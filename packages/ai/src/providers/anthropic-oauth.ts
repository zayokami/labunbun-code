// Long-form design notes: docs/dev/ai-layer.md
/**
 * The Claude subscription OAuth wire, in three pieces: the login handshake
 * (PKCE, the authorize URL, the code-for-token exchange), the refresh grant,
 * and the token provider the streaming client consumes.
 *
 * Endpoints, scopes, and request shapes are the ones Claude Code 2.1.289
 * speaks — this is a reference implementation of that wire. The beta header
 * that marks a bearer request is added by the SDK's credentials path; the
 * streaming adapter adds it per request too, so the header is testable at
 * this layer rather than assumed inside the SDK.
 */

import { createHash, randomBytes } from "node:crypto";

// Long-form design notes: docs/dev/ai-layer.md
/** Where a subscription sign-in starts. The Console door is not this one. */
export const CLAUDE_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";

/** The one endpoint that turns a code or a refresh token into tokens. */
export const CLAUDE_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/** The id Claude Code's own logins carry; the host answers no other door. */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** The paste-the-code redirect, for a sign-in that has no local server. */
export const CLAUDE_OAUTH_MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";

/** What a subscription login asks for; `user:inference` is the load-bearing one. */
export const CLAUDE_OAUTH_SCOPES = [
	"user:profile",
	"user:inference",
	"user:sessions:claude_code",
	"user:mcp_servers",
	"user:file_upload",
];

/** Refresh when this close to expiry: the same five minutes Claude Code keeps. */
export const CLAUDE_REFRESH_WINDOW_MS = 300_000;

/** The exchange gets its own deadline; the wire itself is a single POST. */
const TOKEN_TIMEOUT_MS = 30_000;

/** Refresh-token lifetime when a refresh response does not state one: 30 days. */
const REFRESH_TOKEN_FALLBACK_MS = 2_592_000_000;

// Long-form design notes: docs/dev/ai-layer.md
/** A failure on the login wire, with the one distinction the caller acts on. */
export class ClaudeOAuthError extends Error {
	/**
	 * True when trying again cannot repair the session — the grant is dead or
	 * absent and the user has to sign in — as opposed to the token endpoint
	 * merely being unhappy right now. The retry ladder reads it to fail fast
	 * instead of keeping "run /login" off the screen for two minutes.
	 */
	readonly invalidGrant: boolean;

	constructor(message: string, options: { invalidGrant?: boolean } = {}) {
		super(message);
		this.name = "ClaudeOAuthError";
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
/** A PKCE pair: 32 random bytes and their SHA-256, both as base64url. */
export function createPkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** The `state` that ties the callback to this sign-in, 32 random bytes. */
export function createOAuthState(): string {
	return base64url(randomBytes(32));
}

export interface ClaudeAuthorizeOptions {
	redirectUri: string;
	state: string;
	codeChallenge: string;
	scopes?: string[];
	/** Pre-fills the account field on the sign-in page. */
	loginHint?: string;
}

// Long-form design notes: docs/dev/ai-layer.md
/** The URL a browser opens to sign in, parameters in the console's order. */
export function claudeAuthorizeUrl(options: ClaudeAuthorizeOptions): string {
	const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
	// The order below is the one the console emits its own links in. The host
	// does not require it; a fixed order is what makes the URL testable.
	url.searchParams.set("code", "true");
	url.searchParams.set("client_id", CLAUDE_OAUTH_CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", options.redirectUri);
	url.searchParams.set("scope", (options.scopes ?? CLAUDE_OAUTH_SCOPES).join(" "));
	url.searchParams.set("code_challenge", options.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", options.state);
	if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
	return url.toString();
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The code a user pastes back from the manual redirect: `code#state`, the
 * shape the success page shows. Answers `undefined` for an empty paste.
 */
export function parseClaudeAuthorizationInput(text: string): { code: string; state?: string } | undefined {
	const trimmed = text.trim();
	if (trimmed === "") return undefined;
	const [code, state] = trimmed.split("#");
	if (!code) return undefined;
	return state ? { code, state } : { code };
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/ai-layer.md
/**
 * What a completed grant stores.
 *
 * Times are epoch milliseconds (`null` = the endpoint stated none, which for
 * the access token means it does not expire). `refreshTokenExpiresAt` is
 * informational: refresh is attempted until the endpoint says the grant is
 * dead, because a clock is a worse judge of that than the issuer.
 */
export interface ClaudeOAuthCredential {
	accessToken: string;
	refreshToken: string;
	expiresAt: number | null;
	refreshTokenExpiresAt: number | null;
	scopes: string[];
	clientId: string;
	/** Shown at login so the user can see which account is signed in. */
	accountEmail?: string;
}

interface TokenWireOptions {
	fetch?: typeof fetch;
	/** Injectable clock, for tests; all wire times derive from it. */
	now?: number;
	signal?: AbortSignal;
}

async function postToken(
	body: Record<string, unknown>,
	options: TokenWireOptions,
	failure: (status: number, statusText: string, detail: Record<string, unknown>) => Error,
): Promise<Record<string, unknown>> {
	const doFetch = options.fetch ?? fetch;
	const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await doFetch(CLAUDE_OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			throw new ClaudeOAuthError(`Token endpoint did not answer within ${TOKEN_TIMEOUT_MS / 1000}s.`);
		}
		throw error;
	}
	const text = await response.text();
	let detail: Record<string, unknown> = {};
	try {
		detail = text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		// A non-JSON body is only ever consulted for error text, and "" reads
		// better than a parse failure about a body nobody can see.
		detail = {};
	}
	if (!response.ok) throw failure(response.status, response.statusText, detail);
	return detail;
}

/**
 * Whether an error body says the grant itself is dead (as opposed to the
 * endpoint being briefly unhappy). The server's word list, plus the OAuth
 * standard's own.
 */
function isDeadGrant(detail: Record<string, unknown>): boolean {
	const error = typeof detail.error === "string" ? detail.error : "";
	const description = typeof detail.error_description === "string" ? detail.error_description : "";
	return error === "invalid_grant" || /refresh_token_(expired|reused|invalidated)/.test(`${error} ${description}`);
}

function credentialFromTokenResponse(
	parsed: Record<string, unknown>,
	context: { now: number; clientId: string; previous?: ClaudeOAuthCredential },
): ClaudeOAuthCredential {
	const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
	if (accessToken === "") throw new ClaudeOAuthError("Token endpoint answered without an access token.");
	const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : undefined;
	const refreshExpiresIn =
		typeof parsed.refresh_token_expires_in === "number" ? parsed.refresh_token_expires_in : undefined;
	const scope = typeof parsed.scope === "string" && parsed.scope.length > 0 ? parsed.scope.split(" ") : undefined;
	const account = parsed.account as { email_address?: unknown } | undefined;
	const email = typeof account?.email_address === "string" ? account.email_address : context.previous?.accountEmail;
	const previous = context.previous;
	return {
		accessToken,
		refreshToken:
			typeof parsed.refresh_token === "string" && parsed.refresh_token !== ""
				? parsed.refresh_token
				: (previous?.refreshToken ?? ""),
		expiresAt: expiresIn !== undefined ? context.now + expiresIn * 1000 : (previous?.expiresAt ?? null),
		refreshTokenExpiresAt:
			refreshExpiresIn !== undefined
				? context.now + refreshExpiresIn * 1000
				: (previous?.refreshTokenExpiresAt ?? (previous ? context.now + REFRESH_TOKEN_FALLBACK_MS : null)),
		scopes: scope ?? previous?.scopes ?? [],
		clientId: previous?.clientId ?? context.clientId,
		...(email !== undefined ? { accountEmail: email } : {}),
	};
}

export interface ExchangeClaudeCodeOptions extends TokenWireOptions {
	code: string;
	state?: string;
	codeVerifier: string;
	redirectUri: string;
	clientId?: string;
}

// Long-form design notes: docs/dev/ai-layer.md
/** Turn an authorization code into the tokens a login stores. */
export async function exchangeClaudeCode(options: ExchangeClaudeCodeOptions): Promise<ClaudeOAuthCredential> {
	const body: Record<string, unknown> = {
		grant_type: "authorization_code",
		code: options.code,
		redirect_uri: options.redirectUri,
		client_id: options.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
		code_verifier: options.codeVerifier,
	};
	if (options.state !== undefined) body.state = options.state;
	const parsed = await postToken(body, options, (status, statusText) =>
		status === 401
			? new ClaudeOAuthError("Authentication failed: Invalid authorization code", { invalidGrant: true })
			: new ClaudeOAuthError(`Token exchange failed (${status}): ${statusText}`),
	);
	return credentialFromTokenResponse(parsed, {
		now: options.now ?? Date.now(),
		clientId: options.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
	});
}

export interface RefreshClaudeTokenOptions extends TokenWireOptions {
	refreshToken: string;
	scopes?: string[];
	clientId?: string;
}

// Long-form design notes: docs/dev/ai-layer.md
/** Trade a refresh token for a fresh access token, and often a fresh refresh token. */
export async function refreshClaudeToken(options: RefreshClaudeTokenOptions): Promise<ClaudeOAuthCredential> {
	const previous: ClaudeOAuthCredential = {
		accessToken: "",
		refreshToken: options.refreshToken,
		expiresAt: null,
		refreshTokenExpiresAt: null,
		scopes: options.scopes ?? [],
		clientId: options.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
	};
	const body: Record<string, unknown> = {
		grant_type: "refresh_token",
		refresh_token: options.refreshToken,
		client_id: options.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
	};
	if (options.scopes && options.scopes.length > 0) body.scope = options.scopes.join(" ");
	const parsed = await postToken(body, options, (status, statusText, detail) =>
		isDeadGrant(detail)
			? new ClaudeOAuthError("The Claude subscription session is no longer valid: run /login again.", {
					invalidGrant: true,
				})
			: new ClaudeOAuthError(`Token refresh failed (${status}): ${statusText}`),
	);
	return credentialFromTokenResponse(parsed, {
		now: options.now ?? Date.now(),
		clientId: options.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
		previous,
	});
}

// Long-form design notes: docs/dev/ai-layer.md
/** Whether an access token is due for a refresh at `now`. */
export function claudeRefreshDue(expiresAt: number | null, now: number, windowMs = CLAUDE_REFRESH_WINDOW_MS): boolean {
	return expiresAt !== null && now + windowMs >= expiresAt;
}

// ---------------------------------------------------------------------------
// The token provider
// ---------------------------------------------------------------------------

/** Where a login lives between runs; the app layer owns the file. */
export interface ClaudeCredentialStore {
	load(): Promise<ClaudeOAuthCredential | null>;
	save(credential: ClaudeOAuthCredential): Promise<void>;
	clear(): Promise<void>;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * The SDK's `AccessTokenProvider` contract, structurally: called per request
 * through the client's own token cache, `forceRefresh` bypassing the
 * freshness window after a 401. `available()` is this layer's addition — it
 * is what decides between the subscription path and the api-key path before
 * a request is built.
 */
export interface ClaudeTokenProvider {
	(options?: { forceRefresh?: boolean }): Promise<{ token: string; expiresAt: number | null }>;
	available(): Promise<boolean>;
}

export interface ClaudeTokenProviderOptions {
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
export function createClaudeTokenProvider(
	store: ClaudeCredentialStore,
	options: ClaudeTokenProviderOptions = {},
): ClaudeTokenProvider {
	const clock = options.now ?? Date.now;
	const fallbackClientId = options.clientId ?? CLAUDE_OAUTH_CLIENT_ID;
	let inflight: Promise<{ token: string; expiresAt: number | null }> | null = null;
	let inflightForced = false;

	async function mint(force: boolean): Promise<{ token: string; expiresAt: number | null }> {
		const credential = await store.load();
		if (!credential || (credential.accessToken === "" && credential.refreshToken === "")) {
			throw new ClaudeOAuthError("Not signed in to a Claude subscription: run /login.", { invalidGrant: true });
		}
		const now = clock();
		if (!force && !claudeRefreshDue(credential.expiresAt, now)) {
			return {
				token: credential.accessToken,
				expiresAt: credential.expiresAt === null ? null : Math.floor(credential.expiresAt / 1000),
			};
		}
		if (credential.refreshToken === "") {
			await store.clear();
			throw new ClaudeOAuthError("The Claude subscription session expired and cannot refresh: run /login again.", {
				invalidGrant: true,
			});
		}
		let refreshed: ClaudeOAuthCredential;
		try {
			refreshed = await refreshClaudeToken({
				refreshToken: credential.refreshToken,
				scopes: credential.scopes,
				clientId: credential.clientId || fallbackClientId,
				fetch: options.fetch,
				signal: options.signal,
				now,
			});
		} catch (error) {
			// Only a dead grant empties the store; an endpoint having a bad day
			// must not cost the user their login.
			if (error instanceof ClaudeOAuthError && error.invalidGrant) await store.clear();
			throw error;
		}
		await store.save(refreshed);
		return {
			token: refreshed.accessToken,
			expiresAt: refreshed.expiresAt === null ? null : Math.floor(refreshed.expiresAt / 1000),
		};
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
	}) as ClaudeTokenProvider;

	provider.available = async () => {
		const credential = await store.load();
		// The same emptiness `mint` refuses to serve: a store holding the dead
		// token's husk must not advertise a subscription the next request cannot
		// use — the api-key path is the honest answer.
		if (!credential || (credential.accessToken === "" && credential.refreshToken === "")) return false;
		if (credential.refreshToken !== "") return true;
		return !claudeRefreshDue(credential.expiresAt, clock());
	};
	return provider;
}
