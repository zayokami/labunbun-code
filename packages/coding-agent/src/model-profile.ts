/**
 * Model profiles: the part of the prompt that changes with the model.
 *
 * Claude Code does not keep one persona per Claude model. Its per-model prompt
 * files share the same behavioural sections and differ mainly in the identity
 * line, the effort calibration, and which capabilities are wired. Anthropic's
 * own guidance for agent builders says the same thing: support a small set of
 * models with similar capability profiles rather than write a prompt per model.
 * This module is that shape at labunbun's scale — one profile per model family,
 * plus the few facts (window size, local daemon) that decide whether the short
 * prompt is the safer one.
 *
 * The base prompt in `system-prompt.ts` is still one text. A session that
 * passes no model emits exactly the bytes it did before profiles existed; a
 * session with a model gets a `# Model guidance` section whose contents are
 * resolved here. That keeps the adaptation additive and keeps an unknown
 * provider from silently losing the harness contract.
 *
 * Nothing here claims a capability the model row does not already carry.
 * Thinking shape, effort subsets, output limits and pricing stay on `Model`
 * (`packages/ai/src/types.ts`), where the wire adapters read them. A profile
 * only says how the harness should *talk* to the family: whether independent
 * tool calls may share a turn, which edit shape the family handles best, and
 * the short behavioural reminders that family needs.
 */
import type { Model } from "@labunbun/ai";

/**
 * The families the catalog actually serves. Gateways (`openrouter`, the two
 * OpenCode plans, Ollama's hosts) are not families: their rows carry a vendor
 * model id, so {@link inferModelFamily} reads the id before it reads the
 * provider and a gateway row lands in the family it is serving.
 */
export type ModelFamily =
	| "anthropic"
	| "openai"
	| "google"
	| "deepseek"
	| "kimi"
	| "qwen"
	| "glm"
	| "minimax"
	| "mistral"
	| "meta"
	| "tencent"
	| "xiaomi"
	| "nvidia"
	| "local"
	| "unknown";

/** Which prompt shape a session should use. `lean` is the short form. */
export type PromptVariant = "full" | "lean";

/** Whether a family takes independent tool calls in one turn. */
export type ToolCallStyle = "parallel" | "sequential";

/** The edit shape a family handles most reliably. */
export type EditStyle = "exact" | "whole-file";

export interface ModelProfile {
	family: ModelFamily;
	/** The family name as it appears in the prompt, e.g. "Claude". */
	label: string;
	variant: PromptVariant;
	toolCalls: ToolCallStyle;
	editStyle: EditStyle;
	/** Family-specific reminders, before the shared tool/edit lines. */
	guidance: readonly string[];
}

/** A model row, reduced to the fields a profile decision reads. */
export type ProfileModel = Pick<Model, "provider" | "id" | "contextWindow">;

interface FamilyProfile {
	label: string;
	toolCalls: ToolCallStyle;
	editStyle: EditStyle;
	guidance: readonly string[];
}

/**
 * Shared lines. The family-specific part stays short; these carry the rules
 * that are the same wherever they are true, so a family cannot quietly omit
 * one by copy-paste.
 */
const PARALLEL_TOOLS =
	"Batch independent read-only calls (Read, Grep, Glob) into one turn; wait whenever a call's arguments depend on an earlier result.";
const SEQUENTIAL_TOOLS = "Issue one tool call at a time and wait for its result before the next; do not batch calls.";
const EXACT_EDIT =
	"For edits, copy `old_string` verbatim and add enough surrounding lines to make the match unique; if Edit misses, re-read the file rather than guessing.";
const WHOLE_FILE_EDIT =
	"When an edit touches several parts of one file, Write the whole file instead of a series of Edits, and keep every unchanged byte identical.";

/**
 * The family table. Every entry is a prompt distinction with a reason, not a
 * description of the vendor's marketing: the guidance below names an observed
 * failure mode the base prompt does not already cover.
 */
const FAMILY_PROFILES = {
	anthropic: {
		label: "Claude",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Decide the approach for a non-trivial change before the first edit; keep that reasoning out of the final answer.",
			"When a tool call changes a file or runs a check, state the outcome in one sentence instead of restating the plan.",
		],
	},
	openai: {
		label: "GPT",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Keep the diff the deliverable: one focused change per Edit call, and do not rewrite code the task did not touch.",
			"Report a failed check with its actual output; a passing one gets one line.",
		],
	},
	google: {
		label: "Gemini",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Give every tool call complete arguments; never leave a placeholder or describe a call instead of making it.",
			"Combine independent reads in one turn, then act on the combined result.",
		],
	},
	deepseek: {
		label: "DeepSeek",
		toolCalls: "sequential",
		editStyle: "exact",
		guidance: [
			"Call tools directly; do not describe a call you have not made.",
			"Keep the reasoning separate from the final answer: state the conclusion, the change, and the check.",
		],
	},
	kimi: {
		label: "Kimi",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Use native tool calls with complete arguments; keep the final answer to the change and its verification.",
			"For a non-trivial change, decide the approach before editing rather than discovering it through failed calls.",
		],
	},
	qwen: {
		label: "Qwen",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Call tools directly; a plan belongs in tool calls, not in prose before them.",
			"Keep thinking out of the final answer: state the conclusion and the change.",
		],
	},
	glm: {
		label: "GLM",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Call tools directly and keep their arguments complete; do not narrate an action instead of taking it.",
			"Keep the final answer to the change and the check that exercised it.",
		],
	},
	minimax: {
		label: "MiniMax",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Call tools directly with complete arguments; do not leave a step as a description.",
			"Keep the final answer short; the diff and the check output carry the detail.",
		],
	},
	mistral: {
		label: "Mistral",
		toolCalls: "sequential",
		editStyle: "exact",
		guidance: [
			"Keep tool calls small and verify each result before the next.",
			"Call tools directly; do not put an action in prose where a call belongs.",
		],
	},
	meta: {
		label: "Meta",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Call tools directly with complete arguments; do not rely on prose to carry an action.",
			"Keep the final answer to the change and its verification.",
		],
	},
	tencent: {
		label: "Hunyuan",
		toolCalls: "sequential",
		editStyle: "exact",
		guidance: [
			"Keep edits small and verify each one before starting the next.",
			"Call tools directly; do not describe a call instead of making it.",
		],
	},
	xiaomi: {
		label: "MiMo",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Keep reasoning out of the final answer: state the conclusion and the change.",
			"Call tools directly with complete arguments; do not narrate an action instead of taking it.",
		],
	},
	nvidia: {
		label: "NVIDIA",
		toolCalls: "parallel",
		editStyle: "exact",
		guidance: [
			"Call tools directly with complete arguments; do not leave a step as a description.",
			"Keep the final answer to the change and the check that exercised it.",
		],
	},
	local: {
		label: "local",
		toolCalls: "sequential",
		editStyle: "whole-file",
		guidance: [
			"Keep one change in flight at a time: call one tool, read its result, then decide the next.",
			"Keep the plan in the tool calls themselves; a long description of intended work is not progress.",
		],
	},
	unknown: {
		label: "unknown",
		toolCalls: "sequential",
		editStyle: "whole-file",
		guidance: [
			"Call one tool at a time and use its actual result before deciding the next step.",
			"If an edit is not an exact match, re-read the file rather than guessing at its contents.",
		],
	},
} satisfies Record<ModelFamily, FamilyProfile>;

/** First-party provider ids, for the rows whose model id does not name a family. */
const PROVIDER_FAMILY: Record<string, ModelFamily> = {
	anthropic: "anthropic",
	openai: "openai",
	chatgpt: "openai",
	google: "google",
	gemini: "google",
	deepseek: "deepseek",
	kimi: "kimi",
	"kimi-cn": "kimi",
	"kimi-code": "kimi",
	"kimi-code-cn": "kimi",
	glm: "glm",
	minimax: "minimax",
	mistral: "mistral",
	meta: "meta",
	tencent: "tencent",
	xiaomi: "xiaomi",
};

/**
 * A vendor word, at an id boundary, optionally followed by its own version
 * digits: `qwen3:7b` and `llama3.2` are the family, not an unknown row. The
 * lookahead still refuses a word embedded in another (`chatgpt` must not be
 * read as `gpt`, so the leading boundary is checked first).
 */
function vendorPattern(names: string): RegExp {
	return new RegExp(`(^|[\\/:_-])(?:${names})(?=[\\d]|[\\/:_-]|$)`, "i");
}

/**
 * Id patterns, in priority order. The order matters where a name contains two
 * vendor words (`meta-llama`, `gpt-oss`): the earlier row owns it, and later
 * rows are deliberately narrow.
 */
const ID_PATTERNS: ReadonlyArray<readonly [RegExp, ModelFamily]> = [
	[vendorPattern("claude|sonnet|opus|haiku|fable|mythos"), "anthropic"],
	[vendorPattern("gpt|chatgpt|codex|gpt-oss"), "openai"],
	[/(^|[/:_-])o[1-9](-|$)/i, "openai"],
	[vendorPattern("gemini|gemma|palm"), "google"],
	[vendorPattern("deepseek"), "deepseek"],
	[vendorPattern("kimi|moonshot"), "kimi"],
	[vendorPattern("qwen|qwq"), "qwen"],
	[vendorPattern("glm|chatglm|zhipu"), "glm"],
	[vendorPattern("minimax|abab"), "minimax"],
	[vendorPattern("mistral|codestral|devstral|magistral|pixtral|ministral"), "mistral"],
	[vendorPattern("llama|meta-llama|muse"), "meta"],
	[vendorPattern("hunyuan|hy[34]"), "tencent"],
	[vendorPattern("mimo"), "xiaomi"],
	[vendorPattern("nemotron|nvidia"), "nvidia"],
];

/**
 * The family a row belongs to. The model id wins over the provider because a
 * gateway row's provider names the route, not the model — `openrouter` serving
 * `anthropic/claude-sonnet-5` is Claude. A first-party row whose id carries no
 * vendor word (`hy4`, `mimo-v2.6-pro`) falls back to its provider.
 */
export function inferModelFamily(model: Pick<Model, "provider" | "id">): ModelFamily {
	for (const [pattern, family] of ID_PATTERNS) {
		if (pattern.test(model.id)) return family;
	}
	return PROVIDER_FAMILY[model.provider] ?? (model.provider === "ollama" ? "local" : "unknown");
}

/** The parameter count an Ollama tag states, when it states one. */
function parameterSizeB(id: string): number | undefined {
	const mixture = /(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)b\b/i.exec(id);
	if (mixture) return Number(mixture[1]) * Number(mixture[2]);
	const single = /(\d+(?:\.\d+)?)b\b/i.exec(id);
	return single ? Number(single[1]) : undefined;
}

/**
 * Small windows and small local models get the short prompt. The window test
 * covers a discovered row whose model no family table knows; the Ollama test
 * covers the catalog's own names (`qwen3:7b`), where the window is not the
 * problem but the model's capacity for a long harness contract is. A local row
 * with no stated size is treated as small: the tag is the only evidence, and
 * guessing "large" from silence is the more expensive mistake.
 */
function isLean(model: ProfileModel): boolean {
	if (model.contextWindow > 0 && model.contextWindow < 32_000) return true;
	if (model.provider !== "ollama") return false;
	const size = parameterSizeB(model.id);
	return size === undefined || size <= 14;
}

/**
 * Resolve a model to its prompt profile. Pure, and total: every row gets a
 * profile, so a caller never has to branch on "known or not".
 */
export function resolveModelProfile(model: ProfileModel): ModelProfile {
	const family = inferModelFamily(model);
	const profile = FAMILY_PROFILES[family];
	if (!isLean(model)) return { ...profile, family, variant: "full" };
	// A model small enough for the short prompt is small enough that a batch of
	// parallel calls and an exact-match edit are both optimistic. The lean
	// variant therefore also pins the conservative tool and edit shapes, even
	// when the family table says otherwise: a 7B Qwen row is still a 7B model.
	return { ...profile, family, variant: "lean", toolCalls: "sequential", editStyle: "whole-file" };
}

/**
 * The `# Model guidance` section, or undefined when there is no model to
 * describe. The identity line is first because it is the one fact the model
 * cannot infer from the conversation; the shared tool/edit lines follow the
 * family's own reminders so the generic rule is the last thing read.
 */
export function modelGuidanceSection(model: ProfileModel, profile: ModelProfile): string | undefined {
	const lines = [
		`Current model: \`${model.provider}/${model.id}\` (${profile.label}).`,
		...profile.guidance,
		profile.toolCalls === "parallel" ? PARALLEL_TOOLS : SEQUENTIAL_TOOLS,
		profile.editStyle === "exact" ? EXACT_EDIT : WHOLE_FILE_EDIT,
	];
	// An unknown family has no identity worth stating and no behaviour to tune;
	// the generic tool/edit lines would be the only content. Emitting a section
	// that says "Current model: unknown" would spend prompt tokens on the one
	// thing the model already knows from the request.
	if (profile.family === "unknown") return undefined;
	return `# Model guidance\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
