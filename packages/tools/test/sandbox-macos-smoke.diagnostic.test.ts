/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * Measured so far, with the policy `workspace-write` on a temp cwd:
 *   NO-POLICY   bun noisy.js  exit=0 out="MARKER-OK\nline 1\n…"
 *   WITH-POLICY bun noisy.js  exit=0 out=""        err=""
 *   WITH-POLICY echo ...      exit=0 out="MARKER-DIRECT\n"
 *
 * The third rung is a **shell builtin**, so it never execs a binary and says
 * nothing about exec. exit 0 with two empty streams is also not what a failed
 * exec looks like — a shell that cannot exec reports it and exits 126/127. So
 * the four rungs below ask, in order: is the exec path itself broken, or is it
 * bun, or is it reading the script, or is it the cwd spelling.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAllTools, defaultOperations } from "@labunbun/tools";
import { workspacePolicy } from "../src/sandbox/workspace-policy.ts";

test("where the output goes", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];
	const ops = defaultOperations();
	const cwd = mkdtempSync(join(tmpdir(), "lbb-where-"));
	const policy = await workspacePolicy(cwd, { sandbox: "workspace-write" });

	rows.push(`CWD: ${cwd}`);
	rows.push(`CWD-REAL: ${realpathSync(cwd)}`);
	rows.push(`EXE: ${process.execPath}`);
	rows.push(`ROOTS: ${JSON.stringify(policy.fileSystem.entries.map((e) => `${e.access}:${e.path}`))}`);
	rows.push(`NETWORK: ${policy.network}`);

	// A rung writes a file into cwd before it prints, so "the program never
	// started" and "the program ran and its stdout was lost" stop looking the
	// same. Console output alone cannot tell those apart.
	writeFileSync(
		join(cwd, "noisy.js"),
		`const fs = require("node:fs");\n` + `fs.writeFileSync("ran.txt", "yes");\n` + `console.log("MARKER-OK");\n`,
	);

	async function rung(label: string, command: string): Promise<void> {
		try {
			const r = await ops.exec({
				command,
				cwd,
				timeoutMs: 60_000,
				signal: new AbortController().signal,
				sandbox: policy,
				onOutput: () => {},
			});
			rows.push(
				`${label}: exit=${r.exitCode} killed=${r.killed} ran=${existsSync(join(cwd, "ran.txt"))} ` +
					`out=${JSON.stringify(r.stdout)} err=${JSON.stringify(r.stderr)}`,
			);
		} catch (e) {
			rows.push(`${label}: THREW ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// 1. The control the builtin could not be: a real external binary, same
	// shell, same policy. If this is empty too then the exec path is broken and
	// bun was never the subject.
	await rung("SHELL-ECHO-BINARY", "/bin/echo MARKER-BINARY");

	// 2. bun with no script to read and no dependency on cwd: does it start?
	await rung("BUN-DASH-E", `${process.execPath} -e 'console.log("MARKER-E")'`);

	// 3. bun running a file in cwd: the real shape.
	await rung("BUN-SCRIPT", `${process.execPath} noisy.js`);

	// 4. The tool, exactly as the failing test calls it.
	const tools = createAllTools(cwd, { operations: ops });
	const bash = tools.find((tool) => tool.name === "Bash");
	const result = await bash?.call(
		{ command: `${process.execPath} noisy.js` },
		{ callId: "c1", signal: new AbortController().signal, cwd, sandbox: "workspace-write", onUpdate: () => {} },
	);
	rows.push(
		`TOOL: ${JSON.stringify(result === undefined ? "no Bash tool" : (result.content[0] as { text: string }).text)}`,
	);

	expect(rows.join("\n")).toBe("table");
}, 300_000);
