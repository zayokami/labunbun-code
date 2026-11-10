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
 * would cost correctness, so silence stays standard. A negated verb is not a
 * request: "don't change anything, explain it" is an answer, while "don't
 * forget to change it" is still a change.
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

/**
 * The English verbs, kept as source so the negating reader below can compile
 * its own global copy. Gerunds are included because that is the form a negation
 * takes: "without changing the API".
 */
const CHANGE_VERB_EN =
	"fix|add|implement|refactor|rewrite|rename|update|remove|delete|change|write|create|make|build|migrate|upgrade|replace|adjust|tweak|move|split|merge|port|bump|wire|support|adapt|edit|modify|patch|apply|introduce|extract|inline|changing|editing|modifying|patching|renaming|updating|adding|removing|deleting|refactoring|rewriting";

/** The Chinese verbs. `改`, `修`, `加`, `删` and `补` are listed bare because a Chinese verb is not space-delimited. */
const CHANGE_VERB_ZH =
	"修复|修改|改成|改为|改一下|改下|添加|增加|实现|重构|重写|迁移|升级|替换|调整|删除|移除|创建|新建|写一个|写个|加上|加个|支持|接入|合并|拆|适配|对接|修|加|删|补";

/** The same pattern with `g`, for walking every occurrence; `test` on a `g` pattern would carry `lastIndex`. */
const CHANGE_VERB_ALL = new RegExp(`\\b(?:${CHANGE_VERB_EN})\\b|(?:${CHANGE_VERB_ZH})`, "giu");

/**
 * A negation that ends the text just before a change verb.
 *
 * English allows up to two words between the negation and the verb ("without
 * ever changing"), Chinese takes one of the common particles ("不要再改").
 * `别` is deliberately narrow: a bare match would also hit `区别`, so a
 * non-negation character after it cancels the match.
 */
const NEGATION_BEFORE =
	/(?:\b(?:do not|not|don't|dont|never|without|no need to|avoid)\b(?:\s+[a-z]+){0,2}|(?:不要|别|无需|不用|不需要|不必|勿)(?:再|去|乱|随便)?)\s*$/iu;

/** "change nothing" negates from the other side. Kept to unambiguous objects. */
const NEGATION_AFTER = /^\s*(?:nothing|no files?|no code|none of)\b/iu;

const ANSWER_VERB =
	/\b(?:explain|describe|summari[sz]e|review|analy[sz]e|compare|list|show|tell|find|search|grep|locate|trace|look|check|investigate|diagnose|assess)\b|(?:解释|说明|分析|对比|列出|看看|看下|查查|查下|查一下|找一下|检查|调查|诊断|评估|总结|介绍|说说|讲讲)/iu;

/** A leading interrogative, a trailing question mark, or both. */
const QUESTION_SHAPE =
	/^\s*(?:what|why|how|where|when|who|which|whose|does|do|did|is|are|was|were|can|could|should|would|will|has|have|explain|describe|list|show|tell|find|please)\b|^\s*(?:为什么|怎么|如何|哪|什么|是否|能否|可以|请问|解释|说明|列出|看看)|[?？]\s*$/iu;

/**
 * A question that asks for advice or an explanation, even when it names a
 * change. "Should I refactor this?" carries the verb `refactor` but asks what
 * to do, not for the refactor; reading it as a broad change would attach a plan
 * the user did not request. "Can you fix it?" is the opposite — a request —
 * and is not matched here.
 */
const ADVICE_QUESTION =
	/^\s*(?:how (?:do|does|did|should|would|can|could) (?:i|we|you|it)\b|how to\b|what(?:'s| is) the (?:best|right|proper|usual) way\b|what would you (?:recommend|suggest)\b|should (?:i|we)\b|is it (?:worth|better|a good idea)\b|why\b|where\b|which\b|who\b)|^\s*(?:怎么|怎样|如何|为什么|为何|哪(?:里|个|些)?|什么|要不要|该不该|值不值得|值得|你觉得|你认为)/iu;

/**
 * A second-person or polite request. It is what tells "fix it?" — a request
 * wearing a question mark — apart from "why did it fail?" — a question that
 * happens to name a verb. A sentence-initial change verb counts too
 * ("…? fix it."), which is why the caller checks the position of each match.
 */
const REQUEST_SHAPE =
	/^\s*(?:please\b|can you\b|could you\b|would you\b|will you\b|help me\b|能否|能不能|可以帮|帮我|帮忙|麻烦|请(?!问))/iu;

/** The explicit "this is small" cues. Alone they are enough for `trivial`. */
const EXPLICIT_SMALL =
	/\b(?:just|only|quick(?:ly)?|tiny|small|simple|minor|trivial|one[- ]liner|one line|typo|nit|tweak)\b|(?:简单|只需|只要|只改|只加|只删|只动|只碰|只调整|小改|一行|顺手|稍微|微调|小修|小问题)/iu;

/** The scope words that make a request broad regardless of how short it is. */
const EXPLICIT_LARGE =
	/\b(?:all|every|each|entire|whole|across|throughout|everything|everywhere|all of|codebase|project-?wide|system-?wide|refactor|rewrite|redesign|overhaul|migrat(?:e|ion)|architecture|audit|comprehensive|end-to-end)\b|(?:所有|全部|每个|整个|全项目|代码库|全面|整体|重构|重写|迁移|架构|审计|彻底|端到端|一切|每处|各处)/iu;

/** The same scope words with `g`, so a negated clause can be passed over. */
const EXPLICIT_LARGE_ALL = new RegExp(EXPLICIT_LARGE.source, "giu");

/** Anything URL-shaped, so a documentation link is not counted as a file the request names. */
const URL_TOKEN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;

/** File-ish tokens, so "three paths" can be counted without a filesystem. Both separators count. */
const PATH_TOKEN =
	/\b[\w@.~-]+(?:[\\/][\w@.~-]+)+\b|\b[\w-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|rb|php|cs|c|cc|cpp|h|hpp|json|jsonc|md|mdx|ya?ml|toml|css|scss|sass|less|html|sh|ps1|bat|lua|sql)\b/giu;

/** Words plus half the CJK characters: Chinese says in one character what English says in a syllable. */
function sizeOf(text: string): number {
	const cjk = text.match(/[㐀-鿿豈-﫿]/gu)?.length ?? 0;
	const words = text.trim().split(/\s+/u).filter(Boolean).length;
	return words + Math.ceil(cjk / 2);
}

/** "Remember to …" and "don't forget to …" end a negation rather than start one. */
const NEGATION_CANCEL = /\b(?:forget|remember)\s+(?:to\s+)?$|忘(?:了)?\s*$/iu;

/** Distinct path-shaped tokens, URLs excluded. */
function countPaths(text: string): number {
	const seen = new Set<string>();
	for (const match of text.replace(URL_TOKEN, " ").matchAll(PATH_TOKEN)) {
		seen.add(match[0].toLowerCase());
	}
	return seen.size;
}

/** Whether the verb at `index` is negated by the words around it. */
function negatedAt(text: string, index: number, length: number): boolean {
	const before = text.slice(Math.max(0, index - 48), index);
	if (NEGATION_CANCEL.test(before)) return false;
	const after = text.slice(index + length, index + length + 24);
	return NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after);
}

/** Whether the verb at `index` opens its sentence, which is the shape an imperative takes. */
function isSentenceInitial(text: string, index: number): boolean {
	const before = text.slice(0, index);
	return /^\s*$/u.test(before) || /[.!?;。！？；]\s*$/u.test(before);
}

/**
 * A change clause after "first, then" / "先…然后".
 *
 * The connector alone is not enough: "why did you then change it?" is a
 * question about the past, while "explain first, then fix it" is a two-step
 * request. A preceding comma or `first`/`先` is what separates them.
 */
function isLaterRequest(text: string, index: number): boolean {
	const before = text.slice(Math.max(0, index - 48), index);
	const connector = before.match(/(?:\bthen\b|然后|接着|之后|再)\s*$/iu);
	if (!connector) return false;
	const head = before.slice(0, connector.index);
	return /\bfirst\b|先|首先/iu.test(head) || /[，,；;]\s*$/u.test(head);
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
	const advice = ADVICE_QUESTION.test(trimmed);
	const changeMatches = [...trimmed.matchAll(CHANGE_VERB_ALL)];
	const positive = changeMatches.filter((match) => !negatedAt(trimmed, match.index ?? 0, match[0].length));
	const changeVerb = positive.length > 0;
	const imperative = positive.some((match) => isSentenceInitial(trimmed, match.index ?? 0));
	const later = positive.some((match) => isLaterRequest(trimmed, match.index ?? 0));
	const request = REQUEST_SHAPE.test(trimmed) || imperative || later;
	const broad = [...trimmed.matchAll(EXPLICIT_LARGE_ALL)].some(
		(match) => !negatedAt(trimmed, match.index ?? 0, match[0].length),
	);
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
	if (broad) {
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

	if (question || advice) signals.push("question");
	if (advice) signals.push("advice-question");
	if (request) signals.push("request");
	if (changeVerb) signals.push("change-verb");
	else if (answerVerb) signals.push("answer-verb");
	if (!changeVerb && changeMatches.length > 0) signals.push("negated-change");

	const kind: TaskKind =
		(advice && !imperative && !later) || (changeVerb ? question && !request : question || answerVerb)
			? "answer"
			: "change";
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
 * skipped — they land mid-run and are as often a harness nudge as a user
 * correction, so one must not choose the effort for a run already under way —
 * and a `LBB_TASK_SCALE=off` in the environment turns the whole feature off
 * without changing the prompt bytes or the effort.
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
