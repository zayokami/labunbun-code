/**
 * Settings hierarchy (later overrides earlier):
 *   user (~/.labunbun/settings.json)
 *   → project (<cwd>/.labunbun/settings.json)
 *   → local (<cwd>/.labunbun/settings.local.json, gitignored)
 *   → policy (~/.labunbun/managed-settings.json)
 *   → flag (--settings / CLI-provided object)
 *
 * Objects merge recursively; arrays and scalars replace.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export const PermissionModeSchema = z.enum(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]);

export const OpenAICompatibleProviderSchema = z.object({
	id: z.string(),
	baseUrl: z.string().url(),
	apiKeyEnv: z.string(),
	models: z.array(
		z.object({
			id: z.string(),
			name: z.string().optional(),
			contextWindow: z.number().int().positive(),
			maxOutputTokens: z.number().int().positive(),
			reasoning: z.boolean().optional(),
		}),
	),
});

export const SettingsSchema = z.object({
	model: z.string().optional(),
	/** Model references tried in order when the primary errors before streaming. */
	fallbackModels: z.array(z.string()).optional(),
	permissionMode: PermissionModeSchema.optional(),
	theme: z.enum(["dark", "light"]).optional(),
	vimMode: z.boolean().optional(),
	permissions: z
		.object({
			allow: z.array(z.string()).default([]),
			deny: z.array(z.string()).default([]),
			additionalDirectories: z.array(z.string()).default([]),
		})
		.default({ allow: [], deny: [], additionalDirectories: [] }),
	env: z.record(z.string(), z.string()).optional(),
	providers: z.object({ openaiCompatible: z.array(OpenAICompatibleProviderSchema).default([]) }).optional(),
	hooks: z.record(z.string(), z.array(z.unknown())).optional(),
	mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type RawSettingsInput = z.input<typeof SettingsSchema>;

export type SettingsSourceName = "user" | "project" | "local" | "policy" | "flag";

export interface LoadedSettings {
	settings: Settings;
	/** Which sources contributed (for /permissions display). */
	sources: Partial<Record<SettingsSourceName, string>>;
}

function settingsPath(source: SettingsSourceName, cwd: string): string {
	const home = homedir();
	switch (source) {
		case "user":
			return join(home, ".labunbun", "settings.json");
		case "project":
			return join(resolve(cwd), ".labunbun", "settings.json");
		case "local":
			return join(resolve(cwd), ".labunbun", "settings.local.json");
		case "policy":
			return join(home, ".labunbun", "managed-settings.json");
		case "flag":
			return "";
	}
}

function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`Warning: failed to parse ${path}: ${error instanceof Error ? error.message : error}`);
		return undefined;
	}
}

/** Recursive merge: objects merge, arrays/scalars replace. Later wins. */
export function mergeSettings<T>(base: T, override: unknown): T {
	if (override === undefined) return base;
	if (typeof base !== "object" || base === null || Array.isArray(base)) return override as T;
	if (typeof override !== "object" || override === null || Array.isArray(override)) return override as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(override)) {
		out[key] = key in out ? mergeSettings(out[key], value) : value;
	}
	return out as T;
}

export function loadSettings(cwd: string, flagSettings?: RawSettingsInput): LoadedSettings {
	const order: SettingsSourceName[] = ["user", "project", "local", "policy"];
	let merged: RawSettingsInput = {};
	const sources: Partial<Record<SettingsSourceName, string>> = {};

	for (const source of order) {
		const path = settingsPath(source, cwd);
		const data = readJsonFile(path);
		if (data === undefined) continue;
		merged = mergeSettings(merged, data);
		sources[source] = path;
	}
	if (flagSettings !== undefined) {
		merged = mergeSettings(merged, flagSettings);
		sources.flag = "--settings";
	}

	const parsed = SettingsSchema.safeParse(merged);
	if (!parsed.success) {
		console.error(`Warning: invalid settings ignored: ${parsed.error.message}`);
		return { settings: SettingsSchema.parse({}), sources };
	}
	return { settings: parsed.data, sources };
}
