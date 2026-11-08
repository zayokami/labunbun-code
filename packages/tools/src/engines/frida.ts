/**
 * Frida: process discovery and one-shot dynamic instrumentation through the
 * `frida` command-line tools.
 *
 * The CLI is the narrow dependency: a user who has Frida installed has it, and
 * this build does not take a native Node binding for one tool family. The
 * runtime attaches or spawns for a bounded number of seconds and then detaches;
 * there is no persistent session, no injected agent left behind, and no
 * background handle for a later call to reach.
 *
 * Instrumentation executes the target's code, so it is not read-only. Listing
 * processes only enumerates; it still starts a third-party program, which is
 * why it is not in the plan-mode read-only set either.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "../containment.ts";
import type { Operations } from "../operations.ts";
import { resolveWritableRoots } from "../sandbox/default-writable-roots.ts";
import { workspacePolicy } from "../sandbox/workspace-policy.ts";
import {
	assertCommandSafe,
	createEngineWorkspace,
	defaultProbe,
	discoverEngine,
	engineFailureText,
	missingEngineText,
	quoteToken,
	runEngineCommand,
	tailLines,
} from "./common.ts";

const MAX_REPORT_CHARS = 24_000;
const DEFAULT_LIST_TIMEOUT_SECONDS = 30;
const DEFAULT_INSTRUMENT_SECONDS = 10;
const MAX_INSTRUMENT_SECONDS = 300;

/** The `frida-ps` companion, found beside the `frida` CLI that discovery resolved. */
function psCompanion(
	fridaProgram: string,
	platform: NodeJS.Platform,
	isFile: (path: string) => boolean,
): string | undefined {
	const directory = dirname(fridaProgram);
	const names = platform === "win32" ? ["frida-ps.exe", "frida-ps"] : ["frida-ps"];
	for (const name of names) {
		const candidate = platform === "win32" ? join(directory, name) : `${directory}/${name}`;
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

const listSchema = z.object({
	kind: z
		.enum(["processes", "applications"])
		.default("processes")
		.describe("processes: running processes. applications: installed applications (useful as spawn targets)."),
	device: z.string().optional().describe("A Frida device id (default: the local device)"),
	filter: z.string().optional().describe("Case-insensitive substring the process or application name must contain"),
	timeoutSeconds: z.number().int().min(5).max(120).optional(),
});

export interface FridaToolOptions {
	tempDir?: string;
	env?: NodeJS.ProcessEnv;
	/** An explicit `frida` CLI path, for tests and unusual installs. */
	enginePath?: string;
}

interface FridaProcessRow {
	pid?: number;
	name?: string;
	identifier?: string;
}

/** Enumerate local or device processes/applications without attaching to them. */
export function createListFridaTargetsTool(cwd: string, ops: Operations, options: FridaToolOptions = {}): AnyTool {
	return buildTool({
		name: "ListFridaTargets",
		description:
			"Lists running processes or installed applications visible to Frida, optionally on one device, using " +
			"`frida-ps -j`. It does not attach to anything. Use the returned pid with InstrumentWithFrida (attach) or " +
			"an application identifier with a spawn call. Requires a Frida installation (set LBB_FRIDA_PATH if the " +
			"CLI is not found).",
		inputSchema: listSchema,
		isReadOnly: () => false,
		isConcurrencySafe: () => true,
		call: async (input, ctx) => {
			const probe = defaultProbe(options.env);
			const installed =
				options.enginePath !== undefined ? { program: options.enginePath } : discoverEngine("frida", probe);
			if (installed === undefined) return errorResult(missingEngineText("frida"));
			const ps = psCompanion(installed.program, probe.platform, probe.isFile);
			if (ps === undefined) {
				return errorResult(
					`${installed.program} was found, but frida-ps is not beside it. Install the full frida-tools package, not just the frida binding.`,
				);
			}
			const parts = [quoteToken(assertCommandSafe(ps, "Frida"))];
			// `-a` is the CLI's "applications" view; `-e` drops icon blobs, which
			// otherwise dominate the JSON on a desktop OS.
			if (input.kind === "applications") parts.push("-a");
			parts.push("-j", "-e");
			if (input.device !== undefined) parts.push("-D", quoteToken(assertCommandSafe(input.device, "Frida device")));

			const policy = await workspacePolicy(cwd, { sandbox: ctx.sandbox, network: ctx.network });
			const run = await runEngineCommand({
				ops,
				command: parts.join(" "),
				cwd,
				timeoutMs: (input.timeoutSeconds ?? DEFAULT_LIST_TIMEOUT_SECONDS) * 1_000,
				signal: ctx.signal,
				sandbox: policy,
			});
			if (run.exitCode !== 0) return errorResult(engineFailureText("frida-ps", run));

			let rows: FridaProcessRow[];
			try {
				const parsed = JSON.parse(run.stdout) as unknown;
				if (!Array.isArray(parsed)) return errorResult("frida-ps returned JSON that is not a list of processes.");
				rows = parsed.filter((row): row is FridaProcessRow => typeof row === "object" && row !== null);
			} catch (error) {
				return errorResult(
					`frida-ps output was not JSON (${error instanceof Error ? error.message : String(error)}).\n${tailLines(run.stdout, 10)}`,
				);
			}

			const filter = input.filter?.toLowerCase();
			const matched = rows.filter((row) => {
				if (filter === undefined || filter === "") return true;
				return `${row.name ?? ""} ${row.identifier ?? ""}`.toLowerCase().includes(filter);
			});
			const lines = [
				`Frida ${input.kind === "applications" ? "applications" : "processes"}${input.device === undefined ? "" : ` on ${input.device}`}` +
					`${filter === undefined ? "" : ` matching ${JSON.stringify(input.filter)}`}: ${matched.length}`,
			];
			for (const row of matched.slice(0, 500)) {
				const id = row.pid === undefined ? "" : String(row.pid).padStart(6, " ");
				const identifier = row.identifier === undefined ? "" : `  ${row.identifier}`;
				lines.push(`  ${id}  ${row.name ?? "(unnamed)"}${identifier}`);
			}
			if (matched.length > 500) lines.push(`  ... ${matched.length - 500} more; narrow with filter.`);
			return { content: [{ type: "text", text: cap(lines.join("\n")) }] };
		},
	});
}

const instrumentSchema = z.object({
	mode: z.enum(["attach", "spawn"]).describe("attach to an existing process, or spawn a file under Frida"),
	pid: z.number().int().positive().optional().describe("Process id for mode=attach"),
	name: z.string().optional().describe("Process name for mode=attach (instead of pid)"),
	file: z.string().optional().describe("Executable path inside the workspace for mode=spawn"),
	script: z.string().optional().describe("Inline Frida JavaScript to load"),
	scriptPath: z.string().optional().describe("Path to a Frida JavaScript file inside the workspace"),
	device: z.string().optional().describe("A Frida device id (default: the local device)"),
	seconds: z
		.number()
		.int()
		.min(1)
		.max(MAX_INSTRUMENT_SECONDS)
		.optional()
		.describe(`How long instrumentation runs before detachment (default ${DEFAULT_INSTRUMENT_SECONDS}s)`),
});

/**
 * Attach to or spawn a process, load one script, collect its output for a
 * bounded time, then detach.
 *
 * The run is one Frida CLI invocation in quiet mode with a timeout (`-q -t`),
 * so the detach is the CLI's own orderly exit rather than a kill. If the CLI
 * outlives its ceiling anyway, `Operations.exec` kills the process tree.
 */
export function createInstrumentWithFridaTool(cwd: string, ops: Operations, options: FridaToolOptions = {}): AnyTool {
	return buildTool({
		name: "InstrumentWithFrida",
		description:
			"Attaches Frida to a running process (pid or name) or spawns an executable, loads one JavaScript script, " +
			"collects its output for a bounded number of seconds, then detaches. This executes the target's code and " +
			"can change its behavior; it is dynamic analysis, not inspection. Provide exactly one of script or " +
			"scriptPath. Requires a Frida installation.",
		inputSchema: instrumentSchema,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		validateInput: async (input) => {
			if (input.mode === "attach" && input.pid === undefined && (input.name === undefined || input.name === "")) {
				return "attach needs a pid or a process name.";
			}
			if (input.mode === "spawn" && (input.file === undefined || input.file === "")) return "spawn needs a file path.";
			if ((input.script === undefined) === (input.scriptPath === undefined)) {
				return "provide exactly one of script (inline source) or scriptPath.";
			}
			return null;
		},
		call: async (input, ctx) => {
			if (ctx.sandbox === "read-only") {
				return errorResult(
					"InstrumentWithFrida executes target code and needs a writable private workspace for its script.",
				);
			}
			const installed =
				options.enginePath !== undefined
					? { program: options.enginePath }
					: discoverEngine("frida", defaultProbe(options.env));
			if (installed === undefined) return errorResult(missingEngineText("frida"));

			let scriptSource: string;
			try {
				scriptSource =
					input.script ??
					(await readFile(guardPathContainment(input.scriptPath as string, cwd, "InstrumentWithFrida"), "utf8"));
				if (scriptSource.trim() === "") return errorResult("the Frida script is empty.");
			} catch (error) {
				return errorResult(message(error));
			}

			let spawnPath: string | undefined;
			if (input.mode === "spawn") {
				try {
					spawnPath = guardPathContainment(input.file as string, cwd, "InstrumentWithFrida");
					assertCommandSafe(spawnPath, "Frida target");
				} catch (error) {
					return errorResult(message(error));
				}
			}

			const workspace = await createEngineWorkspace("frida", options.tempDir);
			try {
				const scriptFile = join(workspace.root, "script.js");
				await ops.writeTextFile(scriptFile, scriptSource);

				const seconds = Math.min(input.seconds ?? DEFAULT_INSTRUMENT_SECONDS, MAX_INSTRUMENT_SECONDS);
				const parts = [
					quoteToken(assertCommandSafe(installed.program, "Frida")),
					"-q",
					"-t",
					String(seconds),
					"-l",
					quoteToken(scriptFile),
				];
				if (input.device !== undefined) parts.push("-D", quoteToken(assertCommandSafe(input.device, "Frida device")));
				if (input.mode === "attach") {
					if (input.pid !== undefined) parts.push("-p", String(input.pid));
					else parts.push("-n", quoteToken(assertCommandSafe(input.name as string, "Frida process name")));
				} else {
					parts.push("-f", quoteToken(spawnPath as string), "--stdio", "pipe");
				}

				const policy = await workspacePolicy(cwd, {
					sandbox: ctx.sandbox,
					network: ctx.network,
					writableRoots: [
						{ path: workspace.root, kind: "data" },
						...resolveWritableRoots({ tempDir: options.tempDir }),
					],
				});
				const run = await runEngineCommand({
					ops,
					command: parts.join(" "),
					cwd: workspace.root,
					timeoutMs: (seconds + 20) * 1_000,
					signal: ctx.signal,
					sandbox: policy,
				});

				const output = run.stdout.trim();
				const errors = run.stderr.trim();
				const header =
					input.mode === "attach"
						? `Frida attached to ${input.pid !== undefined ? `pid ${input.pid}` : input.name} for ${seconds}s`
						: `Frida spawned ${input.file} for ${seconds}s`;
				const lines = [header];
				if (run.killed) lines.push("(the CLI outlived its ceiling and was killed; the detach is unconfirmed)");
				else if (run.exitCode !== 0) lines.push(`(frida exited with code ${run.exitCode})`);
				lines.push("", output === "" ? "(no script output)" : output);
				if (errors !== "") lines.push("", "stderr:", errors);
				return { content: [{ type: "text", text: cap(lines.join("\n")) }] };
			} catch (error) {
				return errorResult(message(error));
			} finally {
				const cleaned = await workspace.cleanup();
				if (!cleaned) console.error(`InstrumentWithFrida: could not remove ${workspace.root}`);
			}
		},
	});
}

function cap(text: string): string {
	if (text.length <= MAX_REPORT_CHARS) return text;
	return `${text.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(text.length - MAX_REPORT_CHARS)}`;
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
