/**
 * The logic half of the activity heatmap: which day a session counts for, how
 * a day's intensity is graded, and how many days in a row someone worked.
 *
 * Every test here runs against a throwaway home built with `mkdtempSync`. The
 * real `~/.labunbun` is never read: a heatmap test that quietly measured the
 * machine it ran on would pass in the developer's week and fail in CI's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import {
	type ActivityDay,
	activityLevel,
	civilDayNumber,
	collectActivity,
	intensityThresholds,
	localDayKey,
	startOfLocalDay,
	windowStartFor,
} from "../src/activity.ts";
import { SessionStore, sanitizeCwd, sessionsRoot } from "../src/session-store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpHome(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/**
 * Run `body` with the process in a known zone, then put the zone back.
 *
 * `process.env.TZ` is consulted by every `Date` operation, so assigning it
 * moves the clock mid-process. That is what makes the date assertions below
 * independent of the machine running them: the bug they describe — a UTC day
 * key read through `toISOString` — only misbehaves at a non-zero UTC offset,
 * and on a UTC machine it would sail through against a broken implementation.
 *
 * The restore is an assignment and never a `delete`: once `TZ` has been removed
 * from the environment entirely, Bun stops honouring later assignments to it
 * and every subsequent zone-picking test silently runs in whichever one leaked.
 */
const ORIGINAL_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function inTimeZone<T>(tz: string, body: () => T): T {
	process.env.TZ = tz;
	try {
		return body();
	} finally {
		process.env.TZ = ORIGINAL_TZ;
	}
}

/** An instant at a local wall-clock time, in whichever zone is current. */
function at(year: number, month: number, day: number, hours = 12, minutes = 0): number {
	return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
}

let sessionCounter = 0;

type FakeTurn = { at: number; toolCalls?: number };

/**
 * A session file as {@link SessionStore} writes it: a header, then one `message`
 * entry per turn. Timestamps and mtime are given rather than taken from the
 * clock — the whole point is to place a session on a chosen day.
 */
function writeSession(
	home: string,
	spec: { cwd: string; sessionId?: string; messages: FakeTurn[]; mtimeMs?: number },
): string {
	sessionCounter += 1;
	const sessionId = spec.sessionId ?? `session-${sessionCounter}`;
	const dir = join(sessionsRoot(home), sanitizeCwd(spec.cwd));
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${sessionId}.jsonl`);
	const first = spec.messages[0]?.at ?? 0;
	const lines = [
		JSON.stringify({
			id: `${sessionId}-header`,
			parentId: null,
			type: "header",
			version: 1,
			sessionId,
			cwd: spec.cwd,
			createdAt: first,
		}),
	];
	let parent = `${sessionId}-header`;
	for (const [index, turn] of spec.messages.entries()) {
		const id = `${sessionId}-${index}`;
		lines.push(JSON.stringify({ id, parentId: parent, type: "message", timestamp: turn.at, message: messageAt(turn) }));
		parent = id;
	}
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	if (spec.mtimeMs !== undefined) {
		const seconds = spec.mtimeMs / 1000;
		utimesSync(path, seconds, seconds);
	}
	return path;
}

function messageAt(turn: FakeTurn): AgentMessage {
	if (!turn.toolCalls) return { role: "user", content: "hello", timestamp: turn.at };
	// A text block as well, because that is what an assistant turn that used a
	// tool actually looks like — and it is how a count of content blocks differs
	// from a count of tool calls.
	const content = [
		{ type: "text" as const, text: "let me look" },
		...Array.from({ length: turn.toolCalls }, (_, i) => ({
			type: "toolCall" as const,
			id: `call-${i}`,
			name: "read",
			arguments: "{}",
		})),
	];
	return {
		role: "assistant",
		content,
		provider: "faux",
		model: "faux-1",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse",
		timestamp: turn.at,
	};
}

/** A grid of days with the given message counts, one day each. */
function gridOf(messages: readonly number[]): ActivityDay[] {
	return messages.map((count, i) => ({
		date: dayKey(i + 1),
		sessions: 1,
		messages: count,
		toolCalls: 0,
		touched: false,
	}));
}

function dayKey(index: number): string {
	return `2026-09-${String(index).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Day keys
// ---------------------------------------------------------------------------

describe("localDayKey", () => {
	test("23:30 and 00:30 stay on the day the wall clock says", () => {
		// A negative offset is where `toISOString().slice(0, 10)` puts 23:30 on
		// tomorrow; a positive one is where it puts 00:30 on yesterday. Two zones,
		// chosen rather than inherited, so this holds on any machine.
		expect(inTimeZone("America/New_York", () => localDayKey(at(2026, 9, 26, 23, 30)))).toBe("2026-09-26");
		expect(inTimeZone("Asia/Shanghai", () => localDayKey(at(2026, 9, 27, 0, 30)))).toBe("2026-09-27");
	});

	test("pads the month and day, and reads the year the clock rolled into", () => {
		expect(inTimeZone("Asia/Shanghai", () => localDayKey(at(2026, 1, 5, 0, 5)))).toBe("2026-01-05");
		// UTC+14 puts noon UTC on the 1st of January local.
		expect(inTimeZone("Pacific/Kiritimati", () => localDayKey(Date.UTC(2025, 11, 31, 12)))).toBe("2026-01-01");
	});
});

describe("civilDayNumber", () => {
	test("adjacent days differ by one", () => {
		expect(civilDayNumber("2026-09-27") - civilDayNumber("2026-09-26")).toBe(1);
	});

	test("days either side of a daylight-saving transition differ by one", () => {
		// The reference divided a timestamp difference by 86 400 000 and rounded:
		// these pairs are 23 and 25 hours apart in the zones that observe them,
		// which round to 0 and 2 — a streak broken that never broke.
		for (const [from, to] of [
			["2026-03-08", "2026-03-09"],
			["2026-10-25", "2026-10-26"],
		]) {
			expect(civilDayNumber(to) - civilDayNumber(from)).toBe(1);
		}
	});

	test("produces whole day indices rather than fractions of a day", () => {
		for (const key of ["1970-01-01", "2026-03-08", "2026-09-26", "2026-12-31"]) {
			// An implementation built on `new Date(key + "T00:00:00")` gets the
			// host's local midnight, which in a zone behind UTC is a fraction of a
			// day earlier than the date it was handed.
			expect(Number.isInteger(inTimeZone("America/New_York", () => civilDayNumber(key)))).toBe(true);
		}
	});

	test("the epoch is day zero wherever the clock is", () => {
		// `new Date("1970-01-01")` is UTC midnight by the ISO spec, so an
		// implementation that goes through the host's local midnight lands on
		// 1969-12-31 in a zone ahead of UTC and floor-truncates a day away.
		expect(inTimeZone("Asia/Shanghai", () => civilDayNumber("1970-01-01"))).toBe(0);
		expect(inTimeZone("America/New_York", () => civilDayNumber("1970-01-01"))).toBe(0);
		expect(inTimeZone("Pacific/Kiritimati", () => civilDayNumber("1970-01-01"))).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Intensity
// ---------------------------------------------------------------------------

describe("intensityThresholds", () => {
	test("equal counts produce no scale at all, and no full-strength cell", () => {
		// The reference takes quantiles over the raw counts, so three equal days
		// give p25 = p50 = p75 and every cell clears p75: `█ █ █` for someone
		// whose entire history is three days of three messages.
		const days = gridOf([3, 3, 3]);
		const thresholds = intensityThresholds(days);
		expect(thresholds).toBeNull();
		expect(days.map((day) => activityLevel(day, thresholds))).toEqual([2, 2, 2]);
		expect(days.map((day) => activityLevel(day, thresholds))).not.toContain(4);
	});

	test("a single active day is a full-strength day to no one", () => {
		const days = gridOf([7]);
		expect(intensityThresholds(days)).toBeNull();
		expect(activityLevel(days[0], null)).toBe(2);
	});

	test("a day with no messages at all sets no scale", () => {
		expect(
			intensityThresholds([{ date: dayKey(1), sessions: 1, messages: 0, toolCalls: 0, touched: true }]),
		).toBeNull();
	});

	test("quantiles are taken over distinct counts, not over every day", () => {
		// Without the dedupe: p25 = p50 = p75 = 1, and all five days are level 4.
		const days = gridOf([1, 1, 1, 1, 9]);
		const thresholds = intensityThresholds(days);
		expect(thresholds).toEqual({ p25: 1, p50: 9, p75: 9 });
		expect(days.map((day) => activityLevel(day, thresholds))).toEqual([2, 2, 2, 2, 4]);
	});

	test("eight distinct counts split into four levels", () => {
		const days = gridOf([1, 2, 3, 4, 5, 6, 7, 8]);
		const thresholds = intensityThresholds(days);
		expect(thresholds).toEqual({ p25: 3, p50: 5, p75: 7 });
		expect(days.map((day) => activityLevel(day, thresholds))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
	});
});

describe("activityLevel", () => {
	const empty: ActivityDay = { date: dayKey(1), sessions: 0, messages: 0, toolCalls: 0, touched: false };

	test("a day nothing happened on is level 0, whatever the scale says", () => {
		expect(activityLevel(empty, { p25: 1, p50: 2, p75: 3 })).toBe(0);
		expect(activityLevel(empty, null)).toBe(0);
	});

	test("a day that was only touched is level 1, not level 0", () => {
		const touched: ActivityDay = { date: dayKey(1), sessions: 0, messages: 0, toolCalls: 0, touched: true };
		expect(activityLevel(touched, { p25: 1, p50: 2, p75: 3 })).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

describe("collectActivity", () => {
	test("a session in each of two projects is both collected", () => {
		const home = tmpHome("lbb-activity-home-");
		const first = at(2026, 9, 24);
		const second = at(2026, 9, 25);
		writeSession(home, { cwd: "C:\\work\\alpha", sessionId: "alpha-1", messages: [{ at: first }], mtimeMs: first });
		writeSession(home, { cwd: "C:\\work\\beta", sessionId: "beta-1", messages: [{ at: second }], mtimeMs: second });

		// The trap: with no `cwd`, `listSessions` reads `projects/` itself, where
		// every entry is a directory, so the `.jsonl` filter discards all of them
		// and it returns `[]` having reported nothing wrong. Pinned so the
		// collector can never be quietly rewritten onto it — if this ever goes
		// red, the trap is gone and this assertion is stale, not the collector.
		expect(SessionStore.listSessions(undefined, home)).toEqual([]);

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.totals.sessions).toBe(2);
		expect(report.firstDate).toBe("2026-09-24");
		expect(report.days.filter((day) => day.sessions > 0).map((day) => day.date)).toEqual(["2026-09-24", "2026-09-25"]);
	});

	test("counts the messages and tool calls a session holds", () => {
		const home = tmpHome("lbb-activity-counts-");
		const when = at(2026, 9, 25);
		writeSession(home, {
			cwd: "C:\\work\\alpha",
			messages: [{ at: when }, { at: when, toolCalls: 2 }, { at: when }],
			mtimeMs: when,
		});

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.totals.messages).toBe(3);
		expect(report.totals.toolCalls).toBe(2);
		expect(report.totals.activeDays).toBe(1);
		expect(report.totals.windowDays).toBe(2);
	});

	test("a session written on the day it started is that day's session, not two things", () => {
		const home = tmpHome("lbb-activity-same-day-");
		const when = at(2026, 9, 25);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: when }], mtimeMs: when });

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.days.find((day) => day.date === "2026-09-25")).toEqual({
			date: "2026-09-25",
			sessions: 1,
			messages: 1,
			toolCalls: 0,
			touched: false,
		});
		expect(report.days.filter((day) => day.touched).map((day) => day.date)).toEqual([]);
	});

	test("a session still being written is active on its mtime day, not only on its start day", () => {
		const home = tmpHome("lbb-activity-mtime-");
		const started = at(2026, 9, 22);
		const resumed = at(2026, 9, 25);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: started }], mtimeMs: resumed });

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.days.find((day) => day.date === "2026-09-22")).toEqual({
			date: "2026-09-22",
			sessions: 1,
			messages: 1,
			toolCalls: 0,
			touched: false,
		});
		expect(report.days.find((day) => day.date === "2026-09-25")?.touched).toBe(true);
		expect(report.streaks.current).toBe(0);
	});

	test("a session that ran past midnight is placed on the day it started", () => {
		// Every other session in this file has a single turn, so nothing in the
		// suite yet tells the *first* message's timestamp apart from the last one's.
		// That is not a hypothetical distinction: a thread left open overnight and
		// picked up in the morning is one session, and both of its messages belong
		// to the evening it was opened in. Read the last one instead and the session
		// slides forward a day — the evening goes blank, the morning gets a session
		// that was never started there, and because the mtime then agrees with the
		// (wrong) start day, the second channel quietly stops marking it.
		const home = tmpHome("lbb-activity-overnight-");
		const started = at(2026, 9, 24, 22);
		const finished = at(2026, 9, 25, 9);
		writeSession(home, {
			cwd: "C:\\work\\alpha",
			messages: [{ at: started }, { at: finished, toolCalls: 2 }],
			mtimeMs: finished,
		});

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.days.find((day) => day.date === "2026-09-24")).toEqual({
			date: "2026-09-24",
			sessions: 1,
			messages: 2,
			toolCalls: 2,
			touched: false,
		});
		expect(report.days.find((day) => day.date === "2026-09-25")?.touched).toBe(true);
		expect(report.totals.sessions).toBe(1);
	});

	test("a session that started before the window still reaches the report through its mtime", () => {
		const home = tmpHome("lbb-activity-spanning-");
		const started = at(2026, 9, 18);
		const resumed = at(2026, 9, 22);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: started }], mtimeMs: resumed });

		const report = collectActivity(home, { windowStart: startOfLocalDay(at(2026, 9, 20)), now: at(2026, 9, 26) });
		// Its start day is not a row this report has, so it is not counted as a
		// session — but the day it was actually worked on is in the window.
		expect(report.firstDate).toBe("2026-09-22");
		expect(report.totals.sessions).toBe(0);
		expect(report.days[0].date).toBe("2026-09-22");
		expect(report.days.find((day) => day.date === "2026-09-22")?.touched).toBe(true);
	});

	test("the mtime pre-filter drops what predates the window and keeps the boundary", () => {
		const home = tmpHome("lbb-activity-prefilter-");
		const windowStart = startOfLocalDay(at(2026, 9, 20));
		// Written on the first instant of the window, a minute into the day after
		// it, and a minute before it.
		writeSession(home, {
			cwd: "C:\\work\\alpha",
			messages: [{ at: at(2026, 9, 20, 9) }],
			mtimeMs: windowStart,
		});
		writeSession(home, {
			cwd: "C:\\work\\alpha",
			messages: [{ at: at(2026, 9, 21, 9) }],
			mtimeMs: at(2026, 9, 21, 9),
		});
		writeSession(home, {
			cwd: "C:\\work\\alpha",
			messages: [{ at: at(2026, 9, 19, 9) }],
			mtimeMs: windowStart - 60_000,
		});

		const report = collectActivity(home, { windowStart, now: at(2026, 9, 26) });
		expect(report.totals.sessions).toBe(2);
		expect(report.days.map((day) => day.sessions)).toEqual([1, 1, 0, 0, 0, 0, 0]);
		expect(report.truncated).toBe(true);
	});

	test("days has a row for every day of the window, holes included", () => {
		const home = tmpHome("lbb-activity-holes-");
		const start = at(2026, 9, 24);
		const later = at(2026, 9, 26);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: start }], mtimeMs: start });
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: later }], mtimeMs: later });

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.days).toEqual([
			{ date: "2026-09-24", sessions: 1, messages: 1, toolCalls: 0, touched: false },
			{ date: "2026-09-25", sessions: 0, messages: 0, toolCalls: 0, touched: false },
			{ date: "2026-09-26", sessions: 1, messages: 1, toolCalls: 0, touched: false },
		]);
		expect(report.totals.activeDays).toBe(2);
	});

	test("an empty home, a missing one and no home at all all report nothing, quietly", () => {
		const now = at(2026, 9, 26);
		const empty = tmpHome("lbb-activity-empty-");
		const missing = join(tmpHome("lbb-activity-missing-"), "not-a-home");

		for (const home of [empty, missing]) {
			const report = collectActivity(home, { windowStart: 0, now });
			expect(report.days).toEqual([]);
			expect(report.firstDate).toBeNull();
			expect(report.truncated).toBe(false);
			expect(report.streaks).toEqual({
				current: 0,
				currentStart: null,
				longest: 0,
				longestStart: null,
				longestEnd: null,
			});
			expect(report.totals).toEqual({
				sessions: 0,
				messages: 0,
				toolCalls: 0,
				activeDays: 0,
				windowDays: 0,
			});
		}

		expect(collectActivity(undefined, { windowStart: 0, now })).toEqual(
			collectActivity(empty, { windowStart: 0, now }),
		);
	});

	test("a window with nothing in it still has a row per day", () => {
		const empty = tmpHome("lbb-activity-window-");
		const report = collectActivity(empty, { windowStart: startOfLocalDay(at(2026, 9, 20)), now: at(2026, 9, 26) });
		expect(report.days).toHaveLength(7);
		expect(report.totals.activeDays).toBe(0);
		// A bounded window over an account with no sessions is hiding nothing, so
		// it is not truncated — the flag is about sessions the window drops, not
		// about the window being bounded.
		expect(report.truncated).toBe(false);
	});

	test("a session longer than the read cap still reports its start day", () => {
		const home = tmpHome("lbb-activity-long-");
		const when = at(2026, 9, 25);
		// Well past 64 KiB of transcript. The start day lives in the first message
		// entry, which any cap keeps, so only the counts are affected.
		const turns: FakeTurn[] = [{ at: when }];
		for (let i = 0; i < 4000; i++) turns.push({ at: when, toolCalls: 1 });
		writeSession(home, { cwd: "C:\\work\\alpha", messages: turns, mtimeMs: when });

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.days.find((day) => day.date === "2026-09-25")?.sessions).toBe(1);
		expect(report.totals.messages).toBeGreaterThan(0);
	});
});

describe("collectActivity windows", () => {
	test("a 7-day window opens six civil days back and ends today", () => {
		const now = at(2026, 9, 26, 17, 45);
		const start = windowStartFor("7d", now);
		expect(start).toBe(startOfLocalDay(at(2026, 9, 20)));
		expect(civilDayNumber(localDayKey(start)) - civilDayNumber(localDayKey(now))).toBe(-6);
	});

	test("a 30-day window opens 29 civil days back", () => {
		const now = at(2026, 9, 26);
		const start = windowStartFor("30d", now);
		expect(civilDayNumber(localDayKey(start)) - civilDayNumber(localDayKey(now))).toBe(-29);
		expect(windowStartFor("all", now)).toBe(0);
	});

	test("the window opens at midnight, to the minute", () => {
		// The *time of day* is the invariant here, not the date: a window that
		// opened at 05:45 still contains the right seven calendar days, so every
		// date-keyed assertion above passes over it. The zone is pinned because the
		// distance between a local midnight and a UTC one is exactly the offset,
		// and on a UTC+0 machine there is nothing there to see. Forty-five minutes
		// of offset catches a half-right fix as well as a wholly wrong one.
		inTimeZone("Asia/Kathmandu", () => {
			const start = windowStartFor("7d", at(2026, 9, 26, 17, 45));
			const opened = new Date(start);
			expect([opened.getHours(), opened.getMinutes(), opened.getSeconds(), opened.getMilliseconds()]).toEqual([
				0, 0, 0, 0,
			]);
			expect(localDayKey(start)).toBe("2026-09-20");
		});
	});

	test("the small hours of the window's first day are inside the window", () => {
		// The consequence of the above, which is what a user would actually notice:
		// the pre-filter drops anything older than the window, so a window that
		// opened partway into its first day silently discards the sessions written
		// before that part — the ones a person did at the start of a long day.
		const home = tmpHome("lbb-activity-window-open-");
		inTimeZone("Asia/Kathmandu", () => {
			const firstDay = at(2026, 9, 20, 3);
			writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: firstDay }], mtimeMs: firstDay });

			const report = collectActivity(home, {
				windowStart: windowStartFor("7d", at(2026, 9, 26, 17, 45)),
				now: at(2026, 9, 26, 17, 45),
			});
			expect(report.truncated).toBe(false);
			expect(report.days.find((day) => day.date === "2026-09-20")?.sessions).toBe(1);
		});
	});

	test("today's partial week is in the window and is its last day", () => {
		const home = tmpHome("lbb-activity-partial-");
		const now = at(2026, 9, 26, 17, 45);
		const opened = at(2026, 9, 20, 9);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: opened }], mtimeMs: opened });
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: now }], mtimeMs: now });

		const report = collectActivity(home, { windowStart: windowStartFor("7d", now), now });
		expect(report.days).toHaveLength(7);
		// The week is a half-written one and the grid still shows all of it, with
		// the day that is only 17:45 old as the last row rather than a whole one.
		expect(report.days.at(-1)).toEqual({
			date: "2026-09-26",
			sessions: 1,
			messages: 1,
			toolCalls: 0,
			touched: false,
		});
	});

	test("a window crossing a month end keeps both ends", () => {
		const home = tmpHome("lbb-activity-month-");
		const now = at(2026, 10, 2, 9);
		const start = windowStartFor("7d", now);
		expect(localDayKey(start)).toBe("2026-09-26");

		const opened = at(2026, 9, 26, 9);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: opened }], mtimeMs: opened });
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: now }], mtimeMs: now });
		const report = collectActivity(home, { windowStart: start, now });
		expect(report.days.map((day) => day.date)).toEqual([
			"2026-09-26",
			"2026-09-27",
			"2026-09-28",
			"2026-09-29",
			"2026-09-30",
			"2026-10-01",
			"2026-10-02",
		]);
	});

	test("truncated is true when the window hides an older session and false for `all`", () => {
		const home = tmpHome("lbb-activity-truncated-");
		const old = at(2026, 9, 1);
		const recent = at(2026, 9, 25);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: old }], mtimeMs: old });
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: recent }], mtimeMs: recent });
		const windowStart = startOfLocalDay(at(2026, 9, 20));

		expect(collectActivity(home, { windowStart, now: at(2026, 9, 26) }).truncated).toBe(true);
		expect(collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) }).truncated).toBe(false);
	});

	test("truncated is false when everything is inside the window", () => {
		const home = tmpHome("lbb-activity-untruncated-");
		const when = at(2026, 9, 25);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: when }], mtimeMs: when });

		expect(
			collectActivity(home, { windowStart: startOfLocalDay(at(2026, 9, 20)), now: at(2026, 9, 26) }).truncated,
		).toBe(false);
	});

	test("the grid starts at the later of the window and the first day in it", () => {
		const home = tmpHome("lbb-activity-anchor-");
		const recent = at(2026, 9, 25);
		writeSession(home, { cwd: "C:\\work\\alpha", messages: [{ at: recent }], mtimeMs: recent });

		// A 7-day window on a one-day-old account: five empty rows in front of the
		// one day that happened, not seven rows of which two are real.
		const report = collectActivity(home, { windowStart: startOfLocalDay(at(2026, 9, 20)), now: at(2026, 9, 26) });
		expect(report.days[0].date).toBe("2026-09-25");
		expect(report.days).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

describe("streaks", () => {
	test("a day that was only touched keeps the streak alive", () => {
		const home = tmpHome("lbb-activity-streak-union-");
		const five = [
			// The session that was opened on 09-18 and is still being written on
			// 09-24: the mtime channel, and the reason 09-24 counts.
			{ cwd: "C:\\work\\a", messages: [{ at: at(2026, 9, 18) }], mtimeMs: at(2026, 9, 24) },
			{ cwd: "C:\\work\\b", messages: [{ at: at(2026, 9, 22) }], mtimeMs: at(2026, 9, 22) },
			{ cwd: "C:\\work\\c", messages: [{ at: at(2026, 9, 23) }], mtimeMs: at(2026, 9, 23) },
			{ cwd: "C:\\work\\d", messages: [{ at: at(2026, 9, 25) }], mtimeMs: at(2026, 9, 25) },
			{ cwd: "C:\\work\\e", messages: [{ at: at(2026, 9, 26) }], mtimeMs: at(2026, 9, 26) },
		];
		for (const spec of five) writeSession(home, spec);

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		// 22, 23, 24 (touched only), 25, 26. 09-24 has no session of its own —
		// it is the mtime of the session that started on 09-18.
		expect(report.days.find((day) => day.date === "2026-09-24")).toEqual({
			date: "2026-09-24",
			sessions: 0,
			messages: 0,
			toolCalls: 0,
			touched: true,
		});
		expect(report.streaks.current).toBe(5);
		expect(report.streaks.currentStart).toBe("2026-09-22");
	});

	test("two runs of the same length keep the earlier one", () => {
		const home = tmpHome("lbb-activity-streak-tie-");
		const specs = [
			{ cwd: "C:\\work\\a", messages: [{ at: at(2026, 9, 19) }], mtimeMs: at(2026, 9, 19) },
			{ cwd: "C:\\work\\b", messages: [{ at: at(2026, 9, 20) }], mtimeMs: at(2026, 9, 20) },
			{ cwd: "C:\\work\\c", messages: [{ at: at(2026, 9, 25) }], mtimeMs: at(2026, 9, 25) },
			{ cwd: "C:\\work\\d", messages: [{ at: at(2026, 9, 26) }], mtimeMs: at(2026, 9, 26) },
		];
		for (const spec of specs) writeSession(home, spec);

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.streaks.current).toBe(2);
		expect(report.streaks.currentStart).toBe("2026-09-25");
		expect(report.streaks.longest).toBe(2);
		expect(report.streaks.longestStart).toBe("2026-09-19");
		expect(report.streaks.longestEnd).toBe("2026-09-20");
	});

	test("a single blank day between two runs does not join them", () => {
		// The narrowest version of "a run is broken by a day with nothing on it", and
		// the one a forgiving implementation gets wrong: two two-day runs with a
		// single hole between them become one four-day run, and the card reports four
		// days for somebody who worked on two.
		const home = tmpHome("lbb-activity-streak-onehole-");
		for (const day of [19, 20, 22, 23]) {
			const when = at(2026, 9, day);
			writeSession(home, { cwd: `C:\\work\\${day}`, messages: [{ at: when }], mtimeMs: when });
		}

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		// 09-21 has no session and no mtime, and it is still a hole in the run.
		expect(report.days.find((day) => day.date === "2026-09-21")?.sessions).toBe(0);
		expect(report.streaks.longest).toBe(2);
		expect(report.streaks.longestStart).toBe("2026-09-19");
		expect(report.streaks.longestEnd).toBe("2026-09-20");
	});

	test("yesterday does not count for today", () => {
		const home = tmpHome("lbb-activity-streak-grace-");
		const yesterday = at(2026, 9, 25);
		writeSession(home, { cwd: "C:\\work\\a", messages: [{ at: yesterday }], mtimeMs: yesterday });

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.streaks.current).toBe(0);
		expect(report.streaks.currentStart).toBeNull();
		// The longest run is untouched by today being quiet.
		expect(report.streaks.longest).toBe(1);
		expect(report.streaks.longestStart).toBe("2026-09-25");
		expect(report.streaks.longestEnd).toBe("2026-09-25");
	});

	test("a run that ends yesterday has no current start at all", () => {
		const home = tmpHome("lbb-activity-streak-gap-");
		const specs = [
			{ cwd: "C:\\work\\a", messages: [{ at: at(2026, 9, 24) }], mtimeMs: at(2026, 9, 24) },
			{ cwd: "C:\\work\\b", messages: [{ at: at(2026, 9, 25) }], mtimeMs: at(2026, 9, 25) },
		];
		for (const spec of specs) writeSession(home, spec);

		const report = collectActivity(home, { windowStart: 0, now: at(2026, 9, 26) });
		expect(report.streaks.longest).toBe(2);
		expect(report.streaks.longestStart).toBe("2026-09-24");
		expect(report.streaks.longestEnd).toBe("2026-09-25");
		expect(report.streaks.current).toBe(0);
		expect(report.streaks.currentStart).toBeNull();
	});

	test("two days across a daylight-saving transition are two days", () => {
		// 2026-03-08 and 2026-03-09 are 23 hours apart in New York. Anything that
		// asks "is this the next day?" by dividing hours and truncating reads 0
		// and breaks a streak that did not break.
		const home = tmpHome("lbb-activity-streak-dst-");
		inTimeZone("America/New_York", () => {
			const before = at(2026, 3, 8, 20);
			const after = at(2026, 3, 9, 20);
			writeSession(home, { cwd: "C:\\work\\a", messages: [{ at: before }], mtimeMs: before });
			writeSession(home, { cwd: "C:\\work\\b", messages: [{ at: after }], mtimeMs: after });

			const report = collectActivity(home, { windowStart: 0, now: at(2026, 3, 9, 23) });
			expect(report.days.map((day) => day.date)).toEqual(["2026-03-08", "2026-03-09"]);
			expect(report.streaks.current).toBe(2);
			expect(report.streaks.currentStart).toBe("2026-03-08");
		});
	});
});
