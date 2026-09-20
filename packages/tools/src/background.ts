/**
 * Background shell manager: long-running commands (dev servers, watchers)
 * started by the Bash tool with run_in_background. Output streams to a temp
 * file; BashOutput tails it, KillBash terminates the process tree.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectShell } from "./operations.ts";

/** How much of a shell's log one read may bring back. */
const MAX_SHELL_OUTPUT_CHARS = 30_000;

/**
 * The last `maxChars` characters of a file, without reading the whole thing.
 *
 * One character is at most four UTF-8 bytes, so a window of `4 * maxChars`
 * bytes always holds at least that many characters: the last `maxChars` of what
 * it decodes are the last `maxChars` of the file, and everything before them
 * never had to be read. A window that opens in the middle of a character
 * decodes its leftover bytes as a replacement character — at the front of the
 * window, ahead of everything kept, so the text that comes back is a suffix of
 * the file and made of characters the file contains.
 */
export function readTail(path: string, maxChars: number): { text: string; truncated: boolean; bytes: number } {
	const bytes = statSync(path).size;
	const window = Math.min(bytes, maxChars * 4);
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(window);
		const read = readSync(fd, buffer, 0, window, bytes - window);
		const text = buffer.subarray(0, read).toString("utf8");
		const tail = text.length > maxChars ? text.slice(-maxChars) : text;
		// Two ways to have lost something: the window did not cover the file, or
		// it did and the characters in it still did not fit.
		return { text: tail, truncated: bytes > window || tail.length < text.length, bytes };
	} finally {
		closeSync(fd);
	}
}

export type ShellStatus = "running" | "completed" | "killed";

export interface BackgroundShell {
	id: string;
	command: string;
	cwd: string;
	outputFile: string;
	startTime: number;
	status: ShellStatus;
	exitCode: number | null;
}

interface ShellEntry {
	info: BackgroundShell;
	proc: ChildProcess;
}

let shellCounter = 0;

export class BackgroundShellManager {
	readonly #entries = new Map<string, ShellEntry>();
	readonly #shell = detectShell();

	start(command: string, cwd: string): BackgroundShell {
		shellCounter += 1;
		const id = `shell_${shellCounter}`;
		const outputFile = join(tmpdir(), `lbb-${id}.log`);
		writeFileSync(outputFile, "");

		const { command: shellCommand, args } = this.#shell;
		const proc: ChildProcess = spawn(shellCommand, args(command), {
			cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const info: BackgroundShell = {
			id,
			command,
			cwd,
			outputFile,
			startTime: Date.now(),
			status: "running",
			exitCode: null,
		};
		const entry: ShellEntry = { info, proc };
		this.#entries.set(id, entry);

		const append = (chunk: Buffer | string) => {
			try {
				appendFileSync(outputFile, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
			} catch {
				// best-effort logging
			}
		};
		proc.stdout?.setEncoding("utf8");
		proc.stderr?.setEncoding("utf8");
		proc.stdout?.on("data", append);
		proc.stderr?.on("data", append);
		proc.on("error", (error) => {
			append(`\n[spawn error: ${error.message}]`);
			if (info.status !== "killed") info.status = "completed";
			info.exitCode = 127;
		});
		proc.on("close", (code) => {
			if (info.status !== "killed") info.status = "completed";
			info.exitCode = code ?? 0;
			append(`\n[exit code: ${info.exitCode}]`);
		});

		return info;
	}

	get(id: string): BackgroundShell | undefined {
		return this.#entries.get(id)?.info;
	}

	list(): BackgroundShell[] {
		return [...this.#entries.values()].map((e) => e.info);
	}

	/**
	 * The end of a shell's output so far, at most `maxChars` of it.
	 *
	 * A shell is polled while it runs, so the log only ever grows: a dev server
	 * left up for an hour would otherwise be read whole — as bytes and again as
	 * a string — to show the last few lines of it, once per poll. The read
	 * starts at an offset instead, and what it skipped is said out loud along
	 * with the path to the whole thing, because a tail is a window on the log
	 * and not the log.
	 */
	output(id: string, maxChars = MAX_SHELL_OUTPUT_CHARS): string {
		const entry = this.#entries.get(id);
		if (!entry || !existsSync(entry.info.outputFile)) return "";
		const tail = readTail(entry.info.outputFile, maxChars);
		const header = tail.truncated
			? `[log tail: last ${tail.text.length} characters of ${tail.bytes} bytes — full log: ${entry.info.outputFile}]\n`
			: "";
		return `${header}${tail.text}`;
	}

	kill(id: string): boolean {
		const entry = this.#entries.get(id);
		if (entry?.info.status !== "running" || !entry.proc.pid) return false;
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(entry.proc.pid), "/T", "/F"], { windowsHide: true });
			killer.on("error", () => {
				// taskkill itself failed to spawn — fall back to the direct signal so
				// the process doesn't linger while we've already reported it killed.
				entry.proc.kill();
			});
		} else {
			entry.proc.kill();
		}
		entry.info.status = "killed";
		return true;
	}
}
