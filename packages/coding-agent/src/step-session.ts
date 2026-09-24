/**
 * Step Code session transcripts (`<agent dir>/sessions/<cwd bucket>/*.jsonl`).
 *
 * Step Code is a fork of the MIT-licensed `earendil-works/pi` project
 * (`LICENSE-STATUS.md`, `THIRD_PARTY_NOTICES.md`), and it kept Pi's session format
 * down to the entry shapes: one append-only JSONL file per session, a `session`
 * header on line one, and the same `AgentMessage` objects this build writes
 * (`core/session-manager.ts`: `SessionHeader` at `:32-39`, `SessionMessageEntry`
 * at `:47-50`, the header written at `:939-944`). Nothing here has to be
 * translated between two vocabularies — but three things do have to be *known*:
 *
 *   1. **the version.** `CURRENT_SESSION_VERSION` is 3 (`:30`), and older files are
 *      migrated in memory on load (`migrateToCurrentVersion`, `:280-291`) rather
 *      than on disk. A home holds v1, v2 and v3 files side by side and only the
 *      reader can tell them apart, because none of them says so in its name. The
 *      v1 shape is the one that matters: its entries carry no `id` and no
 *      `parentId` **at all** (the header does carry an `id` — see the fixture at
 *      `test/fixtures/before-compaction.jsonl`, where `"id":"synthetic-session"`
 *      sits next to `"version":1`), and `migrateV1ToV2` (`:231-257`) chains them in
 *      file order so the whole file becomes one path. Reading a v1 file without
 *      doing the same gives every entry no parent, which collapses a whole
 *      conversation to its last line — {@link linkRecords} is that migration, and
 *      it is the reason this reader has one at all.
 *   2. **the tree.** From v2 on, entries hang off a `parentId` and the file holds
 *      every branch the user took; what the model was sent is the path from the
 *      current leaf to the root (`buildSessionPath`, `:334-357`), the leaf being
 *      the last entry in the file (`_buildIndex` sets `leafId` to each entry in
 *      turn, `:959-975`). A reader that imported the file in line order would
 *      import the branches the user walked away from, mixed into the conversation
 *      they stayed in.
 *   3. **the compaction.** A `compaction` entry replaces everything before it on
 *      the path with its summary, except the entries from `firstKeptEntryId` on
 *      (`buildContextEntries`, `:418-459`), and the one that counts is the last one
 *      *on the path* — `getLatestCompactionEntry` scans the path backwards
 *      (`:316-323`, called with the branch at `agent-session.ts:2272`), so an older
 *      compaction is a fact about a branch, not about the conversation. A v1 file
 *      states the same boundary as `firstKeptEntryIndex`, indexed into the file's
 *      entries *including* the header, which `migrateV1ToV2` (`:245-255`) converts —
 *      index 0 is the header and converts to nothing at all, so the boundary is off
 *      by one from this reader's entry list in every v1 file that was ever
 *      compacted.
 *
 * What comes out is the entry list Step would rebuild for the model:
 * `sessionEntryToContextMessages`' projection (`:383-410`) minus the shapes this
 * build has no place for. Kept are the user and assistant text — Step's own
 * messages, unchanged in shape, including a user message's image blocks, which
 * both builds spell `{type:"image", mimeType, data}` (`packages/providers/src/
 * types.ts:303-307`; `@labunbun/ai`'s `ImageContent`) — and the compaction
 * summaries. Counted and left behind are everything else, each with its own
 * reason: tool calls and their results, reasoning blocks, `!` shell commands
 * (`bashExecution`, whose transcript *is* part of Step's context via
 * `bashExecutionToText`, `core/messages.ts:82-98`, but is not a message this build
 * has), extension-injected messages, branch summaries of abandoned branches, and
 * the session's own events. Rebuilding any of those means carrying a second
 * engine's semantics into this one; the count is what keeps the loss honest.
 *
 * Nothing here writes, and nothing outside the session tree is opened. Step's
 * agent directory also holds `auth.json`, `models.json`, `models-store.json` and
 * `settings.json` (`core/auth-storage.ts:73`, `core/model-runtime.ts:175`,
 * `core/models-store.ts:52`, `core/settings-manager.ts:257`) — none of them is
 * opened here. `$STEPCODE_CONFIG_PATH` (`step/stepcode-config.ts:20`) names a
 * *file*, not a tree, and is out of scope for the same reason. When a session
 * directory is configured, sessions are written flat into it
 * (`listSessionsFromDir`, `:812-826`) rather than into a `--<cwd>--` bucket; both
 * layouts are read. Prompt history has no reader to write: Step keeps it in
 * memory in the editor, capped at 100 entries and never touched by a file write
 * (`packages/tui/src/components/editor.ts:318-408`), and no path under the agent
 * directory holds one.
 */
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename } from "node:path";
import {
	type AgentMessage,
	assistantMessage,
	type ImageContent,
	repairToolPairing,
	textContent,
	type UserContent,
	userMessage,
} from "@labunbun/ai";
import { stepSessionScan } from "./step-home.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One session worth offering: header read, title located. */
export interface StepSessionFile {
	/** The `.jsonl` file itself. */
	path: string;
	/** The header's `id`, which is the id Step resumes the session by. */
	id: string;
	/** The header's `cwd` when it names a directory, `null` when it states none. */
	cwd: string | null;
	/** The session's name, as Step's own session list shows it; `null` when it has none. */
	title: string | null;
	/** The header's `timestamp` in epoch ms, 0 when it states none it can parse. */
	startedAt: number;
}

export interface StepListing {
	sessions: StepSessionFile[];
	skipped: Array<{ name: string; reason: string }>;
}

export type StepEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface StepRead {
	entries: StepEntry[];
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * How much of a session file the listing reads to find the session's name.
 *
 * A title can be written anywhere: `session_info` is an ordinary entry (a rename
 * appends one, `core/session-manager.ts:1137-1147`), and the first user message
 * can sit behind a long system prompt and several turns of the user deleting
 * their own first attempts. Step reads the whole file for this
 * (`buildSessionInfo` streams every line, `:688-766`); the listing reads a bounded
 * head instead, because a home with a hundred sessions should cost a hundred
 * bounded reads rather than a hundred conversations. The trade is stated rather
 * than hidden: a name written past the head is not seen, and the session is
 * listed under its first message — which is what Step shows for a session that was
 * never renamed.
 */
const LISTING_HEAD_BYTES = 256 * 1024;

/**
 * Every session Step's own session list would show, with what the listing reads.
 *
 * The walk is `stepSessionScan`'s, and every file it passed over arrives here with
 * the reason it could not become a session (unparseable head, a first entry that
 * is not a header, a header with no id, an unreadable file, a copy of a session
 * already found). Two more skips are this function's own, and both are the same
 * kind of fact: a file that was a session a moment ago and cannot be read now.
 *
 * The order is the precedence `stepSessionDirs` gives — canonical tree first, then
 * the pre-rename one — and name order inside a directory, so two runs over the
 * same home report in the same order.
 */
export function listStepSessions(home: string): StepListing {
	const scan = stepSessionScan(home);
	const sessions: StepSessionFile[] = [];
	const skipped: Array<{ name: string; reason: string }> = [...scan.skipped];
	for (const found of scan.sessions) {
		const head = readHead(found.path, LISTING_HEAD_BYTES);
		if (head === null) {
			skipped.push({ name: basename(found.path), reason: "session file could not be read" });
			continue;
		}
		sessions.push({
			path: found.path,
			id: found.id,
			cwd: found.cwd,
			title: sessionTitle(head),
			startedAt: found.startedAt,
		});
	}
	return { sessions, skipped };
}

/**
 * The name Step's own session list shows for a file, from the part of it read.
 *
 * `buildSessionInfo` keeps two candidates (`core/session-manager.ts:715-735`): the
 * **latest** `session_info` name — including an explicit clear, which it reads as
 * `entry.name?.trim() || undefined` — and the **first user** message with text
 * (`:734-735`; assistant text fills the search corpus but never the preview). The
 * selector renders `session.name ?? session.firstMessage`
 * (`apps/cli/src/ui/view/dialogs/session-selector.ts:465`), which is the order kept
 * here. `"(no messages)"`, the placeholder `buildSessionInfo` substitutes for a
 * missing first message (`:760`), is not a title: a session nobody named and
 * nobody spoke in has none, and `null` says that where a placeholder would claim
 * the user typed it. One place this reader is stricter than the tool: a user
 * message whose text is only whitespace is stepped over rather than shown as the
 * session's name.
 *
 * Step joins a message's text blocks with a space when it extracts this preview
 * (`extractTextContent`, `:663-672`); so does this, for the same reason — the two
 * are showing the same one-line summary, and a title that folded its blocks
 * together differently would read differently from the tool's own list. Step's own
 * screen for a text is `if (!textContent) continue;` (`:731`), which steps over a
 * message whose text is the *empty string* and shows one that is only spaces; the
 * `.trim()` above is this reader's, and the note above records where it differs.
 */
function sessionTitle(head: string): string | null {
	let name: string | null = null;
	let first: string | null = null;
	for (const line of head.split("\n")) {
		const entry = parseJsonLine(line);
		if (entry === null) continue;
		if (entry.type === "session_info") {
			name = asText(entry.name).trim() || null;
			continue;
		}
		if (first !== null || entry.type !== "message") continue;
		const message = asRecord(entry.message);
		if (message === null || message.role !== "user") continue;
		first = previewText(message.content).trim() || null;
	}
	return clipToOneLine(name ?? first);
}

/** A message's content as one line, the way Step's preview does it. */
function previewText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const block of content) {
		const record = asRecord(block);
		if (record !== null && record.type === "text") texts.push(asText(record.text));
	}
	return texts.join(" ");
}

/** Collapse whitespace and clip to one line, as the other sources' listings do. */
function clipToOneLine(text: string | null, max = 60): string | null {
	if (text === null) return null;
	const single = text.replace(/\s+/g, " ").trim();
	if (single === "") return null;
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/**
 * Read one session end to end.
 *
 * Returns `{ error }` for a file that cannot be opened and for one whose first
 * parsed entry is not a session header: Step's own loader answers both with an
 * empty entry list (`loadEntriesFromFile`, `core/session-manager.ts:549-553`), and
 * an empty list is not a session with nothing in it. Everything else inside the
 * file is a line this reader counts and leaves behind, which is what keeps one
 * unknown entry from costing the user a whole conversation.
 *
 * Reading is all this does to the file. Step's own loader is looser about that: it
 * appends a newline to a session file that ends without one *while reading it*
 * (`:555`), which is part of why the test that reads a tree asserts every byte of
 * that tree unmoved.
 */
export function readStepSession(session: StepSessionFile): StepRead | { error: string } {
	const text = readTextOrNull(session.path);
	if (text === null) return { error: "session transcript could not be read" };

	const counts = new Map<string, number>();
	const records: Array<Record<string, unknown>> = [];
	let header: Record<string, unknown> | null = null;
	for (const line of text.split("\n")) {
		const entry = parseJsonLine(line);
		if (entry === null) {
			// A blank line is stepped over in silence — writers append one and Step
			// appends one too when a run was cut mid-line (`:555`) — while a line that
			// was meant to be JSON and is not is a fact about the file.
			if (line.trim() !== "") bump(counts, "malformed line");
			continue;
		}
		if (header === null) {
			if (entry.type !== "session" || asText(entry.id) === "") {
				return { error: "session has no readable header" };
			}
			header = entry;
			continue;
		}
		records.push(entry);
	}
	if (header === null) return { error: "session has no readable header" };

	const version = typeof header.version === "number" ? header.version : 1;
	const linked = linkRecords(records, version);
	const byId = new Map(linked.map((record) => [record.id, record]));

	const path: StepRecord[] = [];
	const visited = new Set<string>();
	let current: StepRecord | undefined = linked[linked.length - 1];
	while (current !== undefined && !visited.has(current.id)) {
		visited.add(current.id);
		path.push(current);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	// A hand-edited `parentId` that loops is a walk Step's own reader never returns
	// from (`buildSessionPath`'s `while (current)`). Stopping is the only useful
	// behaviour for a migrator, and the note says which file did it.
	if (current !== undefined) bump(counts, "entry whose parent chain loops back on itself");
	path.reverse();
	const onPath = new Set(path.map((record) => record.id));
	for (const record of linked) {
		if (record.raw.type !== "message" || onPath.has(record.id)) continue;
		bump(counts, "message on an abandoned branch");
	}

	const items: StepEntry[] = [];
	let stamp = session.startedAt;
	for (const record of applyCompaction(path, counts)) {
		// An entry's own time is its message's numeric `timestamp`, else its own ISO
		// one — `getMessageActivityTime`'s order (`:679-685`) — and a line that states
		// neither keeps the last known time rather than jumping back to the session's
		// start and reordering the messages it feeds.
		const own = entryTime(record.raw);
		if (own > 0) stamp = own;
		const type = asText(record.raw.type);
		if (type === "compaction") {
			const summary = asText(record.raw.summary);
			// An empty summary is nothing to carry into a transcript. Step's projection
			// guards the branch-summary branch with `entry.summary` (`:401`) and has no
			// such guard on the compaction branch (`:404-405`), so an empty one there
			// projects into an empty message; this reader counts it instead.
			if (summary === "") {
				bump(counts, "compaction with no summary");
				continue;
			}
			items.push({ kind: "compaction", summary, preTokens: tokenCount(record.raw.tokensBefore) });
			continue;
		}
		if (type === "message") {
			const message = projectMessage(record.raw, counts, stamp);
			if (message !== null) items.push({ kind: "message", message });
			continue;
		}
		bump(counts, reasonForEntryType(type));
	}

	// The shared guard the other sources use, kept even though this projection
	// cannot produce a tool message for it to drop: it is the one place a mismatch
	// between calls and results would be caught, and `dropped` is what the report
	// prints. The repair only removes, and it removes in order, which is what lets
	// the surviving messages be laid back over the message slots below.
	const messages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
	const repaired = repairToolPairing(messages);
	bump(counts, "unpaired tool call or result", repaired.dropped);
	const entries: StepEntry[] = [];
	let next = 0;
	for (const item of items) {
		if (item.kind === "compaction") {
			entries.push(item);
			continue;
		}
		const message = repaired.messages[next];
		next += 1;
		if (message !== undefined) entries.push({ kind: "message", message });
	}

	// A session that continues another one — `/fork` and `/branch` write their own
	// file with `parentSession` naming the file they came from
	// (`core/session-manager.ts:1620`; `/new` sets the same field to the
	// previous session, `:1443`) — begins with a copy of that session's
	// entries. Nothing in the file marks where the copy ends, so the whole session
	// is imported and the note says whose words are in it, which is the same call
	// grok's reader makes for a forked session.
	const parent = asText(header.parentSession);
	if (parent !== "") {
		counts.set(`continues ${parent} (a fork or branch copies its words into this file)`, 1);
	}

	return { entries, notes: toNotes(counts) };
}

/**
 * One entry with the id and parent the tree walk needs.
 *
 * `version` decides where they come from, mirroring `migrateToCurrentVersion`:
 * from v2 on they are the file's own fields, and for a v1 file they are this
 * reader's — a chain in file order, one entry after the next, exactly the shape
 * `migrateV1ToV2` builds (`core/session-manager.ts:236-243`). The ids are `v1-N`
 * rather than uuids because nothing outside this read ever sees them: they exist
 * to make one path out of a linear file, and a v1 file has no id of its own to
 * reuse. An entry with no readable id keeps `""`, which no `parentId` can name
 * (`asText(value) || null` below), so a hole in a hand-edited v2 file ends the
 * walk there instead of joining it to another hole.
 */
function linkRecords(records: Array<Record<string, unknown>>, version: number): StepRecord[] {
	return records.map((raw, index) => {
		if (version >= 2) return { raw, id: asText(raw.id), parentId: asText(raw.parentId) || null };
		return { raw, id: `v1-${index}`, parentId: index === 0 ? null : `v1-${index - 1}` };
	});
}

/**
 * The entries Step would put in front of the model, by `buildContextEntries`'
 * rule (`core/session-manager.ts:418-459`).
 *
 * The last compaction on the path stands in for the entries before it, except
 * those from the boundary it names onwards, which stay; everything after it stays
 * as it is. The boundary is a *set* difference from the file rather than a
 * position: `firstKeptEntryId` names an entry by id, so a boundary that is not on
 * the path keeps nothing, and so does a boundary of `""` — the same answer
 * `buildContextEntries` reaches when no entry's id matches, which is also what a
 * v1 index of 0 (the header) converts to.
 */
function applyCompaction(path: StepRecord[], counts: Map<string, number>): StepRecord[] {
	let compaction: StepRecord | null = null;
	for (const record of path) {
		if (record.raw.type === "compaction") compaction = record;
	}
	if (compaction === null) return path;
	const at = path.indexOf(compaction);
	if (at < 0) return path;

	const before = path.slice(0, at);
	const boundary = keptEntryId(compaction, path);
	const from = boundary === "" ? before.length : before.findIndex((record) => record.id === boundary);
	const kept = from < 0 ? [] : before.slice(from);
	const replaced = before.length - kept.length;
	if (replaced > 0) bump(counts, "replaced by the last compaction summary", replaced);
	return [compaction, ...kept, ...path.slice(at + 1)];
}

/**
 * The id a compaction keeps entries from, which is two fields in two versions.
 *
 * `firstKeptEntryId` is the v2+ spelling. A v1 file states
 * `firstKeptEntryIndex` instead, and `migrateV1ToV2` (`core/session-manager.ts:245
 * -255`) converts it by indexing the file's entries *including* the header, which
 * is why the index is off by one from this reader's entry list — index 1 is the
 * first entry after the header. Index 0 names the header, and the migration
 * deliberately leaves the field unset for it (`targetEntry.type !== "session"`),
 * so it converts to no boundary at all rather than to the first entry, which is
 * the off-by-one this function exists to get right: getting it wrong moves the
 * kept range by a whole message in every v1 session that was compacted.
 */
function keptEntryId(compaction: StepRecord, path: StepRecord[]): string {
	const stated = asText(compaction.raw.firstKeptEntryId);
	if (stated !== "") return stated;
	const index = compaction.raw.firstKeptEntryIndex;
	if (typeof index !== "number" || !Number.isInteger(index) || index < 1) return "";
	// The boundary is resolved against the *path*, as `buildContextEntries` does
	// when it compares against the entries it is walking: an index naming an entry
	// on an abandoned branch keeps nothing.
	return path[index - 1]?.id ?? "";
}

/**
 * One `message` entry as this build's message, or `null` when there is nothing in
 * it to import.
 *
 * Both roles keep the source's own content shape — a string stays a string, blocks
 * stay blocks — because that is what Step sends (`sessionEntryToContextMessages`
 * returns the message unchanged, `return [message];`, `:394`), and the one
 * thing this reader adds is the timestamp, which the file states as an ISO string
 * or a number and `Message` wants in epoch ms.
 */
function projectMessage(
	entry: Record<string, unknown>,
	counts: Map<string, number>,
	timestamp: number,
): AgentMessage | null {
	const message = asRecord(entry.message);
	if (message === null) {
		bump(counts, "message entry with no message");
		return null;
	}
	const role = asText(message.role);
	if (role === "user") return projectUser(message.content, counts, timestamp);
	if (role === "assistant") return projectAssistant(message.content, counts, timestamp);
	bump(counts, reasonForRole(role));
	return null;
}

/** A user message: text and images are kept, anything else is counted. */
function projectUser(content: unknown, counts: Map<string, number>, timestamp: number): AgentMessage | null {
	if (typeof content === "string") {
		if (content.trim() === "") {
			bump(counts, "empty user message");
			return null;
		}
		return userMessage(content, timestamp);
	}
	if (!Array.isArray(content)) {
		bump(counts, "user message with no text");
		return null;
	}
	const kept: UserContent[] = [];
	for (const block of content) {
		const record = asRecord(block);
		if (record === null) {
			bump(counts, "attachment that is not text");
			continue;
		}
		if (record.type === "text") {
			kept.push({ type: "text", text: asText(record.text) });
			continue;
		}
		// An image is the one attachment that crosses over unchanged: both builds
		// hold it as base64 plus a MIME type, so importing the prompt whole costs
		// nothing and dropping it would announce a prompt the user did not type.
		if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
			const image: ImageContent = { type: "image", mimeType: record.mimeType, data: record.data };
			kept.push(image);
			continue;
		}
		bump(counts, "attachment that is not text");
	}
	if (kept.every((block) => block.type === "text" && block.text.trim() === "")) {
		bump(counts, "user message with no text");
		return null;
	}
	return userMessage(kept, timestamp);
}

/** An assistant message: its text blocks are kept, everything else counted. */
function projectAssistant(content: unknown, counts: Map<string, number>, timestamp: number): AgentMessage | null {
	const texts: string[] = [];
	if (typeof content === "string") {
		if (content !== "") texts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			const record = asRecord(block);
			if (record === null) {
				bump(counts, "content block that is not text");
				continue;
			}
			const type = asText(record.type);
			if (type === "text") {
				texts.push(asText(record.text));
				continue;
			}
			if (type === "thinking") {
				// A thinking block is dropped rather than carried: its
				// `thinkingSignature` is provider replay data, tied to the model that
				// issued it, and a signature replayed against a different provider is
				// the first thing that is rejected on resume.
				bump(counts, "reasoning block");
				continue;
			}
			if (type === "toolCall") {
				bump(counts, "tool call");
				continue;
			}
			bump(counts, "content block that is not text");
		}
	}
	if (texts.every((text) => text.trim() === "")) {
		bump(counts, "assistant message with no text");
		return null;
	}
	// `stop` rather than the stored `stopReason`, the same call grok's reader makes:
	// the blocks that are not carried — a tool call, most of all — are exactly what
	// `toolUse` and `aborted` describe, and a reason that outlives its blocks is the
	// first thing the provider rejects. A turn that was cut off and never answered
	// has no text at all and was dropped above.
	return assistantMessage({ content: texts.map(textContent), timestamp, stopReason: "stop" });
}

/**
 * Why a message that carries nothing is worth counting.
 *
 * The names are the ones the report prints, so they say what the message *was*
 * rather than which role it wore: a reader of the report has not read Step's
 * source. `hookMessage` is named because a v2 file spells the extension-injected
 * role that way and `migrateV2ToV3` (`core/session-manager.ts:259-274`) renames it
 * to `custom` on load — a reader that only knew the v3 name would report one
 * extension's messages as an unknown role.
 */
function reasonForRole(role: string): string {
	if (role === "toolResult") return "tool result";
	if (role === "bashExecution") return "`!` shell command";
	if (role === "custom" || role === "hookMessage") return "extension-injected message";
	if (role === "branchSummary") return "branch summary of an abandoned branch";
	if (role === "compactionSummary") return "compaction summary";
	if (role === "") return "message with no role";
	return "message with an unknown role";
}

/** Why an entry that is not a message or a compaction is worth counting. */
function reasonForEntryType(type: string): string {
	if (type === "custom") return "extension entry (not in context)";
	if (type === "custom_message") return "extension-injected message";
	if (type === "branch_summary") return "branch summary of an abandoned branch";
	if (type === "model_change") return "model change";
	if (type === "thinking_level_change") return "thinking level change";
	if (type === "label") return "session label";
	if (type === "session_info") return "session name";
	if (type === "session") return "second session header in one file";
	return "session event";
}

/** An entry's own time in epoch ms, 0 when it states none this reader can parse. */
function entryTime(entry: Record<string, unknown>): number {
	const own = asRecord(entry.message)?.timestamp;
	if (typeof own === "number" && Number.isFinite(own) && own > 0) return own;
	const parsed = Date.parse(asText(entry.timestamp));
	return Number.isFinite(parsed) ? parsed : 0;
}

/** `tokensBefore` as a count, 0 when the file states none. */
function tokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** One parsed entry and the tree fields the walk reads. */
interface StepRecord {
	raw: Record<string, unknown>;
	id: string;
	parentId: string | null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Up to `limit` bytes of a file as text, or `null` when it cannot be opened. */
function readHead(path: string, limit: number): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(limit);
		const read = readSync(fd, buffer, 0, limit, 0);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
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

/** Count one skip reason; the notes come out in first-seen order. */
function bump(counts: Map<string, number>, reason: string, by = 1): void {
	if (by <= 0) return;
	counts.set(reason, (counts.get(reason) ?? 0) + by);
}

function toNotes(counts: Map<string, number>): Array<{ reason: string; count: number }> {
	return [...counts].map(([reason, count]) => ({ reason, count }));
}
