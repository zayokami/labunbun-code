import { type AnyTool, buildTool } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import type { BackgroundShellManager } from "./background.ts";
import type { Operations } from "./operations.ts";
import { resolveWritableRoots } from "./sandbox/default-writable-roots.ts";
import { workspacePolicy } from "./sandbox/workspace-policy.ts";

/** How much output the live preview keeps — the tail of it, and not the result. */
const MAX_PREVIEW_CHARS = 30_000;

/**
 * How often a running command may push its output to the UI.
 *
 * The stream is a preview, not a transcript — the full output arrives with the
 * result either way — so ten updates a second is indistinguishable from every
 * chunk, while a command printing thousands of lines a second would otherwise
 * drive one store update and one React render per line.
 */
export const BASH_UPDATE_INTERVAL_MS = 100;

/**
 * Holds the last `maxChars` of a stream without rejoining it on every chunk.
 *
 * Chunks are dropped whole from the front once enough have accumulated, so the
 * set retained stays near the cap instead of growing with the command's total
 * output; only `read()` joins, and it is called once per emission rather than
 * once per chunk. The tail can therefore overshoot the cap by at most the length
 * of one chunk, which `read()` trims.
 */
export function createTailBuffer(maxChars: number): { push(chunk: string): void; read(): string } {
	const chunks: string[] = [];
	let size = 0;
	return {
		push(chunk: string): void {
			if (!chunk) return;
			chunks.push(chunk);
			size += chunk.length;
			while (chunks.length > 1 && size - chunks[0].length >= maxChars) {
				size -= chunks[0].length;
				chunks.shift();
			}
		},
		read(): string {
			const joined = chunks.join("");
			return joined.length > maxChars ? joined.slice(-maxChars) : joined;
		},
	};
}

export function createBashTool(
	cwd: string,
	ops: Operations,
	background?: BackgroundShellManager,
	options?: { home?: string; tempDir?: string; writableRoots?: readonly string[] },
): AnyTool {
	return buildTool({
		name: "Bash",
		description:
			"Executes a shell command and returns stdout/stderr with the exit code. " +
			"Output streams live while the command runs. Commands run through a POSIX-compatible " +
			"shell when available (Git Bash on Windows), otherwise cmd.exe. " +
			"Use for git, builds, test runners, and other CLI work. " +
			"Set run_in_background for long-running processes (dev servers, watchers) — you get a " +
			"shell id immediately, read progress with BashOutput, and are told when it finishes. " +
			"A foreground command that hits its timeout is moved to the background, not killed.",
		inputSchema: z.object({
			command: z.string().describe("The shell command to run"),
			timeout: z
				.number()
				.int()
				.min(1)
				.max(600_000)
				.optional()
				.describe("Timeout in ms before a foreground command moves to the background (default 120000, max 600000)"),
			description: z.string().optional().describe("One-line description of what this does"),
			run_in_background: z.boolean().optional().describe("Start without waiting; poll via BashOutput"),
		}),
		prompt:
			"- Prefer dedicated tools over shell where they exist (Read/Grep/Glob instead of cat/grep/find).\n" +
			"- Chain dependent steps with && ; avoid interactive commands.\n" +
			"- Provide a short `description` so the user can follow along.\n" +
			"- Use run_in_background for servers/watchers — a finished shell notifies you; " +
			"use BashOutput only for progress in between.\n" +
			"- A foreground command that exceeds its timeout keeps running in the background — " +
			"the result names its shell id; poll it instead of re-running the command.",
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		// Command output happens once. A failing build ends its report with the
		// error, and a head-only cut would throw exactly that part away.
		overflow: "spill",
		call: async (input, ctx) => {
			// Read per call, not captured at construction: `/mode` can change the
			// sandbox mid-session, and a tool holding the value it was built with
			// would keep applying the old one. Built before the branch because the
			// background path is spawned by the manager, not by `exec`, and leaving
			// it out would make `run_in_background: true` the way around the sandbox.
			const policy = await workspacePolicy(cwd, {
				sandbox: ctx.sandbox,
				network: ctx.network,
				// **`writableRoots` is what this line was missing**, and without it the
				// policy was "the workspace and nothing else" — so `mktemp` could not
				// create its directory and `npm install` could not write its cache, under
				// the mode every user gets by default. Nothing leaked; the policy was
				// exactly as narrow as it was built.
				//
				// `home` and `tempDir` are passed in rather than read here. The temp
				// directory and the package caches are per-USER paths, and this
				// repository's rule is that a reader takes its home as an argument:
				// `os.homedir()` reads only the Win32 environment block, so a reader
				// that calls it reads the developer's real config on linux and macOS,
				// which is a defect CI already caught once (see `source-env-coverage`).
				writableRoots: resolveWritableRoots({
					home: options?.home,
					tempDir: options?.tempDir,
					configured: options?.writableRoots,
				}),
			});

			if (input.run_in_background) {
				if (!background) {
					return {
						content: [textContent("Background execution is not available in this session.")],
						isError: true,
					};
				}
				const shell = await background.start(input.command, cwd, policy);
				return {
					content: [
						textContent(
							`Started in background as ${shell.id}.\nCommand: ${input.command}\nOutput file: ${shell.outputFile}\nPoll with BashOutput(shell_id="${shell.id}"); stop with KillBash.`,
						),
					],
					details: { backgroundShellId: shell.id },
				};
			}

			const timeoutMs = input.timeout ?? 120_000;
			const buffer = createTailBuffer(MAX_PREVIEW_CHARS);
			let lastUpdateAt = 0;
			// Set the moment a timed-out command is adopted. Chunks after that are the
			// shell's log, not this call's preview — pushing them toward an `onUpdate`
			// whose tool call has already returned would be a preview of nothing.
			let adoptedId: string | undefined;
			const result = await ops.exec({
				command: input.command,
				cwd,
				timeoutMs,
				signal: ctx.signal,
				sandbox: policy,
				onOutput: (chunk) => {
					if (adoptedId !== undefined) {
						background?.append(adoptedId, chunk);
						return;
					}
					buffer.push(chunk);
					const now = Date.now();
					if (now - lastUpdateAt < BASH_UPDATE_INTERVAL_MS) return;
					lastUpdateAt = now;
					ctx.onUpdate({ partialOutput: buffer.read() });
				},
				// Opt-in, and only when there is somewhere to hand the process to: a
				// command that outlives the wait is adopted rather than killed, so a
				// long build or test run survives the timeout that gave up on it. It is
				// the same process, not a restart — which is the difference between
				// continuing the work and doing it twice. With no manager (an
				// embedder's own tool set) the timeout keeps killing, because there is
				// no shell id to point a poll at.
				onTimeout: background
					? (handoff) => {
							const shell = background.adopt({
								child: handoff.child,
								command: input.command,
								cwd,
								startTime: handoff.startedAt,
								stdout: handoff.stdout,
								stderr: handoff.stderr,
							});
							adoptedId = shell.id;
						}
					: undefined,
			});

			// `adoptedId` and `handedOff` are set together — the id in `onTimeout`,
			// the flag when the same timer settles the promise — so this branch is
			// the handoff, and the narrowing is the pairing, not a guess.
			if (result.handedOff && adoptedId !== undefined) {
				const shell = background?.get(adoptedId);
				return {
					content: [
						textContent(
							`The command exceeded its ${timeoutMs}ms timeout and was moved to the background as ${adoptedId} — the same process, not a restart.\n` +
								`Command: ${input.command}\n` +
								(shell ? `Output file: ${shell.outputFile}\n` : "") +
								`Poll with BashOutput(shell_id="${adoptedId}"); stop with KillBash.`,
						),
					],
					details: { backgroundShellId: adoptedId },
				};
			}

			// The whole output goes to the model, uncut: `overflow: "spill"` above is
			// a promise that what does not fit is written out in full and pointed at,
			// and a cut here would have kept it to a head the model already had —
			// the spill file would hold exactly what the conversation showed.
			const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n--- stderr ---\n");
			// The verdict leads. A long result is cut at the head on its way into the
			// conversation, and the one line worth keeping through any cut is the one
			// that says whether the command worked.
			const status = result.killed ? "[command timed out or was killed]\n" : "";
			const text = `[exit code: ${result.exitCode}]\n${status}${output}`;
			return { content: [{ type: "text", text }], isError: result.exitCode !== 0 };
		},
	});
}

export function createBashOutputTool(background: BackgroundShellManager): AnyTool {
	return buildTool({
		name: "BashOutput",
		description:
			"Reads the accumulated output of a background shell started with Bash(run_in_background). " +
			"Safe to call repeatedly to tail progress.",
		inputSchema: z.object({
			shell_id: z.string().describe("The background shell id, e.g. 'shell_1'"),
		}),
		prompt: "- Poll BashOutput instead of re-running blocking commands to check on servers.",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			const shell = background.get(input.shell_id);
			if (!shell) {
				return { content: [textContent(`Unknown shell id: ${input.shell_id}`)], isError: true };
			}
			const output = background.output(input.shell_id);
			const statusLine =
				shell.status === "running"
					? `[${shell.id}: still running, ${Math.round((Date.now() - shell.startTime) / 1000)}s]`
					: `[${shell.id}: ${shell.status}, exit code ${shell.exitCode}]`;
			return {
				content: [textContent(`${statusLine}\n${output || "(no output yet)"}`)],
			};
		},
	});
}

export function createKillBashTool(background: BackgroundShellManager): AnyTool {
	return buildTool({
		name: "KillBash",
		description: "Terminates a running background shell (kills the whole process tree).",
		inputSchema: z.object({
			shell_id: z.string().describe("The background shell id to kill"),
		}),
		isConcurrencySafe: () => false,
		call: async (input) => {
			const killed = background.kill(input.shell_id);
			if (!killed) {
				return {
					content: [textContent(`Could not kill ${input.shell_id}: not found or not running.`)],
					isError: true,
				};
			}
			return { content: [textContent(`Killed ${input.shell_id}.`)] };
		},
	});
}
