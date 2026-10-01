/**
 * Antigravity's user state: the `~/.gemini` tree, the two data roots under it,
 * and every path `antigravity-read.ts` looks at.
 *
 * **Everything under this one directory name is verified against the product.**
 * The path claims come from two places and the two are cited separately because
 * they are not equally strong evidence:
 *
 *   - `dist/paths.js` in the unpacked Electron launcher (`asar-out/dist/paths.js`)
 *     is *source*. Every `join(homedir(), '.gemini', …)` below is that file's
 *     expression, verbatim and at the line cited.
 *   - `language_server.exe` is a stripped Go binary, so a path there is cited by
 *     the literal that carries it rather than by line. A literal proves the
 *     product *writes* that path; it does not, by itself, prove what is inside
 *     the directory it names.
 *
 * Nothing here calls `os.homedir()`. The `home` argument is the only source of a
 * home directory, which is the whole reason a migration can be pointed at a
 * fixture instead of the developer's own machine. The single exception is
 * {@link antigravityTreeHasContent}, and it exists only because the *reader*
 * has to choose between two data roots and this module refuses to make that
 * choice: see its note.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The directory every Antigravity path in this module sits under. */
export const ANTIGRAVITY_GEMINI_DIR = ".gemini";

/**
 * The data root the separately-installed IDE reads: `~/.gemini/antigravity-ide`.
 *
 * `asar-out/dist/paths.js:50` — `join(homedir(), '.gemini', 'antigravity-ide')`,
 * exported as `IDE_NEW_DATA_DIR` and commented "User data dir for the separately
 * installed IDE (destination for copy)". It is the app's *own* spelling of
 * "where the current build keeps its data", and it is first in
 * {@link antigravityDataDirs}.
 */
export const ANTIGRAVITY_IDE_DATA_DIR = "antigravity-ide";

/**
 * The pre-split data root: `~/.gemini/antigravity`.
 *
 * `asar-out/dist/paths.js:48` — `join(homedir(), '.gemini', 'antigravity')`,
 * exported as `IDE_OLD_DATA_DIR` and commented "User data dir for the old IDE
 * (source for copy)". "Old" is the app's word, in its own comment: this is the
 * tree a build before the IDE split wrote to, and it is what the wizard copies
 * *from*.
 */
export const ANTIGRAVITY_OLD_DATA_DIR = "antigravity";

/**
 * `~/.gemini/antigravity-backup` — deliberately not a root. See
 * {@link antigravityDataDirs}.
 *
 * `asar-out/dist/paths.js:52` — exported as `IDE_BACKUP_DATA_DIR`, commented
 * "User data dir for backup (destination for backup copy)". The name is
 * exported here so a report can *name* the duplicate copy without this module
 * ever offering it as somewhere to read from.
 */
export const ANTIGRAVITY_BACKUP_DATA_DIR = "antigravity-backup";

/**
 * Paths under the customization root that this source names and never opens.
 *
 * A `Record<string, string>` for the same reason `STEP_STATE_FILES` is one in
 * `step-read.ts`: the reason lives next to the name, so a reader of the report
 * and a reader of this file cannot disagree about why something was left alone.
 *
 * The keys are **labels, not resolved paths** — forward-slashed and `~`-rooted
 * because the report renders every path it names with forward slashes, and
 * because a Windows user reading `~/.gemini/config/hooks.json` recognises it
 * while `%USERPROFILE%\.gemini\config\hooks.json` is a different string on
 * every machine. `antigravity-read.ts` turns each key that exists into one
 * `skipped` entry; keys that do not exist produce nothing, so an install that
 * has none of these is not told about five directories it does not have.
 *
 * What each one is, and why it is named rather than read:
 *
 *   - **`hooks.json`** — attested by the product's own customization guide
 *     ("**Hooks** | `hooks.json` | Lifecycle Event"). Its event names and its
 *     payload shape are Antigravity's own, and this build's hook set is a
 *     fixed list of events with shell-command handlers only. Translating one
 *     into the other is a decision the planner makes with its own schema in
 *     hand; a reader that copied the block would produce a report claiming a
 *     mapping nobody wrote.
 *   - **`workflows.json`** — attested twice, as
 *     `~/.gemini/config/workflows.json` in the built-in `migrate-workflows`
 *     skill's manifest list. It is the manifest of which workflows exist, which
 *     the `.md` files beside it already say.
 *   - **`plugins/`** — attested as `plugins/<plugin_name>/` with `plugin.json`,
 *     `mcp_config.json`, `hooks.json`, `rules/`, `skills/` and `agents/`
 *     inside. A whole tree of the user's own content; naming it costs one line
 *     and is what stops a home full of Antigravity plugins from producing a
 *     report that says nothing about any of them.
 *   - **`sidecars/`** — attested as `~/.gemini/config/sidecars/<sidecar…>`. Each
 *     sidecar is a separate Node process the user starts with its own
 *     `package.json`, its own frontend and its own persistent data directory.
 *   - **`antigravity-cli/settings.json`** — attested as the config of the
 *     *`antigravity` CLI*, a different product from this IDE, in a third tree
 *     this source has no reader for.
 */
export const ANTIGRAVITY_NAMED_ONLY: Record<string, string> = {
	"~/.gemini/config/hooks.json":
		"Antigravity's own hook document; its events and payloads are not this build's hook schema, and nothing was translated",
	"~/.gemini/config/workflows.json":
		"a manifest of which workflows exist, which the workflow files beside it already say",
	"~/.gemini/config/plugins":
		"plugin bundles (plugin.json, mcp_config.json, hooks.json, rules/, skills/, agents/) — named, not read",
	"~/.gemini/config/sidecars":
		"sidecar processes the user wrote; each is a separate app with its own frontend and data directory",
	"~/.gemini/antigravity-cli/settings.json":
		"the settings of the antigravity CLI, a different product in a tree this source has no reader for",
};

/**
 * `~/.gemini` — the parent of every Antigravity data directory.
 *
 * Every data path in this module is `join(homedir(), '.gemini', …)`
 * (`asar-out/dist/paths.js:24`, `:27`, `:48`, `:50`, `:52`) with no
 * environment variable anywhere in the expression, so this is the only spelling
 * there is.
 *
 * **The IDE's *own* app-data directory resolves to {@link ANTIGRAVITY_OLD_DATA_DIR}
 * and is therefore not a third root — but not for the reason it looks like.**
 * `getAppDataDir()` is `join(homedir(), '.gemini', getAppDataDirName())`
 * (`paths.js:24`), and `getAppDataDirName` is
 * `app.isPackaged ? app.getName().toLowerCase().replace(/\s+/g, '') :
 * 'antigravity-dev'` (`paths.js:17-22`). The unpackaged branch yields
 * `antigravity-dev`, which a user only has while running from source. The
 * **packaged** branch is the one that matters, and it yields `antigravity`:
 * `package.json` in the shipped tree carries both `"name": "antigravity"` and
 * `"productName": "Antigravity"` (`:2-3`), and lowercasing either gives
 * `antigravity`. The language server says so in its own words — "the app data
 * directory is `~/.gemini/antigravity` (`%USERPROFILE%\.gemini\antigravity` on
 * Windows)" — which is the same string as `IDE_OLD_DATA_DIR`.
 *
 * So the derived app-data directory is a **spelling of the old root**, not a
 * separate one, and a third read of it would import every conversation twice.
 * That is the whole argument, and it is an argument about what the value is —
 * "a name a user never has" would be false of the packaged build, which is the
 * only build a user installs.
 */
export function antigravityGeminiRoot(home: string): string {
	return join(home, ANTIGRAVITY_GEMINI_DIR);
}

/**
 * `~/.gemini/config` — the customization root, and the one directory under
 * `.gemini` that is *not* inside a data root.
 *
 * The product's own guide calls it the "Global Configuration (Machine-Local)"
 * location and gives the path as `~/.gemini/config/`. This is the root the
 * skills, plugins, workflows, hooks and the global MCP document all live under,
 * which is why a home can hold a complete Antigravity customization with no
 * data root at all — and why reading only the data roots would find nothing.
 *
 * It is a **sibling** of the data roots, not their child: `join(homedir(),
 * '.gemini', 'config', …)` (`paths.js:27`) and `join(homedir(), '.gemini',
 * getAppDataDirName())` (`paths.js:24`) are two different branches of the same
 * parent.
 */
export function antigravityConfigDir(home: string): string {
	return join(antigravityGeminiRoot(home), "config");
}

/**
 * `~/.gemini/config/config.json` — the user settings document, JSON despite the
 * `config` in its name.
 *
 * `asar-out/dist/paths.js:26-28`: `getSettingsPbPath()` returns
 * `join(homedir(), '.gemini', 'config', 'config.json')`, and the reader at
 * `dist/utils.js:63-84` opens it with `JSON.parse`. The function's name says
 * `Pb`; nothing about the file is protobuf, and a reader that trusted the name
 * would look for a `.pb` document and report every setting as absent.
 *
 * **Two writers, one file.** The Electron launcher reads it directly for the
 * theme (`dist/utils.js:65`), and the language server owns it — the binary's
 * own plugin-management prompt says "Never hand-edit
 * `~/.gemini/config/config.json` to do this: writes that bypass the language
 * server miss the live reload", and enables a plugin by sending
 * `JetboxWriteState {"userConfig":{"plugins":{…}}}` over its RPC, deep-merged.
 * So the file is the settings store, written by the language server and read by
 * both halves of the app.
 */
export function antigravityConfigPath(home: string): string {
	return join(antigravityConfigDir(home), "config.json");
}

/**
 * The data roots to read, **most authoritative first**.
 *
 * Two, in this order, and the order is not a guess:
 *
 *   1. `~/.gemini/antigravity-ide` — `IDE_NEW_DATA_DIR`, `paths.js:50`.
 *   2. `~/.gemini/antigravity` — `IDE_OLD_DATA_DIR`, `paths.js:48`.
 *
 * The app's own IDE-split migration copies the first from the second and never
 * deletes the source. `maybeShowIdeInstallWizard`'s `doSetup` copies
 * old → new only when the new one is absent, then old → backup only when *that*
 * is absent (`dist/ideInstall/wizard.js:114-131`), and `downloadAndInstallIde`
 * copies old → new again after a fresh IDE download
 * (`dist/ideInstall/service.js:190`). The copy is a full recursive
 * `fs.cp(source, dest, { recursive: true, force: true })`
 * (`service.js:164-171`), so the new root is a superset of the old one
 * afterwards and a conversation written after the split is only in the new one.
 * That is why the new root wins and the old one is the fallback: a file present
 * in both is read once, from the copy the current build writes to.
 *
 * **`antigravity-backup` is not in this list, on purpose.** It is a third full
 * copy of the same tree, made from the same source in the same function
 * (`wizard.js:123-130`). Reading it would import every conversation twice and
 * the report would call the second copy a name collision. Its name is exported
 * as {@link ANTIGRAVITY_BACKUP_DATA_DIR} so a report can mention that a
 * duplicate exists rather than pretending the tree has only two spellings.
 *
 * No environment variable moves any of these: none of the five expressions in
 * `paths.js` consults one. A user who relocated the whole `.gemini` directory
 * has a home the importer cannot be told about, and that is a fact about the
 * caller rather than something this function can resolve.
 *
 * **What is inside one, from the language server's own documentation rather than
 * from a guess.** A data root holds `brain/` (one directory per conversation —
 * see {@link antigravityConversationsDir}) and `sidecar_data/`, the latter
 * attested in three places as `<appDataDir>/sidecar_data/<sidecar-id>/…` with
 * `data/`, `logs/sidecar.log` and the sidecar's own code below it. Note that
 * those three spell the parent as *the app data directory* — which is
 * {@link ANTIGRAVITY_OLD_DATA_DIR}, the **old** root's own name (see the note
 * above on `getAppDataDirName`) — so a sidecar
 * written by a build before the IDE split is under `antigravity/`, not
 * `antigravity-ide/`. That is the one place in the product where the two roots
 * are genuinely not interchangeable, and it is why both are read rather than
 * merged.
 */
export function antigravityDataDirs(home: string): string[] {
	const root = antigravityGeminiRoot(home);
	return [join(root, ANTIGRAVITY_IDE_DATA_DIR), join(root, ANTIGRAVITY_OLD_DATA_DIR)];
}

/**
 * `<data root>/mcp_config.json` — an MCP document beside a data root.
 *
 * **INFERRED, and it is the weaker of the two MCP locations.** The product
 * documents exactly two: `~/.gemini/config/mcp_config.json` for global servers
 * and `plugins/<plugin_name>/mcp_config.json` inside a plugin. Neither is this
 * path, and no literal in the launcher or the binary spells it. It is here
 * because a data root is the other place a per-user document could plausibly
 * live, and because a candidate that costs one `existsSync` recovers a file
 * that would otherwise be invisible.
 *
 * The cost of the inference is bounded and stated rather than hidden: the reader
 * treats this path as *secondary* to
 * {@link antigravityGlobalMcpConfigPath}, because a documented location is one
 * the product reads and an undocumented one is a guess. See
 * {@link antigravityMcpConfigPaths}.
 */
export function antigravityMcpConfigPath(dir: string): string {
	return join(dir, "mcp_config.json");
}

/**
 * `~/.gemini/config/mcp_config.json` — the global MCP document. **Verified.**
 *
 * The product's own MCP documentation, carried inside `language_server.exe`,
 * gives the location as: "**Global Configuration**:
 * `~/.gemini/config/mcp_config.json` (applies to all sessions)", with the second
 * option being "**Plugin Configuration**:
 * `plugins/<plugin_name>/mcp_config.json`".
 *
 * The file name is not a guess in either direction: `mcp_config.json` appears 14
 * times in the binary, `mcp.json` and `mcp_settings.json` appear **zero** times
 * each. A reader that reached for `.mcp.json` — the spelling every other tool in
 * this repo's migration set uses — would find nothing and report the user as
 * having no MCP servers.
 */
export function antigravityGlobalMcpConfigPath(home: string): string {
	return join(antigravityConfigDir(home), "mcp_config.json");
}

/**
 * Every MCP document to consult, **most authoritative first**.
 *
 * The global one is first and the per-data-root one second, which is the
 * reverse of {@link antigravityDataDirs}'s own order and is deliberate for a
 * stated reason: the data roots are ordered by which tree the current build
 * *writes to*, while these two are ordered by which location the product
 * *documents*. `~/.gemini/config/mcp_config.json` is in the product's own
 * documentation; `<data root>/mcp_config.json` is an inference. When both exist
 * and both name the same server, the documented one wins — a file a vendor
 * documents is a file its reader opens, and an inferred path may be a stale
 * copy of a configuration that has since moved. The reader records the
 * collision rather than dropping it, because "you have this server in two
 * places and only one was read" is a sentence the user is owed.
 */
export function antigravityMcpConfigPaths(home: string, dataDir: string | null): string[] {
	const paths = [antigravityGlobalMcpConfigPath(home)];
	if (dataDir !== null) paths.push(antigravityMcpConfigPath(dataDir));
	return paths;
}

/**
 * `<data root>/brain` — every conversation, one directory each.
 *
 * **Attested nine times, in the product's own prose, and it replaced an
 * inference that was wrong.** The binary carries a documentation block for an
 * agent that reads a conversation's own logs, and it gives the path twice in
 * full:
 *
 * > - `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`
 * > - `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl`
 *
 * with `appDataDir` the binary's own name for the data root — "the app data
 * directory is `~/.gemini/antigravity` (`%USERPROFILE%\.gemini\antigravity` on
 * Windows)" — which is the value {@link antigravityDataDirs} already reads. Two
 * further sites give the same shape through the template the product
 * substitutes: `{{ SystemGeneratedLogsPath }}/transcript.jsonl`, and the
 * directory's siblings `swarm.md` (the multi-agent coordination file) and
 * `scratch/`.
 *
 * **What changed and why the old answer was wrong.** An earlier draft of this
 * module looked for `<data root>/conversations`, on the reasoning that every hit
 * for `conversations/` is the gRPC service table (`/v1/conversations`,
 * `ListConversations`), the debug mux (`conversations/debug/pprof`), or a
 * protobuf field — so no directory goes by that name. **That reasoning was
 * overstated and is corrected here, because the correction does not rescue the
 * original guess.** There *is* a directory named `conversations`: three prose
 * strings in the binary name it as one — "summaries_store: failed to stat /
 * read / watch conversations dir %s: %w" — and a fourth bare `conversations`
 * sits in a settings-key table beside `settingEngine` and `SetSessionPin`. So
 * the original reasoning's *conclusion* held for a reason its *argument* did not
 * support: a summaries store really does keep a `conversations` directory, and
 * it is not where conversations with transcripts live.
 *
 * The store is `brain/<id>`, and the gRPC service is a *view* of it. A reader
 * that had shipped `<data root>/conversations` would have found a summaries
 * store's directory or nothing at all on every real install, and told its users
 * they had no conversations. The useful lesson is the narrower one this time
 * round: a zero count was never the signal — **four attestations of a full path
 * were, and their being in prose rather than in a literal was what made them
 * easy to overlook.** `conversations/` still has zero hits; `conversations` as a
 * bare name has several, and the difference is the whole mistake.
 *
 * The two tiers are the product's own and the reason both are named: a compact
 * `transcript.jsonl` plus a `transcript_full.jsonl` for the steps whose
 * `truncated_fields` say a value was cut. Read the compact one; reach for the
 * full one per line, not wholesale — the compact file is the one whose size the
 * product is asking an agent to keep small.
 */
export function antigravityConversationsDir(dir: string): string {
	return join(dir, "brain");
}

/**
 * `<data root>/brain/<id>/.system_generated/logs` — the two transcripts, compact
 * first.
 *
 * Order is the product's instruction rather than this module's preference: "Start
 * with `transcript.jsonl` (compact). When `truncated_fields` is present, read
 * only that specific line in `transcript_full.jsonl`."
 */
export function antigravityTranscriptPaths(conversationDir: string): string[] {
	const logs = join(conversationDir, ".system_generated", "logs");
	return [join(logs, "transcript.jsonl"), join(logs, "transcript_full.jsonl")];
}

/**
 * Every standing-instructions document, in the order they should be read.
 *
 * Four candidates, and only two of the four paths are attested:
 *
 *   - **`~/.gemini/config/memory.txt`** — **verified three times, in three
 *     distinct places.** As a bare path literal in the binary's string table, as
 *     a protobuf *field* carrying it as documentation beside a `path` field ("Path
 *     to daemon configuration proto file"), and as a protobuf **field default**,
 *     `def=~/.gemini/config/memory.txt`. Three sites, and the third is the one
 *     that settles it: a default value is something the product reads, not
 *     something it mentions. It is the machine-local memory file.
 *   - **`~/.gemini/config/GEMINI.md`** and **`~/.gemini/config/AGENTS.md`** —
 *     attested in *form* rather than in path: the product's customization guide
 *     lists `GEMINI.md` and `AGENTS.md` as "standalone" rule files "relative to
 *     the customization root", and names the customization root as
 *     `~/.gemini/config/`. No literal spells either path out in full.
 *   - **`~/.gemini/GEMINI.md`** — **not attested.** No `~/.gemini/GEMINI.md`
 *     literal exists in the binary and no `config/GEMINI.md` one either, and
 *     `GEMINI.md` on its own is documented as a *workspace* file discovered by
 *     walking up from a file to the repository root, which is a per-project
 *     thing a user-level migration cannot enumerate. It is first in this list
 *     because it is the spelling the rest of this repo's migration set already
 *     agreed on for a `<vendor>/<MEMORY>.md`, and it is marked here as the one
 *     entry with no evidence behind it. The reader reads all four, so a home
 *     that has none of the attested ones and does have this one still has its
 *     instructions carried over.
 *
 * Note what is *not* in the list: any file under a data root. `GEMINI.md` is a
 * customization-root file in every attestation, and nothing in either binary
 * places one inside a data directory.
 */
export function antigravityMemoryPaths(home: string): string[] {
	const root = antigravityGeminiRoot(home);
	const config = antigravityConfigDir(home);
	return [join(root, "GEMINI.md"), join(config, "GEMINI.md"), join(config, "AGENTS.md"), join(config, "memory.txt")];
}

/**
 * `~/.gemini/GEMINI.md` — the first entry of {@link antigravityMemoryPaths}.
 *
 * Named for the shape every other source in this repo uses, and deliberately
 * the **first** entry there so the singular helper and the plural one cannot
 * disagree about what "the" memory file is. Read its doc comment before using
 * it as an answer: this exact path is the one candidate with no evidence behind
 * it. {@link antigravityMemoryPaths} is what `antigravity-read.ts` actually
 * reads, and it reads all four.
 */
export function antigravityMemoryPath(home: string): string {
	return antigravityMemoryPaths(home)[0];
}

/** `~/.gemini/config/skills` — the global skills tree, one directory per skill. */
export function antigravitySkillsDir(home: string): string {
	return join(antigravityConfigDir(home), "skills");
}

/**
 * `~/.gemini/config/workflows` — the legacy global workflows tree.
 *
 * **Deprecated by the product itself, in its own words.** The built-in
 * `migrate-workflows` skill carried in `language_server.exe` opens with
 * "Workflows (`.agents/workflows/*.md` or `_agents/workflows/*.md`) are
 * deprecated. Skills (`.agents/skills/<name>/SKILL.md`) provide all the
 * capabilities of workflows, plus: first-class slash command support, semantic
 * agent discovery, multi-file capabilities" — and then lists
 * `~/.gemini/config/workflows/*.md` among the "Global Workflows" to scan,
 * convert to `~/.gemini/config/skills/<name>/SKILL.md`, and archive by renaming
 * to `<name>.md.bak`.
 *
 * Read anyway, and for exactly the reason that skill gives: a user who never
 * ran it still has real instructions in this tree, and the mapping it performs
 * — a workflow markdown becomes a skill directory — is the vendor's own.
 */
export function antigravityWorkflowsDir(home: string): string {
	return join(antigravityConfigDir(home), "workflows");
}

/**
 * `~/.gemini/config/global_workflows` — the other legacy workflows tree, and
 * deprecated for the same reason as {@link antigravityWorkflowsDir}.
 *
 * Listed as a separate location by the same built-in skill, with the same
 * target: `~/.gemini/config/global_workflows/<name>.md` becomes
 * `~/.gemini/config/skills/<name>/SKILL.md`. It is a second spelling rather
 * than a subdirectory — nothing in the binary shows one nested in the other —
 * so a home may have either or both, and both are read.
 */
export function antigravityGlobalWorkflowsDir(home: string): string {
	return join(antigravityConfigDir(home), "global_workflows");
}

/**
 * Whether a directory exists and holds something.
 *
 * The same test, and the same shape, as `treeHasContent` in `step-home.ts` and
 * `sourceHasContent` in `migrate-types.ts` — three copies of a two-line
 * predicate that all have to agree, because two of them decide whether a source
 * is offered and the third decides which root gets read.
 *
 * It is the one function in this module that touches the filesystem, and it is
 * exported rather than kept private for a specific reason: the choice between
 * the two data roots belongs to `antigravity-read.ts`, which is the thing that
 * reads a directory and therefore the thing that can say which one it chose and
 * what the other held. {@link antigravityDataDirs} returns both roots in
 * priority order without deciding between them, so this module never reports a
 * path as being the user's data directory — that would make "where does this
 * source read from?" answerable from this file alone, and it is answered from
 * both.
 *
 * A directory that exists and is empty counts as absent, which is the same
 * answer detection gives.
 */
export function antigravityTreeHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}
