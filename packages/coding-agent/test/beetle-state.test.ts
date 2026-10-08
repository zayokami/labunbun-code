/**
 * Beetle's ledger file: what it survives being handed.
 *
 * The file is a ledger of our own writing, not a hand-maintained setting, so
 * every unreadable or misshapen input resolves to a smaller ledger — never an
 * error — and the next write replaces it. The member and band predicates keep
 * `/beetle status` from ever printing NaN out of a hand-edited file.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BeetleBandRecord,
	type BeetleState,
	beetleStatePath,
	emptyBeetleState,
	foldBandInto,
	readBeetleState,
	writeBeetleState,
} from "../src/beetle-state.ts";

function freshHome(): string {
	return mkdtempSync(join(tmpdir(), "lbb-beetle-state-"));
}

/** Hand-write the ledger file, hand-edited-state style: the directory made first. */
function seedLedger(home: string, text: string): void {
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(beetleStatePath(home), text, "utf8");
}

const BAND: BeetleBandRecord = {
	task: "fix the parser",
	startedAt: "2026-10-08T10:00:00.000Z",
	disbandedAt: "2026-10-08T10:30:00.000Z",
	active: false,
	members: [{ name: "john", turns: 2, costUSD: 0.5 }],
	costUSD: 0.5,
	turns: 2,
};

describe("the beetle ledger file", () => {
	test("writes a state and reads it back unchanged", () => {
		const home = freshHome();
		const state: BeetleState = { lastBand: BAND, lifetime: { bands: 3, costUSD: 1.25, turns: 9 } };
		writeBeetleState(state, home);
		expect(readBeetleState(home)).toEqual(state);
	});

	test("a missing file reads as an empty ledger", () => {
		expect(readBeetleState(freshHome())).toEqual(emptyBeetleState());
	});

	test("an unreadable file reads as empty and the next write replaces it", () => {
		const home = freshHome();
		seedLedger(home, "{ not json at all");
		expect(readBeetleState(home)).toEqual(emptyBeetleState());
		// Overwritten, not protected: unlike the settings file, losing this
		// content loses book-keeping, not anything the user wrote.
		const state: BeetleState = { lastBand: null, lifetime: { bands: 1, costUSD: 0, turns: 4 } };
		writeBeetleState(state, home);
		expect(readBeetleState(home)).toEqual(state);
	});

	test("a misshapen file keeps only the parts shaped like a ledger", () => {
		const home = freshHome();
		// Raw text, not JSON.stringify: `1e999` parses as Infinity — the one
		// number JSON can carry that must never reach a `/beetle status` line.
		seedLedger(
			home,
			'{"lastBand": {"task": 5, "startedAt": "2026-10-08T10:00:00.000Z", "active": "yes"}, "lifetime": {"bands": 1e999, "costUSD": "lots", "turns": 2}}',
		);
		// The band fails its predicate whole (no task string); the lifetime keeps
		// finite numbers and zeroes the rest.
		expect(readBeetleState(home)).toEqual({ lastBand: null, lifetime: { bands: 0, costUSD: 0, turns: 2 } });
	});

	test("a member record without a name is dropped, its band kept", () => {
		const home = freshHome();
		seedLedger(
			home,
			JSON.stringify({
				lastBand: {
					...BAND,
					members: [
						{ turns: 1, costUSD: 0 },
						{ name: "paul", turns: 3, costUSD: 2 },
					],
				},
				lifetime: { bands: 1, costUSD: 0, turns: 0 },
			}),
		);
		expect(readBeetleState(home).lastBand?.members).toEqual([{ name: "paul", turns: 3, costUSD: 2 }]);
	});

	test("folding a band adds its spend and turns to the lifetime", () => {
		const lifetime = { bands: 3, costUSD: 1.25, turns: 9 };
		foldBandInto(lifetime, BAND);
		expect(lifetime).toEqual({ bands: 3, costUSD: 1.75, turns: 11 });
		// Bands were counted when they started; folding must not count one twice.
	});
});
