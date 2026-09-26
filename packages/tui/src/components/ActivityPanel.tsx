/**
 * The activity heatmap: one cell per day, one column per week, and the streak
 * counters under it.
 *
 * Everything about the arithmetic — which days a session covers, what the
 * quantiles are, where a streak starts — lives in `@labunbun/agent`. This file
 * is the half that has to be wrong in different ways, and it is worth naming
 * the two things it is careful about.
 *
 * **The month labels are placed by column, never spread.** The source this was
 * derived from divides the grid width by the number of months and `padEnd`s
 * each label to that share, so a label lands at an offset that has nothing to do
 * with the column it names: "Jan" ends up written over March's cells. A month
 * label here is written at `col * CELL_COLUMNS` — the first printed column of
 * the week whose Sunday starts the month — which is the only offset that means
 * anything. {@link monthLabelColumns} is the whole rule, and it is a pure
 * function so it can be pinned without a terminal.
 *
 * **The intensity scale is the collector's, and the panel never re-derives it.**
 * {@link intensityThresholds} returns `null` when every active day counts the
 * same, and {@link activityLevel} answers a flat level 2 for all of them. That
 * is the honest answer for an account with nothing to compare against, and a
 * panel that quietly recomputed quantiles over the cells it happens to be
 * drawing would replace it with a scale invented from the same uniform data —
 * which is the collapse {@link intensityThresholds} exists to prevent.
 *
 * The grid itself is a pure function too ({@link gridCells}), because the things
 * worth testing here — where today sits, which cells are blank because they are
 * the future, which channel a cell belongs to — are all arithmetic that a
 * snapshot of a terminal would only test through.
 */
import {
	type ActivityDay,
	type ActivityRange,
	type ActivityReport,
	activityLevel,
	civilDayNumber,
	collectActivity,
	intensityThresholds,
	localDayKey,
	startOfLocalDay,
	windowStartFor,
} from "@labunbun/agent";
import { Box, Text, useAnimation, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme.ts";
import type { Theme } from "../themes/tokens.ts";
import { FRAMES, SPINNER_INTERVAL_MS } from "./StatusLine.tsx";

/** Printed columns taken by the round border, one on each side. */
const BORDER_COLUMNS = 2;
/** Printed columns taken by `paddingX={1}`, one on each side. */
const PADDING_COLUMNS = 2;
/** Printed columns taken by the day-of-week gutter ("Mon "). */
const LABEL_COLUMNS = 4;

/**
 * Printed columns per cell: the glyph, and the gap that keeps `░▒▓█` from
 * running together into a bar. A month label's column offset is this times the
 * week index, so the two can never drift apart.
 */
export const CELL_COLUMNS = 2;

/** Fewest week columns worth drawing, however narrow the terminal is. */
export const MIN_GRID_COLUMNS = 10;
/** Most week columns — a year, which is the most a heatmap reads as a shape. */
export const MAX_GRID_COLUMNS = 52;

/** The five intensities, palest to fullest. */
export const LEVEL_GLYPHS = ["·", "░", "▒", "▓", "█"] as const;
export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Which of the collector's two channels a cell came from.
 *
 * - `empty` — nothing at all. Level 0.
 * - `touched` — a session that *started* on another day was still being written
 *   here. The mtime channel on its own, and the only one that has no message
 *   count to take a level from.
 * - `activity` — a session started here. The channel with a scale.
 */
export type CellChannel = "empty" | "touched" | "activity";

export interface GridCell {
	/** `YYYY-MM-DD`, local civil day, whatever the cell ended up showing. */
	date: string;
	level: ActivityLevel;
	channel: CellChannel;
	/** {@link LEVEL_GLYPHS} by level, or a space for a day that has not happened. */
	glyph: string;
	/** Past the end of today: nothing to report, and nothing to draw. */
	future: boolean;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** Rows that get a name in the gutter, so the grid does not spell out all seven. */
const LABELLED_ROWS = [1, 3, 5];

const MS_PER_DAY = 86_400_000;

/**
 * How many week columns fit in a terminal `columns` wide.
 *
 * The border, the padding and the gutter are subtracted first, and what is left
 * is divided by the two columns a cell occupies. Dividing rather than subtracting
 * is the difference between a panel that fits the window it was given and one
 * that wraps its own grid into two halves the moment the window is a normal
 * size; at 100 columns this returns 46, and the panel then draws in exactly the
 * 100 it was offered.
 */
export function gridWidth(columns: number): number {
	const available = (columns - BORDER_COLUMNS - PADDING_COLUMNS - LABEL_COLUMNS) / CELL_COLUMNS;
	return Math.min(MAX_GRID_COLUMNS, Math.max(MIN_GRID_COLUMNS, Math.floor(available)));
}

/** `YYYY-MM-DD` for a day number — the exact inverse of `civilDayNumber`. */
function dayKeyFromNumber(number: number): string {
	// Anchored in UTC so the string cannot be pulled a day sideways by the host's
	// offset; the calendar was already decided when the number was made.
	return new Date(Date.UTC(1970, 0, 1) + number * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Which channel a cell is drawn on.
 *
 * `touched` is the mtime channel with nothing behind it: no session started on
 * this day, but one that started earlier was still open. A day can only reach
 * that state by *not* having sessions, so the test is on `sessions` and not on
 * the level — a touched day is never level 0 ({@link activityLevel} counts a
 * touched day as active), and a rule that asked for level 0 here would be a rule
 * that never fired.
 */
export function cellChannel(day: ActivityDay | undefined, level: ActivityLevel): CellChannel {
	if (day === undefined || level === 0 || (day.sessions === 0 && !day.touched)) return "empty";
	return day.sessions === 0 ? "touched" : "activity";
}

/** The color a channel is drawn in: the accent for real activity, muted for the rest. */
export function cellColor(channel: CellChannel, theme: Theme): string {
	return channel === "activity" ? theme.accent : theme.textMuted;
}

/**
 * The grid: seven rows (Sunday to Saturday) by `width` week columns, with the
 * week holding today as the rightmost one.
 *
 * Days past today are blank rather than level 0 — a level-0 cell means "that day
 * had nothing", which is a claim, and there is nothing yet to claim about next
 * Tuesday. Days before the report's window are level 0, because that claim is
 * true as far as the panel can see.
 */
export function gridCells(days: readonly ActivityDay[], now: number, width: number): GridCell[][] {
	const byDate = new Map(days.map((day) => [day.date, day]));
	// The collector's scale, once, for the whole grid — and `null` is a real
	// answer, not a failure to compute one.
	const thresholds = intensityThresholds(days);
	const today = civilDayNumber(localDayKey(now));
	// `getDay` on local midnight, so the week starts on the user's Sunday and not
	// on UTC's.
	const weekday = new Date(startOfLocalDay(now)).getDay();
	const first = today - weekday - (width - 1) * 7;

	const grid: GridCell[][] = [];
	for (let row = 0; row < 7; row++) {
		const line: GridCell[] = [];
		for (let col = 0; col < width; col++) {
			const number = first + col * 7 + row;
			const date = dayKeyFromNumber(number);
			const future = number > today;
			const day = future ? undefined : byDate.get(date);
			const level = day === undefined ? 0 : activityLevel(day, thresholds);
			const channel: CellChannel = future ? "empty" : cellChannel(day, level);
			line.push({ date, level, channel, glyph: future ? " " : LEVEL_GLYPHS[level], future });
		}
		grid.push(line);
	}
	return grid;
}

/** Anything with a day key — the collector's `ActivityDay` and this panel's `GridCell` both qualify. */
export interface Dated {
	date: string;
}

/** A month name and where it is written, in printed columns from the grid's left edge. */
export interface MonthLabel {
	/** Week column the label belongs to. */
	col: number;
	/** 0-11, from the date. */
	month: number;
	label: string;
	/** Printed offset from the grid's left edge — `col * {@link CELL_COLUMNS}`. */
	offset: number;
}

/**
 * The month labels, each on the first column of its month.
 *
 * `days` is the grid's days in column-major order — `days[col * 7 + row]` is the
 * cell at that column and row, which is the order `gridCells` fills them in. A
 * month is labelled on the column whose *Sunday* starts it, matching the source
 * this was derived from, and the first column is always labelled whatever month
 * it is in: a grid that opens on 1 January should say so.
 *
 * The offset is the whole point. Spreading the labels evenly instead is the bug
 * this replaces, and it produces a grid whose "Feb" sits over May.
 *
 * Only the date is read, so this takes whatever the grid is made of: the
 * collector's `ActivityDay`s or the panel's own `GridCell`s, both of which have
 * one.
 */
export function monthLabelColumns(days: readonly Dated[], width: number): MonthLabel[] {
	const labels: MonthLabel[] = [];
	let previous = -1;
	for (let col = 0; col < width; col++) {
		const date = days[col * 7]?.date;
		if (date === undefined) break;
		const month = Number(date.slice(5, 7)) - 1;
		if (month === previous) continue;
		previous = month;
		labels.push({ col, month, label: MONTH_NAMES[month] ?? "", offset: col * CELL_COLUMNS });
	}
	return labels;
}

/**
 * The month label row, padded out to the grid's width.
 *
 * A label is written only where there is room for all three of its letters. Two
 * months whose first Sundays are a week apart cannot both be named three columns
 * from the left edge, and writing the second one anyway produces "FeMar" — a
 * string that names neither February nor March and reads as though it did. The
 * one that is dropped is the later month, which is the one the reader can work
 * out from the label before it.
 */
export function monthLabelRow(days: readonly Dated[], width: number): string {
	const cells = new Array<string>(width * CELL_COLUMNS).fill(" ");
	for (const { offset, label } of monthLabelColumns(days, width)) {
		if (offset + label.length > cells.length) break;
		let clear = true;
		for (let i = offset; i < offset + label.length; i++) {
			if (cells[i] !== " ") {
				clear = false;
				break;
			}
		}
		if (!clear) continue;
		for (let i = 0; i < label.length; i++) cells[offset + i] = label[i];
	}
	return cells.join("").trimEnd();
}

/** `7d → 30d → all → 7d`, the order the panel cycles in on `r`. */
export function nextRange(range: ActivityRange): ActivityRange {
	return range === "7d" ? "30d" : range === "30d" ? "all" : "7d";
}

/** `1 day` and not `1 days`. */
export function pluralDays(count: number): string {
	return `${count} ${count === 1 ? "day" : "days"}`;
}

/**
 * The window a figure is inside, in the fewest words that still name it.
 *
 * `Streaks.longest` is bounded by the range rather than by the data
 * (`activity.ts:63-73`): on a 7-day window it cannot come out above 7 however
 * long the real run was, because reading all of history is exactly what the
 * window is there to avoid. So `Longest streak 7 days` on a 7d range and
 * `Longest streak 7 days` on `all` are two different claims wearing the same
 * six words, and the panel is the only place the reader can tell them apart —
 * hence this, on the figure itself rather than as a footnote that only appears
 * when something was cut.
 */
export function rangeName(range: ActivityRange): string {
	return range === "7d" ? "the last 7 days" : range === "30d" ? "the last 30 days" : "all time";
}

/** Stands in for `collectActivity`; anything that resolves a report will do. */
export type ActivityCollector = (
	home: string | undefined,
	opts: { windowStart: number; now: number },
) => ActivityReport | Promise<ActivityReport>;

export interface ActivityPanelProps {
	/** OS home directory holding `.labunbun`; `undefined` collects nothing. */
	home: string | undefined;
	range: ActivityRange;
	/** Asked for the next range when `r` is pressed. The host owns the state. */
	onRange: (next: ActivityRange) => void;
	onClose: () => void;
	/** Width, for a caller that has already measured it. Defaults to the terminal's. */
	columns?: number;
	/** "Today", pinned. Defaults to the clock at mount; a test pins it. */
	now?: number;
	/** The collector, for a test. Defaults to the real one. */
	collect?: ActivityCollector;
}

/**
 * The panel: a header, the grid, the counters, and the way out.
 *
 * Collected on mount rather than given, because a session history is on disk and
 * reading four hundred of them is not something to do while React is
 * committing — the first frame is the spinner, and the grid arrives a tick
 * later. The collection is pushed into a microtask for the same reason: the
 * commit that mounts the panel has to finish first, or the spinner never gets
 * painted and the panel simply hangs on an empty box.
 *
 * `r` cycles the range and `Esc` closes, which is the whole of the keyboard
 * contract. The `Ctrl+S` screenshot the source offers is deliberately absent:
 * there is no screenshot channel here to send one to.
 */
export function ActivityPanel({
	home,
	range,
	onRange,
	onClose,
	columns: measured,
	now: pinnedNow,
	collect = collectActivity,
}: ActivityPanelProps) {
	const theme = useTheme();
	const { columns: windowColumns } = useWindowSize();
	const width = gridWidth(measured ?? windowColumns);
	// One clock reading for the panel's life. A panel left open across midnight
	// shows yesterday's grid until it is reopened, which is a smaller lie than a
	// grid whose last column moves under the reader while they are on it.
	const [now] = useState(() => pinnedNow ?? Date.now());
	const [report, setReport] = useState<ActivityReport | null>(null);
	const [failed, setFailed] = useState(false);
	const { frame } = useAnimation({ interval: SPINNER_INTERVAL_MS, isActive: report === null && !failed });

	// Held in a ref so that a caller passing a fresh arrow on every render does
	// not restart the collection on every render, which would never finish.
	const collector = useRef(collect);
	useEffect(() => {
		collector.current = collect;
	}, [collect]);

	useEffect(() => {
		let live = true;
		setReport(null);
		setFailed(false);
		Promise.resolve()
			.then(() => collector.current(home, { windowStart: windowStartFor(range, now), now }))
			.then((next) => {
				if (live) setReport(next);
			})
			.catch(() => {
				// A history that cannot be read is a panel that says so. Leaving
				// the spinner up instead would read as a hang, and would be one.
				if (live) setFailed(true);
			});
		return () => {
			live = false;
		};
	}, [home, range, now]);

	useInput((input, key) => {
		if (key.escape) {
			onClose();
			return;
		}
		if (input === "r") onRange(nextRange(range));
	});

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				Activity
			</Text>
			{report === null ? (
				<Box marginTop={1}>
					{/* A read that failed says so rather than spinning: a spinner that
					    never stops is indistinguishable from a hang, and is one. */}
					{failed ? (
						<Text color={theme.error}>Could not read the session history.</Text>
					) : (
						<Text dimColor>{FRAMES[frame % FRAMES.length]} Reading activity…</Text>
					)}
				</Box>
			) : (
				<Report report={report} width={width} now={now} range={range} />
			)}
			<Box marginTop={1}>
				<Text dimColor>r range · Esc to close</Text>
			</Box>
		</Box>
	);
}

/** The grid and the counters, once there is a report to draw. */
function Report({
	report,
	width,
	now,
	range,
}: {
	report: ActivityReport;
	width: number;
	now: number;
	range: ActivityRange;
}) {
	const theme = useTheme();
	const grid = gridCells(report.days, now, width);
	// Column-major, which is the order `monthLabelColumns` reads.
	const flat = grid[0].flatMap((_cell, col) => grid.map((row) => row[col]));
	const hasTouched = flat.some((cell) => cell.channel === "touched");

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text>
				{" ".repeat(LABEL_COLUMNS)}
				{monthLabelRow(flat, width)}
			</Text>
			{grid.map((row, index) => (
				<Text key={DAY_NAMES[index]}>
					{LABELLED_ROWS.includes(index) ? `${DAY_NAMES[index]} ` : "    "}
					{row.map((cell, col) => (
						<Text
							// Keyed by the date, which is the cell's own identity: a row holds one
							// week, so no two cells in it can share a day.
							key={cell.date}
							color={cellColor(cell.channel, theme)}
							dimColor={cell.channel === "empty"}
						>
							{cell.glyph}
							{col === row.length - 1 ? "" : " "}
						</Text>
					))}
				</Text>
			))}
			<Box marginTop={1}>
				<Text dimColor>
					Less <Text color={theme.accent}>{LEVEL_GLYPHS.join(" ")}</Text> More
				</Text>
			</Box>
			{/*
			 * The muted channel named in words, because a cell that differs only
			 * in color is a cell a reader piping this through `less`, or reading
			 * it on a monochrome terminal, does not have.
			 */}
			{hasTouched ? (
				<Text dimColor>
					<Text color={theme.textMuted}>·</Text> marks a day an earlier session was still being written on
				</Text>
			) : null}
			<Box flexDirection="column" marginTop={1}>
				<Counter label="Current streak" value={pluralDays(report.streaks.current)} />
				{/*
				 * The window rides on the figure it bounds, not in the truncated
				 * notice below: that notice only appears when something was cut, and
				 * a short history inside a 7-day window is bounded too. On `all` the
				 * figure is the real all-time one and the note says exactly that, so
				 * there is no reading of this line that is not the reading.
				 */}
				<Counter label="Longest streak" value={pluralDays(report.streaks.longest)} note={`in ${rangeName(range)}`} />
				<Counter label="Active days" value={`${report.totals.activeDays}/${report.totals.windowDays}`} />
			</Box>
			{report.truncated ? <Text color={theme.textMuted}>History before this window is not shown.</Text> : null}
		</Box>
	);
}

/** One labelled figure, with an optional dim qualification after the value. */
function Counter({ label, value, note }: { label: string; value: string; note?: string }) {
	const theme = useTheme();
	return (
		<Text>
			{`${label} `.padEnd(18)}
			<Text color={theme.accent} bold>
				{value}
			</Text>
			{note ? <Text dimColor> {note}</Text> : null}
		</Text>
	);
}
