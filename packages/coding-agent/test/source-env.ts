/**
 * The environment a fake home has to be insulated from.
 *
 * `readSources` reads *every* migration source whatever the test is about, and
 * every source can be relocated by an environment variable. So a test that
 * points `HOME`/`USERPROFILE` at a temp directory has not thereby made itself
 * hermetic: one unset-by-accident variable is enough for a developer's real
 * install to walk into a plan, and the failure looks like a wrong assertion
 * rather than like a leak.
 *
 * This is not hypothetical. Adding the `cursor` and `trae` sources made
 * `readSources` read `APPDATA` — always set on Windows, always holding a live
 * `Cursor\User` or `Trae\User` — and "a home with no source in it is no source"
 * started failing on the machine that has Cursor and Trae installed, over 24
 * state databases. It took thirteen files to find all the affected ones by
 * running them.
 *
 * So the list lives here rather than in each file, and `MIGRATION_ENV_VARS`
 * covers every variable a source reads by name: a variable read by any
 * `*-home.ts` or `*-read.ts` module, plus the three `XDG_*_HOME` bases. Adding a
 * source that reads a new variable means adding one line here — and
 * `source-env-coverage.test.ts` is what tells you that you forgot, because the
 * list used to be maintained by hand with nothing checking it, and the variable
 * it missed (`CURSOR_DATA_DIR`) leaked a developer's real Cursor tree into
 * every test in a file that was not about Cursor's data root.
 */

/**
 * Variables a source reads that are deliberately **not** in the list below, and
 * why.
 *
 * Exempt rather than absent. The coverage test in `source-env-coverage.test.ts`
 * reads this, so the exemption is a fact the test can see and a reader can check
 * — the alternative is a list that is quietly short of the sources it claims to
 * cover, which is the exact state this file was in when `CURSOR_DATA_DIR` was
 * added to a source and not to the list.
 */
export const MIGRATION_ENV_VARS_EXEMPT: Readonly<Record<string, string>> = {
	HOME: "a test that wants a fake home sets this itself, and borrowing it would undo that",
	USERPROFILE: "the Windows spelling of the same, and the same reason",
};

/**
 * Every variable a source root can be relocated by. `USERPROFILE` and `HOME`
 * are absent on purpose — see {@link MIGRATION_ENV_VARS_EXEMPT} for why, which is
 * the same reason but in a place a test can read.
 *
 * **The list is hand-maintained, not derived.** `source-env-coverage.test.ts`
 * checks it against the sources; that test is what keeps this comment honest.
 */
export const MIGRATION_ENV_VARS: readonly string[] = [
	"APPDATA",
	"CODEX_HOME",
	"CURSOR_CONFIG_DIR",
	"CURSOR_DATA_DIR",
	"DSH_HOME",
	"GROK_HOME",
	"KIMI_CODE_HOME",
	"KIMI_SHARE_DIR",
	"MAVIS_DATA_DIR",
	"MINIMAX_DATA_DIR",
	"OPENCODE_CONFIG_DIR",
	"OPENCODE_DB",
	"STEP_CODING_AGENT_DIR",
	"STEP_CODING_AGENT_SESSION_DIR",
	"STEPCODE_CONFIG_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"T3CODE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"ZCODE_DATA_BASE_DIR",
	"ZCODE_SESSION_DB",
	"ZCODE_SESSION_DB_PATH",
	"ZCODE_STORAGE_DIR",
];

/**
 * Every name borrowed since the last release, and the value it had. One
 * registry, so a test that borrows the whole list and a test that sets a single
 * variable cannot each remember a different "original" for the same name — the
 * second one to ask would see the first one's cleared value and put back
 * nothing.
 */
const borrowed = new Map<string, string | undefined>();

/**
 * Remember what `name` holds right now, once, so that whoever releases last
 * puts back the value the process started with.
 */
export function rememberEnv(name: string): void {
	if (borrowed.has(name)) return;
	borrowed.set(name, process.env[name]);
}

/**
 * Clear the source-relocating variables for the duration of a test, and hand
 * back the function that puts them back.
 *
 * A test that wants one of these variables says so itself, after this call, and
 * either restores it before calling the returned function or calls
 * `rememberEnv` on the name first — the point is that the value the process
 * started with is what comes back, whichever order the two happen in.
 *
 * ```ts
 * const release = borrowSourceEnv();
 * try {
 *   // ...
 * } finally {
 *   release();
 * }
 * ```
 */
export function borrowSourceEnv(also: readonly string[] = []): () => void {
	for (const name of [...MIGRATION_ENV_VARS, ...also]) {
		rememberEnv(name);
		delete process.env[name];
	}
	return releaseEnv;
}

/**
 * Put every borrowed name back. Safe to call with nothing borrowed, and safe to
 * call twice — the registry empties itself, so a `finally` and an `afterEach`
 * that both release cannot double-restore.
 */
export function releaseEnv(): void {
	for (const [name, value] of borrowed) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	borrowed.clear();
}
