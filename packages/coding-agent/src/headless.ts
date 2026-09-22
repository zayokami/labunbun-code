/**
 * Headless (-p / --print) mode: run one prompt non-interactively.
 *
 * Output formats:
 * - text (default): streamed assistant text on stdout
 * - json: single JSON result object at the end
 * - stream-json: one JSON line per event, live
 */
import { readFileSync } from "node:fs";
import type { AgentEvent, PermissionMode } from "@labunbun/agent";
import { AgentSession, evaluatePermissions, formatRetryNotice, SessionStore } from "@labunbun/agent";
import {
	type AgentMessage,
	type CacheTracker,
	cacheTotals,
	createTrackedStreamFn,
	resolveModel,
	type StreamFn,
	totalsHitRate,
} from "@labunbun/ai";
import { createAllTools } from "@labunbun/tools";
import { builtInCommands, expandPromptCommand } from "./commands.ts";
import { createCompactionWiring } from "./compaction-wiring.ts";
import { costStateFromMessages } from "./cost-tracker.ts";
import { advisoryHookFailures, snapshotHooks } from "./hooks.ts";
import { loadMemoryFiles } from "./memory.ts";
import { describeWithheld } from "./project-trust.ts";
import {
	applyCatalogSettings,
	applySettingsEnv,
	collectPermissionRules,
	formatIgnoredKeysNotice,
	loadSettings,
	resolvePermissionMode,
} from "./settings.ts";
import { loadSkills, skillsAsCommands, withheldProjectSkills } from "./skills.ts";
import { createTaskTool, loadAgentDefinitions, withheldProjectAgents } from "./subagents.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { pruneToolOutput, toolOutputRoot, writeToolOutput } from "./tool-output.ts";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
	prompt: string;
	modelRef?: string;
	permissionMode?: PermissionMode;
	maxTurns?: number;
	noSession?: boolean;
	cwd?: string;
	outputFormat?: OutputFormat;
	/**
	 * The model transport. Injected by tests, which is the only way to run this
	 * path without a network or a bill; production leaves it out and gets the
	 * retrying default.
	 */
	streamFn?: StreamFn;
}

interface JsonResult {
	type: "result";
	subtype: "success" | "error_max_turns" | "error_during_execution" | "error_aborted";
	cost_usd: number;
	duration_ms: number;
	num_turns: number;
	result: string;
	session_id: string | null;
	cache: CacheResult;
}

/**
 * What the prompt cache did, in the machine-readable result.
 *
 * The three token channels sum to the whole prompt, so no separate total is
 * reported — a fourth number that is the sum of the other three is a number
 * that can drift away from them. `cache_hit_rate` is the read share of that
 * sum, or null when the provider reported no prompt size at all, which is a
 * different fact from zero.
 *
 * `cache_rewinds` needs the tracker, and a caller that injected its own
 * transport has none: null says "not observed" where zero would claim something
 * nobody checked. It counts every family, including summariser and subagent
 * requests, because a rewind in any of them is a cache that was thrown away.
 */
interface CacheResult {
	cache_read_tokens: number;
	cache_write_tokens: number;
	full_price_tokens: number;
	cache_hit_rate: number | null;
	cache_rewinds: number | null;
}

function cacheResult(messages: AgentMessage[], tracker?: CacheTracker): CacheResult {
	const totals = cacheTotals(messages);
	const rate = totalsHitRate(totals);
	return {
		cache_read_tokens: totals.read,
		cache_write_tokens: totals.write,
		full_price_tokens: totals.input,
		cache_hit_rate: rate ?? null,
		cache_rewinds: tracker ? tracker.records().filter((record) => record.kind === "rewind").length : null,
	};
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const format = options.outputFormat ?? "text";

	const loadedSettings = loadSettings(cwd);
	const { settings } = loadedSettings;
	const ignoredNotice = formatIgnoredKeysNotice(loadedSettings.ignoredKeys);
	if (ignoredNotice) console.error(`Warning: ${ignoredNotice}`);
	// Before the model is resolved, unlike in the REPL: a provider, or a price,
	// that lives in settings has to be registered for the reference below to
	// resolve at all — and the price is what the reported cost is computed from.
	applySettingsEnv(settings);
	applyCatalogSettings(settings);

	const model = resolveModel(options.modelRef ?? "anthropic/claude-sonnet-5");
	if (!model) {
		console.error(`Unknown model: ${options.modelRef}`);
		return 1;
	}

	// Spilling applies here too: a `-p` run reads a repository like any other
	// session, and a build log that does not fit is no more reproducible for
	// being unattended.
	const tools = createAllTools(cwd, { readOnlyRoots: [toolOutputRoot(cwd)] });
	const store = options.noSession ? undefined : SessionStore.startNew(cwd);
	pruneToolOutput(cwd);
	const rules = collectPermissionRules(loadedSettings);
	// Headless defaults to bypassPermissions, so this is the tier check that
	// matters most: managed settings can veto it and force real evaluation.
	// Note `settings.permissionMode` is deliberately not consulted here — it
	// governs the interactive default, and honouring it would change what
	// existing scripted `-p` runs are allowed to do.
	const { mode: effectiveMode, downgradeReason } = resolvePermissionMode(
		options.permissionMode ?? "bypassPermissions",
		loadedSettings,
	);
	if (downgradeReason) console.error(`Warning: ${downgradeReason}`);

	// ---- user hooks (snapshotted at startup against mid-session injection) ----
	const hooksRuntime = snapshotHooks(settings.hooks);
	const sessionId = store?.sessionId ?? undefined;
	const hookContext: string[] = [];

	// SessionStart runs before the prompt so its context reaches the model.
	// Hook failures are reported on stderr and never change the exit code.
	const sessionStart = await hooksRuntime.run("SessionStart", { session_id: sessionId, cwd });
	hookContext.push(...sessionStart.addedContext);
	for (const message of advisoryHookFailures("SessionStart", sessionStart)) {
		console.error(`Warning: ${message}`);
	}
	/**
	 * The transport, and what it can be asked about afterwards.
	 *
	 * The default is tracked so the JSON result can report what the cache did;
	 * an injected transport (a test, an embedder) is used as it comes, and the
	 * tracker-shaped fields in the result become null rather than invented.
	 */
	const transport: { streamFn: StreamFn; tracker?: CacheTracker } = options.streamFn
		? { streamFn: options.streamFn }
		: createTrackedStreamFn({ policy: settings.cache });

	// Everything the REPL has always put in front of the model and a `-p` run
	// did not: the memory files, the skills, and the agents a Task call can spawn.
	// A scripted run reads the same repository as an interactive one, so a
	// LABUNBUN.md, a `/skill-x`, or an agent definition that works in the REPL and
	// silently does nothing under `-p` made the same prompt behave differently in
	// two modes — which is the kind of difference nobody notices until they trust
	// a nightly job to do what they just did by hand.
	const memory = loadMemoryFiles(cwd);
	const skills = loadSkills(cwd);
	const commands = [...builtInCommands(), ...skillsAsCommands(skills)];
	const agentDefinitions = loadAgentDefinitions(cwd);
	// A `-p` run has no dialog to approve a project's definitions with, so an
	// untrusted one is not loaded at all — the gate is inside the loaders above.
	// Said on stderr rather than passed over in silence: a scripted run whose
	// skills quietly expand to nothing is the exact failure that is invisible
	// until someone reads the transcript and wonders why the model ignored them.
	const withheldAgents = withheldProjectAgents(cwd);
	const withheldSkills = withheldProjectSkills(cwd);
	if (withheldAgents.length + withheldSkills.length > 0) {
		console.error(
			`Warning: this project's definitions are not loaded — ${describeWithheld({
				agents: withheldAgents.length,
				skills: withheldSkills.length,
			})}. Approve them in an interactive session (/agents approve).`,
		);
	}
	// Read at the call, like the REPL's: the definition list is a getter because a
	// definition approved mid-session joins it, and the store because a sidechain
	// belongs to whichever session is live.
	const taskTool = createTaskTool({
		streamFn: transport.streamFn,
		model: () => model,
		resolveModel,
		allTools: tools,
		definitions: () => agentDefinitions,
		store: () => store,
		permissionMode: () => effectiveMode,
		getPermissionRules: () => rules,
		trimOldToolResults: settings.trimOldToolResults,
		report: (text) => console.error(text),
	});
	// MCP servers are deliberately not connected here: `-p` has no dialog to
	// approve a project-defined server with, and an unapproved one must not be
	// reachable just because nobody was watching.
	const allTools = [...tools, taskTool];

	// A `-p` run is a session like any other, and one that runs out of room
	// unattended has nobody to type `/compact`: before this it ended on the
	// provider's own refusal, with the whole transcript still in the way. The
	// same wiring the REPL uses, reporting to stderr because that is where a
	// non-interactive run says things — and registering its rewrites with the
	// tracker, or a `-p` run's own summary would be reported as a prefix rewrite
	// nothing declared.
	const compactionWiring = createCompactionWiring({
		model,
		store,
		streamFn: transport.streamFn,
		trimOldToolResults: settings.trimOldToolResults,
		report: (text) => console.error(text),
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return null;
			}
		},
		noteRewrite: (cause) => transport.tracker?.note(cause),
	});

	const session = new AgentSession({
		model,
		systemPrompt: buildSystemPrompt(allTools, {
			cwd,
			platform: process.platform,
			isTTY: process.stdout.isTTY ?? false,
			memory: memory.content,
		}),
		tools: allTools,
		store,
		cwd,
		maxTurns: options.maxTurns,
		permissionMode: effectiveMode,
		deps: {
			streamFn: transport.streamFn,
			checkCompaction: compactionWiring.checkCompaction,
			spillOutput: (request) => writeToolOutput(request, { cwd, sessionId }),
			// Headless has no interactive dialog, so an unresolved "ask" fails
			// closed rather than hanging — matches dontAsk's documented contract.
			canUseTool: async (toolName, input, ctx) => {
				const decision = evaluatePermissions(toolName, input, { mode: ctx.mode, rules, cwd });
				if (decision.behavior === "ask") {
					return {
						behavior: "deny",
						message: decision.message ?? `Permission required for ${toolName} (no interactive dialog in headless mode)`,
					};
				}
				return decision;
			},
			hooks: {
				composeUserMessage: (text) => {
					// Hook context is composed into the user message as it is created, so
					// the stored transcript is what every later request replays. The
					// version of this that attached it to the first request only made the
					// prompt the hook contributed to unrepeatable: the second request of a
					// tool loop sent the same message without it, and every token after
					// that message was charged at full price again.
					//
					// Drained rather than kept: a second prompt in the same run is a
					// different message, and it gets whatever that prompt's own hooks
					// contributed.
					const context = hookContext.splice(0, hookContext.length);
					if (context.length === 0) return text;
					return `${context.join("\n\n")}\n\n---\n\n${text}`.trimEnd();
				},
				beforeToolCall: async (toolName, input) => {
					if (!hooksRuntime.has("PreToolUse")) return undefined;
					const outcome = await hooksRuntime.run("PreToolUse", { tool_name: toolName, tool_input: input, cwd });
					for (const error of outcome.errors) console.error(`Warning: PreToolUse hook failed: ${error}`);
					if (outcome.blocked) return { block: true, reason: outcome.reason ?? "Blocked by PreToolUse hook" };
					return undefined;
				},
				afterToolCall: async (toolName, input) => {
					if (!hooksRuntime.has("PostToolUse")) return undefined;
					const outcome = await hooksRuntime.run("PostToolUse", { tool_name: toolName, tool_input: input, cwd });
					// Advisory: the call already ran, so a block has nothing to stop.
					for (const message of advisoryHookFailures("PostToolUse", outcome)) {
						console.error(`Warning: ${message}`);
					}
					return undefined;
				},
			},
		},
	});

	const startedAt = Date.now();
	let lastAssistantText = "";
	let turns = 0;
	/**
	 * The loop's own verdict on why the run ended.
	 *
	 * It knows things the transcript does not: a request that could not be sent
	 * ends the run with a reason ("Automatic compaction could not free enough
	 * space… Run /compact"), while the transcript's last error is whatever the
	 * provider said when it refused — which is the symptom, not the explanation.
	 */
	let endErrorMessage: string | undefined;

	const emitStreamJson = (payload: Record<string, unknown>): void => {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	};

	session.on((event: AgentEvent) => {
		if (event.type === "turn_start") turns++;
		if (event.type === "agent_end") endErrorMessage = event.errorMessage;

		// On stderr, not stdout: a `-p` run may be piped, and the wait for a retry
		// is not part of the answer being piped. It is still said out loud — the
		// ladder runs for minutes, and silence is what made a wrong key look like a
		// hang rather than a mistake.
		if (event.type === "retry") {
			process.stderr.write(`${formatRetryNotice(event)}\n`);
		}

		if (event.type === "message_update") {
			const text = event.message.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("");
			if (format === "text") {
				const delta = text.slice(lastAssistantText.length);
				if (delta) {
					process.stdout.write(delta);
					lastAssistantText = text;
				}
			} else if (format === "stream-json") {
				emitStreamJson({
					type: "assistant",
					message: event.assistantMessageEvent.type,
					text_delta: event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : undefined,
				});
			}
		}

		if (format === "stream-json" && event.type === "tool_execution_start") {
			emitStreamJson({ type: "tool_use", tool: event.toolName, input: event.input });
		}
		if (format === "stream-json" && event.type === "tool_execution_end") {
			emitStreamJson({
				type: "tool_result",
				tool: event.toolName,
				is_error: event.result.isError,
			});
		}
	});

	// UserPromptSubmit gates the single headless prompt. A block exits non-zero
	// without ever reaching the model, so scripted callers can detect it.
	if (hooksRuntime.has("UserPromptSubmit")) {
		const outcome = await hooksRuntime.run("UserPromptSubmit", {
			prompt: options.prompt,
			session_id: sessionId,
			cwd,
		});
		for (const error of outcome.errors) console.error(`Warning: UserPromptSubmit hook failed: ${error}`);
		hookContext.push(...outcome.addedContext);
		if (outcome.blocked) {
			console.error(`[prompt blocked by UserPromptSubmit hook${outcome.reason ? `: ${outcome.reason}` : ""}]`);
			const endOutcome = await hooksRuntime.run("SessionEnd", { session_id: sessionId, cwd });
			for (const message of advisoryHookFailures("SessionEnd", endOutcome)) {
				console.error(`Warning: ${message}`);
			}
			return 1;
		}
	}

	// A typed line that names a prompt-command is expanded before it is sent, the
	// same way the REPL expands it — `-p "/skill-x args"` is how a script reaches
	// a skill. Anything else (a local or app-level command, or a prompt that just
	// happens to start with a slash) is sent as typed; the hook above saw the
	// typed text either way.
	const reason = await session.prompt(expandPromptCommand(commands, options.prompt) ?? options.prompt);
	const finalText = finalAssistantText(session.messages);
	const usage = totalUsage(session.messages);

	if (format === "json") {
		const result: JsonResult = {
			type: "result",
			subtype:
				reason === "completed"
					? "success"
					: reason === "max_turns"
						? "error_max_turns"
						: reason === "aborted"
							? "error_aborted"
							: "error_during_execution",
			// Costed from the transcript's own usage records, against the prices the
			// model resolves to — the same arithmetic `/cost` does, so a scripted run
			// and an interactive one disagree about the bill only if the prices differ.
			cost_usd: costStateFromMessages(session.messages).totalCostUSD,
			duration_ms: Date.now() - startedAt,
			num_turns: turns,
			result: finalText,
			session_id: store?.sessionId ?? null,
			cache: cacheResult(session.messages, transport.tracker),
		};
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (format === "stream-json") {
		emitStreamJson({
			type: "result",
			reason,
			result: finalText,
			usage,
			cache: cacheResult(session.messages, transport.tracker),
			duration_ms: Date.now() - startedAt,
			session_id: store?.sessionId ?? null,
		});
	} else {
		// text mode already streamed; close cleanly
		process.stdout.write("\n");
		if (reason !== "completed") {
			// The loop's reason first, the transcript's last error second: only the
			// first one can say what to do about a request that was never sent.
			const errorMessage = endErrorMessage ?? findLastError(session.messages);
			console.error(`[session ended: ${reason}${errorMessage ? ` — ${errorMessage}` : ""}]`);
		}
	}

	if (store && format !== "text") {
		console.error(`[session saved: ${store.path}]`);
	} else if (store) {
		console.error(`[session saved: ${store.path}]`);
	}

	// SessionEnd is last, and its failures never change the exit code.
	const sessionEnd = await hooksRuntime.run("SessionEnd", { session_id: sessionId, cwd });
	for (const message of advisoryHookFailures("SessionEnd", sessionEnd)) {
		console.error(`Warning: ${message}`);
	}
	return reason === "completed" ? 0 : reason === "aborted" ? 130 : 1;
}

function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = m.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

function totalUsage(messages: AgentMessage[]): Record<string, number> {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		totals.input += m.usage.input ?? 0;
		totals.output += m.usage.output ?? 0;
		totals.cacheRead += m.usage.cacheRead ?? 0;
		totals.cacheWrite += m.usage.cacheWrite ?? 0;
	}
	return totals;
}

function findLastError(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && m.errorMessage) return m.errorMessage;
		if (m.role === "toolResult" && m.isError) {
			const text = m.content.find((b) => b.type === "text")?.text;
			if (text) return text.slice(0, 200);
		}
	}
	return undefined;
}
