import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisoryHookFailures, snapshotHooks } from "../src/hooks.ts";

describe("advisoryHookFailures", () => {
	test("a non-zero exit is reported even though it only sets blocked", () => {
		// The contract routes a non-zero exit to `blocked`, not `errors`. An
		// advisory call site that read only `errors` would silently swallow a
		// hook failing on every run.
		const messages = advisoryHookFailures("SessionStart", {
			blocked: true,
			reason: "hook exited 3",
			addedContext: [],
			suppressOutput: false,
			errors: [],
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("SessionStart");
		expect(messages[0]).toContain("hook exited 3");
	});

	test("spawn errors are reported with the event name", () => {
		const messages = advisoryHookFailures("SessionEnd", {
			blocked: false,
			addedContext: [],
			suppressOutput: false,
			errors: ["spawn ENOENT"],
		});
		expect(messages).toEqual(["SessionEnd hook failed: spawn ENOENT"]);
	});

	test("a clean outcome produces no noise", () => {
		const messages = advisoryHookFailures("Notification", {
			blocked: false,
			addedContext: ["some context"],
			suppressOutput: false,
			errors: [],
		});
		expect(messages).toHaveLength(0);
	});
});

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
		// Named as a timeout rather than left to whatever exit code the kill left
		// behind. `blocked` alone cannot tell the two apart on Windows, where
		// `taskkill` gives `cmd.exe` a non-zero code of its own and the hook would
		// read as blocked either way — so on that platform the assertion above was
		// passing without the timeout being recognised as one, and the reason is what
		// pins it everywhere.
		expect(outcome.reason).toContain("timed out");
	}, 10_000);

	// A hook killed by something other than its own timeout — the OOM killer, an
	// operator with a `kill` — never exited either, and has to read the same way.
	// POSIX is the only platform this is expressible on: it reports a signalled
	// child as a null exit code, which is the whole reason the case exists, while
	// Windows has no equivalent (there the kill lands as an exit code of its own).
	// `$$` is the shell the runtime already spawned, so the command signals itself
	// and the runtime never has to know it happened.
	test.skipIf(process.platform === "win32")(
		"a hook killed by a signal is blocked, not passed",
		async () => {
			const runtime = snapshotHooks({ PreToolUse: [{ hooks: [{ command: "kill -TERM $$" }] }] });
			const outcome = await runtime.run("PreToolUse", { tool_name: "Bash" });
			expect(outcome.blocked).toBe(true);
			expect(outcome.reason).toContain("killed by SIGTERM");
		},
		10_000,
	);
});
