/**
 * Operations abstraction — the FS/exec backend behind every built-in tool.
 *
 * Tools depend on these interfaces rather than node:fs/Bun.spawn directly,
 * which makes them unit-testable with in-memory fakes and lets a future
 * remote/container backend slot in without touching tool logic.
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxPolicy } from "@labunbun/agent";
import {
	detectRuntime,
	resolveSandboxExecution,
	type SandboxBackend,
	type SandboxRuntime,
	sandboxBackendFor,
} from "./sandbox/index.ts";
import { type NetworkProxy, startNetworkProxy } from "./sandbox/proxy.ts";

export type { SandboxExecution } from "./sandbox/index.ts";

export interface FileStat {
	size: number;
	isFile: boolean;
	isDirectory: boolean;
	mtimeMs: number;
}

export interface DirentInfo {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
}

export interface FileSystemOperations {
	readTextFile(path: string, encoding?: BufferEncoding): Promise<string>;
	writeTextFile(path: string, content: string): Promise<void>;
	/** Write atomically-ish: temp file + rename (best effort on Windows). */
	writeTextFileAtomic(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	stat(path: string): Promise<FileStat>;
	readdir(path: string): Promise<DirentInfo[]>;
	mkdir(path: string, recursive?: boolean): Promise<void>;
	deleteFile(path: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	killed: boolean;
}

export interface ExecOperations {
	/**
	 * Run a command line through the platform shell. Streams decoded output
	 * chunks to `onOutput` when provided. Never throws on non-zero exit.
	 */
	exec(options: {
		command: string;
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: Record<string, string>;
		onOutput?: (chunk: string) => void;
		/**
		 * A confinement policy to put around the shell, or `undefined` for none.
		 *
		 * Optional because a caller with no sandbox in play is a real case — the
		 * `!` shell passthrough is deliberately outside the mode system — not
		 * because forgetting it should be quiet. When present, this resolves the
		 * platform's backend and wraps the shell with it; `sandboxBackend` on the
		 * implementation says which backend that turned out to be, including the
		 * cases where the answer is "none, and here is why".
		 */
		sandbox?: SandboxPolicy;
	}): Promise<ExecResult>;

	/**
	 * The proxy variables a child spawned under `policy` needs for its traffic to
	 * be confined, or `undefined` when the policy confines no network.
	 *
	 * This exists because `exec` is not the only thing that spawns a shell. The
	 * background manager spawns one directly, and for as long as the proxy
	 * lifecycle was a private detail of this class, that second spawn path
	 * resolved the policy's *filesystem* half and quietly dropped its network
	 * half: the domain table is enforced by the proxy alone, so
	 * `run_in_background: true` was a one-word way around the whole network axis
	 * while every foreground command looked correctly confined.
	 *
	 * The lifecycle — one listener **per policy**, shared between concurrent
	 * callers, all closed together — lives here, so a second spawner joins the
	 * existing proxy rather than opening a second one nobody closes. "Per policy"
	 * is not padding: a single shared listener would be one set of rules for the
	 * whole session, which is the hole that made the first restricted command
	 * decide destinations for every command after it.
	 *
	 * Optional because a fake or an embedder's own executor may confine nothing
	 * and have nothing to share, not because a missing answer may be read
	 * optimistically: a caller with no answer injects nothing, which is the
	 * direction that fails open, so a real executor that confines a network has
	 * to answer this.
	 */
	networkEnvFor?(policy: SandboxPolicy): Promise<Record<string, string> | undefined>;

	/**
	 * What confines commands run through here, when this implementation knows.
	 *
	 * Optional because a fake or an embedder's own executor may have no backend to
	 * report, not because a missing answer may be read optimistically: an absent
	 * backend renders as "simulated", so forgetting it is the safe direction to
	 * fail in.
	 */
	readonly sandboxBackend?: SandboxBackend;
}

export type Operations = FileSystemOperations & ExecOperations;

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

export class NodeFileSystemOperations implements FileSystemOperations {
	async readTextFile(path: string, encoding: BufferEncoding = "utf8"): Promise<string> {
		return readFile(path, encoding);
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		await writeFile(path, content, "utf8");
	}

	async writeTextFileAtomic(path: string, content: string): Promise<void> {
		const tmp = `${path}.lbb-tmp-${Date.now()}`;
		await writeFile(tmp, content, "utf8");
		try {
			await rename(tmp, path);
		} catch {
			// Windows rename-over-existing can fail on some filesystems.
			await writeFile(path, content, "utf8");
			await unlink(tmp).catch(() => {});
		}
	}

	async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<FileStat> {
		const s = await stat(path);
		return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs };
	}

	async readdir(path: string): Promise<DirentInfo[]> {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((e) => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
	}

	async mkdir(path: string, recursive = true): Promise<void> {
		await mkdir(path, { recursive });
	}

	async deleteFile(path: string): Promise<void> {
		await unlink(path);
	}

	async move(from: string, to: string): Promise<void> {
		await rename(from, to);
	}
}

/** A path that exists and is a file — a directory named `bash.exe` is not one. */
function isFileSync(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Whether a `bash.exe` found on PATH is Windows' own — the WSL launcher.
 *
 * It answers to the same name and sits in directories that are on every PATH,
 * but it starts a Linux VM: every command this tool runs names Windows paths,
 * and a shell that resolves them somewhere else is not the shell it promises.
 * Only PATH-derived candidates are held to this: `LBB_BASH_PATH` is a user
 * saying "this one", and that is the end of the question.
 */
function isWindowsBash(path: string): boolean {
	const normalized = path.toLowerCase().replace(/\//g, "\\");
	const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	if (normalized.startsWith(`${systemRoot.toLowerCase().replace(/\//g, "\\")}\\system32\\`)) return true;
	return normalized.includes("\\microsoft\\windowsapps\\");
}

/**
 * Every PATH directory that could hold an executable by that name, in order.
 *
 * Only drive-anchored entries are searched: a shell that is itself MSYS hands
 * its children a PATH made of POSIX paths (`/usr/bin`), which no Windows
 * process can open — the same directories are behind them under their real
 * names, so nothing is lost by skipping the ones that cannot be opened.
 */
function* pathCandidates(name: string): Generator<string> {
	for (const entry of (process.env.PATH ?? "").split(";")) {
		const dir = entry.trim().replace(/^"|"$/g, "");
		if (!/^[A-Za-z]:[\\/]/.test(dir)) continue;
		yield join(dir, name);
	}
}

/**
 * Shell resolution: prefer a POSIX-compatible shell (Git Bash / MSYS2) on
 * Windows since most agent commands assume POSIX syntax; fall back to cmd.
 *
 * The conventional locations are answered first — that install is a deliberate
 * one, and it is where the user pointed us if they set `LBB_BASH_PATH`. PATH
 * is the long tail: an install under scoop, chocolatey, or simply on another
 * drive was, before this, a machine where every command quietly ran through
 * cmd.exe instead, and the tool's POSIX-shaped commands failed one at a time.
 */
export function detectShell(): { command: string; args: (cmd: string) => string[] } {
	if (process.platform === "win32") {
		const conventional = [
			process.env.LBB_BASH_PATH,
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
			`${process.env.USERPROFILE ?? ""}\\.bun\\bin\\bash.exe`,
		].filter(Boolean) as string[];
		for (const candidate of conventional) {
			if (isFileSync(candidate)) return { command: candidate, args: (cmd) => ["-lc", cmd] };
		}
		for (const candidate of pathCandidates("bash.exe")) {
			if (isWindowsBash(candidate)) continue;
			if (isFileSync(candidate)) return { command: candidate, args: (cmd) => ["-lc", cmd] };
		}
		return { command: "cmd.exe", args: (cmd) => ["/d", "/s", "/c", cmd] };
	}
	return { command: "/bin/bash", args: (cmd) => ["-c", cmd] };
}

/**
 * Everything a proxy is built from, as one comparable string.
 *
 * A proxy closes over the rules it was started with, so this string is the whole
 * question "may I reuse the proxy I have?" — and the reason the answer has to
 * include the rules is the hole it closes: without it, the first restricted
 * command of a session decided the destination policy for every command after
 * it, and narrowing an allowlist mid-session silently did nothing.
 *
 * JSON rather than a hand-joined string, because a joined one is ambiguous.
 * Join each rule as `permission:pattern` with a space between rules and
 * `[{allow,"x"},{allow,"y"}]` and `[{allow,"x allow:y"}]` both render
 * `allow:x allow:y` — two different allowlists, one key, and the second one
 * would be run under the first one's rules. That needs an odd pattern to reach,
 * but the cost of the unambiguous form is one `JSON.stringify` per command and
 * the cost of the other one is a policy that is not the policy.
 *
 * Rules are left in order, **not sorted**. Sorting would make two tables that
 * differ only in order collide, and whether the decision function cares about
 * order is not this file's to assume — a needless rebuild costs one listener, a
 * missed one costs enforcement. Same reasoning for not normalising case or
 * trimming.
 */
function proxyPolicyKey(policy: SandboxPolicy): string {
	return JSON.stringify([policy.network, (policy.networkRules ?? []).map((rule) => [rule.permission, rule.pattern])]);
}

export class ChildProcessExecOperations implements ExecOperations {
	#shell = detectShell();
	/**
	 * What this machine can confine with, asked once at construction.
	 *
	 * A PATH scan per command would be pure waste, and the answer does not change
	 * while the process runs. Injectable so the wrapping branch is reachable from
	 * a test on a machine that is not the one it wraps for — see
	 * `sandbox-wiring.test.ts`, where a fake Linux runtime is the only thing that
	 * makes "the wrapper is really around the shell" an assertion rather than a
	 * hope.
	 */
	readonly #runtime: SandboxRuntime;

	/**
	 * One proxy per policy a session has run under, keyed by `proxyPolicyKey`.
	 *
	 * A single shared instance rather than one per command: the rules and the
	 * listening port belong to the session, and a fresh proxy per command would
	 * mean a fresh loopback port per command — which reads to a child process as
	 * "my network configuration is changing underneath me", and breaks anything
	 * that caches the proxy URL. It is created lazily because the common case
	 * (`network: enabled`, no rules) must not pay for a listening socket, and
	 * `close` exists because a proxy nobody tears down is a socket nobody owns.
	 *
	 * **Keyed by the policy, and the key is the fix.** It used to be a single
	 * unkeyed slot, and that made the first restricted command of a session the
	 * authority on destinations for every command after it: the proxy closes over
	 * the rules it was built with, so narrowing an allowlist mid-session changed
	 * nothing, because the narrowing policy was never consulted. The direction is
	 * the bad one — the policy that survives is the older and usually the broader
	 * of the two, so this fails open. `sandbox-wiring.test.ts` measures it.
	 *
	 * A `null` value is a remembered *answer*, not a missing one: `network: enabled`
	 * with no rules starts nothing, so an unrestricted session would otherwise
	 * re-enter `startNetworkProxy` — and re-ask `needsNetworkProxy` — once per
	 * command. **That is an optimisation with no observable difference**, and it is
	 * written here as one so that nobody later builds an assertion on it: there is
	 * no injection seam that could count the calls, and `networkProxyRunning` is
	 * false either way. Removing the `null` costs one function call per command and
	 * breaks nothing.
	 *
	 * Every proxy stays live until {@link close} rather than being retired when a
	 * newer one arrives, because `NetworkProxy.close` destroys every connection
	 * the proxy has open and a command started under the previous policy may still
	 * be running with that port in its environment. Keeping them all also means a
	 * session that flips between two policies twice does not churn four listeners.
	 *
	 * The map grows with the number of *distinct* policies, which is one per
	 * allowlist edit rather than one per command. That is a resource characteristic,
	 * not a bound, and it is written down here rather than hidden behind an eviction
	 * rule — eviction would have to close a proxy something may still be using,
	 * which is the problem the previous paragraph is about.
	 */
	#proxies = new Map<string, NetworkProxy | null>();
	#starting: Promise<NetworkProxy | undefined> | undefined;
	/**
	 * Bumped by {@link close}, so a start that was already in flight when close
	 * ran can tell that it is late.
	 *
	 * `close` clears the map, but it cannot un-start a listener that has not been
	 * listening yet. Without this the late start installs itself into the empty map
	 * and there is a proxy on a port nothing will ever close — the same leak `close`
	 * exists to prevent, reachable by quitting during a slow listen.
	 */
	#epoch = 0;

	constructor(runtime: SandboxRuntime = detectRuntime()) {
		this.#runtime = runtime;
	}

	/**
	 * Whether a proxy is listening right now.
	 *
	 * Skips the remembered `null` answers, because this asks "is a socket open",
	 * not "is the cache warm". The tests read it to assert that a confined command
	 * left exactly one listener behind and that `close` took it away; nothing in
	 * the running app reads it. It used to claim `/doctor` does, which was not true
	 * of any code in this repo.
	 */
	get networkProxyRunning(): boolean {
		for (const proxy of this.#proxies.values()) if (proxy) return true;
		return false;
	}

	/**
	 * Stop every proxy this executor ever started.
	 *
	 * Called on shutdown. Safe to call twice and safe to call when no command ever
	 * needed one. All of them, not just the newest: leaving one listening would
	 * keep the process alive on a port nothing is going to close.
	 */
	async close(): Promise<void> {
		const proxies = [...this.#proxies.values()].filter((proxy) => proxy !== null);
		this.#proxies.clear();
		this.#starting = undefined;
		this.#epoch++;
		await Promise.all(proxies.map((proxy) => proxy.close()));
	}

	/**
	 * The proxy for `policy`, or `undefined` when the policy confines nothing.
	 *
	 * Two callers arriving together under the same policy must not start two
	 * listeners, so the in-flight promise is shared. A start that fails clears
	 * the slot: leaving a rejected promise cached would turn one transient
	 * `EADDRNOTAVAIL` into a permanently broken `exec`, and the next command
	 * would retry the same way the first did.
	 *
	 * Callers under *different* policies are serialised rather than run
	 * concurrently. Letting them overlap would mean two writers racing to fill
	 * the map, and the loser's proxy would be installed by whichever start
	 * resolved last — the entry would then name a port built from rules the
	 * next caller's policy did not ask for. Waiting costs one start's latency
	 * in a case that happens once per allowlist edit.
	 */
	async #proxyFor(policy: SandboxPolicy): Promise<NetworkProxy | undefined> {
		const key = proxyPolicyKey(policy);
		const cached = this.#proxies.get(key);
		if (cached !== undefined) return cached ?? undefined;

		// A start already in flight is for *some* policy. Waiting for it costs one
		// listener's startup on a policy change and buys the one property that is
		// hard to get back otherwise: at most one caller is inside `startNetworkProxy`
		// at a time, so two policies cannot race to install and whichever resolves
		// last does not overwrite the other's entry.
		if (this.#starting) {
			try {
				await this.#starting;
			} catch {
				// That start failed and its own caller has already been told so. This
				// one retries under its own key rather than inheriting a dead promise,
				// which is what would make one transient `EADDRNOTAVAIL` permanent.
			}
			const afterWaiting = this.#proxies.get(key);
			if (afterWaiting !== undefined) return afterWaiting ?? undefined;
		}

		const epoch = this.#epoch;
		const starting = startNetworkProxy({
			network: policy.network,
			rules: policy.networkRules,
		});
		this.#starting = starting;
		try {
			const proxy = await starting;
			// `close` ran while this was starting. The caller still needs what it
			// asked for, but caching it would put a listener on a port past the
			// point everything was torn down, so it is closed instead.
			if (this.#epoch !== epoch) {
				await proxy?.close();
				return proxy;
			}
			// `null` for a start that produced nothing, so the unrestricted case is
			// answered from the map rather than re-asked every command.
			this.#proxies.set(key, proxy ?? null);
			return proxy;
		} finally {
			if (this.#starting === starting) this.#starting = undefined;
		}
	}

	/**
	 * The proxy variables for `policy`, or `undefined` when nothing is confined.
	 *
	 * Public because the background manager spawns shells itself and has to reach
	 * the same listener rather than start a second one; the sharing is the point,
	 * so this hands out the environment and keeps the lifecycle private.
	 */
	async networkEnvFor(policy: SandboxPolicy): Promise<Record<string, string> | undefined> {
		return (await this.#proxyFor(policy))?.env;
	}

	/**
	 * What confines a command on this machine.
	 *
	 * Optional on the interface because an embedder's own `Operations` has no
	 * backend to report, and required here because this class always does — a
	 * caller that asked "what is holding my commands in?" must not be told
	 * nothing. `describeSandboxBackend` treats a missing answer as `simulated`.
	 */
	get sandboxBackend(): SandboxBackend {
		return sandboxBackendFor(this.#runtime.platform, this.#runtime.hasNativeBackend);
	}

	async exec(options: {
		command: string;
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: Record<string, string>;
		onOutput?: (chunk: string) => void;
		sandbox?: SandboxPolicy;
	}): Promise<ExecResult> {
		const { command, cwd, timeoutMs = 120_000, signal, env, onOutput, sandbox } = options;
		const { command: shellCommand, args } = this.#shell;

		// The shell is named here and nowhere else, so this is the only place the
		// argv tail a wrapper has to enclose can be built. `resolveSandboxExecution`
		// therefore takes a policy rather than a finished command, and the
		// wrapper ends up *outside* the shell: the confinement is the parent of the
		// process tree rather than something the shell could drop. With no policy
		// this reduces to exactly the two arguments it always was, which is the
		// case the passthrough shell and most tests exercise.
		const resolution = sandbox
			? resolveSandboxExecution({
					policy: sandbox,
					command: [shellCommand, ...args(command)],
					platform: this.#runtime.platform,
					hasNativeBackend: this.#runtime.hasNativeBackend,
				})
			: ({ kind: "unconfined" } as const);
		const [program, ...programArgs] =
			resolution.kind === "native"
				? [resolution.execution.argv[0], ...resolution.execution.argv.slice(1)]
				: [shellCommand, ...args(command)];

		// The proxy's variables go **after** the caller's, not before: a caller
		// that names `HTTP_PROXY` is stating where its traffic goes, and the
		// policy this command is running under is the thing that has to win.
		// A proxy that is not running injects nothing at all, which is what
		// leaves a session that confined nothing with the environment it had.
		const proxyEnv = sandbox ? await this.networkEnvFor(sandbox) : undefined;
		const childEnv = { ...process.env, ...env, ...proxyEnv };

		return new Promise((resolve) => {
			const child = spawn(program, programArgs, {
				cwd,
				windowsHide: true,
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let killed = false;
			let settled = false;

			const killTree = () => {
				if (process.platform === "win32" && child.pid) {
					spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
				} else {
					child.kill();
				}
			};

			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							killed = true;
							killTree();
						}, timeoutMs)
					: null;

			const onAbort = () => {
				killed = true;
				killTree();
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const finish = (exitCode: number) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve({ stdout, stderr, exitCode, killed });
			};

			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				stdout += chunk;
				onOutput?.(chunk);
			});
			child.stderr.on("data", (chunk: string) => {
				stderr += chunk;
				onOutput?.(chunk);
			});
			child.on("error", (error) => {
				stderr += String(error);
				finish(127);
			});
			child.on("close", (code) => finish(killed ? 124 : (code ?? 0)));
		});
	}
}

/**
 * The operations the app runs on.
 *
 * `exec` is a parameter so a caller can name the executor it owns — a test that
 * has to observe the proxy under test cannot, if the object it holds is not the
 * one running commands. It also keeps one listener: everything routed through
 * the returned object shares the executor's proxy rather than each part opening
 * its own. **That is one listener per policy**, which is what makes it safe — a
 * single listener for the whole session would be one set of rules for every
 * command in it, and the first restricted command would decide destinations for
 * all the rest.
 *
 * The executor's own answers are forwarded rather than recomputed here. They
 * used to be dropped, and the drop was invisible in both directions at once:
 * `sandboxBackend` came back `undefined`, so `/permissions` rendered "simulated,
 * not OS-enforced" on every machine — including a Mac with `sandbox-exec`
 * sitting right there — and `networkEnvFor` came back `undefined`, so a spawn
 * that asked this object for the policy's proxy got nothing and ran unconfined.
 */
export function defaultOperations(exec: ChildProcessExecOperations = new ChildProcessExecOperations()): Operations {
	const fs = new NodeFileSystemOperations();
	return {
		readTextFile: (path, encoding) => fs.readTextFile(path, encoding),
		writeTextFile: (path, content) => fs.writeTextFile(path, content),
		writeTextFileAtomic: (path, content) => fs.writeTextFileAtomic(path, content),
		exists: (path) => fs.exists(path),
		stat: (path) => fs.stat(path),
		readdir: (path) => fs.readdir(path),
		mkdir: (path, recursive) => fs.mkdir(path, recursive),
		deleteFile: (path) => fs.deleteFile(path),
		move: (from, to) => fs.move(from, to),
		exec: (options) => exec.exec(options),
		networkEnvFor: (policy) => exec.networkEnvFor(policy),
		sandboxBackend: exec.sandboxBackend,
	};
}
