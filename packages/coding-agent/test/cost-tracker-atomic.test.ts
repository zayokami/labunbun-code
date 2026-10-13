/**
 * The cost ledger is replaced, never truncated in place.
 *
 * `CostTracker.persist()` runs after every assistant message, and the file it
 * writes is read-modify-written for as long as the project lives. A write that
 * lands directly on that file and is interrupted — a kill, a crash, a full
 * disk — leaves a truncated ledger, and the next start treats the file as
 * unreadable: it is quarantined, one warning goes to stderr, and `/cost`
 * reports the directory's whole history as zero. This is the file whose loss
 * the user notices last and can least repair.
 *
 * The interruption is driven with a mocked `writeFileSync` in a child process,
 * because `mock.module` outlives the file that called it (see
 * `cache-prefix-stability.test.ts`): the write reaches the file it is given
 * and then throws, which is the shape of a death mid-write.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type CostState, loadCostState, saveCostState } from "../src/cost-tracker.ts";

const roots: string[] = [];
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}
// The child process is the point (see the header), so cleanup is per-test.
process.on("exit", () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The history a project would already have, before the interrupted write. */
const SEED: CostState = {
	totalCostUSD: 12.5,
	totalDurationMs: 4200,
	modelsUsage: {
		"anthropic/claude-sonnet-5": {
			inputTokens: 1000,
			outputTokens: 2000,
			cacheReadTokens: 30,
			cacheWriteTokens: 40,
			reasoningTokens: 10,
			costUSD: 0.5,
			subagentCostUSD: 0,
		},
	},
};

/** The state the interrupted write was trying to save. */
function nextState(): CostState {
	return {
		...SEED,
		totalCostUSD: SEED.totalCostUSD + 1,
		modelsUsage: {
			...SEED.modelsUsage,
			"faux/faux-1": {
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUSD: 0,
				subagentCostUSD: 0,
			},
		},
	};
}

/**
 * Save over an existing ledger in a child process whose `writeFileSync` fails
 * partway through, after the bytes it managed have reached the file.
 *
 * Returns what the write did — the failure has to come back, not be swallowed
 * inside the saver — and leaves the ledger on disk for the assertions.
 */
async function interruptedSave(path: string): Promise<{ outcome: string; message?: string }> {
	const script = `
		import { mock } from "bun:test";
		import * as fs from "node:fs";
		import { writeFileSync as realWriteFileSync } from "node:fs";
		const realWrite = realWriteFileSync;
		mock.module("node:fs", () => ({
			...fs,
			// A death mid-write: the first bytes land, the call never returns.
			writeFileSync: (target, data) => {
				realWrite(target, String(data).slice(0, 12));
				throw new Error("simulated crash mid-write");
			},
		}));
		const { saveCostState } = await import("./src/cost-tracker.ts");
		try {
			saveCostState(${JSON.stringify(path)}, ${JSON.stringify(nextState())});
			console.log(JSON.stringify({ outcome: "returned" }));
		} catch (error) {
			console.log(JSON.stringify({ outcome: "threw", message: error.message }));
		}
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout.trim()) as { outcome: string; message?: string };
}

function seededLedger(): { path: string; dir: string } {
	const dir = scratch("lbb-cost-atomic-");
	const path = join(dir, "costs.json");
	writeFileSync(path, JSON.stringify(SEED, null, 2), "utf8");
	return { path, dir };
}

describe("an interrupted cost ledger write", () => {
	test("leaves the ledger that was there whole, and the history still readable", async () => {
		const { path, dir } = seededLedger();

		const result = await interruptedSave(path);

		// The failure reaches the caller, which is what lets persist() decide to
		// swallow it — as it always has — instead of a partial write passing for a
		// saved one.
		expect(result.outcome).toBe("threw");
		// The ledger the project has been accumulating is the one still on disk,
		// byte for byte.
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(SEED, null, 2));
		// And it is still readable: no quarantine, no empty state, no warning. The
		// history /cost shows after a crash is the same history it showed before.
		expect(loadCostState(path)).toEqual(SEED);
		// Nothing half-written survives the failure to be mistaken for a ledger by
		// the next reader or writer.
		expect(readdirSync(dir)).toEqual(["costs.json"]);
	});

	test("a completed save still replaces the ledger and leaves no temp behind", () => {
		const { path, dir } = seededLedger();

		saveCostState(path, nextState());

		expect(readdirSync(dir)).toEqual(["costs.json"]);
		expect(loadCostState(path)).toEqual(nextState());
	});

	test("a first save creates the project directory", () => {
		const home = scratch("lbb-cost-fresh-");
		const path = join(home, "projects", "some-cwd", "costs.json");

		saveCostState(path, SEED);

		expect(readdirSync(dirname(path))).toEqual(["costs.json"]);
		expect(loadCostState(path)).toEqual(SEED);
	});

	test("the project directory that could not be created is reported, not swallowed here", () => {
		// `persist()` is the caller that decides this is best-effort; the saver
		// itself must not lose the failure of a write it did not perform. A
		// directory path that exists as a *file* is the cheap way to make the
		// mkdir fail on every platform.
		const dir = scratch("lbb-cost-blocked-");
		const blocker = join(dir, "projects");
		writeFileSync(blocker, "", "utf8");
		const path = join(blocker, "cwd", "costs.json");
		expect(() => saveCostState(path, SEED)).toThrow();
		expect(readFileSync(blocker, "utf8")).toBe("");
	});
});
