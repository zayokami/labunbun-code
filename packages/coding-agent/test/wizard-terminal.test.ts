/**
 * The first-run wizard on a terminal-shaped stdin. The pure parts of the wizard
 * are covered in wizard.test.ts; this file runs `runWizard` itself, answering
 * each prompt the way a keyboard does: once the prompt is on screen, its text is
 * typed, then Enter. The streams are `PassThrough`s, which hold written input
 * while they are paused, as a terminal holds keystrokes until something reads
 * them, so a wizard that stops reading stalls here the way it stalls for a user.
 *
 * The sign-in rows are not driven: they open a browser. The masked key read takes
 * stdin away from the prompt and gives it back, and the theme question is the
 * first question after it.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runWizard, userSettingsPath } from "../src/wizard.ts";

const KEY = "sk-test-key-123";

interface FakeTerminal {
	stdin: PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): unknown };
	stdout: PassThrough & { isTTY: boolean; columns: number; rows: number };
	/** Everything written to the terminal so far: prompts, echo, and masked stars. */
	screen(): string;
	/** Waits for `text` to appear on screen after the last one matched. */
	waitFor(text: string, timeoutMs?: number): Promise<void>;
	/** Types `text` and then Enter, as two keystroke writes. */
	type(text: string): void;
	/** Waits for `prompt`, then types `text` and Enter. */
	answer(prompt: string, text: string): Promise<void>;
}

function fakeTerminal(): FakeTerminal {
	const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false }) as FakeTerminal["stdin"];
	stdin.setRawMode = (mode: boolean) => {
		stdin.isRaw = mode;
		return stdin;
	};
	const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 }) as FakeTerminal["stdout"];
	let screen = "";
	let read = 0;
	stdout.on("data", (chunk: Buffer) => {
		screen += chunk.toString("utf8");
	});

	const waitFor = async (text: string, timeoutMs = 3000): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const at = screen.indexOf(text, read);
			if (at >= 0) {
				read = at + text.length;
				return;
			}
			if (Date.now() > deadline) {
				throw new Error(
					`"${text}" never reached the screen (stdin paused=${stdin.isPaused()}, flowing=${stdin.readableFlowing}); ` +
						`the last output was ${JSON.stringify(screen.slice(-120))}`,
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	};
	const type = (text: string): void => {
		if (text !== "") stdin.write(text);
		stdin.write("\r");
	};

	return {
		stdin,
		stdout,
		screen: () => screen,
		waitFor,
		type,
		async answer(prompt, text) {
			await waitFor(prompt);
			type(text);
		},
	};
}

let home: string;
let savedStdin: PropertyDescriptor | undefined;
let savedStdout: PropertyDescriptor | undefined;
let savedEnv: Array<[string, string | undefined]>;
let logSpy: { mockRestore(): void };

// The names the anthropic row reads. The wizard checks them before it asks for a
// key, so a machine that already has one would skip the masked read under test.
const ANTHROPIC_ENV_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "lbb-wizard-terminal-"));
	savedStdin = Object.getOwnPropertyDescriptor(process, "stdin");
	savedStdout = Object.getOwnPropertyDescriptor(process, "stdout");
	savedEnv = ANTHROPIC_ENV_NAMES.map((name): [string, string | undefined] => [name, process.env[name]]);
	for (const name of ANTHROPIC_ENV_NAMES) delete process.env[name];
	logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	if (savedStdin) Object.defineProperty(process, "stdin", savedStdin);
	if (savedStdout) Object.defineProperty(process, "stdout", savedStdout);
	for (const [name, value] of savedEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	logSpy.mockRestore();
	rmSync(home, { recursive: true, force: true });
});

/** Runs the wizard on `term` in the background; the caller drives the prompts. */
function startWizard(term: FakeTerminal): Promise<void> {
	Object.defineProperty(process, "stdin", { value: term.stdin, configurable: true, writable: true });
	Object.defineProperty(process, "stdout", { value: term.stdout, configurable: true, writable: true });
	return runWizard(process.cwd(), home);
}

/**
 * Waits for the wizard to finish, failing instead of hanging when it does not.
 * A run that never answers its next prompt never settles, so the bound is what
 * turns that stall into a failed test.
 */
async function settles(run: Promise<void>, ms = 3000): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			run,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`the wizard did not finish within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The import offer is asked only when this machine holds a source (the IDE trees
 * are read from APPDATA), so a run on a developer's machine may or may not reach
 * it. Declined when it comes; a run that finishes without it is left alone.
 */
async function declineImportOffer(term: FakeTerminal, run: Promise<void>): Promise<void> {
	const offered = await Promise.race([
		term.waitFor("Import from ").then(
			() => true,
			() => false,
		),
		run.then(() => false),
	]);
	if (offered) term.type("n");
}

function savedSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(userSettingsPath(home), "utf8")) as Record<string, unknown>;
}

describe("the wizard on a terminal", () => {
	test("a key pasted at the API-key step hands the terminal back: the theme and editing questions are answered", async () => {
		const term = fakeTerminal();
		const run = startWizard(term);
		await term.answer("How do you want to use labunbun?", "3");
		await term.answer("API key (Enter if", KEY);
		await term.answer("Theme (", "auto");
		await term.answer("Editing model (", "none");
		await declineImportOffer(term, run);
		await settles(run);

		expect(savedSettings()).toMatchObject({
			theme: "auto",
			vimMode: false,
			emacsMode: false,
			env: { ANTHROPIC_API_KEY: KEY },
		});
	});

	test("the pasted key is never echoed to the screen", async () => {
		const term = fakeTerminal();
		const run = startWizard(term);
		await term.answer("How do you want to use labunbun?", "3");
		await term.answer("API key (Enter if", KEY);
		await term.waitFor("Theme (");
		expect(term.screen()).not.toContain(KEY);
		term.type("dark");
		await term.answer("Editing model (", "none");
		await declineImportOffer(term, run);
		await settles(run);
	});

	test("the openai-compatible key step (row 4) also hands the terminal back to the theme question", async () => {
		const term = fakeTerminal();
		const run = startWizard(term);
		await term.answer("How do you want to use labunbun?", "4");
		await term.answer("Base URL (e.g.", "https://api.example.com/v1");
		await term.answer("Env var NAME holding your API key", "");
		await term.answer("Model id as the provider names it:", "my-model");
		await term.answer("Context window in tokens", "");
		await term.answer("Max output tokens", "");
		await term.answer("Reasoning-capable model?", "");
		await term.answer("Paste the key value to store now", "sk-compat-key");
		await term.answer("Theme (", "dark");
		await term.answer("Editing model (", "vim");
		await declineImportOffer(term, run);
		await settles(run);

		expect(savedSettings()).toMatchObject({
			theme: "dark",
			vimMode: true,
			emacsMode: false,
			env: { CUSTOM_API_KEY: "sk-compat-key" },
		});
	});
});
