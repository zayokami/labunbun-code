/**
 * The definition-trust ledger is replaced, never rewritten in place.
 *
 * `approveProjectDefinitions` is a read-modify-write over the whole file, and
 * the file is what keeps a cloned repository's agents and skills out of a
 * session. A process that dies mid-write — a crash, a kill, a full disk — left
 * a truncated ledger, and a truncated ledger grants nothing: the next start
 * withholds both tiers again, re-asks for a decision the user already made, and
 * says nothing about why. The one file in this feature whose loss is invisible
 * is the one that decides what is trusted.
 *
 * The interruption is driven with a mocked `writeFileSync` in a child process,
 * because `mock.module` outlives the file that called it (see
 * `cache-prefix-stability.test.ts`): the write reaches the file it is given and
 * then throws, which is the shape of a death mid-write.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";
// `approveProjectDefinitions` itself is called inside the child process below, not here.
import { loadTrustedDefinitionKinds } from "../src/project-trust.ts";

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

/** A decision the user already made, whose loss would be silent. */
const SEED = `${JSON.stringify({ trustedDefinitionKinds: ["agents"] }, null, 2)}\n`;

function ledgerPath(home: string, cwd: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd), "trusted-definitions.json");
}

/**
 * Run one `approveProjectDefinitions` in a child process whose `writeFileSync`
 * fails partway through, after the bytes it managed have reached the file.
 *
 * Returns what the write did — the failure has to come back, not be swallowed
 * inside the store — and leaves the mocked-out home on disk for the assertions.
 */
async function interruptedApproval(cwd: string, home: string): Promise<{ outcome: string; message?: string }> {
	const script = `
		import { mock } from "bun:test";
		import * as fs from "node:fs";
		import { writeFileSync as realWriteFileSync } from "node:fs";
		const realWrite = realWriteFileSync;
		mock.module("node:fs", () => ({
			...fs,
			// A death mid-write: the first bytes land, the call never returns.
			writeFileSync: (path, data) => {
				realWrite(path, String(data).slice(0, 12));
				throw new Error("simulated crash mid-write");
			},
		}));
		const { approveProjectDefinitions } = await import("./src/project-trust.ts");
		try {
			approveProjectDefinitions(${JSON.stringify(cwd)}, ["skills"], ${JSON.stringify(home)});
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

describe("an interrupted trust write", () => {
	test("leaves the trust that was recorded whole, and nothing half-written beside it", async () => {
		const cwd = scratch("lbb-trust-atomic-cwd-");
		const home = scratch("lbb-trust-atomic-home-");
		const path = ledgerPath(home, cwd);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, SEED, "utf8");

		const result = await interruptedApproval(cwd, home);

		// The failure reaches the caller instead of a partial write passing for a
		// completed approval.
		expect(result.outcome).toBe("threw");
		// The ledger is the one that was there, byte for byte...
		expect(readFileSync(path, "utf8")).toBe(SEED);
		// ...and the tier it trusted is still trusted: the definitions it covers
		// are not withdrawn, and the user is not asked again.
		expect(loadTrustedDefinitionKinds(cwd, home)).toEqual(new Set(["agents"]));
		// Nothing half-written survives the failure — no temp file, and no
		// quarantine copy of a ledger that was never actually damaged.
		expect(readdirSync(dirname(path))).toEqual(["trusted-definitions.json"]);
	});
});
