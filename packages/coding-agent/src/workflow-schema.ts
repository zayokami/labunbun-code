/**
 * JSON Schema checking for workflow results.
 *
 * A workflow asks for structured answers so the script can index into them
 * without parsing prose. The wire already forces a schema where it can, but a
 * wire without the field (or a model that ignores the instruction) still owes
 * the script an object, so the runner parses and checks the answer here and
 * hands the failure back to the agent once for a retry.
 *
 * This is deliberately not a full JSON Schema implementation. It covers the
 * keywords a workflow author reaches for — type, properties, required, items,
 * enum, const, string/number/array bounds, and the three combinators — and it
 * treats every unknown keyword as satisfied, which is the only behavior that
 * does not reject schemas written for a stricter validator.
 */
export type WorkflowJsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && Number.isInteger(value)) return "integer";
	return typeof value;
}

function jsonEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function childPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function describe(value: unknown): string {
	const text = JSON.stringify(value);
	if (text === undefined) return String(value);
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Run one schema check, pushing human-readable problems into `errors`. */
function checkSchema(schema: unknown, value: unknown, path: string, errors: string[], depth: number): void {
	if (depth > 64) {
		errors.push(`${path}: schema nests too deeply`);
		return;
	}
	if (schema === true || schema === undefined) return;
	if (schema === false) {
		errors.push(`${path}: no value is allowed here`);
		return;
	}
	if (!isRecord(schema)) return;

	if (Array.isArray(schema.allOf)) {
		for (const sub of schema.allOf) checkSchema(sub, value, path, errors, depth + 1);
	}
	if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => passesSchema(sub, value))) {
		errors.push(`${path}: does not match any allowed shape`);
	}
	if (Array.isArray(schema.oneOf)) {
		const matches = schema.oneOf.filter((sub) => passesSchema(sub, value)).length;
		if (matches !== 1) errors.push(`${path}: must match exactly one allowed shape`);
	}
	if ("const" in schema && !jsonEqual(schema.const, value)) {
		errors.push(`${path}: must equal ${describe(schema.const)}`);
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
		errors.push(`${path}: must be one of ${schema.enum.map(describe).join(", ")}`);
	}

	if (schema.type !== undefined) {
		const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
			(entry): entry is string => typeof entry === "string",
		);
		if (types.length > 0) {
			const actual = typeOf(value);
			const accepted = types.some((type) => type === actual || (type === "number" && actual === "integer"));
			// A wrong type makes every other keyword meaningless — reporting the
			// one real problem is kinder than a pile of follow-on complaints.
			if (!accepted) {
				errors.push(`${path}: expected ${types.join(" or ")}, got ${actual}`);
				return;
			}
		}
	}

	if (typeof value === "string") {
		const length = [...value].length;
		if (typeof schema.minLength === "number" && length < schema.minLength) {
			errors.push(`${path}: must be at least ${schema.minLength} characters`);
		}
		if (typeof schema.maxLength === "number" && length > schema.maxLength) {
			errors.push(`${path}: must be at most ${schema.maxLength} characters`);
		}
		if (typeof schema.pattern === "string") {
			try {
				if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match ${schema.pattern}`);
			} catch {
				// An invalid pattern is the schema author's problem, not the answer's.
			}
		}
	}

	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			errors.push(`${path}: must be at least ${schema.minimum}`);
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			errors.push(`${path}: must be at most ${schema.maximum}`);
		}
		if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
			errors.push(`${path}: must be greater than ${schema.exclusiveMinimum}`);
		}
		if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
			errors.push(`${path}: must be less than ${schema.exclusiveMaximum}`);
		}
		if (typeof schema.multipleOf === "number" && schema.multipleOf > 0 && value % schema.multipleOf !== 0) {
			errors.push(`${path}: must be a multiple of ${schema.multipleOf}`);
		}
	}

	if (Array.isArray(value)) {
		if (isRecord(schema.items)) {
			for (const [index, item] of value.entries()) {
				checkSchema(schema.items, item, `${path}[${index}]`, errors, depth + 1);
			}
		} else if (Array.isArray(schema.items)) {
			for (const [index, item] of value.entries()) {
				if (index < schema.items.length) checkSchema(schema.items[index], item, `${path}[${index}]`, errors, depth + 1);
			}
		}
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errors.push(`${path}: must have at least ${schema.minItems} items`);
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			errors.push(`${path}: must have at most ${schema.maxItems} items`);
		}
	}

	if (isRecord(value)) {
		const properties = isRecord(schema.properties) ? schema.properties : {};
		for (const [key, sub] of Object.entries(properties)) {
			if (key in value) checkSchema(sub, value[key], childPath(path, key), errors, depth + 1);
		}
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (typeof key === "string" && !(key in value)) errors.push(`${childPath(path, key)}: required`);
			}
		}
		if (schema.additionalProperties === false || isRecord(schema.additionalProperties)) {
			for (const key of Object.keys(value)) {
				if (key in properties) continue;
				if (schema.additionalProperties === false) {
					errors.push(`${childPath(path, key)}: not allowed`);
				} else {
					checkSchema(schema.additionalProperties, value[key], childPath(path, key), errors, depth + 1);
				}
			}
		}
		if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
			errors.push(`${path}: must have at least ${schema.minProperties} properties`);
		}
		if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
			errors.push(`${path}: must have at most ${schema.maxProperties} properties`);
		}
	}
}

function passesSchema(schema: unknown, value: unknown): boolean {
	const errors: string[] = [];
	checkSchema(schema, value, "$", errors, 0);
	return errors.length === 0;
}

/**
 * Every way `value` fails `schema`, as sentences a retrying model can act on.
 * An empty list means the answer is good.
 */
export function validateWorkflowSchema(schema: WorkflowJsonSchema, value: unknown): string[] {
	const errors: string[] = [];
	checkSchema(schema, value, "$", errors, 0);
	return errors;
}

/**
 * The one shape check worth doing before any agent runs: a schema whose root
 * is not an object cannot describe the object a structured answer must be, so
 * agent() refuses it up front instead of failing once per call.
 */
export function checkWorkflowSchemaShape(schema: unknown): string | undefined {
	if (!isRecord(schema)) return "schema must be a JSON object";
	const type = schema.type;
	const isObjectRoot = type === undefined || type === "object" || (Array.isArray(type) && type.includes("object"));
	if (!isObjectRoot) return 'a workflow result schema must have type "object" at the root';
	if (isRecord(schema.properties) && Array.isArray(schema.required)) {
		for (const key of schema.required) {
			if (typeof key === "string" && !(key in schema.properties)) {
				return `required key "${key}" is not declared in properties`;
			}
		}
	}
	return undefined;
}

/**
 * Pull a JSON value out of a model's answer. Fenced blocks come first because
 * refusing a correct answer over its packaging teaches the model the wrong
 * lesson; the surrounding prose is only searched after the whole text fails.
 */
export function parseJsonValue(text: string): { value: unknown } | { error: string } {
	const trimmed = text.trim();
	if (trimmed === "") return { error: "the answer was empty" };
	const candidates: string[] = [];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced?.[1] !== undefined && fenced[1].trim() !== "") candidates.push(fenced[1].trim());
	candidates.push(trimmed);
	const first = trimmed.search(/[[{]/);
	const last = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
	if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			return { value: JSON.parse(candidate) };
		} catch {
			// Try the next extraction.
		}
	}
	return { error: "the answer was not valid JSON" };
}

/** The instruction appended to a subagent's prompt when a schema is requested. */
export function structuredAnswerInstruction(schema: WorkflowJsonSchema): string {
	return [
		"",
		"Your final answer must be a single JSON value that matches this JSON Schema:",
		JSON.stringify(schema),
		"Reply with the JSON value only — no prose, no Markdown fences.",
	].join("\n");
}
