/**
 * Interactive mode: settings hierarchy → model resolution → tools →
 * permission engine + dialog bridge → Ink REPL with app-level commands.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
	type AgentDeps,
	AgentSession,
	COMPACTION_DISABLED_NOTICE,
	CompactionManager,
	compactionThreshold,
	contextBreakdown,
	estimateContextUsage,
	evaluatePermissions,
	formatRetryNotice,
	type PermissionMode,
	type PermissionRule,
	type SessionEntry,
	SessionStore,
} from "@labunbun/agent";
import {
	apiKeyEnvNames,
	createDefaultStreamFn,
	formatCatalogNotice,
	listModels,
	type Model,
	refreshModelCatalog,
	resolveApiKey,
	resolveModel,
	withModelFallback,
} from "@labunbun/ai";
import {
	connectAllMcpServers,
	connectMcpServer,
	loadApprovedMcpServers,
	loadMcpConfig,
	loadProjectMcpServerNames,
	type McpConnection,
	type McpServerConfig,
	approveMcpServer as persistMcpApproval,
} from "@labunbun/mcp";
import {
	type BackgroundShell,
	BackgroundShellManager,
	createAllTools,
	defaultOperations,
	type Operations,
	TaskStore,
} from "@labunbun/tools";
import { AUTO_THEME_NAME, mountRepl, type ReplAppHandle, ruleSpecifierFor } from "@labunbun/tui";
import { createAskUserQuestionTool } from "./ask-user.ts";
import {
	BACKGROUND_SHELL_POLL_MS,
	formatShellOutput,
	resolveShellId,
	shellPickerItems,
} from "./background-commands.ts";
import { builtInCommands, type Command, completeCommands, findCommand, type LocalCommandContext } from "./commands.ts";
import { contextRows, contextSummaryLine, isContextLow, lowContextWarning } from "./context-report.ts";
import { CostTracker, formatCostReport } from "./cost-tracker.ts";
import { sessionToMarkdown } from "./export-session.ts";
import { createFileCompleter } from "./file-completions.ts";
import { appendHistory, loadHistory } from "./history.ts";
import { advisoryHookFailures, snapshotHooks } from "./hooks.ts";
import { CLI_NAME } from "./index.ts";
import { loadMemoryFiles } from "./memory.ts";
import { createPlanModeCallbacks, createPlanModeTools, type PlanModeCallbacks } from "./plan-mode.ts";
import {
	damagedSessionNotice,
	exitSummaryLine,
	formatMessageCount,
	listSessions,
	loadSessionForResume,
	resolveContinueTarget,
	type SessionSummary,
} from "./session-resume.ts";
import {
	applyCatalogSettings,
	applySettingsEnv,
	collectPermissionRules,
	formatIgnoredKeysNotice,
	loadSettings,
	resolvePermissionMode,
	type Settings,
} from "./settings.ts";
import { createShellPassthrough } from "./shell-passthrough.ts";
import { loadSkills, skillsAsCommands } from "./skills.ts";
import { createTaskTool, loadAgentDefinitions } from "./subagents.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { bindTaskStore, restoreTasks } from "./task-snapshot.ts";
import { persistThemeChoice, type ResolvedTheme, resolveTheme } from "./theme-file.ts";
import { pruneToolOutput, toolOutputRoot, writeToolOutput } from "./tool-output.ts";
import { persistModelChoice, writeUserSettingsPatch } from "./user-settings.ts";
import { runWizard, shouldRunWizard } from "./wizard.ts";

export interface InteractiveOptions {
	modelRef?: string;
	permissionMode?: PermissionMode;
	resumeSessionId?: string;
	/** Continue the most recent session (the --continue flag). */
	continueLast?: boolean;
	cwd?: string;
	/** Theme name: a built-in, a theme file, or "auto". */
	theme?: string;
	/** Home directory for user-owned state; injectable so tests don't touch the real one. */
	home?: string;
}

export async function runInteractive(options: InteractiveOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const home = options.home ?? homedir();

	// ---- first-run setup (before settings load, so it can create them) ----
	if (shouldRunWizard()) await runWizard(cwd);

	// ---- settings & providers ----
	const loadedSettings = loadSettings(cwd);
	const { settings } = loadedSettings;
	// Say out loud what a file inside this project asked for and did not get —
	// silence here would look like the setting simply didn't work.
	const ignoredNotice = formatIgnoredKeysNotice(loadedSettings.ignoredKeys);
	if (ignoredNotice) console.error(`Warning: ${ignoredNotice}`);
	// Before provider registration and the API-key check below, both of which
	// read process.env — a key configured via settings.env has to be in place
	// by then or it would have no effect at all.
	applySettingsEnv(settings);
	// Models and prices the settings file declares, before anything resolves one.
	applyCatalogSettings(settings);

	// ---- model ----
	const modelRef = options.modelRef ?? settings.model ?? "anthropic/claude-sonnet-5";
	const model = resolveModel(modelRef);
	if (!model) {
		console.error(`Unknown model: ${modelRef}`);
		return 1;
	}
	// Narrowed alias: closures below (hot-swap) read the startup model without
	// re-narrowing.
	const startupModel: Model = model;
	if (!resolveApiKey(model)) {
		const names = apiKeyEnvNames(model);
		console.error(
			`Missing API key for ${model.provider}: set ${names.join(" or ")} in your environment.\n` +
				`Example: export ${model.apiKeyEnv}=sk-...`,
		);
		return 1;
	}

	// ---- catalog refresh ----
	// Ask each provider with a key what it serves, in the background. Started
	// here — after the key check, before the long startup awaits — so the answer
	// is in place by the time the user opens /model, and nothing waits on it: the
	// catalog's own table is already usable, and a provider that does not answer
	// leaves it exactly as it was.
	const catalogAbort = new AbortController();
	const catalogRefresh =
		settings.modelDiscovery === false ? undefined : refreshModelCatalog({ signal: catalogAbort.signal });

	// ---- session persistence: resume, continue, or new ----
	let store: SessionStore | undefined;
	/** Said out loud below: a resumed conversation that is missing messages. */
	let damageNotice: string | undefined;
	if (options.resumeSessionId) {
		const resumeId = options.resumeSessionId;
		const sessions = listSessions(cwd);
		const match =
			sessions.find((s) => s.sessionId === resumeId) ?? sessions.find((s) => s.sessionId.includes(resumeId));
		if (!match) {
			console.error(`Session not found: ${options.resumeSessionId}`);
			return 1;
		}
		const loaded = loadSessionForResume(match.path);
		store = loaded?.store;
		if (loaded) damageNotice = damagedSessionNotice(loaded.store, loaded.removed);
	} else if (options.continueLast) {
		// --resume wins when both are given; this is the shorthand.
		const target = resolveContinueTarget(cwd);
		if (target) {
			const loaded = loadSessionForResume(target.path);
			store = loaded?.store;
			if (loaded) damageNotice = damagedSessionNotice(loaded.store, loaded.removed);
		}
		if (!store) {
			console.error("No previous session to continue — starting a new one.");
			store = SessionStore.startNew(cwd);
		}
	} else {
		store = SessionStore.startNew(cwd);
	}
	// Before the transcript is on screen, so the count the user is about to read
	// is explained rather than contradicted.
	if (damageNotice) console.error(`Warning: ${damageNotice}`);

	// ---- tools & session ----
	const taskStore = new TaskStore();
	// The list survives the process by living in the session file: this run starts
	// from the plan the last one left, and every change after that is recorded.
	// Read through `store` (not the value it holds now) so `/resume` takes effect.
	bindTaskStore(taskStore, () => store);
	// One shared Operations instance: the "!" shell passthrough and the Bash
	// tool must resolve shells and kill process trees identically.
	const ops: Operations = defaultOperations();
	const shellPassthrough = createShellPassthrough({ cwd, ops });
	// Owned here rather than inside createAllTools so `/ps` and `/stop` can reach
	// the same shells the Bash tool started; the factory would otherwise make a
	// private manager nobody else can see.
	const backgroundShells = new BackgroundShellManager();
	// Results too large for the context go here instead of being thrown away, and
	// Read is allowed back into this directory to fetch them.
	const tools = createAllTools(cwd, {
		taskStore,
		operations: ops,
		backgroundShells,
		readOnlyRoots: [toolOutputRoot(cwd, home)],
	});
	// Best effort, and before anything can spill: an expired file is one the
	// context cannot be pointing at, since nothing has run yet this session.
	pruneToolOutput(cwd, { home });
	const sessionRules: PermissionRule[] = [];
	const baseRules: PermissionRule[] = collectPermissionRules(loadedSettings);
	const requestedMode = options.permissionMode ?? settings.permissionMode ?? "default";
	const { mode: effectiveMode, downgradeReason } = resolvePermissionMode(requestedMode, loadedSettings);
	let handle: ReplAppHandle | null = null;

	// Memory files (LABUNBUN.md / AGENTS.md), part of the system prompt. `home` is
	// passed rather than left to `homedir()`: the caller may have named one, and a
	// home the code reads but does not honour is how a test run ends up reading
	// the operator's own memory files.
	const memory = loadMemoryFiles(cwd, home);

	// ---- model fallback chain ----
	const baseStreamFn = createDefaultStreamFn();
	const fallbackChain = (settings.fallbackModels ?? [])
		.map((ref) => resolveModel(ref))
		.filter((m): m is NonNullable<typeof m> => Boolean(m));
	const streamFn = withModelFallback(baseStreamFn, () => fallbackChain);

	// Compaction. Recreated on /resume or /model switch — the manager binds to
	// one store and one model's window, so a swap must rebuild it.
	const buildCompaction = (forModel: Model, forStore: SessionStore | undefined): CompactionManager =>
		new CompactionManager(
			{
				contextWindow: forModel.contextWindow,
				maxOutputTokens: forModel.maxOutputTokens,
				microcompactFirst: settings.trimOldToolResults === true,
			},
			{
				streamFn,
				store: forStore,
				summarizerModel: forModel,
				readFile: (path) => {
					try {
						return readFileSync(path, "utf8");
					} catch {
						return null;
					}
				},
			},
		);
	let compaction = buildCompaction(model, store);
	// Whether the breaker's notice has been shown for the current trip. Edge-
	// triggered off `isTripped` so a rebuild (which cannot be tripped) resets it.
	let breakerWarned = false;
	// Read by the setContextInfo closure on every turn boundary.
	const thresholdHolder = {
		current: compactionThreshold({ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens }),
	};

	/**
	 * What the context indicator measures, and what it measures against.
	 *
	 * The whole request the model will be sent — system prompt and tool schemas
	 * included, not just the transcript: a session with a large toolset carries
	 * thousands of tokens before the user types anything, and an indicator that
	 * reads the messages alone calls that session empty right up until it
	 * compacts. The denominator is the threshold where the session acts, so the
	 * line answers "how much room before this conversation changes shape".
	 */
	function contextInfoFor(target: AgentSession): { usedTokens: number; threshold: number } {
		return { usedTokens: estimateContextUsage(target.currentContext()), threshold: thresholdHolder.current };
	}

	/** Republish the indicator. Anything that changes the context calls this. */
	function refreshContextInfo(target: AgentSession): void {
		handle?.setContextInfo(contextInfoFor(target));
	}

	// ---- user hooks (snapshotted at startup against mid-session injection) ----
	const hooksRuntime = snapshotHooks(settings.hooks);
	/**
	 * Session-scoped mutable state lives behind holders. An in-app /resume or a
	 * /model switch rebinds them without invalidating any closure that captured
	 * the holder itself.
	 */
	const sessionIdHolder: { current: string | undefined } = { current: store?.sessionId ?? undefined };

	// Context contributed by hooks (SessionStart / UserPromptSubmit). Injected
	// into the next user message alongside memory, so the cached system-prompt
	// prefix stays byte-stable.
	const pendingHookContext: string[] = [];

	// ---- SessionStart: runs before the REPL mounts, so its context is
	// available to the very first prompt. Errors are reported, never fatal.
	const sessionStartOutcome = await hooksRuntime.run("SessionStart", {
		session_id: sessionIdHolder.current,
		cwd,
	});
	pendingHookContext.push(...sessionStartOutcome.addedContext);
	const startupHookErrors = advisoryHookFailures("SessionStart", sessionStartOutcome);

	// ---- MCP servers ----
	// User-scoped servers (~/.labunbun/.mcp.json) are trusted like any other
	// setting the user wrote themselves. Project-scoped servers ship with the
	// repo's .mcp.json — a cloned/untrusted repo could otherwise auto-spawn
	// arbitrary commands or connect to arbitrary URLs with zero user action —
	// so they need one-time approval, persisted under the user's home directory
	// (~/.labunbun/projects/<cwd>/mcp-approved.json) where repo contents cannot
	// pre-approve them.
	const mcpConfig = loadMcpConfig(cwd);
	const projectMcpServerNames = loadProjectMcpServerNames(cwd);
	const approvedProjectMcpServers = loadApprovedMcpServers(cwd, home);
	const approvedMcpServers = new Set(
		Object.keys(mcpConfig).filter((name) => !projectMcpServerNames.has(name) || approvedProjectMcpServers.has(name)),
	);
	const mcpConnections = await connectAllMcpServers(mcpConfig, approvedMcpServers);
	const mcpTools = mcpConnections.flatMap((c) => c.tools);
	const pendingMcpApprovals = [...projectMcpServerNames].filter((name) => !approvedProjectMcpServers.has(name));

	// ---- subagents, skills, plan mode ----
	const agentDefinitions = loadAgentDefinitions(cwd);
	const taskTool = createTaskTool({
		streamFn,
		model,
		allTools: [...tools, ...mcpTools],
		definitions: agentDefinitions,
		store,
		permissionMode: effectiveMode,
		getPermissionRules: () => [...baseRules, ...sessionRules],
	});
	const skills = loadSkills(cwd);
	const planCallbacks: PlanModeCallbacks = createPlanModeCallbacks(
		() => sessionRef,
		() => handle,
	);
	let sessionRef: AgentSession | null = null;
	const planTools = createPlanModeTools(planCallbacks);
	const askUserTool = createAskUserQuestionTool({
		askUser: (questions) => (handle ? handle.askUser(questions) : Promise.resolve(null)),
	});

	const allTools = [...tools, ...mcpTools, taskTool, ...planTools, askUserTool];

	const systemPrompt = buildSystemPrompt(allTools, {
		cwd,
		platform: process.platform,
		isTTY: true,
		memory: memory.content,
	});

	/**
	 * Named so a hot-swap can hand the SAME deps object to the next session.
	 * Its closures read only holder-bound or let-bound state (compaction,
	 * store, sessionIdHolder, handle), so they stay correct across swaps.
	 */
	const sessionDeps: AgentDeps = {
		streamFn,
		// Read through the holder rather than a captured id: /resume swaps the
		// session, and the spills belong to whichever one is live.
		spillOutput: (request) => writeToolOutput(request, { cwd, sessionId: sessionIdHolder.current, home }),
		canUseTool: async (toolName, input, ctx) => {
			const decision = evaluatePermissions(toolName, input, {
				mode: ctx.mode,
				rules: [...baseRules, ...sessionRules],
				cwd,
			});
			if (decision.behavior !== "ask") return decision;
			// dontAsk has no dialog of its own — an unresolved ask fails closed
			// rather than falling through to the interactive prompt it exists to skip.
			if (ctx.mode === "dontAsk" || !handle) {
				return { behavior: "deny", message: "Permission required (dontAsk mode denies unresolved prompts)" };
			}
			// Notification: the session is about to block on a human. This is
			// the hook users wire to desktop alerts, so it fires before the
			// dialog appears rather than after it resolves.
			if (hooksRuntime.has("Notification")) {
				const outcome = await hooksRuntime.run("Notification", {
					tool_name: toolName,
					tool_input: input,
					session_id: sessionIdHolder.current,
					cwd,
				});
				// Advisory: a Notification hook cannot veto the dialog.
				reportHookErrors(handle, advisoryHookFailures("Notification", outcome));
			}
			const allowed = await requestPermissionOrAbort(handle, toolName, input, ctx.signal);
			return allowed ? { behavior: "allow" } : { behavior: "deny", message: "User denied permission" };
		},
		checkCompaction: async (context, options) => {
			try {
				if (hooksRuntime.has("PreCompact")) {
					const outcome = await hooksRuntime.run("PreCompact", {
						session_id: sessionIdHolder.current,
						cwd,
					});
					reportHookErrors(
						handle,
						outcome.errors.map((e) => `PreCompact hook failed: ${e}`),
					);
					if (outcome.blocked) {
						// A hook may veto this compaction pass; the threshold check
						// runs again next turn, so this defers rather than disables.
						pushInfo(handle, `Compaction skipped by PreCompact hook${outcome.reason ? `: ${outcome.reason}` : ""}`);
						// A veto can defer a pass the estimate asked for. It cannot defer
						// one the provider already refused: the next turn would send the
						// same request and get the same refusal. End the run with what
						// can actually be done about it instead.
						return options?.force ? { action: "blocked", message: compaction.blockedMessage() } : null;
					}
				}
				const decision = await compaction.check(context, options);
				// The cheap rung is not a compaction, and saying so is the whole
				// report: the user asked for nothing here, and the model is now
				// working from previews of older results. Silence would make that
				// indistinguishable from the transcript having been summarized.
				if (decision?.action === "reduced") {
					pushInfo(
						handle,
						`Context trimmed: ${decision.cleared.results} old tool result${decision.cleared.results === 1 ? "" : "s"} replaced by previews ` +
							`(${decision.cleared.chars.toLocaleString()} characters freed, no summarization needed).`,
					);
				}
				// The breaker has no other way to be seen. Silent, it looks like the
				// session simply stopped managing its context — until the run ends with
				// a request that cannot be sent, long after the failures that caused it.
				const tripped = compaction.isTripped;
				if (tripped !== breakerWarned) {
					breakerWarned = tripped;
					if (tripped) pushInfo(handle, COMPACTION_DISABLED_NOTICE);
				}
				return decision;
			} catch {
				return null; // circuit breaker handles repeated failures
			}
		},
		hooks: {
			transformContext: (context) => {
				// Hook-contributed context drains whenever it has accumulated, and
				// rides on the next user message so the cached system-prompt prefix
				// stays stable. Memory is not here: it is a section of the system
				// prompt, which is the only place that survives a compaction and
				// the only place the cache breakpoint covers.
				const hookContext = pendingHookContext.splice(0, pendingHookContext.length);
				if (hookContext.length === 0) return context;

				const prefix = hookContext.join("\n\n");
				const messages = [...context.messages];
				// Last user message, so hook context lands on the prompt it
				// belongs to rather than on stale history.
				for (let i = messages.length - 1; i >= 0; i--) {
					const message = messages[i];
					if (message.role === "user") {
						const text = typeof message.content === "string" ? message.content : "";
						messages[i] = {
							...message,
							content: `${prefix}\n\n---\n\n${text}`.trimEnd(),
						};
						break;
					}
				}
				return { ...context, messages };
			},
			beforeToolCall: async (toolName, input) => {
				// File checkpoint before mutations — powers /rewind.
				if (store && (toolName === "Edit" || toolName === "Write")) {
					snapshotCheckpoint(store, input);
				}
				if (!hooksRuntime.has("PreToolUse")) return undefined;
				const outcome = await hooksRuntime.run("PreToolUse", { tool_name: toolName, tool_input: input, cwd });
				reportHookErrors(
					handle,
					outcome.errors.map((e) => `PreToolUse hook failed: ${e}`),
				);
				if (outcome.blocked) return { block: true, reason: outcome.reason ?? "Blocked by PreToolUse hook" };
				return undefined;
			},
			afterToolCall: async (toolName, input) => {
				if (!hooksRuntime.has("PostToolUse")) return undefined;
				const outcome = await hooksRuntime.run("PostToolUse", { tool_name: toolName, tool_input: input, cwd });
				// Advisory: the call already ran, so a block has nothing to stop.
				reportHookErrors(handle, advisoryHookFailures("PostToolUse", outcome));
				return undefined;
			},
		},
	};

	const session = new AgentSession({
		model,
		systemPrompt,
		tools: allTools,
		store,
		cwd,
		permissionMode: effectiveMode,
		deps: sessionDeps,
	});
	sessionRef = session;

	// Restore the selected store's transcript for both --resume and --continue.
	// A newly created store simply has no messages yet. A compacted session
	// resumes from its boundary, not from the transcript the summary replaced.
	if (store) {
		session.messages.push(...store.contextMessages());
	}

	// ---- cost tracking + context indicator + session-scoped listeners ----
	const costTracker = new CostTracker(cwd);
	// "This session" is the conversation being opened, not the project it lives
	// in: a resumed one arrives having already spent what its messages record, and
	// leaving that out would make /cost report less the moment a session continues.
	costTracker.beginSession(store?.messages() ?? []);
	// @-mention file list for the prompt, cached with a short TTL.
	const fileCompleter = createFileCompleter(cwd);
	// Guards against a Stop hook that blocks every turn: each resume is only
	// allowed to be driven by a hook a bounded number of times per session.
	let stopHookResumes = 0;
	const MAX_STOP_HOOK_RESUMES = 10;

	/**
	 * Coding-agent-side session listeners (cost, context indicator, Stop hook).
	 * Extracted so a hot-swap can attach them to the incoming session and drop
	 * the ones on the outgoing one — the store subscription in app.tsx is
	 * rebound separately by setSession.
	 */
	let detachSessionListeners: (() => void) | null = null;
	function attachSessionListeners(target: AgentSession): void {
		// Edge-triggered state for the low-context warning, per attached session:
		// after a hot swap the incoming conversation has its own size.
		let contextLowWarned = false;
		detachSessionListeners?.();
		detachSessionListeners = target.on(async (event) => {
			if (event.type === "turn_end") {
				costTracker.recordUsage(event.message.provider, event.message.model, event.message.usage);
				costTracker.persist();
			}
			// Tool calls may have created or deleted files; the next user turn should
			// see the tree as it is now, not as it was when they last typed.
			if (event.type === "agent_end") fileCompleter.bust();
			// The one thing that happens between a turn starting and its first token,
			// and it can last minutes: with nothing said here, a provider that is
			// down reads exactly like an app that has hung.
			if (event.type === "retry") {
				pushInfo(handle, formatRetryNotice(event));
			}
			if (event.type === "turn_end" || event.type === "agent_end") {
				refreshContextInfo(target);
				// Said once per crossing. A warning repeated on every turn is a
				// warning nobody reads; a compaction — or a /trim — brings the
				// measurement back down and arms it again, which is what makes the
				// next crossing worth mentioning too.
				const info = contextInfoFor(target);
				if (isContextLow(info.usedTokens, info.threshold)) {
					if (!contextLowWarned) {
						contextLowWarned = true;
						pushInfo(handle, lowContextWarning(info.usedTokens, info.threshold));
					}
				} else {
					contextLowWarned = false;
				}
			}
			// Stop: the loop reached a natural end. A hook may send it back to work
			// (e.g. "tests still failing"), which followUp() does by design. Only
			// natural completion is resumable — an abort or error stays stopped.
			if (event.type === "agent_end" && event.reason === "completed") {
				if (hooksRuntime.has("Notification")) {
					const notification = await hooksRuntime.run("Notification", {
						session_id: sessionIdHolder.current,
						cwd,
					});
					reportHookErrors(handle, advisoryHookFailures("Notification", notification));
				}
				if (hooksRuntime.has("Stop")) {
					const outcome = await hooksRuntime.run("Stop", { session_id: sessionIdHolder.current, cwd });
					reportHookErrors(
						handle,
						outcome.errors.map((e) => `Stop hook failed: ${e}`),
					);
					if (outcome.blocked) {
						if (stopHookResumes >= MAX_STOP_HOOK_RESUMES) {
							pushInfo(
								handle,
								`Stop hook asked to continue but the per-session resume limit (${MAX_STOP_HOOK_RESUMES}) is reached.`,
							);
						} else {
							stopHookResumes++;
							const reason = outcome.reason ?? "Stop hook requested that work continue.";
							pushInfo(handle, `Continuing: ${reason}`);
							target.followUp(reason);
						}
					}
				}
			}
		});
	}

	/**
	 * Hot-swap the running REPL onto another saved session (in-app /resume):
	 * abort any in-flight work, rebuild the session and its compaction manager,
	 * rebind holders and listeners, and hand the new session to the UI.
	 *
	 * The incoming session is built with the same system prompt, memory files
	 * included, so there is nothing session-specific to re-inject: whatever the
	 * conversation being left behind had been told to work under, the one
	 * arriving is told too.
	 */
	async function hotSwapSession(summary: SessionSummary): Promise<void> {
		const loaded = loadSessionForResume(summary.path);
		if (!loaded || !handle) {
			pushInfo(handle, `Could not load session ${summary.sessionId}`);
			return;
		}
		if (sessionRef?.isRunning) sessionRef.abort();

		const current = sessionRef;
		const next = new AgentSession({
			model: current?.model ?? startupModel,
			systemPrompt,
			tools: [...(current?.tools ?? allTools)],
			store: loaded.store,
			cwd,
			permissionMode: effectiveMode,
			deps: sessionDeps,
		});
		next.messages.push(...loaded.messages);

		store = loaded.store;
		sessionIdHolder.current = loaded.store.sessionId ?? undefined;
		// The incoming conversation brings its own spend; without this the new one
		// would open carrying the totals of the session just left.
		costTracker.beginSession(loaded.store.messages());
		compaction = buildCompaction(next.model, loaded.store);
		thresholdHolder.current = compactionThreshold({
			contextWindow: next.model.contextWindow,
			maxOutputTokens: next.model.maxOutputTokens,
		});
		// The strip follows the conversation across the swap: the incoming session
		// brings its own list, and the store stopped being bound to the one being
		// left when `store` was reassigned above.
		restoreTasks(taskStore, loaded.store);
		handle.setTasks(taskStore.summary());
		handle.setSession(next);
		attachSessionListeners(next);
		refreshContextInfo(next);
		sessionRef = next;
		pushInfo(handle, `Resumed session ${summary.sessionId.slice(0, 8)} (${loaded.messages.length} messages).`);
	}

	/** Switch the active model mid-session (/model). Returns false when refused. */
	function switchModel(ref: string): boolean {
		const next = resolveModel(ref);
		if (!next) {
			pushInfo(handle, `Unknown model: ${ref}`);
			return false;
		}
		if (!resolveApiKey(next)) {
			pushInfo(handle, `No API key for ${next.provider} — set ${next.apiKeyEnv}. Model unchanged.`);
			return false;
		}
		sessionRef?.setModel(next);
		compaction = buildCompaction(next, store);
		thresholdHolder.current = compactionThreshold({
			contextWindow: next.contextWindow,
			maxOutputTokens: next.maxOutputTokens,
		});
		try {
			persistModelChoice(ref);
		} catch (error) {
			pushInfo(handle, `Model switched but not saved: ${error instanceof Error ? error.message : String(error)}`);
		}
		handle?.setModelName(`${next.provider}/${next.id}`);
		// Another window, another threshold, and typically another tool budget:
		// the indicator is measured against the model that is now selected.
		if (sessionRef) refreshContextInfo(sessionRef);
		pushInfo(handle, `Model: ${ref} — takes effect on the next prompt`);
		return true;
	}

	attachSessionListeners(session);
	// Before the first turn: the system prompt and the tool schemas are already
	// part of every request, and a resumed conversation arrives with its history.
	refreshContextInfo(session);

	// ---- command registry ----
	const commands: Command[] = [...builtInCommands(), ...skillsAsCommands(skills)];

	// ---- theme ----
	// Resolved before mounting: "auto" probes the terminal in raw mode, and Ink
	// claims stdin the moment it renders.
	const resolvedTheme = await resolveTheme(options.theme ?? settings.theme, cwd);

	// ---- REPL ----
	handle = mountRepl({
		session,
		modelName: `${model.provider}/${model.id}`,
		theme: resolvedTheme.theme,
		vimMode: settings.vimMode,
		// Both the registry commands and the app-level ones, so /help and Tab
		// completion cover everything that actually dispatches.
		commandSuggestions: [
			...completeCommands(commands, "").map((c) => [`/${c.name}`, c.description] as [string, string]),
			...appCommandTable(),
		].sort(([a], [b]) => a.localeCompare(b)),
		completeFiles: (query) => fileCompleter(query),
		dirName: basename(cwd),
		cwd,
		// Oldest first, which is the order ↑ recall walks backwards through.
		history: loadHistory(cwd),
		onAlwaysAllow: (toolName, input) => {
			// Scoped to what the user was looking at: `Bash(git *)`, not all of Bash.
			// No specifier means the tool could not be scoped, and the rule is the
			// bare tool — which is what every "don't ask again" answer used to mean.
			sessionRules.push({
				toolName,
				specifier: ruleSpecifierFor(toolName, input, cwd),
				behavior: "allow",
				source: "session",
			});
		},
		onSubmitText: async (text) => {
			appendHistory(text, cwd);
			// "!cmd" runs the shell directly — no model, no permission prompt (the
			// user typed the command themselves). The handled verdict keeps the
			// REPL from also pushing a user entry or prompting.
			if (text.startsWith("!")) {
				if (handle) await shellPassthrough.run(text.slice(1).trim(), handle.store);
				return { handled: true };
			}
			if (!hooksRuntime.has("UserPromptSubmit")) return undefined;
			const outcome = await hooksRuntime.run("UserPromptSubmit", {
				prompt: text,
				session_id: sessionIdHolder.current,
				cwd,
			});
			reportHookErrors(
				handle,
				outcome.errors.map((e) => `UserPromptSubmit hook failed: ${e}`),
			);
			// Context a hook attaches to this prompt rides along on the next
			// model call via transformContext.
			pendingHookContext.push(...outcome.addedContext);
			if (outcome.blocked) {
				return { block: true, reason: outcome.reason ?? "Prompt blocked by UserPromptSubmit hook" };
			}
			return undefined;
		},
		onMemoryShortcut: (note) => {
			if (!note) return;
			appendMemoryNote(note);
			pushInfo(handle, `Remembered: ${note}`);
		},
		onCommand: (text) =>
			handleCommandDispatch(text, {
				sessionRef,
				getSession: () => sessionRef,
				handle,
				backgroundShells,
				refreshBackgroundShells: publishShells,
				settings,
				cwd,
				home,
				costTracker,
				baseRules,
				sessionRules,
				commands,
				compaction: () => compaction,
				mcpConnections,
				mcpConfig,
				pendingMcpApprovals,
				sessionStore: () => store,
				theme: resolvedTheme,
				refreshContextInfo,
				memory: memory.content,
				hotSwapSession,
				switchModel,
			}),
	});

	// Task list → UI strip subscription.
	const unsubTasks = taskStore.subscribe(() => {
		handle?.setTasks(taskStore.summary());
	});
	// And the strip's starting state: a restored list is already there before any
	// task changes, so nothing would have pushed it to the UI.
	handle?.setTasks(taskStore.summary());

	/**
	 * Background shells → the status row.
	 *
	 * The manager has no change events, so this polls — the same shape as the task
	 * strip, which is pushed but could equally be polled. `setBackgroundShells`
	 * compares before publishing, so a tick that changed nothing costs one array
	 * walk and no render. Killing a shell publishes immediately rather than
	 * waiting out the interval: the row disappearing is the confirmation the
	 * command worked.
	 */
	const publishShells = () => {
		handle?.setBackgroundShells(
			backgroundShells.list().map((shell) => ({ id: shell.id, command: shell.command, status: shell.status })),
		);
	};
	const shellPoll = setInterval(publishShells, BACKGROUND_SHELL_POLL_MS);
	// A poll must not be the reason the process stays alive.
	shellPoll.unref();
	publishShells();

	// SessionStart ran before the REPL existed, so its failures surface now.
	reportHookErrors(handle, startupHookErrors);
	// Silently running in a weaker mode than the one asked for would be the
	// worst outcome here, so the veto is stated explicitly.
	if (downgradeReason) pushInfo(handle, `Warning: ${downgradeReason}`);
	// The catalog refresh started before there was anywhere to put an answer.
	if (catalogRefresh) {
		void catalogRefresh
			.then((refresh) => {
				const notice = formatCatalogNotice(refresh);
				if (notice) pushInfo(handle, notice);
			})
			.catch((error: unknown) => {
				// Fire-and-forget, but not silent: the refresh promises not to throw,
				// so a rejection here is a bug in it, and the only place it can be
				// seen is the screen.
				pushInfo(handle, `Model catalog refresh failed: ${error instanceof Error ? error.message : error}`);
			});
	}

	await handle.waitUntilExit();
	// Nothing is waiting for the answer, and an in-flight request would hold the
	// process open after the user has quit.
	catalogAbort.abort();
	unsubTasks();
	clearInterval(shellPoll);

	// How to come back to this conversation. Printed here rather than through the
	// REPL because the Ink frame owns the screen: a line written while it is up is
	// erased by the next render and never reaches the scrollback the user is about
	// to read. Only when there is something to resume, and only on a terminal.
	const summary = exitSummaryLine({
		sessionId: sessionIdHolder.current,
		messageCount: sessionRef?.messages.length ?? 0,
		cliName: CLI_NAME,
	});
	if (summary && process.stdout.isTTY) process.stdout.write(`\n${summary}\n`);

	// ---- SessionEnd: the UI is gone, so failures go to stderr. Never fatal —
	// a broken cleanup hook must not change the process exit code.
	const sessionEndOutcome = await hooksRuntime.run("SessionEnd", {
		session_id: sessionIdHolder.current,
		cwd,
	});
	for (const message of advisoryHookFailures("SessionEnd", sessionEndOutcome)) {
		console.error(`Warning: ${message}`);
	}
	return 0;
}

/**
 * Ask the UI for permission, with the run's abort as a second way out.
 *
 * Waiting for an answer is the one pipeline stage that depends on a human, and
 * the run can be aborted while the dialog is up (Ctrl+C, a hot-swap on /resume).
 * Without the race, that wait would outlive the run: the tool batch awaits this
 * call, so the turn would sit unfinished behind a question that no longer means
 * anything, and the next prompt would queue behind a session still marked
 * running. On abort the pending dialogs are denied and dismissed, which fails
 * closed and lets the aborted turn settle.
 */
async function requestPermissionOrAbort(
	handle: ReplAppHandle,
	toolName: string,
	input: unknown,
	signal?: AbortSignal,
): Promise<boolean> {
	const answer = handle.requestPermission(toolName, input);
	if (!signal) return answer;
	if (signal.aborted) {
		handle.clearPermissionRequest();
		return false;
	}

	let onAbort: (() => void) | undefined;
	const abort = new Promise<boolean>((resolve) => {
		onAbort = () => resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([answer, abort]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		// Deny anything still queued: whatever is left belongs to the aborted run.
		if (signal.aborted) handle.clearPermissionRequest();
	}
}

/** Surface hook failures in the transcript without interrupting the session. */
function reportHookErrors(handle: ReplAppHandle | null, messages: string[]): void {
	for (const message of messages) {
		pushInfo(handle, `Warning: ${message}`);
	}
}

function appendMemoryNote(note: string): void {
	const path = join(homedir(), ".labunbun", "MEMORY.md");
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `- ${note}\n`, "utf8");
	} catch {
		// best-effort
	}
}

const CHECKPOINT_MAX_CHARS = 200_000;

/** Snapshot a file's content before Edit/Write mutates it (for /rewind). */
function snapshotCheckpoint(store: SessionStore, input: unknown): void {
	try {
		const filePath = (input as { file_path?: unknown }).file_path;
		if (typeof filePath !== "string" || !existsSync(filePath)) return;
		const content = readFileSync(filePath, "utf8");
		if (content.length > CHECKPOINT_MAX_CHARS) return; // too large to inline
		store.appendCustom("file_checkpoint", { path: filePath, content, at: Date.now() });
	} catch {
		// best-effort — never block the tool call on checkpoint failure
	}
}

interface CheckpointInfo {
	entryId: string;
	path: string;
	at: number;
	content: string;
}

function listCheckpoints(store: SessionStore): CheckpointInfo[] {
	return store
		.linearEntries()
		.filter((e): e is Extract<SessionEntry, { type: "custom" }> => e.type === "custom" && e.kind === "file_checkpoint")
		.map((e) => {
			const data = e.data as { path?: string; content?: string; at?: number };
			return { entryId: e.id, path: data.path ?? "?", at: data.at ?? 0, content: data.content ?? "" };
		});
}

interface AppCommandContext {
	/** The live session, read at dispatch time — /resume may have swapped it. */
	getSession(): AgentSession | null;
	sessionRef: AgentSession | null;
	handle: ReplAppHandle | null;
	/** The shells the Bash tool started; `/ps` and `/stop` act on these. */
	backgroundShells: BackgroundShellAccess;
	/** Republish the status row after a shell changes state outside the poll. */
	refreshBackgroundShells(): void;
	settings: Settings;
	cwd: string;
	/** Home directory for user-owned state (MCP approvals). Defaults to the real one. */
	home?: string;
	costTracker: CostTracker;
	baseRules: PermissionRule[];
	sessionRules: PermissionRule[];
	commands: Command[];
	/** Read at dispatch time; a swap or model switch rebuilds the manager. */
	compaction(): CompactionManager;
	mcpConnections: McpConnection[];
	mcpConfig: Record<string, McpServerConfig>;
	pendingMcpApprovals: string[];
	sessionStore(): SessionStore | undefined;
	/** Theme resolved at startup; `/theme` reads its name and available list. */
	theme: ResolvedTheme;
	/** Republish the context indicator for a session whose context just changed. */
	refreshContextInfo(target: AgentSession): void;
	/** The memory files as loaded, which the system prompt carries; `/context` sizes them. */
	memory?: string;
	hotSwapSession(summary: SessionSummary): Promise<void>;
	switchModel(ref: string): boolean;
}

function handleCommandDispatch(text: string, ctx: AppCommandContext): boolean {
	const [rawName, ...rest] = text.split(/\s+/);
	const args = rest.join(" ");

	// Registry commands first (prompt-type expands into a model prompt).
	const command = findCommand(ctx.commands, rawName);
	if (command) {
		const session = ctx.getSession();
		if (!session) return true;
		if (command.type === "prompt") {
			ctx.handle?.store.set((s) => ({
				...s,
				entries: [...s.entries, { kind: "user", text }],
			}));
			void session.prompt(command.getPrompt(args));
			return true;
		}
		const localCtx: LocalCommandContext = {
			session,
			compaction: ctx.compaction(),
			cwd: ctx.cwd,
			pushInfo: (info) => pushInfo(ctx.handle, info),
			dialog: ctx.handle ?? undefined,
			refreshContext: () => ctx.refreshContextInfo(session),
		};
		void Promise.resolve(command.call(localCtx, args))
			.then((result) => {
				if (typeof result === "string" && result) pushInfo(ctx.handle, result);
			})
			.catch((error: unknown) => {
				// Fire-and-forget, but not silent: a command that throws is the user's
				// only signal that what they asked for did not happen.
				pushInfo(ctx.handle, `/${command.name} failed: ${error instanceof Error ? error.message : error}`);
			});
		return true;
	}

	return handleAppCommand(text, ctx);
}

/**
 * App-level commands, which live in `handleAppCommand`'s switch rather than in
 * the command registry. `/help` is generated from the command table, so a
 * command missing from this list is a command the user cannot discover — that
 * was the `/theme` bug. The switch below is the source of truth for behaviour;
 * `appCommandTable` keeps `/help` in step with it, and a test asserts the two
 * agree so a new `case` cannot be added without a description.
 */
export function appCommandTable(): Array<[string, string]> {
	return [
		["/context", "Show what the context window is made of, and what is left"],
		["/cost", "Show token usage and cost for this conversation, then for this project"],
		["/doctor", "Check the environment, settings, and provider setup"],
		["/export", "Export this session to a Markdown file: /export [path]"],
		["/fork", "Branch the session from an entry id: /fork <id>"],
		["/mcp", "List configured MCP servers and their tools"],
		["/mode", "Show or set the permission mode: /mode <mode>"],
		["/model", "Show or switch the model: /model [provider/id]"],
		["/permissions", "Show the active permission mode and rules"],
		["/ps", "List background shells and show what one has printed"],
		["/resume", "Resume an earlier session in this directory (pick from a list)"],
		["/rewind", "Restore a file from a checkpoint: /rewind [number]"],
		["/status", "Show model, context usage, cost, and settings at a glance"],
		["/stop", "Stop a background shell: /stop [id]"],
		["/theme", "Show or switch the theme: /theme [name|auto]"],
		["/tree", "Show the session branch tree"],
		["/vim", "Turn modal vim editing in the prompt on or off: /vim [on|off]"],
	];
}

function handleAppCommand(text: string, ctx: AppCommandContext): boolean {
	const [command] = text.split(/\s+/);
	const session = ctx.getSession();

	switch (command) {
		case "/cost": {
			pushInfo(ctx.handle, formatCostReport(ctx.costTracker.sessionState, ctx.costTracker.state));
			return true;
		}
		case "/permissions": {
			if (!session) return true;
			const rules = [...ctx.baseRules, ...ctx.sessionRules];
			const lines = [
				`Mode: ${session.permissionMode}`,
				`Rules (${rules.length}):`,
				...rules.map(
					(r) =>
						`  ${r.behavior === "allow" ? "allow" : "deny "} ${r.toolName}${r.specifier ? `(${r.specifier})` : ""}  [${r.source}]`,
				),
			];
			pushInfo(ctx.handle, lines.join("\n") || "(none)");
			return true;
		}
		case "/resume": {
			if (!session || !ctx.handle) return true;
			if (session.isRunning) {
				pushInfo(ctx.handle, "Interrupt the current run first (Esc), then /resume.");
				return true;
			}
			const sessions = listSessions(ctx.cwd);
			if (sessions.length === 0) {
				pushInfo(ctx.handle, "No saved sessions for this project.");
				return true;
			}
			void (async () => {
				const handleRef = ctx.handle;
				if (!handleRef) return;
				const items = sessions.map((s) => ({
					label: `${s.sessionId.slice(0, 8)}  ${new Date(s.mtimeMs).toLocaleString()}`,
					description: `${formatMessageCount(s)} msgs — ${s.firstUserText}`,
				}));
				const index = await handleRef.pickFromList("Resume a session", items);
				if (index === null) return;
				await ctx.hotSwapSession(sessions[index]);
			})();
			return true;
		}
		case "/model": {
			if (!ctx.handle) return true;
			const arg = text.split(/\s+/).slice(1).join(" ").trim();
			if (arg) {
				ctx.switchModel(arg);
				return true;
			}
			void (async () => {
				const handleRef = ctx.handle;
				if (!handleRef) return;
				const current = ctx.getSession()?.model;
				const models = listModels();
				const items = models.map((m) => {
					const ref = `${m.provider}/${m.id}`;
					const isActive = current && m.provider === current.provider && m.id === current.id;
					const hasKey = Boolean(resolveApiKey(m));
					return {
						label: `${isActive ? "* " : "  "}${ref}`,
						description: `${Math.round(m.contextWindow / 1000)}k context${hasKey ? "" : " — no API key"}`,
					};
				});
				const index = await handleRef.pickFromList("Switch model", items);
				if (index === null || index < 0 || index >= models.length) return;
				const chosen = models[index];
				ctx.switchModel(`${chosen.provider}/${chosen.id}`);
			})();
			return true;
		}
		case "/status": {
			if (!session) return true;
			const store = ctx.handle?.store;
			const info = store?.get().contextInfo;
			const storeId = ctx.sessionStore()?.sessionId;
			// The live editor, not the startup flag: `/vim` may have changed it since.
			const vim = store?.get().vim ?? ctx.settings.vimMode === true;
			ctx.handle?.setStatusCard({
				model: `${session.model.provider}/${session.model.id}`,
				directory: shortenHome(ctx.cwd, ctx.home),
				permissions: session.permissionMode,
				session: storeId ? storeId.slice(0, 8) : "(not persisted)",
				context: info,
				details: [
					[
						"Cost",
						`$${ctx.costTracker.sessionState.totalCostUSD.toFixed(4)} this session · ` +
							`$${ctx.costTracker.state.totalCostUSD.toFixed(4)} this project`,
					],
					["Theme", `${ctx.theme.theme.name} · Vim ${vim ? "on" : "off"}`],
					[
						"MCP",
						`${ctx.mcpConnections.length} connected${
							ctx.pendingMcpApprovals.length > 0 ? `, ${ctx.pendingMcpApprovals.length} pending approval` : ""
						}`,
					],
				],
			});
			// The card carries the detail; the transcript keeps the one line, so the
			// fact that it was asked for is still in the session's own history.
			pushInfo(
				ctx.handle,
				`Status: ${session.model.provider}/${session.model.id} · ${session.permissionMode} · ${
					storeId ? storeId.slice(0, 8) : "not persisted"
				}`,
			);
			return true;
		}
		case "/ps": {
			void (async () => {
				const shells = ctx.backgroundShells.list();
				if (shells.length === 0) {
					pushInfo(ctx.handle, "No background shells.");
					return;
				}
				if (!ctx.handle) return;
				const index = await ctx.handle.pickFromList("Background shells", shellPickerItems(shells));
				if (index === null || index >= shells.length) return;
				const shell = shells[index];
				// The tail, not the whole file: the question is what it is saying now,
				// and a dev server's log is mostly the first ten lines over and over.
				pushInfo(ctx.handle, formatShellOutput(shell.id, ctx.backgroundShells.output(shell.id)));
			})();
			return true;
		}
		case "/stop": {
			const arg = text.split(/\s+/).slice(1).join(" ").trim();
			const stop = (shell: BackgroundShell): void => {
				const killed = ctx.backgroundShells.kill(shell.id);
				ctx.refreshBackgroundShells();
				pushInfo(ctx.handle, killed ? `Stopped ${shell.id}.` : `${shell.id} is not running.`);
			};
			void (async () => {
				const all = ctx.backgroundShells.list();
				if (arg) {
					const target = resolveShellId(arg, all);
					if (!target) {
						pushInfo(ctx.handle, `No shell "${arg}". /ps lists them.`);
						return;
					}
					stop(target);
					return;
				}
				const running = all.filter((shell) => shell.status === "running");
				if (running.length === 0) {
					pushInfo(ctx.handle, "No background shells are running.");
					return;
				}
				if (!ctx.handle) return;
				const index = await ctx.handle.pickFromList("Stop a background shell", shellPickerItems(running));
				if (index === null || index >= running.length) return;
				stop(running[index]);
			})();
			return true;
		}
		case "/export": {
			if (!session) return true;
			const arg = text.split(/\s+/).slice(1).join(" ").trim();
			const id = ctx.sessionStore()?.sessionId ?? Date.now().toString(36);
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			const path = arg || join(ctx.cwd, `labunbun-${id.slice(0, 8)}-${stamp}.md`);
			try {
				writeFileSync(path, sessionToMarkdown(session.messages), "utf8");
				pushInfo(ctx.handle, `Session exported to ${path}`);
			} catch (error) {
				pushInfo(ctx.handle, `Export failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return true;
		}
		case "/mcp": {
			const [, sub, serverName] = text.split(/\s+/);
			if (sub === "approve" && serverName) {
				if (!ctx.pendingMcpApprovals.includes(serverName)) {
					pushInfo(ctx.handle, `No pending approval for "${serverName}". See /mcp for the list.`);
					return true;
				}
				const config = ctx.mcpConfig[serverName];
				if (!config) {
					pushInfo(ctx.handle, `Unknown server: ${serverName}`);
					return true;
				}
				persistMcpApproval(ctx.cwd, serverName, ctx.home);
				void connectMcpServer(serverName, config).then((connection) => {
					ctx.mcpConnections.push(connection);
					const index = ctx.pendingMcpApprovals.indexOf(serverName);
					if (index !== -1) ctx.pendingMcpApprovals.splice(index, 1);
					ctx.getSession()?.setTools([...(ctx.getSession()?.tools ?? []), ...connection.tools]);
					pushInfo(
						ctx.handle,
						connection.error
							? `Approved "${serverName}" but connection failed: ${connection.error}`
							: `Approved "${serverName}" — connected with ${connection.tools.length} tools.`,
					);
				});
				return true;
			}

			if (ctx.mcpConnections.length === 0 && ctx.pendingMcpApprovals.length === 0) {
				pushInfo(ctx.handle, "No MCP servers configured (.mcp.json or ~/.labunbun/.mcp.json).");
				return true;
			}
			const lines = ctx.mcpConnections.map((c) => {
				const status = c.error ? `✗ ${c.error}` : `✓ ${c.tools.length} tools`;
				return `  ${c.serverName}: ${status}`;
			});
			for (const name of ctx.pendingMcpApprovals) {
				lines.push(`  ${name}: pending approval — run /mcp approve ${name}`);
			}
			pushInfo(ctx.handle, `MCP servers:\n${lines.join("\n")}`);
			return true;
		}
		case "/permissions-mode":
		case "/mode": {
			const arg = text.split(/\s+/)[1] as PermissionMode | undefined;
			if (arg && ["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"].includes(arg)) {
				ctx.getSession()?.setPermissionMode(arg);
				pushInfo(ctx.handle, `Permission mode: ${arg}`);
			} else {
				pushInfo(ctx.handle, `Usage: /mode default|plan|acceptEdits|dontAsk|bypassPermissions`);
			}
			return true;
		}
		case "/tree": {
			const treeStore = ctx.sessionStore();
			if (!treeStore) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			const tree = treeStore.describeTree();
			const branches = treeStore.branchPoints();
			pushInfo(ctx.handle, `Session tree (* = active path, ${branches.length} branch point(s)):\n${tree}`);
			return true;
		}
		case "/fork": {
			const arg = text.split(/\s+/)[1];
			const forkSession = ctx.getSession();
			const forkStore = ctx.sessionStore();
			if (!forkStore || !forkSession) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			if (!arg) {
				pushInfo(ctx.handle, "Usage: /fork <entry-id> — see /tree for ids");
				return true;
			}
			if (!forkStore.branch(arg)) {
				pushInfo(ctx.handle, `Entry not found: ${arg}`);
				return true;
			}
			// Rebuild in-memory transcript from the new branch. The branch point may
			// sit above a compaction boundary, in which case the whole history from
			// there is live again — and below one, in which case it is not.
			forkSession.messages = forkStore.contextMessages();
			pushInfo(ctx.handle, `Branched from ${arg.slice(0, 8)}. New messages continue on this branch.`);
			return true;
		}
		case "/rewind": {
			const rewindStore = ctx.sessionStore();
			if (!rewindStore) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			const checkpoints = listCheckpoints(rewindStore);
			if (checkpoints.length === 0) {
				pushInfo(ctx.handle, "No checkpoints yet — they are captured before every Edit/Write.");
				return true;
			}
			const arg = text.split(/\s+/)[1];
			if (!arg) {
				const lines = checkpoints
					.slice(-10)
					.reverse()
					.map((c, i) => `${checkpoints.length - 1 - i}. ${new Date(c.at).toLocaleTimeString()}  ${c.path}`);
				pushInfo(ctx.handle, `Checkpoints (newest first). Restore with /rewind <number>:\n${lines.join("\n")}`);
				return true;
			}
			const index = Number(arg);
			if (!Number.isInteger(index) || index < 0 || index >= checkpoints.length) {
				pushInfo(ctx.handle, `Invalid checkpoint number: ${arg} (0-${checkpoints.length - 1})`);
				return true;
			}
			const checkpoint = checkpoints[index];
			try {
				writeFileSync(checkpoint.path, checkpoint.content, "utf8");
				pushInfo(
					ctx.handle,
					`Restored ${checkpoint.path} to the ${new Date(checkpoint.at).toLocaleTimeString()} state.`,
				);
			} catch (error) {
				pushInfo(ctx.handle, `Restore failed: ${error instanceof Error ? error.message : error}`);
			}
			return true;
		}
		case "/context": {
			if (!session) return true;
			const breakdown = contextBreakdown(session.currentContext());
			const limits = ctx.compaction().limits();
			ctx.handle?.setStatusCard({
				title: "Context",
				context: { usedTokens: breakdown.usedTokens, threshold: limits.threshold },
				details: contextRows(breakdown, limits, { memoryChars: ctx.memory?.length ?? 0 }),
			});
			pushInfo(ctx.handle, contextSummaryLine(breakdown, limits));
			return true;
		}
		case "/doctor": {
			void (async () => {
				const { runDoctorChecks, formatDoctorReport } = await import("./doctor.ts");
				const checks = await runDoctorChecks(ctx.settings, ctx.cwd);
				pushInfo(ctx.handle, formatDoctorReport(checks));
			})();
			return true;
		}
		case "/theme": {
			const arg = text.split(/\s+/)[1];
			void (async () => {
				/** Show a theme: the app's idea of the current one and the tree's. */
				const apply = (resolved: ResolvedTheme) => {
					ctx.theme.theme = resolved.theme;
					ctx.theme.available = resolved.available;
					ctx.handle?.setTheme(resolved.theme);
				};
				const save = (name: string, resolved: ResolvedTheme) => {
					try {
						persistThemeChoice(name, ctx.home);
						pushInfo(ctx.handle, `Theme: ${resolved.theme.name}${name === AUTO_THEME_NAME ? " (detected)" : ""}`);
					} catch (error) {
						// The theme is already applied; only the persistence failed.
						pushInfo(
							ctx.handle,
							`Theme: ${resolved.theme.name} (not saved: ${error instanceof Error ? error.message : String(error)})`,
						);
					}
				};
				if (arg) {
					const resolved = await resolveTheme(arg, ctx.cwd);
					// resolveTheme falls back to the default for an unknown name, so
					// check the name rather than trusting that a theme came back.
					if (arg !== AUTO_THEME_NAME && resolved.theme.name !== arg) {
						pushInfo(ctx.handle, `Unknown theme "${arg}". Available: ${resolved.available.join(", ")}`);
						return;
					}
					apply(resolved);
					save(arg, resolved);
					return;
				}

				// No name: pick from a list that previews itself. Every theme is
				// resolved up front — including `auto`, whose probe needs stdin and
				// cannot run while the picker owns the keyboard — so a highlight can
				// repaint the whole screen in the same keystroke.
				const previous = ctx.theme.theme;
				const previousAvailable = ctx.theme.available;
				const names = [...previousAvailable, AUTO_THEME_NAME];
				const resolved = await Promise.all(names.map((name) => resolveTheme(name, ctx.cwd)));
				if (!ctx.handle) return;
				const index = await ctx.handle.pickFromList(
					"Theme — the highlight is a preview",
					names.map((name, i) => ({
						label: `${name === previous.name ? "* " : "  "}${name}`,
						description:
							name === previous.name ? "active" : resolved[i].theme.name !== name ? resolved[i].theme.name : undefined,
					})),
					{
						onHighlight: (i) => apply(resolved[i]),
						onCancel: () => {
							ctx.theme.theme = previous;
							ctx.theme.available = previousAvailable;
							ctx.handle?.setTheme(previous);
						},
					},
				);
				if (index === null) return;
				apply(resolved[index]);
				save(names[index], resolved[index]);
			})();
			return true;
		}
		case "/vim": {
			const arg = text.split(/\s+/)[1]?.toLowerCase();
			if (arg && arg !== "on" && arg !== "off") {
				pushInfo(ctx.handle, "Usage: /vim [on|off] — with no argument it toggles");
				return true;
			}
			// Toggled from what is actually on, not from the settings file: /vim on
			// after a session that started in vim mode means off, and reading the
			// saved value would give the same answer every time.
			const next = arg ? arg === "on" : !(ctx.handle?.store.get().vim ?? false);
			ctx.handle?.setVimMode(next);
			try {
				writeUserSettingsPatch({ vimMode: next }, ctx.home);
				pushInfo(ctx.handle, `Vim mode ${next ? "on" : "off"}`);
			} catch (error) {
				// Already in effect; only the write failed.
				pushInfo(
					ctx.handle,
					`Vim mode ${next ? "on" : "off"} (not saved: ${error instanceof Error ? error.message : String(error)})`,
				);
			}
			return true;
		}
		default:
			return false;
	}
}

/**
 * What `/ps` and `/stop` need from the shell manager. Structural rather than the
 * class itself so a test can hand in shells without spawning anything.
 */
export interface BackgroundShellAccess {
	list(): BackgroundShell[];
	output(id: string, maxChars?: number): string;
	kill(id: string): boolean;
}

function pushInfo(handle: ReplAppHandle | null, text: string): void {
	handle?.store.set((s) => ({ ...s, entries: [...s.entries, { kind: "info", text }] }));
}

/**
 * A path as the user thinks of it, with `~` for their home directory.
 *
 * The status card is the one place the working directory is spelled out, and
 * `/Users/someone/projects/thing` is mostly noise next to `~/projects/thing`.
 * A home that is not a prefix (a `--cwd` outside it) is left exactly as given —
 * showing a partial match would be worse than showing the whole path.
 */
export function shortenHome(path: string, home: string | undefined): string {
	if (!home) return path;
	if (path === home) return "~";
	const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
	return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

export { type AppCommandContext, appendHistory, handleAppCommand, handleCommandDispatch };
