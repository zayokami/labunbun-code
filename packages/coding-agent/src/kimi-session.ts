/**
 * Kimi Code session transcripts (`$KIMI_CODE_HOME/sessions`).
 *
 * A Kimi Code session is a directory per conversation, and inside it one
 * `agents/<agentId>/wire.jsonl` per agent: an append-only journal of everything
 * that shaped the agent's context. The transcript read here is the journal, not
 * the context — the two differ, and the difference is the whole difficulty of
 * this module.
 *
 * The context is what the model was sent: `context.apply_compaction` throws the
 * prefix away and keeps a summary, `context.undo` takes a rewind back, and
 * `context.clear` empties it. The journal keeps every one of those records plus
 * the messages they discarded, in order, which is why Kimi's own reader rebuilds
 * the context by *folding* the journal (`agent/replayBuilder/fold.ts`) instead
 * of reading it. This module mirrors that fold rather than inventing a reading:
 * the boundary an imported session resumes from has to be the boundary Kimi
 * itself would resume from, or the import is a summary of a conversation the
 * user never had.
 *
 * Concretely, the fold's rules are reproduced here one for one:
 *
 *   - a message appended while a tool result is still outstanding waits behind
 *     it (`appendMessage`'s deferral), because the journal can deliver a user
 *     message mid-tool-run and the context never holds it in that order;
 *   - `step.begin` opens an assistant message, `content.part` fills it and
 *     `tool.call` adds a call to it, so an assistant turn is several records;
 *   - a call with no result by the time the step ends is closed with an error
 *     result (`TOOL_INTERRUPTED_ON_RESUME_OUTPUT` there), which is what keeps an
 *     interrupted turn from losing both halves of its pair;
 *   - `context.undo` walks back over *real user inputs* — skipping injections
 *     and stopping at a compaction summary — and the messages it removed leave
 *     the journal too;
 *   - `context.clear` empties the context and leaves the journal alone, so a
 *     cleared session still imports with its whole transcript;
 *   - `context.apply_compaction` replaces the context with the summary (plus the
 *     legacy kept tail, when the record is in the old shape) and binds that
 *     summary to the `full_compaction.begin` record already in the journal.
 *
 * What this reader does *not* do is as deliberate. Reasoning that arrives only
 * encrypted is counted and dropped rather than carried as a signature this build
 * cannot vouch for; audio and video parts, tool displays and every bookkeeping
 * record (`turn.prompt`, `llm.request`, `usage.record`, the goal and permission
 * records) are left behind, none of which the model ever saw as content. And a
 * journal whose records cannot be folded at all — a `content.part` for a step
 * that was never opened — is refused rather than half-read, because a reader
 * that guesses there is a reader that imports a prefix the source itself
 * dropped.
 *
 * Nothing here writes, and nothing outside `<root>/sessions` is opened.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	type AgentMessage,
	type AssistantContent,
	assistantMessage,
	type ImageContent,
	repairToolPairing,
	type StopReason,
	type ThinkingContent,
	type ToolCall,
	type ToolResultContent,
	textContent,
	toolResultMessage,
	type Usage,
	type UserContent,
	userMessage,
} from "@labunbun/ai";
import { caseInsensitivePaths } from "@labunbun/tools";
import { kimiSessionsDir } from "./kimi-home.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One session worth offering: `state.json` read, the main agent's wire found. */
export interface KimiSessionFile {
	/** The directory's name — the id Kimi itself uses. */
	sessionId: string;
	/** The session directory. */
	dir: string;
	/** `<dir>/agents/<agentId>/wire.jsonl`, the conversation rather than a sub-thread. */
	path: string;
	/** Which agent that wire belongs to (`main` for an ordinary session). */
	agentId: string;
	cwd: string;
	/** `state.createdAt` (epoch ms), 0 when nothing states one. */
	startedAt: number;
	/** `state.updatedAt` (epoch ms), 0 when nothing states one. */
	updatedAt: number;
	title: string;
	/** `state.archived` — Kimi filed it away rather than leaving it in the list. */
	archived: boolean;
	/** The session this one was forked from, "" for an original. */
	forkedFrom: string;
}

export interface KimiListing {
	sessions: KimiSessionFile[];
	notes: Array<{ reason: string; count: number }>;
}

export type KimiEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface KimiRead {
	entries: KimiEntry[];
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** How much of a wire the listing reads to place a session with no state file. */
const WIRE_HEAD_BYTES = 64 * 1024;

/** The protocol this reader understands; a wire newer than it is reported. */
const KNOWN_WIRE_PROTOCOL = "1.5";

/**
 * Every session Kimi's own list would show.
 *
 * The walk is the authority on what exists, and `<root>/session_index.jsonl` is
 * not: it is an append log of `{sessionId, sessionDir, workDir}` lines that also
 * holds deletions and, as the tool's own reader notes, entries pointing outside
 * the sessions tree. It is therefore read only to attribute a working directory,
 * and only for a line whose `sessionDir` is the directory the walk actually
 * found — a stale line must not place a conversation in a project it never ran
 * in.
 *
 * Three things are skipped, each for its own reason:
 *
 *   - a child session (`custom.child_session_kind === "child"`), which is a
 *     subagent conversation spawned for a task rather than one the user had;
 *     Kimi writes it beside its parent, with both keys, so the marker is exact;
 *   - every agent's journal but the main agent's, counted as subagent threads:
 *     a session's `agents/` directory holds one wire per agent, and importing
 *     each would import the same conversation several times over;
 *   - a directory that is neither a session nor meant to be one (no state file
 *     and no `agents/`) is passed over in silence, because a note about
 *     something the user never had is a note about nothing. A directory with an
 *     `agents/` directory but no readable state is a *broken* session, and that
 *     is counted.
 */
export function listKimiSessions(root: string): KimiListing {
	const sessions: KimiSessionFile[] = [];
	const counts = new Map<string, number>();
	const sessionsRoot = kimiSessionsDir(root);
	const index = readSessionIndex(root);

	let buckets: string[];
	try {
		buckets = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return { sessions, notes: toNotes(counts) };
	}

	for (const bucket of buckets) {
		// `.index-cache` (a scan cache) and `.index-dirty` (a journal of dirty
		// marks) sit in this very tree and are not workspaces; Kimi's own walk
		// skips those two by name. The prefix rule is this reader's own and is
		// safe for the same reason: a workspace id can never begin with a dot,
		// because the tool builds every one of them as `wd_<slug>_<hash>`
		// (`encodeWorkDirKey`), so a dotted directory here is bookkeeping
		// whichever release wrote it.
		if (bucket.startsWith(".")) continue;
		const bucketDir = join(sessionsRoot, bucket);
		let entries: string[];
		try {
			entries = readdirSync(bucketDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const name of entries) {
			if (name.startsWith(".")) continue;
			const dir = join(bucketDir, name);
			const state = readSessionState(dir);
			const agentsDir = join(dir, "agents");
			if (state === null && !existsSync(agentsDir)) continue;
			if (state === null) bump(counts, "session with no readable state.json");
			if (isChildSession(state)) {
				bump(counts, "subagent session");
				continue;
			}
			const agents = listAgents(agentsDir, state);
			const chosen = chooseAgent(agents, agentsDir);
			if (chosen === null) {
				bump(counts, "session with no main agent transcript");
				continue;
			}
			if (chosen.others > 0) bump(counts, "subagent thread in the same session", chosen.others);
			const path = join(agentsDir, chosen.agentId, "wire.jsonl");
			if (!existsSync(path)) {
				bump(counts, "session with no transcript");
				continue;
			}
			const head = readWireHead(path);
			sessions.push({
				sessionId: name,
				dir,
				path,
				agentId: chosen.agentId,
				cwd: recoverCwd(state) || index.get(projectKey(dir)) || head.cwd,
				startedAt: stateTime(state, "createdAt") || head.createdAt,
				updatedAt: stateTime(state, "updatedAt") || stateTime(state, "createdAt"),
				title: sessionTitle(state),
				archived: state?.archived === true,
				forkedFrom: asText(state?.forkedFrom),
			});
		}
	}
	return { sessions, notes: toNotes(counts) };
}

/** A session directory holding another session's subagent thread. */
function isChildSession(state: Record<string, unknown> | null): boolean {
	const custom = asRecord(state?.custom);
	return custom?.child_session_kind === "child";
}

/** One agent inside a session directory, as the state file describes it. */
interface KimiAgent {
	agentId: string;
	/** `main` | `sub` | `independent`, defaulted the way Kimi's own reader does. */
	type: string;
}

/**
 * The agents of a session: what `state.agents` names, plus any directory under
 * `agents/` it does not.
 *
 * Both directions are needed. A state file written before an agent was
 * registered would leave a journal nobody lists; a state file that lost its
 * agents map (the tool's own reader calls this the empty-inventory case) would
 * hide every journal on disk.
 */
function listAgents(agentsDir: string, state: Record<string, unknown> | null): KimiAgent[] {
	const out = new Map<string, KimiAgent>();
	for (const [id, meta] of Object.entries(asRecord(state?.agents) ?? {})) {
		if (!isSafeAgentId(id)) continue;
		const type = asText(asRecord(meta)?.type);
		out.set(id, { agentId: id, type: type === "main" || type === "sub" || type === "independent" ? type : "" });
	}
	let names: string[];
	try {
		names = readdirSync(agentsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		names = [];
	}
	for (const name of names) {
		if (!isSafeAgentId(name) || out.has(name)) continue;
		out.set(name, { agentId: name, type: "" });
	}
	return [...out.values()]
		.map((agent) => ({ ...agent, type: agent.type || (agent.agentId === "main" ? "main" : "sub") }))
		.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

/** `isSafeAgentId`: the tool's own guard against a name that walks the tree. */
function isSafeAgentId(id: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";
}

/**
 * Which agent's journal is the conversation.
 *
 * The tool resolves it as the literal `agents/main/wire.jsonl`: the engine
 * registers exactly that id as the session's `main` agent
 * (`sessionLifecycleService`) and its own readers — the CLI's replay
 * (`agents['main']`) and the viewer's route (which defaults to `main` and
 * refuses when there is none) — name nothing else. So the agent named `main`
 * comes first here too.
 *
 * The rest exists so a session whose main journal is not on disk is imported
 * rather than lost, and it is a ranking of *kinds* rather than knowledge:
 * an `independent` agent has no parent (the viewer's own disk-only inventory
 * labels every non-main agent that way when `state.json` is unreadable), so its
 * journal is a conversation of its own, where a `sub`'s is a thread of the
 * session's. Last comes the only agent with a journal at all, for a session old
 * enough to predate the field.
 *
 * Everything else is a sub-thread, and the count travels to the report rather
 * than being silently dropped: a user who ran subagents should be told their
 * transcripts stayed behind.
 */
function chooseAgent(agents: KimiAgent[], agentsDir: string): { agentId: string; others: number } | null {
	for (const type of ["main", "independent"]) {
		const ofType = agents.filter((agent) => agent.type === type);
		if (ofType.length > 0) return { agentId: ofType[0]?.agentId ?? "", others: agents.length - 1 };
	}
	const withWire = agents.filter((agent) => existsSync(join(agentsDir, agent.agentId, "wire.jsonl")));
	if (withWire.length === 1) return { agentId: withWire[0]?.agentId ?? "", others: agents.length - 1 };
	return null;
}

/**
 * The session's working directory: `cwd`, then `workDir`, then `custom.cwd`.
 *
 * These three spellings are the tool's own recovery order, and `cwd` alone would
 * report an older session as having none — a session with no directory is one
 * this importer cannot scope to a project.
 */
function recoverCwd(state: Record<string, unknown> | null): string {
	for (const value of [state?.cwd, state?.workDir, asRecord(state?.custom)?.cwd]) {
		const text = asText(value);
		if (text) return text;
	}
	return "";
}

/** `state.json`, at the canonical path and then the legacy `session-meta/`. */
function readSessionState(dir: string): Record<string, unknown> | null {
	for (const path of [join(dir, "state.json"), join(dir, "session-meta", "state.json")]) {
		const text = readTextOrNull(path);
		if (text === null) continue;
		const parsed = parseJsonLine(text);
		if (parsed !== null) return parsed;
	}
	return null;
}

/** An epoch-ms field of the state file, by either of the spellings it uses. */
function stateTime(state: Record<string, unknown> | null, key: "createdAt" | "updatedAt"): number {
	const value = state?.[key];
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

/** The session's title, falling back to the last prompt — never a fabricated one. */
function sessionTitle(state: Record<string, unknown> | null): string {
	return firstText(asText(state?.title)) || firstText(asText(state?.lastPrompt));
}

/**
 * `session_index.jsonl` as `sessionDir → workDir`, for the entries whose
 * `sessionDir` is the directory the walk found.
 *
 * The file is an append log, so it holds lines for sessions that are gone (a
 * deletion is a line too), lines a hand edited, and lines for a session that was
 * copied into another workspace — this tool's own legacy migration copies session
 * directories between buckets, which is the one way two lines can name one id.
 * A prompt history imported under the wrong project is worse than one left
 * behind, so an entry is used only when its `sessionDir` is the directory the
 * walk actually found, and one whose basename is not the id its line claims is
 * refused outright. That is stricter than the tool's own reader, which uses the
 * index to *find* a session and therefore has to accept any line whose directory
 * exists and lies under `<root>/sessions`; keying by the directory is what this
 * reader can afford, because it already knows which directory it is reading and
 * only wants the project name that goes with it.
 */
function readSessionIndex(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const text = readTextOrNull(join(root, "session_index.jsonl"));
	if (text === null) return out;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parsed = parseJsonLine(line);
		if (parsed === null) continue;
		const sessionId = asText(parsed.sessionId);
		const sessionDir = asText(parsed.sessionDir);
		const workDir = asText(parsed.workDir);
		if (!sessionId || !sessionDir || !workDir) continue;
		if (basename(sessionDir.replace(/[/\\]+$/, "")) !== sessionId) continue;
		out.set(projectKey(sessionDir), workDir);
	}
	return out;
}

/** Canonical form of a path, so two spellings of one directory compare equal. */
function projectKey(path: string): string {
	const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return caseInsensitivePaths ? slashed.toLowerCase() : slashed;
}

/**
 * What the first records of a wire say about the session.
 *
 * A session whose state file was written by an older release can carry no `cwd`,
 * and the wire's own `config.update` is then the only place the project is
 * named. Only the first {@link WIRE_HEAD_BYTES} are read: the record is written
 * when the session starts, so a wire that names its directory later than that is
 * reported as having none rather than read to the end during a listing.
 */
function readWireHead(path: string): { cwd: string; createdAt: number } {
	let text: string;
	try {
		const size = statSync(path).size;
		const length = Math.min(size, WIRE_HEAD_BYTES);
		const buffer = Buffer.alloc(length);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, length, 0);
		} finally {
			closeSync(fd);
		}
		// The window can end mid-line, and half a JSON object is not one: the fragment
		// reaches the loop below and is dropped there, by the same parse that drops
		// every other line this reader cannot read.
		text = buffer.toString("utf8");
	} catch {
		return { cwd: "", createdAt: 0 };
	}
	let cwd = "";
	let createdAt = 0;
	for (const line of text.split("\n")) {
		const record = parseJsonLine(line);
		if (record === null) continue;
		if (cwd === "" && record.type === "config.update") cwd = asText(record.cwd);
		if (createdAt === 0 && record.type === "metadata") createdAt = epochMs(record.created_at);
		if (cwd !== "" && createdAt !== 0) break;
	}
	return { cwd, createdAt };
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/** One message the fold holds, with the bookkeeping its own rules need. */
interface KimiMessage {
	message: AgentMessage;
	/** `origin.kind` of the record that appended it, "" when it stated none. */
	origin: string;
	/** `origin.trigger`, for the two origins whose disposition depends on it. */
	trigger: string;
	/** `isRealUserInput`: an `undo` counts back over these. */
	realUserInput: boolean;
	/** Where the message sits in the imported transcript, for `undo` to remove. */
	stream?: KimiStreamItem;
}

/** One thing the imported transcript holds, in the order the journal produced it. */
type KimiStreamItem =
	| { kind: "message"; entry: KimiMessage }
	| { kind: "compaction"; summary: string; preTokens: number; open: boolean };

/** A tool call the journal opened and has not yet paired with a result. */
interface PendingCall {
	id: string;
	name: string;
}

/**
 * Read one session end to end.
 *
 * Returns `{ error }` only when the journal cannot be folded — a record that
 * names a step the journal never opened, which is a journal the tool itself
 * refuses to replay. Every other surprise inside the file is a line this reader
 * counts and leaves behind, which is what keeps one unknown record from costing
 * the user a whole conversation.
 */
export function readKimiSession(session: KimiSessionFile): KimiRead | { error: string } {
	const text = readTextOrNull(session.path);
	if (text === null) return { error: "session transcript could not be read" };

	const counts = new Map<string, number>();
	const stream: KimiStreamItem[] = [];
	const history: KimiMessage[] = [];
	let deferred: KimiMessage[] = [];
	const pending = new Map<string, PendingCall>();
	const openSteps = new Map<string, KimiMessage>();
	let lastTime = session.startedAt;

	/** Append messages to the context and the transcript, in that order. */
	const push = (messages: KimiMessage[]): void => {
		for (const entry of messages) {
			history.push(entry);
			const item: KimiStreamItem = { kind: "message", entry };
			entry.stream = item;
			stream.push(item);
		}
	};
	const flushDeferred = (): void => {
		if (pending.size > 0 || deferred.length === 0) return;
		const queued = deferred;
		deferred = [];
		push(queued);
	};
	/**
	 * Close the steps the journal left open, so nothing imports as still streaming.
	 *
	 * A step can be left open three ways: the process died before its `step.end`,
	 * the journal ends there, or a `context.clear`/`undo`/compaction dropped the
	 * step from the context while its records stayed in the journal. The source
	 * says nothing about how any of those ended, so the reason is derived from what
	 * the step holds — the same reading the ZCode and dsh readers make.
	 */
	const sealOpenSteps = (): void => {
		for (const step of openSteps.values()) {
			if (step.message.role !== "assistant") continue;
			step.message.stopReason = stopReasonOf("", step.message.content);
		}
		openSteps.clear();
	};
	/** A call whose result never came is closed as an error, the way the fold does. */
	const closePending = (time: number): void => {
		if (pending.size === 0) return;
		const closed: KimiMessage[] = [];
		for (const call of pending.values()) {
			closed.push(
				resultItem(
					toolResultMessage(call.id, call.name || UNKNOWN_TOOL_NAME, resultContent(INTERRUPTED_OUTPUT), true, time),
				),
			);
		}
		pending.clear();
		push(closed);
		flushDeferred();
	};

	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const record = parseJsonLine(line);
		if (record === null) {
			bump(counts, "malformed line");
			continue;
		}
		const type = asText(record.type);
		if (!type) {
			bump(counts, "malformed line");
			continue;
		}
		const time = epochMs(record.time) || lastTime;
		lastTime = time;

		if (type === "metadata") {
			const protocol = asText(record.protocol_version);
			if (protocol && isNewerProtocol(protocol)) {
				counts.set(`journal written by a newer wire protocol (${protocol}): read as ${KNOWN_WIRE_PROTOCOL}`, 1);
			}
			continue;
		}
		if (type === "context.append_message") {
			const raw = asRecord(record.message);
			const message = kimiMessage(raw, counts, time);
			if (message === null) continue;
			// The fold's own deferral: a message that arrives while a tool result is
			// outstanding waits behind it, and the journal really does deliver them in
			// that order when a user types during a tool run.
			if (pending.size > 0) deferred.push(message);
			else push([message]);
			continue;
		}
		if (type === "context.append_loop_event") {
			const event = asRecord(record.event);
			const eventType = asText(event?.type);
			if (eventType === "step.begin") {
				closePending(time);
				const entry = assistantItem(assistantMessage({ timestamp: time }));
				openSteps.set(asText(event?.uuid), entry);
				push([entry]);
				continue;
			}
			if (eventType === "step.end") {
				const step = openSteps.get(asText(event?.uuid));
				openSteps.delete(asText(event?.uuid));
				// The step's own usage and how it ended ride on its end. The usage is what
				// keeps an imported turn from showing as free, and the reason is the only
				// place the source says whether the model stopped, ran out of context or was
				// cut off — the fold has no field for either, but a transcript that says
				// "still streaming" about a turn finished months ago is simply wrong.
				const usage = asRecord(event?.usage);
				if (step !== undefined && step.message.role === "assistant") {
					if (usage !== null) step.message.usage = stepUsage(usage);
					step.message.stopReason = stopReasonOf(asText(event?.finishReason), step.message.content);
				}
				flushDeferred();
				continue;
			}
			if (eventType === "content.part") {
				const stepUuid = asText(event?.stepUuid);
				const step = openSteps.get(stepUuid);
				if (step === undefined) {
					return { error: `journal does not replay: content.part for unopened step ${stepUuid || "(none)"}` };
				}
				const part = assistantPart(event?.part, counts);
				if (part === null) continue;
				if (step.message.role !== "assistant") continue;
				step.message.content.push(part);
				continue;
			}
			if (eventType === "tool.call") {
				const stepUuid = asText(event?.stepUuid);
				const step = openSteps.get(stepUuid);
				if (step === undefined) {
					return { error: `journal does not replay: tool.call for unopened step ${stepUuid || "(none)"}` };
				}
				const id = asText(event?.toolCallId);
				if (!id || step.message.role !== "assistant") {
					bump(counts, "tool call with no id");
					continue;
				}
				const name = asText(event?.name) || UNKNOWN_TOOL_NAME;
				step.message.content.push({
					type: "toolCall",
					id,
					name,
					arguments: JSON.stringify(parseArguments(toolCallArguments(event?.args))),
				});
				pending.set(id, { id, name });
				continue;
			}
			if (eventType === "tool.result") {
				const id = asText(event?.toolCallId);
				if (!pending.has(id)) {
					// The fold returns without a word here: a result the journal cannot pair
					// is not part of the context. The count is this reader's own, and it is
					// what keeps such a line from vanishing without a trace.
					bump(counts, "tool result with no open call");
					continue;
				}
				const call = pending.get(id);
				pending.delete(id);
				const result = asRecord(event?.result);
				push([
					resultItem(
						toolResultMessage(
							id,
							call?.name || UNKNOWN_TOOL_NAME,
							toolOutputContent(result?.output, counts),
							result?.isError === true,
							time,
						),
					),
				]);
				flushDeferred();
				continue;
			}
			// `step.begin`'s siblings are all bookkeeping (`step.end`, `tool.call`,
			// `tool.result` and `content.part` are handled above); a loop event this
			// build does not know is counted rather than guessed at.
			bump(counts, "unknown loop event");
			continue;
		}
		if (type === "context.apply_compaction") {
			const summary = summaryText(record);
			if (!summary) {
				bump(counts, "compaction with no summary");
				continue;
			}
			const compacted = asNumber(record.compactedCount) ?? asNumber(record.count) ?? 0;
			const kept = asNumber(record.keptUserMessageCount);
			const legacyTail = kept === undefined;
			// The fold's replacement, verbatim: the old shape kept `history.slice(n)`
			// beside the summary, the current one keeps only the summary (the user
			// messages it "keeps" are re-selected from the old history by token budget,
			// which is a computation this reader does not reimplement — the count of
			// them is reported instead).
			const tail = legacyTail && compacted < history.length ? history.slice(compacted) : [];
			// The boundary goes where the journal wrote it: on the `full_compaction.begin`
			// record when there is one — the fold binds the summary to that record, and a
			// message appended in between stays after the boundary, exactly as it does in
			// the replay — and at the end of what has been appended when there is not.
			const open = openCompaction(stream);
			const tokensBefore = asNumber(record.tokensBefore) ?? 0;
			// ...unless the old shape kept a tail, in which case the context the fold
			// rebuilds is `[summary, ...tail]` and the boundary has to sit *before* that
			// tail: a boundary after it would resume the session without the messages the
			// source deliberately kept. The tail starts earlier in the journal than the
			// compaction's own records do, so this position wins over the placeholder.
			const firstKept = tail[0]?.stream;
			const anchor = firstKept === undefined ? -1 : stream.indexOf(firstKept);
			if (anchor !== -1) {
				if (open !== undefined) stream.splice(stream.indexOf(open), 1);
				stream.splice(anchor, 0, { kind: "compaction", summary, preTokens: tokensBefore, open: false });
			} else if (open?.kind === "compaction") {
				open.summary = summary;
				open.preTokens = tokensBefore;
				open.open = false;
			} else {
				stream.push({ kind: "compaction", summary, preTokens: tokensBefore, open: false });
			}
			if (legacyTail && tail.length > 0)
				bump(counts, "messages kept beside a summary (old compaction shape)", tail.length);
			else if (typeof kept === "number" && kept > 0) {
				counts.set("user messages the summary stands in for; only the summary is imported", kept);
			}
			history.length = 0;
			history.push(summaryItem(summary, time), ...tail);
			sealOpenSteps();
			pending.clear();
			deferred = [];
			continue;
		}
		if (type === "context.undo") {
			const count = asNumber(record.count) ?? 0;
			if (count <= 0 || history.length === 0) continue;
			const removed = new Set<KimiMessage>();
			let removedUserInputs = 0;
			for (let i = history.length - 1; i >= 0; i--) {
				const entry = history[i];
				if (!entry) break;
				// A rewind never reaches past the summary the context now starts from. The
				// fold also skips over injections here; none can be in this history, because
				// this reader does not import them in the first place.
				if (entry.origin === "compaction_summary") break;
				removed.add(entry);
				history.splice(i, 1);
				if (entry.realUserInput) {
					removedUserInputs += 1;
					if (removedUserInputs >= count) break;
				}
			}
			for (const entry of removed) {
				const item = entry.stream;
				if (item === undefined) continue;
				const at = stream.indexOf(item);
				if (at !== -1) stream.splice(at, 1);
			}
			sealOpenSteps();
			pending.clear();
			deferred = [];
			continue;
		}
		if (type === "context.clear") {
			// The context is emptied and the journal is not: a cleared session still
			// imports with everything that was said, which is exactly the audit trail the
			// target keeps for its own compactions.
			history.length = 0;
			sealOpenSteps();
			pending.clear();
			deferred = [];
			continue;
		}
		if (type === "full_compaction.begin") {
			// A placeholder until the summary arrives; a compaction that never completes
			// leaves nothing behind but a count.
			stream.push({ kind: "compaction", summary: "", preTokens: 0, open: true });
			continue;
		}
		if (type === "full_compaction.cancel") {
			const item = openCompaction(stream);
			if (item !== undefined) stream.splice(stream.indexOf(item), 1);
			bump(counts, "compaction that was cancelled");
			continue;
		}
		if (type === "full_compaction.complete") continue;
		// Everything else — prompts, model requests, usage, goals, permissions, the
		// tool store, agent and workspace bookkeeping — is not conversation. None of
		// it can add, remove or rewrite a message, so none of it is counted as a loss:
		// counting every record of a long session would bury the real skips.
	}

	closePending(lastTime);
	flushDeferred();
	// A step the journal never ended is a turn the process did not finish; it is
	// sealed from what it holds rather than left looking like it is still running.
	sealOpenSteps();
	// A compaction that began and never reported a summary is not a boundary: it
	// replaced nothing the model saw.
	const finished = stream.filter((item) => item.kind !== "compaction" || !item.open);
	const abandoned = stream.length - finished.length;
	if (abandoned > 0) bump(counts, "compaction that never completed", abandoned);

	// A step the journal opened and never filled — the process died mid-turn — is an
	// assistant message with nothing in it, and the target cannot hold one. It is
	// dropped here rather than in the repair pass, which would drop it as an unpaired
	// tool call: a different fact, and a wrong note to hand the user.
	const carried = finished.filter(
		(item) =>
			item.kind !== "message" || item.entry.message.role !== "assistant" || item.entry.message.content.length > 0,
	);
	const unfilled = finished.length - carried.length;
	if (unfilled > 0) bump(counts, "assistant turn the journal opened but never filled", unfilled);

	const messages = carried.filter((item) => item.kind === "message").map((item) => item.entry.message);
	fillToolNames(messages);
	// The repair's own output is what goes in: a call whose result never came — and the
	// result whose call never did — is a pair the provider would reject on the next
	// request, which imports as a session that lists but cannot be resumed.
	const repaired = repairToolPairing(messages);
	bump(counts, "unpaired tool call or result", repaired.dropped);

	// Boundaries keep their place among the messages: each is carried as the number
	// of messages that came before it, and the messages are laid out in one pass so
	// that index is exact. If the repair pass dropped anything, every boundary moves
	// to the end instead of landing mid-transcript — a boundary whose suffix no
	// longer exists would be worse than a late one, and that is the same trade the
	// ZCode and dsh readers make.
	//
	// Two boundaries can share a position: a compaction's records land where the
	// records of one before it already stand, because a rewind between them removed
	// every message that would have separated them. They are inserted in the order
	// the journal wrote them — each position carrying the count of messages before
	// it, plus the boundaries already placed — so the newest is the last, which is
	// the one a resumed session starts from: the target reads its context from the
	// final boundary onward, and the newest summary is the one that stands for
	// everything the older ones described.
	const entries: KimiEntry[] = repaired.messages.map((message) => ({ kind: "message", message }));
	const markers: Array<{ after: number; entry: KimiEntry }> = [];
	let seen = 0;
	for (const item of carried) {
		if (item.kind === "message") {
			seen += 1;
			continue;
		}
		markers.push({
			after: seen,
			entry: { kind: "compaction", summary: item.summary, preTokens: item.preTokens },
		});
	}
	if (markers.length > 0) {
		if (repaired.dropped === 0) {
			markers.sort((a, b) => a.after - b.after);
			for (const [placed, marker] of markers.entries()) {
				entries.splice(marker.after + placed, 0, marker.entry);
			}
		} else {
			entries.push(...markers.map((marker) => marker.entry));
		}
	}

	if (entries.length > 0 && session.forkedFrom !== "") {
		// The inherited prefix cannot be told apart from the turns the user typed: a
		// fork copies the parent's records into its own journal, ids and all. So the
		// whole session is imported and the report says whose words are in it.
		counts.set(`forked from session ${session.forkedFrom}: its inherited prefix is imported whole`, 1);
	}
	return { entries, notes: toNotes(counts) };
}

/** The fold's stand-in for a tool result the journal never recorded. */
const INTERRUPTED_OUTPUT = "No result was recorded for this tool call: the source session ended while it was running.";

/**
 * The compaction a summary is still waiting for: the `full_compaction.begin`
 * placeholder a later `context.apply_compaction` fills in.
 *
 * The fold patches only the *last* record of its replay and gives up when a
 * message was appended between the two records, which loses the summary from its
 * replay (the context keeps it). Searching back for the open placeholder instead
 * binds the summary to the record that opened it, which is the placement the
 * fold's own patch is trying to achieve.
 */
function openCompaction(stream: KimiStreamItem[]): KimiStreamItem | undefined {
	for (let i = stream.length - 1; i >= 0; i--) {
		const item = stream[i];
		if (item?.kind === "compaction" && item.open) return item;
	}
	return undefined;
}

/**
 * A `ContextMessage` as a labunbun message, or null when nothing can carry it.
 *
 * The origins the tool itself calls "real user input" are the ones imported:
 * what the user typed, and the two slash-command activations that were typed at
 * the prompt. Everything else the harness appends to its own context — injected
 * reminders, shell lines, task notifications, cron and hook output, system
 * triggers, the summary the context starts from — is a message the target
 * renders for itself on resume, and importing the source's copy would send two
 * of them. Those are counted by what they were, so the report says what happened
 * to the user's `!` commands rather than pretending they were never there.
 */
function kimiMessage(
	raw: Record<string, unknown> | null,
	counts: Map<string, number>,
	time: number,
): KimiMessage | null {
	const role = asText(raw?.role);
	const origin = asRecord(raw?.origin);
	const kind = asText(origin?.kind) || (typeof raw?.origin === "string" ? asText(raw.origin) : "");
	const trigger = asText(origin?.trigger);
	const parts = Array.isArray(raw?.content) ? raw.content : [];

	if (role === "user") {
		if (kind === "injection") {
			bump(counts, "injected reminder (the target writes its own)");
			return null;
		}
		if (kind === "shell_command") {
			bump(counts, "`!` command");
			return null;
		}
		if (kind !== "" && kind !== "user" && kind !== "skill_activation" && kind !== "plugin_command") {
			bump(counts, `message the harness appended (${kind})`);
			return null;
		}
		const content = userContent(parts, counts);
		if (typeof content === "string" && content === "") {
			bump(counts, "empty user message");
			return null;
		}
		return messageItem(userMessage(content, time), kind, trigger, true);
	}
	if (role === "assistant") {
		const content = assistantContent(parts, counts, raw?.toolCalls);
		if (content.length === 0) {
			bump(counts, "empty assistant message");
			return null;
		}
		return messageItem(
			assistantMessage({
				content,
				stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
				timestamp: time,
			}),
			kind,
			trigger,
			false,
		);
	}
	if (role === "tool") {
		const id = asText(raw?.toolCallId);
		if (!id) {
			bump(counts, "tool message with no call id");
			return null;
		}
		return resultItem(
			toolResultMessage(id, UNKNOWN_TOOL_NAME, toolOutputContent(raw?.content, counts), raw?.isError === true, time),
		);
	}
	if (role === "system") {
		bump(counts, "system message (the target writes its own)");
		return null;
	}
	bump(counts, "message with no role");
	return null;
}

/** A message the fold holds, with the flags its rules need. */
function messageItem(message: AgentMessage, origin: string, trigger: string, realUserInput: boolean): KimiMessage {
	return { message, origin, trigger, realUserInput: realUserInput && isRealUserInput(origin, trigger) };
}

/** A tool result, which the fold's `undo` never removes on its own. */
function resultItem(message: AgentMessage): KimiMessage {
	return { message, origin: "", trigger: "", realUserInput: false };
}

/** The assistant message a `step.begin` opens, before any part arrives. */
function assistantItem(message: AgentMessage): KimiMessage {
	return { message, origin: "", trigger: "", realUserInput: false };
}

/** The summary message the context starts from after a compaction. */
function summaryItem(summary: string, time: number): KimiMessage {
	return {
		message: userMessage(summary, time),
		origin: "compaction_summary",
		trigger: "",
		realUserInput: false,
	};
}

/**
 * `isRealUserInput`, the tool's own predicate: what an `undo` counts.
 *
 * An origin the journal did not state counts — an old record omits it, and a
 * message the user typed is more likely than one the harness appended by
 * accident. A slash-command activation counts only when the trigger says the
 * user typed it (`user-slash`); a model-invoked skill is the model's own step.
 */
function isRealUserInput(origin: string, trigger: string): boolean {
	if (origin === "" || origin === "user") return true;
	if (origin === "skill_activation" || origin === "plugin_command") return trigger === "user-slash";
	return false;
}

/** One `content.part` of an assistant turn, or null when it cannot be carried. */
function assistantPart(part: unknown, counts: Map<string, number>): AssistantContent | null {
	const block = asRecord(part);
	const type = asText(block?.type);
	if (type === "text") {
		const text = asText(block?.text);
		return text ? textContent(text) : null;
	}
	if (type === "think") {
		const thinking = asText(block?.think);
		if (thinking) return { type: "thinking", thinking } satisfies ThinkingContent;
		// An encrypted-only reasoning part is counted, not carried as a signature:
		// the blob is the source model's, and the provider a resumed session talks to
		// is in no position to verify it. A part with neither text nor a blob says
		// nothing at all, and is not worth a line in the report.
		if (asText(block?.encrypted)) bump(counts, "reasoning block that carried no text");
		return null;
	}
	if (type === "image_url") {
		// A part the assistant produced is content the target cannot re-request, and
		// a URL is not an image until it is fetched. Counted, not fetched.
		bump(counts, "image the assistant referenced by URL");
		return null;
	}
	bump(counts, `message part this build does not carry (${type || "unknown"})`);
	return null;
}

/** The parts of an assistant message appended as context, with its calls. */
function assistantContent(
	parts: readonly unknown[],
	counts: Map<string, number>,
	toolCalls: unknown,
): AssistantContent[] {
	const content: AssistantContent[] = [];
	for (const part of parts) {
		const mapped = assistantPart(part, counts);
		if (mapped !== null) content.push(mapped);
	}
	for (const raw of Array.isArray(toolCalls) ? toolCalls : []) {
		const call = toolCall(raw);
		if (call === null) {
			bump(counts, "tool call with no id");
			continue;
		}
		content.push(call);
	}
	return content;
}

/**
 * A tool call of an appended message, in either spelling the journal has used.
 *
 * Version 1.0 wrote `{function: {name, arguments}}` and the tool migrates those
 * records forward on read (`wire/migration/v1.1.ts`); reading both spellings
 * here means a journal from before the migration imports without the reader
 * having to know which release wrote it.
 */
function toolCall(raw: unknown): ToolCall | null {
	const block = asRecord(raw);
	if (block === null) return null;
	const id = asText(block.id);
	if (!id) return null;
	const fn = asRecord(block.function);
	const name = asText(block.name) || asText(fn?.name) || UNKNOWN_TOOL_NAME;
	const args = block.arguments ?? fn?.arguments;
	return { type: "toolCall", id, name, arguments: JSON.stringify(parseArguments(toolCallArguments(args))) };
}

/**
 * A call's arguments as text to be parsed.
 *
 * The journal writes `args` as the tool input object and version 1.0 wrote the
 * model's raw string, so both are accepted; anything else is JSON-encoded the
 * way the fold does it (`JSON.stringify(event.args)`) before the shared
 * normaliser turns it into an object.
 */
function toolCallArguments(args: unknown): string {
	if (args === undefined || args === null) return "";
	if (typeof args === "string") return args;
	return JSON.stringify(args);
}

/** A user message's content: the text as it stands, plus any image that travels. */
function userContent(parts: readonly unknown[], counts: Map<string, number>): string | UserContent[] {
	const texts: string[] = [];
	const content: UserContent[] = [];
	for (const part of parts) {
		const block = asRecord(part);
		const type = asText(block?.type);
		if (type === "text") {
			const text = asText(block?.text);
			if (text) texts.push(text);
			continue;
		}
		const image = imageContent(block, counts);
		if (image !== null) content.push(image);
	}
	if (content.length === 0) return texts.join("\n");
	return [...texts.map((text) => textContent(text)), ...content];
}

/** A tool result's content: its text, and any image the tool returned. */
function toolOutputContent(output: unknown, counts: Map<string, number>): ToolResultContent[] {
	if (typeof output === "string") return resultContent(output);
	const content: ToolResultContent[] = [];
	for (const part of Array.isArray(output) ? output : []) {
		const block = asRecord(part);
		if (asText(block?.type) === "text") {
			const text = asText(block?.text);
			if (text) content.push(textContent(text));
			continue;
		}
		const image = imageContent(block, counts);
		if (image !== null) content.push(image);
	}
	return content.length > 0 ? content : resultContent("");
}

/** An image part, when it carries its bytes rather than a place to fetch them. */
function imageContent(block: Record<string, unknown> | null, counts: Map<string, number>): ImageContent | null {
	const type = asText(block?.type);
	if (type !== "image_url") {
		if (type !== "" && type !== "text") bump(counts, `message part this build does not carry (${type})`);
		return null;
	}
	const url = asText(asRecord(block?.imageUrl)?.url);
	// `data:<mime>;base64,<bytes>` is the only form that is an image already; a URL
	// would have to be fetched, and a transcript is not the place to start doing
	// network I/O on the user's behalf.
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
	if (match === null) {
		bump(counts, "image referenced by URL");
		return null;
	}
	return { type: "image", mimeType: match[1] ?? "", data: match[2] ?? "" };
}

/** The summary text a `context.apply_compaction` carries, in any of its shapes. */
function summaryText(record: Record<string, unknown>): string {
	// `contextSummary` is what the context starts from when both are present
	// (`contextSummary ?? summary`); the raw summary is the model's own output and
	// can carry the summarizing prompt's framing with it.
	const contextSummary = asText(record.contextSummary);
	if (contextSummary) return contextSummary;
	const summary = record.summary;
	if (typeof summary === "string") return summary;
	const content = asRecord(summary)?.content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (asText(asRecord(part)?.type) === "text" ? asText(asRecord(part)?.text) : "")).join("");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Stand-in for a tool name the source did not record; replaced when a call names it. */
const UNKNOWN_TOOL_NAME = "unknown";

/**
 * Fill in a tool result's tool name from the call it answers, in place: the
 * journal records the name on the call, and a result that renders unnamed is a
 * result the user cannot recognise.
 *
 * In place rather than as a new array, because the messages are already held by
 * the transcript's entries and rebuilding the array would leave the imported
 * entries pointing at the unnamed originals.
 */
function fillToolNames(messages: AgentMessage[]): void {
	const names = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") names.set(block.id, block.name);
	}
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== UNKNOWN_TOOL_NAME) continue;
		const name = names.get(message.toolCallId);
		if (name) message.toolName = name;
	}
}

/**
 * How a step ended, in the target's vocabulary.
 *
 * The values are the source's own, normalized by its loop before they reach the
 * journal (`normalizeFinishReason`): `tool_calls` becomes `tool_use`,
 * `completed` becomes `end_turn` and `truncated` becomes `max_tokens`.
 *
 * `filtered` is a provider's safety filter cutting the answer off, which is the
 * target's `refusal` — a deliberate stop rather than a failure of the request,
 * and one the user has to be able to see. A step with no reason at all (an older
 * journal, or one cut off before its `step.end`) is read from its content, the
 * way the readers of the sources that record no reason do.
 */
function stopReasonOf(reason: string, content: AssistantContent[]): StopReason {
	if (reason === "tool_use") return "toolUse";
	if (reason === "end_turn") return "stop";
	if (reason === "max_tokens") return "length";
	if (reason === "interrupted") return "aborted";
	if (reason === "error") return "error";
	if (reason === "filtered") return "refusal";
	return content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
}

/** A tool result's content must be non-empty, or the first `--continue` fails. */
function resultContent(text: string): ToolResultContent[] {
	return [textContent(text || "(no output recorded)")];
}

/** Convert `arguments` text into a value that can be re-encoded as a JSON object. */
function parseArguments(raw: string): unknown {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	try {
		const parsed = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : { input: parsed };
	} catch {
		return { input: raw };
	}
}

/**
 * The usage a `step.end` recorded, in the target's four buckets.
 *
 * Kimi splits input into the cached and uncached halves (`inputOther` excludes
 * both cache readings), which is how the target counts them too; the fields are
 * the same four numbers under different names.
 */
function stepUsage(usage: Record<string, unknown> | null): Usage {
	return {
		input: asNumber(usage?.inputOther) ?? 0,
		output: asNumber(usage?.output) ?? 0,
		cacheRead: asNumber(usage?.inputCacheRead) ?? 0,
		cacheWrite: asNumber(usage?.inputCacheCreation) ?? 0,
	};
}

/** True for a protocol version this reader cannot know the shape of. */
function isNewerProtocol(version: string): boolean {
	const parts = version.split(".").map((part) => Number.parseInt(part, 10));
	const known = KNOWN_WIRE_PROTOCOL.split(".").map((part) => Number.parseInt(part, 10));
	for (let i = 0; i < Math.max(parts.length, known.length); i++) {
		const read = Number.isFinite(parts[i]) ? (parts[i] ?? 0) : 0;
		const ours = known[i] ?? 0;
		if (read !== ours) return read > ours;
	}
	return false;
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function parseJsonLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		return asRecord(JSON.parse(trimmed));
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** Epoch ms from a stamp the journal wrote either way, 0 when unreadable. */
function epochMs(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function firstText(value: string, max = 60): string {
	const single = value.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Count one skip reason; the notes come out in first-seen order. */
function bump(counts: Map<string, number>, reason: string, by = 1): void {
	if (by <= 0) return;
	counts.set(reason, (counts.get(reason) ?? 0) + by);
}

function toNotes(counts: Map<string, number>): Array<{ reason: string; count: number }> {
	return [...counts].map(([reason, count]) => ({ reason, count }));
}
