import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** The directory Kimi Code keeps its state in when `$KIMI_CODE_HOME` names none. */
export const KIMI_CODE_DEFAULT_DIR = ".kimi-code";

/** The variable that moves the tree (`KIMI_CODE_HOME_ENV` in the CLI's own constants). */
export const KIMI_CODE_HOME_ENV = "KIMI_CODE_HOME";

/**
 * The tree Kimi Code's predecessor, `kimi-cli`, left behind — a *different*
 * product's directory, which this migrator names but never reads.
 *
 * Kimi Code ships its own migrator for it (`apps/kimi-code/src/migration/`),
 * with its own source root and its own `$KIMI_SHARE_DIR` override
 * (`legacy-source.ts`), and it reads a different on-disk layout: `kimi-cli`
 * keeps plans under `~/.kimi/plans` and shares no file format with the wire
 * protocol this reader parses. So a user who has not yet run Kimi Code's own
 * migration has that tree, not this one — and the report says so by name rather
 * than reading a directory whose files would be mis-parsed as empty sessions.
 * `kimiLegacySourceRoot` below says where that tree would be; nothing here ever
 * opens a file inside it.
 */
export const KIMI_CLI_LEGACY_DIR = ".kimi";

/**
 * Where Kimi Code keeps its tree: `$KIMI_CODE_HOME` verbatim, else
 * `<home>/.kimi-code`.
 *
 * Two readings of the same variable exist in Kimi Code and they agree
 * everywhere except one value, so this module picks one and says which:
 *
 *   - the engine resolves
 *     `homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code')`
 *     (`app/bootstrap/bootstrap.ts`), where `??` makes an **empty string a
 *     value** — the config path then becomes `join('', 'config.toml')`, a
 *     path relative to whatever directory the process was started in;
 *   - the CLI's own data-dir helper uses `if (envDir)`, where an **empty
 *     string is unset** (`apps/kimi-code/src/utils/paths.ts`).
 *
 * This reader follows the CLI: an empty value falls back to `~/.kimi-code`.
 * The engine's reading of `""` names a tree relative to a working directory
 * that a reader of finished sessions does not have, so honouring it would mean
 * reading — or claiming to read — files under *this* process's cwd. Every other
 * value is the same on both sides, so the choice only decides a case no user
 * typed on purpose.
 *
 * The value is used **verbatim**: Kimi Code does not trim it, does not expand a
 * leading `~`, and does not resolve it, so `$KIMI_CODE_HOME=~/elsewhere` names a
 * directory literally called `~`, and a relative value stays relative. Anything
 * else here would read a tree that does not exist and report a configured Kimi
 * Code as absent.
 */
export function kimiRoot(home: string): string {
	const configured = process.env[KIMI_CODE_HOME_ENV];
	if (configured !== undefined && configured !== "") return configured;
	return join(home, KIMI_CODE_DEFAULT_DIR);
}

/** The variable that moves `kimi-cli`'s tree, which Kimi Code migrates from. */
export const KIMI_SHARE_DIR_ENV = "KIMI_SHARE_DIR";

/** Where `kimi-cli`'s tree is, and which rule put it there. */
export interface KimiLegacySource {
	/** The tree to read: `<home>/.kimi`, or the resolved `$KIMI_SHARE_DIR`. */
	root: string;
	/** Which of the two named it, so the report can say why it is not the default. */
	origin: "default" | "share-dir";
	/** `<home>/.kimi`, present only when the share directory moved the tree off it. */
	skillsRoot?: string;
}

/**
 * Where `kimi-cli` keeps its tree: `$KIMI_SHARE_DIR` (resolved) else
 * `<home>/.kimi`.
 *
 * Kimi Code's own migrator resolves this in `resolveLegacySourceHome`
 * (`apps/kimi-code/src/migration/legacy-source.ts:17-31`), and three of its rules
 * are not the ones a reader of `$KIMI_CODE_HOME` would guess:
 *
 *   - an **all-whitespace** share directory counts as unset
 *     (`shareDir === undefined || shareDir.trim() === ''`), where the *other*
 *     variable this module resolves takes whitespace for a directory name — so
 *     the two variables in this one file disagree about what an empty-looking
 *     value means, each because its own tool says so;
 *   - a relative value resolves against the **working directory**
 *     (`resolve(cwd, shareDir)`), not against the home directory, which is why
 *     `cwd` is a parameter here rather than something read from `process.cwd()`
 *     inside: a caller that is not the CLI still has to say which directory the
 *     value is relative to, and a test has to be able to drive both branches;
 *   - a share directory that moved the tree off `<home>/.kimi` does not retire
 *     that directory: skills are still read from it (`skillsSourceHome = sourceHome
 *     === defaultHome ? undefined : defaultHome`), so the answer carries both
 *     paths and the caller reads skills from `skillsRoot` when it is there;
 *   - the comparison that decides whether the share directory *is* the default is
 *     `===` on the two computed strings, not the module's own `sameLegacyPath`
 *     helper (`legacy-source.ts:33-38`, which folds case on Windows) — so this
 *     mirrors the resolver's answer rather than a stricter identity of its own,
 *     and a share directory spelled as the default after `resolve` still leaves
 *     `skillsRoot` undefined.
 *
 * A leading `~` is not expanded here either, but unlike `$KIMI_CODE_HOME` — where
 * it stays a directory literally named `~` — it is not absolute, so it resolves
 * against `cwd` and lands in `<cwd>/~/...`.
 *
 * This function only computes strings: it creates nothing, opens nothing, and
 * does not care whether either tree exists. `existsSync` on the returned paths is
 * the caller's move, so a `$KIMI_SHARE_DIR` naming a directory that is not there
 * is a finding for the report rather than an error raised here.
 */
export function kimiLegacySourceRoot(home: string, cwd: string): KimiLegacySource {
	const defaultHome = join(home, KIMI_CLI_LEGACY_DIR);
	const shareDir = process.env[KIMI_SHARE_DIR_ENV];
	if (shareDir === undefined || shareDir.trim() === "") return { root: defaultHome, origin: "default" };
	const root = isAbsolute(shareDir) ? resolve(shareDir) : resolve(cwd, shareDir);
	if (root === defaultHome) return { root, origin: "share-dir" };
	return { root, origin: "share-dir", skillsRoot: defaultHome };
}

/** `<root>/config.toml` — settings, hooks and provider definitions. */
export function kimiConfigPath(root: string): string {
	return join(root, "config.toml");
}

/** `<root>/sessions` — one directory per working directory, one per session. */
export function kimiSessionsDir(root: string): string {
	return join(root, "sessions");
}

/** `<root>/user-history` — prompt history, one file per working directory. */
export function kimiInputHistoryDir(root: string): string {
	return join(root, "user-history");
}

/**
 * `<root>/user-history/<md5(cwd)>.jsonl` — the prompt history of one project.
 *
 * The key is the md5 of the working directory *as Kimi Code recorded it*, so the
 * only way back from a file to a project is to hash each cwd a session reports
 * and compare; the reader does exactly that rather than guessing a path.
 */
export function kimiInputHistoryFile(root: string, cwd: string): string {
	const key = createHash("md5").update(cwd, "utf-8").digest("hex");
	return join(kimiInputHistoryDir(root), `${key}.jsonl`);
}

/**
 * The prompt history file of one project, or `null` when there is none.
 *
 * `kimiInputHistoryFile` above is the key: it computes the one path Kimi's own
 * writer would use for a working directory it is holding. A migration is not
 * holding that string — it has the working directory a session recorded, or a
 * project it found on disk — and the file was hashed from whatever
 * `process.cwd()` returned to *that* run (`apps/kimi-code/src/utils/paths.ts:143-146`),
 * so the same directory can be spelled more than one way and only one of those
 * spellings has a file behind it. This tries the spellings, in this order:
 *
 *   1. the string as given — `process.cwd()` verbatim, which is what the CLI
 *      hashed, and the only candidate that is right on a platform whose `cwd`
 *      spelling the caller already has;
 *   2. the same string with `\` turned into `/` — how a reader that normalises
 *      to POSIX separators spells the same directory;
 *   3. `resolve(cwd)` — absolute and platform-normalised, which is what a
 *      relative or dotted value needs, and on Windows is also the step that
 *      turns `C:/proj` into the `C:\proj` a Windows CLI hashed.
 *
 * The first of them that exists wins, equal candidates are computed once, and a
 * project with no history answers `null` — not a path to a file that is not
 * there. Nothing is created and nothing is written: this is a lookup, and the
 * source tree a migration reads must not gain a directory because the migration
 * asked about it.
 */
export function kimiInputHistoryLookup(root: string, cwd: string): string | null {
	const tried = new Set<string>();
	for (const candidate of [cwd, cwd.replaceAll("\\", "/"), resolve(cwd)]) {
		const key = createHash("md5").update(candidate, "utf-8").digest("hex");
		const path = join(kimiInputHistoryDir(root), `${key}.jsonl`);
		if (tried.has(path)) continue;
		tried.add(path);
		if (existsSync(path)) return path;
	}
	return null;
}

/** `<root>/skills` — user skills, beside the plugin- and project-level roots. */
export function kimiSkillsDir(root: string): string {
	return join(root, "skills");
}

/** `<root>/agents` — user subagent profiles. */
export function kimiAgentsDir(root: string): string {
	return join(root, "agents");
}

/** `<root>/plugins` — install records and managed copies of installed plugins. */
export function kimiPluginsDir(root: string): string {
	return join(root, "plugins");
}

/** `<root>/credentials` — named only; this reader never opens anything inside it. */
export function kimiCredentialsDir(root: string): string {
	return join(root, "credentials");
}

/** `<root>/mcp.json` — the user-level MCP servers, before the two project files. */
export function kimiMcpFile(root: string): string {
	return join(root, "mcp.json");
}
