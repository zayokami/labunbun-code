/**
 * The source that joins two families.
 *
 * Its contract is that a machine missing one reader still gets the other: an
 * Xbox pad must work without node-hid, a DualShock 4 must work without XInput,
 * and only a machine with neither hears both fixes. The other half is `open`:
 * a device listed by one child is opened by that child, not by whichever child
 * happens to answer first.
 */

import { describe, expect, test } from "bun:test";
import { createCombinedSource, type PadSource, type PadSourceDevice, type PadSourceHandle } from "../src/index.ts";
import { wiredDevice, xboxDevice } from "./devices.ts";

function fakeSource(devices: PadSourceDevice[], options: { unavailable?: string; throwOnWarmUp?: unknown } = {}) {
	const opened: PadSourceDevice[] = [];
	let warmed = 0;
	const source: PadSource = {
		async warmUp() {
			warmed += 1;
			if ("throwOnWarmUp" in options) throw options.throwOnWarmUp;
		},
		unavailable() {
			return warmed > 0 ? options.unavailable : undefined;
		},
		list() {
			return warmed > 0 ? devices : [];
		},
		open(device) {
			opened.push(device);
			return {
				onReport() {},
				onError() {},
				write() {
					return true;
				},
				close() {},
			} satisfies PadSourceHandle;
		},
	};
	return { source, opened };
}

describe("warmUp and unavailable", () => {
	test("one child throwing does not stop the other, and its reason is kept", async () => {
		const hid = fakeSource([], { throwOnWarmUp: new Error("node-hid is not installed") });
		const xinput = fakeSource([xboxDevice()]);
		const combined = createCombinedSource([hid.source, xinput.source]);

		await combined.warmUp();
		// The Xbox child is usable, so the combined source is: the failure of the
		// other child is a reason it is skipped, not a reason to give up.
		expect(combined.unavailable()).toBeUndefined();
		expect(combined.list()).toEqual([xboxDevice()]);
	});

	test("a non-Error thrown during warmUp still becomes a reason", async () => {
		const broken = fakeSource([], { throwOnWarmUp: "boom" });
		const other = fakeSource([], { unavailable: "nothing to read" });
		const combined = createCombinedSource([broken.source, other.source]);

		await combined.warmUp();
		expect(combined.unavailable()).toBe("boom; nothing to read");
	});

	test("unavailable only when every child is, with every reason in the message", async () => {
		const hid = fakeSource([], { unavailable: "node-hid is not installed" });
		const xinput = fakeSource([], { unavailable: "XInput could not be loaded" });
		const combined = createCombinedSource([hid.source, xinput.source]);

		await combined.warmUp();
		expect(combined.unavailable()).toBe("node-hid is not installed; XInput could not be loaded");
		expect(combined.list()).toEqual([]);
	});

	test("no children at all says so rather than claiming success", async () => {
		const combined = createCombinedSource([]);
		await combined.warmUp();
		expect(combined.unavailable()).toBe("no controller source is available");
	});
});

describe("list", () => {
	test("only usable children contribute, in the order they were given", async () => {
		const hid = fakeSource([wiredDevice()]);
		const xinput = fakeSource([xboxDevice()]);
		const combined = createCombinedSource([hid.source, xinput.source]);

		await combined.warmUp();
		expect(combined.list().map((device) => device.path)).toEqual([wiredDevice().path, xboxDevice().path]);
	});

	test("a child that is unavailable is skipped even if it would list something", async () => {
		const hid = fakeSource([wiredDevice()], { unavailable: "node-hid is not installed" });
		const xinput = fakeSource([xboxDevice()]);
		const combined = createCombinedSource([hid.source, xinput.source]);

		await combined.warmUp();
		expect(combined.list()).toEqual([xboxDevice()]);
	});
});

describe("open", () => {
	test("routes a listed device back to the child that listed it, by identity and by path", async () => {
		const ds4 = fakeSource([wiredDevice()]);
		const xinput = fakeSource([xboxDevice()]);
		const combined = createCombinedSource([ds4.source, xinput.source]);
		await combined.warmUp();

		combined.open(wiredDevice());
		combined.open(xboxDevice(0));
		// A device the service rebuilt from `list()` is the same device: the path
		// is the identity the source promises.
		combined.open({ ...xboxDevice(0), name: "copied" });

		expect(ds4.opened).toHaveLength(1);
		expect(xinput.opened).toHaveLength(2);
		expect(ds4.opened[0].path).toBe(wiredDevice().path);
	});

	test("a device no child lists is an error that names it", () => {
		const combined = createCombinedSource([fakeSource([]).source]);
		expect(() => combined.open(wiredDevice())).toThrow("DualShock 4 v2 (CUH-ZCT2) (interface 3) is no longer attached");
	});

	test("an unavailable child is not asked to open anything", async () => {
		const hid = fakeSource([wiredDevice()], { unavailable: "node-hid is not installed" });
		const combined = createCombinedSource([hid.source]);
		await combined.warmUp();
		expect(() => combined.open(wiredDevice())).toThrow("is no longer attached");
		expect(hid.opened).toEqual([]);
	});
});
