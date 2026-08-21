import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { loadSettings } from "../src/settings.ts";

function tmpRoot(): string {
	return tmpdir();
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

describe("SessionStore resilience", () => {
	test("torn trailing line is ignored on load", () => {
		const dir = mkdtempSync(join(tmpdir(), "lbb-torn-"));
		const store = SessionStore.startNew(dir);
		store.appendMessage({ role: "user", content: "intact", timestamp: 1 });

		// Simulate a crash mid-write: append a partial JSON line.
		const { appendFileSync } = require("node:fs") as typeof import("node:fs");
		appendFileSync(store.path, `{"id":"torn","parentId":"xx","type":"mess`);

		const reloaded = SessionStore.load(store.path);
		expect(reloaded.messages()).toHaveLength(1);
		expect(reloaded.messages()[0]).toMatchObject({ role: "user", content: "intact" });
	});
});
