// Antigravity's user state, as read from a home directory. Every path claim lives
// in `antigravity-home.ts`, and no read here throws.
// Long-form design notes: docs/dev/migration-sources.md

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	ANTIGRAVITY_GEMINI_DIR,
	ANTIGRAVITY_NAMED_ONLY,
	antigravityConfigPath,
	antigravityConversationsDir,
	antigravityDataDirs,
	antigravityGeminiRoot,
	antigravityGlobalWorkflowsDir,
	antigravityMcpConfigPaths,
	antigravityMemoryPaths,
	antigravitySkillsDir,
	antigravityTranscriptPaths,
	antigravityTreeHasContent,
	antigravityWorkflowsDir,
} from "./antigravity-home.ts";
import { isRecord, parseJsonc, readSkillDirs, readText, tildePath } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** One thing the walk found and did not carry over, with the reason. */
export interface AntigravitySkipped {
	name: string;
	reason: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** One conversation, named and measured and never opened. */
export interface AntigravityConversation {
	/** The directory's own name, which is the conversation id. */
	name: string;
	/** Where the conversation directory is. Printed by the report, never opened. */
	path: string;
	/** Its compact transcript's size in bytes, from one `stat`. */
	size: number;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The theme, in Antigravity's own spelling rather than this build's. */
export interface AntigravityTheme {
	/** `userSettings.themeMode` verbatim, or `null` when the file states none. */
	declared: string | null;
	/**
	 * True when the app would follow the OS. **The importer cannot resolve
	 * this**: `nativeTheme.shouldUseDarkColors` is a property of the machine
	 * Antigravity runs on, so this is a reason for the report to say "follows
	 * your system theme" rather than a theme to write.
	 */
	inheritsOsTheme: boolean;
	/** The app's second test, verbatim: does the value contain `LIGHT`? */
	light: boolean;
}

/**
 * Antigravity's user state, as one read of one home.
 *
 * Everything here is either a value read out of a file, a *count* of something,
 * or a line explaining why neither happened. No field holds a credential and no
 * field holds conversation contents.
 */
export interface RawAntigravity {
	/** The home directory every root was resolved against, for rendering report paths. */
	home: string;
	/** `~/.gemini` — the parent of every other path here. */
	geminiRoot: string;
	/**
	 * True when `~/.gemini` exists and holds something. A source whose whole
	 * point is that nothing was there produces an empty report rather than a
	 * line saying so, and this is how a caller tells the two apart.
	 */
	present: boolean;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The data root that answered, or `null` when neither has content. */
	dataDir: string | null;
	/** Both candidate roots, most authoritative first, whether or not either exists. */
	dataDirs: string[];
	/** `~/.gemini/config/config.json`. Always present as a path, never as a read. */
	configPath: string;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The settings document, parsed, or `null` when it could not be. */
	config: Record<string, unknown> | null;
	/** The theme, in the app's own terms. See {@link AntigravityTheme}. */
	theme: AntigravityTheme;
	/** Every `mcp_config.json` consulted, in priority order, existing or not. */
	mcpConfigPaths: string[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** The servers from every `mcp_config.json`, merged. */
	mcpServers: Record<string, unknown>;
	/**
	 * Server name → the `mcp_config.json` it was read from, so the planner can
	 * print which document a server came from. Paths only: this map is the
	 * provenance, and the server's own configuration is on {@link mcpServers}.
	 */
	mcpSources: Record<string, string>;
	/** Names in more than one document, and which file won. */
	mcpCollisions: Array<{ name: string; kept: string; dropped: string }>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Standing instructions, as {@link RawFile}s, from every candidate that exists. */
	memory: RawFile[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** Skills and legacy workflows, as {@link RawFile}s. */
	assets: RawFile[];
	/** One entry per conversation file: its name, its path, its size. */
	conversations: AntigravityConversation[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** Two assets answering to one name, and which of the two this reader kept. */
	nameCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/**
	 * Everything seen and not carried over, each with the reason. Sorted by
	 * name so two runs over one home produce the same report.
	 */
	skipped: AntigravitySkipped[];
}

/** A file's text, or why it is not available. `null` is never the answer. */
type AntigravityText = { kind: "text"; value: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/** A JSON document in the three states one can be in when it is on disk. */
type AntigravityJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

// Long-form design notes: docs/dev/migration-sources.md
/** The largest depth a credential-shaped key is looked for at. */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

// Long-form design notes: docs/dev/migration-sources.md
/** Key names `looksLikeSecretName` does not catch. */
const ANTIGRAVITY_SECRET_KEY = /authorization/i;

// Long-form design notes: docs/dev/migration-sources.md
/** Antigravity's theme, from the parsed settings document. */
function antigravityTheme(config: Record<string, unknown> | null): AntigravityTheme {
	const settings = config === null ? undefined : config.userSettings;
	const mode = isRecord(settings) ? settings.themeMode : undefined;
	// Two names for one value: `declared` is what the file said, and `""` stands
	// in for "said nothing" so that both tests below can be written as the app
	// writes them. `String.prototype.includes` on the empty string is `false`, and
	// so is `themeMode && themeMode.includes(…)` on an empty or absent value —
	// the two spellings agree, and keeping the local a `string` is what stops a
	// null check from being smuggled in front of a substring test.
	const declared = typeof mode === "string" ? mode : null;
	const tested = declared ?? "";
	return {
		declared,
		inheritsOsTheme: tested.includes("INHERIT"),
		light: tested.includes("LIGHT"),
	};
}

// Long-form design notes: docs/dev/migration-sources.md
/** Remove every credential-shaped key from a parsed document, recording each by path and never touching the value. */
function scrubAntigravityCredentials(value: Record<string, unknown>, into: AntigravitySkipped[]): void {
	const walk = (node: unknown, prefix: string, depth: number): void => {
		if (!isRecord(node) || depth > MAX_CREDENTIAL_SCAN_DEPTH) return;
		for (const [key, nested] of Object.entries(node)) {
			const path = `${prefix}.${key}`;
			if (ANTIGRAVITY_SECRET_KEY.test(key) || looksLikeSecretName(key)) {
				into.push({ name: path, reason: "looks like a credential — name only, value never read" });
				delete node[key];
				continue;
			}
			walk(nested, path, depth + 1);
		}
	};
	walk(value, "config.json", 0);
}

// Long-form design notes: docs/dev/migration-sources.md
/** A file's text, or the reason it is not text. */
function readAntigravityText(path: string): AntigravityText {
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
function readAntigravityJson(path: string): AntigravityJson {
	const text = readAntigravityText(path);
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
			reason: "not parseable as JSON — damaged, or carrying comments this build's JSON reader will not accept",
		};
	}
}

/** The one line a document read through {@link parseJsonc} earns in `skipped`. */
const ANTIGRAVITY_JSONC_RECOVERY =
	"not parseable as plain JSON — read anyway with comments and trailing commas stripped, so anything the stripping removed is not carried over";

// Long-form design notes: docs/dev/migration-sources.md
/** One MCP document's servers, and the three ways it can have none worth reading. */
function readAntigravityMcpFile(
	path: string,
	label: string,
	skipped: AntigravitySkipped[],
): { servers: Record<string, unknown> } | null {
	const document = readAntigravityJson(path);
	if (document.kind === "absent") return null;
	if (document.kind === "invalid") {
		skipped.push({ name: label, reason: document.reason });
		return null;
	}
	if (document.recovered) skipped.push({ name: label, reason: ANTIGRAVITY_JSONC_RECOVERY });
	if (!("mcpServers" in document.value)) {
		if (Object.keys(document.value).length > 0) {
			skipped.push({
				name: label,
				reason: "no mcpServers field — this source reads only that field, so nothing was imported from it",
			});
		}
		return null;
	}
	const servers = document.value.mcpServers;
	if (!isRecord(servers)) {
		skipped.push({ name: label, reason: "mcpServers is not a JSON object" });
		return null;
	}
	return { servers };
}

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function antigravityDirectoryEntries(dir: string): Dirent[] {
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
/** The workflow markdown files under one deprecated tree, as skills would be. */
function readAntigravityWorkflows(dir: string, label: string, skipped: AntigravitySkipped[]): RawFile[] {
	const files: RawFile[] = [];
	const walk = (current: string, prefix: string): void => {
		for (const entry of antigravityDirectoryEntries(current)) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const name = `${label}/${relativePath}`;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(path, relativePath);
				continue;
			}
			const lower = entry.name.toLowerCase();
			if (lower.endsWith(".md.bak")) {
				skipped.push({
					name,
					reason:
						"already-converted workflow, archived by the product's own migrate-workflows skill as <name>.md.bak — its skill should be in the skills tree",
				});
				continue;
			}
			if (!entry.isFile() || !lower.endsWith(".md")) {
				if (!entry.isFile()) {
					skipped.push({ name, reason: "not a regular file" });
				}
				continue;
			}
			if (lower === "readme.md") {
				skipped.push({ name, reason: "a README, not a workflow" });
				continue;
			}
			const content = readAntigravityText(path);
			if (content.kind !== "text") {
				// `absent` is the race where the file left between the listing and
				// the read; it is named rather than passed over, because a workflow
				// the user can see and this walk cannot is not the same as one that
				// is not there.
				skipped.push({ name, reason: content.kind === "absent" ? "gone before it could be read" : content.reason });
				continue;
			}
			files.push({
				name: entry.name.slice(0, -3),
				sourcePath: path,
				content: content.value,
				detail: `Antigravity workflow from ${label}/${relativePath}; the product's own migrate-workflows skill calls this tree deprecated in favour of skills/<name>/SKILL.md, renames the frontmatter to name/description, and archives the original as <name>.md.bak`,
			});
		}
	};
	walk(dir, "");
	return files;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The conversations under one data root: named and measured, never opened. */
function readAntigravityConversations(
	dir: string,
	skipped: AntigravitySkipped[],
): { found: boolean; conversations: AntigravityConversation[] } {
	if (!existsSync(dir)) return { found: false, conversations: [] };
	const conversations: AntigravityConversation[] = [];
	for (const entry of antigravityDirectoryEntries(dir)) {
		const path = join(dir, entry.name);
		if (!entry.isDirectory()) {
			skipped.push({
				name: `brain/${entry.name}`,
				reason: "a file directly under the conversations tree; the product puts one directory per conversation in it",
			});
			continue;
		}
		// The compact transcript is the one the product tells an agent to read
		// first, so it is the one whose presence decides whether this conversation
		// has anything to import. `transcript_full.jsonl` is the fallback for the
		// steps whose `truncated_fields` point into it, not a second conversation.
		const transcript = antigravityTranscriptPaths(path)[0];
		if (!existsSync(transcript)) {
			skipped.push({
				name: `brain/${entry.name}`,
				reason:
					"a conversation with no transcript at .system_generated/logs/transcript.jsonl — it may predate that layout, or " +
					"have been cleaned up; its artifacts and scratch files are left where Antigravity put them",
			});
			continue;
		}
		let size: number;
		try {
			size = statSync(transcript).size;
		} catch {
			skipped.push({ name: `brain/${entry.name}`, reason: "its transcript could not be measured" });
			continue;
		}
		conversations.push({ name: entry.name, path, size });
	}
	return { found: true, conversations };
}

// Long-form design notes: docs/dev/migration-sources.md
/** Read one Antigravity home. */
export function readAntigravity(home: string): RawAntigravity {
	const geminiRoot = antigravityGeminiRoot(home);
	const dataDirs = antigravityDataDirs(home);
	const skipped: AntigravitySkipped[] = [];

	// The one decision this module makes about where to read, and it makes it by
	// asking rather than by assuming: the first root with anything in it, which is
	// `antigravity-ide` on a machine that went through the IDE split and
	// `antigravity` on one that did not.
	const chosen = dataDirs.find((dir) => antigravityTreeHasContent(dir)) ?? null;

	const configDocument = readAntigravityJson(antigravityConfigPath(home));
	if (configDocument.kind === "invalid") {
		skipped.push({ name: "config.json", reason: configDocument.reason });
	} else if (configDocument.kind === "object" && configDocument.recovered) {
		skipped.push({ name: "config.json", reason: ANTIGRAVITY_JSONC_RECOVERY });
	}
	const config = configDocument.kind === "object" ? configDocument.value : null;
	if (config !== null) scrubAntigravityCredentials(config, skipped);

	const mcpServers: Record<string, unknown> = {};
	const mcpSources: Record<string, string> = {};
	const mcpCollisions: RawAntigravity["mcpCollisions"] = [];
	for (const path of antigravityMcpConfigPaths(home, chosen)) {
		// The report renders every path it names under home with a leading `~` and
		// forward slashes, and `tildePath` is that renderer — so a skip line and a
		// provenance line carry the same spelling, on every platform.
		const label = tildePath(home, path);
		const read = readAntigravityMcpFile(path, label, skipped);
		if (read === null) continue;
		for (const [name, server] of Object.entries(read.servers)) {
			const earlier = mcpSources[name];
			if (earlier !== undefined) {
				mcpCollisions.push({ name, kept: earlier, dropped: label });
				continue;
			}
			mcpServers[name] = server;
			mcpSources[name] = label;
		}
	}

	const memory: RawFile[] = [];
	for (const path of antigravityMemoryPaths(home)) {
		const text = readAntigravityText(path);
		if (text.kind === "absent") continue;
		if (text.kind !== "text") {
			// `~`-rooted like every other label here: four candidates with two of
			// them in one directory means a bare `memory.txt` would not say which
			// one of them failed.
			skipped.push({ name: tildePath(home, path), reason: text.reason });
			continue;
		}
		const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
		memory.push({ name: base, sourcePath: path, content: text.value });
	}

	const skillsDir = antigravitySkillsDir(home);
	const assets = readSkillDirs(skillsDir);
	// `readSkillDirs` passes over two things in silence that are worth a line
	// here, because Antigravity *defines* a skill as a directory holding a
	// `SKILL.md` (`skills/<name>/SKILL.md` in the product's own customization
	// guide) — so both of these are user content in a directory the agent reads,
	// which is exactly the case where silence reads as a bug.
	for (const entry of antigravityDirectoryEntries(skillsDir)) {
		if (entry.isDirectory()) {
			if (assets.some((skill) => skill.name === entry.name)) continue;
			skipped.push({
				name: `skills/${entry.name}`,
				reason: "a skill directory with no SKILL.md in it, which is not a skill Antigravity loads",
			});
			continue;
		}
		// A markdown file sitting directly in `skills/` is not a skill in either
		// shape the product documents — those are a *file* named `SKILL.md` inside a
		// *directory*. It is named rather than read, because importing it as a
		// single-file skill would be a schema this source cannot cite.
		skipped.push({
			name: `skills/${entry.name}`,
			reason:
				"a file directly in the skills root; an Antigravity skill is a directory holding a SKILL.md, and this is not one",
		});
	}
	// Workflows are added after skills, and a name an asset already answers to is
	// recorded rather than dropped: two entries become one target directory, and
	// which of them the plan writes is the plan's decision. A reader that
	// silently dropped one would leave a report claiming one file was imported
	// where two were found.
	const claimed = new Map(assets.map((asset) => [asset.name, asset.sourcePath]));
	const nameCollisions: RawAntigravity["nameCollisions"] = [];
	for (const [dir, label] of [
		[antigravityWorkflowsDir(home), "workflows"],
		[antigravityGlobalWorkflowsDir(home), "global_workflows"],
	] as const) {
		for (const workflow of readAntigravityWorkflows(dir, label, skipped)) {
			const earlier = claimed.get(workflow.name);
			if (earlier !== undefined) {
				nameCollisions.push({ name: workflow.name, kept: earlier, dropped: workflow.sourcePath });
				continue;
			}
			claimed.set(workflow.name, workflow.sourcePath);
			assets.push(workflow);
		}
	}

	const conversations: AntigravityConversation[] = [];
	if (chosen !== null) {
		const scan = readAntigravityConversations(antigravityConversationsDir(chosen), skipped);
		conversations.push(...scan.conversations);
		if (!scan.found) {
			skipped.push({
				name: `brain (under ${tildePath(home, chosen)})`,
				reason:
					"no conversations directory there — this is the path Antigravity's own documentation gives for them, so it is the " +
					"absence of conversations in this data root and not the absence of a location; the other root may still hold them",
			});
		}
	}

	// Long-form design notes: docs/dev/migration-sources.md
	const labelPrefix = `~/${ANTIGRAVITY_GEMINI_DIR}`;
	for (const [label, reason] of Object.entries(ANTIGRAVITY_NAMED_ONLY)) {
		if (!label.startsWith(labelPrefix)) continue;
		if (existsSync(join(geminiRoot, label.slice(labelPrefix.length)))) skipped.push({ name: label, reason });
	}

	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		geminiRoot,
		present: antigravityTreeHasContent(geminiRoot),
		dataDir: chosen,
		dataDirs,
		configPath: antigravityConfigPath(home),
		config,
		theme: antigravityTheme(config),
		mcpConfigPaths: antigravityMcpConfigPaths(home, chosen),
		mcpServers,
		mcpSources,
		mcpCollisions,
		memory,
		assets,
		conversations,
		nameCollisions,
		skipped,
	};
}
