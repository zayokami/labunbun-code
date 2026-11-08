/**
 * Which wires can carry a JSON Schema for the answer.
 *
 * The schema travels as a request field, not as a prompt convention, so a wire
 * without the field either ignores it or rejects it. The Gemini Code Assist wire
 * is a proprietary shape with no equivalent, which is why it is absent rather
 * than untested. The Workflow runner and `-p --output-schema` both ask this one
 * question rather than keeping a private copy of the list.
 */
export const OUTPUT_SCHEMA_APIS: ReadonlySet<string> = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"chatgpt-responses",
]);

/** Whether `model.api` has a request field for a JSON Schema. */
export function supportsOutputSchema(api: string): boolean {
	return OUTPUT_SCHEMA_APIS.has(api);
}
