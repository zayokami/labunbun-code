/**
 * The "!" prompt prefix: run a shell command directly, without the model.
 *
 * The user typed the command themselves, so it skips permission *approval* —
 * asking "may I run what you just typed" would be theater. What it does not
 * skip is the policy: `interactive.ts` calls `evaluatePermissions` before
 * calling down here, so a deny rule still refuses the command, and this module
 * builds the same `SandboxPolicy` the Bash tool builds and hands it to the
 * executor. The verdicts that would need a person — an ask rule, the classifier
 * in a mode that asks — are the half the typing itself answers: the person and
 * the author of the command are the same one.
 *
 * Output streams into the transcript through the same toolUse entry shape the
 * agent's Bash tool uses, so rendering, transcript mode, and truncation all
 * come for free.
 *
 * It shares one Operations instance with the Bash tool (wired in interactive.ts)
 * so shell resolution and process-tree kill behavior are identical on both
 * paths.
 */

import type { NetworkAxis, SandboxMode } from "@labunbun/agent";
import { type Operations, resolveWritableRoots, workspacePolicy } from "@labunbun/tools";
import { RESULT_TEXT_CAP, type Store, type UiEntry, type UiState } from "@labunbun/tui";

export interface ShellPassthrough {
	run(command: string, store: Store<UiState>): Promise<void>;
}

export function createShellPassthrough(opts: {
	cwd: string;
	ops: Operations;
	/**
	 * The live sandbox and network axes, as getters for the same reason the Bash
	 * tool reads them per call: `/mode` can move either mid-session, and a value
	 * captured at construction would keep applying the old one to a command the
	 * user runs after the change.
	 */
	sandbox: () => SandboxMode;
	network: () => NetworkAxis;
	/**
	 * The root inputs the Bash tool is built with in `interactive.ts` (`home` and
	 * `permissions.additionalDirectories`), so both paths resolve the same
	 * writable roots. Absent means the resolver's own fallback — the temp
	 * directory and no per-user caches.
	 */
	home?: string;
	writableRoots?: readonly string[];
}): ShellPassthrough {
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

			// Built per run, from the same resolver the Bash tool uses: identical
			// inputs, identical answer. Skipping it — which is what this path did
			// while the prefix meant "no permission *and no sandbox*" — let a typed
			// command write outside the workspace axis the session was showing.
			const policy = await workspacePolicy(opts.cwd, {
				sandbox: opts.sandbox(),
				network: opts.network(),
				writableRoots: resolveWritableRoots({ home: opts.home, configured: opts.writableRoots }),
			});

			// Live tail: keep the entry's resultText pinned to the newest output so
			// a chatty command cannot grow the frame without bound while running.
			let tail = "";
			const result = await opts.ops.exec({
				command,
				cwd: opts.cwd,
				sandbox: policy,
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
