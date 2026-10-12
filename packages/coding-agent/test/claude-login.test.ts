/**
 * The sign-in flow: the handshake, the callback listener, and the two shapes
 * of the fallback.
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
import { CLAUDE_OAUTH_MANUAL_REDIRECT_URL, type ClaudeCredentialStore, type ClaudeOAuthCredential } from "@labunbun/ai";
import {
	beginClaudeLogin,
	CLAUDE_LOGIN_PORT,
	CLAUDE_LOGIN_REDIRECT_URL,
	claudeLoginFlow,
	completeClaudeLogin,
	runClaudeLoginCli,
	runClaudeLogoutCli,
	startClaudeCallbackServer,
} from "../src/claude-login.ts";

/** What the token endpoint answers; one shape for every test here. */
const TOKEN_RESPONSE = {
	access_token: "at-1",
	refresh_token: "rt-1",
	expires_in: 3600,
	refresh_token_expires_in: 2_592_000,
	scope: "user:profile user:inference",
	account: { email_address: "user@example.com" },
};

interface FetchCall {
	url: string;
	body: Record<string, unknown>;
}

function fakeFetch(response: object = TOKEN_RESPONSE, status = 200): { calls: FetchCall[]; fetchFn: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ url: String(url), body });
		return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { calls, fetchFn };
}

interface MemoryStore extends ClaudeCredentialStore {
	current: ClaudeOAuthCredential | null;
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

function makeHome(): { home: string; clean: () => void } {
	const home = mkdtempSync(join(tmpdir(), "lbb-claude-login-"));
	return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
}

describe("beginClaudeLogin", () => {
	test("builds the authorize URL the console's own links use", () => {
		const pending = beginClaudeLogin();
		const url = new URL(pending.authorizeUrl);
		expect(`${url.origin}${url.pathname}`).toBe("https://claude.com/cai/oauth/authorize");
		expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_LOGIN_REDIRECT_URL);
		expect(url.searchParams.get("state")).toBe(pending.state);
		// The challenge is the verifier's SHA-256, base64url — recomputed here,
		// not read back, so a swapped pair fails.
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(pending.verifier).digest("base64url"),
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("scope")).toContain("user:inference");
		// The exact registered literal, spelled out: the console refuses any other
		// host, port, or path. Comparing against the constant would re-derive both
		// sides and pass for any port — the ChatGPT sibling survived exactly that
		// mutation before its literal pin existed.
		expect(CLAUDE_LOGIN_REDIRECT_URL).toBe("http://localhost:1455/callback");
		expect(CLAUDE_LOGIN_PORT).toBe(1455);
	});

	test("honors a custom redirect for the manual flow", () => {
		const pending = beginClaudeLogin({ redirectUri: CLAUDE_OAUTH_MANUAL_REDIRECT_URL });
		const url = new URL(pending.authorizeUrl);
		expect(url.searchParams.get("redirect_uri")).toBe(CLAUDE_OAUTH_MANUAL_REDIRECT_URL);
		expect(pending.redirectUri).toBe(CLAUDE_OAUTH_MANUAL_REDIRECT_URL);
	});
});

describe("completeClaudeLogin", () => {
	test("exchanges a pasted code#state and stores the credential", async () => {
		const pending = beginClaudeLogin();
		const { calls, fetchFn } = fakeFetch();
		const store = memoryStore();
		const credential = await completeClaudeLogin({
			input: `the-code#${pending.state}`,
			pending,
			store,
			fetch: fetchFn,
			now: () => 111,
		});
		expect(credential.accessToken).toBe("at-1");
		expect(credential.expiresAt).toBe(111 + 3_600_000);
		expect(store.current).toBe(credential);
		expect(calls.length).toBe(1);
		expect(calls[0].url).toContain("/v1/oauth/token");
		expect(calls[0].body.grant_type).toBe("authorization_code");
		expect(calls[0].body.code).toBe("the-code");
		expect(calls[0].body.state).toBe(pending.state);
		expect(calls[0].body.code_verifier).toBe(pending.verifier);
		expect(calls[0].body.redirect_uri).toBe(CLAUDE_LOGIN_REDIRECT_URL);
	});

	test("a bare code with no state is accepted", async () => {
		const pending = beginClaudeLogin();
		const { calls, fetchFn } = fakeFetch();
		const store = memoryStore();
		await completeClaudeLogin({ input: "the-code", pending, store, fetch: fetchFn });
		expect(calls[0].body.code).toBe("the-code");
		expect("state" in calls[0].body).toBe(false);
	});

	test("a state from another login attempt is refused before any exchange", async () => {
		const pending = beginClaudeLogin();
		const { calls, fetchFn } = fakeFetch();
		const store = memoryStore();
		await expect(
			completeClaudeLogin({ input: "the-code#some-other-state", pending, store, fetch: fetchFn }),
		).rejects.toThrow("different login attempt");
		expect(calls.length).toBe(0);
		expect(store.current).toBeNull();
	});

	test("an empty paste is refused before any exchange", async () => {
		const pending = beginClaudeLogin();
		const { calls, fetchFn } = fakeFetch();
		await expect(completeClaudeLogin({ input: "   ", pending, store: memoryStore(), fetch: fetchFn })).rejects.toThrow(
			"no authorization code",
		);
		expect(calls.length).toBe(0);
	});

	test("a failed exchange does not touch the store", async () => {
		const pending = beginClaudeLogin();
		const { fetchFn } = fakeFetch({ error: "server_error" }, 500);
		const store = memoryStore();
		await expect(
			completeClaudeLogin({ input: `the-code#${pending.state}`, pending, store, fetch: fetchFn }),
		).rejects.toThrow("Token exchange failed (500)");
		expect(store.current).toBeNull();
	});
});

describe("startClaudeCallbackServer", () => {
	test("delivers the redirect, answers the page, and resolves the wait", async () => {
		const server = await startClaudeCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/callback?code=c-1&state=s-1`);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("Signed in");
			expect(await server.wait).toEqual({ code: "c-1", state: "s-1" });
		} finally {
			server.close();
		}
	});

	test("a wrong state answers 400 and keeps listening for the real redirect", async () => {
		const server = await startClaudeCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const bad = await fetch(`http://127.0.0.1:${server.port}/callback?code=c&state=other`);
			expect(bad.status).toBe(400);
			const good = await fetch(`http://127.0.0.1:${server.port}/callback?code=c-1&state=s-1`);
			expect(good.status).toBe(200);
			expect(await server.wait).toEqual({ code: "c-1", state: "s-1" });
		} finally {
			server.close();
		}
	});

	test("answers other paths with 404", async () => {
		const server = await startClaudeCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/somewhere-else`);
			expect(response.status).toBe(404);
		} finally {
			server.close();
		}
	});

	test("a denied sign-in rejects with the console's reason", async () => {
		const server = await startClaudeCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(
				`http://127.0.0.1:${server.port}/callback?error=access_denied&error_description=denied+by+user&state=s-1`,
			);
			expect(response.status).toBe(400);
			await expect(server.wait).rejects.toThrow("denied by user");
		} finally {
			server.close();
		}
	});

	test("a matching state with no code rejects", async () => {
		const server = await startClaudeCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		try {
			const response = await fetch(`http://127.0.0.1:${server.port}/callback?state=s-1`);
			expect(response.status).toBe(400);
			await expect(server.wait).rejects.toThrow("returned no authorization code");
		} finally {
			server.close();
		}
	});

	test("gives up after the timeout", async () => {
		const server = await startClaudeCallbackServer({ state: "s-1", port: 0, timeoutMs: 100 });
		try {
			await expect(server.wait).rejects.toThrow("No browser finished the sign-in");
		} finally {
			server.close();
		}
	});

	test("an aborted signal rejects the wait", async () => {
		const controller = new AbortController();
		const server = await startClaudeCallbackServer({
			state: "s-1",
			port: 0,
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		controller.abort();
		await expect(server.wait).rejects.toThrow("cancelled");
	});

	test("releases the port once the wait settles", async () => {
		const first = await startClaudeCallbackServer({ state: "s-1", port: 0, timeoutMs: 5_000 });
		const response = await fetch(`http://127.0.0.1:${first.port}/callback?code=c-1&state=s-1`);
		expect(response.status).toBe(200);
		await first.wait;
		// The same port binds again: the settle path really did close the socket.
		const again = await startClaudeCallbackServer({ state: "s-2", port: first.port, timeoutMs: 2_000 });
		expect(again.port).toBe(first.port);
		again.close();
	});
});

describe("claudeLoginFlow", () => {
	test("browser path: opens the URL, listens for its state, and stores the credential", async () => {
		const notes: string[] = [];
		const opened: string[] = [];
		const store = memoryStore();
		const { calls, fetchFn } = fakeFetch();
		let listenedState = "";
		const result = await claudeLoginFlow({
			store,
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen: async (options) => {
				listenedState = options.state;
				return {
					port: CLAUDE_LOGIN_PORT,
					wait: Promise.resolve({ code: "c-9", state: options.state }),
					close: () => {},
				};
			},
			fetch: fetchFn,
			now: () => 111,
		});
		expect(result.kind).toBe("signed-in");
		expect(store.current?.accessToken).toBe("at-1");
		expect(listenedState).not.toBe("");
		// The URL handed to the browser and the state the listener expects are the
		// same sign-in; two `begin` calls would silently never connect.
		expect(new URL(opened[0]).searchParams.get("state")).toBe(listenedState);
		expect(notes[0]).toContain(opened[0]);
		expect(calls[0].body.state).toBe(listenedState);
	});

	test("bind failure with an asker: the manual URL is offered and the paste completes", async () => {
		const notes: string[] = [];
		const opened: string[] = [];
		const store = memoryStore();
		const { calls, fetchFn } = fakeFetch();
		const result = await claudeLoginFlow({
			store,
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen: async () => {
				throw new Error("listen EADDRINUSE: address already in use");
			},
			askCode: async () => {
				// What the user does: read the code and state off the page the
				// second opened URL led to.
				if (opened.length < 2) throw new Error("the manual URL was never opened");
				const url = new URL(opened[1]);
				return `manual-code#${url.searchParams.get("state") ?? ""}`;
			},
			fetch: fetchFn,
			now: () => 111,
		});
		expect(result.kind).toBe("signed-in");
		expect(store.current?.accessToken).toBe("at-1");
		expect(opened.length).toBe(2);
		expect(notes.join("\n")).toContain("not available");
		expect(calls[0].body.redirect_uri).toBe(CLAUDE_OAUTH_MANUAL_REDIRECT_URL);
		expect(calls[0].body.code).toBe("manual-code");
	});

	test("bind failure without an asker: the pending login comes back for later", async () => {
		const notes: string[] = [];
		const opened: string[] = [];
		const result = await claudeLoginFlow({
			store: memoryStore(),
			note: (line) => notes.push(line),
			openBrowser: (url) => opened.push(url),
			listen: async () => {
				throw new Error("listen EADDRINUSE: address already in use");
			},
		});
		expect(result.kind).toBe("pending");
		if (result.kind === "pending") {
			expect(result.pending.redirectUri).toBe(CLAUDE_OAUTH_MANUAL_REDIRECT_URL);
			expect(notes.join("\n")).toContain(result.pending.authorizeUrl);
			expect(result.pending.state).not.toBe("");
		}
		expect(opened.length).toBe(2);
	});

	test("an empty paste from the asker cancels the sign-in", async () => {
		await expect(
			claudeLoginFlow({
				store: memoryStore(),
				openBrowser: () => {},
				listen: async () => {
					throw new Error("listen EADDRINUSE");
				},
				askCode: async () => null,
			}),
		).rejects.toThrow("cancelled");
	});
});

describe("the login and logout subcommands", () => {
	test("login stores the credential and logout clears it", async () => {
		const { home, clean } = makeHome();
		try {
			const notes: string[] = [];
			const { fetchFn } = fakeFetch();
			const code = await runClaudeLoginCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => notes.push(line),
				openBrowser: () => {},
				listen: async (options) => ({
					port: CLAUDE_LOGIN_PORT,
					wait: Promise.resolve({ code: "c-1", state: options.state }),
					close: () => {},
				}),
				fetch: fetchFn,
				now: () => 111,
			});
			expect(code).toBe(0);
			expect(notes.join("\n")).toContain("Signed in to the Claude subscription as user@example.com.");
			const filePath = join(home, ".labunbun", ".credentials.json");
			expect(JSON.parse(readFileSync(filePath, "utf8")).accessToken).toBe("at-1");

			const logoutNotes: string[] = [];
			const firstLogout = await runClaudeLogoutCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => logoutNotes.push(line),
			});
			expect(firstLogout).toBe(0);
			expect(logoutNotes).toEqual(["Signed out of the Claude subscription."]);
			expect(existsSync(filePath)).toBe(false);

			const secondLogout = await runClaudeLogoutCli({
				home,
				keychain: null,
				warn: () => {},
				note: (line) => logoutNotes.push(line),
			});
			expect(secondLogout).toBe(0);
			expect(logoutNotes[1]).toBe("No Claude subscription was signed in.");
		} finally {
			clean();
		}
	});

	test("login reports a cancelled sign-in with exit code 1", async () => {
		const { home, clean } = makeHome();
		try {
			const code = await runClaudeLoginCli({
				home,
				keychain: null,
				warn: () => {},
				note: () => {},
				openBrowser: () => {},
				listen: async () => {
					throw new Error("listen EADDRINUSE");
				},
				askCode: async () => null,
				fetch: fakeFetch().fetchFn,
			});
			expect(code).toBe(1);
		} finally {
			clean();
		}
	});
});
