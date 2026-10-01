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

/**
 * One environment variable T3 Code stored against a provider instance.
 *
 * A `sensitive` entry is deliberately **not** carried. T3 does not persist the
 * value of one: it writes the six-dot marker `SECRET_REDACTED = "••••••"`
 * (`apps/server/src/serverSettings.ts:147`, applied by `redactSecret` at
 * `:159`) and keeps the real value in the secret store under
 * `<stateDir>/secrets` (`apps/server/src/config.ts:163`), swapping it back in
 * whenever the settings are read (`materializeProviderEnvironmentSecrets` at
 * `serverSettings.ts:699`, wired into `getSettings` at `:1127` and the change
 * stream at `:779`). So a sensitive entry read here holds a marker, not a value
 * — and writing that marker into the target's settings would produce an
 * environment variable that looks configured and silently fails. The entry is
 * skipped with a reason instead, and the `secrets/` directory is never opened.
 *
 * The redaction is also the reason an `environment` array read from disk can be
 * trusted to hold real values on its non-sensitive entries: the marker is
 * written *instead of* a value, never alongside one.
 */
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

/**
 * What T3 Code's `settings.json` gave up.
 *
 * **Absence is spelled two different ways here, and which one a field uses is
 * part of its contract rather than an accident of how it was read.** A field read
 * out of the document with {@link text} is a `string`, and an empty one means the
 * file stated nothing; a field read as a *shape* is `| null`, and `null` means
 * the document held nothing of that shape. The two are not interchangeable, and
 * the difference is load-bearing for {@link T3Settings.runtimeMode} — it is
 * spelled out in `t3-plan.ts`.
 *
 * They are kept apart because a `string | null` that is only ever `null`-or-a-
 * non-empty-string is a lie the type tells about the value: it invites
 * `value ?? fallback`, which on an empty string does **not** fall back, so the
 * fail-open branch a reader writes to be safe silently never runs. That is not
 * hypothetical — an empty string is what T3's own absence decodes to here, and
 * the one setting where importing a default would be wrong is a `string`.
 *
 * Why the file can be silent: T3's writer strips defaults before persisting
 * (`stripDefaultServerSettings`, `apps/server/src/serverSettings.ts:387-419`,
 * called at `:550` against `PERSISTED_SERVER_SETTINGS_DEFAULTS`), and that
 * default is the *decoded* schema default, so a setting left at T3's own default
 * is simply not in the file. `defaultModelSelection` is the one field where the
 * reader cannot tell "absent" from "present and null" — both are `null` here —
 * and the mapping is the same either way, so the distinction is not carried.
 */
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

/**
 * A model T3 Code was pointed at.
 *
 * Two shapes exist on the wire and {@link T3Settings} normalizes them.
 * `ModelSelectionWire` is `{ instanceId, model, options? }`
 * (`packages/contracts/src/orchestration.ts:75-79`). Selections persisted before
 * the driver/instance split carry `{ provider, model }` instead, and T3's own
 * schema absorbs that with a pre-decoding transform that takes `provider` as the
 * routing key when `instanceId` is absent (`:92-107`). This reader reads the slug
 * the same way, so a selection written by an older build is not dropped for
 * naming a field the current one no longer has.
 */
export interface T3ModelSelection {
	/** The routing key: an instance id, or the legacy driver slug it was promoted from. */
	instanceId: string;
	/** The model id as T3 stored it, before any registry lookup. */
	model: string;
	/** Whether {@link instanceId} came from the legacy `provider` field. */
	fromLegacyProvider: boolean;
}

/**
 * One conversation thread, as the listing phase sees it.
 *
 * Deliberately carries no message text. Listing is what a session picker runs
 * before the user has chosen anything, and a listing that read every
 * conversation would make opening the picker cost the whole history — the one
 * input in this migration the architecture is explicit about reading once, and
 * only for the sessions that were actually chosen.
 */
export interface T3SessionRow {
	/** `projection_threads.thread_id`, which is what T3 resumes by. */
	id: string;
	/** The thread's title, or `""` when T3 left it empty. */
	title: string;
	/**
	 * The effective working directory, or `null` when neither column gave one.
	 *
	 * `projection_threads.worktree_path` wins over
	 * `projection_projects.workspace_root` (`005_Projections.ts:11` and `:27`),
	 * because a thread opened in a worktree ran in the worktree and not in the
	 * project it belongs to. There is no `cwd` column anywhere in the schema —
	 * verified against the DDL rather than taken on report — so this join is the
	 * only place a working directory can come from.
	 */
	cwd: string | null;
	/** `created_at` in epoch ms, 0 when T3 stored something unparseable. */
	startedAt: number;
	/**
	 * How many tool-lifecycle activity rows this thread accumulated.
	 *
	 * Carried so the report can say what a transcript will *not* contain instead of
	 * letting a user discover it. T3 records a tool call as an activity row
	 * (`projection_thread_activities`) rather than as a message, and the row is
	 * shaped for T3's own UI: its columns are `activity_id`, `thread_id`, `turn_id`,
	 * `tone`, `kind`, `summary`, `payload_json`, `created_at` and a `sequence`
	 * added by `008_ProjectionThreadActivitySequence.ts` — a one-line summary of
	 * what happened and an opaque payload, with no argument list and no result
	 * paired with it. Reconstructing a tool call from that is a separate piece of
	 * work with its own failure modes, so this importer carries the conversation
	 * and names the count instead.
	 */
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
	/**
	 * The thing's own name — a filename, a directory name, or a table name.
	 *
	 * A path is allowed only where the thing *is* a path and has no other name:
	 * the two entries about state directories name themselves that way because a
	 * user who ran a dev build recognises `~/.t3/dev` and nothing else. Values are
	 * never here, and a sensitive environment entry contributes its *variable's*
	 * name — see {@link T3EnvironmentVariable}.
	 */
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
	/**
	 * Every top-level key `settings.json` holds, whatever became of it.
	 *
	 * Carried so the report can account for the rest of the file by name instead of
	 * leaving a settings document half-migrated and unexplained. `settings` alone
	 * cannot do it: it holds the seven keys this importer *found* something in,
	 * and the sixty-odd it did not are exactly the ones a user would notice
	 * vanishing.
	 */
	settingsKeys: string[];
	/** `client-settings.json`, or `null`. */
	clientSettings: Record<string, unknown> | null;
	/** `desktop-settings.json`, or `null`. */
	desktopSettings: Record<string, unknown> | null;
	/**
	 * Everything seen and passed over, each with a reason.
	 *
	 * Sessions are **not** here. They are read through
	 * {@link t3SessionRows} and {@link t3SessionMessages}, on the two-phase
	 * schedule the rest of this migration uses: list the candidates, let the user
	 * choose, then read only what they chose.
	 */
	skipped: T3Skipped[];
}

/**
 * Read a T3 Code installation.
 *
 * Nothing here throws. Every file is optional, every JSON document may be
 * malformed, and the database may belong to a build with a different schema — a
 * T3 release that renamed a column should cost this importer one query, not the
 * whole run. The failures land in {@link RawT3Code.skipped} with their own
 * reasons, so a report can say what was not read instead of leaving a user to
 * work out whether the migration was partial.
 *
 * No credential is read. T3's sensitive environment values are not in
 * `settings.json` at all — see {@link T3EnvironmentVariable} — and the `secrets/`
 * directory they do live in is never opened.
 */
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

/**
 * Pull the migration-relevant keys out of a decoded `settings.json`.
 *
 * The keys this returns are the ones the target has an equivalent for. Everything
 * else in T3's schema — worktree cleanup policy, storage cleanup, response
 * streaming, device hosts, observability, Tailscale — belongs to a desktop app
 * with its own process model and has no meaning here, and
 * `t3-plan.ts` accounts for the rest of the file with one aggregate note rather
 * than pretending each key was considered and rejected.
 */
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

/**
 * The non-sensitive environment variables of every configured provider instance.
 *
 * `providerInstances` is `Record<ProviderInstanceId, ProviderInstanceConfig>`
 * (`packages/contracts/src/settings.ts:1292`), where each entry has a `driver`
 * slug and an `environment` array
 * (`packages/contracts/src/providerInstance.ts:104-110` — `name`, `value`,
 * `sensitive`, and a `valueRedacted` flag). The per-driver `config`
 * blob is `Schema.Unknown` by design — each driver registers its own decoder with
 * the runtime registry — so this reader does not go looking inside it for a key
 * or a token, and a blob that happens to hold one is never copied.
 *
 * The legacy single-instance `providers` map (`settings.ts:1279`) is read too.
 * It is the same information in an older shape, and skipping it would drop the
 * environment of any user whose T3 predates the instance split.
 */
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

/**
 * Normalize one `ModelSelection`, reading T3's legacy `{ provider, model }`.
 *
 * An `instanceId` wins over a `provider` when both are present, which is the
 * order T3's own transform uses (`orchestration.ts:99-107`): the current field is
 * authoritative and the legacy one is the fallback for payloads written before
 * the split. That transform passes the legacy slug straight through as the
 * routing key — `defaultInstanceIdForDriver` (`:148` in `providerInstance.ts`) is
 * named in its comment as what the slug stands for, not called by it — and so
 * does this, which is all a reader outside T3's registry can do with it.
 */
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

/**
 * Every conversation thread, without their messages.
 *
 * **This is not T3's own thread listing, and the two differences are deliberate.**
 * T3 has two: `listThreadRows` takes every row
 * (`orchestration/Layers/ProjectionSnapshotQuery.ts:562-601`) and
 * `listActiveThreadRows` drops what the user archived or deleted
 * (`:610-652`). This query is the first with two filters layered on it, and each
 * one is about what a migration should resurrect rather than about what a session
 * picker should show:
 *
 *  - a **soft-deleted** row is excluded on both sides, because the user threw it
 *    away and importing it would put back something they removed;
 *  - an **archived** row is *not* excluded. T3 hides it from the main list, but
 *    `listArchivedThreadRows` (`:701-...`) is a second view of the same rows and
 *    an archived conversation is still one the user paid for. Excluding it would
 *    be a filter about the layout of T3's sidebar leaking into a migration.
 *
 * The join to `projection_projects` is not optional: the thread row has no
 * directory of its own and `workspace_root` is the only other place one can come
 * from (see {@link T3SessionRow.cwd}).
 *
 * The order is `created_at, thread_id` — T3's own tiebreak for a listing
 * (`:601`) — and the second key is load-bearing: `created_at` is not unique, and
 * an unstable order would make a session picker show two different lists for two
 * identical runs.
 *
 * Returns `[]` for a database that is absent, unreadable, or from a build whose
 * schema differs — a T3 release that renamed a projection table should cost this
 * importer its conversations and nothing else. The reason is not returned,
 * because this runs inside the listing phase, which reports its own notes; the
 * settings read is unaffected either way.
 */
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

/**
 * Tool-lifecycle activity counts, per thread.
 *
 * Best-effort and separate from the thread query on purpose: the activities
 * table is the one most likely to be absent or renamed, because it is the newest
 * of the three projections and the one this importer cares about least. Folding
 * its failure into the thread query would let a T3 build that renamed it take the
 * user's conversations down with it — losing the thing they wanted in exchange
 * for the count of the thing they did not.
 */
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

/**
 * One thread's messages, in T3's own order.
 *
 * `role IN ('user', 'assistant', 'reasoning')` rather than the two roles a
 * transcript is usually made of: `reasoning` is a role T3 records in this same
 * table and is a real part of what the thread contains. `system` is not carried
 * because it is the desktop client's own framing — a migration has already put
 * the conversation in a different client, and replaying another client's system
 * preamble reads as though the assistant had said it.
 *
 * `ORDER BY created_at ASC, message_id ASC` is T3's ordering
 * (`ProjectionThreadMessages.ts:225`) and the second key is load-bearing:
 * `created_at` alone is not unique, so dropping it yields a different order from
 * the one the user's own client shows.
 */
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

/**
 * Name a state directory that has content and was not the one read.
 *
 * `t3Root` reads the production directory when both exist — see `t3-home.ts` for
 * why that is the right tree — so a dev build's state is left behind. It is named
 * here rather than left for the user to find, because "the migration ignored a
 * directory full of my conversations" and "there was no dev tree" look identical
 * from the outside until you go and look.
 *
 * An empty sibling produces nothing. "There is a `dev` directory holding nothing"
 * is not information a migration report needs.
 */
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

/**
 * Name the attachments directory when there is one.
 *
 * An imported conversation carries its text and nothing else, so a message that
 * points at a file leaves a path in the transcript that resolves to nothing once
 * the migration is done. That is worth one report line rather than a user
 * discovering it while scrolling back through a conversation they just imported.
 *
 * The files themselves are not copied. They are conversation-scoped binary blobs
 * with names T3 chose, and a target history entry is a text transcript; putting
 * the bytes somewhere and rewriting every reference to point at them is a
 * different migration from the one this importer does, and doing half of it would
 * be the worse outcome.
 */
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
