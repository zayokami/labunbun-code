/**
 * The two collections of one pad that is plugged in *and* switched on.
 *
 * Both paths are what Windows 11 really handed over for this controller, copied
 * rather than invented: the whole job of `deviceTransport` is to read the OS's
 * own naming, and a made-up path would only pin a test against itself. Note that
 * the wired path carries a GUID of its own, so "has a GUID, must be Bluetooth"
 * is wrong in the direction that writes a 78-byte packet to a device waiting for
 * 32.
 *
 * The pad is listed as two unrelated HID collections, one per link, and nothing
 * on either says they are the same controller — measured, the wired one's serial
 * number is empty and the wireless one's is the pad's own Bluetooth address.
 * That is why the package opens both and writes to both (`pickLinks`) instead of
 * trying to pick the one the pad will obey.
 */

import type { PadSourceDevice } from "../src/index.ts";

export const WIRED_PATH = "\\\\?\\HID#VID_054C&PID_09CC&MI_03#7&1c3f0d1&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";
export const WIRELESS_PATH =
	"\\\\?\\HID#{00001124-0000-1000-8000-00805f9b34fb}_VID&0002054c_PID&09cc#8&2b6f0d2&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}";

/** The collection the input reports arrive on while the cable is in: interface 3. */
export function wiredDevice(): PadSourceDevice {
	return {
		path: WIRED_PATH,
		vendorId: 0x054c,
		productId: 0x09cc,
		// Both collections carry the same product string — which is why the
		// `device` setting cannot tell the two links apart, and does not have to.
		name: "Wireless Controller",
		interface: 3,
		carriesReports: true,
	};
}

/** The collection that arrived over Bluetooth, which carries reports as well. */
export function wirelessDevice(): PadSourceDevice {
	return {
		path: WIRELESS_PATH,
		vendorId: 0x054c,
		productId: 0x09cc,
		name: "Wireless Controller",
		carriesReports: true,
	};
}

/**
 * Both links, the radio first on purpose: the wire must rank first because
 * `pickLinks` decides that, not because the OS happened to list it first.
 */
export function attachedTwice(): [PadSourceDevice, PadSourceDevice] {
	return [wirelessDevice(), wiredDevice()];
}
