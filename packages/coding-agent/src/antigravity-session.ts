/**
 * Reading one Antigravity conversation out of `brain/<id>/`.
 *
 * **The unit of import is a summary transcript, not the product's own store.**
 * Antigravity's authoritative store is a serialised `gemini_coder.Trajectory`
 * protobuf; what this module reads is the JSONL rendering of it that the product
 * writes for agents to read, at
 * `brain/<id>/.system_generated/logs/transcript.jsonl`. That is a deliberate
 * choice with three reasons behind it:
 *
 *   - **It is what the product tells a reader to use.** The binary carries the
 *     instruction verbatim: "Start with `transcript.jsonl` (compact). When
 *     `truncated_fields` is present, read only that specific line in
 *     `transcript_full.jsonl`." Decoding the trajectory instead would mean
 *     hand-rolling a protobuf wire-format parser for a message with two
 *     recursive edges (`Step.subtrajectory`, `Step.generic_step`) and a
 *     ~110-member `oneof` spanning field numbers 7–158, with no schema compiler
 *     available to check the result against.
 *   - **It is lossier, and the loss is countable.** {@link AntigravityRead.notes}
 *     says exactly what was dropped and how often, which the trajectory path
 *     would not have made easy to say.
 *   - **It is two files with a stated relationship.** The full transcript is the
 *     untruncated rendering of the same records, and this module uses it for
 *     exactly the lines that say they were cut. That is the whole of the
 *     compact/full split, so honouring it recovers most of what the compact file
 *     gives up.
 *
 * **Nothing here opens a path outside the conversation directory it was given.**
 * `media[].uri` names attachments the user attached to their own turns; those are
 * counted, never fetched — reading them would mean opening files the migration
 * was not asked about.
 */

import { closeSync, type Dirent, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { type AgentMessage, type AssistantContent, assistantMessage, textContent, userMessage } from "@labunbun/ai";
import { antigravityConversationsDir, antigravityTranscriptPaths } from "./antigravity-home.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One conversation worth offering: its transcript located, nothing opened. */
export interface AntigravityConversationFile {
	/** The directory's own name, which is the conversation id. */
	id: string;
	/** The conversation directory — the transcripts are read from it. */
	dir: string;
	/** `.system_generated/logs/transcript.jsonl`, the compact transcript. */
	path: string;
	/**
	 * `.system_generated/logs/transcript_full.jsonl`, the untruncated one, or `""`
	 * when the conversation has none.
	 *
	 * `""` rather than a path that may not exist: the full file is *optional* in
	 * this product's own description of itself, and a reader that receives a path
	 * it must re-check cannot tell "this conversation had nothing truncated" from
	 * "the full file went missing" — two different facts with the same fix.
	 */
	fullPath: string;
	/**
	 * Epoch ms of the conversation's **first** record, or `0` when its head held
	 * none.
	 *
	 * Read from a bounded head rather than from the whole file, and the *first*
	 * record rather than the largest: `step_index` runs from 0 and the writer walks
	 * the trajectory in order, so line one is the start. That is the value a picker
	 * sorts on, and getting it here rather than at read time is what stops
	 * `narrowCandidates` from sorting every conversation by `0` and `selectHistory`
	 * from keeping whichever twenty directory names came first in the alphabet.
	 */
	startedAt: number;
}

/**
 * One record: one line of `transcript.jsonl`.
 *
 * **Every field is optional because the writer's own type says so.** `source`,
 * `type` and `status` carry no `omitempty` and are always present; the rest are
 * omitted when zero, and `step_index` / `exit_code` are pointers, so they are
 * either a JSON number or absent. A reader that reached for `record.step_index`
 * without a guard would be reading a field the product is entitled to leave out.
 *
 * The field names are the vendor's, kept as they are rather than renamed to
 * something this repo already uses, because the one that carries the role —
 * `source`, not `role` — is a rename away from looking like the field every other
 * source in this repo has, and that is precisely the mistake {@link
 * ANTIGRAVITY_USER_SOURCES} exists to prevent.
 */
interface AntigravityRecord {
	step_index?: number;
	source?: string;
	type?: string;
	status?: string;
	exit_code?: number;
	error?: string;
	error_code?: number;
	created_at?: string;
	content?: string;
	thinking?: string;
	tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
	media?: Array<{ mime_type?: string; uri?: string }>;
	truncated_fields?: string[];
}

export interface AntigravityListing {
	conversations: AntigravityConversationFile[];
	notes: Array<{ reason: string; count: number }>;
}

export interface AntigravityRead {
	messages: AgentMessage[];
	/** Epoch ms of the earliest `created_at` seen, `0` when none was readable. */
	startedAt: number;
	/** The first user turn's text, for a candidate title. `""` when there is none. */
	title: string;
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// The role field
// ---------------------------------------------------------------------------

/**
 * The `source` values that are a person typing.
 *
 * **Two of the six, not one.** `CortexStepSource` has six members — `UNSPECIFIED`
 * (0), `MODEL` (2), `USER_IMPLICIT` (3), `USER_EXPLICIT` (4), `SYSTEM` (5) and
 * `SYSTEM_SDK` (6) — and the product itself distinguishes a typing user from an
 * implied one. Both are here, and a reader that switched on `type` instead would
 * be reading a 122-value field that overlaps them.
 *
 * The three that are **not** in this set are dropped and counted, and the two
 * system values are dropped rather than shown as a prompt: `SYSTEM` and
 * `SYSTEM_SDK` are the product's own system prompts, which this repo does not
 * re-inject on resume. They are counted under a reason that names them so the
 * count is not mistaken for a parse failure.
 */
export const ANTIGRAVITY_USER_SOURCES: ReadonlySet<string> = new Set(["USER_IMPLICIT", "USER_EXPLICIT"]);

/** The one `source` that is the model answering. */
const ANTIGRAVITY_MODEL_SOURCE = "MODEL";

/** A candidate title longer than this is cut; the conversation id is the fallback. */
const TITLE_LIMIT = 120;

/**
 * The two reasons this importer gives up on a record, named once because both are
 * the sentence a report renders and both are the sentence a reader of this file
 * has to be able to check.
 */
const NOTE_TOOL_CALLS =
	"tool call with no result — antigravity's transcript.jsonl records what a step called (name and arguments) and " +
	"nothing that came back, so the call and its output are both dropped rather than imported unpaired";

const NOTE_NON_MESSAGE_SOURCES =
	"record whose source is not a user turn or a model answer — antigravity's own system prompts are recorded here and " +
	"are not re-injected on resume, so they are counted and dropped";

const NOTE_BAD_LINE = "line of transcript.jsonl that is not a JSON object";

/**
 * How much of a transcript the listing opens.
 *
 * 64 KiB, and the same figure `migrate-history.ts` uses for its bounded head
 * reads, so a tree of these costs what a tree of those does. The first record of
 * a conversation is a system prompt or a typed turn, both short — a head this size
 * holds thousands of them — so the head that misses is a head on a transcript
 * whose *first line alone* is enormous, which is a shape worth bounding rather
 * than reading whole.
 */
const HEAD_BYTES = 65_536;

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * Every conversation directory, as candidates.
 *
 * **A directory with no compact transcript is skipped, not offered.** The product
 * creates a conversation directory before the first turn is written, so an empty
 * one is an ordinary state; offering it would put "nothing to import" in the
 * report under a reason that does not say why.
 *
 * **The one file that is opened is a bounded head of the transcript, for the
 * start time.** Everything else here is a name and an `existsSync`. Antigravity
 * has no metadata file beside the transcript — no `meta.json`, no `conversation.json`
 * — so the picker would otherwise show a date column of nothing and sort every
 * conversation into a tie, and `--history-limit` would then keep whichever twenty
 * directory names came first in the alphabet. {@link HEAD_BYTES} bounds what a
 * listing over a tree of a thousand conversations costs; {@link AntigravityRead.startedAt}
 * is the same value re-derived from the whole file during the read, so a head that
 * was too small to hold the first record costs the picker a date and nothing else.
 */
export function listAntigravityConversations(dataDir: string): AntigravityListing {
	const conversations: AntigravityConversationFile[] = [];
	const counts = new Map<string, number>();
	const brain = antigravityConversationsDir(dataDir);
	let entries: Dirent[];
	try {
		entries = readdirSync(brain, { withFileTypes: true });
	} catch {
		// A data root with no `brain/` is a home that installed the IDE and never
		// had a conversation, which is not a failure and produces no note.
		return { conversations, notes: toNotes(counts) };
	}
	// Sorted so two runs over one home offer the same list in the same order;
	// `readdirSync` order is filesystem-dependent.
	for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
		if (!entry.isDirectory()) {
			bump(
				counts,
				"file directly under the conversations tree — the product puts one directory per conversation in it",
			);
			continue;
		}
		const dir = join(brain, entry.name);
		const [compact, full] = antigravityTranscriptPaths(dir);
		if (!existsSync(compact)) {
			bump(counts, "conversation with no transcript at .system_generated/logs/transcript.jsonl");
			continue;
		}
		conversations.push({
			id: entry.name,
			dir,
			path: compact,
			fullPath: existsSync(full) ? full : "",
			startedAt: headStartedAt(compact),
		});
	}
	return { conversations, notes: toNotes(counts) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One conversation, as this build's messages.
 *
 * **Four things are dropped, and each is counted rather than hidden.** They are
 * the tool calls (there are no results to pair them with), the system's own
 * prompts, the media attachments, and any line that is not a JSON object. The
 * counts come back in {@link AntigravityRead.notes} so the report can say what
 * an imported transcript is missing instead of the user discovering it on
 * `--continue`.
 *
 * **Reasoning folds into the answer that follows it**, as it does for every other
 * source here: a thinking run and the reply it produced are one turn to the
 * person reading it, and emitting them as two messages produces a transcript
 * that stops to think and then says nothing before answering a question already
 * answered. A run with no assistant message after it — an interrupted turn —
 * becomes its own message rather than disappearing.
 */
export function readAntigravityConversation(file: AntigravityConversationFile): AntigravityRead | { error: string } {
	let text: string;
	try {
		text = readFileSync(file.path, "utf8");
	} catch (err) {
		return { error: `transcript.jsonl could not be read: ${(err as Error).message}` };
	}
	const counts = new Map<string, number>();
	const records = parseRecords(text, counts);
	if (records.length === 0) {
		const reasons = toNotes(counts);
		return {
			messages: [],
			startedAt: 0,
			title: "",
			notes:
				reasons.length > 0
					? reasons
					: [
							{
								reason:
									"conversation whose transcript holds no record — not the same as a conversation with no content: " +
									"antigravity records a tool call as a step rather than as something said",
								count: 1,
							},
						],
		};
	}

	// Only consult the full transcript when a line says it lost something. The
	// product's instruction is per line, not wholesale, so the full file is read
	// once and indexed, but the index is consulted **only** for a line that named a
	// truncated field. Reading every line out of it instead would make
	// `transcript_full.jsonl` the source of truth for the whole conversation, which
	// inverts the product's own ordering: the compact file is the one it keeps
	// small, and a line with nothing truncated is not asking to be replaced.
	const cut = new Set<number>();
	for (const record of records) {
		if ((record.truncated_fields?.length ?? 0) > 0 && typeof record.step_index === "number") cut.add(record.step_index);
	}
	const recovered = cut.size > 0 && file.fullPath !== "" ? fullRecordsByStep(file.fullPath, counts) : new Map();

	const messages: AgentMessage[] = [];
	const pending: string[] = [];
	let startedAt = 0;
	let title = "";
	const flushThinking = (timestamp: number): void => {
		if (pending.length === 0) return;
		messages.push(
			assistantMessage({
				content: pending.map((thinking) => ({ type: "thinking" as const, thinking })),
				// `?? Date.now()` and **not** `timestamp ?? undefined`: `assistantMessage`
				// builds its object with a `timestamp: Date.now()` default that a
				// `Partial`'s spread then *overwrites* with an explicit `undefined`,
				// because `exactOptionalPropertyTypes` is off and `Partial<number>`
				// admits it. The result is a message whose `timestamp` is declared
				// `number` and holds `undefined`. `userMessage` below cannot do this —
				// its second parameter is a real default parameter, so passing
				// `undefined` there takes the default — which is exactly the asymmetry
				// that makes the object form worth spelling out.
				timestamp,
				stopReason: "stop",
			}),
		);
		pending.length = 0;
	};

	for (const record of ordered(records)) {
		const wasCut = typeof record.step_index === "number" && cut.has(record.step_index);
		const full = wasCut ? recovered.get(record.step_index as number) : undefined;
		// The compact value is kept when the full file has no counterpart, so a
		// cut sentence survives as a cut sentence instead of vanishing; the count
		// below is what tells the report that the text is partial.
		const content = full?.content ?? record.content ?? "";
		const thinking = full?.thinking ?? record.thinking ?? "";
		if (wasCut && full === undefined) {
			bump(
				counts,
				"record cut in transcript.jsonl whose step_index is not in transcript_full.jsonl — imported as it stands",
			);
		}

		const at = parseCreatedAt(record.created_at);
		if (at !== null && (startedAt === 0 || at < startedAt)) startedAt = at;
		if ((record.tool_calls?.length ?? 0) > 0) bump(counts, NOTE_TOOL_CALLS, record.tool_calls?.length ?? 0);
		if ((record.media?.length ?? 0) > 0) {
			bump(
				counts,
				"attachment named by the transcript — antigravity records the media kind and the uri beside the turn, and " +
					"reading the file it points at is not something this importer does",
				record.media?.length ?? 0,
			);
		}

		const source = record.source ?? "";
		if (ANTIGRAVITY_USER_SOURCES.has(source)) {
			// A user turn after a thinking run means the run belonged to the reply
			// before it and that reply never landed, so it is its own message here
			// rather than being prepended to the wrong turn.
			//
			// `Date.now()` where the record carries no usable `created_at`, for the
			// reason given on `flushThinking`: this must not be able to write an
			// `undefined` into a field typed `number`.
			flushThinking(at ?? Date.now());
			if (content !== "") {
				// `userMessage` takes a default *parameter*, so `undefined` here takes
				// the default rather than overwriting it — the opposite of the
				// object-spread form above, which is why both spellings differ.
				messages.push(userMessage(content, at ?? undefined));
				if (title === "") title = titleFrom(content);
			}
			continue;
		}
		if (source !== ANTIGRAVITY_MODEL_SOURCE) {
			bump(counts, NOTE_NON_MESSAGE_SOURCES);
			continue;
		}
		if (thinking !== "") pending.push(thinking);
		// **A model record with thinking and no text does not become a message.**
		// The runs held so far end at the reply, and a reply that has not arrived is
		// not a turn: emitting one message per thinking record produces a transcript
		// that pauses to think three times and then answers, which is exactly the
		// shape this folding exists to remove. The trailing run — one whose reply
		// never came — is still emitted, by the `flushThinking` after this loop, so
		// the difference is "how many messages", not "whether".
		if (content === "") continue;
		const parts: AssistantContent[] = pending.map((thinking) => ({ type: "thinking" as const, thinking }));
		pending.length = 0;
		parts.push(textContent(content));
		messages.push(assistantMessage({ content: parts, timestamp: at ?? Date.now(), stopReason: "stop" }));
	}
	flushThinking(Date.now());

	return { messages, startedAt, title, notes: toNotes(counts) };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The records, in the order they happened.
 *
 * **File order is not trusted when `step_index` can order it.** `step_index` is
 * the step's own position in the trajectory, which is what determines the order a
 * reader sees; the JSONL is written by a converter that walks the trajectory, so
 * the two agree today — but a file whose lines were reordered, concatenated or
 * partially rewritten is a file this importer can still order, and a
 * transcript with the thinking run *after* the reply it produced reads as a turn
 * that answered nothing.
 *
 * A file where **some** lines carry an index and some do not keeps file order:
 * sorting on a key that is missing half the time would interleave the two halves
 * by a rule neither of them was written under. That is stated here because the
 * alternative — dropping the unindexed lines — would silently lose steps.
 */
function ordered(records: AntigravityRecord[]): AntigravityRecord[] {
	if (records.length < 2) return records;
	const indexed = records.filter((record) => typeof record.step_index === "number");
	if (indexed.length !== records.length) return records;
	return [...records].sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
}

/** Every line that is a JSON object, in file order. */
function parseRecords(text: string, counts: Map<string, number>): AntigravityRecord[] {
	const records: AntigravityRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			bump(counts, NOTE_BAD_LINE);
			continue;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			bump(counts, NOTE_BAD_LINE);
			continue;
		}
		records.push(parsed as AntigravityRecord);
	}
	return records;
}

/**
 * `transcript_full.jsonl` keyed by `step_index`, or an empty map when it cannot
 * be read at all.
 *
 * An unreadable full file is a counted note rather than a failure: the compact
 * transcript still imports, just with its cut values cut. Returning the map
 * rather than an error is what makes that the default path.
 */
function fullRecordsByStep(path: string, counts: Map<string, number>): Map<number, AntigravityRecord> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		bump(
			counts,
			"transcript_full.jsonl could not be read — imported from the compact transcript with its cut values cut",
		);
		return new Map();
	}
	const scratch = new Map<string, number>();
	const byStep = new Map<number, AntigravityRecord>();
	for (const record of parseRecords(text, scratch)) {
		if (typeof record.step_index !== "number" || byStep.has(record.step_index)) continue;
		byStep.set(record.step_index, record);
	}
	for (const [reason, count] of scratch) bump(counts, `transcript_full.jsonl: ${reason}`, count);
	return byStep;
}

/**
 * `created_at` as epoch ms.
 *
 * The product formats it with the RFC 3339 layout `2006-01-02T15:04:05Z07:00`,
 * which carries its own offset, so `Date.parse` reads it without this importer
 * having to guess a zone — and guessing one would be the failure mode worth
 * naming, since a conversation's start time decides where it sorts in the picker.
 *
 * `null` for anything unparseable rather than `0`: an epoch is a real instant
 * that a reader could mistake for "the epoch", and one bad line should not drag
 * a conversation to 1970.
 */
function parseCreatedAt(value: string | undefined): number | null {
	if (value === undefined || value === "") return null;
	const at = Date.parse(value);
	return Number.isFinite(at) ? at : null;
}

/** A candidate title: the first user turn, on one line and no longer than a report line. */
function titleFrom(content: string): string {
	const single = content.replace(/\s+/g, " ").trim();
	return single.length > TITLE_LIMIT ? `${single.slice(0, TITLE_LIMIT - 1)}…` : single;
}

/**
 * The first `created_at` in the first {@link HEAD_BYTES} of a transcript, as epoch
 * ms, or `0`.
 *
 * **`0` rather than a note, on purpose.** This runs once per conversation before
 * the user has chosen any, so a reason about it would be a line per conversation
 * in a report about a list the user has not acted on yet — and the failure it
 * would describe has a fix the read phase applies anyway: the full read takes the
 * earliest time across every record, so a head that found nothing leaves the
 * picker's date empty and the imported session correctly dated. A count here
 * would report a cosmetic limit as a loss.
 *
 * The tail of the head is dropped rather than parsed: {@link HEAD_BYTES} almost
 * certainly lands mid-line, and a half-line is not a record.
 */
function headStartedAt(path: string): number {
	let handle: number | null = null;
	try {
		handle = openSync(path, "r");
		const buffer = Buffer.alloc(HEAD_BYTES);
		const read = readSync(handle, buffer, 0, HEAD_BYTES, 0);
		const lines = buffer.toString("utf8", 0, read).split("\n");
		// The last element is the fragment the read cut off, whatever it turned out
		// to be — a transcript shorter than the head ends with `""` and loses nothing.
		lines.pop();
		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (parsed === null || typeof parsed !== "object") continue;
			const at = parseCreatedAt((parsed as AntigravityRecord).created_at);
			if (at !== null) return at;
		}
		return 0;
	} catch {
		return 0;
	} finally {
		if (handle !== null) closeSync(handle);
	}
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** Add to a reason's count. Reasons are constants, so keying on the string is safe. */
function bump(counts: Map<string, number>, reason: string, by = 1): void {
	counts.set(reason, (counts.get(reason) ?? 0) + by);
}

/** Counts as report lines: highest first, then by the sentence, so runs agree. */
function toNotes(counts: Map<string, number>): Array<{ reason: string; count: number }> {
	return [...counts.entries()]
		.filter(([, count]) => count > 0)
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([reason, count]) => ({ reason, count }));
}
