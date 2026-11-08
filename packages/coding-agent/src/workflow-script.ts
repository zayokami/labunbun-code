/**
 * The workflow script runner: one async function body, a handful of hooks, and
 * a sandbox with no way out.
 *
 * The script is JavaScript, evaluated in a fresh `node:vm` context whose only
 * globals are the hooks below. There is no `process`, no `require`, no
 * `fetch`, and no filesystem — a workflow orchestrates agents, and everything
 * else is the agents' job. Two built-ins are deliberately broken:
 *
 * - `Date` and `Math.random()` throw. Resume depends on the script replaying
 *   the same calls in the same order, and a script that calls either would make
 *   the second run a different run. Timestamps belong in `args` or the result.
 *
 * `agent()` resolves errors to `null` instead of rejecting, so a failed call
 * drops out of a `.filter(Boolean)` rather than taking the whole script down.
 * `parallel()` and `pipeline()` follow the same rule per item. A stage that
 * throws is reported, not hidden: the harness² lesson that a missing result is
 * never evidence of success.
 */
import { availableParallelism } from "node:os";
import vm from "node:vm";
import { THINKING_LEVELS, type ThinkingLevel } from "@labunbun/ai";
import { checkWorkflowSchemaShape, type WorkflowJsonSchema } from "./workflow-schema.ts";

/** A runaway-loop backstop set far above any real workflow. */
export const MAX_WORKFLOW_AGENTS = 1000;
/** The largest list one `parallel()` or `pipeline()` call accepts. */
export const MAX_WORKFLOW_ITEMS = 4096;
/** How the synchronous part of a script may run before the vm cuts it off. */
export const WORKFLOW_SYNC_TIMEOUT_MS = 5000;

/** Concurrent agents: enough to use a laptop without starving it. */
export function workflowConcurrency(): number {
	return Math.max(1, Math.min(16, availableParallelism() - 2));
}

export class WorkflowAbortedError extends Error {
	constructor() {
		super("Workflow aborted");
		this.name = "WorkflowAbortedError";
	}
}

export interface WorkflowMeta {
	name?: string;
	description?: string;
	whenToUse?: string;
}

export interface WorkflowAgentRequest {
	prompt: string;
	label: string;
	phase?: string;
	schema?: WorkflowJsonSchema;
	model?: string;
	effort?: ThinkingLevel;
	agentType?: string;
	isolation?: "worktree";
}

export interface WorkflowAgentOutcome {
	ok: boolean;
	value?: unknown;
	cached?: boolean;
	error?: string;
}

export type WorkflowAgentFn = (request: WorkflowAgentRequest, signal: AbortSignal) => Promise<WorkflowAgentOutcome>;

export interface RunWorkflowScriptOptions {
	script: string;
	args?: unknown;
	agent: WorkflowAgentFn;
	signal: AbortSignal;
	maxAgents?: number;
	concurrency?: number;
	/** Progress lines, one call per line; the caller prefixes the run's name. */
	report?: (line: string) => void;
	timeoutMs?: number;
}

export interface WorkflowScriptResult {
	value: unknown;
	meta: WorkflowMeta | null;
	agentsRun: number;
	agentsCached: number;
	agentsFailed: number;
	logs: string[];
	phases: string[];
	truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An error's sentence, including one thrown inside the vm: a value from another
 * realm is not `instanceof Error` here, but it is still an error with a message,
 * and reading it keeps the script's own words instead of `Error: <words>`.
 */
export function formatWorkflowError(error: unknown): string {
	if (error !== null && typeof error === "object" && "message" in error) {
		const message = (error as { message: unknown }).message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

function messageOf(error: unknown): string {
	return formatWorkflowError(error);
}

/** Replace a source range with spaces, keeping newlines so line numbers stay put. */
function maskRange(script: string, start: number, end: number): string {
	const masked = script.slice(start, end).replace(/[^\n]/g, " ");
	return script.slice(0, start) + masked + script.slice(end);
}

interface MetaLiteral {
	start: number;
	end: number;
	literal: string;
}

/**
 * Blank out everything that is not code — comments, string literals and
 * template literals — keeping newlines so every index still points at the same
 * place in the original script. The meta declaration and the `export` guard are
 * statements, so a mention of either inside a comment or a string must not be
 * mistaken for one.
 */
function maskNonCode(script: string): string {
	let out = "";
	let mode: "code" | "'" | '"' | "`" | "line" | "block" = "code";
	for (let index = 0; index < script.length; index++) {
		const char = script[index];
		const next = script[index + 1];
		if (mode === "code") {
			if (char === "/" && next === "/") {
				mode = "line";
				out += "  ";
				index++;
				continue;
			}
			if (char === "/" && next === "*") {
				mode = "block";
				out += "  ";
				index++;
				continue;
			}
			if (char === "'" || char === '"' || char === "`") {
				mode = char;
				out += " ";
				continue;
			}
			out += char;
			continue;
		}
		if (mode === "line") {
			if (char === "\n") {
				mode = "code";
				out += "\n";
			} else out += " ";
			continue;
		}
		if (mode === "block") {
			if (char === "*" && next === "/") {
				mode = "code";
				out += "  ";
				index++;
				continue;
			}
			out += char === "\n" ? "\n" : " ";
			continue;
		}
		// Inside a string or template: keep the length and the newlines, drop the text.
		if (char === "\\") {
			out += "  ";
			index++;
			continue;
		}
		if (char === mode) mode = "code";
		out += char === "\n" ? "\n" : " ";
	}
	return out;
}

/** Find `export const meta = <object literal>` and the extent of the statement. */
function findMetaLiteral(script: string): MetaLiteral | undefined {
	const code = maskNonCode(script);
	const declaration = /(^|\n)([ \t]*)export\s+const\s+meta\s*=\s*/g.exec(code);
	if (!declaration) return undefined;
	const start = declaration.index + declaration[1].length;
	let index = declaration.index + declaration[0].length;
	while (index < script.length && /\s/.test(code[index])) index++;
	if (code[index] !== "{") return undefined;
	const literalStart = index;
	let depth = 0;
	let mode: "code" | "'" | '"' | "`" | "line" | "block" = "code";
	for (; index < script.length; index++) {
		const char = script[index];
		const next = script[index + 1];
		if (mode === "line") {
			if (char === "\n") mode = "code";
			continue;
		}
		if (mode === "block") {
			if (char === "*" && next === "/") {
				mode = "code";
				index++;
			}
			continue;
		}
		if (mode === "'" || mode === '"' || mode === "`") {
			if (char === "\\") {
				index++;
				continue;
			}
			if (char === mode) mode = "code";
			continue;
		}
		if (char === "/" && next === "/") {
			mode = "line";
			index++;
			continue;
		}
		if (char === "/" && next === "*") {
			mode = "block";
			index++;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			mode = char;
			continue;
		}
		if (char === "{") {
			depth++;
			continue;
		}
		if (char === "}") {
			depth--;
			if (depth === 0) return { start, end: index + 1, literal: script.slice(literalStart, index + 1) };
		}
	}
	return undefined;
}

function evaluateMeta(literal: string): WorkflowMeta {
	const context = vm.createContext({});
	let value: unknown;
	try {
		value = vm.runInContext(`(${literal})`, context, { timeout: 1000 });
	} catch (error) {
		throw new Error(`meta must be a pure object literal (${messageOf(error)})`);
	}
	if (!isRecord(value)) throw new Error("meta must be an object literal");
	const meta: WorkflowMeta = {};
	for (const key of ["name", "description", "whenToUse"] as const) {
		const field = value[key];
		if (field === undefined) continue;
		if (typeof field !== "string") throw new Error(`meta.${key} must be a string`);
		meta[key] = field;
	}
	return meta;
}

export interface ParsedWorkflowScript {
	/** The script body with the meta statement blanked out. */
	body: string;
	meta: WorkflowMeta | null;
	error?: string;
}

/**
 * Split a saved workflow script into its meta and its body. The meta is data,
 * not code: it is evaluated in its own empty context so a saved definition can
 * be described without running the workflow it describes.
 */
export function parseWorkflowScript(script: string): ParsedWorkflowScript {
	const found = findMetaLiteral(script);
	let meta: WorkflowMeta | null = null;
	let body = script;
	if (found) {
		try {
			meta = evaluateMeta(found.literal);
		} catch (error) {
			return { body: script, meta: null, error: `Invalid workflow meta: ${messageOf(error)}` };
		}
		body = maskRange(script, found.start, found.end);
	}
	if (/(^|\n)\s*export\s+/.test(maskNonCode(body))) {
		return { body, meta, error: "workflow scripts run as a function body; only `export const meta` is supported" };
	}
	return { body, meta };
}

/** Render one `log()` or `console.log()` argument for the progress display. */
function renderLogValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	try {
		const text = JSON.stringify(value);
		if (text !== undefined) return text;
	} catch {
		// Fall through to String.
	}
	return String(value);
}

/**
 * A counting gate: `size` holders run at once, the rest wait in order. Waiting
 * is abort-aware — a queued call must not keep the run alive after the user
 * interrupts.
 */
class Gate {
	#free: number;
	#waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal: AbortSignal }> = [];

	constructor(size: number) {
		this.#free = size;
	}

	async acquire(signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw new WorkflowAbortedError();
		if (this.#free > 0) {
			this.#free--;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const waiter = { resolve, reject, signal };
			const onAbort = () => {
				const at = this.#waiters.indexOf(waiter);
				if (at >= 0) this.#waiters.splice(at, 1);
				reject(new WorkflowAbortedError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#waiters.push({
				resolve: () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				},
				reject: (error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
				signal,
			});
		});
	}

	release(): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve();
		else this.#free++;
	}
}

/** Run a workflow script to completion. Throws when the script itself throws. */
export async function runWorkflowScript(options: RunWorkflowScriptOptions): Promise<WorkflowScriptResult> {
	const parsed = parseWorkflowScript(options.script);
	if (parsed.error) throw new Error(parsed.error);
	const signal = options.signal;
	const logs: string[] = [];
	const phases: string[] = [];
	const report = (line: string) => options.report?.(line);
	const maxAgents = Math.max(1, Math.min(options.maxAgents ?? MAX_WORKFLOW_AGENTS, MAX_WORKFLOW_AGENTS));
	const concurrency = Math.max(1, options.concurrency ?? workflowConcurrency());
	// One gate for every agent in the run, not one per parallel() call: nested
	// parallel/pipeline stages must share the same cap, or 10 outer items each
	// fanning out 10 ways would spawn 100 at once. The gate wraps the agent call
	// itself, never a stage, so a stage waiting on nested calls holds no permit
	// and cannot deadlock against them.
	const gate = new Gate(concurrency);

	let agentsStarted = 0;
	let agentsRun = 0;
	let agentsCached = 0;
	let agentsFailed = 0;
	let truncated = false;
	let currentPhase: string | undefined;

	const log = (value: unknown) => {
		const text = renderLogValue(value);
		logs.push(text);
		for (const line of text.split("\n")) report(line);
	};

	const phase = (title: unknown) => {
		if (typeof title !== "string" || title.trim() === "") throw new Error("phase(title) needs a non-empty string");
		currentPhase = title.trim();
		if (!phases.includes(currentPhase)) phases.push(currentPhase);
		report(`▸ phase: ${currentPhase}`);
	};

	const agent = async (prompt: unknown, rawOptions?: unknown): Promise<unknown> => {
		if (typeof prompt !== "string" || prompt.trim() === "") {
			throw new Error("agent(prompt): prompt must be a non-empty string");
		}
		if (signal.aborted) throw new WorkflowAbortedError();
		if (rawOptions !== undefined && rawOptions !== null && !isRecord(rawOptions)) {
			throw new Error("agent(prompt, options): options must be an object");
		}
		const callOptions = (rawOptions ?? {}) as Record<string, unknown>;
		let schema: WorkflowJsonSchema | undefined;
		if (callOptions.schema !== undefined) {
			if (!isRecord(callOptions.schema)) throw new Error("agent(): schema must be a JSON Schema object");
			const shapeError = checkWorkflowSchemaShape(callOptions.schema);
			if (shapeError) throw new Error(`agent(): ${shapeError}`);
			schema = callOptions.schema;
		}
		const effort = callOptions.effort;
		if (
			effort !== undefined &&
			!(typeof effort === "string" && (THINKING_LEVELS as readonly string[]).includes(effort))
		) {
			throw new Error(`agent(): effort must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		const model = callOptions.model;
		if (model !== undefined && (typeof model !== "string" || model.trim() === "")) {
			throw new Error("agent(): model must be a model reference string");
		}
		const agentType = callOptions.agentType;
		if (agentType !== undefined && (typeof agentType !== "string" || agentType.trim() === "")) {
			throw new Error("agent(): agentType must be an agent definition name");
		}
		const isolation = callOptions.isolation;
		if (isolation !== undefined && isolation !== "worktree") {
			throw new Error('agent(): isolation must be "worktree"');
		}
		const labelValue = callOptions.label;
		const label =
			typeof labelValue === "string" && labelValue.trim() !== "" ? labelValue.trim() : `agent ${agentsStarted + 1}`;
		const callPhase =
			typeof callOptions.phase === "string" && callOptions.phase.trim() !== ""
				? callOptions.phase.trim()
				: currentPhase;
		if (agentsStarted >= maxAgents) {
			truncated = true;
			report(`! agent budget reached (${maxAgents}); refusing "${label}"`);
			throw new Error(`Workflow agent budget reached (${maxAgents} agents); this call was refused.`);
		}
		agentsStarted++;
		report(`· ${label}${callPhase ? ` [${callPhase}]` : ""}`);
		let outcome: WorkflowAgentOutcome;
		await gate.acquire(signal);
		try {
			outcome = await options.agent(
				{
					prompt,
					label,
					phase: callPhase,
					schema,
					model: model as string | undefined,
					effort: effort as ThinkingLevel | undefined,
					agentType: agentType as string | undefined,
					isolation: isolation === "worktree" ? "worktree" : undefined,
				},
				signal,
			);
		} finally {
			gate.release();
		}
		if (outcome.ok) {
			if (outcome.cached) agentsCached++;
			else agentsRun++;
			report(`✓ ${label}${outcome.cached ? " (cached)" : ""}`);
			return outcome.value;
		}
		agentsFailed++;
		report(`✗ ${label}: ${outcome.error ?? "failed"}`);
		return null;
	};

	const parallel = async (thunks: unknown): Promise<unknown[]> => {
		if (!Array.isArray(thunks)) throw new Error("parallel(thunks) expects an array of functions");
		if (thunks.length > MAX_WORKFLOW_ITEMS) {
			throw new Error(`parallel() accepts at most ${MAX_WORKFLOW_ITEMS} thunks; received ${thunks.length}`);
		}
		return Promise.all(
			thunks.map((thunk, index) =>
				(async () => {
					if (typeof thunk !== "function") {
						report(`✗ parallel item ${index} is not a function`);
						return null;
					}
					if (signal.aborted) return null;
					try {
						return await (thunk as () => unknown)();
					} catch (error) {
						report(`✗ parallel item ${index}: ${messageOf(error)}`);
						return null;
					}
				})(),
			),
		);
	};

	const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
		if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) expects an array");
		if (items.length > MAX_WORKFLOW_ITEMS) {
			throw new Error(`pipeline() accepts at most ${MAX_WORKFLOW_ITEMS} items; received ${items.length}`);
		}
		for (const stage of stages) {
			if (typeof stage !== "function") throw new Error("pipeline() stages must be functions");
		}
		if (stages.length === 0) return [...items];
		return Promise.all(
			items.map((item, index) =>
				(async () => {
					let value: unknown;
					for (const stage of stages) {
						if (signal.aborted) return null;
						try {
							value = await (stage as (prev: unknown, original: unknown, at: number) => unknown)(value, item, index);
						} catch (error) {
							report(`✗ pipeline item ${index}: ${messageOf(error)}`);
							return null;
						}
					}
					return value;
				})(),
			),
		);
	};

	// A plain function, not an arrow: `new Date()` must reach the refusal below,
	// and an arrow is not constructible — it would fail as "not a constructor"
	// instead of saying why the clock is gone.
	const forbiddenClock = (name: string) =>
		function forbidden(): never {
			throw new Error(
				`${name} is not available in a workflow script: it would break resume. Pass timestamps through args instead.`,
			);
		};
	// Object.create keeps every Math method while replacing only the one that
	// would make two runs differ.
	const mathStub = Object.create(Math) as Math;
	Object.defineProperty(mathStub, "random", { value: forbiddenClock("Math.random()") });
	const dateStub = Object.assign(forbiddenClock("Date"), {
		now: forbiddenClock("Date.now()"),
		parse: Date.parse,
		UTC: Date.UTC,
	});
	const consoleStub = {
		log,
		info: log,
		warn: log,
		error: log,
		debug: log,
	};
	const budget = {
		total: null as number | null,
		spent: () => 0,
		remaining: () => Number.POSITIVE_INFINITY,
	};

	const sandbox: Record<string, unknown> = {
		agent,
		parallel,
		pipeline,
		log,
		phase,
		args: options.args,
		budget,
		console: consoleStub,
		Math: mathStub,
		Date: dateStub,
	};
	const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
	const body = `(async () => {\n${parsed.body}\n})()`;
	const compiled = new vm.Script(body, { filename: "workflow.js" });
	const promise = compiled.runInContext(context, { timeout: options.timeoutMs ?? WORKFLOW_SYNC_TIMEOUT_MS });
	let value: unknown;
	let onAbort: (() => void) | undefined;
	// Race the script with the cancel rather than checking after it: a script
	// awaiting something that never settles would otherwise hold the run open
	// long after the user stopped it. The script cannot be unwound, but the run
	// can stop waiting for it — and every `agent()` call it makes afterwards
	// refuses on the aborted signal.
	const aborted = new Promise<never>((_resolve, reject) => {
		if (signal.aborted) {
			reject(new WorkflowAbortedError());
			return;
		}
		onAbort = () => reject(new WorkflowAbortedError());
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		value = await Promise.race([promise as Promise<unknown>, aborted]);
	} catch (error) {
		if (signal.aborted) throw new WorkflowAbortedError();
		throw error;
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
	if (signal.aborted) throw new WorkflowAbortedError();
	return {
		value,
		meta: parsed.meta,
		agentsRun,
		agentsCached,
		agentsFailed,
		logs,
		phases,
		truncated,
	};
}
