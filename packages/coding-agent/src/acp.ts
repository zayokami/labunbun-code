/**
 * ACP — the Agent Client Protocol, agent half, over stdio.
 *
 * An editor (Zed is the one this exists for) launches `labunbun acp` and speaks
 * JSON-RPC 2.0 with newline-delimited framing: one JSON object per line, in both
 * directions, and nothing else on the wire. That last clause is the constraint
 * the rest of this file is written around — **the ACP route writes zero bytes to
 * stdout that are not a frame**, which is why every notice below goes to stderr
 * and why `main.ts` skips its ConPTY write-chunking install on this path.
 *
 * ## What this implements
 *
 * The mandatory half of the agent side: `initialize`, `session/new`,
 * `session/load`, `session/prompt`, `session/cancel`, `authenticate` — plus
 * `session/set_mode`, small enough to keep `session/new`'s `modes` from
 * advertising ids nothing can set — and the `session/update` notifications that
 * carry a turn's progress and, for a loaded session, its whole stored history
 * before the load response is answered. Sessions are `AgentSession`s: the same
 * loop, tools, settings, permission engine and hooks a `-p` run and the REPL
 * use, assembled through the same helpers `headless.ts` calls, so a turn cannot
 * behave one way under `-p` and another way under an editor.
 *
 * ## What this does not implement (second batch)
 *
 *   - `fs/read_text_file` and `fs/write_text_file`. The client's filesystem is
 *     unreachable from here; the local tools are used instead.
 *   - `terminal/*`. Commands run through the session's own Bash tool.
 *   - `mcpServers` from `session/new` and `session/load`. The servers the user
 *     configured are not connected either; the tools are the local set.
 *   - `authMethods` and a real `authenticate` (see that method below).
 *   - `available_commands_update`, and with it the expansion of a prompt that
 *     names a skill: the editor's command surface is a second batch, and a
 *     `/skill-x` typed into a session is sent to the model as written.
 *   - `session/set_model` (UNSTABLE in the protocol; a model is not something
 *     this skeleton re-resolves mid-session).
 *   - `tool_execution_update`'s partial output: the update is announced as
 *     `in_progress` and the partial itself is dropped — the protocol has no
 *     representation for a half-typed tool result.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type AgentEndReason,
	type AgentEvent,
	AgentSession,
	collectReadOnlyToolNames,
	DEFAULT_MODE_CHOICE,
	evaluatePermissions,
	MODE_CHOICES,
	type NetworkSandboxPolicy,
	type PermissionContext,
	type PermissionMode,
	type PermissionResult,
	type PermissionRule,
	type SandboxMode,
	SessionStore,
} from "@labunbun/agent";
import {
	type AgentMessage,
	type CacheTracker,
	createTrackedStreamFn,
	dynamicProviderTemplates,
	refreshModelCatalog,
	resolveModel,
	type StreamFn,
	type ToolResultContent,
	withModelFallback,
} from "@labunbun/ai";
import {
	BackgroundShellManager,
	ChildProcessExecOperations,
	createAllTools,
	defaultOperations,
	detectRuntime,
	detectShell,
	type Operations,
	TaskStore,
} from "@labunbun/tools";
import { permissionOptions, ruleSpecifierFor } from "@labunbun/tui";
import * as acp from "@zed-industries/agent-client-protocol";
import { createChatGptCredentials } from "./chatgpt-auth.ts";
import { createClaudeCredentials } from "./claude-auth.ts";
import {
	type CompactionTuning,
	compactionPhaseText,
	compactionWarnings,
	createCompactionWiring,
	resolveCompactionSummarizer,
} from "./compaction-wiring.ts";
import { costStateFromMessages } from "./cost-tracker.ts";
import { createGeminiCredentials } from "./gemini-auth.ts";
import { advisoryHookFailures, type HooksRuntime, sessionHookDeps, snapshotHooks } from "./hooks.ts";
import { loadMemoryFiles } from "./memory.ts";
import { writeMissionRecord } from "./mission-ledger.ts";
import { noToolCallingNotice } from "./model-offer.ts";
import {
	budgetVerdict,
	createModelChainResolver,
	modelRefKey,
	resolveRoles,
	roleOrder,
	seatsByRef,
} from "./model-roles.ts";
import { loadOutputStyles, resolveOutputStyle } from "./output-styles.ts";
import { damagedSessionNotice, findSession, listSessions, loadSessionForResume } from "./session-resume.ts";
import {
	applyCatalogSettings,
	applySettingsEnv,
	collectPermissionRules,
	formatIgnoredKeysNotice,
	loadSettings,
	networkAxisFrom,
	type RawSettingsInput,
	resolveMode,
} from "./settings.ts";
import { createSkillTool } from "./skill-tool.ts";
import { loadSkillsWithNotes, skillDiscoveryBlock, skillDiscoveryBudgetChars } from "./skills.ts";
import { createSpawnConfiner } from "./spawn-confinement.ts";
import { formatSubagentRecovery, readSubagentLedger } from "./subagent-ledger.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { bindTaskStore, saveTasks } from "./task-snapshot.ts";
import { pruneToolOutput, toolOutputRoot, toolSpillDir, writeToolOutput } from "./tool-output.ts";

/** One `session/update` payload — the union the protocol declares for `update`. */
export type SessionUpdate = acp.SessionNotification["update"];

/** The stop reasons `session/prompt` may answer with, per the protocol's own enum. */
export type AcpStopReason = acp.PromptResponse["stopReason"];

export interface AcpOptions {
	modelRef?: string;
	permissionMode?: PermissionMode;
	sandbox?: SandboxMode;
	/** The `--network` flag: the access half of the network axis. */
	network?: NetworkSandboxPolicy;
	maxTurns?: number;
	/** The home whose settings, memory files and sign-in store are read. */
	home?: string;
	/** `--settings <json>`, parsed in `main.ts` the same way `-p` parses it there. */
	flagSettings?: RawSettingsInput;
	/** The model transport. Injected by tests; production gets the retrying default. */
	streamFn?: StreamFn;
}

// ---------------------------------------------------------------------------
// Pure mappings
//
// Every translation between the app's vocabulary and the protocol's lives here
// as a function of its arguments, so the wire shape can be asserted without a
// session, a provider or a socket. `test/acp-mapping.test.ts` is what holds them.
// ---------------------------------------------------------------------------

/**
 * The protocol's name for why a turn ended, or `null` when it has none.
 *
 * Three of the four reasons the loop can end with have an exact counterpart.
 * `error` does not: the protocol's remaining reasons — `max_tokens` and
 * `refusal` — describe what the *model* did, and a run that ended in `error`
 * ended because the machinery failed, which a client is entitled to see as a
 * failed request rather than as a turn that finished. `null` is that statement,
 * and the caller turns it into a JSON-RPC error carrying the loop's own message;
 * answering `end_turn` here would report a broken run as a completed one.
 */
export function stopReasonFor(reason: AgentEndReason): AcpStopReason | null {
	switch (reason) {
		case "completed":
			return "end_turn";
		case "aborted":
			// The cancel contract: `session/cancel` is a notification, and the
			// answer to the *original* `session/prompt` is this reason.
			return "cancelled";
		case "max_turns":
			return "max_turn_requests";
		case "error":
			return null;
	}
}

/**
 * The protocol's category for a tool, from the tool's own name.
 *
 * `other` is the honest default rather than a guess: a kind is a hint the editor
 * renders with, and a wrong one paints a read as a write.
 */
export function toolKindFor(toolName: string): acp.ToolKind {
	switch (toolName) {
		case "Read":
			return "read";
		case "Edit":
		case "Write":
		case "NotebookEdit":
			return "edit";
		case "Glob":
		case "Grep":
		case "Ls":
			return "search";
		case "Bash":
		case "BashOutput":
		case "KillBash":
			return "execute";
		case "WebFetch":
		case "WebSearch":
			return "fetch";
		case "EnterPlanMode":
		case "ExitPlanMode":
			return "switch_mode";
		default:
			return "other";
	}
}

/** A one-line title for a tool call, from the input it was called with. */
export function toolTitleFor(toolName: string, input: unknown): string {
	const record = asRecord(input);
	const detail = record
		? (["command", "file_path", "notebook_path", "path", "pattern", "query", "url", "description"] as const)
				.map((key) => record[key])
				.find((value) => typeof value === "string" && value.trim() !== "")
		: undefined;
	if (typeof detail !== "string") return toolName;
	const oneLine = detail.replace(/\s+/g, " ").trim();
	const title = `${toolName}: ${oneLine}`;
	return title.length > 100 ? `${title.slice(0, 99)}…` : title;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The text a user's message carries, from the content blocks the editor sent. */
export function promptTextFrom(blocks: acp.ContentBlock[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			parts.push(block.text);
			continue;
		}
		if (block.type === "resource_link") {
			// `@path` is this app's own mention spelling (see `prompt-files.ts` in the
			// tui package), so a file the user referenced arrives in the form the model
			// is already reading: a path the Read tool can open.
			parts.push(`@${pathFromUri(block.uri)}`);
			continue;
		}
		// Images, audio and embedded resources are not advertised as supported
		// (`promptCapabilities` is empty), so a well-behaved client does not send
		// them. Said out loud rather than dropped in silence.
		process.stderr.write(`acp: ignoring unsupported prompt block "${block.type}"\n`);
	}
	return parts.filter((part) => part !== "").join("\n\n");
}

/** A `file://` URI as a filesystem path; anything else is left as the URI says. */
function pathFromUri(uri: string): string {
	if (!uri.startsWith("file:")) return uri;
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
}

/**
 * The four answers an approval request offers, in the protocol's own four kinds.
 *
 * The first three labels are the REPL's (`permissionOptions` in @labunbun/tui),
 * so the same question reads the same way in a terminal and in an editor — and
 * so the "always" answer says the scope it actually grants. The fourth kind,
 * `reject_always`, has no REPL counterpart (the dialog's "no" is once per call);
 * its label says so.
 */
export function acpPermissionOptions(toolName: string, input: unknown, cwd: string): acp.PermissionOption[] {
	const [once, always, never] = permissionOptions(toolName, input, cwd);
	return [
		{ optionId: "allow_once", name: once?.label ?? "Allow once", kind: "allow_once" },
		{ optionId: "allow_always", name: always?.label ?? "Always allow", kind: "allow_always" },
		{ optionId: "reject_once", name: never?.label ?? "Reject", kind: "reject_once" },
		{
			optionId: "reject_always",
			name: `No, and don't ask again for ${toolName} (this session)`,
			kind: "reject_always",
		},
	];
}

/** What `optionId` means for the tool pipeline. Unknown ids fail closed. */
export function permissionFromOptionId(optionId: string): { allow: boolean; remember: boolean } | null {
	switch (optionId) {
		case "allow_once":
			return { allow: true, remember: false };
		case "allow_always":
			return { allow: true, remember: true };
		case "reject_once":
			return { allow: false, remember: false };
		case "reject_always":
			return { allow: false, remember: true };
		default:
			return null;
	}
}

/**
 * The `session/update` frames one agent event becomes, or `[]` for an event the
 * protocol has nothing to say about.
 *
 * `agent_end` is the one worth naming: it does not become an update. The turn's
 * end is the *response* to `session/prompt`, and `AgentSession.prompt` returns
 * the same reason the event carries — so the response is built from the return
 * value rather than from a flag a notification handler set, which cannot be
 * missed or double-counted.
 */
export function updatesForEvent(event: AgentEvent): SessionUpdate[] {
	switch (event.type) {
		case "message_update":
			return messageUpdates(event);
		case "tool_execution_start":
			return [toolCallAnnouncement(event.callId, event.toolName, event.input)];
		case "tool_execution_update":
			return [{ sessionUpdate: "tool_call_update", toolCallId: event.callId, status: "in_progress" }];
		case "tool_execution_end":
			return [toolResultUpdate(event)];
		default:
			return [];
	}
}

/**
 * One `tool_call` frame — the announcement the live stream makes when a call
 * starts, and that a replay makes for a call the history holds.
 *
 * One function rather than two spellings of the same object, so a replayed call
 * and a live one are the same frame down to `rawInput`, which is what lets an
 * editor treat them alike.
 */
function toolCallAnnouncement(callId: string, toolName: string, input: unknown): SessionUpdate {
	return {
		sessionUpdate: "tool_call",
		toolCallId: callId,
		title: toolTitleFor(toolName, input),
		kind: toolKindFor(toolName),
		status: "pending",
		rawInput: asRecord(input) ?? { input },
	};
}

function messageUpdates(event: Extract<AgentEvent, { type: "message_update" }>): SessionUpdate[] {
	const delta = event.assistantMessageEvent;
	if (delta.type === "text_delta") {
		return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.delta } }];
	}
	if (delta.type === "thinking_delta") {
		return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.delta } }];
	}
	// `text_start`/`text_end` carry no new text (the end repeats what the deltas
	// already said), and the tool-call events are announced from
	// `tool_execution_start` instead — where the input is parsed and the call is
	// actually about to run.
	return [];
}

function toolResultUpdate(event: Extract<AgentEvent, { type: "tool_execution_end" }>): SessionUpdate {
	return toolResultUpdateFor(event.callId, event.result.content, event.result.isError);
}

/**
 * The frame that finishes a tool call, from the result alone.
 *
 * Shared between the live stream and a replay, so the completion of a stored
 * call reads exactly like the completion of one that just ran. `isError` is the
 * app's word for what the protocol calls "failed", and it is what the editor
 * colours by: a command that exited 1 is a failed call, not a completed one.
 */
function toolResultUpdateFor(callId: string, content: ToolResultContent[], isError: boolean): SessionUpdate {
	const text = content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	const update: SessionUpdate = {
		sessionUpdate: "tool_call_update",
		toolCallId: callId,
		status: isError ? "failed" : "completed",
	};
	if (text !== "") {
		update.content = [{ type: "content", content: { type: "text", text } }];
		update.rawOutput = { content: text, isError };
	}
	return update;
}

/**
 * The input a stored tool call was made with.
 *
 * `ToolCall.arguments` is raw JSON text in the message model (parsed once, when
 * the block completes), so a replay parses it here — the same object the live
 * stream already had in hand at `tool_execution_start`.
 */
function toolInputFrom(argumentsText: string): unknown {
	try {
		return JSON.parse(argumentsText);
	} catch {
		// A call whose arguments did not parse as JSON still gets a row: the raw
		// text is what the file holds, and dropping the call would hide that it
		// happened at all. The title falls back to the tool's own name.
		return argumentsText;
	}
}

/**
 * A user message as the protocol's chunk frames, one per content block.
 *
 * A plain string is the common case — this app's REPL and prompt path both
 * store text — and arrives as one text chunk. Blocks arrive when the user
 * attached an image: the protocol's image block has the same shape the app
 * stores (`mimeType` plus base64 `data`), so an attached image is replayed
 * rather than silently dropped from the conversation the editor shows.
 */
function userMessageChunks(message: Extract<AgentMessage, { role: "user" }>): SessionUpdate[] {
	if (typeof message.content === "string") {
		return [{ sessionUpdate: "user_message_chunk", content: { type: "text", text: message.content } }];
	}
	return message.content.map((block): SessionUpdate => {
		if (block.type === "text") {
			return { sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } };
		}
		return {
			sessionUpdate: "user_message_chunk",
			content: { type: "image", data: block.data, mimeType: block.mimeType },
		};
	});
}

/**
 * The frames that show a stored conversation, in the order the file holds it.
 *
 * `session/load`'s contract is that the entire history reaches the client as
 * `session/update` notifications before the load response does. Everything the
 * editor draws for a resumed session is drawn from this list, so a message left
 * out here is a message the user cannot see. The input is the store's full
 * linear history (`messages()`), deliberately not the model-facing view
 * (`contextMessages()`): a compaction boundary is a statement about what the
 * *model* is sent next, and a client showing the session shows the conversation
 * the person had, including the part the boundary dropped from future requests.
 *
 * The pairing rules, and why each one is what it is:
 *
 *   - An assistant tool call and the result message that answers it become the
 *     same two frames the live stream sent: `tool_call`, then
 *     `tool_call_update` (completed/failed). The update is emitted where the
 *     result sits in the file, so parallel calls finish in the order they
 *     actually finished rather than the order they were announced.
 *   - A tool call with no result on the path — an interrupted turn, or a
 *     damaged line that took the result — becomes `tool_call` alone, with
 *     status `pending`: that is the value the live announcement carried, and
 *     the others would each claim something the file does not say.
 *     `in_progress` claims the call is running now; `completed`/`failed` claim
 *     an outcome that was never recorded.
 *   - A result whose call is missing (the damaged line took the call instead)
 *     is announced first, from what the result itself knows — its tool name and
 *     no input — and finished right after. The client needs a row to attach the
 *     outcome to, and dropping the result instead would quietly shorten the
 *     conversation.
 */
export function replayUpdatesForMessages(messages: AgentMessage[]): SessionUpdate[] {
	const updates: SessionUpdate[] = [];
	/** The calls announced so far, so a result is only announced once. */
	const announced = new Set<string>();
	for (const message of messages) {
		if (message.role === "user") {
			updates.push(...userMessageChunks(message));
			continue;
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "text") {
					updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
					continue;
				}
				if (block.type === "thinking") {
					updates.push({
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: block.thinking },
					});
					continue;
				}
				updates.push(toolCallAnnouncement(block.id, block.name, toolInputFrom(block.arguments)));
				announced.add(block.id);
			}
			continue;
		}
		if (!announced.has(message.toolCallId)) {
			// The empty record is the honest input: the file no longer holds what
			// the call was made with, and inventing one would show a person an
			// argument list nobody ever typed.
			updates.push(toolCallAnnouncement(message.toolCallId, message.toolName, {}));
			announced.add(message.toolCallId);
		}
		updates.push(toolResultUpdateFor(message.toolCallId, message.content, message.isError));
	}
	return updates;
}

/**
 * The rows of the mode table the protocol can name.
 *
 * A row whose `id` is not the mode itself (`agentNoSandbox`) differs only in the
 * sandbox axis, and `SessionMode` is one opaque string — so advertising it would
 * mean an editor offering a mode id that no other client understands. The
 * approval modes are advertised, labelled from the same table the REPL's picker
 * reads, so the two cannot drift apart.
 */
const ACP_MODE_ROWS = MODE_CHOICES.filter((choice) => choice.id === choice.mode);

/** The protocol's view of a session's modes: the app's approval modes. */
export function sessionModesFor(currentModeId: string): acp.SessionModeState {
	return {
		currentModeId,
		availableModes: ACP_MODE_ROWS.map((row) => ({ id: row.id, name: row.label, description: row.hint })),
	};
}

/** The approval mode a mode id names, when it is one this agent advertises. */
export function permissionModeFromModeId(modeId: string): PermissionMode | undefined {
	return ACP_MODE_ROWS.find((row) => row.id === modeId)?.mode;
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

/** One tool call announced to the editor and not yet finished. */
interface AnnouncedCall {
	callId: string;
	toolName: string;
	/** Set when a permission question has already been attached to this call. */
	asked: boolean;
}

/**
 * What a permission question needs to know about its session.
 *
 * Separate from `LiveSession` because the tool pipeline's callback is built
 * before the session record it belongs to exists — the callback closes over this
 * state, and the live record is assembled around it afterwards.
 */
interface PermissionState {
	cwd: string;
	rules: PermissionRule[];
	readOnlyToolNames: ReturnType<typeof collectReadOnlyToolNames>;
	announced: AnnouncedCall[];
}

interface LiveSession {
	session: AgentSession;
	/** The file the session's turns go to — what the close-out note is written through. */
	store: SessionStore;
	sessionId: string;
	cwd: string;
	permissions: PermissionState;
	hooks: { runtime: HooksRuntime; context: string[] };
	/** True while a `session/prompt` turn is in flight — one at a time per session. */
	running: boolean;
}

/**
 * The open store `loadSession` is resuming, on its way into the new session.
 *
 * `messages` is the repaired, model-facing transcript (`loadSessionForResume`'s
 * output), which seeds the session; the store travels beside it so the replay
 * and every turn that follows read and write the same open file.
 */
interface ResumedSession {
	store: SessionStore;
	messages: AgentMessage[];
}

class AcpAgent implements acp.Agent {
	#conn: acp.AgentSideConnection | undefined;
	readonly #options: AcpOptions;
	readonly #sessions = new Map<string, LiveSession>();

	constructor(options: AcpOptions) {
		this.#options = options;
	}

	/** The connection arrives from the factory, which needs the agent first. */
	attach(conn: acp.AgentSideConnection): void {
		this.#conn = conn;
	}

	async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
		// Version negotiation, stated rather than assumed: this agent speaks
		// exactly one version, so it answers with that one whatever the client
		// asked for. The protocol puts the decision on the client — it disconnects
		// if the version that comes back is one it does not support — and inventing
		// a lower version to look agreeable would be a claim about behaviour that
		// does not exist here.
		if (params.protocolVersion !== acp.PROTOCOL_VERSION) {
			process.stderr.write(
				`acp: client asked for protocol version ${params.protocolVersion}; ` +
					`this agent speaks ${acp.PROTOCOL_VERSION}\n`,
			);
		}
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				// `session/load` is implemented (the method below replays the stored
				// history), and no prompt capabilities: image, audio and
				// embedded-context blocks are not interpreted.
				loadSession: true,
				promptCapabilities: {},
			},
		};
	}

	// The interface's own return type is `AuthenticateResponse | void`; the
	// signature is narrowed to the object only, which is what every branch returns
	// (and `undefined` is assignable to `void`, so the override still holds).
	async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
		// `initialize` advertises no `authMethods`, so there is no method a client
		// could legitimately call this with — and nothing to verify if it calls one
		// anyway. Answered with an empty success rather than an error, because the
		// session is already able to run (the credentials come from the environment
		// and the sign-in store), and the odd method id is worth a line on stderr
		// rather than a failed sign-in the user cannot act on.
		process.stderr.write(`acp: authenticate("${params.methodId}") — no auth methods are advertised; nothing to do\n`);
		return {};
	}

	async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
		const cwd = params.cwd.trim() === "" ? process.cwd() : resolve(params.cwd);
		const live = await this.#createSession(cwd);
		this.#sessions.set(live.sessionId, live);
		return { sessionId: live.sessionId, modes: sessionModesFor(live.session.permissionMode) };
	}

	async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
		const cwd = params.cwd.trim() === "" ? process.cwd() : resolve(params.cwd);
		// `mcpServers` is ignored, exactly as `session/new` ignores it (see the
		// file header): the servers are not connected, and the tools are the local
		// set.
		const home = this.#options.home ?? homedir();
		// The lookup `--resume` uses, from the same functions: an exact id first,
		// then a token that names one — so a client carrying the id from
		// `session/new`, and a person who typed the short tail, both land in the
		// session they meant.
		const match = findSession(listSessions(cwd, home), params.sessionId);
		if (!match) throw acp.RequestError.invalidParams({ message: `unknown session ${params.sessionId}` });
		const loaded = loadSessionForResume(match.path);
		if (!loaded) throw acp.RequestError.invalidParams({ message: `unknown session ${params.sessionId}` });
		// The same disclosure the terminal resume prints, on stderr because stdout
		// is frames only: a resumed conversation that is shorter than it was must
		// not be presented as whole.
		const damage = damagedSessionNotice(loaded.store, loaded.removed);
		if (damage) process.stderr.write(`Warning: ${damage}\n`);

		const live = await this.#createSession(cwd, loaded);
		// The whole history, one frame per message piece, in file order — awaited
		// one at a time so every replay frame is on the wire before the load
		// response tells the client the session is ready. That ordering is the
		// protocol's contract for this method, not a nicety: a client that draws
		// the session when the response arrives must already have the frames.
		for (const update of replayUpdatesForMessages(loaded.store.messages())) {
			await this.#update(live.sessionId, update);
		}
		// Registered only now, after the replay: `session/prompt` and
		// `session/cancel` resolve sessions through this map, and a request that
		// raced the replay must not find a session whose history is still
		// arriving.
		this.#sessions.set(live.sessionId, live);
		// No `models` in the response: it is UNSTABLE in the protocol, the same
		// reason `session/set_model` is not implemented (see the file header).
		return { modes: sessionModesFor(live.session.permissionMode) };
	}

	async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
		const live = this.#sessions.get(params.sessionId);
		if (!live) return {};
		const mode = permissionModeFromModeId(params.modeId);
		if (!mode) return {};
		// The sandbox axis is left where it stands — `setMode` takes it optionally
		// for exactly this reason (see its docstring in the agent package) — because
		// the protocol names one axis, and the other is the user's own setting.
		live.session.setMode(mode);
		await this.#update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
		return {};
	}

	async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
		const live = this.#sessions.get(params.sessionId);
		if (!live) throw acp.RequestError.invalidParams({ message: `unknown session ${params.sessionId}` });
		if (live.running) {
			throw acp.RequestError.invalidParams({ message: "this session already has a prompt in flight" });
		}
		const text = promptTextFrom(params.prompt);
		if (text.trim() === "") {
			throw acp.RequestError.invalidParams({ message: "the prompt carried no text" });
		}
		live.running = true;
		try {
			// The gate runs on the typed text, before anything is stored — the same
			// order `-p` uses, so a hook that blocks a prompt blocks it in both.
			const { runtime, context } = live.hooks;
			if (runtime.has("UserPromptSubmit")) {
				const outcome = await runtime.run("UserPromptSubmit", {
					prompt: text,
					session_id: live.sessionId,
					cwd: live.cwd,
				});
				for (const error of outcome.errors) {
					process.stderr.write(`Warning: UserPromptSubmit hook failed: ${error}\n`);
				}
				context.push(...outcome.addedContext);
				if (outcome.blocked) {
					throw acp.RequestError.internalError({
						message: `prompt blocked by UserPromptSubmit hook${outcome.reason ? `: ${outcome.reason}` : ""}`,
					});
				}
			}

			const reason = await live.session.prompt(text);
			const stopReason = stopReasonFor(reason);
			if (stopReason === null) {
				// `error`: no stop reason in the protocol means "the run failed", so
				// the failure is reported as one, carrying the loop's own message.
				throw acp.RequestError.internalError({
					reason,
					message: lastErrorMessage(live.session),
				});
			}
			return { stopReason };
		} finally {
			live.running = false;
		}
	}

	async cancel(params: acp.CancelNotification): Promise<void> {
		// A notification, and therefore unanswerable: an id nobody has is a no-op
		// rather than an error the client cannot hear. The turn it cancels answers
		// `session/prompt` with `cancelled`, which is where the protocol puts the
		// acknowledgement.
		this.#sessions.get(params.sessionId)?.session.abort();
	}

	/** One `session/update` notification. */
	async #update(sessionId: string, update: SessionUpdate): Promise<void> {
		await this.#conn?.sessionUpdate({ sessionId, update });
	}

	#onEvent(live: LiveSession, event: AgentEvent): void {
		if (event.type === "tool_execution_start") {
			live.permissions.announced.push({ callId: event.callId, toolName: event.toolName, asked: false });
		}
		if (event.type === "tool_execution_end") {
			live.permissions.announced = live.permissions.announced.filter((call) => call.callId !== event.callId);
		}
		for (const update of updatesForEvent(event)) {
			// Started, not awaited: the session's emitter awaits its handlers, and a
			// slow socket must not become the model loop's clock. The order is still
			// the call order — the web stream behind the connection queues writes and
			// processes them in the order they were made.
			void this.#update(live.sessionId, update);
		}
	}

	/**
	 * The permission round trip: an engine answer of "ask" becomes a
	 * `session/request_permission` the editor's user answers.
	 *
	 * `ctx.signal` is the run's abort — the same signal `session/cancel` fires —
	 * and the race below is what keeps a cancelled turn from sitting in a
	 * question nobody is looking at any more. Note what the abort answers with:
	 * the tool is settled as *denied*, not left pending, because the response to
	 * our request belongs to the client (the protocol requires *it* to answer
	 * `cancelled` for a cancelled turn) and abandoning the promise instead would
	 * leave the tool batch held open behind a dialog the editor has dismissed.
	 */
	async #canUseTool(
		sessionId: string,
		permissions: PermissionState,
		toolName: string,
		input: unknown,
		ctx: PermissionContext,
	): Promise<PermissionResult> {
		const decision = evaluatePermissions(toolName, input, {
			mode: ctx.mode,
			sandbox: ctx.sandbox,
			rules: permissions.rules,
			cwd: permissions.cwd,
			readOnlyToolNames: permissions.readOnlyToolNames,
		});
		if (decision.behavior !== "ask") return decision;
		const conn = this.#conn;
		if (!conn) {
			return { behavior: "deny", message: `Permission required and no client is connected (${toolName})` };
		}
		const answer = conn.requestPermission({
			sessionId,
			toolCall: {
				toolCallId: takeAnnouncedCallId(permissions, toolName),
				title: toolTitleFor(toolName, input),
				kind: toolKindFor(toolName),
				status: "pending",
				rawInput: asRecord(input) ?? { input },
			},
			options: acpPermissionOptions(toolName, input, permissions.cwd),
		});
		const response = await raceWithAbort(answer, ctx.signal);
		if (response === null) {
			return { behavior: "deny", message: `Permission request cancelled (${toolName})` };
		}
		if (response.outcome.outcome === "cancelled") {
			// The client's own cancel: the protocol says it must answer this way, and
			// the turn is already ending, so the tool is settled as interrupted.
			return { behavior: "deny", message: `Permission request cancelled by the client (${toolName})` };
		}
		const meaning = permissionFromOptionId(response.outcome.optionId);
		if (!meaning) {
			// An option id we never offered. Failing closed: nobody told us this call
			// may run.
			return { behavior: "deny", message: `Unrecognised permission option "${response.outcome.optionId}"` };
		}
		if (meaning.remember && !meaning.allow) {
			permissions.rules.push({ toolName, behavior: "deny", source: "session" });
		}
		if (meaning.remember && meaning.allow) {
			// The same session-scoped rule the REPL's "don't ask again" writes, scoped
			// the same way (`ruleSpecifierFor`), so an "always" answer in an editor
			// cannot grant more than the same answer in a terminal.
			permissions.rules.push({
				toolName,
				specifier: ruleSpecifierFor(toolName, input, permissions.cwd),
				behavior: "allow",
				source: "session",
			});
		}
		return meaning.allow ? { behavior: "allow" } : { behavior: "deny", message: "User denied permission" };
	}

	/**
	 * What the process still owes its sessions: a close-out note each, then the
	 * `SessionEnd` runs.
	 *
	 * The note goes down first, the order the REPL writes its own in — it
	 * describes the state the session ended in, not the state after the hooks
	 * below ran. Every open session gets one (a connection can hold several),
	 * written through the store its turns went to, a resumed session's own file
	 * included. The counts are this host's structural zeros: no background
	 * shells (it starts none) and no live subagents (an editor session builds no
	 * `Task` tool, so it cannot spawn one); the recovered-shell zero is the
	 * writer's documented drop rather than a written field. Best effort, like
	 * every ledger write: a note that cost the shutdown would be worse than a
	 * session that closes out in silence.
	 */
	async shutdown(): Promise<void> {
		for (const live of this.#sessions.values()) {
			try {
				writeMissionRecord(live.store, {
					reason: "exit",
					shellsRunning: 0,
					subagentsLive: 0,
					shellsRecovered: 0,
				});
			} catch {
				// best effort — see above
			}
			const outcome = await live.hooks.runtime.run("SessionEnd", {
				session_id: live.sessionId,
				cwd: live.cwd,
			});
			for (const message of advisoryHookFailures("SessionEnd", outcome)) {
				process.stderr.write(`Warning: ${message}\n`);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Session assembly
	//
	// The shape `headless.ts` assembles a `-p` run in: the same settings tiers,
	// the same permission rules and engine, the same tool set, the same compaction
	// wiring, the same hooks and the same spill directory. It is written out here
	// rather than shared with headless because the two differ in exactly the
	// places that matter — the defaults each mode is allowed to pick, the mode
	// sources, and where a turn's output goes — and a parameter object wide enough
	// to cover both would be a second, worse definition of "a session".
	// -----------------------------------------------------------------------

	async #createSession(cwd: string, resumed?: ResumedSession): Promise<LiveSession> {
		const options = this.#options;
		const home = options.home ?? homedir();

		const loadedSettings = loadSettings(cwd, options.flagSettings, home);
		const { settings } = loadedSettings;
		const ignoredNotice = formatIgnoredKeysNotice(loadedSettings.ignoredKeys);
		if (ignoredNotice) process.stderr.write(`Warning: ${ignoredNotice}\n`);
		applySettingsEnv(settings);
		applyCatalogSettings(settings);

		// `settings.roles`, resolved once: fail-soft like the REPL's and the `-p`
		// run's, warned on stderr because stdout is frames only. An editor session
		// has no plan mode and no subagents, so the plan and light seats are
		// resolved but unused here — a warning about one is still worth its line,
		// since the same settings file serves the terminal.
		const resolvedRoles = await resolveRoles(settings.roles, () =>
			settings.modelDiscovery !== false ? refreshModelCatalog({ models: dynamicProviderTemplates() }) : undefined,
		);
		// No prefix added: these strings carry their own "Warning: ", unlike the
		// bare sentence `noToolCallingNotice` returns.
		for (const warning of resolvedRoles.warnings) process.stderr.write(`${warning}\n`);

		// The same priority the REPL resolves in: the explicit `--model`, then the
		// user's persisted choice, then `roles.main`, then the built-in default.
		const builtinModelRef = "anthropic/claude-sonnet-5";
		const modelRef = options.modelRef ?? settings.model;
		let model = modelRef ? resolveModel(modelRef) : (resolvedRoles.main.model ?? resolveModel(builtinModelRef));
		if (!model && modelRef && settings.modelDiscovery !== false) {
			// The same targeted exception headless makes: a ref only a listing can
			// name is worth one catalog refresh, and nothing else here reaches the
			// network on its own.
			await refreshModelCatalog({ models: dynamicProviderTemplates() });
			model = resolveModel(modelRef);
		}
		if (!model) {
			// A throw rather than a stderr line and an exit code: the editor asked
			// for a session, and there is one thing it needs to know.
			throw acp.RequestError.internalError({ message: `Unknown model: ${modelRef ?? builtinModelRef}` });
		}
		if (model.toolCalling === false) process.stderr.write(`Warning: ${noToolCallingNotice(model)}\n`);

		// `roles.compaction.model` is the newer spelling of the same choice and
		// wins where both are set; the older `settings.compaction.model` keeps
		// working alone.
		const compactionSettings = settings.compaction;
		const compactionSummarizer = resolvedRoles.compaction.model
			? { model: resolvedRoles.compaction.model }
			: await resolveCompactionSummarizer(compactionSettings?.model, () =>
					settings.modelDiscovery !== false ? refreshModelCatalog({ models: dynamicProviderTemplates() }) : undefined,
				);
		if (compactionSummarizer.warning) process.stderr.write(`Warning: ${compactionSummarizer.warning}\n`);
		// The tuning struct exists when either key named the summarizer: with only
		// `roles.compaction.model` set there are no knobs, but the model still has
		// to travel — a struct built only for `settings.compaction` would leave the
		// role resolved and never read, and the session model would summarize.
		const compactionTuning: CompactionTuning | undefined =
			compactionSettings || compactionSummarizer.model
				? {
						summarizerModel: compactionSummarizer.model,
						reserveTokens: compactionSettings?.reserveTokens,
						thresholdPercent: compactionSettings?.thresholdPercent,
						enabled: compactionSettings?.enabled,
					}
				: undefined;

		// One shared executor, the REPL's own rule: the confiner below and the
		// Bash tool must resolve shells, backends, and proxies identically, so
		// it is built here and handed to both. The shell is resolved before the
		// runtime — the Windows probe runs this shell — and the one runtime
		// serves the executor and the background manager, so nothing re-probes
		// the machine.
		const shell = detectShell();
		const runtime = detectRuntime(process.platform, shell);
		const ops: Operations = defaultOperations(new ChildProcessExecOperations(runtime, shell));
		const backgroundShells = new BackgroundShellManager(runtime, ops);
		// The board this live session keeps. It is per session, like the store it is
		// bound to below: a connection can hold several sessions, and a list one of
		// them holds is not another's. The tools are built from it here, before the
		// store exists, because the store is the resume/new choice made a few lines
		// down and the binding only needs the instance.
		const taskStore = new TaskStore();
		const tools = createAllTools(cwd, {
			taskStore,
			operations: ops,
			backgroundShells,
			readOnlyRoots: [toolOutputRoot(cwd)],
			spillDir: toolSpillDir(cwd),
			home,
			writableRoots: settings.permissions.additionalDirectories,
		});
		// No subagent tools are built here — an editor session has no `Task` — so
		// this host writes no `subagent_start`/`subagent_end` entries for anything
		// to pair: there is no store getter to wire because there is no spawner.
		// The ledger's read side below still speaks for a session a REPL or a `-p`
		// run left a dead run in (see `missions.md` for the decision).
		// A resumed session hands in the store its file was loaded into, and every
		// turn after the replay appends through that same store. Opening the file
		// a second time here would leave two ledgers over one path — the replay
		// read from one, the new turns written by the other — which is why the
		// parameter exists rather than a path.
		const store = resumed?.store ?? SessionStore.startNew(cwd, home);
		const sessionId = store.sessionId;
		if (!sessionId) throw acp.RequestError.internalError({ message: "the session store produced no id" });
		// Restore the list a loaded session holds and record every change after
		// that, the pair the REPL and a `-p` run make. A session/load of a store
		// with snapshots therefore comes up with the board the last run left, and
		// every live session saves into its own file because the store here is
		// this session's.
		bindTaskStore(taskStore, () => store);
		pruneToolOutput(cwd);
		const rules = collectPermissionRules(loadedSettings);

		// The one startup notice this host prints, from one of the three ledgers:
		// the subagent runs a previous process left unfinished, read from the very
		// file a load resumed. The same line the REPL prints, on stderr because
		// stdout is frames only — and it needs no new/load branch of its own, since
		// a fresh session reads an empty ledger and says nothing. The mission
		// summary and the shell recovery warning stay REPL-only: both sentences
		// send the reader to `/ps`, which no editor session has (the decision is
		// recorded in `mission-ledger.ts`). Nothing here becomes a protocol frame:
		// there is no session/update for a notice, and this one is not an update.
		const subagentNotice = formatSubagentRecovery(readSubagentLedger(store));
		if (subagentNotice) process.stderr.write(`Warning: ${subagentNotice}\n`);

		// The defaults are the REPL's, not headless's: an editor has a person in
		// front of it, and an "ask" that reaches them is the whole point of the
		// permission round trip. `settings.permissionMode`/`settings.sandbox` govern
		// exactly this — the interactive default — and the pairing nobody set comes
		// from the one table both apps read.
		const {
			mode: effectiveMode,
			sandbox: effectiveSandbox,
			downgradeReason,
		} = resolveMode(
			{
				mode: options.permissionMode ?? settings.permissionMode ?? DEFAULT_MODE_CHOICE.mode,
				sandbox: options.sandbox ?? settings.sandbox ?? DEFAULT_MODE_CHOICE.sandbox,
			},
			loadedSettings,
		);
		if (downgradeReason) process.stderr.write(`Warning: ${downgradeReason}\n`);
		const effectiveNetwork = networkAxisFrom(settings, options.network);

		// The spawns outside the Bash tool — hook commands — run under the same
		// axes. The holder exists because the SessionStart hook below runs, and
		// reaches the confiner, before the session does; the getters read it per
		// spawn, not captured, because `session/set_mode` can move the sandbox
		// axis mid-session (see `setSessionMode`).
		const liveRef: { current?: AgentSession } = {};
		const spawnConfine = createSpawnConfiner({
			cwd,
			ops,
			sandbox: () => liveRef.current?.sandbox ?? effectiveSandbox,
			network: () => liveRef.current?.network ?? effectiveNetwork,
			home,
			writableRoots: settings.permissions.additionalDirectories,
		});
		const hooksRuntime = snapshotHooks(settings.hooks, spawnConfine);
		const hookContext: string[] = [];
		const sessionStart = await hooksRuntime.run("SessionStart", { session_id: sessionId, cwd });
		hookContext.push(...sessionStart.addedContext);
		for (const message of advisoryHookFailures("SessionStart", sessionStart)) {
			process.stderr.write(`Warning: ${message}\n`);
		}

		// The Claude, ChatGPT and Gemini subscriptions, when one is signed in: an
		// editor session reads the same stored sign-in the REPL does, so the entry
		// points cannot disagree about which credential serves a request.
		const transport: { streamFn: StreamFn; tracker?: CacheTracker } = options.streamFn
			? { streamFn: options.streamFn }
			: createTrackedStreamFn({
					policy: settings.cache,
					credentials: createClaudeCredentials({ home }),
					chatgptCredentials: createChatGptCredentials({ home }),
					geminiCredentials: createGeminiCredentials({ home }),
				});
		// The fallback chain is per-role now: `resolveChain` receives the model
		// that actually failed, and the seat it belongs to decides what comes
		// next — the role's own `fallback` list first, then `settings.fallbackModels`
		// as the net under everything. The main order is anchored at `roles.main`
		// (falling back to the session model when the seat is unset), so an
		// explicit `--model` landing inside the list still descends below its slot.
		// An editor session has no plan mode and spawns no `Task` subagents, so
		// the plan and light seats contribute no orders here.
		const globalFallbacks = (settings.fallbackModels ?? [])
			.map((ref) => resolveModel(ref))
			.filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
		const mainSeat = resolvedRoles.main.model ?? model;
		// Which seat owns which model ref, and the ceiling it carries — the
		// lookup the budget gate runs on every request, from the same resolution
		// as the orders because the seat a model belongs to decides both.
		const seatTable = seatsByRef(resolvedRoles);
		const roleOrders = [
			roleOrder(mainSeat, resolvedRoles.main.fallback, globalFallbacks),
			...(resolvedRoles.compaction.model
				? [roleOrder(resolvedRoles.compaction.model, resolvedRoles.compaction.fallback, globalFallbacks)]
				: []),
		];
		const streamFn = withModelFallback(transport.streamFn, createModelChainResolver(roleOrders, globalFallbacks));

		const memory = loadMemoryFiles(cwd, home);
		const { skills, notes: skillNotes } = loadSkillsWithNotes(cwd, home);
		// The model's door to the same skills the discovery block lists, merged
		// beside the sandbox tools because the skill directory is this package's
		// to know. No `Task` and no plan tools are built here, but a skill is a
		// document rather than a spawner: nothing about an editor session argues
		// the model out of reading one, and the block this host sends names the
		// tool — a promise this host has to keep.
		const allTools = [...tools, createSkillTool(skills)];
		// Where headless says these on stderr because a scripted run has nowhere
		// else to say them, an ACP session says them for the same reason: a skill
		// the author believes is loaded and is not is worse than no skill.
		for (const note of skillNotes) process.stderr.write(`Skills: ${note}\n`);

		const compactionWiring = createCompactionWiring({
			model,
			store,
			streamFn,
			trimOldToolResults: settings.trimOldToolResults,
			tuning: compactionTuning,
			report: (text) => process.stderr.write(`${text}\n`),
			readFile: (path) => {
				try {
					return readFileSync(path, "utf8");
				} catch {
					return null;
				}
			},
			noteRewrite: (cause) => transport.tracker?.note(cause),
			// The end of a pass is the first moment the chain below the boundary can
			// hold the list again, and the save is the same one the REPL makes at the
			// same point. The reporting is the wiring's default, reproduced because
			// passing `onPhase` replaces it: an editor session's surface is stderr,
			// and it must keep saying exactly what it said before the board existed.
			onPhase: (phase) => {
				const text = compactionPhaseText(phase);
				if (text) process.stderr.write(`${text}\n`);
				if (phase.kind !== "done") return;
				for (const warning of compactionWarnings(phase.verification)) process.stderr.write(`${warning}\n`);
				saveTasks(taskStore, store);
			},
		});

		const permissions: PermissionState = {
			cwd,
			rules,
			readOnlyToolNames: collectReadOnlyToolNames(allTools),
			announced: [],
		};
		// Annotated because `checkBudget` below reads this very session's
		// messages: without it the type would be inferred from its own initializer.
		const session: AgentSession = new AgentSession({
			model,
			systemPrompt: buildSystemPrompt(allTools, {
				cwd,
				platform: process.platform,
				isTTY: process.stdout.isTTY ?? false,
				memory: memory.content,
				language: settings.language,
				outputStyle: resolveOutputStyle(settings.outputStyle, loadOutputStyles(cwd, home))?.content,
				skills: skillDiscoveryBlock(skills, skillDiscoveryBudgetChars(model.contextWindow)),
			}),
			tools: allTools,
			store,
			cwd,
			maxTurns: options.maxTurns,
			permissionMode: effectiveMode,
			sandbox: effectiveSandbox,
			network: effectiveNetwork,
			deps: {
				streamFn,
				thinkingLevel: () => settings.thinkingLevel,
				checkCompaction: compactionWiring.checkCompaction,
				// The spending ceiling, asked before every request: the model
				// about to answer names the seat (a model no seat owns is never
				// gated), and the spend is this conversation's cumulative total
				// at that moment, re-costed from the transcript's own usage
				// records — an editor session has no ledger of its own, and its
				// messages are the record every host's JSON result is costed
				// from. A resumed conversation counts what it already spent,
				// because the costed messages are the ones it was resumed with.
				checkBudget: ({ model: answering }) => {
					const seat = seatTable.get(modelRefKey(answering));
					if (!seat) return { action: "ok" };
					return budgetVerdict(costStateFromMessages(session.messages).totalCostUSD, seat);
				},
				spillOutput: (request) => writeToolOutput(request, { cwd, sessionId, home }),
				// The difference from headless, and the point of this batch: an
				// unresolved "ask" becomes a question with four answers instead of a
				// silent denial.
				canUseTool: (toolName, input, ctx) => this.#canUseTool(sessionId, permissions, toolName, input, ctx),
				hooks: sessionHookDeps({ runtime: hooksRuntime, context: hookContext, cwd }),
			},
		});
		// From here the confiner's getters answer with this session's axes,
		// including whatever `session/set_mode` moves afterwards.
		liveRef.current = session;
		// The transcript a resume handed back, into the session that will carry
		// it — the same seeding `headless.ts` does for `--resume`. A session that
		// was just started has none.
		if (resumed) session.messages.push(...resumed.messages);
		const live: LiveSession = {
			session,
			store,
			sessionId,
			cwd,
			permissions,
			hooks: { runtime: hooksRuntime, context: hookContext },
			running: false,
		};
		session.on((event) => this.#onEvent(live, event));
		return live;
	}
}

/**
 * The tool call id of the call this permission question belongs to.
 *
 * Taken from the `tool_execution_start` the session emitted just before asking,
 * so the editor attaches the question to the tool call it is already showing
 * instead of to a second one it has never heard of. Concurrent calls of the same
 * tool are why this is a list with a consumed flag rather than a map by name.
 */
function takeAnnouncedCallId(permissions: PermissionState, toolName: string): string {
	const found = permissions.announced.find((call) => call.toolName === toolName && !call.asked);
	if (found) {
		found.asked = true;
		return found.callId;
	}
	return `permission_${toolName}`;
}

/**
 * Wait for the editor's answer, or give up when the run is aborted.
 *
 * Returns `null` for the abort, which is a different fact from the client's own
 * `{outcome: "cancelled"}` — the caller reports both as a denial, but only one of
 * them means the client spoke.
 */
async function raceWithAbort(
	answer: Promise<acp.RequestPermissionResponse>,
	signal: AbortSignal | undefined,
): Promise<acp.RequestPermissionResponse | null> {
	if (!signal) return answer;
	if (signal.aborted) return null;
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<null>((resolveAbort) => {
		onAbort = () => resolveAbort(null);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([answer, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/** The loop's own last word on why a run ended, for the error response. */
function lastErrorMessage(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const message = session.messages[i];
		if (message?.role === "assistant" && message.errorMessage) return message.errorMessage;
	}
	return "the run ended with an error";
}

/**
 * Serve ACP on stdio until the client closes its end.
 *
 * Nothing but frames goes to stdout from here on: the connection owns the
 * stream, and every notice this file writes goes to stderr (see the header).
 */
export async function runAcp(options: AcpOptions = {}): Promise<number> {
	const toClient = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
	const fromClient = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	const stream = acp.ndJsonStream(toClient, fromClient);
	const agent = new AcpAgent(options);
	new acp.AgentSideConnection((conn) => {
		agent.attach(conn);
		return agent;
	}, stream);
	await waitForInputEnd();
	await agent.shutdown();
	return 0;
}

/** Resolves when stdin ends — the client's way of ending the session. */
function waitForInputEnd(): Promise<void> {
	if (process.stdin.readableEnded) return Promise.resolve();
	return new Promise((resolveDone) => {
		process.stdin.once("end", () => resolveDone());
	});
}
