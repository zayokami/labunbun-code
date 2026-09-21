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
import {
	createFauxSource,
	type FauxSource,
	PAD_RUMBLE,
	PAD_TOUCH_IDS,
	type PadSourceDevice,
	padPalette,
} from "@labunbun/gamepad";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { attachedTwice } from "../../gamepad/test/devices.ts";
import { CROSS, usbBytes } from "../../gamepad/test/reports.ts";
import {
	createPadRuntime,
	createPadWatch,
	formatPadStatus,
	type PadRuntime,
	padConfigFrom,
} from "../src/gamepad-runtime.ts";
import { type AppCommandContext, appCommandTable, handleAppCommand } from "../src/interactive.ts";
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

/**
 * Let a command's asynchronous half land (the `.then` after `setEnabled`), or —
 * when a test names a longer wait — let a buzz that arrived with the connection
 * finish, so that "nothing was written" cannot be a packet still in flight.
 */
const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The card `/gamepad status` prints, without the command that prints it. */
function card(pad: PadRuntime, now = Date.now()): string {
	return formatPadStatus(pad.service.status(), pad.config, pad.service, now);
}

function infoText(store: { get: () => UiState }): string {
	return store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");
}

/**
 * The sub-arguments `/gamepad` dispatches, read from the source.
 *
 * The same trick `help-commands.test.ts` plays on the app's own switch: a list a
 * user reads has to be checked against the code that answers, or it drifts. `on`,
 * `off` and `approve` are guarded by `if (arg === …)` rather than by a `case`, so
 * both shapes are read; the slice ends where the `/gamepad` body does, at the next
 * top-level command.
 */
function dispatchedPadArgs(): string[] {
	const source = readFileSync(join(import.meta.dir, "..", "src", "interactive.ts"), "utf8");
	const start = source.indexOf('\t\tcase "/gamepad":');
	const end = source.indexOf('\n\t\tcase "/', start + 1);
	const body = source.slice(start, end === -1 ? undefined : end);
	const found = new Set<string>();
	for (const match of body.matchAll(/(?:case |arg === )"([a-z-]+)"/g)) {
		const name = match[1];
		if (name !== undefined) found.add(name);
	}
	return [...found].sort();
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

	test("prints the surface's gestures under their own heading", () => {
		const { ctx, store } = harness();
		handleAppCommand("/gamepad", ctx);

		const text = infoText(store);
		expect(text).toContain("Touch surface");
		// Listed by the names the settings file takes, which is the whole reason this
		// table prints ids at all — and a row is a row: the count of them is the family.
		for (const id of PAD_TOUCH_IDS) expect(text).toContain(`\n  ${id}`);
	});

	test("stars the rows the user moved", () => {
		const { ctx, store } = harness({ settings: { gamepad: { bindings: { cross: "cancel" } } } });
		handleAppCommand("/gamepad", ctx);
		expect(markedRows(infoText(store))).toEqual(["cross"]);
	});

	test("stars a gesture the user moved, exactly as it stars a button", () => {
		// One table, one marker: a gesture a user rebound is a line that would
		// surprise them in the mapping, which is what the star means.
		const { ctx, store } = harness({ settings: { gamepad: { bindings: { "touch-tap": "none" } } } });
		handleAppCommand("/gamepad", ctx);
		expect(markedRows(infoText(store))).toEqual(["touch-tap"]);
	});

	test("an unknown subcommand lists the ones that exist", () => {
		const { ctx, store } = harness();
		handleAppCommand("/gamepad sideways", ctx);
		expect(infoText(store)).toContain("Unknown: /gamepad sideways");
	});

	test("every sub-argument the switch answers to is named where a user can find it", () => {
		// The two places the sub-arguments are written down, and neither is a manual:
		// the line a typo gets back, and the `/help` row. `/gamepad reset` is the rescue
		// for a pad that is answering wrongly, which is exactly the moment nobody is
		// going to read the source — so the list is checked against the switch itself,
		// the way `help-commands.test.ts` checks the app's table against its switch.
		const { ctx, store } = harness();
		handleAppCommand("/gamepad sideways", ctx);
		const usage = infoText(store);
		const row = appCommandTable().find(([name]) => name === "/gamepad")?.[1] ?? "";

		// The scan has to be finding something, or the loop below is vacuous.
		expect(dispatchedPadArgs().length).toBeGreaterThan(3);
		for (const arg of dispatchedPadArgs()) {
			expect(usage, `${arg} is dispatched but not offered in the usage line`).toContain(arg);
			expect(row, `${arg} is dispatched but not in the /help row`).toContain(arg);
		}
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

	test("reset lets go of the pad and opens it again, without waiting", async () => {
		const { ctx, store, pad, source } = harness();
		handleAppCommand("/gamepad on", ctx);
		await settle();
		expect(source.opened()).toHaveLength(1);
		const written = source.writes().length;

		// The pad is answering wrongly, not not at all: the rescue is a fresh handle,
		// not a search. Nothing is waited for — the reconnect timer a lost pad would
		// schedule is deliberately not started — so the card after it says connected,
		// and the pad has been told everything again.
		handleAppCommand("/gamepad reset", ctx);

		expect(source.opened()).toHaveLength(2);
		expect(source.writes().length).toBeGreaterThan(written);
		expect(infoText(store)).toContain("Gamepad connected");

		// And the handle it opened is the live one: a report on it comes back as the
		// app's own reading of the pad, which is the whole point of the rescue.
		source.push(usbBytes(CROSS));
		expect(pad.service.lastSample()?.state.buttons).toContain("cross");
	});

	test("reset does nothing at all when the controller is switched off", async () => {
		const { ctx, pad, source } = harness();
		expect(pad.service.status().phase).toBe("off");
		const opened = source.opened().length;

		handleAppCommand("/gamepad reset", ctx);

		expect(source.opened()).toHaveLength(opened);
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
		// Both families, counted separately: a line that said "25 buttons" would be
		// describing a table this is not.
		expect(text).toContain("18 buttons + 7 touch gestures");
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

	test("two links disagreeing about the buttons are named as two controllers", () => {
		// The service decides *when* to say it (a second of contradictions); what
		// the card says is here. Nothing can pick the right pad — that is the whole
		// problem — so the line names the way out instead.
		const { pad } = harness();
		const text = formatPadStatus(
			{
				phase: "connected",
				device: pad.service.status().device,
				transport: "usb",
				links: ["usb", "bluetooth"],
				linksDisagree: true,
			},
			pad.config,
			pad.service,
			Date.now(),
		);
		expect(text).toContain("links: usb + bluetooth (reading usb)");
		expect(text).toContain("both links report — these may be two controllers");
		expect(text).toContain("device filter");

		// And a card for a pad that agrees with itself does not carry the line at all.
		const quiet = formatPadStatus(
			{ phase: "connected", transport: "usb", links: ["usb", "bluetooth"] },
			pad.config,
			pad.service,
			Date.now(),
		);
		expect(quiet).not.toContain("two controllers");
	});

	test("the card says how long ago the pad was written to", async () => {
		// Reports are the pad talking; a write is the only proof anything went back.
		// Never is a real answer and the one worth seeing — a connected pad that has
		// been told nothing is exactly what a broken write path looks like.
		const off = harness();
		expect(card(off.pad)).toContain("reports: 0 · last write: never");

		const { ctx, pad, source } = harness();
		handleAppCommand("/gamepad on", ctx);
		await settle();
		// A minute later, said by the clock rather than waited for.
		expect(card(pad, Date.now() + 65_000)).toContain("last write: 1m 05s ago");

		// The count is the pad's half of the same question, counted per connection:
		// one report read is one, and the card reads the number the service keeps
		// rather than one of its own.
		source.push(usbBytes(CROSS));
		expect(card(pad)).toContain("reports: 1 ·");

		// And when a read fails, the reason is on the card — which is the only place
		// the user can see *why* the pad went quiet, since the status after a lost pad
		// is the same "searching" whether it was unplugged or broke.
		source.fail(new Error("the controller stopped answering"));
		expect(card(pad)).toContain("last error: the controller stopped answering");
	});

	test("names an unreadable binding, which is the only place a typo is visible", () => {
		const { ctx, store } = harness({ settings: { gamepad: { bindings: { cros: "confirm" } } } });

		handleAppCommand("/gamepad status", ctx);

		const text = infoText(store);
		expect(text).toContain("1 unreadable");
		expect(text).toContain("cros");
	});

	test("says which of the two silent switches is off, and nothing when neither is", () => {
		const quiet = harness({ settings: { gamepad: { rumble: false, lightbar: false } } });
		handleAppCommand("/gamepad status", quiet.ctx);
		const text = infoText(quiet.store);
		expect(text).toContain("feedback: lightbar + rumble off (settings)");

		// One of them is still a line: "the controller is quiet and I do not know
		// why" is the question this card exists to answer.
		const half = harness({ settings: { gamepad: { lightbar: false } } });
		handleAppCommand("/gamepad status", half.ctx);
		expect(infoText(half.store)).toContain("feedback: lightbar off (settings)");

		// Both on is the default and needs no line at all.
		const loud = harness();
		handleAppCommand("/gamepad status", loud.ctx);
		expect(infoText(loud.store)).not.toContain("feedback:");
	});
});

describe("/gamepad rumble", () => {
	test("asks the pad to buzz, and the proof is on the wire", async () => {
		// The command exists because it is the one check that needs no screen: if the
		// motors answer, the write path works. So "Buzzed." is not the assertion — the
		// bytes are.
		const { ctx, store, source } = harness();
		handleAppCommand("/gamepad on", ctx);
		await settle(120);
		source.takeWrites();

		handleAppCommand("/gamepad rumble", ctx);

		expect(infoText(store)).toContain("Buzzed.");
		// The alert pattern in the two bytes a DualShock 4 reads as motors.
		const packet = source.writes().at(-1);
		expect(packet?.[4]).toBe(PAD_RUMBLE.alert.rumble.small);
		expect(packet?.[5]).toBe(PAD_RUMBLE.alert.rumble.large);
	});

	test("with the motors switched off it says so and writes nothing at all", async () => {
		const { ctx, store, source } = harness({ settings: { gamepad: { rumble: false } } });
		handleAppCommand("/gamepad on", ctx);
		await settle(120);
		source.takeWrites();

		handleAppCommand("/gamepad rumble", ctx);

		// Not "a quiet buzz": silence, and the silence has a reason the user can act
		// on. A command that did nothing quietly would read as a broken controller.
		expect(infoText(store)).toContain("Rumble is off — gamepad.rumble is false in settings.");
		expect(source.writes()).toHaveLength(0);
	});

	test("the switch reaches the pad itself, not only the card that reports it", async () => {
		// Three links in a row: the settings file, the config built from it, and the
		// service the bridge builds out of that config. The card above proves the
		// first two, and a switch that is read and then never forwarded is a switch
		// that does nothing at all — so this asks the pad directly.
		const { ctx, source, pad } = harness({ settings: { gamepad: { rumble: false } } });
		handleAppCommand("/gamepad on", ctx);
		await settle(120);
		source.takeWrites();

		pad.bridge.buzz("alert");
		await settle(20);

		expect(source.writes()).toHaveLength(0);
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
