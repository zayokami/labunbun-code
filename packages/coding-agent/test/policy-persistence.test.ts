/**
 * The permission policy, outliving the process.
 *
 * A "don't ask again" used to die at the process boundary, and the mode axes
 * died with it: `--resume` rebuilt both from flags and settings as if the
 * conversation had never said otherwise. The session file now carries a
 * snapshot — rules, mode, sandbox, network — written when the policy changes
 * and re-written when a compaction re-roots the chain out from under it.
 *
 * What these tests insist on is the shape the user experiences: answer once,
 * restart, and the same call goes through; a mode picked before a restart is
 * the mode after it; a grant made in the conversation being left does not
 * follow the user into the one they moved to. Every scenario drives the real
 * `runInteractive`, the real session and the real dialogs — ink's `render` is
 * the only thing replaced, the way `permission-cascade.test.ts` does it — and
 * every "no dialog" claim is a count of dialogs that did reach the store, not
 * an absence of evidence. The resume halves run as separate *processes*,
 * because an in-process rewrite of the same objects would pass with nothing on
 * disk at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findModeChoice, type PermissionRule, SessionStore } from "@labunbun/agent";
import { assistantMessage, userMessage } from "@labunbun/ai";
import {
	type PolicySnapshot,
	readPolicySnapshot,
	resolveStartupAxes,
	type StoredPolicyRule,
	samePolicy,
	savePolicySnapshot,
	sessionRulesFrom,
	storedRules,
} from "../src/policy-snapshot.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** A workspace with the three files the read probes use, and a home of its own. */
function workspace() {
	const home = tempDir("lbb-policy-home-");
	const cwd = tempDir("lbb-policy-cwd-");
	mkdirSync(join(cwd, "sub"));
	writeFileSync(join(cwd, "sub", "one.txt"), "one-contents");
	writeFileSync(join(cwd, "sub", "two.txt"), "two-contents");
	writeFileSync(join(cwd, "outside.txt"), "outside-contents");
	return { home, cwd };
}

function snapshot(overrides: Partial<PolicySnapshot>): PolicySnapshot {
	return {
		at: 1,
		rules: [],
		mode: "ask",
		sandbox: "workspace-write",
		network: { access: "enabled", domains: [] },
		...overrides,
	};
}

function policyEntries(store: SessionStore) {
	return store.entries.filter((entry) => entry.type === "custom" && entry.kind === "policy");
}

/**
 * One saved session, seeded from the test process: a marker user message so the
 * /resume picker can name it, and the policy snapshot spelled out here rather
 * than built by the code under test — the kind string and the shape are on disk,
 * so a fixture that shared a serializer with the reader could not catch a
 * reader and a writer drifting together.
 */
function seededSession(cwd: string, home: string, marker: string, policy: Record<string, unknown>): SessionStore {
	const store = SessionStore.startNew(cwd, home);
	store.appendMessage(userMessage(marker));
	store.appendMessage(assistantMessage({ content: [{ type: "text", text: "started" }], stopReason: "stop" }));
	store.appendCustom("policy", policy);
	return store;
}

// ---------------------------------------------------------------------------
// The harness: the real app in a child process, one script per scenario
// ---------------------------------------------------------------------------

interface StepSpec {
	text?: string;
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

type Op =
	| { op: "prompt"; text: string; always?: boolean }
	| { op: "command"; text: string }
	/** What Shift+Tab does in the REPL: move the session, then report the row. */
	| { op: "shiftTab" }
	| { op: "waitInfo"; match: string }
	| { op: "pick"; match: string };

interface AxisReport {
	mode: string;
	sandbox: string;
	network: { access: string; domains: unknown[] };
}

interface Report {
	exitCode: number;
	/** Every dialog that reached the screen, in order, across the whole run. */
	dialogs: string[];
	prompts: Array<{
		text: string;
		outcome: string;
		dialogs: string[];
		results: Array<{ isError: boolean; text: string }>;
	}>;
	/** The transcript's own lines (`pushInfo`), which is where commands answer. */
	infos: string[];
	/** The startup session's axes, read after the run. */
	axes: AxisReport | null;
	/** The axes of the session an in-app /resume swapped in, when one did. */
	swapped: AxisReport | null;
	/** The picker marker that could not be found, when one was not. */
	pickMiss: string | null;
	stderr: string;
}

async function scenario(input: {
	cwd: string;
	home: string;
	steps: StepSpec[];
	ops: Op[];
	options?: Record<string, unknown>;
}): Promise<Report> {
	const config = {
		cwd: input.cwd,
		home: input.home,
		steps: input.steps,
		ops: input.ops,
		options: { cwd: input.cwd, home: input.home, theme: "dark", ...input.options },
	};
	// Escapes inside this string are doubled where the script itself needs them.
	const script = `
		import { mock } from "bun:test";
		import * as ai from "@labunbun/ai";
		import { cycleModeChoice } from "@labunbun/agent";
		import { createRequire } from "node:module";
		import { pathToFileURL } from "node:url";
		// ink belongs to the TUI package, not this one, so it resolves from there
		// rather than from the working directory of this script.
		const ink = await import(pathToFileURL(
			createRequire(${JSON.stringify(join(import.meta.dir, "..", "..", "tui", "src", "probe.cjs"))}).resolve("ink"),
		).href);
		const CFG = ${JSON.stringify(config)};
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const shown = [];
		const answered = new Set();
		const dialogs = [];
		const prompts = [];
		let session = null;
		let handle = null;
		let swapped = null;
		let pickMiss = null;
		let optionsRef = null;
		let call = 0;
		mock.module("@labunbun/ai", () => ({
			...ai,
			// Startup asks the providers what they serve; the real one would reach
			// for the network, which a test must not do.
			resolveApiKey: () => "local-test-key",
			refreshModelCatalog: async () => null,
			createDefaultStreamFn: () => async function* (model) {
				const step = CFG.steps[Math.min(call++, CFG.steps.length - 1)];
				const builder = new ai.MessageBuilder(model.provider, model.id);
				yield builder.start();
				if (step.text) {
					yield builder.textStart(0);
					yield builder.textDelta(0, step.text);
					yield builder.textEnd(0);
				}
				let index = step.text ? 1 : 0;
				for (const spec of step.toolCalls ?? []) {
					yield builder.toolCallStart(index, "call_" + index, spec.name);
					yield builder.toolCallDelta(index, JSON.stringify(spec.arguments ?? {}));
					yield builder.toolCallEnd(index);
					index++;
				}
				yield builder.done((step.toolCalls ?? []).length > 0 ? "toolUse" : "stop");
			},
		}));
		// The screen is replaced and nothing else: mountRepl builds the real store
		// and the real queue, so the dialog the test presses is the dialog a user
		// would be looking at.
		mock.module("ink", () => ({
			...ink,
			render: () => ({ waitUntilExit: drive, unmount() {} }),
		}));
		const tui = await import("@labunbun/tui");
		// Copied before the mock goes in: the namespace object is re-linked by the
		// mock, so a later read of tui.mountRepl is the wrapper calling itself.
		const realMountRepl = tui.mountRepl;
		mock.module("@labunbun/tui", () => ({
			...tui,
			mountRepl: (options) => {
				optionsRef = options;
				session = options.session;
				handle = realMountRepl(options);
				// The swap's only observable moment from out here is the handle
				// call, so the wrapper is also what re-points the prompts at the
				// incoming session.
				const realSetSession = handle.setSession;
				handle.setSession = (next) => {
					session = next;
					swapped = next;
					realSetSession(next);
				};
				return handle;
			},
		}));
		const infos = () =>
			handle.store.get().entries.filter((entry) => entry.kind === "info").map((entry) => entry.text);
		const waitFor = async (ready, ms) => {
			const end = Date.now() + ms;
			while (Date.now() < end) {
				if (ready()) return true;
				await sleep(5);
			}
			return false;
		};
		const latest = (preview) => {
			for (let i = shown.length - 1; i >= 0; i--) if (shown[i].inputPreview === preview) return shown[i];
			return undefined;
		};
		// A request, not a redraw: the queue re-runs its show on every arrival, so
		// a stale dialog object for the same request must not be answered — the
		// answer has to land on the newest object holding that request's text.
		const answerAll = (always) => {
			for (const dialog of shown) {
				if (answered.has(dialog.inputPreview)) continue;
				const live = latest(dialog.inputPreview);
				if (!live) continue;
				answered.add(dialog.inputPreview);
				dialogs.push(dialog.inputPreview);
				live.resolve(true, always);
			}
		};
		async function runPrompt(op) {
			const startDialogs = shown.length;
			const startResults = session.messages.filter((message) => message.role === "toolResult").length;
			let settled = false;
			let outcome = null;
			session.prompt(op.text).then(
				(value) => { settled = true; outcome = value; },
				(error) => { settled = true; outcome = "rejected: " + (error && error.message ? error.message : error); },
			);
			const deadline = Date.now() + 20000;
			while (!settled && Date.now() < deadline) {
				answerAll(op.always === true);
				await sleep(5);
			}
			if (!settled) outcome = "timeout";
			const here = [];
			for (const dialog of shown.slice(startDialogs)) {
				if (here.indexOf(dialog.inputPreview) === -1) here.push(dialog.inputPreview);
			}
			const results = [];
			const fresh = session.messages.filter((message) => message.role === "toolResult").slice(startResults);
			for (const message of fresh) {
				results.push({
					isError: message.isError === true,
					text: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\\n"),
				});
			}
			prompts.push({ text: op.text, outcome, dialogs: here, results });
		}
		async function drive() {
			handle.store.subscribe(() => {
				const dialog = handle.store.get().dialog;
				if (dialog) shown.push(dialog);
			});
			for (const op of CFG.ops) {
				if (op.op === "prompt") {
					await runPrompt(op);
				} else if (op.op === "command") {
					optionsRef.onCommand(op.text);
				} else if (op.op === "shiftTab") {
					// Exactly the REPL's cycle: move the session, then report the row.
					const next = cycleModeChoice({ mode: session.permissionMode, sandbox: session.sandbox });
					session.setMode(next.mode, next.sandbox);
					optionsRef.onModeChange(next);
				} else if (op.op === "waitInfo") {
					const seen = infos().filter((text) => text.includes(op.match)).length;
					await waitFor(() => infos().filter((text) => text.includes(op.match)).length > seen, 15000);
				} else if (op.op === "pick") {
					await waitFor(() => handle.store.get().picker, 5000);
					const picker = handle.store.get().picker;
					if (!picker) {
						pickMiss = op.match;
						continue;
					}
					const index = picker.items.findIndex((item) => (item.description ?? "").includes(op.match));
					if (index === -1) {
						pickMiss = op.match;
						picker.resolve(null);
						continue;
					}
					picker.resolve(index);
					await waitFor(() => swapped !== null, 10000);
				}
			}
		}
		const { runInteractive } = await import("./src/interactive.ts");
		const exitCode = await runInteractive(CFG.options);
		const axes = session
			? { mode: session.permissionMode, sandbox: session.sandbox, network: session.network }
			: null;
		const swappedAxes = swapped
			? { mode: swapped.permissionMode, sandbox: swapped.sandbox, network: swapped.network }
			: null;
		console.log(JSON.stringify({ exitCode, dialogs, prompts, infos: infos(), axes, swapped: swappedAxes, pickMiss }));
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, HOME: input.home, USERPROFILE: input.home },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return { ...(JSON.parse(stdout.trim()) as Omit<Report, "stderr">), stderr };
}

// ---------------------------------------------------------------------------
// The snapshot as a value
// ---------------------------------------------------------------------------

describe("the policy snapshot as a value", () => {
	test("rules keep their scope and drop only their source", () => {
		const rules: PermissionRule[] = [
			{ toolName: "Bash", specifier: "git *", behavior: "allow", source: "userSettings" },
			{ toolName: "Read", behavior: "allow", source: "session" },
			{ toolName: "Write", specifier: "out/**", behavior: "deny", source: "policy" },
			{ toolName: "Bash", specifier: "git commit *", behavior: "ask", source: "session" },
		];

		const stored = storedRules(rules);
		expect(stored).toEqual<StoredPolicyRule[]>([
			{ toolName: "Bash", specifier: "git *", behavior: "allow" },
			{ toolName: "Read", behavior: "allow" },
			{ toolName: "Write", specifier: "out/**", behavior: "deny" },
			{ toolName: "Bash", specifier: "git commit *", behavior: "ask" },
		]);
		// What a file holds is what this session's user granted, whatever tier a
		// rule was loaded from before it was copied here — and a rule that asks
		// travels the same path: what the session holds, the file holds.
		expect(sessionRulesFrom(stored)).toEqual([
			{ toolName: "Bash", specifier: "git *", behavior: "allow", source: "session" },
			{ toolName: "Read", behavior: "allow", source: "session" },
			{ toolName: "Write", specifier: "out/**", behavior: "deny", source: "session" },
			{ toolName: "Bash", specifier: "git commit *", behavior: "ask", source: "session" },
		]);
	});

	test("equality ignores when a snapshot was taken and nothing else", () => {
		const base = snapshot({});
		expect(samePolicy(base, { ...base, at: 999 })).toBe(true);
		expect(samePolicy(base, { ...base, mode: "plan" })).toBe(false);
		expect(samePolicy(base, { ...base, sandbox: "danger-full-access" })).toBe(false);
		expect(samePolicy(base, { ...base, network: { access: "restricted", domains: [] } })).toBe(false);
		expect(
			samePolicy(base, { ...base, network: { access: "enabled", domains: [{ pattern: "a", permission: "deny" }] } }),
		).toBe(false);
		expect(samePolicy(base, { ...base, rules: [{ toolName: "Read", behavior: "allow" }] })).toBe(false);
		expect(samePolicy(undefined, base)).toBe(false);
		expect(samePolicy(undefined, undefined)).toBe(true);
	});
});

describe("what the file keeps", () => {
	function scratch() {
		const home = tempDir("lbb-policy-store-home-");
		return SessionStore.startNew(home, home);
	}

	test("the newest snapshot on the chain is the policy, older ones are history", () => {
		const store = scratch();

		savePolicySnapshot(store, snapshot({ mode: "plan" }));
		savePolicySnapshot(store, snapshot({ mode: "agent" }));

		expect(readPolicySnapshot(store)?.mode).toBe("agent");
		expect(policyEntries(store)).toHaveLength(2);
	});

	test("saving the same policy again writes nothing", () => {
		const store = scratch();

		savePolicySnapshot(store, snapshot({}));
		// A second call with a fresh clock but the same policy: the clock is the
		// record that the snapshot was taken, not part of the policy.
		savePolicySnapshot(store, snapshot({ at: 2 }));

		expect(policyEntries(store)).toHaveLength(1);
	});

	test("a snapshot abandoned by a branch is not the policy", () => {
		const store = scratch();

		store.appendMessage(userMessage("before"));
		const forkPoint = store.entries.at(-1);
		if (!forkPoint) throw new Error("expected a message");
		savePolicySnapshot(store, snapshot({ mode: "plan" }));
		store.appendMessage(userMessage("after"));

		// Back to the turn before the snapshot: the policy written above it is
		// history on another branch, and the active chain has none.
		expect(store.branch(forkPoint.id)).toBe(true);
		expect(readPolicySnapshot(store)).toBeUndefined();
	});

	test("a malformed snapshot is skipped rather than trusted", () => {
		const store = scratch();

		store.appendCustom("policy", {
			at: 1,
			rules: [],
			mode: "yolo",
			sandbox: "workspace-write",
			network: { access: "enabled", domains: [] },
		});
		expect(readPolicySnapshot(store)).toBeUndefined();

		store.appendCustom("policy", {
			at: 2,
			rules: [{ toolName: "Read", behavior: "sometimes" }],
			mode: "ask",
			sandbox: "workspace-write",
			network: { access: "enabled", domains: [] },
		});
		expect(readPolicySnapshot(store)).toBeUndefined();

		// A valid one below a broken tail is still the policy: a half-written last
		// line must not erase the answer before it.
		savePolicySnapshot(store, snapshot({ mode: "plan" }));
		store.appendCustom("policy", { nope: true });
		expect(readPolicySnapshot(store)?.mode).toBe("plan");
	});

	test("an ask rule is stored and comes back as ask", () => {
		const store = scratch();

		savePolicySnapshot(store, snapshot({ rules: [{ toolName: "Bash", specifier: "git commit *", behavior: "ask" }] }));

		// The file holds it...
		const [entry] = policyEntries(store);
		if (entry?.type !== "custom") throw new Error("expected the snapshot to be written");
		expect((entry.data as { rules?: unknown }).rules).toEqual([
			{ toolName: "Bash", specifier: "git commit *", behavior: "ask" },
		]);
		// ...and the reader accepts it. A guard that knew only allow/deny would
		// drop the whole snapshot on meeting one, which is how a session's ask
		// rule would quietly stop being in force after a restart.
		expect(readPolicySnapshot(store)?.rules).toEqual([
			{ toolName: "Bash", specifier: "git commit *", behavior: "ask" },
		]);
		expect(sessionRulesFrom(readPolicySnapshot(store)?.rules ?? [])).toEqual([
			{ toolName: "Bash", specifier: "git commit *", behavior: "ask", source: "session" },
		]);
	});

	test("a rule with no behavior is refused, not guessed into a grant", () => {
		const store = scratch();

		// Every snapshot this format has ever had came from `storedRules`, which
		// has written `behavior` since the first one — so a rule without it is not
		// a legacy shape to translate, it is a field this build cannot read.
		// Defaulting it to `allow` would invent a grant out of a malformed rule,
		// and a grant runs calls: the one direction this reader must not guess in.
		store.appendCustom("policy", {
			at: 1,
			rules: [{ toolName: "Bash", specifier: "git *" }],
			mode: "agent",
			sandbox: "workspace-write",
			network: { access: "enabled", domains: [] },
		});
		expect(readPolicySnapshot(store)).toBeUndefined();

		// And the refusal is boxed to the one snapshot: with a valid policy below
		// the unreadable tail, the older answer stands rather than the session
		// starting from nothing.
		savePolicySnapshot(store, snapshot({ mode: "plan" }));
		store.appendCustom("policy", {
			at: 3,
			rules: [{ toolName: "Read" }],
			mode: "agent",
			sandbox: "workspace-write",
			network: { access: "enabled", domains: [] },
		});
		expect(readPolicySnapshot(store)?.mode).toBe("plan");
		expect(readPolicySnapshot(store)?.rules).toEqual([]);
	});
});

describe("where a resumed run's axes come from", () => {
	const fallback = { mode: "ask" as const, sandbox: "workspace-write" as const };
	const settingsNetwork = { access: "enabled" as const, domains: [] };
	const policy = {
		mode: "plan" as const,
		sandbox: "danger-full-access" as const,
		network: { access: "restricted" as const, domains: [{ pattern: "api.example.com", permission: "allow" as const }] },
	};

	test("nothing named: the settings file, then the default row", () => {
		expect(resolveStartupAxes({ settingsNetwork, fallback })).toEqual({
			mode: "ask",
			sandbox: "workspace-write",
			network: settingsNetwork,
		});
		expect(
			resolveStartupAxes({ settingsNetwork, settingsMode: "agent", settingsSandbox: "danger-full-access", fallback }),
		).toEqual({ mode: "agent", sandbox: "danger-full-access", network: settingsNetwork });
	});

	test("a session that recorded its axes outranks the settings file", () => {
		expect(
			resolveStartupAxes({
				settingsNetwork,
				settingsMode: "ask",
				settingsSandbox: "workspace-write",
				policy,
				fallback,
			}),
		).toEqual({ mode: "plan", sandbox: "danger-full-access", network: policy.network });
	});

	test("a flag that names one axis settles that axis alone", () => {
		expect(resolveStartupAxes({ settingsNetwork, flagMode: "agent", policy, fallback })).toEqual({
			mode: "agent",
			sandbox: "danger-full-access",
			network: policy.network,
		});
		expect(resolveStartupAxes({ settingsNetwork, flagSandbox: "workspace-write", policy, fallback })).toEqual({
			mode: "plan",
			sandbox: "workspace-write",
			network: policy.network,
		});
	});

	test("a picker row names the pair, so it beats two separate answers", () => {
		expect(
			resolveStartupAxes({
				choice: findModeChoice("agentNoSandbox"),
				flagMode: "ask",
				flagSandbox: "workspace-write",
				policy,
				settingsNetwork,
				fallback,
			}),
		).toEqual({ mode: "agent", sandbox: "danger-full-access", network: policy.network });
	});

	test("the network axis has no flag: the snapshot, then settings", () => {
		expect(
			resolveStartupAxes({
				policy: { ...policy, network: { access: "enabled", domains: [] } },
				settingsNetwork: { access: "restricted", domains: [] },
				fallback,
			}),
		).toEqual({ mode: "plan", sandbox: "danger-full-access", network: { access: "enabled", domains: [] } });
	});
});

// ---------------------------------------------------------------------------
// The golden acceptance: answer once, restart, and it goes through
// ---------------------------------------------------------------------------

describe("a grant that outlives the process", () => {
	test("answer once, restart, and the same read goes through", async () => {
		const { home, cwd } = workspace();
		const one = join(cwd, "sub", "one.txt");
		const two = join(cwd, "sub", "two.txt");
		const outside = join(cwd, "outside.txt");

		const first = await scenario({
			cwd,
			home,
			steps: [
				{ toolCalls: [{ name: "Read", arguments: { file_path: one } }] },
				{ text: "read it" },
				{ toolCalls: [{ name: "Read", arguments: { file_path: two } }] },
				{ text: "read that too" },
			],
			ops: [
				{ op: "prompt", text: "read one", always: true },
				{ op: "prompt", text: "read two" },
			],
		});

		// The grant dialog is the only dialog this run saw — the second read, in
		// the process that granted the rule, was already answered by it.
		expect(first.dialogs).toHaveLength(1);
		expect(first.prompts.map((prompt) => prompt.dialogs.length)).toEqual([1, 0]);
		expect(first.prompts.every((prompt) => prompt.outcome === "completed")).toBe(true);

		// What the grant left on disk, spelled out: scoped to the directory the
		// user was looking at, and stored with no source field at all.
		const [saved] = SessionStore.listSessions(cwd, home);
		if (!saved) throw new Error("expected the run to persist a session");
		const savedStore = SessionStore.load(saved.path);
		const policy = readPolicySnapshot(savedStore);
		expect(policy).toMatchObject({ mode: "ask", sandbox: "workspace-write" });
		expect(policy?.rules).toEqual([{ toolName: "Read", specifier: "sub/**", behavior: "allow" }]);
		expect(policy?.network).toEqual({ access: "enabled", domains: [] });
		// Written once for the one thing that changed: no per-turn backstop added
		// a copy on the second prompt.
		expect(policyEntries(savedStore)).toHaveLength(1);

		// A second process, resumed on that file.
		const second = await scenario({
			cwd,
			home,
			options: { resumeSessionId: saved.sessionId },
			steps: [
				{ toolCalls: [{ name: "Read", arguments: { file_path: two } }] },
				{ text: "read it again" },
				{ toolCalls: [{ name: "Read", arguments: { file_path: outside } }] },
				{ text: "and this" },
			],
			ops: [
				{ op: "prompt", text: "read two again" },
				{ op: "command", text: "/permissions" },
				{ op: "prompt", text: "read outside", always: false },
			],
		});

		// The same-shaped call did not prompt, and it ran: the file's contents came
		// back, so this is an allow and not a silently denied call.
		expect(second.prompts[0].outcome).toBe("completed");
		expect(second.prompts[0].dialogs).toEqual([]);
		expect(second.prompts[0].results).toHaveLength(1);
		expect(second.prompts[0].results[0]?.isError).toBe(false);
		expect(second.prompts[0].results[0]?.text).toContain("two-contents");

		// And the restored rule is a session rule, listed as one: a grant that came
		// back claiming a settings tier would answer a question nobody asked the
		// settings.
		const rules = second.infos.find((text) => text.includes("Rules ("));
		expect(rules).toContain("Rules (1):");
		expect(rules).toContain("allow Read(sub/**)  [session]");

		// The scope came back with it: a file outside the granted directory is not
		// covered, so a restored rule that lost its specifier fails here.
		expect(second.prompts[1].dialogs).toHaveLength(1);
		expect(second.prompts[1].results).toHaveLength(1);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// The regressions the compaction and the model switch can cause
// ---------------------------------------------------------------------------

describe("surviving the two rewrites", () => {
	test("a compaction puts the policy back on the chain", async () => {
		const { home, cwd } = workspace();
		const one = join(cwd, "sub", "one.txt");
		const two = join(cwd, "sub", "two.txt");

		const first = await scenario({
			cwd,
			home,
			steps: [
				{ toolCalls: [{ name: "Read", arguments: { file_path: one } }] },
				{ text: "read it" },
				// The /compact summary call comes between the two prompts.
				{ text: "Compacted summary." },
				{ toolCalls: [{ name: "Read", arguments: { file_path: two } }] },
				{ text: "read it again" },
			],
			ops: [
				{ op: "prompt", text: "read one", always: true },
				{ op: "command", text: "/compact" },
				{ op: "waitInfo", match: "Conversation compacted" },
				{ op: "prompt", text: "read two" },
			],
		});

		expect(first.prompts.map((prompt) => prompt.dialogs.length)).toEqual([1, 0]);
		expect(first.prompts[1]?.outcome).toBe("completed");

		const [saved] = SessionStore.listSessions(cwd, home);
		if (!saved) throw new Error("expected the run to persist a session");
		const loaded = SessionStore.load(saved.path);
		const chain = loaded.linearEntries();
		const boundary = chain.map((entry) => entry.type).lastIndexOf("compaction");
		const policyAt = chain.map((entry) => (entry.type === "custom" && entry.kind === "policy" ? 1 : 0)).lastIndexOf(1);
		expect(boundary).toBeGreaterThan(-1);
		// Below the boundary, not above it: a snapshot the re-root left behind is a
		// snapshot the next restart will not find.
		expect(policyAt).toBeGreaterThan(boundary);
		expect(readPolicySnapshot(loaded)?.rules).toEqual([{ toolName: "Read", specifier: "sub/**", behavior: "allow" }]);

		// The restart that reads it: the rule still answers.
		const resumed = await scenario({
			cwd,
			home,
			options: { resumeSessionId: saved.sessionId },
			steps: [{ toolCalls: [{ name: "Read", arguments: { file_path: two } }] }, { text: "again" }],
			ops: [{ op: "prompt", text: "read two" }],
		});
		expect(resumed.prompts[0]?.dialogs).toEqual([]);
		expect(resumed.prompts[0]?.results).toHaveLength(1);
		expect(resumed.prompts[0]?.results[0]?.isError).toBe(false);
	}, 60_000);

	test("/model leaves the grants alone", async () => {
		const { home, cwd } = workspace();
		const one = join(cwd, "sub", "one.txt");
		const two = join(cwd, "sub", "two.txt");

		const result = await scenario({
			cwd,
			home,
			steps: [
				{ toolCalls: [{ name: "Read", arguments: { file_path: one } }] },
				{ text: "read it" },
				{ toolCalls: [{ name: "Read", arguments: { file_path: two } }] },
				{ text: "read that too" },
			],
			ops: [
				{ op: "prompt", text: "read one", always: true },
				{ op: "command", text: "/model anthropic/claude-sonnet-5-5" },
				{ op: "prompt", text: "read two" },
			],
		});

		expect(result.dialogs).toHaveLength(1);
		expect(result.prompts[1]?.dialogs).toEqual([]);
		expect(result.prompts[1]?.results).toHaveLength(1);
		expect(result.infos.some((text) => text.includes("Model: anthropic/claude-sonnet-5-5"))).toBe(true);
	}, 30_000);
});

// ---------------------------------------------------------------------------
// The axes across a restart
// ---------------------------------------------------------------------------

describe("the mode axes across a restart", () => {
	test("a mode picked before the restart is the mode after it", async () => {
		const { home, cwd } = workspace();
		const network = { access: "restricted", domains: [{ pattern: "api.example.com", permission: "allow" }] };

		// The first run picks the axes the two ways a keyboard has: /mode and the
		// key. The network axis is not touchable from either, so it is the one that
		// has to come back out of the snapshot on its own.
		const set = await scenario({
			cwd,
			home,
			options: {
				flagSettings: { networkAccess: "restricted", networkDomains: [{ domain: "api.example.com", action: "allow" }] },
			},
			steps: [{ text: "unused" }],
			ops: [{ op: "command", text: "/mode agent" }, { op: "shiftTab" }],
		});
		expect(set.exitCode).toBe(0);

		const [saved] = SessionStore.listSessions(cwd, home);
		if (!saved) throw new Error("expected the run to persist a session");
		const savedStore = SessionStore.load(saved.path);
		// One write per change and not one more: /mode moved the pair, Shift+Tab
		// moved the sandbox, and nothing else had anything to record.
		expect(policyEntries(savedStore)).toHaveLength(2);
		expect(readPolicySnapshot(savedStore)).toMatchObject({ mode: "agent", sandbox: "danger-full-access", network });

		// The restart, under settings that say something else entirely: the
		// snapshot outranks them on all three axes.
		const restored = await scenario({
			cwd,
			home,
			options: { resumeSessionId: saved.sessionId, flagSettings: { permissionMode: "ask" } },
			steps: [{ text: "unused" }],
			ops: [],
		});
		expect(restored.axes).toEqual({ mode: "agent", sandbox: "danger-full-access", network });

		// The flag, by contrast, is this run's word and beats the file — for the
		// axis it names, and only that one.
		const flagged = await scenario({
			cwd,
			home,
			options: { resumeSessionId: saved.sessionId, permissionMode: "ask" },
			steps: [{ text: "unused" }],
			ops: [],
		});
		expect(flagged.axes).toEqual({ mode: "ask", sandbox: "danger-full-access", network });
	}, 60_000);
});

// ---------------------------------------------------------------------------
// The in-app /resume: no leak, axes from the target
// ---------------------------------------------------------------------------

describe("an in-app /resume", () => {
	test("does not carry the old conversation's grants into the new one", async () => {
		const { home, cwd } = workspace();
		const one = join(cwd, "sub", "one.txt");
		const two = join(cwd, "sub", "two.txt");
		const target = seededSession(cwd, home, "session b marker", {
			at: 2,
			rules: [],
			mode: "ask",
			sandbox: "workspace-write",
			network: { access: "restricted", domains: [] },
		});
		const current = seededSession(cwd, home, "session a marker", {
			at: 1,
			rules: [],
			mode: "ask",
			sandbox: "workspace-write",
			network: { access: "enabled", domains: [] },
		});
		const currentId = current.sessionId;
		if (!currentId || !target.sessionId) throw new Error("expected session ids");

		const result = await scenario({
			cwd,
			home,
			options: { resumeSessionId: currentId },
			steps: [
				{ toolCalls: [{ name: "Read", arguments: { file_path: one } }] },
				{ text: "read" },
				{ toolCalls: [{ name: "Read", arguments: { file_path: two } }] },
				{ text: "read again" },
			],
			ops: [
				{ op: "prompt", text: "read one", always: true },
				{ op: "command", text: "/resume" },
				{ op: "pick", match: "session b marker" },
				{ op: "prompt", text: "read two" },
				{ op: "command", text: "/permissions" },
			],
		});

		expect(result.pickMiss).toBeNull();
		expect(result.prompts[0]?.dialogs).toHaveLength(1);
		// The grant was made a moment ago, in the conversation that was just left.
		// The call it would answer is asked anyway.
		expect(result.prompts[1]?.dialogs).toHaveLength(1);
		// And the axes are the incoming session's own: the one axis that differs is
		// the one only the target's snapshot could have answered.
		expect(result.swapped?.network.access).toBe("restricted");
		// The rules array agrees, read through the same listing the engine's rules
		// come from.
		const rules = result.infos.filter((text) => text.includes("Rules (")).at(-1);
		expect(rules).toContain("Rules (0):");
	}, 60_000);
});
