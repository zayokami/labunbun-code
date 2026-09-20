import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDoctorReport, runDoctorChecks } from "../src/doctor.ts";
import { SettingsSchema } from "../src/settings.ts";

/**
 * A throwaway home and cwd. The doctor probes the session store for write access
 * and reads theme files, so both have to be somewhere other than the operator's
 * own `~/.labunbun` — see isolation.test.ts.
 */
function makeDirs() {
	const root = mkdtempSync(join(tmpdir(), "lbb-doctor-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	return { home, cwd };
}

/** The Theme row's detail; every theme assertion is about this one line. */
function themeDetail(checks: Awaited<ReturnType<typeof runDoctorChecks>>): string {
	return checks.find((c) => c.name === "Theme")?.detail ?? "";
}

describe("runDoctorChecks", () => {
	test("produces a full report without throwing", async () => {
		const { home, cwd } = makeDirs();
		const settings = SettingsSchema.parse({});
		const checks = await runDoctorChecks(settings, cwd, home);
		const names = checks.map((c) => c.name);
		expect(names).toContain("Runtime");
		expect(names).toContain("Shell");
		expect(names).toContain("ripgrep");
		expect(names).toContain("Auth");
		expect(names).toContain("Session store");

		for (const check of checks) {
			expect(["ok", "warn", "fail"]).toContain(check.status);
			expect(check.detail.length).toBeGreaterThan(0);
		}
	});

	test("report formats with status icons", async () => {
		const { home, cwd } = makeDirs();
		const settings = SettingsSchema.parse({});
		const report = formatDoctorReport(await runDoctorChecks(settings, cwd, home));
		expect(report).toMatch(/[✓!✗] Runtime:/);
	});

	// The probe writes a file to prove the directory is writable, and used to do
	// it in the operator's real home on every run.
	test("the session-store probe runs in the given home, and cleans up after itself", async () => {
		const { home, cwd } = makeDirs();
		await runDoctorChecks(SettingsSchema.parse({}), cwd, home);
		// A fresh temp home has no `.labunbun` at all, so its existence is proof
		// the probe went there rather than to the real one.
		expect(existsSync(join(home, ".labunbun", "projects"))).toBe(true);
		expect(existsSync(join(home, ".labunbun", "projects", ".doctor-probe"))).toBe(false);
	});

	test("theme files are read from the given home", async () => {
		const { home, cwd } = makeDirs();
		const themes = join(home, ".labunbun", "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "midnight.json"), JSON.stringify({ name: "midnight", appearance: "dark" }));
		const detail = themeDetail(await runDoctorChecks(SettingsSchema.parse({ theme: "midnight" }), cwd, home));
		expect(detail).toBe("midnight · 1 from theme files");
	});

	// The session may have switched themes since it started; the row is about the
	// screen in front of the user, not about the one they booted into.
	test("a live theme name beats the one in settings", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "dark" }), cwd, home, "light");
		expect(themeDetail(checks)).toBe("light");
	});

	test("an unknown live theme is reported as unknown", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "dark" }), cwd, home, "ghost");
		expect(themeDetail(checks)).toContain('unknown theme "ghost"');
	});

	// "auto" is the one choice that does not say which theme is on screen, and
	// saying so is the entire content of this row.
	test("auto reports both the choice and what it resolved to", async () => {
		const { home, cwd } = makeDirs();
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "auto" }), cwd, home, "auto");
		// No TTY here, so detection declines to probe and lands on dark.
		expect(themeDetail(checks)).toBe("auto → dark");
	});

	test("auto names the theme file it resolved to, not the built-in it replaces", async () => {
		const { home, cwd } = makeDirs();
		const themes = join(home, ".labunbun", "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "midnight.json"), JSON.stringify({ name: "midnight", appearance: "dark" }));
		const checks = await runDoctorChecks(SettingsSchema.parse({ theme: "auto" }), cwd, home, "auto");
		expect(themeDetail(checks)).toBe("auto → midnight · 1 from theme files");
	});

	test("a broken theme file is reported on the theme row", async () => {
		const { home, cwd } = makeDirs();
		const themes = join(home, ".labunbun", "themes");
		mkdirSync(themes, { recursive: true });
		writeFileSync(join(themes, "broken.json"), "{ not json");
		const checks = await runDoctorChecks(SettingsSchema.parse({}), cwd, home);
		const theme = checks.find((c) => c.name === "Theme");
		expect(theme?.status).toBe("warn");
		expect(theme?.detail).toContain("broken.json");
	});
});
