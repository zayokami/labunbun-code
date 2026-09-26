/**
 * System prompt builder. Static sections are byte-stable for prompt caching;
 * a DYNAMIC_BOUNDARY marker separates per-session dynamic content (P5 adds
 * git status etc.). Tool prompt contributions are appended by the caller.
 */
import { type AnyTool, localDayKey } from "@labunbun/agent";

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "SYSTEM_PROMPT_DYNAMIC_BOUNDARY";

export interface SystemPromptContext {
	cwd: string;
	platform: string;
	isTTY: boolean;
	/**
	 * The joined memory files (`loadMemoryFiles`): LABUNBUN.md / AGENTS.md walked
	 * from cwd to root, the user's own MEMORY.md, and rules.
	 *
	 * A section of the system prompt rather than a user message, for two reasons
	 * that both come down to the same one — the model has to keep seeing it:
	 * the system prompt is what the cache breakpoint covers (one cache write,
	 * then reads on every turn), and it is the part of a request that no
	 * compaction and no transcript edit can drop. Injected as a message it was
	 * present on the first request of a session and on none after it.
	 */
	memory?: string;
	/**
	 * The instant "Today's date" is read from. Defaults to now.
	 *
	 * Handed in rather than read from the ambient clock for two reasons, and the
	 * second is the one that keeps the first honest. A test that can pin the
	 * instant is the only kind worth writing here: the difference between the
	 * local civil day and the UTC day is zero for eight hours out of every
	 * twenty-four, so a test that asserts "the prompt carries the local date"
	 * *without* pinning the clock passes on a machine running UTC and fails on
	 * the same code four hours later — a test whose result is a function of the
	 * hour it runs. The default keeps both production call sites unchanged.
	 */
	now?: number;
}

export function buildSystemPrompt(tools: AnyTool[], ctx: SystemPromptContext): string {
	const sections: string[] = [];

	sections.push(`You are LaBunbun Code, an interactive CLI coding agent. You help the user with software engineering tasks: reading and understanding code, making edits, running commands, and fixing bugs.

# Attitude
You MUST answer the user's question directly, without padding, and to the point. Do not restate what was asked. Skip flattery like "great question". Be direct and technical.

# Doing tasks
- Explore before acting: read files before editing them; never guess content.
- Prefer the dedicated tools (Read/Edit/Write/Grep/Glob) over shell equivalents.
- Make focused, minimal changes that match the codebase's existing style.
- After changes, verify: run builds/tests when they exist.
- Do not commit unless explicitly asked.

# Communication
- Answer in the user's language.
- Reference code as path:line.
- Report outcomes faithfully: if a command failed, say so with its output.`);

	sections.push(`# Environment
- Working directory: ${ctx.cwd}
- Platform: ${ctx.platform}
- Is interactive terminal: ${ctx.isTTY}
- Today's date: ${localDayKey(ctx.now ?? Date.now())}`);

	sections.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

	const toolPrompts = tools.map((tool) => tool.prompt).filter((p): p is string => Boolean(p));
	if (toolPrompts.length > 0) {
		sections.push(`# Tool guidance\n${toolPrompts.join("\n")}`);
	}

	// Last, and after the boundary: this is the most specific instruction in the
	// prompt, so it is what the model reads closest to the conversation, and it
	// differs per project, so it belongs on the dynamic side of the marker. A
	// session with no memory files produces the same bytes it did before this
	// section existed.
	const memory = ctx.memory?.trim();
	if (memory) {
		sections.push(`# Project memory\n${memory}`);
	}

	return sections.join("\n\n");
}
