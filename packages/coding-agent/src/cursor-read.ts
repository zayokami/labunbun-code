/**
 * Cursor's user state: the rules, the two MCP documents, the CLI configuration,
 * the hooks, and the editor's storage as a set of names.
 *
 * Read `cursor-home.ts` first: every claim here about *where* something is comes
 * from that module, and it is documentation-level rather than source-level, which
 * is the standing caveat for this source. What follows is only about *shape*.
 *
 * Three things about Cursor's shape are load-bearing and none of them is obvious:
 *
 * 1. **The rules are `.mdc` and the frontmatter is three keys** — `description`,
 *    `globs`, `alwaysApply` — with `globs` written as a comma-delimited *string*,
 *    not a YAML list. There is no `ruleType`: the four rule behaviours come out of
 *    combinations of those three, and a `ruleType` seen in the wild came from a
 *    generator. The frontmatter is carried over verbatim (see `cursor-plan.ts`);
 *    what does not survive is the *activation*, and that is the downgrade.
 * 2. **A plain `.md` in a rules directory is ignored by Cursor** — the official
 *    page says so in as many words, and gives the reason (no frontmatter). Those
 *    files are named rather than imported: they are either a mistake or a
 *    convention for another tool, and either way importing them would put prose in
 *    the user's context that Cursor itself never showed them.
 * 3. **There are three permission systems and they do not overlap.** The CLI's
 *    (`permissions` in `cli-config.json` / `cli.json`), the IDE's
 *    (`permissions.json`, not read by the CLI), and the in-app command allowlist,
 *    which overrides the IDE's. Only the first is read here, and the report says
 *    which one it was.
 */

import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	CURSOR_PROJECT_FILES,
	CURSOR_RULE_EXTENSION,
	CURSOR_USER_FILES,
	type CursorConfigRootOrigin,
	type CursorUserDataOrigin,
	cursorGlobalStateDatabase,
	cursorProjectRoot,
	cursorPromptHistoryFile,
	cursorUserDataRoot,
	cursorUserRoot,
	cursorWorkspaceStorageDir,
} from "./cursor-home.ts";
import { isRecord, readText } from "./migrate-core.ts";

/** Why a `.md` in a rules directory is not imported. */
export const CURSOR_PLAIN_MARKDOWN_IGNORED =
	"a plain .md in a rules directory — cursor ignores these because they carry no frontmatter, so importing it would add text cursor never showed you";

/** Why a rule from `~/.cursor/rules` is imported but was never live. */
export const CURSOR_USER_RULES_NOT_LOADED =
	"cursor does not load this directory (User Rules are a settings-UI feature with no directory of their own), so these files are here by convention rather than because cursor read them";

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * A configuration file, in the three states it can be in.
 *
 * "Absent" and "unreadable" are kept apart because the report prints different
 * sentences for them and only one of them is worth explaining: a file the user
 * wrote and that does not parse is a fact they need, and folding it into
 * "nothing there" is how a broken edit goes unnoticed for months.
 */
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

/**
 * `.mdc` files under a rules directory, recursively, and the `.md` files beside them.
 *
 * Recursion is the documented shape and not quite the documented *claim*: the
 * official rules page shows a nested layout as its own example
 * (`frontend/components.mdc`) and never says whether discovery stops at the top
 * level. Reading recursively is right if it recurses and harmless if it does not,
 * because a nested file Cursor ignores is a file a user wrote and would expect to
 * come across.
 *
 * The two directories are walked separately and kept apart, because they are
 * different things: `<project>/.cursor/rules` is Cursor's own and is loaded, and
 * `~/.cursor/rules` is a community convention that **Cursor staff say is not
 * supported** — User Rules are a settings-UI feature with no directory of their
 * own. Those files are still imported, because the user wrote them and the
 * importer's job is to carry them, but each one says in the report that Cursor
 * itself never loaded it.
 */
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

/** Cursor's user state. */
export interface RawCursor {
	roots: {
		user: string;
		project: string;
		userData: string;
		userDataOrigin: CursorUserDataOrigin;
	};
	/**
	 * True when there is anything here at all.
	 *
	 * Wider than "does `~/.cursor` exist", for the same reason OpenCode's is: a
	 * Cursor install that has been opened and used leaves its state in the editor's
	 * user-data directory, and a user who never touched the CLI's files still has a
	 * tree worth naming. Narrower than "does any of them exist", because an empty
	 * directory has nothing to import.
	 */
	present: boolean;
	rules: CursorRule[];
	/** `.md` files in a rules directory, which Cursor ignores. Named, never imported. */
	ignored: CursorIgnoredFile[];
	/** Global MCP document, then the project's; both may be present. */
	mcp: RawCursorMcpDocument[];
	cli: { global: CursorDocument; project: CursorDocument };
	hooks: { global: CursorDocument; project: CursorDocument };
	stateDatabases: Array<{ path: string; kind: "workspace" | "global"; workspace?: string }>;
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
	const promptHistoryFile = cursorPromptHistoryFile(home, cwd);

	const documentCount = (doc: CursorDocument): number => (doc.kind === "document" ? Object.keys(doc.value).length : 0);
	const otherUserFiles = unaccountedNames(userRoot, [...Object.keys(CURSOR_USER_FILES), "rules"]);
	const otherProjectEntries = unaccountedNames(projectRoot, [...Object.keys(CURSOR_PROJECT_FILES), "rules"]);
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
		mcp,
		cli,
		hooks,
		stateDatabases,
		promptHistory: promptHistoryFile,
		otherUserFiles,
		otherProjectEntries,
	};
}
