/**
 * The `antigravity` source outside the planner: the reader, the history listing,
 * and the registration every other module depends on.
 *
 * The claims pinned here are the ones a mistake in the reader would make *silently
 * wrong* rather than crash:
 *
 *   - **`~/.gemini` is not a detection root.** It is shared with the Gemini CLI, so
 *     a home with only Gemini CLI content has a busy one and no Antigravity in it.
 *     Detection that looked there would offer those users a source with nothing to
 *     read, and the import would then find nothing — the more embarrassing half of
 *     that failure.
 *   - **A conversation carries no working directory, and that is reported rather
 *     than guessed.** Each one is filed under the project being migrated into,
 *     flagged with `cwdSubstitute` so the report can say the directory was filed
 *     rather than recorded — and `--history-scope cwd` therefore cannot narrow
 *     this source, which is a sentence the report owes the user rather than a
 *     behaviour it can leave unexplained.
 *   - **The new data root wins and the old one is the fallback**, because the
 *     product's own split copies old → new without deleting the source.
 *
 * Fixtures hold fake values only; `~/.gemini` under a temporary directory is the
 * only one these tests ever see, and nothing here opens a real install.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANTIGRAVITY_NAMED_ONLY,
	antigravityConfigDir,
	antigravityConfigPath,
	antigravityDataDirs,
	antigravityGeminiRoot,
	antigravityGlobalMcpConfigPath,
	antigravityGlobalWorkflowsDir,
	antigravityMcpConfigPath,
	antigravityMemoryPaths,
	antigravitySkillsDir,
	antigravityTranscriptPaths,
	antigravityWorkflowsDir,
} from "../src/antigravity-home.ts";
import { readAntigravity } from "../src/antigravity-read.ts";
import { runMigration } from "../src/migrate.ts";
import { collectHistory, listHistory } from "../src/migrate-history.ts";
import { detectSources, MIGRATION_SOURCE_IDS, MIGRATION_SOURCE_LABELS } from "../src/migrate-types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** A home with nothing under `~/.gemini` at all. */
function emptyHome(): string {
	return makeDir("lbb-ag-home-");
}

/** Write `content` at `<dataDir>/<relative>`, creating the directories above it. */
function writeUnder(dataDir: string, relative: string, content: string): void {
	const path = join(dataDir, ...relative.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

/**
 * A home with one data root holding `files`, whose keys are paths relative to that
 * root and use forward slashes whatever the platform.
 *
 * `which` picks the root the way the product's split does: `"ide"` is the tree a
 * current build writes to, `"old"` is the pre-split one.
 */
function homeWith(which: "ide" | "old", files: Record<string, string>, config?: unknown): string {
	const home = emptyHome();
	const dataDir = antigravityDataDirs(home)[which === "ide" ? 0 : 1];
	for (const [relative, content] of Object.entries(files)) writeUnder(dataDir, relative, content);
	if (config !== undefined) {
		const path = antigravityConfigPath(home);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config), "utf8");
	}
	return home;
}

function transcriptBody(lines: unknown[]): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/**
 * One conversation's compact transcript, as a `files` entry for {@link homeWith}.
 *
 * The path is spelled through {@link antigravityTranscriptPaths} rather than
 * written out — a hand-written `"brain/conv-a/.system_generated/logs/
 * transcript.jsonl"` here would test the literal instead of the function, and
 * would keep passing if the function moved somewhere else.
 */
function conversationLines(lines: unknown[]): Record<string, string> {
	return { [transcriptRelative("conv-a")]: transcriptBody(lines) };
}

/** The compact transcript's path relative to the data root, forward-slashed. */
function transcriptRelative(id: string): string {
	const root = join("root", "root");
	return antigravityTranscriptPaths(join(root, "brain", id))[0]
		.slice(root.length + 1)
		.replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("it is appended, so the thirteen before it keep their places", () => {
	expect(MIGRATION_SOURCE_IDS[MIGRATION_SOURCE_IDS.length - 1]).toBe("antigravity");
	expect(MIGRATION_SOURCE_IDS.length).toBe(14);
	expect(MIGRATION_SOURCE_IDS).toContain("t3-code");
	expect(MIGRATION_SOURCE_IDS.indexOf("claude-code")).toBe(0);
	expect(MIGRATION_SOURCE_LABELS.antigravity).toBe("Antigravity");
	expect(new Set(Object.keys(MIGRATION_SOURCE_LABELS))).toEqual(new Set(MIGRATION_SOURCE_IDS));
});

test("every source id has a label, and every label has an id — one list, two tables", () => {
	// The shape `migrate-types.ts` claims both tables are derived from; if either
	// grows an entry the other does not, this is what notices.
	expect(Object.keys(MIGRATION_SOURCE_LABELS).sort()).toEqual([...MIGRATION_SOURCE_IDS].sort());
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test("the two data roots are the new one first and the old one second, under ~/.gemini", () => {
	const home = emptyHome();
	expect(antigravityGeminiRoot(home)).toBe(join(home, ".gemini"));
	expect(antigravityDataDirs(home)).toEqual([
		join(home, ".gemini", "antigravity-ide"),
		join(home, ".gemini", "antigravity"),
	]);
	// The backup root is a third full copy and is never offered as somewhere to read.
	expect(antigravityDataDirs(home).some((dir) => dir.includes("backup"))).toBe(false);
});

test("a conversation's two transcripts are named the product's way", () => {
	const home = emptyHome();
	const [compact, full] = antigravityTranscriptPaths(join(home, "brain", "conv-a"));
	expect(compact.endsWith(join(".system_generated", "logs", "transcript.jsonl"))).toBe(true);
	expect(full.endsWith(join(".system_generated", "logs", "transcript_full.jsonl"))).toBe(true);
	// Compact first: the product's own instruction is to start there and reach for
	// the full one only per line.
	expect(compact < full).toBe(true);
});

test("the settings document is JSON at config/config.json despite the function's name", () => {
	const home = emptyHome();
	expect(antigravityConfigPath(home)).toBe(join(antigravityConfigDir(home), "config.json"));
	expect(antigravityConfigDir(home)).toBe(join(home, ".gemini", "config"));
});

test("the MCP document is mcp_config.json at the customization root, and the inferred one is second", () => {
	const home = emptyHome();
	expect(antigravityGlobalMcpConfigPath(home)).toBe(join(home, ".gemini", "config", "mcp_config.json"));
	expect(antigravityMcpConfigPath("/data")).toBe(join("/data", "mcp_config.json"));
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("a home with only Gemini CLI state is not offered an Antigravity migration", () => {
	const home = emptyHome();
	// A busy `~/.gemini` that is nothing like Antigravity's: no data root, no
	// `config/`, just Gemini CLI's own files.
	mkdirSync(join(home, ".gemini", "commands"), { recursive: true });
	writeFileSync(join(home, ".gemini", "settings.json"), "{}", "utf8");
	writeFileSync(join(home, ".gemini", "GEMINI.md"), "hi", "utf8");
	expect(detectSources(home)).not.toContain("antigravity");
});

test("a data root with content is enough on its own", () => {
	const home = homeWith(
		"ide",
		conversationLines([{ source: "USER_EXPLICIT", type: "GENERIC", status: "DONE", content: "hi" }]),
	);
	expect(detectSources(home)).toContain("antigravity");
});

test("a customization root with no data root is still this source", () => {
	// The shape of a user who installed and customized and then deleted their
	// conversations: real Antigravity, nothing to import, and it must still be
	// offered rather than called absent.
	const home = emptyHome();
	mkdirSync(antigravitySkillsDir(home), { recursive: true });
	expect(detectSources(home)).toContain("antigravity");
	expect(readAntigravity(home).dataDir).toBeNull();
});

test("an empty data root is not content, so a home with one is not offered", () => {
	const home = emptyHome();
	mkdirSync(join(antigravityDataDirs(home)[0]), { recursive: true });
	expect(detectSources(home)).not.toContain("antigravity");
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

test("a home with no ~/.gemini at all reads as absent rather than as empty", () => {
	const raw = readAntigravity(emptyHome());
	expect(raw.present).toBe(false);
	expect(raw.config).toBeNull();
	expect(raw.conversations).toEqual([]);
});

test("the new root wins over the old one when both hold the same conversation", () => {
	// The product's split copies old → new and never deletes the source, so a
	// conversation in both is one conversation, read once — from the tree the
	// current build writes to.
	const home = emptyHome();
	const body = transcriptBody([{ source: "USER_EXPLICIT", type: "GENERIC", status: "DONE", content: "hi" }]);
	for (const dir of antigravityDataDirs(home)) writeUnder(dir, transcriptRelative("conv-a"), body);
	const raw = readAntigravity(home);
	expect(raw.conversations.map((one) => one.name)).toEqual(["conv-a"]);
	expect(raw.dataDir).toBe(antigravityDataDirs(home)[0]);
});

test("the reader names what it left alone and why", () => {
	// Two things under `brain/` that are not importable, both of which the report
	// has to account for: a directory with no transcript, and a file sitting where
	// the product puts one directory per conversation. Neither is dropped silently.
	const home = emptyHome();
	const dataDir = antigravityDataDirs(home)[0];
	const brain = join(dataDir, "brain");
	mkdirSync(join(brain, "no-transcript-here"), { recursive: true });
	writeFileSync(join(brain, "a-stray-file"), "not a conversation", "utf8");

	const raw = readAntigravity(home);
	const skipped = (reason: string) => raw.skipped.filter((entry) => entry.reason.includes(reason));
	expect(raw.conversations).toEqual([]);
	expect(skipped("a conversation with no transcript").map((entry) => entry.name)).toEqual(["brain/no-transcript-here"]);
	expect(skipped("a file directly under the conversations tree").map((entry) => entry.name)).toEqual([
		"brain/a-stray-file",
	]);
	// Every named-only path that does not exist produces nothing, so a home without
	// plugins is not told about a plugins directory.
	const named = Object.values(ANTIGRAVITY_NAMED_ONLY).map((path) => path.split("/").pop() ?? "");
	// `""` can never be a `pop()` result for these, so nothing is excluded by the
	// guard and nothing is matched by it either: a named-only path that exists would
	// put its own basename in `skipped`, and that is exactly what must not happen.
	expect(raw.skipped.filter((entry) => named.some((base) => base !== "" && entry.name.includes(base)))).toEqual([]);
});

test("the four standing-instructions candidates are tried in a documented order", () => {
	const home = emptyHome();
	expect(antigravityMemoryPaths(home).map((path) => path.slice(home.length + 1))).toEqual([
		join(".gemini", "GEMINI.md"),
		join(".gemini", "config", "GEMINI.md"),
		join(".gemini", "config", "AGENTS.md"),
		join(".gemini", "config", "memory.txt"),
	]);
});

test("the two legacy workflow trees are separate spellings, both read", () => {
	const home = emptyHome();
	expect(antigravityWorkflowsDir(home)).toBe(join(home, ".gemini", "config", "workflows"));
	expect(antigravityGlobalWorkflowsDir(home)).toBe(join(home, ".gemini", "config", "global_workflows"));
	expect(antigravityGlobalWorkflowsDir(home).startsWith(antigravityWorkflowsDir(home))).toBe(false);
});

test("every path the reader names is rendered with forward slashes", () => {
	// The report's own convention, and a Windows separator inside one of these
	// strings is a rendering bug rather than a path.
	const home = emptyHome();
	const home2 = emptyHome();
	for (const raw of [readAntigravity(home), readAntigravity(home2)]) {
		for (const entry of raw.skipped) expect(entry.name).not.toContain("\\");
	}
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test("no Antigravity conversation carries a directory, and that is said rather than guessed", () => {
	const home = homeWith(
		"ide",
		conversationLines([
			{ source: "USER_EXPLICIT", type: "GENERIC", status: "DONE", content: "hi", created_at: "2026-09-01T10:00:00Z" },
		]),
	);
	const project = join(home, "some", "project");
	mkdirSync(project, { recursive: true });
	const listed = listHistory("antigravity", home, { cwd: project, scope: "all" });
	expect(listed.candidates).toHaveLength(1);
	// The directory is the user's, not the conversation's — which is exactly what
	// `cwdSubstitute` says. A plain `cwd` here would be a claim the product's
	// record cannot support; an empty one would drop the session entirely, and
	// since the default scope is `cwd`, on the default run.
	expect(listed.candidates[0].cwd).toBe(project);
	expect(listed.candidates[0].cwdSubstitute).toBe(project);
	expect(listed.candidates[0].path.endsWith("transcript.jsonl")).toBe(true);
	expect(listed.notes.some((note) => note.reason.includes("no working directory of its own"))).toBe(true);
});

test("scope cwd imports them anyway, because the substitute is the project it was asked about", () => {
	const home = homeWith(
		"ide",
		conversationLines([{ source: "USER_EXPLICIT", type: "GENERIC", status: "DONE", content: "hi" }]),
	);
	const project = join(home, "some", "project");
	mkdirSync(project, { recursive: true });
	const listed = listHistory("antigravity", home, { cwd: project, scope: "cwd" });
	// This is the test that fails if a future edit reads the substitute as if the
	// source recorded a directory: `sameProject(substitute, options.cwd)` is true
	// here, so the conversation is offered, and the report is what has to carry
	// the fact that it was filed rather than matched.
	expect(listed.candidates).toHaveLength(1);
	expect(listed.notes.some((note) => note.reason.includes('scope is "cwd"'))).toBe(false);
	expect(listed.notes.some((note) => note.reason.includes("cannot narrow this source"))).toBe(true);
});

test("a conversation's start time comes from the transcript, so the picker sorts", () => {
	const home = emptyHome();
	const dataDir = antigravityDataDirs(home)[0];
	for (const [id, at] of [
		["conv-old", "2026-01-01T00:00:00Z"],
		["conv-new", "2026-09-01T00:00:00Z"],
	]) {
		writeUnder(
			dataDir,
			transcriptRelative(id),
			transcriptBody([{ source: "USER_EXPLICIT", type: "GENERIC", status: "DONE", content: id, created_at: at }]),
		);
	}
	const listed = listHistory("antigravity", home, { cwd: home, scope: "all" });
	expect(listed.candidates.map((candidate) => candidate.sourceId)).toEqual(["conv-new", "conv-old"]);
});

test("the collected session carries the transcript and fills in what the picker could not", () => {
	const home = homeWith(
		"ide",
		conversationLines([
			{
				source: "USER_EXPLICIT",
				type: "USER_INPUT",
				status: "DONE",
				content: "the question",
				created_at: "2026-09-01T10:00:00Z",
			},
			{ source: "MODEL", type: "GENERIC", status: "DONE", content: "the answer", created_at: "2026-09-01T10:00:01Z" },
		]),
	);
	const input = collectHistory("antigravity", home, { cwd: home, scope: "all", limit: 20 });
	expect(input.sessions).toHaveLength(1);
	const session = input.sessions[0];
	expect(session.source).toBe("antigravity");
	expect(session.title).toBe("the question");
	expect(session.startedAt).toBe(Date.parse("2026-09-01T10:00:00Z"));
	expect(session.entries).toHaveLength(2);
	// The marker has to survive the candidate → session hop, or the report cannot
	// tell a filed directory from a recorded one.
	expect(session.cwdSubstitute).toBe(home);
});

test("the planner is wired: a settings run reaches planAntigravity", () => {
	// A source can be registered end to end — id, label, `SOURCE_ROOTS`,
	// `detectionRoots`, a reader, a planner, and a working history path — and still
	// import nothing at all, because the one line in `migrate.ts` that calls the
	// planner was never written. Detection finds `~/.gemini`, the report lists
	// Antigravity, and every settings key, MCP server, skill and workflow is
	// silently left behind.
	//
	// `migrate-antigravity-plan.test.ts` cannot catch that: it calls
	// `planAntigravity` directly with its own `claimScalar` recorder, which is the
	// right way to test the mapper and the wrong way to test the wiring. This is
	// the test for the wiring.
	const home = homeWith("ide", conversationLines([]));
	const result = runMigration({ home, from: "antigravity", only: ["settings"], apply: false });
	expect(result.error).toBeUndefined();
	const mine = result.plan.items.filter((item) => item.source === "antigravity");
	expect(mine.length).toBeGreaterThan(0);
	// Not merely "an item exists" — the leftovers line is unconditional, so its
	// presence would survive a planner that had stopped claiming anything. The
	// theme claim is the check that the mapping half ran too.
	const home2 = homeWith("ide", conversationLines([]), { userSettings: { themeMode: "LIGHT" } });
	const themed = runMigration({ home: home2, from: "antigravity", only: ["settings"], apply: false });
	expect(themed.plan.items.some((item) => item.source === "antigravity" && item.detail.includes("light"))).toBe(true);
});

test("an assets-only run still reaches the planner, not just a settings run", () => {
	// The dispatch is `wants("settings") || wants("assets")` rather than one of
	// the two, and the reason is that Antigravity has all three categories: a run
	// that asked only for skills and workflows would reach the asset branches
	// through no path at all. A gate that said `settings` alone would keep every
	// test in the plan file green and drop the assets on the floor.
	const home = emptyHome();
	writeUnder(antigravitySkillsDir(home), "my-skill/SKILL.md", "---\nname: my-skill\n---\n");
	const result = runMigration({ home, from: "antigravity", only: ["assets"], apply: false });
	expect(result.error).toBeUndefined();
	// On `from`/`to`, not on `detail`: a copied skill's detail is "skill copied
	// verbatim" and carries no name in any source — the name is the path the report
	// prints. Asserting on `detail` would be asserting on a string this planner
	// never emits, which fails the same way whether the gate is right or wrong.
	const skills = result.plan.items.filter((item) => item.source === "antigravity" && item.action === "map");
	expect(skills.map((item) => item.to)).toContain("~/.labunbun/skills/my-skill/SKILL.md");
	expect(skills.map((item) => item.detail)).toContain("skill copied verbatim");
	expect(result.plan.writes.some((write) => write.path.includes("my-skill"))).toBe(true);
});

test("the report says the directory was filed, not recorded", () => {
	// The whole chain, at the level the user reads it. A substitute that reached
	// the session and then said nothing would be worse than not having one: the
	// import would look exactly like a correctly attributed one.
	const home = homeWith(
		"ide",
		conversationLines([
			{
				source: "USER_EXPLICIT",
				type: "USER_INPUT",
				status: "DONE",
				content: "the question",
				created_at: "2026-09-01T10:00:00Z",
			},
			{ source: "MODEL", type: "GENERIC", status: "DONE", content: "the answer", created_at: "2026-09-01T10:00:01Z" },
		]),
	);
	const result = runMigration({ home, from: "antigravity", only: ["history"], historyScope: "cwd", apply: false });
	expect(result.error).toBeUndefined();
	const mapped = result.plan.items.filter((item) => item.action === "downgrade");
	expect(mapped).toHaveLength(1);
	// `downgrade` and not `map`: the action vocabulary already has a word for a
	// thing carried over in reduced form, and a session that cannot say which
	// project it was in is exactly that.
	expect(mapped[0].detail).toContain("records no directory for any of its sessions");
	expect(mapped[0].detail).toContain("every project");
	// And the note has to be there too, or a reader of the plan learns the
	// directory was assumed only by noticing the downgrade.
	expect(result.plan.items.some((item) => item.detail.includes("cannot narrow this source"))).toBe(true);
});

test("a home with no conversations collects nothing and reports nothing", () => {
	const home = emptyHome();
	mkdirSync(antigravitySkillsDir(home), { recursive: true });
	const input = collectHistory("antigravity", home, { cwd: home, scope: "all", limit: 20 });
	expect(input.sessions).toEqual([]);
	expect(input.overLimit).toBe(0);
});
