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
 * An entry may also state `budgetUSD`: a ceiling on what that seat's
 * conversation may spend. The rule for when a ceiling has been reached lives
 * here ({@link budgetVerdict}) and so does the lookup a host builds once
 * ({@link seatsByRef}), so the REPL, a `-p` run and an editor session cannot
 * disagree about when a seat is over its budget.
 *
 * One seat has no consumer: `local` resolves like the others and then warns
 * that no feature reads it yet, because a seat that looks wired and answers
 * nothing should say so at startup rather than be discovered by absence.
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
	/**
	 * `roles.<role>.budgetUSD`, when the entry stated one.
	 *
	 * It rides the resolution rather than the raw settings because the two are
	 * one decision: an entry whose model did not resolve is ignored whole, and a
	 * budget that survived that would be a ceiling on a seat that never runs —
	 * which reads as enforcement and is none. An entry that resolved carries its
	 * budget, and a seat that did not run has nothing to enforce it against.
	 */
	budgetUSD?: number;
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
		resolved[name] = { model, fallback, budgetUSD: entry.budgetUSD };
	}
	// The local seat has no consumer: no host reads `resolved.local` — the role
	// orders are built from the other four — so a configured one is a seat that
	// looks wired and answers nothing. Said out loud once, at startup, because
	// the alternative is silence that reads as "the local daemon is handling
	// this". The check reads the raw entry, not the resolution: a local seat
	// that resolved perfectly is still unconsumed, and a user who fixes a bad
	// reference should not have to discover that second fact by reading source.
	if (roles.local?.model !== undefined || roles.local?.provider !== undefined) {
		resolved.warnings.push("Warning: roles.local is configured, but no feature consumes a local seat yet.");
	}
	return resolved;
}

/** Two rows the same model, by the identity `resolveModel` guarantees. */
export function sameModel(a: Model, b: Model): boolean {
	return a.id === b.id && a.provider === b.provider;
}

/**
 * A seat's spending ceiling, in the form its consumers pass around: the role's
 * name — which the refusal sentence owes the reader, because it is the settings
 * key they have to go and change — and `roles.<role>.budgetUSD` when the entry
 * stated one.
 *
 * A seat with no `budgetUSD` is law-abiding by construction, which is what lets
 * a host keep one table of every seat instead of branching around the ones that
 * have no ceiling: {@link budgetVerdict} answers `ok` for them.
 */
export interface RoleBudget {
	role: RoleName;
	budgetUSD?: number;
}

/** The judge's answer. `blocked` carries the sentence a host ends the run with. */
export type BudgetVerdict = { action: "ok" } | { action: "blocked"; message: string };

/**
 * Did a seat spend past its ceiling?
 *
 * Two rules, both deliberate:
 *
 * - **A seat with no budget is ok.** Unset `budgetUSD` is the pre-budget
 *   behaviour, and a check that blocked there would end runs nobody asked it
 *   to end.
 * - **The comparison is strict**: spending exactly the budget is not over it.
 *   The rule beetle's `maxCostUSD` uses, and for the same reason — a ceiling
 *   is a limit, and a run that has spent exactly its limit has not crossed
 *   anything. The next spend crosses it, and the check that runs before that
 *   spend is where the refusal belongs, so a run is never cut off a fraction
 *   under the number its user wrote.
 *
 * `spentUSD` is the number the caller vouches for, and it is *the seat's* spend:
 * for a seat about to answer on the session's own loop it is the session's
 * cumulative spend at that moment (subagent runs included — their money is
 * booked into the same session total, so a fan-out counts against the seat that
 * ordered it), and for the light seat's subagent gates it is the part of the
 * session total the seat itself spent, because that is the only share that can
 * be attributed to a seat at all. The sentence names the setting either way.
 */
export function budgetVerdict(spentUSD: number, budget: RoleBudget): BudgetVerdict {
	if (budget.budgetUSD === undefined || spentUSD <= budget.budgetUSD) return { action: "ok" };
	return {
		action: "blocked",
		message:
			`Budget reached: $${spentUSD.toFixed(4)} spent of the $${budget.budgetUSD.toFixed(4)} budget for ` +
			`roles.${budget.role}. Raise roles.${budget.role}.budgetUSD or switch models.`,
	};
}

/** The key a resolved model answers to: `${provider}/${id}`, the spelling catalogs and ledgers use. */
export function modelRefKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Which role owns which model ref — the table a host consults when it has a
 * model about to answer and needs the ceiling that model's seat carries.
 *
 * Keyed by ref because that is all the loop can see: a request is a model, and
 * which seat asked for it is not something the wire says. When two roles name
 * the same model the first in {@link ROLE_NAMES} order owns the ref, so a shared
 * model gets one label and one ceiling rather than two contradicting ones.
 *
 * A role that resolved no model owns no ref, and that is the same statement as
 * "it can carry no budget": an entry without a model is ignored whole by
 * `resolveRoles`. A ref no role names belongs to no seat and is never gated.
 */
export function seatsByRef(resolved: ResolvedRoles): Map<string, RoleBudget> {
	const seats = new Map<string, RoleBudget>();
	for (const role of ROLE_NAMES) {
		const seat = resolved[role];
		if (!seat.model) continue;
		const ref = modelRefKey(seat.model);
		if (!seats.has(ref)) seats.set(ref, { role, budgetUSD: seat.budgetUSD });
	}
	return seats;
}

/**
 * The ceilings `settings.roles` states, per role.
 *
 * For the readers that have the settings rather than the resolution — `/cost`
 * prints a line per role that has a ceiling — and it reads the raw entries on
 * purpose: a role whose model never resolved still has its ceiling listed,
 * because "$0.0000 of $2.0000" beside a seat that is not running is how a user
 * finds out the budget was configured for a seat that never got one.
 */
export function roleCeilings(roles: RoleSettings | undefined): Partial<Record<RoleName, number>> {
	const ceilings: Partial<Record<RoleName, number>> = {};
	for (const role of ROLE_NAMES) {
		const budgetUSD = roles?.[role]?.budgetUSD;
		if (budgetUSD !== undefined) ceilings[role] = budgetUSD;
	}
	return ceilings;
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
