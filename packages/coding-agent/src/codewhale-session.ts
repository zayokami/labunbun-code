/**
 * Codewhale session transcripts (`<sessions dir>/<id>.json`, one per session).
 *
 * **Codewhale is one of the few sources here whose history is archivable from
 * its own bytes**, and the reason is a single field. `SessionMetadata.workspace`
 * is a `PathBuf` with the serde name `workspace`
 * (`crates/tui/src/session_manager.rs:342-343`), so every transcript records the
 * directory it ran in — which is the fact a scope filter needs and the fact most
 * sources either lack or have to substitute. It is **nested under `metadata`**,
 * not top level, and the on-disk fixture confirms it:
 * `crates/tui/tests/fixtures/work_graph_session_v1_reader.json:12` reads
 * `"workspace": "/tmp/codewhale-wg2-old-reader"`.
 *
 * ## The envelope
 *
 * The struct that is serialized is `SavedSession`, not `SessionMetadata` —
 * `crates/tui/src/session_manager.rs:1025-1070`:
 *
 * ```rust
 * pub struct SavedSession {
 *     #[serde(default = "default_session_schema_version")] pub schema_version: u32,
 *     pub metadata: SessionMetadata,
 *     pub messages: Vec<Message>,                       // :1034
 *     #[serde(default, skip_serializing_if = "Option::is_none")] pub journal: Option<SessionJournal>,
 *     #[serde(default, skip_serializing_if = "Option::is_none")] pub leaf_id: Option<String>,
 *     pub system_prompt: Option<String>,                // :1040 — no skip, so the key is always there
 *     … work_state, artifacts, approval_receipts, context_references …
 * }
 * ```
 *
 * **`messages` is what to read, and it is worth saying why against a plausible
 * reading of the code.** `compact_for_persistence_queue` (`:1076-1080`) empties
 * `messages` when a journal is present, which reads at first like "the array on
 * disk is empty for modern sessions". It is not: the doc comment on the same
 * method says it drops the projection "before an async persistence request takes
 * ownership. **Disk serialization restores it**", and the disk serializer is
 * `serialize_saved_session` (`:1254-1258`), which runs `make_storage_compatible`
 * first. `make_storage_compatible` (`:1096-1104`) rehydrates `messages` from the
 * journal when the array is empty, and the module states the consequence at
 * `:3944-3950`: "every serialization path rehydrates the projection … so **the
 * on-disk bytes are identical to the filled form**." Reading `messages` is
 * therefore correct and reading `journal` would be a second implementation of a
 * tree this reader has no reason to walk.
 *
 * ## The message shape
 *
 * `Message` is `crates/protocol/src/request.rs:110-115`:
 *
 * ```rust
 * pub struct Message { pub role: Role, pub content: Vec<ContentBlock> }
 * ```
 *
 * with `Role` a closed enum (`crates/protocol/src/role.rs:33-51`) of `user`,
 * `assistant`, `system`, `developer`, `assistant_interrupted`, and
 * `Unrecognized(String)`, and `ContentBlock` an internally tagged enum keyed on
 * `type` (`crates/protocol/src/request.rs:137-198`) whose persisted variants are
 * `text`, `image_url`, `thinking`, `tool_use`, `tool_result`, `server_tool_use`
 * and `tool_search_tool_result`.
 *
 * **The one thing that is genuinely a translation, and the reason it is safe:**
 * Codewhale has no `tool` role. A tool result is a `Message` with
 * `role: Role::User` whose content is `[ContentBlock::ToolResult]`
 * (`crates/tui/src/session_manager.rs:6352-6360` is the product building one),
 * where this build's message model wants a distinct `toolResult` role. So the
 * conversion splits a user message into its tool results and whatever prose came
 * with them. **A `ToolResult` block carries no tool name** — only
 * `tool_use_id` — so the name is recovered from the matching `tool_use` block
 * earlier in the same transcript, and an unmatched one is reported rather than
 * guessed.
 *
 * Nothing else needs translating: `text`, `thinking` (with its Anthropic
 * `signature`) and `tool_use` all have a direct counterpart, and
 * `assistant_interrupted` maps onto this build's `stopReason: "aborted"` — the
 * product keeps that role distinct for exactly that reason
 * (`crates/protocol/src/role.rs:44-46`: "Kept distinct from `Role::Assistant` so
 * replay can mark it as incomplete").
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import {
	type AgentMessage,
	type AssistantContent,
	assistantMessage,
	type ImageContent,
	repairToolPairing,
	type ToolResultContent,
	textContent,
	toolResultMessage,
	type UserContent,
	userMessage,
} from "@labunbun/ai";
import {
	type CodewhaleEnv,
	codewhaleSessionPath,
	codewhaleSessionsDir,
	resolveCodewhaleHome,
} from "./codewhale-home.ts";
import { isRecord } from "./migrate-core.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One session worth offering: envelope read, directory and title located. */
export interface CodewhaleSessionFile {
	path: string;
	/** The file's own stem, which is the id Codewhale resumes the session by. */
	id: string;
	/** `metadata.workspace` when it names a directory, `null` when it states none. */
	cwd: string | null;
	/** `metadata.title` — the name, not a `name` field; see the header. */
	title: string | null;
	/** `metadata.created_at` in epoch ms, 0 when the file states none it can parse. */
	startedAt: number;
	/** `metadata.model`, kept for the report and not written anywhere. */
	model: string | null;
}

export interface CodewhaleListing {
	sessions: CodewhaleSessionFile[];
	skipped: Array<{ name: string; reason: string }>;
}

export type CodewhaleEntry =
	| { kind: "message"; message: AgentMessage }
	| { kind: "compaction"; summary: string; preTokens: number };

export interface CodewhaleRead {
	entries: CodewhaleEntry[];
	notes: Array<{ reason: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * How much of a session file the listing reads to find its `metadata`.
 *
 * `serde_json::to_string_pretty` is the serializer (`session_manager.rs:1257`), so
 * a session file is indented and `metadata` opens within the first few hundred
 * bytes — but a session with a long `runtime_store` binding or a large
 * `mode` string can push it, and this is a **bounded** read precisely so a home
 * with a hundred sessions costs a hundred bounded reads rather than a hundred
 * conversations. {@link codewhaleMetadata} brace-matches rather than line-slicing,
 * so a head window that stops inside `metadata` is reported instead of parsed as
 * a truncated document.
 */
const LISTING_HEAD_BYTES = 256 * 1024;

/**
 * The `"metadata"` object out of the head of a session file, brace-matched.
 *
 * **Brace-matching over a string scan rather than `JSON.parse` on a slice**, for
 * a reason that is about correctness rather than style: a session file is
 * pretty-printed, `metadata` is a nested object, and any line-based or
 * brace-count-ignoring-strings approach gets it wrong on a `workspace` path
 * containing a brace. Strings are skipped here, so a `{` inside a path is not a
 * nesting level.
 *
 * Returns `null` when the key is absent, when the window closed before the object
 * did, or when the object does not parse — three different states the caller
 * reports with three different sentences.
 */
export function codewhaleMetadata(head: string): Record<string, unknown> | null {
	const key = head.indexOf('"metadata"');
	if (key < 0) return null;
	const colon = head.indexOf(":", key + '"metadata"'.length);
	if (colon < 0) return null;
	const open = head.indexOf("{", colon);
	if (open < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = open; index < head.length; index += 1) {
		const char = head[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					const parsed: unknown = JSON.parse(head.slice(open, index + 1));
					return isRecord(parsed) ? parsed : null;
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/**
 * Every session Codewhale's own session manager would show.
 *
 * The directory comes from `codewhaleSessionsDir`, which is one of the two roots
 * — a home whose sessions were never migrated keeps them at
 * `~/.deepseek/sessions`, and `ensure_state_dir`
 * (`crates/config/src/lib.rs:6177-6186`) relocates them on the product's next
 * first write. **Both are read; they are never merged**, because the product
 * resolves one directory and reads the other out of existence.
 *
 * Every file that arrives here without becoming a session carries the reason, and
 * the order is the filesystem's name order so two runs over one home report the
 * same thing.
 */
export function listCodewhaleSessions(home: string, env: CodewhaleEnv = process.env): CodewhaleListing {
	const dir = codewhaleSessionsDir(resolveCodewhaleHome(home, env));
	const sessions: CodewhaleSessionFile[] = [];
	const skipped: CodewhaleListing["skipped"] = [];
	for (const id of codewhaleSessionIds(dir)) {
		const path = codewhaleSessionPath(dir, id);
		const head = readHead(path);
		if (head === null) {
			skipped.push({ name: path, reason: "unreadable" });
			continue;
		}
		const metadata = codewhaleMetadata(head);
		if (metadata === null) {
			skipped.push({
				name: path,
				reason:
					"no readable `metadata` object in the first 256 KB — the envelope is `{ schema_version, metadata, messages, … }` and metadata opens second, so this is a file whose shape is not one Codewhale writes",
			});
			continue;
		}
		const title = typeof metadata.title === "string" ? metadata.title : null;
		sessions.push({
			path,
			id,
			cwd: typeof metadata.workspace === "string" && metadata.workspace !== "" ? metadata.workspace : null,
			title,
			startedAt: parseCodewhaleTimestamp(metadata.created_at),
			model: typeof metadata.model === "string" ? metadata.model : null,
		});
	}
	return { sessions, skipped };
}

/**
 * The `<id>` of every `<id>.json` in the directory, name-sorted.
 *
 * An absent or unreadable directory contributes none, which is the ordinary
 * state of a home that has never had a session and not a failure. The `<id>.lock`
 * sidecar (`session_manager.rs:1748-1749`) and the `session_boot_owners.json`
 * index (`:2325`) live in the same directory and are filtered out by the
 * extension — the index is a `.json` that is **not** a session, and it is skipped
 * below by shape rather than by name so a future sidecar is skipped too.
 */
function codewhaleSessionIds(dir: string): string[] {
	return readdirSyncSafe(dir)
		.filter((name) => name.toLowerCase().endsWith(".json"))
		.map((name) => name.slice(0, -".json".length))
		.filter((id) => id !== "session_boot_owners");
}

/**
 * The first `maxBytes` of a file, or `null` when it could not be opened.
 *
 * Opened and read rather than `readFileSync`-then-slice, because the whole point
 * of the bound is not to pay for the conversation.
 */
function readHead(path: string, maxBytes = LISTING_HEAD_BYTES): string | null {
	try {
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(maxBytes);
			const read = readSync(fd, buffer, 0, maxBytes, 0);
			return buffer.toString("utf8", 0, read);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/**
 * `metadata.created_at` in epoch ms.
 *
 * It is a `DateTime<Utc>` (`session_manager.rs:325-326`), which serde writes as
 * **RFC 3339** — `"2026-07-18T00:00:00Z"`. `Date.parse` reads that. Anything it
 * cannot read is epoch 0, which keeps such a session at the **end** of the
 * per-source limit rather than the front: the selection sorts descending by
 * `startedAt`, so an unreadable timestamp loses to a readable one, and a session
 * with no date is the least likely to be the one the user wanted.
 */
export function parseCodewhaleTimestamp(value: unknown): number {
	if (typeof value !== "string") return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Convert one Codewhale session into this build's transcript shape.
 *
 * **The whole file is read here** — this is the expensive phase, and
 * `migrate-history.ts` only calls it for the sessions the user chose. The
 * listing above already decided that the envelope is real; a file that went away
 * or turned unreadable in between is reported, not reconstructed.
 */
export function readCodewhaleSession(session: CodewhaleSessionFile): CodewhaleRead | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(session.path, "utf8"));
	} catch {
		return { error: "session transcript that could not be read" };
	}
	if (!isRecord(parsed)) return { error: "session transcript that is not a JSON object" };
	const rawMessages = parsed.messages;
	if (!Array.isArray(rawMessages)) {
		return {
			error:
				"session transcript with no `messages` array — the envelope's third key, and the one the messages come from",
		};
	}

	const counts = new Map<string, number>();
	const bump = (reason: string): void => {
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	};
	const collected: AgentMessage[] = [];
	// `tool_use_id` → `name`, so a tool result can be labelled with the tool it
	// answered. Filled on the way through, which is why the conversion is one
	// pass: a result always follows its call in a linear transcript.
	const toolNames = new Map<string, string>();

	for (const raw of rawMessages) {
		if (!isRecord(raw)) {
			bump("message that is not an object");
			continue;
		}
		const role = typeof raw.role === "string" ? raw.role : "";
		const content = Array.isArray(raw.content) ? raw.content : [];
		if (content.length === 0) {
			bump("message with no content blocks");
			continue;
		}
		if (role === "user") {
			const prose: UserContent[] = [];
			for (const block of content) {
				const result = codewhaleToolResult(block, toolNames, bump);
				if (result !== null) {
					collected.push(result);
					continue;
				}
				const mapped = codewhaleUserBlock(block, bump);
				if (mapped !== null) prose.push(mapped);
			}
			// **A user message that was only tool results produces no prose**, and
			// that is correct rather than a loss: the results have already been
			// emitted as their own messages, which is where this build keeps them.
			if (prose.length > 0) collected.push(userMessage(prose));
			continue;
		}
		if (role === "assistant" || role === "assistant_interrupted") {
			// **One assistant message with every block, not one per block.** A
			// Codewhale assistant turn is a single `Message` holding parallel tool
			// calls alongside its prose, and splitting it would put a tool call and
			// the text that introduced it in different messages — which is a
			// different conversation, not a different encoding of this one.
			const blocks: AssistantContent[] = [];
			let sawToolCall = false;
			for (const block of content) {
				const call = codewhaleToolUse(block, toolNames, bump);
				if (call !== null) {
					blocks.push(call);
					sawToolCall = true;
					continue;
				}
				const mapped = codewhaleAssistantBlock(block, bump);
				if (mapped !== null) blocks.push(mapped);
			}
			if (blocks.length === 0) {
				bump("assistant message whose blocks were all dropped");
				continue;
			}
			collected.push(
				assistantMessage({
					content: blocks,
					// `assistant_interrupted` is the product's own marker for text that
					// was visible before a turn was cut off, kept distinct for exactly
					// this purpose (`protocol/src/role.rs:44-46`). Anything else ended
					// the turn, and `toolUse` is the honest stop reason when a call is
					// in the turn.
					stopReason: role === "assistant_interrupted" ? "aborted" : sawToolCall ? "toolUse" : "stop",
				}),
			);
			continue;
		}
		if (role === "") {
			bump("message with no role");
			continue;
		}
		// `system` and `developer` are load-bearing *history* in Codewhale
		// (`crates/protocol/src/role.rs:41-43`) but this build has no role for
		// them mid-conversation — a system prompt belongs at the top of the file —
		// so they are counted rather than moved to a place that would change what
		// they mean.
		bump(`\`${role}\` message, which this build has no role for mid-conversation`);
	}

	// **Both halves of an unpaired tool call go.** `repairToolPairing` is the
	// shared repair and the reason it is the right one: a transcript that half-pairs
	// a call would be rejected by the messages API on the first `--continue`, which
	// is worse than a shorter transcript.
	const repaired = repairToolPairing(collected);
	if (repaired.dropped > 0) {
		counts.set(
			"tool call or result whose other half was not in the transcript — both were dropped, because a half-paired call is one the messages API rejects",
			(counts.get(
				"tool call or result whose other half was not in the transcript — both were dropped, because a half-paired call is one the messages API rejects",
			) ?? 0) + repaired.dropped,
		);
	}
	return {
		entries: repaired.messages.map((message) => ({ kind: "message" as const, message })),
		notes: [...counts].map(([reason, count]) => ({ reason, count })),
	};
}

/**
 * One `tool_result` block as a {@link toolResultMessage}, or `null` when the
 * block is something else.
 *
 * **`content_blocks` wins over `content` when it carries an image.**
 * `ContentBlock::ToolResult` has both (`crates/protocol/src/request.rs:180-191`):
 * `content: String` is the text rendering and `content_blocks: Option<Vec<Value>>`
 * is the rich one, and the product's own tool writes an image there —
 * `crates/tui/src/tools/read_media.rs:1504-1516` puts
 * `{"type":"image","mime_type":…,"data":…}` in it. An imported transcript that
 * kept only the text rendering would lose the picture a `read_media` call
 * returned, which is the whole point of having made the call.
 */
function codewhaleToolResult(
	block: unknown,
	toolNames: Map<string, string>,
	bump: (reason: string) => void,
): AgentMessage | null {
	if (!isRecord(block) || block.type !== "tool_result") return null;
	const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
	if (id === "") {
		bump("tool result with no `tool_use_id`, which is the one field it cannot be matched without");
		return null;
	}
	const name = toolNames.get(id);
	if (name === undefined) {
		// Not a failure: `repairToolPairing` will drop this result anyway if its
		// call is missing, and reporting it here would say the same thing twice.
		bump("tool result whose call is not in this transcript");
	}
	const content: ToolResultContent[] = [];
	const rich = block.content_blocks;
	if (Array.isArray(rich)) {
		for (const entry of rich) {
			const image = codewhaleImageBlock(entry);
			if (image !== null) content.push(image);
		}
	}
	if (content.length === 0 && typeof block.content === "string" && block.content !== "") {
		content.push(textContent(block.content));
	}
	if (content.length === 0) {
		bump("tool result with neither text nor an image in it");
		return null;
	}
	return toolResultMessage(id, name ?? "", content, block.is_error === true);
}

/** One `tool_use` block as this build's `toolCall`, recording the id → name. */
function codewhaleToolUse(
	block: unknown,
	toolNames: Map<string, string>,
	bump: (reason: string) => void,
): AssistantContent | null {
	if (!isRecord(block) || block.type !== "tool_use") return null;
	const id = typeof block.id === "string" ? block.id : "";
	const name = typeof block.name === "string" ? block.name : "";
	if (id === "" || name === "") {
		bump("tool call without both an id and a name, which this build's tool-call shape requires");
		return null;
	}
	toolNames.set(id, name);
	// `input` is a `serde_json::Value` (`protocol/src/request.rs:163-165`) and this
	// build's `ToolCall.arguments` is raw JSON text (`packages/ai/src/types.ts:38`),
	// so it is stringified rather than carried as a parsed object. A non-object
	// input is stringified too: the argument text is what a tool receives, and
	// inventing an object around a scalar would change what runs.
	const input = block.input;
	return {
		type: "toolCall",
		id,
		name,
		arguments: typeof input === "string" ? input : JSON.stringify(input ?? null),
	};
}

/** A `text` or `image_url` block in a user message. */
function codewhaleUserBlock(block: unknown, bump: (reason: string) => void): UserContent | null {
	if (!isRecord(block)) {
		bump("content block that is not an object");
		return null;
	}
	if (block.type === "text" && typeof block.text === "string") return textContent(block.text);
	if (block.type === "image_url") {
		const image = codewhaleImageUrl(block.image_url);
		if (image !== null) return image;
		bump("image that is not a data: URL — this build's message model carries image bytes, not a remote address");
		return null;
	}
	bump(`content block of type \`${String(block.type)}\`, which has no counterpart in a user message here`);
	return null;
}

/** A `text` or `thinking` block in an assistant message. */
function codewhaleAssistantBlock(block: unknown, bump: (reason: string) => void): AssistantContent | null {
	if (!isRecord(block)) {
		bump("content block that is not an object");
		return null;
	}
	if (block.type === "text" && typeof block.text === "string") return textContent(block.text);
	if (block.type === "thinking" && typeof block.thinking === "string") {
		// `signature` is the Anthropic proof that the thinking block came from the
		// provider (`protocol/src/request.rs:150-155`) and it carries across
		// verbatim: a replay that drops it is one Anthropic rejects.
		const signature = typeof block.signature === "string" ? block.signature : undefined;
		return { type: "thinking", thinking: block.thinking, ...(signature === undefined ? {} : { signature }) };
	}
	bump(`content block of type \`${String(block.type)}\`, which has no counterpart in an assistant message here`);
	return null;
}

/**
 * The `image_url` block as a `data:` URL's bytes.
 *
 * `ImageUrlContent` is `{ url: String }` (`protocol/src/request.rs:100-103`) — a
 * **URL**, not bytes — so only the `data:` form can be carried and only when it
 * names a MIME type this build's schema accepts. Anything else is reported by the
 * caller, which is the right outcome: a remote image URL in a transcript is not
 * something an imported session should fetch at resume time.
 */
function codewhaleImageUrl(value: unknown): ImageContent | null {
	if (!isRecord(value) || typeof value.url !== "string") return null;
	const match = value.url.match(/^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s);
	if (match === null) return null;
	return { type: "image", mimeType: match[1], data: match[2] };
}

/** One entry of a `content_blocks` rich result, when it is an image. */
function codewhaleImageBlock(value: unknown): ImageContent | null {
	if (!isRecord(value) || value.type !== "image") return null;
	if (typeof value.mime_type !== "string" || typeof value.data !== "string") return null;
	return { type: "image", mimeType: value.mime_type, data: value.data };
}

/** `readdirSync` that contributes nothing when the directory is absent or unreadable. */
function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}
