/**
 * What `/cache` says, and what the status card borrows from it.
 *
 * The number this prints is the honest one: the share of every prompt token
 * that was served from the provider's cache over the conversation so far. It
 * comes with the ceiling beside it, because a hit rate on its own is not a
 * verdict — a request can only read what an earlier request wrote, so the best
 * a conversation of this shape could ever have done is
 * `sum(previous prompts) / sum(prompts)`, and at 200 turns that ceiling is
 * itself only about 99%. Printing the achieved share next to it turns "96%" from
 * a grade into a diagnosis: at the ceiling the machinery is doing everything it
 * can and the workload is the limit; below it, tokens were thrown away and the
 * rewind lines below say where.
 *
 * Everything that legitimately costs a cache hit is counted rather than hidden:
 * the first request (nothing was cached yet), any registered rewrite
 * (compaction, a trimmed history), retries, and requests that were cancelled
 * before the provider answered. A rewind with no registration behind it is the
 * one that means a bug, so it is labelled as one instead of being folded into a
 * total.
 */

import { type CacheNotice, type CacheRequestRecord, cacheCapability, cacheCeiling, type Model } from "@labunbun/ai";

export interface CacheReportInput {
	records: readonly CacheRequestRecord[];
	/** The model the session is on now, for the capability row. */
	model?: Model;
	/** Anything a provider said about the cache settings themselves. */
	notices?: readonly CacheNotice[];
}

function percent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/**
 * The word this report uses for a rewrite the session made on its own.
 *
 * A summary and a set of previews are different events — the report prints them
 * on separate lines, and the user asked for neither — so they are named
 * differently. The mapping lives here rather than inline at the call site
 * because it is the only place it can be checked: from the wire, "compaction"
 * and "trim" are the same rewrite, and a wrong word is invisible everywhere
 * else.
 */
export function rewriteCause(action: "compact" | "reduced"): string {
	return action === "compact" ? "compaction" : "trim";
}

/** The family the user means by "this conversation": the busiest one. */
function mainFamily(records: readonly CacheRequestRecord[]): string | undefined {
	const counts = new Map<string, number>();
	for (const record of records) counts.set(record.family, (counts.get(record.family) ?? 0) + 1);
	let best: string | undefined;
	let bestCount = -1;
	// `>` rather than `>=`: ties go to whichever family was seen last, which is
	// the one in front of the user.
	for (const [family, count] of counts) {
		if (count >= bestCount) {
			best = family;
			bestCount = count;
		}
	}
	return best;
}

/**
 * The capability row: what this provider can do, in the words of its own rules.
 *
 * Printed because every rewind line above is read against it. A provider that
 * caches prefixes automatically has no breakpoints to place, and a reader who
 * does not know that will read "0 breakpoints" as a defect.
 */
function capabilityLine(model: Model): string {
	const capability = cacheCapability(model);
	const minimum =
		capability.minPrefixTokens > 0 ? `min ${capability.minPrefixTokens.toLocaleString()} tokens` : "no minimum";
	const granularity = capability.incrementTokens > 1 ? ` · ${capability.incrementTokens}-token granularity` : "";
	const ttl = capability.ttl.length > 0 ? ` · TTL ${capability.ttl.join(" or ")}` : "";
	const mode = capability.mode === "explicit" ? "explicit breakpoints" : "automatic prefix caching";
	const key = capability.promptCacheKey ? " · routing key supported" : "";
	return `${mode}${granularity} · ${minimum}${ttl}${key}`;
}

/** The one line `/status` puts on the card. */
export function cacheStatusLine(records: readonly CacheRequestRecord[], model?: Model): string {
	const family = mainFamily(records);
	if (family === undefined) return "no requests yet";
	const mine = records.filter((record) => record.family === family);
	const totals = sumTokens(mine);
	const rate = totals.promptTokens > 0 ? totals.read / totals.promptTokens : 0;
	const ceiling = cacheCeiling(
		mine.map((record) => record.promptTotal).filter((total): total is number => total !== undefined),
	);
	const rewinds = mine.filter((record) => record.kind === "rewind").length;
	const ceilingText = ceiling === undefined ? "" : ` · ceiling ${percent(ceiling)}`;
	const rewindText = rewinds === 0 ? "0 rewinds" : `${rewinds} rewind${rewinds === 1 ? "" : "s"}`;
	const capability = model ? ` · ${cacheCapability(model).mode === "explicit" ? "explicit" : "auto"}` : "";
	return `${percent(rate)} read${ceilingText} · ${rewindText}${capability}`;
}

interface TokenTotals {
	read: number;
	write: number;
	input: number;
	output: number;
	promptTokens: number;
	/** Writes by TTL bucket, when any request reported the split. */
	write5m: number;
	write1h: number;
	writeSplit: boolean;
}

function sumTokens(records: readonly CacheRequestRecord[]): TokenTotals {
	const totals: TokenTotals = {
		read: 0,
		write: 0,
		input: 0,
		output: 0,
		promptTokens: 0,
		write5m: 0,
		write1h: 0,
		writeSplit: false,
	};
	for (const record of records) {
		totals.read += record.cacheRead;
		totals.write += record.cacheWrite;
		totals.input += record.input;
		totals.output += record.output;
		if (record.cacheWriteTtl) {
			totals.writeSplit = true;
			totals.write5m += record.cacheWriteTtl["5m"];
			totals.write1h += record.cacheWriteTtl["1h"];
		}
		// The same arithmetic the `Usage` contract uses: the three prompt channels
		// sum to the whole prompt, on both wire formats.
		totals.promptTokens += record.cacheRead + record.cacheWrite + record.input;
	}
	return totals;
}

/** The TTL split of the writes, when the provider reported one. */
function ttlSplit(totals: TokenTotals): string {
	if (!totals.writeSplit) return "";
	return ` (5m ${totals.write5m.toLocaleString()} · 1h ${totals.write1h.toLocaleString()})`;
}

/**
 * One line per provider notice.
 *
 * Printed above the numbers, because a refusal changes what every number below it
 * means — and because the fallback is otherwise invisible: the request succeeds,
 * the tokens are all counted, and the only difference is an entry that expires
 * sooner than the policy asked for.
 */
function noticeLines(notices: readonly CacheNotice[]): string[] {
	return notices.map((notice) => {
		const from = notice.from ?? "the API default";
		const to = notice.to ?? "no ttl field";
		return `  notice       ${from} was refused, using ${to} from here: ${notice.reason}`;
	});
}

/**
 * The full report.
 *
 * Split into a headline, the arithmetic behind it, the prefix's own history and
 * the families underneath, in that order: someone opening `/cache` because a
 * number looked wrong reads the first two lines and then goes looking for a
 * rewind, and someone who has no problem reads the first two and stops.
 */
export function formatCacheReport(input: CacheReportInput): string {
	const { records, model, notices = [] } = input;
	const family = mainFamily(records);
	if (family === undefined) {
		return [
			"Prompt cache: no request has been made yet.",
			"",
			"This reports what the provider actually served from its cache, per request.",
			...noticeLines(notices),
		].join("\n");
	}
	const mine = records.filter((record) => record.family === family);
	const label = mine[mine.length - 1]?.familyLabel ?? family;
	const totals = sumTokens(mine);
	const rate = totals.promptTokens > 0 ? totals.read / totals.promptTokens : 0;
	const ceiling = cacheCeiling(
		mine.map((record) => record.promptTotal).filter((total): total is number => total !== undefined),
	);

	const lines: string[] = [`Prompt cache — ${label}`];
	lines.push(...noticeLines(notices));
	const reasks = mine.filter((record) => record.kind === "reask").length;
	const interrupted = mine.filter((record) => record.outcome !== "reported").length;
	const counts = `${mine.length} request${mine.length === 1 ? "" : "s"}`;
	const extras: string[] = [];
	if (reasks > 0) extras.push(`${reasks} re-asked`);
	if (interrupted > 0) extras.push(`${interrupted} not answered`);
	lines.push(`  requests     ${counts}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`);

	lines.push(
		`  tokens       ${totals.read.toLocaleString()} read · ${totals.write.toLocaleString()} written` +
			`${ttlSplit(totals)} · ${totals.input.toLocaleString()} full price · ${totals.output.toLocaleString()} out`,
	);

	if (ceiling === undefined) {
		lines.push(`  hit rate     ${percent(rate)} read (no ceiling yet: one request cannot read anything)`);
	} else {
		const reachable = ceiling > 0 ? rate / ceiling : 0;
		lines.push(
			`  hit rate     ${percent(rate)} read · ceiling ${percent(ceiling)} for this shape ` +
				`(${percent(Math.min(1, reachable))} of what is reachable)`,
		);
	}

	const cold = mine.filter((record) => record.kind === "first").length;
	const extensions = mine.filter((record) => record.kind === "extension").length;
	const rewinds = mine.filter((record) => record.kind === "rewind");
	lines.push(
		`  prefix       ${extensions} extension${extensions === 1 ? "" : "s"} · ` +
			`${cold} cold start${cold === 1 ? "" : "s"} · ${rewinds.length} rewind${rewinds.length === 1 ? "" : "s"}`,
	);
	for (const rewind of rewinds) {
		const where = rewind.divergence
			? rewind.divergence.scope === "messages"
				? `message ${rewind.divergence.messageIndex}`
				: rewind.divergence.scope
			: "unknown position";
		// Registered rewrites are the ones the app knew it was doing. The others are
		// the reason this report exists: something changed the prefix that no code
		// admitted to, and every token after it was paid for again.
		const why = rewind.causes.length > 0 ? rewind.causes.join(" + ") : "UNREGISTERED — nothing declared this rewrite";
		lines.push(`  rewind       turn ${rewind.turn}: ${where} · ${why}`);
	}

	if (totals.read === 0 && rewinds.length === 0 && mine.length > 1) {
		// Stable bytes and no reads is not a prefix problem, and saying so stops the
		// reader from hunting for one. The causes below are what is left.
		lines.push(
			"  note         the prefix never changed, so the provider chose not to serve it:",
			"               an expired entry, a model-scoped cache, or a request setting it keys on.",
		);
	}

	if (records.length !== mine.length) {
		const others = new Map<string, number>();
		for (const record of records) {
			if (record.family === family) continue;
			others.set(record.familyLabel, (others.get(record.familyLabel) ?? 0) + 1);
		}
		const rendered = [...others.entries()].map(([name, count]) => `${name} ${count}`);
		lines.push(`  other families  ${rendered.join(" · ")}`);
	}

	if (model) lines.push(`  capability   ${capabilityLine(model)}`);
	return lines.join("\n");
}
