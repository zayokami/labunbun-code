import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "../src/background.ts";
import { createBashOutputTool, createKillBashTool } from "../src/bash.ts";
import { htmlToText, parseDuckDuckGoResults } from "../src/web.ts";

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
