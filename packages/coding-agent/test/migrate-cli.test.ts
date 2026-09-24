import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

function withHome(tree: SourceTree, body: (home: string) => Promise<void> | void): Promise<void> | void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-cli-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	// Three sources keep their root in the environment rather than under the home —
	// `$DSH_HOME`, `$GROK_HOME` and `$KIMI_CODE_HOME` — so a developer whose shell
	// exports one of them would have the CLI read *their* tree instead of the fake
	// home's, and the report would name files this test never wrote. Kimi Code's
	// predecessor tree comes from a fourth (`$KIMI_SHARE_DIR`), which would put an
	// extra line in the report of a home that never held one.
	const prevDsh = process.env.DSH_HOME;
	const prevGrok = process.env.GROK_HOME;
	const prevKimi = process.env.KIMI_CODE_HOME;
	const prevKimiShare = process.env.KIMI_SHARE_DIR;
	const restore = (): void => {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		if (prevDsh === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevDsh;
		if (prevGrok === undefined) delete process.env.GROK_HOME;
		else process.env.GROK_HOME = prevGrok;
		if (prevKimi === undefined) delete process.env.KIMI_CODE_HOME;
		else process.env.KIMI_CODE_HOME = prevKimi;
		if (prevKimiShare === undefined) delete process.env.KIMI_SHARE_DIR;
		else process.env.KIMI_SHARE_DIR = prevKimiShare;
		rmSync(home, { recursive: true, force: true });
	};
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	delete process.env.DSH_HOME;
	delete process.env.GROK_HOME;
	delete process.env.KIMI_CODE_HOME;
	delete process.env.KIMI_SHARE_DIR;
	for (const [path, content] of Object.entries(tree)) {
		const full = join(home, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	const result = body(home);
	if (result instanceof Promise) return result.finally(restore);
	restore();
	return undefined;
}

/** Run `main` with console captured, since the CLI reports by printing. */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		out.push(parts.map(String).join(" "));
	});
	const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		err.push(parts.map(String).join(" "));
	});
	try {
		return { code: await main(args), out: out.join("\n"), err: err.join("\n") };
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

const CLAUDE_TREE: SourceTree = {
	".claude/settings.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example/v1" }, model: "opus" }),
	".claude/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
};

/** A Claude Code transcript whose project is the one the tests run from. */
function sessionRow(): string {
	return `${JSON.stringify({
		type: "user",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: process.cwd(),
		message: { role: "user", content: "hello" },
	})}\n`;
}

describe("migrate CLI", () => {
	test("a home with no source says so and exits clean", async () => {
		await withHome({}, async () => {
			const { code, out, err } = await run(["migrate"]);
			expect(code).toBe(0);
			expect(err).toBe("");
			expect(out).toContain("Nothing to import.");
		});
	});

	test("--migrate is the same command as the subcommand", async () => {
		await withHome(CLAUDE_TREE, async () => {
			const sub = await run(["migrate"]);
			const flag = await run(["--migrate"]);
			expect(flag.code).toBe(sub.code);
			expect(flag.out).toBe(sub.out);
			// Both are dry runs, so neither wrote anything.
			expect(sub.out).toContain("Dry run — nothing written.");
		});
	});

	test("an unknown source is a usage error, not a crash", async () => {
		await withHome({}, async () => {
			const { code, err } = await run(["migrate", "--from", "nope"]);
			expect(code).toBe(2);
			expect(err).toContain("Unknown migration source: nope");
			expect(err).toContain(
				"claude-code, codex, zcode, agents, deepseek-harness, grok-build, kimi-code, minimax-code, step-code, all",
			);
		});
	});

	test("--from grok-build is a source the CLI knows, and reads that tree", async () => {
		const tree: SourceTree = {
			".grok/config.toml": '[models]\ndefault = "grok-4.6"\n',
			".grok/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
		};
		await withHome(tree, async () => {
			const { code, out, err } = await run(["migrate", "--from", "grok-build"]);
			expect(err).toBe("");
			expect(code).toBe(0);
			// The plan is built out of the grok tree, and the default model the source
			// pins is a skip with a reason rather than a model reference written blind.
			expect(out).toContain("~/.labunbun/skills/pdf/SKILL.md");
			expect(out).toContain("no model here answers to that name");
			expect(out).toContain("Dry run — nothing written.");
		});
	});

	test("--from kimi-code reads kimi's tree, in the spelling kimi writes it", async () => {
		// `default_model` is the snake spelling kimi's own writer produces; the model
		// it names is not one this build knows, which is a skip with a reason rather
		// than a model reference written blind.
		const tree: SourceTree = {
			".kimi-code/config.toml": 'default_model = "kimi-k9-unreleased"\n',
			".kimi-code/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
		};
		await withHome(tree, async () => {
			const { code, out, err } = await run(["migrate", "--from", "kimi-code"]);
			expect(err).toBe("");
			expect(code).toBe(0);
			expect(out).toContain("~/.kimi-code/skills/pdf/SKILL.md");
			expect(out).toContain("no model of that name exists here");
			expect(out).toContain("Dry run — nothing written.");
		});
	});

	test("an unknown category and a bad limit are usage errors too", async () => {
		await withHome(CLAUDE_TREE, async () => {
			const category = await run(["migrate", "--only", "plugins"]);
			expect(category.code).toBe(2);
			expect(category.err).toContain("Unknown category: plugins");

			const limit = await run(["migrate", "--history-limit", "abc"]);
			expect(limit.code).toBe(2);
			expect(limit.err).toContain("Invalid history limit");

			const scope = await run(["migrate", "--history-scope", "everything"]);
			expect(scope.code).toBe(2);
			expect(scope.err).toContain("Invalid history scope");
		});
	});

	test("--only reaches the planner", async () => {
		await withHome(CLAUDE_TREE, async () => {
			const { code, out } = await run(["migrate", "--only", "settings"]);
			expect(code).toBe(0);
			expect(out).toContain("excluded by the category filter");
			expect(out).toContain("settings.json");
			expect(out).not.toContain("SKILL.md");
		});
	});

	test("--history-scope none turns history off out loud", async () => {
		await withHome(CLAUDE_TREE, async () => {
			const { code, out } = await run(["migrate", "--history-scope", "none"]);
			expect(code).toBe(0);
			expect(out).toContain("history import is off (--history-scope none)");
		});
	});

	test("--history-limit caps the sessions a run takes", async () => {
		const tree: SourceTree = { ".claude/settings.json": "{}" };
		await withHome(tree, async (home) => {
			for (const id of ["one", "two", "three"]) {
				const path = join(home, ".claude", "projects", "-project", `${id}.jsonl`);
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, sessionRow());
			}
			const { code, out } = await run(["migrate", "--only", "history", "--history-limit", "1"]);
			expect(code).toBe(0);
			expect(out).toContain("2 more session(s) matched but exceeded the limit");
		});
	});

	test("--apply writes, and the default run does not", async () => {
		await withHome(CLAUDE_TREE, async (home) => {
			await run(["migrate"]);
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(false);
			const { code, out } = await run(["migrate", "--apply"]);
			expect(code).toBe(0);
			expect(out).toContain("Wrote 2 file(s):");
			expect(out).toContain("~/.labunbun/settings.json");
			expect(out).toContain("~/.labunbun/skills/pdf/SKILL.md");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
		});
	});

	test("--help lists the new sources and flags", async () => {
		const { code, out } = await run(["--help"]);
		expect(code).toBe(0);
		expect(out).toContain(
			"claude-code | codex | zcode | agents | deepseek-harness | grok-build | kimi-code | minimax-code | step-code | all",
		);
		expect(out).toContain("--only <categories>");
		expect(out).toContain("--history-scope <s>");
		expect(out).toContain("--history-limit <n>");
	});
});
