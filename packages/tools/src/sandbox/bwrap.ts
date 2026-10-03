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
 * The returned argv is the argument vector **after the program name**, which the
 * caller prefixes with `bwrap`:
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
 * ## The `.git` relocation bypass: measured, and unfixable with bwrap's primitives
 *
 * **This is a known gap, not a fixed one.** Read it before trusting this backend
 * with a repository whose `.git` must not be tampered with.
 *
 * The seatbelt translator emits ancestor-unlink denies because it matches on
 * pathnames, and `mv /w/repo/sub /w/repo/x` relocates a protected
 * `/w/repo/sub/.git` out from under its own deny. This translator emits nothing,
 * on a belief it inherited: that a bind mount attaches to the dentry rather than
 * the name, so the read-only bind travels with the directory when its parent is
 * renamed, and the rename fails because unlinking a mountpoint needs a write the
 * read-only bind forbids.
 *
 * **That belief was false.** `test (bwrap on PATH)` — the CI leg that installs
 * bubblewrap and gates on a namespace really starting — runs
 * `sandbox-bwrap-smoke.test.ts`, which does the one thing this paragraph used to
 * say needed a manual smoke test:
 *
 * ```console
 * (pass) CONTROL: renaming a directory that holds a .git leaves it writable, unsandboxed
 * (fail) renaming a directory that holds a .git does not make the .git writable
 *        Expected: "refused"   Received: "WROTE"
 * ```
 *
 * The control is what makes it a finding: outside the sandbox the same rename
 * leaves the moved `.git` writable, so the two hypotheses differ. The argv this
 * translator produces is correct either way, which is why no string comparison in
 * `sandbox-native.test.ts` could have found it.
 *
 * **Every arrangement that closes it costs the workspace instead.** Bubblewrap has
 * no deny rule — it is purely constructive, arranging mounts — so a fix had to be
 * an arrangement, and the arrangements were measured rather than reasoned about,
 * because reasoning about mount semantics is what produced the wrong belief in
 * the first place. All of these are from `sandbox-bwrap-smoke.test.ts` on a
 * runner with a real bwrap; `in-ws` is a write into the workspace itself:
 *
 * ```console
 * A  no extra mount:                        rename exit=0  in-ws=ok    <- the bypass
 * D  ancestor --ro-bind after the writable: rename exit=1  in-ws=refused
 * E  ancestor --ro-bind before the writable:rename exit=1  in-ws=refused
 * F  ancestor --ro-bind, workspace re-bound:rename exit=1  in-ws=ok    .git write=WROTE
 * G  as F, reordered:                       rename exit=1  in-ws=ok    .git write=WROTE
 * H/I  --perms 555 instead of a mount:      rename exit=1  in-ws=refused
 * ```
 *
 * Read the table as two columns of failure. **D, E and H freeze the workspace** —
 * `workspace-write` stops writing anything, which is not a narrower sandbox but a
 * broken one, and it is the direction the house rule says to prefer only when the
 * alternative is a hole rather than a cost paid by every user. **F and G restore
 * the workspace and make the `.git` writable again**, because the rebind lands on
 * the ancestor too. `--perms` is not a different answer: it changes nothing.
 *
 * **So no arrangement satisfies both, and none was shipped.** An ancestor mount
 * was in the tree for one commit and removed: it closed the relocation and made
 * `git status` unable to write anything, and `CONTROL: a write inside the
 * workspace succeeds` — the row that exists so a sandbox refusing everything
 * cannot pass — caught it on CI within a day.
 *
 * What a real fix needs is a way to name a path the kernel refuses to rename,
 * which is what seatbelt's `(deny file-write-unlink (literal …))` is and what
 * bubblewrap does not have. Until then: **`sub/` inside a workspace can be renamed
 * out from under its parent, and a `.git` below it becomes writable at the new
 * location.** The path is bounded — it needs a directory holding a protected path
 * *and* a write to that directory — and it is the reason a Linux user who trusts
 * this backend's `.git` protection against a hostile command inside the sandbox is
 * relying on something this file does not provide.
 *
 * The line was here first as an assumption with a named owner, and that is what the
 * history is worth keeping: it said in advance what would falsify it and how, and
 * the cheap thing it proposed turned out to be the thing that did.
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
 * restriction the caller asked for. That branch is `bwrap --bind / /` plus the
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
	// **`denied` is weaker here than it is on the other two backends, and this is
	// the whole reason a `deny` entry is not what its name says on Linux.**
	// `FileSystemAccessMode` documents `deny` as "a path nothing may read"
	// (`sandbox-policy.ts`), and `canRead` there is `access !== "deny"`. Seatbelt
	// honours that — `(deny file-read* file-write* (subpath ...))` — and so does
	// the simulated backend, whose `decideRead` refuses. Bubblewrap has no deny
	// rule at all: it is purely constructive, arranging mounts, so `--ro-bind` is
	// the strongest expression available and it leaves the path **readable**.
	//
	// There is no ordering or mount trick that fixes this. `--ro-bind / /` above
	// is recursive, so omitting a subtree does not hide it, and `--tmpfs` would
	// change what the path appears to be rather than hide it.
	//
	// **It is unreachable today and that is checked, not assumed:**
	// `buildSandboxPolicy` emits only `"write"` and `"read"` (`sandbox-policy.ts`
	// pushes those two and nothing else), so no policy this build constructs
	// carries a `deny`. The tests reach one by hand, which is how this was found.
	// If a caller ever starts building one, this line is where the gap lives and
	// the fix has to happen in the policy, not here.
	//
	// Protected paths are a different case and are correct: read-only, not
	// unreadable, because `git status` has to read `.git`. `canRead` never sees
	// them, because they arrive as `policy.protected` and never as a `deny` entry.
	const protectedPaths = policy.protected;

	return [
		"--new-session",
		"--die-with-parent",
		// Read baseline: readable everywhere, matching this build's read-only mode.
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
		// Readable, not hidden — see the note on `denied` above. This is the
		// strongest thing bubblewrap can say, and it is not what `deny` means.
		...denied.flatMap((path) => ["--ro-bind", path, path]),
		// **No ancestor mount here, and the file header says why at length.** Every
		// arrangement that closes the relocation was measured on a runner with a real
		// bwrap and every one of them costs the workspace instead: read-only after
		// the writable bind freezes the workspace, and read-only plus a writable
		// rebind makes the protected path writable again. `--perms` changes nothing.
		// There is no mount arrangement that both refuses the rename and keeps the
		// rest of the workspace writable, so this translator emits none and the
		// relocation bypass stands as a known, measured gap rather than as a fix that
		// costs users their workspace.
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
 * The alternative is to mount an empty, read-only directory there instead —
 * `--perms 555 --tmpfs <path> --remount-ro <path>` — and it is the only third
 * answer: neither binding a path that cannot be bound nor dropping a path that
 * must not be writable. The path exists, it is empty, and it cannot be written —
 * so the protection holds for the directory that is not there yet as well as the
 * one that is, which is what a derived path needs and what a scan-found path got
 * for free.
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
 * The namespace flags. The network flag is present **exactly** when the policy
 * restricts the network, and the filesystem has nothing to say about it either
 * way.
 */
function namespaceArgs(network: SandboxPolicy["network"]): string[] {
	const args = [
		// Requested explicitly rather than relying on bubblewrap's auto-enable,
		// which it skips when the caller is already uid 0.
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
	];
	// Fail closed, and match what `networkPolicy` does for seatbelt.
	//
	// The two backends used to disagree about a value that should not exist. This
	// asked `network === "restricted"`, so anything else — a corrupted policy, an
	// embedder that built one by hand, a value the type does not have — left
	// `--unshare-net` off and the network **open**. Seatbelt asked
	// `network === "enabled"` and falls through to the restricted text, so the
	// same input closed the network there. Same policy, opposite direction of
	// failure, decided by which platform you are on.
	//
	// At the type level the two forms are equivalent — `network` is
	// `"restricted" | "enabled"` and nothing else — so this changes no verdict on
	// any value the build can produce. That is the point: the reachable inputs
	// are identical either way, and the unreachable one now costs the network
	// rather than granting it. The same shape as `canRead`, which reads
	// `access !== "deny"` for the same reason.
	if (network !== "enabled") args.push("--unshare-net");
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
