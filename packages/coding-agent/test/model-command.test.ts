/**
 * `/model`'s picker, and the one thing it asks the providers before it opens.
 *
 * The registry's own tests pin what a listing does to the table. This one is
 * about the picker's timing: an enumeration of "what the API serves" is only
 * true as of the last time anyone asked, and startup is a long time ago for a
 * key that arrived in another shell or a model a provider added this morning.
 * The refresh is injected rather than stubbed at the module boundary because
 * nothing here may reach a network: the property under test is that the hook is
 * awaited *before* the list is built, which a probe running after the fact
 * could not show.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CatalogRefresh, clearDiscovery, resolveModel, setProviderCatalogue } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the picker was handed, and what the command put in the transcript. */
interface Listing {
	title: string;
	items: Array<{ label: string; description?: string }>;
}

function makeCtx(refreshCatalog?: () => Promise<CatalogRefresh | undefined>) {
	const home = mkdtempSync(join(tmpdir(), "lbb-model-command-"));
	const store = createStore<UiState>({ ...initialUiState(false) });
	const listings: Listing[] = [];
	let asked = 0;

	const ctx = {
		getSession: () => null,
		handle: {
			store,
			pickFromList: (title: string, items: Listing["items"]) => {
				listings.push({ title, items });
				return Promise.resolve(null);
			},
		},
		home,
		cwd: home,
		settings: {},
		refreshCatalog: refreshCatalog
			? () => {
					asked++;
					return refreshCatalog();
				}
			: undefined,
		costTracker: {
			state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
			sessionState: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
		},
		baseRules: [],
		sessionRules: [],
		commands: [],
		switchModel: () => {},
	} as unknown as AppCommandContext;

	return {
		ctx,
		store,
		asked: () => asked,
		clean: () => {
			clearDiscovery();
			rmSync(home, { recursive: true, force: true });
		},
		/** Wait for the picker, which the command opens behind a promise. */
		async listing(index = 0): Promise<Listing> {
			for (let waited = 0; waited < 2000; waited += 10) {
				const found = listings[index];
				if (found) return found;
				await delay(10);
			}
			throw new Error(`the picker never opened (${index + 1})`);
		},
		info: () =>
			store
				.get()
				.entries.filter((e) => e.kind === "info")
				.map((e) => (e as { text: string }).text)
				.join("\n"),
	};
}

/** The wire reference each row names, in the order the picker was handed them. */
const refs = (listing: Listing): string[] =>
	listing.items.map((item) => item.description?.split(" · ")[0] ?? "").filter(Boolean);

describe("/model with no argument", () => {
	test("asks the providers, then lists only what came back", async () => {
		const h = makeCtx(async () => {
			// A complete listing is what lets the table hide the rows it did not
			// name. The provider answering with one model is the whole feature.
			setProviderCatalogue("openai", [{ id: "gpt-6.1-sol" }], { complete: true });
			return { checked: ["openai"], dropped: ["openai/gpt-6.1-terra"], added: [] };
		});
		try {
			handleAppCommand("/model", h.ctx);
			const listing = await h.listing();

			// Asked exactly once, and asked before anything was offered: the rows
			// below cannot come from the table startup left behind.
			expect(h.asked()).toBe(1);
			expect(refs(listing)).toContain("openai/gpt-6.1-sol");
			expect(refs(listing)).not.toContain("openai/gpt-6.1-terra");
			expect(listing.title).toBe("Switch model");

			// And the row that went away is named rather than left as a mystery.
			expect(h.info()).toContain("openai/gpt-6.1-terra not listed by the provider any more");
		} finally {
			h.clean();
		}
	});

	test("a listing that did not move says nothing on the next opening", async () => {
		// `setProviderCatalogue` reports the same dropped ids on every refresh
		// that hides a built-in row, not only on the one that first hid it. A
		// notice printed on every opening would be yesterday's news read out
		// each time the picker is opened, which trains the user to ignore it.
		const h = makeCtx(async () => {
			setProviderCatalogue("openai", [{ id: "gpt-6.1-sol" }], { complete: true });
			return { checked: ["openai"], dropped: ["openai/gpt-6.1-terra"], added: [] };
		});
		try {
			handleAppCommand("/model", h.ctx);
			await h.listing(0);
			expect(h.info()).toContain("not listed by the provider any more");

			handleAppCommand("/model", h.ctx);
			await h.listing(1);
			// One sentence, from the opening that changed the list.
			expect(h.info().match(/not listed by the provider any more/g) ?? []).toHaveLength(1);
		} finally {
			h.clean();
		}
	});

	test("with no hook there is nothing to ask, and the table is what is offered", async () => {
		// A hand-built context — a test, an embedder — has no providers behind
		// it. It still gets a picker: an absent hook is "do not ask", not "do
		// not switch".
		const h = makeCtx();
		try {
			handleAppCommand("/model", h.ctx);
			const listing = await h.listing();
			expect(h.asked()).toBe(0);
			expect(refs(listing)).toContain("openai/gpt-6.1-sol");
			expect(refs(listing)).toContain("openai/gpt-6.1-terra");
		} finally {
			h.clean();
		}
	});

	test("a refresh that throws still leaves a usable picker", async () => {
		// Discovery promises never to throw, but this path awaits it directly —
		// and a rejected refresh taking the picker down would be the one failure
		// mode the user cannot work around.
		const h = makeCtx(async () => {
			throw new Error("probe exploded");
		});
		try {
			handleAppCommand("/model", h.ctx);
			const listing = await h.listing();
			expect(refs(listing)).toContain("openai/gpt-6.1-sol");
		} finally {
			h.clean();
		}
	});
});

describe("/model with a reference", () => {
	test("switches directly, without asking anyone", async () => {
		const h = makeCtx(async () => {
			throw new Error("the picker's refresh must not run");
		});
		try {
			// The argument path resolves a reference; there is no enumeration to
			// make current, so a probe here would be a request with no reader.
			handleAppCommand("/model openai/gpt-6.1-sol", h.ctx);
			await delay(50);
			expect(h.asked()).toBe(0);
		} finally {
			h.clean();
		}
	});
});

describe("the reference the picker hands back", () => {
	test("resolves to the row the listing named", () => {
		// The rows the test above asserts on must be real, not invented strings:
		// a picker whose ids resolve to nothing would be offering a dead name.
		expect(resolveModel("openai/gpt-6.1-sol")).toBeDefined();
		expect(resolveModel("openai/gpt-6.1-terra")).toBeDefined();
	});
});
