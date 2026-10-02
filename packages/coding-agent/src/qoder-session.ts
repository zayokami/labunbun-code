/**
 * Qoder's conversation history: the count of it, and nothing else.
 *
 * **This is a deferral, and the file exists so the deferral is visible.**
 * Every other source in this repository has a `*-session.ts` that can list
 * candidates and read chosen sessions into the target's history. This one cannot,
 * and the reason is a specific piece of evidence rather than a budget:
 *
 *   - **The path is settled.** `vze` is one function and one line:
 *     `join(t.configDirectory, "projects", Bfe(t.cwd), \`${t.targetSessionId}.jsonl\`)`
 *     — a project directory per working directory, one `.jsonl` per session, and
 *     a slug this repository reproduces exactly (see `qoderProjectSlug`, and the
 *     `u`-flag discrepancy recorded there).
 *   - **The record format is not.** The file's writer is the native
 *     `qoder-runtime-host` binary. It is not in `out/main/index.js`, not in
 *     `node_modules/@qoder-ai/qoder-agent-sdk/dist/index.js`, and not in
 *     `protocol/index.js` — those three are the whole of the JavaScript Qoder
 *     ships, and none of them writes a transcript line. A `.jsonl` reader built
 *     from a guess at the record shape would produce histories that look right and
 *     are not, and a wrong history is worse than an absent one: a user reading
 *     back their own conversation would have no way to tell.
 *
 * So this module returns an explicit empty listing with a reason, and the reason
 * is the thing the report carries. **A report that says "3 sessions left behind"
 * is worth writing** — it is the difference between a user who expected their
 * history to come across and being told, and a user who never had any. Silence
 * would be indistinguishable from a Qoder with nothing to say.
 *
 * **The desktop's SQLite store is the same deferral for the same reason, one
 * level up.** `mcp_oauth_credentials` and `byok_model_credentials` hold encrypted
 * blobs and are never opened; `chat_sessions`, `chat_session_messages` and
 * `chat_session_recaps` hold the conversations and are counted by name only. See
 * `qoder-home.ts` for the paths and the table names.
 *
 * Both are a separate batch, and building them means establishing — from the
 * binary's bytes or from a captured sample the user consents to provide — the
 * record shape, the sequence numbering, and whether the store is opened in WAL
 * mode while the app is writing to it. That is a piece of work on its own, and
 * this file is the place it plugs in.
 */

import type { HistoryCandidate, HistoryNote } from "./migrate-history.ts";
import type { QoderEnv } from "./qoder-home.ts";
import { qoderConfigDir } from "./qoder-home.ts";
import { countQoderSessions } from "./qoder-read.ts";

/**
 * The reason a Qoder listing is empty, in one sentence a report can print.
 *
 * Stated as a constant rather than built at the call site so there is exactly one
 * place where this claim is written down, and so a test can assert the *text* —
 * a deferral whose reason drifts is a deferral nobody can check.
 */
export const QODER_HISTORY_NOT_IMPORTED =
	"Qoder's transcripts are at ~/.qoder/projects/<slug>/<sessionId>.jsonl, one project directory per working directory and one .jsonl per session — the layout is the product's own. What is inside them is not established: the file's writer is the native qoder-runtime-host binary, which is in none of the three JavaScript bundles Qoder ships, so no record format could be read from any of them. This import copies none of them and wrote nothing under the projects directory — the conversations are where Qoder put them. The desktop application's own store is %APPDATA%/com.qoder.app.stable/main.sqlite, and was likewise not opened.";

/**
 * List Qoder sessions: none, with the reason attached and the number of
 * transcripts left behind counted.
 *
 * The signature is the one `migrate-history.ts` calls for every source, and
 * `home` and `env` are the same two arguments the reader takes — a function that
 * ignored them would be a lie in a different direction, so they are what resolve
 * the configuration directory the count is taken over.
 */
export function listQoderHistory(
	home: string,
	env: QoderEnv = process.env,
): { candidates: HistoryCandidate[]; notes: HistoryNote[] } {
	// Counting is the whole of what this does, and the count is real rather than a
	// standing zero: the report prints it as "<reason> — N not imported", and "7"
	// against that reason is the difference between a user who expected their
	// history to come across and being told, and a user who never had any. Only
	// directory entries are read — `countQoderSessions` names files to count them
	// and never opens one.
	const { sessions } = countQoderSessions(qoderConfigDir(home, env), []);
	return {
		candidates: [],
		notes: [{ reason: QODER_HISTORY_NOT_IMPORTED, count: sessions }],
	};
}
