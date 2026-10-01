/**
 * Antigravity's user state in the target's shape: the one setting that maps, the
 * MCP servers, the skills and the workflows, the standing instructions, and
 * everything the reader saw and this importer will not carry.
 *
 * **Only the theme is mapped, and the other two settings a reader would expect
 * to find here are absent for reasons worth stating separately.**
 *
 * `~/.gemini/config/config.json` is a protojson document whose top level holds a
 * single nested object, `userSettings`. That is established rather than inferred:
 * the launcher reads `config?.userSettings?.themeMode` out of it
 * (`asar-out/dist/utils.js:71`), and the message behind that object is
 * `jetbox_state_pb.UserSettings` — the only `GetThemeMode` accessor in
 * `language_server.exe` belongs to it. So every `Get*` accessor the binary
 * carries for `jetbox_state_pb.UserSettings` is a real key under `userSettings`,
 * and there are 44 of them.
 *
 *  1. **The permission posture is in that file, and this importer still claims
 *     nothing from it.** `jetbox_state_go_proto.(*UserSettings).GetPermissionPreset`
 *     is one of the 44, and its enum `exa.codeium_common_pb.AgentPermissionPreset`
 *     is fully enumerated — each of `AGENT_PERMISSION_PRESET_UNSPECIFIED`,
 *     `_REQUEST_REVIEW`, `_DEFAULT`, `_VETTED`, `_TURBO`, `_AUTO` and `_NONE` is
 *     an exact literal in the binary, once each. What is missing is any
 *     statement of what they *do*. There is no label, no description and no
 *     documentation for any of the seven anywhere in `language_server.exe`: the
 *     phrase "Request Review" occurs zero times, and the words "Turbo" and
 *     "Vetted" that do occur belong to `google.internal.cloud.code.v1internal.
 *     TurboModeSetting` and `exa.project_pb.SecurityPluginSettings.Vetted`,
 *     neither of which is this enum. Seven names with no behaviour attached
 *     cannot honestly be turned into this build's three permission modes, and the
 *     direction a wrong guess would most likely take — reading `TURBO` as
 *     "runs without asking" — is the one direction a permission import must not
 *     move in. So the value is named in the report and nothing is claimed.
 *
 *  2. **There is no user-level sandbox setting to pair it with, which is why the
 *     pair is claimed per field rather than through `claimModePair`.** `UserSettings`
 *     has no `GetSandboxMode`. A `sandboxMode` is read one of exactly two ways:
 *     `settings.(*CliSettingsStore|IdeSettingsStore|JetskiHubSettingsStore).
 *     GetSandboxModeForProject` — **per project**, from a project file, which is
 *     the failure it logs ("failed to read project file for %s in GetSandboxConfig:
 *     %v") — or `google.cloud.businessaicode.v1beta.AdminControls.AgentControls`,
 *     which is the administrator's control plane and not a setting the user chose.
 *     `claimModePair` exists precisely so a single foreign value cannot set one
 *     axis and leave the other looking deliberate; feeding it `permissionPreset`
 *     would have written a sandbox Antigravity never stated. The keys beside it
 *     in `UserSettings` — `enableTerminalSandbox`, `sandboxAllowNetwork`,
 *     `sandboxProxy`, `internetAccessPolicy`, `nonWorkspaceFileAccessPolicy` —
 *     are named by {@link planAntigravityConfigKeys} and mapped to nothing, for
 *     the same reason: a family of keys is not one decision, and which of them
 *     corresponds to which of this build's two sandbox values is not written
 *     down anywhere either.
 *
 *  3. **The settings document names no model.** None of the 44 accessors is a
 *     model. The model lists `language_server.exe` does carry are the server's own
 *     catalogue — `GetCascadeModelConfigsRequest/Response` and
 *     `GetCommandModelConfigsRequest/Response` are RPC shapes, and
 *     `custom_models_config` is a field of messages other than `UserSettings` —
 *     so there is no user-chosen model in this file to resolve against this
 *     build's registry, and none is claimed.
 *
 * **There is no credential anywhere in this source.** Antigravity keeps its OAuth
 * tokens in the OS credential store, `antigravity-read.ts` says so at length, and
 * the only credential-shaped keys here arrive already removed from the parsed
 * document and named in `skipped`. The one place a secret can still reach a
 * written file is an MCP server's `env`, and it goes through the same marking hook
 * every other source uses.
 */

import { join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	antigravityConversationsDir,
	antigravityGeminiRoot,
	antigravityGlobalWorkflowsDir,
	antigravityWorkflowsDir,
} from "./antigravity-home.ts";
import type { RawAntigravity } from "./antigravity-read.ts";
import {
	collectFileWrites,
	isRecord,
	placeholderNote,
	planMemoryAsRule,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
} from "./migrate-core.ts";
import {
	type ClaimScalar,
	looksLikeSecretName,
	type MigrationItem,
	type MigrationSourceId,
	type PlannedWrite,
	type RawFile,
} from "./migrate-types.ts";

// ---------------------------------------------------------------------------
// Antigravity
// ---------------------------------------------------------------------------

/**
 * This source's id, spelled once.
 *
 * The union and every table keyed by it are already in place:
 * `MigrationSourceId` (`migrate-types.ts:33-48`), `MIGRATION_SOURCE_IDS` (`:69`),
 * `MIGRATION_SOURCE_LABELS` (`:87`), `SOURCE_ROOTS` (`:135`) and the
 * `detectionRoots` arm that points `detectSources` at the two data roots and the
 * customization root (`:287`). So this is a plain literal with no cast, and the
 * only thing it buys is one spelling rather than eleven.
 *
 * **The call lives in `migrate.ts`, and it is one line of plumbing.** This entry
 * point takes the same arguments its neighbours do precisely so that wiring it
 * beside `planTrae`/`planStepCode` is a copy rather than a design — and it is
 * worth saying that a source can be fully registered (id, label, `SOURCE_ROOTS`,
 * `detectionRoots`, a reader and a planner) and still import nothing, because
 * nothing calls the planner. `detectSources` would find `~/.gemini`, the report
 * would list Antigravity, and no settings, server, skill or rule from it would
 * reach the target. `migrate.ts:900` is that call; `migrate-antigravity-plan
 * .test.ts` calls this function directly and cannot see whether it is wired, so
 * the wiring has its own coverage in `migrate-antigravity.test.ts`.
 */
const SOURCE: MigrationSourceId = "antigravity";

/**
 * Top-level keys of `config.json` this mapper accounts for.
 *
 * Read as the *whole* list, and read against the reader's header rather than
 * against this file's convenience: everything else in the document is named by
 * {@link planAntigravityConfigKeys} with no claim attached, which is the only
 * honest way to report a settings file whose schema this importer has read the
 * *names* of but not the meanings of. The product's own customization guide
 * enumerates the customization surface as Rules, Skills, Plugins, Hooks and MCP
 * Servers, and names no setting beyond those.
 */
const ANTIGRAVITY_CONFIG_HANDLED = new Set(["userSettings"]);

/**
 * Keys of `userSettings` this mapper accounts for — one mapped, one named.
 *
 * `themeMode` is mapped because the launcher's own resolution of it is four lines
 * of `String.prototype.includes` and a `nativeTheme` lookup, reproduced in the
 * reader and consumed below. `permissionPreset` is listed because it *is*
 * accounted for: it gets a line of its own saying what it is and why it is not
 * carried, which is not what {@link reportUnhandledKeys} would say about it. A
 * key that earns its own sentence does not also belong in the catch-all.
 */
const ANTIGRAVITY_USER_SETTINGS_HANDLED = new Set(["themeMode", "permissionPreset"]);

/**
 * The keys Antigravity's own MCP documentation gives for one server.
 *
 * `language_server.exe` carries exactly one documentation block headed
 * "# MCP Servers (`mcp_config.json`)", and its schema section is explicit:
 *
 * > ### 1. Stdio Transport (Local)
 * > - **`command`** (string, required): The executable to run
 * > - **`args`** (array of strings, optional)
 * > - **`env`** (object, optional)
 * > ### 2. SSE Transport (Remote)
 * > - **`serverUrl`** (string, required)
 *
 * with the example document above it carrying both under one `mcpServers`. There
 * is no `cwd`, no `headers` and no `type` discriminator in it, so none is written;
 * a key outside this set is named as a downgrade rather than silently dropped,
 * because a hand-written server entry is exactly where an undocumented key turns
 * up.
 */
const ANTIGRAVITY_MCP_KEYS = new Set(["command", "args", "env", "serverUrl"]);

/**
 * The permission posture, named and not carried.
 *
 * The whole of what either binary says about the value is its seven enum names —
 * see the header for the counts and for the two look-alike words that are not
 * this enum — so there is no established mapping onto this build's three
 * permission modes and none is invented. Reporting it by name rather than staying
 * silent is the point: a user who set `TURBO` can see that Antigravity held it
 * and that this importer declined it, which is different from a report that never
 * mentions the file's most consequential setting.
 *
 * The value is echoed verbatim rather than resolved to a name, because the
 * document is protojson and this importer has established that the *field* is
 * there, not how a particular build marshalled the enum inside it.
 */
function planAntigravityPermissionPreset(raw: RawAntigravity, items: MigrationItem[]): void {
	const settings = raw.config === null ? null : raw.config.userSettings;
	if (!isRecord(settings)) return;
	const value = settings.permissionPreset;
	if (value === undefined || value === null) return;
	const shown = typeof value === "string" ? value : JSON.stringify(value);
	items.push({
		source: SOURCE,
		from: `${tildePath(raw.home, raw.configPath)} → userSettings.permissionPreset (${shown})`,
		to: "—",
		action: "skip",
		detail:
			"Antigravity's agent permission preset, one of AGENT_PERMISSION_PRESET_{UNSPECIFIED, REQUEST_REVIEW, DEFAULT, " +
			"VETTED, TURBO, AUTO, NONE} — seven enum names, each an exact literal in the language server, and not one line of " +
			"documentation anywhere in either binary saying what it admits. This build has three permission modes, and deciding " +
			"that TURBO means one of them would be a guess in the one direction a permission setting must not be guessed in: " +
			'reading it as "runs without asking". Set the posture yourself with /mode',
		containsSecret: false,
	});
}

/**
 * `userSettings.themeMode` → this build's `theme`.
 *
 * **The planner consumes the reader's resolution rather than repeating it.**
 * `antigravity-read.ts` has already applied the launcher's two tests in the
 * launcher's order, both with `String.prototype.includes` rather than `===`
 * (`asar-out/dist/utils.js:71-76`), and the order matters: `INHERIT` is tested
 * first, so a value naming both is inherited rather than light. Re-deriving any of
 * it here would be a second copy of a four-line function that could drift from the
 * one the reader runs, and the drift would be invisible.
 *
 * **Three cases, and the third is why a home that states nothing gets no line.**
 *
 *   - `inheritsOsTheme` — **a reason to report, not a theme to write.**
 *     `nativeTheme.shouldUseDarkColors` (`utils.js:73`) is a property of the
 *     operating system on the machine Antigravity ran on. Resolving it here would
 *     resolve it against whichever machine runs the import, which is a different
 *     answer wearing the same name. This build's nearest relative is the `auto`
 *     theme, and that is a *different* resolver — the terminal's own background
 *     rather than the desktop's — so claiming it would quietly substitute one
 *     question for another. Named, and left to `/theme`.
 *   - otherwise, with a value stated — claimed. The launcher's fall-through is
 *     `DARK` (`utils.js:76`) for every value that is neither, so a `themeMode` of
 *     `SYSTEM` or `HIGH_CONTRAST` is a *dark* theme to Antigravity and mapping it
 *     to `dark` reproduces what the user was actually looking at.
 *   - no value stated — nothing claimed and nothing said. `AntigravityTheme`
 *     reports `declared: null` for a document that states no theme, for one that
 *     could not be parsed, and for one whose `themeMode` is not a string; the app
 *     lands on `DARK` for all three, and for the third it does so through a
 *     `catch` on a `TypeError` from `(1).includes` (`utils.js:80-83`). Importing
 *     that fall-through as though the user had chosen it would put a value in the
 *     target's settings that nobody picked — and `claimScalar` would have written
 *     it over a theme this build already had. The same call `planT3RuntimeMode`
 *     makes for an absent `defaultRuntimeMode`, and for a non-security setting.
 */
function planAntigravityTheme(raw: RawAntigravity, items: MigrationItem[], claimScalar: ClaimScalar): void {
	const theme = raw.theme;
	const from = `${tildePath(raw.home, raw.configPath)} → userSettings.themeMode (${theme.declared ?? "not stated"})`;
	if (theme.inheritsOsTheme) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				"the value contains INHERIT, which the launcher tests before anything else (asar-out/dist/utils.js:72), so the " +
				"app was following the operating system's own light/dark preference on the machine it ran on. That is a fact " +
				"about that machine rather than a preference that travels, and resolving it here would resolve it against " +
				"whichever machine runs this import — /theme picks one for this build",
			containsSecret: false,
		});
		return;
	}
	if (theme.declared === null) return;
	const mapped = theme.light ? "light" : "dark";
	claimScalar(
		SOURCE,
		"theme",
		mapped,
		from,
		`mapped to the built-in theme "${mapped}": Antigravity resolves any value containing LIGHT to its light theme and ` +
			"everything else to its dark one (asar-out/dist/utils.js:75-76), and INHERIT was tested first and did not match. " +
			`"${mapped}" is one of this build's eight built-in themes, so the name is the same on both sides`,
	);
}

/**
 * Everything in `config.json` this mapper did not map, named at both levels.
 *
 * Two passes because the document is two levels deep: the top level, and the
 * `userSettings` object whose 44 fields are the settings proper. {@link
 * reportUnhandledKeys} prints names and never values, so this is safe to run over
 * a document that was only scrubbed for *credential-shaped* keys.
 *
 * This is the line that accounts for the whole of the posture discussion above.
 * Whatever an Antigravity install actually writes into that file — a
 * `globalPermissionGrants` record, an `allowedCommands` list, a
 * `conversationWidth`, a `gcpRegion` — arrives here as a name with the sentence
 * "this importer has no mapping for and no note about", which is the true
 * statement. It is also the reason no bespoke line is written for the sandbox
 * family: naming five keys individually would assert what each does, and the
 * honest sentence is the one that says nothing is known about any of them.
 */
function planAntigravityConfigKeys(raw: RawAntigravity, items: MigrationItem[]): void {
	if (raw.config === null) return;
	const file = tildePath(raw.home, raw.configPath);
	reportUnhandledKeys(SOURCE, raw.config, ANTIGRAVITY_CONFIG_HANDLED, file, items);
	const settings = raw.config.userSettings;
	if (!isRecord(settings)) return;
	reportUnhandledKeys(SOURCE, settings, ANTIGRAVITY_USER_SETTINGS_HANDLED, `${file} → userSettings`, items);
}

/**
 * One `mcp_config.json` server → this build's server shape.
 *
 * The transport is Antigravity's to decide and it is unambiguous in the product's
 * own documentation: a `command` means stdio, a `serverUrl` means a remote server,
 * and a server carrying neither is nothing Antigravity would have connected
 * either. Which is why the two shapes are rebuilt rather than filtered — a config
 * carrying both a `command` and a `serverUrl` is a stdio server here, because that
 * is the reading that leaves a usable definition rather than one half of each.
 *
 * **A malformed entry inside a server is dropped, and the server is not.** The
 * reader hands server objects over uninterpreted and the Go map's value type is
 * `jsontext.Value`, so any JSON is legal where the product is concerned — while
 * this build's schema wants `args` and `env` to hold strings, because they are
 * argv and an environment block. Losing a working server because one variable was
 * written as a number would be a worse outcome than losing the variable, so
 * non-string entries are dropped and counted. **No value is ever printed**, only
 * how many were dropped and whether any variable *name* looks like a credential.
 */
function planAntigravityMcp(
	raw: RawAntigravity,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	for (const [name, entry] of Object.entries(raw.mcpServers)) {
		// The reader recorded which document answered for this name, already
		// rendered the way the report renders paths, so provenance costs nothing to
		// print and is the difference between "this server was imported" and "this
		// server was imported from the file the product documents".
		const file = raw.mcpSources[name] ?? tildePath(raw.home, raw.mcpConfigPaths[0]);
		const from = `${file} → mcpServers.${name}`;
		if (!isRecord(entry)) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: "not a server table",
				containsSecret: false,
			});
			continue;
		}

		const command = typeof entry.command === "string" ? entry.command.trim() : "";
		const serverUrl = typeof entry.serverUrl === "string" ? entry.serverUrl.trim() : "";
		if (command === "" && serverUrl === "") {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"it names neither a command nor a serverUrl, which are the two transports Antigravity documents for a " +
					"server here — nothing was serving it over there either",
				containsSecret: false,
			});
			continue;
		}

		const downgrades: string[] = [];
		const config: Record<string, unknown> = {};
		if (command !== "") {
			const args = Array.isArray(entry.args) ? entry.args : [];
			const strings = args.filter((arg): arg is string => typeof arg === "string");
			if (strings.length !== args.length) {
				downgrades.push(`${args.length - strings.length} argument(s) that were not strings, dropped`);
			}
			config.type = "stdio";
			config.command = command;
			config.args = strings;
			if (isRecord(entry.env)) {
				// Names only ever leave this block; the values are copied and never
				// read back out, so a credential cannot reach the report by way of a
				// count or a name.
				const env: Record<string, string> = {};
				for (const [key, value] of Object.entries(entry.env)) {
					if (typeof value === "string") env[key] = value;
				}
				const dropped = Object.keys(entry.env).length - Object.keys(env).length;
				if (dropped > 0) downgrades.push(`${dropped} environment variable(s) whose value was not a string, dropped`);
				config.env = env;
			}
		} else {
			config.type = "http";
			config.url = serverUrl;
		}

		if (!McpServerConfigSchema.safeParse(config).success) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					command !== ""
						? "its command, arguments or environment are not a stdio server definition this build accepts"
						: "its serverUrl is not an address this build's MCP client accepts",
				containsSecret: false,
			});
			continue;
		}

		const extra = Object.keys(entry).filter((key) => !ANTIGRAVITY_MCP_KEYS.has(key));
		if (extra.length > 0) {
			downgrades.push(
				`left off ${summarizeNames(extra)} — not one of the four keys Antigravity's own documentation gives for a ` +
					"server (command, args, env, serverUrl)",
			);
		}
		const placeholder = placeholderNote(config);
		if (placeholder !== undefined) downgrades.push(placeholder);
		if (command !== "" && serverUrl !== "") {
			downgrades.push(
				"it names both a command and a serverUrl; the command was taken as the transport, since that is the reading " +
					"that leaves one usable server rather than half of each",
			);
		}

		if (name in existingMcpServers && !force) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: "target already defines a server with this name — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}

		const secret = Object.keys(isRecord(config.env) ? config.env : {}).some((key) => looksLikeSecretName(key));
		mcpServers[name] = config;
		markMcpSecret(secret);
		const copied = secret
			? "copied verbatim; its environment may hold a credential, and only the variable names were read"
			: "copied verbatim";
		items.push({
			source: SOURCE,
			from,
			to: `~/.labunbun/.mcp.json → mcpServers.${name}`,
			action: downgrades.length > 0 ? "downgrade" : "map",
			detail: downgrades.length > 0 ? `${copied} — ${downgrades.join("; ")}` : copied,
			containsSecret: secret,
		});
	}
}

/**
 * The same server name in two MCP documents, named once.
 *
 * The reader merged them in the priority order `antigravity-home.ts` sets out —
 * the documented global document first, the inferred per-data-root one second —
 * and kept the first. This says so, because "you have this server in two places
 * and only one was read" is a sentence the user is owed and the merge itself is
 * silent about it.
 */
function planAntigravityMcpCollisions(raw: RawAntigravity, items: MigrationItem[]): void {
	for (const collision of raw.mcpCollisions) {
		items.push({
			source: SOURCE,
			from: `mcpServers.${collision.name}`,
			to: "—",
			action: "skip",
			detail:
				`found in two MCP documents — kept the one from ${collision.kept}, and the entry in ${collision.dropped} was ` +
				"not read. Antigravity applies a global document and a per-data-root one in that order of authority, so the two " +
				"can name the same server differently",
			containsSecret: false,
		});
	}
}

/**
 * One standing-instructions document's rule-file name, extension dropped.
 *
 * `GEMINI.md` at the `.gemini` root and `GEMINI.md` in the customization
 * directory are both candidates (`antigravity-home.ts`), and they are two
 * different documents. Naming the rule file after the basename alone would give
 * them one name, and `planMemoryAsRule` guards only against a file already **on
 * disk** — during planning nothing is, so the second would queue a second write to
 * the first's path and both would report `map`. The write step would then leave
 * whichever came last, and the report would have claimed both arrived.
 *
 * So the path is folded into the name whenever the basename is not unique, and
 * only then: `config-gemini` beside `gemini`. A home holding one `GEMINI.md` gets
 * the short, readable name.
 */
function antigravityRuleName(home: string, document: RawFile, disambiguate: boolean): string {
	const stem = document.name.replace(/\.[^.]*$/, "").toLowerCase();
	if (!disambiguate) return stem;
	const root = `${tildePath(home, antigravityGeminiRoot(home))}/`;
	const label = tildePath(home, document.sourcePath);
	const under = label.startsWith(root) ? label.slice(root.length) : label;
	const folded = under
		.replace(/\.[^./]*$/, "")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
	return folded === "" ? stem : folded;
}

/**
 * Skills, the two deprecated workflow trees, and the standing instructions.
 *
 * **A workflow is written where Antigravity itself writes one.** The product's own
 * built-in `migrate-workflows` skill calls both trees deprecated "in favour of
 * skills/<name>/SKILL.md", renames the frontmatter to `name`/`description`, and
 * archives the original as `<name>.md.bak` — so a workflow markdown becoming a
 * skill directory is the vendor's mapping and not one chosen here. What is *not*
 * reproduced is the frontmatter rewrite, because this importer has no citation
 * for the keys an Antigravity workflow header uses, and inventing a
 * `name:`/`description:` pair over a header whose shape it cannot see would be a
 * mapping nobody wrote. The text is carried unchanged and the report says so — a
 * skill the model never finds is a worse outcome than a workflow left where it
 * was, so the sentence names the check the user has to make.
 *
 * A workflow and a skill answering to one name is reported rather than dropped;
 * the reader already decided which of the two to keep, and this only says which.
 */
function planAntigravityAssets(
	raw: RawAntigravity,
	home: string,
	force: boolean,
	items: MigrationItem[],
	writes: PlannedWrite[],
): void {
	collectFileWrites(
		SOURCE,
		raw.assets,
		(name) => join(home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		home,
	);

	// Which assets are workflows, decided by the tree they were read from rather
	// than by any field on the record — the reader fills `sourcePath` and this
	// module owns both trees, so the two agree without either side having to carry
	// a flag. The trailing separator is what keeps a hypothetical `workflows_old`
	// tree from matching `workflows` by prefix.
	const workflowRoots = [antigravityWorkflowsDir(home), antigravityGlobalWorkflowsDir(home)].map((dir) =>
		join(dir, "/"),
	);
	const workflows = raw.assets.filter((asset) => workflowRoots.some((root) => asset.sourcePath.startsWith(root)));
	if (workflows.length > 0) {
		items.push({
			source: SOURCE,
			from: workflows.map((workflow) => tildePath(home, workflow.sourcePath)).join(", "),
			to: "—",
			action: "downgrade",
			detail:
				`${workflows.length} workflow markdown(s) were written to ~/.labunbun/skills/<name>/SKILL.md, which is where ` +
				"Antigravity's own migrate-workflows skill puts its conversion — but the header was copied as it stands. That " +
				"skill also renames the frontmatter to name/description, and nothing in the launcher or the language server spells " +
				"out the keys a workflow header uses, so no rename was attempted here: check that the file has a name and a " +
				"description before relying on the skill being discoverable",
			containsSecret: false,
		});
	}

	// One rule file per document, each named for the document it came from rather
	// than for the source. `memory.txt` is the machine-local memory file — the only
	// one of the four attested as a protobuf field default — and `GEMINI.md` and
	// `AGENTS.md` are two different kinds of rule, so collapsing them into one
	// `imported-antigravity.md` would lose which document said what and would drop
	// whichever lost. See {@link antigravityRuleName} for the two `GEMINI.md`
	// candidates.
	const basenames = new Map<string, number>();
	for (const document of raw.memory) {
		const stem = document.name.replace(/\.[^.]*$/, "").toLowerCase();
		basenames.set(stem, (basenames.get(stem) ?? 0) + 1);
	}
	for (const document of raw.memory) {
		const stem = document.name.replace(/\.[^.]*$/, "").toLowerCase();
		planMemoryAsRule(
			SOURCE,
			tildePath(home, document.sourcePath),
			home,
			document.content,
			`imported-antigravity-${antigravityRuleName(home, document, (basenames.get(stem) ?? 0) > 1)}.md`,
			force,
			items,
			writes,
		);
	}

	for (const collision of raw.nameCollisions) {
		items.push({
			source: SOURCE,
			from: tildePath(home, collision.dropped),
			to: "—",
			action: "skip",
			detail:
				`a workflow and a skill both answer to "${collision.name}"; the one kept came from ` +
				`${tildePath(home, collision.kept)}. A skill is the shape Antigravity itself converts workflows into, so the ` +
				"skill is the one worth carrying — but the second file was there and nothing was merged from it",
			containsSecret: false,
		});
	}
}

/**
 * The data roots, the conversations under them, and everything the reader passed
 * over.
 *
 * **The conversations are counted, not carried, and the count is the point.** A
 * conversation is a directory under `brain/` named for its id, so the reader can
 * say how many there are without opening one. A report that says "3 conversations
 * left behind" is worth writing even though the migration does not move them: it
 * is the difference between a user who expected their history to come across and
 * being told, and a user who never had any.
 *
 * **The root that did not answer is named.** The IDE has two spellings for its
 * data directory and the app copies one out of the other without ever deleting the
 * source (`asar-out/dist/ideInstall/wizard.js:114-131`, `service.js:164-171` and
 * `:190`), so a file in both is read once, from the copy the current build writes
 * to. Anything only the other root holds stayed there — which the report says,
 * because "there is a second copy of your data directory and it was not read" is a
 * fact a user deciding whether this migration finished would want.
 */
function planAntigravityLeftovers(raw: RawAntigravity, items: MigrationItem[]): void {
	const roots = raw.dataDirs.map((dir) => tildePath(raw.home, dir));
	const dataDir = raw.dataDir;

	if (dataDir === null) {
		items.push({
			source: SOURCE,
			from: roots.join(", "),
			to: "—",
			action: "skip",
			detail:
				"neither data root held anything, so this home has Antigravity's customization but no IDE data: there were no " +
				"conversations to count and no per-data-root mcp_config.json to read. That is a real state rather than a " +
				"failure — it is what a user who installed the CLI side, or deleted the IDE, has",
			containsSecret: false,
		});
	} else {
		const here = tildePath(raw.home, dataDir);
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, antigravityConversationsDir(dataDir))} (${raw.conversations.length})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.conversations.length} conversation(s), each named and measured and none read: a conversation is a ` +
				"directory here, and its compact transcript is `.system_generated/logs/transcript.jsonl` inside it, with the " +
				"full log beside it for the steps whose truncated fields point into it. This import copies neither and wrote " +
				"nothing under the data root — the conversations are where Antigravity put them",
			containsSecret: false,
		});
		const others = roots.filter((root) => root !== here);
		if (others.length > 0) {
			items.push({
				source: SOURCE,
				from: others.join(", "),
				to: "—",
				action: "skip",
				detail:
					"the other spelling of the data directory, not read: Antigravity copies this tree out of that one and never " +
					"deletes the source (asar-out/dist/ideInstall/wizard.js:114-131, service.js:164-171 and :190), so a file " +
					`in both was read once, from ${here}. Anything only that root holds stayed there`,
				containsSecret: false,
			});
		}
	}

	for (const entry of raw.skipped) {
		items.push({
			source: SOURCE,
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
 * The signature is TRAE's with `claimScalar` added, and every parameter is one
 * something below uses: `claimScalar` for the theme and nothing else,
 * `existingMcpServers` and `force` for the server a user already has, `writes`
 * for the skills, workflows and rule files, and `mcpServers`/`markMcpSecret` for
 * the one place a credential can still reach a written file. There is no
 * `claimModePair` and no `addPermissionRules` — see the header for why claiming a
 * mode here would have had to invent the sandbox half of it.
 */
export function planAntigravity(
	raw: RawAntigravity,
	home: string,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimScalar: ClaimScalar,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	planAntigravityTheme(raw, items, claimScalar);
	planAntigravityPermissionPreset(raw, items);
	planAntigravityConfigKeys(raw, items);
	planAntigravityMcp(raw, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planAntigravityMcpCollisions(raw, items);
	planAntigravityAssets(raw, home, force, items, writes);
	planAntigravityLeftovers(raw, items);
}
