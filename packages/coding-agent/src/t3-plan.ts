/**
 * T3 Code's configuration in the target's shape: the permission posture, the
 * model, the provider environment, and everything this importer found and will
 * not carry.
 *
 * **T3 Code has no credentials on disk to migrate, and saying so is part of the
 * mapping rather than a footnote to it.** Two independent facts make that true
 * and they are worth separating, because one of them is the reason the report can
 * promise a migration will not need re-auth and the other is the reason a model
 * reference cannot come across at all:
 *
 *  1. **The values are not in `settings.json`.** A provider instance's
 *     `sensitive` environment entry is written as the six-dot marker
 *     `SECRET_REDACTED` (`apps/server/src/serverSettings.ts:147`, applied by
 *     `redactSecret` at `:159`) and the real value lives in the secret store
 *     under `<stateDir>/secrets` (`apps/server/src/config.ts:163`), swapped back
 *     in on every read of the settings
 *     (`materializeProviderEnvironmentSecrets` at `serverSettings.ts:699`).
 *     This importer never opens that directory. Writing the marker into
 *     `settings.json` here would produce an environment variable that looks
 *     configured and silently fails — so those entries are skipped with a
 *     reason, by name only.
 *  2. **The routing key does not port.** A `ModelSelection` names an *instance
 *     id* (`packages/contracts/src/orchestration.ts:75-79`), which resolves
 *     inside T3's own provider registry. Nothing in that registry exists here, so
 *     a model that happens to share a name with one of ours is a coincidence
 *     rather than a match — see {@link planT3Model}.
 *
 * **Two absences are stated here rather than left for the user to discover.**
 * T3 Code persists no rule files, no skills, no subagent registry and no MCP
 * server list: a provider instance's `config` blob is `Schema.Unknown` by design
 * (`packages/contracts/src/providerInstance.ts:104-110` — each driver registers
 * its own decoder with the runtime registry), so an MCP configuration configured
 * inside T3 lives in a blob this importer does not parse and would not be in a
 * shape the target could use even if it were. The report says T3 has none *on
 * disk this importer can read*, which is the true and weaker claim — T3 can
 * absolutely talk to MCP servers, it just does not keep the list where a
 * migration could pick it up. And its conversations live in a projection
 * database this importer reads on the two-phase schedule every source uses:
 * candidates listed cheaply, messages read only for the sessions actually chosen
 * (see `migrate-history.ts`).
 */

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

/**
 * `defaultRuntimeMode` → this build's two mode axes.
 *
 * T3's own words for the four, from the labels its composer renders
 * (`apps/web/src/components/chat/runtimeModeConfig.ts:8-28`), because a mode name
 * read cold is exactly the kind of string that maps to the wrong thing:
 *
 * | T3 | label | description |
 * | --- | --- | --- |
 * | `approval-required` | Supervised | Ask before commands and file changes. |
 * | `auto-accept-edits` | Auto-accept edits | Auto-approve edits, ask before other actions. |
 * | `auto` | Auto | Supported providers approve routine actions; others still ask. |
 * | `full-access` | Full access | Allow commands and edits without prompts. |
 *
 * Three map and one deliberately does not.
 *
 * **`auto-accept-edits` maps to `ask`, which is narrower than it says.** This
 * build has no "edits run, everything else asks" mode, and an import that
 * silently widened writes to unasked would be the worse of the two errors. It is
 * the same call `CLAUDE_PERMISSION_MODES` makes for Claude Code's `acceptEdits`
 * and `MINIMAX_PERMISSION_MODES` makes for MiniMax's, and the report line says so
 * in those words rather than calling it a rename.
 *
 * **`auto` is absent.** It means a classifier decides, and the nearest mode here
 * (`ask`) means the opposite — a human decides — so carrying it over under another
 * name would be a lie about what the session will do. The same call the Claude
 * Code and Kimi Code mappers make for their identically-named mode.
 *
 * **`full-access` is the one row that maps to the unconfined sandbox**, and for
 * the same reason it is `bypassPermissions`' row in Claude's table: the single
 * value is doing two jobs — never ask *and* no confinement — so claiming only the
 * mode half would leave the sandbox at whatever another source decided.
 *
 * Exported for the row count, not for the values: a row added here without a line
 * in the mapper test's table is an import whose claim nobody has checked.
 */
export const T3_RUNTIME_MODES: Record<string, { mode: PermissionMode; sandbox: SandboxMode } | undefined> = {
	"approval-required": { mode: "ask", sandbox: "workspace-write" },
	"auto-accept-edits": { mode: "ask", sandbox: "workspace-write" },
	auto: undefined,
	"full-access": { mode: "agent", sandbox: "danger-full-access" },
};

/**
 * Keys of `settings.json` this mapper accounts for.
 *
 * The rest are named by one closing aggregate rather than one line each, and the
 * two lists have to be read together: a key added here without a mapper behind it
 * is a setting that vanishes with no report line, which is the failure this
 * aggregate exists to make visible.
 */
const T3_SETTINGS_HANDLED = new Set([
	"defaultRuntimeMode",
	"defaultModelSelection",
	"textGenerationModelSelection",
	"defaultTheme",
	"providerInstances",
	"providers",
	"projectSettingsOverrides",
]);

/**
 * The permission posture, and only when the file states one.
 *
 * **An absent `defaultRuntimeMode` is T3's own default, which is `full-access`**
 * (`DEFAULT_RUNTIME_MODE`, `packages/contracts/src/orchestration.ts:135`;
 * `packages/contracts/src/settings.test.ts:82` decodes an empty document to it).
 * T3's writer strips defaults before persisting (`stripDefaultServerSettings`,
 * `apps/server/src/serverSettings.ts:387-419`, called at `:550`), so a user who
 * never touched the setting has no `defaultRuntimeMode` in their file at all.
 *
 * That is the whole argument for claiming only when present, and it is worth
 * spelling out because the alternative looks more faithful. Importing the default
 * would mean writing `agent` + `danger-full-access` — no prompts, no confinement —
 * for a user whose file said nothing, on the grounds that the source's schema
 * would have supplied it. **Failing open on a security posture is the one
 * direction a settings import must not move in.** Omitting it leaves the session
 * at this build's own default, which is the stricter of the two, and the report
 * says what was left alone rather than reporting a mode nobody chose.
 *
 * So a present key means the user — or a build whose default differed — actually
 * said something, and it is claimed. The `full-access` row above is not dead for
 * that reason: it is reachable from a hand-edited file, and from any T3 build
 * older than the one whose default it is.
 *
 * **The absence arrives as `""`, not `null`** — see {@link T3Settings} — and the
 * guard below is `if (!mode)` rather than `if (mode === null)` for that reason.
 * Writing it as `settings.runtimeMode ?? "full-access"` instead would look like
 * the same fail-open behaviour and would not be: `??` does not fire on an empty
 * string, so the branch meant to widen a file that said nothing would be dead
 * code while reading exactly like a deliberate choice. The type is a `string` to
 * keep that mistake from compiling.
 */
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

/**
 * Which of T3's two model keys is claimed, and what is said about the other.
 *
 * T3 keeps two because it routes different turns to different models
 * (`defaultModelSelection` and `textGenerationModelSelection`,
 * `packages/contracts/src/settings.ts:1145` and `:1244`). This build has one
 * `model`, so exactly one of the two can be claimed and the choice has to be
 * stated rather than settled by write order.
 *
 * The default wins, for two reasons that point the same way. It is the setting a
 * user reaches for first and the one a migration report line is expected to
 * carry; and the text selection is, in a stock install, the schema's own decoding
 * default rather than something the user wrote (`settings.ts:1244` supplies
 * `{ instanceId: "codex", model: DEFAULT_TEXT_GENERATION_MODEL, … }`), so
 * preferring it would frequently import a model nobody chose over one they did.
 */
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

/**
 * `defaultTheme`.
 *
 * **T3 stores a theme id, not a palette, and none of its ids is a theme name
 * here.** The five it ships are `t3-chat`, `grove`, `ocean`, `ember` and `iris`
 * (`packages/shared/src/themePalettes.ts:1`), plus whatever a user has published;
 * this build's eight are `dark`, `light`, `high-contrast-dark`,
 * `high-contrast-light`, `deuteranopia-dark`, `tritanopia-dark`, `spiderman` and
 * `splatoon` (`packages/tui/src/themes/`). The sets do not intersect, and the two
 * ids that *would* — `light` and `dark` — are structurally excluded from being a
 * T3 theme id at all: `EnvironmentThemeId` rejects them by pattern, because a
 * published `dark.json` would otherwise capture every client whose stored
 * preference is the stock `"dark"` (`packages/contracts/src/server.ts:510-512`),
 * and `t3 theme set` refuses them again through `UNPUBLISHABLE_THEME_IDS`
 * (`apps/server/src/cli/theme.ts:337`).
 *
 * So this is a membership check that in practice never passes, and the branch is
 * kept anyway: the file is decoded leniently and outlives the build that wrote it,
 * so a hand-written or legacy value can hold anything, and a check that is
 * *expected* to fail is still the correct thing to write rather than a skip.
 */
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

/**
 * The provider instances' environment.
 *
 * **Every entry here is scoped to one provider instance in T3 and becomes global
 * here**, which is why each line is a `downgrade` rather than a copy. In T3 these
 * variables are injected into the process that talks to one provider
 * (`packages/contracts/src/providerInstance.ts:104-110`); a target `settings.env`
 * is applied to every tool call, Bash included. Importing an
 * `ANTHROPIC_BASE_URL` meant for one provider and letting it reach a shell is a
 * widening of scope the user did not ask for, and it is scored as one.
 *
 * **Two instances that disagree about one name are not merged.** The target holds
 * one value per variable, so choosing one would silently discard the other while
 * the report line for the discarded one still said it was imported. Instead the
 * name is skipped with both instances named, which is the only outcome that leaves
 * the user able to fix it by hand.
 *
 * The same name from two instances carrying the *same* value is not a conflict —
 * there is nothing to choose — so it is claimed once, naming both.
 */
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

/**
 * The per-project model overrides, named and not carried.
 *
 * T3 keeps a `projectSettingsOverrides` entry per project
 * (`packages/contracts/src/settings.ts:1157`, a `Record<ProjectId,
 * ProjectSettingsOverrides>`) and this build has no per-project setting to put one
 * in. The second half of the reason is the one that matters: a T3 project id is
 * an opaque record key, not a path, so there is nothing here that could turn it
 * back into the directory it stands for. Carrying the *count* is what tells a
 * user with twelve overrides that twelve decisions went missing — the difference
 * between a migration that is incomplete and one that claims to have finished.
 */
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

/**
 * The two settings files T3 writes beside the one this importer reads.
 *
 * Neither is imported, and the reason is the same for both and is a fact rather
 * than a shrug: every key in each is a presentation or a host concern. T3 Code is
 * a GUI with a web, a desktop and a mobile client, so most of its settings
 * describe how *that* looks and where *that* runs — and this build is a terminal
 * application with a host, not a client surface, so there is no setting in either
 * file that has an equivalent to be lost in.
 *
 *  - `client-settings.json` is `ClientSettingsSchema`
 *    (`packages/contracts/src/settings.ts:298-340`): notifications, diff colours,
 *    chat width, panel animation, and the in-app browser's viewport, zoom,
 *    appearance and recording options.
 *  - `desktop-settings.json` is `DesktopSettingsDocument`
 *    (`apps/desktop/src/settings/DesktopAppSettings.ts:98-116`): window geometry,
 *    the update channel, Tailscale serving, how far the machine is exposed, and
 *    the WSL backend.
 *
 * The keys each file actually holds are named in the report, so the paragraph
 * above can be checked against the user's own file rather than taken on trust — a
 * settings file that is silently not migrated is a worse experience than one the
 * report explains.
 */
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

/**
 * The rest of `settings.json`, accounted for by name.
 *
 * The container is rebuilt from the key list rather than carried whole: the
 * reader hands over the keys so this can name what it did not handle, and keeping
 * the parsed document as well would be a second copy of the same thing for no
 * reader.
 */
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

/**
 * What the reader saw and passed over, replayed as report lines.
 *
 * These are the entries the reading phase could not turn into anything: a file
 * that was not there, a document that was not JSON, a provider environment value
 * T3 keeps in its `secrets/` directory. Each carries **a name, never a value** —
 * the sensitive-entry path in particular records the *variable's* name and stops
 * there, because a report is something a user may paste into an issue.
 */
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

/**
 * Assemble the plan.
 *
 * The signature carries no `mcpServers`, no `existing`, no `existingMcpServers`
 * and no `force`, and each absence is load-bearing rather than an oversight — see
 * the header for why T3's MCP configuration is not readable from disk, and why
 * there is no per-project model setting to collide with. Taking parameters this
 * source has no use for would read as a gap a later change might fill by
 * accident; leaving them out makes the absence the type system's problem.
 */
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
