/**
 * The suite's Windows command fixtures are POSIX shell scripts.
 *
 * The product's default shell on Windows is Windows PowerShell (see
 * `detectShell` in `packages/tools/src/operations.ts`), and the tests that
 * assert the selection clear this variable themselves. Every other test —
 * capture bounds, timeout handoff, proxy wiring, e2e runs — writes command
 * text a POSIX shell parses. On Windows this pins a Git Bash when the
 * developer or the runner did not name a shell, with no drive letter assumed:
 * the `git.exe` entries on PATH lead to their install root, and PATH is read
 * again for a `bash.exe` that is not a WSL launcher.
 */
import { existsSync } from "node:fs";

/** Directory names that hold executables inside an install rather than being its root. */
const CLASS_DIRECTORIES = new Set(["bin", "cmd", "sbin", "usr", "mingw64", "mingw32", "libexec"]);

/** The install root above a PATH entry such as `...\Git\cmd` or `...\Git\mingw64\bin`. */
function installRoot(dir: string): string {
	const components = dir.replace(/\//g, "\\").split("\\");
	while (components.length > 1) {
		const last = (components[components.length - 1] ?? "").toLowerCase();
		if (!CLASS_DIRECTORIES.has(last)) break;
		components.pop();
	}
	return components.join("\\");
}

function findBash(): string | undefined {
	const dirs = (process.env.PATH ?? "")
		.split(";")
		.map((entry) =>
			entry
				.trim()
				.replace(/^"|"$/g, "")
				.replace(/[\\/]+$/, "")
				.replace(/\//g, "\\"),
		)
		.filter((dir) => /^[A-Za-z]:\\/.test(dir));
	for (const dir of dirs) {
		if (!existsSync(`${dir}\\git.exe`)) continue;
		const root = installRoot(dir);
		for (const rest of ["bin", "usr\\bin"]) {
			const candidate = `${root}\\${rest}\\bash.exe`;
			if (existsSync(candidate)) return candidate;
		}
	}
	const systemRoot = (process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows").toLowerCase().replace(/\//g, "\\");
	for (const dir of dirs) {
		const normalized = dir.toLowerCase();
		if (normalized.startsWith(`${systemRoot}\\system32\\`) || normalized.includes("\\microsoft\\windowsapps\\"))
			continue;
		const candidate = `${dir}\\bash.exe`;
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

if (
	process.platform === "win32" &&
	process.env.LBB_SHELL_PATH === undefined &&
	process.env.LBB_BASH_PATH === undefined
) {
	const bash = findBash();
	if (bash !== undefined) process.env.LBB_SHELL_PATH = bash;
}
