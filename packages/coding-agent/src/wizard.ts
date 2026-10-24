/**
 * First-run setup. When there is no settings file yet and a human is on a TTY,
 * a short guided flow replaces the dead end of "Missing API key — set
 * ANTHROPIC_API_KEY" as a user's very first experience.
 *
 * The flow, in the order it runs: what this machine already holds (the
 * detection block), how the user wants to pay for it (the four-way question —
 * the two sign-in rows drive the real login flows), the questions that already
 * existed (theme, editing model), the write, and — only when the detection
 * block found a source — the import offer, run as a dry run the user confirms.
 * The import runs after the write, not before: `--force` stays off, so the
 * import only adds what is missing and every key the wizard just wrote
 * survives the merge by construction (see `offerImport`).
 *
 * Storage rules, matching the rest of the config system:
 * - The key VALUE goes into `settings.env`, which applySettingsEnv applies at
 *   startup (real environment variables always win over it).
 * - OpenAI-compatible providers store only the env var NAME in their spec.
 * - A sign-in itself stores nothing here — the credential store holds it; only
 *   the model it implies is written (a ChatGPT credential is useless with any
 *   other model).
 *
 * Cancel writes an empty object so the wizard does not re-trigger on every
 * start; the user can configure by hand or via migrate instead. No answer may
 * leave a state the app refuses to start in: a flow that ends with no
 * credential at all still writes the file with whatever was chosen, and the
 * REPL mounts anyway carrying the notice that names the fix.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { apiKeyEnvNames, listModels } from "@labunbun/ai";
import { AUTO_THEME_NAME, BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import { runChatGptLoginCli } from "./chatgpt-login.ts";
import { runClaudeLoginCli } from "./claude-login.ts";
import { detectSubscriptionSignIns, type SubscriptionSignIns } from "./credential-presence.ts";
// Only the type is taken from `./migrate.ts`; the value is imported where the
// import offer actually runs. `interactive.ts` imports this module on every
// REPL start, and a static value import here would pull every migration source
// reader into a start that mostly exists to reach the REPL.
import type { RunMigrationOptions } from "./migrate.ts";
import { detectSources, MIGRATION_SOURCE_LABELS, type MigrationSourceId, SOURCE_ROOTS } from "./migrate-types.ts";
import { writeUserSettingsPatch } from "./user-settings.ts";

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
	provider: "anthropic" | "chatgpt" | "openai-compatible";
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

/**
 * The model the anthropic answer runs on. A constant because two readers need
 * the same reference: the settings this module builds, and {@link detectedAnthropicEnv},
 * which resolves the row to learn which variables it reads.
 */
const WIZARD_ANTHROPIC_MODEL = "anthropic/claude-sonnet-5";

/**
 * The model a ChatGPT sign-in implies. The sign-in row exists because that
 * credential is useless with any other model (decision 3 in the design note),
 * so choosing it writes this reference. Spelled `provider/id` the way
 * `settings.model` is; wizard.test.ts resolves it against `listModels()`, so a
 * registry rename cannot leave a dead string here.
 */
export const WIZARD_CHATGPT_MODEL = "chatgpt/gpt-6-astra";

/** Pure translation of answers into a schema-valid settings object. */
export function buildWizardSettings(a: WizardAnswers): Record<string, unknown> {
	const model =
		a.provider === "anthropic"
			? WIZARD_ANTHROPIC_MODEL
			: a.provider === "chatgpt"
				? WIZARD_CHATGPT_MODEL
				: `custom/${a.modelId}`;
	const base: Record<string, unknown> = {
		model,
		theme: a.theme,
		vimMode: a.vimMode,
		emacsMode: a.emacsMode,
	};

	if (a.provider === "chatgpt") {
		// The credential is the sign-in, which the login flow already stored.
		// The file's whole job for this answer is the model that credential
		// can run; there is no key to write and no provider spec to describe.
		return base;
	}

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

/**
 * A bare Enter takes `auto` now that the terminal probe exists
 * (`packages/tui/src/detect-appearance.ts`): a first-run user should get the
 * theme that matches the terminal they are already looking at, and `auto` is
 * the one answer that cannot be wrong about it.
 */
export const WIZARD_THEME_DEFAULT: string = AUTO_THEME_NAME;

/**
 * The editing models the wizard offers, in the order they read best: nothing
 * first, because it is the answer most people want and a bare Enter must be the
 * one that needs no thought.
 */
export const WIZARD_EDITOR_CHOICES: readonly string[] = ["none", "vim", "emacs"];

/** Which row of the payment question a bare Enter takes: `1`–`4`, top to bottom. */
export type WizardProviderRow = "1" | "2" | "3" | "4";

/**
 * The row that is already true for this machine — Codex's default rule, same
 * shape (`onboarding_screen.rs:169-175`: the sign-in when the account path is
 * the allowed one, the key otherwise). A Claude config on disk means the Claude
 * sign-in, a key variable already in the environment means the API-key row, and
 * a bare machine gets row `1` because a sign-in needs nothing typed.
 */
export function wizardProviderDefault(found: {
	claudeConfigured: boolean;
	envKeysPresent: boolean;
}): WizardProviderRow {
	if (!found.claudeConfigured && found.envKeysPresent) return "3";
	return "1";
}

/**
 * The detection block's rows, one per finding, or none for a bare machine —
 * the caller prints nothing then, which is the app's existing habit
 * (`interactive.ts:1963-1965`).
 *
 * A source row names its tree via `SOURCE_ROOTS` (the home-relative spelling
 * that exists to render a label), not a count: counts would mean running every
 * source's read — the plan's work — before the user has answered anything.
 */
export function wizardDetectionLines(found: {
	sources: readonly MigrationSourceId[];
	envKeys: readonly string[];
	signIns: SubscriptionSignIns;
}): string[] {
	const lines = found.sources.map((source) => `${MIGRATION_SOURCE_LABELS[source]} — ~/${SOURCE_ROOTS[source]}`);
	for (const key of found.envKeys) lines.push(`${key} is set`);
	if (found.signIns.claude) lines.push("Claude subscription signed in");
	if (found.signIns.chatgpt) lines.push("ChatGPT subscription signed in");
	if (found.signIns.gemini) lines.push("Gemini subscription signed in");
	return lines;
}

/**
 * The import question, or undefined when there is nothing to offer — the
 * caller asks nothing then, because a question whose only true answer is "no"
 * is not a question.
 *
 * The wording deliberately does not carry the design sketch's "and this
 * project's conversations": history is the one category this offer leaves out
 * (it is the slowest and has the least claim on a first launch), and a question
 * must not promise what its own plan will not count. `/yoshi` keeps offering it.
 */
export function importOfferLine(sources: readonly MigrationSourceId[]): string | undefined {
	if (sources.length === 0) return undefined;
	const names = sources.map((source) => MIGRATION_SOURCE_LABELS[source]).join(", ");
	return `Import from ${names}? Settings, MCP servers, skills and agents. You will see the full plan before anything is written.`;
}

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
 * Every environment variable any shipped model row reads, that is set — the
 * computation `/doctor` already makes (`doctor.ts:128-129`), hoisted rather
 * than copied: a hand-kept list of names is a list that goes stale silently.
 */
function presentEnvKeys(): string[] {
	const keys = [...new Set(listModels().flatMap((model) => apiKeyEnvNames(model)))].sort();
	return keys.filter((key) => process.env[key]);
}

/**
 * The variables the anthropic answer's row reads, that are set — resolved
 * through the registry so the wizard cannot name a variable the row does not
 * read (the row names `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`).
 */
function detectedAnthropicEnv(): string[] {
	const row = listModels().find((model) => `${model.provider}/${model.id}` === WIZARD_ANTHROPIC_MODEL);
	return row ? apiKeyEnvNames(row).filter((name) => process.env[name]) : [];
}

/**
 * Screen C as a console question: dry run first, the report printed, one
 * confirm over the whole plan, `--force` off throughout — the same shape
 * `/yoshi` walks (`migrate-wizard.ts`), minus the category questions.
 *
 * After the write and never before it. The dry run's plan counts what applying
 * would change in the tree as it stands; asking first would count writes the
 * wizard's own file then alters, and the confirm would be over a plan that no
 * longer describes the apply. Since the wizard's answers are on disk by now and
 * `--force` is off, `claimScalar` skips every key already present — the import
 * can add, never clobber, and the model chosen above survives by construction.
 */
async function offerImport(
	ask: Ask,
	opts: { home: string; cwd: string; sources: readonly MigrationSourceId[] },
): Promise<boolean> {
	const question = importOfferLine(opts.sources);
	if (!question) return false;
	if ((await askChoice(ask, question, ["y", "n"], "y", "Y/n")) !== "y") return false;

	const { runMigration } = await import("./migrate.ts");
	const options: RunMigrationOptions = {
		home: opts.home,
		cwd: opts.cwd,
		only: ["settings", "assets"],
		from: opts.sources.join(","),
	};
	const preview = runMigration(options);
	if (preview.error) {
		console.log(`  ${preview.error}`);
		return false;
	}
	console.log(`\n${preview.report}`);
	// Nothing to confirm: the report above already says why each candidate was
	// left alone, and asking to apply zero files is a question with one answer.
	if (preview.plan.writes.length === 0) {
		console.log("Nothing to write — the report above says why.");
		return false;
	}

	const confirm = await askChoice(
		ask,
		`Apply these ${preview.plan.writes.length} file(s)?`,
		["apply", "cancel"],
		"apply",
		"apply/cancel",
	);
	if (confirm !== "apply") {
		console.log("Nothing written (dry run only).");
		return false;
	}

	const applied = runMigration({ ...options, apply: true });
	if (applied.error) {
		console.log(`  ${applied.error}`);
		return false;
	}
	// No "restart to pick up" here, unlike `/yoshi`: the settings load happens
	// after this wizard returns (`interactive.ts:381-384`), so what just landed
	// is what this very session runs on.
	console.log(applied.report);
	// True means an apply ran and reported no error — the caller records that
	// fact. Nothing branches on it here: every earlier exit is a false whether
	// the user declined or the machine had nothing to offer.
	return true;
}

export interface FirstRunRecord {
	offeredAt: string;
	signedIn: SubscriptionSignIns;
	imported: boolean;
}

/**
 * Screen G: what the first run did, for the record. `signIns` is the state at
 * the end of the run — a row-1/row-2 sign-in that finished flips its flag — and
 * `imported` says an apply ran, not how many files it wrote (under the merge
 * rules "two files" and "none needed" both look like success).
 *
 * Recorded, deliberately not read back: the startup notice about a missing
 * credential stays condition-driven. This record is a log of one past run; a
 * sign-in can expire or be revoked, so a record consulted as a suppressor
 * would silence the notice exactly where it is true again.
 */
export function firstRunRecord(opts: { signIns: SubscriptionSignIns; imported: boolean; now: Date }): FirstRunRecord {
	return {
		offeredAt: opts.now.toISOString(),
		// Spread, not a hand-picked pair: a sign-in kind added later is recorded
		// by its own probe rather than silently dropped from the record.
		signedIn: { ...opts.signIns },
		imported: opts.imported,
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Run the guided setup and write the settings file. Ctrl+C anywhere lands in
 * the catch, leaving a minimal valid file so we do not re-prompt forever —
 * but only when nothing was written yet, so a failure after the write cannot
 * blank the answers that just landed.
 */
export async function runWizard(cwd: string, home = homedir()): Promise<void> {
	console.log(`Welcome to labunbun — first-time setup. Press Enter to accept [defaults].\nProject directory: ${cwd}\n`);

	const openPrompt = () => createInterface({ input: process.stdin, output: process.stdout });
	let rl = openPrompt();
	const ask: Ask = (q) => rl.question(q);
	/**
	 * Runs a step that may read the terminal itself with the prompt detached, then
	 * attaches a fresh one. The masked key and a sign-in's pasted-code fallback each
	 * close a readline interface when they finish, and closing one pauses stdin and
	 * drops raw mode, so a prompt still attached would never receive another answer.
	 * An attached prompt also echoes what the step reads, which would print a pasted
	 * key on screen.
	 */
	const withTerminal = async <T>(step: () => Promise<T>): Promise<T> => {
		rl.close();
		try {
			return await step();
		} finally {
			rl = openPrompt();
		}
	};
	let wrote = false;

	try {
		// Screen A: what this machine already knows. Printed only when it is
		// non-empty; silence is the app's existing habit.
		const sources = detectSources(home);
		const envKeys = presentEnvKeys();
		const signIns = await detectSubscriptionSignIns({ home });
		// Flipped true when a row-1/row-2 sign-in finishes with code 0, so the
		// record below states what is on disk when the run ends — the probe just
		// above ran before the login flows did.
		const signedIn = { ...signIns };
		const found = wizardDetectionLines({ sources, envKeys, signIns });
		if (found.length > 0) {
			console.log("Found on this machine:");
			for (const line of found) console.log(`  ${line}`);
			console.log("");
		}

		// Screen B: one question with four answers, defaulted to the row that is
		// already true here.
		const row = await askChoice(
			ask,
			[
				"How do you want to use labunbun?",
				"  1. Sign in with a Claude subscription      a browser opens; no API key needed",
				"  2. Sign in with a ChatGPT subscription     the ChatGPT models, on your plan",
				"  3. Use an API key                          paste it now, or export it yourself",
				"  4. Use an OpenAI-compatible endpoint       DeepSeek, Kimi, GLM, a local daemon",
			].join("\n"),
			["1", "2", "3", "4"],
			wizardProviderDefault({ claudeConfigured: sources.includes("claude-code"), envKeysPresent: envKeys.length > 0 }),
			"1/2/3/4",
		);

		let provider: WizardAnswers["provider"] = "anthropic";
		let apiKey: string | null = null;
		let baseUrl = "";
		let apiKeyEnvName = "CUSTOM_API_KEY";
		let modelId = "";
		let contextWindow = 128_000;
		let maxOutputTokens = 8_192;
		let reasoning = false;

		if (row === "1" || row === "2") {
			// The real flows, wired to the terminal: row 1 falls back to a pasted
			// `code#state`, row 2 to a device code, so neither needs a reachable
			// loopback. A failed sign-in returns non-zero rather than throwing, and
			// the flow continues either way — if no credential landed, the REPL
			// still mounts and the startup notice names the fix.
			const code = await withTerminal(() => (row === "1" ? runClaudeLoginCli({ home }) : runChatGptLoginCli({ home })));
			if (code === 0) {
				provider = row === "1" ? "anthropic" : "chatgpt";
				if (row === "1") signedIn.claude = true;
				else signedIn.chatgpt = true;
			} else {
				const retry = row === "1" ? "/login" : "/login chatgpt";
				console.log(`  Sign-in did not finish — continuing. Run ${retry} in a session to retry.`);
			}
		} else if (row === "3") {
			// The env pre-detection Codex's key screen has (`auth.rs:710-718`): a
			// variable that is already set skips the paste and says so.
			const detected = detectedAnthropicEnv();
			if (detected.length > 0) {
				console.log(`  Detected ${detected.join(" or ")} in the environment — no key needed here.`);
			} else {
				const pasted = await withTerminal(() => readMasked("API key (Enter if ANTHROPIC_API_KEY is already set): "));
				apiKey = pasted.trim() === "" ? null : pasted.trim();
			}
		} else {
			provider = "openai-compatible";
			baseUrl = (await ask("Base URL (e.g. https://api.example.com/v1): ")).trim();
			apiKeyEnvName = (await ask(`Env var NAME holding your API key [CUSTOM_API_KEY]: `)).trim() || "CUSTOM_API_KEY";
			modelId = (await ask("Model id as the provider names it: ")).trim();
			const ctxAnswer = Number(await ask(`Context window in tokens [128000]: `));
			contextWindow = Number.isFinite(ctxAnswer) && ctxAnswer > 0 ? ctxAnswer : 128_000;
			const outAnswer = Number(await ask(`Max output tokens [8192]: `));
			maxOutputTokens = Number.isFinite(outAnswer) && outAnswer > 0 ? outAnswer : 8_192;
			reasoning = (await askChoice(ask, "Reasoning-capable model?", ["y", "n"], "n")).startsWith("y");
			const pasted = await withTerminal(() =>
				readMasked(`Paste the key value to store now, or Enter to set ${apiKeyEnvName} yourself later: `),
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
			provider,
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
		wrote = true;
		console.log(`\nSettings written to ${path}.`);

		// Screen C, after the write — the ordering reasoning is in offerImport.
		const imported = await offerImport(ask, { home, cwd, sources });

		// Screen G: the record of what this run did. Merged through the settings
		// patch so it cannot disturb the answers just written, and in its own
		// try — the catch below reads any throw after the write as a failed
		// import, which a failed note is not.
		try {
			writeUserSettingsPatch({ firstRun: firstRunRecord({ signIns: signedIn, imported, now: new Date() }) }, home);
		} catch (error) {
			// One line, never fatal: the file is already written and the session
			// starts on it; a note that cannot land is not worth a failed start.
			console.log(`  (first-run note not recorded: ${messageOf(error)})`);
		}

		console.log("Type /help in a session to see commands.");
	} catch (error) {
		if (wrote) {
			// The throw came after the write — the import half. The file stands;
			// say where to finish the job rather than pretending nothing happened.
			console.log(`\nThe import did not finish (${messageOf(error)}). Run /yoshi in a session to try again.`);
		} else {
			// Cancel writes an empty object so the wizard does not re-trigger on
			// every start. The second clause is the changed part: the session
			// starts regardless now, so the repair happens inside it.
			writeSettingsFile(userSettingsPath(home), {});
			console.log(
				"\nSetup skipped — the session starts anyway. Run /login or /yoshi in it, or edit ~/.labunbun/settings.json.",
			);
		}
	} finally {
		rl.close();
	}
}

function writeSettingsFile(path: string, value: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
