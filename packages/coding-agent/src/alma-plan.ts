// Alma's user state in the target's shape: the model, the theme, the mode
// pair, the MCP servers, the hooks, the skills and the memory.
// Long-form design notes: docs/dev/migration-sources.md

import { join } from "node:path";
import type { PermissionMode, SandboxMode } from "@labunbun/agent";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	ALMA_BUNDLED_SKILL_COUNT,
	ALMA_DORMANT_MCP_TABLE,
	ALMA_EXPORT_FILES,
	ALMA_HOOK_DEFAULT_TIMEOUT_MS,
	ALMA_HOOK_EVENT_MAP,
	ALMA_HOOK_EVENTS,
	ALMA_HOOK_MATCHER_TARGETS,
	ALMA_IDENTITY_DOCS,
	almaForeignSkillRoots,
	almaOwnSkillRoots,
	almaSharedSkillRoots,
} from "./alma-home.ts";
import type { RawAlma } from "./alma-read.ts";
import {
	collectFileWrites,
	isRecord,
	normalizeClaudeHooks,
	planMemoryAsRule,
	summarizeNames,
	tildePath,
	urlCredentialProblem,
} from "./migrate-core.ts";
import type {
	ClaimHooks,
	ClaimModePair,
	ClaimScalar,
	MigrationItem,
	MigrationSourceId,
	PlannedWrite,
} from "./migrate-types.ts";
import { resolveModelReference } from "./migrate-types.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** This source's id, spelled once. The union and every keyed table live in `migrate-types.ts`; the call lives in `migrate.ts`. */
const SOURCE: MigrationSourceId = "alma";

// Long-form design notes: docs/dev/migration-sources.md
/** `security.autoApproveToolRequests` true → `agent` + `workspace-write`; an absent or non-boolean key claims nothing. */
export const ALMA_AUTO_APPROVE_ON: { mode: PermissionMode; sandbox: SandboxMode } = {
	mode: "agent",
	sandbox: "workspace-write",
};

/** The other half: {@link ALMA_AUTO_APPROVE_ON} with the mode asked rather than taken. */
export const ALMA_AUTO_APPROVE_OFF: { mode: PermissionMode; sandbox: SandboxMode } = {
	mode: "ask",
	sandbox: "workspace-write",
};

/**
 * The keys Alma's shipped `AppSettings` interface has and this importer reads,
 * so the report can say what it did with each rather than leaving the user to
 * diff two schemas.
 */
const ALMA_SETTINGS_REPORTED: Readonly<Record<string, string>> = {
	temperature: "no equivalent here — this build takes a temperature per request rather than from settings",
	maxTokens: "no equivalent here — this build takes an output limit per request rather than from settings",
	autoCompact: "this build compacts on its own schedule and has no threshold to set from a source",
	agentsEnabled: "no equivalent here — subagents are available rather than switched on",
	allowSubagentDelegation: "no equivalent here — delegation is a per-turn choice here, not a standing permission",
	memoryEnabled:
		"no equivalent here — this build's memory is the rule files and the history, and both come across on their own terms",
	networkTimeout: "no equivalent here — this build's HTTP timeout is not a settings key",
	fontSize: "no equivalent here — the terminal owns its own font",
	windowsShell:
		"no equivalent here — this build runs commands through the user's own shell profile rather than choosing one",
	hashlineEdit:
		"no equivalent here, and it is absent from the interface Alma itself ships, so it is a drift between the app and its own documentation",
};

// Long-form design notes: docs/dev/migration-sources.md
/** `chat.defaultModel` → this build's `model`. Only the model half is resolved, and `providers.api_key` is never read. */
function planAlmaModel(raw: RawAlma, items: MigrationItem[], claimScalar: ClaimScalar): void {
	const value = raw.settings?.defaultModel;
	if (value === undefined) return;
	const from = `app_settings.settings_data → chat.defaultModel (${value})`;
	const separator = value.indexOf(":");
	const modelId = separator === -1 ? value : value.slice(separator + 1);
	const providerId = separator === -1 ? undefined : value.slice(0, separator);
	const provider = providerId === undefined ? undefined : raw.providers.find((p) => p.id === providerId);
	// A `providerId` naming no row is worth saying: it is the state a user is in
	// after deleting a provider the picker still remembers.
	const providerWord = provider
		? ` Alma's provider for it is "${provider.name}" (type ${provider.type}).`
		: providerId === undefined
			? ""
			: ` It names provider \`${providerId}\`, which is not a row in the providers table any more.`;

	const resolved = resolveModelReference(modelId);
	if (resolved !== undefined) {
		claimScalar(
			SOURCE,
			"model",
			resolved,
			from,
			`Alma writes this as \`${value}\` — a provider id and a model id joined by a colon, where the provider id is a row in Alma's own providers table. ` +
				`Only the model half, \`${modelId}\`, was resolved against this build's registry;${providerWord} ` +
				"The provider's credentials were not read — `providers.api_key` is a plaintext column and is not among the columns this importer selects",
		);
		return;
	}
	items.push({
		source: SOURCE,
		from,
		to: "—",
		action: "skip",
		detail:
			`\`${modelId}\` is not a model this build carries, and it was not rounded to the nearest one: Alma's model id comes from its provider's catalogue ` +
			`and this build's from its own registry, so a near-match would be a different model wearing the same name.${providerWord} Pick one with /model`,
		containsSecret: false,
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** `general.theme` → this build's `theme`. `light` and `dark` map; `system` follows the terminal and stays unset. */
function planAlmaTheme(raw: RawAlma, items: MigrationItem[], claimScalar: ClaimScalar): void {
	const value = raw.settings?.theme;
	if (value === undefined) return;
	const from = `app_settings.settings_data → general.theme (${value})`;
	if (value === "light" || value === "dark") {
		claimScalar(
			SOURCE,
			"theme",
			value,
			from,
			`mapped to the built-in theme of the same name — Alma's two named modes are this build's two named modes`,
		);
		return;
	}
	if (value === "system") {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				'"system" is a choice, not a missing value: it means "follow the terminal", which is what this build already does. ' +
				"Pinning it to a named theme would write an appearance you did not pick — use /theme if you want one",
			containsSecret: false,
		});
		return;
	}
	items.push({
		source: SOURCE,
		from,
		to: "—",
		action: "skip",
		detail:
			"Alma's own interface declares this key as 'light' | 'dark' | 'system', so a value outside those three was written by something other than " +
			"the settings UI — the appearance is left as it is",
		containsSecret: false,
	});
}

// Long-form design notes: docs/dev/migration-sources.md
/** The approval switch → the mode pair. The sandbox half is this build's own default, not a translation of anything. */
function planAlmaAutoApprove(raw: RawAlma, claimModePair: ClaimModePair): void {
	const value = raw.settings?.autoApproveToolRequests;
	if (value === undefined) return;
	const mapped = value ? ALMA_AUTO_APPROVE_ON : ALMA_AUTO_APPROVE_OFF;
	claimModePair(
		SOURCE,
		mapped.mode,
		mapped.sandbox,
		`app_settings.settings_data → security.autoApproveToolRequests (${value})`,
		value
			? 'mapped to "agent": Alma\'s one approval switch means never ask. The sandbox stays confined to the workspace, and that half is not a translation — Alma has no sandbox setting anywhere in its schema or its runtime, so widening to an unconfined session would be this importer granting a permission Alma never offered'
			: 'mapped to "ask": Alma\'s switch was off, which is the same posture this build starts in for a tool it has not been told about',
	);
}

/** The settings keys this importer read and did nothing with, each with the reason. */
function planAlmaReportedSettings(raw: RawAlma, items: MigrationItem[]): void {
	if (raw.settings === null) return;
	for (const [key, why] of Object.entries(ALMA_SETTINGS_REPORTED)) {
		const value = (raw.settings as Record<string, unknown>)[key];
		if (value === undefined) continue;
		const shown =
			typeof value === "object" && value !== null
				? summarizeNames(Object.keys(value as Record<string, unknown>), 6)
				: String(value);
		items.push({
			source: SOURCE,
			from: `app_settings.settings_data → ${key} (${shown})`,
			to: "—",
			action: "skip",
			detail: why,
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** One `mcp.json` server → this build's server shape, with every scrubbed credential channel named and the URL left out whole. */
function planAlmaMcp(
	raw: RawAlma,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	for (const [name, entry] of Object.entries(raw.mcpServers)) {
		const from = `${tildePath(raw.home, raw.mcpPath)} → mcpServers.${name}`;
		if (!isRecord(entry)) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: 'not a server table — Alma decides the variant with `"command" in e` and would fail on this',
				containsSecret: false,
			});
			continue;
		}
		const hasCommand = "command" in entry;
		const hasUrl = "url" in entry;
		if (!hasCommand && !hasUrl) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"it names neither a command nor a URL, which are the two things Alma's own reader looks for — nothing was serving it over there either",
				containsSecret: false,
			});
			continue;
		}
		if (hasCommand && hasUrl) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"it names both a command and a URL. Alma does not treat that as an error the way Qoder's normalizer does — it checks each with its own `in` test — but this importer would have to pick one, and picking would be picking for it",
				containsSecret: false,
			});
			continue;
		}

		const downgrades: string[] = [];
		const config: Record<string, unknown> = {};

		if (hasCommand) {
			const command = typeof entry.command === "string" ? entry.command : "";
			const args = Array.isArray(entry.args) ? entry.args : [];
			const strings = args.filter((arg): arg is string => typeof arg === "string");
			if (strings.length !== args.length)
				downgrades.push(`${args.length - strings.length} argument(s) that were not strings, dropped`);
			if (typeof entry.args !== "undefined" && !Array.isArray(entry.args))
				downgrades.push("its `args` was not an array, so none was read");
			config.type = "stdio";
			config.command = command;
			config.args = strings;
			if (typeof entry.cwd === "string" && entry.cwd.trim() !== "") {
				if (isAbsolutePath(entry.cwd)) config.cwd = entry.cwd;
				else
					downgrades.push(
						`its relative cwd was left off — ${summarizeNames([entry.cwd])} means a different directory on each machine, and a server's working directory is not something to guess at`,
					);
			}
		} else {
			const url = typeof entry.url === "string" ? entry.url.trim() : "";
			const problem = urlCredentialProblem(url);
			if (problem !== null) {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						`left off, because ${problem} — unlike a header or an environment variable there is no way to drop the credential and keep the address, so nothing was written. ` +
						"Add the server again here with the credential in your environment instead",
					containsSecret: true,
				});
				continue;
			}
			config.type = "http";
			config.url = url;
			const transport = typeof entry.transport === "string" ? entry.transport : "";
			if (transport === "sse") {
				downgrades.push(
					'Alma spells this transport "sse" and this build has one HTTP client, so it connects the same way',
				);
			} else if (transport !== "" && transport !== "streamable-http" && transport !== "http") {
				downgrades.push(
					`its transport of ${summarizeNames([transport])} was read as streamable-http — Alma defaults to that and treats only \`"sse"\` as the other kind, ` +
						"so the spelling is recorded and the connection is the same either way",
				);
			}
		}

		// `env` reaches here as `{ NAME: null }` — `readAlma` kept the names and
		// dropped every value, which is why this can report the count without
		// holding one. There is no credential re-check here and the absence is
		// deliberate: a key matching a credential name was never written into the
		// block at all, so a branch testing for one could not be reached.
		if (isRecord(entry.env)) {
			const names = Object.keys(entry.env);
			if (names.length > 0) {
				downgrades.push(
					`left off ${names.length} environment variable${names.length === 1 ? "" : "s"} (${summarizeNames(names)}) — the names came across in this report, the values did not, ` +
						"so a server that needs a secret has to have it set again here",
				);
			}
		}

		if (!McpServerConfigSchema.safeParse(config).success) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: hasCommand
					? "its command, arguments or working directory are not a stdio server definition this build accepts"
					: "its URL is not an address this build's MCP client accepts",
				containsSecret: false,
			});
			continue;
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

		// Nothing credential-shaped was copied, so this is never true for a server
		// that came across. It is computed rather than assumed so that a future
		// change which *did* start copying a value has to make this turn true on
		// purpose.
		const secret = false;
		mcpServers[name] = config;
		markMcpSecret(secret);
		items.push({
			source: SOURCE,
			from,
			to: `~/.labunbun/.mcp.json → mcpServers.${name}`,
			action: downgrades.length > 0 ? "downgrade" : "map",
			detail:
				downgrades.length > 0
					? `copied without its credentials — ${downgrades.join("; ")}`
					: "copied without its credentials",
			containsSecret: secret,
		});
	}
}

/** Count hook entries matching a predicate without reading anything else. */
function almaHookCount(hooks: unknown, predicate: (entry: Record<string, unknown>) => boolean): number {
	if (!isRecord(hooks)) return 0;
	let count = 0;
	for (const groups of Object.values(hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
			for (const entry of group.hooks) {
				if (isRecord(entry) && predicate(entry)) count += 1;
			}
		}
	}
	return count;
}

/** Whether a path is absolute on any of the three platforms, without `node:path`'s opinion. */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

// Long-form design notes: docs/dev/migration-sources.md
/** Alma's four hook events → this build's, through the shared normalizer, with the drop rules counted. */
function planAlmaHooks(raw: RawAlma, items: MigrationItem[], claimHooks: ClaimHooks): void {
	if (raw.hooks === undefined) return;
	const from = tildePath(raw.home, raw.hooksPath);

	// Translate the vocabulary first, then let the shared normalizer decide what
	// this build can run. Handing it Alma's four names unchanged would put all
	// four into `droppedEvents` and report a working configuration as four hooks
	// this build has no event for, which is the opposite of the truth.
	const translated: Record<string, unknown> = {};
	const unmapped: string[] = [];
	for (const [event, groups] of Object.entries(isRecord(raw.hooks) ? raw.hooks : {})) {
		if (!ALMA_HOOK_EVENTS.includes(event)) continue;
		const target = ALMA_HOOK_EVENT_MAP[event];
		if (target === undefined) {
			unmapped.push(event);
			continue;
		}
		if (!Array.isArray(groups)) continue;
		const carried = groups.map((group) => {
			if (!isRecord(group)) return group;
			const handlers = Array.isArray(group.hooks)
				? group.hooks.filter((handler) => isRecord(handler) && handler.enabled !== false)
				: [];
			// The matcher is dropped for a content event and kept for a tool-name
			// one, because that is the difference between a matcher that means
			// something here and one that matches the empty string.
			const matcher =
				ALMA_HOOK_MATCHER_TARGETS[event] === "tool-name" && typeof group.matcher === "string"
					? group.matcher
					: undefined;
			return { ...(matcher === undefined ? {} : { matcher }), hooks: handlers };
		});
		const existing = Array.isArray(translated[target]) ? (translated[target] as unknown[]) : [];
		translated[target] = [...existing, ...carried];
	}

	const disabled = almaHookCount(raw.hooks, (entry) => entry.enabled === false);
	const normalized = normalizeClaudeHooks(translated);

	const downgrades: string[] = [];
	if (disabled > 0) {
		downgrades.push(
			`${disabled} handler${disabled === 1 ? " was" : "s were"} marked \`enabled: false\` and were not imported — switching one on here would run something you had switched off there`,
		);
	}
	if (unmapped.length > 0) {
		downgrades.push(
			`${summarizeNames(unmapped)} ${unmapped.length === 1 ? "is an event" : "are events"} Alma has and this build does not`,
		);
	}
	downgrades.push(
		'a hook here can still block — Alma\'s `decision: "block"` and its exit code 2 are the same two signals this build reads — but it can no longer **rewrite** the arguments or the message it was about to send, because `updatedInput` has no equivalent',
	);

	const eventCount = Object.keys(normalized.config).length;
	if (eventCount === 0) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				`Alma declares ${ALMA_HOOK_EVENTS.length} hook events and none of the ${Object.keys(isRecord(raw.hooks) ? raw.hooks : {}).length} configured here produced a hook this build can run` +
				// The disabled count is stated here rather than only in `downgrades`,
				// because `downgrades` is what the *claim* line carries and there is no
				// claim line on this path. A hook the user switched off in Alma and
				// finds missing here is owed the reason.
				(disabled > 0
					? `: ${disabled} of them carried \`enabled: false\` and were not imported, which is the only reason this list came out empty`
					: "") +
				(unmapped.length > 0
					? `: ${summarizeNames(unmapped)} ${unmapped.length === 1 ? "has" : "have"} no counterpart here`
					: ""),
			containsSecret: false,
		});
		return;
	}

	claimHooks(
		SOURCE,
		normalized.config,
		from,
		`${eventCount} of Alma's ${ALMA_HOOK_EVENTS.length} events map onto an event this build runs (${summarizeNames(Object.keys(normalized.config))}) — ${downgrades.join("; ")}`,
		"downgrade",
	);

	for (const dropped of normalized.droppedMatchers) {
		items.push({
			source: SOURCE,
			from: `${from} → ${dropped}`,
			to: "—",
			action: "downgrade",
			detail:
				"a matcher was dropped — this build escapes a matcher's pattern characters, so the one carried would have matched a literal rather than the tool it named",
			containsSecret: false,
		});
	}
	if (normalized.droppedHandlers > 0 || normalized.malformed > 0) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "downgrade",
			detail:
				`${normalized.droppedHandlers} handler(s) were not shell commands and ${normalized.malformed} entr${normalized.malformed === 1 ? "y was" : "ies were"} malformed — ` +
				`Alma runs every hook through \`sh -c\`, as this build does, and this build's default timeout of ${ALMA_HOOK_DEFAULT_TIMEOUT_MS} ms applies to any handler that named none`,
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Skills and memory: a verbatim copy of Alma's own skill roots, and one rule file per memory document. */
function planAlmaAssets(raw: RawAlma, force: boolean, items: MigrationItem[], writes: PlannedWrite[]): void {
	collectFileWrites(
		SOURCE,
		raw.assets,
		(name) => join(raw.home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		raw.home,
	);

	for (const collision of raw.assetCollisions) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, collision.dropped),
			to: "—",
			action: "skip",
			detail:
				`a skill named "${collision.name}" is in both ${collision.kept} and here, and Alma resolves a name against its roots in order — the first one is what loads and this second copy ` +
				"is never read by Alma at all. It was not imported, and if you meant the other copy, move it up a root",
			containsSecret: false,
		});
	}

	const memoryNames = new Set<string>();
	for (const document of raw.memory) memoryNames.add(document.name.replace(/\.[^.]*$/, "").toLowerCase());
	for (const document of raw.memory) {
		const isIndex = document.name.toLowerCase() === "memory.md";
		const fileName = isIndex
			? "imported-alma-memory-index.md"
			: `imported-alma-${document.name.replace(/\.[^.]*$/, "")}.md`;
		planMemoryAsRule(
			SOURCE,
			tildePath(raw.home, document.sourcePath),
			raw.home,
			document.content,
			fileName,
			force,
			items,
			writes,
		);
	}
	if (memoryNames.size > 1) {
		items.push({
			source: SOURCE,
			from: "~/.config/alma/memory + ~/.config/alma/MEMORY.md",
			to: "—",
			action: "downgrade",
			detail:
				"Alma's memory came across as one rule file per document — its index plus each entry — because this build has no memory directory and no index format to keep, " +
				"so what pointed at what is now the file names",
			containsSecret: false,
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Everything the reader saw and this importer will not carry, each with the reason the user is owed. */
function planAlmaLeftovers(raw: RawAlma, items: MigrationItem[]): void {
	if (raw.settingsProblem !== null) {
		items.push({
			source: SOURCE,
			from: raw.settingsDbPath === null ? "app_settings.settings_data" : tildePath(raw.home, raw.settingsDbPath),
			to: "—",
			action: "skip",
			detail: raw.settingsProblem,
			containsSecret: false,
		});
	} else if (raw.settings === null) {
		items.push({
			source: SOURCE,
			from: "app_settings.settings_data",
			to: "—",
			action: "skip",
			detail: "Alma's settings row exists and is empty, so there was nothing in it to take",
			containsSecret: false,
		});
	}

	if (raw.unhandledSettings.length > 0) {
		items.push({
			source: SOURCE,
			from: "app_settings.settings_data",
			to: "—",
			action: "skip",
			detail:
				`${raw.unhandledSettings.length} top-level key${raw.unhandledSettings.length === 1 ? "" : "s"} of Alma's settings (${summarizeNames(raw.unhandledSettings, 8)}) ` +
				"were not read. Some are credentials or containers of one and are named as such in the lines below; the rest either have no equivalent here or are fields Alma's own shipped " +
				"interface does not document. The names are the report; nothing under them was opened",
			containsSecret: false,
		});
	}

	// The identity documents. Four of the five have no equivalent and are named
	// with what they are, because a user who wrote a `SOUL.md` and watched it not
	// appear anywhere deserves to know where it stayed.
	const identityWhat: Readonly<Record<string, string>> = {
		"SOUL.md":
			"the agent's persona — Alma prepends it to its instructions as a persona, not as a project instruction file, and this build has no persona file to put one in",
		"USER.md":
			"the human's own name and platform ids, parsed out of its YAML frontmatter by three separate bridge implementations. It is who to address, not what to do, so there is nothing here for it to become",
		"SECURITY.md":
			"a rules block Alma prepends with 'SECURITY RULES (HIGHEST PRIORITY)'. It is not a permission rule — this build's permission rules are tool-and-pattern pairs, and prose cannot be expressed as one",
		"HEARTBEAT.md":
			"a checklist an unattended session follows on a timer. This build has no unattended-session hook to attach it to",
	};
	const present = new Set(raw.identityDocs);
	for (const name of ALMA_IDENTITY_DOCS) {
		if (name === "MEMORY.md") continue;
		if (!present.has(name)) continue;
		items.push({
			source: SOURCE,
			from: `~/.config/alma/${name}`,
			to: "—",
			action: "skip",
			detail: `${identityWhat[name] ?? "an identity document with no equivalent here"} — named and not read, and it stayed where it was`,
			containsSecret: false,
		});
	}

	// The skill roots that are not Alma's. Two categories, two different reasons,
	// and the report says which is which — and names the two that *were* read, so
	// a user looking for the skill Alma loaded can see exactly where it came from.
	const own = almaOwnSkillRoots(raw.roots.configDir, raw.archiveWorkspacePath);
	const shared = almaSharedSkillRoots(raw.home, raw.archiveWorkspacePath);
	const foreign = almaForeignSkillRoots(raw.home);
	items.push({
		source: SOURCE,
		from: own.map((p) => tildePath(raw.home, p)).join(", "),
		to: "~/.labunbun/skills",
		action: "map",
		detail:
			"Alma's own two skill roots are the only ones read, and the order above is Alma's own precedence order — the first one to hold a name is the one that loads",
		containsSecret: false,
	});
	items.push({
		source: SOURCE,
		from: shared.map((p) => tildePath(raw.home, p)).join(", "),
		to: "—",
		action: "skip",
		detail:
			"the shared agent home, which Alma reads for cross-tool portability and which this repository already migrates as its `agents` source. " +
			"Reading it here as well would write two copies of every skill in it and attribute the second to this source — copy them over with --from agents",
		containsSecret: false,
	});
	items.push({
		source: SOURCE,
		from: foreign.map((p) => tildePath(raw.home, p)).join(", "),
		to: "—",
		action: "skip",
		detail:
			"other products' homes, which Alma reads skills out of so a skill written for Claude Code or Codex works here too. They are not Alma's content and were not imported under it — " +
			"they came from those products, and they still live in those products' own directories",
		containsSecret: false,
	});
	items.push({
		source: SOURCE,
		from: "resources/bundled-skills/",
		to: "—",
		action: "skip",
		detail:
			`${ALMA_BUNDLED_SKILL_COUNT} skills ship with Alma itself — ${ALMA_BUNDLED_SKILL_COUNT > 0 ? "authored by its authors, not by you" : ""}, and Alma copies them into your personal skills directory on first run behind a ` +
			"`.bundled-skills-migrated` marker. They are the product's own content rather than yours, so they are not counted as your skills; the ones already copied into " +
			"~/.config/alma/skills are in the import above, because by then they are files in your home",
		containsSecret: false,
	});

	// The thread archive, with its three traps stated rather than assumed.
	if (raw.archiveCount > 0) {
		const where =
			raw.archiveWorkspacePath === null
				? "Alma's thread archive"
				: `${tildePath(raw.home, raw.archiveWorkspacePath)}/threads`;
		items.push({
			source: SOURCE,
			from: `${where} (${raw.archiveCount} markdown file${raw.archiveCount === 1 ? "" : "s"})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.archiveCount} archived conversation${raw.archiveCount === 1 ? "" : "s"}, named and not read, and three things about them are worth knowing before you rely on the folder. ` +
				"Alma writes every archived thread under **one** workspace's path — `settings.workspace.path`, or the `Default` workspace it creates — whatever project the thread was actually had in, and the " +
				"file never records which project that was. Threads titled `⏰ Cron:…` are never archived at all, which is the `title NOT LIKE '⏰ Cron:%'` in its own query. " +
				"And only `text` parts are written, so every tool call and image is missing from an archive by construction. The conversations themselves are in the database; see the history section",
			containsSecret: false,
		});
	}

	items.push({
		source: SOURCE,
		from: `${ALMA_DORMANT_MCP_TABLE} (in ${tildePath(raw.home, raw.settingsDbPath ?? "")})`,
		to: "—",
		action: "skip",
		detail:
			"Alma carries a second, dormant MCP store: a `mcp_servers` table with working CRUD methods that the configuration routes never write, because the manager's `saveConfig` writes mcp.json and " +
			"nothing else touches it. The consequence is not academic — Alma's own `GET /api/data/export` builds its `mcpServers.json` from that table, so its built-in export can emit an **empty** MCP list on an " +
			"install whose servers are all in mcp.json and working. This import read the file",
		containsSecret: false,
	});

	items.push({
		source: SOURCE,
		from: "GET /api/data/export → GET /api/data/import",
		to: "—",
		action: "skip",
		detail:
			`Alma ships its own export and import, and it is a genuine alternative to this migration — take it before you take this. It is not the same thing, though: it writes a zip of ` +
			`${ALMA_EXPORT_FILES.length} Alma-shaped files (${summarizeNames([...ALMA_EXPORT_FILES], 10)}), it **omits** secrets, skills, hooks and every document in ~/.config/alma, and its mcpServers.json ` +
			"may be empty for the reason above. Moving between the two products is what this import does; the export only moves you out of Alma",
		containsSecret: false,
	});

	items.push({
		source: SOURCE,
		from: `chat_threads / chat_messages (${raw.threadCount} thread${raw.threadCount === 1 ? "" : "s"})`,
		to: "—",
		action: "skip",
		detail:
			"the conversations themselves, which live in the database rather than in files. They are imported separately by the history phase, and there is one fact about them worth saying here: " +
			"`chat_threads` has twenty-two columns and **none of them is a directory**. A thread's working directory is `workspace_id` resolved through `workspaces.path`, and the column is " +
			"`ON DELETE SET NULL`, so deleting a workspace leaves its threads with no path at all rather than a stale one",
		containsSecret: false,
	});

	if (raw.providers.length > 0) {
		items.push({
			source: SOURCE,
			from: `providers (${raw.providers.length} row${raw.providers.length === 1 ? "" : "s"})`,
			to: "—",
			action: "skip",
			detail:
				"Alma's providers were read for their id, name and type only, and were **not** migrated: a provider is a base URL, a wire format and a credential, and this build's provider set has none of " +
				`those three shapes. Their \`api_key\` column was not selected — it is plaintext, with no encryption call on the write path, which contradicts the app's own generated api-spec.md ("Provider ` +
				'API keys are stored encrypted"). Add a provider here with the key in your own environment',
			containsSecret: false,
		});
	}

	items.push({
		source: SOURCE,
		from: tildePath(raw.home, raw.roots.configDir),
		to: "—",
		action: "skip",
		detail:
			"two things about Alma's storage are worth knowing because they change what a copy of it means. A secret with `env` set is injected into **every** shell command Alma runs — the column " +
			"`defaults to 1`, so a user who never thought about it has every stored secret in the environment of every Bash call. And Alma redacts secret values out of tool output by substituting " +
			"[REDACTED:<NAME>], so an exported transcript may carry those markers as literal text — and the redaction skips any value shorter than six characters, " +
			"because its guard is `value.length < 6 || text.includes(value) && …` and `||` binds looser than `&&`",
		containsSecret: false,
	});

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
/** Assemble the plan. There is no `claimEnv`, and the absence carries the decision. */
export function planAlma(
	raw: RawAlma,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimScalar: ClaimScalar,
	claimModePair: ClaimModePair,
	claimHooks: ClaimHooks,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	planAlmaModel(raw, items, claimScalar);
	planAlmaTheme(raw, items, claimScalar);
	planAlmaAutoApprove(raw, claimModePair);
	planAlmaReportedSettings(raw, items);
	planAlmaMcp(raw, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planAlmaHooks(raw, items, claimHooks);
	planAlmaAssets(raw, force, items, writes);
	planAlmaLeftovers(raw, items);
}
