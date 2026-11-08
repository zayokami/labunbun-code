/**
 * x64dbg: one headless snapshot run, on a private copy, behind the strictest
 * sandbox gate in the tool set.
 *
 * REA has no x64dbg integration at all, so this is designed from the debugger's
 * own headless mode rather than ported. GUI x64dbg cannot be driven headless —
 * it opens modal dialogs and has no quit command — while `headless.exe` is what
 * x64dbg's own automated tests use. Its interface is not a stable public
 * contract, which is why the tool owns the entire script (a caller cannot send
 * commands), asserts on the log it asked for instead of trusting the exit code,
 * and offers one snapshot action rather than a session.
 *
 * This is dynamic analysis: the debuggee runs. It therefore refuses anything
 * below `danger-full-access`, and it is never read-only or concurrency-safe.
 */
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "../containment.ts";
import type { Operations } from "../operations.ts";
import { resolveWritableRoots } from "../sandbox/default-writable-roots.ts";
import { workspacePolicy } from "../sandbox/workspace-policy.ts";
import {
	assertCommandSafe,
	assertTargetFile,
	copyTarget,
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
const LOG_FILE = "snapshot.log";
const SCRIPT_FILE = "snapshot.script";
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 900;

const inputSchema = z.object({
	path: z.string().describe("Path to a Windows PE executable inside the workspace"),
	timeoutSeconds: z
		.number()
		.int()
		.min(15)
		.max(MAX_TIMEOUT_SECONDS)
		.optional()
		.describe(`How long the debugger may run (default ${DEFAULT_TIMEOUT_SECONDS}s)`),
});

export interface DebugWithX64dbgOptions {
	tempDir?: string;
	env?: NodeJS.ProcessEnv;
	/** An explicit x64dbg install directory or executable, for tests and unusual installs. */
	enginePath?: string;
}

interface PeHeader {
	machine: number;
	/** IMAGE_FILE_DLL: a library is not an image x64dbg can start. */
	dll: boolean;
}

/** The COFF fields this tool reads, or `undefined` when the file is not a PE image. */
async function peHeader(path: string): Promise<PeHeader | undefined> {
	const handle = await open(path, "r");
	try {
		const header = Buffer.alloc(4_096);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		if (bytesRead < 0x40) return undefined;
		if (header[0] !== 0x4d || header[1] !== 0x5a) return undefined;
		const peOffset = header.readUInt32LE(0x3c);
		// 0x16 is Characteristics within the COFF header, which starts four bytes
		// into the PE signature.
		if (peOffset + 0x18 > bytesRead) return undefined;
		if (header.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return undefined;
		return {
			machine: header.readUInt16LE(peOffset + 4),
			dll: (header.readUInt16LE(peOffset + 0x16) & 0x2000) !== 0,
		};
	} finally {
		await handle.close();
	}
}

/**
 * Read the debugger's redirected log. Headless appends the same UTF-8 text it
 * prints, while the GUI's own redirection writes UTF-16LE with a BOM; reading
 * the BOM handles the second form and the UTF-8 path is the one this tool
 * actually takes.
 */
async function readDebuggerLog(path: string): Promise<string> {
	const data = await readFile(path).catch(() => undefined);
	if (data === undefined) return "";
	if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString("utf16le");
	if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
		const swapped = Buffer.from(data.subarray(2));
		swapped.swap16();
		return swapped.toString("utf16le");
	}
	return data.toString("utf8");
}

/** The fixed snapshot script. Every command and argument is ours; the only
 * generated value is the log path, which lives in the private workspace.
 */
function snapshotScript(logPath: string): string {
	// Script arguments are not C strings: a quoted argument keeps a backslash
	// literal unless it precedes a quote or a brace, so `JSON.stringify` would
	// double every Windows separator. `quoteToken` leaves the path bare when it
	// can and quotes it otherwise, and the safety check refuses a path the
	// script lexer could not carry.
	const quotedLog = quoteToken(assertCommandSafe(logPath, "x64dbg log"));
	return [
		`RedirectLog ${quotedLog}`,
		'log "LABUNBUN snapshot begin"',
		"var $base",
		"mov $base, mod.main()",
		'log "LABUNBUN base={x:$base}"',
		// The assert is the success gate, and it is placed before the marker:
		// when the module did not load, mod.main() is zero, the assertion
		// aborts the script, and the marker is never written. x64dbg's own
		// testfinalize then records the run as failed too.
		"testassert $base",
		'log "LABUNBUN entry={x:mod.entry($base)}"',
		'log "LABUNBUN size={x:mod.size($base)}"',
		"imageinfo $base",
		"modcallfind",
		'log "LABUNBUN status=ok"',
		"stop",
		"ret",
		"",
	].join("\n");
}

/** Analyze one PE under x64dbg's headless debugger and report the module snapshot. */
export function createDebugWithX64dbgTool(cwd: string, ops: Operations, options: DebugWithX64dbgOptions = {}): AnyTool {
	return buildTool({
		name: "DebugWithX64dbg",
		description:
			"Loads a Windows PE file in x64dbg's headless debugger and captures a module snapshot: image base, " +
			"entry point, size, image information, and the calls the debugger found. This is dynamic analysis — the " +
			"debuggee is started under a debugger — so it requires the danger-full-access sandbox and never runs " +
			"unattended in a read-only or workspace-write session. The tool owns the debugger script; caller-authored " +
			"commands are not accepted. Requires x64dbg with headless.exe (set LBB_X64DBG_PATH when it is not found).",
		inputSchema,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		call: async (input, ctx) => {
			if (process.platform !== "win32") {
				return errorResult("DebugWithX64dbg is Windows-only: x64dbg debugs Windows PE files.");
			}
			if (ctx.sandbox !== "danger-full-access") {
				return errorResult(
					"DebugWithX64dbg starts a debuggee and needs the danger-full-access sandbox; the current session " +
						"is confined more tightly. Switch the sandbox mode to use it.",
				);
			}
			let source: string;
			try {
				source = guardPathContainment(input.path, cwd, "DebugWithX64dbg");
				await assertTargetFile(source, input.path);
			} catch (error) {
				return errorResult(message(error));
			}

			const header = await peHeader(source).catch(() => undefined);
			if (header === undefined) {
				return errorResult(`${input.path} is not a PE image; x64dbg only debugs Windows PE files.`);
			}
			if (header.dll) {
				return errorResult(
					`${input.path} is a DLL. x64dbg's headless mode starts an executable, so a library has no image for it ` +
						"to load; use a static tool for it.",
				);
			}
			const machine = header.machine;
			if (machine !== 0x14c && machine !== 0x8664) {
				return errorResult(
					`${input.path} targets machine 0x${machine.toString(16)}, which x64dbg's x86/x64 headless builds cannot debug.`,
				);
			}

			const installed =
				options.enginePath !== undefined
					? discoverX64dbgFrom(options.enginePath, options.env)
					: discoverEngine("x64dbg", defaultProbe(options.env));
			if (installed === undefined) return errorResult(missingEngineText("x64dbg"));
			const headless = machine === 0x8664 ? installed.details?.headlessX64 : installed.details?.headlessX32;
			if (headless === undefined) {
				return errorResult(
					`${installed.home ?? installed.program} has no ${machine === 0x8664 ? "x64" : "x32"} headless.exe. ` +
						"DebugWithX64dbg needs the headless build that ships beside the GUI debugger, not the GUI itself.",
				);
			}

			const workspace = await createEngineWorkspace("x64dbg", options.tempDir);
			try {
				const target = await copyTarget(source, workspace);
				// x64dbg's startup refuses a -userdir that does not exist, and this
				// directory is where it writes its database and configuration — so it
				// has to be ours and it has to be made before the debugger starts.
				await mkdir(join(workspace.root, "userdir"), { recursive: true });
				const logPath = join(workspace.root, LOG_FILE);
				const scriptPath = join(workspace.root, SCRIPT_FILE);
				await ops.writeTextFile(scriptPath, snapshotScript(logPath));

				const command = [
					quoteToken(assertCommandSafe(headless, "x64dbg")),
					"-testing",
					"-userdir",
					quoteToken(join(workspace.root, "userdir")),
					"-cf",
					quoteToken(scriptPath),
					quoteToken(target.name),
				].join(" ");
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
					command,
					cwd: workspace.root,
					timeoutMs: Math.min(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1_000,
					signal: ctx.signal,
					sandbox: policy,
				});

				const log = await readDebuggerLog(logPath);
				// The exit code is not a verdict here: a headless test run can exit 0
				// after a script error, and can exit non-zero after a complete
				// snapshot. The marker the script logs is the verdict; the status is
				// reported alongside it, never instead of it.
				if (!log.includes("LABUNBUN status=ok")) {
					const detail = engineFailureText("x64dbg", run, [log, run.stdout, run.stderr].filter(Boolean).join("\n"));
					return errorResult(
						`${detail}\n\nThe debugger did not reach the end of its snapshot script; the log above is x64dbg's own.`,
					);
				}
				// The script's assert stops before the marker when mod.main() is zero,
				// but a zero base is never a snapshot even if a log says the script
				// finished: the tool must not report one.
				if (/^LABUNBUN base=0\r?$/m.test(log)) {
					return errorResult(
						`x64dbg started but did not load a module from ${input.path} (mod.main() is zero), so there is no snapshot.`,
					);
				}
				const lines = [
					`x64dbg snapshot of ${input.path}`,
					`  ${machine === 0x8664 ? "x64" : "x86"} debuggee, headless exit code ${run.exitCode ?? "none"}${run.killed ? " (killed at the time limit)" : ""}`,
					"",
					tailLines(log, 200) || "(the debugger wrote no log lines)",
				];
				if (run.stderr.trim() !== "") lines.push("", "stderr:", tailLines(run.stderr, 20));
				return { content: [{ type: "text", text: cap(lines.join("\n")) }] };
			} catch (error) {
				return errorResult(message(error));
			} finally {
				const cleaned = await workspace.cleanup();
				if (!cleaned) console.error(`DebugWithX64dbg: could not remove ${workspace.root}`);
			}
		},
	});
}

/**
 * Discovery for an explicit path. `discoverEngine` reads `LBB_X64DBG_PATH`, so an
 * injected option is turned into the same environment shape rather than a
 * second discovery implementation.
 */
function discoverX64dbgFrom(enginePath: string, env: NodeJS.ProcessEnv | undefined) {
	return discoverEngine("x64dbg", defaultProbe({ ...process.env, ...env, LBB_X64DBG_PATH: enginePath }));
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
