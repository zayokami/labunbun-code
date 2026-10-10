// The Linux backend: a `bwrap` argument vector generated from a `SandboxPolicy`.
// Pure: which policy is in force is the only thing this file branches on, and
// `exists` is injected so a test's verdict is a fact about the policy.
// Long-form design notes: docs/dev/sandbox.md
import { canWrite, type SandboxPolicy } from "@labunbun/agent";

// Long-form design notes: docs/dev/sandbox.md
/** Build the `bwrap` argument vector for `policy`, wrapping `command`. */
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
	// **`denied` is weaker here than on the other two backends.** Bubblewrap has
	// no deny rule — it is purely constructive — so `--ro-bind` is the strongest
	// thing it can say and it leaves the path readable.
	// Long-form design notes: docs/dev/sandbox.md
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
		// **No ancestor mount here, and the file header says why at length.** No
		// mount arrangement both refuses the rename and keeps the workspace
		// writable, so the relocation bypass stands as a measured gap.
		// Long-form design notes: docs/dev/sandbox.md
		...protectedPaths.flatMap((path) => readOnlyPathArgs(path, exists)),
		...namespaceArgs(policy.network),
		"--cap-drop",
		"ALL",
		"--",
		...command,
	];
}

// Long-form design notes: docs/dev/sandbox.md
/** The argv that makes one protected path read-only, chosen by whether it is there. */
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
	// Fail closed, and match what `networkPolicy` does for seatbelt: the two
	// backends used to disagree about a value that should not exist, leaving the
	// network open on one and closed on the other.
	// Long-form design notes: docs/dev/sandbox.md
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
