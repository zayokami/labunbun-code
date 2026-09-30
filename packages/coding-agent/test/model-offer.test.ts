/**
 * What the app offers as a model, and what it says about the one it will not.
 *
 * Two claims are pinned here, and both were unheld before this file existed —
 * a `/model` list that silently included a model which cannot act, and a warning
 * that existed only as a string inside two different closures.
 *
 * The registry-level half lives in `packages/ai/test/openai-responses.test.ts`;
 * this file is about the *offering*, which is a different question from whether
 * the row is marked. A row can be marked correctly and offered anyway, and that
 * is precisely the failure the picker filter exists to stop.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveModel } from "@labunbun/ai";
import { noToolCallingNotice, offeredModels } from "../src/model-offer.ts";

const SRC = join(import.meta.dir, "..", "src");

describe("offeredModels", () => {
	test("the model that cannot act is not on the list", () => {
		const refs = offeredModels().map((m) => `${m.provider}/${m.id}`);
		expect(refs).toContain("openai/gpt-6.1-sol");
		expect(refs).not.toContain("opencode-zen-oai/gpt-6.1-sol");
	});

	test("the same model is offered under its working provider", () => {
		// The negative above is only meaningful if the row was not simply deleted.
		// Filtering and removing look identical from the catalog; the point is that
		// the user still has this model, on a wire that accepts its tools.
		const offered = offeredModels().find((m) => m.id === "gpt-6.1-sol");
		expect(offered?.provider).toBe("openai");
		expect(offered?.toolCalling).toBeUndefined();
	});

	test("no offered model is one that says it cannot act", () => {
		// The catalog-wide version of the first test: it holds when a mutation marks
		// a second row, which a spot check on one id would not notice.
		const marked = offeredModels().filter((m) => m.toolCalling === false);
		expect(marked.map((m) => `${m.provider}/${m.id}`)).toEqual([]);
	});
});

describe("noToolCallingNotice", () => {
	const zen = resolveModel("opencode-zen-oai/gpt-6.1-sol");

	test("names the model and the reason", () => {
		// Resolved rather than asserted-and-forced: a row that stops existing would
		// otherwise make this test pass on a model that is no longer the one under
		// discussion, which is a green that means nothing.
		if (!zen) throw new Error("opencode-zen-oai/gpt-6.1-sol is no longer in the registry");
		const line = noToolCallingNotice(zen);
		expect(line).toContain("opencode-zen-oai/gpt-6.1-sol");
		// The reason, not the symptom. "it will not act" on its own is a bug report;
		// what a reader needs is that this is a wire property, not a lost tool list.
		expect(line).toContain("cannot call tools");
		expect(line).toContain("wire");
	});

	test("both surfaces use this sentence and not their own copy", () => {
		// Two closures each interpolating the model name is two sentences to keep in
		// step, and a driver that mutated one would see nothing wrong with the other.
		// Read from source because neither function is callable from here.
		for (const file of ["interactive.ts", "headless.ts"]) {
			const source = readFileSync(join(SRC, file), "utf8");
			expect(source).toContain("noToolCallingNotice");
			expect(source).not.toMatch(/cannot call tools on the wire it is registered on/);
		}
	});
});

describe("the picker", () => {
	test("reads its list through offeredModels rather than listModels", () => {
		// A future edit that reaches for listModels directly re-opens the trap with
		// the filter still sitting in model-offer.ts looking correct and unused.
		const source = readFileSync(join(SRC, "interactive.ts"), "utf8");
		expect(source).toContain("offeredModels()");
		expect(source).not.toMatch(/listModels\(\)\.filter/);
	});
});
