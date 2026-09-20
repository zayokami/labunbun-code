/**
 * Session resume: list saved sessions for a project and rebuild an
 * AgentSession's message history from the JSONL tree.
 */
import { SessionStore } from "@labunbun/agent";
import { type AgentMessage, repairToolPairing } from "@labunbun/ai";

export interface SessionSummary {
	path: string;
	sessionId: string;
	mtimeMs: number;
	/** First user message — used as the picker label. */
	firstUserText: string;
	messageCount: number;
	/**
	 * The file was longer than a label is worth reading, so `messageCount` is a
	 * lower bound: it counts the messages in the part that was read.
	 */
	truncated: boolean;
}

/**
 * How much of a session file a picker row may read.
 *
 * A label needs the first user message, which is at the top of the file. The
 * old price was the whole file: every entry parsed, with its tool output, for
 * every session in the project, twice over. This is enough for the label and
 * for the messages that share its head, and it is a bound — a project with one
 * enormous session no longer makes the list take as long as that session did.
 */
const LABEL_READ_LIMIT_BYTES = 256 * 1024;

export function listSessions(cwd?: string, home?: string): SessionSummary[] {
	return SessionStore.listSessions(cwd, home).map((entry) => {
		const store = SessionStore.load(entry.path, { maxBytes: LABEL_READ_LIMIT_BYTES });
		// Read once. Both the label and the count come from the same array, which
		// is the only way they can be about the same conversation.
		const messages = store.messages();
		const firstUser = messages.find((m) => m.role === "user");
		return {
			...entry,
			firstUserText: firstUser ? textOf(firstUser).slice(0, 80) : "(empty session)",
			messageCount: messages.length,
			truncated: store.truncated,
		};
	});
}

/**
 * The most recent saved session for a project — the target of `--continue`.
 * Null when nothing was ever saved; callers start fresh and say so.
 */
export function resolveContinueTarget(cwd?: string, home?: string): SessionSummary | null {
	return listSessions(cwd, home)[0] ?? null;
}

function textOf(message: AgentMessage): string {
	if (message.role === "user") return typeof message.content === "string" ? message.content : "[content blocks]";
	if (message.role === "assistant")
		return message.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
	return message.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
}

/**
 * Load a session file and return its linear messages plus a store positioned
 * at the active leaf so new appends continue (or branch from) that leaf.
 *
 * The messages are repaired before they are handed over. A session file can
 * lose a line — the append that was writing it ran out of disk, or the file was
 * edited by something that did not know the format — and the entry that is gone
 * may have been half of a tool call. The half that remains is a request the
 * provider rejects, which would turn a recoverable session into one that cannot
 * be resumed at all; dropping both halves costs one tool call and keeps the
 * rest of the conversation.
 *
 * `removed` is how many messages the repair took out of the transcript, so the
 * caller can say what the resumed conversation is missing rather than presenting
 * it as whole. It is a message count, where `repairToolPairing`'s own count is
 * of dropped blocks and emptied turns — the finer number is what a migration
 * report wants, and this one is what "your conversation is shorter" means.
 */
export function loadSessionForResume(
	path: string,
): { store: SessionStore; messages: AgentMessage[]; removed: number } | null {
	const store = SessionStore.load(path);
	if (!store.sessionId || store.entries.length === 0) return null;
	// The model-facing view: a compacted session resumes from its boundary. The
	// entries above it stay in the file for the record, not for the next request.
	const context = store.contextMessages();
	const repaired = repairToolPairing(context);
	return { store, messages: repaired.messages, removed: context.length - repaired.messages.length };
}

/**
 * One line about a session that came back shorter than the file it was written
 * to, or undefined when it came back whole.
 *
 * Silence here is the failure worth avoiding: the conversation looks like it
 * simply has less in it, and the person resuming has no way to tell a damaged
 * session from one they remember wrong.
 *
 * The two losses are named separately rather than added up. A damaged line is
 * an entry the file no longer holds, and a message removed with its tool call is
 * one this reader took out on purpose — possibly *because* of that same damaged
 * line, which would make one lost line read as two lost things. A count the user
 * cannot check is worse than two they can.
 */
export function damagedSessionNotice(store: SessionStore, removed: number): string | undefined {
	const losses: string[] = [];
	if (store.skippedLines > 0) {
		losses.push(`${store.skippedLines} damaged line${store.skippedLines === 1 ? "" : "s"}`);
	}
	if (removed > 0) {
		losses.push(`${removed} message${removed === 1 ? "" : "s"} removed with its tool call`);
	}
	if (losses.length === 0) return undefined;
	return `Session file damaged: ${losses.join(" and ")} (${store.path}). The rest of the conversation is intact.`;
}

/**
 * The line printed after the TUI unmounts, telling the user how to come back to
 * this session. Null when there is nothing to come back to — a run that saved no
 * session, or one where no message was ever exchanged.
 */
/** A message count as a picker row shows it: `12`, or `500+` when it is a floor. */
export function formatMessageCount(summary: Pick<SessionSummary, "messageCount" | "truncated">): string {
	return `${summary.messageCount}${summary.truncated ? "+" : ""}`;
}

export function exitSummaryLine(opts: { sessionId?: string; messageCount: number; cliName: string }): string | null {
	if (!opts.sessionId || opts.messageCount === 0) return null;
	// Eight characters is enough: resume matches by prefix, falling back to a
	// substring search (see the session lookup in interactive.ts).
	return `To resume: ${opts.cliName} --resume ${opts.sessionId.slice(0, 8)}`;
}

export function formatSessionList(sessions: SessionSummary[]): string {
	if (sessions.length === 0) return "No saved sessions for this project.";
	return sessions
		.slice(0, 10)
		.map(
			(s, i) =>
				`${i + 1}. ${new Date(s.mtimeMs).toLocaleString()}  (${formatMessageCount(s)} msgs)\n   ${s.firstUserText}`,
		)
		.join("\n");
}
