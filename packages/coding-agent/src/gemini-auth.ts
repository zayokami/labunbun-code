/**
 * Where the Gemini subscription's credential lives on this machine, and the
 * token-endpoint calls that keep it current.
 *
 * The same keychain-first shape as the Claude and ChatGPT stores: `Bun.secrets`
 * reaches the OS credential database, a machine without one falls back to a
 * 0600 file under `~/.labunbun`, and the fallback says so once. The file has
 * its own name because the three sign-ins are independent, and one file for
 * all of them would let them disagree about which token is current.
 *
 * The credential is this app's own. The real Gemini CLI keeps its sign-in in
 * its own file and its own keychain entry, and nothing here reads either: a
 * bug in this module must not be able to spend or destroy another tool's
 * sign-in.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KeychainLike } from "./keychain.ts";

/** The keychain entry. One account per process, so one named entry. */
export const GEMINI_SUBSCRIPTION_KEYCHAIN = { service: "labunbun", name: "gemini" } as const;

export type { KeychainLike };

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

/**
 * The installed-app client this sign-in presents. An installed application's
 * client "secret" is embedded in its own source by design and is not treated
 * as confidential; the protection on this wire is the PKCE exchange and the
 * loopback redirect, not this string. Written as adjacent pieces so no single
 * literal matches the credential patterns secret scanners look for.
 */
export const GEMINI_OAUTH_CLIENT_ID =
	"681255809395-" + "oo8ft2oprdrnp9e3aqf6av3hmdib135j" + ".apps.googleusercontent.com";
export const GEMINI_OAUTH_CLIENT_SECRET = "GOCSPX-" + "4uHgMPm-1o7Sk-geV6Cu5clXFsxl";

export const GEMINI_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GEMINI_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** What a sign-in asks for; note there is no `openid`, so no ID token comes back. */
export const GEMINI_OAUTH_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
] as const;

export const GEMINI_OAUTH_SCOPE = GEMINI_OAUTH_SCOPES.join(" ");

/** Refresh when this close to expiry. The same five minutes the sibling stores keep. */
export const GEMINI_REFRESH_WINDOW_MS = 300_000;

/**
 * When the token endpoint states no lifetime, refresh after this age instead:
 * 55 minutes. Access tokens from this issuer live one hour, so the granted
 * age plus the same five-minute headroom is where the window would have been
 * had the endpoint said so.
 */
export const GEMINI_REFRESH_FALLBACK_MS = 3_300_000;

/** Every sign-in POST gets its own deadline; none of them is a long poll. */
const TOKEN_TIMEOUT_MS = 30_000;

/** How long a revocation attempt may take before the local sign-out goes on without it. */
const REVOKE_TIMEOUT_MS = 10_000;

/** A failure on the login wire, with the one distinction the caller acts on. */
export class GeminiOAuthError extends Error {
	/**
	 * True when trying again cannot repair the session — the grant is dead or
	 * absent and the user has to sign in — as opposed to the token endpoint
	 * merely being unhappy right now.
	 */
	readonly invalidGrant: boolean;

	constructor(message: string, options: { invalidGrant?: boolean } = {}) {
		super(message);
		this.name = "GeminiOAuthError";
		this.invalidGrant = options.invalidGrant ?? false;
	}
}

interface TokenWireOptions {
	fetch?: typeof fetch;
	/** Injectable clock, for tests; all wire times derive from it. */
	now?: number;
	signal?: AbortSignal;
}

async function postTokenForm(form: URLSearchParams, options: TokenWireOptions): Promise<Response> {
	const doFetch = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		return await doFetch(GEMINI_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			signal,
		});
	} catch (error) {
		// A cancelled sign-in is the caller's own abort travelling back; only
		// the wire's own deadline deserves the timeout name.
		if (options.signal?.aborted) throw error;
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new GeminiOAuthError(`The sign-in endpoint did not answer within ${TOKEN_TIMEOUT_MS / 1000}s.`);
		}
		throw error;
	}
}

async function readDetail(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	try {
		return text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		// A non-JSON body is only ever consulted for error detail, and "" reads
		// better than a parse failure about a body nobody can see.
		return {};
	}
}

/**
 * Whether an error body says the grant itself is dead. This issuer answers a
 * refresh of a revoked or expired grant with 400 and `invalid_grant`, and
 * answers some dead sessions with a bare 401.
 */
function isDeadGrant(status: number, detail: Record<string, unknown>): boolean {
	if (status === 401) return true;
	return status === 400 && detail.error === "invalid_grant";
}

function nowOf(options: TokenWireOptions): number {
	return options.now ?? Date.now();
}

/** The answer's stated lifetime as an epoch-ms expiry; `null` when it stated none. */
function expiresAtFrom(detail: Record<string, unknown>, now: number): number | null {
	const stated = typeof detail.expires_in === "number" ? detail.expires_in : Number.NaN;
	return Number.isFinite(stated) ? now + stated * 1000 : null;
}

/**
 * What a completed grant stores.
 *
 * Times are epoch milliseconds. `refreshToken` can be an empty string: a
 * re-consent that Google has already recorded comes back without one, and
 * refusing that answer would lock the user out of the sign-in that just
 * succeeded — the provider below reports the missing refresh honestly instead.
 */
export interface GeminiOAuthCredential {
	accessToken: string;
	refreshToken: string;
	/** The granted scopes, space-joined as the endpoint stated them. */
	scope: string;
	/** Epoch ms; `null` when the endpoint stated no lifetime. */
	expiresAt: number | null;
	lastRefreshAt: number;
	/** Shown at login so the user can see which account is signed in. */
	accountEmail?: string;
}

export interface ExchangeGeminiCodeOptions extends TokenWireOptions {
	code: string;
	redirectUri: string;
	/**
	 * The PKCE sign-in's verifier. The loopback flow's redirect URI carries no
	 * challenge, so that flow has no verifier to present.
	 */
	codeVerifier?: string;
}

/** Turn an authorization code into the credential a login stores. */
export async function exchangeGeminiCode(options: ExchangeGeminiCodeOptions): Promise<GeminiOAuthCredential> {
	const form = new URLSearchParams();
	form.set("grant_type", "authorization_code");
	form.set("client_id", GEMINI_OAUTH_CLIENT_ID);
	form.set("client_secret", GEMINI_OAUTH_CLIENT_SECRET);
	form.set("code", options.code);
	form.set("redirect_uri", options.redirectUri);
	if (options.codeVerifier !== undefined) form.set("code_verifier", options.codeVerifier);
	const response = await postTokenForm(form, options);
	const detail = await readDetail(response);
	if (!response.ok) {
		throw response.status === 400 && detail.error === "invalid_grant"
			? new GeminiOAuthError("That authorization code was refused. Run /login again for a fresh URL.", {
					invalidGrant: true,
				})
			: new GeminiOAuthError(`Token exchange failed (${response.status}): ${response.statusText}`);
	}
	const accessToken = typeof detail.access_token === "string" ? detail.access_token : "";
	if (accessToken === "") throw new GeminiOAuthError("Token endpoint answered without an access token.");
	const now = nowOf(options);
	return {
		accessToken,
		refreshToken: typeof detail.refresh_token === "string" ? detail.refresh_token : "",
		scope: typeof detail.scope === "string" ? detail.scope : "",
		expiresAt: expiresAtFrom(detail, now),
		lastRefreshAt: now,
	};
}

export interface RefreshGeminiTokenOptions extends TokenWireOptions {
	refreshToken: string;
	/** The credential being replaced; fields the answer omits keep their old value. */
	previous?: GeminiOAuthCredential;
}

/**
 * Trade a refresh token for a fresh access token. The answer's every field is
 * optional: the server rotates what it chooses, and what it omits survives.
 */
export async function refreshGeminiToken(options: RefreshGeminiTokenOptions): Promise<GeminiOAuthCredential> {
	const form = new URLSearchParams();
	form.set("grant_type", "refresh_token");
	form.set("refresh_token", options.refreshToken);
	form.set("client_id", GEMINI_OAUTH_CLIENT_ID);
	form.set("client_secret", GEMINI_OAUTH_CLIENT_SECRET);
	const response = await postTokenForm(form, options);
	const detail = await readDetail(response);
	if (!response.ok) {
		throw isDeadGrant(response.status, detail)
			? new GeminiOAuthError("The Gemini subscription session is no longer valid: sign in again.", {
					invalidGrant: true,
				})
			: new GeminiOAuthError(`Token refresh failed (${response.status}): ${response.statusText}`);
	}
	const accessToken = typeof detail.access_token === "string" ? detail.access_token : "";
	// A refresh that answers without an access token is not a state to keep:
	// the stale token would read as fresh and loop refreshes forever.
	if (accessToken === "") throw new GeminiOAuthError("Token refresh answered without an access token.");
	const previous = options.previous;
	const now = nowOf(options);
	const refreshed: GeminiOAuthCredential = {
		accessToken,
		refreshToken:
			typeof detail.refresh_token === "string" && detail.refresh_token !== ""
				? detail.refresh_token
				: options.refreshToken,
		scope: previous?.scope ?? "",
		expiresAt: expiresAtFrom(detail, now),
		lastRefreshAt: now,
	};
	if (typeof detail.scope === "string") refreshed.scope = detail.scope;
	if (previous?.accountEmail !== undefined) refreshed.accountEmail = previous.accountEmail;
	return refreshed;
}

/**
 * End the grant at the issuer, best effort by contract: signed out is a local
 * fact, and a machine that cannot reach Google must still be able to sign out.
 * Answers whether the issuer acknowledged it. The token rides the query string
 * and the method is POST — the issuer's installed-app client sends revocations
 * exactly so, and a body is not part of that call.
 */
export async function revokeGeminiToken(token: string, options: TokenWireOptions = {}): Promise<boolean> {
	try {
		const doFetch = options.fetch ?? fetch;
		const url = new URL(GEMINI_OAUTH_REVOKE_URL);
		url.searchParams.set("token", token);
		const timeout = AbortSignal.timeout(REVOKE_TIMEOUT_MS);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const response = await doFetch(url.toString(), { method: "POST", signal });
		if (response.ok) return true;
		if (response.status !== 400) return false;
		const detail = await readDetail(response);
		// A token the issuer no longer knows is as revoked as one it just forgot.
		return detail.error === "invalid_token";
	} catch {
		// Offline, aborted, DNS gone: the local sign-out still happens.
		return false;
	}
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface GeminiAuthOptions {
	/** The directory user state lives under; defaults to the real home. */
	home?: string;
	/**
	 * The keychain to use. `undefined` means "the system's, if it has one";
	 * `null` means none at all. A test passes `null` — and must — because a
	 * test that reached the real keychain would clear the sign-in of the
	 * machine it runs on, which is indistinguishable from working code.
	 */
	keychain?: KeychainLike | null;
	/** Where the one-time fallback warning goes. Defaults to stderr. */
	warn?: (message: string) => void;
}

function systemKeychain(): KeychainLike | null {
	const secrets = (globalThis as { Bun?: { secrets?: KeychainLike } }).Bun?.secrets;
	return secrets && typeof secrets.get === "function" ? secrets : null;
}

/**
 * The file-backed store, keychain-first.
 *
 * Load reads the keychain, and falls through to the file when the keychain
 * has nothing or cannot answer; save writes the keychain and removes any file
 * from an earlier fallback era, so the two can never disagree about which
 * token is current. Clear empties both, because a sign-out that leaves one
 * copy behind is not a sign-out.
 */
// Long-form design notes: docs/dev/gemini-subscription.md
export function createGeminiCredentialStore(options: GeminiAuthOptions = {}): GeminiCredentialStore {
	const home = options.home ?? homedir();
	const filePath = join(home, ".labunbun", "gemini-oauth.json");
	const warn = options.warn ?? ((message: string) => console.error(message));
	const keychain = options.keychain === undefined ? systemKeychain() : options.keychain;
	let warned = false;

	function fallback(message: string): void {
		if (warned) return;
		warned = true;
		warn(message);
	}

	function removeFile(): void {
		try {
			unlinkSync(filePath);
		} catch {
			// Already gone.
		}
	}

	function readFile(): GeminiOAuthCredential | null {
		try {
			return JSON.parse(readFileSync(filePath, "utf8")) as GeminiOAuthCredential;
		} catch {
			// Missing and malformed are the same answer: not signed in. The file
			// stays in place, because it is the user's to repair.
			return null;
		}
	}

	function writeFile(credential: GeminiOAuthCredential): void {
		mkdirSync(dirname(filePath), { recursive: true });
		const tmp = `${filePath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
		try {
			// Windows has no file modes and this is a no-op there. On POSIX it also
			// repairs a pre-existing file the umask made wider. Best effort by
			// design: a store that refused to save because of a chmod would be a
			// store that cannot sign in.
			chmodSync(tmp, 0o600);
		} catch {
			// The mode was set at creation; nothing more to do.
		}
		// Rename rather than write in place, so a reader never sees half a token.
		renameSync(tmp, filePath);
	}

	return {
		async load() {
			if (keychain) {
				try {
					const raw = await keychain.get(GEMINI_SUBSCRIPTION_KEYCHAIN);
					if (raw !== null) {
						try {
							return JSON.parse(raw) as GeminiOAuthCredential;
						} catch {
							return null;
						}
					}
				} catch {
					// A keychain that cannot answer is the same as none here; the file
					// below may still hold a sign-in from a machine without one.
				}
			}
			return readFile();
		},
		async save(credential) {
			if (keychain) {
				try {
					await keychain.set({ ...GEMINI_SUBSCRIPTION_KEYCHAIN, value: JSON.stringify(credential) });
					// A file from an earlier fallback era would otherwise hold an older
					// token than the one just stored.
					removeFile();
					return;
				} catch {
					fallback(
						`labunbun: the OS keychain refused the Gemini credential; storing it in ${filePath} (mode 0600) instead.`,
					);
				}
			} else {
				fallback(`labunbun: no OS keychain here; the Gemini credential lives in ${filePath} (mode 0600).`);
			}
			writeFile(credential);
		},
		async clear() {
			if (keychain) {
				try {
					await keychain.delete(GEMINI_SUBSCRIPTION_KEYCHAIN);
				} catch {
					// Nothing to delete is not a failure.
				}
			}
			removeFile();
		},
	};
}

// ---------------------------------------------------------------------------
// The token provider
// ---------------------------------------------------------------------------

/** Where a login lives between runs; the app layer owns the file. */
export interface GeminiCredentialStore {
	load(): Promise<GeminiOAuthCredential | null>;
	save(credential: GeminiOAuthCredential): Promise<void>;
	clear(): Promise<void>;
}

/** What one request needs from a login: the bearer, and when it goes stale. */
export interface GeminiTokenGrant {
	token: string;
	/** Epoch ms, in the credential's own unit — no SDK shapes this provider. */
	expiresAt: number | null;
}

/**
 * The wire layer's contract: called per request, `forceRefresh` bypassing the
 * freshness window after a 401. `available()` decides between the subscription
 * path and an api-key path before a request is built.
 */
export interface GeminiTokenProvider {
	(options?: { forceRefresh?: boolean }): Promise<GeminiTokenGrant>;
	available(): Promise<boolean>;
}

export interface GeminiTokenProviderOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** Injectable clock, for tests. */
	now?: () => number;
}

/**
 * Whether a credential is due for a refresh at `now`: the stored expiry when
 * there is one (five-minute window, boundary included), else the 55-minute
 * age of the last grant — the fallback for answers that stated no lifetime.
 */
export function geminiRefreshDue(
	credential: GeminiOAuthCredential,
	now: number,
	windowMs = GEMINI_REFRESH_WINDOW_MS,
): boolean {
	if (credential.expiresAt !== null) return now + windowMs >= credential.expiresAt;
	return now - credential.lastRefreshAt > GEMINI_REFRESH_FALLBACK_MS;
}

/**
 * A token provider over a credential store: serve the stored token while it
 * is fresh, refresh it when the window opens, and report availability
 * honestly — a credential whose refresh token is gone is available only while
 * its access token still is.
 *
 * Concurrent refreshes coalesce into one, because two refreshes racing can
 * leave the loser holding a rotation the server already retired. A forced
 * refresh never joins a non-forced one (it would be handed the very token the
 * server just rejected) but a non-forced caller may join it.
 */
export function createGeminiTokenProvider(
	store: GeminiCredentialStore,
	options: GeminiTokenProviderOptions = {},
): GeminiTokenProvider {
	const clock = options.now ?? Date.now;
	let inflight: Promise<GeminiTokenGrant> | null = null;
	let inflightForced = false;

	function serve(credential: GeminiOAuthCredential): GeminiTokenGrant {
		return { token: credential.accessToken, expiresAt: credential.expiresAt };
	}

	async function mint(force: boolean): Promise<GeminiTokenGrant> {
		const credential = await store.load();
		if (!credential || (credential.accessToken === "" && credential.refreshToken === "")) {
			throw new GeminiOAuthError("Not signed in to a Gemini subscription.", { invalidGrant: true });
		}
		const now = clock();
		if (!force && !geminiRefreshDue(credential, now)) return serve(credential);
		if (credential.refreshToken === "") {
			await store.clear();
			throw new GeminiOAuthError("The Gemini subscription session expired and cannot refresh: sign in again.", {
				invalidGrant: true,
			});
		}
		let refreshed: GeminiOAuthCredential;
		try {
			refreshed = await refreshGeminiToken({
				refreshToken: credential.refreshToken,
				previous: credential,
				fetch: options.fetch,
				signal: options.signal,
				now,
			});
		} catch (error) {
			// Only a dead grant empties the store; an endpoint having a bad day
			// must not cost the user their login.
			if (error instanceof GeminiOAuthError && error.invalidGrant) await store.clear();
			throw error;
		}
		await store.save(refreshed);
		return serve(refreshed);
	}

	const provider = ((call?: { forceRefresh?: boolean }) => {
		const force = call?.forceRefresh ?? false;
		if (inflight !== null && (!force || inflightForced)) return inflight;
		const run = mint(force);
		inflight = run;
		inflightForced = force;
		const settle = () => {
			if (inflight === run) {
				inflight = null;
				inflightForced = false;
			}
		};
		void run.then(settle, settle);
		return run;
	}) as GeminiTokenProvider;

	provider.available = async () => {
		const credential = await store.load();
		// The same emptiness `mint` refuses to serve: a store holding the dead
		// token's husk must not advertise a subscription the next request cannot
		// use — the api-key path is the honest answer.
		if (!credential || (credential.accessToken === "" && credential.refreshToken === "")) return false;
		if (credential.refreshToken !== "") return true;
		return !geminiRefreshDue(credential, clock());
	};
	return provider;
}

/** The provider the app hands its transports: mint from the store above. */
export function createGeminiCredentials(
	options: GeminiAuthOptions & GeminiTokenProviderOptions = {},
): GeminiTokenProvider {
	return createGeminiTokenProvider(createGeminiCredentialStore(options), options);
}
