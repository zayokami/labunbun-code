/**
 * Asking the providers what they serve.
 *
 * Two halves are held to their promise here. The listing calls are held to the
 * wire: what a page means, when a listing is complete, and what a provider that
 * states less than Anthropic does still tells us. The merge is held to the line
 * between the two catalogs — the picker's and the resolver's — because the one
 * expensive mistake in this feature is letting a stale vendor list take away a
 * model that a session recorded yesterday still names.
 *
 * No network: every probe and every listing client is a fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	type CatalogProbe,
	type DiscoveredListing,
	formatCatalogNotice,
	probeProvider,
	refreshModelCatalog,
} from "../src/discovery.ts";
import { missingApiKey } from "../src/index.ts";
import {
	apiKeyEnvNames,
	clearCustomModels,
	clearDiscovery,
	dynamicProviderTemplates,
	listModels,
	resolveModel,
	setProviderCatalogue,
} from "../src/model.ts";
import { listAnthropicModels } from "../src/providers/anthropic.ts";
import { listOpenAIModels, listOpenRouterModels } from "../src/providers/openai-compat.ts";
import type { Model } from "../src/types.ts";

afterEach(() => {
	clearDiscovery();
	clearCustomModels();
});

function modelOf(reference: string): Model {
	const model = resolveModel(reference);
	if (!model) throw new Error(`expected the built-in ${reference}`);
	return model;
}

/** Every variable that can hand a provider a key, so a test can take them away. */
const KEY_VARS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"DEEPSEEK_API_KEY",
	"KIMI_API_KEY",
	"MOONSHOT_API_KEY",
	"MINIMAX_API_KEY",
	"MISTRAL_API_KEY",
	"GLM_API_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	// Ollama's cloud account. The local daemon beside it names no variable at
	// all, which is not a name this list could take away.
	"OLLAMA_API_KEY",
	// One name for all four gateway providers: Zen and Go issue a single
	// dashboard key, and each plan's own catalog entry declares the same
	// variable (`env: ["OPENCODE_API_KEY"]` on both of them), so one exported
	// key reaches whichever plan the user bought.
	"OPENCODE_API_KEY",
	// OpenRouter's key. Its listing answers without one, but the rows this
	// table's pins carry make calls that do not.
	"OPENROUTER_API_KEY",
];

/** Every Anthropic id in the built-in table, in table order. A complete listing
 * that omits one drops it from the picker, so these are the ids at stake. */
const ANTHROPIC_TABLE = [
	"claude-opus-5-5",
	"claude-fable-5-1",
	"claude-mythos-5-1",
	"claude-fable-5",
	"claude-mythos-5",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-haiku-5-5",
	"claude-haiku-4-5",
];

function withoutKeys(): () => void {
	const saved = new Map<string, string | undefined>();
	for (const name of KEY_VARS) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

/** A probe that answers with a fixed listing and remembers who it was asked about. */
function answering(listing: DiscoveredListing): { probe: CatalogProbe; asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		probe: async (model) => {
			asked.push(`${model.provider}/${model.id}`);
			return listing;
		},
	};
}

/**
 * The list above is hand-written, and a name the registry has outgrown is not a
 * lint error: it is a test that quietly means "no provider has a key" while
 * meaning "every provider except the one whose variable nobody cleared". On a
 * machine that holds that variable the assertion fails for a reason that has
 * nothing to do with discovery; on a clean machine it never fails at all, which
 * is the same shape as no test. So the list is checked against the registry
 * here, where a new provider fails on every machine instead of on one.
 *
 * The registry is the source of truth, not the other way round: this asserts
 * coverage, and would rather a caller widen KEY_VARS than narrow the catalog.
 */
test("every variable the registry names is one this file takes away", () => {
	// A catalogue left by a neighbouring test would filter the list down to that
	// provider and make this vacuously true.
	clearDiscovery();
	const named = new Set<string>();
	for (const model of listModels()) for (const name of apiKeyEnvNames(model)) named.add(name);
	expect([...named].filter((name) => !KEY_VARS.includes(name)).sort()).toEqual([]);
});

describe("asking the providers", () => {
	test("a provider whose key is missing is not asked; one that takes no key is", async () => {
		const restore = withoutKeys();
		try {
			const { probe, asked } = answering({ provider: "anthropic", models: [], complete: true });
			expect(await refreshModelCatalog({ probe })).toBeUndefined();
			// The keyed providers are skipped — asking without a key is a request
			// that can only be rejected. The local Ollama template is not skipped:
			// nothing is missing from it, and its catalog exists in no other place.
			// The subscription backend's rows are keyless like the daemon and still
			// absent here, because no listing call exists for their wire — so this
			// exact list is also the pin: a chatgpt ref appearing here means the
			// probe grew a call, and the question of what it asks with was answered
			// on purpose rather than by drift.
			expect(asked).toEqual(["ollama/local"]);
		} finally {
			restore();
		}
	});

	test("one question per provider, asked of whoever holds the key", async () => {
		const restore = withoutKeys();
		try {
			process.env.ANTHROPIC_API_KEY = "test-key";
			const { probe, asked } = answering({ provider: "anthropic", models: [], complete: true });
			await refreshModelCatalog({ probe });
			// One provider, one request — not one per model — and the providers
			// without a key are left alone rather than asked and rejected. The
			// keyless template is asked either way: two questions, not one per row.
			expect(asked).toHaveLength(2);
			expect(asked[0]).toStartWith("anthropic/");
			expect(asked[1]).toBe("ollama/local");
		} finally {
			restore();
		}
	});

	test("what the provider does not list leaves the picker but not the resolver", async () => {
		const { probe } = answering({
			provider: "anthropic",
			models: [{ id: "claude-opus-5", contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
			complete: true,
		});
		const refresh = await refreshModelCatalog({ probe, models: [modelOf("anthropic/claude-opus-5")] });

		expect(refresh?.dropped).toEqual(
			ANTHROPIC_TABLE.filter((id) => id !== "claude-opus-5").map((id) => `anthropic/${id}`),
		);
		expect(
			listModels()
				.filter((m) => m.provider === "anthropic")
				.map((m) => m.id),
		).toEqual(["claude-opus-5"]);
		// The point of the split: a transcript written against a model the vendor
		// has since stopped listing still resolves, and still costs with its own row.
		expect(resolveModel("anthropic/claude-sonnet-5")?.id).toBe("claude-sonnet-5");
		expect(resolveModel("claude-sonnet-5")?.pricing?.input).toBe(2);
		// Providers nobody asked keep every row they had.
		expect(listModels().filter((m) => m.provider === "deepseek")).toHaveLength(2);
	});

	test("a provider that throws changes nothing", async () => {
		const before = listModels();
		const refresh = await refreshModelCatalog({
			probe: async () => {
				throw new Error("offline");
			},
			models: [modelOf("deepseek/deepseek-flash")],
		});
		expect(refresh).toBeUndefined();
		expect(listModels()).toEqual(before);
	});

	test("an empty listing is a provider that did not answer, not one that serves nothing", async () => {
		const before = listModels();
		const { probe } = answering({ provider: "deepseek", models: [], complete: true });
		expect(await refreshModelCatalog({ probe, models: [modelOf("deepseek/deepseek-flash")] })).toBeUndefined();
		// An empty set is what hides a model, so reading a blank response as an
		// answer would delete a whole provider's catalog.
		expect(listModels()).toEqual(before);
	});

	test("a listing cut short states limits but hides nothing", async () => {
		const { probe } = answering({
			provider: "anthropic",
			models: [{ id: "claude-sonnet-5", contextWindow: 999_000, maxOutputTokens: 7_000 }],
			complete: false,
		});
		const refresh = await refreshModelCatalog({ probe, models: [modelOf("anthropic/claude-sonnet-5")] });

		expect(refresh?.dropped).toEqual([]);
		expect(listModels().filter((m) => m.provider === "anthropic")).toHaveLength(ANTHROPIC_TABLE.length);
		// Its own row, though, is worth reading even from a fragment.
		expect(listModels().find((m) => m.id === "claude-sonnet-5")?.contextWindow).toBe(999_000);
	});
});

describe("what the answer changes", () => {
	test("the window and cap a provider states beat the table", async () => {
		const { probe } = answering({
			provider: "anthropic",
			models: [
				{
					id: "claude-sonnet-5",
					displayName: "Claude Sonnet 5 (live)",
					contextWindow: 999_000,
					maxOutputTokens: 7_000,
				},
			],
			complete: true,
		});
		await refreshModelCatalog({ probe, models: [modelOf("anthropic/claude-sonnet-5")] });
		const sonnet = listModels().find((m) => m.id === "claude-sonnet-5");

		expect(sonnet?.contextWindow).toBe(999_000);
		expect(sonnet?.maxOutputTokens).toBe(7_000);
		// A model we already know keeps the name we gave it: a vendor's display
		// string is for showing, and the table's is the one the UI is written around.
		expect(sonnet?.name).toBe("Claude Sonnet 5");
		// The provider said nothing about the price, and there is nothing to say:
		// the table's row is still the only price that exists.
		expect(sonnet?.pricing?.input).toBe(2);
	});

	test("a listing that states only a window corrects it and leaves the output cap alone", async () => {
		// The shape the vendors actually produce: Kimi states a window and no cap at
		// all. The window is worth taking on its own — it is the input to the
		// compaction threshold — but on its own terms: a listing that says nothing
		// about the cap must not be read as saying there is none.
		const { probe } = answering({
			provider: "kimi",
			models: [{ id: "kimi-k2.6", contextWindow: 300_000 }],
			complete: true,
		});
		await refreshModelCatalog({ probe, models: [modelOf("kimi/kimi-k2.6")] });
		const k2 = listModels().find((m) => m.id === "kimi-k2.6");

		expect(k2?.contextWindow).toBe(300_000);
		expect(k2?.maxOutputTokens).toBe(32_768);
	});

	test("a model the table has never heard of is offered when the provider states its limits", async () => {
		const { probe } = answering({
			provider: "anthropic",
			models: [
				{ id: "claude-opus-6", displayName: "Claude Opus 6", contextWindow: 2_000_000, maxOutputTokens: 64_000 },
			],
			complete: true,
		});
		const refresh = await refreshModelCatalog({ probe, models: [modelOf("anthropic/claude-opus-5")] });

		expect(refresh?.added).toEqual(["anthropic/claude-opus-6"]);
		expect(listModels().find((m) => m.id === "claude-opus-6")).toMatchObject({
			name: "Claude Opus 6",
			api: "anthropic-messages",
			provider: "anthropic",
			contextWindow: 2_000_000,
			maxOutputTokens: 64_000,
			// No price: an unpriced model reads as "not priced", which is true. A
			// wrong number here would silently misprice every session that used it.
			pricing: undefined,
		});
		expect(resolveModel("anthropic/claude-opus-6")?.id).toBe("claude-opus-6");
		expect(resolveModel("claude-opus-6")?.provider).toBe("anthropic");
	});

	test("a provider with no table row gets its rows from its own listing", async () => {
		// The local Ollama daemon: the one provider whose catalog cannot be
		// written down, because only the daemon knows what has been pulled. Its
		// template is not a model — it never resolves on its own — but it gives
		// the probe a wire and a base URL, and the synthesizer a row to build on.
		const { probe } = answering({
			provider: "ollama",
			models: [{ id: "llama3.2:3b", contextWindow: 131_072, maxOutputTokens: 131_072, reasoning: false }],
			complete: true,
		});
		const refresh = await refreshModelCatalog({ probe, models: dynamicProviderTemplates() });

		expect(refresh?.added).toEqual(["ollama/llama3.2:3b"]);
		const row = resolveModel("ollama/llama3.2:3b");
		if (!row) throw new Error("expected the listed model to resolve");
		expect(row).toMatchObject({
			provider: "ollama",
			api: "openai-completions",
			baseUrl: "http://localhost:11434/v1",
			contextWindow: 131_072,
			maxOutputTokens: 131_072,
			reasoning: false,
			// No price: it runs on the user's own hardware, and there is no rate to
			// transcribe — the same reading every discovered row takes.
			pricing: undefined,
		});
		// Keyless end to end: the row names no variable and wants none.
		expect(apiKeyEnvNames(row)).toEqual([]);
		expect(missingApiKey(row)).toBeUndefined();
		// The daemon's loadout is reachable only qualified, like the other
		// gateways: the bare id resolves to nothing, and the hint can offer it.
		expect(resolveModel("llama3.2:3b")).toBeUndefined();
	});

	test("what a listing says about thinking reaches the row it builds", async () => {
		const { probe } = answering({
			provider: "ollama",
			models: [
				{ id: "qwen3:8b", contextWindow: 40_960, maxOutputTokens: 40_960, reasoning: true },
				// No claim either way: the template's own flag stands rather than the
				// silence being read as a `false` the daemon never said.
				{ id: "granite4:7b", contextWindow: 131_072, maxOutputTokens: 131_072 },
			],
			complete: true,
		});
		await refreshModelCatalog({ probe, models: dynamicProviderTemplates() });

		expect(resolveModel("ollama/qwen3:8b")?.reasoning).toBe(true);
		expect(resolveModel("ollama/granite4:7b")?.reasoning).toBe(false);
	});

	test("an id with no stated limits is not offered at all", async () => {
		const { probe } = answering({
			provider: "deepseek",
			models: [{ id: "deepseek-flash" }, { id: "deepseek-v5" }],
			complete: true,
		});
		const refresh = await refreshModelCatalog({ probe, models: [modelOf("deepseek/deepseek-flash")] });

		// It is named in no list: we could offer it, but we would have to invent a
		// context window, and that number is what every compaction threshold is
		// computed from. A wrong one is worse than a missing row.
		expect(refresh?.added).toEqual([]);
		expect(refresh?.dropped).toEqual(["deepseek/deepseek-v4-pro"]);
		expect(listModels().some((m) => m.id === "deepseek-v5")).toBe(false);
		expect(resolveModel("deepseek/deepseek-v5")).toBeUndefined();
	});

	test("a second answer replaces the first rather than adding to it", () => {
		const one = { contextWindow: 1_000, maxOutputTokens: 100 };
		expect(
			setProviderCatalogue(
				"anthropic",
				[
					{ id: "a", ...one },
					{ id: "b", ...one },
				],
				{ complete: true },
			),
		).toEqual({
			added: ["a", "b"],
			dropped: [...ANTHROPIC_TABLE],
		});
		expect(setProviderCatalogue("anthropic", [{ id: "b", ...one }], { complete: true })).toEqual({
			added: [],
			// "b" is not counted as added because it was already offered; "a" and the
			// whole built-in table are gone, because a complete listing is taken at
			// its word — that is what makes a stale listing expensive.
			dropped: [...ANTHROPIC_TABLE, "a"],
		});
		expect(listModels().some((m) => m.id === "a")).toBe(false);
	});
});

/** The two listing calls, driven by fake clients — the wire shapes without a wire. */
describe("what a provider answers with", () => {
	const anthropic = modelOf("anthropic/claude-opus-5");
	const deepseek = modelOf("deepseek/deepseek-flash");
	const openrouter = modelOf("openrouter/anthropic/claude-fable-5.1");

	test("an Anthropic page is read for its id, its name and both limits", async () => {
		const client = {
			models: {
				list: async () => ({
					data: [{ id: "m1", display_name: "M One", max_input_tokens: 1_000_000, max_tokens: 128_000 }],
					has_more: false,
				}),
			},
		};
		expect(await listAnthropicModels(anthropic, { client })).toEqual({
			models: [{ id: "m1", displayName: "M One", contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
			complete: true,
		});
	});

	test("every page is read, following the cursor the endpoint hands back", async () => {
		const pages = [
			{ data: [{ id: "m1" }], has_more: true, last_id: "m1" },
			{ data: [{ id: "m2" }], has_more: false },
		];
		const cursors: string[] = [];
		const client = {
			models: {
				list: async (params: Record<string, unknown>) => {
					cursors.push(String(params.after_id ?? "-"));
					return pages.shift() ?? { data: [], has_more: false };
				},
			},
		};
		const listing = await listAnthropicModels(anthropic, { client });
		// The default page size is 20, so a single request would have hidden most
		// of a real catalog from the very code that decides what to hide.
		expect(listing.models.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(listing.complete).toBe(true);
		expect(cursors).toEqual(["-", "m1"]);
	});

	test("a listing that never ends stops at the page cap and says it is partial", async () => {
		let calls = 0;
		const client = {
			models: {
				list: async () => {
					calls++;
					return { data: [{ id: `m${calls}` }], has_more: true, last_id: `m${calls}` };
				},
			},
		};
		const listing = await listAnthropicModels(anthropic, { client });
		// Ten pages of a thousand is far past any real catalog; whatever is past it
		// is unreachable, and an unreachable tail must not be read as "gone".
		expect(calls).toBe(10);
		expect(listing.models).toHaveLength(10);
		expect(listing.complete).toBe(false);
	});

	test("a page claiming more but offering no cursor ends the listing", async () => {
		let calls = 0;
		const client = {
			models: {
				list: async () => {
					calls++;
					return { data: [{ id: "m1" }], has_more: true, last_id: null };
				},
			},
		};
		const listing = await listAnthropicModels(anthropic, { client });
		expect(calls).toBe(1);
		expect(listing).toEqual({ models: [{ id: "m1" }], complete: false });
	});

	test("an OpenAI-compatible listing is an id, plus a window wherever the vendor states one", async () => {
		const client = {
			models: {
				list: async () => ({
					data: [{ id: "a" }, { id: "b", context_length: 262_144 }, { id: "c", context_length: 0 }, {}],
				}),
			},
		};
		// Mostly ids: no cap and no price on this endpoint at all, and only Kimi
		// states `context_length`. A zero is not a window — it is a vendor that
		// filled the field in — and an entry with no id is not a model, so neither
		// becomes one. What does come through is worth keeping: the window is the
		// input to the compaction threshold.
		expect(await listOpenAIModels(deepseek, { client })).toEqual({
			models: [{ id: "a" }, { id: "b", contextWindow: 262_144 }, { id: "c" }],
			complete: true,
		});
	});

	test("an OpenRouter listing states a name and both limits; only facts become them", async () => {
		const client = {
			models: {
				list: async () => ({
					data: [
						{
							id: "a/b",
							name: "Vendor: B",
							context_length: 1_000_000,
							top_provider: { max_completion_tokens: 128_000 },
						},
						// A zero and a null are fields filled in, not facts — and where a
						// field is absent the row just loses it, the reverse of the generic
						// reader, which keeps the window and drops everything the page adds.
						{ id: "c/d", context_length: 0, top_provider: { max_completion_tokens: null } },
						{ id: "e/f", name: "F", context_length: 65_536 },
						{},
					],
				}),
			},
		};
		expect(await listOpenRouterModels(openrouter, { client })).toEqual({
			models: [
				{ id: "a/b", displayName: "Vendor: B", contextWindow: 1_000_000, maxOutputTokens: 128_000 },
				{ id: "c/d" },
				{ id: "e/f", displayName: "F", contextWindow: 65_536 },
			],
			complete: true,
		});
	});

	test("the openrouter probe reads the host's page, not the generic one", async () => {
		// The dispatch is load-bearing: the generic reader would drop both the name
		// and the cap, and a synthesized row missing either limit is not built at
		// all — six pinned rows would then be all OpenRouter ever offered.
		const client = {
			models: {
				list: async () => ({
					data: [
						{
							id: "anthropic/claude-fable-5.1",
							name: "Anthropic: Claude Fable 5.1",
							context_length: 1_000_000,
							top_provider: { max_completion_tokens: 128_000 },
						},
					],
				}),
			},
		};
		expect(await probeProvider(openrouter, undefined, client)).toEqual({
			provider: "openrouter",
			models: [
				{
					id: "anthropic/claude-fable-5.1",
					displayName: "Anthropic: Claude Fable 5.1",
					contextWindow: 1_000_000,
					maxOutputTokens: 128_000,
				},
			],
			complete: true,
		});
	});
});

describe("the notice", () => {
	test("says nothing when nothing changed", () => {
		expect(formatCatalogNotice(undefined)).toBeUndefined();
		// A refresh that confirmed the table is a refresh the user does not need to
		// hear about — a startup notice that always appears is one nobody reads.
		expect(formatCatalogNotice({ checked: ["anthropic"], added: [], dropped: [] })).toBeUndefined();
	});

	test("names what left the picker and what joined it", () => {
		const notice = formatCatalogNotice({
			checked: ["anthropic"],
			dropped: ["anthropic/claude-fable-5"],
			added: ["anthropic/claude-opus-6"],
		});
		expect(notice).toContain("Model catalog refreshed:");
		expect(notice).toContain("anthropic/claude-fable-5 not listed by the provider any more");
		expect(notice).toContain("still usable by name");
		expect(notice).toContain("anthropic/claude-opus-6 added from the provider's listing");
		expect(notice).toContain("declare one in settings.json");
	});

	test("stops naming them after three", () => {
		const notice = formatCatalogNotice({
			checked: ["anthropic"],
			added: [],
			dropped: ["p/1", "p/2", "p/3", "p/4"],
		});
		expect(notice).toContain("p/1, p/2, p/3 and 1 more");
		expect(notice).not.toContain("p/4");
	});
});
