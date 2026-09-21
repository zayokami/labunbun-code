/**
 * Synthetic input reports, addressed by payload offset.
 *
 * The offsets here are the ones `ds4.ts` decodes from — byte 4 is the d-pad and
 * the face buttons, byte 5 the shoulders, byte 29 the battery — so a test says
 * `{ 4: 0x20 }` for "someone pressed ✕" instead of counting bytes from the start
 * of a packet. `ds4.test.ts` has its own copies of these builders: it is the
 * file that pins the wire format, and it should be able to fail when the layout
 * moves without this file moving with it.
 */

import { DS4_INPUT_CRC_SEED, ds4BluetoothCrc } from "../src/index.ts";

export interface Payload {
	[at: number]: number;
}

/**
 * No d-pad direction and no face buttons; the sticks are centred separately.
 *
 * The battery is a full one — ten on the pad's own scale, the reading a pad off
 * its cable gives — unless a test says otherwise, and that is not decoration: an
 * empty byte is a pad about to switch off, so a report that happens to leave it
 * at zero turns every "the bar is this colour" test into a test about a dying
 * controller's blink.
 *
 * The touch counters are the same kind of trap: bit 7 is *set* for "no finger",
 * so a report left at zero says two fingers are resting at (0, 0) — a state the
 * real pad is never in, and one no test here would notice, because a finger that
 * never moves and never lifts produces no gesture at all.
 */
const NEUTRAL = { 0: 0x80, 1: 0x80, 2: 0x80, 3: 0x80, 4: 0x08, 29: 0x0a, 34: 0x80, 38: 0x80 } as const;

function fill(bytes: Uint8Array, payload: Payload): void {
	for (const [at, value] of Object.entries({ ...NEUTRAL, ...payload })) bytes[Number(at)] = value;
}

/** A USB report: 64 bytes, payload from byte 1. */
export function usbBytes(payload: Payload = {}): Uint8Array {
	const bytes = new Uint8Array(64);
	bytes[0] = 0x01;
	const body = new Uint8Array(63);
	fill(body, payload);
	bytes.set(body, 1);
	return bytes;
}

/** A Bluetooth report: 78 bytes, payload from byte 3, with the trailing CRC. */
export function bluetoothBytes(payload: Payload = {}): Uint8Array {
	const bytes = new Uint8Array(78);
	bytes[0] = 0x11;
	bytes[1] = 0xc0;
	bytes[2] = 0x00;
	// 71 payload bytes: the report is 78, the first three are header and the last
	// four are the CRC.
	const body = new Uint8Array(71);
	fill(body, payload);
	bytes.set(body, 3);
	const at = bytes.length - 4;
	const crc = ds4BluetoothCrc(DS4_INPUT_CRC_SEED, bytes.subarray(0, at));
	bytes[at] = crc & 0xff;
	bytes[at + 1] = (crc >>> 8) & 0xff;
	bytes[at + 2] = (crc >>> 16) & 0xff;
	bytes[at + 3] = (crc >>> 24) & 0xff;
	return bytes;
}

/** The one byte that means "cross is down" — the button most tests press. */
export const CROSS = { 4: 0x28 } as const;

/** `up` on the d-pad: hat 0 in the low nibble. */
export const DPAD_UP = { 4: 0x00 } as const;

/** A battery byte: level in the low nibble, the cable bit above it. */
export function battery(level: number, cable = false): Payload {
	return { 29: level | (cable ? 0x10 : 0) };
}

/**
 * One finger on the surface, at the payload offsets the decoder reads: a counter
 * and three bytes of position, packed the way the pad packs them. `at` is which
 * of the two points to report — 34 for the first, 38 for the second.
 */
export function finger(at: 34 | 38, x: number, y: number, id = 0): Payload {
	return {
		[at]: id & 0x7f,
		[at + 1]: x & 0xff,
		[at + 2]: ((x >> 8) & 0x0f) | ((y & 0x0f) << 4),
		[at + 3]: (y >> 4) & 0xff,
	};
}
