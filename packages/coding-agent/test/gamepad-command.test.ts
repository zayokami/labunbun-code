/**
 * `/gamepad` — the command that turns a controller on and reports on it.
 *
 * Two things are being tested, and the second is the one with teeth. The first
 * is that the command says something true: the settings file it writes, the
 * status it prints, the mapping table it shows. The second is that it writes to
 * the user's own file *without flattening it* — `/gamepad off` must not take a
 * hand-written `bindings` block with it.
 *
 * The controller is the faux source: the whole app layer (settings → config →
 * runtime → service → bridge) runs for real, and the pad answers to the test
 * rather than to a USB port. Every test runs against a throwaway home.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createFauxSource, type FauxSource, type PadSourceDevice, padPalette } from "@labunbun/gamepad";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { attachedTwice } from "../../gamepad/test/devices.ts";
import { CROSS, usbBytes } from "../../gamepad/test/reports.ts";
import { createPadRuntime, createPadWatch, type PadRuntime, padConfigFrom } from "../src/gamepad-runtime.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";
import { type Settings, SettingsSchema } from "../src/settings.ts";

/** The two colours the lightbar would take, which none of these tests assert on. */
const PALETTE = { accent: "cyan", alert: "magenta" };

/** Every runtime a test built, so the suite can close their handles and timers. */
const live: Array<{ pad: PadRuntime; stop: () => void }> = [];

afterEach(() => {
	for (const { pad, stop } of live.splice(0)) {
		stop();
		pad.close();
	}
});

function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function savedSettings(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(home, ".labunbun", "settings.json"), "utf8"));
}

/**
 * A running session: real settings, a real runtime over the faux source, and a
 * store for the lines the command pushes.
 *
 * `padConfigFrom` is the production path from a settings file to a config, and
 * it is used here rather than a hand-built object: a test that assembled the
 * config itself would pass while `/gamepad` read a config the app never builds.
 */
function harness(options: { settings?: Record<string, unknown>; home?: string; devices?: PadSourceDevice[] } = {}) {
	const home = options.home ?? mkdtempSync(join(tmpdir(), "lbb-gamepad-"));
	const settings: Settings = SettingsSchema.parse(options.settings ?? {});
	const source: FauxSource = createFauxSource(options.devices);
	const pad = createPadRuntime(padConfigFrom(settings), { source, palette: padPalette(PALETTE) });
	const store = createStore<UiState>({ ...initialUiState() });

	// The app's own watch, with the app's own line writer (`pushInfo`, which is
	// module-private in interactive.ts and reproduced here as the one line it is).
	// A stand-in that counted toggles would have let the throttle inside the real
	// watch go untested, and the throttle is the part that can flood a transcript.
	const watchLines: string[] = [];
	const padWatch = createPadWatch(pad.service, (line) => {
		watchLines.push(line);
		store.set((s) => ({ ...s, entries: [...s.entries, { kind: "info", text: line }] }));
	});
	live.push({ pad, stop: () => padWatch.stop() });

	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const ctx = {
		getSession: () => session,
		sessionRef: session,
		handle: { store },
		home,
		cwd: process.cwd(),
		settings,
		loadedSettings: { settings, sources: {}, perSource: {}, ignoredKeys: [] },
		costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } },
		baseRules: [],
		sessionRules: [],
		commands: [],
		pad,
		padWatch,
		compaction: () => ({}),
		mcpConnections: [],
		mcpConfig: {},
		pendingMcpApprovals: [],
		sessionStore: () => undefined,
		theme: { theme: { name: "dark" }, available: ["dark"], problems: [] },
		hotSwapSession: async () => {},
		switchModel: () => false,
	} as unknown as AppCommandContext;

	return { ctx, store, home, pad, source, watchLines, padWatch };
}

/** Let a command's asynchronous half land (the `.then` after `setEnabled`). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function infoText(store: { get: () => UiState }): string {
	return store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");
}

/** The mapping rows the table marked as changed from the default. */
function markedRows(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => line.endsWith("  *"))
		.map((line) => line.trim().split(/\s+/)[0]);
}

describe("/gamepad with no argument", () => {
	test("prints the mapping, which is the manual", () => {
		const { ctx, store } = harness();
		expect(handleAppCommand("/gamepad", ctx)).toBe(true);

		const text = infoText(store);
		// The button ids are the names the settings file writes, so they appear.
		expect(text).toContain("cross");
		expect(text).toContain("confirm");
		expect(text).toContain("touchpad");
		expect(text).toContain("status");
		// Nothing has been changed, so nothing is starred.
		expect(markedRows(text)).toEqual([]);
	});

	test("stars the rows the user moved", () => {
		const { ctx, store } = harness({ settings: { gamepad: { bindings: { cross: "cancel" } } } });
		handleAppCommand("/gamepad", ctx);
		expect(markedRows(infoText(store))).toEqual(["cross"]);
	});

	test("an unknown subcommand lists the ones that exist", () => {
		const { ctx, store } = harness();
		handleAppCommand("/gamepad sideways", ctx);
		expect(infoText(store)).toContain("Unknown: /gamepad sideways");
	});
});

describe("/gamepad on and off", () => {
	test("on connects the pad, says so, and remembers the choice", async () => {
		const { ctx, store, home, pad } = harness();

		handleAppCommand("/gamepad on", ctx);
		await settle();

		expect(pad.service.status().phase).toBe("connected");
		expect(infoText(store)).toContain("Gamepad connected");
		expect(savedSettings(home)).toEqual({ gamepad: { enabled: true } });
	});

	test("off disconnects, stops a running watch, and remembers that too", async () => {
		const { ctx, store, home, pad, padWatch } = harness();

		handleAppCommand("/gamepad on", ctx);
		await settle();
		handleAppCommand("/gamepad watch", ctx);
		expect(padWatch.watching).toBe(true);

		handleAppCommand("/gamepad off", ctx);
		await settle();

		expect(pad.service.status().phase).toBe("off");
		expect(infoText(store)).toContain("Gamepad off");
		// A watch with nothing behind it would keep printing the last sample forever.
		expect(padWatch.watching).toBe(false);
		expect(savedSettings(home)).toEqual({ gamepad: { enabled: false } });
	});

	test("the write is nested: a hand-written bindings block survives a toggle", async () => {
		// The bug this whole nested writer exists for. `/gamepad off` replaces the
		// `enabled` field and leaves the rest of the block as the user wrote it.
		const home = mkdtempSync(join(tmpdir(), "lbb-gamepad-"));
		writeJson(join(home, ".labunbun", "settings.json"), {
			theme: "nord",
			gamepad: { bindings: { cross: "none" }, phrases: ["run the tests"] },
		});
		const { ctx } = harness({ home });

		handleAppCommand("/gamepad off", ctx);
		await settle();

		expect(savedSettings(home)).toEqual({
			theme: "nord",
			gamepad: { bindings: { cross: "none" }, phrases: ["run the tests"], enabled: false },
		});
	});
});

describe("/gamepad approve", () => {
	test("is off unless asked, and toggling it says what it now means", () => {
		const { ctx, store, home, pad } = harness();
		expect(pad.bridge.allowApprove).toBe(false);

		handleAppCommand("/gamepad approve", ctx);
		expect(pad.bridge.allowApprove).toBe(true);
		expect(infoText(store)).toContain("✕ may answer a permission dialog");

		handleAppCommand("/gamepad approve", ctx);
		// The bridge is what a permission dialog reads at press time, and the file
		// follows it in both directions — a saved "on" with a bridge saying off, or
		// the reverse, is a switch nobody would believe.
		expect(pad.bridge.allowApprove).toBe(false);
		expect(savedSettings(home)).toEqual({ gamepad: { allowApprove: false } });
	});

	test("on and off are absolute, not toggles", () => {
		const { ctx, pad } = harness();
		handleAppCommand("/gamepad approve on", ctx);
		handleAppCommand("/gamepad approve on", ctx);
		expect(pad.bridge.allowApprove).toBe(true);
		handleAppCommand("/gamepad approve off", ctx);
		expect(pad.bridge.allowApprove).toBe(false);
	});

	test("a nonsense argument changes nothing and says the usage", () => {
		const { ctx, store, pad } = harness();
		handleAppCommand("/gamepad approve maybe", ctx);
		expect(pad.bridge.allowApprove).toBe(false);
		expect(infoText(store)).toContain("Usage: /gamepad approve [on|off]");
	});
});

describe("/gamepad status", () => {
	test("reports the approval state and how many bindings were changed", () => {
		const { ctx, store } = harness({
			settings: { gamepad: { bindings: { cross: "cancel", r2: "command:/status" } } },
		});

		handleAppCommand("/gamepad status", ctx);

		const text = infoText(store);
		expect(text).toContain("approvals: off");
		expect(text).toContain("2 changed from the default");
		// Nothing was unreadable, so the word does not appear at all.
		expect(text).not.toContain("unreadable");
		// One link is not a fact worth a line: the transport above already says it.
		expect(text).not.toContain("links:");
	});

	test("a pad attached twice names both links, and which one it reads", async () => {
		// The state that used to be invisible: a cable in *and* the pad still
		// switched on, so the OS lists two collections of one controller. Both are
		// written to, and the card says so — otherwise "the lightbar does nothing"
		// reads as a broken pad instead of as a link the pad is not obeying.
		const [wireless, wired] = attachedTwice();
		const { ctx, store } = harness({ devices: [wireless, wired] });

		handleAppCommand("/gamepad on", ctx);
		await settle();
		handleAppCommand("/gamepad status", ctx);

		expect(infoText(store)).toContain("links: usb + bluetooth (reading usb)");
	});

	test("names an unreadable binding, which is the only place a typo is visible", () => {
		const { ctx, store } = harness({ settings: { gamepad: { bindings: { cros: "confirm" } } } });

		handleAppCommand("/gamepad status", ctx);

		const text = infoText(store);
		expect(text).toContain("1 unreadable");
		expect(text).toContain("cros");
	});
});

describe("/gamepad watch and list", () => {
	test("watch toggles, and says which of the two states it is in", () => {
		const { ctx, store, padWatch } = harness();

		handleAppCommand("/gamepad watch", ctx);
		expect(padWatch.watching).toBe(true);
		expect(infoText(store)).toContain("Watching the controller");
		handleAppCommand("/gamepad watch", ctx);
		expect(padWatch.watching).toBe(false);
		expect(infoText(store)).toContain("Stopped watching the controller.");
	});

	test("a sample is printed once, not once per poll", async () => {
		// The throttle that keeps a held stick from flooding the transcript, through
		// the real watch: the pad sits still, so the same bytes arrive at every poll
		// and only the first one is worth a line.
		const { ctx, store, pad, source, watchLines } = harness();
		handleAppCommand("/gamepad on", ctx);
		await settle();
		source.push(usbBytes(CROSS));

		handleAppCommand("/gamepad watch", ctx);
		await new Promise((resolve) => setTimeout(resolve, 260));

		// The push landed on a live pad: without this the empty line list below
		// would pass for the wrong reason.
		expect(pad.service.status().phase).toBe("connected");
		expect(watchLines).toHaveLength(1);
		expect(watchLines[0]).toContain("usb 64B");
		expect(watchLines[0]).toContain("cross");
		expect(watchLines[0]).toContain("battery 10/10");
		// It reached the transcript, not just the recorded list.
		expect(infoText(store)).toContain("usb 64B");
	});

	test("list names the attached device and the interface it is on", () => {
		const { ctx, store } = harness();
		handleAppCommand("/gamepad list", ctx);
		const text = infoText(store);
		// The model name from the ids, not the USB product string the device also
		// carries: "Wireless Controller" is what every DS4 clone calls itself.
		expect(text).toContain("DualShock 4 v2");
		expect(text).toContain("interface 3");
		expect(text).not.toContain("no reports");
	});
});

describe("/gamepad without a runtime", () => {
	test("says there is no controller rather than throwing", () => {
		// A caller that built a context without a pad — a test, an embedder. The
		// command is dispatched by name, so it has to answer.
		const { ctx, store } = harness();
		const bare = { ...ctx, pad: null } as unknown as AppCommandContext;

		expect(handleAppCommand("/gamepad", bare)).toBe(true);
		expect(handleAppCommand("/gamepad on", bare)).toBe(true);
		expect(infoText(store)).toContain("No controller in this session.");
	});
});
