/**
 * The controller's battery in the status line.
 *
 * A pad the user is holding is a pad that will eventually stop working, and the
 * status line is the only place that can say so before it does. Two facts matter:
 * the bar is only there when something is actually reporting a level — a stale
 * bar outliving the controller would be worse than none — and the shape of the
 * bar is honest about the number it was given.
 *
 * The colour (a low battery is the one case that gets `theme.warning`) is not
 * asserted here. Ink draws no colour when stdout is not a TTY, which is every
 * test run, and the decision itself is `padBatteryLow` — a pure function with its
 * own falsified tests in the gamepad package. What is left for this file is the
 * bar's arithmetic, and where it does and does not appear.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type React from "react";
import { BATTERY_CABLE, BATTERY_EMPTY, BATTERY_FULL, batteryBar, StatusLine } from "../src/components/StatusLine.tsx";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";

describe("batteryBar", () => {
	test("fills the cells a level is worth, and never one it is not", () => {
		// A DualShock reports 0-10, in tens of percent. Four of ten is two cells;
		// zero fills none, because a bar with a cell in it says there is charge
		// left. Nine of ten rounds up to a full bar, which is the rounding saying
		// what five cells can say: a pad at ninety percent is a pad about to be
		// full, and half a cell of ink would be a worse answer than none.
		expect(batteryBar({ level: 10, cable: false })).toBe("▮▮▮▮▮");
		expect(batteryBar({ level: 9, cable: false })).toBe("▮▮▮▮▮");
		expect(batteryBar({ level: 4, cable: false })).toBe("▮▮▯▯▯");
		expect(batteryBar({ level: 1, cable: false })).toBe("▮▯▯▯▯");
		expect(batteryBar({ level: 0, cable: false })).toBe("▯▯▯▯▯");
	});

	test("a pad on its cable wears the mark, and a level out of range is folded in", () => {
		expect(batteryBar({ level: 10, cable: true })).toBe(`${BATTERY_CABLE}▮▮▮▮▮`);
		// Nothing that reaches here is above the scale — `decodeBattery` is where a
		// reading that is not a capacity is refused — but this is also drawn for a
		// level a test or a fake handed over, and a bar with six cells in it is not
		// a thing to put on a screen.
		expect(batteryBar({ level: 99, cable: false })).toBe(BATTERY_FULL.repeat(5));
		expect(batteryBar({ level: -1, cable: false })).toBe(BATTERY_EMPTY.repeat(5));
	});

	test("the width is the caller's, and the cable mark is not a cell", () => {
		expect(batteryBar({ level: 9, cable: false }, 3)).toBe("▮▮▮");
		expect(batteryBar({ level: 0, cable: true }, 3)).toBe(`${BATTERY_CABLE}▯▯▯`);
	});
});

function line(props: { phase?: "idle" | "responding"; battery?: { level: number; cable: boolean } }) {
	const view = render(
		(
			<ThemeContext.Provider value={DARK_THEME}>
				<StatusLine
					phase={props.phase ?? "idle"}
					modelName="test-model"
					elapsedMs={0}
					pad={props.battery ? { phase: "connected", battery: props.battery } : { phase: "connected" }}
				/>
			</ThemeContext.Provider>
		) as React.ReactElement,
	);
	return { frame: () => (view.lastFrame() ?? "").replace(/\s+/g, " "), unmount: view.unmount };
}

describe("the status line and the pad", () => {
	test("a connected pad's charge is on the idle line, next to the model", () => {
		const l = line({ battery: { level: 9, cable: false } });
		expect(l.frame()).toContain("test-model");
		expect(l.frame()).toContain("▮▮▮▮▮");
		l.unmount();
	});

	test("a pad that has not reported a level yet draws no bar", () => {
		// Connected but silent is the state a pad is in for its first second, and
		// an empty bar there would be a claim about a charge nobody has read.
		const l = line({});
		expect(l.frame()).not.toContain(BATTERY_FULL);
		expect(l.frame()).not.toContain(BATTERY_EMPTY);
		l.unmount();
	});

	test("the bar rides along while a turn runs", () => {
		const l = line({ phase: "responding", battery: { level: 4, cable: false } });
		expect(l.frame()).toContain("Responding…");
		expect(l.frame()).toContain("▮▮▯▯▯");
		l.unmount();
	});

	test("no pad at all is the status line it always was", () => {
		const view = render(
			(
				<ThemeContext.Provider value={DARK_THEME}>
					<StatusLine phase="idle" modelName="test-model" elapsedMs={0} />
				</ThemeContext.Provider>
			) as React.ReactElement,
		);
		// Idle with nothing to report draws nothing at all, which is the shape the
		// REPL's layout depends on: an empty row under the prompt would eat a line
		// of the transcript for every screen.
		expect((view.lastFrame() ?? "").trim()).toBe("");
		view.unmount();
	});
});
