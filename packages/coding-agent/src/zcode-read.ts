/**
 * ZCode's user state: `config.json` in two places, a SQLite database the
 * settings reader owns, `AGENTS.md`, skills and plugins.
 *
 * Two roots, not one. The desktop half hangs off `$ZCODE_DATA_BASE_DIR/.zcode`;
 * the CLI half hangs off `$ZCODE_STORAGE_DIR` (or a `storage.dir` inside the CLI
 * config, which is itself the one file in this source that never moves) — see
 * {@link zcodeRoot} and {@link zcodeStorageDir} for why they are separate and
 * read differently. Both default to `~/.zcode`, so every existing fixture still
 * finds what it planted.
 *
 * `countPluginDirs` and `countRolloutLogs` are here rather than in the
 * harness region they were originally written beside: they count ZCode's
 * directories, and `readZcode` is the only thing that calls them. What is left
 * in this file is the layout adapter; the work is the generic readers'.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	countFilesWithExtension,
	readAgentFiles,
	readCommandFiles,
	readJson,
	readSkillDirs,
	readText,
} from "./migrate-core.ts";
import type { RawCommands, RawFile } from "./migrate-types.ts";
import type { ZcodeSettingRow } from "./zcode-db.ts";
import { readZcodeSettings } from "./zcode-db.ts";
import { zcodeBetaDir, zcodeCliConfigDir, zcodeCliDir, zcodeDbPath, zcodeRoot } from "./zcode-home.ts";

export interface RawZcode {
	/** The home directory the roots were resolved against, for rendering report paths. */
	home: string;
	/** `<data base>/.zcode` — the desktop half. */
	root: string;
	/** `<storage>/cli` — the plugin cache and the rollout logs, which a setting can move. */
	cliDir: string;
	/** The CLI config file, at the one path in this source no variable moves. */
	cliConfigPath: string;
	/** ~/.zcode/v2/config.json — providers. */
	config: Record<string, unknown>;
	/** The CLI config — where `mcp.servers` and the two `storage` paths live. */
	cliConfig: Record<string, unknown>;
	/**
	 * The session database, from `storage.sessionDbPath` rather than from
	 * `cliDir` — see {@link zcodeDbPath}. Absent when only the desktop app was
	 * installed, or when the CLI has not run yet.
	 */
	dbPath: string;
	dbPresent: boolean;
	/**
	 * The beta channel's CLI tree, when one was found beside the default.
	 *
	 * Named rather than read: ZCode picks that tree from the name of its own
	 * binary, which this process cannot see, so importing it would be a guess.
	 */
	betaCliDir: string | null;
	/** <root>/AGENTS.md */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
	/** <root>/commands — slash commands, which ZCode reads from here and from `~/.agents/commands`. */
	commands: RawCommands;
	/** Third-party plugin directories found under plugins/cache — reported, never read. */
	pluginCount: number;
	/** Raw model I/O logs under cli/rollout — counted, never opened (they embed live Authorization headers). */
	rolloutCount: number;
	/**
	 * `local_setting` rows (permission mode, permission ruleset, reasoning level).
	 * Read here rather than in the planner so planning stays free of I/O.
	 */
	settings: ZcodeSettingRow[];
	present: boolean;
}

export function readZcode(home: string): RawZcode {
	const root = zcodeRoot(home);
	// The config file is read from the one directory of this source that no
	// variable moves, and what it says about `storage` then decides where the rest
	// of the CLI half lives. Reading it the other way round — from the moved
	// directory — would find a file ZCode itself never opens.
	const cliConfigPath = join(zcodeCliConfigDir(home), "config.json");
	const cliConfig = readJson(cliConfigPath);
	// Three answers, not one: the plugin cache and the logs follow `storage.dir`,
	// while the database follows `storage.sessionDbPath` and can sit in a
	// different tree entirely. `zcodeDbPath` is why they are asked separately.
	const cliDir = zcodeCliDir(home, cliConfig);
	const dbPath = zcodeDbPath(home, cliConfig);
	return {
		home,
		root,
		cliDir,
		cliConfigPath,
		config: readJson(join(root, "v2", "config.json")),
		cliConfig,
		dbPath,
		dbPresent: existsSync(dbPath),
		betaCliDir: zcodeBetaCliDir(home),
		memory: readText(join(root, "AGENTS.md")),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		commands: readCommandFiles(join(root, "commands")),
		pluginCount: countPluginDirs(cliDir),
		rolloutCount: countRolloutLogs(cliDir),
		settings: readZcodeSettings(dbPath),
		present: existsSync(root),
	};
}

/**
 * The session database's path, for a caller that needs the path and nothing else.
 *
 * The history importer asked for it three times over and used to spell the path
 * out each time, which is how a `$ZCODE_STORAGE_DIR` user ends up with their
 * settings imported and their transcripts reported as none.
 */
export function zcodeDbPathFor(home: string): string {
	return zcodeDbPath(home, readJson(join(zcodeCliConfigDir(home), "config.json")));
}

/**
 * The beta channel's CLI tree beside the default one, or `null` when there is
 * none.
 *
 * The whole `cli/` directory rather than one file in it: what a beta install
 * keeps there is the database, the plugin cache and the logs, and there is no
 * single one of them that has to be present for the tree to be worth naming.
 */
function zcodeBetaCliDir(home: string): string | null {
	const cliDir = join(zcodeBetaDir(home), "cli");
	return existsSync(cliDir) ? cliDir : null;
}

/**
 * Count installed plugins (`<root>/plugins/cache/<marketplace>/<plugin>`) without
 * reading them. Plugin code is third-party content, not the user's own
 * configuration, so the report names the count and stops there.
 */
function countPluginDirs(root: string): number {
	let total = 0;
	try {
		const cache = join(root, "plugins", "cache");
		if (!existsSync(cache)) return 0;
		for (const marketplace of readdirSync(cache, { withFileTypes: true })) {
			if (!marketplace.isDirectory()) continue;
			total += readdirSync(join(cache, marketplace.name), { withFileTypes: true }).filter((entry) =>
				entry.isDirectory(),
			).length;
		}
	} catch {
		// unreadable plugin cache — nothing to report
	}
	return total;
}

/**
 * Count the raw model I/O logs (`<root>/rollout/*.jsonl`) without reading one.
 * Each line records a request and response, `Authorization` header included, so
 * the importer treats them as a source it may name and must not open.
 */
function countRolloutLogs(root: string): number {
	return countFilesWithExtension(join(root, "rollout"), ".jsonl");
}
