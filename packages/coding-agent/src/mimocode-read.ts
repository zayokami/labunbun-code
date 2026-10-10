// MiMo Code's user state, as read from a home directory: the settings layers
// and merge, the credential scrub, the asset walks, and the read entry point.
// Long-form design notes: docs/dev/migration-sources.md

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isRecord, parseJsonc, readCommandFiles, readSkillDirs, readText, tildePath } from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";
import {
	MIMOCODE_AGENT_DIRS,
	MIMOCODE_COMMAND_DIRS,
	MIMOCODE_CREDENTIAL_FILES,
	MIMOCODE_ENTRY_MAP_KEYS,
	MIMOCODE_LEGACY_KEYS,
	MIMOCODE_MEMORY_SCOPES,
	MIMOCODE_MODE_DIRS,
	MIMOCODE_NON_CREDENTIAL_SUBTREES,
	MIMOCODE_PLUGIN_DIRS,
	MIMOCODE_SETTINGS_FILES,
	MIMOCODE_SKILL_DIRS,
	MIMOCODE_TUI_FILES,
	type MiMoCodeEnv,
	type MiMoCodeRoots,
	mimocodeAssetDirs,
	mimocodeClaudeCommandRoots,
	mimocodeDatabasePath,
	mimocodeDatabaseSidecars,
	mimocodeEntryName,
	mimocodeGlobalInstructionPaths,
	mimocodeReadRoots,
	mimocodeRoots,
} from "./mimocode-home.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** One thing the walk found and did not carry over, with the reason. */
export interface MiMoCodeSkipped {
	name: string;
	reason: string;
}

/** A JSON document in the three states one can be in when it is on disk. */
type MiMoCodeJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/** A file's text, or why it is not available. `null` is never the answer. */
type MiMoCodeText = { kind: "text"; value: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/** Which of MiMo Code's settings files a layer came from. */
export type MiMoCodeSettingsSource =
	| "global-config-json"
	| "global-mimocode-json"
	| "global-mimocode-jsonc"
	| "custom-file"
	| "project";

// Long-form design notes: docs/dev/migration-sources.md
/** One settings file that was found and parsed, with the layer it stands for — see {@link MIMOCODE_SETTINGS_FILES}. */
export interface MiMoCodeSettingsLayer {
	source: MiMoCodeSettingsSource;
	path: string;
	settings: Record<string, unknown>;
}

/** The merge, and who said what. */
export interface MergedMiMoCodeSettings {
	settings: Record<string, unknown>;
	provenance: Record<string, { source: MiMoCodeSettingsSource; path: string }>;
}

/**
 * MiMo Code's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* of something, or a line
 * saying why neither happened. No field holds a credential and no field holds a
 * conversation.
 */
export interface RawMiMoCode {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the home was resolved from, kept for the report. */
	env: MiMoCodeEnv;
	/** The directory being migrated into; `null` when the caller supplied none. */
	cwd: string | null;
	/** The four roots, each with the rule that decided it. */
	roots: MiMoCodeRoots;
	/** Every directory the asset walk visited, in the product's precedence order. */
	readRoots: string[];
	/** True when any of the four roots exists and holds something. */
	present: boolean;
	/** Why `$MIMOCODE_HOME` was refused, or `null`. See {@link MiMoCodeRoots.rejectedHome}. */
	rejectedHome: string | null;
	/** The settings layers that were found and parsed, in the order applied. */
	settingsLayers: MiMoCodeSettingsLayer[];
	/** Which layer last carried each top-level key, and where that layer's file is. */
	provenance: MergedMiMoCodeSettings["provenance"];
	// Long-form design notes: docs/dev/migration-sources.md
	/** The merged settings document MiMo Code would actually be running, or `null` when no layer was readable. */
	settings: Record<string, unknown> | null;
	/** `mcp` after the merge, copied without interpretation. */
	mcpServers: Record<string, unknown>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The legacy keys {@link MIMOCODE_LEGACY_KEYS} found in the merged document, each with the file that carried it. */
	legacyKeys: Array<{ key: string; path: string }>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `<config>/tui.json` | `tui.jsonc` — the TUI's own document, or `null` when there is none. */
	tui: { path: string; keys: number } | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `$MIMOCODE_TUI_CONFIG` — named whether or not it exists, never read. */
	tuiConfigEnvPath: string | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The standing instruction document — `AGENTS.md` from the first of {@link mimocodeGlobalInstructionPaths} that has one — or `null`. */
	agentsMd: string | null;
	/** The path {@link RawMiMoCode.agentsMd} came from, or `null`. */
	agentsMdPath: string | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Memory entries from `<data>/memory/{global,projects,sessions}/…`, as {@link RawFile}s. */
	memory: RawFile[];
	/**
	 * Skills, de-duplicated by **path-relative** name with the **last** root
	 * winning, which is MiMo Code's own precedence (`mimocodeReadRoots`'s comment).
	 */
	assets: RawFile[];
	/** A skill name answered by more than one root; the earlier ones were not read. */
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/** Agent markdown files, named path-relative by {@link mimocodeEntryName}. */
	agents: RawFile[];
	/**
	 * Mode markdown file **names** — `{mode,modes}/*.md`, `config/agent.ts:166` —
	 * and nothing else.
	 *
	 * **Counted and named, never read.** A mode is the agent that handles a
	 * posture rather than a persona (`config/config.ts:181-189` describes `mode`
	 * as `{build: AgentRef, plan: AgentRef}` and marks it `@deprecated`), and a
	 * subagent file here has no field for a posture. Reading the bodies would mean
	 * importing an agent definition whose activation rule was thrown away.
	 */
	modes: string[];
	/** Command markdown files, which become skills through `planCommands`. */
	commands: RawCommands;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Plugin entry points — file names, never contents. */
	plugins: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** The session database, **existence-checked only**, or `null` when the install keeps none of the names MiMo Code does. */
	database: { path: string; exists: boolean; sidecars: string[] } | null;
	/** How many sessions the database holds, or 0 when it was not opened. */
	sessionCount: number;
	/** How many distinct `directory` values those sessions ran in. */
	projectCount: number;
	/** The database's table names, read from `sqlite_master`. Never a row. */
	databaseTables: string[];
	/**
	 * The credential-bearing files and tables, **named and existence-checked**.
	 *
	 * Never opened, and no value under any of them is read. See
	 * {@link MIMOCODE_CREDENTIAL_FILES} and {@link MIMOCODE_CREDENTIAL_TABLES}.
	 */
	credentials: Array<{ path: string; exists: boolean; holds: string }>;
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: MiMoCodeSkipped[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** A file's text, or the reason it is not text. */
function readMiMoCodeText(path: string): MiMoCodeText {
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
/** A JSONC document, with the two failures kept apart and one recovery attempted. */
function readMiMoCodeJson(path: string): MiMoCodeJson {
	const text = readMiMoCodeText(path);
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
				"not parseable as JSON or JSONC — comments and trailing commas have already been taken out, so the text is damaged rather than decorated",
		};
	}
}

/** The one line a settings document read through {@link parseJsonc} earns. */
const MIMOCODE_JSONC_RECOVERY =
	"read with its comments and trailing commas stripped — MiMo Code parses every settings file as JSONC " +
	"(config/parse.ts:9, jsonc-parser with allowTrailingComma), so both were legal in it";

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function mimocodeDirectoryEntries(dir: string): Dirent[] {
	try {
		return [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		// An absent or unreadable directory is not an error here: most of the ones
		// this module looks for are optional, and the caller reports the absence of
		// the thing they were for, not the absence of the directory.
		return [];
	}
}

// ---------------------------------------------------------------------------
// The credential scrub
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** The largest depth a credential-shaped key is looked for at. */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

// Long-form design notes: docs/dev/migration-sources.md
/** Key names `looksLikeSecretName` does not catch. */
const MIMOCODE_SECRET_KEY = /^(?:authorization|bearer)$/i;

// Long-form design notes: docs/dev/migration-sources.md
/** Config keys that {@link looksLikeSecretName} matches and that are **not** credentials. */
const MIMOCODE_NON_SECRET_KEYS: ReadonlySet<string> = new Set(MIMOCODE_LEGACY_KEYS);

// Long-form design notes: docs/dev/migration-sources.md
/** Remove every credential-shaped key from a parsed document, recording each by path and never touching the value. */
function scrubMiMoCodeCredentials(value: Record<string, unknown>, into: MiMoCodeSkipped[], prefix: string): void {
	const walk = (node: unknown, path: string[], depth: number): void => {
		if (!isRecord(node) || depth > MAX_CREDENTIAL_SCAN_DEPTH) return;
		for (const [key, nested] of Object.entries(node)) {
			// The exemption is tested **first**: `keybinds` matches `looksLikeSecretName`
			// and must not be deleted. See {@link MIMOCODE_NON_SECRET_KEYS}.
			if (!MIMOCODE_NON_SECRET_KEYS.has(key) && (MIMOCODE_SECRET_KEY.test(key) || looksLikeSecretName(key))) {
				into.push({
					name: `${prefix} → ${[...path, key].join(".")}`,
					reason: "looks like a credential — name only, value never read",
				});
				delete node[key];
				continue;
			}
			// Long-form design notes: docs/dev/migration-sources.md
			if (MIMOCODE_NON_CREDENTIAL_SUBTREES.has(key)) continue;
			if (MIMOCODE_ENTRY_MAP_KEYS.has(key)) {
				if (!isRecord(nested)) continue;
				for (const [entryName, entry] of Object.entries(nested)) {
					walk(entry, [...path, key, entryName], depth + 1);
				}
				continue;
			}
			walk(nested, [...path, key], depth + 1);
		}
	};
	walk(value, [], 0);
}

// ---------------------------------------------------------------------------
// The settings merge
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** `remeda`'s `mergeDeep`, as `config/config.ts:54` uses it, plus the one array exception `mergeConfigConcatArrays` makes (`config/config.ts:52-58`). */
function mimocodeMergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const existing = target[key];
		// An array is a **leaf** for every key but one. `mergeConfigConcatArrays`
		// (`config/config.ts:52-58`) adds its single exception back afterwards:
		// `merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))`.
		if (key === "instructions" && Array.isArray(existing) && Array.isArray(value)) {
			target[key] = [...new Set([...existing, ...value])];
			continue;
		}
		if (isRecord(existing) && isRecord(value)) {
			mimocodeMergeInto(existing, cloneValue(value) as Record<string, unknown>);
			continue;
		}
		target[key] = cloneValue(value);
	}
}

/** A structural copy that leaves primitives alone — `cloneValue` is remeda's `clone`. */
function cloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneValue);
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) {
			if (nested === undefined) continue;
			out[key] = cloneValue(nested);
		}
		return out;
	}
	return value;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The layers, applied in order — what MiMo Code would actually be running. */
export function mergeMiMoCodeSettings(layers: MiMoCodeSettingsLayer[]): MergedMiMoCodeSettings {
	const settings: Record<string, unknown> = {};
	const provenance: MergedMiMoCodeSettings["provenance"] = {};
	for (const layer of layers) {
		mimocodeMergeInto(settings, layer.settings);
		for (const key of Object.keys(layer.settings)) provenance[key] = { source: layer.source, path: layer.path };
	}
	return { settings, provenance };
}

// Long-form design notes: docs/dev/migration-sources.md
/** The file a settings key's value came from, as a report may print it. */
export function mimocodeSettingsOrigin(home: string, raw: RawMiMoCode, key: string): string {
	return tildePath(home, raw.provenance[key]?.path ?? raw.settingsLayers[0]?.path ?? raw.roots.config);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The file that carried a **sub-key**, a finer question than {@link mimocodeSettingsOrigin} asks. */
export function mimocodeSettingsSubkeyOrigin(
	home: string,
	raw: RawMiMoCode,
	key: string,
	subkey: string,
): { path: string; source: MiMoCodeSettingsSource } {
	for (let index = raw.settingsLayers.length - 1; index >= 0; index -= 1) {
		const layer = raw.settingsLayers[index];
		const container = layer.settings[key];
		if (isRecord(container) && subkey in container) return { path: tildePath(home, layer.path), source: layer.source };
	}
	const fallback = raw.provenance[key];
	return {
		path: tildePath(home, fallback?.path ?? raw.settingsLayers[0]?.path ?? raw.roots.config),
		source: fallback?.source ?? "global-config-json",
	};
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Every `.md` at any depth under `dir`, named by {@link mimocodeEntryName}. */
function readMiMoCodeMarkdown(dir: string): RawFile[] {
	const files: RawFile[] = [];
	const walk = (current: string, prefix: string): void => {
		for (const entry of mimocodeDirectoryEntries(current)) {
			const path = join(current, entry.name);
			if (entry.isFile()) {
				if (!entry.name.toLowerCase().endsWith(".md")) continue;
				const content = readText(path);
				if (content === null) continue;
				files.push({
					name: mimocodeEntryName(prefix === "" ? entry.name : `${prefix}/${entry.name}`),
					sourcePath: path,
					content,
				});
				continue;
			}
			if (!entry.isDirectory()) continue;
			walk(path, prefix === "" ? entry.name : `${prefix}/${entry.name}`);
		}
	};
	walk(dir, "");
	return files;
}

/** Skills from every root, de-duplicated with the **last** root winning. */
function readMiMoCodeSkills(
	readRoots: string[],
	home: string,
	_skipped: MiMoCodeSkipped[],
): { assets: RawFile[]; collisions: RawMiMoCode["assetCollisions"] } {
	const assets: RawFile[] = [];
	const collisions: RawMiMoCode["assetCollisions"] = [];
	const claimed = new Map<string, string>();
	// Long-form design notes: docs/dev/migration-sources.md
	for (const root of readRoots) {
		for (const dir of mimocodeAssetDirs(root, MIMOCODE_SKILL_DIRS)) {
			if (!existsSync(dir)) continue;
			const label = tildePath(home, dir);
			for (const skill of readSkillDirs(dir)) {
				const earlier = claimed.get(skill.name);
				if (earlier !== undefined) {
					collisions.push({ name: skill.name, kept: label, dropped: earlier });
					assets.splice(
						assets.findIndex((one) => one.name === skill.name),
						1,
					);
				}
				claimed.set(skill.name, label);
				assets.push(skill);
			}
		}
	}
	// Re-sorted into root order so two runs over one install agree.
	assets.sort((a, b) => a.name.localeCompare(b.name));
	return { assets, collisions };
}

/** The memory entries under `<data>/memory`, as {@link RawFile}s, scope-aware. */
function readMiMoCodeMemory(dataRoot: string, home: string, skipped: MiMoCodeSkipped[]): RawFile[] {
	const root = join(dataRoot, "memory");
	if (!existsSync(root)) return [];
	const files: RawFile[] = [];
	for (const scope of MIMOCODE_MEMORY_SCOPES) {
		const scopeDir = join(root, scope);
		if (!existsSync(scopeDir)) continue;
		// `global` has no id segment (`memory/paths.ts:50`), the other two have one,
		// and the key itself may nest. Both shapes are walked here rather than
		// assumed, so a `global/` directory that somehow holds subdirectories still
		// yields its entries instead of being reported as empty.
		const stack: string[] = [scopeDir];
		while (stack.length > 0) {
			const dir = stack.shift() as string;
			for (const entry of mimocodeDirectoryEntries(dir)) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					stack.push(path);
					continue;
				}
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
					skipped.push({
						name: tildePath(home, path),
						reason:
							"not a MiMo Code memory entry — memory/paths.ts:47 matches `/memory/(global|projects|sessions)/<key>.md`, " +
							"so anything else in the tree is something this importer does not know how to read as a memory",
					});
					continue;
				}
				const content = readText(path);
				if (content === null) {
					skipped.push({ name: tildePath(home, path), reason: "present but unreadable" });
					continue;
				}
				const relativePath = relative(scopeDir, path).replace(/\\/g, "/");
				const id = scope === "global" ? "" : dir === scopeDir ? entry.name.split(".")[0] : relativePath.split("/")[0];
				files.push({
					name: relativePath,
					sourcePath: path,
					content,
					detail: `a ${scope}-scoped MiMo Code memory entry (memory/paths.ts:47-53)${
						id === "" ? "" : `, filed under "${id}"`
					}`,
				});
			}
		}
	}
	return files;
}

/** The standing instruction document, or `null` when there is nothing to import. */
function readMiMoCodeAgentsMd(
	roots: MiMoCodeRoots,
	home: string,
	env: MiMoCodeEnv,
	skipped: MiMoCodeSkipped[],
): { text: string | null; path: string | null } {
	for (const path of mimocodeGlobalInstructionPaths(roots.config, env.MIMOCODE_CONFIG_DIR)) {
		const content = readMiMoCodeText(path);
		if (content.kind === "absent") continue;
		if (content.kind !== "text") {
			skipped.push({ name: tildePath(home, path), reason: content.reason });
			return { text: null, path: null };
		}
		return { text: content.value, path };
	}
	return { text: null, path: null };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** Read one MiMo Code home. */
export function readMiMoCode(home: string, cwd: string | undefined, env: MiMoCodeEnv = process.env): RawMiMoCode {
	const roots = mimocodeRoots(home, env);
	const readRoots = mimocodeReadRoots(home, roots, cwd, env);
	const skipped: MiMoCodeSkipped[] = [];

	const layers = readMiMoCodeLayers(roots, readRoots, cwd, home, env, skipped);
	// The scrub runs on each layer **before** the merge, not on the merged result.
	// That ordering is the one that keeps a credential out: `mcp` merges all the way
	// down, so a token in a layer a later layer partly overrode is still walked and
	// still dropped, whereas scrubbing only the merge's output would leave that copy
	// in `layers` — where nothing reads it again, but where `provenance` could still
	// name its file.
	for (const layer of layers) scrubMiMoCodeCredentials(layer.settings, skipped, tildePath(home, layer.path));
	const merged = mergeMiMoCodeSettings(layers);
	const settings = layers.length > 0 ? merged.settings : null;

	const origin = (key: string): string =>
		tildePath(home, merged.provenance[key]?.path ?? layers[0]?.path ?? roots.config);

	const legacyKeys: RawMiMoCode["legacyKeys"] = [];
	for (const key of MIMOCODE_LEGACY_KEYS) {
		// Checked against the **merged** document, not each layer: what the user
		// needs to hear is that the key is present in what MiMo Code runs, and a key
		// a project layer carried that a later layer overwrote is not present.
		if (settings !== null && key in settings) legacyKeys.push({ key, path: origin(key) });
	}

	const mcpServers = settings !== null && isRecord(settings.mcp) ? settings.mcp : {};
	if (settings !== null && "mcp" in settings && !isRecord(settings.mcp)) {
		skipped.push({
			name: `${origin("mcp")} → mcp`,
			reason: "mcp is not a JSON object, so no server was read from it",
		});
	}

	const tui = readMiMoCodeTui(roots, home, skipped, env);
	const { text: agentsMd, path: agentsMdPath } = readMiMoCodeAgentsMd(roots, home, env, skipped);
	const { assets, collisions } = readMiMoCodeSkills(readRoots, home, skipped);
	const memory = readMiMoCodeMemory(roots.data, home, skipped);
	const agents = readMiMoCodeAgents(readRoots);
	const modes = readMiMoCodeModes(readRoots);
	const commands = readMiMoCodeCommands(readRoots, home, cwd);
	const plugins = readMiMoCodePlugins(readRoots);

	const databasePath = mimocodeDatabasePath(roots.data, env);
	const database =
		databasePath === null
			? null
			: {
					path: databasePath,
					exists: existsSync(databasePath),
					sidecars: mimocodeDatabaseSidecars(databasePath),
				};
	// The count is a *number*, and the only way to get one is to open the
	// database — which `mimocode-session.ts` does read-only and only when history
	// was asked for. Here it is left at 0 and the planner says so, because a
	// settings-only run has no business opening a live SQLite file the product is
	// writing to.
	const sessionCount = 0;
	const projectCount = 0;

	const credentials: RawMiMoCode["credentials"] = [];
	for (const name of MIMOCODE_CREDENTIAL_FILES) {
		const path = join(roots.data, name);
		credentials.push({
			path,
			exists: existsSync(path),
			holds:
				name === "auth.json"
					? "every provider key and OAuth refresh token in this install"
					: "per-server MCP OAuth entries",
		});
	}

	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		env,
		cwd: cwd ?? null,
		roots,
		readRoots,
		present: [roots.config, roots.data, roots.state, roots.cache].some(mimocodeTreeHasContent),
		rejectedHome: roots.rejectedHome,
		settingsLayers: layers,
		provenance: merged.provenance,
		settings,
		mcpServers,
		legacyKeys,
		tui,
		tuiConfigEnvPath: env.MIMOCODE_TUI_CONFIG ?? null,
		agentsMd,
		agentsMdPath,
		memory,
		assets,
		assetCollisions: collisions,
		agents,
		modes,
		commands,
		plugins,
		database,
		sessionCount,
		projectCount,
		databaseTables: [],
		credentials,
		skipped,
	};
}

/** A directory exists and holds something, as `sourceHasContent` reads it. */
function mimocodeTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The settings layers, in the order `loadGlobal` and `merge` apply them. */
function readMiMoCodeLayers(
	roots: MiMoCodeRoots,
	readRoots: string[],
	_cwd: string | undefined,
	home: string,
	env: MiMoCodeEnv,
	skipped: MiMoCodeSkipped[],
): MiMoCodeSettingsLayer[] {
	const layers: MiMoCodeSettingsLayer[] = [];
	const read = (source: MiMoCodeSettingsSource, path: string): void => {
		const document = readMiMoCodeJson(path);
		if (document.kind === "invalid") {
			skipped.push({ name: tildePath(home, path), reason: document.reason });
			return;
		}
		if (document.kind === "absent") return;
		if (document.recovered) skipped.push({ name: tildePath(home, path), reason: MIMOCODE_JSONC_RECOVERY });
		layers.push({ source, path, settings: document.value });
	};

	// **Spelled out as pairs rather than as two parallel arrays zipped by index.**
	// `noUncheckedIndexedAccess` makes a zipped lookup `T | undefined`, so the fix
	// would be a non-null assertion on a lookup whose failure mode is a silently
	// missing layer — and a silently missing layer is exactly what this reader's
	// whole merge exists to prevent. Three lines, no assertion, no failure mode.
	const globalFiles: ReadonlyArray<readonly [MiMoCodeSettingsSource, string]> = [
		["global-config-json", "config.json"],
		["global-mimocode-json", "mimocode.json"],
		["global-mimocode-jsonc", "mimocode.jsonc"],
	];
	for (const [source, name] of globalFiles) read(source, join(roots.config, name));

	const customFile = env.MIMOCODE_CONFIG;
	if (customFile !== undefined && customFile.trim() !== "") read("custom-file", customFile);

	// Nearest first in `readRoots` — `walkUp` returns deepest-first — and the
	// product applies them root-first, so the loop runs the list backwards.
	for (const dir of [...readRoots].reverse()) {
		if (dir === roots.config) continue;
		for (const name of ["mimocode.json", "mimocode.jsonc"]) read("project", join(dir, name));
	}
	return layers;
}

/** `<config>/tui.json(c)`, or `null`. Read, counted, and never claimed from. */
function readMiMoCodeTui(
	roots: MiMoCodeRoots,
	home: string,
	skipped: MiMoCodeSkipped[],
	env: MiMoCodeEnv,
): RawMiMoCode["tui"] {
	const custom = env.MIMOCODE_TUI_CONFIG;
	if (custom !== undefined && custom.trim() !== "") {
		const document = readMiMoCodeJson(custom);
		if (document.kind === "invalid") {
			skipped.push({ name: tildePath(home, custom), reason: document.reason });
			return null;
		}
		if (document.kind === "object") {
			if (document.recovered) skipped.push({ name: tildePath(home, custom), reason: MIMOCODE_JSONC_RECOVERY });
			return { path: custom, keys: Object.keys(document.value).length };
		}
	}
	for (const name of MIMOCODE_TUI_FILES) {
		const path = join(roots.config, name);
		const document = readMiMoCodeJson(path);
		if (document.kind === "invalid") {
			skipped.push({ name: tildePath(home, path), reason: document.reason });
			continue;
		}
		if (document.kind === "absent") continue;
		if (document.recovered) skipped.push({ name: tildePath(home, path), reason: MIMOCODE_JSONC_RECOVERY });
		return { path, keys: Object.keys(document.value).length };
	}
	return null;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Mode markdown file names under every root. Nothing is opened. */
function readMiMoCodeModes(readRoots: string[]): string[] {
	const names: string[] = [];
	for (const dir of readRoots) {
		for (const candidate of mimocodeAssetDirs(dir, MIMOCODE_MODE_DIRS)) {
			for (const entry of mimocodeDirectoryEntries(candidate)) {
				if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
				names.push(mimocodeEntryName(entry.name));
			}
		}
	}
	return [...new Set(names)].sort();
}

function readMiMoCodeAgents(readRoots: string[]): RawFile[] {
	const files: RawFile[] = [];
	const seen = new Set<string>();
	// Weakest first, for the same reason as the skills above — the product merges its
	// asset roots in `mimocodeReadRoots`'s order and a later one overwrites.
	for (const dir of readRoots) {
		for (const candidate of mimocodeAssetDirs(dir, MIMOCODE_AGENT_DIRS)) {
			if (!existsSync(candidate)) continue;
			for (const file of readMiMoCodeMarkdown(candidate)) {
				if (seen.has(file.name)) continue;
				seen.add(file.name);
				files.push(file);
			}
		}
	}
	files.sort((a, b) => a.name.localeCompare(b.name));
	return files;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Command markdown, from every root plus every `.claude` directory the product reads. */
function readMiMoCodeCommands(readRoots: string[], home: string, cwd: string | undefined): RawCommands {
	const files: RawFile[] = [];
	const skips: RawCommands["skips"] = [];
	const seen = new Set<string>();
	const claudeRoots = cwd === undefined ? [join(home, ".claude")] : mimocodeClaudeCommandRoots(home, cwd);
	// `.claude` first, then `.mimocode` roots weakest-first — so the first writer of
	// a name wins is wrong and the last must win, which is what the product does.
	for (const dir of [...claudeRoots, ...readRoots]) {
		for (const candidate of mimocodeAssetDirs(dir, MIMOCODE_COMMAND_DIRS)) {
			if (!existsSync(candidate)) continue;
			for (const found of readCommandFiles(candidate).files) {
				if (seen.has(found.name)) continue;
				seen.add(found.name);
				files.push(found);
			}
		}
	}
	files.sort((a, b) => a.name.localeCompare(b.name));
	return { files, skips };
}

/** Plugin entry-point **file names**, never contents. See {@link RawMiMoCode.plugins}. */
function readMiMoCodePlugins(readRoots: string[]): string[] {
	const names = new Set<string>();
	for (const dir of readRoots) {
		for (const candidate of mimocodeAssetDirs(dir, MIMOCODE_PLUGIN_DIRS)) {
			for (const entry of mimocodeDirectoryEntries(candidate)) {
				if (!entry.isFile() || !/\.(?:ts|js)$/i.test(entry.name)) continue;
				names.add(entry.name);
			}
		}
	}
	return [...names].sort();
}
