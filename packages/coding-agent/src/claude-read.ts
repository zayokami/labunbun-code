/**
 * Claude Code's user state: `settings.json`, the state kept beside it, skills,
 * commands, rules and agents.
 *
 * The plugin servers in `~/.claude.json` and the auto-memory under `projects/`
 * are read through the shared readers, so what is left is the part of the layout
 * that is specifically Claude Code's.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	readAgentFiles,
	readCommandFiles,
	readJson,
	readMarkdownDir,
	readSkillDirs,
	readText,
} from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";

export interface RawClaudeCode {
	/** ~/.claude/settings.json */
	settings: Record<string, unknown>;
	/** ~/.claude.json — mostly runtime state; only a few keys are migratable. */
	state: Record<string, unknown>;
	/**
	 * `~/.claude/CLAUDE.md` — the user's own global instructions, read by Claude
	 * Code on every project (`utils/claudemd.ts`, the "user memory" entry).
	 */
	memory: string | null;
	skills: RawFile[];
	rules: RawFile[];
	agents: RawFile[];
	/** ~/.claude/commands/**\/*.md — slash commands, imported as skills. */
	commands: RawCommands;
	present: boolean;
}

export function readClaudeCode(home: string): RawClaudeCode {
	const root = join(home, ".claude");
	return {
		settings: readJson(join(root, "settings.json")),
		state: readJson(join(home, ".claude.json")),
		memory: readText(join(root, "CLAUDE.md")),
		skills: readSkillDirs(join(root, "skills")),
		rules: readMarkdownDir(join(root, "rules")),
		agents: readAgentFiles(join(root, "agents")),
		commands: readCommandFiles(join(root, "commands")),
		present: existsSync(root),
	};
}
