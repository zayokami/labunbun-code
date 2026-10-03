/**
 * Codewhale's user state, as read from a home directory.
 *
 * Read `codewhale-home.ts` first — every path below is that module's, with the
 * reference `file:line` it came from. The standing caveats for this source, in
 * one place:
 *
 *   - **Two roots, and which one answers is per-path.** Codewhale is a rename of
 *     DeepSeek-TUI, `~/.deepseek` is still a live fallback for some readers and
 *     not for others, and {@link CODEWHALE_LEGACY_FALLBACK} says which is which.
 *     `~/.codewhale` is checked first everywhere, and the code below never reads
 *     a legacy path as if it were the canonical one.
 *   - **Five settings documents, not one.** `config.toml` and `permissions.toml`
 *     are siblings; `settings.toml` has *three* candidate roots and none of them
 *     is project-scoped; `tui.toml` is superseded and folded into `settings.toml`
 *     by the product; and there is a project `config.toml` under `<workspace>`.
 *     Reading only the first would be reading a quarter of what Codewhale reads.
 *   - **`config.toml` holds credentials in four shapes, and a key-based scan sees
 *     none of the interesting ones.** `api_key`, `webhook_token` and
 *     `sandbox_api_key` match `looksLikeSecretName` and go. `base_url` and
 *     `http_headers` do not — the first because a credential can live in a URL's
 *     userinfo or query, the second because the *values* are tokens under a key
 *     that is not itself credential-shaped. Both are handled explicitly below,
 *     and both go through the shared {@link urlCredentialProblem} rather than a
 *     check written here.
 *   - **Session transcripts are counted, and their envelope is read; their
 *     messages are converted by `codewhale-session.ts`.** `SavedSession` is a
 *     single JSON document per session with `metadata.workspace` recorded, so
 *     the history arm works from the product's own bytes rather than from a
 *     guessed path.
 *
 * **Nothing here throws.** Every read that fails becomes a line in
 * {@link RawCodewhale.skipped} naming what failed and why, which is the
 * convention `qoder-read.ts` and `antigravity-read.ts` use: a migration that
 * aborts on one damaged file loses every other source's import to make a point
 * about that file.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	CODEWHALE_GLOBAL_DOCUMENTS,
	CODEWHALE_GLOBAL_INSTRUCTIONS,
	CODEWHALE_LEGACY_DIR,
	CODEWHALE_MCP_CREDENTIAL_KEYS,
	CODEWHALE_MCP_SERVERS_ALIAS,
	CODEWHALE_MCP_SERVERS_KEY,
	CODEWHALE_SHARED_TREE,
	type CodewhaleEnv,
	type CodewhaleHome,
	codewhaleConfigPath,
	codewhaleKeyringLocksDir,
	codewhaleMcpPath,
	codewhalePermissionsPath,
	codewhaleProjectAgentsDir,
	codewhaleProjectAnchorsPath,
	codewhaleProjectConfigPath,
	codewhaleProjectHooksPath,
	codewhaleProjectRulesDir,
	codewhaleProjectSharedSkillsDir,
	codewhaleProjectSkillsDir,
	codewhaleSecretsPath,
	codewhaleSessionsDir,
	codewhaleSessionsLocation,
	codewhaleSettingsCandidates,
	codewhaleSkillRoots,
	codewhaleStateLocation,
	codewhaleTreeHasContent,
	codewhaleTuiPrefsPath,
	resolveCodewhaleHome,
} from "./codewhale-home.ts";
import {
	isRecord,
	parseJsonc,
	readSkillDirs,
	readText,
	requoteNumericKeyPaths,
	tildePath,
	urlCredentialProblem,
} from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";

/**
 * One thing the walk found and did not carry over, with the reason.
 *
 * `name` is a **label, not a resolved path**, and the same convention
 * `qoder-read.ts` uses: a bare name where that is unambiguous, a
 * forward-slashed relative label where it is not.
 */
export interface CodewhaleSkipped {
	name: string;
	reason: string;
}

/** A JSON document in the three states one can be in when it is on disk. */
type CodewhaleJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/** A file's text, or why it is not available. `null` is never the answer. */
type CodewhaleText = { kind: "text"; value: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/**
 * One state document, where it resolved, and which root answered.
 *
 * `root` is the whole point; see {@link RawCodewhale.documents}. `purpose` is
 * what the product uses the file for, in one clause, so the report can name a
 * document the user did not know Codewhale kept.
 */
export interface CodewhaleDocument {
	/** The state name this was resolved under — `config.toml`, `mcp.json`, … */
	name: string;
	path: string;
	root: "codewhale" | "deepseek" | "absent";
	exists: boolean;
	/** What Codewhale uses this file for, quoted rather than paraphrased. */
	purpose: string;
}

/** A TOML document in the same three states. */
type CodewhaleToml =
	| { kind: "table"; value: Record<string, unknown>; requoted: string[] }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/**
 * One rule from `permissions.toml`.
 *
 * `crates/config/src/lib.rs:625-630` is the whole document — `PermissionsToml`
 * is `{ rules: Vec<ToolAskRule> }` and nothing else, `#[serde(deny_unknown_fields)]`.
 * The rule itself is `crates/execpolicy/src/lib.rs:112-137`:
 *
 * ```rust
 * pub struct ToolAskRule {
 *     pub tool: String,
 *     pub command: Option<String>,
 *     pub command_exact: bool,
 *     pub path: Option<String>,
 *     pub workspace: Option<String>,
 *     pub action: PermissionAction,   // "allow" | "ask" | "deny"
 * }
 * ```
 *
 * **No credential can live here**, which is worth stating because it is the one
 * Codewhale settings document that can be carried whole: every field is a tool
 * name, a path or an enum.
 */
export interface CodewhalePermissionRule {
	tool: string;
	command?: string;
	commandExact: boolean;
	path?: string;
	workspace?: string;
	action: "allow" | "ask" | "deny" | "other";
}

/**
 * One entry from Codewhale's `[hooks]` table.
 *
 * `HooksConfig` is `crates/tui/src/hooks/config.rs:379-406` — `enabled`,
 * `default_timeout_secs`, `working_dir`, `hooks: Vec<Hook>` — and `Hook`
 * (`:254-290`) is `event`, `command`, `condition?`, `timeout_secs`, `background`,
 * `continue_on_error`, `name?`.
 *
 * **`condition` is a typed enum, not a string** (`HookCondition`, `:217`: `Always`,
 * `ToolName`, `ToolCategory`, `Mode`, `ExitCode`), and it is the field that decides
 * whether a hook can be imported at all — see {@link planCodewhaleHooks}.
 */
export interface CodewhaleHook {
	/** The persisted event name, snake_case (`:117-135`). */
	event: string;
	command: string;
	/** The condition's variant name, or `""` when the entry states none. */
	condition: string;
	/** The condition's argument, which every variant but `Always` carries. */
	conditionArgument: string;
	/** Seconds; Codewhale's own default is 30 (`:292-294`). */
	timeoutSecs: number;
	background: boolean;
	continueOnError: boolean;
	name: string | null;
}

/** Where a hook block was read from, which is not a cosmetic difference. */
export interface CodewhaleHooksBlock {
	/** The file it came from — `config.toml` or `<workspace>/.codewhale/hooks.toml`. */
	path: string;
	/** `[hooks].enabled`; `false` means the whole table is switched off. */
	enabled: boolean;
	/** `[hooks].default_timeout_secs`, seconds, when set. */
	defaultTimeoutSecs: number | null;
	entries: CodewhaleHook[];
}

/**
 * Codewhale's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* of something, or a line
 * saying why neither happened. No field holds a credential and no field holds a
 * conversation.
 */
export interface RawCodewhale {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the home was resolved from, kept for the report. */
	env: CodewhaleEnv;
	/** The two roots, and whether the tree was pinned by `CODEWHALE_HOME`. */
	resolved: CodewhaleHome;
	/**
	 * True when the resolved tree exists and holds something.
	 *
	 * **`present` is not "a settings file was read."** A Codewhale home with only
	 * skills, only sessions or only a project `config.toml` is a real install with
	 * something in it, and the same argument `qoder-read.ts` makes about a
	 * CLI-only home applies here.
	 */
	present: boolean;
	/** Why `CODEWHALE_HOME` was refused, or `null`. */
	rejectedHome: string | null;
	/** The five settings documents, with the paths they were looked for at. */
	configPath: string;
	permissionsPath: string;
	settingsPath: string;
	/** `tui.toml` — superseded, named, never read. */
	tuiPrefsPath: string;
	/**
	 * Where each state document actually resolved, and **which root answered**.
	 *
	 * **This is the field the two-root problem is reported through, and it exists
	 * because "Codewhale's settings came across" hides three facts.** A document in
	 * `~/.codewhale` is a current install; the same document in `~/.deepseek` is a
	 * pre-rename install the product still reads; a document under `root:
	 * "absent"` was **not read at all** and the corresponding parsed field is
	 * `null`. Collapsing the three would make a report claim a read that never
	 * happened, which is the failure the whole source registry exists to prevent.
	 */
	documents: CodewhaleDocument[];
	/** `<cwd>/.codewhale/config.toml`, the project layer, or `null` without a `cwd`. */
	projectConfigPath: string | null;
	/**
	 * The parsed `config.toml`, after the credential scrub, or `null`.
	 *
	 * `null` rather than `{}` on purpose: a home where the file is present and
	 * unusable must say which of "a directory where a file was expected",
	 * "unreadable", "not parseable" or "not a TOML table" applies.
	 */
	config: Record<string, unknown> | null;
	/** The parsed project `config.toml`, when one exists. Never a merge with the above. */
	projectConfig: Record<string, unknown> | null;
	/** The parsed `permissions.toml`, or `null`. */
	permissions: CodewhalePermissionRule[] | null;
	/** The parsed `settings.toml`, or `null`. */
	settings: Record<string, unknown> | null;
	/**
	 * `[hooks]` from `config.toml`, and `<workspace>/.codewhale/hooks.toml`, as two
	 * blocks rather than one merge.
	 *
	 * **Kept apart because the product keeps them apart and the project half is
	 * gated.** `HooksConfig::load_with_project`
	 * (`crates/tui/src/hooks/config.rs:440-441`) appends project hooks *after*
	 * global ones and only after "workspace trust and exact-byte hook approval"
	 * (`:442-443`) — a hook runs code, so an untrusted repository's `hooks.toml` is
	 * inert in Codewhale. Merging them here would import a command the product
	 * itself would refuse to run.
	 */
	hooks: CodewhaleHooksBlock[];
	/**
	 * The servers from `mcp.json`, keyed by name.
	 *
	 * Read from `servers`, or from `mcpServers` when the canonical name is absent —
	 * see {@link CODEWHALE_MCP_SERVERS_KEY}. Credentials inside an entry are
	 * already gone; see {@link scrubCodewhaleCredentials}.
	 */
	mcpServers: Record<string, unknown>;
	/**
	 * `~/.codewhale/mcp.json`, the user-global MCP file, and **whether it was
	 * there**.
	 *
	 * Held as a path because there is no project MCP file to name — see
	 * `codewhale-home.ts`. A report that printed "no MCP servers" for a home with
	 * no `mcp.json` at all would be saying the same sentence twice, so the
	 * absence is a field and the plan can word it.
	 */
	mcpPath: string;
	mcpPresent: boolean;
	/**
	 * The user-global instruction documents, **in the product's precedence**, with
	 * the first copy of each basename winning.
	 *
	 * `.codewhale` before `.agents` before `.deepseek`, per
	 * `project_context.rs:354-364`. `.agents/AGENTS.md` and
	 * `.agents/instructions.md` are the shared agent home this repository already
	 * migrates as its `agents` source, so a name that arrives from both is
	 * recorded as a collision rather than imported twice.
	 */
	globalInstructions: RawFile[];
	/** A basename answered by two of the three roots; the later was not read. */
	instructionCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/** `WHALE.md` files, which Codewhale ignores — named, with the product's own warning. */
	deprecatedDocuments: string[];
	/** `<workspace>/.codewhale/rules/*.md`, in filename order, as the product loads them. */
	projectRules: RawFile[];
	/** `<workspace>/.codewhale/anchors.md`, or `null`. */
	projectAnchors: string | null;
	/** `<workspace>/.codewhale/agents/` — Fleet profiles, named and never opened. */
	projectAgentsDir: string | null;
	/** Skills from the roots Codewhale owns, first root winning a name. */
	assets: RawFile[];
	/** A folder name answered by both skill roots; the second was not read. */
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/**
	 * The **shared** `~/.agents` paths Codewhale reads and this importer does not.
	 *
	 * **This repository already has an `agents` source that owns that tree**
	 * (`agents-read.ts:34-39` reads `~/.agents/AGENTS.md`, `skills/`, `agents/`
	 * and `commands/`). Importing it here as well would write every file in it
	 * twice — and because `collectFileWrites` keys on the target path, the second
	 * copy would be reported as a written skill attributed to Codewhale when it
	 * was the same file the `agents` run already wrote. The same exclusion
	 * `kimi-read.ts` makes with `KIMI_SHARED_TREE`, for the same reason.
	 *
	 * Filtered by existence, so an absent entry is not a report line.
	 */
	sharedTree: string[];
	/** How many session transcripts are on disk. None is read here. */
	sessionCount: number;
	/** The directory they were counted in, which may be the legacy root. */
	sessionsDir: string;
	/** `secrets/secrets.json` and `keyring-locks/`, existence-checked only. */
	secretStore: { path: string; exists: boolean };
	keyringLocksDir: string;
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: CodewhaleSkipped[];
}

/**
 * Key names `looksLikeSecretName` does not catch.
 *
 * That helper matches `TOKEN`, `KEY`, `SECRET`, `PASSWORD` and `CREDENTIAL` as
 * case-insensitive substrings, which covers `api_key`, `webhook_token` and
 * `sandbox_api_key` — the three credential-bearing Codewhale keys it has to.
 * The single gap that matters is `authorization`, which no Codewhale key uses
 * but which an MCP `headers` block or a hand-edited `[providers.*]` entry very
 * plausibly does, and which is in {@link CODEWHALE_CREDENTIAL_TABLE_KEYS}
 * anyway; it is listed here so the two mechanisms are not mistaken for one.
 */
const CODEWHALE_SECRET_KEY = /authorization/i;

/**
 * Top-level keys that are **maps from a user-chosen name to an entry**.
 *
 * The distinction this set exists to draw is the same one `qoder-read.ts` draws,
 * and it is worth restating because Codewhale makes it sharper. `providers` is a
 * `#[serde(flatten)]`ed `extras: BTreeMap<String, toml::Value>`
 * (`crates/config/src/lib.rs:612-615`), so **every dynamically named provider
 * lands under it** — a user who wrote `[providers.my-gateway]` gets an entry
 * called `my-gateway`, and `looksLikeSecretName` matches `KEY` inside that name
 * exactly as it matched inside `keyboard-mcp` in Qoder. A scrub that deleted
 * `providers.my-key-router` would delete a working provider route because its
 * name contained three letters.
 *
 * `servers` and `mcpServers` are the MCP maps under the same argument, and
 * `skills` is a `BTreeMap` in `SkillsToml` (`crates/config/src/lib.rs:1689`).
 */
const CODEWHALE_ENTRY_MAP_KEYS: ReadonlySet<string> = new Set([
	"providers",
	"servers",
	CODEWHALE_MCP_SERVERS_ALIAS,
	"skills",
	"custom_models",
	"extraKnownMarketplaces",
	"enabled_plugins",
	"plugin_configs",
]);

/**
 * Keys whose **values** are credentials whatever the key is called.
 *
 * This is the part a key-name scan cannot do, and it is the security-critical
 * half of this file. Four keys, each with the product's own evidence:
 *
 *   - `http_headers` — `BTreeMap<String, String>` on both the root `ConfigToml`
 *     (`crates/config/src/lib.rs:886-887`) and every `ProviderConfigToml`
 *     (`:210-211`). The product classifies a header as credential-bearing by
 *     name: `is_upstream_auth_header` (`crates/config/src/lib.rs:130-138`) is
 *     `is_sensitive_config_key`, whose doc says "suppress every
 *     credential-shaped request header instead of allowing the same secret
 *     through Proxy-Authorization, X-Auth-Token, X-Access-Token, X-Goog-Api-Key,
 *     or another *-token/*-api-key spelling." So the reference product itself
 *     says these values are secrets, and the reference product's own comment on
 *     the root field says nothing puts them anywhere safer — `config.toml` is an
 *     ordinary `0644` file, unlike `secrets/secrets.json`.
 *   - `headers`, `env`, `env_headers`, `env_http_headers` — the MCP entry's
 *     credential channels, in `crates/tui/src/mcp.rs:626`, `:568`, `:631` and
 *     the `:629` alias. The product's own comment at `:619-623` says a stored
 *     header "lives in plain text in `~/.deepseek/mcp.json`".
 *   - `bearer_token_env_var` — names a variable rather than holding a token, and
 *     is dropped for the same reason as the rest: this build's MCP client has
 *     nowhere to put it, and a name that resolves to a bearer token is a name a
 *     report should not echo without saying so.
 *
 * **`env_headers` is here even though its values are not in the file**, because
 * the file holds an environment variable *name* and the destination this build
 * writes has no field for that either. Dropping it loses an indirection rather
 * than a secret, and the report says which of the two happened.
 */
const CODEWHALE_CREDENTIAL_TABLE_KEYS: ReadonlySet<string> = new Set([
	"http_headers",
	...CODEWHALE_MCP_CREDENTIAL_KEYS,
	"env_headers",
	"env_http_headers",
]);

/**
 * Keys whose **value is a URL that can carry a credential**, checked with the
 * shared {@link urlCredentialProblem}.
 *
 * `base_url` is the load-bearing one: `[providers.*].base_url` is a whole URL a
 * user pastes from a gateway's dashboard, and `https://key@host/v1` is a shape
 * every such dashboard produces. This is the hole that was found in Qoder and
 * then fixed across all fourteen existing sources, and the fix is a shared
 * function rather than a per-source regexp — a first version of that guard used
 * `new URL` as its main path and mis-parsed 11 of 16 hand-edited URLs.
 *
 * **An MCP entry's `url` is deliberately NOT in this list**, and the reason is
 * that the planner has to make a decision this reader cannot: a URL carrying a
 * credential loses the **whole server**, not just the credential, because a URL
 * with its userinfo or its `?access_token=` removed is a *different URL* that
 * points at nothing (`qoder-plan.ts` argues it at length). Dropping the string
 * here would leave the planner looking at an entry with no `command` and no
 * `url`, and it would report "names neither a command nor a URL" — which is
 * false, because the file named one. So the MCP URL reaches
 * {@link urlCredentialProblem} in `planCodewhaleMcp`, where the loss can be
 * reported as the loss of a server. The `config.toml` URLs here have no planner
 * side at all — this source maps no provider route — so dropping them here is
 * the only way they are reported, and dropping them is the only safe answer.
 */
const CODEWHALE_URL_KEYS: ReadonlySet<string> = new Set(["base_url", "sandbox_url", "origin"]);

/**
 * The largest depth a credential-shaped key is looked for at.
 *
 * Eight is past anything Codewhale nests to — the deepest attested provider key
 * is three segments (`providers.<name>.api_key`) — and the cap is here so a
 * pathological document cannot turn a credential scan into a walk of a
 * megabyte-deep structure. A key deeper than this is **left in place**, which is
 * the one thing this function can get wrong, and it is stated rather than
 * pretended away.
 */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

/** The one line a JSON document read through `parseJsonc` earns. */
const CODEWHALE_JSONC_RECOVERY =
	"not parseable as plain JSON — read anyway with comments and trailing commas stripped. The file's own reader is a strict " +
	"JSON parser, so it would have rejected this document outright";

/**
 * Remove every credential from a parsed document, recording each by path and
 * never touching a value it did not have to.
 *
 * Three mechanisms, in the order they run:
 *
 *   1. **Key-name scrub.** Every key matching `looksLikeSecretName` or
 *      {@link CODEWHALE_SECRET_KEY} is deleted at any depth, and one `skipped`
 *      line records its full path. This catches `api_key`, `webhook_token`,
 *      `sandbox_api_key` and `search.api_key`.
 *   2. **Credential-table drop.** Every key in
 *      {@link CODEWHALE_CREDENTIAL_TABLE_KEYS} is deleted *with its entries named
 *      individually*, so the report can say "left off Authorization,
 *      X-Api-Key" rather than "left off a headers block". The values are never
 *      read into a string.
 *   3. **URL check.** Every key in {@link CODEWHALE_URL_KEYS} whose value trips
 *      {@link urlCredentialProblem} is deleted whole, with one line naming the
 *      shape found (`URL_USERINFO` or `URL_PARAMETER`) and not one character of
 *      the URL.
 *
 * **The entry-map exemption is what keeps #1 from eating the user's own names.**
 * Below a key in {@link CODEWHALE_ENTRY_MAP_KEYS} the immediate children are
 * names the user chose, so they are stepped over and only each entry's own keys
 * are matched. The key above was still tested and still deleted if it matched.
 */
function scrubCodewhaleCredentials(value: Record<string, unknown>, into: CodewhaleSkipped[], prefix: string): void {
	const walk = (node: unknown, path: string[], depth: number): void => {
		if (!isRecord(node) || depth > MAX_CREDENTIAL_SCAN_DEPTH) return;
		for (const [key, nested] of Object.entries(node)) {
			const here = [...path, key];
			const at = `${prefix} → ${here.join(".")}`;

			if (CODEWHALE_CREDENTIAL_TABLE_KEYS.has(key) && isRecord(nested)) {
				const names = Object.keys(nested);
				if (names.length > 0) {
					for (const name of names) {
						into.push({
							name: `${at}.${name}`,
							reason:
								key === "http_headers"
									? "an HTTP header value is a bearer token by Codewhale's own account — `is_upstream_auth_header` classifies these names as credential-bearing, and `config.toml` is an ordinary file with no special permissions — so the name is reported and the value was never read"
									: key === "env"
										? "an MCP server's environment value is its process environment, which is an ordinary place for a token; the name is reported and the value was never read"
										: key === "bearer_token_env_var"
											? "this names an environment variable holding a bearer token; the field has no equivalent here, so neither the name nor the variable came across"
											: "an MCP header value; `mcp.rs` says a token stored here lives in plain text and is passed through as-is, so the name is reported and the value was never read",
						});
					}
				} else {
					into.push({ name: at, reason: "an empty credential table — nothing was in it to read" });
				}
				delete node[key];
				continue;
			}

			if (CODEWHALE_URL_KEYS.has(key) && typeof nested === "string") {
				const problem = urlCredentialProblem(nested);
				if (problem !== null) {
					into.push({
						name: at,
						reason: `dropped whole because ${problem} — a credential in a URL is not under a credential-shaped key, so no name-based scan finds it, and a URL with it removed points at nothing`,
					});
					delete node[key];
					continue;
				}
			}

			if (CODEWHALE_SECRET_KEY.test(key) || looksLikeSecretName(key)) {
				into.push({
					name: at,
					reason: "looks like a credential — name only, value never read",
				});
				delete node[key];
				continue;
			}

			// A map keyed by a name the user chose — see
			// CODEWHALE_ENTRY_MAP_KEYS. The key above was still tested and still
			// deleted if it matched; what is exempt is the *next* level.
			if (CODEWHALE_ENTRY_MAP_KEYS.has(key)) {
				if (!isRecord(nested)) continue;
				for (const [entryName, entry] of Object.entries(nested)) {
					walk(entry, [...here, entryName], depth + 1);
				}
				continue;
			}
			walk(nested, here, depth + 1);
		}
	};
	walk(value, [], 0);
}

/**
 * A file's text, or the reason it is not text.
 *
 * `statSync` first rather than opening and catching, because the two failures a
 * caller must tell apart are *absent* and *there but unreadable*, and both would
 * otherwise arrive as exceptions — which would make a home that has never
 * installed Codewhale produce a report full of "unreadable" lines.
 */
function readCodewhaleText(path: string): CodewhaleText {
	let isDirectory: boolean;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		return { kind: "absent" };
	}
	if (isDirectory) return { kind: "unreadable", reason: "a directory where a file was expected" };
	const content = readText(path);
	return content === null ? { kind: "unreadable", reason: "present but unreadable" } : { kind: "text", value: content };
}

/**
 * A JSON document, with the two failures kept apart and one recovery attempted.
 *
 * `mcp.json` is plain JSON in the product — there is no comment-stripping reader
 * on that path — so `parseJsonc` is a **superset** of what Codewhale accepts. A
 * file this reader can still parse is one Codewhale would reject, which is the
 * opposite of what recovery normally covers, and the reason the report line says
 * so rather than reading it quietly.
 */
function readCodewhaleJson(path: string): CodewhaleJson {
	const text = readCodewhaleText(path);
	if (text.kind === "absent") return { kind: "absent" };
	if (text.kind === "unreadable") return { kind: "invalid", reason: text.reason };
	try {
		const parsed: unknown = JSON.parse(text.value);
		return isRecord(parsed)
			? { kind: "object", value: parsed, recovered: false }
			: { kind: "invalid", reason: "not a JSON object" };
	} catch {
		try {
			const recovered = parseJsonc(text.value);
			if (Object.keys(recovered).length > 0) return { kind: "object", value: recovered, recovered: true };
		} catch {
			// The recovery did not reach the real problem either; reported below.
		}
		return {
			kind: "invalid",
			reason:
				"not parseable as JSON — comments and trailing commas have already been taken out, so the text is damaged rather than decorated",
		};
	}
}

/**
 * A TOML document, with the same numeric-key retry `step-read.ts` and
 * `grok-read.ts` document.
 *
 * **This is the parser's deviation, not Codewhale's.** TOML 1.0 allows a
 * digits-only segment after a dot (`[providers].0 = 1`) and `Bun.TOML.parse`
 * rejects the whole document over it. Codewhale parses with the `toml` crate,
 * which is spec-compliant, so such a file is one Codewhale reads. Quoting the
 * segments is a no-op under the spec and recovers every other setting in the
 * file; the segments that were requoted come back in
 * {@link CodewhaleToml} so the report can name them.
 *
 * A fixed phrase for the failure, never the parser's message: `toml`'s error can
 * quote the offending line, which may be a credential.
 */
function readCodewhaleToml(path: string): CodewhaleToml {
	const text = readCodewhaleText(path);
	if (text.kind === "absent") return { kind: "absent" };
	if (text.kind === "unreadable") return { kind: "invalid", reason: text.reason };
	try {
		const parsed = Bun.TOML.parse(text.value);
		return isRecord(parsed)
			? { kind: "table", value: parsed, requoted: [] }
			: { kind: "invalid", reason: "not a TOML table" };
	} catch {
		const requoted = requoteNumericKeyPaths(text.value);
		if (requoted !== null) {
			try {
				const parsed = Bun.TOML.parse(requoted.text);
				if (isRecord(parsed)) return { kind: "table", value: parsed, requoted: requoted.changed };
			} catch {
				// The rewrite did not reach the real problem; reported as unparseable below.
			}
		}
		return { kind: "invalid", reason: "not parseable as TOML" };
	}
}

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function codewhaleDirectoryEntries(dir: string): Dirent[] {
	try {
		return [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		// An absent or unreadable directory is not an error here: most of the ones
		// this module looks for are optional, and the caller reports the absence of
		// the thing they were for, not the absence of the directory.
		return [];
	}
}

/**
 * `~/.codewhale/AGENTS.md`, `~/.deepseek/AGENTS.md` and the `instructions.md`
 * pair, **in the product's own precedence**, first copy of each basename winning.
 *
 * The precedence is not a guess: `project_context.rs:348-353` states it in the
 * product's words — "Within each file name, `.codewhale/` takes priority over
 * vendor-neutral `.agents/`, which takes priority over legacy `.deepseek/`" — and
 * `global_context_relative_paths()` (`:806-815`) returns them in exactly the
 * order {@link CODEWHALE_GLOBAL_INSTRUCTIONS} lists.
 *
 * **The `.agents` rows are skipped rather than read, and that is the same
 * exclusion `kimi-read.ts` makes with `KIMI_SHARED_TREE`.** `~/.agents` is the
 * shared agent home this repository already migrates as its own `agents` source
 * (`agents-read.ts:34-39`), so reading it here would write `AGENTS.md` twice —
 * once attributed to `agents` and once attributed to Codewhale — and the second
 * would land on the first's target path. Both `.agents` rows are named in
 * {@link RawCodewhale.sharedTree} instead.
 *
 * **A collision between the two Codewhale roots is recorded rather than dropped
 * silently**, so a user holding `AGENTS.md` in both learns which one was used.
 */
function readCodewhaleGlobalInstructions(
	home: string,
	resolved: CodewhaleHome,
	skipped: CodewhaleSkipped[],
): { files: RawFile[]; collisions: RawCodewhale["instructionCollisions"] } {
	const files: RawFile[] = [];
	const collisions: RawCodewhale["instructionCollisions"] = [];
	const claimed = new Map<string, string>();
	for (const [root, name] of CODEWHALE_GLOBAL_INSTRUCTIONS) {
		// The shared `.agents` home is named, never imported — see the comment
		// above and {@link RawCodewhale.sharedTree}.
		if (root === ".agents") continue;
		const base = root === CODEWHALE_LEGACY_DIR ? resolved.legacyRoot : resolved.root;
		const path = join(base, name);
		const content = readCodewhaleText(path);
		if (content.kind === "absent") continue;
		const label = tildePath(home, path);
		if (content.kind !== "text") {
			skipped.push({ name: label, reason: content.reason });
			continue;
		}
		const earlier = claimed.get(name);
		if (earlier !== undefined) {
			collisions.push({ name, kept: earlier, dropped: label });
			continue;
		}
		claimed.set(name, label);
		files.push({
			name,
			sourcePath: path,
			content: content.value,
			detail:
				root === CODEWHALE_LEGACY_DIR
					? "Codewhale's pre-rename global instruction document, read only because the `~/.codewhale` copy is absent"
					: "Codewhale's own global instruction document",
		});
	}
	return { files, collisions };
}

/**
 * The deprecated `WHALE.md` files, **named and not read**.
 *
 * `DEPRECATED_WHALE_FILENAME = "WHALE.md"` (`project_context.rs:343`) and
 * `WHALE_IGNORED_WARNING` (`:346`): "WHALE.md is ignored; move project
 * instructions to AGENTS.md, or Codewhale-specific authority policy to
 * `.codewhale/constitution.json`." The product reads one only to warn about it,
 * so importing one would add instructions the product itself will never load.
 */
function findCodewhaleDeprecatedDocuments(home: string, resolved: CodewhaleHome): string[] {
	const found: string[] = [];
	for (const [root, name] of CODEWHALE_GLOBAL_DOCUMENTS) {
		const base = root === ".agents" ? home : root === CODEWHALE_LEGACY_DIR ? resolved.legacyRoot : resolved.root;
		const path = join(base, name);
		if (existsSync(path)) found.push(tildePath(home, path));
	}
	return found;
}

/**
 * `<workspace>/.codewhale/rules/*.md`, in filename order.
 *
 * `project_context.rs:340` (`RULES_DIRS`) and the doc comment at `:335-339`:
 * "All `.md` files in these directories are loaded as project rules in filename
 * order." **`md` is the only extension read** — the cache-invalidation walk at
 * `:769-786` filters on it at `:781` — so a `.txt` beside them is something the
 * product does not load and is named rather than carried.
 */
function readCodewhaleProjectRules(workspace: string, home: string, skipped: CodewhaleSkipped[]): RawFile[] {
	const dir = codewhaleProjectRulesDir(workspace);
	if (!existsSync(dir)) return [];
	const files: RawFile[] = [];
	for (const entry of codewhaleDirectoryEntries(dir)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			skipped.push({
				name: tildePath(home, path),
				reason: "a directory in the rules folder — Codewhale loads the .md files directly in it, not a tree beneath it",
			});
			continue;
		}
		if (!entry.isFile()) continue;
		if (!entry.name.toLowerCase().endsWith(".md")) {
			skipped.push({
				name: tildePath(home, path),
				reason: "not a .md file, and Codewhale's rules folder is read with that extension filter",
			});
			continue;
		}
		const content = readCodewhaleText(path);
		if (content.kind !== "text") {
			skipped.push({
				name: tildePath(home, path),
				reason: content.kind === "absent" ? "gone before it could be read" : content.reason,
			});
			continue;
		}
		files.push({
			name: entry.name,
			sourcePath: path,
			content: content.value,
			detail: "a Codewhale project rule — the product loads every .md in .codewhale/rules in filename order",
		});
	}
	return files;
}

/**
 * Skills from the roots Codewhale owns, first root winning a name.
 *
 * The order is the product's — the global Codewhale root first, then the project
 * scopes (`tui/src/skills/mod.rs:985-991`: "Project roots outrank global roots",
 * so the *caller* passes them in product order) — and a folder present in two is
 * one skill with the second copy not read.
 *
 * **`~/.agents/skills` is deliberately absent from {@link codewhaleSkillRoots}'s
 * output and is not added here.** It is the shared agentskills.io tree, this
 * repository's `agents` source owns it outright, and a second import would write
 * every file in it twice with the second copy attributed to Codewhale. See
 * {@link RawCodewhale.sharedTree}.
 */
function readCodewhaleSkills(
	roots: string[],
	home: string,
	skipped: CodewhaleSkipped[],
): { assets: RawFile[]; collisions: RawCodewhale["assetCollisions"] } {
	const assets: RawFile[] = [];
	const collisions: RawCodewhale["assetCollisions"] = [];
	const claimed = new Map<string, string>();
	for (const dir of roots) {
		if (!existsSync(dir)) continue;
		const label = tildePath(home, dir);
		for (const skill of readSkillDirs(dir)) {
			const earlier = claimed.get(skill.name);
			if (earlier !== undefined) {
				collisions.push({ name: skill.name, kept: earlier, dropped: label });
				continue;
			}
			claimed.set(skill.name, label);
			assets.push(skill);
		}
		// `readSkillDirs` passes over a directory with no `SKILL.md` in silence,
		// which is worth a line: Codewhale's own layout is `<dir>/<name>/SKILL.md`
		// (`skills/mod.rs:560`), so a directory without one is user content in a
		// directory the agent reads and silence there reads as a miss.
		for (const entry of codewhaleDirectoryEntries(dir)) {
			if (!entry.isDirectory()) continue;
			if (claimed.has(entry.name)) continue;
			skipped.push({
				name: `${label}/${entry.name}`,
				reason: "a skill directory with no SKILL.md in it, which is not a skill Codewhale loads",
			});
		}
	}
	return { assets, collisions };
}

/**
 * How many transcripts are on disk.
 *
 * A count and not a list, because the *envelope* of each is read by
 * `codewhale-session.ts` on the history arm and this reader is what tells the
 * report how many there are before the user asks for any of them.
 */
function countCodewhaleSessions(sessionsDir: string): number {
	if (!existsSync(sessionsDir)) return 0;
	let count = 0;
	for (const entry of codewhaleDirectoryEntries(sessionsDir)) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) count += 1;
	}
	return count;
}

/**
 * The `servers` map out of `mcp.json`, or `{}`.
 *
 * **The canonical key is `servers`, and `mcpServers` is the alias.** See
 * {@link CODEWHALE_MCP_SERVERS_KEY}: a file carrying the canonical name uses it,
 * and one carrying only the alias deserializes through it, and one carrying both
 * uses the canonical — which is the only reading consistent with
 * `#[serde(alias = "mcpServers")]`.
 */
function readCodewhaleMcpServers(document: CodewhaleJson): Record<string, unknown> {
	if (document.kind !== "object") return {};
	const container = document.value[CODEWHALE_MCP_SERVERS_KEY];
	if (isRecord(container)) return container;
	const alias = document.value[CODEWHALE_MCP_SERVERS_ALIAS];
	return isRecord(alias) ? alias : {};
}

/**
 * `permissions.toml`'s rules, in file order, with the ones this build cannot
 * carry named rather than dropped.
 *
 * **The document is `deny_unknown_fields`** (`crates/config/src/lib.rs:625`),
 * so a file with a key Codewhale has since removed fails to load *for the
 * product too* — which makes a parse failure here a fact about the user's
 * install rather than about this reader, and the reason is the parser's message
 * never printed.
 */
function readCodewhalePermissions(
	document: CodewhaleToml,
	skipped: CodewhaleSkipped[],
	label: string,
): CodewhalePermissionRule[] | null {
	if (document.kind === "absent") return null;
	if (document.kind === "invalid") {
		skipped.push({ name: label, reason: document.reason });
		return null;
	}
	const rules = document.value.rules;
	if (rules === undefined) return [];
	if (!Array.isArray(rules)) {
		skipped.push({ name: `${label} → rules`, reason: "rules is not an array, so no rule was read from it" });
		return null;
	}
	const out: CodewhalePermissionRule[] = [];
	for (const [index, raw] of rules.entries()) {
		const at = `${label} → rules[${index}]`;
		if (!isRecord(raw)) {
			skipped.push({ name: at, reason: "not a rule table" });
			continue;
		}
		if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
			skipped.push({ name: at, reason: "a rule with no tool name, which is the one field the schema requires" });
			continue;
		}
		const action = raw.action;
		out.push({
			tool: raw.tool,
			command: typeof raw.command === "string" ? raw.command : undefined,
			commandExact: raw.command_exact === true,
			path: typeof raw.path === "string" ? raw.path : undefined,
			workspace: typeof raw.workspace === "string" ? raw.workspace : undefined,
			action:
				action === "allow" || action === "ask" || action === "deny"
					? action
					: typeof action === "string"
						? "other"
						: "ask",
		});
	}
	return out;
}

/**
 * Read one Codewhale home.
 *
 * **Pure with respect to everything outside `home`, `cwd` and `env`**: it
 * resolves paths against those arguments and never calls `os.homedir()` or
 * `process.cwd()`, so a fixture laid out by a test and a developer's own
 * `~/.codewhale` are the same code path. It does touch the filesystem,
 * necessarily — that is what reading is.
 *
 * `cwd` is the directory being migrated into, and it is what the **project
 * `config.toml`**, the project rules and the project anchors hang off. It is
 * `string | undefined` rather than defaulted to `process.cwd()` for the same
 * reason the reader takes `home` as an argument: a default would let a test that
 * forgot it read whatever directory the runner happened to be in.
 *
 * `env` defaults to `process.env`, which is what `readSources` passes, so a
 * developer who has set `CODEWHALE_HOME` gets that tree — the correct answer for
 * their machine. A test passes an explicit block instead, and **a test that
 * asserts on content must pass `env`** rather than rely on the ambient one.
 *
 * The order is the settings documents, then the fields read out of them, then the
 * global instructions, then skills, then the session count, then the paths that
 * exist and are deliberately not opened — but {@link RawCodewhale.skipped} is
 * **sorted by name before it is returned**, so two runs over one home produce the
 * same report rather than one that changes with the order the filesystem handed
 * back. Nothing short-circuits: a home with an unparseable `config.toml` still
 * yields its skills.
 */
export function readCodewhale(home: string, cwd: string | undefined, env: CodewhaleEnv = process.env): RawCodewhale {
	const resolved = resolveCodewhaleHome(home, env);
	const skipped: CodewhaleSkipped[] = [];

	// Every state document is resolved **through the same per-path rule the
	// product uses**, so a path that lives under `~/.deepseek` is read from there
	// and reported as having been read from there. See
	// {@link CODEWHALE_LEGACY_FALLBACK} for which names fall back and which do not.
	const located: CodewhaleDocument[] = [
		{
			name: "config.toml",
			...codewhaleStateLocation(resolved, "config.toml"),
			purpose: "providers, models, and the approval_policy / sandbox_mode pair",
		},
		{
			name: "permissions.toml",
			...codewhaleStateLocation(resolved, "permissions.toml"),
			purpose: "the typed allow/ask/deny rules, a sibling of config.toml",
		},
		{ name: "mcp.json", ...codewhaleStateLocation(resolved, "mcp.json"), purpose: "the user's MCP servers" },
		{
			name: "skills",
			...codewhaleStateLocation(resolved, "skills"),
			purpose: "the user's own skills, as <name>/SKILL.md",
		},
		{ name: "sessions", ...codewhaleSessionsLocation(resolved), purpose: "one <id>.json per conversation" },
	];
	const settingsCandidates = codewhaleSettingsCandidates(resolved);
	const settingsPath = settingsCandidates[0];
	located.push({
		name: "settings.toml",
		path: settingsPath,
		root: existsSync(settingsPath)
			? settingsPath.startsWith(resolved.legacyRoot)
				? "deepseek"
				: "codewhale"
			: "absent",
		exists: existsSync(settingsPath),
		purpose:
			"the TUI's own preferences — a different document from config.toml, with a different approval_policy vocabulary",
	});

	const byName = new Map(located.map((entry) => [entry.name, entry]));
	const configPath = byName.get("config.toml")?.path ?? codewhaleConfigPath(resolved);
	const permissionsPath = byName.get("permissions.toml")?.path ?? codewhalePermissionsPath(resolved);
	const mcpPath = byName.get("mcp.json")?.path ?? codewhaleMcpPath(resolved);
	const tuiPrefsPath = codewhaleTuiPrefsPath(settingsPath);

	// The five documents. Each is read on its own so a home missing one still
	// yields the other four, and each carries its own reason when it is there and
	// unusable — a `config.toml` that does not parse and a `settings.toml` that
	// does not are two different facts about the user's install.
	const configDocument = readCodewhaleToml(configPath);
	if (configDocument.kind === "invalid") {
		skipped.push({ name: tildePath(home, configPath), reason: configDocument.reason });
	} else if (configDocument.kind === "table" && configDocument.requoted.length > 0) {
		skipped.push({
			name: tildePath(home, configPath),
			reason: `read after quoting ${configDocument.requoted.length} digits-only dotted key path(s) (${configDocument.requoted.join(", ")}) — TOML 1.0 allows them and this importer's parser does not, so every other setting in the file came across and none was lost`,
		});
	}
	// The scrub runs before anything reads a field out of the document, so no
	// planner can see a value the reader has already reported by path.
	if (configDocument.kind === "table")
		scrubCodewhaleCredentials(configDocument.value, skipped, tildePath(home, configPath));

	const permissionsDocument = readCodewhaleToml(permissionsPath);
	const permissions = readCodewhalePermissions(permissionsDocument, skipped, tildePath(home, permissionsPath));

	const settingsDocument = readCodewhaleToml(settingsPath);
	if (settingsDocument.kind === "invalid") {
		skipped.push({ name: tildePath(home, settingsPath), reason: settingsDocument.reason });
	} else if (settingsDocument.kind === "table") {
		scrubCodewhaleCredentials(settingsDocument.value, skipped, tildePath(home, settingsPath));
	}

	let projectConfigPath: string | null = null;
	let projectConfig: Record<string, unknown> | null = null;
	if (cwd !== undefined) {
		projectConfigPath = codewhaleProjectConfigPath(cwd);
		const projectDocument = readCodewhaleToml(projectConfigPath);
		if (projectDocument.kind === "invalid") {
			skipped.push({ name: tildePath(home, projectConfigPath), reason: projectDocument.reason });
		} else if (projectDocument.kind === "table") {
			scrubCodewhaleCredentials(projectDocument.value, skipped, tildePath(home, projectConfigPath));
			projectConfig = projectDocument.value;
		}
	}

	const mcpDocument = readCodewhaleJson(mcpPath);
	if (mcpDocument.kind === "invalid") {
		skipped.push({ name: tildePath(home, mcpPath), reason: mcpDocument.reason });
	} else if (mcpDocument.kind === "object" && mcpDocument.recovered) {
		skipped.push({ name: tildePath(home, mcpPath), reason: CODEWHALE_JSONC_RECOVERY });
	}
	const mcpServers = readCodewhaleMcpServers(mcpDocument);
	// The MCP entries are scrubbed on their own rather than through the document
	// walk, because `mcpServers` is reached through the alias `servers` — a walk
	// over the parsed document would have to know both spellings to find it, and
	// `readCodewhaleMcpServers` is what resolves them.
	for (const [name, entry] of Object.entries(mcpServers)) {
		if (!isRecord(entry)) continue;
		scrubCodewhaleCredentials(entry, skipped, `${tildePath(home, mcpPath)} → ${CODEWHALE_MCP_SERVERS_KEY}.${name}`);
	}

	const { files: globalInstructions, collisions: instructionCollisions } = readCodewhaleGlobalInstructions(
		home,
		resolved,
		skipped,
	);
	const deprecatedDocuments = findCodewhaleDeprecatedDocuments(home, resolved);
	const projectRules = cwd === undefined ? [] : readCodewhaleProjectRules(cwd, home, skipped);
	const projectAnchors = cwd === undefined ? null : readAnchors(cwd, home, skipped);
	// **Three skill roots, and which three is a decision with a stated reason.**
	// The global Codewhale root (which may be `~/.deepseek/skills` — the loader
	// falls back for this name) and the two project scopes. `~/.agents/skills` is
	// **not** among them: the `agents` source owns that tree outright, and
	// importing it here would land a second copy of every file in it. See
	// `codewhaleSkillRoots` and {@link RawCodewhale.sharedTree}.
	//
	// The **already-resolved** skills directory, not the resolved home.
	// `CODEWHALE_LEGACY_FALLBACK["skills"]` is `true`, so the loader's own rule puts
	// this tree at `~/.deepseek/skills` on a pre-rename install; asking for
	// `<home>/skills` instead would report a home with a full skills tree as having
	// none, which is the exact failure the two-root table exists to prevent.
	const skillRoots = codewhaleSkillRoots(byName.get("skills")?.path ?? join(resolved.root, "skills"));
	if (cwd !== undefined) {
		skillRoots.push(codewhaleProjectSkillsDir(cwd), codewhaleProjectSharedSkillsDir(cwd));
	}
	const { assets, collisions: assetCollisions } = readCodewhaleSkills(skillRoots, home, skipped);
	const hooks = readCodewhaleHookBlocks(
		configDocument.kind === "table" ? configDocument.value : null,
		configPath,
		home,
		cwd,
		skipped,
	);
	const sharedTree = CODEWHALE_SHARED_TREE.filter((relative) => existsSync(join(home, relative)));

	const sessionsDir = byName.get("sessions")?.path ?? codewhaleSessionsDir(resolved);
	const sessionCount = countCodewhaleSessions(sessionsDir);
	const secretStorePath = codewhaleSecretsPath(resolved.root);

	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		env,
		resolved,
		present:
			codewhaleTreeHasContent(resolved.root) || codewhaleTreeHasContent(resolved.legacyRoot) || projectConfig !== null,
		rejectedHome: resolved.rejectedHome,
		configPath,
		permissionsPath,
		settingsPath,
		tuiPrefsPath,
		documents: located,
		projectConfigPath,
		config: configDocument.kind === "table" ? configDocument.value : null,
		projectConfig,
		permissions,
		settings: settingsDocument.kind === "table" ? settingsDocument.value : null,
		hooks,
		mcpServers,
		mcpPath,
		mcpPresent: existsSync(mcpPath),
		globalInstructions,
		instructionCollisions,
		deprecatedDocuments,
		projectRules,
		projectAnchors,
		projectAgentsDir: cwd === undefined ? null : codewhaleProjectAgentsDir(cwd),
		assets,
		assetCollisions,
		sharedTree,
		sessionCount,
		sessionsDir,
		secretStore: { path: secretStorePath, exists: existsSync(secretStorePath) },
		keyringLocksDir: codewhaleKeyringLocksDir(resolved.root),
		skipped,
	};
}

/**
 * The field each `HookCondition` variant carries, on the hook table beside
 * `condition`.
 *
 * `HookCondition` (`crates/tui/src/hooks/config.rs:217`) is a unit-or-struct enum,
 * and serde's **external** tagging puts a struct variant's single field on the
 * parent rather than inside a nested object. Verified against the bytes a
 * `[[hooks.hooks]]` table produces: `condition = "exit_code"` with `code = 2`
 * beside it, `condition = "mode"` with `mode = "plan"`, `condition =
 * "tool_category"` with `category = "shell"`. `Always` (`:219-221`) is the unit
 * variant and carries nothing, which is why it is absent here rather than mapped
 * to `""`.
 */
const CODEWHALE_CONDITION_ARGUMENT: Readonly<Record<string, string>> = {
	tool_name: "name",
	tool_category: "category",
	mode: "mode",
	exit_code: "code",
};

/**
 * One `[hooks]` table, read into the shape the planner needs.
 *
 * **`HookEvent` is `#[serde(rename_all = "snake_case")]`**
 * (`crates/tui/src/hooks/config.rs:26-27`) and `Hook` has **no** `rename_all`, so
 * every field on disk is its bare Rust name (`event`, `command`, `timeout_secs`,
 * `continue_on_error`) while every *event value* is snake_case
 * (`tool_call_before`, `session_start`, … — `as_str`, `:117-135`).
 *
 * **`condition` is flattened to a variant name and an argument.** The enum
 * (`:217-`) is `Always` (unit), `ToolName { name }`, `ToolCategory { category }`,
 * `Mode { mode }` and `ExitCode { code }` — internally tagged, so what is on disk
 * is `condition = "tool_name"` plus a sibling field rather than a nested object.
 * Both halves are carried because the planner needs the *variant* to decide
 * whether the hook can run here at all and the *argument* to say which one it
 * named; see {@link planCodewhaleHooks}.
 *
 * **`plugin_authority` and `project_authority` are `#[serde(skip)]`** (`:284`,
 * `:289`) — they are never read from TOML — so nothing in a file can claim either.
 */
function readCodewhaleHooks(table: Record<string, unknown> | undefined, path: string): CodewhaleHooksBlock | null {
	if (table === undefined) return null;
	const raw = Array.isArray(table.hooks) ? table.hooks : [];
	const entries: CodewhaleHook[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		if (typeof item.event !== "string" || typeof item.command !== "string") continue;
		const condition = isRecord(item.condition) ? item.condition : undefined;
		const variant =
			typeof item.condition === "string" ? item.condition : typeof condition?.type === "string" ? condition.type : "";
		// **`HookCondition` is externally tagged, and its argument lands as a SIBLING
		// field of `condition`, not inside it.** Verified against the on-disk shape: a
		// `[[hooks.hooks]]` table with `condition = "exit_code"` and `code = 2`
		// deserializes to `exit_code` plus a sibling `code`, and the same holds for
		// `mode` and `tool_category`. `HookCondition` (`config.rs:217`) is a struct
		// variant per condition, so serde's external tagging puts the single field on
		// the parent — which is why a nested-object read finds nothing.
		const argumentField = CODEWHALE_CONDITION_ARGUMENT[variant];
		const argument = argumentField === undefined ? undefined : item[argumentField];
		entries.push({
			event: item.event,
			command: item.command,
			condition: variant,
			conditionArgument: typeof argument === "string" ? argument : typeof argument === "number" ? String(argument) : "",
			timeoutSecs: typeof item.timeout_secs === "number" ? item.timeout_secs : 30,
			background: item.background === true,
			continueOnError: item.continue_on_error !== false,
			// **`name` is ambiguous in Codewhale's own format and this is the
			// consequence.** `Hook.name` is documented as "Optional name for
			// logging/debugging" (`:278-279`) and `ToolName`'s single field is *also*
			// `name`, so a hook with `condition = "tool_name"` and a distinct logging
			// name cannot have both — the key collides and one overwrites the other.
			// Reading it once, as the condition argument, is the interpretation that
			// always has a defined value; the planner uses it as the matcher.
			name: typeof item.name === "string" ? item.name : null,
		});
	}
	return {
		path,
		// `default_enabled` (`config.rs:435-437`) is the serde default, so an absent
		// `enabled` is `true` — the same rule Qoder's MCP reader needed for its own.
		enabled: table.enabled !== false,
		defaultTimeoutSecs: typeof table.default_timeout_secs === "number" ? table.default_timeout_secs : null,
		entries,
	};
}

/**
 * Both hook blocks: `config.toml`'s, and `<workspace>/.codewhale/hooks.toml`'s.
 *
 * **The project file is named whether or not it exists**, because its absence and
 * its presence mean different things and the report should be able to say which:
 * a project that has never written one is not a project whose hooks were missed.
 */
function readCodewhaleHookBlocks(
	config: Record<string, unknown> | null,
	configPath: string,
	home: string,
	cwd: string | undefined,
	skipped: CodewhaleSkipped[],
): CodewhaleHooksBlock[] {
	const blocks: CodewhaleHooksBlock[] = [];
	if (config !== null) {
		const table = config.hooks;
		if (table !== undefined && !isRecord(table)) {
			skipped.push({
				name: `${tildePath(home, configPath)} → hooks`,
				reason: "[hooks] is not a table, so no hook was read from it",
			});
		} else {
			const block = readCodewhaleHooks(table, tildePath(home, configPath));
			if (block !== null) blocks.push(block);
		}
	}
	if (cwd !== undefined) {
		const path = codewhaleProjectHooksPath(cwd);
		const content = readCodewhaleText(path);
		if (content.kind === "text") {
			let parsed: Record<string, unknown> = {};
			try {
				const value: unknown = Bun.TOML.parse(content.value);
				if (isRecord(value)) parsed = value;
				else skipped.push({ name: tildePath(home, path), reason: "not a TOML table, so no hook was read from it" });
			} catch {
				skipped.push({ name: tildePath(home, path), reason: "not parseable as TOML" });
			}
			const block = readCodewhaleHooks(parsed, tildePath(home, path));
			if (block !== null) blocks.push(block);
		} else if (content.kind === "unreadable") {
			skipped.push({ name: tildePath(home, path), reason: content.reason });
		}
	}
	return blocks;
}

/**
 * `<workspace>/.codewhale/anchors.md`, or `null`.
 *
 * Absent is silent, and that is the whole contract: a project that never wrote
 * one is not a failure and does not get a report line.
 */
function readAnchors(cwd: string, home: string, skipped: CodewhaleSkipped[]): string | null {
	const path = codewhaleProjectAnchorsPath(cwd);
	const content = readCodewhaleText(path);
	if (content.kind === "absent") return null;
	if (content.kind !== "text") {
		skipped.push({ name: tildePath(home, path), reason: content.reason });
		return null;
	}
	return content.value;
}
