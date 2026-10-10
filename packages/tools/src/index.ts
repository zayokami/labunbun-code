export const TOOLS_PACKAGE_VERSION = "0.1.0";

export { type BackgroundShell, BackgroundShellManager, readTail, type ShellStatus } from "./background.ts";
export {
	BASH_UPDATE_INTERVAL_MS,
	createBashOutputTool,
	createBashTool,
	createKillBashTool,
} from "./bash.ts";
export { caseInsensitivePaths } from "./containment.ts";
export { createEditTool } from "./edit.ts";
export { createGlobTool, type FileWalkerOps, walkProjectFiles } from "./glob.ts";
export { createGrepTool } from "./grep.ts";
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
export {
	createStreamCapture,
	createTailBuffer,
	nextSpillPath,
	type OverflowSink,
	type StreamCapture,
} from "./output-capture.ts";
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
export { type AgentTask, createTaskTools, TASK_BOARD_TOOL_NAMES, type TaskStatus, TaskStore } from "./tasks.ts";
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
	// Long-form design notes: docs/dev/tools.md
	/** Where tools that bound their own output write what did not fit. */
	spillDir?: string;
	// Long-form design notes: docs/dev/tools.md
	/** Where Read records what it showed, for the edit gate to read back. */
	readState?: ReadFileState;
	// Long-form design notes: docs/dev/tools.md
	/** What Bash passes to the policy builder as extra writable roots. */
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
	// One per tool set: `createAllTools` runs once at startup in both entry
	// points (`interactive.ts:325`, `headless.ts:147`), so a second tool set in
	// the same process is a second call and a second store. A module-level
	// singleton would be readable from any conversation — and a tool set that
	// outlives its conversation (`/resume` inherits the array) is why the app
	// passes its own and clears it (`interactive.ts:875`) rather than leaning on
	// a per-call store to stay correct.
	const readState = options.readState ?? new ReadFileState();
	const coreTools: AnyTool[] = [
		createBashTool(cwd, ops, background, {
			home: options.home,
			tempDir: options.tempDir,
			writableRoots: options.writableRoots,
			spillDir: options.spillDir,
		}),
		// Edit's first gate reads the same store Read writes: an edit is refused on
		// a file this session never read, so the two tools have to be looking at one
		// store or the gate refuses everything.
		createEditTool(cwd, ops, readState),
		createGlobTool(cwd, ops, { spillDir: options.spillDir }),
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
