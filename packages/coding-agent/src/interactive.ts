/**
 * Interactive mode: settings hierarchy → model resolution → tools →
 * permission engine + dialog bridge → Ink REPL with app-level commands.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
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
import { createDefaultStreamFn, registerOpenAICompatibleProvider, resolveModel, withModelFallback } from "@labunbun/ai";
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
import { createAllTools, TaskStore } from "@labunbun/tools";
import { mountRepl, type ReplAppHandle } from "@labunbun/tui";
import { createAskUserQuestionTool } from "./ask-user.ts";
import { builtInCommands, type Command, completeCommands, findCommand, type LocalCommandContext } from "./commands.ts";
import { CostTracker, formatCostState } from "./cost-tracker.ts";
import { appendHistory } from "./history.ts";
import { advisoryHookFailures, snapshotHooks } from "./hooks.ts";
import { loadMemoryFiles } from "./memory.ts";
import { createPlanModeTools, type PlanModeCallbacks } from "./plan-mode.ts";
import { formatSessionList, listSessions, loadSessionForResume } from "./session-resume.ts";
import {
	applySettingsEnv,
	collectPermissionRules,
	loadSettings,
	resolvePermissionMode,
	type Settings,
} from "./settings.ts";
import { loadSkills, skillsAsCommands } from "./skills.ts";
import { createTaskTool, loadAgentDefinitions } from "./subagents.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

export interface InteractiveOptions {
	modelRef?: string;
	permissionMode?: PermissionMode;
	resumeSessionId?: string;
	cwd?: string;
	theme?: "dark" | "light";
}

export async function runInteractive(options: InteractiveOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();

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
	if (!process.env[model.apiKeyEnv]) {
		console.error(
			`Missing API key for ${model.provider}: set ${model.apiKeyEnv} in your environment.\n` +
				`Example: export ${model.apiKeyEnv}=sk-...`,
		);
		return 1;
	}

	// ---- session persistence: resume or new ----
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
	} else {
		store = SessionStore.startNew(cwd);
	}

	// ---- tools & session ----
	const taskStore = new TaskStore();
	const tools = createAllTools(cwd, { taskStore });
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

	// Compaction.
	const compactionThresholdValue = compactionThreshold({
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxOutputTokens,
	});
	const compaction = new CompactionManager(
		{ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
		{
			streamFn,
			store,
			readFile: (path) => {
				try {
					return readFileSync(path, "utf8");
				} catch {
					return null;
				}
			},
		},
	);

	// ---- user hooks (snapshotted at startup against mid-session injection) ----
	const hooksRuntime = snapshotHooks(settings.hooks);
	const sessionId = store?.sessionId ?? undefined;

	// Context contributed by hooks (SessionStart / UserPromptSubmit). Injected
	// into the next user message alongside memory, so the cached system-prompt
	// prefix stays byte-stable.
	const pendingHookContext: string[] = [];

	// ---- SessionStart: runs before the REPL mounts, so its context is
	// available to the very first prompt. Errors are reported, never fatal.
	const sessionStartOutcome = await hooksRuntime.run("SessionStart", { session_id: sessionId, cwd });
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

	const session = new AgentSession({
		model,
		systemPrompt: buildSystemPrompt(allTools, { cwd, platform: process.platform, isTTY: true }),
		tools: allTools,
		store,
		cwd,
		permissionMode: effectiveMode,
		deps: {
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
						session_id: sessionId,
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
						const outcome = await hooksRuntime.run("PreCompact", { session_id: sessionId, cwd });
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
		},
	});
	sessionRef = session;

	// Restore resumed transcript into memory.
	if (options.resumeSessionId && store) {
		session.messages.push(...store.messages());
	}

	// ---- cost tracking + context indicator ----
	const costTracker = new CostTracker(cwd);
	// Guards against a Stop hook that blocks every turn: each resume is only
	// allowed to be driven by a hook a bounded number of times per session.
	let stopHookResumes = 0;
	const MAX_STOP_HOOK_RESUMES = 10;
	session.on(async (event) => {
		if (event.type === "turn_end") {
			costTracker.recordUsage(event.message.provider, event.message.model, event.message.usage);
			costTracker.persist();
		}
		if (handle && (event.type === "turn_end" || event.type === "agent_end")) {
			handle.setContextInfo({
				usedTokens: estimateContextTokens(session.messages),
				threshold: compactionThresholdValue,
			});
		}
		// Stop: the loop reached a natural end. A hook may send it back to work
		// (e.g. "tests still failing"), which followUp() does by design. Only
		// natural completion is resumable — an abort or error stays stopped.
		if (event.type === "agent_end" && event.reason === "completed" && hooksRuntime.has("Stop")) {
			const outcome = await hooksRuntime.run("Stop", { session_id: sessionId, cwd });
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
					session.followUp(reason);
				}
			}
		}
	});

	// ---- command registry ----
	const commands: Command[] = [...builtInCommands(), ...skillsAsCommands(skills)];

	// ---- REPL ----
	handle = mountRepl({
		session,
		modelName: `${model.provider}/${model.id}`,
		theme: options.theme ?? settings.theme,
		vimMode: settings.vimMode,
		commandSuggestions: completeCommands(commands, "").map((c) => [`/${c.name}`, c.description] as [string, string]),
		onAlwaysAllow: (toolName) => {
			sessionRules.push({ toolName, behavior: "allow", source: "session" });
		},
		onSubmitText: async (text) => {
			appendHistory(text, cwd);
			if (!hooksRuntime.has("UserPromptSubmit")) return undefined;
			const outcome = await hooksRuntime.run("UserPromptSubmit", { prompt: text, session_id: sessionId, cwd });
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
				session,
				handle,
				settings,
				cwd,
				costTracker,
				baseRules,
				sessionRules,
				commands,
				compaction,
				mcpConnections,
				mcpConfig,
				pendingMcpApprovals,
				sessionStore: store,
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
	const sessionEndOutcome = await hooksRuntime.run("SessionEnd", { session_id: sessionId, cwd });
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
	session: AgentSession;
	handle: ReplAppHandle | null;
	settings: Settings;
	cwd: string;
	costTracker: CostTracker;
	baseRules: PermissionRule[];
	sessionRules: PermissionRule[];
	commands: Command[];
	compaction: CompactionManager;
	mcpConnections: McpConnection[];
	mcpConfig: Record<string, McpServerConfig>;
	pendingMcpApprovals: string[];
	sessionStore?: SessionStore;
}

function handleCommandDispatch(text: string, ctx: AppCommandContext): boolean {
	const [rawName, ...rest] = text.split(/\s+/);
	const args = rest.join(" ");

	// Registry commands first (prompt-type expands into a model prompt).
	const command = findCommand(ctx.commands, rawName);
	if (command) {
		if (command.type === "prompt") {
			ctx.handle?.store.set((s) => ({
				...s,
				entries: [...s.entries, { kind: "user", text }],
			}));
			void ctx.session.prompt(command.getPrompt(args));
			return true;
		}
		const localCtx: LocalCommandContext = {
			session: ctx.session,
			compaction: ctx.compaction,
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

function handleAppCommand(text: string, ctx: AppCommandContext): boolean {
	const [command] = text.split(/\s+/);

	switch (command) {
		case "/cost": {
			pushInfo(ctx.handle, formatCostState(ctx.costTracker.state));
			return true;
		}
		case "/permissions": {
			const rules = [...ctx.baseRules, ...ctx.sessionRules];
			const lines = [
				`Mode: ${ctx.session.permissionMode}`,
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
			const sessions = listSessions(ctx.cwd);
			pushInfo(ctx.handle, formatSessionList(sessions));
			pushInfo(ctx.handle, "Restart with --resume <session-id> to continue one of these.");
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
					ctx.session.setTools([...ctx.session.tools, ...connection.tools]);
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
				ctx.session.setPermissionMode(arg);
				pushInfo(ctx.handle, `Permission mode: ${arg}`);
			} else {
				pushInfo(ctx.handle, `Usage: /mode default|plan|acceptEdits|dontAsk|bypassPermissions`);
			}
			return true;
		}
		case "/tree": {
			if (!ctx.sessionStore) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			const tree = ctx.sessionStore.describeTree();
			const branches = ctx.sessionStore.branchPoints();
			pushInfo(ctx.handle, `Session tree (* = active path, ${branches.length} branch point(s)):\n${tree}`);
			return true;
		}
		case "/fork": {
			const arg = text.split(/\s+/)[1];
			const store = ctx.sessionStore;
			if (!store) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			if (!arg) {
				pushInfo(ctx.handle, "Usage: /fork <entry-id> — see /tree for ids");
				return true;
			}
			if (!store.branch(arg)) {
				pushInfo(ctx.handle, `Entry not found: ${arg}`);
				return true;
			}
			// Rebuild in-memory transcript from the new branch.
			ctx.session.messages = store.messages();
			pushInfo(ctx.handle, `Branched from ${arg.slice(0, 8)}. New messages continue on this branch.`);
			return true;
		}
		case "/rewind": {
			const rewindStore = ctx.sessionStore;
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
			if (arg === "dark" || arg === "light") {
				pushInfo(
					ctx.handle,
					`Theme "${arg}" takes effect on next launch (persist via settings.json: {"theme":"${arg}"}).`,
				);
			} else {
				pushInfo(ctx.handle, `Usage: /theme dark|light — persists in ~/.labunbun/settings.json`);
			}
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
