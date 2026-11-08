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
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
	/** Directory to create; must not exist yet. */
	dest: string;
	git?: WorkflowGit;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	try {
		await git(["worktree", "add", "--detach", options.dest, baseHead], repoRoot);
	} catch (error) {
		throw new Error(`Could not create a worktree at ${options.dest} (${messageOf(error)})`);
	}
	return { repoRoot, path: options.dest, baseHead };
}

/** Whether the agent left anything behind: tracked edits, untracked files, or a commit. */
export async function worktreeChanged(
	worktree: WorkflowWorktree,
	git: WorkflowGit = defaultWorkflowGit,
): Promise<boolean> {
	const status = (await git(["status", "--porcelain"], worktree.path)).trim();
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
