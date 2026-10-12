/**
 * The sign-in flow for a Claude subscription: the browser dance, plus the
 * paste it falls back to.
 *
 * The console redirects back to a local port when it can, so the app opens
 * the authorize URL, listens on loopback, and the code arrives on its own.
 * When the port cannot be taken — another instance holds it, or a policy
 * forbids listening — the flow falls back to the console's manual page and
 * the user pastes `code#state`. Both paths end in the same exchange, and both
 * store through the same credential store.
 */

import {
	CLAUDE_OAUTH_MANUAL_REDIRECT_URL,
	type ClaudeCredentialStore,
	type ClaudeOAuthCredential,
	ClaudeOAuthError,
	claudeAuthorizeUrl,
	createOAuthState,
	createPkce,
	exchangeClaudeCode,
	parseClaudeAuthorizationInput,
} from "@labunbun/ai";
import { type OAuthCallbackServer, openSystemBrowser, startOAuthCallbackServer } from "./callback-server.ts";
import { createClaudeCredentialStore, type KeychainLike } from "./claude-auth.ts";

export { openSystemBrowser };

/** The port the console's localhost redirect names. Fixed: it is registered. */
export const CLAUDE_LOGIN_PORT = 1455;

/** Where that redirect lands. `localhost`, not `127.0.0.1`: registered as-is. */
export const CLAUDE_LOGIN_REDIRECT_URL = `http://localhost:${CLAUDE_LOGIN_PORT}/callback`;

/** How long the browser gets before the wait gives up. */
const CLAUDE_LOGIN_TIMEOUT_MS = 300_000;

export interface PendingClaudeLogin {
	authorizeUrl: string;
	verifier: string;
	state: string;
	redirectUri: string;
}

// Long-form design notes: docs/dev/claude-subscription.md
/** The first half of a sign-in: fresh PKCE and state, and the URL to open. */
export function beginClaudeLogin(options: { redirectUri?: string } = {}): PendingClaudeLogin {
	const redirectUri = options.redirectUri ?? CLAUDE_LOGIN_REDIRECT_URL;
	const pkce = createPkce();
	const state = createOAuthState();
	return {
		authorizeUrl: claudeAuthorizeUrl({ redirectUri, state, codeChallenge: pkce.challenge }),
		verifier: pkce.verifier,
		state,
		redirectUri,
	};
}

export interface CompleteClaudeLoginArgs {
	/** What the user pasted or the redirect delivered: `code` or `code#state`. */
	input: string;
	pending: PendingClaudeLogin;
	store: ClaudeCredentialStore;
	fetch?: typeof fetch;
	/** Injectable clock; the token's lifetime is measured from it. */
	now?: () => number;
}

// Long-form design notes: docs/dev/claude-subscription.md
/**
 * The second half: turn what came back into a stored credential.
 *
 * A paste without a state is accepted — the page shows both halves, and a
 * user who copied only the code should not be told the code is wrong — but a
 * paste carrying a DIFFERENT state is refused, because that is a redirect
 * from some other sign-in and its code would bind this session to an account
 * the user did not open here.
 */
export async function completeClaudeLogin(args: CompleteClaudeLoginArgs): Promise<ClaudeOAuthCredential> {
	const parsed = parseClaudeAuthorizationInput(args.input);
	if (!parsed) {
		throw new ClaudeOAuthError("That input held no authorization code. Run /login again for a fresh URL.");
	}
	if (parsed.state !== undefined && parsed.state !== args.pending.state) {
		throw new ClaudeOAuthError("That authorization belongs to a different login attempt. Run /login again.");
	}
	const credential = await exchangeClaudeCode({
		code: parsed.code,
		state: parsed.state,
		codeVerifier: args.pending.verifier,
		redirectUri: args.pending.redirectUri,
		fetch: args.fetch,
		now: args.now?.(),
	});
	await args.store.save(credential);
	return credential;
}

export type ClaudeCallbackServer = OAuthCallbackServer;

export type ClaudeCallbackListen = (options: {
	port?: number;
	state: string;
	timeoutMs?: number;
}) => Promise<ClaudeCallbackServer>;

// Long-form design notes: docs/dev/claude-subscription.md
/**
 * The Claude spelling of the shared listener: the console's registered path,
 * this layer's error type, and the send-a-fresh-URL shape of the timeout note.
 * The bind failure it rejects with is the one the flow recovers from, by
 * switching to the manual paste.
 */
export function startClaudeCallbackServer(options: {
	port?: number;
	state: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<ClaudeCallbackServer> {
	return startOAuthCallbackServer({
		path: "/callback",
		port: options.port ?? CLAUDE_LOGIN_PORT,
		state: options.state,
		timeoutMs: options.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS,
		signal: options.signal,
		makeError: (message) => new ClaudeOAuthError(message),
	});
}

export interface ClaudeLoginFlowOptions {
	store: ClaudeCredentialStore;
	/** Progress and instruction lines, one string at a time. */
	note?: (line: string) => void;
	/** Defaults to the system opener; tests collect the URL instead. */
	openBrowser?: (url: string) => void;
	/** The callback listener, injectable the way every client here is. */
	listen?: ClaudeCallbackListen;
	/** The port the automatic flow tries; 0 asks the OS for a free one. */
	port?: number;
	timeoutMs?: number;
	/**
	 * Reads a pasted `code#state` when the browser path is unavailable.
	 * Without it the flow stops and returns the pending login, so a caller
	 * with somewhere to keep it (the REPL) can ask later.
	 */
	askCode?: () => Promise<string | null>;
	fetch?: typeof fetch;
	now?: () => number;
}

export type ClaudeLoginResult =
	| { kind: "signed-in"; credential: ClaudeOAuthCredential }
	| { kind: "pending"; pending: PendingClaudeLogin };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Long-form design notes: docs/dev/claude-subscription.md
/** The whole sign-in, from a fresh PKCE to a stored credential. */
export async function claudeLoginFlow(options: ClaudeLoginFlowOptions): Promise<ClaudeLoginResult> {
	const note = options.note ?? ((): void => {});
	const listen = options.listen ?? startClaudeCallbackServer;
	const openBrowser = options.openBrowser ?? openSystemBrowser;

	const automatic = beginClaudeLogin();
	note(`Open this URL to sign in to a Claude subscription: ${automatic.authorizeUrl}`);
	openBrowser(automatic.authorizeUrl);

	let server: ClaudeCallbackServer;
	try {
		server = await listen({ port: options.port, state: automatic.state, timeoutMs: options.timeoutMs });
	} catch (error) {
		// Reaching here means the port did not come up — the only failure before
		// listening that the manual flow repairs. Everything after a successful
		// bind is the browser's job or the user's, and fails on `wait` instead.
		const manual = beginClaudeLogin({ redirectUri: CLAUDE_OAUTH_MANUAL_REDIRECT_URL });
		note(`The local callback port is not available (${messageOf(error)}).`);
		note(`Open this URL instead, approve the request, and copy the code it shows: ${manual.authorizeUrl}`);
		openBrowser(manual.authorizeUrl);
		if (!options.askCode) return { kind: "pending", pending: manual };
		const input = await options.askCode();
		if (input === null || input.trim() === "") {
			throw new ClaudeOAuthError("The sign-in was cancelled.");
		}
		return {
			kind: "signed-in",
			credential: await completeClaudeLogin({
				input,
				pending: manual,
				store: options.store,
				fetch: options.fetch,
				now: options.now,
			}),
		};
	}

	note("Waiting for the browser to finish the sign-in…");
	const callback = await server.wait;
	return {
		kind: "signed-in",
		credential: await completeClaudeLogin({
			input: `${callback.code}#${callback.state}`,
			pending: automatic,
			store: options.store,
			fetch: options.fetch,
			now: options.now,
		}),
	};
}

/** What to tell the user after a successful sign-in. One sentence, both callers. */
export function signedInLine(credential: ClaudeOAuthCredential): string {
	return credential.accountEmail
		? `Signed in to the Claude subscription as ${credential.accountEmail}.`
		: "Signed in to the Claude subscription.";
}

/**
 * Remove the stored credential and report whether one was there.
 *
 * The two steps are one function so the answer cannot come from a load that
 * some other path already made stale, and so the REPL and the CLI word their
 * output from the same fact.
 */
export async function clearClaudeSubscription(store: ClaudeCredentialStore): Promise<boolean> {
	const had = (await store.load()) !== null;
	await store.clear();
	return had;
}

/**
 * What the REPL needs from this module. Injectable so a test can drive
 * `/login` and `/logout` without a browser, a network, or — and this is the
 * one that matters — the real keychain of the machine running the tests.
 */
export interface ClaudeAuthHooks {
	store: () => ClaudeCredentialStore;
	login: (options: ClaudeLoginFlowOptions) => Promise<ClaudeLoginResult>;
	complete: (args: CompleteClaudeLoginArgs) => Promise<ClaudeOAuthCredential>;
}

// ---------------------------------------------------------------------------
// The subcommands
// ---------------------------------------------------------------------------

export interface ClaudeLoginCliOptions {
	home?: string;
	keychain?: KeychainLike | null;
	warn?: (message: string) => void;
	note?: (line: string) => void;
	port?: number;
	timeoutMs?: number;
	openBrowser?: (url: string) => void;
	listen?: ClaudeCallbackListen;
	askCode?: () => Promise<string | null>;
	fetch?: typeof fetch;
	now?: () => number;
}

function terminalAskCode(): () => Promise<string | null> {
	return async (): Promise<string | null> => {
		if (!process.stdin.isTTY) {
			throw new ClaudeOAuthError(
				"The local callback port is unavailable and this input is not a terminal to paste into. Run login from a terminal that can listen, or from one where port 1455 is free.",
			);
		}
		const { createInterface } = await import("node:readline/promises");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = await rl.question("Paste the code#state shown by the page: ");
			const trimmed = answer.trim();
			return trimmed === "" ? null : trimmed;
		} finally {
			rl.close();
		}
	};
}

/** The `labunbun login` subcommand: the flow, wired to the terminal. */
export async function runClaudeLoginCli(options: ClaudeLoginCliOptions = {}): Promise<number> {
	const store = createClaudeCredentialStore({ home: options.home, keychain: options.keychain, warn: options.warn });
	const note = options.note ?? ((line: string) => console.log(line));
	try {
		const result = await claudeLoginFlow({
			store,
			note,
			port: options.port,
			timeoutMs: options.timeoutMs,
			openBrowser: options.openBrowser,
			// The CLI always can ask: readline in a terminal. The result is
			// `pending` only for callers that pass their own `askCode` and stop.
			listen: options.listen,
			askCode: options.askCode ?? terminalAskCode(),
			fetch: options.fetch,
			now: options.now,
		});
		if (result.kind === "signed-in") {
			note(signedInLine(result.credential));
			return 0;
		}
		console.error("The sign-in did not complete. Run login again.");
		return 1;
	} catch (error) {
		console.error(messageOf(error));
		return 1;
	}
}

/** The `labunbun logout` subcommand. */
export async function runClaudeLogoutCli(
	options: {
		home?: string;
		keychain?: KeychainLike | null;
		warn?: (message: string) => void;
		note?: (line: string) => void;
	} = {},
): Promise<number> {
	const note = options.note ?? ((line: string) => console.log(line));
	try {
		const had = await clearClaudeSubscription(
			createClaudeCredentialStore({ home: options.home, keychain: options.keychain, warn: options.warn }),
		);
		note(had ? "Signed out of the Claude subscription." : "No Claude subscription was signed in.");
		return 0;
	} catch (error) {
		console.error(messageOf(error));
		return 1;
	}
}
