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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

describe("the sandbox reaches the foreground spawn", () => {
	test("a confined command is handed to bwrap, which is not installed here", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		const result = await exec.exec({ command: "echo hi", cwd, sandbox: policy("workspace-write", cwd) });

		// The proof is the error naming a program that is not there. If the
		// wrapper were not applied the command would print `hi` and exit 0, so
		// this assertion fails the moment the wiring is removed — which is the
		// line a reader would otherwise have to take on trust.
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("bwrap");
	});

	test("the control: the same executor runs the same command when the policy is unrestricted", async () => {
		// A control that cannot fail is not a control. This one differs from the
		// test above only in the sandbox axis, and the two must not agree — so if
		// the assertion above ever starts passing for the wrong reason, this one
		// is what notices.
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		const result = await exec.exec({ command: "echo hi", cwd, sandbox: policy("danger-full-access", cwd) });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hi");
	});

	test("no policy at all is the plain shell, exactly as it was", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		const result = await exec.exec({ command: "echo hi", cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hi");
	});
});

describe("the sandbox reaches the background spawn too", () => {
	// The bypass this closes was invisible: `run_in_background: true` would have
	// spawned the shell directly, so the sandbox would have looked like it worked
	// for every command a user ran in the foreground.
	test("a backgrounded command is wrapped the same way a foreground one is", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		const manager = new BackgroundShellManager(FAKE_LINUX, exec);
		const shell = await manager.start("echo hi", cwd, policy("workspace-write", cwd));

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
		expect(manager.get(shell.id)?.exitCode).not.toBe(0);
		expect(manager.output(shell.id)).toContain("bwrap");
	});

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
		for (const backend of ["native", "simulated", "unavailable"] as const) {
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
	});

	test("the executor reports the backend its own runtime implies, not the host's", () => {
		expect(new ChildProcessExecOperations(FAKE_LINUX).sandboxBackend).toBe("native");
		expect(new ChildProcessExecOperations({ platform: "linux", hasNativeBackend: false }).sandboxBackend).toBe(
			"unavailable",
		);
		expect(new ChildProcessExecOperations({ platform: "win32", hasNativeBackend: true }).sandboxBackend).toBe(
			"simulated",
		);
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
	// Codex reaches that branch only because it pairs `--unshare-net` with a
	// TCP→UDS→TCP bridge (`codex-rs/linux-sandbox/README.md`); this build has no
	// bridge, so "wrap anyway" would enforce the axis by breaking the network.
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
		// could never get out — the same reason Codex does not pair the two.
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

		const argv = argvFor(built, [present]);
		expect(argv).toContain(present);
		expect(argv).not.toContain(absent);
		// The workspace itself is never marked skip, so it survives the filter
		// even though `exists` was told it is not there either.
		expect(argv).toContain(cwd);
	});

	test("the workspace is kept even when it is absent, because a missing one is a broken session", () => {
		// Dropping it would confine the session to nothing and report success,
		// which is strictly worse than the spawn error it replaces.
		const ghost = join(tmpdir(), "lbb-sandbox-no-workspace");
		const built = buildSandboxPolicy({ sandbox: "workspace-write", workspace: ghost });
		const argv = argvFor(built, []);
		expect(argv).toContain(ghost);
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
	/** `node` rather than `echo $VAR`: this file runs on Windows, where the shell
	 * is `cmd.exe` and `$HTTP_PROXY` is a literal string. */
	const PROBE = `node -e "process.stdout.write(String(process.env.HTTP_PROXY||'(none)'))"`;

	/** Run one command to completion in the background and read what it saw. */
	async function runBackground(
		manager: BackgroundShellManager,
		cwd: string,
		policy: SandboxPolicy | undefined,
	): Promise<{ exitCode: number | null; stdout: string }> {
		const shell = await manager.start(PROBE, cwd, policy);
		for (let i = 0; i < 400; i++) {
			const info = manager.get(shell.id);
			if (info && info.status !== "running") break;
			await Bun.sleep(25);
		}
		return {
			exitCode: manager.get(shell.id)?.exitCode ?? null,
			// The manager writes the exit code into the same log the child wrote to.
			stdout: manager
				.output(shell.id)
				.replace(/\n?\[exit code: -?\d+\]\s*$/, "")
				.trim(),
		};
	}

	test("a backgrounded command is pointed at the proxy, and at the same one", async () => {
		const cwd = workspace();
		const exec = new ChildProcessExecOperations(FAKE_LINUX);
		try {
			const restricted = netPolicy(cwd, "restricted", [{ pattern: "registry.npmjs.org", permission: "allow" }]);
			const foreground = await exec.exec({ command: PROBE, cwd, sandbox: restricted });
			const background = await runBackground(new BackgroundShellManager(FAKE_LINUX, exec), cwd, restricted);

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
	const PROBE = `node -e "process.stdout.write(String(process.env.HTTP_PROXY||'(none)'))"`;
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
