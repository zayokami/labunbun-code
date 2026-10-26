/**
 * Every controller family the machine can read, behind one source.
 *
 * The service is written against a single source: it asks for a list, picks
 * links, and opens them. That shape is right, and adding a family should not
 * change it — so the two real sources (node-hid for DualShock 4s, XInput for
 * Xbox pads) are joined here, and the service never learns there is more than
 * one way a controller can arrive.
 *
 * The awkward part is `unavailable`, whose answer is about the machine rather
 * than about a pad: "node-hid is not installed" is not a reason to give up when
 * XInput is sitting right there. So the combined source is unavailable only
 * when every child is, and it says all of their reasons — a user who has an
 * Xbox pad and no node-hid should see the pad work, and a user with neither
 * should see both fixes.
 *
 * Opening routes by the path the device was listed with. Paths are the one
 * identity a source promises is stable, and the list a service opens from came
 * from this object, so a device with the same path is the same device.
 */

import { describePadDevice, type PadSource, type PadSourceDevice } from "../source.ts";

/** What a child said when its `warmUp` threw, which is not the same as "not there". */
export function createCombinedSource(sources: readonly PadSource[]): PadSource {
	const failures = new Map<PadSource, string>();

	/** A child's reason for being unusable: its own answer, or why warm-up threw. */
	function unavailableFrom(source: PadSource): string | undefined {
		return failures.get(source) ?? source.unavailable();
	}

	return {
		async warmUp() {
			// One child failing to load must not take the other down with it: the
			// whole point of this source is that the families fail independently.
			await Promise.all(
				sources.map(async (source) => {
					try {
						await source.warmUp();
					} catch (error) {
						failures.set(source, error instanceof Error ? error.message : String(error));
					}
				}),
			);
		},

		unavailable() {
			if (sources.length === 0) return "no controller source is available";
			const reasons = sources.map(unavailableFrom);
			// One usable child is enough for this source to be worth trying.
			if (reasons.some((reason) => reason === undefined)) return undefined;
			return reasons.filter((reason): reason is string => reason !== undefined).join("; ");
		},

		list() {
			const devices: PadSourceDevice[] = [];
			for (const source of sources) {
				if (unavailableFrom(source) !== undefined) continue;
				devices.push(...source.list());
			}
			return devices;
		},

		open(device) {
			for (const source of sources) {
				if (unavailableFrom(source) !== undefined) continue;
				const owned = source
					.list()
					.some((candidate) => candidate === device || (device.path !== undefined && candidate.path === device.path));
				if (owned) return source.open(device);
			}
			throw new Error(`${describePadDevice(device)} is no longer attached`);
		},
	} satisfies PadSource;
}
