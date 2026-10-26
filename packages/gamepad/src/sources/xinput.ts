/**
 * Xbox controllers on Windows, through XInput.
 *
 * This is not a second way to read the same HID device — it is the only way.
 * An Xbox One pad enumerates as a HID collection (`XINPUT 兼容的 HID 设备` on
 * this machine) and node-hid opens it happily, but XInput's driver owns it and
 * the collection delivers no input reports; measured twice, with a blocking
 * read and with an event listener. XInput answers with the full state, so the
 * source polls it and turns each poll into the 18-byte report `xbox.ts` reads.
 *
 * Everything here is injected the same way node-hid's loader is: the dynamic
 * library and the timer are options, so a test can be a machine with no pad, a
 * pad with a scripted state, and a clock it advances by hand.
 *
 * A slot, not a path. XInput identifies pads 0-3 and exposes no vendor id or
 * product id, so the device this source lists carries zeros for both and says
 * `family: "xbox"` — that claim, not the ids, is what tells `pickLinks` this is
 * a pad it can read. Third-party controllers behind XInput work identically.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import type { PadSource, PadSourceDevice, PadSourceHandle } from "../source.ts";
import { XBOX_REPORT_LENGTH, XINPUT_VIBRATION_LENGTH } from "../xbox.ts";

/** The bytes `XInputGetState` writes: `XINPUT_STATE`, a DWORD and five fields. */
export const XINPUT_STATE_LENGTH = 16;

/** `XINPUT_BATTERY_INFORMATION`: a type byte and a level byte. */
const XINPUT_BATTERY_LENGTH = 2;

/** `ERROR_SUCCESS`. Every XInput call returns one of these codes. */
const XINPUT_CONNECTED = 0;

/** The four slots XInput addresses, numbered 0-3. */
const XINPUT_SLOTS = 4;

/**
 * How often the pad is asked for its state. 16 ms is one report per frame at
 * 60 Hz: input latency below what a person can see, and the service's silence
 * watchdog sees a live pad rather than a quiet one.
 */
export const XINPUT_POLL_MS = 16;

/** What the dynamic library has to provide. Buffers are written in place. */
export interface XInputModule {
	getState(slot: number, state: Uint8Array): number;
	getBattery(slot: number, battery: Uint8Array): number;
	setState(slot: number, vibration: Uint8Array): number;
}

/** Injected so a test needs neither Windows nor a controller. */
export type XInputLoader = () => Promise<XInputModule | null>;

export interface XInputTimer {
	unref?(): void;
}

/** The timer surface the poller needs; injected for deterministic tests. */
export interface XInputTimers {
	setInterval(handler: () => void, ms: number): XInputTimer;
	clearInterval(handle: XInputTimer): void;
}

export interface XInputSourceOptions {
	load: XInputLoader;
	timers?: XInputTimers;
	pollMs?: number;
}

/** Shown when XInput cannot be opened even though this is Windows. */
export const XINPUT_MISSING =
	"XInput could not be loaded — install the Xbox controller driver (xinput1_4.dll) or update Windows";

/** Shown everywhere else. The wire here is Windows-only for this family. */
export const XINPUT_NOT_WINDOWS =
	"Xbox controllers need XInput, which is Windows-only; on this platform the controller is not supported yet";

const systemTimers: XInputTimers = {
	setInterval(handler, ms) {
		const timer = setInterval(handler, ms);
		timer.unref?.();
		return timer;
	},
	clearInterval(handle) {
		clearInterval(handle as ReturnType<typeof setInterval>);
	},
};

/** A slot's synthetic handle, so the service can name and filter it like a path. */
export function xinputSlotPath(slot: number): string {
	return `xinput://${slot}`;
}

function slotFromPath(path: string | undefined): number | undefined {
	if (path === undefined) return undefined;
	const match = /^xinput:\/\/(\d)$/.exec(path);
	if (match === null) return undefined;
	const slot = Number(match[1]);
	return slot < XINPUT_SLOTS ? slot : undefined;
}

export function createXInputSource(options: XInputSourceOptions): PadSource {
	const load = options.load;
	const timers = options.timers ?? systemTimers;
	const pollMs = options.pollMs ?? XINPUT_POLL_MS;
	// Its level changes on the scale of minutes; the state changes on the scale
	// of milliseconds. Reading the battery every poll would be sixty needless
	// calls a second for an answer that is almost always the same byte. Derived
	// from the actual poll interval so a slower poller does not read it faster.
	const batteryPolls = Math.max(1, Math.round(1000 / pollMs));

	/** The loaded library, `null` once we know it is not there, `undefined` until asked. */
	let module: XInputModule | null | undefined;

	function probe(slot: number): boolean {
		// A fresh scratch buffer rather than a shared one: `list()` may be called
		// while a handle is polling, and the two must not overwrite each other.
		if (module === null || module === undefined) return false;
		return module.getState(slot, new Uint8Array(XINPUT_STATE_LENGTH)) === XINPUT_CONNECTED;
	}

	return {
		async warmUp() {
			if (module === undefined) module = await load();
		},

		unavailable() {
			if (process.platform !== "win32") return XINPUT_NOT_WINDOWS;
			return module === null ? XINPUT_MISSING : undefined;
		},

		list() {
			if (!module) return [];
			const devices: PadSourceDevice[] = [];
			for (let slot = 0; slot < XINPUT_SLOTS; slot += 1) {
				if (!probe(slot)) continue;
				devices.push({
					path: xinputSlotPath(slot),
					// XInput exposes neither id. `family` is the claim that matters: it
					// says this package can read the device without a vendor table entry.
					vendorId: 0,
					productId: 0,
					name: `Xbox controller (XInput slot ${slot + 1})`,
					family: "xbox",
					carriesReports: true,
				});
			}
			return devices;
		},

		open(device) {
			if (module === undefined) throw new Error("the controller module has not been loaded yet — call warmUp()");
			if (module === null) throw new Error(process.platform === "win32" ? XINPUT_MISSING : XINPUT_NOT_WINDOWS);
			const slot = slotFromPath(device.path);
			if (slot === undefined) throw new Error(`not an XInput device: ${device.path ?? "no path"}`);

			const lib = module;
			const state = new Uint8Array(XINPUT_STATE_LENGTH);
			const battery = new Uint8Array(XINPUT_BATTERY_LENGTH);
			const packet = new Uint8Array(XBOX_REPORT_LENGTH);
			let batteryType = 0;
			let batteryLevel = 0;
			let polls = 0;
			let closed = false;
			let timer: XInputTimer | undefined;
			let report: ((bytes: Uint8Array) => void) | undefined;
			let failure: ((error: Error) => void) | undefined;

			const stop = (): void => {
				closed = true;
				if (timer !== undefined) timers.clearInterval(timer);
				timer = undefined;
			};

			const poll = (): void => {
				if (closed) return;
				if (lib.getState(slot, state) !== XINPUT_CONNECTED) {
					// The one error XInput raises here is "the pad is gone"; a pulled
					// cable and an exhausted battery look the same, and both mean the
					// service should drop this link and look again.
					stop();
					failure?.(new Error("the controller is no longer connected"));
					return;
				}
				if (polls % batteryPolls === 0 && lib.getBattery(slot, battery) === XINPUT_CONNECTED) {
					batteryType = battery[0];
					batteryLevel = battery[1];
				}
				polls += 1;
				// The report the decoder reads: XInput's own state, then the battery
				// bytes this source adds because `XINPUT_STATE` does not carry them.
				packet.set(state);
				packet[XINPUT_STATE_LENGTH] = batteryType;
				packet[XINPUT_STATE_LENGTH + 1] = batteryLevel;
				// A copy per report: a handler is allowed to keep the bytes, and the
				// next poll overwrites the scratch packet.
				report?.(Uint8Array.from(packet));
			};

			// Started here rather than on the first `onReport`: the service registers
			// its handlers synchronously right after `open` returns, and a poll that
			// fired in between would be a report nobody heard. The interval cannot
			// fire before this function returns.
			timer = timers.setInterval(poll, pollMs);

			return {
				onReport(handler) {
					report = handler;
				},
				onError(handler) {
					failure = handler;
				},
				write(bytes) {
					// `XINPUT_VIBRATION` is exactly four bytes; anything shorter is a
					// packet built for another family and is refused rather than padded.
					if (closed || bytes.length < XINPUT_VIBRATION_LENGTH) return false;
					return lib.setState(slot, bytes.subarray(0, XINPUT_VIBRATION_LENGTH)) === XINPUT_CONNECTED;
				},
				close() {
					stop();
				},
			} satisfies PadSourceHandle;
		},
	};
}

/**
 * The production loader. `xinput1_4.dll` ships with Windows 8 and later;
 * `xinput1_3.dll` is the Windows 7 name and exports the same three functions.
 * Failure is a value, like node-hid's: an unsupported machine is a supported
 * way to run the rest of the package.
 */
export async function importXInput(): Promise<XInputModule | null> {
	if (process.platform !== "win32") return null;
	for (const dll of ["xinput1_4.dll", "xinput1_3.dll"]) {
		try {
			const lib = dlopen(dll, {
				XInputGetState: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
				XInputSetState: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
				XInputGetBatteryInformation: { args: [FFIType.u32, FFIType.u8, FFIType.ptr], returns: FFIType.u32 },
			});
			return {
				getState(slot, state) {
					return lib.symbols.XInputGetState(slot, ptr(state));
				},
				getBattery(slot, battery) {
					return lib.symbols.XInputGetBatteryInformation(slot, 0, ptr(battery));
				},
				setState(slot, vibration) {
					return lib.symbols.XInputSetState(slot, ptr(vibration));
				},
			};
		} catch {
			// This DLL is not here or is not the one with the battery call; the next
			// name is the only other place Windows keeps these functions.
		}
	}
	return null;
}
