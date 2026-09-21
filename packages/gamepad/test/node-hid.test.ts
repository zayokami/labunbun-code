/**
 * The one file that names node-hid, and the failure it must not have.
 *
 * node-hid is an optional dependency, which makes "it is not installed" a
 * supported way to run this package rather than an error: the whole feature is
 * off, the rest of the tool is unaffected, and the user is owed a sentence
 * saying which command fixes it. That path is the reason `load` is injected, and
 * it is the first thing tested here.
 *
 * The rest is a fake module standing in for a real one: a device list shaped
 * like the lists node-hid actually returns on Windows (four interfaces of which
 * one carries reports, and — with Steam open — a device with no path), and a
 * handle whose writes can be made to fail, because the OS refusing a write is
 * the normal case when a pad is unplugged mid-turn.
 */

import { describe, expect, test } from "bun:test";
import {
	createFauxSource,
	createNodeHidSource,
	createPadService,
	DEFAULT_BINDINGS,
	importNodeHid,
	NODE_HID_MISSING,
	type NodeHidDeviceInfo,
	type NodeHidModule,
	nodeHidModuleFrom,
	padPalette,
	pickDevice,
} from "../src/index.ts";
import { createFauxClock } from "./clock.ts";

const PALETTE = padPalette({ accent: "cyan", alert: "magenta" });
const A_PAD = { vendorId: 0x054c, productId: 0x09cc };

/** The four interfaces of one DualShock 4, as Windows lists them over USB. */
const INTERFACES: NodeHidDeviceInfo[] = [
	{ vendorId: 0x054c, productId: 0x09cc, path: "hid#iface-0", interface: 0, usagePage: 1, usage: 2 },
	{ vendorId: 0x054c, productId: 0x09cc, path: "hid#iface-2", interface: 2, usagePage: 1, usage: 2 },
	{
		vendorId: 0x054c,
		productId: 0x09cc,
		path: "hid#iface-3",
		interface: 3,
		usagePage: 1,
		usage: 5,
		product: "Wireless Controller",
	},
	{ vendorId: 0x054c, productId: 0x09cc, path: "hid#iface-4", interface: 4, usagePage: 1, usage: 2 },
];

/**
 * A stand-in for the module. Hand-written rather than `implements`: the real
 * `NodeHidHandle.on` is overloaded per event, and satisfying that overload set
 * would cost more lines than the fake — so the single cast at the bottom is the
 * price of a shorter double, and the interface is still checked where it is
 * used, since the source only ever sees `NodeHidModule`.
 */
class FakeHid {
	readonly written: number[][] = [];
	readonly path: string;
	closed = false;
	/** What `write` answers: bytes accepted, or 0 for "the device refused it". */
	writeResult = 3;
	/** Set to make every write throw, as a device that has been pulled does. */
	failWrites = false;
	failClose = false;
	private readonly listeners = new Map<string, ((payload: unknown) => void)[]>();

	constructor(path: string) {
		this.path = path;
		opened.push(this);
	}

	on(event: string, listener: (payload: never) => void): void {
		const list = this.listeners.get(event) ?? [];
		list.push(listener as (payload: unknown) => void);
		this.listeners.set(event, list);
	}

	write(data: readonly number[]): number {
		if (this.failWrites) throw new Error("device not open");
		this.written.push([...data]);
		return this.writeResult;
	}

	close(): void {
		if (this.failClose) throw new Error("already closed");
		this.closed = true;
	}

	emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(payload);
	}
}

/** The handles the fake module made, oldest first. Reassigned per `fakeNodeHid`. */
let opened: FakeHid[] = [];

function fakeNodeHid(devices: readonly NodeHidDeviceInfo[] = INTERFACES): NodeHidModule {
	opened = [];
	const HID = FakeHid as unknown as NodeHidModule["HID"];
	return { devices: () => devices, HID };
}

describe("the shape node-hid arrives in", () => {
	test("a CommonJS module is recognised however the import hands it over", () => {
		const direct = fakeNodeHid();
		expect(nodeHidModuleFrom(direct)).toBe(direct);
		// What `await import()` gives for a CommonJS package on Bun.
		expect(nodeHidModuleFrom({ default: direct })).toBe(direct);
	});

	test("what is not the module is refused rather than half-used", () => {
		const half = { devices: () => [] };
		expect(nodeHidModuleFrom(null)).toBeNull();
		expect(nodeHidModuleFrom(undefined)).toBeNull();
		expect(nodeHidModuleFrom("node-hid")).toBeNull();
		expect(nodeHidModuleFrom(half)).toBeNull();
		expect(nodeHidModuleFrom({ HID: () => undefined })).toBeNull();
		expect(nodeHidModuleFrom({ default: half })).toBeNull();
		expect(nodeHidModuleFrom({ default: undefined })).toBeNull();
	});

	test("the production loader answers a value either way, never an exception", async () => {
		// Not "it is null on this machine": on a checkout that has installed the
		// optional dependency it is the module, and on one that has not it is null.
		// What must hold in both worlds is that asking is not a crash, and that
		// whatever comes back is the shape the rest of this file expects.
		const loaded = await importNodeHid();
		if (loaded === null) return;
		expect(typeof loaded.devices).toBe("function");
		expect(typeof loaded.HID).toBe("function");
	});

	test("the loader names node-hid in a way a bundler can follow", async () => {
		// A source-text assertion, which is a thing to be suspicious of — but the
		// property is a build-time one and there is no other place to stand: the
		// loader has to be *readable* as "node-hid" by `bun build --compile`, since
		// a bundler cannot follow a name assembled at run time. When the name was
		// held in a variable, every test in this file passed, and the compiled
		// executable told the user node-hid was not installed while it sat in the
		// workspace. This is the only test that would have caught that.
		const source = await Bun.file(new URL("../src/sources/node-hid.ts", import.meta.url)).text();
		expect(source).toContain('import("node-hid"');
	});
});

describe("without the module", () => {
	test("not installed is a state with a command in it, not an error", async () => {
		const source = createNodeHidSource({ load: async () => null });
		// Before warmUp there is nothing to say: not looked yet is not broken.
		expect(source.unavailable()).toBeUndefined();
		expect(source.list()).toEqual([]);
		await source.warmUp();
		expect(source.unavailable()).toBe(NODE_HID_MISSING);
		expect(NODE_HID_MISSING).toContain("pnpm add");
		expect(source.list()).toEqual([]);
		expect(() => source.open(A_PAD)).toThrow(NODE_HID_MISSING);
	});

	test("asking is done once, however many times it is asked", async () => {
		let loads = 0;
		const source = createNodeHidSource({
			load: async () => {
				loads += 1;
				return null;
			},
		});
		await source.warmUp();
		await source.warmUp();
		expect(loads).toBe(1);
		expect(source.unavailable()).toBe(NODE_HID_MISSING);
	});

	test("opening before asking says which mistake it was", () => {
		// "Call warmUp" and "install it" have different fixes, and only one of them
		// is the user's problem. Collapsing them into "no controller" sends someone
		// to a cable that is fine.
		const source = createNodeHidSource({ load: async () => null });
		expect(() => source.open(A_PAD)).toThrow(/warmUp/);
	});

	test("the service over it says so in words and stops looking", async () => {
		// The whole feature with the optional dependency absent: no crash, no
		// three-second retry asking the same question forever.
		const clock = createFauxClock();
		const service = createPadService(
			{ bindings: DEFAULT_BINDINGS, palette: PALETTE },
			{ source: createNodeHidSource({ load: async () => null }), clock },
		);
		await service.enable();
		expect(service.status().phase).toBe("off");
		expect(service.status().detail).toBe(NODE_HID_MISSING);
		expect(service.devices()).toEqual([]);
		expect(clock.pending()).toBe(0);
	});

	test("a source that fails to load at all is a pad that is not there", async () => {
		// Not a crash: the module being broken is another way for there to be no
		// controller, which is the state this whole feature is built around.
		const source = createNodeHidSource({
			load: async () => {
				throw new Error("no such module");
			},
		});
		const clock = createFauxClock();
		const service = createPadService({ bindings: DEFAULT_BINDINGS, palette: PALETTE }, { source, clock });
		await service.enable();
		expect(service.status().phase).toBe("error");
		expect(service.status().detail).toBe("no such module");
		expect(clock.pending()).toBe(0);
	});
});

describe("with the module", () => {
	async function sourceWith(devices: readonly NodeHidDeviceInfo[]) {
		const source = createNodeHidSource({ load: async () => fakeNodeHid(devices) });
		await source.warmUp();
		return source;
	}

	test("only the pads, and every interface of them", async () => {
		const source = await sourceWith([
			...INTERFACES,
			{ vendorId: 0x046d, productId: 0xc52b, path: "hid#keyboard", usagePage: 1, usage: 6 },
		]);
		const list = source.list();
		expect(list.map((device) => device.path)).toEqual(["hid#iface-0", "hid#iface-2", "hid#iface-3", "hid#iface-4"]);
		expect(list.map((device) => device.carriesReports)).toEqual([false, false, true, false]);
		// The one the reports arrive on, which is the whole reason the list is not
		// just "the first device".
		expect(pickDevice(list)?.path).toBe("hid#iface-3");
	});

	test("a pad with no name from the OS is named by its model", async () => {
		const source = await sourceWith(INTERFACES);
		expect(source.list()[2]?.name).toBe("Wireless Controller");
		expect(source.list()[0]?.name).toBe("DualShock 4 v2 (CUH-ZCT2)");
	});

	test("a device another program is holding is kept, because that is the answer", async () => {
		// Steam and DS4Windows enumerate the pad with no path. Dropping it would
		// turn "something else has your controller" into "nothing is plugged in".
		const source = await sourceWith([{ vendorId: 0x054c, productId: 0x09cc, interface: 3, usagePage: 1, usage: 5 }]);
		expect(source.list()).toHaveLength(1);
		expect(source.list()[0]?.path).toBeUndefined();
		expect(pickDevice(source.list())).toBeUndefined();
		expect(() => source.open(source.list()[0] ?? A_PAD)).toThrow(/held by another program/);
	});

	test("reports arrive as plain bytes, whatever the module hands over", async () => {
		const source = await sourceWith(INTERFACES);
		const device = pickDevice(source.list());
		expect(device).toBeDefined();
		const handle = source.open(device ?? A_PAD);
		const received: Uint8Array[] = [];
		handle.onReport((bytes) => received.push(bytes));

		// A Buffer, which is what node-hid really gives: a view over memory that
		// the next read may write into again.
		const handed = Buffer.from([0x01, 0x80, 0x80]);
		opened[0]?.emit("data", handed);
		expect(received).toHaveLength(1);
		expect(Array.from(received[0] ?? [])).toEqual([0x01, 0x80, 0x80]);
		expect(Buffer.isBuffer(received[0])).toBe(false);
		handed[0] = 0xff;
		expect(received[0]?.[0]).toBe(0x01);
	});

	test("a read failure is reported as it came", async () => {
		const source = await sourceWith(INTERFACES);
		const handle = source.open(pickDevice(source.list()) ?? A_PAD);
		const seen: Error[] = [];
		handle.onError((error) => seen.push(error));
		const failure = new Error("device disconnected");
		opened[0]?.emit("error", failure);
		expect(seen).toEqual([failure]);
	});

	test("a write is the bytes, and a refusal is false rather than a throw", async () => {
		const source = await sourceWith(INTERFACES);
		const handle = source.open(pickDevice(source.list()) ?? A_PAD);
		const packet = new Uint8Array([0x05, 0xff, 0x00, 0x40]);
		expect(handle.write(packet)).toBe(true);
		// Numbers, not a typed array: this is the shape node-hid's write takes.
		expect(opened[0]?.written[0]).toEqual([0x05, 0xff, 0x00, 0x40]);

		if (opened[0] !== undefined) opened[0].failWrites = true;
		expect(handle.write(packet)).toBe(false);

		// And a write the device takes no bytes of is the same answer: it did not go.
		if (opened[0] !== undefined) {
			opened[0].failWrites = false;
			opened[0].writeResult = 0;
		}
		expect(handle.write(packet)).toBe(false);
	});

	test("closing a pad that is already gone is not worth an exception", async () => {
		const source = await sourceWith(INTERFACES);
		const handle = source.open(pickDevice(source.list()) ?? A_PAD);
		if (opened[0] !== undefined) opened[0].failClose = true;
		expect(() => handle.close()).not.toThrow();
	});

	test("a source that is all there is also works through the service", async () => {
		// Not a second copy of the service's tests: this is the one line where the
		// real source and the real service meet, on a fake module standing in for a
		// controller, and it is the path `bun run dev` takes with a pad plugged in.
		const clock = createFauxClock();
		const service = createPadService(
			{ bindings: DEFAULT_BINDINGS, palette: PALETTE },
			{ source: await sourceWith(INTERFACES), clock },
		);
		await service.enable();
		// Written to before anything has been read: the transport comes from the
		// device itself rather than from its first report, because a pad switched on
		// over Bluetooth sends nothing readable until something writes to it. The
		// packet is a different size on each transport, which is what this pins.
		expect(opened[0]?.written).toHaveLength(1);
		expect(opened[0]?.written[0]?.length).toBe(32);
		expect(service.status().phase).toBe("connected");
		expect(service.status().device?.interface).toBe(3);
		expect(opened).toHaveLength(1);
		expect(opened[0]?.path).toBe("hid#iface-3");
	});
});

describe("the faux source, on the same contract", () => {
	test("it answers the way the real one does", async () => {
		// The faux source is what every other test in this package runs against, so
		// the one thing worth pinning is that it is a source: nothing to load, and
		// a device that is there.
		const source = createFauxSource();
		expect(source.unavailable()).toBeUndefined();
		await source.warmUp();
		expect(source.list()).toHaveLength(1);
		const handle = source.open(source.list()[0] ?? A_PAD);
		expect(handle.write(new Uint8Array([1, 2]))).toBe(true);
		expect(source.writes()).toHaveLength(1);
	});
});
