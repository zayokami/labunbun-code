/**
 * The pieces more than one source needs, whichever side of the read/plan
 * divide they sit on.
 *
 * Two kinds of thing live here, and both are here because of who calls them.
 * The first is the generic readers — `readJson`, `readSkillDirs`,
 * `readAgentFiles` and the rest — which every source's layout adapter is built
 * from. The second is the set of helpers that used to sit inside one source's
 * region while three or more other sources called them: `isRecord` (declared
 * next to the codex planner, called 149 times), `summarizeNames`, `tildePath`,
 * `placeholderNote` and the directory counters. A helper's home is decided by
 * its callers, not by which source it happened to be written next to, and
 * leaving them where they were is what made this file unreadable.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	MigrationItem,
	MigrationSourceId,
	NormalizedHookEntry,
	NormalizedHooks,
	PlannedWrite,
	RawAttachment,
	RawCommands,
	RawFile,
} from "./migrate-types.ts";
import { SOURCE_ROOTS } from "./migrate-types.ts";
import type { RawSettingsInput } from "./settings.ts";
// The same reader the skill loader uses, so what the importer writes back is
// what the loader will read.
import { parseFrontmatter } from "./skills.ts";

export function readJson(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// A malformed source file migrates nothing rather than aborting the run:
		// the other sources are still worth importing.
		return {};
	}
}

export function readText(path: string): string | null {
	try {
		return existsSync(path) ? readFileSync(path, "utf8") : null;
	} catch {
		return null;
	}
}

/** Directories inside a skill that hold somebody else's files, not the skill's. */
const SKILL_EXCLUDED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

/** Largest supporting file worth carrying; a skill is prose, not an asset store. */
const MAX_ATTACHMENT_BYTES = 256 * 1024;

/** Most supporting files one skill may bring along. */
const MAX_ATTACHMENTS = 200;

/**
 * The files beside a skill's `SKILL.md`, as attachments.
 *
 * A skill is a directory, not a document: its body points at `references/*.md`,
 * `scripts/`, and so on, and copying only the `SKILL.md` leaves those pointers
 * dangling. Text files are carried; binaries and anything oversized are counted
 * and named in the report instead of written, because the writer is text-only
 * and a silent truncation would be worse than an explanation.
 */
export function readAttachments(skillDir: string): Pick<RawFile, "attachments" | "attachmentSkips"> {
	const attachments: RawAttachment[] = [];
	const attachmentSkips: Array<{ relativePath: string; reason: string }> = [];
	const walk = (dir: string, prefix: string): void => {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (attachments.length >= MAX_ATTACHMENTS) {
				attachmentSkips.push({ relativePath, reason: `more than ${MAX_ATTACHMENTS} files` });
				continue;
			}
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKILL_EXCLUDED_DIRS.has(entry.name)) {
					attachmentSkips.push({ relativePath, reason: "not part of the skill (dependencies or VCS data)" });
					continue;
				}
				walk(full, relativePath);
				continue;
			}
			if (!entry.isFile()) continue;
			if (entry.name === "SKILL.md" && prefix === "") continue;
			let bytes: Buffer;
			try {
				bytes = readFileSync(full);
			} catch {
				attachmentSkips.push({ relativePath, reason: "unreadable" });
				continue;
			}
			if (bytes.length > MAX_ATTACHMENT_BYTES) {
				attachmentSkips.push({ relativePath, reason: `larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB` });
				continue;
			}
			if (bytes.includes(0)) {
				attachmentSkips.push({ relativePath, reason: "binary file" });
				continue;
			}
			attachments.push({ relativePath, content: bytes.toString("utf8") });
		}
	};
	walk(skillDir, "");
	return { attachments, attachmentSkips };
}

/** Skill directories, each contributing its SKILL.md and the files beside it. */
export function readSkillDirs(skillsRoot: string): RawFile[] {
	const out: RawFile[] = [];
	try {
		if (!existsSync(skillsRoot)) return out;
		for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const skillDir = join(skillsRoot, entry.name);
			const content = readText(join(skillDir, "SKILL.md"));
			if (content === null) continue;
			const { attachments, attachmentSkips } = readAttachments(skillDir);
			out.push({ name: entry.name, sourcePath: join(skillDir, "SKILL.md"), content, attachments, attachmentSkips });
		}
	} catch {
		// unreadable skills dir — contributes nothing
	}
	return out;
}

/** Longest skill name to derive from a command file's path. */
export const MAX_COMMAND_NAME = 64;

/**
 * Slash-command markdown files, read recursively.
 *
 * Unlike a rules or agents directory, a commands tree mirrors how the source
 * tool namespaced its commands: `fix/bugs.md` is a different command from
 * `fix.md`, and the two files may say different things. The nesting is
 * flattened into the name (`fix-bugs`) because a skill here is one directory
 * per name, and a collision would be reported as one skill having been kept.
 */
export function readCommandFiles(root: string): RawCommands {
	const files: RawFile[] = [];
	const skips: Array<{ path: string; reason: string }> = [];
	const walk = (dir: string, prefix: string): void => {
		let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (SKILL_EXCLUDED_DIRS.has(entry.name)) continue;
				walk(join(dir, entry.name), relativePath);
				continue;
			}
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
			if (entry.name.toLowerCase() === "readme.md") {
				skips.push({ path: relativePath, reason: "a README, not a command" });
				continue;
			}
			const name = relativePath.slice(0, -3).split("/").join("-");
			if (name === "") {
				skips.push({ path: relativePath, reason: "no usable name" });
				continue;
			}
			if (name.length > MAX_COMMAND_NAME) {
				skips.push({ path: relativePath, reason: `name would be longer than ${MAX_COMMAND_NAME} characters` });
				continue;
			}
			const content = readText(join(dir, entry.name));
			if (content === null) {
				skips.push({ path: relativePath, reason: "unreadable" });
				continue;
			}
			files.push({ name, sourcePath: join(dir, entry.name), content });
		}
	};
	walk(root, "");
	return { files, skips };
}

export function readMarkdownDir(dir: string): RawFile[] {
	const out: RawFile[] = [];
	try {
		if (!existsSync(dir)) return out;
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".md")) continue;
			const path = join(dir, name);
			if (!statSync(path).isFile()) continue;
			const content = readText(path);
			if (content !== null) out.push({ name, sourcePath: path, content });
		}
	} catch {
		// unreadable rules dir — contributes nothing
	}
	return out;
}

/**
 * Agent definition files (`agents/*.md`), annotated when the frontmatter asks
 * for a model.
 *
 * The model name is resolved when a subagent starts, against the models this
 * build knows (`subagents.ts`). A name that resolves is used; one that does not
 * falls back to the session's model and says so at the spawn. The note here is
 * therefore about which of those two the user should expect, not about a field
 * being ignored — it used to read "is not honoured", which stopped being true
 * when that resolution landed, and a report that describes behaviour the build
 * does not have is the same defect as a silent mismatch.
 */
export function readAgentFiles(dir: string): RawFile[] {
	const files = readMarkdownDir(dir);
	for (const file of files) {
		const { data } = parseFrontmatter(file.content);
		if (data.model) {
			file.detail = `agent copied verbatim; its "model: ${data.model}" frontmatter is resolved when a subagent starts — a name that no longer resolves falls back to the session model and says so`;
		}
	}
	return files;
}

/** Files directly under `dir` with the given extension; unreadable counts as none. */
export function countFilesWithExtension(dir: string, extension: string): number {
	try {
		if (!existsSync(dir)) return 0;
		return readdirSync(dir).filter((name) => name.endsWith(extension)).length;
	} catch {
		return 0;
	}
}

/** The last non-empty path segment: what a file, or a skill's own directory, is called. */
export function leafName(path: string): string {
	const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
	return parts[parts.length - 1] ?? "";
}

/** A whole line that is a table header and nothing else: `[a.b]`, `[[a.b]]`. */
const GROK_HEADER_LINE = /^\s*\[\[?\s*([A-Za-z0-9_. -]+?)\s*\]\]?\s*$/;

/** The key part of an assignment: `a.b = …`, quoted segments left out of the match. */
const GROK_ASSIGNMENT_KEY = /^([A-Za-z0-9_. -]+?)\s*=/;

/**
 * Quote the digits-only segments in a document's key paths so this parser can
 * read it, and say which paths were touched.
 *
 * `[model.grok-4.6]` is TOML 1.0, and it is what grok's user guide writes —
 * `docs/user-guide/05-configuration.md`, `11-custom-models.md` (three times) and
 * the shell README all spell per-model overrides that way. It is the path
 * `model.grok-4."6"`: the id with a dot in it becomes *three* keys. grok's own
 * pty test says so in as many words ("bare `[model.grok-4.5]` is TOML key-path
 * syntax, not the id `grok-4.5`"), and its parser takes it. `Bun.TOML` does not:
 * a digits-only bare segment after a dot is rejected, and the rejection costs the
 * whole document — every other setting, rule and MCP server in the file with it.
 *
 * So the segments are quoted, which under the spec produces the identical
 * structure, and the paths are handed back so the report can explain what grok
 * made of them. Only the key part of a line is touched, and nothing inside a
 * triple-quoted string is, so a value that happens to look like a header — a
 * description containing `[model.grok-4.6]` — is left as the user wrote it.
 *
 * Returns `null` when the document needs no repair, which is the case for every
 * file this parser accepts as-is.
 */
export function requoteNumericKeyPaths(text: string): { text: string; changed: string[] } | null {
	const changed: string[] = [];
	let multiline: string | null = null;
	const repair = (path: string): string | null => {
		const segments = path.split(".").map((segment) => segment.trim());
		if (!segments.some((segment) => /^[0-9]+$/.test(segment))) return null;
		changed.push(segments.join("."));
		return segments.map((segment) => (/^[0-9]+$/.test(segment) ? `"${segment}"` : segment)).join(".");
	};
	const lines = text.split("\n").map((line) => {
		if (multiline !== null) {
			// Inside a triple-quoted string a header-shaped line is content. An odd
			// count of the delimiter is what opens or closes one; an even count is
			// two of them on one line, which leaves the state where it was.
			if (line.includes(multiline)) multiline = null;
			return line;
		}
		for (const delimiter of ['"""', "'''"]) {
			if ((line.split(delimiter).length - 1) % 2 === 1) multiline = delimiter;
		}
		const match = GROK_HEADER_LINE.exec(line) ?? GROK_ASSIGNMENT_KEY.exec(line);
		const path = match?.[1];
		if (path === undefined) return line;
		const requoted = repair(path);
		return requoted === null ? line : line.replace(path, requoted);
	});
	return changed.length === 0 ? null : { text: lines.join("\n"), changed };
}

/**
 * Direct children of `dir` of any kind, or 0 when it is unreadable.
 *
 * Not {@link countDirectoryEntries}: grok's `personas`, `roles` and `workflows`
 * trees hold `.toml` and `.rhai` files, and counting only directories would make
 * each of them come back as 0 — which the caller filters out, so a tree full of
 * the user's own definitions would be reported as one grok does not have.
 */
export function countTreeEntries(dir: string): number {
	try {
		return existsSync(dir) ? readdirSync(dir).length : 0;
	} catch {
		return 0;
	}
}

/** Entry names under a directory, sorted. An unreadable or absent one has none. */
export function readDirectoryNames(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

/**
 * Characters that make a hook matcher mean something different in each tool.
 *
 * `matchesPattern` in `hooks.ts` treats `*` as the only wildcard and escapes
 * every other pattern character, so a source matcher written as a regular
 * expression (`mcp__.*__delete.*`) imports as a literal that can never match.
 * Keeping this list equal to the escape list there is what makes the check
 * honest — a character escaped there but not here would be a silent miss.
 */
export const HOOK_MATCHER_METACHARACTERS = /[.+^${}()|[\]\\]/;

/** A matcher name this build can reproduce: tool names, MCP ids, and `*`. */
export const HOOK_MATCHER_NAME = /^[A-Za-z0-9_:*-]+$/;

/**
 * The longest timeout the target's hook schema accepts, in milliseconds, and
 * what a handler that names none runs for there (`hooks.ts`).
 */
export const MAX_HOOK_TIMEOUT_MS = 600_000;

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * One handler in the target's shape, or nothing plus a count of why not.
 *
 * The timeout is the one field whose *value* has to change on the way across:
 * the source counts it in seconds — "Timeout in seconds for this specific
 * command", `schemas/hooks.ts` — and runs a handler that names none for ten
 * minutes (`utils/hooks.ts`, `TOOL_HOOK_EXECUTION_TIMEOUT_MS`), where this build
 * counts milliseconds and waits a minute. A copy that keeps the number is the
 * one thing that makes `timeout: 30` mean thirty milliseconds, so the
 * conversion happens here and both counts are reported.
 */
export function normalizeClaudeHandler(handler: unknown, counts: NormalizedHooks): NormalizedHookEntry["hooks"] {
	if (!isRecord(handler)) {
		counts.malformed += 1;
		return [];
	}
	if ((handler.type ?? "command") !== "command") {
		counts.droppedHandlers += 1;
		return [];
	}
	if (typeof handler.command !== "string" || handler.command.trim() === "") {
		counts.malformed += 1;
		return [];
	}
	const seconds = handler.timeout;
	let timeout: number | undefined;
	if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
		// Clamped rather than dropped: the schema would reject an oversized value
		// and take every hook in the file down with it, so the longest wait this
		// build has is what a longer one becomes — and the report says how many.
		const millis = Math.round(seconds * 1000);
		timeout = Math.min(Math.max(millis, 1), MAX_HOOK_TIMEOUT_MS);
		counts.convertedTimeouts += 1;
		if (millis > MAX_HOOK_TIMEOUT_MS) counts.clampedTimeouts += 1;
	} else {
		counts.untimedHandlers += 1;
	}
	return [
		timeout === undefined
			? { type: "command", command: handler.command }
			: { type: "command", command: handler.command, timeout },
	];
}

/**
 * One line naming the keys that were neither imported nor explained.
 *
 * Silence is the one thing a migration report may not do: a key the user set is
 * either carried across or named here, so the report cannot leave them
 * wondering whether something went missing. Values are never printed — the
 * names are the report, the contents are the user's own.
 */
export function reportUnhandledKeys(
	source: MigrationSourceId,
	container: Record<string, unknown>,
	handled: Set<string>,
	from: string,
	items: MigrationItem[],
): void {
	const unhandled = Object.keys(container).filter((key) => !handled.has(key));
	if (unhandled.length === 0) return;
	items.push({
		source,
		from: `${from} → ${summarizeNames(unhandled, 8)}`,
		to: "—",
		action: "skip",
		detail: `${unhandled.length} key(s) this importer has no mapping for and no note about, so they were left where they are — copy over by hand whatever matters`,
		containsSecret: false,
	});
}

/**
 * Rewrite one Codex `[mcp_servers.<name>]` entry into labunbun's config shape.
 *
 * The differences are all about credentials Codex does not store: `env_vars` and
 * `bearer_token_env_var` name variables in the user's shell environment rather
 * than holding values. The importer copies the server and says which variables
 * it used to read — it will not read them itself, and inventing an empty value
 * would turn a working server into one that fails at connect time.
 *
 * Returns `null` when the entry is neither of the two shapes that can be
 * carried over; the caller reports that as a skip.
 */
/**
 * `${VAR}` names used in the values of an env or header block.
 *
 * The target's MCP client does not expand variables (`packages/mcp` has no such
 * step), so a copied value that says `${TOKEN}` stays the literal text — a
 * server that would have authenticated does not. Names only: whatever else is in
 * the value is the user's.
 */
function placeholderNames(config: unknown): string[] {
	const names = new Set<string>();
	if (!isRecord(config)) return [];
	for (const value of Object.values(config)) {
		if (typeof value !== "string") continue;
		for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]);
	}
	return [...names];
}

/** The reason a copied MCP config is a downgrade rather than a plain copy. */
export function placeholderNote(config: Record<string, unknown>): string | undefined {
	const names = [...placeholderNames(config.env), ...placeholderNames(config.headers)];
	if (names.length === 0) return undefined;
	return `${names.map((name) => `\${${name}}`).join(", ")} is not expanded here — replace it with the value itself`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Output-token budget assumed for an imported model whose source does not say. */
export const ASSUMED_MAX_OUTPUT_TOKENS = 8192;

/** `model-a, model-b, model-c +4 more` — enough to act on, short enough to read. */
export function summarizeNames(names: string[], max = 5): string {
	const unique = [...new Set(names)];
	if (unique.length <= max) return unique.join(", ");
	return `${unique.slice(0, max).join(", ")} +${unique.length - max} more`;
}

/** A positive whole number of tokens, or nothing — a window has no other form. */
export function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function planAssetTrees(
	source: MigrationSourceId,
	raw: { skills: RawFile[]; agents: RawFile[]; memory: string | null },
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		source,
		raw.skills,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
	collectFileWrites(
		source,
		raw.agents,
		(name) => join(home, ".labunbun", "agents", name),
		"agent",
		force,
		items,
		writes,
		home,
	);
	if (raw.memory?.trim()) {
		planMemoryAsRule(
			source,
			`~/${SOURCE_ROOTS[source]}/AGENTS.md`,
			home,
			raw.memory,
			`imported-${source}.md`,
			force,
			items,
			writes,
		);
	}
}

/** Command frontmatter keys that do nothing once the file is a skill here. */
const UNHONORED_COMMAND_KEYS = ["allowed-tools", "model", "argument-hint"];

/**
 * Rewrite a source command file as a skill.
 *
 * The body is carried byte for byte — a command is prose the user wrote, and
 * the only part that has to change is the header, which this build reads as a
 * skill's `name`/`description`. Everything else the source understood is named
 * in the report rather than copied into a file that looks like it honours it:
 * `allowed-tools` and `model` do nothing here, and `$1`-`$9` and inline shell
 * expansion are never substituted.
 *
 * A `detail` the reader already set is kept in front of the rest. That is the
 * plugin provenance: a command lifted out of a plugin has to keep saying so, and
 * this rewrite would otherwise be the last word on it.
 */
function commandAsSkill(file: RawFile): RawFile {
	const { data, body } = parseFrontmatter(file.content);
	const description = (data.description ?? "").replace(/\s+/g, " ").trim();
	// A description spread over several lines — a YAML block scalar, say — is
	// collapsed onto one: the reader here takes one line per key, and a header
	// that splits its own value would come back as an empty description.
	const header = [`name: ${file.name}`, ...(description ? [`description: ${description}`] : [])];
	const unhonored = UNHONORED_COMMAND_KEYS.filter((key) => data[key] !== undefined);
	return {
		...file,
		content: `---\n${header.join("\n")}\n---\n${body}`,
		detail: [
			file.detail ?? "",
			"command imported as a skill: frontmatter rewritten to name/description",
			description ? "" : "the source had no description, so none was written",
			unhonored.length > 0 ? `${summarizeNames(unhonored)} is not honoured here` : "",
			"$ARGUMENTS is substituted, $1..$9 and inline shell expansion are not",
		]
			.filter(Boolean)
			.join("; "),
	};
}

/**
 * Command files become skills: a command is a named prompt, and a skill here is
 * exactly that, so this is a rewrite of the header rather than a translation.
 *
 * Codex's own importer turns Claude Code commands into skills the same way,
 * which is a sign the mapping is the intended one rather than merely the
 * convenient one.
 */
export function planCommands(
	source: MigrationSourceId,
	commands: RawCommands,
	fromLabel: string,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	if (commands.skips.length > 0) {
		items.push({
			source,
			from: fromLabel,
			to: "—",
			action: "skip",
			detail: `${commands.skips.length} command file(s) not imported — ${summarizeNames(
				commands.skips.map((skip) => `${skip.path} (${skip.reason})`),
			)}`,
			containsSecret: false,
		});
	}
	collectFileWrites(
		source,
		commands.files.map(commandAsSkill),
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);
}

/**
 * An imported memory document becomes a rule file rather than `MEMORY.md`.
 *
 * `MEMORY.md` is a file the user curates and may already have; dropping an
 * imported document on top of it would destroy their own notes. `rules/` is
 * additive by design and loaded with the same weight.
 */
export function planMemoryAsRule(
	source: MigrationSourceId,
	fromLabel: string,
	home: string,
	memory: string,
	fileName: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	const path = join(home, ".labunbun", "rules", fileName);
	if (existsSync(path) && !force) {
		items.push({
			source,
			from: fromLabel,
			to: "—",
			action: "skip",
			detail: "target rule file already exists — kept (use --force to overwrite)",
			containsSecret: false,
		});
		return;
	}
	writes.push({ path, kind: "rule", content: memory, containsSecret: false });
	items.push({
		source,
		from: fromLabel,
		to: tildePath(home, path),
		action: "map",
		detail: "imported as a rule file so it merges with existing memory instead of replacing it",
		containsSecret: false,
	});
}

/**
 * Merge prepared provider specs into the settings patch, reporting a collision
 * rather than overwriting it: `id` is what a model reference resolves against,
 * so replacing an existing entry silently repoints configuration that was
 * already working.
 *
 * Returns the ids that were taken, so a caller that wants to report on the
 * entries it offered asks this function instead of re-deriving which of them
 * survived. The rule is small and it is exactly the kind of small rule that
 * drifts: two copies of it is how a report starts describing a patch that was
 * never written.
 */
export function mergeProviderSpecs(
	source: MigrationSourceId,
	additions: Array<Record<string, unknown>>,
	fromFor: (id: string) => string,
	items: MigrationItem[],
	settingsPatch: Record<string, unknown>,
	existing: RawSettingsInput,
	force: boolean,
): string[] {
	if (additions.length === 0) return [];
	const currentProviders = (existing.providers?.openaiCompatible ?? []) as Array<{ id?: string }>;
	const existingIds = new Set(currentProviders.map((p) => p.id));
	for (const provider of additions) {
		if (force || !existingIds.has(provider.id as string)) continue;
		items.push({
			source,
			from: fromFor(provider.id as string),
			to: "—",
			action: "skip",
			detail: "target already defines a provider with this id — kept (use --force to overwrite)",
			containsSecret: false,
		});
	}
	const accepted = force ? additions : additions.filter((p) => !existingIds.has(p.id as string));
	if (accepted.length === 0) return [];
	const kept = force ? currentProviders.filter((p) => !additions.some((a) => a.id === p.id)) : currentProviders;
	settingsPatch.providers = { openaiCompatible: [...kept, ...accepted] };
	return accepted.map((p) => p.id as string);
}

/**
 * Render a path the way the rest of the report does: under home with a leading
 * `~`, so an item's source and target read at the same scale. Paths outside
 * home are left alone rather than mangled into a misleading relative form.
 */
export function tildePath(home: string, path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const base = home.replace(/\\/g, "/").replace(/\/+$/, "");
	return base && normalized.startsWith(`${base}/`) ? `~/${normalized.slice(base.length + 1)}` : normalized;
}

export function collectFileWrites(
	source: MigrationSourceId,
	files: RawFile[],
	targetFor: (name: string) => string,
	kind: PlannedWrite["kind"],
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
	home: string,
): void {
	for (const file of files) {
		const path = targetFor(file.name);
		const from = tildePath(home, file.sourcePath);
		// An earlier source may already have claimed this exact path — two sources
		// can hold a skill of the same name. `existsSync` can't see that, since
		// nothing has been written yet during planning.
		if (writes.some((w) => w.path === path)) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `this ${kind} is already being written by this run — kept the first one`,
				containsSecret: false,
			});
			continue;
		}
		if (existsSync(path) && !force) {
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `target ${kind} already exists — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		writes.push({ path, kind, content: file.content, containsSecret: false });
		const attachments = collectAttachmentWrites(file, path, force, items, writes, home, source, kind);
		items.push({
			source,
			from,
			to: tildePath(home, path),
			action: "map",
			detail:
				attachments.copied === 0
					? (file.detail ?? `${kind} copied verbatim`)
					: `${file.detail ?? `${kind} copied verbatim`}, with ${attachments.copied} supporting file(s)`,
			containsSecret: false,
		});
		if (file.attachmentSkips?.length) {
			// One line per file, whatever the mix of reasons: a skill with a dozen
			// images should not turn the report into a directory listing.
			items.push({
				source,
				from,
				to: "—",
				action: "skip",
				detail: `${file.attachmentSkips.length} supporting file(s) not copied — ${summarizeNames(
					file.attachmentSkips.map((skip) => `${skip.relativePath} (${skip.reason})`),
				)}`,
				containsSecret: false,
			});
		}
	}
}

/**
 * Queue the files that belong beside `file` (a skill's `references/`, say).
 *
 * They are written into the same directory as the file they arrived with, which
 * is what keeps a skill's internal links pointing at something real after the
 * move. A supporting file that is already at the target is kept rather than
 * overwritten, for the same reason the main file is: the user may have edited
 * it, and `--force` is how they say they did not.
 */
function collectAttachmentWrites(
	file: RawFile,
	mainPath: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
	home: string,
	source: MigrationSourceId,
	kind: PlannedWrite["kind"],
): { copied: number } {
	if (!file.attachments?.length) return { copied: 0 };
	const root = dirname(mainPath);
	let copied = 0;
	for (const attachment of file.attachments) {
		const path = join(root, attachment.relativePath);
		// Guarded rather than assumed: two entries resolving to one path would
		// otherwise write twice, and the report would show one of them only.
		if (writes.some((write) => write.path === path)) continue;
		if (existsSync(path) && !force) {
			items.push({
				source,
				from: tildePath(home, join(dirname(file.sourcePath), attachment.relativePath)),
				to: "—",
				action: "skip",
				detail: `supporting ${kind} file already exists at the target — kept (use --force to overwrite)`,
				containsSecret: false,
			});
			continue;
		}
		writes.push({ path, kind, content: attachment.content, containsSecret: false });
		copied += 1;
	}
	return { copied };
}
