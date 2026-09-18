/**
 * The interactive `/migrate` flow: ask what to bring over, show the plan, then
 * write only after the user has seen it.
 *
 * The wizard asks questions, it does not decide: every answer ends up as an
 * argument to `runMigration`, the same call the CLI makes, so the wizard cannot
 * import anything `labunbun migrate` would not.
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
	MIGRATION_SOURCE_LABELS,
	type MigrationCategory,
	type MigrationSourceId,
	runMigration,
} from "./migrate.ts";
import {
	collectHistory,
	DEFAULT_HISTORY_LIMIT,
	type HistoryImport,
	type HistoryInput,
	listHistory,
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
		detail: "writes resumable session files under ~/.labunbun/projects",
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
 * How much of one source's history to take.
 *
 * `null` means "leave this source's history alone" — the user said so, or
 * cancelled the picker, or there is nothing to take.
 */
async function askHistory(
	dialog: MigrationDialogBridge,
	source: MigrationSourceId,
	ctx: MigrationWizardContext,
): Promise<HistoryInput | null> {
	const label = MIGRATION_SOURCE_LABELS[source];
	const listing = listHistory(source, ctx.home ?? homedir(), { cwd: ctx.cwd, scope: "all" });
	if (listing.candidates.length === 0) return null;
	const here = listing.candidates.filter((candidate) => sameProject(candidate.cwd, ctx.cwd));
	const newest = listing.candidates.slice(0, DEFAULT_HISTORY_LIMIT);

	const answers = await dialog.askUser([
		{
			question: `Which ${label} conversations should come across?`,
			header: "History",
			options: [
				{ label: `Only this project (${here.length})`, description: "sessions whose working directory is this one" },
				{
					label: `Everything (${listing.candidates.length})`,
					description: `newest ${DEFAULT_HISTORY_LIMIT} per source`,
				},
				{ label: "Choose sessions…", description: "pick from the most recent" },
				{ label: "Skip history", description: `${label} settings still come across` },
			],
		},
	]);
	if (!answers) return null;
	const answer = answers[0] ?? "";
	if (answer === "Skip history") return null;

	let scope: "cwd" | "all" = "all";
	let selected: string[] | undefined;
	if (answer.startsWith("Only this project")) {
		scope = "cwd";
	} else if (answer === "Choose sessions…") {
		// Entry 0 stands for the whole list, so the cap does not have to be turned
		// into a question of its own.
		const items: MigrationDialogItem[] = [
			{ label: `All of them (newest ${newest.length})`, description: "subject to the import limit" },
			...newest.map((candidate) => ({ label: sessionLabel(candidate) })),
		];
		const index = await dialog.pickFromList(`${label} sessions`, items);
		if (index === null) return null;
		if (index > 0) selected = [newest[index - 1].sourceId];
	}

	const result = collectHistory(source, ctx.home ?? homedir(), {
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
	return result;
}

/** Ask the source, category and history questions, then plan and confirm. */
export async function runMigrationWizard(ctx: MigrationWizardContext): Promise<string | undefined> {
	const home = ctx.home ?? homedir();

	const detected = detectSources(home);
	if (detected.length === 0) return "No source configuration found. Nothing to import.";

	const sources = await askSources(ctx.dialog, detected);
	if (!sources) return "Migration cancelled — nothing was read or written.";
	if (sources.length === 0) return "No source selected — nothing to import.";

	const categories = await askCategories(ctx.dialog);
	if (!categories) return "Migration cancelled — nothing was read or written.";
	if (categories.length === 0) return "No category selected — nothing to import.";

	const history: HistoryImport = {};
	if (categories.includes("history")) {
		for (const source of sources) {
			const taken = await askHistory(ctx.dialog, source, ctx);
			if (taken) history[source] = taken;
		}
	}

	const options = {
		home,
		only: categories,
		from: sources.join(","),
		history,
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
