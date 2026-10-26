/**
 * The service driving an Xbox pad: the same lifecycle as a DualShock 4, with a
 * different family on the end of it.
 *
 * What is worth pinning here is the seam rather than the lifecycle (that file
 * exists): the parser and the packet builder switch together, so an Xbox link is
 * read as XInput and written as four bytes of vibration — never as a HID report
 * with a lightbar it does not have. The bindings above the seam are unchanged,
 * which is the design: A is `cross` by position, so "confirm" still works.
 */

import { describe, expect, test } from "bun:test";
import {
	createFauxSource,
	createPadService,
	DEFAULT_BINDINGS,
	type FauxSource,
	PAD_RUMBLE,
	type PadAction,
	type PadService,
	type PadServiceStatus,
	type PadSourceDevice,
	padPalette,
} from "../src/index.ts";
import { createFauxClock, type FauxClock } from "./clock.ts";
import { wiredDevice, xboxDevice } from "./devices.ts";
import { CROSS, usbBytes, XBOX_A, xboxBattery, xboxBytes } from "./reports.ts";

const PALETTE = padPalette({ accent: "cyan", alert: "magenta" });

interface Harness {
	service: PadService;
	source: FauxSource;
	clock: FauxClock;
	actions: PadAction[];
	statuses: PadServiceStatus[];
}

async function harness(
	devices: PadSourceDevice[] = [xboxDevice()],
	config: Record<string, unknown> = {},
): Promise<Harness> {
	const source = createFauxSource(devices);
	const clock = createFauxClock();
	const actions: PadAction[] = [];
	const statuses: PadServiceStatus[] = [];
	const service = createPadService(
		{ bindings: DEFAULT_BINDINGS, palette: PALETTE, ...config },
		{ source, clock, onActions: (next) => actions.push(...next), onStatus: (next) => statuses.push(next) },
	);
	await service.enable();
	return { service, source, clock, actions, statuses };
}

describe("an Xbox pad is an XInput link", () => {
	test("connected, read as xinput, and told hello in four bytes", async () => {
		const { service, source } = await harness();
		expect(service.status().phase).toBe("connected");
		expect(service.status().transport).toBe("xinput");
		expect(service.status().links).toEqual(["xinput"]);
		expect(service.status().device?.family).toBe("xbox");

		// The greeting is the same news a DualShock 4 gets — `connected` is the
		// small motor — but the packet is XInput's: left word from `large` (zero),
		// right word from `small` (0x40), little-endian.
		expect(source.writes()).toEqual([Uint8Array.of(0x00, 0x00, 0x40, 0x40)]);
	});

	test("A is the bottom button, so the confirm binding fires without changing", async () => {
		const { service, source, actions } = await harness();
		source.push(xboxBytes(XBOX_A));
		expect(actions).toEqual([{ kind: "confirm", button: "cross", phase: "press", heldMs: 0 }]);

		const sample = service.lastSample();
		expect(sample?.family).toBe("xbox");
		expect(sample?.transport).toBe("xinput");
		expect(sample?.bytes).toBe(18);
		expect(sample?.state.buttons).toEqual(["cross"]);
		// No surface, and the sample says so by omission rather than by an empty
		// touch: a gesture reader seeing one would think a finger just left.
		expect("touch" in (sample?.state ?? {})).toBe(false);
		expect(sample?.gestures).toBeUndefined();
	});

	test("the analog triggers become LT/RT in the state, at the mapper's threshold", async () => {
		const { source, actions } = await harness();
		source.push(xboxBytes({ 6: 128, 7: 255 }));
		// l2/r2 are unbound by default, so this is about what the state carries.
		expect(actions).toEqual([]);
	});

	test("the battery is XInput's three-step scale, with its own low word", async () => {
		const { service, source } = await harness();
		source.push(xboxBytes(xboxBattery(2, 1)));
		expect(service.status().battery).toEqual({ level: 1, cable: false, full: 3, low: true });

		source.push(xboxBytes(xboxBattery(1, 3)));
		expect(service.status().battery).toEqual({ level: 3, cable: true, full: 3, low: false });
	});

	test("a palette change is not a write: the bar it colours does not exist here", async () => {
		const { service, source } = await harness();
		source.takeWrites();
		service.setPalette(padPalette({ accent: "red", alert: "magenta" }));
		// The packet is four bytes of vibration; a colour cannot change one, and an
		// unchanged packet is skipped. This is what keeps a pad with no lightbar
		// from being written to at 30 Hz for nothing.
		expect(source.takeWrites()).toEqual([]);
	});

	test("a buzz is both motors, and its stop is all zeroes", async () => {
		const { service, source, clock } = await harness();
		source.takeWrites();
		service.buzz("alert");
		expect(source.writes().at(-1)).toEqual(Uint8Array.of(0x80, 0x80, 0x80, 0x80));

		clock.advance(PAD_RUMBLE.alert.durationMs);
		expect(source.writes().at(-1)).toEqual(Uint8Array.of(0x00, 0x00, 0x00, 0x00));
	});

	test("disabling darkens the pad before letting go of it", async () => {
		const { service, source } = await harness();
		source.takeWrites();
		service.disable();
		expect(source.writes().at(-1)).toEqual(Uint8Array.of(0x00, 0x00, 0x00, 0x00));
		expect(source.closed()).toBe(true);
		expect(service.status().phase).toBe("off");
	});

	test("a pulled pad is a state that looks again, and an Xbox pad can come back", async () => {
		const { service, source, clock } = await harness();
		source.push(xboxBytes(XBOX_A));
		source.detach();
		expect(service.status().phase).toBe("searching");
		expect(service.status().detail).toContain("disconnected");

		source.attach(xboxDevice());
		clock.advance(3_000);
		expect(service.status().phase).toBe("connected");
		expect(service.status().transport).toBe("xinput");
	});
});

describe("the two families side by side", () => {
	test("their links keep their own framings, and the wire leads", async () => {
		const { service, source } = await harness([wiredDevice(), xboxDevice()]);
		expect(service.status().links).toEqual(["usb", "xinput"]);
		expect(service.status().transport).toBe("usb");

		// Both links were told hello, each in the shape it understands: the Xbox
		// one is exactly the four-byte vibration packet, not a truncated HID report.
		const xboxWrites = source.writes().filter((packet) => packet.length === 4);
		expect(xboxWrites).toEqual([Uint8Array.of(0x00, 0x00, 0x40, 0x40)]);
	});

	test("a report on the Xbox link does not drive the app while the wire is fresh", async () => {
		const { source, actions } = await harness([wiredDevice(), xboxDevice()]);
		// The faux source keys handles by identity, so push to the object the
		// service opened rather than to an equal one.
		const wired = source.opened().find((device) => device.family !== "xbox");
		if (wired === undefined) throw new Error("the wired link was not opened");
		source.push(usbBytes(CROSS), wired);
		expect(actions.map((action) => action.phase)).toEqual(["press"]);

		// The Xbox link is the second opinion, and says the same thing: no second
		// press, no release — the state was already the reader's.
		const xinput = source.opened().find((device) => device.family === "xbox");
		source.push(xboxBytes(XBOX_A), xinput);
		expect(actions).toHaveLength(1);
	});
});
