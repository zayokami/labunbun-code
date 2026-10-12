import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	CHATGPT_OAUTH_CLIENT_ID,
	type ChatGptOAuthCredential,
	ChatGptOAuthError,
	type ChatGptTokenProvider,
	chatGptAuthorizeUrl,
	chatGptJwtExpiresAt,
	chatGptRefreshDue,
	completeChatGptDeviceLogin,
	createChatGptOAuthState,
	createChatGptPkce,
	createChatGptTokenProvider,
	exchangeChatGptCode,
	parseChatGptIdToken,
	refreshChatGptToken,
	requestChatGptDeviceCode,
} from "../src/providers/chatgpt-oauth.ts";

/** A clock the test moves by hand; the wire times all derive from it. */
function fixedClock(start = 1_000_000_000_000) {
	const now = start;
	return {
		now: () => now,
		get current() {
			return now;
		},
	};
}

/** base64url of a JSON object, the way a JWT segment is written. */
function b64(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A JWT-shaped string; the signature may be anything non-empty. */
function jwt(payload: Record<string, unknown>): string {
	return `${b64({ alg: "none" })}.${b64(payload)}.signature`;
}

/** An ID token carrying the namespaced claims the account data lives under. */
function idToken(
	overrides: { email?: string; profileEmail?: string; accountId?: string; planType?: string; fedramp?: boolean } = {},
): string {
	const payload: Record<string, unknown> = {};
	if (overrides.email !== undefined) payload.email = overrides.email;
	if (overrides.profileEmail !== undefined)
		payload["https://api.openai.com/profile"] = { email: overrides.profileEmail };
	const auth: Record<string, unknown> = {};
	if (overrides.accountId !== undefined) auth.chatgpt_account_id = overrides.accountId;
	if (overrides.planType !== undefined) auth.chatgpt_plan_type = overrides.planType;
	if (overrides.fedramp !== undefined) auth.chatgpt_account_is_fedramp = overrides.fedramp;
	if (Object.keys(auth).length > 0) payload["https://api.openai.com/auth"] = auth;
	return jwt(payload);
}

interface FetchCall {
	url: string;
	init: RequestInit;
	/** The JSON body, when the request sent one. */
	body: Record<string, unknown>;
	/** The form fields in order, when the request sent form encoding. */
	form: Array<[string, string]> | null;
}

/** A fake fetch that records the request and answers with what the test says. */
function recordingFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const raw = init?.body ? String(init.body) : "";
		const contentType = ((init?.headers ?? {}) as Record<string, string>)["content-type"] ?? "";
		const call: FetchCall = {
			url: String(input),
			init: init ?? {},
			body: contentType.includes("json") && raw !== "" ? (JSON.parse(raw) as Record<string, unknown>) : {},
			form: contentType.includes("x-www-form-urlencoded") ? [...new URLSearchParams(raw).entries()] : null,
		};
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/** An in-memory credential store that keeps a ledger of what happened to it. */
function memoryStore(initial: ChatGptOAuthCredential | null = null) {
	let value = initial;
	const saves: ChatGptOAuthCredential[] = [];
	let clears = 0;
	return {
		store: {
			load: async () => value,
			save: async (credential: ChatGptOAuthCredential) => {
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

function credential(overrides: Partial<ChatGptOAuthCredential> = {}): ChatGptOAuthCredential {
	return {
		accessToken: jwt({ exp: 2_000_000_000 }),
		refreshToken: "rt-old",
		idToken: idToken({ accountId: "acct-1" }),
		accountId: "acct-1",
		expiresAt: 2_000_000_000_000,
		lastRefreshAt: 0,
		fedramp: false,
		...overrides,
	};
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
	return Response.json({
		id_token: idToken({ accountId: "acct-1", email: "someone@example.com", planType: "plus" }),
		access_token: jwt({ exp: 2_000_000_000 }),
		refresh_token: "rt-new",
		...overrides,
	});
}

/** The error a promise rejected with — and proof that it rejected at all. */
async function rejection(promise: Promise<unknown>): Promise<ChatGptOAuthError> {
	try {
		await promise;
	} catch (error) {
		return error as ChatGptOAuthError;
	}
	throw new Error("expected the promise to reject");
}

describe("createChatGptPkce", () => {
	test("the verifier is 64 random bytes as base64url, and the challenge is its digest", () => {
		const pkce = createChatGptPkce();
		// The challenge must be derivable from the verifier and nothing else —
		// that is the entire handshake — so the test recomputes it rather than
		// comparing to a stored string. 64 bytes in base64url is 86 characters.
		expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
		expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
		expect(createChatGptPkce().verifier).not.toBe(pkce.verifier);
	});

	test("the state is its own 32 random bytes", () => {
		const state = createChatGptOAuthState();
		expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(createChatGptOAuthState()).not.toBe(state);
	});
});

describe("chatGptAuthorizeUrl", () => {
	test("carries the reference client's parameters in its order, extras included", () => {
		const url = chatGptAuthorizeUrl({
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			state: "STATE",
			codeChallenge: "CHALLENGE",
		});
		expect(url.startsWith("https://auth.openai.com/oauth/authorize?")).toBe(true);
		const parsed = new URL(url);
		// Order is pinned because it is the only part of the URL a host could
		// not tell us was wrong; everything else here has a named home.
		expect([...parsed.searchParams.keys()]).toEqual([
			"response_type",
			"client_id",
			"redirect_uri",
			"code_challenge",
			"code_challenge_method",
			"state",
			"scope",
			"id_token_add_organizations",
			"codex_cli_simplified_flow",
			"originator",
		]);
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
		expect(parsed.searchParams.get("code_challenge")).toBe("CHALLENGE");
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("state")).toBe("STATE");
		expect(parsed.searchParams.get("scope")).toBe(
			"openid profile email offline_access api.connectors.read api.connectors.invoke",
		);
		expect(parsed.searchParams.get("id_token_add_organizations")).toBe("true");
		expect(parsed.searchParams.get("codex_cli_simplified_flow")).toBe("true");
		expect(parsed.searchParams.get("originator")).toBe("codex_cli_rs");
	});
});

describe("parseChatGptIdToken", () => {
	test("reads the namespaced claims, plan and fedramp included", () => {
		const claims = parseChatGptIdToken(
			idToken({ accountId: "acct-9", email: "someone@example.com", planType: "pro", fedramp: true }),
		);
		expect(claims).toEqual({
			accountId: "acct-9",
			accountEmail: "someone@example.com",
			planType: "pro",
			fedramp: true,
		});
	});

	test("the profile claim's e-mail is the fallback, and the top-level one wins", () => {
		expect(parseChatGptIdToken(idToken({ profileEmail: "profile@example.com" }))?.accountEmail).toBe(
			"profile@example.com",
		);
		expect(
			parseChatGptIdToken(idToken({ email: "top@example.com", profileEmail: "profile@example.com" }))?.accountEmail,
		).toBe("top@example.com");
	});

	test("an auth-less token is an account nobody described, not an error", () => {
		expect(parseChatGptIdToken(jwt({ email: "e@example.com" }))).toEqual({
			accountEmail: "e@example.com",
			fedramp: false,
		});
	});

	test("a token that is not a JWT at all is undefined", () => {
		expect(parseChatGptIdToken("not-a-jwt")).toBeUndefined();
		expect(parseChatGptIdToken("a..c")).toBeUndefined();
		expect(parseChatGptIdToken(`x.${Buffer.from("not json").toString("base64url")}.y`)).toBeUndefined();
	});
});

describe("chatGptJwtExpiresAt", () => {
	test("the exp claim in milliseconds, and nothing for anything else", () => {
		expect(chatGptJwtExpiresAt(jwt({ exp: 1234 }))).toBe(1_234_000);
		// A string exp is not a claim this reads; the 8-day fallback takes over.
		expect(chatGptJwtExpiresAt(jwt({ exp: "1234" }))).toBeNull();
		expect(chatGptJwtExpiresAt(jwt({}))).toBeNull();
		expect(chatGptJwtExpiresAt("nope")).toBeNull();
	});
});

describe("exchangeChatGptCode", () => {
	test("posts the code and the verifier as a form to the token endpoint", async () => {
		const clock = fixedClock();
		const access = jwt({ exp: 2_000_000_000 });
		const identity = idToken({ accountId: "acct-1", email: "someone@example.com", planType: "plus" });
		const { fetch, calls } = recordingFetch(() =>
			Response.json({ id_token: identity, access_token: access, refresh_token: "rt-new" }),
		);
		const tokens = await exchangeChatGptCode({
			code: "THE-CODE",
			codeVerifier: "THE-VERIFIER",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			fetch,
			now: clock.current,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/token");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
		expect(calls[0]?.form).toEqual([
			["grant_type", "authorization_code"],
			["client_id", "app_EMoamEEZ73f0CkXaXp7hrann"],
			["code", "THE-CODE"],
			["redirect_uri", "http://127.0.0.1:1455/auth/callback"],
			["code_verifier", "THE-VERIFIER"],
		]);
		expect(tokens.accessToken).toBe(access);
		expect(tokens.refreshToken).toBe("rt-new");
		expect(tokens.idToken).toBe(identity);
		expect(tokens.accountId).toBe("acct-1");
		// No expires_in on this wire: the lifetime comes from the JWT itself.
		expect(tokens.expiresAt).toBe(2_000_000_000_000);
		expect(tokens.lastRefreshAt).toBe(clock.current);
		expect(tokens.accountEmail).toBe("someone@example.com");
		expect(tokens.planType).toBe("plus");
		expect(tokens.fedramp).toBe(false);
	});

	test("a refused code is an auth failure, and a dead server is not", async () => {
		const bad = recordingFetch(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
		const failure = await rejection(
			exchangeChatGptCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: bad.fetch }),
		);
		expect(failure).toBeInstanceOf(ChatGptOAuthError);
		expect(failure.message).toBe("Authentication failed: Invalid authorization code");
		expect(failure.invalidGrant).toBe(true);

		const down = recordingFetch(() => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
		const downError = await rejection(
			exchangeChatGptCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: down.fetch }),
		);
		expect(downError.message).toBe("Token exchange failed (500): Internal Server Error");
		expect(downError.invalidGrant).toBe(false);
	});

	test("a grant missing its tokens or its readable ID token is refused rather than stored", async () => {
		const noAccess = recordingFetch(() => tokenResponse({ access_token: undefined }));
		await expect(
			exchangeChatGptCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: noAccess.fetch }),
		).rejects.toThrow("without an access token");
		const noRefresh = recordingFetch(() => tokenResponse({ refresh_token: undefined }));
		await expect(
			exchangeChatGptCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: noRefresh.fetch }),
		).rejects.toThrow("without a refresh token");
		const noId = recordingFetch(() => tokenResponse({ id_token: undefined }));
		await expect(
			exchangeChatGptCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: noId.fetch }),
		).rejects.toThrow("without an ID token");
		const garbled = recordingFetch(() => tokenResponse({ id_token: "not-a-jwt" }));
		await expect(
			exchangeChatGptCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch: garbled.fetch }),
		).rejects.toThrow("unreadable ID token");
	});

	test("a timeout is named as one", async () => {
		const { fetch } = recordingFetch(() => {
			const error = new Error("The operation timed out");
			error.name = "TimeoutError";
			throw error;
		});
		await expect(exchangeChatGptCode({ code: "C", codeVerifier: "V", redirectUri: "R", fetch })).rejects.toThrow(
			"did not answer within 30s",
		);
	});

	test("a cancelled sign-in surfaces its own abort, not a timeout", async () => {
		const abort = new Error("The operation was aborted");
		abort.name = "AbortError";
		const { fetch } = recordingFetch(() => {
			throw abort;
		});
		const error = await exchangeChatGptCode({
			code: "C",
			codeVerifier: "V",
			redirectUri: "R",
			fetch,
			signal: AbortSignal.abort(),
		}).catch((e) => e);
		expect(error).toBe(abort);
		expect(error).not.toBeInstanceOf(ChatGptOAuthError);
	});
});

describe("refreshChatGptToken", () => {
	test("posts the refresh grant as JSON — the same endpoint's other encoding", async () => {
		const clock = fixedClock();
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		const tokens = await refreshChatGptToken({ refreshToken: "rt-old", fetch, now: clock.current });
		expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/token");
		expect(calls[0]?.init.headers).toEqual({ "content-type": "application/json" });
		expect(calls[0]?.body).toEqual({
			client_id: CHATGPT_OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: "rt-old",
		});
		expect(tokens.accessToken).toBe(jwt({ exp: 2_000_000_000 }));
		expect(tokens.expiresAt).toBe(2_000_000_000_000);
		expect(tokens.lastRefreshAt).toBe(clock.current);
	});

	test("an answer that omits fields keeps the previous values — the server rotates at will", async () => {
		const clock = fixedClock();
		const previous = credential({
			// The retained ID token is what speaks for the account; the fixture
			// keeps it coherent so the kept values are the token's own claims.
			idToken: idToken({ accountId: "acct-1", fedramp: true }),
			accountEmail: "old@example.com",
			planType: "pro",
			fedramp: true,
		});
		const { fetch } = recordingFetch(() => Response.json({ access_token: jwt({ exp: 2_000_100_000 }) }));
		const tokens = await refreshChatGptToken({ refreshToken: "rt-old", previous, fetch, now: clock.current });
		expect(tokens.refreshToken).toBe("rt-old");
		expect(tokens.idToken).toBe(previous.idToken);
		expect(tokens.accountId).toBe("acct-1");
		expect(tokens.accountEmail).toBe("old@example.com");
		expect(tokens.planType).toBe("pro");
		expect(tokens.fedramp).toBe(true);
		expect(tokens.expiresAt).toBe(2_000_100_000_000);
	});

	test("a rotated ID token replaces the account data it carries", async () => {
		const rotated = idToken({ accountId: "acct-2", email: "new@example.com", planType: "pro" });
		const { fetch } = recordingFetch(() =>
			Response.json({ access_token: jwt({ exp: 2_000_100_000 }), id_token: rotated }),
		);
		const tokens = await refreshChatGptToken({ refreshToken: "rt-old", previous: credential(), fetch });
		expect(tokens.idToken).toBe(rotated);
		expect(tokens.accountId).toBe("acct-2");
		expect(tokens.accountEmail).toBe("new@example.com");
	});

	test("an answer without an access token is refused, not served stale", async () => {
		const { fetch } = recordingFetch(() => Response.json({ refresh_token: "rt-new" }));
		await expect(refreshChatGptToken({ refreshToken: "rt-old", fetch })).rejects.toThrow(
			"Token refresh answered without an access token",
		);
	});

	test("a dead grant is marked dead; a sick endpoint is not", async () => {
		const dead = recordingFetch(() => new Response("nope", { status: 401, statusText: "Unauthorized" }));
		const deadError = await rejection(refreshChatGptToken({ refreshToken: "R", fetch: dead.fetch }));
		expect(deadError.invalidGrant).toBe(true);
		expect(deadError.message).toContain("sign in again");

		const invalidGrant = recordingFetch(
			() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, statusText: "Bad Request" }),
		);
		expect(
			await refreshChatGptToken({ refreshToken: "R", fetch: invalidGrant.fetch }).catch((e) => e.invalidGrant),
		).toBe(true);

		// The server's own word for a rotated grant; also a dead one.
		const reused = recordingFetch(
			() => new Response(JSON.stringify({ code: "refresh_token_reused" }), { status: 400, statusText: "Bad Request" }),
		);
		expect(await refreshChatGptToken({ refreshToken: "R", fetch: reused.fetch }).catch((e) => e.invalidGrant)).toBe(
			true,
		);

		// A 400 that says nothing about the grant is the endpoint's bad day, not
		// the session's death.
		const unclear = recordingFetch(
			() => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400, statusText: "Bad Request" }),
		);
		expect(await refreshChatGptToken({ refreshToken: "R", fetch: unclear.fetch }).catch((e) => e.invalidGrant)).toBe(
			false,
		);

		const sick = recordingFetch(() => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
		const sickError = await rejection(refreshChatGptToken({ refreshToken: "R", fetch: sick.fetch }));
		expect(sickError.message).toBe("Token refresh failed (500): Internal Server Error");
		expect(sickError.invalidGrant).toBe(false);
	});
});

describe("chatGptRefreshDue", () => {
	test("the stored expiry opens the window five minutes before it, boundary included", () => {
		const now = 1_000_000_000_000;
		expect(chatGptRefreshDue(credential({ expiresAt: now + 300_001 }), now)).toBe(false);
		expect(chatGptRefreshDue(credential({ expiresAt: now + 300_000 }), now)).toBe(true);
		expect(chatGptRefreshDue(credential({ expiresAt: now - 1 }), now)).toBe(true);
	});

	test("with no readable exp, the 8-day age of the last grant is the clock", () => {
		const now = 1_000_000_000_000;
		const timedOut = { accessToken: jwt({}), expiresAt: null };
		expect(chatGptRefreshDue(credential({ ...timedOut, lastRefreshAt: now }), now)).toBe(false);
		// Exactly 8 days old is not yet due — the reference client's rule is "older than".
		expect(chatGptRefreshDue(credential({ ...timedOut, lastRefreshAt: now - 691_200_000 }), now)).toBe(false);
		expect(chatGptRefreshDue(credential({ ...timedOut, lastRefreshAt: now - 691_200_001 }), now)).toBe(true);
	});
});

describe("createChatGptTokenProvider", () => {
	test("a fresh token is served without touching the network, account data included", async () => {
		const clock = fixedClock();
		const stored = credential({ expiresAt: clock.current + 3_600_000, fedramp: true });
		const store = memoryStore(stored);
		const { fetch } = recordingFetch(() => {
			throw new Error("the network must not be asked for a fresh token");
		});
		const provider = createChatGptTokenProvider(store.store, { fetch, now: clock.now });
		expect(await provider()).toEqual({
			token: stored.accessToken,
			expiresAt: clock.current + 3_600_000,
			accountId: "acct-1",
			fedramp: true,
		});
	});

	test("a token inside the window refreshes and is saved", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ expiresAt: clock.current + 299_999 }));
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		const provider = createChatGptTokenProvider(store.store, { fetch, now: clock.now });
		expect(await provider()).toEqual({
			token: jwt({ exp: 2_000_000_000 }),
			expiresAt: 2_000_000_000_000,
			accountId: "acct-1",
			fedramp: false,
		});
		expect(calls).toHaveLength(1);
		expect(store.saves).toHaveLength(1);
		expect(store.saves[0]?.refreshToken).toBe("rt-new");
	});

	test("a forced refresh ignores the freshness window — the caller knows something the clock does not", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ expiresAt: clock.current + 3_600_000 }));
		const { fetch, calls } = recordingFetch(() => tokenResponse());
		const provider = createChatGptTokenProvider(store.store, { fetch, now: clock.now });
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
		const provider = createChatGptTokenProvider(store.store, { fetch, now: clock.now });
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
		const provider = createChatGptTokenProvider(store.store, { fetch, now: clock.now });
		const soft = provider();
		const forced = provider({ forceRefresh: true });
		release?.();
		await Promise.all([soft, forced]);
		expect(calls).toHaveLength(2);
	});

	test("an empty store names the sign-in", async () => {
		const store = memoryStore(null);
		const provider = createChatGptTokenProvider(store.store, { now: () => 0 });
		expect(await provider.available()).toBe(false);
		const error = await rejection(provider());
		expect(error.message).toContain("Not signed in");
		expect(error.invalidGrant).toBe(true);
	});

	test("an expired token with no refresh token empties the store and names the sign-in", async () => {
		const clock = fixedClock();
		const store = memoryStore(credential({ refreshToken: "", expiresAt: clock.current - 1 }));
		const provider = createChatGptTokenProvider(store.store, { now: clock.now });
		expect(await provider.available()).toBe(false);
		const error = await rejection(provider());
		expect(error.message).toContain("cannot refresh: sign in again");
		expect(error.invalidGrant).toBe(true);
		expect(store.clears).toBe(1);
		expect(store.value).toBeNull();
	});

	test("a dead grant empties the store; a sick endpoint keeps it", async () => {
		const clock = fixedClock();
		const deadStore = memoryStore(credential({ expiresAt: clock.current - 1 }));
		const dead = recordingFetch(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
		await expect(createChatGptTokenProvider(deadStore.store, { fetch: dead.fetch, now: clock.now })()).rejects.toThrow(
			"sign in again",
		);
		expect(deadStore.value).toBeNull();

		const sickStore = memoryStore(credential({ expiresAt: clock.current - 1 }));
		const sick = recordingFetch(() => new Response("boom", { status: 503, statusText: "Service Unavailable" }));
		await expect(createChatGptTokenProvider(sickStore.store, { fetch: sick.fetch, now: clock.now })()).rejects.toThrow(
			"Token refresh failed (503)",
		);
		// The user's login survives the endpoint having a bad day.
		expect(sickStore.value?.refreshToken).toBe("rt-old");
		expect(sickStore.clears).toBe(0);
	});

	test("availability tracks what the next request could actually do", async () => {
		const clock = fixedClock();
		const withRefresh = createChatGptTokenProvider(memoryStore(credential({ refreshToken: "R", expiresAt: 0 })).store, {
			now: clock.now,
		});
		expect(await withRefresh.available()).toBe(true);

		// Without a refresh token, availability is the access token's own clock:
		// true while past the refresh window, false the moment a refresh would be
		// wanted and none is possible.
		const freshOnly = createChatGptTokenProvider(
			memoryStore(credential({ refreshToken: "", expiresAt: clock.current + 600_000 })).store,
			{ now: clock.now },
		);
		expect(await freshOnly.available()).toBe(true);

		const dueOnly = createChatGptTokenProvider(
			memoryStore(credential({ refreshToken: "", expiresAt: clock.current + 60_000 })).store,
			{ now: clock.now },
		);
		expect(await dueOnly.available()).toBe(false);

		const husk = createChatGptTokenProvider(memoryStore(credential({ accessToken: "", refreshToken: "" })).store, {
			now: clock.now,
		});
		expect(await husk.available()).toBe(false);
	});

	test("the provider matches the streaming adapter's contract shape", () => {
		// Structural claim, checked structurally: the adapter calls the provider
		// as a plain function with an options bag and reads the grant fields.
		const provider: ChatGptTokenProvider = createChatGptTokenProvider(memoryStore(null).store);
		const callable: (opts?: { forceRefresh?: boolean }) => Promise<{
			token: string;
			expiresAt: number | null;
			accountId: string | null;
			fedramp: boolean;
		}> = provider;
		expect(typeof callable).toBe("function");
		expect(typeof provider.available).toBe("function");
	});
});

describe("requestChatGptDeviceCode", () => {
	test("asks for a code and reports where the user types it", async () => {
		const { fetch, calls } = recordingFetch(() =>
			Response.json({ device_auth_id: "dev-1", user_code: "AB-12", interval: "3" }),
		);
		const code = await requestChatGptDeviceCode({ fetch });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.body).toEqual({ client_id: CHATGPT_OAUTH_CLIENT_ID });
		expect(code).toEqual({
			deviceAuthId: "dev-1",
			userCode: "AB-12",
			verificationUrl: "https://auth.openai.com/codex/device",
			intervalMs: 3000,
		});
	});

	test("the older field spelling works, and a missing interval gets a sane default", async () => {
		const { fetch } = recordingFetch(() => Response.json({ device_auth_id: "dev-2", usercode: "CD-34" }));
		const code = await requestChatGptDeviceCode({ fetch });
		expect(code.userCode).toBe("CD-34");
		expect(code.intervalMs).toBe(5000);
	});

	test("a server without device sign-in says so, and other failures name their status", async () => {
		const missing = recordingFetch(() => new Response("", { status: 404, statusText: "Not Found" }));
		await expect(requestChatGptDeviceCode({ fetch: missing.fetch })).rejects.toThrow(
			"not enabled for this server; use the browser sign-in",
		);

		const broken = recordingFetch(() => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
		await expect(requestChatGptDeviceCode({ fetch: broken.fetch })).rejects.toThrow("Device sign-in failed (500)");
	});

	test("an answer without a code is refused", async () => {
		const { fetch } = recordingFetch(() => Response.json({ device_auth_id: "dev-3" }));
		await expect(requestChatGptDeviceCode({ fetch })).rejects.toThrow("without a code");
	});
});

describe("completeChatGptDeviceLogin", () => {
	test("waits out pending polls, then completes the standard exchange with the server's own PKCE", async () => {
		let polls = 0;
		const access = jwt({ exp: 2_000_000_000 });
		const { fetch, calls } = recordingFetch((call) => {
			if (call.url.endsWith("/deviceauth/token")) {
				polls++;
				if (polls < 3) return new Response("", { status: 403, statusText: "Forbidden" });
				return Response.json({
					authorization_code: "THE-CODE",
					code_challenge: "THE-CHALLENGE",
					code_verifier: "THE-VERIFIER",
				});
			}
			return Response.json({
				id_token: idToken({ accountId: "acct-1" }),
				access_token: access,
				refresh_token: "rt-new",
			});
		});
		const tokens = await completeChatGptDeviceLogin({
			deviceAuthId: "dev-1",
			userCode: "AB-12",
			intervalMs: 1,
			fetch,
		});
		expect(calls.map((call) => call.url)).toEqual([
			"https://auth.openai.com/api/accounts/deviceauth/token",
			"https://auth.openai.com/api/accounts/deviceauth/token",
			"https://auth.openai.com/api/accounts/deviceauth/token",
			"https://auth.openai.com/oauth/token",
		]);
		expect(calls[0]?.body).toEqual({ device_auth_id: "dev-1", user_code: "AB-12" });
		// The device grant's redirect is the issuer's own callback, and the
		// verifier is the one the server minted — not one this client made.
		expect(calls[3]?.form).toEqual([
			["grant_type", "authorization_code"],
			["client_id", "app_EMoamEEZ73f0CkXaXp7hrann"],
			["code", "THE-CODE"],
			["redirect_uri", "https://auth.openai.com/deviceauth/callback"],
			["code_verifier", "THE-VERIFIER"],
		]);
		expect(tokens.accessToken).toBe(access);
		expect(tokens.refreshToken).toBe("rt-new");
		expect(tokens.accountId).toBe("acct-1");
	});

	test("gives up when the user never approves", async () => {
		const { fetch } = recordingFetch(() => new Response("", { status: 403, statusText: "Forbidden" }));
		await expect(
			completeChatGptDeviceLogin({ deviceAuthId: "d", userCode: "u", intervalMs: 5, timeoutMs: 40, fetch }),
		).rejects.toThrow("Device sign-in timed out");
	});

	test("a poll that fails for another reason stops at once", async () => {
		const { fetch, calls } = recordingFetch(
			() => new Response("boom", { status: 500, statusText: "Internal Server Error" }),
		);
		await expect(
			completeChatGptDeviceLogin({ deviceAuthId: "d", userCode: "u", intervalMs: 1, fetch }),
		).rejects.toThrow("Device sign-in failed (500)");
		expect(calls).toHaveLength(1);
	});

	test("an approval without the full grant is refused", async () => {
		const { fetch } = recordingFetch(() => Response.json({ authorization_code: "C", code_challenge: "CH" }));
		await expect(
			completeChatGptDeviceLogin({ deviceAuthId: "d", userCode: "u", intervalMs: 1, fetch }),
		).rejects.toThrow("without a completed grant");
	});
});
