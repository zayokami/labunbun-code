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
import { detectSources, runMigration } from "../src/migrate.ts";

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
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		if (dshEnv === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = dshEnv;
		writeTree(home, tree);
		body(home);
	} finally {
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
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		process.env.DSH_HOME = dshEnv ?? root;
		writeTree(home, homeTree);
		writeTree(root, rootTree);
		body({ home, root });
	} finally {
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
 * A harness `settings.yaml` with the sections the importer reads: the default
 * model, two providers, and a permission preset that is the one shape with an
 * equivalent here.
 */
const DSH_SETTINGS = [
	"agent-default-model:",
	// `deepseek-official` is the route the harness's own composition mounts; the
	// document names it rather than declaring an endpoint for it.
	"  provider: deepseek-official",
	"  model: deepseek-v4-pro",
	"  reasoningEffort: high",
	"llm-pi-ai:",
	"  providers:",
	"    gateway:",
	"      apiKeyEnv: GATEWAY_API_KEY",
	"      api: openai-completions",
	"      baseURL: https://gateway.example/v1",
	"      models:",
	"        - id: gateway-chat",
	"          contextWindow: 131072",
	"          maxTokens: 4096",
	"llm-deepseek:",
	"  apiKeyEnv: DEEPSEEK_API_KEY",
	"  baseURL: https://api.deepseek.com/v1",
	"  protocol: chat-completions",
	"  models:",
	"    - id: deepseek-v4-pro",
	"      contextWindow: 1000000",
	"      maxTokens: 384000",
	"",
].join("\n");

/** A settings.yaml whose default model no labunbun table entry answers to. */
const UNRESOLVABLE_SETTINGS = [
	"agent-default-model:",
	"  provider: deepseek-official",
	"  model: deepseek-v5-ultra",
	"",
].join("\n");

/** labunbun's table entry for `deepseek-v4-pro`, which the drift fixture overrides. */
const TABLE_CONTEXT_WINDOW = 1_000_000;
const DRIFT_CONTEXT_WINDOW = 262_144;

/** The DeepSeek catalog declaring a model the table knows with numbers it does not. */
const DRIFT_SETTINGS = [
	"llm-deepseek:",
	"  apiKeyEnv: DEEPSEEK_API_KEY",
	"  baseURL: https://api.deepseek.com/v1",
	"  protocol: chat-completions",
	"  models:",
	"    - id: deepseek-v4-pro",
	`      contextWindow: ${DRIFT_CONTEXT_WINDOW}`,
	"      maxTokens: 384000",
	"",
].join("\n");

/** The preset table the harness ships, name → the bundle that name stands for. */
const SHIPPED_PRESETS: Record<string, { sandbox: string; approval: string }> = {
	"danger-full-access": { sandbox: "danger-full-access", approval: "never" },
	"workspace-write": { sandbox: "workspace-write", approval: "ask" },
};

/**
 * The preset section of a settings document.
 *
 * One namespace, spelled the way the harness spells it: `permission`
 * (`PERMISSION_SETTINGS_NAMESPACE`, `packages/interaction/permission-presets/
 * src/index.ts:89`). A fixture that also wrote the section under some other name
 * would prove nothing about this one — it would only show that *a* key was read.
 *
 * `presets` is the table from the harness's own `Config`, which a deployment may
 * replace. Omitting it entirely is the shipped table applying, which is how the
 * shipped preset names keep their meaning; passing an empty table writes a
 * document that names no table at all, and a deployment is free to make a name
 * mean something else there.
 */
function permissionSettings(
	defaultPreset: string,
	presets: Record<string, { sandbox: string; approval: string }> = SHIPPED_PRESETS,
): string {
	const lines = ["permission:", `  defaultPreset: ${defaultPreset}`];
	if (Object.keys(presets).length > 0) {
		lines.push("  presets:");
		for (const [name, spec] of Object.entries(presets)) {
			lines.push(`    ${name}:`, `      sandbox: ${spec.sandbox}`, `      approval: ${spec.approval}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

/** A full harness home: memory, both skill shapes, settings, and the named leftovers. */
const FULL_TREE: SourceTree = {
	".dsh/AGENTS.md": AGENTS_MD,
	".dsh/settings.yaml": DSH_SETTINGS,
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

	// 2.
	test("the harness home is found at ~/.dsh and at $DSH_HOME", () => {
		withHome({ ".dsh/settings.yaml": DSH_SETTINGS }, (home) => {
			expect(detectSources(home)).toContain("deepseek-harness");
		});
		withMovedRoot({}, { "settings.yaml": DSH_SETTINGS, "AGENTS.md": AGENTS_MD }, ({ home }) => {
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
				{ ".dsh/settings.yaml": DSH_SETTINGS },
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
			{ "settings.yaml": DSH_SETTINGS },
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
		withHome({ ".dsh/settings.yaml": DSH_SETTINGS }, (home) => {
			const result = runMigration({ home });
			const model = settingsJson(result).model;
			expect(typeof model).toBe("string");
			expect(model as string).toContain("deepseek-v4-pro");
			// The point of resolving: what is written is a model this build loads.
			expect(resolveModel(model as string)).toBeDefined();
		});
	});

	test("an unresolvable default model is a skip naming provider and model", () => {
		withHome({ ".dsh/settings.yaml": UNRESOLVABLE_SETTINGS }, (home) => {
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
		withHome({ ".dsh/settings.yaml": DSH_SETTINGS }, (home) => {
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
		// `danger-full-access` + `never` is the one preset that means the same
		// thing here; the presets that name a sandbox are skipped, because a
		// sandbox mode and a permission mode are not the same setting.
		withHome({ ".dsh/settings.yaml": permissionSettings("danger-full-access") }, (home) => {
			const result = runMigration({ home });
			expect(settingsJson(result).permissionMode).toBe("bypassPermissions");
			expect(settingsText(result)).not.toContain("acceptEdits");
		});

		withHome({ ".dsh/settings.yaml": permissionSettings("workspace-write") }, (home) => {
			const result = runMigration({ home });
			// The sandbox word is the signal: only the permission preset carries one.
			const skip = result.plan.items.find((i) => i.action === "skip" && /sandbox/i.test(i.detail));
			expect(skip?.source).toBe("deepseek-harness");
			expect(skip?.detail).toMatch(/sandbox/i);
			expect(skip?.detail).toMatch(/permission[\s-]?mode/i);
			// Nothing "close enough" was written instead.
			expect(settingsJson(result).permissionMode).toBeUndefined();
			expect(settingsText(result)).not.toContain("acceptEdits");
		});
	});

	// 8b.
	test("a preset is read as the bundle it names, not as its name", () => {
		// The same meaning under a name this build has never heard of: a preset
		// table is the deployment's to write, so `defaultPreset` is a key, and the
		// entry behind it is what the user actually gets.
		withHome(
			{
				".dsh/settings.yaml": permissionSettings("trusted", {
					trusted: { sandbox: "danger-full-access", approval: "never" },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				expect(settingsJson(result).permissionMode).toBe("bypassPermissions");
			},
		);

		// And the dangerous direction: the shipped *name* carrying a bundle that
		// confines. Reading the name alone would tell the user they are never asked
		// for approval while their configuration confines writes and does ask.
		withHome(
			{
				".dsh/settings.yaml": permissionSettings("danger-full-access", {
					"danger-full-access": { sandbox: "read-only", approval: "ask" },
				}),
			},
			(home) => {
				const result = runMigration({ home });
				expect(settingsJson(result).permissionMode).toBeUndefined();
				expect(settingsText(result)).not.toContain("bypassPermissions");
				const skip = result.plan.items.find((i) => i.action === "skip" && /sandbox/i.test(i.detail));
				expect(skip?.source).toBe("deepseek-harness");
			},
		);
	});

	// 8c.
	test("a document that states no preset table keeps the shipped names' meaning", () => {
		// A settings document with no table means the harness applies the one it
		// ships, where `danger-full-access` is the whole-access, never-ask bundle.
		// That is the whole reason the name can be trusted here — and only here.
		withHome({ ".dsh/settings.yaml": permissionSettings("danger-full-access", {}) }, (home) => {
			const result = runMigration({ home });
			expect(settingsJson(result).permissionMode).toBe("bypassPermissions");
		});
	});

	// 9.
	test("a model whose context window differs from the table is reported, never written", () => {
		withHome({ ".dsh/settings.yaml": DRIFT_SETTINGS }, (home) => {
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
