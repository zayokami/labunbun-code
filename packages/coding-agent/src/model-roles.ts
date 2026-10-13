/**
 * Model roles: which model each seat of a session runs on, resolved fail-soft.
 *
 * The session is not one model. The main conversation answers, plan mode
 * designs, compaction summarizes, subagents research, and a local seat is a
 * possibility the catalog already contains — and each of those wants its own
 * provider, model and fallback order. `settings.roles` names them; this module
 * turns the settings into resolved models, and turns those into the fallback
 * chains the stream pipeline walks.
 *
 * Resolution follows the compaction resolver's rule (`compaction-wiring.ts`):
 * an unknown reference or a model whose key is missing warns on stderr and
 * leaves the role on the host's own default. A role is a convenience, and a
 * convenience that stops the app is worse than one that does not apply.
 *
 * The reference syntax is the session model's, read from `resolveModel` in
 * `packages/ai/src/model.ts` and pinned here:
 *
 * - `model` alone is resolved verbatim, exactly like `settings.model` — a bare
 *   id names its vendor only (a bare id never resolves to a gateway row), and a
 *   `provider/model` string splits at its first slash.
 * - `provider` together with `model` builds `provider/model`: the provider is
 *   the serving side, the model the id it serves the model under. Its ids may
 *   contain slashes of their own — OpenRouter serves `deepseek/deepseek-chat` —
 *   which is why the serving side has to be nameable at all.
 * - `provider` without `model` names nothing: the entry warns and is ignored.
 */

import { type Model, missingApiKey, resolveModel } from "@labunbun/ai";
import type { Settings } from "./settings.ts";

/** The seats a session has. The order is the order warnings come out in. */
export const ROLE_NAMES = ["main", "plan", "compaction", "light", "local"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** What a role resolved to. An absent model leaves the host's own default in place. */
export interface RoleResolution {
	model?: Model;
	/**
	 * The role's own fallback models, in order, minus any that did not resolve.
	 * Hosts append the global `fallbackModels` after them; both lists reach the
	 * pipeline through {@link roleOrder}.
	 */
	fallback: Model[];
}

export interface ResolvedRoles {
	main: RoleResolution;
	plan: RoleResolution;
	compaction: RoleResolution;
	light: RoleResolution;
	local: RoleResolution;
	/** One line per role value that could not be honoured, prefixed "Warning: ". */
	warnings: string[];
}

export type RoleSettings = NonNullable<Settings["roles"]>;

/** What a role falls back to when its own value cannot be used, said per role. */
const ROLE_DEFAULT_SENTENCE: Record<RoleName, string> = {
	main: "the built-in default model will be used",
	plan: "plan mode will keep the session's model",
	compaction: "the session's model will write summaries",
	light: "subagents will run on the session's model",
	local: "the local role stays unset",
};

/** The reference an entry names, in the syntax `resolveModel` accepts. */
function refFor(entry: { provider?: string; model: string }): string {
	return entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
}

/**
 * `settings.roles`, resolved once at startup.
 *
 * The refresh callback is the host's second look for the same reason it is in
 * `resolveCompactionSummarizer`: a reference nothing matched yet may be one a
 * provider is about to name — the local daemon's loadout exists only in its own
 * answer — and waiting on a catalog belongs to the host, not here.
 *
 * Fallback references get no warning and no refresh: an unresolvable entry in
 * the list is dropped in silence, exactly as `settings.fallbackModels` has
 * always been handled, because a longer safety net that could not be woven
 * should not turn into startup noise.
 */
export async function resolveRoles(
	roles: RoleSettings | undefined,
	refreshCatalog: () => Promise<unknown> | undefined,
): Promise<ResolvedRoles> {
	const resolved: ResolvedRoles = {
		main: { fallback: [] },
		plan: { fallback: [] },
		compaction: { fallback: [] },
		light: { fallback: [] },
		local: { fallback: [] },
		warnings: [],
	};
	if (!roles) return resolved;

	for (const name of ROLE_NAMES) {
		const entry = roles[name];
		if (!entry) continue;
		const fallbackSentence = ROLE_DEFAULT_SENTENCE[name];
		if (!entry.model) {
			resolved.warnings.push(
				`Warning: roles.${name} sets no model${entry.provider ? ` (only a provider)` : ""} — ignored; ${fallbackSentence}.`,
			);
			continue;
		}
		const ref = refFor({ provider: entry.provider, model: entry.model });
		let model = resolveModel(ref);
		if (!model) {
			await refreshCatalog();
			model = resolveModel(ref);
		}
		if (!model) {
			resolved.warnings.push(`Warning: unknown model "${ref}" for roles.${name} — ${fallbackSentence}.`);
			continue;
		}
		// Checked here rather than left to the first request: the main role's key
		// is checked at startup anyway, and a light or plan role that only fails
		// when it is first used would present as a request error, not a settings
		// mistake — the same reasoning the compaction resolver documents.
		const missing = missingApiKey(model);
		if (missing) {
			resolved.warnings.push(
				`Warning: ${missing.message} — ${fallbackSentence}.\nExample: export ${missing.envNames[0]}=sk-...`,
			);
			continue;
		}
		const fallback: Model[] = [];
		for (const ref of entry.fallback ?? []) {
			const candidate = resolveModel(ref);
			if (candidate && !missingApiKey(candidate)) fallback.push(candidate);
		}
		resolved[name] = { model, fallback };
	}
	return resolved;
}

/** Two rows the same model, by the identity `resolveModel` guarantees. */
export function sameModel(a: Model, b: Model): boolean {
	return a.id === b.id && a.provider === b.provider;
}

/**
 * One role's ordered candidates: its model first, then its own fallbacks, then
 * the global `fallbackModels` as the outer net every role shares — an existing
 * `fallbackModels` keeps working untouched beside a role's own list, and the
 * role's list is the more specific ask, so it runs first. Duplicates keep their
 * first position.
 */
export function roleOrder(model: Model, roleFallbacks: Model[], globalFallbacks: Model[]): Model[] {
	const order: Model[] = [model];
	for (const candidate of [...roleFallbacks, ...globalFallbacks]) {
		if (!order.some((existing) => sameModel(existing, candidate))) order.push(candidate);
	}
	return order;
}

/**
 * The `resolveChain` the pipeline calls, fixed to use its parameter.
 *
 * `withModelFallback` hands the failing model in and walks what comes back; the
 * hosts used to hand back one fixed list whatever the parameter said, so a
 * model's fallback could land back on the model that had just failed. The
 * descent rule here is: whichever order owns the failing model is walked from
 * *below* that position. Ownership is checked in two passes — first the orders
 * whose primary seat is the failing model (a primary is where the model is
 * supposed to run, so its rungs win), then membership anywhere in an order. A
 * chain only descends: it never climbs back to a candidate that outranks the
 * model that just failed, because a session moved to a lower rung on purpose
 * (a `/model` swap, a plan-mode seat) must not be dragged back up by another
 * rung's failure.
 *
 * A model no order names — one resolved from an agent definition's own
 * frontmatter, say — gets the global list alone: the safety net is shared, the
 * role-specific rungs are not guessed at.
 */
export function createModelChainResolver(orders: Model[][], globalFallbacks: Model[]): (model: Model) => Model[] {
	return (model) => {
		for (const order of orders) {
			if (order.length > 0 && sameModel(order[0], model)) return order.slice(1);
		}
		for (const order of orders) {
			const index = order.findIndex((candidate) => sameModel(candidate, model));
			if (index !== -1) return order.slice(index + 1);
		}
		return globalFallbacks.filter((candidate) => !sameModel(candidate, model));
	};
}
