import { describe, expect, test } from "bun:test";
import {
	AUTO_THEME_NAME,
	BUILT_IN_THEME_NAMES,
	BUILT_IN_THEMES,
	DARK_THEME,
	DEFAULT_THEME,
	defineTheme,
	deriveTheme,
	resolveBuiltInTheme,
	THEME_TOKEN_KEYS,
	type Theme,
	themeForAppearance,
} from "../src/theme.ts";

const ALL = [...BUILT_IN_THEMES.values()];

/** Tokens that must differ from each other so state stays readable. */
const STATE_TOKENS = ["success", "warning", "error", "accent"] as const;

describe("built-in theme registry", () => {
	test("registers all eight themes, addressable by name", () => {
		expect(ALL).toHaveLength(8);
		expect(BUILT_IN_THEME_NAMES).toHaveLength(8);
		for (const name of BUILT_IN_THEME_NAMES) {
			expect(resolveBuiltInTheme(name)?.name).toBe(name);
		}
	});

	test("no theme claims the reserved auto name", () => {
		expect(BUILT_IN_THEME_NAMES).not.toContain(AUTO_THEME_NAME);
		expect(resolveBuiltInTheme(AUTO_THEME_NAME)).toBeUndefined();
	});

	test("resolveBuiltInTheme misses report undefined rather than a default", () => {
		expect(resolveBuiltInTheme("nope")).toBeUndefined();
		expect(resolveBuiltInTheme(undefined)).toBeUndefined();
	});

	test("the default theme is one of the registered themes", () => {
		expect(BUILT_IN_THEMES.get(DEFAULT_THEME.name)).toBe(DEFAULT_THEME);
	});

	test("themeForAppearance maps each background to a theme designed for it", () => {
		expect(themeForAppearance("dark").appearance).toBe("dark");
		expect(themeForAppearance("light").appearance).toBe("light");
	});
});

describe("token completeness", () => {
	// A derived theme that forgot a token would render an undefined color, which
	// Ink silently ignores — so the shape is asserted rather than eyeballed.
	test("every theme defines every token in the contract", () => {
		const expected = Object.keys(DARK_THEME).sort();
		expect(expected).toEqual([...THEME_TOKEN_KEYS].sort());
		for (const theme of ALL) {
			expect(Object.keys(theme).sort()).toEqual(expected);
		}
	});

	test("every color token is a non-empty string", () => {
		for (const theme of ALL) {
			for (const key of THEME_TOKEN_KEYS) {
				if (key === "marks" || key === "bold") continue;
				const value = theme[key];
				expect(typeof value).toBe("string");
				expect((value as string).trim()).not.toBe("");
			}
		}
	});

	test("every theme declares an appearance", () => {
		for (const theme of ALL) {
			expect(["dark", "light"]).toContain(theme.appearance);
		}
	});

	test("aliases hold the same value as the tokens they alias", () => {
		for (const theme of ALL) {
			expect(theme.primary).toBe(theme.accent);
			expect(theme.dim).toBe(theme.textMuted);
			expect(theme.userMessage).toBe(theme.userInput);
		}
	});
});

describe("state legibility", () => {
	// The failure this guards against: a themed accent color that happens to
	// equal the error color, so an error message vanishes into the decoration.
	test("success, warning, error, and accent are pairwise distinct in every theme", () => {
		for (const theme of ALL) {
			const seen = new Map<string, string>();
			for (const token of STATE_TOKENS) {
				const value = theme[token];
				expect(seen.has(value), `${theme.name}: ${token} duplicates ${seen.get(value)} (${value})`).toBe(false);
				seen.set(value, token);
			}
		}
	});

	test("every theme carries all five marks, non-empty", () => {
		for (const theme of ALL) {
			expect(Object.keys(theme.marks).sort()).toEqual(["error", "pending", "selected", "success", "warning"]);
			for (const [key, mark] of Object.entries(theme.marks)) {
				expect(typeof mark, `${theme.name}.marks.${key}`).toBe("string");
				expect(mark.trim()).not.toBe("");
			}
		}
	});

	test("every theme carries all three bold flags as booleans", () => {
		for (const theme of ALL) {
			expect(Object.keys(theme.bold).sort()).toEqual(["error", "success", "warning"]);
			for (const [key, flag] of Object.entries(theme.bold)) {
				expect(typeof flag, `${theme.name}.bold.${key}`).toBe("boolean");
			}
		}
	});

	test("high-contrast themes bold every state", () => {
		for (const theme of ALL.filter((t) => t.name.startsWith("high-contrast"))) {
			expect(theme.bold).toEqual({ error: true, warning: true, success: true });
		}
	});
});

describe("deriveTheme", () => {
	test("carries over untouched tokens", () => {
		const derived = deriveTheme(DARK_THEME, { error: "#ff0000" });
		expect(derived.error).toBe("#ff0000");
		expect(derived.text).toBe(DARK_THEME.text);
		expect(derived.toolBorder).toBe(DARK_THEME.toolBorder);
	});

	test("merges marks per key instead of replacing the group", () => {
		const derived = deriveTheme(DARK_THEME, { marks: { error: "!!" } });
		expect(derived.marks.error).toBe("!!");
		expect(derived.marks.success).toBe(DARK_THEME.marks.success);
		expect(derived.marks.warning).toBe(DARK_THEME.marks.warning);
		expect(derived.marks.pending).toBe(DARK_THEME.marks.pending);
		expect(derived.marks.selected).toBe(DARK_THEME.marks.selected);
	});

	test("merges bold per key instead of replacing the group", () => {
		const derived = deriveTheme(DARK_THEME, { bold: { warning: true } });
		expect(derived.bold.warning).toBe(true);
		expect(derived.bold.error).toBe(DARK_THEME.bold.error);
		expect(derived.bold.success).toBe(DARK_THEME.bold.success);
	});

	test("recomputes aliases from the overridden tokens", () => {
		const derived = deriveTheme(DARK_THEME, { accent: "#123456", textMuted: "#654321", userInput: "#abcdef" });
		expect(derived.primary).toBe("#123456");
		expect(derived.dim).toBe("#654321");
		expect(derived.userMessage).toBe("#abcdef");
	});

	test("does not mutate the base theme", () => {
		const before = structuredClone(DARK_THEME) as Theme;
		deriveTheme(DARK_THEME, { error: "#000000", marks: { error: "x" }, bold: { success: true } });
		expect(DARK_THEME).toEqual(before);
	});
});

describe("defineTheme", () => {
	test("fills in the aliases from the canonical tokens", () => {
		const theme = defineTheme({ ...DARK_THEME, accent: "#111111", textMuted: "#222222", userInput: "#333333" });
		expect(theme.primary).toBe("#111111");
		expect(theme.dim).toBe("#222222");
		expect(theme.userMessage).toBe("#333333");
	});
});
