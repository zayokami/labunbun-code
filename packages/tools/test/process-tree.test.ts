/**
 * The one place a Windows tree kill is invoked.
 *
 * The spawning is faked on every platform: what these rows pin is the argv
 * every caller must issue, the exit code as the only confirmation, and the
 * fallback each caller keeps when taskkill itself cannot be started. Whether
 * a real taskkill ends a real tree is `web-background.test.ts`'s and
 * `appcontainer.test.ts`'s judgement.
 */
import { describe, expect, test } from "bun:test";
import type { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { killProcessTree, killProcessTreeSync, taskkillTreeArgs } from "../src/process-tree.ts";

interface Invocation {
	command: string;
	args: readonly string[];
	options: unknown;
}

/** A ChildProcess stand-in: the helper only listens to it. */
function fakeChild(): EventEmitter {
	return new EventEmitter();
}

/** A spawn that records its call and hands back `child`. */
function recordingSpawn(child: EventEmitter, calls: Invocation[]): typeof spawn {
	return ((command: string, args: readonly string[], options: unknown) => {
		calls.push({ command, args, options });
		return child;
	}) as unknown as typeof spawn;
}

/** A spawnSync that records its call and answers with `result`. */
function recordingSpawnSync(result: unknown, calls: Invocation[]): typeof spawnSync {
	return ((command: string, args: readonly string[], options: unknown) => {
		calls.push({ command, args, options });
		return result;
	}) as unknown as typeof spawnSync;
}

describe("the taskkill invocation", () => {
	test("names the pid, its descendants, and force", () => {
		expect(taskkillTreeArgs(4242)).toEqual(["/pid", "4242", "/T", "/F"]);
	});

	test("the async wrapper spawns that argv without a window", async () => {
		const calls: Invocation[] = [];
		const child = fakeChild();
		const pending = killProcessTree(4242, { spawnImpl: recordingSpawn(child, calls) });
		child.emit("close", 0);
		expect(await pending).toBe(true);
		expect(calls).toEqual([
			{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"], options: { windowsHide: true } },
		]);
	});

	test("exit 0 is a kill; a non-zero exit is a taskkill that did not happen", async () => {
		const zero = fakeChild();
		const confirmed = killProcessTree(1, { spawnImpl: recordingSpawn(zero, []) });
		zero.emit("close", 0);
		expect(await confirmed).toBe(true);

		const nonZero = fakeChild();
		const failed = killProcessTree(1, { spawnImpl: recordingSpawn(nonZero, []) });
		nonZero.emit("close", 128);
		expect(await failed).toBe(false);
	});
});

describe("a taskkill that cannot be started", () => {
	test("the async wrapper runs the caller's fallback and keeps its answer", async () => {
		const child = fakeChild();
		const fallbackPids: number[] = [];
		const pending = killProcessTree(4242, {
			spawnImpl: recordingSpawn(child, []),
			onMissing: (pid) => {
				fallbackPids.push(pid);
				return true;
			},
		});
		child.emit("error", new Error("spawn taskkill ENOENT"));
		expect(await pending).toBe(true);
		expect(fallbackPids).toEqual([4242]);
	});

	test("a fallback that could not kill is false — an attempt is not a kill", async () => {
		const child = fakeChild();
		const pending = killProcessTree(4242, {
			spawnImpl: recordingSpawn(child, []),
			onMissing: () => false,
		});
		child.emit("error", new Error("spawn taskkill ENOENT"));
		expect(await pending).toBe(false);
	});

	test("no fallback means a missing taskkill is a kill that did not happen", async () => {
		const child = fakeChild();
		const pending = killProcessTree(4242, { spawnImpl: recordingSpawn(child, []) });
		child.emit("error", new Error("spawn taskkill ENOENT"));
		expect(await pending).toBe(false);
	});

	test("a spawn that throws takes the same fallback instead of escaping", async () => {
		const spawnImpl = (() => {
			throw new Error("spawn refused");
		}) as unknown as typeof spawn;
		expect(await killProcessTree(4242, { spawnImpl })).toBe(false);
		expect(await killProcessTree(4242, { spawnImpl, onMissing: () => true })).toBe(true);
	});
});

describe("the synchronous tree kill", () => {
	test("spawns the same argv and answers with the exit code", () => {
		const calls: Invocation[] = [];
		expect(killProcessTreeSync(4242, { spawnSyncImpl: recordingSpawnSync({ status: 0 }, calls) })).toBe(true);
		expect(calls).toEqual([
			{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"], options: { windowsHide: true } },
		]);
		expect(killProcessTreeSync(4242, { spawnSyncImpl: recordingSpawnSync({ status: 1 }, []) })).toBe(false);
	});

	test("a taskkill that could not start is false — the caller's handle is the backstop", () => {
		const missing = { error: new Error("spawn taskkill ENOENT"), status: null };
		expect(killProcessTreeSync(4242, { spawnSyncImpl: recordingSpawnSync(missing, []) })).toBe(false);
		const throwing = (() => {
			throw new Error("spawn refused");
		}) as unknown as typeof spawnSync;
		expect(killProcessTreeSync(4242, { spawnSyncImpl: throwing })).toBe(false);
	});
});
