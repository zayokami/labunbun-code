/**
 * Subagents: agent definitions (frontmatter .md) + the tools that run nested
 * AgentSessions — Task spawns one, SendMessage continues or nudges one,
 * TaskStop cancels one. A subagent's conversation lives in this process only:
 * what reaches the parent's session file is a start/end entry around each run,
 * with the final report text. The conversation itself is not written down, so
 * a subagent cannot be revived after the process ends.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentEndReason,
	AgentSession,
	type AnyTool,
	buildTool,
	evaluatePermissions,
	type NetworkAxis,
	type PermissionMode,
	type PermissionRule,
	type SandboxMode,
	type SessionStore,
	type ToolResult,
} from "@labunbun/agent";
import type { Model, StreamFn, ThinkingLevel } from "@labunbun/ai";
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
	/**
	 * The other axis, read at the same moment. Inherited for the same reason the
	 * mode is: a subagent that ran confined while its parent ran unconfined would
	 * be the one place in the system where the sandbox is not what the user
	 * picked. `undefined` means the subagent's own default, which is confined.
	 */
	sandbox?: () => SandboxMode | undefined;
	/**
	 * The third axis, read at the same moment and for the same reason. A
	 * subagent that reached the network while its parent was `restricted` would
	 * make every allow-list entry in `settings.networkDomains` advisory, and the
	 * parent is the thing a user thinks of as the session — a subagent is an
	 * implementation detail of a tool call.
	 */
	network?: () => NetworkAxis | undefined;
	/**
	 * How hard the subagent should think, read at the same moment as the axes
	 * above and inherited for the same reason: a subagent is an implementation
	 * detail of a tool call, and a session the user set to `high` that quietly
	 * ran its research at the model's default would be deciding that per call
	 * rather than per user. `undefined` leaves it to the model, exactly as on
	 * the parent.
	 */
	thinkingLevel?: () => ThinkingLevel | undefined;
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

/**
 * How many finished subagents a session keeps addressable.
 *
 * A finished handle holds a whole nested conversation in memory — that is the
 * point, since continuing it is what SendMessage is for — so the registry is
 * capped. The number is memory first and aging second: a run that finished
 * eight subagents ago is history in every sense.
 */
const MAX_RETAINED_SUBAGENTS = 8;

/** Where a subagent is in its life: running, ready to continue, or cancelled. */
type SubagentState = "live" | "finished" | "stopped";

interface SubagentHandle {
	sidechainId: string;
	agentType: string;
	/**
	 * The nested session, kept alive after its first run so that a continuation
	 * continues the same conversation. That is the whole difference between
	 * SendMessage and a second Task call, so the session must outlive the call
	 * that spawned it.
	 */
	session: AgentSession;
	/** What its own context management did, accumulated across runs. */
	notes: string[];
	state: SubagentState;
	/** Finish order, for eviction; larger ended later. 0 while live. */
	endedAt: number;
}

/**
 * The subagent tools, sharing one registry, in a fixed order: Task, then
 * SendMessage, then TaskStop.
 *
 * They are created together because the id a Task call returns is the only way
 * back to the session behind it: an id nobody holds a map for is an id that
 * means nothing, so the three tools must see the same map.
 */
export function createSubagentTools(ctx: TaskToolContext): AnyTool[] {
	/** Finished handles, addressable until evicted. */
	const handles = new Map<string, SubagentHandle>();
	let endSeq = 0;

	/** Drop the oldest non-live handles down to the cap; never a live one. */
	const evictOldest = (): void => {
		const ended = [...handles.values()].filter((handle) => handle.state !== "live");
		if (ended.length <= MAX_RETAINED_SUBAGENTS) return;
		ended.sort((a, b) => a.endedAt - b.endedAt);
		for (const handle of ended.slice(0, ended.length - MAX_RETAINED_SUBAGENTS)) {
			handles.delete(handle.sidechainId);
		}
	};

	/**
	 * Run one prompt on a handle, and mark where the run left it.
	 *
	 * Shared by Task and SendMessage so the mechanics cannot drift: in both
	 * cases the caller's cancel has to stop the nested session, or of the two
	 * things Esc means only the outer one happens — the reported bug was a
	 * subagent that kept streaming after the user cancelled, holding the
	 * parent's tool batch open.
	 */
	const runPrompt = async (
		handle: SubagentHandle,
		text: string,
		signal: AbortSignal,
	): Promise<{ reason: AgentEndReason; events: string[] }> => {
		const events: string[] = [];
		const unsubscribe = handle.session.on((event) => {
			if (event.type === "tool_execution_end") {
				events.push(`${event.toolName}: ${event.result.isError ? "error" : "ok"}`);
			}
		});
		const onAbort = () => handle.session.abort();
		handle.state = "live";
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const promptPromise = handle.session.prompt(text);
			// The cancel can land before prompt() created its controller, where
			// abort() is a no-op on a null controller; re-check now that one exists.
			if (signal.aborted) handle.session.abort();
			return { reason: await promptPromise, events };
		} finally {
			signal.removeEventListener("abort", onAbort);
			unsubscribe();
			// A TaskStop during the run has already moved the state, and its
			// verdict — never resumed — outranks the run simply ending.
			if (handle.state === "live") {
				handle.state = "finished";
				handle.endedAt = ++endSeq;
				evictOldest();
			}
		}
	};

	/** The subagent's last piece of prose: what the parent reads as the result. */
	const finalReport = (session: AgentSession): string => {
		const finalAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
		return finalAssistant && finalAssistant.role === "assistant"
			? finalAssistant.content
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("\n")
			: "(no response)";
	};

	/**
	 * The line that makes a result addressable. A tool result is the only
	 * channel the parent model reads — an id kept anywhere else would be an id
	 * the model has never seen — so every result that ran or ended a subagent
	 * carries it, and SendMessage and TaskStop take it as their argument.
	 */
	const idLine = (sidechainId: string): string => `[subagent id: ${sidechainId}]`;

	const unknownHandle = (sidechainId: string): ToolResult => ({
		content: [
			textContent(
				`Unknown or expired subagent: ${sidechainId}. Only the last ${MAX_RETAINED_SUBAGENTS} finished ` +
					"subagents stay addressable, and their conversations are not written down — a subagent " +
					"cannot be revived; start a new Task instead.",
			),
		],
		isError: true,
	});

	/** Spawn: a nested AgentSession per invocation, addressable by its id line. */
	const task = buildTool({
		name: "Task",
		description:
			"Launch a subagent to handle a self-contained task. The subagent has its own context window " +
			"and returns its final report as the tool result, ending with its id line — pass that id to " +
			"SendMessage to continue the subagent, or to TaskStop to cancel it. Use for parallel research " +
			"or isolating context-heavy work from the main conversation.\n\nAgent types (pass the name as subagent_type):\n" +
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
			"- Multiple Task calls run concurrently when safe.\n" +
			"- Every result ends with a [subagent id: …] line — the handle SendMessage and TaskStop take.",
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
			const sandbox = ctx.sandbox?.();
			const network = ctx.network?.();
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

			/** What the subagent did to its own context; lives on its handle so
			 *  continuations can record what each run added. */
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
				sandbox,
				network,
				deps: {
					streamFn: ctx.streamFn,
					// The parent's reader, not its current answer: a `/think` that lands
					// while the subagent runs is seen by the subagent's next request,
					// which is the same call-time shape the axes above travel by.
					thinkingLevel: ctx.thinkingLevel,
					checkCompaction: subagentWiring.checkCompaction,
					// Subagents inherit the parent's rules but have no dialog of their
					// own to resolve an "ask" — fail closed rather than hang or auto-allow.
					canUseTool: permissionMode
						? async (toolName, permInput, permCtx) => {
								const decision = evaluatePermissions(toolName, permInput, {
									mode: permCtx.mode,
									sandbox: permCtx.sandbox,
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
			const handle: SubagentHandle = {
				sidechainId,
				agentType: definition.agentType,
				session: subSession,
				notes,
				state: "live",
				endedAt: 0,
			};
			handles.set(sidechainId, handle);
			store?.appendCustom("subagent_start", { sidechainId, agentType: definition.agentType, prompt: input.prompt });

			const { reason, events } = await runPrompt(handle, input.prompt, toolCtx.signal);
			const finalText = finalReport(subSession);
			store?.appendCustom("subagent_end", {
				sidechainId,
				reason,
				toolCalls: events,
				messages: subSession.messages.length,
				notes,
				report: finalText,
			});

			// Interrupted subagents report the interruption, not a summary that
			// happens to trail off mid-thought. The id line rides along so the
			// conversation can be picked back up: an interrupted run keeps its
			// messages, and SendMessage continues from them.
			if (toolCtx.signal.aborted) {
				return {
					content: [textContent(`Tool execution aborted\n\n${idLine(sidechainId)}`)],
					isError: true,
					details: { sidechainId, agentType: definition.agentType, reason },
				};
			}

			const summary = reason === "completed" ? finalText : `${finalText}\n\n[subagent ended: ${reason}]`;
			return {
				content: [textContent(`${summary}\n\n${idLine(sidechainId)}`)],
				details: { sidechainId, agentType: definition.agentType, reason },
			};
		},
	});

	/**
	 * Continue or nudge: the same conversation, addressed by its id line.
	 *
	 * A finished handle runs the message as a new prompt on its retained
	 * session, so the subagent still knows everything its first run learned; a
	 * live one has the message steered into its running loop, delivered at its
	 * next turn, because a second prompt() cannot start while one is running.
	 */
	const sendMessage = buildTool({
		name: "SendMessage",
		description:
			"Continue a subagent that a Task call started, or leave a note for one still running. The " +
			"subagent keeps its whole conversation, so a follow-up continues where its report left off " +
			"instead of starting over, and the new report returns as this call's result. Address the " +
			"subagent by the id line at the end of its Task result. A subagent stopped with TaskStop is " +
			"not resumed — that stop cancels its work — and an evicted or unknown id is an error.",
		inputSchema: z.object({
			sidechain_id: z.string().describe("The subagent id from the [subagent id: …] line of a Task result"),
			message: z
				.string()
				.describe("The follow-up: the next step, a question about the report, or a note for a running subagent"),
		}),
		prompt:
			"- Continue a subagent when its work needs a follow-up; it already has the whole task in context.\n" +
			"- A running subagent gets the message at its next turn; a finished one runs it as a new prompt.",
		call: async (input, toolCtx) => {
			const handle = handles.get(input.sidechain_id);
			if (!handle) return unknownHandle(input.sidechain_id);
			if (handle.state === "stopped") {
				return {
					content: [
						textContent(
							`Subagent ${input.sidechain_id} was stopped and is not resumed — treat its work as ` +
								"cancelled. Start a new Task instead.",
						),
					],
					isError: true,
				};
			}
			if (handle.state === "live") {
				handle.session.steer(input.message);
				return {
					content: [
						textContent(
							`Subagent ${input.sidechain_id} is still running; the message is queued for its next ` +
								"turn, and the report of the run it is in comes back with the call waiting on it.",
						),
					],
					details: { sidechainId: input.sidechain_id, queued: true },
				};
			}

			// The axes are read again, not remembered: a mode or a plan entered
			// since the spawn applies to this continuation exactly as it would to
			// a fresh Task call, and a continued subagent that kept writing after
			// its parent was confined would be one place the user's choice did
			// not reach.
			const mode = ctx.permissionMode?.();
			const sandbox = ctx.sandbox?.();
			if (mode !== undefined || sandbox !== undefined) {
				handle.session.setMode(mode ?? handle.session.permissionMode, sandbox);
			}
			const network = ctx.network?.();
			if (network !== undefined) handle.session.setNetwork(network);

			const store = ctx.store?.();
			const notesBefore = handle.notes.length;
			const { reason, events } = await runPrompt(handle, input.message, toolCtx.signal);
			const finalText = finalReport(handle.session);
			store?.appendCustom("subagent_end", {
				sidechainId: handle.sidechainId,
				reason,
				toolCalls: events,
				messages: handle.session.messages.length,
				notes: handle.notes.slice(notesBefore),
				report: finalText,
			});

			if (toolCtx.signal.aborted) {
				return {
					content: [textContent(`Tool execution aborted\n\n${idLine(handle.sidechainId)}`)],
					isError: true,
					details: { sidechainId: handle.sidechainId, agentType: handle.agentType, reason },
				};
			}
			const summary = reason === "completed" ? finalText : `${finalText}\n\n[subagent ended: ${reason}]`;
			return {
				content: [textContent(`${summary}\n\n${idLine(handle.sidechainId)}`)],
				details: { sidechainId: handle.sidechainId, agentType: handle.agentType, reason },
			};
		},
	});

	/**
	 * Cancel: abort a running subagent, or mark a finished one so it is never
	 * continued. Stopping does not undo anything the subagent already did —
	 * its side effects stand, and its partial report stays where it was
	 * returned — so the tool exists to end the work, not to erase it.
	 */
	const taskStop = buildTool({
		name: "TaskStop",
		description:
			"Stop a subagent started with Task and cancel its work. A running subagent is interrupted; " +
			"a finished one is marked stopped, so SendMessage will refuse it. What the subagent already " +
			"did is not undone — stop it when its work is no longer needed.",
		inputSchema: z.object({
			sidechain_id: z.string().describe("The subagent id from the [subagent id: …] line of a Task result"),
		}),
		prompt: "- Only for cancelling a subagent; stopping one that finished keeps its report where it was returned.",
		call: async (input) => {
			const handle = handles.get(input.sidechain_id);
			if (!handle) return unknownHandle(input.sidechain_id);
			if (handle.state === "stopped") {
				return { content: [textContent(`Subagent ${input.sidechain_id} was already stopped.`)] };
			}
			const wasLive = handle.state === "live";
			handle.state = "stopped";
			handle.endedAt = ++endSeq;
			evictOldest();
			if (wasLive) handle.session.abort();
			return {
				content: [
					textContent(
						wasLive
							? `Subagent ${input.sidechain_id} was stopped; it will not be resumed.`
							: `Subagent ${input.sidechain_id} had already finished; it is now marked stopped and will not be continued.`,
					),
				],
				details: { sidechainId: input.sidechain_id, stopped: true },
			};
		},
	});

	return [task, sendMessage, taskStop];
}
