// Qoder's user state, as read from one home: the settings layers and their
// merge, the scrub, the counts, and what is named and not opened.
// Long-form design notes: docs/dev/migration-sources.md

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord, parseJsonc, readSkillDirs, readText, tildePath } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";
import {
	QODER_DEFAULT_DIR,
	QODER_DESKTOP_DATA_DIR,
	QODER_DIR_NAME_REJECTIONS,
	QODER_MEMORY_ENTRY_PATTERN,
	QODER_MEMORY_INDEX_NAME,
	QODER_MERGE_SHALLOW,
	QODER_MERGE_UNION,
	QODER_PROTOTYPE_KEYS,
	type QoderEnv,
	type QoderSettingsSource,
	qoderAgentsMdPath,
	qoderConfigDir,
	qoderDesktopStorePath,
	qoderDirNameRejection,
	qoderLocalSettingsPath,
	qoderMemoryDir,
	qoderOtherConfigDir,
	qoderProjectMcpPath,
	qoderProjectSettingsPath,
	qoderProjectsDir,
	qoderSettingsPath,
	qoderSkillsDirs,
	qoderTreeHasContent,
} from "./qoder-home.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** One thing the walk found and did not carry over; `name` is a label rather than a resolved path, and never a value read out of a credential-shaped key. */
export interface QoderSkipped {
	name: string;
	reason: string;
}

/** A JSON document in the three states one can be in when it is on disk. */
type QoderJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/** A file's text, or why it is not available. `null` is never the answer. */
type QoderText = { kind: "text"; value: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/**
 * Qoder's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* of something, or a line
 * saying why neither happened. No field holds a credential and no field holds a
 * conversation.
 */
export interface RawQoder {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the home was resolved from, kept for the report. */
	env: QoderEnv;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The configuration home that answered: `$QODER_CONFIG_DIR` when set, else `<cli home or home>/<directory name>`; always a path and never a read. */
	configDir: string;
	/** The other build's configuration home, named whether or not it exists. */
	otherConfigDir: string;
	/** True when the home resolved above exists and holds something. */
	present: boolean;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Why `QODER_CONFIG_DIR_NAME` was not used, or `null`; the SDK throws on an invalid name, so this importer falls back to `.qoder` and reports the refusal. */
	rejectedDirName: string | null;
	/** `<home>/settings.json` — the **user** layer's path, whatever else was read. */
	settingsPath: string;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The settings layers that were found and parsed, in the order applied; kept so the report can say which file a key came from. */
	settingsLayers: QoderSettingsLayer[];
	/**
	 * Which layer last carried each top-level key, and where that layer's file is.
	 *
	 * The report's answer to "why does my project say something my user settings do
	 * not". See {@link mergeQoderSettings} for what "last carried" means and what it
	 * deliberately does not mean.
	 */
	provenance: MergedQoderSettings["provenance"];
	// Long-form design notes: docs/dev/migration-sources.md
	/** The merged settings document Qoder would run, or `null` when no layer was readable; this is the merge and not the user layer, and credential-shaped keys are already gone. */
	settings: Record<string, unknown> | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `<cwd>/.qoder/.mcp.json`, or `null` when there is no `cwd`; held as a path and nothing more, so the report can name the file a user who has one would otherwise find missing. */
	projectMcpPath: string | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `mcpServers` after the merge, copied without interpretation; the names are the union across the layers that had the key and each entry is whatever the last layer to mention that name said. */
	mcpServers: Record<string, unknown>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `settings.hooks`, verbatim and uninterpreted; the normalizer in `migrate-core.ts` knows this build's event names and turns an unknown event into a report line rather than a silent loss. */
	hooks: unknown;
	// Long-form design notes: docs/dev/migration-sources.md
	/** `<configDir>/AGENTS.md`, the standing instruction document, or `null`; the name is attested and this location is a chosen one. */
	agentsMd: string | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Memory entries and the index from `<home>/memory`, as {@link RawFile}s; the index is carried under its own name so the two do not collapse into one. */
	memory: RawFile[];
	/**
	 * Skills from {@link qoderSkillsDirs}, de-duplicated by folder name with the
	 * first root winning, which is Qoder's own precedence order.
	 */
	assets: RawFile[];
	/** A folder name answered by both skill roots; the second was not read. */
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/**
	 * How many session transcripts are on disk, none of them read.
	 *
	 * A count and not a list, because a list means parsing: see `qoder-session.ts`
	 * for what the transcript format would take to establish.
	 */
	sessionCount: number;
	/** How many project directories those sessions are spread across. */
	projectCount: number;
	/**
	 * The desktop application's SQLite store, **existence-checked only**, or
	 * `null` when no `appData` was supplied.
	 *
	 * The *name* is what a report may print. Nothing in this importer opens it.
	 */
	desktopStore: { path: string; exists: boolean } | null;
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: QoderSkipped[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** The largest depth a credential-shaped key is looked for at; a key deeper than this is left in place, the one thing the scan can get wrong. */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

// Long-form design notes: docs/dev/migration-sources.md
/** The one key name `looksLikeSecretName` misses that Qoder itself names: a case-insensitive `authorization`. */
const QODER_SECRET_KEY = /authorization/i;

// Long-form design notes: docs/dev/migration-sources.md
/** Settings keys whose value is a map from a user-chosen name to an entry: the six shallow keys plus `hooks`. The scrub drops credential-shaped keys inside an entry and never the entry itself. */
const QODER_ENTRY_MAP_KEYS: ReadonlySet<string> = new Set([...QODER_MERGE_SHALLOW, "hooks"]);

// Long-form design notes: docs/dev/migration-sources.md
/** Remove every credential-shaped key from a parsed document, recording each by path and never touching the value; the names go into `skipped` and the values are dropped. */
function scrubQoderCredentials(value: Record<string, unknown>, into: QoderSkipped[], prefix: string): void {
	const walk = (node: unknown, path: string[], depth: number): void => {
		if (!isRecord(node) || depth > MAX_CREDENTIAL_SCAN_DEPTH) return;
		for (const [key, nested] of Object.entries(node)) {
			if (QODER_SECRET_KEY.test(key) || looksLikeSecretName(key)) {
				// `file → key.path`, the shape every other line in a report uses. Written
				// as `file.key.path` it reads as one long filename, and the reader is
				// already inconsistent with itself here: the line a few hundred bytes
				// down reports a bad `mcpServers` as `<file> → mcpServers`.
				into.push({
					name: `${prefix} → ${[...path, key].join(".")}`,
					reason: "looks like a credential — name only, value never read",
				});
				delete node[key];
				continue;
			}
			// A map keyed by a name the user chose. The key above was still tested and
			// still deleted if it matched — `mcpServers` does not, and a settings file
			// whose top level carried `apiKey` still loses it. What is exempt is the
			// *next* level: these are the map's own keys, so each is stepped over and
			// only the entry's contents are scrubbed.
			if (QODER_ENTRY_MAP_KEYS.has(key)) {
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

// Long-form design notes: docs/dev/migration-sources.md
/** A file's text, or the reason it is not text; `statSync` first so absent and there-but-unreadable stay apart. */
function readQoderText(path: string): QoderText {
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
/** A JSON document with the two failures kept apart and one recovery attempted: plain `JSON.parse` first, then `parseJsonc` once, which is a strict superset of what either Qoder half accepts. */
function readQoderJson(path: string): QoderJson {
	const text = readQoderText(path);
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

/** The one line a settings document read through {@link parseJsonc} earns. */
const QODER_JSONC_RECOVERY =
	"not parseable as plain JSON — read anyway with comments and trailing commas stripped. Qoder's own SDK reader strips comments too; " +
	"a trailing comma is beyond it, and its desktop reader would have rejected this file outright";

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function qoderDirectoryEntries(dir: string): Dirent[] {
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
/** The memory entries in one memory directory, plus the index, as {@link RawFile}s; the project-scoped directory is not read here because this function has no `cwd`. */
function readQoderMemory(configDir: string, home: string, skipped: QoderSkipped[]): RawFile[] {
	const dir = qoderMemoryDir(configDir);
	if (!existsSync(dir)) return [];
	const files: RawFile[] = [];
	for (const entry of qoderDirectoryEntries(dir)) {
		if (!entry.isFile()) continue;
		const path = join(dir, entry.name);
		const lower = entry.name.toLowerCase();
		const isIndex = lower === QODER_MEMORY_INDEX_NAME.toLowerCase();
		if (!isIndex && !QODER_MEMORY_ENTRY_PATTERN.test(entry.name)) {
			skipped.push({
				name: `${tildePath(home, path)}`,
				reason:
					"not a Qoder memory entry — the product matches a dated YYYY-MM-DD.md name for an entry, and MEMORY.md for the index; " +
					"anything else in the directory is something this importer does not know how to read as a memory",
			});
			continue;
		}
		const content = readQoderText(path);
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
			detail: isIndex
				? "the index beside Qoder's dated memory entries — a list of what the agent is told to remember, in the product's own `- [title](file.md)` form"
				: "a dated Qoder memory entry; the product names these by the day they were written and loads the most recent first",
		});
	}
	return files;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<configDir>/AGENTS.md`, or `null` when there is nothing to import; absent is silent, the contract the other importers use for the same file. */
function readQoderAgentsMd(configDir: string, home: string, skipped: QoderSkipped[]): string | null {
	const path = qoderAgentsMdPath(configDir);
	const content = readQoderText(path);
	if (content.kind === "absent") return null;
	if (content.kind !== "text") {
		skipped.push({ name: tildePath(home, path), reason: content.reason });
		return null;
	}
	return content.value;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Skills from both candidate roots, the first root winning a name; a collision is recorded rather than dropped in silence. */
function readQoderSkills(
	configDir: string,
	home: string,
	skipped: QoderSkipped[],
): { assets: RawFile[]; collisions: RawQoder["assetCollisions"] } {
	const assets: RawFile[] = [];
	const collisions: RawQoder["assetCollisions"] = [];
	const claimed = new Map<string, string>();
	for (const dir of qoderSkillsDirs(configDir, home)) {
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
		// which is worth a line here because Qoder *defines* a skill as a
		// directory holding one — its own walker treats a directory as a skill only
		// when `join(dir, "SKILL.md")` is a file. A directory that is not one is
		// user content in a directory the agent reads, and silence there reads as
		// a miss.
		for (const entry of qoderDirectoryEntries(dir)) {
			if (!entry.isDirectory()) continue;
			if (claimed.has(entry.name)) continue;
			skipped.push({
				name: `${label}/${entry.name}`,
				reason: "a skill directory with no SKILL.md in it, which is not a skill Qoder loads",
			});
		}
	}
	return { assets, collisions };
}

// Long-form design notes: docs/dev/migration-sources.md
/** How many transcripts are on disk, spread across how many projects, and how many bytes in total; none of them opened, and a project with no transcript is counted apart. */
export function countQoderSessions(
	configDir: string,
	skipped: QoderSkipped[],
): { sessions: number; projects: number; bytes: number } {
	const projectsDir = qoderProjectsDir(configDir);
	if (!existsSync(projectsDir)) return { sessions: 0, projects: 0, bytes: 0 };
	let sessions = 0;
	let projects = 0;
	let bytes = 0;
	let emptyProjects = 0;
	for (const project of qoderDirectoryEntries(projectsDir)) {
		if (!project.isDirectory()) continue;
		projects += 1;
		let inThisProject = 0;
		for (const file of qoderDirectoryEntries(join(projectsDir, project.name))) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			inThisProject += 1;
			sessions += 1;
			try {
				bytes += statSync(join(projectsDir, project.name, file.name)).size;
			} catch {
				// Measured on a best-effort basis: the file left between the listing
				// and the stat. It is still counted, because it was there a moment
				// ago and the count is what the report leads with.
			}
		}
		if (inThisProject === 0) emptyProjects += 1;
	}
	if (emptyProjects > 0) {
		skipped.push({
			name: "projects/",
			reason:
				`${emptyProjects} of ${projects} project director${emptyProjects === 1 ? "y holds" : "ies hold"} no .jsonl transcript — ` +
				"a project directory the product creates per working directory, so one with nothing in it is a project that was set up and never had a session in it",
		});
	}
	return { sessions, projects, bytes };
}

/**
 * One settings file that was found and parsed, with the layer it stands for.
 *
 * The layer names are `oc`'s: `["user","project","local"]`, which is the SDK's
 * **default** `settingSources`, so a Qoder with all three files present is running
 * on their merge and not on any one of them.
 */
export interface QoderSettingsLayer {
	source: QoderSettingsSource;
	path: string;
	settings: Record<string, unknown>;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The merge, and who said what: `provenance` is the SDK's own record and names the last layer that carried a key, not the layer whose value survived. */
export interface MergedQoderSettings {
	settings: Record<string, unknown>;
	provenance: Record<string, { source: QoderSettingsSource; path: string }>;
}

const QODER_MERGE_SHALLOW_SET = new Set(QODER_MERGE_SHALLOW);
const QODER_MERGE_UNION_SET = new Set(QODER_MERGE_UNION);
const QODER_PROTOTYPE_SET = new Set(QODER_PROTOTYPE_KEYS);

/** `Ie` — a structural copy that leaves primitives alone. */
function qoderCloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(qoderCloneValue);
	if (isRecord(value)) return qoderCloneRecord(value);
	return value;
}

/** `Et` — a structural copy that drops `undefined` and the three prototype keys. */
function qoderCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		if (QODER_PROTOTYPE_SET.has(key) || nested === undefined) continue;
		out[key] = qoderCloneValue(nested);
	}
	return out;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `pc`: the merge policy for one path within the document; the extra `providers` clause is carried because the product has it, and no path reaches it. */
function qoderMergePolicy(path: string[]): "shallow" | "union" | "concat" | undefined {
	const dotted = path.join(".");
	if (QODER_MERGE_SHALLOW_SET.has(dotted) || (path.length === 2 && path[0] === "providers")) return "shallow";
	if (QODER_MERGE_UNION_SET.has(dotted)) return "union";
	if (path.length === 2 && path[0] === "hooks") return "concat";
	return undefined;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `Rn`: fold one document into the accumulator, in place, reproduced statement for statement; the three shapes that look like bugs are reproduced rather than "fixed". */
function qoderMergeInto(target: Record<string, unknown>, source: Record<string, unknown>, path: string[] = []): void {
	for (const [key, value] of Object.entries(source)) {
		if (QODER_PROTOTYPE_SET.has(key) || value === undefined) continue;
		const here = [...path, key];
		const policy = qoderMergePolicy(here);
		const existing = target[key];
		if (policy === "shallow" && existing && value) {
			const merged: Record<string, unknown> = {};
			if (isRecord(existing)) Object.assign(merged, qoderCloneRecord(existing));
			if (isRecord(value)) Object.assign(merged, qoderCloneRecord(value));
			target[key] = merged;
			continue;
		}
		if (Array.isArray(existing)) {
			const incoming = Array.isArray(value) ? value : [value];
			if (policy === "concat") {
				target[key] = [...existing.map(qoderCloneValue), ...incoming.map(qoderCloneValue)];
				continue;
			}
			if (policy === "union") {
				target[key] = [...new Set([...existing, ...incoming])].map(qoderCloneValue);
				continue;
			}
		}
		if (isRecord(existing) && isRecord(value)) qoderMergeInto(existing, value, here);
		else if (isRecord(value)) {
			const fresh: Record<string, unknown> = {};
			qoderMergeInto(fresh, value, here);
			target[key] = fresh;
		} else {
			target[key] = qoderCloneValue(value);
		}
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The three layers, applied in order, as what Qoder would actually be running; exported because every merge claim is a claim about this function. */
export function mergeQoderSettings(layers: QoderSettingsLayer[]): MergedQoderSettings {
	const settings: Record<string, unknown> = {};
	const provenance: MergedQoderSettings["provenance"] = {};
	for (const layer of layers) {
		qoderMergeInto(settings, layer.settings);
		for (const key of Object.keys(layer.settings)) {
			if (QODER_PROTOTYPE_SET.has(key)) continue;
			provenance[key] = { source: layer.source, path: layer.path };
		}
	}
	return { settings, provenance };
}

// Long-form design notes: docs/dev/migration-sources.md
/** The file a settings key's value came from, as a report may print it; falls back to the user layer's path for a key no layer carried by name. */
export function qoderSettingsOrigin(
	home: string,
	provenance: MergedQoderSettings["provenance"],
	key: string,
	fallback: string,
): string {
	const path = provenance[key]?.path;
	return tildePath(home, path ?? fallback);
}

// Long-form design notes: docs/dev/migration-sources.md
/** The file that carried a sub-key, a finer question than {@link qoderSettingsOrigin} asks; only the label is narrowed, and `fallback` answers when no layer holds `key.subkey`. */
export function qoderSettingsSubkeyOrigin(
	home: string,
	layers: QoderSettingsLayer[],
	key: string,
	subkey: string,
	fallback: string,
	fallbackSource: QoderSettingsSource,
): { path: string; source: QoderSettingsSource } {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const container = layers[index].settings[key];
		if (isRecord(container) && subkey in container)
			return { path: tildePath(home, layers[index].path), source: layers[index].source };
	}
	return { path: fallback, source: fallbackSource };
}

// Long-form design notes: docs/dev/migration-sources.md
/** The layers that exist, in `QODER_SETTINGS_SOURCES` order; a missing file is not an error, and the `fc` shortcut that reads fewer than three is reproduced. */
function readQoderLayers(
	home: string,
	cwd: string | undefined,
	configDir: string,
	env: QoderEnv,
	skipped: QoderSkipped[],
): QoderSettingsLayer[] {
	const layers: QoderSettingsLayer[] = [];
	const read = (source: QoderSettingsSource, path: string): void => {
		const document = readQoderJson(path);
		if (document.kind === "invalid") {
			skipped.push({ name: tildePath(home, path), reason: document.reason });
			return;
		}
		if (document.kind === "absent") return;
		if (document.recovered) skipped.push({ name: tildePath(home, path), reason: QODER_JSONC_RECOVERY });
		layers.push({ source, path, settings: document.value });
	};

	read("user", qoderSettingsPath(configDir));
	if (cwd === undefined) return layers;

	const cliHome = env.QODER_CLI_HOME?.trim();
	const resolvedCliHome = resolve(cwd, cliHome !== undefined && cliHome !== "" ? cliHome : home);
	if (resolvedCliHome === resolve(cwd)) return layers;

	read("project", qoderProjectSettingsPath(cwd, env));
	read("local", qoderLocalSettingsPath(cwd, env));
	return layers;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Read one Qoder home; pure with respect to `home`, `cwd` and `env`, and the skipped lines come back sorted by name. */
export function readQoder(
	home: string,
	cwd: string | undefined,
	env: QoderEnv = process.env,
	appData?: string,
): RawQoder {
	const configDir = qoderConfigDir(home, env);
	const skipped: QoderSkipped[] = [];

	const layers = readQoderLayers(home, cwd, configDir, env, skipped);
	// The scrub runs on each layer **before** the merge, not on the merged result.
	// That ordering is the one that keeps a credential out: `mcpServers` merges one
	// level deep, so a token in a layer that a later layer partly overrode is
	// still walked and still dropped, whereas scrubbing only the merge's output
	// would leave that copy in `layers` — where nothing reads it again, but where
	// `provenance` could still name its file.
	for (const layer of layers) scrubQoderCredentials(layer.settings, skipped, tildePath(home, layer.path));
	const merged = mergeQoderSettings(layers);
	const settings = layers.length > 0 ? merged.settings : null;

	// `mcpServers` and `hooks` are **read, not moved**: they stay in the merged
	// document, because `planQoder` is what decides they are handled and because a
	// reader that deleted them would make `reportUnhandledKeys` name them as
	// unhandled, which is the opposite of the truth.
	const mcpServers = settings !== null && isRecord(settings.mcpServers) ? settings.mcpServers : {};
	if (settings !== null && "mcpServers" in settings && !isRecord(settings.mcpServers)) {
		skipped.push({
			name: `${qoderSettingsOrigin(home, merged.provenance, "mcpServers", qoderSettingsPath(configDir))} → mcpServers`,
			reason: "mcpServers is not a JSON object, so no server was read from it",
		});
	}
	const hooks = settings === null ? undefined : settings.hooks;

	const memory = readQoderMemory(configDir, home, skipped);
	const agentsMd = readQoderAgentsMd(configDir, home, skipped);
	const { assets, collisions } = readQoderSkills(configDir, home, skipped);
	const { sessions, projects } = countQoderSessions(configDir, skipped);

	// The desktop store is *named*, never opened. `appData` is an explicit
	// argument rather than a `process.env` read at this call site so a test can
	// hand it a fixture and so the reader stays pure with respect to `home` and
	// `env` — the same reason those two are parameters. It defaults to the real
	// `%APPDATA%` only on the platform that has one; elsewhere there is no such
	// store and the field stays `null` rather than naming a path that would never
	// exist.
	const desktopRoot = appData ?? (process.platform === "win32" ? process.env.APPDATA : undefined);
	const desktopStore =
		desktopRoot === undefined
			? null
			: {
					path: qoderDesktopStorePath(desktopRoot, QODER_DESKTOP_DATA_DIR),
					exists: existsSync(qoderDesktopStorePath(desktopRoot, QODER_DESKTOP_DATA_DIR)),
				};

	const rejection = qoderDirNameRejection(env);
	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		env,
		configDir,
		otherConfigDir: qoderOtherConfigDir(home, configDir),
		present: existsSync(configDir) && qoderTreeHasContent(configDir),
		rejectedDirName:
			rejection === null
				? null
				: `QODER_CONFIG_DIR_NAME is set to a value Qoder itself refuses — ${QODER_DIR_NAME_REJECTIONS[rejection]} — so the SDK throws before it reads anything, and this import fell back to ${QODER_DEFAULT_DIR}`,
		settingsPath: qoderSettingsPath(configDir),
		settingsLayers: layers,
		provenance: merged.provenance,
		settings,
		projectMcpPath: cwd === undefined ? null : qoderProjectMcpPath(cwd),
		mcpServers,
		hooks,
		agentsMd,
		memory,
		assets,
		assetCollisions: collisions,
		sessionCount: sessions,
		projectCount: projects,
		desktopStore: desktopStore,
		skipped,
	};
}
