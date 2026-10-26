/**
 * The Xbox controller, as XInput sees it, in the same bytes-in/bytes-out shape
 * as the DualShock 4 decoder.
 *
 * Windows does not expose this pad through its HID collection: the collection
 * enumerates and opens, and then delivers nothing, because `xinputhid.sys` owns
 * the device. Measured on a real Xbox One pad: a five-second blocking read and
 * a fifteen-second event read both returned zero reports, while XInput returned
 * every button, stick and trigger. So the source polls XInput and the report
 * this file decodes is the one the source builds: the 16-byte `XINPUT_STATE`
 * followed by the battery type and level.
 *
 * The buttons are normalized *by position*, not by letter. A is the bottom face
 * button, so it decodes as `cross`; B is right (`circle`), X is left (`square`)
 * and Y is top (`triangle`). That is what keeps the binding table, the settings
 * file and every dialog hint working unchanged — "confirm" lives on the bottom
 * button on both families, and only the letter printed on the plastic differs.
 *
 * The guide button is deliberately absent: `XInputGetState` reserves its bit
 * (0x0400) and never reports it. There is no `ps` on this family.
 */

import {
	type DpadDirection,
	type Ds4ButtonId,
	dpadButtonIds,
	type PadBattery,
	type PadOutputState,
	type PadReport,
	type PadState,
} from "./ds4.ts";

/** XInput's battery scale: empty, low, medium, full. */
export const XBOX_BATTERY_FULL = 3;

/** The level XInput itself calls "low". */
const XBOX_BATTERY_LOW = 1;

/** `BATTERY_TYPE_WIRED`: the pad is on a cable and has no pack to drain. */
const XBOX_BATTERY_WIRED = 1;

/**
 * A trigger this far in counts as the corresponding button being down.
 *
 * XInput triggers are analog with no digital bit, while the DualShock 4 closes
 * its L2/R2 bits at the end of the pull. Half is the same threshold the mapper
 * uses to treat a trigger as a repeat modifier, so a binding on `l2`/`r2` fires
 * at exactly the point the modifier starts to apply.
 */
export const XBOX_TRIGGER_PRESS = 0.5;

/** The bytes one report occupies: `XINPUT_STATE`, then the two battery bytes. */
export const XBOX_REPORT_LENGTH = 18;

export interface XboxReport extends PadReport {
	transport: "xinput";
	state: PadState;
}

/** Xbox button bits, `wButtons` little-endian. The guide bit is reserved. */
const FACE_BUTTONS: ReadonlyArray<readonly [number, Ds4ButtonId]> = [
	[0x4000, "square"], // X, left
	[0x1000, "cross"], // A, bottom
	[0x2000, "circle"], // B, right
	[0x8000, "triangle"], // Y, top
];
const SHOULDER_BUTTONS: ReadonlyArray<readonly [number, Ds4ButtonId]> = [
	[0x0100, "l1"], // LB
	[0x0200, "r1"], // RB
];
const SYSTEM_BUTTONS: ReadonlyArray<readonly [number, Ds4ButtonId]> = [
	[0x0020, "share"], // View
	[0x0010, "options"], // Menu
	[0x0040, "l3"],
	[0x0080, "r3"],
];
const DPAD_BITS = { up: 0x0001, down: 0x0002, left: 0x0004, right: 0x0008 } as const;

/**
 * `XINPUT_STATE`'s field offsets. The packet number is at 0 and unused: it is
 * the pad's own counter, and the service's clock is the one everything is timed
 * against.
 */
const STATE = { buttons: 4, leftTrigger: 6, rightTrigger: 7, leftX: 8, leftY: 10, rightX: 12, rightY: 14 } as const;
const BATTERY_TYPE = 16;
const BATTERY_LEVEL = 17;

/**
 * One 18-byte report, or `undefined` for anything shorter.
 *
 * Unlike the DualShock 4 there is no framing to guess: the source builds these
 * bytes from XInput's struct, so length is the only check there is to make.
 */
export function parseXboxInput(bytes: Uint8Array): XboxReport | undefined {
	if (bytes.length < XBOX_REPORT_LENGTH) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const mask = view.getUint16(STATE.buttons, true);
	const leftTrigger = bytes[STATE.leftTrigger] / 255;
	const rightTrigger = bytes[STATE.rightTrigger] / 255;
	const dpad = dpadFrom(mask);

	const buttons: Ds4ButtonId[] = [];
	for (const [bit, id] of FACE_BUTTONS) if ((mask & bit) !== 0) buttons.push(id);
	for (const [bit, id] of SHOULDER_BUTTONS) if ((mask & bit) !== 0) buttons.push(id);
	if (leftTrigger >= XBOX_TRIGGER_PRESS) buttons.push("l2");
	if (rightTrigger >= XBOX_TRIGGER_PRESS) buttons.push("r2");
	for (const [bit, id] of SYSTEM_BUTTONS) if ((mask & bit) !== 0) buttons.push(id);
	if (dpad !== null) buttons.push(...dpadButtonIds(dpad));

	return {
		transport: "xinput",
		state: {
			leftStick: { x: stick(view.getInt16(STATE.leftX, true)), y: stick(view.getInt16(STATE.leftY, true)) },
			rightStick: { x: stick(view.getInt16(STATE.rightX, true)), y: stick(view.getInt16(STATE.rightY, true)) },
			leftTrigger,
			rightTrigger,
			dpad,
			buttons,
			battery: decodeXboxBattery(bytes[BATTERY_TYPE], bytes[BATTERY_LEVEL]),
		},
	};
}

/**
 * XInput's sticks are signed 16-bit, positive right and *up* — the same sign
 * convention the shared state uses, so unlike the DualShock 4 there is nothing
 * to invert here.
 */
function stick(value: number): number {
	return Math.max(-1, Math.min(1, value / 32767));
}

function dpadFrom(mask: number): DpadDirection | null {
	const up = (mask & DPAD_BITS.up) !== 0;
	const down = (mask & DPAD_BITS.down) !== 0;
	const left = (mask & DPAD_BITS.left) !== 0;
	const right = (mask & DPAD_BITS.right) !== 0;
	if (up && right) return "up-right";
	if (down && right) return "down-right";
	if (down && left) return "down-left";
	if (up && left) return "up-left";
	if (up) return "up";
	if (down) return "down";
	if (left) return "left";
	if (right) return "right";
	return null;
}

/**
 * XInput's two battery bytes as the shared shape.
 *
 * A level above full is a reading the pad could not make; like the DualShock 4
 * decoder, it comes through as zero rather than as a full bar, which is the one
 * answer that is certainly wrong. `low` is the pad's own word — XInput calls
 * level one "low" — and is left for the feedback layer instead of comparing a
 * three-step scale against a ten-step threshold.
 */
export function decodeXboxBattery(type: number, level: number): PadBattery {
	const cable = type === XBOX_BATTERY_WIRED;
	const measured = level <= XBOX_BATTERY_FULL ? level : 0;
	return { level: measured, cable, full: XBOX_BATTERY_FULL, low: !cable && measured <= XBOX_BATTERY_LOW };
}

/** `XINPUT_VIBRATION`: two little-endian 16-bit motor speeds. */
export const XINPUT_VIBRATION_LENGTH = 4;

/**
 * 0-255 scales to 0-65535 exactly: XInput's motors are byte-shaped values in a
 * word-sized field, and 255 × 257 fills the word.
 */
const XINPUT_MOTOR_SCALE = 257;

/**
 * The packet to write: `large` on the left (low-frequency) motor and `small` on
 * the right (high-frequency), the same way round the rest of the package names
 * them. A lightbar and a blink have no surface here and are ignored.
 */
export function buildXboxOutput(state: PadOutputState = {}): Uint8Array {
	const packet = new Uint8Array(XINPUT_VIBRATION_LENGTH);
	const view = new DataView(packet.buffer);
	view.setUint16(0, motor(state.rumble?.large), true);
	view.setUint16(2, motor(state.rumble?.small), true);
	return packet;
}

function motor(value: number | undefined): number {
	return Math.max(0, Math.min(255, Math.round(value ?? 0))) * XINPUT_MOTOR_SCALE;
}

/** The letters on the plastic, for text that has to name a button a person can see. */
const XBOX_BUTTON_NAMES: Readonly<Partial<Record<Ds4ButtonId, string>>> = {
	square: "X",
	cross: "A",
	circle: "B",
	triangle: "Y",
	l1: "LB",
	r1: "RB",
	l2: "LT",
	r2: "RT",
	share: "View",
	options: "Menu",
	l3: "LS",
	r3: "RS",
};

/** The Xbox name for a normalized id; ids with no counterpart keep their name. */
export function xboxButtonName(button: Ds4ButtonId): string {
	return XBOX_BUTTON_NAMES[button] ?? button;
}
