/**
 * The Xbox wire format — which here means XInput's `XINPUT_STATE` plus the two
 * battery bytes the source appends.
 *
 * The reports are built by hand from the documented struct, not captured,
 * because the layout is the struct's: a test that reused the source's packer
 * would agree with a decoder that shared its mistakes. What is pinned is the
 * *normalization* too: A is the bottom button and therefore `cross`, and the
 * whole binding table depends on that staying true.
 */

import { describe, expect, test } from "bun:test";
import {
	buildXboxOutput,
	decodeXboxBattery,
	parseXboxInput,
	XBOX_BATTERY_FULL,
	XBOX_TRIGGER_PRESS,
	XINPUT_VIBRATION_LENGTH,
	xboxButtonName,
} from "../src/index.ts";

/** XInput button bits, by the letter on the plastic. */
const A = 0x1000;
const B = 0x2000;
const X = 0x4000;
const Y = 0x8000;
const LB = 0x0100;
const RB = 0x0200;
const VIEW = 0x0020;
const MENU = 0x0010;
const LS = 0x0040;
const RS = 0x0080;
const DPAD_UP = 0x0001;
const DPAD_DOWN = 0x0002;
const DPAD_LEFT = 0x0004;
const DPAD_RIGHT = 0x0008;

interface ReportFields {
	buttons?: number;
	leftTrigger?: number;
	rightTrigger?: number;
	leftX?: number;
	leftY?: number;
	rightX?: number;
	rightY?: number;
	/** `BATTERY_TYPE_*`: 1 wired, 2 alkaline, 3 NiMH. */
	batteryType?: number;
	batteryLevel?: number;
}

/** An 18-byte report, laid out exactly as `XInputGetState` writes the first 16. */
function bytes(fields: ReportFields = {}): Uint8Array {
	const report = new Uint8Array(18);
	const view = new DataView(report.buffer);
	view.setUint32(0, 1234, true); // the pad's packet counter; decoded by nothing
	view.setUint16(4, fields.buttons ?? 0, true);
	report[6] = fields.leftTrigger ?? 0;
	report[7] = fields.rightTrigger ?? 0;
	view.setInt16(8, fields.leftX ?? 0, true);
	view.setInt16(10, fields.leftY ?? 0, true);
	view.setInt16(12, fields.rightX ?? 0, true);
	view.setInt16(14, fields.rightY ?? 0, true);
	report[16] = fields.batteryType ?? 1;
	report[17] = fields.batteryLevel ?? XBOX_BATTERY_FULL;
	return report;
}

function state(fields: ReportFields = {}) {
	const report = parseXboxInput(bytes(fields));
	if (report === undefined) throw new Error("the report did not parse");
	return report.state;
}

describe("parseXboxInput", () => {
	test("face buttons are normalized by position, not by letter", () => {
		// A is the bottom button, which is where the DualShock 4 keeps ✕; the
		// binding table says "confirm" for that position and must not hear a
		// different answer because the plastic has an A on it.
		expect(state({ buttons: A }).buttons).toEqual(["cross"]);
		expect(state({ buttons: B }).buttons).toEqual(["circle"]);
		expect(state({ buttons: X }).buttons).toEqual(["square"]);
		expect(state({ buttons: Y }).buttons).toEqual(["triangle"]);
	});

	test("a combination comes out in one fixed order", () => {
		expect(state({ buttons: A | B | X | Y }).buttons).toEqual(["square", "cross", "circle", "triangle"]);
	});

	test("shoulders, View/Menu and the stick clicks", () => {
		expect(state({ buttons: LB | RB }).buttons).toEqual(["l1", "r1"]);
		expect(state({ buttons: VIEW | MENU }).buttons).toEqual(["share", "options"]);
		expect(state({ buttons: LS | RS }).buttons).toEqual(["l3", "r3"]);
	});

	test("the d-pad reports its exact direction, and the ids that direction stands for", () => {
		const up = state({ buttons: DPAD_UP });
		expect(up.dpad).toBe("up");
		expect(up.buttons).toEqual(["up"]);

		const corner = state({ buttons: DPAD_DOWN | DPAD_LEFT });
		expect(corner.dpad).toBe("down-left");
		expect(corner.buttons).toEqual(["down", "left"]);

		const other = state({ buttons: DPAD_UP | DPAD_RIGHT });
		expect(other.dpad).toBe("up-right");

		expect(state({}).dpad).toBeNull();
	});

	test("the guide button is never reported: XInput reserves its bit", () => {
		// 0x0400 is XINPUT_GAMEPAD_GUIDE. If a future XInput starts exposing it,
		// this test is the place to decide what it should mean; today the bit must
		// not invent a `ps` button.
		expect(state({ buttons: 0x0400 }).buttons).toEqual([]);
	});

	test("triggers are analog, and become L2/R2 at the modifier threshold", () => {
		const below = state({ leftTrigger: 127, rightTrigger: 127 });
		expect(below.leftTrigger).toBeCloseTo(127 / 255);
		expect(below.buttons).toEqual([]);

		const above = state({ leftTrigger: 128, rightTrigger: 255 });
		expect(above.leftTrigger).toBeGreaterThanOrEqual(XBOX_TRIGGER_PRESS);
		expect(above.rightTrigger).toBe(1);
		// l2 before r2: the same order the rest of the shoulders use.
		expect(above.buttons).toEqual(["l2", "r2"]);
	});

	test("sticks are -1..1 with Y positive up, and the extremes clamp", () => {
		const neutral = state({});
		expect(neutral.leftStick).toEqual({ x: 0, y: 0 });

		const pushed = state({ leftX: 32767, leftY: -32768, rightX: -32768, rightY: 16384 });
		expect(pushed.leftStick.x).toBe(1);
		// XInput's Y already points up, so unlike the DualShock 4 there is no sign
		// flip; -32768 is one step past -1 and is clamped.
		expect(pushed.leftStick.y).toBe(-1);
		expect(pushed.rightStick.x).toBe(-1);
		expect(pushed.rightStick.y).toBeCloseTo(16384 / 32767);
	});

	test("the battery keeps XInput's three-step scale and its own low flag", () => {
		expect(state({ batteryType: 1, batteryLevel: 3 }).battery).toEqual({
			level: 3,
			cable: true,
			full: 3,
			low: false,
		});
		expect(state({ batteryType: 2, batteryLevel: 1 }).battery).toEqual({
			level: 1,
			cable: false,
			full: 3,
			low: true,
		});
		expect(state({ batteryType: 2, batteryLevel: 2 }).battery.low).toBe(false);
	});

	test("a level the pad could not measure fails towards empty, not full", () => {
		expect(decodeXboxBattery(2, 0xff)).toEqual({ level: 0, cable: false, full: 3, low: true });
	});

	test("there is no touch surface to report", () => {
		expect(state({}).touch).toBeUndefined();
		expect(parseXboxInput(bytes())?.transport).toBe("xinput");
	});

	test("a report shorter than the struct is not a report", () => {
		expect(parseXboxInput(new Uint8Array(17))).toBeUndefined();
		expect(parseXboxInput(new Uint8Array(0))).toBeUndefined();
	});

	test("a longer buffer is read from its front", () => {
		const padded = new Uint8Array(32);
		padded.set(bytes({ buttons: A }));
		expect(parseXboxInput(padded)?.state.buttons).toEqual(["cross"]);
	});
});

describe("buildXboxOutput", () => {
	test("two little-endian motor words, scaled from bytes", () => {
		// 0x40 × 257 = 0x4040, 0xFF × 257 = 0xFFFF: the scale is exact.
		expect(buildXboxOutput({ rumble: { large: 0x40, small: 0xff } })).toEqual(Uint8Array.of(0x40, 0x40, 0xff, 0xff));
	});

	test("absent and out-of-range values are off and clamped", () => {
		expect(buildXboxOutput()).toEqual(new Uint8Array(XINPUT_VIBRATION_LENGTH));
		expect(buildXboxOutput({ rumble: { large: -10, small: 300 } })).toEqual(Uint8Array.of(0x00, 0x00, 0xff, 0xff));
	});

	test("the lightbar and blink have nowhere to go, and change nothing", () => {
		const bare = buildXboxOutput({});
		const decorated = buildXboxOutput({
			lightbar: { r: 1, g: 2, b: 3 },
			blink: { on: 5, off: 6 },
		});
		expect(decorated).toEqual(bare);
	});
});

describe("xboxButtonName", () => {
	test("names the plastic, and leaves shared ids alone", () => {
		expect(xboxButtonName("cross")).toBe("A");
		expect(xboxButtonName("circle")).toBe("B");
		expect(xboxButtonName("square")).toBe("X");
		expect(xboxButtonName("triangle")).toBe("Y");
		expect(xboxButtonName("l2")).toBe("LT");
		expect(xboxButtonName("share")).toBe("View");
		expect(xboxButtonName("up")).toBe("up");
	});
});
