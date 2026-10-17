/**
 * The key list behind `?` and the one-line hint under the prompt.
 *
 * The rows are spelled out here rather than scraped from the components, so this
 * file is the single place that can drift from reality — which is why the
 * overlay test walks every advertised key. A shortcut list that lies is worse
 * than no list.
 */
import { MODE_CHOICES } from "@labunbun/agent";
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
	// Under emacs the engine claims `C-r` as reserved isearch, so the key never
	// reaches history search — the overlay's Ctrl+R row says so at length, and the
	// hint must not say the opposite in the smaller font. The other two editors
	// keep the clause: with no editor the host owns the key, and with vim it is
	// search in insert mode (redo lives in the overlay's Vim group).
	const search = opts.editor === "emacs" ? "" : " · ctrl+r search";
	if (columns >= HINT_FULL_MIN_COLUMNS) {
		return `Enter send · Shift+Enter newline · ↑↓ history${search} · ${esc} · /help`;
	}
	if (columns >= HINT_SHORT_MIN_COLUMNS) return `Enter send · ↑↓ history${search} · ${esc} · /help`;
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
				// Its own row rather than a parenthetical on the Tab row above,
				// because the two are different keys that arrive as the same Ink flag
				// with one modifier apart, and the modifier is the whole of the
				// difference. A row that read "complete · change mode" would be a
				// sentence about a key nobody presses.
				//
				// The four names are read out of `MODE_CHOICES` rather than typed here,
				// because this file's own header is about lists that drift and a
				// hand-written arrow chain is the same class of bug: a fifth row would
				// leave the overlay promising a cycle it no longer has.
				["Shift+Tab", `cycle permission mode (${MODE_CHOICES.map((c) => c.label).join(" → ")})`],
				// This row said "taken" until the claim was measured, and the
				// measurement said otherwise. `EmacsEngine` does reserve `C-o`
				// (`emacs.ts`, `RESERVED_KEYS`), but the claim is made inside the
				// prompt's own `useInput`, and ink hands every key to every active
				// hook separately (`node_modules/ink/build/hooks/use-input.js:115-123`):
				// the engine silences the prompt's later branches and nothing else.
				// The REPL's handler still receives the key, and the transcript opens
				// under emacs exactly as it does with no editor — measured, in the
				// frame, in `packages/tui/test/watch-panel.test.tsx`. The honest row
				// says both facts. (The `Ctrl+R` row above is the case where "taken"
				// *is* the truth, because history search is a prompt-level branch and
				// that is the one the engine suppresses.)
				["Ctrl+O", emacs ? "transcript — the engine also claims C-o, and the REPL still gets the key" : "transcript"],
				// The same correction one key later: `C-t` is reserved
				// `transpose-chars` there, and the panel opens anyway. Under vim both
				// keys work without a caveat — a ctrl combo that is not one of the few
				// the engine runs is handed to the host on purpose.
				["Ctrl+T", emacs ? "watch panel — the engine also claims C-t, and the REPL still gets the key" : "watch panel"],
				// The one host key neither engine contests — vim's ctrl block
				// forwards everything but C-r, and the emacs engine binds no C-v at
				// all — so unlike the two rows above this one needs no "taken"
				// caveat. The open question is the terminal, not the editor:
				// Windows Terminal may claim C-v as paste before the app sees it,
				// which is a real-machine check the design page records.
				["Ctrl+V", "watch panel: cycle source (shells → subagents → status)"],
				// The jump key, and the second row that depends on the editor. The
				// engine claims it first: `M-1`..`M-9` are `digit-argument` in
				// `EmacsEngine` (`emacs.ts:1292-1296`), and because ink delivers each
				// key to both the engine and the REPL, the REPL's jump branch stands
				// down under emacs rather than letting one press both arm a count and
				// move the panel. So under emacs the key is the engine's, and the row
				// says so in the vocabulary the `Ctrl+R` row uses.
				[
					"Alt+1..9",
					emacs ? "taken — M-1..9 arms a count in the prompt (see the Emacs group)" : "watch panel: jump to that shell",
				],
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
		// Only what the engine *runs*. It also claims `C-t`, `M-z` and the rest of its reserved
		// table — `C-o` among them, where the binding is `open-line`, not the `C-x C-o` below —
		// consuming them so they cannot fall through as stray characters, so naming them here as
		// if they worked would be the same lie in a new place. They are left out rather than
		// listed as pending.
		groups.push({
			title: "Emacs",
			rows: [
				["C-a / C-e", "start / end of line"],
				["C-f / C-b", "character forward / back"],
				["C-n / C-p", "line down / up"],
				["M-f / M-b", "word forward / back"],
				// uemacs's `goto-matching-fence`; GNU gives the key to `forward-sexp`. The
				// divergence is named on the command in `emacs.ts`, where the key is taken.
				["M-C-F", "jump to the matching bracket"],
				["M-u / M-l / M-c", "upcase / downcase / capitalize word"],
				// GNU's `transpose-words` on its own key, and uemacs's `transpose-chars`
				// relocated from the watch panel's `C-t`; `emacs.ts` records both decisions.
				["M-t", "transpose the word at point with the next"],
				["M-o", "transpose the characters around point (uemacs's C-t)"],
				["C-k", "kill to end of line"],
				["C-w", "kill region"],
				["M-w", "copy region as kill"],
				["M-C-w", "make the next kill append"],
				["C-d / C-h", "delete forward / back"],
				["C-y / M-y", "yank / rotate the kill ring"],
				["C-u", "count prefix (×4 per press)"],
				["M-1..9 / M--", "digit prefix / negative"],
				["C-SPC", "set mark; twice toggles the region"],
				// uemacs's spellings of the same command; GNU binds these two keys to
				// `cycle-spacing` and `xref-find-definitions` instead, and the engine notes
				// the divergence where the keys are taken.
				["M-SPC / M-.", "set mark; the same command as C-SPC"],
				["C-x C-x", "exchange point and mark"],
				// The second implemented member of `ctl-x-map`. Its two aliases are the ones
				// this build cannot have: `C-/` is not a byte most terminals send, and `C-_`
				// is the byte a terminal sends for `M--`, which is `negative-argument` here.
				// `emacs.ts` says so where the two decisions are made.
				["C-x u", "undo"],
				["C-x C-u / C-x C-l", "upcase / downcase the region"],
				["C-x C-o", "delete blank lines around point"],
				// Listed with the caveat rather than left out, because it is Emacs's `dd`
				// and a reader coming from Emacs will look for it — but `EmacsKey` has to be
				// told to set `ctrlShiftBackspace`, and no terminal sends the combination,
				// so a user pressing it here may get nothing at all. Saying so is the point.
				["C-S-BS", "kill whole line (most terminals never send it)"],
				// The uemacs alias for the command `[C-backspace]` above runs (GNU gives the
				// key to `mark-defun`). Same reachability caveat: meta and ctrl have to
				// arrive together for the engine to see it.
				["M-C-H", "kill the word before (most terminals never send it)"],
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
