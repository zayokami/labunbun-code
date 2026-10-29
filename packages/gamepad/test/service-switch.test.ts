/**
 * Two pads, one app.
 *
 * The service reads exactly one controller and moves to the other only when
 * someone deliberately uses it. "Deliberately" is the whole design: a report
 * arriving is not an instruction, a button held through the move is not a new
 * press, and the input that chose the pad is not fed to the mapper — picking up
 * the other controller must not answer a dialog that was already open.
 *
 * The assertions are written at the seam the UI sees (`status().controllers`,
 * the writes that follow) rather than against the counter inside, so a change in
 * how "deliberate" is measured does not silently rewrite what the feature means.
 */

import { describe, expect, test } from "bun:test";
import {
	createFauxSource,
	createPadService,
	DEFAULT_BINDINGS,
	type FauxSource,
	type PadAction,
	type PadFamily,
	type PadService,
	type PadServiceStatus,
	type PadSourceDevice,
	padPalette,
	xinputSlotPath,
} from "../src/index.ts";
import { createFauxClock, type FauxClock } from "./clock.ts";
import { attachedTwice, WIRED_PATH, WIRELESS_PATH, wiredDevice, xboxDevice } from "./devices.ts";
import { battery, CROSS, finger, usbBytes, XBOX_A, xboxBattery, xboxBytes } from "./reports.ts";

const PALETTE = padPalette({ accent: "cyan", alert: "magenta" });

interface Harness {
	service: PadService;
	source: FauxSource;
	clock: FauxClock;
	actions: PadAction[];
	statuses: PadServiceStatus[];
}

async function harness(
	devices: PadSourceDevice[] = [wiredDevice(), xboxDevice()],
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

/** The handle the service opened for a device of this family. */
function opened(source: FauxSource, family: PadFamily): PadSourceDevice {
	const device = source.opened().find((candidate) => (candidate.family ?? "ds4") === family);
	if (device === undefined) throw new Error(`no ${family} link was opened`);
	return device;
}

/** The handle the service opened for one XInput slot. */
function openedSlot(source: FauxSource, slot: number): PadSourceDevice {
	const path = xinputSlotPath(slot);
	const device = source.opened().find((candidate) => candidate.path === path);
	if (device === undefined) throw new Error(`XInput slot ${slot + 1} was not opened`);
	return device;
}

/** The motors and bar of a written HID packet, whichever transport built it. */
function hid(packet: Uint8Array | undefined) {
	if (packet === undefined) return undefined;
	const at = packet[0] === 0x05 ? { small: 4, large: 5, rgb: 6 } : { small: 6, large: 7, rgb: 8 };
	return {
		small: packet[at.small],
		large: packet[at.large],
		rgb: { r: packet[at.rgb], g: packet[at.rgb + 1], b: packet[at.rgb + 2] },
	};
}

/** An XInput report that pushes the left stick to `value` on its x axis. */
function leftStick(value: number) {
	const raw = Math.round(value * 32767);
	return { 8: raw & 0xff, 9: (raw >> 8) & 0xff };
}

/** An XInput report that pushes the right stick to `value` on its y axis (up is positive). */
function rightStickY(value: number) {
	const raw = Math.round(value * 32767);
	return { 14: raw & 0xff, 15: (raw >> 8) & 0xff };
}

describe("two pads attached", () => {
	test("the DualShock 4 leads, and both controllers are listed", async () => {
		const { service } = await harness();
		const status = service.status();
		// `device`/`transport`/`links` still describe the pad being read only.
		expect(status.device?.path).toBe(WIRED_PATH);
		expect(status.transport).toBe("usb");
		expect(status.links).toEqual(["usb"]);

		const controllers = status.controllers ?? [];
		expect(controllers.map((controller) => controller.key)).toEqual(["ds4", `xbox:${xinputSlotPath(0)}`]);
		expect(controllers.map((controller) => controller.family)).toEqual(["ds4", "xbox"]);
		expect(controllers.map((controller) => controller.active)).toEqual([true, false]);
	});

	test("a pad attached twice is still one controller, with two transports", async () => {
		// The cable and the radio on one controller are one pad, whichever
		// collection the OS listed first: this is the grouping the handover tests
		// have always depended on, and it must not become two cards.
		const { service } = await harness(attachedTwice());
		const controllers = service.status().controllers ?? [];
		expect(controllers).toHaveLength(1);
		expect(controllers[0]?.key).toBe("ds4");
		expect(controllers[0]?.transports).toEqual(["usb", "bluetooth"]);
		expect(service.status().links).toEqual(["usb", "bluetooth"]);
	});

	test("two deliberate Xbox reports move the app, and the press that moved it is not mapped", async () => {
		const { service, source, actions } = await harness();
		const xbox = opened(source, "xbox");
		// The pad reports at rest first, which is what arms it: a controller polled
		// while lying on the table always does this before anyone picks it up.
		source.push(xboxBytes(), xbox);

		source.push(xboxBytes(XBOX_A), xbox);
		expect(service.status().transport).toBe("usb"); // one report is not a decision

		source.push(xboxBytes(XBOX_A), xbox);
		expect(service.status().transport).toBe("xinput");
		expect(service.status().controllers?.find((controller) => controller.active)?.family).toBe("xbox");
		// A held across the switch: the app has been shown the state, but the press
		// that chose the pad must not answer anything.
		expect(actions).toEqual([]);
		expect(service.lastSample()?.family).toBe("xbox");
		expect(service.lastSample()?.state.buttons).toEqual(["cross"]);

		// Let go first: that is the report the mapper is willing to believe.
		source.push(xboxBytes(), xbox);
		source.push(xboxBytes(XBOX_A), xbox);
		expect(actions).toEqual([{ kind: "confirm", button: "cross", phase: "press", heldMs: 0 }]);
	});

	test("writes follow the pad in hand, and the pad left behind goes dark", async () => {
		const { service, source, clock } = await harness();
		const xbox = opened(source, "xbox");
		source.takeWrites();

		source.push(xboxBytes(), xbox);
		source.push(xboxBytes(XBOX_A), xbox);
		source.push(xboxBytes(XBOX_A), xbox);

		const moved = source.takeWrites();
		// The DualShock 4 got exactly one more packet: the dark one. Its bar and
		// motors are off before it stops being the pad in hand.
		const hidPackets = moved.filter((packet) => packet.length >= 32);
		expect(hidPackets).toHaveLength(1);
		expect(hid(hidPackets[0])).toEqual({ small: 0, large: 0, rgb: { r: 0, g: 0, b: 0 } });
		// The Xbox pad is told in its own four bytes, and it is told something.
		expect(moved.filter((packet) => packet.length === 4).length).toBeGreaterThan(0);

		// Normal operation from here writes to the Xbox pad only: a controller put
		// down must not be sent a bar animation thirty times a second.
		clock.advance(100);
		source.takeWrites();
		service.setFeedback({ phase: "busy", awaiting: false });
		clock.advance(200);
		expect(source.writes().every((packet) => packet.length === 4)).toBe(true);

		// And switching back is the same in reverse.
		source.takeWrites();
		expect(service.switchPad("ds4")).toBe(true);
		const back = source.takeWrites();
		expect(back.filter((packet) => packet.length === 4)).toEqual([Uint8Array.of(0, 0, 0, 0)]);
		const lit = back.filter((packet) => packet.length >= 32);
		expect(lit.length).toBeGreaterThan(0);
		expect(hid(lit.at(-1))?.rgb).not.toEqual({ r: 0, g: 0, b: 0 });
	});

	test("a held button cannot steal the app back; a released, pressed one can", async () => {
		const { service, source, actions } = await harness();
		const xbox = opened(source, "xbox");
		source.push(xboxBytes(), xbox);
		source.push(xboxBytes(XBOX_A), xbox);
		source.push(xboxBytes(XBOX_A), xbox); // the switch, with A still held
		expect(service.status().transport).toBe("xinput");
		expect(actions).toEqual([]);

		source.push(xboxBytes(), xbox); // release clears the post-switch suppression
		source.push(xboxBytes(XBOX_A), xbox);
		expect(actions).toEqual([{ kind: "confirm", button: "cross", phase: "press", heldMs: 0 }]);

		expect(service.switchPad("ds4")).toBe(true);
		expect(service.status().transport).toBe("usb");
		// Still held on the pad that just lost the app: reports arrive, but no
		// release has armed it, so it cannot take the app back.
		for (let at = 0; at < 5; at += 1) source.push(xboxBytes(XBOX_A), xbox);
		expect(service.status().transport).toBe("usb");

		// Let go, then press again: that is a person, and two reports are enough.
		source.push(xboxBytes(), xbox);
		source.push(xboxBytes(XBOX_A), xbox);
		expect(service.status().transport).toBe("usb");
		source.push(xboxBytes(XBOX_A), xbox);
		expect(service.status().transport).toBe("xinput");
	});

	test("a finger resting through a switch cannot become a tap on the arriving pad", async () => {
		const { service, source, actions } = await harness();
		const ds4 = opened(source, "ds4");

		// The Xbox is in hand; the DS4's reports are the ones that can switch.
		expect(service.switchPad("xbox")).toBe(true);

		// A finger is already on the surface when the app moves back: the pad is
		// armed by a neutral report, then two reports of cross make it deliberate.
		source.push(usbBytes(finger(34, 500, 400)), ds4);
		source.push(usbBytes({ ...CROSS, ...finger(34, 500, 400) }), ds4);
		source.push(usbBytes({ ...CROSS, ...finger(34, 500, 400) }), ds4);
		expect(service.status().transport).toBe("usb");

		// Cross is let go but the finger stays down. `padIsActive` says "not
		// active", and that is deliberately not enough: `touch-tap` defaults to
		// confirm, so a finger resting on the surface is one lift away from an
		// approval the user never gave.
		const reportsBefore = service.stats().reports;
		for (let at = 0; at < 4; at += 1) source.push(usbBytes(finger(34, 500, 400)), ds4);
		expect(actions).toEqual([]);
		expect(service.stats().reports).toBe(reportsBefore); // none reached the mapper

		// The lift is the first report with nothing down and nothing touching: it
		// clears suppression and is mapped, but it produces nothing — the surface
		// was never shown this finger, so there is no tap for it to judge.
		source.push(usbBytes(), ds4);
		expect(service.stats().reports).toBe(reportsBefore + 1);
		expect(actions).toEqual([]);

		// From here the pad is mapped normally again.
		source.push(usbBytes(CROSS), ds4);
		expect(actions).toEqual([{ kind: "confirm", button: "cross", phase: "press", heldMs: 0 }]);
	});

	test("a button held across a manual switch cannot re-arm without a release", async () => {
		// The edge that a bare consecutive counter gets wrong: one active report on
		// the DS4, then a hand-picked switch to the Xbox while that button is still
		// down. Counting from that first report would reach the switch point on the
		// very next report and take the app back with no new press at all.
		const { service, source } = await harness();
		const ds4 = opened(source, "ds4");
		source.push(usbBytes(CROSS), ds4);
		expect(service.switchPad("xbox")).toBe(true);
		expect(service.status().transport).toBe("xinput");

		const xbox = opened(source, "xbox");
		for (let at = 0; at < 5; at += 1) source.push(usbBytes(CROSS), ds4);
		expect(service.status().transport).toBe("xinput");

		// Release arms it; then two reports of CROSS are a deliberate pick-up.
		source.push(usbBytes(), ds4);
		source.push(usbBytes(CROSS), ds4);
		expect(service.status().transport).toBe("xinput");
		source.push(usbBytes(CROSS), ds4);
		expect(service.status().transport).toBe("usb");
		expect(xbox).toBeDefined();
	});

	test("a stick past the threshold for two reports switches; a nudge below it never does", async () => {
		const { service, source } = await harness();
		const xbox = opened(source, "xbox");
		source.push(xboxBytes(), xbox); // arm

		// Half deflection is inside the mapper's deadzone-plus, but far short of a
		// deliberate push: two of them must not move the app.
		source.push(xboxBytes(leftStick(0.5)), xbox);
		source.push(xboxBytes(leftStick(0.5)), xbox);
		expect(service.status().transport).toBe("usb");

		source.push(xboxBytes(leftStick(0.7)), xbox);
		expect(service.status().transport).toBe("usb");
		source.push(xboxBytes(leftStick(0.7)), xbox);
		expect(service.status().transport).toBe("xinput");
	});

	test("a stick that chose the pad runs no binding as it eases back through the deadzone", async () => {
		// The push that moves the app is at 0.6 or more, but the mapper reads a
		// direction from 0.25. A stick springing home passes through the band between
		// them, and a pad that counted as neutral there answered with a navigation
		// step for a push that was only meant to pick it up.
		const { service, source, actions } = await harness();
		const xbox = opened(source, "xbox");
		source.push(xboxBytes(), xbox); // arm
		source.push(xboxBytes(leftStick(0.9)), xbox);
		source.push(xboxBytes(leftStick(0.9)), xbox);
		expect(service.status().transport).toBe("xinput");

		for (const value of [0.55, 0.4, 0.3]) source.push(xboxBytes(leftStick(value)), xbox);
		expect(actions).toEqual([]);

		// Inside the deadzone is centered as far as the mapper is concerned: that
		// report ends the suppression and is mapped, and it produces nothing.
		source.push(xboxBytes(leftStick(0.1)), xbox);
		expect(actions).toEqual([]);

		// From here the stick is the user's again.
		source.push(xboxBytes(leftStick(0.9)), xbox);
		expect(actions).toEqual([{ kind: "right", button: "stick", phase: "press", heldMs: 0 }]);
	});

	test("the same holds for the right stick, which scrolls from the deadzone", async () => {
		const { service, source, actions } = await harness();
		const xbox = opened(source, "xbox");
		source.push(xboxBytes(), xbox);
		source.push(xboxBytes(rightStickY(0.9)), xbox);
		source.push(xboxBytes(rightStickY(0.9)), xbox);
		expect(service.status().transport).toBe("xinput");

		for (const value of [0.5, 0.35]) source.push(xboxBytes(rightStickY(value)), xbox);
		expect(actions).toEqual([]);
		source.push(xboxBytes(rightStickY(0.1)), xbox);
		expect(actions).toEqual([]);
	});

	test("the user's deadzone is where a stick stops being neutral", async () => {
		// A wider deadzone means the mapper ignores more of the travel, so a stick
		// at 0.4 is already home; a narrower one reads it as a push.
		const { service, source, actions } = await harness(undefined, { deadzone: 0.5 });
		const xbox = opened(source, "xbox");
		source.push(xboxBytes(), xbox);
		source.push(xboxBytes(leftStick(0.9)), xbox);
		source.push(xboxBytes(leftStick(0.9)), xbox);
		expect(service.status().transport).toBe("xinput");

		source.push(xboxBytes(leftStick(0.55)), xbox); // still past the user's deadzone
		expect(service.stats().reports).toBe(0);
		source.push(xboxBytes(leftStick(0.4)), xbox); // inside it: neutral, and mapped
		expect(service.stats().reports).toBe(1);
		expect(actions).toEqual([]);
	});

	test("the active pad going silent hands the app to the other pad instead of closing it", async () => {
		// A Bluetooth pad that goes out of range raises no error; it just stops. The
		// watchdog used to answer by dropping every link, healthy Xbox pad included,
		// and searching from scratch.
		const { service, source, clock } = await harness();
		const ds4 = opened(source, "ds4");
		const xbox = opened(source, "xbox");
		source.push(usbBytes(), ds4);

		for (let at = 0; at < 2_500; at += 16) {
			source.push(xboxBytes(), xbox);
			clock.advance(16);
		}

		const status = service.status();
		expect(status.phase).toBe("connected");
		expect(status.detail).toBeUndefined();
		expect(status.transport).toBe("xinput");
		expect(status.controllers?.find((controller) => controller.active)?.family).toBe("xbox");
		expect(source.closedFor(xbox)).toBe(false);
		expect(source.closedFor(ds4)).toBe(true);
		// The pad in hand is the one being read: its next report is mapped.
		source.push(xboxBytes(XBOX_A), xbox);
		expect(service.lastSample()?.family).toBe("xbox");
	});

	test("the active pad's cable comes out, and the other pad takes over at once", async () => {
		const { service, source } = await harness();
		const wired = opened(source, "ds4");
		source.detach(wired);

		// No silence to wait out: the link that was being read is closed, and there
		// is another pad attached. Searching would be a lie about the state.
		expect(service.status().phase).toBe("connected");
		expect(service.status().detail).toBeUndefined();
		expect(service.status().transport).toBe("xinput");
		const controllers = service.status().controllers ?? [];
		expect(controllers).toHaveLength(1);
		expect(controllers[0]?.family).toBe("xbox");
		expect(controllers[0]?.active).toBe(true);
	});

	test("an inactive pad's cable comes out and the active pad does not move", async () => {
		const { service, source } = await harness();
		const xbox = opened(source, "xbox");
		source.detach(xbox);

		expect(service.status().phase).toBe("connected");
		expect(service.status().transport).toBe("usb");
		const controllers = service.status().controllers ?? [];
		expect(controllers).toHaveLength(1);
		expect(controllers[0]?.key).toBe("ds4");
		expect(controllers[0]?.active).toBe(true);
	});

	test("a pad that appears later is opened inactive and told one dark packet", async () => {
		const { service, source, clock } = await harness([xboxDevice()]);
		expect(service.status().transport).toBe("xinput");
		source.takeWrites();

		source.attach(); // the faux default: one DualShock 4 collection
		clock.advance(1_100); // the link scan runs on the output tick

		expect(service.status().transport).toBe("xinput");
		expect(service.status().controllers?.map((controller) => controller.family)).toEqual(["xbox", "ds4"]);
		expect(service.status().controllers?.[1]?.active).toBe(false);

		// One write reached the new link, and it was dark. A DualShock 4 switched on
		// over Bluetooth sends unreadable power-on reports until a host writes a
		// valid output report; a pad that is never written to could never report
		// anything this service can parse, and so could never switch in.
		const dark = source.takeWrites().filter((packet) => packet.length === 32);
		expect(dark).toHaveLength(1);
		expect(hid(dark[0])).toEqual({ small: 0, large: 0, rgb: { r: 0, g: 0, b: 0 } });
	});
});

describe("choosing a pad by hand", () => {
	test("switchPad cycles, wraps, and resolves a word, an index, and a name", async () => {
		const { service } = await harness();
		expect(service.status().controllers?.map((controller) => controller.family)).toEqual(["ds4", "xbox"]);

		// No target cycles, and wraps.
		expect(service.switchPad()).toBe(true);
		expect(service.status().transport).toBe("xinput");
		expect(service.switchPad("next")).toBe(true);
		expect(service.status().transport).toBe("usb");

		// A family word, case-insensitive.
		expect(service.switchPad("XBOX")).toBe(true);
		expect(service.status().transport).toBe("xinput");
		// 1-based index; naming the pad already in hand is valid and changes nothing.
		expect(service.switchPad("2")).toBe(true);
		expect(service.status().transport).toBe("xinput");
		expect(service.switchPad("1")).toBe(true);
		expect(service.status().transport).toBe("usb");
		expect(service.switchPad("dualshock")).toBe(true);
		expect(service.status().transport).toBe("usb");

		// No such controller: false, and the active pad is untouched.
		expect(service.switchPad("nope")).toBe(false);
		expect(service.switchPad("3")).toBe(false);
		expect(service.status().transport).toBe("usb");
	});

	test("a controller answers to the path of either of its links", async () => {
		const [wireless, wired] = attachedTwice();
		const { service } = await harness([wireless, wired, xboxDevice()]);
		expect(service.switchPad("xbox")).toBe(true);

		// The controllers row names the link being read, but `/gamepad list` shows
		// both links of a DualShock 4. A path copied from the row the app is not
		// reading must still mean this controller.
		expect(service.switchPad(WIRELESS_PATH)).toBe(true);
		expect(service.status().controllers?.find((controller) => controller.active)?.family).toBe("ds4");
	});

	test("a single pad has nowhere to cycle, but naming it still works", async () => {
		const { service } = await harness([wiredDevice()]);
		expect(service.switchPad()).toBe(false);
		expect(service.switchPad("next")).toBe(false);
		expect(service.switchPad("ds4")).toBe(true);
	});

	test("a device filter pins one pad, so there is nothing to switch to", async () => {
		// "controller" is in the DualShock 4's name and the Xbox pad's. The setting
		// chooses a controller; it must not leave the other one attached and merely
		// unused, which is the state this whole feature would then keep flipping.
		const { service } = await harness(undefined, { device: "controller" });
		expect(service.status().controllers?.map((controller) => controller.family)).toEqual(["ds4"]);
		expect(service.switchPad()).toBe(false);
	});

	test("a blank device filter pins nothing, so the pads still switch", async () => {
		// The settings schema takes `""`, and a blank value means "unset".
		for (const device of ["", "   "]) {
			const { service } = await harness(undefined, { device });
			expect(service.status().controllers?.map((controller) => controller.family)).toEqual(["ds4", "xbox"]);
			expect(service.switchPad()).toBe(true);
			expect(service.status().transport).toBe("xinput");
		}
	});

	test("a name copied from the list picks that pad, not the first of its family", async () => {
		// The name of slot 2 contains "xbox". Reading the family word first picked
		// slot 1 every time, and answered `true` as if that were the pad asked for.
		const { service } = await harness([xboxDevice(0), xboxDevice(1)]);
		expect(service.switchPad("Xbox controller (XInput slot 2)")).toBe(true);
		expect(service.status().device?.path).toBe(xinputSlotPath(1));
		expect(service.switchPad("xbox controller (xinput slot 1)")).toBe(true);
		expect(service.status().device?.path).toBe(xinputSlotPath(0));
	});

	test("a phrase that only contains a family word still reaches the family", async () => {
		const { service } = await harness();
		expect(service.switchPad("xbox")).toBe(true);
		expect(service.status().transport).toBe("xinput");
		expect(service.switchPad("dualshock 4")).toBe(true);
		expect(service.status().transport).toBe("usb");
	});

	test("two XInput slots are two pads, switchable by slot path or name", async () => {
		const { service, source } = await harness([xboxDevice(0), xboxDevice(1)]);
		expect(service.status().controllers?.map((controller) => controller.key)).toEqual([
			`xbox:${xinputSlotPath(0)}`,
			`xbox:${xinputSlotPath(1)}`,
		]);
		expect(service.status().device?.path).toBe(xinputSlotPath(0));

		// Using the second slot moves the app there all by itself.
		const second = openedSlot(source, 1);
		source.push(xboxBytes(), second); // arm
		source.push(xboxBytes(XBOX_A), second);
		source.push(xboxBytes(XBOX_A), second);
		expect(service.status().device?.path).toBe(xinputSlotPath(1));

		// And either one can be asked for by path or by the name XInput gave it.
		expect(service.switchPad("xinput://0")).toBe(true);
		expect(service.status().device?.path).toBe(xinputSlotPath(0));
		expect(service.switchPad("slot 2")).toBe(true);
		expect(service.status().device?.path).toBe(xinputSlotPath(1));
	});
});

describe("what the cards can show", () => {
	test("each controller carries its own battery, whichever one is being read", async () => {
		const { service, source } = await harness();
		const ds4 = opened(source, "ds4");
		const xbox = opened(source, "xbox");

		source.push(usbBytes(battery(7)), ds4);
		source.push(xboxBytes(xboxBattery(2, 1)), xbox);

		const controllers = service.status().controllers ?? [];
		expect(controllers).toHaveLength(2);
		expect(controllers[0]?.battery).toEqual({ level: 7, cable: false });
		// XInput's own scale, including its own word for "low" — not a DS4 reading.
		expect(controllers[1]?.battery).toEqual({ level: 1, cable: false, full: 3, low: true });
		// The inactive pad's report refreshed its card and nothing else.
		expect(service.status().battery).toEqual({ level: 7, cable: false });
	});
});
