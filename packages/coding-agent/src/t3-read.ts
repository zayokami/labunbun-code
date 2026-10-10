import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tildePath } from "./migrate-core.ts";
import {
	t3AttachmentsDir,
	t3ClientSettingsPath,
	t3DesktopSettingsPath,
	t3Root,
	t3SettingsPath,
	t3StateDatabase,
	t3StateDirs,
} from "./t3-home.ts";

// Long-form design notes: docs/dev/migration-sources.md
/** One environment variable T3 Code stored against a provider instance. */
export interface T3EnvironmentVariable {
	/** The variable's name, as T3 stored it. */
	name: string;
	/** The value, present only for a non-sensitive entry. */
	value: string;
	/** The provider instance this entry belonged to. */
	instanceId: string;
	/** The driver slug that instance used — `codex`, `claudeAgent`, `antigravity`, … */
	driver: string;
}

// Long-form design notes: docs/dev/migration-sources.md
/** What T3 Code's `settings.json` gave up. */
export interface T3Settings {
	/** `defaultRuntimeMode`, or `""` when the file states none. See {@link T3Settings}. */
	runtimeMode: string;
	/** `defaultModelSelection`, already resolved from T3's legacy shape. */
	modelSelection: T3ModelSelection | null;
	/** `textGenerationModelSelection`, which wins over the default for text turns. */
	textModelSelection: T3ModelSelection | null;
	/** `defaultTheme`, or `""` when the file states none. T3 stores an id, not a palette. */
	theme: string;
	/** Non-sensitive environment variables from every provider instance. */
	environment: T3EnvironmentVariable[];
	/**
	 * Per-project model overrides, keyed by project id.
	 *
	 * Carried so the report can name how many projects had one. Not applied: the
	 * target has no per-project model setting, and a project id in T3 is not a
	 * path this importer can resolve to one.
	 */
	projectOverrides: string[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** A model T3 Code was pointed at. */
export interface T3ModelSelection {
	/** The routing key: an instance id, or the legacy driver slug it was promoted from. */
	instanceId: string;
	/** The model id as T3 stored it, before any registry lookup. */
	model: string;
	/** Whether {@link instanceId} came from the legacy `provider` field. */
	fromLegacyProvider: boolean;
}

// Long-form design notes: docs/dev/migration-sources.md
/** One conversation thread, as the listing phase sees it. */
export interface T3SessionRow {
	/** `projection_threads.thread_id`, which is what T3 resumes by. */
	id: string;
	/** The thread's title, or `""` when T3 left it empty. */
	title: string;
	// Long-form design notes: docs/dev/migration-sources.md
	/** The effective working directory, or `null` when neither column gave one. */
	cwd: string | null;
	/** `created_at` in epoch ms, 0 when T3 stored something unparseable. */
	startedAt: number;
	// Long-form design notes: docs/dev/migration-sources.md
	/** How many tool-lifecycle activity rows this thread accumulated. */
	toolCount: number;
}

/** One message of a {@link T3SessionRow}. */
export interface T3SessionMessage {
	/** `projection_thread_messages.role` — one of `user`, `assistant`, `system`, `reasoning`. */
	role: string;
	/** The message text, which for this schema is the whole message. */
	text: string;
	/** `created_at` in epoch ms, 0 when unparseable. */
	at: number;
}

/** One thing seen and not read, and why. */
export interface T3Skipped {
	// Long-form design notes: docs/dev/migration-sources.md
	/** The thing's own name — a filename, a directory name, or a table name. */
	name: string;
	/** The reason, in the words the report prints. */
	reason: string;
}

/** Everything T3 Code gave up. */
export interface RawT3Code {
	/** The state directory read, or `null` when there was nothing to read. */
	stateDir: string | null;
	/** `settings.json`, or `null` when it was absent or unparseable. */
	settings: T3Settings | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Every top-level key `settings.json` holds, whatever became of it. */
	settingsKeys: string[];
	/** `client-settings.json`, or `null`. */
	clientSettings: Record<string, unknown> | null;
	/** `desktop-settings.json`, or `null`. */
	desktopSettings: Record<string, unknown> | null;
	// Long-form design notes: docs/dev/migration-sources.md
	/** Everything seen and passed over, each with a reason. Sessions are not here. */
	skipped: T3Skipped[];
}

// Long-form design notes: docs/dev/migration-sources.md
/** Read a T3 Code installation. */
export function readT3Code(home: string): RawT3Code {
	const skipped: T3Skipped[] = [];
	const stateDir = t3Root(home);
	if (stateDir === null) {
		return {
			stateDir: null,
			settings: null,
			settingsKeys: [],
			clientSettings: null,
			desktopSettings: null,
			skipped,
		};
	}

	noteOtherStateDirs(home, stateDir, skipped);
	noteAttachments(stateDir, skipped);

	const settingsDocument = readJsonFile(t3SettingsPath(stateDir), "settings.json", skipped);
	const clientSettings = readJsonFile(t3ClientSettingsPath(stateDir), "client-settings.json", skipped);
	const desktopSettings = readJsonFile(t3DesktopSettingsPath(stateDir), "desktop-settings.json", skipped);

	return {
		stateDir,
		settings: settingsDocument === null ? null : readSettings(settingsDocument, skipped),
		settingsKeys: settingsDocument === null ? [] : Object.keys(settingsDocument).sort(),
		clientSettings,
		desktopSettings,
		skipped,
	};
}

// Long-form design notes: docs/dev/migration-sources.md
/** Pull the migration-relevant keys out of a decoded `settings.json`. */
function readSettings(document: Record<string, unknown>, skipped: T3Skipped[]): T3Settings {
	return {
		runtimeMode: text(document.defaultRuntimeMode),
		modelSelection: modelSelection(document.defaultModelSelection),
		textModelSelection: modelSelection(document.textGenerationModelSelection),
		theme: text(document.defaultTheme),
		environment: readEnvironment(document.providerInstances, document.providers, skipped),
		projectOverrides: projectOverrideKeys(document.projectSettingsOverrides),
	};
}

// Long-form design notes: docs/dev/migration-sources.md
/** The non-sensitive environment variables of every configured provider instance. */
function readEnvironment(instances: unknown, legacyProviders: unknown, skipped: T3Skipped[]): T3EnvironmentVariable[] {
	const found: T3EnvironmentVariable[] = [];
	const read = (source: unknown, legacy: boolean) => {
		const record = asRecord(source);
		if (record === null) return;
		for (const [key, entry] of Object.entries(record)) {
			const instance = asRecord(entry);
			if (instance === null) continue;
			const entries = instance.environment;
			if (!Array.isArray(entries)) continue;
			// The current map is keyed by a user-chosen instance id and each entry
			// names its own driver. The legacy map is keyed by the driver slug itself,
			// so there the key stands in when the entry does not repeat it.
			const driver = text(instance.driver) || (legacy ? key : "");
			for (const item of entries) {
				const variable = asRecord(item);
				if (variable === null) continue;
				const name = text(variable.name);
				if (name === "") continue;
				if (variable.sensitive === true) {
					// See T3EnvironmentVariable: the value here is a redaction marker.
					skipped.push({
						name,
						reason: "sensitive value, kept in T3's secrets directory rather than in its settings",
					});
					continue;
				}
				found.push({ name, value: text(variable.value), instanceId: key, driver });
			}
		}
	};
	read(instances, false);
	read(legacyProviders, true);
	return found;
}

/** The project ids T3 holds a model override for. */
function projectOverrideKeys(value: unknown): string[] {
	const record = asRecord(value);
	if (record === null) return [];
	return Object.keys(record).sort();
}

// Long-form design notes: docs/dev/migration-sources.md
/** Normalize one `ModelSelection`, reading T3's legacy `{ provider, model }`. */
function modelSelection(value: unknown): T3ModelSelection | null {
	const record = asRecord(value);
	if (record === null) return null;
	const model = text(record.model);
	if (model === "") return null;
	const instanceId = text(record.instanceId);
	if (instanceId !== "") return { instanceId, model, fromLegacyProvider: false };
	const provider = text(record.provider);
	if (provider !== "") return { instanceId: provider, model, fromLegacyProvider: true };
	return null;
}

// Long-form design notes: docs/dev/migration-sources.md
/** Every conversation thread, without their messages. */
export function t3SessionRows(home: string): T3SessionRow[] {
	const stateDir = t3Root(home);
	if (stateDir === null) return [];
	const dbPath = t3StateDatabase(stateDir);
	if (!existsSync(dbPath)) return [];
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		const rows = db
			.query(
				`SELECT t.thread_id AS id, t.title AS title, t.created_at AS created_at,
				        t.worktree_path AS worktree_path, p.workspace_root AS workspace_root
				 FROM projection_projects p
				 JOIN projection_threads t ON t.project_id = p.project_id
				 WHERE p.deleted_at IS NULL AND t.deleted_at IS NULL
				 ORDER BY t.created_at ASC, t.thread_id ASC`,
			)
			.all() as Array<Record<string, unknown>>;
		const toolCounts = toolActivityCounts(db);
		const toolsByThread = new Map(toolCounts.map((row) => [text(row.thread_id), Number(row.total) || 0]));
		return rows.map((row) => ({
			id: text(row.id),
			title: text(row.title),
			cwd: text(row.worktree_path) || text(row.workspace_root) || null,
			startedAt: timestamp(row.created_at),
			toolCount: toolsByThread.get(text(row.id)) ?? 0,
		}));
	} catch {
		return [];
	} finally {
		try {
			db?.close();
		} catch {
			// closing a failed handle is best-effort
		}
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Tool-lifecycle activity counts, per thread. */
function toolActivityCounts(db: Database): Array<Record<string, unknown>> {
	try {
		return db
			.query(
				`SELECT thread_id, COUNT(*) AS total FROM projection_thread_activities
				 WHERE tone = 'tool' GROUP BY thread_id`,
			)
			.all() as Array<Record<string, unknown>>;
	} catch {
		return [];
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** One thread's messages, in T3's own order. */
export function t3SessionMessages(home: string, threadId: string): T3SessionMessage[] {
	const stateDir = t3Root(home);
	if (stateDir === null) return [];
	const dbPath = t3StateDatabase(stateDir);
	if (!existsSync(dbPath)) return [];
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { readonly: true });
		const rows = db
			.query(
				`SELECT role, text, created_at
				 FROM projection_thread_messages
				 WHERE thread_id = ? AND role IN ('user', 'assistant', 'reasoning')
				 ORDER BY created_at ASC, message_id ASC`,
			)
			.all(threadId) as Array<Record<string, unknown>>;
		return rows
			.map((row) => ({ role: text(row.role), text: text(row.text), at: timestamp(row.created_at) }))
			.filter((message) => message.text !== "");
	} catch {
		return [];
	} finally {
		try {
			db?.close();
		} catch {
			// closing a failed handle is best-effort
		}
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Name a state directory that has content and was not the one read. */
function noteOtherStateDirs(home: string, read: string, skipped: T3Skipped[]): void {
	for (const dir of t3StateDirs(home)) {
		if (dir === read || !treeHasContent(dir)) continue;
		skipped.push({
			name: tildePath(home, dir),
			reason:
				"a development build's state directory, and this run read the installed build's tree instead — which is the one " +
				"an installed t3 code would resume. Nothing here was merged in: two builds' settings and sessions are separate " +
				"histories, and this import does not write one over the other",
		});
	}
}

// Long-form design notes: docs/dev/migration-sources.md
/** Name the attachments directory when there is one. */
function noteAttachments(stateDir: string, skipped: T3Skipped[]): void {
	if (!treeHasContent(t3AttachmentsDir(stateDir))) return;
	skipped.push({
		name: "attachments",
		reason:
			"files a conversation referenced: imported transcripts carry their text only, so a message naming one of these will " +
			"point at a path that is not in this home. The originals are left where t3 code put them",
	});
}

/** A JSON file's contents, or `null` — with a reason in `skipped` for why not. */
function readJsonFile(path: string, name: string, skipped: T3Skipped[]): Record<string, unknown> | null {
	if (!existsSync(path)) {
		skipped.push({ name, reason: "not in the state directory" });
		return null;
	}
	let text_: string;
	try {
		text_ = readFileSync(path, "utf8");
	} catch {
		skipped.push({ name, reason: "could not be read" });
		return null;
	}
	try {
		return asRecord(JSON.parse(text_));
	} catch {
		skipped.push({ name, reason: "not valid JSON" });
		return null;
	}
}

/** T3 stores timestamps as ISO strings; anything else reads as 0. */
function timestamp(value: unknown): number {
	const raw = text(value);
	if (raw === "") return 0;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : 0;
}

/** A directory that exists and holds something, as `sourceHasContent` reads it. */
function treeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
