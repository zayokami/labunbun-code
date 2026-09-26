/**
 * First-run setup. When there is no settings file yet and a human is on a TTY,
 * a short guided flow replaces the dead end of "Missing API key — set
 * ANTHROPIC_API_KEY" as a user's very first experience.
 *
 * Storage rules, matching the rest of the config system:
 * - The key VALUE goes into `settings.env`, which applySettingsEnv applies at
 *   startup (real environment variables always win over it).
 * - OpenAI-compatible providers store only the env var NAME in their spec.
 *
 * Cancel writes an empty object so the wizard does not re-trigger on every
 * start; the user can configure by hand or via migrate instead.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { AUTO_THEME_NAME, BUILT_IN_THEME_NAMES, DEFAULT_THEME } from "@labunbun/tui";

export function userSettingsPath(home = homedir()): string {
	return join(home, ".labunbun", "settings.json");
}

export function shouldRunWizard(opts: { home?: string; isTTY?: boolean } = {}): boolean {
	const isTTY = opts.isTTY ?? process.stdin.isTTY;
	if (!isTTY) return false;
	return !existsSync(userSettingsPath(opts.home));
}

/** Answers collected by the interactive flow; consumed only by the builder. */
export interface WizardAnswers {
	provider: "anthropic" | "openai-compatible";
	/** Pasted API key value, or null when it already lives in the environment. */
	apiKey: string | null;
	baseUrl: string;
	apiKeyEnvName: string;
	modelId: string;
	contextWindow: number;
	maxOutputTokens: number;
	reasoning: boolean;
	theme: string;
	vimMode: boolean;
	/**
	 * The other half of an exclusive pair with {@link vimMode}. Both are always
	 * written, even when both are false, so the file states what was chosen rather
	 * than leaving a reader to infer it from the absence of a key.
	 */
	emacsMode: boolean;
}

/** Pure translation of answers into a schema-valid settings object. */
export function buildWizardSettings(a: WizardAnswers): Record<string, unknown> {
	const base: Record<string, unknown> = {
		model: a.provider === "anthropic" ? "anthropic/claude-sonnet-5" : `custom/${a.modelId}`,
		theme: a.theme,
		vimMode: a.vimMode,
		emacsMode: a.emacsMode,
	};

	if (a.provider === "anthropic") {
		// Only write what was actually pasted; an empty hand never means
		// "store an empty secret".
		return a.apiKey ? { ...base, env: { ANTHROPIC_API_KEY: a.apiKey } } : base;
	}

	const provider: Record<string, unknown> = {
		id: "custom",
		baseUrl: a.baseUrl,
		apiKeyEnv: a.apiKeyEnvName,
		models: [
			{
				id: a.modelId,
				contextWindow: a.contextWindow,
				maxOutputTokens: a.maxOutputTokens,
				reasoning: a.reasoning,
			},
		],
	};
	return {
		...base,
		env: a.apiKey ? { [a.apiKeyEnvName]: a.apiKey } : undefined,
		providers: { openaiCompatible: [provider] },
	};
}

/**
 * The theme names the wizard accepts, and the one a bare Enter takes.
 *
 * The REPL's own list rather than a copy of it written out here: the copy is
 * what would let the wizard quietly offer a theme that no longer exists, or
 * miss one that does. Theme files are deliberately not included — they are found
 * by the REPL, and a name that has to be typed exactly is not a first-run
 * question.
 */
export const WIZARD_THEME_CHOICES: readonly string[] = [...BUILT_IN_THEME_NAMES, AUTO_THEME_NAME];
export const WIZARD_THEME_DEFAULT: string = DEFAULT_THEME.name;

/**
 * The editing models the wizard offers, in the order they read best: nothing
 * first, because it is the answer most people want and a bare Enter must be the
 * one that needs no thought.
 */
export const WIZARD_EDITOR_CHOICES: readonly string[] = ["none", "vim", "emacs"];

type Ask = (question: string) => Promise<string>;

/**
 * A question with a set of answers, asked until one of them arrives.
 *
 * Exported for the tests: the retry is the part that used to be missing, and it
 * cannot be checked without driving this loop. `hint` shortens what is shown in
 * the parentheses when the full list is too long to read — the accepted set is
 * still `valid`, which is what the re-ask prints in full.
 */
export async function askChoice(
	ask: Ask,
	prompt: string,
	valid: readonly string[],
	fallback: string,
	hint?: string,
): Promise<string> {
	while (true) {
		const answer = (await ask(`${prompt} (${hint ?? valid.join("/")}) [${fallback}]: `)).trim().toLowerCase();
		if (answer === "") return fallback;
		if (valid.includes(answer)) return answer;
		console.log(`  Please answer one of: ${valid.join(", ")}`);
	}
}

async function readMasked(prompt: string): Promise<string> {
	// Raw-mode single-line reader echoing asterisks. Restores the terminal on
	// every exit path — a leaked raw mode would leave the REPL deaf to keys.
	return new Promise((resolve) => {
		const { stdin, stdout } = process;
		if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
			// No TTY: visible readline fallback (shouldRunWizard gates this in practice).
			const rl = createInterface({ input: stdin });
			void rl.question(prompt).then((answer) => {
				stdout.write("\n");
				rl.close();
				resolve(answer);
			});
			return;
		}
		stdin.setRawMode(true);
		stdin.resume();
		stdout.write(prompt);
		let buffer = "";
		const onData = (ch: Buffer) => {
			const key = ch.toString("utf8");
			if (key === "\r" || key === "\n") {
				cleanup();
				stdout.write("\n");
				resolve(buffer);
			} else if (key === "\x03") {
				// Ctrl+C: treat as "no key pasted".
				cleanup();
				stdout.write("\n");
				resolve("");
			} else if (key === "\x7f" || key === "\b") {
				buffer = buffer.slice(0, -1);
				stdout.write("\b \b");
			} else if (key >= " ") {
				buffer += key;
				stdout.write("*");
			}
		};
		function cleanup(): void {
			stdin.removeListener("data", onData);
			if (typeof stdin.setRawMode === "function") stdin.setRawMode(false);
			stdin.pause();
		}
		stdin.on("data", onData);
	});
}

/**
 * Run the guided setup and write the settings file. Ctrl+C anywhere lands in
 * the catch, leaving a minimal valid file so we do not re-prompt forever.
 */
export async function runWizard(cwd: string, home = homedir()): Promise<void> {
	console.log(`Welcome to labunbun — first-time setup. Press Enter to accept [defaults].\nProject directory: ${cwd}\n`);

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask: Ask = (q) => rl.question(q);

	try {
		const providerAnswer = await askChoice(ask, "Model provider", ["anthropic", "openai-compatible"], "anthropic");

		let apiKey: string | null = null;
		let baseUrl = "";
		let apiKeyEnvName = "CUSTOM_API_KEY";
		let modelId = "";
		let contextWindow = 128_000;
		let maxOutputTokens = 8_192;
		let reasoning = false;

		if (providerAnswer === "anthropic") {
			const pasted = await readMasked("API key (Enter if ANTHROPIC_API_KEY is already set): ");
			apiKey = pasted.trim() === "" ? null : pasted.trim();
		} else {
			baseUrl = (await ask("Base URL (e.g. https://api.example.com/v1): ")).trim();
			apiKeyEnvName = (await ask(`Env var NAME holding your API key [CUSTOM_API_KEY]: `)).trim() || "CUSTOM_API_KEY";
			modelId = (await ask("Model id as the provider names it: ")).trim();
			const ctxAnswer = Number(await ask(`Context window in tokens [128000]: `));
			contextWindow = Number.isFinite(ctxAnswer) && ctxAnswer > 0 ? ctxAnswer : 128_000;
			const outAnswer = Number(await ask(`Max output tokens [8192]: `));
			maxOutputTokens = Number.isFinite(outAnswer) && outAnswer > 0 ? outAnswer : 8_192;
			reasoning = (await askChoice(ask, "Reasoning-capable model?", ["y", "n"], "n")).startsWith("y");
			const pasted = await readMasked(
				`Paste the key value to store now, or Enter to set ${apiKeyEnvName} yourself later: `,
			);
			apiKey = pasted.trim() === "" ? null : pasted.trim();
		}

		// Asked, validated and re-asked rather than read as free text: a name that
		// is not a theme used to be rewritten to "auto" without a word, so the
		// setting the user then found in settings.json was one they never chose.
		const theme = await askChoice(ask, "Theme", WIZARD_THEME_CHOICES, WIZARD_THEME_DEFAULT, "dark/light… or auto");
		// One question with three answers rather than two yes/no ones. Two questions
		// can both be answered "yes" and the file would then hold two settings that
		// exclude each other, discovered the first time a key did the wrong thing.
		const editing = await askChoice(ask, "Editing model", WIZARD_EDITOR_CHOICES, "none", "vim, emacs, or none");

		const settings = buildWizardSettings({
			provider: providerAnswer === "anthropic" ? "anthropic" : "openai-compatible",
			apiKey,
			baseUrl,
			apiKeyEnvName,
			modelId,
			contextWindow,
			maxOutputTokens,
			reasoning,
			theme,
			vimMode: editing === "vim",
			emacsMode: editing === "emacs",
		});

		const path = userSettingsPath(home);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		console.log(`\nSettings written to ${path}. Type /help in a session to see commands.`);
	} catch {
		writeSettingsFile(userSettingsPath(home), {});
		console.log("\nSetup skipped — rerun without a settings file, or edit ~/.labunbun/settings.json.");
	} finally {
		rl.close();
	}
}

function writeSettingsFile(path: string, value: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
