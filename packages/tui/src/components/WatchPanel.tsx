/**
 * The watch panel: the tail of one background shell, read-only.
 *
 * A dev server outlives the turn that started it, which is why the status row
 * keeps counting it — but "still running" is not the question someone watching a
 * build is asking. This is the answer to "what is it saying now", inside the
 * frame that already repaints on every keystroke, so it can be read while the
 * prompt keeps being used. **It takes no keys at all** — no `useInput`, no
 * `isActive` guard to get wrong — which is the whole reason it can sit beside a
 * working prompt: every key it does not want is a key the prompt never loses.
 *
 * Three things it is careful about:
 *
 * **It is a snapshot, and it says so.** The data arrives on the host's two-second
 * poll (the manager has no change events), and a shell that ended between ticks
 * is still drawn as running. The panel cannot fix that by polling harder — the
 * cadence belongs to the publisher — so it names its own age instead: see
 * {@link POLL_NOTE}. The note is the first row rather than the last, because a
 * body that outgrows the budget is cut from the bottom.
 *
 * **It budgets its rows and never exceeds them.** The frame under the sealed
 * transcript is shared with the live output tail, the status block and the
 * prompt, and the frame reaching the viewport height is what makes ink clear and
 * reprint the session's scrollback on Windows. {@link watchPanelHeight} is the
 * clamp and {@link WATCH_PANEL_RESERVE_ROWS} itemizes what is being kept out of
 * the panel's reach.
 *
 * **It renders what it was handed.** Which shell the tail belongs to is
 * {@link selectWatchShell}; nothing here reads a file, spawns a timer or reaches
 * the shell manager — that is the app layer's half, and it is why this file has
 * no import from `@labunbun/tools`.
 */
import { Box, Text, useWindowSize } from "ink";
import { useTheme } from "../theme.ts";
import type { UiBackgroundShell } from "../ui-state.ts";

/** Rows the panel asks for when the terminal can spare them. */
export const WATCH_PANEL_DESIRED_ROWS = 12;

/**
 * Rows kept out of the panel's reach, because everything below the sealed
 * transcript shares one frame and a panel that took them would push that frame
 * to the terminal's height — which is where ink stops diffing and starts
 * clearing and reprinting. The three claims: a live output tail at its worst
 * realistic case (three lines), the status block with its detail row (two), and
 * a prompt that has wrapped once (three). Itemized here rather than tuned
 * invisibly, because this number is the feature's whole exposure.
 */
export const WATCH_PANEL_RESERVE_ROWS = 8;

/**
 * How many rows the panel may occupy, its own border included.
 *
 * Three is the floor: a panel that could shrink to nothing would be a toggle key
 * that visibly did nothing on a short terminal, which is a worse answer than a
 * small panel that still says what it is.
 */
export function watchPanelHeight(rows: number): number {
	return Math.max(3, Math.min(WATCH_PANEL_DESIRED_ROWS, rows - WATCH_PANEL_RESERVE_ROWS));
}

/**
 * Which shell the tail belongs to: the last one still running in the order the
 * manager lists them (start order), and the last one there is when none is. A
 * finished shell's output is still the answer to "what did it say", which is
 * exactly when it is worth reading — so the fallback is not a degraded case.
 * `undefined` only for an empty list.
 */
export function selectWatchShell(shells: UiBackgroundShell[]): UiBackgroundShell | undefined {
	for (let i = shells.length - 1; i >= 0; i--) {
		if (shells[i].status === "running") return shells[i];
	}
	return shells[shells.length - 1];
}

/**
 * What the panel is looking at, in the panel: a row of the store, not a live
 * read. The interval is the publisher's (`BACKGROUND_SHELL_POLL_MS`), and it is
 * spelled out here rather than imported, because the TUI does not depend on the
 * app layer — if the two ever disagree, this line is the one that is wrong, and
 * a wrong sentence about staleness beats no sentence at all.
 */
const POLL_NOTE = "as of last poll (2s)";

/**
 * The panel. Handed the published rows and nothing else.
 *
 * Layout, top to bottom: the poll note, one header per shell, then the tail of
 * the selected shell. The note is never what gets cut, the headers are cut to
 * whole rows, and the tail takes what is left — down to nothing on a terminal
 * with no room to spare.
 */
export function WatchPanel({ shells }: { shells: UiBackgroundShell[] }) {
	const theme = useTheme();
	const { columns, rows } = useWindowSize();
	// The frame inside the border: everything below is budgeted in these rows.
	const inner = Math.max(0, watchPanelHeight(rows) - 2);
	// One row is the note's, before anything else is promised a row.
	const shownShells = shells.slice(0, Math.max(0, inner - 1));
	// The tail is what remains after every shell has a header — not just the ones
	// that fit. Headers that would have been cut are not silently paid for by the
	// tail: a panel this small shows who is running and no more.
	const tailRows = Math.max(0, inner - 1 - shells.length);
	const selected = selectWatchShell(shells);
	const tail = selected ? selected.tail.slice(-tailRows) : [];
	// Border on both sides and one column of padding inside each: the width left
	// for text. The `- 4` matches the box's own geometry below.
	const width = Math.max(8, columns - 4);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
			<Text dimColor wrap="truncate">
				{POLL_NOTE}
			</Text>
			{shells.length === 0 ? (
				<Text wrap="truncate">No background shells.</Text>
			) : (
				shownShells.map((shell) => (
					// Keyed by the shell id: two shells cannot share one, and a shell that
					// ends leaves the list entirely rather than changing into another.
					<Text key={shell.id} wrap="truncate">
						{shellHeader(shell, width)}
					</Text>
				))
			)}
			{tail.map((line, index) => (
				<Text
					// biome-ignore lint/suspicious/noArrayIndexKey: a sliding window has no id of its own — the pair of position and text is what identifies a row, and the text is in the key precisely because it changes.
					key={`${index}\u0000${line}`}
					dimColor
					wrap="truncate"
				>
					{cut(line, width)}
				</Text>
			))}
		</Box>
	);
}

/**
 * One shell's header row: who, what, and whether it is still going.
 *
 * The command is the only part that may be elided. The id and the status word
 * are what the row is for — a wide command that pushed "running" off the edge
 * would be a row that answers neither of the two questions a watcher has.
 */
function shellHeader(shell: UiBackgroundShell, width: number): string {
	const before = `${shell.id}  `;
	const after = `  ${shell.status}`;
	const room = Math.max(0, width - before.length - after.length);
	return `${before}${elide(shell.command, room)}${after}`;
}

/** A command is one line by the time it is drawn, however many it was written on. */
function elide(command: string, room: number): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	if (oneLine.length <= room) return oneLine;
	return cut(oneLine, room);
}

/** Cut to one row, with the ellipsis inside the room it is given. */
function cut(text: string, room: number): string {
	if (room <= 0) return "";
	if (text.length <= room) return text;
	if (room === 1) return "…";
	return `${text.slice(0, room - 1)}…`;
}
