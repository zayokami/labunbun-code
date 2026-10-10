// The macOS backend: a `sandbox-exec` profile generated from a `SandboxPolicy`.
// Pure: the caller passes the policy and the command, and gets back an argv.
// Long-form design notes: docs/dev/sandbox.md
import { canWrite, type SandboxPolicy } from "@labunbun/agent";

// Long-form design notes: docs/dev/sandbox.md
/** The part of the profile that is not the policy: process control, the terminal, and local IPC. */
const BASE_POLICY = `(version 1)
(deny default)

; Process control, scoped to this sandbox so a child cannot signal out of it.
(allow process-fork)
(allow process-exec)
(allow signal (target same-sandbox))
(allow process-info*)

; Sysctls permitted. This list is not decoration and the omission of it was a
; real defect, measured on macOS rather than reasoned about: with no sysctl rule
; at all under the (deny default) below, a JavaScript runtime dies during
; startup and takes the whole command with it. A one-liner under this profile
; exited 133 -- SIGTRAP -- with both streams empty, so the Bash tool reported
; "[exit code: 0]" and a test asserting that a command's output arrives saw
; nothing. /bin/echo under the identical profile was fine, because it queries
; nothing, which is what pinned the fault on the runtime's startup rather than
; on exec.
;
; These rules were carried over from a working base policy rather than written
; from scratch here. They are enumerated rather than a bare (allow sysctl-read)
; because the enumeration hands a confined command those specific keys rather
; than every key the kernel has. The trade is that a runtime querying a key
; outside this list still fails to start, so adding to it is the price of not
; widening it.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.sysv.semmns")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))
; Misclassified as a write because the caller passes a buffer to read into.
(allow sysctl-write (sysctl-name "kern.grade_cputype"))

; The terminal. Without these an interactive shell cannot detect a TTY and
; coreutils refuses to run at all.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/null"))
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))

; Local IPC, plus the two Mach services a process cannot start without:
; opendirectoryd resolves the user's home directory, PowerManagement handles
; sleep. Everything else is withheld.
(allow ipc-posix-shm-read-data)
(allow ipc-posix-shm-write-create)
(allow ipc-posix-shm-write-unlink)
(allow ipc-posix-sem)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control"))`;

/**
 * The Mach services needed only once the policy turns the network on: DNS
 * resolution, TLS trust evaluation, and the SystemConfiguration resolver.
 * Withheld under `network: "restricted"`, because a lookup service is a way out.
 */
const NETWORK_MACH_LOOKUP = `(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))`;

/** One `(param "KEY")` reference and the `-DKEY=value` argument that fills it. */
interface SeatbeltParam {
	key: string;
	value: string;
}

// Long-form design notes: docs/dev/sandbox.md
/** Build the `sandbox-exec` argument vector for `policy`, wrapping `command`. */
export function buildSeatbeltArgs(policy: SandboxPolicy, command: string[]): string[] {
	if (policy.fileSystem.kind === "unrestricted") {
		return policy.network === "enabled" ? [...command] : ["-p", unconfinedProfile(), "--", ...command];
	}

	const params: SeatbeltParam[] = [];
	const writableKeys: string[] = [];
	for (const [index, entry] of policy.fileSystem.entries.entries()) {
		if (!canWrite(entry.access)) continue;
		const key = `WRITABLE_ROOT_${index}`;
		params.push({ key, value: entry.path });
		writableKeys.push(key);
	}

	const deniedKeys: string[] = [];
	for (const [index, entry] of policy.fileSystem.entries.entries()) {
		if (entry.access !== "deny") continue;
		const key = `DENIED_${index}`;
		params.push({ key, value: entry.path });
		deniedKeys.push(key);
	}

	const protectedKeys: string[] = [];
	for (const [index, path] of policy.protected.entries()) {
		const key = `PROTECTED_${index}`;
		params.push({ key, value: path });
		protectedKeys.push(key);
	}

	const ancestorParams = protectedAncestors(policy);

	const sections: string[] = [
		BASE_POLICY,
		READ_BASELINE,
		...writableKeys.map((key) => `(allow file-write* (subpath (param "${key}")))`),
		networkPolicy(policy.network),
		...deniedKeys.map((key) => `(deny file-read* file-write* (subpath (param "${key}")))`),
		...protectedKeys.map((key) => `(deny file-write* (subpath (param "${key}")))`),
		...ancestorParams.map(
			(param) => `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal (param "${param.key}"))))`,
		),
	];

	return [
		"-p",
		sections.filter((section) => section.length > 0).join("\n"),
		...params.map((param) => `-D${param.key}=${param.value}`),
		...ancestorParams.map((param) => `-D${param.key}=${param.value}`),
		"--",
		...command,
	];
}

// Long-form design notes: docs/dev/sandbox.md
/** The read baseline: readable everywhere, so `read` entries produce no rule. */
const READ_BASELINE = `; Read baseline: readable everywhere, matching this build's read-only mode.
; "read" entries are additions to this and so emit no rule of their own.
(allow file-read*)`;

/** The network axis. Emitted last of the non-deny sections so the denies still close the profile. */
function networkPolicy(network: SandboxPolicy["network"]): string {
	if (network === "enabled") {
		return `; Network: enabled.
(allow network-outbound)
(allow network-inbound)
(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)))
${NETWORK_MACH_LOOKUP}`;
	}
	return `; Network: restricted. No network-outbound or network-inbound rule is present
; in this profile, and the base policy starts from (deny default), so the
; sandboxed process has no route off the machine.`;
}

/**
 * The profile for an unconfined filesystem under a restricted network: every
 * read and every write, no network. Reached only by the branch documented on
 * `buildSeatbeltArgs`; the fully-unconfined case returns the command instead.
 */
function unconfinedProfile(): string {
	return `${BASE_POLICY}
(allow file-read*)
(allow file-write*)
${networkPolicy("restricted")}`;
}

// Long-form design notes: docs/dev/sandbox.md
/** Directory ancestors of every protected path and every denied path that sit inside a writable root. */
function protectedAncestors(policy: SandboxPolicy): SeatbeltParam[] {
	const writable = policy.fileSystem.entries.filter((entry) => canWrite(entry.access)).map((entry) => entry.path);
	const carved = [
		...policy.protected,
		...policy.fileSystem.entries.filter((entry) => entry.access === "deny").map((entry) => entry.path),
	];

	const ancestors = new Set<string>();
	for (const path of carved) {
		const root = writable.find((candidate) => isAtOrBelow(parentOf(path), candidate));
		if (root === undefined) continue;
		for (const ancestor of ancestorsUpTo(parentOf(path), root)) ancestors.add(ancestor);
	}

	// Sorted so the `-D` indices are a function of the policy rather than of
	// `Set` insertion order.
	return [...ancestors].sort().map((value, index) => ({ key: `PROTECTED_ANCESTOR_${index}`, value }));
}

/**
 * `path` and its parent directories, stopping once the walk leaves `root`.
 *
 * With `/w/repo` writable and `/w/repo/sub/.git` protected this yields
 * `["/w/repo/sub", "/w/repo"]` — the root itself included, because renaming the
 * writable root moves the protected directory just as effectively.
 */
function ancestorsUpTo(path: string, root: string): string[] {
	const chain: string[] = [];
	let current = path;
	// Two conditions, both load-bearing: the ordinary exit from the walk, and a
	// no-progress backstop for a writable root of `/`, which oscillates forever.
	// Long-form design notes: docs/dev/sandbox.md
	while (isAtOrBelow(current, root)) {
		chain.push(current);
		const parent = parentOf(current);
		if (parent === current || parent === "") break;
		current = parent;
	}
	return chain;
}

// Long-form design notes: docs/dev/sandbox.md
/** The containing directory of an absolute path. Returns a string, never `undefined`; the root yields `""`. */
function parentOf(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	const index = trimmed.lastIndexOf("/");
	if (index < 0) return trimmed;
	return index === 0 ? "/" : trimmed.slice(0, index);
}

/**
 * Whether `candidate` is `root` or sits inside it, on already-canonical absolute
 * paths with forward slashes — the form every producer in this build emits, and
 * the same comparison `isWritePermitted` makes on the other side of this seam.
 * Case is not folded: on a case-sensitive filesystem `Repo` and `repo` are
 * different directories.
 */
function isAtOrBelow(candidate: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}
