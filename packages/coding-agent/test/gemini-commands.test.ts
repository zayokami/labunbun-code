/**
 * `/login gemini` and `/logout gemini`, wired to the REPL.
 *
 * Everything behind the commands is injected: the stores are memory objects,
 * the flow never opens a browser or a socket, and the token endpoint is never
 * reached. That is not only about speed — a `/logout gemini` test that used
 * the default hooks would clear the real keychain entry of whoever runs the
 * tests, and it would pass exactly the same way it does here.
 *
 * `pendingGeminiLogin` and `geminiLoginRunning` are module state, so tests run
 * in order and each one leaves both clean.
 */
import { describe, expect, test } from "bun:test";
import type { ClaudeCredentialStore, ClaudeOAuthCredential } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import type { ClaudeAuthHooks } from "../src/claude-login.ts";
import type { GeminiCredentialStore, GeminiOAuthCredential } from "../src/gemini-auth.ts";
import type {
	GeminiAuthHooks,
	GeminiLoginFlowOptions,
	GeminiLoginResult,
	PendingGeminiLogin,
} from "../src/gemini-login.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

function credential(): GeminiOAuthCredential {
	return {
		accessToken: "at-1",
		refreshToken: "rt-1",
		scope: "https://www.googleapis.com/auth/cloud-platform",
		expiresAt: 1_000,
		lastRefreshAt: 900,
		accountEmail: "user@example.com",
	};
}

function pendingLogin(): PendingGeminiLogin {
	return {
		authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
		verifier: "verifier-1",
		state: "state-1",
		redirectUri: "https://codeassist.google.com/authcode",
	};
}

interface MemoryGeminiStore extends GeminiCredentialStore {
	current: GeminiOAuthCredential | null;
}

function makeGeminiAuth(
	options: {
		login?: (options: GeminiLoginFlowOptions) => Promise<GeminiLoginResult>;
		complete?: (input: string) => Promise<GeminiOAuthCredential>;
		seed?: GeminiOAuthCredential | null;
	} = {},
) {
	const store: MemoryGeminiStore = {
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
	const logins: GeminiLoginFlowOptions[] = [];
	const completions: string[] = [];
	const completionStores: GeminiCredentialStore[] = [];
	const hooks: GeminiAuthHooks = {
		store: () => store,
		async login(loginOptions) {
			logins.push(loginOptions);
			return options.login ? options.login(loginOptions) : { kind: "signed-in", credential: credential() };
		},
		async complete(args) {
			completions.push(args.input);
			completionStores.push(args.store);
			return options.complete ? options.complete(args.input) : credential();
		},
	};
	return { hooks, store, logins, completions, completionStores };
}

interface MemoryClaudeStore extends ClaudeCredentialStore {
	current: ClaudeOAuthCredential | null;
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

/** The neighbouring subscription, to prove `/login gemini` does not touch it. */
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

function makeCtx(auth: { claudeAuth?: ClaudeAuthHooks; geminiAuth?: GeminiAuthHooks }) {
	const store = createStore<UiState>({ ...initialUiState(false) });
	const ctx = {
		getSession: () => null,
		handle: { store },
		claudeAuth: auth.claudeAuth,
		geminiAuth: auth.geminiAuth,
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

describe("/login gemini and /logout gemini", () => {
	test("/login gemini runs the Gemini flow, forwards its notes, and reports the account", async () => {
		const auth = makeGeminiAuth({
			login: async (options) => {
				options.note?.(
					"Open this URL to sign in to a Gemini subscription: https://accounts.google.com/o/oauth2/v2/auth?x=1",
				);
				return { kind: "signed-in", credential: credential() };
			},
		});
		const claude = makeClaudeAuth();
		const { ctx, info } = makeCtx({ claudeAuth: claude.hooks, geminiAuth: auth.hooks });
		handleAppCommand("/login gemini", ctx);
		await settle();
		expect(auth.logins.length).toBe(1);
		expect(auth.logins[0].store).toBe(auth.store);
		// The provider word routed the command; the Claude flow never ran.
		expect(claude.logins.length).toBe(0);
		const text = info().join("\n");
		expect(text).toContain("Open this URL to sign in to a Gemini subscription:");
		expect(text).toContain("Signed in to the Gemini subscription as user@example.com.");
	});

	test("a pending sign-in is parked, and a later /login gemini <code> completes it", async () => {
		const auth = makeGeminiAuth({
			login: async () => ({ kind: "pending", pending: pendingLogin() }),
		});
		const { ctx, info } = makeCtx({ geminiAuth: auth.hooks });
		handleAppCommand("/login gemini", ctx);
		await settle();
		expect(info().join("\n")).toContain("When the page shows the code, run: /login gemini <code>");

		handleAppCommand("/login gemini 4/abc#state", ctx);
		await settle();
		expect(auth.completions).toEqual(["4/abc#state"]);
		// The store the REPL handed the completer is the hook's own — the memory
		// hook does not write it, but production's completion does.
		expect(auth.completionStores[0]).toBe(auth.store);
		expect(info().join("\n")).toContain("Signed in to the Gemini subscription as user@example.com.");
	});

	test("a failed completion keeps the parked sign-in for another try", async () => {
		let calls = 0;
		const auth = makeGeminiAuth({
			login: async () => ({ kind: "pending", pending: pendingLogin() }),
			complete: async () => {
				calls += 1;
				if (calls === 1) throw new Error("invalid_grant");
				return credential();
			},
		});
		const { ctx, info } = makeCtx({ geminiAuth: auth.hooks });
		handleAppCommand("/login gemini", ctx);
		await settle();

		// The usual failure is a mis-paste; a fresh URL would invalidate the code
		// still on screen, so the pending login stays parked.
		handleAppCommand("/login gemini not-a-code", ctx);
		await settle();
		expect(info().join("\n")).toContain("The sign-in did not complete: invalid_grant");
		handleAppCommand("/login gemini 4/good#state", ctx);
		await settle();
		expect(auth.completions).toEqual(["not-a-code", "4/good#state"]);
		expect(info().join("\n")).toContain("Signed in to the Gemini subscription as user@example.com.");
	});

	test("a code with no sign-in waiting is refused", async () => {
		const auth = makeGeminiAuth();
		const { ctx, info } = makeCtx({ geminiAuth: auth.hooks });
		handleAppCommand("/login gemini 4/abc#state", ctx);
		await settle();
		expect(auth.completions.length).toBe(0);
		expect(info().join("\n")).toContain("No Gemini sign-in is waiting for a code.");
	});

	test("a failed sign-in is reported and does not leave the running flag stuck", async () => {
		let calls = 0;
		const auth = makeGeminiAuth({
			login: async () => {
				calls += 1;
				if (calls === 1) throw new Error("listen EADDRINUSE: address already in use");
				return { kind: "signed-in", credential: credential() };
			},
		});
		const { ctx, info } = makeCtx({ geminiAuth: auth.hooks });
		handleAppCommand("/login gemini", ctx);
		await settle();
		expect(info().join("\n")).toContain("The sign-in did not complete: listen EADDRINUSE");

		// The `finally` released the guard: a second attempt runs.
		handleAppCommand("/login gemini", ctx);
		await settle();
		expect(auth.logins.length).toBe(2);
		expect(info().join("\n")).toContain("Signed in to the Gemini subscription as user@example.com.");
	});

	test("a second /login gemini while one is running is refused", async () => {
		let release!: (result: GeminiLoginResult) => void;
		const gate = new Promise<GeminiLoginResult>((resolve) => {
			release = resolve;
		});
		const auth = makeGeminiAuth({ login: () => gate });
		const { ctx, info } = makeCtx({ geminiAuth: auth.hooks });
		handleAppCommand("/login gemini", ctx);
		await settle();
		handleAppCommand("/login gemini", ctx);
		await settle();
		expect(auth.logins.length).toBe(1);
		expect(info().join("\n")).toContain("A Gemini sign-in is already running.");

		// Release so the module state is clean for the next test.
		release({ kind: "signed-in", credential: credential() });
		await settle();
		expect(info().join("\n")).toContain("Signed in to the Gemini subscription as user@example.com.");
	});

	test("/logout gemini clears the Gemini credential, says so, and leaves the Claude one alone", async () => {
		// The husk's tokens are empty, so the best-effort revoke has nothing to
		// send: the REPL path offers no fetch injection, and a revoke of a fake
		// token would be a network call this suite must not make. The exchange
		// half is covered where the flow is, with an injected fetch.
		const auth = makeGeminiAuth({ seed: { ...credential(), accessToken: "", refreshToken: "" } });
		const claude = makeClaudeAuth(claudeCredential());
		const { ctx, info } = makeCtx({ claudeAuth: claude.hooks, geminiAuth: auth.hooks });
		expect(handleAppCommand("/logout gemini", ctx)).toBe(true);
		await settle();
		expect(auth.store.current).toBeNull();
		expect(info().join("\n")).toContain(
			"Signed out of the Gemini subscription. The next request to a Gemini model asks for a sign-in.",
		);
		// The other subscription's sign-in is a different credential entirely.
		expect(claude.store.current).not.toBeNull();
		expect(claude.logins.length).toBe(0);
	});

	test("/logout gemini with nothing stored says nothing was signed in", async () => {
		const auth = makeGeminiAuth();
		const { ctx, info } = makeCtx({ geminiAuth: auth.hooks });
		handleAppCommand("/logout gemini", ctx);
		await settle();
		expect(info().join("\n")).toContain("No Gemini subscription was signed in.");
	});
});
