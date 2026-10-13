/**
 * `settings.roles` at the REPL's front door, run for real.
 *
 * The startup goes through the actual `runInteractive` in a subprocess with the
 * provider mocked the way `continue.test.ts` mocks it: the model each request
 * was made to is recorded, so the priority order the code documents can be
 * asserted instead of assumed. The claim proven here is the whole order —
 * `--model`, then `settings.model`, then `roles.main`, then the built-in
 * default — plus the fallback chain's descent: a failing model walks the rungs
 * *below its slot* in its role's order, never back up onto a model that
 * outranks it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(settings?: Record<string, unknown>) {
	const home = mkdtempSync(join(tmpdir(), "lbb-roles-repl-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-roles-cwd-"));
	roots.push(home, cwd);
	if (settings) {
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify(settings));
	}
	return { home, cwd };
}

/**
 * Run the real startup and one prompt, isolating the module mocks.
 *
 * `failFirst` makes that many leading stream attempts end in a pre-content
 * error — the shape a fallback-safe failure has — so the walk between models
 * is observable in the recorded request list.
 */
async function startup(home: string, cwd: string, options: { modelRef?: string; failFirst?: number } = {}) {
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		const requests = [];
		const FAIL_FIRST = ${options.failFirst ?? 0};
		mock.module("@labunbun/ai", () => ({
			...ai,
			resolveApiKey: () => "local-test-key",
			refreshModelCatalog: async () => null,
			createDefaultStreamFn: () => async function* (model, context) {
				requests.push({ model: model.id, provider: model.provider });
				if (requests.length <= FAIL_FIRST) {
					yield { type: "error", message: ai.assistantMessage({
						provider: model.provider, model: model.id, stopReason: "error", errorMessage: "the wire is down",
					}) };
					return;
				}
				yield { type: "done", message: ai.assistantMessage({
					content: [{ type: "text", text: "new answer" }], stopReason: "stop",
					provider: model.provider, model: model.id,
				}) };
			}
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: ({ session }) => ({
				setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
				store: { set() {} },
				waitUntilExit: async () => { await session.prompt("new question"); }
			})
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(${JSON.stringify({ modelRef: options.modelRef, cwd, theme: "dark" })});
		console.log(JSON.stringify({ exitCode, requests }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: home, USERPROFILE: home },
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
	return {
		...(JSON.parse(stdout.trim()) as { exitCode: number; requests: Array<{ model: string; provider: string }> }),
		stderr,
	};
}

describe("settings.roles at REPL startup", () => {
	test("roles.main answers when neither --model nor settings.model did", async () => {
		const { home, cwd } = fixture({
			modelDiscovery: false,
			roles: { main: { model: "anthropic/claude-haiku-4-5" } },
		});

		const result = await startup(home, cwd);

		expect(result.requests.map((request) => request.model)).toEqual(["claude-haiku-4-5"]);
		expect(result.stderr).not.toContain("Unknown model");
	}, 30_000);

	test("settings.model — the persisted choice — outranks roles.main", async () => {
		// This is what keeps `/model` working beside a role: the switch persists to
		// `model`, and the user's explicit ask wins over the role's default.
		const { home, cwd } = fixture({
			modelDiscovery: false,
			model: "anthropic/claude-haiku-4-5",
			roles: { main: { model: "anthropic/claude-sonnet-5" } },
		});

		const result = await startup(home, cwd);

		expect(result.requests.map((request) => request.model)).toEqual(["claude-haiku-4-5"]);
	}, 30_000);

	test("an unknown roles.main warns on stderr and the built-in default answers", async () => {
		const { home, cwd } = fixture({
			modelDiscovery: false,
			roles: { main: { model: "no-such-model" } },
		});

		const result = await startup(home, cwd);

		expect(result.stderr).toContain(
			'Warning: unknown model "no-such-model" for roles.main — the built-in default model will be used.',
		);
		expect(result.requests.map((request) => request.model)).toEqual(["claude-sonnet-5"]);
	}, 30_000);

	test("a failing model descends its role's order from its own slot, never back up", async () => {
		// The session runs on haiku — an explicit `--model` landing inside the main
		// order's list — and the first attempt fails before any content. The walk
		// must move to the rung below haiku (opus) and must not re-request sonnet,
		// which outranks the model that just failed: a session moved down a rung on
		// purpose is not dragged back up by another rung's failure.
		const { home, cwd } = fixture({
			modelDiscovery: false,
			roles: {
				main: {
					model: "anthropic/claude-sonnet-5",
					fallback: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
				},
			},
		});

		const result = await startup(home, cwd, { modelRef: "anthropic/claude-haiku-4-5", failFirst: 1 });

		expect(result.requests.map((request) => request.model)).toEqual(["claude-haiku-4-5", "claude-opus-4-6"]);
	}, 30_000);
});
