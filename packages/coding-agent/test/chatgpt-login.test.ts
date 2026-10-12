/**
 * The ChatGPT sign-in flow: the callback handshake, the device fallback, and
 * the two subcommands.
 *
 * The browser is never opened and the network never leaves the machine: the
 * opener is a collector, the token endpoint is a fake fetch, and the flow
 * tests drive the listener through an injected `listen`. The listener's own
 * tests use real loopback sockets on port 0, because a fake server would
 * assert the shape this file wishes node:http had, not the one it has.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ChatGptCredentialStore,
	type ChatGptDeviceCode,
	type ChatGptOAuthCredential,
	ChatGptOAuthError,
	type CompleteChatGptDeviceLoginOptions,
} from "@labunbun/ai";
import {
	beginChatGptLogin,
	CHATGPT_LOGIN_PORT,
	CHATGPT_LOGIN_REDIRECT_URL,
	chatGptLoginFlow,
	chatGptSignedInLine,
	runChatGptLoginCli,
	runChatGptLogoutCli,
	startChatGptCallbackServer,
} from "../src/chatgpt-login.ts";

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jwt(payload: Record<string, unknown>): string {
	return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

/** What the token endpoint answers; the claims are the ones the store reads. */
const ACCESS_TOKEN = jwt({ exp: 1_999 });
const ID_TOKEN = jwt({
	email: "user@example.com",
	"https://api.openai.com/auth": {
		chatgpt_account_id: "acct-1",
		chatgpt_plan_type: "plus",
		chatgpt_account_is_fedramp: false,
	},
});
const TOKEN_RESPONSE = { access_token: ACCESS_TOKEN, refresh_token: "rt-1", id_token: ID_TOKEN };

interface FetchCall {
	url: string;
	form: URLSearchParams;
}

function fakeFetch(response: object = TOKEN_RESPONSE, status = 200): { calls: FetchCall[]; fetchFn: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), form: new URLSearchParams(String(init?.body ?? "")) });
		return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { calls, fetchFn };
}

interface MemoryStore extends ChatGptCredentialStore {
	current: ChatGptOAuthCredential | null;
}

function memoryStore(): MemoryStore {
	return {
		current: null,
		async load() {
			return this.current;
		},
		async save(credential) {
			this.current = credential;
		},
		async clear() {
			this.current = null;
		},
	};
}

function credential(): ChatGptOAuthCredential {
	return {
		accessToken: "at-1",
		refreshToken: "rt-1",
		idToken: ID_TOKEN,
		accountId: "acct-1",
		expiresAt: 1_999_000,
		lastRefreshAt: 900,
		accountEmail: "user@example.com",
		planType: "plus",
		fedramp: false,
	};
}

function makeHome(): { home: string; clean: () => void } {
	const home = mkdtempSync(join(tmpdir(), "lbb-chatgpt-login-"));
	return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
}

describe("beginChatGptLogin", () => {
	test("builds the authorize URL the codex client's links use", () => {
		const pending = beginChatGptLogin();
		const url = new URL(pending.authorizeUrl);
		expect(`${url.origin}${url.pathname}`).toBe("https://auth.openai.com/oauth/authorize");
		expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(url.searchParams.get("redirect_uri")).toBe(CHATGPT_LOGIN_REDIRECT_URL);
		expect(url.searchParams.get("state")).toBe(pending.state);
		// The challenge is the verifier's SHA-256, base64url — recomputed here,
		// not read back, so a swapped pair fails.
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(pending.verifier).digest("base64url"),
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("scope")).toContain("offline_access");
		expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
		// The exact registered literal, spelled out: the console refuses any other
		// host, port, or path. Comparing against the constant would re-derive both
		// sides and pass for any port — the mutation driver survived exactly that
		// before this literal pin existed.
		expect(CHATGPT_LOGIN_REDIRECT_URL).toBe("http://localhost:1455/auth/callback");
		expect(CHATGPT_LOGIN_PORT).toBe(1455);
	});

	test("honors a custom redirect", () => {
		const pending = beginChatGptLogin({ redirectUri: "http://localhost:9999/auth/callback" });
		const url = new URL(pending.authorizeUrl);
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:9999/auth/callback");
		expect(pending.redirectUri).toBe("http://localhost:9999/auth/callback");
	});
});

describe("startChatGptCallbackServer", () => {
	test("delivers the redirect on /auth/callback, answers the page, and resolves the wait", async () => {
		const server = await startChatGptCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/auth/callback?code=c-1&state=s-1`);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("Signed in");
			expect(await server.wait).toEqual({ code: "c-1", state: "s-1" });
		} finally {
			server.close();
		}
	});

	test("answers the Claude path with 404: this listener waits for its own callback only", async () => {
		const server = await startChatGptCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/callback?code=c-1&state=s-1`);
			expect(response.status).toBe(404);
		} finally {
			server.close();
		}
	});

	test("a wrong state answers 400 and keeps listening for the real redirect", async () => {
		const server = await startChatGptCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const bad = await fetch(`http://127.0.0.1:${server.port}/auth/callback?code=c&state=other`);
			expect(bad.status).toBe(400);
			const good = await fetch(`http://127.0.0.1:${server.port}/auth/callback?code=c-1&state=s-1`);
			expect(good.status).toBe(200);
			expect(await server.wait).toEqual({ code: "c-1", state: "s-1" });
		} finally {
			server.close();
		}
	});

	test("a denied sign-in rejects with this layer's error type and the console's reason", async () => {
		const server = await startChatGptCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${server.port}/auth/callback?error=access_denied&error_description=denied+by+user&state=s-1`,
			);
			expect(response.status).toBe(400);
			await expect(server.wait).rejects.toBeInstanceOf(ChatGptOAuthError);
			await expect(server.wait).rejects.toThrow("denied by user");
		} finally {
			server.close();
		}
	});

	test("a matching state with no code rejects", async () => {
		const server = await startChatGptCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/auth/callback?state=s-1`);
			expect(response.status).toBe(400);
			await expect(server.wait).rejects.toThrow("returned no authorization code");
		} finally {
			server.close();
		}
	});

	test("gives up after the timeout", async () => {
		const server = await startChatGptCallbackServer({ state: "s-1", port: 0, timeoutMs: 100 });
		try {
			await expect(server.wait).rejects.toThrow("No browser finished the sign-in");
		} finally {
			server.close();
		}
	});

	test("releases the port once the wait settles", async () => {
		const first = await startChatGptCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		const response = await fetch(`http://127.0.0.1:${first.port}/auth/callback?code=c-1&state=s-1`);
		expect(response.status).toBe(200);
		await first.wait;
		// The same port binds again: the settle path really did close the socket.
		const again = await startChatGptCallbackServer({ state: "s-2", port: first.port, timeoutMs: 2_000 });
		expect(again.port).toBe(first.port);
		again.close();
	});
});

describe("chatGptLoginFlow", () => {
	test("browser path: opens the URL, listens for its state, and stores the credential", async () => {
		const notes: string[] = [];
		const opened: string[] = [];
		const store = memoryStore();
		const { calls, fetchFn } = fakeFetch();
		let listenedState = "";
		const result = await chatGptLoginFlow({
			store,
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen: async (options) => {
				listenedState = options.state;
				return {
					port: CHATGPT_LOGIN_PORT,
					wait: Promise.resolve({ code: "c-9", state: options.state }),
					close: () => {},
				};
			},
			fetch: fetchFn,
			now: () => 111,
		});
		expect(result.accessToken).toBe(ACCESS_TOKEN);
		expect(result.accountId).toBe("acct-1");
		expect(store.current?.accessToken).toBe(ACCESS_TOKEN);
		expect(listenedState).not.toBe("");
		// The URL handed to the browser and the state the listener expects are the
		// same sign-in; two `begin` calls would silently never connect.
		expect(new URL(opened[0]).searchParams.get("state")).toBe(listenedState);
		expect(notes[0]).toContain(opened[0]);
		expect(notes.join("\n")).toContain("Waiting for the browser");
		// The exchange presents the verifier whose challenge the browser was
		// given — recomputed, so a swapped pair across the two halves fails.
		expect(new URL(opened[0]).searchParams.get("code_challenge")).toBe(
			createHash("sha256")
				.update(calls[0].form.get("code_verifier") ?? "")
				.digest("base64url"),
		);
		expect(calls[0].form.get("grant_type")).toBe("authorization_code");
		expect(calls[0].form.get("code")).toBe("c-9");
		expect(calls[0].form.get("redirect_uri")).toBe(CHATGPT_LOGIN_REDIRECT_URL);
	});

	test("bind failure falls back to the device sign-in, which completes without a second keystroke", async () => {
		const notes: string[] = [];
		const opened: string[] = [];
		const store = memoryStore();
		const { calls, fetchFn } = fakeFetch();
		const device: ChatGptDeviceCode = {
			deviceAuthId: "da-1",
			userCode: "CODE-12",
			verificationUrl: "https://auth.openai.com/codex/device",
			intervalMs: 5,
		};
		const completed: CompleteChatGptDeviceLoginOptions[] = [];
		const stored = credential();
		const result = await chatGptLoginFlow({
			store,
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen: async () => {
				throw new Error("listen EADDRINUSE: address already in use");
			},
			requestDevice: async () => device,
			completeDevice: async (options) => {
				completed.push(options);
				return stored;
			},
			deviceTimeoutMs: 1_234,
			fetch: fetchFn,
			now: () => 111,
		});
		expect(result).toBe(stored);
		expect(store.current).toBe(stored);
		// Both URLs were opened, in order: the authorize page first, then the
		// device page the fallback decided on.
		expect(opened.length).toBe(2);
		expect(new URL(opened[0]).pathname).toBe("/oauth/authorize");
		expect(opened[1]).toBe("https://auth.openai.com/codex/device");
		expect(notes.join("\n")).toContain("The local callback port is not available (listen EADDRINUSE");
		expect(notes.join("\n")).toContain("Trying the device sign-in instead");
		expect(notes.join("\n")).toContain("Open https://auth.openai.com/codex/device and enter the code CODE-12.");
		expect(completed.length).toBe(1);
		expect(completed[0]).toMatchObject({ deviceAuthId: "da-1", userCode: "CODE-12", intervalMs: 5 });
		// The flow's knobs reach the device client, and the exchange is the
		// injected one — the network here is the fake, untouched.
		expect(completed[0].timeoutMs).toBe(1_234);
		expect(completed[0].fetch).toBe(fetchFn);
		expect(completed[0].now).toBe(111);
		expect(calls.length).toBe(0);
	});

	test("a failed exchange does not touch the store", async () => {
		const store = memoryStore();
		const { fetchFn } = fakeFetch({ error: "server_error" }, 500);
		await expect(
			chatGptLoginFlow({
				store,
				openBrowser: () => {},
				listen: async (options) => ({
					port: CHATGPT_LOGIN_PORT,
					wait: Promise.resolve({ code: "c-1", state: options.state }),
					close: () => {},
				}),
				fetch: fetchFn,
			}),
		).rejects.toThrow("Token exchange failed (500)");
		expect(store.current).toBeNull();
	});
});

describe("chatGptSignedInLine", () => {
	test("names the account and its plan when the token carries them", () => {
		expect(chatGptSignedInLine(credential())).toBe("Signed in to the ChatGPT subscription as user@example.com (plus).");
		expect(chatGptSignedInLine({ ...credential(), accountEmail: undefined })).toBe(
			"Signed in to the ChatGPT subscription (plus).",
		);
		expect(chatGptSignedInLine({ ...credential(), planType: undefined })).toBe(
			"Signed in to the ChatGPT subscription as user@example.com.",
		);
		expect(chatGptSignedInLine({ ...credential(), accountEmail: undefined, planType: undefined })).toBe(
			"Signed in to the ChatGPT subscription.",
		);
	});
});

describe("the login and logout subcommands", () => {
	test("login stores the credential and logout clears it", async () => {
		const { home, clean } = makeHome();
		try {
			const notes: string[] = [];
			const { fetchFn } = fakeFetch();
			const code = await runChatGptLoginCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => notes.push(line),
				openBrowser: () => {},
				listen: async (options) => ({
					port: CHATGPT_LOGIN_PORT,
					wait: Promise.resolve({ code: "c-1", state: options.state }),
					close: () => {},
				}),
				fetch: fetchFn,
				now: () => 111,
			});
			expect(code).toBe(0);
			expect(notes.join("\n")).toContain("Signed in to the ChatGPT subscription as user@example.com (plus).");
			const filePath = join(home, ".labunbun", ".chatgpt-credentials.json");
			expect(JSON.parse(readFileSync(filePath, "utf8")).accessToken).toBe(ACCESS_TOKEN);

			const logoutNotes: string[] = [];
			const firstLogout = await runChatGptLogoutCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => logoutNotes.push(line),
			});
			expect(firstLogout).toBe(0);
			expect(logoutNotes).toEqual(["Signed out of the ChatGPT subscription."]);
			expect(existsSync(filePath)).toBe(false);

			const secondLogout = await runChatGptLogoutCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => logoutNotes.push(line),
			});
			expect(secondLogout).toBe(0);
			expect(logoutNotes[1]).toBe("No ChatGPT subscription was signed in.");
		} finally {
			clean();
		}
	});

	test("a device fallback that cannot start reports the failure with exit code 1", async () => {
		const { home, clean } = makeHome();
		try {
			const code = await runChatGptLoginCli({
				home,
				keychain: null,
				warn: () => {},
				note: () => {},
				openBrowser: () => {},
				listen: async () => {
					throw new Error("listen EADDRINUSE");
				},
				requestDevice: async () => {
					throw new ChatGptOAuthError(
						"Device sign-in is not enabled for this server; use the browser sign-in instead.",
					);
				},
			});
			expect(code).toBe(1);
		} finally {
			clean();
		}
	});
});
