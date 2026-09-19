/**
 * The key list behind `?` and the one-line hint under the prompt.
 *
 * The rows are spelled out here rather than scraped from the components, so this
 * file is the single place that can drift from reality — which is why the
 * overlay test walks every advertised key. A shortcut list that lies is worse
 * than no list.
 */
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
 */
export function escapeHint(vim: boolean, vimMode: VimMode): string {
	if (!vim) return "Esc interrupt";
	if (vimMode === "insert") return "Esc normal";
	if (vimMode.startsWith("visual")) return "Esc cancel";
	return "Esc interrupt";
}

/**
 * The prompt's key hint, folded to what fits. Three tiers rather than wrapping:
 * a hint that spills onto a second line pushes the prompt up and down as the
 * user resizes, and the terminal is the one place it cannot be reflowed later.
 */
export function hintLine(columns: number, opts: { vim: boolean; vimMode: VimMode }): string {
	const esc = escapeHint(opts.vim, opts.vimMode);
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
	vim: boolean;
	vimMode?: VimMode;
	commands?: Array<[string, string]>;
}): ShortcutGroup[] {
	const groups: ShortcutGroup[] = [
		{
			title: "Prompt",
			rows: [
				["Enter", "send"],
				["Shift+Enter", "newline"],
				["↑ / ↓", "history"],
				["Ctrl+R", opts.vim ? "search history (redo in vim normal)" : "search history"],
				["Esc", escapeHint(opts.vim, opts.vimMode ?? "insert")],
				["Tab", opts.vim ? "complete (insert mode)" : "complete command or file"],
				["Ctrl+O", "transcript"],
				["Ctrl+L", "clear screen"],
				["Ctrl+C", "exit (twice when idle)"],
			],
		},
	];
	if (opts.vim) {
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
