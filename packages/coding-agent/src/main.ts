#!/usr/bin/env bun
import { runHeadless } from "./headless.ts";
import { CLI_NAME, CODING_AGENT_VERSION } from "./index.ts";
import { runInteractive } from "./interactive.ts";

interface CliArgs {
	help: boolean;
	version: boolean;
	print: string | null;
	model: string | null;
	permissionMode: string | null;
	maxTurns: number | null;
	noSession: boolean;
	resume: string | null;
	outputFormat: string | null;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		help: false,
		version: false,
		print: null,
		model: null,
		permissionMode: null,
		maxTurns: null,
		noSession: false,
		resume: null,
		outputFormat: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
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
				args.print = argv[++i] ?? "";
				break;
			case "--model":
				args.model = argv[++i] ?? null;
				break;
			case "--permission-mode":
				args.permissionMode = argv[++i] ?? null;
				break;
			case "--max-turns":
				args.maxTurns = Number(argv[++i]) || null;
				break;
			case "--no-session":
				args.noSession = true;
				break;
			case "--resume":
				args.resume = argv[++i] ?? null;
				break;
			case "--output-format":
				args.outputFormat = argv[++i] ?? null;
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
  labunbun                     Interactive REPL (Phase 3)
  labunbun -p "<prompt>"       Headless: run one prompt and print the result
  labunbun --version           Show version

Options:
  -p, --print <prompt>         Run headless mode
      --model <provider/id>    Model to use (default anthropic/claude-sonnet-5)
      --permission-mode <m>    default | plan | acceptEdits | dontAsk | bypassPermissions
      --max-turns <n>          Cap agent turns in headless mode
      --no-session             Don't persist this session to disk
      --resume <id>            Resume a saved session
      --output-format <f>      Headless output: text | json | stream-json
  -h, --help                   Show this help`);
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
	});
}

if (import.meta.main) {
	process.exit(await main());
}
