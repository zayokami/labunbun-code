export const TOOLS_PACKAGE_VERSION = "0.1.0.3";

export { createInspectArtifactTool } from "./artifact.ts";
export {
	type BackgroundShell,
	BackgroundShellManager,
	type BackgroundShellManagerOptions,
	killPidTree,
	readTail,
	type ShellKillReason,
	type ShellStatus,
} from "./background.ts";
export {
	BASH_UPDATE_INTERVAL_MS,
	createBashOutputTool,
	createBashTool,
	createKillBashTool,
} from "./bash.ts";
export { createInspectBinaryTool } from "./binary.ts";
export { createCompareArtifactsTool } from "./compare-artifacts.ts";
export { caseInsensitivePaths } from "./containment.ts";
export { createDigestTool } from "./digest.ts";
export { createEditTool } from "./edit.ts";
export { createGlobTool, type FileWalkerOps, walkProjectFiles } from "./glob.ts";
export { createGrepTool } from "./grep.ts";
export { createInspectSqliteTool } from "./inspect-sqlite.ts";
export { createLsTool } from "./ls.ts";
export type {
	DirentInfo,
	ExecOperations,
	ExecResult,
	FileStat,
	FileSystemOperations,
	Operations,
	SpawnConfiner,
	SpawnSpec,
} from "./operations.ts";
export { ChildProcessExecOperations, defaultOperations, detectShell, NodeFileSystemOperations } from "./operations.ts";
export {
	createStreamCapture,
	createTailBuffer,
	nextSpillPath,
	type OverflowSink,
	type StreamCapture,
} from "./output-capture.ts";
export {
	describeFsFailure,
	errorCode,
	isMissingPathError,
	isPermissionError,
	type PathProbe,
	probePath,
} from "./path-errors.ts";
export { createReadTool } from "./read.ts";
export {
	ReadFileState,
	type ReadFileStateEntry,
	type RecordReadInput,
} from "./read-file-state.ts";
// The bridge process, reached two ways: a source checkout runs
// `sandbox/bridge-main.ts` beside the tools package, and a compiled binary
// re-enters the CLI's main with `__bridge` — see `bridgeRuntime` in
// `sandbox/bridge.ts` for what tells the two shapes apart.
export { runBridge } from "./sandbox/bridge.ts";
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
// The policy builder itself, for callers that exec a command outside the Bash
// tool — the "!" shell passthrough — and must run it under the same sandbox the
// tool would have built.
export { workspacePolicy } from "./sandbox/workspace-policy.ts";
export { createInspectSourceMapTool } from "./sourcemap.ts";
export { type AgentTask, createTaskTools, TASK_BOARD_TOOL_NAMES, type TaskStatus, TaskStore } from "./tasks.ts";
export {
	createWebFetchTool,
	createWebSearchTool,
	type HostResolver,
	htmlToText,
	parseDuckDuckGoResults,
	resolveHostWithDns,
	resolveWebBackends,
	type SearchResult,
	type WebFetchBackend,
	type WebFetchOptions,
	type WebSearchBackend,
	type WebSearchOptions,
} from "./web.ts";
export { createInspectWebCaptureTool } from "./web-capture.ts";
export { createWriteTool } from "./write.ts";

import type { AnyTool } from "@labunbun/agent";
import { createInspectArtifactTool } from "./artifact.ts";
import { BackgroundShellManager } from "./background.ts";
import { createBashOutputTool, createBashTool, createKillBashTool } from "./bash.ts";
import { createInspectBinaryTool } from "./binary.ts";
import { createCompareArtifactsTool } from "./compare-artifacts.ts";
import { createDigestTool } from "./digest.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createInspectSqliteTool } from "./inspect-sqlite.ts";
import { createLsTool } from "./ls.ts";
import { ChildProcessExecOperations, defaultOperations, detectShell, type Operations } from "./operations.ts";
import { createReadTool } from "./read.ts";
import { ReadFileState } from "./read-file-state.ts";
import { detectRuntime, type SandboxRuntime } from "./sandbox/index.ts";
import { createInspectSourceMapTool } from "./sourcemap.ts";
import { createTaskTools, type TaskStore } from "./tasks.ts";
import {
	createWebFetchTool,
	createWebSearchTool,
	resolveWebBackends,
	type WebFetchBackend,
	type WebSearchBackend,
} from "./web.ts";
import { createInspectWebCaptureTool } from "./web-capture.ts";
import { createWriteTool } from "./write.ts";

export interface CreateAllToolsOptions {
	operations?: Operations;
	taskStore?: TaskStore;
	backgroundShells?: BackgroundShellManager;
	webTools?: boolean;
	/** Which backend each web tool uses. Absent fields resolve from LBB_WEB_SEARCH / LBB_WEB_FETCH. */
	webBackends?: { search?: WebSearchBackend; fetch?: WebFetchBackend };
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
 * tools, with the standalone read-only probes (Digest, InspectSqlite,
 * InspectArtifact, InspectBinary, InspectSourceMap, CompareArtifacts, InspectWebCapture) last — a new tool is
 * appended, never inserted, so no existing tool's schema slot moves.
 */
export function createAllTools(cwd: string, options: CreateAllToolsOptions = {}): AnyTool[] {
	// The shell is resolved before the runtime, because the Windows probe runs
	// this shell; the runtime itself is built at most once and serves both
	// default spawners, so the sentence `/permissions` prints and the branch
	// each spawn path takes are answers to one question about this machine — and
	// a caller that brought both its own executor and its own manager needs no
	// probe at all.
	const shell = detectShell();
	let runtime: SandboxRuntime | undefined;
	const runtimeFor = (): SandboxRuntime => (runtime ??= detectRuntime(process.platform, shell));
	const ops = options.operations ?? defaultOperations(new ChildProcessExecOperations(runtimeFor(), shell));
	// The same executor, so a backgrounded command joins the proxy the foreground
	// one uses instead of opening a second listener that nothing would close.
	const background = options.backgroundShells ?? new BackgroundShellManager(runtimeFor(), ops);
	// One per tool set: `createAllTools` runs once at startup in both entry
	// points (`interactive.ts:595`, `headless.ts:278`), so a second tool set in
	// the same process is a second call and a second store. A module-level
	// singleton would be readable from any conversation — and a tool set that
	// outlives its conversation (`/resume` inherits the array) is why the app
	// passes its own and clears it (`interactive.ts:1497`) rather than leaning on
	// a per-call store to stay correct.
	const readState = options.readState ?? new ReadFileState();
	const coreTools: AnyTool[] = [
		createBashTool(cwd, ops, background, {
			home: options.home,
			tempDir: options.tempDir,
			writableRoots: options.writableRoots,
			spillDir: options.spillDir,
			shell,
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
	// Read once, at startup, after applySettingsEnv — the switches and the key
	// can come from settings.env. The factories take the answer as a parameter,
	// so a unit test that builds a tool directly never reads this process's env.
	const webBackends = resolveWebBackends(process.env, options.webBackends);
	const web =
		options.webTools === false
			? []
			: [createWebFetchTool({ backend: webBackends.fetch }), createWebSearchTool({ backend: webBackends.search })];
	return [
		...coreTools,
		...taskTools,
		...web,
		createDigestTool(cwd),
		createInspectSqliteTool(cwd),
		createInspectArtifactTool(cwd),
		createInspectBinaryTool(cwd),
		createInspectSourceMapTool(cwd),
		createCompareArtifactsTool(cwd),
		createInspectWebCaptureTool(cwd),
	];
}
