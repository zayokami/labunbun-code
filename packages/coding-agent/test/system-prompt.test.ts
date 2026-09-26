/**
 * "Today's date" is the local civil day, not the UTC one.
 *
 * The bug this pins was live in the prompt: it read the date with
 * `new Date().toISOString().slice(0, 10)`, which is a UTC day key, so on a
 * UTC+8 machine the model was told the date was yesterday for the first eight
 * hours of every local day, and in a UTC-4 machine it was told the date was
 * tomorrow for the last four. `activity.ts` was fixed for the same reason
 * earlier and carries the long version of the argument at its file header; what
 * is here is only the narrow claim that the prompt line does not regress into a
 * second, differently-answered copy of it.
 *
 * Every instant below is pinned through `ctx.now` rather than read from the
 * clock, and that is the whole reason the production signature grew the field.
 * The gap between the local day and the UTC day is zero for eight hours out of
 * every twenty-four, so a test that compared the prompt against the local date at
 * the current instant would pass on a UTC machine and fail on identical code at
 * another hour. The two zones and the control instant below are chosen so that
 * the *old* implementation fails the first two and passes the third — if the
 * third ever starts failing too, the test is measuring something other than the
 * day boundary.
 *
 * `process.env.TZ` is restored by assignment rather than by deleting it. Bun's
 * `Date` caches the zone, and a `delete` leaves the process unable to honour any
 * later assignment for the rest of the run — which then fails every other test
 * that touches a date, far from anything that looks related.
 */

import { describe, expect, test } from "bun:test";
import { localDayKey } from "@labunbun/agent";
import { buildSystemPrompt, type SystemPromptContext } from "../src/system-prompt.ts";

const ORIGINAL_TZ = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function inTimeZone<T>(tz: string, body: () => T): T {
	process.env.TZ = tz;
	try {
		return body();
	} finally {
		process.env.TZ = ORIGINAL_TZ;
	}
}

const BASE: SystemPromptContext = { cwd: "G:\\work\\proj", platform: "win32", isTTY: true };

/** The `Today's date` line, so a failure names the day rather than the prompt. */
function dateLine(ctx: SystemPromptContext): string {
	const line = buildSystemPrompt([], ctx)
		.split("\n")
		.find((l) => l.startsWith("- Today's date:"));
	if (line === undefined) throw new Error("the prompt has no date line to read");
	return line;
}

describe("the date in the system prompt", () => {
	test("a negative-offset zone is not told it is tomorrow", () => {
		// 03:30 UTC on the 27th is 23:30 on the 26th in New York. `toISOString`
		// reads 2026-09-27; the wall clock says 2026-09-26.
		const ctx = { ...BASE, now: Date.UTC(2026, 8, 27, 3, 30) };
		expect(inTimeZone("America/New_York", () => dateLine(ctx))).toBe("- Today's date: 2026-09-26");
	});

	test("a positive-offset zone is not told it is yesterday", () => {
		// 16:30 UTC on the 26th is 00:30 on the 27th in Shanghai. `toISOString`
		// reads 2026-09-26; the wall clock says 2026-09-27.
		const ctx = { ...BASE, now: Date.UTC(2026, 8, 26, 16, 30) };
		expect(inTimeZone("Asia/Shanghai", () => dateLine(ctx))).toBe("- Today's date: 2026-09-27");
	});

	test("an instant where the two agree still agrees", () => {
		// The control. Noon UTC is 08:00 in New York and 20:00 in Shanghai, so both
		// zones are on the 27th and so is UTC — the old code passes this one, which
		// is what makes the two above discriminating rather than uniformly red.
		const ctx = { ...BASE, now: Date.UTC(2026, 8, 27, 12, 0) };
		expect(inTimeZone("America/New_York", () => dateLine(ctx))).toBe("- Today's date: 2026-09-27");
		expect(inTimeZone("Asia/Shanghai", () => dateLine(ctx))).toBe("- Today's date: 2026-09-27");
	});

	test("UTC+14 reads the year the clock rolled into", () => {
		// Noon UTC on 31 December is already 1 January on the far side of the date
		// line, so this one catches a year error as well as a day error.
		const ctx = { ...BASE, now: Date.UTC(2025, 11, 31, 12, 0) };
		expect(inTimeZone("Pacific/Kiritimati", () => dateLine(ctx))).toBe("- Today's date: 2026-01-01");
	});

	test("no `now` means now, and the line is a well-formed day key", () => {
		// The default has to stay the default: the two production call sites pass
		// no instant, and a formatting change here would ship to every session
		// without any of the tests above noticing, since they all supply `now`.
		const expected = localDayKey(Date.now());
		expect(dateLine(BASE)).toBe(`- Today's date: ${expected}`);
		expect(dateLine(BASE)).toMatch(/^- Today's date: \d{4}-\d{2}-\d{2}$/);
	});
});
