/**
 * What the app can suggest after a provider failure the agent layer classified.
 *
 * The classification is `AssistantMessage.errorKind` — the agent decides that a
 * failure was a rate limit, an overload, an auth rejection or a window overflow,
 * because it is the layer that sees the wire. The remedy cannot live there: it
 * names `/model`, `/login` and `/compact`, and the agent package knows no
 * commands. Each host passes this function in as `AgentDeps.errorRemedy`, and
 * the agent's `agent_end` carries the answer beside the error.
 *
 * The wording is per kind and, for auth, per wire — the same split
 * {@link missingCredentialNotice} makes at startup: a failure on the ChatGPT or
 * Gemini wire is fixed by signing in, a failure on an env-keyed wire by
 * exporting the variable. Advice that names the wrong fix is worse than none.
 */

import { type AssistantMessage, apiKeyEnvNames, type Model } from "@labunbun/ai";

/** The kinds this host has something to say about. */
type ErrorKind = NonNullable<AssistantMessage["errorKind"]>;

/** The auth fix for one model, read from its wire the way the startup gate does. */
function authFix(model: Model): string {
	if (model.api === "chatgpt-responses") return "run /login chatgpt to sign in";
	if (model.api === "gemini-code-assist") return "run /login gemini to sign in";
	const keyNames = apiKeyEnvNames(model);
	if (keyNames.length > 0) return `set ${keyNames.join(" or ")} in the environment`;
	if (model.provider === "anthropic") return "run /login to sign in";
	// A keyless row cannot fail auth on a key it does not need; whatever reached
	// here is the endpoint refusing the session, so switching is the way out.
	return "switch models with /model";
}

/**
 * The sentence to print under `Error: <message>`, or undefined for a kind with
 * no action worth naming. Undefined is the common answer — an unclassified
 * failure already carries the provider's own words, and inventing advice for
 * it would be guessing.
 */
export function errorRemedy(kind: ErrorKind, model: Model): string | undefined {
	switch (kind) {
		case "rate_limit":
			return `${model.provider} is rate limiting ${model.id} — wait a moment and send again, or switch with /model.`;
		case "overload":
			return `${model.provider} is overloaded right now — send again in a moment, or switch with /model.`;
		case "auth":
			return `No valid credential for ${model.provider}/${model.id} — ${authFix(model)}.`;
		case "context_overflow":
			return "The conversation no longer fits this model's context window — run /compact to summarize it, or start a new session.";
		default:
			return undefined;
	}
}
