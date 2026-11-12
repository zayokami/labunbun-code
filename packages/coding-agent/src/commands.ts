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
import { formatTokenTotal } from "@labunbun/tui/format";
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

/** What `/map` renders: the map text plus how complete it is. */
export interface RepoMapCommandResult {
	text: string;
	tokens: number;
	definitions: number;
	files: number;
	totalDefinitions: number;
	totalFiles: number;
	partial: boolean;
	/** Whether the scan stopped at its file ceiling before walking the whole tree. */
	truncated: boolean;
	/** Files the scan found but could not read or skipped for size. */
	skipped: number;
	/** Directories the walk could not list. */
	unreadableDirectories: number;
	elapsedMs: number;
	root: string;
}

/**
 * The session's repository map, as `/map` sees it.
 *
 * Structural on purpose: `RepoMapService` satisfies it without this module
 * importing the tools package, which keeps the command framework away from the
 * scanner. Optional on the context because a hand-built context (a test, an
 * embedder) has none, and the commands answer that rather than throwing.
 */
export interface RepoMapCommand {
	map(options: {
		path?: string;
		maxTokens?: number;
		refresh?: boolean;
		signal?: AbortSignal;
	}): Promise<RepoMapCommandResult>;
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
	/**
	 * Drop the Edit gate's record of what Read has shown this session. `/trim`
	 * replaces old tool results with previews, so the bytes the model was shown
	 * are gone from its context while the record still holds them; without this
	 * an Edit would proceed on content the model can no longer see. `/compact`
	 * needs no call here: a finished compaction clears the record in its `done`
	 * phase, which every entry point runs. Optional because a context built by
	 * hand — a test, an embedder — may have no tool set behind it.
	 */
	clearReads?(): void;
	/**
	 * Forget which path rules the session has attached. `/trim` replaces tool
	 * results with previews, and a rule attached to one of them goes with it;
	 * without this the session believes the model still carries a rule that is
	 * no longer in its context. Optional for the same reason as `clearReads`.
	 */
	resetPathRules?(): void;
	/**
	 * The abort signal of the command's own run, when the host keeps one.
	 *
	 * `/compact` is a full-prefix model call and may take half a minute; a host
	 * that lets Esc cancel it passes the signal here, and the command reports a
	 * cancel instead of a failure. Absent for a hand-built context (a test, an
	 * embedder), where there is no one to press anything.
	 */
	signal?: AbortSignal;
	/**
	 * The session's repository map. `/map` renders it; `/map-refresh` drops the
	 * cache first, so a file edited outside the session is seen. Shares the
	 * RepoMap tool's service and therefore its cache.
	 */
	repoMap?: RepoMapCommand;
	/**
	 * Put the rebuilt map in front of the model after `/map-refresh`.
	 *
	 * The prompt section is computed once at startup and carried in the live
	 * system prompt, so a refreshed map that only reached the screen would leave
	 * the model reading names that no longer exist. `/map` deliberately does not
	 * call this: looking at the map should not replace the cached prompt prefix.
	 */
	onRepoMapRefreshed?(): Promise<void> | void;
}

export interface LocalCommand extends CommandBase {
	type: "local";
	/**
	 * Whether the command watches `ctx.signal` and can be stopped with Esc.
	 *
	 * Declared rather than guessed: a host that routes Esc to running commands
	 * has to know which ones actually observe the abort, or a press would be
	 * swallowed by a command that never looks at its signal.
	 */
	cancellable?: true;
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
				c.description.toLowerCase().includes(normalized) ||
				// An alias is a name the user can type. Leaving it out here makes
				// `/migrate` look like a broken command: Enter dispatches it, and
				// the picker above the prompt says "No matching commands".
				c.aliases?.some((alias) => alias.startsWith(normalized) || alias.includes(normalized)),
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
			// The summary is a full-prefix model call; Esc must be able to stop it.
			cancellable: true,
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
				let compacted: Awaited<ReturnType<CompactionManager["compact"]>>;
				try {
					compacted = await ctx.compaction.compact(context, { trigger: "manual", focus: args, signal: ctx.signal });
				} catch (error) {
					// A cancel is the user's own Esc, not a failed summary: the manager
					// already skipped its failure counter for it, and the command owes
					// the user the outcome rather than an error line.
					if (ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
						return "Compaction cancelled.";
					}
					throw error;
				}
				// The summary replaces everything above the boundary, so the next
				// request is a miss from there down. Declared, because the user asked.
				ctx.noteCacheRewrite?.("compaction");
				// Adopting the result is the whole command. Reporting success without
				// it costs a full summarization call and changes nothing.
				ctx.session.applyCompaction(compacted);
				ctx.refreshContext?.();
				const after = estimateContextUsage(compacted);
				const freed = Math.max(0, before - after);
				const headline = `Conversation compacted: ~${formatTokenTotal(freed)} tokens freed (${formatTokenTotal(before)} → ${formatTokenTotal(after)}).`;
				// The receipt under the headline. The app's automatic report
				// suppresses itself for this trigger precisely so this line can be the
				// full account, and what the pass verified about its own product is
				// the half the numbers cannot tell. Read from the manager right after
				// the pass it ran: a phase listener has no way to hand the
				// verification back to a command's return value.
				const verification = ctx.compaction.lastVerification();
				const receipt = verification ? compactionReceiptLines(verification) : [];
				// A summary can succeed and still leave the context unsendable — the
				// summary itself can be large, or the turn it had to keep can be. The
				// headline already reported the saving; saying nothing more would read
				// as a fixed session right before the next request is refused. The
				// limit comes from the manager, which is the arithmetic the loop and
				// the automatic path use; recomputing it here could disagree.
				const hardLimit = ctx.compaction.limits().hardLimit;
				const overLimit =
					after >= hardLimit
						? [
								`Warning: the compacted context is still ~${formatTokenTotal(after)} tokens, over this model's hard limit of ${formatTokenTotal(hardLimit)}; ` +
									"the next request may still be refused. Run /trim to drop old tool results, or use a model with a larger window.",
							]
						: [];
				return [headline, ...receipt, ...overLimit].join("\n");
			},
		},
		{
			name: "btw",
			description: "Ask a side question about the conversation without adding it to the history: /btw [question]",
			type: "local",
			// The answer is one model call; Esc must be able to stop it.
			cancellable: true,
			call: async (ctx, args) => {
				const question = args.trim();
				if (!question) return "Usage: /btw [question] — a question answered from this conversation, not added to it.";
				if (ctx.session.isRunning) return "/btw waits for the current run to finish.";
				// One model call takes a while, and the REPL prints only the return
				// value: without this line the command looks hung.
				ctx.pushInfo("Asking…");
				try {
					const answer = await ctx.session.aside(question, { signal: ctx.signal });
					return answer || "The model returned no text.";
				} catch (error) {
					if (ctx.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
						return "Aside cancelled.";
					}
					throw error;
				}
			},
		},
		{
			name: "explain",
			description: "Ask the model to explain code or a concept: /explain [target]",
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
				`1. If LABUNBUN.md already exists, suggest only the lines worth removing or correcting; do not rewrite it wholesale.\n` +
				`2. Otherwise create it with the commands an agent needs to check its own work — build, typecheck, lint, test,\n` +
				`   and how to run one test file — plus only the conventions and gotchas that cannot be learned by reading the repo.\n` +
				`Write each convention as a concrete, checkable instruction, not a vague preference.\n` +
				`Do not describe the architecture or file layout; later sessions read the code directly.\n` +
				`Keep it short: every line is loaded into every session, so aim for well under 200 lines.`,
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
				// The full results are now previews in the conversation: the model can no
				// longer see what the read record says it saw, so the record goes too.
				ctx.clearReads?.();
				// A path rule attached to one of those results is gone with it; the
				// next matching read has to be allowed to attach it again.
				ctx.resetPathRules?.();
				ctx.refreshContext?.();
				const after = estimateContextUsage(trimmed.context);
				const freed = Math.max(0, before - after);
				return (
					`Replaced ${trimmed.cleared.results} old tool result${trimmed.cleared.results === 1 ? "" : "s"} with previews: ` +
					`~${formatTokenTotal(freed)} tokens freed (${formatTokenTotal(before)} → ${formatTokenTotal(after)}). ` +
					"Files on disk are unchanged; /compact summarizes instead when this is not enough."
				);
			},
		},
		{
			name: "map",
			description: "Show the ranked repository map: /map [path] [--tokens N]",
			type: "local",
			// Esc stops a cold scan of a large tree; the scan checks the signal per
			// file and the walk checks it per entry.
			cancellable: true,
			call: (ctx, args) => showRepoMap(ctx, args, false),
		},
		{
			name: "map-refresh",
			description: "Rebuild the repository map from disk: /map-refresh [path] [--tokens N]",
			type: "local",
			cancellable: true,
			call: (ctx, args) => showRepoMap(ctx, args, true),
		},
	];
}

/**
 * `/map`'s arguments: an optional directory, and the token budget.
 *
 * The directory comes first positionally because that is what a user types;
 * the budget needs its flag because a bare number would be ambiguous with a
 * path component. A malformed budget is ignored rather than refused — the map
 * still answers at the default, and the caller sees the token count it got.
 */
function parseRepoMapArgs(args: string): { path?: string; maxTokens?: number } {
	const tokens = splitQuotedArgs(args);
	let path: string | undefined;
	let maxTokens: number | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--tokens" || token === "-t") {
			const value = Number(tokens[++index]);
			if (Number.isFinite(value)) maxTokens = value;
			continue;
		}
		if (token.startsWith("--tokens=")) {
			const value = Number(token.slice("--tokens=".length));
			if (Number.isFinite(value)) maxTokens = value;
			continue;
		}
		if (path === undefined) path = token;
	}
	return { path, maxTokens };
}

/** Split on whitespace, keeping a quoted path with spaces in it one token. */
function splitQuotedArgs(args: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	for (const char of args) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (/\s/.test(char)) {
			if (current !== "") {
				tokens.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	if (current !== "") tokens.push(current);
	return tokens;
}

function formatRepoMapReport(result: RepoMapCommandResult): string {
	const scope = result.partial
		? `${result.definitions.toLocaleString()} of ${result.totalDefinitions.toLocaleString()} definitions in ` +
			`${result.files.toLocaleString()} of ${result.totalFiles.toLocaleString()} files`
		: `${result.definitions.toLocaleString()} definitions in ${result.files.toLocaleString()} ` +
			`file${result.files === 1 ? "" : "s"}`;
	const hint = result.partial ? " Raise it with /map --tokens <n>." : "";
	const truncated = result.truncated ? " The scan stopped at its file ceiling; the rest of the tree is unindexed." : "";
	const unindexed: string[] = [];
	if (result.skipped > 0) {
		unindexed.push(
			`${result.skipped.toLocaleString()} file${result.skipped === 1 ? "" : "s"} skipped (unreadable or over the size limit)`,
		);
	}
	if (result.unreadableDirectories > 0) {
		unindexed.push(
			`${result.unreadableDirectories.toLocaleString()} unreadable director${result.unreadableDirectories === 1 ? "y" : "ies"}`,
		);
	}
	const skipped = unindexed.length > 0 ? ` ${unindexed.join(" and ")}; that part of the tree is unindexed.` : "";
	const body = result.text || `(no definitions found under ${result.root})`;
	return `${body}\n\nRepo map: ${scope}, ~${result.tokens.toLocaleString()} tokens, ${(result.elapsedMs / 1000).toFixed(1)}s.${hint}${truncated}${skipped}`;
}

async function showRepoMap(ctx: LocalCommandContext, args: string, refresh: boolean): Promise<string> {
	if (!ctx.repoMap) return "Repository maps are not available in this session.";
	const { path, maxTokens } = parseRepoMapArgs(args);
	let report: string;
	try {
		const result = await ctx.repoMap.map({ path, maxTokens, refresh, signal: ctx.signal });
		report = formatRepoMapReport(result);
	} catch (error) {
		// Esc is not a failure to report as one: the user stopped the scan.
		if (ctx.signal?.aborted) return "Repo map cancelled.";
		return `Repo map failed: ${error instanceof Error ? error.message : String(error)}`;
	}
	// Only a refresh offers the new map to the model; `/map` is a look. The
	// section is recomputed after the map so it reads the cache this call just
	// filled instead of scanning twice.
	if (refresh) {
		try {
			await ctx.onRepoMapRefreshed?.();
		} catch (error) {
			return `${report}\n\nThe files were re-read, but the prompt still holds the old map: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	return report;
}
