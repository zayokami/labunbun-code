/**
 * What `scrubQoderCredentials` is allowed to delete, and what it is not.
 *
 * **The bug this file is written against, measured rather than argued.** The scrub
 * walked `settings.json` as one generic object and deleted every key whose *name*
 * contained `TOKEN`, `KEY`, `SECRET`, `PASSWORD` or `CREDENTIAL`
 * (`looksLikeSecretName`, a case-insensitive substring test). Under `mcpServers`
 * those keys are not slots holding a credential — they are the **names of servers
 * the user created**. On a settings file with seven servers named `plain`,
 * `secrets-vault`, `credential-helper`, `keyboard-mcp`, `monkey`, `keychain` and
 * `github-token`, only `plain` came back. Six servers were deleted, each with a
 * `skipped` line calling it a credential. None of the six carried one; a server
 * called `keyboard-mcp` is not a secret, and its `command` and `args` went with it.
 *
 * **It fails safe, which is why it survived.** Nothing leaked — the value of a real
 * credential is still dropped — but it silently destroys working user configuration
 * and reports it as hygiene, which is the worse failure of the two because a user
 * reading the report is told they had nothing there.
 *
 * **The line this file holds.** The scrub drops credential-shaped keys **inside**
 * an entry (`headers.authorization`, `env.API_TOKEN`) and never the entry's own
 * name. Both halves are asserted here, because either alone would pass against a
 * scrub that had simply stopped walking:
 *
 *   - a server named `secrets-vault` survives **with its command and args intact**,
 *     and reaches the written `.mcp.json` end to end;
 *   - `headers.authorization` inside that same server is still gone, and still
 *     produces its `skipped` line with the full path;
 *   - a real credential key under `env` is still gone by name.
 *
 * The map-shaped siblings are here for the same reason. The exemption is a set
 * derived from what the product's own merge treats as one level deep
 * (`QODER_MERGE_SHALLOW`) plus `hooks`, and every member has the same shape, so
 * every member is asserted: `providers`, `skillOverrides`, `enabledPlugins`,
 * `extraKnownMarketplaces` and `pluginConfigs` each lost a user-chosen name under
 * the same walk. `hooks` is the sharpest case, because `hGr` takes *any* key of
 * the block as an event name and never enumerates it — so `StopSessionSecret` is
 * a name the product would accept.
 *
 * **Every fixture is a temporary directory.** Nothing here reads a real install, a
 * real credential path, or anything under a user's home: `readQoder` takes `home`
 * and `env` as arguments and never calls `homedir()`, and every call passes an
 * explicit `env` so a developer's own `QODER_CONFIG_DIR` cannot leak in.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigration } from "../src/migrate.ts";
import { QODER_DEFAULT_DIR } from "../src/qoder-home.ts";
import { readQoder } from "../src/qoder-read.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	made.push(dir);
	return dir;
}

/** Write `content` at `<root>/<relative>`, creating the directories above it. */
function writeUnder(root: string, relative: string, content: string): void {
	const path = join(root, ...relative.split("/"));
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

interface QoderFixture {
	home: string;
	cwd: string;
}

/**
 * A home holding `~/.qoder/settings.json` carrying `settings`, and a separate
 * project directory so the project and local layers have somewhere to be absent.
 *
 * **The two trees are separate roots on purpose**, as in `migrate-qoder.test.ts`:
 * the layers live under `<home>/.qoder` and `<cwd>/.qoder`, so a fixture that put
 * both under one directory could not tell a scrub bug from a path bug.
 */
function qoderFixture(settings: unknown): QoderFixture {
	const home = makeDir("lbb-qoder-scope-home-");
	const cwd = makeDir("lbb-qoder-scope-proj-");
	writeUnder(home, `${QODER_DEFAULT_DIR}/settings.json`, JSON.stringify(settings));
	return { home, cwd };
}

/** The labels the scrub produced for a credential-shaped key. Names, never values. */
function credentialSkips(home: string, cwd: string): string[] {
	const raw = readQoder(home, cwd, {});
	return raw.skipped.filter((entry) => entry.reason.includes("looks like a credential")).map((entry) => entry.name);
}

// ---------------------------------------------------------------------------
// The server name is an identifier, not a credential
// ---------------------------------------------------------------------------

/**
 * The seven names from the measured report, minus the one that survived by
 * accident.
 *
 * **Each is here because the substring test catches it for a different reason**,
 * and a test that only used one would not know whether the exemption was keyed on
 * the substring or on the position: `secrets-vault` and `credential-helper` are
 * the obvious two, `keyboard-mcp` and `monkey` are the *substring* accidents
 * (`KEY` inside `keyboard` and inside `monkey`), `keychain` is the bare word, and
 * `github-token` is the `TOKEN` one. A regression that only exempted names
 * starting with a credential word would pass four of these five.
 */
const SERVER_NAMES: string[] = ["secrets-vault", "credential-helper", "keyboard-mcp", "monkey", "keychain"];

test.each(SERVER_NAMES)("an MCP server named %p survives readQoder", (name) => {
	const { home, cwd } = qoderFixture({
		mcpServers: { [name]: { command: "npx", args: ["-y", "demo"], cwd: "/tmp" } },
	});

	const raw = readQoder(home, cwd, {});
	const servers = raw.mcpServers as Record<string, Record<string, unknown>>;

	// Present, and whole: the assertion is on the entry's *contents*, so a scrub
	// that kept the name while emptying it would still be red here.
	expect(Object.keys(servers)).toContain(name);
	expect(servers[name]).toEqual({ command: "npx", args: ["-y", "demo"], cwd: "/tmp" });

	// And nothing claimed to have removed it. A surviving server that also carries
	// a "looks like a credential" line would mean the name came back by a path that
	// does not exist — the scrub deletes in place, so this is a cheap double check
	// that the label was never written.
	expect(
		raw.skipped.some((entry) => entry.name.endsWith(`.${name}`) && entry.reason.includes("looks like a credential")),
	).toBe(false);
});

test("every credential-shaped server name in one file survives at once", () => {
	// The measured case, whole: seven servers on one document. Asserted as a set so
	// the failure names which names went missing rather than which line tripped.
	const names = ["plain", ...SERVER_NAMES, "github-token", "passport"];
	const mcpServers: Record<string, unknown> = {};
	for (const name of names) mcpServers[name] = { command: `bin-${name}`, args: [] };

	const { home, cwd } = qoderFixture({ mcpServers });
	const raw = readQoder(home, cwd, {});

	expect(Object.keys(raw.mcpServers).sort()).toEqual([...names].sort());
	for (const name of names)
		expect((raw.mcpServers as Record<string, Record<string, unknown>>)[name]?.command).toBe(`bin-${name}`);
});

test("a credential-shaped server name still reaches the written .mcp.json", () => {
	// The end-to-end half. `planQoderMcp` iterates `raw.mcpServers`, so under the
	// bug a deleted server produced no write and no report line at all — the user
	// was told nothing had been lost, because as far as the plan was concerned there
	// had been nothing there. This is the assertion that fails loudest on a revert.
	const { home, cwd } = qoderFixture({
		mcpServers: {
			"keyboard-mcp": { command: "keyboard-bin", args: ["--stdio"] },
			"secrets-vault": { command: "vault-bin", args: [] },
		},
	});

	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const write = result.plan.writes.find((one) => one.kind === "mcp");
	const written = JSON.parse(write?.content ?? "{}").mcpServers;

	expect(written["keyboard-mcp"]).toEqual({ type: "stdio", command: "keyboard-bin", args: ["--stdio"] });
	expect(written["secrets-vault"]).toEqual({ type: "stdio", command: "vault-bin", args: [] });

	// A plain server beside them is unaffected either way, which is what makes the
	// per-entry check in the report worth asserting rather than assuming.
	for (const name of ["keyboard-mcp", "secrets-vault"]) {
		const item = result.plan.items.find((one) => one.to.includes(`mcpServers.${name}`));
		expect(item?.action).toBe("map");
	}
	expect(JSON.stringify(result.plan)).not.toContain("looks like a credential");
});

// ---------------------------------------------------------------------------
// Inside an entry, the scrub still runs
// ---------------------------------------------------------------------------

test("headers.authorization inside a surviving entry is still dropped, and still reported", () => {
	// The other half of the contract, and the one `planQoderMcp` depends on. The
	// server name being spared must not spare the server's contents: this key is a
	// slot, and it is one of the two the product's own MCP reader throws
	// MCP_CONFIG_STATIC_CREDENTIAL_FORBIDDEN for.
	const { home, cwd } = qoderFixture({
		mcpServers: {
			"keyboard-mcp": {
				command: "keyboard-bin",
				headers: { "x-team": "team-value", authorization: "auth-VALUE" },
			},
		},
	});

	const raw = readQoder(home, cwd, {});
	const entry = (raw.mcpServers as Record<string, Record<string, unknown>>)["keyboard-mcp"];

	// The entry survived; the header did not.
	expect(entry).toBeDefined();
	expect(entry.headers).toEqual({ "x-team": "team-value" });
	// The path carries the server name, so a report line points at the server whose
	// header went — which is the shape `migrate-qoder.test.ts` asserts as a suffix.
	expect(raw.skipped.some((line) => line.name.endsWith("mcpServers.keyboard-mcp.headers.authorization"))).toBe(true);
	// And the value is nowhere in the reader's output, under any spelling.
	expect(JSON.stringify(raw.mcpServers)).not.toContain("auth-VALUE");
});

test("a real credential key inside a server entry is still dropped by name", () => {
	// `looksLikeSecretName` catching `API_TOKEN` is the behaviour the exemption must
	// not have broken. It is an ordinary env variable name, not a server name, so it
	// is still a finding — and `planQoderMcp` reads `Object.keys(entry.env)` on the
	// strength of this having already happened.
	const { home, cwd } = qoderFixture({
		mcpServers: {
			"credential-helper": {
				command: "helper-bin",
				env: { API_TOKEN: "token-VALUE", DEMO_HOME: "/tmp" },
			},
		},
	});

	const raw = readQoder(home, cwd, {});
	const entry = (raw.mcpServers as Record<string, Record<string, unknown>>)["credential-helper"];

	expect((entry.env as Record<string, unknown>).API_TOKEN).toBeUndefined();
	expect(entry.env).toEqual({ DEMO_HOME: "/tmp" });
	expect(raw.skipped.some((line) => line.name.endsWith("mcpServers.credential-helper.env.API_TOKEN"))).toBe(true);
	expect(JSON.stringify(raw)).not.toContain("token-VALUE");

	// The server itself is still imported, and the report says which env names the
	// user has to set again — the names crossing over is what makes the drop usable.
	const result = runMigration({ home, cwd, from: "qoder", only: ["settings"], apply: false });
	const written = JSON.parse(result.plan.writes.find((one) => one.kind === "mcp")?.content ?? "{}").mcpServers;
	expect(written["credential-helper"]).toEqual({ type: "stdio", command: "helper-bin", args: [] });
	expect(JSON.stringify(result.plan)).toContain("DEMO_HOME");
	expect(JSON.stringify(result.plan)).toContain("API_TOKEN");
	expect(JSON.stringify(result.plan)).not.toContain("token-VALUE");
});

test("the top level is still scrubbed — the exemption is positional, not a blanket", () => {
	// A reader that simply stopped matching names would pass everything above and
	// stop being a guard. A key holding a credential at the document's own level is
	// still a finding, and `general` is not a map of user-chosen names, so the
	// exemption does not reach into it either.
	const { home, cwd } = qoderFixture({
		apiKey: "top-VALUE",
		general: { defaultPermissionMode: "ask", someKeyThing: "inner-VALUE" },
		mcpServers: { plain: { command: "plain-bin", env: { NESTED_SECRET: "deep-VALUE" } } },
	});

	const raw = readQoder(home, cwd, {});
	// A file that parsed is a document, so `settings` is not null here; the cast is
	// the narrowing the reader's own type demands rather than an assumption.
	const settings = raw.settings as Record<string, unknown>;
	const general = settings.general as Record<string, unknown>;
	const plainEnv = (raw.mcpServers.plain as Record<string, unknown>).env as Record<string, unknown>;

	expect(settings.apiKey).toBeUndefined();
	expect(general.someKeyThing).toBeUndefined();
	expect(plainEnv.NESTED_SECRET).toBeUndefined();

	const plan = JSON.stringify(raw);
	for (const value of ["top-VALUE", "inner-VALUE", "deep-VALUE"]) expect(plan).not.toContain(value);

	// The permission mode beside the dropped key is untouched: the scrub deletes one
	// key, not its container.
	expect(general.defaultPermissionMode).toBe("ask");
	expect(credentialSkips(home, cwd).some((name) => name.endsWith("apiKey"))).toBe(true);
});

// ---------------------------------------------------------------------------
// The same shape, elsewhere in the document
// ---------------------------------------------------------------------------

/**
 * The other five {@link QODER_MERGE_SHALLOW} keys, with a name each that the
 * substring test catches.
 *
 * **They were all measured losing the name before the fix** — a plugin called
 * `keystroke-mcp`, a provider called `my-key-store`, a skill override called
 * `keyboard-mcp`, a marketplace called `secret-market` and a plugin config called
 * `credential-helper` each disappeared whole, each with a "looks like a
 * credential" line. They are in one `test.each` because the exemption is one set
 * and a member added to it without a row here is a fix nobody has checked.
 */
// Rows rather than objects, as everywhere else in this directory: `test.each` takes
// a mutable table of tuples, and an object row is the difference between the test
// running and the file typechecking.
const MAP_SHAPED_SIBLINGS: [string, string, unknown][] = [
	["providers", "my-key-store", { baseUrl: "https://provider.invalid" }],
	["skillOverrides", "keyboard-mcp", { enabled: true }],
	["enabledPlugins", "keystroke-mcp", true],
	["extraKnownMarketplaces", "secret-market", "https://market.invalid"],
	["pluginConfigs", "credential-helper", { setting: "value" }],
];

test.each(MAP_SHAPED_SIBLINGS)("a user-chosen name under %s survives", (key, name, entry) => {
	const { home, cwd } = qoderFixture({ [key]: { [name]: entry } });

	const raw = readQoder(home, cwd, {});
	const container = (raw.settings as Record<string, unknown>)[key] as Record<string, unknown>;

	expect(Object.keys(container)).toContain(name);
	expect(container[name]).toEqual(entry);
	expect(
		raw.skipped.some((line) => line.name.endsWith(`${key}.${name}`) && line.reason.includes("looks like a credential")),
	).toBe(false);
});

test("a credential inside a provider entry is still dropped while the provider name is not", () => {
	// Both halves on one key, which is the point: the exemption is about *this
	// level's* names, not about the subtree. `providers` is one of the six the SDK
	// merges one level deep, and a BYOK provider's `apiKey` is exactly the shape the
	// scrub exists for.
	const { home, cwd } = qoderFixture({
		providers: {
			"my-key-store": { baseUrl: "https://provider.invalid", apiKey: "provider-VALUE" },
		},
	});

	const raw = readQoder(home, cwd, {});
	const provider = ((raw.settings as Record<string, unknown>).providers as Record<string, Record<string, unknown>>)[
		"my-key-store"
	];

	expect(provider.baseUrl).toBe("https://provider.invalid");
	expect(provider.apiKey).toBeUndefined();
	expect(raw.skipped.some((line) => line.name.endsWith("providers.my-key-store.apiKey"))).toBe(true);
	expect(JSON.stringify(raw)).not.toContain("provider-VALUE");
});

test("a hook event name that reads as a credential survives, handlers and all", () => {
	// `hooks` is the case the product makes sharpest: `hGr` takes **any** key of the
	// block as an event name and never enumerates it, so the name is the user's and
	// not one of a fixed eighteen. Deleting it took the whole handler array with it.
	// The event shape is Qoder's own — `{matcher?, hooks: [...]}` per group.
	const { home, cwd } = qoderFixture({
		hooks: {
			StopSessionSecret: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo secret-event" }] }],
			SessionKeyLoaded: [{ hooks: [{ type: "command", command: "echo key-event" }] }],
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
		},
	});

	const raw = readQoder(home, cwd, {});
	const hooks = raw.hooks as Record<string, unknown>;

	expect(Object.keys(hooks)).toEqual(["StopSessionSecret", "SessionKeyLoaded", "PreToolUse"]);
	// Not just the name: the group array and the handler inside it are the working
	// configuration a user would have to rewrite by hand.
	expect(JSON.stringify(hooks)).toContain("echo secret-event");
	expect(JSON.stringify(hooks)).toContain("echo key-event");
	expect(JSON.stringify(raw)).not.toContain("looks like a credential");
});
