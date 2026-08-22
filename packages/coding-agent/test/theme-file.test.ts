/**
 * Third-party theme files: what loads, what is reported, and what a bad file is
 * not allowed to do — namely, stop the REPL from starting or take other themes
 * down with it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DARK_THEME, LIGHT_THEME } from "@labunbun/tui";
import { loadThemeFiles, persistThemeChoice, resolveTheme, ThemeFileSchema, themeFromFile } from "../src/theme-file.ts";

/** A home and cwd pair with themes directories ready to write into. */
function makeDirs() {
	const root = mkdtempSync(join(tmpdir(), "lbb-theme-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	const userThemes = join(home, ".labunbun", "themes");
	const projectThemes = join(cwd, ".labunbun", "themes");
	mkdirSync(userThemes, { recursive: true });
	mkdirSync(projectThemes, { recursive: true });
	return { root, home, cwd, userThemes, projectThemes };
}

function writeTheme(dir: string, file: string, body: unknown): void {
	writeFileSync(join(dir, file), typeof body === "string" ? body : JSON.stringify(body));
}

describe("themeFromFile", () => {
	test("fills every unset token from the extended theme", () => {
		const parsed = ThemeFileSchema.parse({
			name: "mine",
			extends: "dark",
			tokens: { error: "#ff00ff", accent: "#00ffff", codeText: "#888888" },
		});
		const { theme, problems } = themeFromFile(parsed, "mine.json");
		expect(problems).toEqual([]);
		expect(theme?.error).toBe("#ff00ff");
		expect(theme?.accent).toBe("#00ffff");
		expect(theme?.codeText).toBe("#888888");
		// Everything else is the base theme, which is the entire point of extends.
		for (const key of ["text", "textMuted", "toolBorder", "diffAdded", "path", "border"] as const) {
			expect(theme?.[key]).toBe(DARK_THEME[key]);
		}
		expect(theme?.marks).toEqual(DARK_THEME.marks);
	});

	test("aliases follow the overridden tokens", () => {
		const parsed = ThemeFileSchema.parse({ name: "mine", tokens: { accent: "#abcdef", textMuted: "#fedcba" } });
		const { theme } = themeFromFile(parsed, "mine.json");
		expect(theme?.primary).toBe("#abcdef");
		expect(theme?.dim).toBe("#fedcba");
	});

	test("appearance picks the base theme when extends is omitted", () => {
		const dark = themeFromFile(ThemeFileSchema.parse({ name: "d" }), "d.json");
		const light = themeFromFile(ThemeFileSchema.parse({ name: "l", appearance: "light" }), "l.json");
		expect(dark.theme?.text).toBe(DARK_THEME.text);
		expect(dark.theme?.appearance).toBe("dark");
		expect(light.theme?.text).toBe(LIGHT_THEME.text);
		expect(light.theme?.appearance).toBe("light");
	});

	test("merges marks per key, keeping the ones the file left alone", () => {
		const parsed = ThemeFileSchema.parse({ name: "mine", tokens: { marks: { error: "XX" } } });
		const { theme, problems } = themeFromFile(parsed, "mine.json");
		expect(problems).toEqual([]);
		expect(theme?.marks.error).toBe("XX");
		expect(theme?.marks.success).toBe(DARK_THEME.marks.success);
	});

	test("rejects the reserved auto name", () => {
		const { theme, problems } = themeFromFile(ThemeFileSchema.parse({ name: "auto" }), "auto.json");
		expect(theme).toBeUndefined();
		expect(problems.join("\n")).toContain("reserved");
	});

	test("rejects an extends that names no built-in theme", () => {
		const parsed = ThemeFileSchema.parse({ name: "mine", extends: "nonexistent" });
		const { theme, problems } = themeFromFile(parsed, "mine.json");
		expect(theme).toBeUndefined();
		expect(problems.join("\n")).toContain("nonexistent");
	});

	// A misspelled token is the most common mistake in a hand-written theme and
	// has no visible effect, so it is reported while the rest of the file loads.
	test("reports an unknown token but keeps the valid ones", () => {
		const parsed = ThemeFileSchema.parse({ name: "mine", tokens: { errorColor: "#ff0000", error: "#00ff00" } });
		const { theme, problems } = themeFromFile(parsed, "mine.json");
		expect(problems.join("\n")).toContain("errorColor");
		expect(theme?.error).toBe("#00ff00");
	});

	test("reports a token given the wrong type instead of passing it through", () => {
		const parsed = ThemeFileSchema.parse({ name: "mine", tokens: { error: 42, text: "", marks: "nope" } });
		const { theme, problems } = themeFromFile(parsed, "mine.json");
		expect(problems).toHaveLength(3);
		expect(theme?.error).toBe(DARK_THEME.error);
		expect(theme?.text).toBe(DARK_THEME.text);
		expect(theme?.marks).toEqual(DARK_THEME.marks);
	});

	test("reports identity keys placed inside tokens", () => {
		const parsed = ThemeFileSchema.parse({ name: "mine", tokens: { name: "other", appearance: "light" } });
		const { theme, problems } = themeFromFile(parsed, "mine.json");
		expect(problems).toHaveLength(2);
		expect(problems.join("\n")).toContain("top level");
		expect(theme?.name).toBe("mine");
	});
});

describe("loadThemeFiles", () => {
	test("returns nothing and no problems when no themes directories exist", () => {
		const root = mkdtempSync(join(tmpdir(), "lbb-theme-empty-"));
		const loaded = loadThemeFiles(join(root, "project"), join(root, "home"));
		expect(loaded.themes.size).toBe(0);
		expect(loaded.problems).toEqual([]);
	});

	test("loads themes from both scopes", () => {
		const { home, cwd, userThemes, projectThemes } = makeDirs();
		writeTheme(userThemes, "ocean.json", { name: "ocean", tokens: { accent: "#0000ff" } });
		writeTheme(projectThemes, "forest.json", { name: "forest", tokens: { accent: "#00ff00" } });
		const loaded = loadThemeFiles(cwd, home);
		expect([...loaded.themes.keys()].sort()).toEqual(["forest", "ocean"]);
		expect(loaded.problems).toEqual([]);
	});

	test("a project theme overrides a user theme of the same name", () => {
		const { home, cwd, userThemes, projectThemes } = makeDirs();
		writeTheme(userThemes, "shared.json", { name: "shared", tokens: { accent: "#111111" } });
		writeTheme(projectThemes, "shared.json", { name: "shared", tokens: { accent: "#222222" } });
		const loaded = loadThemeFiles(cwd, home);
		expect(loaded.themes.size).toBe(1);
		expect(loaded.themes.get("shared")?.accent).toBe("#222222");
	});

	test("ignores files that are not .json", () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "notes.txt", "not a theme");
		writeTheme(userThemes, "ok.json", { name: "ok" });
		const loaded = loadThemeFiles(cwd, home);
		expect([...loaded.themes.keys()]).toEqual(["ok"]);
		expect(loaded.problems).toEqual([]);
	});

	// The load path must not throw: a broken theme file cannot be allowed to
	// stop the REPL from starting.
	test("unparseable JSON is reported without throwing and without taking other files down", () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "broken.json", "{ not json");
		writeTheme(userThemes, "good.json", { name: "good", tokens: { accent: "#333333" } });
		const loaded = loadThemeFiles(cwd, home);
		expect([...loaded.themes.keys()]).toEqual(["good"]);
		expect(loaded.problems).toHaveLength(1);
		expect(loaded.problems[0]).toContain("broken.json");
	});

	test("a file failing schema validation is reported, naming the path", () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "nameless.json", { tokens: { accent: "#444444" } });
		writeTheme(userThemes, "good.json", { name: "good" });
		const loaded = loadThemeFiles(cwd, home);
		expect([...loaded.themes.keys()]).toEqual(["good"]);
		expect(loaded.problems).toHaveLength(1);
		expect(loaded.problems[0]).toContain("nameless.json");
	});

	test("an unknown extends is reported and only that theme is dropped", () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "orphan.json", { name: "orphan", extends: "ghost" });
		writeTheme(userThemes, "good.json", { name: "good" });
		const loaded = loadThemeFiles(cwd, home);
		expect([...loaded.themes.keys()]).toEqual(["good"]);
		expect(loaded.problems.join("\n")).toContain("ghost");
	});

	test("problems from both scopes are collected together", () => {
		const { home, cwd, userThemes, projectThemes } = makeDirs();
		writeTheme(userThemes, "a.json", "{{{");
		writeTheme(projectThemes, "b.json", { name: "b", tokens: { bogusToken: "#555555" } });
		const loaded = loadThemeFiles(cwd, home);
		expect(loaded.problems).toHaveLength(2);
		expect(loaded.themes.has("b")).toBe(true);
	});

	test("a theme file can extend a built-in variant, not just the base themes", () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "hc.json", { name: "hc", extends: "high-contrast-dark", tokens: { accent: "#ff00ff" } });
		const loaded = loadThemeFiles(cwd, home);
		expect(loaded.themes.get("hc")?.bold).toEqual({ error: true, warning: true, success: true });
		expect(loaded.themes.get("hc")?.accent).toBe("#ff00ff");
	});
});

describe("resolveTheme", () => {
	test("no configured name resolves the default and still lists what is available", async () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "mine.json", { name: "mine" });
		const resolved = await resolveTheme(undefined, cwd, home);
		expect(resolved.theme).toBe(DARK_THEME);
		expect(resolved.available).toContain("mine");
		expect(resolved.available).toContain("dark");
		expect(resolved.problems).toEqual([]);
	});

	test("resolves a built-in theme by name", async () => {
		const { home, cwd } = makeDirs();
		const resolved = await resolveTheme("light", cwd, home);
		expect(resolved.theme).toBe(LIGHT_THEME);
	});

	test("a theme file wins over a built-in of the same name", async () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "dark.json", { name: "dark", tokens: { accent: "#c0ffee" } });
		const resolved = await resolveTheme("dark", cwd, home);
		expect(resolved.theme.accent).toBe("#c0ffee");
	});

	// Falling back rather than failing: an unresolved name should not stop
	// startup, but it must be visible in /doctor.
	test("an unknown name falls back to the default and reports the miss", async () => {
		const { home, cwd } = makeDirs();
		const resolved = await resolveTheme("ghost", cwd, home);
		expect(resolved.theme).toBe(DARK_THEME);
		expect(resolved.problems.join("\n")).toContain("ghost");
	});

	test("theme-file problems reach the caller alongside a resolved theme", async () => {
		const { home, cwd, userThemes } = makeDirs();
		writeTheme(userThemes, "broken.json", "nope");
		const resolved = await resolveTheme("light", cwd, home);
		expect(resolved.theme).toBe(LIGHT_THEME);
		expect(resolved.problems).toHaveLength(1);
	});

	test("auto resolves to a built-in theme without a terminal to probe", async () => {
		const { home, cwd } = makeDirs();
		const resolved = await resolveTheme("auto", cwd, home);
		// No TTY here, so detection declines to probe and returns dark.
		expect(resolved.theme).toBe(DARK_THEME);
	});
});

describe("persistThemeChoice", () => {
	test("creates the settings file when there is none", async () => {
		const { home } = makeDirs();
		persistThemeChoice("splatoon", home);
		const written = JSON.parse(await Bun.file(join(home, ".labunbun", "settings.json")).text());
		expect(written).toEqual({ theme: "splatoon" });
	});

	test("writes the theme key and leaves every other key alone", async () => {
		const { home } = makeDirs();
		const path = join(home, ".labunbun", "settings.json");
		writeFileSync(path, JSON.stringify({ model: "anthropic/claude-sonnet-5", permissions: { allow: ["Bash"] } }));
		persistThemeChoice("spiderman", home);
		const written = JSON.parse(await Bun.file(path).text());
		expect(written).toEqual({
			model: "anthropic/claude-sonnet-5",
			permissions: { allow: ["Bash"] },
			theme: "spiderman",
		});
	});

	test("replaces an existing theme key rather than duplicating it", async () => {
		const { home } = makeDirs();
		const path = join(home, ".labunbun", "settings.json");
		writeFileSync(path, JSON.stringify({ theme: "dark", model: "x" }));
		persistThemeChoice("light", home);
		const written = JSON.parse(await Bun.file(path).text());
		expect(written).toEqual({ theme: "light", model: "x" });
	});

	// Overwriting a file we cannot parse would discard whatever the user has in
	// it, so this refuses instead.
	test("refuses to overwrite a settings file that is not valid JSON, leaving it intact", async () => {
		const { home } = makeDirs();
		const path = join(home, ".labunbun", "settings.json");
		writeFileSync(path, "{ broken");
		expect(() => persistThemeChoice("light", home)).toThrow(/valid JSON/);
		expect(await Bun.file(path).text()).toBe("{ broken");
	});
});
