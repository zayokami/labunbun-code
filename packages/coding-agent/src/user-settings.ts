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
import { stripBom } from "./json-text.ts";

export function writeUserSettingsPatch(patch: Record<string, unknown>, home = homedir()): void {
	const path = userSettingsPath(home);
	const existing = readUserSettings(path);
	writeUserSettings(path, home, { ...existing, ...patch });
}

/**
 * Persist part of one settings block, leaving the rest of it alone.
 *
 * `writeUserSettingsPatch` replaces a top-level key wholesale, which for
 * `gamepad` would mean `/gamepad off` deleting the user's `bindings` and
 * `phrases` on its way past — settings they wrote by hand and would have to
 * write again. This merges one level down instead: `existing[key]` is treated as
 * an object and the patch's own keys are laid over it.
 *
 * Three details worth stating, because each is a choice:
 *   - Sub-keys the patch does not mention survive, including ones this version
 *     of labunbun knows nothing about.
 *   - A value of `undefined` removes that sub-key: JSON cannot write one, so the
 *     key is absent from the result. That is how a caller un-sets a field.
 *   - If the file's `key` is not an object (a hand-written `"gamepad": true`),
 *     there is nothing to merge into and the patch replaces it.
 */
export function writeUserSettingsNestedPatch(key: string, patch: Record<string, unknown>, home = homedir()): void {
	const path = userSettingsPath(home);
	const existing = readUserSettings(path);
	const current = existing[key];
	const nested =
		typeof current === "object" && current !== null && !Array.isArray(current)
			? (current as Record<string, unknown>)
			: {};
	writeUserSettings(path, home, { ...existing, [key]: { ...nested, ...patch } });
}

function userSettingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

/**
 * The user's own settings file, parsed. Missing reads as empty; unparseable
 * throws, because every writer here is a read-merge-write and merging into a
 * file nobody could read would discard it.
 */
function readUserSettings(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(stripBom(readFileSync(path, "utf8")));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return {};
	} catch {
		throw new Error(`${path} is not valid JSON; fix it before changing settings`);
	}
}

function writeUserSettings(path: string, home: string, data: Record<string, unknown>): void {
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Persist the model choice made via /model. */
export function persistModelChoice(ref: string, home = homedir()): void {
	writeUserSettingsPatch({ model: ref }, home);
}
