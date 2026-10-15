/**
 * User-configurable lifecycle hooks (command type).
 *
 * Config shape (settings.json):
 *   { "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [
 *       { "type": "command", "command": "./check.sh", "timeout": 10000 } ] }] } }
 *
 * Contract: the hook command receives a JSON payload on stdin and may reply
 * with JSON on stdout:
 *   { "continue": false, "suppressOutput": true, "decision": "block", "reason": "..." }
 * Non-zero exit or `decision:"block"` blocks (for PreToolUse) / flags failure.
 *
 * The config is snapshotted at startup so a compromised session cannot inject
 * hooks mid-run.
 */
import { spawn } from "node:child_process";
import type { CompactionTrigger, LoopHooks } from "@labunbun/agent";
import { z } from "zod";

export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"SessionStart",
	"SessionEnd",
	"Stop",
	"PreCompact",
	"PostCompact",
	"Notification",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

export const CommandHookSchema = z.object({
	type: z.literal("command").default("command"),
	command: z.string(),
	timeout: z.number().int().positive().max(600_000).optional(),
});

export const HookMatcherSchema = z.object({
	matcher: z.string().optional(),
	hooks: z.array(CommandHookSchema).min(1),
});

export const HooksConfigSchema = z.record(z.string(), z.array(HookMatcherSchema));

export type CommandHook = z.infer<typeof CommandHookSchema>;
export type HookMatcher = z.infer<typeof HookMatcherSchema>;
export type HooksConfig = Partial<Record<HookEventName, HookMatcher[]>>;

export interface HookPayload {
	event: HookEventName;
	tool_name?: string;
	tool_input?: unknown;
	prompt?: string;
	session_id?: string;
	cwd?: string;
	/**
	 * The compaction events' fields, on this one interface because it carries
	 * every event's fields at once. The exact per-event shapes are
	 * `PreCompactHookPayload` and `PostCompactHookPayload` below, and those are
	 * what the firing sites should build; optional here so a caller that names
	 * only the fields it has does not have to spell the rest.
	 */
	trigger?: CompactionTrigger;
	custom_instructions?: string;
	pre_tokens?: number;
	post_tokens?: number;
}

/**
 * What a `PreCompact` hook receives, fired while a veto still means something:
 * a block defers the pass the estimate asked for, and the estimate will ask
 * again on a later turn. One refusal cannot be deferred — a request the
 * provider already refused would just be refused again — so the veto applies
 * to estimate-driven passes, which is why `trigger` is part of the payload
 * rather than something a hook has to guess.
 *
 * `trigger` is the compaction's own word for why the pass is running, the same
 * `CompactionTrigger` the session store records for it: `auto` when the
 * estimate tripped, `overflow` when a request did not fit and the pass is the
 * recovery, `manual` when the user asked. `/compact` hands its arguments over
 * as the focus text, which arrives as `custom_instructions` — absent when
 * there is none.
 *
 * `session_id` and `cwd` stay optional because they are optional on
 * `HookPayload`; every firing site passes both today.
 */
export interface PreCompactHookPayload {
	session_id?: string;
	cwd?: string;
	trigger: CompactionTrigger;
	custom_instructions?: string;
}

/**
 * What a `PostCompact` hook receives, fired after the transcript has been
 * rewritten: the pass is over, and `pre_tokens`/`post_tokens` are the estimate
 * before and after — the same pair the compaction report shows the user.
 *
 * An observer event: `OBSERVER_HOOK_EVENTS` below, and nothing a config
 * answers here can change the pass it is answering about. That is the whole
 * difference from `PreCompact`, whose block still vetoes.
 */
export interface PostCompactHookPayload {
	session_id?: string;
	cwd?: string;
	trigger: CompactionTrigger;
	pre_tokens: number;
	post_tokens: number;
}

/**
 * Events that watch rather than steer: a hook under one of these is told what
 * happened, and nothing it answers changes the run.
 *
 * `run()` still reports `blocked` for these the same as for every other event.
 * A non-zero exit is a failure everywhere, and the contract routes it to
 * `blocked` rather than `errors` — a runtime that special-cased it here would
 * hide a hook that fails on every single compaction. It is the call site that
 * decides what a block means: for an observer it is a line to report
 * (`advisoryHookFailures`), never a veto, because the moment it describes has
 * already passed.
 */
export const OBSERVER_HOOK_EVENTS: readonly HookEventName[] = ["PostCompact"];

export interface HookOutcome {
	/** A hook asked to block (PreToolUse deny / Stop prevention). */
	blocked: boolean;
	reason?: string;
	/** Extra context hooks want injected into the conversation. */
	addedContext: string[];
	suppressOutput: boolean;
	errors: string[];
}

function emptyOutcome(): HookOutcome {
	return { blocked: false, addedContext: [], suppressOutput: false, errors: [] };
}

interface HookEntry {
	event: HookEventName;
	matcher?: string;
	hook: CommandHook;
}

/** Snapshot + flatten raw settings into an immutable execution list. */
export function snapshotHooks(rawHooks: unknown): HooksRuntime {
	let config: HooksConfig = {};
	const parsed = HooksConfigSchema.safeParse(rawHooks);
	if (parsed.success) {
		config = parsed.data;
	} else if (rawHooks !== undefined) {
		console.error(`Warning: invalid hooks config ignored: ${parsed.error.message}`);
	}
	const entries: HookEntry[] = [];
	for (const [rawEvent, matchers] of Object.entries(config)) {
		if (!HOOK_EVENTS.includes(rawEvent as HookEventName)) continue;
		const event = rawEvent as HookEventName;
		for (const matcher of matchers ?? []) {
			for (const hook of matcher.hooks) {
				entries.push({ event, matcher: matcher.matcher, hook });
			}
		}
	}
	return new HooksRuntime(entries);
}

export class HooksRuntime {
	readonly #entries: HookEntry[];

	constructor(entries: HookEntry[]) {
		this.#entries = entries;
	}

	get isEmpty(): boolean {
		return this.#entries.length === 0;
	}

	has(event: HookEventName): boolean {
		return this.#entries.some((e) => e.event === event);
	}

	/**
	 * Run all matching hooks for an event; never throws.
	 *
	 * The payload reaches the hooks as it is handed over — serialized whole —
	 * so a field this interface does not name still arrives. The per-event
	 * interfaces above are the contract, not a filter.
	 */
	async run(event: HookEventName, payload: Omit<HookPayload, "event">): Promise<HookOutcome> {
		const outcome = emptyOutcome();
		const relevant = this.#entries.filter(
			(e) => e.event === event && (!e.matcher || matchesPattern(e.matcher, payload.tool_name ?? "")),
		);
		for (const entry of relevant) {
			try {
				const result = await runCommandHook(entry.hook, { event, ...payload });
				outcome.addedContext.push(...result.addedContext);
				if (result.blocked) {
					outcome.blocked = true;
					outcome.reason = result.reason ?? outcome.reason;
				}
				if (result.suppressOutput) outcome.suppressOutput = true;
			} catch (error) {
				outcome.errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		return outcome;
	}
}

function matchesPattern(pattern: string, toolName: string): boolean {
	if (pattern === "*" || pattern === "") return true;
	const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
	return regex.test(toolName);
}

/**
 * Failure lines for an *advisory* event — one where a hook's "block" reply
 * carries no control-flow meaning (SessionStart, SessionEnd, Notification,
 * PostToolUse, and the observer events in `OBSERVER_HOOK_EVENTS`).
 *
 * Per the hook contract a non-zero exit sets `blocked` rather than pushing to
 * `errors`, so a caller that reported only `errors` would silently swallow a
 * hook that is failing on every single run — the exact dead-configuration
 * failure these call sites exist to prevent.
 */
export function advisoryHookFailures(event: HookEventName, outcome: HookOutcome): string[] {
	const messages = outcome.errors.map((error) => `${event} hook failed: ${error}`);
	if (outcome.blocked) {
		messages.push(`${event} hook reported failure${outcome.reason ? `: ${outcome.reason}` : ""}`);
	}
	return messages;
}

/**
 * The session-level hook deps every unattended entry point wires the same way —
 * `-p` runs and ACP sessions.
 *
 * One definition rather than one per entry point, because the subtle half is not
 * the three callbacks but the timing in `composeUserMessage`: hook context is
 * folded into the user message at the moment it is stored, and a second copy of
 * that rule is a second place it can be got wrong. `context` is the array the
 * caller's `SessionStart`/`UserPromptSubmit` runs pushed into; it is drained
 * rather than read, so a second prompt in the same run carries only what its own
 * prompt contributed.
 */
export function sessionHookDeps(options: { runtime: HooksRuntime; context: string[]; cwd: string }): LoopHooks {
	const { runtime, context, cwd } = options;
	return {
		// Hook context is composed into the user message as it is created, so the
		// stored transcript is what every later request replays. Attaching it to the
		// first request only would make the prompt the hook contributed to
		// unrepeatable: the second request of a tool loop would send the same message
		// without it, and every token after that message would be charged at full
		// price again.
		composeUserMessage: (text) => {
			const added = context.splice(0, context.length);
			if (added.length === 0) return text;
			return `${added.join("\n\n")}\n\n---\n\n${text}`.trimEnd();
		},
		beforeToolCall: async (toolName, input) => {
			if (!runtime.has("PreToolUse")) return undefined;
			const outcome = await runtime.run("PreToolUse", { tool_name: toolName, tool_input: input, cwd });
			for (const error of outcome.errors) console.error(`Warning: PreToolUse hook failed: ${error}`);
			if (outcome.blocked) return { block: true, reason: outcome.reason ?? "Blocked by PreToolUse hook" };
			return undefined;
		},
		afterToolCall: async (toolName, input) => {
			if (!runtime.has("PostToolUse")) return undefined;
			const outcome = await runtime.run("PostToolUse", { tool_name: toolName, tool_input: input, cwd });
			// Advisory: the call already ran, so a block has nothing to stop.
			for (const message of advisoryHookFailures("PostToolUse", outcome)) {
				console.error(`Warning: ${message}`);
			}
			return undefined;
		},
	};
}

interface CommandHookResult {
	blocked: boolean;
	reason?: string;
	suppressOutput: boolean;
	addedContext: string[];
}

async function runCommandHook(hook: CommandHook, payload: HookPayload): Promise<CommandHookResult> {
	const timeoutMs = hook.timeout ?? 60_000;
	const result = await execWithTimeout(hook.command, JSON.stringify(payload), timeoutMs);

	const out: CommandHookResult = { blocked: false, suppressOutput: false, addedContext: [] };

	// Parse stdout as JSON when it looks like our contract.
	const stdout = result.stdout.trim();
	if (stdout.startsWith("{")) {
		try {
			const parsed = JSON.parse(stdout) as {
				continue?: boolean;
				suppressOutput?: boolean;
				decision?: string;
				reason?: string;
				addedContext?: unknown;
			};
			if (parsed.decision === "block" || parsed.continue === false) {
				out.blocked = true;
				out.reason = parsed.reason;
			}
			if (parsed.suppressOutput) out.suppressOutput = true;
			if (typeof parsed.addedContext === "string") out.addedContext.push(parsed.addedContext);
		} catch {
			// non-JSON stdout is treated as plain context output
			if (stdout) out.addedContext.push(stdout);
		}
	} else if (stdout) {
		out.addedContext.push(stdout);
	}

	if (result.exitCode !== 0 && !out.blocked) {
		out.blocked = true;
		out.reason =
			out.reason ?? `hook exited ${result.exitCode}${result.stderr ? `: ${result.stderr.slice(0, 200)}` : ""}`;
	}
	return out;
}

/**
 * Grace between killing a timed-out hook and settling without a `close`.
 *
 * A kill does not guarantee the pipe follows: the command may leave a
 * grandchild holding the inherited stdout (`sleep 15 & echo started` on POSIX,
 * `start /b ping ...` on Windows), and `close` waits for every holder of the
 * pipe — minutes, or never. Settling on `close` alone therefore left the
 * promise below pending, and `run()` awaits it, so a `PreToolUse` hook that
 * hangs once holds the entire tool loop shut forever. This is the same
 * measured family, and the same bound, as `EXIT_DRAIN_GRACE_MS` in
 * `packages/tools/src/operations.ts`, which carries the long-form shapes.
 */
const TIMEOUT_KILL_GRACE_MS = 2_000;

function execWithTimeout(
	command: string,
	stdinData: string,
	timeoutMs: number,
): Promise<{
	stdout: string;
	stderr: string;
	exitCode: number;
}> {
	return new Promise((resolve) => {
		const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
		const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
		const child = spawn(shell, args, { cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let graceTimer: ReturnType<typeof setTimeout> | null = null;
		/** The result a hook that had to be killed gets, whether `close` or the grace delivers it. */
		const timeoutResult = () => ({
			stdout,
			stderr: stderr || `hook timed out after ${timeoutMs}ms`,
			exitCode: 124,
		});
		const timer = setTimeout(() => {
			timedOut = true;
			if (process.platform === "win32" && child.pid) {
				// cmd.exe doesn't propagate signals — kill the whole process tree.
				// The killer is fire-and-forget, but an `error` with no listener on a
				// child process is an uncaught exception; a `taskkill` that could not
				// start must not take down the session over a hook being failed anyway.
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
			} else {
				child.kill();
			}
			// Settling on `close` alone waits on a drain a grandchild can hold open
			// past the kill (see TIMEOUT_KILL_GRACE_MS). The kill has happened; give
			// the pipe a bounded moment to follow it, then settle as the timeout it
			// already is. A `close` inside the grace is the normal path and cancels it.
			graceTimer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve(timeoutResult());
			}, TIMEOUT_KILL_GRACE_MS);
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout += c));
		child.stderr.on("data", (c: string) => (stderr += c));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			resolve({ stdout, stderr: `${stderr}${error}`, exitCode: 127 });
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			// A hook we killed is a hook that did not finish, and it has to read as a
			// failure. POSIX reports a signalled child as `code === null`, and
			// `null ?? 0` is a clean exit — so without this the timeout resolved as
			// success, `exitCode !== 0` never held, and every hung hook counted as
			// having passed. A `PreToolUse` hook that hangs is the one case that must
			// not let the tool run quietly. Windows never reached that branch, because
			// `taskkill` leaves `cmd.exe` with a non-zero code of its own.
			if (timedOut) {
				resolve(timeoutResult());
				return;
			}
			// The same shape for a hook something *else* killed: still a child that
			// never exited, and still not a zero.
			if (code === null && signal) {
				resolve({ stdout, stderr: `${stderr}hook killed by ${signal}`, exitCode: 128 });
				return;
			}
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
		// A hook killed at its timeout can take the stdin pipe down with it, and a
		// write crossing that moment raises EPIPE — an unhandled `error` on the
		// stream is a thrown exception in the loop that was running the tool, over
		// a hook whose fate is already decided. The result carries the verdict; the
		// broken pipe only repeats it.
		child.stdin.on("error", () => {});
		try {
			child.stdin.write(`${stdinData}\n`);
			child.stdin.end();
		} catch {
			// The same race, thrown synchronously instead of emitted.
		}
	});
}
