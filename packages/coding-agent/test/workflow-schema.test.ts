/**
 * The schema subset a workflow's structured answers are held to, and the
 * extraction that gets a value out of a model's prose.
 *
 * These are the rules the retrying model is told about, so the errors are
 * tested for what they say: a wrong type reports one problem rather than a
 * cascade, a missing required key names its path, and an unknown keyword is
 * satisfied rather than rejected — a schema written for a stricter validator
 * must still work here.
 */
import { describe, expect, test } from "bun:test";
import {
	checkWorkflowSchemaShape,
	parseJsonValue,
	structuredAnswerInstruction,
	validateWorkflowSchema,
} from "../src/workflow-schema.ts";

describe("validateWorkflowSchema", () => {
	const person = {
		type: "object",
		properties: {
			name: { type: "string", minLength: 1, maxLength: 10 },
			age: { type: "integer", minimum: 0, maximum: 150 },
			role: { type: "string", enum: ["admin", "user"] },
			tags: { type: "array", items: { type: "string" }, maxItems: 2 },
		},
		required: ["name", "age"],
		additionalProperties: false,
	};

	test("a matching value has no problems", () => {
		expect(validateWorkflowSchema(person, { name: "Ada", age: 36, role: "admin", tags: ["x"] })).toEqual([]);
	});

	test("required keys are named by their path", () => {
		expect(validateWorkflowSchema(person, { name: "Ada" })).toEqual(["$.age: required"]);
	});

	test("a wrong type is one problem, not a cascade", () => {
		// The bounds on the field would also complain about a string, but a model
		// reading five complaints for one mistake cannot tell which is real.
		expect(validateWorkflowSchema(person, { name: 3, age: 1 })).toEqual(["$.name: expected string, got integer"]);
	});

	test("integer and number accept each other's direction, not the reverse", () => {
		expect(validateWorkflowSchema({ type: "number" }, 3)).toEqual([]);
		expect(validateWorkflowSchema({ type: "integer" }, 3)).toEqual([]);
		expect(validateWorkflowSchema({ type: "integer" }, 3.5)).toEqual(["$: expected integer, got number"]);
	});

	test("string bounds and patterns", () => {
		expect(validateWorkflowSchema({ type: "string", minLength: 3 }, "ab")).toEqual([
			"$: must be at least 3 characters",
		]);
		expect(validateWorkflowSchema({ type: "string", maxLength: 2 }, "abc")).toEqual([
			"$: must be at most 2 characters",
		]);
		expect(validateWorkflowSchema({ type: "string", pattern: "^a+$" }, "ab")).toEqual(["$: does not match ^a+$"]);
	});

	test("number bounds, exclusivity and multiples", () => {
		expect(validateWorkflowSchema({ type: "number", minimum: 2 }, 1)).toEqual(["$: must be at least 2"]);
		expect(validateWorkflowSchema({ type: "number", maximum: 2 }, 3)).toEqual(["$: must be at most 2"]);
		expect(validateWorkflowSchema({ type: "number", exclusiveMinimum: 2 }, 2)).toEqual(["$: must be greater than 2"]);
		expect(validateWorkflowSchema({ type: "number", exclusiveMaximum: 2 }, 2)).toEqual(["$: must be less than 2"]);
		expect(validateWorkflowSchema({ type: "number", multipleOf: 5 }, 7)).toEqual(["$: must be a multiple of 5"]);
	});

	test("enum and const", () => {
		expect(validateWorkflowSchema({ enum: ["a", "b"] }, "c")).toEqual(['$: must be one of "a", "b"']);
		expect(validateWorkflowSchema({ const: 7 }, 8)).toEqual(["$: must equal 7"]);
		expect(validateWorkflowSchema({ enum: [{ a: 1 }] }, { a: 1 })).toEqual([]);
	});

	test("array items, lengths, and tuple schemas", () => {
		expect(validateWorkflowSchema({ type: "array", items: { type: "number" } }, [1, "x"])).toEqual([
			"$[1]: expected number, got string",
		]);
		expect(validateWorkflowSchema({ type: "array", minItems: 2 }, [1])).toEqual(["$: must have at least 2 items"]);
		expect(validateWorkflowSchema({ type: "array", maxItems: 1 }, [1, 2])).toEqual(["$: must have at most 1 items"]);
		expect(validateWorkflowSchema({ items: [{ type: "string" }, { type: "number" }] }, ["a", 1])).toEqual([]);
	});

	test("additionalProperties: false names the offending key", () => {
		expect(validateWorkflowSchema(person, { name: "Ada", age: 1, extra: true })).toEqual(["$.extra: not allowed"]);
	});

	test("combinators", () => {
		expect(validateWorkflowSchema({ allOf: [{ type: "number" }, { minimum: 5 }] }, 3)).toEqual([
			"$: must be at least 5",
		]);
		expect(validateWorkflowSchema({ anyOf: [{ type: "string" }, { type: "number" }] }, true)).toEqual([
			"$: does not match any allowed shape",
		]);
		expect(validateWorkflowSchema({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3)).toEqual([
			"$: must match exactly one allowed shape",
		]);
	});

	test("unknown keywords are satisfied, not rejected", () => {
		const strict = { type: "object", properties: { n: { type: "number", format: "float", $ref: "#/nope" } } };
		expect(validateWorkflowSchema(strict, { n: 1.5 })).toEqual([]);
	});

	test("a schema that nests past the depth cap says so instead of recursing", () => {
		let schema: Record<string, unknown> = { type: "string" };
		let value: unknown = "leaf";
		for (let i = 0; i < 70; i++) {
			schema = { type: "array", items: schema };
			value = [value];
		}
		expect(validateWorkflowSchema(schema, value).join("\n")).toContain("nests too deeply");
	});
});

describe("checkWorkflowSchemaShape", () => {
	test("a schema that is not an object is refused", () => {
		expect(checkWorkflowSchemaShape("nope")).toBe("schema must be a JSON object");
		expect(checkWorkflowSchemaShape([])).toBe("schema must be a JSON object");
	});

	test("the root must be an object", () => {
		expect(checkWorkflowSchemaShape({ type: "array" })).toBe(
			'a workflow result schema must have type "object" at the root',
		);
		expect(checkWorkflowSchemaShape({ type: ["object", "null"] })).toBeUndefined();
		expect(checkWorkflowSchemaShape({})).toBeUndefined();
	});

	test("required must be declared in properties", () => {
		expect(checkWorkflowSchemaShape({ type: "object", properties: { a: {} }, required: ["a", "b"] })).toBe(
			'required key "b" is not declared in properties',
		);
		expect(checkWorkflowSchemaShape({ type: "object", properties: { a: {} }, required: ["a"] })).toBeUndefined();
	});
});

describe("parseJsonValue", () => {
	test("a fenced block wins over the prose around it", () => {
		expect(parseJsonValue('Here you go:\n```json\n{"a": 1}\n```\nDone.')).toEqual({ value: { a: 1 } });
	});

	test("plain JSON is read whole", () => {
		expect(parseJsonValue("  [1, 2, 3]  ")).toEqual({ value: [1, 2, 3] });
	});

	test("a balanced span inside prose is the last resort", () => {
		expect(parseJsonValue('The answer is {"a": {"b": 2}} as requested.')).toEqual({ value: { a: { b: 2 } } });
	});

	test("empty and non-JSON answers fail with a sentence", () => {
		expect(parseJsonValue("   ")).toEqual({ error: "the answer was empty" });
		expect(parseJsonValue("no json here")).toEqual({ error: "the answer was not valid JSON" });
	});

	test("a fence without a language tag works too", () => {
		expect(parseJsonValue('```\n{"a": true}\n```')).toEqual({ value: { a: true } });
	});
});

describe("structuredAnswerInstruction", () => {
	test("it carries the schema and says the answer is JSON only", () => {
		const schema = { type: "object", properties: { n: { type: "number" } } };
		const instruction = structuredAnswerInstruction(schema);
		expect(instruction).toContain(JSON.stringify(schema));
		expect(instruction).toContain("no prose, no Markdown fences");
	});
});
