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
 * ## Why there are ancestor mounts here, and what it cost to find out
 *
 * The seatbelt translator emits ancestor-unlink denies because it matches on
 * pathnames, and `mv /w/repo/sub /w/repo/x` relocates a protected
 * `/w/repo/sub/.git` out from under its own deny. This translator used to emit
 * nothing, on the belief that bubblewrap has no such hole: a bind mount attaches
 * to the dentry rather than the name, so the read-only bind travels with the
 * directory when its parent is renamed, and the rename itself fails because
 * unlinking a mountpoint needs a write the read-only bind forbids.
 *
 * **That belief was inherited and it was false.** `test (bwrap on PATH)` — the CI
 * leg that installs bubblewrap and gates on a namespace really starting — runs
 * `sandbox-bwrap-smoke.test.ts`, which does the one thing this paragraph used to
 * say needed a manual smoke test. With a `.git` protected under `sub/` and `sub`
 * inside a writable workspace:
 *
 * ```console
 * (pass) CONTROL: renaming a directory that holds a .git leaves it writable, unsandboxed
 * (fail) renaming a directory that holds a .git does not make the .git writable
 *        Expected: "refused"   Received: "WROTE"
 * ```
 *
 * The control is what makes that a finding: outside the sandbox the same rename
 * leaves the moved `.git` writable, so the two hypotheses differ and the
 * assertion can tell them apart. The argv this translator produces is correct
 * either way, which is why no string comparison in `sandbox-native.test.ts` could
 * have found it.
 *
 * **Bubblewrap has no deny rule** — it is purely constructive, arranging mounts —
 * so the fix cannot be a rule. It has to be an arrangement, and the arrangement
 * was measured rather than reasoned about, because reasoning about mount
 * semantics is what produced the wrong belief in the first place. Same machine,
 * same run, three probes (`sandbox-bwrap-smoke.test.ts`, the row named MEASURE):
 *
 * ```console
 * A  as shipped, no extra mount:        rename exit=0                       <- the bypass
 * B  --bind the ancestor onto itself:    rename exit=1   read=read  write=WROTE
 * C  --ro-bind the ancestor onto itself:  rename exit=1   read=read  write=refused
 * ```
 *
 * B is why this is not a one-liner: it refuses the rename and leaves the
 * contained `.git` writable, so it closes the hole and does nothing about the
 * thing the hole was about. A test asserting only "the rename was refused" would
 * have shipped it. C refuses the rename, keeps `.git` readable, and makes it
 * unwritable — which is the whole requirement, because `git status` has to read
 * the thing it must not write.
 *
 * **The cost of C is a narrowing, and it is deliberate.** A read-only bind of the
 * ancestor shadows everything beneath it, so anything under a protected path's
 * parent that was writable is now read-only. That fails closed, which is the right
 * direction, and it is a real cost — see {@link ancestorArgs}.
 *
 * The line was here first as an assumption with a named owner, and that is what
 * the preceding paragraph is worth keeping: it said in advance what would falsify
 * it and how, and the cheap thing it proposed turned out to be the thing that did.
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
	const ancestors = protectedAncestors(
		policy,
		writable.map((entry) => entry.path),
	);

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
		// Ancestors of a protected path, read-only, so a directory carrying one
		// cannot be renamed out from under its parent. See the file header for the
		// measurement that settled this — it is not a guess and it is not free.
		...ancestors.flatMap((path) => ancestorArgs(path, exists)),
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
 * The mount that makes one ancestor of a protected path unrenameable.
 *
 * `--ro-bind` onto itself, and **that is the only shape that works**: a writable
 * bind of the same directory refuses the rename just as well but leaves the
 * contained `.git` writable, which is the protection doing nothing while looking
 * like it worked. Both answers are in the measurement row of
 * `sandbox-bwrap-smoke.test.ts`, measured on a runner with a real bwrap:
 *
 * ```console
 * A  as shipped, no extra mount:       rename exit=0                       <- the bypass
 * B  --bind the ancestor onto itself:   rename exit=1   read=read  write=WROTE
 * C  --ro-bind the ancestor onto itself: rename exit=1   read=read  write=refused
 * ```
 *
 * B is the near miss worth keeping in this comment: it closes the relocation and
 * leaves the `.git` writable through the same path, so a test asserting only
 * "the rename was refused" would have shipped it.
 *
 * **The cost is real and it is not small.** A read-only bind of the ancestor
 * shadows everything under it, so a nested `.git` that `protected` listed is
 * covered twice and a nested one it did *not* list is now read-only too. That is
 * a narrowing: `mv` of a sibling directory, or a build writing under a protected
 * path's parent, stops working. It fails closed, which is the right direction,
 * and it is a cost a user of `workspace-write` will feel.
 *
 * `--ro-bind` needs the source to exist. An absent ancestor of a derived `.git`
 * is unusual — `<root>` exists whenever it is a writable root — but the
 * `--tmpfs` fallback is the same shape {@link readOnlyPathArgs} uses, and
 * skipping it would make one input shape fail with a spawn error instead of
 * narrowing.
 */
function ancestorArgs(path: string, exists: (path: string) => boolean = () => true): string[] {
	if (exists(path)) return ["--ro-bind", path, path];
	return ["--perms", "555", "--tmpfs", path, "--remount-ro", path];
}

/**
 * Every directory between a protected path and its writable root, the root
 * included.
 *
 * **The root is included on purpose.** Renaming the writable root moves a
 * protected directory just as effectively as renaming an intermediate one, so a
 * walk that stopped below the root would leave the same bypass one level up.
 *
 * This mirrors `protectedAncestors` in `seatbelt.ts`, which exists for the same
 * reason against pathnames rather than against mounts, and the two have to agree
 * about which directories are at stake — a policy confined on macOS and not on
 * Linux would be a policy whose meaning depends on the machine.
 *
 * Sorted, so the argv is a function of the policy and not of `Set` insertion
 * order.
 */
function protectedAncestors(policy: SandboxPolicy, writableRoots: string[]): string[] {
	const carved = [
		...policy.protected,
		...policy.fileSystem.entries.filter((entry) => entry.access === "deny").map((entry) => entry.path),
	];
	const ancestors = new Set<string>();
	for (const path of carved) {
		const root = writableRoots.find((candidate) => isAtOrBelow(parentOf(path), candidate));
		if (root === undefined) continue;
		// The no-progress guard is load-bearing. With a writable root of `/`,
		// `isAtOrBelow` matches everything and `parentOf("/")` is `""`, which
		// `parentOf("")` also returns, so the walk oscillates between `""` forever.
		// Measured before this guard elsewhere: a chain that never terminated.
		let current = parentOf(path);
		while (current !== "" && !ancestors.has(current)) {
			ancestors.add(current);
			if (current === root) break;
			const next = parentOf(current);
			if (next === current) break;
			current = next;
		}
	}
	return [...ancestors].sort();
}

/** `path` without its last segment; `/` for a top-level path. */
function parentOf(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	if (index < 0) return trimmed;
	return index === 0 ? "/" : trimmed.slice(0, index);
}

/** Whether `candidate` is `root` or sits inside it, on canonical absolute paths. */
function isAtOrBelow(candidate: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
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
