export const TOOLS_PACKAGE_VERSION = "0.1.0";

export { type BackgroundShell, BackgroundShellManager, readTail, type ShellStatus } from "./background.ts";
export {
	BASH_UPDATE_INTERVAL_MS,
	createBashOutputTool,
	createBashTool,
	createKillBashTool,
	createTailBuffer,
} from "./bash.ts";
export { caseInsensitivePaths } from "./containment.ts";
export { createEditTool } from "./edit.ts";
export { createGlobTool, type FileWalkerOps, walkProjectFiles } from "./glob.ts";
export { createGrepTool, globToRegExp } from "./grep.ts";
export { createLsTool } from "./ls.ts";
export type {
	DirentInfo,
	ExecOperations,
	ExecResult,
	FileStat,
	FileSystemOperations,
	Operations,
} from "./operations.ts";
export { ChildProcessExecOperations, defaultOperations, detectShell, NodeFileSystemOperations } from "./operations.ts";
export { createReadTool } from "./read.ts";
export {
	ReadFileState,
	type ReadFileStateEntry,
	type RecordReadInput,
} from "./read-file-state.ts";
export {
	describeWritableRoots,
	resolveWritableRoots,
	type WritableRootOptions,
} from "./sandbox/default-writable-roots.ts";
export {
	describeSandboxBackend,
	detectNativeBackend,
	detectRuntime,
	networkConfinement,
	policyFor,
	type SandboxBackend,
	sandboxBackendFor,
} from "./sandbox/index.ts";
export { type AgentTask, createTaskTools, type TaskStatus, TaskStore } from "./tasks.ts";
export {
	createWebFetchTool,
	createWebSearchTool,
	type HostResolver,
	htmlToText,
	parseDuckDuckGoResults,
	resolveHostWithDns,
	type SearchResult,
	type WebFetchOptions,
} from "./web.ts";
export { createWriteTool } from "./write.ts";

import type { AnyTool } from "@labunbun/agent";
import { BackgroundShellManager } from "./background.ts";
import { createBashOutputTool, createBashTool, createKillBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { defaultOperations, type Operations } from "./operations.ts";
import { createReadTool } from "./read.ts";
import { ReadFileState } from "./read-file-state.ts";
import { detectRuntime } from "./sandbox/index.ts";
import { createTaskTools, type TaskStore } from "./tasks.ts";
import { createWebFetchTool, createWebSearchTool } from "./web.ts";
import { createWriteTool } from "./write.ts";

export interface CreateAllToolsOptions {
	operations?: Operations;
	taskStore?: TaskStore;
	backgroundShells?: BackgroundShellManager;
	webTools?: boolean;
	/** Directories outside the workspace Read may still open (the spill dir). */
	readOnlyRoots?: string[];
	/**
	 * Where Read records what it showed, for the edit gate to read back.
	 *
	 * Left out, one is made here and used for nothing else, so a caller who
	 * forgets to pass the same instance to the Edit tool gets a gate that always
	 * refuses — the safe direction to fail in, and one a test finds.
	 */
	readState?: ReadFileState;
	/**
	 * What Bash passes to the policy builder as extra writable roots.
	 *
	 * `home` and `tempDir` are **parameters rather than reads of the process**, so
	 * a caller can point the whole set at a fixture. `os.homedir()` reads only the
	 * Win32 environment block, so on linux and macOS a reader that calls it reads
	 * the developer's real home — the defect `source-env-coverage` exists to catch.
	 */
	home?: string;
	tempDir?: string;
	/** Extra roots the session configuration asked for, on top of the defaults. */
	writableRoots?: readonly string[];
}

/**
 * The default coding tool set. Order is frozen here so the wire-tool list
 * stays prompt-cache stable: core file/shell tools first, then task and web
 * tools.
 */
export function createAllTools(cwd: string, options: CreateAllToolsOptions = {}): AnyTool[] {
	const ops = options.operations ?? defaultOperations();
	// The same executor, so a backgrounded command joins the proxy the foreground
	// one uses instead of opening a second listener that nothing would close.
	const background = options.backgroundShells ?? new BackgroundShellManager(detectRuntime(), ops);
	// One per tool set, which is one per session: `createAllTools` runs once at
	// startup in both entry points (`interactive.ts:315`, `headless.ts:147`), so a
	// second conversation in the same process is a second call and a second store.
	// A module-level singleton would be readable from any conversation, which is
	// the leak this constructor exists to prevent.
	const readState = options.readState ?? new ReadFileState();
	const coreTools: AnyTool[] = [
		createBashTool(cwd, ops, background, {
			home: options.home,
			tempDir: options.tempDir,
			writableRoots: options.writableRoots,
		}),
		// Edit's first gate reads the same store Read writes: an edit is refused on
		// a file this session never read, so the two tools have to be looking at one
		// store or the gate refuses everything.
		createEditTool(cwd, ops, readState),
		createGlobTool(cwd, ops),
		createGrepTool(cwd, ops),
		createLsTool(cwd, ops),
		createReadTool(cwd, ops, options.readOnlyRoots ?? [], readState),
		// Write takes the same list, and not because it may write there: a root
		// the policy calls readable-only is exactly the root `decideWrite` has to
		// refuse, and a policy that only Read knows about is a policy the shell
		// and the write tools disagree with.
		createWriteTool(cwd, ops, options.readOnlyRoots ?? [], readState),
		createBashOutputTool(background),
		createKillBashTool(background),
	];
	const taskTools = options.taskStore ? createTaskTools(options.taskStore) : [];
	const web = options.webTools === false ? [] : [createWebFetchTool(), createWebSearchTool()];
	return [...coreTools, ...taskTools, ...web];
}
