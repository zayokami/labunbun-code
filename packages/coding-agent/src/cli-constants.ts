/**
 * The handful of values the CLI needs before it knows which mode it is running.
 *
 * `main.ts` used to import them from `@labunbun/agent` and `./migrate.ts`, which
 * meant the whole engine and every migration reader had to load before
 * `--version` could print a string. The copies here are what lets the process
 * answer `--version` and `--help` without touching either module graph; the
 * modules are imported only once a branch actually needs them.
 *
 * Copies drift, so `cli-constants.test.ts` compares every array and value below
 * against its authoritative export. A mode, sandbox, network policy or migration
 * source added in the real list fails that test until it is added here too —
 * which is the only moment the difference is visible. The values themselves are
 * byte-for-byte the ones the engine ships, help text included.
 */

export const CLI_NAME = "labunbun";
export const CODING_AGENT_VERSION = "0.1.0";

/** `packages/agent/src/types.ts` owns this list. */
export const PERMISSION_MODES = ["ask", "plan", "agent"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** `packages/agent/src/types.ts` owns this list. */
export const SANDBOX_MODES = ["workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** `packages/agent/src/sandbox-policy.ts` owns this list. */
export const NETWORK_SANDBOX_POLICIES = ["restricted", "enabled"] as const;
export type NetworkSandboxPolicy = (typeof NETWORK_SANDBOX_POLICIES)[number];

/** `packages/agent/src/types.ts` owns this row; only its two axes are read here. */
export const DEFAULT_MODE_CHOICE = {
	id: "agent",
	mode: "agent",
	sandbox: "workspace-write",
	label: "Agent",
	hint: "every call runs without asking; a dangerous command is refused outright",
} as const;

/** `packages/coding-agent/src/migrate-types.ts` owns this list, in this order. */
export const MIGRATION_SOURCE_IDS = [
	"claude-code",
	"codex",
	"zcode",
	"agents",
	"deepseek-harness",
	"grok-build",
	"kimi-code",
	"minimax-code",
	"step-code",
	"opencode",
	"cursor",
	"trae",
	"t3-code",
	"antigravity",
	"qoder",
	"codewhale",
	"mimocode-code",
	"openclaw",
	"alma",
	"command-code",
] as const;
export type MigrationSourceId = (typeof MIGRATION_SOURCE_IDS)[number];

/** `packages/coding-agent/src/migrate-history.ts` owns this value. */
export const DEFAULT_HISTORY_LIMIT = 20;
