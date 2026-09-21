/**
 * A controller that answers to whoever is testing.
 *
 * Deliberately not a script on a timer. The service takes its clock as a
 * dependency precisely so that a test can hold an hour of pad in a microsecond;
 * a source that fired reports off its own `setTimeout` would put a second,
 * competing clock back into the same test and make it flaky for the usual
 * reason — the assertion races the timer. Here the test *is* the device: it
 * plugs, unplugs, pushes reports and reads back what was written, all
 * synchronously, and nothing happens until it says so.
 */

import { DS4_VENDOR_ID } from "../ds4.ts";
import type { PadSource, PadSourceDevice, PadSourceHandle } from "../source.ts";

/** The default: the DualShock 4 v2 this package was written against. */
export const FAUX_DS4: PadSourceDevice = {
	path: "faux://dualshock-4-v2",
	vendorId: DS4_VENDOR_ID,
	productId: 0x09cc,
	name: "Wireless Controller",
	interface: 3,
	carriesReports: true,
};

export interface FauxSource extends PadSource {
	/** Plug a controller in, as the pad appearing does. */
	attach(overrides?: Partial<PadSourceDevice>): PadSourceDevice;
	/**
	 * Pull a cable: the device disappears and its open handle reports it. The
	 * default is the last device attached; name one to pull a single link of a pad
	 * that is attached twice.
	 */
	detach(device?: PadSourceDevice): void;
	/**
	 * Feed one input report to one device's handle. The default is the handle
	 * opened most recently, which is what most tests want.
	 */
	push(bytes: Uint8Array, device?: PadSourceDevice): void;
	/** A read failure on a device that is still attached. */
	fail(error: Error, device?: PadSourceDevice): void;
	/** Everything written to every handle, oldest first. */
	writes(): readonly Uint8Array[];
	/** What was written since the last call, and forget the rest. */
	takeWrites(): Uint8Array[];
	/** Every device `open` was called with. */
	opened(): readonly PadSourceDevice[];
	/** Whether every opened handle has been closed. */
	closed(): boolean;
	/** Whether the handle opened for this device — if any — has been closed. */
	closedFor(device: PadSourceDevice): boolean;
}

/** One open device, as the fake remembers it: handlers and whether it is closed. */
interface FauxHandle {
	device: PadSourceDevice;
	report?: (bytes: Uint8Array) => void;
	error?: (error: Error) => void;
	closed: boolean;
}

export function createFauxSource(devices: PadSourceDevice[] = [FAUX_DS4]): FauxSource {
	const attached = [...devices];
	const written: Uint8Array[] = [];
	const opened: PadSourceDevice[] = [];
	// One handle per opened device, in the order they were opened: a pad that is
	// attached twice is two handles, and a test that wants to talk to one of them
	// names it. Nothing here keys on the path — the fake's devices are objects, and
	// two of them may well share a path the way two real collections do.
	const handles: FauxHandle[] = [];

	/** The handle a call addresses: a named device's, or the most recent one. */
	function handleFor(device?: PadSourceDevice): FauxHandle | undefined {
		return device === undefined ? handles.at(-1) : handles.find((handle) => handle.device === device);
	}

	return {
		async warmUp() {
			// Nothing to load: the devices are already here.
		},

		unavailable: () => undefined,

		list: () => attached,

		open(device) {
			if (!attached.includes(device)) throw new Error(`${device.path} is not attached`);
			const handle: FauxHandle = { device, closed: false };
			handles.push(handle);
			opened.push(device);
			return {
				onReport(handler) {
					handle.report = handler;
				},
				onError(handler) {
					handle.error = handler;
				},
				write(bytes) {
					if (handle.closed) return false;
					written.push(Uint8Array.from(bytes));
					return true;
				},
				close() {
					handle.closed = true;
				},
			} satisfies PadSourceHandle;
		},

		attach(overrides = {}) {
			const device: PadSourceDevice = { ...FAUX_DS4, ...overrides };
			attached.push(device);
			return device;
		},

		detach(device) {
			const target = device ?? attached.at(-1);
			if (target === undefined) return;
			attached.splice(attached.indexOf(target), 1);
			// A cable pulled out is an error on the handle as well as a device that is
			// no longer listed: whichever one the service watches, it hears.
			const handle = handleFor(target);
			handle?.error?.(new Error(`${target.path ?? "device"} disconnected`));
			if (handle !== undefined) handle.closed = true;
		},

		push(bytes, device) {
			const handle = handleFor(device);
			// A closed handle delivers nothing: that is what closing it means.
			if (handle?.closed === false) handle.report?.(Uint8Array.from(bytes));
		},

		fail(error, device) {
			// Delivered even on a closed handle — a real read error can arrive after
			// the close — so that a test can watch what the service does with it.
			handleFor(device)?.error?.(error);
		},

		writes: () => written,

		takeWrites() {
			return written.splice(0, written.length);
		},

		opened: () => opened,

		closed: () => handles.every((handle) => handle.closed),

		closedFor: (device) => handles.find((handle) => handle.device === device)?.closed ?? true,
	};
}
