/**
 * The key list behind `?` and the one-line hint under the prompt.
 *
 * The rows are spelled out here rather than scraped from the components, so this
 * file is the single place that can drift from reality — which is why the
 * overlay test walks every advertised key. A shortcut list that lies is worse
 * than no list.
 */
import type { EditorKind } from "./editing-mode.ts";
import type { VimMode } from "./vim.ts";

export interface ShortcutGroup {
	title: string;
	rows: Array<[keys: string, what: string]>;
}

/** Above this the hint can afford the full clause list. */
export const HINT_FULL_MIN_COLUMNS = 90;
/** Below this only what a first-time user needs survives. */
export const HINT_SHORT_MIN_COLUMNS = 60;
/** Above this the `?` overlay lays its groups out in two columns. */
export const SHORTCUT_TWO_COLUMN_MIN_COLUMNS = 72;

/**
 * What Escape does right now. With vim it depends on the mode: leaving insert or
 * cancelling a selection never reaches the session's interrupt, so one fixed
 * "Esc interrupt" was wrong half the time.
 *
 * Emacs is the case that looks like it should differ and does not. There is no
 * mode to leave, so `EmacsEngine` declines the key and the REPL's own interrupt
 * stands — the same answer the no-editor case gives, reached for a different
 * reason.
 */
export function escapeHint(editor: EditorKind, vimMode: VimMode): string {
	if (editor !== "vim") return "Esc interrupt";
	if (vimMode === "insert") return "Esc normal";
	if (vimMode.startsWith("visual")) return "Esc cancel";
	return "Esc interrupt";
}

/**
 * The prompt's key hint, folded to what fits. Three tiers rather than wrapping:
 * a hint that spills onto a second line pushes the prompt up and down as the
 * user resizes, and the terminal is the one place it cannot be reflowed later.
 */
export function hintLine(columns: number, opts: { editor: EditorKind; vimMode: VimMode }): string {
	const esc = escapeHint(opts.editor, opts.vimMode);
	if (columns >= HINT_FULL_MIN_COLUMNS) {
		return `Enter send · Shift+Enter newline · ↑↓ history · ctrl+r search · ${esc} · /help`;
	}
	if (columns >= HINT_SHORT_MIN_COLUMNS) return `Enter send · ↑↓ history · ctrl+r search · ${esc} · /help`;
	return `Enter send · ${esc} · /help`;
}

/**
 * Every group the overlay shows. `commands` is the caller's merged command table
 * (built-ins plus whatever the app layer registered), so `/help` and this list
 * cannot disagree about what a command is called.
 */
export function shortcutGroups(opts: {
	editor: EditorKind;
	vimMode?: VimMode;
	commands?: Array<[string, string]>;
}): ShortcutGroup[] {
	const vim = opts.editor === "vim";
	const emacs = opts.editor === "emacs";
	const groups: ShortcutGroup[] = [
		{
			title: "Prompt",
			rows: [
				["Enter", "send"],
				["Shift+Enter", "newline"],
				["↑ / ↓", "history"],
				// Three editors, three different answers, and the third is the one this
				// row used to get wrong. `EmacsEngine` *claims* `C-r` — it is in its
				// reserved table, so isearch is swallowed rather than passed through — which
				// means "search history" is false under emacs, not merely unavailable. A row
				// that names a command the key cannot reach is the failure this file's header
				// is about.
				[
					"Ctrl+R",
					vim
						? "search history (redo in vim normal)"
						: emacs
							? "taken — incremental search is not in this build"
							: "search history",
				],
				["Esc", escapeHint(opts.editor, opts.vimMode ?? "insert")],
				// "insert mode" was the mode name when there was one editor and
				// nothing else could be true; under Emacs the parenthetical would
				// be false, so it is a fact about vim and stays under vim.
				["Tab", vim ? "complete (insert mode)" : "complete command or file"],
				["Ctrl+O", "transcript"],
				["Ctrl+L", "clear screen"],
				["Ctrl+C", "exit (twice when idle)"],
			],
		},
	];
	if (vim) {
		groups.push({
			title: "Vim",
			rows: [
				["i / a", "insert before / after"],
				["Esc", "leave insert"],
				["v / V", "character / line selection"],
				["Esc", "cancel selection"],
				["Ctrl+R", "redo"],
			],
		});
	}
	if (emacs) {
		// Only what the engine *runs*. It also claims `C-t`, `M-u`, `M-z`, `C-o` and the rest
		// of its reserved table, consuming them so they cannot fall through as stray
		// characters — so naming them here as if they worked would be the same lie in a new
		// place, and they are left out rather than listed as pending.
		groups.push({
			title: "Emacs",
			rows: [
				["C-a / C-e", "start / end of line"],
				["C-f / C-b", "character forward / back"],
				["C-n / C-p", "line down / up"],
				["M-f / M-b", "word forward / back"],
				["C-k", "kill to end of line"],
				["C-w", "kill region"],
				["M-w", "copy region as kill"],
				["M-C-w", "make the next kill append"],
				["C-d / C-h", "delete forward / back"],
				["C-y / M-y", "yank / rotate the kill ring"],
				["C-u", "count prefix (×4 per press)"],
				["M-1..9 / M--", "digit prefix / negative"],
				["C-SPC", "set mark; twice toggles the region"],
				["C-x C-x", "exchange point and mark"],
				// Listed with the caveat rather than left out, because it is Emacs's `dd`
				// and a reader coming from Emacs will look for it — but `EmacsKey` has to be
				// told to set `ctrlShiftBackspace`, and no terminal sends the combination,
				// so a user pressing it here may get nothing at all. Saying so is the point.
				["C-S-BS", "kill whole line (most terminals never send it)"],
			],
		});
	}
	if (opts.commands && opts.commands.length > 0) {
		groups.push({ title: "Commands", rows: opts.commands });
	}
	return groups;
}

/**
 * Split the groups into two columns of roughly equal height, for a wide
 * terminal. Groups are kept whole: half a key list under a heading is the kind
 * of layout that makes a reader think entries are missing.
 */
export function splitShortcutGroups(groups: ShortcutGroup[]): [ShortcutGroup[], ShortcutGroup[]] {
	const columns: [ShortcutGroup[], ShortcutGroup[]] = [[], []];
	const heights = [0, 0];
	for (const group of groups) {
		// Rows plus the title line, which is part of the column's height too.
		const height = group.rows.length + 1;
		const target = heights[0] <= heights[1] ? 0 : 1;
		columns[target].push(group);
		heights[target] += height;
	}
	return columns;
}
