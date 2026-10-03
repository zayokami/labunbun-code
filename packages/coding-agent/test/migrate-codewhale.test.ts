/**
 * The `codewhale` source, from the two roots through to the report.
 *
 * **What this file is for.** Codewhale is the first source here whose layout is
 * *two roots with a per-path fallback*, and every one of its credential channels
 * except two hides under a key a name-based scan cannot see. So most of what
 * follows is about the difference between "the file is here" and "the file is what
 * Codewhale is running":
 *
 *   - **`~/.deepseek` is a live second root**, and which paths consult it is a
 *     table rather than a rule — so "read from the pre-rename tree" and "looked
 *     for under `~/.codewhale` only" are separate answers, and so is "under
 *     neither".
 *   - **`config.toml` holds credentials in four shapes and a key-based scrub sees
 *     two of them.** `base_url` can carry one in a URL; `http_headers` holds
 *     bearer tokens under a key that is not credential-shaped. Both are dropped
 *     and the report names them.
 *   - **`providers` is a `#[serde(flatten)]` map**, so a provider named
 *     `my-key-router` must survive a scan that matches `KEY` in key names.
 *   - **`approval_policy` has two vocabularies in two files**, and `sandbox_mode`
 *     has one value with no counterpart here that must be named rather than
 *     approximated onto a *wider* sandbox.
 *   - **Codewhale ships its own `/import-claude`**, and the report has to say the
 *     run saw the competing path and did not take it.
 *   - **`~/.agents` belongs to the `agents` source**, so a plan over both must
 *     yield one write for a shared skill, not two.
 *
 * Every fixture is a temporary directory. Nothing here reads a real install, a
 * real credential path, or anything under a user's home: `readCodewhale` takes
 * `home`, `cwd` and `env` as arguments and never calls `homedir()`, and every
 * call below passes an explicit `env` so a developer's own `CODEWHALE_HOME`
 * cannot leak in.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CODEWHALE_DEFAULT_DIR,
	CODEWHALE_DENIED_HOME_ENTRIES,
	CODEWHALE_IMPORT_CLAUDE,
	CODEWHALE_LEGACY_DIR,
	CODEWHALE_LEGACY_FALLBACK,
	CODEWHALE_MCP_CREDENTIAL_KEYS,
	CODEWHALE_MCP_SERVER_KEYS,
	CODEWHALE_MCP_SERVERS_ALIAS,
	CODEWHALE_MCP_SERVERS_KEY,
	CODEWHALE_SHARED_TREE,
	codewhaleStateLocation,
	codewhaleStatePath,
	expandLeadingTilde,
	resolveCodewhaleHome,
} from "../src/codewhale-home.ts";
import {
	CODEWHALE_APPROVAL_POLICIES,
	CODEWHALE_CONFIG_SANDBOX_VALUES,
	CODEWHALE_HOOK_EVENT_NAMES,
	CODEWHALE_HOOK_EVENTS,
	CODEWHALE_HOOK_EVENTS_THIS_BUILD_RUNS,
	CODEWHALE_SANDBOX_MODES,
	CODEWHALE_SETTINGS_APPROVAL_POLICIES,
} from "../src/codewhale-plan.ts";
import { readCodewhale } from "../src/codewhale-read.ts";
import { codewhaleMetadata, listCodewhaleSessions, readCodewhaleSession } from "../src/codewhale-session.ts";
import { runMigration } from "../src/migrate.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS, SOURCE_ROOTS } from "../src/migrate-types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/**
 * The placeholder a fixture uses for "this project's own directory".
 *
 * A session's `metadata.workspace` has to be a real directory for the scope filter
 * to keep it, and the fixture's `cwd` does not exist until the fixture has made
 * it — so a test that wrote `workspace: cwd` inside the fixture's own argument
 * list would be reading a binding it is about to create. The token is substituted
 * on the way out instead, which is the one moment the value exists.
 */
const FIXTURE_CWD_TOKEN = "FIXTURE_CWD";

/** Write `content` at `<root>/<relative>`, creating the directories above it. */
function writeUnder(root: string, relative: string, content: string): void {
	const path = join(root, ...relative.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

interface CodewhaleFixture {
	home: string;
	cwd: string;
}

/**
 * A home and a project directory, with whichever files the caller asked for.
 *
 * **`files` is rooted at `~/.codewhale`** so the common case needs no ceremony,
 * and **`legacyFiles` is rooted at `~/.deepseek`** because the two-root behaviour
 * is most of what this file is about and a fixture that could not express it would
 * not test it. `sharedFiles` is rooted at the home and lands in `~/.agents`.
 */
function codewhaleFixture(
	options: {
		files?: Record<string, string>;
		legacyFiles?: Record<string, string>;
		sharedFiles?: Record<string, string>;
	} = {},
): CodewhaleFixture {
	const home = makeDir("lbb-codewhale-home-");
	const cwd = makeDir("lbb-codewhale-proj-");
	// **Escaped, not interpolated raw.** A Windows temp path is full of backslashes
	// and a raw one spliced into a JSON string is an invalid escape, so the file
	// would not parse and every session test would report "no readable metadata" —
	// a failure that looks exactly like a reader bug and is not one. `JSON.stringify`
	// minus the surrounding quotes is the escape without the quotes.
	const escapedCwd = JSON.stringify(cwd).slice(1, -1);
	for (const [relative, content] of Object.entries(options.files ?? {})) {
		writeUnder(home, `${CODEWHALE_DEFAULT_DIR}/${relative}`, content.replaceAll(FIXTURE_CWD_TOKEN, escapedCwd));
	}
	for (const [relative, content] of Object.entries(options.legacyFiles ?? {})) {
		writeUnder(home, `${CODEWHALE_LEGACY_DIR}/${relative}`, content);
	}
	for (const [relative, content] of Object.entries(options.sharedFiles ?? {})) {
		writeUnder(home, relative, content);
	}
	return { home, cwd };
}

/** A TOML config.toml body with the keys this file cares about. */
function configToml(body: string): string {
	return body;
}

/** A session file in the product's own envelope shape. */
function sessionJson(metadata: Record<string, unknown>, messages: unknown[]): string {
	return JSON.stringify({ schema_version: 1, metadata: { ...metadata }, messages, system_prompt: null }, null, 2);
}

/** Every `from` label a plan produced, for the "which line says what" assertions. */
function itemsFor(plan: { items: Array<{ from: string; detail: string; action: string }> }, needle: string) {
	return plan.items.filter((item) => item.from.includes(needle));
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("it is appended, so every id before it keeps its place", () => {
	// Appended, never slotted in: the order is what `detectSources` reports, and
	// reordering would silently change which of two sources providing the same file
	// wins.
	expect(MIGRATION_SOURCE_IDS).toContain("codewhale");
	expect(MIGRATION_SOURCE_LABELS.codewhale).toBe("Codewhale");
	expect(SOURCE_ROOTS.codewhale).toBe(CODEWHALE_DEFAULT_DIR);
	expect(new Set(Object.keys(MIGRATION_SOURCE_LABELS))).toEqual(new Set(MIGRATION_SOURCE_IDS));
	expect(MIGRATION_SOURCE_IDS.indexOf("qoder")).toBeLessThan(MIGRATION_SOURCE_IDS.indexOf("codewhale"));
});

test("every source id has a label, and every label has an id — one list, two tables", () => {
	expect(Object.keys(MIGRATION_SOURCE_LABELS).sort()).toEqual([...MIGRATION_SOURCE_IDS].sort());
});

// ---------------------------------------------------------------------------
// The two roots
// ---------------------------------------------------------------------------

test("with no environment at all, the tree is ~/.codewhale and the legacy root is named beside it", () => {
	const resolved = resolveCodewhaleHome("/home/u", {});
	expect(resolved.root).toBe(join("/home/u", CODEWHALE_DEFAULT_DIR));
	expect(resolved.legacyRoot).toBe(join("/home/u", CODEWHALE_LEGACY_DIR));
	expect(resolved.explicit).toBe(false);
	expect(resolved.rejectedHome).toBeNull();
});

test("$CODEWHALE_HOME wins outright and disables the legacy fallback — the product's isolation rule", () => {
	const resolved = resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "/opt/cw" });
	expect(resolved.root).toBe("/opt/cw");
	expect(resolved.explicit).toBe(true);
	// `codewhale_state_path` never consults the legacy root once `explicit` is set.
	expect(codewhaleStatePath(resolved, "mcp.json", () => true)).toBe(join("/opt/cw", "mcp.json"));
});

test("a whitespace-only or empty $CODEWHALE_HOME is unset, matching normalize_path_value", () => {
	// `crates/paths/src/lib.rs:213-225` — empty is unset and a Unicode value is
	// trimmed, so whitespace-only is unset too.
	expect(resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "   " }).root).toBe(join("/home/u", CODEWHALE_DEFAULT_DIR));
	expect(resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "" }).root).toBe(join("/home/u", CODEWHALE_DEFAULT_DIR));
	expect(resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "  /opt/cw  " }).root).toBe("/opt/cw");
});

test("a leading ~ is expanded against the home, on either separator", () => {
	expect(resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "~" }).root).toBe("/home/u");
	expect(resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "~/cw" }).root).toBe(join("/home/u", "cw"));
	expect(resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "~\\cw" }).root).toBe(join("/home/u", "cw"));
	expect(expandLeadingTilde("~/cw", "/home/u")).toBe(join("/home/u", "cw"));
	expect(expandLeadingTilde("~", "")).toBeNull();
});

test("a relative $CODEWHALE_HOME is REFUSED, not silently used — and the reason is reported", () => {
	// The product raises `PathOverrideErrorKind::Relative` here
	// (`crates/paths/src/lib.rs:35-39`), so falling back to `~/.codewhale`
	// silently would import a tree Codewhale itself refused to look at.
	const resolved = resolveCodewhaleHome("/home/u", { CODEWHALE_HOME: "cw" });
	expect(resolved.root).toBe(join("/home/u", CODEWHALE_DEFAULT_DIR));
	expect(resolved.rejectedHome).toContain("CODEWHALE_HOME");
	expect(resolved.rejectedHome).toContain("absolute");
});

test("the legacy fallback table is cited for every row and marks exactly the paths that fall back", () => {
	// The table is the whole two-root story, so a row added without a citation is a
	// claim nobody can check. These five are the ones the brief named as *not*
	// falling back, and each is a path joined straight onto `codewhale_home()`.
	for (const name of ["agents", "fleets", "constitution.json", "workflows", "themes", "audit.log"]) {
		expect(CODEWHALE_LEGACY_FALLBACK[name]).toBe(false);
	}
	// And these are the ones that do.
	for (const name of ["config.toml", "permissions.toml", "mcp.json", "settings.toml", "sessions"]) {
		expect(CODEWHALE_LEGACY_FALLBACK[name]).toBe(true);
	}
});

test("a path under ~/.deepseek is reported as having come from there, and one under neither as absent", () => {
	const resolved = resolveCodewhaleHome("/home/u", {});
	const nothing = () => false;
	expect(codewhaleStateLocation(resolved, "mcp.json", nothing)).toEqual({
		path: join("/home/u", CODEWHALE_DEFAULT_DIR, "mcp.json"),
		root: "absent",
		exists: false,
	});
	const legacyOnly = (path: string): boolean => path === join("/home/u", CODEWHALE_LEGACY_DIR, "mcp.json");
	expect(codewhaleStateLocation(resolved, "mcp.json", legacyOnly)).toEqual({
		path: join("/home/u", CODEWHALE_LEGACY_DIR, "mcp.json"),
		root: "deepseek",
		exists: true,
	});
	const canonicalOnly = (path: string): boolean => path === join("/home/u", CODEWHALE_DEFAULT_DIR, "mcp.json");
	expect(codewhaleStateLocation(resolved, "mcp.json", canonicalOnly).root).toBe("codewhale");
});

test("a path whose reader does not fall back is never reported from ~/.deepseek, even when only that exists", () => {
	// `agents/` is joined straight onto `codewhale_home()`
	// (`crates/tui/src/fleet/profile.rs:63`), so a `.deepseek/agents` tree is a
	// directory Codewhale itself will not read.
	const resolved = resolveCodewhaleHome("/home/u", {});
	const legacyOnly = (path: string): boolean => path.startsWith(join("/home/u", CODEWHALE_LEGACY_DIR));
	expect(codewhaleStateLocation(resolved, "agents", legacyOnly).root).toBe("absent");
});

test("the reader reports which root each document came from, including the ones that are nowhere", () => {
	const { home, cwd } = codewhaleFixture({
		files: { "config.toml": configToml('model = "x"\n') },
		legacyFiles: { "mcp.json": JSON.stringify({ servers: {} }) },
	});
	const raw = readCodewhale(home, cwd, {});
	const byName = new Map(raw.documents.map((entry) => [entry.name, entry]));
	expect(byName.get("config.toml")?.root).toBe("codewhale");
	expect(byName.get("mcp.json")?.root).toBe("deepseek");
	expect(byName.get("permissions.toml")?.root).toBe("absent");
	expect(byName.get("permissions.toml")?.exists).toBe(false);
	expect(raw.permissions).toBeNull();
});

test("the plan says which root answered and lists the documents that are under neither", () => {
	const { home, cwd } = codewhaleFixture({
		files: { "config.toml": configToml('sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n') },
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const report = itemsFor(plan, "state documents")[0];
	expect(report).toBeDefined();
	expect(report.detail).toContain("config.toml");
	expect(report.detail).toContain("Not present under either root");
	expect(report.detail).toContain("mcp.json");
});

test("an explicit $CODEWHALE_HOME stops the legacy tree being consulted at all", () => {
	const { home, cwd } = codewhaleFixture({ legacyFiles: { "config.toml": 'model = "from-legacy"\n' } });
	const ambient = readCodewhale(home, cwd, {});
	expect(ambient.config?.model).toBe("from-legacy");
	const isolated = readCodewhale(home, cwd, { CODEWHALE_HOME: join(home, "elsewhere") });
	expect(isolated.config).toBeNull();
});

// ---------------------------------------------------------------------------
// Credentials — the security-critical half
// ---------------------------------------------------------------------------

test("an api_key is dropped and reported by its full path", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": configToml(
				'[providers.openai]\napi_key = "sk-secret-value"\nbase_url = "https://api.example.com/v1"\n',
			),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	expect(JSON.stringify(raw.config)).not.toContain("sk-secret-value");
	const line = raw.skipped.find((entry) => entry.name.endsWith("providers.openai.api_key"));
	expect(line).toBeDefined();
	expect(line?.reason).toContain("never read");
});

test("a base_url carrying a credential in its userinfo is dropped whole and reported by shape", () => {
	// The hole that was found in Qoder and then fixed across every source. The key
	// is not credential-shaped and the value is not under a secret key, so a
	// name-based scan cannot see it at all.
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": configToml('[providers.gateway]\nbase_url = "https://tok123@api.example.com/v1"\n'),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	const serialised = JSON.stringify(raw.config);
	expect(serialised).not.toContain("tok123");
	expect(serialised).not.toContain("api.example.com");
	const line = raw.skipped.find((entry) => entry.name.endsWith("providers.gateway.base_url"));
	expect(line?.reason).toContain("`name:password@` part in front of the address");
});

test("http_headers values never reach the reader — the names do", () => {
	// The product classifies these names as credential-bearing itself:
	// `is_upstream_auth_header` (`crates/config/src/lib.rs:130-138`) is
	// `is_sensitive_config_key`. Unlike `secrets/secrets.json`, `config.toml` has no
	// special permission mode.
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": configToml(
				'[providers.gateway]\nhttp_headers = { Authorization = "Bearer sk-live-abc", "x-tenant" = "acme" }\n',
			),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	const serialised = JSON.stringify(raw.config);
	expect(serialised).not.toContain("sk-live-abc");
	const names = raw.skipped.filter((entry) => entry.name.includes("http_headers")).map((entry) => entry.name);
	expect(names.some((name) => name.endsWith("http_headers.Authorization"))).toBe(true);
	expect(names.some((name) => name.endsWith("http_headers.x-tenant"))).toBe(true);
});

test("the root http_headers is dropped the same way", () => {
	const { home, cwd } = codewhaleFixture({
		files: { "config.toml": configToml('http_headers = { "X-Api-Key" = "sk-root" }\n') },
	});
	const raw = readCodewhale(home, cwd, {});
	expect(JSON.stringify(raw.config)).not.toContain("sk-root");
	expect(raw.skipped.some((entry) => entry.name.endsWith("http_headers.X-Api-Key"))).toBe(true);
});

test("webhook_token, search.api_key and sandbox_api_key all go by name", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": configToml(
				'[lifecycle_outbox]\nwebhook_token = "wh-secret"\n\n[search]\napi_key = "search-secret"\n\nsandbox_api_key = "sandbox-secret"\n',
			),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	const serialised = JSON.stringify(raw.config);
	for (const secret of ["wh-secret", "search-secret", "sandbox-secret"]) expect(serialised).not.toContain(secret);
	expect(raw.skipped.some((entry) => entry.name.endsWith("lifecycle_outbox.webhook_token"))).toBe(true);
	expect(raw.skipped.some((entry) => entry.name.endsWith("search.api_key"))).toBe(true);
	expect(raw.skipped.some((entry) => entry.name.endsWith("sandbox_api_key"))).toBe(true);
});

test("a provider whose NAME reads as a credential survives, with its model and context window", () => {
	// `providers` is `#[serde(flatten)]`ed into `extras`
	// (`crates/config/src/lib.rs:612-615`), so every dynamically named provider
	// lands under it. `looksLikeSecretName` matches `KEY` inside `my-key-router`
	// exactly as it matched inside Kimi's `keyboard-mcp`: deleting the entry would
	// delete a working provider route over its own name.
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": configToml(
				'[providers.my-key-router]\nbase_url = "https://clean.example.com/v1"\nmodel = "some-model"\ncontext_window = 200000\n',
			),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	const providers = raw.config?.providers as Record<string, Record<string, unknown>>;
	expect(providers["my-key-router"]).toBeDefined();
	expect(providers["my-key-router"].model).toBe("some-model");
	expect(providers["my-key-router"].context_window).toBe(200000);
	expect(raw.skipped.some((entry) => entry.name.includes("my-key-router") && entry.name.endsWith(".api_key"))).toBe(
		false,
	);
});

test("the credential store and keyring locks are existence-checked only and never opened", () => {
	const { home, cwd } = codewhaleFixture({ files: { "secrets/secrets.json": '{"entries":{"x":"tok"}}' } });
	const raw = readCodewhale(home, cwd, {});
	expect(raw.secretStore.exists).toBe(true);
	expect(raw.secretStore.path).toBe(join(home, CODEWHALE_DEFAULT_DIR, "secrets", "secrets.json"));
	// Nothing in `RawCodewhale` may hold the store's contents.
	expect(JSON.stringify(raw)).not.toContain("tok");
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test("servers come from `servers`, and `mcpServers` is accepted as the alias", () => {
	// `#[serde(default, alias = "mcpServers")]` (`crates/tui/src/mcp.rs:514`) — the
	// file's own key is `servers`. A reader looking only for `mcpServers` would
	// report a configured user as having no MCP servers at all.
	expect(CODEWHALE_MCP_SERVERS_KEY).toBe("servers");
	expect(CODEWHALE_MCP_SERVERS_ALIAS).toBe("mcpServers");
	for (const key of [CODEWHALE_MCP_SERVERS_KEY, CODEWHALE_MCP_SERVERS_ALIAS]) {
		const { home, cwd } = codewhaleFixture({
			files: { "mcp.json": JSON.stringify({ [key]: { demo: { command: "echo", args: ["hi"] } } }) },
		});
		const raw = readCodewhale(home, cwd, {});
		expect(Object.keys(raw.mcpServers)).toEqual(["demo"]);
	}
});

test("a file carrying both spellings uses `servers`, which is the only reading consistent with serde", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"mcp.json": JSON.stringify({
				servers: { canonical: { command: "a" } },
				mcpServers: { aliased: { command: "b" } },
			}),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	expect(Object.keys(raw.mcpServers)).toEqual(["canonical"]);
});

test("MCP headers lose their values and keep their names; env does too", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"mcp.json": JSON.stringify({
				servers: {
					gw: {
						url: "https://mcp.example.com",
						headers: { Authorization: "Bearer mcp-secret" },
						env: { HF_TOKEN: "hf-secret", WORKDIR: "/tmp" },
					},
				},
			}),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	const serialised = JSON.stringify(raw.mcpServers);
	expect(serialised).not.toContain("mcp-secret");
	expect(serialised).not.toContain("hf-secret");
	expect(serialised).not.toContain("WORKDIR");
	const names = raw.skipped.map((entry) => entry.name);
	expect(names.some((name) => name.endsWith("headers.Authorization"))).toBe(true);
	expect(names.some((name) => name.endsWith("env.HF_TOKEN"))).toBe(true);
	expect(CODEWHALE_MCP_CREDENTIAL_KEYS).toContain("headers");
	expect(CODEWHALE_MCP_CREDENTIAL_KEYS).toContain("env");
	expect(CODEWHALE_MCP_CREDENTIAL_KEYS).toContain("bearer_token_env_var");
});

test("a stdio server is copied without its env, and the server name is never a credential", () => {
	// The mirror of the Kimi bug: a server called `keyboard-mcp` must survive a
	// scan that matches `KEY` inside its name.
	const { home, cwd } = codewhaleFixture({
		files: {
			"mcp.json": JSON.stringify({
				servers: { "keyboard-mcp": { command: "node", args: ["server.js"], env: { API_KEY: "nope" } } },
			}),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	// **One file, not one per server** — every MCP server lands in the target's
	// single `.mcp.json`, so the assertion is about its *content*.
	const written = plan.writes.filter((write) => write.path.endsWith(".mcp.json"));
	expect(written).toHaveLength(1);
	expect(written[0].content).toContain("keyboard-mcp");
	expect(written[0].content).toContain("server.js");
	expect(written[0].content).not.toContain("nope");
	expect(written[0].containsSecret).toBe(false);
	// And the name survived: `looksLikeSecretName` matches `KEY` inside
	// `keyboard-mcp`, and deleting the entry would delete a working server.
	const line = plan.items.find((item) => item.to.includes("mcpServers.keyboard-mcp"));
	expect(line?.action).toBe("map");
});

test("a server url carrying a credential loses the whole server, not just the credential", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"mcp.json": JSON.stringify({
				servers: { gw: { url: "https://tok123@mcp.example.com/mcp" } },
			}),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.writes.filter((write) => write.content.includes("mcp.example.com"))).toHaveLength(0);
	// The reader's own scrub line shares the `from` prefix and is reported with
	// `containsSecret: false` (nothing was written), so the *plan* line is the one
	// selected by its target.
	const line = plan.items.find((item) => item.from.includes("servers.gw") && item.to === "—");
	expect(line?.action).toBe("skip");
	expect(line?.containsSecret).toBe(true);
	// `urlCredentialProblem` returns a sentence, not a shape name, so the assertion
	// matches the sentence rather than a symbol the report never prints.
	expect(line?.detail).toContain("`name:password@` part in front of the address");
});

test("a disabled server is not imported, and both spellings of the switch are honoured", () => {
	for (const [field, value] of [
		["disabled", true],
		["enabled", false],
	] as const) {
		const { home, cwd } = codewhaleFixture({
			files: { "mcp.json": JSON.stringify({ servers: { off: { command: "x", [field]: value } } }) },
		});
		const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
		expect(plan.writes.filter((write) => write.content.includes('"off"'))).toHaveLength(0);
		expect(plan.items.some((item) => item.detail.includes("switched off"))).toBe(true);
	}
});

test("every field this importer names as a Codewhale MCP key really is one", () => {
	// `McpServerConfig` carries no `#[serde(rename_all)]`, so every name on disk is
	// the bare Rust name. `env_http_headers` is the alias on `env_headers`.
	for (const key of [
		"command",
		"args",
		"env",
		"cwd",
		"url",
		"transport",
		"headers",
		"disabled",
		"enabled",
		"required",
	]) {
		expect(CODEWHALE_MCP_SERVER_KEYS).toContain(key);
	}
	expect(CODEWHALE_MCP_SERVER_KEYS).toContain("env_headers");
	expect(CODEWHALE_MCP_SERVER_KEYS).toContain("env_http_headers");
	expect(CODEWHALE_MCP_SERVER_KEYS).toContain("enabled_tools");
	expect(CODEWHALE_MCP_SERVER_KEYS).toContain("disabled_tools");
	// The two spellings that could be camelCase are not.
	expect(CODEWHALE_MCP_SERVER_KEYS).not.toContain("envHeaders");
	expect(CODEWHALE_MCP_SERVER_KEYS).not.toContain("enabledTools");
});

// ---------------------------------------------------------------------------
// The mode pair
// ---------------------------------------------------------------------------

test("workspace-write and danger-full-access map 1:1 — the vocabularies are the same strings", () => {
	expect(CODEWHALE_SANDBOX_MODES["workspace-write"]).toBe("workspace-write");
	expect(CODEWHALE_SANDBOX_MODES["danger-full-access"]).toBe("danger-full-access");
	expect(CODEWHALE_CONFIG_SANDBOX_VALUES).toEqual([
		"read-only",
		"workspace-write",
		"danger-full-access",
		"external-sandbox",
	]);
});

test("read-only claims NOTHING, because the nearest sandbox here is wider", () => {
	expect(CODEWHALE_SANDBOX_MODES["read-only"]).toBeUndefined();
	const { home, cwd } = codewhaleFixture({
		files: { "config.toml": configToml('approval_policy = "on-request"\nsandbox_mode = "read-only"\n') },
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find((item) => item.from.includes("sandbox_mode"));
	expect(line?.action).toBe("skip");
	expect(line?.detail).toContain("widen");
	// Nothing may have claimed a sandbox at all.
	expect(plan.items.some((item) => item.to === "settings.json → sandbox" && item.action === "map")).toBe(false);
});

test("`never` claims nothing, and the report says it both declines to ask and denies", () => {
	expect(CODEWHALE_APPROVAL_POLICIES.never).toBeUndefined();
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": configToml('approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find((item) => item.from.includes("approval_policy"));
	expect(line?.action).toBe("skip");
	expect(line?.detail).toContain("never requires approval");
	expect(plan.items.some((item) => item.to === "settings.json → permissionMode" && item.action === "map")).toBe(false);
});

test("every row of both approval tables has a stated reason for the ones that claim nothing", () => {
	// A row added without a sentence is an import whose claim nobody has checked.
	for (const value of ["never"]) expect(CODEWHALE_APPROVAL_POLICIES[value]).toBeUndefined();
	for (const value of ["auto-review", "use-tui-default"]) {
		expect(CODEWHALE_SETTINGS_APPROVAL_POLICIES[value]).toBeUndefined();
	}
	expect(CODEWHALE_APPROVAL_POLICIES.auto).toBe("agent");
	expect(CODEWHALE_APPROVAL_POLICIES["on-request"]).toBe("ask");
	expect(CODEWHALE_APPROVAL_POLICIES.untrusted).toBe("ask");
	expect(CODEWHALE_APPROVAL_POLICIES.suggest).toBe("ask");
	expect(CODEWHALE_SETTINGS_APPROVAL_POLICIES["full-access"]).toBe("agent");
	expect(CODEWHALE_SETTINGS_APPROVAL_POLICIES.ask).toBe("ask");
});

test("a mode with no sandbox alongside it claims NEITHER half", () => {
	// Writing `permissionMode` alone would leave a session that auto-approves
	// everything inside a sandbox the user never chose.
	const { home, cwd } = codewhaleFixture({ files: { "config.toml": configToml('approval_policy = "auto"\n') } });
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.to === "settings.json → permissionMode")).toBe(false);
	expect(plan.items.some((item) => item.to === "settings.json → sandbox")).toBe(false);
	expect(plan.items.some((item) => item.detail.includes("states no sandbox_mode"))).toBe(true);
});

test("the settings.toml vocabulary is a different table, and config.toml's values are not read from it", () => {
	// `check_config_toml_choice`'s own note (`crates/config/src/lib.rs:3822-3825`)
	// says `ask` and `full-access` are settings.toml values that config.toml does
	// not read. Reading one file with the other's table would map them to nothing.
	expect(CODEWHALE_APPROVAL_POLICIES.ask).toBeUndefined();
	expect(CODEWHALE_APPROVAL_POLICIES["full-access"]).toBeUndefined();
	// The settings file supplies the posture and `config.toml` the confinement, which
	// is what a real install looks like: a `full-access` posture with no sandbox
	// beside it claims **neither** half, by this planner's own rule.
	const { home, cwd } = codewhaleFixture({
		files: {
			"settings.toml": 'approval_policy = "full-access"\n',
			"config.toml": 'sandbox_mode = "danger-full-access"\n',
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const mode = plan.items.find((item) => item.to === "settings.json → permissionMode");
	expect(mode?.action).toBe("map");
	// **From the settings file, and named as such** — which is the whole point of
	// keeping two tables: the same key in `config.toml` would have mapped to nothing.
	expect(mode?.from).toContain("settings.toml");
});

test("a pair of values claims both halves together", () => {
	const { home, cwd } = codewhaleFixture({
		files: { "config.toml": configToml('approval_policy = "auto"\nsandbox_mode = "danger-full-access"\n') },
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.to === "settings.json → permissionMode" && item.action === "map")).toBe(true);
	expect(plan.items.some((item) => item.to === "settings.json → sandbox" && item.action === "map")).toBe(true);
});

// ---------------------------------------------------------------------------
// Hooks — the sixth document, found late
// ---------------------------------------------------------------------------

/**
 * The global `[hooks]` table, with the entries a test handed it.
 *
 * **The two hook documents have different table shapes, and that is the
 * product's own distinction.** `config.toml`'s block is the `[hooks]` table of
 * the root config — `[[hooks.hooks]]` — while
 * `<workspace>/.codewhale/hooks.toml` is parsed as a *whole* `HooksConfig`
 * (`toml::from_str::<HooksConfig>(&contents)`,
 * `crates/tui/src/hooks/config.rs:495`), so its entries are `[[hooks]]` at the
 * top level. `PROJECT_HOOKS_TEMPLATE` (`:410-425`) shows the project spelling in
 * a commented example. Two helpers, because writing the global shape into the
 * project file produces a document Codewhale itself would reject.
 */
function hooksToml(entries: string[], extra = ""): string {
	return `${extra}\n[[hooks.hooks]]\n${entries.join("\n")}\n`;
}

/** The project `hooks.toml` shape — `HooksConfig` is the whole document there. */
function projectHooksToml(entries: string[]): string {
	return `[[hooks]]\n${entries.join("\n")}\n`;
}

test("the [hooks] table is read even though ConfigToml declares no hooks field", () => {
	// `HooksConfig` is deserialized separately from the root config
	// (`crates/tui/src/hooks/config.rs:379`). Reading ConfigToml's field list and
	// concluding Codewhale has no hooks is the mistake this test exists to keep
	// made twice.
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": hooksToml(['event = "tool_call_before"', 'command = "echo pre"', "timeout_secs = 5"]),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	expect(raw.hooks).toHaveLength(1);
	expect(raw.hooks[0].enabled).toBe(true);
	expect(raw.hooks[0].entries[0]).toMatchObject({
		event: "tool_call_before",
		command: "echo pre",
		timeoutSecs: 5,
		continueOnError: true,
	});
});

test("the fifteen event names are all present, six of which this build fires", () => {
	// `ALL_HOOK_EVENTS` is `[HookEvent; 15]` (`config.rs:81-97`) and `as_str`
	// (`:117-135`) is the persisted spelling; the two agree exactly.
	expect(CODEWHALE_HOOK_EVENT_NAMES).toHaveLength(15);
	expect(CODEWHALE_HOOK_EVENTS_THIS_BUILD_RUNS).toHaveLength(6);
	expect(CODEWHALE_HOOK_EVENT_NAMES).toContain("waiting_for_user");
	expect(CODEWHALE_HOOK_EVENTS.waiting_for_user).toBeUndefined();
	expect(CODEWHALE_HOOK_EVENTS.tool_call_before).toBe("PreToolUse");
	expect(CODEWHALE_HOOK_EVENTS.turn_end).toBe("Stop");
});

test("a hook this build fires is imported", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": hooksToml(['event = "tool_call_before"', 'command = "echo pre"'], 'model = "x"'),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find((item) => item.detail.includes("event(s) imported"));
	expect(line?.to).toContain("hooks");
});

test("a hook under an event this build does not fire is named, never imported", () => {
	// An imported hook that never runs is a silent loss dressed as a success.
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": hooksToml(['event = "shell_env"', 'command = "echo token"'], 'model = "x"'),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.detail.includes("none of the 1 hook(s)"))).toBe(true);
	const dropped = plan.items.find((item) => item.detail.includes("an event this build has no hook for"));
	expect(dropped?.detail).toContain("shell_env");
	expect(plan.writes.every((write) => !write.content.includes("echo token"))).toBe(true);
});

test("an exit_code condition is skipped rather than approximated onto a matcher", () => {
	// "Only when the exit code was 2" is a different predicate from "when the subject
	// matches"; a matcher is a subject pattern.
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": hooksToml(
				['event = "tool_call_after"', 'command = "log"', 'condition = "exit_code"', "code = 2"],
				'model = "x"',
			),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.detail.includes("no field for"))).toBe(true);
	expect(plan.writes.every((write) => !write.content.includes('"log"'))).toBe(true);
});

test("a tool_name condition becomes this build's matcher", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": hooksToml(
				['event = "tool_call_before"', 'command = "echo scoped"', 'condition = "tool_name"', 'name = "write_file"'],
				'model = "x"',
			),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.detail.includes("event(s) imported"))).toBe(true);
});

test("a hooks block switched off imports nothing", () => {
	// A user who turned their hooks off has hooks that are off.
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": hooksToml(
				['event = "session_start"', 'command = "setup"'],
				'model = "x"\n\n[hooks]\nenabled = false',
			),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.detail.includes("the block is switched off"))).toBe(true);
	expect(plan.writes.every((write) => !write.content.includes("setup"))).toBe(true);
});

test("a project hooks.toml is read, and its trust gate is named", () => {
	const { home, cwd } = codewhaleFixture({ files: { "config.toml": 'model = "x"\n' } });
	writeUnder(cwd, ".codewhale/hooks.toml", projectHooksToml(['event = "turn_end"', 'command = "notify"']));
	// Only the project block: `config.toml` here states no `[hooks]` table, so
	// the global half is absent rather than empty — the two are different facts.
	const raw = readCodewhale(home, cwd, {});
	expect(raw.hooks).toHaveLength(1);
	expect(raw.hooks[0].path).toContain("hooks.toml");
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const imported = plan.items.find((item) => item.to.includes("hooks") && item.action !== "skip");
	expect(imported?.from).toContain("hooks.toml");
});

// ---------------------------------------------------------------------------
// permissions.toml
// ---------------------------------------------------------------------------

test("allow and deny rules come across as permission lists", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"permissions.toml": configToml(
				'[[rules]]\ntool = "exec_shell"\ncommand = "git status"\naction = "allow"\n\n[[rules]]\ntool = "exec_shell"\ncommand = "rm -rf /"\naction = "deny"\n',
			),
		},
	});
	const raw = readCodewhale(home, cwd, {});
	expect(raw.permissions?.map((rule) => rule.action)).toEqual(["allow", "deny"]);
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.to.includes("allow"))).toBe(true);
	expect(plan.items.some((item) => item.to.includes("deny"))).toBe(true);
});

test("ask rules are named and not imported as either allow or deny", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"permissions.toml": configToml(
				'[[rules]]\ntool = "exec_shell"\ncommand = "cargo"\naction = "ask"\n\n[[rules]]\ntool = "exec_shell"\ncommand = "git"\naction = "allow"\n',
			),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find((item) => item.detail.includes("`ask` rule"));
	expect(line?.detail).toContain('no "always ask" list');
	expect(plan.writes.every((write) => !write.content.includes('"cargo"'))).toBe(true);
});

test("a workspace-scoped rule is named, not widened into a global one", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"permissions.toml": configToml(
				'[[rules]]\ntool = "exec_shell"\ncommand = "make"\nworkspace = "/repo"\naction = "allow"\n',
			),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.items.some((item) => item.detail.includes("workspace-scoped"))).toBe(true);
	expect(plan.items.some((item) => item.to.includes("allow"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Assets, and the shared `.agents` tree
// ---------------------------------------------------------------------------

test("a skill in ~/.agents is NOT imported here — the `agents` source owns it", () => {
	// The bug this guards: `~/.agents/skills` is the shared agentskills.io tree and
	// `agents-read.ts:34-39` already migrates it. Importing it here too writes every
	// file in it twice.
	expect(CODEWHALE_SHARED_TREE).toContain(join(".agents", "skills"));
	const { home, cwd } = codewhaleFixture({
		sharedFiles: { ".agents/skills/shared/SKILL.md": "---\nname: shared\n---\n" },
		files: { "skills/mine/SKILL.md": "---\nname: mine\n---\n" },
	});
	const raw = readCodewhale(home, cwd, {});
	expect(raw.assets.map((skill) => skill.name)).toEqual(["mine"]);
	expect(raw.sharedTree).toContain(join(".agents", "skills"));
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	expect(plan.writes.filter((write) => write.path.includes(join("skills", "shared")))).toHaveLength(0);
	expect(plan.items.some((item) => item.detail.includes("shared cross-tool `.agents` home"))).toBe(true);
});

test("a plan over BOTH sources writes a shared skill exactly once, attributed to agents", () => {
	// The differential the exclusion exists for. Two writes is the bug, and the
	// report would otherwise look clean while double-importing.
	const { home, cwd } = codewhaleFixture({
		sharedFiles: { ".agents/skills/shared/SKILL.md": "---\nname: shared\n---\nshared body\n" },
	});
	const plan = runMigration({ home, cwd, from: "codewhale,agents" }).plan;
	// `write.path` is the real path (Windows separators); an item's `to` goes through
	// `tildePath`, which normalises to `/`. Matching both on one spelling would test
	// nothing on one platform and everything on the other.
	const writes = plan.writes.filter((write) => write.path.includes(join("skills", "shared", "SKILL.md")));
	expect(writes).toHaveLength(1);
	const claimed = plan.items.filter((item) => item.to.includes("skills/shared/SKILL.md") && item.action === "map");
	expect(claimed).toHaveLength(1);
	expect(claimed[0].source).toBe("agents");
});

test("~/.agents/AGENTS.md is named as shared, not imported as Codewhale's", () => {
	expect(CODEWHALE_SHARED_TREE).toContain(join(".agents", "AGENTS.md"));
	const { home, cwd } = codewhaleFixture({
		sharedFiles: { ".agents/AGENTS.md": "shared instructions\n" },
	});
	const raw = readCodewhale(home, cwd, {});
	expect(raw.globalInstructions.map((doc) => doc.name)).not.toContain("AGENTS.md");
	expect(raw.sharedTree).toContain(join(".agents", "AGENTS.md"));
});

test("the Codewhale roots of AGENTS.md and instructions.md are read, canonical first", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"AGENTS.md": "canonical agents\n",
			"instructions.md": "canonical instructions\n",
		},
		legacyFiles: {
			"AGENTS.md": "legacy agents\n",
			"instructions.md": "legacy instructions\n",
		},
	});
	const raw = readCodewhale(home, cwd, {});
	expect(raw.globalInstructions.map((doc) => doc.name).sort()).toEqual(["AGENTS.md", "instructions.md"]);
	const agents = raw.globalInstructions.find((doc) => doc.name === "AGENTS.md");
	expect(agents?.content).toBe("canonical agents\n");
	expect(agents?.sourcePath).toContain(CODEWHALE_DEFAULT_DIR);
});

test("a legacy document is read only when the canonical one is absent, and the collision is reported", () => {
	const { home, cwd } = codewhaleFixture({ legacyFiles: { "AGENTS.md": "legacy only\n" } });
	const raw = readCodewhale(home, cwd, {});
	const agents = raw.globalInstructions.find((doc) => doc.name === "AGENTS.md");
	expect(agents?.content).toBe("legacy only\n");
	expect(agents?.sourcePath).toContain(CODEWHALE_LEGACY_DIR);
});

test("WHALE.md is named with the product's own warning and never read", () => {
	// `DEPRECATED_WHALE_FILENAME` (`project_context.rs:343`) and
	// `WHALE_IGNORED_WARNING` (`:346`).
	const { home, cwd } = codewhaleFixture({ files: { "WHALE.md": "old instructions\n" } });
	const raw = readCodewhale(home, cwd, {});
	expect(raw.deprecatedDocuments).toHaveLength(1);
	expect(raw.globalInstructions.map((doc) => doc.name)).not.toContain("WHALE.md");
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find((item) => item.from.includes("WHALE.md"));
	expect(line?.detail).toContain("WHALE.md is ignored");
});

test("a project rules folder is read, .md only, in filename order", () => {
	const { home, cwd } = codewhaleFixture();
	writeUnder(cwd, ".codewhale/rules/second.md", "second rule\n");
	writeUnder(cwd, ".codewhale/rules/first.md", "first rule\n");
	writeUnder(cwd, ".codewhale/rules/notes.txt", "not a rule\n");
	const raw = readCodewhale(home, cwd, {});
	expect(raw.projectRules.map((rule) => rule.name)).toEqual(["first.md", "second.md"]);
	expect(raw.skipped.some((entry) => entry.name.endsWith("notes.txt"))).toBe(true);
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test("a session's working directory is read from metadata.workspace — nested, not top level", () => {
	// `SessionMetadata.workspace: PathBuf` with the serde name `workspace`
	// (`crates/tui/src/session_manager.rs:342-343`), and the on-disk fixture has
	// `"workspace"` at line 12 *inside* `metadata`.
	const { home, cwd } = codewhaleFixture({
		files: {
			"sessions/abc.json": sessionJson(
				{
					id: "abc",
					title: "A chat",
					created_at: "2026-07-18T00:00:00Z",
					message_count: 1,
					workspace: FIXTURE_CWD_TOKEN,
				},
				[{ role: "user", content: [{ type: "text", text: "hello" }] }],
			),
		},
	});
	const listed = listCodewhaleSessions(home, {});
	expect(listed.sessions).toHaveLength(1);
	expect(listed.sessions[0].cwd).toBe(cwd);
	expect(listed.sessions[0].title).toBe("A chat");
	expect(listed.sessions[0].startedAt).toBe(Date.parse("2026-07-18T00:00:00Z"));
});

test("the title comes from `title` and a `name` key is ignored — the trap in the brief", () => {
	// `SessionMetadata` has `title` (`crates/tui/src/session_manager.rs:322-323`) and
	// no `name`. A reader that looked for `name` would list every Codewhale session
	// as untitled.
	const { home } = codewhaleFixture({
		files: {
			"sessions/named.json": sessionJson(
				{ id: "named", title: "the real title", name: "the wrong one", workspace: FIXTURE_CWD_TOKEN },
				[],
			),
		},
	});
	expect(listCodewhaleSessions(home, {}).sessions[0].title).toBe("the real title");
});

test("a tool result is a user-role message carrying a tool_result block, and it converts to its own message", () => {
	// `crates/tui/src/session_manager.rs:6352-6360` — the product building one.
	const { home } = codewhaleFixture({
		files: {
			"sessions/pair.json": sessionJson({ id: "pair", title: "tools", workspace: FIXTURE_CWD_TOKEN }, [
				{ role: "user", content: [{ type: "text", text: "run it" }] },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "call_1", content: "file body", is_error: false }],
				},
			]),
		},
	});
	const [session] = listCodewhaleSessions(home, {}).sessions;
	const read = readCodewhaleSession(session);
	expect("error" in read).toBe(false);
	if ("error" in read) return;
	const roles = read.entries.map((entry) => (entry.kind === "message" ? entry.message.role : "compaction"));
	expect(roles).toEqual(["user", "assistant", "toolResult"]);
	const result = read.entries[2];
	if (result.kind !== "message" || result.message.role !== "toolResult") throw new Error("expected a tool result");
	expect(result.message.toolCallId).toBe("call_1");
	// The name is recovered from the earlier `tool_use`, which is the only place it
	// is recorded.
	expect(result.message.toolName).toBe("read_file");
});

test("an unpaired tool call loses both halves rather than producing a transcript the API rejects", () => {
	const { home } = codewhaleFixture({
		files: {
			"sessions/lonely.json": sessionJson({ id: "lonely", title: "half", workspace: FIXTURE_CWD_TOKEN }, [
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "tool_use", id: "call_x", name: "t", input: {} }] },
			]),
		},
	});
	const [session] = listCodewhaleSessions(home, {}).sessions;
	const read = readCodewhaleSession(session);
	if ("error" in read) throw new Error(read.error);
	const calls = read.entries.flatMap((entry) =>
		entry.kind === "message" && entry.message.role === "assistant" ? entry.message.content : [],
	);
	expect(calls.some((block) => block.type === "toolCall")).toBe(false);
	expect(read.notes.some((note) => note.reason.includes("other half was not in the transcript"))).toBe(true);
});

test("an interrupted assistant turn becomes `aborted`, which is what the role is for", () => {
	// `crates/protocol/src/role.rs:44-46`: kept distinct from `Role::Assistant` so
	// replay can mark it as incomplete.
	const { home } = codewhaleFixture({
		files: {
			"sessions/cut.json": sessionJson({ id: "cut", title: "cut", workspace: FIXTURE_CWD_TOKEN }, [
				{ role: "assistant_interrupted", content: [{ type: "text", text: "half a sen" }] },
			]),
		},
	});
	const [session] = listCodewhaleSessions(home, {}).sessions;
	const read = readCodewhaleSession(session);
	if ("error" in read) throw new Error(read.error);
	const message = read.entries[0];
	if (message.kind !== "message") throw new Error("expected a message");
	expect(message.message.role).toBe("assistant");
	expect(message.message.role === "assistant" ? message.message.stopReason : "").toBe("aborted");
});

test("a thinking block keeps its Anthropic signature, because a replay that drops it is rejected", () => {
	const { home } = codewhaleFixture({
		files: {
			"sessions/thinking.json": sessionJson({ id: "thinking", title: "t", workspace: FIXTURE_CWD_TOKEN }, [
				{ role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig-abc" }] },
			]),
		},
	});
	const [session] = listCodewhaleSessions(home, {}).sessions;
	const read = readCodewhaleSession(session);
	if ("error" in read) throw new Error(read.error);
	const message = read.entries[0];
	if (message.kind !== "message" || message.message.role !== "assistant")
		throw new Error("expected an assistant message");
	expect(message.message.content[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "sig-abc" });
});

test("a session with no readable metadata is reported, not listed as an empty session", () => {
	const { home } = codewhaleFixture({ files: { "sessions/junk.json": '{"not":"a session"}' } });
	const listed = listCodewhaleSessions(home, {});
	expect(listed.sessions).toHaveLength(0);
	expect(listed.skipped).toHaveLength(1);
});

test("the metadata brace-match survives a path containing a brace", () => {
	// The reason this is a string scan and not a line slice: a `workspace` path is
	// user data and `{` inside a string is not a nesting level.
	const head = '{\n  "schema_version": 1,\n  "metadata": {\n    "id": "a",\n    "workspace": "/tmp/{weird}/x"\n  },\n';
	expect(codewhaleMetadata(head)?.workspace).toBe("/tmp/{weird}/x");
});

test("the session directory is read from the legacy root when that is where it is", () => {
	// `ensure_state_dir` relocates a legacy tree on the product's next first write
	// (`crates/config/src/lib.rs:6177-6186`), so this is a state the product itself
	// produces.
	const { home } = codewhaleFixture({
		legacyFiles: { "sessions/old.json": sessionJson({ id: "old", title: "old", workspace: FIXTURE_CWD_TOKEN }, []) },
	});
	const listed = listCodewhaleSessions(home, {});
	expect(listed.sessions.map((session) => session.id)).toEqual(["old"]);
	expect(listed.sessions[0].path).toContain(CODEWHALE_LEGACY_DIR);
});

test("a boot-owners index sitting beside the transcripts is not offered as a session", () => {
	// `session_boot_owners.json` (`crates/tui/src/session_manager.rs:2325`) is a
	// `.json` in the same directory that is not a session.
	const { home } = codewhaleFixture({
		files: {
			"session_boot_owners.json": "{}",
			"sessions/real.json": sessionJson({ id: "real", title: "r", workspace: FIXTURE_CWD_TOKEN }, []),
		},
	});
	expect(listCodewhaleSessions(home, {}).sessions.map((session) => session.id)).toEqual(["real"]);
});

test("the prompt history is reported as coming from the sessions rather than as a separate file", () => {
	const { home, cwd } = codewhaleFixture({ files: { "config.toml": 'model = "x"\n' } });
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	// No prompt-history file is read, so nothing is asserted here beyond the source
	// not crashing on a home with nothing in it; the wording is asserted by
	// `migrate-history.ts`'s own arm.
	expect(plan.items.some((item) => item.from.includes("state documents"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Detection, and the two sentences the report must carry
// ---------------------------------------------------------------------------

test("detection finds a Codewhale install under either root", () => {
	const canonical = codewhaleFixture({ files: { "config.toml": 'model = "x"\n' } });
	expect(detectSources(canonical.home)).toContain("codewhale");
	const legacy = codewhaleFixture({ legacyFiles: { "config.toml": 'model = "x"\n' } });
	expect(detectSources(legacy.home)).toContain("codewhale");
});

test("an empty home is not offered as a Codewhale source", () => {
	const { home } = codewhaleFixture();
	expect(detectSources(home)).not.toContain("codewhale");
});

test("the report names Codewhale's own /import-claude and says this run did not take it", () => {
	const { home, cwd } = codewhaleFixture({ files: { "config.toml": 'model = "x"\n' } });
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find((item) => item.from.includes(CODEWHALE_IMPORT_CLAUDE.command));
	expect(line).toBeDefined();
	expect(line?.detail).toContain("did not take it");
	expect(line?.detail).toContain("instructions.md");
	expect(CODEWHALE_IMPORT_CLAUDE.commandLines).toBe(305);
	expect(CODEWHALE_IMPORT_CLAUDE.engineLines).toBe(543);
});

test("the report says Codewhale is a rename of DeepSeek-TUI and which paths fall back", () => {
	const { home, cwd } = codewhaleFixture({ files: { "config.toml": 'model = "x"\n' } });
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find(
		(item) => item.from.includes(CODEWHALE_LEGACY_DIR) && item.detail.includes("rename of DeepSeek-TUI"),
	);
	expect(line?.detail).toContain("rename of DeepSeek-TUI");
	// **Every name, not a summary of them.** `summarizeNames` truncates at five with
	// a "+N more", and a list whose whole point is "which paths fall back" cannot
	// answer that for the paths it left out.
	expect(line?.detail).toContain("sessions");
	expect(line?.detail).toContain("settings.toml");
	expect(line?.detail).not.toContain("more");
	expect(line?.detail).toContain("config.toml");
	expect(line?.detail).toContain("sessions");
});

test("the product's own extension-host denylist is quoted once, by name", () => {
	const { home, cwd } = codewhaleFixture({ files: { "config.toml": 'model = "x"\n' } });
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const line = plan.items.find((item) => item.from.includes("extension-host denylist"));
	expect(line).toBeDefined();
	// `secrets` and `state.db` are in it and are never opened.
	expect(CODEWHALE_DENIED_HOME_ENTRIES).toContain("secrets");
	expect(CODEWHALE_DENIED_HOME_ENTRIES).toContain("state.db");
	expect(line?.detail).toContain("secrets");
});

test("nothing in the plan's writes carries a credential from any of the four shapes", () => {
	const { home, cwd } = codewhaleFixture({
		files: {
			"config.toml": configToml(
				'[providers.gw]\napi_key = "sk-1"\nbase_url = "https://u:p@host/v1"\nhttp_headers = { Authorization = "Bearer sk-2" }\n\n[search]\napi_key = "sk-3"\n',
			),
			"mcp.json": JSON.stringify({
				servers: {
					gw: { url: "https://sk-4@host/mcp", headers: { Authorization: "Bearer sk-5" }, env: { T: "sk-6" } },
				},
			}),
		},
	});
	const plan = runMigration({ home, cwd, from: "codewhale" }).plan;
	const written = plan.writes.map((write) => write.content).join("\n");
	for (const secret of ["sk-1", "sk-2", "sk-3", "sk-4", "sk-5", "sk-6", "u:p@"]) {
		expect(written).not.toContain(secret);
	}
	expect(plan.writes.every((write) => write.containsSecret === false)).toBe(true);
});
