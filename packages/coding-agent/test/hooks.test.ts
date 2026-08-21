import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotHooks } from "../src/hooks.ts";

describe("snapshotHooks", () => {
	test("invalid config is rejected, not thrown", () => {
		const runtime = snapshotHooks({ PreToolUse: "not-an-array" });
		expect(runtime.isEmpty).toBe(true);
	});

	test("empty config yields empty runtime", () => {
		expect(snapshotHooks(undefined).isEmpty).toBe(true);
		expect(snapshotHooks({}).isEmpty).toBe(true);
	});
});

describe("PreToolUse blocking", () => {
	test("blocking JSON output blocks the tool call", async () => {
		// Script-file hook avoids shell-quoting pitfalls entirely (cmd.exe
		// strips nested quotes, which breaks `bun -e "..."` on Windows).
		const dir = mkdtempSync(join(tmpdir(), "lbb-hook-"));
		const scriptPath = join(dir, "block-hook.mjs");
		writeFileSync(scriptPath, `console.log(JSON.stringify({ decision: "block", reason: "no rm" }));`);
		const command = `${process.execPath} ${scriptPath}`;
		const runtime = snapshotHooks({
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
		});
		const outcome = await runtime.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" } });
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toContain("no rm");
	});

	test("non-blocking hook passes through with context", async () => {
		const command =
			process.platform === "win32"
				? `echo {"addedContext":"remember the rules"}`
				: `echo '{"addedContext":"remember the rules"}'`;
		const runtime = snapshotHooks({ PreToolUse: [{ hooks: [{ command }] }] });
		const outcome = await runtime.run("PreToolUse", { tool_name: "Read", tool_input: {} });
		expect(outcome.blocked).toBe(false);
		expect(outcome.addedContext.join("\n")).toContain("remember the rules");
	});

	test("matcher filters by tool name pattern", async () => {
		const command = process.platform === "win32" ? `exit /b 1` : `exit 1`;
		const runtime = snapshotHooks({
			PreToolUse: [{ matcher: "Write", hooks: [{ command }] }],
		});
		const readOutcome = await runtime.run("PreToolUse", { tool_name: "Read", tool_input: {} });
		expect(readOutcome.blocked).toBe(false); // matcher didn't match Read
		const writeOutcome = await runtime.run("PreToolUse", { tool_name: "Write", tool_input: {} });
		expect(writeOutcome.blocked).toBe(true); // exit 1 → blocked
	});

	test("failing hook counts as blocked with error reason", async () => {
		const command = process.platform === "win32" ? `cmd /c exit 3` : `exit 3`;
		const runtime = snapshotHooks({ Stop: [{ hooks: [{ command }] }] });
		const outcome = await runtime.run("Stop", {});
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toContain("exited");
	});

	test("timeout kills hung hooks", async () => {
		const command = process.platform === "win32" ? `ping -n 10 127.0.0.1 > nul` : `sleep 5`;
		const runtime = snapshotHooks({ Notification: [{ hooks: [{ command, timeout: 300 }] }] });
		const started = Date.now();
		const outcome = await runtime.run("Notification", {});
		expect(Date.now() - started).toBeLessThan(3000);
		expect(outcome.blocked).toBe(true);
	}, 10_000);
});
