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

/**
 * A throwaway home plus a project dir to run in. Hooks are honored only from
 * tiers the user controls — a hooks block inside the working tree is
 * repo-controlled and deliberately ignored (see stripUntrustedKeys in
 * settings.ts) — so these tests declare hooks in the home tier via `setHooks`
 * and point the child process at that home.
 */
function hookFixture(prefix: string): {
	home: string;
	dir: string;
	markerPath: string;
	setHooks: (hooks: Record<string, unknown>) => void;
} {
	const home = mkdtempSync(join(tmpdir(), prefix));
	const dir = mkdtempSync(join(tmpdir(), `${prefix}proj-`));
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return {
		home,
		dir,
		markerPath: join(dir, "markers.txt"),
		setHooks: (hooks) => writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify({ hooks }, null, 2)),
	};
}

async function runCli(
	dir: string,
	args: string[],
	home: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: dir,
		// Both names: homedir() reads USERPROFILE on Windows and HOME elsewhere.
		env: { ...process.env, USERPROFILE: home, HOME: home, ANTHROPIC_API_KEY: "sk-not-a-real-key-for-tests" },
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
		const f = hookFixture("lbb-hookwire-block-");
		const script = join(f.dir, "block.mjs");
		writeFileSync(
			script,
			`import { appendFileSync } from "node:fs";\n` +
				`appendFileSync(${JSON.stringify(f.markerPath)}, "UserPromptSubmit\\n");\n` +
				`console.log(JSON.stringify({ decision: "block", reason: "prompt refused by policy" }));\n`,
		);
		f.setHooks({ UserPromptSubmit: [{ hooks: [{ type: "command", command: `${process.execPath} ${script}` }] }] });

		const result = await runCli(f.dir, ["-p", "hello", "--no-session"], f.home);
		expect(markers(f.markerPath)).toContain("UserPromptSubmit");
		expect(result.stderr).toContain("prompt refused by policy");
		expect(result.exitCode).toBe(1);
	}, 60_000);

	test("SessionStart and SessionEnd both fire around a headless run", async () => {
		const f = hookFixture("lbb-hookwire-session-");
		f.setHooks({
			SessionStart: [{ hooks: [{ command: markerHook(join(f.dir, "start.mjs"), f.markerPath, "SessionStart") }] }],
			SessionEnd: [{ hooks: [{ command: markerHook(join(f.dir, "end.mjs"), f.markerPath, "SessionEnd") }] }],
			// Block so the run never needs a working API key, while still
			// passing through SessionStart -> ... -> SessionEnd.
			UserPromptSubmit: [{ hooks: [{ command: blockingHook(join(f.dir, "block.mjs"), "short-circuit") }] }],
		});

		await runCli(f.dir, ["-p", "hello", "--no-session"], f.home);
		const fired = markers(f.markerPath);
		expect(fired).toContain("SessionStart");
		expect(fired).toContain("SessionEnd");
		// Ordering matters: start must precede end.
		expect(fired.indexOf("SessionStart")).toBeLessThan(fired.indexOf("SessionEnd"));
	}, 60_000);

	test("a hook that exits non-zero is reported but does not crash the session", async () => {
		const f = hookFixture("lbb-hookwire-fail-");
		const failScript = join(f.dir, "fail.mjs");
		writeFileSync(failScript, `process.stderr.write("hook exploded"); process.exit(3);\n`);
		f.setHooks({
			SessionStart: [{ hooks: [{ command: `${process.execPath} ${failScript}` }] }],
			UserPromptSubmit: [{ hooks: [{ command: blockingHook(join(f.dir, "block.mjs"), "stop here") }] }],
		});

		const result = await runCli(f.dir, ["-p", "hello", "--no-session"], f.home);
		// The failing SessionStart hook is surfaced, and the run still reaches
		// the UserPromptSubmit block rather than dying at startup.
		expect(result.stderr).toContain("SessionStart hook reported failure");
		expect(result.stderr).toContain("stop here");
		expect(result.exitCode).toBe(1);
	}, 60_000);

	test("SessionStart addedContext is accepted without breaking startup", async () => {
		const f = hookFixture("lbb-hookwire-ctx-");
		const ctxScript = join(f.dir, "ctx.mjs");
		writeFileSync(ctxScript, `console.log(JSON.stringify({ addedContext: "the build runs via make" }));\n`);
		f.setHooks({
			SessionStart: [{ hooks: [{ command: `${process.execPath} ${ctxScript}` }] }],
			UserPromptSubmit: [{ hooks: [{ command: blockingHook(join(f.dir, "block.mjs"), "halt") }] }],
		});

		const result = await runCli(f.dir, ["-p", "hello", "--no-session"], f.home);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("halt");
	}, 60_000);

	test("no hooks configured leaves headless behavior unchanged", async () => {
		const f = hookFixture("lbb-hookwire-none-");
		f.setHooks({});
		const result = await runCli(f.dir, ["--help"], f.home);
		expect(result.exitCode).toBe(0);
	}, 60_000);

	test("hooks declared inside the project are ignored, with a notice", async () => {
		const f = hookFixture("lbb-hookwire-repo-");
		// The user's own hook blocks the prompt, so the run needs no API key
		// while still proving which of the two hooks was reached.
		f.setHooks({ UserPromptSubmit: [{ hooks: [{ command: blockingHook(join(f.dir, "user-block.mjs"), "halt") }] }] });

		// A cloned repo shipping hooks: without the filter these would run on
		// every turn, before any permission check.
		const repoMarker = join(f.dir, "repo-markers.txt");
		mkdirSync(join(f.dir, ".labunbun"), { recursive: true });
		writeFileSync(
			join(f.dir, ".labunbun", "settings.json"),
			JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{ hooks: [{ command: markerHook(join(f.dir, "repo.mjs"), repoMarker, "from the repo") }] },
					],
				},
			}),
		);

		const result = await runCli(f.dir, ["-p", "hello", "--no-session"], f.home);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("halt"); // the user's hook ran
		expect(markers(repoMarker)).toEqual([]); // the repo's did not
		expect(result.stderr).toContain("project:hooks"); // and it said so
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

	test("neither app rewrites the request context after the fact", () => {
		// The seam that put hook context in the first request of a prompt and left
		// it out of every later one. Context a hook contributes is composed into
		// the user message as it is created (`composeUserMessage`), so the stored
		// bytes and the sent bytes are the same bytes; a rewrite at request time is
		// a prefix rewrite by construction, and the cache report would be right to
		// call every one of them a bug.
		//
		// The agent's own hook is still there for embedders that need a view — this
		// is about the two apps, which have a transcript to keep stable.
		for (const file of ["interactive.ts", "headless.ts"]) {
			const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
			expect(source).not.toContain("transformContext");
			expect(source).toContain("composeUserMessage");
		}
	});
});
