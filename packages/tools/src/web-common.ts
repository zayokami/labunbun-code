// Shared HTTP plumbing and destination checks for the web tools. The local
// fetch path and the DeepSeek backends both build on this module, so they
// cannot drift on the timeout, the byte cap, the network axis, or the
// truncation marker.
// Long-form design notes: docs/dev/tools.md

import { isIP } from "node:net";
import { decideNetworkRequest, isBlockedAddress, type NetworkAxis, normalizeHost } from "@labunbun/agent";

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 10_000_000;

// Long-form design notes: docs/dev/tools.md
/** The answer of the network axis for `hostname`, as a refusal string or `null`. */
export function refuseByNetworkPolicy(hostname: string, network: NetworkAxis | undefined): string | null {
	if (!network) return null;
	const decision = decideNetworkRequest(network.domains, normalizeHost(hostname), network.access);
	if (decision.allowed) return null;
	return `Network policy refuses ${hostname} (${decision.reason})`;
}

/**
 * The URL checks that need no DNS: the URL parses, the protocol is HTTP(S),
 * the network axis allows the host, the host is not localhost, and a literal
 * address is not in a blocked range. The DeepSeek Fetch backend uses this
 * half alone — the fetch happens on DeepSeek's side, so a local lookup would
 * judge a resolution that the fetch never uses.
 */
export function guardUrlWithoutDns(rawUrl: string, network: NetworkAxis | undefined): string | null {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return "Invalid URL";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `Unsupported protocol: ${url.protocol}`;
	}
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const policyRefusal = refuseByNetworkPolicy(hostname, network);
	if (policyRefusal) return policyRefusal;
	if (hostname.toLowerCase() === "localhost") return "Requests to localhost are not allowed";
	if (isIP(hostname) && isBlockedAddress(hostname)) return "Requests to private/internal addresses are not allowed";
	return null;
}

/** The one cut both fetch backends apply: the head, and a marker for what was removed. */
export function truncateWithMarker(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}\n\n[truncated ${text.length - cap} chars]` : text;
}

export async function fetchWithTimeout(url: string, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	// The run's own cancel has to reach the request too, or an interrupted turn
	// stays parked on the network until the timeout above expires.
	const onAbort = () => controller.abort();
	// A signal that aborted before this listener was attached never fires
	// "abort" again, so the already-aborted case is read first — attaching
	// alone would let the request run on for a caller that already gave up.
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Read a response body up to a byte cap, aborting the stream once exceeded. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				break;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock?.();
	}
	return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}
