/**
 * Choosing a device, and saying why there isn't one.
 *
 * These are pure functions about a list the OS handed over, and they carry more
 * weight than their size suggests: every "it doesn't work" this feature has
 * starts here, and the difference between "nothing is plugged in" and
 * "something else is holding your controller" is the difference between the
 * user checking a cable that is fine and the user closing Steam.
 */

import { describe, expect, test } from "bun:test";
import {
	describePadDevice,
	deviceTransport,
	isDs4Device,
	matchesDevice,
	noDeviceDetail,
	type PadSourceDevice,
	pickDevice,
	pickLinks,
} from "../src/index.ts";
import { attachedTwice, WIRED_PATH, WIRELESS_PATH } from "./devices.ts";

function device(overrides: Partial<PadSourceDevice> = {}): PadSourceDevice {
	return { path: "hid#vid_054c&pid_09cc#1", vendorId: 0x054c, productId: 0x09cc, ...overrides };
}

/** The four interfaces a DualShock 4 presents, in the order Windows lists them. */
function interfaces(): PadSourceDevice[] {
	return [
		device({ path: "hid#0000", interface: 0 }),
		device({ path: "hid#0002", interface: 2 }),
		device({ path: "hid#0003", interface: 3, carriesReports: true, name: "Wireless Controller" }),
		device({ path: "hid#0004", interface: 4 }),
	];
}

describe("isDs4Device", () => {
	test("knows both models, and only them", () => {
		expect(isDs4Device(device())).toBe(true);
		expect(isDs4Device(device({ productId: 0x05c4 }))).toBe(true);
		expect(isDs4Device(device({ productId: 0x1234 }))).toBe(false);
		expect(isDs4Device(device({ vendorId: 0x045e }))).toBe(false);
	});
});

describe("describePadDevice", () => {
	test("names the model, and which interface of it this is", () => {
		expect(describePadDevice(device({ interface: 3 }))).toBe("DualShock 4 v2 (CUH-ZCT2) (interface 3)");
		expect(describePadDevice(device())).toBe("DualShock 4 v2 (CUH-ZCT2)");
	});

	test("says so when another program is holding it", () => {
		// The device enumerates with no path. That is not a device that is missing.
		expect(describePadDevice(device({ path: undefined }))).toBe("DualShock 4 v2 (CUH-ZCT2) (held by another program)");
	});

	test("falls back the way a person would read it", () => {
		expect(describePadDevice(device({ vendorId: 1, productId: 2, name: "Some Pad" }))).toBe("Some Pad");
		expect(describePadDevice(device({ vendorId: 1, productId: 2 }))).toBe("unknown controller");
	});
});

describe("matchesDevice", () => {
	test("a substring of the name or the path, however it is spelled", () => {
		const pad = device({ name: "Wireless Controller", path: "\\\\?\\hid#vid_054c&pid_09cc#8&1" });
		expect(matchesDevice(pad, "wireless")).toBe(true);
		expect(matchesDevice(pad, "WIRELESS CONTROLLER")).toBe(true);
		expect(matchesDevice(pad, "pid_09cc")).toBe(true);
		expect(matchesDevice(pad, "  vid_054c  ")).toBe(true);
		expect(matchesDevice(pad, "pid_05c4")).toBe(false);
		expect(matchesDevice(pad, "xbox")).toBe(false);
	});

	test("an empty setting means every device, which is what 'unset' has to mean", () => {
		const pad = device();
		expect(matchesDevice(pad, "")).toBe(true);
		expect(matchesDevice(pad, "   ")).toBe(true);
	});

	test("a held device can still be named, if only by its model", () => {
		// No path and no name from the OS: there is nothing left but the model, and
		// a user naming it deserves to find it.
		expect(matchesDevice(device({ path: undefined, name: undefined }), "dualshock")).toBe(true);
	});
});

describe("pickDevice", () => {
	test("only models this package can read, whichever came first", () => {
		const other = device({ vendorId: 0x045e, productId: 0x02ea, path: "hid#xbox" });
		expect(pickDevice([other, device()])?.path).toBe("hid#vid_054c&pid_09cc#1");
		expect(pickDevice([other])).toBeUndefined();
	});

	test("of the interfaces of one pad, the one that carries reports", () => {
		const picked = pickDevice(interfaces());
		expect(picked?.interface).toBe(3);
	});

	test("without that hint it takes the first, rather than nothing", () => {
		// Linux hidraw reports no usage at all. Refusing to guess there would mean
		// refusing to work there.
		const bare = interfaces().map(({ carriesReports: _drop, ...rest }) => rest);
		expect(pickDevice(bare)?.interface).toBe(0);
	});

	test("a device another program is holding is never the answer", () => {
		const held = device({ path: undefined, carriesReports: true });
		expect(pickDevice([held])).toBeUndefined();
		expect(pickDevice([held, device({ path: "hid#free", interface: 1 })])?.path).toBe("hid#free");
	});

	test("a named device that is not there is not quietly swapped for another", () => {
		// Whoever asked for one controller should hear that it is missing, not find
		// their input arriving from a different one.
		const pads = [
			device({ path: "a", name: "Wireless Controller" }),
			device({ path: "b", name: "Wireless Controller (2)" }),
		];
		expect(pickDevice(pads, "(2")?.path).toBe("b");
		expect(pickDevice(pads, "nintendo")).toBeUndefined();
	});
});

describe("noDeviceDetail", () => {
	test("nothing attached says nothing is attached", () => {
		expect(noDeviceDetail([])).toBe("no controller attached");
	});

	test("a held controller says so, because the cable is not the problem", () => {
		const detail = noDeviceDetail([device({ path: undefined })]);
		expect(detail).toContain("another program is holding it");
		expect(detail).toContain("Steam");
	});

	test("a device setting that matched nothing names itself", () => {
		expect(noDeviceDetail([device()], "nintendo")).toContain('"nintendo"');
	});

	test("but a named device with nothing attached at all is just nothing attached", () => {
		expect(noDeviceDetail([], "nintendo")).toBe("no controller attached");
	});

	test("an attached, openable pad is not something to have an excuse for", () => {
		// The service only asks when it found nothing; this is the wording for a
		// list that has no usable device in it.
		expect(noDeviceDetail([device({ path: undefined }), device({ path: undefined })])).toContain("another program");
	});
});

describe("pickLinks", () => {
	test("a pad that is wired and on the radio is both links, the wire first", () => {
		// The state this exists for: the cable is in and the pad is still switched
		// on, and the OS lists the two as unrelated collections. Both are opened and
		// both are written to, because nothing can tell which one the pad obeys.
		const [wireless, wired] = attachedTwice();
		expect(pickLinks([wireless, wired]).map(deviceTransport)).toEqual(["usb", "bluetooth"]);
		expect(pickLinks([wireless, wired])).toHaveLength(2);
	});

	test("of the four interfaces of one wired pad, the one that carries reports", () => {
		// The list is one pad seen four times, not four pads: only the interface the
		// OS says carries reports is a link.
		const links = pickLinks(interfaces());
		expect(links).toHaveLength(1);
		expect(links[0]?.interface).toBe(3);
	});

	test("one link per transport: two pads of one model on one wire are two controllers", () => {
		// The wire ranks first, so the first of the two is the link — this package
		// drives one controller, and a second one plugged in is not a second link of
		// the first.
		const pads = [
			device({ path: "a", interface: 3, carriesReports: true }),
			device({ path: "b", carriesReports: true }),
		];
		expect(pickLinks(pads)).toHaveLength(1);
		expect(pickLinks(pads)[0]?.path).toBe("a");
	});

	test("a source that cannot say which interface carries reports yields one link", () => {
		// Linux hidraw reports no usage at all, and every node looks alike: there is
		// nothing there that says two of them are two links of one pad, so nothing
		// here invents a second one.
		const bare = interfaces().map(({ carriesReports: _drop, ...rest }) => rest);
		expect(pickLinks(bare)).toHaveLength(1);
		expect(pickLinks(bare)[0]?.interface).toBe(0);
	});

	test("a device another program is holding is never a link", () => {
		const held = device({ path: undefined, carriesReports: true });
		expect(pickLinks([held])).toEqual([]);
	});

	test("a named device keeps the other controller's links out", () => {
		const pads = [
			device({ path: "a", name: "Wireless Controller", carriesReports: true }),
			device({ path: "b", name: "Wireless Controller (2)", carriesReports: true }),
		];
		expect(pickLinks(pads, "(2").map((pad) => pad.path)).toEqual(["b"]);
		expect(pickLinks(pads, "nintendo")).toEqual([]);
	});

	test("`pickDevice` is the link it leads with", () => {
		const [wireless, wired] = attachedTwice();
		expect(pickDevice([wireless, wired])).toBe(pickLinks([wireless, wired])[0]);
		expect(pickDevice([wireless, wired])?.path).toBe(WIRED_PATH);
	});
});

describe("deviceTransport", () => {
	// Both strings live in `devices.ts`: they are what Windows 11 really handed
	// over for this pad — one plugged in, one switched on over Bluetooth.

	test("a Bluetooth pad is recognised by the service UUID in its path", () => {
		expect(deviceTransport(device({ path: WIRELESS_PATH }))).toBe("bluetooth");
		// The OS does not promise a case for its own identifiers.
		expect(deviceTransport(device({ path: WIRELESS_PATH.toUpperCase() }))).toBe("bluetooth");
	});

	test("a wired pad is everything else, its own path included", () => {
		// The wired path carries a GUID of its own and the same vendor and product
		// id as the wireless one, so anything reading this as "has a GUID, must be
		// Bluetooth" gets the pad wrong in the direction that writes a 78-byte
		// packet to a device waiting for 32.
		expect(deviceTransport(device({ path: WIRED_PATH }))).toBe("usb");
	});

	test("a pad with no path at all has to say something", () => {
		// It cannot be opened — `pickDevice` refuses a device with no path, because
		// another program is holding it — so this is only ever the answer to a
		// question nobody should have asked. It still has to be an answer.
		expect(deviceTransport(device({ path: undefined }))).toBe("usb");
	});
});
