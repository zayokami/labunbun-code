/**
 * The Grok Build MCP and endpoint face: `[mcp_servers.*]` and `[model.<id>]`.
 *
 * Two credential rules shape this file, and both are about what is *not* read:
 *
 * - grok can name an environment variable for a bearer token, an OAuth client
 *   secret or a header value. None of those variables is expanded here and no
 *   empty value is invented — a server that authenticates itself from the
 *   environment would otherwise be copied as one that fails at connect time. The
 *   report names the variables instead.
 * - `[model.<id>]` may carry an inline `api_key`. Its *presence* is checked and
 *   its value is never read: the settings schema here holds a variable name, so
 *   a literal has nowhere to go — and copying one into `settings.json` would put
 *   a live credential in a second file. The sentinel below is a value the test
 *   requires to be absent from every line of the report and every write.
 *
 * Fixture credentials are fake and say so; nothing here is key-shaped.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type MigrationItem,
	type MigrationPlan,
	planMigration,
	readSources,
	requoteNumericKeyPaths,
} from "../src/migrate.ts";
import type { RawSettingsInput } from "../src/settings.ts";

type SourceTree = Record<string, string>;

/** Run `body` against a throwaway home whose `~/.grok` holds `tree`. */
function withGrokHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-grok-mcp-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	const prevGrokHome = process.env.GROK_HOME;
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		// The machine's own `$GROK_HOME`, if any, must not win over the fixture.
		delete process.env.GROK_HOME;
		for (const [path, content] of Object.entries(tree)) {
			const full = join(home, ".grok", path);
			mkdirSync(join(full, ".."), { recursive: true });
			writeFileSync(full, content);
		}
		body(home);
	} finally {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		if (prevGrokHome === undefined) delete process.env.GROK_HOME;
		else process.env.GROK_HOME = prevGrokHome;
		rmSync(home, { recursive: true, force: true });
	}
}

function plan(tree: SourceTree, existing: RawSettingsInput = {}, force = false): MigrationPlan {
	let planned: MigrationPlan | undefined;
	withGrokHome(tree, (home) => {
		planned = planMigration(readSources(home), existing, { only: ["grok-build"], force });
	});
	if (!planned) throw new Error("the fake home did not survive");
	return planned;
}

/** The servers the plan would write to `.mcp.json`. */
function writtenMcp(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((w) => w.kind === "mcp");
	const parsed = JSON.parse(write?.content ?? "{}") as { mcpServers?: Record<string, unknown> };
	return parsed.mcpServers ?? {};
}

/** The settings document the plan would write. */
function writtenSettings(planned: MigrationPlan): Record<string, unknown> {
	const write = planned.writes.find((w) => w.kind === "settings");
	return JSON.parse(write?.content ?? "{}") as Record<string, unknown>;
}

/** Every byte the plan would report or write, for "this value is nowhere" claims. */
function planText(planned: MigrationPlan): string {
	return JSON.stringify({ items: planned.items, writes: planned.writes });
}

function line(planned: MigrationPlan, needle: string): MigrationItem | undefined {
	return planned.items.find((item) => item.from.includes(needle));
}

const STDIO_AND_HTTP = [
	"[mcp_servers.files]",
	'command = "npx"',
	'args = ["-y", "server-filesystem", "G:/work"]',
	'env = { FILES_ROOT_TOKEN = "fixture-token-not-real" }',
	'cwd = "G:/work"',
	"",
	"[mcp_servers.docs]",
	'url = "https://mcp.example/docs"',
	'type = "streamable-http"',
	'headers = { X-Client = "labunbun-migrate" }',
	"",
].join("\n");

describe("grok MCP servers", () => {
	test("a stdio server and an http server are copied in this build's shapes", () => {
		const planned = plan({ "config.toml": STDIO_AND_HTTP });
		const servers = writtenMcp(planned);
		expect(servers.files).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "server-filesystem", "G:/work"],
			env: { FILES_ROOT_TOKEN: "fixture-token-not-real" },
			cwd: "G:/work",
		});
		expect(servers.docs).toEqual({
			type: "http",
			url: "https://mcp.example/docs",
			headers: { "X-Client": "labunbun-migrate" },
		});
		// A value under a credential-shaped name is carried — that is what "copied
		// verbatim" means for MCP — and the report says so on the line itself.
		expect(line(planned, "mcp_servers.files")?.containsSecret).toBe(true);
		expect(line(planned, "mcp_servers.files")?.detail).toContain("including credential headers");
	});

	test("a server grok keeps switched off is not started here", () => {
		const planned = plan({
			"config.toml": ["[mcp_servers.off]", 'command = "node"', "enabled = false", ""].join("\n"),
		});
		// There is no "defined but not started" state here, so copying it would start
		// a server the user had turned off.
		expect(writtenMcp(planned)).toEqual({});
		expect(line(planned, "mcp_servers.off")?.action).toBe("skip");
		expect(line(planned, "mcp_servers.off")?.detail).toContain("no way to keep a server defined and switched off");
	});

	test("the two disabled-server lists are named", () => {
		const planned = plan({
			"config.toml": ['disabled_mcp_servers = ["legacy"]', 'disabled_mcp_tools = { files = ["write"] }', ""].join("\n"),
		});
		expect(line(planned, "disabled_mcp_servers")?.action).toBe("skip");
		expect(line(planned, "disabled_mcp_tools")?.action).toBe("skip");
		expect(writtenMcp(planned)).toEqual({});
	});

	test("a token the source reads from the environment is named, not invented", () => {
		const planned = plan({
			"config.toml": [
				"[mcp_servers.docs]",
				'url = "https://mcp.example/docs"',
				'bearer_token_env_var = "DOCS_TOKEN"',
				"",
			].join("\n"),
		});
		// grok builds the Authorization header from that variable at request time.
		// Writing `Authorization: $DOCS_TOKEN` here would send the literal text —
		// headers in this build are not expanded — so the header is left out and the
		// variable is named instead.
		expect(writtenMcp(planned).docs).toEqual({ type: "http", url: "https://mcp.example/docs" });
		const item = line(planned, "mcp_servers.docs");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("$DOCS_TOKEN");
		expect(item?.detail).toContain("not expanded here");
	});

	test("a client secret and header variables are named the same way", () => {
		const planned = plan({
			"config.toml": [
				"[mcp_servers.oauth]",
				'url = "https://mcp.example/oauth"',
				'oauth_client_secret_env_var = "OAUTH_SECRET"',
				"",
				"[mcp_servers.hdr]",
				'url = "https://mcp.example/hdr"',
				'env_http_headers = { Authorization = "HDR_TOKEN" }',
				"",
			].join("\n"),
		});
		expect(line(planned, "mcp_servers.oauth")?.detail).toContain("$OAUTH_SECRET");
		expect(line(planned, "mcp_servers.hdr")?.detail).toContain("$HDR_TOKEN");
		expect(writtenMcp(planned).hdr).toEqual({ type: "http", url: "https://mcp.example/hdr" });
	});

	test("a setting with no counterpart here is named as a downgrade", () => {
		const planned = plan({
			"config.toml": ["[mcp_servers.slow]", 'command = "node"', "startup_timeout_sec = 60", ""].join("\n"),
		});
		const item = line(planned, "mcp_servers.slow");
		expect(item?.action).toBe("downgrade");
		expect(item?.detail).toContain("startup_timeout_sec");
		expect(item?.detail).toContain("no counterpart here");
	});

	test("an entry that is neither shape is named rather than half-carried", () => {
		const planned = plan({ "config.toml": ["[mcp_servers.nothing]", 'type = "stdio"', ""].join("\n") });
		expect(line(planned, "mcp_servers.nothing")?.detail).toContain("does not match the supported stdio/http shapes");
		expect(writtenMcp(planned)).toEqual({});
	});
});

describe("grok model endpoints", () => {
	test("an endpoint becomes a provider and its default becomes the model", () => {
		const planned = plan({
			"config.toml": [
				"[models]",
				'default = "local-qwen"',
				"",
				"[model.local-qwen]",
				'base_url = "https://api.example/v1"',
				'env_key = "LOCAL_KEY"',
				"context_window = 200000",
				"",
			].join("\n"),
		});
		const providers = (writtenSettings(planned) as { providers?: { openaiCompatible?: unknown[] } }).providers;
		expect(providers?.openaiCompatible).toEqual([
			{
				id: "local-qwen",
				baseUrl: "https://api.example/v1",
				apiKeyEnv: "LOCAL_KEY",
				models: [{ id: "local-qwen", contextWindow: 200000, maxOutputTokens: 8192 }],
			},
		]);
		expect(writtenSettings(planned).model).toBe("local-qwen/local-qwen");
		expect(line(planned, "models.default")?.detail).toContain('registered under the "local-qwen" provider');
	});

	test("api_base_url is an endpoint too, and the difference is stated", () => {
		const planned = plan({
			"config.toml": ["[model.alt]", 'api_base_url = "https://alt.example/v1"', 'model = "real-wire-id"', ""].join(
				"\n",
			),
		});
		expect(writtenSettings(planned).model).toBeUndefined();
		expect(line(planned, "model.alt")?.detail).toContain("the endpoint is the one api_base_url names");
		const providers = (
			writtenSettings(planned) as { providers?: { openaiCompatible?: Array<{ id: string; models: unknown[] }> } }
		).providers;
		// The table key is the provider id; `model` is the name the endpoint answers
		// to. They differ here on purpose, and both halves are asserted: registering
		// the provider under the wire id would leave `models.default` looking for a
		// provider the source never named.
		expect(providers?.openaiCompatible?.[0]?.id).toBe("alt");
		expect(providers?.openaiCompatible?.[0]?.models).toEqual([
			{ id: "real-wire-id", contextWindow: 128000, maxOutputTokens: 8192 },
		]);
	});

	test("an inline api_key is noticed and never read", () => {
		const sentinel = "zz-not-a-real-key-value-zz";
		const planned = plan({
			"config.toml": ["[model.local-qwen]", 'base_url = "https://api.example/v1"', `api_key = "${sentinel}"`, ""].join(
				"\n",
			),
		});
		// Presence only: the report has to say the key is still in config.toml and has
		// to be exported, and it may not carry the value anywhere — not into the
		// settings file, not into a report line, not into a write of any kind.
		expect(planText(planned)).not.toContain(sentinel);
		expect(line(planned, "model.local-qwen")?.detail).toContain("(api_key) and was not read");
		expect(line(planned, "model.local-qwen")?.detail).toContain("LOCAL_QWEN_API_KEY");
		const settings = writtenSettings(planned) as { providers?: { openaiCompatible?: Array<{ apiKeyEnv?: string }> } };
		expect(settings.providers?.openaiCompatible?.[0]?.apiKeyEnv).toBe("LOCAL_QWEN_API_KEY");
	});

	test("a model that names a provider is registered against the endpoint the provider holds", () => {
		const planned = plan({
			"config.toml": [
				"[models]",
				'default = "via-gateway"',
				"",
				"[model_providers.gateway]",
				'base_url = "https://gateway.example/v1"',
				"context_window = 123456",
				"",
				"[model.via-gateway]",
				'model = "m"',
				'model_provider = "gateway"',
				"",
			].join("\n"),
		});
		// The defect this test exists for: the model's own table holds no endpoint, so
		// it used to come back as an override that "names no endpoint of its own" —
		// about a model whose endpoint is one table over. Both halves are asserted,
		// because the false sentence on its own would satisfy a naive presence check.
		expect(planned.items.some((item) => item.detail.includes("names no endpoint of its own"))).toBe(false);
		// Nor may the keys this reads come back as keys the importer has no mapping
		// for: `model_provider` on the entry and the whole table above it are both
		// read now, and either one still landing in a fallback line would put the
		// report back where this defect started.
		expect(planned.items.some((item) => item.from.endsWith("→ model_provider"))).toBe(false);
		expect(planned.items.some((item) => item.detail.includes("no mapping for and no note about"))).toBe(false);
		const providers = (writtenSettings(planned) as { providers?: { openaiCompatible?: unknown[] } }).providers;
		expect(providers?.openaiCompatible).toEqual([
			{
				id: "via-gateway",
				baseUrl: "https://gateway.example/v1",
				apiKeyEnv: "VIA_GATEWAY_API_KEY",
				// The context window is the provider's: grok's merge is `or_else`, and
				// this model states none of its own.
				models: [{ id: "m", contextWindow: 123456, maxOutputTokens: 8192 }],
			},
		]);
		// The line says where the endpoint came from, so a reader can go and look.
		expect(line(planned, "model.via-gateway")?.detail).toContain(
			"the endpoint is the one model_providers.gateway defines",
		);
		// Nor may a provider a model resolves through be reported as one nobody names:
		// those two lines are two sides of one fact, and a report saying both would
		// contradict itself in the user's hands.
		expect(planned.items.some((item) => item.detail.includes("no model in this config names it"))).toBe(false);
		// And the model the session would start on is that endpoint's, named by the
		// table key rather than by the provider: the two are separate decisions, and
		// registering the provider under the provider's id would leave this reference
		// pointing at nothing.
		expect(writtenSettings(planned).model).toBe("via-gateway/m");
	});

	test("the provider's credential applies only where the model has none of its own", () => {
		const config = (modelExtra: string): string =>
			[
				"[model_providers.gateway]",
				'base_url = "https://gateway.example/v1"',
				'env_key = "GATEWAY_KEY"',
				"",
				"[model.via-gateway]",
				'model_provider = "gateway"',
				modelExtra,
			].join("\n");
		const providerEnv = (tree: string): string | undefined => {
			const providers = (
				writtenSettings(plan({ "config.toml": tree })) as {
					providers?: { openaiCompatible?: Array<{ apiKeyEnv?: string }> };
				}
			).providers;
			return providers?.openaiCompatible?.[0]?.apiKeyEnv;
		};
		expect(providerEnv(config(""))).toBe("GATEWAY_KEY");
		// All-or-nothing, as grok's own merge is: a model with any credential of its
		// own takes none of the provider's, not the other variables beside it.
		expect(providerEnv(config('env_key = "OWN_KEY"'))).toBe("OWN_KEY");
		// Which of the two it is has to be on the line, too: a user told only the
		// variable name would go looking for it on the model entry, where the source
		// never wrote it — and a user told only that it was "read" would not know the
		// provider's variable is the one in force.
		const note = (modelExtra: string): string | undefined =>
			line(plan({ "config.toml": config(modelExtra) }), "model.via-gateway")?.detail;
		expect(note("")).toContain("GATEWAY_KEY, the variable its provider's env_key names");
		expect(note('env_key = "OWN_KEY"')).toContain("the credential is read from OWN_KEY");
		// An inline key is a credential of the model's own as well, so the provider's
		// variable is not the one this endpoint would read.
		expect(providerEnv(config('api_key = "zz-not-a-real-key-zz"'))).toBe("VIA_GATEWAY_API_KEY");
		// A helper beside a variable is the fallback for when that variable does not
		// resolve, so it is not the same statement as "the variable is the credential".
		expect(note('env_key = "OWN_KEY"\nauth_provider = "corp"')).toContain(
			"auth_provider names a helper that mints one when that variable",
		);
	});

	test("a model's own credential helper is named, not a variable it has not got", () => {
		const planned = plan({
			"config.toml": [
				"[model_providers.gateway]",
				'base_url = "https://gateway.example/v1"',
				'env_key = "GATEWAY_KEY"',
				"",
				"[model.via-gateway]",
				'model_provider = "gateway"',
				'auth_provider = "corp"',
				"",
			].join("\n"),
		});
		// Naming a helper is a credential of the model's own (`with_provider_defaults`
		// counts it as one), so the provider's variable is not the one in force here.
		const providers = (writtenSettings(planned) as { providers?: { openaiCompatible?: Array<{ apiKeyEnv?: string }> } })
			.providers;
		expect(providers?.openaiCompatible?.[0]?.apiKeyEnv).toBe("VIA_GATEWAY_API_KEY");
		const detail = line(planned, "model.via-gateway")?.detail ?? "";
		expect(detail).toContain("the credential helper auth_provider names");
		// And the variable it names is a real one: without its own branch this line
		// read "the credential is read from undefined".
		expect(detail).toContain("VIA_GATEWAY_API_KEY");
		expect(detail).not.toContain("undefined");
		// `auth_provider` is read for presence like `api_key` is, so it may not also
		// come back as a key this planner has no mapping for.
		expect(planned.items.some((item) => item.detail.includes("no mapping for and no note about"))).toBe(false);
	});

	test("a provider's inline key is noticed and never read", () => {
		const sentinel = "zz-provider-not-a-real-key-zz";
		const planned = plan({
			"config.toml": [
				"[model_providers.gateway]",
				'base_url = "https://gateway.example/v1"',
				`api_key = "${sentinel}"`,
				"",
				"[model.via-gateway]",
				'model_provider = "gateway"',
				"",
			].join("\n"),
		});
		expect(planText(planned)).not.toContain(sentinel);
		// The model inherits the provider's key, so the note about the inline value has
		// to say where it is written — a user told to export `VIA_GATEWAY_API_KEY`
		// without being told which table holds the key would go looking in the model's.
		expect(line(planned, "model.via-gateway")?.detail).toContain("api_key on model_providers.gateway");
		expect(line(planned, "model.via-gateway")?.detail).toContain("VIA_GATEWAY_API_KEY");
	});

	test("a provider reference that resolves to no endpoint says which kind of nothing it is", () => {
		// Two different facts, and a report that ran them together would send the user
		// to the wrong table: a provider that is not defined at all, and one that is
		// defined and holds no endpoint.
		const dangling = plan({
			"config.toml": ["[model.dangling]", 'model = "m"', 'model_provider = "ghost"', ""].join("\n"),
		});
		expect(line(dangling, "model.dangling")?.detail).toContain("this config does not define");
		expect(line(dangling, "model.dangling")?.detail).toContain("model_providers.ghost");
		const bare = plan({
			"config.toml": [
				"[model_providers.bare]",
				"context_window = 1000",
				"",
				"[model.on-bare]",
				'model_provider = "bare"',
				"",
			].join("\n"),
		});
		expect(line(bare, "model.on-bare")?.detail).toContain("defines neither base_url nor api_base_url");
		expect(writtenSettings(bare).providers).toBeUndefined();
	});

	test("a provider no model resolves through is named, not imported", () => {
		const planned = plan({
			"config.toml": ["[model_providers.unused]", 'base_url = "https://unused.example/v1"', ""].join("\n"),
		});
		// grok reaches a provider only through the model that names it, so this table
		// is inert there. Registering it would hand the user an endpoint the source
		// never used; saying nothing would read as an omission.
		expect(line(planned, "model_providers.unused")?.detail).toContain("no model in this config names it");
		expect(writtenSettings(planned).providers).toBeUndefined();
	});

	test("a provider entry that is not a table is named rather than passed over", () => {
		const planned = plan({
			"config.toml": ["[model_providers]", 'gateway = "https://gateway.example/v1"', ""].join("\n"),
		});
		// grok's own parser warns about this shape and skips it. An importer that said
		// nothing would leave the entry out of the report entirely, which reads as a
		// provider that was carried over.
		expect(line(planned, "model_providers.gateway")?.detail).toContain("not a table");
		expect(writtenSettings(planned).providers).toBeUndefined();
	});

	test("a provider's request-shaping fields and credential helper are named", () => {
		const planned = plan({
			"config.toml": [
				"[model_providers.gateway]",
				'base_url = "https://gateway.example/v1"',
				'api_backend = "responses"',
				"",
				"[model_providers.gateway.query_params]",
				'api-version = "2026-07-22"',
				"",
				"[model_providers.gateway.extra_headers]",
				'X-Tenant = "acme"',
				"",
				"[model_providers.gateway.auth]",
				'command = "printf token"',
				"",
				"[model.via-gateway]",
				'model_provider = "gateway"',
				"",
			].join("\n"),
		});
		// Inherited wholesale by the models that name the provider, and there is
		// nowhere for them to go: a provider entry here carries an endpoint, a
		// variable name and models.
		const fold = line(planned, "extra_headers, query_params");
		expect(fold?.detail).toContain("folded into every request by grok");
		expect(fold?.detail).toContain("will not answer the same way");
		expect(line(planned, "→ auth")?.detail).toContain("credential helper grok runs");
		// The model inherits the helper, so its own line has to say how to authenticate
		// once the helper is gone.
		expect(line(planned, "model.via-gateway")?.detail).toContain("mints its token with a credential helper");
		expect(line(planned, "model.via-gateway")?.detail).toContain("VIA_GATEWAY_API_KEY");
		// The wire protocol is inherited too: the model names no `api_backend`, so the
		// one on the provider is the one grok speaks to this endpoint.
		expect(line(planned, "model.via-gateway")?.detail).toContain('api_backend is "responses"');
	});

	test("an override of a model grok already knows stays behind", () => {
		const planned = plan({
			"config.toml": ["[model.grok-4]", 'reasoning_effort = "high"', "temperature = 0.2", ""].join("\n"),
		});
		// `endsWith`, because the line naming the keys inside it mentions the alias too.
		expect(planned.items.find((item) => item.from.endsWith("→ model.grok-4"))?.detail).toContain(
			"names no endpoint of its own",
		);
		// And the keys inside it are named: the entry is reported, so a reader would
		// otherwise take the retunings beside them for carried settings.
		expect(line(planned, "→ reasoning_effort, temperature")?.action).toBe("skip");
		expect(writtenSettings(planned).providers).toBeUndefined();
	});

	test("a dotted id is read as grok reads it, and the rest of the file still is", () => {
		// grok's user guide writes per-model overrides this way in four places
		// (`[model.grok-4.6]`), and it is legal TOML: the path `model` → `grok-4` →
		// `6`. grok's parser takes it. `Bun.TOML` rejects the whole document over it,
		// which used to cost the user every other setting in the file — so the parse
		// is retried with that one segment quoted.
		const planned = plan({
			"config.toml": [
				"[model.grok-4.6]",
				'reasoning_effort = "high"',
				"temperature = 0.2",
				"",
				"[mcp_servers.after]",
				'command = "node"',
				"",
				"[permission]",
				'deny = ["Bash(rm -rf:*)"]',
				"",
			].join("\n"),
		});
		const item = line(planned, "model.grok-4.6");
		expect(item?.action).toBe("skip");
		expect(item?.detail).toContain('a table named "6" inside "model.grok-4"');
		expect(item?.detail).toContain('[model.grok-4."6"]');
		// Not described as an override of a model, which is not what was written: the
		// alias `grok-4` exists only because of the dotted path, so the loop leaves it
		// to the line above.
		expect(planned.items.some((i) => i.detail.includes("names no endpoint of its own"))).toBe(false);
		expect(writtenSettings(planned).providers).toBeUndefined();
		// The point of the retry: the sections around it are not lost with it.
		expect(Object.keys(writtenMcp(planned))).toEqual(["after"]);
		// The rule is translated as it would be from a file that parsed first time:
		// grok's `:*` becomes this build's `*`.
		expect(planned.writes.find((w) => w.kind === "settings")?.content).toContain("Bash(rm -rf*)");
	});

	test("a header-shaped line inside a string is not a key path", () => {
		// The rewrite applies to key positions only, so a description that happens to
		// contain the same text keeps the bytes the user typed. The dotted path below
		// is what forces the retry; without it the repair would never run and the
		// assertion would hold for the wrong reason.
		const planned = plan({
			"config.toml": [
				"[model.mine]",
				'base_url = "https://api.example/v1"',
				'description = """',
				"[model.grok-4.6]",
				'"""',
				'note = "[model.grok-2.1]"',
				"",
				"[model.other.7]",
				'reasoning_effort = "low"',
				"",
			].join("\n"),
		});
		expect(planned.items.some((i) => i.from.includes("model.other.7"))).toBe(true);
		expect(planned.items.some((i) => i.from.includes("grok-4.6"))).toBe(false);
		expect(planned.items.some((i) => i.from.includes("grok-2.1"))).toBe(false);
		const providers = (writtenSettings(planned) as { providers?: { openaiCompatible?: Array<{ id: string }> } })
			.providers;
		expect(providers?.openaiCompatible?.map((p) => p.id)).toEqual(["mine"]);
	});

	test("the requoting touches key positions and nothing else", () => {
		expect(requoteNumericKeyPaths('[model.mine]\nbase_url = "https://api.example/v1"\n')).toBeNull();
		expect(requoteNumericKeyPaths("[a.b.6]\nx = 1\n")).toEqual({ text: '[a.b."6"]\nx = 1\n', changed: ["a.b.6"] });
		expect(requoteNumericKeyPaths("[model.grok-4.6]\n")).toEqual({
			text: '[model.grok-4."6"]\n',
			changed: ["model.grok-4.6"],
		});
		// Assignment form, spaces and arrays of tables are the same path.
		expect(requoteNumericKeyPaths("a.b.6 = 1\n")?.text).toBe('a.b."6" = 1\n');
		expect(requoteNumericKeyPaths("[[a.b.6]]\n")?.text).toBe('[[a.b."6"]]\n');
		expect(requoteNumericKeyPaths("[a . b . 6]\n")?.text).toBe('[a.b."6"]\n');
		// A quoted segment is already one key; a digits-only *value* is a value.
		expect(requoteNumericKeyPaths('[a."b.6"]\nx = 1\n')).toBeNull();
		expect(requoteNumericKeyPaths("a = 1.6\n")).toBeNull();
		// Inside a string, including a multi-line one, the text is content.
		expect(requoteNumericKeyPaths('note = "[a.b.6]"\n')).toBeNull();
		expect(requoteNumericKeyPaths('d = """\n[a.b.6]\nx = 1\n"""\n')).toBeNull();
		expect(requoteNumericKeyPaths("d = '''\n[a.b.6]\n'''\n[e.9]\n")).toEqual({
			text: "d = '''\n[a.b.6]\n'''\n[e.\"9\"]\n",
			changed: ["e.9"],
		});
	});

	test("a default that answers to nothing here is a line, not silence", () => {
		const planned = plan({ "config.toml": ["[models]", 'default = "no-such-model-anywhere"', ""].join("\n") });
		const item = line(planned, "models.default");
		expect(item?.action).toBe("skip");
		expect(item?.detail).toContain("no model here answers to that name");
		expect(writtenSettings(planned).model).toBeUndefined();
	});

	test("the other [models] keys are named with what this build does instead", () => {
		const planned = plan({
			"config.toml": ["[models]", 'hidden_models = ["x"]', 'web_search = "grok-4.6"', ""].join("\n"),
		});
		expect(line(planned, "models.hidden_models")?.detail).toContain("picker visibility only");
		expect(line(planned, "models.web_search")?.detail).toContain("search here is a tool call on the session model");
	});

	test("an existing provider of the same name is kept unless forced", () => {
		const tree = { "config.toml": ["[model.mine]", 'base_url = "https://api.example/v1"', ""].join("\n") };
		const existing = {
			providers: { openaiCompatible: [{ id: "mine", baseUrl: "https://kept.example/v1", apiKeyEnv: "K", models: [] }] },
		} as unknown as RawSettingsInput;
		const kept = plan(tree, existing);
		expect(line(kept, "model.mine")?.detail).toContain("kept");
		const forced = plan(tree, existing, true);
		const settings = writtenSettings(forced) as { providers?: { openaiCompatible?: Array<{ baseUrl: string }> } };
		expect(settings.providers?.openaiCompatible?.[0]?.baseUrl).toBe("https://api.example/v1");
	});
});
