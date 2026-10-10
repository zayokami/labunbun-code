// Codewhale's user state, as read from a home directory: the two roots, the five
// settings documents, the credential scrub, skills, sessions and hooks.
// Long-form design notes: docs/dev/migration-sources.md

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

// Long-form design notes: docs/dev/migration-sources.md
/** One rule from `permissions.toml`, the one settings document carried whole. */
export interface CodewhalePermissionRule {
	tool: string;
	command?: string;
	commandExact: boolean;
	path?: string;
	workspace?: string;
	action: "allow" | "ask" | "deny" | "other";
}

// Long-form design notes: docs/dev/migration-sources.md
/** One entry from Codewhale's `[hooks]` table; `condition` decides whether it can be imported. */
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
	// Long-form design notes: docs/dev/migration-sources.md
	/** True when the resolved tree holds something; not only when a settings file was read. */
	present: boolean;
	/** Why `CODEWHALE_HOME` was refused, or `null`. */
	rejectedHome: string | null;
	/** The five settings documents, with the paths they were looked for at. */
	configPath: string;
	permissionsPath: string;
	settingsPath: string;
	/** `tui.toml` — superseded, named, never read. */
	tuiPrefsPath: string;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Where each state document resolved, and which root answered. */
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
	// Long-form design notes: docs/dev/migration-sources.md
	/** `[hooks]` from `config.toml` and the project hooks file, as two blocks rather than one merge. */
	hooks: CodewhaleHooksBlock[];
	/**
	 * The servers from `mcp.json`, keyed by name.
	 *
	 * Read from `servers`, or from `mcpServers` when the canonical name is absent —
	 * see {@link CODEWHALE_MCP_SERVERS_KEY}. Credentials inside an entry are
	 * already gone; see {@link scrubCodewhaleCredentials}.
	 */
	mcpServers: Record<string, unknown>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `~/.codewhale/mcp.json` and whether it was there; held as a path because no project MCP file exists. */
	mcpPath: string;
	mcpPresent: boolean;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The user-global instruction documents, in the product's precedence, first copy of each basename winning. */
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
	// Long-form design notes: docs/dev/migration-sources.md
	/** The shared `~/.agents` paths Codewhale reads and this importer does not; the `agents` source owns them. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Key names `looksLikeSecretName` does not catch. */
const CODEWHALE_SECRET_KEY = /authorization/i;

// Long-form design notes: docs/dev/migration-sources.md
/** Top-level keys that are maps from a user-chosen name to an entry. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Keys whose values are credentials whatever the key is called. */
const CODEWHALE_CREDENTIAL_TABLE_KEYS: ReadonlySet<string> = new Set([
	"http_headers",
	...CODEWHALE_MCP_CREDENTIAL_KEYS,
	"env_headers",
	"env_http_headers",
]);

// Long-form design notes: docs/dev/migration-sources.md
/** Keys whose value is a URL that can carry a credential, checked with {@link urlCredentialProblem}. */
const CODEWHALE_URL_KEYS: ReadonlySet<string> = new Set(["base_url", "sandbox_url", "origin"]);

// Long-form design notes: docs/dev/migration-sources.md
/** The largest depth a credential-shaped key is looked for at; deeper keys stay in place. */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

/** The one line a JSON document read through `parseJsonc` earns. */
const CODEWHALE_JSONC_RECOVERY =
	"not parseable as plain JSON — read anyway with comments and trailing commas stripped. The file's own reader is a strict " +
	"JSON parser, so it would have rejected this document outright";

// Long-form design notes: docs/dev/migration-sources.md
/** Remove every credential from a parsed document, recording each by path, in three mechanisms. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** A file's text, or the reason it is not text; `statSync` first keeps absent and unreadable apart. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** A JSON document, with the two failures kept apart and one recovery attempted. */
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

// Long-form design notes: docs/dev/migration-sources.md
/**
 * A TOML document, with the same numeric-key retry `step-read.ts` and
 * `grok-read.ts` document; the failure line is a fixed phrase, never the
 * parser's message.
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

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `~/.codewhale/AGENTS.md`, `~/.deepseek/AGENTS.md` and the `instructions.md`
 * pair, in the product's own precedence, first copy of each basename winning;
 * `.agents` rows are named instead and collisions are recorded.
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

// Long-form design notes: docs/dev/migration-sources.md
/** The deprecated `WHALE.md` files, named and not read; the product reads one only to warn. */
function findCodewhaleDeprecatedDocuments(home: string, resolved: CodewhaleHome): string[] {
	const found: string[] = [];
	for (const [root, name] of CODEWHALE_GLOBAL_DOCUMENTS) {
		const base = root === ".agents" ? home : root === CODEWHALE_LEGACY_DIR ? resolved.legacyRoot : resolved.root;
		const path = join(base, name);
		if (existsSync(path)) found.push(tildePath(home, path));
	}
	return found;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<workspace>/.codewhale/rules/*.md`, in filename order; `md` is the only extension read. */
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

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Skills from the roots Codewhale owns, first root winning a name and
 * collisions recorded; `~/.agents/skills` is not among them, by the same
 * exclusion as {@link RawCodewhale.sharedTree}.
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

// Long-form design notes: docs/dev/migration-sources.md
/** The `servers` map out of `mcp.json`, or `{}`; `mcpServers` is the alias. */
function readCodewhaleMcpServers(document: CodewhaleJson): Record<string, unknown> {
	if (document.kind !== "object") return {};
	const container = document.value[CODEWHALE_MCP_SERVERS_KEY];
	if (isRecord(container)) return container;
	const alias = document.value[CODEWHALE_MCP_SERVERS_ALIAS];
	return isRecord(alias) ? alias : {};
}

// Long-form design notes: docs/dev/migration-sources.md
/**
 * `permissions.toml`'s rules, in file order, with the ones this build cannot
 * carry named rather than dropped; the document is `deny_unknown_fields` for
 * the product too.
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

// Long-form design notes: docs/dev/migration-sources.md
/**
 * Read one Codewhale home. Pure with respect to everything outside `home`,
 * `cwd` and `env`; `skipped` is sorted by name before it is returned, and
 * nothing short-circuits.
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
	// Long-form design notes: docs/dev/migration-sources.md
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

// Long-form design notes: docs/dev/migration-sources.md
/** The field each `HookCondition` variant carries, on the hook table beside `condition`. */
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
