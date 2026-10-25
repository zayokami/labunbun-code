import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_NAME, CODING_AGENT_VERSION } from "../src/index.ts";
import { main, parseArgs, promptFromStdin } from "../src/main.ts";

describe("@labunbun/coding-agent smoke", () => {
	test("reports its version", () => {
		expect(CODING_AGENT_VERSION).toBe("0.1.0.2");
		expect(CLI_NAME).toBe("labunbun");
	});

	test("--version exits cleanly", async () => {
		const exitCode = await main(["--version"]);
		expect(exitCode).toBe(0);
	});
});

describe("flags that cannot mean anything are refused, not dropped", () => {
	// A home under the platform temp dir. Every invocation below is expected to
	// exit 2 before touching it; the mutation check for these tests runs the old
	// code, which instead walks into the interactive path and would use it.
	const home = mkdtempSync(join(tmpdir(), "labunbun-flags-"));

	test("--no-session without -p is rejected instead of ignored", async () => {
		expect(await main(["--no-session"], { home })).toBe(2);
	});

	test("a yoshi flag without the subcommand word is rejected", async () => {
		expect(await main(["--apply"], { home })).toBe(2);
	});

	test("--settings with malformed JSON is a CLI error", async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		try {
			expect(await main(["--settings", "{"], { home })).toBe(2);
		} finally {
			console.error = original;
		}
		expect(errors.join("\n")).toContain("Invalid --settings");
	});
});

describe("headless automation flags", () => {
	const home = mkdtempSync(join(tmpdir(), "labunbun-output-flags-"));

	test("parse the schema and last-message paths, including the -o alias", () => {
		expect(parseArgs(["--output-schema", "s.json", "--output-last-message", "o.txt"])).toMatchObject({
			outputSchema: "s.json",
			outputLastMessage: "o.txt",
		});
		expect(parseArgs(["-o", "o.txt"])).toMatchObject({ outputLastMessage: "o.txt" });
	});

	test("a bare flag is an empty path, which the headless branch refuses", async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		try {
			expect(await main(["-p", "hello", "--output-schema"], { home })).toBe(2);
			expect(await main(["-p", "hello", "--output-last-message"], { home })).toBe(2);
		} finally {
			console.error = original;
		}
		expect(errors.join("\n")).toContain("--output-schema requires a file path");
		expect(errors.join("\n")).toContain("--output-last-message requires a file path");
	});

	test("acp refuses the flags it has no use for", async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		try {
			expect(await main(["acp", "--output-schema", "s.json"], { home })).toBe(2);
		} finally {
			console.error = original;
		}
		expect(errors.join("\n")).toContain("--output-schema");
	});

	test("piped text becomes a prompt; whitespace alone does not", () => {
		expect(promptFromStdin("  task\n")).toBe("task");
		expect(promptFromStdin(" \n\t")).toBeNull();
		expect(promptFromStdin("")).toBeNull();
	});
});

describe("the provider word after login/logout", () => {
	// parseArgs only: the subcommands themselves open browsers and reach the
	// keychain, so the word that routes them is tested at the parse layer,
	// where nothing else can happen.
	test("bare login and logout mean the Claude flow", () => {
		expect(parseArgs(["login"])).toMatchObject({ subcommand: "login", loginProvider: null });
		expect(parseArgs(["logout"])).toMatchObject({ subcommand: "logout", loginProvider: null });
	});

	test("chatgpt, claude and gemini after the subcommand name the provider", () => {
		expect(parseArgs(["login", "chatgpt"])).toMatchObject({ subcommand: "login", loginProvider: "chatgpt" });
		expect(parseArgs(["logout", "chatgpt"])).toMatchObject({ subcommand: "logout", loginProvider: "chatgpt" });
		expect(parseArgs(["login", "claude"])).toMatchObject({ subcommand: "login", loginProvider: "claude" });
		expect(parseArgs(["login", "gemini"])).toMatchObject({ subcommand: "login", loginProvider: "gemini" });
		expect(parseArgs(["logout", "gemini"])).toMatchObject({ subcommand: "logout", loginProvider: "gemini" });
	});

	test("the provider word is consumed, and flags after it still parse", () => {
		const args = parseArgs(["login", "chatgpt", "--version"]);
		expect(args.loginProvider).toBe("chatgpt");
		expect(args.version).toBe(true);
	});
});
