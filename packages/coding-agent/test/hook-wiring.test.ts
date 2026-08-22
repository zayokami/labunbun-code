import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end hook wiring: these run the real CLI in headless mode and assert
 * that each lifecycle event actually reaches a call site. Unit-testing
 * HooksRuntime (hooks.test.ts) cannot catch a declared-but-never-invoked
 * event — the gap these cover.
 *
 * No API key is needed: the prompt is blocked before the model call, and
 * every event asserted here fires on the near side of the network.
 */

const CLI = join(import.meta.dir, "..", "bin", "labunbun.ts");

/** A hook command that appends its event name to a marker file. */
function markerHook(scriptPath: string, markerPath: string, event: string, extraJson = "{}"): string {
	writeFileSync(
		scriptPath,
		`import { appendFileSync } from "node:fs";\n` +
			`appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(`${event}\n`)});\n` +
			`console.log(JSON.stringify(${extraJson}));\n`,
	);
	return `${process.execPath} ${scriptPath}`;
}

/** A hook that blocks, used to short-circuit runs before any model call. */
function blockingHook(scriptPath: string, reason: string): string {
	writeFileSync(scriptPath, `console.log(JSON.stringify({ decision: "block", reason: ${JSON.stringify(reason)} }));\n`);
	return `${process.execPath} ${scriptPath}`;
}

function projectWithHooks(prefix: string, hooks: Record<string, unknown>): { dir: string; markerPath: string } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	mkdirSync(join(dir, ".labunbun"), { recursive: true });
	writeFileSync(join(dir, ".labunbun", "settings.json"), JSON.stringify({ hooks }, null, 2));
	return { dir, markerPath: join(dir, "markers.txt") };
}

async function runCli(dir: string, args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: dir,
		env: { ...process.env, ANTHROPIC_API_KEY: "sk-not-a-real-key-for-tests" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { exitCode: await proc.exited, stdout, stderr };
}

function markers(markerPath: string): string[] {
	if (!existsSync(markerPath)) return [];
	return readFileSync(markerPath, "utf8").trim().split("\n").filter(Boolean);
}

describe("hook wiring (headless, real process)", () => {
	test("UserPromptSubmit blocks the prompt before any model call", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-hookwire-block-"));
		mkdirSync(join(dir, ".labunbun"), { recursive: true });
		const markerPath = join(dir, "markers.txt");
		const script = join(dir, "block.mjs");
		writeFileSync(
			script,
			`import { appendFileSync } from "node:fs";\n` +
				`appendFileSync(${JSON.stringify(markerPath)}, "UserPromptSubmit\\n");\n` +
				`console.log(JSON.stringify({ decision: "block", reason: "prompt refused by policy" }));\n`,
		);
		writeFileSync(
			join(dir, ".labunbun", "settings.json"),
			JSON.stringify({
				hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] },
			}),
		);

		const result = await runCli(dir, ["-p", "hello", "--no-session"]);
		expect(markers(markerPath)).toContain("UserPromptSubmit");
		expect(result.stderr).toContain("prompt refused by policy");
		expect(result.exitCode).toBe(1);
	}, 60_000);

	test("SessionStart and SessionEnd both fire around a headless run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-hookwire-session-"));
		mkdirSync(join(dir, ".labunbun"), { recursive: true });
		const markerPath = join(dir, "markers.txt");
		writeFileSync(
			join(dir, ".labunbun", "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [{ hooks: [{ command: markerHook(join(dir, "start.mjs"), markerPath, "SessionStart") }] }],
					SessionEnd: [{ hooks: [{ command: markerHook(join(dir, "end.mjs"), markerPath, "SessionEnd") }] }],
					// Block so the run never needs a working API key, while still
					// passing through SessionStart -> ... -> SessionEnd.
					UserPromptSubmit: [{ hooks: [{ command: blockingHook(join(dir, "block.mjs"), "short-circuit") }] }],
				},
			}),
		);

		await runCli(dir, ["-p", "hello", "--no-session"]);
		const fired = markers(markerPath);
		expect(fired).toContain("SessionStart");
		expect(fired).toContain("SessionEnd");
		// Ordering matters: start must precede end.
		expect(fired.indexOf("SessionStart")).toBeLessThan(fired.indexOf("SessionEnd"));
	}, 60_000);

	test("a hook that exits non-zero is reported but does not crash the session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-hookwire-fail-"));
		mkdirSync(join(dir, ".labunbun"), { recursive: true });
		const failScript = join(dir, "fail.mjs");
		writeFileSync(failScript, `process.stderr.write("hook exploded"); process.exit(3);\n`);
		writeFileSync(
			join(dir, ".labunbun", "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [{ hooks: [{ command: `${process.execPath} ${failScript}` }] }],
					UserPromptSubmit: [{ hooks: [{ command: blockingHook(join(dir, "block.mjs"), "stop here") }] }],
				},
			}),
		);

		const result = await runCli(dir, ["-p", "hello", "--no-session"]);
		// The failing SessionStart hook is surfaced, and the run still reaches
		// the UserPromptSubmit block rather than dying at startup.
		expect(result.stderr).toContain("SessionStart hook reported failure");
		expect(result.stderr).toContain("stop here");
		expect(result.exitCode).toBe(1);
	}, 60_000);

	test("SessionStart addedContext is accepted without breaking startup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-hookwire-ctx-"));
		mkdirSync(join(dir, ".labunbun"), { recursive: true });
		const ctxScript = join(dir, "ctx.mjs");
		writeFileSync(ctxScript, `console.log(JSON.stringify({ addedContext: "the build runs via make" }));\n`);
		writeFileSync(
			join(dir, ".labunbun", "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [{ hooks: [{ command: `${process.execPath} ${ctxScript}` }] }],
					UserPromptSubmit: [{ hooks: [{ command: blockingHook(join(dir, "block.mjs"), "halt") }] }],
				},
			}),
		);

		const result = await runCli(dir, ["-p", "hello", "--no-session"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("halt");
	}, 60_000);

	test("no hooks configured leaves headless behavior unchanged", async () => {
		const { dir } = projectWithHooks("lbb-hookwire-none-", {});
		const result = await runCli(dir, ["--help"]);
		expect(result.exitCode).toBe(0);
	}, 60_000);
});

describe("hook event coverage", () => {
	test("every declared HOOK_EVENTS name has a call site in the app layer", async () => {
		const { HOOK_EVENTS } = await import("../src/hooks.ts");
		const interactive = readFileSync(join(import.meta.dir, "..", "src", "interactive.ts"), "utf8");
		const headless = readFileSync(join(import.meta.dir, "..", "src", "headless.ts"), "utf8");
		const combined = `${interactive}\n${headless}`;
		// Guards against an event being declared in the schema but never
		// invoked — config the user writes that silently does nothing.
		for (const event of HOOK_EVENTS) {
			expect(combined).toContain(`hooksRuntime.run("${event}"`);
		}
	});
});
