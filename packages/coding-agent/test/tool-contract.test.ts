/**
 * Who decides a tool call's permission: the engine, and only the engine.
 *
 * `Tool` used to declare a `checkPermissions` hook, Edit and Write implemented
 * it, `buildTool` filled in a default — and nothing ever called any of it. The
 * question was already answered by `evaluatePermissions`, which is the only thing
 * that sees the mode, the rules and the workspace roots at once, and the hook's
 * answer was not merely redundant: "acceptEdits → allow" would have allowed a
 * write outside the workspace that the engine asks about, because a tool is
 * never told where the workspace is. Deleting it is not enough on its own — the
 * harness this codebase's conventions came from has such a hook, so the next
 * person adding a tool may go looking for one. This file is what says the seam
 * is closed on purpose.
 *
 * Read from the source, not from the built objects: a hook that is declared and
 * never implemented is exactly the shape being guarded against, and it appears
 * on no tool object at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyTool } from "@labunbun/agent";
import { createAllTools, defaultOperations, TaskStore } from "@labunbun/tools";

const CWD = process.cwd();
const TYPES_SOURCE = readFileSync(join(import.meta.dir, "..", "..", "agent", "src", "types.ts"), "utf8");

/**
 * The source with its comments taken out.
 *
 * `types.ts` documents the hook that was removed — by name, so the next author
 * finds the reasoning where the declaration used to be — and a scan over the raw
 * text would match that explanation. What this file guards is the declaration, so
 * it reads the code.
 */
function declarations(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/.*$/gm, "");
}

function builtTools(): AnyTool[] {
	return createAllTools(CWD, { taskStore: new TaskStore(), operations: defaultOperations() });
}

describe("the tool contract", () => {
	test("no tool decides its own permission", () => {
		for (const tool of builtTools()) {
			expect("checkPermissions" in tool, `${tool.name} carries a permission hook`).toBe(false);
		}
	});

	test("the interface declares no such hook either", () => {
		// The failure this guards is an author adding the declaration back and
		// implementing it — which is what happened the first time: two sources of
		// truth, one of them unreachable.
		expect(declarations(TYPES_SOURCE)).not.toContain("checkPermissions");
	});

	test("every built tool still answers the optionals the pipeline reads", () => {
		// The other half of the same contract: `buildTool` fills these in, and the
		// pipeline calls them without checking they exist.
		for (const tool of builtTools()) {
			expect(typeof tool.isEnabled, `${tool.name}.isEnabled`).toBe("function");
			expect(typeof tool.isReadOnly, `${tool.name}.isReadOnly`).toBe("function");
			expect(typeof tool.isConcurrencySafe, `${tool.name}.isConcurrencySafe`).toBe("function");
			expect(typeof tool.maxResultSizeChars, `${tool.name}.maxResultSizeChars`).toBe("number");
		}
	});
});
