/**
 * OpenClaw's user state, as read from a home directory.
 *
 * Read `openclaw-home.ts` first — every path claim below is that module's. The
 * standing caveats for this source, in one place:
 *
 *   - **There are two unrelated settings documents and a user's model may be in
 *     either.** `<stateDir>/openclaw.json` is the product configuration;
 *     `<agentDir>/settings.json` is a *forked Claude Code settings manager*
 *     (`src/agents/sessions/settings-storage.ts:89`) holding `defaultProvider`,
 *     `defaultModel`, `defaultThinkingLevel`, `theme` and the rest
 *     (`:73-111`). Reading only the first reports "no model set" for a user who
 *     set one, which is the most common way a migration of this shape goes wrong.
 *   - **`$include` is the layering mechanism, and skipping it imports a document
 *     the product is not running** (`includes.ts:25`). Merge semantics are
 *     specific and are implemented below: arrays concatenate, objects merge
 *     recursively, primitives take the source (`includes.ts:204-207`).
 *   - **The MCP server map is open-world and has retired keys that make a whole
 *     file fail to load.** `McpServerSchema` ends in `.catchall(z.unknown())`
 *     (`zod-schema.mcp-server.ts:154`), which is precisely why the retired aliases
 *     are rejected in a `superRefine` rather than by the schema — the comment at
 *     `:75-76` says so. **A file carrying one of them does not load at all**, so a
 *     migrator that silently ignored them would report a healthy install where the
 *     product refuses to start.
 *   - **The state directory has three spellings and only one of them is the
 *     answer** (`state-dir.ts:21-43`, `cli/profile-utils.ts:26-37`,
 *     `infra/config-dir.ts:7-20`). They disagree about `OPENCLAW_CONFIG_PATH`
 *     and about the `.clawdbot` fallback; see the table in `openclaw-home.ts`.
 *
 * **Nothing here throws.** Every read that fails becomes a line in
 * {@link RawOpenClaw.skipped} naming what failed and why, for the reason
 * `qoder-read.ts` states in its own header.
 *
 * **No field holds a credential and no field holds a conversation.** See
 * {@link scrubOpenClawCredentials} for the shapes that were removed, and the
 * header of `migrate-core.ts`'s `urlCredentialProblem` for the one that no
 * key-name scan can see.
 */

import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord, readSkillDirs, readText } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";
import {
	OPENCLAW_BOOTSTRAP_FILENAMES,
	OPENCLAW_INCLUDE_KEY,
	OPENCLAW_INCLUDE_MAX_BYTES,
	OPENCLAW_INCLUDE_MAX_DEPTH,
	OPENCLAW_LEGACY_DIR,
	OPENCLAW_LEGACY_MEMORY_FILENAME,
	OPENCLAW_PRIMARY_INSTRUCTION_FILE,
	type OpenClawEnv,
	openclawAgentDir,
	openclawConfigCandidates,
	openclawConfigDir,
	openclawConfigPath,
	openclawSkillDirs,
	openclawStateDir,
} from "./openclaw-home.ts";
import { countOpenClawSessions } from "./openclaw-session.ts";

/**
 * One thing the walk found and did not carry over, with the reason.
 *
 * `name` is a **label, not a resolved path**, the same convention `qoder-read.ts`
 * uses. Nothing here ever holds a value read out of a credential-shaped key.
 */
export interface OpenClawSkipped {
	name: string;
	reason: string;
}

/**
 * A configuration document in the three states one can be in when it is on disk.
 *
 * `recovered` records whether the file needed the JSON5 fallback: OpenClaw tries
 * strict JSON first and JSON5 second (`utils/parse-json-compat.ts:48-55`), so a
 * file that only parses as JSON5 is a real and common state — and its comments are
 * **stripped on write** (`config/json5-comments.ts:24-34`), which is why this
 * importer never round-trips a document through the product's writer.
 */
type OpenClawJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/**
 * OpenClaw's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* of something, or a line
 * saying why neither happened. No field holds a credential and no field holds a
 * conversation.
 */
export interface RawOpenClaw {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the roots were resolved from, kept for the report. */
	env: OpenClawEnv;
	/** The state directory the product's own resolver selected. Always a path. */
	stateDir: string;
	/** `~/.clawdbot` — the pre-rename state directory, named whether or not it exists. */
	legacyStateDir: string;
	/** The configuration directory, which is **not** always {@link RawOpenClaw.stateDir}. */
	configDir: string;
	/** True when a resolved root exists and holds something. */
	present: boolean;
	/**
	 * Which configuration file the product would load, and every candidate it
	 * would have chosen between.
	 *
	 * The candidates are reported because the choice is not obvious: an install can
	 * hold both spellings, and the modern one wins (`paths.ts:38-44`).
	 */
	configPath: string;
	configCandidates: string[];
	/**
	 * The configuration **after `$include` resolution** — the document OpenClaw is
	 * actually running — or `null` when nothing was readable.
	 *
	 * `null` rather than `{}` on purpose: a present-but-unusable file must say which
	 * of "not a JSON object" or "not parseable" applies, and an empty object would
	 * let a planner claim a document was read and held nothing.
	 *
	 * **This is the merged document, not the file.** An importer that read
	 * `openclaw.json` alone and stopped would be importing a file the product has
	 * layered other documents over, which is the single most load-bearing thing
	 * this reader does beyond opening the right directories.
	 *
	 * Credential-shaped keys have been removed; see {@link scrubOpenClawCredentials}.
	 */
	settings: Record<string, unknown> | null;
	/** The files an `$include` pulled in, in the order they were merged. */
	includeFiles: string[];
	/**
	 * Includes that could not be read, and why.
	 *
	 * **Never empty when {@link RawOpenClaw.settings} is non-null but thin.** A
	 * malformed sibling is isolated rather than fatal — `resolveConfigIncludesForTopLevelKey`
	 * exists for exactly that (`includes.ts:637-646`) — so a home whose include is
	 * broken still reports the keys it does have, and this list says what is
	 * missing. Silence here would be a report claiming completeness it does not have.
	 */
	includeFailures: Array<{ path: string; reason: string }>;
	/**
	 * Top-level keys that were dropped because the product would not load a file
	 * carrying them, named rather than counted.
	 *
	 * A whole-file failure in OpenClaw is not a per-key one, so these are a
	 * *diagnosis*, not a partial import: the planner refuses the MCP map entirely
	 * when this is non-empty.
	 */
	retiredMcpKeys: string[];
	/**
	 * `mcp.servers` — copied without interpretation, credential values removed.
	 *
	 * The map itself is keyed by a name the user chose (`types.mcp.ts:15-17`), and a
	 * server called `keyboard-mcp` is an ordinary thing to want, so the scrub walks
	 * *into* each entry and never deletes the entry. What is removed, and why, is
	 * {@link scrubOpenClawCredentials}'s whole subject.
	 */
	mcpServers: Record<string, unknown>;
	/**
	 * The **names** of the credential values {@link RawOpenClaw.mcpServers} had
	 * removed, keyed by server name.
	 *
	 * **This exists because a value that is gone is a name the report cannot
	 * print.** The scrub drops `env` and `headers` whole, so a planner reading
	 * `mcpServers` sees no trace of them and would report a clean `map` for a server
	 * whose secrets were dropped — which is the "everything came across" reading
	 * the credential rules exist to prevent. The names are carried separately so the
	 * planner can say "left off MY_TOKEN, authorization — set them again here".
	 *
	 * Never a value. See {@link scrubOpenClawCredentials}.
	 */
	mcpCredentialNames: Record<string, { env?: string[]; headers?: string[] }>;
	/**
	 * The **names** of the environment variables `openclaw.json`'s `env` block
	 * declared, never a value.
	 *
	 * **The one that carries the finding this source exists for.** OpenClaw's own
	 * provider key list (`src/infra/dotenv.ts:43,61,62,76`) includes
	 * `KIMI_API_KEY`, `KIMICODE_API_KEY`, `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`
	 * and `MINIMAX_API_KEY`, so this block is a place *other tools'* credentials
	 * live. An importer that copied `env` into this build's settings would hand one
	 * tool's key to another file; an importer that copies nothing and **names what
	 * it saw** is what keeps that from being invisible.
	 *
	 * Read from the unsanitized merge for the reason
	 * {@link RawOpenClaw.mcpCredentialNames} is: the scrub has already removed the
	 * values, so the scrubbed copy has no names left to report.
	 */
	envNames: string[];
	/**
	 * `<agentDir>/settings.json` — the forked Claude Code settings document — or
	 * `null` when there is none.
	 *
	 * **Read separately and never merged into {@link RawOpenClaw.settings}.** They
	 * are different documents with different schemas: this one carries
	 * `defaultProvider`/`defaultModel`/`defaultThinkingLevel`/`theme`
	 * (`settings-storage.ts:73-111`) and the product configuration carries none of
	 * them. The planner reads both and reports both.
	 */
	agentSettings: Record<string, unknown> | null;
	/** Where {@link RawOpenClaw.agentSettings} came from, or `null` beside it. */
	agentSettingsPath: string | null;
	/**
	 * Retired keys carried by {@link RawOpenClaw.agentSettings}.
	 *
	 * Four checks, not six: `queueMode`, `websockets`, `skills` **as an object**
	 * (it is a `string[]` now) and `retry.maxDelayMs` — `requireSupportedSettings`
	 * (`settings-manager.ts:51-77`) pushes all four and throws. A document carrying
	 * one does not load, so the planner says so rather than importing a settings
	 * file OpenClaw refuses.
	 */
	retiredAgentSettingKeys: string[];
	/**
	 * `<workspace>/AGENTS.md` — the one bootstrap document with an equivalent here
	 * — or `null`.
	 *
	 * **These live in the workspace, not in `~/.openclaw`** (the policy resolves
	 * them against `workspaceRoot`, `workspace-bootstrap-policy.ts:51-57`), so the
	 * field is null for a home that has never run an agent in a directory it kept.
	 */
	agentsMd: string | null;
	/** The workspace the bootstrap documents were looked for in. */
	workspaceDir: string | null;
	/**
	 * The other five bootstrap documents, by name.
	 *
	 * Named and not imported, because this build has no counterpart for a persona
	 * document, a device identity, a user profile, a first-run script or a root
	 * memory index. **They are reported by name because "no equivalent" and "we did
	 * not look" are different claims**, and only one of them is true.
	 */
	otherBootstrapDocs: Array<{ name: string; present: boolean }>;
	/** Managed and plugin skills, de-duplicated by folder name, managed first. */
	assets: RawFile[];
	/** A folder name answered by both skill roots; the second was not read. */
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/** The agent directory the configuration selects, and the default one beside it. */
	agentDir: string;
	agentId: string;
	/**
	 * The agent's SQLite store, **existence-checked only**, or `null` when absent.
	 *
	 * The *name* is what a report may print. Nothing in this importer opens it;
	 * `openclaw-session.ts` does, under its own guarded reader.
	 */
	agentDb: { path: string; exists: boolean } | null;
	/** How many session transcripts the store holds, none of them read here. */
	sessionCount: number;
	/**
	 * The retired `sessions.json`, **existence-checked only**, or `null`.
	 *
	 * `state-migrations.legacy-session-store.ts:1` declares it retired and
	 * `openclaw doctor --fix` migrates it into SQLite. Reading it is a migration
	 * *source*, not a current store, so it is named here rather than parsed.
	 */
	legacySessions: { path: string; exists: boolean } | null;
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: OpenClawSkipped[];
}

/** The agent OpenClaw uses when the configuration names none. */
const DEFAULT_AGENT_ID = "main";

/** How deep a credential-shaped key is looked for. See the note in `qoder-read.ts`. */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

/**
 * Keys whose value is dropped **whole**, contents and all.
 *
 * The distinction is the same one `scrubQoderCredentials` draws, and getting it
 * backwards is how a scrub deletes a user's servers. `mcp.servers.headers` is a
 * slot — every value in it is registered sensitive by the product's own schema
 * (`zod-schema.mcp-server.ts:33-37`), so dropping the map loses nothing that was
 * configuration. `mcp.servers.keyboard-mcp` is a *name*, and it is handled by
 * {@link OPENCLAW_NAME_MAP_KEYS} instead.
 *
 * **`env` is deliberately NOT here**, which was a first-draft mistake worth
 * recording: it is not only a credential slot. `env.shellEnv` is plain
 * configuration (`enabled`, `timeoutMs`, `types.openclaw.ts:55-67`), so dropping
 * the whole block lost it. `env` recurses instead — `env.vars` is dropped whole
 * below, and a bare `FOO: "bar"` under `env` survives because it is not a
 * credential. `auth` is dropped the same way for the same reason: it is a mix of
 * `authProfiles` (state) and profile *references*.
 */
const OPENCLAW_CREDENTIAL_SLOTS = new Set([
	"headers",
	"apiKey",
	"clientCert",
	"clientKey",
	"tokens",
	"vars",
	"authProfiles",
]);

/**
 * Keys whose value is a **map the user keys by hand**, so its child keys are
 * names rather than field names.
 *
 * **This set is what stops {@link scrubOpenClawCredentials} deleting servers, and
 * the bug it prevents is not hypothetical.** `looksLikeSecretName` matches `KEY` as
 * a case-insensitive *substring*, so a server named `keyboard-mcp` matches it — and
 * a walk that tested every key it reached would delete that user's server, its
 * command, its arguments and its working directory, none of which is a secret. That
 * is the failure `qoder-read.ts` documents in its own header ("a server called
 * `keyboard-mcp` is an ordinary thing to want; `looksLikeSecretName` matches `KEY`
 * inside it and the naive walk took that as a finding"), and a first draft of this
 * module reproduced it exactly.
 *
 * So when the walk reaches one of these keys it **recurses into each entry and keeps
 * every entry**, dropping credential-shaped keys *inside* an entry
 * (`mcp.servers.x.env`, `models.providers.y.apiKey`) and never the entry itself.
 *
 * `authProfiles` is deliberately **not** here: it is login state rather than a
 * user-named map, so it is dropped whole above.
 */
const OPENCLAW_NAME_MAP_KEYS = new Set(["servers", "providers", "entries", "surfaces", "accessGroups"]);

/**
 * The keys OpenClaw's own MCP schema hard-rejects (`zod-schema.mcp-server.ts`).
 *
 * **Nine at the top level** — eight in the loop at `:77-86` plus `disabled` at
 * `:102-113` — and one more nested under `codex` (`:95-104`). They exist as
 * checks rather than as a strict object *because* the schema is
 * `.catchall(z.unknown())` (`:154`): without the `superRefine` those aliases would
 * be swallowed by the open-world catchall and silently accepted. A file carrying
 * one fails to load in its entirety, which is why this importer reports the
 * diagnosis instead of importing the surviving keys as if the file were healthy.
 */
const OPENCLAW_RETIRED_MCP_KEYS = new Set([
	"connectTimeout",
	"connect_timeout",
	"timeout",
	"workingDirectory",
	"supports_parallel_tool_calls",
	"ssl_verify",
	"client_cert",
	"client_key",
	"disabled",
]);

/** The nested retired key, under `codex` (`zod-schema.mcp-server.ts:95-104`). */
const OPENCLAW_RETIRED_MCP_CODEX_KEY = "default_tools_approval_mode";

/**
 * Read OpenClaw's state from `home`.
 *
 * `cwd` is the workspace the bootstrap documents are looked for in and is
 * **required, not defaulted** — for the reason `readSources` states: a workspace is
 * not something a reader may pick for itself. `env` is required too, so no test can
 * be made hermetic by forgetting it.
 */
export function readOpenClaw(home: string, cwd: string, env: OpenClawEnv): RawOpenClaw {
	const skipped: OpenClawSkipped[] = [];
	const stateDir = openclawStateDir(home, env);
	const configDir = openclawConfigDir(home, env);
	const configCandidates = openclawConfigCandidates(home, env);
	const configPath = openclawConfigPath(home, env);

	const merged = resolveOpenClawConfig(home, configPath, skipped);

	const agentId = readAgentId(merged.value);
	const agentDir = openclawAgentDir(stateDir, agentId, readConfiguredAgentDir(merged.value, agentId));
	const agentDbPath = join(agentDir, "openclaw-agent.sqlite");

	const agentSettingsDoc = readJsonFile(join(agentDir, "settings.json"));
	const agentSettings =
		agentSettingsDoc.kind === "object" ? scrubOpenClawCredentials(agentSettingsDoc.value).value : null;
	if (agentSettingsDoc.kind === "invalid")
		skipped.push({ name: "<agentDir>/settings.json", reason: `not usable: ${agentSettingsDoc.reason}` });

	const retiredMcpKeys = collectRetiredMcpKeys(merged.raw);
	const mcp = readMcpServers(merged.value, merged.raw);

	const workspace = readWorkspace(cwd, skipped);
	const { assets, assetCollisions } = readSkillRoots(configDir);

	const legacySessionsPath = join(stateDir, "sessions.json");

	return {
		home,
		env,
		stateDir,
		legacyStateDir: join(home, OPENCLAW_LEGACY_DIR),
		configDir,
		present: existsSync(stateDir) || existsSync(configDir),
		configPath,
		configCandidates,
		settings: merged.value,
		includeFiles: merged.files,
		includeFailures: merged.failures,
		retiredMcpKeys,
		mcpServers: mcp.servers,
		mcpCredentialNames: mcp.names,
		envNames: readOpenClawEnvNames(merged.raw),
		agentSettings,
		agentSettingsPath: agentSettings === null ? null : join(agentDir, "settings.json"),
		retiredAgentSettingKeys: collectRetiredAgentSettingKeys(agentSettings),
		agentsMd: workspace.agentsMd,
		workspaceDir: cwd,
		otherBootstrapDocs: workspace.others,
		assets,
		assetCollisions,
		agentDir,
		agentId,
		agentDb: { path: agentDbPath, exists: existsSync(agentDbPath) },
		sessionCount: countOpenClawSessions(agentDbPath),
		legacySessions: { path: legacySessionsPath, exists: existsSync(legacySessionsPath) },
		skipped: skipped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
	};
}

// ---------------------------------------------------------------------------
// Configuration: strict JSON, JSON5, and `$include`
// ---------------------------------------------------------------------------

/**
 * Parse one configuration document: **strict JSON first, JSON5 second**
 * (`utils/parse-json-compat.ts:48-55`).
 *
 * The JSON5 arm is a comment-and-trailing-comma stripper rather than a full JSON5
 * parser, and that is enough for what OpenClaw writes: the fallback exists for
 * comments (`config/json5-comments.ts:24-34`), which are the only JSON5 feature the
 * product's own writer produces.
 *
 * **The document is never written back.** OpenClaw strips JSON5 comments on save,
 * so a round-trip through its writer would quietly delete the user's comments —
 * which is exactly why this is a reader and not a rewriter.
 */
function parseConfigText(raw: string): OpenClawJson {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return { kind: "invalid", reason: "the document is not a JSON object" };
		return { kind: "object", value: parsed, recovered: false };
	} catch {
		// fall through to the JSON5 arm
	}
	const stripped = stripJson5Comments(raw);
	try {
		const parsed: unknown = JSON.parse(stripped);
		if (!isRecord(parsed)) return { kind: "invalid", reason: "the document is not a JSON object" };
		return { kind: "object", value: parsed, recovered: true };
	} catch {
		return { kind: "invalid", reason: "not parseable as JSON and not parseable once JSON5 comments are stripped" };
	}
}

/**
 * Remove `//` and block comments, and trailing commas, that are **outside** a
 * string.
 *
 * Hand-written rather than delegated to a JSON5 library: the only JSON5 this
 * product's writer produces is comments (`json5-comments.ts:24-34`), and the
 * string tracking is the part a naive `replace` gets wrong — a URL in a config
 * value contains `//` and stripping to end-of-line would truncate the document.
 *
 * **Trailing commas are handled here because the product names them.** Its own
 * comment on the fallback is "accepts JSON5 syntax such as comments **and
 * trailing commas**" (`utils/parse-json-compat.ts:48`), so a file with a trailing
 * comma parses for OpenClaw and must parse here. Removing one only where the next
 * non-space character closes a container is what keeps `"a", "b"` intact — a
 * blanket `,}` replacement would eat the comma out of an object *value*.
 */
function stripJson5Comments(raw: string): string {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		const next = raw[i + 1];
		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			}
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === "\\") {
				if (next !== undefined) {
					out += next;
					i += 1;
				}
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLine = true;
			i += 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlock = true;
			i += 1;
			continue;
		}
		if (ch === ",") {
			// Look ahead past whitespace: a comma immediately followed by `}` or `]`
			// is a trailing one. Anything else is a real separator and is kept.
			let j = i + 1;
			while (j < raw.length && /\s/.test(raw[j] ?? "")) j += 1;
			const following = raw[j];
			if (following === "}" || following === "]") continue;
		}
		out += ch;
	}
	return out;
}

/**
 * The merged configuration: `configPath` plus every `$include`, deepest last.
 *
 * **The merge is the product's** (`includes.ts:204-207`): arrays concatenate,
 * objects merge recursively, and a primitive takes the *source* — the document being
 * merged in — over the target. Getting the primitive direction backwards inverts
 * every override the user wrote, which is why it is spelled out here and tested.
 *
 * Bounds are the product's too: {@link OPENCLAW_INCLUDE_MAX_DEPTH} over the file
 * chain and {@link OPENCLAW_INCLUDE_MAX_BYTES} per file (`includes.ts:26,31`). A
 * chain deeper than the budget is a failure of *that* include, not of the read —
 * the product isolates a malformed branch the same way
 * (`resolveConfigIncludesForTopLevelKey`, `includes.ts:637-646`), and a document
 * that would not load is worth less to the user than one that loads with a gap the
 * report names.
 */
function resolveOpenClawConfig(
	home: string,
	configPath: string,
	skipped: OpenClawSkipped[],
): {
	value: Record<string, unknown> | null;
	/** The **unsanitized** merge, read only for key *names*. See {@link readMcpServers}. */
	raw: Record<string, unknown> | null;
	files: string[];
	failures: Array<{ path: string; reason: string }>;
} {
	const files: string[] = [];
	const failures: Array<{ path: string; reason: string }> = [];
	const root = readJsonFile(configPath);
	if (root.kind === "absent") return { value: null, raw: null, files, failures };
	if (root.kind === "invalid") {
		skipped.push({ name: configPath, reason: root.reason });
		return { value: null, raw: null, files, failures };
	}
	if (root.recovered)
		skipped.push({
			name: configPath,
			reason:
				"read as JSON5 (it has comments or trailing commas); OpenClaw's own writer strips JSON5 comments on save, so nothing here was written back",
		});

	// The root document is first in the list, so `includeFiles.length > 1` is the
	// test for "an `$include` actually pulled anything in" — which is why the
	// planner's report line uses that and not `> 0`.
	files.push(configPath);
	const merged = resolveIncludes(root.value, configPath, home, 1, new Set([configPath]), files, failures);
	for (const failure of failures)
		skipped.push({ name: failure.path, reason: `its $include could not be applied — ${failure.reason}` });
	return { value: scrubOpenClawCredentials(merged).value, raw: merged, files, failures };
}

/**
 * Resolve one document's `$include` chain, returning the document with its
 * includes merged in.
 *
 * **The direction of the merge is the thing to get right, and it is the opposite of
 * the obvious reading.** The product returns `deepMerge(included, rest)`
 * (`includes.ts:368`): `included` is the *target* and `rest` — the including
 * document's **own** keys, gathered as `siblingKeys` at `:360-366` — is the
 * *source*. Primitives take the source (`includes.ts:204-207`), so **a key written
 * in `openclaw.json` wins over the same key in an included file.** An importer that
 * merged the other way round would silently invert every override the user wrote
 * in the file they actually edited.
 *
 * For an array of includes, `entries.reduce((current, entry) => deepMerge(current,
 * entry.value), {})` (`:336`) makes each **later** include the source, so a later
 * entry wins — the same rule one level down.
 *
 * `basePath` is the file the *current* document lives in, because an include path
 * is resolved relative to **the including file's own directory** (`includes.ts:415-418`)
 * and not to the root configuration's.
 */
function resolveIncludes(
	document: Record<string, unknown>,
	basePath: string,
	home: string,
	depth: number,
	visited: Set<string>,
	files: string[],
	failures: Array<{ path: string; reason: string }>,
): Record<string, unknown> {
	if (depth > OPENCLAW_INCLUDE_MAX_DEPTH) {
		failures.push({
			path: basePath,
			reason: `the $include chain is deeper than the product's own limit of ${OPENCLAW_INCLUDE_MAX_DEPTH}`,
		});
		return { ...document };
	}
	const declared = document[OPENCLAW_INCLUDE_KEY];
	if (declared === undefined) return { ...document };
	// A string or an array of strings (`includes.ts:25`); anything else is a shape
	// the product would reject and this importer reports rather than guesses at.
	const list = Array.isArray(declared) ? declared : [declared];
	const included: Record<string, unknown> = {};
	let resolvedAny = false;
	for (const entry of list) {
		if (typeof entry !== "string" || entry.trim() === "") {
			failures.push({ path: basePath, reason: `\`${OPENCLAW_INCLUDE_KEY}\` holds an entry that is not a file path` });
			continue;
		}
		const resolved = resolveIncludePath(entry, basePath, home);
		if (visited.has(resolved)) {
			failures.push({
				path: resolved,
				reason: "already included by this document — the product detects the cycle and stops",
			});
			continue;
		}
		const loaded = readJsonFile(resolved);
		if (loaded.kind === "absent") {
			failures.push({ path: resolved, reason: "named by $include but not on disk" });
			continue;
		}
		if (loaded.kind === "invalid") {
			failures.push({ path: resolved, reason: loaded.reason });
			continue;
		}
		if (readByteLength(resolved) > OPENCLAW_INCLUDE_MAX_BYTES) {
			failures.push({
				path: resolved,
				reason: `larger than the product's own ${OPENCLAW_INCLUDE_MAX_BYTES}-byte limit for an included file`,
			});
			continue;
		}
		visited.add(resolved);
		files.push(resolved);
		// The included document's own includes resolve against *its* directory and
		// merge into it before it merges here.
		const nested = resolveIncludes(loaded.value, resolved, home, depth + 1, visited, files, failures);
		// Later entries are the source, so a later include wins (`:336`).
		mergeInto(included, nested);
		resolvedAny = true;
	}
	if (!resolvedAny) return { ...document };
	// The document's own keys are the source and therefore win (`:368`).
	const own = { ...document };
	delete own[OPENCLAW_INCLUDE_KEY];
	mergeInto(included, own);
	return included;
}

/** The `$include` path, relative to the including file (`includes.ts:415-418`). */
function resolveIncludePath(includePath: string, basePath: string, home: string): string {
	const dir = basePath.replace(/[\\/][^\\/]*$/, "");
	if (includePath.startsWith("~")) {
		const rest = includePath.slice(1).replace(/^[\\/]+/, "");
		return rest === "" ? home : join(home, ...rest.split(/[\\/]/));
	}
	return join(dir === "" ? "." : dir, ...includePath.split(/[\\/]/));
}

/**
 * `target = merge(target, source)` — arrays concatenate, objects recurse, and a
 * primitive takes the source (`includes.ts:204-207`).
 */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		const existing = target[key];
		if (Array.isArray(existing) && Array.isArray(value)) {
			target[key] = [...existing, ...value];
			continue;
		}
		if (isRecord(existing) && isRecord(value)) {
			mergeInto(existing, value);
			continue;
		}
		target[key] = value;
	}
}

function readByteLength(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** One configuration file, as the three states it can be in. */
function readJsonFile(path: string): OpenClawJson {
	const raw = readText(path);
	if (raw === null) return { kind: "absent" };
	return parseConfigText(raw);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * The agent whose state is read.
 *
 * `agents` is a list whose entries carry an `id` (`agent-scope-config.ts:578-589`
 * reads `resolveAgentConfig(cfg, id)`), and OpenClaw's own store is laid out under
 * `agents/<id>/agent` — so a user with several agents has several stores and this
 * importer reads the **first configured agent**, which is the one the product calls
 * `main` when none is named. Naming one agent and saying so is the honest move: a
 * reader that merged several would produce a `RawOpenClaw` describing no single
 * install.
 */
function readAgentId(settings: Record<string, unknown> | null): string {
	const agents = settings?.agents;
	if (isRecord(agents) && typeof agents.default === "string" && agents.default.trim() !== "") {
		return agents.default.trim();
	}
	if (Array.isArray(agents)) {
		for (const entry of agents) {
			if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim() !== "") return entry.id.trim();
		}
	}
	return DEFAULT_AGENT_ID;
}

/** `agents[].agentDir` for the agent whose state is read, when the file states one. */
function readConfiguredAgentDir(settings: Record<string, unknown> | null, agentId: string): string | undefined {
	const agents = settings?.agents;
	const entries = Array.isArray(agents)
		? agents
		: isRecord(agents) && Array.isArray(agents.list)
			? agents.list
			: isRecord(agents)
				? Object.values(agents).filter(isRecord)
				: [];
	for (const entry of entries) {
		if (isRecord(entry) && entry.id === agentId && typeof entry.agentDir === "string") return entry.agentDir;
	}
	return undefined;
}

/**
 * The retired keys carried by an agent settings document
 * (`settings-manager.ts:51-77`).
 *
 * Four checks, and two of them are not top-level keys at all: `skills` is
 * rejected **as an object** (it is a `string[]` now) and `retry.maxDelayMs` is
 * nested inside `retry`. Reporting either as a top-level key name would be a
 * finding the user cannot act on.
 */
export function collectRetiredAgentSettingKeys(settings: Record<string, unknown> | null): string[] {
	if (settings === null) return [];
	const found: string[] = [];
	if (Object.hasOwn(settings, "queueMode")) found.push("queueMode");
	if (Object.hasOwn(settings, "websockets")) found.push("websockets");
	if (isRecord(settings.skills)) found.push("skills (as an object)");
	if (isRecord(settings.retry) && Object.hasOwn(settings.retry, "maxDelayMs")) found.push("retry.maxDelayMs");
	return found;
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/**
 * The retired keys across every configured server, sorted and de-duplicated.
 *
 * **Read from the unsanitized merge**, for a reason that is not obvious and that a
 * first draft got wrong: one of the nine rejected keys is `client_key`, and
 * `looksLikeSecretName` matches the `KEY` inside it — so the credential scrub had
 * already deleted the key before this ran, and a configuration OpenClaw would
 * refuse to load was reported as clean. A diagnosis that reads the sanitized copy
 * diagnoses the sanitized document rather than the user's.
 */
function collectRetiredMcpKeys(raw: Record<string, unknown> | null): string[] {
	if (raw === null) return [];
	const mcp = raw.mcp;
	if (!isRecord(mcp)) return [];
	const servers = mcp.servers;
	if (!isRecord(servers)) return [];
	const found = new Set<string>();
	for (const entry of Object.values(servers)) {
		if (!isRecord(entry)) continue;
		for (const key of Object.keys(entry)) {
			if (OPENCLAW_RETIRED_MCP_KEYS.has(key)) found.add(key);
		}
		if (isRecord(entry.codex) && Object.hasOwn(entry.codex, OPENCLAW_RETIRED_MCP_CODEX_KEY)) {
			found.add(`codex.${OPENCLAW_RETIRED_MCP_CODEX_KEY}`);
		}
	}
	return [...found].sort();
}

/**
 * `mcp.servers`, copied with every credential value removed, plus the names.
 *
 * See {@link scrubOpenClawCredentials} for what "removed" covers; this only has to
 * find the map. A `mcp` with no `servers` is an empty object rather than `null`,
 * for the reason `qoder-read.ts` gives: the key's absence is information, and an
 * absent map reads the same as an empty one in a report either way.
 *
 * The names are read from the **original** entry, before the scrub runs — reading
 * them from the scrubbed copy is the bug this split exists to prevent, since the
 * scrubbed copy no longer has the keys at all.
 */
function readMcpServers(
	settings: Record<string, unknown> | null,
	raw: Record<string, unknown> | null,
): {
	servers: Record<string, unknown>;
	names: Record<string, { env?: string[]; headers?: string[] }>;
} {
	const empty = {
		servers: {} as Record<string, unknown>,
		names: {} as Record<string, { env?: string[]; headers?: string[] }>,
	};
	const mcp = settings?.mcp;
	if (!isRecord(mcp)) return empty;
	const servers = mcp.servers;
	if (!isRecord(servers)) return empty;
	// The names come from the **unsanitized** merge. Reading them from `servers`
	// finds only the keys the scrub kept, so a credential-shaped name — `MY_TOKEN`,
	// `authorization` — would be *absent from the report that exists to name it*,
	// which is the exact silence these names are here to prevent.
	const rawMcp = raw?.mcp;
	const rawServers = isRecord(rawMcp) && isRecord(rawMcp.servers) ? rawMcp.servers : {};
	const out: Record<string, unknown> = {};
	const names: Record<string, { env?: string[]; headers?: string[] }> = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRecord(entry)) {
			out[name] = entry;
			continue;
		}
		const source = isRecord(rawServers[name]) ? rawServers[name] : entry;
		const record: { env?: string[]; headers?: string[] } = {};
		if (isRecord(source.headers)) record.headers = Object.keys(source.headers);
		if (isRecord(source.env)) record.env = Object.keys(source.env);
		if (record.env !== undefined || record.headers !== undefined) names[name] = record;
		out[name] = entry;
	}
	return { servers: out, names };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Remove every credential value from a document, keeping the structure.
 *
 * **Four classes of thing are removed, and the fourth is the one that matters.**
 *
 *   1. **Slots the product itself registers sensitive.** `mcp.servers[].env` and
 *      `.headers` are wrapped in `.register(sensitive)` in the product's own schema
 *      (`zod-schema.mcp-server.ts:20-24,33-37`) — every value, whatever it is called.
 *   2. **Keys that read as credentials.** {@link looksLikeSecretName} covers
 *      `apiKey`, `accessToken`, `clientSecret`, `password`.
 *   3. **Named slots.** {@link OPENCLAW_CREDENTIAL_SLOTS} covers the ones whose name
 *      is not credential-shaped but whose *contents* are: `clientCert`/`clientKey`
 *      are TLS key material, `authProfiles` and `tokens` hold login state.
 *   4. **The URL.** `mcp.servers[].url` is validated only as http/https
 *      (`zod-schema.mcp-server.ts:26`), so `https://user:token@host/mcp` is a valid
 *      server as far as OpenClaw is concerned, and the credential is inside a
 *      string every scanner treats as a safe identifier.
 *
 * The fourth is why this function records {@link looksLikeSecretName}'s miss rather
 * than trusting it: **the key is called `url` and there is nothing to key-name-match
 * on.** The guard that catches it is `urlCredentialProblem`, and it lives in the
 * planner — the value cannot be dropped here and the server kept, because a URL with
 * its userinfo removed points at nothing.
 *
 * **Every key a user typed as a server name survives.** See
 * {@link OPENCLAW_CREDENTIAL_SLOTS} for why that distinction is load-bearing.
 */
export function scrubOpenClawCredentials<T>(value: T): { value: T; removed: string[] } {
	const removed: string[] = [];
	const walk = (node: unknown, path: string, level: number): unknown => {
		if (level > MAX_CREDENTIAL_SCAN_DEPTH) return node;
		if (Array.isArray(node)) return node.map((entry, index) => walk(entry, `${path}[${index}]`, level + 1));
		if (!isRecord(node)) return node;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(node)) {
			const here = path === "" ? key : `${path}.${key}`;
			// A user-keyed map: recurse **through** every entry and keep them all,
			// whatever they are named. This is the branch that saves a server called
			// `keyboard-mcp` from `looksLikeSecretName`'s `KEY` substring — see
			// {@link OPENCLAW_NAME_MAP_KEYS} for why that is a real failure and not a
			// hypothetical one.
			if (OPENCLAW_NAME_MAP_KEYS.has(key) && isRecord(child)) {
				const entries: Record<string, unknown> = {};
				for (const [name, entry] of Object.entries(child)) {
					const entryPath = `${here}.${name}`;
					entries[name] = isRecord(entry) ? walk(entry, entryPath, level + 1) : entry;
				}
				out[key] = entries;
				continue;
			}
			// A *slot* is removed; a *name* is not walked as a slot.
			if (looksLikeSecretName(key) || OPENCLAW_CREDENTIAL_SLOTS.has(key)) {
				removed.push(here);
				continue;
			}
			if (key === "url" && typeof child === "string") {
				// Kept, and the planner decides: `urlCredentialProblem` is the only
				// thing that can tell a credential inside a URL from an ordinary one,
				// and it needs the string.
				out[key] = child;
				continue;
			}
			out[key] = walk(child, here, level + 1);
		}
		return out;
	};
	return { value: walk(value, "", 0) as T, removed };
}

/**
 * The names under `env`, read from the **unsanitized** merge.
 *
 * `env` carries an index signature (`types.openclaw.ts:57-67`): a *string* value
 * directly under it is the documented "sugar" for `env.vars`, and a record value
 * is a structured block (`shellEnv` and friends). Both shapes are named; neither
 * is read, and no value is ever returned.
 */
function readOpenClawEnvNames(raw: Record<string, unknown> | null): string[] {
	const env = raw?.env;
	if (!isRecord(env)) return [];
	const names = new Set<string>();
	for (const [key, value] of Object.entries(env)) {
		if (typeof value === "string") names.add(key);
		else if (isRecord(value)) for (const inner of Object.keys(value)) names.add(inner);
	}
	return [...names].sort();
}

// ---------------------------------------------------------------------------
// Workspace bootstrap documents
// ---------------------------------------------------------------------------

/**
 * The workspace documents: `AGENTS.md` read, the other five named.
 *
 * **They live in the workspace, not the state directory.** `resolveWorkspaceBootstrapPath`
 * resolves them against `workspaceRoot` (`workspace-bootstrap-policy.ts:51-57`), so
 * a migration that looked for them under `~/.openclaw` would find nothing on every
 * machine and could not tell that apart from a machine that has none.
 *
 * **`TOOLS.md` is absent from {@link OPENCLAW_BOOTSTRAP_FILENAMES} on purpose** —
 * see that constant's own note. It is not reported here either, for the same
 * reason: `openclaw doctor --fix` folds it into `AGENTS.md`.
 */
function readWorkspace(
	cwd: string,
	skipped: OpenClawSkipped[],
): { agentsMd: string | null; others: OpenClawBootstrapDoc[] } {
	const others: OpenClawBootstrapDoc[] = [];
	let agentsMd: string | null = null;
	for (const name of OPENCLAW_BOOTSTRAP_FILENAMES) {
		const path = join(cwd, ...name.split("/"));
		if (name === OPENCLAW_PRIMARY_INSTRUCTION_FILE) {
			agentsMd = readText(path);
			continue;
		}
		// `MEMORY.md` is resolved by the product only when it is a **real file and
		// not a symlink** (`root-memory-files.ts:41-52`); the legacy spelling is
		// skipped outright (`:72`). Both facts change the answer, so both are
		// reported rather than reduced to "not present".
		if (name === "MEMORY.md" && agentsMd === null) {
			const real = readRealFileOnly(path);
			const legacy = readRealFileOnly(join(cwd, OPENCLAW_LEGACY_MEMORY_FILENAME));
			others.push({
				name,
				present: real !== null,
				...(legacy !== null && real === null ? { legacySpelling: true } : {}),
			});
			continue;
		}
		others.push({ name, present: existsSync(path) });
	}
	if (agentsMd === null)
		skipped.push({
			name: join(cwd, OPENCLAW_PRIMARY_INSTRUCTION_FILE),
			reason: `not present in this workspace — OpenClaw reads its bootstrap documents from the directory the agent runs in, not from the state directory, so a home whose sessions ran elsewhere has its instructions somewhere this importer was not pointed at`,
		});
	return { agentsMd, others };
}

/** A bootstrap document this build has no counterpart for, and whether it was there. */
export interface OpenClawBootstrapDoc {
	name: string;
	present: boolean;
	/** Set for a `MEMORY.md` found only under the legacy `memory.md` spelling. */
	legacySpelling?: boolean;
}

/**
 * `path`'s contents when it is a regular file and **not** a symlink.
 *
 * `lstatSync` rather than `statSync`: `root-memory-files.ts:41-52` requires
 * `entry.isFile() && !entry.isSymbolicLink()` on a *directory entry*, which is
 * `lstat` semantics — `statSync` follows the link and would report a symlink to a
 * real file as a plain file, which is the case the product refuses.
 */
function readRealFileOnly(path: string): string | null {
	try {
		if (lstatSync(path).isSymbolicLink()) return null;
	} catch {
		return null;
	}
	return readText(path);
}

// ---------------------------------------------------------------------------
// Assets and session counts
// ---------------------------------------------------------------------------

/** Skills from both managed roots, de-duplicated by folder name, managed first. */
function readSkillRoots(configDir: string): {
	assets: RawFile[];
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
} {
	const assets: RawFile[] = [];
	const collisions: Array<{ name: string; kept: string; dropped: string }> = [];
	const seen = new Set<string>();
	for (const root of openclawSkillDirs(configDir)) {
		for (const file of readSkillDirs(root)) {
			if (seen.has(file.name)) {
				collisions.push({
					name: file.name,
					kept: assets.find((a) => a.name === file.name)?.sourcePath ?? root,
					dropped: file.sourcePath,
				});
				continue;
			}
			seen.add(file.name);
			assets.push(file);
		}
	}
	return { assets, assetCollisions: collisions };
}

/** Directories that exist under `root`, sorted; unreadable is empty. */
export function openclawDirNames(root: string): string[] {
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}
