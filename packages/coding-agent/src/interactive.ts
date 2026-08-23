/**
 * Interactive mode: settings hierarchy → model resolution → tools →
 * permission engine + dialog bridge → Ink REPL with app-level commands.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type AgentDeps,
	AgentSession,
	CompactionManager,
	compactionThreshold,
	estimateContextTokens,
	evaluatePermissions,
	type PermissionMode,
	type PermissionRule,
	type SessionEntry,
	SessionStore,
} from "@labunbun/agent";
import {
	apiKeyEnvNames,
	createDefaultStreamFn,
	listModels,
	type Model,
	registerOpenAICompatibleProvider,
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
import { createAllTools, defaultOperations, type Operations, TaskStore } from "@labunbun/tools";
import { AUTO_THEME_NAME, mountRepl, type ReplAppHandle } from "@labunbun/tui";
import { createAskUserQuestionTool } from "./ask-user.ts";
import { builtInCommands, type Command, completeCommands, findCommand, type LocalCommandContext } from "./commands.ts";
import { CostTracker, formatCostState } from "./cost-tracker.ts";
import { sessionToMarkdown } from "./export-session.ts";
import { createFileCompleter } from "./file-completions.ts";
import { appendHistory, loadHistory } from "./history.ts";
import { advisoryHookFailures, snapshotHooks } from "./hooks.ts";
import { loadMemoryFiles } from "./memory.ts";
import { createPlanModeTools, type PlanModeCallbacks } from "./plan-mode.ts";
import { listSessions, loadSessionForResume, resolveContinueTarget, type SessionSummary } from "./session-resume.ts";
import {
	applySettingsEnv,
	collectPermissionRules,
	loadSettings,
	resolvePermissionMode,
	type Settings,
} from "./settings.ts";
import { createShellPassthrough } from "./shell-passthrough.ts";
import { loadSkills, skillsAsCommands } from "./skills.ts";
import { createTaskTool, loadAgentDefinitions } from "./subagents.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { persistThemeChoice, type ResolvedTheme, resolveTheme } from "./theme-file.ts";
import { persistModelChoice } from "./user-settings.ts";
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
}

export async function runInteractive(options: InteractiveOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();

	// ---- first-run setup (before settings load, so it can create them) ----
	if (shouldRunWizard()) await runWizard(cwd);

	// ---- settings & providers ----
	const loadedSettings = loadSettings(cwd);
	const { settings } = loadedSettings;
	// Before provider registration and the API-key check below, both of which
	// read process.env — a key configured via settings.env has to be in place
	// by then or it would have no effect at all.
	applySettingsEnv(settings);
	for (const provider of settings.providers?.openaiCompatible ?? []) {
		registerOpenAICompatibleProvider(provider);
	}

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

	// ---- session persistence: resume, continue, or new ----
	let store: SessionStore | undefined;
	if (options.resumeSessionId) {
		const resumeId = options.resumeSessionId;
		const sessions = listSessions(cwd);
		const match =
			sessions.find((s) => s.sessionId === resumeId) ?? sessions.find((s) => s.sessionId.includes(resumeId));
		if (!match) {
			console.error(`Session not found: ${options.resumeSessionId}`);
			return 1;
		}
		store = loadSessionForResume(match.path)?.store;
	} else if (options.continueLast) {
		// --resume wins when both are given; this is the shorthand.
		const target = resolveContinueTarget(cwd);
		if (target) {
			store = loadSessionForResume(target.path)?.store;
		}
		if (!store) {
			console.error("No previous session to continue — starting a new one.");
			store = SessionStore.startNew(cwd);
		}
	} else {
		store = SessionStore.startNew(cwd);
	}

	// ---- tools & session ----
	const taskStore = new TaskStore();
	// One shared Operations instance: the "!" shell passthrough and the Bash
	// tool must resolve shells and kill process trees identically.
	const ops: Operations = defaultOperations();
	const shellPassthrough = createShellPassthrough({ cwd, ops });
	const tools = createAllTools(cwd, { taskStore, operations: ops });
	const sessionRules: PermissionRule[] = [];
	const baseRules: PermissionRule[] = collectPermissionRules(loadedSettings);
	const requestedMode = options.permissionMode ?? settings.permissionMode ?? "default";
	const { mode: effectiveMode, downgradeReason } = resolvePermissionMode(requestedMode, loadedSettings);
	let handle: ReplAppHandle | null = null;

	// Memory files (LABUNBUN.md / AGENTS.md), injected into the first user
	// message to keep the cached system-prompt prefix byte-stable.
	const memory = loadMemoryFiles(cwd);
	let memoryInjected = false;

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
			{ contextWindow: forModel.contextWindow, maxOutputTokens: forModel.maxOutputTokens },
			{
				streamFn,
				store: forStore,
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
	// Read by the setContextInfo closure on every turn boundary.
	const thresholdHolder = {
		current: compactionThreshold({ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens }),
	};

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
	// so they need one-time approval, persisted to the gitignored local
	// settings file, before they're allowed to connect.
	const mcpConfig = loadMcpConfig(cwd);
	const projectMcpServerNames = loadProjectMcpServerNames(cwd);
	const approvedProjectMcpServers = loadApprovedMcpServers(cwd);
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
	const planCallbacks: PlanModeCallbacks = {
		enterPlanMode: () => sessionRef?.setPermissionMode("plan"),
		requestPlanApproval: async (plan) => {
			if (!handle) return { approved: true };
			const approved = await handle.requestPermission("ExitPlanMode", { plan });
			return { approved };
		},
	};
	let sessionRef: AgentSession | null = null;
	const planTools = createPlanModeTools(planCallbacks);
	const askUserTool = createAskUserQuestionTool({
		askUser: (questions) => (handle ? handle.askUser(questions) : Promise.resolve(null)),
	});

	const allTools = [...tools, ...mcpTools, taskTool, ...planTools, askUserTool];

	const systemPrompt = buildSystemPrompt(allTools, { cwd, platform: process.platform, isTTY: true });

	/**
	 * Named so a hot-swap can hand the SAME deps object to the next session.
	 * Its closures read only holder-bound or let-bound state (compaction,
	 * store, sessionIdHolder, handle), so they stay correct across swaps.
	 */
	const sessionDeps: AgentDeps = {
		streamFn,
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
			const allowed = await handle.requestPermission(toolName, input);
			return allowed ? { behavior: "allow" } : { behavior: "deny", message: "User denied permission" };
		},
		checkCompaction: async (context) => {
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
						return null;
					}
				}
				return await compaction.maybeCompact(context);
			} catch {
				return null; // circuit breaker handles repeated failures
			}
		},
		hooks: {
			transformContext: (context) => {
				// Memory files inject once; hook-contributed context drains
				// whenever it has accumulated. Both ride on the next user
				// message so the cached system-prompt prefix stays stable.
				const injectMemory = !memoryInjected && Boolean(memory.content);
				const hookContext = pendingHookContext.splice(0, pendingHookContext.length);
				if (!injectMemory && hookContext.length === 0) return context;
				if (injectMemory) memoryInjected = true;

				const prefix = [...(injectMemory ? [memory.content] : []), ...hookContext].join("\n\n");
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

	// Restore resumed transcript into memory.
	if (options.resumeSessionId && store) {
		session.messages.push(...store.messages());
	}

	// ---- cost tracking + context indicator + session-scoped listeners ----
	const costTracker = new CostTracker(cwd);
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
		detachSessionListeners?.();
		detachSessionListeners = target.on(async (event) => {
			if (event.type === "turn_end") {
				costTracker.recordUsage(event.message.provider, event.message.model, event.message.usage);
				costTracker.persist();
			}
			// Tool calls may have created or deleted files; the next user turn should
			// see the tree as it is now, not as it was when they last typed.
			if (event.type === "agent_end") fileCompleter.bust();
			if (handle && (event.type === "turn_end" || event.type === "agent_end")) {
				handle.setContextInfo({
					usedTokens: estimateContextTokens(target.messages),
					threshold: thresholdHolder.current,
				});
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
	 * Memory is NOT re-injected into a resumed session — memoryInjected stays
	 * consumed across swaps, matching how --resume behaves at startup.
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
		compaction = buildCompaction(next.model, loaded.store);
		thresholdHolder.current = compactionThreshold({
			contextWindow: next.model.contextWindow,
			maxOutputTokens: next.model.maxOutputTokens,
		});
		handle.setTasks([]);
		handle.setSession(next);
		attachSessionListeners(next);
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
		pushInfo(handle, `Model: ${ref} — takes effect on the next prompt`);
		return true;
	}

	attachSessionListeners(session);

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
		// Oldest first, which is the order ↑ recall walks backwards through.
		history: loadHistory(cwd),
		onAlwaysAllow: (toolName) => {
			sessionRules.push({ toolName, behavior: "allow", source: "session" });
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
				settings,
				cwd,
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
				hotSwapSession,
				switchModel,
			}),
	});

	// Task list → UI strip subscription.
	const unsubTasks = taskStore.subscribe(() => {
		handle?.setTasks(taskStore.summary());
	});

	// SessionStart ran before the REPL existed, so its failures surface now.
	reportHookErrors(handle, startupHookErrors);
	// Silently running in a weaker mode than the one asked for would be the
	// worst outcome here, so the veto is stated explicitly.
	if (downgradeReason) pushInfo(handle, `Warning: ${downgradeReason}`);

	await handle.waitUntilExit();
	unsubTasks();

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
	settings: Settings;
	cwd: string;
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
		};
		void Promise.resolve(command.call(localCtx, args)).then((result) => {
			if (typeof result === "string" && result) pushInfo(ctx.handle, result);
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
		["/cost", "Show token usage and cost for this session"],
		["/doctor", "Check the environment, settings, and provider setup"],
		["/export", "Export this session to a Markdown file: /export [path]"],
		["/fork", "Branch the session from an entry id: /fork <id>"],
		["/mcp", "List configured MCP servers and their tools"],
		["/mode", "Show or set the permission mode: /mode <mode>"],
		["/model", "Show or switch the model: /model [provider/id]"],
		["/permissions", "Show the active permission mode and rules"],
		["/resume", "Resume an earlier session in this directory (pick from a list)"],
		["/rewind", "Restore a file from a checkpoint: /rewind [number]"],
		["/status", "Show model, context usage, cost, and settings at a glance"],
		["/theme", "Show or switch the theme: /theme [name|auto]"],
		["/tree", "Show the session branch tree"],
	];
}

function handleAppCommand(text: string, ctx: AppCommandContext): boolean {
	const [command] = text.split(/\s+/);
	const session = ctx.getSession();

	switch (command) {
		case "/cost": {
			pushInfo(ctx.handle, formatCostState(ctx.costTracker.state));
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
					description: `${s.messageCount} msgs — ${s.firstUserText}`,
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
			const info = ctx.handle?.store.get().contextInfo;
			const storeId = ctx.sessionStore()?.sessionId;
			const lines = [
				`Model: ${session.model.provider}/${session.model.id}`,
				`Permission mode: ${session.permissionMode}`,
				`Session: ${storeId ? storeId.slice(0, 8) : "(not persisted)"}`,
				info
					? `Context: ~${info.usedTokens.toLocaleString()} tokens (auto-compacts near ${info.threshold.toLocaleString()})`
					: "Context: measured after the first turn",
				`Cost this project (all sessions): $${ctx.costTracker.state.totalCostUSD.toFixed(4)}`,
				`Theme: ${ctx.theme.theme.name} · Vim: ${ctx.settings.vimMode ? "on" : "off"}`,
				`MCP servers: ${ctx.mcpConnections.length} connected${
					ctx.pendingMcpApprovals.length > 0 ? `, ${ctx.pendingMcpApprovals.length} pending approval` : ""
				}`,
			];
			pushInfo(ctx.handle, lines.join("\n"));
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
				persistMcpApproval(ctx.cwd, serverName);
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
			// Rebuild in-memory transcript from the new branch.
			forkSession.messages = forkStore.messages();
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
			if (!arg) {
				const lines = ctx.theme.available.map((name) => `  ${name === ctx.theme.theme.name ? "*" : " "} ${name}`);
				pushInfo(
					ctx.handle,
					[
						`Themes (* = active):`,
						...lines,
						`  ${AUTO_THEME_NAME === ctx.theme.theme.name ? "*" : " "} ${AUTO_THEME_NAME} — follow the terminal background`,
						"",
						`/theme <name> applies it now and saves it to ~/.labunbun/settings.json`,
					].join("\n"),
				);
				return true;
			}
			void (async () => {
				const resolved = await resolveTheme(arg, ctx.cwd);
				// resolveTheme falls back to the default for an unknown name, so
				// check the name rather than trusting that a theme came back.
				if (arg !== AUTO_THEME_NAME && resolved.theme.name !== arg) {
					pushInfo(ctx.handle, `Unknown theme "${arg}". Available: ${resolved.available.join(", ")}`);
					return;
				}
				ctx.theme.theme = resolved.theme;
				ctx.theme.available = resolved.available;
				ctx.handle?.setTheme(resolved.theme);
				try {
					persistThemeChoice(arg);
					pushInfo(ctx.handle, `Theme: ${resolved.theme.name}${arg === AUTO_THEME_NAME ? " (detected)" : ""}`);
				} catch (error) {
					// The theme is already applied; only the persistence failed.
					pushInfo(
						ctx.handle,
						`Theme: ${resolved.theme.name} (not saved: ${error instanceof Error ? error.message : String(error)})`,
					);
				}
			})();
			return true;
		}
		default:
			return false;
	}
}

function pushInfo(handle: ReplAppHandle | null, text: string): void {
	handle?.store.set((s) => ({ ...s, entries: [...s.entries, { kind: "info", text }] }));
}

export { type AppCommandContext, appendHistory, handleAppCommand };
