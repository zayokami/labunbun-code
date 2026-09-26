/**
 * `/activity`: the line the transcript keeps, from the walk the heatmap draws.
 *
 * The panel is the answer — a year of days at a glance, which is a picture and
 * not a sentence. This is the other half: a picture scrolls out of reach, and
 * the one number somebody asks about is the streak. The walk runs twice, once
 * for each: the panel re-collects when `r` widens the window, and a report
 * frozen here would have to be re-walked for every range the key cycles
 * through. That is cheap on purpose — the mtime prefilter leaves a handful of
 * files to read, not the 1.9 MB the whole tree is.
 *
 * The wording is duplicated between the two layers, and cannot be shared: the
 * panel lives in the TUI package and the TUI must not depend on the app layer.
 * What is shared is the *rule* the two obey — a count of one takes the singular
 * — and each side has a test that says so.
 */
import type { ActivityRange, ActivityReport } from "@labunbun/agent";

/** What each range is called in a sentence, which is not the key that chose it. */
const RANGE_NAMES: Record<ActivityRange, string> = {
	"7d": "the last 7 days",
	"30d": "the last 30 days",
	all: "all time",
};

/** `1 day` and not `1 days`. Every count in here goes through this. */
function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one line `/activity` leaves in the transcript.
 *
 * Leads with the streak because that is the figure the panel cannot be read for:
 * a grid shows which days were busy, and "you have been at it twelve days
 * running" is a different sentence from anything in it. The active-day count
 * follows, and the window's own size with it, so `12 of 30` is readable as the
 * proportion it is rather than as a bare number.
 *
 * An empty walk says so rather than reporting a zero streak, which is what a
 * genuinely-zero streak would also say — and the two are not the same claim
 * about the user.
 */
export function activitySummaryLine(report: ActivityReport, range: ActivityRange): string {
	const scope = RANGE_NAMES[range];
	if (!report.firstDate) return `Activity: nothing recorded ${scope} yet.`;

	const streak =
		report.streaks.current > 0
			? `Current streak ${plural(report.streaks.current, "day")} (since ${report.streaks.currentStart ?? "today"})`
			: "No streak — nothing active today";
	const longest =
		report.streaks.longest > 0
			? `longest ${plural(report.streaks.longest, "day")} (${report.streaks.longestStart} – ${report.streaks.longestEnd})`
			: "no run of consecutive days yet";

	return (
		`Activity ${scope}: ${streak}; ${longest}; ` +
		`${plural(report.totals.activeDays, "active day")} of ${report.totals.windowDays}` +
		(report.truncated ? " (older history exists and is not in this window)" : "") +
		"."
	);
}
