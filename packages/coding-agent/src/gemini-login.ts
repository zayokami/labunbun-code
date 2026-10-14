/**
 * The sign-in flows for a Gemini subscription: the loopback dance on a free
 * port, plus the code-paste flow for machines whose browser cannot reach
 * loopback.
 *
 * The loopback flow binds port 0 and learns the real port before it builds
 * the authorize URL: this console registers its loopback redirect for any
 * port, unlike the two sibling flows whose consoles pin 1455, so the URL must
 * name the port the listener actually holds. Its redirect carries no PKCE —
 * the code arrives on a socket only this process holds. The paste flow uses
 * the console's hosted redirect and PKCE S256, because a pasted code travels
 * through a browser and a clipboard, and the verifier is what keeps a code
 * that leaked along the way unredeemable. Both paths end in the same
 * exchange, and both store through the same credential store.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	type OAuthCallbackListen,
	type OAuthCallbackServer,
	openSystemBrowser,
	startOAuthCallbackServer,
} from "./callback-server.ts";
import {
	createGeminiCredentialStore,
	exchangeGeminiCode,
	GEMINI_OAUTH_AUTHORIZE_URL,
	GEMINI_OAUTH_CLIENT_ID,
	GEMINI_OAUTH_SCOPE,
	type GeminiCredentialStore,
	type GeminiOAuthCredential,
	GeminiOAuthError,
	type KeychainLike,
	revokeGeminiToken,
} from "./gemini-auth.ts";

/** The path the console's loopback redirect lands on. Registered as-is. */
export const GEMINI_LOGIN_CALLBACK_PATH = "/oauth2callback";

/** Where the paste flow sends the browser; the page hands back a code to copy. */
export const GEMINI_OAUTH_USER_CODE_REDIRECT_URL = "https://codeassist.google.com/authcode";

/** How long the browser gets before the wait gives up. */
export const GEMINI_LOGIN_TIMEOUT_MS = 300_000;

/** How long the paste flow waits for a code before it gives up: five minutes. */
export const GEMINI_USER_CODE_TIMEOUT_MS = 300_000;

/** The account read a login makes after its grant lands; a nicety, never a gate. */
export const GEMINI_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** How long that read gets. */
const USERINFO_TIMEOUT_MS = 10_000;

/** The `state` that ties the callback to this sign-in: 32 random bytes, as hex. */
export function createGeminiOAuthState(): string {
	return randomBytes(32).toString("hex");
}

/** A PKCE pair: 32 random bytes and their SHA-256, both as base64url. */
export function createGeminiPkce(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface GeminiAuthorizeOptions {
	redirectUri: string;
	state: string;
	/** Present only on the paste flow; the loopback flow's redirect sends no PKCE. */
	codeChallenge?: string;
}

/**
 * The URL a browser opens to sign in.
 *
 * No `prompt` parameter: the authorize URL is byte-checked against the flow
 * this module mirrors, which sends none, so Google decides whether the
 * consent screen reappears. The consequence is real and accepted: a
 * re-consent of an already-granted client can come back without a refresh
 * token — the store keeps that shape and the provider reports it honestly
 * instead of this URL demanding a consent screen on every sign-in.
 */
export function geminiAuthorizeUrl(options: GeminiAuthorizeOptions): string {
	const url = new URL(GEMINI_OAUTH_AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", GEMINI_OAUTH_CLIENT_ID);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("scope", GEMINI_OAUTH_SCOPE);
	url.searchParams.set("state", options.state);
	if (options.codeChallenge !== undefined) {
		url.searchParams.set("code_challenge", options.codeChallenge);
		url.searchParams.set("code_challenge_method", "S256");
	}
	return url.toString();
}

export interface PendingGeminiLogin {
	authorizeUrl: string;
	verifier: string;
	state: string;
	redirectUri: string;
}

/** The first half of the paste sign-in: fresh PKCE and state, and the URL to open. */
export function beginGeminiHeadlessLogin(): PendingGeminiLogin {
	const pkce = createGeminiPkce();
	const state = createGeminiOAuthState();
	return {
		authorizeUrl: geminiAuthorizeUrl({
			redirectUri: GEMINI_OAUTH_USER_CODE_REDIRECT_URL,
			state,
			codeChallenge: pkce.challenge,
		}),
		verifier: pkce.verifier,
		state,
		redirectUri: GEMINI_OAUTH_USER_CODE_REDIRECT_URL,
	};
}

/**
 * The pasted code, from whatever the user actually copied.
 *
 * The console's page shows the code itself; a user who pasted the page's own
 * URL instead still gets in, because the `code` parameter is read out of it.
 * A paste cannot carry the `state` back, and none is demanded: the PKCE
 * verifier is what binds this redemption to this attempt, so a code that
 * leaked through a browser or a clipboard is unredeemable without it.
 */
export function parseGeminiAuthorizationInput(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const code = new URL(trimmed).searchParams.get("code");
			return code === null || code === "" ? undefined : code;
		} catch {
			return undefined;
		}
	}
	return trimmed;
}

/**
 * The signed-in account's address, best effort: only the login line shows it,
 * and a machine where the read fails still has a working sign-in.
 */
export async function fetchGeminiAccountEmail(
	accessToken: string,
	options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string | undefined> {
	try {
		const doFetch = options.fetch ?? fetch;
		const timeout = AbortSignal.timeout(USERINFO_TIMEOUT_MS);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const response = await doFetch(GEMINI_USERINFO_URL, {
			headers: { authorization: `Bearer ${accessToken}` },
			signal,
		});
		if (!response.ok) return undefined;
		const detail = (await response.json()) as { email?: unknown };
		return typeof detail.email === "string" && detail.email !== "" ? detail.email : undefined;
	} catch {
		return undefined;
	}
}

/** The exchange plus the account read plus the save; both completion paths end here. */
async function storeGeminiLogin(
	store: GeminiCredentialStore,
	credential: GeminiOAuthCredential,
	options: { fetch?: typeof fetch },
): Promise<GeminiOAuthCredential> {
	const accountEmail = await fetchGeminiAccountEmail(credential.accessToken, options);
	const stored = accountEmail === undefined ? credential : { ...credential, accountEmail };
	await store.save(stored);
	return stored;
}

export interface CompleteGeminiLoginArgs {
	/** What the user pasted: the code itself, or the page URL that carries it. */
	input: string;
	pending: PendingGeminiLogin;
	store: GeminiCredentialStore;
	fetch?: typeof fetch;
	/** Injectable clock; the token's lifetime is measured from it. */
	now?: () => number;
}

/** The second half of the paste sign-in: turn what came back into a stored credential. */
export async function completeGeminiLogin(args: CompleteGeminiLoginArgs): Promise<GeminiOAuthCredential> {
	const code = parseGeminiAuthorizationInput(args.input);
	if (code === undefined) {
		throw new GeminiOAuthError("That input held no authorization code. Run /login again for a fresh URL.");
	}
	const credential = await exchangeGeminiCode({
		code,
		codeVerifier: args.pending.verifier,
		redirectUri: args.pending.redirectUri,
		fetch: args.fetch,
		now: args.now?.(),
	});
	return storeGeminiLogin(args.store, credential, { fetch: args.fetch });
}

/**
 * The Gemini spelling of the shared listener: the console's loopback path and
 * this layer's error type. The default port is 0 — the OS picks a free one —
 * because this console registers the loopback redirect for any port, so the
 * sibling flows' pinned 1455 would only invite a collision.
 */
export function startGeminiCallbackServer(options: {
	port?: number;
	state: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<OAuthCallbackServer> {
	return startOAuthCallbackServer({
		path: GEMINI_LOGIN_CALLBACK_PATH,
		port: options.port ?? 0,
		state: options.state,
		timeoutMs: options.timeoutMs ?? GEMINI_LOGIN_TIMEOUT_MS,
		signal: options.signal,
		makeError: (message) => new GeminiOAuthError(message),
	});
}

export interface GeminiLoginFlowOptions {
	store: GeminiCredentialStore;
	/** Progress and instruction lines, one string at a time. */
	note?: (line: string) => void;
	/** Defaults to the system opener; tests collect the URL instead. */
	openBrowser?: (url: string) => void;
	/** The callback listener, injectable the way every client here is. */
	listen?: OAuthCallbackListen;
	/** The loopback flow's port; 0 — the default — asks the OS for a free one. */
	port?: number;
	timeoutMs?: number;
	/**
	 * Reads a pasted code when the browser path is unavailable. Without it the
	 * flow stops and returns the pending login, so a caller with somewhere to
	 * keep it (the REPL) can ask later.
	 */
	askCode?: () => Promise<string | null>;
	/** How long the paste flow waits for a paste before giving up. */
	userCodeTimeoutMs?: number;
	/**
	 * Skip the loopback flow entirely — the shape an SSH session needs, where
	 * binding loopback succeeds but no browser on this machine can reach it.
	 */
	headless?: boolean;
	fetch?: typeof fetch;
	now?: () => number;
}

export type GeminiLoginResult =
	| { kind: "signed-in"; credential: GeminiOAuthCredential }
	| { kind: "pending"; pending: PendingGeminiLogin };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The paste flow's own deadline. Five minutes is the budget the flow this
 * module mirrors keeps. The race subscribes to the asker's promise, so a
 * terminal that answers after the deadline cannot surface as an unhandled
 * rejection — its settlement is observed and dropped.
 */
async function askWithTimeout(askCode: () => Promise<string | null>, timeoutMs: number): Promise<string | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new GeminiOAuthError(
					`No authorization code arrived within ${Math.round(timeoutMs / 1000)}s. Run /login again when ready.`,
				),
			);
		}, timeoutMs);
	});
	try {
		return await Promise.race([askCode(), deadline]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function userCodeLogin(
	options: GeminiLoginFlowOptions,
	note: (line: string) => void,
	openBrowser: (url: string) => void,
): Promise<GeminiLoginResult> {
	const pending = beginGeminiHeadlessLogin();
	note(`Open this URL to sign in to a Gemini subscription: ${pending.authorizeUrl}`);
	openBrowser(pending.authorizeUrl);
	note("Approve the request in the browser, then paste the authorization code it shows.");
	if (!options.askCode) return { kind: "pending", pending };
	const input = await askWithTimeout(options.askCode, options.userCodeTimeoutMs ?? GEMINI_USER_CODE_TIMEOUT_MS);
	if (input === null || input.trim() === "") {
		throw new GeminiOAuthError("The sign-in was cancelled.");
	}
	return {
		kind: "signed-in",
		credential: await completeGeminiLogin({
			input,
			pending,
			store: options.store,
			fetch: options.fetch,
			now: options.now,
		}),
	};
}

/**
 * The whole sign-in, from a fresh state to a stored credential.
 *
 * The loopback flow runs first; a listener that cannot come up at all — a
 * policy forbidding loopback — hands off to the paste flow, which needs no
 * listener. A caller that knows its browser cannot reach this machine asks
 * for the paste flow up front with `headless`.
 */
// Long-form design notes: docs/dev/gemini-subscription.md
export async function geminiLoginFlow(options: GeminiLoginFlowOptions): Promise<GeminiLoginResult> {
	const note = options.note ?? ((): void => {});
	const openBrowser = options.openBrowser ?? openSystemBrowser;
	const paste = (): Promise<GeminiLoginResult> => userCodeLogin(options, note, openBrowser);

	if (options.headless) return paste();

	const state = createGeminiOAuthState();
	let server: OAuthCallbackServer;
	try {
		server = await (options.listen ?? startGeminiCallbackServer)({
			port: options.port ?? 0,
			state,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		// The only failure before the listener is up that the paste flow repairs.
		note(`The local callback port is not available (${messageOf(error)}).`);
		return paste();
	}

	// Built only now, from the port the listener actually holds: the URL the
	// browser follows and the redirect_uri the exchange presents must name the
	// same port, and the state must be the one this listener waits for.
	const redirectUri = `http://127.0.0.1:${server.port}${GEMINI_LOGIN_CALLBACK_PATH}`;
	const authorizeUrl = geminiAuthorizeUrl({ redirectUri, state });
	note(`Open this URL to sign in to a Gemini subscription: ${authorizeUrl}`);
	openBrowser(authorizeUrl);
	note("Waiting for the browser to finish the sign-in…");
	const callback = await server.wait;
	const credential = await exchangeGeminiCode({
		code: callback.code,
		redirectUri,
		fetch: options.fetch,
		now: options.now?.(),
	});
	return { kind: "signed-in", credential: await storeGeminiLogin(options.store, credential, options) };
}

/** What to tell the user after a successful sign-in. One sentence, both callers. */
export function geminiSignedInLine(credential: GeminiOAuthCredential): string {
	return credential.accountEmail
		? `Signed in to the Gemini subscription as ${credential.accountEmail}.`
		: "Signed in to the Gemini subscription.";
}

/**
 * Remove the stored credential, end the grant at the issuer best effort, and
 * report whether one was there.
 *
 * The steps are one function so the answer cannot come from a load that some
 * other path already made stale, and so the REPL and the CLI word their output
 * from the same fact. Revocation is best effort by contract: a machine that
 * cannot reach Google still signs out, and one that can leaves nothing behind
 * to revoke later. The refresh token is revoked when there is one, because it
 * is the half that outlives the hour.
 */
export async function clearGeminiSubscription(
	store: GeminiCredentialStore,
	options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<boolean> {
	const credential = await store.load();
	if (credential !== null) {
		const token = credential.refreshToken !== "" ? credential.refreshToken : credential.accessToken;
		if (token !== "") await revokeGeminiToken(token, { fetch: options.fetch, signal: options.signal });
	}
	await store.clear();
	return credential !== null;
}

/**
 * What the REPL needs from this module. Injectable so a test can drive
 * `/login gemini` and `/logout gemini` without a browser, a network, or — and
 * this is the one that matters — the real keychain of the machine running the
 * tests.
 */
export interface GeminiAuthHooks {
	store: () => GeminiCredentialStore;
	login: (options: GeminiLoginFlowOptions) => Promise<GeminiLoginResult>;
	complete: (args: CompleteGeminiLoginArgs) => Promise<GeminiOAuthCredential>;
}

// ---------------------------------------------------------------------------
// The subcommands
// ---------------------------------------------------------------------------

export interface GeminiLoginCliOptions {
	home?: string;
	keychain?: KeychainLike | null;
	warn?: (message: string) => void;
	note?: (line: string) => void;
	port?: number;
	timeoutMs?: number;
	userCodeTimeoutMs?: number;
	headless?: boolean;
	openBrowser?: (url: string) => void;
	listen?: OAuthCallbackListen;
	askCode?: () => Promise<string | null>;
	fetch?: typeof fetch;
	now?: () => number;
}

function terminalAskCode(): () => Promise<string | null> {
	return async (): Promise<string | null> => {
		if (!process.stdin.isTTY) {
			throw new GeminiOAuthError(
				"This input is not a terminal to paste into. Run login from a terminal that can paste the authorization code.",
			);
		}
		const { createInterface } = await import("node:readline/promises");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			const answer = await rl.question("Paste the authorization code shown by the page: ");
			const trimmed = answer.trim();
			return trimmed === "" ? null : trimmed;
		} finally {
			rl.close();
		}
	};
}

/** The `labunbun login gemini` subcommand: the flow, wired to the terminal. */
export async function runGeminiLoginCli(options: GeminiLoginCliOptions = {}): Promise<number> {
	const store = createGeminiCredentialStore({ home: options.home, keychain: options.keychain, warn: options.warn });
	const note = options.note ?? ((line: string) => console.log(line));
	try {
		const result = await geminiLoginFlow({
			store,
			note,
			port: options.port,
			timeoutMs: options.timeoutMs,
			userCodeTimeoutMs: options.userCodeTimeoutMs,
			headless: options.headless,
			openBrowser: options.openBrowser,
			listen: options.listen,
			// The CLI always can ask: readline in a terminal. The result is
			// `pending` only for callers that pass their own `askCode` and stop.
			askCode: options.askCode ?? terminalAskCode(),
			fetch: options.fetch,
			now: options.now,
		});
		if (result.kind === "signed-in") {
			note(geminiSignedInLine(result.credential));
			return 0;
		}
		console.error("The sign-in did not complete. Run login again.");
		return 1;
	} catch (error) {
		console.error(messageOf(error));
		return 1;
	}
}

/** The `labunbun logout gemini` subcommand. */
export async function runGeminiLogoutCli(
	options: {
		home?: string;
		keychain?: KeychainLike | null;
		warn?: (message: string) => void;
		note?: (line: string) => void;
		fetch?: typeof fetch;
	} = {},
): Promise<number> {
	const note = options.note ?? ((line: string) => console.log(line));
	try {
		const had = await clearGeminiSubscription(
			createGeminiCredentialStore({ home: options.home, keychain: options.keychain, warn: options.warn }),
			{ fetch: options.fetch },
		);
		note(had ? "Signed out of the Gemini subscription." : "No Gemini subscription was signed in.");
		return 0;
	} catch (error) {
		console.error(messageOf(error));
		return 1;
	}
}
