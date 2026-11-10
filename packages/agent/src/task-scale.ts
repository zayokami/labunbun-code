/**
 * Task scale: how much process a request has earned.
 *
 * A coding agent can fail by doing too little, but the failure users report
 * most is the other one: a full suite run for a one-line fix, a plan for a
 * rename, fallbacks and compatibility shims nobody asked for, or a question
 * answered with an edit. Codex's own issue tracker records the pattern at
 * length — stubs and fallbacks presented as working code
 * ([#6587](https://github.com/openai/codex/issues/6587)), and self-generated
 * governance and review loops that grow past the task and consume the budget
 * ([#34898](https://github.com/openai/codex/issues/34898)). The workaround the
 * community converges on is the same every time: say up front how big the job
 * is.
 *
 * This module is the deterministic half of that answer. It is a pure function
 * from the user's words to a scale and a kind, the short contract that follows
 * from them, and the one effort the request should be answered at. No model
 * call, no clock, no provider, so every decision can be read back in a test.
 *
 * Conservative by construction. `trivial` needs evidence — an explicit
 * "just"/"quick"/"typo"/"只改" — and `complex` needs scope evidence — a
 * all/every/whole, refactor/migrate/audit, or three file paths. Everything else
 * is `standard`, which adds no text and changes no effort. A wrong guess
 * toward trivial costs a check; a classifier that read silence as trivial
 * would cost correctness, so silence stays standard.
 *
 * Long-form design notes: docs/dev/task-scale.md
 */
import type { ThinkingLevel } from "@labunbun/ai";
import type { UserMessageOrigin } from "./types.ts";

/** The three process sizes a change request can have. */
export const TASK_SCALE_VALUES = ["trivial", "standard", "complex"] as const;
export type TaskScale = (typeof TASK_SCALE_VALUES)[number];

/** Whether the request asks for an answer or for a change to the tree. */
export type TaskKind = "answer" | "change";

export interface TaskShape {
	readonly kind: TaskKind;
	readonly scale: TaskScale;
	/** The signals that decided it, in a stable order: what a test asserts, and what a notice could show. */
	readonly signals: readonly string[];
}

const CHANGE_VERB =
	/\b(?:fix|add|implement|refactor|rewrite|rename|update|remove|delete|change|write|create|make|build|migrate|upgrade|replace|adjust|tweak|move|split|merge|port|bump|wire|support|adapt)\b|(?:修复|修改|改成|改为|改一下|改下|添加|增加|实现|重构|重写|迁移|升级|替换|调整|删除|移除|创建|新建|写一个|写个|加上|加个|支持|接入|合并|拆|适配|对接|改)/iu;

const ANSWER_VERB =
	/\b(?:explain|describe|summari[sz]e|review|analy[sz]e|compare|list|show|tell|find|look|check|investigate|diagnose|assess)\b|(?:解释|说明|分析|对比|列出|看看|看一下|查查|查一下|找一下|检查|调查|诊断|评估|总结)/iu;

/** A leading interrogative, a trailing question mark, or both. */
const QUESTION_SHAPE =
	/^\s*(?:what|why|how|where|when|who|which|whose|does|do|did|is|are|was|were|can|could|should|would|will|has|have|explain|describe|list|show|tell|find|please)\b|^\s*(?:为什么|怎么|如何|哪|什么|是否|能否|可以|请问|解释|说明|列出|看看)|[?？]\s*$/iu;

/** The explicit "this is small" cues. Alone they are enough for `trivial`. */
const EXPLICIT_SMALL =
	/\b(?:just|only|quick(?:ly)?|tiny|small|one[- ]liner|one line|typo|nit|tweak)\b|(?:简单|只需|只要|只改|只加|只删|小改|一行|顺手|稍微|微调|小修|小问题)/iu;

/** The scope words that make a request broad regardless of how short it is. */
const EXPLICIT_LARGE =
	/\b(?:all|every|each|entire|whole|across|throughout|codebase|project-?wide|system-?wide|refactor|rewrite|redesign|overhaul|migrat(?:e|ion)|architecture|audit|comprehensive|end-to-end)\b|(?:所有|全部|每个|整个|全项目|代码库|全面|整体|重构|重写|迁移|架构|审计|彻底|端到端)/iu;

/** File-ish tokens, so "three paths" can be counted without a filesystem. */
const PATH_TOKEN =
	/\b[\w@.-]+(?:\/[\w@.-]+)+\b|\b[\w-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|json|jsonc|md|mdx|ya?ml|toml|css|scss|sass|less|html|sh|ps1|bat|lua|sql)\b/giu;

/** Words plus half the CJK characters: Chinese says in one character what English says in a syllable. */
function sizeOf(text: string): number {
	const cjk = text.match(/[㐀-鿿豈-﫿]/gu)?.length ?? 0;
	const words = text.trim().split(/\s+/u).filter(Boolean).length;
	return words + Math.ceil(cjk / 2);
}

/** Distinct path-shaped tokens, URLs excluded. */
function countPaths(text: string): number {
	const seen = new Set<string>();
	for (const match of text.matchAll(PATH_TOKEN)) {
		const token = match[0];
		if (!token.includes("://")) seen.add(token.toLowerCase());
	}
	return seen.size;
}

/**
 * Classify one user request.
 *
 * The scoring is deliberately small enough to read in one sitting: explicit
 * small cues subtract, scope evidence adds, and the thresholds keep a short
 * request *standard* unless it also said it was small. The returned `signals`
 * are stable names rather than offsets, so a caller can tell why a request was
 * read the way it was without re-running the regexes.
 */
export function classifyTask(text: string): TaskShape {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { kind: "change", scale: "standard", signals: ["empty"] };

	const size = sizeOf(trimmed);
	const paths = countPaths(trimmed);
	const question = QUESTION_SHAPE.test(trimmed);
	const changeVerb = CHANGE_VERB.test(trimmed);
	const answerVerb = ANSWER_VERB.test(trimmed);

	let score = 0;
	const signals: string[] = [];

	if (EXPLICIT_SMALL.test(trimmed)) {
		score -= 3;
		signals.push("explicit-small");
	}
	if (size <= 12) {
		score -= 1;
		signals.push("short");
	}
	if (EXPLICIT_LARGE.test(trimmed)) {
		score += 4;
		signals.push("explicit-large");
	}
	if (size >= 60) {
		score += 2;
		signals.push("long");
	}
	if ((trimmed.match(/[.!?;。！？；]/gu)?.length ?? 0) >= 4) {
		score += 1;
		signals.push("many-sentences");
	}
	if (paths >= 3) {
		score += 4;
		signals.push("several-paths");
	}

	if (question) signals.push("question");
	if (changeVerb) signals.push("change-verb");
	else if (answerVerb) signals.push("answer-verb");

	const kind: TaskKind = !changeVerb && (question || answerVerb) ? "answer" : "change";
	const scale: TaskScale = score >= 3 ? "complex" : score <= -2 ? "trivial" : "standard";
	return { kind, scale, signals };
}

/**
 * The contract a non-standard shape is worth one paragraph of prompt for.
 *
 * `standard` returns undefined on purpose: the base prompt already says what
 * to do, and a block that repeats it on every ordinary request is the prompt
 * bloat this feature exists to avoid.
 */
export function taskScaleContract(shape: TaskShape): string | undefined {
	const body =
		shape.kind === "answer"
			? "This is a question, not a change request. Answer from what you read; do not edit files, run builds or tests, or start work the question did not ask for."
			: shape.scale === "trivial"
				? "This is a small, contained change. Do not plan, delegate, or widen the search. Make the smallest edit that works and run the single check that covers it. Add no tests, docs, or defensive handling the request did not ask for."
				: shape.scale === "complex"
					? "This is a broad change. Read the affected areas first, state a short plan before the first edit, and make the change in one focused pass. Run the project checks that cover it, then stop: no audit, review, refactor, or extra hardening beyond the request."
					: undefined;
	if (!body) return undefined;
	return `<task-scale scale="${shape.scale}" kind="${shape.kind}">\n${body}\n</task-scale>`;
}

/** Wrap a raw user message with its contract, for a caller composing without the state object. */
export function composeTaskScale(text: string, shape: TaskShape): string {
	const block = taskScaleContract(shape);
	return block ? `${block}\n\n---\n\n${text}` : text;
}

/**
 * Remove the contract from a stored user message.
 *
 * The block is machine guidance, not something the user typed, so the
 * transcript rebuild, the resume preview and the Markdown export all strip it.
 * Only the prefix our own composition writes is removed; text the user wrote
 * later in the message is untouched.
 */
const TASK_SCALE_PREFIX = /^<task-scale\b[^>]*>\n[\s\S]*?\n<\/task-scale>\n\n---\n\n/u;
export function stripTaskScale(text: string): string {
	return text.replace(TASK_SCALE_PREFIX, "");
}

/**
 * The effort a shape should be answered at, or undefined to leave the model's
 * own default in place.
 *
 * Trivial work gets `low` and broad work gets `high`; the rungs above `high`
 * stay a user choice, because the vendor pages that name them do not promise
 * they help, and the community guidance on agents is consistent that blanket
 * depth burns budget without buying accuracy. A question keeps the default:
 * "why does this fail" is cheap to ask and not always cheap to answer.
 */
export function taskScaleThinkingLevel(shape: TaskShape | undefined): ThinkingLevel | undefined {
	if (!shape || shape.kind === "answer") return undefined;
	if (shape.scale === "trivial") return "low";
	if (shape.scale === "complex") return "high";
	return undefined;
}

export interface TaskCalibration {
	/** Compose one stored user message, and remember the shape for the effort reader. */
	compose(storedText: string, userText: string, origin: UserMessageOrigin): string;
	/** The effort for the next request; a level the user chose wins over the classification. */
	level(pinned: ThinkingLevel | undefined): ThinkingLevel | undefined;
	/** The shape of the latest prompt, for a host that wants to show or log it. */
	current(): TaskShape | undefined;
}

/**
 * The small state object a host holds for one session.
 *
 * `compose` runs at the one moment a user message is created, which is also
 * before the first request of the run: the effort reader therefore has the
 * run's shape by the time the adapter asks for it. Steering messages are
 * skipped — they are the harness talking to the model, not a new task — and a
 * `LBB_TASK_SCALE=off` in the environment turns the whole feature off without
 * changing the prompt bytes or the effort.
 */
export function createTaskCalibration(
	options: { env?: { LBB_TASK_SCALE?: string | undefined } } = {},
): TaskCalibration {
	const disabled = options.env?.LBB_TASK_SCALE?.trim().toLowerCase() === "off";
	let shape: TaskShape | undefined;
	return {
		compose(storedText, userText, origin) {
			if (disabled || origin === "steer") return storedText;
			shape = classifyTask(userText);
			return composeTaskScale(storedText, shape);
		},
		level(pinned) {
			return pinned ?? taskScaleThinkingLevel(shape);
		},
		current() {
			return shape;
		},
	};
}
