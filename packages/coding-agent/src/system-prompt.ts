/**
 * System prompt builder. Static sections are byte-stable for prompt caching;
 * a DYNAMIC_BOUNDARY marker separates per-session dynamic content (P5 adds
 * git status etc.). Tool prompt contributions are appended by the caller.
 */
import type { AnyTool } from "@labunbun/agent";

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "SYSTEM_PROMPT_DYNAMIC_BOUNDARY";

export interface SystemPromptContext {
	cwd: string;
	platform: string;
	isTTY: boolean;
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
- Today's date: ${new Date().toISOString().slice(0, 10)}`);

	sections.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

	const toolPrompts = tools.map((tool) => tool.prompt).filter((p): p is string => Boolean(p));
	if (toolPrompts.length > 0) {
		sections.push(`# Tool guidance\n${toolPrompts.join("\n")}`);
	}

	return sections.join("\n\n");
}
