/**
 * The spawn extension `SubagentControl.spawn` added for workflows: caller-chosen
 * model, working directory, thinking level, and a structured answer.
 *
 * A workflow call with no options is exactly a Task call, so the interesting
 * cases are the ones that differ: the chosen model must outrank the seats, the
 * schema must be both instructed and (where the wire has it) sent natively, and
 * one malformed answer must get one retry with the validator's complaints — a
 * second failure is reported to the script rather than retried forever.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyTool, buildTool, type SessionStore } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type Model, type StreamFn } from "@labunbun/ai";
import { z } from "zod";
import type { RoleName } from "../src/model-roles.ts";
import { SubagentRegistry } from "../src/subagent-registry.ts";
import { createSubagentTools, type SubagentControl } from "../src/subagents.ts";

const SCHEMA = {
	type: "object",
	properties: { n: { type: "number" } },
	required: ["n"],
	additionalProperties: false,
};
const LIGHT: Model = { ...FAUX_MODEL, id: "light-model" };
const OTHER: Model = { ...FAUX_MODEL, id: "other-model" };

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lbb-subagent-structured-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function echoTool(): AnyTool {
	return buildTool({
		name: "echo",
		description: "echo",
		inputSchema: z.object({ text: z.string() }),
		call: async (input: { text: string }) => ({ content: [{ type: "text", text: input.text }] }),
	});
}

type Harness = {
	control: SubagentControl;
	received: Array<{ systemPrompt: string; outputSchema?: Record<string, unknown>; thinkingLevel?: string }>;
	contexts: unknown[];
	models: string[];
	registry: SubagentRegistry;
	reports: string[];
};

function harness(options: {
	lightModel?: () => Model | undefined;
	tools?: AnyTool[];
	steps: Parameters<typeof fauxProvider>[0];
	budgetGate?: (role: RoleName) => string | null;
	store?: () => SessionStore | undefined;
}) {
	const faux = fauxProvider(options.steps);
	const received: Harness["received"] = [];
	const models: string[] = [];
	const reports: string[] = [];
	const registry = new SubagentRegistry();
	const streamFn: StreamFn = async function* (model, context, streamOptions) {
		models.push(model.id);
		received.push({
			systemPrompt: context.systemPrompt,
			outputSchema: streamOptions?.outputSchema,
			thinkingLevel: streamOptions?.thinkingLevel,
		});
		yield* faux.streamFn(model, context, streamOptions);
	};
	const [, , , control] = createSubagentTools({
		streamFn,
		model: () => FAUX_MODEL,
		lightModel: options.lightModel,
		allTools: () => options.tools ?? [echoTool()],
		definitions: () => [],
		budgetGate: options.budgetGate,
		report: (text) => reports.push(text),
		store: options.store,
		registry,
	});
	return { control, received, contexts: faux.receivedContexts, models, registry, reports };
}

const REQUEST = { description: "job", prompt: "do the thing" };

describe("structured answers", () => {
	test("a matching JSON answer is parsed for the caller", async () => {
		const { control } = harness({ steps: [{ text: '{"n": 2}' }] });
		const outcome = await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });

		expect(outcome.structured).toEqual({ n: 2 });
		expect(outcome.structuredError).toBeUndefined();
		expect(outcome.reason).toBe("completed");
		expect(outcome.result.isError).toBeFalsy();
	});

	test("the schema is instructed in the system prompt and sent on the request", async () => {
		const { control, received } = harness({ steps: [{ text: '{"n": 1}' }] });
		await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });

		expect(received[0].systemPrompt).toContain("Your final answer must be a single JSON value");
		expect(received[0].systemPrompt).toContain(JSON.stringify(SCHEMA));
		expect(received[0].outputSchema).toEqual(SCHEMA);
	});

	test("a fenced answer is accepted rather than refused for its packaging", async () => {
		const { control } = harness({ steps: [{ text: '```json\n{"n": 5}\n```' }] });
		const outcome = await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });
		expect(outcome.structured).toEqual({ n: 5 });
	});

	test("one bad answer is retried with the validator's complaint", async () => {
		const { control, contexts } = harness({ steps: [{ text: '{"n": "no"}' }, { text: '{"n": 3}' }] });
		const outcome = await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });

		expect(outcome.structured).toEqual({ n: 3 });
		expect(outcome.structuredError).toBeUndefined();
		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1])).toContain("did not satisfy the required JSON schema");
		expect(JSON.stringify(contexts[1])).toContain("$.n: expected number, got string");
	});

	test("a second bad answer is reported, not retried again", async () => {
		const { control, contexts } = harness({ steps: [{ text: "not json" }, { text: "still not json" }] });
		const outcome = await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });

		expect(outcome.structured).toBeUndefined();
		expect(outcome.structuredError).toBe("the answer was not valid JSON");
		// The original request and the one retry: no third attempt.
		expect(contexts).toHaveLength(2);
	});

	test("an example that does not fit the schema does not win over the answer", async () => {
		// Both are valid JSON; only the real answer satisfies the schema, so the
		// schema is what tells the example and the answer apart.
		const { control } = harness({ steps: [{ text: 'For example {"n": "zero"}, but my answer is {"n": 7}.' }] });
		const outcome = await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });
		expect(outcome.structured).toEqual({ n: 7 });
		expect(outcome.structuredError).toBeUndefined();
	});

	test("two schema-matching values are ambiguous and get the retry, not the first one", async () => {
		// A schema-shaped example is exactly the shape validation cannot reject,
		// so the first match must not be reported as the answer.
		const { control, contexts } = harness({
			steps: [{ text: 'For example {"n": 0}, but my answer is {"n": 7}.' }, { text: '{"n": 7}' }],
		});
		const outcome = await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });

		expect(outcome.structured).toEqual({ n: 7 });
		expect(contexts).toHaveLength(2);
		expect(JSON.stringify(contexts[1])).toContain("more than one JSON value that matches the schema");
	});

	test("a seat that crossed its ceiling is not handed the retry", async () => {
		// The retry is another request on the seat. The gate answers null at the
		// spawn door and for the turn_end booking, then refuses the retry door.
		let gates = 0;
		const { control, contexts, reports } = harness({
			steps: [{ text: '{"n": "no"}' }, { text: '{"n": 3}' }],
			lightModel: () => LIGHT,
			budgetGate: () => (++gates >= 3 ? "The light seat is over its ceiling." : null),
		});
		const outcome = await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });

		expect(contexts).toHaveLength(1);
		expect(outcome.structured).toBeUndefined();
		expect(outcome.structuredError).toBe("$.n: expected number, got string");
		expect(reports).toContain("The light seat is over its ceiling.");
	});

	test("a start entry the store refuses still finishes the handle", async () => {
		// The start write sits inside the pairing guard, and registry.finish used
		// to live only in runPrompt — which a refused start never reaches. The
		// handle would stay live forever with no run behind it.
		const store = {
			appendCustom: (kind: string) => {
				if (kind === "subagent_start") throw new Error("ENOSPC");
			},
		} as unknown as SessionStore;
		const { control, registry } = harness({ steps: [{ text: "unused" }], store: () => store });

		await expect(control.spawn(REQUEST, { cwd: tempRoot() })).rejects.toThrow("ENOSPC");
		const [handle] = registry.list();
		expect(handle?.state).toBe("finished");
		expect(handle?.endReason).toBe("error");
		expect(handle?.finishedAt).toBeGreaterThan(0);
	});

	test("a run that ended before completing is not asked again for its schema", async () => {
		// max_turns ends the run with no final prose. The schema retry used to
		// send another request anyway, spending on a run the session had already
		// ended — the same shape as a stopped subagent being revived.
		const { control, contexts } = harness({ steps: [{ toolCalls: [{ name: "echo", arguments: { text: "hi" } }] }] });
		const outcome = await control.spawn({ ...REQUEST, maxTurns: 1 }, { cwd: tempRoot() }, { outputSchema: SCHEMA });

		expect(outcome.reason).not.toBe("completed");
		expect(outcome.structured).toBeUndefined();
		expect(outcome.structuredError).toBeUndefined();
		// One request: the original. No retry after a run that did not finish.
		expect(contexts).toHaveLength(1);
	});

	test("the retry continues the same conversation", async () => {
		const { control, contexts } = harness({ steps: [{ text: "nope" }, { text: '{"n": 4}' }] });
		await control.spawn(REQUEST, { cwd: tempRoot() }, { outputSchema: SCHEMA });
		const second = contexts[1] as { messages: Array<{ role: string }> };
		expect(second.messages.filter((message) => message.role === "user")).toHaveLength(2);
	});
});

describe("per-call terms", () => {
	test("the chosen model outranks the light seat", async () => {
		const { control, models } = harness({ steps: [{ text: "done" }], lightModel: () => LIGHT });
		await control.spawn(REQUEST, { cwd: tempRoot() }, { model: OTHER });
		expect(models).toEqual([OTHER.id]);
	});

	test("without a model option the light seat still answers", async () => {
		const { control, models } = harness({ steps: [{ text: "done" }], lightModel: () => LIGHT });
		await control.spawn(REQUEST, { cwd: tempRoot() });
		expect(models).toEqual([LIGHT.id]);
	});

	test("the cwd option is where the subagent's tools run", async () => {
		const seen: string[] = [];
		const pwd = buildTool({
			name: "pwd",
			description: "report the cwd",
			inputSchema: z.object({}),
			call: async (_input: unknown, ctx: { cwd: string }) => {
				seen.push(ctx.cwd);
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		});
		const { control } = harness({
			steps: [{ toolCalls: [{ name: "pwd", arguments: {} }] }, { text: '{"n": 1}' }],
			tools: [pwd],
		});
		const runCwd = tempRoot();
		const scopeCwd = tempRoot();

		await control.spawn(REQUEST, { cwd: scopeCwd }, { cwd: runCwd, outputSchema: SCHEMA });

		expect(seen).toEqual([runCwd]);
	});

	test("the thinking level option reaches the request", async () => {
		const { control, received } = harness({ steps: [{ text: "done" }] });
		await control.spawn(REQUEST, { cwd: tempRoot() }, { thinkingLevel: "high" });
		expect(received[0].thinkingLevel).toBe("high");
	});

	test("an unknown agent type is refused before a session exists", async () => {
		const { control, models } = harness({ steps: [{ text: "unused" }] });
		const outcome = await control.spawn({ ...REQUEST, subagentType: "nope" }, { cwd: tempRoot() });
		expect(outcome.result.isError).toBe(true);
		expect(outcome.report).toBe("");
		expect((outcome.result.content[0] as { text: string }).text).toContain("Unknown agent type: nope");
		expect(models).toEqual([]);
	});

	test("an aborted run produces no structured answer", async () => {
		const controller = new AbortController();
		controller.abort();
		const { control } = harness({ steps: [{ text: '{"n": 1}' }] });
		const outcome = await control.spawn(
			REQUEST,
			{ cwd: tempRoot(), signal: controller.signal },
			{ outputSchema: SCHEMA },
		);
		expect(outcome.structured).toBeUndefined();
		expect(outcome.structuredError).toBeUndefined();
	});
});
