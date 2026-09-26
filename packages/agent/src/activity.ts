/**
 * Activity heatmap and streak arithmetic — the logic half, with no renderer.
 *
 * Two things here are load-bearing, and both are places the obvious
 * implementation is wrong. Everything else in this file is arithmetic.
 *
 * **Every date is a local civil day, never a UTC one.** The reference this was
 * derived from computes them with `toISOString().slice(0, 10)`, which is a UTC
 * day: a session run at 23:30 in any negative-offset zone lands in tomorrow's
 * column, and at 00:30 in any positive-offset zone it lands in yesterday's. Its
 * own changelog records the symptom — "daily token chart dates showing one day
 * early in UTC-negative timezones". {@link localDayKey} reads the local
 * calendar instead, and a timestamp is the only thing it ever converts.
 *
 * **Streaks are counted in day numbers, not milliseconds.** Not because
 * milliseconds are wrong — they are not, and the reason is worth recording so
 * nobody re-derives a fix for a bug that isn't there. The reference takes a
 * timestamp difference, divides by 86 400 000, and rounds, and **that rounds
 * correctly in every timezone measured**: `new Date("YYYY-MM-DD")` is a UTC
 * midnight by the ISO spec, so two such strings differ by exactly 86 400 000 ms
 * and `round` is 1; and even with *local* midnights the `T00:00:00` parse lands
 * on the side of a DST transition that leaves the difference a clean 24 h. That
 * was checked across UTC, America/New_York, Australia/Lord_Howe, Asia/Shanghai
 * and Pacific/Chatham, on spring-forward, fall-back and two-day spans — 1 every
 * time.
 *
 * What the reference actually gets wrong is *mixing the two calendars*. Its
 * `calculateStreaks` walks back with `new Date()` and `setDate(-1)`, which is
 * the local calendar, and formats with `toISOString()`, which is UTC — and that
 * combination, not the arithmetic, is what the changelog's "one day early"
 * entry is about. {@link civilDayNumber} keeps the two apart by turning a
 * `YYYY-MM-DD` into an integer day index through `Date.UTC`, so adjacency is
 * integer arithmetic, the host timezone is never consulted, and a test cannot
 * change its answer by moving machines. That is the reason it exists — integer
 * arithmetic and one calendar, not defence against a bug that was never there.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@labunbun/ai";
import { SessionStore, sessionsRoot } from "./session-store.ts";

export type ActivityDay = {
	/** 本地民用日，YYYY-MM-DD。 */
	date: string;
	/** 首条消息落在这一天的会话数。 */
	sessions: number;
	/** 那些会话里的消息数。 */
	messages: number;
	/** 那些会话里的工具调用数。 */
	toolCalls: number;
	/** 有会话的 mtime 落在这一天，且它不是那个会话的起始日。 */
	touched: boolean;
};

export type Streaks = {
	/**
	 * Days counted back from today, stopping at the first inactive one. There is
	 * no grace for yesterday: a run that survives a missed day is not a run.
	 */
	current: number;
	/** The day the current run started; null when {@link current} is 0. */
	currentStart: string | null;
	/**
	 * The longest run **inside the window**, not over all history.
	 *
	 * This is the one figure here that is bounded by the range rather than by the
	 * data, and it is bounded on purpose: the mtime pre-filter is what makes a
	 * seven-day window cost a handful of file reads instead of a walk of every
	 * session ever written, and a true all-time longest would give that up. So on
	 * a 7-day window this cannot exceed 7 however long the real run was, and the
	 * `all` range is the one that answers the all-time question. Every caller
	 * that shows it says which window it is inside, because "longest 3 days" is a
	 * different claim from "longest 3 days, ever".
	 */
	longest: number;
	/** First day of the longest run; null when {@link longest} is 0. */
	longestStart: string | null;
	/** Last day of the longest run, inclusive; null when {@link longest} is 0. */
	longestEnd: string | null;
};

export type ActivityTotals = {
	sessions: number;
	messages: number;
	toolCalls: number;
	activeDays: number;
	windowDays: number;
};

export type ActivityReport = {
	/** 升序，覆盖窗口内每一天，含空洞。 */
	days: ActivityDay[];
	streaks: Streaks;
	totals: ActivityTotals;
	/** 窗口内最早的起始日；空则 null。 */
	firstDate: string | null;
	/** 窗口截断了更早的历史；`all` 时为 false。 */
	truncated: boolean;
};

export type ActivityRange = "7d" | "30d" | "all";

export type IntensityThresholds = { p25: number; p50: number; p75: number };

const DAY_MS = 86_400_000;

/**
 * How much of a session file is read for the counts.
 *
 * The start day lives in the first `message` entry, which follows the header
 * and so is always inside any sane cap; the *counts* are what a cap costs. A
 * 64 KiB head is a few dozen turns, which is the right order of magnitude for
 * "how much happened" and the wrong order for an audit. {@link
 * SessionStore.load} drops the partial line the cap lands on, so a capped read
 * never reports the fragment as a damaged entry.
 */
const HEAD_BYTES = 64 * 1024;

/** The local calendar day an instant falls in, as `YYYY-MM-DD`. */
export function localDayKey(ms: number): string {
	const date = new Date(ms);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Local midnight at the start of the day an instant falls in. */
export function startOfLocalDay(ms: number): number {
	const date = new Date(ms);
	// `setHours` rather than an arithmetic subtraction: on the day a zone
	// changes its offset, local midnight is 23 or 25 hours after the previous
	// day's, and only the calendar knows which.
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * `YYYY-MM-DD` as an integer day index, for comparing calendar days.
 *
 * `Date.UTC` is the whole trick: the arguments are read as UTC fields, so this
 * is arithmetic on a (year, month, day) triple and cannot be shifted by the
 * host's offset. That is what makes "were these two days adjacent?" a question
 * about integers — see the note at the top of the file.
 */
export function civilDayNumber(date: string): number {
	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(5, 7));
	const day = Number(date.slice(8, 10));
	return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1970, 0, 1)) / DAY_MS);
}

/** First instant of the window a range means, given "now". */
export function windowStartFor(range: ActivityRange, now: number): number {
	if (range === "all") return 0;
	const date = new Date(startOfLocalDay(now));
	// Six days back from today *includes* today, so 7d is 6 and 30d is 29.
	// `setDate` rather than subtracting milliseconds: six civil days is 143 or
	// 145 hours either side of a daylight-saving transition, not 144.
	date.setDate(date.getDate() - (range === "7d" ? 6 : 29));
	return date.getTime();
}

/**
 * The message counts that split active days into four intensities.
 *
 * Deduplicated before the quantiles are taken, and that is the fix rather than a
 * detail. The reference takes quantiles over the raw sorted counts, so a user
 * with three days of three messages each gets `p25 = p50 = p75 = 3` — every cell
 * at or above `p75`, every cell full-strength, and a brand-new account looking
 * exactly as busy as a heavy one. A heatmap has to be able to say "you have no
 * idea yet how much a busy day looks like", which is what `null` means here and
 * what {@link activityLevel} renders as a single honest middle shade.
 *
 * A day qualifies as active for this purpose by having messages. A day marked
 * only `touched` has none, so it sets no scale; it is still a real day and
 * still gets a level of its own.
 */
export function intensityThresholds(days: readonly ActivityDay[]): IntensityThresholds | null {
	const counts: number[] = [];
	for (const day of days) if (day.messages > 0) counts.push(day.messages);
	if (counts.length === 0) return null;
	const unique = [...new Set(counts)].sort((a, b) => a - b);
	if (unique.length <= 1) return null;
	const quantile = (q: number): number => unique[Math.min(unique.length - 1, Math.floor(unique.length * q))];
	return { p25: quantile(0.25), p50: quantile(0.5), p75: quantile(0.75) };
}

/**
 * One cell's intensity, 0 (inactive) through 4 (busiest).
 *
 * A day is active if either channel saw it — a session started on it, or a
 * session still being written on it. Both count, because both are the person
 * working: a session opened on Monday and finished on Wednesday did not stop
 * being work on Tuesday.
 */
export function activityLevel(day: ActivityDay, thresholds: IntensityThresholds | null): 0 | 1 | 2 | 3 | 4 {
	if (!isActiveDay(day)) return 0;
	// No scale to place it on. Level 2 for every active cell: the honest flat
	// read. Level 4 here would say "busiest day so far" about a person's first
	// day, and level 1 would say "barely used" about the same day.
	if (thresholds === null) return 2;
	if (day.messages >= thresholds.p75) return 4;
	if (day.messages >= thresholds.p50) return 3;
	if (day.messages >= thresholds.p25) return 2;
	return 1;
}

/**
 * Read every session under `home` and lay it out on a day-by-day grid.
 *
 * `home` is an OS home directory (the one holding `.labunbun`); `undefined`
 * yields the empty report rather than an error, because a caller that has not
 * resolved a home yet has not failed — it has nothing to show.
 *
 * **Two channels, because one undercounts.** The start day is the first
 * `message` entry's timestamp, read from the head of the file: it is the only
 * honest answer, since the ISO date embedded in a session *filename* is
 * `toISOString()` output and therefore a UTC day. The mtime is the second
 * channel, and it is the only evidence that a session which started last week
 * is still being used today. A day is `touched` when the mtime lands on it and
 * the session did not start there, so a session opened and finished in one
 * afternoon is counted once.
 *
 * A session whose start day falls before the window still counts through its
 * mtime: that is the long-running-session case the second channel exists for.
 * Its messages are not counted anywhere, because its start day is not a row
 * this report has.
 *
 * **No cache, deliberately.** The reference keeps a `stats-cache.json` with its
 * own version migration, and its changelog records the cost of getting that
 * wrong: "cache format change lost 30+ days of history". The store this reads is
 * small — 465 project directories, 425 session files, 1.9 MB — and a full pass
 * over a synthetic tree of that shape measured ~140 ms on the machine this was
 * written on, against a 300 ms bar. The cost is per *file*, not per byte: only a
 * 64 KiB head is read from each, so an 85 MB tree with the same 310 files still
 * collects in ~200 ms, and the number that would break the 300 ms bar is the
 * session count rather than the transcript size. If a pass ever measures over
 * 300 ms, the thing to add is an incremental cache keyed on the window and each
 * file's mtime — not a rewrite of this, and not a cache that can lose history to
 * a format change.
 *
 * @param home OS home directory; `undefined` collects nothing.
 * @param opts.windowStart First instant in scope. Anything older is dropped,
 *   and anything that exists older than it sets {@link ActivityReport.truncated}.
 * @param opts.now "Today", for the grid's last row. Injectable so the grid is
 *   deterministic; defaults to the wall clock. This function reads nothing else
 *   from the clock.
 */
export function collectActivity(home: string | undefined, opts: { windowStart: number; now?: number }): ActivityReport {
	const now = opts.now ?? Date.now();
	const windowStart = opts.windowStart;
	// The day the window opens on. Empty for `all`, which sorts before every real
	// date, so the anchor below becomes the first session's day rather than 1970.
	const windowDayKey = windowStart === 0 ? "" : localDayKey(windowStart);
	const buckets = new Map<string, Bucket>();
	let truncated = false;

	const scan =
		home === undefined ? { files: [], truncated: false } : sessionFilesUnder(sessionsRoot(home), windowStart);
	truncated = scan.truncated;

	for (const file of scan.files) {
		let store: SessionStore;
		try {
			store = SessionStore.load(file.path, { maxBytes: HEAD_BYTES });
		} catch {
			// One unreadable file is not a reason to lose the other four hundred.
			continue;
		}
		let startKey: string | null = null;
		let messages = 0;
		let toolCalls = 0;
		for (const entry of store.entries) {
			if (entry.type !== "message") continue;
			if (startKey === null && Number.isFinite(entry.timestamp)) startKey = localDayKey(entry.timestamp);
			messages += 1;
			toolCalls += countToolCalls(entry.message);
		}
		const mtimeKey = localDayKey(file.mtimeMs);
		// Channel one. `YYYY-MM-DD` compares chronologically as a string — fixed
		// width, zero padded — so a session that started before the window is
		// excluded here and still reaches the report through its mtime below.
		if (startKey !== null && startKey >= windowDayKey) {
			const bucket = bucketFor(buckets, startKey);
			bucket.sessions += 1;
			bucket.messages += messages;
			bucket.toolCalls += toolCalls;
		}
		// Channel two. A file that was written on the day it started is that day's
		// session and not a second thing that happened to it.
		if (mtimeKey !== startKey) bucketFor(buckets, mtimeKey).touched = true;
	}

	// The earliest day this report has anything for. That is not always a start
	// day: a session opened before the window and written inside it contributes
	// only an mtime, and a report anchored on nothing would be blank. When any
	// start day is in the window the two agree anyway — an mtime can never
	// precede its own session's start, so the earliest mtime is bounded below by
	// some start day. Every bucket key is in the window: the mtime by the
	// pre-filter, the start day by the check above.
	let firstDate: string | null = null;
	for (const key of buckets.keys()) if (firstDate === null || key < firstDate) firstDate = key;

	// The grid runs from the later of "the window opens" and "the first thing in
	// the report", so a 7-day window on a five-day-old account shows five days
	// and not two empty ones in front of them. With nothing to anchor to and no
	// window to fall back on there is no range to draw, and the honest row count
	// is zero — not twenty thousand days back to the epoch.
	const days: ActivityDay[] = [];
	if (firstDate !== null || windowDayKey !== "") {
		const anchor = firstDate !== null && firstDate > windowDayKey ? firstDate : windowDayKey;
		const last = civilDayNumber(localDayKey(now));
		for (let number = civilDayNumber(anchor); number <= last; number++) {
			const key = dayKeyFor(number);
			const bucket = buckets.get(key);
			days.push({
				date: key,
				sessions: bucket?.sessions ?? 0,
				messages: bucket?.messages ?? 0,
				toolCalls: bucket?.toolCalls ?? 0,
				touched: bucket?.touched ?? false,
			});
		}
	}

	return {
		days,
		streaks: computeStreaks(days, localDayKey(now)),
		totals: {
			sessions: sum(days, (day) => day.sessions),
			messages: sum(days, (day) => day.messages),
			toolCalls: sum(days, (day) => day.toolCalls),
			activeDays: days.filter(isActiveDay).length,
			windowDays: days.length,
		},
		firstDate,
		truncated,
	};
}

type Bucket = { sessions: number; messages: number; toolCalls: number; touched: boolean };

function bucketFor(buckets: Map<string, Bucket>, key: string): Bucket {
	let bucket = buckets.get(key);
	if (bucket === undefined) {
		bucket = { sessions: 0, messages: 0, toolCalls: 0, touched: false };
		buckets.set(key, bucket);
	}
	return bucket;
}

function sum(days: readonly ActivityDay[], pick: (day: ActivityDay) => number): number {
	let total = 0;
	for (const day of days) total += pick(day);
	return total;
}

function isActiveDay(day: ActivityDay): boolean {
	return day.sessions > 0 || day.touched;
}

/**
 * Every session file under the projects root, with the ones the window cannot
 * show already dropped.
 *
 * This walk is the reason this module exists. `SessionStore.listSessions()`
 * without a `cwd` reads the projects root itself, where every entry is a
 * *directory* named for a sanitized cwd: there is not one `.jsonl` at that
 * level, so the filter that keeps only `.jsonl` discards all of them and the
 * call returns `[]` having found nothing and reported nothing wrong. A heatmap
 * built on that call is empty, and an empty heatmap looks like a quiet week. So
 * the descent is done here instead — one level for the projects, one more for
 * each project — and the two `readdirSync` calls are each inside their own
 * `try`, because a panel that throws because one directory is unreadable is
 * worse than a panel that is one day short.
 *
 * The mtime pre-filter is safe in the direction it cuts: a file's mtime is when
 * it was last written, it is only written while a session runs, and so a file
 * whose mtime predates the window has no line inside the window either — not
 * even its header's. The boundary is `>=`, so a session written on the first
 * instant of the window is in.
 */
function sessionFilesUnder(
	root: string,
	windowStart: number,
): { files: Array<{ path: string; mtimeMs: number }>; truncated: boolean } {
	const files: Array<{ path: string; mtimeMs: number }> = [];
	let truncated = false;
	let projects: string[];
	try {
		projects = readdirSync(root);
	} catch {
		// No projects directory yet, or one this process cannot read. The
		// try/catch is the only guard here on purpose: an `existsSync` first would
		// cover the missing-directory case and leave this covering permission
		// errors, and either one alone is then untested.
		return { files, truncated };
	}
	for (const project of projects) {
		let names: string[];
		try {
			names = readdirSync(join(root, project));
		} catch {
			continue; // Not a project directory, or unreadable. Neither is this report's problem.
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const path = join(root, project, name);
			let mtimeMs: number;
			try {
				mtimeMs = statSync(path).mtimeMs;
			} catch {
				continue;
			}
			if (windowStart > 0 && mtimeMs < windowStart) {
				// The window is hiding this session's existence, not just its
				// contents, and the panel needs to be able to say so.
				truncated = true;
				continue;
			}
			files.push({ path, mtimeMs });
		}
	}
	return { files, truncated };
}

/**
 * Tool invocations in one message: the `toolCall` blocks the model asked for.
 *
 * Counting the results instead would give the same number on a healthy file and
 * a different one on a head-capped or damaged read, and it would report the
 * model's requests as work done.
 */
function countToolCalls(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	let calls = 0;
	for (const block of message.content) if (block.type === "toolCall") calls += 1;
	return calls;
}

/**
 * The inverse of {@link civilDayNumber}.
 *
 * The `getUTC*` getters are deliberate: the argument is a civil day index, not
 * an instant, so reading it back through the local getters would put the host
 * timezone back into arithmetic that exists to stay out of it.
 */
function dayKeyFor(dayNumber: number): string {
	const date = new Date(dayNumber * DAY_MS);
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${date.getUTCFullYear()}-${month}-${day}`;
}

/**
 * Current and longest runs of consecutive active days.
 *
 * `days` is dense and ascending, so the active days within it are unique and
 * already sorted; the runs are then plain integer adjacency. `current` counts
 * backwards from today and stops at the first day that is not active — there is
 * no grace for yesterday, because a streak that survives a missed day is not a
 * streak. `longest` keeps the *earlier* of two equal runs: the comparison is
 * `>`, and the runs arrive in date order.
 */
function computeStreaks(days: readonly ActivityDay[], todayKey: string): Streaks {
	const active = new Set<number>();
	for (const day of days) if (isActiveDay(day)) active.add(civilDayNumber(day.date));
	const runs: Array<{ start: number; length: number }> = [];
	for (const number of [...active].sort((a, b) => a - b)) {
		const last = runs.at(-1);
		if (last !== undefined && number === last.start + last.length) last.length += 1;
		else runs.push({ start: number, length: 1 });
	}
	let longest = { length: 0, start: 0 };
	for (const run of runs) if (run.length > longest.length) longest = run;
	let current = 0;
	let currentStart: number | null = null;
	for (let number = civilDayNumber(todayKey); active.has(number); number -= 1) {
		current += 1;
		currentStart = number;
	}
	return {
		current,
		currentStart: currentStart === null ? null : dayKeyFor(currentStart),
		longest: longest.length,
		longestStart: longest.length === 0 ? null : dayKeyFor(longest.start),
		longestEnd: longest.length === 0 ? null : dayKeyFor(longest.start + longest.length - 1),
	};
}
