/**
 * /doctor diagnostics: environment health checks for shell, ripgrep,
 * auth, and settings.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectShell } from "@labunbun/tools";
import { AUTO_THEME_NAME, DEFAULT_THEME, resolveBuiltInTheme } from "@labunbun/tui";
import type { Settings } from "./settings.ts";
import { loadThemeFiles } from "./theme-file.ts";

export interface DoctorCheck {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

export async function runDoctorChecks(settings: Settings, cwd: string): Promise<DoctorCheck[]> {
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

	// Auth: which API keys are visible
	const keys = ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "GLM_API_KEY"];
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
	const userSettings = join(homedir(), ".labunbun", "settings.json");
	const projectSettings = join(cwd, ".labunbun", "settings.json");
	const found = [userSettings, projectSettings].filter((p) => existsSync(p));
	checks.push({
		name: "Settings",
		status: found.length > 0 ? "ok" : "warn",
		detail: found.length > 0 ? found.join(", ") : "no settings files (all defaults)",
	});

	// Theme resolution: an unresolved name or a broken theme file shows up as a
	// theme that silently did nothing, so it is worth naming here.
	const themeName = settings.theme ?? DEFAULT_THEME.name;
	const loadedThemes = loadThemeFiles(cwd);
	const known =
		themeName === AUTO_THEME_NAME || loadedThemes.themes.has(themeName) || resolveBuiltInTheme(themeName) !== undefined;
	const themeDetails = [known ? themeName : `unknown theme "${themeName}" — using ${DEFAULT_THEME.name}`];
	if (loadedThemes.themes.size > 0) themeDetails.push(`${loadedThemes.themes.size} from theme files`);
	themeDetails.push(...loadedThemes.problems);
	checks.push({
		name: "Theme",
		status: known && loadedThemes.problems.length === 0 ? "ok" : "warn",
		detail: themeDetails.join(" · "),
	});

	// Session storage writable
	try {
		const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const probe = join(homedir(), ".labunbun", "projects", ".doctor-probe");
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
