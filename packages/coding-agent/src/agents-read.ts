/**
 * The `agents` source: an instruction file, skills and agents under one
 * `~/.agents` tree.
 *
 * It is the smallest reader here, and that is the point of giving it a file. All
 * the work happens in the generic readers in `migrate-core.ts`; what lives here
 * is only what is about *this* layout. Before the split, a reader with two
 * declarations sat inside a thirteen-thousand-line file, and "where is the
 * agents reader" had two plausible answers.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAgentFiles, readCommandFiles, readSkillDirs, readText } from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";

/** The shared `~/.agents` home some tools read agent/skill definitions from. */
export interface RawAgents {
	/** ~/.agents/AGENTS.md */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/**
	 * ~/.agents/commands — the tree ZCode and the other tools that adopted it read
	 * for slash commands. It is imported here rather than by each of those tools,
	 * because it is one directory: a second source writing the same command would
	 * report a name collision the user never had.
	 */
	commands: RawCommands;
	present: boolean;
}

export function readAgents(home: string): RawAgents {
	const root = join(home, ".agents");
	return {
		memory: readText(join(root, "AGENTS.md")),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		commands: readCommandFiles(join(root, "commands")),
		present: existsSync(root),
	};
}
