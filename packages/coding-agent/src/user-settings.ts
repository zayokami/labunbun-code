/**
 * Persisting a single setting from inside a running session (/theme, /model).
 *
 * Read-merge-write on the USER settings file only: project and local layers are
 * repo-scoped and must not be modified as a side effect of an interactive
 * command. An unparseable file is never overwritten — rewriting it would
 * discard whatever the user has in there.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function writeUserSettingsPatch(patch: Record<string, unknown>, home = homedir()): void {
	const path = join(home, ".labunbun", "settings.json");
	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			throw new Error(`${path} is not valid JSON; fix it before changing settings`);
		}
	}
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, "utf8");
}

/** Persist the theme choice; kept as its own name for call-site readability. */
export function persistThemeChoice(name: string, home = homedir()): void {
	writeUserSettingsPatch({ theme: name }, home);
}

/** Persist the model choice made via /model. */
export function persistModelChoice(ref: string, home = homedir()): void {
	writeUserSettingsPatch({ model: ref }, home);
}
