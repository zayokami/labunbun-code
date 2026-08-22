import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import {
	applySettingsEnv,
	collectPermissionRules,
	loadSettings,
	resolvePermissionMode,
	SettingsSchema,
} from "../src/settings.ts";

function tmpRoot(): string {
	return tmpdir();
}

/**
 * Run `body` against a throwaway home + project dir, with settings files
 * written per tier. Restores USERPROFILE afterwards — loadSettings resolves the
 * user and policy tiers through it.
 */
function withSettingsTiers(
	tiers: { user?: unknown; project?: unknown; local?: unknown; policy?: unknown },
	body: (cwd: string) => void,
): void {
	const fakeHome = mkdtempSync(join(tmpRoot(), "lbb-home-"));
	const cwd = mkdtempSync(join(tmpRoot(), "lbb-proj-"));
	const prevHome = process.env.USERPROFILE;
	try {
		process.env.USERPROFILE = fakeHome;
		mkdirSync(join(fakeHome, ".labunbun"), { recursive: true });
		mkdirSync(join(cwd, ".labunbun"), { recursive: true });
		if (tiers.user) writeFileSync(join(fakeHome, ".labunbun", "settings.json"), JSON.stringify(tiers.user));
		if (tiers.policy) writeFileSync(join(fakeHome, ".labunbun", "managed-settings.json"), JSON.stringify(tiers.policy));
		if (tiers.project) writeFileSync(join(cwd, ".labunbun", "settings.json"), JSON.stringify(tiers.project));
		if (tiers.local) writeFileSync(join(cwd, ".labunbun", "settings.local.json"), JSON.stringify(tiers.local));
		body(cwd);
	} finally {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		rmSync(fakeHome, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("loadSettings hierarchy", () => {
	test("project overrides user; local overrides project; policy wins last", () => {
		const fakeHome = mkdtempSync(join(tmpRoot(), "lbb-home-"));
		const cwd = mkdtempSync(join(tmpRoot(), "lbb-proj-"));
		const prevHome = process.env.USERPROFILE;
		try {
			process.env.USERPROFILE = fakeHome;

			mkdirSync(join(fakeHome, ".labunbun"), { recursive: true });
			mkdirSync(join(cwd, ".labunbun"), { recursive: true });
			writeFileSync(
				join(fakeHome, ".labunbun", "settings.json"),
				JSON.stringify({ model: "deepseek/deepseek-chat", theme: "dark", permissionMode: "default" }),
			);
			writeFileSync(join(cwd, ".labunbun", "settings.json"), JSON.stringify({ model: "kimi/kimi-k2-0905-preview" }));
			writeFileSync(join(cwd, ".labunbun", "settings.local.json"), JSON.stringify({ theme: "light" }));
			writeFileSync(join(fakeHome, ".labunbun", "managed-settings.json"), JSON.stringify({ permissionMode: "plan" }));

			const { settings } = loadSettings(cwd);
			expect(settings.model).toBe("kimi/kimi-k2-0905-preview"); // project beat user
			expect(settings.theme).toBe("light"); // local beat user
			expect(settings.permissionMode).toBe("plan"); // policy beats everything
		} finally {
			if (prevHome === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = prevHome;
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("perSource keeps each tier's own object unmerged", () => {
		withSettingsTiers(
			{
				user: { model: "deepseek/deepseek-chat" },
				policy: { permissionMode: "plan" },
			},
			(cwd) => {
				const { settings, perSource } = loadSettings(cwd);
				expect(perSource.user?.model).toBe("deepseek/deepseek-chat");
				expect(perSource.policy?.permissionMode).toBe("plan");
				// The user tier's view must not have picked up the policy value,
				// which is the whole point of keeping tiers separate.
				expect(perSource.user?.permissionMode).toBeUndefined();
				expect(perSource.project).toBeUndefined();
				expect(settings.permissionMode).toBe("plan");
			},
		);
	});

	test("corrupt settings file is skipped with a warning, not a crash", () => {
		const cwd = mkdtempSync(join(tmpRoot(), "lbb-corrupt-"));
		const prevHome = process.env.USERPROFILE;
		try {
			process.env.USERPROFILE = cwd;
			mkdirSync(join(cwd, ".labunbun"), { recursive: true });
			writeFileSync(join(cwd, ".labunbun", "settings.json"), "{not json");
			const { settings } = loadSettings(cwd);
			expect(settings.permissions.allow).toEqual([]); // defaults intact
		} finally {
			if (prevHome === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = prevHome;
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("permission rule tiers", () => {
	test("each settings tier tags its rules with its own source", () => {
		withSettingsTiers(
			{
				user: { permissions: { allow: ["Read"], deny: [] } },
				project: { permissions: { allow: ["Grep"], deny: [] } },
				local: { permissions: { allow: ["Glob"], deny: [] } },
				policy: { permissions: { allow: [], deny: ["Bash(rm *)"] } },
			},
			(cwd) => {
				const rules = collectPermissionRules(loadSettings(cwd));
				const bySource = new Map(rules.map((r) => [r.toolName, r.source]));
				// Before rule attribution existed every one of these was
				// "userSettings", which made the tier ordering inert.
				expect(bySource.get("Read")).toBe("userSettings");
				expect(bySource.get("Grep")).toBe("projectSettings");
				expect(bySource.get("Glob")).toBe("localSettings");
				expect(bySource.get("Bash")).toBe("policy");
			},
		);
	});

	test("rules follow the settings hierarchy order", () => {
		withSettingsTiers(
			{
				user: { permissions: { allow: ["Read"], deny: [] } },
				policy: { permissions: { allow: ["Write"], deny: [] } },
			},
			(cwd) => {
				const sources = collectPermissionRules(loadSettings(cwd)).map((r) => r.source);
				expect(sources.indexOf("userSettings")).toBeLessThan(sources.indexOf("policy"));
			},
		);
	});

	test("allowManagedPermissionRulesOnly discards non-managed rules", () => {
		withSettingsTiers(
			{
				user: { permissions: { allow: ["Bash(curl *)"], deny: [] } },
				project: { permissions: { allow: ["Write"], deny: [] } },
				local: { permissions: { allow: ["Bash(rm -rf *)"], deny: [] } },
				policy: {
					allowManagedPermissionRulesOnly: true,
					permissions: { allow: ["Read"], deny: ["Read(**/.env)"] },
				},
			},
			(cwd) => {
				const rules = collectPermissionRules(loadSettings(cwd));
				expect(rules.every((r) => r.source === "policy")).toBe(true);
				// The policy tier's own rules survive intact.
				expect(rules.some((r) => r.behavior === "deny" && r.specifier === "**/.env")).toBe(true);
				expect(rules.some((r) => r.toolName === "Write")).toBe(false);
			},
		);
	});

	test("a project file cannot grant itself managed-only privilege", () => {
		withSettingsTiers(
			{
				project: {
					// Set at the wrong tier: this must not lock out the user tier,
					// or any repo could neutralise the rules protecting it.
					allowManagedPermissionRulesOnly: true,
					permissions: { allow: ["Bash(rm -rf *)"], deny: [] },
				},
				user: { permissions: { allow: [], deny: ["Bash(rm -rf *)"] } },
			},
			(cwd) => {
				const rules = collectPermissionRules(loadSettings(cwd));
				expect(rules.some((r) => r.source === "userSettings" && r.behavior === "deny")).toBe(true);
			},
		);
	});

	test("a tier with no permissions block contributes nothing", () => {
		withSettingsTiers({ user: { model: "kimi/kimi-k2-0905-preview" } }, (cwd) => {
			expect(collectPermissionRules(loadSettings(cwd))).toEqual([]);
		});
	});
});

describe("disableBypassPermissionsMode", () => {
	test("policy downgrades bypassPermissions to default with a reason", () => {
		withSettingsTiers({ policy: { disableBypassPermissionsMode: true } }, (cwd) => {
			const result = resolvePermissionMode("bypassPermissions", loadSettings(cwd));
			expect(result.mode).toBe("default");
			expect(result.downgradeReason).toContain("managed settings");
		});
	});

	test("other modes pass through untouched", () => {
		withSettingsTiers({ policy: { disableBypassPermissionsMode: true } }, (cwd) => {
			const loaded = loadSettings(cwd);
			for (const mode of ["default", "plan", "acceptEdits", "dontAsk"] as const) {
				const result = resolvePermissionMode(mode, loaded);
				expect(result.mode).toBe(mode);
				expect(result.downgradeReason).toBeUndefined();
			}
		});
	});

	test("bypassPermissions is untouched when policy does not disable it", () => {
		withSettingsTiers({ user: { disableBypassPermissionsMode: true } }, (cwd) => {
			// Set at the user tier, which has no authority to restrict itself.
			const result = resolvePermissionMode("bypassPermissions", loadSettings(cwd));
			expect(result.mode).toBe("bypassPermissions");
			expect(result.downgradeReason).toBeUndefined();
		});
	});
});

describe("applySettingsEnv", () => {
	test("fills only keys absent from the real environment", () => {
		const present = "LBB_TEST_PRESENT_KEY";
		const absent = "LBB_TEST_ABSENT_KEY";
		const prev = process.env[present];
		try {
			process.env[present] = "from-shell";
			delete process.env[absent];
			const settings = SettingsSchema.parse({ env: { [present]: "from-settings", [absent]: "from-settings" } });
			const applied = applySettingsEnv(settings);

			// A settings file must never shadow a key the user exported, or it
			// could silently redirect credentials the shell already set.
			expect(process.env[present]).toBe("from-shell");
			expect(process.env[absent]).toBe("from-settings");
			expect(applied).toEqual([absent]);
		} finally {
			if (prev === undefined) delete process.env[present];
			else process.env[present] = prev;
			delete process.env[absent];
		}
	});

	test("no env block is a no-op", () => {
		expect(applySettingsEnv(SettingsSchema.parse({}))).toEqual([]);
	});

	test("an empty string value is still applied", () => {
		const key = "LBB_TEST_EMPTY_KEY";
		try {
			delete process.env[key];
			applySettingsEnv(SettingsSchema.parse({ env: { [key]: "" } }));
			// "" is a real, intentional value — distinct from unset.
			expect(process.env[key]).toBe("");
		} finally {
			delete process.env[key];
		}
	});
});

describe("SessionStore resilience", () => {
	test("torn trailing line is ignored on load", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-torn-"));
		// Temp home: without it the session file lands in ~/.labunbun/projects.
		const store = SessionStore.startNew(dir, mkdtempSync(join(tmpdir(), "lbb-torn-home-")));
		store.appendMessage({ role: "user", content: "intact", timestamp: 1 });

		// Simulate a crash mid-write: append a partial JSON line.
		const { appendFileSync } = require("node:fs") as typeof import("node:fs");
		appendFileSync(store.path, `{"id":"torn","parentId":"xx","type":"mess`);

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.messages()).toHaveLength(1);
		expect(reloaded.messages()[0]).toMatchObject({ role: "user", content: "intact" });
	});
});
