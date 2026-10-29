/**
 * What the Windows command shell receives.
 *
 * Three failures met in the same report. Git installed away from the
 * conventional `C:\Program Files` was not found, because only `git.exe`'s own
 * directory sits on PATH and `bash.exe` lives one level over; every command
 * then ran under cmd.exe. cmd.exe's quotes were mangled when it was handed the
 * command as an argv item. And the default shell was a POSIX one on a machine
 * whose commands are now written for PowerShell. The order is configured
 * shell, Windows PowerShell, Git Bash, cmd.exe.
 *
 * The install search is pinned without this machine's PATH, and each shell is
 * exercised through its real executable.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundShellManager } from "../src/background.ts";
import { createBashTool, defaultOperations } from "../src/index.ts";
import { bashFromGitOnPath, ChildProcessExecOperations, detectShell, resolveShell } from "../src/operations.ts";

const win32 = process.platform === "win32";

/** A cmd.exe resolution, written by hand so the test does not depend on selection. */
const cmdShell = {
	command: process.env.ComSpec ?? "cmd.exe",
	args: (cmd: string) => ["/d", "/s", "/c", cmd],
	cmdExe: true as const,
};

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Run `body` with those environment variables, and put them all back after. */
async function withEnv<T>(values: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await body();
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

	test("detectShell falls back to the Git install when there is no PowerShell", async () => {
		if (!win32) return;
		const root = tempDir("lbb-cmd-shell-");
		mkdirSync(join(root, "cmd"), { recursive: true });
		writeFileSync(join(root, "cmd", "git.exe"), "");
		mkdirSync(join(root, "bin"), { recursive: true });
		const bash = join(root, "bin", "bash.exe");
		writeFileSync(bash, "");
		const noPowerShell = tempDir("lbb-no-ps-");

		await withEnv(
			{
				PATH: join(root, "cmd"),
				SystemRoot: noPowerShell,
				windir: noPowerShell,
				ProgramFiles: tempDir("lbb-no-git-"),
				"ProgramFiles(x86)": tempDir("lbb-no-git-"),
				LOCALAPPDATA: tempDir("lbb-no-git-"),
				USERPROFILE: tempDir("lbb-cmd-home-"),
				LBB_SHELL_PATH: undefined,
				LBB_BASH_PATH: undefined,
			},
			async () => {
				const shell = detectShell();
				expect(shell.command).toBe(bash);
				expect(shell.kind).toBe("bash");
				// Still a login shell, and no longer the cmd.exe fallback.
				expect(shell.args("echo hi")).toEqual(["-lc", "echo hi"]);
				expect(shell.cmdExe).toBeUndefined();
			},
		);
	});
});

describe("PowerShell is the Windows default", () => {
	test("detectShell answers with a PowerShell -Command script", async () => {
		if (!win32) return;
		await withEnv({ LBB_SHELL_PATH: undefined, LBB_BASH_PATH: undefined }, async () => {
			const shell = detectShell();
			expect(shell.kind).toBe("powershell");
			expect(shell.command.toLowerCase()).toContain("powershell");
			const args = shell.args("Write-Output hi");
			expect(args).toContain("-Command");
			// The exit-code suffix is what makes a native program's failure the
			// tool's failure; without it PowerShell answers 1 for every nonzero.
			expect(args[args.length - 1]).toContain("$LASTEXITCODE");
			expect(shell.cmdExe).toBeUndefined();
		});
	});

	test("the foreground path runs a quoted command with a spaced path", async () => {
		if (!win32) return;
		const dir = tempDir("lbb-ps-quote-");
		const spaced = join(dir, "a dir with spaces");
		mkdirSync(spaced, { recursive: true });
		await withEnv({ LBB_SHELL_PATH: undefined, LBB_BASH_PATH: undefined }, async () => {
			const result = await new ChildProcessExecOperations().exec({
				command: `Set-Location "${spaced}"; (Get-Location).Path; Write-Output "hi there"`,
				cwd: dir,
				timeoutMs: 20_000,
			});
			expect(result.exitCode).toBe(0);
			// The long spelling of the same directory: a runner whose TMP is reached
			// through an 8.3 name (RUNNER~1) has the cwd expanded by PowerShell, and
			// only the native call expands with it — the plain one returns the short
			// name it was handed.
			expect(result.stdout).toContain(realpathSync.native(spaced));
			expect(result.stdout).toContain("hi there");
			expect(result.stdout).not.toContain('\\"');
			expect(result.stderr).toBe("");
		});
	});

	test("a native program's own exit code comes back", async () => {
		if (!win32) return;
		await withEnv({ LBB_SHELL_PATH: undefined, LBB_BASH_PATH: undefined }, async () => {
			const result = await new ChildProcessExecOperations().exec({
				command: "cmd /c exit 3",
				cwd: tempDir("lbb-ps-exit-"),
				timeoutMs: 20_000,
			});
			expect(result.exitCode).toBe(3);
		});
	});

	test("the background path runs one too", async () => {
		if (!win32) return;
		await withEnv({ LBB_SHELL_PATH: undefined, LBB_BASH_PATH: undefined }, async () => {
			const manager = new BackgroundShellManager();
			const shell = await manager.start('Write-Output "hi there"', tempDir("lbb-ps-bg-"));
			expect(await until(() => manager.get(shell.id)?.status === "completed", 10_000)).toBe(true);
			const log = readFileSync(shell.outputFile, "utf8");
			expect(log).toContain("hi there");
			expect(log).not.toContain('\\"');
			expect(log).toContain("[exit code: 0]");
		});
	});

	test("LBB_SHELL_PATH names the shell, and LBB_BASH_PATH remains an alias", async () => {
		if (!win32) return;
		const bash = join(tempDir("lbb-shell-config-"), "bash.exe");
		writeFileSync(bash, "");
		await withEnv({ LBB_SHELL_PATH: bash, LBB_BASH_PATH: undefined }, async () => {
			const shell = detectShell();
			expect(shell.command).toBe(bash);
			expect(shell.kind).toBe("bash");
		});
		await withEnv({ LBB_SHELL_PATH: undefined, LBB_BASH_PATH: bash }, async () => {
			expect(detectShell().command).toBe(bash);
		});
	});

	test("a bare name in LBB_SHELL_PATH is looked up on PATH", async () => {
		if (!win32) return;
		const dir = tempDir("lbb-shell-name-");
		writeFileSync(join(dir, "pwsh.exe"), "");
		await withEnv({ PATH: dir, LBB_SHELL_PATH: "pwsh", LBB_BASH_PATH: undefined }, async () => {
			const shell = detectShell();
			expect(shell.command).toBe(join(dir, "pwsh.exe"));
			expect(shell.kind).toBe("powershell");
		});
	});
});

/**
 * The PowerShells this machine has, by path: Windows PowerShell from System32
 * (always there) and PowerShell 7 when PATH carries it. The wrapper's exit
 * codes were measured on both, and the 5.1 behaviours it works around do not
 * exist on 7, so each assertion has to hold on each.
 */
function installedPowerShells(): Array<[string, string]> {
	if (!win32) return [];
	const found: Array<[string, string]> = [];
	const root = process.env.SystemRoot ?? process.env.windir;
	if (root) found.push(["Windows PowerShell", join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]);
	const pwsh = Bun.which("pwsh.exe");
	if (pwsh) found.push(["PowerShell 7", pwsh]);
	return found;
}

describe.each(installedPowerShells())("the wrapper's exit code in %s follows the last statement", (_name, program) => {
	const run = (command: string) =>
		new ChildProcessExecOperations(undefined, resolveShell(program)).exec({
			command,
			cwd: tempDir("lbb-ps-code-"),
			timeoutMs: 30_000,
		});

	test("a native program that writes to stderr under 2>&1 does not end the script", async () => {
		// Under `$ErrorActionPreference = 'Stop'` Windows PowerShell 5.1 raised
		// NativeCommandError on the first stderr line, so `after` never ran and a
		// command as ordinary as `git push 2>&1` failed.
		const result = await run('cmd /c "echo err 1>&2 & exit 0" 2>&1; Write-Output after');
		expect(result.stdout).toContain("after");
		expect(result.exitCode).toBe(0);
	}, 40_000);

	test("a program that exits 0 after writing to stderr is a success, redirected or not", async () => {
		expect((await run('cmd /c "echo err 1>&2" 2>&1')).exitCode).toBe(0);
		expect((await run('cmd /c "echo err 1>&2"')).exitCode).toBe(0);
	}, 40_000);

	test("a failing native program as the last statement returns its own code", async () => {
		expect((await run('cmd /c "exit 3"')).exitCode).toBe(3);
		expect((await run('cmd /c "echo err 1>&2 & exit 4" 2>&1')).exitCode).toBe(4);
		expect((await run('cmd /c "exit 3"; cmd /c "exit 5"')).exitCode).toBe(5);
		expect((await run('if ($true) { cmd /c "exit 6" }')).exitCode).toBe(6);
	}, 60_000);

	test("an earlier failure does not decide the code once a later statement succeeded", async () => {
		// What bash reports: the last command's status. The `$LASTEXITCODE` the
		// earlier program left behind used to be returned whatever came after it.
		const afterNative = await run('cmd /c "exit 3"; Write-Output done');
		expect(afterNative.stdout).toContain("done");
		expect(afterNative.exitCode).toBe(0);
		expect((await run('cmd /c "exit 3"; cmd /c "exit 0"')).exitCode).toBe(0);
	}, 40_000);

	test("a cmdlet that fails as the last statement still fails the call", async () => {
		const missing = join(tempDir("lbb-ps-missing-"), "not-here");
		expect((await run(`Get-Item "${missing}"`)).exitCode).toBe(1);
		// Not even a stale 0 from a native program that ran before it hides the failure.
		expect((await run(`cmd /c "exit 0"; Get-Item "${missing}"`)).exitCode).toBe(1);
		expect((await run('throw "boom"')).exitCode).toBe(1);
	}, 60_000);
});

describe("the Bash tool describes the shell it runs", () => {
	const toolFor = (command: string, kind: "powershell" | "bash" | "cmd") =>
		createBashTool(process.cwd(), defaultOperations(), undefined, { shell: { command, kind } });

	test("a PowerShell shell gets PowerShell syntax, and the 5.1 limit is named", () => {
		const tool = toolFor("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell");
		expect(tool.description).toContain("Windows PowerShell");
		expect(tool.description).toContain("write PowerShell syntax");
		expect(tool.prompt).toContain("$?");
		expect(tool.prompt).toContain("LBB_SHELL_PATH");
		// The POSIX assumption is what the description exists to correct.
		expect(tool.prompt).not.toContain("Chain dependent steps with &&");
	});

	test("pwsh is named PowerShell 7", () => {
		const tool = toolFor("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell");
		expect(tool.description).toContain("PowerShell 7");
		expect(tool.description).not.toContain("Windows PowerShell");
	});

	test("a POSIX shell keeps the POSIX prompt", () => {
		const tool = toolFor("/bin/bash", "bash");
		expect(tool.description).toContain("POSIX-compatible shell");
		expect(tool.prompt).toContain("Chain dependent steps with &&");
		expect(tool.prompt).not.toContain("$LASTEXITCODE");
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
