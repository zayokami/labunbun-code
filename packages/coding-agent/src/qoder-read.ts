/**
 * Qoder's user state, as read from a home directory.
 *
 * Read `qoder-home.ts` first — every path claim below is that module's, and it
 * says which of them are quoted from the product and which are chosen. The
 * standing caveats for this source, in one place:
 *
 *   - **`settings.json` holds much less than a reader would expect, and the
 *     bundle says exactly how much.** The desktop app reads settings by field,
 *     and every call that names a literal names one of five keys: `hooks`,
 *     `mcpServers`, `enabledPlugins`, `pluginConfigs` and
 *     `chatSession.builtInBrowserHosts`. There is no field call for a permission
 *     mode, a theme or a model. Those three are what a migration from most other
 *     sources is mostly about, and on Qoder 0.4.3 **this file has none of them** —
 *     which is the single most load-bearing fact in this source and the reason
 *     `planQoder` claims exactly one scalar.
 *   - **There is no credential to migrate, and this is verified rather than
 *     assumed.** Every one of the four `apiKey` occurrences in the bundle is in a
 *     BYOK flow or an IPC message, and the key itself is sealed before it is
 *     stored: `g5t.seal` builds `{schemaVersion: 1, apiKey}` and hands the JSON
 *     to `protectionService.protectString`, and what lands in SQLite is
 *     `byok_model_credentials.encrypted_payload BLOB NOT NULL`. The plaintext key
 *     is never in `settings.json`. The MCP path is the one that could still hold
 *     one, and {@link scrubQoderCredentials} exists because Qoder's own MCP
 *     reader throws on a literal `authorization` or `token` — a future version
 *     could grow one under a name nobody has seen.
 *   - **Session transcripts are counted and never opened.** The path is settled
 *     (`vze`: `projects/<slug>/<sessionId>.jsonl`) but the record format is
 *     written by the native `qoder-runtime-host` binary, which is in neither the
 *     JavaScript bundle nor the SDK. See `qoder-session.ts`.
 *   - **One configuration home is read, and the other is named.** Qoder resolves a
 *     single home per process — `mc()` returns one `{user, project}` pair — so a
 *     home holding both `.qoder` and `.qoder-cn` is two installs, not two halves
 *     of one.
 *
 * **Nothing here throws.** Every read that fails becomes a line in
 * {@link RawQoder.skipped} naming what failed and why, which is the convention
 * `antigravity-read.ts` uses: a migration that aborts on one damaged file loses
 * every other source's import to make a point about that file.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord, parseJsonc, readSkillDirs, readText, tildePath } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";
import {
	QODER_DEFAULT_DIR,
	QODER_DESKTOP_DATA_DIR,
	QODER_DIR_NAME_REJECTIONS,
	QODER_MEMORY_ENTRY_PATTERN,
	QODER_MEMORY_INDEX_NAME,
	QODER_MERGE_SHALLOW,
	QODER_MERGE_UNION,
	QODER_PROTOTYPE_KEYS,
	type QoderEnv,
	type QoderSettingsSource,
	qoderConfigDir,
	qoderDesktopStorePath,
	qoderDirNameRejection,
	qoderLocalSettingsPath,
	qoderMemoryDir,
	qoderOtherConfigDir,
	qoderProjectMcpPath,
	qoderProjectSettingsPath,
	qoderProjectsDir,
	qoderSettingsPath,
	qoderSkillsDirs,
	qoderTreeHasContent,
} from "./qoder-home.ts";

/**
 * One thing the walk found and did not carry over, with the reason.
 *
 * `name` is a **label, not a resolved path**, and the same convention
 * `antigravity-read.ts` uses: a bare name where that is unambiguous, a
 * forward-slashed relative label where it is not. Nothing here ever holds a value
 * read out of a credential-shaped key — see {@link RawQoder.skipped}.
 */
export interface QoderSkipped {
	name: string;
	reason: string;
}

/** A JSON document in the three states one can be in when it is on disk. */
type QoderJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/** A file's text, or why it is not available. `null` is never the answer. */
type QoderText = { kind: "text"; value: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/**
 * Qoder's user state, as one read of one home.
 *
 * Every field is a value read out of a file, a *count* of something, or a line
 * saying why neither happened. No field holds a credential and no field holds a
 * conversation.
 */
export interface RawQoder {
	/** The home directory every root was resolved against. */
	home: string;
	/** The environment block the home was resolved from, kept for the report. */
	env: QoderEnv;
	/**
	 * The configuration home that answered: `$QODER_CONFIG_DIR` when set, else
	 * `<cli home or home>/<directory name>`.
	 *
	 * Always a path, never a read: a home that has never installed Qoder still
	 * has the right answer for where one *would* be, and a report that printed a
	 * "not found" line for every absent path would bury the ones that matter.
	 * {@link RawQoder.settings} is `null` in that case.
	 */
	configDir: string;
	/** The other build's configuration home, named whether or not it exists. */
	otherConfigDir: string;
	/** True when the home resolved above exists and holds something. */
	present: boolean;
	/**
	 * Why `QODER_CONFIG_DIR_NAME` was not used, or `null`.
	 *
	 * The SDK **throws** on an invalid name rather than falling back —
	 * `${configDirNameEnv} must be a valid directory name` /
	 * `must not use a protected directory name` — so a Qoder configured that way
	 * is a Qoder that will not start. This importer falls back to `.qoder` and
	 * reports it, because silently reading a directory the product refused to
	 * read would import a tree Qoder itself rejects.
	 */
	rejectedDirName: string | null;
	/** `<home>/settings.json` — the **user** layer's path, whatever else was read. */
	settingsPath: string;
	/**
	 * The settings layers that were found and parsed, in the order applied.
	 *
	 * One entry for a home that only ever wrote `~/.qoder/settings.json`, and three
	 * for a project with a local override. Kept so the report can say which file a
	 * key came from; nothing reads them a second time, and the credentials in them
	 * were already dropped (see {@link scrubQoderCredentials}).
	 */
	settingsLayers: QoderSettingsLayer[];
	/**
	 * Which layer last carried each top-level key, and where that layer's file is.
	 *
	 * The report's answer to "why does my project say something my user settings do
	 * not". See {@link mergeQoderSettings} for what "last carried" means and what it
	 * deliberately does not mean.
	 */
	provenance: MergedQoderSettings["provenance"];
	/**
	 * The **merged** settings document — what Qoder would actually be running — or
	 * `null` when no layer was readable.
	 *
	 * `null` rather than `{}` on purpose: a home where the file is present and
	 * unusable must say which of "a directory where a file was expected",
	 * "unreadable", "not a JSON object" or "not parseable" applies, and an empty
	 * object would let a planner claim a document was read and held nothing. An
	 * **absent** file produces no line at all — never having written settings is
	 * the ordinary state of a home that only installed the CLI, not a failure.
	 *
	 * **This is the merge, not the user layer**, and that is the whole difference:
	 * six keys — `mcpServers` among them — are merged one level deep rather than
	 * all the way (see {@link QODER_MERGE_SHALLOW}), so an MCP server the user
	 * configured and a project has redefined is one entry with the project's
	 * command, and the user file alone is not a document Qoder is running.
	 * See {@link mergeQoderSettings}.
	 *
	 * Credential-shaped keys have been **removed** from whatever comes back; see
	 * {@link scrubQoderCredentials}.
	 */
	settings: Record<string, unknown> | null;
	/**
	 * `<cwd>/.qoder/.mcp.json`, or `null` when there is no `cwd`.
	 *
	 * Held as a **path and nothing more**: this importer does not stat it, does not
	 * read it and does not know whether it exists. It is in {@link RawQoder} so the
	 * report can name the file a user who has one would otherwise find missing,
	 * because its absence from an import looks exactly like a project with no MCP
	 * configuration. See {@link qoderProjectMcpPath} for why it is not read.
	 */
	projectMcpPath: string | null;
	/**
	 * `mcpServers` **after the merge**, copied without interpretation.
	 *
	 * The desktop reads the field by name (`readField("mcpServers", {})`) and the
	 * SDK writes back to it, so the key is one per settings file — but `mcpServers`
	 * is one of the six {@link QODER_MERGE_SHALLOW} keys, so the **names** here are
	 * the union across the layers that had the key and each **entry** is whatever
	 * the last layer to mention that name said. `provenance.mcpServers` names the
	 * file that supplied the map; it does not mean every entry in it came from
	 * there, and the report line is worded so it does not.
	 *
	 * The `<project>/.qoder/.mcp.json` file is a **separate** location and is not
	 * read: it is not a settings file, so the merge does not reach it, and the SDK's
	 * project layer resolves it against the working directory. It is named in the
	 * report rather than opened.
	 */
	mcpServers: Record<string, unknown>;
	/**
	 * `settings.hooks`, verbatim and uninterpreted.
	 *
	 * Handed over as it stands because {@link normalizeClaudeHooks} in
	 * `migrate-core.ts` is what knows this build's event names, which Qoder's own
	 * reader does not: `hGr` takes **any** key of the `hooks` object as an event
	 * name and never enumerates them, because the dispatcher is in the runtime
	 * binary. Passing the block through and letting the normalizer drop the
	 * events it has no word for is what makes an unknown event a report line
	 * rather than a silent loss.
	 */
	hooks: unknown;
	/**
	 * Memory entries from `<home>/memory`, as {@link RawFile}s, plus the index.
	 *
	 * A memory *entry* is a file named for the day it was written —
	 * {@link QODER_MEMORY_ENTRY_PATTERN} — and `MEMORY.md` beside them is the
	 * index the agent is told to read, not an entry. Both are carried, and the
	 * index is carried as its own rule file so the two do not collapse into one
	 * name.
	 */
	memory: RawFile[];
	/**
	 * Skills from {@link qoderSkillsDirs}, de-duplicated by folder name with the
	 * first root winning, which is Qoder's own precedence order.
	 */
	assets: RawFile[];
	/** A folder name answered by both skill roots; the second was not read. */
	assetCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/**
	 * How many session transcripts are on disk, none of them read.
	 *
	 * A count and not a list, because a list means parsing: see `qoder-session.ts`
	 * for what the transcript format would take to establish.
	 */
	sessionCount: number;
	/** How many project directories those sessions are spread across. */
	projectCount: number;
	/**
	 * The desktop application's SQLite store, **existence-checked only**, or
	 * `null` when no `appData` was supplied.
	 *
	 * The *name* is what a report may print. Nothing in this importer opens it.
	 */
	desktopStore: { path: string; exists: boolean } | null;
	/** Everything seen and not carried over, each with the reason. Sorted by name. */
	skipped: QoderSkipped[];
}

/**
 * The largest depth a credential-shaped key is looked for at.
 *
 * Eight is well past anything `settings.json` nests to — the deepest attested
 * key is three segments (`context.fileFiltering.customIgnoreFilePaths`), and the
 * shallowest merge merge-policy key is one. The cap is here so a pathological
 * document cannot turn a credential scan into a walk of a megabyte-deep
 * structure. A key deeper than this is **left in place**, which is the one thing
 * this function can get wrong; it is stated rather than pretended away.
 */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

/**
 * Key names `looksLikeSecretName` does not catch.
 *
 * That helper matches `TOKEN`, `KEY`, `SECRET`, `PASSWORD` and `CREDENTIAL` as
 * case-insensitive substrings, which covers `apiKey`, `accessToken` and
 * `clientSecret`. It deliberately misses two spellings that are the ones Qoder
 * itself names: `authorization`, which is one of the two keys the product's own
 * MCP reader throws `MCP_CONFIG_STATIC_CREDENTIAL_FORBIDDEN` for, and
 * `bearerToken` — no, `bearerToken` *does* match `TOKEN`; the second one is
 * `password`, which matches, so the real gap is the single word `authorization`.
 */
const QODER_SECRET_KEY = /authorization/i;

/**
 * Settings keys whose value is a **map from a user-chosen name to an entry**.
 *
 * **The distinction this set exists to draw is between a key that names a slot and
 * a key that names a thing.** `headers.authorization` is a slot: the credential is
 * under it, and deleting it removes the credential and nothing else.
 * `mcpServers.keyboard-mcp` is not a slot — it is the *name of an MCP server the
 * user created*, and deleting it deletes the server, its command, its arguments
 * and its working directory, none of which is a secret. A server called
 * `keyboard-mcp` is an ordinary thing to want; `looksLikeSecretName` matches `KEY`
 * inside it and the naive walk took that as a finding.
 *
 * **So the scrub's job is to drop credential-shaped keys *inside* an entry and
 * never the entry itself**, and that is what the recursion below does for these
 * keys: the map's own keys are walked through, each entry's contents are scrubbed
 * normally, and the name is left alone. `headers.authorization` and
 * `env.API_TOKEN` still go, each with its own `skipped` line carrying the full
 * path — which is the guarantee `planQoderMcp` depends on, and why its "a name
 * that reads as a credential was already gone" comment stays true of `env`'s
 * *contents* while no longer being true of the server's own name.
 *
 * **The membership is derived rather than guessed, from two facts in the product.**
 *
 *   - The six {@link QODER_MERGE_SHALLOW} keys are the keys the SDK's own merge
 *     treats as one level deep (`Object.assign` over the top-level map rather than
 *     a walk into each value). A key the product merges *by its own names* is a
 *     map the user keys by hand, which is the property this set needs.
 *   - `hooks` is map-shaped too and is not in that list: the merge concatenates
 *     each event's group arrays (`path.length === 2 && path[0] === "hooks"`),
 *     which is a per-name merge by a different rule. It belongs here for the same
 *     reason, and the reader's own note that `hGr` takes *any* key of `hooks` as
 *     an event name makes it the sharpest case: an event named
 *     `StopSessionSecret` would otherwise take its handlers with it.
 *
 * Nothing attested in Qoder's eighteen `QODER_HOOK_EVENTS` matches a credential
 * word today — checked name by name against both matchers — so this is not a live
 * loss for the hooks block. But the names are the user's, the product does not
 * enumerate them, and the exemption costs nothing.
 */
const QODER_ENTRY_MAP_KEYS: ReadonlySet<string> = new Set([...QODER_MERGE_SHALLOW, "hooks"]);

/**
 * Remove every credential-shaped key from a parsed document, recording each by
 * path and never touching the value.
 *
 * Nothing in Qoder's `settings.json` is *expected* to be a secret — the BYOK key
 * is sealed into SQLite before it is stored, which is why this is a guard rather
 * than a step — and it is written as one because a guard nobody can see is not a
 * guard. The names go into `skipped`; the values are dropped on the floor, so a
 * credential can never reach a planner, a plan, a report or a written file.
 *
 * **The one thing this function gets wrong is a map treated as a generic object**,
 * and {@link QODER_ENTRY_MAP_KEYS} is what it gets right: below one of those keys
 * the immediate children are names the user chose, so they are stepped over and
 * only the entries' own keys are matched. Everything else about the walk is
 * unchanged — same depth cap, same `skipped` labels, same reason string.
 *
 * Depth-limited at {@link MAX_CREDENTIAL_SCAN_DEPTH}, documented there because
 * the depth is where this function could be wrong.
 */
function scrubQoderCredentials(value: Record<string, unknown>, into: QoderSkipped[], prefix: string): void {
	const walk = (node: unknown, path: string[], depth: number): void => {
		if (!isRecord(node) || depth > MAX_CREDENTIAL_SCAN_DEPTH) return;
		for (const [key, nested] of Object.entries(node)) {
			if (QODER_SECRET_KEY.test(key) || looksLikeSecretName(key)) {
				// `file → key.path`, the shape every other line in a report uses. Written
				// as `file.key.path` it reads as one long filename, and the reader is
				// already inconsistent with itself here: the line a few hundred bytes
				// down reports a bad `mcpServers` as `<file> → mcpServers`.
				into.push({
					name: `${prefix} → ${[...path, key].join(".")}`,
					reason: "looks like a credential — name only, value never read",
				});
				delete node[key];
				continue;
			}
			// A map keyed by a name the user chose. The key above was still tested and
			// still deleted if it matched — `mcpServers` does not, and a settings file
			// whose top level carried `apiKey` still loses it. What is exempt is the
			// *next* level: these are the map's own keys, so each is stepped over and
			// only the entry's contents are scrubbed.
			if (QODER_ENTRY_MAP_KEYS.has(key)) {
				if (!isRecord(nested)) continue;
				for (const [entryName, entry] of Object.entries(nested)) {
					walk(entry, [...path, key, entryName], depth + 1);
				}
				continue;
			}
			walk(nested, [...path, key], depth + 1);
		}
	};
	walk(value, [], 0);
}

/**
 * A file's text, or the reason it is not text.
 *
 * `statSync` first rather than opening and catching, because the two failures a
 * caller must tell apart are *absent* and *there but unreadable*, and both would
 * otherwise arrive as exceptions — which would make a home that has never
 * installed Qoder produce a report full of "unreadable" lines. A directory where
 * a file was expected is its own case, and a real one: `<home>/memory` is a
 * directory here and the settings document lives one level up, so a user who has
 * the other arrangement gets a sentence that says which.
 */
function readQoderText(path: string): QoderText {
	let isDirectory: boolean;
	try {
		isDirectory = statSync(path).isDirectory();
	} catch {
		return { kind: "absent" };
	}
	if (isDirectory) return { kind: "unreadable", reason: "a directory where a file was expected" };
	const content = readText(path);
	return content === null ? { kind: "unreadable", reason: "present but unreadable" } : { kind: "text", value: content };
}

/**
 * A JSON document, with the two failures kept apart and one recovery attempted.
 *
 * **The recovery is not speculative here, and the difference from every other
 * source in this repository is worth stating plainly.** Qoder's own two halves
 * disagree: the desktop's `readDocument` parses with `goe`, which rejects a
 * comment or a trailing comma as `SETTINGS_JSON_INVALID`, while the SDK's loader
 * calls `dc`, and `dc(t, path)` is `JSON.parse(lc(t))` where `lc` is a
 * comment-stripper — it skips a leading BOM, then walks the text keeping string
 * literals intact while removing `//` and block comments. `lc` does **not** handle
 * trailing commas, so a file with one fails under **both** halves of the product.
 *
 * So: plain `JSON.parse` first, which is what the desktop does; then `parseJsonc`
 * once; and if that yields a non-empty object the file is read with
 * `recovered: true`, which every caller turns into one line in `skipped`.
 *
 * **This reader's recovery is a strict superset of the product's.** `parseJsonc`
 * strips trailing commas as well as comments, so a file this importer can still
 * read is one **neither** Qoder half would accept — which is the opposite failure
 * from the one the recovery normally covers, and the reason the report line says
 * the desktop would have rejected the file. Reading such a file is the right call
 * for a migration (the user's settings are their settings) and the wrong thing to
 * do silently, which is what the line is for.
 *
 * A fixed phrase for the failure, never the parser's message: a `SyntaxError`
 * from `JSON.parse` quotes the text it choked on, which would put a fragment of
 * the user's file into the report.
 */
function readQoderJson(path: string): QoderJson {
	const text = readQoderText(path);
	if (text.kind === "absent") return { kind: "absent" };
	if (text.kind === "unreadable") return { kind: "invalid", reason: text.reason };
	try {
		const parsed: unknown = JSON.parse(text.value);
		return isRecord(parsed)
			? { kind: "object", value: parsed, recovered: false }
			: { kind: "invalid", reason: "not a JSON object" };
	} catch {
		try {
			const recovered = parseJsonc(text.value);
			if (Object.keys(recovered).length > 0) return { kind: "object", value: recovered, recovered: true };
		} catch {
			// The recovery did not reach the real problem either; reported below.
		}
		return {
			kind: "invalid",
			reason:
				"not parseable as JSON — comments and trailing commas have already been taken out, so the text is damaged rather than decorated",
		};
	}
}

/** The one line a settings document read through {@link parseJsonc} earns. */
const QODER_JSONC_RECOVERY =
	"not parseable as plain JSON — read anyway with comments and trailing commas stripped. Qoder's own SDK reader strips comments too; " +
	"a trailing comma is beyond it, and its desktop reader would have rejected this file outright";

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function qoderDirectoryEntries(dir: string): Dirent[] {
	try {
		return [...readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		// An absent or unreadable directory is not an error here: most of the ones
		// this module looks for are optional, and the caller reports the absence of
		// the thing they were for, not the absence of the directory.
		return [];
	}
}

/**
 * The memory entries in one memory directory, plus the index, as {@link RawFile}s.
 *
 * **Both halves are read and they are not the same kind of thing.** An entry is a
 * file named for the day it was written, matched by
 * {@link QODER_MEMORY_ENTRY_PATTERN} — the product's own discriminator, which its
 * memory reader applies before it reads a file, so nothing else in the directory
 * is treated as an entry. `MEMORY.md` beside them is the index the agent is told
 * to read, and it is carried under its own name rather than folded in with the
 * entries: importing twenty entries and the index as twenty-one would assert
 * something about the index that the product's own reader does not assert.
 *
 * The project-scoped memory directory — `projects/<slug>/memory` — is **not**
 * read here, and the reason is that this function has no `cwd`. It is a function
 * of the directory being migrated into, and `readSources(home, cwd)` has one;
 * `qoder-home.ts` exposes the derivation and `planQoder` names the directory it
 * did not read.
 */
function readQoderMemory(configDir: string, home: string, skipped: QoderSkipped[]): RawFile[] {
	const dir = qoderMemoryDir(configDir);
	if (!existsSync(dir)) return [];
	const files: RawFile[] = [];
	for (const entry of qoderDirectoryEntries(dir)) {
		if (!entry.isFile()) continue;
		const path = join(dir, entry.name);
		const lower = entry.name.toLowerCase();
		const isIndex = lower === QODER_MEMORY_INDEX_NAME.toLowerCase();
		if (!isIndex && !QODER_MEMORY_ENTRY_PATTERN.test(entry.name)) {
			skipped.push({
				name: `${tildePath(home, path)}`,
				reason:
					"not a Qoder memory entry — the product matches a dated YYYY-MM-DD.md name for an entry, and MEMORY.md for the index; " +
					"anything else in the directory is something this importer does not know how to read as a memory",
			});
			continue;
		}
		const content = readQoderText(path);
		if (content.kind !== "text") {
			skipped.push({
				name: tildePath(home, path),
				reason: content.kind === "absent" ? "gone before it could be read" : content.reason,
			});
			continue;
		}
		files.push({
			name: entry.name,
			sourcePath: path,
			content: content.value,
			detail: isIndex
				? "the index beside Qoder's dated memory entries — a list of what the agent is told to remember, in the product's own `- [title](file.md)` form"
				: "a dated Qoder memory entry; the product names these by the day they were written and loads the most recent first",
		});
	}
	return files;
}

/**
 * Skills from both candidate roots, the first root winning a name.
 *
 * Qoder's precedence is the order `qoderSkillsDirs` returns, so a folder present
 * in both is one skill and the second copy is not read. The collision is
 * recorded rather than dropped silently — a user who has the same skill in two
 * places is owed the sentence, and a report claiming one skill where two files
 * were found reads as an importer bug.
 */
function readQoderSkills(
	configDir: string,
	home: string,
	skipped: QoderSkipped[],
): { assets: RawFile[]; collisions: RawQoder["assetCollisions"] } {
	const assets: RawFile[] = [];
	const collisions: RawQoder["assetCollisions"] = [];
	const claimed = new Map<string, string>();
	for (const dir of qoderSkillsDirs(configDir, home)) {
		if (!existsSync(dir)) continue;
		const label = tildePath(home, dir);
		for (const skill of readSkillDirs(dir)) {
			const earlier = claimed.get(skill.name);
			if (earlier !== undefined) {
				collisions.push({ name: skill.name, kept: earlier, dropped: label });
				continue;
			}
			claimed.set(skill.name, label);
			assets.push(skill);
		}
		// `readSkillDirs` passes over a directory with no `SKILL.md` in silence,
		// which is worth a line here because Qoder *defines* a skill as a
		// directory holding one — its own walker treats a directory as a skill only
		// when `join(dir, "SKILL.md")` is a file. A directory that is not one is
		// user content in a directory the agent reads, and silence there reads as
		// a miss.
		for (const entry of qoderDirectoryEntries(dir)) {
			if (!entry.isDirectory()) continue;
			if (claimed.has(entry.name)) continue;
			skipped.push({
				name: `${label}/${entry.name}`,
				reason: "a skill directory with no SKILL.md in it, which is not a skill Qoder loads",
			});
		}
	}
	return { assets, collisions };
}

/**
 * How many transcripts are on disk, spread across how many projects, and how many
 * bytes in total — none of them opened.
 *
 * The layout is the product's own (`vze`), so this walk is reliable about what
 * is *there*: one directory per working directory under `projects/`, and one
 * `<sessionId>.jsonl` per session inside it. The *contents* are a different
 * question and a different piece of work — the writer is the native
 * `qoder-runtime-host` binary, which is in neither the JavaScript bundle nor the
 * SDK, so no record format could be established from bytes. See
 * `qoder-session.ts`.
 *
 * A `.jsonl` file that is not there, and one that is, are counted apart: a user
 * whose projects directory holds directories with no transcript is a real state
 * (a project created and never used, or cleaned up) and the report says so
 * rather than reporting a number that silently excluded them.
 */
export function countQoderSessions(
	configDir: string,
	skipped: QoderSkipped[],
): { sessions: number; projects: number; bytes: number } {
	const projectsDir = qoderProjectsDir(configDir);
	if (!existsSync(projectsDir)) return { sessions: 0, projects: 0, bytes: 0 };
	let sessions = 0;
	let projects = 0;
	let bytes = 0;
	let emptyProjects = 0;
	for (const project of qoderDirectoryEntries(projectsDir)) {
		if (!project.isDirectory()) continue;
		projects += 1;
		let inThisProject = 0;
		for (const file of qoderDirectoryEntries(join(projectsDir, project.name))) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			inThisProject += 1;
			sessions += 1;
			try {
				bytes += statSync(join(projectsDir, project.name, file.name)).size;
			} catch {
				// Measured on a best-effort basis: the file left between the listing
				// and the stat. It is still counted, because it was there a moment
				// ago and the count is what the report leads with.
			}
		}
		if (inThisProject === 0) emptyProjects += 1;
	}
	if (emptyProjects > 0) {
		skipped.push({
			name: "projects/",
			reason:
				`${emptyProjects} of ${projects} project director${emptyProjects === 1 ? "y holds" : "ies hold"} no .jsonl transcript — ` +
				"a project directory the product creates per working directory, so one with nothing in it is a project that was set up and never had a session in it",
		});
	}
	return { sessions, projects, bytes };
}

/**
 * One settings file that was found and parsed, with the layer it stands for.
 *
 * The layer names are `oc`'s: `["user","project","local"]`, which is the SDK's
 * **default** `settingSources`, so a Qoder with all three files present is running
 * on their merge and not on any one of them.
 */
export interface QoderSettingsLayer {
	source: QoderSettingsSource;
	path: string;
	settings: Record<string, unknown>;
}

/**
 * The merge, and who said what.
 *
 * `provenance` is the SDK's own record (`p[f] = {source: d.source, path: d.path}`,
 * overwritten as the layers are applied), and it exists for the report: a key the
 * **local** layer last supplied has to say so, or the user is told their
 * `~/.qoder/settings.json` said something it did not say.
 *
 * Note what provenance records — **the last layer that carried the key**, not the
 * layer whose value survived. Those differ for a key a later layer sets to a value
 * the merge then drops (`undefined`, or a prototype key), and the product reports
 * the former, so this does too. A report that said "the project layer set it" for a
 * key the user layer still governs would be its own kind of wrong.
 */
export interface MergedQoderSettings {
	settings: Record<string, unknown>;
	provenance: Record<string, { source: QoderSettingsSource; path: string }>;
}

const QODER_MERGE_SHALLOW_SET = new Set(QODER_MERGE_SHALLOW);
const QODER_MERGE_UNION_SET = new Set(QODER_MERGE_UNION);
const QODER_PROTOTYPE_SET = new Set(QODER_PROTOTYPE_KEYS);

/** `Ie` — a structural copy that leaves primitives alone. */
function qoderCloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(qoderCloneValue);
	if (isRecord(value)) return qoderCloneRecord(value);
	return value;
}

/** `Et` — a structural copy that drops `undefined` and the three prototype keys. */
function qoderCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value)) {
		if (QODER_PROTOTYPE_SET.has(key) || nested === undefined) continue;
		out[key] = qoderCloneValue(nested);
	}
	return out;
}

/**
 * `pc` — the merge policy for one path within the document.
 *
 * ```js
 * if (uc.has(path) || (path.length === 2 && path[0] === "providers")) return "shallow";
 * if (cc.has(path)) return "union";
 * if (path.length === 2 && path[0] === "hooks") return "concat";
 * // undefined: merge into
 * ```
 *
 * All three conditions are reproduced verbatim. Two notes on what they actually
 * do, because both are easy to read as doing more than they do:
 *
 *   - **`providers` merges one level deep because `providers` is in `uc`.** The
 *     extra `n.length === 2 && n[0] === "providers"` clause is carried because
 *     `pc` has it, but nothing reaches it: a shallow key `continue`s out of `Rn`
 *     before any recursion, so `pc(["providers", name])` is only called from the
 *     branch that handles a target **missing** the key — where the branch's own
 *     `i && o` guard has already failed and the policy is not consulted — and
 *     from there the next path is three segments long, which no clause matches.
 *     An earlier draft of this comment credited the clause with making one
 *     provider entry replace rather than merge all the way down. It does not; the
 *     name in `uc` does. Dropping the clause changes no output, which a mutation
 *     run over this file's tests confirms.
 *   - **`hooks` is matched on arity, not on a name list.** A hook event is
 *     `hooks.<Event>` and its group arrays concatenate, which is why two layers
 *     that both define `PreToolUse` produce both groups rather than one winning.
 */
function qoderMergePolicy(path: string[]): "shallow" | "union" | "concat" | undefined {
	const dotted = path.join(".");
	if (QODER_MERGE_SHALLOW_SET.has(dotted) || (path.length === 2 && path[0] === "providers")) return "shallow";
	if (QODER_MERGE_UNION_SET.has(dotted)) return "union";
	if (path.length === 2 && path[0] === "hooks") return "concat";
	return undefined;
}

/**
 * `Rn` — fold one document into the accumulator, in place.
 *
 * Reproduced statement for statement, including the three shapes that look like
 * bugs and are not to be "fixed" here:
 *
 *   - **A shallow key is merged one level deep, not replaced.** `Object.assign(u,
 *     clone(i))` then `Object.assign(u, clone(o))` is `{...i, ...o}`, so
 *     `mcpServers` gains the later layer's server *names* and loses the earlier
 *     layer's definitions of the ones both declare. An earlier draft of this file
 *     called the six keys "replaced wholesale", which these bytes do not support.
 *   - **A shallow key set to two non-objects becomes `{}`.** `let u = {}` and both
 *     `Object.assign` calls are guarded by an is-record test, so a later layer
 *     replacing a string with a number yields an empty object. Faithful is the
 *     only safe choice: this importer's whole claim is that it reads what Qoder
 *     reads.
 *   - **The union dedupes by identity.** `[...new Set([...i, ...u])]` compares the
 *     values themselves, so two structurally equal objects from two layers stay
 *     two entries. Making them one would be this importer deciding that Qoder's
 *     list should be shorter than Qoder's list.
 */
function qoderMergeInto(target: Record<string, unknown>, source: Record<string, unknown>, path: string[] = []): void {
	for (const [key, value] of Object.entries(source)) {
		if (QODER_PROTOTYPE_SET.has(key) || value === undefined) continue;
		const here = [...path, key];
		const policy = qoderMergePolicy(here);
		const existing = target[key];
		if (policy === "shallow" && existing && value) {
			const merged: Record<string, unknown> = {};
			if (isRecord(existing)) Object.assign(merged, qoderCloneRecord(existing));
			if (isRecord(value)) Object.assign(merged, qoderCloneRecord(value));
			target[key] = merged;
			continue;
		}
		if (Array.isArray(existing)) {
			const incoming = Array.isArray(value) ? value : [value];
			if (policy === "concat") {
				target[key] = [...existing.map(qoderCloneValue), ...incoming.map(qoderCloneValue)];
				continue;
			}
			if (policy === "union") {
				target[key] = [...new Set([...existing, ...incoming])].map(qoderCloneValue);
				continue;
			}
		}
		if (isRecord(existing) && isRecord(value)) qoderMergeInto(existing, value, here);
		else if (isRecord(value)) {
			const fresh: Record<string, unknown> = {};
			qoderMergeInto(fresh, value, here);
			target[key] = fresh;
		} else {
			target[key] = qoderCloneValue(value);
		}
	}
}

/**
 * The three layers, applied in order — what Qoder would actually be running.
 *
 * Exported because this is the function worth arguing with: it is pure, it takes
 * three documents, and every claim above about shallow merging, union and
 * concatenation is a claim about *this*. A reader that read one layer would be
 * right about the file and wrong about the settings.
 */
export function mergeQoderSettings(layers: QoderSettingsLayer[]): MergedQoderSettings {
	const settings: Record<string, unknown> = {};
	const provenance: MergedQoderSettings["provenance"] = {};
	for (const layer of layers) {
		qoderMergeInto(settings, layer.settings);
		for (const key of Object.keys(layer.settings)) {
			if (QODER_PROTOTYPE_SET.has(key)) continue;
			provenance[key] = { source: layer.source, path: layer.path };
		}
	}
	return { settings, provenance };
}

/**
 * The file a settings key's value came from, as a report may print it.
 *
 * Falls back to the **user** layer's path when {@link provenance} has nothing for
 * the key, which is the case for a key the merge produced that no layer carried by
 * name — and is right for the only way that happens, which is a key this importer
 * asked about that no layer set.
 */
export function qoderSettingsOrigin(
	home: string,
	provenance: MergedQoderSettings["provenance"],
	key: string,
	fallback: string,
): string {
	const path = provenance[key]?.path;
	return tildePath(home, path ?? fallback);
}

/**
 * The file that carried a **sub-key** — a finer question than
 * {@link qoderSettingsOrigin} asks, and the only one that gives a report line the
 * right answer.
 *
 * The SDK's provenance is keyed by top-level name alone, so a server the user
 * added and a project never mentioned is attributed to whichever layer last
 * carried the *name* `mcpServers` — the project's, whenever the project has any
 * servers at all. Printed as a label, that sends the user to the project file to
 * edit a server that is not in it: the same mistake the layer suffix exists to
 * prevent, pointed the other way.
 *
 * So the read is untouched and only the label is narrowed — to the last layer, in
 * application order, that holds `key.subkey`. Where no layer holds it, which is
 * the case for a key the merge produced rather than any layer carried, `fallback`
 * is returned, and the caller passes the top-level origin so the answer degrades
 * to what it always was. The layer comes back with the path because the report
 * names it, and a suffix saying `project layer` beside a user's own file would be
 * the same error once more.
 */
export function qoderSettingsSubkeyOrigin(
	home: string,
	layers: QoderSettingsLayer[],
	key: string,
	subkey: string,
	fallback: string,
	fallbackSource: QoderSettingsSource,
): { path: string; source: QoderSettingsSource } {
	for (let index = layers.length - 1; index >= 0; index -= 1) {
		const container = layers[index].settings[key];
		if (isRecord(container) && subkey in container)
			return { path: tildePath(home, layers[index].path), source: layers[index].source };
	}
	return { path: fallback, source: fallbackSource };
}

/**
 * Read the layers that exist, in `QODER_SETTINGS_SOURCES` order.
 *
 * **A missing file is not an error here** — it is the normal state of two of the
 * three, and reporting "there is no `<cwd>/.qoder/settings.local.json`" for every
 * project a user visits would be noise. A file that exists and does not parse is
 * the opposite: it changes what the merge produces, so it is named.
 *
 * **The one case where the product reads fewer than three** is reproduced: `fc`
 * computes `c = resolve(cliHome) === resolve(cwd)` and skips both
 * `cwd`-relative layers when the directory being migrated into *is* the CLI home,
 * because then the "project" settings would be the user's own global settings read
 * a second time from a different path. That is a real configuration (a CLI home
 * set to a project directory) and it is why this takes the same two arguments
 * `fc` does.
 */
function readQoderLayers(
	home: string,
	cwd: string | undefined,
	configDir: string,
	env: QoderEnv,
	skipped: QoderSkipped[],
): QoderSettingsLayer[] {
	const layers: QoderSettingsLayer[] = [];
	const read = (source: QoderSettingsSource, path: string): void => {
		const document = readQoderJson(path);
		if (document.kind === "invalid") {
			skipped.push({ name: tildePath(home, path), reason: document.reason });
			return;
		}
		if (document.kind === "absent") return;
		if (document.recovered) skipped.push({ name: tildePath(home, path), reason: QODER_JSONC_RECOVERY });
		layers.push({ source, path, settings: document.value });
	};

	read("user", qoderSettingsPath(configDir));
	if (cwd === undefined) return layers;

	const cliHome = env.QODER_CLI_HOME?.trim();
	const resolvedCliHome = resolve(cwd, cliHome !== undefined && cliHome !== "" ? cliHome : home);
	if (resolvedCliHome === resolve(cwd)) return layers;

	read("project", qoderProjectSettingsPath(cwd, env));
	read("local", qoderLocalSettingsPath(cwd, env));
	return layers;
}

/**
 * Read one Qoder home.
 *
 * **Pure with respect to everything outside `home`, `cwd` and `env`**: it resolves
 * paths against those arguments and never calls `os.homedir()` or
 * `process.cwd()`, so a fixture laid out by a test and a developer's own `~/.qoder`
 * are the same code path. It does touch the filesystem, necessarily — that is what
 * reading is.
 *
 * `cwd` is the directory being migrated into, and it is what the **project and
 * local settings layers** hang off (`<cwd>/.qoder/settings.json` and
 * `settings.local.json`). It is `string | undefined` rather than defaulted to
 * `process.cwd()` for the same reason the reader takes `home` as an argument: a
 * default here would let a test that forgot it read whatever directory the test
 * runner happened to be in. `readSources(home, cwd)` always passes it.
 *
 * `env` defaults to `process.env`, which is what `readSources` passes, so a
 * developer who has set `QODER_CONFIG_DIR` gets that tree — the correct answer
 * for their machine. A test passes an explicit block instead. This is the same
 * trade `codex-home.ts` makes with `CODEX_HOME` and it is stated here because it
 * is the one way a test that reads a fixture home could quietly read a real one:
 * **a test that asserts on content must pass `env` rather than rely on the
 * ambient block.**
 *
 * The order is the settings layers, then the fields read out of the merged
 * document, then memory and skills, then the transcript count, then the paths
 * that exist and are deliberately not opened — but {@link RawQoder.skipped} is
 * **sorted by name before it is returned**, so two runs over one home produce the
 * same report rather than one that changes with the order the filesystem handed
 * back. Nothing short-circuits: a home with a damaged `settings.json` still yields
 * its skills.
 */
export function readQoder(
	home: string,
	cwd: string | undefined,
	env: QoderEnv = process.env,
	appData?: string,
): RawQoder {
	const configDir = qoderConfigDir(home, env);
	const skipped: QoderSkipped[] = [];

	const layers = readQoderLayers(home, cwd, configDir, env, skipped);
	// The scrub runs on each layer **before** the merge, not on the merged result.
	// That ordering is the one that keeps a credential out: `mcpServers` merges one
	// level deep, so a token in a layer that a later layer partly overrode is
	// still walked and still dropped, whereas scrubbing only the merge's output
	// would leave that copy in `layers` — where nothing reads it again, but where
	// `provenance` could still name its file.
	for (const layer of layers) scrubQoderCredentials(layer.settings, skipped, tildePath(home, layer.path));
	const merged = mergeQoderSettings(layers);
	const settings = layers.length > 0 ? merged.settings : null;

	// `mcpServers` and `hooks` are **read, not moved**: they stay in the merged
	// document, because `planQoder` is what decides they are handled and because a
	// reader that deleted them would make `reportUnhandledKeys` name them as
	// unhandled, which is the opposite of the truth.
	const mcpServers = settings !== null && isRecord(settings.mcpServers) ? settings.mcpServers : {};
	if (settings !== null && "mcpServers" in settings && !isRecord(settings.mcpServers)) {
		skipped.push({
			name: `${qoderSettingsOrigin(home, merged.provenance, "mcpServers", qoderSettingsPath(configDir))} → mcpServers`,
			reason: "mcpServers is not a JSON object, so no server was read from it",
		});
	}
	const hooks = settings === null ? undefined : settings.hooks;

	const memory = readQoderMemory(configDir, home, skipped);
	const { assets, collisions } = readQoderSkills(configDir, home, skipped);
	const { sessions, projects } = countQoderSessions(configDir, skipped);

	// The desktop store is *named*, never opened. `appData` is an explicit
	// argument rather than a `process.env` read at this call site so a test can
	// hand it a fixture and so the reader stays pure with respect to `home` and
	// `env` — the same reason those two are parameters. It defaults to the real
	// `%APPDATA%` only on the platform that has one; elsewhere there is no such
	// store and the field stays `null` rather than naming a path that would never
	// exist.
	const desktopRoot = appData ?? (process.platform === "win32" ? process.env.APPDATA : undefined);
	const desktopStore =
		desktopRoot === undefined
			? null
			: {
					path: qoderDesktopStorePath(desktopRoot, QODER_DESKTOP_DATA_DIR),
					exists: existsSync(qoderDesktopStorePath(desktopRoot, QODER_DESKTOP_DATA_DIR)),
				};

	const rejection = qoderDirNameRejection(env);
	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		env,
		configDir,
		otherConfigDir: qoderOtherConfigDir(home, configDir),
		present: existsSync(configDir) && qoderTreeHasContent(configDir),
		rejectedDirName:
			rejection === null
				? null
				: `QODER_CONFIG_DIR_NAME is set to a value Qoder itself refuses — ${QODER_DIR_NAME_REJECTIONS[rejection]} — so the SDK throws before it reads anything, and this import fell back to ${QODER_DEFAULT_DIR}`,
		settingsPath: qoderSettingsPath(configDir),
		settingsLayers: layers,
		provenance: merged.provenance,
		settings,
		projectMcpPath: cwd === undefined ? null : qoderProjectMcpPath(cwd),
		mcpServers,
		hooks,
		memory,
		assets,
		assetCollisions: collisions,
		sessionCount: sessions,
		projectCount: projects,
		desktopStore: desktopStore,
		skipped,
	};
}
