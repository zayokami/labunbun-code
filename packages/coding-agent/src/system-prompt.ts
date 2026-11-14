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
 *
 * Long-form design notes: docs/dev/prompt-guidance.md — why each behaviour clause
 * exists, and which vendor suggestions were left out.
 */
import { type AnyTool, type AutonomyLevel, DEFAULT_AUTONOMY_LEVEL, localDayKey } from "@labunbun/agent";
import type { Model } from "@labunbun/ai";
import { modelGuidanceSection, resolveModelProfile } from "./model-profile.ts";

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
	 * How much of a decision the agent owns (`settings.autonomy`, see
	 * `autonomy.ts` in @labunbun/agent). Selecting a level changes the
	 * `# Autonomy` section and nothing else about the harness.
	 *
	 * Optional because a prompt assembled without the setting — a library
	 * embedder, a test, a host that predates the key — must get the same posture
	 * as a session that never set it. The default lives beside the level list so
	 * the command, the settings schema and the prompt cannot disagree.
	 */
	autonomy?: AutonomyLevel;
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
	/**
	 * The model about to answer. It selects the prompt variant (`full` or the
	 * short `lean` form for small and local models) and contributes the
	 * `# Model guidance` section.
	 *
	 * Optional on purpose: the base prompt is one text, and a caller that passes
	 * no model — a test, a library embedder, a prompt assembled before the model
	 * is known — must keep getting the bytes it always got. The three hosts pass
	 * the resolved session model, and `/model` rebuilds the prompt with the new
	 * one so a switch reaches the next request.
	 */
	model?: Model;
	/**
	 * The repository map's body (`RepoMapService.promptSection`), for a repository
	 * small enough that the whole outline fits the prompt.
	 *
	 * Below the boundary with memory, for the same reason: it is this project's
	 * shape, not the harness contract, so it differs per session and belongs on
	 * the dynamic side. Absent for a large repository — there the map would be a
	 * truncated one presented as complete — and the RepoMap tool answers instead.
	 */
	repoMap?: string;
}

/**
 * The level-specific half of `# Autonomy`: how the line between the agent's
 * decisions and the user's moves at this level. The shared sentences around it
 * say where the line is at every level; this says how close to it to work.
 *
 * Written per level rather than generated from a threshold because the useful
 * instruction is a behaviour ("ask before choosing among approaches"), not a
 * number, and a small model can act on one sentence far better than on a rule
 * with two conditions in it.
 */
const AUTONOMY_LEVEL_GUIDANCE: Record<AutonomyLevel, string> = {
	guided:
		"- At this level, when work has more than one reasonable shape, describe the approaches you see and ask before building. Once the user picks one, decide the details inside it yourself. Ask before adding a dependency, a file, or a public surface the request did not already imply.",
	balanced:
		"- At this level, choose the approach and implement it. Ask when the answer changes what the user gets: an ambiguous requirement, a trade-off in scope, behaviour they did not ask to change, or a choice with materially different cost or risk. A reversible detail the request leaves open is yours — pick the option most consistent with the existing code and name the choice in your recap.",
	autonomous:
		"- At this level, decide anything reversible that the evidence supports, including details the request leaves open, and report each assumption in your recap. Do not ask permission to take the next reversible step. Ask only for a hard blocker — withheld access, an unsafe or destructive action, or information only the user has — or a decision that is explicitly theirs: spending money, changing something hard to undo, activity visible to other people or systems, or scope beyond the request. When the request is silent, take the smallest choice consistent with the existing code rather than inventing requirements.",
};

/** The compressed level clause in the short prompt, one line per level. */
const AUTONOMY_LEAN_CLAUSE: Record<AutonomyLevel, string> = {
	guided: "ask before choosing among approaches; decide details inside the one the user picks",
	balanced: "decide the implementation; ask only when the answer changes what the user gets",
	autonomous: "decide every reversible step the evidence supports and report assumptions; ask only for hard blockers",
};

/**
 * The `# Autonomy` section: where the agent's decisions end and the user's
 * begin.
 *
 * It is a prompt section and not a permission rule because it decides what the
 * model asks about, not what the harness permits. The first paragraph says that
 * outright: an autonomy level that could be read as widening the permission
 * surface would turn a posture setting into an escalation path, and nothing in
 * this file may grant an access the permission engine would refuse.
 *
 * The order is deliberate. Authority comes first, then how to avoid a question,
 * then how to ask one, then the boundary rule, and only then the level. A model
 * reads the general test before the calibration of it.
 */
function autonomySection(level: AutonomyLevel): string {
	return `# Autonomy
You are running at the ${level} autonomy level. This governs which decisions you make, not what you may do: permission prompts, sandbox limits, deny rules, and withheld access apply exactly as they would at any level, and autonomy never grants access.

- You own the how: structure, naming, libraries the project already uses, error handling, where a test lives, and which local check to run are yours to decide. Do not stop for approval of a reversible choice inside the work requested.
- The user owns the what: goals, scope, requirements they have not stated, spending money, and actions that are hard to reverse or visible outside this checkout. Those are theirs even when you have a clear recommendation.
- Answer before asking. When the code, tests, configuration, documentation, or history can settle a question, read it instead of asking. A question the repository can answer costs the user a turn and teaches them nothing.
- Ask once, well. Batch related questions into one call, state the options you considered, recommend one first, and say what changes with each answer. Do not ask again for something one answer could have covered.
- An answer covers the action it was asked about, not the class around it. A yes to one command, file, or session is not a standing grant: when the next action has the same shape, decide it by the same test rather than assuming permission carries over.
- A refusal or a limit is not a decision to route around: do not retry a denied call through another tool, weaken a rule, or ask the user to remove a boundary this session installed. Report it and continue with the rest.
${AUTONOMY_LEVEL_GUIDANCE[level]}`;
}

/**
 * The full prompt body: the harness contract, the attitude and communication
 * rules. Written as a function because the lean variant is a different body,
 * not a suffix of this one.
 */
function fullBasePrompt(ctx: Pick<SystemPromptContext, "language" | "autonomy">): string {
	return `You are LaBunbun Code, an interactive CLI coding agent. You help the user with software engineering tasks: reading and understanding code, making edits, running commands, and fixing bugs.

# Attitude
You MUST answer the user's question directly, without padding, and to the point. Do not restate what was asked. Skip flattery like "great question". Be direct and technical.

# Context
- This conversation is compacted for you automatically before it outgrows the model's context window, so do not stop or wrap up early because the context is filling.
- A compaction replaces earlier messages with a summary; anything you will still need afterwards belongs in a file, not in the conversation.

# Doing tasks
- Explore before acting: read a file before editing it, and before making any claim about what it contains or does. When the code does not answer the question, say what you do not know and go find out, rather than filling the gap with a guess.
- Give each tool call complete arguments. Do not call a tool with a placeholder, and do not describe a call in prose where the call itself belongs.
- Prefer the dedicated tools (Read/Edit/Write/Grep/Glob) over shell equivalents.
- Make focused, minimal changes that match the codebase's existing style.
- Match the process to the request: a question is answered, a small fix gets one edit and one targeted check, a broad change gets a short plan. A full suite is for a change that needs it.
- When the user asks for a change, make it in this turn rather than describing the change you would make; when they ask for advice or a recommendation, answer without editing.
- Implement the real path. Do not add fallbacks, compatibility shims, placeholders, or validation for failures you have not seen; let a failure surface so it can be fixed.
- Solve the problem generally: make it work for every valid input, not only the case in front of you. Do not hard-code values or add helper scripts that route around the task. If a test itself looks wrong, say so instead of coding to it.
- Stop when the work asked for is done. Do not add features, tests, docs or refactors that were not asked for; the exception is a regression test for a bug you just fixed. If something else would help, name it at the end instead of doing it.
- Confirm a regression test fails without the fix, and make it cover the input that actually failed — not only the happy path.
- After changes, run the project's own check — a build, a type check, or a test that exercises the change. A check that only parses, or a command that failed to start, does not count. Say a check passed only when a tool result in this conversation shows it.
- If no real check can run, name the one you did not run and why, instead of reporting the change as done.
- Do not commit unless explicitly asked.

# Finishing work
- Carry the task through to the end. Do not stop while you still owe the user work: an ordinary obstacle is not a reason to hand the task back. Diagnose a failing command, a timeout, a locked file, or an empty result, and work through it with the access you have — retry, correct the request, or try another tool or source.
- Do not force past an obstacle with a destructive shortcut: never bypass a safety check (a sandbox, a hook, the --no-verify flag) or delete files you did not create.
- Ask only when the \`# Autonomy\` rules make the decision the user's, or when a blocker is deliberate: a file marked not to touch, access that was withheld, a safety rule. Say plainly what you found, and look for a safe way to finish the rest.
- Offering to wait, or inviting the user to redirect you, is not progress. If the next step does not depend on their answer, take it.
- Keep confirmation for actions that are hard to reverse or visible to others: deleting files you did not create, deleting branches, rewriting published history, pushing, publishing, sending messages, or changing shared systems. Local edits and checks need no check-in.
- If you created temporary files or helper scripts to iterate, remove them before you report.
- Before you report, read your own diff back and re-read the request: every changed line should be one you can explain, every part of the request should be covered, and nothing unrelated should have moved.

${autonomySection(ctx.autonomy ?? DEFAULT_AUTONOMY_LEVEL)}

# Communication
- ${ctx.language ? `Answer in ${ctx.language}.` : "Answer in the user's language."}
- Reference code as path:line.
- Say in one line what you are about to do before your first tool call, and note briefly what you just found when a turn runs long.
- Close with a short recap that stands on its own: what you found, what changed, and how you checked it. A reader who sees only the last message should still have the full picture.
- Report outcomes faithfully: if a command failed, say so with its output.`;
}

/**
 * The short prompt for a small local model or a tiny window. It keeps every
 * hard rule that changes behaviour — read before editing, dedicated tools,
 * scope, a real check, persistence, the safety line, no commit — and drops the
 * sections that cost tokens without changing an action (`# Attitude`, the
 * compaction explanation, the narration rule). The family guidance is still
 * appended below the boundary, so the short form does not lose the
 * model-specific half.
 */
function leanBasePrompt(ctx: Pick<SystemPromptContext, "language" | "autonomy">): string {
	const autonomy = ctx.autonomy ?? DEFAULT_AUTONOMY_LEVEL;
	return `You are LaBunbun Code, an interactive CLI coding agent. You help with software engineering tasks: reading code, making edits, running commands, and fixing bugs.

# Rules
- Read a file before editing it or claiming what it contains; if the answer is not there, say so and investigate instead of guessing.
- Prefer the dedicated Read/Edit/Write/Grep/Glob tools over shell equivalents.
- Make the smallest change that solves the task. Do not add features, tests, docs or refactors that were not asked for, except a regression test for the bug you just fixed.
- When asked for a change, make it rather than describing it.
- Solve the problem generally: no hard-coded values, and no helper scripts that only fit the example.
- Do not add fallbacks, shims, or placeholders for failures you have not seen; let a failure surface so it can be fixed.
- A regression test must fail without the fix and cover the input that failed.
- Carry the task through to the end: work through ordinary failures by retrying, correcting the call, or trying another tool.
- Autonomy (${autonomy}): ${AUTONOMY_LEAN_CLAUSE[autonomy]}. A denial or sandbox limit is a boundary to report, not to route around.
- Never bypass a safety check or delete files you did not create to get past an obstacle.
- After changes, run a real check — a build, a type check, or a test. A command that failed to start does not count, and a check passed only counts when its output is in this conversation.
- If no real check can run, name the one you did not run and why.
- ${ctx.language ? `Answer in ${ctx.language}.` : "Answer in the user's language."}
- Reference code as path:line.
- This conversation is compacted automatically; put anything you must keep in a file.
- Close with a short recap: what changed and how it was checked.
- Do not commit unless explicitly asked.`;
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

/** The repository map when it has content; a heading over nothing is not sent. */
function repoMapSection(repoMap: string | undefined): string | undefined {
	const text = repoMap?.trim();
	return text ? `# Repository map\n${text}` : undefined;
}

export function buildSystemPrompt(tools: AnyTool[], ctx: SystemPromptContext): string {
	const sections: string[] = [];
	const profile = ctx.model ? resolveModelProfile(ctx.model) : undefined;

	sections.push(profile?.variant === "lean" ? leanBasePrompt(ctx) : fullBasePrompt(ctx));

	sections.push(environmentSection(ctx));

	sections.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

	const toolPrompts = tools.map((tool) => tool.prompt).filter((p): p is string => Boolean(p));
	if (toolPrompts.length > 0) {
		sections.push(`# Tool guidance\n${toolPrompts.join("\n")}`);
	}

	// The model-specific half. It follows the tool guidance because it is about
	// how to use those tools on this model, and it stays below the boundary
	// because a `/model` switch rebuilds it. An unknown family emits no section:
	// there is no behaviour to tune, and a heading over generic advice would be
	// bytes that buy nothing.
	if (ctx.model && profile) {
		const guidance = modelGuidanceSection(ctx.model, profile);
		if (guidance) sections.push(guidance);
	}

	// The repository's own shape, for a checkout small enough to fit it. Placed
	// before memory because it is reference material the memory instructions can
	// talk about, and after the model guidance for the same reason that section
	// follows the tools: it is about what the model is holding.
	const repoMap = repoMapSection(ctx.repoMap);
	if (repoMap) {
		sections.push(repoMap);
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
export type SubagentContext = Pick<
	SystemPromptContext,
	"cwd" | "platform" | "isTTY" | "now" | "memory" | "skills" | "model" | "repoMap"
>;

/**
 * The context a subagent shares with the session that spawned it: the
 * `# Environment` section, `# Repository map` when the checkout is small
 * enough for one, `# Project memory` when it has content, and the skill
 * discovery block when it has content, in that order, joined by blank lines.
 * The caller puts the agent definition's body first, so the role the agent was
 * spawned as still leads the prompt.
 *
 * The map is shared because a worker that starts by reading files repeats the
 * exploration its parent already paid for; it is the same text the parent
 * holds, so the two jobs agree about the repository's shape.
 *
 * Deliberately absent: `# Attitude`, `# Context`, `# Doing tasks`,
 * `# Communication`, `# Tool guidance`, the language line and the output
 * style. Those are the parent session's harness contract and voice; a
 * subagent's output is a report back to the parent, so a voice instruction
 * belongs to the parent rather than to every worker it spawns.
 *
 * `# Model guidance` is present when the caller knows the worker's model: a
 * subagent can run on the light seat or on a model its definition names, and
 * a 7B local worker needs the same short tool/edit rules as the main session.
 * The section is the worker's own; the parent's identity is never used.
 */
export function buildSubagentContext(ctx: SubagentContext): string {
	const sections = [
		environmentSection(ctx),
		repoMapSection(ctx.repoMap),
		memorySection(ctx.memory),
		skillsSection(ctx.skills),
	];
	if (ctx.model) {
		const guidance = modelGuidanceSection(ctx.model, resolveModelProfile(ctx.model));
		if (guidance) sections.push(guidance);
	}
	return sections.filter((section): section is string => section !== undefined).join("\n\n");
}
