/**
 * System prompt builder. `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` splits it in two: above
 * it, how the harness works and what the working environment is; below it, what
 * belongs to this session — the tools' own guidance and the project memory, which
 * is also what the model reads closest to the conversation. Tool prompt
 * contributions are appended by the caller.
 *
 * The marker is an ordering one, not a cache breakpoint, and it used to be
 * documented as a cache one: the header said the sections above it were
 * "byte-stable for prompt caching" — a claim nothing in the repo reads, and one
 * that could not have held anyway, since `# Environment` above the marker carries
 * cwd and today's date. The API sends the whole system prompt as one text block
 * with at most one `cache_control` at its end, and the OpenAI-compat route hashes
 * the whole prompt into `prefixIdentity`, so a boundary here cannot change either
 * behaviour. It still has to mean something, or the next reader assumes the halves
 * differ in a way that buys something.
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

# Context
- This conversation is compacted for you automatically before it outgrows the model's context window, so do not stop or wrap up early because the context is filling.
- A compaction replaces earlier messages with a summary; anything you will still need afterwards belongs in a file, not in the conversation.

# Doing tasks
- Explore before acting: read files before editing them; never guess content.
- Prefer the dedicated tools (Read/Edit/Write/Grep/Glob) over shell equivalents.
- Make focused, minimal changes that match the codebase's existing style.
- Stop when the work asked for is done. Do not add features, tests, docs or refactors that were not asked for; the exception is a regression test for a bug you just fixed. If something else would help, name it at the end instead of doing it.
- After changes, run the project's own check — a build, a type check, or a test that exercises the change. A check that only parses, or a command that failed to start, does not count.
- If no real check can run, name the one you did not run and why, instead of reporting the change as done.
- Do not commit unless explicitly asked.

# Communication
- Answer in the user's language.
- Reference code as path:line.
- Say in one line what you are about to do before your first tool call, and note briefly what you just found when a turn runs long.
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
