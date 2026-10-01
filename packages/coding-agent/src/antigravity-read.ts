/**
 * Antigravity's user state, as read from a home directory.
 *
 * Read `antigravity-home.ts` first — every path claim below is that module's,
 * and it says which of them are verified against the product and which are
 * inferred. The standing caveats for this source, in one place:
 *
 *   - **The MCP file is `mcp_config.json`.** 14 occurrences in
 *     `language_server.exe`; `mcp.json` and `mcp_settings.json` have zero each.
 *     Every other source in this repo's migration set spells it `.mcp.json`,
 *     and a reader that reached for that spelling would report a user with MCP
 *     servers as having none.
 *   - **There is nothing to import that is a credential.** Antigravity keeps
 *     OAuth tokens in the OS credential store — `wincred` on Windows, the
 *     keychain elsewhere — and there is no credential document under
 *     `~/.gemini` to read. A `credentials.db` path does occur in the binary,
 *     inside an agent prompt template, as `~/.config/gcloud/credentials.db` in
 *     a list of files the agent is told not to read: it is an example of a
 *     sensitive path belonging to **gcloud**, not a store Antigravity writes.
 *     Nothing in this module opens it, and {@link scrubAntigravityCredentials}
 *     exists because `config.json` is a settings document that a future version
 *     could grow a token into, not because one is expected.
 *   - **Conversation contents are not read and not parsed.** Counting and
 *     measuring each transcript is the whole of it, and the layout that makes
 *     that possible is the product's own — see {@link antigravityConversationsDir}
 *     for the four independent attestations of `brain/<id>/…/transcript.jsonl`.
 *     A unit here is a conversation *directory* and a size, never a parsed turn.
 *   - **Two data roots, and only one is read.** `antigravity-ide` wins when it
 *     has anything in it and `antigravity` is the fallback, because the app
 *     copies the first from the second and never deletes the source. Which one
 *     answered is on {@link RawAntigravity.dataDir}, and the other is still on
 *     {@link RawAntigravity.dataDirs}, because "the IDE has two spellings for
 *     its data directory" is a fact the report is better for knowing.
 *
 * **Nothing here throws.** Every read that fails becomes a line in
 * {@link RawAntigravity.skipped} naming what failed and why, which is the
 * convention `step-home.ts` uses for a walk that passes over something: a
 * migration that aborts on one damaged file loses every other source's import
 * to make a point about that file.
 */

import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	ANTIGRAVITY_GEMINI_DIR,
	ANTIGRAVITY_NAMED_ONLY,
	antigravityConfigPath,
	antigravityConversationsDir,
	antigravityDataDirs,
	antigravityGeminiRoot,
	antigravityGlobalWorkflowsDir,
	antigravityMcpConfigPaths,
	antigravityMemoryPaths,
	antigravitySkillsDir,
	antigravityTranscriptPaths,
	antigravityTreeHasContent,
	antigravityWorkflowsDir,
} from "./antigravity-home.ts";
import { isRecord, parseJsonc, readSkillDirs, readText, tildePath } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";
import { looksLikeSecretName } from "./migrate-types.ts";

/**
 * One thing the walk found and did not carry over, with the reason.
 *
 * `name` is a **label, not a resolved path**: a bare file or directory name
 * where that is unambiguous, and a forward-slashed relative label where it is
 * not (`plugins/foo`, `workflows.json`). This is the same convention as
 * `step-home.ts`'s `StepSkippedEntry` and `step-read.ts`'s `agent/<name>`
 * labels — the report renders every path it names with forward slashes, and a
 * Windows separator inside one of those lines is a rendering bug, not a path.
 *
 * A name appears here for one of four reasons, and the sentence says which:
 * it could not be read, it could not be parsed, it was deliberately left
 * unopened, or it was read and then not carried because of a collision.
 */
export interface AntigravitySkipped {
	name: string;
	reason: string;
}

/**
 * One conversation, named and measured and never opened.
 *
 * A conversation is a **directory** under `brain/`, not a file, and `size` is
 * the size of the compact transcript inside it — `.system_generated/logs/
 * transcript.jsonl` — because that is the file whose presence decides whether
 * there is anything here to import. See {@link antigravityConversationsDir}.
 */
export interface AntigravityConversation {
	/** The directory's own name, which is the conversation id. */
	name: string;
	/** Where the conversation directory is. Printed by the report, never opened. */
	path: string;
	/** Its compact transcript's size in bytes, from one `stat`. */
	size: number;
}

/**
 * The theme, in Antigravity's own spelling rather than this build's.
 *
 * `dist/utils.js:63-84` resolves it in two steps and the second is not an
 * equality test:
 *
 * ```js
 * const themeMode = config?.userSettings?.themeMode;
 * if (themeMode && themeMode.includes('INHERIT')) return nativeTheme.shouldUseDarkColors ? 'DARK' : 'LIGHT';
 * if (themeMode && themeMode.includes('LIGHT'))  return 'LIGHT';
 * return 'DARK';
 * ```
 *
 * **`String.prototype.includes`, not `===`** — and it matters, because the value
 * is an enum the product spells in more than one form and this reader has no
 * way to enumerate them. `themeMode === "LIGHT"` would import
 * `LIGHT_MODE`, `MODE_LIGHT` or `light` as *dark*, silently and in the
 * direction the user did not choose. Both tests below are the app's, including
 * the order: `INHERIT` is tested first, so a value naming both is inherited.
 *
 * The `themeMode &&` guard is reproduced too. `themeMode.includes` on a
 * non-string throws inside `getThemeMode`, whose `catch` returns `'DARK'`
 * (`:80-83`) — so a settings file with `"themeMode": 1` is a **dark** theme to
 * Antigravity, not a missing one, and reading it as absent would let the
 * planner invent a preference the app does not have.
 */
export interface AntigravityTheme {
	/** `userSettings.themeMode` verbatim, or `null` when the file states none. */
	declared: string | null;
	/**
	 * True when the app would follow the OS. **The importer cannot resolve
	 * this**: `nativeTheme.shouldUseDarkColors` is a property of the machine
	 * Antigravity runs on, so this is a reason for the report to say "follows
	 * your system theme" rather than a theme to write.
	 */
	inheritsOsTheme: boolean;
	/** The app's second test, verbatim: does the value contain `LIGHT`? */
	light: boolean;
}

/**
 * Antigravity's user state, as one read of one home.
 *
 * Everything here is either a value read out of a file, a *count* of something,
 * or a line explaining why neither happened. No field holds a credential and no
 * field holds conversation contents.
 */
export interface RawAntigravity {
	/** The home directory every root was resolved against, for rendering report paths. */
	home: string;
	/** `~/.gemini` — the parent of every other path here. */
	geminiRoot: string;
	/**
	 * True when `~/.gemini` exists and holds something. A source whose whole
	 * point is that nothing was there produces an empty report rather than a
	 * line saying so, and this is how a caller tells the two apart.
	 */
	present: boolean;
	/**
	 * The data root that answered, or `null` when neither has content.
	 *
	 * `antigravity-ide` when it is not empty, else `antigravity`, which is the
	 * order {@link antigravityDataDirs} returns and the app's own copy
	 * direction. `null` is a real answer — it means the home has customization
	 * but no IDE data, which is the shape of a user who installed the CLI side
	 * or deleted the IDE — and it is what stops the reader from reading
	 * `brain/` and `mcp_config.json` out of a directory it never established was
	 * theirs.
	 */
	dataDir: string | null;
	/** Both candidate roots, most authoritative first, whether or not either exists. */
	dataDirs: string[];
	/** `~/.gemini/config/config.json`. Always present as a path, never as a read. */
	configPath: string;
	/**
	 * The settings document, parsed, or `null` when it could not be.
	 *
	 * `null` rather than `{}` on purpose: when the file is there and unusable,
	 * {@link AntigravitySkipped} says which of "a directory where a file was
	 * expected", "unreadable", "not a JSON object", "not parseable" or "read
	 * anyway with comments stripped" applied, and an empty object would let a
	 * planner claim a document was read and held nothing. An **absent** file
	 * produces no line at all — never having written settings is the ordinary
	 * state of a home that only installed the IDE, not a failure to report.
	 * Credential-shaped keys have been **removed** from whatever comes back —
	 * see {@link scrubAntigravityCredentials}.
	 */
	config: Record<string, unknown> | null;
	/** The theme, in the app's own terms. See {@link AntigravityTheme}. */
	theme: AntigravityTheme;
	/** Every `mcp_config.json` consulted, in priority order, existing or not. */
	mcpConfigPaths: string[];
	/**
	 * The servers from every `mcp_config.json`, merged.
	 *
	 * The values are the source's own server objects, copied without
	 * interpretation: `command`/`args`/`env` for a stdio server and
	 * `serverUrl` for an SSE one are the shapes the product documents, and
	 * deciding what this build can reproduce from them is the planner's job.
	 * A server that is present in two documents appears once, from the
	 * earlier one in {@link mcpConfigPaths}; {@link mcpCollisions} says so.
	 */
	mcpServers: Record<string, unknown>;
	/**
	 * Server name → the `mcp_config.json` it was read from, so the planner can
	 * print which document a server came from. Paths only: this map is the
	 * provenance, and the server's own configuration is on {@link mcpServers}.
	 */
	mcpSources: Record<string, string>;
	/** Names in more than one document, and which file won. */
	mcpCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/**
	 * Standing instructions, as {@link RawFile}s, from every candidate in
	 * {@link antigravityMemoryPaths} that exists.
	 *
	 * One array rather than one string because there can be more than one:
	 * `memory.txt` is the machine-local memory file and `GEMINI.md` /
	 * `AGENTS.md` are rules, and a home can hold both. Which paths were tried
	 * is in {@link antigravityMemoryPaths}, and a candidate that is there but
	 * unreadable is named in {@link AntigravitySkipped}.
	 */
	memory: RawFile[];
	/**
	 * Skills and legacy workflows, as {@link RawFile}s.
	 *
	 * Skills come from `~/.gemini/config/skills/<name>/SKILL.md` and carry the
	 * files beside them as `attachments` — the shape `readSkillDirs` gives
	 * every other source, and the reason a skill's `references/` and
	 * `scripts/` travel with it. Workflows come from the two deprecated
	 * `workflows/` trees and carry a `detail` saying which tree they were in
	 * and that the product now converts them to skills.
	 *
	 * A workflow whose name a skill already answers to is **left out** and
	 * recorded in {@link nameCollisions}, rather than dropped silently: a skill
	 * is the live shape and a workflow the same name is the shape the product
	 * itself retires in favour of it, so the skill is the one worth carrying —
	 * and the collision is a line in the report so the user is told the second
	 * file was there.
	 */
	assets: RawFile[];
	/** One entry per conversation file: its name, its path, its size. */
	conversations: AntigravityConversation[];
	/**
	 * Two assets answering to one name, and which of the two this reader kept.
	 *
	 * "Kept" and "dropped" are this reader's words, not the plan's: nothing has
	 * been written yet, and the write step keeps the first of two writes to one
	 * target path anyway. The record exists so the report can say a second file
	 * was found under a name already taken.
	 */
	nameCollisions: Array<{ name: string; kept: string; dropped: string }>;
	/**
	 * Everything seen and not carried over, each with the reason. Sorted by
	 * name so two runs over one home produce the same report.
	 */
	skipped: AntigravitySkipped[];
}

/** A file's text, or why it is not available. `null` is never the answer. */
type AntigravityText = { kind: "text"; value: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/** A JSON document in the three states one can be in when it is on disk. */
type AntigravityJson =
	| { kind: "object"; value: Record<string, unknown>; recovered: boolean }
	| { kind: "absent" }
	| { kind: "invalid"; reason: string };

/**
 * The largest depth a credential-shaped key is looked for at.
 *
 * Eight is well past anything a settings document nests to — `config.json`
 * holds `userSettings` and one level under it — and the cap is here so a
 * pathological document cannot turn a credential scan into a walk of a
 * megabyte-deep structure. A key deeper than this is **left in place**, which
 * is the one thing this function can get wrong; it is stated rather than
 * pretended away.
 */
const MAX_CREDENTIAL_SCAN_DEPTH = 8;

/**
 * Key names `looksLikeSecretName` does not catch.
 *
 * That helper matches `TOKEN`, `KEY`, `SECRET`, `PASSWORD` and `CREDENTIAL` as
 * case-insensitive substrings (`migrate-types.ts:379-384`), which covers
 * `apiKey`, `accessToken`, `refreshToken`, `clientSecret` and `privateKey`. It
 * is deliberately broad — it also matches a hypothetical `monkey`, and a
 * settings key called that is dropped as a credential it is not. The cost is
 * one line in the report saying so, which is cheaper than a token written into
 * a file the user then shares. `authorization` is the one common spelling it
 * misses, because none of the five markers is in it.
 */
const ANTIGRAVITY_SECRET_KEY = /authorization/i;

/**
 * Antigravity's theme, from the parsed settings document.
 *
 * `dist/utils.js:71-75`, reproduced in {@link AntigravityTheme}: the value is
 * `config?.userSettings?.themeMode`, `INHERIT` is tested first with
 * `String.prototype.includes`, `LIGHT` second, and everything else — including
 * a value that is not a string at all — is `DARK`, which is what the app's
 * `catch` returns.
 */
function antigravityTheme(config: Record<string, unknown> | null): AntigravityTheme {
	const settings = config === null ? undefined : config.userSettings;
	const mode = isRecord(settings) ? settings.themeMode : undefined;
	// Two names for one value: `declared` is what the file said, and `""` stands
	// in for "said nothing" so that both tests below can be written as the app
	// writes them. `String.prototype.includes` on the empty string is `false`, and
	// so is `themeMode && themeMode.includes(…)` on an empty or absent value —
	// the two spellings agree, and keeping the local a `string` is what stops a
	// null check from being smuggled in front of a substring test.
	const declared = typeof mode === "string" ? mode : null;
	const tested = declared ?? "";
	return {
		declared,
		inheritsOsTheme: tested.includes("INHERIT"),
		light: tested.includes("LIGHT"),
	};
}

/**
 * Remove every credential-shaped key from a parsed document, recording each by
 * path and never touching the value.
 *
 * Nothing in `config.json` is expected to be a secret — the settings document
 * holds `userSettings.themeMode` and similar — so this is a guard rather than a
 * step, and it is written as one because a guard nobody can see is not a guard.
 * The names go into `skipped`; the values are dropped on the floor, so a token
 * that a future Antigravity version put in its settings file never reaches a
 * planner, a plan, a report or a written target file.
 *
 * Depth-limited at {@link MAX_CREDENTIAL_SCAN_DEPTH}, which is documented on
 * the constant because the depth is where this function could be wrong.
 */
function scrubAntigravityCredentials(value: Record<string, unknown>, into: AntigravitySkipped[]): void {
	const walk = (node: unknown, prefix: string, depth: number): void => {
		if (!isRecord(node) || depth > MAX_CREDENTIAL_SCAN_DEPTH) return;
		for (const [key, nested] of Object.entries(node)) {
			const path = `${prefix}.${key}`;
			if (ANTIGRAVITY_SECRET_KEY.test(key) || looksLikeSecretName(key)) {
				into.push({ name: path, reason: "looks like a credential — name only, value never read" });
				delete node[key];
				continue;
			}
			walk(nested, path, depth + 1);
		}
	};
	walk(value, "config.json", 0);
}

/**
 * A file's text, or the reason it is not text.
 *
 * `statSync` first rather than opening and catching, because the two failures
 * a caller must tell apart are *absent* and *there but unreadable*, and both
 * arrive as exceptions from `readText` — which would make a home that has never
 * installed Antigravity produce a report full of "unreadable" lines. A
 * directory sitting where a file was expected is its own case, and a real one:
 * `~/.gemini/config` is both a directory here and a file name inside
 * `~/.gemini`, so a user who has it the other way round gets a sentence that
 * says which.
 */
function readAntigravityText(path: string): AntigravityText {
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
 * Plain `JSON.parse` first, which is what both halves of the product do: the
 * Electron launcher opens `config.json` with `JSON.parse` (`dist/utils.js:70`)
 * and the binary's own JSON-shape validation for MCP is a
 * `jsontext.Value` unmarshal, which is plain JSON. There is **no** evidence
 * that either file is JSONC — the only document the product documents as JSONC
 * is a plugin's `plugin.json`, which this source does not read.
 *
 * So the retry is a recovery, not a format claim, and it is **reported**: when
 * `JSON.parse` fails the text is run through {@link parseJsonc} once, and if
 * that yields a non-empty object the file is read with `recovered: true` set,
 * which every caller turns into one line in `skipped`. A user whose settings
 * file carries a comment is told the file was read anyway and why, because
 * "every setting came across" and "every setting came across from a file this
 * build does not officially parse" are different sentences.
 *
 * A document whose body is nothing but a block comment parses as an empty
 * object under both readers and so reports as damaged; that is the one input
 * where the recovery is wrong, and it costs a settings file that held nothing.
 *
 * A fixed phrase for the failure, never the parser's message: a `SyntaxError`
 * from `JSON.parse` quotes the text it choked on, which would put a fragment of
 * the user's file into the report.
 */
function readAntigravityJson(path: string): AntigravityJson {
	const text = readAntigravityText(path);
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
			reason: "not parseable as JSON — damaged, or carrying comments this build's JSON reader will not accept",
		};
	}
}

/** The one line a document read through {@link parseJsonc} earns in `skipped`. */
const ANTIGRAVITY_JSONC_RECOVERY =
	"not parseable as plain JSON — read anyway with comments and trailing commas stripped, so anything the stripping removed is not carried over";

/**
 * One MCP document's servers, and the three ways it can have none worth reading.
 *
 * The shape is the product's: a top-level object with `mcpServers` holding a map
 * of server name to that server's object. The Go type is
 * `struct { McpServers map[string]jsontext.Value \`json:"mcpServers"\` }`, and
 * the failure the product raises when the field is the wrong type is the string
 * `mcpServers field is not a JSON object, got %T` — so a non-object
 * `mcpServers` is a real, named condition rather than a shape this reader
 * invented.
 *
 * A **missing** `mcpServers` is reported rather than passed over in silence,
 * because the one document where a user is likely to have got it wrong is
 * exactly this one: the whole rest of this repo's migration set spells its MCP
 * document with the servers at the top level, so `{"sqlite": {…}}` is a shape a
 * user arriving from another tool will write by hand. Saying "this source reads
 * only the `mcpServers` field" is worth one line; importing it anyway would be
 * inventing a schema.
 *
 * Entries are handed over as they are. The Go map's value type is
 * `jsontext.Value`, so *any* JSON value is legal where the product is
 * concerned, and this reader does not second-guess it.
 */
function readAntigravityMcpFile(
	path: string,
	label: string,
	skipped: AntigravitySkipped[],
): { servers: Record<string, unknown> } | null {
	const document = readAntigravityJson(path);
	if (document.kind === "absent") return null;
	if (document.kind === "invalid") {
		skipped.push({ name: label, reason: document.reason });
		return null;
	}
	if (document.recovered) skipped.push({ name: label, reason: ANTIGRAVITY_JSONC_RECOVERY });
	if (!("mcpServers" in document.value)) {
		if (Object.keys(document.value).length > 0) {
			skipped.push({
				name: label,
				reason: "no mcpServers field — this source reads only that field, so nothing was imported from it",
			});
		}
		return null;
	}
	const servers = document.value.mcpServers;
	if (!isRecord(servers)) {
		skipped.push({ name: label, reason: "mcpServers is not a JSON object" });
		return null;
	}
	return { servers };
}

/** A directory's entries, name-sorted. Unreadable or absent contributes none. */
function antigravityDirectoryEntries(dir: string): Dirent[] {
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
 * The workflow markdown files under one deprecated tree, as skills would be.
 *
 * Recursive rather than flat because the product's own discovery instructions
 * write both as `*.md` globs and neither states a depth, and a reader that
 * assumed depth zero would silently drop a nested workflow.
 *
 * Four kinds of entry are passed over, each named in `skipped` with its own
 * reason — except the fourth, which is walked:
 *
 *   - **`*.md.bak`** — the product's own archive suffix. The built-in
 *     `migrate-workflows` skill renames each converted file to
 *     `<name>.md.bak` rather than deleting it, so one of these is a workflow
 *     that has *already* been converted, and saying that is the difference
 *     between "this was already migrated" and "this was missed".
 *   - **`README.md`** — not a workflow, and every other reader in this repo
 *     refuses one for the same reason (`readCommandFiles` in `migrate-core.ts`).
 *   - **anything that is not a `.md`** — named rather than read, because a
 *     workflow is markdown by the product's own definition and a file that is
 *     not one is not a workflow this importer can translate.
 *   - **a directory** — walked, recursively.
 *
 * The `detail` on each result is what the planner needs to explain the copy: a
 * workflow is a `.md` file and a skill here is a directory with a `SKILL.md`
 * and a `name`/`description` header, so this is a rewrite and not a verbatim
 * move, and the vendor's own migration performs exactly that rewrite.
 */
function readAntigravityWorkflows(dir: string, label: string, skipped: AntigravitySkipped[]): RawFile[] {
	const files: RawFile[] = [];
	const walk = (current: string, prefix: string): void => {
		for (const entry of antigravityDirectoryEntries(current)) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const name = `${label}/${relativePath}`;
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(path, relativePath);
				continue;
			}
			const lower = entry.name.toLowerCase();
			if (lower.endsWith(".md.bak")) {
				skipped.push({
					name,
					reason:
						"already-converted workflow, archived by the product's own migrate-workflows skill as <name>.md.bak — its skill should be in the skills tree",
				});
				continue;
			}
			if (!entry.isFile() || !lower.endsWith(".md")) {
				if (!entry.isFile()) {
					skipped.push({ name, reason: "not a regular file" });
				}
				continue;
			}
			if (lower === "readme.md") {
				skipped.push({ name, reason: "a README, not a workflow" });
				continue;
			}
			const content = readAntigravityText(path);
			if (content.kind !== "text") {
				// `absent` is the race where the file left between the listing and
				// the read; it is named rather than passed over, because a workflow
				// the user can see and this walk cannot is not the same as one that
				// is not there.
				skipped.push({ name, reason: content.kind === "absent" ? "gone before it could be read" : content.reason });
				continue;
			}
			files.push({
				name: entry.name.slice(0, -3),
				sourcePath: path,
				content: content.value,
				detail: `Antigravity workflow from ${label}/${relativePath}; the product's own migrate-workflows skill calls this tree deprecated in favour of skills/<name>/SKILL.md, renames the frontmatter to name/description, and archives the original as <name>.md.bak`,
			});
		}
	};
	walk(dir, "");
	return files;
}

/**
 * The conversations under one data root: named and measured, never opened.
 *
 * **The layout here is attested, so the shape of this scan follows the product
 * rather than a guess.** A data root holds `brain/`, and each entry of `brain/`
 * is a **directory** named for a conversation id, with its transcript at
 * `.system_generated/logs/transcript.jsonl` inside it — see
 * {@link antigravityConversationsDir} for the four independent attestations.
 * An earlier draft scanned for *files* under a `conversations/` directory whose
 * name nothing attested; that would have found nothing on every real install.
 *
 * So a conversation is measured by its compact transcript, and the measurement is
 * a size rather than a parse: this half of the reader accounts for what is there,
 * and the transcripts themselves are read by the history phase, on the same
 * two-phase schedule every other source here uses.
 *
 * `found` distinguishes *the directory is not there* from *it is there and holds
 * nothing*, which are different sentences to a user deciding whether their
 * history came across. A conversation whose transcript is missing is named and
 * counted, with the reason — it is a conversation the user can see in Antigravity
 * and this reader cannot account for, which is exactly the case a report owes
 * them an explanation for.
 */
function readAntigravityConversations(
	dir: string,
	skipped: AntigravitySkipped[],
): { found: boolean; conversations: AntigravityConversation[] } {
	if (!existsSync(dir)) return { found: false, conversations: [] };
	const conversations: AntigravityConversation[] = [];
	for (const entry of antigravityDirectoryEntries(dir)) {
		const path = join(dir, entry.name);
		if (!entry.isDirectory()) {
			skipped.push({
				name: `brain/${entry.name}`,
				reason: "a file directly under the conversations tree; the product puts one directory per conversation in it",
			});
			continue;
		}
		// The compact transcript is the one the product tells an agent to read
		// first, so it is the one whose presence decides whether this conversation
		// has anything to import. `transcript_full.jsonl` is the fallback for the
		// steps whose `truncated_fields` point into it, not a second conversation.
		const transcript = antigravityTranscriptPaths(path)[0];
		if (!existsSync(transcript)) {
			skipped.push({
				name: `brain/${entry.name}`,
				reason:
					"a conversation with no transcript at .system_generated/logs/transcript.jsonl — it may predate that layout, or " +
					"have been cleaned up; its artifacts and scratch files are left where Antigravity put them",
			});
			continue;
		}
		let size: number;
		try {
			size = statSync(transcript).size;
		} catch {
			skipped.push({ name: `brain/${entry.name}`, reason: "its transcript could not be measured" });
			continue;
		}
		conversations.push({ name: entry.name, path, size });
	}
	return { found: true, conversations };
}

/**
 * Read one Antigravity home.
 *
 * Pure with respect to everything outside `home`: it resolves paths against the
 * argument and never calls `os.homedir()`, so a fixture laid out by a test and
 * a developer's own `~/.gemini` are the same code path. It does touch the
 * filesystem, necessarily — that is what reading is.
 *
 * The work is done in one order — the settings document, then the theme that
 * only it can answer, then the MCP documents in priority order, then the
 * standing instructions, then the skills and workflows, then the conversations,
 * and last the paths that exist and are deliberately not opened — but
 * {@link AntigravitySkipped} is **sorted by name before it is returned**, so
 * two runs over one home produce the same report rather than one that changes
 * with the order the filesystem happened to hand back. Nothing short-circuits:
 * a home with a damaged `config.json` still yields its skills.
 */
export function readAntigravity(home: string): RawAntigravity {
	const geminiRoot = antigravityGeminiRoot(home);
	const dataDirs = antigravityDataDirs(home);
	const skipped: AntigravitySkipped[] = [];

	// The one decision this module makes about where to read, and it makes it by
	// asking rather than by assuming: the first root with anything in it, which is
	// `antigravity-ide` on a machine that went through the IDE split and
	// `antigravity` on one that did not.
	const chosen = dataDirs.find((dir) => antigravityTreeHasContent(dir)) ?? null;

	const configDocument = readAntigravityJson(antigravityConfigPath(home));
	if (configDocument.kind === "invalid") {
		skipped.push({ name: "config.json", reason: configDocument.reason });
	} else if (configDocument.kind === "object" && configDocument.recovered) {
		skipped.push({ name: "config.json", reason: ANTIGRAVITY_JSONC_RECOVERY });
	}
	const config = configDocument.kind === "object" ? configDocument.value : null;
	if (config !== null) scrubAntigravityCredentials(config, skipped);

	const mcpServers: Record<string, unknown> = {};
	const mcpSources: Record<string, string> = {};
	const mcpCollisions: RawAntigravity["mcpCollisions"] = [];
	for (const path of antigravityMcpConfigPaths(home, chosen)) {
		// The report renders every path it names under home with a leading `~` and
		// forward slashes, and `tildePath` is that renderer — so a skip line and a
		// provenance line carry the same spelling, on every platform.
		const label = tildePath(home, path);
		const read = readAntigravityMcpFile(path, label, skipped);
		if (read === null) continue;
		for (const [name, server] of Object.entries(read.servers)) {
			const earlier = mcpSources[name];
			if (earlier !== undefined) {
				mcpCollisions.push({ name, kept: earlier, dropped: label });
				continue;
			}
			mcpServers[name] = server;
			mcpSources[name] = label;
		}
	}

	const memory: RawFile[] = [];
	for (const path of antigravityMemoryPaths(home)) {
		const text = readAntigravityText(path);
		if (text.kind === "absent") continue;
		if (text.kind !== "text") {
			// `~`-rooted like every other label here: four candidates with two of
			// them in one directory means a bare `memory.txt` would not say which
			// one of them failed.
			skipped.push({ name: tildePath(home, path), reason: text.reason });
			continue;
		}
		const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
		memory.push({ name: base, sourcePath: path, content: text.value });
	}

	const skillsDir = antigravitySkillsDir(home);
	const assets = readSkillDirs(skillsDir);
	// `readSkillDirs` passes over two things in silence that are worth a line
	// here, because Antigravity *defines* a skill as a directory holding a
	// `SKILL.md` (`skills/<name>/SKILL.md` in the product's own customization
	// guide) — so both of these are user content in a directory the agent reads,
	// which is exactly the case where silence reads as a bug.
	for (const entry of antigravityDirectoryEntries(skillsDir)) {
		if (entry.isDirectory()) {
			if (assets.some((skill) => skill.name === entry.name)) continue;
			skipped.push({
				name: `skills/${entry.name}`,
				reason: "a skill directory with no SKILL.md in it, which is not a skill Antigravity loads",
			});
			continue;
		}
		// A markdown file sitting directly in `skills/` is not a skill in either
		// shape the product documents — those are a *file* named `SKILL.md` inside a
		// *directory*. It is named rather than read, because importing it as a
		// single-file skill would be a schema this source cannot cite.
		skipped.push({
			name: `skills/${entry.name}`,
			reason:
				"a file directly in the skills root; an Antigravity skill is a directory holding a SKILL.md, and this is not one",
		});
	}
	// Workflows are added after skills, and a name an asset already answers to is
	// recorded rather than dropped: two entries become one target directory, and
	// which of them the plan writes is the plan's decision. A reader that
	// silently dropped one would leave a report claiming one file was imported
	// where two were found.
	const claimed = new Map(assets.map((asset) => [asset.name, asset.sourcePath]));
	const nameCollisions: RawAntigravity["nameCollisions"] = [];
	for (const [dir, label] of [
		[antigravityWorkflowsDir(home), "workflows"],
		[antigravityGlobalWorkflowsDir(home), "global_workflows"],
	] as const) {
		for (const workflow of readAntigravityWorkflows(dir, label, skipped)) {
			const earlier = claimed.get(workflow.name);
			if (earlier !== undefined) {
				nameCollisions.push({ name: workflow.name, kept: earlier, dropped: workflow.sourcePath });
				continue;
			}
			claimed.set(workflow.name, workflow.sourcePath);
			assets.push(workflow);
		}
	}

	const conversations: AntigravityConversation[] = [];
	if (chosen !== null) {
		const scan = readAntigravityConversations(antigravityConversationsDir(chosen), skipped);
		conversations.push(...scan.conversations);
		if (!scan.found) {
			skipped.push({
				name: `brain (under ${tildePath(home, chosen)})`,
				reason:
					"no conversations directory there — this is the path Antigravity's own documentation gives for them, so it is the " +
					"absence of conversations in this data root and not the absence of a location; the other root may still hold them",
			});
		}
	}

	// The named-only paths are checked last and reported only when they exist, so
	// an install with none of them is not told about five directories it does not
	// have. The label is what the report prints and what the reason hangs off;
	// existence is the only thing asked of the filesystem here.
	//
	// The label is resolved by replacing its leading `~/.gemini` — a slice rather
	// than a `replace`, because a home that itself contained the text `~/.gemini`
	// would otherwise have that occurrence substituted instead of the leading one.
	const labelPrefix = `~/${ANTIGRAVITY_GEMINI_DIR}`;
	for (const [label, reason] of Object.entries(ANTIGRAVITY_NAMED_ONLY)) {
		if (!label.startsWith(labelPrefix)) continue;
		if (existsSync(join(geminiRoot, label.slice(labelPrefix.length)))) skipped.push({ name: label, reason });
	}

	skipped.sort((a, b) => a.name.localeCompare(b.name));
	return {
		home,
		geminiRoot,
		present: antigravityTreeHasContent(geminiRoot),
		dataDir: chosen,
		dataDirs,
		configPath: antigravityConfigPath(home),
		config,
		theme: antigravityTheme(config),
		mcpConfigPaths: antigravityMcpConfigPaths(home, chosen),
		mcpServers,
		mcpSources,
		mcpCollisions,
		memory,
		assets,
		conversations,
		nameCollisions,
		skipped,
	};
}
