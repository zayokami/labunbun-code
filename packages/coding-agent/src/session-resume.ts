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

export function formatSessionList(sessions: SessionSummary[]): string {
	if (sessions.length === 0) return "No saved sessions for this project.";
	return sessions
		.slice(0, 10)
		.map((s, i) => `${i + 1}. ${new Date(s.mtimeMs).toLocaleString()}  (${s.messageCount} msgs)\n   ${s.firstUserText}`)
		.join("\n");
}
