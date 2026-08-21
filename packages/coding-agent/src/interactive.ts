/**
 * Interactive mode: settings hierarchy → model resolution → tools →
 * permission engine + dialog bridge → Ink REPL with app-level commands.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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
	parseRuleList,
	SessionStore,
} from "@labunbun/agent";
import { createDefaultStreamFn, registerOpenAICompatibleProvider, resolveModel } from "@labunbun/ai";
import { connectAllMcpServers, loadMcpConfig, type McpConnection } from "@labunbun/mcp";
import { createAllTools } from "@labunbun/tools";
import { mountRepl, type ReplAppHandle } from "@labunbun/tui";
import { builtInCommands, type Command, completeCommands, findCommand, type LocalCommandContext } from "./commands.ts";
import { CostTracker, formatCostState } from "./cost-tracker.ts";
import { appendHistory, loadHistory } from "./history.ts";
import { snapshotHooks } from "./hooks.ts";
import { loadMemoryFiles } from "./memory.ts";
import { createPlanModeTools, type PlanModeCallbacks } from "./plan-mode.ts";
import { formatSessionList, listSessions, loadSessionForResume } from "./session-resume.ts";
import { loadSettings, type Settings } from "./settings.ts";
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
	const { settings } = loadSettings(cwd);
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
		const sessions = listSessions(cwd);
		const match =
			sessions.find((s) => s.sessionId === options.resumeSessionId) ??
			sessions.find((s) => s.sessionId.includes(options.resumeSessionId!));
		if (!match) {
			console.error(`Session not found: ${options.resumeSessionId}`);
			return 1;
		}
		store = loadSessionForResume(match.path)?.store;
	} else {
		store = SessionStore.startNew(cwd);
	}

	// ---- tools & session ----
	const tools = createAllTools(cwd);
	const sessionRules: PermissionRule[] = [];
	const baseRules: PermissionRule[] = [
		...parseRuleList(settings.permissions.deny, "deny", "userSettings"),
		...parseRuleList(settings.permissions.allow, "allow", "userSettings"),
	];
	let handle: ReplAppHandle | null = null;

	// Memory files (LABUNBUN.md / AGENTS.md), injected into the first user
	// message to keep the cached system-prompt prefix byte-stable.
	const memory = loadMemoryFiles(cwd);
	let memoryInjected = false;

	// Compaction.
	const compactionThresholdValue = compactionThreshold({
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxOutputTokens,
	});
	const compaction = new CompactionManager(
		{ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens },
		{
			streamFn: createDefaultStreamFn(),
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

	// ---- MCP servers ----
	const mcpConnections = await connectAllMcpServers(loadMcpConfig(cwd));
	const mcpTools = mcpConnections.flatMap((c) => c.tools);

	// ---- subagents, skills, plan mode ----
	const agentDefinitions = loadAgentDefinitions(cwd);
	const taskTool = createTaskTool({
		streamFn: createDefaultStreamFn(),
		model,
		allTools: [...tools, ...mcpTools],
		definitions: agentDefinitions,
		store,
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

	const allTools = [...tools, ...mcpTools, taskTool, ...planTools];

	const session = new AgentSession({
		model,
		systemPrompt: buildSystemPrompt(allTools, { cwd, platform: process.platform, isTTY: true }),
		tools: allTools,
		store,
		cwd,
		permissionMode: options.permissionMode ?? settings.permissionMode ?? "default",
		deps: {
			streamFn: createDefaultStreamFn(),
			canUseTool: async (toolName, input, ctx) => {
				const decision = evaluatePermissions(toolName, input, {
					mode: ctx.mode,
					rules: [...baseRules, ...sessionRules],
					cwd,
				});
				if (decision.behavior !== "ask" || !handle) return decision;
				const allowed = await handle.requestPermission(toolName, input);
				return allowed ? { behavior: "allow" } : { behavior: "deny", message: "User denied permission" };
			},
			checkCompaction: async (context) => {
				try {
					return await compaction.maybeCompact(context);
				} catch {
					return null; // circuit breaker handles repeated failures
				}
			},
			hooks: {
				transformContext: (context) => {
					if (memoryInjected || !memory.content) return context;
					memoryInjected = true;
					const messages = [...context.messages];
					for (let i = 0; i < messages.length; i++) {
						const message = messages[i];
						if (message.role === "user") {
							const text = typeof message.content === "string" ? message.content : "";
							messages[i] = {
								...message,
								content: `${memory.content}\n\n---\n\n${text}`.trimEnd(),
							};
							break;
						}
					}
					return { ...context, messages };
				},
				beforeToolCall: async (toolName, input) => {
					if (!hooksRuntime.has("PreToolUse")) return undefined;
					const outcome = await hooksRuntime.run("PreToolUse", { tool_name: toolName, tool_input: input, cwd });
					if (outcome.blocked) return { block: true, reason: outcome.reason ?? "Blocked by PreToolUse hook" };
					return undefined;
				},
				afterToolCall: async (toolName, input) => {
					if (!hooksRuntime.has("PostToolUse")) return undefined;
					await hooksRuntime.run("PostToolUse", { tool_name: toolName, tool_input: input, cwd });
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
	session.on((event) => {
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
	});

	// ---- command registry ----
	const commands: Command[] = [...builtInCommands(), ...skillsAsCommands(skills)];

	// ---- REPL ----
	handle = mountRepl({
		session,
		modelName: `${model.provider}/${model.id}`,
		theme: options.theme ?? settings.theme,
		commandSuggestions: completeCommands(commands, "").map((c) => [`/${c.name}`, c.description] as [string, string]),
		onAlwaysAllow: (toolName) => {
			sessionRules.push({ toolName, behavior: "allow", source: "session" });
		},
		onSubmitText: (text) => appendHistory(text, cwd),
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
			}),
	});

	await handle.waitUntilExit();
	return 0;
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
			if (ctx.mcpConnections.length === 0) {
				pushInfo(ctx.handle, "No MCP servers configured (.mcp.json or ~/.labunbun/.mcp.json).");
				return true;
			}
			const lines = ctx.mcpConnections.map((c) => {
				const status = c.error ? `✗ ${c.error}` : `✓ ${c.tools.length} tools`;
				return `  ${c.serverName}: ${status}`;
			});
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
				pushInfo(ctx.handle, `Theme "${arg}" takes effect on next launch (persist via settings.json: {"theme":"${arg}"}).`);
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

export { appendHistory };
