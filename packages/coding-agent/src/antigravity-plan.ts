// Antigravity's user state in the target's shape: the one setting that maps, the MCP servers,
// the skills and workflows, the instructions, and everything the reader saw this importer will not carry.
// Long-form design notes: docs/dev/migration-sources.md

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
	urlCredentialProblem,
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

// Long-form design notes: docs/dev/migration-sources.md
/** This source's id, spelled once. */
const SOURCE: MigrationSourceId = "antigravity";

// Long-form design notes: docs/dev/migration-sources.md
/** Top-level keys of `config.json` this mapper accounts for. */
const ANTIGRAVITY_CONFIG_HANDLED = new Set(["userSettings"]);

// Long-form design notes: docs/dev/migration-sources.md
/** Keys of `userSettings` this mapper accounts for — one mapped, one named. */
const ANTIGRAVITY_USER_SETTINGS_HANDLED = new Set(["themeMode", "permissionPreset"]);

// Long-form design notes: docs/dev/migration-sources.md
/** The keys Antigravity's own MCP documentation gives for one server. */
const ANTIGRAVITY_MCP_KEYS = new Set(["command", "args", "env", "serverUrl"]);

// Long-form design notes: docs/dev/migration-sources.md
/** The permission posture, named and not carried. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** `userSettings.themeMode` → this build's `theme`. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Everything in `config.json` this mapper did not map, named at both levels. */
function planAntigravityConfigKeys(raw: RawAntigravity, items: MigrationItem[]): void {
	if (raw.config === null) return;
	const file = tildePath(raw.home, raw.configPath);
	reportUnhandledKeys(SOURCE, raw.config, ANTIGRAVITY_CONFIG_HANDLED, file, items);
	const settings = raw.config.userSettings;
	if (!isRecord(settings)) return;
	reportUnhandledKeys(SOURCE, settings, ANTIGRAVITY_USER_SETTINGS_HANDLED, `${file} → userSettings`, items);
}

// Long-form design notes: docs/dev/migration-sources.md
/** One `mcp_config.json` server → this build's server shape. */
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

		// Long-form design notes: docs/dev/migration-sources.md
		if (command === "" && serverUrl !== "") {
			const problem = urlCredentialProblem(serverUrl);
			if (problem !== null) {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						`left off, because its serverUrl ${problem} — Antigravity has no field to put a credential in besides the ` +
						"address itself, and unlike a header or an environment variable there is no way to drop the credential and keep " +
						"the address, so nothing was written; add the server again here with the credential in your environment instead",
					containsSecret: true,
				});
				continue;
			}
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

// Long-form design notes: docs/dev/migration-sources.md
/** The same server name in two MCP documents, named once. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** One standing-instructions document's rule-file name, extension dropped. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Skills, the two deprecated workflow trees, and the standing instructions. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** The data roots, the conversations under them, and everything the reader passed over. */
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

// Long-form design notes: docs/dev/migration-sources.md
/** Assemble the plan. */
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
