// Long-form design notes: docs/dev/migration-sources.md
/**
 * Command Code session transcripts (`~/.commandcode/projects/<slug>/<id>.jsonl`).
 *
 * ## The file
 *
 * A session is **one JSON object per line, and the first line is not a message**
 * — it is a header. The CLI's own validator is short enough to quote in prose
 * (`dist/cli.mjs`, function `isSessionHeaderV3`, kept verbatim by `__name` in
 * the minified bundle): a record is a header when `type === "session"`,
 * `version === 3`, and `id`, `timestamp` and `cwd` are all strings. **`cwd` in
 * the header is the fact a scope filter needs**, and it is why this importer
 * needs no directory-name decoding: the directory a session ran in is written
 * on the session.
 *
 * Every line after the header is an entry, validated the same way
 * (`isSessionEntryV3`): `type` in the nine-member set the loader keeps
 * (`COMMAND_CODE_ENTRY_TYPES`), `id` a string, `parentId` `null` or a string,
 * `timestamp` a string. **The entries are a tree, not a list** — `parentId`
 * chains them, and one file holds every branch that was ever taken. What the
 * CLI shows (and resumes) is the **active** branch, and its picker is
 * `buildSessionPath` in the bundle: start at the **last** entry in the file,
 * follow `parentId` up with a `Set` for cycle protection, reverse so ancestors
 * come first. This reader walks the same path for the same reason: importing
 * every branch would put conversations the user abandoned into one transcript.
 *
 * ## The entries
 *
 * Four of the nine types carry text a transcript can use:
 *
 * - `message` — `{ message: { role, content } }`, where `content` is an
 *   Anthropic-shaped block array (`text`, `thinking` with its `signature`,
 *   `tool_use` with `id`/`name`/`input`, `tool_result` with
 *   `tool_use_id`/`content`/`is_error`, `image` with
 *   `source: { type: "base64", media_type, data }`). The CLI is an Anthropic
 *   client, so these blocks translate one-for-one — with the one translation
 *   every Anthropic source here needs: a user message holding `tool_result`
 *   blocks becomes this build's `toolResult` messages, and a result carries no
 *   tool name, so the name is recovered from the matching `tool_use` (the same
 *   `rewriteToolNames` repair the Claude Code reader uses, for the same
 *   reason).
 * - `compaction` — `{ summary, tokensBefore, firstKeptEntryId, … }`: the
 *   product replaced its own context prefix with `summary`, and `tokensBefore`
 *   is the measured size of the prefix. It maps onto this build's compaction
 *   entry directly, boundary and all.
 * - `branch_summary` — `{ summary, fromId, … }`: the product's words for "this
 *   conversation came back from a branch". It is rendered to the model as a
 *   user message and it is shown in the product's own transcript, so it
 *   arrives here the same way, wearing the product's own framing verbatim
 *   (`dv`/`uv` in the bundle; see {@link COMMAND_CODE_BRANCH_SUMMARY_LEAD}).
 * - `custom_message` — `{ customType, content, display }`: text a mod put in
 *   front of the user. `display: true` means it was shown, and it arrives as a
 *   user message; anything else was injected context, and is counted rather
 *   than imported — the same visibility rule the product's own session picker
 *   applies (`message.meta.isMeta` skips a message there, too).
 *
 * The other five (`model_change`, `effort_change`, `custom`, `label`,
 * `session_info`) are bookkeeping: the context builder turns them into no
 * message at all, and this reader counts them rather than moving them
 * somewhere they would mean something different.
 *
 * ## What the listing reads and what the read reads
 *
 * The listing wants a header, a title and a start time, so it reads a
 * **bounded head** of each candidate — a session with a hundred conversations
 * costs a hundred bounded reads. The read phase is called only for the
 * sessions the user chose, and reads the whole file.
 *
 * The title is `meta.title` from the `<id>.meta.json` sidecar, which the
 * product rewrites in step with every rename (`appendSessionInfo` sets
 * `meta.title` and `userRenamed` in the same write), with the head window's
 * own fallback chain behind it: the last `session_info` name in the window
 * (the bundle's `latestSessionInfoName` picks the last non-empty one), then
 * the first visible user text — the same two fallbacks the product's session
 * list uses, in the same order.
 *
 * ## Print sessions stay out
 *
 * `meta.entrypoint === "print"` marks a scripted `-p` run. The product's own
 * session listing hides those by default (`includePrint: false`), and this
 * importer lists what that list shows — a user who never saw a session in
 * Command Code should not meet it for the first time here.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentMessage,
	type AssistantContent,
	assistantMessage,
	type ImageContent,
	repairToolPairing,
	type ToolResultContent,
	textContent,
	toolResultMessage,
	type Usage,
	type UserContent,
	userMessage,
} from "@labunbun/ai";
import {
	COMMAND_CODE_ENTRY_TYPES,
	COMMAND_CODE_META_SUFFIX,
	COMMAND_CODE_SESSION_VERSION,
	commandCodeProjectsDir,
	commandCodeRoot,
	isCommandCodeTranscriptName,
} from "./command-code-home.ts";
import { isRecord } from "./migrate-core.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One session worth offering: header read, directory and title located. */
export interface CommandCodeSessionFile {
	path: string;
	/** The file's own stem, which is the id the CLI files the session under. */
	id: string;
	/** `header.cwd`, the directory the session ran in. Required by the v3 header. */
	cwd: string;
	/** The product's title for the session, or a fallback; `""` when it has none. */
	title: string;
	/** `header.timestamp` in epoch ms, 0 when the file states none it can parse. */
	startedAt: number;
}

export interface CommandCodeListing {
	sessions: CommandCodeSessionFile[];
	skipped: Array<{ name: string; reason: string }>;
}

export type CommandCodeEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface CommandCodeRead {
	entries: CommandCodeEntry[];
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * How much of a session file the listing reads.
 *
 * A session is JSONL and opens with its header, so a few hundred bytes answer
 * the shape question; the window exists for the title fallbacks, which walk
 * the head looking for a `session_info` entry or the first user message. It is
 * **bounded** precisely so a home with a hundred sessions costs a hundred
 * bounded reads rather than a hundred conversations. A rename recorded past
 * the window is still found, because the sidecar the product maintains beside
 * the file is checked first.
 */
const LISTING_HEAD_BYTES = 256 * 1024;

/** `meta.entrypoint` for a scripted run — the one the product's own session list hides. */
const COMMAND_CODE_PRINT_ENTRYPOINT = "print";

// Long-form design notes: docs/dev/migration-sources.md
/**
 * The product's own words for a branch that a conversation came back from,
 * verbatim from the bundle (`dv`/`uv` beside `entryToContextMessages`), because
 * the target has no branch concept: the one thing this message must carry is
 * what the product meant by it, and its own sentence says it.
 */
export const COMMAND_CODE_BRANCH_SUMMARY_LEAD =
	"The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export const COMMAND_CODE_BRANCH_SUMMARY_TAIL = "</summary>";

/**
 * Every session Command Code's own session list would show.
 *
 * The walk mirrors the CLI's `listAllSessionsV3`: the projects directory holds
 * one directory per project slug, and each transcript is `<id>.jsonl` inside
 * one of them. `isCommandCodeTranscriptName` excludes the sidecars that share
 * the extension (`.checkpoints.jsonl`, `.prompts.jsonl`, `.v2.bak`), so what
 * the CLI lists as a session, this importer lists as one. Names are sorted
 * rather than trusting directory order, so two runs over one home report the
 * same thing.
 */
export function listCommandCodeSessions(home: string): CommandCodeListing {
	const projects = commandCodeProjectsDir(commandCodeRoot(home));
	const sessions: CommandCodeSessionFile[] = [];
	const skipped: CommandCodeListing["skipped"] = [];
	for (const dir of sortedProjectDirs(projects)) {
		let files: string[];
		try {
			files = readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && isCommandCodeTranscriptName(entry.name))
				.map((entry) => entry.name)
				.sort();
		} catch {
			skipped.push({ name: dir, reason: "project directory that could not be listed" });
			continue;
		}
		for (const name of files) {
			const path = join(dir, name);
			const head = readHeadLines(path);
			if (head.length === 0) {
				skipped.push({ name: path, reason: "session file that could not be read" });
				continue;
			}
			const opened = openCommandCodeTranscript(head);
			if ("reason" in opened) {
				skipped.push({ name: path, reason: opened.reason });
				continue;
			}
			const { header, firstIndex } = opened;
			const meta = readCommandCodeMeta(dir, name);
			if (meta?.entrypoint === COMMAND_CODE_PRINT_ENTRYPOINT) {
				skipped.push({
					name: path,
					reason:
						"session started with `-p` (a scripted, non-interactive run) — the product's own session list hides print " +
						"mode sessions by default, and this importer lists what that list shows",
				});
				continue;
			}
			const scanned = scanHeadForListing(head, firstIndex);
			const parsedTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
			const metaTitle = typeof meta?.title === "string" ? meta.title : "";
			sessions.push({
				path,
				id: name.slice(0, -".jsonl".length),
				cwd: typeof header.cwd === "string" ? header.cwd : "",
				title: metaTitle || scanned.sessionInfoName || scanned.firstUserText,
				startedAt: Number.isFinite(parsedTime) ? parsedTime : scanned.firstTimestamp,
			});
		}
	}
	return { sessions, skipped };
}

/** The project slug directories under the projects root, name-sorted. */
function sortedProjectDirs(projects: string): string[] {
	try {
		return readdirSync(projects, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()
			.map((name) => join(projects, name));
	} catch {
		// No projects directory is the ordinary state of a home whose sessions
		// never started, and not a failure: it contributes no candidates.
		return [];
	}
}

/**
 * The header of an opened head window, or the reason the file is not one of
 * today's transcripts.
 *
 * The first **non-blank** line decides, which is `detectSessionFileVersion`'s
 * own rule (it skips blanks and judges the first record it can parse). A
 * first line that parses but is not a v3 header is a newer format, an older
 * one, or a version 3 header missing a field, and each gets its own sentence
 * because they are different facts: a newer file is one this importer is too
 * old to read, an older one is a file the CLI itself will convert the next
 * time it opens it, and a malformed v3 header is a file the CLI's own loader
 * would refuse.
 */
function openCommandCodeTranscript(
	head: string[],
): { header: Record<string, unknown>; firstIndex: number } | { reason: string } {
	for (let index = 0; index < head.length; index += 1) {
		if (!head[index].trim()) continue;
		const parsed = parseCommandCodeLine(head[index]);
		if (parsed === null) {
			return {
				reason: "session file whose first line is not JSON — a version 3 session opens with a header object",
			};
		}
		if (isCommandCodeHeaderV3(parsed)) return { header: parsed, firstIndex: index };
		if (parsed.type === "session" && parsed.version === COMMAND_CODE_SESSION_VERSION) {
			return {
				reason:
					"session file whose header is missing a field a version 3 header carries (`id`, `timestamp` and `cwd` are " +
					"all strings) — not a session the CLI itself would open",
			};
		}
		if (
			parsed.type === "session" &&
			typeof parsed.version === "number" &&
			parsed.version > COMMAND_CODE_SESSION_VERSION
		) {
			return {
				reason:
					`session file in a newer format (version ${parsed.version}, and this importer reads ` +
					`version ${COMMAND_CODE_SESSION_VERSION} transcripts) — the copy the current CLI writes is what is read here`,
			};
		}
		return {
			reason:
				"session file in Command Code's older format — the CLI itself converts these to version 3 the next time it opens " +
				"them, and this importer reads only what the CLI writes today",
		};
	}
	return { reason: "session file that could not be read" };
}

/** The header validator, verbatim from the bundle's `isSessionHeaderV3`. */
function isCommandCodeHeaderV3(value: Record<string, unknown>): boolean {
	return (
		value.type === "session" &&
		value.version === COMMAND_CODE_SESSION_VERSION &&
		typeof value.id === "string" &&
		typeof value.timestamp === "string" &&
		typeof value.cwd === "string"
	);
}

/** The entry validator, verbatim from the bundle's `isSessionEntryV3`. */
function isCommandCodeEntryV3(value: Record<string, unknown>): boolean {
	return (
		typeof value.type === "string" &&
		COMMAND_CODE_ENTRY_TYPES.includes(value.type) &&
		typeof value.id === "string" &&
		(value.parentId === null || typeof value.parentId === "string") &&
		typeof value.timestamp === "string"
	);
}

/** What the listing can learn from the head window past the header. */
function scanHeadForListing(
	head: string[],
	firstIndex: number,
): { sessionInfoName: string; firstUserText: string; firstTimestamp: number } {
	let sessionInfoName = "";
	let firstUserText = "";
	let firstTimestamp = 0;
	for (let index = firstIndex + 1; index < head.length; index += 1) {
		const parsed = parseCommandCodeLine(head[index]);
		if (parsed === null || !isCommandCodeEntryV3(parsed)) continue;
		if (firstTimestamp === 0 && typeof parsed.timestamp === "string") {
			const parsedTime = Date.parse(parsed.timestamp);
			if (Number.isFinite(parsedTime)) firstTimestamp = parsedTime;
		}
		// Last one in the window wins, which is the bundle's `latestSessionInfoName`
		// rule applied to the part of the file this read holds.
		if (parsed.type === "session_info" && typeof parsed.name === "string" && parsed.name.length > 0) {
			sessionInfoName = parsed.name;
			continue;
		}
		if (firstUserText === "" && parsed.type === "message") {
			const message = isRecord(parsed.message) ? parsed.message : null;
			const meta = message !== null && isRecord(message.meta) ? message.meta : null;
			if (message !== null && message.role === "user" && meta?.isMeta !== true) {
				firstUserText = firstText(messageContentText(message.content));
			}
		}
	}
	return { sessionInfoName, firstUserText, firstTimestamp };
}

/**
 * The `<id>.meta.json` sidecar, or `null` when there is none to read.
 *
 * The product merges every meta write into this file (`writeSessionMeta`:
 * `{ ...old, ...meta }`), and a rename lands here in the same write as the
 * `session_info` entry — so a title found here is the newest one, not a
 * head-window guess.
 */
function readCommandCodeMeta(dir: string, transcriptName: string): Record<string, unknown> | null {
	const id = transcriptName.slice(0, -".jsonl".length);
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, `${id}${COMMAND_CODE_META_SUFFIX}`), "utf8"));
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The opening lines of a file, or `[]` when it could not be opened.
 *
 * Opened and read rather than `readFileSync`-then-slice, because the whole
 * point of the bound is not to pay for the conversation. A window that stops
 * mid-line can leave a truncated last line, which never parses — so the
 * truncation reports itself as an unreadable entry rather than as data.
 */
function readHeadLines(path: string, maxBytes = LISTING_HEAD_BYTES): string[] {
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const read = readSync(fd, buffer, 0, maxBytes, 0);
			return buffer.toString("utf8", 0, read).split("\n");
		} finally {
			closeSync(fd);
		}
	} catch {
		return [];
	}
}

function parseCommandCodeLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Concatenated `text` blocks of a message's content, the way the product's own `extractTextFromMessageContent` joins them. */
function messageContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const raw of content) {
		const block = isRecord(raw) ? raw : null;
		if (block !== null && block.type === "text" && typeof block.text === "string") text += block.text;
	}
	return text;
}

/** A one-line title, collapsed and cut, the same shape the Claude Code listing uses. */
function firstText(value: string, max = 60): string {
	const single = value.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Convert one Command Code session into this build's transcript shape.
 *
 * **The whole file is read here** — this is the expensive phase, and
 * `migrate-history.ts` only calls it for the sessions the user chose.
 *
 * The walk is `buildSessionPath` then the path in order: the active branch,
 * ancestors first. A compaction entry becomes this build's compaction entry at
 * its own position (`tokensBefore` is the product's own measurement, so it is
 * carried rather than guessed), which means the transcript keeps the whole
 * conversation **and** the marker for where the product summarized it — the
 * messages above a compaction are still real history, and nothing about
 * importing should pretend they were never said.
 */
export function readCommandCodeSession(path: string, startedAt: number): CommandCodeRead {
	const counts = new Map<string, number>();
	const bump = (reason: string, by = 1): void => {
		counts.set(reason, (counts.get(reason) ?? 0) + by);
	};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {
			entries: [],
			notes: [
				{ reason: "session transcript that could not be read — it moved or was removed since the listing", count: 1 },
			],
		};
	}
	const lines = text.split("\n");
	let headerIndex = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (!lines[index].trim()) continue;
		headerIndex = index;
		break;
	}
	const header = headerIndex === -1 ? null : parseCommandCodeLine(lines[headerIndex]);
	if (header === null || !isCommandCodeHeaderV3(header)) {
		return {
			entries: [],
			notes: [
				{ reason: "session file that is no longer a version 3 transcript — it changed since the listing", count: 1 },
			],
		};
	}

	const all: Array<Record<string, unknown>> = [];
	let malformed = 0;
	for (let index = headerIndex + 1; index < lines.length; index += 1) {
		if (!lines[index].trim()) continue;
		const parsed = parseCommandCodeLine(lines[index]);
		if (parsed === null || !isCommandCodeEntryV3(parsed)) {
			malformed += 1;
			continue;
		}
		all.push(parsed);
	}

	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of all) byId.set(asText(entry.id), entry);
	const branch = activeEntryPath(all, byId);
	const offPath = all.length - branch.length;

	// Messages and marks are collected apart, and the repaired message stream is
	// what becomes the entry list below — see the comment at the repair for why.
	const collected: AgentMessage[] = [];
	const marks: Array<{ after: number; entry: CommandCodeEntry }> = [];
	let injected = 0;
	let bookkeeping = 0;
	for (const entry of branch) {
		const type = asText(entry.type);
		const timestamp = entryTimestamp(entry, startedAt);
		if (type === "message") {
			const message = isRecord(entry.message) ? entry.message : null;
			if (message === null) {
				bump("message entry whose `message` is not an object");
				continue;
			}
			const role = asText(message.role);
			const content = Array.isArray(message.content) ? message.content : [];
			if (content.length === 0) {
				bump("message with no content blocks");
				continue;
			}
			if (role === "user") {
				const meta = isRecord(message.meta) ? message.meta : null;
				// `meta.isMeta` is the product's own flag for context it put in front
				// of the model without showing it, and its session picker skips those
				// messages when it counts; so does this reader.
				if (meta?.isMeta === true) {
					injected += 1;
					continue;
				}
				commandCodeUserTurn(content, timestamp, (message) => collected.push(message), bump);
				continue;
			}
			if (role === "assistant") {
				const blocks = commandCodeAssistantBlocks(content, bump);
				if (blocks.length === 0) {
					bump("assistant message whose blocks were all dropped");
					continue;
				}
				collected.push(
					assistantMessage({
						content: blocks,
						// `usage`, `model` and `effort` live on the entry, not on the
						// message (`appendMessage` spreads them beside `message`), and all
						// three are written for assistant turns only.
						model: asText(entry.model),
						usage: commandCodeUsage(entry.usage),
						// The product does not persist its stop reason, so the honest
						// inference is the one every reader here makes: a turn with a call
						// in it stopped to use the tool, anything else stopped.
						stopReason: blocks.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
						timestamp,
					}),
				);
				continue;
			}
			bump(`\`${role}\` message, which this build has no role for`);
			continue;
		}
		if (type === "compaction") {
			const summary = asText(entry.summary);
			if (summary === "") {
				bump("compaction entry that recorded no summary");
				continue;
			}
			const preTokens = typeof entry.tokensBefore === "number" ? entry.tokensBefore : 0;
			marks.push({ after: collected.length, entry: { kind: "compaction", summary, preTokens } });
			continue;
		}
		if (type === "branch_summary") {
			const summary = asText(entry.summary);
			if (summary === "") {
				bump("branch summary that recorded no summary");
				continue;
			}
			collected.push(
				userMessage(`${COMMAND_CODE_BRANCH_SUMMARY_LEAD}${summary}${COMMAND_CODE_BRANCH_SUMMARY_TAIL}`, timestamp),
			);
			continue;
		}
		if (type === "custom_message") {
			// `display` is read the way the product's context builder reads it
			// (`isMeta: !display`): only an explicit `true` means the user saw it.
			if (entry.display !== true) {
				injected += 1;
				continue;
			}
			const blocks = commandCodeCustomMessageBlocks(entry.content, bump);
			if (blocks.length === 0) continue;
			collected.push(userMessage(blocks, timestamp));
			continue;
		}
		// `model_change`, `effort_change`, `custom`, `label`, `session_info` — the
		// five the product's own context builder turns into no message.
		bookkeeping += 1;
	}

	// **Both halves of an unpaired tool call go.** A user turn's results travel
	// as their own messages, and the result blocks carry no names — the call's
	// name is copied onto them first, then the pairing is repaired, which is the
	// same order and the same two repairs the Claude Code reader applies.
	//
	// The entry list is the **repaired** stream, not the pre-repair sequence:
	// the repair can drop a whole message (an unpaired result, or an assistant
	// turn left with nothing to say), and laying the survivors back over the
	// pre-repair slots would shift every entry after the drop — one turn's words
	// attributed to another, and an entry with no message at all at the end.
	// The compaction marks keep their place as indices into the message stream;
	// if the repair dropped anything, the marks move to the end rather than land
	// mid-stream (the same trade the dsh and ZCode readers make).
	const repaired = repairToolPairing(rewriteToolNames(collected));
	let entries: CommandCodeEntry[] = repaired.messages.map((message) => ({ kind: "message" as const, message }));
	if (marks.length > 0) {
		if (repaired.dropped === 0) {
			for (const mark of [...marks].sort((a, b) => b.after - a.after)) {
				entries.splice(Math.min(mark.after, entries.length), 0, mark.entry);
			}
		} else {
			entries = [...entries, ...marks.map((mark) => mark.entry)];
		}
	}

	if (malformed > 0) bump("line that is not a version 3 entry", malformed);
	if (injected > 0) {
		bump(
			"user message the product injects rather than shows — `meta.isMeta`, or a custom message not marked `display: true`",
			injected,
		);
	}
	if (offPath > 0) {
		bump(
			"entry on a branch the session left — the file keeps every branch, and only the path ending at the newest entry was imported",
			offPath,
		);
	}
	if (bookkeeping > 0) {
		bump(
			"bookkeeping entry — a model or effort change, a label, a session name or custom data rather than a message",
			bookkeeping,
		);
	}
	if (repaired.dropped > 0) bump("unpaired tool call or result", repaired.dropped);
	return { entries, notes: [...counts].map(([reason, count]) => ({ reason, count })) };
}

/**
 * The active branch: start at the last entry, follow `parentId` up, reverse.
 *
 * Verbatim in behaviour from the bundle's `buildSessionPath`: the `Set` is the
 * cycle guard (a corrupted file can point a parent at its own descendant, and
 * the product's own walk stops rather than spinning), a `parentId` that names
 * no entry ends the walk, and the leaf defaults to the **last entry in the
 * file** because that is the newest thing that happened.
 */
function activeEntryPath(
	all: Array<Record<string, unknown>>,
	byId: Map<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
	if (all.length === 0) return [];
	const out: Array<Record<string, unknown>> = [];
	const seen = new Set<string>();
	let node: Record<string, unknown> | undefined = byId.get(asText(all[all.length - 1].id));
	while (node !== undefined && !seen.has(asText(node.id))) {
		seen.add(asText(node.id));
		out.push(node);
		node = node.parentId === null ? undefined : byId.get(asText(node.parentId));
	}
	out.reverse();
	return out;
}

/**
 * One user entry's blocks: prose as a user message, results as their own
 * messages, in the order the Claude Code reader uses for the same shapes —
 * text first, because a user turn that also carries results is the model's
 * prompt read back, and those results answer calls made before it.
 */
function commandCodeUserTurn(
	content: unknown[],
	timestamp: number,
	send: (message: AgentMessage) => void,
	bump: (reason: string, by?: number) => void,
): void {
	const prose: UserContent[] = [];
	const results: AgentMessage[] = [];
	for (const raw of content) {
		const block = isRecord(raw) ? raw : null;
		if (block === null) {
			bump("content block that is not an object");
			continue;
		}
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) prose.push(textContent(text));
			continue;
		}
		if (block.type === "image") {
			const image = commandCodeImageBlock(block);
			if (image !== null) prose.push(image);
			else
				bump(
					"image that is not base64 with a mime type — this build's message model carries image bytes, not a reference",
				);
			continue;
		}
		if (block.type === "tool_result") {
			const toolCallId = asText(block.tool_use_id);
			if (toolCallId === "") {
				bump("tool result with no `tool_use_id`, which is the one field it cannot be matched without");
				continue;
			}
			// Not a failure when the name is missing: the call's own block, earlier
			// in the path, fills it in, and an unpaired result is dropped by the
			// repair either way.
			results.push(
				toolResultMessage(
					toolCallId,
					UNKNOWN_TOOL_NAME,
					commandCodeResultContent(block.content),
					block.is_error === true,
					timestamp,
				),
			);
			continue;
		}
		bump(`content block of type \`${String(block.type)}\` in a user message, which has no counterpart here`);
	}
	if (prose.length > 0) send(userMessage(prose, timestamp));
	for (const result of results) send(result);
}

/**
 * One assistant entry's blocks.
 *
 * `thinking` keeps its Anthropic `signature` verbatim: a replay that drops it
 * is one the provider rejects, which is the same reason the Codewhale reader
 * keeps it.
 */
function commandCodeAssistantBlocks(
	content: unknown[],
	bump: (reason: string, by?: number) => void,
): AssistantContent[] {
	const blocks: AssistantContent[] = [];
	for (const raw of content) {
		const block = isRecord(raw) ? raw : null;
		if (block === null) {
			bump("content block that is not an object");
			continue;
		}
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) blocks.push(textContent(text));
			continue;
		}
		if (block.type === "thinking") {
			const thinking = asText(block.thinking);
			if (!thinking) continue;
			const signature = typeof block.signature === "string" ? block.signature : undefined;
			blocks.push({ type: "thinking", thinking, ...(signature === undefined ? {} : { signature }) });
			continue;
		}
		if (block.type === "tool_use") {
			const id = asText(block.id);
			const name = asText(block.name);
			if (id === "" || name === "") {
				bump("tool call without both an id and a name, which this build's tool-call shape requires");
				continue;
			}
			blocks.push({ type: "toolCall", id, name, arguments: JSON.stringify(block.input ?? {}) });
			continue;
		}
		bump(`content block of type \`${String(block.type)}\` in an assistant message, which has no counterpart here`);
	}
	return blocks;
}

/** A `custom_message` entry's content — a string or a block array — as user blocks. */
function commandCodeCustomMessageBlocks(content: unknown, bump: (reason: string, by?: number) => void): UserContent[] {
	const raw = typeof content === "string" ? [{ type: "text", text: content }] : content;
	if (!Array.isArray(raw)) return [];
	const blocks: UserContent[] = [];
	for (const entry of raw) {
		const block = isRecord(entry) ? entry : null;
		if (block === null) {
			bump("content block that is not an object");
			continue;
		}
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) blocks.push(textContent(text));
			continue;
		}
		if (block.type === "image") {
			const image = commandCodeImageBlock(block);
			if (image !== null) blocks.push(image);
			else
				bump(
					"image that is not base64 with a mime type — this build's message model carries image bytes, not a reference",
				);
			continue;
		}
		bump(`content block of type \`${String(block.type)}\` in a custom message, which has no counterpart here`);
	}
	return blocks;
}

/**
 * An Anthropic `image` block as this build's image content.
 *
 * `source.type === "base64"` is the only form that can be carried: a `url`
 * source is a reference to bytes this build's message model does not fetch at
 * resume time, so it is reported by the caller rather than resolved.
 */
function commandCodeImageBlock(block: Record<string, unknown>): ImageContent | null {
	const source = isRecord(block.source) ? block.source : null;
	if (source === null || source.type !== "base64") return null;
	const data = asText(source.data);
	const mimeType = asText(source.media_type);
	if (!data || !mimeType) return null;
	return { type: "image", mimeType, data };
}

/**
 * A tool result's content: a string, or blocks of text and images.
 *
 * A result with nothing in it gets "(no output recorded)", because an empty
 * text block is rejected by the messages API and a source records a failed
 * call as exactly that — the same placeholder, for the same reason, as the
 * Claude Code reader.
 */
function commandCodeResultContent(content: unknown): ToolResultContent[] {
	if (typeof content === "string") return commandCodeResultText(content);
	if (!Array.isArray(content)) return commandCodeResultText("");
	const out: ToolResultContent[] = [];
	for (const raw of content) {
		const block = isRecord(raw) ? raw : null;
		if (block === null) continue;
		if (block.type === "text") {
			const text = asText(block.text);
			if (text) out.push(textContent(text));
			continue;
		}
		if (block.type === "image") {
			const image = commandCodeImageBlock(block);
			if (image !== null) out.push(image);
		}
	}
	return out.length > 0 ? out : commandCodeResultText("");
}

function commandCodeResultText(text: string): ToolResultContent[] {
	return [textContent(text || "(no output recorded)")];
}

/** Stand-in for a tool name a result block does not carry; replaced from the call that owns it. */
const UNKNOWN_TOOL_NAME = "unknown";

/** Copy each call's name onto the results that answer it — the Claude Code reader's repair, over these shapes. */
function rewriteToolNames(messages: AgentMessage[]): AgentMessage[] {
	const names = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") names.set(block.id, block.name);
	}
	return messages.map((message) => {
		if (message.role !== "toolResult" || message.toolName !== UNKNOWN_TOOL_NAME) return message;
		const name = names.get(message.toolCallId);
		return name ? { ...message, toolName: name } : message;
	});
}

/**
 * The entry's own `usage`, in this build's fields.
 *
 * The product persists `{ inputTokens, outputTokens, cacheReadTokens,
 * cacheWriteTokens, … }` (`toSessionUsage` in the bundle), so the numbers are
 * carried rather than estimated; a turn with no recorded usage reads as zeros,
 * which is the same convention the Claude Code reader uses.
 */
function commandCodeUsage(value: unknown): Usage {
	const usage = isRecord(value) ? value : {};
	return {
		input: Number(usage.inputTokens ?? 0) || 0,
		output: Number(usage.outputTokens ?? 0) || 0,
		cacheRead: Number(usage.cacheReadTokens ?? 0) || 0,
		cacheWrite: Number(usage.cacheWriteTokens ?? 0) || 0,
	} satisfies Usage;
}

/** An entry's timestamp, or the session's start when the string does not parse. */
function entryTimestamp(entry: Record<string, unknown>, startedAt: number): number {
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : startedAt;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : "";
}
