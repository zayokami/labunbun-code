/**
 * Cursor's user state: the rules, the two MCP documents, the CLI configuration,
 * the hooks, the three asset directories, the editor's storage as a set of names,
 * and the CLI's own per-workspace tree.
 *
 * **The citations here are of two kinds and each claim below is marked with
 * which one it is.** `DOCUMENTATION-LEVEL` means a second-hand claim with a date
 * on it, checkable only against Cursor's published pages. `SOURCE-LEVEL` means it
 * was read out of the minified bundle the CLI actually ships — build
 * `2026.09.26-dd393fe` — and is cited as **module path + function name + build
 * id**, never as a `file:line`, which would be invented precision about a file
 * nobody can open.
 *
 * The two kinds are not equal in what a reader owes the user, and the standing
 * caveat used to be "this source is documentation-level throughout". It stopped
 * being true when the CLI bundle was unpacked, and the split is worth keeping
 * visible: a reader deciding whether to trust a sentence should not have to guess
 * which of two standards it was written to. Every source-level claim in this
 * module is about *shape or path arithmetic* — the parts documentation does not
 * cover and that were wrong before they were checked. Every documentation-level
 * claim is about a file Cursor documents, where the docs and the file agree.
 *
 * Six things about Cursor's shape are load-bearing and none of them is obvious:
 *
 * 1. **The rules are `.mdc` and the frontmatter is three keys** — `description`,
 *    `globs`, `alwaysApply` — with `globs` written as a comma-delimited *string*,
 *    not a YAML list. There is no `ruleType`: the four rule behaviours come out of
 *    combinations of those three, and a `ruleType` seen in the wild came from a
 *    generator. The frontmatter is carried over verbatim (see `cursor-plan.ts`);
 *    what does not survive is the *activation*, and that is the downgrade.
 *    *DOCUMENTATION-LEVEL.*
 * 2. **A plain `.md` in a rules directory is ignored by Cursor** — the official
 *    page says so in as many words, and gives the reason (no frontmatter). Those
 *    files are named rather than imported: they are either a mistake or a
 *    convention for another tool, and either way importing them would put prose in
 *    the user's context that Cursor itself never showed them.
 *    *DOCUMENTATION-LEVEL.*
 * 3. **There are three permission systems and they do not overlap.** The CLI's
 *    (`permissions` in `cli-config.json` / `cli.json`), the IDE's
 *    (`permissions.json`, not read by the CLI), and the in-app command allowlist,
 *    which overrides the IDE's. Only the first is read here, and the report says
 *    which one it was. *SOURCE-LEVEL* for the CLI's list and the IDE's being
 *    unread by it; *DOCUMENTATION-LEVEL* for the third, which is an in-app
 *    feature with no file behind it.
 * 4. **Three of the trees Cursor reads are not its own, and copying them would
 *    file every one of the user's skills under the wrong tool.** See
 *    {@link CURSOR_VENDOR_TREES} — the exclusion is per asset kind, because the
 *    three kinds do not read the same four directories, and a flat list would
 *    either miss a tree Cursor really does read or claim one it does not.
 *    *SOURCE-LEVEL* (`$n` and the `thirdParty` marks, build `2026.09.26-dd393fe`).
 * 5. **The three asset kinds are read differently**, and the differences are the
 *    whole of how they are read — commands are user *and* project, one level,
 *    `*.md` only; agents are **project only**; skills are user and project,
 *    recursive to a depth limit. *SOURCE-LEVEL.*
 * 6. **A command has no frontmatter and its arguments are substituted, not
 *    appended.** Both are the opposite of what the shared `commandAsSkill` path
 *    says, which is why this source writes its own. *SOURCE-LEVEL* — see
 *    {@link CURSOR_COMMAND_ARGUMENTS} for the substitution rule verbatim and
 *    `parseMarkdownCommand` for the title extraction.
 *
 * **What is deliberately not read**, and is named rather than quietly skipped:
 * the chat bodies, which live in the editor's SQLite `state.vscdb` and are keyed
 * by a workspace hash this importer cannot recompute; the MCP OAuth tokens under
 * the CLI's data root, which are `existsSync` and nothing else; and the two
 * decision lists beside them. {@link readCursorStateDatabases} and
 * {@link readCursorProjectData} are the two readers that do nothing but count
 * and name, and both say why in place.
 */

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
// Assets: commands, agents, skills
// ---------------------------------------------------------------------------

/** A file inside a tree Cursor reads that this importer will not carry, and why. */
interface CursorAssetSkip {
	path: string;
	reason: string;
}

/**
 * Frontmatter the way Cursor parses it: **line by line, not as YAML.**
 *
 * Verbatim from the bundle (`Hs`, build `2026.09.26-dd393fe`):
 *
 * ```js
 * for (const e of r.split("\n")) {
 *   const t = e.trim();
 *   if (!t.length || t.startsWith("#")) continue;
 *   const r = t.indexOf(":");
 *   if (-1 === r) continue;
 *   s[t.slice(0, r).trim().toLowerCase()] = t.slice(r + 1).trim();
 * }
 * ```
 *
 * So a value is whatever follows the first colon, a key is lowercased, `#` lines
 * are comments, and nothing is nested. This is the same parser
 * `subagents.ts:parseAgentDefinitions` uses on the target side, which is why an
 * agent file is carried over **byte for byte** rather than rewritten: every key
 * Cursor honours that this build also honours is already in the same spelling.
 */
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

/**
 * One `commands/` directory: the `*.md` files directly in it, and nothing else.
 *
 * **Source-level** — `loadCommandsFromDirectory` (build `2026.09.26-dd393fe`):
 *
 * ```js
 * const n = (yield this.readDirectory(e)).filter((e) => !e.isDirectory && e.name.endsWith(".md"));
 * ```
 *
 * **Not recursive**, so a command in a subdirectory is invisible to Cursor and
 * must not be invented here — it is named instead. And a file whose name minus
 * `.md` is blank is dropped by Cursor itself (`if (!o.trim()) return null`).
 *
 * The description Cursor derives is worth stating because it is a source of
 * surprise rather than a design: `extractTitle` is applied to the **first line
 * only**, and falls back to that line verbatim when it is not a heading. A
 * command that opens with a frontmatter block is therefore described to the
 * model as the three characters `---`. {@link cursorCommandDescription} does not
 * reproduce that; it looks for the first heading anywhere in the file, which is
 * the same text the author meant.
 */
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

/**
 * The one line that says what a Cursor command does with its arguments, and it
 * is the opposite of what the shared command writer says for the other sources.
 *
 * **Source-level** — build `2026.09.26-dd393fe`:
 *
 * ```js
 * let r = e, o = false;
 * r.includes("$ARGUMENTS") && (o = true, r = r.replace(/\$ARGUMENTS/g, t.join(" ")));
 * /(?<!\w)\$(\d{1,2})\b/g.test(r) && (r = r.replace(…, (m, d) => n > 0 && n <= t.length ? t[n - 1] : ""));
 * const i = o ? r : t.length ? `${e}\n\n${t.join(" ")}` : e;
 * ```
 *
 * Three facts, and the shared `commandAsSkill` detail would state the first one
 * backwards:
 *
 *   - **`$ARGUMENTS` *is* substituted**, and so is `$1` through `$99` — not
 *     `$1` through `$9`. The guard is `(?<!\w)`, so `$1` inside `$12` does not
 *     match on its own.
 *   - **An argument with no matching placeholder becomes the empty string**, not
 *     the literal `$7`.
 *   - **The arguments are appended only when nothing was substituted.** With a
 *     placeholder, the substituted text *replaces* them; without one, they land
 *     after a blank line. So "appends its arguments" and "substitutes
 *     `$ARGUMENTS`" are not two descriptions of the same command — they are two
 *     different commands, and the file says which.
 */
export const CURSOR_COMMAND_ARGUMENTS =
	"cursor substitutes $ARGUMENTS and $1-$99 when the command runs, and an argument past the end becomes blank rather than staying literal; when the file has no such placeholder it appends the arguments after a blank line instead — a skill body is never substituted, so both the placeholders and the append are behaviour this build does not have";

/**
 * A description for the imported skill, which is not the one Cursor shows.
 *
 * Cursor reads the **first line** and, if it is not a heading, uses that line
 * verbatim — so a file opening with `---` is described as `---`. This looks for
 * the first heading anywhere, then for the first line that is neither the
 * frontmatter fence nor blank, and finally says what the file is rather than
 * inventing prose for it.
 */
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

/**
 * The file extensions Cursor reads an agent out of.
 *
 * **Source-level** — `Ys` in the same module as the subagent loader, passed as
 * `includeFile` to the ripwalk that collects them (build `2026.09.26-dd393fe`):
 *
 * ```js
 * function Ys(e){const t=(0,s.extname)(e).toLowerCase();
 *   return ".md"===t||".mdc"===t||".markdown"===t}
 * ```
 *
 * Three extensions, not one, and lowercased first — so `AGENT.MD` counts. A
 * reader that took only `.md` would skip a file Cursor loads, and an `.mdc` in
 * an agents directory is not a strange thing to find: `.mdc` is the extension
 * Cursor's *rules* use, so a user who copied a rule-shaped file across would
 * produce one by accident.
 */
export const CURSOR_AGENT_EXTENSIONS = [".md", ".mdc", ".markdown"] as const;

/**
 * How deep the agent walk goes.
 *
 * **The source has no cap** — the ripwalk it hands to runs until the filesystem
 * runs out — and this is the one place the importer's answer is not the
 * source's. A cap is imposed because a walk with no bound is a walk a user can
 * make slow, and because every other walk in this repository has one.
 *
 * The value is `CURSOR_SKILL_MAX_DEPTH`'s, and deliberately the same number
 * rather than a new one: two walks in one product that both stop at ten is a
 * coincidence, and matching it means the report can say "ten" once per kind
 * rather than inviting the reader to wonder whether the two differ for a reason.
 * What the walk gives up on is **named**, so a tree deeper than this is a report
 * sentence and not a silent omission.
 */
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
			// The filename, not the frontmatter's `name`, because that is what
			// `readAgentFiles` — the reader the other sources share — uses, and the
			// directory this lands in is built from it.
			//
			// **That is a divergence from Cursor and it is reported.** The loader does
			// `name: n.name || Vs(basename)`, where `Vs` is
			// `basename(e, extname(e)).replace(/[\s_]+/g, "-")` — so Cursor shows the
			// frontmatter's name when there is one, and otherwise a *slugified*
			// basename, which is not the filename either. Two files called
			// `code reviewer.md` and `code-reviewer.md` are the same agent to Cursor
			// and two to this run. The target reads the filename, so that is what the
			// directory is named, and the difference is the user's to see.
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

/**
 * One `skills/` directory, walked the way Cursor walks it.
 *
 * **Source-level** — `findSkillMarkdownFiles` (build `2026.09.26-dd393fe`)
 * recurses under `if (s > 10) return`, keeps only files named exactly
 * `SKILL.md`, and resolves each directory before descending on it, requiring the
 * resolved path to still be inside the root — in the project scope. That last
 * one is not reproduced here as a check, because the walk never leaves the root
 * on its own: `readdirSync` reports a symlink as a link rather than a
 * directory, so a linked directory falls out of the walk instead of being
 * descended into. The difference is only in *which* links get followed, never
 * in what is left behind, and following none of them is the conservative side:
 * a link is the one way a scan of a workspace tree reaches a directory the user
 * keeps somewhere else entirely.
 *
 * **The name is the directory holding `SKILL.md`, not the top-level one**, and
 * that is a different rule from every other reader in this repository. It is
 * `getSkillIdForPath`:
 *
 * ```js
 * const s = basename(dirname(skillMdPath));
 * const a = dupNames.has(s) && getRelativeSkillId(root, skillMdPath) ? getRelativeSkillId(…) : s;
 * let d = a, l = 2;
 * for (; taken.has(d); ) d = `${a}-${l}`, l++;
 * ```
 *
 * So a nested `frontend/deploy/SKILL.md` is the skill `deploy`; only when two
 * of them are called `deploy` does the path come in, joined with `-`. Getting
 * the first case wrong would name every nested skill after its top-level
 * directory and merge unrelated ones.
 *
 * **The third line of that snippet is not reproduced, on purpose** — see the
 * note at the `const name = base` below, which is where the reason belongs.
 */
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
		// `name` is `base`, and the source's own `for (; taken.has(d); ) d =
		// \`${a}-${l++}\`` is deliberately **not** reproduced. Its `taken` set spans
		// every root of one load; this set spans one `skills` directory, and within
		// one directory the rule above already yields distinct names — the bare name
		// is used only when it is unique, and the relative path is unique by
		// construction. So the loop cannot fire here, and a mechanism that can only
		// be a no-op is one more thing that reads as load-bearing. The case the
		// source's suffix exists for — the same id claimed by the user half and the
		// project half of a home that is also its own project — is caught one layer
		// up by `collectFileWrites`, which reports the collision and keeps the first
		// rather than inventing a second directory.
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

/**
 * The trees Cursor harvests that another source in this repository already owns.
 *
 * **Per asset kind, because the three kinds do not read the same trees.** A flat
 * list would be wrong in both directions: naming `.codex` for commands would
 * claim Cursor reads `~/.codex/commands` (it does not), and stopping at `.claude`
 * for skills would import a second copy of every Claude skill the user has.
 *
 * **Source-level**, build `2026.09.26-dd393fe` — the roots each kind loads:
 *
 *   - skills: `$n` in `index.js` pairs `{configDir, subdir, thirdParty}`, and
 *     `Wn(enabled)` is `$n.filter(t => !t.builtin && (enabled || !t.thirdParty))`.
 *     The `configDir` values are `.cursor` and the four vendors `.claude`,
 *     `.codex`, `.grok`, `.agents`, at **both** the user and the workspace level,
 *     through `Dct` and `x7$`. **And `.agents` is marked `thirdParty: false` in
 *     that table** — unlike `.claude`, `.codex` and `.grok`, which are `true` —
 *     so Cursor treats `~/.agents/skills` as a first-class skill root. It is
 *     excluded here for a different reason and on a different warrant: not
 *     "Cursor marks it another tool's" but "this repository's `agents` source
 *     imports it, and importing it twice would file the same skill under two
 *     names". The exclusion is the same; the reason printed is not, and a report
 *     that gave Cursor's reason would be asserting something the source denies.
 *   - agents: `computeAgentsDirs()` pushes `.claude` and `.grok` only, and only
 *     when third-party extensibility is on — and **off the resolved workspace
 *     path alone**. There is no `homedir()` anywhere in it, so the two agent
 *     trees have **no user half at all**, which is why `scopes` below is the one
 *     place the table says where each tree can be.
 *   - commands: loaded from `.claude` at both levels, **ungated** — the
 *     extensibility flag does not apply to commands at all.
 *
 * Each entry's `owner` is a `MIGRATION_SOURCE_IDS` member that really does read
 * that directory for that kind; that was checked per entry rather than assumed
 * from the name, because the same vendor id is not good for all three kinds.
 *
 * **The flag that decides half of this is not modelled, and does not need to
 * be.** `thirdPartyExtensibilityEnabled` defaults to `true`
 * (`t?.thirdPartyExtensibilityEnabled ?? true`, and no configuration key in the
 * bundle turns it off), but excluding these trees is right in **both** states:
 *
 *   - **on** — Cursor would read them, and copying them would file a Claude
 *     skill under Cursor's name as well, so the user ends up with two of every
 *     one and no way to tell which is the copy that came from where.
 *   - **off** — the trees are none of Cursor's business, and the source that
 *     does own them brings them in its own run.
 *
 * So the answer is the same either way, and a report sentence that branched on
 * the flag would be branching on something with no second outcome.
 */
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

/**
 * Both halves of the three directories, which is not the same six paths.
 *
 * **Agents have no user half.** `computeAgentsDirs()` computes the list from
 * `resolve(this.workspacePath)` and there is no other call site for it anywhere
 * in the bundle, so a `~/.cursor/agents` a user built by hand is not read by
 * Cursor. Reading it here would mean importing a directory the source is
 * documented not to look at — and, worse, reporting it as Cursor content.
 *
 * **The home and the cwd come in rather than the two `.cursor` roots**, and the
 * reason is the vendor scan at the bottom: the third-party trees are
 * `~/.claude/skills` and `<workspace>/.claude/skills`, and their base is the
 * home and the workspace — **not** the config root. On a machine that set
 * `CURSOR_CONFIG_DIR`, the config root is somewhere else entirely, and
 * `join(configRoot, ".claude", "skills")` would be a directory that does not
 * exist on any machine. The bundle makes the same distinction: `loadSkillRoots`
 * takes `userHomeDirectory` and each workspace, never `WI()`.
 */
export function readCursorAssets(home: string, cwd: string): RawCursorAssets {
	// **`home`, not {@link cursorUserRoot}.** This is the one place in the asset
	// path where the two are different, and getting it wrong is the same failure
	// batch 1 fixed for the config files, one level down: silent emptiness.
	//
	// The source's asset loader takes a `userHomeDirectory`, and it defaults to
	// `homedir()` — module `../commands.ts` (chunk `4723.index.js`, build
	// `2026.09.26-dd393fe`):
	//
	// ```js
	// this.userHomeDirectory = t?.userHomeDirectory ?? homedir()
	// …
	// loadCommandsFromDirectory(join(this.userHomeDirectory, ".cursor", "commands"), "user")
	// ```
	//
	// and the same `userHomeDirectory` is what `c$0`, `x7$` and `Dct` are handed
	// for the skill roots. **`WI()` appears in none of them.** So on a machine
	// that exports `XDG_CONFIG_HOME` or `CURSOR_CONFIG_DIR`, the config files
	// move and the three asset directories do not: Cursor reads `~/.cursor/…`
	// for both, and a reader that used the config root for the assets would find
	// the config and nothing else. `migrate.ts` passes `options.home ?? homedir()`
	// here, which is the same value by construction.
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
			// Each tree is looked for only at the levels the source loads it at,
			// which is the reason `scopes` exists on the table. The case it was added
			// for: `computeAgentsDirs()` resolves everything off
			// `resolve(workspacePath)` and never mentions the home, so a
			// `~/.claude/agents` is not a tree Cursor reads — naming it would put a
			// sentence in the report telling the user Cursor harvests a directory it
			// does not touch, and the `claude-code` source imports that directory in
			// its own run regardless of what this source says about it.
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

/**
 * The CLI's per-workspace data tree, and the known files in it.
 *
 * Listed rather than addressed, for the reason the slug is not computed — see the
 * block comment in `cursor-home.ts`. `existsSync` is the only contact with any of
 * them: `mcp-auth.json` is a token store, and the other two are decision lists
 * this importer has no reading for in any case.
 *
 * The workspace is the directory name, reported as-is. It is a slug of the
 * workspace path (`r_()`), so it is already a name the reader cannot mistake for
 * something they typed.
 */
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
	/** The three reusable-text directories, and the vendor trees left to their owners. */
	assets: RawCursorAssets;
	/** Global MCP document, then the project's; both may be present. */
	mcp: RawCursorMcpDocument[];
	cli: { global: CursorDocument; project: CursorDocument };
	hooks: { global: CursorDocument; project: CursorDocument };
	stateDatabases: Array<{ path: string; kind: "workspace" | "global"; workspace?: string }>;
	/**
	 * The CLI's per-workspace data tree under its own data root.
	 *
	 * Kept apart from `stateDatabases` because the two answer different
	 * questions: those are the *editor's* SQLite files, this is the *CLI's*, and
	 * it hangs off `$CURSOR_DATA_DIR` rather than the editor's user-data
	 * directory. `root` is the tree itself and is `null` when there is none, which
	 * is the common case and still worth distinguishing from "there and empty".
	 */
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
	// `projects` joins the accounted list for a different reason than the three
	// above. The other three are imported or reported by name, so leaving them in
	// the leftovers list would print both halves of a contradiction. `projects` is
	// *never* imported, but `readCursorProjectData` gives it a line of its own that
	// says strictly more than the generic one — which files are in it, and that the
	// token store was not opened. Listing it here would print "reads nothing out
	// of projects" directly above the paragraph about the token in it, and the
	// first sentence is the one that reads as "there is nothing there".
	//
	// **At both roots, and only where it is the tree that reader walks.** The first
	// half of that is the fix: the list was extended for the user root and not for
	// the project one, so a home whose project directory is also its home printed
	// the contradiction anyway — and a test written to catch it looked at the user
	// list, which was clean, so it passed. The second half is why the entry is
	// computed rather than written: with `CURSOR_DATA_DIR` pointing elsewhere, a
	// `projects` under either root is an unrelated directory, and "this importer
	// reads nothing out of it" is exactly true of it.
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
			// The per-workspace data tree, on the same grounds again — and this is
			// the one case where the pillar is doing work the others cannot. Under
			// the default data root, `projects` is an entry of the user directory and
			// `otherUserFiles` would carry the install on its own. Once
			// `CURSOR_DATA_DIR` points somewhere else, the tree is the only thing
			// left of the CLI's own state on this machine, and without this
			// disjunct a user with nothing but MCP tokens behind it would be told
			// there is no Cursor here.
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
