export const TOOLS_PACKAGE_VERSION = "0.1.0";

export { type BackgroundShell, BackgroundShellManager, type ShellStatus } from "./background.ts";
export { createBashOutputTool, createBashTool, createKillBashTool } from "./bash.ts";
export { createEditTool } from "./edit.ts";
export { createGlobTool } from "./glob.ts";
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
export { type AgentTask, createTaskTools, type TaskStatus, TaskStore } from "./tasks.ts";
export {
	createWebFetchTool,
	createWebSearchTool,
	htmlToText,
	parseDuckDuckGoResults,
	type SearchResult,
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
import { createTaskTools, type TaskStore } from "./tasks.ts";
import { createWebFetchTool, createWebSearchTool } from "./web.ts";
import { createWriteTool } from "./write.ts";

export interface CreateAllToolsOptions {
	operations?: Operations;
	taskStore?: TaskStore;
	backgroundShells?: BackgroundShellManager;
	webTools?: boolean;
}

/**
 * The default coding tool set. Order is frozen here so the wire-tool list
 * stays prompt-cache stable: core file/shell tools first, then task and web
 * tools.
 */
export function createAllTools(cwd: string, options: CreateAllToolsOptions = {}): AnyTool[] {
	const ops = options.operations ?? defaultOperations();
	const background = options.backgroundShells ?? new BackgroundShellManager();
	const coreTools: AnyTool[] = [
		createBashTool(cwd, ops, background),
		createEditTool(cwd, ops),
		createGlobTool(cwd, ops),
		createGrepTool(cwd, ops),
		createLsTool(cwd, ops),
		createReadTool(cwd, ops),
		createWriteTool(cwd, ops),
		createBashOutputTool(background),
		createKillBashTool(background),
	];
	const taskTools = options.taskStore ? createTaskTools(options.taskStore) : [];
	const web = options.webTools === false ? [] : [createWebFetchTool(), createWebSearchTool()];
	return [...coreTools, ...taskTools, ...web];
}
