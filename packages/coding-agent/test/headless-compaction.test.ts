/**
 * Compaction in a `-p` run, followed all the way to the wire.
 *
 * A `-p` run is a session like any other, and the one shape with nobody to type
 * `/compact`: before this it ended on the provider's refusal with the whole
 * transcript still in the way. What is asserted here is what got sent — a
 * summary of what could not be sent, then the prompt again carrying it — and
 * that the run ends with an exit code a script can act on.
 *
 * The transport is scripted, so there is no network, no key and nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { fauxProvider } from "@labunbun/ai";
import { runHeadless } from "../src/headless.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	home: string;
	cwd: string;
	/** Write the home-tier settings, which is where hooks are honoured from. */
	writeSettings(settings: unknown): void;
}

function fixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "lbb-headless-compact-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-headless-compact-cwd-"));
	roots.push(home, cwd);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return {
		home,
		cwd,
		writeSettings: (settings) => writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify(settings)),
	};
}

const OVERFLOW = {
	stopReason: "error" as const,
	errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
	errorKind: "context_overflow" as const,
};

/** Run with a throwaway home and a captured stdout, and put both back afterwards. */
async function runCaptured(
	f: Fixture,
	options: {
		streamFn: ReturnType<typeof fauxProvider>["streamFn"];
		noSession?: boolean;
		outputFormat?: "json" | "stream-json";
	},
): Promise<{ code: number; stdout: string }> {
	const chunks: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		const code = await runHeadless({
			prompt: "hello",
			modelRef: "anthropic/claude-haiku-4-5",
			cwd: f.cwd,
			noSession: options.noSession ?? true,
			outputFormat: options.outputFormat ?? "json",
			streamFn: options.streamFn,
			home: f.home,
		});
		return { code, stdout: chunks.join("") };
	} finally {
		process.stdout.write = write;
	}
}

/**
 * One text-mode run in a child process, where stderr is real.
 *
 * `console.error` in Bun writes to the handle, not through `process.stderr.write`,
 * so the reason a run gave for ending cannot be read from a test in the same
 * process — and that line is the whole point of the last test below.
 */
async function runChild(f: Fixture, steps: unknown[]): Promise<{ code: number; stderr: string }> {
	const script = `
		import { fauxProvider } from "@labunbun/ai";
		import { runHeadless } from "./src/headless.ts";
		const steps = ${JSON.stringify(steps)};
		let call = 0;
		const streamFn = async function* (model, context, options) {
			const step = steps[Math.min(call++, steps.length - 1)];
			if (step.throw) throw new Error(step.throw);
			const reply = step.overflow
				? { stopReason: "error", errorMessage: "prompt is too long: 250000 tokens", errorKind: "context_overflow" }
				: { text: step.text };
			const provider = fauxProvider([reply]);
			yield* provider.streamFn(model, context, options);
		};
		const code = await runHeadless({
			prompt: "hello",
			modelRef: "anthropic/claude-haiku-4-5",
			cwd: ${JSON.stringify(f.cwd)},
			noSession: true,
			outputFormat: "text",
			streamFn,
			home: ${JSON.stringify(f.home)},
		});
		console.error("CALLS=" + call);
		process.exitCode = code;
	`;
	// The home is handed to `runHeadless` in the script rather than through the
	// environment. An env assignment does reach `os.homedir()` in a child on every
	// platform, but only because it is read at process start — in *this* process the
	// same assignment is invisible on linux and macOS, and a test that quietly
	// depends on which of the two it is running is a test that means two things.
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code, stderr };
}

describe("a `-p` run that runs out of room", () => {
	test("compacts what the provider refused and sends the prompt again", async () => {
		const f = fixture();
		const faux = fauxProvider([OVERFLOW, { text: "<summary>1. Primary Request: hello</summary>" }, { text: "done" }]);

		const { code, stdout } = await runCaptured(f, { streamFn: faux.streamFn });

		expect(code).toBe(0);
		const result = JSON.parse(stdout) as { subtype: string; result: string };
		expect(result.subtype).toBe("success");
		expect(result.result).toBe("done");

		// Three requests: the one that was refused, the summarization the refusal
		// forced, and the prompt again — carrying the summary in place of the
		// history the provider would not take.
		expect(faux.receivedContexts).toHaveLength(3);
		expect(JSON.stringify(faux.receivedContexts[1]?.messages)).toContain("You are summarizing");
		const retried = JSON.stringify(faux.receivedContexts[2]?.messages);
		expect(retried).toContain("Conversation compacted");
		expect(retried).toContain("hello");
	});

	test("a read above the boundary does not license an edit after the summary", async () => {
		// A `-p` run used to build its tool set with a read record the host could
		// not reach, so a summary replaced the prefix and the record outlived the
		// bytes it described. The `done` phase is the clear the REPL makes, and
		// the Edit gate below is what shows it ran: the first edit is refused for
		// the gate's own reason, the re-read licenses the second one.
		const f = fixture();
		const target = join(f.cwd, "target.txt");
		writeFileSync(target, "alpha\nbeta\n");
		const read = { toolCalls: [{ name: "Read", arguments: { file_path: target } }] };
		const edit = {
			toolCalls: [{ name: "Edit", arguments: { file_path: target, old_string: "alpha", new_string: "ALPHA" } }],
		};
		const faux = fauxProvider([
			read,
			OVERFLOW,
			{ text: "<summary>1. Primary Request: hello</summary>" },
			edit,
			read,
			edit,
			{ text: "done" },
		]);

		const { code, stdout } = await runCaptured(f, { streamFn: faux.streamFn, outputFormat: "stream-json" });

		expect(code).toBe(0);
		// The summary really ran: without it the first edit would be legal and the
		// refusal below would pass for the wrong reason.
		expect(faux.receivedContexts.length).toBeGreaterThanOrEqual(4);
		const events = stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; tool?: string; is_error?: boolean });
		const edits = events.filter((event) => event.type === "tool_result" && event.tool === "Edit");
		expect(edits.map((event) => event.is_error)).toEqual([true, false]);
		expect(readFileSync(target, "utf8")).toBe("ALPHA\nbeta\n");
	});

	test("records the compaction in the session file, so the run can be resumed from it", async () => {
		// The store is what makes a `-p` run inspectable afterwards — `/resume`
		// reads the same boundary, and without the record it would reload the
		// transcript the summary replaced.
		const f = fixture();
		const faux = fauxProvider([OVERFLOW, { text: "<summary>1. Primary Request: hello</summary>" }, { text: "done" }]);

		const { code } = await runCaptured(f, { streamFn: faux.streamFn, noSession: false });

		expect(code).toBe(0);
		const [session] = SessionStore.listSessions(f.cwd, f.home);
		expect(session).toBeDefined();
		const entries = readFileSync(session?.path ?? "", "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; trigger?: string; postTokens?: number });
		const compaction = entries.find((entry) => entry.type === "compaction");
		// "overflow", not "auto": the record says which of the three callers asked
		// for this summary, and this run's caller was a provider that had already
		// refused the request. The word costs nothing to store and is the only way
		// to tell `-p` refusing to fit apart from `/compact` from the file.
		expect(compaction?.trigger).toBe("overflow");
		expect(compaction?.postTokens ?? 0).toBeGreaterThan(0);
	});

	test("when no room can be made, it says why instead of sending the same request again", async () => {
		// The other half of the retry: it exists to make room. With the summarizer
		// itself failing there is no room to make, and the run has to end with the
		// reason — the provider's own 400 says only that the request was too long,
		// which is the symptom and not what to do about it.
		const f = fixture();

		const { code, stderr } = await runChild(f, [{ overflow: true }, { throw: "summarizer down" }]);

		expect(code).toBe(1);
		// Two calls, and nothing else: the refused request was not sent again.
		expect(stderr).toContain("CALLS=2");
		expect(stderr).toContain("could not free enough space");
		expect(stderr).toContain("/compact");
		// The attempt said it had started and then said it had failed. A wait
		// announced and never closed is the one thing this reporting cannot do:
		// while the summary is in flight it is the only evidence the run is alive.
		expect(stderr).toContain("Compacting context…");
		expect(stderr).toContain("Compaction failed (overflow)");
	});

	test("a `-p` run reports the summary it paid for, on the surface a script reads", async () => {
		// The wiring's default report path — the one the interactive app replaces
		// with `onPhase` — is only exercised here, and stderr is the whole surface a
		// `-p` run has. Both lines are the same two the TUI draws, in the same
		// order, through a different outlet.
		const f = fixture();

		const { code, stderr } = await runChild(f, [
			{ overflow: true },
			{ text: "<summary>1. Primary Request: hello</summary>" },
			{ text: "done" },
		]);

		expect(code).toBe(0);
		expect(stderr).toContain("Compacting context…");
		expect(stderr).toMatch(/Context compacted \(overflow\): [\d.]+k → [\d.]+k tokens\./);
		// Announced before it started, reported when it was over.
		expect(stderr.indexOf("Compacting context…")).toBeLessThan(stderr.indexOf("Context compacted"));
	});
});

/** The session file's entries, as the store wrote them. */
function sessionEntries(f: Fixture): Array<{ type?: string; trigger?: string }> {
	const [session] = SessionStore.listSessions(f.cwd, f.home);
	const path = session?.path;
	if (!path) throw new Error("the run saved no session file");
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type?: string; trigger?: string });
}

/** A hook command that runs `body` under the test's own runtime. */
function hookCommand(f: Fixture, name: string, body: string): string {
	const script = join(f.cwd, `${name}.mjs`);
	writeFileSync(script, body);
	return `${process.execPath} ${script}`;
}

describe("the compaction hooks in a `-p` run", () => {
	test("a PreCompact hook vetoes the pass the refusal forced, and nothing is recorded", async () => {
		// The same hook the REPL honors: a `-p` run has no dialog, so a veto is the
		// only way a script gets a word in. A veto cannot defer a refusal — the
		// next request would be the same request — so the run ends with the
		// manager's "cannot free enough space" message instead of re-sending.
		const f = fixture();
		const command = hookCommand(
			f,
			"precompact",
			`console.log(${JSON.stringify(JSON.stringify({ decision: "block", reason: "hold the summary" }))});\n`,
		);
		f.writeSettings({ hooks: { PreCompact: [{ hooks: [{ type: "command", command }] }] } });
		const faux = fauxProvider([OVERFLOW, { text: "done" }]);

		const { code } = await runCaptured(f, { streamFn: faux.streamFn, noSession: false });

		expect(code).toBe(1);
		// One request — the one that was refused — and no summarization request.
		expect(faux.receivedContexts).toHaveLength(1);
		// The veto really vetoed: the store a resume reads carries no boundary.
		expect(sessionEntries(f).some((entry) => entry.type === "compaction")).toBe(false);
	}, 30_000);

	test("a completed compaction fires PostCompact with the trigger and the sizes", async () => {
		// The observer event, wired exactly as the REPL wires it: a failing hook is
		// a line, and the payload carries the same pair the receipt prints.
		const f = fixture();
		const marker = join(f.cwd, "postcompact.json");
		const command = hookCommand(
			f,
			"postcompact",
			'import { writeFileSync } from "node:fs";\n' +
				'let input = "";\n' +
				"for await (const chunk of process.stdin) input += chunk;\n" +
				`writeFileSync(${JSON.stringify(marker)}, input);\n`,
		);
		f.writeSettings({ hooks: { PostCompact: [{ hooks: [{ type: "command", command }] }] } });
		const faux = fauxProvider([OVERFLOW, { text: "<summary>1. Primary Request: hello</summary>" }, { text: "done" }]);

		const { code } = await runCaptured(f, { streamFn: faux.streamFn, noSession: false });

		expect(code).toBe(0);
		// The pass completed, so there is a boundary to be the event about.
		const compaction = sessionEntries(f).find((entry) => entry.type === "compaction");
		expect(compaction?.trigger).toBe("overflow");

		// Read without polling: the phase callback is awaited through to the
		// manager, so the hook has finished by the time the run returns. A poll
		// here would hide exactly the exit race this contract closes.
		const payload = JSON.parse(readFileSync(marker, "utf8")) as {
			event?: string;
			session_id?: string;
			cwd?: string;
			trigger?: string;
			pre_tokens?: number;
			post_tokens?: number;
		};
		expect(payload.event).toBe("PostCompact");
		expect(payload.trigger).toBe("overflow");
		expect(payload.cwd).toBe(f.cwd);
		const [session] = SessionStore.listSessions(f.cwd, f.home);
		expect(payload.session_id).toBe(session?.sessionId);
		expect(payload.pre_tokens ?? 0).toBeGreaterThan(0);
		expect(typeof payload.post_tokens).toBe("number");
	}, 30_000);
});
