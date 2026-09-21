/**
 * The real device, through node-hid.
 *
 * Two things here are deliberate and worth not "cleaning up":
 *
 * The module is loaded through `load`, injected. That is what lets the
 * "node-hid is not installed" path — which is a supported way to run this
 * package, not an error — be tested without the module, and it keeps the import
 * itself to one line at the bottom of this file.
 *
 * The specifier is a literal that the *type checker* cannot see. `node-hid` is an
 * optional dependency, so a bare literal is a "cannot find module" error on every
 * checkout that has not installed it — but a name held in a variable is one
 * `bun build --compile` cannot follow, and the compiled executable then carries
 * no node-hid and reports the feature as not installed with the module sitting in
 * the workspace. The cast in the loader satisfies both; `--external` is needed
 * for neither.
 */

import { describeModel } from "../ds4.ts";
import { isDs4Device, type PadSource, type PadSourceDevice, type PadSourceHandle } from "../source.ts";

/** What node-hid says about one attached device. */
export interface NodeHidDeviceInfo {
	vendorId: number;
	productId: number;
	/** Absent when another process holds the device open. */
	path?: string;
	product?: string;
	interface?: number;
	usagePage?: number;
	usage?: number;
}

export interface NodeHidHandle {
	on(event: "data", listener: (data: Uint8Array) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	/** Returns the number of bytes written. */
	write(data: readonly number[]): number;
	close(): void;
}

export interface NodeHidModule {
	devices(): readonly NodeHidDeviceInfo[];
	HID: new (path: string) => NodeHidHandle;
}

/** Injected so a test can be a machine without the optional dependency. */
export type NodeHidLoader = () => Promise<NodeHidModule | null>;

export interface NodeHidSourceOptions {
	load: NodeHidLoader;
}

/**
 * The interface the input reports arrive on.
 *
 * A DualShock 4 exposes four interfaces over USB and only one of them carries
 * the reports: measured on this machine's v2, the working one is
 * `interface 3, usagePage 1, usage 5`. The others are the pad's audio and a
 * second HID collection; opening one of those delivers silence forever, which
 * on screen is indistinguishable from a broken controller. Linux hidraw does
 * not report usage, so there the field is simply absent and the first interface
 * is used.
 */
const DS4_INPUT_USAGE = { page: 0x01, usage: 0x05 };

/** Shown when the optional dependency is missing. Not an error: a supported way to run. */
export const NODE_HID_MISSING =
	"node-hid is not installed — run `pnpm add --optional node-hid -F @labunbun/gamepad` to read a controller";

/**
 * The device as this package wants to see it. A device the OS lists without a
 * path is one another process holds open — Steam and DS4Windows both do this —
 * and it is kept rather than dropped, because "a controller is attached but
 * something else has it" is the answer that saves the user a cable hunt.
 */
function toSourceDevice(info: NodeHidDeviceInfo): PadSourceDevice {
	const device: PadSourceDevice = {
		vendorId: info.vendorId,
		productId: info.productId,
		carriesReports: info.usagePage === DS4_INPUT_USAGE.page && info.usage === DS4_INPUT_USAGE.usage,
	};
	if (info.path !== undefined) device.path = info.path;
	const name = info.product ?? describeModel(info.vendorId, info.productId);
	if (name !== undefined) device.name = name;
	if (info.interface !== undefined) device.interface = info.interface;
	return device;
}

/**
 * node-hid is CommonJS, and what a dynamic import hands back for it differs by
 * runtime: sometimes the exports themselves, sometimes a `default` wrapping
 * them. Getting this wrong is not a crash — it is a module with no `devices`
 * function, which reads as "no controller attached" and sends the user to the
 * cable. So the shape is decided here, where it can be tested.
 */
export function nodeHidModuleFrom(loaded: unknown): NodeHidModule | null {
	if (loaded === null || typeof loaded !== "object") return null;
	const module = loaded as Partial<NodeHidModule> & { default?: Partial<NodeHidModule> };
	if (typeof module.HID === "function" && typeof module.devices === "function") return module as NodeHidModule;
	const inner = module.default;
	if (inner && typeof inner.HID === "function" && typeof inner.devices === "function") return inner as NodeHidModule;
	return null;
}

export function createNodeHidSource(options: NodeHidSourceOptions): PadSource {
	const load = options.load;

	/** The loaded module, `null` once we know it is not there, `undefined` until asked. */
	let module: NodeHidModule | null | undefined;

	return {
		async warmUp() {
			if (module === undefined) module = await load();
		},

		unavailable() {
			// Unknown until asked: `undefined` here means "not looked yet", and
			// `list()` is empty either way.
			return module === null ? NODE_HID_MISSING : undefined;
		},

		list() {
			if (!module) return [];
			return module.devices().map(toSourceDevice).filter(isDs4Device);
		},

		open(device) {
			// Distinguishing these two matters: "install it" and "we have not looked
			// yet" have different fixes and only one of them is the user's problem.
			if (module === undefined) throw new Error("the controller module has not been loaded yet — call warmUp()");
			if (module === null) throw new Error(NODE_HID_MISSING);
			if (device.path === undefined) {
				throw new Error(
					`${describeModel(device.vendorId, device.productId) ?? "the device"} is held by another program`,
				);
			}

			const handle = new module.HID(device.path);
			return {
				onReport(handler) {
					handle.on("data", (data) => handler(Uint8Array.from(data)));
				},
				onError(handler) {
					handle.on("error", handler);
				},
				write(bytes) {
					try {
						// The report id is byte 0 of what we build, which is the first
						// element node-hid expects.
						return handle.write([...bytes]) > 0;
					} catch {
						return false;
					}
				},
				close() {
					try {
						handle.close();
					} catch {
						// Already gone. Closing twice is not worth reporting.
					}
				},
			} satisfies PadSourceHandle;
		},
	};
}

/**
 * The production loader. Failure is a value, not an exception: this package is
 * expected to be usable without its optional dependency.
 */
export async function importNodeHid(): Promise<NodeHidModule | null> {
	try {
		// The cast buys two opposite things at once, and both are needed.
		//
		// `bun build --compile` follows a specifier it can *read*: written as a
		// variable — which is how this line started — the compiled executable
		// carried no node-hid at all and told the user the feature was not
		// installed, with the module sitting right there in the workspace. A
		// bundler cannot follow a name it does not know.
		//
		// The type checker wants the opposite: a bare literal is a "cannot find
		// module" error on every checkout that skipped the optional dependency,
		// which is a supported way to run this package. `string` is opaque to it,
		// so the literal stays out of its reach while remaining literal in the
		// file — erased at compile time, a string at run time.
		return nodeHidModuleFrom(await import("node-hid" as string));
	} catch {
		return null;
	}
}
