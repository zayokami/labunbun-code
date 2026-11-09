/**
 * Environment pheromones: the board's record of what a command actually did.
 *
 * A worker does not report a test failure as prose. A Bash result already begins
 * with `[exit code: N]` (`bash.ts`) and a result too large for the conversation
 * already begins with a spill pointer (`output-limits.ts`), so the band's event
 * observer reads both facts for free and writes the structured trace onto the
 * task: a bounded `cutText` summary, the exit code, and when it happened.
 *
 * For a `build`/`verify` task the recorder also decides the verdict, because
 * nothing in a transcript can: once every declared command has a run, the
 * verdict is `passed` iff every latest run exited zero, and a pass closes the
 * task. This is the deterministic exception to "completion is a writer's fact"
 * that `docs/dev/blackboard.md` records; a failure only writes the verdict and
 * the error pheromone, leaving the task open for the worker to repair.
 *
 * Written as pure helpers plus a small recorder, the way `blackboard.ts` and
 * `task-nudges.ts` are, so every rule is testable without a provider.
 */
import { cutText } from "@labunbun/agent";
import type { ToolResultMessage } from "@labunbun/ai";
import type { AgentTask, TaskRun, TaskStore, TaskVerdict } from "@labunbun/tools";
import { DEFAULT_ERROR_SUMMARY_CHARS } from "./blackboard.ts";

/** How many runs a task keeps. Oldest go first; the verdict only reads the latest per command. */
export const DEFAULT_MAX_RUNS = 20;

/** The exit line Bash writes at the start of its result, after a possible spill header. */
const EXIT_CODE = /\[exit code: (-?\d+)\]/;

/** The tool whose results are evidence. Any other tool's input is not a command. */
const EVIDENCE_TOOL = "Bash";

/** The exit code a Bash result reports, or null when it carries none (a killed run). */
export function parseExitCode(text: string): number | null {
	const match = EXIT_CODE.exec(text);
	return match ? Number(match[1]) : null;
}

/** The text blocks of a result, joined the way the transcript reads them. */
export function resultText(result: Pick<ToolResultMessage, "content">): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** The command behind a tool call, when the call is shaped like a Bash call. */
export function commandOf(input: unknown): string | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const command = (input as { command?: unknown }).command;
	if (typeof command !== "string") return undefined;
	const trimmed = command.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** The newest run of each command, which is the one its verdict reads. */
export function latestRuns(runs: readonly TaskRun[]): Map<string, TaskRun> {
	const latest = new Map<string, TaskRun>();
	for (const run of runs) latest.set(run.command, run);
	return latest;
}

/**
 * The verdict the evidence supports, or undefined while it is not decided.
 *
 * Only a `build`/`verify` task with declared commands has one, and only once
 * every declared command has a run: a verdict on half the evidence would close
 * a task whose other half never ran. A run with no exit code — a killed command
 * — is not a zero, so it fails.
 */
export function decidedVerdict(
	task: Pick<AgentTask, "kind" | "commands">,
	runs: readonly TaskRun[],
): TaskVerdict | undefined {
	if (task.kind !== "build" && task.kind !== "verify") return undefined;
	const commands = (task.commands ?? []).map((command) => command.trim());
	if (commands.length === 0) return undefined;
	const latest = latestRuns(runs);
	const evidence = commands.map((command) => latest.get(command));
	if (evidence.some((run) => run === undefined)) return undefined;
	return evidence.every((run) => run?.exitCode === 0) ? "passed" : "failed";
}

export interface TaskPheromoneOptions {
	store: TaskStore;
	/** Bound on a run's summary; `beetle.errorSummaryChars`. */
	errorChars?: number;
	/** How many runs a task keeps; defaults to {@link DEFAULT_MAX_RUNS}. */
	maxRuns?: number;
	/** One line for the transcript when the evidence decides a verdict. */
	notice?: (line: string) => void;
}

/**
 * Watches Bash calls and records the declared ones on the caller's task.
 *
 * `begin` remembers the command per call id; `record` pairs the result with it.
 * Only a task's declared `commands` become evidence — a worker running `ls` has
 * changed nothing the board can check, and copying it would make every later
 * wake pay for noise. The store write bumps `rev`, which is how the worker (and
 * the dispatcher's continuation wake) learn that the environment said something.
 */
export class TaskPheromoneRecorder {
	readonly #options: TaskPheromoneOptions;
	readonly #started = new Map<string, string>();

	constructor(options: TaskPheromoneOptions) {
		this.#options = options;
	}

	/** Remember the command behind a started call. Anything but Bash is ignored. */
	begin(callId: string, toolName: string, input: unknown): void {
		if (toolName !== EVIDENCE_TOOL) return;
		const command = commandOf(input);
		if (command !== undefined) this.#started.set(callId, command);
	}

	/**
	 * Turn a finished call into evidence when its command is declared by the
	 * seat's current task. Returns the run it wrote, or undefined when the call
	 * was not evidence.
	 */
	record(
		seat: string,
		taskId: string | undefined,
		toolName: string,
		callId: string,
		result: Pick<ToolResultMessage, "content">,
	): TaskRun | undefined {
		const started = this.#started.get(callId);
		this.#started.delete(callId);
		if (toolName !== EVIDENCE_TOOL || started === undefined || taskId === undefined) return undefined;
		const task = this.#options.store.get(taskId);
		// A task that already closed is history; its runs must not bump `rev` and
		// wake a session the dispatcher has released.
		if (!task || task.status === "completed") return undefined;
		// Declared commands are matched after trimming, and the run records the
		// trimmed form, so a stray space on the board cannot make evidence the
		// verdict never sees.
		if (!task.commands?.some((command) => command.trim() === started)) return undefined;

		const text = resultText(result);
		const run: TaskRun = {
			command: started,
			exitCode: parseExitCode(text),
			summary: cutText(text, this.#options.errorChars ?? DEFAULT_ERROR_SUMMARY_CHARS),
			at: Date.now(),
			by: seat,
		};
		const runs = [...(task.runs ?? []), run];
		const maxRuns = this.#options.maxRuns ?? DEFAULT_MAX_RUNS;
		if (runs.length > maxRuns) runs.splice(0, runs.length - maxRuns);

		const patch: { runs: TaskRun[]; errorSummary?: string; verdict?: TaskVerdict; status?: "completed" } = { runs };
		// The summary is the latest failing run's cut, so a passing run leaves the
		// failure that explains the repair in place.
		if (run.exitCode !== 0) patch.errorSummary = run.summary;
		const verdict = decidedVerdict(task, runs);
		if (verdict === "passed") {
			patch.verdict = "passed";
			patch.status = "completed";
		} else if (verdict === "failed") {
			patch.verdict = "failed";
		}
		this.#options.store.update(task.id, patch);

		if (verdict !== undefined) {
			const label = `#${task.id} ${task.kind}`;
			this.#options.notice?.(
				verdict === "passed"
					? `[blackboard] ${label}: every declared command passed — the task closes itself.`
					: `[blackboard] ${label}: ${run.command} exited ${run.exitCode === null ? "without a code" : run.exitCode} — verdict failed.`,
			);
		}
		return run;
	}
}
