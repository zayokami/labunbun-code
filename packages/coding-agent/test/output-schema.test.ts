/**
 * Which wires are promised a request-level JSON Schema.
 *
 * The list is the difference between a wire that enforces the answer's shape
 * and one that silently drops the field, so a wire whose builder does not
 * forward it must not be listed. `chatgpt-responses` rebuilds the Responses
 * request field by field and carries no `text`; claiming otherwise would give
 * `-p --output-schema` and a workflow's `agent(..., { schema })` free-form text
 * under a promise of structure.
 */
import { describe, expect, test } from "bun:test";
import { OUTPUT_SCHEMA_APIS, supportsOutputSchema } from "../src/output-schema.ts";

describe("supportsOutputSchema", () => {
	test("the wires whose builders carry the schema field", () => {
		expect(supportsOutputSchema("anthropic-messages")).toBe(true);
		expect(supportsOutputSchema("openai-completions")).toBe(true);
		expect(supportsOutputSchema("openai-responses")).toBe(true);
	});

	test("a wire that would drop the field is not promised", () => {
		expect(supportsOutputSchema("chatgpt-responses")).toBe(false);
		expect(supportsOutputSchema("gemini-code-assist")).toBe(false);
		expect(OUTPUT_SCHEMA_APIS.has("chatgpt-responses")).toBe(false);
	});
});
