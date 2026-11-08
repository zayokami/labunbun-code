/**
 * The on-disk record of a workflow run, and the keys that make resuming real.
 *
 * A workflow is a script making agent calls in a fixed order. Resume works by
 * replaying that script against what the previous run recorded: every call is
 * keyed by its inputs, and a key whose entry says "ok" returns the stored value
 * without spawning anything. Two details make that honest:
 *
 * - The key includes an occurrence index. A loop that asks the same question
 *   twice must produce two answers, so the first call is `hash#0` and the
 *   second `hash#1`; without it, resume would feed the first answer to both.
 * - Only `status: "ok"` entries are reusable. A call that errored is recorded
 *   so it consumes its occurrence, but it runs again on resume — the point of
 *   resuming is that the failure gets another chance.
 *
 * A run holds itself to no silent truncation: a result too large to journal is
 * recorded as an error with that stated reason, so resume re-runs it rather
 * than quietly replaying a partial answer.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WORKFLOW_RUN_VERSION = 1;

/** Entries larger than this are not journaled; the call re-runs on resume. */
export const MAX_JOURNAL_RESULT_CHARS = 4_000_000;

export type WorkflowRunStatus = "running" | "completed" | "failed" | "aborted";

export interface WorkflowRunCounts {
	run: number;
	cached: number;
	failed: number;
}

export interface WorkflowRunMeta {
	version: number;
	kind: "workflow";
	runId: string;
	name: string;
	scriptHash: string;
	argsHash: string;
	createdAt: number;
	updatedAt: number;
	status: WorkflowRunStatus;
	agents?: WorkflowRunCounts;
}

export interface WorkflowJournalEntry {
	seq: number;
	/** `<call hash>#<occurrence>` — unique within one run. */
	key: string;
	label: string;
	phase?: string;
	status: "ok" | "error";
	resultKind?: "text" | "json";
	result?: unknown;
	error?: string;
	worktree?: string;
	durationMs?: number;
	at: number;
}

export type WorkflowJournalRecord = Omit<WorkflowJournalEntry, "seq" | "at">;

export interface WorkflowJournalOptions {
	/** The directory that holds one directory per run (not the run's own). */
	root: string;
	name: string;
	script: string;
	args?: unknown;
	runId?: string;
	now?: () => number;
}

export interface WorkflowJournalOpenOptions {
	root: string;
	runId: string;
	now?: () => number;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function hashWorkflowScript(script: string): string {
	return sha256(script).slice(0, 16);
}

/** Stable JSON: object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown, depth = 0): string {
	if (depth > 32) throw new Error("value nests too deeply to hash");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`);
		return `{${pairs.join(",")}}`;
	}
	return "null";
}

export function hashWorkflowValue(value: unknown): string {
	return sha256(canonicalJson(value ?? null)).slice(0, 16);
}

export interface WorkflowCallIdentity {
	prompt: string;
	schema?: unknown;
	model?: string;
	effort?: string;
	agentType?: string;
	isolation?: string;
}

/**
 * The content address of one agent call. Labels and phases are display only and
 * stay out of the hash: renaming a stage must not invalidate its cache.
 */
export function workflowCallKey(identity: WorkflowCallIdentity): string {
	return hashWorkflowValue({
		prompt: identity.prompt,
		schema: identity.schema ?? null,
		model: identity.model ?? null,
		effort: identity.effort ?? null,
		agentType: identity.agentType ?? null,
		isolation: identity.isolation ?? null,
	});
}

/**
 * The journal for one run. `create` starts a fresh run; `open` loads an earlier
 * one for resume. Both expose the same read side, so the runner does not branch
 * on which it has.
 */
export class WorkflowJournal {
	readonly dir: string;
	readonly #meta: WorkflowRunMeta;
	readonly #script: string;
	readonly #args: unknown;
	readonly #entries = new Map<string, WorkflowJournalEntry>();
	readonly #occurrences = new Map<string, number>();
	readonly #resumed: boolean;
	readonly #now: () => number;
	#seq = 0;

	private constructor(args: {
		dir: string;
		meta: WorkflowRunMeta;
		script: string;
		args: unknown;
		entries: WorkflowJournalEntry[];
		resumed: boolean;
		now: () => number;
	}) {
		this.dir = args.dir;
		this.#meta = args.meta;
		this.#script = args.script;
		this.#args = args.args;
		this.#resumed = args.resumed;
		this.#now = args.now;
		for (const entry of args.entries) {
			this.#entries.set(entry.key, entry);
			if (entry.seq >= this.#seq) this.#seq = entry.seq + 1;
		}
		// Occurrence counters deliberately start at zero even for a reopened run:
		// a resume replays the script from its first call, so the k-th identical
		// call must claim `#k` again and meet the entry it wrote last time. Seeding
		// from the journal would make every resumed call a new occurrence and the
		// cache a no-op.
	}

	/** Start a new run directory and write its script and metadata. */
	static create(options: WorkflowJournalOptions): WorkflowJournal {
		const now = options.now ?? Date.now;
		const createdAt = now();
		const runId = options.runId ?? `wf-${createdAt.toString(36)}-${randomBytes(2).toString("hex")}`;
		const dir = join(options.root, runId);
		mkdirSync(dir, { recursive: true });
		const meta: WorkflowRunMeta = {
			version: WORKFLOW_RUN_VERSION,
			kind: "workflow",
			runId,
			name: options.name,
			scriptHash: hashWorkflowScript(options.script),
			argsHash: hashWorkflowValue(options.args),
			createdAt,
			updatedAt: createdAt,
			status: "running",
		};
		writeFileSync(join(dir, "script.js"), options.script, "utf8");
		if (options.args !== undefined) {
			writeFileSync(join(dir, "args.json"), JSON.stringify(options.args, null, 2), "utf8");
		}
		writeMeta(dir, meta);
		return new WorkflowJournal({
			dir,
			meta,
			script: options.script,
			args: options.args,
			entries: [],
			resumed: false,
			now,
		});
	}

	/** Load an earlier run. Unknown run ids throw with the path that was tried. */
	static open(options: WorkflowJournalOpenOptions): WorkflowJournal {
		const dir = join(options.root, options.runId);
		const metaPath = join(dir, "run.json");
		if (!existsSync(metaPath)) throw new Error(`Unknown workflow run ${options.runId} (looked in ${dir})`);
		const meta = JSON.parse(readFileSync(metaPath, "utf8")) as WorkflowRunMeta;
		const scriptPath = join(dir, "script.js");
		if (!existsSync(scriptPath)) throw new Error(`Workflow run ${options.runId} has no saved script`);
		const script = readFileSync(scriptPath, "utf8");
		const argsPath = join(dir, "args.json");
		const args: unknown = existsSync(argsPath) ? JSON.parse(readFileSync(argsPath, "utf8")) : undefined;
		const entries = readJournal(join(dir, "journal.jsonl"));
		return new WorkflowJournal({
			dir,
			meta,
			script,
			args,
			entries,
			resumed: true,
			now: options.now ?? Date.now,
		});
	}

	get runId(): string {
		return this.#meta.runId;
	}

	get meta(): WorkflowRunMeta {
		return this.#meta;
	}

	get script(): string {
		return this.#script;
	}

	get args(): unknown {
		return this.#args;
	}

	get resumed(): boolean {
		return this.#resumed;
	}

	get worktreesDir(): string {
		return join(this.dir, "worktrees");
	}

	/**
	 * Claim the next key for a call hash. Assignment happens even for a call
	 * that will fail, so the replay order matches the original run.
	 */
	nextKey(base: string): string {
		const next = this.#occurrences.get(base) ?? 0;
		this.#occurrences.set(base, next + 1);
		return `${base}#${next}`;
	}

	lookup(key: string): WorkflowJournalEntry | undefined {
		return this.#entries.get(key);
	}

	/** Append one call's outcome and make it visible to a later `lookup`. */
	record(entry: WorkflowJournalRecord): WorkflowJournalEntry {
		const at = this.#now();
		let record: WorkflowJournalEntry = { seq: this.#seq, at, ...entry };
		if (record.status === "ok" && record.result !== undefined) {
			let size = 0;
			try {
				size = JSON.stringify(record.result)?.length ?? 0;
			} catch {
				size = Number.POSITIVE_INFINITY;
			}
			if (size > MAX_JOURNAL_RESULT_CHARS) {
				record = {
					...record,
					status: "error",
					result: undefined,
					resultKind: undefined,
					error: `result was ${size} characters, over the journal limit; resume will run this call again`,
				};
			}
		}
		this.#seq++;
		this.#entries.set(record.key, record);
		appendFileSync(join(this.dir, "journal.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
		return record;
	}

	appendLog(line: string): void {
		appendFileSync(join(this.dir, "log.txt"), `${line}\n`, "utf8");
	}

	/** Seal the run. Called once, on every exit path. */
	finish(status: WorkflowRunStatus, agents: WorkflowRunCounts): void {
		this.#meta.status = status;
		this.#meta.agents = agents;
		this.#meta.updatedAt = this.#now();
		writeMeta(this.dir, this.#meta);
	}
}

function writeMeta(dir: string, meta: WorkflowRunMeta): void {
	const path = join(dir, "run.json");
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf8");
	renameSync(tmp, path);
}

function readJournal(path: string): WorkflowJournalEntry[] {
	if (!existsSync(path)) return [];
	const entries: WorkflowJournalEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line) as WorkflowJournalEntry;
			if (typeof parsed.key === "string" && typeof parsed.seq === "number") entries.push(parsed);
		} catch {
			// A half-written final line is the one damage a crash can leave; the
			// rest of the journal is still worth replaying.
		}
	}
	return entries;
}
