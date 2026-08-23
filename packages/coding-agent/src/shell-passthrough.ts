/**
 * The "!" prompt prefix: run a shell command directly, without the model.
 *
 * The user typed the command themselves, so it bypasses permission approval —
 * asking "may I run what you just typed" would be theater. Output streams into
 * the transcript through the same toolUse entry shape the agent's Bash tool
 * uses, so rendering, transcript mode, and truncation all come for free.
 *
 * It shares one Operations instance with the Bash tool (wired in interactive.ts)
 * so shell resolution and process-tree kill behavior are identical on both
 * paths.
 */

import type { Operations } from "@labunbun/tools";
import { RESULT_TEXT_CAP, type Store, type UiEntry, type UiState } from "@labunbun/tui";

export interface ShellPassthrough {
	run(command: string, store: Store<UiState>): Promise<void>;
}

export function createShellPassthrough(opts: { cwd: string; ops: Operations }): ShellPassthrough {
	let seq = 0;

	const patchEntry = (store: Store<UiState>, callId: string, patch: Partial<Extract<UiEntry, { kind: "toolUse" }>>) => {
		store.set((s) => ({
			...s,
			entries: s.entries.map((e) => (e.kind === "toolUse" && e.callId === callId ? { ...e, ...patch } : e)),
		}));
	};

	return {
		async run(command, store) {
			if (!command) {
				store.set((s) => ({ ...s, entries: [...s.entries, { kind: "info", text: "Usage: ! <command>" }] }));
				return;
			}
			seq += 1;
			const callId = `shell-${seq}`;
			store.set((s) => ({
				...s,
				entries: [
					...s.entries,
					{ kind: "user", text: `! ${command}` },
					{ kind: "toolUse", callId, toolName: "Bash", inputPreview: command },
				],
			}));

			// Live tail: keep the entry's resultText pinned to the newest output so
			// a chatty command cannot grow the frame without bound while running.
			let tail = "";
			const result = await opts.ops.exec({
				command,
				cwd: opts.cwd,
				onOutput: (chunk) => {
					tail = (tail + chunk).slice(-RESULT_TEXT_CAP);
					patchEntry(store, callId, { resultText: tail });
				},
			});

			const text =
				`${tail}${tail && !tail.endsWith("\n") ? "\n" : ""}[exit code: ${result.exitCode}]` +
				(result.killed ? " [timed out or killed]" : "");
			patchEntry(store, callId, { resultText: text.slice(0, RESULT_TEXT_CAP), isError: result.exitCode !== 0 });
		},
	};
}
