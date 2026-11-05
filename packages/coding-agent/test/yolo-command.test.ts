/**
 * `/yolo` as a command, which is the only door.
 *
 * The distinctions under test are the ones a mode-based implementation would
 * get wrong for free: the trigger is a typed command rather than a row in the
 * picker or a key in the cycle, the confirmation is a typed phrase rather than
 * a choice, and nothing about the session's two axes moves when it is on or
 * off. The structural half at the bottom holds the same line from the outside:
 * no settings key, CLI flag, policy snapshot or worker host can carry it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, MODE_CHOICES, PERMISSION_MODES, type PermissionMode, type SandboxMode } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import {
	createStore,
	initialUiState,
	type PhraseConfirmRequest,
	type StatusCardData,
	type UiState,
} from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand, YOLO_CONFIRMATION_PHRASE } from "../src/interactive.ts";
import { validateModeFlags } from "../src/main.ts";
import { PermissionModeSchema } from "../src/settings.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const infoTexts = (store: { get: () => UiState }) =>
	store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");

function makeCtx(
	pair: { mode: PermissionMode; sandbox: SandboxMode } = { mode: "agent", sandbox: "workspace-write" },
	options: { policy?: boolean; confirmPhrase?: boolean } = {},
) {
	const home = mkdtempSync(join(tmpdir(), "lbb-yolo-"));
	const cwd = join(home, "project");
	const store = createStore<UiState>(initialUiState(false));
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		deps: { streamFn: faux.streamFn },
		permissionMode: pair.mode,
		sandbox: pair.sandbox,
	});

	const phraseRequests: PhraseConfirmRequest[] = [];
	let settlePhrase: ((confirmed: boolean) => void) | undefined;
	const cards: Array<StatusCardData | null> = [];
	const handle: Record<string, unknown> = {
		store,
		setModeLabel: (label: string) => store.set((s) => (s.modeLabel === label ? s : { ...s, modeLabel: label })),
		setStatusCard: (card: StatusCardData | null) => cards.push(card),
	};
	if (options.confirmPhrase !== false) {
		handle.confirmPhrase = (request: PhraseConfirmRequest) => {
			phraseRequests.push(request);
			return new Promise<boolean>((resolve) => {
				settlePhrase = resolve;
			});
		};
	}

	const ctx = {
		getSession: () => session,
		handle,
		home,
		cwd,
		settings: { permissions: { additionalDirectories: [] } },
		loadedSettings: {
			perSource: options.policy ? { policy: { disableBypassPermissionsMode: true } } : {},
			settings: {},
		},
		baseRules: [{ toolName: "Bash", behavior: "ask", source: "projectSettings" }],
		sessionRules: [],
		compaction: () => ({}),
		costTracker: {
			state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
			sessionState: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
		},
		mcpConnections: [],
		pendingMcpApprovals: [],
		sessionStore: () => undefined,
		theme: { theme: { name: "nord" }, available: ["dark", "nord"], problems: [] },
		thinkingLevel: () => undefined,
	} as unknown as AppCommandContext;

	return {
		ctx,
		store,
		session,
		phraseRequests,
		cards,
		answer: (confirmed: boolean) => settlePhrase?.(confirmed),
	};
}

describe("/yolo entry", () => {
	test("asks for the exact phrase, and enabling keeps both axes where they were", async () => {
		const h = makeCtx({ mode: "agent", sandbox: "workspace-write" });
		expect(handleAppCommand("/yolo", h.ctx)).toBe(true);
		expect(h.phraseRequests).toHaveLength(1);

		const request = h.phraseRequests[0];
		expect(request?.phrase).toBe(YOLO_CONFIRMATION_PHRASE);
		expect(request?.sandbox).toBe("workspace-write");
		expect(request?.off.join(" ")).toContain("classifier");
		expect(request?.on.join(" ")).toContain("Deny rules");
		expect(request?.note).toContain("next permission decision");

		h.answer(true);
		await delay(10);

		expect(h.session.yolo).toBe(true);
		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("workspace-write");
		expect(h.store.get().modeLabel).toBe("YOLO");
		expect(infoTexts(h.store)).toContain("YOLO on");
		// The durable trace names the sandbox the posture keeps, not only the word.
		expect(infoTexts(h.store)).toContain("sandbox workspace-write");
	});

	test("a refusal from the dialog changes nothing", async () => {
		const h = makeCtx();
		handleAppCommand("/yolo", h.ctx);
		h.answer(false);
		await delay(10);

		expect(h.session.yolo).toBe(false);
		expect(h.store.get().modeLabel).toBe("");
		expect(infoTexts(h.store)).toBe("YOLO not enabled.");
	});

	test.each([
		["plan mode", { mode: "plan" as const, sandbox: "workspace-write" as const }, {}, "plan mode"],
		[
			"a sandbox that is already off",
			{ mode: "agent" as const, sandbox: "danger-full-access" as const },
			{},
			"no sandbox",
		],
		[
			"a managed policy",
			{ mode: "agent" as const, sandbox: "workspace-write" as const },
			{ policy: true },
			"managed settings",
		],
	])("%s refuses before the dialog opens", (_label, pair, options, expected) => {
		const h = makeCtx(pair, options);
		handleAppCommand("/yolo", h.ctx);

		// The refusal is ahead of the phrase: spending the acknowledgment on a door
		// that cannot open is the exact waste the ordering exists to prevent.
		expect(h.phraseRequests).toHaveLength(0);
		expect(h.session.yolo).toBe(false);
		expect(infoTexts(h.store)).toContain(expected);
	});

	test("a host with no phrase surface has no way in", () => {
		const h = makeCtx(undefined, { confirmPhrase: false });
		handleAppCommand("/yolo", h.ctx);
		expect(h.session.yolo).toBe(false);
		expect(infoTexts(h.store)).toContain("needs an interactive phrase confirmation");
	});
});

describe("/yolo exit", () => {
	test("a second /yolo turns it off and restores the underlying label", async () => {
		const h = makeCtx({ mode: "agent", sandbox: "workspace-write" });
		handleAppCommand("/yolo", h.ctx);
		h.answer(true);
		await delay(10);
		expect(h.store.get().modeLabel).toBe("YOLO");

		handleAppCommand("/yolo", h.ctx);
		expect(h.session.yolo).toBe(false);
		expect(h.store.get().modeLabel).toBe("Agent");
		expect(infoTexts(h.store)).toContain("YOLO off · Agent (agent · sandbox workspace-write)");
	});

	test("/yolo off is the explicit spelling, and is harmless when it is already off", async () => {
		const h = makeCtx();
		handleAppCommand("/yolo", h.ctx);
		h.answer(true);
		await delay(10);
		handleAppCommand("/yolo off", h.ctx);
		expect(h.session.yolo).toBe(false);
		expect(h.store.get().modeLabel).toBe("Agent");

		handleAppCommand("/yolo off", h.ctx);
		expect(infoTexts(h.store)).toContain("YOLO is not on.");
	});

	test("a mode change clears it, and the label follows the new pair", async () => {
		const h = makeCtx({ mode: "agent", sandbox: "workspace-write" });
		handleAppCommand("/yolo", h.ctx);
		h.answer(true);
		await delay(10);

		handleAppCommand("/mode plan", h.ctx);
		expect(h.session.yolo).toBe(false);
		expect(h.store.get().modeLabel).toBe("Plan");
	});

	test("an unknown argument is a usage line and changes nothing", () => {
		const h = makeCtx();
		handleAppCommand("/yolo maybe", h.ctx);
		expect(h.phraseRequests).toHaveLength(0);
		expect(h.session.yolo).toBe(false);
		expect(infoTexts(h.store)).toContain("Usage: /yolo [on|off]");
	});
});

describe("the screens", () => {
	test("/status names YOLO in front of the pair, which is still what runs next", async () => {
		const h = makeCtx({ mode: "agent", sandbox: "workspace-write" });
		handleAppCommand("/yolo", h.ctx);
		h.answer(true);
		await delay(10);

		handleAppCommand("/status", h.ctx);
		expect(h.cards.at(-1)?.permissions).toBe("YOLO · Agent");
	});

	test("/permissions lists what is off, what is on, and marks ask rules ignored", async () => {
		const h = makeCtx();
		handleAppCommand("/yolo", h.ctx);
		h.answer(true);
		await delay(10);

		handleAppCommand("/permissions", h.ctx);
		const text = infoTexts(h.store);
		expect(text).toContain("YOLO: on — classifier off, ask rules ignored, approvals suppressed.");
		expect(text).toContain("Deny rules, hooks, and the sandbox still apply.");
		expect(text).toContain("ask (ignored under YOLO) Bash");
	});

	/**
	 * The policy line belongs on this screen even while YOLO is off, because the
	 * screen is where a user learns why `/yolo` will refuse. A session that looks
	 * eligible and a door that silently does not open is the confusing pairing
	 * this line exists to prevent.
	 */
	test("/permissions says when a managed policy forbids the door", () => {
		const h = makeCtx({ mode: "agent", sandbox: "workspace-write" }, { policy: true });
		handleAppCommand("/permissions", h.ctx);
		expect(infoTexts(h.store)).toContain(
			"Managed policy: bypass-permission modes are disabled — /yolo cannot be entered.",
		);
	});
});

/**
 * The structural half.
 *
 * These are source scans and enum walks rather than behavior, because the
 * failure they guard against is a second door appearing: a settings key, a CLI
 * flag, a resumable policy field, or a worker host carrying the posture. Each
 * one would pass every behavioral test above and quietly make the phrase
 * optional.
 */
describe("YOLO is not a mode, a setting, a flag or a resumable field", () => {
	const sourceOf = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

	test("neither the mode list nor the picker has a YOLO row", () => {
		expect(PERMISSION_MODES).not.toContain("yolo");
		expect(MODE_CHOICES.some((choice) => choice.id === "yolo" || choice.label === "YOLO")).toBe(false);
	});

	test("the settings schema and the CLI validator both refuse the name", () => {
		expect(PermissionModeSchema.safeParse("yolo").success).toBe(false);
		const flags = validateModeFlags({ permissionMode: "yolo", sandbox: null, network: null });
		expect(flags.mode).toBeUndefined();
		expect(flags.error).toBeDefined();
	});

	test.each([
		["settings.ts", "../src/settings.ts"],
		["policy-snapshot.ts", "../src/policy-snapshot.ts"],
		["main.ts", "../src/main.ts"],
		["acp.ts", "../src/acp.ts"],
		["headless.ts", "../src/headless.ts"],
	])("%s has no YOLO door", (_label, relative) => {
		// The word may not appear at all: each of these is a place a flag or a
		// persisted field would have to be spelled, and an absent word is the
		// strongest available statement that none exists.
		expect(sourceOf(relative)).not.toMatch(/yolo/i);
	});
});
