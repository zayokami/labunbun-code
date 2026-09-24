/**
 * Codex's user state: `config.toml`, instructions, skills, prompts, agents,
 * rules, and sessions.
 *
 * Two things here are worth knowing before reading the code. Instructions are
 * `AGENTS.override.md` when both spellings are present, and only then
 * `AGENTS.md` — the other one is named in the report so the user can see which
 * file was left behind. And a session log is `.jsonl.zst`, decompressed whole;
 * that is the one expensive read in the migration, which is why transcripts are
 * read before planning and never inside it.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codexRoot } from "./codex-home.ts";
import { countFilesWithExtension, readAgentFiles, readCommandFiles, readSkillDirs, readText } from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";

/** One `*.rules` execpolicy file, as text. */
export interface RawRuleFile {
	/** File name under `rules/`, e.g. `default.rules`. */
	name: string;
	content: string;
}

export interface RawCodex {
	/** The resolved Codex home (`$CODEX_HOME`, else `~/.codex`). */
	root: string;
	/** Parsed <codex home>/config.toml */
	config: Record<string, unknown>;
	/** The instruction document Codex reads: `AGENTS.override.md`, else `AGENTS.md`. */
	memory: string | null;
	/** Which of the two names supplied {@link memory}; null when neither holds anything. */
	memoryFile: string | null;
	/**
	 * The other name, when it holds a document of its own. Codex reads one of the
	 * two and this is the one it does not — a file the user may believe is in force.
	 */
	memoryShadowed: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/**
	 * ~/.codex/prompts/*.md — custom prompts. Absent from the Codex versions
	 * this importer was written against (it turns foreign commands into skills
	 * instead), so this is normally empty and read only if the directory appears.
	 */
	prompts: RawCommands;
	/** ~/.codex/rules/*.rules — the user's own execpolicy decisions. */
	execpolicy: RawRuleFile[];
	/** ~/.codex/hooks.json — reported by name, never opened. */
	hooksPresent: boolean;
	/** Definition files under ~/.codex/agents that are not markdown — counted, never parsed. */
	agentTomlCount: number;
	/** Profile names under `<codex home>/*.config.toml` — named, never merged. */
	profileArchives: string[];
	present: boolean;
}

export function readCodex(home: string): RawCodex {
	const root = codexRoot(home);
	const configText = readText(join(root, "config.toml"));
	let config: Record<string, unknown> = {};
	if (configText !== null) {
		try {
			const parsed = Bun.TOML.parse(configText);
			if (typeof parsed === "object" && parsed !== null) config = parsed as Record<string, unknown>;
		} catch {
			// unparseable TOML migrates nothing from this source
		}
	}
	return {
		root,
		config,
		...readCodexInstructions(root),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		prompts: readCommandFiles(join(root, "prompts")),
		execpolicy: readRuleFiles(join(root, "rules")),
		hooksPresent: existsSync(join(root, "hooks.json")),
		agentTomlCount: countFilesWithExtension(join(root, "agents"), ".toml"),
		profileArchives: readCodexProfileArchives(root),
		present: existsSync(root),
	};
}

/**
 * The global instruction document, and which of the two names supplied it.
 *
 * `AGENTS.override.md` wins over `AGENTS.md` when both are there
 * (`codex-home/src/instructions/mod.rs:47-79`, and the core copy of the same
 * rule), and the loser is not read at all — this is a preference, not a merge,
 * unlike the six names grok joins. Reading `AGENTS.md` unconditionally, as this
 * reader used to, imports the file the user left behind when they wrote the
 * override: a document Codex does not read, presented as the user's memory.
 *
 * "Wins" is decided the way Codex decides it: the first name that exists as a
 * file *and* holds something other than whitespace. A present-but-empty
 * override falls through to `AGENTS.md` in Codex, so it does here too.
 */
function readCodexInstructions(root: string): Pick<RawCodex, "memory" | "memoryFile" | "memoryShadowed"> {
	const documents: Array<[name: string, text: string | null]> = [
		["AGENTS.override.md", readText(join(root, "AGENTS.override.md"))],
		["AGENTS.md", readText(join(root, "AGENTS.md"))],
	];
	const decided = documents.find(([, text]) => text !== null && text.trim() !== "");
	if (decided === undefined) return { memory: null, memoryFile: null, memoryShadowed: null };
	// The other name is recorded only when it holds something: an empty file next
	// to the one in force is not a document the user is losing.
	const shadowed = documents.find(([name, text]) => name !== decided[0] && text !== null && text.trim() !== "");
	return { memory: decided[1], memoryFile: decided[0], memoryShadowed: shadowed === undefined ? null : shadowed[0] };
}

/**
 * `<CODEX_HOME>/<name>.config.toml` — the profile files `--profile <name>` loads.
 *
 * Named rather than read: each one is a whole second `config.toml` whose keys
 * override the base file, and merging two configs into one report is a decision
 * the user has to make with the profile name in hand — the base file here is
 * imported as the configuration, and a profile's overrides are not in force
 * unless Codex was started with that switch.
 */
function readCodexProfileArchives(root: string): string[] {
	try {
		return readdirSync(root)
			.filter((name) => name.endsWith(".config.toml"))
			.map((name) => name.slice(0, -".config.toml".length))
			.filter((name) => name !== "")
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/**
 * `~/.codex/rules/*.rules` — the execpolicy files, read as text.
 *
 * These hold decisions the user made by hand about what may run (`prefix_rule`)
 * and are the closest thing Codex has to this build's permission rules, so they
 * are worth reading. Parsing them is left to the planner: a `.rules` file is
 * Starlark, and the planner is where the "cannot express this" decisions belong.
 */
function readRuleFiles(dir: string): RawRuleFile[] {
	const out: RawRuleFile[] = [];
	try {
		if (!existsSync(dir)) return out;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".rules")) continue;
			const content = readText(join(dir, entry.name));
			if (content !== null) out.push({ name: entry.name, content });
		}
	} catch {
		// unreadable rules directory — contributes nothing
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
