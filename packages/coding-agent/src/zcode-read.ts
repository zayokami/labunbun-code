/**
 * ZCode's user state: `config.json` in two places, a SQLite database the
 * settings reader owns, `AGENTS.md`, skills and plugins.
 *
 * `countPluginDirs` and `countRolloutLogs` are here rather than in the
 * harness region they were originally written beside: they count ZCode's
 * directories, and `readZcode` is the only thing that calls them. What is left
 * in this file is the layout adapter; the work is the generic readers'.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { countFilesWithExtension, readAgentFiles, readJson, readSkillDirs, readText } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import type { ZcodeSettingRow } from "./zcode-db.ts";
import { readZcodeSettings } from "./zcode-db.ts";

export interface RawZcode {
	/** ~/.zcode/v2/config.json — providers. */
	config: Record<string, unknown>;
	/** ~/.zcode/cli/config.json — CLI-side config, where `mcp.servers` lives. */
	cliConfig: Record<string, unknown>;
	/** ~/.zcode/cli/db/db.sqlite; absent when only the desktop app was installed. */
	dbPath: string;
	dbPresent: boolean;
	/** ~/.zcode/AGENTS.md */
	memory: string | null;
	skills: RawFile[];
	agents: RawFile[];
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
	const root = join(home, ".zcode");
	const cliRoot = join(root, "cli");
	const dbPath = join(cliRoot, "db", "db.sqlite");
	return {
		config: readJson(join(root, "v2", "config.json")),
		cliConfig: readJson(join(cliRoot, "config.json")),
		dbPath,
		dbPresent: existsSync(dbPath),
		memory: readText(join(root, "AGENTS.md")),
		skills: readSkillDirs(join(root, "skills")),
		agents: readAgentFiles(join(root, "agents")),
		pluginCount: countPluginDirs(cliRoot),
		rolloutCount: countRolloutLogs(cliRoot),
		settings: readZcodeSettings(dbPath),
		present: existsSync(root),
	};
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
