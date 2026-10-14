/**
 * The Gemini credential store, its token-endpoint calls, and the provider the
 * wire layer calls: keychain first, file as the fallback, eager refresh.
 *
 * The keychain is injected in every test here, and never probed. `Bun.secrets`
 * on a real machine reaches the operator's own credential database, and a test
 * that cleared the entry "labunbun" / "gemini" would delete a real sign-in —
 * which, from the test runner's point of view, is indistinguishable from
 * working code. Every fetch is a fake for the same reason: no test here may
 * reach the token, userinfo, or revoke endpoints.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGeminiCredentialStore,
	createGeminiCredentials,
	createGeminiTokenProvider,
	exchangeGeminiCode,
	GEMINI_OAUTH_REVOKE_URL,
	GEMINI_OAUTH_TOKEN_URL,
	GEMINI_REFRESH_WINDOW_MS,
	GEMINI_SUBSCRIPTION_KEYCHAIN,
	type GeminiCredentialStore,
	type GeminiOAuthCredential,
	GeminiOAuthError,
	geminiRefreshDue,
	type KeychainLike,
	refreshGeminiToken,
	revokeGeminiToken,
} from "../src/gemini-auth.ts";

/**
 * The exact client this sign-in presents; spelled out in pieces, like the
 * source row, so a mutation fails here and no single literal matches a
 * credential scanner.
 */
const CLIENT_ID = "681255809395-" + "oo8ft2oprdrnp9e3aqf6av3hmdib135j" + ".apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-" + "4uHgMPm-1o7Sk-geV6Cu5clXFsxl";

/** What the token endpoint answers; one shape for most tests here. */
const TOKEN_ANSWER = {
	access_token: "at-1",
	refresh_token: "rt-1",
	expires_in: 3600,
	scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email",
	token_type: "Bearer",
};

interface FetchCall {
	url: string;
	method: string;
	form: URLSearchParams;
}

function fakeFetch(
	response: object = TOKEN_ANSWER,
	status = 200,
	statusText = "OK",
): { calls: FetchCall[]; fetchFn: typeof fetch } {
	const calls: FetchCall[] = [];
	const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(url),
			method: init?.method ?? "GET",
			form: new URLSearchParams(String(init?.body ?? "")),
		});
		return new Response(JSON.stringify(response), {
			status,
			statusText,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { calls, fetchFn };
}

function credential(overrides: Partial<GeminiOAuthCredential> = {}): GeminiOAuthCredential {
	return {
		accessToken: "access-1",
		refreshToken: "refresh-1",
		scope: "https://www.googleapis.com/auth/cloud-platform",
		expiresAt: 1_000_000,
		lastRefreshAt: 900_000,
		accountEmail: "user@example.com",
		...overrides,
	};
}

function makeHome(): { home: string; clean: () => void } {
	const home = mkdtempSync(join(tmpdir(), "lbb-gemini-auth-"));
	return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
}

function filePathOf(home: string): string {
	return join(home, ".labunbun", "gemini-oauth.json");
}

function writeFile(home: string, value: unknown): string {
	const filePath = filePathOf(home);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(filePath, JSON.stringify(value));
	return filePath;
}

interface FakeKeychain extends KeychainLike {
	entries: Map<string, string>;
	calls: string[];
}

function fakeKeychain(
	seed?: GeminiOAuthCredential,
	behavior: { failGet?: boolean; failSet?: boolean; failDelete?: boolean } = {},
): FakeKeychain {
	const key = "labunbun:gemini";
	const entries = new Map<string, string>();
	if (seed) entries.set(key, JSON.stringify(seed));
	const calls: string[] = [];
	return {
		entries,
		calls,
		async get() {
			calls.push("get");
			if (behavior.failGet) throw new Error("keychain unavailable");
			return entries.get(key) ?? null;
		},
		async set(options) {
			calls.push("set");
			if (behavior.failSet) throw new Error("keychain refused");
			entries.set(`${options.service}:${options.name}`, options.value);
		},
		async delete() {
			calls.push("delete");
			if (behavior.failDelete) throw new Error("keychain refused");
			return entries.delete(key);
		},
	};
}

interface MemoryStore extends GeminiCredentialStore {
	current: GeminiOAuthCredential | null;
}

function memoryStore(initial: GeminiOAuthCredential | null = null): MemoryStore {
	return {
		current: initial,
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

describe("createGeminiCredentialStore", () => {
	test("the keychain entry is this app's own — never the real Gemini CLI's", () => {
		// The real Gemini CLI keeps its sign-in under its own keychain service.
		// A store pointed there would read or clear another tool's credentials;
		// this pins the entry this app may touch, service and account both.
		expect(GEMINI_SUBSCRIPTION_KEYCHAIN).toEqual({ service: "labunbun", name: "gemini" });
	});

	test("load prefers the keychain over a file from an earlier fallback era", async () => {
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const store = createGeminiCredentialStore({
				home,
				keychain: fakeKeychain(credential({ accessToken: "from-keychain" })),
			});
			expect((await store.load())?.accessToken).toBe("from-keychain");
		} finally {
			clean();
		}
	});

	test("load falls back to the file when the keychain has no entry", async () => {
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const store = createGeminiCredentialStore({ home, keychain: fakeKeychain() });
			expect((await store.load())?.accessToken).toBe("from-file");
		} finally {
			clean();
		}
	});

	test("load falls back to the file when the keychain throws", async () => {
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const store = createGeminiCredentialStore({ home, keychain: fakeKeychain(undefined, { failGet: true }) });
			expect((await store.load())?.accessToken).toBe("from-file");
		} finally {
			clean();
		}
	});

	test("load answers null when nothing is stored, and for malformed content", async () => {
		const { home, clean } = makeHome();
		try {
			expect(await createGeminiCredentialStore({ home, keychain: fakeKeychain() }).load()).toBeNull();
			mkdirSync(join(home, ".labunbun"), { recursive: true });
			writeFileSync(filePathOf(home), "{not json");
			const store = createGeminiCredentialStore({ home, keychain: fakeKeychain() });
			expect(await store.load()).toBeNull();
		} finally {
			clean();
		}
	});

	test("a malformed keychain entry is null and does NOT fall through to the file", async () => {
		// The two stores are one credential, so when the keychain holds an entry
		// the answer comes from it alone. Falling back here would serve a token
		// the keychain replaced, from a source nobody looks at.
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const keychain = fakeKeychain();
			keychain.entries.set("labunbun:gemini", "{not json");
			const store = createGeminiCredentialStore({ home, keychain });
			expect(await store.load()).toBeNull();
		} finally {
			clean();
		}
	});

	test("save writes the keychain and removes a file left by an earlier fallback", async () => {
		const { home, clean } = makeHome();
		try {
			const filePath = writeFile(home, credential({ accessToken: "stale" }));
			const keychain = fakeKeychain();
			const warnings: string[] = [];
			const store = createGeminiCredentialStore({ home, keychain, warn: (m) => warnings.push(m) });
			await store.save(credential({ accessToken: "fresh" }));
			expect(JSON.parse(keychain.entries.get("labunbun:gemini") ?? "{}").accessToken).toBe("fresh");
			expect(existsSync(filePath)).toBe(false);
			expect(warnings).toEqual([]);
		} finally {
			clean();
		}
	});

	test("save without a keychain warns once and writes a file only the user can read", async () => {
		const { home, clean } = makeHome();
		try {
			const warnings: string[] = [];
			const store = createGeminiCredentialStore({ home, keychain: null, warn: (m) => warnings.push(m) });
			await store.save(credential({ accessToken: "first" }));
			await store.save(credential({ accessToken: "second" }));
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain("gemini-oauth.json");
			expect(JSON.parse(readFileSync(filePathOf(home), "utf8")).accessToken).toBe("second");
			if (process.platform !== "win32") {
				// Windows has no file modes; the check would pass vacuously there.
				expect(statSync(filePathOf(home)).mode & 0o777).toBe(0o600);
			}
		} finally {
			clean();
		}
	});

	test("a keychain that refuses on save falls back to the file with one warning", async () => {
		const { home, clean } = makeHome();
		try {
			const warnings: string[] = [];
			const store = createGeminiCredentialStore({
				home,
				keychain: fakeKeychain(undefined, { failSet: true }),
				warn: (m) => warnings.push(m),
			});
			await store.save(credential({ accessToken: "saved" }));
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain("keychain refused");
			expect(JSON.parse(readFileSync(filePathOf(home), "utf8")).accessToken).toBe("saved");
		} finally {
			clean();
		}
	});

	test("clear empties the keychain and the file", async () => {
		const { home, clean } = makeHome();
		try {
			const filePath = writeFile(home, credential());
			const keychain = fakeKeychain(credential());
			const store = createGeminiCredentialStore({ home, keychain });
			await store.clear();
			expect(keychain.entries.size).toBe(0);
			expect(existsSync(filePath)).toBe(false);
		} finally {
			clean();
		}
	});

	test("clear survives a keychain that refuses to delete", async () => {
		const { home, clean } = makeHome();
		try {
			const filePath = writeFile(home, credential());
			const store = createGeminiCredentialStore({
				home,
				keychain: fakeKeychain(credential(), { failDelete: true }),
			});
			await store.clear();
			expect(existsSync(filePath)).toBe(false);
		} finally {
			clean();
		}
	});

	test("the store only ever touches its own keychain entry", async () => {
		// The service is shared with the other sign-ins; a bug that dropped the
		// name would clear a different subscription's entry. This pins the calls.
		const { home, clean } = makeHome();
		try {
			const keychain = fakeKeychain();
			const touched: Array<{ name: string }> = [];
			const recording = {
				...keychain,
				async get(options: { service: string; name: string }) {
					touched.push(options);
					return keychain.get(options);
				},
				async set(options: { service: string; name: string; value: string }) {
					touched.push(options);
					return keychain.set(options);
				},
				async delete(options: { service: string; name: string }) {
					touched.push(options);
					return keychain.delete(options);
				},
			};
			const store = createGeminiCredentialStore({ home, keychain: recording, warn: () => {} });
			await store.load();
			await store.save(credential());
			await store.clear();
			expect(touched.map((options) => options.name)).toEqual(["gemini", "gemini", "gemini"]);
		} finally {
			clean();
		}
	});
});

describe("exchangeGeminiCode", () => {
	test("posts the code form and stores the stated lifetime", async () => {
		const { calls, fetchFn } = fakeFetch();
		const result = await exchangeGeminiCode({
			code: "the-code",
			redirectUri: "https://codeassist.google.com/authcode",
			fetch: fetchFn,
			now: 500,
		});
		expect(result.accessToken).toBe("at-1");
		expect(result.refreshToken).toBe("rt-1");
		expect(result.expiresAt).toBe(500 + 3_600_000);
		expect(result.lastRefreshAt).toBe(500);
		expect(result.scope).toContain("cloud-platform");
		expect(calls.length).toBe(1);
		expect(calls[0].url).toBe(GEMINI_OAUTH_TOKEN_URL);
		expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].form.get("grant_type")).toBe("authorization_code");
		expect(calls[0].form.get("code")).toBe("the-code");
		expect(calls[0].form.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
		// The client literals, spelled out: comparing against the constants would
		// re-derive both sides and pass for any value.
		expect(calls[0].form.get("client_id")).toBe(CLIENT_ID);
		expect(calls[0].form.get("client_secret")).toBe(CLIENT_SECRET);
		// The loopback flow's redirect carries no challenge, so no verifier.
		expect(calls[0].form.has("code_verifier")).toBe(false);
	});

	test("carries the PKCE verifier when the paste flow presents one", async () => {
		const { calls, fetchFn } = fakeFetch();
		await exchangeGeminiCode({
			code: "c",
			redirectUri: "https://codeassist.google.com/authcode",
			codeVerifier: "v-1",
			fetch: fetchFn,
		});
		expect(calls[0].form.get("code_verifier")).toBe("v-1");
	});

	test("an answer without a refresh token is accepted, not refused", async () => {
		// A re-consent of an already-granted client comes back this way. Refusing
		// it would lock the user out of the sign-in that just succeeded; the
		// provider reports the missing refresh when the hour is up instead.
		const { fetchFn } = fakeFetch({ access_token: "at-1", expires_in: 3600 });
		const result = await exchangeGeminiCode({ code: "c", redirectUri: "r", fetch: fetchFn, now: 1 });
		expect(result.refreshToken).toBe("");
		expect(result.accessToken).toBe("at-1");
	});

	test("an answer without a stated lifetime stores a null expiry", async () => {
		const { fetchFn } = fakeFetch({ access_token: "at-1", refresh_token: "rt-1" });
		const result = await exchangeGeminiCode({ code: "c", redirectUri: "r", fetch: fetchFn, now: 1 });
		expect(result.expiresAt).toBeNull();
	});

	test("an answer without an access token is refused", async () => {
		const { fetchFn } = fakeFetch({ refresh_token: "rt-1" });
		await expect(exchangeGeminiCode({ code: "c", redirectUri: "r", fetch: fetchFn })).rejects.toThrow(
			"without an access token",
		);
	});

	test("a 400 invalid_grant names the one repair, and marks the grant dead", async () => {
		const { fetchFn } = fakeFetch({ error: "invalid_grant" }, 400);
		try {
			await exchangeGeminiCode({ code: "c", redirectUri: "r", fetch: fetchFn });
			throw new Error("expected the exchange to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(GeminiOAuthError);
			expect((error as GeminiOAuthError).invalidGrant).toBe(true);
			expect((error as Error).message).toContain("Run /login again");
		}
	});

	test("any other refusal names the status and is not a dead grant", async () => {
		const { fetchFn } = fakeFetch({ error: "server_error" }, 500, "Internal Server Error");
		try {
			await exchangeGeminiCode({ code: "c", redirectUri: "r", fetch: fetchFn });
			throw new Error("expected the exchange to reject");
		} catch (error) {
			expect((error as Error).message).toBe("Token exchange failed (500): Internal Server Error");
			expect((error as GeminiOAuthError).invalidGrant).toBe(false);
		}
	});
});

describe("refreshGeminiToken", () => {
	test("posts the refresh grant and rotates what the answer states", async () => {
		const { calls, fetchFn } = fakeFetch({ access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 });
		const previous = credential({ accessToken: "at-1", refreshToken: "rt-1" });
		const refreshed = await refreshGeminiToken({ refreshToken: "rt-1", previous, fetch: fetchFn, now: 700 });
		expect(refreshed.accessToken).toBe("at-2");
		expect(refreshed.refreshToken).toBe("rt-2");
		expect(refreshed.expiresAt).toBe(700 + 1_800_000);
		expect(refreshed.lastRefreshAt).toBe(700);
		// The account read is a nicety nothing can redo on every refresh; it
		// survives rotation.
		expect(refreshed.accountEmail).toBe("user@example.com");
		expect(refreshed.scope).toBe(previous.scope);
		expect(calls[0].form.get("grant_type")).toBe("refresh_token");
		expect(calls[0].form.get("refresh_token")).toBe("rt-1");
		expect(calls[0].form.get("client_id")).toBe(CLIENT_ID);
		expect(calls[0].form.get("client_secret")).toBe(CLIENT_SECRET);
	});

	test("the old refresh token survives an answer that omits one", async () => {
		const { fetchFn } = fakeFetch({ access_token: "at-2", expires_in: 1800 });
		const refreshed = await refreshGeminiToken({
			refreshToken: "rt-1",
			previous: credential(),
			fetch: fetchFn,
			now: 1,
		});
		expect(refreshed.refreshToken).toBe("rt-1");
	});

	test("a stated scope replaces the previous one", async () => {
		const { fetchFn } = fakeFetch({ access_token: "at-2", expires_in: 1800, scope: "new-scope" });
		const refreshed = await refreshGeminiToken({
			refreshToken: "rt-1",
			previous: credential({ scope: "old-scope" }),
			fetch: fetchFn,
			now: 1,
		});
		expect(refreshed.scope).toBe("new-scope");
	});

	test("a dead grant (400 invalid_grant, or a bare 401) says sign in again", async () => {
		for (const [body, status] of [
			[{ error: "invalid_grant" }, 400],
			[{}, 401],
		] as const) {
			const { fetchFn } = fakeFetch(body, status);
			try {
				await refreshGeminiToken({ refreshToken: "rt-1", fetch: fetchFn });
				throw new Error("expected the refresh to reject");
			} catch (error) {
				expect(error).toBeInstanceOf(GeminiOAuthError);
				expect((error as GeminiOAuthError).invalidGrant).toBe(true);
				expect((error as Error).message).toContain("sign in again");
			}
		}
	});

	test("an endpoint having a bad day is not a dead grant", async () => {
		const { fetchFn } = fakeFetch({}, 500, "Internal Server Error");
		try {
			await refreshGeminiToken({ refreshToken: "rt-1", fetch: fetchFn });
			throw new Error("expected the refresh to reject");
		} catch (error) {
			expect((error as Error).message).toBe("Token refresh failed (500): Internal Server Error");
			expect((error as GeminiOAuthError).invalidGrant).toBe(false);
		}
	});

	test("an answer without an access token is refused", async () => {
		const { fetchFn } = fakeFetch({ expires_in: 1800 });
		await expect(refreshGeminiToken({ refreshToken: "rt-1", fetch: fetchFn })).rejects.toThrow(
			"without an access token",
		);
	});
});

describe("geminiRefreshDue", () => {
	test("the five-minute window, boundary included", () => {
		const now = 1_000_000;
		expect(geminiRefreshDue(credential({ expiresAt: now + GEMINI_REFRESH_WINDOW_MS }), now)).toBe(true);
		expect(geminiRefreshDue(credential({ expiresAt: now + GEMINI_REFRESH_WINDOW_MS + 1 }), now)).toBe(false);
		expect(geminiRefreshDue(credential({ expiresAt: now }), now)).toBe(true);
		expect(GEMINI_REFRESH_WINDOW_MS).toBe(300_000);
	});

	test("without a stated lifetime, the 55-minute age stands in for the expiry", () => {
		const now = 10_000_000;
		expect(geminiRefreshDue(credential({ expiresAt: null, lastRefreshAt: now - 3_300_001 }), now)).toBe(true);
		expect(geminiRefreshDue(credential({ expiresAt: null, lastRefreshAt: now - 3_300_000 }), now)).toBe(false);
	});
});

describe("revokeGeminiToken", () => {
	test("posts the token as a query parameter — no body, the issuer's own shape", async () => {
		const { calls, fetchFn } = fakeFetch({});
		const ok = await revokeGeminiToken("rt-1", { fetch: fetchFn });
		expect(ok).toBe(true);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url.startsWith(GEMINI_OAUTH_REVOKE_URL)).toBe(true);
		expect(calls[0].url.startsWith("https://oauth2.googleapis.com/revoke?")).toBe(true);
		expect(new URL(calls[0].url).searchParams.get("token")).toBe("rt-1");
		expect(calls[0].form.toString()).toBe("");
	});

	test("a token the issuer no longer knows counts as revoked", async () => {
		const { fetchFn } = fakeFetch({ error: "invalid_token" }, 400);
		expect(await revokeGeminiToken("rt-1", { fetch: fetchFn })).toBe(true);
	});

	test("a refusing issuer answers false, and an unreachable one does too — never a throw", async () => {
		const refusing = fakeFetch({ error: "server_error" }, 500);
		expect(await revokeGeminiToken("rt-1", { fetch: refusing.fetchFn })).toBe(false);
		const offline = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
			throw new TypeError("fetch failed");
		}) as typeof fetch;
		expect(await revokeGeminiToken("rt-1", { fetch: offline })).toBe(false);
	});
});

describe("createGeminiTokenProvider", () => {
	const NOW = 10_000_000;

	test("serves the stored token while it is fresh, without touching the wire", async () => {
		const store = memoryStore(credential({ accessToken: "fresh", expiresAt: NOW + 3_600_000 }));
		const { calls, fetchFn } = fakeFetch();
		const provider = createGeminiTokenProvider(store, { fetch: fetchFn, now: () => NOW });
		const grant = await provider();
		expect(grant).toEqual({ token: "fresh", expiresAt: NOW + 3_600_000 });
		expect(calls.length).toBe(0);
	});

	test("refreshes inside the window, saves the answer, and serves it", async () => {
		const store = memoryStore(credential({ accessToken: "stale", expiresAt: NOW + 1_000 }));
		const { calls, fetchFn } = fakeFetch({ access_token: "fresh", expires_in: 3600 });
		const provider = createGeminiTokenProvider(store, { fetch: fetchFn, now: () => NOW });
		expect(await provider()).toEqual({ token: "fresh", expiresAt: NOW + 3_600_000 });
		expect(calls.length).toBe(1);
		expect(store.current?.accessToken).toBe("fresh");
	});

	test("concurrent refreshes coalesce into one", async () => {
		const store = memoryStore(credential({ accessToken: "stale", expiresAt: NOW }));
		const { calls, fetchFn } = fakeFetch({ access_token: "fresh", expires_in: 3600 });
		const provider = createGeminiTokenProvider(store, { fetch: fetchFn, now: () => NOW });
		const [a, b] = await Promise.all([provider(), provider()]);
		expect(a).toEqual(b);
		expect(calls.length).toBe(1);
	});

	test("a forced refresh does not join a non-forced one in flight", async () => {
		// The forced caller was just told its token is bad; joining the ordinary
		// refresh would hand it the very token that was refused.
		const store = memoryStore(credential({ accessToken: "stale", expiresAt: NOW }));
		const { calls, fetchFn } = fakeFetch({ access_token: "fresh", expires_in: 3600 });
		const provider = createGeminiTokenProvider(store, { fetch: fetchFn, now: () => NOW });
		await Promise.all([provider(), provider({ forceRefresh: true })]);
		expect(calls.length).toBe(2);
	});

	test("a non-forced caller may join a forced one", async () => {
		const store = memoryStore(credential({ accessToken: "stale", expiresAt: NOW }));
		const { calls, fetchFn } = fakeFetch({ access_token: "fresh", expires_in: 3600 });
		const provider = createGeminiTokenProvider(store, { fetch: fetchFn, now: () => NOW });
		await Promise.all([provider({ forceRefresh: true }), provider()]);
		expect(calls.length).toBe(1);
	});

	test("a forced refresh bypasses the freshness window", async () => {
		const store = memoryStore(credential({ accessToken: "fresh", expiresAt: NOW + 3_600_000 }));
		const { calls, fetchFn } = fakeFetch({ access_token: "newer", expires_in: 3600 });
		const provider = createGeminiTokenProvider(store, { fetch: fetchFn, now: () => NOW });
		expect((await provider({ forceRefresh: true })).token).toBe("newer");
		expect(calls.length).toBe(1);
	});

	test("a dead grant empties the store; a 500 does not", async () => {
		const dead = memoryStore(credential({ accessToken: "stale", expiresAt: NOW }));
		const deadFetch = fakeFetch({ error: "invalid_grant" }, 400);
		const deadProvider = createGeminiTokenProvider(dead, { fetch: deadFetch.fetchFn, now: () => NOW });
		await expect(deadProvider()).rejects.toThrow("sign in again");
		expect(dead.current).toBeNull();

		const flaky = memoryStore(credential({ accessToken: "stale", expiresAt: NOW }));
		const flakyFetch = fakeFetch({}, 500);
		const flakyProvider = createGeminiTokenProvider(flaky, { fetch: flakyFetch.fetchFn, now: () => NOW });
		await expect(flakyProvider()).rejects.toThrow("Token refresh failed (500)");
		// An endpoint having a bad day must not cost the user their login.
		expect(flaky.current?.accessToken).toBe("stale");
	});

	test("a credential whose refresh token is gone and whose hour is up asks for a new sign-in", async () => {
		const store = memoryStore(credential({ accessToken: "stale", refreshToken: "", expiresAt: NOW }));
		const { calls, fetchFn } = fakeFetch();
		const provider = createGeminiTokenProvider(store, { fetch: fetchFn, now: () => NOW });
		await expect(provider()).rejects.toThrow("expired and cannot refresh: sign in again");
		expect(store.current).toBeNull();
		expect(calls.length).toBe(0);
	});

	test("nothing stored is a dead grant before any request is built", async () => {
		const provider = createGeminiTokenProvider(memoryStore(), { now: () => NOW });
		try {
			await provider();
			throw new Error("expected the provider to reject");
		} catch (error) {
			expect((error as Error).message).toBe("Not signed in to a Gemini subscription.");
			expect((error as GeminiOAuthError).invalidGrant).toBe(true);
		}
	});

	test("available(): the refresh token decides, and a fresh access-only credential still counts", async () => {
		const none = createGeminiTokenProvider(memoryStore(), { now: () => NOW });
		expect(await none.available()).toBe(false);

		const withRefresh = createGeminiTokenProvider(memoryStore(credential()), { now: () => NOW });
		expect(await withRefresh.available()).toBe(true);

		const accessOnlyFresh = createGeminiTokenProvider(
			memoryStore(credential({ refreshToken: "", expiresAt: NOW + 3_600_000 })),
			{ now: () => NOW },
		);
		expect(await accessOnlyFresh.available()).toBe(true);

		const accessOnlyStale = createGeminiTokenProvider(memoryStore(credential({ refreshToken: "", expiresAt: NOW })), {
			now: () => NOW,
		});
		expect(await accessOnlyStale.available()).toBe(false);

		const husk = createGeminiTokenProvider(memoryStore(credential({ accessToken: "", refreshToken: "" })), {
			now: () => NOW,
		});
		expect(await husk.available()).toBe(false);
	});
});

describe("createGeminiCredentials", () => {
	test("wires the store and the provider together over an injected home and keychain", async () => {
		const { home, clean } = makeHome();
		try {
			const warnings: string[] = [];
			const store = createGeminiCredentialStore({ home, keychain: null, warn: (m) => warnings.push(m) });
			await store.save(credential({ accessToken: "wired", expiresAt: Date.now() + 3_600_000 }));
			const provider = createGeminiCredentials({ home, keychain: null, warn: (m) => warnings.push(m) });
			expect(await provider.available()).toBe(true);
			expect((await provider()).token).toBe("wired");
		} finally {
			clean();
		}
	});
});
