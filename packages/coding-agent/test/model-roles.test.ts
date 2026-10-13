/**
 * The role stack: what `settings.roles` resolves to, and what the fallback
 * chain does with the failing model it is handed.
 *
 * Two promises are under test here. The first is fail-soft: an unknown
 * reference, a missing key, or an entry that names no model warns and leaves
 * the seat on the host's default — a settings mistake must not stop the app.
 * The second is the chain's descent: `resolveChain` takes the model that failed
 * and returns what comes *after* it, in the order the role declared, never
 * climbing back over a rung the session already stepped off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { clearCustomModels, FAUX_MODEL, type Model, registerOpenAICompatibleProvider } from "@labunbun/ai";
import {
	budgetVerdict,
	createModelChainResolver,
	modelRefKey,
	resolveRoles,
	roleCeilings,
	roleOrder,
	sameModel,
	seatsByRef,
} from "../src/model-roles.ts";

afterEach(() => {
	// The catalog's custom-provider map is process-global, and this file is not
	// its only writer.
	clearCustomModels();
});

/** A registered provider whose models exist only for this test. */
function registerProvider(id: string, apiKeyEnv: string, modelIds: string[]): void {
	registerOpenAICompatibleProvider({
		id,
		baseUrl: `https://${id}.invalid/v1`,
		apiKeyEnv,
		models: modelIds.map((modelId) => ({ id: modelId, contextWindow: 128_000, maxOutputTokens: 8_192 })),
	});
}

/** Run `fn` with the named variables set to a placeholder, then put them back. */
async function withKeys(names: string[], fn: () => Promise<void>): Promise<void> {
	const before = names.map((name) => [name, process.env[name]] as const);
	for (const name of names) process.env[name] = "test-key";
	try {
		await fn();
	} finally {
		for (const [name, value] of before) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("resolveRoles", () => {
	test("no roles section is nothing to resolve, and nothing to say", async () => {
		let refreshes = 0;
		const result = await resolveRoles(undefined, async () => {
			refreshes++;
		});
		expect(result.warnings).toEqual([]);
		expect(refreshes).toBe(0);
		for (const role of ["main", "plan", "compaction", "light", "local"] as const) {
			expect(result[role].model).toBeUndefined();
			expect(result[role].fallback).toEqual([]);
		}
	});

	test("a role's model resolves, and the role names it", async () => {
		await withKeys(["LBB_ROLES_MAIN_KEY"], async () => {
			registerProvider("roles-main", "LBB_ROLES_MAIN_KEY", ["m1"]);
			const result = await resolveRoles({ main: { model: "roles-main/m1" } }, async () => {});

			expect(result.warnings).toEqual([]);
			expect(result.main.model?.id).toBe("m1");
			expect(result.main.model?.provider).toBe("roles-main");
		});
	});

	test("provider and model build provider/model, and the model id may contain slashes", async () => {
		// The serving side is the provider field, the id is what it serves the
		// model under — OpenRouter's own ids look like `deepseek/deepseek-chat`,
		// and a bare id never resolves to a gateway row, so the entry has to be
		// able to name both.
		await withKeys(["LBB_ROLES_GATEWAY_KEY"], async () => {
			registerProvider("roles-gateway", "LBB_ROLES_GATEWAY_KEY", ["deepseek/deepseek-chat"]);
			const result = await resolveRoles(
				{ light: { provider: "roles-gateway", model: "deepseek/deepseek-chat" } },
				async () => {},
			);

			expect(result.warnings).toEqual([]);
			expect(result.light.model?.provider).toBe("roles-gateway");
			expect(result.light.model?.id).toBe("deepseek/deepseek-chat");
		});
	});

	test("an unknown ref asks for one refresh, then falls back with a line", async () => {
		let refreshes = 0;
		const result = await resolveRoles({ plan: { model: "no-such/provider-model" } }, async () => {
			refreshes++;
		});

		expect(refreshes).toBe(1);
		expect(result.plan.model).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain('unknown model "no-such/provider-model" for roles.plan');
		expect(result.warnings[0]).toContain("plan mode will keep the session's model");
	});

	test("the second look's answer is used, not the first miss", async () => {
		// A ref only a provider's listing can name — the local daemon's loadout —
		// resolves on the retry after the refresh. The provider appears during the
		// refresh, which is the ordering the daemon has.
		await withKeys(["LBB_ROLES_LATE_KEY"], async () => {
			const result = await resolveRoles({ local: { model: "roles-late/m1" } }, async () => {
				registerProvider("roles-late", "LBB_ROLES_LATE_KEY", ["m1"]);
			});

			expect(result.warnings).toEqual([]);
			expect(result.local.model?.id).toBe("m1");
		});
	});

	test("a model whose key is missing falls back naming the key", async () => {
		// Registered under a variable nothing sets: a machine that configured a
		// cloud model for a role and never exported its key.
		registerProvider("roles-missing", "LBB_ROLES_TEST_MISSING_KEY", ["m1"]);
		const result = await resolveRoles({ compaction: { model: "roles-missing/m1" } }, async () => {});

		expect(result.compaction.model).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("LBB_ROLES_TEST_MISSING_KEY");
		expect(result.warnings[0]).toContain("the session's model will write summaries");
	});

	test("an entry that names no model warns instead of resolving to something", async () => {
		const result = await resolveRoles({ main: { provider: "roles-main" } }, async () => {});

		expect(result.main.model).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("roles.main sets no model");
		expect(result.warnings[0]).toContain("the built-in default model will be used");
	});

	test("a role's fallback list keeps its order and drops what will not resolve", async () => {
		await withKeys(["LBB_ROLES_FB_KEY"], async () => {
			registerProvider("roles-fb", "LBB_ROLES_FB_KEY", ["m1", "m2", "m3"]);
			registerProvider("roles-fb-nokey", "LBB_ROLES_FB_TEST_MISSING", ["m4"]);
			const result = await resolveRoles(
				{
					main: {
						model: "roles-fb/m1",
						fallback: ["roles-fb/m2", "no-such/ref", "roles-fb-nokey/m4", "roles-fb/m3"],
					},
				},
				async () => {},
			);

			expect(result.warnings).toEqual([]);
			expect(result.main.model?.id).toBe("m1");
			// The unresolvable and the unauthenticated fallbacks are dropped in
			// silence — the same treatment `settings.fallbackModels` gets — and the
			// resolvable ones stay in the order they were written.
			expect(result.main.fallback.map((m) => m.id)).toEqual(["m2", "m3"]);
		});
	});

	test("every role is resolved independently, and a bad one does not poison the rest", async () => {
		await withKeys(["LBB_ROLES_MIX_KEY"], async () => {
			registerProvider("roles-mix", "LBB_ROLES_MIX_KEY", ["m1"]);
			const result = await resolveRoles(
				{
					main: { model: "roles-mix/m1" },
					plan: { model: "no-such/ref" },
					light: { model: "roles-mix/m1" },
				},
				async () => {},
			);

			expect(result.main.model?.id).toBe("m1");
			expect(result.plan.model).toBeUndefined();
			expect(result.light.model?.id).toBe("m1");
			expect(result.warnings).toHaveLength(1);
		});
	});
});

describe("budgetVerdict", () => {
	test("a seat with no budget is ok, whatever it spent", () => {
		// The ceiling is the whole mechanism: without one there is nothing to
		// cross, and the pre-budget behaviour is what an unconfigured seat means.
		expect(budgetVerdict(12.5, { role: "main" })).toEqual({ action: "ok" });
	});

	test("spending under the budget is ok, and spending exactly it is not over it", () => {
		// The comparison is strict, the rule beetle's maxCostUSD uses: a run that
		// has spent exactly its limit has not crossed anything, and cutting it off
		// a hair under the number its user wrote is the failure this avoids.
		expect(budgetVerdict(1, { role: "main", budgetUSD: 2 })).toEqual({ action: "ok" });
		expect(budgetVerdict(2, { role: "main", budgetUSD: 2 })).toEqual({ action: "ok" });
	});

	test("spending past the budget is blocked, with a sentence that says what to change", () => {
		const verdict = budgetVerdict(2.5, { role: "main", budgetUSD: 2 });
		expect(verdict.action).toBe("blocked");
		if (verdict.action !== "blocked") throw new Error("expected a blocked verdict");
		// What was spent, what the ceiling was, and the two ways out — a refusal
		// that only says "no" leaves the user guessing which number to edit.
		expect(verdict.message).toBe(
			"Budget reached: $2.5000 spent of the $2.0000 budget for roles.main. Raise roles.main.budgetUSD or switch models.",
		);
	});

	test("the sentence names the seat it is about", () => {
		const verdict = budgetVerdict(3, { role: "light", budgetUSD: 1 });
		expect(verdict.action === "blocked" ? verdict.message : "").toContain("roles.light.budgetUSD");
	});
});

describe("resolveRoles carries a seat's budget", () => {
	test("a resolved seat carries the budget its entry stated", async () => {
		await withKeys(["LBB_ROLES_BUDGET_KEY"], async () => {
			registerProvider("roles-budget", "LBB_ROLES_BUDGET_KEY", ["m1"]);
			const result = await resolveRoles({ main: { model: "roles-budget/m1", budgetUSD: 5 } }, async () => {});

			expect(result.main.budgetUSD).toBe(5);
			expect(result.light.budgetUSD).toBeUndefined();
		});
	});

	test("an entry that did not resolve carries no budget — the seat is ignored whole", async () => {
		// A ceiling that survived a dropped seat would read as enforcement and be
		// none: there is no seat left to enforce it against.
		const result = await resolveRoles({ main: { model: "no-such-model", budgetUSD: 5 } }, async () => {});

		expect(result.main.model).toBeUndefined();
		expect(result.main.budgetUSD).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
	});
});

describe("seatsByRef", () => {
	test("each resolved seat answers to its model ref, with its own ceiling", async () => {
		await withKeys(["LBB_ROLES_SEATS_KEY"], async () => {
			registerProvider("roles-seats", "LBB_ROLES_SEATS_KEY", ["m1", "m2"]);
			const result = await resolveRoles(
				{
					main: { model: "roles-seats/m1", budgetUSD: 5 },
					light: { model: "roles-seats/m2", budgetUSD: 1 },
				},
				async () => {},
			);
			const seats = seatsByRef(result);

			expect(seats.get("roles-seats/m1")).toEqual({ role: "main", budgetUSD: 5 });
			expect(seats.get("roles-seats/m2")).toEqual({ role: "light", budgetUSD: 1 });
			// A ref no role names is nobody's seat: the gate that finds nothing here
			// is the same "ok" an unconfigured budget answers.
			expect(seats.get("roles-seats/m3")).toBeUndefined();
		});
	});

	test("two roles on one ref leave the first in role order owning it", async () => {
		// Keyed by ref because a request is a model and nothing on the wire says
		// which seat asked: the shared model gets one label and one ceiling.
		await withKeys(["LBB_ROLES_SHARED_KEY"], async () => {
			registerProvider("roles-shared", "LBB_ROLES_SHARED_KEY", ["m1"]);
			const result = await resolveRoles(
				{
					main: { model: "roles-shared/m1", budgetUSD: 5 },
					light: { model: "roles-shared/m1", budgetUSD: 1 },
				},
				async () => {},
			);

			expect(seatsByRef(result).get("roles-shared/m1")).toEqual({ role: "main", budgetUSD: 5 });
		});
	});

	test("a seat that resolved no model owns no ref", async () => {
		const result = await resolveRoles({ main: { model: "no-such/model" } }, async () => {});

		expect(seatsByRef(result).size).toBe(0);
	});
});

describe("roleCeilings", () => {
	test("states the configured ceilings and nothing for the seats without one", () => {
		expect(roleCeilings({ light: { model: "p/m", budgetUSD: 2 }, plan: { model: "p/m" }, local: {} })).toEqual({
			light: 2,
		});
	});

	test("no roles section is no ceilings", () => {
		expect(roleCeilings(undefined)).toEqual({});
	});
});

describe("modelRefKey", () => {
	test("is the provider and id spelling the catalog and the ledger use", () => {
		expect(modelRefKey({ ...FAUX_MODEL, provider: "anthropic", id: "claude-sonnet-5" })).toBe(
			"anthropic/claude-sonnet-5",
		);
	});
});

describe("roleOrder", () => {
	test("the role's own fallbacks run before the global list, and duplicates keep their first seat", () => {
		const a: Model = { ...FAUX_MODEL, id: "a" };
		const b: Model = { ...FAUX_MODEL, id: "b" };
		const c: Model = { ...FAUX_MODEL, id: "c" };
		const order = roleOrder(a, [b, a], [c, b]);
		expect(order.map((m) => m.id)).toEqual(["a", "b", "c"]);
	});
});

describe("createModelChainResolver", () => {
	const model = (id: string): Model => ({ ...FAUX_MODEL, id });
	const primary = model("primary");
	const roleFallback = model("role-fallback");
	const globalFallback = model("global-fallback");
	const orders = [roleOrder(primary, [roleFallback], [globalFallback])];
	const resolveChain = createModelChainResolver(orders, [globalFallback]);

	test("the failing model is the parameter that picks the chain", () => {
		// The bug this fixes: the chain used to be one fixed list whatever model
		// arrived, so a failure could land back on a rung that had just failed.
		expect(resolveChain(primary).map((m) => m.id)).toEqual(["role-fallback", "global-fallback"]);
	});

	test("a chain only descends — it never climbs back over the failing model", () => {
		// The role fallback failed; what is left is the global net. The primary
		// does not come back, because it outranks the model that just failed.
		expect(resolveChain(roleFallback).map((m) => m.id)).toEqual(["global-fallback"]);
	});

	test("a model no order names gets the global net alone", () => {
		const stranger = model("stranger");
		expect(resolveChain(stranger).map((m) => m.id)).toEqual(["global-fallback"]);
		// And the net never repeats the failing model itself.
		expect(resolveChain(globalFallback)).toEqual([]);
	});

	test("a primary seat outranks membership in another order", () => {
		// The same model can sit in one order as a fallback and be another order's
		// primary. The primary seat is where the model is *supposed* to run, so it
		// decides which rungs are below it: the order where it is a mid-chain
		// fallback is not walked on its behalf.
		const shared = model("shared");
		const after = model("after");
		const orders = [roleOrder(primary, [shared, after], []), roleOrder(shared, [], [globalFallback])];
		const resolver = createModelChainResolver(orders, [globalFallback]);
		expect(resolver(shared).map((m) => m.id)).toEqual(["global-fallback"]);
	});

	test("sameModel is provider and id, not object identity", () => {
		expect(sameModel(model("x"), model("x"))).toBe(true);
		expect(sameModel(model("x"), { ...FAUX_MODEL, id: "x", provider: "other" })).toBe(false);
	});
});
