/**
 * Concurrent permission dialogs.
 *
 * A turn runs its concurrency-safe tools in parallel, so several can ask for
 * approval at once — but only one dialog fits on screen. The failure this
 * guards against is quiet and total: a second request overwriting the first
 * left that tool's promise pending forever, and since the batch awaits every
 * call in it, the turn simply stopped, with no dialog to answer and no way to
 * tell why.
 */
import { describe, expect, test } from "bun:test";
import { createPermissionQueue } from "../src/permission-queue.ts";
import type { PermissionDialogState } from "../src/ui-state.ts";

function harness(cwd?: string) {
	const shown: Array<PermissionDialogState | null> = [];
	const alwaysAllowed: Array<[string, unknown]> = [];
	const queue = createPermissionQueue({
		show: (dialog) => shown.push(dialog),
		preview: (toolName, input) => `${toolName}: ${JSON.stringify(input)}`,
		fullPreview: (toolName, input) => `${toolName} full:\n${JSON.stringify(input, null, 2)}`,
		cwd,
		onAlwaysAllow: (toolName, input) => alwaysAllowed.push([toolName, input]),
	});
	return {
		queue,
		alwaysAllowed,
		/** The dialog currently on screen. */
		current: () => shown[shown.length - 1],
		screens: () => shown.length,
	};
}

describe("permission queue", () => {
	test("shows a lone request and clears the dialog once it is answered", async () => {
		const { queue, current } = harness();
		const answer = queue.request("Write", { file_path: "/tmp/a.txt" });

		expect(current()?.toolName).toBe("Write");
		expect(current()?.inputPreview).toBe('Write: {"file_path":"/tmp/a.txt"}');
		expect(current()?.queueLength).toBe(1);

		current()?.resolve(true, false);
		expect(await answer).toBe(true);
		expect(current()).toBeNull();
	});

	// The regression: the second request used to replace the first in the store,
	// so the first promise could never be resolved by anyone.
	test("queues a concurrent request instead of replacing the one on screen", async () => {
		const { queue, current } = harness();
		const first = queue.request("Write", { file_path: "a" });
		const second = queue.request("Bash", { command: "rm -rf build" });

		expect(current()?.toolName).toBe("Write");
		expect(current()?.queueLength).toBe(2);

		current()?.resolve(true, false);
		expect(await first).toBe(true);
		expect(current()?.toolName).toBe("Bash");
		expect(current()?.queueLength).toBe(1);

		current()?.resolve(false, false);
		expect(await second).toBe(false);
		expect(current()).toBeNull();
	});

	test("answers a burst in arrival order", async () => {
		const { queue, current } = harness();
		const answers = [
			queue.request("Read", { file_path: "1" }),
			queue.request("Read", { file_path: "2" }),
			queue.request("Read", { file_path: "3" }),
		];

		expect(current()?.inputPreview).toContain('"1"');
		current()?.resolve(true, false);
		expect(current()?.inputPreview).toContain('"2"');
		current()?.resolve(false, false);
		expect(current()?.inputPreview).toContain('"3"');
		current()?.resolve(true, false);

		expect(await Promise.all(answers)).toEqual([true, false, true]);
		expect(current()).toBeNull();
	});

	test("a denial resolves only the request it answered", async () => {
		const { queue, current } = harness();
		const denied = queue.request("Write", { file_path: "a" });
		const stillWaiting = queue.request("Write", { file_path: "b" });

		current()?.resolve(false, false);
		expect(await denied).toBe(false);
		expect(current()?.inputPreview).toContain('"b"');

		current()?.resolve(true, false);
		expect(await stillWaiting).toBe(true);
	});

	// "Don't ask again for this tool" is a statement about the tool, and the
	// requests already queued are for that same tool — re-asking would read as
	// the option having been ignored.
	test("always-allow also answers what is already queued for that tool", async () => {
		const { queue, alwaysAllowed, current } = harness();
		const first = queue.request("Write", { file_path: "a" });
		const sameTool = queue.request("Write", { file_path: "b" });
		const other = queue.request("Bash", { command: "ls" });

		current()?.resolve(true, true);

		expect(await first).toBe(true);
		expect(await sameTool).toBe(true);
		expect(alwaysAllowed).toEqual([["Write", { file_path: "a" }]]);
		// The grant is per tool: the queued Bash request still asks.
		expect(current()?.toolName).toBe("Bash");
		expect(current()?.queueLength).toBe(1);

		current()?.resolve(false, false);
		expect(await other).toBe(false);
	});

	test("clear denies every pending request, not just the one on screen", async () => {
		const { queue, current } = harness();
		const pending = [queue.request("Write", { file_path: "a" }), queue.request("Bash", { command: "ls" })];

		queue.clear();

		expect(await Promise.all(pending)).toEqual([false, false]);
		expect(current()).toBeNull();
	});

	test("clear is safe with nothing pending and still clears the dialog", async () => {
		const { queue, current } = harness();
		queue.clear();
		expect(current()).toBeNull();
	});

	// An answer arriving after the run was aborted must not resurrect a dialog
	// for a request nobody is waiting on any more.
	test("an answer that arrives after clear does not reopen the dialog", async () => {
		const { queue, current } = harness();
		const stale = queue.request("Write", { file_path: "a" });
		const staleDialog = current();
		queue.clear();

		staleDialog?.resolve(true, false);
		expect(await stale).toBe(false);
		expect(current()).toBeNull();
	});
});

/**
 * What "don't ask again" is allowed to cover.
 *
 * Answering every queued request with the same tool name was correct only while
 * the grant *was* the whole tool. A grant can now be scoped to the command the
 * user was looking at, and matching by name would then silently approve the
 * `rm -rf` queued behind that `git status` — the same tool, a different rule.
 */
describe("scoped always-allow", () => {
	const CWD = "C:\\work\\proj";

	test("covers the queued calls the rule matches, and only those", async () => {
		const { queue, current, alwaysAllowed } = harness(CWD);
		const asked = queue.request("Bash", { command: "git status" });
		const covered = queue.request("Bash", { command: "git log --oneline" });
		const notCovered = queue.request("Bash", { command: "rm -rf /" });

		expect(current()?.options?.[1].label).toContain("commands starting with `git `");
		current()?.resolve(true, true);

		expect(await asked).toBe(true);
		expect(await covered).toBe(true); // `git *` is the rule, and this is a git command
		expect(alwaysAllowed).toEqual([["Bash", { command: "git status" }]]);
		// Still asking: the grant was for git, and this is not git.
		expect(current()?.toolName).toBe("Bash");
		expect(current()?.inputPreview).toContain("rm -rf /");
		expect(current()?.queueLength).toBe(1);

		current()?.resolve(false, false);
		expect(await notCovered).toBe(false);
	});

	test("without a workspace root a scoped grant covers nothing queued", async () => {
		// The rule's reach cannot be established here, and assuming is how the
		// `rm -rf` gets through.
		const { queue, current } = harness();
		const asked = queue.request("Bash", { command: "git status" });
		const queued = queue.request("Bash", { command: "git log" });

		current()?.resolve(true, true);

		expect(await asked).toBe(true);
		expect(current()?.inputPreview).toContain("git log");
		current()?.resolve(false, false);
		expect(await queued).toBe(false);
	});

	test("an unscopable tool still covers its own queued calls", async () => {
		// WebFetch has no specifier grammar, so the grant is the bare tool and
		// re-asking would read as the answer having been ignored.
		const { queue, current } = harness(CWD);
		const first = queue.request("WebFetch", { url: "https://example.com" });
		const second = queue.request("WebFetch", { url: "https://example.org" });

		current()?.resolve(true, true);

		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(current()).toBeNull();
	});

	test("the dialog carries the full input for the Ctrl+A view", async () => {
		const { queue, current } = harness(CWD);
		const answer = queue.request("Bash", { command: "npm test" });

		expect(current()?.inputFull).toContain('"command": "npm test"');
		// The one-line preview is still what the dialog opens with.
		expect(current()?.inputPreview).toBe('Bash: {"command":"npm test"}');

		current()?.resolve(false, false);
		await answer;
	});
});
