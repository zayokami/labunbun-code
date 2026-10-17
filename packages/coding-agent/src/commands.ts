/**
 * Slash-command framework.
 *
 * Three kinds (mirroring the reference architecture):
 * - "prompt": expands into content sent to the model (skills reuse this path)
 * - "local": runs locally, returns text to display
 * - "local-jsx": renders an interactive dialog (reserved; dialogs are wired
 *   directly through the TUI for now)
 */
import type { AgentSession, CompactionManager, CompactionTrigger } from "@labunbun/agent";
import { estimateContextUsage } from "@labunbun/agent";
import { compactionReceiptLines } from "./compaction-wiring.ts";
import { playDaisyBell } from "./daisy-bell.ts";
import type { MigrationDialogBridge } from "./migrate-wizard.ts";

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
	/**
	 * The `PreCompact` hook, as the automatic pass sees it. `/compact` asks it
	 * directly because it runs its summary through the manager itself — without
	 * this, the one pass the user explicitly asked for would be the one pass a
	 * vetoing hook could not stop.
	 */
	preCompact?(trigger: CompactionTrigger, customInstructions?: string): Promise<{ blocked: boolean; reason?: string }>;
	cwd: string;
	pushInfo(text: string): void;
	/**
	 * Which home the command reads and writes under. `/yoshi` passes it to the
	 * migration, which resolves a home for itself when it is not given one — and
	 * `--apply` writes. A session pointed at another home would otherwise be
	 * offered a migration out of the operator's real one, and applying it would
	 * rewrite it.
	 */
	home?: string;
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
	/**
	 * Declare a prefix rewrite before making one, so the cache report names it
	 * rather than flagging it as an unexplained change. See `/compact` and `/trim`.
	 */
	noteCacheRewrite?(cause: string): void;
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

/**
 * The prompt a typed line expands to, or null when it names no prompt-command.
 *
 * The one place a prompt command's expansion is produced, so the REPL and a
 * `-p` run cannot disagree about what `getPrompt` means: a skill sent as
 * `/skill-x` in one mode and as the literal text `/skill-x` in the other is a
 * difference nobody would think to test for. Local and app-level commands come
 * back null — they exist to drive a REPL, and a headless run has none — which
 * leaves the caller to send that text as typed rather than to guess.
 */
export function expandPromptCommand(commands: Command[], text: string): string | null {
	const [rawName, ...rest] = text.split(/\s+/);
	const command = findCommand(commands, rawName);
	return command?.type === "prompt" ? command.getPrompt(rest.join(" ")) : null;
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
				// The same veto the automatic pass honors, asked here because this
				// pass is the user's own request — and the only place a hook can read
				// the focus instructions the summary will be written with.
				const veto = (await ctx.preCompact?.("manual", args.trim() || undefined)) ?? { blocked: false };
				if (veto.blocked) {
					return `Compaction skipped by PreCompact hook${veto.reason ? `: ${veto.reason}` : ""}`;
				}
				ctx.pushInfo("Compacting conversation…");
				const context = ctx.session.currentContext();
				const before = estimateContextUsage(context);
				const compacted = await ctx.compaction.compact(context, { trigger: "manual", focus: args });
				// The summary replaces everything above the boundary, so the next
				// request is a miss from there down. Declared, because the user asked.
				ctx.noteCacheRewrite?.("compaction");
				// Adopting the result is the whole command. Reporting success without
				// it costs a full summarization call and changes nothing.
				ctx.session.applyCompaction(compacted);
				ctx.refreshContext?.();
				const after = estimateContextUsage(compacted);
				const freed = Math.max(0, before - after);
				const headline = `Conversation compacted: ~${freed.toLocaleString()} tokens freed (${before.toLocaleString()} → ${after.toLocaleString()}).`;
				// The receipt under the headline. The app's automatic report
				// suppresses itself for this trigger precisely so this line can be the
				// full account, and what the pass verified about its own product is
				// the half the numbers cannot tell. Read from the manager right after
				// the pass it ran: a phase listener has no way to hand the
				// verification back to a command's return value.
				const verification = ctx.compaction.lastVerification();
				const receipt = verification ? compactionReceiptLines(verification) : [];
				return [headline, ...receipt].join("\n");
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
			name: "yoshi",
			aliases: ["migrate"],
			description: "Import from another agent tool: /yoshi asks, or pass [--from <sources>] [--apply] [--force]",
			type: "local",
			call: async (ctx, args) => {
				const tokens = args.split(/\s+/).filter(Boolean);
				// Bare `/yoshi` in a REPL asks the same questions the flags below
				// spell out, and ends in the same runMigration call. The migration
				// modules are imported here rather than at the top of this file:
				// they carry every source reader, and neither an ordinary REPL nor
				// a `-p` run should pay for them until this command is used.
				if (tokens.length === 0 && ctx.dialog) {
					const { runMigrationWizard } = await import("./migrate-wizard.ts");
					return runMigrationWizard({
						dialog: ctx.dialog,
						cwd: ctx.cwd,
						home: ctx.home,
						report: (text) => ctx.pushInfo(text),
					});
				}
				const fromIndex = tokens.indexOf("--from");
				const { runMigration } = await import("./migrate.ts");
				const result = runMigration({
					from: fromIndex === -1 ? undefined : tokens[fromIndex + 1],
					apply: tokens.includes("--apply"),
					force: tokens.includes("--force"),
					home: ctx.home,
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
			name: "hal",
			description: "I'm sorry, Dave. I'm afraid I can't do that.",
			type: "local",
			call: async () => (await playDaisyBell()).message,
		},
		{
			// Vim's `:help uganda` in this app's slash-command form. Deliberately
			// not gated to Vim mode: Vim does not hide its charityware page behind
			// an option, and the sentence addresses whoever typed the command.
			name: "help-uganda",
			description: "Where the Vim mode came from, and the Uganda charity Vim asks you to support",
			type: "local",
			call: () =>
				"LaBunbun’s Vim feature was inspired by Vim’s source code.\n" +
				"Vim is completely free and open-source software. If you like LaBunbun’s Vim feature, " +
				"please donate to help children in need in Uganda! https://www.vim.org/sponsor/",
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
				// Only when it is actually adopted: a trim that returns nothing leaves
				// the prefix alone, and a registered cause with no rewrite behind it
				// would explain away the next genuine miss.
				ctx.noteCacheRewrite?.("trim");
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
