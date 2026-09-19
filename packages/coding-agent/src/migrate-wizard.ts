/**
 * The interactive `/migrate` flow: ask what to bring over, show the plan, then
 * write only after the user has seen it.
 *
 * The wizard asks questions, it does not decide: every answer ends up as an
 * argument to `runMigration`, the same call the CLI makes, so the wizard cannot
 * import anything `labunbun migrate` would not.
 *
 * The first question is the shortcut. "Import everything" answers the source and
 * category questions with "every source found, every category" and goes straight
 * to the plan; history is still asked about, because that one answer decides how
 * much of the user's past is read and no default is worth guessing at.
 *
 * Two things about the dialog it has to live with, both visible in
 * `packages/tui`: a question offers radio-style options and answers with the
 * chosen label (there is no multi-select), and a picker scrolls a long list but
 * resolves to a single index. So "which sources?" is one yes/no question per
 * source, and "which sessions?" is a picker whose first entry stands for "all of
 * them".
 */
import { homedir } from "node:os";
import { basename } from "node:path";
import {
	detectSources,
	MIGRATION_CATEGORIES,
	MIGRATION_SOURCE_LABELS,
	type MigrationCategory,
	type MigrationSourceId,
	runMigration,
} from "./migrate.ts";
import {
	collectHistory,
	DEFAULT_HISTORY_LIMIT,
	DEFAULT_PROMPT_HISTORY_LIMIT,
	type HistoryImport,
	type HistoryInput,
	type HistoryScope,
	listHistory,
	type PromptHistoryImport,
	type PromptHistoryInput,
	readPromptHistory,
	sameProject,
} from "./migrate-history.ts";

export interface MigrationDialogItem {
	label: string;
	description?: string;
}

/**
 * The slice of the REPL app handle the wizard uses. Structural on purpose: the
 * TUI's `ReplAppHandle` satisfies it, and neither package has to import the
 * other's types for that to hold.
 */
export interface MigrationDialogBridge {
	askUser(
		questions: Array<{ question: string; header: string; options: MigrationDialogItem[] }>,
	): Promise<string[] | null>;
	pickFromList(title: string, items: MigrationDialogItem[]): Promise<number | null>;
}

export interface MigrationWizardContext {
	dialog: MigrationDialogBridge;
	/** Sessions are imported relative to this project. */
	cwd: string;
	home?: string;
	/** Where each step's output goes; the REPL passes `pushInfo`. */
	report(text: string): void;
}

const YES = "Yes";
const NO = "No";
const EVERYTHING = "Import everything";
const CHOOSE = "Choose…";
/** The first question's header; the rest are labelled with what they are about. */
const MODE_HEADER = "Migration";

/** The three categories, phrased as questions the user can answer. */
const CATEGORY_QUESTIONS: Array<{ category: MigrationCategory; question: string; detail: string }> = [
	{
		category: "settings",
		question: "Bring settings, MCP servers and permissions across?",
		detail: "model, environment variables, MCP servers, permission rules",
	},
	{
		category: "assets",
		question: "Bring skills, agents and rules across?",
		detail: "files under ~/.labunbun (existing files are kept)",
	},
	{
		category: "history",
		question: "Import past conversations?",
		detail: "resumable session files under ~/.labunbun/projects, and your prompts for ↑ recall",
	},
];

function yesNo(detail: string): MigrationDialogItem[] {
	return [
		{ label: YES, description: detail },
		{ label: NO, description: "leave it where it is" },
	];
}

/** `title — project — date`: the three things that tell two sessions apart. */
function sessionLabel(candidate: { title: string; sourceId: string; cwd: string; startedAt: number }): string {
	const title = candidate.title || candidate.sourceId.slice(0, 8);
	const date = candidate.startedAt ? new Date(candidate.startedAt).toLocaleDateString() : "unknown date";
	return `${title} — ${basename(candidate.cwd)} — ${date}`;
}

/**
 * The shortcut question: everything, or the step-by-step path?
 *
 * `null` means the user cancelled the dialog, and then nothing at all was read:
 * the sources are only listed, never opened, until an answer says which of them
 * count.
 */
async function askImportEverything(
	dialog: MigrationDialogBridge,
	sources: MigrationSourceId[],
): Promise<boolean | null> {
	const names = sources.map((source) => MIGRATION_SOURCE_LABELS[source]).join(", ");
	const answers = await dialog.askUser([
		{
			question: "Import your existing setup?",
			header: MODE_HEADER,
			options: [
				{
					label: EVERYTHING,
					description: `settings, files and history from ${names} — history is still asked about`,
				},
				{ label: CHOOSE, description: "pick the sources and the categories yourself" },
			],
		},
	]);
	if (!answers) return null;
	return answers[0] === EVERYTHING;
}

/** Ask which sources to consider. `null` means the user cancelled the dialog. */
async function askSources(
	dialog: MigrationDialogBridge,
	sources: MigrationSourceId[],
): Promise<MigrationSourceId[] | null> {
	const answers = await dialog.askUser(
		sources.map((source) => ({
			question: `Import from ${MIGRATION_SOURCE_LABELS[source]}?`,
			header: MIGRATION_SOURCE_LABELS[source].slice(0, 12),
			options: yesNo("settings, files and history"),
		})),
	);
	if (!answers) return null;
	return sources.filter((_, index) => answers[index] === YES);
}

async function askCategories(dialog: MigrationDialogBridge): Promise<MigrationCategory[] | null> {
	const answers = await dialog.askUser(
		CATEGORY_QUESTIONS.map((entry) => ({
			question: entry.question,
			header: "Categories",
			options: yesNo(entry.detail),
		})),
	);
	if (!answers) return null;
	return CATEGORY_QUESTIONS.filter((_, index) => answers[index] === YES).map((entry) => entry.category);
}

/**
 * What one history answer buys: the sessions to bring, and the prompts that come
 * with them.
 *
 * The recall list rides on the same answer on purpose. The user was asked what of
 * theirs should come across, and "this project only" is an answer about their
 * words as much as about their transcripts — importing every prompt they ever
 * typed in every directory would be answering a question they did not say yes to,
 * and "skip history" cannot sensibly mean "except the recall list".
 */
interface HistoryTake {
	/** Sessions to bring. */
	history: HistoryInput;
	/** Prompts to merge into the recall list, under the same answer's scope. */
	prompts: PromptHistoryInput;
}

/**
 * How much of one source's history to take.
 *
 * `null` means "leave this source's history alone" — the user said so, or
 * cancelled the picker, or there is nothing to take. A source with nothing to
 * list is not asked about, and nothing of it is read: without an answer there is
 * no scope to read under.
 */
async function askHistory(
	dialog: MigrationDialogBridge,
	source: MigrationSourceId,
	ctx: MigrationWizardContext,
): Promise<HistoryTake | null> {
	const home = ctx.home ?? homedir();
	const label = MIGRATION_SOURCE_LABELS[source];
	const listing = listHistory(source, home, { cwd: ctx.cwd, scope: "all" });
	if (listing.candidates.length === 0) return null;
	const here = listing.candidates.filter((candidate) => sameProject(candidate.cwd, ctx.cwd));
	const newest = listing.candidates.slice(0, DEFAULT_HISTORY_LIMIT);

	const answers = await dialog.askUser([
		{
			question: `Which ${label} conversations should come across?`,
			header: "History",
			options: [
				{
					label: `Only this project (${here.length})`,
					description: "sessions and recalled prompts from this directory",
				},
				{
					label: `Everything (${listing.candidates.length})`,
					description: `newest ${DEFAULT_HISTORY_LIMIT} per source, plus the prompts it remembers`,
				},
				{ label: "Choose sessions…", description: "pick from the most recent" },
				{ label: "Skip history", description: `${label} settings still come across` },
			],
		},
	]);
	if (!answers) return null;
	const answer = answers[0] ?? "";
	if (answer === "Skip history") return null;

	let scope: HistoryScope = "all";
	// Prompt scope follows the session scope, which is the same decision once more:
	// one directory, or everywhere the source remembers.
	let promptScope: HistoryScope = "all";
	let promptCwd = ctx.cwd;
	let selected: string[] | undefined;
	if (answer.startsWith("Only this project")) {
		scope = "cwd";
		promptScope = "cwd";
	} else if (answer === "Choose sessions…") {
		// Entry 0 stands for the whole list, so the cap does not have to be turned
		// into a question of its own.
		const items: MigrationDialogItem[] = [
			{ label: `All of them (newest ${newest.length})`, description: "subject to the import limit" },
			...newest.map((candidate) => ({ label: sessionLabel(candidate) })),
		];
		const index = await dialog.pickFromList(`${label} sessions`, items);
		if (index === null) return null;
		if (index > 0) {
			const picked = newest[index - 1];
			selected = [picked.sourceId];
			// One conversation, chosen out of the list: its prompts come from the
			// directory it happened in, not from every directory on the machine.
			if (picked.cwd) {
				promptScope = "cwd";
				promptCwd = picked.cwd;
			}
		}
		// Entry 0 is "all of them", which is the "Everything" answer with a name.
	}

	const result = collectHistory(source, home, {
		cwd: ctx.cwd,
		scope,
		limit: DEFAULT_HISTORY_LIMIT,
		selected,
	});
	if (result.sessions.length === 0) {
		// The user asked for this source's history and it converted to nothing.
		// Saying so beats an empty section they would read as success.
		const why = result.notes.map((note) => `${note.reason} — ${note.count}`).join("; ");
		ctx.report(`${label}: no sessions imported${why ? ` (${why})` : ""}`);
		return null;
	}
	return {
		history: result,
		prompts: readPromptHistory(source, home, {
			cwd: promptCwd,
			scope: promptScope,
			limit: DEFAULT_PROMPT_HISTORY_LIMIT,
		}),
	};
}

/** Ask the source, category and history questions, then plan and confirm. */
export async function runMigrationWizard(ctx: MigrationWizardContext): Promise<string | undefined> {
	const home = ctx.home ?? homedir();

	const detected = detectSources(home);
	if (detected.length === 0) return "No source configuration found. Nothing to import.";

	// Not asked when there is nothing to ask about: a machine with no source at
	// all is answered above, without a question whose only answer is "no".
	const everything = await askImportEverything(ctx.dialog, detected);
	if (everything === null) return "Migration cancelled — nothing was read or written.";

	const sources = everything ? detected : await askSources(ctx.dialog, detected);
	if (!sources) return "Migration cancelled — nothing was read or written.";
	if (sources.length === 0) return "No source selected — nothing to import.";

	// The shortcut's answers: every detected source, every category. `--only all`
	// and `--from all` mean the same thing to the runner.
	const categories = everything ? [...MIGRATION_CATEGORIES] : await askCategories(ctx.dialog);
	if (!categories) return "Migration cancelled — nothing was read or written.";
	if (categories.length === 0) return "No category selected — nothing to import.";

	const history: HistoryImport = {};
	const promptHistory: PromptHistoryImport = {};
	if (categories.includes("history")) {
		for (const source of sources) {
			const taken = await askHistory(ctx.dialog, source, ctx);
			if (!taken) continue;
			history[source] = taken.history;
			promptHistory[source] = taken.prompts;
		}
	}

	const options = {
		home,
		only: categories,
		from: sources.join(","),
		history,
		// Both history inputs were read above, from the answers the user gave. The
		// scope here only says the category is on — the per-source scopes travelled
		// with the entries themselves — and passing the prompts in keeps the dry run
		// and the write from reading the sources twice.
		promptHistory,
		historyScope: "all",
	};

	const preview = runMigration(options);
	if (preview.error) return preview.error;
	ctx.report(preview.report);
	// Nothing to confirm: the report above already says why each candidate was
	// left alone, and asking to apply zero files is a question with one answer.
	if (preview.plan.writes.length === 0) return "Nothing to write — the report above says why.";

	const answers = await ctx.dialog.askUser([
		{
			question: `Apply these ${preview.plan.writes.length} file(s)?`,
			header: "Confirm",
			options: [
				{ label: "Apply", description: "write them now" },
				{ label: "Cancel", description: "keep the dry run" },
			],
		},
	]);
	if (answers?.[0] !== "Apply") return "Nothing written (dry run only).";

	const applied = runMigration({ ...options, apply: true });
	if (applied.error) return applied.error;
	return `${applied.report}\n\nRestart to pick up the imported configuration.`;
}
