// Long-form design notes: docs/dev/ai-layer.md
/** Ollama's native catalog: `GET /api/tags` for the ids, `POST /api/show` for what each one is. */
import { type DiscoveredModel, resolveApiKey } from "../model.ts";
import type { Model } from "../types.ts";

/** `GET /api/tags` answers with one entry per model the daemon or account serves. */
interface OllamaTagsPage {
	models?: Array<{ name?: string; model?: string }>;
}

/** The part of one `POST /api/show` answer this lister reads. */
interface OllamaShowPage {
	capabilities?: string[];
	model_info?: Record<string, unknown>;
}

/**
 * The OpenAI wire lives under `/v1` and the native API does not: the base URL
 * ends in `/v1`, the root does not, and the difference is exactly that suffix.
 */
export function ollamaNativeRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * The context window `model_info` states, under `<architecture>.context_length`.
 * The prefix is the architecture, which the id cannot predict: `kimi-k3` states
 * `kimi-k3.context_length` but `kimi-k2.6` states `kimi-k2.context_length`, and
 * one model reports the key with no prefix at all. So the suffix is the only
 * invariant there is. First match wins; in practice there is exactly one.
 */
function contextLengthFrom(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) return undefined;
	for (const [key, value] of Object.entries(modelInfo)) {
		if ((key === "context_length" || key.endsWith(".context_length")) && typeof value === "number" && value > 0) {
			return value;
		}
	}
	return undefined;
}

// Long-form design notes: docs/dev/ai-layer.md
/**
 * What the daemon — or the cloud account — actually serves, read off the
 * native API. `/v1/models` answers here too, but with ids and nothing else: no
 * window, no capabilities. That is not enough for a row, because a discovered
 * model needs both limits and needs to say whether it thinks.
 */
export async function listOllamaModels(
	model: Model,
	options?: { signal?: AbortSignal; fetch?: typeof fetch },
): Promise<{ models: DiscoveredModel[]; complete: boolean }> {
	const doFetch = options?.fetch ?? fetch;
	const root = ollamaNativeRoot(model.baseUrl);
	const apiKey = resolveApiKey(model);
	const headers: Record<string, string> = { "content-type": "application/json" };
	// A local daemon takes its requests without one; the cloud host wants its key.
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;

	const tagsResponse = await doFetch(`${root}/api/tags`, { headers, signal: options?.signal });
	if (!tagsResponse.ok) {
		throw new Error(`Ollama catalog request failed: ${tagsResponse.status} ${tagsResponse.statusText}`);
	}
	const tags = (await tagsResponse.json()) as OllamaTagsPage;

	const models = await Promise.all(
		(tags.models ?? []).map(async (entry): Promise<DiscoveredModel | undefined> => {
			const id = entry.model ?? entry.name;
			if (!id) return undefined;
			// One model whose show page will not answer is still a model the daemon
			// serves, so the id stands; what goes missing is the row's detail, not
			// the model.
			let show: OllamaShowPage | undefined;
			try {
				const showResponse = await doFetch(`${root}/api/show`, {
					method: "POST",
					headers,
					signal: options?.signal,
					body: JSON.stringify({ model: id }),
				});
				if (showResponse.ok) show = (await showResponse.json()) as OllamaShowPage;
			} catch {
				show = undefined;
			}

			// A capability list that names no `completion` is the daemon saying this
			// model is not one to chat with — an embedding model, say — and a row
			// for it would be a picker entry that can only fail. Silence is not that
			// statement: a server too old to report capabilities keeps its models.
			const capabilities = show?.capabilities;
			if (capabilities && capabilities.length > 0 && !capabilities.includes("completion")) return undefined;

			const contextWindow = contextLengthFrom(show?.model_info);
			// No separate output cap is stated anywhere in the answer, so the window
			// stands in for one — the same reading the Mistral rows take.
			return {
				id,
				...(contextWindow !== undefined ? { contextWindow, maxOutputTokens: contextWindow } : {}),
				...(capabilities ? { reasoning: capabilities.includes("thinking") } : {}),
			};
		}),
	);

	// The tags page is the whole catalog — a model pulled after this answer is
	// simply not in it — so what it lists is complete and a model missing from
	// it may be hidden.
	return { models: models.filter((entry): entry is DiscoveredModel => entry !== undefined), complete: true };
}
