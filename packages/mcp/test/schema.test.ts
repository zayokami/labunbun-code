import { describe, expect, test } from "bun:test";
import { jsonSchemaToZod } from "../src/client.ts";

/** Whether the mapping accepts `value` — the only observable that matters. */
function check(schema: Record<string, unknown>, value: unknown): boolean {
	return jsonSchemaToZod(schema).safeParse(value).success;
}

describe("jsonSchemaToZod", () => {
	test("an enum of strings validates as that enum", () => {
		const schema = { type: "string", enum: ["fast", "slow"] };
		expect(check(schema, "fast")).toBe(true);
		expect(check(schema, "turbo")).toBe(false);
		expect(check(schema, 1)).toBe(false);
	});

	test("an enum of primitives becomes a union of literals", () => {
		const schema = { enum: [1, "two", true, null] };
		expect(check(schema, 1)).toBe(true);
		expect(check(schema, "two")).toBe(true);
		expect(check(schema, true)).toBe(true);
		expect(check(schema, null)).toBe(true);
		expect(check(schema, 2)).toBe(false);
		expect(check(schema, "one")).toBe(false);
	});

	test("an enum containing a non-primitive falls back to unknown", () => {
		// An object member has no literal form; a union with `unknown` would
		// accept everything, so the enum rather accepts broadly than rejects
		// values the server declared valid.
		const schema = { enum: [1, { nested: true }] };
		expect(check(schema, 1)).toBe(true);
		expect(check(schema, { nested: true })).toBe(true);
	});

	test("oneOf is a union of its members", () => {
		const schema = { oneOf: [{ type: "string" }, { type: "number" }] };
		expect(check(schema, "x")).toBe(true);
		expect(check(schema, 5)).toBe(true);
		expect(check(schema, false)).toBe(false);
	});

	test("anyOf is a union of its members", () => {
		const schema = { anyOf: [{ type: "string" }, { type: "boolean" }] };
		expect(check(schema, "x")).toBe(true);
		expect(check(schema, true)).toBe(true);
		expect(check(schema, 5)).toBe(false);
	});

	test("a single-member union is just that member", () => {
		const schema = { oneOf: [{ type: "string" }] };
		expect(check(schema, "x")).toBe(true);
		expect(check(schema, 5)).toBe(false);
	});

	test("nullable: true accepts null alongside the declared type", () => {
		const schema = { type: "string", nullable: true };
		expect(check(schema, "x")).toBe(true);
		expect(check(schema, null)).toBe(true);
		expect(check(schema, 5)).toBe(false);
	});

	test("a type array: null joins the rest, which union", () => {
		expect(check({ type: ["integer", "null"] }, 3)).toBe(true);
		expect(check({ type: ["integer", "null"] }, null)).toBe(true);
		expect(check({ type: ["integer", "null"] }, "3")).toBe(false);
		expect(check({ type: ["string", "number"] }, "x")).toBe(true);
		expect(check({ type: ["string", "number"] }, 3)).toBe(true);
		expect(check({ type: ["string", "number"] }, null)).toBe(false);
	});

	test("a lone null type accepts only null", () => {
		expect(check({ type: ["null"] }, null)).toBe(true);
		expect(check({ type: ["null"] }, "x")).toBe(false);
	});

	test("array items keep their declared type", () => {
		expect(check({ type: "array", items: { type: "number" } }, [1, 2])).toBe(true);
		expect(check({ type: "array", items: { type: "number" } }, ["a"])).toBe(false);
		// No `items` at all: anything goes, as before.
		expect(check({ type: "array" }, ["a", 1])).toBe(true);
	});

	test("tuple items validate per position", () => {
		const schema = { type: "array", items: [{ type: "string" }, { type: "number" }] };
		expect(check(schema, ["a", 1])).toBe(true);
		expect(check(schema, [1, "a"])).toBe(false);
		expect(check(schema, ["a", 1, "extra"])).toBe(false);
	});

	test("required properties are required, the rest optional", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: ["a"],
		};
		expect(check(schema, { a: "x" })).toBe(true);
		expect(check(schema, { a: "x", b: 1 })).toBe(true);
		expect(check(schema, { b: 1 })).toBe(false);
		expect(check(schema, { a: 1 })).toBe(false);
	});

	test("integer maps to number — JSON draws no line between them", () => {
		expect(check({ type: "integer" }, 2)).toBe(true);
		expect(check({ type: "integer" }, 2.5)).toBe(true);
		expect(check({ type: "integer" }, "2")).toBe(false);
	});

	test("an unknown or missing type validates nothing", () => {
		expect(check({ type: "thing" }, "anything")).toBe(true);
		expect(check({}, "anything")).toBe(true);
	});

	test("objects pass undeclared properties through", () => {
		const schema = { type: "object", properties: { a: { type: "string" } } };
		expect(check(schema, { a: "x", extra: 1 })).toBe(true);
	});
});
