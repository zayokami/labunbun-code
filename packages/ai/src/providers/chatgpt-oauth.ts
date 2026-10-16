// Long-form design notes: docs/dev/ai-layer.md
/**
 * The ChatGPT subscription OAuth wire, in four pieces: the login handshake
 * (PKCE, the authorize URL, the code-for-token exchange), the refresh grant,
 * the token provider the streaming adapter consumes, and the device-code
 * sign-in for machines whose localhost a browser cannot reach.
 *
 * Endpoints, scopes, and request shapes are the ones the Codex CLI speaks —
 * this is a reference implementation of that wire. Two shapes differ from the
 * Claude subscription wire and are easy to get backwards: the code exchange
 * is form-encoded while the refresh grant is JSON, and a grant answer carries
 * no `expires_in` — the access token's lifetime lives in its own JWT `exp`
 * claim. The Authorization and ChatGPT-Account-ID headers that mark a
 * subscription request are added by the streaming adapter; this module
 * supplies the values they carry.
 */

import { createHash, randomBytes } from "node:crypto";

// Long-form design notes: docs/dev/ai-layer.md
/** Where a ChatGPT subscription sign-in starts: tokens arrive at the same host. */
export const CHATGPT_OAUTH_ISSUER = "https://auth.openai.com";

/** The whole handshake hangs off these issuer paths. */
export const CHATGPT_OAUTH_AUTHORIZE_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/authorize`;
export const CHATGPT_OAUTH_TOKEN_URL = `${CHATGPT_OAUTH_ISSUER}/oauth/token`;

/** The id the Codex CLI's own logins carry; the host answers no other door. */
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** What a subscription login asks for, as the single space-joined string. */
export const CHATGPT_OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

/**
 * The client name the authorize link and the API header both present. One
 * constant because they must not drift: the same value that opens the login
 * page identifies the traffic that uses it.
 */
export const CHATGPT_ORIGINATOR = "codex_cli_rs";

/** Refresh when this close to expiry: the same five minutes the reference client keeps. */
export const CHATGPT_REFRESH_WINDOW_MS = 300_000;

/** When the access token carries no readable `exp`, refresh after this age instead: 8 days. */
export const CHATGPT_REFRESH_FALLBACK_MS = 691_200_000;

/** Every sign-in POST gets its own deadline; none of them is a long poll. */
const TOKEN_TIMEOUT_MS = 30_000;

/** How long the device flow waits for the user to approve, overall: 15 minutes. */
const DEVICE_POLL_TIMEOUT_MS = 900_000;

/** Poll spacing when the server does not state one. */
const DEVICE_POLL_FALLBACK_INTERVAL_MS = 5_000;

// Long-form design notes: docs/dev/ai-layer.md
/** A failure on the login wire, with the one distinction the caller acts on. */
export class ChatGptOAuthError extends Error {
	/**
	 * True when trying again cannot repair the session — the grant is dead or
	 * absent and the user has to sign in — as opposed to the token endpoint
	 * merely being unhappy right now. The retry ladder reads it to fail fast
	 * instead of keeping "sign in" off the screen for two minutes.
	 */
	readonly invalidGrant: boolean;

	constructor(message: string, options: { invalidGrant?: boolean } = {}) {
		super(message);
		this.name = "ChatGptOAuthError";
		this.invalidGrant = options.invalidGrant ?? false;
	}
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

function base64url(data: Uint8Array): string {
	return Buffer.from(data).toString("base64url");
}

// Long-form design notes: docs/dev/ai-layer.md
/** A PKCE pair: 64 random bytes and their SHA-256, both as base64url. */
export function createChatGptPkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(64));
	return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** The `state` that ties the callback to this sign-in, 32 random bytes. */
export function createChatGptOAuthState(): string {
	return base64url(randomBytes(32));
}

export interface ChatGptAuthorizeOptions {
	redirectUri: string;
	state: string;
	codeChallenge: string;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The URL a browser opens to sign in, parameters in the reference client's order. */
export function chatGptAuthorizeUrl(options: ChatGptAuthorizeOptions): string {
	const url = new URL(CHATGPT_OAUTH_AUTHORIZE_URL);
	// The order below is the one the reference client emits its own links in.
	// The host does not require it; a fixed order is what makes the URL
	// testable. The three trailing parameters are the client's own knobs: ask
	// the ID token for organization claims, use the simplified flow, and
	// identify the requesting client.
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CHATGPT_OAUTH_CLIENT_ID);
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("code_challenge", options.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", options.state);
	url.searchParams.set("scope", CHATGPT_OAUTH_SCOPE);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", CHATGPT_ORIGINATOR);
	return url.toString();
}

// ---------------------------------------------------------------------------
// The ID token
// ---------------------------------------------------------------------------

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
	const parts = jwt.split(".");
	if (parts.length !== 3) return undefined;
	const [header, payload, signature] = parts;
	if (!header || !payload || !signature) return undefined;
	try {
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** The pieces of an ID token this app acts on. */
export interface ChatGptIdTokenClaims {
	/** The ChatGPT account the login belongs to; the API header needs it. */
	accountId?: string;
	accountEmail?: string;
	/** The subscription plan ("plus", "pro", …), for the login message. */
	planType?: string;
	/** Whether the account routes through the FedRAMP edge. */
	fedramp: boolean;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The ID token's claims, flattened: e-mail and account data live under the
 * `https://api.openai.com/...` namespaced claims. `undefined` means the token
 * was not a JWT at all — an empty claim set is not an error, because an ID
 * token without an auth claim is simply an account this login knows nothing
 * about.
 */
export function parseChatGptIdToken(jwt: string): ChatGptIdTokenClaims | undefined {
	const claims = decodeJwtPayload(jwt);
	if (claims === undefined) return undefined;
	const profile = claims["https://api.openai.com/profile"] as { email?: unknown } | undefined;
	const auth = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
	const email = typeof claims.email === "string" ? claims.email : undefined;
	const profileEmail = typeof profile?.email === "string" ? profile.email : undefined;
	const accountEmail = email ?? profileEmail;
	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
	const planType = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
	return {
		...(accountId !== undefined ? { accountId } : {}),
		...(accountEmail !== undefined ? { accountEmail } : {}),
		...(planType !== undefined ? { planType } : {}),
		fedramp: auth?.chatgpt_account_is_fedramp === true,
	};
}

// Long-form design notes: docs/dev/ai-layer.md
/** The access token's own expiry, epoch ms; `null` when there is no readable `exp`. */
export function chatGptJwtExpiresAt(jwt: string): number | null {
	const claims = decodeJwtPayload(jwt);
	const exp = claims?.exp;
	return typeof exp === "number" ? exp * 1000 : null;
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/ai-layer.md
/**
 * What a completed grant stores.
 *
 * Times are epoch milliseconds. `expiresAt` comes from the access token's own
 * `exp` claim (`null` = no readable claim). `lastRefreshAt` is informational
 * until it is not: when `expiresAt` is null it becomes the refresh clock, the
 * same 8-day fallback the reference client keeps beside its tokens.
 */
export interface ChatGptOAuthCredential {
	accessToken: string;
	refreshToken: string;
	/** The raw ID token; its claims carry the account id the API headers need. */
	idToken: string;
	/** ChatGPT account id from the ID token; `null` when the token names none. */
	accountId: string | null;
	expiresAt: number | null;
	lastRefreshAt: number;
	/** Shown at login so the user can see which account is signed in. */
	accountEmail?: string;
	/** The subscription plan the ID token states, for the login message. */
	planType?: string;
	/** Whether the account routes through the FedRAMP edge. */
	fedramp: boolean;
}

interface TokenWireOptions {
	fetch?: typeof fetch;
	/** Injectable clock, for tests; all wire times derive from it. */
	now?: number;
	signal?: AbortSignal;
}

interface WirePost {
	headers: Record<string, string>;
	body: string;
}

async function sendRequest(url: string, post: WirePost, options: TokenWireOptions): Promise<Response> {
	const doFetch = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	try {
		return await doFetch(url, { method: "POST", headers: post.headers, body: post.body, signal });
	} catch (error) {
		// A cancelled sign-in is the caller's own abort travelling back; only
		// the wire's own deadline deserves the timeout name.
		if (options.signal?.aborted) throw error;
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new ChatGptOAuthError(`The sign-in endpoint did not answer within ${TOKEN_TIMEOUT_MS / 1000}s.`);
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
 * Whether an error body says the grant itself is dead (as opposed to the
 * endpoint being briefly unhappy). The reference client's rule: a 401, its
 * word list, or a 400 that names `invalid_grant`.
 */
function isDeadGrant(status: number, detail: Record<string, unknown>): boolean {
	if (status === 401) return true;
	const error = typeof detail.error === "string" ? detail.error : "";
	const code = typeof detail.code === "string" ? detail.code : "";
	if (status === 400 && (error === "invalid_grant" || code === "invalid_grant")) return true;
	return /refresh_token_(expired|reused|invalidated)/i.test(`${error} ${code}`);
}

function idTokenClaimsOrThrow(idToken: string, subject: string): ChatGptIdTokenClaims {
	const claims = parseChatGptIdToken(idToken);
	if (claims === undefined) throw new ChatGptOAuthError(`${subject} answered with an unreadable ID token.`);
	return claims;
}

export interface ExchangeChatGptCodeOptions extends TokenWireOptions {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	clientId?: string;
}

// Long-form design notes: docs/dev/ai-layer.md
/** Turn an authorization code into the tokens a login stores (form-encoded). */
export async function exchangeChatGptCode(options: ExchangeChatGptCodeOptions): Promise<ChatGptOAuthCredential> {
	const clientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
	// The reference client's exact field set and order; this path is an OAuth
	// token endpoint and nothing more.
	const form = new URLSearchParams();
	form.set("grant_type", "authorization_code");
	form.set("client_id", clientId);
	form.set("code", options.code);
	form.set("redirect_uri", options.redirectUri);
	form.set("code_verifier", options.codeVerifier);
	const response = await sendRequest(
		CHATGPT_OAUTH_TOKEN_URL,
		{ headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
		options,
	);
	const detail = await readDetail(response);
	if (!response.ok) {
		throw response.status === 401
			? new ChatGptOAuthError("Authentication failed: Invalid authorization code", { invalidGrant: true })
			: new ChatGptOAuthError(`Token exchange failed (${response.status}): ${response.statusText}`);
	}
	const idToken = typeof detail.id_token === "string" ? detail.id_token : "";
	const accessToken = typeof detail.access_token === "string" ? detail.access_token : "";
	const refreshToken = typeof detail.refresh_token === "string" ? detail.refresh_token : "";
	// A grant that cannot refresh dies within the hour; refusing it here is
	// kinder than storing a login that silently stops working. The ID token is
	// how the account id — a header the API cannot be called without — arrives.
	if (accessToken === "") throw new ChatGptOAuthError("Token endpoint answered without an access token.");
	if (refreshToken === "") throw new ChatGptOAuthError("Token endpoint answered without a refresh token.");
	if (idToken === "") throw new ChatGptOAuthError("Token endpoint answered without an ID token.");
	const claims = idTokenClaimsOrThrow(idToken, "Token endpoint");
	return {
		accessToken,
		refreshToken,
		idToken,
		accountId: claims.accountId ?? null,
		expiresAt: chatGptJwtExpiresAt(accessToken),
		lastRefreshAt: options.now ?? Date.now(),
		...(claims.accountEmail !== undefined ? { accountEmail: claims.accountEmail } : {}),
		...(claims.planType !== undefined ? { planType: claims.planType } : {}),
		fedramp: claims.fedramp,
	};
}

export interface RefreshChatGptTokenOptions extends TokenWireOptions {
	refreshToken: string;
	clientId?: string;
	/** The credential being replaced; fields the answer omits keep their old value. */
	previous?: ChatGptOAuthCredential;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * Trade a refresh token for a fresh access token — JSON this time, the same
 * grant the same endpoint takes two ways. The answer's every field is
 * optional: the server rotates what it chooses, and what it omits survives.
 */
export async function refreshChatGptToken(options: RefreshChatGptTokenOptions): Promise<ChatGptOAuthCredential> {
	const clientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
	const response = await sendRequest(
		CHATGPT_OAUTH_TOKEN_URL,
		{
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_id: clientId,
				grant_type: "refresh_token",
				refresh_token: options.refreshToken,
			}),
		},
		options,
	);
	const detail = await readDetail(response);
	if (!response.ok) {
		throw isDeadGrant(response.status, detail)
			? new ChatGptOAuthError("The ChatGPT subscription session is no longer valid: sign in again.", {
					invalidGrant: true,
				})
			: new ChatGptOAuthError(`Token refresh failed (${response.status}): ${response.statusText}`);
	}
	const previous = options.previous;
	const accessToken = typeof detail.access_token === "string" ? detail.access_token : "";
	// Unlike the exchange, a gift-less refresh is not a state to keep: the
	// stale token would read as fresh and loop refreshes forever.
	if (accessToken === "") throw new ChatGptOAuthError("Token refresh answered without an access token.");
	const refreshToken =
		typeof detail.refresh_token === "string" && detail.refresh_token !== ""
			? detail.refresh_token
			: options.refreshToken;
	const idToken =
		typeof detail.id_token === "string" && detail.id_token !== "" ? detail.id_token : (previous?.idToken ?? "");
	const claims = idToken === "" ? undefined : idTokenClaimsOrThrow(idToken, "Token refresh");
	const accountEmail = claims?.accountEmail ?? previous?.accountEmail;
	const planType = claims?.planType ?? previous?.planType;
	return {
		accessToken,
		refreshToken,
		idToken,
		accountId: claims?.accountId ?? previous?.accountId ?? null,
		expiresAt: chatGptJwtExpiresAt(accessToken),
		lastRefreshAt: options.now ?? Date.now(),
		...(accountEmail !== undefined ? { accountEmail } : {}),
		...(planType !== undefined ? { planType } : {}),
		fedramp: claims?.fedramp ?? previous?.fedramp ?? false,
	};
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * Whether a credential is due for a refresh at `now`: the stored expiry when
 * there is one (five-minute window, boundary included), else the 8-day age of
 * the last grant — the reference client's fallback for tokens whose `exp` it
 * could not read.
 */
export function chatGptRefreshDue(
	credential: ChatGptOAuthCredential,
	now: number,
	windowMs = CHATGPT_REFRESH_WINDOW_MS,
): boolean {
	if (credential.expiresAt !== null) return now + windowMs >= credential.expiresAt;
	return now - credential.lastRefreshAt > CHATGPT_REFRESH_FALLBACK_MS;
}

// ---------------------------------------------------------------------------
// The token provider
// ---------------------------------------------------------------------------

/** Where a login lives between runs; the app layer owns the file. */
export interface ChatGptCredentialStore {
	load(): Promise<ChatGptOAuthCredential | null>;
	save(credential: ChatGptOAuthCredential): Promise<void>;
	clear(): Promise<void>;
}

/** What one request needs from a login: the bearer and the two header values. */
export interface ChatGptTokenGrant {
	token: string;
	/** Epoch ms, in the credential's own unit — no SDK shapes this provider. */
	expiresAt: number | null;
	/** Goes in the ChatGPT-Account-ID header. */
	accountId: string | null;
	/** Decides the FedRAMP header. */
	fedramp: boolean;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The streaming adapter's contract: called per request, `forceRefresh`
 * bypassing the freshness window after a 401. `available()` is this layer's
 * addition — it decides between the subscription path and the api-key path
 * before a request is built.
 */
export interface ChatGptTokenProvider {
	(options?: { forceRefresh?: boolean }): Promise<ChatGptTokenGrant>;
	available(): Promise<boolean>;
}

export interface ChatGptTokenProviderOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** Injectable clock, for tests. */
	now?: () => number;
	clientId?: string;
}

/**
 * A token provider over a credential store: serve the stored token while it
 * is fresh, refresh it when the window opens, and report availability
 * honestly — a credential whose refresh token is gone is available only
 * while its access token still is.
 *
 * Concurrent refreshes coalesce into one, because two refreshes racing can
 * leave the loser holding a rotation the server already retired. A forced
 * refresh never joins a non-forced one (it would be handed the very token
 * the server just rejected) but a non-forced caller may join it.
 */
export function createChatGptTokenProvider(
	store: ChatGptCredentialStore,
	options: ChatGptTokenProviderOptions = {},
): ChatGptTokenProvider {
	const clock = options.now ?? Date.now;
	const fallbackClientId = options.clientId ?? CHATGPT_OAUTH_CLIENT_ID;
	let inflight: Promise<ChatGptTokenGrant> | null = null;
	let inflightForced = false;

	function serve(credential: ChatGptOAuthCredential): ChatGptTokenGrant {
		return {
			token: credential.accessToken,
			expiresAt: credential.expiresAt,
			accountId: credential.accountId,
			fedramp: credential.fedramp,
		};
	}

	async function mint(force: boolean): Promise<ChatGptTokenGrant> {
		const credential = await store.load();
		if (!credential || (credential.accessToken === "" && credential.refreshToken === "")) {
			throw new ChatGptOAuthError("Not signed in to a ChatGPT subscription.", { invalidGrant: true });
		}
		const now = clock();
		if (!force && !chatGptRefreshDue(credential, now)) return serve(credential);
		if (credential.refreshToken === "") {
			await store.clear();
			throw new ChatGptOAuthError("The ChatGPT subscription session expired and cannot refresh: sign in again.", {
				invalidGrant: true,
			});
		}
		let refreshed: ChatGptOAuthCredential;
		try {
			refreshed = await refreshChatGptToken({
				refreshToken: credential.refreshToken,
				clientId: fallbackClientId,
				previous: credential,
				fetch: options.fetch,
				signal: options.signal,
				now,
			});
		} catch (error) {
			// Only a dead grant empties the store; an endpoint having a bad day
			// must not cost the user their login.
			if (error instanceof ChatGptOAuthError && error.invalidGrant) await store.clear();
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
	}) as ChatGptTokenProvider;

	provider.available = async () => {
		const credential = await store.load();
		// The same emptiness `mint` refuses to serve: a store holding the dead
		// token's husk must not advertise a subscription the next request cannot
		// use — the api-key path is the honest answer.
		if (!credential || (credential.accessToken === "" && credential.refreshToken === "")) return false;
		if (credential.refreshToken !== "") return true;
		return !chatGptRefreshDue(credential, clock());
	};
	return provider;
}

// ---------------------------------------------------------------------------
// The device flow
// ---------------------------------------------------------------------------

export interface ChatGptDeviceCode {
	/** The server's handle for this attempt; the poll sends it back. */
	deviceAuthId: string;
	/** The one-time code the user enters on the verification page. */
	userCode: string;
	/** The page the user opens to approve the sign-in. */
	verificationUrl: string;
	/** Poll spacing, in ms (the server states it in seconds, as a string). */
	intervalMs: number;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * Start a device sign-in: a one-time code the user enters in any browser, for
 * machines whose localhost no browser can reach.
 */
export async function requestChatGptDeviceCode(options: TokenWireOptions = {}): Promise<ChatGptDeviceCode> {
	const response = await sendRequest(
		`${CHATGPT_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
		{
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
		},
		options,
	);
	const detail = await readDetail(response);
	if (!response.ok) {
		throw response.status === 404
			? new ChatGptOAuthError("Device sign-in is not enabled for this server; use the browser sign-in instead.")
			: new ChatGptOAuthError(`Device sign-in failed (${response.status}): ${response.statusText}`);
	}
	const deviceAuthId = typeof detail.device_auth_id === "string" ? detail.device_auth_id : "";
	// The server has spelled this field both ways; both are the same code.
	const userCode =
		typeof detail.user_code === "string"
			? detail.user_code
			: typeof detail.usercode === "string"
				? detail.usercode
				: "";
	if (deviceAuthId === "" || userCode === "") {
		throw new ChatGptOAuthError("Device code endpoint answered without a code.");
	}
	const statedInterval = typeof detail.interval === "string" ? Number(detail.interval) : Number.NaN;
	const intervalMs =
		Number.isFinite(statedInterval) && statedInterval > 0 ? statedInterval * 1000 : DEVICE_POLL_FALLBACK_INTERVAL_MS;
	return {
		deviceAuthId,
		userCode,
		verificationUrl: `${CHATGPT_OAUTH_ISSUER}/codex/device`,
		intervalMs,
	};
}

/** Wait `ms`, or until the sign-in is cancelled. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		// An abort event does not replay for a listener added after it. The signal
		// can already be aborted here — the poll loop's own check runs before its
		// request, and a cancel during that await lands in this window — and
		// without this the wait ran out its full interval before the next
		// iteration's check noticed, keeping a cancelled sign-in waiting on a
		// timer that no longer had anything to wait for.
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Sign-in aborted."));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Sign-in aborted."));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface CompleteChatGptDeviceLoginOptions extends TokenWireOptions {
	deviceAuthId: string;
	userCode: string;
	/** Poll spacing from the device-code request. */
	intervalMs: number;
	clientId?: string;
	/** The overall poll cap; the reference client allows 15 minutes. */
	timeoutMs?: number;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * Wait for the user to approve, then complete the standard exchange — except
 * the server itself hands over the PKCE pair to use, and the redirect is the
 * device callback rather than a local port.
 */
export async function completeChatGptDeviceLogin(
	options: CompleteChatGptDeviceLoginOptions,
): Promise<ChatGptOAuthCredential> {
	const pollUrl = `${CHATGPT_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
	const deadline = Date.now() + (options.timeoutMs ?? DEVICE_POLL_TIMEOUT_MS);
	for (;;) {
		options.signal?.throwIfAborted();
		const response = await sendRequest(
			pollUrl,
			{
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ device_auth_id: options.deviceAuthId, user_code: options.userCode }),
			},
			options,
		);
		if (response.ok) {
			const detail = await readDetail(response);
			const authorizationCode = typeof detail.authorization_code === "string" ? detail.authorization_code : "";
			const codeChallenge = typeof detail.code_challenge === "string" ? detail.code_challenge : "";
			const codeVerifier = typeof detail.code_verifier === "string" ? detail.code_verifier : "";
			if (authorizationCode === "" || codeChallenge === "" || codeVerifier === "") {
				throw new ChatGptOAuthError("Device sign-in answered without a completed grant.");
			}
			return exchangeChatGptCode({
				code: authorizationCode,
				codeVerifier,
				redirectUri: `${CHATGPT_OAUTH_ISSUER}/deviceauth/callback`,
				clientId: options.clientId,
				fetch: options.fetch,
				now: options.now,
				signal: options.signal,
			});
		}
		// 403 and 404 both mean "not approved yet" on this endpoint.
		if (response.status !== 403 && response.status !== 404) {
			throw new ChatGptOAuthError(`Device sign-in failed (${response.status}): ${response.statusText}`);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new ChatGptOAuthError("Device sign-in timed out.");
		await sleep(Math.min(options.intervalMs, remaining), options.signal);
	}
}
