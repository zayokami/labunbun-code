import { describe, expect, test } from "bun:test";
import { formatDoctorReport, runDoctorChecks } from "../src/doctor.ts";
import { SettingsSchema } from "../src/settings.ts";

describe("runDoctorChecks", () => {
	test("produces a full report without throwing", async () => {
		const settings = SettingsSchema.parse({});
		const checks = await runDoctorChecks(settings, process.cwd());
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
		const settings = SettingsSchema.parse({});
		const report = formatDoctorReport(await runDoctorChecks(settings, process.cwd()));
		expect(report).toMatch(/[✓!✗] Runtime:/);
	});
});
