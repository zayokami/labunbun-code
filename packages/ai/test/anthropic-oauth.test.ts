import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type ClaudeOAuthCredential,
	ClaudeOAuthError,
	type ClaudeTokenProvider,
	claudeAuthorizeUrl,
	claudeRefreshDue,
	createClaudeTokenProvider,
	createOAuthState,
	createPkce,
	exchangeClaudeCode,
	parseClaudeAuthorizationInput,
	refreshClaudeToken,
} from "../src/providers/anthropic-oauth.ts";

/** A clock the test moves by hand; the wire times all derive from it. */
function fixedClock(start = 1_000_000_000) {
	const now = start;
	return {
		now: () => now,
		get current() {
			return now;
		},
	};
}

interface FetchCall {
	url: string;
	init: RequestInit;
	body: Record<string, unknown>;
}

/** A fake fetch that records the request and answers with what the test says. */
function recordingFetch(respond: (call: FetchCall) => Response | Promise<Response> | never) {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const call: FetchCall = {
			url: String(input),
			init: init ?? {},
			body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
		};
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/** An in-memory credential store that keeps a ledger of what happened to it. */
function memoryStore(initial: ClaudeOAuthCredential | null = null) {
	let value = initial;
	const saves: ClaudeOAuthCredential[] = [];
	let clears = 0;
	return {
		store: {
			load: async () => value,
			save: async (credential: ClaudeOAuthCredential) => {
				value = credential;
				saves.push(credential);
			},
			clear: async () => {
				value = null;
				clears++;
			},
		},
		get value() {
			return value;
		},
		saves,
		get clears() {
			return clears;
		},
	};
}

function credential(overrides: Partial<ClaudeOAuthCredential> = {}): ClaudeOAuthCredential {
	return {
		accessToken: "sk-ant-oat-old",
		refreshToken: "sk-ant-ort-old",
		expiresAt: 2_000_000_000_000,
		refreshTokenExpiresAt: null,
		scopes: ["user:inference"],
		clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		...overrides,
	};
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
	return Response.json({
		access_token: "sk-ant-oat-new",
		refresh_token: "sk-ant-ort-new",
		expires_in: 3600,
		refresh_token_expires_in: 864000,
		scope: "user:inference user:profile",
		...overrides,
	});
}

/** The error a promise rejected with — and proof that it rejected at all. */
async function rejection(promise: Promise<unknown>): Promise<ClaudeOAuthError> {
	try {
		await promise;
	} catch (error) {
		return error as ClaudeOAuthError;
	}
	throw new Error("expected the promise to reject");
}

describe("createPkce", () => {
	test("the verifier is 32 random bytes as base64url, and the challenge is its digest", () => {
		const pkce = createPkce();
		// The challenge must be derivable from the verifier and nothing else —
		// that is the entire handshake — so the test recomputes it rather than
		// comparing to a stored string.
		expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
		// 32 bytes in base64url is 43 characters, padding stripped.
		expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(createPkce().verifier).not.toBe(pkce.verifier);
	});

	test("the state is its own 32 random bytes, not a slice of the verifier", () => {
		const state = createOAuthState();
		expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(createOAuthState()).not.toBe(state);
	});
});

describe("claudeAuthorizeUrl", () => {
	test("carries the console's parameters in the console's order", () => {
		const url = claudeAuthorizeUrl({
			redirectUri: "http://localhost:1455/callback",
			state: "STATE",
			codeChallenge: "CHALLENGE",
		});
		expect(url.startsWith("https://claude.com/cai/oauth/authorize?")).toBe(true);
		const parsed = new URL(url);
		// Order is pinned because it is the only part of the URL a host could
		// not tell us was wrong; everything else here has a named home.
		expect([...parsed.searchParams.keys()]).toEqual([
			"code",
			"client_id",
			"response_type",
			"redirect_uri",
			"scope",
			"code_challenge",
			"code_challenge_method",
			"state",
		]);
		expect(parsed.searchParams.get("code")).toBe("true");
		expect(parsed.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:1455/callback");
		expect(parsed.searchParams.get("scope")).toBe(
			"user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
		);
		expect(parsed.searchParams.get("code_challenge")).toBe("CHALLENGE");
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe("STATE");
		expect(parsed.searchParams.has("login_hint")).toBe(false);
	});

	test("a login hint is appended after the fixed ones, and a custom scope replaces the default", () => {
		const parsed = new URL(
			claudeAuthorizeUrl({
				redirectUri: "https://platform.claude.com/oauth/code/callback",
				state: "S",
				codeChallenge: "C",
				scopes: ["user:inference"],
				loginHint: "someone@example.com",
			}),
		);
		expect(parsed.searchParams.get("scope")).toBe("user:inference");
		expect(parsed.searchParams.get("login_hint")).toBe("someone@example.com");
		expect([...parsed.searchParams.keys()].at(-1)).toBe("login_hint");
	});
});

describe("parseClaudeAuthorizationInput", () => {
	test("splits code from state, and the code alone is still a code", () => {
		expect(parseClaudeAuthorizationInput("the-code#the-state")).toEqual({ code: "the-code", state: "the-state" });
		expect(parseClaudeAuthorizationInput("  the-code  ")).toEqual({ code: "the-code" });
		// The success page shows `code#state` and a paste can carry a stray tail;
		// the last segments are not part of the protocol and are dropped, the
		// same way Claude Code's own parser drops them.
		expect(parseClaudeAuthorizationInput("a#b#c")).toEqual({ code: "a", state: "b" });
	});

	test("an empty paste and a state-only paste are nothing", () => {
		expect(parseClaudeAuthorizationInput("")).toBeUndefined();
		expect(parseClaudeAuthorizationInput("   ")).toBeUndefined();
		expect(parseClaudeAuthorizationInput("#state")).toBeUndefined();
	});
});

describe("exchangeClaudeCode", () => {
	test("posts the code and the verifier as JSON to the token endpoint", async () => {
		const clock = fixedClock();
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		const tokens = await exchangeClaudeCode({
			code: "THE-CODE",
			state: "THE-STATE",
			codeVerifier: "THE-VERIFIER",
			redirectUri: "http://localhost:1455/callback",
			fetch,
			now: clock.current,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://platform.claude.com/v1/oauth/token");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
		expect(calls[0]?.body).toEqual({
			grant_type: "authorization_code",
			code: "THE-CODE",
			redirect_uri: "http://localhost:1455/callback",
			client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			code_verifier: "THE-VERIFIER",
			state: "THE-STATE",
		});
		expect(tokens.accessToken).toBe("sk-ant-oat-new");
		expect(tokens.refreshToken).toBe("sk-ant-ort-new");
		expect(tokens.expiresAt).toBe(clock.current + 3600_000);
		expect(tokens.refreshTokenExpiresAt).toBe(clock.current + 864000_000);
		expect(tokens.scopes).toEqual(["user:inference", "user:profile"]);
	});

	test("a state-less paste sends no state field", async () => {
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		await exchangeClaudeCode({
			code: "C",
			codeVerifier: "V",
			redirectUri: "https://platform.claude.com/oauth/code/callback",
			fetch,
		});
		expect("state" in (calls[0]?.body ?? {})).toBe(false);
	});

	test("the account e-mail rides along for the login message", async () => {
		const { fetch } = recordingFetch(() => tokenResponse({ account: { email_address: "someone@example.com" } }));
		const tokens = await exchangeClaudeCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch });
		expect(tokens.accountEmail).toBe("someone@example.com");
	});

	test("a refused code is an auth failure, and a dead server is not", async () => {
		const bad = recordingFetch(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
		const failure = exchangeClaudeCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: bad.fetch });
		await expect(failure).rejects.toThrow("Authentication failed: Invalid authorization code");
		await expect(
			exchangeClaudeCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: bad.fetch }).catch((e) => e),
		).resolves.toBeInstanceOf(ClaudeOAuthError);

		const down = recordingFetch(() => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
		await expect(
			exchangeClaudeCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: down.fetch }),
		).rejects.toThrow("Token exchange failed (500): Internal Server Error");
	});

	test("an answer without a token is refused rather than stored as one", async () => {
		const { fetch } = recordingFetch(() => tokenResponse({ access_token: undefined }));
		await expect(exchangeClaudeCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch })).rejects.toThrow(
			"without an access token",
		);
	});

	test("a timeout is named as one", async () => {
		const { fetch } = recordingFetch(() => {
			const error = new Error("The operation timed out");
			error.name = "TimeoutError";
			throw error;
		});
		await expect(exchangeClaudeCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch })).rejects.toThrow(
			"did not answer within 30s",
		);
	});
});

describe("refreshClaudeToken", () => {
	test("posts the refresh grant with the scopes the login was granted", async () => {
		const clock = fixedClock();
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		const tokens = await refreshClaudeToken({
			refreshToken: "sk-ant-ort-old",
			scopes: ["user:inference"],
			fetch,
			now: clock.current,
		});
		expect(calls[0]?.body).toEqual({
			grant_type: "refresh_token",
			refresh_token: "sk-ant-ort-old",
			client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			scope: "user:inference",
		});
		expect(tokens.accessToken).toBe("sk-ant-oat-new");
	});

	test("an answer that omits the refresh token keeps the old one — the server rotates at will", async () => {
		const clock = fixedClock();
		const { fetch } = recordingFetch(() =>
			tokenResponse({ refresh_token: undefined, refresh_token_expires_in: undefined, scope: undefined }),
		);
		const tokens = await refreshClaudeToken({
			refreshToken: "sk-ant-ort-old",
			scopes: ["user:inference"],
			fetch,
			now: clock.current,
		});
		expect(tokens.refreshToken).toBe("sk-ant-ort-old");
		expect(tokens.scopes).toEqual(["user:inference"]);
		// No stated lifetime falls back to the 30 days the issuer effectively
		// grants; storing null would read as "never expires", the one thing it
		// is not.
		expect(tokens.refreshTokenExpiresAt).toBe(clock.current + 2_592_000_000);
	});

	test("a dead grant is marked dead; a sick endpoint is not", async () => {
		const dead = recordingFetch(
			() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, statusText: "Bad Request" }),
		);
		const deadError = await rejection(refreshClaudeToken({ refreshToken: "R", fetch: dead.fetch }));
		expect(deadError).toBeInstanceOf(ClaudeOAuthError);
		expect(deadError.invalidGrant).toBe(true);
		expect(deadError.message).toContain("run /login again");

		const reused = recordingFetch(
			() =>
				new Response(JSON.stringify({ error: "invalid_request", error_description: "refresh_token_reused" }), {
					status: 400,
					statusText: "Bad Request",
				}),
		);
		expect(await refreshClaudeToken({ refreshToken: "R", fetch: reused.fetch }).catch((e) => e.invalidGrant)).toBe(
			true,
		);

		const sick = recordingFetch(() => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
		const sickError = await rejection(refreshClaudeToken({ refreshToken: "R", fetch: sick.fetch }));
		expect(sickError.message).toBe("Token refresh failed (500): Internal Server Error");
		expect(sickError.invalidGrant).toBe(false);
	});
});

describe("claudeRefreshDue", () => {
	test("the window opens five minutes before expiry, boundary included", () => {
		const now = 1_000_000_000_000;
		expect(claudeRefreshDue(null, now)).toBe(false);
		expect(claudeRefreshDue(now + 300_001, now)).toBe(false);
		expect(claudeRefreshDue(now + 300_000, now)).toBe(true);
		expect(claudeRefreshDue(now + 1, now)).toBe(true);
		expect(claudeRefreshDue(now - 1, now)).toBe(true);
		expect(claudeRefreshDue(now + 1_000, now, 2_000)).toBe(true);
	});
});

describe("createClaudeTokenProvider", () => {
	test("a fresh token is served without touching the network", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ expiresAt: clock.current + 3600_000 }));
		const { fetch } = recordingFetch(() => {
			throw new Error("the network must not be asked for a fresh token");
		});
		const provider = createClaudeTokenProvider(store.store, { fetch, now: clock.now });
		expect(await provider()).toEqual({ token: "sk-ant-oat-old", expiresAt: (clock.current + 3600_000) / 1000 });
	});

	test("a token inside the window refreshes and is saved", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ expiresAt: clock.current + 299_999 }));
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		const provider = createClaudeTokenProvider(store.store, { fetch, now: clock.now });
		expect(await provider()).toEqual({ token: "sk-ant-oat-new", expiresAt: (clock.current + 3600_000) / 1000 });
		expect(calls).toHaveLength(1);
		expect(store.saves).toHaveLength(1);
		expect(store.saves[0]?.refreshToken).toBe("sk-ant-ort-new");
	});

	test("a forced refresh ignores the freshness window — the caller knows something the clock does not", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ expiresAt: clock.current + 3600_000 }));
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		const provider = createClaudeTokenProvider(store.store, { fetch, now: clock.now });
		await provider({ forceRefresh: true });
		expect(calls).toHaveLength(1);
	});

	test("concurrent refreshes coalesce into one request", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ expiresAt: clock.current - 1 }));
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { fetch, calls } = recordingFetch(async () => {
			await gate;
			return tokenResponse();
		});
		const provider = createClaudeTokenProvider(store.store, { fetch, now: clock.now });
		// Both calls happen before the gate opens: the join is decided
		// synchronously, or two requests would race the rotation.
		const first = provider();
		const second = provider();
		release?.();
		const [a, b] = await Promise.all([first, second]);
		expect(calls).toHaveLength(1);
		expect(a).toEqual(b);
	});

	test("a forced refresh does not join a non-forced one — it would be handed the rejected token", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ expiresAt: clock.current - 1 }));
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { fetch, calls } = recordingFetch(async () => {
			await gate;
			return tokenResponse();
		});
		const provider = createClaudeTokenProvider(store.store, { fetch, now: clock.now });
		const soft = provider();
		const forced = provider({ forceRefresh: true });
		release?.();
		await Promise.all([soft, forced]);
		expect(calls).toHaveLength(2);
	});

	test("an empty store names the login", async () => {
		const store = memoryStore(null);
		const provider = createClaudeTokenProvider(store.store, { now: () => 0 });
		expect(await provider.available()).toBe(false);
		const error = await rejection(provider());
		expect(error.message).toContain("run /login");
		// Terminal, and marked so: the retry ladder reads this mark to fail fast
		// rather than keep the login message off the screen for two minutes.
		expect(error.invalidGrant).toBe(true);
	});

	test("an expired token with no refresh token empties the store and names the login", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ refreshToken: "", expiresAt: clock.current - 1 }));
		const provider = createClaudeTokenProvider(store.store, { now: clock.now });
		expect(await provider.available()).toBe(false);
		const error = await rejection(provider());
		expect(error.message).toContain("run /login again");
		expect(error.invalidGrant).toBe(true);
		expect(store.clears).toBe(1);
		expect(store.value).toBeNull();
	});

	test("a dead grant empties the store; a sick endpoint keeps it", async () => {
		const clock = fixedClock();
		const deadStore = memoryStore(credential({ expiresAt: clock.current - 1 }));
		const dead = recordingFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
		await expect(createClaudeTokenProvider(deadStore.store, { fetch: dead.fetch, now: clock.now })()).rejects.toThrow(
			"run /login again",
		);
		expect(deadStore.value).toBeNull();

		const sickStore = memoryStore(credential({ expiresAt: clock.current - 1 }));
		const sick = recordingFetch(() => new Response("boom", { status: 503, statusText: "Service Unavailable" }));
		await expect(createClaudeTokenProvider(sickStore.store, { fetch: sick.fetch, now: clock.now })()).rejects.toThrow(
			"Token refresh failed (503)",
		);
		// The user's login survives the endpoint having a bad day.
		expect(sickStore.value?.refreshToken).toBe("sk-ant-ort-old");
		expect(sickStore.clears).toBe(0);
	});

	test("availability tracks what the next request could actually do", async () => {
		const clock = fixedClock();
		const withRefresh = createClaudeTokenProvider(memoryStore(credential({ refreshToken: "R", expiresAt: 0 })).store, {
			now: clock.now,
		});
		expect(await withRefresh.available()).toBe(true);

		// Without a refresh token, availability is the access token's own clock:
		// true while past the refresh window, false the moment a refresh would be
		// wanted and none is possible.
		const freshOnly = createClaudeTokenProvider(
			memoryStore(credential({ refreshToken: "", expiresAt: clock.current + 600_000 })).store,
			{ now: clock.now },
		);
		expect(await freshOnly.available()).toBe(true);

		const dueOnly = createClaudeTokenProvider(
			memoryStore(credential({ refreshToken: "", expiresAt: clock.current + 60_000 })).store,
			{ now: clock.now },
		);
		expect(await dueOnly.available()).toBe(false);

		const husk = createClaudeTokenProvider(memoryStore(credential({ accessToken: "", refreshToken: "" })).store, {
			now: clock.now,
		});
		expect(await husk.available()).toBe(false);
	});

	test("the provider matches the SDK's AccessTokenProvider shape", () => {
		// Structural claim, checked structurally: the SDK calls the provider as a
		// plain function with an options bag and reads `.token`/`.expiresAt`.
		const provider: ClaudeTokenProvider = createClaudeTokenProvider(memoryStore(null).store);
		const callable: (opts?: { forceRefresh?: boolean }) => Promise<{ token: string; expiresAt: number | null }> =
			provider;
		expect(typeof callable).toBe("function");
		expect(typeof provider.available).toBe("function");
	});
});
