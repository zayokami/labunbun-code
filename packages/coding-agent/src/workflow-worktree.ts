/**
 * Git worktree isolation for workflow agents that write files.
 *
 * Two agents editing the same checkout at once is a race with no winner, so a
 * script can ask for `isolation: "worktree"` and each call gets a detached
 * worktree at the current HEAD. Cleanup is deliberately conservative:
 *
 * - An unchanged worktree (no tracked edits, no new commit) is removed.
 * - A changed one is kept, and its path is reported. Deleting an agent's work
 *   because cleanup was tidy is the one mistake that cannot be undone.
 * - Any git failure keeps the directory too: fail closed, never silently
 *   discard.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How many numbered alternatives to try before giving up on a taken path. */
const MAX_WORKTREE_NAME_ATTEMPTS = 100;

/** Run git and return stdout; reject on a nonzero exit. */
export type WorkflowGit = (args: string[], cwd: string) => Promise<string>;

export const defaultWorkflowGit: WorkflowGit = async (args, cwd) => {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout;
};

export interface WorkflowWorktree {
	/** The main checkout, from which `git worktree remove` must be run. */
	repoRoot: string;
	path: string;
	baseHead: string;
}

export interface CreateWorktreeOptions {
	cwd: string;
	/**
	 * Preferred directory to create. When it is already taken — a kept worktree
	 * from an earlier run, or a registration git still holds — the next free
	 * `<dest>-2`, `<dest>-3`, … is used instead.
	 */
	dest: string;
	git?: WorkflowGit;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Whether `git worktree add` refused because the slot is taken rather than
 * because the command is broken.
 *
 * git has no machine-readable code here, so the three refusals a taken slot
 * produces are matched by sentence. A localized git would fall through to the
 * plain error, which is the same outcome as before this loop existed.
 */
function slotTaken(error: unknown): boolean {
	return /already exists|already registered|already checked out/i.test(messageOf(error));
}

/** Add a detached worktree of `cwd`'s repository at HEAD. */
export async function createWorkflowWorktree(options: CreateWorktreeOptions): Promise<WorkflowWorktree> {
	const git = options.git ?? defaultWorkflowGit;
	let repoRoot: string;
	try {
		repoRoot = (await git(["rev-parse", "--show-toplevel"], options.cwd)).trim();
	} catch (error) {
		throw new Error(`isolation: "worktree" needs a git repository (${messageOf(error)})`);
	}
	if (repoRoot === "") throw new Error('isolation: "worktree" needs a git repository with a HEAD commit');
	let baseHead: string;
	try {
		baseHead = (await git(["rev-parse", "HEAD"], repoRoot)).trim();
	} catch (error) {
		throw new Error(`isolation: "worktree" needs a HEAD commit (${messageOf(error)})`);
	}
	await mkdir(dirname(options.dest), { recursive: true });
	let dest = options.dest;
	for (let attempt = 1; ; attempt++) {
		if (!existsSync(dest)) {
			try {
				await git(["worktree", "add", "--detach", dest, baseHead], repoRoot);
				return { repoRoot, path: dest, baseHead };
			} catch (error) {
				if (!slotTaken(error)) throw new Error(`Could not create a worktree at ${dest} (${messageOf(error)})`);
			}
		}
		// A kept worktree from a resumed run owns the preferred name. The name is a
		// slot, not the record — the journal entry names the directory — so the
		// next free suffix is the answer, and nothing is ever deleted to make room.
		if (attempt >= MAX_WORKTREE_NAME_ATTEMPTS) {
			throw new Error(
				`Could not create a worktree near ${options.dest}: ${MAX_WORKTREE_NAME_ATTEMPTS} names are taken`,
			);
		}
		dest = `${options.dest}-${attempt + 1}`;
	}
}

/** Whether the agent left anything behind: tracked edits, untracked files, ignored files, or a commit. */
export async function worktreeChanged(
	worktree: WorkflowWorktree,
	git: WorkflowGit = defaultWorkflowGit,
): Promise<boolean> {
	// Ignored files count as work too. An agent asked to produce a build output,
	// a log or a local config writes exactly those, and a plain status call would
	// call the worktree untouched and delete the files. `traditional` mode
	// collapses an ignored directory to one line, so a dependency install costs a
	// line rather than a directory walk. A git too old for the flag falls back to
	// the plain check rather than keeping every worktree forever.
	//
	// `--untracked-files=normal` is passed even though it is the default: the
	// default is the *config* `status.showUntrackedFiles`, and a user who set it
	// to `no` would otherwise hide exactly the new files an agent writes — the
	// worktree would read as unchanged and be removed.
	let status: string;
	try {
		status = (
			await git(["status", "--porcelain", "--untracked-files=normal", "--ignored=traditional"], worktree.path)
		).trim();
	} catch {
		status = (await git(["status", "--porcelain", "--untracked-files=normal"], worktree.path)).trim();
	}
	if (status !== "") return true;
	const head = (await git(["rev-parse", "HEAD"], worktree.path)).trim();
	return head !== worktree.baseHead;
}

/**
 * Remove an unchanged worktree. Returns whether it was removed; `false` means
 * it was kept, either because it changed or because git would not remove it.
 */
export async function removeWorkflowWorktreeIfUnchanged(
	worktree: WorkflowWorktree,
	git: WorkflowGit = defaultWorkflowGit,
): Promise<boolean> {
	let changed: boolean;
	try {
		changed = await worktreeChanged(worktree, git);
	} catch {
		return false;
	}
	if (changed) return false;
	try {
		await git(["worktree", "remove", "--force", worktree.path], worktree.repoRoot);
		return true;
	} catch {
		return false;
	}
}
