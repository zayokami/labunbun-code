/**
 * The user's settings file is replaced, never rewritten in place.
 *
 * Every `/theme`, `/model`, `/vim` and `/gamepad` is a read-merge-write over
 * `~/.labunbun/settings.json`, and the write used to land directly on the file.
 * A process that dies mid-write — a crash, a kill, a full disk — then leaves a
 * truncated file, and the damage is not local: the next start drops the whole
 * user tier behind one stderr warning, and every later read-merge-write refuses
 * to run ("not valid JSON; fix it before changing settings") until the operator
 * repairs the file by hand. That is the one file in the tree whose loss the
 * user cannot recover from the app.
 *
 * The interruption is driven with a mocked `writeFileSync`, in a child process
 * because `mock.module` outlives the file that called it (see
 * `cache-prefix-stability.test.ts`): the write reaches the file it is given and
 * then throws, which is the shape of a crash mid-write. What is asserted is the
 * old contents still being there and no half-written file left beside them.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** The settings a user would already have, before a command tries to change one. */
const SEED = { theme: "nord", model: "kimi/kimi-k2", env: { ANTHROPIC_API_KEY: "keep-me" } };

/**
 * Run one `writeUserSettingsPatch` in a child process whose `writeFileSync`
 * fails partway through, after the bytes it managed have reached the file.
 *
 * Returns what the write did — the error has to come back, not be swallowed —
 * and leaves the mocked-out home on disk for the assertions.
 */
async function interruptedWrite(home: string): Promise<{ outcome: string; message?: string }> {
	const script = `
		import { mock } from "bun:test";
		import * as fs from "node:fs";
		import { writeFileSync as realWriteFileSync } from "node:fs";
		const realWrite = realWriteFileSync;
		const home = ${JSON.stringify(home)};
		mock.module("node:fs", () => ({
			...fs,
			writeFileSync: (path, data) => {
				// A crash mid-write: the first bytes land, the call never returns.
				realWrite(path, String(data).slice(0, 12));
				throw new Error("simulated crash mid-write");
			},
		}));
		const { writeUserSettingsPatch } = await import("./src/user-settings.ts");
		try {
			writeUserSettingsPatch({ theme: "dark" }, home);
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

function settingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

describe("an interrupted settings write", () => {
	test("leaves the file that was there whole, and nothing half-written beside it", async () => {
		const home = scratch("lbb-settings-atomic-");
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(settingsPath(home), `${JSON.stringify(SEED, null, 2)}\n`, "utf8");

		const result = await interruptedWrite(home);

		// The failure is reported to the caller — a `/theme` that could not be
		// saved must not look like one that was.
		expect(result.outcome).toBe("threw");
		// And the file it failed to replace is the one every later read, merge
		// and startup sees: intact, still valid, still the user's.
		expect(readFileSync(settingsPath(home), "utf8")).toBe(`${JSON.stringify(SEED, null, 2)}\n`);
		expect(JSON.parse(readFileSync(settingsPath(home), "utf8"))).toEqual(SEED);
		// No temp file survives the failure to be mistaken for a settings file
		// by the next writer (or by the user).
		expect(readdirSync(join(home, ".labunbun"))).toEqual(["settings.json"]);
	});
});
