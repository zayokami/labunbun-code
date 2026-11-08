/**
 * The Workflow tool: one call runs a JavaScript script whose `agent()` hooks
 * spawn subagents.
 *
 * The tool is the thin shell around `workflow-runner.ts` and
 * `workflow-script.ts` — argument resolution, the description the model picks
 * from, and a result that carries everything a person needs afterwards (what
 * ran, what was cached, and the run id to resume from). It deliberately does
 * not add a second meaning to any of the script hooks: the runner and the vm
 * are the implementation, and this file only points at them.
 *
 * The tool is not offered to subagents (the session tool list excludes it), so
 * a workflow cannot nest another workflow: resume accounting assumes one
 * journal per run, and a nested run would spend agents the outer budget never
 * sees.
 */
import { type AnyTool, buildTool } from "@labunbun/agent";
import type { Model } from "@labunbun/ai";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import {
	loadWorkflowDefinitions,
	type WorkflowDefinition,
	workflowCatalogue,
	workflowRunsRoot,
} from "./workflow-definitions.ts";
import { type RunWorkflowResult, runWorkflow, WorkflowRunError, type WorkflowSpawn } from "./workflow-runner.ts";
import {
	formatWorkflowError,
	MAX_WORKFLOW_AGENTS,
	MAX_WORKFLOW_ITEMS,
	parseWorkflowScript,
} from "./workflow-script.ts";
import type { WorkflowGit } from "./workflow-worktree.ts";

export interface WorkflowToolOptions {
	/** The session's working directory. */
	cwd: string;
	home?: string;
	/** The subagent fleet's spawn, adapted by the host. */
	spawn: WorkflowSpawn;
	/** Progress lines for the person watching (a status row, a transcript line). */
	report?: (text: string) => void;
	resolveModel?: (ref: string) => Model | undefined;
	/** Read at call time, so a project tier approved mid-session is usable. */
	definitions?: () => WorkflowDefinition[];
	runsRoot?: string;
	maxAgents?: number;
	concurrency?: number;
	now?: () => number;
	git?: WorkflowGit;
}

const workflowInputSchema = z.object({
	script: z.string().optional().describe("The workflow script (plain JavaScript, an async function body)"),
	name: z.string().optional().describe("A saved workflow's name, from the list in this tool's description"),
	resume_from: z
		.string()
		.optional()
		.describe("A [workflow run: ...] id to replay; reuses its saved script when no script or name is given"),
	args: z.unknown().optional().describe("The value the script sees as `args`; pass JSON, not a JSON-encoded string"),
	max_agents: z.number().int().positive().optional().describe("Cap this run's agent calls"),
	concurrency: z.number().int().positive().optional().describe("How many agents may run at once"),
});

function formatDuration(milliseconds: number): string {
	return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatValue(value: unknown): string {
	if (value === undefined) return "(the script returned no value)";
	if (typeof value === "string") return value;
	try {
		const text = JSON.stringify(value, null, 2);
		return text === undefined ? String(value) : text;
	} catch {
		return String(value);
	}
}

function messageOf(error: unknown): string {
	return formatWorkflowError(error);
}

/** The result text: the answer, then the counts, then how to resume. */
function formatResult(name: string, result: RunWorkflowResult): string {
	const counts =
		`${result.agentsRun + result.agentsCached + result.agentsFailed} agent calls` +
		` (${result.agentsRun} run, ${result.agentsCached} cached, ${result.agentsFailed} failed)`;
	const verb = result.resumed ? "resumed" : "completed";
	const lines = [`Workflow "${name}" ${verb} in ${formatDuration(result.durationMs)} — ${counts}.`];
	if (result.phases.length > 0) lines.push(`Phases: ${result.phases.join(" → ")}`);
	if (result.truncated) {
		lines.push("Note: the agent budget was reached; later agent() calls threw and the script saw the error.");
	}
	if (result.keptWorktrees.length > 0) {
		lines.push("Kept worktrees (their agents changed files):");
		for (const path of result.keptWorktrees) lines.push(`- ${path}`);
	}
	lines.push("", "Result:", formatValue(result.value));
	lines.push("", `[workflow run: ${result.runId}] Resume with resume_from: "${result.runId}".`);
	lines.push(`Run directory: ${result.dir}`);
	return lines.join("\n");
}

export function createWorkflowTool(options: WorkflowToolOptions): AnyTool {
	const home = options.home;
	const saved = options.definitions?.() ?? loadWorkflowDefinitions(options.cwd, home).workflows;
	const catalogue = saved.length === 0 ? "(no saved workflows)" : workflowCatalogue(saved);
	const description = [
		"Run a workflow: a JavaScript script that orchestrates subagents. Reach for it when the work has a",
		"shape worth encoding — fan out over many items, verify findings with independent passes, or run",
		"stages that do not need a barrier between them. The script is the control flow; the agents are",
		"the readers and writers.",
		"",
		"Script hooks (plain JavaScript, run as an async function body; `await` works at the top level):",
		"- agent(prompt, options?) → one subagent. Without a schema it resolves to the final text; with a",
		'  schema (a JSON Schema with type "object" at the root) it resolves to the validated object.',
		"  A failed call resolves to null, so filter with .filter(Boolean).",
		'  options: {label, phase, schema, model, effort, isolation: "worktree", agentType}',
		"- parallel(thunks) → a barrier: runs every thunk and waits for all. A failed thunk resolves to null.",
		"- pipeline(items, ...stages) → no barrier between stages; each stage is (previous, item, index).",
		"  A throwing stage drops that item to null and skips its remaining stages.",
		"- phase(title) groups later agents in the progress display; log(message) emits one progress line.",
		"- args is the call's args value; budget is {total, spent(), remaining()} (no target is wired).",
		"",
		`Limits: ${MAX_WORKFLOW_AGENTS} agent calls per run, ${MAX_WORKFLOW_ITEMS} items per parallel()/pipeline(),`,
		"concurrency min(16, cpus - 2). Date.now(), new Date() and Math.random() throw because they would",
		"break resume; pass timestamps through args. The script has no filesystem, process or network access.",
		"",
		"Saved workflows (pass as `name`):",
		catalogue,
		"",
		"Every result ends with a [workflow run: ...] id; pass it as resume_from to replay the run, reusing",
		"every call that succeeded. Pass a script inline or name a saved workflow — not both.",
	].join("\n");

	return buildTool({
		name: "Workflow",
		description,
		inputSchema: workflowInputSchema,
		prompt:
			"- Use a workflow when the work fans out or needs several independent passes; one self-contained question is a Task call.\n" +
			"- Subagents do not see this conversation: every prompt the script sends must stand alone.\n" +
			"- Prefer pipeline() over parallel() when a stage does not need all prior results.\n" +
			'- Use isolation: "worktree" only for agents that edit files in parallel; it costs a checkout per call.\n' +
			"- The result ends with a [workflow run: ...] line — resume_from takes it after a pause or a script edit.",
		isConcurrencySafe: () => true,
		call: async (input, toolCtx) => {
			if (input.script !== undefined && input.name !== undefined) {
				return {
					content: [textContent("Pass either a script or a saved workflow name, not both.")],
					isError: true,
				};
			}
			const definitions = options.definitions?.() ?? loadWorkflowDefinitions(toolCtx.cwd, home).workflows;
			let script = input.script;
			const name = input.name;
			if (name !== undefined) {
				const definition = definitions.find((candidate) => candidate.name === name);
				if (!definition) {
					const names = definitions.map((candidate) => candidate.name);
					return {
						content: [
							textContent(
								names.length === 0
									? `Unknown workflow "${name}". No saved workflows are available.`
									: `Unknown workflow "${name}". Saved workflows: ${names.join(", ")}.`,
							),
						],
						isError: true,
					};
				}
				script = definition.script;
			}
			if (script === undefined && input.resume_from === undefined) {
				return {
					content: [textContent("Pass a script, a saved workflow name, or a resume_from run id.")],
					isError: true,
				};
			}
			// A resume with neither a script nor a name leaves the name to the
			// journal: the run that is being replayed already has one.
			const runName = name ?? (script === undefined ? undefined : parseWorkflowScript(script).meta?.name);
			try {
				const result = await runWorkflow({
					cwd: toolCtx.cwd,
					runsRoot: options.runsRoot ?? workflowRunsRoot(home),
					script,
					resumeFrom: input.resume_from,
					args: input.args,
					name: runName,
					spawn: options.spawn,
					report: options.report,
					resolveModel: options.resolveModel,
					signal: toolCtx.signal,
					maxAgents: input.max_agents ?? options.maxAgents,
					concurrency: input.concurrency ?? options.concurrency,
					now: options.now,
					git: options.git,
				});
				return {
					content: [textContent(formatResult(result.name, result))],
					details: {
						runId: result.runId,
						dir: result.dir,
						agentsRun: result.agentsRun,
						agentsCached: result.agentsCached,
						agentsFailed: result.agentsFailed,
						phases: result.phases,
						keptWorktrees: result.keptWorktrees,
						truncated: result.truncated,
						resumed: result.resumed,
					},
				};
			} catch (error) {
				const resume =
					error instanceof WorkflowRunError ? `\nRun directory: ${error.dir} (resume_from: "${error.runId}")` : "";
				return {
					content: [textContent(`Workflow failed: ${messageOf(error)}${resume}`)],
					isError: true,
				};
			}
		},
	});
}
