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
import { AUTONOMY_LEVELS, DEFAULT_AUTONOMY_LEVEL, localDayKey } from "@labunbun/agent";
import type { Model } from "@labunbun/ai";
import {
	buildSubagentContext,
	buildSystemPrompt,
	SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
	type SystemPromptContext,
} from "../src/system-prompt.ts";

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
	// Grounding: the model must not describe code it has not opened, and must be
	// allowed to say it does not know instead of filling the gap.
	"read a file before editing it, and before making any claim",
	"say what you do not know and go find out",
	// Tool calls carry actions, not descriptions or placeholders.
	"Give each tool call complete arguments",
	// Scope: the model adds unrequested tests and docs at every effort level.
	"Stop when the work asked for is done",
	"the exception is a regression test for a bug you just fixed",
	// A change that was asked for is made, not proposed.
	"make it in this turn rather than describing the change",
	// Generality: a solution coded to the example is not a solution.
	"Solve the problem generally",
	// A regression test is only evidence when it goes red without the fix.
	"Confirm a regression test fails without the fix",
	"not only the happy path",
	// Verification: the old bullet said "when they exist", which lets a turn end
	// with the work unexercised.
	"A check that only parses, or a command that failed to start, does not count",
	"Say a check passed only when a tool result",
	"name the one you did not run and why",
	// Persistence: long turns used to end with a to-do list and an offer to
	// continue. Obstacles are for the agent to work through; deliberate blockers
	// are for reporting, not for working around. The safety line bounds the
	// persistence rule: an obstacle is not a reason to bypass a guard.
	"Carry the task through to the end",
	"an ordinary obstacle is not a reason to hand the task back",
	"Offering to wait, or inviting the user to redirect you, is not progress",
	"never bypass a safety check",
	// Iteration files are scratch, not deliverables.
	"remove them before you report",
	"re-read the request",
	// Narration, including the recap a low-context reader needs.
	"Say in one line what you are about to do before your first tool call",
	"Close with a short recap that stands on its own",
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

describe("the language setting", () => {
	test("unset, the line is the generic one every session shipped with", () => {
		const prompt = buildSystemPrompt([], BASE);
		expect(prompt).toContain("- Answer in the user's language.");
		expect(prompt).not.toContain("Answer in Chinese.");
	});

	test("set, it replaces the generic line rather than joining it", () => {
		// The value is free-form (`settings.language`), injected as written — the
		// prompt is not a language registry.
		const prompt = buildSystemPrompt([], { ...BASE, language: "Chinese" });
		expect(prompt).toContain("- Answer in Chinese.");
		// Two instructions about one thing is how a prompt ends up arguing with
		// itself; the configured value is the more specific one, so the generic
		// line is gone, not merely preceded.
		expect(prompt).not.toContain("the user's language");
	});
});

/**
 * The short prompt for a small model or a tiny window. It is a different body,
 * not a suffix, so it is tested on its own for the same reason: a rule that
 * matters can be dropped from it silently, because the full prompt's tests
 * never read these bytes.
 */
describe("the short prompt", () => {
	const model = { provider: "ollama", id: "qwen3:7b", contextWindow: 8192 } as unknown as Model;
	const prompt = () => buildSystemPrompt([], { ...BASE, model });

	test("is the lean body, not a suffix of the full one", () => {
		expect(prompt()).toContain("# Rules");
		expect(prompt()).not.toContain("# Attitude");
		expect(prompt()).not.toContain("# Doing tasks");
	});

	test("keeps the hard rules that change an action", () => {
		for (const clause of [
			"Read a file before editing it or claiming what it contains",
			"Make the smallest change",
			"except a regression test for the bug you just fixed",
			"make it rather than describing it",
			"must fail without the fix",
			"Never bypass a safety check",
			"Carry the task through to the end",
			"check passed only counts when its output is in this conversation",
			"Close with a short recap",
			"Do not commit unless explicitly asked",
		]) {
			expect(prompt(), `"${clause}" is missing from the short prompt`).toContain(clause);
		}
	});

	test("sits above the boundary, with the model guidance below it", () => {
		const text = prompt();
		const marker = text.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		expect(marker).toBeGreaterThan(text.indexOf("Carry the task through to the end"));
		expect(text.indexOf("# Model guidance")).toBeGreaterThan(marker);
	});
});

/**
 * The subagent context block: what a worker shares with the session that
 * spawned it. It is deliberately not the session prompt, so the omissions are
 * as load-bearing as the inclusions — a worker that answered in the parent's
 * voice, or inherited the parent's "do the task asked for" contract as if it
 * were its own role, would be reading a second definition of its job.
 */
describe("the subagent context block", () => {
	const now = Date.UTC(2026, 8, 27, 12, 0);
	const SUB = { cwd: BASE.cwd, platform: BASE.platform, isTTY: BASE.isTTY, now };

	test("carries the same # Environment section as the main prompt", () => {
		const main = buildSystemPrompt([], { ...BASE, now });
		const start = main.indexOf("# Environment");
		const end = main.indexOf(`\n\n${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}`);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		// Byte-identical to the section the parent gets: one wording, one date.
		expect(buildSubagentContext(SUB)).toBe(main.slice(start, end));
		const context = buildSubagentContext(SUB);
		expect(context).toContain(`- Working directory: ${BASE.cwd}`);
		expect(context).toContain(`- Platform: ${BASE.platform}`);
		expect(context).toContain(`- Today's date: ${localDayKey(now)}`);
	});

	test("adds memory and skills after the environment, in that order", () => {
		const context = buildSubagentContext({ ...SUB, memory: "MEMORY-MARKER", skills: "SKILLS-MARKER" });
		expect(context).toContain("# Project memory\nMEMORY-MARKER");
		expect(context).toContain("SKILLS-MARKER");
		expect(context.indexOf("# Environment")).toBeLessThan(context.indexOf("# Project memory"));
		expect(context.indexOf("# Project memory")).toBeLessThan(context.indexOf("SKILLS-MARKER"));
		// The role definition is the caller's to prepend; this block never
		// re-states it and always starts with where the worker is running.
		expect(context.startsWith("# Environment")).toBe(true);
	});

	test("carries the parent's repository map between the environment and memory", () => {
		const context = buildSubagentContext({
			...SUB,
			repoMap: "src/a.ts:\n│export function alpha() {}",
			memory: "MEMORY-MARKER",
		});

		expect(context).toContain("# Repository map\nsrc/a.ts:\n│export function alpha() {}");
		expect(context.indexOf("# Environment")).toBeLessThan(context.indexOf("# Repository map"));
		expect(context.indexOf("# Repository map")).toBeLessThan(context.indexOf("# Project memory"));
		// A map the parent declined is not a heading over nothing.
		expect(buildSubagentContext({ ...SUB, repoMap: "  \n" })).toBe(buildSubagentContext(SUB));
	});

	test("leaves out the parent's voice, harness contract, tool guidance and style", () => {
		const context = buildSubagentContext({ ...SUB, memory: "MEMORY-MARKER", skills: "SKILLS-MARKER" });
		for (const omitted of [
			"# Attitude",
			"# Context",
			"# Doing tasks",
			"# Communication",
			"# Tool guidance",
			"# Output style",
			"Answer in",
			SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
		]) {
			expect(context, `the subagent context must not carry "${omitted}"`).not.toContain(omitted);
		}
	});

	test("empty memory and skills produce no headers and no empty sections", () => {
		const plain = buildSubagentContext(SUB);
		// Whitespace is what an empty file loads as; a heading over nothing would
		// be a section the model is told to read and finds empty.
		expect(buildSubagentContext({ ...SUB, memory: "  \n", skills: "\n\t" })).toBe(plain);
		expect(plain).not.toContain("# Project memory");
		expect(plain).not.toContain("\n\n\n");
	});
});

describe("the repository map section", () => {
	test("unset, no section is sent at all", () => {
		expect(buildSystemPrompt([], BASE)).not.toContain("# Repository map");
		// Whitespace is what an empty repository resolves to; a heading over
		// nothing is a section the model is told to read and finds empty.
		expect(buildSystemPrompt([], { ...BASE, repoMap: "  \n" })).toBe(buildSystemPrompt([], BASE));
	});

	test("set, it is its own section below the boundary and before memory", () => {
		const prompt = buildSystemPrompt([], {
			...BASE,
			repoMap: "src/a.ts:\n│export function alpha() {}",
			memory: "MEMORY-MARKER",
		});
		const marker = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

		expect(prompt).toContain("# Repository map\nsrc/a.ts:\n│export function alpha() {}");
		// Below the boundary: the map is this project's shape, not the harness
		// contract, so it belongs on the dynamic side with memory.
		expect(prompt.indexOf("# Repository map")).toBeGreaterThan(marker);
		expect(prompt.indexOf("# Repository map")).toBeLessThan(prompt.indexOf("# Project memory"));
	});
});

describe("the output-style setting", () => {
	test("unset, no style section is sent at all", () => {
		expect(buildSystemPrompt([], BASE)).not.toContain("# Output style");
		// Whitespace is what an empty or unreadable style resolves to; a heading
		// over nothing is a section the model is told to read and finds empty.
		expect(buildSystemPrompt([], { ...BASE, outputStyle: "  \n" })).toBe(buildSystemPrompt([], BASE));
	});

	test("set, it is its own section between memory and the skill list", () => {
		const prompt = buildSystemPrompt([], {
			...BASE,
			memory: "MEMORY-MARKER",
			outputStyle: "STYLE-MARKER",
			skills: "SKILLS-MARKER",
		});
		expect(prompt).toContain("# Output style\nSTYLE-MARKER");
		expect(prompt.indexOf("# Project memory")).toBeLessThan(prompt.indexOf("# Output style"));
		expect(prompt.indexOf("# Output style")).toBeLessThan(prompt.indexOf("SKILLS-MARKER"));
	});

	test("a style is a section, not a replacement — the coding instructions stay", () => {
		// Stripping them is the tempting reading of "style", and it would turn a
		// tone setting into a way for a style file to ship a prompt.
		const prompt = buildSystemPrompt([], { ...BASE, outputStyle: "STYLE-MARKER" });
		expect(prompt).toContain("Stop when the work asked for is done");
		expect(prompt).toContain("# Communication");
	});
});

/**
 * `# Autonomy` is the one prompt section whose text changes with a setting.
 *
 * The shared half is the safety claim — an autonomy level changes what the model
 * asks about, never what it may do — and it has to be present at every level,
 * because the level that is easiest to misread as a permission grant is the
 * loosest one. The level clauses are tested for presence *and* for the absence
 * of the other two: a table that emitted every clause would still say the
 * right thing somewhere and give the model two contradictory instructions.
 */
describe("the autonomy section", () => {
	const CLAUSE: Record<(typeof AUTONOMY_LEVELS)[number], string> = {
		guided: "describe the approaches you see and ask before building",
		balanced: "Ask when the answer changes what the user gets",
		autonomous: "decide anything reversible that the evidence supports",
	};

	test("defaults to the level the command and the schema start from", () => {
		const prompt = buildSystemPrompt([], BASE);
		expect(prompt).toContain("# Autonomy");
		expect(prompt).toContain(`You are running at the ${DEFAULT_AUTONOMY_LEVEL} autonomy level`);
	});

	test("the shared half is present at every level, including the boundary claim", () => {
		for (const level of AUTONOMY_LEVELS) {
			const prompt = buildSystemPrompt([], { ...BASE, autonomy: level });
			expect(prompt, `${level} lost the access boundary`).toContain("autonomy never grants access");
			expect(prompt, `${level} lost the how/what split`).toContain("- You own the how:");
			expect(prompt, `${level} lost the how/what split`).toContain("- The user owns the what:");
			expect(prompt, `${level} lost the evidence rule`).toContain("- Answer before asking.");
			expect(prompt, `${level} lost the ask rule`).toContain("- Ask once, well.");
			// One yes is not a standing grant: the failure this guards is the agent
			// treating an approval for one command as permission for the next.
			expect(prompt, `${level} lost the approval-scope rule`).toContain(
				"- An answer covers the action it was asked about",
			);
			// A denial is a limit, not a step to route around: this sentence is what
			// keeps "be autonomous" from reading as "find another tool".
			expect(prompt, `${level} lost the refusal rule`).toContain(
				"- A refusal or a limit is not a decision to route around",
			);
		}
	});

	test.each([...AUTONOMY_LEVELS])("level %s gets its clause and not the other two", (level) => {
		const prompt = buildSystemPrompt([], { ...BASE, autonomy: level });
		expect(prompt).toContain(CLAUSE[level]);
		for (const other of AUTONOMY_LEVELS) {
			if (other === level) continue;
			expect(prompt, `${level} also carried ${other}'s clause`).not.toContain(CLAUSE[other]);
		}
	});

	test("sits after # Finishing work and before # Communication, above the boundary", () => {
		const prompt = buildSystemPrompt([], { ...BASE, autonomy: "guided" });
		expect(prompt.indexOf("# Doing tasks")).toBeLessThan(prompt.indexOf("# Finishing work"));
		expect(prompt.indexOf("# Finishing work")).toBeLessThan(prompt.indexOf("# Autonomy"));
		expect(prompt.indexOf("# Autonomy")).toBeLessThan(prompt.indexOf("# Communication"));
		// It is a working rule, not this project's shape: it belongs above the
		// dynamic boundary with the rest of the harness contract.
		expect(prompt.indexOf("# Autonomy")).toBeLessThan(prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY));
	});

	test("the short prompt carries the compressed clause for the selected level", () => {
		const model = { provider: "ollama", id: "qwen3:7b", contextWindow: 8192 } as unknown as Model;
		const guided = buildSystemPrompt([], { ...BASE, model, autonomy: "guided" });
		expect(guided).toContain("Autonomy (guided): ask before choosing among approaches");
		const autonomous = buildSystemPrompt([], { ...BASE, model, autonomy: "autonomous" });
		expect(autonomous).toContain("Autonomy (autonomous): decide every reversible step");
		// No `# Autonomy` heading: the lean body is a different prompt, not a
		// suffix, and a heading there would be the full section's shape.
		expect(autonomous).not.toContain("# Autonomy");
	});
});
