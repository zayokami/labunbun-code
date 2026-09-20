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
import { estimateContextUsage } from "@labunbun/agent";
import { runMigration } from "./migrate.ts";
import { type MigrationDialogBridge, runMigrationWizard } from "./migrate-wizard.ts";

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
	/**
	 * Present only with a REPL attached. A command that can ask the user checks
	 * for it and falls back to its non-interactive form without it.
	 */
	dialog?: MigrationDialogBridge;
	/**
	 * Republish the context indicator. A command that changes how much of the
	 * window is in use calls this — the indicator otherwise only hears about
	 * turn boundaries, and `/compact` would leave it showing the number the user
	 * ran the command to change.
	 */
	refreshContext?(): void;
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
			call: async (ctx, args) => {
				if (!ctx.compaction) return "Compaction is not available in this session.";
				ctx.pushInfo("Compacting conversation…");
				const context = ctx.session.currentContext();
				const before = estimateContextUsage(context);
				const compacted = await ctx.compaction.compact(context, { trigger: "manual", focus: args });
				// Adopting the result is the whole command. Reporting success without
				// it costs a full summarization call and changes nothing.
				ctx.session.applyCompaction(compacted);
				ctx.refreshContext?.();
				const after = estimateContextUsage(compacted);
				const freed = Math.max(0, before - after);
				return `Conversation compacted: ~${freed.toLocaleString()} tokens freed (${before.toLocaleString()} → ${after.toLocaleString()}).`;
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
			name: "migrate",
			description: "Import from another agent tool: /migrate asks, or pass [--from <sources>] [--apply] [--force]",
			type: "local",
			call: async (ctx, args) => {
				const tokens = args.split(/\s+/).filter(Boolean);
				// Bare `/migrate` in a REPL asks the same questions the flags below
				// spell out, and ends in the same runMigration call.
				if (tokens.length === 0 && ctx.dialog) {
					return runMigrationWizard({
						dialog: ctx.dialog,
						cwd: ctx.cwd,
						report: (text) => ctx.pushInfo(text),
					});
				}
				const fromIndex = tokens.indexOf("--from");
				const result = runMigration({
					from: fromIndex === -1 ? undefined : tokens[fromIndex + 1],
					apply: tokens.includes("--apply"),
					force: tokens.includes("--force"),
				});
				if (result.error) return result.error;
				if (!result.applied) return result.report;
				// Settings, skills and rules are all read at startup, so an applied
				// migration only takes effect on the next launch.
				return `${result.report}\n\nRestart to pick up the imported configuration.`;
			},
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
		{
			name: "trim",
			description: "Replace old tool results with short previews to free context without summarizing",
			type: "local",
			call: (ctx) => {
				if (!ctx.compaction) return "Trimming is not available in this session.";
				const context = ctx.session.currentContext();
				const before = estimateContextUsage(context);
				const trimmed = ctx.compaction.trim(context);
				// Nothing to do is not a failure, and it has one cause worth naming:
				// the older results were already small, so cutting them would free
				// nothing and lose what little they still said.
				if (!trimmed) return "Nothing to trim: no old tool results are large enough to be worth previewing.";
				ctx.session.applyCompaction(trimmed.context);
				ctx.refreshContext?.();
				const after = estimateContextUsage(trimmed.context);
				const freed = Math.max(0, before - after);
				return (
					`Replaced ${trimmed.cleared.results} old tool result${trimmed.cleared.results === 1 ? "" : "s"} with previews: ` +
					`~${freed.toLocaleString()} tokens freed (${before.toLocaleString()} → ${after.toLocaleString()}). ` +
					"Files on disk are unchanged; /compact summarizes instead when this is not enough."
				);
			},
		},
	];
}
