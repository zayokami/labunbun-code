/**
 * The CRC a DualShock 4 verifies before it will read anything else in a
 * Bluetooth packet — and the one part of this protocol that fails silently, so
 * a wrong guess here costs a debugging session with no feedback from the pad at
 * all.
 *
 * Two of these tests are evidence from outside this repository: the canonical
 * CRC-32 check value, and Bun's own implementation of it (Zig's standard
 * library, which shares no code with the loop here). The fixed vectors are
 * regression pins — they cannot prove the seed and the complement are the ones
 * the pad wants, because only hardware can say that (see `bluetoothCrcOk` in
 * the service tests) — but they do mean changing either of them cannot pass
 * quietly.
 */

import { describe, expect, test } from "bun:test";
import { bluetoothCrcOk, crc32Le, DS4_INPUT_CRC_SEED, DS4_OUTPUT_CRC_SEED, ds4BluetoothCrc } from "../src/index.ts";

/** The CRC-32/ISO-HDLC check value: what every implementation returns for "123456789". */
const CHECK_VALUE = 0xcbf43926;

describe("crc32Le", () => {
	test("is the CRC-32 the world computes, up to the final inversion", () => {
		const bytes = new TextEncoder().encode("123456789");
		expect(~crc32Le(0xffffffff, bytes) >>> 0).toBe(CHECK_VALUE);
		expect(~crc32Le(0xffffffff, bytes) >>> 0).toBe(Bun.hash.crc32(bytes) >>> 0);
	});

	test("continues across calls, which is why the seed byte is hashed separately", () => {
		const whole = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
		expect(crc32Le(crc32Le(0xffffffff, whole.subarray(0, 3)), whole.subarray(3))).toBe(crc32Le(0xffffffff, whole));
	});
});

/** An output header with the lightbar on magenta and no rumble. */
const body = Uint8Array.of(0x11, 0xc4, 0x00, 0x07, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0xff);

describe("ds4BluetoothCrc", () => {
	test("matches the pinned vector for this body", () => {
		expect(ds4BluetoothCrc(DS4_OUTPUT_CRC_SEED, body).toString(16)).toBe("686b8b41");
	});

	test("the seed byte is part of the CRC, not decoration", () => {
		expect(ds4BluetoothCrc(DS4_INPUT_CRC_SEED, body).toString(16)).toBe("1ff559b1");
	});
});

describe("bluetoothCrcOk", () => {
	/** `body` followed by its own CRC in the trailing four bytes, little-endian. */
	function stamp(body: Uint8Array, seed: number): Uint8Array {
		const report = new Uint8Array(body.length + 4);
		report.set(body);
		const crc = ds4BluetoothCrc(seed, body);
		report[body.length] = crc & 0xff;
		report[body.length + 1] = (crc >>> 8) & 0xff;
		report[body.length + 2] = (crc >>> 16) & 0xff;
		report[body.length + 3] = (crc >>> 24) & 0xff;
		return report;
	}

	test("accepts a report whose trailing four bytes are its own CRC", () => {
		expect(bluetoothCrcOk(stamp(body, DS4_INPUT_CRC_SEED))).toBe(true);
	});

	test("rejects a flipped payload byte, and a flipped CRC byte", () => {
		const report = stamp(body, DS4_INPUT_CRC_SEED);
		report[5] ^= 0x01;
		expect(bluetoothCrcOk(report)).toBe(false);
		report[5] ^= 0x01;
		expect(bluetoothCrcOk(report)).toBe(true);
		report[body.length + 1] ^= 0x80;
		expect(bluetoothCrcOk(report)).toBe(false);
	});

	test("a report stamped with the output seed is not a valid input report", () => {
		expect(bluetoothCrcOk(stamp(body, DS4_OUTPUT_CRC_SEED))).toBe(false);
	});

	test("a report too short to hold a CRC is not valid", () => {
		// Arithmetic, not a length check: the missing bytes read as zero and the
		// body ends before them, so every one of these fails on its own.
		expect(bluetoothCrcOk(new Uint8Array(0))).toBe(false);
		expect(bluetoothCrcOk(Uint8Array.of(1, 2))).toBe(false);
		expect(bluetoothCrcOk(Uint8Array.of(1, 2, 3, 4))).toBe(false);
	});
});
