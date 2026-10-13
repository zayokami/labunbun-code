/**
 * The light seat: `roles.light` is the model subagents run on.
 *
 * A subagent is the cheapest traffic a session generates — research sweeps,
 * file summarization — and the seat is the user's statement about where those
 * requests should go. The precedence the spawn resolves is: an agent
 * definition's own `model:` frontmatter first (it is the most specific word
 * about that agent), then the light seat, then the parent session's model,
 * which is what every host did before roles existed. An illegal `roles.light`
 * is dropped at startup with a warning — `resolveRoles` runs it through the
 * same resolution as every other seat — so what reaches here is either a model
 * or nothing, and nothing degrades to the parent.
 */
import { describe, expect, test } from "bun:test";
import { type AnyTool, buildTool } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type Model, type StreamFn } from "@labunbun/ai";
import { z } from "zod";
import { createSubagentTools } from "../src/subagents.ts";

const PARENT: Model = FAUX_MODEL;
const LIGHT: Model = { ...FAUX_MODEL, id: "light-model" };
const OTHER: Model = { ...FAUX_MODEL, id: "other-model" };

function echoTool(): AnyTool {
	return buildTool({
		name: "echo",
		description: "echo",
		inputSchema: z.object({ text: z.string() }),
		call: async (input: any) => ({ content: [{ type: "text", text: input.text }] }),
	});
}

/** A stream function that records which model each request was made to. */
function recordedModels(provider: { streamFn: StreamFn }) {
	const models: string[] = [];
	const streamFn: StreamFn = async function* (model, context, options) {
		models.push(model.id);
		yield* provider.streamFn(model, context, options);
	};
	return { models, streamFn };
}

function callTool(tool: AnyTool, input: Record<string, unknown> = { description: "x", prompt: "do it" }) {
	return tool.call(input, {
		callId: "t1",
		signal: new AbortController().signal,
		cwd: process.cwd(),
		sandbox: "workspace-write" as const,
		network: { access: "enabled" as const, domains: [] },
		onUpdate: () => {},
	});
}

describe("the light model seat", () => {
	test("a configured light seat runs subagents on it", async () => {
		const subFaux = fauxProvider([{ text: "sub done" }]);
		const { models, streamFn } = recordedModels(subFaux);
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			allTools: [echoTool()],
			definitions: () => [],
		});

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "general-purpose" });

		expect(models).toEqual(["light-model"]);
	});

	test("an agent definition's own model outranks the light seat", async () => {
		const subFaux = fauxProvider([{ text: "sub done" }]);
		const { models, streamFn } = recordedModels(subFaux);
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			resolveModel: (ref) => (ref === "other-model" ? OTHER : undefined),
			allTools: [echoTool()],
			definitions: () => [{ agentType: "quick", whenToUse: "Small jobs", source: "user", model: "other-model" }],
		});

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "quick" });

		expect(models).toEqual(["other-model"]);
	});

	test("no light seat — including one dropped as illegal — falls back to the parent model", async () => {
		// `lightModel: () => undefined` is exactly what a dropped `roles.light`
		// looks like from here: resolveRoles warns at startup and leaves the seat
		// empty, so the spawn must degrade to the parent rather than fail. This is
		// also the pre-roles behaviour every host had.
		const subFaux = fauxProvider([{ text: "sub done" }]);
		const { models, streamFn } = recordedModels(subFaux);
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => undefined,
			allTools: [echoTool()],
			definitions: () => [],
		});

		const result = await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "general-purpose" });

		expect(result.isError).toBeFalsy();
		expect(models).toEqual([PARENT.id]);
	});

	test("the light seat is read at spawn, not captured at construction", async () => {
		// The seat can move with the session (`/model` on a host that rebuilds the
		// context), and a captured value would keep spending the model the first
		// spawn ran on.
		const subFaux = fauxProvider([{ text: "sub done" }, { text: "sub done again" }]);
		const { models, streamFn } = recordedModels(subFaux);
		let current: Model | undefined = LIGHT;
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => current,
			allTools: [echoTool()],
			definitions: () => [],
		});

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "general-purpose" });
		current = undefined;
		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "general-purpose" });

		expect(models).toEqual(["light-model", PARENT.id]);
	});
});
