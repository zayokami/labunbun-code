/**
 * Which models this app is willing to offer, and what it says about the one that
 * is offered anyway.
 *
 * Lifted out of `interactive.ts` for the reason `unknownModelMessage` was: both
 * of these are claims about what a user will see, and a claim that lives inside a
 * closure holding seven bindings is a comment rather than something the suite can
 * hold. `switchModel` holds six bindings and a TUI handle; a test can neither
 * call it nor read what it decided.
 */
import { listModels, type Model } from "@labunbun/ai";

/**
 * Every model a session may be pointed at, minus the ones that cannot act.
 *
 * Filtered rather than greyed out. The picker answers "what can work on my
 * request", and a row that will answer but not act is not an answer to that — and
 * a greyed row is a row whose reason has to be read before it is understood.
 * The row still resolves by name, so this removes it from a menu rather than from
 * the catalog; see {@link noToolCallingNotice} for what happens when a user asks
 * for it anyway.
 */
export function offeredModels(): Model[] {
	return listModels().filter((model) => model.toolCalling !== false);
}

/**
 * The warning for a model that cannot call tools on the wire it is registered on.
 *
 * One sentence, and it has to carry the reason rather than the symptom: "it will
 * not act" alone is a bug report waiting to happen, and this is the difference
 * between a vendor publishing its function calling on another endpoint and the
 * adapter having dropped the tools.
 */
export function noToolCallingNotice(model: Model): string {
	return `${model.provider}/${model.id} cannot call tools on the wire it is registered on — it will answer, but it will not act.`;
}
