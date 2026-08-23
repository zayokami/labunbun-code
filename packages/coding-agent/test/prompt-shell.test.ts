/**
 * The @-mention file completer and the "!" shell passthrough, against a real
 * temp project tree and fake exec respectively. The passthrough is asserted
 * through the store entries it writes — the same data the renderer consumes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Operations } from "@labunbun/tools";
import { createStore, initialUiState } from "@labunbun/tui";
import { createFileCompleter } from "../src/file-completions.ts";
import { createShellPassthrough } from "../src/shell-passthrough.ts";

let root: string;

beforeAll(() => {
	root = join(tmpdir(), `lbb-files-${Date.now().toString(36)}`);
	mkdirSync(join(root, "src", "nested"), { recursive: true });
	writeFileSync(join(root, "src", "alpha.ts"), "export {};\n");
	writeFileSync(join(root, "src", "nested", "beta.ts"), "export {};\n");
	// node_modules must be invisible to the walker.
	mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
	writeFileSync(join(root, "node_modules", "pkg", "index.js"), "{}\n");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("createFileCompleter", () => {
	test("lists project files as relative forward-slash paths, skipping vendored dirs", async () => {
		const completer = createFileCompleter(root);
		const files = await completer("");
		expect(files).toContain("src/alpha.ts");
		expect(files).toContain(join("src", "nested", "beta.ts").split("\\").join("/"));
		expect(files.some((f) => f.includes("node_modules"))).toBe(false);
	});

	test("caches within the TTL and busts on demand", async () => {
		const completer = createFileCompleter(root, { ttlMs: 60_000 });
		await completer("");
		writeFileSync(join(root, "fresh.txt"), "new\n");
		// Within the TTL the new file is not visible yet...
		expect(await completer("")).not.toContain("fresh.txt");
		completer.bust();
		// ...and a busted cache re-walks.
		expect(await completer("")).toContain("fresh.txt");
	});

	test("mtime order puts newer files first", async () => {
		const completer = createFileCompleter(root, { ttlMs: 0 });
		const now = new Date();
		utimesSync(join(root, "src", "nested", "beta.ts"), now, now);
		const files = await completer("");
		expect(files.indexOf("src/nested/beta.ts")).toBeLessThan(files.indexOf("src/alpha.ts"));
	});
});

function scriptOps(script: Array<{ out?: string; code?: number; killed?: boolean }>): {
	ops: Operations;
	calls: string[];
} {
	let at = 0;
	const calls: string[] = [];
	// Only exec is implemented — the passthrough touches nothing else.
	const execOnly: Pick<Operations, "exec"> = {
		exec: async (options) => {
			calls.push(options.command);
			const step = script[Math.min(at, script.length - 1)];
			at++;
			options.onOutput?.(step.out ?? "");
			return { stdout: "", stderr: "", exitCode: step.code ?? 0, killed: step.killed ?? false };
		},
	};
	return { calls, ops: { ...emptyFs(), ...execOnly } as Operations };
}

/** Fill the filesystem half of Operations with throwing stubs. */
function emptyFs(): Operations {
	const fail = () => {
		throw new Error("not implemented in this test");
	};
	return {
		readTextFile: fail,
		writeTextFile: fail,
		writeTextFileAtomic: fail,
		exists: fail,
		stat: fail,
		readdir: fail,
		mkdir: fail,
		deleteFile: fail,
		move: fail,
		exec: fail,
	} as unknown as Operations;
}

describe("createShellPassthrough", () => {
	test("streams output into a user entry plus a toolUse entry with exit code", async () => {
		const { ops } = scriptOps([{ out: "file one\nfile two\n" }]);
		const passthrough = createShellPassthrough({ cwd: root, ops });
		const store = createStore(initialUiState());

		await passthrough.run("ls -la", store);

		const entries = store.get().entries;
		expect(entries[0]).toEqual({ kind: "user", text: "! ls -la" });
		const tool = entries[1];
		if (tool.kind !== "toolUse") throw new Error(`expected toolUse, got ${tool.kind}`);
		expect(tool.toolName).toBe("Bash");
		expect(tool.inputPreview).toBe("ls -la");
		expect(tool.isError).toBe(false);
		expect(tool.resultText).toContain("file two");
		expect(tool.resultText?.endsWith("[exit code: 0]")).toBe(true);
	});

	test("a non-zero exit marks the entry as an error", async () => {
		const { ops } = scriptOps([{ out: "not found\n", code: 127 }]);
		const passthrough = createShellPassthrough({ cwd: root, ops });
		const store = createStore(initialUiState());
		await passthrough.run("nope", store);

		const tool = store.get().entries[1];
		if (tool.kind !== "toolUse") throw new Error("expected toolUse");
		expect(tool.isError).toBe(true);
		expect(tool.resultText).toContain("[exit code: 127]");
	});

	test("a bare ! prints usage instead of executing anything", async () => {
		const { ops, calls } = scriptOps([]);
		const passthrough = createShellPassthrough({ cwd: root, ops });
		const store = createStore(initialUiState());
		await passthrough.run("", store);

		expect(calls).toEqual([]);
		expect(store.get().entries[0]).toEqual({ kind: "info", text: "Usage: ! <command>" });
	});
});
