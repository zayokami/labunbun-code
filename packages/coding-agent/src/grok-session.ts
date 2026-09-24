/**
 * Grok Build session transcripts (`$GROK_HOME/sessions`).
 *
 * Grok keeps one append-only `updates.jsonl` per session and a `summary.json`
 * beside it. The transcript read here is the updates file, not the
 * `chat_history.jsonl` next to it: grok rebuilds the latter from the former
 * (`storage/mod.rs`, `chat_rebuild`), so reading the cache would freeze one
 * derivation of a conversation the tool itself treats as derived — and would
 * read a file that a session still running has not refreshed.
 *
 * Every line is one ACP notification in an envelope —
 * `{timestamp, method, params}` — and the tag that says what the line *is* lives
 * at `params.update.sessionUpdate`. Two shapes in the same file are not variants
 * of that one:
 *
 *   - a line with no `method` is a legacy update written bare
 *     (`{sessionId, update}`), which grok's own `SessionUpdateEnvelope::from_str`
 *     accepts. A reader that insisted on the envelope would drop those lines in
 *     silence and report the session as empty.
 *   - the user-visible prompt is not always the wire text. A text block's
 *     `displayText` is what the user typed when the wire text expands it (a slash
 *     skill, a mid-turn interjection), and an interjection's wire text is a
 *     model-facing envelope wrapped around the typed words.
 *
 * The lines are read in three passes, each of which is grok's own:
 *
 *   1. classify — the timeline roles `rewind_step_for_line` works in: a user
 *      chunk opens or continues a prompt run, a rewind marker truncates, and
 *      everything else ends the run.
 *   2. filter — `filter_rewind_by`'s semantics. A rewind to prompt N drops the
 *      Nth *counted* run and everything after it, because the turn went back into
 *      the composer: it was never asked in the conversation the file now
 *      describes. Counting is progressive (every unmarked run counts until the
 *      first `promptIndex`, only marked ones after), which is what makes a
 *      mid-turn phantom text not a turn.
 *   3. assemble — the surviving chunks become messages with the boundaries
 *      `ChatReducer` draws: consecutive chunks of one role concatenate with
 *      nothing between them (they are streaming deltas), an interjection is a
 *      message of its own, and a completed tool frame closes the assistant text
 *      before it.
 *
 * Tool calls, reasoning and the session's own events are counted and left behind
 * rather than reconstructed: rebuilding them the way grok does means running
 * `ChatReducer` — accumulating `tool_args` across updates, emitting a result only
 * on completion — and half of that machine would be worse than none of it.
 *
 * Nothing here writes, and nothing outside the session tree is opened. The
 * credentials in the same home stay shut, and a session directory holds
 * transcripts, summaries and rendered compaction segments, which is all this
 * module reads.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentMessage, assistantMessage, repairToolPairing, textContent, userMessage } from "@labunbun/ai";
import { decodeGrokCwdDir, grokSessions } from "./grok-home.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One session worth offering: `summary.json` read, transcript located. */
export interface GrokSessionFile {
	/** The directory's name, which is the id grok uses. */
	sessionId: string;
	/** The session directory — the compaction segments are read from it. */
	dir: string;
	/** `<dir>/updates.jsonl`, the transcript. */
	path: string;
	/** `summary.info.cwd`, or the directory name decoded when the summary has none. */
	cwd: string;
	/** `summary.created_at` (epoch ms), 0 when it states nothing readable. */
	startedAt: number;
	/** `generated_title` when it says something, else `session_summary`. */
	title: string;
	/** `session_kind`, "" when the summary states none. */
	kind: string;
	/** `parent_session_id` for a fork, "" otherwise. */
	parentSessionId: string;
}

export interface GrokListing {
	sessions: GrokSessionFile[];
	notes: Array<{ reason: string; count: number }>;
}

export type GrokEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface GrokRead {
	entries: GrokEntry[];
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Every session grok's own history would show.
 *
 * The two skips are the panel's, not this module's invention:
 * `Summary::is_hidden` is `hidden.unwrap_or(kind.starts_with("subagent"))` — so a
 * summary that says `hidden: false` about a subagent session is *shown*, and
 * reading the rule as "kind starts with subagent" would hide a session the user
 * can see in grok — and `Summary::is_unused_optimistic_husk` is a session with
 * no messages, no title and no fork provenance. A husk has nothing to import,
 * so importing one could only produce the "nothing to import" count under a
 * reason that does not say why.
 *
 * A session directory without `updates.jsonl` is skipped too. grok creates the
 * directory before the first turn, so this is an ordinary state rather than a
 * damaged one, and "no transcript" is a different fact from "nothing said".
 */
export function listGrokSessions(root: string): GrokListing {
	const sessions: GrokSessionFile[] = [];
	const counts = new Map<string, number>();
	for (const found of grokSessions(root)) {
		const summary = readSummary(found.summaryPath);
		if (summary === null) {
			bump(counts, "summary.json that could not be read");
			continue;
		}
		if (summary.hidden) {
			bump(counts, "hidden session");
			continue;
		}
		if (summary.husk) {
			bump(counts, "session with no title and no messages");
			continue;
		}
		if (!existsSync(found.updatesPath)) {
			bump(counts, "session with no transcript");
			continue;
		}
		sessions.push({
			sessionId: found.id,
			dir: found.dir,
			path: found.updatesPath,
			cwd: summary.cwd || decodeGrokCwdDir(found.cwdDir) || "",
			startedAt: summary.startedAt,
			title: firstText(summary.title),
			kind: summary.kind,
			parentSessionId: summary.parentSessionId,
		});
	}
	return { sessions, notes: toNotes(counts) };
}

/** What the listing needs out of a `summary.json`, already resolved. */
interface GrokSummary {
	cwd: string;
	startedAt: number;
	title: string;
	kind: string;
	parentSessionId: string;
	/** `is_hidden()` — the panel's rule, including the explicit `hidden: false` override. */
	hidden: boolean;
	/** `is_unused_optimistic_husk()` — nothing said, nothing titled, nothing inherited. */
	husk: boolean;
}

function readSummary(path: string): GrokSummary | null {
	const parsed = parseJsonLine(readTextOrNull(path) ?? "");
	if (parsed === null) return null;
	const info = asRecord(parsed.info);
	const kind = asText(parsed.session_kind);
	const parentSessionId = asText(parsed.parent_session_id);
	const generated = asText(parsed.generated_title).trim();
	const title = generated !== "" ? generated : asText(parsed.session_summary);
	// The fork fields are the exemption `is_unused_optimistic_husk` states: a
	// fork has provenance even when it has said nothing yet, and worktree forks
	// keep kind `worktree`, which is why `forked_at` is checked too.
	const inherited = kind === "fork" || parentSessionId !== "" || parsed.forked_at !== undefined;
	const numMessages = typeof parsed.num_messages === "number" ? parsed.num_messages : 0;
	return {
		cwd: asText(info?.cwd),
		startedAt: epochMs(parsed.created_at),
		title,
		kind,
		parentSessionId,
		hidden: typeof parsed.hidden === "boolean" ? parsed.hidden : kind.startsWith("subagent"),
		husk: !inherited && numMessages === 0 && title.trim() === "",
	};
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/** The `method` that marks a line as an xAI extension rather than plain ACP. */
const XAI_SESSION_UPDATE_METHOD = "_x.ai/session/update";

/**
 * What one line puts into the transcript, or why it puts nothing in.
 *
 * `step` and `carry` are separate because they answer different questions: the
 * rewind algebra classifies a line by its tag alone, while the transcript only
 * keeps some of what survived. A user chunk whose content is an image is a
 * prompt run to the algebra (`step: "user"`) and nothing to write down.
 */
interface GrokLine {
	step: "user" | "rewind" | "other";
	carry: GrokCarry;
	/** The marked run's `promptIndex`, null for an unmarked run or a non-user line. */
	promptIndex: number | null;
	/** The line's timestamp (epoch ms), inherited from the line before when it states none. */
	timestamp: number;
}

type GrokCarry =
	| { kind: "prompt"; text: string; interjection: boolean }
	| { kind: "agent"; text: string }
	| { kind: "rewind"; target: number }
	| { kind: "skip"; reason: string; closesAssistant: boolean };

/** A line as read, before the timestamp it inherits is filled in. */
interface ParsedLine {
	step: GrokLine["step"];
	carry: GrokCarry;
	promptIndex: number | null;
	/** The envelope's own timestamp, null when it states none (the legacy shape never does). */
	timestamp: number | null;
}

/**
 * Read one line of `updates.jsonl`, or `null` when there is nothing to read.
 *
 * The order of the checks is grok's own classifier's: the rewind tag is only
 * honoured on an xAI line, a user chunk only on an ACP one and only when it is
 * not a host turn, and anything else — a tool call, a thought, a session event,
 * a line that is not JSON at all — is `Other`. A marker whose target is missing
 * or not a whole number is `Other` there (the field is an `Option<usize>`, so a
 * negative one fails the parse), and it is `Other` here too: the difference is
 * that this reader counts it, because a marker that truncates nothing is worth
 * a line in the report.
 */
function parseLine(line: string): ParsedLine | null {
	if (line.trim() === "") return null;
	const envelope = parseJsonLine(line);
	if (envelope === null) return other({ kind: "skip", reason: "malformed line", closesAssistant: false }, null, null);
	// `params` absent means the line itself was the notification: that is the
	// legacy shape, and it is also what grok falls back to when an envelope has no
	// `params`, so both are read the same way here.
	const params = envelope.params === undefined ? envelope : asRecord(envelope.params);
	const update = params === null ? null : asRecord(params.update);
	const tag = update === null ? "" : asText(update.sessionUpdate);
	if (update === null || tag === "") {
		return other({ kind: "skip", reason: "line with no session update", closesAssistant: false }, null, null);
	}
	const timestamp = envelopeTimestamp(envelope);
	const isXai = envelope.method === XAI_SESSION_UPDATE_METHOD;

	if (isXai && tag === "rewind_marker") {
		const target = update.target_prompt_index;
		if (typeof target === "number" && Number.isInteger(target) && target >= 0) {
			return { step: "rewind", carry: { kind: "rewind", target }, promptIndex: null, timestamp };
		}
		return other(
			{ kind: "skip", reason: "rewind marker with no prompt index", closesAssistant: false },
			null,
			timestamp,
		);
	}

	// The chunk's own meta — `update._meta`, a sibling of `content` — carries the
	// run's `promptIndex`, the host-turn flag and the interjection flag. The text
	// block's meta is a different map one level down.
	const meta = asRecord(update._meta);
	const hostTurn = meta?.hostTurn === true;

	if (hostTurn) {
		// A host-injected turn is conversation-shaped and model-facing only: it is
		// what grok sends itself between turns, and it ends both runs it lands
		// between the way `flush_host_turn_boundary` does.
		return other({ kind: "skip", reason: "host-injected turn", closesAssistant: true }, null, timestamp);
	}

	if (!isXai && tag === "user_message_chunk") {
		const promptIndex = typeof meta?.promptIndex === "number" ? meta.promptIndex : null;
		const content = asRecord(update.content);
		const blockMeta = asRecord(content?._meta);
		// A `!` command is typed at grok's prompt but never asked of the model, and
		// its block meta says so (`extensions/prompt_meta.rs`); it is skipped
		// without ending a run, because the reducer does not see it as a turn.
		if (typeof blockMeta?.bash_command === "string") {
			return {
				step: "user",
				carry: { kind: "skip", reason: "`!` command", closesAssistant: false },
				promptIndex,
				timestamp,
			};
		}
		if (asText(content?.type) !== "text") {
			return {
				step: "user",
				carry: { kind: "skip", reason: "user message with no text", closesAssistant: false },
				promptIndex,
				timestamp,
			};
		}
		const text = userPromptText(asText(content?.text), blockMeta);
		if (text.trim() === "") {
			return {
				step: "user",
				carry: { kind: "skip", reason: "empty prompt", closesAssistant: false },
				promptIndex,
				timestamp,
			};
		}
		return {
			step: "user",
			carry: { kind: "prompt", text, interjection: meta?.interjection === true },
			promptIndex,
			timestamp,
		};
	}

	if (tag === "agent_message_chunk") {
		const content = asRecord(update.content);
		const text = asText(content?.text);
		if (text === "") {
			return other({ kind: "skip", reason: "empty assistant chunk", closesAssistant: false }, null, timestamp);
		}
		return { step: "other", carry: { kind: "agent", text }, promptIndex: null, timestamp };
	}

	return other(
		{ kind: "skip", reason: skipReasonFor(tag), closesAssistant: closedByTool(tag, update) },
		null,
		timestamp,
	);
}

/** A line that ends the current run and carries nothing. */
function other(carry: GrokCarry, promptIndex: number | null, timestamp: number | null): ParsedLine {
	return { step: "other", carry, promptIndex, timestamp };
}

/**
 * The text of a user chunk, as the user would recognise it.
 *
 * `displayText` wins when it says something: it is the compact form of what they
 * typed (`queue_text_from_blocks`), and an interjection's wire text is a
 * model-facing frame around it. `bash_command` is checked by the caller rather
 * than here because it decides whether the line is a prompt at all.
 */
function userPromptText(wire: string, blockMeta: Record<string, unknown> | null): string {
	const display = blockMeta?.displayText;
	if (typeof display === "string" && display.trim() !== "") return display.trim();
	return stripContextWrappers(wire);
}

/**
 * Remove grok's own `<fork-context>` / `<resume-context>` wrappers and the text
 * they carry, keeping what sits outside them — `strip_context_wrappers`' rule,
 * including the `trim_start` on the remainder, which is what keeps the real
 * prompt from arriving with the wrapper's newline in front of it.
 *
 * The sessions this reader imports are the user's own, so the wrappers are rare
 * here (they are injected by the subagent fork/resume path, whose sessions are
 * skipped); the rule is kept because a fork session's first turn can carry one,
 * and importing the parent's transcript inside a tag is not a prompt.
 */
function stripContextWrappers(text: string): string {
	let out = text;
	for (const tag of ["fork-context", "resume-context"]) {
		const open = `<${tag}>`;
		const close = `</${tag}>`;
		const start = out.indexOf(open);
		if (start === -1) continue;
		const inner = out.indexOf(close, start + open.length);
		if (inner === -1) continue;
		out = `${out.slice(0, start)}${out.slice(inner + close.length).trimStart()}`;
	}
	return out;
}

/**
 * The typed words inside an interjection's envelope.
 *
 * `format_interjection` is `note + "\n" + <user_query>…</user_query> + "\n" +
 * reminder`, and the persisted chunk keeps the whole frame because that is what
 * the model was sent. A chunk written with a `displayText` never reaches this
 * (the typed text is in the meta), so this is the fallback for one written
 * without — and when the tags are not both there, the text is returned as it
 * stands rather than guessed at.
 */
function unwrapInterjection(text: string): string {
	const open = "<user_query>";
	const close = "</user_query>";
	const start = text.indexOf(open);
	if (start === -1) return text;
	const end = text.indexOf(close, start + open.length);
	if (end === -1) return text;
	return text.slice(start + open.length, end).trim();
}

/**
 * Why a line that carries nothing is worth counting.
 *
 * The names are the ones the report prints, so they say what the line was rather
 * than which tag it wore: a reader of the report has not read grok's source.
 */
function skipReasonFor(tag: string): string {
	if (tag === "tool_call" || tag === "tool_call_update" || tag === "tool_result") return "tool call or result";
	if (tag === "agent_thought_chunk") return "reasoning block";
	if (tag === "compaction_checkpoint") return "compaction checkpoint";
	return "session event";
}

/** True for the one tool update that closes an assistant run before its result. */
function closedByTool(tag: string, update: Record<string, unknown>): boolean {
	if (tag !== "tool_call_update") return false;
	return update.status === "completed" || update.status === "failed";
}

/** Epoch ms from the envelope's seconds-since-epoch stamp, 0 when it states none. */
function envelopeTimestamp(envelope: Record<string, unknown>): number | null {
	const seconds = envelope.timestamp;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
	return epochMs(seconds);
}

/** Epoch ms from an RFC 3339 string or an epoch-seconds number, 0 when unreadable. */
function epochMs(value: unknown): number {
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// The rewind filter
// ---------------------------------------------------------------------------

/** The counting state `UserRunTurnTracker` keeps between lines. */
interface TurnTracker {
	seenMarker: boolean;
	inUser: boolean;
	currentRunPi: number | null;
}

/**
 * Keep only the lines a rewind left standing, by grok's own algorithm.
 *
 * A marker to prompt N truncates the survivors back to where the Nth *counted*
 * run opened, and the marker goes with the text it removed. That is not "drop
 * the target turn and the ones after it in the file": the run's opening chunk can
 * carry several chunks, unmarked runs before the first `promptIndex` all count,
 * and a target the file no longer holds truncates nothing at all — `unwrap_or`
 * on the index folds to the current length, which is how a marker for a turn that
 * predates a compaction keeps every survivor.
 */
function filterRewind(lines: GrokLine[]): { kept: GrokLine[]; removed: number } {
	// A file without markers is kept as it stands. grok skips the parse in that
	// case; the scan below is cheap either way, so this is only about the answer.
	if (!lines.some((line) => line.step === "rewind")) return { kept: lines, removed: 0 };
	const kept: GrokLine[] = [];
	/** Where each counted run opened, as an index into `kept`. */
	const promptStarts: number[] = [];
	const tracker: TurnTracker = { seenMarker: false, inUser: false, currentRunPi: null };
	for (const line of lines) {
		if (line.step === "rewind" && line.carry.kind === "rewind") {
			const target = line.carry.target;
			kept.length = target < promptStarts.length ? (promptStarts[target] ?? kept.length) : kept.length;
			if (target < promptStarts.length) promptStarts.length = target;
			tracker.inUser = false;
			tracker.currentRunPi = null;
			continue;
		}
		if (line.step === "user") {
			if (opensCountedTurn(tracker, line.promptIndex)) promptStarts.push(kept.length);
		} else {
			tracker.inUser = false;
			tracker.currentRunPi = null;
		}
		kept.push(line);
	}
	return { kept, removed: carried(lines) - carried(kept) };
}

/** How many things in a line list were the transcript's, not the filter's bookkeeping. */
function carried(lines: GrokLine[]): number {
	return lines.reduce(
		(total, line) => total + (line.carry.kind === "prompt" || line.carry.kind === "agent" ? 1 : 0),
		0,
	);
}

/** grok's `UserRunTurnTracker::on_user_chunk`: true when this chunk opens a counted turn. */
function opensCountedTurn(tracker: TurnTracker, promptIndex: number | null): boolean {
	if (promptIndex !== null) tracker.seenMarker = true;
	const counted = tracker.seenMarker ? promptIndex !== null : true;
	const newRun =
		!tracker.inUser || ((tracker.seenMarker || promptIndex !== null) && promptIndex !== tracker.currentRunPi);
	if (newRun) {
		tracker.currentRunPi = promptIndex;
		tracker.inUser = true;
		return counted;
	}
	tracker.inUser = true;
	return false;
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/**
 * Read one session end to end.
 *
 * Returns `{ error }` only for a transcript that cannot be opened: every other
 * surprise inside the file is a line this reader counts and leaves behind, which
 * is what keeps one unknown update from costing the user a whole conversation.
 */
export function readGrokSession(session: GrokSessionFile): GrokRead | { error: string } {
	const text = readTextOrNull(session.path);
	if (text === null) return { error: "session transcript could not be read" };

	const counts = new Map<string, number>();
	let stamp = session.startedAt;
	const lines: GrokLine[] = [];
	for (const raw of text.split("\n")) {
		const parsed = parseLine(raw);
		if (parsed === null) continue;
		// A line without a stamp inherits the last one, which is what grok's own
		// readers do with a session's fields: the file is in order, and a jump back
		// to the session's start would reorder the messages it feeds.
		stamp = parsed.timestamp ?? stamp;
		lines.push({ step: parsed.step, carry: parsed.carry, promptIndex: parsed.promptIndex, timestamp: stamp });
	}
	const { kept, removed } = filterRewind(lines);
	if (removed > 0) bump(counts, "dropped by a rewind marker", removed);

	const messages = assemble(kept, counts);
	const repaired = repairToolPairing(messages);
	bump(counts, "unpaired tool call or result", repaired.dropped);

	const entries: GrokEntry[] = [...readSegments(session.dir)];
	for (const message of repaired.messages) entries.push({ kind: "message", message });
	if (entries.length === 0) return { entries, notes: toNotes(counts) };

	if (session.kind === "fork") {
		// The inherited prefix cannot be told apart from the turns the user typed:
		// it is a line-for-line copy of the parent's transcript with the session id
		// rewritten, and the summary's `inherited_prefix_len` counts conversation
		// *items*, which messages are not. So the whole session is imported and the
		// report says whose words are in it.
		const parent = session.parentSessionId === "" ? "a parent session" : `session ${session.parentSessionId}`;
		counts.set(`forked from ${parent}: its inherited prefix is imported whole`, 1);
	}

	return { entries, notes: toNotes(counts) };
}

/**
 * The message boundaries grok's reducer draws, over the lines that survived.
 *
 * The deltas are concatenated without a separator because that is what they are:
 * grok appends each chunk to the same item (`ChatReducer::on_agent_chunk`), and a
 * reader that joined them with a newline would answer differently from the tool.
 * An interjection is pushed as its own message — it never merges with the prompt
 * run beside it, which is the one place the run rule gives way — and its text is
 * the typed words rather than the frame the model saw.
 */
function assemble(lines: GrokLine[], counts: Map<string, number>): AgentMessage[] {
	const messages: AgentMessage[] = [];
	let user: { text: string; timestamp: number } | null = null;
	let agent: { text: string; timestamp: number } | null = null;

	const flushUser = (): void => {
		if (user === null) return;
		messages.push(userMessage(user.text, user.timestamp));
		user = null;
	};
	const flushAgent = (): void => {
		if (agent === null) return;
		// `stop` rather than `toolUse`: no tool block survives into the imported
		// transcript, so a message that claims one would be the first thing the API
		// rejects on resume.
		messages.push(
			assistantMessage({ content: [textContent(agent.text)], timestamp: agent.timestamp, stopReason: "stop" }),
		);
		agent = null;
	};

	for (const line of lines) {
		const carry = line.carry;
		if (carry.kind === "prompt") {
			flushAgent();
			if (carry.interjection) {
				flushUser();
				messages.push(userMessage(unwrapInterjection(carry.text), line.timestamp));
			} else if (user === null) {
				user = { text: carry.text, timestamp: line.timestamp };
			} else {
				user.text += carry.text;
			}
			continue;
		}
		if (carry.kind === "agent") {
			flushUser();
			if (agent === null) agent = { text: carry.text, timestamp: line.timestamp };
			else agent.text += carry.text;
			continue;
		}
		if (carry.kind === "skip") {
			bump(counts, carry.reason);
			if (carry.closesAssistant) {
				flushUser();
				flushAgent();
			}
		}
	}
	flushUser();
	flushAgent();
	return messages;
}

/**
 * The session's compaction segments, oldest first.
 *
 * These are the rendered record of the turns grok compacted away, and they are
 * the only place in the session directory where a summary is written as text —
 * the authoritative copy rides inside the checkpoint file
 * (`compaction_checkpoints/<id>.json`) as `ConversationItem` JSON, which this
 * reader does not parse for the same reason it does not rebuild chat items.
 *
 * They are entries at the *front* of the transcript, and that is a decision.
 * `SessionStore.contextMessages` resumes from the last compaction entry, so a
 * summary at the end of the transcript would leave a resumed session holding
 * nothing but the summary; at the front, every message the file has stands after
 * the boundary and all of it travels. grok's own replay puts its base where the
 * checkpoint line sits instead — mid-file — which drops the turns it kept
 * verbatim around the summary (they live in the checkpoint file this reader
 * leaves alone). Front-loading keeps them, at the price of the summary's text
 * appearing before the lines it summarizes.
 *
 * The token count is zero because the source does not record one: a segment's
 * stats block counts turns, tools, files and errors, and no byte of it is a
 * measurement of what compaction replaced.
 */
function readSegments(dir: string): GrokEntry[] {
	const root = join(dir, "compaction");
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const segments: Array<{ index: number; path: string }> = [];
	for (const name of names) {
		const index = segmentIndex(name);
		if (index === null) continue;
		segments.push({ index, path: join(root, name) });
	}
	segments.sort((a, b) => a.index - b.index);
	const entries: GrokEntry[] = [];
	for (const segment of segments) {
		const summary = (readTextOrNull(segment.path) ?? "").trim();
		if (summary === "") continue;
		entries.push({ kind: "compaction", summary, preTokens: 0 });
	}
	return entries;
}

/** The index in `segment_NNN.md`, by grok's own `parse_segment_index`. */
function segmentIndex(name: string): number | null {
	if (!name.startsWith("segment_") || !name.endsWith(".md")) return null;
	const digits = name.slice("segment_".length, -".md".length);
	return /^[0-9]+$/.test(digits) ? Number(digits) : null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

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
