/**
 * The bridge: the two ends of one controller.
 *
 * Almost everything it does is delegation, and delegation is exactly what a test
 * has to check rather than assume — the interesting failures are a status that
 * stops changing (the UI then never re-renders), an action that reaches one
 * subscriber and not another, and an unsubscribe that leaves the handler on the
 * list. The two settings it holds are checked here too, because "off unless the
 * user says so" is a promise about a default.
 */

import { describe, expect, test } from "bun:test";
import {
	createFauxSource,
	createPadBridge,
	DEFAULT_BINDINGS,
	type FauxSource,
	PAD_RUMBLE,
	type PadAction,
	type PadServiceStatus,
	padPalette,
} from "../src/index.ts";
import { createFauxClock } from "./clock.ts";
import { CROSS, usbBytes } from "./reports.ts";

const PALETTE = padPalette({ accent: "cyan", alert: "magenta" });
const MAGENTA = { r: 136, g: 23, b: 152 };
/** The accent at idle: cyan at the quarter brightness `padLightbarFor` gives it. */
const DIM_CYAN = { r: 15, g: 38, b: 55 };

/** The motors and bar of a written packet, whichever transport built it. */
function output(packet: Uint8Array | undefined) {
	if (packet === undefined) return undefined;
	const at = packet[0] === 0x05 ? { small: 4, large: 5, rgb: 6 } : { small: 6, large: 7, rgb: 8 };
	return {
		small: packet[at.small],
		large: packet[at.large],
		rgb: { r: packet[at.rgb], g: packet[at.rgb + 1], b: packet[at.rgb + 2] },
	};
}

function harness(options: Partial<Parameters<typeof createPadBridge>[0]> = {}) {
	const source: FauxSource = createFauxSource();
	const clock = createFauxClock();
	return {
		...createPadBridge({ bindings: DEFAULT_BINDINGS, palette: PALETTE, ...options, source, clock }),
		source,
		clock,
	};
}

describe("the bridge", () => {
	test("hands every action to every subscriber, in order", async () => {
		const h = harness();
		const seen: PadAction[] = [];
		const other: PadAction[] = [];
		h.bridge.onAction((action) => seen.push(action));
		h.bridge.onAction((action) => other.push(action));
		await h.service.enable();
		h.source.push(usbBytes(CROSS));
		h.source.push(usbBytes());

		expect(seen.map((action) => `${action.kind}/${action.phase}`)).toEqual(["confirm/press", "confirm/release"]);
		expect(other.map((action) => action.kind)).toEqual(["confirm", "confirm"]);
	});

	test("an unsubscribe stops the actions and leaves the others alone", async () => {
		const h = harness();
		const kept: PadAction[] = [];
		const dropped: PadAction[] = [];
		const unsubscribe = h.bridge.onAction((action) => dropped.push(action));
		h.bridge.onAction((action) => kept.push(action));
		await h.service.enable();
		h.source.push(usbBytes(CROSS));
		expect(dropped).toHaveLength(1);
		expect(kept).toHaveLength(1);

		unsubscribe();
		h.source.push(usbBytes());
		expect(dropped).toHaveLength(1);
		expect(kept).toHaveLength(2);
	});

	test("the status is one object until something about it changes", async () => {
		// The identity is the whole contract with `useSyncExternalStore`: a new
		// object per call is an infinite render loop, and a reused one after a
		// change is a screen that never says the pad went away.
		const h = harness();
		const statuses: PadServiceStatus[] = [];
		let notifications = 0;
		h.bridge.subscribe(() => {
			notifications += 1;
			statuses.push(h.bridge.status());
		});
		const before = h.bridge.status();
		expect(h.bridge.status()).toBe(before);

		await h.service.enable();
		expect(notifications).toBe(1);
		expect(h.bridge.status()).not.toBe(before);
		expect(h.bridge.status()).toBe(statuses[notifications - 1]);
		expect(h.bridge.status().phase).toBe("connected");

		// The first report is news (the battery arrives), the second is not: what
		// keeps a thumb resting on a stick from rerendering is that the status the
		// report carries is compared field by field.
		h.source.push(usbBytes());
		expect(notifications).toBe(2);
		const settled = h.bridge.status();
		expect(settled.battery).toEqual({ level: 10, cable: false });
		h.source.push(usbBytes(CROSS));
		expect(notifications).toBe(2);
		expect(h.bridge.status()).toBe(settled);
	});

	test("a question is on the bar before the next frame", async () => {
		// The alert is a summons, not news. The same exemption that lets its buzz
		// through the rumble gap puts the colour on the bar in the same breath, so
		// the pad is already glowing when the dialog appears — and no tick has to
		// happen for that to be true.
		const h = harness();
		await h.service.enable();
		h.source.push(usbBytes());
		h.source.takeWrites();
		h.bridge.setFeedback({ phase: "idle", awaiting: true });
		const written = output(h.source.writes().at(-1));
		expect(written?.rgb).toEqual(MAGENTA);
	});

	test("a quiet change waits for the frame", async () => {
		// Answering the question is not a summons, so it takes the ordinary road:
		// held back by the 30 Hz throttle, and landed by the tick that follows. Two
		// writes for one question, and neither of them is wasted.
		const h = harness();
		await h.service.enable();
		h.source.push(usbBytes());
		h.bridge.setFeedback({ phase: "idle", awaiting: true });
		h.source.takeWrites();
		h.bridge.setFeedback({ phase: "idle", awaiting: false });
		expect(h.source.writes()).toHaveLength(0);
		h.clock.advance(40);
		const written = output(h.source.writes().at(-1));
		expect(written?.rgb).toEqual(DIM_CYAN);
		expect(h.source.writes()).toHaveLength(1);
	});

	test("a buzz is a person asking, so it is not held back by the gap", async () => {
		const h = harness();
		await h.service.enable();
		h.source.push(usbBytes());
		// The connect buzz is a moment old; the rule that keeps news from
		// stuttering must not swallow a buzz somebody asked for.
		h.clock.advance(10);
		h.source.takeWrites();
		h.bridge.buzz("alert");
		const written = output(h.source.writes().at(-1));
		expect(written?.small).toBe(PAD_RUMBLE.alert.rumble.small);
		expect(written?.large).toBe(PAD_RUMBLE.alert.rumble.large);
	});

	test("approving is off unless the user turns it on", () => {
		// The default is the one that matters: a controller on a couch is not a
		// person deciding, and a feature that has to be switched off is a feature
		// that approved something before anyone looked.
		expect(harness().bridge.allowApprove).toBe(false);
		expect(harness({ allowApprove: true }).bridge.allowApprove).toBe(true);
	});

	test("the wheel's phrases are the user's, minus the ones that say nothing", () => {
		expect(harness().bridge.phrases).toEqual([]);
		expect(harness({ phrases: ["  run the tests  ", "", "   ", "explain this"] }).bridge.phrases).toEqual([
			"run the tests",
			"explain this",
		]);
	});
});
