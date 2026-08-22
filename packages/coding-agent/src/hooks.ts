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
import { z } from "zod";

export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"SessionStart",
	"SessionEnd",
	"Stop",
	"PreCompact",
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
}

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

	/** Run all matching hooks for an event; never throws. */
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
 * PostToolUse).
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
		const timer = setTimeout(() => {
			if (process.platform === "win32" && child.pid) {
				// cmd.exe doesn't propagate signals — kill the whole process tree.
				spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
			} else {
				child.kill();
			}
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c: string) => (stdout += c));
		child.stderr.on("data", (c: string) => (stderr += c));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr: `${stderr}${error}`, exitCode: 127 });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
		child.stdin.write(`${stdinData}\n`);
		child.stdin.end();
	});
}
