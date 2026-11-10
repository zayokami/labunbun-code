/**
 * Task scale: the classifier, the contract it emits, and the effort it asks
 * for.
 *
 * The table below is the whole point of the module. Each row is a request a
 * person would send, and the expected reading is the one the harness acts on:
 * a typo fix must not buy a plan, a "why" must not buy an edit, and a refactor
 * must not be answered as a one-liner. The scoring is heuristic by design, so
 * the cases are here to keep a regex edit from quietly moving a boundary.
 */
import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { z } from "zod";
import {
	AgentSession,
	buildTool,
	classifyTask,
	composeTaskScale,
	createTaskCalibration,
	stripTaskScale,
	type TaskKind,
	type TaskScale,
	taskScaleContract,
	taskScaleThinkingLevel,
} from "../src/index.ts";

const CASES: Array<{ text: string; kind: TaskKind; scale: TaskScale; why: string }> = [
	{ text: "fix the typo in README.md", kind: "change", scale: "trivial", why: "an explicit small cue and one path" },
	{ text: "just rename the variable", kind: "change", scale: "trivial", why: "explicit small" },
	{ text: "只改 README 里的标题", kind: "change", scale: "trivial", why: "只改 is an explicit small cue" },
	{ text: "把这个变量名改成 userName", kind: "change", scale: "standard", why: "short alone is not trivial" },
	{
		text: "add a --json flag to the export command",
		kind: "change",
		scale: "standard",
		why: "a short feature is still a feature",
	},
	{
		text: "do not change anything and explain the failure",
		kind: "answer",
		scale: "standard",
		why: "the only change verb is negated",
	},
	{
		text: "don't forget to update the changelog",
		kind: "change",
		scale: "standard",
		why: "forget cancels the negation and leaves a change",
	},
	{
		text: "don't change the API, but rename the file",
		kind: "change",
		scale: "standard",
		why: "one negated verb does not cancel a positive one",
	},
	{ text: "不要改配置，只加一行日志", kind: "change", scale: "trivial", why: "改 is negated, 加 is not" },
	{
		text: "change everything everywhere",
		kind: "change",
		scale: "complex",
		why: "everything is scope evidence",
	},
	{
		text: "update src\\a.ts, src\\b.ts and src\\c.ts",
		kind: "change",
		scale: "complex",
		why: "three Windows paths",
	},
	{
		text: "refactor the permission engine across the whole codebase",
		kind: "change",
		scale: "complex",
		why: "two scope words outweigh the short length",
	},
	{
		text: "quickly refactor this function",
		kind: "change",
		scale: "standard",
		why: "explicit small cancels the refactor",
	},
	{ text: "update src/a.ts, src/b.ts and src/c.ts", kind: "change", scale: "complex", why: "three paths" },
	{
		text: "why does the compaction test fail?",
		kind: "answer",
		scale: "standard",
		why: "a question with no change verb",
	},
	{
		text: "how do I fix the flaky test?",
		kind: "answer",
		scale: "standard",
		why: "advice about a fix, not a request to make one",
	},
	{
		text: "should I refactor this?",
		kind: "answer",
		scale: "complex",
		why: "advice wins over the scope word it mentions",
	},
	{
		text: "can you fix the flaky test?",
		kind: "change",
		scale: "standard",
		why: "a second-person request is not advice",
	},
	{ text: "怎么修复这个 bug", kind: "answer", scale: "standard", why: "怎么 asks how, not for the fix" },
	{
		text: "该不该重构整个项目？",
		kind: "answer",
		scale: "complex",
		why: "该不该 asks for a judgment",
	},
	{
		text: "能不能帮我修复一下？",
		kind: "change",
		scale: "standard",
		why: "能不能帮我 is a polite request",
	},
	{
		text: "don't refactor everything, just fix the typo",
		kind: "change",
		scale: "trivial",
		why: "a negated scope word is not scope evidence",
	},
	{
		text: "why does the entire build fail?",
		kind: "answer",
		scale: "complex",
		why: "the verb is a noun in the question, not a request",
	},
	{ text: "what did you change?", kind: "answer", scale: "standard", why: "a question about a past change" },
	{
		text: "why does it fail? fix it.",
		kind: "change",
		scale: "standard",
		why: "a later imperative sentence makes it a request",
	},
	{ text: "is the build failing?", kind: "answer", scale: "standard", why: "build is the subject here" },
	{ text: "麻烦看下为什么构建失败", kind: "answer", scale: "standard", why: "看下 asks for an investigation" },
	{
		text: "explain how the whole pipeline works",
		kind: "answer",
		scale: "complex",
		why: "an answer can still be broad",
	},
	{ text: "", kind: "change", scale: "standard", why: "nothing to read" },
];

describe("classifyTask", () => {
	for (const entry of CASES) {
		test(`${JSON.stringify(entry.text)} is ${entry.scale}/${entry.kind} — ${entry.why}`, () => {
			const shape = classifyTask(entry.text);
			expect({ scale: shape.scale, kind: shape.kind }).toEqual({ scale: entry.scale, kind: entry.kind });
		});
	}

	test("a long, many-sentence request reads as complex", () => {
		const text = Array.from({ length: 16 }, (_, i) => `Step ${i} changes one area.`).join(" ");
		expect(classifyTask(text).scale).toBe("complex");
	});

	test("signals say why, not just what", () => {
		expect(classifyTask("refactor everything").signals).toContain("explicit-large");
		expect(classifyTask("fix the typo").signals).toEqual(
			expect.arrayContaining(["explicit-small", "short", "change-verb"]),
		);
		expect(classifyTask("why does this fail?").signals).toContain("question");
		expect(classifyTask("do not change anything and explain").signals).toContain("negated-change");
		expect(classifyTask("edit src/a.ts").signals).toContain("change-verb");
		expect(classifyTask("should I refactor this?").signals).toContain("advice-question");
		expect(classifyTask("don't refactor everything").signals).not.toContain("explicit-large");
		expect(classifyTask("fix the typo").signals).toContain("request");
	});

	test("URLs are links, not files the request names", () => {
		const text = "look at https://example.com/src/a.ts, https://example.com/src/b.ts and https://example.com/src/c.ts";
		const shape = classifyTask(text);
		expect(shape.signals).not.toContain("several-paths");
		expect(shape.scale).toBe("standard");
	});
});

describe("the contract", () => {
	test("standard emits nothing", () => {
		expect(taskScaleContract(classifyTask("add a --json flag"))).toBeUndefined();
	});

	test("trivial asks for the smallest edit and one check", () => {
		const block = taskScaleContract(classifyTask("fix the typo"));
		expect(block).toContain('<task-scale scale="trivial" kind="change">');
		expect(block).toContain("smallest edit");
		expect(block).toContain("Add no tests, docs, or defensive handling");
	});

	test("complex allows a plan and forbids the audit it did not ask for", () => {
		const block = taskScaleContract(classifyTask("refactor the whole engine"));
		expect(block).toContain('<task-scale scale="complex" kind="change">');
		expect(block).toContain("short plan");
		expect(block).toContain("no audit, review, refactor, or extra hardening");
	});

	test("a question is answered, not edited", () => {
		const block = taskScaleContract(classifyTask("why does this fail?"));
		expect(block).toContain('<task-scale scale="standard" kind="answer">');
		expect(block).toContain("do not edit files, run builds or tests");
	});

	test("the block leads the stored message and the separator survives a round trip", () => {
		const text = "fix the typo in README.md";
		const composed = composeTaskScale(text, classifyTask(text));
		expect(composed.startsWith("<task-scale ")).toBe(true);
		expect(composed).toContain(`\n</task-scale>\n\n---\n\n${text}`);
		expect(stripTaskScale(composed)).toBe(text);
	});

	test("stripping is a prefix match: user text is untouched", () => {
		const plain = "what does <task-scale> mean?";
		expect(stripTaskScale(plain)).toBe(plain);
		// A block that is not at the head is part of what the user wrote.
		expect(stripTaskScale(`hello\n\n${composeTaskScale("x", classifyTask("fix the typo"))}`)).toContain("<task-scale");
	});
});

describe("effort", () => {
	test("only the change tiers move the dial", () => {
		expect(taskScaleThinkingLevel(classifyTask("fix the typo"))).toBe("low");
		expect(taskScaleThinkingLevel(classifyTask("refactor the whole engine"))).toBe("high");
		expect(taskScaleThinkingLevel(classifyTask("add a --json flag"))).toBeUndefined();
		expect(taskScaleThinkingLevel(classifyTask("why does this fail?"))).toBeUndefined();
	});
});

describe("the calibration state", () => {
	test("a prompt is classified, composed, and read by the effort getter", () => {
		const calibration = createTaskCalibration();
		const composed = calibration.compose("stored", "fix the typo", "prompt");
		expect(composed.startsWith("<task-scale ")).toBe(true);
		expect(composed.endsWith("\n\n---\n\nstored")).toBe(true);
		expect(calibration.current()?.scale).toBe("trivial");
		expect(calibration.level(undefined)).toBe("low");
		// A level the user chose is never overruled.
		expect(calibration.level("max")).toBe("max");
	});

	test("a steer is harness speech, not a new task", () => {
		const calibration = createTaskCalibration();
		expect(calibration.compose("stored", "refactor everything", "steer")).toBe("stored");
		expect(calibration.current()).toBeUndefined();
		expect(calibration.level(undefined)).toBeUndefined();
	});

	test("LBB_TASK_SCALE=off leaves both the bytes and the effort alone", () => {
		const calibration = createTaskCalibration({ env: { LBB_TASK_SCALE: "off" } });
		expect(calibration.compose("stored", "fix the typo", "prompt")).toBe("stored");
		expect(calibration.level(undefined)).toBeUndefined();
	});
});

describe("the session hands the hook its origin", () => {
	test("prompt, steer and follow-up arrive labelled", async () => {
		const faux = fauxProvider([
			{ toolCalls: [{ name: "noop", arguments: {} }] },
			{ toolCalls: [{ name: "noop", arguments: {} }] },
			{ text: "done" },
			{ text: "done again" },
		]);
		const noop = buildTool({
			name: "noop",
			description: "does nothing",
			inputSchema: z.object({}),
			call: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
		const origins: string[] = [];
		let session: AgentSession;
		let steered = false;
		let queued = false;
		const streamFn: StreamFn = async function* (model, context, options) {
			if (!steered) {
				steered = true;
				session.steer("also check the tests");
			} else if (!queued && context.messages.some((m) => m.role === "toolResult")) {
				queued = true;
				session.followUp("and then summarize");
			}
			yield* faux.streamFn(model, context, options);
		};
		session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "sys",
			tools: [noop],
			deps: {
				streamFn,
				hooks: {
					composeUserMessage: (text, origin) => {
						origins.push(origin);
						return text;
					},
				},
			},
		});

		await session.prompt("start");

		expect(origins).toEqual(["prompt", "steer", "followUp"]);
	});
});
