/**
 * Session resume: list saved sessions for a project and rebuild an
 * AgentSession's message history from the JSONL tree.
 */
import { SessionStore } from "@labunbun/agent";
import type { AgentMessage } from "@labunbun/ai";

export interface SessionSummary {
	path: string;
	sessionId: string;
	mtimeMs: number;
	/** First user message — used as the picker label. */
	firstUserText: string;
	messageCount: number;
}

export function listSessions(cwd?: string, home?: string): SessionSummary[] {
	return SessionStore.listSessions(cwd, home).map((entry) => {
		const store = SessionStore.load(entry.path);
		const firstUser = store.messages().find((m) => m.role === "user");
		return {
			...entry,
			firstUserText: firstUser ? textOf(firstUser).slice(0, 80) : "(empty session)",
			messageCount: store.messages().length,
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
 */
export function loadSessionForResume(path: string): { store: SessionStore; messages: AgentMessage[] } | null {
	const store = SessionStore.load(path);
	if (!store.sessionId || store.entries.length === 0) return null;
	return { store, messages: store.messages() };
}

/**
 * The line printed after the TUI unmounts, telling the user how to come back to
 * this session. Null when there is nothing to come back to — a run that saved no
 * session, or one where no message was ever exchanged.
 */
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
		.map((s, i) => `${i + 1}. ${new Date(s.mtimeMs).toLocaleString()}  (${s.messageCount} msgs)\n   ${s.firstUserText}`)
		.join("\n");
}
