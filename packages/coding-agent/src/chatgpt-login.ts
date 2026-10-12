/**
 * The sign-in flow for a ChatGPT subscription: the browser dance on the codex
 * client's registered callback, plus the device code for machines whose
 * loopback no browser can reach.
 *
 * There is no paste: the console has no page that shows a `code#state`, so
 * the repair when the port cannot be taken is the device flow — a one-time
 * code approved in any browser and polled for here. Both paths end in the
 * same exchange, and both store through the same credential store.
 */

import {
	type ChatGptCredentialStore,
	type ChatGptOAuthCredential,
	ChatGptOAuthError,
	chatGptAuthorizeUrl,
	completeChatGptDeviceLogin,
	createChatGptOAuthState,
	createChatGptPkce,
	exchangeChatGptCode,
	requestChatGptDeviceCode,
} from "@labunbun/ai";
import {
	type OAuthCallbackListen,
	type OAuthCallbackServer,
	openSystemBrowser,
	startOAuthCallbackServer,
} from "./callback-server.ts";
import { createChatGptCredentialStore, type KeychainLike } from "./chatgpt-auth.ts";

/** The port the console's localhost redirect names. Fixed: it is registered. */
export const CHATGPT_LOGIN_PORT = 1455;

/** Where that redirect lands. `localhost`, not `127.0.0.1`: registered as-is. */
export const CHATGPT_LOGIN_REDIRECT_URL = `http://localhost:${CHATGPT_LOGIN_PORT}/auth/callback`;

/** How long the browser gets before the wait gives up. */
const CHATGPT_LOGIN_TIMEOUT_MS = 300_000;

export interface PendingChatGptLogin {
	authorizeUrl: string;
	verifier: string;
	state: string;
	redirectUri: string;
}

// Long-form design notes: docs/dev/chatgpt-subscription.md
/** The first half of a sign-in: fresh PKCE and state, and the URL to open. */
export function beginChatGptLogin(options: { redirectUri?: string } = {}): PendingChatGptLogin {
	const redirectUri = options.redirectUri ?? CHATGPT_LOGIN_REDIRECT_URL;
	const pkce = createChatGptPkce();
	const state = createChatGptOAuthState();
	return {
		authorizeUrl: chatGptAuthorizeUrl({ redirectUri, state, codeChallenge: pkce.challenge }),
		verifier: pkce.verifier,
		state,
		redirectUri,
	};
}

// Long-form design notes: docs/dev/chatgpt-subscription.md
/**
 * The ChatGPT spelling of the shared listener: the codex client's registered
 * `/auth/callback` path and this layer's error type. The bind failure it
 * rejects with is what the flow recovers from, by switching to the device
 * sign-in.
 */
export function startChatGptCallbackServer(options: {
	port?: number;
	state: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<OAuthCallbackServer> {
	return startOAuthCallbackServer({
		path: "/auth/callback",
		port: options.port ?? CHATGPT_LOGIN_PORT,
		state: options.state,
		timeoutMs: options.timeoutMs ?? CHATGPT_LOGIN_TIMEOUT_MS,
		signal: options.signal,
		makeError: (message) => new ChatGptOAuthError(message),
	});
}

export interface ChatGptLoginFlowOptions {
	store: ChatGptCredentialStore;
	/** Progress and instruction lines, one string at a time. */
	note?: (line: string) => void;
	/** Defaults to the system opener; tests collect the URL instead. */
	openBrowser?: (url: string) => void;
	/** The callback listener, injectable the way every client here is. */
	listen?: OAuthCallbackListen;
	/** The port the browser flow tries; 0 asks the OS for a free one. */
	port?: number;
	timeoutMs?: number;
	/** The device flow's own injection points and budget. */
	requestDevice?: typeof requestChatGptDeviceCode;
	completeDevice?: typeof completeChatGptDeviceLogin;
	deviceTimeoutMs?: number;
	fetch?: typeof fetch;
	now?: () => number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Long-form design notes: docs/dev/chatgpt-subscription.md
/**
 * The whole sign-in, from a fresh PKCE to a stored credential.
 *
 * Nothing here can end `pending`: the device fallback completes in-process
 * once the user approves it, so this returns the credential itself rather
 * than the Claude flow's two-case result.
 */
export async function chatGptLoginFlow(options: ChatGptLoginFlowOptions): Promise<ChatGptOAuthCredential> {
	const note = options.note ?? ((): void => {});
	const listen = options.listen ?? startChatGptCallbackServer;
	const openBrowser = options.openBrowser ?? openSystemBrowser;
	const requestDevice = options.requestDevice ?? requestChatGptDeviceCode;
	const completeDevice = options.completeDevice ?? completeChatGptDeviceLogin;

	const automatic = beginChatGptLogin();
	note(`Open this URL to sign in to a ChatGPT subscription: ${automatic.authorizeUrl}`);
	openBrowser(automatic.authorizeUrl);

	let server: OAuthCallbackServer;
	try {
		server = await listen({ port: options.port, state: automatic.state, timeoutMs: options.timeoutMs });
	} catch (error) {
		// Reaching here means the port did not come up. This backend has no paste
		// page, so the repair is the device flow: approve in any browser, and the
		// poll below finishes the exchange without another keystroke.
		note(`The local callback port is not available (${messageOf(error)}).`);
		note("Trying the device sign-in instead: approve it in any browser.");
		const device = await requestDevice({ fetch: options.fetch, now: options.now?.() });
		note(`Open ${device.verificationUrl} and enter the code ${device.userCode}.`);
		openBrowser(device.verificationUrl);
		const credential = await completeDevice({
			deviceAuthId: device.deviceAuthId,
			userCode: device.userCode,
			intervalMs: device.intervalMs,
			timeoutMs: options.deviceTimeoutMs,
			fetch: options.fetch,
			now: options.now?.(),
		});
		await options.store.save(credential);
		return credential;
	}

	note("Waiting for the browser to finish the sign-in…");
	const callback = await server.wait;
	const credential = await exchangeChatGptCode({
		code: callback.code,
		codeVerifier: automatic.verifier,
		redirectUri: automatic.redirectUri,
		fetch: options.fetch,
		now: options.now?.(),
	});
	await options.store.save(credential);
	return credential;
}

/** What to tell the user after a successful sign-in. One sentence, both callers. */
export function chatGptSignedInLine(credential: ChatGptOAuthCredential): string {
	const plan = credential.planType ? ` (${credential.planType})` : "";
	return credential.accountEmail
		? `Signed in to the ChatGPT subscription as ${credential.accountEmail}${plan}.`
		: `Signed in to the ChatGPT subscription${plan}.`;
}

/**
 * Remove the stored credential and report whether one was there.
 *
 * The two steps are one function so the answer cannot come from a load that
 * some other path already made stale, and so the REPL and the CLI word their
 * output from the same fact.
 */
export async function clearChatGptSubscription(store: ChatGptCredentialStore): Promise<boolean> {
	const had = (await store.load()) !== null;
	await store.clear();
	return had;
}

/**
 * What the REPL needs from this module. Injectable so a test can drive
 * `/login chatgpt` and `/logout chatgpt` without a browser, a network, or —
 * and this is the one that matters — the real keychain of the machine
 * running the tests.
 */
export interface ChatGptAuthHooks {
	store: () => ChatGptCredentialStore;
	login: (options: ChatGptLoginFlowOptions) => Promise<ChatGptOAuthCredential>;
}

// ---------------------------------------------------------------------------
// The subcommands
// ---------------------------------------------------------------------------

export interface ChatGptLoginCliOptions {
	home?: string;
	keychain?: KeychainLike | null;
	warn?: (message: string) => void;
	note?: (line: string) => void;
	port?: number;
	timeoutMs?: number;
	deviceTimeoutMs?: number;
	openBrowser?: (url: string) => void;
	listen?: OAuthCallbackListen;
	requestDevice?: typeof requestChatGptDeviceCode;
	completeDevice?: typeof completeChatGptDeviceLogin;
	fetch?: typeof fetch;
	now?: () => number;
}

// Long-form design notes: docs/dev/chatgpt-subscription.md
/** The `labunbun login chatgpt` subcommand: the flow, wired to the terminal. */
export async function runChatGptLoginCli(options: ChatGptLoginCliOptions = {}): Promise<number> {
	const store = createChatGptCredentialStore({ home: options.home, keychain: options.keychain, warn: options.warn });
	const note = options.note ?? ((line: string) => console.log(line));
	try {
		const credential = await chatGptLoginFlow({
			store,
			note,
			port: options.port,
			timeoutMs: options.timeoutMs,
			deviceTimeoutMs: options.deviceTimeoutMs,
			openBrowser: options.openBrowser,
			listen: options.listen,
			requestDevice: options.requestDevice,
			completeDevice: options.completeDevice,
			fetch: options.fetch,
			now: options.now,
		});
		note(chatGptSignedInLine(credential));
		return 0;
	} catch (error) {
		console.error(messageOf(error));
		return 1;
	}
}

/** The `labunbun logout chatgpt` subcommand. */
export async function runChatGptLogoutCli(
	options: {
		home?: string;
		keychain?: KeychainLike | null;
		warn?: (message: string) => void;
		note?: (line: string) => void;
	} = {},
): Promise<number> {
	const note = options.note ?? ((line: string) => console.log(line));
	try {
		const had = await clearChatGptSubscription(
			createChatGptCredentialStore({ home: options.home, keychain: options.keychain, warn: options.warn }),
		);
		note(had ? "Signed out of the ChatGPT subscription." : "No ChatGPT subscription was signed in.");
		return 0;
	} catch (error) {
		console.error(messageOf(error));
		return 1;
	}
}
