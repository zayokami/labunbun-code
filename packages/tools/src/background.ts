/**
 * Background shell manager: long-running commands (dev servers, watchers)
 * started by the Bash tool with run_in_background. Output streams to a temp
 * file; BashOutput tails it, KillBash terminates the process tree.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectShell } from "./operations.ts";

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

	/** Read the full output so far (tail-capped). */
	output(id: string, maxChars = 30_000): string {
		const entry = this.#entries.get(id);
		if (!entry || !existsSync(entry.info.outputFile)) return "";
		const text = readFileSync(entry.info.outputFile, "utf8");
		return text.length > maxChars ? `...[truncated]...\n${text.slice(-maxChars)}` : text;
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
