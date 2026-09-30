/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * The spill test still gets 15 characters — exactly "[exit code: 0]\n" — while
 * the generated profile compiles and runs /bin/echo. So the sandbox is not what
 * stops the output: the command is `bun noisy.js`, and the question is whether
 * bun runs at all under the profile. Previous rungs forgot (allow process-exec),
 * which made every isolated construct fail to exec and test nothing; this one
 * keeps it. Control first.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxPolicy } from "@labunbun/agent";
import { buildSeatbeltArgs } from "../src/sandbox/seatbelt.ts";

/** Runs `command` under `profile` verbatim: no repacking, no dropped `-D`. */
async function run(profile: string, params: string[], command: string[]): Promise<string> {
	const proc = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, ...params, "--", ...command], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: REAL,
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const brief = (s: string) => JSON.stringify(s.length > 220 ? `${s.slice(0, 220)}…(${s.length})` : s);
	return `exit=${code} out=${brief(out)} err=${brief(err)}`;
}

const REAL = realpathSync(mkdtempSync(join(tmpdir(), "lbb-bun-")));
const NOISY = join(REAL, "noisy.js");
writeFileSync(NOISY, `console.log("MARKER-OK");\nfor (let i = 1; i <= 5; i++) console.log("line " + i);\n`);

test("does bun run under the profile", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];

	const args = buildSeatbeltArgs(buildSandboxPolicy({ sandbox: "workspace-write", workspace: REAL }), [
		process.execPath,
		"noisy.js",
	]);
	const profile = args[1] ?? "";
	const params = args.slice(2).filter((a) => a !== "--");

	// Controls, unsandboxed: what the command does with no profile at all.
	rows.push(`NO-SANDBOX bun: ${await run("(version 1)\n(allow default)", [], [process.execPath, "noisy.js"])}`);
	rows.push(`NO-SANDBOX echo: ${await run("(version 1)\n(allow default)", [], ["/bin/echo", "MARKER-OK"])}`);

	// The real thing, and the same command with the read baseline removed, to
	// separate "bun cannot start" from "bun runs but cannot write the file".
	rows.push(`OURS bun: ${await run(profile, params, [process.execPath, "noisy.js"])}`);
	rows.push(`OURS echo: ${await run(profile, params, ["/bin/echo", "MARKER-OK"])}`);

	// Base policy with process-exec, then base + every write, to find which
	// operation bun needs that /bin/echo does not.
	const base = profile.split("\n; Read baseline")[0] ?? "";
	rows.push(`BASE bun: ${await run(`${base}\n(allow file-read*)`, [], [process.execPath, "noisy.js"])}`);
	rows.push(
		`BASE+WRITE bun: ${await run(
			`${base}\n(allow file-read*)\n(allow file-write*)`,
			[],
			[process.execPath, "noisy.js"],
		)}`,
	);
	// bun caches transpiled output; if that write is what is missing, naming the
	// cache directory as a writable root is what changes the answer.
	rows.push(
		`BASE+WRITECACHE bun: ${await run(
			`${base}\n(allow file-read*)\n(allow file-write*)`,
			[`-DCACHE=${join(REAL, "cache")}`],
			[process.execPath, "noisy.js"],
		)}`,
	);

	expect(rows.join("\n")).toBe("table");
}, 180_000);
