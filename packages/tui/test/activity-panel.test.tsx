/**
 * The activity panel: the grid's arithmetic, the two keys, and the two things it
 * gets right that the source it was derived from gets wrong.
 *
 * Every frame here is built from an injected collector, so nothing in this file
 * reads a real `~/.labunbun` — and `now` is pinned, because a heatmap whose
 * answer depends on what day the suite happens to run is a heatmap that cannot
 * be pinned at all.
 *
 * Two of the tests are about *not* computing something. The panel does not
 * re-derive the intensity scale (`intensityThresholds` returning `null` is an
 * answer, and a panel that second-guessed it would spread a uniform history
 * across four shades), and it does not place month labels by dividing the width
 * evenly (`monthLabelColumns` is pinned to the column a month starts in, which
 * is what makes "Jan" mean January). Both are the kind of thing that reads as a
 * rendering detail and is actually a wrong answer.
 */

import { describe, expect, test } from "bun:test";
import type { ActivityDay, ActivityRange, ActivityReport, Streaks } from "@labunbun/agent";
import { civilDayNumber, intensityThresholds, localDayKey } from "@labunbun/agent";
import { render } from "ink-testing-library";
import type React from "react";
import {
	type ActivityCollector,
	ActivityPanel,
	CELL_COLUMNS,
	cellChannel,
	cellColor,
	gridCells,
	gridWidth,
	LEVEL_GLYPHS,
	type MonthLabel,
	monthLabelColumns,
	monthLabelRow,
	nextRange,
	pluralDays,
	rangeName,
} from "../src/components/ActivityPanel.tsx";
import { DARK_THEME, type Theme, ThemeContext } from "../src/theme.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wednesday 7 January 2026, local noon — mid-week, so the last column splits. */
const NOW = new Date(2026, 0, 7, 12, 0, 0, 0).getTime();
const NOW_KEY = localDayKey(NOW);
const NOW_WEEKDAY = new Date(NOW).getDay();
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Printed columns before the first cell: the border, its padding, and the gutter. */
const GRID_LEFT = 6;

/** The glyphs a rendered grid row carries. Spaces — the future — are not glyphs. */
const GLYPH = /[·░▒▓█]/g;

const MS_PER_DAY = 86_400_000;

/** A `YYYY-MM-DD` `n` days from `date`, through the same day-number arithmetic. */
function addDays(date: string, n: number): string {
	return new Date(Date.UTC(1970, 0, 1) + (civilDayNumber(date) + n) * MS_PER_DAY).toISOString().slice(0, 10);
}

const fromNow = (offset: number): string => addDays(NOW_KEY, offset);

function day(date: string, over: Partial<ActivityDay> = {}): ActivityDay {
	return { date, sessions: 0, messages: 0, toolCalls: 0, touched: false, ...over };
}

/** The column-major day list the panel feeds to the month label code. */
function gridDayList(width: number, sunday: string): { date: string }[] {
	const days: { date: string }[] = [];
	for (let col = 0; col < width; col++) {
		for (let row = 0; row < 7; row++) days.push({ date: addDays(sunday, col * 7 + row) });
	}
	return days;
}

function streaks(over: Partial<Streaks> = {}): Streaks {
	return { current: 0, currentStart: null, longest: 0, longestStart: null, longestEnd: null, ...over };
}

function report(days: ActivityDay[], over: Partial<ActivityReport> = {}): ActivityReport {
	return {
		days,
		streaks: streaks(),
		totals: {
			sessions: days.reduce((n, d) => n + d.sessions, 0),
			messages: days.reduce((n, d) => n + d.messages, 0),
			toolCalls: days.reduce((n, d) => n + d.toolCalls, 0),
			activeDays: days.filter((d) => d.sessions > 0 || d.touched).length,
			windowDays: days.length,
		},
		firstDate: days[0]?.date ?? null,
		truncated: false,
		...over,
	};
}

function withTheme(node: React.ReactNode, theme: Theme = DARK_THEME) {
	return <ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>;
}

/**
 * Run a body against a terminal that is not 100 columns wide.
 *
 * ink-testing-library hard-codes 100, and 100 is exactly the width the panel
 * would fall back on if it ignored `useWindowSize` altogether — so a test that
 * only ever sees 100 cannot tell measuring the terminal from not measuring it.
 * The property is on the mock's prototype, so it is put back afterwards. The
 * probe exists only to reach that prototype, and it is mounted with no home at
 * all — the one input that collects nothing — so nothing in this file can reach
 * a real `~/.labunbun` even by accident.
 */
async function withTerminalColumns<T>(columns: number, run: () => Promise<T>): Promise<T> {
	const probe = render(withTheme(<ActivityPanel home={undefined} range="all" onRange={() => {}} onClose={() => {}} />));
	const proto = Object.getPrototypeOf(probe.stdout) as object;
	const original = Object.getOwnPropertyDescriptor(proto, "columns");
	probe.unmount();
	Object.defineProperty(proto, "columns", { value: columns, configurable: true });
	try {
		return await run();
	} finally {
		if (original) Object.defineProperty(proto, "columns", original);
		else Reflect.deleteProperty(proto, "columns");
	}
}

interface MountOptions {
	columns?: number;
	range?: ActivityRange;
	onClose?: () => void;
	collect?: ActivityCollector;
	/** Omit the `columns` prop entirely, so the panel has to measure the terminal. */
	measure?: boolean;
}

/**
 * Mount the panel over a fixed report.
 *
 * The range is held here and fed back in, because the host owns it: pressing `r`
 * only asks, and a panel that moved its own range would be a panel whose state
 * the host could not see.
 */
function mount(fixed: ActivityReport, opts: MountOptions = {}) {
	const asked: ActivityRange[] = [];
	const closed = { n: 0 };
	let range: ActivityRange = opts.range ?? "all";
	const handle: { rerender?: (tree: React.ReactElement) => void } = {};

	const tree = (): React.ReactElement =>
		withTheme(
			<ActivityPanel
				home="unused"
				range={range}
				onRange={(next) => {
					asked.push(next);
					range = next;
					handle.rerender?.(tree());
				}}
				onClose={() => closed.n++}
				{...(opts.measure ? {} : { columns: opts.columns ?? 100 })}
				now={NOW}
				collect={opts.collect ?? (() => fixed)}
			/>,
		);

	const view = render(tree());
	handle.rerender = view.rerender;
	const lines = () => (view.lastFrame() ?? "").split("\n");
	// Anchored on the "Mon" gutter rather than on the month row's own text: a row
	// whose first label runs into the next one ("FeMar") is exactly the failure
	// these tests are here to catch, and a harness that could not find its way
	// round to it would report every grid test as broken at once.
	const gridIndex = () => {
		const at = lines().findIndex((l) => l.includes(" Mon "));
		if (at === -1) throw new Error(`no grid in:\n${view.lastFrame()}`);
		return at;
	};
	/** The seven grid rows, Sunday first — the legend and the counters are not in here. */
	const gridRows = () => lines().slice(gridIndex() - 1, gridIndex() + 6);

	return {
		...view,
		frame: () => view.lastFrame() ?? "",
		lines,
		gridRows,
		/** Every cell in the grid, in reading order, as one string. */
		gridText: () => gridRows().join(""),
		monthRow: () => {
			// The label row is the one above the grid, which starts on the blank
			// Sunday gutter and puts "Mon" on the line after it.
			const line = lines()[gridIndex() - 2] ?? "";
			if (!/[A-Z][a-z]{2}/.test(line)) throw new Error(`no month on the label row:\n${view.lastFrame()}`);
			return line;
		},
		/** The row whose gutter names `name`. */
		row: (name: string) => {
			const at = gridRows().findIndex((l) => l.includes(` ${name} `));
			if (at === -1) throw new Error(`no row labelled ${name} in:\n${view.lastFrame()}`);
			return gridRows()[at];
		},
		/** The printed character of one cell, read back out of the frame. */
		cellAt: (row: number, col: number) => gridRows()[row][GRID_LEFT + col * CELL_COLUMNS],
		asked,
		closes: () => closed.n,
	};
}

describe("grid width", () => {
	// The panel has to fit the window it was handed, and a cell is two printed
	// columns, so the width it derives is the columns left over *divided by two*.
	// Reading the leftover as if a cell were one column is what puts a 52-week
	// grid — 104 columns of cells — into a 100-column terminal, wrapped in half.
	test("takes the two columns a cell occupies out of the leftover width", () => {
		expect(gridWidth(100)).toBe(46);
		expect(gridWidth(40)).toBe(16);
	});

	test("never drops below ten weeks, however narrow the terminal is", () => {
		expect(gridWidth(28)).toBe(10);
		expect(gridWidth(20)).toBe(10);
		// A terminal so narrow the arithmetic goes negative still draws a grid,
		// because an empty panel says nothing at all.
		expect(gridWidth(4)).toBe(10);
	});

	test("never goes past a year of weeks", () => {
		expect(gridWidth(200)).toBe(52);
	});
});

describe("the grid", () => {
	test("draws one cell per column, at both a narrow and a wide terminal", async () => {
		for (const columns of [40, 100]) {
			const view = mount(report([day(fromNow(0), { sessions: 1, messages: 1 })]), { columns });
			await delay(30);
			const width = gridWidth(columns);
			// A row that wrapped would split its cells across two lines, and the
			// half that kept the "Mon" gutter would come up short.
			expect(view.row("Mon").slice(GRID_LEFT).match(GLYPH) ?? []).toHaveLength(width);
			view.unmount();
		}
	});

	// ink-testing-library's terminal is 100 columns, and 100 is exactly what a
	// panel that ignored `useWindowSize` would fall back on — so this runs
	// against a terminal of some other width, or it proves nothing.
	test("measures the terminal when the caller has not", async () => {
		const fixed = report([day(fromNow(0), { sessions: 1, messages: 1 })]);
		const glyphsAt = (columns: number): Promise<number> =>
			withTerminalColumns(columns, async () => {
				const view = mount(fixed, { measure: true });
				await delay(30);
				const count = (view.frame().match(GLYPH) ?? []).length;
				view.unmount();
				return count;
			});
		expect(gridWidth(60)).not.toBe(gridWidth(100));
		const narrow = await glyphsAt(60);
		const wide = await glyphsAt(100);
		// Counted as a difference, because the panel's decoration — the legend's
		// five glyphs and the footer's separator — is in both frames and cancels
		// out, leaving exactly the cells the extra twenty weeks added. Counting one
		// row's glyphs would not survive: a 46-week grid is 100 columns wide, ink
		// wraps it in half, and the half that keeps the "Mon" gutter is exactly as
		// long as a 26-week row. Today sits in the rightmost column either way, so
		// the three blank future cells are in both and cancel too.
		expect(wide - narrow).toBe((gridWidth(100) - gridWidth(60)) * 7);
	});

	// A day that has not happened yet gets a space, not a level-0 dot: a dot
	// claims the day was quiet, and next Tuesday is not quiet yet, it is later.
	test("a day past today is a space, and only the days past today are", async () => {
		const view = mount(report([day(fromNow(0), { sessions: 1, messages: 1 })]), { columns: 100 });
		await delay(30);
		const width = gridWidth(100);
		// Row r's last cell is the day after today exactly when r is past today's
		// weekday; every earlier cell is a real day, and so carries a glyph.
		for (const name of ["Mon", "Wed", "Fri"] as const) {
			const row = DAY_NAMES.indexOf(name);
			expect(view.row(name).slice(GRID_LEFT).match(GLYPH) ?? []).toHaveLength(width - (row > NOW_WEEKDAY ? 1 : 0));
		}
		view.unmount();
	});

	test("a day past today is marked future and drawn as a space, not a level-0 dot", () => {
		const grid = gridCells([], NOW, 12);
		const lastColumn = grid.map((row) => row[row.length - 1]);
		const future = lastColumn.filter((cell) => cell.future);
		const past = lastColumn.filter((cell) => !cell.future);
		expect(future).toHaveLength(6 - NOW_WEEKDAY);
		expect(past).toHaveLength(NOW_WEEKDAY + 1);
		for (const cell of future) {
			expect(cell.glyph).toBe(" ");
			expect(cell.glyph).not.toBe(LEVEL_GLYPHS[0]);
		}
		// Today itself is not in the future — the off-by-one that would blank out
		// the cell the user is standing in.
		const todayCells = grid.flat().filter((cell) => cell.date === NOW_KEY);
		expect(todayCells).toHaveLength(1);
		expect(todayCells[0].future).toBe(false);
	});

	test("today sits in the last column, and the weeks run oldest to newest", () => {
		const width = 20;
		const grid = gridCells([], NOW, width);
		// One week per column: a column's Sunday through its Saturday, and the next
		// column the Sunday after.
		expect(grid[0][0].date).toBe(addDays(grid[6][0].date, -6));
		expect(grid[0][1].date).toBe(addDays(grid[0][0].date, 7));
		expect(grid[6][0].date).toBe(addDays(grid[0][0].date, 6));
		// The week holding today is the rightmost one, and it is a week.
		expect(grid[0][width - 1].date).toBe(addDays(NOW_KEY, -NOW_WEEKDAY));
		expect(grid[NOW_WEEKDAY][width - 1].date).toBe(NOW_KEY);
		expect(grid[6][width - 1].date).toBe(addDays(NOW_KEY, 6 - NOW_WEEKDAY));
		// Nothing after today is in the past.
		for (const cell of grid[NOW_WEEKDAY + 1].slice(0, 0)) expect(cell.future).toBe(true);
	});

	// A report that has a day in it which has not happened yet — a clock skewed
	// the wrong way, a fixture written by hand — must not paint it. "The grid
	// ends at today" is a rule about the calendar, not about what the report
	// happens to contain.
	test("a day past today is blank even when the report claims something happened on it", async () => {
		const width = gridWidth(100);
		const futureDate = addDays(NOW_KEY, 6 - NOW_WEEKDAY);
		const days = [day(fromNow(0), { sessions: 1, messages: 1 }), day(futureDate, { sessions: 9, messages: 400 })];
		const view = mount(report(days), { columns: 100 });
		await delay(30);
		const grid = gridCells(days, NOW, width);
		const cell = grid[6][width - 1];
		expect(cell.date).toBe(futureDate);
		expect(cell.level).toBe(0);
		expect(cell.future).toBe(true);
		expect(view.cellAt(6, width - 1)).toBe(" ");
		view.unmount();
	});
});

describe("the two channels", () => {
	// `touched` is the mtime channel on its own: a session that started on some
	// other day was still being written here. The rule is on `sessions` and not on
	// the level, because a touched day is never level 0 — a rule that asked for
	// level 0 here would be a rule that never fired, and the channel would be a
	// color nothing ever wore.
	test("a day an earlier session was still open on is the muted channel", () => {
		expect(cellChannel(day("2026-01-07", { touched: true }), 2)).toBe("touched");
	});

	test("a day a session started on is the accent channel", () => {
		expect(cellChannel(day("2026-01-07", { sessions: 1, messages: 1 }), 3)).toBe("activity");
	});

	test("a day with nothing on it is neither, and a day the report never mentioned is empty too", () => {
		expect(cellChannel(day("2026-01-07"), 0)).toBe("empty");
		expect(cellChannel(undefined, 0)).toBe("empty");
		// The level comes from the day, so a level and a day that disagree — which
		// is what a caller handing in a hand-written day can do — go by the day. A
		// level of 0 with a session on the day is a claim about the day that the
		// day does not support, and the day is the one that is true.
		expect(cellChannel(day("2026-01-07"), 3)).toBe("empty");
		expect(cellChannel(day("2026-01-07", { sessions: 2, messages: 6 }), 0)).toBe("empty");
	});

	test("the two channels are drawn in different theme colors, and the muted one is a theme token", () => {
		expect(cellColor("activity", DARK_THEME)).toBe(DARK_THEME.accent);
		expect(cellColor("touched", DARK_THEME)).toBe(DARK_THEME.textMuted);
		expect(cellColor("activity", DARK_THEME)).not.toBe(cellColor("touched", DARK_THEME));
		expect(cellColor("empty", DARK_THEME)).toBe(DARK_THEME.textMuted);
	});

	// Ink draws no color when stdout is not a TTY, which is every test run, so a
	// frame cannot show which color a cell wore. What it *can* show is whether
	// the panel knows the channel exists — the note under the legend is there for
	// exactly the reader who cannot see the color, and it comes and goes with the
	// cells that need it.
	test("the panel names the muted channel only while there is a cell on it", async () => {
		const withTouched = mount(
			report([day(fromNow(-3), { sessions: 1, messages: 4 }), day(fromNow(-1), { touched: true })]),
		);
		await delay(30);
		expect(withTouched.frame()).toContain("still being written on");
		withTouched.unmount();

		const without = mount(report([day(fromNow(-3), { sessions: 1, messages: 4 })]));
		await delay(30);
		expect(without.frame()).not.toContain("still being written on");
		without.unmount();
	});

	// The cell itself: a day only an earlier session touched still gets a level
	// glyph, not the level-0 dot an untouched day gets. The dot would say the day
	// was empty, which is the one thing it is not.
	test("a touched-only day draws a level glyph where an untouched day draws the level-0 dot", async () => {
		const touchedDate = fromNow(-1);
		const quietDate = fromNow(-2);
		const days = [day(fromNow(-6), { sessions: 3, messages: 9 }), day(quietDate), day(touchedDate, { touched: true })];
		const view = mount(report(days), { columns: 100 });
		await delay(30);
		const width = gridWidth(100);
		const grid = gridCells(days, NOW, width);
		const locate = (date: string) => {
			const row = grid.findIndex((line) => line.some((cell) => cell.date === date));
			const col = grid[row].findIndex((cell) => cell.date === date);
			return { row, col };
		};
		const touched = locate(touchedDate);
		const quiet = locate(quietDate);
		// The channel the component's own grid puts these two days on.
		expect(grid[touched.row][touched.col].channel).toBe("touched");
		expect(grid[quiet.row][quiet.col].channel).toBe("empty");
		// And the two characters the component put on the terminal for them.
		expect(view.cellAt(touched.row, touched.col)).not.toBe(LEVEL_GLYPHS[0]);
		expect(view.cellAt(quiet.row, quiet.col)).toBe(LEVEL_GLYPHS[0]);
		view.unmount();
	});
});

describe("intensity comes from the collector", () => {
	// Every active day counting the same is the case the whole threshold function
	// exists for: there is no scale to place them on, so they all get the same
	// honest middle shade. A panel that computed quantiles of its own would see
	// p25 = p50 = p75 = 4 and paint every cell as a record day.
	test("a uniform history gets one flat shade rather than a scale invented from itself", async () => {
		const days = [-8, -7, -6, -5, -4].map((offset) => day(fromNow(offset), { sessions: 2, messages: 4 }));
		// Guard, so this test cannot pass by never reaching the null branch.
		expect(intensityThresholds(days)).toBeNull();

		const view = mount(report(days));
		await delay(30);
		const grid = view.gridText();
		expect(grid).toContain(LEVEL_GLYPHS[2]);
		// The three shades a re-derived scale would have produced. If the panel
		// grew its own quantiles, these are what would show up instead.
		expect(grid).not.toContain(LEVEL_GLYPHS[1]);
		expect(grid).not.toContain(LEVEL_GLYPHS[3]);
		expect(grid).not.toContain(LEVEL_GLYPHS[4]);
		view.unmount();
	});

	test("a spread history does get four shades, from the same code path", async () => {
		const days = [
			day(fromNow(-8), { sessions: 1, messages: 1 }),
			day(fromNow(-7), { sessions: 1, messages: 2 }),
			day(fromNow(-6), { sessions: 1, messages: 3 }),
			day(fromNow(-5), { sessions: 1, messages: 40 }),
		];
		expect(intensityThresholds(days)).not.toBeNull();
		const view = mount(report(days));
		await delay(30);
		expect(view.gridText()).toContain(LEVEL_GLYPHS[1]);
		expect(view.gridText()).toContain(LEVEL_GLYPHS[4]);
		view.unmount();
	});
});

describe("month labels", () => {
	// The reference divides the width by the number of months and pads each name
	// to that share, so the names land at offsets that have nothing to do with the
	// columns they name. A label here is written where its month starts.
	test("a month is labelled on the column it starts in, not at an even share of the width", () => {
		const width = 46;
		const days = gridDayList(width, addDays(NOW_KEY, -NOW_WEEKDAY - (width - 1) * 7));
		const labels = monthLabelColumns(days, width);
		expect(labels.length).toBeGreaterThan(1);
		for (const label of labels) expect(label.offset).toBe(label.col * CELL_COLUMNS);
		// The evenly-spread layout this replaces, for the same labels: each name
		// at `floor(width / months)`, whatever column its month started in. If the
		// two agreed there would be nothing here to fix.
		const even = Math.floor(width / labels.length);
		expect(labels[1].offset).not.toBe(even);
		expect(labels.map((l) => l.offset)).not.toEqual(labels.map((_l, i) => i * even));
	});

	test("the first column is labelled whatever month the grid opens in", () => {
		const days = gridDayList(12, "2025-02-02");
		const labels = monthLabelColumns(days, 12);
		expect(labels[0].col).toBe(0);
		expect(labels[0].offset).toBe(0);
		expect(labels[0].label).toBe("Feb");
	});

	// A month is named on the week whose *Sunday* is in it, which is the rule the
	// source this was derived from uses. Here a column's Sunday is 31 August and
	// its Monday is 1 September: naming the column by any day but the Sunday puts
	// September on the August column and never labels August at all.
	test("a column is named for its Sunday, not for a day later in the same week", () => {
		expect(new Date(2025, 7, 31).getDay()).toBe(0);
		const days = gridDayList(8, "2025-08-31");
		const labels = monthLabelColumns(days, 8);
		expect(labels[0]).toMatchObject({ col: 0, month: 7, label: "Aug", offset: 0 });
		expect(labels[1]).toMatchObject({ col: 1, month: 8, label: "Sep", offset: CELL_COLUMNS });
		expect(monthLabelRow(days, 8).startsWith("Aug")).toBe(true);
	});

	// The grid opens in the middle of February, so February's name lands on the
	// first column and March's — one week later — would start two columns in,
	// inside it. Writing it anyway gives "FeMar", which names neither month and
	// reads as though it did. The later month is the one that goes: the reader
	// can work it out from the one before.
	test("a name that would not fit beside the last one is dropped, not written over it", () => {
		const width = 46;
		const days = gridDayList(width, addDays(NOW_KEY, -NOW_WEEKDAY - (width - 1) * 7));
		const labels = monthLabelColumns(days, width);
		expect(labels[0]).toMatchObject({ col: 0, label: "Feb", offset: 0 });
		expect(labels[1]).toMatchObject({ col: 1, label: "Mar", offset: CELL_COLUMNS });

		const row = monthLabelRow(days, width);
		expect(row.startsWith("Feb")).toBe(true);
		// Dropped, not merged: "FeMar" contains "Mar" and does not start "Feb",
		// so both halves of this go red the moment the overlap guard comes off.
		expect(row).not.toContain("Mar");
		// And the guard costs one name, not the row: the months after it are still
		// on screen, at their own offsets.
		expect(row).toContain("Apr");
		expect(row.indexOf("Apr")).toBe(labels[2].offset);
	});

	// The offset has to survive into the terminal, not just into the function that
	// computes it. A label rendered at the right column of a right-shaped array
	// and then written at the wrong place would pass everything above.
	test("every month name on screen sits at the offset of the column its month starts in", async () => {
		const width = gridWidth(100);
		const view = mount(report([day(fromNow(0), { sessions: 1, messages: 1 })]), { columns: 100 });
		await delay(30);
		const grid = gridCells([], NOW, width);
		const labels: MonthLabel[] = monthLabelColumns(
			grid[0].flatMap((_cell, col) => grid.map((row) => row[col])),
			width,
		);
		const line = view.monthRow();
		const visible = line.match(/[A-Z][a-z]{2}/g) ?? [];
		expect(visible.length).toBeGreaterThan(1);
		for (const name of visible) {
			const label = labels.find((l) => l.label === name);
			// A name on screen that no column claims would be a name the panel
			// invented; one at the wrong offset is the even-split bug, on screen.
			expect(label).toBeDefined();
			expect(line.indexOf(name)).toBe(GRID_LEFT + (label as MonthLabel).offset);
		}
		view.unmount();
	});
});

describe("the counters", () => {
	test("one is one day, and zero is zero days", () => {
		expect(pluralDays(1)).toBe("1 day");
		expect(pluralDays(0)).toBe("0 days");
		expect(pluralDays(2)).toBe("2 days");
	});

	test("the panel says '1 day' and never '1 days'", async () => {
		const view = mount(
			report([day(fromNow(0), { sessions: 1, messages: 1 })], { streaks: streaks({ current: 1, longest: 1 }) }),
		);
		await delay(30);
		const frame = view.frame();
		expect(frame).toContain("Current streak");
		expect(frame).toContain("1 day");
		expect(frame).not.toContain("1 days");
		expect(frame).toContain("Longest streak");
		view.unmount();
	});

	test("active days are counted over the window, and truncation is admitted", async () => {
		const days = [day(fromNow(-2), { sessions: 1, messages: 3 }), day(fromNow(-1), { touched: true })];
		const view = mount(report(days, { truncated: true }), { columns: 100 });
		await delay(30);
		const frame = view.frame();
		expect(frame).toContain(`Active days${" ".repeat(7)}2/2`);
		expect(frame).toContain("not shown");
		view.unmount();
	});

	test("a report that lost no history does not say it lost some", async () => {
		const view = mount(report([day(fromNow(0), { sessions: 1, messages: 1 })]));
		await delay(30);
		expect(view.frame()).not.toContain("not shown");
		view.unmount();
	});
});

// `Streaks.longest` is bounded by the window rather than by the data
// (`activity.ts:63-73`), so the same number means two different things on `7d`
// and on `all`. The contract is that every caller names the window; these are
// the checks that the one caller in the tree does.
describe("the longest streak says which window it is inside", () => {
	test("the three ranges name themselves", () => {
		expect(rangeName("7d")).toBe("the last 7 days");
		expect(rangeName("30d")).toBe("the last 30 days");
		expect(rangeName("all")).toBe("all time");
	});

	test("a 7-day window is named on the figure, not only in the truncated notice", async () => {
		// `truncated: false` on purpose. A history that is only three days long is
		// bounded by the window just as a cut one is, and the notice that would
		// have covered for it does not appear — so a panel that leaned on the
		// notice instead of the figure would pass a test that only used `truncated:
		// true`, and print an unbounded claim for every short-lived account.
		const days = [
			day(fromNow(-2), { sessions: 1 }),
			day(fromNow(-1), { sessions: 1 }),
			day(fromNow(0), { sessions: 1 }),
		];
		const view = mount(report(days, { streaks: streaks({ longest: 3 }) }), { range: "7d" });
		await delay(30);
		const frame = view.frame();
		expect(frame).not.toContain("not shown");
		expect(frame).toContain("Longest streak");
		expect(frame).toContain("3 days in the last 7 days");
		view.unmount();
	});

	test("30 days says 30, and does not reuse the 7-day wording", async () => {
		const view = mount(report([day(fromNow(0), { sessions: 1 })], { streaks: streaks({ longest: 1 }) }), {
			range: "30d",
		});
		await delay(30);
		expect(view.frame()).toContain("1 day in the last 30 days");
		view.unmount();
	});

	test("the all-time range claims all time, which is the one window that does not bound it", async () => {
		const view = mount(report([day(fromNow(0), { sessions: 1 })], { streaks: streaks({ longest: 1 }) }), {
			range: "all",
		});
		await delay(30);
		const frame = view.frame();
		expect(frame).toContain("1 day in all time");
		expect(frame).not.toContain("the last 7 days");
		expect(frame).not.toContain("the last 30 days");
		view.unmount();
	});

	test("the same report reads differently on two ranges, so the number is not the claim", async () => {
		const fixed = report([day(fromNow(0), { sessions: 1 }), day(fromNow(-1), { sessions: 1 })], {
			streaks: streaks({ longest: 2 }),
		});
		const short = mount(fixed, { range: "7d" });
		await delay(30);
		const shortFrame = short.frame();
		short.unmount();
		const all = mount(fixed, { range: "all" });
		await delay(30);
		const allFrame = all.frame();
		all.unmount();
		// Same figure, same digits; the sentence around it is what carries the claim.
		expect(shortFrame).toContain("2 days in the last 7 days");
		expect(allFrame).toContain("2 days in all time");
	});

	test("the current streak is not qualified, because the window does not bound it", async () => {
		// `Streaks.current` counts back from today and is the same number on every
		// range, so attaching a window to it would be a false claim in the other
		// direction. This pins the asymmetry, so a later "be consistent" edit does
		// not put the note on both.
		const view = mount(report([day(fromNow(0), { sessions: 1 })], { streaks: streaks({ current: 1, longest: 1 }) }), {
			range: "7d",
		});
		await delay(30);
		const frame = view.frame();
		// Spelled out rather than as `"Current streak 1 day"`: the counters are
		// aligned by a `padEnd`, and this pair also pins that the note lands
		// *after* the value — the figure column is the same width on both lines,
		// so a note inserted before the value would break both of these at once.
		expect(frame).toContain(`Current streak${" ".repeat(4)}1 day`);
		expect(frame).toContain(`Longest streak${" ".repeat(4)}1 day in the last 7 days`);
		view.unmount();
	});
});

describe("the keys", () => {
	test("Esc closes the panel", async () => {
		const view = mount(report([]));
		await delay(30);
		view.stdin.write("\x1b");
		await delay(30);
		expect(view.closes()).toBe(1);
		view.unmount();
	});

	// The host owns the range, so the panel only asks. This mounts the same way
	// the REPL would — feeding the answer back in — and the panel has to ask for
	// the *next* one each time, not the same one three times.
	test("r asks for the next range, in the order 7d, 30d, all", async () => {
		const view = mount(report([]), { range: "7d" });
		await delay(30);
		for (const expected of ["30d", "all", "7d"] as const) {
			view.stdin.write("r");
			await delay(30);
			expect(view.asked).toEqual(view.asked.slice(0, -1).concat(expected));
		}
		expect(view.asked).toEqual(["30d", "all", "7d"]);
		view.unmount();
	});

	test("the cycle is a pure function of where it starts", () => {
		expect(nextRange("7d")).toBe("30d");
		expect(nextRange("30d")).toBe("all");
		expect(nextRange("all")).toBe("7d");
	});

	test("a key that is neither Esc nor r changes nothing", async () => {
		const view = mount(report([]), { range: "7d" });
		await delay(30);
		view.stdin.write("x");
		view.stdin.write("\r");
		await delay(30);
		expect(view.closes()).toBe(0);
		expect(view.asked).toEqual([]);
		view.unmount();
	});
});

describe("the wait", () => {
	test("a collector that never answers leaves the spinner up and no grid", async () => {
		const view = mount(report([]), { collect: () => new Promise<ActivityReport>(() => {}) });
		await delay(30);
		expect(view.frame()).toContain("Reading activity");
		expect(view.frame()).not.toContain("Current streak");
		view.unmount();
	});

	// A history that cannot be read says so. Spinning forever would read as a
	// hang, and would be one.
	test("a collector that throws says the history could not be read", async () => {
		const view = mount(report([]), {
			collect: () => {
				throw new Error("nope");
			},
		});
		await delay(30);
		expect(view.frame()).toContain("Could not read the session history");
		expect(view.frame()).not.toContain("Reading activity");
		view.unmount();
	});

	test("the panel measures the window the range means, and hands on its own now", async () => {
		const asked: number[] = [];
		let handed: number | undefined;
		const view = render(
			withTheme(
				<ActivityPanel
					home="/home/someone"
					range="30d"
					onRange={() => {}}
					onClose={() => {}}
					columns={100}
					now={NOW}
					collect={(_home, opts) => {
						asked.push(opts.windowStart);
						handed = opts.now;
						return report([]);
					}}
				/>,
			),
		);
		await delay(30);
		// Thirty days back from the pinned now, and the same now handed on, so the
		// report and the grid cannot disagree about which day today is.
		expect(asked).toHaveLength(1);
		expect(handed).toBe(NOW);
		expect(NOW - asked[0]).toBeLessThan(31 * MS_PER_DAY);
		expect(NOW - asked[0]).toBeGreaterThan(28 * MS_PER_DAY);
		view.unmount();
	});
});
