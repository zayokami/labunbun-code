/**
 * What `/activity` says, given a report.
 *
 * Two things are held to account here, and they are the two a picture cannot
 * check for you: that every count in the sentence agrees with the report it
 * came from, and that a count of one is written in the singular. The heatmap
 * shows the same numbers as a grid, and a grid cannot say "days" or "day" — so
 * the line is the only place the grammar of the feature lives.
 */
import { describe, expect, test } from "bun:test";
import type { ActivityRange, ActivityReport } from "@labunbun/agent";
import { activitySummaryLine } from "../src/activity-report.ts";

function report(over: Partial<ActivityReport> = {}): ActivityReport {
	return {
		days: [],
		streaks: { current: 0, currentStart: null, longest: 0, longestStart: null, longestEnd: null },
		totals: { sessions: 0, messages: 0, toolCalls: 0, activeDays: 0, windowDays: 30 },
		firstDate: null,
		truncated: false,
		...over,
	};
}

/** The same report, three ranges, so a range-dependent word cannot hide. */
const RANGES: ActivityRange[] = ["7d", "30d", "all"];

describe("activitySummaryLine", () => {
	test("names every count in the report", () => {
		const line = activitySummaryLine(
			report({
				firstDate: "2026-09-01",
				streaks: {
					current: 12,
					currentStart: "2026-09-15",
					longest: 30,
					longestStart: "2026-08-20",
					longestEnd: "2026-09-18",
				},
				totals: { sessions: 40, messages: 900, toolCalls: 210, activeDays: 22, windowDays: 30 },
			}),
			"30d",
		);
		expect(line).toContain("Current streak 12 days");
		expect(line).toContain("since 2026-09-15");
		expect(line).toContain("longest 30 days");
		expect(line).toContain("2026-08-20 – 2026-09-18");
		expect(line).toContain("22 active days of 30");
	});

	// The rule the grid cannot carry: one is one day, not one days. A count of
	// one is the case a pluralising template is most likely to get wrong, and the
	// most likely day for a real streak to be.
	test("a count of one is singular, everywhere it appears", () => {
		const line = activitySummaryLine(
			report({
				firstDate: "2026-09-25",
				streaks: {
					current: 1,
					currentStart: "2026-09-25",
					longest: 1,
					longestStart: "2026-09-25",
					longestEnd: "2026-09-25",
				},
				totals: { sessions: 1, messages: 4, toolCalls: 0, activeDays: 1, windowDays: 1 },
			}),
			"7d",
		);
		expect(line).toContain("Current streak 1 day (");
		expect(line).toContain("longest 1 day (");
		expect(line).toContain("1 active day of 1");
		expect(line).not.toContain("1 days");
		expect(line).not.toContain("1 day of 1 day,");
	});

	test("two is plural — the boundary the singular branch must not creep past", () => {
		const line = activitySummaryLine(
			report({
				firstDate: "2026-09-24",
				streaks: {
					current: 2,
					currentStart: "2026-09-24",
					longest: 2,
					longestStart: "2026-09-24",
					longestEnd: "2026-09-25",
				},
				totals: { sessions: 2, messages: 8, toolCalls: 1, activeDays: 2, windowDays: 7 },
			}),
			"7d",
		);
		expect(line).toContain("Current streak 2 days");
		expect(line).toContain("2 active days of 7");
	});

	// A zero streak and an empty walk both mean "no number to show", and they
	// are different claims: one is about today, the other about whether the
	// collector found anything at all. Collapsing them would report a user who
	// has never run this as though they had stopped today.
	test("an empty walk says so, rather than reporting a zero streak", () => {
		for (const range of RANGES) {
			const line = activitySummaryLine(report(), range);
			expect(line).toContain("nothing recorded");
			expect(line).not.toContain("streak 0");
			expect(line).not.toContain("0 active days");
		}
	});

	test("a real history with nothing active today is a zero streak, not an empty walk", () => {
		const line = activitySummaryLine(
			report({
				firstDate: "2026-09-01",
				streaks: { current: 0, currentStart: null, longest: 5, longestStart: "2026-09-01", longestEnd: "2026-09-05" },
				totals: { sessions: 9, messages: 200, toolCalls: 30, activeDays: 5, windowDays: 30 },
			}),
			"30d",
		);
		expect(line).toContain("No streak");
		expect(line).toContain("longest 5 days");
		expect(line).toContain("5 active days of 30");
		expect(line).not.toContain("nothing recorded");
	});

	// The window can cut history that exists. Saying nothing about it would let
	// a reader conclude the 30-day heatmap is the whole record.
	test("a truncated window says older history exists", () => {
		const truncated = activitySummaryLine(
			report({
				firstDate: "2026-09-20",
				truncated: true,
				totals: { sessions: 3, messages: 10, toolCalls: 0, activeDays: 3, windowDays: 7 },
			}),
			"7d",
		);
		const whole = activitySummaryLine(
			report({
				firstDate: "2026-09-20",
				truncated: false,
				totals: { sessions: 3, messages: 10, toolCalls: 0, activeDays: 3, windowDays: 7 },
			}),
			"7d",
		);
		expect(truncated).toContain("older history exists");
		expect(whole).not.toContain("older history exists");
	});

	// `all` is the one range whose name is not a duration, so a formatter that
	// builds every name from the key would print "the last all days".
	test("each range is named the way a person would say it", () => {
		const line = (range: ActivityRange) => activitySummaryLine(report({ firstDate: "2026-09-25" }), range);
		expect(line("7d")).toContain("the last 7 days");
		expect(line("30d")).toContain("the last 30 days");
		expect(line("all")).toContain("all time");
		expect(line("all")).not.toContain("the last all");
	});
});
