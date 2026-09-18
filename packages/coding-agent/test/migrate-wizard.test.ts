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

/** The fake home, both in the environment and in the caller's hands. */
function withHome(tree: SourceTree, body: (home: string) => Promise<void> | void): Promise<void> | void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-wizard-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	const restore = (): void => {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		rmSync(home, { recursive: true, force: true });
	};
	process.env.USERPROFILE = home;
	process.env.HOME = home;
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

/** Run the wizard against a fake home, collecting what it pushed to the user. */
async function wizard(
	home: string,
	dialog: MigrationDialogBridge,
): Promise<{ result: string | undefined; reported: string[] }> {
	const reported: string[] = [];
	const result = await runMigrationWizard({ dialog, home, cwd: CWD, report: (text) => reported.push(text) });
	return { result, reported };
}

describe("migrate wizard: sources", () => {
	test("the first questions name the sources that were detected", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [["No", "No"]] });
			const { result } = await wizard(home, bridge);
			expect(result).toBe("No source selected — nothing to import.");
			expect(asked).toHaveLength(2);
			expect(asked.map((question) => question.question)).toEqual(["Import from Claude Code?", "Import from Codex?"]);
			// The question is answerable without knowing which tools exist, and it
			// is not a menu of raw ids.
			expect(asked[0].options.map((option) => option.label)).toEqual(["Yes", "No"]);
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});

	test("cancelling the source dialog stops before anything is read or written", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [null] });
			const { result, reported } = await wizard(home, bridge);
			expect(result).toBe("Migration cancelled — nothing was read or written.");
			expect(asked).toHaveLength(2); // the dialog was one call of two questions
			expect(reported).toEqual([]);
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});

	test("answering no to a source keeps that source out of the plan", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge } = scriptedDialog({ answers: [["Yes", "No"], ["Yes", "Yes", "No"], ["Apply"]] });
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
			const { bridge, asked } = scriptedDialog({ answers: [["Yes"], ["Yes", "No", "No"], ["Apply"]] });
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
			const { bridge } = scriptedDialog({ answers: [["Yes"], null] });
			const { result, reported } = await wizard(home, bridge);
			expect(result).toBe("Migration cancelled — nothing was read or written.");
			expect(reported).toEqual([]);
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});

	test("declining every category writes nothing", async () => {
		await withHome(historyTree(), async (home) => {
			const { bridge } = scriptedDialog({ answers: [["Yes"], ["No", "No", "No"]] });
			const { result } = await wizard(home, bridge);
			expect(result).toBe("No category selected — nothing to import.");
			expect(existsSync(join(home, ".labunbun"))).toBe(false);
		});
	});
});

describe("migrate wizard: history", () => {
	/** Source yes, settings yes, history yes, then the history answer itself. */
	function historyAnswers(scope: string): Array<string[] | null> {
		return [["Yes"], ["Yes", "No", "Yes"], [scope], ["Apply"]];
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
			// Three answers, not four: with nothing to list there is no history
			// question to answer.
			const { bridge, asked } = scriptedDialog({ answers: [["Yes"], ["Yes", "Yes", "Yes"], ["Apply"]] });
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

describe("migrate wizard: the plan is shown before it is written", () => {
	test("declining the preview leaves the home untouched", async () => {
		await withHome(twoSources(), async (home) => {
			const { bridge, asked } = scriptedDialog({ answers: [["Yes"], ["Yes", "Yes", "No"], ["Cancel"]] });
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
			const { bridge } = scriptedDialog({ answers: [["Yes"], ["Yes", "Yes", "No"], ["Apply"]] });
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
				const { bridge, asked } = scriptedDialog({ answers: [["Yes"], ["Yes", "No", "No"]] });
				const { result, reported } = await wizard(home, bridge);
				expect(asked.map((question) => question.header)).toEqual([
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
