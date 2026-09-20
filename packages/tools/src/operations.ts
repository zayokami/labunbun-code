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
	}): Promise<ExecResult>;
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

	exec(options: {
		command: string;
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: Record<string, string>;
		onOutput?: (chunk: string) => void;
	}): Promise<ExecResult> {
		const { command, cwd, timeoutMs = 120_000, signal, env, onOutput } = options;
		const { command: shellCommand, args } = this.#shell;

		return new Promise((resolve) => {
			const child = spawn(shellCommand, args(command), {
				cwd,
				windowsHide: true,
				env: env ? { ...process.env, ...env } : process.env,
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
