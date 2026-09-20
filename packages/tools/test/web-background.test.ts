import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager, readTail } from "../src/background.ts";
import { createBashOutputTool, createKillBashTool } from "../src/bash.ts";
import { htmlToText, parseDuckDuckGoResults } from "../src/web.ts";

function tempFile(name: string): string {
	return join(mkdtempSync(join(tmpdir(), "lbb-tail-")), name);
}

describe("htmlToText", () => {
	test("strips scripts, styles, tags; decodes entities", () => {
		const html = `<!doctype html><html><head><style>body{color:red}</style>
		<script>evil()</script></head><body><h1>Hello &amp; welcome</h1>
		<p>First&nbsp;paragraph</p><!-- comment --><p>Second</p></body></html>`;
		const text = htmlToText(html);
		expect(text).toContain("Hello & welcome");
		expect(text).toContain("First paragraph");
		expect(text).toContain("Second");
		expect(text).not.toContain("evil()");
		expect(text).not.toContain("color:red");
		expect(text).not.toContain("<");
	});
});

describe("parseDuckDuckGoResults", () => {
	test("extracts title/url/snippet and unwraps redirect URLs", () => {
		const html = `
		<div class="result">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example <b>Docs</b></a>
			<a class="result__snippet" href="#">The docs snippet here</a>
		</div>
		<div class="result">
			<a class="result__a" href="https://direct.example.org">Direct Link</a>
			<a class="result__snippet" href="#">Another snippet</a>
		</div>`;
		const results = parseDuckDuckGoResults(html);
		expect(results).toHaveLength(2);
		expect(results[0].url).toBe("https://example.com/docs");
		expect(results[0].title).toBe("Example Docs");
		expect(results[0].snippet).toBe("The docs snippet here");
		expect(results[1].url).toBe("https://direct.example.org");
	});

	test("empty html yields no results", () => {
		expect(parseDuckDuckGoResults("<html></html>")).toEqual([]);
	});
});

describe("readTail", () => {
	test("a log longer than the cap comes back as its last characters", () => {
		// The end of it is unlike anything before it: a read that started at the
		// front would return the first hundred characters and pass for a tail.
		const end = "the end of the log, and not a line from the front of it";
		const content = `${"x".repeat(99_000)}${end}`;
		const path = tempFile("long.log");
		writeFileSync(path, content);

		const tail = readTail(path, 100);

		expect(tail.text).toBe(content.slice(-100));
		expect(tail.text).not.toBe("x".repeat(100));
		expect(tail.truncated).toBe(true);
		expect(tail.bytes).toBe(Buffer.byteLength(content));
	});

	test("a log shorter than the cap comes back whole, and unannounced", () => {
		const path = tempFile("short.log");
		writeFileSync(path, "one line\n");

		const tail = readTail(path, 1_000);

		expect(tail.text).toBe("one line\n");
		expect(tail.truncated).toBe(false);
	});

	test("a window that opens inside a character cannot put one into the tail", () => {
		// The window is 4 bytes per character, so it holds `maxChars` characters
		// whatever the text is made of — but it can open anywhere, including between
		// the bytes of one, and the bytes it caught must not become a character the
		// log never contained.
		const content = `${"α".repeat(100)}${"🚀".repeat(50)}x`;
		const path = tempFile("wide.log");
		writeFileSync(path, content);

		// Four characters: exactly the cap. Every unit the window decodes has to be
		// dropped except the last four, so a window that read less than 4 bytes per
		// character would leave the fragment in the answer.
		const maxChars = 4;
		const bytes = Buffer.byteLength(content);
		const offset = bytes - Math.min(bytes, maxChars * 4);
		const file = Buffer.from(content, "utf8");
		// 0b10xxxxxx: the setup means nothing unless the window really does open
		// inside a character.
		expect((file[offset] ?? 0) & 0xc0).toBe(0x80);

		const tail = readTail(path, maxChars);

		// No U+FFFD: a window that opened mid-character must not put a character
		// into the tail that the log never contained.
		expect(tail.text.includes(String.fromCharCode(0xfffd))).toBe(false);
		// A true suffix: every character of the tail is a character of the log.
		expect(tail.text).toBe(content.slice(-tail.text.length));
		expect(tail.text.length).toBeGreaterThan(0);
		expect(tail.text.length).toBeLessThanOrEqual(maxChars);
		expect(tail.bytes).toBe(bytes);
	});
});

describe("background shells (real spawn)", () => {
	test("start → output accumulates → completes", async () => {
		mkdtempSync(join(tmpdir(), "lbb-bg-")); // ensure tmpdir usable
		const manager = new BackgroundShellManager();
		const shell = manager.start(process.platform === "win32" ? "echo hello-bg" : "echo hello-bg", process.cwd());

		// Wait for completion.
		for (let i = 0; i < 50 && shell.status === "running"; i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(shell.status).toBe("completed");
		const output = manager.output(shell.id);
		expect(output).toContain("hello-bg");
		expect(output).toContain("[exit code: 0]");
	}, 10_000);

	test("a log longer than the read says what it skipped, and where the rest is", async () => {
		// A shell polled for an hour has a log far longer than one read takes, and
		// the answer is a window on it — so it has to read as one: where the whole
		// log is, and that this is not it.
		const manager = new BackgroundShellManager();
		const shell = manager.start("echo one-two-three-four-five", process.cwd());
		for (let i = 0; i < 50 && shell.status === "running"; i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		const whole = manager.output(shell.id);
		// The exit code is the manager's last append, with no newline after it.
		expect(whole.endsWith("[exit code: 0]")).toBe(true);
		expect(whole).not.toContain("[log tail:");

		const tail = manager.output(shell.id, 8);
		expect(tail.startsWith(`[log tail: last 8 characters of ${Buffer.byteLength(whole)} bytes — full log: `)).toBe(
			true,
		);
		expect(tail).toContain(shell.outputFile);
		expect(tail.slice(tail.indexOf("\n") + 1)).toBe(whole.slice(-8));
	}, 10_000);

	test("kill terminates a running shell", async () => {
		const manager = new BackgroundShellManager();
		const command = process.platform === "win32" ? "ping -n 30 127.0.0.1 > nul" : "sleep 30";
		const shell = manager.start(command, process.cwd());
		await new Promise((r) => setTimeout(r, 300));

		expect(manager.kill(shell.id)).toBe(true);
		expect(shell.status).toBe("killed");
		expect(manager.kill(shell.id)).toBe(false); // already killed
	}, 10_000);

	test("BashOutput/KillBash tools wrap the manager", async () => {
		const manager = new BackgroundShellManager();
		const outputTool = createBashOutputTool(manager);
		const killTool = createKillBashTool(manager);
		const ctx = {
			callId: "t",
			signal: new AbortController().signal,
			cwd: process.cwd(),
			onUpdate: () => {},
		};

		const missing = await outputTool.call({ shell_id: "nope" }, ctx);
		expect(missing.isError).toBe(true);

		const command = process.platform === "win32" ? "ping -n 30 127.0.0.1 > nul" : "sleep 30";
		const shell = manager.start(command, process.cwd());
		const out = await outputTool.call({ shell_id: shell.id }, ctx);
		expect((out.content[0] as any).text).toContain("still running");

		const killed = await killTool.call({ shell_id: shell.id }, ctx);
		expect((killed.content[0] as any).text).toContain(`Killed ${shell.id}`);
	}, 10_000);
});
