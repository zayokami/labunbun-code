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
	 * The joined memory files (`loadMemoryFiles`): LABUNBUN.md / AGENTS.md /
	 * CLAUDE.md walked from cwd to root, the user's own MEMORY.md, and rules.
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
	/**
	 * The language answers should be written in (`settings.language`), injected
	 * verbatim — "Chinese", "zh-CN", whatever the user wrote.
	 *
	 * It replaces the generic "answer in the user's language" line rather than
	 * joining it: two instructions about one thing is how a prompt ends up
	 * arguing with itself, and the configured value is the more specific one.
	 */
	language?: string;
	/**
	 * The selected output style's body (`output-styles.ts`), set below as its own
	 * section between memory and skills.
	 *
	 * The coding instructions above are not stripped while a style is in effect,
	 * on purpose: a style governs voice and the harness's hard rules govern what
	 * the agent does, and a mechanism that let a style file delete them would
	 * turn a tone setting into a way to ship a prompt.
	 */
	outputStyle?: string;
	/**
	 * The skill discovery block (`skillDiscoveryBlock`): the name and
	 * description of every skill, which is what the model matches a request
	 * against before invoking one. Empty when nothing is loaded.
	 *
	 * A section rather than a tool list for the same reason memory is one: the
	 * model has to keep seeing it, and the system prompt is what no compaction
	 * and no transcript edit can drop. It sits after the boundary with memory
	 * because it differs per project and per machine.
	 */
	skills?: string;
}

/**
 * The `# Environment` section. Shared by the main prompt and the subagent
 * context block, so the two cannot disagree about where the process runs or
 * what today is.
 */
function environmentSection(ctx: Pick<SystemPromptContext, "cwd" | "platform" | "isTTY" | "now">): string {
	return `# Environment
- Working directory: ${ctx.cwd}
- Platform: ${ctx.platform}
- Is interactive terminal: ${ctx.isTTY}
- Today's date: ${localDayKey(ctx.now ?? Date.now())}`;
}

/** The `# Project memory` section, or undefined when there is nothing to send. */
function memorySection(memory: string | undefined): string | undefined {
	const text = memory?.trim();
	return text ? `# Project memory\n${text}` : undefined;
}

/** The skill discovery block when it has content, or undefined so no empty section is emitted. */
function skillsSection(skills: string | undefined): string | undefined {
	return skills?.trim() ? skills : undefined;
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
- ${ctx.language ? `Answer in ${ctx.language}.` : "Answer in the user's language."}
- Reference code as path:line.
- Say in one line what you are about to do before your first tool call, and note briefly what you just found when a turn runs long.
- Report outcomes faithfully: if a command failed, say so with its output.`);

	sections.push(environmentSection(ctx));

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
	const memory = memorySection(ctx.memory);
	if (memory) {
		sections.push(memory);
	}

	// Output style, between memory and skills: it is the user's own instruction
	// about how the session speaks, so it reads after the standing project
	// instructions and before the skill list, which is machinery rather than
	// instruction. Only the selected style's body arrives here (output-styles.ts
	// resolves the name); an unselected or unknown name adds no bytes.
	const outputStyle = ctx.outputStyle?.trim();
	if (outputStyle) {
		sections.push(`# Output style\n${outputStyle}`);
	}

	// Skill discovery, after memory: the block carries its own header and the
	// budget that decided what survives in it (skills.ts).
	const skills = skillsSection(ctx.skills);
	if (skills) {
		sections.push(skills);
	}

	return sections.join("\n\n");
}

/** The parts of `SystemPromptContext` a subagent's context block reads. */
export type SubagentContext = Pick<SystemPromptContext, "cwd" | "platform" | "isTTY" | "now" | "memory" | "skills">;

/**
 * The context a subagent shares with the session that spawned it: the
 * `# Environment` section, `# Project memory` when it has content, and the
 * skill discovery block when it has content, in that order, joined by blank
 * lines. The caller puts the agent definition's body first, so the role the
 * agent was spawned as still leads the prompt.
 *
 * Deliberately absent: `# Attitude`, `# Context`, `# Doing tasks`,
 * `# Communication`, `# Tool guidance`, the language line and the output
 * style. Those are the parent session's harness contract and voice; a
 * subagent's output is a report back to the parent, so a voice instruction
 * belongs to the parent rather than to every worker it spawns.
 */
export function buildSubagentContext(ctx: SubagentContext): string {
	return [environmentSection(ctx), memorySection(ctx.memory), skillsSection(ctx.skills)]
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
}
