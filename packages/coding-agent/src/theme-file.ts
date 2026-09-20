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
import { stripBom } from "./json-text.ts";
import { writeUserSettingsPatch } from "./user-settings.ts";

export const ThemeFileSchema = z.object({
	/** Theme name, as used by `theme` in settings and `/theme <name>`. */
	name: z.string().min(1),
	/**
	 * Which background the theme was designed for; also what `auto` matches on.
	 * Optional, and inherited from the extended theme when left out — an author
	 * extending the light theme is stating everything that matters already.
	 */
	appearance: z.enum(["dark", "light"]).optional(),
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
const GROUP_KEYS = new Set(["marks", "bold", "syntax"]);

type GroupName = "marks" | "bold" | "syntax";

/** Tokens a file may not set: they are identity, not appearance. */
const RESERVED_KEYS = new Set(["name", "appearance"]);

const TOKEN_KEYS = new Set<string>(THEME_TOKEN_KEYS as readonly string[]);

/**
 * Check one nested group against the base theme's own members, which are the
 * contract — a new mark or syntax class is valid the moment the built-ins have
 * one, and nothing has to be listed in two places to stay in step.
 *
 * As at the top level, a bad member is reported and dropped rather than passed
 * through: a `marks` value that is not a string prints as `null` or `7` in
 * place of a symbol, which reads as the app being broken instead of the file.
 */
function groupOverrides(
	base: Theme,
	group: GroupName,
	values: Record<string, unknown>,
	path: string,
	problems: string[],
): Record<string, string | boolean> {
	const reference = base[group] as unknown as Record<string, string | boolean>;
	const accepted: Record<string, string | boolean> = {};
	for (const [member, value] of Object.entries(values)) {
		// hasOwn, not `in`: "toString" is not a mark, and `in` would say it is.
		if (!Object.hasOwn(reference, member)) {
			problems.push(`${path}: unknown token "${group}.${member}"; ${group} has ${Object.keys(reference).join(", ")}`);
			continue;
		}
		const wantsBoolean = typeof reference[member] === "boolean";
		if (wantsBoolean ? typeof value !== "boolean" : typeof value !== "string" || value.trim() === "") {
			problems.push(
				`${path}: token "${group}.${member}" must be ${wantsBoolean ? "true or false" : "a non-empty string"}`,
			);
			continue;
		}
		accepted[member] = value as string | boolean;
	}
	return accepted;
}

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
			overrides[key] = groupOverrides(base, key as GroupName, value as Record<string, unknown>, path, problems);
			continue;
		}
		if (typeof value !== "string" || value.trim() === "") {
			problems.push(`${path}: token "${key}" must be a non-empty string`);
			continue;
		}
		overrides[key] = value;
	}

	// Inherited, not defaulted to dark: a file that says nothing about its
	// appearance is whatever the theme it extends is, and `auto` matches on it.
	const theme = deriveTheme(base, { ...overrides, name: file.name, appearance: file.appearance ?? base.appearance });
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
			// The byte-order mark some Windows editors and shells put in front of a
			// UTF-8 file is not JSON, and JSON.parse names it "Unexpected token" at
			// position 0 — a report about the parser, about a file whose only fault
			// is where it was saved from.
			const text = stripBom(readFileSync(path, "utf8"));
			const parsed = ThemeFileSchema.safeParse(JSON.parse(text));
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

/**
 * Every name a user can pick, built-ins in presentation order, then theme files
 * — each exactly once.
 *
 * A theme file may call itself after a built-in, and the file wins; listing both
 * would put two rows in `/theme` that resolve to the same theme, one of them
 * always unreachable. Deduped here rather than at each list site so the
 * selector, the "Unknown theme … Available:" line and the startup list cannot
 * disagree about what exists.
 */
export function selectableThemeNames(loaded: LoadedThemes): string[] {
	return [...new Set([...BUILT_IN_THEME_NAMES, ...loaded.themes.keys()])];
}

export interface ResolvedTheme {
	theme: Theme;
	/**
	 * The name that was asked for, defaulted when none was given.
	 *
	 * Not the same as `theme.name`: `"auto"` resolves to whichever built-in the
	 * terminal probe picked, and a theme file named `mine.json` can call itself
	 * anything. This is the name that gets written back and the row `/theme`
	 * marks as current — taking it from the resolved theme instead made Enter on
	 * an `auto` setting save the built-in it happened to detect.
	 */
	choice: string;
	/** Every selectable name, built-ins first, then theme files — see `selectableThemeNames`. */
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
	const available = selectableThemeNames(loaded);
	const problems = [...loaded.problems];

	if (!name) return { theme: DEFAULT_THEME, choice: DEFAULT_THEME.name, available, problems };
	if (name === AUTO_THEME_NAME) {
		const appearance = await detectAppearance();
		// A theme file that states its appearance is a theme the author wrote for
		// this background; the built-in is the fallback for a workspace that has
		// none. Last one wins, the same rule the loader applies to the files
		// themselves (sorted within a directory, project after user), so `auto`
		// agrees with what `/theme <name>` would have selected by hand.
		const fromFiles = [...loaded.themes.values()].filter((theme) => theme.appearance === appearance);
		return { theme: fromFiles.at(-1) ?? themeForAppearance(appearance), choice: name, available, problems };
	}
	const theme = loaded.themes.get(name) ?? resolveBuiltInTheme(name);
	if (!theme) {
		// The choice stays the name that was asked for even though it did not
		// resolve: the problem above says so, and the caller checks it.
		problems.push(`Unknown theme "${name}"; using "${DEFAULT_THEME.name}". Available: ${available.join(", ")}`);
		return { theme: DEFAULT_THEME, choice: name, available, problems };
	}
	return { theme, choice: name, available, problems };
}

/**
 * Persist the theme choice. Delegates to the shared read-merge-write helper;
 * kept as its own export because several call sites and tests name it.
 */
export function persistThemeChoice(name: string, home = homedir()): void {
	writeUserSettingsPatch({ theme: name }, home);
}
