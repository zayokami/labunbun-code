/**
 * `/login chatgpt` and `/logout chatgpt`, wired to the REPL.
 *
 * Everything behind the commands is injected: the stores are memory objects,
 * the flow never opens a browser or a socket, and the token endpoint is never
 * reached. That is not only about speed — a `/logout chatgpt` test that used
 * the default hooks would clear the real keychain entry of whoever runs the
 * tests, and it would pass exactly the same way it does here.
 *
 * `chatgptLoginRunning` is module state, so tests run in order and each one
 * leaves it false. The bare `/login` and `/logout` are pinned here too: the
 * provider word re-routes them, and a regression that swallowed the bare
 * forms would otherwise only surface in the Claude suite — or not at all.
 */
import { describe, expect, test } from "bun:test";
import type {
	ChatGptCredentialStore,
	ChatGptOAuthCredential,
	ClaudeCredentialStore,
	ClaudeOAuthCredential,
} from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import type { ChatGptAuthHooks, ChatGptLoginFlowOptions } from "../src/chatgpt-login.ts";
import type { ClaudeAuthHooks } from "../src/claude-login.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

function credential(): ChatGptOAuthCredential {
	return {
		accessToken: "at-1",
		refreshToken: "rt-1",
		idToken: "header.payload.sig",
		accountId: "acct-1",
		expiresAt: 1_000,
		lastRefreshAt: 900,
		accountEmail: "user@example.com",
		planType: "plus",
		fedramp: false,
	};
}

function claudeCredential(): ClaudeOAuthCredential {
	return {
		accessToken: "cat-1",
		refreshToken: "crt-1",
		expiresAt: 1_000,
		refreshTokenExpiresAt: 2_000,
		scopes: ["user:inference"],
		clientId: "client-1",
		accountEmail: "user@example.com",
	};
}

interface MemoryStore extends ChatGptCredentialStore {
	current: ChatGptOAuthCredential | null;
}

function makeChatGptAuth(
	options: {
		login?: (options: ChatGptLoginFlowOptions) => Promise<ChatGptOAuthCredential>;
		seed?: ChatGptOAuthCredential | null;
	} = {},
) {
	const store: MemoryStore = {
		current: options.seed ?? null,
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
	const logins: ChatGptLoginFlowOptions[] = [];
	const hooks: ChatGptAuthHooks = {
		store: () => store,
		async login(loginOptions) {
			logins.push(loginOptions);
			return options.login ? options.login(loginOptions) : credential();
		},
	};
	return { hooks, store, logins };
}

interface MemoryClaudeStore extends ClaudeCredentialStore {
	current: ClaudeOAuthCredential | null;
}

function makeClaudeAuth(seed?: ClaudeOAuthCredential | null) {
	const store: MemoryClaudeStore = {
		current: seed ?? null,
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
	const logins: unknown[] = [];
	const hooks: ClaudeAuthHooks = {
		store: () => store,
		async login() {
			logins.push({});
			return { kind: "signed-in", credential: claudeCredential() };
		},
		async complete() {
			return claudeCredential();
		},
	};
	return { hooks, store, logins };
}

function makeCtx(auth: { claudeAuth?: ClaudeAuthHooks; chatgptAuth?: ChatGptAuthHooks }) {
	const store = createStore<UiState>({ ...initialUiState(false) });
	const ctx = {
		getSession: () => null,
		handle: { store },
		claudeAuth: auth.claudeAuth,
		chatgptAuth: auth.chatgptAuth,
	} as unknown as AppCommandContext;
	const info = () =>
		store
			.get()
			.entries.filter((e) => e.kind === "info")
			.map((e) => (e as { text: string }).text);
	return { ctx, info };
}

/** Let the fire-and-forget command bodies finish. */
function settle(): Promise<void> {
	return Bun.sleep(0);
}

describe("/login chatgpt and /logout chatgpt", () => {
	test("/logout chatgpt clears the ChatGPT credential, says so, and leaves the Claude one alone", async () => {
		const auth = makeChatGptAuth({ seed: credential() });
		const claude = makeClaudeAuth(claudeCredential());
		const { ctx, info } = makeCtx({ claudeAuth: claude.hooks, chatgptAuth: auth.hooks });
		expect(handleAppCommand("/logout chatgpt", ctx)).toBe(true);
		await settle();
		expect(auth.store.current).toBeNull();
		expect(info().join("\n")).toContain(
			"Signed out of the ChatGPT subscription. The next request to a ChatGPT model asks for a sign-in.",
		);
		// The other subscription's sign-in is a different credential entirely.
		expect(claude.store.current).not.toBeNull();
	});

	test("/logout chatgpt with nothing stored says nothing was signed in", async () => {
		const auth = makeChatGptAuth();
		const { ctx, info } = makeCtx({ chatgptAuth: auth.hooks });
		handleAppCommand("/logout chatgpt", ctx);
		await settle();
		expect(info().join("\n")).toContain("No ChatGPT subscription was signed in.");
	});

	test("/login chatgpt runs the ChatGPT flow, forwards its notes, and reports the account and plan", async () => {
		const auth = makeChatGptAuth({
			login: async (options) => {
				options.note?.(
					"Open this URL to sign in to a ChatGPT subscription: https://auth.openai.com/oauth/authorize?x=1",
				);
				return credential();
			},
		});
		const claude = makeClaudeAuth();
		const { ctx, info } = makeCtx({ claudeAuth: claude.hooks, chatgptAuth: auth.hooks });
		handleAppCommand("/login chatgpt", ctx);
		await settle();
		expect(auth.logins.length).toBe(1);
		expect(auth.logins[0].store).toBe(auth.store);
		// The provider word routed the command; the Claude flow never ran.
		expect(claude.logins.length).toBe(0);
		const text = info().join("\n");
		expect(text).toContain("Open this URL to sign in to a ChatGPT subscription:");
		expect(text).toContain("Signed in to the ChatGPT subscription as user@example.com (plus).");
	});

	test("an argument after the provider word is refused with the no-code note", async () => {
		const auth = makeChatGptAuth();
		const { ctx, info } = makeCtx({ chatgptAuth: auth.hooks });
		handleAppCommand("/login chatgpt abc123", ctx);
		await settle();
		expect(auth.logins.length).toBe(0);
		expect(info().join("\n")).toContain("The ChatGPT sign-in takes no code");
	});

	test("a failed sign-in is reported and does not leave the running flag stuck", async () => {
		let calls = 0;
		const auth = makeChatGptAuth({
			login: async () => {
				calls += 1;
				if (calls === 1) throw new Error("listen EADDRINUSE: address already in use");
				return credential();
			},
		});
		const { ctx, info } = makeCtx({ chatgptAuth: auth.hooks });
		handleAppCommand("/login chatgpt", ctx);
		await settle();
		expect(info().join("\n")).toContain("The sign-in did not complete: listen EADDRINUSE");

		// The `finally` released the guard: a second attempt runs.
		handleAppCommand("/login chatgpt", ctx);
		await settle();
		expect(auth.logins.length).toBe(2);
		expect(info().join("\n")).toContain("Signed in to the ChatGPT subscription as user@example.com (plus).");
	});

	test("a second /login chatgpt while one is running is refused", async () => {
		let release!: (result: ChatGptOAuthCredential) => void;
		const gate = new Promise<ChatGptOAuthCredential>((resolve) => {
			release = resolve;
		});
		const auth = makeChatGptAuth({ login: () => gate });
		const { ctx, info } = makeCtx({ chatgptAuth: auth.hooks });
		handleAppCommand("/login chatgpt", ctx);
		await settle();
		handleAppCommand("/login chatgpt", ctx);
		await settle();
		expect(auth.logins.length).toBe(1);
		expect(info().join("\n")).toContain("A ChatGPT sign-in is already running.");

		// Release so the module state is clean for the next test.
		release(credential());
		await settle();
		expect(info().join("\n")).toContain("Signed in to the ChatGPT subscription as user@example.com (plus).");
	});
});

describe("the bare forms still route to Claude", () => {
	test("/login with no provider word runs the Claude flow", async () => {
		const auth = makeChatGptAuth();
		const claude = makeClaudeAuth();
		const { ctx, info } = makeCtx({ claudeAuth: claude.hooks, chatgptAuth: auth.hooks });
		handleAppCommand("/login", ctx);
		await settle();
		expect(claude.logins.length).toBe(1);
		expect(auth.logins.length).toBe(0);
		expect(info().join("\n")).toContain("Signed in to the Claude subscription as user@example.com.");
	});

	test("/login claude names the same flow the bare form runs", async () => {
		const claude = makeClaudeAuth();
		const { ctx } = makeCtx({ claudeAuth: claude.hooks });
		handleAppCommand("/login claude", ctx);
		await settle();
		expect(claude.logins.length).toBe(1);
	});

	test("/logout with no provider word clears the Claude credential and leaves the ChatGPT one alone", async () => {
		const auth = makeChatGptAuth({ seed: credential() });
		const claude = makeClaudeAuth(claudeCredential());
		const { ctx, info } = makeCtx({ claudeAuth: claude.hooks, chatgptAuth: auth.hooks });
		handleAppCommand("/logout", ctx);
		await settle();
		expect(claude.store.current).toBeNull();
		expect(info().join("\n")).toContain("Signed out of the Claude subscription.");
		expect(auth.store.current).not.toBeNull();
	});
});
