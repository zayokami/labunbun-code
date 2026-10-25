import { type AnyTool, buildSandboxPolicy, buildTool, formatSpillHeader } from "@labunbun/agent";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import type { BackgroundShellManager } from "./background.ts";
import type { Operations } from "./operations.ts";
import { createTailBuffer } from "./output-capture.ts";
import { resolveWritableRoots } from "./sandbox/default-writable-roots.ts";
import { workspacePolicy } from "./sandbox/workspace-policy.ts";
import { likelySandboxDenied } from "./sandbox-denial.ts";
import { type ShellKind, shellKindOf } from "./shell-kind.ts";

/** How much output the live preview keeps — the tail of it, and not the result. */
const MAX_PREVIEW_CHARS = 30_000;

// Long-form design notes: docs/dev/tools.md
/** How often a running command may push its output to the UI. */
export const BASH_UPDATE_INTERVAL_MS = 100;

/**
 * What the model is told the shell is, in the syntax that shell actually
 * parses. The tool keeps the name `Bash` on the wire, so the description is
 * the only place that can correct a model's assumption about the grammar.
 */
function shellGuidance(shell: { command: string; kind?: ShellKind } | undefined): {
	clause: string;
	lines: string;
} {
	const kind =
		shell === undefined
			? process.platform === "win32"
				? "powershell"
				: "bash"
			: (shell.kind ?? shellKindOf(shell.command));
	if (kind === "powershell") {
		const flavor = (shell?.command ?? "").toLowerCase().endsWith("pwsh.exe") ? "PowerShell 7" : "Windows PowerShell";
		return {
			clause: `Commands run through ${flavor}; write PowerShell syntax. `,
			lines:
				"- Commands run in PowerShell. Separate statements with ';'. On Windows PowerShell 5.1 '&&' and '||' do not exist; use ';' and test $?, or point LBB_SHELL_PATH at pwsh.exe for PowerShell 7.\n" +
				"- Quote paths that contain spaces. A native program's own exit code is returned as the tool's exit code.\n",
		};
	}
	if (kind === "cmd") {
		return {
			clause: "Commands run through cmd.exe; write cmd syntax. ",
			lines: "- Chain dependent steps with && ; avoid interactive commands.\n",
		};
	}
	return {
		clause: "Commands run through a POSIX-compatible shell (Git Bash on Windows); write POSIX shell syntax. ",
		lines: "- Chain dependent steps with && ; avoid interactive commands.\n",
	};
}

export function createBashTool(
	cwd: string,
	ops: Operations,
	background?: BackgroundShellManager,
	options?: {
		home?: string;
		tempDir?: string;
		writableRoots?: readonly string[];
		spillDir?: string;
		/** The shell `ops` runs; its grammar shapes the description and prompt. */
		shell?: { command: string; kind?: ShellKind };
	},
): AnyTool {
	const guidance = shellGuidance(options?.shell);
	return buildTool({
		name: "Bash",
		description:
			"Executes a shell command and returns stdout/stderr with the exit code. " +
			"Output streams live while the command runs. " +
			guidance.clause +
			"Use for git, builds, test runners, and other CLI work. " +
			"Very long output is cut to a head and a tail with a count of what is missing; the " +
			"full output is written to a file and the result's first line names its path. " +
			"Set run_in_background for long-running processes (dev servers, watchers) — you get a " +
			"shell id immediately, read progress with BashOutput, and are told when it finishes. " +
			"A foreground command that hits its timeout is moved to the background, not killed. " +
			"Set escalate, with a justification, only when the command cannot work inside the sandbox: " +
			"the user approves each escalated call before it runs outside the sandbox.",
		inputSchema: z.object({
			command: z.string().describe("The shell command to run"),
			timeout: z
				.number()
				.int()
				.min(1)
				// The ceiling is the background lifetime's; a foreground call is
				// clamped to its own 600000 below, so one schema field can serve
				// both modes without a conditional that only some callers obey.
				.max(7_200_000)
				.optional()
				.describe(
					"Timeout in ms. Foreground: how long to wait before the command moves to the background " +
						"(default 120000, max 600000). run_in_background: the shell's lifetime " +
						"(default 1800000, max 7200000).",
				),
			description: z.string().optional().describe("One-line description of what this does"),
			run_in_background: z.boolean().optional().describe("Start without waiting; poll via BashOutput"),
			escalate: z
				.boolean()
				.optional()
				.describe(
					"Run this one command outside the sandbox. The user approves each escalated call before it runs; " +
						"the deny rules and the dangerous-command classifier still apply. Use only when the command cannot work inside the sandbox.",
				),
			justification: z
				.string()
				.optional()
				.describe(
					"Required with escalate: one sentence on why the command cannot run inside the sandbox. The user reads it in the approval dialog.",
				),
		}),
		prompt:
			"- Prefer dedicated tools over shell where they exist (Read/Grep/Glob instead of cat/grep/find).\n" +
			guidance.lines +
			"- Provide a short `description` so the user can follow along.\n" +
			"- Escalate only when a command cannot work inside the sandbox, and say why in justification; the user is asked on each escalated call.\n" +
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
			// An escalated call is checked here as well as in the permission engine, so a call that could not have
			// been approved (a background run, or no reason given) fails before any process starts.
			const escalated = input.escalate === true;
			if (escalated && input.run_in_background) {
				return {
					content: [
						textContent("An escalated command runs in the foreground: it cannot also start in the background."),
					],
					isError: true,
				};
			}
			if (escalated && (input.justification ?? "").trim() === "") {
				return {
					content: [
						textContent(
							"An escalated command needs a justification: say in one sentence why it cannot run inside the sandbox.",
						),
					],
					isError: true,
				};
			}
			const policy = await workspacePolicy(cwd, {
				sandbox: ctx.sandbox,
				network: ctx.network,
				// The policy needs the per-user roots, and `home`/`tempDir` are
				// arguments and not reads of the process.
				// Long-form design notes: docs/dev/tools.md
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
				// Caught here rather than left to reject the tool call, for the
				// same reason the branch above returns instead of throwing: an
				// unavailable path is an answer the model reads, not an
				// exception it cannot see. `start` refuses in the same voice
				// when it must — a shell the container cannot execute, a grant
				// that could not be established — and the message names the
				// constraint rather than the mechanism.
				try {
					const shell = await background.start(input.command, cwd, policy, input.timeout);
					return {
						content: [
							textContent(
								`Started in background as ${shell.id}.\nCommand: ${input.command}\nOutput file: ${shell.outputFile}\nPoll with BashOutput(shell_id="${shell.id}"); stop with KillBash.`,
							),
						],
						details: { backgroundShellId: shell.id },
					};
				} catch (error) {
					return {
						content: [textContent(String(error))],
						isError: true,
					};
				}
			}

			// The schema admits the background ceiling so one field can name a
			// lifetime; a foreground wait stays at its own documented maximum.
			const timeoutMs = Math.min(input.timeout ?? 120_000, 600_000);
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
				sandbox: escalated ? buildSandboxPolicy({ sandbox: "danger-full-access", workspace: cwd }) : policy,
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

			// Nothing is cut here: the executor bounded the capture, and the
			// pipeline's own cut reuses its spill file.
			// Long-form design notes: docs/dev/tools.md
			const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n--- stderr ---\n");
			// The pointer leads, and the verdict right behind it: a long result is
			// cut at both ends on its way into the conversation, and the two lines
			// that have to survive any cut are the path to the rest of the output
			// and whether the command worked. The pipeline's cut recognizes the
			// header and reuses the file the executor already wrote instead of
			// spilling a second copy of what is shown here regardless.
			const header = result.spill ? formatSpillHeader(result.spill.path, result.spill.chars) : "";
			// The hedge line, right after the verdict: a nonzero exit that reads
			// like a kernel refusal under a backend that really holds one gets
			// the axes named once, because a sandbox's refusals speak in errno
			// and the user is the only party who knows whether this command
			// should have worked. A label, not a decision — `isError` stays
			// whatever the exit code said, and a timed-out run keeps its own
			// story without a second one.
			const denied =
				!result.killed && likelySandboxDenied(result, result.sandboxBackend)
					? `[sandbox] This may be the sandbox refusing an operation, not the command failing — filesystem axis "${policy.fileSystem.kind}", network axis "${policy.network}". /permissions shows the policy; /mode can turn the sandbox off if this is the refusal.\n`
					: "";
			const status = result.killed ? "[command timed out or was killed]\n" : "";
			const escalation = escalated
				? `[ran outside the sandbox, on the user's approval: ${input.justification?.trim() ?? ""}]\n`
				: "";
			const text = `${header}[exit code: ${result.exitCode}]\n${escalation}${denied}${status}${output}`;
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
