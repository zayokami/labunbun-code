/**
 * What a killed process leaves behind in a session file.
 *
 * The session file is append-only, one JSON line per entry, written as the
 * conversation happens — so the shape of a crash is decided by where in that
 * file the process stopped. An `appendFileSync` that is interrupted can leave a
 * line with a beginning and no end, and the reader's answer to that line is the
 * whole of this file's contract: the damaged line costs itself, the entries
 * written before it survive, and the chain they form still reaches the header.
 * A reader that lost the chain would hand the model a conversation with no
 * beginning.
 *
 * The interruption here is a real SIGKILL against a child that is appending in
 * a loop, not a mocked write: this is the one claim in the atomicity work that
 * a mock cannot establish, because what is being asserted is what the kernel
 * and the filesystem leave on disk when the process stops existing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionStore, sanitizeCwd } from "../src/session-store.ts";

const roots: string[] = [];
function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}
process.on("exit", () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Payload per message. Large enough that one append is several writes. */
const MESSAGE_CHARS = 4_000;

/** How long the appender gets to produce a file worth killing, before it is called stalled. */
const APPEND_BUDGET_MS = 15_000;

/** The project directory a store started with this cwd and home lands in. */
function projectDir(home: string, cwd: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd));
}

/** How much the child has written so far — 0 while its directory does not exist. */
function bytesWritten(dir: string): number {
	try {
		const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		return names.length === 1 ? statSync(join(dir, names[0] as string)).size : 0;
	} catch {
		return 0;
	}
}

/**
 * Start a child that appends messages to a fresh session for as long as it
 * lives, wait until it has written real content, then kill it with SIGKILL.
 *
 * The wait is on the file, not on a timer: a kill that lands before the first
 * append produces a file with nothing to lose, which would pass every assertion
 * below while testing nothing. Killing *after* the file is big still lands
 * mid-append — the child never stops writing.
 */
async function killMidAppend(cwd: string, home: string): Promise<string> {
	const script = `
		const { SessionStore } = await import("./src/session-store.ts");
		const store = SessionStore.startNew(${JSON.stringify(cwd)}, ${JSON.stringify(home)});
		let n = 0;
		for (;;) {
			store.appendMessage({
				role: "user",
				content: "message " + n + " " + "m".repeat(${MESSAGE_CHARS}),
				timestamp: Date.now(),
			});
			n++;
		}
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		stdin: "ignore",
		// The child never finishes, so nothing reads its pipes to EOF.
		stdout: "ignore",
		stderr: "ignore",
	});

	const dir = projectDir(home, cwd);
	const deadline = Date.now() + APPEND_BUDGET_MS;
	for (;;) {
		const size = bytesWritten(dir);
		if (size > 16 * 1024) break;
		if (Date.now() > deadline) {
			proc.kill("SIGKILL");
			await proc.exited;
			throw new Error(`the appender wrote ${size} bytes in ${APPEND_BUDGET_MS}ms; nothing to kill it mid-write`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	proc.kill("SIGKILL");
	await proc.exited;

	const files = readdirSync(dir);
	expect(files).toHaveLength(1);
	return join(dir, files[0] as string);
}

describe("a session file whose writer was killed mid-append", () => {
	// The real kill above does not reliably tear a line: one `appendFileSync` of
	// a few kilobytes lands whole or not at all, so a run can go by without ever
	// producing the residue this file is about. The residue is therefore pinned
	// directly as well — the bytes a kill between two writes of one append would
	// leave — so the reader's half of the contract is exercised on every run
	// rather than whenever the platform happens to interrupt a write.
	test("a torn last line costs itself and nothing above it", () => {
		const cwd = scratch("lbb-crash-torn-cwd-");
		const home = scratch("lbb-crash-torn-home-");
		const store = SessionStore.startNew(cwd, home);
		for (let i = 0; i < 5; i++) store.appendMessage({ role: "user", content: `message ${i}`, timestamp: 1 });

		const whole = readFileSync(store.path, "utf8");
		const lastLineStart = whole.lastIndexOf("\n", whole.length - 2) + 1;
		const lastLine = whole.slice(lastLineStart);
		writeFileSync(
			store.path,
			`${whole.slice(0, lastLineStart)}${lastLine.slice(0, Math.floor(lastLine.length / 2))}`,
			"utf8",
		);

		const loaded = SessionStore.load(store.path);
		// The interrupted entry is gone — it was never written whole — and it is
		// the only one that is.
		expect(loaded.skippedLines).toBe(1);
		const texts = loaded.messages().map((message) => (typeof message.content === "string" ? message.content : ""));
		expect(texts).toEqual(["message 0", "message 1", "message 2", "message 3"]);
		const chain = loaded.linearEntries();
		expect(chain[0]?.type).toBe("header");
		expect(chain.length).toBe(loaded.entries.length);
	});

	test("costs at most the line being written, and the chain above it still holds", async () => {
		const cwd = scratch("lbb-crash-cwd-");
		const home = scratch("lbb-crash-home-");
		const path = await killMidAppend(cwd, home);

		// Nothing but the session file: a killed appender leaves no temp file and no
		// partial sibling for the next reader to trip over.
		expect(readdirSync(projectDir(home, cwd))).toEqual([basename(path)]);

		const text = readFileSync(path, "utf8");
		const loaded = SessionStore.load(path);

		// The kill landed on real content, so the assertions below have something
		// to lose.
		expect(loaded.entries.length).toBeGreaterThan(3);
		expect(loaded.messages().length).toBe(loaded.entries.length - 1);

		// Exactly the torn line is missing, and nothing else: a file that does not
		// end on a line break lost its last line, and a file that does lost none.
		expect(loaded.skippedLines).toBe(text.endsWith("\n") ? 0 : 1);

		// The chain still walks from the header to the last entry that survived.
		const chain = loaded.linearEntries();
		expect(chain[0]?.type).toBe("header");
		expect(chain.length).toBe(loaded.entries.length);
		expect(chain[chain.length - 1]?.type).toBe("message");

		// Every message but the interrupted one is there, in the order it was
		// written: losing the file's tail is the failure this format accepts, and
		// losing its middle is the one it does not.
		const texts = loaded.messages().map((message) => (typeof message.content === "string" ? message.content : ""));
		for (const [i, text_] of texts.entries()) expect(text_).toContain(`message ${i} `);
	}, 60_000);

	// The other half of the torn tail: the reader above survives it, and the writer
	// that resumes the file has to as well. A file whose last line has no terminator
	// used to take the next append onto the end of the fragment, so the first entry
	// of the resumed session was written, kept in memory, and read back as nothing.
	test("the first append after a torn tail is a line of its own", () => {
		const cwd = scratch("lbb-crash-resume-cwd-");
		const home = scratch("lbb-crash-resume-home-");
		const store = SessionStore.startNew(cwd, home);
		for (let i = 0; i < 3; i++) store.appendMessage({ role: "user", content: `message ${i}`, timestamp: 1 });
		const whole = readFileSync(store.path, "utf8");
		const lastLineStart = whole.lastIndexOf("\n", whole.length - 2) + 1;
		const lastLine = whole.slice(lastLineStart);
		writeFileSync(
			store.path,
			`${whole.slice(0, lastLineStart)}${lastLine.slice(0, Math.floor(lastLine.length / 2))}`,
			"utf8",
		);

		const resumed = SessionStore.load(store.path);
		resumed.appendMessage({ role: "user", content: "first after resume", timestamp: 2 });
		resumed.appendMessage({ role: "user", content: "second after resume", timestamp: 3 });

		const reloaded = SessionStore.load(store.path);
		// The torn entry is the only loss; both entries written since are there.
		expect(reloaded.skippedLines).toBe(1);
		const texts = reloaded.messages().map((message) => (typeof message.content === "string" ? message.content : ""));
		expect(texts).toEqual(["message 0", "message 1", "first after resume", "second after resume"]);
		expect(reloaded.linearEntries()[0]?.type).toBe("header");
	});

	test("a file that ends on a line break gets no extra line on resume", () => {
		const cwd = scratch("lbb-crash-clean-cwd-");
		const home = scratch("lbb-crash-clean-home-");
		const store = SessionStore.startNew(cwd, home);
		store.appendMessage({ role: "user", content: "before", timestamp: 1 });

		const resumed = SessionStore.load(store.path);
		resumed.appendMessage({ role: "user", content: "after", timestamp: 2 });

		expect(readFileSync(store.path, "utf8")).not.toContain("\n\n");
		expect(SessionStore.load(store.path).skippedLines).toBe(0);
	});
});
