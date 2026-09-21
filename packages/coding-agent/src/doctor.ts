/**
 * /doctor diagnostics: environment health checks for shell, ripgrep,
 * auth, and settings.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectShell } from "@labunbun/tools";
import { AUTO_THEME_NAME, DEFAULT_THEME, resolveBuiltInTheme } from "@labunbun/tui";
import { changedBindings, type PadConfig } from "./gamepad-runtime.ts";
import type { Settings } from "./settings.ts";
import { loadThemeFiles, resolveTheme } from "./theme-file.ts";

export interface DoctorCheck {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

/**
 * `home` and `liveThemeName` are the two things this cannot read off `settings`:
 * where the user's files are (a session may be pointed at another home), and
 * which theme is on screen right now (`/theme` may have changed it since
 * startup). Both default to the setting-based answer, which is right for a
 * caller that has neither.
 *
 * `pad` is the third, and it is passed rather than derived: the bindings a user
 * can actually press are the ones the running session resolved against the
 * command table, and resolving them a second time here — from the same settings
 * but without the command names — would let `/doctor` call a binding fine that
 * `/gamepad` calls unreadable. The runtime is built before the REPL mounts, so
 * the caller always has it.
 */
export async function runDoctorChecks(
	settings: Settings,
	cwd: string,
	home = homedir(),
	liveThemeName?: string,
	pad?: PadConfig,
): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];

	// Runtime
	checks.push({
		name: "Runtime",
		status: "ok",
		detail: `Bun ${Bun.version} · Node ${process.version} · ${process.platform}`,
	});

	// Shell availability (POSIX shell preferred for the Bash tool)
	const shell = detectShell();
	const isCmd = shell.command === "cmd.exe";
	checks.push({
		name: "Shell",
		status: isCmd ? "warn" : "ok",
		detail: isCmd ? "cmd.exe fallback — install Git for Windows for POSIX syntax" : `${shell.command} (POSIX)`,
	});

	// ripgrep presence (informational; Grep has a JS fallback)
	let rgStatus: DoctorCheck["status"] = "warn";
	let rgDetail = "not found — using built-in JS search";
	try {
		const proc = Bun.spawnSync(["rg", "--version"], { stdout: "pipe", stderr: "pipe" });
		if (proc.exitCode === 0) {
			rgStatus = "ok";
			rgDetail = proc.stdout.toString().split("\n")[0].trim();
		}
	} catch {
		// keep warn
	}
	checks.push({ name: "ripgrep", status: rgStatus, detail: rgDetail });

	// Auth: which API keys are visible. The same names the registry reads, so a
	// provider that resolves here is one the probe will also ask.
	const keys = [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"DEEPSEEK_API_KEY",
		"KIMI_API_KEY",
		"MOONSHOT_API_KEY",
		"GLM_API_KEY",
		"OPENAI_API_KEY",
		"GEMINI_API_KEY",
	];
	const present = keys.filter((k) => process.env[k]);
	checks.push({
		name: "Auth",
		status: present.length > 0 ? "ok" : "fail",
		detail: present.length > 0 ? present.join(", ") : `none of ${keys.join(", ")} set`,
	});

	// Model resolution
	checks.push({
		name: "Model",
		status: settings.model ? "ok" : "warn",
		detail: settings.model ?? "default (anthropic/claude-sonnet-5) — set `model` in settings.json",
	});

	// Settings files present
	const userSettings = join(home, ".labunbun", "settings.json");
	const projectSettings = join(cwd, ".labunbun", "settings.json");
	const found = [userSettings, projectSettings].filter((p) => existsSync(p));
	checks.push({
		name: "Settings",
		status: found.length > 0 ? "ok" : "warn",
		detail: found.length > 0 ? found.join(", ") : "no settings files (all defaults)",
	});

	// Theme resolution: an unresolved name or a broken theme file shows up as a
	// theme that silently did nothing, so it is worth naming here.
	//
	// The live choice rather than the one the session started with: /theme may
	// have changed it since, and a row naming the theme that was on screen an hour
	// ago is a row about a screen nobody is looking at.
	const themeName = liveThemeName ?? settings.theme ?? DEFAULT_THEME.name;
	const loadedThemes = loadThemeFiles(cwd, home);
	const known =
		themeName === AUTO_THEME_NAME || loadedThemes.themes.has(themeName) || resolveBuiltInTheme(themeName) !== undefined;
	// `auto` is the one choice that does not say what it resolved to, and saying
	// what it resolved to is the only thing this row is for. Resolved through the
	// same call the session uses, so a theme file that claims the detected
	// appearance is reported here exactly as it is applied.
	const resolvedName =
		themeName === AUTO_THEME_NAME ? (await resolveTheme(themeName, cwd, home)).theme.name : themeName;
	const label = resolvedName === themeName ? themeName : `${themeName} → ${resolvedName}`;
	const themeDetails = [known ? label : `unknown theme "${themeName}" — using ${DEFAULT_THEME.name}`];
	if (loadedThemes.themes.size > 0) themeDetails.push(`${loadedThemes.themes.size} from theme files`);
	themeDetails.push(...loadedThemes.problems);
	checks.push({
		name: "Theme",
		status: known && loadedThemes.problems.length === 0 ? "ok" : "warn",
		detail: themeDetails.join(" · "),
	});

	// The controller: configuration only, never the hardware.
	//
	// Whether a pad is plugged in, and whether node-hid loaded at all, are runtime
	// facts that change while the user is looking at the screen — `/gamepad status`
	// answers those, and answers them about *now*. What can be checked here is the
	// part that is the same whether or not anything is plugged in: a binding that
	// names a button or an action that does not exist, which is a typo in a file
	// and is invisible until the button does nothing.
	const padEnabled = pad?.enabled ?? settings.gamepad?.enabled === true;
	const padDetails: string[] = [padEnabled ? "enabled" : "off — /gamepad on, or --gamepad for one run"];
	if (padEnabled) {
		if (pad?.allowApprove) padDetails.push("✕ may answer a permission dialog");
		if (pad?.device) padDetails.push(`device filter: ${pad.device}`);
		const changed = pad ? changedBindings(pad.bindings).length : 0;
		if (changed > 0) padDetails.push(`${changed} binding${changed === 1 ? "" : "s"} changed from the default`);
	}
	// Printed whether or not the pad is on: a binding that cannot be read is
	// precisely the thing that would make turning it on look like it did nothing.
	const padProblems = pad?.problems ?? [];
	padDetails.push(...padProblems);
	checks.push({
		name: "Gamepad",
		status: padProblems.length > 0 ? "warn" : "ok",
		detail: padDetails.join(" · "),
	});

	// Session storage writable
	try {
		const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const probe = join(home, ".labunbun", "projects", ".doctor-probe");
		mkdirSync(probe, { recursive: true });
		writeFileSync(join(probe, "probe"), "x");
		rmSync(probe, { recursive: true, force: true });
		checks.push({ name: "Session store", status: "ok", detail: "~/.labunbun/projects writable" });
	} catch (error) {
		checks.push({
			name: "Session store",
			status: "fail",
			detail: `cannot write ~/.labunbun: ${error instanceof Error ? error.message : error}`,
		});
	}

	return checks;
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
	return checks
		.map((c) => {
			const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
			return `${icon} ${c.name}: ${c.detail}`;
		})
		.join("\n");
}
