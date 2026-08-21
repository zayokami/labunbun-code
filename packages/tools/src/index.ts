export const TOOLS_PACKAGE_VERSION = "0.1.0";

export { createBashTool } from "./bash.ts";
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
export { createWriteTool } from "./write.ts";

import type { AnyTool } from "@labunbun/agent";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { defaultOperations, type Operations } from "./operations.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export interface CreateAllToolsOptions {
	operations?: Operations;
}

/**
 * The default coding tool set: Bash, Edit, Glob, Grep, LS, Read, Write.
 * Order is frozen here so the wire-tool list stays prompt-cache stable.
 */
export function createAllTools(cwd: string, options: CreateAllToolsOptions = {}): AnyTool[] {
	const ops = options.operations ?? defaultOperations();
	return [
		createBashTool(cwd, ops),
		createEditTool(cwd, ops),
		createGlobTool(cwd, ops),
		createGrepTool(cwd, ops),
		createLsTool(cwd, ops),
		createReadTool(cwd, ops),
		createWriteTool(cwd, ops),
	];
}
