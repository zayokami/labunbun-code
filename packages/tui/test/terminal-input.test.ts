import { describe, expect, test } from "bun:test";
import { dropLastChar, enterRawModeEarly } from "../src/terminal-input.ts";

describe("dropLastChar", () => {
	test("removes one ASCII or CJK character", () => {
		expect(dropLastChar("abc")).toBe("ab");
		expect(dropLastChar("你好")).toBe("你");
	});

	test("removes a whole emoji, not half of its surrogate pair", () => {
		expect(dropLastChar("ok😀")).toBe("ok");
		expect("ok😀".slice(0, -1)).not.toBe("ok");
	});

	test("removes a base character together with its combining mark", () => {
		expect(dropLastChar("aé")).toBe("a");
	});

	test("an empty string stays empty", () => {
		expect(dropLastChar("")).toBe("");
	});
});

describe("enterRawModeEarly", () => {
	test("switches a TTY to raw mode, so the kitty query answer is read and not echoed", () => {
		const calls: boolean[] = [];
		const entered = enterRawModeEarly({ isTTY: true, setRawMode: (mode) => calls.push(mode) });
		expect(entered).toBe(true);
		expect(calls).toEqual([true]);
	});

	test("leaves a stream that is not a TTY alone", () => {
		const calls: boolean[] = [];
		expect(enterRawModeEarly({ isTTY: false, setRawMode: (mode) => calls.push(mode) })).toBe(false);
		expect(enterRawModeEarly({ setRawMode: (mode) => calls.push(mode) })).toBe(false);
		expect(calls).toEqual([]);
	});

	test("leaves a stream that cannot switch modes alone", () => {
		expect(enterRawModeEarly({ isTTY: true })).toBe(false);
	});

	test("a stream that refuses the switch is not an error", () => {
		const refusing = {
			isTTY: true,
			setRawMode: () => {
				throw new Error("EIO");
			},
		};
		expect(enterRawModeEarly(refusing)).toBe(false);
	});
});
