/**
 * The two token formats, and the one setting that switches between them.
 *
 * The compact form is what every "1.2k" in the app has always been; the MTok
 * form is opt-in and only starts at a million, so the tests pin the boundary
 * rather than a sample a long way from it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { formatTokens, formatTokenTotal, getTokenUnit, setTokenUnit } from "../src/format.ts";

afterEach(() => setTokenUnit("k"));

describe("formatTokens", () => {
	test("keeps the compact k form below a million", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(123_456)).toBe("123.5k");
		expect(formatTokens(999_999)).toBe("1000.0k");
	});

	test("switches to MTok at a million when the setting asks for it", () => {
		setTokenUnit("mtok");
		expect(formatTokens(999_999)).toBe("1000.0k");
		expect(formatTokens(1_000_000)).toBe("1.0 MTok");
		expect(formatTokens(849_928_626)).toBe("849.9 MTok");
	});

	test("an unset unit is the compact one", () => {
		setTokenUnit("mtok");
		setTokenUnit(undefined);
		expect(getTokenUnit()).toBe("k");
		expect(formatTokens(2_500_000)).toBe("2500.0k");
	});

	test("a caller may name a unit instead of taking the process default", () => {
		expect(formatTokens(2_500_000, "mtok")).toBe("2.5 MTok");
		expect(formatTokens(2_500_000, "k")).toBe("2500.0k");
	});
});

describe("formatTokenTotal", () => {
	test("keeps every digit below a million", () => {
		expect(formatTokenTotal(0)).toBe("0");
		expect(formatTokenTotal(1_000)).toBe("1,000");
		expect(formatTokenTotal(849_928)).toBe("849,928");
	});

	test("uses MTok above a million only when the setting is on", () => {
		expect(formatTokenTotal(1_234_567)).toBe("1,234,567");
		setTokenUnit("mtok");
		expect(formatTokenTotal(1_234_567)).toBe("1.2 MTok");
		expect(formatTokenTotal(849_928_626)).toBe("849.9 MTok");
	});
});
