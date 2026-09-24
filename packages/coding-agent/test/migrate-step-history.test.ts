/**
 * What the Step Code importer carries out of `<agent dir>/sessions`, and what it
 * says about what it does not.
 *
 * Step Code is a fork of `earendil-works/pi` and kept Pi's session format, so the
 * fixtures here are the bytes Step writes: a `session` header on line one, entries
 * with `id`/`parentId`, ISO timestamps beside epoch-ms ones, and the shapes a v1
 * file has instead — no ids at all on its entries, which is the one difference a
 * reader cannot notice from the file name and cannot ignore. The v1 lines below
 * are the bytes of Step's own v1 fixture
 * (`packages/coding-agent/test/fixtures/before-compaction.jsonl` in that tree,
 * asserted literally in the test that reads them): a header that carries both
 * `version: 1` and an id, entry lines that carry neither, and a trailing
 * `model_change` entry, which is what makes such a file's last line a non-message
 * leaf.
 *
 * Three rules shape the file. The tree is resolved through the same environment
 * Step reads, so the tests borrow every variable that moves it (`$HOME` and
 * `$USERPROFILE` too, for the same reason the other sources' tests do: a
 * developer's real home must not decide an outcome) and give them all back.
 * Reading is a read: nothing here writes, and two tests say so — a home with no
 * Step tree is left without one, and every byte of a tree that has one is
 * unmoved. And every skip is asserted with the reason the report prints, because a
 * reader that quietly passes over a session is worse than one that refuses it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionStore } from "@labunbun/agent";
import type { AgentMessage, AssistantContent, ImageContent, ToolResultContent, UserContent } from "@labunbun/ai";
import { type RunMigrationResult, runMigration } from "../src/migrate.ts";
import { importedSessionId, listHistory, readHistory, readPromptHistory } from "../src/migrate-history.ts";
import { STEPCODE_DEFAULT_DIR, STEPCODE_LEGACY_DIR, stepAgentDir, stepConfigRoot, stepRoot } from "../src/step-home.ts";
import {
	listStepSessions,
	readStepSession,
	type StepEntry,
	type StepRead,
	type StepSessionFile,
} from "../src/step-session.ts";

/** The session id every fixture uses, in Step's own uuid-v7 spelling. */
const SESSION_ID = "0199a1f6-7c2e-7b31-9a4d-6f0b2c8e1d55";

/** A second session, for the listings that hold more than one. */
const OTHER_ID = "0199a1f6-7c2e-7b31-9a4d-6f0b2c8e1d56";

/** A third, behind a name no reader should call a session (`ALSO.JSONL`). */
const THIRD_ID = "0199a1f6-7c2e-7b31-9a4d-6f0b2c8e1d57";

/** The working directory the fixtures record, encoded into the bucket name below. */
const CWD = "C:\\work\\demo";

/** The fixtures' clock: every entry below counts from here, one second per line. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** Temp homes, swept with the test that made them. */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Environment variables a test borrowed, restored after it. */
const borrowed = new Map<string, string | undefined>();
afterEach(() => {
	for (const [name, value] of borrowed) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	borrowed.clear();
});

/** Borrow one environment variable for the rest of the test. */
function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * Run `body` against a throwaway home with nothing set, so what is read is
 * `~/.stepcode`.
 *
 * The three variables that move the tree are borrowed away rather than assumed
 * absent, and so are the two that name the home: a machine that has any of them
 * set would otherwise decide what these tests are testing.
 */
function withHome(body: (home: string) => void): string {
	const home = mkdtempSync(join(tmpdir(), "lbb-step-history-"));
	roots.push(home);
	setEnv("HOME", home);
	setEnv("USERPROFILE", home);
	setEnv("STEPCODE_CONFIG_DIR", undefined);
	setEnv("STEP_CODING_AGENT_DIR", undefined);
	setEnv("STEP_CODING_AGENT_SESSION_DIR", undefined);
	body(home);
	return home;
}

/** `<home>/.stepcode` — the canonical tree. */
function canonicalRoot(home: string): string {
	return join(home, STEPCODE_DEFAULT_DIR);
}

/** `<root>/agent/sessions` — the session root of a tree with no session override. */
function sessionsUnder(root: string): string {
	return join(root, "agent", "sessions");
}

/**
 * The `--<cwd>--` bucket Step puts a working directory's sessions in.
 *
 * `getDefaultSessionDirPath` (`core/session-manager.ts:476-481`, spelled again at
 * `step/session.ts:105-110`) resolves the cwd, drops one leading separator and
 * maps every `/`, `\` and `:` to `-` — a lossy encoding with no decoder anywhere in
 * Step, which is why the reader takes a session's cwd from its header and never
 * from this name. It is reproduced here so the fixtures sit where Step would have
 * put them; the reader must not care.
 */
function bucketName(cwd: string): string {
	return `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}

/** Epoch ms of the fixture clock, `second`s in. */
function epoch(second: number): number {
	return T0 + second * 1000;
}

/** The same instant as the ISO string Step writes. */
function iso(second: number): string {
	return new Date(epoch(second)).toISOString();
}

/** The file name Step gives a session: its timestamp, then its id (`:953-954`). */
function fileName(id: string, second = 0): string {
	return `${iso(second).replace(/[:.]/g, "-")}_${id}.jsonl`;
}

// ---------------------------------------------------------------------------
// Fixtures: the bytes Step writes
// ---------------------------------------------------------------------------

/** A v3 session header: the version is written, the id is the session's own. */
function header(fields: Record<string, unknown> = {}): string {
	return JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: iso(0), cwd: CWD, ...fields });
}

/** A v1 session header: `version: 1`, the id present, and the field order of the real fixture. */
function v1Header(id = SESSION_ID, cwd = CWD): string {
	return `{"type":"session","id":${JSON.stringify(id)},"timestamp":"${iso(0)}","cwd":${JSON.stringify(cwd)},"version":1}`;
}

/** One v3 entry: the base fields first, as `SessionEntryBase` declares them. */
function entry(id: string, parentId: string | null, body: Record<string, unknown>, second: number): string {
	return JSON.stringify({ ...body, id, parentId, timestamp: iso(second) });
}

/** A v3 message entry wrapping a message body. */
function messageEntry(id: string, parentId: string | null, message: Record<string, unknown>, second: number): string {
	return entry(id, parentId, { type: "message", message }, second);
}

/** A v3 user message: the content is a string or a list of blocks. */
function userEntry(id: string, parentId: string | null, content: unknown, second: number): string {
	return messageEntry(id, parentId, { role: "user", content, timestamp: epoch(second) }, second);
}

/** A v3 assistant message with one text block, as the provider records it. */
function assistantEntry(id: string, parentId: string | null, text: string, second: number): string {
	return messageEntry(
		id,
		parentId,
		{
			role: "assistant",
			content: [{ type: "text", text }],
			api: "openai-completions",
			provider: "stepcode",
			model: "step-5-preview",
			stopReason: "stop",
			timestamp: epoch(second),
			usage: { input: 128, output: 32, cacheRead: 0, cacheWrite: 0, totalTokens: 160 },
		},
		second,
	);
}

/** The compaction entry's own shape, `CompactionEntry` (`core/session-manager.ts:69-82`). */
function compactionEntry(id: string, parentId: string | null, fields: Record<string, unknown>, second: number): string {
	return entry(id, parentId, { type: "compaction", ...fields }, second);
}

/**
 * A v1 entry line: no `id`, no `parentId`, and the field order of the real
 * fixture — `{type, timestamp, message}` with an ISO stamp in both places.
 */
function v1UserLine(text: string, second: number): string {
	return `{"type":"message","timestamp":"${iso(second)}","message":{"role":"user","content":${JSON.stringify(text)},"timestamp":"${iso(second)}"}}`;
}

/** A v1 assistant line, in the fixture's shape: the usage block included. */
function v1AssistantLine(text: string, second: number): string {
	const usage = { input: 128, output: 32, cacheRead: 0, cacheWrite: 0, totalTokens: 160 };
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "synthetic",
		model: "synthetic-model",
		stopReason: "stop",
		timestamp: iso(second),
		usage,
	};
	return `{"type":"message","timestamp":"${iso(second)}","message":${JSON.stringify(message)}}`;
}

/** The v1 model-change line the real fixture ends with. */
function v1ModelChangeLine(second: number): string {
	return `{"type":"model_change","timestamp":"${iso(second)}","provider":"synthetic","modelId":"synthetic-model"}`;
}

interface SessionFixture {
	/** The file's name; the default is the one Step writes for `id`. */
	name?: string;
	lines: string[];
	/** Write it straight into the session root instead of a `--<cwd>--` bucket. */
	flat?: boolean;
	/** The bucket to sit in, when it is not `CWD`'s. */
	bucket?: string;
}

/** Write one session where Step would have written it, and say where that is. */
function writeSession(root: string, fixture: SessionFixture): string {
	const dir = fixture.flat ? root : join(root, fixture.bucket ?? bucketName(CWD));
	mkdirSync(dir, { recursive: true });
	const path = join(dir, fixture.name ?? fileName(SESSION_ID));
	writeFileSync(path, `${fixture.lines.join("\n")}\n`);
	return path;
}

/** A file that sits in a session directory without being a session. */
function writeRaw(dir: string, name: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
}

/**
 * A session whose last line starts at an exact byte offset.
 *
 * The head the listing reads is a byte count, so the only way to say where a name
 * falls relative to it is to place the line by its bytes: the header, the first
 * user message and a `label` filler are all ASCII, and the filler's padding is
 * computed from the bytes the lines before it occupy, newlines included.
 */
function sessionNamingAt(id: string, nameLine: string, startsAt: number): string[] {
	const prefix = [header({ id }), userEntry("e1", null, `prompt of ${id}`, 1)];
	const used = prefix.reduce((total, line) => total + Buffer.byteLength(line, "utf8") + 1, 0);
	const template = entry("e2", "e1", { type: "label", targetId: "e1", label: "PAD" }, 2);
	const empty = Buffer.byteLength(template.replace("PAD", ""), "utf8");
	return [...prefix, template.replace("PAD", "y".repeat(startsAt - used - empty - 1)), nameLine];
}

/** The session a listing has to have found; the reader's own words are the failure. */
function listed(home: string, id = SESSION_ID): StepSessionFile {
	const found = listStepSessions(home).sessions.find((session) => session.id === id);
	if (found === undefined) throw new Error(`no listed session ${id} under ${home}`);
	return found;
}

/** A read that has to have succeeded. */
function readSession(home: string, id = SESSION_ID): StepRead {
	const read = readStepSession(listed(home, id));
	if ("error" in read) throw new Error(`readStepSession refused ${id}: ${read.error}`);
	return read;
}

/**
 * Read one session in a child process, with a deadline only this process can enforce.
 *
 * A reader that follows a cyclic `parentId` never returns, and a synchronous loop
 * never yields the thread a timer would need, so nothing *inside* this process can
 * end it — not a `bun test` timeout, not an abort signal. A child can be killed
 * from outside, and that is what turns "hangs forever" into a red test. The script
 * is written into the throwaway home (nothing outside the temp tree is touched),
 * imports the reader by absolute URL so it does not care where it was started from,
 * and prints the same two things the in-process assertions read.
 */
function readInChild(home: string, path: string, boundMs = 10_000): { texts: string[]; notes: StepRead["notes"] } {
	const script = join(home, "read-in-child.ts");
	writeFileSync(
		script,
		[
			`import { readStepSession } from ${JSON.stringify(new URL("../src/step-session.ts", import.meta.url).href)};`,
			`const read = readStepSession({ path: ${JSON.stringify(path)}, id: "child", cwd: null, title: null, startedAt: 0 });`,
			'if ("error" in read) throw new Error(read.error);',
			"const texts = read.entries.flatMap((entry) => {",
			"\tconst content = entry.message.content;",
			'\tif (typeof content === "string") return [content];',
			'\treturn content.filter((block) => block.type === "text").map((block) => block.text);',
			"});",
			"console.log(JSON.stringify({ texts, notes: read.notes }));",
		].join("\n"),
	);
	const child = Bun.spawnSync({ cmd: [process.execPath, script], timeout: boundMs, stdout: "pipe", stderr: "pipe" });
	// A child killed at the deadline printed nothing: the two assertions say which of
	// the two happened, because "the reader hung" and "the reader said more than the
	// answer" are different failures. `stderr` first, so a child that died on its own
	// error still shows it.
	expect(child.stderr.toString().trim()).toBe("");
	expect(child.exitCode).toBe(0);
	return JSON.parse(child.stdout.toString()) as { texts: string[]; notes: StepRead["notes"] };
}

/** The messages of a read, with any compaction entry left out. */
function messagesOf(entries: StepEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
}

/**
 * A message's text, so an assertion can look for a canary.
 *
 * Only the text blocks are joined: an attachment in the same message is not a
 * blank line, and these assertions are about the words.
 */
function textOf(message: AgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content : textsFrom(message.content);
	}
	return textsFrom(message.content);
}

/** The text of the blocks that carry any, in order. */
function textsFrom(blocks: ReadonlyArray<UserContent | AssistantContent | ToolResultContent>): string {
	const texts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") texts.push(block.text);
	}
	return texts.join("\n");
}

/** The image blocks a message carries, in order; a message that is one string carries none. */
function imagesOf(content: AgentMessage["content"]): ImageContent[] {
	if (typeof content === "string") return [];
	const blocks: ReadonlyArray<{ type: string }> = content;
	return blocks.filter((block): block is ImageContent => block.type === "image");
}

/** Every text a read produced, in order. */
function textsOf(entries: StepEntry[]): string[] {
	return messagesOf(entries).map(textOf);
}

/** The count a reader wrote for one reason, or 0 when it wrote none. */
function note(read: { notes: Array<{ reason: string; count: number }> }, reason: string): number {
	return read.notes.find((entry) => entry.reason === reason)?.count ?? 0;
}

/** The reason a walk gave for one entry, or undefined when it gave none. */
function skipFor(skipped: Array<{ name: string; reason: string }>, name: string): string | undefined {
	return skipped.find((entry) => entry.name === name)?.reason;
}

/** Every file and directory under a root, with its size, mtime and content digest. */
function snapshotTree(root: string): string[] {
	const lines: string[] = [];
	for (const entry of readdirSync(root, { recursive: true }).map(String).sort()) {
		const path = join(root, entry);
		const stat = statSync(path);
		const body = stat.isDirectory() ? "<dir>" : createHash("sha256").update(readFileSync(path)).digest("hex");
		lines.push(`${entry.replace(/\\/g, "/")} ${stat.size} ${stat.mtimeMs} ${body}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

describe("the tree the Step Code history reader reads", () => {
	test("with nothing set it is ~/.stepcode, and a session there is found", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), { lines: [header(), userEntry("e1", null, "hello", 1)] });
			expect(stepAgentDir(home)).toBe(join(home, ".stepcode", "agent"));
			expect(stepConfigRoot(home)).toBe(join(home, ".stepcode"));
			expect(listStepSessions(home).sessions.map((session) => session.id)).toEqual([SESSION_ID]);
		});
	});

	test("$STEPCODE_CONFIG_DIR names the tree, and a blank one does not", () => {
		withHome((home) => {
			const moved = sessionsUnder(join(home, "my-code"));
			writeSession(moved, { lines: [header(), userEntry("e1", null, "hello", 1)] });
			for (const blank of ["", "   ", "\t"]) {
				setEnv("STEPCODE_CONFIG_DIR", blank);
				expect(listStepSessions(home).sessions).toEqual([]);
			}
			setEnv("STEPCODE_CONFIG_DIR", "my-code");
			expect(listStepSessions(home).sessions.map((session) => session.id)).toEqual([SESSION_ID]);
			// A `~` in the name is an ordinary character: the setting names a
			// directory under the home, and Step never expands it.
			setEnv("STEPCODE_CONFIG_DIR", "~");
			expect(stepRoot(home)).toBe(join(home, "~"));
			expect(listStepSessions(home).sessions).toEqual([]);
		});
	});

	test("$STEP_CODING_AGENT_DIR moves the agent directory and the tree with it", () => {
		// The config root is the agent directory's *parent* (`resolveStepConfigRoot`),
		// so a user who kept their agent directory elsewhere has a whole tree
		// elsewhere — and the `~/.stepcode` sessions of the default tree are not
		// theirs to import. A reader that took the parent rule as a detail of where
		// `config.toml` lives would read both trees here and import the wrong one.
		withHome((home) => {
			writeSession(sessionsUnder(join(home, ".stepcode")), {
				lines: [header({ id: OTHER_ID }), userEntry("e1", null, "default tree", 1)],
			});
			const agentDir = join(home, "elsewhere", "agent");
			setEnv("STEP_CODING_AGENT_DIR", agentDir);
			writeSession(sessionsUnder(join(home, "elsewhere")), {
				lines: [header(), userEntry("e1", null, "moved tree", 1)],
			});
			expect(stepAgentDir(home)).toBe(agentDir);
			expect(stepConfigRoot(home)).toBe(join(home, "elsewhere"));
			expect(listStepSessions(home).sessions.map((session) => session.id)).toEqual([SESSION_ID]);
			expect(textsOf(readSession(home).entries)).toEqual(["moved tree"]);
		});
	});

	test("$STEP_CODING_AGENT_SESSION_DIR names the session root, and it is read flat", () => {
		// A configured session directory is what `--session-dir` and the `sessionDir`
		// setting both mean, and a session written under one lands directly in it
		// rather than in a `--<cwd>--` bucket (`listSessionsFromDir`, `:812-826`).
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [header({ id: OTHER_ID }), userEntry("e1", null, "bucketed", 1)],
			});
			setEnv("STEP_CODING_AGENT_SESSION_DIR", join(home, "sessions-here"));
			writeSession(join(home, "sessions-here"), {
				lines: [header(), userEntry("e1", null, "configured", 1)],
				flat: true,
			});
			expect(listStepSessions(home).sessions.map((session) => session.id)).toEqual([SESSION_ID]);
			expect(textsOf(readSession(home).entries)).toEqual(["configured"]);
			// A leading `~` is expanded against the home the migrator was given, then
			// resolved; a relative value is resolved the same way.
			setEnv("STEP_CODING_AGENT_SESSION_DIR", "~/sessions-from-env");
			writeSession(join(home, "sessions-from-env"), {
				lines: [header({ id: OTHER_ID }), userEntry("e1", null, "tilde", 1)],
				flat: true,
			});
			expect(listStepSessions(home).sessions.map((session) => session.id)).toEqual([OTHER_ID]);
		});
	});

	test("a session survives the rename: .step-harness is read when the canonical tree has nothing", () => {
		withHome((home) => {
			const retired = join(home, STEPCODE_LEGACY_DIR);
			writeSession(sessionsUnder(retired), { lines: [header(), userEntry("e1", null, "before the rename", 1)] });
			expect(stepRoot(home)).toBe(retired);
			expect(listed(home).path.startsWith(retired)).toBe(true);
			expect(textsOf(readSession(home).entries)).toEqual(["before the rename"]);
		});
	});

	test("a variable that names the tree cancels the retired-tree fallback", () => {
		withHome((home) => {
			writeSession(sessionsUnder(join(home, STEPCODE_LEGACY_DIR)), {
				lines: [header(), userEntry("e1", null, "abandoned", 1)],
			});
			setEnv("STEPCODE_CONFIG_DIR", "custom");
			expect(listStepSessions(home).sessions).toEqual([]);
			setEnv("STEPCODE_CONFIG_DIR", undefined);
			setEnv("STEP_CODING_AGENT_DIR", join(home, "elsewhere", "agent"));
			expect(listStepSessions(home).sessions).toEqual([]);
		});
	});

	test("reading creates nothing: a home with no Step tree is left without one", () => {
		// Step itself creates the `--<cwd>--` bucket the moment a session *starts*
		// (`getDefaultSessionDir`, `:483-489`), so a reader that reached for that
		// helper would leave directories behind in a home it was only asked to look
		// at. This is the test that says it does not.
		const home = withHome((home) => {
			expect(listStepSessions(home)).toEqual({ sessions: [], skipped: [] });
		});
		expect(existsSync(join(home, STEPCODE_DEFAULT_DIR))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("the listing", () => {
	test("a session is listed with its header's id, cwd, title and time", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [header(), userEntry("e1", null, "what is in the header", 3)],
			});
			const session = listed(home);
			expect(session.id).toBe(SESSION_ID);
			expect(session.cwd).toBe(CWD);
			expect(session.startedAt).toBe(epoch(0));
			expect(session.title).toBe("what is in the header");
		});
	});

	test("the title is the last name the session was given, else its first prompt", () => {
		withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			// Renamed: the last `session_info` wins, and a clear (`""`) is a name taken
			// back rather than an ignored line (`buildSessionInfo`, `:718-721`).
			writeSession(root, {
				name: fileName(SESSION_ID),
				lines: [
					header(),
					userEntry("e1", null, "first thing said", 1),
					entry("e2", "e1", { type: "session_info", name: "named once" }, 2),
					entry("e3", "e2", { type: "session_info", name: "named twice" }, 3),
				],
			});
			expect(listed(home).title).toBe("named twice");
			// Never renamed: the first user message, and an assistant message does not
			// stand in for one.
			writeSession(root, {
				name: fileName(OTHER_ID),
				lines: [
					header({ id: OTHER_ID }),
					assistantEntry("e1", null, "the model spoke first", 1),
					userEntry("e2", "e1", "   the user's first words   ", 2),
				],
			});
			expect(listed(home, OTHER_ID).title).toBe("the user's first words");
		});
	});

	test("a session with nothing said and no name has no title", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), { lines: [header()] });
			expect(listed(home).title).toBeNull();
		});
	});

	test("a name made of nothing but whitespace leaves the title to the first prompt", () => {
		// Step trims the name before it decides it has one
		// (`name = asText(entry.name).trim() || null`, `:200`), so a session renamed
		// to spaces is a session that was never named: the title is the first prompt,
		// not the blank the name would clip to.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "the first thing said", 1),
					entry("e2", "e1", { type: "session_info", name: "   " }, 2),
				],
			});
			expect(listed(home).title).toBe("the first thing said");
		});
	});

	test("the title is the first user message, not the last thing said", () => {
		// `first` is filled once and never overwritten (`:203-208`): the scan stops at
		// the first user message that gives it something, so a later turn — the user's
		// or the model's — cannot become the title of the session.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "the question that started it", 1),
					assistantEntry("e2", "e1", "an answer", 2),
					userEntry("e3", "e2", "the last thing said", 3),
				],
			});
			expect(listed(home).title).toBe("the question that started it");
		});
	});

	test("a title is folded onto one line", () => {
		// `clipToOneLine` collapses every run of whitespace to one space before it
		// clips (`:224-226`), so a name written across two lines is one line: a title
		// is a label for a row, and a newline in it would break the row. (The padding
		// around the name goes too, but it is already gone by the time the name gets
		// here — both call sites trim what they pass, `:200` and `:206` — so the trim
		// inside `clipToOneLine` is redundant and no test can pin it on its own.)
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "a prompt nobody renamed this session after", 1),
					entry("e2", "e1", { type: "session_info", name: "  two\nlines  " }, 2),
				],
			});
			expect(listed(home).title).toBe("two lines");
		});
	});

	test("a damaged line before the header does not cost the session", () => {
		// A run killed mid-write leaves a line that never finished. Step's own header
		// scan steps over anything that does not parse and keeps looking for the
		// header (`parseSessionHeaderCandidate` returns "keep scanning",
		// `core/session-manager.ts:564-570`), so the header one line down is the
		// session's header and the file is a session.
		withHome((home) => {
			const path = writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					'{"type":"session","version":3,"id":"this line never finis',
					header(),
					userEntry("e1", null, "after the damage", 1),
				],
			});
			expect(listed(home).path).toBe(path);
			expect(textsOf(readSession(home).entries)).toEqual(["after the damage"]);
		});
	});

	test("a header past a line too long to parse is still found", () => {
		// The head read is bounded at 64 KiB (`SESSION_HEAD_BYTES`). A head of one
		// kilobyte — or a scan that gave up at the first line it could not parse —
		// would lose this session, whose header sits behind four kilobytes of damage.
		withHome((home) => {
			const path = writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: ["-".repeat(4096), header(), userEntry("e1", null, "behind the damage", 1)],
			});
			expect(listed(home).path).toBe(path);
			expect(textsOf(readSession(home).entries)).toEqual(["behind the damage"]);
		});
	});

	test("a directory wearing the session name is not a session", () => {
		// Step's walk keeps a name ending in `.jsonl` whether or not it is a file
		// (`(await readdir(dir)).filter((f) => f.endsWith(".jsonl"))`,
		// `core/session-manager.ts:1685`), and its loader then fails to open the
		// directory. This reader reads dirents and knows the difference, so it does
		// not report a directory as a session file that failed to open: the bucket
		// holds no session, which is the ordinary state a `--<cwd>--` directory is in
		// before its first turn is saved (`getDefaultSessionDir`, `:483-489`).
		withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			const bucket = bucketName("C:\\work\\decoy");
			mkdirSync(join(root, bucket, "decoy.jsonl"), { recursive: true });
			const listing = listStepSessions(home);
			expect(listing.sessions).toEqual([]);
			expect(skipFor(listing.skipped, bucket)).toBe("directory holding no session file");
			expect(skipFor(listing.skipped, "decoy.jsonl")).toBeUndefined();
		});
	});

	test("sessions come back in the name order of the files they live in", () => {
		// The walk reads each directory by name (`directoryEntries` sorts) and that
		// order is the listing's: the order Step's own list is built in, not the order
		// the files happened to be written in.
		withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			const later = writeSession(root, {
				name: fileName(OTHER_ID, 5),
				lines: [header({ id: OTHER_ID }), userEntry("e1", null, "written first", 1)],
			});
			const earlier = writeSession(root, {
				name: fileName(SESSION_ID, 0),
				lines: [header(), userEntry("e1", null, "written second", 1)],
			});
			expect(earlier < later).toBe(true);
			expect(listStepSessions(home).sessions.map((session) => session.path)).toEqual([earlier, later]);
		});
	});

	test("a first prompt split into blocks reads as one line, the blocks apart", () => {
		// Step's preview joins a message's text blocks with a space
		// (`extractTextContent`, `core/session-manager.ts:670-671`), so a title that
		// folded them together would read as a different sentence than the tool's own
		// list shows.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry(
						"e1",
						null,
						[
							{ type: "text", text: "look at" },
							{ type: "text", text: "this thing" },
						],
						1,
					),
				],
			});
			expect(listed(home).title).toBe("look at this thing");
		});
	});

	test("a long name is clipped to one line of sixty characters", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [header(), entry("e1", null, { type: "session_info", name: "n".repeat(90) }, 1)],
			});
			const title = listed(home).title ?? "";
			expect(title).toBe(`${"n".repeat(59)}…`);
			expect(title.length).toBe(60);
		});
	});

	test("the listing's head is bounded: a name inside it is seen, one past it is not", () => {
		// The trade the reader documents rather than hides: a name written past the
		// head is not read. Two files pin the bound at both edges — the name line of
		// the first ends one byte inside the cut, the second one starts *at* it — so a
		// smaller head would lose a name this reader promises to find, and a larger one
		// would find a name its own comment says it cannot.
		const head = 256 * 1024;
		withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			const inside = entry("e3", "e2", { type: "session_info", name: "a name inside the head" }, 3);
			const past = entry("e3", "e2", { type: "session_info", name: "a name past the head" }, 3);
			writeSession(root, {
				name: fileName(SESSION_ID),
				lines: sessionNamingAt(SESSION_ID, inside, head - Buffer.byteLength(inside, "utf8") - 1),
			});
			writeSession(root, {
				name: fileName(OTHER_ID),
				lines: sessionNamingAt(OTHER_ID, past, head),
			});
			expect(listed(home).title).toBe("a name inside the head");
			expect(listed(home, OTHER_ID).title).toBe(`prompt of ${OTHER_ID}`);
		});
	});

	test("every thing passed over is reported with a reason", () => {
		withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			writeSession(root, { lines: [header(), userEntry("e1", null, "a real session", 1)] });
			// A file whose head holds no JSON at all.
			writeRaw(root, join(bucketName(CWD), "not-json.jsonl"), "this is not a session\n");
			// A file whose first JSON line is not a session header.
			writeRaw(root, join(bucketName(CWD), "no-header.jsonl"), `${userEntry("e1", null, "no header", 1)}\n`);
			// A header Step refuses to open: `loadEntriesFromFile` wants a string id.
			writeRaw(
				root,
				join(bucketName(CWD), "no-id.jsonl"),
				`${JSON.stringify({ type: "session", timestamp: iso(0) })}\n`,
			);
			// A bucket Step created when a session started and never filled.
			mkdirSync(join(root, bucketName("C:\\work\\empty")), { recursive: true });
			// A real session whose name wears the wrong case: Step reads back
			// `f.endsWith(".jsonl")` and only that (`:641`, `:825`), so a `.JSONL` file
			// is a file to Step and must not become a session here. Both places the
			// name is tested get one — a bucket's file and a file sitting directly in
			// the session root, which is the other half of the walk.
			writeRaw(
				root,
				join(bucketName(CWD), "LOUD.JSONL"),
				`${header({ id: OTHER_ID })}\n${userEntry("e1", null, "wrong case", 1)}\n`,
			);
			writeRaw(root, "ALSO.JSONL", `${header({ id: THIRD_ID })}\n${userEntry("e1", null, "wrong case here too", 1)}\n`);

			const listing = listStepSessions(home);
			expect(listing.sessions.map((session) => session.id)).toEqual([SESSION_ID]);
			expect(skipFor(listing.skipped, "not-json.jsonl")).toBe("no JSON line in the file's head");
			expect(skipFor(listing.skipped, "no-header.jsonl")).toBe("first entry is not a session header");
			expect(skipFor(listing.skipped, "no-id.jsonl")).toBe("session header with no id");
			expect(skipFor(listing.skipped, bucketName("C:\\work\\empty"))).toBe("directory holding no session file");
			// The rule the whole listing rests on: nothing is passed over in silence.
			expect(listing.skipped.length).toBe(4);
			expect(listing.skipped.every((entry) => entry.reason.trim() !== "")).toBe(true);
			// A file Step would never call a session is not reported as one that failed
			// to be: a note about a file the user never had as a session is noise.
			writeRaw(root, "notes.txt", "not a session either\n");
			expect(skipFor(listStepSessions(home).skipped, "notes.txt")).toBeUndefined();
			expect(skipFor(listStepSessions(home).skipped, "LOUD.JSONL")).toBeUndefined();
			expect(skipFor(listStepSessions(home).skipped, "ALSO.JSONL")).toBeUndefined();
		});
	});

	test("a session the retired tree also holds is read once, and the copy says so", () => {
		withHome((home) => {
			const lines = [header(), userEntry("e1", null, "said once", 1)];
			writeSession(sessionsUnder(canonicalRoot(home)), { lines });
			const retiredPath = writeSession(sessionsUnder(join(home, STEPCODE_LEGACY_DIR)), { lines });
			const listing = listStepSessions(home);
			expect(listing.sessions.map((session) => session.id)).toEqual([SESSION_ID]);
			expect(listing.sessions[0]?.path.startsWith(canonicalRoot(home))).toBe(true);
			expect(skipFor(listing.skipped, fileName(SESSION_ID))).toBe(
				`a copy of the session already found at ${listing.sessions[0]?.path}`,
			);
			expect(retiredPath.startsWith(join(home, STEPCODE_LEGACY_DIR))).toBe(true);
		});
	});

	test("a session root named by the environment is one walk, not a walk and its own copy", () => {
		// `$STEP_CODING_AGENT_SESSION_DIR` is read for *both* roots
		// (`stepSessionsRoot` tests it before the root it was handed, `:154-155`), so
		// when it is set the canonical and the retired root resolve to the same
		// directory. `stepSessionDirs` returns that one directory once
		// (`retired === sessions ? [sessions] : [sessions, retired]`, `:372`); read
		// twice, every session in it comes back a second time and is reported as a
		// copy of itself.
		withHome((home) => {
			setEnv("STEP_CODING_AGENT_SESSION_DIR", join(home, "sessions-here"));
			const path = writeSession(join(home, "sessions-here"), {
				lines: [header(), userEntry("e1", null, "said once", 1)],
				flat: true,
			});
			const listing = listStepSessions(home);
			expect(listing.sessions.map((session) => session.path)).toEqual([path]);
			expect(listing.skipped).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// Reading a v3 session
// ---------------------------------------------------------------------------

describe("reading a v3 session", () => {
	test("the conversation comes back in order, with the entry times as epoch ms", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "first question", 1),
					assistantEntry("e2", "e1", "first answer", 2),
					userEntry("e3", "e2", "second question", 3),
					assistantEntry("e4", "e3", "second answer", 4),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["first question", "first answer", "second question", "second answer"]);
			expect(messagesOf(read.entries).map((message) => message.timestamp)).toEqual([
				epoch(1),
				epoch(2),
				epoch(3),
				epoch(4),
			]);
			// The blocks that are not carried — a tool call, most of all — are what
			// `toolUse` and `aborted` describe, so nothing claims one.
			for (const message of messagesOf(read.entries)) {
				if (message.role === "assistant") expect(message.stopReason).toBe("stop");
			}
			expect(read.notes).toEqual([]);
		});
	});

	test("a message's own time wins over the entry's", () => {
		// `getMessageActivityTime` (`:653-668`) reads the message's numeric stamp
		// first and falls back to the entry's; the two are written by the same run and
		// usually agree, which is exactly why a reader that swapped the order would go
		// unnoticed until a message was stamped by something other than its entry.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					messageEntry("e1", null, { role: "user", content: "stamped late", timestamp: epoch(9) }, 4),
					messageEntry("e2", "e1", { role: "user", content: "stamped by its entry" }, 5),
				],
			});
			const read = readSession(home);
			expect(messagesOf(read.entries).map((message) => message.timestamp)).toEqual([epoch(9), epoch(5)]);
		});
	});

	test("an entry that states no time is dated by the one before it", () => {
		// The stamp carries down the path: it starts at the session's own time
		// (`let stamp = session.startedAt;`, `:301`) and is replaced only by an entry
		// that has one (`const own = entryTime(record.raw); if (own > 0) stamp = own;`,
		// `:307-308`). An entry that states no readable time at all — neither the
		// message's numeric stamp nor the entry's own ISO one, which is what
		// `entryTime` reports as 0 (`:586-591`) — takes the last time the conversation
		// was at, so one bare line cannot re-date everything around it to 1970 and put
		// the session in the wrong order.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "first question", 1),
					assistantEntry("e2", "e1", "an answer", 2),
					'{"type":"message","id":"e3","parentId":"e2","message":{"role":"assistant","content":[{"type":"text","text":"no clock at all"}]}}',
					userEntry("e4", "e3", "and on we go", 4),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["first question", "an answer", "no clock at all", "and on we go"]);
			expect(messagesOf(read.entries).map((message) => message.timestamp)).toEqual([
				epoch(1),
				epoch(2),
				epoch(2),
				epoch(4),
			]);
		});
	});

	test("the session's own events are counted, not imported", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "hello", 1),
					entry("e2", "e1", { type: "model_change", provider: "stepcode", modelId: "step-5-preview" }, 2),
					entry("e3", "e2", { type: "session_info", name: "named" }, 3),
					entry("e4", "e3", { type: "label", targetId: "e1", label: "start" }, 4),
					entry("e5", "e4", { type: "custom", customType: "artifact-index", data: {} }, 5),
					entry("e6", "e5", { type: "custom_message", customType: "todo", content: "a note", display: true }, 6),
					entry("e7", "e6", { type: "thinking_level_change", thinkingLevel: "high" }, 7),
					entry("e8", "e7", { type: "branch_summary", fromId: "e1", summary: "the other branch" }, 8),
					entry("e9", "e8", { type: "something_new" }, 9),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["hello"]);
			expect(read.notes).toEqual([
				{ reason: "model change", count: 1 },
				{ reason: "session name", count: 1 },
				{ reason: "session label", count: 1 },
				{ reason: "extension entry (not in context)", count: 1 },
				{ reason: "extension-injected message", count: 1 },
				{ reason: "thinking level change", count: 1 },
				{ reason: "branch summary of an abandoned branch", count: 1 },
				{ reason: "session event", count: 1 },
			]);
		});
	});

	test("messages this build has no place for are counted by what they were", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "run it", 1),
					messageEntry(
						"e2",
						"e1",
						{
							role: "bashExecution",
							command: "ls",
							output: "a.txt",
							exitCode: 0,
							cancelled: false,
							truncated: false,
							timestamp: epoch(2),
						},
						2,
					),
					messageEntry("e3", "e2", { role: "toolResult", toolCallId: "t1", content: "ok", timestamp: epoch(3) }, 3),
					messageEntry(
						"e4",
						"e3",
						{ role: "custom", customType: "todo", content: "a note", display: true, timestamp: epoch(4) },
						4,
					),
					messageEntry(
						"e5",
						"e4",
						{ role: "hookMessage", customType: "old", content: "older", timestamp: epoch(5) },
						5,
					),
					messageEntry(
						"e6",
						"e5",
						{ role: "branchSummary", summary: "the other branch", fromId: "e1", timestamp: epoch(6) },
						6,
					),
					messageEntry(
						"e7",
						"e6",
						{ role: "compactionSummary", summary: "what came before", tokensBefore: 900, timestamp: epoch(7) },
						7,
					),
					messageEntry("e8", "e7", { role: "unknownRole", timestamp: epoch(8) }, 8),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["run it"]);
			expect(read.notes).toEqual([
				{ reason: "`!` shell command", count: 1 },
				{ reason: "tool result", count: 1 },
				{ reason: "extension-injected message", count: 2 },
				{ reason: "branch summary of an abandoned branch", count: 1 },
				{ reason: "compaction summary", count: 1 },
				{ reason: "message with an unknown role", count: 1 },
			]);
		});
	});

	test("an attachment is imported, a reasoning block and a tool call are counted", () => {
		withHome((home) => {
			const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, [{ type: "text", text: "look at this" }, image], 1),
					userEntry("e2", "e1", [image], 2),
					userEntry("e3", "e2", [{ type: "text", text: "   " }], 3),
					userEntry("e4", "e3", "", 4),
					userEntry("e5", "e4", [{ type: "audio", data: "...." }], 5),
					messageEntry(
						"e6",
						"e5",
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "hmm", thinkingSignature: "opaque" },
								{ type: "text", text: "here it is" },
								{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
								{ type: "audio", data: "...." },
							],
							stopReason: "toolUse",
							timestamp: epoch(6),
						},
						6,
					),
					// A user message whose text is only whitespace carries nothing this build
					// can send, so it is an empty message rather than a prompt made of spaces.
					// One place this reader is stricter than the tool: Step steps over a
					// message whose *extracted* text is falsy (`if (!textContent) continue;`,
					// `core/session-manager.ts:731`) and would preview this one as blank.
					userEntry("e7", "e6", "   ", 7),
					// An image with the bytes but no MIME type is not the image shape either
					// build can carry: what crosses over is `{type, mimeType, data}`, and a
					// block missing a third of that is an attachment with no place in this one.
					userEntry("e8", "e7", [{ type: "image", data: "aGVsbG8=" }], 8),
					// An assistant turn whose only text is blank is a turn with no answer in it:
					// the blocks that would have filled it are the ones this reader counts.
					messageEntry(
						"e9",
						"e8",
						{ role: "assistant", content: [{ type: "text", text: "   " }], stopReason: "stop", timestamp: epoch(9) },
						9,
					),
				],
			});
			const read = readSession(home);
			const messages = messagesOf(read.entries);
			// The prompt is imported whole: text and image are the same two shapes in
			// both builds, so nothing has to be invented to carry them.
			expect(messages[0]?.content).toEqual([
				{ type: "text", text: "look at this" },
				{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
			]);
			expect(messages[1]?.content).toEqual([{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }]);
			// Three survive — the prompt, the image on its own, and the assistant's
			// answer — and the image without a MIME type is not a fourth.
			expect(messages.length).toBe(3);
			expect(messages.flatMap((message) => imagesOf(message.content))).toEqual([
				{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
				{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
			]);
			expect(textsOf(read.entries)).toEqual(["look at this", "", "here it is"]);
			// The counts the dropped messages leave: e3, e5 and e8 carry no text at all,
			// e4 and e7 are empty user messages, e5 and e8 dropped an attachment that is
			// not text, e6 counted a reasoning block and a tool call, and e9 is an
			// assistant turn whose only text is blank.
			expect(read.notes).toEqual([
				{ reason: "user message with no text", count: 3 },
				{ reason: "empty user message", count: 2 },
				{ reason: "attachment that is not text", count: 2 },
				{ reason: "reasoning block", count: 1 },
				{ reason: "tool call", count: 1 },
				{ reason: "content block that is not text", count: 1 },
				{ reason: "assistant message with no text", count: 1 },
			]);
		});
	});

	test("a branch the user left is counted, not imported", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "the question", 1),
					assistantEntry("e2", "e1", "the answer", 2),
					userEntry("e3", "e2", "the road not taken", 3),
					userEntry("e4", "e2", "the road taken", 4),
					assistantEntry("e5", "e4", "the reply", 5),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["the question", "the answer", "the road taken", "the reply"]);
			expect(read.notes).toEqual([{ reason: "message on an abandoned branch", count: 1 }]);
		});
	});

	test("a session that continues another one says whose words are in it", () => {
		withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			// `/fork` and `/branch` write a new file whose header names the file it came
			// from, then copy that file's entries in (`core/session-manager.ts:1620`).
			// Nothing in the bytes marks where the copy ends, so the whole session is
			// imported and the note says whose words are in it.
			writeSession(root, {
				lines: [
					header({ parentSession: "C:\\step\\sessions\\the-other-file.jsonl" }),
					userEntry("e1", null, "the copied words", 1),
				],
			});
			// `/new` writes the same field naming the session the user was in before
			// (`:1443`), and a header that states an empty one continues nothing.
			writeSession(root, {
				name: fileName(OTHER_ID, 1),
				lines: [header({ id: OTHER_ID, parentSession: "" }), userEntry("e1", null, "a fresh start", 1)],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["the copied words"]);
			expect(read.notes).toEqual([
				{
					reason:
						"continues C:\\step\\sessions\\the-other-file.jsonl (a fork or branch copies its words into this file)",
					count: 1,
				},
			]);
			const other = readSession(home, OTHER_ID);
			expect(textsOf(other.entries)).toEqual(["a fresh start"]);
			expect(other.notes).toEqual([]);
		});
	});

	test("a compaction stands in for the entries before it, up to the ones it keeps", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "summarised away", 1),
					assistantEntry("e2", "e1", "also summarised away", 2),
					userEntry("e3", "e2", "kept question", 3),
					assistantEntry("e4", "e3", "kept answer", 4),
					compactionEntry("e5", "e4", { summary: "what came before", firstKeptEntryId: "e3", tokensBefore: 4200 }, 5),
					userEntry("e6", "e5", "after the summary", 6),
					assistantEntry("e7", "e6", "and its answer", 7),
				],
			});
			const read = readSession(home);
			expect(read.entries[0]).toEqual({ kind: "compaction", summary: "what came before", preTokens: 4200 });
			expect(textsOf(read.entries)).toEqual(["kept question", "kept answer", "after the summary", "and its answer"]);
			expect(read.notes).toEqual([{ reason: "replaced by the last compaction summary", count: 2 }]);
		});
	});

	test("only the last compaction on the path counts", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "the first summary's subject", 1),
					compactionEntry("e2", "e1", { summary: "the older summary", firstKeptEntryId: "e1", tokensBefore: 700 }, 2),
					userEntry("e3", "e2", "the second summary's subject", 3),
					compactionEntry("e4", "e3", { summary: "the newer summary", firstKeptEntryId: "e3", tokensBefore: 1500 }, 4),
					userEntry("e5", "e4", "still in context", 5),
				],
			});
			const read = readSession(home);
			const compactions = read.entries.filter((entry) => entry.kind === "compaction");
			expect(compactions).toEqual([{ kind: "compaction", summary: "the newer summary", preTokens: 1500 }]);
			expect(textsOf(read.entries)).toEqual(["the second summary's subject", "still in context"]);
			// The older compaction is one of the entries the newer one stands in for,
			// which is why the count is two and not one.
			expect(note(read, "replaced by the last compaction summary")).toBe(2);
		});
	});

	test("a boundary that is not on the path keeps nothing", () => {
		// `firstKeptEntryId` is resolved by walking the path, so a boundary on an
		// abandoned branch matches nothing and the summary stands in for everything
		// before it — `buildContextEntries`' answer, reached by never finding a
		// match (`core/session-manager.ts:445-452`). A reader that treated the
		// boundary as a position instead would keep entries the file says were
		// summarised away.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "summarised away", 1),
					userEntry("e2", "e1", "on the abandoned branch", 2),
					userEntry("e3", "e1", "kept only if the boundary matched", 3),
					compactionEntry("e4", "e3", { summary: "the summary", firstKeptEntryId: "e2", tokensBefore: 300 }, 4),
					userEntry("e5", "e4", "after the summary", 5),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["after the summary"]);
			expect(note(read, "replaced by the last compaction summary")).toBe(2);
			expect(note(read, "message on an abandoned branch")).toBe(1);
		});
	});

	test("a compaction with no summary imports as nothing", () => {
		// Step's own projection emits a message for a compaction only when its
		// summary is non-empty (`if (entry.summary)`, `:404-406`), so an empty one is
		// counted rather than pushed as an entry that would carry no words.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "kept", 1),
					compactionEntry("e2", "e1", { summary: "", firstKeptEntryId: "e1", tokensBefore: 100 }, 2),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["kept"]);
			expect(read.notes).toEqual([{ reason: "compaction with no summary", count: 1 }]);
		});
	});

	// The bound is the point of this test as much as the assertion is: a reader that
	// follows the loop spins forever, and a test that spins forever is neither green
	// nor red — it hangs the file, and a hang reads as a pass if nobody is watching
	// the clock. A bound *inside* the spinning process cannot end it: the loop is
	// synchronous, so it never yields the thread a timer would need, and `bun test`'s
	// own per-test timeout never fires either (measured: the whole run sat for three
	// minutes and printed no verdict at all). So the read is given a process to spin
	// in — `readInChild` below — and the deadline is the spawn's. With the guard in
	// place the child answers in a quarter of a second; without it the child is
	// killed at the deadline and this test fails on the exit code, with a summary.
	test("an entry whose parent chain loops is stopped, not followed forever", () => {
		// `buildSessionPath` walks `parentId` without a guard, so a hand-edited file
		// that points an entry back at its own descendant is a reader that never
		// returns. A migrator that hangs on one damaged file is worse than one that
		// reports it.
		withHome((home) => {
			const path = writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [header(), userEntry("e1", "e2", "the loop", 1), userEntry("e2", "e1", "and its other half", 2)],
			});
			const read = readInChild(home, path);
			expect(read.texts).toEqual(["the loop", "and its other half"]);
			expect(read.notes).toEqual([{ reason: "entry whose parent chain loops back on itself", count: 1 }]);
		});
	});
});

// ---------------------------------------------------------------------------
// Reading a v1 session
// ---------------------------------------------------------------------------

describe("reading a v1 session", () => {
	/**
	 * The v1 bytes, as the real fixture has them: a header with `version: 1` and an
	 * id, three question-and-answer pairs with no ids of any kind on their lines,
	 * ISO timestamps inside the message *and* beside it, and a `model_change` entry
	 * last — which is what makes such a file's leaf a line that holds no message.
	 */
	const beforeCompaction = [
		v1Header("synthetic-session", "synthetic-workspace"),
		v1UserLine("synthetic user message 001", 1),
		v1AssistantLine("synthetic assistant response 001", 1),
		v1UserLine("synthetic user message 002", 2),
		v1AssistantLine("synthetic assistant response 002", 2),
		v1UserLine("synthetic user message 003", 3),
		v1AssistantLine("synthetic assistant response 003", 3),
		v1ModelChangeLine(3599),
	];

	test("the fixture bytes are the bytes Step's own v1 fixture has", () => {
		expect(beforeCompaction[0]).toBe(
			'{"type":"session","id":"synthetic-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"synthetic-workspace","version":1}',
		);
		expect(beforeCompaction[1]).toBe(
			'{"type":"message","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"synthetic user message 001","timestamp":"2026-01-01T00:00:01.000Z"}}',
		);
		expect(beforeCompaction.at(-1)).toContain('"type":"model_change"');
	});

	test("a v1 file's entries are chained, so the whole conversation comes back", () => {
		// Without the chain every entry has no parent, the leaf is the only reachable
		// entry, and a three-turn conversation imports as one message — which is the
		// failure this test exists to catch, and the reason `migrateV1ToV2`
		// (`:231-257`) is mirrored rather than skipped as an old format.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				name: fileName("synthetic-session"),
				lines: beforeCompaction,
			});
			expect(listed(home, "synthetic-session").cwd).toBe("synthetic-workspace");
			const read = readSession(home, "synthetic-session");
			expect(textsOf(read.entries)).toEqual([
				"synthetic user message 001",
				"synthetic assistant response 001",
				"synthetic user message 002",
				"synthetic assistant response 002",
				"synthetic user message 003",
				"synthetic assistant response 003",
			]);
			// The message's own stamp is an ISO string in this format, so the time comes
			// from the entry beside it — `getMessageActivityTime`'s fallback (`:653-668`).
			expect(messagesOf(read.entries).map((message) => message.timestamp)).toEqual([
				epoch(1),
				epoch(1),
				epoch(2),
				epoch(2),
				epoch(3),
				epoch(3),
			]);
			expect(read.notes).toEqual([{ reason: "model change", count: 1 }]);
		});
	});

	test("a header that states no version is a v1 file", () => {
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					JSON.stringify({ type: "session", id: SESSION_ID, timestamp: iso(0), cwd: CWD }),
					v1UserLine("no version stated", 1),
					v1AssistantLine("still chained", 2),
				],
			});
			expect(textsOf(readSession(home).entries)).toEqual(["no version stated", "still chained"]);
		});
	});

	test("a v1 compaction's firstKeptEntryIndex counts the header, as Step's migration reads it", () => {
		// `migrateV1ToV2` converts the index against the *file's* entries, header
		// included (`:245-255`), so index 1 is the first entry after the header and
		// index 0 is the header itself — which converts to no boundary at all, since
		// the migration refuses to name a `session` entry. Read as an index into the
		// entries, the boundary would move by a message in every compacted v1
		// session.
		withHome((home) => {
			const v1Compaction = (index: number, second: number): string =>
				`{"type":"compaction","timestamp":"${iso(second)}","summary":"the summary","firstKeptEntryIndex":${index},"tokensBefore":800}`;
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					v1Header(),
					v1UserLine("m1", 1),
					v1AssistantLine("m2", 2),
					v1UserLine("m3", 3),
					v1AssistantLine("m4", 4),
					v1Compaction(3, 5),
					v1UserLine("m5", 6),
					v1AssistantLine("m6", 7),
				],
			});
			const read = readSession(home);
			// Index 3 is the third entry after the header, `m3`: everything before it —
			// `m1` and `m2` — is what the summary replaced.
			expect(textsOf(read.entries)).toEqual(["m3", "m4", "m5", "m6"]);
			expect(note(read, "replaced by the last compaction summary")).toBe(2);
			// Index 1 is `m1`, so nothing before the first compaction is replaced; index
			// 0 is the header, which names no boundary at all and therefore replaces
			// everything before it — `m1`, the older compaction and `m5` alike.
			writeSession(sessionsUnder(canonicalRoot(home)), {
				name: fileName(OTHER_ID),
				lines: [
					v1Header(OTHER_ID),
					v1UserLine("m1", 1),
					v1Compaction(1, 2),
					v1UserLine("m5", 3),
					v1Compaction(0, 4),
					v1UserLine("m6", 5),
				],
			});
			// Two compactions, and the last one names the header: only `m6` survives.
			const second = readSession(home, OTHER_ID);
			expect(textsOf(second.entries)).toEqual(["m6"]);
			expect(note(second, "replaced by the last compaction summary")).toBe(3);
		});
	});
});

// ---------------------------------------------------------------------------
// Files that cannot be read
// ---------------------------------------------------------------------------

describe("a file that cannot be read", () => {
	test("a file with no header is an error, not an empty conversation", () => {
		// Three files no reader can open, and the three ways a session file has no
		// header: every line was written and none of them says `session` (`:258`), and
		// the two heads with no parsed entry at all — an empty file and one holding
		// only whitespace (`:266`, the branch reached after the loop). The last two
		// are the ones that make "no header" mean *error*, and a reader that answered
		// them with an empty conversation would be telling the user their session was
		// empty rather than unreadable.
		withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			const file = (name: string, text: string) => {
				const path = writeRaw(root, name, text);
				return readStepSession({ path, id: SESSION_ID, cwd: null, title: null, startedAt: 0 });
			};
			expect(file("no-header.jsonl", `${userEntry("e1", null, "no header at all", 1)}\n`)).toEqual({
				error: "session has no readable header",
			});
			expect(file("empty.jsonl", "")).toEqual({ error: "session has no readable header" });
			expect(file("blank.jsonl", "\n \n\t\n")).toEqual({ error: "session has no readable header" });
		});
	});

	test("a file that cannot be opened is an error, not a throw", () => {
		withHome((home) => {
			const path = join(sessionsUnder(canonicalRoot(home)), "gone.jsonl");
			expect(readStepSession({ path, id: SESSION_ID, cwd: null, title: null, startedAt: 0 })).toEqual({
				error: "session transcript could not be read",
			});
		});
	});

	test("a damaged line costs the line, not the session", () => {
		// The line is written by an append that was cut off, which is what a killed
		// run leaves (`:558` appends the missing newline on the next load). Step skips
		// it (`parseSessionEntryLine`, `:509-517`) and so does this reader — the whole
		// conversation is not the price of one truncated write.
		withHome((home) => {
			writeSession(sessionsUnder(canonicalRoot(home)), {
				lines: [
					header(),
					userEntry("e1", null, "before the cut", 1),
					'{"type":"message","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:02.',
					assistantEntry("e3", "e1", "after the cut", 3),
				],
			});
			const read = readSession(home);
			expect(textsOf(read.entries)).toEqual(["before the cut", "after the cut"]);
			expect(read.notes).toEqual([{ reason: "malformed line", count: 1 }]);
		});
	});

	test("reading a tree leaves every byte of it where it was", () => {
		const home = withHome((home) => {
			const root = sessionsUnder(canonicalRoot(home));
			writeSession(root, {
				lines: [
					header(),
					userEntry("e1", null, "hello", 1),
					compactionEntry("e2", "e1", { summary: "a summary", firstKeptEntryId: "e1", tokensBefore: 100 }, 2),
				],
			});
			writeRaw(root, join(bucketName(CWD), "not-json.jsonl"), "not a session\n");
		});
		const before = snapshotTree(home);
		const listing = listStepSessions(home);
		for (const session of listing.sessions) readStepSession(session);
		expect(snapshotTree(home)).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// The migration run
// ---------------------------------------------------------------------------

/**
 * The environment variables *other* sources' trees hang on, lent back.
 *
 * `runMigration` reads every source before it plans anything, so on a machine
 * with `$CODEX_HOME` or `$GROK_HOME` set a run pinned to Step Code would still
 * read a real install: read-only either way, but the run's cost and its report
 * would depend on the developer's machine rather than on the fixtures. The
 * variables that move Step's own tree are borrowed by `withHome` already.
 */
function borrowSourceTrees(): void {
	for (const name of [
		"CODEX_HOME",
		"DSH_HOME",
		"GROK_HOME",
		"KIMI_CODE_HOME",
		"KIMI_SHARE_DIR",
		"MINIMAX_DATA_DIR",
		"MAVIS_DATA_DIR",
		"STEPCODE_STORAGE_ROOT_DIR",
	]) {
		setEnv(name, undefined);
	}
}

/** A throwaway home for a whole run, with every other source's tree lent back. */
function withRunHome(body: (home: string) => void): string {
	borrowSourceTrees();
	return withHome(body);
}

/**
 * A working directory that exists, since the run's own narrowing checks.
 *
 * `narrowCandidates` drops every candidate whose recorded directory is not on
 * disk and reports it as a note instead, so a fixture recorded as living in
 * `C:\work\demo` never reaches the planner — which is true of every fixture in
 * the file above, and is why the tests that only exercise the reader can use a
 * path that does not exist and these cannot.
 */
function projectDir(home: string, name = "demo"): string {
	const dir = join(home, "work", name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** The session file a converted Step session is written to, spelled out. */
function expectedHistoryPath(project: string, home: string): string {
	return join(
		home,
		".labunbun",
		"projects",
		project.replace(/[:\\/]/g, "-"),
		`${importedSessionId("step-code", SESSION_ID)}.jsonl`,
	);
}

/** The history writes of a run, as home-relative labels. */
function historyWrites(result: RunMigrationResult, home: string): string[] {
	return result.plan.writes
		.filter((write) => write.kind === "history")
		.map((write) => write.path.replace(/\\/g, "/").replace(home.replace(/\\/g, "/"), "~"))
		.sort();
}

/** The plan items whose `from` label matches, so an assertion can look at one. */
function planItems(result: RunMigrationResult, from: string | RegExp): Array<{ action: string; detail: string }> {
	return result.plan.items.filter((item) => (typeof from === "string" ? item.from === from : from.test(item.from)));
}

/**
 * A session with one question, one answer, and a name the user gave it.
 *
 * The rename sits between them so the entry chain is the one Step writes
 * (`e1 → e2 → e3`): a `session_info` entry is on the path, not off it, and a
 * reader that followed only the message entries would still see both messages
 * while one that dropped the chain's middle would lose the answer.
 */
function conversation(cwd: string): SessionFixture {
	return {
		// The bucket the session's own directory would have put it in, rather than the
		// module's `CWD`: a fixture in the wrong bucket is one the reader still finds
		// (it never reads the bucket name), and the point of these tests is the run,
		// not the reader's tolerance for a tree Step would not have written.
		bucket: bucketName(cwd),
		lines: [
			header({ cwd }),
			userEntry("e1", null, "what the user typed", 1),
			entry("e2", "e1", { type: "session_info", name: "Fix the parser" }, 2),
			assistantEntry("e3", "e2", "what the model said", 3),
		],
	};
}

describe("the Step source in a migration run", () => {
	test("a session is offered with the name the user gave it and the directory its header records", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			const path = writeSession(sessionsUnder(canonicalRoot(home)), conversation(project));
			const listing = listHistory("step-code", home, { cwd: project, scope: "all" });
			expect(listing.candidates).toHaveLength(1);
			const [candidate] = listing.candidates;
			expect(candidate.source).toBe("step-code");
			expect(candidate.sourceId).toBe(SESSION_ID);
			// The directory and the name are the *header's* — Step's bucket names are a
			// lossy encoding with no decoder, so a reader that undid them would be
			// guessing, and a name is the last `session_info` rather than the prompt at
			// the top of the file.
			expect(candidate.cwd).toBe(project);
			expect(candidate.title).toBe("Fix the parser");
			expect(candidate.startedAt).toBe(T0);
			expect(candidate.path).toBe(path);
			// Nothing was wrong with this listing, so it says nothing.
			expect(listing.notes).toEqual([]);
		});
	});

	test("a session nobody named is offered under its first prompt, and one with no directory is a note", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			const root = sessionsUnder(canonicalRoot(home));
			writeSession(root, {
				name: fileName(SESSION_ID),
				lines: [header({ cwd: project }), userEntry("e1", null, "the opening prompt", 1)],
			});
			writeSession(root, {
				name: fileName(OTHER_ID, 9),
				lines: [header({ id: OTHER_ID, cwd: undefined }), userEntry("e1", null, "in no project", 1)],
			});
			const all = listHistory("step-code", home, { cwd: project, scope: "all" });
			expect(all.candidates.map((candidate) => [candidate.sourceId, candidate.cwd, candidate.title])).toEqual([
				[SESSION_ID, project, "the opening prompt"],
			]);
			// The listing hands a header with no directory over as an empty one, and the
			// run's own narrowing turns that into a note rather than a session filed
			// under no project at all: `""` is not a directory, and importing a session
			// into a bucket named after nothing would hide it from the project it ran in.
			expect(all.notes).toEqual([{ reason: "no working directory recorded", count: 1 }]);
			const here = listHistory("step-code", home, { cwd: project, scope: "cwd" });
			expect(here.candidates.map((candidate) => candidate.sourceId)).toEqual([SESSION_ID]);
		});
	});

	test("the scope keeps this project's sessions, counts the others, and names a directory that is gone", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			const other = projectDir(home, "other");
			const root = sessionsUnder(canonicalRoot(home));
			writeSession(root, {
				name: fileName(SESSION_ID),
				lines: [header({ cwd: project }), userEntry("e1", null, "in this project", 1)],
			});
			// Started later, so the newest-first order is the one the report uses.
			writeSession(root, {
				name: fileName(OTHER_ID, 9),
				lines: [header({ id: OTHER_ID, cwd: other, timestamp: iso(9) }), userEntry("e1", null, "elsewhere", 1)],
			});
			// A third session whose project was deleted since. It is not something to
			// guess a directory for: the transcript says where it ran and that place is
			// gone, so the run reports it instead of filing it under the home directory.
			writeSession(root, {
				name: fileName(THIRD_ID, 5),
				lines: [header({ id: THIRD_ID, cwd: join(home, "work", "deleted") })],
			});
			const all = listHistory("step-code", home, { cwd: project, scope: "all" });
			expect(all.candidates.map((candidate) => candidate.sourceId)).toEqual([OTHER_ID, SESSION_ID]);
			expect(all.notes).toEqual([{ reason: "working directory no longer exists", count: 1 }]);
			const here = listHistory("step-code", home, { cwd: project, scope: "cwd" });
			expect(here.candidates.map((candidate) => candidate.sourceId)).toEqual([SESSION_ID]);
			expect(here.notes).toEqual([
				{ reason: "working directory no longer exists", count: 1 },
				{ reason: 'another project (scope is "cwd")', count: 1 },
			]);
		});
	});

	test("the whole conversation is written into the project it ran in, and it resumes there", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			writeSession(sessionsUnder(canonicalRoot(home)), conversation(project));
			const result = runMigration({ home, from: "step-code", only: ["history"], historyScope: "all", apply: true });
			expect(result.error).toBeUndefined();
			expect(historyWrites(result, home)).toEqual([
				`~/.labunbun/projects/${project.replace(/[:\\/]/g, "-")}/${importedSessionId("step-code", SESSION_ID)}.jsonl`,
			]);
			const path = result.plan.writes.find((write) => write.kind === "history")?.path ?? "";
			expect(path).toBe(expectedHistoryPath(project, home));
			const store = SessionStore.load(path);
			expect(store.contextMessages().map(textOf)).toEqual(["what the user typed", "what the model said"]);
			// The header is what makes the import a session rather than a pile of lines:
			// the project, the time it started and the id `--continue` looks it up by.
			const header = store.linearEntries()[0];
			expect(header.type === "header" && header.cwd).toBe(project);
			expect(header.type === "header" && header.createdAt).toBe(T0);
			expect(header.type === "header" && header.sessionId).toBe(importedSessionId("step-code", SESSION_ID));
			// The line the user reads: the name they gave it, the count of entries, and
			// the fact that this one can be picked up where it left off.
			const [item] = planItems(result, /^Step Code session /);
			expect(item.action).toBe("map");
			expect(item.detail).toBe("transcript with 2 entries — resumable with --continue");
			expect(planItems(result, `Step Code session ${SESSION_ID} — Fix the parser`)).toHaveLength(1);
			// The rename itself is not an entry, and the reader says so rather than
			// dropping it silently — the line the plan prints is the reader's own note.
			const [note] = planItems(result, "Step Code history");
			expect(note.action).toBe("skip");
			expect(note.detail).toBe("session name — 1 turned away");
		});
	});

	test("a second run keeps the session it already wrote", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			writeSession(sessionsUnder(canonicalRoot(home)), conversation(project));
			const first = runMigration({ home, from: "step-code", only: ["history"], historyScope: "all", apply: true });
			const path = expectedHistoryPath(project, home);
			const bytes = readFileSync(path, "utf8");
			const second = runMigration({ home, from: "step-code", only: ["history"], historyScope: "all", apply: true });
			// Kept, and *said* to be kept: ids are derived from the source session's id, so
			// importing the same session twice names the same file and the second run has
			// nothing to do.
			const [item] = planItems(second, /^Step Code session /);
			expect(item.action).toBe("skip");
			expect(item.detail).toBe("already imported — kept (use --force to overwrite)");
			expect(readFileSync(path, "utf8")).toBe(bytes);
			expect(first.plan.writes.filter((write) => write.kind === "history")).toHaveLength(1);
			expect(second.plan.writes.filter((write) => write.kind === "history")).toHaveLength(0);
		});
	});

	test("a file that is not a session is turned away with its reason, and the run carries the reason", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			const root = sessionsUnder(canonicalRoot(home));
			writeSession(root, conversation(project));
			// A file whose first line is a message rather than a header: something a
			// reader has to refuse, because there is no session id to file it under.
			writeRaw(join(root, bucketName(project)), "stray.jsonl", `${userEntry("e1", null, "no header here", 1)}\n`);
			const listing = listHistory("step-code", home, { cwd: project, scope: "all" });
			expect(listing.candidates.map((candidate) => candidate.sourceId)).toEqual([SESSION_ID]);
			expect(listing.notes).toEqual([{ reason: "first entry is not a session header", count: 1 }]);
			const result = runMigration({ home, from: "step-code", only: ["history"], historyScope: "all", apply: false });
			const [note] = planItems(result, "Step Code history");
			expect(note.action).toBe("skip");
			expect(note.detail).toBe("first entry is not a session header — 1 turned away");
		});
	});

	test("a session that went away between the listing and the read is reported, not guessed at", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			const root = sessionsUnder(canonicalRoot(home));
			const path = writeSession(root, conversation(project));
			const listing = listHistory("step-code", home, { cwd: project, scope: "all" });
			rmSync(path);
			const read = readHistory("step-code", home, listing.candidates);
			// The candidate is answered with why it came to nothing: "nothing to import"
			// would be a claim about a conversation this reader never managed to open.
			expect(read.sessions).toEqual([]);
			expect(read.notes).toEqual([{ reason: "session is no longer on disk", count: 1 }]);
		});
	});

	test("Step's ↑ list is not on disk, and the run says so instead of staying silent", () => {
		withRunHome((home) => {
			const project = projectDir(home);
			writeSession(sessionsUnder(canonicalRoot(home)), conversation(project));
			const absent = readPromptHistory("step-code", home, { cwd: project, scope: "all", limit: 100 });
			expect(absent.absent).toBe(
				"Step keeps its ↑ recall list in memory only — the editor holds the last 100 prompts and never writes them " +
					"to a file — so there is nothing to read here for any home, and the prompts you sent come across with " +
					"their sessions",
			);
			expect(absent.seen).toBe(0);
			expect(absent.entries).toEqual([]);
			expect(absent.notes).toEqual([]);
			expect(absent.truncated).toBe(false);
			const result = runMigration({ home, from: "step-code", only: ["history"], historyScope: "all", apply: true });
			const [item] = planItems(result, "Step Code prompt history");
			expect(item.action).toBe("skip");
			expect(item.detail).toBe(absent.absent ?? "");
			// Nothing is merged into the recall list: there was nothing to read, and a
			// write with no entries would be a file rewritten for no reason.
			expect(result.plan.writes.filter((write) => write.kind === "prompt-history")).toHaveLength(0);
		});
	});

	test("reading the source leaves it exactly as it was", () => {
		const home = withRunHome((home) => {
			const project = projectDir(home);
			const other = projectDir(home, "other");
			const root = sessionsUnder(canonicalRoot(home));
			writeSession(root, conversation(project));
			writeSession(root, { name: fileName(OTHER_ID, 9), lines: [header({ id: OTHER_ID, cwd: other })] });
			writeRaw(join(root, bucketName(project)), "stray.jsonl", "not a session\n");
		});
		const project = join(home, "work", "demo");
		const root = sessionsUnder(canonicalRoot(home));
		const before = snapshotTree(root);
		listHistory("step-code", home, { cwd: project, scope: "all" });
		const listing = listHistory("step-code", home, { cwd: project, scope: "all" });
		readHistory("step-code", home, listing.candidates);
		runMigration({ home, from: "step-code", only: ["history"], historyScope: "all", apply: true });
		// The whole tree — buckets, session files and the file that is not a session —
		// is byte for byte what it was, mtimes included: this importer reads the user's
		// running install, and a read that touched it would be a write to a live tool.
		expect(snapshotTree(root)).toEqual(before);
	});
});
