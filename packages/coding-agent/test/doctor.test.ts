import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDoctorReport, runDoctorChecks } from "../src/doctor.ts";
import { padConfigFrom } from "../src/gamepad-runtime.ts";
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

/** The Gamepad row, which is two lines when a binding could not be read. */
function padRow(checks: Awaited<ReturnType<typeof runDoctorChecks>>) {
	return checks.find((c) => c.name === "Gamepad");
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

describe("the Gamepad row", () => {
	test("off by default, and the row says how to turn it on", async () => {
		const { home, cwd } = makeDirs();
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({}), cwd, home));
		expect(row?.status).toBe("ok");
		expect(row?.detail).toBe("off — /gamepad on, or --gamepad for one run");
	});

	test("settings alone are enough to enable it", async () => {
		// The doctor runs before a session exists, so it reads the settings file and
		// not a live runtime — the two must agree, which is why the row's wording is
		// written from the resolved config either way.
		const { home, cwd } = makeDirs();
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({ gamepad: { enabled: true } }), cwd, home));
		expect(row?.detail).toBe("enabled");
	});

	test("a live runtime reports approvals, the device filter and changed bindings", async () => {
		const { home, cwd } = makeDirs();
		const pad = padConfigFrom(
			SettingsSchema.parse({
				gamepad: { enabled: true, allowApprove: true, device: "wireless", bindings: { cross: "cancel" } },
			}),
		);
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({}), cwd, home, undefined, pad));
		expect(row?.status).toBe("ok");
		expect(row?.detail).toBe(
			"enabled · ✕ may answer a permission dialog · device filter: wireless · 1 binding changed from the default",
		);
	});

	test("an unreadable binding warns, and is named", async () => {
		// The row is the one place a typo in `bindings` is visible without turning
		// the pad on, so the problem text has to survive into the detail.
		const { home, cwd } = makeDirs();
		const pad = padConfigFrom(SettingsSchema.parse({ gamepad: { enabled: true, bindings: { cros: "confirm" } } }));
		const row = padRow(await runDoctorChecks(SettingsSchema.parse({}), cwd, home, undefined, pad));
		expect(row?.status).toBe("warn");
		expect(row?.detail).toContain("cros");
	});

	test("a live runtime that is off beats a settings file that says on", async () => {
		// `/gamepad off` writes the setting and disables the pad in one move, but a
		// session started with `--no-gamepad` has a runtime saying off and a file
		// still saying on. What the session is doing is the answer worth printing.
		const { home, cwd } = makeDirs();
		const pad = padConfigFrom(SettingsSchema.parse({ gamepad: { enabled: false } }));
		const row = padRow(
			await runDoctorChecks(SettingsSchema.parse({ gamepad: { enabled: true } }), cwd, home, undefined, pad),
		);
		expect(row?.detail).toBe("off — /gamepad on, or --gamepad for one run");
	});
});

/**
 * The Network row, which is the one place the repo says out loud whether the
 * network restriction can be backed up on the machine asking.
 *
 * Driven through an injected platform rather than skipped per OS, because the
 * Windows branch is the one that matters: a test that only ran where the author
 * happens to be would report the row as fine and never read the sentence that
 * admits the proxy is the whole boundary.
 */
describe("the Network row", () => {
	function networkRow(settings: ReturnType<typeof SettingsSchema.parse>, cwd: string, home: string, platform: string) {
		return runDoctorChecks(settings, cwd, home, undefined, undefined, platform).then((checks) =>
			checks.find((c) => c.name === "Network"),
		);
	}

	// Four platforms, not three. With only darwin/linux/win32 the table agrees
	// with `platform !== "win32"` as well as with the real predicate, so a
	// falsification run could swap one for the other and every assertion here
	// would still hold. `freebsd` is the fourth: a platform this build has no
	// backend for and that is not the one special-cased by name, which is what
	// makes the difference between "not darwin and not linux" and "not windows"
	// visible in a test rather than in a reviewer's head.
	test.each([
		["darwin", "ok"],
		["linux", "ok"],
		["win32", "warn"],
		["freebsd", "warn"],
	] as const)("on %s the row is %s", async (platform, status) => {
		const { home, cwd } = makeDirs();
		const row = await networkRow(
			SettingsSchema.parse({ networkAccess: "restricted", networkDomains: ["registry.npmjs.org"] }),
			cwd,
			home,
			platform,
		);
		expect(row?.status).toBe(status);
		expect(row?.detail).toContain("1 domain allowed");
	});

	test("the platform without a backend says what the restriction depends on", async () => {
		const { home, cwd } = makeDirs();
		const row = await networkRow(
			SettingsSchema.parse({ networkAccess: "restricted", networkDomains: ["x.test"] }),
			cwd,
			home,
			"win32",
		);
		// The names, not "sandbox on". A user reading this row on Windows is
		// deciding whether to trust the setting, and the difference between
		// "restricted" and "restricted, as long as the program is honest about
		// proxy variables" is the entire content of that decision.
		expect(row?.detail).toContain("HTTP_PROXY/HTTPS_PROXY/ALL_PROXY");
		expect(row?.detail).toContain("no OS network backend");
	});

	test("a session that confines nothing is reported plainly, and not as a warning", async () => {
		// The row has to distinguish "not restricted" from "restricted and not
		// enforceable here". A warn on the default would be noise on every machine
		// in the repository, and a warn is the signal that makes the Windows case
		// worth reading.
		const { home, cwd } = makeDirs();
		for (const platform of ["darwin", "linux", "win32", "freebsd"]) {
			const row = await networkRow(SettingsSchema.parse({}), cwd, home, platform);
			expect(row?.status).toBe("ok");
			expect(row?.detail).toBe("not restricted — commands reach whatever the host can reach");
		}
	});

	test("`restricted` with an empty list says nothing is reachable", async () => {
		// The two axes are separate settings, so this is a configuration someone
		// can write by accident. A row that said "1 policy" or nothing at all
		// would leave a session that cannot fetch looking configured.
		const { home, cwd } = makeDirs();
		const row = await networkRow(SettingsSchema.parse({ networkAccess: "restricted" }), cwd, home, "linux");
		expect(row?.detail).toContain("nothing is reachable");
	});
});
