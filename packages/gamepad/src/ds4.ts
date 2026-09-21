/**
 * The DualShock 4 wire format, both directions, as pure functions over bytes.
 *
 * Nothing here opens a device. The offsets come from the kernel drivers
 * (hid-sony, hid-playstation) and from Chromium's `dualshock4_controller`,
 * which agree on all of it; the tests carry reports captured from a real pad on
 * this machine, so a change to the layout has to argue with hardware and not
 * just with a comment.
 *
 * Two transports, one layout. A USB report is 64 bytes and opens with 0x01; a
 * Bluetooth report is 78 and opens with 0x11, with every common field shifted
 * two bytes because its header is longer. The shift is not a guess — the kernel
 * reads the battery at byte 30 over USB and byte 32 over Bluetooth, and both go
 * through the same parser here — but it is also why the layout is chosen by
 * *length*, not by which device we happened to open: clone pads keep the USB
 * report id over Bluetooth.
 */

import { bluetoothCrcOk, DS4_BLUETOOTH_CRC_LENGTH, DS4_OUTPUT_CRC_SEED, ds4BluetoothCrc } from "./crc32.ts";

export type Ds4Transport = "usb" | "bluetooth";

export const DS4_VENDOR_ID = 0x054c;

/** The Sony pads this package knows: product id, and the name worth showing a user. */
const DS4_MODELS: ReadonlyArray<readonly [number, string]> = [
	[0x05c4, "DualShock 4 (CUH-ZCT1)"],
	[0x09cc, "DualShock 4 v2 (CUH-ZCT2)"],
];

export const DS4_PRODUCT_IDS: readonly number[] = DS4_MODELS.map(([productId]) => productId);

/** `undefined` for anything that is not one of the pads above. */
export function describeModel(vendorId: number, productId: number): string | undefined {
	if (vendorId !== DS4_VENDOR_ID) return undefined;
	return DS4_MODELS.find(([id]) => id === productId)?.[1];
}

/**
 * The 18 buttons a user can rebind, in the order the settings reference lists
 * them. The sticks and the analog triggers are deliberately absent: the sticks
 * are navigation and the triggers are modifiers, and neither is a thing you
 * hand to a different action.
 */
export type Ds4ButtonId =
	| "up"
	| "down"
	| "left"
	| "right"
	| "square"
	| "cross"
	| "circle"
	| "triangle"
	| "l1"
	| "r1"
	| "l2"
	| "r2"
	| "share"
	| "options"
	| "l3"
	| "r3"
	| "ps"
	| "touchpad";

export const DS4_BUTTON_IDS: readonly Ds4ButtonId[] = [
	"up",
	"down",
	"left",
	"right",
	"square",
	"cross",
	"circle",
	"triangle",
	"l1",
	"r1",
	"l2",
	"r2",
	"share",
	"options",
	"l3",
	"r3",
	"ps",
	"touchpad",
];

export type DpadDirection = "up" | "down" | "left" | "right" | "up-right" | "down-right" | "down-left" | "up-left";

/**
 * The d-pad's 8-way hat, in the order the report encodes it. Index 8 is the
 * released position, and the table is indexed by the raw nibble — `watch`
 * prints the name from here too, so the two can never disagree.
 */
export const DPAD_DIRECTIONS: readonly (DpadDirection | null)[] = [
	"up",
	"up-right",
	"right",
	"down-right",
	"down",
	"down-left",
	"left",
	"up-left",
	null,
];

/**
 * A diagonal is two buttons held at once, which is how a user reads it: the
 * mapping layer picks a dominant axis for navigation, but "is up held" has to
 * be true whichever corner of the d-pad is under the thumb.
 */
const DPAD_BUTTONS: Readonly<Record<DpadDirection, readonly Ds4ButtonId[]>> = {
	up: ["up"],
	down: ["down"],
	left: ["left"],
	right: ["right"],
	"up-right": ["up", "right"],
	"down-right": ["down", "right"],
	"down-left": ["down", "left"],
	"up-left": ["up", "left"],
};

export interface Ds4Axis {
	x: number;
	y: number;
}

export interface Ds4Battery {
	/**
	 * The pad's own scale: 0-10, and past 10 with the cable in once the pack is
	 * full. Not a percentage — the display layer multiplies, and clamps.
	 */
	level: number;
	/** The cable is in. This is the bit that means "charging". */
	cable: boolean;
}

export interface Ds4State {
	/** Sticks in -1..1, 0 at rest, Y positive *up*. The report has it inverted. */
	leftStick: Ds4Axis;
	rightStick: Ds4Axis;
	/** Analog, 0..1. The digital bits in `buttons` only close near the end. */
	leftTrigger: number;
	rightTrigger: number;
	/** The exact position, diagonals included. */
	dpad: DpadDirection | null;
	/** Pressed buttons in a fixed order, so two identical states compare equal. */
	buttons: Ds4ButtonId[];
	battery: Ds4Battery;
}

export interface Ds4Report {
	transport: Ds4Transport;
	state: Ds4State;
	/** Bluetooth only: whether the trailing CRC verified. See `bluetoothCrcOk`. */
	crcOk?: boolean;
}

/**
 * Field offsets inside the report's *payload* — what follows the report id on
 * USB, and the two-byte header on Bluetooth. Relative on purpose: the two
 * transports differ by this shift and nothing else.
 */
const PAYLOAD = {
	leftX: 0,
	leftY: 1,
	rightX: 2,
	rightY: 3,
	/** Low nibble: the 8-way d-pad. High nibble: square cross circle triangle. */
	dpadFace: 4,
	/** L1 R1 L2 R2 share options L3 R3, one bit each. */
	shoulders: 5,
	/** Bits 0-1: PS and the touchpad click. Bits 2-7: the pad's report counter. */
	system: 6,
	leftTrigger: 7,
	rightTrigger: 8,
	/** Battery nibble and cable bit; the touchpad block starts five bytes later. */
	battery: 29,
} as const;

const USB_REPORT_ID = 0x01;
const BLUETOOTH_REPORT_ID = 0x11;
const USB_REPORT_LENGTH = 64;
const BLUETOOTH_REPORT_LENGTH = 78;
const USB_PAYLOAD_OFFSET = 1;
const BLUETOOTH_PAYLOAD_OFFSET = 3;

const FACE_BUTTONS: ReadonlyArray<readonly [number, Ds4ButtonId]> = [
	[0x10, "square"],
	[0x20, "cross"],
	[0x40, "circle"],
	[0x80, "triangle"],
];

const SHOULDER_BUTTONS: ReadonlyArray<readonly [number, Ds4ButtonId]> = [
	[0x01, "l1"],
	[0x02, "r1"],
	[0x04, "l2"],
	[0x08, "r2"],
	[0x10, "share"],
	[0x20, "options"],
	[0x40, "l3"],
	[0x80, "r3"],
];

const SYSTEM_BUTTONS: ReadonlyArray<readonly [number, Ds4ButtonId]> = [
	[0x01, "ps"],
	[0x02, "touchpad"],
];

const STICK_CENTER = 128;
const STICK_SPAN = 127;

/**
 * The top of the battery's scale, and the number every reading is out of.
 *
 * The nibble is a capacity in units of ten percent, so the scale runs 0-10 and
 * the last step is a real one — the pad on this desk reports 10 while charging,
 * and a UI that divides by nine prints it as "10/9".
 */
export const DS4_BATTERY_FULL = 10;

/** One past the top of the scale: the pad saying "on the cable, and charged". */
const DS4_BATTERY_CHARGED = DS4_BATTERY_FULL + 1;

/**
 * The battery byte: the low nibble is the capacity, bit 4 is the cable. The two
 * are read together because the pad uses them together — it marks a finished
 * charge with a value that is not a capacity at all.
 *
 * A real 0 comes through as 0: an empty reading is a pad about to switch off, and
 * inventing an "unknown" for it would hide the one moment the number matters. A
 * reading *above* 11 gets the same treatment for the opposite reason: 14 and 15
 * are what the Linux driver treats as a cell it could not measure, and a full bar
 * is the one answer that is certainly wrong for a battery nobody can read.
 */
export function decodeBattery(byte: number): Ds4Battery {
	const raw = byte & 0x0f;
	return { level: batteryLevel(raw), cable: (byte & 0x10) !== 0 };
}

function batteryLevel(raw: number): number {
	if (raw <= DS4_BATTERY_FULL) return raw;
	if (raw === DS4_BATTERY_CHARGED) return DS4_BATTERY_FULL;
	return 0;
}

/**
 * The pad's state, or `undefined` for anything that is not a DualShock 4 report
 * — a short read, a report from some other device, a zeroed buffer.
 */
export function parseDs4Input(bytes: Uint8Array): Ds4Report | undefined {
	const id = bytes[0];
	if (id === BLUETOOTH_REPORT_ID) {
		const report = reportWindow(bytes);
		if (report.length < BLUETOOTH_REPORT_LENGTH) return undefined;
		return {
			transport: "bluetooth",
			state: decode(report, BLUETOOTH_PAYLOAD_OFFSET),
			crcOk: bluetoothCrcOk(report),
		};
	}
	if (id !== USB_REPORT_ID) return undefined;
	if (bytes.length === USB_REPORT_LENGTH) return { transport: "usb", state: decode(bytes, USB_PAYLOAD_OFFSET) };
	// A USB report id on something that is not a USB report's length is one of two
	// things, and they cannot be told apart by looking. One is a pad in the mode it
	// powers on in over Bluetooth: it sends the USB shape with no Bluetooth header
	// and no CRC, and stops as soon as a host writes to it. The other is a clone pad
	// that keeps 0x01 on a Bluetooth link, where the fields really are two bytes
	// later. Guessing wrong shifts every field and invents button presses nobody
	// made, so the framing has to be *proved* instead: the CRC covers the Bluetooth
	// layout and nothing else, and 32 bits of it agreeing is not a coincidence. A
	// report that cannot prove it is not read at all — the one case where the CRC
	// is enforced rather than reported, because here it is the only evidence there
	// is about what these bytes are.
	const report = reportWindow(bytes);
	if (report.length === BLUETOOTH_REPORT_LENGTH && bluetoothCrcOk(report)) {
		return { transport: "bluetooth", state: decode(report, BLUETOOTH_PAYLOAD_OFFSET), crcOk: true };
	}
	return undefined;
}

/**
 * The report inside whatever the OS handed back.
 *
 * A read is not always as long as the report in it: Windows hands a Bluetooth
 * read back padded out to the descriptor's maximum — 547 bytes for a report the
 * pad sent 78 of — and everything wanted here is at the front of that, the CRC
 * included, because the CRC is at the end of the *report*. Reading the end of
 * the buffer instead reads padding, and the CRC of padding is never right; that
 * is what a steady `crc bad` on a working pad means.
 */
function reportWindow(bytes: Uint8Array): Uint8Array {
	return bytes.length > BLUETOOTH_REPORT_LENGTH ? bytes.subarray(0, BLUETOOTH_REPORT_LENGTH) : bytes;
}

function decode(bytes: Uint8Array, at: number): Ds4State {
	const dpadFace = bytes[at + PAYLOAD.dpadFace];
	const dpad = DPAD_DIRECTIONS[dpadFace & 0x0f] ?? null;
	const shoulders = bytes[at + PAYLOAD.shoulders];
	const system = bytes[at + PAYLOAD.system];

	const buttons: Ds4ButtonId[] = [];
	for (const [mask, id] of FACE_BUTTONS) if (dpadFace & mask) buttons.push(id);
	for (const [mask, id] of SHOULDER_BUTTONS) if (shoulders & mask) buttons.push(id);
	// Bits 2-7 are the pad's own counter, which is why this is masked: reading
	// the whole byte would make every report look like eight buttons.
	for (const [mask, id] of SYSTEM_BUTTONS) if (system & mask) buttons.push(id);
	if (dpad) buttons.push(...DPAD_BUTTONS[dpad]);

	return {
		leftStick: { x: axis(bytes[at + PAYLOAD.leftX]), y: upAxis(bytes[at + PAYLOAD.leftY]) },
		rightStick: { x: axis(bytes[at + PAYLOAD.rightX]), y: upAxis(bytes[at + PAYLOAD.rightY]) },
		leftTrigger: bytes[at + PAYLOAD.leftTrigger] / 255,
		rightTrigger: bytes[at + PAYLOAD.rightTrigger] / 255,
		dpad,
		buttons,
		battery: decodeBattery(bytes[at + PAYLOAD.battery]),
	};
}

function axis(byte: number): number {
	return Math.max(-1, Math.min(1, (byte - STICK_CENTER) / STICK_SPAN));
}

/** The report has Y growing downwards; every caller wants it the other way. */
function upAxis(byte: number): number {
	const value = axis(byte);
	// Negating a centered stick would hand out `-0`, which compares unequal to
	// `0` in a test and prints as "-0" in a debug dump.
	return value === 0 ? 0 : -value;
}

/** What to write to the pad. Everything is optional; absent means "leave dark". */
export interface Ds4OutputState {
	/** 0-255 per motor: `small` is the right-hand one, `large` the left. */
	rumble?: { small?: number; large?: number };
	lightbar?: { r: number; g: number; b: number };
	/** Blink timings in 10 ms units; the pad needs both halves or neither takes. */
	blink?: { on: number; off: number };
}

const USB_OUTPUT_REPORT_ID = 0x05;
const BLUETOOTH_OUTPUT_REPORT_ID = 0x11;
const USB_OUTPUT_LENGTH = 32;

/**
 * Header bytes for an output report, one set per transport. These say which
 * fields the pad should read, so the value is the union of what the sources
 * set: an extra bit asserts a field we leave at zero (no effect), while a
 * missing one drops a field we meant — and a pad that ignores a packet explains
 * nothing. If the lightbar stays dark on real hardware, these are the first
 * constants to widen; the pre-CRC kernel patch used 0xB0/0x0F where SDL uses
 * 0xC0/0x07, which is what the DualShock 4 v2 answers to.
 */
const USB_VALID_FLAGS = 0xff;
const BLUETOOTH_HW_CONTROL = 0xc0 | 0x04;
const BLUETOOTH_VALID_FLAGS = 0x07;

/**
 * The packet to write. Bluetooth packets carry a CRC the pad verifies before it
 * will look at anything else in them, so a report built here and rejected there
 * is indistinguishable from a pad that is off.
 */
export function buildDs4Output(transport: Ds4Transport, state: Ds4OutputState = {}): Uint8Array {
	const lightbar = state.lightbar ?? { r: 0, g: 0, b: 0 };
	const rumble = state.rumble ?? {};

	if (transport === "bluetooth") {
		const packet = new Uint8Array(BLUETOOTH_REPORT_LENGTH);
		packet[0] = BLUETOOTH_OUTPUT_REPORT_ID;
		packet[1] = BLUETOOTH_HW_CONTROL;
		packet[3] = BLUETOOTH_VALID_FLAGS;
		packet[6] = rumble.small ?? 0;
		packet[7] = rumble.large ?? 0;
		packet[8] = lightbar.r;
		packet[9] = lightbar.g;
		packet[10] = lightbar.b;
		packet[11] = state.blink?.on ?? 0;
		packet[12] = state.blink?.off ?? 0;
		const at = BLUETOOTH_REPORT_LENGTH - DS4_BLUETOOTH_CRC_LENGTH;
		const crc = ds4BluetoothCrc(DS4_OUTPUT_CRC_SEED, packet.subarray(0, at));
		packet[at] = crc & 0xff;
		packet[at + 1] = (crc >>> 8) & 0xff;
		packet[at + 2] = (crc >>> 16) & 0xff;
		packet[at + 3] = (crc >>> 24) & 0xff;
		return packet;
	}

	const packet = new Uint8Array(USB_OUTPUT_LENGTH);
	packet[0] = USB_OUTPUT_REPORT_ID;
	packet[1] = USB_VALID_FLAGS;
	packet[4] = rumble.small ?? 0;
	packet[5] = rumble.large ?? 0;
	packet[6] = lightbar.r;
	packet[7] = lightbar.g;
	packet[8] = lightbar.b;
	packet[9] = state.blink?.on ?? 0;
	packet[10] = state.blink?.off ?? 0;
	return packet;
}
