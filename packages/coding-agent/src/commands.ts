/**
 * Slash-command framework.
 *
 * Three kinds (mirroring the reference architecture):
 * - "prompt": expands into content sent to the model (skills reuse this path)
 * - "local": runs locally, returns text to display
 * - "local-jsx": renders an interactive dialog (reserved; dialogs are wired
 *   directly through the TUI for now)
 */
import type { AgentSession, CompactionManager } from "@labunbun/agent";

export interface CommandBase {
	name: string;
	description: string;
	aliases?: string[];
}

export interface PromptCommand extends CommandBase {
	type: "prompt";
	/** Build the user-message content this command expands to. */
	getPrompt(args: string): string;
}

export interface LocalCommandContext {
	session: AgentSession;
	compaction?: CompactionManager;
	cwd: string;
	pushInfo(text: string): void;
}

export interface LocalCommand extends CommandBase {
	type: "local";
	call(ctx: LocalCommandContext, args: string): Promise<string | undefined> | string | undefined;
}

export interface LocalJsxCommand extends CommandBase {
	type: "local-jsx";
	/** Placeholder until dialogs route through the TUI dialog slot. */
	call(ctx: LocalCommandContext, args: string): Promise<string | undefined> | string | undefined;
}

export type Command = PromptCommand | LocalCommand | LocalJsxCommand;

export function findCommand(commands: Command[], name: string): Command | undefined {
	const normalized = name.replace(/^\//, "").toLowerCase();
	return commands.find((c) => c.name === normalized) ?? commands.find((c) => c.aliases?.includes(normalized));
}

/** Prefix matches for autocomplete, ordered by name. */
export function completeCommands(commands: Command[], prefix: string): Command[] {
	const normalized = prefix.replace(/^\//, "").toLowerCase();
	if (!normalized) return [...commands].sort((a, b) => a.name.localeCompare(b.name));
	return commands
		.filter(
			(c) =>
				c.name.startsWith(normalized) ||
				c.name.includes(normalized) ||
				c.description.toLowerCase().includes(normalized),
		)
		.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Built-in commands
// ---------------------------------------------------------------------------

export function builtInCommands(): Command[] {
	return [
		{
			name: "compact",
			description: "Summarize the conversation to free context; optional focus instructions",
			type: "local",
			call: async (ctx, _args) => {
				if (!ctx.compaction) return "Compaction is not available in this session.";
				ctx.pushInfo("Compacting conversation…");
				await ctx.compaction.compact({
					systemPrompt: "",
					messages: ctx.session.messages,
				});
				return "Conversation compacted.";
			},
		},
		{
			name: "explain",
			description: "Ask the model to explain code or a concept: /explain <target>",
			type: "prompt",
			getPrompt: (args) =>
				`Explain ${args || "the most recently discussed code"}. Cover what it does, why it is written this way, and any gotchas. Reference specific files and line numbers.`,
		},
		{
			name: "init",
			description: "Generate a LABUNBUN.md project guide by analyzing the codebase",
			type: "prompt",
			getPrompt: () =>
				`Analyze this codebase and create a LABUNBUN.md file at the project root:\n` +
				`1. If LABUNBUN.md already exists, suggest improvements based on what you learned.\n` +
				`2. Otherwise create it with: build/lint/test commands (especially for running a single test),\n` +
				`   architecture overview, and any conventions an agent must follow.\n` +
				`Be concise — future agent sessions will read this file first.`,
		},
	];
}
