// Alma's user state as read from a home directory: SQLite settings, the MCP and
// hook files, skills from Alma's own two roots, memory, and the roots named but
// never read. Read `alma-home.ts` first for every path claim.
// Long-form design notes: docs/dev/migration-sources.md

import { Database } from "bun:sqlite";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	ALMA_CREDENTIAL_FILES,
	ALMA_CREDENTIAL_TABLES,
	ALMA_IDENTITY_DOCS,
	ALMA_SETTINGS_HANDLE,
	ALMA_SETTINGS_KEYS_READ,
	type AlmaEnv,
	almaCronDir,
	almaDbPath,
	almaDotDir,
	almaHooksPath,
	almaIdentityDocPath,
	almaMcpPath,
	almaMemoryDir,
	almaOwnSkillRoots,
	almaPlainDir,
	almaPluginsDir,
	almaRoots,
	almaThreadsArchiveDir,
	almaTreeHasContent,
	almaWorktreesDir,
	isAlmaCredentialKey,
} from "./alma-home.ts";
import { isRecord, readAttachments, readJson, readText, tildePath } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { parseFrontmatter } from "./skills.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** One thing the walk found and did not carry over. `name` is a label, not a resolved path, never a value from a credential-shaped key. */
export interface AlmaSkipped {
	name: string;
	reason: string;
}

/** One provider as far as this importer is concerned: an id, a label, and a kind. */
export interface AlmaProvider {
	/** The `providers.id` a model reference is written against. */
	id: string;
	/** The user's own name for it. Safe to print; it is not a credential. */
	name: string;
	/** One of the eighteen `type` values. The list is in `alma-home.ts`'s siblings. */
	type: string;
}

/** Alma's settings, as far as this importer is concerned. A whitelist, so it is small. */
export interface AlmaSettings {
	/** `general.theme` — `'light' | 'dark' | 'system'`, or absent. */
	theme?: string;
	/** `general.windowsShell` — which shell a Windows session runs commands in. */
	windowsShell?: string;
	/** `chat.defaultModel` — `"<providerId>:<modelId>"`, or absent. */
	defaultModel?: string;
	/** `chat.temperature`, `chat.maxTokens`, `chat.autoCompact.*` — reported, not claimed. */
	temperature?: number;
	maxTokens?: number;
	autoCompact?: { enabled?: boolean; threshold?: number; keepRecentMessages?: number };
	/** `security.autoApproveToolRequests` — the only approval switch Alma has. */
	autoApproveToolRequests?: boolean;
	/** `agents.enabled` and `agents.allowSubagentDelegation`. */
	agentsEnabled?: boolean;
	allowSubagentDelegation?: boolean;
	/** `memory.enabled`, `memory.autoSummarize`, `memory.autoRetrieve`. */
	memoryEnabled?: boolean;
	/** `network.timeout` / `network.retryAttempts` — the proxy is a credential and is not read. */
	networkTimeout?: number;
	/** `ui.fontSize`. */
	fontSize?: number;
	/** `workspace.path` — the archiver's one workspace, not a per-thread directory. */
	workspacePath?: string;
	/** `tools.hashlineEdit` — read by the app, absent from the shipped interface. */
	hashlineEdit?: boolean;
}

/**
 * Alma's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* of something, or a line
 * saying why neither happened. No field holds a credential and no field holds a
 * conversation.
 */
export interface RawAlma {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the roots were resolved from, kept for the report. */
	env: AlmaEnv;
	/** All four roots; `userData` is `null` where the platform has no such path. */
	roots: ReturnType<typeof almaRoots>;
	/** True when any of the four roots exists and holds something. */
	present: boolean;
	/** Where the settings row was read from, or `null` when there was no database. */
	settingsDbPath: string | null;
	/** Whether that database could be opened and the settings row read. */
	settingsRead: boolean;
	/** Why the settings could not be read, or `null`. */
	settingsProblem: string | null;
	/** The whitelisted settings, or `null` when there was no row. */
	settings: AlmaSettings | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Top-level keys present in `settings_data` that this importer did not read. */
	unhandledSettings: string[];
	/** Every provider's id, name and type. `api_key` is not among the columns selected. */
	providers: AlmaProvider[];
	// Long-form design notes: docs/dev/migration-sources.md
	/** The one workspace Alma's thread archive is written under, or `null`. */
	archiveWorkspacePath: string | null;
	/** How many `.md` files the thread archive holds, none of them read. */
	archiveCount: number;
	/** How many threads the database holds, none of them read here. */
	threadCount: number;
	/** `mcp.json`, copied without interpretation; `headers` and `env` values are not. */
	mcpServers: Record<string, unknown>;
	/** The MCP file's path, named whether or not it was there. */
	mcpPath: string;
	/** `hooks.json`'s `hooks` block, verbatim and uninterpreted. */
	hooks: unknown;
	/** The hook file's path, named whether or not it was there. */
	hooksPath: string;
	/** Skills from Alma's **own two roots**, first match wins by lowercased name. */
	assets: RawFile[];
	/** A skill name answered by both own roots; the second was not read. */
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/** Memory documents from `~/.config/alma/memory`, plus `MEMORY.md` itself. */
	memory: RawFile[];
	/** Which of the five identity documents were on disk, by name. */
	identityDocs: string[];
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: AlmaSkipped[];
}

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function almaDirectoryEntries(dir: string): Dirent[] {
	try {
		return [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Open the database read-only, run `work`, and close it whatever happens. */
function withDatabase<T>(dbPath: string, work: (db: Database) => T): T | null {
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		return work(db);
	} catch {
		return null;
	} finally {
		try {
			db?.close();
		} catch {
			// Closing a handle that never opened, or that is already gone, is not a
			// failure worth propagating: the caller already has its answer.
		}
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** The settings blob, or `null` when it could not be read as a JSON object. The three states are an object, an empty object, and `null`. */
function readAlmaSettingsBlob(blob: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(blob);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Read one string, treating a non-string as absent rather than coercing it. */
function stringAt(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

/** Read one number, treating a non-number as absent rather than coercing it. */
function numberAt(source: unknown, key: string): number | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read one boolean, treating a non-boolean as absent rather than coercing it. */
function booleanAt(source: unknown, key: string): boolean | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "boolean" ? value : undefined;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Turn the raw blob into the whitelisted `AlmaSettings`. */
function narrowAlmaSettings(blob: Record<string, unknown>): AlmaSettings {
	const general = blob.general;
	const chat = blob.chat;
	const security = blob.security;
	const agents = blob.agents;
	const memory = blob.memory;
	const network = blob.network;
	const ui = blob.ui;
	const tools = blob.tools;
	const settings: AlmaSettings = {};

	const theme = stringAt(general, "theme");
	if (theme !== undefined) settings.theme = theme;
	const windowsShell = stringAt(general, "windowsShell");
	if (windowsShell !== undefined) settings.windowsShell = windowsShell;
	const defaultModel = stringAt(chat, "defaultModel");
	if (defaultModel !== undefined) settings.defaultModel = defaultModel;
	const temperature = numberAt(chat, "temperature");
	if (temperature !== undefined) settings.temperature = temperature;
	const maxTokens = numberAt(chat, "maxTokens");
	if (maxTokens !== undefined) settings.maxTokens = maxTokens;
	if (isRecord(chat) && isRecord(chat.autoCompact)) {
		const compact: NonNullable<AlmaSettings["autoCompact"]> = {};
		const enabled = booleanAt(chat.autoCompact, "enabled");
		if (enabled !== undefined) compact.enabled = enabled;
		const threshold = numberAt(chat.autoCompact, "threshold");
		if (threshold !== undefined) compact.threshold = threshold;
		const keep = numberAt(chat.autoCompact, "keepRecentMessages");
		if (keep !== undefined) compact.keepRecentMessages = keep;
		if (Object.keys(compact).length > 0) settings.autoCompact = compact;
	}
	const approve = booleanAt(security, "autoApproveToolRequests");
	if (approve !== undefined) settings.autoApproveToolRequests = approve;
	const agentsEnabled = booleanAt(agents, "enabled");
	if (agentsEnabled !== undefined) settings.agentsEnabled = agentsEnabled;
	const delegate = booleanAt(agents, "allowSubagentDelegation");
	if (delegate !== undefined) settings.allowSubagentDelegation = delegate;
	const memoryEnabled = booleanAt(memory, "enabled");
	if (memoryEnabled !== undefined) settings.memoryEnabled = memoryEnabled;
	const networkTimeout = numberAt(network, "timeout");
	if (networkTimeout !== undefined) settings.networkTimeout = networkTimeout;
	const fontSize = numberAt(ui, "fontSize");
	if (fontSize !== undefined) settings.fontSize = fontSize;
	const workspacePath = stringAt(blob.workspace, "path");
	if (workspacePath !== undefined) settings.workspacePath = workspacePath;
	const hashline = booleanAt(tools, "hashlineEdit");
	if (hashline !== undefined) settings.hashlineEdit = hashline;

	return settings;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Alma's skills from its own two roots, first match wins by lowercased name, with each refusal and collision reported. */
function readAlmaSkills(
	configDir: string,
	workspacePath: string | null,
	home: string,
	skipped: AlmaSkipped[],
): { assets: RawFile[]; collisions: RawAlma["assetCollisions"] } {
	const assets: RawFile[] = [];
	const collisions: RawAlma["assetCollisions"] = [];
	const claimed = new Map<string, string>();
	for (const dir of almaOwnSkillRoots(configDir, workspacePath)) {
		if (!existsSync(dir)) continue;
		const label = tildePath(home, dir);
		for (const entry of almaDirectoryEntries(dir)) {
			if (!entry.isDirectory()) continue;
			const skillDir = join(dir, entry.name);
			const content = readText(join(skillDir, "SKILL.md"));
			if (content === null) {
				skipped.push({
					name: `${label}/${entry.name}`,
					reason: "a directory with no readable SKILL.md, which is the one file Alma defines a skill by",
				});
				continue;
			}
			// Alma's own parser: the fence first, then `name`, then `description`.
			// Both are refused rather than defaulted, because a skill with no
			// description is one the agent cannot know when to reach for.
			if (!/^---\r?\n/.test(content)) {
				skipped.push({
					name: `${label}/${entry.name}/SKILL.md`,
					reason: "no YAML frontmatter — Alma's skill parser refuses a SKILL.md that does not open with `---`",
				});
				continue;
			}
			const { data } = parseFrontmatter(content);
			if (typeof data.name !== "string" || data.name.trim() === "") {
				skipped.push({
					name: `${label}/${entry.name}/SKILL.md`,
					reason: 'frontmatter carries no `name`, which Alma requires (SKILL.md missing required "name" field)',
				});
				continue;
			}
			if (typeof data.description !== "string" || data.description.trim() === "") {
				skipped.push({
					name: `${label}/${entry.name}/SKILL.md`,
					reason:
						'frontmatter carries no `description`, which Alma requires (SKILL.md missing required "description" field)',
				});
				continue;
			}
			const key = data.name.toLowerCase();
			const earlier = claimed.get(key);
			if (earlier !== undefined) {
				collisions.push({ name: data.name, kept: earlier, dropped: label });
				continue;
			}
			claimed.set(key, label);
			const { attachments, attachmentSkips } = readAttachments(skillDir);
			assets.push({
				name: data.name,
				sourcePath: join(skillDir, "SKILL.md"),
				content,
				attachments,
				attachmentSkips,
			});
		}
	}
	return { assets, collisions };
}

// Long-form design notes: docs/dev/migration-sources.md
/** `~/.config/alma/memory/` and `MEMORY.md`, as `RawFile`s. The index and the entries are told apart by name, and this reader does not second-guess a file name. */
function readAlmaMemory(configDir: string, home: string, skipped: AlmaSkipped[]): RawFile[] {
	const out: RawFile[] = [];
	const index = almaIdentityDocPath(configDir, "MEMORY.md");
	const indexText = readText(index);
	if (indexText !== null) {
		out.push({
			name: "MEMORY.md",
			sourcePath: index,
			content: indexText,
			detail: "Alma's memory index — the list of what the agent is told to remember",
		});
	}
	const dir = almaMemoryDir(configDir);
	if (!existsSync(dir)) return out;
	for (const entry of almaDirectoryEntries(dir)) {
		if (!entry.isFile()) continue;
		const path = join(dir, entry.name);
		const content = readText(path);
		if (content === null) {
			skipped.push({ name: tildePath(home, path), reason: "present but unreadable" });
			continue;
		}
		out.push({
			name: entry.name,
			sourcePath: path,
			content,
			detail: "a memory entry in Alma's own memory directory",
		});
	}
	return out;
}

// Long-form design notes: docs/dev/migration-sources.md
/** `mcp.json`, with the two credential channels removed before anything else sees the entry. `headers` is dropped whole, `env` values become names, and the URL is checked in the planner. */
function readAlmaMcp(
	configDir: string,
	home: string,
	skipped: AlmaSkipped[],
): { mcpServers: Record<string, unknown>; mcpPath: string } {
	const path = almaMcpPath(configDir);
	const document = readJson(path);
	const servers = document.mcpServers;
	if (servers === undefined) return { mcpServers: {}, mcpPath: path };
	if (!isRecord(servers)) {
		skipped.push({
			name: tildePath(home, path),
			reason:
				"`mcpServers` is not a JSON object, so no server was read from it — Alma's own reader iterates its keys and would fail the same way",
		});
		return { mcpServers: {}, mcpPath: path };
	}
	const out: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRecord(entry)) {
			out[name] = entry;
			continue;
		}
		const kept: Record<string, unknown> = { ...entry };
		if (isRecord(kept.headers)) {
			skipped.push({
				name: `${tildePath(home, path)} → mcpServers.${name}.headers`,
				reason:
					"a header block was dropped whole — a header value is an ordinary place for a bearer token and this importer reads none of them. " +
					"The header names were not printed either",
			});
			delete kept.headers;
		}
		if (isRecord(kept.env)) {
			const names = Object.keys(kept.env);
			const keptNames: Record<string, unknown> = {};
			for (const key of names) keptNames[key] = null;
			kept.env = keptNames;
		}
		out[name] = kept;
	}
	return { mcpServers: out, mcpPath: path };
}

// Long-form design notes: docs/dev/migration-sources.md
/** `hooks.json`'s `hooks` block, verbatim. A file with no `hooks` key produces `undefined`, which is not the same as a file that held nothing. */
function readAlmaHooks(configDir: string, home: string, skipped: AlmaSkipped[]): { hooks: unknown; hooksPath: string } {
	const path = almaHooksPath(configDir);
	if (!existsSync(path)) return { hooks: undefined, hooksPath: path };
	const document = readJson(path);
	if (document.hooks === undefined) {
		skipped.push({
			name: tildePath(home, path),
			reason: "no `hooks` key — Alma's own reader starts from `{ hooks: {} }` and rewrites the file on every change",
		});
		return { hooks: undefined, hooksPath: path };
	}
	return { hooks: document.hooks, hooksPath: path };
}

// Long-form design notes: docs/dev/migration-sources.md
/** Read one Alma home. Resolves against `home` and `env` only and never calls `os.homedir()`, so a test that asserts on content must pass `env`. */
export function readAlma(home: string, env: AlmaEnv = process.env): RawAlma {
	const roots = almaRoots(home, env);
	const skipped: AlmaSkipped[] = [];
	const configDir = roots.configDir;

	const dbPath = roots.userData === null ? null : almaDbPath(roots.userData);

	// Settings. Three failures kept apart, because "there is no database" and
	// "there is one and this row is damaged" are different sentences and only the
	// second is a problem.
	let settingsBlob: Record<string, unknown> | null = null;
	let settingsRead = false;
	let settingsProblem: string | null = null;
	if (dbPath === null) {
		settingsProblem =
			"this platform has no application-data directory this importer resolves, so Alma's userData root was not located and its database was not opened";
	} else if (!existsSync(dbPath)) {
		settingsProblem = "no `chat_threads.db` at the userData path — Alma creates it on first launch";
	} else {
		const row = withDatabase(dbPath, (db) =>
			db.query("SELECT settings_data FROM app_settings WHERE id = ?").get(ALMA_SETTINGS_HANDLE),
		);
		if (row === null) {
			settingsProblem =
				"the database opened but no `app_settings` row could be read — an empty or older-schema file, or one the app holds locked";
		} else {
			const blob = (row as { settings_data?: unknown }).settings_data;
			if (typeof blob !== "string") {
				settingsProblem = "the `app_settings` row exists but `settings_data` is not text";
			} else {
				const parsed = readAlmaSettingsBlob(blob);
				if (parsed === null) {
					settingsProblem =
						"the `app_settings` row exists but its `settings_data` is not a JSON object — a half-written or hand-edited blob, which is a different answer from one that read and held nothing";
				} else {
					// An empty object is still a row that was read, and it says so: the
					// difference between "Alma stored no settings" and "we could not read
					// them" is the difference between silence and a report line.
					settingsBlob = parsed;
					settingsRead = true;
				}
			}
		}
	}
	const settings = settingsBlob === null ? null : narrowAlmaSettings(settingsBlob);
	const unhandledSettings =
		settingsBlob === null
			? []
			: Object.keys(settingsBlob)
					.filter((key) => !ALMA_SETTINGS_KEYS_READ.includes(key))
					.sort();

	// Providers, and nothing but their identity. The column list is explicit.
	const providers: AlmaProvider[] = [];
	let threadCount = 0;
	if (dbPath !== null && existsSync(dbPath)) {
		const rows = withDatabase(dbPath, (db) => db.query("SELECT id, name, type FROM providers ORDER BY name ASC").all());
		for (const row of rows ?? []) {
			const record = row as { id?: unknown; name?: unknown; type?: unknown };
			if (typeof record.id !== "string") continue;
			providers.push({
				id: record.id,
				name: typeof record.name === "string" ? record.name : record.id,
				type: typeof record.type === "string" ? record.type : "unknown",
			});
		}
		const counted = withDatabase(dbPath, (db) => db.query("SELECT COUNT(*) AS n FROM chat_threads").get());
		threadCount = Number((counted as { n?: unknown } | null)?.n ?? 0);
		if (!Number.isInteger(threadCount) || threadCount < 0) threadCount = 0;
	}

	// The archiver's one workspace: the settings key first, the app-created
	// `Default` row second. Neither is a per-thread directory — see
	// `alma-home.ts`.
	let archiveWorkspacePath = settings?.workspacePath ?? null;
	if (archiveWorkspacePath === null && dbPath !== null && existsSync(dbPath)) {
		const defaultPath = roots.userData === null ? null : join(roots.userData, "workspaces", "default");
		if (defaultPath !== null) {
			const found = withDatabase(dbPath, (db) =>
				db.query("SELECT path FROM workspaces WHERE path = ?").get(defaultPath),
			);
			const rowPath = (found as { path?: unknown } | null)?.path;
			if (typeof rowPath === "string") archiveWorkspacePath = rowPath;
		}
	}

	let archiveCount = 0;
	if (archiveWorkspacePath !== null) {
		const dir = almaThreadsArchiveDir(archiveWorkspacePath);
		archiveCount = almaDirectoryEntries(dir).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
	}

	const { mcpServers, mcpPath } = readAlmaMcp(configDir, home, skipped);
	const { hooks, hooksPath } = readAlmaHooks(configDir, home, skipped);
	const { assets, collisions } = readAlmaSkills(configDir, archiveWorkspacePath, home, skipped);
	const memory = readAlmaMemory(configDir, home, skipped);

	const identityDocs: string[] = [];
	for (const name of ALMA_IDENTITY_DOCS) {
		try {
			if (statSync(almaIdentityDocPath(configDir, name)).isFile()) identityDocs.push(name);
		} catch {
			// Absent is the ordinary state for four of the five and gets no line.
		}
	}

	// The roots that exist but are not read, each named once with the reason it is
	// named rather than opened. These are the lines that stop a report from
	// reading as "Alma had nothing here".
	if (roots.userData !== null) {
		skipped.push({
			name: tildePath(home, roots.userData),
			reason:
				`Alma's Electron userData root — opened read-only for \`app_settings\`, \`providers\` and the thread count, and never for anything else. ` +
				`It also holds ${ALMA_CREDENTIAL_FILES.join(", ")}, none of which was opened, and the tables ${ALMA_CREDENTIAL_TABLES.join(", ")}, ` +
				"none of whose columns was selected",
		});
	}
	// One line per key the user's blob **actually carries** and this importer did
	// not read. Iterating the whole catalogue instead would put fourteen credential
	// lines under a user who has two, and would report a key the user's file has
	// never contained — the difference between a report and a leaflet.
	for (const name of unhandledSettings) {
		skipped.push({
			name: `app_settings.settings_data → ${name}`,
			reason: isAlmaCredentialKey(name)
				? "present in Alma's settings blob and deliberately not read: it is a credential or a container of one. The name is the report; nothing under it was opened"
				: "present in Alma's settings blob and not read — this importer has no mapping for it and no note about it, so it was left where it is",
		});
	}
	skipped.push({
		name: almaPluginsDir(configDir),
		reason:
			"installed plugins, named and not read: a plugin is an installed directory with a plugin.json, its own skills/, agents/, hooks/hooks.json and mcp.json inside it, " +
			"and its state and credentials live under the userData plugin-storage directory",
	});
	skipped.push({
		name: almaCronDir(configDir),
		reason:
			"Alma's scheduled jobs, named and not read: a cron entry is a prompt plus a delivery channel (Telegram, Discord), and neither has an equivalent here",
	});
	skipped.push({
		name: almaWorktreesDir(home),
		reason:
			"Alma's git worktrees under ~/alma/worktrees, named and not read: a worktree is a checkout of the user's own repository, not agent state",
	});
	skipped.push({
		name: almaDotDir(home),
		reason:
			"~/.alma holds bin/, npm-cache/, activity-records/ and cache/ — an installed CLI's binaries, an npm cache, screenshots and a cache directory. " +
			"None of it is configuration, so nothing here was read",
	});
	skipped.push({
		name: almaPlainDir(home),
		reason:
			"~/alma (no leading dot — a different directory from ~/.alma) holds the browser extension's stable copy and worktrees/, and the extension's config.json is " +
			`{ port, token } — a credential. The root is named so its absence from the import is not read as an empty one`,
	});

	const present =
		almaTreeHasContent(configDir) ||
		(roots.userData !== null && almaTreeHasContent(roots.userData)) ||
		almaTreeHasContent(roots.dotDir) ||
		almaTreeHasContent(roots.plainDir);

	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		env,
		roots,
		present,
		settingsDbPath: dbPath,
		settingsRead,
		settingsProblem,
		settings,
		unhandledSettings,
		providers,
		archiveWorkspacePath,
		archiveCount,
		threadCount,
		mcpServers,
		mcpPath,
		hooks,
		hooksPath,
		assets,
		assetCollisions: collisions,
		memory,
		identityDocs,
		skipped,
	};
}
