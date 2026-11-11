/**
 * Ending a process tree on Windows.
 *
 * `taskkill /T /F` is the only tree kill the platform has, and each caller
 * hears its outcome differently: the background manager reads the exit code as
 * the confirmation of a stop, the exec path fires and forgets, and the confined
 * runner is synchronous over a blocked event loop and cannot receive a `close`
 * at all. Only the invocation is shared — a caller's fallback stays its own,
 * because a taskkill that never started means something different to each.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

/** The argv every tree kill uses: the pid, its descendants, and force. */
export function taskkillTreeArgs(pid: number): string[] {
	return ["/pid", String(pid), "/T", "/F"];
}

export interface KillProcessTreeOptions {
	/** Injection point for tests; defaults to `node:child_process.spawn`. */
	spawnImpl?: typeof spawn;
	/**
	 * Runs when taskkill could not be started at all — not on PATH, spawn
	 * failure — so a caller with a direct-signal fallback keeps it. Its answer
	 * becomes the result; no answer is a kill that did not happen.
	 */
	onMissing?: (pid: number) => boolean | undefined;
}

/**
 * Kill `pid` and every process below it, and report whether taskkill confirmed
 * it: true only for exit code 0. A taskkill that ran and failed — not found,
 * access denied — is false, so no caller reports a stop that did not happen.
 */
export function killProcessTree(pid: number, options: KillProcessTreeOptions = {}): Promise<boolean> {
	const spawnImpl = options.spawnImpl ?? spawn;
	return new Promise<boolean>((resolve) => {
		let killer: ChildProcess;
		try {
			killer = spawnImpl("taskkill", taskkillTreeArgs(pid), { windowsHide: true });
		} catch {
			// `spawn` normally reports a missing binary as an `error` event, but a
			// throw is the same fact and must not escape into the caller.
			resolve(options.onMissing?.(pid) ?? false);
			return;
		}
		killer.on("error", () => resolve(options.onMissing?.(pid) ?? false));
		killer.on("close", (code) => resolve(code === 0));
	});
}

export interface KillProcessTreeSyncOptions {
	/** Injection point for tests; defaults to `node:child_process.spawnSync`. */
	spawnSyncImpl?: typeof spawnSync;
}

/**
 * The synchronous twin, for the confined runner: its wait is FFI polling on a
 * blocked event loop, so it can neither await a promise nor receive a `close`.
 * A missing taskkill is false and leaves the caller's own backstop — the direct
 * process handle — to act.
 */
export function killProcessTreeSync(pid: number, options: KillProcessTreeSyncOptions = {}): boolean {
	const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
	try {
		const result = spawnSyncImpl("taskkill", taskkillTreeArgs(pid), { windowsHide: true });
		// A missing taskkill comes back as `error` with a null status, not as a
		// thrown call: both spellings are a kill that did not happen.
		return result.error === undefined && result.status === 0;
	} catch {
		return false;
	}
}
