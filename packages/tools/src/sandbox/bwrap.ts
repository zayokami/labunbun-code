/**
 * The Linux backend: a `bwrap` argument vector generated from a `SandboxPolicy`.
 *
 * Pure. No filesystem access, no `process.platform`, no clock. Which backend runs
 * is the caller's decision and it passes the policy in; which policy is in
 * force is the only thing this file branches on. The one thing it has to be told
 * it cannot know — whether a protected path is there — arrives as an injected
 * `exists` rather than an import, so a test's verdict is a fact about the policy
 * and not about the machine the test ran on.
 *
 * ## Shape
 *
 * The returned argv is the argument vector **after the program name**, matching
 * Codex's `BwrapArgs.args` (`codex-rs/linux-sandbox/src/bwrap.rs:248-402`), which
 * the caller prefixes with `bwrap`:
 *
 *     ["--new-session", "--die-with-parent", "--ro-bind", "/", "/", ...,
 *      "--unshare-user", "--unshare-pid", "--unshare-ipc", ["--unshare-net"],
 *      "--proc", "/proc", "--cap-drop", "ALL", "--", ...command]
 *
 * Flags are separate argv elements, never a joined string, so a path containing a
 * space or a leading `-` cannot become a flag. There is no `-D` equivalent here:
 * bwrap takes paths as operands, so the "never interpolate a path into a
 * template string" property that the seatbelt translator has to work for falls
 * out of using an array.
 *
 * ## Ordering is the protection
 *
 * bubblewrap applies mounts in order and a later mount shadows an earlier one at
 * the same path. So the read-only binds for denied and protected paths are
 * emitted **after** the writable binds that cover them, and that is what makes
 * `/w/repo/.git` read-only when `/w/repo` is writable. Moving them above the
 * writable binds would silently unprotect `.git`.
 *
 * ## Why there are no ancestor-unlink denies here
 *
 * The seatbelt translator has to emit them, because seatbelt matches on
 * pathnames and `mv /w/repo/sub /w/repo/x` relocates a protected
 * `/w/repo/sub/.git` out from under its own deny. This translator does not emit
 * them, on the belief that bubblewrap does not have that hole: a bind mount
 * attaches to the dentry rather than the name, so the read-only bind is expected
 * to travel with the directory when its parent is renamed, and the rename is
 * expected to fail because unlinking a mountpoint needs a write the read-only
 * bind forbids.
 *
 * **That belief is inherited, not verified here.** It was not checked against
 * kernel mount semantics from this machine, and it is load-bearing: if it is
 * wrong, this backend has a `.git`-relocation bypass and no test in this
 * repository would catch it, because the argv it produces is correct either way.
 * Codex emits the equivalent rules for the *seatbelt* backend
 * (`seatbelt.rs:912-935`, `:1064-1074`) and does not for its bwrap one, which is
 * the reference for the asymmetry. The cheap thing that would settle it is one
 * `bwrap` command on a real Linux box — `mv` a directory containing a `.git` out
 * from under its parent and see whether the repository survives — and that is a
 * manual smoke test, not something a unit test can do. Until it is run, treat
 * this as an assumption with a named owner rather than a property of the code.
 *
 * ## About `missingPathBehavior`
 *
 * This function cannot honour it. It is pure, so it cannot tell whether
 * `/w/.cache/labunbun` exists, and a `skip`-marked entry that does not exist is
 * passed through. Unlike seatbelt that is **not** harmless: `--bind` of a source
 * that is not there makes bubblewrap fail before the command ever runs, which
 * turns a policy that named an unused directory into a broken shell.
 * `resolveSandboxExecution` filters those entries out before calling here, which
 * is why the contract belongs on the entry and the work belongs one layer up.
 *
 * A **protected** path that does not exist is the opposite case and does not go
 * through that filter, because the two answers are not interchangeable: dropping
 * a `skip`-marked cache is what the caller asked for, and dropping a protected
 * path is exactly the failure this file's whole `.git` protection exists to
 * prevent. It gets a mount of its own instead — see `readOnlyPathArgs`.
 */
import { canWrite, type SandboxPolicy } from "@labunbun/agent";

/**
 * Build the `bwrap` argument vector for `policy`, wrapping `command`.
 *
 * Returns `command` **unchanged** for a policy that confines nothing and permits
 * the network. A wrapper whose mounts grant everything is a mechanism that can
 * only be a no-op, and paying for a namespace to reach that result is a wrapper
 * that only looks like a sandbox; handing the caller its own argv makes the
 * unconfined case distinguishable from a very wide sandbox by inspection.
 *
 * The exception is an unconfined filesystem with `network: "restricted"`, which
 * still wraps: omitting `--unshare-net` there would silently discard a
 * restriction the caller asked for. Codex takes the same branch for the same
 * reason (`bwrap.rs:259-270`), and that branch is `bwrap --bind / /` plus the
 * namespace flags.
 *
 * `exists` is the one impure thing this function needs, and it is injected rather
 * than imported for the reason `resolveSandboxExecution` injects the same predicate:
 * a translator that stats the filesystem is a translator whose tests are tests of
 * the machine they run on. See {@link readOnlyPathArgs} for what it is asked.
 */
export function buildBwrapArgs(
	policy: SandboxPolicy,
	command: string[],
	exists: (path: string) => boolean = () => true,
): string[] {
	if (policy.fileSystem.kind === "unrestricted") {
		return policy.network === "enabled" ? [...command] : [...fullFilesystemArgs(), "--", ...command];
	}

	const writable = policy.fileSystem.entries.filter((entry) => canWrite(entry.access));
	const denied = policy.fileSystem.entries.filter((entry) => entry.access === "deny").map((e) => e.path);
	// Protected paths are read-only, not unreadable: `git status` has to read
	// `.git`. Codex separates the two the same way
	// (`permissions.rs:104-130`: `can_read` is `access !== Deny`).
	const protectedPaths = policy.protected;

	return [
		"--new-session",
		"--die-with-parent",
		// Read baseline: readable everywhere, matching Codex's read-only mode.
		// `read` entries are additions to this and so produce no mount at all,
		// which is what `buildSandboxPolicy` means by "on the backends where the
		// default is readable they are not emitted at all".
		"--ro-bind",
		"/",
		"/",
		// A minimal writable /dev with the standard nodes. It has to come before
		// the writable roots so an explicit writable bind under /dev still lands.
		"--dev",
		"/dev",
		// Writable roots first, read-only paths after them: a later mount shadows
		// an earlier one at the same path, and this is the ordering that protects
		// `.git`. See the file header.
		...writable.flatMap((entry) => ["--bind", entry.path, entry.path]),
		...denied.flatMap((path) => ["--ro-bind", path, path]),
		...protectedPaths.flatMap((path) => readOnlyPathArgs(path, exists)),
		...namespaceArgs(policy.network),
		"--cap-drop",
		"ALL",
		"--",
		...command,
	];
}

/**
 * The argv that makes one protected path read-only, chosen by whether it is there.
 *
 * `--ro-bind` needs its source to exist: bubblewrap fails to start otherwise, so
 * a policy naming a path that was never created turns a narrower sandbox into a
 * shell that does not run. That was fine while `protected` came only from a scan
 * — a scan does not report what it did not find — and stopped being fine the
 * moment `buildSandboxPolicy` began *deriving* `<root>/.git`, which is absent in
 * every workspace that is not a repository.
 *
 * The alternative is to mount an empty, read-only directory there instead, and it
 * is Codex's: `--perms 555 --tmpfs <path> --remount-ro <path>`
 * (`codex-rs/linux-sandbox/src/bwrap.rs:1198-1205`,
 * `append_empty_directory_args`). The path exists, it is empty, and it cannot be
 * written — so the protection holds for the directory that is not there yet as
 * well as the one that is, which is what a derived path needs and what a
 * scan-found path got for free.
 *
 * `exists` defaults to "yes", which is the answer that reproduces the previous
 * argv exactly. It is not the right answer in production — the caller passes the
 * real one — and defaulting to it rather than to the filesystem is what keeps
 * this function from becoming impure. A default of `existsSync` would make every
 * existing test of this translator a test of the machine it runs on, which is the
 * same mistake `web-network-axis.test.ts` was just fixed for.
 */
function readOnlyPathArgs(path: string, exists: (path: string) => boolean): string[] {
	if (exists(path)) return ["--ro-bind", path, path];
	return ["--perms", "555", "--tmpfs", path, "--remount-ro", path];
}

/**
 * The namespace flags, in Codex's order. The network flag is present **exactly**
 * when the policy restricts the network, and the filesystem has nothing to say
 * about it either way.
 */
function namespaceArgs(network: SandboxPolicy["network"]): string[] {
	const args = [
		// Requested explicitly rather than relying on bubblewrap's auto-enable,
		// which it skips when the caller is already uid 0.
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
	];
	if (network === "restricted") args.push("--unshare-net");
	// A fresh procfs, so host process roots are not reachable through /proc.
	args.push("--proc", "/proc");
	return args;
}

/**
 * The full-filesystem argv: the writable-root bind for `/`, plus the namespace
 * flags. Reached only by the branch documented on `buildBwrapArgs`; the fully
 * unconfined case returns the command instead of building this.
 */
function fullFilesystemArgs(): string[] {
	return [
		"--new-session",
		"--die-with-parent",
		"--bind",
		"/",
		"/",
		"--dev",
		"/dev",
		...namespaceArgs("restricted"),
		"--cap-drop",
		"ALL",
	];
}
