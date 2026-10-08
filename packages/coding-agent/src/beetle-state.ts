/**
 * The band's ledger file: the last band's record, and the lifetime totals.
 *
 * The settings file treats unreadable content as an error because the user
 * wrote it. This file runs the other way: it is the app's own book-keeping, so
 * anything unreadable or misshapen reads as a smaller — or empty — ledger, and
 * the next write replaces it. The sanitizers exist so `/beetle status`, which
 * prints these numbers straight into a line, can never say NaN.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One member's line in a recorded band. */
export interface BeetleMemberRecord {
	name: string;
	turns: number;
	costUSD: number;
}

export interface BeetleBandRecord {
	task: string;
	startedAt: string;
	/** The disband time; null while none was recorded (a crash leaves it null). */
	disbandedAt: string | null;
	/** True while the recording process was still running the band. */
	active: boolean;
	members: BeetleMemberRecord[];
	costUSD: number;
	turns: number;
}

/** Bands are counted at start; spend and turns fold in when a band deactivates. */
export interface BeetleLifetime {
	bands: number;
	costUSD: number;
	turns: number;
}

export interface BeetleState {
	lastBand: BeetleBandRecord | null;
	lifetime: BeetleLifetime;
}

export function beetleStatePath(home = homedir()): string {
	return join(home, ".labunbun", "beetle-state.json");
}

export function emptyBeetleState(): BeetleState {
	return { lastBand: null, lifetime: { bands: 0, costUSD: 0, turns: 0 } };
}

/**
 * Fold a disbanded (or crash-abandoned) band into the lifetime.
 *
 * The caller owns the once-only rule: this adds whatever the record holds, and
 * a record folded twice would be counted twice — the guards live at the two
 * call sites (the active→inactive edge, and the crash residue at the next
 * start), each of which fires exactly once per band.
 */
export function foldBandInto(lifetime: BeetleLifetime, band: BeetleBandRecord): void {
	lifetime.costUSD += band.costUSD;
	lifetime.turns += band.turns;
}

function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeMember(value: unknown): BeetleMemberRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string") return null;
	return { name: record.name, turns: finiteOr(record.turns, 0), costUSD: finiteOr(record.costUSD, 0) };
}

/**
 * Whole or nothing: a band that cannot say what its task was is not a record,
 * so it is dropped rather than half-filled. The members inside are per-line,
 * so one misshapen member loses only itself.
 */
function sanitizeBand(value: unknown): BeetleBandRecord | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.task !== "string" || typeof record.startedAt !== "string") return null;
	return {
		task: record.task,
		startedAt: record.startedAt,
		disbandedAt: typeof record.disbandedAt === "string" ? record.disbandedAt : null,
		active: record.active === true,
		members: Array.isArray(record.members)
			? record.members.map(sanitizeMember).filter((member): member is BeetleMemberRecord => member !== null)
			: [],
		costUSD: finiteOr(record.costUSD, 0),
		turns: finiteOr(record.turns, 0),
	};
}

/** Missing, unreadable, or not JSON at all: an empty ledger, never an error. */
export function readBeetleState(home = homedir()): BeetleState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(beetleStatePath(home), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return emptyBeetleState();
		const record = parsed as Record<string, unknown>;
		const lifetime = (typeof record.lifetime === "object" && record.lifetime !== null ? record.lifetime : {}) as Record<
			string,
			unknown
		>;
		return {
			lastBand: sanitizeBand(record.lastBand),
			lifetime: {
				bands: finiteOr(lifetime.bands, 0),
				costUSD: finiteOr(lifetime.costUSD, 0),
				turns: finiteOr(lifetime.turns, 0),
			},
		};
	} catch {
		return emptyBeetleState();
	}
}

/** Failures are the caller's to report — the write itself only writes. */
export function writeBeetleState(state: BeetleState, home = homedir()): void {
	const path = beetleStatePath(home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}
