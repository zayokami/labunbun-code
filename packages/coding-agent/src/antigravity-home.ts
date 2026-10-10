// Antigravity's user state: the `~/.gemini` tree, the two data roots under it,
// and every path `antigravity-read.ts` looks at.
// Long-form design notes: docs/dev/migration-sources.md

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The directory every Antigravity path in this module sits under. */
export const ANTIGRAVITY_GEMINI_DIR = ".gemini";

// Long-form design notes: docs/dev/migration-sources.md
/** The data root the separately-installed IDE reads: `~/.gemini/antigravity-ide`. */
export const ANTIGRAVITY_IDE_DATA_DIR = "antigravity-ide";

// Long-form design notes: docs/dev/migration-sources.md
/** The pre-split data root: `~/.gemini/antigravity`. */
export const ANTIGRAVITY_OLD_DATA_DIR = "antigravity";

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini/antigravity-backup` is deliberately not a root. See {@link antigravityDataDirs}. */
export const ANTIGRAVITY_BACKUP_DATA_DIR = "antigravity-backup";

// Long-form design notes: docs/dev/migration-sources.md
/** Paths under the customization root that this source names and never opens. */
export const ANTIGRAVITY_NAMED_ONLY: Record<string, string> = {
	"~/.gemini/config/hooks.json":
		"Antigravity's own hook document; its events and payloads are not this build's hook schema, and nothing was translated",
	"~/.gemini/config/workflows.json":
		"a manifest of which workflows exist, which the workflow files beside it already say",
	"~/.gemini/config/plugins":
		"plugin bundles (plugin.json, mcp_config.json, hooks.json, rules/, skills/, agents/) — named, not read",
	"~/.gemini/config/sidecars":
		"sidecar processes the user wrote; each is a separate app with its own frontend and data directory",
	"~/.gemini/antigravity-cli/settings.json":
		"the settings of the antigravity CLI, a different product in a tree this source has no reader for",
};

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini` is the parent of every Antigravity data directory. */
export function antigravityGeminiRoot(home: string): string {
	return join(home, ANTIGRAVITY_GEMINI_DIR);
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini/config` is the customization root, and the one directory under `.gemini` that is not inside a data root. */
export function antigravityConfigDir(home: string): string {
	return join(antigravityGeminiRoot(home), "config");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini/config/config.json` is the user settings document, JSON despite the `config` in its name. */
export function antigravityConfigPath(home: string): string {
	return join(antigravityConfigDir(home), "config.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** The data roots to read, most authoritative first. */
export function antigravityDataDirs(home: string): string[] {
	const root = antigravityGeminiRoot(home);
	return [join(root, ANTIGRAVITY_IDE_DATA_DIR), join(root, ANTIGRAVITY_OLD_DATA_DIR)];
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<data root>/mcp_config.json` is an MCP document beside a data root, and it is inferred rather than documented. */
export function antigravityMcpConfigPath(dir: string): string {
	return join(dir, "mcp_config.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini/config/mcp_config.json` is the global MCP document, and it is verified. */
export function antigravityGlobalMcpConfigPath(home: string): string {
	return join(antigravityConfigDir(home), "mcp_config.json");
}

// Long-form design notes: docs/dev/migration-sources.md
/** Every MCP document to consult, most authoritative first. */
export function antigravityMcpConfigPaths(home: string, dataDir: string | null): string[] {
	const paths = [antigravityGlobalMcpConfigPath(home)];
	if (dataDir !== null) paths.push(antigravityMcpConfigPath(dataDir));
	return paths;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<data root>/brain` holds every conversation, one directory each. */
export function antigravityConversationsDir(dir: string): string {
	return join(dir, "brain");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `<data root>/brain/<id>/.system_generated/logs` holds the two transcripts, compact first. */
export function antigravityTranscriptPaths(conversationDir: string): string[] {
	const logs = join(conversationDir, ".system_generated", "logs");
	return [join(logs, "transcript.jsonl"), join(logs, "transcript_full.jsonl")];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Every standing-instructions document, in the order they should be read. */
export function antigravityMemoryPaths(home: string): string[] {
	const root = antigravityGeminiRoot(home);
	const config = antigravityConfigDir(home);
	return [join(root, "GEMINI.md"), join(config, "GEMINI.md"), join(config, "AGENTS.md"), join(config, "memory.txt")];
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini/GEMINI.md` is the first entry of {@link antigravityMemoryPaths}. */
export function antigravityMemoryPath(home: string): string {
	return antigravityMemoryPaths(home)[0];
}

/** `~/.gemini/config/skills` — the global skills tree, one directory per skill. */
export function antigravitySkillsDir(home: string): string {
	return join(antigravityConfigDir(home), "skills");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini/config/workflows` is the legacy global workflows tree, deprecated by the product itself. */
export function antigravityWorkflowsDir(home: string): string {
	return join(antigravityConfigDir(home), "workflows");
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.gemini/config/global_workflows` is the other legacy workflows tree, deprecated for the same reason as {@link antigravityWorkflowsDir}. */
export function antigravityGlobalWorkflowsDir(home: string): string {
	return join(antigravityConfigDir(home), "global_workflows");
}

// Long-form design notes: docs/dev/migration-sources.md
/** Whether a directory exists and holds something. */
export function antigravityTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}
