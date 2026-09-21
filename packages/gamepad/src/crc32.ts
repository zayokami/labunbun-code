/**
 * The CRC a DualShock 4 puts on its Bluetooth reports.
 *
 * Neither direction is trusted without it: the pad drops an output report whose
 * CRC is wrong, and it drops it *silently*, so a wrong seed and a pad that is
 * ignoring you look exactly alike from the host side. That is the whole reason
 * this is four pure functions over bytes instead of something inlined at the
 * write site — the arithmetic can be tested without a device, and the one part
 * that cannot (does the pad agree?) is reported back as `bluetoothCrcOk`.
 *
 * The shape is the kernel's `crc32_le` pre-seeded the way hid-sony seeds it:
 * hash the seed byte first, then the report, complement the result and store it
 * little-endian in the four bytes the report reserved for it.
 */

/** Reflected CRC-32 polynomial — the one zlib and `Bun.hash.crc32` use. */
const CRC32_POLYNOMIAL = 0xedb88320;

/**
 * The seed byte hid-sony hashes ahead of the report itself. Output reports use
 * 0xA2, input reports 0xA1 — and since the two directions are otherwise the
 * same computation, a Bluetooth input report that verifies proves the output
 * packets are built right, which is not something the pad will tell us.
 */
export const DS4_INPUT_CRC_SEED = 0xa1;
export const DS4_OUTPUT_CRC_SEED = 0xa2;

/** Bytes a Bluetooth report reserves at its end for the CRC. */
export const DS4_BLUETOOTH_CRC_LENGTH = 4;

/**
 * CRC-32 with no final inversion, so a caller can feed the result back in as
 * the next `init` and get the CRC of the concatenation. `~crc32Le(0xffffffff,
 * bytes)` is what zlib and `Bun.hash.crc32` return for the same bytes.
 */
export function crc32Le(init: number, bytes: Uint8Array): number {
	let crc = init >>> 0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ CRC32_POLYNOMIAL : crc >>> 1;
	}
	return crc >>> 0;
}

/** The value that belongs in a Bluetooth report's trailing four bytes. */
export function ds4BluetoothCrc(seed: number, bytes: Uint8Array): number {
	return ~crc32Le(crc32Le(0xffffffff, Uint8Array.of(seed)), bytes) >>> 0;
}

/**
 * Whether a Bluetooth *input* report's trailing CRC matches its own contents.
 *
 * Reported rather than enforced: a report that does not verify is still worth
 * reading (a clone pad may compute it differently, and a report that arrived at
 * all is more interesting than one we threw away). What the flag is really for
 * is telling the user whether the offset constants are right — over Bluetooth
 * this is the only feedback the hardware gives.
 *
 * There is no length check, and one is not needed: a report too short to hold a
 * CRC reads its missing bytes as zero and hashes a body that ends before them,
 * so it cannot come out true. The tests pin that for 0, 2 and 4 bytes.
 */
export function bluetoothCrcOk(report: Uint8Array, seed = DS4_INPUT_CRC_SEED): boolean {
	const at = report.length - DS4_BLUETOOTH_CRC_LENGTH;
	const body = report.subarray(0, at);
	const expected = ds4BluetoothCrc(seed, body);
	const actual = (report[at] | (report[at + 1] << 8) | (report[at + 2] << 16) | (report[at + 3] << 24)) >>> 0;
	return actual === expected;
}
