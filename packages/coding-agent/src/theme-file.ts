/**
 * Third-party themes loaded from JSON files.
 *
 * A theme is a flat token table plus an optional `extends` naming a built-in to
 * inherit from, so a theme that only changes a few colors does not have to
 * restate the whole contract. Files live in `~/.labunbun/themes/*.json` and
 * `<cwd>/.labunbun/themes/*.json`, project overriding user by name.
 *
 * Failures are collected rather than thrown: a broken theme file must not stop
 * the REPL from starting. But a silently ignored file is worse than a loud one,
 * because the symptom — "my theme did nothing" — gives no hint why, so every
 * problem is recorded for `/doctor` to report.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

import { homedir } from "node:os";
import { join } from "node:path";
import {
	AUTO_THEME_NAME,
	BUILT_IN_THEME_NAMES,
	DEFAULT_THEME,
	deriveTheme,
	detectAppearance,
	resolveBuiltInTheme,
	THEME_TOKEN_KEYS,
	type Theme,
	themeForAppearance,
} from "@labunbun/tui";
import { z } from "zod";
import { writeUserSettingsPatch } from "./user-settings.ts";

export const ThemeFileSchema = z.object({
	/** Theme name, as used by `theme` in settings and `/theme <name>`. */
	name: z.string().min(1),
	/** Which background the theme was designed for; also what `auto` matches on. */
	appearance: z.enum(["dark", "light"]).default("dark"),
	/** Built-in theme supplying every token this file does not set. */
	extends: z.string().optional(),
	/** Token overrides. Validated against the contract, not blindly trusted. */
	tokens: z.record(z.string(), z.unknown()).default({}),
});

export type ThemeFile = z.infer<typeof ThemeFileSchema>;

export interface LoadedThemes {
	/** Successfully loaded themes by name. */
	themes: Map<string, Theme>;
	/** Human-readable problems, for `/doctor`. Empty when everything loaded. */
	problems: string[];
}

/** Tokens whose values are nested objects rather than color strings. */
const GROUP_KEYS = new Set(["marks", "bold"]);
/** Tokens a file may not set: they are identity, not appearance. */
const RESERVED_KEYS = new Set(["name", "appearance"]);

const TOKEN_KEYS = new Set<string>(THEME_TOKEN_KEYS as readonly string[]);

/**
 * Turn a parsed file into a theme, or explain why it cannot become one.
 *
 * Unknown token keys do not fail the file — the rest of it is still usable —
 * but they are reported, because a misspelled token name is the most common
 * mistake in a hand-written theme and produces no visible effect otherwise.
 */
export function themeFromFile(file: ThemeFile, path: string): { theme?: Theme; problems: string[] } {
	const problems: string[] = [];

	if (file.name === AUTO_THEME_NAME) {
		return { problems: [`${path}: "${AUTO_THEME_NAME}" is reserved for terminal detection; rename this theme`] };
	}

	const baseName = file.extends ?? (file.appearance === "light" ? "light" : "dark");
	const base = resolveBuiltInTheme(baseName);
	if (!base) {
		return { problems: [`${path}: extends unknown theme "${baseName}"`] };
	}

	const overrides: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(file.tokens)) {
		if (RESERVED_KEYS.has(key)) {
			problems.push(`${path}: set "${key}" at the top level, not inside tokens`);
			continue;
		}
		if (!TOKEN_KEYS.has(key)) {
			problems.push(`${path}: unknown token "${key}"`);
			continue;
		}
		if (GROUP_KEYS.has(key)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				problems.push(`${path}: token "${key}" must be an object`);
				continue;
			}
			overrides[key] = value;
			continue;
		}
		if (typeof value !== "string" || value.trim() === "") {
			problems.push(`${path}: token "${key}" must be a non-empty string`);
			continue;
		}
		overrides[key] = value;
	}

	const theme = deriveTheme(base, { ...overrides, name: file.name, appearance: file.appearance });
	return { theme, problems };
}

function loadThemesFromDir(themesRoot: string): LoadedThemes {
	const themes = new Map<string, Theme>();
	const problems: string[] = [];
	if (!existsSync(themesRoot)) return { themes, problems };
	let entries: string[];
	try {
		entries = readdirSync(themesRoot, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => entry.name);
	} catch {
		// An unreadable themes directory is not worth reporting: there is
		// nothing the user can act on beyond what the OS already told them.
		return { themes, problems };
	}
	for (const name of entries.sort()) {
		const path = join(themesRoot, name);
		try {
			const parsed = ThemeFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
			if (!parsed.success) {
				problems.push(
					`${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
				);
				continue;
			}
			const result = themeFromFile(parsed.data, path);
			problems.push(...result.problems);
			if (result.theme) themes.set(result.theme.name, result.theme);
		} catch (error) {
			problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { themes, problems };
}

/**
 * Load user then project themes. Project wins on a name collision, matching how
 * skills and settings already resolve the two scopes.
 */
export function loadThemeFiles(cwd: string, home = homedir()): LoadedThemes {
	const user = loadThemesFromDir(join(home, ".labunbun", "themes"));
	const project = loadThemesFromDir(join(cwd, ".labunbun", "themes"));
	const themes = new Map<string, Theme>([...user.themes, ...project.themes]);
	return { themes, problems: [...user.problems, ...project.problems] };
}

export interface ResolvedTheme {
	theme: Theme;
	/** Every selectable name, built-ins first, then theme files. */
	available: string[];
	/** Problems from theme files, plus an unresolved name, for `/doctor`. */
	problems: string[];
}

/**
 * Resolve a configured theme name to an actual theme.
 *
 * `"auto"` probes the terminal, which is why this is async. At startup it must be
 * awaited before the REPL mounts; called later, from `/theme auto`, the probe
 * takes stdin from Ink for its timeout window and hands it back.
 */
export async function resolveTheme(name: string | undefined, cwd: string, home = homedir()): Promise<ResolvedTheme> {
	const loaded = loadThemeFiles(cwd, home);
	const available = [...BUILT_IN_THEME_NAMES, ...loaded.themes.keys()];
	const problems = [...loaded.problems];

	if (!name) return { theme: DEFAULT_THEME, available, problems };
	if (name === AUTO_THEME_NAME) {
		return { theme: themeForAppearance(await detectAppearance()), available, problems };
	}
	const theme = loaded.themes.get(name) ?? resolveBuiltInTheme(name);
	if (!theme) {
		problems.push(`Unknown theme "${name}"; using "${DEFAULT_THEME.name}". Available: ${available.join(", ")}`);
		return { theme: DEFAULT_THEME, available, problems };
	}
	return { theme, available, problems };
}

/**
 * Persist the theme choice. Delegates to the shared read-merge-write helper;
 * kept as its own export because several call sites and tests name it.
 */
export function persistThemeChoice(name: string, home = homedir()): void {
	writeUserSettingsPatch({ theme: name }, home);
}
