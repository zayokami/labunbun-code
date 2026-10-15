import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	advisoryHookFailures,
	HOOK_EVENTS,
	HooksConfigSchema,
	OBSERVER_HOOK_EVENTS,
	snapshotHooks,
} from "../src/hooks.ts";

/**
 * A hook that appends the JSON it received on stdin to a file. Run through a
 * script file rather than an inline command for the same reason the tests below
 * do: `cmd.exe` mangles nested quotes, and what these cases are about is the
 * payload, not the quoting.
 */
function captureStdinScript(dir: string, capturePath: string, reply?: string): string {
	const scriptPath = join(dir, "capture-hook.mjs");
	writeFileSync(
		scriptPath,
		`import { appendFileSync } from "node:fs";\n` +
			`let data = "";\n` +
			`process.stdin.setEncoding("utf8");\n` +
			`process.stdin.on("data", (chunk) => (data += chunk));\n` +
			`process.stdin.on("end", () => appendFileSync(${JSON.stringify(capturePath)}, data));\n` +
			(reply === undefined ? "" : `console.log(JSON.stringify(${reply}));\n`),
	);
	return `${process.execPath} ${scriptPath}`;
}

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
		const command = process.platform === "win32" ? `ping -n 10 127.0.0.1` : `sleep 5`;
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

	// The measured family the kill grace exists for (see EXIT_DRAIN_GRACE_MS in
	// packages/tools/src/operations.ts): the hook's own process is gone, but a
	// grandchild inherited stdout and holds the pipe open, so `close` — the only
	// event the runtime settled on — does not arrive while that process lives.
	// The command detaches the grandchild from the tree the kill reaches, so
	// nothing short of the grace ends the wait, and a `PreToolUse` hook that
	// hangs is the whole tool loop stuck behind a hook already declared failed.
	test("a hook whose stdout pipe outlives the kill still settles, as the timeout", async () => {
		const command =
			process.platform === "win32"
				? // `start /b` returns immediately and cmd.exe exits, while ping keeps the
					// inherited stdout pipe for the next ~19 seconds.
					`start /b ping -n 20 127.0.0.1`
				: // bash forks sleep into the background and exits; sleep keeps the pipe.
					`sleep 15 & echo started`;
		const runtime = snapshotHooks({ Notification: [{ hooks: [{ command, timeout: 300 }] }] });
		const started = Date.now();
		const outcome = await runtime.run("Notification", {});
		// Bounded by the hook timeout plus the kill grace, not by the grandchild's
		// lifetime: settling on `close` alone waited the grandchild out (~15s on
		// POSIX, ~19s on Windows) before this grace existed.
		expect(Date.now() - started).toBeLessThan(6_000);
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toContain("timed out");
	}, 20_000);

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

describe("compaction events", () => {
	test("a PostCompact hook runs and the payload reaches it whole", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-hook-"));
		const capturePath = join(dir, "seen.json");
		const command = captureStdinScript(dir, capturePath);
		const runtime = snapshotHooks({ PostCompact: [{ hooks: [{ type: "command", command }] }] });

		// The extra key is the point of half this case: the runtime hands the
		// payload over serialized whole, so a field the interface does not name
		// still arrives, and nothing in the way filters it out.
		const payload = {
			session_id: "s-1",
			cwd: "/proj",
			trigger: "auto" as const,
			pre_tokens: 1840,
			post_tokens: 220,
			something_extra: "kept",
		};
		const outcome = await runtime.run("PostCompact", payload);
		expect(outcome.errors).toEqual([]);
		expect(outcome.blocked).toBe(false);

		const seen = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
		expect(seen.event).toBe("PostCompact");
		expect(seen.session_id).toBe("s-1");
		expect(seen.cwd).toBe("/proj");
		expect(seen.trigger).toBe("auto");
		expect(seen.pre_tokens).toBe(1840);
		expect(seen.post_tokens).toBe(220);
		expect(seen.something_extra).toBe("kept");
	}, 10_000);

	test("a PreCompact block still vetoes, and the hook sees the focus text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-hook-"));
		const capturePath = join(dir, "seen.json");
		const command = captureStdinScript(dir, capturePath, `{ decision: "block", reason: "keep it for now" }`);
		const runtime = snapshotHooks({ PreCompact: [{ hooks: [{ type: "command", command }] }] });

		const outcome = await runtime.run("PreCompact", {
			session_id: "s-2",
			cwd: "/proj",
			trigger: "manual",
			custom_instructions: "keep the diffs",
		});
		expect(outcome.blocked).toBe(true);
		expect(outcome.reason).toContain("keep it for now");

		const seen = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, unknown>;
		expect(seen.event).toBe("PreCompact");
		expect(seen.trigger).toBe("manual");
		expect(seen.custom_instructions).toBe("keep the diffs");
	}, 10_000);

	test("a PostCompact block is reported, never obeyed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-hook-"));
		const command = captureStdinScript(
			dir,
			join(dir, "seen.json"),
			`{ decision: "block", reason: "too much happened" }`,
		);
		const runtime = snapshotHooks({ PostCompact: [{ hooks: [{ type: "command", command }] }] });

		const outcome = await runtime.run("PostCompact", {
			session_id: "s-3",
			cwd: "/proj",
			trigger: "manual",
			pre_tokens: 9,
			post_tokens: 3,
		});
		// The runtime reports the block faithfully — a non-zero exit would land
		// in the same flag, and hiding it would hide a failing hook — but the
		// pass it is answering about has already happened, so the observer
		// contract is that the call site turns this into a line, not a veto.
		// `advisoryHookFailures` is that line.
		expect(outcome.blocked).toBe(true);
		expect(advisoryHookFailures("PostCompact", outcome)).toEqual([
			"PostCompact hook reported failure: too much happened",
		]);
		expect(OBSERVER_HOOK_EVENTS).toContain("PostCompact");
		// And nothing about the pass is vetoable through this list: PreCompact,
		// whose block still defers, is not on it.
		expect(OBSERVER_HOOK_EVENTS).not.toContain("PreCompact");
	}, 10_000);
});

describe("event registration", () => {
	test("PostCompact is registered beside PreCompact", () => {
		// Pinned as the whole list, because this array is the one gate every
		// event passes: the settings schema is a record over strings and cannot
		// name them, so what `snapshotHooks` accepts is exactly this array.
		expect([...HOOK_EVENTS]).toEqual([
			"PreToolUse",
			"PostToolUse",
			"UserPromptSubmit",
			"SessionStart",
			"SessionEnd",
			"Stop",
			"PreCompact",
			"PostCompact",
			"Notification",
		]);
	});

	test("a PostCompact config survives the settings schema and the snapshot", () => {
		// The settings-side schema (`settings.ts`) types `hooks` as a record
		// over strings and `HooksConfigSchema` does the same, so neither
		// enumerates event names — both accept the key, and the event list is
		// the gate one step later.
		const rawHooks = { PostCompact: [{ hooks: [{ type: "command", command: "echo hi" }] }] };
		expect(HooksConfigSchema.safeParse(rawHooks).success).toBe(true);
		const runtime = snapshotHooks(rawHooks);
		expect(runtime.isEmpty).toBe(false);
		expect(runtime.has("PostCompact")).toBe(true);
		expect(runtime.has("PreCompact")).toBe(false);
	});

	test("an event name that is not on the list is refused", () => {
		// Refused rather than kept: a config under a name nothing fires would
		// sit in the runtime looking alive and run never.
		expect(snapshotHooks({ PostCompactHook: [{ hooks: [{ command: "echo hi" }] }] }).isEmpty).toBe(true);
		// Case matters the same way it does at every firing site.
		expect(snapshotHooks({ postcompact: [{ hooks: [{ command: "echo hi" }] }] }).isEmpty).toBe(true);
		expect(snapshotHooks({ PostCompact: [{ hooks: [{ command: "echo hi" }] }] }).isEmpty).toBe(false);
	});
});
