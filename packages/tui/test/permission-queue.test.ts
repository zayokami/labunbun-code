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

function harness(cwd?: string, canAutoResolve?: (toolName: string, input: unknown) => boolean) {
	const shown: Array<PermissionDialogState | null> = [];
	const alwaysAllowed: Array<[string, unknown]> = [];
	const consulted: Array<[string, unknown]> = [];
	const queue = createPermissionQueue({
		show: (dialog) => shown.push(dialog),
		preview: (toolName, input) => `${toolName}: ${JSON.stringify(input)}`,
		fullPreview: (toolName, input) => `${toolName} full:\n${JSON.stringify(input, null, 2)}`,
		cwd,
		onAlwaysAllow: (toolName, input) => alwaysAllowed.push([toolName, input]),
		...(canAutoResolve
			? {
					canAutoResolve: (toolName: string, input: unknown) => {
						consulted.push([toolName, input]);
						return canAutoResolve(toolName, input);
					},
				}
			: {}),
	});
	return {
		queue,
		alwaysAllowed,
		/** Every call the policy hook was asked about, in order. */
		consulted,
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

/**
 * A match is not a permission.
 *
 * The cascade above answers queued requests from the rule the user just granted,
 * and matching is all it knows: the same tool, the same scope, the same grammar
 * the engine uses. What it cannot know is policy — the rules and the mode live
 * in the app layer, so the app layer answers, and it answers by evaluating
 * afresh.
 *
 * The case that makes this necessary is a mode that moved. Everything queued was
 * raised under the mode in force when it was raised, and `EnterPlanMode` is
 * concurrency-safe: a grant made after it fires must not carry a `Write` that
 * plan mode now refuses. What the tests below pin is the shape of the answer to
 * that: a fresh refusal asks again, a fresh permission keeps the cascade, and a
 * plain "yes, just this once" never consults the gate at all.
 */
describe("the policy gate on the cascade", () => {
	const CWD = "C:\\work\\proj";

	// The rule matches and the policy refuses: the request must still be asked.
	// This is the one the gate exists for, and it is invisible without it — the
	// queue has no way to know the mode moved, so the call is answered by a rule
	// the current mode would not have accepted.
	test("a matched request the policy refuses is still asked about", async () => {
		const { queue, current, alwaysAllowed } = harness(CWD, () => false);
		const asked = queue.request("Bash", { command: "git status" });
		const matched = queue.request("Bash", { command: "git log --oneline" });

		current()?.resolve(true, true);

		// The grant itself is honoured — the human said yes to the call in front of
		// them, and nothing here second-guesses that.
		expect(await asked).toBe(true);
		expect(alwaysAllowed).toEqual([["Bash", { command: "git status" }]]);
		// The rule is stored; the sibling is not covered by it as far as the session
		// is concerned, and the dialog is back on screen to say so.
		expect(current()?.inputPreview).toContain("git log --oneline");
		expect(current()?.queueLength).toBe(1);

		current()?.resolve(false, false);
		expect(await matched).toBe(false);
	});

	/**
	 * The other half, and the reason the gate is a conjunction rather than a
	 * replacement: a queue with a policy that says yes must behave exactly as it
	 * did before the gate existed. A gate that only ever blocks would pass the test
	 * above while quietly turning "don't ask again" into "ask again, every time".
	 */
	test("a matched request the policy allows is answered from the grant, as before", async () => {
		const { queue, current, consulted } = harness(CWD, () => true);
		const first = queue.request("Bash", { command: "git status" });
		const second = queue.request("Bash", { command: "git log --oneline" });

		current()?.resolve(true, true);

		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(current()).toBeNull();
		// Asked about exactly the one request the cascade considered — the one in
		// front of the user was already answered.
		expect(consulted).toEqual([["Bash", { command: "git log --oneline" }]]);
	});

	/**
	 * The ordering the app layer depends on, and the reason this is a callback
	 * rather than the queue reading the rules: the grant is recorded by
	 * `onAlwaysAllow`, and the evaluation has to see that rule. A queue that
	 * evaluated against the rules as they were *before* the grant would answer
	 * "still needs a human" for every request — always safe, and the feature dead.
	 */
	test("the gate is consulted after the grant is recorded, not before", async () => {
		const granted: Array<[string, unknown]> = [];
		const { queue, current, consulted } = harness(CWD, (toolName, input) => {
			// The policy the app layer would evaluate: the grant is already in it.
			return granted.some(([t, i]) => t === toolName && JSON.stringify(i) === JSON.stringify(input));
		});
		// `onAlwaysAllow` in the harness records into `alwaysAllowed`; this gate
		// stands in for the same push, so the two run in the order the app layer
		// writes them.
		const first = queue.request("Write", { file_path: "a" });
		const second = queue.request("Write", { file_path: "b" });
		granted.push(["Write", { file_path: "a" }]);

		current()?.resolve(true, true);
		expect(await first).toBe(true);
		// The second is the same tool with the same (unscopable) shape, so the gate
		// is asked and it can only answer with what the app layer knows by now.
		expect(consulted).toEqual([["Write", { file_path: "b" }]]);
		expect(current()?.inputPreview).toContain('"file_path":"b"');

		current()?.resolve(false, false);
		expect(await second).toBe(false);
	});

	/**
	 * A queue with no policy access keeps the behaviour it had. The hook is
	 * optional so a caller that cannot answer it is not forced to invent an
	 * answer — and inventing "no" would silently disable the feature, which is a
	 * worse failure than not having the gate.
	 */
	test("without a policy hook the cascade still answers what the rule matches", async () => {
		const { queue, current, consulted } = harness(CWD);
		const first = queue.request("Bash", { command: "git status" });
		const second = queue.request("Bash", { command: "git log" });

		current()?.resolve(true, true);

		expect(await first).toBe(true);
		expect(await second).toBe(true);
		expect(consulted).toEqual([]);
	});

	// The gate is a policy question, so a plain "yes, just this once" must not
	// consult it: there is no cascade, and nothing to decide.
	test("a one-off answer never consults the policy", async () => {
		const { queue, current, consulted } = harness(CWD, () => false);
		const first = queue.request("Bash", { command: "git status" });
		const second = queue.request("Bash", { command: "git log" });

		current()?.resolve(true, false);

		expect(await first).toBe(true);
		expect(consulted).toEqual([]);
		expect(current()?.inputPreview).toContain("git log");

		current()?.resolve(false, false);
		expect(await second).toBe(false);
	});
});
