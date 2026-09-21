/**
 * The controller's life, on a clock the test holds.
 *
 * The clock is the whole point of this file: "it looks again after three
 * seconds", "a buzz stops after sixty milliseconds" and "the bar breathes" are
 * all claims about time, and a test that waits for real ones is slow enough that
 * nobody writes the next one and flaky enough that the suite gets ignored.
 *
 * What is asserted is mostly about *not* doing things. An idle pad is written to
 * exactly once, a repeat that was already due does not fire on the tick a button
 * is let go, a disconnect does not invent a release, and a question that is
 * answered does not buzz. Those are the properties that make the feature feel
 * like a controller instead of a glitch.
 */

import { describe, expect, test } from "bun:test";
import {
	createFauxSource,
	createPadService,
	DEFAULT_BINDINGS,
	type FauxSource,
	PAD_LOW_RGB,
	PAD_RUMBLE,
	PAD_RUMBLE_MIN_GAP_MS,
	type PadAction,
	type PadService,
	type PadServiceStatus,
	type PadSourceDevice,
	padPalette,
} from "../src/index.ts";
import { createFauxClock, type FauxClock } from "./clock.ts";
import { attachedTwice, wiredDevice, wirelessDevice } from "./devices.ts";
import { battery, bluetoothBytes, CROSS, DPAD_UP, usbBytes } from "./reports.ts";

const PALETTE = padPalette({ accent: "cyan", alert: "magenta" });
const CYAN = { r: 58, g: 150, b: 221 };
const MAGENTA = { r: 136, g: 23, b: 152 };
/** The idle bar: the accent, dimmed. */
const IDLE = { r: 15, g: 38, b: 55 };

interface Harness {
	service: PadService;
	source: FauxSource;
	clock: FauxClock;
	actions: PadAction[];
	statuses: PadServiceStatus[];
}

async function harness(
	options: { devices?: PadSourceDevice[]; config?: Record<string, unknown> } = {},
): Promise<Harness> {
	const source = createFauxSource(options.devices ?? undefined);
	const clock = createFauxClock();
	const actions: PadAction[] = [];
	const statuses: PadServiceStatus[] = [];
	const service = createPadService(
		{ bindings: DEFAULT_BINDINGS, palette: PALETTE, ...options.config },
		{ source, clock, onActions: (next) => actions.push(...next), onStatus: (next) => statuses.push(next) },
	);
	await service.enable();
	return { service, source, clock, actions, statuses };
}

/** The motors and bar of a written packet, whichever transport built it. */
function output(packet: Uint8Array | undefined) {
	if (packet === undefined) return undefined;
	const at = packet[0] === 0x05 ? { small: 4, large: 5, rgb: 6 } : { small: 6, large: 7, rgb: 8 };
	return {
		small: packet[at.small],
		large: packet[at.large],
		rgb: { r: packet[at.rgb], g: packet[at.rgb + 1], b: packet[at.rgb + 2] },
	};
}

const RUMBLE_NAMES = new Map(
	Object.entries(PAD_RUMBLE).map(([name, command]) => [`${command.rumble.small}/${command.rumble.large}`, name]),
);

/**
 * The buzzes the motors were given, in order, collapsed: sixteen writes of the
 * same 0x50 while a pattern plays are one buzz to the hand holding the pad, and
 * a test that counts writes would be counting frames. Words rather than numbers
 * so a failure reads as "expected working, got done".
 */
function buzzes(source: FauxSource): string[] {
	const felt: string[] = [];
	for (const packet of source.writes()) {
		const motors = output(packet);
		if (motors === undefined || (motors.small === 0 && motors.large === 0)) continue;
		const name = RUMBLE_NAMES.get(`${motors.small}/${motors.large}`) ?? `${motors.small}/${motors.large}`;
		if (felt.at(-1) !== name) felt.push(name);
	}
	return felt;
}

describe("finding a controller", () => {
	test("an attached pad is opened, and the status says which", async () => {
		const { service, source } = await harness();
		expect(service.status().phase).toBe("connected");
		expect(service.status().device?.path).toBe("faux://dualshock-4-v2");
		expect(source.opened()).toHaveLength(1);
	});

	test("of a pad's four interfaces, the one that carries reports", async () => {
		const pad = (interfaceNumber: number, carriesReports: boolean): PadSourceDevice => ({
			path: `faux://iface-${interfaceNumber}`,
			vendorId: 0x054c,
			productId: 0x09cc,
			interface: interfaceNumber,
			carriesReports,
		});
		const { source } = await harness({
			devices: [pad(0, false), pad(2, false), pad(3, true), pad(4, false)],
			config: { device: undefined },
		});
		expect(source.opened()[0]?.interface).toBe(3);
	});

	test("nothing attached waits, says why, and looks again", async () => {
		const { service, source, clock } = await harness({ devices: [] });
		expect(service.status().phase).toBe("searching");
		expect(service.status().detail).toBe("no controller attached");
		expect(source.opened()).toHaveLength(0);

		source.attach();
		clock.advance(3_000);
		expect(service.status().phase).toBe("connected");
	});

	test("a source that cannot work at all is not retried every few seconds", async () => {
		// Waiting three seconds to ask again whether node-hid is installed answers
		// the same way every time. The reason is what the user is owed.
		const source = { ...createFauxSource([]), unavailable: () => "node-hid is not installed" };
		const clock = createFauxClock();
		const service = createPadService({ bindings: DEFAULT_BINDINGS, palette: PALETTE }, { source, clock });
		await service.enable();
		expect(service.status().detail).toBe("node-hid is not installed");
		expect(clock.pending()).toBe(0);
	});

	test("a device setting that matches nothing says so rather than picking another", async () => {
		const { service } = await harness({ devices: [], config: { device: "nintendo" } });
		expect(service.status().phase).toBe("searching");
		expect(service.status().detail).toBe("no controller attached");
		const second = await harness({ config: { device: "nintendo" } });
		expect(second.service.status().detail).toContain('"nintendo"');
		expect(second.source.opened()).toHaveLength(0);
	});

	test("an open that fails is a state with a reason, not a crash", async () => {
		const source = createFauxSource([]);
		source.attach();
		source.open = () => {
			throw new Error("Access denied");
		};
		const clock = createFauxClock();
		const service = createPadService({ bindings: DEFAULT_BINDINGS, palette: PALETTE }, { source, clock });
		await service.enable();
		expect(service.status().phase).toBe("error");
		expect(service.status().detail).toBe("Access denied");
		expect(service.stats().lastError).toBe("Access denied");
	});
});

describe("a pad attached twice", () => {
	test("both links are opened and both are written to, in each link's own shape", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, clock } = await harness({ devices: [wireless, wired] });
		expect(source.opened()).toHaveLength(2);
		// The wire leads, though the OS listed the radio first, and it is the link
		// the app reads.
		expect(service.status().links).toEqual(["usb", "bluetooth"]);
		expect(service.status().transport).toBe("usb");

		source.push(usbBytes(CROSS), wired);
		source.push(bluetoothBytes(CROSS), wireless);
		clock.advance(33);
		service.setFeedback({ phase: "busy", awaiting: false });
		clock.advance(100);

		const usb = source.writes().filter((packet) => packet[0] === 0x05);
		const bluetooth = source.writes().filter((packet) => packet[0] === 0x11);
		expect(usb.at(-1)?.length).toBe(32);
		expect(bluetooth.at(-1)?.length).toBe(78);
		expect(usb.length).toBeGreaterThan(2);
		// The same frames, in each link's own shape: the pad obeys one of the two and
		// nothing here can tell which, so it is told on both.
		expect(bluetooth.map((packet) => output(packet)?.rgb)).toEqual(usb.map((packet) => output(packet)?.rgb));
	});

	test("the same press seen on both links is one action, not two", async () => {
		// Both links carry the same buttons a few milliseconds apart, and the mapper
		// works on edges: reading both would make the second copy read as a release
		// and then as the press again — one ✕, two characters typed.
		const [wireless, wired] = attachedTwice();
		const { source, actions, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired); // the reader sees the press
		clock.advance(4);
		source.push(bluetoothBytes(), wireless); // the radio's copy, still showing it up
		clock.advance(4);
		source.push(bluetoothBytes(CROSS), wireless); // and the radio catches up
		expect(actions).toEqual([{ kind: "confirm", button: "cross", phase: "press", heldMs: 0 }]);
	});

	test("the cable comes out and the radio takes over, without inventing a release", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, actions } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired);
		source.push(bluetoothBytes(CROSS), wireless);

		source.detach(wired); // the cable is pulled

		// The pad is still here: the other link was answering all along, the press
		// that was down is still down, and the handle that failed was let go.
		expect(service.status().phase).toBe("connected");
		expect(service.status().links).toEqual(["bluetooth"]);
		expect(service.status().transport).toBe("bluetooth");
		expect(actions.filter((action) => action.phase === "release")).toEqual([]);
		expect(source.closedFor(wired)).toBe(true);

		// And the radio drives it from here: letting go is a release this time.
		source.push(bluetoothBytes(), wireless);
		expect(actions.at(-1)).toEqual({ kind: "confirm", button: "cross", phase: "release", heldMs: 0 });
	});

	test("a reader that goes quiet hands over to the link that is still talking", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, actions, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired);

		// The wire's reports stop and the radio's keep coming. Nothing is lost while
		// *a* link is talking — the pad is here — and the app moves its reading to
		// the link that is, a few seconds later, without the user doing anything.
		for (let at = 0; at < 40; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(), wireless);
		}
		expect(service.status().phase).toBe("connected");
		expect(service.status().transport).toBe("bluetooth");
		expect(service.status().links).toEqual(["bluetooth", "usb"]);
		// Held across the handover, so the hold is due by the time the radio's
		// reports are read — and letting go is what it always was.
		expect(actions.map((action) => action.phase)).toEqual(["press", "hold", "release"]);
	});

	test("a cable plugged in mid-session becomes a second link, and is written to", async () => {
		const wireless = wirelessDevice();
		const { service, source, clock } = await harness({ devices: [wireless] });
		source.push(bluetoothBytes(), wireless);
		expect(service.status().links).toEqual(["bluetooth"]);

		source.attach(wiredDevice()); // the cable goes in
		// A second and a bit: the looking happens on a tick, and the ticks are
		// frames of the animation.
		clock.advance(1_100);

		// Nothing announces it — the OS simply starts listing a second collection —
		// so it is looked for, and from the next frame on it is written to as well.
		expect(service.status().links).toEqual(["bluetooth", "usb"]);
		source.takeWrites();
		service.setFeedback({ phase: "busy", awaiting: false });
		clock.advance(100);
		const usb = source.writes().filter((packet) => packet[0] === 0x05);
		expect(usb.length).toBeGreaterThan(0);
		expect(source.writes().filter((packet) => packet[0] === 0x11)).toHaveLength(usb.length);
	});

	test("the status keeps its identity while both links keep saying the same", async () => {
		// The link list is rebuilt on every report, so it has to be compared by
		// value: a new array 250 times a second is a re-render 250 times a second.
		const [wireless, wired] = attachedTwice();
		const { service, source, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(battery(7)), wired);
		source.push(bluetoothBytes(battery(7)), wireless);
		const settled = service.status();
		for (let at = 0; at < 5; at += 1) {
			clock.advance(4);
			source.push(usbBytes(battery(7)), wired);
			source.push(bluetoothBytes(battery(7)), wireless);
		}
		expect(service.status()).toBe(settled);
	});

	test("pulling both links loses the pad, and only then", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source } = await harness({ devices: [wireless, wired] });
		source.detach(wired);
		expect(service.status().phase).toBe("connected");
		source.detach(wireless);
		expect(service.status().phase).toBe("searching");
		expect(service.status().detail).toContain("disconnected");
		expect(source.closed()).toBe(true);
	});
});

describe("reading reports", () => {
	test("a report becomes the action its button maps to", async () => {
		const { source, actions } = await harness();
		source.push(usbBytes(CROSS));
		expect(actions).toEqual([{ kind: "confirm", button: "cross", phase: "press", heldMs: 0 }]);
	});

	test("a button that stays down says nothing more", async () => {
		const { source, actions, clock } = await harness();
		source.push(usbBytes(CROSS));
		for (let at = 0; at < 10; at += 1) {
			clock.advance(4);
			source.push(usbBytes(CROSS));
		}
		expect(actions).toHaveLength(1);
	});

	test("a report that is not ours is ignored, whatever it is", async () => {
		const { source, actions, service } = await harness();
		source.push(new Uint8Array(64));
		source.push(new Uint8Array([0x01, 0x02]));
		expect(actions).toEqual([]);
		expect(service.stats().reports).toBe(0);
	});

	test("the sample and the counters follow the stream", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes({ ...CROSS, ...battery(7) }));
		clock.advance(4);
		source.push(usbBytes(battery(7)));
		expect(service.stats().reports).toBe(2);
		expect(service.stats().lastReportAt).toBe(4);
		expect(service.lastSample()?.bytes).toBe(64);
		expect(service.lastSample()?.transport).toBe("usb");
		expect(service.status().battery).toEqual({ level: 7, cable: false });
	});

	test("a bluetooth report is read as bluetooth, and its CRC is checked", async () => {
		const { source, service, actions } = await harness();
		source.push(bluetoothBytes(CROSS));
		expect(service.status().transport).toBe("bluetooth");
		expect(service.status().crcOk).toBe(true);
		expect(service.lastSample()?.bytes).toBe(78);
		expect(actions).toHaveLength(1);
	});

	test("a radio link reporting in its USB shape is still written to over the radio", async () => {
		// A pad switched on over Bluetooth sends its USB-shaped report until a host
		// writes to it, so the first report says "usb" on a link the OS calls
		// Bluetooth. Taking it at its word would start sending 32-byte packets down a
		// radio link, which is the moment the bar stops changing.
		const wireless = wirelessDevice();
		const { source, clock } = await harness({ devices: [wireless] });
		source.push(usbBytes(battery(1)), wireless);
		source.takeWrites();
		clock.advance(100);
		const written = source.takeWrites();
		expect(written.length).toBeGreaterThan(0);
		expect(written.every((packet) => packet[0] === 0x11)).toBe(true);
		expect(written[0]?.length).toBe(78);
	});

	test("the status object keeps its identity until it says something different", async () => {
		// The UI reads this through `useSyncExternalStore`: a new object on every
		// report would be a re-render 250 times a second.
		const { source, service, clock } = await harness();
		source.push(usbBytes(battery(7)));
		const settled = service.status();
		for (let at = 0; at < 5; at += 1) {
			clock.advance(4);
			source.push(usbBytes(battery(7)));
		}
		expect(service.status()).toBe(settled);
		source.push(usbBytes(battery(6)));
		expect(service.status()).not.toBe(settled);
		expect(service.status().battery?.level).toBe(6);
	});

	test("a report arriving after the pad is gone is ignored", async () => {
		const { source, service, actions } = await harness();
		source.push(usbBytes(CROSS));
		source.detach();
		const before = actions.length;
		source.push(usbBytes(CROSS));
		expect(actions).toHaveLength(before);
		expect(service.status().phase).toBe("searching");
	});

	test("the UI hears about each change once, not about each report", async () => {
		// This is the callback the REPL subscribes with. Firing it per report would
		// be a re-render 250 times a second; never firing it would leave the screen
		// saying the pad is gone after it came back.
		const { source, statuses, clock } = await harness();
		expect(statuses.map((status) => status.phase)).toEqual(["connected"]);

		// Settled: the transport and the battery are known, and five reports saying
		// what the last one said are not five pieces of news. A status whose identity
		// changed 250 times a second would re-render the whole screen.
		source.push(usbBytes(battery(7)));
		const settled = statuses.map((status) => status.phase);
		for (let at = 0; at < 5; at += 1) {
			clock.advance(4);
			source.push(usbBytes(battery(7)));
		}
		expect(statuses.map((status) => status.phase)).toEqual(settled);

		source.detach();
		expect(statuses.at(-1)?.phase).toBe("searching");
		source.attach();
		clock.advance(3_000);
		expect(statuses.map((status) => status.phase)).toEqual([...settled, "searching", "connected"]);
	});
});

describe("the lightbar", () => {
	test("idle is written once and then left alone", async () => {
		// The property the whole output path exists for: an idle pad is not
		// written to. Anything else is a USB device being told the same thing
		// thirty times a second for no reason.
		const { source, clock } = await harness();
		source.push(usbBytes());
		clock.advance(100); // the hello buzz ends here
		expect(output(source.writes().at(-1))?.rgb).toEqual(IDLE);
		const settled = source.writes().length;
		clock.advance(1_000);
		expect(source.writes()).toHaveLength(settled);
	});

	test("working breathes, at about the output rate", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		service.setFeedback({ phase: "busy", awaiting: false });
		const before = source.writes().length;
		clock.advance(1_000);
		// Thirty frames, plus the one that stops the buzz — the frame boundary is
		// nobody's business, the order of magnitude is.
		const written = source.writes().length - before;
		expect(written).toBeGreaterThanOrEqual(20);
		expect(written).toBeLessThanOrEqual(34);
		// A breath is a change: consecutive packets are never the same colour.
		const colours = source.writes().map((packet) => JSON.stringify(output(packet)?.rgb));
		expect(new Set(colours.slice(-10)).size).toBeGreaterThan(5);
	});

	test("a question pulses in the alert colour, and outranks work", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		service.setFeedback({ phase: "busy", awaiting: true });
		clock.advance(500);
		const colours = source.writes().map((packet) => output(packet)?.rgb);
		expect(colours).toContainEqual(MAGENTA);
		expect(colours).toContainEqual({ r: 34, g: 6, b: 38 });
		expect(colours).not.toContainEqual(CYAN);
	});

	test("two changes inside one frame are one write", async () => {
		// The bar is an animation, so its writes are frames: two changes made in the
		// same frame are one frame's worth of work, not two packets down the wire.
		const { source, service, clock } = await harness();
		source.push(usbBytes(battery(7)));
		service.setFeedback({ phase: "busy", awaiting: true });
		const before = source.writes().length;
		service.setFeedback({ phase: "busy", awaiting: false });
		expect(source.writes()).toHaveLength(before);
		clock.advance(33);
		expect(source.writes()).toHaveLength(before + 1);
	});

	test("an empty battery only gets the bar when nothing else wants it", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes(battery(1)));
		// A frame later, because the greeting written at open owns this one: the bar
		// is written once a frame, and a battery that arrives in the same frame as
		// the hello is the next frame's news.
		clock.advance(33);
		expect(output(source.writes().at(-1))?.rgb).toEqual(PAD_LOW_RGB);

		service.setFeedback({ phase: "busy", awaiting: false });
		clock.advance(800);
		expect(output(source.writes().at(-1))?.rgb).not.toEqual(PAD_LOW_RGB);
	});

	test("the bar is the theme's colour", async () => {
		const source = createFauxSource();
		const clock = createFauxClock();
		const service = createPadService(
			{ bindings: DEFAULT_BINDINGS, palette: padPalette({ accent: "#ff0080", alert: "yellow" }) },
			{ source, clock },
		);
		await service.enable();
		source.push(usbBytes());
		expect(output(source.writes().at(-1))?.rgb).toEqual({ r: 64, g: 0, b: 32 });
	});
});

describe("the motors", () => {
	test("the pad proves it is alive by being felt, and stops on its own", async () => {
		const { source, clock } = await harness();
		source.push(usbBytes());
		expect(buzzes(source)).toEqual(["connected"]);
		clock.advance(PAD_RUMBLE.connected.durationMs);
		expect(output(source.writes().at(-1))?.small).toBe(0);
	});

	test("work starting and work finishing feel different", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		service.setFeedback({ phase: "busy", awaiting: false });
		expect(buzzes(source)).toEqual(["connected", "working"]);
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		service.setFeedback({ phase: "idle", awaiting: false });
		expect(buzzes(source)).toEqual(["connected", "working", "done"]);
	});

	test("a question is felt even when the phase did not change", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		service.setFeedback({ phase: "busy", awaiting: false });
		service.setFeedback({ phase: "busy", awaiting: true });
		expect(buzzes(source)).toEqual(["connected", "working", "alert"]);
	});

	test("answering a question is not worth a buzz", async () => {
		const { source, service } = await harness();
		source.push(usbBytes());
		service.setFeedback({ phase: "busy", awaiting: true });
		service.setFeedback({ phase: "busy", awaiting: false });
		expect(buzzes(source)).toEqual(["connected", "alert"]);
	});

	test("two pieces of news a moment apart share one buzz", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		service.setFeedback({ phase: "busy", awaiting: false });
		clock.advance(300);
		service.setFeedback({ phase: "idle", awaiting: false });
		// The turn was over before the motors had finished saying it had started:
		// one buzz, not two.
		expect(buzzes(source)).toEqual(["connected", "working"]);
	});

	test("a person asking for a buzz gets one, gap rule or not", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		service.setFeedback({ phase: "busy", awaiting: false });
		service.buzz("alert");
		expect(buzzes(source)).toEqual(["connected", "working", "alert"]);
	});

	test("a second buzz is not cut short by the first one's stop", async () => {
		// Two commands in a row: the stop must belong to the newest one, or the
		// motors are shut off while the user is still being told something.
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		service.buzz("connected"); // would stop at 60
		clock.advance(10);
		service.buzz("alert"); // must cancel that, and run to 190
		clock.advance(59);
		expect(buzzes(source)).toEqual(["connected", "alert"]);
		expect(output(source.writes().at(-1))?.large).toBe(PAD_RUMBLE.alert.rumble.large);
		clock.advance(200);
		expect(output(source.writes().at(-1))?.small).toBe(0);
		expect(output(source.writes().at(-1))?.large).toBe(0);
	});
});

describe("losing the pad", () => {
	test("a pulled cable is a state with a reason, not a release", async () => {
		const { source, service, actions, clock } = await harness();
		source.push(usbBytes(CROSS));
		source.detach();
		expect(service.status().phase).toBe("searching");
		expect(service.status().detail).toContain("disconnected");
		// The button was never let go, and the pad that comes back is a new pad:
		// a release here would be an action nobody performed.
		expect(actions.some((action) => action.phase === "release")).toBe(false);

		source.attach();
		clock.advance(3_000);
		expect(service.status().phase).toBe("connected");
		expect(service.stats().lastError).toContain("disconnected");
	});

	test("silence is the same as a pull, because bluetooth does not say goodbye", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(1_999);
		expect(service.status().phase).toBe("connected");
		// Noticed on the next frame rather than the instant it happened, which is
		// the cost of not having a timer per possible kind of silence.
		clock.advance(41);
		expect(service.status().phase).toBe("searching");
		expect(service.status().detail).toContain("stopped reporting");
	});

	test("a pad that comes back is told everything again", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		service.setFeedback({ phase: "busy", awaiting: false });
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		const told = source.writes().length;

		source.detach();
		source.attach();
		clock.advance(3_000);
		// A replugged pad has no memory of the colour, and it is told again on
		// arrival rather than on its first report: that write is what ends a
		// Bluetooth pad's power-on mode, so a service that waited for a readable
		// report before writing would never write to a pad that has just come back.
		expect(source.writes()).toHaveLength(told + 1);
		expect(buzzes(source)).toEqual(["connected", "working", "connected"]);
		source.push(usbBytes());
		// And the report that follows has nothing to add: the packet it would send is
		// the packet the greeting already sent, and two identical packets in a row are
		// one packet's worth of news.
		expect(source.writes()).toHaveLength(told + 1);
	});

	test("handing the pad over stops the repeats without inventing a release", async () => {
		const { source, service, clock, actions } = await harness();
		source.push(usbBytes(DPAD_UP));
		clock.advance(400);
		source.push(usbBytes(DPAD_UP));
		expect(actions.filter((action) => action.phase === "press")).toHaveLength(2);

		service.suspendRepeat();
		clock.advance(400);
		source.push(usbBytes(DPAD_UP));
		expect(actions.filter((action) => action.phase === "press")).toHaveLength(2);
		source.push(usbBytes());
		expect(actions.at(-1)?.phase).toBe("release");
	});
});

describe("shutting down", () => {
	test("turning it off leaves the pad dark and quiet", async () => {
		const { source, service } = await harness();
		source.push(usbBytes(CROSS));
		service.disable();
		expect(service.status().phase).toBe("off");
		expect(output(source.writes().at(-1))).toEqual({ small: 0, large: 0, rgb: { r: 0, g: 0, b: 0 } });
		expect(source.closed()).toBe(true);
	});

	test("and nothing more is read, and no timers are left running", async () => {
		const { source, service, clock, actions } = await harness();
		source.push(usbBytes(CROSS));
		service.disable();
		const read = actions.length;
		source.push(usbBytes(CROSS));
		expect(actions).toHaveLength(read);
		expect(clock.pending()).toBe(0);
	});

	test("an error arriving after it was turned off does not restart the search", async () => {
		// A USB read failure is delivered on the event loop, so it can land after the
		// user has already turned the pad off. It must not undo that — and a status
		// that says "searching" would have the UI promise something nobody asked for.
		const { source, service, clock } = await harness();
		source.push(usbBytes(CROSS));
		service.disable();
		source.fail(new Error("device disconnected"));
		expect(service.status().phase).toBe("off");
		expect(clock.pending()).toBe(0);
	});

	test("turning it back on works", async () => {
		const { source, service, actions } = await harness();
		service.disable();
		await service.enable();
		expect(service.status().phase).toBe("connected");
		source.push(usbBytes(CROSS));
		expect(actions).toHaveLength(1);
	});

	test("closing is the end: it cannot be turned back on", async () => {
		const { service } = await harness();
		service.close();
		await service.enable();
		expect(service.status().phase).toBe("off");
	});
});
