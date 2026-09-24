/**
 * The `step-code` source, planner half: `config.toml`, `models.json`, the
 * `[mcp_servers.*]` tables, the permission posture, the retired documents and
 * the assets half.
 *
 * Three facts about this source decide the shape of nearly every test here, and
 * each one is pinned below where it is used:
 *
 *   - **the live document is `config.toml`**, and `settings.json` /
 *     `step-settings.json` are retired (`docs/step-configuration.md:13-15`), so
 *     a key that lives only in the retired pair is reported as retired rather
 *     than applied;
 *   - **the permission posture is resolved the vendor's own way** — a mode first
 *     (`[approvalMode, approval.mode, tools.approval.mode]`), then a preset, then
 *     `effectiveMode = approvalMode ?? preset.mode` (`step/settings-manager.ts:137-200`)
 *     — which is why the mode-beats-preset case is a test of its own;
 *   - **a theme is named by the `name` inside its file**, not by the file's own
 *     name (`theme/theme.ts:555-560`), so the reader opens the theme files to
 *     learn the names `config.toml` can refer to.
 *
 * Fixtures hold fake values only. `auth.json`, `.credentials.json` and friends
 * are named in the report and never opened — the sentinel assertions below are
 * what keeps that true (a value written into one of those files must not appear
 * anywhere in the report), and the same goes for a literal `apiKey` in
 * `models.json` and for the values inside the retired `settings.json`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIMI_CODE_HOME_ENV, KIMI_SHARE_DIR_ENV } from "../src/kimi-home.ts";
import {
	detectSources,
	MIGRATION_SOURCE_IDS,
	MIGRATION_SOURCE_LABELS,
	type MigrationItem,
	type MigrationPlan,
	parseFromOption,
	planMigration,
	readSources,
	readStepCode,
	resolveModelReference,
} from "../src/migrate.ts";
import { MINIMAX_DATA_DIR_ENV, MINIMAX_LEGACY_DATA_DIR_ENV } from "../src/minimax-home.ts";
import type { RawSettingsInput } from "../src/settings.ts";
import { STEPCODE_DEFAULT_DIR, STEPCODE_LEGACY_DIR, stepRoot } from "../src/step-home.ts";

/** Directories a test made, swept when it ends. */
const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Environment variables a test borrowed, restored after it. */
const borrowed = new Map<string, string | undefined>();
afterEach(() => {
	for (const [name, value] of borrowed) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	borrowed.clear();
});

function setEnv(name: string, value: string | undefined): void {
	if (!borrowed.has(name)) borrowed.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** Files keyed by path relative to a base, written with their parents. */
function writeTree(base: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		const full = join(base, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

/**
 * Every variable that can put a *tree* outside the fixture's own home.
 *
 * `sourceRoot` asks each source's root function, and eight of the ten read an
 * environment variable first — Step's four among them. A developer with any of
 * these set would have the outcome of a detection test decided by their own
 * machine, so they are all cleared for the duration of a fixture.
 */
const TREE_ENV = [
	"STEPCODE_CONFIG_DIR",
	"STEP_CODING_AGENT_DIR",
	"STEPCODE_STORAGE_ROOT_DIR",
	"STEP_CODING_AGENT_SESSION_DIR",
	MINIMAX_DATA_DIR_ENV,
	MINIMAX_LEGACY_DATA_DIR_ENV,
	KIMI_CODE_HOME_ENV,
	KIMI_SHARE_DIR_ENV,
	"CODEX_HOME",
	"DSH_HOME",
	"GROK_HOME",
];

/**
 * A home with a Step tree in it: `<home>/.stepcode`, created whether or not the
 * fixture puts anything in it.
 *
 * `tree` is keyed relative to that root, so `agent/skills/pdf/SKILL.md` is the
 * tree's own spelling of a skill and `config.toml` is the settings document.
 */
function stepHome(tree: Record<string, string> = {}): { home: string; root: string; agent: string } {
	const home = makeDir("lbb-step-home-");
	for (const name of TREE_ENV) setEnv(name, undefined);
	const root = join(home, STEPCODE_DEFAULT_DIR);
	mkdirSync(root, { recursive: true });
	writeTree(root, tree);
	return { home, root, agent: join(root, "agent") };
}

function plan(home: string, existing: RawSettingsInput = {}, force = false): MigrationPlan {
	return planMigration(readSources(home), existing, { only: ["step-code"], force });
}

function itemsOf(planned: MigrationPlan): MigrationItem[] {
	return planned.items.filter((item) => item.source === "step-code");
}

/** The item details matching, so a test can name one line of the report. */
function detailsMatching(planned: MigrationPlan, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.detail))
		.map((item) => item.detail);
}

/** The `from` labels matching — for the lines whose subject is named there. */
function fromsMatching(planned: MigrationPlan, pattern: RegExp): string[] {
	return itemsOf(planned)
		.filter((item) => pattern.test(item.from))
		.map((item) => item.from);
}

/** The single item whose `to` is exactly this, so a claim can be read whole. */
function itemTo(planned: MigrationPlan, to: string): MigrationItem | undefined {
	return itemsOf(planned).find((item) => item.to === to);
}

/** The settings file the plan would write, parsed. */
function settingsWritten(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((candidate) => candidate.kind === "settings");
	return write === undefined ? {} : (JSON.parse(write.content) as Record<string, unknown>);
}

/** The MCP file the plan would write, parsed into its server table. */
function mcpWritten(planned: MigrationPlan): Record<string, Record<string, unknown>> {
	const write = planned.writes.find((candidate) => candidate.kind === "mcp");
	if (write === undefined) return {};
	const parsed = JSON.parse(write.content) as { mcpServers: Record<string, Record<string, unknown>> };
	return parsed.mcpServers;
}

/** The provider entries the plan would register, in the order it would write them. */
function providersWritten(planned: MigrationPlan): Array<Record<string, unknown>> {
	const providers = settingsWritten(planned).providers as
		| { openaiCompatible?: Array<Record<string, unknown>> }
		| undefined;
	return providers?.openaiCompatible ?? [];
}

/** Everything the report would say, as one string — for the sentinel assertions. */
function reportText(planned: MigrationPlan): string {
	return itemsOf(planned)
		.map((item) => `${item.from}\n${item.to}\n${item.detail}`)
		.join("\n");
}

/** A `models.json` provider table of one provider, in the shape the file holds. */
function modelsJson(providers: Record<string, unknown>): string {
	return JSON.stringify({ providers }, null, "\t");
}

/** One openai-completions model entry, as `models.json` spells it. */
function model(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, api: "openai-completions", baseUrl: "https://gw.example.invalid/v1", ...extra };
}

describe("the ninth source", () => {
	test("it is appended, so the eight before it keep their places", () => {
		// The list is append-only (`MIGRATION_SOURCE_IDS`, migrate.ts:121-136), and
		// its order is what `detectSources` reports — reordering silently changes
		// which of two sources providing the same file wins. So the claim is the
		// position and the eight names above it, not "this is the last one".
		expect(MIGRATION_SOURCE_IDS.indexOf("step-code")).toBe(8);
		expect(MIGRATION_SOURCE_IDS.slice(0, 8)).toEqual([
			"claude-code",
			"codex",
			"zcode",
			"agents",
			"deepseek-harness",
			"grok-build",
			"kimi-code",
			"minimax-code",
		]);
		expect(MIGRATION_SOURCE_LABELS["step-code"]).toBe("Step Code");
	});

	test("--from step-code is accepted, and a misspelling still names the whole list", () => {
		const home = makeDir("lbb-step-root-");
		expect(parseFromOption("step-code", home)).toEqual(["step-code"]);
		const bad = parseFromOption("step", home);
		expect(bad).toHaveProperty("error");
		const message = (bad as { error: string }).error;
		for (const id of MIGRATION_SOURCE_IDS) expect(message).toContain(id);
		expect(message).toContain("all");
	});

	test("detection wants content in the tree, not the directory", () => {
		const { home, root } = stepHome();
		expect(detectSources(home)).not.toContain("step-code");
		writeFileSync(join(root, "config.toml"), 'theme = "dark"\n');
		expect(detectSources(home)).toContain("step-code");
	});

	test("$STEPCODE_CONFIG_DIR moves the tree, and a blank value is unset", () => {
		// `stepConfigDirName` (step-home.ts:41-44) trims the variable and treats an
		// all-whitespace value as unset, which is Step's own reading
		// (`env.STEPCODE_CONFIG_DIR?.trim() || STEPCODE_CONFIG_DIR`): a blank value
		// does not name a directory called "   ".
		const { home, root } = stepHome({ "config.toml": 'theme = "dark"\n' });
		expect(stepRoot(home)).toBe(root);

		setEnv("STEPCODE_CONFIG_DIR", "   ");
		expect(stepRoot(home)).toBe(root);

		// A real value moves the tree — the default directory keeps its file, and
		// the one the variable names is what the report reads.
		const moved = join(home, "step-elsewhere");
		writeTree(moved, { "config.toml": 'theme = "splatoon"\n' });
		setEnv("STEPCODE_CONFIG_DIR", "step-elsewhere");
		expect(stepRoot(home)).toBe(moved);
		expect(settingsWritten(plan(home)).theme).toBe("splatoon");
		expect(detectSources(home)).toContain("step-code");
	});

	test("$STEP_CODING_AGENT_DIR moves the agent directory, and the tree is its parent", () => {
		// `stepConfigRoot` takes the parent of the resolved agent directory, which
		// is Step's own rule (`config.ts:209-215`): the settings document sits
		// *beside* the agent directory rather than inside it.
		const { home } = stepHome();
		const agent = join(home, "elsewhere", "agent");
		writeTree(join(home, "elsewhere"), { "config.toml": 'theme = "light"\n' });
		setEnv("STEP_CODING_AGENT_DIR", agent);
		expect(stepRoot(home)).toBe(join(home, "elsewhere"));
		expect(settingsWritten(plan(home)).theme).toBe("light");
		// The agent directory is the one the session-side reader takes verbatim, so
		// a skill under it is read from where the variable points.
		writeTree(agent, { "skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n" });
		expect(itemTo(plan(home), "~/.labunbun/skills/pdf/SKILL.md")).toBeDefined();
	});

	test("$STEPCODE_STORAGE_ROOT_DIR moves the plugins and marketplaces root", () => {
		// `storage-root.ts:5-7`: the storage root is the plugins/marketplaces half
		// of the tree and does not move `config.toml`. A plugin under it is read
		// from there, and one under the tree's own `plugins/` is not read at all —
		// which is what makes this a test of the variable rather than of both.
		const { home, root } = stepHome({ "config.toml": 'theme = "dark"\n' });
		const storage = join(home, "step-storage");
		writeTree(join(storage, "plugins", "far"), {
			"step.plugin.json": JSON.stringify({ name: "far", skills: ["skills"] }),
			"skills/remote/SKILL.md": "---\nname: remote\n---\nremote skill\n",
		});
		writeTree(join(root, "plugins", "near"), {
			"step.plugin.json": JSON.stringify({ name: "near", skills: ["skills"] }),
			"skills/local/SKILL.md": "---\nname: local\n---\nlocal skill\n",
		});
		setEnv("STEPCODE_STORAGE_ROOT_DIR", storage);
		const planned = plan(home);
		expect(itemTo(planned, "~/.labunbun/skills/remote/SKILL.md")).toBeDefined();
		expect(itemTo(planned, "~/.labunbun/skills/local/SKILL.md")).toBeUndefined();
		expect(detailsMatching(planned, /from the "far" plugin/)).toHaveLength(1);
	});

	test("the pre-rename tree is read when the new one holds nothing, and named", () => {
		const home = makeDir("lbb-step-legacy-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		writeTree(join(home, STEPCODE_LEGACY_DIR), { "config.toml": 'theme = "dark"\n' });
		expect(stepRoot(home)).toBe(join(home, STEPCODE_LEGACY_DIR));
		const planned = plan(home);
		expect(detailsMatching(planned, /Step Code used before its rename/)).toHaveLength(1);
		expect(settingsWritten(planned).theme).toBe("dark");
	});

	test("an override guards the fallback: a named tree that is absent is not replaced by the old one", () => {
		// `stepRoot` (step-home.ts:214-222): a user who set the variable has already
		// said where their tree is, so a directory they did not name — the one
		// Step's *previous* release used — is not read on their behalf.
		const home = makeDir("lbb-step-guard-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		writeTree(join(home, STEPCODE_LEGACY_DIR), { "config.toml": 'theme = "dark"\n' });
		setEnv("STEPCODE_CONFIG_DIR", "step-elsewhere");
		expect(plan(home).items.filter((item) => item.source === "step-code")).toHaveLength(0);
	});
});

describe("the live document, and the two retired ones", () => {
	test("a key in the retired settings.json is reported as retired, not applied", () => {
		const { home } = stepHome({
			"agent/settings.json": JSON.stringify({ theme: "light", model: "claude-opus-5" }),
		});
		const planned = plan(home);
		const [line] = detailsMatching(planned, /retired: this Step build no longer reads it/);
		expect(line).toContain("2 key(s)");
		expect(line).toContain("theme");
		expect(line).toContain("config.toml");
		// Nothing from it reached the settings document: the live document said
		// nothing about a theme, so none was claimed.
		expect(settingsWritten(planned).theme).toBeUndefined();
		expect(settingsWritten(planned).model).toBeUndefined();
	});

	test("the retired settings.json is parsed for names only — its values stay out of the report", () => {
		const { home } = stepHome({
			"agent/settings.json": JSON.stringify({ apiKey: "sk-fake-value-should-never-be-printed" }),
		});
		expect(reportText(plan(home))).not.toContain("sk-fake-value-should-never-be-printed");
	});

	test("a settings.json that will not parse is named as unreadable and as retired", () => {
		const { home } = stepHome({ "agent/settings.json": "{ not json" });
		expect(detailsMatching(plan(home), /not parseable as JSON — and the file is retired in any case/)).toHaveLength(1);
	});

	test("step-settings.json is named by presence, and never opened", () => {
		const { home } = stepHome({
			"agent/step-settings.json": JSON.stringify({ apiKey: "sk-fake-step-settings-never-printed" }),
		});
		const planned = plan(home);
		expect(fromsMatching(planned, /step-settings\.json$/)).toHaveLength(1);
		expect(detailsMatching(planned, /retired in the same sentence as settings\.json/)).toHaveLength(1);
		expect(reportText(planned)).not.toContain("sk-fake-step-settings-never-printed");
	});

	test("a config.toml that will not parse says so rather than looking like an empty one", () => {
		const { home } = stepHome({ "config.toml": "this is [not = toml" });
		expect(
			detailsMatching(plan(home), /config\.toml is not parseable as TOML — nothing in this file was read/),
		).toHaveLength(1);
	});

	test("a key path this parser had to requote is named, and the rest of the file still arrives", () => {
		// TOML 1.0 allows a digits-only segment after a dot and `Bun.TOML` rejects
		// the whole document over it; Step's own parser is spec-compliant, so the
		// document is one Step reads (`readStepConfigDocument`, migrate.ts:3245-3268).
		const { home } = stepHome({
			"config.toml": 'theme = "dark"\n\n[whatever.4]\nkey = "value"\n',
		});
		const planned = plan(home);
		expect(detailsMatching(planned, /had to be requoted to parse this document/)).toHaveLength(1);
		expect(settingsWritten(planned).theme).toBe("dark");
	});
});

describe("the permission posture", () => {
	test("read-only resolves to plan, with the caveat that leaving it is itself an approval", () => {
		const { home } = stepHome({ "config.toml": 'permissionPreset = "read-only"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("plan");
		const [detail] = detailsMatching(planned, /mapped to "plan"/);
		expect(detail).toContain("leaving plan mode here is itself an approval");
	});

	test("the auto preset widens: bypassPermissions, and the report says so", () => {
		// A widening stated rather than implied: Step's auto mode still asks before
		// a command its command analyser calls dangerous, and nothing here asks.
		const { home } = stepHome({ "config.toml": 'permissionPreset = "bypass"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("bypassPermissions");
		const [detail] = detailsMatching(planned, /mapped to "bypassPermissions"/);
		expect(detail).toContain("a wider one");
		expect(detail).toContain("nothing here asks");
	});

	test("the plain modes resolve to the plain answers", () => {
		expect(settingsWritten(plan(stepHome({ "config.toml": 'approvalMode = "confirm"\n' }).home)).permissionMode).toBe(
			"default",
		);
		expect(settingsWritten(plan(stepHome({ "config.toml": 'approvalMode = "strict"\n' }).home)).permissionMode).toBe(
			"plan",
		);
		expect(settingsWritten(plan(stepHome({ "config.toml": 'approvalMode = "auto"\n' }).home)).permissionMode).toBe(
			"bypassPermissions",
		);
	});

	test("an explicit mode beats a preset, and the report says which overrode which", () => {
		// The vendor's order, key for key (`step/settings-manager.ts:141-157`): a
		// mode is read before a preset, and `effectiveMode = approvalMode ??
		// preset.mode`. A reader that took the file's own order would resolve this
		// file the other way round.
		const { home } = stepHome({
			"config.toml": 'permissionPreset = "bypass"\napprovalMode = "strict"\n',
		});
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("plan");
		const [detail] = detailsMatching(planned, /mapped to "plan"/);
		expect(detail).toContain('the preset beside it is "bypass", whose mode "auto" the explicit mode overrides');
	});

	test("a preset beside a mode that agrees with it is named as agreeing", () => {
		const { home } = stepHome({ "config.toml": 'permissionPreset = "ask"\napprovalMode = "confirm"\n' });
		const [detail] = detailsMatching(plan(home), /mapped to "default"/);
		expect(detail).toContain('the preset beside it, "ask", resolves to the same mode');
	});

	test("a mode the vendor's tables do not recognize decides nothing, and is named", () => {
		const { home } = stepHome({ "config.toml": 'permissionMode = "yolo"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		const [detail] = detailsMatching(planned, /not a preset or mode Step reads/);
		expect(detail).toContain("never decided a session there either");
		expect(fromsMatching(planned, /permissionMode \("yolo"\)/)).toHaveLength(1);
	});

	test("an approval mode the vendor does not recognize decides nothing either", () => {
		// The same rule on the other chain: `approvalMode` is read through
		// `resolveStepApprovalMode`, which recognizes Step's three modes and nothing
		// else — a fourth spelling is named and claims no posture at all.
		const { home } = stepHome({ "config.toml": 'approvalMode = "yolo"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		expect(detailsMatching(planned, /not a preset or mode Step reads/)).toHaveLength(1);
		expect(fromsMatching(planned, /approvalMode \("yolo"\)/)).toHaveLength(1);
	});

	test("the autopilot preset's second half is reported, and its third", () => {
		// `autopilot` is two settings in one — an auto posture and an auto-resume
		// ladder — and the ladder has no counterpart here. `normalizeAutoResume`
		// (`permissions.ts:271-281`) only lets the flag count when the mode is auto,
		// which is why the report can say it was in force.
		const { home } = stepHome({ "config.toml": 'permissionPreset = "autopilot"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("bypassPermissions");
		const [detail] = detailsMatching(planned, /a continuation ladder for transient model errors/);
		expect(detail).toContain("it was in force over there");
		expect(fromsMatching(planned, /permissionPreset \("autopilot"\)$/)).toHaveLength(1);
	});

	test("autoResume switched on beside a mode that is not auto was not in force", () => {
		// The flag alone is not the ladder: `normalizeAutoResume` only counts it when
		// the mode is auto, so a file that turns it on beside `confirm` had a
		// continuation that never ran — and the report must not say otherwise.
		const { home } = stepHome({ "config.toml": 'approvalMode = "confirm"\nautoResume = true\n' });
		const [detail] = detailsMatching(plan(home), /a continuation ladder for transient model errors/);
		expect(detail).not.toContain("set to false");
		expect(detail).toContain("it was not in force over there either");
	});

	test("autoResume switched off is reported as off, and as not in force", () => {
		const { home } = stepHome({ "config.toml": 'permissionPreset = "ask"\nautoResume = false\n' });
		const [detail] = detailsMatching(plan(home), /a continuation ladder for transient model errors/);
		expect(detail).toContain("set to false, and");
		expect(detail).toContain("it was not in force over there either");
	});

	test("an unattended run's approval answer is named rather than carried", () => {
		const { home } = stepHome({ "config.toml": 'nonInteractiveApproval = "allow"\n' });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /what an unattended run does with an approval request/);
		expect(detail).toContain("the value is named rather than carried");
		expect(fromsMatching(planned, /nonInteractiveApproval \("allow"\)/)).toHaveLength(1);
		// A value outside the two Step documents decides nothing and is not named.
		expect(
			detailsMatching(plan(stepHome({ "config.toml": 'nonInteractiveApproval = "maybe"\n' }).home), /unattended run/),
		).toHaveLength(0);
	});

	test("the feedback switch is reported as a switch about the vendor's service", () => {
		const { home } = stepHome({ "config.toml": "feedbackEnabled = true\n" });
		expect(detailsMatching(plan(home), /whether Step submits your feedback to the vendor/)).toHaveLength(1);
	});
});

describe("models.json → providers", () => {
	test("an openai-completions provider travels with its models, limits and rates", () => {
		const { home } = stepHome({
			"config.toml": 'theme = "dark"\n',
			"models.json": modelsJson({
				gw: {
					apiKey: "$GW_KEY",
					models: [
						model("m1", {
							name: "M One",
							contextWindow: 200_000,
							maxTokens: 8_192,
							cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.5 },
						}),
					],
				},
			}),
		});
		const [provider] = providersWritten(plan(home));
		expect(provider.id).toBe("step-gw");
		expect(provider.baseUrl).toBe("https://gw.example.invalid/v1");
		// The variable is named; the key itself is not read (`stepApiKeyName`).
		expect(provider.apiKeyEnv).toBe("GW_KEY");
		expect(provider.models).toEqual([
			{
				id: "m1",
				name: "M One",
				contextWindow: 200_000,
				maxOutputTokens: 8_192,
				pricing: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.5 },
			},
		]);
	});

	test("a per-model override is what a session ran under where it disagrees with the model", () => {
		// `stepModelEntries` reads `provider.modelOverrides[id]` first, which is how the
		// vendor's own composer applies an override on top of the model it names
		// (`core/provider-composer.ts`) — so the override is the number a session over
		// there was running under, and the model's own field is not.
		const { home } = stepHome({
			"models.json": modelsJson({
				gw: {
					apiKey: "$GW_KEY",
					models: [model("m1", { contextWindow: 200_000, maxTokens: 8_192 })],
					modelOverrides: { m1: { contextWindow: 32_000, maxTokens: 4_096 } },
				},
			}),
		});
		const [{ models }] = providersWritten(plan(home)) as Array<{ models: Array<Record<string, unknown>> }>;
		expect(models[0].contextWindow).toBe(32_000);
		expect(models[0].maxOutputTokens).toBe(4_096);
	});

	test("a model that states no limits gets the vendor's own fallbacks", () => {
		// `provider-composer.ts:165-166`: 128k context and 16 384 output tokens are
		// what a session over there was running under, and the schema here requires
		// both.
		const { home } = stepHome({
			"models.json": modelsJson({ gw: { apiKey: "$GW_KEY", models: [model("m1")] } }),
		});
		const [{ models }] = providersWritten(plan(home)) as Array<{ models: Array<Record<string, unknown>> }>;
		expect(models[0].contextWindow).toBe(128_000);
		expect(models[0].maxOutputTokens).toBe(16_384);
		expect(models[0].pricing).toBeUndefined();
	});

	test("a provider whose models speak another protocol is skipped by name", () => {
		const { home } = stepHome({
			"models.json": modelsJson({
				claude: {
					apiKey: "$C_KEY",
					models: [{ id: "m1", api: "anthropic-messages", baseUrl: "https://gw.example.invalid/v1" }],
				},
			}),
		});
		const planned = plan(home);
		expect(providersWritten(planned)).toHaveLength(0);
		const [detail] = detailsMatching(planned, /no model this build can serve/);
		expect(detail).toContain("m1 (anthropic-messages)");
		expect(detail).toContain("one chat-completions endpoint");
	});

	test("a model with no protocol at all is skipped the way Step's own composer refuses it", () => {
		const { home } = stepHome({
			"models.json": modelsJson({ gw: { apiKey: "$GW_KEY", models: [{ id: "m1", baseUrl: "https://x.invalid/v1" }] } }),
		});
		expect(
			detailsMatching(plan(home), /name no protocol at all.*refuses as well \("no "api" specified"\)/),
		).toHaveLength(1);
	});

	test("a model with no endpoint, and a provider with none either, is one skip line", () => {
		// The third disposition: the protocol is one this build speaks, but there is
		// no endpoint to speak it to — neither the model's own nor the provider's.
		const { home } = stepHome({
			"models.json": modelsJson({ gw: { apiKey: "$GW_KEY", models: [{ id: "m1", api: "openai-completions" }] } }),
		});
		const planned = plan(home);
		expect(providersWritten(planned)).toHaveLength(0);
		expect(
			detailsMatching(planned, /1 model\(s\) name neither an endpoint of their own nor a provider one/),
		).toHaveLength(1);
	});

	test("a provider whose models answer at two endpoints is refused rather than half-registered", () => {
		const { home } = stepHome({
			"models.json": modelsJson({
				gw: {
					apiKey: "$GW_KEY",
					models: [
						model("m1", { baseUrl: "https://one.example.invalid/v1" }),
						model("m2", { baseUrl: "https://two.example.invalid/v1" }),
					],
				},
			}),
		});
		const planned = plan(home);
		expect(providersWritten(planned)).toHaveLength(0);
		const [detail] = detailsMatching(planned, /answer at 2 different endpoints/);
		expect(detail).toContain("split them into a provider each and import them by hand");
	});

	test("a literal apiKey is reported by shape, and its value is in no line of the report", () => {
		const { home } = stepHome({
			"models.json": modelsJson({
				gw: { apiKey: "sk-fake-literal-should-never-be-printed", models: [model("m1")] },
			}),
		});
		const planned = plan(home);
		const [provider] = providersWritten(planned);
		expect(provider.apiKeyEnv).toBe("GW_API_KEY");
		expect(detailsMatching(planned, /the key written in its apiKey was not read/)).toHaveLength(1);
		expect(reportText(planned)).not.toContain("sk-fake-literal-should-never-be-printed");
		// And it is not in the file the plan would write either.
		const written = planned.writes.find((write) => write.kind === "settings")?.content ?? "";
		expect(written).not.toContain("sk-fake-literal-should-never-be-printed");
	});

	test("a provider with no apiKey names the variable this build will read instead", () => {
		const { home } = stepHome({ "models.json": modelsJson({ gw: { models: [model("m1")] } }) });
		const planned = plan(home);
		expect(providersWritten(planned)[0].apiKeyEnv).toBe("GW_API_KEY");
		expect(detailsMatching(planned, /it names no api key variable, so this build reads \$GW_API_KEY/)).toHaveLength(1);
	});

	test("an apiKey produced by a shell command is named as one, and the command is never run", () => {
		const { home } = stepHome({
			"models.json": modelsJson({ gw: { apiKey: "!op read op://vault/key", models: [model("m1")] } }),
		});
		expect(
			detailsMatching(plan(home), /its key is produced by a shell command, which was neither read nor run/),
		).toHaveLength(1);
	});

	test("the ${VAR} spelling names the same variable as $VAR", () => {
		const { home } = stepHome({ "models.json": modelsJson({ gw: { apiKey: "${GW_KEY}", models: [model("m1")] } }) });
		expect(providersWritten(plan(home))[0].apiKeyEnv).toBe("GW_KEY");
	});

	test("a provider id the user already has is kept unless --force says otherwise", () => {
		const { home } = stepHome({ "models.json": modelsJson({ gw: { apiKey: "$GW_KEY", models: [model("m1")] } }) });
		const existing: RawSettingsInput = {
			providers: {
				openaiCompatible: [{ id: "step-gw", baseUrl: "https://x.invalid", apiKeyEnv: "STEP_GW_KEY", models: [] }],
			},
		};
		const kept = plan(home, existing);
		expect(providersWritten(kept)).toHaveLength(0);
		expect(detailsMatching(kept, /already defines a provider with the id this would take \(step-gw\)/)).toHaveLength(1);

		const forced = plan(home, existing, true);
		expect(providersWritten(forced).map((provider) => provider.id)).toEqual(["step-gw"]);
		expect(detailsMatching(forced, /it replaces the provider already registered as step-gw/)).toHaveLength(1);
	});
});

describe("defaultModel and defaultProvider", () => {
	test("a model of an imported provider is rewritten to the id that provider lands under", () => {
		const { home } = stepHome({
			"config.toml": 'defaultProvider = "gw"\ndefaultModel = "m1"\n',
			"models.json": modelsJson({ gw: { apiKey: "$GW_KEY", models: [model("m1")] } }),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe("step-gw/m1");
		expect(detailsMatching(planned, /the same model under the id your provider is imported as/)).toHaveLength(1);
	});

	test("a model the named provider does not list is a skip, not a reference to nothing", () => {
		const { home } = stepHome({
			"config.toml": 'defaultProvider = "gw"\ndefaultModel = "m9"\n',
			"models.json": modelsJson({ gw: { apiKey: "$GW_KEY", models: [model("m1")] } }),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(
			detailsMatching(
				planned,
				/your provider "gw" does not list a model called "m9", so the reference would point at nothing/,
			),
		).toHaveLength(1);
	});

	test("a provider whose own line was a skip is pointed at rather than silently dropped", () => {
		const { home } = stepHome({
			"config.toml": 'defaultProvider = "claude"\ndefaultModel = "m1"\n',
			"models.json": modelsJson({
				claude: {
					apiKey: "$C_KEY",
					models: [{ id: "m1", api: "anthropic-messages", baseUrl: "https://x.invalid/v1" }],
				},
			}),
		});
		expect(detailsMatching(plan(home), /which this run did not import — see its own line above/)).toHaveLength(1);
	});

	test("a provider that is not in models.json at all is named as not one this build registers", () => {
		const { home } = stepHome({ "config.toml": 'defaultProvider = "nope"\ndefaultModel = "m1"\n' });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /is not a provider this build registers/);
		expect(detail).toContain('"nope"');
	});

	test("with no provider named, the question is this build's own registry", () => {
		const { home } = stepHome({ "config.toml": 'defaultModel = "claude-opus-5"\n' });
		expect(settingsWritten(plan(home)).model).toBe(resolveModelReference("claude-opus-5"));

		const unknown = stepHome({ "config.toml": 'defaultModel = "step-k9-unreleased"\n' });
		const planned = plan(unknown.home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /no model of that name exists here/)).toHaveLength(1);
	});

	test("a provider with no model chosen has nothing to write a reference out of", () => {
		const { home } = stepHome({ "config.toml": 'defaultProvider = "gw"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /a provider with no model chosen for it/)).toHaveLength(1);
	});

	test("a model reference already in the target's settings is kept unless --force", () => {
		const { home } = stepHome({ "config.toml": 'defaultModel = "claude-opus-5"\n' });
		const existing: RawSettingsInput = { model: "claude-sonnet-5" };
		expect(settingsWritten(plan(home, existing)).model).toBeUndefined();
		expect(detailsMatching(plan(home, existing), /target already sets model to "claude-sonnet-5"/)).toHaveLength(1);
		expect(settingsWritten(plan(home, existing, true)).model).toBe("claude-opus-5");
	});
});

describe("theme", () => {
	test("a built-in name is claimed, and nothing about files is said", () => {
		const { home } = stepHome({ "config.toml": 'theme = "high-contrast-dark"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).theme).toBe("high-contrast-dark");
		expect(detailsMatching(planned, /the built-in theme of the same name/)).toHaveLength(1);
	});

	test("a name a theme file's body carries is recognized as the user's own theme", () => {
		// The name comes from the `name` field inside the file, not from its stem
		// (`theme/theme.ts:555-560`), and the file itself is not converted: the two
		// vocabularies diverge.
		const { home } = stepHome({
			"config.toml": 'theme = "plum"\n',
			"agent/themes/mine.json": JSON.stringify({ name: "plum", vars: { bg: "#000" }, colors: { text: "fg" } }),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).theme).toBeUndefined();
		const [detail] = detailsMatching(planned, /it names a theme file of your own under the agent directory/);
		expect(detail).toContain("`vars`/`colors` palette");
		expect(detail).toContain("was not converted");
		// And the file is counted among the ones left behind.
		expect(detailsMatching(planned, /1 theme file\(s\), not converted/)).toHaveLength(1);
	});

	test("a name that is neither built in nor in any theme file lists what this build ships", () => {
		const { home } = stepHome({
			"config.toml": 'theme = "solarized"\n',
			"agent/themes/mine.json": JSON.stringify({ name: "plum" }),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).theme).toBeUndefined();
		const [detail] = detailsMatching(planned, /no built-in theme here has that name/);
		expect(detail).toContain("dark");
		expect(detail).toContain('named by the "name" inside the file');
	});

	test("a theme file whose body names nothing contributes no name, and is still counted", () => {
		const { home } = stepHome({
			"config.toml": 'theme = "plum"\n',
			"agent/themes/broken.json": "{ not json",
		});
		expect(settingsWritten(plan(home)).theme).toBeUndefined();
		expect(detailsMatching(plan(home), /1 theme file\(s\), not converted/)).toHaveLength(1);
	});

	test("theme files are named and their conversion refused with the reason", () => {
		const { home } = stepHome({
			"config.toml": 'theme = "mine"\n',
			"agent/themes/mine.json": JSON.stringify({ name: "mine" }),
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /not converted: a Step theme is a table of named/);
		expect(detail).toContain("flat `tokens` table");
		expect(detail).toContain("Copy the colours across into `~/.labunbun/themes/<name>.json`");
	});
});

describe("mcp_servers", () => {
	test("a stdio server travels with its arguments, environment and working directory", () => {
		const { home } = stepHome({
			"config.toml":
				'[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-server"]\ncwd = "/tmp/docs"\n\n' +
				'[mcp_servers.docs.env]\nDOCS_URL = "https://docs.example.invalid"\n',
		});
		const planned = plan(home);
		expect(mcpWritten(planned).docs).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "docs-server"],
			env: { DOCS_URL: "https://docs.example.invalid" },
			cwd: "/tmp/docs",
		});
		const item = itemTo(planned, ".mcp.json → mcpServers.docs");
		expect(item?.detail).toBe("copied verbatim");
		expect(item?.containsSecret).toBe(false);
	});

	test("an http server carries its headers, and a secret-looking one is marked", () => {
		const { home } = stepHome({
			"config.toml":
				'[mcp_servers.remote]\nurl = "https://mcp.example.invalid/sse"\nhttp_headers = { Authorization = "Bearer fake" }\n',
		});
		const planned = plan(home);
		expect(mcpWritten(planned).remote).toEqual({
			type: "http",
			url: "https://mcp.example.invalid/sse",
			headers: { Authorization: "Bearer fake" },
		});
		expect(itemTo(planned, ".mcp.json → mcpServers.remote")?.containsSecret).toBe(true);
	});

	test("a server switched off is refused, because this build cannot keep a definition switched off", () => {
		const { home } = stepHome({
			"config.toml": '[mcp_servers.old]\ncommand = "run"\nenabled = false\n',
		});
		const planned = plan(home);
		expect(mcpWritten(planned).old).toBeUndefined();
		const [detail] = detailsMatching(planned, /switched off in config\.toml/);
		expect(detail).toContain("connect every later session to a server you had turned off");
	});

	test("the keys that do not fit are one named downgrade each, on the server's own line", () => {
		const { home } = stepHome({
			"config.toml":
				'[mcp_servers.loaded]\ncommand = "run"\nstartup_timeout_sec = 30\ntool_timeout_sec = 5\n' +
				'enabled_tools = ["a", "b"]\ndisabled_tools = ["c"]\nweird = true\n\n' +
				'[mcp_servers.loaded.oauth]\nclient_id = "client"\n',
		});
		const planned = plan(home);
		const item = itemTo(planned, ".mcp.json → mcpServers.loaded");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("copied verbatim — ");
		for (const fragment of [
			"it is given 30s to start, and this build has one connect timeout for every server",
			"it is given 5s per tool call, and this build has no per-call timeout",
			"it filters its own tools (2 enabled, 1 disabled), and every tool a server advertises is available here",
			"it registers an OAuth client, which this build has no store for — you will have to authorize it there",
			"weird has no counterpart here",
		]) {
			expect(item?.detail).toContain(fragment);
		}
	});

	test("a bearer token variable is named and the Authorization header is not invented", () => {
		const { home } = stepHome({
			"config.toml":
				'[mcp_servers.remote]\nurl = "https://mcp.example.invalid/sse"\nbearer_token_env_var = "MCP_TOKEN"\n',
		});
		const planned = plan(home);
		expect(mcpWritten(planned).remote).toEqual({ type: "http", url: "https://mcp.example.invalid/sse" });
		const [detail] = detailsMatching(planned, /it authenticates with a bearer token read from \$MCP_TOKEN/);
		expect(detail).toContain("the Authorization header was not copied");
	});

	test("headers filled from variables are named as variables, never expanded", () => {
		const { home } = stepHome({
			"config.toml":
				'[mcp_servers.remote]\nurl = "https://mcp.example.invalid/sse"\n' +
				'env_http_headers = { "X-Api-Key" = "THE_KEY" }\n',
		});
		const planned = plan(home);
		expect(mcpWritten(planned).remote).toEqual({ type: "http", url: "https://mcp.example.invalid/sse" });
		expect(detailsMatching(planned, /X-Api-Key would be filled from \$THE_KEY over there/)).toHaveLength(1);
	});

	test("a server with neither a command nor a url decides nothing on either side", () => {
		const { home } = stepHome({ "config.toml": "[mcp_servers.empty]\ntimeout = 3\n" });
		const planned = plan(home);
		expect(mcpWritten(planned).empty).toBeUndefined();
		expect(
			detailsMatching(planned, /it names neither a command nor a url, so Step has nothing to connect either/),
		).toHaveLength(1);
	});

	test("a command that is only whitespace names nothing, the way an absent one does", () => {
		const { home } = stepHome({ "config.toml": '[mcp_servers.blank]\ncommand = "   "\n' });
		const planned = plan(home);
		expect(mcpWritten(planned).blank).toBeUndefined();
		expect(detailsMatching(planned, /it names neither a command nor a url/)).toHaveLength(1);
	});

	test("a stdio server carrying http-only keys says which keys only an http server uses", () => {
		const { home } = stepHome({
			"config.toml": '[mcp_servers.mixed]\ncommand = "run"\nurl = "https://mcp.example.invalid/sse"\n',
		});
		const planned = plan(home);
		expect(mcpWritten(planned).mixed).toMatchObject({ type: "stdio" });
		expect(detailsMatching(planned, /it also carries url, which only an http server uses/)).toHaveLength(1);
	});

	test("a name the target already has is kept unless --force says otherwise", () => {
		const { home } = stepHome({ "config.toml": '[mcp_servers.docs]\ncommand = "npx"\n' });
		writeTree(join(home, ".labunbun"), {
			".mcp.json": JSON.stringify({ mcpServers: { docs: { type: "stdio", command: "theirs" } } }),
		});
		const kept = plan(home);
		// Nothing is added, so there is no `.mcp.json` to write at all — the file
		// the user already has is left exactly as it is.
		expect(kept.writes.some((write) => write.kind === "mcp")).toBe(false);
		expect(detailsMatching(kept, /target already defines a server with this name — kept/)).toHaveLength(1);

		const forced = plan(home, {}, true);
		expect(mcpWritten(forced).docs).toMatchObject({ command: "npx" });
	});
});

describe("keys with no counterpart, and the closing report", () => {
	test("each key the build has no setting for is one line with its reason", () => {
		const { home } = stepHome({
			"config.toml":
				'defaultThinkingLevel = "high"\ndefaultTools = "all"\n' +
				'transport = { type = "http" }\nextensions = []\npackages = []\nenabledModels = ["m1"]\n',
		});
		const planned = plan(home);
		for (const fragment of [
			"a thinking level this build has no setting for",
			"which transport the model client uses; this build picks its own",
			"Pi extensions, which this build has no loader for",
			"Pi packages, the same",
			"a model-picker allow-list, which this build has no picker setting for",
			"a default tool set, which this build's sessions decide for themselves",
		]) {
			expect(detailsMatching(planned, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toHaveLength(1);
		}
	});

	test("a key nothing above handled is named by the closing aggregate", () => {
		const { home } = stepHome({ "config.toml": 'theme = "dark"\nmysteryKey = 1\n' });
		const planned = plan(home);
		// Handled keys are not in it; the one nothing read is, named in the `from`
		// under the file it came from rather than in a detail of its own.
		expect(fromsMatching(planned, /config\.toml → mysteryKey$/)).toHaveLength(1);
		expect(detailsMatching(planned, /key\(s\) this importer has no mapping for and no note about/)).toHaveLength(1);
		expect(fromsMatching(planned, /config\.toml → \w+$/)).toEqual(["~/.stepcode/config.toml → mysteryKey"]);
	});

	test("a key under [tools] that is not the approval table is named, and the approval table is not", () => {
		const { home } = stepHome({
			"config.toml": '[tools]\nunknownThing = 2\n\n[tools.approval]\nmode = "confirm"\n',
		});
		const planned = plan(home);
		// The mode was read out of the approval table, and the only key under
		// `tools` the closing line names is the one nothing read: `approval` is
		// accounted for by the claim above it.
		expect(settingsWritten(planned).permissionMode).toBe("default");
		expect(fromsMatching(planned, /config\.toml → tools\.approval\.mode$/)).toHaveLength(1);
		expect(fromsMatching(planned, /config\.toml → tools →/)).toEqual([
			"~/.stepcode/config.toml → tools → unknownThing",
		]);
	});

	test("the telemetry switch is reported as a switch about the vendor's service", () => {
		const { home } = stepHome({ "config.toml": "telemetry = { enabled = true }\n" });
		expect(detailsMatching(plan(home), /where Step sends its own usage reports/)).toHaveLength(1);
	});

	test("an unrelated file at the root is named rather than passed over", () => {
		const { home } = stepHome({ "config.toml": 'theme = "dark"\n', "notes.md": "hello\n" });
		const planned = plan(home);
		expect(fromsMatching(planned, /notes\.md$/)).toHaveLength(1);
		expect(detailsMatching(planned, /neither settings, state nor credentials/)).toHaveLength(1);
	});

	test("a directory at the root with no counterpart is named rather than passed over", () => {
		// The root's own accounting: `agent`, `plugins` and `marketplaces` are read,
		// and everything else is listed with its size rather than left silent.
		const { home } = stepHome({ "mystery-dir/one.txt": "x\n" });
		const planned = plan(home);
		expect(detailsMatching(planned, /no mapping here for these, so they were left where they are/)).toHaveLength(1);
		expect(fromsMatching(planned, /mystery-dir \(1\)/)).toHaveLength(1);
	});
});

describe("assets", () => {
	test("skills, agents and prompts land where this build reads them", () => {
		const { home } = stepHome({
			"agent/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill forms\n",
			"agent/agents/helper.md": "---\nname: helper\ndescription: helps\n---\nbe helpful\n",
			"agent/prompts/review.md": "---\ndescription: review a diff\n---\nReview $ARGUMENTS\n",
		});
		const planned = plan(home);
		expect(itemTo(planned, "~/.labunbun/skills/pdf/SKILL.md")?.action).toBe("map");
		expect(itemTo(planned, "~/.labunbun/agents/helper.md")?.action).toBe("map");
		const prompt = itemTo(planned, "~/.labunbun/skills/review/SKILL.md");
		expect(prompt?.detail).toContain("command imported as a skill: frontmatter rewritten to name/description");
		expect(prompt?.detail).toContain("$ARGUMENTS is substituted, $1..$9 and inline shell expansion are not");
	});

	test("a plugin's resources travel with the user's, each naming the plugin it came from", () => {
		const { home } = stepHome({
			"plugins/pdf-tools/step.plugin.json": JSON.stringify({ name: "pdf-tools", skills: ["skills"] }),
			"plugins/pdf-tools/skills/forms/SKILL.md": "---\nname: forms\n---\nforms\n",
		});
		const planned = plan(home);
		const item = itemTo(planned, "~/.labunbun/skills/forms/SKILL.md");
		expect(item?.detail).toContain('from the "pdf-tools" plugin');
		// The plugin line names the plugins in its `from` — the detail is about
		// what is left behind, which holds for every plugin there is.
		expect(fromsMatching(planned, /plugins \(pdf-tools\)/)).toHaveLength(1);
		expect(detailsMatching(planned, /1 installed plugin\(s\)/)).toHaveLength(1);
	});

	test("a plugin's manifest that will not parse is named, and nothing it declares is taken", () => {
		const { home } = stepHome({
			"plugins/broken/step.plugin.json": "{ not json",
			"plugins/broken/skills/x/SKILL.md": "---\nname: x\n---\nx\n",
		});
		const planned = plan(home);
		expect(itemTo(planned, "~/.labunbun/skills/x/SKILL.md")).toBeUndefined();
		expect(detailsMatching(planned, /plugin manifests that could not be read as JSON/)).toHaveLength(1);
		expect(fromsMatching(planned, /plugins \(broken: /)).toHaveLength(1);
	});

	test("a plugin shipping code and declaring MCP servers is named as both", () => {
		const { home } = stepHome({
			"plugins/coder/step.plugin.json": JSON.stringify({
				name: "coder",
				entry: "index.ts",
				mcpServers: { docs: { command: "run" } },
			}),
		});
		const [detail] = detailsMatching(plan(home), /1 installed plugin\(s\)/);
		expect(detail).toContain("declaring MCP servers (coder)");
		expect(detail).toContain("shipping code (coder)");
		expect(detail).toContain("this build has no plugin host to run it in");
	});

	test("the system-prompt documents become rule files, and the standing line says how they land", () => {
		const { home } = stepHome({
			"agent/SYSTEM.md": "You are thorough.\n",
			"agent/APPEND_SYSTEM.md": "Prefer tests.\n",
		});
		const planned = plan(home);
		expect(itemTo(planned, "~/.labunbun/rules/imported-step-code.md")?.action).toBe("map");
		expect(itemTo(planned, "~/.labunbun/rules/imported-step-code-append.md")?.action).toBe("map");
		const [detail] = detailsMatching(planned, /Step splices the first into its own system prompt/);
		expect(detail).toContain("a rule file here is a memory section of the system prompt");
	});

	test("a SYSTEM.md whose text is only whitespace imports nothing, and says nothing", () => {
		const { home } = stepHome({ "agent/SYSTEM.md": "   \n\n" });
		const planned = plan(home);
		expect(itemTo(planned, "~/.labunbun/rules/imported-step-code.md")).toBeUndefined();
		expect(detailsMatching(planned, /splices the first into its own system prompt/)).toHaveLength(0);
	});

	test("a skill directory named in config.toml is read, and a glob entry among the paths is not", () => {
		const { home } = stepHome({
			"config.toml": 'skills = ["~/.stepcode/shared-skills", "!*/legacy"]\n',
			"shared-skills/extra/SKILL.md": "---\nname: extra\n---\nextra\n",
		});
		const planned = plan(home);
		expect(itemTo(planned, "~/.labunbun/skills/extra/SKILL.md")).toBeDefined();
		const [detail] = detailsMatching(planned, /glob entries among the resource paths/);
		expect(detail).toContain("nothing to select");
		expect(fromsMatching(planned, /!\/legacy|!\*\/legacy/)).toHaveLength(1);
	});

	test("a prompt directory named in config.toml is read beside the agent directory's own", () => {
		// `prompts` is a resource list like `skills` (`core/settings-manager.ts`), and
		// `<agentDir>/prompts` is only the first root of it: a template in a listed
		// directory is one of the user's prompts and lands as a skill like any other.
		const { home } = stepHome({ "config.toml": 'prompts = ["~/.stepcode/shared-prompts"]\n' });
		writeTree(join(home, STEPCODE_DEFAULT_DIR), {
			"shared-prompts/review.md": "---\ndescription: review a diff\n---\nReview $ARGUMENTS\n",
		});
		expect(itemTo(plan(home), "~/.labunbun/skills/review/SKILL.md")?.action).toBe("map");
	});

	test("a theme directory named in config.toml is counted with the theme files", () => {
		const { home } = stepHome({ "config.toml": 'themes = ["~/.stepcode/shared-themes"]\n' });
		writeTree(join(home, STEPCODE_DEFAULT_DIR), { "shared-themes/plum.json": JSON.stringify({ name: "plum" }) });
		const planned = plan(home);
		// Nothing under `<agentDir>/themes`, so the sentence stands on the listed path
		// alone — which is the whole point of naming it.
		expect(detailsMatching(planned, /1 theme file\(s\), not converted/)).toHaveLength(1);
		expect(fromsMatching(planned, /shared-themes$/)).toHaveLength(1);
	});

	test("a bare ~ in a resource list is the home directory rather than the agent directory", () => {
		// `splitStepExtraDirs`: `~` and `~/…` resolve against the home, an absolute
		// path stands as it is, and a bare relative one resolves against the agent
		// directory. Reading `~` as a name under the agent directory would find
		// nothing at all.
		const { home } = stepHome({ "config.toml": 'skills = ["~"]\n' });
		writeTree(home, { "mine/SKILL.md": "---\nname: mine\n---\nmine\n" });
		expect(itemTo(plan(home), "~/.labunbun/skills/mine/SKILL.md")?.action).toBe("map");
	});

	test("marketplace checkouts are named as the catalogues they are", () => {
		const { home } = stepHome({
			"marketplaces/one/plugin.json": JSON.stringify({ name: "one" }),
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /marketplace checkouts/);
		expect(detail).toContain("the plugins installed *from* them were read above");
	});

	test("the state files are named with the reason they are state rather than settings", () => {
		const { home } = stepHome({ "mcp-import.json": "{}", "models-store.json": "{}" });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /which MCP sources were already reviewed for import/);
		expect(detail).toContain("the credential store beside models.json");
		expect(fromsMatching(planned, /mcp-import\.json, models-store\.json$/)).toHaveLength(1);
	});

	test("a state file under the agent directory is named with a forward slash, and with its reason", () => {
		// The names under the agent directory are *labels*, not paths (`readStepCode`):
		// they are spelled `agent/<name>` because every path in the report is rendered
		// with forward slashes, and `STEP_STATE_FILES` is keyed by the leaf name — the
		// label is not the key.
		const { home } = stepHome({ "agent/mcp-import.json": "{}" });
		const planned = plan(home);
		expect(fromsMatching(planned, /agent\/mcp-import\.json$/)).toHaveLength(1);
		expect(detailsMatching(planned, /which MCP sources were already reviewed for import/)).toHaveLength(1);
	});

	test("credentials are named and never opened", () => {
		const { home } = stepHome({
			"auth.json": JSON.stringify({ token: "fake-auth-value-never-printed" }),
			"agent/credentials.json": JSON.stringify({ key: "fake-credential-value-never-printed" }),
		});
		const planned = plan(home);
		expect(detailsMatching(planned, /credential-shaped entries reported by name and never opened/)).toHaveLength(1);
		// Both trees are covered, and the label under the agent directory is spelled
		// with a forward slash like every other path in the report.
		expect(fromsMatching(planned, /agent\/credentials\.json, auth\.json$/)).toHaveLength(1);
		const report = reportText(planned);
		expect(report).not.toContain("fake-auth-value-never-printed");
		expect(report).not.toContain("fake-credential-value-never-printed");
		// And nothing in the plan would write either file.
		expect(planned.writes.some((write) => /credential|auth\.json/.test(write.path))).toBe(false);
	});

	test("directories under the agent directory are named as code and state", () => {
		const { home } = stepHome({
			"agent/extensions/one.ts": "export {};\n",
			"agent/tools/two.ts": "export {};\n",
		});
		const planned = plan(home);
		const [detail] = detailsMatching(
			planned,
			/directories under the agent directory this importer reads nothing out of/,
		);
		expect(detail).toContain("`extensions` and `tools` are code Step loads at startup");
		expect(fromsMatching(planned, /agent\/extensions \(1\)/)).toHaveLength(1);
	});

	test("the other two models.json spellings are named, and only one is read", () => {
		// `readStepModels` (migrate.ts:3549-3583): the CLI's own file wins; the agent
		// directory's copy is Pi's default and is a different file whenever the two
		// roots differ, so it is named rather than registered from.
		const { home } = stepHome({
			"models.json": modelsJson({ near: { apiKey: "$N_KEY", models: [model("m1")] } }),
			"agent/models.json": modelsJson({ far: { apiKey: "$F_KEY", models: [model("m2")] } }),
		});
		const planned = plan(home);
		expect(providersWritten(planned).map((provider) => provider.id)).toEqual(["step-near"]);
		const [detail] = detailsMatching(planned, /the agent directory's own models\.json/);
		expect(detail).toContain(
			"a second table of providers would register endpoints from a file that may no longer be read",
		);
	});

	test("the agent directory's models.json is read when the CLI's own file is absent", () => {
		const { home } = stepHome({
			"agent/models.json": modelsJson({ far: { apiKey: "$F_KEY", models: [model("m2")] } }),
		});
		const planned = plan(home);
		expect(providersWritten(planned).map((provider) => provider.id)).toEqual(["step-far"]);
		expect(detailsMatching(planned, /the agent directory's own models\.json/)).toHaveLength(0);
	});

	test("the agent directory's models.json is not named when there is no such file", () => {
		// The guard on that line is the file's existence and not the two roots
		// differing (`readStepModels`): naming a second table that is not there would
		// report a file this run never looked at.
		const { home } = stepHome({ "models.json": modelsJson({ near: { apiKey: "$N_KEY", models: [model("m1")] } }) });
		const planned = plan(home);
		expect(providersWritten(planned).map((provider) => provider.id)).toEqual(["step-near"]);
		expect(detailsMatching(planned, /the agent directory's own models\.json/)).toHaveLength(0);
	});

	test("a project's own Step tree is named as out of reach, in every run", () => {
		// A `.stepcode/` beside a repository looks like this source's own tree, so a
		// user who does not find it mentioned reads the silence as a bug.
		const { home } = stepHome({ "config.toml": 'theme = "dark"\n' });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /a project's resources live beside the project/);
		expect(detail).toContain("walking up from the working directory");
		expect(fromsMatching(planned, /each working directory's own .*\/\{skills,prompts,themes,agents\}/)).toHaveLength(1);
	});

	test("the tree the run read is named when it is the pre-rename one", () => {
		const home = makeDir("lbb-step-legacy-assets-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		writeTree(join(home, STEPCODE_LEGACY_DIR), { "agent/skills/pdf/SKILL.md": "---\nname: pdf\n---\nfill\n" });
		const planned = plan(home);
		expect(detailsMatching(planned, /Step Code used before its rename/)).toHaveLength(1);
		expect(itemTo(planned, "~/.labunbun/skills/pdf/SKILL.md")).toBeDefined();
	});

	test("a skill the target already has is kept unless --force says otherwise", () => {
		const { home } = stepHome({ "agent/skills/pdf/SKILL.md": "---\nname: pdf\n---\ntheirs\n" });
		writeTree(join(home, ".labunbun"), { "skills/pdf/SKILL.md": "mine\n" });
		expect(detailsMatching(plan(home), /target skill already exists — kept/)).toHaveLength(1);
		expect(itemTo(plan(home, {}, true), "~/.labunbun/skills/pdf/SKILL.md")?.action).toBe("map");
	});
});

describe("reading the tree", () => {
	test("the reader reports the tree it chose, and the legacy flag with it", () => {
		const { home, root } = stepHome({ "config.toml": 'theme = "dark"\n' });
		const raw = readStepCode(home);
		expect(raw.root).toBe(root);
		expect(raw.legacy).toBe(false);
		expect(raw.present).toBe(true);
		expect(raw.agentDir).toBe(join(root, "agent"));
		expect(raw.config).toEqual({ theme: "dark" });
	});

	test("a tree that is not there reads as absent rather than as empty", () => {
		const home = makeDir("lbb-step-absent-");
		for (const name of TREE_ENV) setEnv(name, undefined);
		expect(readStepCode(home).present).toBe(false);
		expect(plan(home).items.filter((item) => item.source === "step-code")).toHaveLength(0);
	});
});
