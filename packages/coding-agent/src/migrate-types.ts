/**
 * The vocabulary every migration module shares: which sources exist, what one
 * of them looks like once read, and what a planned write or a report line is.
 *
 * This module is deliberately a leaf. `migrate-history.ts` needs
 * {@link MigrationSourceId} and the hub needs all of it, so anything that would
 * have to import back from either of them cannot live here — which is why
 * `PlanOptions`, the one type that talks about imported history, stays in the
 * hub. Keeping that edge one-way is what lets `migrate-history.ts` name the source
 * ids without the two modules importing each other.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode, SandboxMode } from "@labunbun/agent";
import { resolveModel } from "@labunbun/ai";
import { almaConfigDir, almaDetectionRoots } from "./alma-home.ts";
import { antigravityConfigDir, antigravityDataDirs } from "./antigravity-home.ts";
import { CODEWHALE_DEFAULT_DIR, codewhaleDefaultRoots, resolveCodewhaleHome } from "./codewhale-home.ts";
import { codexRoot } from "./codex-home.ts";
import { cursorDetectionRoots, cursorUserRoot } from "./cursor-home.ts";
import { DSH_DEFAULT_DIR, dshRoot } from "./dsh-home.ts";
import { GROK_DEFAULT_DIR, grokRoot } from "./grok-home.ts";
import { KIMI_CODE_DEFAULT_DIR, kimiRoot } from "./kimi-home.ts";
import { mimocodeRoots } from "./mimocode-home.ts";
import { MINIMAX_DATA_DIR_BASENAME, minimaxRoot } from "./minimax-home.ts";
import { OPENCLAW_DEFAULT_DIR, openclawStateDir, openclawStateRoots } from "./openclaw-home.ts";
import { opencodeRoots } from "./opencode-home.ts";
import { QODER_CN_DEFAULT_DIR, QODER_DEFAULT_DIR, qoderConfigDir } from "./qoder-home.ts";
import { STEPCODE_DEFAULT_DIR, stepRoot } from "./step-home.ts";
import { T3_DEFAULT_DIR, t3Root, t3StateDirs } from "./t3-home.ts";
import { traeDetectionRoots, traeEdition, traeGlobalRulesDir } from "./trae-home.ts";
import { ZCODE_DEFAULT_DIR, zcodeRoot } from "./zcode-home.ts";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export type MigrationSourceId =
	| "claude-code"
	| "codex"
	| "zcode"
	| "agents"
	| "deepseek-harness"
	| "grok-build"
	| "kimi-code"
	| "minimax-code"
	| "step-code"
	| "opencode"
	| "cursor"
	| "trae"
	| "t3-code"
	| "antigravity"
	| "qoder"
	| "codewhale"
	| "mimocode-code"
	| "openclaw"
	| "alma";

/**
 * Ordered as the picker and `--from` list them. New sources are appended: the
 * order is what `detectSources` reports, and reordering would silently change
 * which of two sources providing the same file wins.
 */
export const MIGRATION_SOURCE_IDS: MigrationSourceId[] = [
	"claude-code",
	"codex",
	"zcode",
	"agents",
	"deepseek-harness",
	"grok-build",
	"kimi-code",
	"minimax-code",
	"step-code",
	"opencode",
	"cursor",
	"trae",
	"t3-code",
	"antigravity",
	"qoder",
	"codewhale",
	"mimocode-code",
	"openclaw",
	"alma",
];

/** Display names for the picker; the ids themselves are the CLI switches. */
export const MIGRATION_SOURCE_LABELS: Record<MigrationSourceId, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
	zcode: "ZCode",
	agents: "~/.agents (shared agent home)",
	"deepseek-harness": "DeepSeek Harness",
	"grok-build": "Grok Build",
	"kimi-code": "Kimi Code",
	"minimax-code": "MiniMax Code",
	"step-code": "Step Code",
	opencode: "OpenCode",
	cursor: "Cursor",
	trae: "Trae",
	"t3-code": "T3 Code",
	antigravity: "Antigravity",
	qoder: "Qoder",
	codewhale: "Codewhale",
	"mimocode-code": "MiMo Code",
	openclaw: "OpenClaw",
	alma: "Alma",
};

/**
 * Directory that marks a source as present, relative to home.
 *
 * Only for the sources whose tree really is under `~`. dsh and grok both let an
 * environment variable put theirs anywhere, so their entries here are the
 * *default* spelling, used to render a label rather than to find the tree — see
 * {@link sourceRoot}, which is what detection and the readers call.
 */
export const SOURCE_ROOTS: Record<MigrationSourceId, string> = {
	"claude-code": ".claude",
	codex: ".codex",
	zcode: ZCODE_DEFAULT_DIR,
	agents: ".agents",
	"deepseek-harness": DSH_DEFAULT_DIR,
	"grok-build": GROK_DEFAULT_DIR,
	"kimi-code": KIMI_CODE_DEFAULT_DIR,
	"minimax-code": MINIMAX_DATA_DIR_BASENAME,
	"step-code": STEPCODE_DEFAULT_DIR,
	// Not a single segment, and the only entry here that is two directories deep:
	// OpenCode puts its tree under the XDG bases, and `xdg-basedir@5.1.0` has no
	// Windows branch, so on Windows this is `~/.config/opencode` and not
	// `%APPDATA%`. The path exists to render a label — see `sourceRoot`, which is
	// what actually finds the tree.
	opencode: ".config/opencode",
	// Both of these are *also* not the whole story, and for a reason the other nine
	// do not have: an IDE that has been opened and used keeps its state in a
	// profile directory outside the home, so the home-relative spelling is the CLI
	// half only. `cursor` is the CLI's home; `trae` is the international global
	// home, and the China build's is `.trae-cn`. Both exist to render a label —
	// `detectionRoots` is what finds the trees.
	cursor: ".cursor",
	trae: ".trae",
	// T3 Code's *base* directory, not its state directory, and the gap between
	// the two is the whole reason `sourceRoot` has a branch for it. The tree a
	// migration reads lives at `<base>/userdata` (`t3-home.ts`), which is also
	// where a `$T3CODE_HOME` override lands, so `~/.t3` is the spelling that
	// exists for every user who has not overridden it — the label, not the answer.
	// See `sourceRoot`.
	"t3-code": T3_DEFAULT_DIR,
	// `~/.gemini`, and this one is **not** a directory only Antigravity uses — the
	// Gemini CLI keeps its own state beside it. That is why it cannot be a detection
	// root, and why the entry below it says so in as many words: a home with only
	// Gemini CLI content has a non-empty `~/.gemini` and no Antigravity in it at all,
	// and detection that looked here would offer those users a source with nothing
	// to read. `detectionRoots` looks inside instead. See `sourceRoot`.
	antigravity: ".gemini",
	// `~/.qoder`, and unlike `~/.gemini` above this one is **not** shared with a
	// foreign tool: the Qoder CLI's home is `~/.qoder` too — `$QODER_CLI_HOME`
	// defaults to the user's home and the directory name is appended to it — so
	// anything in here was written by Qoder and only by Qoder. That is why this
	// entry can be a plain relative spelling while `sourceRoot` still has a branch
	// for the id: the *override* is what moves the tree, not a second tool. See
	// `sourceRoot`.
	qoder: QODER_DEFAULT_DIR,
	// `~/.codewhale`, and this one is the **first source whose root is not a single
	// directory**: Codewhale is a rename of DeepSeek-TUI and `~/.deepseek` is a
	// live fallback root for some of its readers and not for others
	// (`CODEWHALE_LEGACY_FALLBACK` in `codewhale-home.ts` records which is which).
	// The spelling here is the canonical half; `sourceRoot` and `detectionRoots`
	// resolve both.
	codewhale: CODEWHALE_DEFAULT_DIR,
	// **Also not a single segment, and for the same reason as OpenCode's entry
	// above.** MiMo Code is an opencode fork whose `packages/shared/src/global.ts`
	// imports `xdg-basedir` with no platform branch, so the tree lives under the
	// XDG bases and on Windows this is `~/.config/mimocode` rather than
	// `%LOCALAPPDATA%`. **The product's own README disagrees** — it claims
	// `%LOCALAPPDATA%\mimocode\` (`README.md:385`) and
	// `~/Library/Application Support/mimocode/` (`:422`), and neither path is
	// anywhere in the tree. Like OpenCode's, this exists to render a label; see
	// `sourceRoot`, which is what finds the tree.
	"mimocode-code": ".config/mimocode",
	// `.openclaw`, and the entry exists only to render a label. **Three spellings
	// are live and they disagree**: `resolveStateDir` falls back to `.clawdbot`
	// when `.openclaw` is absent (`state-dir.ts:33-43`), `OPENCLAW_PROFILE` puts a
	// named profile in `.openclaw-<name>` (`cli/profile-utils.ts:35-37`), and
	// `OPENCLAW_STATE_DIR` replaces the root outright. A plain relative spelling is
	// therefore wrong for two of the three ways this source installs itself, which
	// is why both `sourceRoot` and `detectionRoots` have branches for it. See
	// `openclaw-home.ts`, which is where all five resolvers are quoted.
	openclaw: OPENCLAW_DEFAULT_DIR,
	// `.config/alma`, and this is **the only one of Alma's four roots that this
	// importer reads a file from**. Alma writes to Electron's `userData`
	// (`%APPDATA%\alma`, holding `chat_threads.db`), to `~/.alma` (binaries, an
	// npm cache, screenshots) and to `~/alma` — no leading dot, the browser
	// extension's stable copy and `worktrees/`. Three roots for one source is the
	// record so far, so the label names the configuration root and both
	// `sourceRoot` and `detectionRoots` have branches for the rest. See
	// `alma-home.ts`, which is where all four are quoted.
	alma: ".config/alma",
};

/**
 * Where a source's tree actually is.
 *
 * Most roots are home-relative. Seven are not: `$DSH_HOME`, `$GROK_HOME`,
 * `$CODEX_HOME`, `$KIMI_CODE_HOME`, MiniMax's pair of variables, Step's two and
 * `$ZCODE_DATA_BASE_DIR` can each put their tree anywhere, and a reader that
 * consulted `~/` anyway would call the source absent while the importer went on
 * to import from it — or, worse here, detection would find it while the label
 * named a path nobody read. One function rather than a condition inside
 * `detectSources`, so the detection and the readers cannot disagree about which
 * tree a source is.
 *
 * Step's entry is `stepRoot`, which is also the only one that is *not* a single
 * expression: the directory name itself is a setting (`$STEPCODE_CONFIG_DIR`),
 * an agent-directory override moves the tree out of the home entirely, and the
 * pre-rename `.step-harness` tree is read when the canonical one holds nothing.
 *
 * ZCode's is the one whose *default* is also a variable: the desktop half of its
 * tree is `$ZCODE_DATA_BASE_DIR/.zcode`, so this function is where the data
 * directory name stops being a constant. Its CLI half is a second root with a
 * second variable and is resolved in `zcode-read.ts`; detection deliberately
 * looks only at the data root, because that is the half a fresh install always
 * has.
 */
function sourceRoot(id: MigrationSourceId, home: string): string {
	if (id === "deepseek-harness") return dshRoot(home);
	if (id === "grok-build") return grokRoot(home);
	if (id === "codex") return codexRoot(home);
	if (id === "kimi-code") return kimiRoot(home);
	if (id === "minimax-code") return minimaxRoot(home).root;
	if (id === "step-code") return stepRoot(home);
	// OpenCode's three roots are three different XDG bases, and this is the config
	// one; detection looks at the config and data roots together, in
	// `detectionRoots`. See `opencodeRoots`, which is what the reader uses for all
	// three.
	if (id === "opencode") return opencodeRoots(home).config;
	// MiMo Code's config root, from the same derivation OpenCode's uses and for the
	// same reason: four XDG bases rather than one home-relative directory, so
	// `join(home, SOURCE_ROOTS[id])` would be wrong for a user who has moved any of
	// them. `mimocodeRoots` also honours `$MIMOCODE_HOME`, which replaces all four.
	//
	// It reads `process.env` through its `env` parameter, as `opencodeRoots` does
	// directly and for the same reason: a developer with `MIMOCODE_HOME` set gets
	// that tree, which is the correct answer for their machine. A reader that takes
	// the block as an argument (`readMiMoCode`) is what the tests point at a
	// fixture with.
	if (id === "mimocode-code") return mimocodeRoots(home, process.env).config;
	// Neither of these is a home-relative join. Both are VS Code forks whose state
	// lives outside the home, and both have a first-class path derivation worth
	// calling rather than spelling out again here.
	//
	// **These two branches are unreachable today, and no test covers them.**
	// `detectionRoots` answers both ids before it ever gets here, because a VS Code
	// fork is detected by more than one root. They are kept because they are the
	// right answer — `~/.trae` would be *wrong* for Trae, whose global rules live in
	// `~/.trae/user_rules` — and a future caller deserves the correct one. The
	// alternative, deleting them, leaves `return join(home, SOURCE_ROOTS[id])` as the
	// fallthrough for a source whose root is not a home-relative join, with nothing
	// to catch it. Said here rather than left for a reader to assume a branch that
	// runs on every import.
	if (id === "cursor") return cursorUserRoot(home);
	if (id === "trae") return traeGlobalRulesDir(home, traeEdition(home));
	if (id === "zcode") return zcodeRoot(home);
	// T3 Code's state is a *subdirectory* of the directory this table names, and
	// which of the two subdirectories a given install has depends on whether the
	// user ever launched a dev build — a fact only `t3Root` and `t3StateDirs`
	// know, and the reason this entry falls through to `join(home, ".t3")` would
	// be wrong. `t3Root` is the directory the reader will actually open; the
	// `??` is the fallback for a label rendered against a tree nothing was read
	// from, which is the same state `detectionRoots` reports as absent.
	if (id === "t3-code") return t3Root(home) ?? t3StateDirs(home)[0];
	// Qoder's tree moves for two reasons the plain `join` below cannot express: a
	// whole-path override (`$QODER_CONFIG_DIR`, which wins outright and is used
	// verbatim) and a directory *name* the user chose (`$QODER_CONFIG_DIR_NAME`,
	// applied under `$QODER_CLI_HOME` or the home). Both are the product's own
	// precedence — `qoderConfigDir` quotes it — so calling it here means detection
	// and the reader cannot disagree about which tree the source is.
	//
	// `qoderConfigDir` reads `process.env` directly, as `codexRoot` and `t3Root`
	// do. That is the same trade those two make and it has one consequence worth
	// naming: a developer with `QODER_CONFIG_DIR` set gets that tree, which is the
	// correct answer for their machine.
	if (id === "qoder") return qoderConfigDir(home);
	// Codewhale's tree moves for one reason — `$CODEWHALE_HOME` — and it is a
	// **whole-directory** override, unlike Qoder's `$QODER_CONFIG_DIR`. Two things
	// are reproduced here rather than left to a plain `join`, and both are the
	// product's own rules from `crates/paths/src/lib.rs`:
	//
	//   - an unusable override is *refused*, not used: a relative value raises
	//     `PathOverrideErrorKind::Relative` in the product, so falling back to
	//     `~/.codewhale` silently would import a tree Codewhale itself rejected
	//     (the same argument Qoder's branch makes);
	//   - `~/.deepseek` is a live second root, so the *detection* below needs both.
	//
	// `resolveCodewhaleHome` reads `process.env` through its defaulted parameter,
	// which is the same trade `qoderConfigDir` and `codexRoot` make.
	if (id === "codewhale") return resolveCodewhaleHome(home).root;
	// OpenClaw resolves **three** spellings and they disagree, so this is the
	// product's own precedence rather than a `join`: `$OPENCLAW_STATE_DIR` wins
	// outright, else `.openclaw` if it exists, else `.clawdbot`
	// (`src/config/state-dir.ts:21-43`), and `OPENCLAW_HOME` moves the whole
	// thing. `openclawStateDir` quotes all three; `process.env` is passed as an
	// argument rather than read inside that module, which is the same trade
	// `qoderConfigDir` makes above and for the same reason — a developer with the
	// variable set gets that tree, which is the correct answer for their machine.
	if (id === "openclaw") return openclawStateDir(home, process.env);
	// Alma's configuration root, which is the only one of its four that a report
	// points a user at for something they can edit. There is no environment
	// variable to honour — `alma-home.ts` records that Alma reads none anywhere in
	// its bundle — so this is a plain home-relative join and the branch exists
	// only to say so, in the one place a reader looks for the reason a source did
	// not fall through.
	if (id === "alma") return almaConfigDir(home);
	// Antigravity needs no branch, and the fallthrough being correct is itself the
	// interesting part: `~/.gemini` is a plain home-relative join, so this source is
	// the first whose *tree* is unambiguous while its *detection* is not. What it
	// is not is a tree only it uses — the Gemini CLI shares the parent — which is
	// why `detectionRoots` looks inside rather than here.
	return join(home, SOURCE_ROOTS[id]);
}

/**
 * Detect a source by what is in it, not by whether its directory exists.
 *
 * `~/.agents` (and `~/.claude`, `~/.codex`) are directories other tools create —
 * an empty one has nothing to import, and offering it is a question whose only
 * possible answer still costs the user a read and a keystroke. A root that is
 * present but unreadable counts as empty for the same reason: nothing can be
 * read from it either way.
 */
function sourceHasContent(root: string): boolean {
	try {
		return readdirSync(root).length > 0;
	} catch {
		return false;
	}
}

export function detectSources(home: string): MigrationSourceId[] {
	return MIGRATION_SOURCE_IDS.filter((id) => detectionRoots(id, home).some(sourceHasContent));
}

/**
 * The trees whose being non-empty means "this source is here".
 *
 * One for every source except OpenCode, which needs two. `core/src/global.ts:34-42`
 * creates the config root at import time, before the user has written a setting,
 * so on a stock install the config root exists and is *empty* — and
 * {@link sourceHasContent} counts an empty directory as absent, which is right for
 * a directory other tools create and wrong for this one. A user who has run
 * OpenCode, talked to it, and never touched a setting has settings to import from
 * nowhere and sessions to import from `<data>`; detection that looked only at the
 * config root would offer them a source with nothing in it and hide the one with
 * everything.
 *
 * The `OPENCODE_CONFIG_DIR` case is the sharp one: the override replaces
 * `Global.Path.config` (`core/src/global.ts:64`), so a user who sets it has a tree
 * at an arbitrary path that only comes into being when something is written there,
 * while every session sits in the untouched default data root.
 */
function detectionRoots(id: MigrationSourceId, home: string): string[] {
	if (id === "opencode") {
		const roots = opencodeRoots(home);
		return [roots.config, roots.data];
	}
	// The two IDE sources, and the same mistake avoided in both. A user who has
	// opened the editor and never run its CLI has no home-relative directory at
	// all, and a user who has run the CLI and never opened the editor has no
	// profile directory. Looking at one of each would call the source absent on
	// half the machines that have it — and the import would then find the other's
	// contents, which is the worse of the two failures: a source that was offered
	// as empty and then imported from anyway.
	if (id === "cursor") return cursorDetectionRoots(home);
	if (id === "trae") return traeDetectionRoots(home);
	// T3 Code is the same mistake a third time, and for the same reason as the two
	// above: the state directory an installed build writes and the one a dev build
	// writes are different directories under the same base, and which exist
	// depends on how the user launched T3. Reading only the production one would
	// call the source absent on every machine whose only T3 is a dev checkout —
	// and then find nothing to import, which is the more embarrassing half of
	// that failure rather than the safer one.
	if (id === "t3-code") return t3StateDirs(home);
	// **Antigravity is the first source whose home-relative root cannot be used for
	// detection at all.** `~/.gemini` is shared with the Gemini CLI, so a home that
	// has never run Antigravity can still have a busy `~/.gemini` — and offering
	// those users an Antigravity migration would be the same failure the two IDE
	// branches above avoid, except with nothing behind it: every one of those
	// entries is still a directory Antigravity itself writes.
	//
	// So detection looks at three directories Antigravity owns: both data roots
	// (the new one and the pre-split one, because which exists depends on whether
	// the user went through the IDE-split wizard), and `~/.gemini/config` — the
	// customization root the product's own guide names as its "Global Configuration
	// (Machine-Local)" location, holding `skills/`, `plugins/`, `mcp_config.json`
	// and `hooks.json`. A user with all three deleted but `config/` still populated
	// is real, and the reader handles it: `RawAntigravity.dataDir` is `null` there
	// and every conversation count is zero, which is a report with nothing in it
	// rather than a crash.
	//
	// What this cannot rule out: a home whose *only* `~/.gemini/config` content is
	// something that is not Antigravity's. That is why `config` is last and not
	// first — a home with any data root at all is detected by the first two.
	if (id === "antigravity") return [...antigravityDataDirs(home), antigravityConfigDir(home)];
	// **Qoder is the first source whose detection needs no special case, and that
	// is a fact rather than an omission.** `~/.qoder` is not shared with a foreign
	// tool the way `~/.gemini` is: the Qoder CLI writes its own state under the
	// same directory (`$QODER_CLI_HOME` defaults to the home and `.qoder` is
	// appended to it), so anything in there is Qoder's. A CLI-only home with skills
	// and memory but no `settings.json` is a real state and worth offering — it is
	// not a Gemini CLI home that happens to be busy.
	//
	// Two roots are checked anyway, and both are Qoder spellings: the resolved one
	// (`sourceRoot`, which honours the two environment overrides) and the
	// **China build's default**, because a `.qoder-cn` home is an install this
	// importer reads settings from under a different name. `QODER_CN_DEFAULT_DIR`
	// is a constant rather than a build-time lookup — the product picks its build
	// at start-up and a process cannot see both, so listing the two spellings is
	// what makes a machine holding either detectable.
	if (id === "qoder") return [sourceRoot(id, home), join(home, QODER_CN_DEFAULT_DIR)];
	// **Codewhale is the first source whose two roots are two *eras* rather than two
	// builds.** `~/.deepseek` is the pre-rename tree and the product still reads it
	// — `resolve_state_dir` (`crates/config/src/lib.rs:6158`) and
	// `default_user_state_path_from_environment`
	// (`crates/tui/src/config/paths.rs:240-263`) both fall back to it — so a home
	// that used Codewhale under its old name has its whole tree there and nothing
	// under `.codewhale`. Looking only at the canonical root would report those
	// users as having no Codewhale at all.
	//
	// The reverse is handled rather than assumed away: a user who has run Codewhale
	// since the rename has `~/.codewhale` and, for the paths that still fall back,
	// **also** a stale `~/.deepseek`. Both are therefore read, and the per-path
	// resolution in `codewhale-home.ts` decides which one answers — detection only
	// has to say the source is here at all.
	//
	// **`CODEWHALE_HOME` narrows this to one root**, and that is the product's own
	// rule rather than a choice here: an explicit home "is an isolation boundary:
	// state/config resolvers must not fall back to ambient legacy `~/.deepseek`
	// data outside that root" (`crates/config/src/lib.rs:6105-6111`). Falling back
	// from an isolated profile would read exactly the data the user isolated
	// themselves from.
	if (id === "codewhale") return codewhaleDefaultRoots(home);
	// **OpenClaw is the first source whose detection roots are three spellings of
	// one tree rather than distinct trees**, and all three are live because the
	// product's own resolver moves between them: `resolveStateDir` falls back to
	// the pre-rename `~/.clawdbot` when `.openclaw` is absent
	// (`src/config/state-dir.ts:33-43`), and a named profile puts the tree in
	// `~/.openclaw-<name>` (`src/cli/profile-utils.ts:35-37`).
	//
	// **A detector that looked only at `.openclaw` would report "no OpenClaw" for
	// every user who upgraded from the pre-rename build**, whose entire history
	// lives in `.clawdbot` — which is the failure `SOURCE_ROOTS`'s entry describes
	// and the reason that entry cannot be used for detection even though it is a
	// plain relative spelling.
	//
	// What this cannot rule out is a profile directory with no `OPENCLAW_PROFILE`
	// set now: a profile name is only discoverable from the variable, so a home
	// that ran `openclaw --profile work` once and never exported it has a
	// `~/.openclaw-work` this never looks at. Stated rather than papered over.
	if (id === "openclaw") return openclawStateRoots(home, process.env);
	// **Alma is the first source in this repository whose home is four *unrelated*
	// roots rather than four of anything else.** `detectionRoots` needs all four,
	// and the reason is not tidiness: each of the other three is the *only* one
	// that answers for some real user.
	//
	// `~/.config/alma` holds the identity documents, `mcp.json`, `hooks.json` and
	// the personal `skills/`. `%APPDATA%/alma` holds `chat_threads.db` — every
	// conversation — plus `plugin-storage/`, and a user who installed Alma and
	// never opened the settings has it and nothing else. `~/.alma` holds `bin/`,
	// an npm cache, screenshots and a cache directory, none of it importable, all
	// of it written by the CLI rather than the desktop app. And `~/alma` — **with
	// no leading dot**, a different directory from `~/.alma` — holds the browser
	// extension's stable copy and `worktrees/`.
	//
	// **The leading dot is the single most-missed path in the product.** A
	// detector that looked for `~/.alma` and `~/.config/alma` would report "no
	// Alma" for every user who has only ever run the CLI, and for every user who
	// runs the browser relay.
	//
	// The `userData` root is `null` on macOS and Linux, where this importer does
	// not guess at `~/Library/Application Support` or the XDG data base, and it is
	// simply absent from the list there. **A path this source names but did not
	// read is better than one it names wrongly**, and the report says which
	// platform it is on.
	if (id === "alma") return almaDetectionRoots(home, process.env);
	// **MiMo Code is the first source whose tree is four sibling directories rather
	// than one, and that is the whole reason this branch exists.**
	// `resolveMimocodeHome` (`packages/shared/src/global.ts:26-50`) answers four
	// bases — `xdgConfig`, `xdgData`, `xdgState`, `xdgCache`, each with `mimocode`
	// appended — or, under `$MIMOCODE_HOME`, `<root>/{config,data,state,cache}`.
	// Neither shape nests the others, so there is no single directory whose being
	// non-empty means "MiMo Code is here".
	//
	// **Two of the four would be wrong on their own and one is the sharp case.**
	// `config` gets a starter `mimocode.jsonc` written on first run
	// (`config/config.ts:656-662`), so it is non-empty early. `data` is where every
	// session and `auth.json` live and is frequently empty for a user who has run
	// the TUI without keeping a conversation. `state` and `cache` hold nothing this
	// importer reads. Looking at `config` alone would call the source absent on
	// exactly the machines whose history is the thing being migrated, so all four
	// are checked and the order puts the two that carry content first.
	if (id === "mimocode-code") {
		const roots = mimocodeRoots(home, process.env);
		return [roots.config, roots.data, roots.state, roots.cache];
	}
	return [sourceRoot(id, home)];
}

// ---------------------------------------------------------------------------
// Raw source data
// ---------------------------------------------------------------------------

/**
 * A file that travels with a {@link RawFile} rather than standing on its own: a
 * skill's `references/*.md`, `scripts/`, and so on.
 *
 * A skill is a directory, not a document. Copying only its `SKILL.md` leaves the
 * body pointing at files that are not there, so the supporting files are read
 * alongside it and written next to it.
 */
export interface RawAttachment {
	/** Path relative to the owning file's directory, e.g. `references/api.md`. */
	relativePath: string;
	content: string;
}

/** A skill, rule or agent file found in a source tree, carried as content. */
export interface RawFile {
	/** Name used to build the target path: skill directory name, or rule filename. */
	name: string;
	sourcePath: string;
	content: string;
	/** Overrides the report's "copied verbatim" note when the copy has a caveat. */
	detail?: string;
	/** Files belonging beside this one, written into the same target directory. */
	attachments?: RawAttachment[];
	/**
	 * Supporting files deliberately left behind, with the reason. Carried out of
	 * the reading phase because the report is written from the plan, and a file
	 * that neither travels nor is explained reads as an importer bug.
	 */
	attachmentSkips?: Array<{ relativePath: string; reason: string }>;
}

/**
 * Command files found under a source's commands directory, with the ones that
 * could not become a skill.
 *
 * Separate from {@link RawFile} because a command file is not carried as it
 * stands: its header is rewritten, and the reason a file was refused (a README,
 * a name too long to be a directory here) has to survive into the report.
 */
export interface RawCommands {
	files: RawFile[];
	skips: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * `map` — carried over as-is.
 * `downgrade` — carried over with a semantic loss, explained in `detail`.
 * `skip` — deliberately not carried over; `detail` says why.
 *
 * Skips are reported rather than dropped silently. A setting that vanishes
 * without explanation reads as a migration bug, and the user cannot tell the
 * difference between "labunbun has no equivalent" and "the importer missed it".
 */
export type MigrationAction = "map" | "downgrade" | "skip";

export interface MigrationItem {
	source: MigrationSourceId;
	/** Human-readable origin, e.g. "~/.claude/settings.json → env.ANTHROPIC_BASE_URL". */
	from: string;
	/** Human-readable destination, or "—" for skips. */
	to: string;
	action: MigrationAction;
	detail: string;
	/** Whether the migrated value is a credential, for the report's secrets notice. */
	containsSecret: boolean;
}

/** File writes the plan would perform, keyed by absolute target path. */
export interface PlannedWrite {
	path: string;
	kind: "settings" | "mcp" | "skill" | "rule" | "memory" | "agent" | "history" | "prompt-history";
	/** Full file content to write. */
	content: string;
	/** True when `content` embeds a credential. */
	containsSecret: boolean;
}

/**
 * What kind of thing is being carried over. The user chooses at this
 * granularity (`--only`, the wizard) because the three have very different
 * consequences: settings change behaviour, assets add files to the home
 * directory, history writes a transcript that resume will replay.
 */
export type MigrationCategory = "settings" | "assets" | "history";

export const MIGRATION_CATEGORIES: MigrationCategory[] = ["settings", "assets", "history"];

const KIND_CATEGORY: Record<PlannedWrite["kind"], MigrationCategory> = {
	settings: "settings",
	mcp: "settings",
	skill: "assets",
	rule: "assets",
	memory: "assets",
	agent: "assets",
	history: "history",
	"prompt-history": "history",
};

export function categoryOfKind(kind: PlannedWrite["kind"]): MigrationCategory {
	return KIND_CATEGORY[kind];
}

export interface MigrationPlan {
	home: string;
	sources: MigrationSourceId[];
	/** Categories this plan was allowed to touch. */
	categories: MigrationCategory[];
	items: MigrationItem[];
	writes: PlannedWrite[];
}

/**
 * Environment variables whose values are credentials rather than configuration.
 * Drives the report's closing notice about which written files hold secrets;
 * matched case-insensitively as a substring so `*_API_KEY` variants are covered.
 */
const SECRET_ENV_MARKERS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"];

export function looksLikeSecretName(name: string): boolean {
	const upper = name.toUpperCase();
	return SECRET_ENV_MARKERS.some((marker) => upper.includes(marker));
}

/**
 * Short model aliases → labunbun model references.
 *
 * Source tools accept a family alias where labunbun wants a `provider/id`
 * reference. Each target is verified against the registry during planning, so an
 * alias pointing at a model this build doesn't carry becomes a reported skip
 * rather than an unusable `model` value written into settings.
 */
const MODEL_ALIASES: Record<string, string> = {
	opus: "anthropic/claude-opus-5",
	sonnet: "anthropic/claude-sonnet-5",
	haiku: "anthropic/claude-haiku-4-5",
	fable: "anthropic/claude-fable-5-1",
};

/** Resolve a source `model` value to a reference labunbun can actually load. */
export function resolveModelReference(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const alias = MODEL_ALIASES[trimmed.toLowerCase()];
	const candidates = alias ? [alias, trimmed] : [trimmed];
	for (const candidate of candidates) {
		if (resolveModel(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Keys in the source state file that are telemetry or runtime bookkeeping.
 *
 * `projects` is deliberately not among them: each entry under it holds that
 * project's local-scope MCP servers (`services/mcp/config.ts` reads them for
 * scope `local`), and those are configuration. They are named one by one in
 * `planClaudeCode` — calling the whole map "not configuration" was a claim the
 * file itself contradicts.
 */
export const STATE_TELEMETRY_KEYS = new Set(["tipsHistory", "promptQueueUseCount", "cachedChangelog"]);

/**
 * Keys of `~/.claude/settings.json` that either get imported or get a note of
 * their own. Anything else is named by the closing aggregate item.
 */
export const CLAUDE_SETTINGS_HANDLED = new Set([
	"env",
	"model",
	"permissions",
	"sandbox",
	"hooks",
	"fallbackModel",
	"effortLevel",
	"enabledPlugins",
]);

/** Keys of `~/.claude.json` that are accounted for above; the rest is state. */
export const CLAUDE_STATE_HANDLED = new Set(["env", "model", "mcpServers", "projects", ...STATE_TELEMETRY_KEYS]);

export function targetSettingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

export function targetMcpPath(home: string): string {
	return join(home, ".labunbun", ".mcp.json");
}

/**
 * Claim one environment variable.
 *
 * `action` defaults to `map`, which is right whenever the source's variable and
 * the target's mean the same thing. A source that **scopes** its variables more
 * narrowly than the target does should pass `downgrade`: T3 Code injects a
 * provider instance's variables into that provider's process, while a target
 * `settings.env` reaches every tool call, so the value arrives unchanged and its
 * scope does not — and a report line that called that a faithful copy would be
 * the kind of imprecision that is only noticed once a shell has inherited an
 * endpoint meant for one model provider.
 */
export type ClaimEnv = (
	source: MigrationSourceId,
	name: string,
	value: string,
	from: string,
	action?: MigrationAction,
	detail?: string,
) => void;

/**
 * Settings keys a source may claim outright, and the value shapes they carry.
 * Widening this list is cheap; claiming a key that the merge cannot undo is not,
 * which is why permission rules take the accumulating path instead.
 */
export type ClaimableScalarKey =
	| "model"
	| "theme"
	| "permissionMode"
	| "sandbox"
	| "fallbackModels"
	| "disableBypassPermissionsMode";

export type ClaimedScalarValue = string | string[] | boolean;

/** One entry of the target's hook config. */
export interface NormalizedHookEntry {
	matcher?: string;
	hooks: Array<{ type: "command"; command: string; timeout?: number }>;
}

/** What survived hook normalization, and what did not. */
export interface NormalizedHooks {
	/** Event name → entries that will run. Events with nothing runnable are absent. */
	config: Record<string, NormalizedHookEntry[]>;
	/** Source event names this build has no event for; hooks under them never fire. */
	droppedEvents: string[];
	/** Handlers dropped because their `type` is not a shell command (e.g. `prompt`). */
	droppedHandlers: number;
	/** Matchers dropped because this build would escape their pattern characters. */
	droppedMatchers: string[];
	/** Alternation matchers (`A|B`) split into one entry per name. */
	splitMatchers: string[];
	/** Handlers that carried no usable command, or entries that were not objects. */
	malformed: number;
	/** Handlers whose timeout came across, converted from the source's seconds. */
	convertedTimeouts: number;
	/** Of those, how many asked for longer than this build waits and were clamped. */
	clampedTimeouts: number;
	/** Handlers that name no timeout, so the target's own default applies. */
	untimedHandlers: number;
}

export type AddPermissionRules = (
	source: MigrationSourceId,
	behavior: "allow" | "deny",
	rules: string[],
	from: string,
	caveat: string,
) => void;

export type ClaimPermissionList = (
	source: MigrationSourceId,
	behavior: "allow" | "deny" | "additionalDirectories",
	rules: string[],
	from: string,
	detail: string,
	/**
	 * How the report should score the claim. `map` when the rules arrive intact,
	 * `downgrade` when the source's form had to be rewritten on the way — a
	 * permission list that arrived in another shape is not a faithful copy, and
	 * the tally is where a user notices.
	 */
	action?: MigrationAction,
) => void;

export type ClaimScalar = (
	source: MigrationSourceId,
	key: ClaimableScalarKey,
	value: ClaimedScalarValue,
	from: string,
	detail: string,
) => void;

/**
 * Claim a mode and a sandbox together, as the one decision they are.
 *
 * Every foreign tool's notion of "how much do you ask me" is a single value, and
 * in this repo the closest equivalent is often a *pair*: `bypassPermissions`
 * meant never-ask and unconfined, and `yolo` means the same. Calling
 * `claimScalar` twice by hand in each of eight mappers is how one of them ends
 * up writing the mode and forgetting the sandbox — a session that auto-approves
 * everything and still enforces a workspace sandbox is a combination the user
 * never chose, and nothing in the report would say so.
 *
 * So this is the only way a mode is written. Both halves are claimed even when
 * the source named only one, because "the source had no opinion about the
 * sandbox" is not the same claim as "import nothing" — the alternative is a
 * half-written pair that reads as a deliberate setting.
 */
export type ClaimModePair = (
	source: MigrationSourceId,
	mode: PermissionMode,
	sandbox: SandboxMode,
	from: string,
	detail: string,
) => void;

/**
 * One source's share of the target's hook config, claimed rather than written.
 *
 * Two sources can each hold hooks — a `Stop` hook from one and a `PreToolUse`
 * from the other is one configuration, not two competing ones — so entries are
 * unioned per event and the key is written once at the end. Writing straight
 * into the patch would let the last source reached erase the first while both
 * report lines saying their hooks were written.
 */
export type ClaimHooks = (
	source: MigrationSourceId,
	config: Record<string, NormalizedHookEntry[]>,
	from: string,
	detail: string,
	/** `downgrade` when something of the source's hook block did not come across. */
	action?: MigrationAction,
) => void;
