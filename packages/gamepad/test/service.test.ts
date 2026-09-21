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
	PAD_BLINK_ATTENTION,
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
import { battery, bluetoothBytes, CROSS, DPAD_UP, finger, usbBytes } from "./reports.ts";

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

/** The blink bytes of a written packet, whichever transport built it. */
function blink(packet: Uint8Array | undefined) {
	if (packet === undefined) return undefined;
	const at = packet[0] === 0x05 ? { on: 9, off: 10 } : { on: 11, off: 12 };
	return { on: packet[at.on], off: packet[at.off] };
}

/** The motors of the last thing written, as the words the table uses. */
function lastMotors(source: FauxSource): string {
	const motors = output(source.writes().at(-1));
	if (motors === undefined) return "nothing";
	return RUMBLE_NAMES.get(`${motors.small}/${motors.large}`) ?? `${motors.small}/${motors.large}`;
}

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

	test("a rescan opens the pad again at once, and counts this connection from zero", async () => {
		const { service, source, clock } = await harness();
		source.push(usbBytes(CROSS));
		// Past the gap that keeps two buzzes from reading as one stutter, so the hello
		// the rescan earns is news the pad can feel rather than a stutter suppressed.
		clock.advance(1_000);
		source.takeWrites();
		expect(service.stats().reports).toBe(1);

		service.rescan();

		// Now, not in three seconds: a fresh handle, a fresh connection, and the pad
		// told everything again — which is the only proof the new handle is writable.
		expect(service.status().phase).toBe("connected");
		expect(service.stats().reports).toBe(0);
		expect(source.opened()).toHaveLength(2);
		expect(buzzes(source)).toContain("connected");

		// And it is being read: the rescue leaves a pad that works, not a pad that is
		// merely attached.
		clock.advance(100);
		source.push(usbBytes(CROSS));
		expect(service.stats().reports).toBe(1);
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
		// The press survives the handover — no invented release at the moment the
		// app changes which link it believes — and the radio, which has been saying
		// ✕ is up this whole time, ends it. No hold: two seconds nobody was reading
		// is not two seconds of the pad saying the button was down.
		expect(actions.map((action) => action.phase)).toEqual(["press", "release"]);
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

	test("two links that keep disagreeing are called two controllers", async () => {
		// Nothing on a collection says which device it belongs to, so a second pad
		// switched on looks exactly like one pad attached twice. The app cannot tell
		// them apart and does not pretend to — but it can say what it sees.
		const [wireless, wired] = attachedTwice();
		const { service, source, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired); // the reader: ✕ down

		// The radio says ✕ is up, and keeps saying it. Four hundred milliseconds is
		// plenty for one pad's slower link to catch up with its faster one, which is
		// what the first four reports of this are.
		for (let at = 0; at < 4; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(), wireless);
		}
		expect(service.status().linksDisagree).toBeUndefined();

		for (let at = 0; at < 7; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(), wireless);
		}
		expect(service.status().linksDisagree).toBe(true);

		// The radio catches up, and the two are one pad again.
		source.push(bluetoothBytes(CROSS), wireless);
		expect(service.status().linksDisagree).toBeUndefined();
	});

	test("a link a few milliseconds behind is not a second controller", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, clock } = await harness({ devices: [wireless, wired] });
		// A real pad's two links are milliseconds apart at an edge — the wire sees ✕
		// go down and the radio says so a frame later. That is latency, not a second
		// controller, and a card that cried wolf at every press would be ignored.
		for (let at = 0; at < 30; at += 1) {
			clock.advance(20);
			source.push(usbBytes(CROSS), wired);
			clock.advance(4);
			source.push(bluetoothBytes(), wireless); // the radio has not caught up
			// The moment that matters: a press seen on one link and not yet on the
			// other, which happens at every edge on a real pad.
			expect(service.status().linksDisagree).toBeUndefined();
			clock.advance(8);
			source.push(bluetoothBytes(CROSS), wireless); // and now it has
		}
		expect(service.status().linksDisagree).toBeUndefined();
	});

	test("the line about two controllers does not outlive the second link", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired);
		for (let at = 0; at < 12; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(), wireless);
		}
		expect(service.status().linksDisagree).toBe(true);

		// The bag's pad is switched off: one link is left, and one link cannot
		// disagree with itself.
		source.detach(wireless);
		expect(service.status().links).toEqual(["usb"]);
		expect(service.status().linksDisagree).toBeUndefined();
	});

	test("turning the pad off forgets the second opinion too", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired);
		for (let at = 0; at < 12; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(), wireless);
		}
		expect(service.status().linksDisagree).toBe(true);

		// The line goes off with the feature: a status still saying "these may be two
		// controllers" while nothing at all is being read is the one thing on the
		// card that would be about a pad nobody is listening to.
		service.disable();
		expect(service.status().phase).toBe("off");
		expect(service.status().linksDisagree).toBeUndefined();
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

describe("a pad that goes quiet", () => {
	test("a button held across the silence is not a hold when the reports come back", async () => {
		const { source, actions, clock } = await harness();
		source.push(usbBytes(CROSS));
		expect(actions.map((action) => action.phase)).toEqual(["press"]);

		// The pad says nothing with ✕ still down and the link still up: the radio
		// idle-slept, the USB pipe stalled. Nothing arrived, so nothing is known —
		// and a hold is only ever a claim about what the pad said.
		clock.advance(900);
		source.push(usbBytes(CROSS));
		// The press is neither invented again nor released. The silence cost it its
		// hold, which is the point: without that, the age of the silence would be
		// read as the age of the press, and a ✕ that slept through a question would
		// answer the next one with "always allow".
		expect(actions).toHaveLength(1);

		clock.advance(200);
		source.push(usbBytes(CROSS));
		clock.advance(200);
		source.push(usbBytes(CROSS));
		expect(actions).toHaveLength(1);

		// And the six hundred milliseconds are six hundred milliseconds of reports,
		// to the millisecond — the same threshold as ever, measured on the stream.
		clock.advance(199);
		source.push(usbBytes(CROSS));
		expect(actions).toHaveLength(1);
		clock.advance(1);
		source.push(usbBytes(CROSS));
		expect(actions.at(-1)).toEqual({ kind: "confirm", button: "cross", phase: "hold", heldMs: 1_500 });
	});

	test("a stutter is not a silence: the hold still lands at six hundred", async () => {
		const { source, actions, clock } = await harness();
		source.push(usbBytes(CROSS));
		// A hundred milliseconds between reports is a stutter — two dozen reports at
		// the rate this pad sends them — and it costs the press nothing. Holding ✕
		// over a link that is merely busy must not need longer than holding it over
		// a quiet one.
		for (let at = 0; at < 5; at += 1) {
			clock.advance(100);
			source.push(usbBytes(CROSS));
		}
		expect(actions).toHaveLength(1);
		clock.advance(100);
		source.push(usbBytes(CROSS));
		expect(actions.at(-1)).toEqual({ kind: "confirm", button: "cross", phase: "hold", heldMs: 600 });
	});

	test("the other link chattering does not cover for the reader's silence", async () => {
		// The app reads one link and ignores the other on purpose — and the other
		// may not even be the same controller (see "these may be two controllers").
		// So a hold is vouched for by the reports the app acts on, not by traffic
		// that happens to be arriving on the bus.
		const [wireless, wired] = attachedTwice();
		const { source, actions, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired); // the reader sees the press
		expect(actions.map((action) => action.phase)).toEqual(["press"]);

		for (let at = 0; at < 9; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(CROSS), wireless); // the radio has plenty to say
		}
		source.push(usbBytes(CROSS), wired);

		// The wire's own reports were what stopped, so they are what has to resume:
		// nine hundred milliseconds of radio buy the press nothing.
		expect(actions).toHaveLength(1);
		for (let at = 0; at < 6; at += 1) {
			clock.advance(100);
			source.push(usbBytes(CROSS), wired);
		}
		expect(actions.at(-1)).toEqual({ kind: "confirm", button: "cross", phase: "hold", heldMs: 1_500 });
	});

	test("a handover is a silence too: the press survives it, the hold starts over", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, actions, clock } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired); // the reader sees the press

		// The wire goes quiet with ✕ down *and stays down*: the radio has been
		// saying the button is held all along, but the app is not reading the radio
		// — it is waiting for the link it was reading to speak again, and two
		// seconds later it gives up on it and moves.
		for (let at = 0; at < 21; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(CROSS), wireless);
		}
		expect(service.status().transport).toBe("bluetooth");
		// Same press, still down, and no release invented by the change of reader.
		expect(actions.map((action) => action.phase)).toEqual(["press"]);

		// The hold is then six hundred milliseconds of the radio reporting, which is
		// the only thing that has been vouching for the press since it took over.
		for (let at = 0; at < 6; at += 1) {
			clock.advance(100);
			source.push(bluetoothBytes(CROSS), wireless);
		}
		expect(actions.at(-1)).toEqual({ kind: "confirm", button: "cross", phase: "hold", heldMs: 2_700 });
	});
});

describe("the touch surface", () => {
	test("a drag becomes the action its direction maps to", async () => {
		const { source, actions, clock } = await harness();
		source.push(usbBytes(finger(34, 500, 400)));
		// A step: an eighth of the surface's height, which is what a deliberate drag
		// makes. The finger itself is not a button anywhere in the app.
		clock.advance(4);
		source.push(usbBytes(finger(34, 500 + 120, 400)));
		expect(actions).toEqual([{ kind: "right", button: "touch-right", phase: "press", heldMs: 0 }]);
		// And the report after it lets go: a step is an event, not a key held down.
		clock.advance(4);
		source.push(usbBytes(finger(34, 500 + 120, 400)));
		expect(actions.at(-1)).toEqual({ kind: "right", button: "touch-right", phase: "release", heldMs: 4 });
	});

	test("a tap confirms, on the report where the finger has gone", async () => {
		const { source, actions, clock } = await harness();
		source.push(usbBytes(finger(34, 900, 300)));
		clock.advance(4);
		source.push(usbBytes(finger(34, 902, 300)));
		clock.advance(96);
		source.push(usbBytes());
		expect(actions).toEqual([{ kind: "confirm", button: "touch-tap", phase: "press", heldMs: 0 }]);
	});

	test("the sample carries the gesture, for exactly the report that held it", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes(finger(34, 500, 400)));
		expect(service.lastSample()?.gestures).toBeUndefined();
		clock.advance(4);
		source.push(usbBytes(finger(34, 620, 400)));
		expect(service.lastSample()?.gestures).toEqual(["touch-right"]);
		clock.advance(4);
		source.push(usbBytes(finger(34, 620, 400)));
		expect(service.lastSample()?.gestures).toBeUndefined();
	});

	test("a finger that was down when the pad went away is not a drag when it comes back", async () => {
		// The reports that would have ended the touch never arrived, so the first
		// report after the reconnect is compared against a position from before the
		// sleep — and a step measured across that gap is a move nobody made. The
		// reset is the only thing that decides this one: the tap case cannot be told
		// apart from the clock here, because a pad is away far longer than a tap.
		const { source, actions, clock } = await harness();
		source.push(usbBytes(finger(34, 100, 400)));
		source.detach();
		source.attach();
		clock.advance(3_000);
		// The same finger, somewhere else: a whole surface away from where the pad
		// last saw it, which is what a hand that moved while the pad was off looks
		// like from here.
		source.push(usbBytes(finger(34, 900, 400)));
		expect(actions).toEqual([]);
	});

	test("the thresholds come from the caller, so they can be tuned", async () => {
		// Nothing here is measured on real hardware yet, so the layer has to be
		// tunable without a code change: a step of 4 units is a test's idea of a
		// drag, and it is the service that has to pass it through.
		const { source, actions, clock } = await harness({ config: { touch: { step: 4, tapMs: 1 } } });
		source.push(usbBytes(finger(34, 500, 400)));
		clock.advance(4);
		source.push(usbBytes(finger(34, 504, 400)));
		expect(actions).toEqual([{ kind: "right", button: "touch-right", phase: "press", heldMs: 0 }]);
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

	test("a question blinks the hardware, and answering it stops the blinking", async () => {
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE.connected.durationMs);
		source.takeWrites();

		service.setFeedback({ phase: "busy", awaiting: true });
		expect(blink(source.writes().at(-1))).toEqual(PAD_BLINK_ATTENTION);
		// The colour and the blink are one answer: the bar blinks, and it blinks in
		// the colour that says what it is blinking about.
		expect(output(source.writes().at(-1))?.rgb).toEqual(MAGENTA);

		service.setFeedback({ phase: "busy", awaiting: false });
		source.takeWrites();
		clock.advance(100);
		// Nothing is sent to say "stop blinking": the packet describes the whole pad,
		// so a packet that does not ask for a blink is the pad being told to stop. The
		// wait is a frame or two, since the bar is an animation and its writes are
		// frames — but every frame from here on says the same thing.
		const after = source.takeWrites();
		expect(after.length).toBeGreaterThan(0);
		for (const packet of after) expect(blink(packet)).toEqual({ on: 0, off: 0 });
	});

	test("with the lightbar switched off the bar is dark, and stays that way", async () => {
		const { source, service, clock } = await harness({ config: { lightbar: false } });
		source.push(usbBytes());
		// The state that would light it, blink it and pulse it, for a second of frames.
		service.setFeedback({ phase: "busy", awaiting: true });
		clock.advance(1_000);

		expect(source.writes().length).toBeGreaterThan(0);
		for (const packet of source.writes()) {
			expect(output(packet)?.rgb).toEqual({ r: 0, g: 0, b: 0 });
			expect(blink(packet)).toEqual({ on: 0, off: 0 });
		}
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

	test("the two-part pattern is two buzzes, with a real silence between them", async () => {
		// The one thing a stop sounds like: two taps of one shape. Written out frame
		// by frame because the silence is the pattern — two buzzes with no gap is one
		// longer buzz, which is `done`.
		const { source, service, clock } = await harness();
		const stop = PAD_RUMBLE.stopped;
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE.connected.durationMs);
		source.takeWrites();

		service.buzz("stopped");
		expect(lastMotors(source)).toBe("stopped");
		clock.advance(stop.durationMs);
		expect(lastMotors(source)).toBe("0/0");
		clock.advance(stop.again.afterMs - 1);
		expect(lastMotors(source)).toBe("0/0");
		clock.advance(1);
		expect(lastMotors(source)).toBe("stopped");
		clock.advance(stop.again.durationMs);
		// Nothing is left running: a pad that buzzes after the program has moved on is
		// the failure every duration in this file exists to prevent.
		expect(lastMotors(source)).toBe("0/0");
	});

	test("a stop by hand is the last thing felt, not the first half of a stutter", async () => {
		// ○ while a turn runs: the buzz is the user's own, and the phase change that
		// follows it — the run really does go idle — would otherwise send `done` a
		// moment later. "You stopped it" and "it finished" are not the same news.
		const { source, service, clock } = await harness();
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		service.setFeedback({ phase: "busy", awaiting: false });
		// Long enough that the working buzz is not the thing that swallows the `done`:
		// the only buzz recent enough to absorb it is the stop itself.
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		source.takeWrites();

		service.buzz("stopped");
		service.setFeedback({ phase: "idle", awaiting: false });

		expect(buzzes(source)).toEqual(["stopped"]);
	});

	test("with the motors switched off, nothing is felt from either direction", async () => {
		const { source, service, clock } = await harness({ config: { rumble: false } });
		source.push(usbBytes());
		clock.advance(PAD_RUMBLE_MIN_GAP_MS);
		// The buzz a state change asks for, and the one a person asks for.
		service.setFeedback({ phase: "busy", awaiting: true });
		service.buzz("alert");

		expect(buzzes(source)).toEqual([]);
		for (const packet of source.writes()) {
			expect(output(packet)?.small).toBe(0);
			expect(output(packet)?.large).toBe(0);
		}
		// The other switch is untouched: a pad nobody can hear is not a pad nobody can
		// see, and the question is still the question.
		expect(output(source.writes().at(-1))?.rgb).toEqual(MAGENTA);
		expect(blink(source.writes().at(-1))).toEqual(PAD_BLINK_ATTENTION);
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

	test("a pad that sleeps with both links down is found again, and told again", async () => {
		const [wireless, wired] = attachedTwice();
		const { service, source, clock, actions } = await harness({ devices: [wireless, wired] });
		source.push(usbBytes(CROSS), wired);
		const heard = actions.length;
		source.takeWrites();

		// Asleep: the radio stops answering and the OS lets both collections go.
		source.detach(wireless);
		source.detach(wired);
		expect(service.status().phase).toBe("searching");

		// Awake again, and listed again — which is all the app is ever told. It has
		// to be looking, and the looking is the retry.
		source.attach(wireless);
		source.attach(wired);
		clock.advance(3_000);

		expect(service.status().phase).toBe("connected");
		expect(service.status().links).toEqual(["usb", "bluetooth"]);
		expect(source.opened()).toHaveLength(4); // both links, opened again
		// Told everything again: the bar comes back, and with it the buzz that is
		// the only proof the motors work.
		expect(buzzes(source)).toContain("connected");
		// And nothing is invented on the way back: waking is not a press.
		expect(actions).toHaveLength(heard);
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
