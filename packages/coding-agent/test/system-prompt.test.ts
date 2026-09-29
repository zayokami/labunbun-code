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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localDayKey } from "@labunbun/agent";
import { buildSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type SystemPromptContext } from "../src/system-prompt.ts";

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

/**
 * The prompt clauses, and the one section that describes the harness to the model.
 *
 * The file header above is about the date, and the rest of the file had one job.
 * These do the other half: a prompt is behaviour with no test behind it, so every
 * clause here was added against a failure mode named in the vendor's prompting
 * docs, and a clause that quietly stops being sent is a silent behaviour change
 * that no type-check and no other test would ever report.
 *
 * The assertions are deliberately not a golden file. "The prompt equals this exact
 * text" passes on any wording and fails on any reword, which teaches the next
 * author that the test is a formality to update rather than a claim to satisfy.
 * What is pinned instead is each clause's *reason to exist* — present, above the
 * marker, said once — and, for `# Context`, the bound on how much it may promise.
 */
const COMPACTION_SOURCE = readFileSync(join(import.meta.dir, "..", "..", "agent", "src", "compaction.ts"), "utf8");

/** The source with its comments taken out, so an explanation cannot satisfy a guard. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/.*$/gm, "");
}

/**
 * Every behavioural clause the batch added, by its distinctive half.
 *
 * "Distinctive half" is the point: `toContain` on a whole sentence would pass on
 * any paraphrase of it and fail on a comma, neither of which is a behaviour
 * change. These are the phrases that carry the instruction.
 */
const CLAUSES = [
	// # Context — see the section tests below for what this one may not claim.
	"compacted for you automatically",
	"belongs in a file, not in the conversation",
	// Scope: the model adds unrequested tests and docs at every effort level.
	"Stop when the work asked for is done",
	"the exception is a regression test for a bug you just fixed",
	// Verification: the old bullet said "when they exist", which lets a turn end
	// with the work unexercised.
	"A check that only parses, or a command that failed to start, does not count",
	"name the one you did not run and why",
	// Narration.
	"Say in one line what you are about to do before your first tool call",
];

/** The `# Context` section on its own, so an assertion cannot pass on a neighbour. */
function contextSection(ctx: SystemPromptContext): string {
	const prompt = buildSystemPrompt([], ctx);
	const head = "# Context";
	const start = prompt.indexOf(head);
	if (start === -1) throw new Error("the prompt has no # Context section to read");
	const body = prompt.slice(start + head.length);
	const end = body.indexOf("\n\n# ");
	return end === -1 ? prompt.slice(start) : prompt.slice(start, start + head.length + end);
}

describe("the prompt tells the model what the harness will do to it", () => {
	test("each clause is sent, above the marker, and said once", () => {
		const prompt = buildSystemPrompt([], BASE);
		const marker = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		expect(marker, "the prompt has no dynamic boundary").toBeGreaterThan(-1);

		for (const clause of CLAUSES) {
			const at = prompt.indexOf(clause);
			expect(at, `"${clause}" is not in the prompt`).toBeGreaterThan(-1);
			// Above the marker, because the marker is an ordering claim: the
			// comment at the boundary says the most specific instruction is what
			// the model reads closest to the conversation, which is the argument
			// someone would use to move `# Communication` down there. A behaviour
			// clause below it is still sent, but the prompt has stopped arguing
			// for it in the position it is asking to be read from.
			expect(at, `"${clause}" sits below the dynamic boundary`).toBeLessThan(marker);
			// A duplicate is the real failure mode here: two copies of a rule read
			// as emphasis but mean the prompt has drifted, and only the second one
			// would get edited.
			expect(prompt.split(clause).length - 1, `"${clause}" is said more than once`).toBe(1);
		}
	});

	test("the verification bullet does not hedge its way out of running anything", () => {
		// The old wording was "run builds/tests when they exist", which is how a
		// turn ends reporting a change as done that nothing ever exercised. This
		// pins the exact old phrase rather than the general idea: a *different*
		// hedge would pass here, and the positive clause above is what catches the
		// ones that matter.
		expect(buildSystemPrompt([], BASE)).not.toContain("when they exist");
	});

	test("`# Context` promises no more than the harness delivers", () => {
		const section = contextSection(BASE);
		// Every one of these is available on a minority of runs, and each has been:
		// the circuit breaker after three consecutive failures turns compaction off
		// for the session, `PreCompact` can veto, the anti-thrash gate skips a
		// compaction that just happened, the summariser gives up on an oversized
		// summary, and a bare `AgentSession` (the library surface) has none of this
		// wired at all. "Always"/"never" would be the sentence the vendor's docs
		// reach for and that this repo cannot sign.
		expect(section).not.toMatch(/\balways\b|\bnever\b|guaranteed?|every time/i);
		// The two halves the instruction needs: that it happens, and that it is
		// not something to stop early for.
		expect(section).toContain("automatically");
		expect(section).toContain("do not stop or wrap up early");
	});

	test("the mechanisms `# Context` names still exist", () => {
		// The failure this guards is the section outliving its subject, in both
		// directions, and they are different failures. A *removal* turns a true
		// sentence into a false one that still type-checks, still lints, and still
		// sits next to a green test suite. A *rename* leaves the sentence true but
		// unanchored: the prompt and the code stop agreeing on what to call the
		// thing, and the next person sent looking for it finds nothing. Neither
		// raises anything on its own.
		const body = code(COMPACTION_SOURCE);
		expect(body, "the compaction threshold is gone").toContain("function compactionThreshold");
		expect(body, "the compaction boundary is gone").toContain("function compactionBoundary");
		expect(body, "the file re-injection that survives a compaction is gone").toContain("#reinjectFiles");
	});
});
