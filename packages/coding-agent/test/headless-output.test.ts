/**
 * The two automation flags that touch the answer's file: `--output-schema`
 * constrains its shape, and `--output-last-message` keeps a copy.
 *
 * No network and no real session: a faux transport answers, and the home is a
 * throwaway. What the providers actually put on the wire is pinned in their
 * own adapter tests; here the question is whether the flag reaches the session
 * and whether the file the caller named is written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCustomModels, clearPricingOverrides, fauxProvider, type StreamFn } from "@labunbun/ai";
import { runHeadless } from "../src/headless.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	// Both maps are process-global, and this file is not their only writer.
	clearCustomModels();
	clearPricingOverrides();
});

interface Harness {
	home: string;
	cwd: string;
}

function makeHarness(): Harness {
	const home = mkdtempSync(join(tmpdir(), "lbb-headless-output-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-headless-output-cwd-"));
	roots.push(home, cwd);
	return { home, cwd };
}

/** Run with a throwaway home and captured streams, and put all three back. */
async function run(
	harness: Harness,
	options: {
		streamFn: StreamFn;
		modelRef?: string;
		outputSchemaPath?: string;
		outputLastMessagePath?: string;
	},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const error = console.error;
	process.stdout.write = ((chunk: unknown) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	console.error = (...args: unknown[]) => {
		err.push(args.map(String).join(" "));
	};
	try {
		const code = await runHeadless({
			prompt: "hello",
			modelRef: options.modelRef ?? "anthropic/claude-haiku-4-5",
			cwd: harness.cwd,
			noSession: true,
			outputFormat: "json",
			outputSchemaPath: options.outputSchemaPath,
			outputLastMessagePath: options.outputLastMessagePath,
			streamFn: options.streamFn,
			home: harness.home,
		});
		return { code, stdout: out.join(""), stderr: err.join("\n") };
	} finally {
		process.stdout.write = write;
		console.error = error;
	}
}

const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };

describe("--output-schema", () => {
	test("the parsed schema reaches every request the session sends", async () => {
		const harness = makeHarness();
		const schemaPath = join(harness.cwd, "schema.json");
		writeFileSync(schemaPath, JSON.stringify(SCHEMA));
		let seen: Record<string, unknown> | undefined;
		const faux = fauxProvider([{ text: "done" }]);
		const streamFn: StreamFn = (model, context, options) => {
			seen = options?.outputSchema;
			return faux.streamFn(model, context, options);
		};

		const result = await run(harness, { streamFn, outputSchemaPath: schemaPath });
		expect(result.code).toBe(0);
		expect(seen).toEqual(SCHEMA);
	});

	test("no flag means the stream options carry no schema", async () => {
		const harness = makeHarness();
		let seen: Record<string, unknown> | undefined;
		const faux = fauxProvider([{ text: "done" }]);
		const streamFn: StreamFn = (model, context, options) => {
			seen = options?.outputSchema;
			return faux.streamFn(model, context, options);
		};

		const result = await run(harness, { streamFn });
		expect(result.code).toBe(0);
		expect(seen).toBeUndefined();
	});

	test("a file that is not JSON is a CLI error before the model runs", async () => {
		const harness = makeHarness();
		const schemaPath = join(harness.cwd, "schema.json");
		writeFileSync(schemaPath, "{");
		const faux = fauxProvider([]);

		const result = await run(harness, { streamFn: faux.streamFn, outputSchemaPath: schemaPath });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("Invalid --output-schema:");
	});

	test("a JSON value that is not an object is refused", async () => {
		const harness = makeHarness();
		const schemaPath = join(harness.cwd, "schema.json");
		writeFileSync(schemaPath, "[1,2]");
		const faux = fauxProvider([]);

		const result = await run(harness, { streamFn: faux.streamFn, outputSchemaPath: schemaPath });
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("must name a JSON object");
	});

	test("a wire with no field for the schema is refused, not silently ignored", async () => {
		const harness = makeHarness();
		const schemaPath = join(harness.cwd, "schema.json");
		writeFileSync(schemaPath, JSON.stringify(SCHEMA));
		const faux = fauxProvider([]);

		const result = await run(harness, {
			streamFn: faux.streamFn,
			modelRef: "gemini/gemini-3-flash-preview",
			outputSchemaPath: schemaPath,
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("not supported on the gemini-code-assist wire");
	});
});

describe("--output-last-message", () => {
	test("writes the final answer it also reports", async () => {
		const harness = makeHarness();
		const target = join(harness.cwd, "answer.txt");
		const faux = fauxProvider([{ text: "final answer" }]);

		const result = await run(harness, { streamFn: faux.streamFn, outputLastMessagePath: target });
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).result).toBe("final answer");
		expect(readFileSync(target, "utf8")).toBe("final answer");
	});

	test("a write that fails is a failed run", async () => {
		const harness = makeHarness();
		// The parent directory is not created for us: the path is the caller's.
		const target = join(harness.cwd, "missing", "answer.txt");
		const faux = fauxProvider([{ text: "final answer" }]);

		const result = await run(harness, { streamFn: faux.streamFn, outputLastMessagePath: target });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--output-last-message:");
	});

	test("a run with no assistant text warns and writes nothing", async () => {
		const harness = makeHarness();
		const target = join(harness.cwd, "answer.txt");
		const faux = fauxProvider([{ stopReason: "error", errorMessage: "boom" }]);

		const result = await run(harness, { streamFn: faux.streamFn, outputLastMessagePath: target });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the run produced no assistant message");
		expect(() => readFileSync(target, "utf8")).toThrow();
	});
});
