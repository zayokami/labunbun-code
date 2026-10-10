// T3 Code's configuration in the target's shape: the permission posture, the model,
// the provider environment, and everything this importer found and will not carry.
// Long-form design notes: docs/dev/migration-sources.md

import { join } from "node:path";
import type { PermissionMode, SandboxMode } from "@labunbun/agent";
import { BUILT_IN_THEME_NAMES } from "@labunbun/tui";
import { reportUnhandledKeys, summarizeNames, tildePath } from "./migrate-core.ts";
import type { ClaimEnv, ClaimModePair, ClaimScalar, MigrationItem } from "./migrate-types.ts";
import { resolveModelReference } from "./migrate-types.ts";
import { t3SettingsPath } from "./t3-home.ts";
import type { RawT3Code, T3Settings } from "./t3-read.ts";

// ---------------------------------------------------------------------------
// T3 Code
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/migration-sources.md
/** T3's four runtime modes, three mapped and one deliberately not. */
export const T3_RUNTIME_MODES: Record<string, { mode: PermissionMode; sandbox: SandboxMode } | undefined> = {
	"approval-required": { mode: "ask", sandbox: "workspace-write" },
	"auto-accept-edits": { mode: "ask", sandbox: "workspace-write" },
	auto: undefined,
	"full-access": { mode: "agent", sandbox: "danger-full-access" },
};

// Long-form design notes: docs/dev/migration-sources.md
/** Keys of `settings.json` this mapper accounts for. */
const T3_SETTINGS_HANDLED = new Set([
	"defaultRuntimeMode",
	"defaultModelSelection",
	"textGenerationModelSelection",
	"defaultTheme",
	"providerInstances",
	"providers",
	"projectSettingsOverrides",
]);

// Long-form design notes: docs/dev/migration-sources.md
/** The permission posture, claimed only when the file states one. */
function planT3RuntimeMode(
	file: string,
	settings: T3Settings,
	items: MigrationItem[],
	claimModePair: ClaimModePair,
): void {
	const mode = settings.runtimeMode;
	if (!mode) return;
	const from = `${file} → defaultRuntimeMode ("${mode}")`;
	const mapped = T3_RUNTIME_MODES[mode];
	if (mapped !== undefined) {
		claimModePair(
			"t3-code",
			mapped.mode,
			mapped.sandbox,
			from,
			mode === "auto-accept-edits"
				? 'mapped to "ask": this build has no mode that applies edits without asking, so a write is asked like everything else. Narrower than the mode it replaced, deliberately'
				: `mapped to "${mapped.mode}"`,
		);
		return;
	}
	items.push({
		source: "t3-code",
		from,
		to: "—",
		action: "skip",
		detail:
			mode === "auto"
				? '"auto" is a classifier that approves the calls it judges routine, and no mode here does that: "ask" puts a ' +
					'person in the loop instead of a classifier and "agent" runs everything instead of judging. Either would change ' +
					"the posture the mode names, so the session keeps whatever it would otherwise start in"
				: "not a mode t3 code defines, so it never decided a session — the permission mode is left as it is",
		containsSecret: false,
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** Which of T3's two model keys is claimed, and what is said about the other. */
function planT3Model(file: string, settings: T3Settings, items: MigrationItem[], claimScalar: ClaimScalar): void {
	const hasDefault = settings.modelSelection !== null;
	const key = hasDefault ? "defaultModelSelection" : "textGenerationModelSelection";
	const primary = hasDefault ? settings.modelSelection : settings.textModelSelection;
	if (!primary) return;

	const reference = resolveModelReference(primary.model);
	if (reference === undefined) {
		items.push({
			source: "t3-code",
			from: `${file} → ${key}.model ("${primary.model}")`,
			to: "—",
			action: "skip",
			detail:
				`${key} names a model by an id from t3 code's own provider registry (routed through the ` +
				`${primary.instanceId === "" ? "unnamed instance" : `"${primary.instanceId}" instance`}` +
				`${primary.fromLegacyProvider ? ", named by the pre-split 'provider' field" : ""}), and no model this build ` +
				"carries goes by that name. T3 Code's model list is its own — the picker is a list of providers it launches, not " +
				"a registry this build shares — so there is no equivalent name to map it to",
			containsSecret: false,
		});
	} else {
		claimScalar(
			"t3-code",
			"model",
			reference,
			`${file} → ${key}.model ("${primary.model}")`,
			`t3 code's id for this model is "${primary.model}", which goes by the same name in this build's registry; it ` +
				`${primary.fromLegacyProvider ? "named the routing instance by the pre-split provider field" : "routed through"} ` +
				`"${primary.instanceId}", which is not carried — an instance is a t3 code concept and nothing here resolves one`,
		);
	}

	// The key that did not win is named whether or not it resolves, so a user who
	// set both is never left wondering where the second one went.
	if (hasDefault && settings.textModelSelection !== null) {
		const text = settings.textModelSelection;
		items.push({
			source: "t3-code",
			from: `${file} → textGenerationModelSelection.model ("${text.model}")`,
			to: "—",
			action: "skip",
			detail:
				"t3 code can send text turns to a different model than everything else; this build has one `model` setting, and " +
				"the default was the one imported — set the text one by hand if you want it",
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** `defaultTheme`, mapped only when the id is one of this build's themes. */
function planT3Theme(file: string, settings: T3Settings, items: MigrationItem[], claimScalar: ClaimScalar): void {
	const theme = settings.theme;
	if (!theme) return;
	const from = `${file} → defaultTheme ("${theme}")`;
	if (BUILT_IN_THEME_NAMES.includes(theme)) {
		claimScalar("t3-code", "theme", theme, from, "mapped to the built-in theme of the same name");
		return;
	}
	items.push({
		source: "t3-code",
		from,
		to: "—",
		action: "skip",
		detail:
			`"${theme}" names a theme t3 code owns — it ships t3-chat, grove, ocean, ember and iris, plus any you published ` +
			`yourself — and this build's themes are ${summarizeNames([...BUILT_IN_THEME_NAMES], 8)}. Neither list holds the ` +
			"other's names, so there is no equivalent to map it to; pick one with /theme",
		containsSecret: false,
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** The provider instances' environment, global here and scoped there. */
function planT3Environment(file: string, settings: T3Settings, items: MigrationItem[], claimEnv: ClaimEnv): void {
	if (settings.environment.length === 0) return;

	const byName = new Map<string, T3Settings["environment"]>();
	for (const entry of settings.environment) {
		byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
	}

	for (const [name, entries] of byName) {
		const values = new Set(entries.map((entry) => entry.value));
		const instances = [...new Set(entries.map((entry) => entry.instanceId))];
		const where =
			instances.length > 1
				? `${instances.map((id) => `"${id}"`).join(", ")} → environment`
				: `${file} → providerInstances.${instances[0] ?? "?"}.environment`;
		if (values.size > 1) {
			items.push({
				source: "t3-code",
				from: `${where}.${name}`,
				to: "—",
				action: "skip",
				detail:
					`${instances.length} provider instance(s) set ${name} to ${values.size} different values, and this build's ` +
					"settings hold one value per variable — copying either would silently drop the other. Set it by hand if the " +
					"two were meant to differ",
				containsSecret: false,
			});
			continue;
		}
		claimEnv(
			"t3-code",
			name,
			entries[0].value,
			`${where}.${name}`,
			"downgrade",
			instances.length > 1
				? `copied verbatim; ${instances.length} provider instances set ${name} to the same value, so nothing was lost by making it global`
				: `copied verbatim, but t3 code scoped it to the "${instances[0] ?? "?"}" provider instance and this build applies settings.env to every tool call`,
		);
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The per-project model overrides, counted and not carried. */
function planT3ProjectOverrides(file: string, settings: T3Settings, items: MigrationItem[]): void {
	const overrides = settings.projectOverrides;
	if (overrides.length === 0) return;
	items.push({
		source: "t3-code",
		from: `${file} → projectSettingsOverrides`,
		to: "—",
		action: "skip",
		detail:
			`${overrides.length} project(s) override the model, and this build has no per-project model setting to put one ` +
			`in: a t3 code project id is a key in its own database, not a directory, so ${overrides.length === 1 ? "it" : "they"} ` +
			`could not be resolved to ${overrides.length === 1 ? "a path" : "paths"} even with one. Projects: ${summarizeNames(overrides)}`,
		containsSecret: false,
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** The two settings files T3 writes beside the one this importer reads. */
function planT3OtherSettingsFiles(raw: RawT3Code, home: string, items: MigrationItem[]): void {
	const stateDir = raw.stateDir;
	if (stateDir === null) return;
	const documents: Array<{ name: string; keys: string[] }> = [
		{ name: "client-settings.json", keys: Object.keys(raw.clientSettings ?? {}).sort() },
		{ name: "desktop-settings.json", keys: Object.keys(raw.desktopSettings ?? {}).sort() },
	];
	for (const document of documents) {
		if (document.keys.length === 0) continue;
		items.push({
			source: "t3-code",
			from: tildePath(home, join(stateDir, document.name)),
			to: "—",
			action: "skip",
			detail:
				`${document.keys.length} key(s) — ${summarizeNames(document.keys, 8)} — and every one is a preference of t3 code's ` +
				"own clients: notifications, diff colours, chat width, panel animation, the in-app browser, the window, the update " +
				"channel, Tailscale serving, how far the machine is exposed, and the WSL backend. This build is a terminal " +
				"application with no client surface and no update channel of its own, so none of them has an equivalent",
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The rest of `settings.json`, accounted for by name. */
function planT3UnhandledSettings(file: string, raw: RawT3Code, items: MigrationItem[]): void {
	if (raw.settingsKeys.length === 0) return;
	reportUnhandledKeys(
		"t3-code",
		Object.fromEntries(raw.settingsKeys.map((key) => [key, true])),
		T3_SETTINGS_HANDLED,
		file,
		items,
	);
}

// Long-form design notes: docs/dev/migration-sources.md
/** What the reader saw and passed over, replayed as report lines. */
function planT3Skipped(raw: RawT3Code, items: MigrationItem[]): void {
	for (const entry of raw.skipped) {
		items.push({
			source: "t3-code",
			from: entry.name,
			to: "—",
			action: "skip",
			detail: entry.reason,
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Assemble the plan. */
export function planT3Code(
	raw: RawT3Code,
	home: string,
	items: MigrationItem[],
	claimEnv: ClaimEnv,
	claimScalar: ClaimScalar,
	claimModePair: ClaimModePair,
): void {
	// A readable `settings` is what every mapper below needs, and it is null
	// exactly when there was no state directory or no settings document — in which
	// case `skipped` already says why and an empty mapping table would say it
	// twice. The other two settings files are still named: they can be present
	// when `settings.json` is not.
	if (raw.settings !== null && raw.stateDir !== null) {
		const file = tildePath(home, t3SettingsPath(raw.stateDir));
		planT3RuntimeMode(file, raw.settings, items, claimModePair);
		planT3Model(file, raw.settings, items, claimScalar);
		planT3Theme(file, raw.settings, items, claimScalar);
		planT3Environment(file, raw.settings, items, claimEnv);
		planT3ProjectOverrides(file, raw.settings, items);
		planT3UnhandledSettings(file, raw, items);
	}
	planT3OtherSettingsFiles(raw, home, items);
	planT3Skipped(raw, items);
}
