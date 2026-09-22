/**
 * `/cache`, as the user meets it.
 *
 * Two things are under test here and they are different: the arithmetic the
 * report does over a set of recorded requests — the hit rate, the ceiling it is
 * measured against, and which rewrites get named — and the wiring that puts that
 * report in the transcript. The first is pinned with hand-built records so the
 * numbers are checkable by hand; the second runs a real tracker over a real
 * stream function, because a report that is right in isolation and unreachable
 * from the command is not a report.
 */
import { describe, expect, test } from "bun:test";
import { type CacheRequestRecord, type Context, withCacheTracker } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { cacheStatusLine, formatCacheReport } from "../src/cache-report.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const MODEL = {
	id: "claude-sonnet-5",
	name: "Claude Sonnet 5",
	api: "anthropic-messages" as const,
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	apiKeyEnv: "ANTHROPIC_API_KEY",
	contextWindow: 200_000,
	maxOutputTokens: 64_000,
	reasoning: true,
	input: ["text" as const],
};

function record(overrides: Partial<CacheRequestRecord> = {}): CacheRequestRecord {
	return {
		family: "fam-1",
		familyLabel: "anthropic/claude-sonnet-5",
		turn: 1,
		at: 0,
		kind: "extension",
		causes: [],
		cacheRead: 0,
		cacheWrite: 0,
		input: 0,
		output: 0,
		reported: true,
		outcome: "reported",
		...overrides,
	};
}

/** The shape a healthy two-request conversation makes: write, then read. */
const WRITE_THEN_READ: CacheRequestRecord[] = [
	record({ turn: 1, kind: "first", cacheWrite: 1000, promptTotal: 1000 }),
	record({ turn: 2, cacheRead: 1000, cacheWrite: 100, input: 100, promptTotal: 1200 }),
];

describe("formatCacheReport", () => {
	test("says so when nothing has been asked yet", () => {
		const text = formatCacheReport({ records: [] });
		expect(text).toContain("no request has been made yet");
	});

	test("reports the read share and the ceiling for this conversation's shape", () => {
		const text = formatCacheReport({ records: WRITE_THEN_READ, model: MODEL });
		expect(text).toContain("Prompt cache — anthropic/claude-sonnet-5");
		expect(text).toContain("2 requests");
		// 1000 read of 2200 prompt tokens; the ceiling is the same 1000/2200
		// because the second request is the last one and can read the first.
		expect(text).toContain("45.5% read");
		expect(text).toContain("ceiling 45.5%");
		expect(text).toContain("100.0% of what is reachable");
		expect(text).toContain("1,000 read · 1,100 written · 100 full price");
	});

	test("names the prefix's history and the capability behind it", () => {
		const text = formatCacheReport({ records: WRITE_THEN_READ, model: MODEL });
		expect(text).toContain("1 extension · 1 cold start · 0 rewinds");
		expect(text).toContain("explicit breakpoints");
		expect(text).toContain("min 1,024 tokens");
		expect(text).toContain("TTL 5m or 1h");
	});

	test("a registered rewrite is named; an unregistered one is a bug and says so", () => {
		const text = formatCacheReport({
			records: [
				...WRITE_THEN_READ,
				record({
					turn: 3,
					kind: "rewind",
					divergence: { scope: "messages", messageIndex: 12 },
					causes: ["compaction"],
				}),
				record({ turn: 4, kind: "rewind", divergence: { scope: "tools" } }),
			],
		});
		expect(text).toContain("rewind       turn 3: message 12 · compaction");
		expect(text).toContain("rewind       turn 4: tools · UNREGISTERED — nothing declared this rewrite");
		expect(text).toContain("2 rewinds");
	});

	test("stable bytes with no reads points at the provider instead of the prefix", () => {
		// Every request extended the one before it, and nothing was ever served
		// from cache: the prefix is not the problem, so the report says so.
		const text = formatCacheReport({
			records: [
				record({ turn: 1, kind: "first", input: 500, promptTotal: 500 }),
				record({ turn: 2, input: 600, promptTotal: 600 }),
			],
		});
		expect(text).toContain("the prefix never changed");
	});

	test("counts retries and unanswered requests apart from the real ones", () => {
		const text = formatCacheReport({
			records: [
				...WRITE_THEN_READ,
				record({ turn: 3, kind: "reask" }),
				record({ turn: 4, kind: "extension", outcome: "cancelled", reported: false }),
			],
		});
		expect(text).toContain("4 requests (1 re-asked, 1 not answered)");
	});

	test("a second family is listed rather than folded into the headline", () => {
		// A subagent (or a compaction summary) shares neither prompt nor tools, so
		// its requests are not this conversation's — but hiding them would make the
		// numbers here disagree with the bill.
		const text = formatCacheReport({
			records: [...WRITE_THEN_READ, record({ family: "fam-2", familyLabel: "anthropic/claude-haiku-4-5", turn: 1 })],
		});
		expect(text).toContain("2 requests");
		expect(text).toContain("other families  anthropic/claude-haiku-4-5 1");
	});

	test("one request has no ceiling yet, because there was nothing to read", () => {
		const text = formatCacheReport({ records: [record({ kind: "first", input: 900, promptTotal: 900 })] });
		expect(text).toContain("no ceiling yet");
	});

	test("a refused cache setting is printed above the numbers it changes", () => {
		const text = formatCacheReport({
			records: WRITE_THEN_READ,
			notices: [
				{
					kind: "ttl-downgrade",
					from: "1h",
					to: "5m",
					reason: "1h cache ttl is not supported for this model",
				},
			],
		});
		const lines = text.split("\n");
		expect(lines[1]).toBe(
			"  notice       1h was refused, using 5m from here: 1h cache ttl is not supported for this model",
		);
		// Above the headline: a setting that was refused is what makes a low read
		// share explicable, so it is read before the share, not after it.
		expect(lines.findIndex((line) => line.includes("notice"))).toBeLessThan(
			lines.findIndex((line) => line.includes("hit rate")),
		);
	});

	test("a refusal is reported even when no request has been made yet", () => {
		// The refused setting is in force, and it is the reason the next request will
		// be shaped the way it is — so it is not withheld until there are numbers.
		const text = formatCacheReport({
			records: [],
			notices: [{ kind: "ttl-downgrade", from: undefined, to: undefined, reason: "no ttl field in this API" }],
		});
		expect(text).toContain("no request has been made yet");
		expect(text).toContain("the API default was refused, using no ttl field from here: no ttl field in this API");
	});

	test("writes are split by TTL bucket when the provider said which bucket", () => {
		const text = formatCacheReport({
			records: [
				record({
					turn: 1,
					kind: "first",
					cacheWrite: 3501,
					cacheWriteTtl: { "5m": 0, "1h": 3501 },
					promptTotal: 3501,
				}),
			],
		});
		expect(text).toContain("0 read · 3,501 written (5m 0 · 1h 3,501) · 0 full price");
	});

	test("no split is claimed for requests that did not report one", () => {
		// A provider that reports no breakdown gets no parenthetical, rather than a
		// "(5m 0 · 1h 1,100)" that would read as a measurement nobody made.
		const text = formatCacheReport({ records: WRITE_THEN_READ });
		expect(text).toContain("1,000 read · 1,100 written · 100 full price");
	});
});

describe("cacheStatusLine", () => {
	test("no requests is a sentence, not a zero", () => {
		expect(cacheStatusLine([], MODEL)).toBe("no requests yet");
	});

	test("carries the rate, the ceiling and the rewinds", () => {
		const line = cacheStatusLine(WRITE_THEN_READ, MODEL);
		expect(line).toBe("45.5% read · ceiling 45.5% · 0 rewinds · explicit");
	});

	test("counts one rewind in the singular", () => {
		const line = cacheStatusLine([...WRITE_THEN_READ, record({ kind: "rewind" })], MODEL);
		expect(line).toContain("1 rewind ·");
	});
});

describe("/cache", () => {
	function makeCtx(cache?: { report(): string; statusLine(): string }) {
		const store = createStore<UiState>({ ...initialUiState(false) });
		const ctx = {
			getSession: () => undefined,
			handle: { store },
			cache,
		} as unknown as AppCommandContext;
		const text = () =>
			store
				.get()
				.entries.filter((entry) => entry.kind === "info")
				.map((entry) => (entry as { text: string }).text)
				.join("\n");
		return { ctx, text };
	}

	test("prints the report", () => {
		const h = makeCtx({ report: () => "REPORT", statusLine: () => "LINE" });
		expect(handleAppCommand("/cache", h.ctx)).toBe(true);
		expect(h.text()).toBe("REPORT");
	});

	test("says there is nothing to report when the session does not track", () => {
		const h = makeCtx(undefined);
		expect(handleAppCommand("/cache", h.ctx)).toBe(true);
		expect(h.text()).toContain("does not track the prompt cache");
	});

	test("a real tracker's records reach the transcript", async () => {
		// The production path: requests are observed by the tracker in `ai`, and
		// this is what `/cache` shows for them. The first request can only have
		// written — nothing existed to read — which is what makes the ceiling
		// below it meaningful rather than decorative.
		let call = 0;
		const { streamFn, tracker } = withCacheTracker(async function* (_model, _context: Context) {
			call++;
			const usage =
				call === 1
					? { input: 0, output: 10, cacheRead: 0, cacheWrite: 1000, promptTotal: 1000 }
					: { input: 200, output: 10, cacheRead: 800, cacheWrite: 0, promptTotal: 1000 };
			yield {
				type: "start" as const,
				partial: {
					role: "assistant" as const,
					content: [],
					provider: "",
					model: "",
					stopReason: "pending" as const,
					timestamp: 0,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			};
			yield {
				type: "done" as const,
				message: {
					role: "assistant" as const,
					content: [],
					provider: "anthropic",
					model: "claude-sonnet-5",
					stopReason: "stop" as const,
					timestamp: 0,
					usage,
				},
			};
		});
		for (const count of [1, 2]) {
			const messages = Array.from({ length: count }, (_, i) => ({
				role: "user" as const,
				content: `ask ${i}`,
				timestamp: 0,
			}));
			for await (const _event of streamFn(MODEL, { systemPrompt: "sys", messages })) {
				// drained: the tracker records on the terminal event
			}
		}

		const h = makeCtx({
			report: () => formatCacheReport({ records: tracker.records(), model: MODEL }),
			statusLine: () => cacheStatusLine(tracker.records(), MODEL),
		});
		handleAppCommand("/cache", h.ctx);
		const text = h.text();
		expect(text).toContain("2 requests");
		// 800 read of 2000 prompt tokens, against a ceiling of 1000/2000.
		expect(text).toContain("40.0% read");
		expect(text).toContain("ceiling 50.0%");
		expect(text).toContain("80.0% of what is reachable");
		expect(text).toContain("1 extension · 1 cold start");
	});
});
