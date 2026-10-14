/**
 * Whether the machine can run a model at all — asked the way the request path
 * asks it, so the answer a display shows and the failure a request produces
 * cannot disagree.
 *
 * The environment is the easy half: `resolveApiKey` settles it. The half only
 * the credential stores can answer is a subscription sign-in, and the request
 * path already treats one as a stand-in for the anthropic key (the
 * `subscription` argument `missingApiKey` is called with). What was missing
 * was every *display* of that rule: the startup gate refused machines that had
 * signed in, `/model` and the beetle picker annotated rows a sign-in could run
 * with "no API key", and `/doctor` called a signed-in machine's Auth row a
 * failure. This module is that rule, in one place, for all four to read.
 *
 * The split of work is deliberate: {@link modelMayRun} is sync and takes the
 * sign-ins as a value — the beetle band resolves member models from a
 * constructor, where an await cannot reach. {@link detectSubscriptionSignIns}
 * is the async half, called by the surfaces that can afford a keychain read.
 */

import { apiKeyEnvNames, type Model, resolveApiKey } from "@labunbun/ai";
import { createChatGptCredentialStore } from "./chatgpt-auth.ts";
import { type ClaudeAuthOptions, createClaudeCredentialStore } from "./claude-auth.ts";

/** The two subscriptions this machine may hold; one entry per credential store. */
export interface SubscriptionSignIns {
	claude: boolean;
	chatgpt: boolean;
}

/**
 * Nothing signed in — the answer for every display given no stores to read.
 * A default rather than an error case: a caller that never asks must render
 * exactly what it rendered before subscriptions existed.
 */
export const NO_SIGN_INS: SubscriptionSignIns = Object.freeze({ claude: false, chatgpt: false });

/**
 * Read both stores, keychain-first, and report what is signed in.
 *
 * A test passes a throwaway `home` and `keychain: null` through `options` —
 * and must — because a probe that read the real keychain would report the
 * sign-in of whoever runs the tests, which is a different fact than whether
 * the code works.
 */
export async function detectSubscriptionSignIns(options: ClaudeAuthOptions = {}): Promise<SubscriptionSignIns> {
	const [claude, chatgpt] = await Promise.all([
		signedIn(createClaudeCredentialStore(options)),
		signedIn(createChatGptCredentialStore(options)),
	]);
	return { claude, chatgpt };
}

/** Whether a store holds anything; a missing or malformed file already answers null. */
async function signedIn(store: { load(): Promise<unknown> }): Promise<boolean> {
	return (await store.load()) !== null;
}

/**
 * Whether the machine can run this model, given what is signed in.
 *
 * Mirrors the request path's rule — `missingApiKey` with the subscription flag
 * the adapters are wired with here: a keyless row runs on its daemon, the
 * ChatGPT wire is subscription or nothing, and the Claude subscription stands
 * in for the anthropic key. Sync on purpose (see the module comment), so the
 * sign-ins arrive as a value and the caller decides how live they are.
 */
export function modelMayRun(model: Model, signIns: SubscriptionSignIns): boolean {
	// The ChatGPT wire names no environment variable by construction; being
	// signed in is the whole availability story.
	if (model.api === "chatgpt-responses") return signIns.chatgpt;
	if (apiKeyEnvNames(model).length === 0) return true;
	if (resolveApiKey(model)) return true;
	return model.provider === "anthropic" && signIns.claude;
}

/**
 * The one-cause annotation for a row that cannot run, or undefined when it
 * can. One cause, not a list: the row has one line, and it names the fix the
 * model's own wire would name. The wording is per wire because the fix is —
 * "no API key" on a row a sign-in would run was the lie this replaces, and
 * "no ChatGPT sign-in" on an env-keyed row would be the new one.
 */
export function unrunnableSuffix(model: Model, signIns: SubscriptionSignIns): string | undefined {
	if (modelMayRun(model, signIns)) return undefined;
	if (model.api === "chatgpt-responses") return "no ChatGPT sign-in";
	if (model.provider === "anthropic") return "no API key or sign-in";
	return "no API key";
}

/**
 * The startup line for a session whose model cannot run, or undefined when it
 * can. One line, because it is a notice and not a lecture: what is missing,
 * what will happen, and the ways out — sign in, or import a setup that
 * carries one. The wire decides which of the two is the real fix.
 */
export function missingCredentialNotice(model: Model, signIns: SubscriptionSignIns): string | undefined {
	if (modelMayRun(model, signIns)) return undefined;
	const fix =
		model.api === "chatgpt-responses"
			? "/login chatgpt to sign in"
			: model.provider === "anthropic"
				? "/login to sign in"
				: `Set ${apiKeyEnvNames(model).join(" or ")} in your environment`;
	return `No credential for ${model.provider}/${model.id} yet — the first prompt will fail. ${fix}, or /yoshi to import a setup.`;
}
