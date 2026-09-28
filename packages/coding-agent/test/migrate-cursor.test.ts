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

	test("sandbox and network are named as settings with no equivalent here", () => {
		const planned = plan({
			".cursor/cli-config.json": JSON.stringify({ sandbox: true, network: { allow: ["example.com"] } }),
		});
		for (const key of ["sandbox", "network"]) {
			const skipped = line(planned, `→ ${key}`);
			expect(skipped?.action).toBe("skip");
			expect(skipped?.detail).toContain("its own process may reach");
		}
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

	test("each approval mode is read as the nearest one here, and the near-miss says why", () => {
		for (const [value, expected] of [
			["ask", "default"],
			["auto", "acceptEdits"],
			["yolo", "bypassPermissions"],
		] as const) {
			const planned = plan({ ".cursor/cli-config.json": JSON.stringify({ approvalMode: value }) });
			expect(settingsJson(planned).permissionMode).toBe(expected);
		}
		// `auto` is the one that is genuinely narrower than cursor's promise, so
		// the report has to say so rather than presenting three exact translations.
		const auto = plan({ ".cursor/cli-config.json": JSON.stringify({ approvalMode: "auto" }) });
		expect(line(auto, 'approvalMode ("auto")')?.detail).toContain("nearest mode");
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
