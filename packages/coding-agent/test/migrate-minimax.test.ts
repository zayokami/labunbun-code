/**
 * The `minimax-code` source, planner half: `config.yaml`, `permission.json`,
 * `mcp.json`, the provider table, and the source's place in the lists.
 *
 * MiniMax Code's tree has three historical names and only one of them is live,
 * so where the tree is has a module of its own (`minimax-home.ts`) and the first
 * describe below pins what the planner asks of it: `$MINIMAX_DATA_DIR` beats
 * `$MAVIS_DATA_DIR`, and an all-whitespace value is *unset* rather than a
 * directory name — the opposite of `$DSH_HOME`, which the memory of this repo
 * says counts pure whitespace as a value, and the same as nothing else.
 *
 * The planner's decisions are policy calls, and a policy call that is not
 * written down reads as an oversight. Each test below names the function it
 * pins and, where the wording *is* the decision, quotes it:
 * `planMinimaxPermissionMode` carries `off` as `bypassPermissions` because
 * MiniMax itself calls it that; `planMinimaxPermissions` refuses a file
 * `readMinimaxPermissions` refused, whole, rather than importing the allows out
 * of a store the source is refusing to honour; `planMinimaxProviders` reads a
 * variable *name* out of `env[]` and never a key — the difference between
 * naming a credential and copying one.
 *
 * Fixtures hold fake values only. No test opens `auth/`, `credentials/`,
 * `cli-auth/` or a BYOK key: those paths are named in the report and never read,
 * which is the property the sentinel assertions below exist to keep.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	detectSources,
	MIGRATION_SOURCE_IDS,
	MIGRATION_SOURCE_LABELS,
	type MigrationItem,
	type MigrationPlan,
	parseFromOption,
	planMigration,
	readMinimaxCode,
	readSources,
	resolveModelReference,
} from "../src/migrate.ts";
import {
	MINIMAX_DATA_DIR_BASENAME,
	MINIMAX_DATA_DIR_ENV,
	MINIMAX_LEGACY_DATA_DIR_ENV,
	minimaxRoot,
} from "../src/minimax-home.ts";
import type { RawSettingsInput } from "../src/settings.ts";

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

/** One file at an absolute path, with the directories it needs. */
function writeFileAt(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/**
 * The six variables that can put a *tree* outside the fixture's own home.
 *
 * `detectSources` asks every source's root function (`sourceRoot`,
 * migrate.ts:174-181) and five of them read an environment variable first, so a
 * developer with any of these set would have the outcome of a detection test
 * decided by their own machine. MiniMax's two are the pair whose rule this file
 * exists to pin; the other four are cleared so that they cannot answer for it.
 */
const TREE_ENV = [
	MINIMAX_DATA_DIR_ENV,
	MINIMAX_LEGACY_DATA_DIR_ENV,
	"KIMI_CODE_HOME",
	"CODEX_HOME",
	"DSH_HOME",
	"GROK_HOME",
];

/**
 * A home with a MiniMax tree in it. The root exists whether or not the fixture
 * puts anything in it — an installed tree that has not written a file yet is
 * still an installed tree — and every variable in {@link TREE_ENV} is cleared
 * for the duration so the fixture is the only thing a reader can find.
 */
function minimaxHome(tree: Record<string, string> = {}): { home: string; root: string } {
	const home = makeDir("lbb-mm-home-");
	for (const name of TREE_ENV) setEnv(name, undefined);
	const root = join(home, MINIMAX_DATA_DIR_BASENAME);
	mkdirSync(root, { recursive: true });
	writeTree(root, tree);
	return { home, root };
}

function plan(home: string, existing: RawSettingsInput = {}, force = false): MigrationPlan {
	return planMigration(readSources(home), existing, { only: ["minimax-code"], force });
}

function itemsOf(planned: MigrationPlan): MigrationItem[] {
	return planned.items.filter((item) => item.source === "minimax-code");
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

/** The permission lists the plan would write, or empty when it writes none. */
function permissionsWritten(planned: MigrationPlan): {
	allow?: string[];
	deny?: string[];
	additionalDirectories?: string[];
} {
	return (settingsWritten(planned).permissions ?? {}) as { allow?: string[]; deny?: string[] };
}

/** The provider entries the plan would register, in the order it would write them. */
function providersWritten(planned: MigrationPlan): Array<Record<string, unknown>> {
	const providers = settingsWritten(planned).providers as
		| { openaiCompatible?: Array<Record<string, unknown>> }
		| undefined;
	return providers?.openaiCompatible ?? [];
}

/** A `{"mcpServers": {…}}` document — the wrapper both this build and MiniMax use. */
function servers(entries: Record<string, unknown>): string {
	return JSON.stringify({ mcpServers: entries }, null, "\t");
}

/**
 * A `custom_provider.<key>` table as `config.yaml` spells one: `env` and
 * `options` and `models` are siblings under the key. `options.baseURL` is what
 * makes the provider importable at all, and `models` is the table a default
 * model's reference is checked against.
 */
function providerYaml(key: string, parts: { env?: string[]; options?: string[]; models?: string[] } = {}): string[] {
	const out = ["custom_provider:", `  ${key}:`];
	if (parts.env !== undefined) out.push("    env:", ...parts.env.map((name) => `      - ${name}`));
	out.push(
		"    options:",
		...(parts.options ?? ['baseURL: "https://gw.example.invalid/v1"']).map((line) => `      ${line}`),
	);
	out.push("    models:", ...(parts.models ?? ["m1: {}"]).map((line) => `      ${line}`));
	return out;
}

describe("the eighth source", () => {
	test("it is appended, so the seven before it keep their places", () => {
		// The list is append-only (`MIGRATION_SOURCE_IDS`, migrate.ts:116-130), and
		// its order is what `detectSources` reports — reordering silently changes
		// which of two sources providing the same file wins. So the claim is the
		// position and the seven names above it, not "this is the last one".
		expect(MIGRATION_SOURCE_IDS.indexOf("minimax-code")).toBe(7);
		expect(MIGRATION_SOURCE_IDS.slice(0, 7)).toEqual([
			"claude-code",
			"codex",
			"zcode",
			"agents",
			"deepseek-harness",
			"grok-build",
			"kimi-code",
		]);
		expect(MIGRATION_SOURCE_LABELS["minimax-code"]).toBe("MiniMax Code");
	});

	test("--from minimax-code is accepted, and a misspelling still names the whole list", () => {
		const home = makeDir("lbb-mm-root-");
		expect(parseFromOption("minimax-code", home)).toEqual(["minimax-code"]);
		const bad = parseFromOption("minimax", home);
		expect(bad).toHaveProperty("error");
		const message = (bad as { error: string }).error;
		// The message is the whole list plus "all" (`parseFromOption`,
		// migrate.ts:10953-10966): a user who typed a prefix is told the eight
		// spellings that would have worked, not just that theirs did not.
		for (const id of MIGRATION_SOURCE_IDS) expect(message).toContain(id);
		expect(message).toContain("all");
	});

	test("detection wants content in the tree, not the directory", () => {
		const { home } = minimaxHome();
		// Empty: the question it would ask has one answer (`sourceHasContent`,
		// migrate.ts:192-198), and an installed-but-unwritten tree has nothing to
		// import, so offering it costs a read and a keystroke for nothing.
		expect(detectSources(home)).not.toContain("minimax-code");
		writeTree(join(home, MINIMAX_DATA_DIR_BASENAME), { "config.yaml": 'defaultModel: "claude-opus-5"\n' });
		expect(detectSources(home)).toContain("minimax-code");
	});

	test("a moved tree is found wherever the variables put it, and blank is unset", () => {
		// `minimaxRoot` (minimax-home.ts:113-119) reproduces three rules of the
		// vendor's own resolution (`getExplicitPublicDataDirEnv`, config.ts:1316-1319):
		// the value is trimmed, an all-whitespace value names nothing, and the newer
		// variable wins. The trim is why "  " falls through to the second rule, and
		// it is the half that is the opposite of `$KIMI_CODE_HOME`, which takes `"  "`
		// for a directory name.
		const { home } = minimaxHome({ "config.yaml": 'defaultModel: "claude-opus-5"\n' });
		const moved = join(home, "elsewhere");
		writeTree(moved, { "config.yaml": 'defaultModel: "claude-opus-5"\n' });
		const legacy = join(home, "mavis-tree");
		writeTree(legacy, { "config.yaml": 'defaultModel: "claude-opus-5"\n' });

		setEnv(MINIMAX_DATA_DIR_ENV, undefined);
		setEnv(MINIMAX_LEGACY_DATA_DIR_ENV, legacy);
		expect(minimaxRoot(home)).toEqual({ root: legacy, origin: "legacy-data-dir" });
		expect(detectSources(home)).toContain("minimax-code");

		// The older name is read second and decides only when the newer one is unset.
		setEnv(MINIMAX_DATA_DIR_ENV, moved);
		expect(minimaxRoot(home)).toEqual({ root: moved, origin: "data-dir" });

		// A blank value is "unset", so the next rule decides — the value does not
		// name a directory called "   ".
		setEnv(MINIMAX_DATA_DIR_ENV, "   ");
		expect(minimaxRoot(home)).toEqual({ root: legacy, origin: "legacy-data-dir" });

		// And the surviving value is the *trimmed* one, which is what makes a
		// padded export name the tree it looks like it names.
		setEnv(MINIMAX_DATA_DIR_ENV, `  ${moved}  `);
		expect(minimaxRoot(home)).toEqual({ root: moved, origin: "data-dir" });
		expect(detectSources(home)).toContain("minimax-code");
	});
});

describe("config.yaml → defaultModel", () => {
	test("a reference into a provider being imported is rewritten to the id it lands under", () => {
		// MiniMax spells a reference `providerID/modelID` and a user-created
		// provider's id is the qualified form `custom_provider:<key>`
		// (`parseSourceQualifiedModelKey`, model-key.ts:44-55). The id this build
		// registers is `minimax-<key>`, so a reference that kept the source's
		// spelling would name a provider that does not exist here —
		// `planMinimaxCode`, migrate.ts:9717-9735.
		const { home } = minimaxHome({
			"config.yaml": `${['defaultModel: "custom_provider:mygw/m1"', ...providerYaml("mygw")].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe("minimax-mygw/m1");
		const item = itemTo(planned, "settings.json → model");
		expect(item?.action).toBe("map");
		expect(item?.detail).toContain('mapped to "minimax-mygw/m1"');
		expect(item?.from).toContain('"custom_provider:mygw/m1"');
		// The provider it names is registered in the same run, so the rewritten
		// reference resolves to something: this is the half that makes the rewrite
		// an answer rather than a different way of pointing at nothing.
		expect(providersWritten(planned).map((provider) => provider.id)).toEqual(["minimax-mygw"]);
	});

	test("a model the custom provider does not list is refused", () => {
		const { home } = minimaxHome({
			"config.yaml": `${['defaultModel: "custom_provider:mygw/nope"', ...providerYaml("mygw")].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		const [detail] = detailsMatching(planned, /does not list/);
		expect(detail).toContain("mygw");
		expect(detail).toContain("would point at nothing here");
	});

	test("a provider that exists but was not imported is named, not guessed at", () => {
		// `enabled: false` keeps the provider out, and the model reference is then
		// refused for the reason that is actually true — the provider is there and
		// this run did not take it — rather than by the "not in the file" wording
		// that would send the user looking for a table they can see.
		const { home } = minimaxHome({
			"config.yaml": `${[
				'defaultModel: "custom_provider:offgw/m1"',
				"custom_provider:",
				"  offgw:",
				"    enabled: false",
				...providerYaml("offgw", {}).slice(2),
			].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /which this run did not import/)).toHaveLength(1);
	});

	test("a provider that is not in the file at all says so", () => {
		const { home } = minimaxHome({ "config.yaml": 'defaultModel: "custom_provider:ghost/m1"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		const [detail] = detailsMatching(planned, /which is not in config.yaml/);
		expect(detail).toContain('"ghost"');
		expect(detail).toContain("points at nothing");
	});

	test("the reserved minimax_api route is named rather than followed", () => {
		// MiniMax's own account route (`MINIMAX_API_PROVIDER_ID`): the key behind
		// it is the user's MiniMax key, and this build has no route of that kind.
		// The line says the value was not read, which is the promise the whole
		// source is built around.
		const { home } = minimaxHome({ "config.yaml": 'defaultModel: "minimax_api/MiniMax-M2"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		const [detail] = detailsMatching(planned, /reserved `minimax_api` route/);
		expect(detail).toContain("not read");
		expect(detail).toContain("export the key under its name");
	});

	test("provider.<name> is the installer's catalogue, and is reported as such", () => {
		// `provider.*` is seeded from a preset (`config.ts:1677-1706`) and works
		// through the account's route to MiniMax's service, so importing it would
		// register an endpoint the user never typed — `planMinimaxCode`'s
		// "installer-seeded" branch (migrate.ts:9803-9813).
		const { home } = minimaxHome({ "config.yaml": 'defaultModel: "provider.volcengine/doubao"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		const [detail] = detailsMatching(planned, /seeded by its installer/);
		expect(detail).toContain('"provider.volcengine"');
		expect(detail).toContain("account route");
	});

	test("a bare name that exists nowhere here is a skip with that reason", () => {
		const { home } = minimaxHome({ "config.yaml": 'defaultModel: "totally-made-up"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /no model of that name exists here/)).toHaveLength(1);
	});

	test("a provider with a trailing slash and no model after it is refused", () => {
		// MiniMax's own parser refuses the whole key there (`slash === raw.length - 1`,
		// model-key.ts:46-52), so no model was in force over there either. The
		// branch only fires for a provider this run *did* import, which is what the
		// fixture provides.
		const { home } = minimaxHome({
			"config.yaml": `${['defaultModel: "custom_provider:mygw/"', ...providerYaml("mygw")].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBeUndefined();
		expect(detailsMatching(planned, /no model after the slash/)).toHaveLength(1);
	});

	test("a bare name this build carries is mapped", () => {
		// With no provider in front of it, the name is a question about this
		// build's own registry (`resolveModelReference`, migrate.ts:3171-3182), and
		// the answer is the resolved id. Cross-checked against the resolver so the
		// fixture cannot be a name that stops resolving and takes the claim with it.
		expect(resolveModelReference("claude-opus-5")).toBe("claude-opus-5");
		const { home } = minimaxHome({ "config.yaml": 'defaultModel: "claude-opus-5"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).model).toBe("claude-opus-5");
		expect(itemTo(planned, "settings.json → model")?.detail).toBe('mapped to "claude-opus-5"');
	});

	test("a defaultModel that is not a string is not a model name", () => {
		for (const [value, label] of [
			["7", "7"],
			['""', '""'],
			['"   "', '"   "'],
		] as const) {
			const { home } = minimaxHome({ "config.yaml": `defaultModel: ${value}\n` });
			const planned = plan(home);
			expect(settingsWritten(planned).model).toBeUndefined();
			const [detail] = detailsMatching(planned, /^not a model reference$/);
			expect(detail).toBe("not a model reference");
			expect(
				fromsMatching(planned, new RegExp(`defaultModel \\(${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`)),
			).toHaveLength(1);
		}
	});
});

describe("config.yaml → custom_provider", () => {
	test("a provider switched off there is a skip, with that reason", () => {
		const { home } = minimaxHome({
			"config.yaml":
				["custom_provider:", "  parked:", "    enabled: false", ...providerYaml("parked", {}).slice(2)].join("\n") +
				"\n",
		});
		const planned = plan(home);
		expect(providersWritten(planned)).toHaveLength(0);
		expect(detailsMatching(planned, /disabled in MiniMax/)).toHaveLength(1);
	});

	test("a provider with no endpoint is not a provider entry", () => {
		const { home } = minimaxHome({
			"config.yaml": `${[...providerYaml("bare", { options: [] })].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(providersWritten(planned)).toHaveLength(0);
		const [detail] = detailsMatching(planned, /no endpoint in its options/);
		expect(detail).toContain("nothing here to point a provider at");
	});

	test("an endpoint that is not a usable URL is refused by this build's schema", () => {
		// The spec is written as an entry and then validated against
		// `OpenAICompatibleProviderSchema` before it is offered (migrate.ts:9550), so
		// a value MiniMax tolerated does not become a settings.json that fails to
		// load.
		const { home } = minimaxHome({
			"config.yaml": `${[...providerYaml("odd", { options: ['baseURL: "not a url"'] })].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(providersWritten(planned)).toHaveLength(0);
		expect(detailsMatching(planned, /not a usable URL for a provider entry/)).toHaveLength(1);
	});

	test("a collision with a provider already in settings.json is kept unless --force", () => {
		// The id is derived (`minimax-<key>`), so a collision is possible, and it
		// has to be decided *here*: a default model naming this provider is
		// rewritten to the derived id, and rewriting it to an id that was never
		// registered would leave settings.json pointing at whatever was already
		// there — a different endpoint answering under the same name.
		const { home } = minimaxHome({ "config.yaml": `${providerYaml("mygw").join("\n")}\n` });
		const existing: RawSettingsInput = {
			providers: {
				openaiCompatible: [
					{ id: "minimax-mygw", baseUrl: "https://mine.example.invalid/v1", apiKeyEnv: "MINE_KEY", models: [] },
				],
			},
		};
		const kept = plan(home, existing);
		expect(fromsMatching(kept, /custom_provider\.mygw/)).toHaveLength(1);
		const [detail] = detailsMatching(kept, /already defines a provider with the id this would take/);
		expect(detail).toContain("minimax-mygw");
		expect(detail).toContain("--force");
		// Only one agent claims the collision: `mergeProviderSpecs` (migrate.ts:10468)
		// would otherwise add a second line for the same id.
		expect(detailsMatching(kept, /already defines a provider with this id/)).toHaveLength(0);

		const forced = plan(home, existing, true);
		const [forcedDetail] = detailsMatching(forced, /it replaces the provider already registered as minimax-mygw/);
		expect(forcedDetail).toBeDefined();
		// Replaced, not appended: the target keeps one entry under that id.
		expect(providersWritten(forced).map((provider) => provider.id)).toEqual(["minimax-mygw"]);
		expect(providersWritten(forced)[0]?.baseUrl).toBe("https://gw.example.invalid/v1");
	});

	test("the api key variable is carried and no key value is read", () => {
		// `env[]` holds variable *names* (`planMinimaxProviders`, migrate.ts:9541-9547),
		// and this build reads the key from the environment at run time. The
		// sentinel is fake on purpose.
		//
		// What is pinned is that the key's *value* reaches nothing the migration
		// emits — not the settings it would write, not the MCP file, not one line of
		// the report. The reader's own return value is deliberately not the subject:
		// `RawMinimaxCode.config` is the parsed table, so it holds the file's own
		// contents, and asserting otherwise would be asserting that the reader
		// rewrites a config.yaml it never writes anything to. The value crossing a
		// variable is not the promise; carrying it into a settings.json is.
		const sentinel = "fake-not-a-key";
		const { home } = minimaxHome({
			"config.yaml": `${providerYaml("mygw", {
				env: ["GW_TOKEN"],
				options: ['baseURL: "https://gw.example.invalid/v1"', `apiKey: "${sentinel}"`],
			}).join("\n")}\n`,
		});
		const planned = plan(home);
		expect(providersWritten(planned)[0]?.apiKeyEnv).toBe("GW_TOKEN");
		const [detail] = detailsMatching(planned, /the key stored in its options was not read/);
		expect(detail).toContain("export it under the name below");
		expect(JSON.stringify(planned)).not.toContain(sentinel);
		expect(JSON.stringify(planned.writes)).not.toContain(sentinel);
		expect(
			itemsOf(planned)
				.map((item) => `${item.from}\n${item.to}\n${item.detail}`)
				.join("\n"),
		).not.toContain(sentinel);
		// A provider entry carries a variable name, so the item is not a secret.
		expect(
			itemTo(planned, "settings.json → providers.openaiCompatible[minimax-mygw] (1 model(s))")?.containsSecret,
		).toBe(false);
	});

	test("a provider that names no variable gets this build's derived one, spelled out", () => {
		// The fallback is this build's convention, so the report has to spell it:
		// a user who never set that variable would otherwise get a provider whose
		// requests fail with no line saying which name to export. The derivation
		// (`key.toUpperCase().replace(/[^A-Z0-9]/g, "_")`) is what makes a key with a
		// dash usable at all.
		const plain = minimaxHome({ "config.yaml": `${providerYaml("mygw").join("\n")}\n` });
		const plainPlan = plan(plain.home);
		expect(providersWritten(plainPlan)[0]?.apiKeyEnv).toBe("MYGW_API_KEY");
		expect(detailsMatching(plainPlan, /it names no api key variable, so this build reads \$MYGW_API_KEY/)).toHaveLength(
			1,
		);

		const dashed = minimaxHome({ "config.yaml": `${providerYaml("my-gw").join("\n")}\n` });
		const dashedPlan = plan(dashed.home);
		expect(providersWritten(dashedPlan)[0]?.id).toBe("minimax-my-gw");
		expect(providersWritten(dashedPlan)[0]?.apiKeyEnv).toBe("MY_GW_API_KEY");
	});

	test("several variables are narrowed to one, and the count is said", () => {
		const { home } = minimaxHome({
			"config.yaml": `${providerYaml("mygw", { env: ["GW_TOKEN", "GW_TOKEN_BACKUP"] }).join("\n")}\n`,
		});
		const planned = plan(home);
		expect(providersWritten(planned)[0]?.apiKeyEnv).toBe("GW_TOKEN");
		const [detail] = detailsMatching(planned, /it names 2 variables and this build reads one, \$GW_TOKEN/);
		expect(detail).toBeDefined();
	});

	test("a model list carries its limits, and its disabled entries are counted out", () => {
		const { home } = minimaxHome({
			"config.yaml": `${providerYaml("mygw", {
				models: ["m1:", "  limit:", "    context: 131072", "    output: 8192", "gone:", "  enabled: false"],
			}).join("\n")}\n`,
		});
		const planned = plan(home);
		expect(providersWritten(planned)[0]?.models).toEqual([{ id: "m1", contextWindow: 131072, maxOutputTokens: 8192 }]);
		expect(detailsMatching(planned, /1 model\(s\) it disables were left out \(gone\)/)).toHaveLength(1);
	});

	test("a model with no limits gets MiniMax's own BYOK fallback, not one of ours", () => {
		// `BYOK_FALLBACK_MODEL_LIMITS` (`local-runtime/src/runtime/model-resolver-byok.ts:27-30`)
		// is 200 000 context and 16 384 output — what MiniMax itself assumes for a
		// user-created provider — and the schema here requires an output limit, so
		// "assume nothing" is not an option the report can offer
		// (`minimaxModelEntries`, migrate.ts:9448-9476).
		const { home } = minimaxHome({ "config.yaml": `${providerYaml("mygw", { models: ["m1: {}"] }).join("\n")}\n` });
		expect(providersWritten(plan(home))[0]?.models).toEqual([
			{ id: "m1", contextWindow: 200_000, maxOutputTokens: 16_384 },
		]);
	});

	test("a model with a cost block is counted and priced nowhere", () => {
		// MiniMax's own runtime prices a call from the provider's usage payload
		// (`usage.cost.total`, usage/api.ts:250-252); the block a model may carry in
		// config.yaml prices nothing over there, so there is no scale to copy it at
		// and the fact has to be said rather than dropped.
		const { home } = minimaxHome({
			"config.yaml": `${providerYaml("mygw", {
				models: ["paid:", "  cost:", "    input: 1", "    output: 2"],
			}).join("\n")}\n`,
		});
		const planned = plan(home);
		const models = providersWritten(planned)[0]?.models as Array<Record<string, unknown>>;
		expect(models).toEqual([{ id: "paid", contextWindow: 200_000, maxOutputTokens: 16_384 }]);
		expect(models[0]?.pricing).toBeUndefined();
		const [detail] = detailsMatching(planned, /declare prices, which are not carried/);
		expect(detail).toContain("1 model(s)");
		expect(detail).toContain("usage payload");
	});

	test("a header table on the provider is named as something that did not come across", () => {
		// A header table is a real thing a user typed and it has no counterpart in an
		// OpenAI-compatible provider entry — which is information, while silence
		// would read as "you never set one".
		const { home } = minimaxHome({
			"config.yaml": `${providerYaml("mygw", {
				options: ['baseURL: "https://gw.example.invalid/v1"', "headers:", '  X-Gw-Route: "eu"'],
			}).join("\n")}\n`,
		});
		const [detail] = detailsMatching(plan(home), /its header table has no counterpart here/);
		expect(detail).toContain("needs it by another route");
	});
});

describe("config.yaml → permissionMode", () => {
	test("off is bypassPermissions, which is what MiniMax itself calls it", () => {
		// `modeToAskPolicy` sends both spellings to "always allow"
		// (`ask-policy.ts:22-36`) and the facade rewrites `off` into
		// `bypassPermissions` before its engine sees the mode (`facade.ts:563-566`),
		// so this is a second spelling rather than a third posture — and the report
		// says so, because a reader of the two files would not guess it.
		const { home } = minimaxHome({ "config.yaml": 'permissionMode: "off"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("bypassPermissions");
		const item = itemTo(planned, "settings.json → permissionMode");
		expect(item?.from).toContain('("off")');
		expect(item?.detail).toContain("which is what MiniMax itself calls it");
		expect(item?.detail).toContain("always allow");
	});

	test("acceptEdits travels, with MiniMax's two readers named", () => {
		// MiniMax's own readers disagree about this value: the runtime's reader
		// accepts it (`readLocalPermissionMode`, host-helpers.ts:543-554) and the
		// writer that persists the key lists it, while the reader the bundled
		// config goes through does not and falls back to `auto`
		// (`config.ts:2053-2059`). Its documented meaning there is this build's
		// mode of the same name, so the value is carried and the split is said.
		const { home } = minimaxHome({ "config.yaml": 'permissionMode: "acceptEdits"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBe("acceptEdits");
		const [detail] = detailsMatching(planned, /MiniMax's runtime reader accepts this value/);
		expect(detail).toContain('"auto"');
	});

	test("auto is left behind, and the line says why the nearest mode is the wrong one", () => {
		// `auto` is a classifier that approves what it judges safe; the nearest
		// mode here, `dontAsk`, means the opposite — anything not explicitly
		// allowed is denied — so carrying it under a different name would be a lie
		// about what the session will do (`MINIMAX_PERMISSION_MODES`' doc comment,
		// migrate.ts:9253-9289).
		const { home } = minimaxHome({ "config.yaml": 'permissionMode: "auto"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		const [detail] = detailsMatching(planned, /approves the calls it judges safe/);
		expect(detail).toContain("dontAsk");
		expect(detail).toContain("denied");
	});

	test("dontAsk is left behind, because no reader of this file accepts it", () => {
		// It is a live session mode in MiniMax, reached through `setMode`
		// (`plugin-hook-permission-state.ts:76-84,232`), and no reader of
		// *config.yaml* accepts it — the file's own reader validates against
		// `["default", "bypassPermissions", "auto", "off"]` (config.ts:2053-2059) —
		// so a config.yaml carrying it runs as `auto` over there.
		const { home } = minimaxHome({ "config.yaml": 'permissionMode: "dontAsk"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		const [detail] = detailsMatching(planned, /none of the readers that open this file accept it/);
		expect(detail).toContain('runs as "auto"');
	});

	test("a mode MiniMax never read decides nothing, and a blank one is not a mode", () => {
		const { home } = minimaxHome({ "config.yaml": 'permissionMode: "yolo"\n' });
		const planned = plan(home);
		expect(settingsWritten(planned).permissionMode).toBeUndefined();
		const [detail] = detailsMatching(planned, /not a mode MiniMax reads/);
		expect(detail).toContain("never decided a session");
		expect(fromsMatching(planned, /permissionMode \("yolo"\)/)).toHaveLength(1);

		// `planMinimaxPermissionMode` trims and treats the empty string as "the key
		// is not there" (migrate.ts:9299-9300): a value of spaces decided nothing
		// there either, so there is no line to write.
		const blank = minimaxHome({ "config.yaml": 'permissionMode: "   "\n' });
		const blankPlan = plan(blank.home);
		expect(settingsWritten(blankPlan).permissionMode).toBeUndefined();
		expect(fromsMatching(blankPlan, /permissionMode/)).toHaveLength(0);
	});
});

describe("config.yaml → the rest of the file", () => {
	test("toolResultCompaction.enabled false becomes trimOldToolResults false", () => {
		// `enabled: false` there means "go straight to the summary"; this build's
		// switch for the same decision is `trimOldToolResults: false`
		// (migrate.ts:9876-9900). Writing the opposite value would turn the user's
		// decision into its reverse.
		const { home } = minimaxHome({ "config.yaml": `${["toolResultCompaction:", "  enabled: false"].join("\n")}\n` });
		const planned = plan(home);
		expect(settingsWritten(planned).trimOldToolResults).toBe(false);
		const item = itemTo(planned, "settings.json → trimOldToolResults");
		expect(item?.from).toContain("toolResultCompaction.enabled (false)");
		expect(item?.detail).toContain("summarise rather than trim old tool results first");
	});

	test("a target that already sets the switch is kept unless --force", () => {
		// A second setting is in the fixture so that settings.json is written at
		// all: "kept" then means the write carries the target's own value, not the
		// imported one, which is the claim the wording makes.
		const { home } = minimaxHome({
			"config.yaml": `${['defaultModel: "claude-opus-5"', "toolResultCompaction:", "  enabled: false"].join("\n")}\n`,
		});
		const existing: RawSettingsInput = { trimOldToolResults: true };
		const kept = plan(home, existing);
		expect(settingsWritten(kept).trimOldToolResults).toBe(true);
		const [detail] = detailsMatching(kept, /target already sets trimOldToolResults to true/);
		expect(detail).toContain("--force");

		const forced = plan(home, existing, true);
		expect(settingsWritten(forced).trimOldToolResults).toBe(false);
	});

	test("the tuning keys are one line, not six", () => {
		const { home } = minimaxHome({
			"config.yaml": `${["toolResultCompaction:", "  enabled: true", "  watermarkKiB: 40", "  keepRecentRounds: 2"].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(detailsMatching(planned, /watermarks its own compaction works to/)).toHaveLength(1);
		const [from] = fromsMatching(planned, /toolResultCompaction \(/);
		expect(from).toContain("watermarkKiB");
		expect(from).toContain("keepRecentRounds");
		// `enabled: true` is the default on both sides, so nothing is claimed for it.
		expect(settingsWritten(planned).trimOldToolResults).toBeUndefined();
	});

	test("a section with no mapping carries its own reason, not the sweep's", () => {
		// `MINIMAX_UNMIGRATED_SECTIONS` (migrate.ts:9136-9227) is the whole
		// interface: every key MiniMax declares minus the ones planned above and the
		// computed paths below. The reasons are quoted here rather than imported
		// because the table is private — a section that fell out of it would still be
		// named, by the sweep's generic line, so only the reason tells the two apart.
		const { home } = minimaxHome({
			"config.yaml": `${["asr:", "  enabled: true", "browser:", "  headless: true"].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(detailsMatching(planned, /^cloud speech-to-text — there is no voice input here$/)).toHaveLength(1);
		expect(
			detailsMatching(planned, /^MiniMax's bundled browser automation — there is no browser tool here$/),
		).toHaveLength(1);
		expect(fromsMatching(planned, /→ asr$/)).toHaveLength(1);
		expect(detailsMatching(planned, /no mapping for and no note about/)).toHaveLength(0);
	});

	test("the keys MiniMax computes are answered together, because they are one answer", () => {
		// `MINIMAX_COMPUTED_PATHS` (migrate.ts:9229-9251) are the keys the vendor
		// overwrites with `join(dataDir, …)` on every read, so a value for one is
		// ignored there too. Eleven copies of "MiniMax recomputes this" would drown
		// the sections that carry a decision.
		const { home } = minimaxHome({
			"config.yaml": `${['dataDir: "/tmp/ignored"', 'logsDir: "/tmp/ignored-too"'].join("\n")}\n`,
		});
		const planned = plan(home);
		const matching = detailsMatching(planned, /paths MiniMax computes from its data directory/);
		expect(matching).toHaveLength(1);
		const [from] = fromsMatching(planned, /→ dataDir/);
		expect(from).toContain("logsDir");
		expect(matching[0]).toContain("~/.labunbun");
	});

	test("a key with no note reaches the report through the sweep", () => {
		// The sweep is what keeps a key MiniMax's own file is allowed to carry (its
		// reader keeps the raw parse, so the table may grow without this importer
		// knowing) from vanishing in silence — `reportUnhandledKeys`,
		// migrate.ts:4164-4185.
		const { home } = minimaxHome({ "config.yaml": `${['madeUpKey: "x"', "anotherOne: 1"].join("\n")}\n` });
		const planned = plan(home);
		expect(detailsMatching(planned, /2 key\(s\) this importer has no mapping for and no note about/)).toHaveLength(1);
		const [from] = fromsMatching(planned, /madeUpKey/);
		expect(from).toContain("anotherOne");
	});

	test("provider.* and minimax_api are named and not imported", () => {
		const { home } = minimaxHome({
			"config.yaml": `${[
				"provider:",
				"  volcengine:",
				'    baseURL: "https://ark.example.invalid/v1"',
				"minimax_api:",
				'  apiKey: "fake-not-a-key"',
			].join("\n")}\n`,
		});
		const planned = plan(home);
		expect(providersWritten(planned)).toHaveLength(0);
		const [seeded] = detailsMatching(planned, /MiniMax's own model routes, seeded by its installer/);
		expect(seeded).toContain("none of it is imported");
		expect(fromsMatching(planned, /→ provider \(volcengine\)/)).toHaveLength(1);
		const [own] = detailsMatching(planned, /your own MiniMax API key and an optional endpoint override/);
		expect(own).toContain("the key was not read");
		expect(JSON.stringify(planned)).not.toContain("fake-not-a-key");
	});

	test("a config.yaml that cannot be parsed says nothing in it was read", () => {
		// The wording is a fixed phrase rather than the parser's message, which can
		// quote the line it choked on — and that line is often `apiKey`
		// (`readMinimaxConfig`, migrate.ts:2788-2801). The second half matters as
		// much: the report has to say that what it is missing is the file's, not
		// that the file held nothing.
		const { home } = minimaxHome({ "config.yaml": "key: [unclosed\n" });
		const planned = plan(home);
		expect(settingsWritten(planned)).toEqual({});
		const [detail] = detailsMatching(planned, /config.yaml is not parseable as YAML/);
		expect(detail).toContain("nothing in this file was read");
		expect(detail).toContain("missing whatever it held");
	});

	test("a config.yaml that is not a table is its own refusal", () => {
		const { home } = minimaxHome({ "config.yaml": "just a bare scalar\n" });
		const planned = plan(home);
		expect(settingsWritten(planned)).toEqual({});
		expect(detailsMatching(planned, /holds something other than a table/)).toHaveLength(1);
		expect(detailsMatching(planned, /missing whatever it held/)).toHaveLength(1);
	});
});

describe("permission.json", () => {
	test("v1 is the shape with no version key, and it is read", () => {
		// `record.version === 2` picks the v2 decoder, `!== undefined` is the
		// refusal, and what is left is v1 (`rules.ts:243-267`) — so "v1" is the
		// absence of a version key rather than the presence of `1`. The caveat names
		// the generation, because the two grammars differ and the user should be
		// able to tell which file this run read.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({
				allow: ["bash(git status)", "read"],
				deny: ["bash(rm -rf /*)"],
			}),
		});
		const raw = readMinimaxCode(home);
		expect(raw.permissionError).toBeUndefined();
		expect(raw.permissions.version).toBe(1);

		const planned = plan(home);
		expect(permissionsWritten(planned).allow).toEqual(["Bash(git status)", "Read"]);
		expect(permissionsWritten(planned).deny).toEqual(["Bash(rm -rf /*)"]);
		const [detail] = detailsMatching(planned, /permission\.json v1:/);
		expect(detail).toContain("word-boundary prefix");
		expect(detail).toContain("matches the whole command line as a glob");
		expect(itemTo(planned, "settings.json → permissions.allow")?.action).toBe("map");
	});

	test("…and a file that spells version: 1 is refused, not read as v1", () => {
		// The pair is the point: a file *without* a version key is v1 and is read
		// (above), while a file that writes `version: 1` is refused. A later
		// refactor that treats `1` as "v1" would reverse a decision MiniMax itself
		// enforces — and it would do it for the one file shape a hand-edited config
		// gets wrong.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({ version: 1, allow: ["bash"] }),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).permissions).toBeUndefined();
		const [detail] = detailsMatching(planned, /declares version 1, which MiniMax itself refuses to read/);
		expect(detail).toContain("no rule was taken from it");
	});

	test("any other explicit version is refused the same way", () => {
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({ version: 3, allow: ["bash"] }),
		});
		const planned = plan(home);
		expect(settingsWritten(planned).permissions).toBeUndefined();
		expect(detailsMatching(planned, /declares version 3, which MiniMax itself refuses to read/)).toHaveLength(1);
	});

	test("a corrupt document, and a document that is not an object, are both refusals", () => {
		// Every way this file can be unusable is a refusal over there rather than a
		// partial read (`LocalPermissionStoreUnhealthyError`, rules.ts:214-262), and
		// its callers turn that into "ask about everything" rather than "allow
		// everything" — so importing the allows out of a store the user's own tool
		// is refusing to honour would put in force exactly what it is protecting
		// them from.
		const corrupt = minimaxHome({ "permission.json": "{oops" });
		const corruptPlan = plan(corrupt.home);
		expect(settingsWritten(corruptPlan).permissions).toBeUndefined();
		const [corruptDetail] = detailsMatching(corruptPlan, /holds a document that is not JSON/);
		expect(corruptDetail).toContain("it asks about every call instead");

		const list = minimaxHome({ "permission.json": JSON.stringify(["bash"]) });
		const listPlan = plan(list.home);
		expect(settingsWritten(listPlan).permissions).toBeUndefined();
		expect(detailsMatching(listPlan, /^does not hold an object, which MiniMax itself refuses to read/)).toHaveLength(1);
	});

	test("the tool names MiniMax writes become the names this engine knows", () => {
		// `MINIMAX_TOOL_NAMES` (migrate.ts:2508-2524): MiniMax's names are lower
		// case and this build's are not, and a rule naming a tool that does not
		// exist where it is read is a rule that silently does nothing. Two pairs
		// collapse — `edit` and `apply_patch` are both this build's `Edit` — and the
		// reader keeps both, because its list is the record of what the file said.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({ allow: ["bash", "read", "write", "edit", "apply_patch"] }),
		});
		expect(readMinimaxCode(home).permissions.allow).toEqual(["Bash", "Read", "Write", "Edit", "Edit"]);
		// What is written is a set (`addPermissionRules`, migrate.ts:3367-3369), and
		// one bare `Edit` covers both tools, so the collapsed pair is written once.
		expect(permissionsWritten(plan(home)).allow).toEqual(["Bash", "Read", "Write", "Edit"]);
	});

	test("fs is the umbrella name over the file tools, and expands to each of them", () => {
		// The doc comment on `MINIMAX_TOOL_NAMES` (migrate.ts:2505-2506): "`fs` is the
		// umbrella name MiniMax puts over the file tools, so it expands to every one
		// of them whose action the rule asks for" — and a rule with no pattern asks
		// for no particular action, so all three come across at once.
		const { home } = minimaxHome({ "permission.json": JSON.stringify({ allow: ["fs"] }) });
		expect(permissionsWritten(plan(home)).allow).toEqual(["Read", "Write", "Edit"]);
	});

	test("a rule with no pattern is a bare tool rule, not a rule with an empty one", () => {
		// Both engines read a name alone as "this tool, whatever it is asked to do"
		// (`decodeMinimaxRule`, migrate.ts:2610-2614), so `Bash` is written without a
		// specifier rather than as `Bash()` — which this build's parser would refuse.
		const { home } = minimaxHome({ "permission.json": JSON.stringify({ deny: ["bash"] }) });
		expect(permissionsWritten(plan(home)).deny).toEqual(["Bash"]);
	});

	test("the rules MiniMax would not consult either are named anyway", () => {
		// `decodeMinimaxRule` (migrate.ts:2556-2637) leaves two kinds behind and the
		// report separates them, because only one of them is a loss: a tool name
		// MiniMax has no tool for decides nothing there either
		// (`permissionToolMatches`, rule-match.ts:87-91, is an exact comparison),
		// while a pattern on a tool whose specifier this engine never reads —
		// `glob(/etc/**)` — is live over there and dead here.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({ allow: ["memory", "glob(/etc/**)"] }),
		});
		const planned = plan(home);
		expect(permissionsWritten(planned).allow).toBeUndefined();
		expect(
			detailsMatching(planned, /naming a tool MiniMax does not have, so they decide nothing there either/),
		).toHaveLength(1);
		const [grammar] = detailsMatching(planned, /whose pattern only MiniMax's own engine reads/);
		expect(grammar).toContain("a command, a file path and the MCP family");
		expect(grammar).toContain("sit in the file unread");
		// Each is reported under the source's spelling and its behavior, so the
		// user can find the line in their own file.
		expect(fromsMatching(planned, /permission\.json → memory \(allow\)/)).toHaveLength(1);
		expect(fromsMatching(planned, /permission\.json → glob\(\/etc\/\*\*\) \(allow\)/)).toHaveLength(1);
	});

	test("a :* command rule is rewritten to the glob both engines read", () => {
		// MiniMax reads `:*` as its own word-boundary command prefix
		// (`matchesCommandPrefix`, rule-match.ts:141-148); here a Bash specifier is a
		// glob over the whole command line, so `Bash(sed:*)` carried as written
		// would match the literal text and decide nothing — a dead allow *and* a
		// dead deny, which is the one outcome worse than one that means something
		// slightly different. The rewrite is recorded, not silent.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({ allow: ["bash(git status:*)"], deny: ["bash(sed:*)"] }),
		});
		const raw = readMinimaxCode(home);
		expect(raw.permissions.widened).toEqual(["Bash(git status:*)", "Bash(sed:*)"]);

		const planned = plan(home);
		expect(permissionsWritten(planned).allow).toEqual(["Bash(git status*)"]);
		expect(permissionsWritten(planned).deny).toEqual(["Bash(sed*)"]);
		const widened = itemsOf(planned).filter((item) => item.action === "downgrade");
		expect(widened).toHaveLength(1);
		expect(widened[0]?.to).toBe("settings.json → permissions");
		expect(widened[0]?.detail).toContain('2 command rule(s) ended in ":*"');
		expect(widened[0]?.detail).toContain("would match the literal text `:*` here and decide nothing");
		expect(widened[0]?.detail).toContain("matches a longer first word (`sed*` covers `sedx`)");
		expect(widened[0]?.detail).toContain("a command that chains commands");
	});

	test("ask rules are counted, and are not turned into allows", () => {
		// This build's settings hold allow and deny only, and an ask rule turned
		// into an allow would decide what the user asked to be asked about
		// (`planMinimaxPermissions`, migrate.ts:9384-9393) — the one direction a
		// migration must not round.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({ allow: ["bash"], ask: ["write(/tmp/**)", "read"] }),
		});
		const planned = plan(home);
		expect(permissionsWritten(planned).allow).toEqual(["Bash"]);
		expect(detailsMatching(planned, /2 rule\(s\) that ask rather than decide/)).toHaveLength(1);
		const [detail] = detailsMatching(planned, /a rule turned into an allow/);
		expect(detail).toContain("what you asked to be asked about");
		expect(fromsMatching(planned, /permission\.json → ask$/)).toHaveLength(1);
		// `ask` is a list this build's settings do not have at all.
		expect(permissionsWritten(planned) as Record<string, unknown>).not.toHaveProperty("ask");
	});

	test("v2 entries decode the same three matcher kinds", () => {
		// `{tool_name, matcher}` is v2's shape (`rule-codec.ts`), and the matcher is
		// `tool`, `command` or `path`. A `tool` matcher is a bare tool rule, a
		// `command` matcher carries the pattern a bash specifier is made of, and a
		// `path` matcher carries the pattern plus the actions it is scoped to.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({
				version: 2,
				allow: [
					{ tool_name: "bash", matcher: { kind: "tool" } },
					{ tool_name: "bash", matcher: { kind: "command", pattern: "npm test" } },
					{ tool_name: "read", matcher: { kind: "path", pattern: "/srv/**", actions: ["read"] } },
					{ tool_name: "write", matcher: { kind: "path", pattern: "/srv/**", actions: ["write"] } },
				],
			}),
		});
		const planned = plan(home);
		expect(permissionsWritten(planned).allow).toEqual(["Bash", "Bash(npm test)", "Read(/srv/**)", "Write(/srv/**)"]);
		expect(detailsMatching(planned, /permission\.json v2:/)).toHaveLength(1);
	});

	test("a v2 deny entry is a deny, and never lands in the allow list", () => {
		// Which list an entry goes into is decided by the key it was written under,
		// and MiniMax reads all three keys through the same decoder
		// (`configV2ToRules`, `rule-codec.ts:140-150`). A deny that arrives as an
		// allow is the one direction this must not round: it would grant a permission
		// the user had refused.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({
				version: 2,
				allow: [{ tool_name: "bash", matcher: { kind: "tool" } }],
				deny: [
					{ tool_name: "bash", matcher: { kind: "command", pattern: "rm -rf" } },
					{ tool_name: "read", matcher: { kind: "path", pattern: "/etc/**", actions: ["read"] } },
				],
			}),
		});
		const planned = plan(home);
		expect(permissionsWritten(planned).allow).toEqual(["Bash"]);
		expect(permissionsWritten(planned).deny).toEqual(["Bash(rm -rf)", "Read(/etc/**)"]);
	});

	test("a path matcher whose actions exclude what the tool does is left behind", () => {
		// MiniMax would not consult it either: `structuredMatcherMatches`
		// (rule-match.ts:57-67) returns false when the matcher's `actions` do not
		// include the action the tool performs, so nothing is lost by leaving it —
		// which is why it is dropped without a line of its own.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({
				version: 2,
				allow: [
					{ tool_name: "read", matcher: { kind: "path", pattern: "/srv/**", actions: ["write"] } },
					{ tool_name: "read", matcher: { kind: "path", pattern: "/kept/**", actions: ["read"] } },
				],
			}),
		});
		expect(permissionsWritten(plan(home)).allow).toEqual(["Read(/kept/**)"]);
	});

	test("one malformed v2 entry refuses the whole store", () => {
		// Not skipped — refused, in MiniMax as well as here: `configV2ToRules`
		// throws and `rules.ts:243-262` turns it into an unhealthy store, so a
		// partial import would be importing decisions the source is not honouring.
		// The wordings are the ones the reader chose, one per way the entry can be
		// unusable.
		const refused: Array<{ what: string; entry: unknown; says: RegExp }> = [
			{
				what: "no tool_name",
				entry: { matcher: { kind: "tool" } },
				says: /holds an entry with no tool name/,
			},
			{ what: "no matcher", entry: { tool_name: "bash" }, says: /holds an entry with no matcher/ },
			{
				what: "unknown matcher kind",
				entry: { tool_name: "bash", matcher: { kind: "regex", pattern: "x" } },
				says: /holds an entry whose matcher kind is "regex", which MiniMax refuses/,
			},
			{
				what: "empty pattern",
				entry: { tool_name: "bash", matcher: { kind: "command", pattern: "   " } },
				says: /holds a matcher with no pattern/,
			},
			{
				what: "path matcher with no actions",
				entry: { tool_name: "read", matcher: { kind: "path", pattern: "/srv/**" } },
				says: /holds a path matcher with no actions/,
			},
			{
				what: "action MiniMax does not know",
				entry: { tool_name: "read", matcher: { kind: "path", pattern: "/srv/**", actions: ["sniff"] } },
				says: /holds a path matcher naming an action MiniMax does not know/,
			},
		];
		for (const { what, entry, says } of refused) {
			const { home } = minimaxHome({
				"permission.json": JSON.stringify({
					version: 2,
					allow: [{ tool_name: "bash", matcher: { kind: "tool" } }, entry],
				}),
			});
			const planned = plan(home);
			// The entry before the bad one is refused with it: the file goes whole.
			expect(settingsWritten(planned).permissions).toBeUndefined();
			const matching = detailsMatching(planned, says);
			expect(`${what}: ${matching.length}`).toBe(`${what}: 1`);
			expect(matching[0]).toContain("no rule was taken from it");
		}
	});

	test("a malformed ask entry refuses the store too, the way MiniMax reads it", () => {
		// The ask list is not exempt from the validation that decides whether the
		// file may be read at all.
		//
		// MiniMax runs all three lists through the same decoder — `configV2ToRules`
		// (rule-codec.ts:140-150) calls `storedRulesToRules` for `allow`, `deny` and
		// `ask` alike — and `readStoredMatcher` (`:244-267`) throws for an unknown
		// kind, a whitespace-only pattern and a path matcher with no actions, which
		// `rules.ts:236-248` turns into an unhealthy store. Callers answer an
		// unhealthy store by asking about every call (`rules.ts:213`), so over there
		// *nothing* in this file is in force.
		//
		// Counting an ask entry before validating it was a defect in this reader: the
		// `behavior === "ask"` branch used to sit after the tool-name and
		// matcher-presence checks and before the kind, pattern and actions checks, so
		// an ask entry malformed in one of those three ways was counted and the
		// file's allows were imported anyway. That is the one direction a permission
		// migration must not round — imported allows would come into force where the
		// source asks about everything — so the validation now runs first and the
		// file goes whole, as it does for the same entry under `allow` above.
		const malformed: Array<[string, unknown]> = [
			["unknown matcher kind", { tool_name: "read", matcher: { kind: "regex", pattern: "x" } }],
			["empty pattern", { tool_name: "read", matcher: { kind: "command", pattern: "   " } }],
			["path matcher with no actions", { tool_name: "read", matcher: { kind: "path", pattern: "/srv/**" } }],
		];
		const carried: string[] = [];
		for (const [what, entry] of malformed) {
			const { home } = minimaxHome({
				"permission.json": JSON.stringify({
					version: 2,
					allow: [{ tool_name: "bash", matcher: { kind: "tool" } }],
					ask: [entry],
				}),
			});
			if (settingsWritten(plan(home)).permissions !== undefined) carried.push(what);
		}
		// One assertion at the end, so the failure names every shape that was carried
		// through rather than stopping at the first: all three are one defect.
		expect(carried).toEqual([]);
		// And the validation did not become a refusal to count asks at all: a
		// well-formed v2 ask entry is still read as one — every matcher kind of it.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({
				version: 2,
				allow: [{ tool_name: "bash", matcher: { kind: "tool" } }],
				ask: [
					{ tool_name: "write", matcher: { kind: "tool" } },
					{ tool_name: "bash", matcher: { kind: "command", pattern: "rm -rf" } },
					{ tool_name: "read", matcher: { kind: "path", pattern: "/srv/**", actions: ["read"] } },
				],
			}),
		});
		const planned = plan(home);
		expect(permissionsWritten(planned).allow).toEqual(["Bash"]);
		expect(detailsMatching(planned, /3 rule\(s\) that ask rather than decide/)).toHaveLength(1);
	});
});

describe("mcp.json", () => {
	test("a stdio server carries its args and its env, and a command alone is stdio", () => {
		// The wrapper is the same `{"mcpServers": {…}}` this build's own file uses
		// (`normalizeMinimaxMcp`, migrate.ts:9626-9675), `stdio` means the same two
		// fields, and a `type` MiniMax leaves off is inferred from the command it
		// sees — the one inference the vendor makes too (`inferTransport`).
		const { home } = minimaxHome({
			"mcp.json": servers({
				local: { type: "stdio", command: "npx", args: ["-y", "some-server"], env: { LOG_LEVEL: "info" } },
				implicit: { command: "uvx", args: ["thing"] },
			}),
		});
		const planned = plan(home);
		const written = mcpWritten(planned);
		expect(written.local).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "some-server"],
			env: { LOG_LEVEL: "info" },
		});
		expect(written.implicit?.type).toBe("stdio");
		expect(written.implicit?.command).toBe("uvx");
		expect(itemTo(planned, ".mcp.json → mcpServers.local")?.detail).toBe("copied verbatim");
		expect(itemTo(planned, ".mcp.json → mcpServers.local")?.action).toBe("map");
	});

	test("a credential-shaped env name marks the item, and the line says so", () => {
		// `looksLikeSecretName` (migrate.ts:3150-3153) matches TOKEN/KEY/SECRET/
		// PASSWORD/CREDENTIAL as substrings, which is what decides the closing
		// notice about which written files hold secrets. An env table is copied
		// verbatim, so the flag is the only warning the user gets.
		const { home } = minimaxHome({
			"mcp.json": servers({ keyed: { type: "stdio", command: "npx", env: { SERVICE_API_KEY: "fake-not-a-key" } } }),
		});
		const planned = plan(home);
		const item = itemTo(planned, ".mcp.json → mcpServers.keyed");
		expect(item?.containsSecret).toBe(true);
		expect(item?.detail).toContain("copied verbatim, including credential headers");
		expect(planned.writes.find((write) => write.kind === "mcp")?.containsSecret).toBe(true);
	});

	test("http and streamable-http both become http, and headers survive", () => {
		// `streamable-http` is what this build calls `http`, and a header table on a
		// remote server has a counterpart here — so the transport is renamed and
		// nothing is said about it, while the `sse` case below is a real downgrade.
		const { home } = minimaxHome({
			"mcp.json": servers({
				plain: { type: "http", url: "https://example.invalid/mcp" },
				streamed: {
					type: "streamable-http",
					url: "https://example.invalid/mcp",
					headers: { "X-Api-Key": "fake-not-a-key" },
				},
			}),
		});
		const planned = plan(home);
		expect(mcpWritten(planned).plain).toEqual({ type: "http", url: "https://example.invalid/mcp" });
		expect(mcpWritten(planned).streamed).toEqual({
			type: "http",
			url: "https://example.invalid/mcp",
			headers: { "X-Api-Key": "fake-not-a-key" },
		});
		expect(itemTo(planned, ".mcp.json → mcpServers.streamed")?.containsSecret).toBe(true);
	});

	test("an auth block is a downgrade: the credentials were neither read nor carried", () => {
		// A server that authenticates by having a stored credential was authorised
		// over there and has to be authorised here again; the block is never opened.
		const { home } = minimaxHome({
			"mcp.json": servers({
				gated: { type: "http", url: "https://example.invalid/mcp", auth: { token: "fake-not-a-key" } },
			}),
		});
		const planned = plan(home);
		const item = itemTo(planned, ".mcp.json → mcpServers.gated");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("authenticates with credentials that are neither read nor carried");
		expect(item?.detail).toContain("authorise it again here");
		expect(mcpWritten(planned).gated).toEqual({ type: "http", url: "https://example.invalid/mcp" });
		expect(JSON.stringify(planned)).not.toContain("fake-not-a-key");
	});

	test("an SSE server is a downgrade naming the transports this client speaks", () => {
		const { home } = minimaxHome({
			"mcp.json": servers({ legacy: { type: "sse", url: "https://example.invalid/sse" } }),
		});
		const planned = plan(home);
		expect(mcpWritten(planned).legacy.url).toBe("https://example.invalid/sse");
		const [detail] = detailsMatching(planned, /it is an SSE server/);
		expect(detail).toContain("stdio or StreamableHTTP only");
	});

	test("MiniMax's own bookkeeping for a server is named, key by key", () => {
		// `timeout`, `description`, `metadata` and `tools` are the vendor's own
		// fields for a server, and a `tools` list that narrows what a server may
		// expose is a real decision this build cannot make — so the server is
		// carried and the settings are named rather than quietly gone.
		const { home } = minimaxHome({
			"mcp.json": servers({
				big: {
					type: "stdio",
					command: "npx",
					timeout: 30,
					description: "a server",
					metadata: { team: "x" },
					tools: ["only-this"],
				},
			}),
		});
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /no counterpart here/);
		for (const key of ["timeout", "description", "metadata", "tools"]) expect(detail).toContain(key);
		// Named, not dropped: the server itself still crosses.
		expect(mcpWritten(planned).big.command).toBe("npx");
	});

	test("cwd on stdio and env on a remote server are named as fields MiniMax does not read", () => {
		// `LocalMcpServerConfig` (contracts.ts:76-91) has no `cwd` at all, and the
		// transport input for a remote server has no `env` — so carrying either
		// would import a value the source itself ignores.
		const { home } = minimaxHome({
			"mcp.json": servers({
				withCwd: { type: "stdio", command: "npx", cwd: "/tmp/work" },
				remoteEnv: { type: "http", url: "https://example.invalid/mcp", env: { A: "b" } },
			}),
		});
		const planned = plan(home);
		expect(mcpWritten(planned).withCwd?.cwd).toBeUndefined();
		expect(mcpWritten(planned).remoteEnv?.env).toBeUndefined();
		expect(detailsMatching(planned, /`cwd` is not a field MiniMax reads either, so it was not carried/)).toHaveLength(
			1,
		);
		expect(detailsMatching(planned, /an env table on a remote server is not read by MiniMax either/)).toHaveLength(1);
	});

	test("enabled, builtin and configured are three skips with three reasons", () => {
		// `enabled: false` has no counterpart here — this build has no way to keep a
		// server defined and switched off. `builtin: true` is one of MiniMax's own
		// bundled servers, whose command is a path inside its installation.
		// `configured: false` is read the same way by MiniMax
		// (`isUserConfiguredServer`, settings-config.ts:33-35): its own settings API
		// refuses to hand such an entry back, so it is not one of the user's servers.
		const { home } = minimaxHome({
			"mcp.json": servers({
				parked: { type: "stdio", command: "npx", enabled: false },
				shipped: { type: "stdio", command: "npx", builtin: true },
				unset: { type: "stdio", command: "npx", configured: false },
			}),
		});
		const planned = plan(home);
		expect(Object.keys(mcpWritten(planned))).toEqual([]);
		const reasons = itemsOf(planned)
			.filter((item) => item.to === "—" && item.from.includes("→ "))
			.map((item) => item.detail);
		const ours = reasons.filter((detail) => /disabled in MiniMax|ships with itself|not configured by you/.test(detail));
		expect(ours).toHaveLength(3);
		expect(new Set(ours).size).toBe(3);
		expect(ours.some((detail) => detail.includes("no way to keep a server defined and switched off here"))).toBe(true);
		expect(ours.some((detail) => detail.includes("runs MiniMax's own bundled program"))).toBe(true);
		expect(ours.some((detail) => detail.includes("its own settings refuse to read it back"))).toBe(true);
	});

	test("a server the target already defines is kept unless --force", () => {
		const { home } = minimaxHome({
			"mcp.json": servers({ shared: { type: "stdio", command: "npx", args: ["theirs"] } }),
		});
		writeFileAt(join(home, ".labunbun", ".mcp.json"), servers({ shared: { type: "stdio", command: "mine" } }));
		const kept = plan(home);
		const [detail] = detailsMatching(kept, /target already defines a server with this name/);
		expect(detail).toContain("--force");
		// Nothing was added, so no MCP file is written at all: "kept" means the
		// target's own file stands untouched rather than being rewritten without it.
		expect(kept.writes.some((write) => write.kind === "mcp")).toBe(false);

		const forced = plan(home, {}, true);
		expect(mcpWritten(forced).shared.command).toBe("npx");
	});

	test("an entry that is not an object is not a server definition", () => {
		const { home } = minimaxHome({ "mcp.json": servers({ odd: "npx -y somewhere" }) });
		expect(detailsMatching(plan(home), /^entry is not a server definition$/)).toHaveLength(1);
	});

	test("a server with neither a command nor a url is not a server", () => {
		// `normalizeMinimaxMcp` returns null when the chosen shape has no content:
		// a `stdio` entry with an empty command, or a remote one with no url, is not
		// something this build can connect to, and saying so is the difference
		// between a reported loss and a missing server.
		const { home } = minimaxHome({
			"mcp.json": servers({ empty: { type: "stdio", command: "   " }, urlLess: { type: "http", url: "" } }),
		});
		expect(detailsMatching(plan(home), /does not match the supported stdio\/http shapes/)).toHaveLength(2);
	});

	test("a corrupt mcp.json says no server in it was read", () => {
		const { home } = minimaxHome({ "mcp.json": "{nope" });
		const planned = plan(home);
		expect(planned.writes.some((write) => write.kind === "mcp")).toBe(false);
		const [detail] = detailsMatching(planned, /mcp\.json is not parseable as JSON — no server in it was read/);
		expect(detail).toBeDefined();
		expect(fromsMatching(planned, /^~\/\.minimax\/mcp\.json$/)).toHaveLength(1);
	});

	test("secrets are marked on the MCP side only", () => {
		// The flag exists for the closing notice about which written files hold
		// credentials, so it must not be raised for the files that hold none: rules,
		// memory and skills travel as text, and only the MCP file can carry a token.
		const { home } = minimaxHome({
			"permission.json": JSON.stringify({ allow: ["bash"] }),
			"AGENTS.md": "# house rules\n",
			"skills/demo/SKILL.md": "---\nname: demo\n---\n\n# demo\n",
			"mcp.json": servers({ keyed: { type: "stdio", command: "npx", env: { SERVICE_API_KEY: "fake-not-a-key" } } }),
		});
		const planned = plan(home);
		const kinds = (secret: boolean): string[] =>
			planned.writes
				.filter((write) => write.containsSecret === secret)
				.map((write) => write.kind)
				.sort();
		expect(kinds(true)).toEqual(["mcp"]);
		expect(kinds(false)).toContain("settings");
		expect(kinds(false)).toContain("rule");
		expect(kinds(false)).toContain("skill");
		// The same on the item side, where the rule line is the one a reader would
		// look at.
		expect(itemTo(planned, "settings.json → permissions.allow")?.containsSecret).toBe(false);
	});
});

describe("mcp/mcp.json, the second place MiniMax looks", () => {
	test("the alias is the document that was read when mcp.json is absent", () => {
		// `readMinimaxMcp` (migrate.ts:2836-2873) reads both files whatever the
		// first one holds, and says why: a name in the older file that the current
		// one does not define is a server the user wrote and would never see again
		// if the reader stopped at the first path.
		const { home } = minimaxHome({ "mcp/mcp.json": servers({ aliased: { type: "stdio", command: "npx" } }) });
		const raw = readMinimaxCode(home);
		expect(raw.mcpErrors).toEqual([]);
		expect(Object.keys(raw.mcp)).toEqual([]);
		expect(Object.keys(raw.mcpAlias)).toEqual(["aliased"]);
	});

	test("…and the servers in it are imported, named where they were read", () => {
		// A source whose only MCP file is the alias must not come out server-less,
		// and its line must say `mcp/mcp.json` rather than the primary path.
		const { home } = minimaxHome({ "mcp/mcp.json": servers({ aliased: { type: "stdio", command: "npx" } }) });
		const planned = plan(home);
		expect(mcpWritten(planned).aliased).toBeDefined();
		expect(itemTo(planned, ".mcp.json → mcpServers.aliased")?.from).toContain("mcp/mcp.json");
		// And the reason the older file answered, with what MiniMax itself does with
		// it: its runtime connects servers out of `mcp.json` only, and reads this
		// file to keep the names resolvable for skills.
		const [detail] = detailsMatching(planned, /the older spelling of the same document/);
		expect(detail).toContain("the only place these servers are written down");
		expect(detail).toContain("connects servers out of `mcp.json` only");
		expect(detail).toContain("imported here anyway");
	});

	test("when both files exist and the older one has servers of its own, they are named and left", () => {
		// The current file answers, and the older one is not a second source of
		// connections: MiniMax's runtime reads `mcp.json` alone
		// (`local-mcp.service.ts:1027`) and takes the older file only into the set
		// of names that keep skill references resolvable (`config-file.ts:6-11`), so
		// a server defined there and nowhere else is running in neither tool.
		// Importing it silently would hand the user a working server the source
		// never had — it is named instead, with the names that differ.
		const { home } = minimaxHome({
			"mcp.json": servers({ primary: { type: "stdio", command: "npx" }, shared: { type: "stdio", command: "npx" } }),
			"mcp/mcp.json": servers({
				aliased: { type: "stdio", command: "npx" },
				shared: { type: "stdio", command: "npx" },
			}),
		});
		const raw = readMinimaxCode(home);
		expect(Object.keys(raw.mcp)).toEqual(["primary", "shared"]);
		expect(Object.keys(raw.mcpAlias)).toEqual(["aliased", "shared"]);
		const planned = plan(home);
		expect(Object.keys(mcpWritten(planned)).sort()).toEqual(["primary", "shared"]);
		expect(itemTo(planned, ".mcp.json → mcpServers.primary")?.from).toContain("~/.minimax/mcp.json →");
		const [detail] = detailsMatching(planned, /no longer connects/);
		expect(detail).toContain("aliased is defined there and nowhere in `mcp.json`");
		expect(detail).toContain("shared came across from `mcp.json`");
		expect(fromsMatching(planned, /^~\/\.minimax\/mcp\/mcp\.json$/)).toHaveLength(1);
	});

	test("a corrupt alias is reported at the alias path", () => {
		// The reader prefixes each error with the file that produced it, and the
		// planner reads that prefix to name the right path (migrate.ts:10517-10531):
		// a report that sent the user to `mcp.json` would name a file this run never
		// opened.
		const { home } = minimaxHome({ "mcp/mcp.json": "{nope" });
		const planned = plan(home);
		const [detail] = detailsMatching(planned, /mcp\/mcp\.json is not parseable as JSON — no server in it was read/);
		expect(detail).toBeDefined();
		expect(fromsMatching(planned, /^~\/\.minimax\/mcp\/mcp\.json$/)).toHaveLength(1);
	});

	test("a corrupt mcp.json does not silence the older file", () => {
		// Two files can fail in one run and both are named; the servers of the file
		// that did parse are still read, because the file that answered is the one
		// with servers in it.
		const { home } = minimaxHome({
			"mcp.json": "{nope",
			"mcp/mcp.json": servers({ aliased: { type: "stdio", command: "npx" } }),
		});
		const planned = plan(home);
		expect(detailsMatching(planned, /mcp\.json is not parseable as JSON — no server in it was read/)).toHaveLength(1);
		// Where that line points, and not only that there is one: `/mcp\.json …/`
		// matches the alias path too, so a reader that swapped the two file names in
		// its error strings would leave this count at one while sending the user to a
		// file the run never opened.
		expect(fromsMatching(planned, /^~\/\.minimax\/mcp\.json$/)).toHaveLength(1);
		expect(mcpWritten(planned).aliased).toBeDefined();
	});
});
