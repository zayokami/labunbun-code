/**
 * Hook context in a `-p` run, followed all the way to the wire.
 *
 * A SessionStart hook contributes text to the conversation, and a run is one
 * long prefix a provider can cache — so the contribution has to be part of the
 * user message that was stored, and it has to still be there on the second
 * request of a tool loop. Attaching it to the first request instead (which is
 * what the app used to do) rewrote the prefix at that message, and everything
 * after it was charged at full price again.
 *
 * The hook is a real script spawned by the real hook runtime: what is under
 * test is the wiring from settings to the request body, and a stubbed runtime
 * would be testing the stub. The transport is scripted, so there is no network,
 * no key and nothing billed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type StreamFn } from "@labunbun/ai";
import { runHeadless } from "../src/headless.ts";

const CONTEXT = "the build runs via make, and tests via bun test";

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

/** A throwaway home plus a project dir to run in. */
function fixture(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "lbb-headless-hook-"));
	const cwd = mkdtempSync(join(tmpdir(), "lbb-headless-hook-cwd-"));
	roots.push(home, cwd);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	return {
		home,
		cwd,
		writeSettings: (settings) => writeFileSync(join(home, ".labunbun", "settings.json"), JSON.stringify(settings)),
	};
}

/** A hook in the project dir that emits `addedContext` for one event, and nothing else. */
function contextHook(f: Fixture, event: string, text: string): string {
	const script = join(f.cwd, `${event}.mjs`);
	writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify({ addedContext: text }))});\n`);
	return `${process.execPath} ${script}`;
}

/** Requests as they were sent, serialized at the moment they were received. */
function recording(inner: StreamFn): { streamFn: StreamFn; sent: string[] } {
	const sent: string[] = [];
	const streamFn: StreamFn = async function* (model, context, options) {
		sent.push(JSON.stringify(context.messages));
		yield* inner(model, context, options);
	};
	return { streamFn, sent };
}

/** Run with a throwaway home and a captured stdout, and put both back afterwards. */
async function runCaptured(
	home: string,
	options: { cwd: string; prompt: string; streamFn: StreamFn },
): Promise<{ code: number; stdout: string }> {
	const chunks: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const prevHome = process.env.HOME;
	const prevProfile = process.env.USERPROFILE;
	process.stdout.write = ((chunk: unknown) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		const code = await runHeadless({
			prompt: options.prompt,
			modelRef: "anthropic/claude-haiku-4-5",
			cwd: options.cwd,
			noSession: true,
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

describe("hook context across a headless tool loop", () => {
	test("the hook's context is in the stored message and in both requests of the loop", async () => {
		const faux = fauxProvider([
			// A tool call first, so the run has a second request to get wrong.
			{ toolCalls: [{ name: "Read", arguments: { file_path: "missing.txt" } }] },
			{ text: "done" },
		]);
		const rec = recording(faux.streamFn);
		const f = fixture();
		f.writeSettings({
			hooks: { SessionStart: [{ hooks: [{ type: "command", command: contextHook(f, "SessionStart", CONTEXT) }] }] },
		});

		const { code, stdout } = await runCaptured(f.home, {
			cwd: f.cwd,
			prompt: "what command builds this?",
			streamFn: rec.streamFn,
		});

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ type: "result", result: "done" });
		expect(rec.sent).toHaveLength(2);
		// The first request carries the hook's contribution…
		expect(rec.sent[0]).toContain(CONTEXT);
		// …and so does the second, the continuation of the same loop after a tool
		// result. A message that lost it here is a prefix rewritten at that message:
		// the entry the first request wrote would never be read again.
		expect(rec.sent[1]).toContain(CONTEXT);
		// The second request is the first with the turn's messages appended, which
		// holds only while the stored bytes stay put.
		const earlier = rec.sent[0] ?? "";
		expect(rec.sent[1]?.startsWith(earlier.slice(0, -1))).toBe(true);
		// And it is genuinely the next turn, not a repeat: the tool result is in it.
		expect(rec.sent[1]).toContain('"role":"toolResult"');
	}, 30_000);

	test("a UserPromptSubmit contribution rides on the prompt it was given for", async () => {
		// The other lifecycle event that contributes context, and the one that made
		// the old bug visible: it belongs to *this* prompt, so it has to be inside
		// this prompt's message rather than beside it.
		const faux = fauxProvider([{ text: "done" }]);
		const rec = recording(faux.streamFn);
		const f = fixture();
		f.writeSettings({
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: contextHook(f, "UserPromptSubmit", CONTEXT) }] }],
			},
		});

		const { code } = await runCaptured(f.home, { cwd: f.cwd, prompt: "hello", streamFn: rec.streamFn });

		expect(code).toBe(0);
		expect(rec.sent[0]).toContain(CONTEXT);
		// Composed as a preamble to the user's own words, in that order.
		const message = rec.sent[0] ?? "";
		expect(message.indexOf(CONTEXT)).toBeLessThan(message.indexOf("hello"));
	}, 30_000);

	test("no hooks means the prompt is sent as typed", async () => {
		// The default path, so a composition that always adds something cannot pass
		// the tests above by adding it unconditionally.
		const faux = fauxProvider([{ text: "done" }]);
		const rec = recording(faux.streamFn);
		const f = fixture();
		f.writeSettings({});

		const { code } = await runCaptured(f.home, { cwd: f.cwd, prompt: "hello there", streamFn: rec.streamFn });

		expect(code).toBe(0);
		expect(rec.sent).toHaveLength(1);
		expect(rec.sent[0]).toContain('"content":"hello there"');
	}, 30_000);
});
