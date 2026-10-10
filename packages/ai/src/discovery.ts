// Long-form design notes: docs/dev/ai-layer.md
/** Ask the providers what they serve. */
import {
	allModels,
	applyBaseUrlOverrides,
	type DiscoveredModel,
	resolveApiKey,
	setProviderCatalogue,
} from "./model.ts";
import { listAnthropicModels } from "./providers/anthropic.ts";
import { listOpenAIModels, type OpenAIModelsClientLike } from "./providers/openai-compat.ts";
import type { Model } from "./types.ts";

/**
 * How long a provider gets to answer before it counts as unreachable. A catalog
 * listing is a nicety; five seconds of a background nicety is already generous.
 */
const DISCOVERY_TIMEOUT_MS = 5_000;

/** What one provider said about itself. */
export interface DiscoveredListing {
	provider: string;
	models: DiscoveredModel[];
	/** False when the listing may be missing ids — it then hides nothing. */
	complete: boolean;
}

/**
 * Ask one provider. Answers `undefined` when the answer cannot be used, which is
 * the same outcome as a rejection — the caller treats both as "not probed".
 * Injectable so tests can answer without a network.
 */
export type CatalogProbe = (model: Model, signal?: AbortSignal) => Promise<DiscoveredListing | undefined>;

/** What changed, so the caller can say so. */
export interface CatalogRefresh {
	/** Providers that answered. The rest were left alone. */
	checked: string[];
	/** Refs the picker stopped offering. */
	dropped: string[];
	/** Refs the table did not have. */
	added: string[];
}

/**
 * Refresh the catalog from the providers. Returns what changed, or `undefined`
 * when nobody answered — in which case nothing changed and there is nothing to
 * report. Never throws: a probe that blows up is one provider not answering.
 */
export async function refreshModelCatalog(options?: {
	probe?: CatalogProbe;
	signal?: AbortSignal;
	models?: Model[];
}): Promise<CatalogRefresh | undefined> {
	const candidates = options?.models ?? providersWithKeys();
	if (candidates.length === 0) return undefined;

	// One deadline for the whole refresh, plus whatever the caller uses to give
	// up (the app aborts at exit, so a probe in flight cannot hold the process
	// open after the user has quit).
	const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const probe = options?.probe ?? probeProvider;

	const listings = await Promise.all(
		candidates.map(async (model) => {
			try {
				return await probe(applyBaseUrlOverrides(model), signal);
			} catch {
				// One provider's bad day is not the catalog's problem.
				return undefined;
			}
		}),
	);

	const refresh: CatalogRefresh = { checked: [], dropped: [], added: [] };
	for (const listing of listings) {
		// An empty listing is a provider that did not answer, not one that serves
		// nothing: hiding the whole catalog behind a blank response would be the
		// worst possible reading of it.
		if (!listing || listing.models.length === 0) continue;
		const { added, dropped } = setProviderCatalogue(listing.provider, listing.models, {
			complete: listing.complete,
		});
		refresh.checked.push(listing.provider);
		refresh.added.push(...added.map((id) => `${listing.provider}/${id}`));
		refresh.dropped.push(...dropped.map((id) => `${listing.provider}/${id}`));
	}

	return refresh.checked.length > 0 ? refresh : undefined;
}

/**
 * One model per provider that has a key: the probe needs a credential and a base
 * URL, and every model of a provider answers the same listing.
 */
function providersWithKeys(): Model[] {
	const byProvider = new Map<string, Model>();
	for (const model of allModels()) {
		if (byProvider.has(model.provider) || !resolveApiKey(model)) continue;
		byProvider.set(model.provider, model);
	}
	return [...byProvider.values()];
}

// Long-form design notes: docs/dev/ai-layer.md
/** The catalog request for one model, as the startup refresh makes it. */
export async function probeProvider(
	model: Model,
	signal?: AbortSignal,
	openaiClient?: OpenAIModelsClientLike,
): Promise<DiscoveredListing | undefined> {
	if (model.api === "anthropic-messages") {
		const listing = await listAnthropicModels(model, { signal });
		return { provider: model.provider, models: listing.models, complete: listing.complete };
	}
	if (model.api === "openai-completions" || model.api === "openai-responses") {
		// One lister for both OpenAI wires, because the catalog is not part of
		// either: `GET /models` is the same request on both and answers the same
		// shape. Splitting this by wire would need a second copy of an endpoint
		// that does not differ.
		const listing = await listOpenAIModels(model, { client: openaiClient, signal });
		return { provider: model.provider, models: listing.models, complete: listing.complete };
	}
	// An API this module has no listing call for is one it cannot check.
	return undefined;
}

/** How many refs a notice names before it stops naming them. */
const NOTICE_LIMIT = 3;

function nameRefs(refs: string[]): string {
	const shown = refs.slice(0, NOTICE_LIMIT).join(", ");
	return refs.length > NOTICE_LIMIT ? `${shown} and ${refs.length - NOTICE_LIMIT} more` : shown;
}

// Long-form design notes: docs/dev/ai-layer.md
/** One line about what the refresh changed, or `undefined` when it changed nothing. */
export function formatCatalogNotice(refresh: CatalogRefresh | undefined): string | undefined {
	if (!refresh) return undefined;
	const parts: string[] = [];
	if (refresh.dropped.length > 0) {
		parts.push(
			`${nameRefs(refresh.dropped)} not listed by the provider any more — hidden from /model, still usable by name`,
		);
	}
	if (refresh.added.length > 0) {
		parts.push(`${nameRefs(refresh.added)} added from the provider's listing — no price, declare one in settings.json`);
	}
	if (parts.length === 0) return undefined;
	return `Model catalog refreshed: ${parts.join("; ")}.`;
}
