/**
 * TEMPORARY DIAGNOSTIC — not a permanent test. Delete once the answer is known.
 *
 * The generated profile runs /bin/echo under sandbox-exec (exit=0), so the
 * profile is not what empties the spill test. What is left is the path between:
 * the Bash tool -> exec -> the shell -> the command. The test gets exactly
 * "[exit code: 0]\n", i.e. exit 0 and both streams empty, which no real command
 * does. So drive the same tool call and report what each layer returned.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAllTools, defaultOperations } from "@labunbun/tools";
import { workspacePolicy } from "../src/sandbox/workspace-policy.ts";

test("where the output goes", async () => {
	if (process.platform !== "darwin") return;
	const rows: string[] = [];
	const cwd = mkdtempSync(join(tmpdir(), "lbb-where-"));
	writeFileSync(
		join(cwd, "noisy.js"),
		`console.log("MARKER-OK");\nfor (let i = 1; i <= 5; i++) console.log("line " + i);\n`,
	);

	// 1. The operations layer alone, no policy: is stdout captured at all?
	const bare = await defaultOperations().exec({
		command: `${process.execPath} noisy.js`,
		cwd,
		timeoutMs: 60_000,
		signal: new AbortController().signal,
		onOutput: () => {},
	});
	rows.push(`NO-POLICY: exit=${bare.exitCode} out=${JSON.stringify(bare.stdout)} err=${JSON.stringify(bare.stderr)}`);

	// 2. The same, with the policy the tool would build. If this is the one that
	// empties, the difference is the policy and not the tool or the shell.
	const policy = await workspacePolicy(cwd, { sandbox: "workspace-write" });
	rows.push(`POLICY: roots=${JSON.stringify(policy.fileSystem.entries.map((e) => `${e.access}:${e.path}`))}`);
	const wrapped = await defaultOperations().exec({
		command: `${process.execPath} noisy.js`,
		cwd,
		timeoutMs: 60_000,
		signal: new AbortController().signal,
		sandbox: policy,
		onOutput: () => {},
	});
	rows.push(
		`WITH-POLICY: exit=${wrapped.exitCode} out=${JSON.stringify(wrapped.stdout)} err=${JSON.stringify(wrapped.stderr)}`,
	);

	// 3. A command that cannot be a path or a policy question: a bare echo.
	const echoed = await defaultOperations().exec({
		command: "echo MARKER-DIRECT",
		cwd,
		timeoutMs: 60_000,
		signal: new AbortController().signal,
		sandbox: policy,
		onOutput: () => {},
	});
	rows.push(
		`ECHO-WITH-POLICY: exit=${echoed.exitCode} out=${JSON.stringify(echoed.stdout)} err=${JSON.stringify(echoed.stderr)}`,
	);

	// 4. The tool, exactly as the failing test calls it.
	const tools = createAllTools(cwd, { operations: defaultOperations() });
	const bash = tools.find((tool) => tool.name === "Bash");
	const result = await bash?.call(
		{ command: `${process.execPath} noisy.js` },
		{ callId: "c1", signal: new AbortController().signal, cwd, sandbox: "workspace-write", onUpdate: () => {} },
	);
	rows.push(
		`TOOL: ${JSON.stringify(result === undefined ? "no Bash tool" : (result.content[0] as { text: string }).text)}`,
	);

	expect(rows.join("\n")).toBe("table");
}, 180_000);
