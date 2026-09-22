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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
}

function fixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "lbb-headless-compact-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-headless-compact-cwd-"));
	roots.push(home, cwd);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return { home, cwd };
}

const OVERFLOW = {
	stopReason: "error" as const,
	errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
	errorKind: "context_overflow" as const,
};

/** Run with a throwaway home and a captured stdout, and put both back afterwards. */
async function runCaptured(
	f: Fixture,
	options: { streamFn: ReturnType<typeof fauxProvider>["streamFn"]; noSession?: boolean },
): Promise<{ code: number; stdout: string }> {
	const chunks: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const prevHome = process.env.HOME;
	const prevProfile = process.env.USERPROFILE;
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.env.HOME = f.home;
	process.env.USERPROFILE = f.home;
	try {
		const code = await runHeadless({
			prompt: "hello",
			modelRef: "anthropic/claude-haiku-4-5",
			cwd: f.cwd,
			noSession: options.noSession ?? true,
			outputFormat: "json",
			streamFn: options.streamFn,
		});
		return { code, stdout: chunks.join("") };
	} finally {
		process.stdout.write = write;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevProfile;
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
		});
		console.error("CALLS=" + call);
		process.exitCode = code;
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: f.home, USERPROFILE: f.home },
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
