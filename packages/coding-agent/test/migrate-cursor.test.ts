/**
 * The eleventh source: Cursor.
 *
 * Cursor is a VS Code fork with a CLI beside it, and the two halves keep
 * different things in different places — which is why this file has four groups
 * of assertions that read like four unrelated importers. Rules come from
 * `.cursor/rules`; permissions come from the **CLI's** file, not the IDE's
 * `permissions.json`; the CLI's prompt list comes from a per-workspace subtree
 * of the CLI's own home, three directories down; and the editor's own storage is
 * named and never opened.
 *
 * The claims behind that are documentation-level rather than source-level —
 * Cursor ships no public tree, and `cursor-home.ts` says so where it applies.
 * So the assertions below are about the **behaviour those claims produce**, and
 * each of them is written so that a path which turns out to be wrong fails
 * loudly rather than quietly reading nothing: the detection test plants a
 * profile directory that is the *only* evidence, and the state-database test
 * plants a file that could only be read by opening it.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CURSOR_DIR_BASENAME,
	cursorDetectionRoots,
	cursorPromptHistoryFile,
	cursorUserDataRoot,
	cursorUserRoot,
} from "../src/cursor-home.ts";
import { CURSOR_PLAIN_MARKDOWN_IGNORED, CURSOR_USER_RULES_NOT_LOADED, readCursor } from "../src/cursor-read.ts";
import {
	detectSources,
	type MigrationItem,
	type MigrationPlan,
	planMigration,
	readSources,
	runMigration,
} from "../src/migrate.ts";
import { readPromptHistory } from "../src/migrate-history.ts";
import { MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS } from "../src/migrate-types.ts";
import { parseFrontmatter } from "../src/skills.ts";
import { borrowSourceEnv } from "./source-env.ts";

/** Files a source tree should contain, keyed by path relative to the fake home. */
type SourceTree = Record<string, string>;

/**
 * Run `body` against a throwaway home seeded with `tree`, with the project
 * directory the same directory.
 *
 * `seed` runs after the files exist, for the fixtures a string cannot express —
 * a `state.vscdb` has to be a directory tree rather than a file's contents.
 */
function withHome(
	tree: SourceTree,
	body: (home: string) => void,
	seed?: (home: string) => void,
	env: Record<string, string | undefined> = {},
): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-cursor-"));
	const releaseSourceEnv = borrowSourceEnv();
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		for (const [path, content] of Object.entries(tree)) {
			const full = join(home, path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, content);
		}
		for (const [name, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		seed?.(home);
		body(home);
	} finally {
		releaseSourceEnv();
		rmSync(home, { recursive: true, force: true });
	}
}

/** The plan for one cursor tree, and nothing else. */
function plan(
	tree: SourceTree,
	seed?: (home: string) => void,
	env: Record<string, string | undefined> = {},
): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome(
		tree,
		(home) => {
			planned = planMigration(readSources(home, home), {}, { only: ["cursor"] });
		},
		seed,
		env,
	);
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/**
 * The plan for a tree whose project directory is `<home>/proj` rather than the
 * home itself.
 *
 * The reason this is not the default: `~/.cursor` and `<project>/.cursor` are the
 * same relative path under two roots, so a home that is also the project reads
 * every rule, config and MCP document **twice** — once per scope, with the
 * project copy first. Any assertion about scopes, about a name that collides
 * after flattening, or about which document won has to be run against a project
 * that is somewhere else.
 */
function planInProject(
	tree: SourceTree,
	seed?: (home: string) => void,
	env: Record<string, string | undefined> = {},
): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withHome(
		tree,
		(home) => {
			mkdirSync(join(home, "proj"), { recursive: true });
			planned = planMigration(readSources(home, join(home, "proj")), {}, { only: ["cursor"] });
		},
		seed,
		env,
	);
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The write queued for a path, addressed by its tail (`~/.labunbun/…`). */
function writeAt(planned: MigrationPlan, tail: string) {
	const normalized = tail.replace(/\\/g, "/").replace(/^~\//, "");
	return planned.writes.find((write) => write.path.replace(/\\/g, "/").endsWith(normalized));
}

/** The first item whose source label contains `needle`. */
function line(planned: MigrationPlan, needle: string): MigrationItem | undefined {
	return planned.items.find((item) => item.from.includes(needle));
}

/** Every item whose source label contains `needle`. */
function lines(planned: MigrationPlan, needle: string): MigrationItem[] {
	return planned.items.filter((item) => item.from.includes(needle));
}

/**
 * The first item whose **detail** contains `needle`.
 *
 * Separate from {@link line} because the two label a report's rows differently:
 * a grouped skip names the *directory* it looked in and counts the files, so the
 * sentence the user reads is in `detail` and the path a test would naturally
 * reach for is not there at all. Matching on the detail is also the more honest
 * of the two — it fails when the sentence stops saying what it says, rather than
 * when a label is reworded.
 */
function note(planned: MigrationPlan, needle: string): MigrationItem | undefined {
	return planned.items.find((item) => item.detail.includes(needle));
}

/** The settings document the plan would write, parsed. */
function settingsJson(planned: MigrationPlan): Record<string, unknown> {
	return JSON.parse(writeAt(planned, "~/.labunbun/settings.json")?.content ?? "{}") as Record<string, unknown>;
}

/** The permission list the plan would write, as an array of strings. */
function permissions(planned: MigrationPlan, behavior: "allow" | "deny"): string[] {
	return ((settingsJson(planned).permissions as Record<string, string[]> | undefined)?.[behavior] ?? []) as string[];
}

/** An `.mdc` rule with the frontmatter Cursor writes, as a document. */
function mdc(options: { description: string; globs?: string; alwaysApply?: string; body?: string }): string {
	return [
		"---",
		`description: ${options.description}`,
		...(options.globs === undefined ? [] : [`globs: ${options.globs}`]),
		...(options.alwaysApply === undefined ? [] : [`alwaysApply: ${options.alwaysApply}`]),
		"---",
		"",
		options.body ?? "Do the thing.",
		"",
	].join("\n");
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe("the eleventh source", () => {
	test("it is appended, so the ten before it keep their places", () => {
		// Append-only, and the order is what `detectSources` reports: reordering
		// would silently change which of two sources providing the same file wins.
		expect(MIGRATION_SOURCE_IDS.indexOf("cursor")).toBe(10);
		expect(MIGRATION_SOURCE_IDS.slice(0, 10)).toEqual([
			"claude-code",
			"codex",
			"zcode",
			"agents",
			"deepseek-harness",
			"grok-build",
			"kimi-code",
			"minimax-code",
			"step-code",
			"opencode",
		]);
		expect(MIGRATION_SOURCE_LABELS.cursor).toBe("Cursor");
	});

	test("the global file is cli-config.json and the project one is cli.json", () => {
		// Deliberately asymmetric, and a reader that guessed symmetrically would
		// read a project file that does not exist and miss the one that does. This
		// is the assertion that keeps the two spellings from being "tidied" into
		// each other by a later change.
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({ model: "sonnet" }),
			".cursor/cli.json": JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }),
		});
		expect(permissions(planned, "allow")).toEqual(["Bash(npm test)"]);
		expect(line(planned, "cli-config.json → model")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe("cursor rules", () => {
	test("the frontmatter is carried over byte for byte and the loss is named", () => {
		const content = mdc({ description: "React conventions", globs: "**/*.tsx", alwaysApply: "false" });
		const planned = plan({ ".cursor/rules/react.mdc": content });
		const write = writeAt(planned, "~/.labunbun/rules/react.md");
		// Byte for byte, not "the body survived": stripping the frontmatter would
		// be the same as deleting the user's own description of the rule.
		expect(write?.content).toBe(content);
		const item = line(planned, "react.mdc");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("with its frontmatter intact");
		expect(item?.detail).toContain('its globs ("**/*.tsx")');
		expect(item?.detail).toContain("alwaysApply: false");
	});

	test("alwaysApply: true is the one activation that survives, and it is scored as such", () => {
		const planned = plan({ ".cursor/rules/always.mdc": mdc({ description: "Always", alwaysApply: "true" }) });
		const item = line(planned, "always.mdc");
		expect(item?.action).toBe("map");
		expect(item?.detail).toContain("it applies always");
	});

	test("a rule with no frontmatter is imported, and the report says why it always loads", () => {
		const planned = plan({ ".cursor/rules/bare.mdc": "# bare\n" });
		const item = line(planned, "bare.mdc");
		expect(item?.action).toBe("downgrade");
		// The generic sentence is the accurate one here: no `alwaysApply` means
		// Cursor attached it by its description, and there is no description to read.
		expect(item?.detail).toContain("by its description when the model judges it relevant");
	});

	test("a nested rule is flattened, and a second one of the same name is named rather than overwritten", () => {
		const planned = planInProject({
			"proj/.cursor/rules/frontend/components.mdc": mdc({ description: "One", alwaysApply: "true" }),
			"proj/.cursor/rules/backend/components.mdc": mdc({ description: "Two", alwaysApply: "true" }),
		});
		// Flat, because the target's rules directory is flat: no recursion at all.
		// `backend` is the survivor because the walk sorts each level by name and
		// "the first" is defined as the first walked — asserted through the report
		// below so the choice is a stated rule rather than a path accident.
		expect(writeAt(planned, "~/.labunbun/rules/components.md")?.content).toContain("Two");
		// The collision is a fact the user is owed. Writing both and letting the
		// second win is a report that claims two imports and produced one file.
		const kept = lines(planned, "components.mdc");
		expect(kept).toHaveLength(2);
		const skipped = kept.find((item) => item.action === "skip");
		expect(skipped?.detail).toContain('already named "components"');
		expect(skipped?.detail).toContain("kept the first");
		expect(kept[0].from).toContain("backend");
		expect(skipped?.from).toContain("frontend");
	});

	test("a plain .md in a rules directory is named, because cursor ignores it", () => {
		const planned = plan({ ".cursor/rules/notes.md": "# notes\n" });
		expect(writeAt(planned, "~/.labunbun/rules/notes.md")).toBeUndefined();
		// The line is grouped by reason, so the file is named inside the detail
		// rather than being the item's own label — which is the right shape when
		// twenty files share one reason and one sentence.
		const skipped = line(planned, "<project>/.cursor/rules");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("notes.md");
		expect(skipped?.detail).toContain(CURSOR_PLAIN_MARKDOWN_IGNORED);
	});

	test("a rule under ~/.cursor/rules is imported, and says cursor never loaded it", () => {
		// Both directories are spelled `.cursor/rules`; they differ only in which
		// root they hang off. So the project has to be a *second* tree, or the same
		// file is read twice — once as the project's rule and once as the user's —
		// and the project copy, walked first, would answer every assertion here.
		let planned: MigrationPlan | undefined;
		withHome(
			{
				"proj/.cursor/rules/project.mdc": mdc({ description: "A", alwaysApply: "true" }),
				".cursor/rules/user.mdc": mdc({ description: "B", alwaysApply: "true" }),
			},
			(home) => {
				planned = planMigration(readSources(home, join(home, "proj")), {}, { only: ["cursor"] });
			},
		);
		const items: MigrationItem[] = planned?.items ?? [];
		expect(items.find((entry) => entry.from.includes("project.mdc"))?.detail).toContain("the project's rules");
		const user = items.find((entry) => entry.from.includes("user.mdc"));
		expect(user?.detail).toContain("your user rules");
		// The import still happens — the user wrote the file — but the report has
		// to say it was never live, or "imported" reads as "was working".
		expect(user?.detail).toContain(CURSOR_USER_RULES_NOT_LOADED);
		expect(writeAt(planned as MigrationPlan, "~/.labunbun/rules/user.md")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Permission rules
// ---------------------------------------------------------------------------

describe("cursor permissions", () => {
	test("Bash(git:*) becomes the anchored wildcard, and the rewrite is reported", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({ permissions: { allow: ["Bash(git:*)", "Read(**/.env)"] } }),
		});
		// `git:*` is cursor's way of writing "the command word and its arguments";
		// this build has one wildcard over the whole line, anchored.
		expect(permissions(planned, "allow")).toEqual(["Bash(git*)", "Read(**/.env)"]);
		const item = line(planned, "permissions.allow");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("git:*");
		expect(item?.detail).toContain("whole command line");
	});

	test("a specifier this build cannot evaluate is named, never widened into a bare allow", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({ permissions: { allow: ["WebFetch(docs.example.com)"] } }),
		});
		// `inputMatchesSpecifier` evaluates a specifier only for Bash, the four file
		// tools and `mcp__*`, and answers "no match" for everything else. Carrying
		// this as a bare `WebFetch` would turn "this one domain" into "this tool,
		// unconstrained" — the exact opposite of the file.
		expect(permissions(planned, "allow")).toEqual([]);
		const skipped = line(planned, "permissions.allow");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("WebFetch(docs.example.com)");
		expect(skipped?.detail).toContain("would cover the whole tool");
	});

	test("a bare tool name is carried, because its shape survives", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({ permissions: { allow: ["WebFetch", "mcp__docs(lookup)"] } }),
		});
		// The bare name matches by name alone, so it means the same thing here. The
		// one with a specifier is a specifier on a tool that evaluates it.
		expect(permissions(planned, "allow")).toEqual(["WebFetch", "mcp__docs(lookup)"]);
	});

	test("the IDE's permissions.json is named as the list the CLI never applied", () => {
		const planned = plan({ ".cursor/permissions.json": JSON.stringify({ allow: ["Bash(rm -rf)"] }) });
		expect(permissions(planned, "allow")).toEqual([]);
		const skipped = line(planned, "~/.cursor");
		expect(skipped?.detail).toContain("permissions.json");
		// The sentence has to say *which* list was not read, or a user who has spent
		// an afternoon in that file concludes the importer missed it.
		expect(skipped?.detail).toContain("the cursor CLI neither reads nor applies");
	});

	test("a project entry this importer has no mapping for is named in the project's half", () => {
		// The other of the two lists, and the one that would be missed if only the
		// user half were checked: a repository can carry a `.cursor/` file this
		// importer does not read, and the two halves are reported apart so the user
		// knows which tree to go looking in.
		const planned = planInProject({ "proj/.cursor/some-future-file.json": "{}" });
		const skipped = planned.items.find((item) => item.from === "<project>/.cursor");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("some-future-file.json");
		// And a home whose only Cursor file is that one is still a Cursor install.
		expect(planned.items).toHaveLength(1);
	});

	test("a user file this importer has no mapping for is named in the user's half", () => {
		// The mirror of the one above, and it exists because that one cannot fail for
		// the reason this one can. `permissions.json` and an unaccounted name both land
		// in the *project's* list when the home is also the project — and the project
		// list alone is enough to make the source `present` — so every fixture that
		// named a user-half sentence had the project half's flag holding it up. This
		// fixture has a `~/.cursor` and a project directory with no `.cursor` of its
		// own, which is the only shape in which the user half is load-bearing.
		const planned = planInProject({ ".cursor/some-future-file.json": "{}" });
		const skipped = planned.items.find((item) => item.from === "~/.cursor");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("some-future-file.json");
		expect(planned.items).toHaveLength(1);
	});

	test("a file the editor owns gets its own sentence rather than only its name", () => {
		// `permissions.json` and `extensions.json` are the two entries the report
		// attaches a reason to, and the reason is the whole treatment — a bare name
		// says "ignored", which reads as a bug in the importer rather than a decision
		// it made. They are also two different kinds of thing: one is a list that was
		// never in effect, the other is the editor's own installed set, and a user
		// reading one line should not have to work out which they are looking at.
		const planned = planInProject({ ".cursor/permissions.json": "{}", ".cursor/extensions.json": "{}" });
		const skipped = planned.items.find((item) => item.from === "~/.cursor");
		expect(skipped?.detail).toContain("permissions.json (the IDE's permission list");
		expect(skipped?.detail).toContain("extensions.json (installed editor extensions");
	});

	test("additionalDirectories is named as a session setting, not a rule", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({ permissions: { additionalDirectories: ["/tmp"] } }),
		});
		const skipped = line(planned, "additionalDirectories");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("session setting");
	});

	test("a permissions value that is not an object is named rather than read as nothing", () => {
		const planned = plan({ ".cursor/cli-config.json": JSON.stringify({ permissions: ["Bash(npm)"] }) });
		const skipped = line(planned, "→ permissions");
		expect(skipped?.detail).toContain("not an object");
	});

	test("the project's cli.json is read for permissions, and the two files are reported apart", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }),
			".cursor/cli.json": JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }),
		});
		// Union, not replacement: the second file adds to what the first claimed.
		expect(permissions(planned, "allow")).toEqual(["Bash(npm test)", "Bash(git status)"]);
		expect(line(planned, "~/.cursor/cli-config.json → permissions.allow")).toBeDefined();
		expect(line(planned, ".cursor/cli.json → permissions.allow")).toBeDefined();
	});

	test("sandbox is read as the second axis, and network is named as having no equivalent here", () => {
		// `sandbox` and `network` are no longer the same kind of thing, and the
		// test that used to lump them together was asserting a claim about
		// `network` the bundled CLI does not support. `sandbox.mode` *is* the
		// second axis of the pair `approvalMode` already decided, so it is read
		// and named as such; `network` is a different key entirely.
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({
				sandbox: { mode: "enabled", networkAccess: "user_config_with_defaults" },
				network: { useHttp1ForAgent: true },
			}),
		});

		const sandbox = line(planned, 'sandbox.mode ("enabled")');
		expect(sandbox?.action).toBe("skip");
		// The sentence has to say *which* half of the pair it agreed with, or a
		// user reading one line has no way to tell a deliberate merge from a
		// setting the importer forgot.
		expect(sandbox?.detail).toContain('approvalMode "allowlist" already maps to');

		const unconfined = line(
			plan({ ".cursor/cli-config.json": JSON.stringify({ sandbox: { mode: "disabled" } }) }),
			'sandbox.mode ("disabled")',
		);
		expect(unconfined?.action).toBe("skip");
		expect(unconfined?.detail).toContain('approvalMode "unrestricted" already maps to');

		const network = line(planned, "→ network");
		expect(network?.action).toBe("skip");
		// `network` is `{useHttp1ForAgent}` in the real CLI — a transport switch,
		// not an allowlist of reachable hosts — and the report says so rather
		// than sending the user after a permission list that was never there.
		expect(network?.detail).toContain("{useHttp1ForAgent}");
		expect(network?.detail).toContain("sandbox.networkAccess");
	});

	/**
	 * The other half of the sandbox block, named one key at a time.
	 *
	 * The fixture in the test above plants `networkAccess` next to `mode` and, at
	 * the time this was written, nothing in the report mentioned it: `sandbox` is
	 * a whole key in the handled list, so `reportUnhandledKeys` stayed quiet, and
	 * the reader only ever looked at `mode`. A user reading that report had no way
	 * to tell "the importer saw your network settings and decided they did not
	 * matter" from "the importer never looked".
	 *
	 * `networkAccess` is the pointed case because it *is* the setting that governs
	 * what cursor's process may reach — the sentence about the separate `network`
	 * key above says as much, which is what made the omission hard to spot.
	 */
	test("keys inside the sandbox block that were not read are named individually", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({
				sandbox: { mode: "enabled", networkAccess: "allow_all", networkAllowlist: ["example.com"] },
			}),
		});

		for (const key of ["networkAccess", "networkAllowlist"]) {
			const unread = line(planned, `→ sandbox.${key}`);
			expect(unread?.action).toBe("skip");
			expect(unread?.detail).toContain("is not read");
		}
	});

	/**
	 * The keys are enumerated from the object, not from a list of names cursor is
	 * known to use. A name written out in the importer would stop being checked
	 * the day cursor adds another one, which is the same rot the mode enums had.
	 */
	test("an unrecognised sandbox sub-key is still reported, without its value", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({
				sandbox: { mode: "enabled", somethingNew: "hunter2" },
			}),
		});
		const unread = line(planned, "→ sandbox.somethingNew");
		expect(unread?.action).toBe("skip");
		// The value is not echoed. A key nobody recognises is exactly the kind that
		// turns out to hold a token, and naming what was left behind is the whole
		// job — reproducing it would be the one way to make this line unsafe.
		expect(unread?.detail).not.toContain("hunter2");
	});

	/**
	 * And a `sandbox` that is not an object at all. The key is in the handled
	 * list, so nothing else in this file would say a word about it.
	 */
	test("a sandbox key that is not an object is reported rather than passing silently", () => {
		const planned = plan({ ".cursor/cli-config.json": JSON.stringify({ sandbox: true }) });
		const reported = line(planned, "→ sandbox");
		expect(reported?.action).toBe("skip");
		expect(reported?.detail).toContain("not an object");
	});
});

// ---------------------------------------------------------------------------
// The model and the approval mode
// ---------------------------------------------------------------------------

describe("cursor model and approval mode", () => {
	test("a model this build can resolve is claimed by its resolved name", () => {
		const planned = plan({ ".cursor/cli-config.json": JSON.stringify({ model: "sonnet" }) });
		expect(settingsJson(planned).model).toBe("anthropic/claude-sonnet-5");
		expect(line(planned, 'model ("sonnet")')?.detail).toContain("resolved to");
	});

	test("a model name this build does not know is a skip, not a guess", () => {
		const planned = plan({ ".cursor/cli-config.json": JSON.stringify({ model: "cursor-small" }) });
		expect(settingsJson(planned).model).toBeUndefined();
		const skipped = line(planned, 'model ("cursor-small")');
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("no model in the registry matches");
	});

	test("each approval mode is read as the pair it stands for, and the near-miss says why", () => {
		// The three values the bundled CLI declares for `approvalMode`, and both
		// halves of what each becomes. `cursor-approval-modes.test.ts` checks
		// that this is the *whole* declared list against the bundle itself; this
		// is the behavioural half, over the plan rather than the table.
		for (const [value, mode, sandbox] of [
			["allowlist", "ask", "workspace-write"],
			["auto-review", "ask", "workspace-write"],
			["unrestricted", "agent", "danger-full-access"],
		] as const) {
			const planned = plan({ ".cursor/cli-config.json": JSON.stringify({ approvalMode: value }) });
			const settings = settingsJson(planned);
			expect(settings.permissionMode).toBe(mode);
			// The second axis too: cursor's mode is one value doing both jobs and
			// this build splits them, so `unrestricted` has to arrive unconfined
			// and not merely un-asked.
			expect(settings.sandbox).toBe(sandbox);
		}
		// `auto-review` is the one that is genuinely narrower than cursor's
		// promise, so the report has to say so rather than presenting three exact
		// translations.
		const auto = plan({ ".cursor/cli-config.json": JSON.stringify({ approvalMode: "auto-review" }) });
		expect(line(auto, 'approvalMode ("auto-review")')?.detail).toContain("narrower than what the config asked for");
	});

	test("an approval mode with no counterpart is a skip, and does not leave a stale mode", () => {
		const planned = plan({ ".cursor/cli-config.json": JSON.stringify({ approvalMode: "yolo-ish" }) });
		expect(settingsJson(planned).permissionMode).toBeUndefined();
		const skipped = line(planned, 'approvalMode ("yolo-ish")');
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("no permission mode here corresponds");
	});
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

describe("cursor hooks", () => {
	/** A hooks file in the flat shape cursor writes. */
	function hooksFile(entries: Record<string, unknown>, version: unknown = 1): string {
		return JSON.stringify({ version, hooks: entries });
	}

	test("a flat hook entry becomes the shape this build reads, and seconds are named", () => {
		const planned = plan({
			".cursor/hooks.json": hooksFile({ SessionStart: [{ command: "echo hi", timeout: 30 }] }),
		});
		const written = JSON.parse(writeAt(planned, "~/.labunbun/settings.json")?.content ?? "{}") as {
			hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>;
		};
		const handler = written.hooks?.SessionStart?.[0]?.hooks?.[0];
		expect(handler?.type).toBe("command");
		expect(handler?.command).toBe("echo hi");
		// Cursor writes seconds and this build reads milliseconds. Putting the bare
		// number in would make a thirty-second hook fire after thirty milliseconds.
		expect(handler?.timeout).toBe(30_000);
		const item = line(planned, "hooks");
		expect(item?.detail).toContain("converted from the seconds cursor writes");
	});

	test("an event with no counterpart here is counted, not silently kept", () => {
		const planned = plan({
			".cursor/hooks.json": hooksFile({ SessionStart: [{ command: "echo hi" }], SomeCursorEvent: [{ command: "x" }] }),
		});
		const item = line(planned, "hooks");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("cursor event(s) with no event here");
		expect(item?.detail).toContain("SomeCursorEvent");
	});

	test("an entry with no command is counted rather than dropped in silence", () => {
		const planned = plan({
			".cursor/hooks.json": hooksFile({ SessionStart: [{ command: "echo hi" }, { type: "prompt" }] }),
		});
		const item = line(planned, "hooks");
		// Counted at the point it is dropped, which is inside cursor's own flat
		// shape and therefore *before* the shared normalizer ever sees it — so the
		// count comes from the adapter and not from `normalizeClaudeHooks`, and the
		// two sentences stay distinguishable.
		expect(item?.detail).toContain("1 entr(ies) with no command in them");
		expect(item?.detail).toContain("1 hook(s) over 1 event(s)");
	});

	test("a hooks file for a schema version this importer cannot interpret is not half-applied", () => {
		const planned = plan({ ".cursor/hooks.json": hooksFile({ SessionStart: [{ command: "echo hi" }] }, 2) });
		const settings = writeAt(planned, "~/.labunbun/settings.json");
		// "Nothing from this file was applied" has to be true, so the assertion is
		// that no hook reached the settings at all rather than that a line was printed.
		expect(settings === undefined || !settings.content.includes("echo hi")).toBe(true);
		const skipped = line(planned, "→ version");
		expect(skipped?.action).toBe("skip");
		expect(skipped?.detail).toContain("schema version this importer cannot interpret");
	});

	test("a hooks key that is not a table is named, with no hooks applied", () => {
		const planned = plan({ ".cursor/hooks.json": JSON.stringify({ version: 1, hooks: ["echo hi"] }) });
		const skipped = line(planned, "→ hooks");
		expect(skipped?.detail).toContain("could not read");
	});

	test("an empty hooks block is named as nothing rather than as a hook file", () => {
		const planned = plan({ ".cursor/hooks.json": hooksFile({}) });
		const skipped = line(planned, "→ hooks");
		expect(skipped?.detail).toContain("it is nothing");
	});
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

describe("cursor mcp", () => {
	test("the global document is written, and its servers are copied verbatim", () => {
		const planned = plan({
			".cursor/mcp.json": JSON.stringify({
				mcpServers: { docs: { type: "http", url: "https://mcp.example/docs" } },
			}),
		});
		const written = JSON.parse(writeAt(planned, "~/.labunbun/.mcp.json")?.content ?? "{}") as {
			mcpServers: Record<string, unknown>;
		};
		expect(written.mcpServers.docs).toEqual({ type: "http", url: "https://mcp.example/docs" });
		expect(line(planned, "mcpServers.docs")?.action).toBe("map");
	});

	test("a project document is named rather than merged into the global file", () => {
		// The project directory is a second tree, so the two documents are genuinely
		// different files rather than one shadowing the other.
		let planned: MigrationPlan | undefined;
		withHome(
			{
				".cursor/mcp.json": JSON.stringify({ mcpServers: { global: { type: "http", url: "https://mcp.example/g" } } }),
				"proj/.cursor/mcp.json": JSON.stringify({
					mcpServers: { local: { type: "stdio", command: "node", args: ["s.js"] } },
				}),
			},
			(home) => {
				planned = planMigration(readSources(home, join(home, "proj")), {}, { only: ["cursor"] });
			},
		);
		// The repository's own file is not something an import should rewrite, so the
		// report gives the two paths that would carry these instead.
		const skipped = planned?.items.find((item) => item.action === "skip" && item.detail.includes("project-scope"));
		expect(skipped?.detail).toContain("<cwd>/.mcp.json");
		expect(skipped?.detail).toContain("~/.labunbun/.mcp.json");
		// And only the global one was written.
		const written = writeAt(planned as MigrationPlan, "~/.labunbun/.mcp.json")?.content ?? "";
		expect(written).toContain("global");
		expect(written).not.toContain("local");
	});
	test("an environment reference in the colon spelling is named, not passed through as text", () => {
		const planned = plan({
			".cursor/mcp.json": JSON.stringify({
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture writes VSCode's own spelling into the file
				mcpServers: { files: { type: "stdio", command: "node", env: { ROOT: "${env:PROJECT_ROOT}" } } },
			}),
		});
		const item = line(planned, "mcpServers.files");
		expect(item?.action).toBe("downgrade");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the assertion is that this text survives unexpanded
		expect(item?.detail).toContain("${env:PROJECT_ROOT}");
		expect(item?.detail).toContain("is not expanded here");
	});

	test("a document that is not JSON, and one whose mcpServers is not a table, are named apart", () => {
		// Both fixtures make the home's *only* Cursor file a broken one, so these
		// double as the assertion that a source with nothing importable is still
		// reported rather than called absent — otherwise the report would say
		// "nothing migratable in it" and print neither of these sentences.
		const unreadable = plan({ ".cursor/mcp.json": "{ not json" });
		expect(line(unreadable, ".cursor/mcp.json")?.detail).toContain("not a JSON object");
		const malformed = plan({ ".cursor/mcp.json": JSON.stringify({ mcpServers: ["node"] }) });
		expect(line(malformed, "mcpServers")?.detail).toContain("not a table of servers");
	});

	test("a URL that carries a credential is not carried across, and a clean one still is", () => {
		// The record is copied verbatim here, `url` included, and a URL is the one
		// credential channel a name-based scan cannot reach: the token is inside the
		// one string every importer treats as a safe identifier. `headers` and `env`
		// can be dropped whole and leave a working server; a URL cannot — the same
		// address with its userinfo or its `?access_token=` stripped points at nothing
		// — so it is left off rather than written under a line saying nothing in it is
		// a secret.
		const userinfoPassword = "sk-url-pass-VALUE";
		const queryToken = "sk-url-token-VALUE";
		const planned = plan({
			".cursor/mcp.json": JSON.stringify({
				mcpServers: {
					withUserinfo: { type: "http", url: `https://alice:${userinfoPassword}@mcp.example/sse` },
					withQuery: { type: "http", url: `https://mcp.example/mcp?access_token=${queryToken}` },
					clean: { type: "http", url: "https://mcp.example/mcp" },
				},
			}),
		});
		expect(JSON.stringify(planned)).not.toContain(userinfoPassword);
		expect(JSON.stringify(planned)).not.toContain(queryToken);

		// Per-entry, not a gate on the whole file: one credential must not cost the
		// user the servers beside it.
		const written = JSON.parse(writeAt(planned, "~/.labunbun/.mcp.json")?.content ?? "{}") as {
			mcpServers: Record<string, unknown>;
		};
		expect(written.mcpServers.clean).toEqual({ type: "http", url: "https://mcp.example/mcp" });
		expect(written.mcpServers.withUserinfo).toBeUndefined();
		expect(written.mcpServers.withQuery).toBeUndefined();

		for (const name of ["withUserinfo", "withQuery"]) {
			const skipped = line(planned, `mcpServers.${name}`);
			expect(skipped?.action).toBe("skip");
			// Nothing was written for these, and no file is marked for it — but the
			// value this line is about *was* a credential, and a reader filtering items
			// for one should not have to read the detail to find that out.
			expect(skipped?.containsSecret).toBe(true);
		}
		// The reason names the shape, and prints neither the value nor the address.
		expect(line(planned, "mcpServers.withUserinfo")?.detail).toContain("name:password@");
		expect(line(planned, "mcpServers.withQuery")?.detail).toContain("parameter names is a credential word");
	});
});

// ---------------------------------------------------------------------------
// The editor's storage
// ---------------------------------------------------------------------------

describe("cursor's editor storage", () => {
	test("the state databases are named and never opened", () => {
		// The sentinel is the whole assertion. `state.vscdb` is where the chat
		// bodies are, so a reader that opened one would either fail on this
		// non-database or — worse, with a driver that creates what it opens — write
		// into a directory it promised to leave alone. Both outcomes are checked:
		// the value turns up nowhere in the plan, and the bytes are unchanged
		// afterwards, because "nowhere in the report" alone would not notice a
		// file that had been rewritten with the same length.
		const sentinel = "cursor-state-sentinel-not-a-database";
		let located: MigrationItem | undefined;
		let bytesAfter: string[] = [];
		let report = "";
		let plannedText = "";
		withHome({ ".cursor/cli-config.json": "{}" }, (home) => {
			// `%APPDATA%` is what the reader consults on Windows, so the fixture
			// has to answer it; the borrow above guarantees the machine's own
			// profile is not the one under test.
			process.env.APPDATA = join(home, "appdata");
			const base = cursorUserDataRoot(home).root;
			for (const dir of [join(base, "workspaceStorage", "abc123"), join(base, "globalStorage")]) {
				mkdirSync(dir, { recursive: true });
				writeFileSync(join(dir, "state.vscdb"), sentinel);
			}
			const database = join(base, "workspaceStorage", "abc123", "state.vscdb");
			const before = statSync(database).size;
			const result = runMigration({ home, cwd: home, from: "cursor" });
			located = result.plan.items.find((item) => item.from.includes("editor storage"));
			plannedText = JSON.stringify(result.plan);
			report = result.report;
			bytesAfter = [readFileSync(database, "utf8"), readFileSync(join(base, "globalStorage", "state.vscdb"), "utf8")];
			expect(statSync(database).size).toBe(before);
		});
		expect(located?.action).toBe("skip");
		expect(located?.detail).toContain("2 state database(s) (1 workspace, 1 global)");
		expect(located?.detail).toContain("opened by name only, never read");
		// The workspace key cannot be recomputed, and the report must not imply it can.
		expect(located?.detail).toContain("cannot be recomputed from the path");
		expect(plannedText).not.toContain(sentinel);
		expect(report).not.toContain(sentinel);
		expect(bytesAfter).toEqual([sentinel, sentinel]);
	});

	test("a database whose name is a directory entry of either shape is still named", () => {
		// Older VS Code workspaces are a 32-character hex digest and newer ones are
		// a numeric timestamp, and both are observed in one directory. A reader that
		// pattern-matched one shape would skip half a real install.
		let located: MigrationItem | undefined;
		withHome({}, (home) => {
			process.env.APPDATA = join(home, "appdata");
			const base = cursorUserDataRoot(home).root;
			for (const id of ["0123456789abcdef0123456789abcdef", "1758901200000"]) {
				mkdirSync(join(base, "workspaceStorage", id), { recursive: true });
				writeFileSync(join(base, "workspaceStorage", id, "state.vscdb"), "x");
			}
			const raw = readSources(home, home);
			located = planMigration(raw, {}, { only: ["cursor"] }).items.find((item) => item.from.includes("editor storage"));
		});
		expect(located?.detail).toContain("2 state database(s) (2 workspace, 0 global)");
	});
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe("cursor detection", () => {
	test("a profile directory with no ~/.cursor at all is still a cursor install", () => {
		// The failure this prevents: a user who has used the IDE and never run the
		// CLI has no `~/.cursor`, its files being created by the command. Detection
		// that looked only at the home would call Cursor absent on exactly the
		// machine where a Cursor install most obviously exists — and then the
		// import would find the workspace databases anyway.
		//
		// `sourceHasContent` counts an empty directory as absent, which is right
		// for `~/.agents` and wrong here: the profile is created on first launch
		// and fills in over time, so an empty one would make a Cursor install
		// undetectable on a machine where it was just installed. What is planted is
		// therefore a real entry, not just the directory.
		let detected: string[] = [];
		withHome({}, (home) => {
			process.env.APPDATA = join(home, "appdata");
			mkdirSync(join(cursorUserDataRoot(home).root, "globalStorage"), { recursive: true });
			writeFileSync(join(cursorUserDataRoot(home).root, "globalStorage", "storage.json"), "{}");
			detected = detectSources(home);
		});
		expect(detected).toEqual(["cursor"]);
	});

	test("a rules file in the project half is a cursor install with no home at all", () => {
		let detected: string[] = [];
		withHome({ ".cursor/rules/r.mdc": mdc({ description: "A", alwaysApply: "true" }) }, (home) => {
			detected = detectSources(home);
		});
		expect(detected).toEqual(["cursor"]);
	});

	test("the detection roots are the CLI home and the editor profile", () => {
		withHome({}, (home) => {
			const roots = cursorDetectionRoots(home).map((path) => path.replace(/\\/g, "/"));
			expect(roots[0]).toBe(`${home.replace(/\\/g, "/")}/${CURSOR_DIR_BASENAME}`);
			// The second is the profile directory itself, so a machine that has only
			// opened the editor is not reported as having no cursor.
			expect(roots[1]).toBe(cursorUserDataRoot(home).root.replace(/\\/g, "/"));
		});
	});

	test("a home with nothing of cursor's in it is not a cursor install", () => {
		withHome({}, (home) => {
			expect(detectSources(home)).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// The CLI's home, which two environment variables can move
// ---------------------------------------------------------------------------

/**
 * `~/.cursor` is the **default**, not the location.
 *
 * The shipped bundle resolves the CLI's home in three steps
 * (`cursor-config/dist/paths.js`, `WI()`) and the importer used to hard-code the
 * last one, so on a Linux desktop that exports `XDG_CONFIG_HOME` the config
 * genuinely lives at `$XDG_CONFIG_HOME/cursor`, `~/.cursor` does not exist, every
 * read came back empty, and the report said **nothing at all** — not a file, not
 * a directory, and not "not installed" either, because the importer called the
 * source absent while the evidence sat one directory over.
 *
 * The variables are borrowed by `withHome`, which is what makes these assertions
 * about the rule rather than about the box: a developer who has set either one
 * gets the same answer here as a developer who has set neither.
 */
describe("cursor's config root", () => {
	test("CURSOR_CONFIG_DIR moves the CLI home, and the home is not under the user's", () => {
		// The override is returned **verbatim** — the source trims to test the value
		// and returns the original — so the path is asserted with the stray spaces
		// still in it. A reader that tidied this would be diverging from the thing
		// it is mirroring, and on a value with a trailing space the two point
		// somewhere different on Windows.
		let located: string | undefined;
		let expected = "";
		withHome({ "elsewhere/cli-config.json": "{}" }, (home) => {
			process.env.CURSOR_CONFIG_DIR = `  ${join(home, "elsewhere")}  `;
			located = cursorUserRoot(home);
			expected = `  ${join(home, "elsewhere")}  `;
		});
		expect(located).toBe(expected);
	});

	test("a relocated CLI home is where the config is read from, and the default is not", () => {
		// The consequence, not the path. The file is planted **only** at the
		// relocated root, so a reader that still looked under `~/.cursor` would find
		// an empty directory and report a cursor install with nothing in it — the
		// failure this whole group exists to prevent, and one no path assertion
		// would catch on its own.
		let keys: string[] = [];
		withHome({ "elsewhere/cli-config.json": JSON.stringify({ vimMode: { enable: true } }) }, (home) => {
			process.env.CURSOR_CONFIG_DIR = join(home, "elsewhere");
			const document = readCursor(home, home).cli.global;
			keys = document.kind === "document" ? Object.keys(document.value) : [];
		});
		expect(keys).toEqual(["vimMode"]);
	});

	test("XDG_CONFIG_HOME/cursor is the middle rule, and it beats the default", () => {
		// Both spellings are planted and the variable picks between them, so this
		// is a precedence assertion rather than a fallback one: with `~/.cursor`
		// present *and* the variable set, the variable is the answer.
		let located: string | undefined;
		let expected = "";
		withHome({ ".cursor/cli-config.json": "{}" }, (home) => {
			process.env.XDG_CONFIG_HOME = join(home, "xdg");
			located = cursorUserRoot(home);
			expected = join(home, "xdg", "cursor");
		});
		expect(located).toBe(expected);
	});

	test("whitespace-only is not a value, in either variable", () => {
		// The test the source makes is `value?.trim()` being truthy. `join(" ", …)`
		// would resolve to a path relative to the process's working directory, so a
		// reader that took a blank value at face value would read — and this
		// importer would report — somewhere arbitrary. The XDG half of the
		// assertion is also the regression: pre-fix the root ignored both variables.
		withHome({}, (home) => {
			process.env.CURSOR_CONFIG_DIR = "   ";
			expect(cursorUserRoot(home)).toBe(join(home, CURSOR_DIR_BASENAME));
			delete process.env.CURSOR_CONFIG_DIR;
			process.env.XDG_CONFIG_HOME = "\t";
			expect(cursorUserRoot(home)).toBe(join(home, CURSOR_DIR_BASENAME));
		});
	});

	test("with neither variable set the root is the documented one", () => {
		withHome({}, (home) => {
			expect(cursorUserRoot(home)).toBe(join(home, CURSOR_DIR_BASENAME));
		});
	});

	test("a user who moved the root is detected through the moved one", () => {
		// `detectSources` reads `cursorDetectionRoots`, so a relocated root that
		// detection did not follow would leave the CLI's config invisible to the
		// one function that decides whether to offer the source at all.
		let detected: string[] = [];
		withHome({ "elsewhere/cli-config.json": "{}" }, (home) => {
			process.env.CURSOR_CONFIG_DIR = join(home, "elsewhere");
			detected = detectSources(home);
		});
		expect(detected).toEqual(["cursor"]);
	});
});

// ---------------------------------------------------------------------------
// The prompt list
// ---------------------------------------------------------------------------

describe("cursor prompt history", () => {
	/** A prompt list in the flat array shape the CLI writes, newest last. */
	function promptList(...prompts: string[]): string {
		return JSON.stringify(prompts);
	}

	test("the list is read from the workspace subtree of the CLI home", () => {
		withHome({}, (home) => {
			// The path is asserted through the reader rather than through the report,
			// because a report line that named a directory the reader never opened
			// would be the exact defect this module's header warns about.
			const planted = withPromptList(home, promptList("a prompt"));
			expect(cursorPromptHistoryFile(home, home)?.path).toBe(planted);
			expect(readCursor(home, home).promptHistory?.path).toBe(planted);
		});
	});

	test("a prompt_history.json under ~/.config is not this file and is not read", () => {
		// The two spellings this importer used to choose between are both under
		// `~/.config/cursor/`, and the source writes to **neither** — not in the
		// shipped bundle's `WI()`, which resolves the config root to
		// `CURSOR_CONFIG_DIR` / `$XDG_CONFIG_HOME/cursor` / `~/.cursor`, and not in
		// the workspace subtree the file is actually in. So the file had never been
		// found on any machine, and a `prompt_history.json` that *is* sitting in
		// `~/.config/cursor` belongs to something other than this CLI.
		withHome({ ".config/cursor/prompt_history.json": promptList("not cursor's") }, (home) => {
			expect(cursorPromptHistoryFile(home, home)).toBeNull();
			expect(readPromptHistory("cursor", home, { cwd: home, scope: "all", limit: 10 }).absent).toContain(join("chats"));
		});
	});

	test("the digest is the md5 of the resolved working directory, pinned as a literal", () => {
		// A literal, not a re-derivation: the file is planted at a digest this test
		// states outright, so an implementation that hashed the home, the raw
		// argument or a trimmed path would not find it at all. The value differs per
		// platform **because** the digest is of the *resolved* path — that is the
		// property under test, not an inconvenience: `resolve` of a native absolute
		// path is that path, and the two natives are spelled differently.
		const cwd = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
		const digest =
			process.platform === "win32" ? "b7b763bda2734ee95fbb91f3e92dbf5b" : "343f7bd911faa66cb512d68f95a5f2f9";
		let found: string | undefined;
		let expected = "";
		withHome({}, (home) => {
			expected = join(home, CURSOR_DIR_BASENAME, "chats", digest, "view", "prompt_history.json");
			withPromptList(home, promptList("a prompt"), cwd);
			found = cursorPromptHistoryFile(home, cwd)?.path;
		});
		expect(found).toBe(expected);
	});

	test("the path has the shape the source builds, in that order", () => {
		withHome({}, (home) => {
			withPromptList(home, promptList("a prompt"));
			const path = cursorPromptHistoryFile(home, home)?.path ?? "";
			expect(path.replace(/\\/g, "/")).toMatch(/\/\.cursor\/chats\/[0-9a-f]{32}\/view\/prompt_history\.json$/);
		});
	});

	test("CURSOR_CONFIG_DIR moves the list too, because both hang off the same root", () => {
		// The failure this prevents is the silent one: a user who exported
		// `CURSOR_CONFIG_DIR` keeps their whole CLI state there, so a list at the
		// default root is not a fallback, it is a different install's file.
		withHome({}, (home) => {
			const root = join(home, "elsewhere");
			process.env.CURSOR_CONFIG_DIR = root;
			const planted = withPromptList(home, promptList("from the override"), home, root);
			const located = cursorPromptHistoryFile(home, home);
			expect(located?.origin).toBe("cursor-config-dir");
			expect(located?.path).toBe(planted);
		});
	});

	test("XDG_CONFIG_HOME moves the list, and the rule that answered is named", () => {
		withHome({}, (home) => {
			const root = join(home, "xdg", "cursor");
			process.env.XDG_CONFIG_HOME = join(home, "xdg");
			// The default root holds a *different* list, so "which one answered" is
			// a question with two possible answers and this asserts the right one.
			withPromptList(home, promptList("from the default"));
			const planted = withPromptList(home, promptList("from xdg"), home, root);
			const located = cursorPromptHistoryFile(home, home);
			expect(located?.origin).toBe("xdg-config-home");
			expect(located?.path).toBe(planted);
			expect(
				readPromptHistory("cursor", home, { cwd: home, scope: "all", limit: 10 }).entries.map((e) => e.text),
			).toEqual(["from xdg"]);
		});
	});

	test("a user whose only cursor file is the list is still a cursor install", () => {
		// Why getting this path wrong cost more than one file. The list is one of
		// the four pillars of the source's `present` flag, so a user who has typed
		// prompts and written no rule, no config and no server file has this file
		// and nothing else — and a reader that missed it reported the whole source
		// as absent, taking every other thing Cursor had with it.
		let report = "";
		withHome({}, (home) => {
			withPromptList(home, promptList("the only evidence"));
			report = runMigration({ home, cwd: home, from: "cursor" }).report;
		});
		expect(report).toContain("1 prompt(s) added to the recall history");
	});

	test("a run offers the prompts and says which directory they are filed under", () => {
		let report = "";
		withHome({}, (home) => {
			withPromptList(home, promptList("first prompt", "second prompt"));
			report = runMigration({ home, cwd: home, from: "cursor" }).report;
		});
		expect(report).toContain("2 prompt(s) added to the recall history");
		// The list records no directory, so the entries are filed under one place
		// and the report has to say so: "↑ offers them in the directory each was
		// typed in" would be false here, and that is a sentence about behaviour.
		expect(report).toContain("the source records no directory for any of them");
		// The prompt text itself is not echoed. Every other source's report prints
		// file names, keys and counts, and a history line is the one place the text
		// is the user's own prose and may be a pasted secret; the count plus the
		// path is what the report has to offer.
		expect(report).not.toContain("first prompt");
	});

	test("--history-scope cwd cannot narrow this source, and says so", () => {
		withHome({}, (home) => {
			withPromptList(home, promptList("a prompt"));
			const scoped = readPromptHistory("cursor", home, { cwd: home, scope: "cwd", limit: 10 });
			// The entry is still offered, and the reason it cannot be narrowed is
			// stated rather than the option being honoured by accident.
			expect(scoped.entries).toHaveLength(1);
			expect(scoped.entries[0].cwd).toBe(home);
			expect(scoped.cwdSubstitute).toBe(home);
			expect(JSON.stringify(scoped.notes)).toContain("--history-scope cwd cannot narrow this source");
		});
	});

	test("a slash command is not offered as a prompt, and is counted", () => {
		const input = readWith(promptList("/compact", "a real prompt"));
		expect(input.entries.map((entry) => entry.text)).toEqual(["a real prompt"]);
	});

	test("a non-string entry, an empty one, and a pasted block are each counted", () => {
		const input = readWith(JSON.stringify(["kept", "", "   ", "[Pasted text #1 +12 lines]", 7]));
		expect(input.entries.map((entry) => entry.text)).toEqual(["kept"]);
		// `seen` is what the list *had*, before any filter: the two entries that are
		// still strings count, and the number 7 does not. Reading it as "one prompt
		// was offered" would under-report by a third, which is the one number a
		// person uses to decide whether the import lost something.
		expect(input.seen).toBe(2);
		// Each filter is a line in the report with its own count, in the order the
		// list is walked — newest first, since the CLI prepends.
		const reasons = input.notes.map((note) => [note.reason, note.count]);
		expect(reasons).toEqual([
			["entry that is not a string, so not a prompt", 1],
			["prompt whose text was a pasted block, stored without its body", 1],
			["empty prompt", 2],
		]);
	});

	test("a list longer than the limit keeps the newest, and says how many it left", () => {
		// The one thing a *flat* list has to get right that a transcript does not: a
		// `.jsonl` carries a timestamp per line and `selectPrompts` orders by it,
		// while this list carries none, so its order is the whole of its recency
		// information. Dropping the `reverse()` before the push would keep the
		// *oldest* `limit` and report "truncated" as if it were the newest — a
		// recall list that has quietly forgotten everything you asked today.
		const prompts = Array.from({ length: 12 }, (_, index) => `prompt ${index}`);
		const input = readWith(promptList(...prompts), 5);
		expect(input.entries.map((entry) => entry.text)).toEqual([
			"prompt 11",
			"prompt 10",
			"prompt 9",
			"prompt 8",
			"prompt 7",
		]);
		expect(input.overLimit).toBe(7);
		expect(input.seen).toBe(12);
	});

	test("a list that is not an array is named, and a list that is not JSON is named differently", () => {
		expect(readWith(JSON.stringify({ a: 1 })).entries).toEqual([]);
		expect(readWith("not json").entries).toEqual([]);
	});

	test("with no list the report names the exact path that was looked for", () => {
		// "There is no list" and "we looked somewhere else" used to print the same
		// sentence, and the old one named two paths that were both wrong. The
		// sentence has to name the path, so the user can go and check it.
		const input = readWith(undefined);
		expect(input.entries).toEqual([]);
		// `tildePath` rewrites the separator while it abbreviates, so the shape is
		// matched rather than joined — the sentence has to name the directory that
		// was searched, whichever platform printed it.
		expect(input.absent).toMatch(/chats[\\/][0-9a-f]{32}[\\/]view[\\/]prompt_history\.json/);
		expect(input.absent).toContain("a list is looked for and there is none");
	});

	test("a prompt that is a credential-looking string is still a prompt, and the report does not print it", () => {
		// The one place this source reads user prose, and the reason the report
		// carries counts rather than text: a pasted key lands in a recall list like
		// any other line, and a report that echoed the list would print it.
		const secret = "sk-ant-CURSOR-PROMPT-SENTINEL";
		let report = "";
		let written = "";
		withHome({}, (home) => {
			withPromptList(home, promptList(secret));
			const result = runMigration({ home, cwd: home, from: "cursor" });
			report = result.report;
			written = result.plan.writes.find((write) => write.path.endsWith("history.jsonl"))?.content ?? "";
		});
		expect(written).toContain(secret);
		expect(report).not.toContain(secret);
	});
});

// ---------------------------------------------------------------------------
// The credential boundary
// ---------------------------------------------------------------------------

describe("cursor: the credential boundary", () => {
	test("a value planted in every place a credential can be never reaches the report", () => {
		// Four places, and they are four different mechanisms, so four assertions
		// rather than one: an MCP server's `headers` and `env` are *copied* (an MCP
		// config is a credential document by nature, and the importer says so
		// instead of pretending otherwise), an unhandled config key is *named* by
		// key, a credential-named file at the user root is *listed by name only*, and
		// the editor's database is `existsSync` and nothing else.
		//
		// The values below are fake. The assertion is on the rendered report, because
		// the plan is the structure and the report is what a person reads.
		const headerToken = "cursor-HDR-SENTINEL";
		const envToken = "cursor-ENV-SENTINEL";
		const keyValue = "cursor-KEY-SENTINEL";
		const fileValue = "cursor-FILE-SENTINEL";
		const dbValue = "cursor-DB-SENTINEL";
		let report = "";
		let items: MigrationItem[] = [];
		withHome(
			{
				".cursor/mcp.json": JSON.stringify({
					mcpServers: {
						vault: {
							type: "http",
							url: "https://mcp.invalid/v",
							headers: { Authorization: headerToken },
							env: { VAULT_TOKEN: envToken },
						},
					},
				}),
				".cursor/cli-config.json": JSON.stringify({ apiKey: keyValue, permissions: { allow: [] } }),
				".cursor/auth.json": JSON.stringify({ refresh: fileValue }),
			},
			(home) => {
				process.env.APPDATA = join(home, "appdata");
				mkdirSync(join(cursorUserDataRoot(home).root, "globalStorage"), { recursive: true });
				writeFileSync(join(cursorUserDataRoot(home).root, "globalStorage", "state.vscdb"), dbValue);
				const result = runMigration({ home, cwd: home, from: "cursor" });
				report = result.report;
				items = result.plan.items;
			},
		);
		for (const value of [headerToken, envToken, keyValue, fileValue, dbValue]) {
			expect(report).not.toContain(value);
		}
		// The names still come out, or the boundary would be a silent one.
		expect(report).toContain("auth.json");
		expect(report).toContain("apiKey");
		// The copied server is marked as carrying a credential, which is what makes
		// the report warn about the file it is about to write.
		expect(items.find((item) => item.from.includes("mcpServers.vault"))?.containsSecret).toBe(true);
		expect(report).toContain("including credential headers");
	});

	test("the file the mcp server's secrets were copied into holds them, and the report names that file", () => {
		// The other half of the sentence above, and the reason the values may be
		// copied at all: the target is an MCP server file, which is where an MCP
		// server's credentials belong. Writing them anywhere else — or not naming
		// the file — would be the actual defect.
		const token = "cursor-COPY-SENTINEL";
		let report = "";
		let content = "";
		withHome(
			{
				".cursor/mcp.json": JSON.stringify({
					mcpServers: { vault: { type: "http", url: "https://mcp.invalid/v", headers: { Authorization: token } } },
				}),
			},
			(home) => {
				const result = runMigration({ home, cwd: home, from: "cursor" });
				report = result.report;
				content = result.plan.writes.find((write) => write.path.endsWith(".mcp.json"))?.content ?? "";
			},
		);
		expect(content).toContain(token);
		expect(report).toContain("~/.labunbun/.mcp.json");
		expect(report).not.toContain(token);
	});
});

// ---------------------------------------------------------------------------
// The three asset directories
// ---------------------------------------------------------------------------

/**
 * `.cursor/commands` — one level, `*.md` only, and a header this build writes.
 *
 * Every claim below is **source-level** (build `2026.09.26-dd393fe`), and the
 * one that matters most is the one the other three sources say the opposite
 * of: Cursor **substitutes** `$ARGUMENTS` and `$1`-`$99` when a command runs.
 * `migrate-core.ts`'s `commandAsSkill` reports 「`$ARGUMENTS` is substituted,
 * $1..$9 … are not」, which is true for the sources it serves and backwards for
 * this one, so the assertion that catches a regression here is a *negative* one
 * on that sentence rather than a positive one on any text of our own.
 */
describe("cursor commands", () => {
	const command = ["# Ship it", "", "Deploy $1 to $ARGUMENTS."].join("\n");

	test("the user half and the project half are two different commands, and both land", () => {
		const planned = planInProject({
			".cursor/commands/mine.md": "# Mine\n\nDo mine.",
			"proj/.cursor/commands/theirs.md": "# Theirs\n\nDo theirs.",
		});
		expect(writeAt(planned, ".labunbun/skills/mine/SKILL.md")?.content).toContain("Do mine.");
		expect(writeAt(planned, ".labunbun/skills/theirs/SKILL.md")?.content).toContain("Do theirs.");
	});

	test("the written file has a name and a description, and the body is the command whole", () => {
		// Cursor parses no frontmatter for a command at all — `parseMarkdownCommand`
		// reads the id off the filename and the content as the entire trimmed text —
		// so both header keys are this build's, and the file is not otherwise
		// touched. A `---` block the user happened to put at the top was text the
		// model saw in Cursor, which is why it stays in the body.
		const planned = plan({ ".cursor/commands/ship.md": command });
		const written = writeAt(planned, ".labunbun/skills/ship/SKILL.md")?.content ?? "";
		expect(written.startsWith("---\nname: ship\ndescription: Ship it\n---\n")).toBe(true);
		expect(written.endsWith(command)).toBe(true);
		// The same reader `skills.ts` gives the loader, not a second parser written
		// here: one written in the test would agree with itself and disagree with
		// the thing being tested.
		expect(parseFrontmatter(written).body).toBe(command);
	});

	test("the report says cursor substitutes its placeholders, and does not say the other thing", () => {
		const planned = plan({ ".cursor/commands/ship.md": command });
		const detail = line(planned, "commands/ship.md")?.detail ?? "";
		expect(detail).toContain("substitutes $ARGUMENTS and $1-$99");
		// The shared sentence, in full. Swapping `cursorCommandAsSkill` for
		// `commandAsSkill` is a one-line change and this is what catches it.
		expect(detail).not.toContain("$1..$9 and inline shell expansion are not");
	});

	test("a command in a subdirectory is named, because cursor does not recurse", () => {
		// `loadCommandsFromDirectory` filters `!isDirectory && name.endsWith(".md")`
		// over one directory's entries and stops there, so `sub/nested.md` is not a
		// command to Cursor. The other three sources flatten their command trees
		// instead — which is why this is worth a test of its own: copying that
		// behaviour here would import a command Cursor never offered.
		const planned = plan({ ".cursor/commands/sub/nested.md": "# Nested\n\nBody." });
		expect(writeAt(planned, ".labunbun/skills/nested/SKILL.md")).toBeUndefined();
		const skip = note(planned, "command file(s) not imported")?.detail ?? "";
		expect(skip).toContain("sub");
		expect(skip).toContain("does not recurse");
	});

	test("a non-markdown file beside a command is neither imported nor named", () => {
		// The extension filter is ordinary rather than a Cursor quirk, and this is
		// the line that says so: the *directory* is named (its "extension" is a
		// filename, and Cursor's filter would have accepted it), the `.txt` is not.
		const planned = plan({ ".cursor/commands/notes.txt": "not a command" });
		expect(planned.writes).toHaveLength(0);
		expect(note(planned, "command file(s) not imported")).toBeUndefined();
	});

	test("a command whose name is blank is named, because cursor drops the file", () => {
		// `if (!o.trim()) return null` after stripping `.md` — the check is on the
		// name, not the contents, so a file full of text still goes.
		const planned = plan({ ".cursor/commands/   .md": "# Real heading\n\nBody." });
		expect(planned.writes).toHaveLength(0);
		expect(note(planned, "command file(s) not imported")?.detail).toContain("blank");
	});

	test("the description is the first heading anywhere, not cursor's first line", () => {
		// `extractTitle` looks at **one line** and falls back to that line verbatim,
		// so a command opening with a frontmatter block is described to the model as
		// `---`. Reproducing that would write a description of three characters; the
		// heading the author wrote is the same text and is the useful one.
		//
		// The second assertion is the load-bearing one and it needs the same fixture:
		// a mutation that strips a leading `---` block out of the body is invisible
		// to a command file that has none, so "the body is the file whole" is
		// checked *here*, on the one fixture that has a block to strip. The other
		// test uses a command with no header, where the two behaviours coincide.
		const source = "---\nfoo: bar\n---\n\n# Ship it\n\nBody.";
		const planned = plan({ ".cursor/commands/ship.md": source });
		const written = writeAt(planned, ".labunbun/skills/ship/SKILL.md")?.content ?? "";
		expect(written).toContain("description: Ship it");
		// Cursor reads the whole file as the command's content, `---` block and
		// all, so the block the model saw in cursor is text the model sees here.
		expect(parseFrontmatter(written).body).toBe(source);
	});
});

/**
 * `.cursor/agents` — the project's only, and carried over byte for byte.
 *
 * The verbatim copy is possible because Cursor's parser and this build's are the
 * same shape: line-based `key: value`, lowercased keys, no YAML, and the body is
 * the prompt. `subagents.ts` reads the same four keys.
 */
describe("cursor agents", () => {
	const agent = [
		"---",
		"name: reviewer",
		"description: Reviews a diff",
		"tools: Read, Grep",
		"model: x",
		"---",
		"",
		"You review.",
	].join("\n");

	test("a project agent is copied byte for byte, and the keys are reported as read", () => {
		const planned = planInProject({ "proj/.cursor/agents/reviewer.md": agent });
		const written = writeAt(planned, ".labunbun/agents/reviewer");
		expect(written?.kind).toBe("agent");
		expect(written?.content).toBe(agent);
		const detail = line(planned, "agents/reviewer.md")?.detail ?? "";
		expect(detail).toContain('"name"');
		expect(detail).toContain('"tools" (Read, Grep)');
		expect(detail).toContain('"model"');
	});

	test("there is no user half, and the report never claims to have looked for one", () => {
		// `computeAgentsDirs()` computes its list from `resolve(workspacePath)` and
		// nowhere else in the bundle. So a `~/.cursor/agents` is not read by Cursor,
		// and the report must not print a path it never looked at — the sentence
		// "no user-level agents found" would name a directory the user has.
		const planned = planInProject({ ".cursor/agents/mine.md": agent });
		expect(writeAt(planned, ".labunbun/agents/mine")).toBeUndefined();
		expect(JSON.stringify(planned.items)).not.toContain("~/.cursor/agents");
	});

	test("cursor's own three keys are named, because this build has none of them", () => {
		const withKeys = [
			"---",
			"name: r",
			"readonly: true",
			"background: true",
			"force-default-model: gpt",
			"---",
			"",
			"Body.",
		].join("\n");
		const detail = line(plan({ ".cursor/agents/r.md": withKeys }), "agents/r.md")?.detail ?? "";
		expect(detail).toContain('"readonly"');
		expect(detail).toContain('"background"');
		expect(detail).toContain('"force-default-model"');
	});

	test("a file with no frontmatter is named rather than imported", () => {
		// The body *is* the prompt, and cursor requires a header to find one, so a
		// plain `.md` here is not an agent to it. The user wrote it in the right
		// place, which is why this is a named skip and not silence.
		const planned = plan({ ".cursor/agents/loose.md": "Just prose." });
		expect(writeAt(planned, ".labunbun/agents/loose")).toBeUndefined();
		expect(note(planned, "path(s) not imported")?.detail).toContain("frontmatter");
	});

	test("a header with nothing after it is named too", () => {
		// `if (0 === n.length) return null`: an empty prompt is not an agent, and
		// importing one would write a subagent that starts with no instructions.
		const planned = plan({ ".cursor/agents/empty.md": "---\nname: e\n---\n" });
		expect(writeAt(planned, ".labunbun/agents/empty")).toBeUndefined();
		expect(note(planned, "path(s) not imported")?.detail).toContain("empty");
	});
});

/**
 * `.cursor/skills` — recursive, and named after the directory that holds
 * `SKILL.md` rather than the top-level one.
 *
 * That naming rule is the one place this reader differs from every other in the
 * repository, and getting it wrong does not fail loudly: it names every nested
 * skill after its top-level directory, so two unrelated skills called `deploy`
 * arrive as one and the report claims two.
 */
describe("cursor skills", () => {
	const skill = ["---", "name: pdf", "description: Work with PDFs", "---", "", "Do the thing."].join("\n");

	test("the user half and the project half are both read", () => {
		const planned = planInProject({
			".cursor/skills/mine/SKILL.md": skill,
			"proj/.cursor/skills/theirs/SKILL.md": skill,
		});
		expect(writeAt(planned, ".labunbun/skills/mine/SKILL.md")?.content).toBe(skill);
		expect(writeAt(planned, ".labunbun/skills/theirs/SKILL.md")?.content).toBe(skill);
	});

	test("a nested skill is named after the directory that holds it, not the top-level one", () => {
		// `getSkillIdForPath`: `basename(dirname(skillMdPath))` first, and the
		// relative path *only* when that bare name is duplicated in the same root.
		const planned = plan({ ".cursor/skills/frontend/deploy/SKILL.md": skill });
		expect(writeAt(planned, ".labunbun/skills/deploy/SKILL.md")).toBeDefined();
		expect(writeAt(planned, ".labunbun/skills/frontend")).toBeUndefined();
	});

	test("two directories of the same name both survive, because the path then decides", () => {
		const planned = plan({
			".cursor/skills/frontend/deploy/SKILL.md": skill,
			".cursor/skills/backend/deploy/SKILL.md": skill,
		});
		expect(writeAt(planned, ".labunbun/skills/frontend-deploy/SKILL.md")).toBeDefined();
		expect(writeAt(planned, ".labunbun/skills/backend-deploy/SKILL.md")).toBeDefined();
		// Neither is dropped, and the report says why the names are paths.
		expect(line(planned, "frontend/deploy/SKILL.md")?.detail).toContain("frontend-deploy");
	});

	test("the rest of the directory travels, even though cursor loads only SKILL.md", () => {
		// Two different questions, and only conflating them would justify dropping
		// them: what the model is *told* at load time is `SKILL.md` alone; what the
		// skill may *use* when it runs is everything beside it, and a skill whose
		// body names `references/guide.md` needs that file to exist.
		const planned = plan({
			".cursor/skills/pdf/SKILL.md": `${skill}\n\nRead references/guide.md first.`,
			".cursor/skills/pdf/references/guide.md": "the guide",
		});
		expect(writeAt(planned, ".labunbun/skills/pdf/SKILL.md")?.content).toContain("references/guide.md");
		expect(writeAt(planned, ".labunbun/skills/pdf/references/guide.md")?.content).toBe("the guide");
		// Counted on the row for the file it belongs to, which is the shared
		// `collectFileWrites` wording rather than a Cursor one.
		expect(note(planned, "with 1 supporting file(s)")?.from).toContain("skills/pdf/SKILL.md");
	});

	test("a markdown file sitting directly in the skills directory is not a skill", () => {
		// `entry.name !== "SKILL.md"` — a bare `notes.md` beside the directories is
		// nothing to cursor, so it is not imported and not worth a line in the report.
		const planned = plan({ ".cursor/skills/notes.md": "not a skill" });
		expect(planned.writes).toHaveLength(0);
	});

	test("the walk gives up at the depth cursor gives up at, and says where", () => {
		// `if (s > 10) return`. A leaf ten directories below the skills root is the
		// last one cursor reaches and one deeper is not, and the cap has to be
		// **named** rather than silently truncating: "nothing to import" and "I
		// stopped looking" are different facts about the same directory.
		//
		// Every leaf is a differently-named directory on purpose. Twelve leaves all
		// called `leaf` would trip the duplicate rule first and every id would
		// become a path, which is a different mechanism and would make this test
		// pass for the wrong reason.
		const tree: SourceTree = {};
		for (let i = 0; i < 12; i++) tree[`.cursor/skills/${"d/".repeat(i)}l${i}/SKILL.md`] = `name: l${i}\n`;
		const planned = plan(tree);
		expect(writeAt(planned, ".labunbun/skills/l9/SKILL.md")).toBeDefined();
		expect(writeAt(planned, ".labunbun/skills/l10/SKILL.md")).toBeUndefined();
		expect(note(planned, "10 directories below")?.detail).toContain("d/".repeat(10));
	});

	test("one skill read from both halves is written once, and the collision is named", () => {
		// `plan()` makes the home its own project, so `~/.cursor/skills` and
		// `<project>/.cursor/skills` are the same directory read twice — the case
		// `planInProject`'s own comment is about. The source's `-2` suffix exists
		// for exactly this, and it is **not** reproduced: the two reads are two
		// calls, and one directory's ids are already distinct within it. So the
		// second is reported as a collision and dropped, which is what the rules
		// reader does for the same situation and what `collectFileWrites` does for
		// every source. Inventing `pdf-2` would put a directory in the user's
		// `~/.labunbun/skills` that names nothing they wrote.
		const planned = plan({ ".cursor/skills/pdf/SKILL.md": "---\nname: pdf\n---\n\nBody." });
		expect(writeAt(planned, ".labunbun/skills/pdf/SKILL.md")).toBeDefined();
		expect(writeAt(planned, ".labunbun/skills/pdf-2/SKILL.md")).toBeUndefined();
		expect(note(planned, "already being written by this run")?.from).toContain("skills/pdf/SKILL.md");
	});
});

/**
 * The trees Cursor harvests and the sources that own them.
 *
 * The table is **per asset kind**, and the test that pins it is the negative one:
 * `~/.codex/agents` is named for nothing because Cursor reads no vendor agents
 * from `.codex`, while `~/.codex/skills` is. A flat list of four directories
 * would name both, and the extra name is a report telling the user a tool reads a
 * directory it does not.
 */
describe("the vendor trees", () => {
	test("a claude skill is not copied a second time, and the owner is named", () => {
		const planned = planInProject({ ".claude/skills/shared/SKILL.md": "---\nname: shared\n---\n\nBody." });
		expect(writeAt(planned, ".labunbun/skills/shared/SKILL.md")).toBeUndefined();
		const detail = line(planned, "~/.claude/skills")?.detail ?? "";
		expect(detail).toContain("claude-code");
		expect(detail).toContain("already imports those trees");
	});

	// The third column is the **spelling**, and it is the per-kind scope table
	// again: `commands` and `skills` are read at the user level as well as the
	// project one, and `agents` only at the project one — so the same directory
	// under a `home` that is also the `cwd` is named twice for the first two
	// kinds and once as `<project>` for the third. Spelling it `~/` throughout
	// would name a user-level `~/.claude/agents` for a directory that does not
	// exist, which is the sentence this file's own header says is the failure.
	test.each([
		["commands", ".claude/commands/ship.md", "# Ship\n\nBody.", "~/.claude/commands"],
		["agents", ".claude/agents/rev.md", "---\nname: rev\n---\n\nBody.", "<project>/.claude/agents"],
		["skills", ".claude/skills/s/SKILL.md", "---\nname: s\n---\n\nBody.", "~/.claude/skills"],
	])("%s: the same vendor directory is named for its own kind", (_kind, path, content, spelling) => {
		const planned = plan({ [path]: content });
		const detail = line(planned, ".claude")?.detail ?? "";
		expect(detail).toContain(spelling);
		expect(detail).toContain("claude-code");
	});

	test("the exclusion is per kind: a codex skill is named and a codex agent is not", () => {
		const planned = plan({
			".codex/skills/shared/SKILL.md": "---\nname: shared\n---\n\nBody.",
			".codex/agents/rev.md": "---\nname: rev\n---\n\nBody.",
		});
		const named = line(planned, "~/.codex")?.detail ?? "";
		expect(named).toContain("codex");
		expect(named).toContain("skills");
		// `.codex` is in the skills row and not in the agents row, and this is the
		// assertion that would go red if the two were flattened into one list.
		expect(named).not.toContain("agents");
	});

	test("grok is owned by grok-build, for both the skills and the agents tree", () => {
		// The one vendor this repository's Cursor source did not have before:
		// `grok-build` is the sixth source, and cursor reads `.grok/skills` *and*
		// `.grok/agents`, so a table that stopped at `.claude` would have imported
		// a second copy of both.
		const planned = plan({
			".grok/skills/s/SKILL.md": "---\nname: s\n---\n\nBody.",
			".grok/agents/a.md": "---\nname: a\n---\n\nBody.",
		});
		const named = line(planned, "~/.grok")?.detail ?? "";
		expect(named).toContain("grok-build");
		expect(named).toContain("skills");
		expect(named).toContain("agents");
	});

	test("the sentence is the same whether or not third-party extensibility is on", () => {
		// `thirdPartyExtensibilityEnabled` defaults to true and nothing in the
		// bundle turns it off, so there is no second outcome to branch on. The
		// exclusion is right in both states, which is why nothing here reads it.
		const planned = plan({ ".claude/commands/ship.md": "# Ship\n\nBody." });
		expect(line(planned, "~/.claude/commands")?.detail).toContain(
			"whether or not cursor's third-party extensibility is on",
		);
	});
});

/**
 * The two lists that have to agree with each other.
 *
 * `commands`, `agents` and `skills` are now read, so they have left the "this
 * importer reads nothing out of" report — and if only one of the two lists were
 * updated, a single run would print 「3 entries imported」 and 「commands is one
 * of the entries this importer reads nothing out of」 in the same report.
 */
describe("presence and the accounted lists", () => {
	test("a home whose only cursor file is one command is still a cursor install", () => {
		// The pillar: `present` gates the whole source, so a user who has written
		// one command and nothing else would have been reported as having no
		// Cursor at all.
		let detected: string[] = [];
		withHome({ ".cursor/commands/ship.md": "# Ship\n\nBody." }, (home) => {
			detected = detectSources(home);
		});
		expect(detected).toEqual(["cursor"]);
	});

	test.each([
		["commands", ".cursor/commands/ship.md", "# Ship\n\nBody."],
		["skills", ".cursor/skills/s/SKILL.md", "---\nname: s\n---\n\nBody."],
		["agents", "proj/.cursor/agents/rev.md", "---\nname: rev\n---\n\nBody."],
	])("%s is imported and is not also reported as unread", (kind, path, content) => {
		const planned = planInProject({ [path]: content });
		const unread = lines(planned, "~/.cursor")
			.map((item) => item.detail)
			.join(" ");
		expect(unread).not.toContain(kind);
	});

	test("an entry the importer really does read nothing out of is still named", () => {
		// The other direction: accounting for the three directories must not have
		// swallowed the sentence that had work to do.
		const planned = plan({ ".cursor/permissions.json": "{}" });
		expect(lines(planned, "~/.cursor")[0]?.detail).toContain("permissions.json");
	});
});

// ---------------------------------------------------------------------------
// Where the user half of the assets is read from
// ---------------------------------------------------------------------------

describe("the user half of the three asset directories", () => {
	// The rule the source follows, verbatim, from `../commands.ts` (chunk
	// `4723.index.js`, build `2026.09.26-dd393fe`):
	//
	//   this.userHomeDirectory = t?.userHomeDirectory ?? homedir()
	//   loadCommandsFromDirectory(join(this.userHomeDirectory, ".cursor", "commands"), "user")
	//
	// and the skill roots are handed that same `userHomeDirectory`. **`WI()` is in
	// neither.** So the config root and the asset root come apart the moment
	// `CURSOR_CONFIG_DIR` or `XDG_CONFIG_HOME` is set — and a reader that used the
	// config root for the assets would read the config files and nothing else,
	// which is batch 1's failure mode one level down.
	test("a command under the home is read even when the config root is elsewhere", () => {
		const planned = plan({ ".cursor/commands/ship.md": "# Ship\n\nBody." }, undefined, {
			CURSOR_CONFIG_DIR: undefined,
		});
		// Baseline first: with no override the same tree imports, so a green here is
		// a fact about the *path* and not about the fixture being read at all.
		expect(writeAt(planned, ".labunbun/skills/ship/SKILL.md")).toBeDefined();
	});

	test("a command under the config root but not the home is NOT read", () => {
		// The load-bearing half. A home whose only command lives where `WI()` points
		// is a tree Cursor does not read, and importing it would put a file in the
		// user's skills that was never a command to them.
		const root = join(tmpdir(), "lbb-cursor-config-root");
		try {
			const planned = plan(
				{ "elsewhere/commands/ghost.md": "# Ghost\n\nBody." },
				() => {
					mkdirSync(join(root, "commands"), { recursive: true });
					writeFileSync(join(root, "commands", "ghost.md"), "# Ghost\n\nBody.");
				},
				{ CURSOR_CONFIG_DIR: root },
			);
			expect(writeAt(planned, ".labunbun/skills/ghost/SKILL.md")).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("the two roots really can come apart, or the test above proves nothing", () => {
		// If `WI()` and the asset root were the same function, the test above would
		// pass for the wrong reason — because the command would be found either way.
		// So: a home with BOTH a command under the home and a different one under
		// the config root, and the two must not both land.
		const root = join(tmpdir(), "lbb-cursor-config-root-2");
		try {
			const planned = plan(
				{ ".cursor/commands/real.md": "# Real\n\nBody." },
				() => {
					mkdirSync(join(root, "commands"), { recursive: true });
					writeFileSync(join(root, "commands", "real.md"), "# Decoy\n\nBody.");
				},
				{ CURSOR_CONFIG_DIR: root },
			);
			expect(writeAt(planned, ".labunbun/skills/real/SKILL.md")).toBeDefined();
			expect(writeAt(planned, ".labunbun/skills/real/SKILL.md")?.content).toContain("# Real");
			expect(writeAt(planned, ".labunbun/skills/real/SKILL.md")?.content).not.toContain("# Decoy");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a skill under the home is read even when the config root is elsewhere", () => {
		const planned = plan({ ".cursor/skills/s/SKILL.md": "---\nname: s\n---\n\nBody." });
		expect(writeAt(planned, ".labunbun/skills/s/SKILL.md")).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// The agents directory, which is read three ways this once got wrong
// ---------------------------------------------------------------------------

describe("cursor agents, in the shape the source reads them", () => {
	test("the walk is recursive, because the source's is", () => {
		// `load()` calls the ripwalk and iterates its results with no depth check of
		// its own, so a nested agent is an agent. A flat reader would skip it and
		// say nothing.
		const planned = planInProject({
			"proj/.cursor/agents/top.md": "---\nname: top\n---\n\nBody.",
			"proj/.cursor/agents/group/inner.md": "---\nname: inner\n---\n\nBody.",
		});
		expect(writeAt(planned, ".labunbun/agents/top")).toBeDefined();
		expect(writeAt(planned, ".labunbun/agents/inner")).toBeDefined();
	});

	test.each([
		["a .md file", "a.md", true],
		["a .mdc file", "a.mdc", true],
		["a .markdown file", "a.markdown", true],
		["an uppercase .MD file", "a.MD", true],
		["a .txt file", "a.txt", false],
		["a file with no extension", "agent", false],
	])("%s is %s", (_label, file, wanted) => {
		// `Ys` is `.md || .mdc || .markdown`, applied to `extname(...).toLowerCase()`.
		// Three extensions and the lowercasing, both of which a one-extension reader
		// gets wrong — and `.mdc` is not a strange file to find in an agents
		// directory, because `.mdc` is the extension Cursor's *rules* use.
		const planned = planInProject({
			[`proj/.cursor/agents/${file}`]: "---\nname: a\n---\n\nBody.",
		});
		expect(writeAt(planned, ".labunbun/agents/a") !== undefined).toBe(wanted);
	});

	test("the depth the walk gives up on is named, not swallowed", () => {
		// The source's walk has no cap and this one does. A cap that reports
		// nothing is indistinguishable from a source that has no files down there.
		const tree: SourceTree = { "proj/.cursor/agents/leaf.md": "---\nname: leaf\n---\n\nBody." };
		let deep = "proj/.cursor/agents";
		for (let i = 0; i < 12; i++) {
			deep = join(deep, `d${i}`);
			tree[`${deep}/leaf.md`] = "---\nname: leaf\n---\n\nBody.";
		}
		const planned = planInProject(tree);
		const skipped = planned.items.find((item) => item.detail.includes("below depth"));
		expect(skipped?.detail).toContain("cursor's walk has none");
	});

	test("a name cursor would show differently is reported, not silently changed", () => {
		// The loader does `name: n.name || Vs(basename)`, and `Vs` collapses runs of
		// spaces and underscores to dashes. The target reads the filename, so the
		// directory is named from the filename — and the difference is the user's to
		// see rather than this run's to decide.
		const planned = planInProject({
			"proj/.cursor/agents/code reviewer.md": "---\nname: reviewer\ntools: Read\n---\n\nBody.",
		});
		const item = note(planned, "agent copied verbatim");
		expect(item?.detail).toContain('cursor shows this as "reviewer"');
	});

	test("a slug-only difference is reported too, because it is a difference", () => {
		// No `name:` key at all: Cursor still does not call this
		// `code reviewer` — `Vs` turns it into `code-reviewer`, which is a different
		// string and a different agent name in a merged list.
		const planned = planInProject({
			"proj/.cursor/agents/code reviewer.md": "---\ntools: Read\n---\n\nBody.",
		});
		expect(note(planned, "agent copied verbatim")?.detail).toContain('cursor shows this as "code-reviewer"');
	});

	test("an agent whose two names agree is not told it was renamed", () => {
		const planned = planInProject({
			"proj/.cursor/agents/rev.md": "---\nname: rev\n---\n\nBody.",
		});
		const detail = note(planned, "agent copied verbatim")?.detail ?? "";
		expect(detail).not.toContain("cursor shows this as");
	});
});

// ---------------------------------------------------------------------------
// The vendor trees, per kind and per level
// ---------------------------------------------------------------------------

describe("the vendor trees, at the levels each kind is read at", () => {
	test("an agents tree under the home is not named: cursor reads no such thing", () => {
		// `computeAgentsDirs()` resolves every one of its joins off
		// `resolve(this.workspacePath)`; `homedir()` appears nowhere in it. A
		// `~/.claude/agents` is a tree the `claude-code` source imports, and naming
		// it here would print a sentence telling the user cursor harvests a
		// directory it never touches.
		//
		// **The tree has to be there.** The first version of this test seeded an
		// empty home, so the sentence was absent because nothing matched rather
		// than because the level was filtered out — which is a claim about the
		// assertion, not about the reader, and it let a driver mutation that
		// deleted the `scopes` filter report HELD. Same shape as the dead-anchor
		// case in the emacs work: a test that never reaches the branch it claims
		// to judge.
		const planned = planInProject({ ".claude/agents/rev.md": "---\nname: rev\n---\n\nBody." });
		const named = note(planned, "cursor harvests")?.detail ?? "";
		expect(named).not.toContain("agents");
	});

	test("the same directory at the user level IS named for skills, or the test above is vacuous", () => {
		// The control for the test above, and it is the only thing that makes it a
		// statement about agents rather than about the scan not running: the
		// identical `~/.claude` prefix, one level down the kinds table, read at
		// both levels.
		const planned = planInProject({ ".claude/skills/s/SKILL.md": "---\nname: s\n---\n\nBody." });
		const named = note(planned, "cursor harvests")?.detail ?? "";
		expect(named).toContain("skills");
		expect(named).toContain("~/.claude/skills");
	});

	test("the project-level agents tree is still named", () => {
		// The other direction, so the test above is not passing because the table
		// lost its agent rows altogether.
		const planned = planInProject({ "proj/.claude/agents/a.md": "---\nname: a\n---\n\nB." });
		const named = note(planned, "cursor harvests")?.detail ?? "";
		expect(named).toContain(".claude");
		expect(named).toContain("agents");
	});

	test("a skill tree under the home is named, because skills do have a user half", () => {
		// `plan` puts the project at `<home>/proj`, so a path with no `proj/`
		// prefix is the **user** half — which is the half being tested here, and the
		// half that a `.cursor`-prefixed fixture would not have reached.
		const planned = planInProject({ ".claude/skills/s/SKILL.md": "---\nname: s\n---\n\nB." });
		expect(note(planned, "cursor harvests")?.detail ?? "").toContain("skills");
	});

	test("a user-level tree is spelled with the tilde, and a project-level one without", () => {
		// The tilde is not decoration. `<project>/.claude/skills` printed as
		// `~/.claude/skills` names a path in the home that does not exist, and this
		// is the second time a level this importer got wrong was hidden by it: batch
		// 1 was the same mistake about the *root* of the user half.
		const user = planInProject({ ".claude/skills/s/SKILL.md": "---\nname: s\n---\n\nB." });
		expect(note(user, "cursor harvests")?.from ?? "").toContain("~/.claude/skills");

		const project = planInProject({ "proj/.claude/skills/s/SKILL.md": "---\nname: s\n---\n\nB." });
		const from = note(project, "cursor harvests")?.from ?? "";
		expect(from).toContain("<project>/.claude/skills");
		expect(from).not.toContain("~/.claude/skills");
	});

	test("the same directory at two levels is two names, not one", () => {
		// `Set` over the spelling used to fold the two into a single entry, which
		// is how a user half could hide behind a project half: the reader would see
		// one name and could not tell which level it described.
		const planned = planInProject({
			".claude/skills/s/SKILL.md": "---\nname: s\n---\n\nB.",
			"proj/.claude/skills/s/SKILL.md": "---\nname: s\n---\n\nB.",
		});
		const from = note(planned, "cursor harvests")?.from ?? "";
		expect(from).toContain("~/.claude/skills");
		expect(from).toContain("<project>/.claude/skills");
	});
});

// ---------------------------------------------------------------------------
// The CLI's per-workspace data tree, and the one credential in it
// ---------------------------------------------------------------------------

describe("the CLI's per-workspace data tree", () => {
	const seedProject = (home: string, files: Record<string, string>) => {
		for (const [name, content] of Object.entries(files)) {
			const path = join(home, ".cursor", "projects", "ws", name);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, content);
		}
	};

	test("a home whose only trace is an MCP token store is still a cursor install", () => {
		// The tree is under the *data* root, and it is the only thing left of the
		// CLI's own state once `CURSOR_CONFIG_DIR` has moved the config elsewhere.
		// Gating on the importable files would report a user with a token store as
		// having no Cursor.
		const planned = plan({}, (home) => seedProject(home, { "mcp-auth.json": "{}" }));
		expect(planned.items.length).toBeGreaterThan(0);
		expect(note(planned, "MCP OAuth tokens")?.detail).toContain("never opened");
	});

	test("the credential and the two decision lists are three names and two sentences", () => {
		// Folding them together would either call a list of approvals a secret,
		// which spends the one warning a user actually reads, or call a token store
		// a list, which is the error the convention exists to prevent.
		const planned = plan({}, (home) =>
			seedProject(home, {
				"mcp-auth.json": "{}",
				"mcp-approvals.json": "{}",
				"mcp-disabled.json": "{}",
			}),
		);
		const credential = note(planned, "MCP OAuth tokens");
		expect(credential?.from).toContain("mcp-auth.json");
		expect(credential?.from).not.toContain("mcp-approvals.json");
		const decisions = note(planned, "which MCP servers you approved");
		expect(decisions?.from).toContain("mcp-approvals.json");
		expect(decisions?.from).toContain("mcp-disabled.json");
	});

	test("a decision list alone is never called a credential", () => {
		const planned = plan({}, (home) => seedProject(home, { "mcp-approvals.json": "{}" }));
		expect(note(planned, "MCP OAuth tokens")).toBeUndefined();
		expect(note(planned, "which MCP servers you approved")).toBeDefined();
	});

	test("`projects` is not also reported as an entry read nothing out of", () => {
		// The double report: a line saying the tree was read, and a line saying
		// there is nothing in it worth reading.
		//
		// **Both lists, and this is the second version of the test.** The first
		// looked only at the user entries, and it passed — while the project list,
		// which the accounted names had never been extended to, was printing
		// `<project>/.cursor … reads nothing out of: projects` right next to the
		// paragraph about the token in it. The fixture is `cwd === home`, so the
		// directory is at both roots and the two lines are two rows of one report.
		// A test that checks one list is a test of half the claim.
		const planned = plan({}, (home) => seedProject(home, { "mcp-auth.json": "{}" }));
		const unread = planned.items
			.filter((item) => item.detail.includes("reads nothing out of"))
			.map((item) => `${item.from} ${item.detail}`)
			.join(" ");
		expect(unread).not.toContain("projects");
	});

	test("a `projects` directory that is not the tree the reader walks is still named", () => {
		// The other direction, so the fix above cannot be over-fitted. Once
		// `CURSOR_DATA_DIR` points elsewhere, a `projects` under the config root is
		// an unrelated directory — and "this importer reads nothing out of it" is
		// true of it, so the sentence belongs.
		const elsewhere = join(tmpdir(), "lbb-cursor-data-root-2");
		try {
			const planned = plan(
				{ ".cursor/projects/ws/leftover.json": "{}" },
				() => {
					mkdirSync(join(elsewhere, "projects", "ws"), { recursive: true });
					writeFileSync(join(elsewhere, "projects", "ws", "mcp-auth.json"), "{}");
				},
				{ CURSOR_DATA_DIR: elsewhere },
			);
			const unread = planned.items
				.filter((item) => item.detail.includes("reads nothing out of"))
				.map((item) => item.detail)
				.join(" ");
			expect(unread).toContain("projects");
			// And the tree that *is* the reader's still got its own line, so the
			// entry above is not the generic sentence standing in for it.
			expect(note(planned, "MCP OAuth tokens")).toBeDefined();
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	test("an empty tree is named once, and not as a credential", () => {
		const planned = plan({}, (home) => {
			mkdirSync(join(home, ".cursor", "projects", "ws"), { recursive: true });
		});
		expect(note(planned, "per-workspace data directory")).toBeDefined();
		expect(note(planned, "MCP OAuth tokens")).toBeUndefined();
	});

	test("a blank `CURSOR_DATA_DIR` is not a value, so the tree stays where it was", () => {
		// `const e=process.env.CURSOR_DATA_DIR; … e.trim()?` — the same judgment
		// `WI()` makes on `CURSOR_CONFIG_DIR` and every other override in this
		// repository. Without it, `CURSOR_DATA_DIR="   "` sends the data root to a
		// path that is three spaces, and the report names a directory no user has.
		const planned = plan({}, (home) => seedProject(home, { "mcp-auth.json": "{}" }), {
			CURSOR_DATA_DIR: "   ",
		});
		expect(note(planned, "MCP OAuth tokens")?.detail).toContain("never opened");
		const from = note(planned, "MCP OAuth tokens")?.from ?? "";
		expect(from).not.toContain("   ");
	});

	test("`CURSOR_DATA_DIR` moves the tree, and only the tree", () => {
		const elsewhere = join(tmpdir(), "lbb-cursor-data-root");
		try {
			const planned = plan(
				{ ".cursor/cli-config.json": "{}" },
				() => {
					mkdirSync(join(elsewhere, "projects", "ws"), { recursive: true });
					writeFileSync(join(elsewhere, "projects", "ws", "mcp-auth.json"), "{}");
				},
				{ CURSOR_DATA_DIR: elsewhere },
			);
			// The config file is still read from the config root…
			expect(note(planned, "MCP OAuth tokens")?.detail).toContain("never opened");
			// …and the tree came from the data root, which is a different variable.
			expect(planned.items.some((item) => item.from.includes("lbb-cursor-data-root"))).toBe(true);
		} finally {
			rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	test("the workspace directory is the name cursor files it under, not one this run invented", () => {
		// The importer lists the tree rather than computing the slug, because the
		// source slugs the **git root** where there is one. So the name in the report
		// has to be the directory that is actually there.
		const planned = plan({}, (home) => seedProject(home, { "mcp-auth.json": "{}" }));
		expect(note(planned, "MCP OAuth tokens")?.detail).toContain("1 workspace(s)");
	});
});

describe("the entries cursor names and this importer has nothing behind", () => {
	test("`sandbox-policies` says why rather than what", () => {
		// The name appears once in the whole bundle, in `src/ephemeral-bridge.ts`'s
		// path table, and no reader constructs it. The generic sentence reads as
		// "we did not bother"; this one is the other thing.
		const planned = plan({ ".cursor/sandbox-policies": "{}" });
		const detail = lines(planned, "~/.cursor")[0]?.detail ?? "";
		expect(detail).toContain("sandbox-policies");
		expect(detail).toContain("nothing in this build of the CLI reads it");
	});
});

// ---------------------------------------------------------------------------
// Helpers used only by the prompt-history group
// ---------------------------------------------------------------------------

/**
 * Where the CLI's prompt list is, spelled out rather than derived from the
 * importer — a fixture that asked the code under test where the file is would
 * pass for any implementation, including the one that had the path wrong.
 *
 * The digest is written out because it is the rule, not a re-implementation of
 * it: `md5(resolve(cwd))` over the **resolved** working directory, which is what
 * `./src/state/index.ts` (`r7()`) does. It is *not* the `state.vscdb` workspace
 * hash, which mixes in the folder's creation time and cannot be recomputed; see
 * `cursor-home.ts`, where the two are kept apart on purpose.
 */
function withPromptList(home: string, contents: string, cwd = home, root = join(home, CURSOR_DIR_BASENAME)): string {
	const path = join(root, "chats", createHash("md5").update(resolve(cwd)).digest("hex"), "view", "prompt_history.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

/** Read a home's prompt list the way the importer does, with the env borrowed. */
function readWith(list: string | undefined, limit = 10): ReturnType<typeof readPromptHistory> {
	let out: ReturnType<typeof readPromptHistory> | undefined;
	withHome({}, (home) => {
		if (list !== undefined) withPromptList(home, list);
		out = readPromptHistory("cursor", home, { cwd: home, scope: "all", limit });
	});
	if (!out) throw new Error("the fake home did not survive");
	return out;
}
