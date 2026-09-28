import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.ts";
import { MIGRATION_SOURCE_IDS } from "../src/migrate-types.ts";
import { borrowSourceEnv } from "./source-env.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

function withHome(tree: SourceTree, body: (home: string) => Promise<void> | void): Promise<void> | void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-cli-"));
	// Several sources keep their root in the environment rather than under the home
	// — `$DSH_HOME`, `$GROK_HOME`, `$KIMI_CODE_HOME`, the MiniMax and Step pairs —
	// so a developer whose shell exports one of them would have the CLI read
	// *their* tree instead of the fake home's, and the report would name files this
	// test never wrote. `source-env.ts` holds the whole list and the reason it has
	// to be complete: a per-variable list here is where the next source's variable
	// gets forgotten, and on Windows `APPDATA` alone puts a real Cursor or Trae
	// profile directory in reach.
	const releaseSourceEnv = borrowSourceEnv();
	const restore = (): void => {
		releaseSourceEnv();
		rmSync(home, { recursive: true, force: true });
	};
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

/**
 * Run `main` with console captured, since the CLI reports by printing. `home` is
 * optional because `--help` genuinely reads no configuration; everything that
 * does is inside a `withHome` and has one to hand.
 */
async function run(args: string[], home?: string): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
		out.push(parts.map(String).join(" "));
	});
	const error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
		err.push(parts.map(String).join(" "));
	});
	try {
		return { code: await main(args, { home }), out: out.join("\n"), err: err.join("\n") };
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
		await withHome({}, async (home) => {
			const { code, out, err } = await run(["migrate"], home);
			expect(code).toBe(0);
			expect(err).toBe("");
			expect(out).toContain("Nothing to import.");
		});
	});

	test("--migrate is the same command as the subcommand", async () => {
		await withHome(CLAUDE_TREE, async (home) => {
			const sub = await run(["migrate"], home);
			const flag = await run(["--migrate"], home);
			expect(flag.code).toBe(sub.code);
			expect(flag.out).toBe(sub.out);
			// Both are dry runs, so neither wrote anything.
			expect(sub.out).toContain("Dry run — nothing written.");
		});
	});

	test("yoshi is the subcommand, and every older spelling is the same run", async () => {
		await withHome(CLAUDE_TREE, async (home) => {
			const yoshi = await run(["yoshi"], home);
			expect(yoshi.code).toBe(0);
			expect(yoshi.err).toBe("");
			// Compared as whole runs rather than exit codes: a spelling that parsed
			// but took a different path would still exit 0.
			for (const spelling of [["migrate"], ["--yoshi"], ["--migrate"]]) {
				const other = await run(spelling, home);
				expect(other.code).toBe(yoshi.code);
				expect(other.out).toBe(yoshi.out);
				expect(other.err).toBe(yoshi.err);
			}
			// All four are dry runs, so none of them wrote anything.
			expect(yoshi.out).toContain("Dry run — nothing written.");
		});
	});

	test("--help names yoshi and says the old spelling still works", async () => {
		await withHome({}, async (home) => {
			const { code, out } = await run(["--help"], home);
			expect(code).toBe(0);
			expect(out).toContain("labunbun yoshi");
			expect(out).toContain("yoshi options:");
			expect(out).toContain("and still work");
		});
	});

	test("an unknown source is a usage error, not a crash", async () => {
		await withHome({}, async (home) => {
			const { code, err } = await run(["migrate", "--from", "nope"], home);
			expect(code).toBe(2);
			expect(err).toContain("Unknown migration source: nope");
			expect(err).toContain(`${MIGRATION_SOURCE_IDS.join(", ")}, all`);
		});
	});

	test("--from grok-build is a source the CLI knows, and reads that tree", async () => {
		const tree: SourceTree = {
			".grok/config.toml": '[models]\ndefault = "grok-4.6"\n',
			".grok/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
		};
		await withHome(tree, async (home) => {
			const { code, out, err } = await run(["migrate", "--from", "grok-build"], home);
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
		await withHome(tree, async (home) => {
			const { code, out, err } = await run(["migrate", "--from", "kimi-code"], home);
			expect(err).toBe("");
			expect(code).toBe(0);
			expect(out).toContain("~/.kimi-code/skills/pdf/SKILL.md");
			expect(out).toContain("no model of that name exists here");
			expect(out).toContain("Dry run — nothing written.");
		});
	});

	test("--from cursor reads the CLI's home, which is not where the editor keeps its state", async () => {
		// The two halves of Cursor keep different things in different places, and
		// the CLI's home is the one the CLI creates — a user who has only opened the
		// editor has no `~/.cursor` at all. So the fixture plants a rule and a config
		// in the CLI's half and nothing in the profile, and the assertion is that
		// both are read from the tree a `--from cursor` names.
		const tree: SourceTree = {
			".cursor/rules/style.mdc": "---\ndescription: One\nalwaysApply: true\n---\n\nDo the thing.\n",
			".cursor/cli-config.json": JSON.stringify({ model: "cursor-model-that-does-not-exist" }),
		};
		await withHome(tree, async (home) => {
			const { code, out, err } = await run(["migrate", "--from", "cursor"], home);
			expect(err).toBe("");
			expect(code).toBe(0);
			expect(out).toContain("~/.labunbun/rules/style.md");
			expect(out).toContain("no model in the registry matches this name");
			expect(out).toContain("Dry run — nothing written.");
		});
	});

	test("--from trae reads the rules directory, and the China home when that is the one there", async () => {
		// The asymmetric pair: a project rule and a global one, with the global one
		// in `~/.trae-cn` so a reader that guessed `~/.trae` would import the project
		// rule and drop the global one without a line about it. The stray sits at the
		// level *above* `user_rules` on purpose: the walk recurses, so planting the
		// global rule inside the directory would pass just as well against a reader
		// that scanned `~/.trae-cn/` flat. Asserted on the write path, which is the
		// only part of the report where a carried rule and a named file differ — the
		// name itself also appears in the sentence about the files nothing reads.
		const tree: SourceTree = {
			".trae-cn/user_rules/preferences.md": "---\nalwaysApply: true\n---\n\nDo the thing.\n",
			".trae-cn/stray.md": "---\nalwaysApply: true\n---\n\nDo the other thing.\n",
		};
		await withHome(tree, async (home) => {
			const { code, out, err } = await run(["migrate", "--from", "trae"], home);
			expect(err).toBe("");
			expect(code).toBe(0);
			expect(out).toContain("~/.labunbun/rules/preferences.md");
			expect(out).toContain("your user rules");
			expect(out).not.toContain("~/.labunbun/rules/stray.md");
			expect(out).toContain("Dry run — nothing written.");
		});
	});

	test("an unknown category and a bad limit are usage errors too", async () => {
		await withHome(CLAUDE_TREE, async (home) => {
			const category = await run(["migrate", "--only", "plugins"], home);
			expect(category.code).toBe(2);
			expect(category.err).toContain("Unknown category: plugins");

			const limit = await run(["migrate", "--history-limit", "abc"], home);
			expect(limit.code).toBe(2);
			expect(limit.err).toContain("Invalid history limit");

			const scope = await run(["migrate", "--history-scope", "everything"], home);
			expect(scope.code).toBe(2);
			expect(scope.err).toContain("Invalid history scope");
		});
	});

	test("--only reaches the planner", async () => {
		await withHome(CLAUDE_TREE, async (home) => {
			const { code, out } = await run(["migrate", "--only", "settings"], home);
			expect(code).toBe(0);
			expect(out).toContain("excluded by the category filter");
			expect(out).toContain("settings.json");
			expect(out).not.toContain("SKILL.md");
		});
	});

	test("--history-scope none turns history off out loud", async () => {
		await withHome(CLAUDE_TREE, async (home) => {
			const { code, out } = await run(["migrate", "--history-scope", "none"], home);
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
			const { code, out } = await run(["migrate", "--only", "history", "--history-limit", "1"], home);
			expect(code).toBe(0);
			expect(out).toContain("2 more session(s) matched but exceeded the limit");
		});
	});

	test("--apply writes, and the default run does not", async () => {
		await withHome(CLAUDE_TREE, async (home) => {
			await run(["migrate"], home);
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(false);
			const { code, out } = await run(["migrate", "--apply"], home);
			expect(code).toBe(0);
			expect(out).toContain("Wrote 2 file(s):");
			expect(out).toContain("~/.labunbun/settings.json");
			expect(out).toContain("~/.labunbun/skills/pdf/SKILL.md");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
		});
	});

	test("--help lists the new sources and flags", async () => {
		// No `withHome`: printing the help reads no configuration, which is the
		// point of checking it before anything is migrated.
		const { code, out } = await run(["--help"]);
		expect(code).toBe(0);
		// Built from the source list rather than written out, so a source added
		// later is in the expected string the day it is registered instead of the
		// day somebody remembers to touch this assertion.
		expect(out).toContain(`${MIGRATION_SOURCE_IDS.join(" | ")} | all`);
		expect(out).toContain("--only <categories>");
		expect(out).toContain("--history-scope <s>");
		expect(out).toContain("--history-limit <n>");
	});
});
