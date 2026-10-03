/**
 * The `deepseek-harness` migration source.
 *
 * A DeepSeek Harness home — `$DSH_HOME` when it is set and not blank, `~/.dsh`
 * otherwise — holds `AGENTS.md`, `skills/`, `settings.yaml` and the Cordis
 * compositions that declare MCP servers. Two invariants get their own tests
 * here, because they are what makes the importer safe to run:
 *
 * - `.credentials.yaml` and `.env` are never opened. The proof is a sentinel
 *   value written into both: it must not appear anywhere in the plan or the
 *   report, and the assertion's failure message names what leaked it.
 * - Nothing is written without `apply: true`.
 *
 * Fixtures use fake values only — no fixture here holds anything shaped like a
 * real credential, and the sentinel is deliberately not key-shaped.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "@labunbun/ai";
import { readDshSettingsRows } from "../src/dsh-cordis.ts";
import { DSH_SHIPPED_PRESETS } from "../src/dsh-plan.ts";
import { detectSources, runMigration } from "../src/migrate.ts";
import { borrowSourceEnv } from "./source-env.ts";

type Result = ReturnType<typeof runMigration>;

/** Files a source tree should contain, keyed by path relative to a root. */
type SourceTree = Record<string, string>;

function writeTree(base: string, tree: SourceTree): void {
	for (const [path, content] of Object.entries(tree)) {
		const full = join(base, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

/**
 * Run `body` against a throwaway home seeded with `tree`.
 *
 * `dshEnv` decides what `$DSH_HOME` says for the duration: left out it is
 * unset, so the harness home is `~/.dsh`; a string is that value verbatim,
 * blanks included.
 */
function withHome(tree: SourceTree, body: (home: string) => void, dshEnv?: string): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-dsh-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	const prevDsh = process.env.DSH_HOME;
	// `$DSH_HOME` is this source's own variable and is set below; every other
	// source's relocation variable is borrowed by the shared helper, because this
	// file asserts about a home that holds nothing else.
	const releaseSourceEnv = borrowSourceEnv();
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		if (dshEnv === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = dshEnv;
		writeTree(home, tree);
		body(home);
	} finally {
		releaseSourceEnv();
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		if (prevDsh === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevDsh;
		rmSync(home, { recursive: true, force: true });
	}
}

/**
 * Run `body` with `$DSH_HOME` pointing at a root outside the fake home — the
 * shape a relocated harness home has, with no `.dsh` under the home at all.
 *
 * `dshEnv` overrides what the variable says, which is how the blank case is
 * expressed: a populated root that a blank `$DSH_HOME` must not find.
 */
function withMovedRoot(
	homeTree: SourceTree,
	rootTree: SourceTree,
	body: (context: { home: string; root: string }) => void,
	dshEnv?: string,
): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-migrate-dsh-home-"));
	const root = mkdtempSync(join(tmpdir(), "lbb-migrate-dsh-root-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	const prevDsh = process.env.DSH_HOME;
	const releaseSourceEnv = borrowSourceEnv();
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		process.env.DSH_HOME = dshEnv ?? root;
		writeTree(home, homeTree);
		writeTree(root, rootTree);
		body({ home, root });
	} finally {
		releaseSourceEnv();
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		if (prevDsh === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevDsh;
		rmSync(home, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
}

/** Everything under `dir`, one line per entry, for an unchanged-after compare. */
function snapshot(dir: string): string[] {
	const lines: string[] = [];
	const walk = (current: string): void => {
		const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				lines.push(`${full}/`);
				walk(full);
			} else {
				const stat = statSync(full);
				lines.push(`${full}\t${stat.size}\t${stat.mtimeMs}`);
			}
		}
	};
	walk(dir);
	return lines;
}

/** The settings write, or an empty document when the plan writes none. */
function settingsText(result: Result): string {
	return result.plan.writes.find((w) => w.path.endsWith("settings.json"))?.content ?? "{}";
}

function settingsJson(result: Result): Record<string, unknown> {
	return JSON.parse(settingsText(result)) as Record<string, unknown>;
}

/**
 * The report line that writes `key` into the target settings.
 *
 * Both halves of a mode pair are claimed from one source line, so a search by
 * `from` can only ever reach the first of them. The target key is what tells
 * `permissionMode: ask` apart from the `sandbox` it was chosen with — which is
 * exactly the half a mode-only assertion cannot see.
 */
function itemWriting(result: Result, key: string): Result["plan"]["items"][number] | undefined {
	return result.plan.items.find((i) => i.to === `settings.json → ${key}`);
}

/**
 * Where `needle` shows up in a finished run, as a sentence; empty when it does
 * not. The credential test asserts this is empty, so a failure names the field
 * that carried the secret instead of only reporting that something did.
 */
function findLeak(result: Result, needle: string): string {
	const where: string[] = [];
	if (result.report.includes(needle)) where.push("the printed report");
	for (const [index, item] of result.plan.items.entries()) {
		for (const field of ["from", "to", "detail"] as const) {
			if (item[field].includes(needle)) {
				where.push(`items[${index}] (${item.source}) ${field}: ${item[field]}`);
			}
		}
	}
	for (const write of result.plan.writes) {
		if (write.content.includes(needle)) where.push(`the content written to ${write.path}`);
	}
	// The catch-all: anything the checks above do not have a name for.
	if (JSON.stringify(result.plan).includes(needle)) where.push("the serialized plan, in a field listed above");
	return where.join("; ");
}

/**
 * A number as it may be printed, with thousands separators allowed: `1_000_000`
 * and `1,000,000` are the same number to a reader, and the assertion is about
 * the number, not about the formatting.
 */
function numberPattern(value: number): RegExp {
	return new RegExp(String(value).split("").join("[,._]?"));
}

const AGENTS_MD = "Harness memory content.\n\nPrefer the smallest diff that works.\n";

const SKILL_MD = [
	"---",
	"name: release-notes",
	"description: Write the release notes",
	"---",
	"",
	"Summarize the merged pull requests.",
	"",
].join("\n");

const FLAT_SKILL_MD = [
	"---",
	"name: changelog",
	"description: Draft a changelog entry",
	"---",
	"",
	"Group the commits by kind.",
	"",
].join("\n");

/**
 * A harness composition carrying the rows the importer reads: the default model,
 * two providers, and a permission preset that is the one shape with an equivalent
 * here.
 *
 * **This is a Cordis patch layer, and it is the only settings shape the product
 * has.** The fixtures used to be a `settings.yaml` mapping, which stopped being
 * one: `settings/settings/src/index.ts:238` names it "the removed
 * `settings.yaml`" and keeps it only to rename it to `.imported` on a one-shot
 * upgrade import. A test written against the old document kept passing while the
 * importer read nothing at all, which is the failure the rewrite exists to stop.
 *
 * The row shape is the shipped one — `- insert:` holding `- id:` entries, each
 * with a `config` block — so a typo in a row id fails here rather than in a home.
 */
const DSH_SETTINGS = [
	"- insert:",
	"    - id: agent-default-model",
	"      name: '@deepseek-ai/dsh-agent-default-model'",
	"      config:",
	// `deepseek-official` is the route the harness's own composition mounts; the
	// row names it rather than declaring an endpoint for it.
	"        provider: deepseek-official",
	"        model: deepseek-v4-pro",
	"        reasoningEffort: high",
	"",
	"    - id: llm-pi-ai",
	"      name: '@deepseek-ai/dsh-llm-pi-ai'",
	"      config:",
	"        providers:",
	"          gateway:",
	"            apiKeyEnv: GATEWAY_API_KEY",
	"            api: openai-completions",
	"            baseURL: https://gateway.example/v1",
	"            models:",
	"              - id: gateway-chat",
	"                contextWindow: 131072",
	"                maxTokens: 4096",
	"",
	"    - id: llm-deepseek",
	"      name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
	"      config:",
	"        apiKeyEnv: DEEPSEEK_API_KEY",
	"        baseURL: https://api.deepseek.com/v1",
	"        protocol: chat-completions",
	"        models:",
	"          - id: deepseek-v4-pro",
	"            contextWindow: 1000000",
	"            maxTokens: 384000",
	"",
].join("\n");

/** A composition whose default model no labunbun table entry answers to. */
const UNRESOLVABLE_SETTINGS = [
	"- insert:",
	"    - id: agent-default-model",
	"      name: '@deepseek-ai/dsh-agent-default-model'",
	"      config:",
	"        provider: deepseek-official",
	"        model: deepseek-v5-ultra",
	"",
].join("\n");

/** labunbun's table entry for `deepseek-v4-pro`, which the drift fixture overrides. */
const TABLE_CONTEXT_WINDOW = 1_000_000;
const DRIFT_CONTEXT_WINDOW = 262_144;

/** A composition row declaring a model the table knows with numbers it does not. */
const DRIFT_SETTINGS = [
	"- insert:",
	"    - id: llm-deepseek",
	"      name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
	"      config:",
	"        apiKeyEnv: DEEPSEEK_API_KEY",
	"        baseURL: https://api.deepseek.com/v1",
	"        protocol: chat-completions",
	"        models:",
	"          - id: deepseek-v4-pro",
	`            contextWindow: ${DRIFT_CONTEXT_WINDOW}`,
	"            maxTokens: 384000",
	"",
].join("\n");

/**
 * What every shipped DeepSeek Harness preset means here, written by hand rather
 * than read back out of the mapper — the harness's own claim, per row.
 *
 * A table that read `DSH_SHIPPED_PRESETS` back into itself would pass for any
 * mapping at all, including a wrong one, so these are the claims and the mapper's
 * own table is only checked against them. The approval column is the *source*
 * spelling, which is not the target's: the target has three modes and the harness
 * has two policies, so no row below has its approval half survive as itself.
 */
const DSH_SHIPPED_PRESET_CLAIMS: Array<[preset: string, mode: string, sandbox: string, approval: string]> = [
	// `PermissionPresetService.Config`'s `presets` default
	// (`packages/interaction/permission-presets/src/index.ts`): the harness's whole
	// shipped table, and each name is spelled like its own sandbox half.
	["danger-full-access", "agent", "danger-full-access", "never"],
	["workspace-write", "ask", "workspace-write", "ask"],
];

/**
 * The preset section of a settings document.
 *
 * One namespace, spelled the way the harness spells it: `permission`
 * (`PERMISSION_SETTINGS_NAMESPACE`, `packages/interaction/permission-presets/
 * src/index.ts:89`). A fixture that also wrote the section under some other name
 * would prove nothing about this one — it would only show that *a* key was read.
 *
 * `presets` is the table from the harness's own `Config`, which a deployment may
 * replace; the default is the table the harness ships, restated in the document.
 * Omitting it entirely (`{}`) is the shipped table applying, which is how the
 * shipped preset names keep their meaning; passing an empty table writes a
 * document that names no table at all, and a deployment is free to make a name
 * mean something else there.
 */
function permissionSettings(
	defaultPreset: string,
	presets: Record<string, { sandbox: string; approval: string }> = DSH_SHIPPED_PRESETS,
): string {
	const lines = [
		"- insert:",
		"    - id: permission",
		"      name: '@deepseek-ai/dsh-permission-presets'",
		"      config:",
		`        defaultPreset: ${defaultPreset}`,
	];
	if (Object.keys(presets).length > 0) {
		lines.push("        presets:");
		for (const [name, spec] of Object.entries(presets)) {
			lines.push(
				`          ${name}:`,
				`            sandbox: ${spec.sandbox}`,
				`            approval: ${spec.approval}`,
			);
		}
	}
	lines.push("");
	return lines.join("\n");
}

/** A full harness home: memory, both skill shapes, settings, and the named leftovers. */
const FULL_TREE: SourceTree = {
	".dsh/AGENTS.md": AGENTS_MD,
	".dsh/cordis.patch.yml": DSH_SETTINGS,
	".dsh/skills/release-notes/SKILL.md": SKILL_MD,
	".dsh/skills/changelog.md": FLAT_SKILL_MD,
	".dsh/.agent-presets/reviewer.md": "---\nname: reviewer\n---\n\nReview the diff.\n",
	".dsh/attachments/v1/objects/aa/blob.bin": "binary-ish",
	".dsh/storages/session-cache.json": "{}",
};

describe("migrate: DeepSeek Harness source", () => {
	// 1.
	test("a home with no harness directory is not a source", () => {
		withHome({}, (home) => {
			expect(detectSources(home)).toEqual([]);
			const result = runMigration({ home });
			expect(result.plan.items.filter((i) => i.source === "deepseek-harness")).toEqual([]);
		});
	});

	test("a harness directory holding nothing is not a source", () => {
		withHome({ ".claude/settings.json": "{}" }, (home) => {
			// `~/.dsh` is created by other tooling — `~/.agents` and `~/.claude`
			// alike — and an empty one has nothing to import.
			mkdirSync(join(home, ".dsh"), { recursive: true });
			expect(detectSources(home)).toEqual(["claude-code"]);
		});
	});

	/**
	 * The retired settings filenames carry nothing, even when a file is there.
	 *
	 * **This test exists because a mutation proved the suite could not see the
	 * repair.** Pointing the reader back at `settings.yaml` — the file
	 * `settings/settings/src/index.ts:238` calls "the removed `settings.yaml`" —
	 * left every test green. That is the whole failure this source had: it read a
	 * document the product does not use, found nothing, and reported a clean
	 * import. A regression test that only exercises the new happy path cannot see
	 * it coming back, so this one writes a *complete, valid, old-shaped* settings
	 * document and asserts that nothing in it is carried across.
	 *
	 * `settings.yml` and `settings.json` are in the same assertion and for a
	 * stronger reason: **neither name has ever existed** in the shipped tree —
	 * zero occurrences repo-wide — so a reader listing them was listing two
	 * inventions. A file under either name today is a user's own, not the
	 * harness's, and reading it would be the importer inventing configuration.
	 */
	test("the retired settings filenames carry nothing even when a document is there", () => {
		const legacy = ["agent-default-model:", "  provider: deepseek-official", "  model: deepseek-v4-pro", ""].join("\n");
		withHome(
			{
				".dsh/settings.yaml": legacy,
				".dsh/settings.yml": legacy,
				".dsh/settings.json": JSON.stringify({ "agent-default-model": { model: "deepseek-v4-pro" } }),
			},
			(home) => {
				const rows = readDshSettingsRows(join(home, ".dsh")).rows;
				// No row came from any of the three. `{}` is the answer both for
				// "the file is not there" and for "the file is not one of ours",
				// and the report says nothing either way.
				expect(Object.keys(rows)).toEqual([]);

				// And the run is silent about them rather than importing a model the
				// user never had configured in this build.
				const result = runMigration({ home });
				expect(settingsJson(result)).toEqual({});
				expect(result.plan.items.filter((i) => i.detail.includes("deepseek-v4-pro"))).toEqual([]);
			},
		);
	});

	/**
	 * A row in two layers resolves the way the harness resolves it: **last write
	 * wins**, because a patch replaces the targeted row's whole `config` rather
	 * than merging into it (`packages/bundle/base/cordis.patch.yml`, header
	 * comment: "the last write winning per row").
	 *
	 * **This test exists because a mutation proved nothing covered it.** Flipping
	 * the fold to first-write-wins left the suite green — a settings importer that
	 * kept the *bundle's* default instead of the user's own override would have
	 * shipped without a single red test, which is the one failure mode worth a
	 * test that no other test would catch.
	 *
	 * The two layers are ordered the way the reader walks them: the home-level
	 * patch first, then each profile's own. So the profile row here is the
	 * override, and it must win.
	 */
	test("a profile layer overrides the home-level row for the same id", () => {
		const override = [
			"- insert:",
			"    - id: agent-default-model",
			"      name: '@deepseek-ai/dsh-agent-default-model'",
			"      config:",
			"        provider: deepseek-official",
			"        model: deepseek-v4-pro",
			"        reasoningEffort: low",
			"",
		].join("\n");
		withHome(
			{
				// The home layer sets `reasoningEffort: high`, the profile layer
				// overrides the same row with `low`. Both declare the same `id`.
				".dsh/cordis.patch.yml": DSH_SETTINGS,
				".dsh/profiles/default/cordis.patch.yml": override,
			},
			(home) => {
				expect(readDshSettingsRows(join(home, ".dsh")).rows["agent-default-model"]?.reasoningEffort).toBe("low");
			},
		);
	});

	// 2.
	test("the harness home is found at ~/.dsh and at $DSH_HOME", () => {
		withHome({ ".dsh/cordis.patch.yml": DSH_SETTINGS }, (home) => {
			expect(detectSources(home)).toContain("deepseek-harness");
		});
		withMovedRoot({}, { "cordis.patch.yml": DSH_SETTINGS, "AGENTS.md": AGENTS_MD }, ({ home }) => {
			// The home has no `.dsh` at all: everything comes from the moved root,
			// for detection, for reading, and for the report's own labels.
			expect(detectSources(home)).toContain("deepseek-harness");
			const result = runMigration({ home });
			const item = result.plan.items.find((i) => i.from.includes("AGENTS.md"));
			expect(item?.source).toBe("deepseek-harness");
			expect(result.plan.writes.some((w) => w.content === AGENTS_MD)).toBe(true);
			// settings.yaml was read from the moved root too, not just AGENTS.md.
			const providers = (settingsJson(result).providers ?? {}) as {
				openaiCompatible?: Array<{ apiKeyEnv?: string }>;
			};
			expect((providers.openaiCompatible ?? []).some((p) => p.apiKeyEnv === "GATEWAY_API_KEY")).toBe(true);
		});
	});

	test("a blank $DSH_HOME means unset", () => {
		for (const blank of ["", "   ", "\t"]) {
			withHome(
				{ ".dsh/cordis.patch.yml": DSH_SETTINGS },
				(home) => {
					expect(detectSources(home)).toContain("deepseek-harness");
				},
				blank,
			);
		}
		// A blank variable does not relocate the root: the home below has no
		// `.dsh` at all, and the populated root it does not name is never found.
		withMovedRoot(
			{},
			{ "cordis.patch.yml": DSH_SETTINGS },
			({ home }) => {
				expect(detectSources(home)).toEqual([]);
			},
			"   ",
		);
	});

	// 3.
	test("credentials and .env are never opened, and never leak into the plan", () => {
		// Not key-shaped on purpose: a fixture that looked like a real credential
		// would be one, and the assertion is about the string never travelling.
		const sentinel = "dsh-fixture-sentinel-not-a-real-credential";
		withHome(
			{
				...FULL_TREE,
				".dsh/.credentials.yaml": ["credentials:", "  deepseek:", `    apiKey: ${sentinel}-from-credentials`, ""].join(
					"\n",
				),
				".dsh/.env": `DEEPSEEK_API_KEY=${sentinel}-from-env\n`,
			},
			(home) => {
				const credentialsPath = join(home, ".dsh", ".credentials.yaml");
				const envPath = join(home, ".dsh", ".env");
				const before = [statSync(credentialsPath).mtimeMs, statSync(envPath).mtimeMs];

				const result = runMigration({ home });

				// The run has to have planned something, or "nothing leaked" is the
				// vacuous truth of an empty plan.
				expect(result.plan.writes.length).toBeGreaterThan(0);
				expect(result.plan.items.length).toBeGreaterThan(0);
				expect(findLeak(result, sentinel)).toBe("");
				expect(result.report).not.toContain(sentinel);

				// The files are also still exactly as they were: the importer reads
				// sources, never writes them.
				const after = [statSync(credentialsPath).mtimeMs, statSync(envPath).mtimeMs];
				expect(after).toEqual(before);
			},
		);
	});

	// 4.
	test("AGENTS.md becomes a rule file", () => {
		withHome({ ".dsh/AGENTS.md": AGENTS_MD }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.kind === "rule");
			expect(write?.content).toBe(AGENTS_MD);
			// A rule rather than MEMORY.md: the imported document has to merge with
			// memory the user already curates instead of replacing it.
			expect(write?.path).toContain("rules");
			expect(write?.path.endsWith(".md")).toBe(true);

			const item = result.plan.items.find((i) => i.source === "deepseek-harness");
			expect(item?.action).toBe("map");
			expect(item?.from).toContain("AGENTS.md");
			expect(item?.to).toContain("rules");
		});
	});

	// 5.
	test("both skill shapes become one skill write each", () => {
		withHome(
			{
				".dsh/skills/release-notes/SKILL.md": SKILL_MD,
				".dsh/skills/changelog.md": FLAT_SKILL_MD,
			},
			(home) => {
				const result = runMigration({ home });
				const skills = result.plan.writes.filter((w) => w.kind === "skill");
				expect(skills.length).toBe(2);

				const directory = skills.find((w) => w.path.includes("release-notes"));
				expect(directory?.path.endsWith(join("skills", "release-notes", "SKILL.md"))).toBe(true);
				expect(directory?.content).toBe(SKILL_MD);

				// A flat `skills/<name>.md` is a skill too, with the same frontmatter
				// and body: it is written where the loader looks for one.
				const flat = skills.find((w) => w.content === FLAT_SKILL_MD);
				expect(flat?.path.endsWith(join("skills", "changelog", "SKILL.md"))).toBe(true);
				expect(flat?.content).toContain("---");
				expect(flat?.content).toContain("name: changelog");

				// Frontmatter survives: a skill without its description is not the
				// skill the source declared.
				expect(directory?.content).toContain("name: release-notes");
				expect(directory?.content).toContain("description: Write the release notes");

				const items = result.plan.items.filter((i) => i.source === "deepseek-harness");
				expect(items.filter((i) => i.action === "map").length).toBe(2);
				expect(items.some((i) => i.from.includes("changelog.md"))).toBe(true);
			},
		);
	});

	// 6.
	test("a resolvable default model becomes settings.model", () => {
		withHome({ ".dsh/cordis.patch.yml": DSH_SETTINGS }, (home) => {
			const result = runMigration({ home });
			const model = settingsJson(result).model;
			expect(typeof model).toBe("string");
			expect(model as string).toContain("deepseek-v4-pro");
			// The point of resolving: what is written is a model this build loads.
			expect(resolveModel(model as string)).toBeDefined();
		});
	});

	test("an unresolvable default model is a skip naming provider and model", () => {
		withHome({ ".dsh/cordis.patch.yml": UNRESOLVABLE_SETTINGS }, (home) => {
			const result = runMigration({ home });
			const item = result.plan.items.find((i) => i.action === "skip" && i.detail.includes("deepseek-v5-ultra"));
			expect(item?.source).toBe("deepseek-harness");
			expect(item?.detail).toContain("deepseek-v5-ultra");
			expect(item?.detail).toContain("deepseek-official");
			// Nothing was written as if it worked.
			expect(settingsJson(result).model).toBeUndefined();
		});
	});

	// 7.
	test("providers merge into settings.providers with apiKeyEnv carried as a name", () => {
		withHome({ ".dsh/cordis.patch.yml": DSH_SETTINGS }, (home) => {
			const result = runMigration({ home });
			const providers = (settingsJson(result).providers ?? {}) as {
				openaiCompatible?: Array<{ id?: string; baseUrl?: string; apiKeyEnv?: string }>;
			};
			const entries = providers.openaiCompatible ?? [];
			const names = entries.map((p) => p.apiKeyEnv);
			expect(names).toContain("GATEWAY_API_KEY");
			expect(names).toContain("DEEPSEEK_API_KEY");
			// The variable's *name* is what travels; its value lives in the
			// environment, which is the one place a key belongs.
			expect(entries.find((p) => p.apiKeyEnv === "GATEWAY_API_KEY")?.baseUrl).toBe("https://gateway.example/v1");

			// No credential-shaped value anywhere in the plan: the fixture holds
			// none, so any match would be the importer inventing one.
			const credentialLike = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,}|AKIA[0-9A-Z]{8,})/;
			expect(credentialLike.exec(JSON.stringify(result.plan))?.[0]).toBeUndefined();
		});
	});

	// 8.
	test("a permission preset is a different axis from a permission mode", () => {
		// A preset is a bundle — a sandbox plus an approval policy — and a bundle
		// lands as both keys. Reading the name as the mode would write
		// `permissionMode: "workspace-write"`, which is a sandbox value in a mode
		// slot, and skip the half that actually confines the process.
		withHome({ ".dsh/cordis.patch.yml": permissionSettings("workspace-write") }, (home) => {
			const result = runMigration({ home });
			const written = settingsJson(result);
			expect(written.permissionMode).toBe("ask");
			expect(written.sandbox).toBe("workspace-write");
			// The axis claim, on the row where the two spellings collide: the preset
			// name is the sandbox's, and it did not become the mode.
			expect(written.permissionMode).not.toBe("workspace-write");
		});
	});

	// 8b.
	test("a preset is read as the bundle it names, not as its name", () => {
		// The same meaning under a name this build has never heard of: a preset
		// table is the deployment's to write, so `defaultPreset` is a key, and the
		// entry behind it is what the user actually gets.
		withHome(
			{
				".dsh/cordis.patch.yml": permissionSettings("trusted", {
					trusted: { sandbox: "danger-full-access", approval: "never" },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				expect(settingsJson(result).permissionMode).toBe("agent");
				expect(settingsJson(result).sandbox).toBe("danger-full-access");
			},
		);

		// And the dangerous direction: the shipped *name* carrying a bundle that
		// confines. Reading the name alone would tell the user they are never asked
		// for approval while their configuration confines writes and does ask.
		withHome(
			{
				".dsh/cordis.patch.yml": permissionSettings("danger-full-access", {
					"danger-full-access": { sandbox: "read-only", approval: "ask" },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				expect(settingsJson(result).permissionMode).toBeUndefined();
				expect(settingsText(result)).not.toContain("agent");
				const skip = result.plan.items.find((i) => i.action === "skip" && /sandbox/i.test(i.detail));
				expect(skip?.source).toBe("deepseek-harness");
			},
		);
	});

	// 8c.
	test("the shipped table is the harness's own two rows, spelled as the harness spells them", () => {
		// `PermissionPresetService.Config`'s `presets` default is the whole of what
		// ships, and each name is spelled after its own sandbox half. A row added
		// here without a claim above — or a claim for a row the harness never ships
		// — fails on the extra key rather than quietly widening coverage.
		// Widened to plain strings on the received side only, so the comparison is
		// between two hand-written claims and not between a value and the literal
		// types that value is already declared to have. `toEqual` compares deeply at
		// run time, so the cast changes what the compiler checks and not what the
		// assertion sees.
		expect(DSH_SHIPPED_PRESETS as Record<string, { sandbox: string; approval: string }>).toEqual(
			Object.fromEntries(
				DSH_SHIPPED_PRESET_CLAIMS.map(([preset, , sandbox, approval]) => [preset, { sandbox, approval }]),
			),
		);
	});

	test.each(DSH_SHIPPED_PRESET_CLAIMS)(
		'a document stating the "%s" preset imports it as mode %s and sandbox %s',
		(preset, mode, sandbox, approval) => {
			withHome({ ".dsh/cordis.patch.yml": permissionSettings(preset) }, (home) => {
				const result = runMigration({ home });
				const written = settingsJson(result);
				// Both halves, on every row. A mode-only assertion passes for a mapper
				// that stopped claiming the sandbox, which is the silent narrowing the
				// pair exists to prevent.
				expect(written.permissionMode).toBe(mode);
				expect(written.sandbox).toBe(sandbox);

				const from = `cordis.patch.yml → permission.defaultPreset ("${preset}")`;
				const modeItem = itemWriting(result, "permissionMode");
				expect(modeItem?.action).toBe("map");
				expect(modeItem?.from).toBe(from);
				// The sentence names both halves of the bundle it read, so a report
				// line that outlived its mapping would show it.
				expect(modeItem?.detail).toContain(`bundles ${sandbox} with ${approval}`);
				expect(modeItem?.detail).toContain("imported as both keys");

				// The sandbox is claimed from the same source line, so only the target
				// key tells the two apart — and the sentence beside it has to agree
				// with the value, not merely exist.
				const sandboxItem = itemWriting(result, "sandbox");
				expect(sandboxItem?.action).toBe("map");
				expect(sandboxItem?.from).toBe(from);
				expect(sandboxItem?.detail).toContain(
					sandbox === "danger-full-access" ? "imported unrestricted" : "imported confined",
				);
			});
		},
	);

	// 8d.
	test.each([
		[
			"a sandbox this build has no value for",
			{ "danger-full-access": { sandbox: "read-only", approval: "never" } },
			"read-only",
			"never",
		],
		[
			"an approval policy this build has no mode for",
			{ "danger-full-access": { sandbox: "danger-full-access", approval: "unless-trusted" } },
			"danger-full-access",
			"unless-trusted",
		],
	])("half a pair is skipped rather than half-imported: %s", (_label, presets, sandbox, approval) => {
		// The first row is the reachable one: `read-only` is a real mode the harness
		// ships (`SANDBOX_MODES`) and this build has no name for. The second stands
		// for a policy a newer harness could add — the harness's own `APPROVAL_POLICIES`
		// is exactly `ask` and `never` today, so there is no shipped value for it yet.
		//
		// Importing the half that is known is the failure this guards, and it goes
		// loose in both directions: a `danger-full-access` sandbox on its own leaves
		// the process unrestricted while the report never says the approval half
		// could not be read, and an `agent` mode on its own takes the confined pairing
		// for the missing sandbox — a session that never asks, in a confinement the
		// document never asked for. Neither is a posture the source described.
		withHome(
			{
				".dsh/cordis.patch.yml": permissionSettings(
					"danger-full-access",
					presets as Record<string, { sandbox: string; approval: string }>,
				),
			},
			(home) => {
				const result = runMigration({ home });
				// Neither half. A lone `sandbox` would be a setting nobody chose.
				expect(settingsJson(result).permissionMode).toBeUndefined();
				expect(settingsJson(result).sandbox).toBeUndefined();
				expect(itemWriting(result, "permissionMode")).toBeUndefined();
				expect(itemWriting(result, "sandbox")).toBeUndefined();

				// The skip names the preset and both of the halves as the document
				// spelled them, so the refusal says what it could not read.
				const skip = result.plan.items.find(
					(i) => i.action === "skip" && i.from.includes('permission.defaultPreset ("danger-full-access")'),
				);
				expect(skip?.source).toBe("deepseek-harness");
				expect(skip?.to).toBe("—");
				expect(skip?.detail).toContain(`bundles ${sandbox} sandbox with ${approval} approval`);
				expect(skip?.detail).toContain("one of the two is not a value this build has");
			},
		);
	});

	// 8e.
	test.each(DSH_SHIPPED_PRESET_CLAIMS)(
		'a document that states no preset table keeps the shipped "%s" meaning',
		(preset, mode, sandbox) => {
			// A settings document with no table means the harness applies the one it
			// ships. That is the whole reason the name can be trusted here — and only
			// here: a document that states a table owns its own names, which is why
			// the table-driven row above reads the bundle and never the name.
			withHome({ ".dsh/cordis.patch.yml": permissionSettings(preset, {}) }, (home) => {
				const result = runMigration({ home });
				expect(settingsJson(result).permissionMode).toBe(mode);
				expect(settingsJson(result).sandbox).toBe(sandbox);
				const modeItem = itemWriting(result, "permissionMode");
				expect(modeItem?.detail).toContain("the shipped one is the one that applies");
			});
		},
	);

	// 8f.
	test.each([
		["no table stated", {}, "is not a name in the harness"],
		["a stated table that does not define it", DSH_SHIPPED_PRESETS, "does not define that name"],
	])("a preset name no table defines is skipped, and the report names it: %s", (_label, presets, phrase) => {
		// A name in neither the shipped table nor the one the document states, so
		// there is no bundle to read at all. Where a deployment's own table for a
		// name like this would live is its composition, not this document — which is
		// why the two cases exit the same way and each says which of the two
		// documents failed to define it.
		withHome(
			{
				".dsh/cordis.patch.yml": permissionSettings(
					"yolo",
					presets as Record<string, { sandbox: string; approval: string }>,
				),
			},
			(home) => {
				const result = runMigration({ home });
				expect(settingsJson(result).permissionMode).toBeUndefined();
				expect(settingsJson(result).sandbox).toBeUndefined();
				expect(itemWriting(result, "permissionMode")).toBeUndefined();
				expect(itemWriting(result, "sandbox")).toBeUndefined();

				const skip = result.plan.items.find(
					(i) => i.action === "skip" && i.from.includes('permission.defaultPreset ("yolo")'),
				);
				expect(skip?.source).toBe("deepseek-harness");
				expect(skip?.to).toBe("—");
				expect(skip?.detail).toContain(phrase as string);
			},
		);
	});

	// 9.
	test("a model whose context window differs from the table is reported, never written", () => {
		withHome({ ".dsh/cordis.patch.yml": DRIFT_SETTINGS }, (home) => {
			const result = runMigration({ home });
			// The drifted number is the signal: no other item has a reason to print it.
			const skip = result.plan.items.find(
				(i) =>
					i.action === "skip" &&
					numberPattern(DRIFT_CONTEXT_WINDOW).test(i.detail) &&
					i.detail.includes("deepseek-v4-pro"),
			);
			expect(skip?.source).toBe("deepseek-harness");
			// Both numbers, so the report says what the file claims and what this
			// build would enforce.
			expect(skip?.detail ?? "").toMatch(numberPattern(DRIFT_CONTEXT_WINDOW));
			expect(skip?.detail ?? "").toMatch(numberPattern(TABLE_CONTEXT_WINDOW));

			// The claim is dropped rather than carried: a window the provider does
			// not have would silently truncate, or overflow, every request.
			expect(settingsText(result)).not.toMatch(numberPattern(DRIFT_CONTEXT_WINDOW));
		});
	});

	// 10.
	test("without --apply nothing is written, and the sources are untouched", () => {
		withHome(FULL_TREE, (home) => {
			const before = snapshot(home);
			const result = runMigration({ home });
			// A dry run that planned nothing would make the comparison vacuous.
			expect(result.plan.writes.length).toBeGreaterThan(0);
			expect(result.applied).toBeUndefined();
			expect(snapshot(home)).toEqual(before);
		});
	});

	test("the named leftovers are skip items, not silent omissions", () => {
		withHome(FULL_TREE, (home) => {
			const result = runMigration({ home });
			for (const name of [".agent-presets", "attachments", "storages"]) {
				const skipped = result.plan.items.some(
					(i) => i.action === "skip" && (i.from.includes(name) || i.detail.includes(name)),
				);
				expect(skipped).toBe(true);
				expect(result.plan.writes.some((w) => w.path.includes(name))).toBe(false);
			}
		});
	});
});
