/**
 * The approval ledger is replaced, never rewritten in place.
 *
 * `approveMcpServer` is a read-modify-write over the whole store, and every
 * project-scoped server the user approves goes through it. A process that dies
 * mid-write — a crash, a kill, a full disk — left a truncated file, and the
 * next reader takes a truncated file as no store at all: every earlier approval
 * silently stops counting, and the servers they covered are asked about again.
 * The file is small, which is what makes it worth replacing rather than
 * repairing: nothing about it is expensive to write, and nothing about losing
 * it is cheap to notice.
 *
 * The interruption is driven with a mocked `writeFileSync` in a child process,
 * because `mock.module` outlives the file that called it (see
 * `packages/coding-agent/test/cost-tracker-atomic.test.ts` for the same
 * pattern, and `cache-prefix-stability.test.ts` for why the child is
 * required): the write reaches the file it is given and then throws, which is
 * the shape of a death mid-write.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";
// `approveMcpServer` itself is called inside the child process below, not here.
import { loadApprovedMcpServers } from "../src/client.ts";

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

/** An approval the user already granted, whose loss would be silent. */
const SEED = `${JSON.stringify({ approvedMcpServers: ["alpha"] }, null, 2)}\n`;

function storePath(home: string, cwd: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd), "mcp-approved.json");
}

/**
 * Run one `approveMcpServer` in a child process whose `writeFileSync` fails
 * partway through, after the bytes it managed have reached the file.
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
		const { approveMcpServer } = await import("./src/client.ts");
		try {
			approveMcpServer(${JSON.stringify(cwd)}, "beta", ${JSON.stringify(home)});
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

describe("an interrupted approval write", () => {
	test("leaves the earlier approvals whole, and nothing half-written beside them", async () => {
		const cwd = scratch("lbb-mcp-atomic-cwd-");
		const home = scratch("lbb-mcp-atomic-home-");
		const path = storePath(home, cwd);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, SEED, "utf8");

		const result = await interruptedApproval(cwd, home);

		// The failure reaches the caller instead of a partial write passing for a
		// saved one.
		expect(result.outcome).toBe("threw");
		// The store is the one that was there, byte for byte...
		expect(readFileSync(path, "utf8")).toBe(SEED);
		// ...and it still agrees to the approval it held: no quarantine, no
		// warning, no server silently asked about again.
		expect([...loadApprovedMcpServers(cwd, home)]).toEqual(["alpha"]);
		// Nothing half-written survives the failure to be read as a store later.
		expect(readdirSync(dirname(path))).toEqual(["mcp-approved.json"]);
	});
});
