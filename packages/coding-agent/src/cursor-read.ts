// Cursor's user state: the rules, the two MCP documents, the CLI configuration,
// the hooks, the three asset directories, the editor's storage as a set of names,
// and the CLI's own per-workspace tree.
// Long-form design notes: docs/dev/migration-sources.md

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
	CURSOR_DIR_BASENAME,
	CURSOR_PROJECT_DATA_FILES,
	CURSOR_PROJECT_FILES,
	CURSOR_RULE_EXTENSION,
	CURSOR_USER_FILES,
	type CursorAssetKind,
	type CursorConfigRootOrigin,
	type CursorUserDataOrigin,
	cursorAssetDir,
	cursorGlobalStateDatabase,
	cursorProjectDataRoot,
	cursorProjectRoot,
	cursorPromptHistoryFile,
	cursorUserDataRoot,
	cursorUserRoot,
	cursorWorkspaceStorageDir,
} from "./cursor-home.ts";
import { isRecord, readAttachments, readText } from "./migrate-core.ts";
import type { MigrationSourceId, RawCommands, RawFile } from "./migrate-types.ts";

/** Why a `.md` in a rules directory is not imported. */
export const CURSOR_PLAIN_MARKDOWN_IGNORED =
	"a plain .md in a rules directory — cursor ignores these because they carry no frontmatter, so importing it would add text cursor never showed you";

/** Why a rule from `~/.cursor/rules` is imported but was never live. */
export const CURSOR_USER_RULES_NOT_LOADED =
	"cursor does not load this directory (User Rules are a settings-UI feature with no directory of their own), so these files are here by convention rather than because cursor read them";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** A configuration file, in the three states it can be in: absent, unreadable, document. */
export type CursorDocument =
	| { kind: "absent" }
	| { kind: "unreadable" }
	| { kind: "document"; value: Record<string, unknown> };

/** Read one JSON object, or say which of the other two things it is. */
function readCursorDocument(path: string): CursorDocument {
	if (!existsSync(path)) return { kind: "absent" };
	const text = readText(path);
	if (text === null) return { kind: "unreadable" };
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? { kind: "document", value: parsed } : { kind: "unreadable" };
	} catch {
		return { kind: "unreadable" };
	}
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** One rule file, and the one thing about it the report cannot leave out. */
export interface CursorRule {
	/** The file's name with `.mdc` replaced, so two subdirectories collide by name. */
	name: string;
	sourcePath: string;
	/** The file byte for byte, frontmatter included. */
	content: string;
	/** Which directory it came from; the two are reported apart. */
	scope: "project" | "user";
	/** Set when Cursor does not load this file itself — see the module header. */
	notLoaded?: string;
}

/** A file inside a rules directory that this importer will not import, and why. */
export interface CursorIgnoredFile {
	path: string;
	reason: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `.mdc` files under a rules directory, recursively, and the `.md` files beside them. */
function readCursorRules(projectRoot: string, userRoot: string): { rules: CursorRule[]; ignored: CursorIgnoredFile[] } {
	const rules: CursorRule[] = [];
	const ignored: CursorIgnoredFile[] = [];
	const walk = (dir: string, scope: CursorRule["scope"]): void => {
		// `Dirent[]` rather than `ReturnType<typeof readdirSync>`: that resolves to
		// the `Buffer` overload and the names come out typed as buffers, which is a
		// false statement about the filesystem that TypeScript then propagates into
		// every `.name` below.
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path, scope);
				continue;
			}
			if (entry.name.endsWith(CURSOR_RULE_EXTENSION)) {
				const content = readText(path);
				if (content === null) {
					ignored.push({ path, reason: "unreadable" });
					continue;
				}
				rules.push({
					name: entry.name.slice(0, -CURSOR_RULE_EXTENSION.length),
					sourcePath: path,
					content,
					scope,
					notLoaded: scope === "user" ? CURSOR_USER_RULES_NOT_LOADED : undefined,
				});
				continue;
			}
			// The official page is explicit: a plain `.md` here is ignored because it
			// has no frontmatter. Naming it is the whole of the treatment — importing
			// it would put text in the model's context that Cursor never showed the
			// user, which is the opposite of what a migration is for.
			if (entry.name.endsWith(".md")) ignored.push({ path, reason: CURSOR_PLAIN_MARKDOWN_IGNORED });
		}
	};
	walk(join(projectRoot, "rules"), "project");
	walk(join(userRoot, "rules"), "user");
	return { rules, ignored };
}

// ---------------------------------------------------------------------------
// Assets: commands, agents, skills
// ---------------------------------------------------------------------------

/** A file inside a tree Cursor reads that this importer will not carry, and why. */
interface CursorAssetSkip {
	path: string;
	reason: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Frontmatter the way Cursor parses it: line by line, not as YAML (`Hs` in the bundle). */
function readCursorFrontmatter(content: string): { body: string; data: Record<string, string> } | null {
	const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/m.exec(content);
	if (!match) return null;
	const body = (match[2] ?? "").trim();
	// Cursor refuses a header with nothing after it: `if (0 === n.length) return null`,
	// because the body is the agent's prompt and an empty prompt is not an agent.
	if (body.length === 0) return null;
	const data: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon === -1) continue;
		const key = trimmed.slice(0, colon).trim().toLowerCase();
		if (key.length > 0) data[key] = trimmed.slice(colon + 1).trim();
	}
	return { body, data };
}

// Long-form design notes: docs/dev/migration-sources.md
/** One `commands/` directory: the `*.md` files directly in it, and nothing else. */
function readCursorCommandDir(dir: string): { files: RawFile[]; skips: CursorAssetSkip[] } {
	const files: RawFile[] = [];
	const skips: CursorAssetSkip[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { files, skips };
	}
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			skips.push({
				path,
				reason:
					"a subdirectory — cursor reads the files directly in a commands directory and does not recurse, so a command under one is not a command to it",
			});
			continue;
		}
		// Non-`.md` files are left unmentioned, and the reason is that this is the
		// ordinary convention rather than a Cursor quirk: every command tree in this
		// repository filters on the extension, and a `notes.txt` beside a command is
		// not a thing a user needs a migration to explain. A *directory* is, because
		// the extension of a directory is a filename and Cursor's filter would have
		// accepted it.
		if (!entry.name.endsWith(".md")) continue;
		const id = entry.name.slice(0, -3);
		if (id.trim() === "") {
			skips.push({ path, reason: "the name cursor would give this command is blank, so it drops the file" });
			continue;
		}
		const content = readText(path);
		if (content === null) {
			skips.push({ path, reason: "unreadable" });
			continue;
		}
		files.push({ name: id, sourcePath: path, content: content.trim() });
	}
	return { files, skips };
}

// Long-form design notes: docs/dev/migration-sources.md
/** What a Cursor command does with its arguments: the opposite of the shared `commandAsSkill` writer. */
export const CURSOR_COMMAND_ARGUMENTS =
	"cursor substitutes $ARGUMENTS and $1-$99 when the command runs, and an argument past the end becomes blank rather than staying literal; when the file has no such placeholder it appends the arguments after a blank line instead — a skill body is never substituted, so both the placeholders and the append are behaviour this build does not have";

// Long-form design notes: docs/dev/migration-sources.md
/** A description for the imported skill, which is not the one Cursor shows. */
export function cursorCommandDescription(id: string, content: string): string {
	const heading = /^#{1,6}[ \t]+(.+)$/m.exec(content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, ""));
	const first = (heading?.[1] ?? "").trim();
	if (first) return first.replace(/\s+/g, " ");
	const line = content
		.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
		.split("\n")
		.map((entry) => entry.trim())
		.find((entry) => entry.length > 0 && !/^[-=*#]+$/.test(entry));
	return line ? line.replace(/\s+/g, " ").slice(0, 200) : `the cursor command /${id}`;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The file extensions Cursor reads an agent out of, lowercased first: `.md`, `.mdc`, `.markdown`. */
export const CURSOR_AGENT_EXTENSIONS = [".md", ".mdc", ".markdown"] as const;

// Long-form design notes: docs/dev/migration-sources.md
/** How deep the agent walk goes: 10 — this importer's own limit, the source has no cap. */
export const CURSOR_AGENT_MAX_DEPTH = 10;

/**
 * One `agents/` directory, and it is only ever the project's.
 *
 * **Source-level** — `computeAgentsDirs()` returns
 * `[join(resolve(workspacePath), ".cursor", "agents")]` and pushes `.claude` and
 * `.grok` only when third-party extensibility is on. **Every one of those joins
 * is off `resolve(this.workspacePath)`** and `homedir()` appears nowhere in the
 * method, so there is no user-level agent directory: a `~/.cursor/agents` a user
 * created by hand is not something Cursor reads, and this reader does not go
 * looking for one.
 *
 * **The walk is recursive**, unlike a commands directory's — `load()` calls the
 * ripwalk for each directory and iterates its results, with no depth check of
 * its own. A flat reader would skip a nested agent that Cursor loads.
 *
 * The file is carried over **verbatim**, which is possible because Cursor's
 * parser ({@link readCursorFrontmatter}) and the target's
 * (`subagents.ts:parseAgentDefinitions`) are the same shape: line-based `key:
 * value`, lowercased keys, no YAML. The three keys Cursor honours that the
 * target does not read are named instead.
 */
function readCursorAgentDir(dir: string): { files: RawFile[]; skips: CursorAssetSkip[] } {
	const files: RawFile[] = [];
	const skips: CursorAssetSkip[] = [];
	// Depth counted from `dir` itself, so a file directly inside it is depth 1 and
	// the cap is comparable to the source's, which counts the same way: `s` is 0
	// for the root it is handed and the guard is `if (s > 10) return`.
	const walk = (at: string, depth: number): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(at, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(at, entry.name);
			if (entry.isDirectory()) {
				if (depth + 1 > CURSOR_AGENT_MAX_DEPTH) {
					skips.push({
						path,
						reason: `below depth ${CURSOR_AGENT_MAX_DEPTH}, which is this importer's own limit — cursor's walk has none, so an agent in here is one it would load and this run does not reach`,
					});
					continue;
				}
				walk(path, depth + 1);
				continue;
			}
			if (!CURSOR_AGENT_EXTENSIONS.includes(extname(entry.name).toLowerCase() as never)) continue;
			const content = readText(path);
			if (content === null) {
				skips.push({ path, reason: "unreadable" });
				continue;
			}
			const parsed = readCursorFrontmatter(content);
			if (parsed === null) {
				skips.push({
					path,
					reason:
						content.trim() === ""
							? "empty"
							: "cursor reads an agent's prompt from the text after a frontmatter block, so a file with no block (or with an empty one) is not an agent to it",
				});
				continue;
			}
			// Long-form design notes: docs/dev/migration-sources.md
			const id = entry.name.slice(0, entry.name.length - extname(entry.name).length);
			const cursorName = parsed.data.name;
			const slug = id.replace(/[\s_]+/g, "-");
			const renames: string[] = [];
			if (cursorName && cursorName !== id) renames.push(`cursor shows this as "${cursorName}", from its "name" key`);
			if (slug !== id)
				renames.push(
					`cursor shows this as "${slug}", its file name with runs of spaces and underscores collapsed to dashes`,
				);
			const tools = parsed.data.tools ?? "";
			const losses: string[] = [];
			for (const key of ["force-default-model", "readonly", "background", "is_background"]) {
				if (parsed.data[key] !== undefined) losses.push(`"${key}"`);
			}
			files.push({
				name: id,
				sourcePath: path,
				content,
				detail:
					`agent copied verbatim — the text after the frontmatter is cursor's own prompt for it, and its "name", "description", "tools" (${tools || "none"}) and "model" keys are read here in the same spelling` +
					(renames.length > 0
						? `; named "${id}" here rather than by cursor, which names it differently, and the name is the only thing that changed: ${renames.join("; ")}`
						: "") +
					(losses.length > 0
						? `; not read here: ${losses.join(", ")} — cursor uses them to pick the model, the permission mode and whether the agent runs in the background, and this build has no key for any of the three`
						: ""),
			});
		}
	};
	walk(dir, 0);
	return { files, skips };
}

/** How deep `findSkillMarkdownFiles` walks before it gives up. */
const CURSOR_SKILL_MAX_DEPTH = 10;

// Long-form design notes: docs/dev/migration-sources.md
/** One `skills/` directory, walked the way Cursor walks it (`findSkillMarkdownFiles`). */
function readCursorSkillDir(root: string): { files: RawFile[]; skips: CursorAssetSkip[] } {
	const skips: CursorAssetSkip[] = [];
	const found: string[] = [];
	const seen = new Set<string>();
	const walk = (dir: string, depth: number): void => {
		if (depth > CURSOR_SKILL_MAX_DEPTH) {
			skips.push({
				path: dir,
				reason: `more than ${CURSOR_SKILL_MAX_DEPTH} directories below the skills directory — cursor stops walking here too, so anything under it is not a skill to it`,
			});
			return;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path, depth + 1);
				continue;
			}
			if (entry.name !== "SKILL.md") continue;
			if (seen.has(path)) continue;
			seen.add(path);
			found.push(path);
		}
	};
	walk(root, 0);
	if (found.length === 0) return { files: [], skips };

	// `dupNames` first, then the ids: whether a name is relative or bare depends
	// on the whole set, so a name cannot be settled as each file is found.
	const skillDirs = found.map((path) => dirname(path));
	const bareNames = skillDirs.map((dir) => basename(dir));
	const counts = new Map<string, number>();
	for (const name of bareNames) counts.set(name, (counts.get(name) ?? 0) + 1);

	const files: RawFile[] = [];
	for (const [index, path] of found.entries()) {
		const bare = bareNames[index];
		// `getRelativeSkillId`: the path under the root, its segments joined with
		// `-`. Only reached when the bare name is duplicated, which is what stops
		// two unrelated `deploy` directories from arriving as one skill.
		const under = skillDirs[index].startsWith(root) ? skillDirs[index].slice(root.length) : "";
		const relative = under
			.split(/[/\\]+/)
			.filter((part) => part.length > 0)
			.join("-");
		const base = (counts.get(bare) ?? 0) > 1 && relative.length > 0 ? relative : bare;
		// Long-form design notes: docs/dev/migration-sources.md
		const name = base;
		const content = readText(path);
		if (content === null) {
			skips.push({ path, reason: "unreadable" });
			continue;
		}
		// The rest of the directory travels with the file even though Cursor loads
		// only `SKILL.md`. Those are different questions: what the model is *told*
		// at load time, and what the skill may use when it runs. A skill whose
		// body says "run `scripts/check.sh``" needs that script, and Cursor keeps
		// the script next to the `SKILL.md` it read. `readAttachments` is the
		// shared walk — the same size cap, the same binary and VCS exclusions, the
		// same skip reasons in the report.
		const { attachments, attachmentSkips } = readAttachments(dirname(path));
		const nameNote =
			base === bare
				? `named after the directory cursor names it after ("${bare}")`
				: `cursor calls this "${bare}", and because more than one directory in this tree has that name it uses the path instead — "${base}"`;
		files.push({
			name,
			sourcePath: path,
			content,
			attachments,
			attachmentSkips,
			detail: `skill copied verbatim, ${nameNote}; cursor loads only SKILL.md, and the rest of the directory is carried with it so the skill still has what it names`,
		});
	}
	return { files, skips };
}

// Long-form design notes: docs/dev/migration-sources.md
/** The trees Cursor harvests that another source in this repository already owns, per asset kind. */
export const CURSOR_VENDOR_TREES: Readonly<
	Record<
		CursorAssetKind,
		ReadonlyArray<{ dir: string; owner: MigrationSourceId; scopes: ReadonlyArray<"user" | "project"> }>
	>
> = {
	commands: [{ dir: ".claude", owner: "claude-code", scopes: ["user", "project"] }],
	agents: [
		{ dir: ".claude", owner: "claude-code", scopes: ["project"] },
		{ dir: ".grok", owner: "grok-build", scopes: ["project"] },
	],
	skills: [
		{ dir: ".claude", owner: "claude-code", scopes: ["user", "project"] },
		{ dir: ".codex", owner: "codex", scopes: ["user", "project"] },
		{ dir: ".grok", owner: "grok-build", scopes: ["user", "project"] },
		{ dir: ".agents", owner: "agents", scopes: ["user", "project"] },
	],
};

/** A vendor tree Cursor reads, at the level it was found. */
export interface CursorVendorTreeHit {
	kind: CursorAssetKind;
	/** The config directory it lives under, leading dot and all: `.claude`. */
	dir: string;
	/** The source in this repository that imports it. */
	owner: MigrationSourceId;
	scope: "user" | "project";
}

/** The three asset kinds, as one run found them. */
export interface RawCursorAssets {
	commands: RawCommands;
	agents: RawFile[];
	/** Agent-shaped files Cursor does not read as agents, with the reason. */
	agentSkips: Array<{ path: string; reason: string }>;
	skills: RawFile[];
	/** Directories the walk gave up on, with the reason. */
	skillSkips: Array<{ path: string; reason: string }>;
	/**
	 * Named by their presence, not by a scan — the same call
	 * `opencode-read.ts` makes, and for the same reason: the point of the line is
	 * that the user learns another source owns the tree, and counting the files in
	 * it would say nothing they can act on.
	 */
	vendorTrees: CursorVendorTreeHit[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Both halves of the three directories, which is not the same six paths. */
export function readCursorAssets(home: string, cwd: string): RawCursorAssets {
	// Long-form design notes: docs/dev/migration-sources.md
	const projectRoot = cursorProjectRoot(cwd);
	const commands: RawCommands = { files: [], skips: [] };
	for (const root of [home, cwd]) {
		const read = readCursorCommandDir(join(root, CURSOR_DIR_BASENAME, "commands"));
		commands.files.push(...read.files);
		commands.skips.push(...read.skips);
	}
	const agentRead = readCursorAgentDir(cursorAssetDir(projectRoot, "agents"));
	const skills: RawFile[] = [];
	const skillSkips: Array<{ path: string; reason: string }> = [];
	for (const root of [home, cwd]) {
		const read = readCursorSkillDir(join(root, CURSOR_DIR_BASENAME, "skills"));
		skills.push(...read.files);
		skillSkips.push(...read.skips);
	}

	const vendorTrees: CursorVendorTreeHit[] = [];
	for (const kind of ["commands", "agents", "skills"] as const) {
		for (const entry of CURSOR_VENDOR_TREES[kind]) {
			// Long-form design notes: docs/dev/migration-sources.md
			for (const [scope, base] of [
				["user", home],
				["project", cwd],
			] as const) {
				if (!entry.scopes.includes(scope)) continue;
				if (existsSync(join(base, entry.dir, kind)))
					vendorTrees.push({ kind, dir: entry.dir, owner: entry.owner, scope });
			}
		}
	}
	return { commands, agents: agentRead.files, agentSkips: agentRead.skips, skills, skillSkips, vendorTrees };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** One `mcp.json`, read as the document it is. */
export interface RawCursorMcpDocument {
	path: string;
	/** `mcpServers` as Cursor wrote it. Empty when the file has no such key. */
	servers: Record<string, unknown>;
	/** The file was there and its `mcpServers` was not a table of servers. */
	malformed: boolean;
	/** The file was there and is not JSON at all. */
	unreadable: boolean;
}

function readCursorMcpDocument(path: string): RawCursorMcpDocument {
	const doc = readCursorDocument(path);
	if (doc.kind === "absent") return { path, servers: {}, malformed: false, unreadable: false };
	if (doc.kind === "unreadable") return { path, servers: {}, malformed: false, unreadable: true };
	const servers = doc.value.mcpServers;
	if (servers === undefined) return { path, servers: {}, malformed: false, unreadable: false };
	if (!isRecord(servers)) return { path, servers: {}, malformed: true, unreadable: false };
	return { path, servers, malformed: false, unreadable: false };
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

/** Names in a directory this importer has no mapping for; a missing one is none. */
function unaccountedNames(dir: string, accounted: readonly string[]): string[] {
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((name) => !accounted.includes(name))
			.sort();
	} catch {
		return [];
	}
}

/**
 * The editor's databases, by name only.
 *
 * `state.vscdb` is `existsSync` and nothing else — the chat bodies are in it and
 * this importer cannot carry them (see `cursorStateDatabase`). The count is the
 * part that earns its keep: it is a fact about what is being left behind.
 */
function readCursorStateDatabases(userData: string): RawCursor["stateDatabases"] {
	const out: RawCursor["stateDatabases"] = [];
	const global = cursorGlobalStateDatabase(userData);
	if (existsSync(global)) out.push({ path: global, kind: "global" });
	const storage = cursorWorkspaceStorageDir(userData);
	try {
		for (const entry of readdirSync(storage, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(storage, entry.name, "state.vscdb");
			if (existsSync(path)) out.push({ path, kind: "workspace", workspace: entry.name });
		}
	} catch {
		// no workspaceStorage: the editor has not been opened here, or the directory
		// is not readable, and either way there is no database to name
	}
	return out;
}

// Long-form design notes: docs/dev/migration-sources.md
/** The CLI's per-workspace data tree, and the known files in it, named rather than addressed. */
function readCursorProjectData(home: string): RawCursor["projectData"] {
	const root = cursorProjectDataRoot(home);
	if (!existsSync(root)) return { root: null, files: [] };
	const files: RawCursor["projectData"]["files"] = [];
	try {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			// `Object.entries` rather than `Object.keys` and a lookup: the lookup
			// needed a non-null assertion, because the key type is `string` and the
			// table is `Record<string, …>` — an assertion standing in for a lookup
			// that cannot miss. The entries carry the value along.
			for (const [name, kind] of Object.entries(CURSOR_PROJECT_DATA_FILES)) {
				const path = join(root, entry.name, name);
				if (existsSync(path)) files.push({ name, path, workspace: entry.name, kind });
			}
		}
	} catch {
		// the tree is there but not readable, which is a report sentence rather than
		// a failure: what would have been in it is unnameable either way
	}
	// Sorted by workspace then by file name, so two runs over the same tree print
	// the same line. `readdirSync` order is filesystem order, which is not.
	return { root, files: files.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name)) };
}

/** Cursor's user state. */
export interface RawCursor {
	roots: {
		user: string;
		project: string;
		userData: string;
		userDataOrigin: CursorUserDataOrigin;
	};
	// Long-form design notes: docs/dev/migration-sources.md
	/** True when there is anything here at all: wider than "does `~/.cursor` exist", narrower than "does any of them exist". */
	present: boolean;
	rules: CursorRule[];
	/** `.md` files in a rules directory, which Cursor ignores. Named, never imported. */
	ignored: CursorIgnoredFile[];
	/** The three reusable-text directories, and the vendor trees left to their owners. */
	assets: RawCursorAssets;
	/** Global MCP document, then the project's; both may be present. */
	mcp: RawCursorMcpDocument[];
	cli: { global: CursorDocument; project: CursorDocument };
	hooks: { global: CursorDocument; project: CursorDocument };
	stateDatabases: Array<{ path: string; kind: "workspace" | "global"; workspace?: string }>;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The CLI's per-workspace data tree under its own data root, kept apart from `stateDatabases`. */
	projectData: {
		root: string | null;
		files: Array<{ name: string; path: string; workspace: string; kind: "credential" | "decision" }>;
	};
	/** The CLI's prompt list, and which of the three config-root rules answered. */
	promptHistory: { path: string; origin: CursorConfigRootOrigin } | null;
	/** Entries of the user directory this importer reads nothing out of. */
	otherUserFiles: string[];
	/** Entries of the project directory this importer reads nothing out of. */
	otherProjectEntries: string[];
}

export function readCursor(home: string, cwd: string): RawCursor {
	const userRoot = cursorUserRoot(home);
	const projectRoot = cursorProjectRoot(cwd);
	const userData = cursorUserDataRoot(home);

	const { rules, ignored } = readCursorRules(projectRoot, userRoot);
	const cli = {
		global: readCursorDocument(join(userRoot, "cli-config.json")),
		project: readCursorDocument(join(projectRoot, "cli.json")),
	};
	const hooks = {
		global: readCursorDocument(join(userRoot, "hooks.json")),
		project: readCursorDocument(join(projectRoot, "hooks.json")),
	};
	const mcp = [readCursorMcpDocument(join(userRoot, "mcp.json")), readCursorMcpDocument(join(projectRoot, "mcp.json"))];
	const stateDatabases = readCursorStateDatabases(userData.root);
	const projectData = readCursorProjectData(home);
	const promptHistoryFile = cursorPromptHistoryFile(home, cwd);
	const assets = readCursorAssets(home, cwd);

	const documentCount = (doc: CursorDocument): number => (doc.kind === "document" ? Object.keys(doc.value).length : 0);
	// The three asset directories join the accounted lists, or the same run would
	// print both halves of a contradiction: a line saying `commands` was imported,
	// and a line saying `commands` is one of the entries this importer reads
	// nothing out of. `rules` has been in both lists since before there were
	// assets, which is the shape being followed here.
	const assetDirs = ["commands", "agents", "skills"];
	// Long-form design notes: docs/dev/migration-sources.md
	const dataProjects = cursorProjectDataRoot(home);
	const accountedAt = (root: string, files: Readonly<Record<string, string>>): string[] => [
		...Object.keys(files),
		"rules",
		...assetDirs,
		...(join(root, "projects") === dataProjects ? ["projects"] : []),
	];
	const otherUserFiles = unaccountedNames(userRoot, accountedAt(userRoot, CURSOR_USER_FILES));
	const otherProjectEntries = unaccountedNames(projectRoot, accountedAt(projectRoot, CURSOR_PROJECT_FILES));
	return {
		roots: { user: userRoot, project: projectRoot, userData: userData.root, userDataOrigin: userData.origin },
		present:
			rules.length > 0 ||
			mcp.some((doc) => Object.keys(doc.servers).length > 0) ||
			// A document that is there and unreadable has a whole sentence written
			// for it in the plan — "the file is there but is not a JSON object, so no
			// server could be read out of it" — and a source that is not `present`
			// prints none of them. The same reasoning as the prompt list and the two
			// lists of names below: gate on the sentences, not on the importable
			// files alone.
			mcp.some((doc) => doc.malformed || doc.unreadable) ||
			documentCount(cli.global) > 0 ||
			documentCount(cli.project) > 0 ||
			documentCount(hooks.global) > 0 ||
			documentCount(hooks.project) > 0 ||
			stateDatabases.length > 0 ||
			// The prompt list is buried where no other file this importer reads is:
			// under the CLI's own home, but three directories down, in a per-workspace
			// subtree named by a digest of the cwd. So it is the one piece of
			// evidence that a user who has typed prompts and written no rule, no
			// config and no server file would otherwise not have counted as an
			// install. Excluding it made the report say "nothing migratable in it"
			// while sitting on the very file the run exists to read.
			promptHistoryFile !== null ||
			// The asset directories, on the same grounds as `promptHistoryFile`: a
			// user who has written three commands and nothing else has a Cursor
			// install, and gating on the importable files alone is what would have
			// called that home empty. `vendorTrees` is here for the same reason the
			// two name lists are — the sentence naming the owner is the whole
			// treatment, and a source that is not `present` prints none of it.
			assets.commands.files.length > 0 ||
			assets.commands.skips.length > 0 ||
			assets.agents.length > 0 ||
			assets.agentSkips.length > 0 ||
			assets.skills.length > 0 ||
			assets.skillSkips.length > 0 ||
			assets.vendorTrees.length > 0 ||
			// Long-form design notes: docs/dev/migration-sources.md
			projectData.root !== null ||
			// Same reasoning for the two lists of names. A home whose only Cursor
			// file is `permissions.json` is a home where the report has something to
			// say — the sentence explaining that it is the IDE's list and not the
			// one in effect is the entire treatment — and gating on the importable
			// files alone meant that sentence could never be printed.
			ignored.length > 0 ||
			otherUserFiles.length > 0 ||
			otherProjectEntries.length > 0,
		rules,
		ignored,
		assets,
		mcp,
		cli,
		hooks,
		stateDatabases,
		projectData,
		promptHistory: promptHistoryFile,
		otherUserFiles,
		otherProjectEntries,
	};
}
