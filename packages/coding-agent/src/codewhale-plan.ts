/**
 * Codewhale's user state in the target's shape: the permission posture, the
 * permission rules, the MCP servers, the skills, the instruction documents and
 * everything the reader saw that this importer will not carry.
 *
 * **The headline is that `sandbox_mode` needs no translation at all.**
 * `crates/config/src/lib.rs:3799-3804`:
 *
 * ```rust
 * pub const CONFIG_TOML_SANDBOX_MODES: &[&str] = &[
 *     "read-only", "workspace-write", "danger-full-access", "external-sandbox",
 * ];
 * ```
 *
 * Two of those three-and-a-bit are **byte-identical to this build's own
 * vocabulary** (`packages/agent/src/types.ts:49`: `SANDBOX_MODES =
 * ["workspace-write", "danger-full-access"]`). That is not a coincidence to be
 * waved at — it is the reason Codewhale is worth importing carefully: the
 * confinement axis maps 1:1 and the *approval* axis does not, so the pair has to
 * be read apart rather than taken as one value.
 *
 * **`approval_policy` has two vocabularies in two files, and only one of them is
 * `config.toml`'s.** `crates/config/src/lib.rs:3794-3796` gives the root key's
 * five: `on-request`, `untrusted`, `never`, `auto`, `suggest`. The doc comment on
 * `check_config_toml_choice` (`:3822-3825`) spells out the trap by name:
 * "`use-tui-default`, `ask`, `auto-review` and `full-access` are settings.toml
 * values for the /settings editor; **config.toml does not read them**." And
 * `settings_schema.rs:257-272` confirms which values the editor offers — and its
 * trailing comment is the load-bearing one: "`never` is a managed-policy value
 * only: it is accepted from config.toml and shown read-only, never offered by the
 * editor." So a migration that read `approval_policy` out of `settings.toml` with
 * `config.toml`'s table would map `ask` and `full-access` to nothing at all.
 *
 * **Two map, one maps to nothing, and the one that maps to nothing is the
 * dangerous one.** `AskForApproval` (`crates/execpolicy/src/lib.rs:209-227`) is
 * the type the policy resolves to:
 *
 * ```rust
 * UnlessTrusted,                       // trusted prefix skips the ask
 * OnFailure,                           // allow, and ask only after a failure
 * OnRequest,                           // always require approval
 * Reject { sandbox_approval, rules, mcp_elicitations },
 * Never,                               // never require approval; forbid what would need it
 * ```
 *
 *   - `auto` → `agent`. The loosest thing Codewhale has
 *     (`approval_policy_rank` at `crates/config/src/lib.rs:3873-3881` gives it 0,
 *     the loosest rank, and the doc above it says "Full Access is looser than
 *     every project policy, so its baseline is the loosest ranked policy
 *     (`auto`)"). The sandbox half is claimed from `sandbox_mode` rather than
 *     assumed — see {@link planCodewhaleModes}.
 *   - `on-request` / `untrusted` / `suggest` → `ask`. Three names for one posture;
 *     `approval_policy_rank` puts all three at 1 beside `suggested` and `deny`'s
 *     opposites, and the TUI's own bridge says so directly
 *     (`crates/tui/src/config.rs:4426-4434`: `"ask" | "suggest" | "on-request" |
 *     "untrusted" => Some("on-request")`).
 *   - `never` → **nothing.** `AskForApproval::Never` is "never require approval;
 *     forbid commands that would need it" — it never asks *and* denies what it
 *     will not approve. Nothing here does both: `ask` asks, `agent` runs. Mapping
 *     it to either would change what runs in one direction or the other, so it is
 *     named and skipped. Importing the absence would be safe and importing a
 *     guess would not.
 *   - `settings.toml`'s `ask` → `ask`, `full-access` → `agent` with the sandbox
 *     unconfined, `auto-review` and `use-tui-default` → nothing.
 *
 * **Nothing carries a credential, and the four shapes that could have are all
 * named.** `config.toml` holds them at `[providers.*].api_key` (a
 * credential-shaped key, caught by name), `[providers.*].base_url` (**a URL, and
 * a URL can carry one in its userinfo or query**), `[providers.*].http_headers`
 * (**the values are tokens under a key that is not credential-shaped**),
 * `[search].api_key`, `[vision_model].api_key`, `[lifecycle_outbox].webhook_token`,
 * and a top-level `sandbox_api_key`. The reader has already dropped every one of
 * them by the time this file runs; see {@link RawCodewhale.skipped}. Two more
 * channels are the MCP `headers` / `env` blocks and a `url` carrying a credential.
 */

import { join } from "node:path";
import type { PermissionMode, SandboxMode } from "@labunbun/agent";
import { McpServerConfigSchema } from "@labunbun/mcp";
import {
	CODEWHALE_DENIED_HOME_ENTRIES,
	CODEWHALE_IMPORT_CLAUDE,
	CODEWHALE_LEGACY_CONFIG_DIR_NAME,
	CODEWHALE_LEGACY_FALLBACK,
	CODEWHALE_MCP_CREDENTIAL_KEYS,
	CODEWHALE_MCP_SERVER_KEYS,
	CODEWHALE_MCP_SERVERS_KEY,
} from "./codewhale-home.ts";
import type { RawCodewhale } from "./codewhale-read.ts";
import {
	collectFileWrites,
	isRecord,
	normalizeClaudeHooks,
	planMemoryAsRule,
	reportUnhandledKeys,
	summarizeNames,
	tildePath,
	urlCredentialProblem,
} from "./migrate-core.ts";
import type {
	ClaimHooks,
	ClaimPermissionList,
	ClaimScalar,
	MigrationItem,
	MigrationSourceId,
	PlannedWrite,
} from "./migrate-types.ts";
import { resolveModelReference } from "./migrate-types.ts";

/**
 * This source's id, spelled once.
 *
 * The union and every table keyed by it live in `migrate-types.ts`; this is a
 * plain literal with no cast, and the only thing it buys is one spelling rather
 * than eleven. **The call lives in `migrate.ts`** — see that file's arm for
 * `codewhale`, which is where this planner is actually reached from.
 */
const SOURCE: MigrationSourceId = "codewhale";

/**
 * `config.toml`'s `approval_policy` → this build's permission mode.
 *
 * **Only the `config.toml` vocabulary appears here, and that is the point.**
 * `CONFIG_TOML_APPROVAL_POLICIES` (`crates/config/src/lib.rs:3794-3796`) is
 * `["on-request", "untrusted", "never", "auto", "suggest"]`; the four values the
 * `settings.toml` editor uses (`use-tui-default`, `ask`, `auto-review`,
 * `full-access`) are a **different** table and the product says in as many words
 * that `config.toml` does not read them
 * (`crates/config/src/lib.rs:3822-3825`). Two tables rather than one merged list
 * is the difference between a mapping and a guess.
 *
 * The second table is {@link CODEWHALE_SETTINGS_APPROVAL_POLICIES}.
 *
 * **`never` maps to nothing on purpose**, and it is the only member of the
 * five that does. See the header: `AskForApproval::Never` denies what it will not
 * approve, and neither `ask` nor `agent` does both.
 *
 * Exported for the row count, not for the values: a row added here without a line
 * in the mapper test's table is an import whose claim nobody has checked.
 */
export const CODEWHALE_APPROVAL_POLICIES: Record<string, PermissionMode | undefined> = {
	auto: "agent",
	"on-request": "ask",
	untrusted: "ask",
	suggest: "ask",
	never: undefined,
};

/**
 * `settings.toml`'s `approval_policy` → this build's permission mode.
 *
 * `crates/config/src/settings_schema.rs:257-272`, the four `SettingOption`s the
 * `/settings` editor offers. **`use-tui-default` and `auto-review` map to
 * nothing:**
 *
 *   - `use-tui-default` is the *absence* of a choice, so importing it would write
 *     a posture the user never stated;
 *   - `auto-review` is a classifier that approves the calls it judges routine
 *     (`crates/tui/src/config.rs:4426-4434` groups it with `auto`), and no mode
 *     here does that — `ask` puts a person in the loop and `agent` runs everything.
 */
export const CODEWHALE_SETTINGS_APPROVAL_POLICIES: Record<string, PermissionMode | undefined> = {
	ask: "ask",
	"full-access": "agent",
	"auto-review": undefined,
	"use-tui-default": undefined,
};

/**
 * `config.toml`'s `sandbox_mode` → this build's sandbox, and what to do about the
 * one value with no counterpart.
 *
 * **Two of the four map 1:1**, because `SANDBOX_MODES` here
 * (`packages/agent/src/types.ts:49`) and `CONFIG_TOML_SANDBOX_MODES` there are the
 * same two strings. The other two do not:
 *
 *   - `read-only` — **nothing.** This build has no read-only sandbox; the two
 *     values are `workspace-write` and `danger-full-access`. Claiming
 *     `workspace-write` for it would **widen** a confinement setting on the
 *     user's behalf, and widening is the one direction a migration must not move
 *     in on its own judgement. A user who wants it sets `/mode` after.
 *   - `external-sandbox` — **nothing**, and for a second reason: it routes
 *     `exec_shell` through an external backend's HTTP API at `sandbox_url` with a
 *     bearer token (`crates/tui/src/config.rs:3137-3141`), and this build has no
 *     such backend. There is nothing to point it at.
 */
export const CODEWHALE_SANDBOX_MODES: Record<string, SandboxMode | undefined> = {
	"workspace-write": "workspace-write",
	"danger-full-access": "danger-full-access",
	"read-only": undefined,
	"external-sandbox": undefined,
};

/** The whole `config.toml` sandbox vocabulary, so a report can name a value's rank. */
export const CODEWHALE_CONFIG_SANDBOX_VALUES: readonly string[] = [
	"read-only",
	"workspace-write",
	"danger-full-access",
	"external-sandbox",
];

/**
 * Top-level keys of `config.toml` this mapper accounts for.
 *
 * Read against the reader's header: `providers` is walked for its
 * `base_url`, `model` and `context_window`; `approval_policy` and `sandbox_mode`
 * are the mode pair; `model` and `default_text_model` are the model. Everything
 * else is named by the closing aggregate line rather than silently left behind.
 */
const CODEWHALE_CONFIG_HANDLED = new Set([
	"providers",
	"approval_policy",
	"sandbox_mode",
	"model",
	"default_text_model",
	"custom_models",
]);

/** Keys of `settings.toml` this mapper accounts for. See the two tables above. */
const CODEWHALE_SETTINGS_HANDLED = new Set(["approval_policy", "default_provider", "model", "theme"]);

/**
 * Why `approval_policy` produced no mode, per value.
 *
 * Each of these is a sentence rather than a flag because each is a different
 * reason, and a report that printed the same four words for all of them would be
 * indistinguishable from an importer that had not tried.
 */
const CODEWHALE_APPROVAL_REASONS: Record<string, string> = {
	never:
		'"never" is Codewhale\'s far end and it does two things at once: `AskForApproval::Never` never requires approval *and* forbids the commands that would have needed one. ' +
		'Nothing here does both — "ask" asks and "agent" runs — so claiming either would change which commands run rather than only how often they are checked. The posture is left as it is; set it with /mode',
	"auto-review":
		'"auto-review" is a classifier that approves the calls it judges routine, and no mode here does that: "ask" puts a person in the loop and "agent" runs everything. Either would change the posture the setting names',
	"use-tui-default":
		'"use-tui-default" is the absence of a choice — it means "use whatever the TUI would have used" — so importing it would write a posture the user never stated. The session starts as it otherwise would',
	default:
		"not a value Codewhale's config.toml accepts, so it never decided a session here; the approval policy is left as it is",
};

/** Why `sandbox_mode` produced no sandbox, per value. */
const CODEWHALE_SANDBOX_REASONS: Record<string, string> = {
	"read-only":
		'"read-only" is the *tightest* confinement Codewhale has, and this build has no read-only sandbox — its two values are "workspace-write" and "danger-full-access". ' +
		"Claiming the nearest one would widen a confinement setting on the user's behalf, which is the one direction a migration must not move in on its own judgement, so nothing was claimed",
	"external-sandbox":
		'"external-sandbox" routes exec_shell through a separate backend\'s HTTP API at its own `sandbox_url` with a bearer token, and this build has no such backend to point it at. ' +
		"The nearest sandbox here is not the same decision, so nothing was claimed",
	default:
		"not a value Codewhale's config.toml accepts, so it never confined anything here; the sandbox is left as it is",
};

/**
 * The two mode axes, read apart and claimed together.
 *
 * **Both halves come from separate keys, and neither is claimed alone.** This is
 * the property `claimModePair` exists to enforce, and it is enforced here by hand
 * for the reason given at the claim site: Codewhale states `approval_policy` and
 * `sandbox_mode` as two independent root keys
 * (`crates/config/src/lib.rs:927-928`), so a `claimModePair` call would put one
 * sentence about a single value onto both report lines and both would be wrong.
 * `antigravity-plan.ts` makes exactly this call for exactly this reason.
 *
 * **Which sandbox an `auto` approval policy gets is a real question and this is
 * the answer.** `auto` is Codewhale's loosest policy and the file may say nothing
 * about confinement at all. Claiming `agent` alone would leave a session that
 * auto-approves everything inside a workspace sandbox — a combination no user
 * chose — so when `sandbox_mode` is absent **neither** key is claimed. That is the
 * `t3-plan.ts` argument: writing the strictest posture because the schema would
 * have supplied it is the fail-open failure, and so is writing the loosest.
 */
function planCodewhaleModes(raw: RawCodewhale, items: MigrationItem[], claimScalar: ClaimScalar): void {
	const config = raw.config;
	const settings = raw.settings;
	const from = `${tildePath(raw.home, raw.configPath)} → approval_policy + sandbox_mode`;

	const approval = config !== null ? config.approval_policy : undefined;
	const sandbox = config !== null ? config.sandbox_mode : undefined;
	// `settings.toml`'s own vocabulary, which is a *different* table — see the
	// header. It is only consulted when `config.toml` said nothing, because the
	// two files are two documents rather than one merge and `config.toml` is the
	// one that names the value in the table this planner checks.
	const settingsApproval = settings !== null ? settings.approval_policy : undefined;

	const policy =
		typeof approval === "string" ? approval : typeof settingsApproval === "string" ? settingsApproval : undefined;
	const mode =
		typeof approval === "string"
			? CODEWHALE_APPROVAL_POLICIES[approval.trim().toLowerCase()]
			: typeof settingsApproval === "string"
				? CODEWHALE_SETTINGS_APPROVAL_POLICIES[settingsApproval.trim().toLowerCase()]
				: undefined;

	if (mode === undefined) {
		if (policy !== undefined) {
			items.push({
				source: SOURCE,
				from:
					typeof approval === "string"
						? `${tildePath(raw.home, raw.configPath)} → approval_policy`
						: `${tildePath(raw.home, raw.settingsPath)} → approval_policy`,
				to: "—",
				action: "skip",
				detail: `${CODEWHALE_APPROVAL_REASONS[policy.trim().toLowerCase()] ?? CODEWHALE_APPROVAL_REASONS.default} (read as "${policy}")`,
				containsSecret: false,
			});
		}
		return;
	}

	if (sandbox === undefined) {
		items.push({
			source: SOURCE,
			from,
			to: "—",
			action: "skip",
			detail:
				`the permission mode maps to "${mode}" here, but the file states no sandbox_mode, and the two are one decision in this build — importing the mode alone would ` +
				"leave a session that auto-approves everything inside a sandbox the user never asked for. Neither half was claimed; set the pair with /mode",
			containsSecret: false,
		});
		return;
	}

	const sandboxValue = CODEWHALE_SANDBOX_MODES[typeof sandbox === "string" ? sandbox.trim().toLowerCase() : ""];
	if (typeof sandbox !== "string") {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.configPath)} → sandbox_mode`,
			to: "—",
			action: "skip",
			detail: "sandbox_mode is not a string, so the confinement it describes could not be read",
			containsSecret: false,
		});
		return;
	}
	if (sandboxValue === undefined) {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.configPath)} → sandbox_mode`,
			to: "—",
			action: "skip",
			detail: `${CODEWHALE_SANDBOX_REASONS[sandbox.trim().toLowerCase()] ?? CODEWHALE_SANDBOX_REASONS.default} (read as "${sandbox}")`,
			containsSecret: false,
		});
		return;
	}

	// **Claimed per field, not through `claimModePair`, and the reason is the same
	// one `antigravity-plan.ts` gives for the same decision.** `claimModePair` writes
	// one shared detail onto both keys, and it is written for a source that has *one*
	// value doing two jobs: its sandbox note says either "the source's mode also meant
	// no confinement" or "the source had no separate confinement setting". **Codewhale
	// has two separate root keys for this** — `approval_policy` and `sandbox_mode`, both
	// attested in `ConfigToml` (`crates/config/src/lib.rs:927-928`) — so both of those
	// sentences would be false here, and a report line is not the place to be
	// approximately right about where a confinement setting came from.
	//
	// What `claimModePair` buys — that a mode cannot be written without a sandbox
	// beside it — is kept, and it is enforced above: when `sandbox_mode` is absent
	// **neither** key is claimed.
	// **Labelled with the file the value is in, not the one the pair usually is.**
	// `settings.toml` carries a posture of its own and a report line pointing at
	// `config.toml` for a value that is not in it sends the user to the wrong file.
	const modeFrom =
		typeof approval === "string"
			? `${tildePath(raw.home, raw.configPath)} → approval_policy`
			: `${tildePath(raw.home, raw.settingsPath)} → approval_policy`;
	claimScalar(
		SOURCE,
		"permissionMode",
		mode,
		modeFrom,
		mode === "agent"
			? 'mapped to "agent": `auto` is Codewhale\'s loosest policy and `approval_policy_rank` gives it the loosest rank, so it is the one that approves without asking. ' +
					"It is claimed **together with** the sandbox below and never alone — a session that auto-approves everything inside a sandbox the user never chose is a combination nobody stated"
			: 'mapped to "ask": Codewhale\'s three names for one posture (`on-request`, `untrusted`, `suggest`) all mean the approval card is shown, which is what this mode is. ' +
					"It is claimed **together with** the sandbox below and never alone",
	);
	claimScalar(
		SOURCE,
		"sandbox",
		sandboxValue,
		`${tildePath(raw.home, raw.configPath)} → sandbox_mode`,
		`taken from Codewhale's own sandbox_mode, which this build spells the same way: ${CODEWHALE_CONFIG_SANDBOX_VALUES.join(", ")}. ` +
			"It is a separate key here — change it and the mode is untouched, which is the same relationship the two had in config.toml",
	);
}

/**
 * `config.toml`'s model → this build's `model`.
 *
 * **`default_text_model` is read only when `model` is absent**, and the reason is
 * a doc comment rather than a guess: `default_text_model` is described as the
 * "TUI-compatible default DeepSeek model" (`crates/config/src/lib.rs:888`) while
 * `model` is the root selector. An install that set both means both, and the root
 * one is the closer analogue of what this build stores — so it wins and the other
 * is named.
 *
 * **A model that resolves to nothing here is reported, not written.**
 * `resolveModelReference` is the shared check and a model this build does not
 * carry becomes a reported skip rather than a `model` value that would fail at
 * the first request.
 */
function planCodewhaleModel(raw: RawCodewhale, items: MigrationItem[], claimScalar: ClaimScalar): void {
	if (raw.config === null) return;
	const label = tildePath(raw.home, raw.configPath);
	const model = raw.config.model;
	const fallback = raw.config.default_text_model;
	const value = typeof model === "string" && model.trim() !== "" ? model : undefined;
	if (value === undefined) {
		if (typeof fallback === "string" && fallback.trim() !== "") {
			items.push({
				source: SOURCE,
				from: `${label} → default_text_model`,
				to: "—",
				action: "skip",
				detail:
					`"${fallback}" was not imported: Codewhale documents this key as the TUI-compatible *default* rather than the selected model, and the root \`model\` key is the one this build stores. ` +
					"Set the model here with /model",
				containsSecret: false,
			});
		}
		return;
	}
	const resolved = resolveModelReference(value);
	if (resolved === undefined) {
		items.push({
			source: SOURCE,
			from: `${label} → model`,
			to: "—",
			action: "skip",
			detail: `"${value}" is a model this build does not carry, so nothing was written — set the model here with /model`,
			containsSecret: false,
		});
		return;
	}
	claimScalar(SOURCE, "model", resolved, `${label} → model`, "taken from Codewhale's root `model` selector");
}

/**
 * `permissions.toml`'s rules → this build's permission lists.
 *
 * **The document is small and typed, which is unusual enough to be worth saying.**
 * `PermissionsToml` (`crates/config/src/lib.rs:625-630`) is
 * `{ rules: Vec<ToolAskRule> }` and `ToolAskRule`
 * (`crates/execpolicy/src/lib.rs:112-137`) is six fields, none of them a
 * credential — so unlike everything else in `config.toml` this file is carried
 * whole.
 *
 * **Three of the six fields have no counterpart here and each costs a rule:**
 *
 *   - `action = "ask"` — the forced-approval rule. This build's permission lists
 *     are `allow` and `deny`; there is no "always ask" list, so an ask rule would
 *     have to become an allow rule (widening) or a deny rule (narrowing past what
 *     the user wrote). Neither is the rule they wrote.
 *   - `tool` — the rule names a Codewhale tool (`exec_shell`, `edit_file`), and
 *     this build's rule grammar has no tool field: a rule is matched on the
 *     command line. A rule with **no** `command` therefore has nothing to match
 *     on and is dropped.
 *   - `workspace` — pins a rule to one repo. This build's rules are global, so a
 *     workspace-scoped rule imported as global would apply everywhere, which is a
 *     widening.
 *
 * **`command_exact` is the subtle one and it goes the safe way.**
 * `crates/execpolicy/src/lib.rs:120-122`: "Approval-card remembered grants set
 * this so approving one safe command cannot silently authorize a later invocation
 * with extra arguments." A prefix rule for `git status` matches `git status --amend`
 * here; an exact rule does not. So an **exact** rule is imported as its own text
 * and reported as narrower-or-equal, while a rule with a `path` but no `command`
 * has no command text at all and is named.
 */
function planCodewhalePermissions(
	raw: RawCodewhale,
	items: MigrationItem[],
	claimPermissionList: ClaimPermissionList,
): void {
	if (raw.permissions === null) return;
	const label = tildePath(raw.home, raw.permissionsPath);
	const allow: string[] = [];
	const deny: string[] = [];
	const notes: string[] = [];
	let asked = 0;
	let scoped = 0;
	let withoutCommand = 0;
	let pathOnly = 0;
	let unknownAction = 0;

	for (const rule of raw.permissions) {
		if (rule.action === "ask") {
			asked += 1;
			continue;
		}
		if (rule.action === "other") {
			unknownAction += 1;
			continue;
		}
		if (rule.workspace !== undefined) {
			scoped += 1;
			continue;
		}
		if (rule.command === undefined || rule.command === "") {
			withoutCommand += 1;
			if (rule.path !== undefined) pathOnly += 1;
			continue;
		}
		(rule.action === "deny" ? deny : allow).push(rule.command);
	}

	if (allow.length > 0) {
		claimPermissionList(
			SOURCE,
			"allow",
			allow,
			`${label} → rules`,
			`${allow.length} of ${raw.permissions.length} rule(s) copied. A Codewhale rule names a tool and a command prefix; this build's rule matches the whole command line, so a chained \`git commit && …\` counts as a match too` +
				(notes.length > 0 ? `; ${summarizeNames([...new Set(notes)])}` : ""),
		);
	}
	if (deny.length > 0) {
		claimPermissionList(
			SOURCE,
			"deny",
			deny,
			`${label} → rules`,
			`${deny.length} of ${raw.permissions.length} rule(s) copied. A Codewhale rule names a tool and a command prefix; this build's rule matches the whole command line, so a chained \`git commit && …\` counts as a match too` +
				(notes.length > 0 ? `; ${summarizeNames([...new Set(notes)])}` : ""),
		);
	}

	const losses = [
		asked > 0
			? `${asked} \`ask\` rule(s) — a forced-approval rule. This build's permission lists are allow and deny; there is no "always ask" list, so importing one as an allow would widen it and as a deny would narrow it past what you wrote`
			: null,
		scoped > 0
			? `${scoped} workspace-scoped rule(s) — a rule pinned to one repository by its \`workspace\` field. This build's rules are global, so importing one would apply it in every project`
			: null,
		withoutCommand > 0
			? `${withoutCommand} rule(s) with no command to match on${pathOnly > 0 ? ` (${pathOnly} of them path-only, which is the other way to say "this file", and this build's rule grammar has no path field)` : ""}`
			: null,
		unknownAction > 0 ? `${unknownAction} rule(s) with an action Codewhale's own schema does not define` : null,
	].filter((entry): entry is string => entry !== null);
	if (losses.length > 0) {
		items.push({
			source: SOURCE,
			from: `${label} → rules`,
			to: "—",
			action: "downgrade",
			detail: `${raw.permissions.length} rule(s) read, ${allow.length + deny.length} of them copied: ${losses.join("; ")}`,
			containsSecret: false,
		});
	}
}

/**
 * One MCP server from `mcp.json`'s `servers` → this build's server shape.
 *
 * **The transport is decided the way the product's own fields describe it.**
 * `McpServerConfig` (`crates/tui/src/mcp.rs:562-658`) has both `command: Option<String>`
 * and `url: Option<String>` with **no `#[serde(rename_all)]`**, so both spellings
 * are the bare names. Three cases:
 *
 *   - `command` present → stdio, `args`/`env`/`cwd` alongside it. An **empty**
 *     `command` string still selects stdio, because the field is an `Option<String>`
 *     and `Some("")` is a value; reading "absent when empty" would reclassify a
 *     malformed entry as a transport-less one and give the wrong reason.
 *   - `url` present, `command` absent → HTTP, with `transport` deciding between
 *     streamable HTTP and legacy SSE. `crates/tui/src/mcp.rs:578-582` says the
 *     default is Streamable HTTP with an SSE fallback, and `transport: "sse"`
 *     forces the legacy one.
 *   - both, or neither → named, because picking one would be picking for it.
 *
 * **`disabled` and `enabled` are both real and independent** (`:594`, `:596`, with
 * `enabled` defaulting to `true`). `disabled: true` is the switch-off and the
 * server is not imported — importing a server the user turned off would add one to
 * the target that they had deliberately removed.
 *
 * **Every credential channel is dropped and the names reported**, and none of the
 * values reaches this function: the reader has already deleted them and written
 * one `skipped` line per name. See {@link CODEWHALE_MCP_CREDENTIAL_KEYS}.
 * `env_headers` is the fourth and it is the mildest: the file holds an environment
 * variable *name*, and this build's server config has no field for that either.
 *
 * **A `url` carrying a credential loses the whole server**, for the reason
 * `qoder-plan.ts` argues at length: a URL with its userinfo or its
 * `?access_token=` removed is a *different URL* that points at nothing.
 */
function planCodewhaleMcp(
	raw: RawCodewhale,
	items: MigrationItem[],
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	if (!raw.mcpPresent) return;
	const label = tildePath(raw.home, raw.mcpPath);
	for (const [name, entry] of Object.entries(raw.mcpServers)) {
		const from = `${label} → ${CODEWHALE_MCP_SERVERS_KEY}.${name}`;
		if (!isRecord(entry)) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: "not a server table",
				containsSecret: false,
			});
			continue;
		}

		if (entry.disabled === true) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"Codewhale has this server switched off (`disabled: true`). Importing it would add a server to the target's configuration that the user had turned off in Codewhale, so it was left out — turn it on here with /mcp if you want it",
				containsSecret: false,
			});
			continue;
		}
		if (entry.enabled === false) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"Codewhale has this server switched off (`enabled: false` — the field defaults to true, so an explicit false is the switch). It was left out for the same reason `disabled` is",
				containsSecret: false,
			});
			continue;
		}

		const hasCommand = typeof entry.command === "string";
		const command = hasCommand ? (entry.command as string).trim() : "";
		const url = typeof entry.url === "string" ? entry.url.trim() : "";

		if (!hasCommand && url === "") {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"it names neither a `command` nor a `url`, which are the two transports Codewhale's own `McpServerConfig` accepts — so this entry was not a working server there either",
				containsSecret: false,
			});
			continue;
		}
		if (hasCommand && url !== "") {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail:
					"it names both a `command` and a `url`. Codewhale's config is a struct with both as independent `Option<String>` and no rule that picks one, so choosing a transport for it would be choosing for it",
				containsSecret: false,
			});
			continue;
		}

		if (!hasCommand && url !== "") {
			const problem = urlCredentialProblem(url);
			if (problem !== null) {
				items.push({
					source: SOURCE,
					from,
					to: "—",
					action: "skip",
					detail:
						`left off, because ${problem} — unlike a header or an environment variable there is no way to drop the credential and keep the address, so nothing was written; ` +
						"add the server again here with the credential in your environment instead",
					containsSecret: true,
				});
				continue;
			}
		}

		const downgrades: string[] = [];
		const config: Record<string, unknown> = {};
		if (hasCommand) {
			const args = Array.isArray(entry.args) ? entry.args : [];
			const strings = args.filter((arg): arg is string => typeof arg === "string");
			if (strings.length !== args.length) {
				downgrades.push(`${args.length - strings.length} argument(s) that were not strings, dropped`);
			}
			if (entry.args !== undefined && !Array.isArray(entry.args)) {
				downgrades.push("its `args` was not an array, so none was read");
			}
			config.type = "stdio";
			config.command = command;
			config.args = strings.slice(0, 256);
			if (typeof entry.cwd === "string") {
				// A `cwd` written on another machine means a different directory here,
				// and Codewhale's field is a `PathBuf` it resolves against its own
				// working directory (`mcp.rs:569-571`), so a relative value is one
				// whose meaning depends on where it was written. Absolute only.
				if (isAbsolutePath(entry.cwd)) config.cwd = entry.cwd;
				else
					downgrades.push(
						`its relative cwd was left off — ${summarizeNames([entry.cwd])} means a different directory on each machine, and an absolute path is the only spelling that survives the move`,
					);
			}
		} else {
			config.type = "http";
			config.url = url;
			const transport = typeof entry.transport === "string" ? entry.transport : "";
			if (transport === "sse") {
				downgrades.push(
					'Codewhale spells this transport "sse" and this build has one HTTP client, so it connects the same way',
				);
			} else if (transport !== "" && transport !== "http" && transport !== "streamable-http") {
				downgrades.push(
					`its \`transport\` of ${summarizeNames([transport])} is not one Codewhale documents for this field, so it was read as a plain HTTP server`,
				);
			}
			// Three per-server timeouts (`connect_timeout`, `execute_timeout`,
			// `read_timeout`, `mcp.rs:588-592`) and a container-level `timeouts` block
			// (`:513`). This build's server config has no field for any of them.
			const timeouts = ["connect_timeout", "execute_timeout", "read_timeout"].filter(
				(field) => typeof entry[field] === "number",
			);
			if (timeouts.length > 0) {
				downgrades.push(
					`its ${summarizeNames(timeouts)} left off — this build's server config has no field for a per-server timeout`,
				);
			}
		}

		if (entry.required === true) {
			downgrades.push(
				"its `required` flag was left off — it marks a server whose failure should stop startup here, and this build has no per-server required flag",
			);
		}
		const tools = ["enabled_tools", "disabled_tools"].filter((field) => {
			const value = entry[field];
			return Array.isArray(value) && value.length > 0;
		});
		if (tools.length > 0) {
			downgrades.push(
				`its ${summarizeNames(tools)} left off — this build's server config exposes every tool a server offers, with no allow/deny list`,
			);
		}
		if (entry.allow_private_network === true) {
			downgrades.push(
				"its `allow_private_network` grant was left off — that is explicit operator authority for a private DNS name at one origin, and this importer does not carry an authority grant it cannot check",
			);
		}

		// The credential blocks. Their values are already gone; the names were
		// reported by the reader, so this is the sentence that says what that cost.
		// `env` in particular survives the scrub as a table of *names* whose values
		// were dropped, so counting it here is not a re-check.
		if (isRecord(entry.env) && Object.keys(entry.env).length > 0) {
			downgrades.push(
				`left off ${Object.keys(entry.env).length} environment variable(s) (${summarizeNames(Object.keys(entry.env))}) — the names came across in this report, the values did not, so a server that needs a secret has to have it set again here`,
			);
		}
		for (const field of ["headers", "env_headers", "env_http_headers", "bearer_token_env_var"]) {
			if (!isRecord(entry[field]) && entry[field] === undefined) continue;
			if (isRecord(entry[field]) && Object.keys(entry[field]).length === 0) continue;
			if (field === "bearer_token_env_var") {
				downgrades.push("its `bearer_token_env_var` was left off — this build's server config has no field for it");
				continue;
			}
			downgrades.push(
				`left off ${summarizeNames([field])} — ${field === "headers" ? "a header value is an ordinary place for a bearer token, and Codewhale's own comment says a token stored there lives in plain text in mcp.json" : "the values are read from the environment at request time, and this build's server config has no field for that indirection"}`,
			);
		}

		if (!McpServerConfigSchema.safeParse(config).success) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: hasCommand
					? "its command, arguments or working directory are not a stdio server definition this build accepts"
					: "its URL is not an address this build's MCP client accepts",
				containsSecret: false,
			});
			continue;
		}

		const extra = Object.keys(entry).filter((key) => !CODEWHALE_MCP_SERVER_KEYS.includes(key));
		if (extra.length > 0) {
			downgrades.push(
				`left off ${summarizeNames(extra)} — not one of the ${CODEWHALE_MCP_SERVER_KEYS.length} fields Codewhale's own \`McpServerConfig\` has`,
			);
		}

		if (name in existingMcpServers && !force) {
			items.push({
				source: SOURCE,
				from,
				to: "—",
				action: "skip",
				detail: "target already defines a server with this name — kept (use --force to overwrite)",
				containsSecret: false,
			});
			continue;
		}

		// Nothing credential-shaped was copied, so this is never true for an entry
		// Codewhale accepted. It is computed rather than assumed so that a future
		// change which *did* start copying a value has to make this turn true on
		// purpose.
		const secret = false;
		mcpServers[name] = config;
		markMcpSecret(secret);
		items.push({
			source: SOURCE,
			from,
			to: `~/.labunbun/.mcp.json → mcpServers.${name}`,
			action: downgrades.length > 0 ? "downgrade" : "map",
			detail:
				downgrades.length > 0
					? `copied without its credentials — ${downgrades.join("; ")}`
					: "copied without its credentials",
			containsSecret: secret,
		});
	}
}

/**
 * Codewhale's `HookEvent` names, and the ones this build has a hook for.
 *
 * `HookEvent` is `#[serde(rename_all = "snake_case")]`
 * (`crates/tui/src/hooks/config.rs:26-27`) and `ALL_HOOK_EVENTS` (`:81-97`)
 * declares **fifteen** of them; `as_str` (`:117-135`) is the persisted spelling
 * and the two agree exactly. Seven of the fifteen have a counterpart here and
 * nine do not, and the nine are the interesting half: a hook under an event this
 * build does not fire would be imported and never run, which is a silent loss
 * dressed as a successful migration.
 *
 * **The nine are spelled out rather than left to a default branch**, so the
 * table's shape says "this is the whole list" and a variant added upstream is a
 * diff here rather than a silent no-op.
 *
 * Exported for the row count, for the same reason
 * {@link CODEWHALE_APPROVAL_POLICIES} is.
 */
export const CODEWHALE_HOOK_EVENTS: Record<string, string | undefined> = {
	session_start: "SessionStart",
	session_end: "SessionEnd",
	message_submit: "UserPromptSubmit",
	tool_call_before: "PreToolUse",
	tool_call_after: "PostToolUse",
	turn_end: "Stop",
	on_error: undefined,
	mode_change: undefined,
	subagent_spawn: undefined,
	subagent_complete: undefined,
	shell_env: undefined,
	session_idle: undefined,
	session_error: undefined,
	waiting_for_user: undefined,
	session_busy: undefined,
};

/** The event names Codewhale fires, verbatim — fifteen, and the table above must match. */
export const CODEWHALE_HOOK_EVENT_NAMES: readonly string[] = Object.keys(CODEWHALE_HOOK_EVENTS);

/** The seven of {@link CODEWHALE_HOOK_EVENT_NAMES} this build fires, by Codewhale's spelling. */
export const CODEWHALE_HOOK_EVENTS_THIS_BUILD_RUNS: readonly string[] = CODEWHALE_HOOK_EVENT_NAMES.filter(
	(name) => CODEWHALE_HOOK_EVENTS[name] !== undefined,
);

/**
 * `[hooks]` → this build's hook config, through the shared normalizer.
 *
 * **The block is reassembled into the Claude shape rather than reimplemented**,
 * because `normalizeClaudeHooks` is the thing that knows this build's event names
 * and how it clamps a timeout. Codewhale's entry is already very close — an event,
 * a shell command, an optional condition, a timeout — and what it has that this
 * build's entry does not is `background` and `continue_on_error`.
 *
 * **`background` is dropped** and this is the safe direction: this build's handler
 * has no such field, so an imported hook runs synchronously and the turn waits.
 *
 * **`continue_on_error` is dropped, and that is a widening**, so it is counted and
 * said rather than left implicit: this build always continues past a failing hook,
 * so a Codewhale hook that set the flag to `false` — which meant "abort the turn" —
 * becomes one that does not. The count is what keeps the tally honest.
 *
 * **`condition` decides importability, and it is the sharpest field here.**
 * `HookCondition` (`crates/tui/src/hooks/config.rs:217`) is `Always`, `ToolName
 * { name }`, `ToolCategory { category }`, `Mode { mode }` and `ExitCode { code }`:
 *
 *   - `always` (and an absent condition) maps onto "no matcher" and imports;
 *   - `tool_name` maps onto this build's **matcher**, which is what a matcher is;
 *   - `exit_code`, `tool_category` and `mode` are **skipped, not approximated**. A
 *     matcher is a subject pattern; "only when the exit code was 2" is a different
 *     predicate, and `tool_category` / `mode` name Codewhale's own taxonomies
 *     (`"safe"`, `"file_write"`, `"shell"`; `"plan"`, `"agent"`, `"yolo"`) whose
 *     meanings are not written down anywhere this build can check.
 *
 * **A hook skipped for its condition is reported rather than dropped**, because an
 * imported hook running on the wrong predicate is worse than one that never came
 * across.
 *
 * **`[hooks].enabled = false` switches the whole table off and nothing is
 * imported.** A user who turned their hooks off has hooks that are off; importing
 * them would add a behaviour they deliberately removed.
 */
function planCodewhaleHooks(raw: RawCodewhale, items: MigrationItem[], claimHooks: ClaimHooks): void {
	// **Two maps rather than one list of a union type**, and the reason is that the
	// two shapes land in different places in the Claude-shaped document: a
	// matcher-less handler goes in a group with no `matcher`, and a tool-scoped one
	// needs a group of its own carrying the matcher. Keeping them apart means neither
	// shape is ever cast to the other, which is what an earlier draft of this
	// function did and what TypeScript correctly refused.
	const plain = new Map<string, Array<{ command: string; timeout?: number }>>();
	const matched = new Map<string, Array<{ matcher: string; hooks: Array<{ command: string; timeout?: number }> }>>();
	const dropped: string[] = [];
	const downgrades: string[] = [];
	const sources: string[] = [];
	const label = () => sources.join(", ");
	let total = 0;

	// **The one sentence for a hook this build cannot run, written once.** A closure
	// rather than a helper taking `items`: both call sites already have the array in
	// scope, and a module-level sink for one push would be mutable state shared by
	// every source in the run.
	const reportDropped = (): void => {
		if (dropped.length === 0) return;
		items.push({
			source: SOURCE,
			from: label(),
			to: "—",
			action: "skip",
			detail:
				`${dropped.length} hook(s) left off, each because this build has no event or no predicate for it: ${summarizeNames(dropped)}. ` +
				`Codewhale declares ${CODEWHALE_HOOK_EVENT_NAMES.length} events, ${CODEWHALE_HOOK_EVENTS_THIS_BUILD_RUNS.length} of which this build fires; ` +
				"a hook under an event that never fires would have been imported and silently never run",
			containsSecret: false,
		});
	};

	for (const block of raw.hooks) {
		sources.push(block.path);
		if (!block.enabled) {
			if (block.entries.length > 0) {
				items.push({
					source: SOURCE,
					from: block.path,
					to: "—",
					action: "skip",
					detail:
						`${block.entries.length} hook(s) here, and the block is switched off — Codewhale runs none of them, so importing them would add a behaviour that was deliberately removed. ` +
						"Set [hooks].enabled = true in Codewhale first, or add the commands by hand with /hooks",
					containsSecret: false,
				});
			}
			continue;
		}
		if (block.defaultTimeoutSecs !== null && block.entries.length > 0) {
			downgrades.push(
				`${block.path}'s \`default_timeout_secs\` of ${block.defaultTimeoutSecs} left off — it replaces every hook's own timeout rather than filling in for one, and this build has no such override`,
			);
		}
		for (const entry of block.entries) {
			total += 1;
			const event = CODEWHALE_HOOK_EVENTS[entry.event];
			const name = entry.name === null ? entry.event : `${entry.event} (${entry.name})`;
			if (event === undefined) {
				dropped.push(`${name}: an event this build has no hook for`);
				continue;
			}
			const handler = { command: entry.command, timeout: entry.timeoutSecs * 1000 };
			if (entry.condition === "" || entry.condition === "always") {
				const bucket = plain.get(event) ?? [];
				bucket.push(handler);
				plain.set(event, bucket);
				continue;
			}
			if (entry.condition === "tool_name" && entry.conditionArgument !== "") {
				const groups = matched.get(event) ?? [];
				groups.push({ matcher: entry.conditionArgument, hooks: [handler] });
				matched.set(event, groups);
				downgrades.push(`${entry.command} kept its \`tool_name\` condition as this build's matcher`);
				continue;
			}
			dropped.push(
				`${name}: \`${entry.condition}${entry.conditionArgument === "" ? "" : ` = ${entry.conditionArgument}`}\`, which is a predicate this build's hook has no field for`,
			);
		}
	}

	const eventNames = [...new Set([...plain.keys(), ...matched.keys()])];
	if (eventNames.length === 0) {
		if (total > 0) {
			items.push({
				source: SOURCE,
				from: label(),
				to: "—",
				action: "skip",
				detail: `none of the ${total} hook(s) Codewhale declares here produced a hook this build can run`,
				containsSecret: false,
			});
		}
		reportDropped();
		return;
	}

	// The Claude-shaped document `normalizeClaudeHooks` already understands: an event
	// maps to an array of groups, a group to a `matcher?` and a list of handlers.
	// The matcher-less group comes first because that is the shape every other
	// importer produces for a hook with no matcher.
	const document: Record<string, unknown> = {};
	for (const event of eventNames) {
		const groupsOut: unknown[] = [];
		const unfiltered = plain.get(event);
		if (unfiltered !== undefined) {
			groupsOut.push({ hooks: unfiltered.map((handler) => ({ type: "command", ...handler })) });
		}
		for (const group of matched.get(event) ?? []) {
			groupsOut.push({
				matcher: group.matcher,
				hooks: group.hooks.map((handler) => ({ type: "command", ...handler })),
			});
		}
		document[event] = groupsOut;
	}

	const normalized = normalizeClaudeHooks(document);
	if (normalized.droppedHandlers > 0) {
		downgrades.push(`${normalized.droppedHandlers} handler(s) were not shell commands and were dropped`);
	}
	if (normalized.malformed > 0) {
		downgrades.push(
			`${normalized.malformed} entr${normalized.malformed === 1 ? "y was" : "ies were"} malformed or carried no usable command`,
		);
	}
	if (normalized.clampedTimeouts > 0) {
		downgrades.push(`${normalized.clampedTimeouts} timeout(s) were clamped to the longest this build waits`);
	}

	const eventCount = Object.keys(normalized.config).length;
	if (eventCount === 0) {
		items.push({
			source: SOURCE,
			from: label(),
			to: "—",
			action: "skip",
			detail: `none of the ${total} hook(s) Codewhale declares here produced a hook this build can run`,
			containsSecret: false,
		});
		reportDropped();
		return;
	}

	claimHooks(
		SOURCE,
		normalized.config,
		label(),
		downgrades.length > 0
			? `${eventCount} event(s) imported — ${downgrades.join("; ")}`
			: `${eventCount} event(s) imported; every handler is a shell command, as this build's hooks are`,
		downgrades.length > 0 ? "downgrade" : "map",
	);
	reportDropped();
}

/**
 * Whether a path is absolute, without pulling `node:path`'s platform behaviour in.
 *
 * The same helper `qoder-plan.ts` uses, for the same reason: this reader has to
 * decide about a *file written on another machine*, so it tests both spellings
 * rather than the one this process would use.
 */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * The instruction documents, the project rules and the skills.
 *
 * **Rule files and not memory entries**, for the reason `planMemoryAsRule`'s own
 * detail line states: this build merges rule files with the memory it has instead
 * of replacing it, which is what a document the agent re-reads at the top of every
 * session wants.
 *
 * **A name collision is folded into the path** rather than resolved, because two
 * documents wanting one target path is the case `planAntigravityAssets` guards
 * against and resolving it would mean picking a winner silently.
 */
function planCodewhaleAssets(raw: RawCodewhale, force: boolean, items: MigrationItem[], writes: PlannedWrite[]): void {
	collectFileWrites(
		SOURCE,
		raw.assets,
		(name) => join(raw.home, ".labunbun", "skills", name, "SKILL.md"),
		"skill",
		force,
		items,
		writes,
		raw.home,
	);
	for (const collision of raw.assetCollisions) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, collision.dropped),
			to: "—",
			action: "skip",
			detail: `a skill named "${collision.name}" is in both ${collision.kept} and here; Codewhale reads the first, so the second was not read`,
			containsSecret: false,
		});
	}

	const documents: Array<{ content: string; sourcePath: string; fileName: string; what: string }> = [];
	for (const document of raw.globalInstructions) {
		documents.push({
			content: document.content,
			sourcePath: document.sourcePath,
			// `AGENTS.md` and `instructions.md` are two different documents in
			// Codewhale's own precedence list, so they get two different target
			// names rather than one `imported-codewhale.md`.
			fileName: `imported-codewhale-${document.name.replace(/\.[^.]*$/, "")}.md`,
			what: document.detail ?? "a Codewhale global instruction document",
		});
	}
	for (const rule of raw.projectRules) {
		documents.push({
			content: rule.content,
			sourcePath: rule.sourcePath,
			fileName: `imported-codewhale-rule-${rule.name.replace(/\.[^.]*$/, "")}.md`,
			what: rule.detail ?? "a Codewhale project rule",
		});
	}
	if (raw.projectAnchors?.trim()) {
		documents.push({
			content: raw.projectAnchors,
			sourcePath: join(raw.projectConfigPath === null ? raw.home : splitDir(raw.projectConfigPath), "anchors.md"),
			fileName: "imported-codewhale-anchors.md",
			what: "this project's `.codewhale/anchors.md`",
		});
	}
	for (const document of documents) {
		planMemoryAsRule(
			SOURCE,
			tildePath(raw.home, document.sourcePath),
			raw.home,
			document.content,
			document.fileName,
			force,
			items,
			writes,
		);
	}
	if (documents.length > 0) {
		items.push({
			source: SOURCE,
			from: raw.globalInstructions.length > 0 ? tildePath(raw.home, raw.configPath) : "this project's .codewhale/rules",
			to: "—",
			action: "downgrade",
			detail:
				`${documents.length} instruction document(s) came across as one rule file each, because this build has no global-instructions slot and merges rule files with the memory it has instead of replacing it — ` +
				"what pointed at what is now the file names",
			containsSecret: false,
		});
	}
}

/** The directory part of a path, for naming a sibling file's origin. */
function splitDir(path: string): string {
	const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return index <= 0 ? path.slice(0, index + 1) : path.slice(0, index);
}

/**
 * Every name, with no truncation.
 *
 * `summarizeNames` stops at five and writes "+N more", which is right for a list of
 * server names and **wrong for the two tables this file quotes**: the whole point of
 * naming which paths fall back to `~/.deepseek` is that the user can look up the one
 * they care about, and a list that stops at five cannot answer that for the paths it
 * left out. Both tables are short, fixed, and fully readable in a report line.
 */
function allNames(names: string[]): string {
	return names.join(", ");
}

/** The state names whose readers go through `codewhale_home()` alone — no legacy fallback. */
function noFallbackPaths(): string[] {
	return Object.entries(CODEWHALE_LEGACY_FALLBACK)
		.filter(([, fallsBack]) => !fallsBack)
		.map(([name]) => name);
}

/**
 * Everything the reader saw and this importer will not carry.
 *
 * **Two of these lines are the report's most important sentences for this
 * source**, and both are facts about a competing path rather than about a file
 * that could have been read:
 *
 *   - **Codewhale ships its own Claude Code importer.** `/import-claude`
 *     (`crates/tui/src/commands/groups/config/import_claude.rs`, 305 lines, and
 *     `crates/tui/src/import_claude.rs`, 543 lines) reads `~/.claude.json` and
 *     `~/.claude/settings.json` and, on `--apply`, moves `~/.claude/CLAUDE.md` to
 *     `~/.codewhale/instructions.md`. A user who has run it has already had their
 *     CLAUDE.md moved into a file this importer reads, and the report has to say
 *     so — "the run saw a competing path and did not take it".
 *   - **Codewhale is a rename of DeepSeek-TUI.** `~/.deepseek` is a live fallback
 *     root for some readers and not for others, which is what
 *     {@link CODEWHALE_LEGACY_FALLBACK} records, and what makes the tree this
 *     import read not always the tree the user still writes to.
 */
function planCodewhaleLeftovers(raw: RawCodewhale, items: MigrationItem[]): void {
	// **Which root answered each document, stated plainly, including "neither".**
	// Codewhale is two-rooted and the fallback is per-path, so a report that said
	// "Codewhale's settings were read" without saying from where would hide three
	// different facts: a current install, a pre-rename install the product still
	// reads, and a file that is simply not there. The third is the ordinary state
	// of a home that never wrote one, and it is listed as `absent` rather than
	// omitted — an omitted row is indistinguishable from a bug in the walk.
	const fromCanonical: string[] = [];
	const fromLegacy: string[] = [];
	const nowhere: string[] = [];
	for (const document of raw.documents) {
		if (document.root === "codewhale") fromCanonical.push(document.name);
		else if (document.root === "deepseek") fromLegacy.push(document.name);
		else nowhere.push(document.name);
	}
	items.push({
		source: SOURCE,
		from: `~/.codewhale and ~/.deepseek (${raw.documents.length} state documents)`,
		to: "—",
		action: "skip",
		detail:
			`where each state document was found, because Codewhale is two-rooted and the fallback is per-path rather than global. ` +
			`Read from the canonical ~/.codewhale: ${summarizeNames(fromCanonical)}. ` +
			`Read from the pre-rename ~/.deepseek, which the product still falls back to for these names: ${summarizeNames(fromLegacy)}. ` +
			`Not present under either root, so nothing was read from them: ${summarizeNames(nowhere)}. ` +
			`The names that do NOT fall back at all — ${allNames(noFallbackPaths())} — were looked for under ~/.codewhale only, which is what Codewhale itself does with them`,
		containsSecret: false,
	});

	// The shared `~/.agents` tree, named because the `agents` source owns it.
	if (raw.sharedTree.length > 0) {
		items.push({
			source: SOURCE,
			from: raw.sharedTree.map((relative) => `~/${relative.split("\\").join("/")}`).join(", "),
			to: "—",
			action: "skip",
			detail:
				"the shared cross-tool `.agents` home, which Codewhale reads below its own tree and **this importer did not import**. This repository has an `agents` source that owns that home outright, so importing it here too would write every file in it twice and attribute the second copy to Codewhale; run `--from agents` for it. `~/.agents/instructions.md` is listed here because the `agents` source reads `AGENTS.md`, `skills/`, `agents/` and `commands/` — not that file — so it has no other importer",
			containsSecret: false,
		});
	}

	items.push({
		source: SOURCE,
		from: `${CODEWHALE_IMPORT_CLAUDE.command} (${CODEWHALE_IMPORT_CLAUDE.commandModule}, ${CODEWHALE_IMPORT_CLAUDE.commandLines} lines; ${CODEWHALE_IMPORT_CLAUDE.engineModule}, ${CODEWHALE_IMPORT_CLAUDE.engineLines} lines)`,
		to: "—",
		action: "skip",
		detail:
			"Codewhale ships its own Claude Code importer, and this run saw it and did not take it. It reads ~/.claude.json and ~/.claude/settings.json and builds a plan; --apply performs exactly one mutation, copying ~/.claude/CLAUDE.md to ~/.codewhale/instructions.md when that destination is absent, and it names MCP servers and hooks for manual follow-up rather than importing them. " +
			"Two consequences for this report: if you have run it, your CLAUDE.md has already been moved into ~/.codewhale/instructions.md, which is one of the global instruction documents above; and a migration run from here reads that file as it stands rather than re-copying it",
		containsSecret: false,
	});

	// The legacy root, one line per state path whose resolution differs. This is
	// the sentence a user with a pre-rename install needs, and it is a sentence
	// per path because the answer is not uniform.
	const legacyPaths = Object.entries(CODEWHALE_LEGACY_FALLBACK)
		.filter(([, fallsBack]) => fallsBack)
		.map(([name]) => name);
	items.push({
		source: SOURCE,
		from: tildePath(raw.home, raw.resolved.legacyRoot),
		to: "—",
		action: "skip",
		detail:
			`Codewhale is a rename of DeepSeek-TUI and this is the pre-rename tree. It is read for ${allNames(legacyPaths)} — the paths whose readers still fall back to it — and not for ${allNames(noFallbackPaths())}, which resolve against ~/.codewhale only. ` +
			"A user who has run Codewhale's own first write has usually had their state relocated (`ensure_state_dir` moves a legacy tree on first creation, `crates/config/src/lib.rs:6177-6186`); one who has not has everything here, and anything this importer did not map in that tree stayed there",
		containsSecret: false,
	});

	if (raw.rejectedHome !== null) {
		items.push({
			source: SOURCE,
			from: "CODEWHALE_HOME",
			to: "—",
			action: "skip",
			detail: raw.rejectedHome,
			containsSecret: false,
		});
	}

	if (raw.sessionCount > 0) {
		items.push({
			source: SOURCE,
			from: `${tildePath(raw.home, raw.sessionsDir)} (${raw.sessionCount} session transcript${raw.sessionCount === 1 ? "" : "s"})`,
			to: "—",
			action: "skip",
			detail:
				`${raw.sessionCount} session transcript(s) found and none read by the settings import. Each is one <id>.json whose metadata records the working directory it ran in, so they convert with --history-scope rather than here — ` +
				"pass `--only history` or `--history-scope all` to bring them across",
			containsSecret: false,
		});
	}

	// The credential store, the keyring locks and `state.db`. Existence is the
	// only thing asked of the store and the *name* is what a report may print: it
	// holds `access_token` and `refresh_token` in plaintext, and it is the one file
	// here that Codewhale itself protects (0600, parent 0700) rather than leaving
	// to the umask.
	items.push({
		source: SOURCE,
		from: raw.secretStore.exists ? raw.secretStore.path : `${raw.secretStore.path} (not present)`,
		to: "—",
		action: "skip",
		detail:
			"Codewhale's credential store, never opened by this import. It is a JSON object of `{ entries: { name: value } }` at 0600 with the parent at 0700, and it holds the account access and refresh tokens — `crates/secrets/src/account.rs` says account sessions must never touch the OS keyring precisely because this file is the store. " +
			"On Windows there is no ACL enforcement at all, which the product's own comment notes. Nothing here holds a credential to migrate: re-authenticate with /login",
		containsSecret: false,
	});
	items.push({
		source: SOURCE,
		from: tildePath(raw.home, raw.keyringLocksDir),
		to: "—",
		action: "skip",
		detail: "the OS keyring's lock files — named, never listed, never opened",
		containsSecret: false,
	});
	items.push({
		source: SOURCE,
		from: "state.db",
		to: "—",
		action: "skip",
		detail:
			"Codewhale's derived-state database, named and not opened. It is in the product's own list of home entries the extension host refuses to expose (`crates/tui/src/extension_host/supervisor.rs:340-358`) and the interactive TUI does not always write it, so its absence is not evidence that there are no sessions",
		containsSecret: false,
	});

	// `tui.toml`, the superseded store, and the third `settings.toml` root nobody
	// would guess.
	items.push({
		source: SOURCE,
		from: raw.tuiPrefsPath,
		to: "—",
		action: "skip",
		detail:
			"Codewhale's superseded second preferences store, named and not read. The product folds it into settings.toml on load and moves it aside with a receipt (`tui/src/settings.rs:7`), so its contents are already in the document above and reading it would import the same preferences twice from a tree the product considers spent",
		containsSecret: false,
	});
	items.push({
		source: SOURCE,
		from: `<platform config dir>/${CODEWHALE_LEGACY_CONFIG_DIR_NAME}/settings.toml`,
		to: "—",
		action: "skip",
		detail:
			"Codewhale's third settings.toml candidate, which has no `~/` in it at all — `dirs::config_dir()` joined to a legacy directory name, so `%APPDATA%\\deepseek\\settings.toml` on Windows (`tui/src/settings.rs:2458-2459`). It is named rather than opened because it lies outside the home directory this run was given, and reading it would be reading a file the user did not scope this migration to",
		containsSecret: false,
	});

	// The project `config.toml`, reported rather than merged — and the reason is
	// the product's own, in its own words.
	if (raw.projectConfigPath !== null) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, raw.projectConfigPath),
			to: "—",
			action: "skip",
			detail:
				raw.projectConfig === null
					? "this project's own config.toml — the only project-scoped settings document Codewhale has — and nothing was read out of it"
					: "this project's own config.toml, read and reported but not merged. A project config can only *tighten* approval_policy and sandbox_mode beyond the user's baseline (`project_approval_policy_is_allowed` and `project_sandbox_mode_is_allowed`, `crates/config/src/lib.rs:3846-3872`), so importing what it asked for would be widening the target's posture at import time — the one direction a migration must not move in on its own judgement",
			containsSecret: false,
		});
	}
	if (raw.projectAgentsDir !== null) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, raw.projectAgentsDir),
			to: "—",
			action: "skip",
			detail:
				"this project's Fleet agent profiles, named and not read. A profile is a `<id>.toml` carrying a role, a loadout and its own permissions block (`crates/tui/src/fleet/profile.rs:112-137` for the personal half), which is a different document from a labunbun subagent definition rather than a format this importer can rewrite",
			containsSecret: false,
		});
	}
	for (const path of raw.deprecatedDocuments) {
		items.push({
			source: SOURCE,
			from: path,
			to: "—",
			action: "skip",
			detail:
				'WHALE.md, which Codewhale itself ignores — it reads one only to warn (`DEPRECATED_WHALE_FILENAME`, `project_context.rs:343`). The product\'s own words: "WHALE.md is ignored; move project instructions to AGENTS.md, or Codewhale-specific authority policy to .codewhale/constitution.json." Importing it would add instructions the product will never load',
			containsSecret: false,
		});
	}
	for (const collision of raw.instructionCollisions) {
		items.push({
			source: SOURCE,
			from: tildePath(raw.home, collision.dropped),
			to: "—",
			action: "skip",
			detail: `a document named "${collision.name}" is in both ${collision.kept} and here; Codewhale reads the first, so the second was not read`,
			containsSecret: false,
		});
	}

	if (raw.config !== null)
		reportUnhandledKeys(SOURCE, raw.config, CODEWHALE_CONFIG_HANDLED, tildePath(raw.home, raw.configPath), items);
	if (raw.settings !== null) {
		reportUnhandledKeys(SOURCE, raw.settings, CODEWHALE_SETTINGS_HANDLED, tildePath(raw.home, raw.settingsPath), items);
	}
	if (raw.projectConfig !== null) {
		reportUnhandledKeys(
			SOURCE,
			raw.projectConfig,
			CODEWHALE_CONFIG_HANDLED,
			tildePath(raw.home, raw.projectConfigPath ?? ""),
			items,
		);
	}

	// The product's own denylist, once, so a user can see what was out of scope
	// without reading twenty lines to find out.
	items.push({
		source: SOURCE,
		from: `Codewhale's own extension-host denylist (${CODEWHALE_DENIED_HOME_ENTRIES.length} home entries)`,
		to: "—",
		action: "skip",
		detail: `the rest of what Codewhale keeps: ${summarizeNames([...CODEWHALE_DENIED_HOME_ENTRIES], 24)}. This importer read three of them on purpose — sessions, mcp.json and settings.toml — and names the rest rather than opening them`,
		containsSecret: false,
	});

	for (const entry of raw.skipped) {
		items.push({
			source: SOURCE,
			from: entry.name,
			to: "—",
			action: "skip",
			detail: entry.reason,
			containsSecret: false,
		});
	}
}

/**
 * Assemble the plan.
 *
 * Every parameter is one something below uses: `claimScalar` for the model and
 * for the two mode axes, `claimPermissionList` for `permissions.toml`, and
 * `mcpServers`/`markMcpSecret`/`existingMcpServers`/`force` for the one place a
 * credential could still reach a written file.
 *
 * **There is no `claimModePair`, and that absence is a decision rather than an
 * oversight.** Codewhale states `approval_policy` and `sandbox_mode` as two
 * independent root keys, so the pair is claimed per field — see
 * {@link planCodewhaleModes} for why, which is the same argument
 * `antigravity-plan.ts` makes and for the same reason: `claimModePair` writes one
 * shared detail onto both keys, and both of its sandbox sentences would be false
 * of a source that has a `sandbox_mode` of its own.
 *
 * **There is no `claimEnv`, and that absence is a fact.** The one place Codewhale
 * stores an environment variable's *value* is an MCP server's `env`, and the
 * instruction on this source is that those values do not come across; nothing else
 * in any of its documents holds one.
 *
 * **`claimHooks` is present, and finding it late is worth recording.** An earlier
 * draft of this header said Codewhale had no hooks at all, on the evidence that
 * `ConfigToml` (`crates/config/src/lib.rs:882-995`) declares no `hooks` field. That
 * is a false negative of a familiar kind: `HooksConfig` is deserialized
 * **separately** from the root config (`crates/tui/src/hooks/config.rs:379`,
 * "Configuration for hooks (loaded from config.toml)"), exactly as the TUI's own
 * `Config` is. Reading "the field is not on the struct" as "the document does not
 * exist" is the same mistake as trusting a field list for a settings file, and it
 * is corrected here rather than quietly.
 */
export function planCodewhale(
	raw: RawCodewhale,
	items: MigrationItem[],
	writes: PlannedWrite[],
	claimScalar: ClaimScalar,
	claimHooks: ClaimHooks,
	claimPermissionList: ClaimPermissionList,
	mcpServers: Record<string, unknown>,
	markMcpSecret: (hasSecret: boolean) => void,
	existingMcpServers: Record<string, unknown>,
	force: boolean,
): void {
	planCodewhaleModel(raw, items, claimScalar);
	planCodewhaleModes(raw, items, claimScalar);
	planCodewhaleHooks(raw, items, claimHooks);
	planCodewhalePermissions(raw, items, claimPermissionList);
	planCodewhaleMcp(raw, items, mcpServers, markMcpSecret, existingMcpServers, force);
	planCodewhaleAssets(raw, force, items, writes);
	planCodewhaleLeftovers(raw, items);
}

/** Re-exported so a caller can name the credential keys without reading the reader. */
export { CODEWHALE_MCP_CREDENTIAL_KEYS };
