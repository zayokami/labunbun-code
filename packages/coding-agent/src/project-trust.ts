/**
 * One-time trust for the definitions a repository ships.
 *
 * A project's `.labunbun/agents` markdown files and `.labunbun/skills` folders are read
 * into a session as if the user had written them: an agent definition becomes the
 * system prompt of every subagent spawned from it, and a skill becomes a slash
 * command whose expansion is sent to the model. Cloning a repository and opening
 * it was therefore enough to change what the model is told to be, with no user
 * action and nothing on screen to point at. The same move wears two more names:
 * a `LABUNBUN.md`/`AGENTS.md` the walk picks up (`memory.ts`) goes into the
 * system prompt as standing instructions, and `.labunbun/output-styles` files
 * (`output-styles.ts`) replace the `# Output style` section once the user's own
 * settings name one. All four kinds load only after this directory has been
 * trusted once, each recorded separately, so a kind added later is not trusted
 * by a decision taken before it existed.
 *
 * Project-tier definitions now load only after this directory has been trusted
 * once, and the decision is remembered outside the working tree —
 * `~/.labunbun/projects/<slug>/trusted-definitions.json`, keyed with
 * `sanitizeCwd` exactly as SessionStore keys its sessions — for the reason MCP
 * approvals live there too: a ledger inside the repository is a file its author
 * can ship pre-approved. The user tier (`~/.labunbun/agents`,
 * `~/.labunbun/skills`) is not gated: it is the user's own, and it is where a
 * definition belongs when it should apply everywhere.
 *
 * What is remembered is the project, not the bytes of what was approved. A skill
 * edited after approval is trusted without being re-read — the same bound
 * `.mcp.json` has, and the reason `/agents` lists what is about to be loaded
 * rather than asking the user to approve a hash they cannot read.
 *
 * A refusal is not recorded anywhere. Declining is simply not calling
 * `approveProjectDefinitions`, so the definitions stay withheld and the notice
 * comes back on the next start — the question is asked again rather than the
 * answer being remembered, which is the same shape the MCP gate has.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";

/** The project tiers one trust decision covers, named as their directories are. */
export type DefinitionKind = "agents" | "skills" | "memory" | "styles";

/** Fixed order, so repeated approvals write the same bytes. */
const KINDS: DefinitionKind[] = ["agents", "skills", "memory", "styles"];

function trustStorePath(cwd: string, home: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd), "trusted-definitions.json");
}

/**
 * The kinds this directory has been trusted for; empty when the ledger is
 * missing, unreadable, or says something this build does not load.
 *
 * Fail-closed, and entry by entry: a hand-edited file naming a tier that does
 * not exist grants nothing for that entry instead of throwing where a session is
 * starting up, and an unparseable one grants nothing at all.
 */
export function loadTrustedDefinitionKinds(cwd: string, home: string = homedir()): Set<DefinitionKind> {
	try {
		const path = trustStorePath(cwd, home);
		if (!existsSync(path)) return new Set();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { trustedDefinitionKinds?: unknown };
		const list = Array.isArray(parsed?.trustedDefinitionKinds) ? parsed.trustedDefinitionKinds : [];
		return new Set(list.filter((kind): kind is DefinitionKind => KINDS.includes(kind as DefinitionKind)));
	} catch {
		return new Set();
	}
}

/**
 * "2 agent definitions, 1 skill" — the withheld counts, phrased in one place.
 *
 * Three lines print these numbers (the REPL's startup notice, its confirmation
 * after an approval, and a `-p` run's stderr) and the pluralisation is the part
 * that drifts quietly between them.
 *
 * The memory and output-style counts are real tiers now but print only when
 * non-zero: the agents/skills zeros are pinned (`project-trust.test.ts`), while
 * a session with no memory files or styles in front of it should not read a
 * clause about them at all — and their confirmation says "restart", which an
 * absent tier has no business doing.
 */
export function describeWithheld(kinds: { agents: number; skills: number; memory?: number; styles?: number }): string {
	const counts = `${kinds.agents} agent definition${kinds.agents === 1 ? "" : "s"}, ${kinds.skills} skill${kinds.skills === 1 ? "" : "s"}`;
	const memory = kinds.memory;
	const styles = kinds.styles;
	const parts = [counts];
	if (memory !== undefined && memory !== 0) parts.push(`${memory} memory file${memory === 1 ? "" : "s"}`);
	if (styles !== undefined && styles !== 0) parts.push(`${styles} output style${styles === 1 ? "" : "s"}`);
	return parts.join(", ");
}

/**
 * The line that says a project tier is being held back, phrased for where it is
 * read.
 *
 * The counts were shared from the start; the sentence around them was written
 * twice instead, and the sentence is the half that tells the user what to do —
 * a `/agents` that had drifted to some other name would be read at the one
 * moment the feature it is about is invisible, and nothing looked at it. Exported
 * so `help-commands.test.ts` holds these two lines to the same rule as every
 * other line of advice this app prints: the commands they name have to exist.
 *
 * `subdirectoryOfGitRoot` is `enclosingRepositoryRoot`'s answer for the working
 * directory, and when it is set the notice gains the scope sentence below.
 */
export function withheldDefinitionNotice(
	kinds: { agents: number; skills: number; memory?: number; styles?: number },
	audience: "repl" | "headless",
	subdirectoryOfGitRoot?: string,
): string {
	const counts = describeWithheld(kinds);
	const base =
		audience === "repl"
			? `This project's definitions are not loaded — ${counts}. /agents to review.`
			: `Warning: this project's definitions are not loaded — ${counts}. Approve them in an interactive session (/agents approve).`;
	if (subdirectoryOfGitRoot === undefined) return base;
	// Codex's git-root note (`trust_directory.rs:144-152`), said truthfully for
	// this app: Codex's trust applies to the repository root, ours to exactly this
	// directory — the ledger is keyed by the cwd (`trustStorePath`) — so the
	// sentence states our scope rather than copying Codex's claim, which here
	// would be false. Same note for both audiences: scope is not a property of
	// where the line is read.
	return `${base}\nNote: you're in a subdirectory of a Git project — approval covers this directory, not the repository root at ${subdirectoryOfGitRoot}.`;
}

/**
 * The root of the repository that encloses `cwd`, or undefined when none does.
 *
 * The walk starts at the parent, so a `cwd` that is itself a repository root
 * reports nothing — "in a subdirectory of a Git project" is the one question
 * this exists for, and a session started at the root is not in one. Nested
 * repositories resolve to the nearest root the way `git` resolves them.
 *
 * Presence of `.git` is the whole test: a directory in a normal clone, a file
 * in a worktree or submodule, so each level costs one `existsSync` and nothing
 * shells out to `git`. The returned path is built from `cwd`'s own spelling
 * with `dirname`/`join`, never `realpath` — a caller compares it against
 * nothing (the parameter carries the answer), which is what keeps the
 * `/var`-vs-`/private/var` class of spelling traps out of this.
 */
export function enclosingRepositoryRoot(cwd: string): string | undefined {
	const start = resolve(cwd);
	if (existsSync(join(start, ".git"))) return undefined;
	let dir = dirname(start);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Whether this directory's tier of `kind` may be loaded. */
export function isProjectTierTrusted(cwd: string, kind: DefinitionKind, home: string = homedir()): boolean {
	return loadTrustedDefinitionKinds(cwd, home).has(kind);
}

/**
 * Write the ledger by replacement: the bytes land in a sibling file and are
 * renamed over the target, so a process that dies mid-write leaves the previous
 * complete ledger rather than a truncated one.
 *
 * The ledger is read back as the whole record of what this project may load, so
 * a torn write does not cost one decision — it drops every tier at once, and
 * the user is asked to approve again with nothing on screen explaining why.
 * Throws when the write fails, leaving the caller to decide whether a decision
 * it could not record is worth failing over; the temp file does not survive the
 * failure either way.
 */
// Long-form design notes: docs/dev/crash-consistency.md
function writeLedgerAtomic(path: string, data: Record<string, unknown>): void {
	const tmp = `${path}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// No temp file to remove (the write failed before it existed).
		}
		throw error;
	}
}

/** Persist a trust decision, creating the file and its directory as needed. */
export function approveProjectDefinitions(cwd: string, kinds: DefinitionKind[], home: string = homedir()): void {
	const path = trustStorePath(cwd, home);
	let existing: Record<string, unknown> = {};
	let parseFailure: unknown;
	try {
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			// Anything that is not an object would be replaced rather than extended;
			// this file is only ever written here, and a hand-edited one still starts
			// from whatever else it holds.
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
		}
	} catch (error) {
		parseFailure = error;
	}
	if (parseFailure !== undefined) {
		// Read-modify-write over an unreadable file: continuing with `{}` would
		// rewrite the store holding only the new kinds. The corrupt file moves
		// aside (best effort) and the warning names where it went — the earlier
		// trust is then visibly re-asked rather than invisibly discarded.
		const backup = `${path}.corrupt-${Date.now()}`;
		let moved: string | null = null;
		try {
			renameSync(path, backup);
			moved = backup;
		} catch {}
		console.error(
			`Warning: ${path} could not be read (${parseFailure instanceof Error ? parseFailure.message : String(parseFailure)}); ` +
				(moved ? `moved to ${moved}.` : "could not be moved aside.") +
				" Earlier approvals are not in effect until re-approved.",
		);
	}
	const trusted = loadTrustedDefinitionKinds(cwd, home);
	for (const kind of kinds) trusted.add(kind);
	existing.trustedDefinitionKinds = KINDS.filter((kind) => trusted.has(kind));
	mkdirSync(dirname(path), { recursive: true });
	writeLedgerAtomic(path, existing);
}
