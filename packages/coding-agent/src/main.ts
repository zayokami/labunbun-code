#!/usr/bin/env bun
import { runHeadless } from "./headless.ts";
import { CLI_NAME, CODING_AGENT_VERSION } from "./index.ts";
import { runInteractive } from "./interactive.ts";
import { MIGRATION_SOURCE_IDS, runMigration } from "./migrate.ts";

/** Subcommands, recognised only as the first argument. */
const SUBCOMMANDS = new Set(["migrate"]);

interface CliArgs {
	subcommand: string | null;
	help: boolean;
	version: boolean;
	print: string | null;
	model: string | null;
	permissionMode: string | null;
	maxTurns: number | null;
	noSession: boolean;
	resume: string | null;
	continueLast: boolean;
	outputFormat: string | null;
	apply: boolean;
	force: boolean;
	from: string | null;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		subcommand: null,
		help: false,
		version: false,
		print: null,
		model: null,
		permissionMode: null,
		maxTurns: null,
		noSession: false,
		resume: null,
		continueLast: false,
		outputFormat: null,
		apply: false,
		force: false,
		from: null,
	};
	// A leading bare word is a subcommand. Only the first argument is eligible,
	// so a stray word later in the line is still the error it was before.
	let rest = argv;
	if (argv.length > 0 && !argv[0].startsWith("-") && SUBCOMMANDS.has(argv[0])) {
		args.subcommand = argv[0];
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
			case "--apply":
				args.apply = true;
				break;
			case "--force":
				args.force = true;
				break;
			case "--from":
				args.from = rest[++i] ?? null;
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
  labunbun migrate             Import settings from another agent tool
  labunbun --version           Show version

Options:
  -p, --print <prompt>         Run headless mode
      --model <provider/id>    Model to use (default anthropic/claude-sonnet-5)
      --permission-mode <m>    default | plan | acceptEdits | dontAsk | bypassPermissions
      --max-turns <n>          Cap agent turns in headless mode
      --no-session             Don't persist this session to disk
      --resume <id>            Resume a saved session
  -c, --continue               Continue the most recent session
      --output-format <f>      Headless output: text | json | stream-json
  -h, --help                   Show this help

migrate options:
      --from <sources>         ${MIGRATION_SOURCE_IDS.join(" | ")} | all (default all)
      --apply                  Write the changes (default is a dry run)
      --force                  Overwrite values and files that already exist`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
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
	if (args.subcommand === "migrate") {
		const result = runMigration({
			from: args.from ?? undefined,
			apply: args.apply,
			force: args.force,
		});
		if (result.error) {
			console.error(result.error);
			return 2;
		}
		console.log(result.report);
		return result.applied && result.applied.failed.length > 0 ? 1 : 0;
	}

	if (args.print !== null) {
		if (!args.print.trim()) {
			console.error("-p requires a prompt string");
			return 2;
		}
		const validModes = new Set(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]);
		if (args.permissionMode && !validModes.has(args.permissionMode)) {
			console.error(`Invalid permission mode: ${args.permissionMode}`);
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
			permissionMode: (args.permissionMode as never) ?? undefined,
			maxTurns: args.maxTurns ?? undefined,
			noSession: args.noSession,
			outputFormat: (args.outputFormat as never) ?? undefined,
		});
	}

	console.log(`${CLI_NAME} ${CODING_AGENT_VERSION} — starting interactive mode…`);
	return runInteractive({
		modelRef: args.model ?? undefined,
		permissionMode: (args.permissionMode as never) ?? undefined,
		resumeSessionId: args.resume ?? undefined,
		continueLast: args.continueLast,
	});
}

if (import.meta.main) {
	process.exit(await main());
}
