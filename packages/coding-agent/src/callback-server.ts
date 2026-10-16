/**
 * The loopback listener the subscription sign-ins share.
 *
 * Both flows are one machine — a browser is opened, the console redirects to
 * loopback, the code arrives — and they differ only in the path their console
 * is registered to redirect to and the error type their layer throws. The
 * server carries everything else, including the two rules that are easy to
 * get wrong twice: a redirect whose state does not match answers 400 and
 * keeps listening — an error redirect included, because a state-less request
 * to loopback is just as likely to be a stray as a mis-dialed tab — and the
 * bind failure — port taken, listening forbidden — is the one rejection a
 * caller recovers from by switching flows.
 */

import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface OAuthCallbackServer {
	/** The port actually bound — a caller that asked for 0 learns the real one. */
	port: number;
	wait: Promise<{ code: string; state: string }>;
	close(): void;
}

/** How a caller's test double stands in for the real listener. */
export type OAuthCallbackListen = (options: {
	port?: number;
	state: string;
	timeoutMs?: number;
}) => Promise<OAuthCallbackServer>;

const LOGIN_PAGE_HEAD = '<!doctype html>\n<meta charset="utf-8">\n<title>labunbun</title>\n';

function page(title: string, body: string): string {
	return `${LOGIN_PAGE_HEAD}<h1>${title}</h1>\n<p>${body}</p>\n`;
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function respondHtml(response: ServerResponse, status: number, html: string): void {
	// `close` tells the browser not to keep the connection, so the listener can
	// shut down the moment the page is delivered.
	response.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
	response.end(html);
}

// Long-form design notes: docs/dev/claude-subscription.md
/**
 * Listen on loopback for a console's redirect.
 *
 * The promise it resolves rejects when the port cannot be bound — the one
 * failure the callers recover from, by switching flows. After that, failures
 * arrive on `wait`: a denied sign-in, a timeout, or a cancel. A redirect
 * whose state does not match answers 400 and KEEPS listening, because a
 * stray request to the port (a scanner, an old tab) must not end the sign-in
 * the user is still completing.
 */
export function startOAuthCallbackServer(options: {
	/** The console's registered redirect path. */
	path: string;
	port: number;
	state: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** The caller's error class, so a refusal surfaces as its layer's own. */
	makeError: (message: string) => Error;
}): Promise<OAuthCallbackServer> {
	return new Promise((resolveBound, rejectBind) => {
		let settleCode!: (value: { code: string; state: string }) => void;
		let rejectCode!: (error: unknown) => void;
		const wait = new Promise<{ code: string; state: string }>((resolve, reject) => {
			settleCode = resolve;
			rejectCode = reject;
		});
		// The caller may not attach to `wait` until a microtask later; without
		// this handle a fast rejection would surface as an unhandled rejection.
		void wait.catch(() => {});

		let settled = false;
		let bound = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const settle = (action: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			action();
			server.close();
			// Browsers may hold an idle keep-alive connection from an earlier
			// request; the response header asks them not to, and this does not
			// depend on the ask having been honored.
			(server as { closeAllConnections?: () => void }).closeAllConnections?.();
		};

		const onAbort = (): void => {
			settle(() => rejectCode(options.makeError("The sign-in was cancelled.")));
		};

		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", `http://127.0.0.1:${options.port}`);
			if (url.pathname !== options.path) {
				respondHtml(response, 404, page("Not found", "This port waits for the sign-in redirect only."));
				return;
			}
			// The state check runs before everything else, an error redirect
			// included: the console's error responses carry the state back (RFC
			// 6749 requires it), and a request without it — the shape any page the
			// user visits can send to loopback — is a stray that must not end the
			// sign-in the user is still completing.
			const state = url.searchParams.get("state") ?? "";
			if (state !== options.state) {
				respondHtml(
					response,
					400,
					page("Wrong sign-in", "This redirect did not match the sign-in this terminal started."),
				);
				return;
			}
			const code = url.searchParams.get("code") ?? "";
			const error = url.searchParams.get("error");
			if (error) {
				const detail = url.searchParams.get("error_description") ?? error;
				respondHtml(response, 400, page("Sign-in refused", `${escapeHtml(detail)} Return to the terminal.`));
				settle(() => rejectCode(options.makeError(`The console refused the sign-in: ${detail}`)));
				return;
			}
			if (code === "") {
				respondHtml(response, 400, page("Missing code", "The console returned no authorization code."));
				settle(() => rejectCode(options.makeError("The console returned no authorization code.")));
				return;
			}
			respondHtml(response, 200, page("Signed in", "You can close this tab and return to the terminal."));
			settle(() => settleCode({ code, state }));
		});

		server.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			// Before the bind succeeds this is the recoverable failure — port
			// taken, or listening not permitted. After it, the listener is up and
			// the wait has no page to deliver; both reject on `wait`, except the
			// bind itself, which is what the caller catches to switch flows.
			if (bound) rejectCode(error);
			else rejectBind(error);
		});

		server.listen(options.port, "127.0.0.1", () => {
			bound = true;
			const address = server.address() as AddressInfo;
			timer = setTimeout(() => {
				settle(() =>
					rejectCode(
						options.makeError(
							`No browser finished the sign-in within ${Math.round(options.timeoutMs / 1000)}s. Run /login again when ready.`,
						),
					),
				);
			}, options.timeoutMs);
			timer.unref?.();
			// An abort event does not replay for listeners added after it, so a
			// signal already aborted while the port was binding (Esc pressed in
			// that window) is handled rather than subscribed to — without this,
			// the wait sits until the timeout rejects a sign-in the user cancelled.
			if (options.signal?.aborted) onAbort();
			options.signal?.addEventListener("abort", onAbort, { once: true });
			resolveBound({
				port: address.port,
				wait,
				close: () => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					server.close();
				},
			});
		});
	});
}

/**
 * Open the system browser at `url`. Best effort, always: the URL is printed
 * either way, so an opener that is missing turns into a copy and a paste
 * rather than an error.
 */
export function openSystemBrowser(url: string): void {
	try {
		const [command, args] =
			process.platform === "win32"
				? // The URL carries `&`, which cmd would read as a command separator.
					// The whole verbatim string keeps `start` from re-parsing the URL.
					(["cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`]] as const)
				: ([(process.platform === "darwin" ? "open" : "xdg-open") as string, [url]] as const);
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
		});
		child.on("error", () => {
			// No opener on this machine; the printed URL is the fallback.
		});
		child.unref();
	} catch {
		// Same as above: the note with the URL already went to the user.
	}
}
