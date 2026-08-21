/**
 * Subagents: agent definitions (frontmatter .md) + the Task tool that runs
 * nested AgentSessions. Subagent transcripts persist as sidechain entries in
 * the parent's session tree, and the final assistant text returns to the
 * parent as the tool result.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentSession, type AnyTool, buildTool, type SessionStore } from "@labunbun/agent";
import type { Model, StreamFn } from "@labunbun/ai";
import { textContent } from "@labunbun/ai";
import { z } from "zod";

export interface AgentDefinition {
	agentType: string;
	whenToUse: string;
	/** Tool names the agent may use; undefined = inherit all. */
	tools?: string[];
	model?: string;
	maxTurns?: number;
	source: "builtin" | "user" | "project";
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
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
				const { data } = parseFrontmatter(readFileSync(join(dir, name), "utf8"));
				const agentType = data.name ?? data.agent ?? name.replace(/\.md$/, "");
				if (!agentType) continue;
				out.push({
					agentType,
					whenToUse: data.description ?? data.whenToUse ?? "",
					tools: data.tools ? data.tools.split(",").map((t) => t.trim()) : undefined,
					model: data.model || undefined,
					maxTurns: data.maxTurns ? Number(data.maxTurns) : undefined,
					source,
				});
			} catch {}
		}
	} catch {
		return out;
	}
	return out;
}

export function loadAgentDefinitions(cwd: string, home = homedir()): AgentDefinition[] {
	return [
		...loadDefinitionsFromDir(join(home, ".labunbun", "agents"), "user"),
		...loadDefinitionsFromDir(join(cwd, ".labunbun", "agents"), "project"),
	];
}

export interface TaskToolContext {
	streamFn: StreamFn;
	model: Model;
	allTools: AnyTool[];
	definitions: AgentDefinition[];
	store?: SessionStore;
	systemPromptFor?: (agent: AgentDefinition) => string;
}

export const GENERAL_PURPOSE: AgentDefinition = {
	agentType: "general-purpose",
	whenToUse: "General-purpose agent for researching questions and executing multi-step tasks",
	source: "builtin",
};

/** Create the Task tool: spawns a nested AgentSession per invocation. */
export function createTaskTool(ctx: TaskToolContext): AnyTool {
	const definitions = [GENERAL_PURPOSE, ...ctx.definitions];
	return buildTool({
		name: "Task",
		description:
			"Launch a subagent to handle a self-contained task. The subagent has its own context window " +
			"and returns its final report as the tool result. Use for parallel research or isolating " +
			"context-heavy work from the main conversation.",
		inputSchema: z.object({
			description: z.string().describe("A short (3-5 word) description of the task"),
			prompt: z.string().describe("The complete task for the agent to perform"),
			subagent_type: z.string().optional().describe("Agent type (default general-purpose)"),
			max_turns: z.number().int().positive().optional(),
		}),
		prompt:
			"- Launch subagents for context-heavy, self-contained work (research, broad searches).\n" +
			"- Always include a complete, self-contained prompt — subagents don't see this conversation.\n" +
			"- Multiple Task calls run concurrently when safe.",
		isConcurrencySafe: () => true,
		call: async (input, toolCtx) => {
			const requested = input.subagent_type ?? "general-purpose";
			const definition = definitions.find((d) => d.agentType === requested);
			if (!definition) {
				const available = definitions.map((d) => d.agentType).join(", ");
				return {
					content: [textContent(`Unknown agent type: ${requested}. Available: ${available}`)],
					isError: true,
				};
			}

			const tools = definition.tools ? ctx.allTools.filter((t) => definition.tools!.includes(t.name)) : ctx.allTools;

			const subSession = new AgentSession({
				model: ctx.model,
				systemPrompt:
					ctx.systemPromptFor?.(definition) ??
					`You are ${definition.agentType}, a focused subagent. ${definition.whenToUse}\nComplete the task and report results concisely.`,
				tools,
				maxTurns: input.max_turns ?? definition.maxTurns,
				cwd: toolCtx.cwd,
				deps: { streamFn: ctx.streamFn },
			});

			// Sidechain persistence: record start + final transcript in the parent tree.
			const sidechainId = `sidechain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			ctx.store?.appendCustom("subagent_start", { sidechainId, agentType: definition.agentType, prompt: input.prompt });

			const events: string[] = [];
			const unsubscribe = subSession.on((event) => {
				if (event.type === "tool_execution_end") {
					events.push(`${event.toolName}: ${event.result.isError ? "error" : "ok"}`);
				}
			});

			try {
				const reason = await subSession.prompt(input.prompt);
				const finalAssistant = [...subSession.messages].reverse().find((m) => m.role === "assistant");
				const finalText =
					finalAssistant && finalAssistant.role === "assistant"
						? finalAssistant.content
								.filter((b) => b.type === "text")
								.map((b) => b.text)
								.join("\n")
						: "(no response)";

				ctx.store?.appendCustom("subagent_end", {
					sidechainId,
					reason,
					toolCalls: events,
					messages: subSession.messages.length,
				});

				const summary = reason === "completed" ? finalText : `${finalText}\n\n[subagent ended: ${reason}]`;
				return {
					content: [textContent(summary)],
					details: { sidechainId, agentType: definition.agentType, reason },
				};
			} finally {
				unsubscribe();
			}
		},
	});
}
