/**
 * A short preview of a saved session, shown in the `/resume` picker.
 *
 * The picker's rows are built from the head of each transcript, because that
 * is where the first user message is. A preview wants the opposite end: the
 * part of the conversation the user would be returning to. Reading the whole
 * file for a panel that shows a dozen lines would make a long-session project
 * pay its largest file every time the highlight moves, so this reads a bounded
 * tail and walks the parent chain from the last entry.
 *
 * Everything here is best-effort. A preview is not the session: a file this
 * module cannot read is "no preview", never an error in the picker.
 */
import { open } from "node:fs/promises";
import { parseSessionLine, type SessionEntry } from "@labunbun/agent";
import type { PickerPreview } from "@labunbun/tui";
import { readSessionTitle } from "./session-title.ts";

/** How much of the transcript's tail a preview may read. */
export const PREVIEW_TAIL_BYTES = 128 * 1024;
/** How many of the most recent messages the panel shows. */
export const PREVIEW_MAX_MESSAGES = 6;
/** The line cap across all of those messages. */
export const PREVIEW_MAX_LINES = 12;
/** Longest line kept, by code point. Longer text is cut, not wrapped into more rows. */
export const PREVIEW_LINE_CHARS = 240;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching raw escape sequences is the purpose of this line
const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[ -/]*[@-~])/g;

/**
 * Collapse a message into one safe line: no escapes, no control characters,
 * one space wherever whitespace was, and a hard cap. The panel is a summary,
 * and a multi-paragraph message that pushed the other five messages off the
 * panel would be the wrong summary.
 */
function previewLine(text: string): string {
	const clean = text
		.replace(ANSI_PATTERN, "")
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const characters = Array.from(clean);
	return characters.length > PREVIEW_LINE_CHARS ? `${characters.slice(0, PREVIEW_LINE_CHARS - 1).join("")}…` : clean;
}

/** The text a user message carries, ignoring images. */
function userText(message: Extract<SessionEntry, { type: "message" }>["message"]): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(" ");
}

/**
 * One argument from a tool call, short enough to sit on a preview row.
 *
 * The arguments are raw JSON text that may be incomplete. The named keys come
 * first because they are the ones a person recognizes at a glance — a path, a
 * command — and an unknown tool still gets its first string argument rather
 * than a row that says only its name.
 */
function toolCallSummary(raw: string): string {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return raw;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return raw;
	const record = value as Record<string, unknown>;
	for (const key of ["file_path", "path", "command", "pattern", "query", "url", "description"]) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	for (const candidate of Object.values(record)) {
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return "";
}

/** What one chain entry contributes to the panel. Compactions and tool results contribute nothing. */
function renderedLines(entry: SessionEntry): string[] {
	if (entry.type !== "message") return [];
	const message = entry.message;
	if (message.role === "user") {
		const text = userText(message).trim();
		return text ? [previewLine(`You: ${text}`)] : [];
	}
	if (message.role !== "assistant") return [];
	const out: string[] = [];
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(" ")
		.trim();
	if (text) out.push(previewLine(`Assistant: ${text}`));
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const summary = previewLine(toolCallSummary(block.arguments));
		out.push(previewLine(`→ ${block.name}${summary ? ` ${summary}` : ""}`));
	}
	return out;
}

/** The entries on the active chain, oldest first, from a tail of the file. */
function activeChain(lines: string[], startsMidLine: boolean): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const line of startsMidLine ? lines.slice(1) : lines) {
		const entry = parseSessionLine(line);
		if (entry) entries.push(entry);
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const chain: SessionEntry[] = [];
	const seen = new Set<string>();
	let cursor: SessionEntry | undefined = entries[entries.length - 1];
	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		chain.push(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	return chain.reverse();
}

/**
 * The preview for one session file, or null when it cannot be read at all —
 * a missing file, a permission error. A readable file with nothing to show
 * comes back with empty lines, which the panel reports as such.
 */
export async function readSessionPreview(path: string): Promise<PickerPreview | null> {
	let text: string;
	let startsMidLine: boolean;
	let truncated: boolean;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
		const { size } = await handle.stat();
		const start = Math.max(0, size - PREVIEW_TAIL_BYTES);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		let filled = 0;
		while (filled < length) {
			const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
			if (bytesRead === 0) break;
			filled += bytesRead;
		}
		// Whether the first byte is the start of a line. A tail read usually
		// begins mid-line, and that fragment is not an entry — but when the byte
		// before it is a newline the whole first line was read, and dropping it
		// would lose a message that is really there.
		startsMidLine = false;
		if (start > 0) {
			const probe = Buffer.alloc(1);
			const { bytesRead } = await handle.read(probe, 0, 1, start - 1);
			startsMidLine = bytesRead > 0 && probe[0] !== 0x0a;
		}
		text = buffer.subarray(0, filled).toString("utf8");
		truncated = start > 0;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}

	const chain = activeChain(text.split("\n"), startsMidLine);
	// Only messages a reader would recognize as the conversation: compactions
	// are a boundary and a summary, and a tool result is the program's answer,
	// not something either side said.
	const messages = chain.flatMap((entry) => {
		const lines = renderedLines(entry);
		return lines.length > 0 ? [lines] : [];
	});
	const shown = messages.slice(-PREVIEW_MAX_MESSAGES);
	const omittedMessages = messages.length - shown.length;
	let lines = shown.flat();
	const omittedLines = Math.max(0, lines.length - PREVIEW_MAX_LINES);
	if (omittedLines > 0) lines = lines.slice(-PREVIEW_MAX_LINES);

	const notices: string[] = [];
	if (omittedMessages > 0) {
		notices.push(`Showing the last ${shown.length} message${shown.length === 1 ? "" : "s"}.`);
	}
	if (omittedLines > 0) notices.push(`Showing the last ${PREVIEW_MAX_LINES} lines.`);
	if (truncated) notices.push("Earlier messages not loaded.");

	return {
		title: readSessionTitle(path),
		lines,
		notice: notices.length > 0 ? notices.join(" ") : undefined,
	};
}

/** How many previews the requester remembers. The picker's list is bounded by the project. */
const CACHE_LIMIT = 32;

/**
 * Debounces and caches preview reads for a picker whose highlight can move
 * faster than a disk read.
 *
 * The debounce is the point: holding ↓ would otherwise start one read per row
 * and race them all onto the screen. A superseded request resolves null rather
 * than never — the dialog awaits it, and a promise that settles never is a
 * panel stuck on "Loading" long after its row is gone.
 */
export function createPreviewRequester(options: { debounceMs?: number } = {}): {
	request(path: string): Promise<PickerPreview | null>;
	reset(): void;
} {
	const debounceMs = options.debounceMs ?? 120;
	const cache = new Map<string, PickerPreview | null>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let currentPath: string | undefined;
	let waiters: Array<(preview: PickerPreview | null) => void> = [];
	let generation = 0;

	const settle = (preview: PickerPreview | null): void => {
		const waiting = waiters;
		waiters = [];
		for (const resolve of waiting) resolve(preview);
	};

	return {
		request(path: string): Promise<PickerPreview | null> {
			if (cache.has(path)) return Promise.resolve(cache.get(path) ?? null);
			// A new row was asked for before the old one's timer fired: the caller
			// waiting on the old row is owed an answer now, not when a debounce for
			// a row nobody is looking at finally elapses.
			if (currentPath !== undefined && currentPath !== path) settle(null);
			currentPath = path;
			if (timer !== undefined) clearTimeout(timer);
			const own = ++generation;
			const answer = new Promise<PickerPreview | null>((resolve) => waiters.push(resolve));
			timer = setTimeout(async () => {
				timer = undefined;
				const preview = await readSessionPreview(path);
				// A newer request, or a reset, owns the panel now. Its read will
				// answer; this one's result is stale even if it arrived first.
				if (own !== generation || currentPath !== path) return;
				if (cache.size >= CACHE_LIMIT) {
					const oldest = cache.keys().next().value;
					if (oldest !== undefined) cache.delete(oldest);
				}
				cache.set(path, preview);
				settle(preview);
			}, debounceMs);
			return answer;
		},
		reset(): void {
			generation++;
			currentPath = undefined;
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			settle(null);
			cache.clear();
		},
	};
}
