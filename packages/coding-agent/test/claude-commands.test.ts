/**
 * `/login` and `/logout`, wired to the REPL.
 *
 * Everything behind the commands is injected: the store is a memory object,
 * the flow never opens a browser or a socket, and the token endpoint is never
 * reached. That is not only about speed — a `/logout` test that used the
 * default hooks would clear the real keychain entry of whoever runs the
 * tests, and it would pass exactly the same way it does here.
 *
 * `pendingClaudeLogin` is module state, so tests run in order and each one
 * leaves it empty; a test that seeds a pending sign-in ends by completing it
 * or by logging out.
 */
import { describe, expect, test } from "bun:test";
import type { ClaudeCredentialStore, ClaudeOAuthCredential } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import type {
	ClaudeAuthHooks,
	ClaudeLoginFlowOptions,
	ClaudeLoginResult,
	CompleteClaudeLoginArgs,
	PendingClaudeLogin,
} from "../src/claude-login.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

function credential(): ClaudeOAuthCredential {
	return {
		accessToken: "at-1",
		refreshToken: "rt-1",
		expiresAt: 1_000,
		refreshTokenExpiresAt: 2_000,
		scopes: ["user:inference"],
		clientId: "client-1",
		accountEmail: "user@example.com",
	};
}

function pending(): PendingClaudeLogin {
	return {
		authorizeUrl: "https://claude.com/cai/oauth/authorize?state=s-1",
		verifier: "v-1",
		state: "s-1",
		redirectUri: "https://platform.claude.com/oauth/code/callback",
	};
}

interface MemoryStore extends ClaudeCredentialStore {
	current: ClaudeOAuthCredential | null;
}

function makeAuth(
	options: {
		login?: (options: ClaudeLoginFlowOptions) => Promise<ClaudeLoginResult>;
		complete?: (args: CompleteClaudeLoginArgs) => Promise<ClaudeOAuthCredential>;
		seed?: ClaudeOAuthCredential | null;
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
	const logins: ClaudeLoginFlowOptions[] = [];
	const completes: CompleteClaudeLoginArgs[] = [];
	const hooks: ClaudeAuthHooks = {
		store: () => store,
		async login(loginOptions) {
			logins.push(loginOptions);
			return options.login ? options.login(loginOptions) : { kind: "signed-in", credential: credential() };
		},
		async complete(args) {
			completes.push(args);
			return options.complete ? options.complete(args) : credential();
		},
	};
	return { hooks, store, logins, completes };
}

function makeCtx(hooks: ClaudeAuthHooks) {
	const store = createStore<UiState>({ ...initialUiState(false) });
	const ctx = {
		getSession: () => null,
		handle: { store },
		claudeAuth: hooks,
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

describe("/login and /logout", () => {
	test("/logout clears the stored credential and says so", async () => {
		const auth = makeAuth({ seed: credential() });
		const { ctx, info } = makeCtx(auth.hooks);
		expect(handleAppCommand("/logout", ctx)).toBe(true);
		await settle();
		expect(auth.store.current).toBeNull();
		expect(info().join("\n")).toContain("Signed out of the Claude subscription.");
	});

	test("/logout with nothing stored says nothing was signed in", async () => {
		const auth = makeAuth();
		const { ctx, info } = makeCtx(auth.hooks);
		handleAppCommand("/logout", ctx);
		await settle();
		expect(info().join("\n")).toContain("No Claude subscription was signed in.");
	});

	test("/login runs the flow, forwards its notes, and reports the account", async () => {
		const auth = makeAuth({
			login: async (options) => {
				options.note?.("Open this URL to sign in: https://claude.com/cai/oauth/authorize?x=1");
				return { kind: "signed-in", credential: credential() };
			},
		});
		const { ctx, info } = makeCtx(auth.hooks);
		handleAppCommand("/login", ctx);
		await settle();
		expect(auth.logins.length).toBe(1);
		expect(auth.logins[0].store).toBe(auth.store);
		const text = info().join("\n");
		expect(text).toContain("Open this URL to sign in: https://claude.com/cai/oauth/authorize?x=1");
		expect(text).toContain("Signed in to the Claude subscription as user@example.com.");
	});

	test("the manual path: a pending login, then a paste that completes it", async () => {
		const auth = makeAuth({ login: async () => ({ kind: "pending", pending: pending() }) });
		const { ctx, info } = makeCtx(auth.hooks);
		handleAppCommand("/login", ctx);
		await settle();
		expect(info().join("\n")).toContain("When the page shows the code, run: /login <code#state>");

		handleAppCommand("/login abc#s-1", ctx);
		await settle();
		expect(auth.completes.length).toBe(1);
		expect(auth.completes[0].input).toBe("abc#s-1");
		expect(auth.completes[0].pending.state).toBe("s-1");
		expect(info().join("\n")).toContain("Signed in to the Claude subscription as user@example.com.");

		// The pending login is spent; a second paste has nothing to complete.
		handleAppCommand("/login def#s-1", ctx);
		await settle();
		expect(info().join("\n")).toContain("No sign-in is waiting for a code.");
	});

	test("a paste with no pending sign-in is answered, not exchanged", async () => {
		const auth = makeAuth();
		const { ctx, info } = makeCtx(auth.hooks);
		handleAppCommand("/login abc#s-1", ctx);
		await settle();
		expect(auth.completes.length).toBe(0);
		expect(info().join("\n")).toContain("No sign-in is waiting for a code.");
	});

	test("a failed sign-in is reported and does not leave the running flag stuck", async () => {
		let calls = 0;
		const auth = makeAuth({
			login: async () => {
				calls += 1;
				if (calls === 1) throw new Error("listen EADDRINUSE: address already in use");
				return { kind: "signed-in", credential: credential() };
			},
		});
		const { ctx, info } = makeCtx(auth.hooks);
		handleAppCommand("/login", ctx);
		await settle();
		expect(info().join("\n")).toContain("The sign-in did not complete: listen EADDRINUSE");

		// The `finally` released the guard: a second attempt runs.
		handleAppCommand("/login", ctx);
		await settle();
		expect(auth.logins.length).toBe(2);
		expect(info().join("\n")).toContain("Signed in to the Claude subscription as user@example.com.");
	});

	test("a second /login while one is running is refused", async () => {
		let release!: (result: ClaudeLoginResult) => void;
		const gate = new Promise<ClaudeLoginResult>((resolve) => {
			release = resolve;
		});
		const auth = makeAuth({ login: () => gate });
		const { ctx, info } = makeCtx(auth.hooks);
		handleAppCommand("/login", ctx);
		await settle();
		handleAppCommand("/login", ctx);
		await settle();
		expect(auth.logins.length).toBe(1);
		expect(info().join("\n")).toContain("A sign-in is already running.");

		// Release so the module state is clean for the next test.
		release({ kind: "signed-in", credential: credential() });
		await settle();
		expect(info().join("\n")).toContain("Signed in to the Claude subscription as user@example.com.");
	});

	test("a failed paste keeps the pending login for a retry", async () => {
		let exchangeCalls = 0;
		const auth = makeAuth({
			login: async () => ({ kind: "pending", pending: pending() }),
			complete: async () => {
				exchangeCalls += 1;
				if (exchangeCalls === 1) throw new Error("Token exchange failed (500)");
				return credential();
			},
		});
		const { ctx, info } = makeCtx(auth.hooks);
		handleAppCommand("/login", ctx);
		await settle();
		handleAppCommand("/login bad#s-1", ctx);
		await settle();
		expect(info().join("\n")).toContain("The sign-in did not complete: Token exchange failed (500)");

		// The same pending sign-in is still there; the retry succeeds.
		handleAppCommand("/login good#s-1", ctx);
		await settle();
		expect(auth.completes.length).toBe(2);
		expect(info().join("\n")).toContain("Signed in to the Claude subscription as user@example.com.");
	});
});
