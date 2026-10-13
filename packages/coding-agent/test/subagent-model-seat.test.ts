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
import { FAUX_MODEL, fauxProvider, type Model, type StreamFn, type Usage } from "@labunbun/ai";
import { z } from "zod";
import type { UsageSeat } from "../src/cost-tracker.ts";
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

/**
 * The booking, not the ledger: a subagent's usage must reach the host's hook
 * with the seat label it is booked under — kind "subagent" plus the role when
 * a role seat answered — because nothing else records it. The subagent's
 * transcript never enters the parent's, so a host that drops this hook books
 * the spend nowhere. The ledger it lands in is cost-tracker.test.ts's subject.
 */
describe("subagent usage booking", () => {
	function bookingsOf() {
		const bookings: Array<{ provider: string; model: string; input: number; output: number; seat: UsageSeat }> = [];
		const onUsage = (provider: string, modelId: string, usage: Usage, seat: UsageSeat) => {
			bookings.push({ provider, model: modelId, input: usage.input, output: usage.output, seat });
		};
		return { bookings, onUsage };
	}

	test("a run on the light seat books its usage under the light role", async () => {
		const subFaux = fauxProvider([{ text: "sub done", usage: { input: 10, output: 5 } }]);
		const { streamFn } = recordedModels(subFaux);
		const { bookings, onUsage } = bookingsOf();
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			allTools: [echoTool()],
			definitions: () => [],
			onUsage,
		});

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "general-purpose" });

		expect(bookings).toEqual([
			{ provider: "faux", model: "light-model", input: 10, output: 5, seat: { kind: "subagent", role: "light" } },
		]);
	});

	test("a definition's own model books with no role to name", async () => {
		// The seat only names itself when the seat answered: a definition's own
		// model is the agent's choice, not a role's.
		const subFaux = fauxProvider([{ text: "sub done", usage: { input: 1, output: 2 } }]);
		const { streamFn } = recordedModels(subFaux);
		const { bookings, onUsage } = bookingsOf();
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			resolveModel: (ref) => (ref === "other-model" ? OTHER : undefined),
			allTools: [echoTool()],
			definitions: () => [{ agentType: "quick", whenToUse: "Small jobs", source: "user", model: "other-model" }],
			onUsage,
		});

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "quick" });

		expect(bookings).toHaveLength(1);
		expect(bookings[0].model).toBe("other-model");
		expect(bookings[0].seat.kind).toBe("subagent");
		expect(bookings[0].seat.role).toBeUndefined();
	});

	test("a run on the parent's model books with no role either", async () => {
		const subFaux = fauxProvider([{ text: "sub done", usage: { input: 1, output: 2 } }]);
		const { streamFn } = recordedModels(subFaux);
		const { bookings, onUsage } = bookingsOf();
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => undefined,
			allTools: [echoTool()],
			definitions: () => [],
			onUsage,
		});

		await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "general-purpose" });

		expect(bookings).toHaveLength(1);
		expect(bookings[0].model).toBe(PARENT.id);
		expect(bookings[0].seat.role).toBeUndefined();
	});

	test("a continuation books under the seat it was spawned on", async () => {
		// SendMessage runs the same `runPrompt` as Task and holds only the
		// handle, so the label travels beside the handle: the follow-up books
		// under the spawn's seat rather than against whatever answers now.
		const subFaux = fauxProvider([
			{ text: "first", usage: { input: 1, output: 0 } },
			{ text: "second", usage: { input: 2, output: 0 } },
		]);
		const { streamFn } = recordedModels(subFaux);
		const { bookings, onUsage } = bookingsOf();
		const [taskTool, sendMessageTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			allTools: [echoTool()],
			definitions: () => [],
			onUsage,
		});

		const first = await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "general-purpose" });
		const id = /\[subagent id: (sidechain-[^\]]+)\]/.exec((first.content[0] as { text: string }).text)?.[1];
		expect(id).toBeTruthy();
		await callTool(sendMessageTool, { sidechain_id: id, message: "again" });

		expect(bookings.map((booking) => booking.input)).toEqual([1, 2]);
		expect(bookings.every((booking) => booking.seat.role === "light")).toBe(true);
	});
});

/**
 * The light seat's budget, at the three doors into a run.
 *
 * The tool does no arithmetic: the host books the spend (`onUsage`) and the
 * host answers "over, or not" (`budgetGate`) — so these tests drive the gate
 * with a fake and assert where it is asked and what each door does with a
 * refusal. The spawn and the continuation hand the sentence back as the tool
 * result, because the model that ordered the work is the reader who has to
 * act; a crossing mid-run aborts that subagent, and the sentence is said out
 * loud because the ending alone reads only "aborted". A gate that must not be
 * asked — a definition's own model, which is not a role seat — leaves the run
 * alone however far over the seat itself is.
 */
describe("the light seat's budget gate", () => {
	const sentence =
		"Budget reached: $2.5000 spent of the $2.0000 budget for roles.light. Raise roles.light.budgetUSD or switch models.";

	test("a spawn is refused before it starts, with the sentence as the result", async () => {
		const subFaux = fauxProvider([{ text: "should not run" }]);
		const { models, streamFn } = recordedModels(subFaux);
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			allTools: [echoTool()],
			definitions: () => [],
			budgetGate: (role) => (role === "light" ? sentence : null),
		});

		const result = await callTool(taskTool, { description: "x", prompt: "do it" });

		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain(sentence);
		expect((result.content[0] as { text: string }).text).toContain("No subagent was started.");
		// Nothing was sent for the refused run: the refusal precedes the request.
		expect(models).toEqual([]);
	});

	test("a definition's own model is not a seat, so the gate is never asked", async () => {
		// Only the light seat's spend is attributable — the label carries the role
		// only when the seat answered — so only its budget can apply. A run on an
		// agent's own model answers even with the light seat deep in the red.
		const subFaux = fauxProvider([{ text: "done" }]);
		const { models, streamFn } = recordedModels(subFaux);
		const asked: string[] = [];
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			resolveModel: (ref) => (ref === "other-model" ? OTHER : undefined),
			allTools: [echoTool()],
			definitions: () => [{ agentType: "quick", whenToUse: "Small jobs", source: "user", model: "other-model" }],
			budgetGate: (role) => {
				asked.push(role);
				return sentence;
			},
		});

		const result = await callTool(taskTool, { description: "x", prompt: "do it", subagent_type: "quick" });

		expect(result.isError).toBeFalsy();
		expect(asked).toEqual([]);
		expect(models).toEqual(["other-model"]);
	});

	test("the turn that crosses the ceiling ends that run, after the booking landed", async () => {
		// The running gate: the spend is booked first (`onUsage`), then the gate
		// is asked — a fake that goes over exactly when the booking lands. The
		// abort ends the subagent's own session, so the next request never goes
		// out while the parent's run is untouched.
		const subFaux = fauxProvider([
			{ text: "step 1", toolCalls: [{ name: "echo", arguments: { text: "hi" } }], usage: { input: 1_000 } },
			{ text: "should not run" },
		]);
		const { models, streamFn } = recordedModels(subFaux);
		const reports: string[] = [];
		let booked = 0;
		const [taskTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			allTools: [echoTool()],
			definitions: () => [],
			report: (text) => reports.push(text),
			onUsage: (_provider, _model, usage) => {
				booked += usage.input;
			},
			budgetGate: () => (booked > 0 ? sentence : null),
		});

		const result = await callTool(taskTool, { description: "x", prompt: "do it" });

		// The crossing turn was paid for and its tool ran; the one after it was
		// never sent.
		expect(models).toEqual(["light-model"]);
		expect(reports.join("\n")).toContain(sentence);
		expect((result.content[0] as { text: string }).text).toContain("[subagent ended: aborted]");
	});

	test("a continuation is refused when the seat went over after the spawn", async () => {
		const subFaux = fauxProvider([{ text: "first" }, { text: "should not run" }]);
		const { models, streamFn } = recordedModels(subFaux);
		let refuse = false;
		const [taskTool, sendMessageTool] = createSubagentTools({
			streamFn,
			model: () => PARENT,
			lightModel: () => LIGHT,
			allTools: [echoTool()],
			definitions: () => [],
			budgetGate: () => (refuse ? sentence : null),
		});

		const first = await callTool(taskTool, { description: "x", prompt: "do it" });
		const id = /\[subagent id: (sidechain-[^\]]+)\]/.exec((first.content[0] as { text: string }).text)?.[1];
		expect(id).toBeTruthy();
		refuse = true;

		const second = await callTool(sendMessageTool, { sidechain_id: id, message: "again" });

		expect(second.isError).toBe(true);
		expect((second.content[0] as { text: string }).text).toContain(sentence);
		expect((second.content[0] as { text: string }).text).toContain("was not continued");
		// Only the spawn's request was made.
		expect(models).toEqual(["light-model"]);
	});
});
