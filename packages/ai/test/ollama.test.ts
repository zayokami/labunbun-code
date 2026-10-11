/**
 * Ollama's native catalog: `GET /api/tags` names the models, `POST /api/show`
 * says what each one is.
 *
 * The interesting half is what a daemon states versus what it does not. A
 * window, a capability list, a context key whose prefix the id cannot predict —
 * each of those drives a number the rest of the app computes from, so silence
 * has to stay distinguishable from a claim. No network here: the fetch is
 * injected everywhere it can be, and stubbed where the signature cannot carry
 * one.
 */
import { describe, expect, test } from "bun:test";
import { probeProvider } from "../src/discovery.ts";
import { dynamicProviderTemplates, resolveModel } from "../src/model.ts";
import { listOllamaModels, ollamaNativeRoot } from "../src/providers/ollama.ts";
import type { Model } from "../src/types.ts";

/** The keyless local template; the only row whose provider has no static model. */
const local = () => {
	const template = dynamicProviderTemplates().find((model) => model.provider === "ollama");
	if (!template) throw new Error("expected the ollama template");
	return template;
};

function cloud(): Model {
	const model = resolveModel("ollama-cloud/kimi-k3");
	if (!model) throw new Error("expected the built-in ollama-cloud row");
	return model;
}

interface FetchCall {
	url: string;
	init?: RequestInit;
}

type FetchImpl = typeof fetch;

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }): Response {
	const ok = init?.ok ?? true;
	return {
		ok,
		status: init?.status ?? (ok ? 200 : 500),
		statusText: init?.statusText ?? (ok ? "OK" : "Internal Server Error"),
		json: async () => body,
	} as unknown as Response;
}

/** A fetch that records its calls and answers from the handler. */
function recordingFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
	calls: FetchCall[];
	fetchImpl: FetchImpl;
} {
	const calls: FetchCall[] = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		return handler(url, init);
	}) as FetchImpl;
	return { calls, fetchImpl };
}

/** Tags with one entry, show answering with a fixed body per model id. */
function daemon(entry: Record<string, unknown>, show: Record<string, Response> = {}) {
	return recordingFetch((url, init) => {
		if (url.endsWith("/api/tags")) return jsonResponse({ models: [entry] });
		const body = JSON.parse(String(init?.body)) as { model?: string };
		return show[body.model ?? ""] ?? jsonResponse({}, { ok: false, status: 404, statusText: "Not Found" });
	});
}

const withEnv = (name: string, value: string | undefined): (() => void) => {
	const saved = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	return () => {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	};
};

describe("the native root", () => {
	test("is the base URL with the OpenAI wire's suffix taken off", () => {
		expect(ollamaNativeRoot("http://localhost:11434/v1")).toBe("http://localhost:11434");
		// The daemon and the cloud host both keep `/v1` exactly once, and a
		// trailing slash before it must not defeat the match.
		expect(ollamaNativeRoot("https://ollama.com/v1/")).toBe("https://ollama.com");
		// No suffix at all: the root is the base URL.
		expect(ollamaNativeRoot("http://192.168.1.5:11434")).toBe("http://192.168.1.5:11434");
	});
});

describe("listing what a daemon serves", () => {
	test("an id is read from `model` first, `name` otherwise, with a window and a capability list", async () => {
		const { calls, fetchImpl } = daemon(
			{ name: "from-name", model: "from-model" },
			{
				"from-model": jsonResponse({
					capabilities: ["completion", "tools", "thinking"],
					model_info: { "general.parameter_count": 671_000_000_000, "kimi-k3.context_length": 1_048_576 },
				}),
			},
		);
		const listing = await listOllamaModels(local(), { fetch: fetchImpl });

		expect(listing).toEqual({
			models: [
				{
					id: "from-model",
					contextWindow: 1_048_576,
					// No separate output cap is stated: the window stands in for one.
					maxOutputTokens: 1_048_576,
					reasoning: true,
				},
			],
			complete: true,
		});
		// Tags first, then one show for the model — POSTed as a JSON body, since
		// the native API takes the id in the body and not in a path segment.
		expect(calls.map((call) => call.url)).toEqual([
			"http://localhost:11434/api/tags",
			"http://localhost:11434/api/show",
		]);
		expect(calls[1]?.init?.method).toBe("POST");
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ model: "from-model" });
		// The local daemon takes requests bare: the keyless row must not decorate
		// them with an Authorization header it has no value for.
		for (const call of calls) {
			const headers = (call.init?.headers ?? {}) as Record<string, string>;
			expect(headers.authorization).toBeUndefined();
		}
	});

	test("an entry with only `name` still names a model", async () => {
		const { calls, fetchImpl } = daemon(
			{ name: "only:latest" },
			{
				"only:latest": jsonResponse({ capabilities: ["completion"], model_info: {} }),
			},
		);
		const listing = await listOllamaModels(local(), { fetch: fetchImpl });

		expect(listing.models.map((model) => model.id)).toEqual(["only:latest"]);
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ model: "only:latest" });
	});

	test("a window is read only from a `context_length` key holding a positive number", async () => {
		// The prefix is the architecture and the id cannot predict it: one model
		// reports the bare key. Anything that is not a positive number — a string
		// spelling of one, or a zero a vendor filled in — is not a window.
		const answers: Record<string, Response> = {
			bare: jsonResponse({ model_info: { context_length: 131_072 } }),
			prefixed: jsonResponse({ model_info: { "llama.context_length": 131_072 } }),
			stringly: jsonResponse({ model_info: { "x.context_length": "131072" } }),
			zero: jsonResponse({ model_info: { "x.context_length": 0 } }),
			foreign: jsonResponse({ model_info: { "general.parameter_count": 8_000_000_000 } }),
		};
		const entries = Object.keys(answers).map((id) => ({ model: id }));
		const { fetchImpl } = recordingFetch((url, init) => {
			if (url.endsWith("/api/tags")) return jsonResponse({ models: entries });
			const body = JSON.parse(String(init?.body)) as { model?: string };
			return answers[body.model ?? ""] ?? jsonResponse({});
		});
		const listing = await listOllamaModels(local(), { fetch: fetchImpl });

		expect(listing.models).toEqual([
			{ id: "bare", contextWindow: 131_072, maxOutputTokens: 131_072 },
			{ id: "prefixed", contextWindow: 131_072, maxOutputTokens: 131_072 },
			// Ids without a usable window still stand — the row's detail is what is
			// missing, not the model. A row needs limits to be *offered*, and that
			// rule lives in the merge, not here.
			{ id: "stringly" },
			{ id: "zero" },
			{ id: "foreign" },
		]);
	});

	test("a capability list without `completion` is a model that is not for chatting", async () => {
		const { fetchImpl } = recordingFetch((url, init) => {
			if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ model: "nomic-embed" }, { model: "chat" }] });
			const body = JSON.parse(String(init?.body)) as { model?: string };
			return body.model === "nomic-embed"
				? jsonResponse({ capabilities: ["embedding"], model_info: { context_length: 2048 } })
				: jsonResponse({ capabilities: ["completion", "tools"], model_info: { context_length: 131_072 } });
		});
		const listing = await listOllamaModels(local(), { fetch: fetchImpl });

		// The embedding model is dropped, not offered as a picker row that can only
		// fail; the chat model keeps its stated capabilities.
		expect(listing.models).toEqual([
			{ id: "chat", contextWindow: 131_072, maxOutputTokens: 131_072, reasoning: false },
		]);
	});

	test("a silent show page is not a statement about capabilities", async () => {
		// An old server answers without a capability list at all. Nothing is
		// claimed — so nothing is read as `false`, and nothing is excluded.
		const { fetchImpl } = daemon(
			{ model: "old" },
			{
				old: jsonResponse({ model_info: { context_length: 4096 } }),
			},
		);
		const listing = await listOllamaModels(local(), { fetch: fetchImpl });

		const row = listing.models[0];
		expect(row).toEqual({ id: "old", contextWindow: 4096, maxOutputTokens: 4096 });
		expect(row && "reasoning" in row).toBe(false);
	});

	test("a show page that will not answer loses its detail, not the model", async () => {
		const { fetchImpl } = daemon({ model: "stubborn" });
		const listing = await listOllamaModels(local(), { fetch: fetchImpl });

		expect(listing).toEqual({ models: [{ id: "stubborn" }], complete: true });
	});

	test("a tags page that refuses is an error the refresh can swallow", async () => {
		// The refresh catches a throwing probe and reads it as "did not answer" —
		// which is why the refusal has to arrive as a throw, not as an empty list.
		const refusing = recordingFetch(() => jsonResponse({}, { ok: false, status: 401, statusText: "Unauthorized" }));
		expect(listOllamaModels(local(), { fetch: refusing.fetchImpl })).rejects.toThrow(
			"Ollama catalog request failed: 401",
		);
		// A daemon that serves nothing lists nothing — one request, no shows.
		const empty = recordingFetch(() => jsonResponse({ models: [] }));
		expect(await listOllamaModels(local(), { fetch: empty.fetchImpl })).toEqual({ models: [], complete: true });
		expect(empty.calls).toHaveLength(1);
	});

	test("the cloud host is asked with the account's key", async () => {
		const restore = withEnv("OLLAMA_API_KEY", "cloud-key");
		try {
			const { calls, fetchImpl } = daemon(
				{ model: "kimi-k3" },
				{
					"kimi-k3": jsonResponse({
						capabilities: ["completion", "thinking"],
						model_info: { context_length: 1_048_576 },
					}),
				},
			);
			const listing = await listOllamaModels(cloud(), { fetch: fetchImpl });

			expect(listing.models).toEqual([
				{ id: "kimi-k3", contextWindow: 1_048_576, maxOutputTokens: 1_048_576, reasoning: true },
			]);
			// The cloud host authenticates like any other vendor; the `/v1` suffix
			// comes off the native requests but stays off, not errors.
			expect(calls[0]?.url).toBe("https://ollama.com/api/tags");
			for (const call of calls) {
				const headers = (call.init?.headers ?? {}) as Record<string, string>;
				expect(headers.authorization).toBe("Bearer cloud-key");
			}
		} finally {
			restore();
		}
	});
});

describe("the probe dispatch", () => {
	const stubFetch = (handler: (url: string) => Response): (() => void) => {
		const real = globalThis.fetch;
		globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch;
		return () => {
			globalThis.fetch = real;
		};
	};

	test("an ollama provider is asked the native API, not `/v1/models`", async () => {
		const restore = stubFetch((url) => {
			if (url.endsWith("/api/tags")) return jsonResponse({ models: [{ model: "tiny" }] });
			return jsonResponse({ capabilities: ["completion"], model_info: { context_length: 8192 } });
		});
		try {
			const listing = await probeProvider(local());
			expect(listing).toEqual({
				provider: "ollama",
				models: [{ id: "tiny", contextWindow: 8192, maxOutputTokens: 8192, reasoning: false }],
				complete: true,
			});
		} finally {
			restore();
		}
	});

	test("the cloud provider is dispatched the same way, under its own name", async () => {
		const keyRestore = withEnv("OLLAMA_API_KEY", "cloud-key");
		const urls: string[] = [];
		const restore = stubFetch((url) => {
			urls.push(url);
			return urls.length === 1
				? jsonResponse({ models: [{ model: "kimi-k3" }] })
				: jsonResponse({ capabilities: ["completion"], model_info: { context_length: 1_048_576 } });
		});
		try {
			const listing = await probeProvider(cloud());
			// The provider name is the row's own — a cloud listing must not land in
			// the local daemon's catalogue.
			expect(listing?.provider).toBe("ollama-cloud");
			expect(urls[0]).toBe("https://ollama.com/api/tags");
		} finally {
			restore();
			keyRestore();
		}
	});
});
