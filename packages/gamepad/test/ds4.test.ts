/**
 * The wire format, checked against two kinds of evidence.
 *
 * IDLE_REPORT is a real DualShock 4 v2 on USB, captured on this machine with
 * every stick and button at rest — so "byte 5 is the d-pad nibble" argues with a
 * device rather than with a comment. The button tables are the part hardware has
 * not yet confirmed one press at a time (`/gamepad watch` is how that gets
 * settled), and they are written as absolute byte offsets on purpose: the
 * implementation's own offset table must not be the thing checking it.
 */

import { describe, expect, test } from "bun:test";
import {
	bluetoothCrcOk,
	buildDs4Output,
	type DpadDirection,
	DS4_OUTPUT_CRC_SEED,
	type Ds4ButtonId,
	decodeBattery,
	describeModel,
	ds4BluetoothCrc,
	parseDs4Input,
} from "../src/index.ts";

/** 64 bytes, id 0x01, every input released, battery full with the cable in. */
const IDLE_REPORT = hex(
	"01808080800800fc 00006d7f000c00e7 ff040051ffd61e40 0400000000001a00 " +
		"00010086d5b43a82 0000000080000000 8000000000800000 0080000000008000",
);

function hex(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text.replace(/\s/g, ""), "hex"));
}

/** A USB report with the given absolute byte offsets set, at rest everywhere else. */
function usbReport(bytes: Record<number, number> = {}): Uint8Array {
	const report = new Uint8Array(64);
	report.set(rest, 0);
	report[0] = 0x01;
	for (const [at, value] of Object.entries(bytes)) report[Number(at)] = value;
	return report;
}

/**
 * The same report over Bluetooth: 78 bytes, report id 0x11, and every common
 * field two bytes later. The shift lives here, in the test, so that a
 * parser which picks the wrong payload start cannot pass by agreeing with
 * itself.
 */
function bluetoothReport(bytes: Record<number, number> = {}): Uint8Array {
	const report = new Uint8Array(78);
	report.set(rest, 2);
	report[0] = 0x11;
	for (const [at, value] of Object.entries(bytes)) report[Number(at) + 2] = value;
	return report;
}

/** A released pad, as the absolute bytes a report would carry: sticks centered, hat away. */
const rest = (() => {
	const bytes = new Uint8Array(64);
	bytes[1] = bytes[2] = bytes[3] = bytes[4] = 0x80;
	bytes[5] = 0x08;
	return bytes;
})();

function buttonsOf(report: Uint8Array): Ds4ButtonId[] | undefined {
	return parseDs4Input(report)?.state.buttons;
}

describe("parseDs4Input", () => {
	test("reads a real pad at rest", () => {
		expect(IDLE_REPORT.length).toBe(64);
		const report = parseDs4Input(IDLE_REPORT);
		expect(report?.transport).toBe("usb");
		expect(report?.state.leftStick).toEqual({ x: 0, y: 0 });
		expect(report?.state.rightStick).toEqual({ x: 0, y: 0 });
		expect(report?.state.leftTrigger).toBe(0);
		expect(report?.state.rightTrigger).toBe(0);
		expect(report?.state.dpad).toBeNull();
		expect(report?.state.buttons).toEqual([]);
		// Byte 30 of this capture is 0x1a: level 10 on the pad's scale, cable in.
		expect(report?.state.battery).toEqual({ level: 10, cable: true });
		expect(report?.crcOk).toBeUndefined();
	});

	test("the d-pad is the low nibble of byte 5", () => {
		const cases: Array<[number, DpadDirection | null]> = [
			[0, "up"],
			[1, "up-right"],
			[2, "right"],
			[3, "down-right"],
			[4, "down"],
			[5, "down-left"],
			[6, "left"],
			[7, "up-left"],
			[8, null],
		];
		for (const [hat, direction] of cases) {
			expect(parseDs4Input(usbReport({ 5: hat }))?.state.dpad).toBe(direction);
		}
	});

	test("a corner of the d-pad is both of its buttons", () => {
		expect(buttonsOf(usbReport({ 5: 0x01 }))).toEqual(["up", "right"]);
		expect(buttonsOf(usbReport({ 5: 0x03 }))).toEqual(["down", "right"]);
	});

	test("the face buttons are the high nibble of byte 5, above a released hat", () => {
		const cases: Array<[number, Ds4ButtonId]> = [
			[0x10, "square"],
			[0x20, "cross"],
			[0x40, "circle"],
			[0x80, "triangle"],
		];
		for (const [mask, button] of cases) {
			expect(buttonsOf(usbReport({ 5: 0x08 | mask }))).toEqual([button]);
		}
	});

	test("the row of shoulders is all eight bits of byte 6", () => {
		const cases: Array<[number, Ds4ButtonId]> = [
			[0x01, "l1"],
			[0x02, "r1"],
			[0x04, "l2"],
			[0x08, "r2"],
			[0x10, "share"],
			[0x20, "options"],
			[0x40, "l3"],
			[0x80, "r3"],
		];
		for (const [mask, button] of cases) {
			expect(buttonsOf(usbReport({ 6: mask }))).toEqual([button]);
		}
	});

	test("PS and the touchpad click are the low bits of byte 7, and the rest is a counter", () => {
		expect(buttonsOf(usbReport({ 7: 0x03 }))).toEqual(["ps", "touchpad"]);
		// Bits 2-7 increment on every report. Reading the whole byte would make
		// each one look like six buttons held.
		expect(buttonsOf(usbReport({ 7: 0xfc }))).toEqual([]);
	});

	test("sticks are centered at 0x80 and read Y positive up", () => {
		expect(parseDs4Input(usbReport({ 1: 0x00 }))?.state.leftStick).toEqual({ x: -1, y: 0 });
		expect(parseDs4Input(usbReport({ 1: 0xff }))?.state.leftStick).toEqual({ x: 1, y: 0 });
		expect(parseDs4Input(usbReport({ 2: 0x00 }))?.state.leftStick).toEqual({ x: 0, y: 1 });
		expect(parseDs4Input(usbReport({ 2: 0xff }))?.state.leftStick).toEqual({ x: 0, y: -1 });
		// The right stick reads from bytes 3 and 4, and 0x00 on a Y byte is up.
		expect(parseDs4Input(usbReport({ 3: 0xff, 4: 0x00 }))?.state.rightStick).toEqual({ x: 1, y: 1 });
		expect(parseDs4Input(usbReport({ 3: 0x00, 4: 0xff }))?.state.rightStick).toEqual({ x: -1, y: -1 });
	});

	test("triggers are the analog bytes 8 and 9", () => {
		const state = parseDs4Input(usbReport({ 8: 0xff, 9: 0x80 }))?.state;
		expect(state?.leftTrigger).toBe(1);
		expect(state?.rightTrigger).toBeCloseTo(0.502, 3);
	});

	test("the battery is byte 30 over USB and byte 32 over Bluetooth", () => {
		expect(parseDs4Input(usbReport({ 30: 0x1a }))?.state.battery).toEqual({ level: 10, cable: true });
		expect(parseDs4Input(bluetoothReport({ 30: 0x1a }))?.state.battery).toEqual({ level: 10, cable: true });
		expect(parseDs4Input(usbReport({ 30: 0x03 }))?.state.battery).toEqual({ level: 3, cable: false });
		expect(parseDs4Input(usbReport({ 30: 0x0b }))?.state.battery).toEqual({ level: 10, cable: false });
		expect(parseDs4Input(usbReport({ 30: 0x00 }))?.state.battery).toEqual({ level: 0, cable: false });
	});

	test("the same state parses the same over either transport", () => {
		const bytes = { 1: 0x20, 5: 0x28, 6: 0x02, 8: 0x40, 30: 0x1a };
		const wired = parseDs4Input(usbReport(bytes));
		const wireless = parseDs4Input(bluetoothReport(bytes));
		expect(wired?.transport).toBe("usb");
		expect(wireless?.transport).toBe("bluetooth");
		expect(wireless?.state).toEqual(wired?.state);
	});

	test("says whether a Bluetooth report's own CRC verified", () => {
		const report = bluetoothReport({ 5: 0x28 });
		const at = report.length - 4;
		const crc = ds4BluetoothCrc(0xa1, report.subarray(0, at));
		report[at] = crc & 0xff;
		report[at + 1] = (crc >>> 8) & 0xff;
		report[at + 2] = (crc >>> 16) & 0xff;
		report[at + 3] = (crc >>> 24) & 0xff;
		expect(parseDs4Input(report)?.crcOk).toBe(true);

		// A report that does not verify is still read: what the flag buys is
		// knowing the offsets are right, not permission to throw bytes away.
		report[5] = 0x29;
		expect(parseDs4Input(report)?.crcOk).toBe(false);
		expect(buttonsOf(report)).toEqual(["cross"]);
	});

	test("a report under the USB id is Bluetooth only if its CRC says so", () => {
		// Clone pads are known to keep 0x01 over Bluetooth, and the fields really are
		// two bytes later when they do — but the same id and a longer-than-USB length
		// is also what a DualShock 4 sends over Bluetooth for the first second after
		// it is switched on, in its USB shape and with no Bluetooth header at all. The
		// two are the same bytes read two ways, so nothing about the report can say
		// which it is except the CRC, which covers the Bluetooth layout and nothing
		// else. A CRC that agrees is the framing; no CRC is no answer.
		const clone = bluetoothReport({ 5: 0x28, 30: 0x1a });
		clone[0] = 0x01;
		expect(parseDs4Input(clone)).toBeUndefined();

		const at = clone.length - 4;
		const crc = ds4BluetoothCrc(0xa1, clone.subarray(0, at));
		for (let byte = 0; byte < 4; byte += 1) clone[at + byte] = (crc >>> (byte * 8)) & 0xff;
		const parsed = parseDs4Input(clone);
		expect(parsed?.transport).toBe("bluetooth");
		expect(parsed?.crcOk).toBe(true);
		expect(parsed?.state.battery).toEqual({ level: 10, cable: true });
		expect(buttonsOf(clone)).toEqual(["cross"]);
	});

	test("a Bluetooth read that the OS padded out is read from the front of it", () => {
		// Windows hands back 547 bytes for a report the pad sent 78 of. Everything
		// wanted is at the front, the CRC included — which is at the end of the
		// report, not of the buffer — so a parser that reads the last four bytes of
		// what it was handed checks the padding and reports a bad CRC forever.
		const report = bluetoothReport({ 5: 0x28, 30: 0x1a });
		const at = report.length - 4;
		const crc = ds4BluetoothCrc(0xa1, report.subarray(0, at));
		for (let byte = 0; byte < 4; byte += 1) report[at + byte] = (crc >>> (byte * 8)) & 0xff;
		const padded = new Uint8Array(547);
		padded.set(report);

		const parsed = parseDs4Input(padded);
		expect(parsed?.transport).toBe("bluetooth");
		expect(parsed?.crcOk).toBe(true);
		expect(parsed?.state.battery).toEqual({ level: 10, cable: true });
		expect(parsed?.state.buttons).toEqual(["cross"]);
	});

	test("the USB shape a pad sends over Bluetooth before it has been written to", () => {
		// This is the report a DualShock 4 sends from the moment it is switched on
		// until a host writes to it: the USB id, a USB-shaped payload, the rest of
		// the buffer zero, and no CRC anywhere. Reading it as Bluetooth puts the
		// sticks three bytes early and turns a pad nobody is holding into one that
		// is pointing up with an empty battery, so it is refused instead.
		const compat = new Uint8Array(547);
		compat.set([0x01, 0x80, 0x80, 0x80, 0x80, 0x08, 0x00], 0);
		expect(parseDs4Input(compat)).toBeUndefined();
	});

	test("what is not a DualShock 4 report", () => {
		expect(parseDs4Input(new Uint8Array(0))).toBeUndefined();
		expect(parseDs4Input(new Uint8Array(64))).toBeUndefined();
		expect(parseDs4Input(IDLE_REPORT.subarray(0, 63))).toBeUndefined();
		expect(parseDs4Input(hex(`04${"00".repeat(63)}`))).toBeUndefined();
	});
});

describe("decodeBattery", () => {
	test("the low nibble is the level and bit 4 is the cable", () => {
		expect(decodeBattery(0x09)).toEqual({ level: 9, cable: false });
		expect(decodeBattery(0x19)).toEqual({ level: 9, cable: true });
		expect(decodeBattery(0x10)).toEqual({ level: 0, cable: true });
	});

	test("the scale ends at ten, and eleven is the pad saying it has finished charging", () => {
		// The nibble is a capacity in tens of percent, so ten is a hundred and the
		// top of the scale — the pad on this desk reports exactly this over USB, and
		// a decoder that stopped at nine printed it as "10/9".
		expect(decodeBattery(0x0a)).toEqual({ level: 10, cable: false });
		// Eleven is past the scale and is not a capacity at all: it is the Linux
		// driver's DS4_BATTERY_STATUS_FULL, "on the cable and charged". Ten is the
		// honest reading — a full cell — and the separate cable bit says the rest.
		expect(decodeBattery(0x0b)).toEqual({ level: 10, cable: false });
		expect(decodeBattery(0x1b)).toEqual({ level: 10, cable: true });
		// A real zero is kept: it is a pad about to switch off, which is the one
		// moment the number is worth showing.
		expect(decodeBattery(0x00)).toEqual({ level: 0, cable: false });
	});

	test("a reading the pad says it could not take is not reported as a full battery", () => {
		// Fourteen and fifteen are what hid-playstation.c calls an unmeasurable
		// cell. Zero is the honest answer — the bar is empty because nothing was
		// read — and the tempting alternative, leaning on the high nibble being
		// near the top, would draw a full bar for a battery nobody measured.
		expect(decodeBattery(0x0e)).toEqual({ level: 0, cable: false });
		expect(decodeBattery(0x0f)).toEqual({ level: 0, cable: false });
		expect(decodeBattery(0x1f)).toEqual({ level: 0, cable: true });
	});
});

describe("buildDs4Output", () => {
	test("a USB packet is 32 bytes with the motors at 4/5 and the lightbar at 6/7/8", () => {
		const packet = buildDs4Output("usb", {
			rumble: { small: 0x40, large: 0x80 },
			lightbar: { r: 0xff, g: 0, b: 0xff },
		});
		expect(packet.length).toBe(32);
		expect(packet[0]).toBe(0x05);
		// The header bytes are a claim about what the pad reads, and the one part
		// of the packet no fixture here can confirm — pinned so a change to them
		// is a decision, not a drift.
		expect(packet[1]).toBe(0xff);
		expect([...packet.subarray(4, 9)]).toEqual([0x40, 0x80, 0xff, 0x00, 0xff]);
	});

	test("a Bluetooth packet is 78 bytes, two later, and carries its own CRC", () => {
		const packet = buildDs4Output("bluetooth", {
			rumble: { small: 0x40, large: 0x80 },
			lightbar: { r: 0xff, g: 0, b: 0xff },
		});
		expect(packet.length).toBe(78);
		expect(packet[0]).toBe(0x11);
		expect(packet[1]).toBe(0xc4);
		expect(packet[3]).toBe(0x07);
		expect([...packet.subarray(6, 11)]).toEqual([0x40, 0x80, 0xff, 0x00, 0xff]);
		expect(bluetoothCrcOk(packet, DS4_OUTPUT_CRC_SEED)).toBe(true);

		// The pad verifies this before it reads anything else, so a packet whose
		// CRC is over the wrong span is a packet the pad never sees.
		packet[8] = 0x00;
		expect(bluetoothCrcOk(packet, DS4_OUTPUT_CRC_SEED)).toBe(false);
	});

	test("an empty packet is black and silent, not uninitialized", () => {
		expect([...buildDs4Output("usb").subarray(4, 11)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
	});
});

describe("describeModel", () => {
	test("names the pads it knows and declines the rest", () => {
		expect(describeModel(0x054c, 0x09cc)).toBe("DualShock 4 v2 (CUH-ZCT2)");
		expect(describeModel(0x054c, 0x05c4)).toBe("DualShock 4 (CUH-ZCT1)");
		expect(describeModel(0x054c, 0x0ce6)).toBeUndefined();
		expect(describeModel(0x1234, 0x09cc)).toBeUndefined();
	});
});
