/**
 * The startup credential notice, run through the real `runInteractive` in a
 * subprocess.
 *
 * Two claims: a machine that cannot run its startup model still mounts — the
 * gate that used to exit 1 read only the environment, so a subscription-only
 * box could not start — and it says so in the transcript, naming the fix for
 * the model's own wire. The sign-ins arrive through the `signIns` seam rather
 * than being read from the stores of the machine running the test: the
 * operator may well be signed in, and a test must not read a real keychain
 * (see claude-auth.ts). The provider environment is stripped for the same
 * reason — the claim is about a machine with no credential anywhere.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const home = mkdtempSync(join(tmpdir(), "lbb-credential-repl-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-credential-cwd-"));
	roots.push(home, cwd);
	// Discovery off, so the run touches no network; every other fact under the
	// fixture home is absent, which is the machine this test is about.
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify({ modelDiscovery: false }));
	return { home, cwd };
}

/**
 * Mount the real REPL with the transport and the frame mocked, and return the
 * info lines mounting pushed plus the exit code. No prompt is sent: the claim
 * is about what mounting says, not about what a request then does — the mock
 * frame's `waitUntilExit` returns immediately.
 */
async function mount(home: string, cwd: string, signIns: { claude: boolean; chatgpt: boolean }) {
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import * as tui from "@labunbun/tui";
		let state = { entries: [] };
		mock.module("@labunbun/ai", () => ({
			...ai,
			refreshModelCatalog: async () => null,
		}));
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: () => ({
				setTasks() {}, setContextInfo() {}, setBackgroundShells() {},
				store: { set(updater) { state = typeof updater === "function" ? updater(state) : updater; } },
				waitUntilExit: async () => {}
			})
		}));
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(${JSON.stringify({ cwd, home, theme: "dark", signIns })});
		console.log(JSON.stringify({ exitCode, entries: state.entries.map((entry) => entry.text ?? "") }));
	`;
	const env: Record<string, string | undefined> = { ...process.env };
	env.HOME = home;
	env.USERPROFILE = home;
	// The claim is about a machine with no credential in the environment
	// either, and the runner's own exports must not decide it.
	delete env.ANTHROPIC_API_KEY;
	delete env.ANTHROPIC_AUTH_TOKEN;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env,
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
	return JSON.parse(stdout.trim()) as { exitCode: number; entries: string[] };
}

describe("the startup credential notice", () => {
	test("a machine with no credential still mounts, and says the first prompt will fail", async () => {
		const { home, cwd } = fixture();

		const result = await mount(home, cwd, { claude: false, chatgpt: false });

		expect(result.exitCode).toBe(0);
		expect(result.entries.join("\n")).toContain(
			"No credential for anthropic/claude-sonnet-5 yet — the first prompt will fail. /login to sign in, or /yoshi to import a setup.",
		);
	}, 30_000);

	test("a signed-in machine mounts the same way and gets no notice", async () => {
		const { home, cwd } = fixture();

		const result = await mount(home, cwd, { claude: true, chatgpt: false });

		expect(result.exitCode).toBe(0);
		expect(result.entries.join("\n")).not.toContain("No credential for");
	}, 30_000);
});
