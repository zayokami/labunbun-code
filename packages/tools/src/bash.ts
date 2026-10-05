import { type AnyTool, buildTool, formatSpillHeader } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import type { BackgroundShellManager } from "./background.ts";
import type { Operations } from "./operations.ts";
import { createTailBuffer } from "./output-capture.ts";
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

export function createBashTool(
	cwd: string,
	ops: Operations,
	background?: BackgroundShellManager,
	options?: { home?: string; tempDir?: string; writableRoots?: readonly string[]; spillDir?: string },
): AnyTool {
	return buildTool({
		name: "Bash",
		description:
			"Executes a shell command and returns stdout/stderr with the exit code. " +
			"Output streams live while the command runs. Commands run through a POSIX-compatible " +
			"shell when available (Git Bash on Windows), otherwise cmd.exe. " +
			"Use for git, builds, test runners, and other CLI work. " +
			"Very long output is cut to a head and a tail with a count of what is missing; the " +
			"full output is written to a file and the result's first line names its path. " +
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
				// The executor is the only party that sees every chunk, so it is the
				// one that keeps the output bounded — a window in memory and the whole
				// stream on disk. Absent (an embedder's own tool set), accumulation is
				// exactly what it always was and `overflow: "spill"` below is the only
				// bound.
				spillDir: options?.spillDir,
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
								// The background log opens with what had been captured, and a
								// bounded capture opens it with a notice — this is where the
								// rest of it lives.
								(result.spill ? `Output before the handoff: ${result.spill.path}\n` : "") +
								`Poll with BashOutput(shell_id="${adoptedId}"); stop with KillBash.`,
						),
					],
					details: { backgroundShellId: adoptedId },
				};
			}

			// Nothing is cut here. The executor bounded the capture — it is the only
			// party that saw every chunk — and a cut at this layer could only keep
			// what the conversation already had while dropping output no file holds:
			// `overflow: "spill"` above promises that what does not fit is written
			// out in full, and the pointer below is where this result said it went.
			//
			// Both streams over the bound at once puts two truncation notices in one
			// result, and the pipeline's cut reads only the first — so a further cut
			// would keep the first stream's count and let the second's go stale.
			// Accepted: the file holds every character either way, and a marker
			// format with ordinals is not worth the rare case that needs it.
			const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n--- stderr ---\n");
			// The pointer leads, and the verdict right behind it: a long result is
			// cut at both ends on its way into the conversation, and the two lines
			// that have to survive any cut are the path to the rest of the output
			// and whether the command worked. The pipeline's cut recognizes the
			// header and reuses the file the executor already wrote instead of
			// spilling a second copy of what is shown here regardless.
			const header = result.spill ? formatSpillHeader(result.spill.path, result.spill.chars) : "";
			const status = result.killed ? "[command timed out or was killed]\n" : "";
			const text = `${header}[exit code: ${result.exitCode}]\n${status}${output}`;
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
