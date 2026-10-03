/**
 * A provider's **base URL** is the same credential channel an MCP server's `url`
 * is, under another name — and `urlCredentialProblem` was wired into every source
 * for the second spelling and into none of them for the first.
 *
 * **The shape of the hole.** Every importer here copies an MCP server's `url` into
 * `.mcp.json` and has since been taught to check it. A provider entry's endpoint
 * lands in `settings.json` instead, from a different field in a different file, and
 * it was copied with no check at all. The credential is in the same place either
 * way — inside the one string an importer treats as a safe identifier, where a
 * name-based scrub walking *keys* looks straight past it. Measured on this repo
 * before the fix: a `base_url` with userinfo and one with `?access_token=` both
 * reached `settings.json` under a report line reading `action: "map"` and
 * `containsSecret: false`. The importer asserting the opposite of the truth about
 * a live credential is the failure this repository treats as the expensive one.
 *
 * **Why the provider is skipped rather than cleaned.** A header or an environment
 * variable can be dropped whole and leave something that still works. A URL cannot:
 * `https://alice:pw@host/v1` with the password stripped is a different address
 * pointing at nothing. So nothing is written, and the report says which provider did
 * not come across and why — the user has to know, or they will look for a provider
 * that is not there.
 *
 * **Every row below names the test that goes red if its guard is deleted**, because
 * that class of bug was found three times in this repository in three shapes. The
 * assertions are in pairs on purpose: the provider must be *absent from the written
 * settings* (red when the guard goes) **and** there must be *a line saying why*
 * (red when someone skips silently, which is the same bug wearing a hat). A test
 * with only the second assertion passes against an importer that explains everything
 * and writes nothing.
 *
 * **The controls matter as much as the guards.** A guard that fires on every URL
 * leaves the user with no providers at all and nothing that looks like a bug, so
 * each source also has a row proving a clean endpoint still migrates — with a
 * credential-shaped *variable name* beside it, because `env_key` / `apiKeyEnv` /
 * `env[]` is only ever a name and its value is never read. `API_KEY` is the most
 * credential-looking string in these fixtures and must not trip anything.
 *
 * Nothing here is a real address or a real credential: every host is under
 * `.example` / `.invalid`, and every value is a fixed sentinel a leak assertion
 * searches the whole plan for.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type MigrationItem, type MigrationPlan, planMigration, readSources } from "../src/migrate.ts";
import type { RawSettingsInput } from "../src/settings.ts";
import { borrowSourceEnv, releaseEnv } from "./source-env.ts";

/** Directories a test made, swept when it ends. */
const made: string[] = [];
afterEach(() => {
	releaseEnv();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Files keyed by path relative to a base, written with their parents. */
function writeTree(base: string, tree: Record<string, string>): void {
	for (const [path, content] of Object.entries(tree)) {
		const full = join(base, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
}

/**
 * Plan one source against a throwaway home, and hand the plan to `body`.
 *
 * `$CODEX_HOME` and every other relocation variable is borrowed so a developer
 * machine's real tree cannot answer for the fixture (`source-env.ts` on why the
 * list is not optional).
 */
function withPlan(
	prefix: string,
	tree: Record<string, string>,
	only: string,
	body: (planned: MigrationPlan, home: string) => void,
	existing: RawSettingsInput = {},
): void {
	const home = mkdtempSync(join(tmpdir(), prefix));
	made.push(home);
	const prevProfile = process.env.USERPROFILE;
	const prevHome = process.env.HOME;
	const release = borrowSourceEnv();
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		writeTree(home, tree);
		body(planMigration(readSources(home, home), existing, { only: [only as never] }), home);
	} finally {
		release();
		if (prevProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevProfile;
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
	}
}

/** The `providers.openaiCompatible` entries a plan would write. */
function providersWritten(planned: MigrationPlan): Array<Record<string, unknown>> {
	const write = planned.writes.find((candidate) => candidate.kind === "settings");
	if (write === undefined) return [];
	const settings = JSON.parse(write.content) as { providers?: { openaiCompatible?: Array<Record<string, unknown>> } };
	return settings.providers?.openaiCompatible ?? [];
}

/** Every provider entry `planned` registers under this id, however many there are. */
function providerById(planned: MigrationPlan, id: string): Array<Record<string, unknown>> {
	return providersWritten(planned).filter((provider) => provider.id === id);
}

/**
 * The report lines about one `from` label.
 *
 * Several of these sources write two lines off one source line — a protocol
 * downgrade beside the map, an unhandled-keys line beside both — so a `find`
 * could return whichever happened to come first and assert about the wrong one.
 */
function linesAbout(planned: MigrationPlan, needle: string): MigrationItem[] {
	return planned.items.filter((item) => item.from.includes(needle));
}

/** The one line about `needle` that says the item was left off. */
function refusal(planned: MigrationPlan, needle: string): MigrationItem {
	const line = linesAbout(planned, needle).find((item) => item.action === "skip" && item.containsSecret);
	if (line === undefined) {
		throw new Error(
			`no line about "${needle}" refused the write: ${JSON.stringify(
				planned.items.filter((i) => i.from.includes(needle)),
				null,
				1,
			)}`,
		);
	}
	return line;
}

/**
 * The shared shape every source's credential row asserts.
 *
 * `written` is what the plan would register under `id`, so a source whose provider
 * lands under a different id (grok registers the *model's* alias, not the provider's)
 * passes the id it actually uses.
 */
function expectRefused(planned: MigrationPlan, needle: string, id: string, sentinel: string): void {
	// 1. Absent from the written settings. This is the assertion that goes red when
	//    the guard is deleted, and it is why the test is worth having.
	expect(providerById(planned, id)).toEqual([]);
	// 2. Said out loud. An importer that skips silently passes 1 and fails here.
	const line = refusal(planned, needle);
	expect(line.detail).toContain("there is no way to drop the credential and keep the address");
	// The reason names the shape, and the fixed phrase carries neither the value nor
	// the address — the same rule `urlCredentialProblem` is written under.
	expect(line.detail).toMatch(/name:password@|parameter names is a credential word/);
	expect(line.detail).not.toContain(sentinel);
	// 3. Nowhere in the plan at all: not the write, not the report, not a sibling
	//    line that quoted the endpoint to explain something else.
	expect(JSON.stringify(planned)).not.toContain(sentinel);
}

/**
 * The refusal wording, as the fixed strings the guard is written under.
 *
 * Asserting these on a *clean* plan is the control that rots quietly. The bare
 * word `credential` is not usable for it: every source's clean line legitimately
 * says "the credential comes from `X`" or "the endpoint and credential variable the
 * section names" — those are about the variable's *name* and were always true.
 */
const REFUSAL = ["name:password@", "parameter names is a credential word", "no way to drop the credential"];

/** Nothing in `text` reads as a refusal, so a clean endpoint was left alone. */
function expectNotRefused(text: string | undefined): void {
	for (const phrase of REFUSAL) expect(text).not.toContain(phrase);
}

// Sentinels. Fixed strings, so a failure names the value that leaked.
const PW = "sk-plan-userinfo-VALUE";
const TOKEN = "sk-plan-querytoken-VALUE";

/** A `base_url` carrying a password in its userinfo, and a clean one. */
const userinfo = (host: string) => `https://alice:${PW}@${host}/v1`;
/** An endpoint whose query carries a credential-named parameter, and a clean one. */
const queryToken = (host: string) => `https://${host}/v1?access_token=${TOKEN}`;
// ---------------------------------------------------------------------------
// codex — `model_providers.<name>.base_url`
// ---------------------------------------------------------------------------

/**
 * A codex `config.toml`. TOML tables are position-dependent, so anything after a
 * `[model_providers.*]` header belongs to that table — the fixture says which.
 */
function codexToml(providers: Record<string, string[]>, top: string[] = []): string {
	const out = ['model = "gpt-5.6-terra"', 'model_provider = "gw"', "model_context_window = 131072", ...top, ""];
	for (const [name, lines] of Object.entries(providers)) {
		out.push(`[model_providers.${name}]`, ...lines, "");
	}
	return out.join("\n");
}

describe("codex — model_providers.<name>.base_url", () => {
	test.each([
		["userinfo", "name:password@"],
		["query token", "parameter names is a credential word"],
	])("a base_url carrying a %s is not written, and says so", (_shape, reason) => {
		const bad = _shape === "userinfo" ? userinfo("gw.example.invalid") : queryToken("gw.example.invalid");
		const sentinel = _shape === "userinfo" ? PW : TOKEN;
		withPlan(
			"lbb-plan-cred-codex-",
			{ ".codex/config.toml": codexToml({ gw: [`base_url = "${bad}"`, 'env_key = "GW_KEY"'] }) },
			"codex",
			(planned) => {
				expectRefused(planned, "model_providers.gw", "gw", sentinel);
				expect(refusal(planned, "model_providers.gw").detail).toContain("model_providers.gw.base_url");
				expect(refusal(planned, "model_providers.gw").detail).toContain(reason);
			},
		);
	});

	test("a clean base_url still migrates, and a credential-shaped env_key name does not stop it", () => {
		// `env_key = "OPENAI_API_KEY"` is the most credential-looking string in this
		// file and it is only a *name* — its value is never read. An importer that
		// flagged it would cost every user with an ordinary provider their provider.
		withPlan(
			"lbb-plan-cred-codex-",
			{
				".codex/config.toml": codexToml({
					gw: ['base_url = "https://gw.example.invalid/v1"', 'env_key = "OPENAI_API_KEY"'],
				}),
			},
			"codex",
			(planned) => {
				const entry = providerById(planned, "gw")[0];
				expect(entry?.baseUrl).toBe("https://gw.example.invalid/v1");
				expect(entry?.apiKeyEnv).toBe("OPENAI_API_KEY");
				// The session model rides on the provider the config names, so an empty
				// `models` here would mean the control passed a provider no run could use.
				expect((entry?.models as Array<{ id: string }> | undefined)?.[0]?.id).toBe("gpt-5.6-terra");
				const line = linesAbout(planned, "model_providers.gw").find((item) => item.to.includes("openaiCompatible"));
				expect(line?.action).toBe("map");
				expect(line?.containsSecret).toBe(false);
				// The map line says the endpoint was checked, because after the fix it
				// was. Before the fix this sentence was about a channel nothing looked at.
				expect(line?.detail).toContain("base_url carried over, and it carries no credential of its own");
				// …and it does not scream at a URL that needed no help.
				expectNotRefused(line?.detail);
			},
		);
	});
});

// ---------------------------------------------------------------------------
// grok — `model.<alias>.base_url` / `api_base_url`, and the provider table's two
// ---------------------------------------------------------------------------

/** A grok `config.toml` with a session model, a provider table and a model table. */
function grokToml(provider: string[], model: string[]): string {
	return [
		"[models]",
		'default = "m"',
		"",
		"[model_providers.gateway]",
		...provider,
		"",
		"[model.m]",
		...model,
		"",
	].join("\n");
}

describe("grok — a model endpoint, in either spelling and from either table", () => {
	// Four rows, because they are four different paths through the planner and the
	// two spellings are separate fields that could drift apart. The first two are the
	// model's own; the last two are inherited, which is the shape that used to report
	// "an override of a model grok already knows" about a model that has an endpoint.
	test.each([
		["base_url", "model.base_url"],
		["api_base_url", "model.api_base_url"],
	])("a model's own %s carrying a credential is not written", (field, where) => {
		const bad = where === "model.base_url" ? userinfo("own.example.invalid") : queryToken("own.example.invalid");
		const sentinel = where === "model.base_url" ? PW : TOKEN;
		withPlan(
			"lbb-plan-cred-grok-",
			{ ".grok/config.toml": grokToml([], ['model = "m"', `${field} = "${bad}"`]) },
			"grok-build",
			(planned) => {
				expectRefused(planned, "model.m", "m", sentinel);
				// The line names the field it actually read, so a user with two
				// spellings in one file knows which one was refused.
				expect(refusal(planned, "model.m").detail).toContain(`model.m.${field}`);
				// …and not the provider's, which this model never inherited from.
				expect(refusal(planned, "model.m").detail).not.toContain("model_providers.gateway");
			},
		);
	});

	test.each([
		["base_url", "base_url"],
		["api_base_url", "api_base_url"],
	])("a model inheriting a provider %s carrying a credential is not written", (field) => {
		const bad = field === "base_url" ? userinfo("gw.example.invalid") : queryToken("gw.example.invalid");
		const sentinel = field === "base_url" ? PW : TOKEN;
		withPlan(
			"lbb-plan-cred-grok-",
			{
				".grok/config.toml": grokToml(
					[`${field} = "${bad}"`, 'env_key = "GW_KEY"'],
					['model = "m"', 'model_provider = "gateway"'],
				),
			},
			"grok-build",
			(planned) => {
				// grok registers the *model's* alias, so that is the id written.
				expectRefused(planned, "model.m", "m", sentinel);
				expect(refusal(planned, "model.m").detail).toContain(`model_providers.gateway.${field}`);
			},
		);
	});

	test("a clean endpoint in either table still migrates, and neither env_key name is flagged", () => {
		withPlan(
			"lbb-plan-cred-grok-",
			{
				".grok/config.toml": [
					"[models]",
					'default = "m"',
					"",
					"[model_providers.gateway]",
					'base_url = "https://gw.example.invalid/v1"',
					'env_key = "OPENAI_API_KEY"',
					"",
					"[model.m]",
					'model = "m"',
					'model_provider = "gateway"',
					"",
					"[model.own]",
					'model = "own"',
					'api_base_url = "https://own.example.invalid/v1"',
					'env_key = "OWN_TOKEN"',
					"",
				].join("\n"),
			},
			"grok-build",
			(planned) => {
				expect(providerById(planned, "m")[0]?.baseUrl).toBe("https://gw.example.invalid/v1");
				expect(providerById(planned, "m")[0]?.apiKeyEnv).toBe("OPENAI_API_KEY");
				expect(providerById(planned, "own")[0]?.baseUrl).toBe("https://own.example.invalid/v1");
				expect(providerById(planned, "own")[0]?.apiKeyEnv).toBe("OWN_TOKEN");
				for (const alias of ["model.m", "model.own"]) {
					const line = linesAbout(planned, alias).find((item) => item.action === "map");
					expect(line?.containsSecret).toBe(false);
					expectNotRefused(line?.detail);
				}
			},
		);
	});
});

// ---------------------------------------------------------------------------
// deepseek-harness — `llm-pi-ai.providers.<route>.baseURL`, `llm-deepseek.baseURL`
// ---------------------------------------------------------------------------

/**
 * A harness composition carrying the routes the importer reads.
 *
 * A Cordis patch layer, not a `settings.yaml` mapping: the settings document was
 * retired (`settings/settings/src/index.ts:238` calls it "the removed
 * `settings.yaml`") and the routes now live in rows addressed by `- id:`.
 */
function dshYaml(gatewayBaseUrl: string, deepseekBaseUrl?: string): string {
	const out = [
		"- insert:",
		"    - id: llm-pi-ai",
		"      name: '@deepseek-ai/dsh-llm-pi-ai'",
		"      config:",
		"        providers:",
		"          gateway:",
		"            apiKeyEnv: GATEWAY_API_KEY",
		"            api: openai-completions",
		`            baseURL: ${gatewayBaseUrl}`,
		"            models:",
		"              - id: gateway-chat",
		"                contextWindow: 131072",
		"                maxTokens: 4096",
	];
	if (deepseekBaseUrl !== undefined) {
		out.push(
			"",
			"    - id: llm-deepseek",
			"      name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
			"      config:",
			"        apiKeyEnv: DEEPSEEK_API_KEY",
			`        baseURL: ${deepseekBaseUrl}`,
			"        protocol: chat-completions",
			"        models:",
			"          - id: deepseek-v4-pro",
			"            contextWindow: 1000000",
			"            maxTokens: 384000",
		);
	}
	return `${out.join("\n")}\n`;
}

describe("deepseek-harness — the two baseURL fields", () => {
	test.each([
		["userinfo", () => userinfo("gw.example.invalid"), PW],
		["query token", () => queryToken("gw.example.invalid"), TOKEN],
	])("a route baseURL carrying a %s is not written", (_shape, make, sentinel) => {
		withPlan("lbb-plan-cred-dsh-", { ".dsh/cordis.patch.yml": dshYaml(make()) }, "deepseek-harness", (planned) => {
			expectRefused(planned, "providers.gateway", "dsh-gateway", sentinel);
			expect(refusal(planned, "providers.gateway").detail).toContain("llm-pi-ai.providers.gateway.baseURL");
		});
	});

	test.each([
		["userinfo", () => userinfo("api.deepseek.invalid"), PW],
		["query token", () => queryToken("api.deepseek.invalid"), TOKEN],
	])("an llm-deepseek baseURL carrying a %s is not written", (_shape, make, sentinel) => {
		withPlan(
			"lbb-plan-cred-dsh-",
			{ ".dsh/cordis.patch.yml": dshYaml("https://gw.example.invalid/v1", make()) },
			"deepseek-harness",
			(planned) => {
				expectRefused(planned, "llm-deepseek", "dsh-deepseek-official", sentinel);
				expect(refusal(planned, "llm-deepseek").detail).toContain("llm-deepseek.baseURL");
			},
		);
	});

	test("both clean baseURLs still migrate, and neither apiKeyEnv is flagged", () => {
		withPlan(
			"lbb-plan-cred-dsh-",
			{ ".dsh/cordis.patch.yml": dshYaml("https://gw.example.invalid/v1", "https://api.deepseek.invalid/v1") },
			"deepseek-harness",
			(planned) => {
				expect(providerById(planned, "dsh-gateway")[0]?.baseUrl).toBe("https://gw.example.invalid/v1");
				expect(providerById(planned, "dsh-gateway")[0]?.apiKeyEnv).toBe("GATEWAY_API_KEY");
				expect(providerById(planned, "dsh-deepseek-official")[0]?.baseUrl).toBe("https://api.deepseek.invalid/v1");
				for (const id of ["dsh-gateway", "dsh-deepseek-official"]) {
					const line = planned.items.find((item) => item.to.includes(`[${id}]`) && item.action === "map");
					expect(line?.containsSecret).toBe(false);
					expectNotRefused(line?.detail);
				}
			},
		);
	});

	test("a credential in the deepseek endpoint is not echoed by the model line that compares against it", () => {
		// The fifth carrier, and the one a fix at the two registration sites alone
		// would have missed: the model's own line interpolates the harness endpoint
		// into a sentence. Skipping the registration stops the *write*; only this
		// stops the *report* from printing the same address one line later.
		withPlan(
			"lbb-plan-cred-dsh-",
			{
				".dsh/cordis.patch.yml": [
					"- insert:",
					"    - id: agent-default-model",
					"      name: '@deepseek-ai/dsh-agent-default-model'",
					"      config:",
					"        provider: deepseek-official",
					"        model: deepseek-v4-pro",
					"    - id: llm-deepseek",
					"      name: '@deepseek-ai/dsh-llm-deepseek-api-key'",
					"      config:",
					"        apiKeyEnv: DEEPSEEK_API_KEY",
					`        baseURL: ${userinfo("api.deepseek.invalid")}`,
					"        protocol: chat-completions",
					"        models:",
					"          - id: deepseek-v4-pro",
					"            contextWindow: 1000000",
					"            maxTokens: 384000",
					"",
				].join("\n"),
			},
			"deepseek-harness",
			(planned) => {
				expect(providerById(planned, "dsh-deepseek-official")).toEqual([]);
				expect(JSON.stringify(planned)).not.toContain(PW);
				expect(JSON.stringify(planned)).not.toContain("alice");
				// And it does not paper over the loss by claiming the harness falls
				// back to its own endpoint — it declares one, and the report says so
				// while declining to print it.
				expect(JSON.stringify(planned)).toContain("carries a credential");
			},
		);
	});
});

// ---------------------------------------------------------------------------
// minimax-code — `custom_provider.<key>.options.baseURL`
// ---------------------------------------------------------------------------

/** A `custom_provider` table as `config.yaml` spells one. */
function minimaxYaml(key: string, baseUrl: string, env: string[]): string {
	return [
		"custom_provider:",
		`  ${key}:`,
		"    env:",
		...env.map((name) => `      - ${name}`),
		"    options:",
		`      baseURL: ${baseUrl}`,
		"    models:",
		"      m1: {}",
	].join("\n");
}

describe("minimax-code — custom_provider.<key>.options.baseURL", () => {
	test.each([
		["userinfo", () => userinfo("gw.example.invalid"), PW],
		["query token", () => queryToken("gw.example.invalid"), TOKEN],
	])("a baseURL carrying a %s is not written", (_shape, make, sentinel) => {
		withPlan(
			"lbb-plan-cred-minimax-",
			{ ".minimax/config.yaml": minimaxYaml("mygw", make(), ["MYGW_API_KEY"]) },
			"minimax-code",
			(planned) => {
				expectRefused(planned, "custom_provider.mygw", "minimax-mygw", sentinel);
				expect(refusal(planned, "custom_provider.mygw").detail).toContain("custom_provider.mygw.options.baseURL");
			},
		);
	});

	test("a clean baseURL still migrates, and the env[] names are not flagged", () => {
		// `env[]` holds variable *names* — the difference between naming a credential
		// and copying one, which this file's own header is about.
		withPlan(
			"lbb-plan-cred-minimax-",
			{
				".minimax/config.yaml": minimaxYaml("mygw", "https://gw.example.invalid/v1", ["OPENAI_API_KEY", "MYGW_SECRET"]),
			},
			"minimax-code",
			(planned) => {
				expect(providerById(planned, "minimax-mygw")[0]?.baseUrl).toBe("https://gw.example.invalid/v1");
				expect(providerById(planned, "minimax-mygw")[0]?.apiKeyEnv).toBe("OPENAI_API_KEY");
				const line = linesAbout(planned, "custom_provider.mygw").find((item) => item.action === "map");
				expect(line?.containsSecret).toBe(false);
				expectNotRefused(line?.detail);
			},
		);
	});
});

// ---------------------------------------------------------------------------
// What the helper itself is allowed to say, in a provider report line
// ---------------------------------------------------------------------------

describe("the reason, in a provider report line", () => {
	test("names the field and the shape, and neither the value nor the address", () => {
		const bad = userinfo("gw.example.invalid");
		withPlan(
			"lbb-plan-cred-wording-",
			{ ".codex/config.toml": codexToml({ gw: [`base_url = "${bad}"`] }) },
			"codex",
			(planned) => {
				const detail = refusal(planned, "model_providers.gw").detail;
				expect(detail).toContain("model_providers.gw.base_url");
				expect(detail).toContain("name:password@");
				expect(detail).not.toContain(PW);
				expect(detail).not.toContain("alice");
				// The host is in the source file the user can open; the password is not,
				// and the difference is what this line is for.
				expect(detail).not.toContain("gw.example.invalid");
			},
		);
	});

	test("a skipped provider does not stop the clean one beside it", () => {
		// A false positive costs a user one provider — but an importer that refused
		// the whole file would cost them all of them, and the report would look
		// exactly the same as correct behaviour.
		const bad = userinfo("bad.example.invalid");
		withPlan(
			"lbb-plan-cred-sibling-",
			{
				".codex/config.toml": codexToml({
					bad: [`base_url = "${bad}"`],
					good: ['base_url = "https://good.example.invalid/v1"', 'env_key = "GOOD_KEY"'],
				}),
			},
			"codex",
			(planned) => {
				expect(providerById(planned, "bad")).toEqual([]);
				expect(providerById(planned, "good")[0]?.baseUrl).toBe("https://good.example.invalid/v1");
				// One refusal does not become a file-wide one, and saying so is the
				// only way a regression here would be visible.
				expect(linesAbout(planned, "model_providers.good").filter((item) => item.action === "map")).toHaveLength(1);
			},
		);
	});
});
