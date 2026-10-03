/**
 * Where OpenClaw keeps its state, and which of the five resolvers wins.
 *
 * **OpenClaw is the first source in this repository whose answer is a list rather
 * than a path**, and that is the single fact this module exists to record. Five
 * independent resolvers in the product compute overlapping things, and they do not
 * agree with each other:
 *
 * | resolver | file | honours |
 * | --- | --- | --- |
 * | {@link openclawStateDir} | `src/config/state-dir.ts:21-31` | `OPENCLAW_STATE_DIR`, then `.openclaw`, then `.clawdbot` |
 * | {@link openclawProfileDir} | `src/cli/profile-utils.ts:26-37` | `OPENCLAW_PROFILE` → `~/.openclaw-<profile>` |
 * | {@link openclawConfigDir} | `src/infra/config-dir.ts:7-20` | `OPENCLAW_STATE_DIR`, then `OPENCLAW_CONFIG_PATH`, then `.openclaw` |
 * | `resolveOsHomeDir` | `src/infra/home-dir.ts:40-51` | **deliberately not** `OPENCLAW_HOME` |
 * | {@link openclawAgentDir} | `src/agents/agent-scope-config.ts:578-589` | `agents[].agentDir` — a config key, not a variable |
 *
 * Read `state-dir.ts:33-43` and `config-dir.ts:7-20` together and the disagreement
 * is concrete: the state resolver falls back to `.clawdbot`, the config resolver
 * does not, and the config resolver will honour an `OPENCLAW_CONFIG_PATH` the
 * state resolver never sees. **An install can therefore have a state directory in
 * one place and a configuration document in another**, which is why
 * {@link openclawConfigCandidates} is a list and {@link openclawStateRoots}
 * returns more than one root.
 *
 * **Every function here takes `env` as a parameter and never reads
 * `process.env`.** The product's own resolvers default to it (`env:
 * NodeJS.ProcessEnv = process.env` is the first parameter of each), but a migrator
 * has no business picking up the developer's shell, and taking it as an argument
 * is what makes a fixture able to state a `$OPENCLAW_STATE_DIR` without setting a
 * real one. `migrate-types.ts` passes `process.env` at the two call sites that need
 * a real process, and every test passes an explicit one.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** The environment block a resolver reads. Never `process.env` inside this file. */
export type OpenClawEnv = Record<string, string | undefined>;

/** `~/.openclaw` — the state directory a current build writes. */
export const OPENCLAW_DEFAULT_DIR = ".openclaw";

/**
 * `~/.clawdbot` — the pre-rename state directory.
 *
 * `resolveLegacyStateDirs` returns a one-element list of exactly this
 * (`src/config/state-dir.ts:8-10`), and it is still read: `resolveStateDirFromHome`
 * returns it when `.openclaw` is absent and it exists (`:38-43`). A user who
 * upgraded from that build has *all* of their state here, so this is a first-class
 * root rather than a curiosity.
 */
export const OPENCLAW_LEGACY_DIR = ".clawdbot";

/** The configuration document's canonical name (`paths.ts:35`). */
export const OPENCLAW_CONFIG_FILENAME = "openclaw.json";

/**
 * The legacy configuration name (`paths.ts:36`).
 *
 * **Tried second, not first.** `configPathsInStateDir` (`paths.ts:38-40`) maps
 * `[CONFIG_FILENAME, ...LEGACY_CONFIG_FILENAMES]` in that order and
 * `findExistingConfigPath` takes the first that exists (`paths.ts:42-44`), so a
 * directory holding both gets the modern one. A migrator that tried the legacy
 * name first would import a document the product is not running.
 */
export const OPENCLAW_LEGACY_CONFIG_FILENAME = "clawdbot.json";

/**
 * What a CLI profile name may be (`profile-utils.ts:5`).
 *
 * **The product throws on a name this rejects** rather than falling back —
 * `resolveProfileStateDir` raises `Invalid profile name` (`:31-33`). A profile
 * directory named by an invalid name is therefore one OpenClaw could not have
 * written, and this importer reports it as a rejected name rather than reading a
 * directory under a spelling the product refuses.
 */
export const OPENCLAW_PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** The profile name that means "no profile" (`profile-utils.ts:11-22,35`). */
export const OPENCLAW_DEFAULT_PROFILE = "default";

/**
 * The maximum depth of an `$include` file chain (`includes.ts:26`).
 *
 * Depth is counted over *files*, not document nesting: the comment at
 * `includes.ts:28-29` says the container walk runs on an explicit work stack and
 * only the `$include` chain keeps a budget.
 */
export const OPENCLAW_INCLUDE_MAX_DEPTH = 10;

/** The largest file an `$include` will read (`includes.ts:31`). */
export const OPENCLAW_INCLUDE_MAX_BYTES = 2 * 1024 * 1024;

/** The `$include` key itself (`includes.ts:25`). */
export const OPENCLAW_INCLUDE_KEY = "$include";

/**
 * The six workspace bootstrap documents, in prompt order
 * (`workspace-bootstrap-policy.ts:29-37`).
 *
 * **`TOOLS.md` is not among them and the omission is deliberate**, which is the
 * whole reason this list is spelled out here rather than reused from the product's
 * constants: `DEFAULT_TOOLS_FILENAME` *is* declared, at
 * `workspace-bootstrap-policy.ts:12`, and is a real file on many workspaces — but
 * `openclaw doctor --fix` folds it into `AGENTS.md`
 * (`src/commands/doctor-tools-md-migration.ts:142,464`). Importing `TOOLS.md` as
 * its own instruction file would resurrect a document the product is retiring.
 */
export const OPENCLAW_BOOTSTRAP_FILENAMES = [
	"AGENTS.md",
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"BOOTSTRAP.md",
	"MEMORY.md",
] as const;

/**
 * The one of those six that has a labunbun equivalent.
 *
 * Only `AGENTS.md` — this build has no counterpart for a persona document
 * (`SOUL.md`), a device identity (`IDENTITY.md`), a user profile (`USER.md`), a
 * first-run script (`BOOTSTRAP.md`) or a root memory index (`MEMORY.md`).
 */
export const OPENCLAW_PRIMARY_INSTRUCTION_FILE = "AGENTS.md";

/**
 * The legacy spelling of the root memory file (`root-memory-files.ts:8`).
 *
 * Read **only** when it is a real file and not a symlink:
 * `resolveCanonicalRootMemoryFile` requires both (`root-memory-files.ts:41-52`).
 * A home whose `memory.md` is a link into somewhere else is a case the product
 * refuses, so this importer names it rather than following it.
 */
export const OPENCLAW_LEGACY_MEMORY_FILENAME = "memory.md";

/** `<stateDir>/agents/<id>/agent` — where an agent's own tree lives. */
export function openclawDefaultAgentDir(stateDir: string, agentId: string): string {
	return join(stateDir, "agents", agentId, "agent");
}

/** The agent directory's authoritative session store. */
export const OPENCLAW_AGENT_DB_FILENAME = "openclaw-agent.sqlite";

/**
 * The agent directory for `agentId`.
 *
 * `agents[].agentDir` wins outright and is run through `resolveUserPath`;
 * otherwise the tree is `<stateDir>/agents/<id>/agent`
 * (`agent-scope-config.ts:578-589`). The key is **configuration, not
 * environment** — `OPENCLAW_AGENT_DIR` appears in this repository's reading of
 * OpenClaw only inside `*.test.ts` files and `oauth-test-utils.ts`, and is not a
 * product variable. Naming it here is how a reader knows not to go looking for it.
 */
export function openclawAgentDir(stateDir: string, agentId: string, configured?: string): string {
	const trimmed = typeof configured === "string" ? configured.trim() : "";
	if (trimmed !== "") return resolve(expandTilde(trimmed, stateDir));
	return openclawDefaultAgentDir(stateDir, agentId);
}

/**
 * `OPENCLAW_HOME`, honoured, or the OS home.
 *
 * `resolveEffectiveHomeDir` takes `OPENCLAW_HOME` first and only falls through to
 * the OS home when it is unset (`home-dir.ts:50-52`). **That precedence does not
 * extend to OS-home paths**: `resolveRequiredOsHomeDir` calls `resolveOsHomeDir`,
 * which `home-dir.ts:40-51` documents as deliberately ignoring it. So a user who
 * exports `OPENCLAW_HOME` gets OpenClaw's own state moved and everything that
 * resolves against the real OS home unchanged — a split this importer reports
 * rather than papers over.
 */
export function openclawHome(home: string, env: OpenClawEnv): string {
	const explicit = env.OPENCLAW_HOME?.trim();
	if (explicit === undefined || explicit === "") return resolve(home);
	if (explicit === "~" || explicit.startsWith("~/") || explicit.startsWith("~\\")) {
		return resolve(explicit.replace(/^~(?=$|[\\/])/, () => resolve(home)));
	}
	return resolve(explicit);
}

/**
 * `OPENCLAW_PROFILE` as a profile name, or `null`.
 *
 * The three ways a value becomes "no profile" are all here: absent, blank after
 * trimming, and the literal `default` (`profile-utils.ts:11-22`). A name that
 * fails {@link OPENCLAW_PROFILE_NAME_RE} also becomes `null`, but for a different
 * reason — there the product *throws* (`:31-33`) while `normalizeProfileName`
 * returns `null` (`:16-21`) — and {@link openclawProfileRejection} tells those two
 * apart rather than collapsing them.
 */
export function openclawProfile(env: OpenClawEnv): string | null {
	const raw = env.OPENCLAW_PROFILE?.trim();
	if (raw === undefined || raw === "") return null;
	if (raw.toLowerCase() === OPENCLAW_DEFAULT_PROFILE) return null;
	return OPENCLAW_PROFILE_NAME_RE.test(raw) ? raw : null;
}

/**
 * Why `OPENCLAW_PROFILE` was not used, or `null`.
 *
 * `"invalid"` is a distinct answer from `"none"` and the report treats them
 * differently: an unset or `default` profile is the ordinary case, while an
 * invalid one names a configuration OpenClaw refuses to start with
 * (`profile-utils.ts:31-33`).
 */
export function openclawProfileRejection(env: OpenClawEnv): "invalid" | null {
	const raw = env.OPENCLAW_PROFILE?.trim();
	if (raw === undefined || raw === "") return null;
	if (raw.toLowerCase() === OPENCLAW_DEFAULT_PROFILE) return null;
	return OPENCLAW_PROFILE_NAME_RE.test(raw) ? null : "invalid";
}

/**
 * A one-line description of the profile root this environment selects.
 *
 * Named rather than returned as a path because the *interesting* cases are the
 * ones with no directory: an unset profile and an explicit `default` both land on
 * plain `~/.openclaw`, and the report's job is to say which of them happened.
 */
export function openclawProfileStateNotice(env: OpenClawEnv): string {
	const raw = env.OPENCLAW_PROFILE?.trim();
	if (raw === undefined || raw === "") return "OPENCLAW_PROFILE (unset)";
	if (raw.toLowerCase() === OPENCLAW_DEFAULT_PROFILE) return "OPENCLAW_PROFILE=default";
	return `OPENCLAW_PROFILE=${raw} → ~/.openclaw-${raw}`;
}

/**
 * `~/.openclaw-<profile>`, or `~/.openclaw` for the default profile
 * (`profile-utils.ts:35-37`).
 *
 * **The `default` profile resolves to the un-suffixed directory**, which is the
 * detail that makes profile roots enumerable rather than a single extra
 * directory: a default-profile install and a no-profile install share one tree.
 */
export function openclawProfileDir(home: string, profile: string): string {
	const suffix = profile.toLowerCase() === OPENCLAW_DEFAULT_PROFILE ? "" : `-${profile}`;
	return `${join(home, OPENCLAW_DEFAULT_DIR)}${suffix}`;
}

/**
 * The state directory — `$OPENCLAW_STATE_DIR`, else `$OPENCLAW_PROFILE`'s root,
 * else `.openclaw`, else `.clawdbot` (`state-dir.ts:21-43`).
 *
 * **The override is not verbatim.** It goes through `resolveHomeRelativePath`
 * (`state-dir.ts:27`), so a leading `~` is expanded against the effective home
 * and a relative value is resolved.
 *
 * **The profile is applied here, and `resolveStateDir` does not read it.** That is
 * not an omission in the product: the CLI's profile handling writes the profile's
 * root into `OPENCLAW_STATE_DIR` before any resolver runs
 * (`src/cli/profile.ts:129-137` — `env.OPENCLAW_PROFILE = profile`, then
 * `env.OPENCLAW_STATE_DIR = stateDir`), and `resolveStateDir` is handed the
 * already-mutated environment. A migrator reads a raw environment instead, so it
 * has to do that one step itself or a home whose `OPENCLAW_PROFILE` is exported
 * would be read from the *default* profile's tree — which is a different install.
 *
 * Explicit `$OPENCLAW_STATE_DIR` still wins over the profile, which is the
 * product's own order: the profile is only folded in when the user named none.
 *
 * The fallback after both is *existence-based*: `.openclaw` wins if it is there,
 * `.clawdbot` is used only when it is there and `.openclaw` is not, and if neither
 * exists the answer is `.openclaw` anyway (`:36-43`).
 */
export function openclawStateDir(
	home: string,
	env: OpenClawEnv,
	exists: (path: string) => boolean = existsSync,
): string {
	const override = env.OPENCLAW_STATE_DIR?.trim();
	if (override !== undefined && override !== "") return resolve(expandTilde(override, home));
	const root = openclawHome(home, env);
	const profile = openclawProfile(env);
	if (profile !== null) return openclawProfileDir(root, profile);
	const current = join(root, OPENCLAW_DEFAULT_DIR);
	if (exists(current)) return current;
	const legacy = join(root, OPENCLAW_LEGACY_DIR);
	return exists(legacy) ? legacy : current;
}

/** `~/.clawdbot` (`state-dir.ts:8-10`), named whether or not it exists. */
export function openclawLegacyStateDir(home: string): string {
	return join(home, OPENCLAW_LEGACY_DIR);
}

/**
 * Every state root worth detecting, most authoritative first.
 *
 * Three roots, and the list is longer than the answer for one machine on purpose:
 * a user's `.openclaw` may be empty while a migrated `.clawdbot` holds their real
 * history, and a named profile puts a *third* directory on disk that nothing else
 * in this list would find. What this cannot do is enumerate profiles — a profile
 * name is only discoverable from `OPENCLAW_PROFILE`, and a user who ran
 * `openclaw --profile work` once without the variable set afterwards has a
 * `~/.openclaw-work` this importer never looks at. That is stated rather than
 * worked around, because the alternative is a rule that sounds exhaustive and is
 * not.
 */
export function openclawStateRoots(home: string, env: OpenClawEnv): string[] {
	const root = openclawHome(home, env);
	const profile = openclawProfile(env);
	return [
		openclawStateDir(home, env),
		join(root, OPENCLAW_DEFAULT_DIR),
		openclawLegacyStateDir(home),
		...(profile === null ? [] : [openclawProfileDir(root, profile)]),
	];
}

/**
 * The configuration directory (`config-dir.ts:7-20`).
 *
 * **Two disagreements with {@link openclawStateDir}, both load-bearing.** This
 * resolver honours `OPENCLAW_CONFIG_PATH` — taking its *directory* — and the
 * state resolver does not; and this one's fallback is a plain `.openclaw`, with no
 * `.clawdbot` in it at all. So for a `.clawdbot`-only install the state directory
 * and the configuration directory are different paths, and only this one is where
 * `openclaw.json` will be looked for.
 */
export function openclawConfigDir(home: string, env: OpenClawEnv): string {
	const override = env.OPENCLAW_STATE_DIR?.trim();
	if (override !== undefined && override !== "") return resolve(expandTilde(override, home));
	const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
	if (configPath !== undefined && configPath !== "") return resolve(expandTilde(configPath, home), "..");
	return join(openclawHome(home, env), OPENCLAW_DEFAULT_DIR);
}

/**
 * Every configuration file the product would consider, in its own order
 * (`paths.ts:320-334`).
 *
 * `$OPENCLAW_CONFIG_PATH` short-circuits to a single candidate because an explicit
 * selection is "independent of existence" (`paths.ts:249`, `:326-328`) — the same
 * sentence the product uses to say an override need not exist yet. Otherwise the
 * list is `$OPENCLAW_STATE_DIR` first when set, then `.openclaw`, then
 * `.clawdbot`, each expanded to both spellings. **The state directory's own
 * candidate list is consulted before `.clawdbot`** (`paths.ts:275-279`), which is
 * why this returns a list rather than a single path.
 */
export function openclawConfigCandidates(home: string, env: OpenClawEnv): string[] {
	const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
	if (explicit !== undefined && explicit !== "") return [resolve(expandTilde(explicit, home))];
	const root = openclawHome(home, env);
	const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
	const dirs =
		stateOverride !== undefined && stateOverride !== ""
			? [resolve(expandTilde(stateOverride, home)), join(root, OPENCLAW_DEFAULT_DIR), openclawLegacyStateDir(home)]
			: [join(root, OPENCLAW_DEFAULT_DIR), openclawLegacyStateDir(home)];
	return dirs.flatMap((dir) => [join(dir, OPENCLAW_CONFIG_FILENAME), join(dir, OPENCLAW_LEGACY_CONFIG_FILENAME)]);
}

/**
 * The configuration file in use, preferring one that exists
 * (`paths.ts:239-255`).
 *
 * Falls back to `<stateDir>/openclaw.json` when nothing is on disk — the path a
 * first run would create — so this is always an answer and never a guess, which is
 * what lets the report print a path for a home that has never configured anything.
 */
export function openclawConfigPath(
	home: string,
	env: OpenClawEnv,
	exists: (path: string) => boolean = existsSync,
): string {
	const found = openclawConfigCandidates(home, env).find((candidate) => exists(candidate));
	if (found !== undefined) return found;
	return join(openclawConfigDir(home, env), OPENCLAW_CONFIG_FILENAME);
}

/**
 * The directories holding managed skills (`config-dir.ts:7-20` names the config
 * directory; the two subdirectories are its own layout).
 *
 * Two roots rather than one because OpenClaw ships a *managed* tree
 * (`skills/`) beside a *plugin-provided* one (`plugin-skills/`), and a user can
 * have content in either. The managed one comes first so a name present in both
 * keeps the copy OpenClaw would have loaded itself.
 */
export function openclawSkillDirs(configDir: string): string[] {
	return [join(configDir, "skills"), join(configDir, "plugin-skills")];
}

/**
 * Expand a leading `~` against `home`, then resolve.
 *
 * Stands in for `resolveHomeRelativePath` / `resolveUserPath`
 * (`state-dir.ts:27`, `config-dir.ts:15`). A value that does not start with `~` is
 * resolved against this process's working directory rather than against `home` —
 * the same trade `t3BaseDir` documents, and for the same reason: OpenClaw does
 * the same, so a relative override that this importer resolved differently would
 * point at a directory OpenClaw never wrote.
 */
function expandTilde(value: string, home: string): string {
	if (value === "~") return resolve(home);
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return resolve(value.replace(/^~(?=$|[\\/])/, () => resolve(home)));
	}
	return resolve(value);
}
