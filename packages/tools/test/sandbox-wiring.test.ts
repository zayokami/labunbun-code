/**
 * Does the sandbox actually reach the spawn?
 *
 * The translators next door are unit-tested as pure functions, which leaves the
 * question this file answers: a policy that says the workspace is the only
 * writable root is worth nothing if the process that runs the command never
 * consults it. So these tests drive the real `exec` and the real background
 * manager and watch what gets spawned.
 *
 * The trick is the `SandboxRuntime` injection. On the machine this repository is
 * built on there is no native backend, so the wrapping branch is unreachable and
 * "the wrapper is around the shell" would be untestable — which is exactly how a
 * wiring that was never wired passes CI forever. Constructing the executor with a
 * fake Linux runtime makes the branch reachable: `bwrap` is genuinely not
 * installed here, so a confined command fails with a spawn error naming it, and
 * an unconfined one runs. The two outcomes differ, which is what makes the
 * control a control.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildSandboxPolicy,
	isWritePermitted,
	type NetworkAxis,
	type SandboxMode,
	type SandboxPolicy,
	type ToolCallContext,
} from "@labunbun/agent";
import { BackgroundShellManager } from "../src/background.ts";
import { createBashTool } from "../src/bash.ts";
import { createAllTools } from "../src/index.ts";
import { ChildProcessExecOperations, defaultOperations, type ExecResult, type Operations } from "../src/operations.ts";
import { createReadTool } from "../src/read.ts";
import {
	describeSandboxBackend,
	detectNativeBackend,
	policyFor,
	resolveSandboxExecution,
	type SandboxRuntime,
	sandboxBackendFor,
} from "../src/sandbox/index.ts";
import { decideRead, decideWrite } from "../src/sandbox/simulated.ts";
import { workspacePolicy } from "../src/sandbox/workspace-policy.ts";
import { createWriteTool } from "../src/write.ts";

/** A machine this one is not: Linux, with bubblewrap believed to be present. */
const FAKE_LINUX: SandboxRuntime = { platform: "linux", hasNativeBackend: true };

function workspace(): string {
	return mkdtempSync(join(tmpdir(), "lbb-sandbox-wire-"));
}

/**
 * The spelling a policy path has once `buildSandboxPolicy` is done with it.
 *
 * Every expectation below compares argv against a path built with `join`, and on
 * Windows that is a backslash path while the policy now emits `/`. The
 * normalisation is the behaviour under test elsewhere
 * (`sandbox-policy.test.ts`), so restating it here as a literal `replace` is
 * deliberate: a test that re-derived the expected value with the same call the
 * code uses would agree with a regression in that call.
 */
function canonical(path: string): string {
	return path.replace(/\\/g, "/");
}

function policy(sandbox: SandboxMode, cwd: string) {
	return buildSandboxPolicy({ sandbox, workspace: cwd });
}

/**
 * A policy the filesystem half does not object to, carrying a network axis.
 *
 * Unrestricted on purpose: the filesystem wrapper is built out of that half, and
 * `bwrap` is not installed here, so a `workspace-write` command never reaches
 * the point where it could report an environment. These tests are about the
 * network, and the network has to be the only thing in play.
 */
function netPolicy(
	cwd: string,
	network: "enabled" | "restricted",
	rules: { pattern: string; permission: "allow" | "deny" }[],
) {
	return buildSandboxPolicy({ sandbox: "danger-full-access", workspace: cwd, network, networkRules: rules });
}

const CTX = (sandbox: SandboxMode) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd: process.cwd(),
	sandbox,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

/** Records the options it was handed so a test can read back the policy. */
function capturingOps(sink: { last?: { sandbox?: unknown } }): Operations {
	return {
		...defaultOperations(),
		exec: (options): Promise<ExecResult> => {
			sink.last = options;
			return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, killed: false });
		},
	};
}

/**
 * Whether a real `bwrap` is on this machine's PATH.
 *
 * **The two tests below used to assume it is not**, and that assumption is the
 * whole reason this probe exists. They proved the wrapper was applied by
 * asserting that the spawn failed naming a program that is not installed — which
 * is true, and which stops being true the moment anyone installs bubblewrap. A
 * runner image that gained it would have turned both red while testing nothing.
 *
 * The replacement signal has to **differ between "wrapped" and "unwrapped"**,
 * because the obvious one does not. With bubblewrap present, `echo hi` runs to
 * completion *either way* — wrapped it prints `hi` and exits 0, unwrapped it
 * prints `hi` and exits 0. Identical output, so an assertion on stdout would be
 * the no-discrimination probe this repository keeps warning about.
 *
 * So the branch that runs when bubblewrap is installed asserts something the
 * wrapper *changes*: a write outside the workspace fails inside it and succeeds
 * outside it. That pair differs under the two hypotheses, which is the only
 * property that makes the assertion worth having.
 */
const BWRAP_INSTALLED = detectNativeBackend("linux");

describe("the sandbox reaches the foreground spawn", () => {
	test(
		BWRAP_INSTALLED
			? "a confined command is confined: it cannot write outside the workspace"
			: "a confined command is handed to bwrap, which is not installed here",
		async () => {
			const cwd = workspace();
			const outside = mkdtempSync(join(tmpdir(), "lbb-outside-"));
			const exec = new ChildProcessExecOperations(FAKE_LINUX);
			try {
				if (!BWRAP_INSTALLED) {
					const result = await exec.exec({ command: "echo hi", cwd, sandbox: policy("workspace-write", cwd) });
					// The proof is the error naming a program that is not there. If the
					// wrapper were not applied the command would print `hi` and exit 0, so
					// this assertion fails the moment the wiring is removed — which is the
					// line a reader would otherwise have to take on trust.
					expect(result.exitCode).not.toBe(0);
					expect(result.stderr).toContain("bwrap");
					return;
				}
				// Bubblewrap is here, so the wrapper runs. What changes is the
				// filesystem: `--ro-bind / /` makes everything outside the writable
				// roots read-only, so this write the unwrapped shell would do is refused.
				const target = join(outside, "escaped.txt");
				const result = await exec.exec({
					command: `echo x > ${JSON.stringify(target)}`,
					cwd,
					sandbox: policy("workspace-write", cwd),
				});
				expect(result.exitCode, `the write outside the workspace succeeded: ${result.stderr}`).not.toBe(0);
				expect(existsSync(target)).toBe(false);
			} finally {
				await exec.close();
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);

	test(
		BWRAP_INSTALLED
			? "CONTROL: the same write outside the workspace is allowed with no policy"
			: "the control: the same executor runs the same command when the policy is unrestricted",
		async () => {
			// A control that cannot fail is not a control. This one differs from the
			// test above only in the sandbox axis, and the two must not agree — so if
			// the assertion above ever starts passing for the wrong reason, this one
			// is what notices.
			const cwd = workspace();
			const exec = new ChildProcessExecOperations(FAKE_LINUX);
			try {
				if (!BWRAP_INSTALLED) {
					const result = await exec.exec({ command: "echo hi", cwd, sandbox: policy("danger-full-access", cwd) });
					expect(result.exitCode).toBe(0);
					expect(result.stdout.trim()).toBe("hi");
					return;
				}
				const outside = mkdtempSync(join(tmpdir(), "lbb-outside-ctl-"));
				const target = join(outside, "allowed.txt");
				try {
					const result = await exec.exec({
						command: `echo x > ${JSON.stringify(target)}`,
						cwd,
						sandbox: policy("danger-full-access", cwd),
					});
					// Unwrapped, the same command succeeds. If it did not, the refusal
					// above would be attributable to something other than the sandbox.
					expect(result.exitCode, result.stderr).toBe(0);
					expect(existsSync(target)).toBe(true);
				} finally {
					rmSync(outside, { recursive: true, force: true });
				}
			} finally {
				await exec.close();
			}
		},
	);

	test("no policy at all is the plain shell, exactly as it was", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const result = await exec.exec({ command: "echo hi", cwd });
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe("hi");
		} finally {
			await exec.close();
		}
	});
});

describe("the sandbox reaches the background spawn too", () => {
	// The bypass this closes was invisible: `run_in_background: true` would have
	// spawned the shell directly, so the sandbox would have looked like it worked
	// for every command a user ran in the foreground.
	test(
		BWRAP_INSTALLED
			? "a backgrounded command is confined the same way a foreground one is"
			: "a backgrounded command is wrapped the same way a foreground one is",
		async () => {
			const cwd = workspace();
			const outside = mkdtempSync(join(tmpdir(), "lbb-outside-bg-"));
			const exec = new ChildProcessExecOperations(FAKE_LINUX);
			const manager = new BackgroundShellManager(FAKE_LINUX, exec);
			try {
				// The signal is the same one the foreground row uses, and for the same
				// reason: with bubblewrap installed, "it ran" is identical whether or
				// not the wrapper was applied. A write outside the workspace is not.
				const target = join(outside, "escaped.txt");
				const command = BWRAP_INSTALLED ? `echo x > ${JSON.stringify(target)}` : "echo hi";
				const shell = await manager.start(command, cwd, policy("workspace-write", cwd));

				const exited = await new Promise<boolean>((resolve) => {
					const poll = setInterval(() => {
						const info = manager.get(shell.id);
						if (info && info.status !== "running") {
							clearInterval(poll);
							resolve(true);
						}
					}, 25);
					setTimeout(() => {
						clearInterval(poll);
						resolve(false);
					}, 15_000);
				});

				expect(exited).toBe(true);
				if (BWRAP_INSTALLED) {
					expect(existsSync(target), "the background path let a write escape the workspace").toBe(false);
				} else {
					expect(manager.get(shell.id)?.exitCode).not.toBe(0);
					expect(manager.output(shell.id)).toContain("bwrap");
				}
			} finally {
				await exec.close();
				rmSync(outside, { recursive: true, force: true });
			}
		},
	);

	test("the control: unrestricted runs in the background as well", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		const manager = new BackgroundShellManager(FAKE_LINUX, exec);
		const shell = await manager.start("echo hi", cwd, policy("danger-full-access", cwd));

		for (let i = 0; i < 200; i++) {
			if (manager.get(shell.id)?.status !== "running") break;
			await Bun.sleep(25);
		}
		expect(manager.get(shell.id)?.exitCode).toBe(0);
		expect(manager.output(shell.id)).toContain("hi");
	});
});

describe("the Bash tool builds its policy from the context, per call", () => {
	for (const sandbox of ["workspace-write", "danger-full-access"] as const) {
		test(`${sandbox} reaches exec as the policy kind it names`, async () => {
			const cwd = workspace();
			const sink: { last?: { sandbox?: unknown } } = {};
			const tool = createBashTool(cwd, capturingOps(sink));
			await tool.call({ command: "echo hi" }, CTX(sandbox));
			const built = sink.last?.sandbox as { fileSystem: { kind: string } } | undefined;
			// Read per call rather than captured at construction: `/mode` can change
			// the sandbox mid-session, and a tool holding the value it was built
			// with keeps applying the old one. Two calls with two values is the
			// only way to show it re-reads.
			expect(built?.fileSystem.kind).toBe(sandbox === "workspace-write" ? "restricted" : "unrestricted");
		});
	}

	test("a .git in the workspace reaches the policy the tool hands to exec", async () => {
		// Without this the protected list could be dropped anywhere between the
		// scan and the spawn and every test above would still pass, because a
		// workspace with no repository in it has nothing to protect.
		const cwd = workspace();
		mkdirSync(join(cwd, ".git"), { recursive: true });
		writeFileSync(join(cwd, ".git", "config"), "[core]\n");
		const sink: { last?: { sandbox?: unknown } } = {};
		const tool = createBashTool(cwd, capturingOps(sink));
		await tool.call({ command: "echo hi" }, CTX("workspace-write"));
		const built = sink.last?.sandbox as { protected: string[] } | undefined;
		expect(built?.protected.some((p) => p.endsWith("/.git"))).toBe(true);
	});
});

describe("the policy refuses a write inside protected metadata", () => {
	test("a real Write call is refused by the policy, not by the guard in front of it", async () => {
		// The reachability question, answered through the tool rather than around
		// it. `guardWritablePath` runs first and is strictly stronger for every root
		// the app currently builds — all of them outside the workspace, which it
		// refuses outright — so a test that used one of those roots would pass
		// whether or not `decideWrite` was ever called, and would prove nothing.
		// A root *inside* the workspace is the one shape where the policy is the
		// only thing that can say no, so that is the one this builds.
		//
		// The message is the other half: it can only have come from `decideWrite`.
		const cwd = workspace();
		mkdirSync(join(cwd, "generated"), { recursive: true });
		const tool = createWriteTool(cwd, defaultOperations(), [join(cwd, "generated")]);

		const refused = await tool.call(
			{ file_path: join(cwd, "generated", "out.txt"), content: "x" },
			CTX("workspace-write"),
		);
		expect(refused.isError).toBe(true);
		expect((refused.content[0] as { text: string }).text).toContain("readable but not writable");

		// The control: a sibling the policy does not call read-only still writes,
		// so the refusal above is about the root and not about the workspace.
		const allowed = await tool.call({ file_path: join(cwd, "notes.md"), content: "x" }, CTX("workspace-write"));
		expect(allowed.isError).toBeFalsy();
	});

	test("a real Read call is refused outside the workspace in every mode, including no sandbox", async () => {
		// The regression this pair of tests exists for. Routing Read's escape hatch
		// through the session's policy made `danger-full-access` — which builds
		// `kind: "unrestricted"`, and on which `decideRead` allows every path — open
		// the whole disk to the model. The Read tool's boundary is the application's
		// and does not move with the mode, so the mode that turns the sandbox off
		// must not turn Read into a filesystem browser.
		const cwd = workspace();
		const outside = join(cwd, "..", `lbb-outside-${Date.now()}.txt`);
		writeFileSync(outside, "not yours");
		const tool = createReadTool(cwd, defaultOperations());

		for (const sandbox of ["workspace-write", "danger-full-access"] as const) {
			const result = await tool.call({ file_path: outside }, CTX(sandbox));
			expect(result.isError).toBe(true);
			expect((result.content[0] as { text: string }).text).toContain("outside workspace");
		}
	});

	test("the control: a root the caller named is still readable outside the workspace", async () => {
		// If the test above were passing because Read refused everything, this
		// would be the one that notices. It differs only in the root list.
		const spill = mkdtempSync(join(tmpdir(), "lbb-spill-"));
		const file = join(spill, "Bash-call_1.txt");
		writeFileSync(file, "spilled output");
		const cwd = workspace();
		const tool = createReadTool(cwd, defaultOperations(), [spill]);
		const result = await tool.call({ file_path: file }, CTX("workspace-write"));
		expect(result.isError).toBeFalsy();
		expect((result.content[0] as { text: string }).text).toContain("spilled output");
	});

	test("a .git below the workspace is refused, and an ordinary file beside it is not", async () => {
		// The measured gap this layer closes: before it, `agent` mode let
		// `rm .git/config` through Bash as `allow`, because the tool-layer guard
		// never saw a shell command. Here the same path is refused by a value,
		// and the neighbouring file is not — so the assertion is about the
		// decision, not about a blanket refusal.
		const cwd = workspace();
		mkdirSync(join(cwd, "sub", ".git"), { recursive: true });
		const built = await workspacePolicy(cwd, { sandbox: "workspace-write" });

		expect(built.protected.some((p) => p.includes("/sub/.git"))).toBe(true);
		expect(decideWrite(built, join(cwd, "sub", ".git", "config"), cwd).allowed).toBe(false);
		expect(decideWrite(built, join(cwd, "sub", "notes.md"), cwd).allowed).toBe(true);
	});

	/**
	 * The two-step hole, on any platform and without bubblewrap.
	 *
	 * `sandbox-bwrap-smoke.test.ts` has the row that measures this on a real `bwrap`,
	 * and it needs one: the rename and the write are two `spawnSync` calls, so the
	 * second re-derives its mounts from the list the first produced. That is the
	 * shape of the bug and it is worth having measured against a kernel — but it
	 * only runs where `bwrap` is installed, so on a machine without it the row
	 * **skips** and the defect is unguarded. This is the property underneath it,
	 * stated so it can be checked anywhere: after the directory holding a `.git`
	 * moves, the list names where the `.git` **is**.
	 *
	 * **The assertion is on the second list naming the new location, and that is
	 * the whole test.** Asserting only that the workspace's own `.git` is still
	 * protected would pass against the broken code — `protectedFor` derives that
	 * one unconditionally, so it is present whether or not the scan is cached. It
	 * is asserted below anyway, in both directions, because a re-derivation that
	 * returned the right *new* root while losing `.git` entirely would be a second
	 * bug wearing the first one's clothes.
	 */
	test("a renamed repository is protected at its new location, not the one it left", async () => {
		const cwd = workspace();
		mkdirSync(join(cwd, ".git"), { recursive: true });
		mkdirSync(join(cwd, "sub", ".git"), { recursive: true });
		writeFileSync(join(cwd, "sub", ".git", "HEAD"), "ref: refs/heads/main\n");

		const before = await workspacePolicy(cwd, { sandbox: "workspace-write" });
		expect(before.protected.some((p) => p.endsWith("/sub/.git"))).toBe(true);

		// Step one. A Bash command moving the directory, with no sandbox involved:
		// this test is about what the *next* call derives, and a rename the sandbox
		// refused would prove nothing about re-derivation.
		const relocated = join(cwd, "relocated");
		renameSync(join(cwd, "sub"), relocated);

		// Step two. A later call — a later Bash command, which is a separate spawn.
		const after = await workspacePolicy(cwd, { sandbox: "workspace-write" });

		// The stale entry is gone *and* the new one is present. Checking only the
		// second would also pass against a cache that merely appended, and the
		// first is the half that says the list was re-derived rather than extended.
		expect(after.protected.some((p) => p.endsWith("/sub/.git"))).toBe(false);
		expect(after.protected.some((p) => p.endsWith("/relocated/.git"))).toBe(true);

		// The decision, not just the string: this is what a Bash command consults.
		expect(decideWrite(after, join(relocated, ".git", "config"), cwd).allowed).toBe(false);
		// The workspace's own `.git` survives the whole sequence — see the doc comment
		// for why this is asserted rather than assumed.
		expect(after.protected.some((p) => p.endsWith("/.git"))).toBe(true);
		expect(decideWrite(after, join(cwd, ".git", "config"), cwd).allowed).toBe(false);
		// And the control: a policy that refused everything would pass all of the
		// above, so an ordinary file beside the relocated repository must still write.
		expect(decideWrite(after, join(relocated, "notes.md"), cwd).allowed).toBe(true);
	});

	test("a narrower entry nested inside a wider one wins, whichever direction", async () => {
		// The ordering inside `decideWrite` and `decideRead`, at the level it is
		// written. An allow that runs before the narrower refusal does not merely
		// answer first, it answers *instead* — the read-only entry is never read.
		// Both directions are here because the same mistake in each is invisible
		// from the other: fixing only the write order leaves a `deny` nested inside
		// a readable root shadowed.
		const cwd = workspace();
		const nested = mkdtempSync(join(tmpdir(), "lbb-nested-"));
		const built = buildSandboxPolicy({
			sandbox: "workspace-write",
			workspace: cwd,
			readOnlyRoots: [nested],
		});

		// A read-only root outside the workspace: not writable.
		expect(decideWrite(built, join(nested, "f.txt"), cwd).allowed).toBe(false);

		// The same root with a `deny` nested inside a readable one, which is the
		// shape the read path has to get right.
		const withDeny: typeof built = {
			...built,
			fileSystem: {
				...built.fileSystem,
				entries: [...built.fileSystem.entries, { path: join(nested, "secrets"), access: "deny" }],
			},
		};
		expect(decideRead(withDeny, join(nested, "secrets", "k.txt"), cwd).allowed).toBe(false);
		// And a sibling that is only refused by the deny, not by its parent.
		expect(decideRead(withDeny, join(nested, "ok.txt"), cwd).allowed).toBe(true);
	});

	test("a denied decision always carries a reason naming the path", async () => {
		// A deny the model cannot act on is indistinguishable from a bug, and the
		// model is the reader.
		const cwd = workspace();
		const built = await workspacePolicy(cwd, { sandbox: "workspace-write" });
		const outside = join(cwd, "..", "elsewhere.txt");
		const decision = decideWrite(built, outside, cwd);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) throw new Error("unreachable");
		expect(decision.reason.length).toBeGreaterThan(0);
		expect(decision.reason).toContain("elsewhere.txt");
	});
});

describe("what the user is told", () => {
	test("each backend gets its own sentence, and none of them claims a confinement it does not have", () => {
		const native = describeSandboxBackend("native", "workspace-write", "darwin");
		const unavailable = describeSandboxBackend("unavailable", "workspace-write", "linux");
		const simulated = describeSandboxBackend("simulated", "workspace-write", "win32");
		const appcontainer = describeSandboxBackend("appcontainer", "workspace-write", "win32");
		const unreported = describeSandboxBackend(undefined, "workspace-write", "win32");

		// The sentence a user forms their model from. What is asserted here is
		// that each one says the thing that is true of it: only the native one
		// claims the OS is doing the confining, and the unreported case is never
		// allowed to render as the good news.
		expect(native).toContain("enforced by the OS");
		expect(unavailable).toContain("not enforced");
		expect(unavailable).toContain("bwrap");
		expect(simulated).toContain("not OS-enforced");
		expect(unreported).toBe(simulated);
		// The container sentence, and the half of it that matters most: it is a
		// real confinement, so it says "enforced by the OS" like the native one —
		// and it must NOT borrow the native sentence's version-control promise.
		// The deny ACE is out (the timing anomaly in `appcontainer.ts`), so a
		// confined command can write .git inside its grant. A sentence that
		// repeated the native claim here would tell a user the one thing this
		// backend demonstrably does not do, so the absence is asserted rather
		// than left to a reader of the string.
		expect(appcontainer).toContain("enforced by the OS");
		expect(appcontainer).toContain("AppContainer profile derived from this workspace");
		expect(appcontainer).toContain("Version-control metadata is not protected by this backend");
		// The restricted-axis gap is stated too, because the reader this sentence
		// reaches cannot be handed the axis: a `restricted` command is never
		// confined here (the proxy is on loopback, which the container child
		// cannot reach, measured), and someone told "enforced by the OS" would
		// rely on a confinement they do not have.
		expect(appcontainer).toContain("restricted network axis is not confined");
		// And it must not name a wrapper program: the confinement is the child's
		// own token, not an argv in front of the shell.
		expect(appcontainer).not.toContain("sandbox-exec");
		expect(appcontainer).not.toContain("bwrap");
		// The negative half, which is the half that matters. A positive assertion
		// only proves the right words are present somewhere in the string; these
		// prove the claim that must not be. A simulated layer that renders as
		// "enforced by the OS" is the exact failure this sentence exists to
		// prevent, and it is invisible to a `toContain`.
		expect(unavailable).not.toContain("enforced by the OS");
		expect(simulated).not.toContain("enforced by the OS");
		expect(unreported).not.toContain("enforced by the OS");
	});

	test("danger-full-access says off, whatever backend is underneath it", () => {
		// Asked first on purpose: on a Mac with `sandbox-exec` right there, an
		// unrestricted policy still wraps nothing, so "native" must never be
		// allowed to imply confinement on its own.
		for (const backend of ["native", "simulated", "unavailable", "appcontainer"] as const) {
			const sentence = describeSandboxBackend(backend, "danger-full-access", "darwin");
			expect(sentence).toContain("Sandbox: off");
			expect(sentence).not.toContain("enforced by the OS");
		}
	});

	test("the backend follows the platform, and a platform with no backend is never native", () => {
		expect(sandboxBackendFor("darwin", true)).toBe("native");
		expect(sandboxBackendFor("linux", true)).toBe("native");
		// The case that decides whether a user is told a lie: a backend for this
		// platform that is not installed.
		expect(sandboxBackendFor("linux", false)).toBe("unavailable");
		// And the case that is not a tuning question at all.
		expect(sandboxBackendFor("win32", true)).toBe("simulated");
		expect(sandboxBackendFor("win32", false)).toBe("simulated");
		// The fourth answer, and it is win32's own: the AppContainer backend is
		// a pair of DLL loads rather than a program on PATH, so `hasNativeBackend`
		// is not what decides it — the deliberate claim in the runtime is, and
		// the default is the safe direction (no claim reads as `simulated`, the
		// status quo, while a wrong claim would tell a user the kernel holds a
		// boundary it does not). The flag changes nothing off win32: there is no
		// fourth answer for a platform whose backend is a wrapper.
		expect(sandboxBackendFor("win32", false, true)).toBe("appcontainer");
		expect(sandboxBackendFor("win32", true, true)).toBe("appcontainer");
		expect(sandboxBackendFor("darwin", true, true)).toBe("native");
		expect(sandboxBackendFor("darwin", false, true)).toBe("unavailable");
		expect(sandboxBackendFor("linux", false, true)).toBe("unavailable");
	});

	test("the executor reports the backend its own runtime implies, not the host's", () => {
		expect(new ChildProcessExecOperations(FAKE_LINUX).sandboxBackend).toBe("native");
		expect(new ChildProcessExecOperations({ platform: "linux", hasNativeBackend: false }).sandboxBackend).toBe(
			"unavailable",
		);
		expect(new ChildProcessExecOperations({ platform: "win32", hasNativeBackend: true }).sandboxBackend).toBe(
			"simulated",
		);
		// The container claim, and the sentence follows it: the report and the
		// branch the argv comes from are answers to one question, so the runtime
		// that would confine the spawn is the runtime that says so. The control
		// beside it is production's actual shape — `detectRuntime` does not claim
		// the backend, so what `/permissions` prints on this machine is still the
		// simulated sentence, and the README's warning stays true.
		expect(
			new ChildProcessExecOperations({
				platform: "win32",
				hasNativeBackend: false,
				hasAppContainer: true,
			}).sandboxBackend,
		).toBe("appcontainer");
		expect(
			new ChildProcessExecOperations({
				platform: "win32",
				hasNativeBackend: false,
			}).sandboxBackend,
		).toBe("simulated");
	});

	test("the app's own executor reports its backend, rather than nothing", () => {
		// `/permissions` reads `ops.sandboxBackend`, and `defaultOperations()` is
		// what the app builds. When this dropped the executor's answer, that read
		// got `undefined`, and the resolver turns an unreported backend into
		// "simulated" — so every machine was told its commands were not
		// OS-enforced, including the Mac with `sandbox-exec` sitting right there.
		// The bug is invisible from the other side: nothing errors, and the
		// sentence it produces is the pessimistic one.
		const ops = defaultOperations(new ChildProcessExecOperations(FAKE_LINUX));
		expect(ops.sandboxBackend).toBe("native");
		expect(describeSandboxBackend(ops.sandboxBackend, "workspace-write", "linux")).toContain("enforced by the OS");
		// The control: the same call on a machine with no backend must not be
		// rescued by the fix above into claiming confinement.
		const unavailable = defaultOperations(
			new ChildProcessExecOperations({ platform: "linux", hasNativeBackend: false }),
		);
		expect(unavailable.sandboxBackend).toBe("unavailable");
		expect(describeSandboxBackend(unavailable.sandboxBackend, "workspace-write", "linux")).not.toContain(
			"enforced by the OS",
		);
	});
});

describe("the network axis does not smuggle a wrapper around an unrestricted filesystem", () => {
	// Both translators carry a branch for "unconfined filesystem, restricted
	// network" that still wraps, and this pins the short-circuit that keeps it
	// unreachable. The tempting change is to delete the short-circuit so the
	// network axis looks like it is held at the kernel in both modes — and on
	// Linux that silently breaks the network instead of confining it, because
	// `--unshare-net` puts the command in a namespace where the proxy on
	// `127.0.0.1` is unreachable and allowed domains fail alongside denied ones.
	// A build that reaches that branch can only do so because it pairs
	// `--unshare-net` with a TCP→UDS→TCP bridge; this build has no bridge, so
	// "wrap anyway" would enforce the axis by breaking the network.
	test.each(["darwin", "linux"] as const)(
		"an unrestricted filesystem wraps nothing on %s, whatever the network",
		(platform) => {
			const restricted: NetworkAxis = {
				access: "restricted",
				domains: [{ pattern: "registry.npmjs.org", permission: "allow" }],
			};
			for (const network of [restricted, { access: "enabled" as const, domains: [] }]) {
				const resolution = resolveSandboxExecution({
					policy: policyFor({ sandbox: "danger-full-access", workspace: workspace(), network }),
					command: ["/bin/bash", "-c", "true"],
					platform,
					hasNativeBackend: true,
				});
				expect(resolution.kind).toBe("unconfined");
			}
		},
	);

	test("a confined filesystem with a restricted network does unshare the network", () => {
		// The control, and the reason the short-circuit is a decision rather than a
		// shrug: the *other* side of the same branch does confine the network at
		// the kernel, so the asymmetry `networkConfinement` reports is real and this
		// is what keeps it from being an excuse. Without this, the test above
		// would also pass if the whole restricted-network path had stopped working.
		const resolution = resolveSandboxExecution({
			policy: policyFor({
				sandbox: "workspace-write",
				workspace: workspace(),
				network: { access: "restricted", domains: [{ pattern: "registry.npmjs.org", permission: "allow" }] },
			}),
			command: ["/bin/bash", "-c", "true"],
			platform: "linux",
			hasNativeBackend: true,
			exists: () => true,
		});
		expect(resolution.kind).toBe("native");
		if (resolution.kind !== "native") return;
		expect(resolution.execution.argv).toContain("--unshare-net");
		// And the network is *not* unshared when it is open, or an allowed request
		// could never get out — the same reason this build does not pair the two.
		const open = resolveSandboxExecution({
			policy: policyFor({
				sandbox: "workspace-write",
				workspace: workspace(),
				network: { access: "enabled", domains: [] },
			}),
			command: ["/bin/bash", "-c", "true"],
			platform: "linux",
			hasNativeBackend: true,
			exists: () => true,
		});
		expect(open.kind).toBe("native");
		if (open.kind !== "native") return;
		expect(open.execution.argv).not.toContain("--unshare-net");
	});
});

describe("the Windows AppContainer branch, selected by the resolver", () => {
	// The fifth outcome, and the only one that is not an argv decision. It is
	// testable on every machine because every input is injected: `platform`,
	// the backend-availability flag, and `exists`. What each test below pins is
	// one condition of the branch or one property of what it returns — the
	// workspace it derives the container from, and the list of roots the caller
	// must grant before the spawn.
	const confined = (cwd: string, network: NetworkAxis, writableRoots?: string[]) =>
		policyFor({ sandbox: "workspace-write", workspace: cwd, network, writableRoots });

	const win32 = {
		command: ["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "true"],
		platform: "win32" as const,
		hasAppContainer: true,
		exists: () => true,
	};

	test("an open network with a usable backend resolves to the container, naming the workspace", () => {
		const cwd = workspace();
		const resolution = resolveSandboxExecution({ ...win32, policy: confined(cwd, { access: "enabled", domains: [] }) });
		expect(resolution.kind).toBe("appcontainer");
		if (resolution.kind !== "appcontainer") return;
		// The profile — the identity, and the refcount that decides when a grant
		// is released — is derived from this path, so it is the workspace and
		// nothing else.
		expect(resolution.workspace).toBe(canonical(cwd));
		expect(resolution.network).toBe(true);
		// Fifty characters and lowercase is the shape `userenv` accepts, and it
		// is `appcontainer.ts` that enforces it — here the point is only that the
		// resolution carried a real path, not the empty string.
		expect(resolution.workspace.length).toBeGreaterThan(0);
	});

	test("the grant list is every writable root, the workspace first and each path once", () => {
		// More than the workspace is writable in every real session — the temp
		// directory and the package caches arrive beside it — and a container
		// granted only the workspace cannot `mktemp`. The workspace leads because
		// the identity is derived from it; the rest follow in policy order.
		const cwd = workspace();
		const cache = mkdtempSync(join(tmpdir(), "lbb-ac-cache-"));
		const resolution = resolveSandboxExecution({
			...win32,
			policy: confined(cwd, { access: "enabled", domains: [] }, [cache, cwd]),
		});
		expect(resolution.kind).toBe("appcontainer");
		if (resolution.kind !== "appcontainer") return;
		// `cwd` appears twice in the policy's entries — once as the workspace
		// and once as a writable root that names itself — and is granted once.
		expect(resolution.grantRoots).toEqual([canonical(cwd), canonical(cache)]);
	});

	test("a skip-marked root that does not exist is dropped from the grant list", () => {
		// The same rule the translators follow, for a reason that is stronger
		// here: granting a path that is not there fails the grant outright, so
		// keeping it would turn a confined command into a command that does not
		// run at all — a narrower sandbox becoming a broken tool.
		const cwd = workspace();
		const absent = join(tmpdir(), "lbb-ac-never-created");
		const present = mkdtempSync(join(tmpdir(), "lbb-ac-present-"));
		const resolution = resolveSandboxExecution({
			...win32,
			exists: (path) => path !== canonical(absent),
			policy: confined(cwd, { access: "enabled", domains: [] }, [absent, present]),
		});
		expect(resolution.kind).toBe("appcontainer");
		if (resolution.kind !== "appcontainer") return;
		expect(resolution.grantRoots).toEqual([canonical(cwd), canonical(present)]);
		// And the workspace itself survives the same filter even when it is not
		// there — it is the one entry never marked `skip`.
		const gone = resolveSandboxExecution({
			...win32,
			exists: () => false,
			policy: confined(cwd, { access: "enabled", domains: [] }, [present]),
		});
		expect(gone.kind).toBe("appcontainer");
		if (gone.kind !== "appcontainer") return;
		expect(gone.grantRoots).toEqual([canonical(cwd)]);
	});

	test("read-only roots stay out of the grant list", () => {
		// A grant there buys nothing: a container child reads outside its grant
		// by default and only writes are refused. Asserting the absence is what
		// stops a later "grant everything the policy mentions" change from
		// passing silently.
		const cwd = workspace();
		const readable = mkdtempSync(join(tmpdir(), "lbb-ac-readable-"));
		const resolution = resolveSandboxExecution({
			...win32,
			policy: policyFor({
				sandbox: "workspace-write",
				workspace: cwd,
				network: { access: "enabled", domains: [] },
				readOnlyRoots: [readable],
			}),
		});
		expect(resolution.kind).toBe("appcontainer");
		if (resolution.kind !== "appcontainer") return;
		expect(resolution.grantRoots).toEqual([canonical(cwd)]);
	});

	test("a restricted network keeps the simulated answer, backend or none", () => {
		// The measured reason, and it is the one that is easy to get wrong: the
		// proxy that enforces the axis listens on loopback, and a container child
		// cannot reach it — so confining a restricted command would enforce the
		// axis by breaking the network, every allowed domain failing alongside
		// every denied one. `simulated` is where the tool layer and the proxy
		// still hold the axis, which is an honest answer rather than a broken
		// one.
		const restricted: NetworkAxis = {
			access: "restricted",
			domains: [{ pattern: "registry.npmjs.org", permission: "allow" }],
		};
		const resolution = resolveSandboxExecution({ ...win32, policy: confined(workspace(), restricted) });
		expect(resolution.kind).toBe("simulated");
	});

	test("without the availability flag the answer is the simulated one it has always been", () => {
		// The default direction, and the safe one: a wrong `true` sends a
		// command down a container path whose profile and grant were never
		// established, while a wrong `false` costs the answer this platform
		// already gives. No production caller passes the flag yet.
		const { hasAppContainer: _ignored, ...withoutFlag } = win32;
		const resolution = resolveSandboxExecution({
			...withoutFlag,
			policy: confined(workspace(), { access: "enabled", domains: [] }),
		});
		expect(resolution.kind).toBe("simulated");
	});

	test("danger-full-access wraps nothing, whatever the platform claims", () => {
		// The unrestricted short-circuit runs before the branch, and it has to:
		// an unrestricted filesystem with a container around it is confinement
		// the user asked not to have.
		const resolution = resolveSandboxExecution({
			...win32,
			policy: policyFor({
				sandbox: "danger-full-access",
				workspace: workspace(),
				network: { access: "enabled", domains: [] },
			}),
		});
		expect(resolution.kind).toBe("unconfined");
	});

	test("a policy whose only roots are all skip-marked never reaches the branch", () => {
		// A hand-built policy can name roots without naming a workspace. The
		// branch refuses rather than picking an arbitrary root as the identity —
		// an identity per root would be an identity per command, and the
		// refcount that releases a grant would have nothing stable to hang on.
		const cache = mkdtempSync(join(tmpdir(), "lbb-ac-skiponly-"));
		const policy: SandboxPolicy = {
			fileSystem: {
				kind: "restricted",
				entries: [{ path: canonical(cache), access: "write", missingPathBehavior: "skip" }],
			},
			network: "enabled",
			networkRules: [],
			protected: [],
		};
		const resolution = resolveSandboxExecution({ ...win32, policy });
		expect(resolution.kind).toBe("simulated");
	});

	test.each(["darwin", "linux"] as const)("the branch never fires on %s, whatever the flag says", (platform) => {
		// The condition is the platform itself — `AppContainer` is `userenv.dll`
		// and nothing else reaches it — so a claim of availability must not be
		// able to move a Mac onto the Windows backend.
		const resolution = resolveSandboxExecution({
			...win32,
			platform,
			hasNativeBackend: true,
			policy: confined(workspace(), { access: "enabled", domains: [] }),
		});
		expect(resolution.kind).toBe("native");
	});
});

const describeWindowsExec = process.platform === "win32" ? describe : describe.skip;

describeWindowsExec("the container path reaches a real spawn", () => {
	// The wiring half, against the machine it describes. The decision tests
	// above pin what the resolver says; this pins that a `ChildProcessExecOperations`
	// built with the container runtime actually ends up with a confined child —
	// the claim is not "the resolver returned a kind" but "a command ran under a
	// token that refuses a write outside its grant".
	//
	// The injection is the same one the Linux branch uses, aimed at the fifth
	// outcome: `hasAppContainer: true` on a machine whose `detectRuntime`
	// already answers that is redundant, and it is written out anyway so the
	// runtime under test is legible rather than inherited.
	//
	// **The policy here is `workspace-write`, not the file's usual
	// `netPolicy`.** That helper builds a `danger-full-access` policy on
	// purpose — the filesystem wrapper is what it must not build, so the
	// network tests can run without bwrap — and an unrestricted policy
	// short-circuits the resolver to `unconfined` before the container branch
	// is ever consulted. Using it here would have tested the plain spawn path
	// while believing it tested the container: the inside write would pass and
	// the outside write would be refused by nothing at all.
	const CONTAINER_RUNTIME: SandboxRuntime = { platform: "win32", hasNativeBackend: false, hasAppContainer: true };

	function containerPolicy(cwd: string): SandboxPolicy {
		return buildSandboxPolicy({
			sandbox: "workspace-write",
			workspace: cwd,
			network: "enabled",
			networkRules: [],
		});
	}

	/**
	 * A shell this test supplies rather than the machine's — `cmd.exe`, which
	 * `confinedProgramName` resolves to System32 and a container child can
	 * execute. Without the injection these tests measured the host's Git
	 * layout: on the GitHub Windows runner `detectShell` answers with
	 * `C:\Program Files\Git\bin\bash.exe`, which starts inside the container
	 * and dies at DLL initialization with 0xC0000142, so every spawn below was
	 * red there while the same assertions passed on a machine with no
	 * conventional Git install. The refusal test right after uses the Program
	 * Files path deliberately.
	 */
	const CONTAINER_SHELL = { command: "cmd.exe", args: (cmd: string) => ["/d", "/s", "/c", cmd] };

	test("a command runs inside the container and comes back with its output and exit code", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(CONTAINER_RUNTIME, CONTAINER_SHELL);
		try {
			const result = await exec.exec({ command: "echo confined-hello", cwd, sandbox: containerPolicy(cwd) });
			expect(result.exitCode).toBe(0);
			expect(result.killed).toBe(false);
			expect(result.stdout).toContain("confined-hello");
		} finally {
			void exec.close?.();
		}
	});

	test("the grant lets the child write the workspace and the kernel refuses everything beyond it", async () => {
		// The claim this whole backend exists for. The inside write is the
		// usability half — an un-granted child cannot even read the workspace, so
		// this passing is also evidence the grant was acquired — and the outside
		// write is the confinement half: "Access is denied" is the kernel, not
		// this process's opinion.
		const cwd = workspace();
		const outside = `C:\\Windows\\Temp\\lbb-ac-wire-out-${process.pid}.txt`;
		const exec = new ChildProcessExecOperations(CONTAINER_RUNTIME, CONTAINER_SHELL);
		try {
			const inside = await exec.exec({
				command: `echo written > "${cwd.replace(/\//g, "\\")}\\inside.txt"`,
				cwd,
				sandbox: containerPolicy(cwd),
			});
			expect(inside.exitCode).toBe(0);
			expect(existsSync(join(cwd, "inside.txt"))).toBe(true);

			const escaped = await exec.exec({
				command: `echo pwned > "${outside}"`,
				cwd,
				sandbox: containerPolicy(cwd),
			});
			expect(escaped.exitCode).not.toBe(0);
			expect(existsSync(outside)).toBe(false);
		} finally {
			void exec.close?.();
		}
	});

	test("a command that outlives its timeout is killed rather than handed off", async () => {
		// The divergence from the spawn path, measured so it stays true: the
		// confined runner owns a raw process handle, so there is no
		// `ChildProcess` to hand `onTimeout` and a timeout kills.
		//
		// The command is a `powershell Start-Sleep`, and that shape is
		// measured rather than assumed. The two obvious sleepers are both dead
		// on arrival inside the container: `timeout /t N` refuses to run at all
		// when its stdin is redirected — the confined child's stdin is a pipe at
		// EOF — and exits 1 in ~130ms; `ping -n N 127.0.0.1` needs a network the
		// container does not have (no IP driver) and exits in 40–100ms. A
		// sleeper that dies before the deadline cannot test a kill. Powershell
		// lives in System32, reads no stdin, and touches no socket.
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(CONTAINER_RUNTIME, CONTAINER_SHELL);
		try {
			const result = await exec.exec({
				command: "powershell -NoProfile -Command Start-Sleep -Seconds 30",
				cwd,
				sandbox: containerPolicy(cwd),
				timeoutMs: 600,
			});
			expect(result.killed).toBe(true);
			expect(result.exitCode).not.toBe(0);
		} finally {
			void exec.close?.();
		}
	});

	test("an already-aborted signal kills the child before it can run", async () => {
		// The one abort case this build can honour: the signal is checked
		// between polls, so a signal that fired before the run began is seen on
		// the first poll. A mid-run abort is not — the runner is synchronous FFI
		// and the event loop cannot deliver the listener while it blocks — and
		// that limit is documented on the branch rather than tested here,
		// because measuring it would mean freezing this test's own loop.
		//
		// The command is the powershell sleeper for the measured reason given on
		// the timeout test above: a command that exits on its own before the
		// first poll (25ms) makes `waited === 0` win the race and reports
		// `killed: false` — which is exactly what `ping -n 30` did here for three
		// runs, because the container has no IP driver. Powershell starts slowly
		// enough that the first poll still finds it alive.
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(CONTAINER_RUNTIME, CONTAINER_SHELL);
		try {
			const controller = new AbortController();
			controller.abort();
			const result = await exec.exec({
				command: "powershell -NoProfile -Command Start-Sleep -Seconds 30",
				cwd,
				sandbox: containerPolicy(cwd),
				signal: controller.signal,
			});
			expect(result.killed).toBe(true);
		} finally {
			void exec.close?.();
		}
	});

	test("streaming reaches the caller while the command runs, not in one dump after", async () => {
		// The preview half of the contract, and it is the one a synchronous
		// runner could plausibly have broken: `onOutput` is called from inside
		// the pump loop, so chunks arrive as the child writes them.
		//
		// The two writes are one powershell command with a sleep between them
		// (measured: 378ms and 1404ms), for the same reason the timeout test
		// needs a real sleeper — `ping -n 5 127.0.0.1` inside the container exits
		// in milliseconds with "Unable to contact IP driver", so both echoes
		// land in one chunk and the assertion below passes for the wrong
		// reason. The two `Write-Host`s are separated by a `Start-Sleep` the
		// kernel-level pipe keeps apart.
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(CONTAINER_RUNTIME, CONTAINER_SHELL);
		try {
			const chunks: string[] = [];
			await exec.exec({
				command:
					"powershell -NoProfile -Command Write-Host streaming-one; Start-Sleep -Seconds 1; Write-Host streaming-two",
				cwd,
				sandbox: containerPolicy(cwd),
				onOutput: (chunk) => chunks.push(chunk),
				timeoutMs: 20_000,
			});
			// The chunk contents ride in the failure message, because a count
			// alone cannot say which shape broke: this test failed once on a
			// runner that produced a single chunk in 265ms — faster than the
			// sleep the command was meant to straddle — and "the command was
			// truncated after the first echo" versus "both writes arrived in
			// one pipe batch" is visible only in the text. Evaluated only on
			// failure, so a passing run prints nothing.
			expect(
				chunks.length,
				`chunks were ${chunks.map((c) => JSON.stringify(c.slice(0, 60))).join(" | ")}`,
			).toBeGreaterThan(1);
			expect(chunks.join("")).toContain("streaming-one");
			expect(chunks.join("")).toContain("streaming-two");
		} finally {
			void exec.close?.();
		}
	});

	test("a shell the container cannot execute refuses the command, with the reason in stderr", async () => {
		// The refusal that replaced four opaque CI failures. A session whose
		// shell resolves to `C:\Program Files\Git\bin\bash.exe` — which
		// `detectShell` prefers on any machine with Git for Windows installed
		// conventionally, the GitHub Windows runner included — hands the
		// container branch a program in neither System32 nor a granted root.
		// Spawned, it starts and dies at DLL initialization with 0xC0000142,
		// a number that reads as "the command ran and failed" when the truth is
		// "the backend could not start the shell". The refusal names the
		// program and the two sets it is not in, and fails closed — falling
		// through to the unconfined spawn would run the command the user asked
		// to confine.
		const cwd = workspace();
		const gitBash = { command: "C:\\Program Files\\Git\\bin\\bash.exe", args: (cmd: string) => ["-lc", cmd] };
		const exec = new ChildProcessExecOperations(CONTAINER_RUNTIME, gitBash);
		try {
			const result = await exec.exec({ command: "echo unreachable", cwd, sandbox: containerPolicy(cwd) });
			expect(result.exitCode).toBe(-1);
			expect(result.killed).toBe(false);
			expect(result.stderr).toContain("C:\\Program Files\\Git\\bin\\bash.exe");
			expect(result.stderr).toContain("System32");
			// And nothing ran: the refusal is before the spawn, so no child
			// existed to produce output.
			expect(result.stdout).toBe("");
		} finally {
			void exec.close?.();
		}
	});

	test("run_in_background under the same policy refuses, rather than falling through to a bare spawn", async () => {
		// The escape hatch `bash.ts` named when it threaded the policy into the
		// background manager: with the container in force, starting a background
		// shell must not run the shell with nothing around it. Refusing is the
		// honest option available here — the confined runner waits for the child
		// to exit, and a background shell's whole point is a child that outlives
		// the call.
		const cwd = workspace();
		const manager = new BackgroundShellManager(CONTAINER_RUNTIME);
		const policy = containerPolicy(cwd);
		let caught: unknown;
		try {
			await manager.start("echo backgrounded", cwd, policy);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect(String(caught)).toContain("run_in_background");
	});
});

describe("a path the policy names but the disk does not have", () => {
	// Not cosmetic on the Linux side. `bwrap` refuses to start when a `--bind`
	// source is absent, so a policy naming a build cache that was never created
	// becomes a shell that does not run at all — a *narrower* sandbox silently
	// becoming a broken tool, on the machine least able to see why. This test is
	// about the argv that reaches the program, not about the decision function
	// that built the policy.
	function argvFor(policy: SandboxPolicy, present: string[]): string[] {
		const resolution = resolveSandboxExecution({
			policy,
			command: ["/bin/sh", "-lc", "true"],
			platform: "linux",
			hasNativeBackend: true,
			exists: (path) => present.includes(path),
		});
		expect(resolution.kind).toBe("native");
		return resolution.kind === "native" ? resolution.execution.argv : [];
	}

	test("a skip-marked root that is absent is dropped, and a present one is kept", () => {
		const cwd = workspace();
		const present = mkdtempSync(join(tmpdir(), "lbb-sandbox-present-"));
		const absent = join(tmpdir(), "lbb-sandbox-never-created");
		// Writable roots, not read-only ones: a `read` entry never becomes a
		// `--bind`, because the bwrap profile already mounts `/` read-only. Asserting
		// on a `read` root would pass for a reason that has nothing to do with the
		// filter, which is the kind of test that quietly stops testing the thing.
		const built = buildSandboxPolicy({ sandbox: "workspace-write", workspace: cwd, writableRoots: [present, absent] });

		const argv = argvFor(built, [canonical(present)]);
		expect(argv).toContain(canonical(present));
		expect(argv).not.toContain(canonical(absent));
		// The workspace itself is never marked skip, so it survives the filter
		// even though `exists` was told it is not there either.
		expect(argv).toContain(canonical(cwd));
	});

	test("the workspace is kept even when it is absent, because a missing one is a broken session", () => {
		// Dropping it would confine the session to nothing and report success,
		// which is strictly worse than the spawn error it replaces.
		const ghost = join(tmpdir(), "lbb-sandbox-no-workspace");
		const built = buildSandboxPolicy({ sandbox: "workspace-write", workspace: ghost });
		const argv = argvFor(built, []);
		expect(argv).toContain(canonical(ghost));
	});

	test("an unrestricted policy wraps nothing, so the filter never runs", () => {
		const cwd = workspace();
		const resolution = resolveSandboxExecution({
			policy: buildSandboxPolicy({ sandbox: "danger-full-access", workspace: cwd }),
			command: ["/bin/sh", "-lc", "true"],
			platform: "linux",
			hasNativeBackend: true,
		});
		expect(resolution.kind).toBe("unconfined");
	});

	test("but a protected path that is absent is not filtered out — it is mounted empty", () => {
		// The two halves of this describe pull in opposite directions and the whole
		// file depends on them not cancelling: an absent *entry* marked `skip` is
		// dropped, and an absent *protected* path is not, because dropping the second
		// is the one answer that removes the protection it is there to provide.
		//
		// This one deliberately does **not** use `argvFor`, so nothing about the disk
		// is stubbed: `resolveSandboxExecution` falls back to the real `existsSync`,
		// which is the production path, and a `mkdtemp` directory genuinely has no
		// `.git`. The claim under test is that the two answers differ on the disk the
		// command will actually run against, and a stubbed predicate could only ever
		// prove they differ on a table.
		const cwd = mkdtempSync(join(tmpdir(), "lbb-sandbox-no-git-"));
		const argv = realDiskArgv(buildSandboxPolicy({ sandbox: "workspace-write", workspace: cwd }));

		expect(existsSync(join(cwd, ".git"))).toBe(false);
		expect(tmpfsTargetOf(argv)).toBe(canonical(join(cwd, ".git")));
		expect(roBindTargetOf(argv, join(cwd, ".git"))).toBeNull();
	});

	test("and the same workspace with a real `.git` gets the bind, not the empty mount", () => {
		// The control, without which the test above would also pass if *every*
		// protected path had become a tmpfs — that is, if the protection had been
		// quietly deleted rather than made robust. Creating the directory is the only
		// way to make the two answers distinguishable, and it is safe because the
		// directory goes into a temp dir that is removed with it.
		const cwd = mkdtempSync(join(tmpdir(), "lbb-sandbox-with-git-"));
		mkdirSync(join(cwd, ".git"));
		try {
			const argv = realDiskArgv(buildSandboxPolicy({ sandbox: "workspace-write", workspace: cwd }));

			expect(roBindTargetOf(argv, canonical(join(cwd, ".git")))).toBe(canonical(join(cwd, ".git")));
			expect(tmpfsTargetOf(argv)).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	/** The argv for `policy` with no `exists` seam, so the real disk decides. */
	function realDiskArgv(policy: SandboxPolicy): string[] {
		const resolution = resolveSandboxExecution({
			policy,
			command: ["/bin/sh", "-lc", "true"],
			platform: "linux",
			hasNativeBackend: true,
		});
		expect(resolution.kind).toBe("native");
		return resolution.kind === "native" ? resolution.execution.argv : [];
	}

	/**
	 * The single `--tmpfs` target, or `null`.
	 *
	 * Every "the other recipe was not used" assertion in this describe has to name
	 * the path rather than the flag, because `--ro-bind / /` is the read baseline and
	 * appears in every argv `buildBwrapArgs` produces. An assertion of the form
	 * `expect(argv).not.toContain("--ro-bind")` is therefore red against correct code
	 * — which is a test that fails for the right reason and the wrong one, and is
	 * worse than no assertion because the next person "fixes" the code.
	 */
	function tmpfsTargetOf(argv: string[]): string | null {
		const at = argv.indexOf("--tmpfs");
		return at < 0 ? null : argv[at + 1];
	}

	/** The target of the `--ro-bind` for `path`, or `null` if it has none. */
	function roBindTargetOf(argv: string[], path: string): string | null {
		for (let index = 0; index < argv.length; index++) {
			if (argv[index] === "--ro-bind" && argv[index + 1] === path && argv[index + 2] === path) return path;
		}
		return null;
	}
});

describe("isWritePermitted is directional, including on a policy the builder cannot produce", () => {
	// `buildSandboxPolicy` returns an unrestricted policy with an empty `protected`
	// list, so the combination below is unreachable through it. The type permits
	// it, the function's own doc says it "should not have a branch that silently
	// discards the narrower rule", and a caller building a policy by hand is not
	// hypothetical — which is exactly the kind of argument that is true until the
	// one line it defends is deleted. So it is asserted here, on the literal.
	test("protected paths are refused even when the policy says unrestricted", () => {
		const hand: SandboxPolicy = {
			fileSystem: { kind: "unrestricted", entries: [] },
			network: "enabled",
			networkRules: [],
			protected: ["/repo/.git"],
		};
		expect(isWritePermitted(hand, "/repo/.git/config")).toBe(false);
		expect(isWritePermitted(hand, "/repo/.git")).toBe(false);
		// And the control: the same policy still permits everything it is not told
		// to protect, or the function would be refusing rather than narrowing.
		expect(isWritePermitted(hand, "/repo/src/index.ts")).toBe(true);
	});

	test("a path outside every root is refused, not allowed", () => {
		const built = buildSandboxPolicy({ sandbox: "workspace-write", workspace: "/repo" });
		expect(isWritePermitted(built, "/elsewhere/file.txt")).toBe(false);
		expect(isWritePermitted(built, "/repo/src/index.ts")).toBe(true);
		// A prefix that is not a path boundary. `/repository` starts with the
		// string `/repo` and is a different directory.
		expect(isWritePermitted(built, "/repository/file.txt")).toBe(false);
	});
});

/**
 * Does the network axis reach the spawn?
 *
 * The same question the rest of this file asks about the filesystem half, and
 * with less room for doubt: a proxy that is started, correct, and never named
 * in the child's environment confines nothing, and nothing about that looks
 * like a failure. The command still runs and still prints what it printed
 * before. Both tests below drive a real `exec` and read the child's own view of
 * its environment.
 *
 * Found by the batch-4 falsification driver: two mutations — dropping the proxy
 * variables from the child environment, and reordering the merge so a caller's
 * own `HTTP_PROXY` wins — left every test in the repository green.
 */
describe("the network axis reaches the spawn", () => {
	/** What the spawned process actually saw, asked of the process itself. */
	function childEnvOf(exec: ChildProcessExecOperations, cwd: string, env?: Record<string, string>) {
		// `node` rather than `echo $VAR`: this file runs on Windows too, where the
		// shell is `cmd.exe` and `$HTTP_PROXY` is a literal string. A test that
		// only passed on a POSIX machine would report the wiring as working on the
		// platform where it is most often not.
		return exec
			.exec({
				command: "node -e \"process.stdout.write(process.env.HTTP_PROXY || '(none)')\"",
				cwd,
				sandbox: netPolicy(cwd, "restricted", [{ pattern: "registry.npmjs.org", permission: "allow" }]),
				env,
			})
			.then((result) => ({ exitCode: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr }));
	}

	test("a restricted session's child is pointed at the proxy this process started", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const result = await childEnvOf(exec, cwd);
			expect(result.exitCode).toBe(0);
			// Not "some URL" — the port belongs to a proxy this process is holding
			// open, and a child that got a URL with nothing listening on it would
			// pass a weaker version of this assertion and break every fetch.
			expect(result.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			expect(exec.networkProxyRunning).toBe(true);
		} finally {
			// The proxy holds a listening socket. Leaving it open would keep the
			// test process alive and the next test's port from being free.
			await exec.close();
		}
	});

	test("a caller's own HTTP_PROXY does not win over the policy", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const result = await childEnvOf(exec, cwd, { HTTP_PROXY: "http://192.0.2.1:9/" });
			expect(result.exitCode).toBe(0);
			// The merge order is the whole test. `HTTP_PROXY` is last on purpose:
			// a caller handing `exec` a proxy is a way around the policy, and the
			// session that owns the policy is the one that has to hold.
			expect(result.stdout).not.toContain("192.0.2.1");
			expect(result.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		} finally {
			await exec.close();
		}
	});

	test("a policy that confines no network starts no proxy and adds no variables", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		// The control, and the reason the two above mean something: with nothing
		// restricted there is no proxy to point at, and a child that found a
		// `127.0.0.1` proxy here would mean the proxy is started unconditionally
		// — a listening socket and a rewritten environment in every command of
		// every session, enforcing nothing.
		const result = await exec.exec({
			command: "node -e \"process.stdout.write(process.env.HTTP_PROXY || '(none)')\"",
			cwd,
			sandbox: netPolicy(cwd, "enabled", []),
		});
		expect(result.exitCode).toBe(0);
		// Compared against what this process already had rather than against a
		// literal. An unset `HTTP_PROXY` is the common case, but a developer
		// behind a corporate proxy has one in their environment and the child
		// inherits it — and that is not the executor having done anything, which
		// is the fact under test. Asserting "(none)" here would fail on exactly
		// the machines least likely to look at why.
		expect(result.stdout).toBe(process.env.HTTP_PROXY || "(none)");
		expect(exec.networkProxyRunning).toBe(false);
	});
});

/**
 * The background spawn is a second process tree, and the network axis has no
 * second reading of its own: `networkRules` is enforced by the proxy and nothing
 * else.
 *
 * Found by reading the two spawn paths against each other rather than by reading
 * the tests. The proxy's variables were added to `exec`'s child environment and
 * to nothing else, so a backgrounded command reached the network unconfined —
 * measured on the machine this was written on, under one and the same policy, as
 * `HTTP_PROXY` reading `http://127.0.0.1:2613` through `exec` and `(none)`
 * through the manager. `run_in_background: true` is a word the model chooses.
 *
 * Worth being precise about what this drops and what it does not: the deny rules
 * and the dangerous-command classifier still read the command either way,
 * because they read the tool's input rather than the spawn. What was missing is
 * the confinement around the process that input asked for.
 */
describe("the network axis reaches the background spawn too", () => {
	/**
	 * `bun`, not `node`, and the choice is worth 3.3 seconds per spawn.
	 *
	 * Not `echo $VAR` either: this file runs on Windows, where the shell is
	 * `cmd.exe` and `$HTTP_PROXY` is a literal string. A real interpreter is
	 * needed to print an environment variable at all.
	 *
	 * **This line used to say `node`, and four rows in this block were reported as
	 * machine-load flakes for weeks.** They were not flakes. Measured on this
	 * machine, same probe, same arguments, cold interpreter each time:
	 *
	 * ```console
	 * node   3474 ms
	 * bun     181 ms
	 * ```
	 *
	 * A 19x difference, on the one operation these rows are timing. The default
	 * 5,000 ms budget was therefore mostly spent on `node` starting up, and the
	 * rows went red whenever anything else on the machine competed for the same
	 * time — which is exactly what "flaky under load" describes and exactly what
	 * it was not.
	 *
	 * **`process.execPath` rather than a literal**, so the probe runs on whatever
	 * interpreter is executing the suite. A hard-coded `bun` would reintroduce the
	 * same coupling in the other direction: a machine without `bun` on PATH but
	 * running this file would find nothing.
	 */
	const PROBE = `"${process.execPath}" -e "process.stdout.write(String(process.env.HTTP_PROXY||'(none)'))"`;

	/**
	 * Poll budget: **shorter than the 5 s test timeout, on purpose.**
	 *
	 * This loop used to be 400 iterations at 25 ms — a 10,000 ms window inside a
	 * 5,000 ms budget. So a command that never finished could not be reported as
	 * "gave up": the harness killed the test first, and the failure was a bare
	 * `timed out after 5000ms` with no signal about which step hung.
	 *
	 * **The window is 4,000 ms and that number was measured, not chosen.** On this
	 * machine one `exec` of the probe costs ~2,300 ms end to end, and the two
	 * accounts add up:
	 *
	 * ```console
	 * bun -e (the probe alone)            181 ms
	 * the same probe through exec         2,306 ms
	 *   of which, with NO sandbox policy  2,138 ms
	 * ```
	 *
	 * So **the probe's own runtime is not the cost** — the earlier `node` probe
	 * added 3.4 s on top of that, which is why these rows read as load-sensitive
	 * for weeks. What remains is `detectShell` finding a `bash.exe` and starting
	 * it per call, on Windows, and that is **not attributed yet** — the two rows
	 * that still go red are exactly the ones whose budget the 2,138 ms no-policy
	 * baseline exceeds.
	 *
	 * **These rows are not fixed. They are measured.** Two candidates remain and
	 * neither is in this file: give the poll the room the work needs (4 s here,
	 * and the test's own timeout would still have to fit), or find why starting the
	 * shell costs two seconds. The second is the better question and it belongs to
	 * `operations.ts`, not to a test that is only observing it.
	 */
	const BACKGROUND_POLL_ATTEMPTS = 160;
	const BACKGROUND_POLL_INTERVAL_MS = 25;

	/** Run one command to completion in the background and read what it saw. */
	async function runBackground(
		manager: BackgroundShellManager,
		cwd: string,
		policy: SandboxPolicy | undefined,
	): Promise<{ exitCode: number | null; stdout: string; completed: boolean }> {
		const shell = await manager.start(PROBE, cwd, policy);
		for (let i = 0; i < BACKGROUND_POLL_ATTEMPTS; i++) {
			const info = manager.get(shell.id);
			if (info && info.status !== "running") break;
			await Bun.sleep(BACKGROUND_POLL_INTERVAL_MS);
		}
		return {
			exitCode: manager.get(shell.id)?.exitCode ?? null,
			// The manager writes the exit code into the same log the child wrote to.
			stdout: manager
				.output(shell.id)
				.replace(/\n?\[exit code: -?\d+\]\s*$/, "")
				.trim(),
			/** Whether the child actually finished inside the poll budget. */
			completed: manager.get(shell.id)?.status !== "running",
		};
	}

	test("a backgrounded command is pointed at the proxy, and at the same one", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const restricted = netPolicy(cwd, "restricted", [{ pattern: "registry.npmjs.org", permission: "allow" }]);
			const foreground = await exec.exec({ command: PROBE, cwd, sandbox: restricted });
			const background = await runBackground(new BackgroundShellManager(FAKE_LINUX, exec), cwd, restricted);

			// Named before anything else, so a failure says the child never finished
			// rather than reporting four downstream symptoms of the same thing. The
			// proxy is still holding a socket when this fails, so the message has to
			// be the assertion's own.
			expect(
				background.completed,
				`the background child did not finish inside ${BACKGROUND_POLL_ATTEMPTS * BACKGROUND_POLL_INTERVAL_MS} ms; what it printed was: ${background.stdout}`,
			).toBe(true);
			expect(foreground.exitCode).toBe(0);
			expect(background.exitCode).toBe(0);
			// The *same* port, not merely a proxy-shaped URL. A background path that
			// opened a listener of its own would satisfy a weaker version of this,
			// and nothing in the session would ever close it.
			expect(background.stdout).toBe(foreground.stdout);
			expect(background.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			expect(exec.networkProxyRunning).toBe(true);
		} finally {
			// The proxy holds a listening socket; leaving it open would keep the
			// test process alive.
			await exec.close();
		}
	});

	test("a caller's own HTTP_PROXY does not win over the policy, in the background", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		// A proxy in this process's own environment is the same hazard `exec` has:
		// whatever is already set here would be inherited by a child that injects
		// nothing, which is exactly how this bypass hid.
		const had = process.env.HTTP_PROXY;
		process.env.HTTP_PROXY = "http://192.0.2.1:9/";
		try {
			const result = await runBackground(
				new BackgroundShellManager(FAKE_LINUX, exec),
				cwd,
				netPolicy(cwd, "restricted", [{ pattern: "registry.npmjs.org", permission: "allow" }]),
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("192.0.2.1");
			expect(result.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		} finally {
			if (had === undefined) process.env.HTTP_PROXY = "";
			else process.env.HTTP_PROXY = had;
			await exec.close();
		}
	});

	test("the control: a policy that confines no network adds no variables in the background", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const result = await runBackground(
				new BackgroundShellManager(FAKE_LINUX, exec),
				cwd,
				netPolicy(cwd, "enabled", []),
			);
			// Compared against what this process already had rather than a literal:
			// a developer behind a corporate proxy has one in their environment, and
			// the child inheriting it is not the manager having done anything —
			// which is the fact under test.
			expect(result.stdout).toBe(process.env.HTTP_PROXY || "(none)");
			expect(exec.networkProxyRunning).toBe(false);
		} finally {
			await exec.close();
		}
	});

	test("the control: no policy at all starts no proxy in the background", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const result = await runBackground(new BackgroundShellManager(FAKE_LINUX, exec), cwd, undefined);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe(process.env.HTTP_PROXY || "(none)");
			expect(exec.networkProxyRunning).toBe(false);
		} finally {
			await exec.close();
		}
	});
});

/**
 * The two halves above say the manager injects the policy. These say the tool
 * hands it one, because that is the seam a later refactor would cut: a factory
 * that built its own executor, or a Bash tool that stopped awaiting `start`,
 * would leave every assertion above passing while the app ran unconfined.
 */

/**
 * The blocks above say the manager injects the policy. These say the tool hands
 * it one, because that is the seam a later refactor would cut: a factory that
 * built an executor of its own, or a Bash tool that stopped awaiting `start`,
 * would leave every assertion above passing while the app ran unconfined.
 */
describe("the tool hands the background spawn a confined policy", () => {
	/** `process.execPath` and why — the measured reason is in the block above. */
	const PROBE = `"${process.execPath}" -e "process.stdout.write(String(process.env.HTTP_PROXY||'(none)'))"`;
	const RESTRICTED: NetworkAxis = {
		access: "restricted",
		domains: [{ pattern: "registry.npmjs.org", permission: "allow" }],
	};

	function ctxFor(sandbox: SandboxMode, network: NetworkAxis): ToolCallContext {
		return {
			callId: "t1",
			signal: new AbortController().signal,
			cwd: process.cwd(),
			sandbox,
			network,
			onUpdate: () => {},
		};
	}

	async function readShell(manager: BackgroundShellManager, result: unknown): Promise<string> {
		const id = (result as { details?: { backgroundShellId?: string } }).details?.backgroundShellId;
		if (id === undefined) throw new Error(`the tool did not report a shell: ${JSON.stringify(result)}`);
		for (let i = 0; i < 400; i++) {
			const info = manager.get(id);
			if (info && info.status !== "running") break;
			await Bun.sleep(25);
		}
		return manager
			.output(id)
			.replace(/\n?\[exit code: -?\d+\]\s*$/, "")
			.trim();
	}

	test("run_in_background reaches the child with the proxy, not just the manager", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			// `danger-full-access` so nothing refuses the call before the shell
			// spawns: the filesystem half is not what this is about.
			const manager = new BackgroundShellManager(FAKE_LINUX, exec);
			const tool = createBashTool(cwd, defaultOperations(exec), manager);
			const result = await tool.call(
				{ command: PROBE, run_in_background: true },
				ctxFor("danger-full-access", RESTRICTED),
			);
			expect(await readShell(manager, result)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		} finally {
			await exec.close();
		}
	});

	test("the tool set builds its background manager on the executor it was given", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			// No manager passed, so the factory builds one — the only way this
			// wiring is reached in the app.
			const tools = createAllTools(cwd, { operations: defaultOperations(exec) });
			const bash = tools.find((tool) => tool.name === "Bash");
			if (!bash) throw new Error("no Bash tool in the default set");
			await bash.call({ command: "echo hi", run_in_background: true }, ctxFor("danger-full-access", RESTRICTED));
			// Asserted on the *given* executor, which is the whole point: a factory
			// that built the manager on an executor of its own would confine the
			// command just as well and leave this false — two listeners, and only
			// one of them reachable to be closed.
			expect(exec.networkProxyRunning).toBe(true);
		} finally {
			await exec.close();
		}
	});
});

/**
 * The proxy belongs to the policy that built it.
 *
 * `ChildProcessExecOperations` caches its proxy so a session runs one listener
 * rather than a fresh port per command, and the cache used to be a single slot
 * keyed on nothing. A proxy closes over the rules it was started with, so the
 * first restricted command of a session decided the destination policy for
 * every command after it: narrowing the allowlist mid-session changed nothing,
 * because the narrowing policy was never consulted. It fails **open** — the
 * policy that survives the collision is the older one and usually the broader.
 *
 * Reachable in the app, not just in theory: `bash.ts` rebuilds the policy for
 * every call from the context, so `/mode` and an allowlist edit both produce a
 * new policy under a session whose proxy slot is already full.
 *
 * The two destinations below are `.invalid` names (RFC 2606) on purpose. The
 * proxy decides before it resolves or dials, so a refused request here cannot
 * touch the network — and the alternative, a real host that the first policy
 * allows, would make the test's own failure mode an outbound connection to
 * somewhere. What makes each assertion decisive is the **reason**, not merely
 * the 403: `domain_denied` and `no_matching_allow_rule` are different decisions
 * from different rule tables, so a caller handed the wrong proxy reports the
 * wrong one and fails.
 */
describe("the proxy is keyed by the policy that built it", () => {
	const DENIED = "denied.invalid";
	const UNMATCHED = "unmatched.invalid";

	/** One `CONNECT host:443`, answered with the response head. */
	function connectVia(port: number, host: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const socket = connect({ host: "127.0.0.1", port }, () => {
				socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
			});
			let seen = "";
			socket.setEncoding("latin1");
			socket.on("data", (chunk: string) => {
				seen += chunk;
				const end = seen.indexOf("\r\n\r\n");
				if (end >= 0) {
					resolve(seen.slice(0, end));
					socket.destroy();
				}
			});
			socket.on("error", reject);
			// The proxy answers every refused request, but a listener that vanished
			// under us ends here with half a response, which is a failure to report
			// rather than a refusal to assert on.
			socket.on("close", () => resolve(seen));
		});
	}

	const portOf = (env: Record<string, string> | undefined): number => {
		if (!env) throw new Error("expected a confined policy to inject a proxy");
		return Number(new URL(env.HTTP_PROXY ?? "").port);
	};

	/** Whether nothing is listening on `port` any more. */
	function refused(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = connect({ host: "127.0.0.1", port }, () => {
				socket.destroy();
				resolve(false);
			});
			socket.on("error", () => resolve(true));
		});
	}

	const denyHost = (cwd: string) => netPolicy(cwd, "restricted", [{ pattern: DENIED, permission: "deny" }]);

	test("a second policy gets its own proxy and its own decision", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const first = await exec.networkEnvFor(denyHost(cwd));
			// The narrowing: the same axis, an allowlist that no longer names the
			// host. This is what a session does when the user edits its rules.
			const second = await exec.networkEnvFor(netPolicy(cwd, "restricted", []));

			// Two policies, two listeners. Without the key there is one slot, so
			// this is the assertion that fails first when the key is dropped.
			expect(portOf(second)).not.toBe(portOf(first));

			// Each proxy answers with the reason from *its own* table. Sharing one
			// would give both of these the same string, and the second one is the
			// one that matters: it is the narrowing policy going unenforced.
			expect(await connectVia(portOf(first), DENIED)).toContain("X-LBB-Denial: domain_denied");
			expect(await connectVia(portOf(second), UNMATCHED)).toContain("X-LBB-Denial: no_matching_allow_rule");

			// And the reverse order, because the old bug was "whoever came first
			// wins" and a fix that only handled the widening would still leave the
			// narrowing half in place when the session starts narrow.
			const third = new ChildProcessExecOperations(FAKE_LINUX);
			try {
				const narrowFirst = await third.networkEnvFor(netPolicy(cwd, "restricted", []));
				const wideAfter = await third.networkEnvFor(
					netPolicy(cwd, "restricted", [{ pattern: DENIED, permission: "deny" }]),
				);
				expect(portOf(wideAfter)).not.toBe(portOf(narrowFirst));
				expect(await connectVia(portOf(wideAfter), DENIED)).toContain("X-LBB-Denial: domain_denied");
			} finally {
				await third.close();
			}
		} finally {
			await exec.close();
		}
	});

	test("one policy is one listener, however many commands ask for it", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const first = portOf(await exec.networkEnvFor(denyHost(cwd)));
			// A fresh policy object with the same content, which is what every
			// command produces — `bash.ts` rebuilds it each call. Equal content has
			// to mean equal key, or this drops a listener per command and breaks the
			// sharing `run_in_background` depends on.
			expect(portOf(await exec.networkEnvFor(denyHost(cwd)))).toBe(first);
		} finally {
			await exec.close();
		}
	});

	test("two callers arriving together share one listener, and close takes it away", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		// Both calls are made before either can await, which is the only way to be
		// *in* the race rather than merely testing the cache afterwards.
		const [first, second] = await Promise.all([exec.networkEnvFor(denyHost(cwd)), exec.networkEnvFor(denyHost(cwd))]);
		const port = portOf(first);
		expect(portOf(second)).toBe(port);

		// The consequence, which is the part that matters: a second listener would
		// have been overwritten in the map rather than closed, so it would still be
		// listening on a port nothing holds a handle to. Asserting the URL equality
		// alone would leave that leak unguarded.
		await exec.close();
		expect(await refused(port)).toBe(true);
	});

	test("a start still in flight when close runs does not outlive it", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		// Deliberately not awaited before `close`: `close` runs synchronously up to
		// its own first await, so it lands while the listener is still being opened.
		const starting = exec.networkEnvFor(denyHost(cwd));
		const closing = exec.close();
		const env = await starting;
		await closing;

		// `close` cleared the map, and a start that finishes afterwards must not
		// put itself back — otherwise quitting during a slow listen leaves a socket
		// open on a port nothing will ever close.
		expect(portOf(env)).toBeGreaterThan(0);
		expect(await refused(portOf(env))).toBe(true);
	});

	test("a policy that confines nothing starts nothing, and says so once", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			expect(await exec.networkEnvFor(netPolicy(cwd, "enabled", []))).toBeUndefined();
			expect(exec.networkProxyRunning).toBe(false);
		} finally {
			await exec.close();
		}
	});
});
