/**
 * The watch panel: one source out of the background world, read-only — a
 * shell's tail, the subagent listing, or the session's cost/context facts.
 *
 * A dev server outlives the turn that started it, which is why the status row
 * keeps counting it — but "still running" is not the question someone watching a
 * build is asking. This started as the answer to "what is it saying now",
 * inside the frame that already repaints on every keystroke, so it can be read
 * while the prompt keeps being used. **It takes no keys itself** — no
 * `useInput`, no `isActive` guard to get wrong — which is the half of the
 * reason it can sit beside a working prompt: every key it does not want is a
 * key the prompt never loses. The other half is that the one key that moves
 * it, Ctrl+V, belongs to the REPL: the press walks the ring there and comes
 * back in through the `selection` prop, so a panel of several sources is still
 * not a component that owns a key.
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
 * {@link selectWatchShell} until a selection arrives; nothing here reads a
 * file, spawns a timer or reaches the shell manager — that is the app layer's
 * half, and it is why this file has no import from `@labunbun/tools`. The
 * watched shell is marked, not chosen: its header row opens on a `▶` gutter
 * (every other row carries a blank column there, so the headers stay aligned)
 * and it is the only row so marked, which is what tells a reader whose tail
 * the rows below belong to. The gutter also carries the shell's number — the
 * one `Alt+<n>` jumps to ({@link jumpWatchSelection}) — so the key's map is on
 * the screen it moves. The walk across sources and the jump are the REPL's;
 * what lives here is the ring it walks ({@link watchRing}), the one-step rule
 * ({@link nextWatchSelection}) and the jump rule — pure functions, because a
 * cycle that can only be exercised through a terminal is a cycle half of whose
 * edges are never tested.
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
 * What the panel is showing: one stop of the source ring.
 *
 * A shell stop is an identity — a shell id, not an index — because the list
 * reorders itself as shells start and end, and a positional pick would
 * silently slide onto a different shell between two ticks. The other two stops
 * are singletons: kinds without ids.
 */
export type WatchSelection = { kind: "shell"; id: string } | { kind: "subagents" } | { kind: "status" };

/**
 * The cycle: every shell in the order the manager lists them — each one's own
 * tail — then the subagent listing, then the session facts, wrapping back to
 * the first shell. Shells come first because the panel existed for them, and
 * no shells at all is a ring of two, not an error: the other two stops answer
 * questions that do not depend on a shell ever having run.
 */
export function watchRing(shells: UiBackgroundShell[]): WatchSelection[] {
	const ring: WatchSelection[] = shells.map((shell) => ({ kind: "shell", id: shell.id }));
	ring.push({ kind: "subagents" }, { kind: "status" });
	return ring;
}

/**
 * The stop one Ctrl+V press moves to. `null` is the state before the first
 * press — the shell {@link selectWatchShell} picked on its own — and the walk
 * starts *after* it, so the first press moves on rather than repeating what is
 * already on screen. A pick whose shell has left the list restarts at the
 * ring's first stop: the pick is an identity, and an identity with nothing
 * behind it points at nothing — the alternative, treating the old index as a
 * position, would land on whichever shell slid into that slot.
 */
export function nextWatchSelection(shells: UiBackgroundShell[], current: WatchSelection | null): WatchSelection {
	const ring = watchRing(shells);
	if (!current) {
		const auto = selectWatchShell(shells);
		const index = auto ? ring.findIndex((stop) => stop.kind === "shell" && stop.id === auto.id) : -1;
		return ring[(index + 1) % ring.length];
	}
	const index = ring.findIndex((stop) => sameStop(stop, current));
	return ring[(index + 1) % ring.length];
}

/** Stop identity: the kind, and for a shell the id — never the position. */
function sameStop(a: WatchSelection, b: WatchSelection): boolean {
	if (a.kind === "shell") return b.kind === "shell" && a.id === b.id;
	return a.kind === b.kind;
}

/**
 * The stop `Alt+<n>` jumps to: the nth shell in the manager's order — the same
 * order, and the same numbering, the headers carry in their gutters.
 *
 * Shells only. The other two stops are not numbered on screen, so a number
 * cannot name them; the key is the gutter read aloud, not a second ring.
 *
 * `null` for a number past the list — including every number when there are no
 * shells: the caller keeps the selection it has, because the alternative, some
 * nearest stop, would make `Alt+9` with three shells land somewhere the user
 * did not name. A press that names nothing does nothing.
 */
export function jumpWatchSelection(shells: UiBackgroundShell[], n: number): WatchSelection | null {
	// The number is 1-based because that is what is drawn; the list is not.
	const picked = shells[n - 1];
	return picked ? { kind: "shell", id: picked.id } : null;
}

/**
 * What the panel is looking at, in the panel: a row of the store, not a live
 * read. The interval is the publisher's (`BACKGROUND_SHELL_POLL_MS`), and it is
 * spelled out here rather than imported, because the TUI does not depend on the
 * app layer — if the two ever disagree, this line is the one that is wrong, and
 * a wrong sentence about staleness beats no sentence at all.
 *
 * The cycle hint rides on this row because this is the row that is never cut,
 * and the panel is where the question gets asked: a key that changes what is
 * on screen should say on the screen that it exists.
 */
const POLL_NOTE = "as of last poll (2s) · ctrl+v cycles";

/**
 * The panel. Handed the published rows, the selection, and nothing else.
 *
 * Layout, top to bottom: the poll note (which doubles as the cycle key's one
 * always-visible telling), then the stop. For a shell stop: one header per
 * shell with the watched shell's row opening on a `▶` gutter, then the tail of
 * that same shell — the note is never what gets cut, the headers are cut to
 * whole rows, and the tail takes what is left, down to nothing on a terminal
 * with no room to spare. For the other stops the published lines are drawn
 * from the top and cut from the bottom, because those lists are ordered
 * most-interesting-first, while a tail ends at its newest line.
 */
export function WatchPanel({
	shells,
	selection = null,
	subagentLines = [],
	statusLines = [],
}: {
	shells: UiBackgroundShell[];
	/** The stop Ctrl+V moved to; `null` while the automatic shell still stands. */
	selection?: WatchSelection | null;
	/** The published subagent rows, counts line first (see `formatSubagentWatchLines`). */
	subagentLines?: string[];
	/** The published session facts, one per line (model, cost, context, cache). */
	statusLines?: string[];
}) {
	const theme = useTheme();
	const { columns, rows } = useWindowSize();
	// The frame inside the border: everything below is budgeted in these rows.
	const inner = Math.max(0, watchPanelHeight(rows) - 2);
	// The stop on screen. A picked shell that has left the list falls back to
	// the automatic answer rather than to a neighbour: the pick is an identity,
	// and "the one I chose is gone" must not silently become "here is another
	// one". `null` means there is no shell to watch at all — the empty-list
	// case, which the shells stop draws as a sentence.
	const pickedId =
		selection?.kind === "shell" && shells.some((shell) => shell.id === selection.id) ? selection.id : null;
	const shellId = pickedId ?? selectWatchShell(shells)?.id;
	const stop: WatchSelection | null =
		selection?.kind === "subagents" || selection?.kind === "status"
			? selection
			: shellId !== undefined
				? { kind: "shell", id: shellId }
				: null;
	// Border on both sides and one column of padding inside each: the width left
	// for text. The `- 4` matches the box's own geometry below.
	const width = Math.max(8, columns - 4);

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
			<Text dimColor wrap="truncate">
				{POLL_NOTE}
			</Text>
			{stop === null ? (
				<Text wrap="truncate">No background shells.</Text>
			) : stop.kind === "shell" ? (
				<ShellStop shells={shells} watched={stop.id} inner={inner} width={width} />
			) : (
				// The cut keeps the head, not the tail: these lists are ordered
				// most-interesting-first (running subagents on top, the counts line
				// above all), while a shell's tail ends at its newest line. An
				// unpublished stop falls back to the sentence the publisher would
				// have sent — the same words either way, so "nothing has run" reads
				// the same whether the reason is the fleet or the first tick.
				(stop.kind === "subagents"
					? subagentLines.length > 0
						? subagentLines
						: ["No subagents have run in this session."]
					: statusLines.length > 0
						? statusLines
						: ["No session facts yet."]
				)
					.slice(0, Math.max(0, inner - 1))
					.map((line, index) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: a cut list has no id of its own — the pair of position and text is what identifies a row, and the text is in the key precisely because it changes.
							key={`${index}\u0000${line}`}
							wrap="truncate"
						>
							{cut(line, width)}
						</Text>
					))
			)}
		</Box>
	);
}

/**
 * The shells stop: every published shell's header, then the watched shell's
 * tail.
 *
 * Every shell gets a row, not just the watched one — the list is what makes
 * the watched shell's absence, when it ends, legible. The tail is what remains
 * after every shell has a header, not just the ones that fit: headers that
 * would have been cut are not silently paid for by the tail, so a panel this
 * small shows who is running and no more.
 */
function ShellStop({
	shells,
	watched,
	inner,
	width,
}: {
	shells: UiBackgroundShell[];
	watched: string;
	inner: number;
	width: number;
}) {
	const shownShells = shells.slice(0, Math.max(0, inner - 1));
	const tailRows = Math.max(0, inner - 1 - shells.length);
	const watchedShell = shells.find((shell) => shell.id === watched);
	const tail = watchedShell ? watchedShell.tail.slice(-tailRows) : [];

	return (
		<>
			{shownShells.map((shell, index) => (
				// Keyed by the shell id: two shells cannot share one, and a shell that
				// ends leaves the list entirely rather than changing into another.
				<Text key={shell.id} wrap="truncate">
					{/* The marker and the tail compare against the one `watched` id this
					render already resolved, so they cannot disagree about which shell
					is being read. The index is the row's position, which is the one
					thing `Alt+<n>` and the printed number both mean. */}
					{shellHeader(shell, width, index, shell.id === watched)}
				</Text>
			))}
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
		</>
	);
}

/** The gutter on the header of the shell whose tail is on screen. */
const SELECTED_GUTTER = "▶";
/** The gutter on every other header: one blank column, so the rows stay aligned. */
const PLAIN_GUTTER = " ";

/**
 * The gutter's second column: the shell's number, the one `Alt+<n>` jumps to.
 *
 * Nine shells are what the key has keys for, so a tenth row on is drawn as `·`
 * — the column stays two characters wide and the rows stay aligned, instead of
 * a two-digit number no press can name widening every row's gutter.
 *
 * Exported for its own test rather than left to the frame: the panel's row
 * budget caps the list at nine headers ({@link watchPanelHeight} asks for
 * twelve rows, minus the border and the note), so the `·` edge cannot be
 * reached by any terminal the component can be rendered in today. It is the
 * rule that keeps the gutters aligned on the day that budget moves, and an
 * edge no frame can draw is exactly the kind a test has to hold directly.
 */
export function jumpDigit(index: number): string {
	return index < 9 ? String(index + 1) : "·";
}

/**
 * One shell's header row: who, what, and whether it is still going.
 *
 * The row opens on a two-column gutter — `▶` or a blank column, then the
 * shell's number — which is what tells a reader whose tail the rows below
 * belong to, and which key jumps to this same row. The gutter is folded into
 * the width budget (it rides in {@link before}), so it costs the command
 * exactly two columns of room and the elision is otherwise untouched.
 *
 * The command is the only part that may be elided. The id and the status word
 * are what the row is for — a wide command that pushed "running" off the edge
 * would be a row that answers neither of the two questions a watcher has.
 */
function shellHeader(shell: UiBackgroundShell, width: number, index: number, selected: boolean): string {
	const before = `${selected ? SELECTED_GUTTER : PLAIN_GUTTER}${jumpDigit(index)} ${shell.id}  `;
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
