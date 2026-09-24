/**
 * The `/migrate` wizard, driven through a scripted dialog.
 *
 * The bridge is the seam that makes this testable without a terminal: the
 * wizard may only learn what the user decided by asking, so a stub that answers
 * is a user, and a stub that throws on an unscripted call is a user who was
 * asked something the test did not expect.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtInCommands, findCommand, type LocalCommand, type LocalCommandContext } from "../src/commands.ts";
import { importedSessionId } from "../src/migrate-history.ts";
import { type MigrationDialogBridge, type MigrationDialogItem, runMigrationWizard } from "../src/migrate-wizard.ts";

type SourceTree = Record<string, string>;

/**
 * Every variable that moves a source's tree.
 *
 * Five of the nine sources let an environment variable put their tree anywhere —
 * sometimes the whole tree (`$CODEX_HOME`, `$DSH_HOME`, `$GROK_HOME`,
 * `$KIMI_CODE_HOME`, MiniMax's pair, Step's two), sometimes a part of it
 * (`$KIMI_SHARE_DIR` names Kimi's predecessor tree, `$STEP_CODING_AGENT_SESSION_DIR`
 * its session directory; Step's session override is a per-process question the
 * planner answers from a temporary home's environment without it meaning a
 * different tree, so the test makes that meaning true). A developer whose shell
 * exports one would have the wizard detect (or miss) a source by a directory the
 * test never wrote, and the questions it asks would name files that are not
 * there. The same discipline `migrate-cli.test.ts` documents for its own fake
 * home, applied to the wizard's.
 */
const TREE_ENV_VARS = [
	"CODEX_HOME",
	"DSH_HOME",
	"GROK_HOME",
	"KIMI_CODE_HOME",
	"KIMI_SHARE_DIR",
	"MINIMAX_DATA_DIR",
	"MAVIS_DATA_DIR",
	"STEPCODE_CONFIG_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"STEP_CODING_AGENT_DIR",
	"STEP_CODING_AGENT_SESSION_DIR",
] as const;

/** The fake home, both in the environment and in the caller's hands. */
function withHome(tree: SourceTree, body: (home: string) => Promise<void> | void): Promise<void> | void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-wizard-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	const borrowed = TREE_ENV_VARS.map((name) => [name, process.env[name]] as const);
	const restore = (): void => {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		for (const [name, value] of borrowed) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(home, { recursive: true, force: true });
	};
	process.env.USERPROFILE = home;
	process.env.HOME = home;
	for (const name of TREE_ENV_VARS) delete process.env[name];
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

const CWD = process.cwd();

const CLAUDE_SETTINGS = JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: "https://proxy.example/v1" } });
const CODEX_CONFIG = ['model = "gpt-5-codex"', 'base_url = "https://provider.example/v1"'].join("\n");

/** A home with two sources, one settings file, one skill and one codex rule. */
function twoSources(): SourceTree {
	return {
		".claude/settings.json": CLAUDE_SETTINGS,
		".claude/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
		".codex/config.toml": CODEX_CONFIG,
		".codex/AGENTS.md": "Codex memory content.\n",
	};
}

/** Claude Code tree with two sessions here and one in another project. */
function historyTree(): SourceTree {
	return {
		".claude/settings.json": CLAUDE_SETTINGS,
		".claude/projects/-tmp-proj/newest.jsonl": claudeRows(CWD, "2026-01-03T00:00:00.000Z"),
		".claude/projects/-tmp-proj/second.jsonl": claudeRows(CWD, "2026-01-02T00:00:00.000Z"),
		".claude/projects/-tmp-proj/elsewhere.jsonl": claudeRows(tmpdir(), "2026-01-01T00:00:00.000Z"),
	};
}

/** A minimal Claude Code transcript, stamped so ordering is deterministic. */
function claudeRows(cwd: string, startedAt: string): string {
	return `${[
		{
			type: "user",
			timestamp: startedAt,
			cwd,
			message: { role: "user", content: "hello" },
		},
		{
			type: "assistant",
			timestamp: startedAt,
			cwd,
			message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] },
		},
	]
		.map((row) => JSON.stringify(row))
		.join("\n")}\n`;
}

/** Where a Claude Code session's transcript would land in the target. */
function importedPath(home: string, sessionId: string, cwd = CWD): string {
	const project = cwd.replace(/[:\\/]/g, "-");
	return join(home, ".labunbun", "projects", project, `${importedSessionId("claude-code", sessionId)}.jsonl`);
}

/** A line of `~/.claude/history.jsonl`: `project` is the directory it was typed in. */
function claudePrompt(text: string, cwd: string, ms: number): Record<string, unknown> {
	return { display: text, pastedContents: {}, project: cwd, sessionId: "s-1", timestamp: ms };
}

function jsonl(rows: Array<Record<string, unknown>>): string {
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** The recall file the run wrote, or "" when it wrote none. */
function recallText(home: string): string {
	const path = join(home, ".labunbun", "history.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

interface Asked {
	question: string;
	header: string;
	options: MigrationDialogItem[];
}

/** A dialog that answers from a script and remembers everything it was asked. */
function scriptedDialog(options: { answers?: Array<string[] | null>; picks?: Array<number | null> }): {
	bridge: MigrationDialogBridge;
	asked: Asked[];
	titles: string[];
} {
	const answers = [...(options.answers ?? [])];
	const picks = [...(options.picks ?? [])];
	const asked: Asked[] = [];
	const titles: string[] = [];
	const bridge: MigrationDialogBridge = {
		askUser: async (questions) => {
			asked.push(...questions);
			if (answers.length === 0) throw new Error(`unscripted askUser: ${questions[0]?.question}`);
			return answers.shift() ?? null;
		},
		pickFromList: async (title) => {
			titles.push(title);
			if (picks.length === 0) throw new Error(`unscripted pickFromList: ${title}`);
			return picks.shift() ?? null;
		},
	};
	return { bridge, asked, titles };
}

/**
 * Run the wizard against a fake home, collecting what it pushed to the user.
 *
 * Detection reads the environment as well as the home, and `$DSH_HOME`,
 * `$GROK_HOME` and `$KIMI_CODE_HOME` — not the fake home's `~/.dsh`, `~/.grok`
 * and `~/.kimi-code` — decide where those three roots are when they are set, so
 * the run clears them the way `withHome` fixes `HOME`. A developer whose own shell
 * exports one of them must not change which sources these tests are asked about.
 * `$KIMI_SHARE_DIR` decides nothing about *which* sources are detected, but it
 * decides where the tree kimi-cli left behind is said to be, so it is cleared too.
 */
async function wizard(
	home: string,
	dialog: MigrationDialogBridge,
): Promise<{ result: string | undefined; reported: string[] }> {
	const prevDsh = process.env.DSH_HOME;
	const prevGrok = process.env.GROK_HOME;
	const prevKimi = process.env.KIMI_CODE_HOME;
	const prevKimiShare = process.env.KIMI_SHARE_DIR;
	const reported: string[] = [];
	try {
		delete process.env.DSH_HOME;
		delete process.env.GROK_HOME;
		delete process.env.KIMI_CODE_HOME;
		delete process.env.KIMI_SHARE_DIR;
		const result = await runMigrationWizard({ dialog, home, cwd: CWD, report: (text) => reported.push(text) });
		return { result, reported };
	} finally {
		if (prevDsh !== undefined) process.env.DSH_HOME = prevDsh;
		if (prevGrok !== undefined) process.env.GROK_HOME = prevGrok;
		if (prevKimi !== undefined) process.env.KIMI_CODE_HOME = prevKimi;
		if (prevKimiShare !== undefined) process.env.KIMI_SHARE_DIR = prevKimiShare;
	}
}

describe("migrate wizard: sources", () => {
	test("the first questions name the sources that were detected", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["No", "No"]] });
			const { result } = await wizard(home, bridge);
			expect(result).toBe("No source selected — nothing to import.");
			expect(asked).toHaveLength(3); // the mode question, then one per source
			expect(asked.map((question) => question.question)).toEqual([
				"Import your existing setup?",
				"Import from Claude Code?",
				"Import from Codex?",
			]);
			// The question is answerable without knowing which tools exist, and it
			// is not a menu of raw ids.
			expect(asked[1].options.map((option) => option.label)).toEqual(["Yes", "No"]);
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});

	test("cancelling the source dialog stops before anything is read or written", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], null] });
			const { result, reported } = await wizard(home, bridge);
			expect(result).toBe("Migration cancelled — nothing was read or written.");
			// The mode question, then the source dialog's one call of two questions.
			expect(asked).toHaveLength(3);
			expect(reported).toEqual([]);
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});

	test("a source directory with nothing in it is not asked about", async () => {
		await withHome(twoSources(), async (home) => {
			// Both extra roots exist empty, so neither adds a question — and the
			// answers above stay one per *detected* source, in `detectSources`
			// order: `~/.dsh` is appended after the four original sources, so
			// filling it in would add its question last, not move the others.
			mkdirSync(join(home, ".agents"), { recursive: true });
			mkdirSync(join(home, ".dsh"), { recursive: true });
			const { bridge, asked } = scriptedDialog({
				answers: [["Choose…"], ["Yes", "Yes"], ["Yes", "Yes", "No"], ["Apply"]],
			});
			const { result } = await wizard(home, bridge);
			expect(asked.map((question) => question.question)).not.toContain("Import from ~/.agents (shared agent home)?");
			expect(asked.map((question) => question.question)).not.toContain("Import from DeepSeek Harness?");
			expect(result).toContain("Restart to pick up the imported configuration.");
		});
	});

	test("the harness source is asked about last", async () => {
		await withHome(
			{
				...twoSources(),
				".dsh/settings.yaml": "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n",
			},
			async (home) => {
				const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["No", "No", "No"]] });
				const { result } = await wizard(home, bridge);
				// A new source is appended: the four original questions keep their
				// order and answers, and the harness is asked about after them.
				expect(asked.map((question) => question.question)).toEqual([
					"Import your existing setup?",
					"Import from Claude Code?",
					"Import from Codex?",
					"Import from DeepSeek Harness?",
				]);
				expect(result).toBe("No source selected — nothing to import.");
			},
		);
	});

	test("the grok source is asked about after the harness, and its label is not the raw id", async () => {
		await withHome(
			{
				...twoSources(),
				".dsh/settings.yaml": "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n",
				".grok/config.toml": '[models]\ndefault = "grok-4.6"\n',
			},
			async (home) => {
				// One answer per detected source, and the last two are new: the two
				// environment-first roots come after the four original ones, in the
				// order their ids were appended.
				const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["No", "No", "No", "No"]] });
				const { result } = await wizard(home, bridge);
				expect(asked.map((question) => question.question)).toEqual([
					"Import your existing setup?",
					"Import from Claude Code?",
					"Import from Codex?",
					"Import from DeepSeek Harness?",
					"Import from Grok Build?",
				]);
				expect(result).toBe("No source selected — nothing to import.");
			},
		);
	});

	test("the kimi source is asked about after grok, and its label is not the raw id", async () => {
		await withHome(
			{
				...twoSources(),
				".dsh/settings.yaml": "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n",
				".grok/config.toml": '[models]\ndefault = "grok-4.6"\n',
				".kimi-code/config.toml": 'default_model = "kimi-k3"\n',
			},
			async (home) => {
				// One answer per detected source, and the fifth is the newest: the three
				// environment-first roots come after the four original ones, in the order
				// their ids were appended.
				const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["No", "No", "No", "No", "No"]] });
				const { result } = await wizard(home, bridge);
				expect(asked.map((question) => question.question)).toEqual([
					"Import your existing setup?",
					"Import from Claude Code?",
					"Import from Codex?",
					"Import from DeepSeek Harness?",
					"Import from Grok Build?",
					"Import from Kimi Code?",
				]);
				expect(result).toBe("No source selected — nothing to import.");
			},
		);
	});

	test("the minimax source is asked about after kimi, and its label is not the raw id", async () => {
		await withHome(
			{
				...twoSources(),
				".dsh/settings.yaml": "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n",
				".grok/config.toml": '[models]\ndefault = "grok-4.6"\n',
				".kimi-code/config.toml": 'default_model = "kimi-k3"\n',
				".minimax/config.yaml": "model: minimax-m2.5\n",
			},
			async (home) => {
				// One answer per detected source, and the seventh is the newest: the
				// two sources after the three environment-first roots, in the order
				// their ids were appended. MiniMax's root is home-relative by default,
				// so the home alone decides whether it is offered.
				const { bridge, asked } = scriptedDialog({
					answers: [["Choose…"], ["No", "No", "No", "No", "No", "No"]],
				});
				const { result } = await wizard(home, bridge);
				expect(asked.map((question) => question.question)).toEqual([
					"Import your existing setup?",
					"Import from Claude Code?",
					"Import from Codex?",
					"Import from DeepSeek Harness?",
					"Import from Grok Build?",
					"Import from Kimi Code?",
					"Import from MiniMax Code?",
				]);
				expect(result).toBe("No source selected — nothing to import.");
			},
		);
	});

	test("the step source is asked about after minimax, and its label is not the raw id", async () => {
		await withHome(
			{
				...twoSources(),
				".dsh/settings.yaml": "agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-pro\n",
				".grok/config.toml": '[models]\ndefault = "grok-4.6"\n',
				".kimi-code/config.toml": 'default_model = "kimi-k3"\n',
				".minimax/config.yaml": "model: minimax-m2.5\n",
				".stepcode/config.toml": 'defaultModel = "step-3"\n',
			},
			async (home) => {
				// The eighth and last question, and the label is the product's name
				// rather than the id — the picker is the only place a user meets the id
				// at all.
				const { bridge, asked } = scriptedDialog({
					answers: [["Choose…"], ["No", "No", "No", "No", "No", "No", "No"]],
				});
				const { result } = await wizard(home, bridge);
				expect(asked.map((question) => question.question)).toEqual([
					"Import your existing setup?",
					"Import from Claude Code?",
					"Import from Codex?",
					"Import from DeepSeek Harness?",
					"Import from Grok Build?",
					"Import from Kimi Code?",
					"Import from MiniMax Code?",
					"Import from Step Code?",
				]);
				expect(result).toBe("No source selected — nothing to import.");
			},
		);
	});

	test("answering no to a source keeps that source out of the plan", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge } = scriptedDialog({ answers: [["Choose…"], ["Yes", "No"], ["Yes", "Yes", "No"], ["Apply"]] });
			const { result } = await wizard(home, bridge);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "skills", "pdf", "SKILL.md"))).toBe(true);
			// Codex said yes to nothing, so its rule must not be there.
			expect(existsSync(join(home, ".labunbun", "rules", "imported-codex.md"))).toBe(false);
		});
	});
});

describe("migrate wizard: categories", () => {
	test("declining a category leaves its files alone, even where there is something to take", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["Yes"], ["Yes", "No", "No"], ["Apply"]] });
			const { result } = await wizard(home, bridge);
			// The transcripts are on disk, and the user still was not asked about
			// them, because the category answer already settled it.
			expect(asked.map((question) => question.question)).not.toContain(
				"Which Claude Code conversations should come across?",
			);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "projects"))).toBe(false);
		});
	});

	test("cancelling the category dialog writes nothing", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: [["Choose…"], ["Yes"], null] });
			const { result, reported } = await wizard(home, bridge);
			expect(result).toBe("Migration cancelled — nothing was read or written.");
			expect(reported).toEqual([]);
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});

	test("declining every category writes nothing", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: [["Choose…"], ["Yes"], ["No", "No", "No"]] });
			const { result } = await wizard(home, bridge);
			expect(result).toBe("No category selected — nothing to import.");
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});
});

describe("migrate wizard: history", () => {
	/** Source yes, settings yes, history yes, then the history answer itself. */
	function historyAnswers(scope: string): Array<string[] | null> {
		return [["Choose…"], ["Yes"], ["Yes", "No", "Yes"], [scope], ["Apply"]];
	}

	test("'only this project' leaves the other project's sessions behind", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: historyAnswers("Only this project (2)") });
			const { result } = await wizard(home, bridge);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(importedPath(home, "newest"))).toBe(true);
			expect(existsSync(importedPath(home, "second"))).toBe(true);
			expect(existsSync(importedPath(home, "elsewhere"))).toBe(false);
		});
	});

	test("'everything' takes the cross-project session too, into its own project", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: historyAnswers("Everything (3)") });
			const { result } = await wizard(home, bridge);
			expect(result).toContain("Restart to pick up the imported configuration.");
			// Imported under the directory it came from, not the one we are in:
			// `--continue` looks sessions up per project.
			expect(existsSync(importedPath(home, "elsewhere", tmpdir()))).toBe(true);
			expect(existsSync(importedPath(home, "elsewhere"))).toBe(false);
		});
	});

	test("the picker imports the session that was picked, not the newest", async () => {
		await withHome(historyTree(), async (home) => {
			// Entry 0 is "all of them"; entry 1 the newest session, entry 2 the next.
			const { bridge, titles } = scriptedDialog({
				answers: historyAnswers("Choose sessions…"),
				picks: [2],
			});
			const { result } = await wizard(home, bridge);
			expect(titles).toEqual(["Claude Code sessions"]);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(importedPath(home, "second"))).toBe(true);
			expect(existsSync(importedPath(home, "newest"))).toBe(false);
		});
	});

	test("cancelling the picker skips history but still imports the settings", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: historyAnswers("Choose sessions…"), picks: [null] });
			const { result } = await wizard(home, bridge);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "projects"))).toBe(false);
		});
	});

	test("'skip history' still imports the settings", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: historyAnswers("Skip history") });
			const { result } = await wizard(home, bridge);
			expect(asked.map((question) => question.question)).toContain(
				"Which Claude Code conversations should come across?",
			);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "projects"))).toBe(false);
		});
	});

	test("a source with no sessions at all is not asked about", async () => {
		await withHome({ ".claude/settings.json": CLAUDE_SETTINGS }, async (home) => {
			// Four answers, not five: with nothing to list there is no history
			// question to answer.
			const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["Yes"], ["Yes", "Yes", "Yes"], ["Apply"]] });
			const { result } = await wizard(home, bridge);
			expect(asked.map((question) => question.question)).not.toContain(
				"Which Claude Code conversations should come across?",
			);
			expect(result).toContain("Restart to pick up the imported configuration.");
			// Asking for history with nothing to take still imports the settings.
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
		});
	});

	test("choosing 'only this project' where nothing is left says so out loud", async () => {
		await withHome(
			{
				".claude/settings.json": CLAUDE_SETTINGS,
				".claude/projects/-tmp-proj/elsewhere.jsonl": claudeRows(tmpdir(), "2026-01-01T00:00:00.000Z"),
			},
			async (home) => {
				const { bridge } = scriptedDialog({
					answers: historyAnswers("Only this project (0)"),
				});
				const { result, reported } = await wizard(home, bridge);
				expect(reported.join("\n")).toContain("no sessions imported");
				expect(existsSync(join(home, ".labunbun", "projects"))).toBe(false);
				expect(result).toContain("Restart to pick up the imported configuration.");
			},
		);
	});
});

describe("migrate wizard: prompts ride along with the history answer", () => {
	/** One session here, one elsewhere, and prompts typed in both directories. */
	function promptTree(): SourceTree {
		return {
			".claude/settings.json": CLAUDE_SETTINGS,
			".claude/projects/-tmp-proj/newest.jsonl": claudeRows(CWD, "2026-01-03T00:00:00.000Z"),
			".claude/projects/-tmp-proj/elsewhere.jsonl": claudeRows(tmpdir(), "2026-01-01T00:00:00.000Z"),
			".claude/history.jsonl": jsonl([
				claudePrompt("typed here", CWD, 1_700_000_000_000),
				claudePrompt("typed over there", tmpdir(), 1_700_000_001_000),
			]),
		};
	}

	/** What ↑ would read back, oldest first. */
	function recall(home: string): Array<{ text: string; cwd: string }> {
		return recallText(home)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { text: string; cwd: string });
	}

	/** Step-by-step, source yes, settings yes, history yes, then the history answer. */
	function answers(scope: string): Array<string[] | null> {
		return [["Choose…"], ["Yes"], ["Yes", "No", "Yes"], [scope], ["Apply"]];
	}

	test("'only this project' brings its prompts and leaves the other directory's", async () => {
		await withHome(promptTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: answers("Only this project (1)") });
			const { result, reported } = await wizard(home, bridge);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(recall(home).map((entry) => [entry.text, entry.cwd])).toEqual([["typed here", CWD]]);
			// The prompt that stayed behind is reported, not silently dropped.
			expect(reported.join("\n")).toContain("prompt from another directory — 1 not imported");
		});
	});

	test("'everything' brings the other directory's prompts with it", async () => {
		await withHome(promptTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: answers("Everything (2)") });
			await wizard(home, bridge);
			// Each prompt keeps the directory it was typed in: recall filters by it.
			expect(recall(home).map((entry) => [entry.text, entry.cwd])).toEqual([
				["typed here", CWD],
				["typed over there", tmpdir()],
			]);
		});
	});

	test("picking one conversation takes the prompts of the directory it happened in", async () => {
		await withHome(promptTree(), async (home) => {
			// Entry 0 is "all of them"; entry 2 is the session from the other directory.
			const { bridge } = scriptedDialog({ answers: answers("Choose sessions…"), picks: [2] });
			await wizard(home, bridge);
			expect(recall(home).map((entry) => [entry.text, entry.cwd])).toEqual([["typed over there", tmpdir()]]);
		});
	});

	test("'skip history' leaves the recall list alone", async () => {
		await withHome(promptTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: answers("Skip history") });
			const { result } = await wizard(home, bridge);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(recallText(home)).toBe("");
		});
	});

	test("a second run adds no prompt the recall list already has", async () => {
		await withHome(promptTree(), async (home) => {
			const first = scriptedDialog({ answers: answers("Everything (2)") });
			await wizard(home, first.bridge);
			const written = recallText(home);
			expect(written).toContain("typed here");

			const second = scriptedDialog({ answers: answers("Everything (2)") });
			const { reported } = await wizard(home, second.bridge);
			expect(recallText(home)).toBe(written);
			expect(reported.join("\n")).toContain("already in the recall history");
		});
	});
});

describe("migrate wizard: the one-question path", () => {
	/** Two sources, a skill, sessions here and elsewhere, prompts in both. */
	function quickTree(): SourceTree {
		return {
			".claude/settings.json": CLAUDE_SETTINGS,
			".claude/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
			".claude/projects/-tmp-proj/newest.jsonl": claudeRows(CWD, "2026-01-03T00:00:00.000Z"),
			".claude/projects/-tmp-proj/elsewhere.jsonl": claudeRows(tmpdir(), "2026-01-01T00:00:00.000Z"),
			".claude/history.jsonl": jsonl([
				claudePrompt("typed here", CWD, 1_700_000_000_000),
				claudePrompt("typed over there", tmpdir(), 1_700_000_001_000),
			]),
			".codex/config.toml": CODEX_CONFIG,
			".codex/AGENTS.md": "Codex memory content.\n",
		};
	}

	/** The mode answer, the history answer it still asks for, then the confirm. */
	function everythingAnswers(scope: string): Array<string[] | null> {
		return [["Import everything"], [scope], ["Apply"]];
	}

	test("'import everything' takes every source and category after one question", async () => {
		await withHome(quickTree(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: everythingAnswers("Everything (2)") });
			const { result } = await wizard(home, bridge);
			expect(asked.map((question) => question.header)).toEqual(["Migration", "History", "Confirm"]);
			expect(result).toContain("Restart to pick up the imported configuration.");
			// One from each category, without either of them being asked about.
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "skills", "pdf", "SKILL.md"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "rules", "imported-codex.md"))).toBe(true);
			expect(existsSync(importedPath(home, "elsewhere", tmpdir()))).toBe(true);
			expect(recallText(home)).toContain("typed over there");
		});
	});

	test("the one-question path still asks about history", async () => {
		await withHome(quickTree(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: everythingAnswers("Skip history") });
			const { result } = await wizard(home, bridge);
			expect(asked.map((question) => question.question)).toContain(
				"Which Claude Code conversations should come across?",
			);
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "projects"))).toBe(false);
			expect(existsSync(join(home, ".labunbun", "history.jsonl"))).toBe(false);
		});
	});

	test("cancelling the first question reads and writes nothing", async () => {
		await withHome(quickTree(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [null] });
			const { result, reported } = await wizard(home, bridge);
			expect(result).toBe("Migration cancelled — nothing was read or written.");
			expect(asked).toHaveLength(1);
			expect(reported).toEqual([]);
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});

	test("'choose' leads to the step-by-step questions", async () => {
		await withHome(quickTree(), async (home) => {
			const { bridge, asked } = scriptedDialog({
				answers: [["Choose…"], ["Yes", "No"], ["Yes", "No", "No"], ["Apply"]],
			});
			const { result } = await wizard(home, bridge);
			expect(asked.map((question) => question.header)).toEqual([
				"Migration",
				"Claude Code",
				"Codex",
				"Categories",
				"Categories",
				"Categories",
				"Confirm",
			]);
			expect(result).toContain("Restart to pick up the imported configuration.");
			// Codex was declined at the source question, so its memory stays put.
			expect(existsSync(join(home, ".labunbun", "rules", "imported-codex.md"))).toBe(false);
		});
	});
});

describe("migrate wizard: the plan is shown before it is written", () => {
	test("declining the preview leaves the home untouched", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["Yes"], ["Yes", "Yes", "No"], ["Cancel"]] });
			const { result, reported } = await wizard(home, bridge);
			expect(result).toBe("Nothing written (dry run only).");
			expect(reported).toHaveLength(1);
			expect(reported[0]).toContain("Dry run — nothing written.");
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
			const confirm = asked.at(-1);
			expect(confirm?.question).toMatch(/^Apply these \d+ file\(s\)\?$/);
			expect(confirm?.options.map((option) => option.label)).toEqual(["Apply", "Cancel"]);
		});
	});

	test("what the preview listed is what lands on disk", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge } = scriptedDialog({ answers: [["Choose…"], ["Yes"], ["Yes", "Yes", "No"], ["Apply"]] });
			const { result, reported } = await wizard(home, bridge);
			expect(reported[0]).toContain("~/.labunbun/settings.json");
			expect(reported[0]).toContain("~/.labunbun/skills/pdf/SKILL.md");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
			expect(existsSync(join(home, ".labunbun", "skills", "pdf", "SKILL.md"))).toBe(true);
			expect(result).toContain("Restart to pick up the imported configuration.");
		});
	});

	test("a plan that would write nothing does not ask to confirm it", async () => {
		// The target already holds the only value the source would contribute, so
		// the plan is empty and there is nothing to confirm.
		await withHome(
			{
				".claude/settings.json": JSON.stringify({ model: "opus" }),
				".labunbun/settings.json": JSON.stringify({ model: "opus" }),
			},
			async (home) => {
				const { bridge, asked } = scriptedDialog({ answers: [["Choose…"], ["Yes"], ["Yes", "No", "No"]] });
				const { result, reported } = await wizard(home, bridge);
				expect(asked.map((question) => question.header)).toEqual([
					"Migration",
					"Claude Code",
					"Categories",
					"Categories",
					"Categories",
				]);
				expect(reported[0]).toContain("Dry run — nothing to write.");
				expect(result).toBe("Nothing to write — the report above says why.");
			},
		);
	});

	test("a home with nothing to import says so without asking", async () => {
		await withHome({}, async (home) => {
			const { bridge, asked } = scriptedDialog({});
			const { result } = await wizard(home, bridge);
			expect(result).toBe("No source configuration found. Nothing to import.");
			expect(asked).toEqual([]);
		});
	});
});

describe("migrate command: when the wizard is not the right shape", () => {
	/** The command only reaches for the context in its wizard branch. */
	function commandContext(dialog?: MigrationDialogBridge): LocalCommandContext {
		return {
			session: null as unknown as LocalCommandContext["session"],
			cwd: CWD,
			pushInfo: () => {},
			dialog,
		};
	}

	function migrateCommand(): LocalCommand {
		const command = findCommand(builtInCommands(), "migrate");
		if (command?.type !== "local") throw new Error("/migrate should be a local command");
		return command;
	}

	test("arguments take the flag path, never the dialog", async () => {
		await withHome(twoSources(), async (home) => {
			const command = migrateCommand();
			const refuse: MigrationDialogBridge = {
				askUser: async () => {
					throw new Error("the dialog must not be opened when flags are given");
				},
				pickFromList: async () => {
					throw new Error("the dialog must not be opened when flags are given");
				},
			};
			const result = await command.call(commandContext(refuse), "--apply");
			expect(result).toContain("Restart to pick up the imported configuration.");
			expect(existsSync(join(home, ".labunbun", "settings.json"))).toBe(true);
		});
	});

	test("without a dialog the bare command is still the non-interactive report", async () => {
		await withHome(twoSources(), async (home) => {
			const command = migrateCommand();
			const result = await command.call(commandContext(), "");
			expect(result).toContain("Dry run — nothing written.");
			expect(result).toContain("~/.labunbun/settings.json");
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
			expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(CLAUDE_SETTINGS);
		});
	});
});
