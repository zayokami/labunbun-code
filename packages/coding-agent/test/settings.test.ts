import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostTracker, formatCostState } from "../src/cost-tracker.ts";
import { appendHistory, loadHistory } from "../src/history.ts";
import { mergeSettings, type RawSettingsInput, SettingsSchema } from "../src/settings.ts";

describe("mergeSettings", () => {
	test("objects merge recursively, arrays and scalars replace", () => {
		const base: RawSettingsInput = {
			permissions: { allow: ["Read"], deny: ["Bash(rm *)"], additionalDirectories: [] },
			model: "a/b",
		};
		const override: RawSettingsInput = {
			permissions: { allow: ["Write"] },
			model: "c/d",
		};
		const merged = mergeSettings(base, override);
		expect(merged.model).toBe("c/d");
		expect((merged.permissions as any).allow).toEqual(["Write"]);
		expect((merged.permissions as any).deny).toEqual(["Bash(rm *)"]); // untouched
	});
});

describe("SettingsSchema", () => {
	test("parses a full document with defaults", () => {
		const parsed = SettingsSchema.parse({
			model: "deepseek/deepseek-chat",
			permissionMode: "acceptEdits",
			permissions: { allow: ["Read"], deny: [] },
			providers: {
				openaiCompatible: [
					{
						id: "custom",
						baseUrl: "https://api.example.com/v1",
						apiKeyEnv: "CUSTOM_KEY",
						models: [{ id: "m1", contextWindow: 128000, maxOutputTokens: 8192 }],
					},
				],
			},
		});
		expect(parsed.permissions.deny).toEqual([]);
		expect(parsed.providers?.openaiCompatible[0].id).toBe("custom");
	});

	test("rejects invalid permission mode and bad urls", () => {
		expect(SettingsSchema.safeParse({ permissionMode: "yolo" }).success).toBe(false);
		expect(
			SettingsSchema.safeParse({
				providers: { openaiCompatible: [{ id: "x", baseUrl: "not-a-url", apiKeyEnv: "K", models: [] }] },
			}).success,
		).toBe(false);
	});
});

describe("CostTracker", () => {
	test("accumulates usage per model and computes totals", () => {
		const tracker = new CostTracker();
		tracker.recordUsage("faux", "faux-1", { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 });
		tracker.recordUsage("faux", "faux-1", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const state = tracker.state;
		expect(state.modelsUsage["faux/faux-1"].inputTokens).toBe(1_000_000);
		expect(state.totalCostUSD).toBeGreaterThanOrEqual(0); // no pricing → 0
		expect(formatCostState(state)).toContain("faux/faux-1");
	});

	test("persists and reloads per-project state", () => {
		// HOME decides where costs.json lands, and CostTracker reads it in its
		// constructor. Without the override the suite writes into the real
		// ~/.labunbun/projects/ and leaves a directory behind on every run.
		const home = mkdtempSync(join(tmpdir(), "lbb-cost-home-"));
		const dir = mkdtempSync(join(tmpdir(), "lbb-cost-"));
		const previousHome = process.env.HOME;
		const previousProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		try {
			const first = new CostTracker(dir);
			first.recordUsage("faux", "faux-1", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
			first.persist();

			const reloaded = new CostTracker(dir);
			expect(reloaded.state.modelsUsage["faux/faux-1"].inputTokens).toBe(10);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousProfile;
		}
	});
});

describe("history", () => {
	test("append + load roundtrip with dedupe and cwd filter", () => {
		// Every append goes to the home passed here. Omitting it appends to the
		// user's real prompt history.
		const home = mkdtempSync(join(tmpdir(), "lbb-hist-home-"));
		const dirA = mkdtempSync(join(tmpdir(), "lbb-hist-a-"));
		const dirB = mkdtempSync(join(tmpdir(), "lbb-hist-b-"));
		appendHistory("first prompt", dirA, home);
		appendHistory("second prompt", dirA, home);
		appendHistory("other project", dirB, home);
		appendHistory("second prompt", dirA, home); // dedupe moves it to front

		const forA = loadHistory(dirA, 100, home);
		// Oldest → newest: ↑ recall pops from the end (most recent first).
		expect(forA).toEqual(["first prompt", "second prompt"]);
		expect(loadHistory(dirB, 100, home)).toEqual(["other project"]);
		expect(loadHistory(dirA, 1, home)).toEqual(["second prompt"]);
	});
});

describe("session resume roundtrip", () => {
	test("list + load + continue appends to the same tree", async () => {
		const { listSessions, loadSessionForResume } = await import("../src/session-resume.ts");
		const { AgentSession, SessionStore } = await import("@labunbun/agent");
		const { FAUX_MODEL, fauxProvider } = await import("@labunbun/ai");

		const dir = mkdtempSync(join(tmpdir(), "lbb-resume-"));
		mkdirSync(join(dir, ".labunbun"), { recursive: true });
		// Sessions live under a home directory; a temp one keeps this run out of
		// ~/.labunbun/projects. Both the store and the listing need to agree on it.
		const home = mkdtempSync(join(tmpdir(), "lbb-resume-home-"));

		// Session 1: a scripted conversation.
		const store = SessionStore.startNew(dir, home);
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "x" } }] }, { text: "done" }]);
		const session1 = new AgentSession({
			model: FAUX_MODEL,
			store,
			cwd: dir,
			deps: { streamFn: faux.streamFn },
		});
		await session1.prompt("hello world");

		// Resume: same store path, messages replayed, new prompt appends.
		const sessions = listSessions(dir, home);
		expect(sessions).toHaveLength(1);
		const loaded = loadSessionForResume(sessions[0].path);
		expect(loaded).not.toBeNull();
		if (!loaded) throw new Error("expected loaded session");
		expect(loaded.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

		const faux2 = fauxProvider([{ text: "continued" }]);
		const session2 = new AgentSession({
			model: FAUX_MODEL,
			store: loaded.store,
			cwd: dir,
			deps: { streamFn: faux2.streamFn },
		});
		session2.messages.push(...loaded.messages);
		await session2.prompt("continue please");

		const reloaded = SessionStore.load(sessions[0].path);
		expect(reloaded.messages().map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"user",
			"assistant",
		]);
	});
});
