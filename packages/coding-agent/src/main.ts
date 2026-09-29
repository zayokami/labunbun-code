#!/usr/bin/env bun
import { PERMISSION_MODES, type PermissionMode, SANDBOX_MODES, type SandboxMode } from "@labunbun/agent";
import { runHeadless } from "./headless.ts";
import { CLI_NAME, CODING_AGENT_VERSION } from "./index.ts";
import { runInteractive } from "./interactive.ts";
import { DEFAULT_HISTORY_LIMIT, MIGRATION_SOURCE_IDS, runMigration } from "./migrate.ts";

/**
 * Check `--permission-mode` and `--sandbox` against the lists that define them.
 *
 * Returns the typed values or a sentence naming the valid ones, so the caller
 * has one thing to do either way. Absent flags come back as `undefined`, which
 * is the whole point: the session then derives the axis from its default rather
 * than this function inventing one, so `--sandbox` alone and no flag at all
 * cannot disagree about what confined means.
 */
export function validateModeFlags(args: { permissionMode: string | null; sandbox: string | null }): {
	mode?: PermissionMode;
	sandbox?: SandboxMode;
	error?: string;
} {
	const validModes = new Set<string>(PERMISSION_MODES);
	if (args.permissionMode && !validModes.has(args.permissionMode)) {
		return { error: `Invalid permission mode: ${args.permissionMode} (${PERMISSION_MODES.join(" | ")})` };
	}
	const validSandboxes = new Set<string>(SANDBOX_MODES);
	if (args.sandbox && !validSandboxes.has(args.sandbox)) {
		return { error: `Invalid sandbox: ${args.sandbox} (${SANDBOX_MODES.join(" | ")})` };
	}
	// An untyped flag comes back as `undefined` and not as the `null` the
	// argument parser produced. The two behave the same under `??`, so nothing
	// downstream was reading the difference — which is exactly why the return
	// type claiming `undefined` while the value was `null` went unnoticed, and
	// why a consumer that checked `"mode" in flags` would have been told the
	// flag was there when nobody typed it.
	return {
		mode: args.permissionMode ? (args.permissionMode as PermissionMode) : undefined,
		sandbox: args.sandbox ? (args.sandbox as SandboxMode) : undefined,
	};
}

/**
 * Subcommands, recognised only as the first argument, each spelling mapped to
 * the one canonical name.
 *
 * A map rather than a set so that a second spelling of a subcommand is a second
 * entry here instead of a second condition at the dispatch site — the place a
 * third alias would be forgotten. `migrate` is the former name of `yoshi` and
 * still works, so the old scripts and the muscle memory keep running.
 */
const SUBCOMMANDS = new Map([
	["yoshi", "yoshi"],
	["migrate", "yoshi"],
]);

interface CliArgs {
	subcommand: string | null;
	help: boolean;
	version: boolean;
	print: string | null;
	model: string | null;
	permissionMode: string | null;
	sandbox: string | null;
	maxTurns: number | null;
	noSession: boolean;
	resume: string | null;
	continueLast: boolean;
	outputFormat: string | null;
	/**
	 * `null` means "whatever the settings say". A flag rather than a value: the
	 * two spellings are `--gamepad` and `--no-gamepad`, and neither writes the
	 * setting — a flag that edited the user's file would make "try it once"
	 * impossible.
	 */
	gamepad: boolean | null;
	apply: boolean;
	force: boolean;
	from: string | null;
	only: string | null;
	historyScope: string | null;
	historyLimit: string | null;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		subcommand: null,
		help: false,
		version: false,
		print: null,
		model: null,
		permissionMode: null,
		sandbox: null,
		maxTurns: null,
		noSession: false,
		resume: null,
		continueLast: false,
		outputFormat: null,
		gamepad: null,
		apply: false,
		force: false,
		from: null,
		only: null,
		historyScope: null,
		historyLimit: null,
	};
	// A leading bare word is a subcommand. Only the first argument is eligible,
	// so a stray word later in the line is still the error it was before. The
	// canonical name is what lands in `args`, so everything downstream reads one
	// spelling rather than testing which one the user happened to type.
	let rest = argv;
	if (argv.length > 0 && !argv[0].startsWith("-") && SUBCOMMANDS.has(argv[0])) {
		args.subcommand = SUBCOMMANDS.get(argv[0]) ?? null;
		rest = argv.slice(1);
	}
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		switch (arg) {
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--version":
			case "-v":
				args.version = true;
				break;
			case "--print":
			case "-p":
				args.print = rest[++i] ?? "";
				break;
			case "--model":
				args.model = rest[++i] ?? null;
				break;
			case "--permission-mode":
				args.permissionMode = rest[++i] ?? null;
				break;
			case "--sandbox":
				args.sandbox = rest[++i] ?? null;
				break;
			case "--max-turns":
				args.maxTurns = Number(rest[++i]) || null;
				break;
			case "--no-session":
				args.noSession = true;
				break;
			case "--resume":
				args.resume = rest[++i] ?? null;
				break;
			case "--continue":
			case "-c":
				args.continueLast = true;
				break;
			case "--output-format":
				args.outputFormat = rest[++i] ?? null;
				break;
			case "--gamepad":
				args.gamepad = true;
				break;
			case "--no-gamepad":
				args.gamepad = false;
				break;
			case "--apply":
				args.apply = true;
				break;
			case "--force":
				args.force = true;
				break;
			case "--from":
				args.from = rest[++i] ?? null;
				break;
			case "--yoshi":
			case "--migrate":
				// Alias for the subcommand, handled here so it too runs before the
				// API-key check — importing a configuration is what someone does
				// when they have no working configuration yet. `--migrate` is the
				// spelling this command had before it was renamed.
				args.subcommand = "yoshi";
				break;
			case "--only":
				args.only = rest[++i] ?? null;
				break;
			case "--history-scope":
				args.historyScope = rest[++i] ?? null;
				break;
			case "--history-limit":
				args.historyLimit = rest[++i] ?? null;
				break;
			default:
				console.error(`Unknown argument: ${arg} (see --help)`);
				process.exit(2);
		}
	}
	return args;
}

function printHelp(): void {
	console.log(`${CLI_NAME} — a coding agent for your terminal

Usage:
  labunbun                     Interactive REPL
  labunbun -p "<prompt>"       Headless: run one prompt and print the result
  labunbun yoshi               Import settings from another agent tool
  labunbun --version           Show version

Options:
  -p, --print <prompt>         Run headless mode
      --model <provider/id>    Model to use (default anthropic/claude-sonnet-5)
      --permission-mode <m>    ${PERMISSION_MODES.join(" | ")}  (default ask)
      --sandbox <s>            ${SANDBOX_MODES.join(" | ")}
                               The other axis: what a run may touch at all.
      --max-turns <n>          Cap agent turns in headless mode
      --no-session             Don't persist this session to disk
      --resume <id>            Resume a saved session
  -c, --continue               Continue the most recent session
      --output-format <f>      Headless output: text | json | stream-json
      --gamepad                Read a DualShock 4 this run (or --no-gamepad)
  -h, --help                   Show this help

yoshi options:
      --from <sources>         ${MIGRATION_SOURCE_IDS.join(" | ")} | all (default all)
      --only <categories>      settings | assets | history | all (default all)
      --history-scope <s>      cwd | all | none (default cwd)
      --history-limit <n>      Sessions to import per source (default ${DEFAULT_HISTORY_LIMIT}, 0 for none)
      --apply                  Write the changes (default is a dry run)
      --force                  Overwrite values and files that already exist

  Both \`yoshi\` and \`--yoshi\` run this; \`migrate\` and \`--migrate\` are the
  spellings this command had before it was renamed, and still work.`);
}

/**
 * `home` is the directory the run reads and writes user-owned state under. The
 * process entry point has no reason to want one, and takes the default; it is
 * here because `argv` is already injectable and a caller that supplies it is
 * running the CLI in-process, where "which home" is otherwise only answerable by
 * mutating `process.env` — which resolves differently depending on the platform
 * the code happens to be running on.
 */
export interface MainOptions {
	home?: string;
}

export async function main(argv: string[] = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
	const args = parseArgs(argv);

	if (args.version) {
		console.log(`${CLI_NAME} ${CODING_AGENT_VERSION}`);
		return 0;
	}
	if (args.help) {
		printHelp();
		return 0;
	}

	// Subcommands run before model resolution and the API-key check: importing a
	// configuration is exactly what someone does when they have no working
	// configuration yet, so it must not require one.
	if (args.subcommand === "yoshi") {
		const result = runMigration({
			from: args.from ?? undefined,
			apply: args.apply,
			force: args.force,
			only: args.only ?? undefined,
			historyScope: args.historyScope ?? undefined,
			historyLimit: args.historyLimit ?? undefined,
			home: options.home,
		});
		if (result.error) {
			console.error(result.error);
			return 2;
		}
		console.log(result.report);
		return result.applied && result.applied.failed.length > 0 ? 1 : 0;
	}

	// Both axes, validated once, before either path branches. This used to live
	// inside the `-p` branch only, so the interactive path reached the session
	// with `permissionMode: args.permissionMode as never` — a cast, no check. A
	// typo in `--permission-mode` exited 2 when there was a prompt and was
	// silently dropped to the default when there wasn't, which is the worse half
	// being the one nobody runs.
	const flags = validateModeFlags(args);
	if (flags.error !== undefined) {
		console.error(flags.error);
		return 2;
	}

	if (args.print !== null) {
		if (!args.print.trim()) {
			console.error("-p requires a prompt string");
			return 2;
		}
		const validFormats = new Set(["text", "json", "stream-json"]);
		if (args.outputFormat && !validFormats.has(args.outputFormat)) {
			console.error(`Invalid output format: ${args.outputFormat} (text | json | stream-json)`);
			return 2;
		}
		return runHeadless({
			prompt: args.print,
			modelRef: args.model ?? undefined,
			permissionMode: flags.mode,
			sandbox: flags.sandbox,
			maxTurns: args.maxTurns ?? undefined,
			noSession: args.noSession,
			outputFormat: (args.outputFormat as never) ?? undefined,
			home: options.home,
		});
	}

	console.log(`${CLI_NAME} ${CODING_AGENT_VERSION} — starting interactive mode…`);
	return runInteractive({
		modelRef: args.model ?? undefined,
		permissionMode: flags.mode,
		sandbox: flags.sandbox,
		resumeSessionId: args.resume ?? undefined,
		continueLast: args.continueLast,
		gamepad: args.gamepad ?? undefined,
		home: options.home,
	});
}

if (import.meta.main) {
	process.exit(await main());
}
