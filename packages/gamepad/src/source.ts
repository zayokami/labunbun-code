/**
 * Where reports come from.
 *
 * Everything above this file — the mapper, the feedback rules, the service —
 * works on bytes in and bytes out, so the one part of the package that has to
 * touch an operating system is kept behind these three interfaces and nothing
 * else. That is what makes the rest testable on a machine with no controller
 * plugged in, and what would let a different OS layer (a worker thread reading
 * synchronously, a `bun:ffi` binding) be dropped in without touching a line
 * above it.
 *
 * A source never throws for "not there": `list()` answers "nothing" and `open()`
 * throws something a person can act on, because the three failures users
 * actually hit — nothing plugged in, something else holding the device, and the
 * optional dependency not installed — arrive here first and have to be told
 * apart at the top.
 */

import { DS4_PRODUCT_IDS, DS4_VENDOR_ID, type Ds4Transport, describeModel } from "./ds4.ts";

/** A controller the source knows about. */
export interface PadSourceDevice {
	/**
	 * The OS's handle: a HID path on Windows, `/dev/hidrawN` on Linux. Absent
	 * when another program is holding the device open — the OS still lists it,
	 * and it still cannot be opened, which is a different problem from a pad that
	 * is not plugged in and deserves a different answer.
	 */
	path?: string;
	vendorId: number;
	productId: number;
	/** What the OS calls it, when it says. */
	name?: string;
	/**
	 * Which of the device's interfaces this is. A DualShock 4 presents several —
	 * audio, HID control, and the one the input reports arrive on — so a list of
	 * four "controllers" is really one controller on four interfaces.
	 */
	interface?: number;
	/**
	 * Set when the OS itself says this interface is the one carrying input
	 * reports. Several interfaces of one pad are openable; only one of them is
	 * useful, and this is how the choice is made without hardcoding an OS rule
	 * above the source.
	 */
	carriesReports?: boolean;
}

/** An open device. Reports arrive on their own; writes are best-effort. */
export interface PadSourceHandle {
	onReport(handler: (bytes: Uint8Array) => void): void;
	/**
	 * The device went away or the read failed. A pulled cable raises this; a
	 * Bluetooth pad that has gone out of range may only go quiet, which is why
	 * the service also watches for silence.
	 */
	onError(handler: (error: Error) => void): void;
	/** `false` when the device refused it — a pulled cable, a busy endpoint. */
	write(bytes: Uint8Array): boolean;
	close(): void;
}

export interface PadSource {
	/**
	 * Get ready to answer `list()`. A source whose module has to be imported
	 * (the real one does) cannot answer before this resolves, and `list()` is
	 * synchronous because the menus that call it are rendering. Awaiting it twice
	 * is free; not awaiting it is an empty list.
	 */
	warmUp(): Promise<void>;
	/**
	 * Why this source cannot work here at all, or `undefined` to try it. Separate
	 * from an empty `list()` because the fixes are different and so are the
	 * words: "nothing is plugged in" sends someone to the cable, "the optional
	 * dependency is not installed" sends them to a command. Known only after
	 * `warmUp()`; `undefined` before that means "not looked yet".
	 */
	unavailable(): string | undefined;
	/** Every interface of every controller attached right now, or none. */
	list(): readonly PadSourceDevice[];
	/** Open one, or throw with a message worth showing. */
	open(device: PadSourceDevice): PadSourceHandle;
}

/** Whether the vendor and product id are ones this package knows how to read. */
export function isDs4Device(device: PadSourceDevice): boolean {
	return device.vendorId === DS4_VENDOR_ID && DS4_PRODUCT_IDS.includes(device.productId);
}

/** For lists and error messages: the model name, with the interface when known. */
export function describePadDevice(device: PadSourceDevice): string {
	const model = describeModel(device.vendorId, device.productId) ?? device.name ?? "unknown controller";
	if (device.path === undefined) return `${model} (held by another program)`;
	return device.interface === undefined ? model : `${model} (interface ${device.interface})`;
}

/**
 * The Bluetooth HID service UUID, which is how Windows writes "this device
 * arrived over Bluetooth" into a HID path.
 */
const BLUETOOTH_HID_SERVICE = "00001124-0000-1000-8000-00805f9b34fb";

/**
 * What the *device* says the link is, before any report has said anything.
 *
 * A DualShock 4 switched on over Bluetooth spends its first second sending its
 * USB-shaped report — the mode it powers on in, which nothing here can read and
 * which only ends when a host writes to it. So the first report cannot say how
 * it arrived, and the greeting that would end that state needs the transport to
 * be built at all: a service that waits for a readable report to learn the
 * transport never writes, and a pad that is never written to never becomes
 * readable. The device's own description is the way out — Windows gives a
 * Bluetooth HID device the Bluetooth HID service UUID in its path, and a USB one
 * a VID/PID hardware id, and neither is a guess about the pad's contents.
 *
 * A report overrides this the moment one parses: the bytes are the authority,
 * and this is only what to do while they are still saying nothing.
 */
export function deviceTransport(device: PadSourceDevice): Ds4Transport {
	return (device.path ?? "").toLowerCase().includes(BLUETOOTH_HID_SERVICE) ? "bluetooth" : "usb";
}

/**
 * The `device` setting: a case-insensitive substring of the name or the path, so
 * a user can write "wireless" or "hid#vid_054c" and not a full Windows path. An
 * empty or blank setting matches everything, which is what "unset" should mean.
 */
export function matchesDevice(device: PadSourceDevice, wanted: string): boolean {
	const needle = wanted.trim().toLowerCase();
	if (needle === "") return true;
	const name = (device.name ?? describeModel(device.vendorId, device.productId) ?? "").toLowerCase();
	return name.includes(needle) || (device.path ?? "").toLowerCase().includes(needle);
}

/**
 * Every link the controller has, best first.
 *
 * Only models this package can read are considered, and a named device that is
 * not attached is *not* silently replaced by another pad: whoever asked for a
 * particular controller should hear that it is missing, not find their input
 * coming from a different one.
 *
 * Among the interfaces that survive, the ones the OS says carry reports are
 * preferred — open the audio interface of a controller and it delivers silence
 * forever, which reads exactly like a broken pad. A device with no path is one
 * another program is holding, so it is never the answer.
 *
 * *Every* surviving interface, not just one, because a DualShock 4 can be
 * attached twice at once: a cable in and the radio on, which is what happens to
 * a controller that was left switched on and then plugged in. The OS lists the
 * two as unrelated HID collections and there is nothing on either that says
 * they are one pad — measured on Windows, the wired collection's serial number
 * is empty and the wireless one's is the pad's own Bluetooth address. Both
 * deliver reports, both accept writes, and *which* one the pad obeys for the
 * lightbar and the motors cannot be read off the device: measured, it is the
 * radio in that state, but that is a fact about this firmware and not a rule to
 * encode. So all of them are opened and all of them are written to, which is
 * also the only version of this that survives a cable being pulled mid-sentence.
 *
 * One link per transport, because two collections of one model on one transport
 * are two controllers and not one; and the wire ranks first, because it is the
 * link someone means by "I plugged it in" and the one whose reports arrive on
 * the shorter path. A source that cannot say which interface carries reports —
 * Linux, where every hidraw node looks alike — yields a single link, as it
 * always did.
 *
 * Two controllers attached at once, one wired and one on the radio, are read as
 * one pad's two links: nothing on either device says which pad it belongs to, so
 * that is the closest thing to a rule there is. Being wrong about it costs a
 * second controller whose bar mirrors the app, and one that can drive the app if
 * the first one goes quiet — not nothing, but less than the cost of picking one
 * link and being wrong about which of them the pad obeys.
 */
export function pickLinks(devices: readonly PadSourceDevice[], wanted?: string): PadSourceDevice[] {
	const pads = devices
		.filter(isDs4Device)
		.filter((device) => device.path !== undefined)
		.filter((device) => wanted === undefined || matchesDevice(device, wanted));
	const reported = pads.filter((device) => device.carriesReports === true);
	const candidates = reported.length > 0 ? reported : pads.slice(0, 1);
	const byTransport = new Map<Ds4Transport, PadSourceDevice>();
	for (const device of candidates) {
		const transport = deviceTransport(device);
		if (!byTransport.has(transport)) byTransport.set(transport, device);
	}
	return [...byTransport.values()].sort((a, b) => transportRank(a) - transportRank(b));
}

/** The one controller `pickLinks` leads with: the device to name and describe. */
export function pickDevice(devices: readonly PadSourceDevice[], wanted?: string): PadSourceDevice | undefined {
	return pickLinks(devices, wanted)[0];
}

/** The wire before the radio, by the same reading of the path as `deviceTransport`. */
function transportRank(device: PadSourceDevice): number {
	return deviceTransport(device) === "usb" ? 0 : 1;
}
