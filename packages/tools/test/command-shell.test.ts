/**
 * What the Windows command shell receives.
 *
 * Two failures met in the same report. Git installed away from the
 * conventional `C:\Program Files` was not found, because only `git.exe`'s own
 * directory sits on PATH and `bash.exe` lives one level over; every command
 * then ran under cmd.exe. And the way cmd.exe was spawned mangled its quotes:
 * node escaped the inner pair as `\"`, which cmd does not undo, so
 * `cd /d "G:\dir"` died with a syntax error of its own making.
 *
 * The install search is pinned without this machine's PATH, and the fallback
 * shell is exercised through a real cmd.exe even where a POSIX shell is
 * installed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "../src/background.ts";
import { bashFromGitOnPath, ChildProcessExecOperations, detectShell } from "../src/operations.ts";

const win32 = process.platform === "win32";

/** The shell this tool falls back to when it finds no POSIX one. */
const cmdShell = {
	command: process.env.ComSpec ?? "cmd.exe",
	args: (cmd: string) => ["/d", "/s", "/c", cmd],
	cmdExe: true as const,
};

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Run `body` with those environment variables, and put them all back after. */
function withEnv(values: Record<string, string | undefined>, body: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		body();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Poll for a condition, bounded: `false` rather than a hang when it never holds. */
async function until(condition: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return condition();
}

describe("a Git install found through its own git.exe", () => {
	test("a PATH that carries only git.exe still leads to the bash beside it", () => {
		const pathValue = ["C:\\Tools\\Git\\cmd", "C:\\ProgramData\\chocolatey\\bin"].join(";");
		const present = new Set(["C:\\Tools\\Git\\bin\\bash.exe"]);
		expect(bashFromGitOnPath(pathValue, (path) => present.has(path))).toBe("C:\\Tools\\Git\\bin\\bash.exe");
	});

	test("the usr\\bin copy answers when bin does not", () => {
		// A PATH that names Git's mingw64 bin directly still climbs to the
		// install root, where both shipped bash locations hang off.
		const present = new Set(["D:\\Program Files\\Git\\usr\\bin\\bash.exe"]);
		expect(bashFromGitOnPath("D:\\Program Files\\Git\\mingw64\\bin", (path) => present.has(path))).toBe(
			"D:\\Program Files\\Git\\usr\\bin\\bash.exe",
		);
	});

	test("a git.exe with no bash beside it means no guess", () => {
		expect(bashFromGitOnPath("C:\\Windows\\System32", () => false)).toBeUndefined();
		// A POSIX PATH yields no Windows candidates at all.
		expect(bashFromGitOnPath("/usr/local/bin", () => true)).toBeUndefined();
	});

	test("detectShell reaches the install, not just the helper", () => {
		const conventional = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"];
		// The two absolute probes outrank anything staged on PATH, by design.
		if (!win32 || conventional.some((path) => existsSync(path))) return;
		const root = tempDir("lbb-cmd-shell-");
		mkdirSync(join(root, "cmd"), { recursive: true });
		writeFileSync(join(root, "cmd", "git.exe"), "");
		mkdirSync(join(root, "bin"), { recursive: true });
		const bash = join(root, "bin", "bash.exe");
		writeFileSync(bash, "");

		withEnv(
			{
				PATH: join(root, "cmd"),
				LBB_BASH_PATH: undefined,
				USERPROFILE: tempDir("lbb-cmd-home-"),
			},
			() => {
				const shell = detectShell();
				expect(shell.command).toBe(bash);
				// Still a login shell, and no longer the cmd.exe fallback.
				expect(shell.args("echo hi")).toEqual(["-lc", "echo hi"]);
				expect(shell.cmdExe).toBeUndefined();
			},
		);
	});
});

describe("a command reaches cmd.exe with its quotes intact", () => {
	test("the foreground path runs a quoted cd and echo", async () => {
		if (!win32) return;
		const dir = tempDir("lbb-cmd-quote-");
		const spaced = join(dir, "a dir with spaces");
		mkdirSync(spaced, { recursive: true });
		const ops = new ChildProcessExecOperations(undefined, cmdShell);
		const result = await ops.exec({
			command: `cd /d "${spaced}" && echo "hi there"`,
			cwd: dir,
			timeoutMs: 20_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('"hi there"');
		expect(result.stdout).not.toContain('\\"');
		expect(result.stderr).toBe("");
	}, 30_000);

	test("the background path runs one too", async () => {
		if (!win32) return;
		const manager = new BackgroundShellManager(undefined, undefined, cmdShell);
		const shell = await manager.start('echo "hi there"', tempDir("lbb-cmd-bg-"));
		expect(await until(() => manager.get(shell.id)?.status === "completed", 10_000)).toBe(true);
		const log = readFileSync(shell.outputFile, "utf8");
		expect(log).toContain('"hi there"');
		expect(log).not.toContain('\\"');
		expect(log).toContain("[exit code: 0]");
	}, 20_000);
});
