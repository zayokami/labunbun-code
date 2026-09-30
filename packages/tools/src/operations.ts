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
	 * The lifecycle — one listener, shared between concurrent callers, closed
	 * once — lives here, so a second spawner joins the existing proxy rather than
	 * opening a second one nobody closes.
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
	 * The proxy, started on the first command that needs one and kept until
	 * {@link close}.
	 *
	 * A single instance rather than one per command: the rules and the listening
	 * port belong to the session, and a fresh proxy per command would mean a fresh
	 * loopback port per command — which reads to a child process as "my network
	 * configuration is changing underneath me", and breaks anything that caches
	 * the proxy URL. It is created lazily because the common case (`network:
	 * enabled`, no rules) must not pay for a listening socket, and `close` exists
	 * because a proxy nobody tears down is a socket nobody owns.
	 */
	#proxy: NetworkProxy | undefined;
	#starting: Promise<NetworkProxy | undefined> | undefined;

	constructor(runtime: SandboxRuntime = detectRuntime()) {
		this.#runtime = runtime;
	}

	/** Whether a proxy is listening right now. For tests and for `/doctor`. */
	get networkProxyRunning(): boolean {
		return this.#proxy !== undefined;
	}

	/**
	 * Stop the proxy, if one was ever started.
	 *
	 * Called on shutdown. Safe to call twice and safe to call when no command
	 * ever needed one.
	 */
	async close(): Promise<void> {
		const proxy = this.#proxy;
		this.#proxy = undefined;
		this.#starting = undefined;
		await proxy?.close();
	}

	/**
	 * The proxy for `policy`, or `undefined` when the policy confines nothing.
	 *
	 * Two callers racing here must not start two listeners, so the in-flight
	 * promise is shared rather than each awaiting its own `startNetworkProxy`.
	 * A start that fails clears the slot: leaving a rejected promise cached
	 * would turn one transient `EADDRNOTAVAIL` into a permanently broken
	 * `exec`, and the next command would retry the same way the first did.
	 */
	async #proxyFor(policy: SandboxPolicy): Promise<NetworkProxy | undefined> {
		if (this.#proxy) return this.#proxy;
		this.#starting ??= startNetworkProxy({
			network: policy.network,
			rules: policy.networkRules,
		}).then((proxy) => {
			this.#proxy = proxy;
			return proxy;
		});
		try {
			return await this.#starting;
		} finally {
			this.#starting = undefined;
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

export function defaultOperations(): Operations {
	const fs = new NodeFileSystemOperations();
	const exec = new ChildProcessExecOperations();
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
	};
}
