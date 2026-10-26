/**
 * The XInput source, on a fake library and a clock the test fires by hand.
 *
 * Two things are worth pinning beyond "a report comes out": the source polls a
 * *slot* rather than opening a path (XInput's whole interface), and a pad that
 * disappears is an error on the handle rather than a stream of reports that
 * quietly stop — the service's silence watchdog would eventually notice either
 * way, but the immediate signal is what makes a pulled cable reconnect at once.
 */

import { describe, expect, test } from "bun:test";
import {
	buildXboxOutput,
	createXInputSource,
	XBOX_REPORT_LENGTH,
	XINPUT_MISSING,
	XINPUT_NOT_WINDOWS,
	XINPUT_POLL_MS,
	type XInputModule,
	type XInputTimer,
	xinputSlotPath,
} from "../src/index.ts";
import { XINPUT_CAPABILITIES_LENGTH, XINPUT_STATE_LENGTH, xinputSubtypeLabel } from "../src/sources/xinput.ts";

/** A capabilities answer for the fake; leaving it out models a module without the call. */
interface FakeCapabilities {
	/** `SubType` per slot. A slot not named here answers GAMEPAD. */
	subtypes?: Record<number, number>;
	/** A non-zero result to answer instead of filling in the struct. */
	result?: number;
	/** Thrown instead of answering. */
	throws?: Error;
}

/** A library whose slots, state, battery and capabilities the test sets. */
function fakeXInput(slots: number[], capabilities?: FakeCapabilities) {
	const connected = new Set(slots);
	let state = new Uint8Array(XINPUT_STATE_LENGTH);
	let batteryType = 1;
	let batteryLevel = 3;
	const writes: Uint8Array[] = [];
	const capabilityCalls: { slot: number; length: number }[] = [];

	const module: XInputModule = {
		getState(slot, out) {
			if (!connected.has(slot)) return 1167;
			out.set(state);
			return 0;
		},
		getBattery(slot, out) {
			if (!connected.has(slot)) return 1167;
			out[0] = batteryType;
			out[1] = batteryLevel;
			return 0;
		},
		setState(slot, vibration) {
			if (!connected.has(slot)) return 1167;
			writes.push(Uint8Array.from(vibration));
			return 0;
		},
	};

	if (capabilities !== undefined) {
		module.getCapabilities = (slot, out) => {
			capabilityCalls.push({ slot, length: out.length });
			if (capabilities.throws !== undefined) throw capabilities.throws;
			if (capabilities.result !== undefined) return capabilities.result;
			// `SubType` is the second byte of `XINPUT_CAPABILITIES`.
			out[1] = capabilities.subtypes?.[slot] ?? 0x01;
			return 0;
		};
	}

	return {
		module,
		connected,
		writes,
		capabilityCalls,
		setState(next: Uint8Array) {
			state = Uint8Array.from(next);
		},
		setButtons(mask: number) {
			state[4] = mask & 0xff;
			state[5] = (mask >>> 8) & 0xff;
		},
		setBattery(type: number, level: number) {
			batteryType = type;
			batteryLevel = level;
		},
	};
}

interface FakeInterval extends XInputTimer {
	handler: () => void;
	ms: number;
	cleared: boolean;
}

/** Timers the test advances with `fire()`, so no real setInterval is involved. */
function fakeTimers() {
	const intervals: FakeInterval[] = [];
	const timers = {
		setInterval(handler: () => void, ms: number): XInputTimer {
			const interval: FakeInterval = { handler, ms, cleared: false };
			intervals.push(interval);
			return interval;
		},
		clearInterval(timer: XInputTimer) {
			(timer as FakeInterval).cleared = true;
		},
	};
	return {
		timers,
		intervals,
		fire() {
			for (const interval of intervals) if (!interval.cleared) interval.handler();
		},
	};
}

async function source(fake: ReturnType<typeof fakeXInput>, clock = fakeTimers()) {
	const s = createXInputSource({ load: async () => fake.module, timers: clock.timers });
	await s.warmUp();
	return { source: s, clock };
}

describe("unavailable", () => {
	test("nothing is known before warmUp, and the message afterwards names the platform", async () => {
		const s = createXInputSource({ load: async () => null, timers: fakeTimers().timers });
		if (process.platform === "win32") expect(s.unavailable()).toBeUndefined();
		await s.warmUp();
		expect(s.unavailable()).toBe(process.platform === "win32" ? XINPUT_MISSING : XINPUT_NOT_WINDOWS);
		expect(s.list()).toEqual([]);
	});

	test("the loader is asked once, however many warmUps", async () => {
		let loads = 0;
		const fake = fakeXInput([0]);
		const s = createXInputSource({
			load: async () => {
				loads += 1;
				return fake.module;
			},
			timers: fakeTimers().timers,
		});
		await s.warmUp();
		await s.warmUp();
		expect(loads).toBe(1);
	});
});

describe("list", () => {
	test("one device per connected slot, named the way a person counts them", async () => {
		const fake = fakeXInput([1, 3]);
		const { source: s } = await source(fake);
		const devices = s.list();
		expect(devices.map((device) => device.path)).toEqual([xinputSlotPath(1), xinputSlotPath(3)]);
		expect(devices.map((device) => device.name)).toEqual([
			"Xbox controller (XInput slot 2)",
			"Xbox controller (XInput slot 4)",
		]);
		// The family is the claim that makes `pickLinks` accept it: XInput has no
		// vendor/product ids to match against a table.
		expect(devices.every((device) => device.family === "xbox")).toBe(true);
		expect(devices.every((device) => device.carriesReports === true)).toBe(true);
	});

	test("a slot that disappears leaves the list", async () => {
		const fake = fakeXInput([0, 1]);
		const { source: s } = await source(fake);
		expect(s.list()).toHaveLength(2);
		fake.connected.delete(0);
		expect(s.list().map((device) => device.path)).toEqual([xinputSlotPath(1)]);
	});
});

describe("subtype labels", () => {
	test("every documented subtype has words, and anything else stays generic", () => {
		expect(xinputSubtypeLabel(0x00)).toBe("Xbox controller");
		expect(xinputSubtypeLabel(0x01)).toBe("Xbox controller");
		expect(xinputSubtypeLabel(0x02)).toBe("Xbox wheel");
		expect(xinputSubtypeLabel(0x03)).toBe("Xbox arcade stick");
		expect(xinputSubtypeLabel(0x04)).toBe("Xbox flight stick");
		expect(xinputSubtypeLabel(0x05)).toBe("Xbox dance pad");
		expect(xinputSubtypeLabel(0x06)).toBe("Xbox guitar");
		expect(xinputSubtypeLabel(0x07)).toBe("Xbox guitar");
		expect(xinputSubtypeLabel(0x08)).toBe("Xbox drum kit");
		expect(xinputSubtypeLabel(0x0b)).toBe("Xbox bass guitar");
		expect(xinputSubtypeLabel(0x13)).toBe("Xbox arcade pad");
		expect(xinputSubtypeLabel(0x7f)).toBe("Xbox controller");
	});
});

describe("capabilities naming", () => {
	test("a plain gamepad keeps the name this source has always used", async () => {
		const fake = fakeXInput([0], { subtypes: { 0: 0x01 } });
		const { source: s } = await source(fake);
		expect(s.list().map((device) => device.name)).toEqual(["Xbox controller (XInput slot 1)"]);
	});

	test("a wheel is named as a wheel, not as a controller", async () => {
		const fake = fakeXInput([0], { subtypes: { 0: 0x02 } });
		const { source: s } = await source(fake);
		expect(s.list().map((device) => device.name)).toEqual(["Xbox wheel (XInput slot 1)"]);
	});

	test("an arcade pad on slot 1 is still slot 2 to a person", async () => {
		const fake = fakeXInput([1], { subtypes: { 1: 0x13 } });
		const { source: s } = await source(fake);
		expect(s.list().map((device) => device.name)).toEqual(["Xbox arcade pad (XInput slot 2)"]);
	});

	test("a subtype newer than this table falls back to the generic name", async () => {
		const fake = fakeXInput([0], { subtypes: { 0: 0x7f } });
		const { source: s } = await source(fake);
		expect(s.list().map((device) => device.name)).toEqual(["Xbox controller (XInput slot 1)"]);
	});

	test("a module without capabilities still lists its pads", async () => {
		const fake = fakeXInput([2]);
		const { source: s } = await source(fake);
		expect(s.list().map((device) => device.name)).toEqual(["Xbox controller (XInput slot 3)"]);
	});

	test("a refused capabilities call costs the label, not the pad", async () => {
		const fake = fakeXInput([0], { result: 1167, subtypes: { 0: 0x02 } });
		const { source: s } = await source(fake);
		const devices = s.list();
		expect(devices.map((device) => device.name)).toEqual(["Xbox controller (XInput slot 1)"]);
		expect(devices.map((device) => device.path)).toEqual([xinputSlotPath(0)]);
	});

	test("a capabilities call that throws costs the label, not the pad", async () => {
		const fake = fakeXInput([0], { throws: new Error("the fake cannot answer"), subtypes: { 0: 0x02 } });
		const { source: s } = await source(fake);
		const devices = s.list();
		expect(devices.map((device) => device.name)).toEqual(["Xbox controller (XInput slot 1)"]);
		expect(devices.map((device) => device.path)).toEqual([xinputSlotPath(0)]);
	});

	test("one 20-byte request per connected slot, made by list and by nothing else", async () => {
		const fake = fakeXInput([0, 2], { subtypes: { 0: 0x02, 2: 0x04 } });
		const { source: s, clock } = await source(fake);
		expect(fake.capabilityCalls).toEqual([]);

		// Open and poll a slot without asking `list()` first: capabilities belong
		// to discovery, not to the report path, so a running pad must not ask.
		const handle = s.open({ path: xinputSlotPath(0), vendorId: 0, productId: 0, family: "xbox" });
		clock.fire();
		handle.close();
		expect(fake.capabilityCalls).toEqual([]);

		expect(s.list().map((device) => device.name)).toEqual([
			"Xbox wheel (XInput slot 1)",
			"Xbox flight stick (XInput slot 3)",
		]);
		expect(fake.capabilityCalls).toEqual([
			{ slot: 0, length: XINPUT_CAPABILITIES_LENGTH },
			{ slot: 2, length: XINPUT_CAPABILITIES_LENGTH },
		]);
		expect(XINPUT_CAPABILITIES_LENGTH).toBe(20);
	});

	test("the production binding asks for any device type", async () => {
		// The flags word does not cross the injected module seam — `getCapabilities`
		// takes a slot and a buffer, so the fake cannot see it. The policy is still
		// worth pinning: `XINPUT_FLAG_GAMEPAD` would make exactly the wheel and the
		// flight stick above answer with an error, and both would lose their names.
		// A source-text check is the only place to stand, the same reason the
		// node-hid loader has one.
		const source = await Bun.file(new URL("../src/sources/xinput.ts", import.meta.url)).text();
		expect(source).toContain("XInputGetCapabilities(slot, 0, ptr(capabilities))");
	});
});

describe("open", () => {
	test("each poll becomes an 18-byte report: the state, then the battery", async () => {
		const fake = fakeXInput([0]);
		fake.setButtons(0x1000); // A
		fake.setBattery(2, 1);
		const { source: s, clock } = await source(fake);
		const device = s.list()[0];
		const handle = s.open(device);
		const reports: Uint8Array[] = [];
		handle.onReport((bytes) => reports.push(bytes));

		clock.fire();
		expect(reports).toHaveLength(1);
		const report = reports[0];
		expect(report).toHaveLength(XBOX_REPORT_LENGTH);
		expect(report[0]).toBe(0); // the packet counter our fake leaves at zero
		expect(report[4]).toBe(0x00);
		expect(report[5]).toBe(0x10);
		expect(report[16]).toBe(2);
		expect(report[17]).toBe(1);
	});

	test("the battery is re-read once a second, not on every frame", async () => {
		const fake = fakeXInput([0]);
		fake.setBattery(1, 3);
		const { source: s, clock } = await source(fake);
		const handle = s.open(s.list()[0]);
		const reports: Uint8Array[] = [];
		handle.onReport((bytes) => reports.push(bytes));

		clock.fire();
		expect([reports.at(-1)?.[16], reports.at(-1)?.[17]]).toEqual([1, 3]);
		fake.setBattery(2, 1);
		// About a second of polls at the default interval. The first fire above
		// already read the battery, so the next read comes a whole cadence later.
		const batteryPolls = Math.max(1, Math.round(1000 / XINPUT_POLL_MS));
		for (let at = 0; at < batteryPolls - 1; at += 1) clock.fire();
		expect([reports.at(-1)?.[16], reports.at(-1)?.[17]]).toEqual([1, 3]);
		clock.fire();
		expect([reports.at(-1)?.[16], reports.at(-1)?.[17]]).toEqual([2, 1]);
	});

	test("a write is four bytes of vibration, refused when it is another family's packet", async () => {
		const fake = fakeXInput([0]);
		const { source: s } = await source(fake);
		const handle = s.open(s.list()[0]);

		const packet = buildXboxOutput({ rumble: { large: 0x40, small: 0x80 } });
		expect(handle.write(packet)).toBe(true);
		expect(fake.writes).toEqual([Uint8Array.of(0x40, 0x40, 0x80, 0x80)]);

		expect(handle.write(Uint8Array.of(0, 0))).toBe(false);
		expect(fake.writes).toHaveLength(1);
	});

	test("a pad that goes away raises one error and stops polling", async () => {
		const fake = fakeXInput([0]);
		const { source: s, clock } = await source(fake);
		const handle = s.open(s.list()[0]);
		const errors: Error[] = [];
		const reports: Uint8Array[] = [];
		handle.onError((error) => errors.push(error));
		handle.onReport((bytes) => reports.push(bytes));

		clock.fire();
		expect(reports).toHaveLength(1);
		fake.connected.delete(0);
		clock.fire();
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain("no longer connected");
		// The interval was cleared, so a later fire can neither report nor error.
		clock.fire();
		expect(reports).toHaveLength(1);
		expect(errors).toHaveLength(1);
		expect(handle.write(buildXboxOutput())).toBe(false);
	});

	test("close stops the poller", async () => {
		const fake = fakeXInput([0]);
		const { source: s, clock } = await source(fake);
		const handle = s.open(s.list()[0]);
		const reports: Uint8Array[] = [];
		handle.onReport((bytes) => reports.push(bytes));
		clock.fire();
		handle.close();
		clock.fire();
		expect(reports).toHaveLength(1);
	});

	test("opening before warmUp, or a path from another source, says why", async () => {
		const fake = fakeXInput([0]);
		const clock = fakeTimers();
		const cold = createXInputSource({ load: async () => fake.module, timers: clock.timers });
		expect(() => cold.open({ path: xinputSlotPath(0), vendorId: 0, productId: 0, family: "xbox" })).toThrow(
			"has not been loaded yet",
		);

		const { source: s } = await source(fake, clock);
		expect(() => s.open({ path: "hid#somewhere", vendorId: 0, productId: 0, family: "xbox" })).toThrow(
			"not an XInput device",
		);
	});
});
