/**
 * One workflow run: a journal, a script, and the bridge between the script's
 * `agent()` calls and the subagent fleet.
 *
 * The journal is the spine. Before an agent is spawned, the call is keyed and
 * looked up; before its result reaches the script, it is written down. That is
 * what lets `resume_from` replay a run without paying for the calls that
 * already succeeded — and what makes an interrupted run legible afterwards.
 *
 * A worktree-isolated call is created, used, and cleaned up around that same
 * record. The cleanup runs on every exit path, and it keeps anything the agent
 * changed: a resumed run may want that work, and deleting it would be the one
 * mistake cleanup cannot make right.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, ThinkingLevel } from "@labunbun/ai";
import { hashWorkflowValue, WorkflowJournal, workflowCallKey } from "./workflow-journal.ts";
import {
	formatWorkflowError,
	runWorkflowScript,
	WorkflowAbortedError,
	type WorkflowAgentOutcome,
	type WorkflowAgentRequest,
	type WorkflowMeta,
} from "./workflow-script.ts";
import {
	createWorkflowWorktree,
	removeWorkflowWorktreeIfUnchanged,
	type WorkflowGit,
	type WorkflowWorktree,
} from "./workflow-worktree.ts";

function messageOf(error: unknown): string {
	return formatWorkflowError(error);
}

/**
 * What the runner asks of the subagent fleet. The tool adapts
 * `SubagentControl.spawn` to this shape so the runner is testable with a plain
 * function and does not depend on the tool registry.
 */
export interface WorkflowSpawnRequest {
	description: string;
	prompt: string;
	subagentType?: string;
	cwd: string;
	signal: AbortSignal;
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	outputSchema?: Record<string, unknown>;
}

export interface WorkflowSpawnResult {
	ok: boolean;
	/** The final report; the call's value when no schema was requested. */
	report?: string;
	structured?: unknown;
	structuredError?: string;
	reason?: string;
	error?: string;
}

export type WorkflowSpawn = (request: WorkflowSpawnRequest) => Promise<WorkflowSpawnResult>;

export interface RunWorkflowOptions {
	/** The session's working directory; a worktree is cut from its repository. */
	cwd: string;
	/** Directory holding one directory per run. */
	runsRoot: string;
	/** The script to run. Optional only when resuming, which reuses the saved copy. */
	script?: string;
	/** An earlier run to replay. */
	resumeFrom?: string;
	args?: unknown;
	/** The display name; defaults to the journal's name on resume. */
	name?: string;
	spawn: WorkflowSpawn;
	report?: (line: string) => void;
	resolveModel?: (ref: string) => Model | undefined;
	signal: AbortSignal;
	maxAgents?: number;
	concurrency?: number;
	timeoutMs?: number;
	now?: () => number;
	git?: WorkflowGit;
}

export interface RunWorkflowResult {
	runId: string;
	name: string;
	dir: string;
	value: unknown;
	meta: WorkflowMeta | null;
	agentsRun: number;
	agentsCached: number;
	agentsFailed: number;
	logs: string[];
	phases: string[];
	truncated: boolean;
	/** Worktrees kept because they changed; their paths are the report. */
	keptWorktrees: string[];
	resumed: boolean;
	durationMs: number;
}

/** A run that got far enough to have a directory, so its failure can be inspected. */
export class WorkflowRunError extends Error {
	readonly runId: string;
	readonly dir: string;

	constructor(message: string, runId: string, dir: string) {
		super(message);
		this.name = "WorkflowRunError";
		this.runId = runId;
		this.dir = dir;
	}
}

/**
 * Replace the journal's saved script when resuming from an edited one. The
 * original stays as `script.js` — a resume that overwrote the record of what
 * ran would defeat the point of having one.
 */
function saveResumedScript(journal: WorkflowJournal, script: string): void {
	if (!journal.resumed || script === journal.script) return;
	writeFileSync(join(journal.dir, "script.resume.js"), script, "utf8");
	journal.appendLog("resumed with an edited script (script.resume.js)");
}

/**
 * Record the args a resume was given, when they differ from the saved ones.
 *
 * `args.json` is the original invocation's record, and a resume without args
 * replays it — that is what resuming means. A resume with different args is a
 * different work order against the same script, so the new value is kept beside
 * the original (the same shape as `script.resume.js`) instead of overwriting
 * the record or being dropped after the run.
 */
function saveResumedArgs(journal: WorkflowJournal, args: unknown): void {
	if (!journal.resumed || args === undefined) return;
	if (hashWorkflowValue(args) === journal.meta.argsHash) return;
	writeFileSync(join(journal.dir, "args.resume.json"), `${JSON.stringify(args, null, 2)}\n`, "utf8");
	journal.appendLog("resumed with different args (args.resume.json)");
}

export async function runWorkflow(options: RunWorkflowOptions): Promise<RunWorkflowResult> {
	const now = options.now ?? Date.now;
	const startedAt = now();
	const signal = options.signal;

	if (!options.script && !options.resumeFrom) throw new Error("A workflow needs a script or a run to resume");
	const journal = options.resumeFrom
		? WorkflowJournal.open({ root: options.runsRoot, runId: options.resumeFrom, now })
		: WorkflowJournal.create({
				root: options.runsRoot,
				name: options.name ?? "workflow",
				script: options.script ?? "",
				args: options.args,
				now,
			});
	const name = options.name ?? journal.meta.name;
	const script = options.script ?? journal.script;
	saveResumedScript(journal, script);
	saveResumedArgs(journal, options.args);

	const report = (line: string) => {
		journal.appendLog(line);
		options.report?.(`[workflow ${name}] ${line}`);
	};

	let agentsRun = 0;
	let agentsCached = 0;
	let agentsFailed = 0;
	let agentIndex = 0;
	const keptWorktrees: string[] = [];
	const counts = () => ({ run: agentsRun, cached: agentsCached, failed: agentsFailed });

	const agentFn = async (request: WorkflowAgentRequest, callSignal: AbortSignal): Promise<WorkflowAgentOutcome> => {
		const key = journal.nextKey(
			workflowCallKey({
				prompt: request.prompt,
				schema: request.schema,
				model: request.model,
				effort: request.effort,
				agentType: request.agentType,
				isolation: request.isolation,
			}),
		);
		const cached = journal.lookup(key);
		if (cached?.status === "ok") {
			agentsCached++;
			return { ok: true, cached: true, value: cached.result };
		}
		if (signal.aborted || callSignal.aborted) return { ok: false, error: "Workflow aborted" };

		agentIndex++;
		const label = request.label;
		let callCwd = options.cwd;
		let worktree: WorkflowWorktree | undefined;
		if (request.isolation === "worktree") {
			try {
				worktree = await createWorkflowWorktree({
					cwd: options.cwd,
					dest: join(journal.worktreesDir, `agent-${agentIndex}`),
					git: options.git,
				});
				callCwd = worktree.path;
			} catch (error) {
				const message = messageOf(error);
				agentsFailed++;
				journal.record({ key, label, phase: request.phase, status: "error", error: message });
				return { ok: false, error: message };
			}
		}

		let model: Model | undefined;
		if (request.model) {
			model = options.resolveModel?.(request.model);
			if (!model) {
				const message = `Unknown model "${request.model}"`;
				agentsFailed++;
				journal.record({ key, label, phase: request.phase, status: "error", error: message });
				if (worktree) await releaseWorktree(worktree, options.git, keptWorktrees, report);
				return { ok: false, error: message };
			}
		}

		const started = now();
		try {
			const outcome = await options.spawn({
				description: label,
				prompt: request.prompt,
				subagentType: request.agentType,
				cwd: callCwd,
				signal: callSignal,
				model,
				thinkingLevel: request.effort,
				outputSchema: request.schema,
			});
			const durationMs = now() - started;
			if (!outcome.ok) {
				const error = outcome.structuredError ?? outcome.error ?? `subagent ended: ${outcome.reason ?? "error"}`;
				agentsFailed++;
				journal.record({
					key,
					label,
					phase: request.phase,
					status: "error",
					error,
					durationMs,
					worktree: worktree?.path,
				});
				return { ok: false, error };
			}
			const value = request.schema ? outcome.structured : outcome.report;
			journal.record({
				key,
				label,
				phase: request.phase,
				status: "ok",
				resultKind: request.schema ? "json" : "text",
				result: value,
				durationMs,
				worktree: worktree?.path,
			});
			agentsRun++;
			return { ok: true, value };
		} catch (error) {
			const message = messageOf(error);
			agentsFailed++;
			journal.record({ key, label, phase: request.phase, status: "error", error: message, worktree: worktree?.path });
			return { ok: false, error: message };
		} finally {
			if (worktree) await releaseWorktree(worktree, options.git, keptWorktrees, report);
		}
	};

	let scriptResult: Awaited<ReturnType<typeof runWorkflowScript>>;
	try {
		scriptResult = await runWorkflowScript({
			script,
			args: options.args !== undefined ? options.args : journal.args,
			agent: agentFn,
			signal,
			maxAgents: options.maxAgents,
			concurrency: options.concurrency,
			report,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		journal.finish(signal.aborted ? "aborted" : "failed", counts());
		if (error instanceof WorkflowAbortedError || signal.aborted) throw new WorkflowAbortedError();
		throw new WorkflowRunError(messageOf(error), journal.runId, journal.dir);
	}

	journal.finish("completed", counts());
	return {
		runId: journal.runId,
		name,
		dir: journal.dir,
		value: scriptResult.value,
		meta: scriptResult.meta,
		agentsRun,
		agentsCached,
		agentsFailed,
		logs: scriptResult.logs,
		phases: scriptResult.phases,
		truncated: scriptResult.truncated,
		keptWorktrees,
		resumed: journal.resumed,
		durationMs: now() - startedAt,
	};
}

/** Remove an unchanged worktree, or report the one that has work in it. */
async function releaseWorktree(
	worktree: WorkflowWorktree,
	git: WorkflowGit | undefined,
	kept: string[],
	report: (line: string) => void,
): Promise<void> {
	let removed = false;
	try {
		removed = await removeWorkflowWorktreeIfUnchanged(worktree, git);
	} catch {
		removed = false;
	}
	if (removed) return;
	kept.push(worktree.path);
	report(`kept worktree: ${worktree.path}`);
}
