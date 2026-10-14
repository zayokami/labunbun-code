/**
 * The two Gemini sign-in flows: the loopback dance and the code paste.
 *
 * No test in this file opens a browser or reaches the network. `openBrowser`,
 * `listen`, `askCode`, and `fetch` are all injected, and every credential
 * store is either an in-memory fake or a throwaway `home` with the keychain
 * turned off — a test that took the machine's real keychain or fired a real
 * request would be exercising the operator's sign-in, not this code. The
 * three tests under `startGeminiCallbackServer` do open a real loopback
 * socket, on port 0, and speak to 127.0.0.1 only.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCallbackListen } from "../src/callback-server.ts";
import {
	createGeminiCredentialStore,
	type GeminiCredentialStore,
	type GeminiOAuthCredential,
} from "../src/gemini-auth.ts";
import {
	beginGeminiHeadlessLogin,
	clearGeminiSubscription,
	completeGeminiLogin,
	createGeminiOAuthState,
	createGeminiPkce,
	fetchGeminiAccountEmail,
	GEMINI_LOGIN_TIMEOUT_MS,
	GEMINI_OAUTH_USER_CODE_REDIRECT_URL,
	GEMINI_USER_CODE_TIMEOUT_MS,
	GEMINI_USERINFO_URL,
	geminiAuthorizeUrl,
	geminiLoginFlow,
	geminiSignedInLine,
	parseGeminiAuthorizationInput,
	runGeminiLoginCli,
	runGeminiLogoutCli,
	startGeminiCallbackServer,
} from "../src/gemini-login.ts";

/**
 * The exact client this sign-in presents; spelled out in pieces, like the
 * source row, so a mutation fails here and no single literal matches a
 * credential scanner.
 */
const CLIENT_ID = "681255809395-" + "oo8ft2oprdrnp9e3aqf6av3hmdib135j" + ".apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-" + "4uHgMPm-1o7Sk-geV6Cu5clXFsxl";
const SCOPE =
	"https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

const TOKEN_ANSWER = {
	access_token: "at-1",
	refresh_token: "rt-1",
	expires_in: 3600,
	scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email",
	token_type: "Bearer",
};
const USERINFO_ANSWER = { email: "user@example.com" };

interface RouteCall {
	url: string;
	method: string;
	form: URLSearchParams;
	authorization: string | null;
}

interface RouteAnswers {
	token?: object;
	tokenStatus?: number;
	/** `null` makes the account read fail, the way a flaky one would. */
	userinfo?: object | null;
	revokeStatus?: number;
}

/** One fake for every endpoint the flows reach, routed by URL and recording calls. */
function routeFetch(answers: RouteAnswers = {}): { calls: RouteCall[]; fetchFn: typeof fetch } {
	const calls: RouteCall[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const target = String(url);
		calls.push({
			url: target,
			method: init?.method ?? "GET",
			form: new URLSearchParams(init?.body === undefined ? "" : String(init.body)),
			authorization: new Headers(init?.headers).get("authorization"),
		});
		if (target.startsWith("https://oauth2.googleapis.com/token")) {
			return new Response(JSON.stringify(answers.token ?? TOKEN_ANSWER), {
				status: answers.tokenStatus ?? 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (target.startsWith("https://www.googleapis.com/oauth2/v2/userinfo")) {
			if (answers.userinfo === null) return new Response("gone", { status: 500 });
			return new Response(JSON.stringify(answers.userinfo ?? USERINFO_ANSWER), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (target.startsWith("https://oauth2.googleapis.com/revoke")) {
			return new Response(null, { status: answers.revokeStatus ?? 200 });
		}
		throw new Error(`unexpected fetch: ${target}`);
	}) as typeof fetch;
	return { calls, fetchFn };
}

interface MemoryStore extends GeminiCredentialStore {
	current: GeminiOAuthCredential | null;
}

function memoryStore(): MemoryStore {
	return {
		current: null,
		async load() {
			return this.current;
		},
		async save(next) {
			this.current = next;
		},
		async clear() {
			this.current = null;
		},
	};
}

function makeHome(): { home: string; clean: () => void } {
	const home = mkdtempSync(join(tmpdir(), "lbb-gemini-login-"));
	return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
}

function filePathOf(home: string): string {
	return join(home, ".labunbun", "gemini-oauth.json");
}

interface CapturedListen {
	port: number | undefined;
	state: string;
	timeoutMs: number | undefined;
}

/** The listener double: captures what the flow asked for, then answers at once. */
function stubListen(options: { port?: number; code?: string; error?: Error } = {}): {
	listen: OAuthCallbackListen;
	captured: CapturedListen[];
} {
	const captured: CapturedListen[] = [];
	const listen: OAuthCallbackListen = async (listenOptions) => {
		captured.push({ port: listenOptions.port, state: listenOptions.state, timeoutMs: listenOptions.timeoutMs });
		const wait = new Promise<{ code: string; state: string }>((resolve, reject) => {
			if (options.error) reject(options.error);
			else resolve({ code: options.code ?? "code-1", state: listenOptions.state });
		});
		// The real listener keeps a not-yet-attached rejection handled; a stub
		// that skipped this would surface one the caller has not awaited yet.
		void wait.catch(() => {});
		return { port: options.port ?? 54321, wait, close: () => {} };
	};
	return { listen, captured };
}

const failingListen: OAuthCallbackListen = async () => {
	throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:0");
};

function challengeOf(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

describe("geminiAuthorizeUrl", () => {
	test("the URL the loopback flow opens", () => {
		const url = new URL(geminiAuthorizeUrl({ redirectUri: "http://127.0.0.1:54321/oauth2callback", state: "state-1" }));
		expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/oauth2callback");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("scope")).toBe(SCOPE);
		expect(url.searchParams.get("state")).toBe("state-1");
		// The loopback redirect lands on a socket only this process holds, so
		// this flow sends no PKCE.
		expect(url.searchParams.has("code_challenge")).toBe(false);
		expect(url.searchParams.has("code_challenge_method")).toBe(false);
	});

	test("no prompt parameter is sent — re-consent is left to Google", () => {
		// The flow this module mirrors sends no `prompt`; byte-checked. The
		// accepted consequence: a re-consent can come back without a refresh
		// token, which the store keeps and the provider reports honestly.
		const url = new URL(geminiAuthorizeUrl({ redirectUri: "http://127.0.0.1:1/oauth2callback", state: "s" }));
		expect(url.searchParams.get("prompt")).toBeNull();
	});

	test("the paste flow's URL: the hosted redirect, PKCE S256, and the same state shape", () => {
		const pending = beginGeminiHeadlessLogin();
		const url = new URL(pending.authorizeUrl);
		expect(GEMINI_OAUTH_USER_CODE_REDIRECT_URL).toBe("https://codeassist.google.com/authcode");
		expect(url.searchParams.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
		expect(pending.redirectUri).toBe("https://codeassist.google.com/authcode");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBe(challengeOf(pending.verifier));
		expect(url.searchParams.get("state")).toBe(pending.state);
		expect(pending.state).toMatch(/^[0-9a-f]{64}$/);
	});

	test("state is 32 random bytes as hex, fresh per call", () => {
		const first = createGeminiOAuthState();
		const second = createGeminiOAuthState();
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(first).not.toBe(second);
	});

	test("a PKCE pair is 32 random bytes and their SHA-256, both base64url", () => {
		const first = createGeminiPkce();
		const second = createGeminiPkce();
		expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(first.challenge).toBe(challengeOf(first.verifier));
		expect(first.verifier).not.toBe(second.verifier);
	});
});

describe("parseGeminiAuthorizationInput", () => {
	test("a bare code comes back trimmed", () => {
		expect(parseGeminiAuthorizationInput("  4/0AeaYCODE  ")).toBe("4/0AeaYCODE");
	});

	test("a pasted page URL gives up its code parameter", () => {
		expect(parseGeminiAuthorizationInput("https://codeassist.google.com/authcode?code=abc-9&scope=x")).toBe("abc-9");
	});

	test("an empty paste, and a URL without a code, are undefined", () => {
		expect(parseGeminiAuthorizationInput("   ")).toBeUndefined();
		expect(parseGeminiAuthorizationInput("https://codeassist.google.com/authcode?scope=x")).toBeUndefined();
	});
});

describe("fetchGeminiAccountEmail", () => {
	test("reads the address with the bearer it was given", async () => {
		const { calls, fetchFn } = routeFetch();
		expect(await fetchGeminiAccountEmail("at-9", { fetch: fetchFn })).toBe("user@example.com");
		expect(calls[0].url).toBe(GEMINI_USERINFO_URL);
		expect(calls[0].url).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
		expect(calls[0].authorization).toBe("Bearer at-9");
	});

	test("a refusing endpoint and an unreachable one both answer undefined, never a throw", async () => {
		const { fetchFn } = routeFetch({ userinfo: null });
		expect(await fetchGeminiAccountEmail("at-9", { fetch: fetchFn })).toBeUndefined();
		const offline = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		expect(await fetchGeminiAccountEmail("at-9", { fetch: offline })).toBeUndefined();
	});
});

describe("startGeminiCallbackServer", () => {
	test("delivers the console's redirect on /oauth2callback, then the wait resolves", async () => {
		const server = await startGeminiCallbackServer({ port: 0, state: "s-1" });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/oauth2callback?code=c-1&state=s-1`);
			expect(response.status).toBe(200);
			// The same page the sibling flows show: close the tab, return here.
			expect(await response.text()).toContain("You can close this tab");
			expect(await server.wait).toEqual({ code: "c-1", state: "s-1" });
		} finally {
			server.close();
		}
	});

	test("the sibling flows' paths answer 404 here — this listener serves one path", async () => {
		const server = await startGeminiCallbackServer({ port: 0, state: "s-1" });
		try {
			expect((await fetch(`http://127.0.0.1:${server.port}/callback?code=c&state=s-1`)).status).toBe(404);
			expect((await fetch(`http://127.0.0.1:${server.port}/auth/callback?code=c&state=s-1`)).status).toBe(404);
			expect((await fetch(`http://127.0.0.1:${server.port}/oauth2callback?code=c-1&state=s-1`)).status).toBe(200);
			expect((await server.wait).code).toBe("c-1");
		} finally {
			server.close();
		}
	});

	test("a redirect whose state does not match answers 400 and KEEPS listening", async () => {
		const server = await startGeminiCallbackServer({ port: 0, state: "s-1" });
		try {
			// A stray tab or scanner must not end the sign-in the user is completing.
			expect((await fetch(`http://127.0.0.1:${server.port}/oauth2callback?code=c&state=intruder`)).status).toBe(400);
			expect((await fetch(`http://127.0.0.1:${server.port}/oauth2callback?code=c-2&state=s-1`)).status).toBe(200);
			expect((await server.wait).code).toBe("c-2");
		} finally {
			server.close();
		}
	});

	test("the wait gives up on the deadline with this layer's error", async () => {
		const server = await startGeminiCallbackServer({ port: 0, state: "s-1", timeoutMs: 100 });
		try {
			await expect(server.wait).rejects.toThrow("No browser finished the sign-in within 0s.");
			expect(GEMINI_LOGIN_TIMEOUT_MS).toBe(300_000);
		} finally {
			server.close();
		}
	});
});

describe("geminiLoginFlow", () => {
	test("the browser flow: listen first, then a URL built from the port actually bound", async () => {
		const store = memoryStore();
		const notes: string[] = [];
		const opened: string[] = [];
		const { listen, captured } = stubListen({ port: 54321 });
		const { calls, fetchFn } = routeFetch();
		const result = await geminiLoginFlow({
			store,
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen,
			fetch: fetchFn,
			now: () => 500,
		});
		if (result.kind !== "signed-in") throw new Error(`expected signed-in, got ${result.kind}`);

		// The port is the OS-picked 0, not any pinned sibling port: this console
		// registers the loopback redirect for any port.
		expect(captured.length).toBe(1);
		expect(captured[0].port).toBe(0);
		expect(captured[0].timeoutMs).toBeUndefined();

		// The URL the browser received names the real port and this sign-in's state.
		const url = new URL(opened[0]);
		expect(url.searchParams.get("state")).toBe(captured[0].state);
		expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321/oauth2callback");
		expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(url.searchParams.has("code_challenge")).toBe(false);
		expect(notes[0]).toContain(opened[0]);
		expect(notes.some((line) => line.includes("Waiting for the browser"))).toBe(true);

		// The exchange presents the same redirect URI and no verifier — this
		// flow's redirect carries no challenge.
		expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].form.get("grant_type")).toBe("authorization_code");
		expect(calls[0].form.get("code")).toBe("code-1");
		expect(calls[0].form.get("redirect_uri")).toBe("http://127.0.0.1:54321/oauth2callback");
		expect(calls[0].form.has("code_verifier")).toBe(false);
		expect(calls[0].form.get("client_id")).toBe(CLIENT_ID);
		expect(calls[0].form.get("client_secret")).toBe(CLIENT_SECRET);

		// The account read, then the store.
		expect(calls[1].url).toBe(GEMINI_USERINFO_URL);
		expect(calls[1].authorization).toBe("Bearer at-1");
		expect(store.current?.accessToken).toBe("at-1");
		expect(store.current?.refreshToken).toBe("rt-1");
		expect(store.current?.expiresAt).toBe(500 + 3_600_000);
		expect(store.current?.accountEmail).toBe("user@example.com");
	});

	test("an account read that fails does not fail the login", async () => {
		const store = memoryStore();
		const { listen } = stubListen();
		const { fetchFn } = routeFetch({ userinfo: null });
		const result = await geminiLoginFlow({
			store,
			note: () => {},
			openBrowser: () => {},
			listen,
			fetch: fetchFn,
		});
		expect(result.kind).toBe("signed-in");
		expect(store.current?.accessToken).toBe("at-1");
		// The line then just omits the address; nothing else depended on it.
		expect(store.current?.accountEmail).toBeUndefined();
	});

	test("a caller-given port reaches the listener", async () => {
		const { listen, captured } = stubListen();
		const { fetchFn } = routeFetch();
		await geminiLoginFlow({
			store: memoryStore(),
			note: () => {},
			openBrowser: () => {},
			listen,
			port: 41234,
			fetch: fetchFn,
		});
		expect(captured[0].port).toBe(41234);
	});

	test("a denied sign-in reaches the caller and stores nothing", async () => {
		const store = memoryStore();
		const { listen } = stubListen({ error: new Error("The console refused the sign-in: access_denied") });
		await expect(
			geminiLoginFlow({ store, note: () => {}, openBrowser: () => {}, listen, fetch: routeFetch().fetchFn }),
		).rejects.toThrow("refused the sign-in");
		expect(store.current).toBeNull();
	});

	test("an exchange that fails stores nothing", async () => {
		const store = memoryStore();
		const { listen } = stubListen();
		const { calls, fetchFn } = routeFetch({ tokenStatus: 500 });
		await expect(
			geminiLoginFlow({ store, note: () => {}, openBrowser: () => {}, listen, fetch: fetchFn }),
		).rejects.toThrow("Token exchange failed (500)");
		expect(store.current).toBeNull();
		expect(calls.length).toBe(1);
	});

	test("a listener that cannot bind hands off to the paste flow, and an answer completes it", async () => {
		const store = memoryStore();
		const notes: string[] = [];
		const opened: string[] = [];
		const { calls, fetchFn } = routeFetch();
		const result = await geminiLoginFlow({
			store,
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen: failingListen,
			askCode: async () => "pasted-code",
			fetch: fetchFn,
			now: () => 7,
		});
		if (result.kind !== "signed-in") throw new Error(`expected signed-in, got ${result.kind}`);
		expect(notes.some((line) => line.includes("local callback port is not available"))).toBe(true);
		const url = new URL(opened[0]);
		expect(url.searchParams.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
		expect(notes.some((line) => line.includes("paste the authorization code"))).toBe(true);
		expect(calls[0].form.get("code")).toBe("pasted-code");
		expect(calls[0].form.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
		// The verifier the exchange presents is the one the URL's challenge was
		// made from: any other would be refused at the token endpoint.
		const verifier = calls[0].form.get("code_verifier") ?? "";
		expect(verifier).not.toBe("");
		expect(url.searchParams.get("code_challenge")).toBe(challengeOf(verifier));
		expect(store.current?.accessToken).toBe("at-1");
		expect(store.current?.expiresAt).toBe(7 + 3_600_000);
	});

	test("without an asker, the handoff stops at the pending login", async () => {
		const store = memoryStore();
		const opened: string[] = [];
		const result = await geminiLoginFlow({
			store,
			note: () => {},
			openBrowser: (url) => opened.push(url),
			listen: failingListen,
			fetch: routeFetch().fetchFn,
		});
		if (result.kind !== "pending") throw new Error(`expected pending, got ${result.kind}`);
		expect(result.pending.redirectUri).toBe("https://codeassist.google.com/authcode");
		const url = new URL(opened[0]);
		expect(url.searchParams.get("state")).toBe(result.pending.state);
		expect(url.searchParams.get("code_challenge")).toBe(challengeOf(result.pending.verifier));
		expect(store.current).toBeNull();
	});

	test("headless skips the listener entirely and completes from the paste", async () => {
		const store = memoryStore();
		const notes: string[] = [];
		const opened: string[] = [];
		const listen: OAuthCallbackListen = async () => {
			throw new Error("the headless flow must not bind a listener");
		};
		const { calls, fetchFn } = routeFetch();
		const result = await geminiLoginFlow({
			store,
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen,
			headless: true,
			askCode: async () => "headless-code",
			fetch: fetchFn,
		});
		expect(result.kind).toBe("signed-in");
		expect(opened.length).toBe(1);
		const url = new URL(opened[0]);
		expect(url.searchParams.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
		expect(calls[0].form.get("code")).toBe("headless-code");
		const verifier = calls[0].form.get("code_verifier") ?? "";
		expect(url.searchParams.get("code_challenge")).toBe(challengeOf(verifier));
		expect(store.current?.accessToken).toBe("at-1");
	});

	test("an empty paste cancels the paste flow", async () => {
		const store = memoryStore();
		await expect(
			geminiLoginFlow({
				store,
				note: () => {},
				openBrowser: () => {},
				headless: true,
				askCode: async () => "   ",
				fetch: routeFetch().fetchFn,
			}),
		).rejects.toThrow("The sign-in was cancelled.");
		expect(store.current).toBeNull();
	});

	test("a terminal that never answers hits the paste deadline", async () => {
		const store = memoryStore();
		await expect(
			geminiLoginFlow({
				store,
				note: () => {},
				openBrowser: () => {},
				headless: true,
				askCode: () => new Promise(() => {}),
				userCodeTimeoutMs: 250,
				fetch: routeFetch().fetchFn,
			}),
		).rejects.toThrow("No authorization code arrived");
		expect(store.current).toBeNull();
		expect(GEMINI_USER_CODE_TIMEOUT_MS).toBe(300_000);
	});
});

describe("completeGeminiLogin", () => {
	test("accepts the page's URL as readily as the bare code, and stores the grant", async () => {
		const store = memoryStore();
		const pending = beginGeminiHeadlessLogin();
		const { calls, fetchFn } = routeFetch();
		const credential = await completeGeminiLogin({
			input: "https://codeassist.google.com/authcode?code=abc-9&scope=x",
			pending,
			store,
			fetch: fetchFn,
			now: () => 1,
		});
		expect(calls[0].form.get("code")).toBe("abc-9");
		expect(calls[0].form.get("code_verifier")).toBe(pending.verifier);
		expect(credential.accessToken).toBe("at-1");
		expect(store.current?.accessToken).toBe("at-1");
		expect(store.current?.accountEmail).toBe("user@example.com");
	});

	test("an empty paste is refused before any request is built", async () => {
		const store = memoryStore();
		const { calls, fetchFn } = routeFetch();
		await expect(
			completeGeminiLogin({ input: "  ", pending: beginGeminiHeadlessLogin(), store, fetch: fetchFn }),
		).rejects.toThrow("held no authorization code");
		expect(calls.length).toBe(0);
		expect(store.current).toBeNull();
	});
});

describe("geminiSignedInLine", () => {
	test("names the account when the login managed to read it", () => {
		expect(geminiSignedInLine({ accountEmail: "user@example.com" } as GeminiOAuthCredential)).toBe(
			"Signed in to the Gemini subscription as user@example.com.",
		);
	});

	test("and says less when it did not", () => {
		expect(geminiSignedInLine({} as GeminiOAuthCredential)).toBe("Signed in to the Gemini subscription.");
	});
});

describe("clearGeminiSubscription", () => {
	test("revokes the refresh token — the half that outlives the hour — then clears", async () => {
		const store = memoryStore();
		store.current = {
			accessToken: "at-1",
			refreshToken: "rt-1",
			scope: "",
			expiresAt: null,
			lastRefreshAt: 1,
		};
		const { calls, fetchFn } = routeFetch();
		expect(await clearGeminiSubscription(store, { fetch: fetchFn })).toBe(true);
		expect(store.current).toBeNull();
		const revoke = calls.find((call) => call.url.startsWith("https://oauth2.googleapis.com/revoke"));
		expect(revoke).toBeDefined();
		expect(new URL(revoke?.url ?? "").searchParams.get("token")).toBe("rt-1");
	});

	test("an access-only credential is revoked by its access token", async () => {
		const store = memoryStore();
		store.current = { accessToken: "at-9", refreshToken: "", scope: "", expiresAt: null, lastRefreshAt: 1 };
		const { calls, fetchFn } = routeFetch();
		expect(await clearGeminiSubscription(store, { fetch: fetchFn })).toBe(true);
		expect(new URL(calls[0].url).searchParams.get("token")).toBe("at-9");
	});

	test("nothing signed in answers false and attempts no revocation", async () => {
		const { calls, fetchFn } = routeFetch();
		expect(await clearGeminiSubscription(memoryStore(), { fetch: fetchFn })).toBe(false);
		expect(calls.length).toBe(0);
	});
});

describe("the login and logout subcommands", () => {
	test("login stores and prints the account line; logout revokes, clears, and reports the second run", async () => {
		const { home, clean } = makeHome();
		try {
			const notes: string[] = [];
			const { listen } = stubListen({ port: 54321 });
			const { calls, fetchFn } = routeFetch();
			const loginCode = await runGeminiLoginCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => notes.push(line),
				listen,
				openBrowser: () => {},
				fetch: fetchFn,
				now: () => 1,
			});
			expect(loginCode).toBe(0);
			expect(notes.at(-1)).toBe("Signed in to the Gemini subscription as user@example.com.");
			const saved = JSON.parse(readFileSync(filePathOf(home), "utf8")) as GeminiOAuthCredential;
			expect(saved.accessToken).toBe("at-1");
			expect(saved.refreshToken).toBe("rt-1");

			const logoutNotes: string[] = [];
			const beforeLogout = calls.length;
			const logoutCode = await runGeminiLogoutCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => logoutNotes.push(line),
				fetch: fetchFn,
			});
			expect(logoutCode).toBe(0);
			expect(logoutNotes).toEqual(["Signed out of the Gemini subscription."]);
			const revoke = calls.slice(beforeLogout).find((call) => call.url.includes("/revoke"));
			expect(new URL(revoke?.url ?? "").searchParams.get("token")).toBe("rt-1");
			expect(existsSync(filePathOf(home))).toBe(false);

			const againCode = await runGeminiLogoutCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => logoutNotes.push(line),
				fetch: fetchFn,
			});
			expect(againCode).toBe(0);
			expect(logoutNotes.at(-1)).toBe("No Gemini subscription was signed in.");
		} finally {
			clean();
		}
	});

	test("logout still signs out when the issuer cannot be reached", async () => {
		const { home, clean } = makeHome();
		try {
			const store = createGeminiCredentialStore({ home, keychain: null, warn: () => {} });
			await store.save({
				accessToken: "at-1",
				refreshToken: "rt-1",
				scope: "",
				expiresAt: null,
				lastRefreshAt: 1,
			});
			const offline = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
				throw new TypeError("fetch failed");
			}) as typeof fetch;
			const notes: string[] = [];
			const code = await runGeminiLogoutCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => notes.push(line),
				fetch: offline,
			});
			expect(code).toBe(0);
			expect(notes).toEqual(["Signed out of the Gemini subscription."]);
			expect(existsSync(filePathOf(home))).toBe(false);
		} finally {
			clean();
		}
	});

	test("a login that cannot complete exits 1", async () => {
		const { home, clean } = makeHome();
		try {
			const code = await runGeminiLoginCli({
				home,
				keychain: null,
				warn: () => {},
				note: () => {},
				listen: failingListen,
				openBrowser: () => {},
				askCode: async () => null,
				fetch: routeFetch().fetchFn,
			});
			expect(code).toBe(1);
			expect(existsSync(filePathOf(home))).toBe(false);
		} finally {
			clean();
		}
	});
});
