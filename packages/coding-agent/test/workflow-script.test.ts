/**
 * The script runner's contract with a workflow author: what a script returns,
 * what each hook means, and what the sandbox refuses.
 *
 * The hooks are deliberately small, so the tests hold them to their documented
 * shapes — a failure is `null` rather than a rejection, pipeline stages overlap,
 * the concurrency cap is one shared gate — and to the determinism rules that
 * make resume possible. The returned value is the one the runner journals, so
 * the first test is the widest: it proves the body actually ran.
 */
import { describe, expect, test } from "bun:test";
import {
	MAX_WORKFLOW_ITEMS,
	parseWorkflowScript,
	type RunWorkflowScriptOptions,
	runWorkflowScript,
	WorkflowAbortedError,
	workflowConcurrency,
} from "../src/workflow-script.ts";

function harness(overrides: Partial<RunWorkflowScriptOptions> = {}) {
	const lines: string[] = [];
	const options: RunWorkflowScriptOptions = {
		script: "return 1;",
		signal: new AbortController().signal,
		agent: async () => ({ ok: true, value: "ok" }),
		report: (line) => lines.push(line),
		...overrides,
	};
	return { lines, run: () => runWorkflowScript(options) };
}

/** A promise resolved by the returned function, for ordering assertions. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("parseWorkflowScript", () => {
	const script = [
		'export const meta = { name: "demo", description: "A demo", whenToUse: "Testing" };',
		'log("body");',
		"return 1;",
	].join("\n");

	test("the meta is read and the statement is blanked out of the body", () => {
		const parsed = parseWorkflowScript(script);
		expect(parsed.meta).toEqual({ name: "demo", description: "A demo", whenToUse: "Testing" });
		expect(parsed.error).toBeUndefined();
		// Blanked, not removed: the body keeps the script's line numbers.
		expect(parsed.body.split("\n")).toHaveLength(script.split("\n").length);
		expect(parsed.body).not.toContain("export const meta");
	});

	test("braces in strings and comments do not end the meta early", () => {
		const tricky = [
			"export const meta = { // a { in a comment",
			'  name: "demo",',
			'  description: "uses {braces} and /* comments */",',
			"};",
			"return 1;",
		].join("\n");
		const parsed = parseWorkflowScript(tricky);
		expect(parsed.meta?.description).toBe("uses {braces} and /* comments */");
		expect(parsed.error).toBeUndefined();
	});

	test("a meta without the object literal is an error, not an empty meta", () => {
		expect(parseWorkflowScript("export const meta = buildMeta();").error).toContain("only `export const meta`");
		const computed = parseWorkflowScript("export const meta = { name: buildName() };");
		expect(computed.error).toContain("meta must be a pure object literal");
	});

	test("any export besides meta is refused", () => {
		const parsed = parseWorkflowScript("export default 1;");
		expect(parsed.error).toBe("workflow scripts run as a function body; only `export const meta` is supported");
	});

	test("meta fields must be strings", () => {
		expect(parseWorkflowScript("export const meta = { name: 3 };").error).toContain("meta.name must be a string");
	});

	test("a meta declaration inside a comment or a string is not a meta", () => {
		const commented = parseWorkflowScript('/*\nexport const meta = { name: "fake" };\n*/\nreturn 1;');
		expect(commented.meta).toBeNull();
		expect(commented.body).toContain("export const meta");

		const stringy = parseWorkflowScript('const note = `\nexport const meta = { name: "fake" };\n`;\nreturn note;');
		expect(stringy.meta).toBeNull();
		expect(stringy.error).toBeUndefined();
	});

	test("an export mentioned in a comment is not a second export", () => {
		expect(parseWorkflowScript("/*\nexport default 1;\n*/\nreturn 1;").error).toBeUndefined();
	});
});

describe("runWorkflowScript", () => {
	test("the body runs and its return value is the workflow's value", async () => {
		// A wrapper that is only defined, never invoked, would make every script
		// return a function instead of its value — the failure this pins.
		const { run } = harness({ script: "const n = 2;\nreturn n * 21;" });
		expect((await run()).value).toBe(42);
	});

	test("meta is returned with the result", async () => {
		const { run } = harness({ script: 'export const meta = { name: "demo" };\nreturn 1;' });
		expect((await run()).meta).toEqual({ name: "demo" });
	});

	test("agent resolves the value, and counts run and cached calls", async () => {
		let call = 0;
		const { run } = harness({
			script: 'const a = await agent("one");\nconst b = await agent("two");\nreturn [a, b];',
			agent: async () => {
				call++;
				return { ok: true, value: `v${call}`, cached: call === 2 };
			},
		});
		const result = await run();
		expect(result.value).toEqual(["v1", "v2"]);
		expect(result.agentsRun).toBe(1);
		expect(result.agentsCached).toBe(1);
		expect(result.agentsFailed).toBe(0);
	});

	test("a failed agent resolves to null and is counted and reported", async () => {
		const { lines, run } = harness({
			script: 'return await agent("bad", { label: "sad" });',
			agent: async () => ({ ok: false, error: "it broke" }),
		});
		const result = await run();
		expect(result.value).toBeNull();
		expect(result.agentsFailed).toBe(1);
		expect(lines).toContain("✗ sad: it broke");
	});

	test("parallel is a barrier that maps failures to null in place", async () => {
		const { run } = harness({
			script: `
				const out = await parallel([
					async () => "first",
					async () => { throw new Error("boom"); },
					async () => "third",
				]);
				return out;
			`,
		});
		expect((await run()).value).toEqual(["first", null, "third"]);
	});

	test("pipeline passes (previous, original, index) and skips later stages after a throw", async () => {
		const { lines, run } = harness({
			script: `
				const out = await pipeline(["a", "b"], (prev, original, index) => {
					log("stage1:" + original + ":" + index + ":" + typeof prev);
					return original.toUpperCase();
				}, (prev, original, index) => {
					log("stage2:" + prev + ":" + original + ":" + index);
					if (original === "a") throw new Error("stop here");
					return prev + "!";
				}, (prev, original) => {
					log("stage3:" + original + ":" + prev);
					return "never:" + prev;
				});
				return out;
			`,
		});
		expect((await run()).value).toEqual([null, "never:B!"]);
		expect(lines.filter((line) => line.startsWith("stage1:"))).toEqual([
			"stage1:a:0:undefined",
			"stage1:b:1:undefined",
		]);
		expect(lines).toContain("stage2:A:a:0");
		expect(lines).toContain("stage3:b:B!");
		expect(lines.some((line) => line.startsWith("stage3:a:"))).toBe(false);
	});

	test("pipeline does not wait between stages for other items", async () => {
		// Item 0's first stage is slow; item 1 must still reach stage 2 before it
		// finishes. A barrier anywhere would keep item 1 behind item 0.
		const gate = deferred();
		const { lines, run } = harness({
			concurrency: 4,
			script: `
				return await pipeline([0, 1], async (prev, item) => {
					log("evt:start:" + item);
					if (item === 0) await agent("slow");
					log("evt:middle:" + item);
					return item;
				}, (prev, item) => {
					log("evt:stage2:" + item);
					return item;
				});
			`,
			agent: async (request) => {
				if (request.prompt === "slow") await gate.promise;
				return { ok: true, value: null };
			},
		});
		const running = run();
		const deadline = Date.now() + 2000;
		while (!lines.includes("evt:stage2:1") && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const middleOfOne = lines.indexOf("evt:middle:1");
		expect(middleOfOne).toBeGreaterThan(-1);
		expect(lines.indexOf("evt:stage2:1")).toBeGreaterThan(middleOfOne);
		expect(lines).not.toContain("evt:middle:0");
		gate.resolve();
		const result = await running;
		expect(result.value).toEqual([0, 1]);
	});

	test("phase sets the implicit phase and an explicit one wins", async () => {
		const requests: Array<{ label: string; phase?: string }> = [];
		const { run } = harness({
			script: `
				phase("Review");
				await agent("a", { label: "first" });
				await agent("b", { label: "second", phase: "Verify" });
				await agent("c");
				return 0;
			`,
			agent: async (request) => {
				requests.push({ label: request.label, phase: request.phase });
				return { ok: true, value: null };
			},
		});
		const result = await run();
		expect(requests).toEqual([
			{ label: "first", phase: "Review" },
			{ label: "second", phase: "Verify" },
			{ label: "agent 3", phase: "Review" },
		]);
		expect(result.phases).toEqual(["Review"]);
	});

	test("agent options reach the spawn request", async () => {
		const seen: unknown[] = [];
		const { run } = harness({
			script: `
				return await agent("x", {
					label: "one", effort: "high", model: "fast", agentType: "quick", isolation: "worktree",
					schema: { type: "object", properties: { n: { type: "number" } } },
				});
			`,
			agent: async (request) => {
				seen.push(request);
				return { ok: true, value: { n: 1 } };
			},
		});
		await run();
		expect(seen[0]).toMatchObject({
			label: "one",
			effort: "high",
			model: "fast",
			agentType: "quick",
			isolation: "worktree",
			schema: { type: "object", properties: { n: { type: "number" } } },
		});
	});

	test("log and console.log both become progress lines", async () => {
		const { lines, run } = harness({
			script: 'log("plain");\nconsole.log({ a: 1 });\nconsole.warn("warned");\nreturn 0;',
		});
		const result = await run();
		expect(result.logs).toEqual(["plain", '{"a":1}', "warned"]);
		expect(lines).toEqual(["plain", '{"a":1}', "warned"]);
	});

	test("the concurrency cap is one gate shared by every nested call", async () => {
		let inFlight = 0;
		let most = 0;
		const { run } = harness({
			concurrency: 2,
			script: `
				await parallel([1, 2, 3].map((outer) => () =>
					parallel([1, 2, 3].map((inner) => () => agent("a" + outer + inner)))));
				return 0;
			`,
			agent: async () => {
				inFlight++;
				most = Math.max(most, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 5));
				inFlight--;
				return { ok: true, value: null };
			},
		});
		await run();
		expect(most).toBe(2);
	});

	test("the agent budget refuses further calls and marks the run truncated", async () => {
		const { run } = harness({
			maxAgents: 1,
			script: `
				const first = await agent("one");
				let second = "none";
				try { await agent("two"); } catch (error) { second = error.message; }
				return [first, second];
			`,
			agent: async () => ({ ok: true, value: "done" }),
		});
		const result = await run();
		expect(result.truncated).toBe(true);
		expect(result.agentsRun).toBe(1);
		expect(String((result.value as unknown[])[1])).toContain("budget reached");
	});

	test("more items than the cap is an error, not a truncation", async () => {
		const items = Array.from({ length: MAX_WORKFLOW_ITEMS + 1 }, () => "async () => 1").join(",");
		const { run } = harness({ script: `return await parallel([${items}]);` });
		await expect(run()).rejects.toThrow(`at most ${MAX_WORKFLOW_ITEMS} thunks`);
	});

	test("a bad agent argument is refused before anything is spawned", async () => {
		let spawned = 0;
		const { run } = harness({
			script: `
				const errors = [];
				for (const call of [
					() => agent(""),
					() => agent("x", { schema: { type: "string" } }),
					() => agent("x", { effort: "turbo" }),
					() => agent("x", { isolation: "sandbox" }),
				]) {
					try { await call(); errors.push("none"); } catch (error) { errors.push(error.message); }
				}
				return errors;
			`,
			agent: async () => {
				spawned++;
				return { ok: true, value: null };
			},
		});
		const result = await run();
		const errors = result.value as string[];
		expect(errors[0]).toContain("prompt must be a non-empty string");
		expect(errors[1]).toContain('type "object" at the root');
		expect(errors[2]).toContain("effort must be one of");
		expect(errors[3]).toContain('isolation must be "worktree"');
		expect(spawned).toBe(0);
	});
});

describe("the sandbox", () => {
	test("no process, require, fetch or Buffer", async () => {
		const { run } = harness({
			script: "return [typeof process, typeof require, typeof fetch, typeof Buffer];",
		});
		expect((await run()).value).toEqual(["undefined", "undefined", "undefined", "undefined"]);
	});

	test("string code generation is off", async () => {
		const { run } = harness({ script: 'return eval("1 + 1");' });
		await expect(run()).rejects.toThrow("Code generation from strings disallowed");
	});

	test("Date and Math.random throw, other Date and Math members survive", async () => {
		const clock = harness({ script: "return Date.now();" });
		await expect(clock.run()).rejects.toThrow("Date.now() is not available in a workflow script");
		const dated = harness({ script: "return new Date().getTime();" });
		await expect(dated.run()).rejects.toThrow("Date is not available in a workflow script");
		const random = harness({ script: "return Math.random();" });
		await expect(random.run()).rejects.toThrow("Math.random() is not available in a workflow script");
		const kept = harness({ script: 'return [Date.parse("2020-01-01T00:00:00Z"), Math.max(2, 3), Math.floor(2.9)];' });
		expect((await kept.run()).value).toEqual([1577836800000, 3, 2]);
	});

	test("the synchronous part of a script is cut off at the time limit", async () => {
		const { run } = harness({ script: "while (true) {}", timeoutMs: 50 });
		await expect(run()).rejects.toThrow("timed out");
	});
});

describe("abort", () => {
	test("an already-aborted signal stops the run before it settles", async () => {
		const controller = new AbortController();
		controller.abort();
		const { run } = harness({ script: "return 1;", signal: controller.signal });
		await expect(run()).rejects.toBeInstanceOf(WorkflowAbortedError);
	});

	test("aborting during a call ends the run as aborted", async () => {
		const controller = new AbortController();
		const { run } = harness({
			script: "return await agent('go');",
			signal: controller.signal,
			agent: async () => {
				controller.abort();
				return { ok: false, error: "aborted" };
			},
		});
		await expect(run()).rejects.toBeInstanceOf(WorkflowAbortedError);
	});

	test("a script that never settles does not keep the run alive after a cancel", async () => {
		// The script cannot be unwound, but the runner must stop waiting for it;
		// otherwise an `await new Promise(() => {})` outlives the user's stop.
		const controller = new AbortController();
		const { run } = harness({ script: "await new Promise(() => {});\nreturn 1;", signal: controller.signal });
		const pending = run();
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(WorkflowAbortedError);
	});
});

describe("workflowConcurrency", () => {
	test("it stays within the documented band", () => {
		const value = workflowConcurrency();
		expect(value).toBeGreaterThanOrEqual(1);
		expect(value).toBeLessThanOrEqual(16);
	});
});
