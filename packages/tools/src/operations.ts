/**
 * Operations abstraction — the FS/exec backend behind every built-in tool.
 *
 * Tools depend on these interfaces rather than node:fs/Bun.spawn directly,
 * which makes them unit-testable with in-memory fakes and lets a future
 * remote/container backend slot in without touching tool logic.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxPolicy } from "@labunbun/agent";
import { createStreamCapture, nextSpillPath } from "./output-capture.ts";
import {
	acquireWorkspaceGrant,
	canonicalPathForChild,
	confinedCommandLine,
	confinedEnvBlock,
	confinedProgramName,
	containerCanExecute,
	releaseWorkspaceGrant,
	runConfined,
} from "./sandbox/appcontainer.ts";
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

// Long-form design notes: docs/dev/tools.md
/** How much of each captured stream stays in memory: a head and a tail of this many characters. */
const CAPTURE_HEAD_CHARS = 30_000;
const CAPTURE_TAIL_CHARS = 30_000;

export interface ExecResult {
	stdout: string;
	stderr: string;
	/**
	 * The exit code, or `null` for a call that ended without the command ending —
	 * a process handed over at its timeout. A decoy `0` here would say the
	 * command succeeded, and what it went on to do is the adopter's to report.
	 */
	exitCode: number | null;
	killed: boolean;
	/**
	 * True when the timeout elapsed and the caller's `onTimeout` took the live
	 * process over instead of the timeout killing it. `exitCode` is `null` then.
	 */
	handedOff?: boolean;
	// Long-form design notes: docs/dev/tools.md
	/** Set when the output outgrew the capture bound and the whole stream went to a file. */
	spill?: { path: string; chars: number };
}

/** A live process, handed to the caller at the moment its wait expired. */
export interface ExecHandoff {
	child: ChildProcess;
	/** Kills the whole process tree — the same function the timeout would have called. */
	killTree: () => void;
	/** When the process was spawned; elapsed time counts from here, not from the handoff. */
	startedAt: number;
	/**
	 * What the command had printed by the moment of the handoff — bounded text
	 * when the call had a capture (`spillDir`), with `ExecResult.spill` naming
	 * where the rest went; the adopter opens its log with exactly these.
	 */
	stdout: string;
	stderr: string;
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
		// Long-form design notes: docs/dev/tools.md
		/** Take the process over when `timeoutMs` elapses, instead of killing it. */
		onTimeout?: (handoff: ExecHandoff) => void;
		// Long-form design notes: docs/dev/tools.md
		/** A confinement policy to put around the shell, or `undefined` for none. */
		sandbox?: SandboxPolicy;
		// Long-form design notes: docs/dev/tools.md
		/** Where a command's output goes once it outgrows the in-memory capture; presence turns the capture on. */
		spillDir?: string;
	}): Promise<ExecResult>;

	// Long-form design notes: docs/dev/tools.md
	/** The proxy variables a child under `policy` needs, or `undefined` when the policy confines no network. */
	networkEnvFor?(policy: SandboxPolicy): Promise<Record<string, string> | undefined>;

	// Long-form design notes: docs/dev/tools.md
	/** What confines commands run through here, when this implementation knows. */
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

// Long-form design notes: docs/dev/tools.md
/** Whether a `bash.exe` found on PATH is Windows' own WSL launcher. */
function isWindowsBash(path: string): boolean {
	const normalized = path.toLowerCase().replace(/\//g, "\\");
	const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
	if (normalized.startsWith(`${systemRoot.toLowerCase().replace(/\//g, "\\")}\\system32\\`)) return true;
	return normalized.includes("\\microsoft\\windowsapps\\");
}

// Long-form design notes: docs/dev/tools.md
/** Every PATH directory that could hold an executable by that name, in order. */
function* pathCandidates(name: string): Generator<string> {
	for (const entry of (process.env.PATH ?? "").split(";")) {
		const dir = entry.trim().replace(/^"|"$/g, "");
		if (!/^[A-Za-z]:[\\/]/.test(dir)) continue;
		yield join(dir, name);
	}
}

// Long-form design notes: docs/dev/tools.md
/** Shell resolution: a POSIX-compatible shell on Windows when one exists, else `cmd.exe`; `/bin/bash` elsewhere. */
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

// Long-form design notes: docs/dev/tools.md
/** Everything a proxy is built from, as one comparable string. */
function proxyPolicyKey(policy: SandboxPolicy): string {
	return JSON.stringify([policy.network, (policy.networkRules ?? []).map((rule) => [rule.permission, rule.pattern])]);
}

// Long-form design notes: docs/dev/tools.md
/** The bounded capture `exec` runs when it was given a spill directory. */
function createExecCapture(dir: string) {
	let file: { fd: number; path: string } | null = null;
	let broken = false;

	const open = (prefix: string) => {
		try {
			mkdirSync(dir, { recursive: true });
			const path = nextSpillPath(dir, "exec");
			const fd = openSync(path, "w");
			file = { fd, path };
			writeSync(fd, prefix);
		} catch {
			// No file, or one not worth pointing at. The result reports no spill
			// and carries the bounded text, which is all that can honestly be
			// said; a path to a half-written file would be worse than none.
			broken = true;
		}
	};

	const append = (chunk: string) => {
		if (!file || broken) return;
		try {
			writeSync(file.fd, chunk);
		} catch {
			broken = true;
		}
	};

	const out = createStreamCapture(CAPTURE_HEAD_CHARS, CAPTURE_TAIL_CHARS);
	const err = createStreamCapture(CAPTURE_HEAD_CHARS, CAPTURE_TAIL_CHARS);
	const combined = createStreamCapture(CAPTURE_HEAD_CHARS, CAPTURE_TAIL_CHARS, {
		overflow: open,
		chunk: append,
	});

	return {
		pushOut(chunk: string): void {
			combined.push(chunk);
			out.push(chunk);
		},
		pushErr(chunk: string): void {
			combined.push(chunk);
			err.push(chunk);
		},
		/**
		 * Ends the capture: closes the file and decides whether it is worth
		 * keeping. One call per outcome — the timeout snapshot and the final
		 * settlement share one — because closing a file is not repeatable.
		 */
		assemble(): { stdout: string; stderr: string; spill?: ExecResult["spill"] } {
			const outResult = out.finish();
			const errResult = err.finish();
			const closed = file;
			file = null;
			if (!closed) return { stdout: outResult.text, stderr: errResult.text };
			try {
				closeSync(closed.fd);
			} catch {
				// Nothing left to do about an fd that will not close; the content
				// question is decided below either way.
			}
			if (!broken && (outResult.dropped > 0 || errResult.dropped > 0)) {
				return {
					stdout: outResult.text,
					stderr: errResult.text,
					spill: { path: closed.path, chars: outResult.total + errResult.total },
				};
			}
			// Deleted for one of two reasons: the text already holds the whole output,
			// or the file is broken. Both are best effort.
			// Long-form design notes: docs/dev/tools.md
			try {
				unlinkSync(closed.path);
			} catch {
				// Leftover for the retention sweep, not an error worth failing on.
			}
			return { stdout: outResult.text, stderr: errResult.text };
		},
	};
}

export class ChildProcessExecOperations implements ExecOperations {
	#shell: ReturnType<typeof detectShell>;
	// Long-form design notes: docs/dev/tools.md
	/** What this machine can confine with, asked once at construction. */
	readonly #runtime: SandboxRuntime;

	// Long-form design notes: docs/dev/tools.md
	/** One proxy per policy a session has run under, keyed by `proxyPolicyKey`. */
	#proxies = new Map<string, NetworkProxy | null>();
	#starting: Promise<NetworkProxy | undefined> | undefined;
	// Long-form design notes: docs/dev/tools.md
	/** Bumped by `close`, so a start that was already in flight can tell that it is late. */
	#epoch = 0;

	// Long-form design notes: docs/dev/tools.md
	/** `runtime` and `shell` are injectable, so tests assert the branches and not the machine's own layout. */
	constructor(runtime: SandboxRuntime = detectRuntime(), shell: ReturnType<typeof detectShell> = detectShell()) {
		this.#runtime = runtime;
		this.#shell = shell;
	}

	// Long-form design notes: docs/dev/tools.md
	/** Whether a proxy is listening right now. */
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

	// Long-form design notes: docs/dev/tools.md
	/** The proxy for `policy`, or `undefined` when the policy confines nothing. */
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

	// Long-form design notes: docs/dev/tools.md
	/** What confines a command on this machine. */
	get sandboxBackend(): SandboxBackend {
		// The third argument is the same fact the resolver takes, read from the
		// same runtime: the sentence `/permissions` prints and the branch the
		// argv comes from have to be answers to one question. A runtime that
		// does not claim the backend reports `simulated`, which is what
		// production still runs.
		return sandboxBackendFor(this.#runtime.platform, this.#runtime.hasNativeBackend, this.#runtime.hasAppContainer);
	}

	async exec(options: {
		command: string;
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: Record<string, string>;
		onOutput?: (chunk: string) => void;
		onTimeout?: (handoff: ExecHandoff) => void;
		sandbox?: SandboxPolicy;
		spillDir?: string;
	}): Promise<ExecResult> {
		const { command, cwd, timeoutMs = 120_000, signal, env, onOutput, onTimeout, sandbox, spillDir } = options;
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
					hasAppContainer: this.#runtime.hasAppContainer,
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

		// The container path's view of the child environment, with the `undefined`
		// pseudo-variables of `process.env` dropped for the env block.
		// Long-form design notes: docs/dev/tools.md
		const confinedEnv = Object.fromEntries(
			Object.entries(childEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
		);

		// The Windows container path: the shell argv, the child environment, and
		// the grant roots are all decided by now, and this branch never falls
		// through to the plain spawn below.
		// Long-form design notes: docs/dev/tools.md
		if (resolution.kind === "appcontainer") {
			// Refuse before the grant is acquired when this session's shell cannot
			// execute inside the container; fail closed.
			// Long-form design notes: docs/dev/tools.md
			const shellProgram = confinedProgramName(shellCommand);
			if (!containerCanExecute(shellProgram, resolution.grantRoots)) {
				return {
					stdout: "",
					stderr: `the Windows container sandbox cannot run this session's shell: ${shellProgram} is not in C:\\Windows\\System32 and not inside a granted root, so the confined child could not execute it. Turn the sandbox off for this session, or point the shell (LBB_BASH_PATH) at a path inside a granted root.`,
					exitCode: -1,
					killed: false,
				};
			}
			const grant = acquireWorkspaceGrant(resolution.workspace, resolution.network, resolution.grantRoots.slice(1));
			if (grant.error !== undefined || grant.profile === undefined) {
				// Fail closed and legibly: no grant means the child could not
				// touch the workspace at all, which is a worse command than a
				// command that fails before it starts.
				return {
					stdout: "",
					stderr: grant.error ?? "the container profile could not be established",
					exitCode: -1,
					killed: false,
				};
			}
			// The child's environment: the parent's, the caller's overrides, and
			// the block format `CreateProcessW` demands, all from the one value
			// defined above — `confinedEnv` is that value with the undefined
			// pseudo-variables removed, for the reason given where it is built.
			const envBlock = confinedEnvBlock(confinedEnv);
			// Declared outside the try so the `finally` can append the cleanup
			// error to whatever result the run produced, without the run's own
			// assignment having to know the cleanup exists.
			let result: ExecResult = { stdout: "", stderr: "", exitCode: -1, killed: false };
			try {
				// The child's cwd, spelled the one way every reader agrees on — the
				// same canonicalisation the grant roots get, and for the same measured
				// reason: on the GitHub Windows runner the workspace is short-named
				// (`RUNNER~1`) and a confined powershell whose cwd it was died with
				// .NET's `Access to the path ... is denied` — the runtime resolves
				// its cwd itself at start-up, and it resolved a spelling the ACE did
				// not cover. Best-effort: an unresolvable cwd is handed over spelled.
				const confined = runConfined(grant.profile, confinedCommandLine([shellProgram, ...args(command)]), {
					cwd: canonicalPathForChild(cwd),
					env: envBlock,
					timeoutMs,
					signal,
					onStdout: (chunk) => onOutput?.(chunk),
					onStderr: (chunk) => onOutput?.(chunk),
				});
				if (confined.error !== undefined) {
					// The run ended by kill or never started. Either way the
					// numbers alone would read as a command that ran, so the
					// reason travels in stderr where the tool puts it.
					result = {
						stdout: confined.stdout,
						stderr: confined.error,
						exitCode: confined.exitCode,
						killed: confined.killed,
					};
				} else {
					result = { stdout: confined.stdout, stderr: confined.stderr, exitCode: confined.exitCode, killed: false };
				}
			} finally {
				const dropError = releaseWorkspaceGrant(resolution.workspace, resolution.network);
				// A failed cleanup is reported, not thrown: the command already
				// ran and its exit code is what the caller acts on, so raising
				// here would turn a successful command into an exception. The
				// warning rides along on the same result, appended to stderr,
				// because that is where the tool surfaces it. A leftover ACE
				// names the container SID — which the next run derives again —
				// so it is reusable rather than dangerous.
				if (dropError !== null && dropError !== "") {
					result.stderr = result.stderr === "" ? dropError : `${result.stderr}\n${dropError}`;
				}
			}
			return result;
		}

		return new Promise((resolve) => {
			const startedAt = Date.now();
			const child = spawn(program, programArgs, {
				cwd,
				windowsHide: true,
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});

			// The unbounded strings, kept only when there is no capture; the capture
			// is what a spilled call accumulates into instead, and the two never
			// both fill.
			let stdout = "";
			let stderr = "";
			let killed = false;
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | null = null;
			const capture = spillDir ? createExecCapture(spillDir) : null;

			const killTree = () => {
				if (process.platform === "win32" && child.pid) {
					spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
				} else {
					child.kill();
				}
			};

			const onAbort = () => {
				killed = true;
				killTree();
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			/** The one exit from this call: whichever path arrives first decides, the rest are no-ops. */
			const settle = (result: ExecResult) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};

			// The guard in front is about the capture, not about `settle`: the
			// argument is built before `settle` can look at it, and assembling
			// ends a capture (closes its file), so a second call — the error
			// event's finish after a timeout already settled, say — must not
			// reach it.
			const finish = (exitCode: number) => {
				if (settled) return;
				settle(capture ? { ...capture.assemble(), exitCode, killed } : { stdout, stderr, exitCode, killed });
			};

			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					if (!onTimeout) {
						killed = true;
						killTree();
						return;
					}
					// The handoff runs before the promise settles, so the callback owns
					// the process by the time the caller resumes and no chunk falls
					// between the two. `settle` detaches the abort listener in the same
					// turn: a process an embedder has adopted must not die when some
					// later turn's signal fires.
					//
					// One snapshot, used twice: the adopter's log opens with exactly
					// what the result carries, and a capture is assembled exactly once.
					const snapshot = capture ? capture.assemble() : { stdout, stderr };
					onTimeout({ child, killTree, startedAt, stdout: snapshot.stdout, stderr: snapshot.stderr });
					settle({ ...snapshot, exitCode: null, killed: false, handedOff: true });
				}, timeoutMs);
			}

			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				// Once handed off, this call's windows on the streams belong to the
				// adopter's log: chunks still forward through `onOutput`, but
				// accumulating them here would grow without bound for the life of a
				// server nobody is waiting on anymore. A settled capture is frozen
				// the same way — the adopter owns the stream past the handoff.
				if (!settled) {
					if (capture) capture.pushOut(chunk);
					else stdout += chunk;
				}
				onOutput?.(chunk);
			});
			child.stderr.on("data", (chunk: string) => {
				if (!settled) {
					if (capture) capture.pushErr(chunk);
					else stderr += chunk;
				}
				onOutput?.(chunk);
			});
			child.on("error", (error) => {
				const note = String(error);
				// Through the capture when there is one, so the error lands in the
				// spill file in arrival order like everything else — and so the
				// result's own text shows it with the marker if the window let it
				// go.
				if (capture) capture.pushErr(note);
				else stderr += note;
				finish(127);
			});
			child.on("close", (code) => finish(killed ? 124 : (code ?? 0)));
		});
	}
}

// Long-form design notes: docs/dev/tools.md
/** The operations the app runs on, with the executor's own answers forwarded. */
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
