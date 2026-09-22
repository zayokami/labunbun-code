/**
 * Subagents: agent definitions (frontmatter .md) + the Task tool that runs
 * nested AgentSessions. Subagent transcripts persist as sidechain entries in
 * the parent's session tree, and the final assistant text returns to the
 * parent as the tool result.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AgentSession,
	type AnyTool,
	buildTool,
	evaluatePermissions,
	type PermissionMode,
	type PermissionRule,
	type SessionStore,
} from "@labunbun/agent";
import type { Model, StreamFn } from "@labunbun/ai";
import { textContent } from "@labunbun/ai";
import { z } from "zod";
import { createCompactionWiring } from "./compaction-wiring.ts";
import { isProjectTierTrusted } from "./project-trust.ts";

export interface AgentDefinition {
	agentType: string;
	whenToUse: string;
	/** Tool names the agent may use; undefined = inherit all. */
	tools?: string[];
	model?: string;
	maxTurns?: number;
	source: "builtin" | "user" | "project";
	/**
	 * Markdown body after the frontmatter — the subagent's system prompt. This
	 * is where a hand-written agent says what it is actually for, so dropping it
	 * silently turned every custom agent into its own one-line description.
	 */
	body?: string;
}

/**
 * System prompt for a subagent: the definition's body when it has one, and the
 * generic fallback otherwise. Exported so the fallback wording is pinned by a
 * test rather than re-derived at each call site.
 */
export function agentSystemPrompt(definition: AgentDefinition): string {
	return (
		definition.body ??
		`You are ${definition.agentType}, a focused subagent. ${definition.whenToUse}\nComplete the task and report results concisely.`
	);
}

/** Split a frontmatter `.md` into its key/value header and its markdown body. */
export function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { data: {}, body: content };
	const data: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { data, body: content.slice(match[0].length) };
}

function loadDefinitionsFromDir(dir: string, source: "user" | "project"): AgentDefinition[] {
	const out: AgentDefinition[] = [];
	if (!existsSync(dir)) return out;
	try {
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".md")) continue;
			try {
				const { data, body } = parseFrontmatter(readFileSync(join(dir, name), "utf8"));
				const agentType = data.name ?? data.agent ?? name.replace(/\.md$/, "");
				if (!agentType) continue;
				out.push({
					agentType,
					whenToUse: data.description ?? data.whenToUse ?? "",
					tools: data.tools ? data.tools.split(",").map((t) => t.trim()) : undefined,
					model: data.model || undefined,
					maxTurns: data.maxTurns ? Number(data.maxTurns) : undefined,
					source,
					body: body.trim() || undefined,
				});
			} catch {}
		}
	} catch {
		return out;
	}
	return out;
}

function projectAgentDefinitions(cwd: string): AgentDefinition[] {
	return loadDefinitionsFromDir(join(cwd, ".labunbun", "agents"), "project");
}

/**
 * The user tier always, the project tier only once this directory is trusted.
 *
 * An agent definition becomes the system prompt of every subagent spawned from
 * it, so a repository that ships one is a repository that writes the agent's
 * instructions — see `project-trust.ts` for why that needs one approval, and for
 * why the ledger sits outside the working tree.
 */
export function loadAgentDefinitions(cwd: string, home = homedir()): AgentDefinition[] {
	const project = isProjectTierTrusted(cwd, "agents", home) ? projectAgentDefinitions(cwd) : [];
	return [...loadDefinitionsFromDir(join(home, ".labunbun", "agents"), "user"), ...project];
}

/**
 * The project definitions the trust gate is holding back, for a dialog to offer.
 *
 * Read through the same reader as the loader, so a listing and the thing a user
 * then approves cannot disagree about what is there.
 */
export function withheldProjectAgents(cwd: string, home = homedir()): AgentDefinition[] {
	if (isProjectTierTrusted(cwd, "agents", home)) return [];
	return projectAgentDefinitions(cwd);
}

export interface TaskToolContext {
	streamFn: StreamFn;
	/**
	 * The parent session's model, read at the call.
	 *
	 * A reader rather than a value because `/model` swaps it mid-session: a
	 * subagent spawned afterwards has to run on the model the user chose. The
	 * staleness would not be cosmetic — the subagent's own compaction threshold
	 * is computed from this model's window, so a captured one compacts at the
	 * window the session left behind.
	 */
	model: () => Model;
	/**
	 * Resolve an agent definition's `model:` frontmatter to a model, or undefined
	 * when the name means nothing — a definition left in a directory after its
	 * model was retired is a fallback, not a failed spawn.
	 */
	resolveModel?: (ref: string) => Model | undefined;
	allTools: AnyTool[];
	/** Read at the call: a definition approved mid-session joins the list. */
	definitions: () => AgentDefinition[];
	/** Read at the call: `/resume` swaps the session a sidechain is written into. */
	store?: () => SessionStore | undefined;
	systemPromptFor?: (agent: AgentDefinition) => string;
	/** Read at the call: the parent's mode follows EnterPlanMode and `/resume`. */
	permissionMode?: () => PermissionMode | undefined;
	/** Resolved fresh per call so session-scoped allow rules added mid-conversation apply to new subagents. */
	getPermissionRules?: () => PermissionRule[];
	/**
	 * Where a subagent's own context management is announced. A subagent that
	 * summarizes its conversation does so out of sight of both the user and the
	 * parent session — this is the only line that says it happened.
	 */
	report?: (text: string) => void;
	/** `settings.trimOldToolResults`, passed through to the subagent's own manager. */
	trimOldToolResults?: boolean;
}

export const GENERAL_PURPOSE: AgentDefinition = {
	agentType: "general-purpose",
	whenToUse: "General-purpose agent for researching questions and executing multi-step tasks",
	source: "builtin",
};

/**
 * The agent types there are, as the model reads them to pick one.
 *
 * `subagent_type` used to be a bare string with nothing, anywhere, naming the
 * types that exist: a definition's `whenToUse` was parsed, listed by `/agents`
 * and then never shown to the one caller that has to choose between them, so a
 * session shipping a `researcher` agent could only reach it by guessing the name
 * and reading the error the guess earned. Built once, when the tool is built,
 * because the wire tool list is frozen for the session to keep the prompt prefix
 * cacheable (`session.ts`): a definition approved mid-session is reachable by
 * name — the tool resolves it at the call — but is advertised from the next
 * start.
 */
export function agentCatalogue(definitions: AgentDefinition[]): string {
	return [GENERAL_PURPOSE, ...definitions]
		.map((definition) =>
			definition.whenToUse ? `- ${definition.agentType}: ${definition.whenToUse}` : `- ${definition.agentType}`,
		)
		.join("\n");
}

/** Create the Task tool: spawns a nested AgentSession per invocation. */
export function createTaskTool(ctx: TaskToolContext): AnyTool {
	return buildTool({
		name: "Task",
		description:
			"Launch a subagent to handle a self-contained task. The subagent has its own context window " +
			"and returns its final report as the tool result. Use for parallel research or isolating " +
			"context-heavy work from the main conversation.\n\nAgent types (pass the name as subagent_type):\n" +
			agentCatalogue(ctx.definitions()),
		inputSchema: z.object({
			description: z.string().describe("A short (3-5 word) description of the task"),
			prompt: z.string().describe("The complete task for the agent to perform"),
			subagent_type: z.string().optional().describe('One of the agent types listed above (default "general-purpose")'),
			max_turns: z.number().int().positive().optional(),
		}),
		prompt:
			"- Launch subagents for context-heavy, self-contained work (research, broad searches).\n" +
			"- Always include a complete, self-contained prompt — subagents don't see this conversation.\n" +
			"- Multiple Task calls run concurrently when safe.",
		isConcurrencySafe: () => true,
		call: async (input, toolCtx) => {
			const definitions = [GENERAL_PURPOSE, ...ctx.definitions()];
			const requested = input.subagent_type ?? "general-purpose";
			const definition = definitions.find((d) => d.agentType === requested);
			if (!definition) {
				const available = definitions.map((d) => d.agentType).join(", ");
				return {
					content: [textContent(`Unknown agent type: ${requested}. Available: ${available}`)],
					isError: true,
				};
			}

			const tools = definition.tools ? ctx.allTools.filter((t) => definition.tools?.includes(t.name)) : ctx.allTools;
			const store = ctx.store?.();
			const permissionMode = ctx.permissionMode?.();
			// A definition may name its own model. One that no longer resolves falls
			// back to the session's — said out loud, because a subagent quietly
			// running on a different model than its definition asks for is the kind
			// of thing that gets diagnosed as the model having a bad day.
			const named = definition.model;
			const resolved = named ? ctx.resolveModel?.(named) : undefined;
			if (named && !resolved) {
				ctx.report?.(`[${definition.agentType}] Unknown model "${named}" — running on the session model instead.`);
			}
			const model = resolved ?? ctx.model();

			/** What the subagent did to its own context, to report with its end. */
			const notes: string[] = [];
			// A subagent has a context window of its own and can fill it: a research
			// task that reads a repository is exactly the shape that does. It has no
			// store — a subagent's transcript is kept as start/end entries, not as a
			// conversation to resume — so its compactions are recorded nowhere and
			// reported here instead.
			const subagentWiring = createCompactionWiring({
				model,
				store: undefined,
				streamFn: ctx.streamFn,
				trimOldToolResults: ctx.trimOldToolResults,
				report: (text) => {
					notes.push(text);
					ctx.report?.(`[${definition.agentType}] ${text}`);
				},
			});

			const subSession = new AgentSession({
				model,
				systemPrompt: ctx.systemPromptFor?.(definition) ?? agentSystemPrompt(definition),
				tools,
				maxTurns: input.max_turns ?? definition.maxTurns,
				cwd: toolCtx.cwd,
				permissionMode,
				deps: {
					streamFn: ctx.streamFn,
					checkCompaction: subagentWiring.checkCompaction,
					// Subagents inherit the parent's rules but have no dialog of their
					// own to resolve an "ask" — fail closed rather than hang or auto-allow.
					canUseTool: permissionMode
						? async (toolName, permInput, permCtx) => {
								const decision = evaluatePermissions(toolName, permInput, {
									mode: permCtx.mode,
									rules: ctx.getPermissionRules?.() ?? [],
									cwd: toolCtx.cwd,
								});
								if (decision.behavior === "ask") {
									return {
										behavior: "deny",
										message:
											decision.message ?? `Permission required for ${toolName} (subagents cannot prompt interactively)`,
									};
								}
								return decision;
							}
						: undefined,
				},
			});

			// Sidechain persistence: record start + final transcript in the parent tree.
			const sidechainId = `sidechain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			store?.appendCustom("subagent_start", { sidechainId, agentType: definition.agentType, prompt: input.prompt });

			const events: string[] = [];
			const unsubscribe = subSession.on((event) => {
				if (event.type === "tool_execution_end") {
					events.push(`${event.toolName}: ${event.result.isError ? "error" : "ok"}`);
				}
			});

			// A parent interrupt (Esc) must stop the nested session too. Without this
			// the subagent keeps streaming after the user cancels, and the parent's
			// tool batch — plus its "Running tools…" spinner — stays blocked until the
			// subagent finishes on its own, which reads as Esc doing nothing.
			const onAbort = () => subSession.abort();
			toolCtx.signal.addEventListener("abort", onAbort, { once: true });

			try {
				const promptPromise = subSession.prompt(input.prompt);
				// The cancel can land before prompt() created its controller, where
				// abort() is a no-op on a null controller; re-check now that one exists.
				if (toolCtx.signal.aborted) subSession.abort();
				const reason = await promptPromise;
				const finalAssistant = [...subSession.messages].reverse().find((m) => m.role === "assistant");
				const finalText =
					finalAssistant && finalAssistant.role === "assistant"
						? finalAssistant.content
								.filter((b) => b.type === "text")
								.map((b) => b.text)
								.join("\n")
						: "(no response)";

				store?.appendCustom("subagent_end", {
					sidechainId,
					reason,
					toolCalls: events,
					messages: subSession.messages.length,
					notes,
				});

				// Interrupted subagents report the interruption, not a summary that
				// happens to trail off mid-thought.
				if (toolCtx.signal.aborted) {
					return {
						content: [textContent("Tool execution aborted")],
						isError: true,
						details: { sidechainId, agentType: definition.agentType, reason },
					};
				}

				const summary = reason === "completed" ? finalText : `${finalText}\n\n[subagent ended: ${reason}]`;
				return {
					content: [textContent(summary)],
					details: { sidechainId, agentType: definition.agentType, reason },
				};
			} finally {
				toolCtx.signal.removeEventListener("abort", onAbort);
				unsubscribe();
			}
		},
	});
}
