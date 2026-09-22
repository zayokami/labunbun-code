/**
 * Plan mode's allow-list, held against the tools' own `isReadOnly`.
 *
 * The engine in `@labunbun/agent` decides the mode by tool name — it is handed
 * names, never tool objects — while every tool answers the same question itself
 * through `Tool.isReadOnly`. Nothing read that declaration, and the two drifted:
 * AskUserQuestion declared itself read-only and was still refused in plan mode,
 * which a real session showed when the model, told to plan a task whose goal had
 * never been stated, tried to ask which task and had to plan a guess instead.
 *
 * So this walks the tool set the app actually builds and fails on any
 * disagreement, in both directions: a read-only tool the mode refuses, and a
 * mutating one it permits. A tool that wants plan mode to admit it has to say so
 * in its own declaration, and the name list in `permissions.ts` has to agree
 * with what the tools say.
 *
 * The Task tool is deliberately not in the set: it is built from a live
 * session's context. It declares no `isReadOnly`, so it fails closed to
 * "mutating" and the mode denies it — which is what its own declaration says.
 */
import { describe, expect, test } from "bun:test";
import { type AnyTool, evaluatePermissions } from "@labunbun/agent";
import { createAllTools, defaultOperations, TaskStore } from "@labunbun/tools";
import { createAskUserQuestionTool } from "../src/ask-user.ts";
import { createPlanModeTools, type PlanModeCallbacks } from "../src/plan-mode.ts";

const CWD = process.cwd();

/** The set the app offers: the sandbox tools, then the plan and question tools. */
function appTools(): AnyTool[] {
	const callbacks: PlanModeCallbacks = {
		enterPlanMode: () => {},
		// Neither is ever invoked here — the tools are asked what they are, not run.
		requestPlanApproval: async () => ({ approved: false }),
	};
	return [
		...createAllTools(CWD, { taskStore: new TaskStore(), operations: defaultOperations() }),
		...createPlanModeTools(callbacks),
		createAskUserQuestionTool({ askUser: async () => null }),
	];
}

/** `[name, declared read-only]`, computed once for the table below. */
const TOOLS: Array<[string, boolean]> = appTools().map((tool) => [tool.name, tool.isReadOnly?.({}) ?? false]);

describe("plan mode's allow-list against the tools' declarations", () => {
	// Declared in a loop rather than through `test.each`: the failure has to name the
	// tool, and bun's each-templates print their placeholders literally.
	for (const [name, readOnly] of TOOLS) {
		test(`${name} (isReadOnly: ${readOnly})`, () => {
			const { behavior } = evaluatePermissions(name, {}, { mode: "plan", rules: [], cwd: CWD, workspaceRoots: [CWD] });
			// Not "allow" but "not denied": a read-only tool still goes through the
			// user's own rules, and asks when none allows it. What the mode must not do
			// is refuse it outright — that is a decision taken out of the user's hands
			// on the strength of a list, and the list was wrong.
			expect(behavior === "deny").toBe(!readOnly);
		});
	}

	test("the sentence the model reads names the tools the mode actually admits", async () => {
		const callbacks: PlanModeCallbacks = {
			enterPlanMode: () => {},
			requestPlanApproval: async () => ({ approved: false }),
		};
		const [enter] = createPlanModeTools(callbacks);
		// The call ignores both arguments: it switches a session's mode and describes
		// the mode back, and which session is not what this asks about.
		const result = await enter.call({}, {} as never);
		const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

		// The model plans by what it is told it may use. A sentence listing four tools
		// while the list admits more is how a question that could have been asked is
		// never asked at all.
		for (const name of ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "AskUserQuestion"]) {
			expect(text).toContain(name);
		}
	});

	test("covers the tools whose declarations the drift hit", () => {
		const names = TOOLS.map(([name]) => name);
		// The table is the test, so a row that quietly stopped being built would take
		// its own coverage with it.
		for (const name of ["AskUserQuestion", "WebFetch", "WebSearch", "BashOutput"]) {
			expect(names).toContain(name);
		}
	});
});
