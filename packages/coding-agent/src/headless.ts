/**
 * Headless (-p / --print) mode: run one prompt non-interactively.
 *
 * Output formats:
 * - text (default): streamed assistant text on stdout
 * - json: single JSON result object at the end
 * - stream-json: one JSON line per event, live
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentEvent, PermissionMode, SandboxMode } from "@labunbun/agent";
import {
	AgentSession,
	collectReadOnlyToolNames,
	evaluatePermissions,
	formatRetryNotice,
	SessionStore,
} from "@labunbun/agent";
import {
	type AgentMessage,
	type CacheTracker,
	cacheTotals,
	createTrackedStreamFn,
	dynamicProviderTemplates,
	refreshModelCatalog,
	resolveModel,
	type StreamFn,
	totalsHitRate,
	withModelFallback,
} from "@labunbun/ai";
import {
	connectAllMcpServers,
	disconnectAllMcpServers,
	loadApprovedMcpServers,
	loadMcpConfig,
	loadProjectMcpServerNames,
	type McpServerConfig,
	parseMcpServersRecord,
} from "@labunbun/mcp";
import { createAllTools } from "@labunbun/tools";
import { createChatGptCredentials } from "./chatgpt-auth.ts";
import { createToolLedger, formatResumeSummary, readToolCheckpoints } from "./checkpoint-log.ts";
import { createClaudeCredentials } from "./claude-auth.ts";
import { builtInCommands, expandPromptCommand } from "./commands.ts";
import { type CompactionTuning, createCompactionWiring, resolveCompactionSummarizer } from "./compaction-wiring.ts";
import { CostTracker, costStateFromMessages } from "./cost-tracker.ts";
import { createGeminiCredentials } from "./gemini-auth.ts";
import { advisoryHookFailures, sessionHookDeps, snapshotHooks } from "./hooks.ts";
import { loadMemoryFiles } from "./memory.ts";
import { writeMissionRecord } from "./mission-ledger.ts";
import { noToolCallingNotice } from "./model-offer.ts";
import {
	budgetVerdict,
	createModelChainResolver,
	modelRefKey,
	resolveRoles,
	roleOrder,
	seatsByRef,
} from "./model-roles.ts";
import { enclosingRepositoryRoot, withheldDefinitionNotice } from "./project-trust.ts";
import {
	damagedSessionNotice,
	findSession,
	listSessions,
	loadSessionForResume,
	resolveContinueTarget,
} from "./session-resume.ts";
import {
	applyCatalogSettings,
	applySettingsEnv,
	collectPermissionRules,
	formatIgnoredKeysNotice,
	loadSettings,
	networkAxisFrom,
	type RawSettingsInput,
	resolveMode,
} from "./settings.ts";
import {
	loadSkillsWithNotes,
	skillDiscoveryBlock,
	skillDiscoveryBudgetChars,
	skillsAsCommands,
	withheldProjectSkills,
} from "./skills.ts";
import { formatSubagentRecovery, readSubagentLedger } from "./subagent-ledger.ts";
import { SubagentRegistry } from "./subagent-registry.ts";
import { createSubagentTools, loadAgentDefinitions, withheldProjectAgents } from "./subagents.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { pruneToolOutput, toolOutputRoot, toolSpillDir, writeToolOutput } from "./tool-output.ts";

export type OutputFormat = "text" | "json" | "stream-json";

/** Read a file, or null when it is absent or unreadable — the readers' shared answer. */
function readFileOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export interface HeadlessOptions {
	prompt: string;
	modelRef?: string;
	permissionMode?: PermissionMode;
	sandbox?: SandboxMode;
	maxTurns?: number;
	noSession?: boolean;
	/**
	 * Resume a saved session by id (`--resume <id>`), and its shorthand: the
	 * most recent one (`continueLast`, `-c`). Both mirror the REPL's loadout —
	 * the repaired transcript is restored and the ledger's recovery line goes to
	 * stderr — because a scripted run continuing yesterday's conversation has the
	 * same question to answer as a person doing it. `--no-session` alongside
	 * either is rejected in `main.ts`: one writes nothing, the other reads what a
	 * previous run wrote, and honoring either would silently drop the other.
	 */
	resumeSessionId?: string;
	continueLast?: boolean;
	cwd?: string;
	outputFormat?: OutputFormat;
	/**
	 * Which home the run reads. Threaded into every loader below that would
	 * otherwise resolve one for itself — the settings tiers, the session file,
	 * the memory files, the skills, the agent definitions — so that a run given
	 * a home reads that home throughout. The alternative is what this parameter
	 * exists to remove: a caller that wants a different home has to mutate
	 * `process.env` and hope every loader it does not know about re-resolves.
	 */
	home?: string;
	/**
	 * Settings delivered as a JSON object on the command line (`--settings`),
	 * merged over every file tier. Parsed and shape-checked in `main.ts`.
	 */
	flagSettings?: RawSettingsInput;
	/**
	 * The model transport. Injected by tests, which is the only way to run this
	 * path without a network or a bill; production leaves it out and gets the
	 * retrying default.
	 */
	streamFn?: StreamFn;
}

interface JsonResult {
	type: "result";
	subtype: "success" | "error_max_turns" | "error_during_execution" | "error_aborted";
	cost_usd: number;
	/** The part of `cost_usd` subagent runs spent, so a script can attribute it. */
	subagent_cost_usd: number;
	duration_ms: number;
	num_turns: number;
	result: string;
	session_id: string | null;
	cache: CacheResult;
}

/**
 * What the prompt cache did, in the machine-readable result.
 *
 * The three token channels sum to the whole prompt, so no separate total is
 * reported — a fourth number that is the sum of the other three is a number
 * that can drift away from them. `cache_hit_rate` is the read share of that
 * sum, or null when the provider reported no prompt size at all, which is a
 * different fact from zero.
 *
 * `cache_rewinds` needs the tracker, and a caller that injected its own
 * transport has none: null says "not observed" where zero would claim something
 * nobody checked. It counts every family, including summariser and subagent
 * requests, because a rewind in any of them is a cache that was thrown away.
 */
interface CacheResult {
	cache_read_tokens: number;
	cache_write_tokens: number;
	full_price_tokens: number;
	cache_hit_rate: number | null;
	cache_rewinds: number | null;
}

function cacheResult(messages: AgentMessage[], tracker?: CacheTracker): CacheResult {
	const totals = cacheTotals(messages);
	const rate = totalsHitRate(totals);
	return {
		cache_read_tokens: totals.read,
		cache_write_tokens: totals.write,
		full_price_tokens: totals.input,
		cache_hit_rate: rate ?? null,
		cache_rewinds: tracker ? tracker.records().filter((record) => record.kind === "rewind").length : null,
	};
}

export async function runHeadless(options: HeadlessOptions): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const format = options.outputFormat ?? "text";
	const home = options.home ?? homedir();

	const loadedSettings = loadSettings(cwd, options.flagSettings, home);
	const { settings } = loadedSettings;
	const ignoredNotice = formatIgnoredKeysNotice(loadedSettings.ignoredKeys);
	if (ignoredNotice) console.error(`Warning: ${ignoredNotice}`);
	// Before the model is resolved, unlike in the REPL: a provider, or a price,
	// that lives in settings has to be registered for the reference below to
	// resolve at all — and the price is what the reported cost is computed from.
	applySettingsEnv(settings);
	applyCatalogSettings(settings);

	// `settings.roles`, resolved once before anything resolves a model, the way
	// the REPL resolves it: fail-soft, with the same targeted refresh a `-p` run
	// already makes for a ref only a listing can name. The warnings go to stderr
	// where everything else a scripted run says goes.
	const resolvedRoles = await resolveRoles(settings.roles, () =>
		settings.modelDiscovery !== false ? refreshModelCatalog({ models: dynamicProviderTemplates() }) : undefined,
	);
	for (const warning of resolvedRoles.warnings) console.error(warning);

	// `settings.model` is the fallback between the flag and the built-in default,
	// the same order the REPL resolves in: the setting is documented as the model
	// to use, and a `-p` run that ignored it made the same prompt behave
	// differently in two modes for no reason the user could see. `roles.main`
	// sits between that setting and the built-in default — the role stack's
	// statement about the main seat, which an explicit ask of either kind wins
	// over, exactly as in the REPL.
	const builtinModelRef = "anthropic/claude-sonnet-5";
	const modelRef = options.modelRef ?? settings.model;
	let model = modelRef ? resolveModel(modelRef) : (resolvedRoles.main.model ?? resolveModel(builtinModelRef));
	if (!model && modelRef && settings.modelDiscovery !== false) {
		// The REPL refreshes the whole catalog in the background at startup; a `-p`
		// run stays off the network by default for the reason `modelDiscovery`
		// documents. The one targeted exception: a ref only a listing can name —
		// the local Ollama daemon's loadout — resolved to nothing, and nothing but
		// asking that daemon (the keyless provider, the only one in the template
		// list) will ever name it.
		await refreshModelCatalog({ models: dynamicProviderTemplates() });
		model = resolveModel(modelRef);
	}
	if (!model) {
		console.error(`Unknown model: ${modelRef ?? builtinModelRef}`);
		return 1;
	}
	// Warned, not refused, for the reason the interactive picker filters these rows
	// out instead: an unattended run has no one to tell, so the fact has to be in
	// the log or it is nowhere. stderr so a piped stdout stays machine-readable.
	if (model.toolCalling === false) {
		console.error(`Warning: ${noToolCallingNotice(model)}`);
	}

	// `settings.compaction`, resolved once and shared down the same seams
	// `trimOldToolResults` travels — the session's manager, each subagent's, each
	// beetle member's. The refresh the summarizer resolution may need is the
	// targeted one above rather than a full catalog walk: a `-p` run stays off
	// the network by default, and the exception it already makes covers exactly
	// the case a configured summarizer can be — a model only a listing can name.
	// `roles.compaction.model` is the newer spelling of the same choice and wins
	// where both are set; the older `settings.compaction.model` keeps working
	// alone, which is what keeps every configuration written before the role
	// stack did.
	const compactionSettings = settings.compaction;
	const compactionSummarizer = resolvedRoles.compaction.model
		? { model: resolvedRoles.compaction.model }
		: await resolveCompactionSummarizer(compactionSettings?.model, () =>
				settings.modelDiscovery !== false ? refreshModelCatalog({ models: dynamicProviderTemplates() }) : undefined,
			);
	if (compactionSummarizer.warning) console.error(compactionSummarizer.warning);
	// The tuning struct exists when either key named the summarizer: with only
	// `roles.compaction.model` set there are no knobs, but the model still has to
	// travel — a struct built only for `settings.compaction` would leave the role
	// resolved and never read, and the session model would summarize.
	const compactionTuning: CompactionTuning | undefined =
		compactionSettings || compactionSummarizer.model
			? {
					summarizerModel: compactionSummarizer.model,
					reserveTokens: compactionSettings?.reserveTokens,
					thresholdPercent: compactionSettings?.thresholdPercent,
					enabled: compactionSettings?.enabled,
				}
			: undefined;

	// Spilling applies here too: a `-p` run reads a repository like any other
	// session, and a build log that does not fit is no more reproducible for
	// being unattended.
	const tools = createAllTools(cwd, {
		readOnlyRoots: [toolOutputRoot(cwd)],
		// Under the root Read is already allowed into, so every pointer a tool
		// result carries is a path Read can open.
		spillDir: toolSpillDir(cwd),
		// The Bash tool builds its policy from these. Without `home` the resolver
		// gets nothing and returns no roots, which is the safe direction but means
		// `workspace-write` still cannot reach the temp directory or a package cache
		// — the usability defect these roots exist to close.
		home,
		writableRoots: settings.permissions.additionalDirectories,
	});
	// ---- session persistence: resume, continue, or new ----
	// The same three-way choice the REPL makes at startup, from the same
	// functions: `-p` ignored `--resume`/`-c` before this (the flags parsed and
	// went nowhere), and a scripted run of a saved conversation resumed from
	// nothing while the flags said otherwise.
	let store: SessionStore | undefined;
	/** The repaired transcript `loadSessionForResume` handed back, restored below. */
	let resumedMessages: AgentMessage[] | undefined;
	if (options.noSession) {
		store = undefined;
	} else if (options.resumeSessionId) {
		const resumeId = options.resumeSessionId;
		const match = findSession(listSessions(cwd, home), resumeId);
		if (!match) {
			console.error(`Session not found: ${resumeId}`);
			return 1;
		}
		const loaded = loadSessionForResume(match.path);
		if (loaded) {
			store = loaded.store;
			const damage = damagedSessionNotice(loaded.store, loaded.removed);
			if (damage) console.error(`Warning: ${damage}`);
			resumedMessages = loaded.messages;
		} else {
			console.error(`Could not read session ${resumeId} — starting a new one.`);
			store = SessionStore.startNew(cwd, home);
		}
	} else if (options.continueLast) {
		const target = resolveContinueTarget(cwd, home);
		if (target) {
			const loaded = loadSessionForResume(target.path);
			store = loaded?.store;
			if (loaded) {
				const damage = damagedSessionNotice(loaded.store, loaded.removed);
				if (damage) console.error(`Warning: ${damage}`);
				resumedMessages = loaded.messages;
			}
		}
		if (!store) {
			console.error("No previous session to continue — starting a new one.");
			store = SessionStore.startNew(cwd, home);
		}
	} else {
		store = SessionStore.startNew(cwd, home);
	}

	// The recovery notices, at the same moment the REPL prints them and in its
	// order. A fresh session reads empty ledgers and prints nothing, so neither
	// line needs a `--resume` branch of its own. stderr, like every other
	// startup notice here — `-p`'s stdout is the answer.
	if (store) {
		// The subagent orphan notice, and only that one of the three: the mission
		// summary and the shell recovery warning both send the reader to `/ps`,
		// which does not exist in a `-p` run (see `mission-ledger.ts` for the
		// decision). A run that died mid-flight is exactly what a scripted caller
		// resuming a session needs to hear about.
		const subagentNotice = formatSubagentRecovery(readSubagentLedger(store));
		if (subagentNotice) console.error(`Warning: ${subagentNotice}`);
		// The recovery protocol's own line: what the resumed ledger says the last
		// run was doing, and where to look next.
		const resumeSummary = formatResumeSummary(readToolCheckpoints(store.entries));
		if (resumeSummary) console.error(resumeSummary);
	}

	pruneToolOutput(cwd);
	const rules = collectPermissionRules(loadedSettings);
	// Headless runs unattended, so there is nobody to ask: the default is the
	// only pairing that still finishes the work, which is why this is
	// `agent` + `danger-full-access` rather than `ask`. Both axes go through the
	// policy tier, so a managed machine can take the confinement back.
	// Note `settings.permissionMode` is deliberately not consulted here — it
	// governs the interactive default, and honouring it would change what
	// existing scripted `-p` runs are allowed to do.
	const {
		mode: effectiveMode,
		sandbox: effectiveSandbox,
		downgradeReason,
	} = resolveMode(
		{
			mode: options.permissionMode ?? "agent",
			sandbox: options.sandbox ?? "danger-full-access",
		},
		loadedSettings,
	);
	if (downgradeReason) console.error(`Warning: ${downgradeReason}`);
	// The network axis is read from settings even though the other two are not:
	// there is no headless default to preserve, because before this axis existed
	// every command reached whatever the host could reach. So the settings value
	// is the only thing that can turn it down, and reading it here is what makes
	// `networkAccess` mean anything in a `-p` run.
	const effectiveNetwork = networkAxisFrom(settings);

	// ---- user hooks (snapshotted at startup against mid-session injection) ----
	const hooksRuntime = snapshotHooks(settings.hooks);
	const sessionId = store?.sessionId ?? undefined;
	const hookContext: string[] = [];

	// SessionStart runs before the prompt so its context reaches the model.
	// Hook failures are reported on stderr and never change the exit code.
	const sessionStart = await hooksRuntime.run("SessionStart", { session_id: sessionId, cwd });
	hookContext.push(...sessionStart.addedContext);
	for (const message of advisoryHookFailures("SessionStart", sessionStart)) {
		console.error(`Warning: ${message}`);
	}
	/**
	 * The transport, and what it can be asked about afterwards.
	 *
	 * The default is tracked so the JSON result can report what the cache did;
	 * an injected transport (a test, an embedder) is used as it comes, and the
	 * tracker-shaped fields in the result become null rather than invented.
	 */
	// The Claude subscription, when one is signed in. A `-p` run reads the
	// same stored sign-in the REPL does, and the anthropic adapter prefers it
	// over the environment key, so headless and interactive cannot disagree
	// about which credential served a request. The ChatGPT and Gemini
	// subscriptions ride the same reasoning on their own wires.
	const credentials = createClaudeCredentials({ home });
	const chatgptCredentials = createChatGptCredentials({ home });
	const geminiCredentials = createGeminiCredentials({ home });
	const transport: { streamFn: StreamFn; tracker?: CacheTracker } = options.streamFn
		? { streamFn: options.streamFn }
		: createTrackedStreamFn({ policy: settings.cache, credentials, chatgptCredentials, geminiCredentials });
	// The same fallback the REPL wraps around its transport, from the same
	// settings: a `-p` run that ignored `fallbackModels` kept failing on a model
	// whose provider was down while an interactive run of the same prompt would
	// have moved on. The chain is computed from the model that failed and
	// descends the order that owns it — the main and compaction seats, then the
	// light seat for a subagent's requests, and the global `fallbackModels` as
	// the net they share. There is no plan order here: a `-p` run has no plan
	// mode. The tracker stays underneath, so the JSON result still reports what
	// the cache did on whichever model actually answered.
	const globalFallbacks = (settings.fallbackModels ?? [])
		.map((ref) => resolveModel(ref))
		.filter((m): m is NonNullable<typeof m> => Boolean(m));
	const mainSeat = resolvedRoles.main.model ?? model;
	// Which seat owns which model ref, and the ceiling it carries — the lookup
	// the budget gate runs on every request, from the same resolution as the
	// orders because the seat a model belongs to decides both.
	const seatTable = seatsByRef(resolvedRoles);
	const roleOrders = [
		roleOrder(mainSeat, resolvedRoles.main.fallback, globalFallbacks),
		...(resolvedRoles.compaction.model
			? [roleOrder(resolvedRoles.compaction.model, resolvedRoles.compaction.fallback, globalFallbacks)]
			: []),
		...(resolvedRoles.light.model
			? [roleOrder(resolvedRoles.light.model, resolvedRoles.light.fallback, globalFallbacks)]
			: []),
	];
	const streamFn = withModelFallback(transport.streamFn, createModelChainResolver(roleOrders, globalFallbacks));

	// Everything the REPL has always put in front of the model and a `-p` run
	// did not: the memory files, the skills, and the agents a Task call can spawn.
	// A scripted run reads the same repository as an interactive one, so a
	// LABUNBUN.md, a `/skill-x`, or an agent definition that works in the REPL and
	// silently does nothing under `-p` made the same prompt behave differently in
	// two modes — which is the kind of difference nobody notices until they trust
	// a nightly job to do what they just did by hand.
	const memory = loadMemoryFiles(cwd, home);
	const { skills, notes: skillNotes } = loadSkillsWithNotes(cwd, home);
	const commands = [...builtInCommands(), ...skillsAsCommands(skills)];
	const agentDefinitions = loadAgentDefinitions(cwd, home);
	// A `-p` run has no dialog to approve a project's definitions with, so an
	// untrusted one is not loaded at all — the gate is inside the loaders above.
	// Said on stderr rather than passed over in silence: a scripted run whose
	// skills quietly expand to nothing is the exact failure that is invisible
	// until someone reads the transcript and wonders why the model ignored them.
	const withheldAgents = withheldProjectAgents(cwd, home);
	const withheldSkills = withheldProjectSkills(cwd, home);
	if (withheldAgents.length + withheldSkills.length > 0) {
		console.error(
			withheldDefinitionNotice(
				{ agents: withheldAgents.length, skills: withheldSkills.length },
				"headless",
				enclosingRepositoryRoot(cwd),
			),
		);
	}
	// Held-back skill folders (a name that fails validation): a scripted run has
	// nowhere else to say so, and a skill the author believes is loaded is worse
	// than no skill.
	for (const note of skillNotes) console.error(`Skills: ${note}`);
	// ---- MCP servers ----
	// A `-p` run has no dialog to approve a project-defined server with, so the
	// gate cannot be lifted by asking — an unapproved one is skipped, but skipped
	// loudly, because "no server connected" and "your server was withheld" are
	// the same transcript until something says which. User-scope servers (the
	// user's own `~/.labunbun/.mcp.json`) and `settings.json`'s `mcpServers` are
	// the user's own configuration and need no approval; project `.mcp.json`
	// names still go through the ledger the REPL writes.
	const mcpLoad = loadMcpConfig(cwd, home);
	const settingsMcp = parseMcpServersRecord(settings.mcpServers, "settings.json");
	const mcpConfig: Record<string, McpServerConfig> = { ...mcpLoad.servers, ...settingsMcp.servers };
	for (const error of [...mcpLoad.errors, ...settingsMcp.errors]) {
		console.error(`Warning: MCP config: ${error.path} — ${error.message}`);
	}
	const projectMcpServerNames = loadProjectMcpServerNames(cwd);
	const approvedProjectMcpServers = loadApprovedMcpServers(cwd, home);
	const runnableMcpServers: Record<string, McpServerConfig> = {};
	const withheldMcpServers: string[] = [];
	for (const [name, config] of Object.entries(mcpConfig)) {
		const needsApproval = projectMcpServerNames.has(name) && settingsMcp.servers[name] === undefined;
		if (needsApproval && !approvedProjectMcpServers.has(name)) withheldMcpServers.push(name);
		else runnableMcpServers[name] = config;
	}
	if (withheldMcpServers.length > 0) {
		console.error(
			`Warning: skipping unapproved project MCP server${withheldMcpServers.length === 1 ? "" : "s"} ` +
				`${withheldMcpServers.join(", ")} — approve in an interactive session (/mcp approve <name>).`,
		);
	}
	const mcpConnections = await connectAllMcpServers(runnableMcpServers);
	// No `onToolsChanged` is attached on purpose: a `-p` run is one shot and ends
	// before a tool-list change could reach anyone, so there is no live session
	// to move a new list into. A server that announces a change mid-run still
	// refreshes its own connection snapshot; this process has nothing to do with
	// it. The REPL, which outlives its servers' changes, wires the callback
	// (see runInteractive).
	for (const connection of mcpConnections) {
		if (connection.error) console.error(`Warning: MCP server ${connection.serverName}: ${connection.error}`);
	}
	const mcpTools = mcpConnections.flatMap((connection) => connection.tools);

	// Subagent spend, accumulated as it happens: a subagent's conversation never
	// enters this run's messages, so a bill computed from them alone would
	// under-report every run that fanned out. In memory only — a `-p` run keeps
	// no project ledger.
	const subagentUsage = new CostTracker();
	// The fleet as the host watches it, the same table the REPL injects: the
	// close-out note's live count has to be read from the registry the tools
	// write to, or it would be a claim rather than an observation.
	const subagentRegistry = new SubagentRegistry();
	// Read at the call, like the REPL's: the definition list is a getter because a
	// definition approved mid-session joins it, and the store because a sidechain
	// belongs to whichever session is live.
	const [taskTool, sendMessageTool, taskStopTool] = createSubagentTools({
		streamFn,
		model: () => model,
		// `roles.light`, when one is configured: where subagents run unless their
		// definition names its own model.
		lightModel: () => resolvedRoles.light.model,
		resolveModel,
		// A getter like the REPL's, but one that always answers the same list: a
		// `-p` run attaches no `onToolsChanged` (see above), so nothing moves
		// `tools` or the session's own registry mid-run — the two stay equal, as
		// the read-only note below says. Reading `mcpConnections` live here would
		// hand a subagent a tool the parent session never got.
		allTools: () => [...tools, ...mcpTools],
		definitions: () => agentDefinitions,
		store: () => store,
		registry: subagentRegistry,
		permissionMode: () => effectiveMode,
		// Both axes, because a subagent that got different ones from the session
		// that spawned it would be running under a policy nobody chose. `sandbox`
		// was missing here and defaulted to `workspace-write`, so a `-p` run at
		// `danger-full-access` got subagents that could not write outside the
		// workspace — narrower, so nothing leaked, but a subagent in `agent` mode
		// cannot ask, so the failure was an unexplained "not permitted" deep in a
		// tool result with no line anywhere saying why.
		sandbox: () => effectiveSandbox,
		network: () => effectiveNetwork,
		// A `-p` run has no `/think` to move it mid-run, so this answers the same
		// thing every time — but it is still the reader shape, so a subagent's
		// requests travel the same seam as the session's.
		thinkingLevel: () => settings.thinkingLevel,
		getPermissionRules: () => rules,
		trimOldToolResults: settings.trimOldToolResults,
		compactionTuning,
		report: (text) => console.error(text),
		// The subagent's own usage, into the accumulator above; the JSON result
		// reports the part beside the bill it is included in.
		onUsage: (provider, modelId, usage, seat) => subagentUsage.recordUsage(provider, modelId, usage, 0, seat),
		// The light seat's spending gate, read at every door into a subagent
		// run. The spend is the share this seat itself booked —
		// `roleCostUSD.light` on the accumulator's session view — against the
		// ceiling the user set on `roles.light`; a seat with none answers
		// `null` for every call.
		budgetGate: (role) => {
			const verdict = budgetVerdict(subagentUsage.sessionState.roleCostUSD[role] ?? 0, {
				role,
				budgetUSD: resolvedRoles[role].budgetUSD,
			});
			return verdict.action === "blocked" ? verdict.message : null;
		},
	});
	const subagentTools = [taskTool, sendMessageTool, taskStopTool];
	const allTools = [...tools, ...mcpTools, ...subagentTools];
	// The plan gate's read-only answer, from the tool objects themselves (see
	// `collectReadOnlyToolNames`). A constant here: unlike the REPL, nothing
	// appends tools to this session mid-run.
	const readOnlyToolNames = collectReadOnlyToolNames(allTools);

	// A `-p` run is a session like any other, and one that runs out of room
	// unattended has nobody to type `/compact`: before this it ended on the
	// provider's own refusal, with the whole transcript still in the way. The
	// same wiring the REPL uses, reporting to stderr because that is where a
	// non-interactive run says things — and registering its rewrites with the
	// tracker, or a `-p` run's own summary would be reported as a prefix rewrite
	// nothing declared.
	const compactionWiring = createCompactionWiring({
		model,
		store,
		streamFn,
		trimOldToolResults: settings.trimOldToolResults,
		tuning: compactionTuning,
		report: (text) => console.error(text),
		readFile: readFileOrNull,
		noteRewrite: (cause) => transport.tracker?.note(cause),
	});

	// The tool ledger, through the same writer the REPL runs: one entry per
	// finished call, the /rewind snapshots, the file fingerprints, the failing
	// tests a failed test run reported, and the next step the board states.
	// Before this, a `-p` run left none of it — the events below existed and
	// nothing at this end read them.
	const ledger = createToolLedger({ store: () => store, readFile: readFileOrNull });
	const hookDeps = sessionHookDeps({ runtime: hooksRuntime, context: hookContext, cwd });

	// Annotated because `checkBudget` below reads this very session's messages:
	// without the annotation the type would be inferred from its own initializer.
	const session: AgentSession = new AgentSession({
		model,
		systemPrompt: buildSystemPrompt(allTools, {
			cwd,
			platform: process.platform,
			isTTY: process.stdout.isTTY ?? false,
			memory: memory.content,
			skills: skillDiscoveryBlock(skills, skillDiscoveryBudgetChars(model.contextWindow)),
		}),
		tools: allTools,
		store,
		cwd,
		maxTurns: options.maxTurns,
		permissionMode: effectiveMode,
		sandbox: effectiveSandbox,
		network: effectiveNetwork,
		deps: {
			streamFn,
			// Constant in a `-p` run — nothing moves it mid-run — but read per request
			// like the REPL's, so the settings value lands on the wire through the
			// same seam in both modes.
			thinkingLevel: () => settings.thinkingLevel,
			checkCompaction: compactionWiring.checkCompaction,
			// The spending ceiling, asked before every request of this run's own
			// loop. The model about to answer names the seat (a model no seat
			// owns is never gated), and the spend is the run's cumulative total
			// at that moment: the transcript, re-costed from its own usage
			// records — which is what makes a resumed conversation count what it
			// already spent — plus the subagent accumulator, whose bookings never
			// enter the transcript. The same sum the JSON result reports.
			checkBudget: ({ model: answering }) => {
				const seat = seatTable.get(modelRefKey(answering));
				if (!seat) return { action: "ok" };
				const spent = costStateFromMessages(session.messages).totalCostUSD + subagentUsage.state.totalCostUSD;
				return budgetVerdict(spent, seat);
			},
			spillOutput: (request) => writeToolOutput(request, { cwd, sessionId }),
			// Headless has no interactive dialog, so an unresolved "ask" fails
			// closed rather than hanging: there is nobody to ask, and waiting
			// forever is not a decision. This is what the deleted `dontAsk` mode
			// did, reached here by the fact that is actually the reason for it.
			canUseTool: async (toolName, input, ctx) => {
				const decision = evaluatePermissions(toolName, input, {
					mode: ctx.mode,
					sandbox: ctx.sandbox,
					rules,
					cwd,
					readOnlyToolNames,
				});
				if (decision.behavior === "ask") {
					return {
						behavior: "deny",
						message: decision.message ?? `Permission required for ${toolName} (no interactive dialog in headless mode)`,
					};
				}
				return decision;
			},
			// The same three callbacks the ACP route wires, from one definition
			// (`sessionHookDeps`), so the two unattended entry points cannot drift
			// about when hook context joins a user message. The tool ledger's two
			// mutation notes wrap them, running first — the REPL's order — so the
			// before-side fingerprint is taken before any other hook could touch
			// the file, and a hook that blocks a call still leaves the ledger
			// saying what was attempted.
			hooks: {
				...hookDeps,
				beforeToolCall: async (toolName, input, ctx) => {
					ledger.noteBeforeMutation(toolName, input);
					return hookDeps.beforeToolCall?.(toolName, input, ctx);
				},
				afterToolCall: async (toolName, input, result) => {
					ledger.noteAfterMutation(toolName, input, result.isError);
					return hookDeps.afterToolCall?.(toolName, input, result);
				},
			},
		},
	});

	// The transcript a resume handed back, into the session that will carry it.
	// A newly started store has none, and a compacted one resumes from its
	// boundary — the same seed the REPL applies at startup.
	if (store) session.messages.push(...(resumedMessages ?? store.contextMessages()));

	const startedAt = Date.now();
	let lastAssistantText = "";
	let turns = 0;
	/**
	 * The loop's own verdict on why the run ended.
	 *
	 * It knows things the transcript does not: a request that could not be sent
	 * ends the run with a reason ("Automatic compaction could not free enough
	 * space… Run /compact"), while the transcript's last error is whatever the
	 * provider said when it refused — which is the symptom, not the explanation.
	 */
	let endErrorMessage: string | undefined;

	const emitStreamJson = (payload: Record<string, unknown>): void => {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	};

	session.on((event: AgentEvent) => {
		if (event.type === "turn_start") turns++;
		if (event.type === "agent_end") endErrorMessage = event.errorMessage;

		// The tool ledger, from the same two events the REPL's subscription
		// feeds it. Nothing here touches stdout: the formats below own that.
		if (event.type === "tool_execution_start") ledger.noteToolStart(event.callId, event.input);
		if (event.type === "tool_execution_end") ledger.noteToolEnd(event);

		// On stderr, not stdout: a `-p` run may be piped, and the wait for a retry
		// is not part of the answer being piped. It is still said out loud — the
		// ladder runs for minutes, and silence is what made a wrong key look like a
		// hang rather than a mistake.
		if (event.type === "retry") {
			process.stderr.write(`${formatRetryNotice(event)}\n`);
		}

		if (event.type === "message_update") {
			const text = event.message.content
				.filter((b) => b.type === "text")
				.map((b) => (b as { text: string }).text)
				.join("");
			if (format === "text") {
				const delta = text.slice(lastAssistantText.length);
				if (delta) {
					process.stdout.write(delta);
					lastAssistantText = text;
				}
			} else if (format === "stream-json") {
				emitStreamJson({
					type: "assistant",
					message: event.assistantMessageEvent.type,
					text_delta: event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : undefined,
				});
			}
		}

		if (format === "stream-json" && event.type === "tool_execution_start") {
			emitStreamJson({ type: "tool_use", tool: event.toolName, input: event.input });
		}
		if (format === "stream-json" && event.type === "tool_execution_end") {
			emitStreamJson({
				type: "tool_result",
				tool: event.toolName,
				is_error: event.result.isError,
			});
		}
	});

	/**
	 * The close-out note, at every controlled end of the run.
	 *
	 * The same note the REPL leaves at teardown, read by the next run the same
	 * way: how this one ended, and what it was still holding. The fields mirror
	 * the REPL's call site — a `-p` run has no background shells to count, the
	 * live subagents come from the registry the tools write to, and the
	 * recovered-shell count is this host's structural zero, since it attaches
	 * no shell ledger to recover one from. `reason: "exit"` is the one value
	 * every host writes; a run that dies mid-flight writes nothing at all, and
	 * that absence is how a crash is told from an exit.
	 *
	 * Every controlled exit calls this — the prompt's normal end, an aborted
	 * one, and a prompt a hook blocked before the model — and nothing else
	 * does: a throw out of the run is a crash, and a crash must leave the
	 * session note-less. `--no-session` has no store and stays silent, the way
	 * it writes nothing else. Best effort, like the REPL's: a note that cost
	 * the exit would be worse than a session that closes out in silence.
	 */
	const writeCloseoutNote = (): void => {
		if (!store) return;
		try {
			writeMissionRecord(store, {
				reason: "exit",
				shellsRunning: 0,
				subagentsLive: subagentRegistry.list().filter((handle) => handle.state === "live").length,
				shellsRecovered: 0,
			});
		} catch {
			// best effort — see above
		}
	};

	// UserPromptSubmit gates the single headless prompt. A block exits non-zero
	// without ever reaching the model, so scripted callers can detect it.
	if (hooksRuntime.has("UserPromptSubmit")) {
		const outcome = await hooksRuntime.run("UserPromptSubmit", {
			prompt: options.prompt,
			session_id: sessionId,
			cwd,
		});
		for (const error of outcome.errors) console.error(`Warning: UserPromptSubmit hook failed: ${error}`);
		hookContext.push(...outcome.addedContext);
		if (outcome.blocked) {
			console.error(`[prompt blocked by UserPromptSubmit hook${outcome.reason ? `: ${outcome.reason}` : ""}]`);
			// The run ends here under its own control — the prompt was never sent
			// — so the session closes out like any other controlled ending rather
			// than looking like a run that died.
			writeCloseoutNote();
			const endOutcome = await hooksRuntime.run("SessionEnd", { session_id: sessionId, cwd });
			for (const message of advisoryHookFailures("SessionEnd", endOutcome)) {
				console.error(`Warning: ${message}`);
			}
			await disconnectAllMcpServers(mcpConnections);
			return 1;
		}
	}

	// A typed line that names a prompt-command is expanded before it is sent, the
	// same way the REPL expands it — `-p "/skill-x args"` is how a script reaches
	// a skill. Anything else (a local or app-level command, or a prompt that just
	// happens to start with a slash) is sent as typed; the hook above saw the
	// typed text either way.
	const reason = await session.prompt(expandPromptCommand(commands, options.prompt) ?? options.prompt);
	const finalText = finalAssistantText(session.messages);
	const usage = totalUsage(session.messages);

	if (format === "json") {
		const result: JsonResult = {
			type: "result",
			subtype:
				reason === "completed"
					? "success"
					: reason === "max_turns"
						? "error_max_turns"
						: reason === "aborted"
							? "error_aborted"
							: "error_during_execution",
			// Costed from the transcript's own usage records, against the prices the
			// model resolves to — the same arithmetic `/cost` does, so a scripted run
			// and an interactive one disagree about the bill only if the prices differ.
			// The subagents' spend is added in, and named beside it: their
			// conversations never enter this transcript, so a sum of the messages
			// alone under-reported every run that fanned out.
			cost_usd: costStateFromMessages(session.messages).totalCostUSD + subagentUsage.state.totalCostUSD,
			subagent_cost_usd: subagentUsage.state.totalCostUSD,
			duration_ms: Date.now() - startedAt,
			num_turns: turns,
			result: finalText,
			session_id: store?.sessionId ?? null,
			cache: cacheResult(session.messages, transport.tracker),
		};
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (format === "stream-json") {
		emitStreamJson({
			type: "result",
			reason,
			result: finalText,
			usage,
			cache: cacheResult(session.messages, transport.tracker),
			duration_ms: Date.now() - startedAt,
			session_id: store?.sessionId ?? null,
		});
	} else {
		// text mode already streamed; close cleanly
		process.stdout.write("\n");
		if (reason !== "completed") {
			// The loop's reason first, the transcript's last error second: only the
			// first one can say what to do about a request that was never sent.
			const errorMessage = endErrorMessage ?? findLastError(session.messages);
			console.error(`[session ended: ${reason}${errorMessage ? ` — ${errorMessage}` : ""}]`);
		}
	}

	if (store && format !== "text") {
		console.error(`[session saved: ${store.path}]`);
	} else if (store) {
		console.error(`[session saved: ${store.path}]`);
	}

	// The run is over and ended under its own control, so the close-out note goes
	// down before the teardown below — the same order the REPL writes its own in,
	// and for the same reason: the counts describe the state the run ended in.
	writeCloseoutNote();

	// SessionEnd is last, and its failures never change the exit code.
	const sessionEnd = await hooksRuntime.run("SessionEnd", { session_id: sessionId, cwd });
	for (const message of advisoryHookFailures("SessionEnd", sessionEnd)) {
		console.error(`Warning: ${message}`);
	}
	// The stdio servers are child processes, and the transports are what keep
	// them attached: closing here is the difference between a `-p` run that ends
	// cleanly and one that leaves a server process behind on every invocation.
	await disconnectAllMcpServers(mcpConnections);
	return reason === "completed" ? 0 : reason === "aborted" ? 130 : 1;
}

function finalAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = m.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

function totalUsage(messages: AgentMessage[]): Record<string, number> {
	// `reasoning` is a subset of `output`, reported beside it rather than added
	// into it — the same relationship `Usage` declares on the wire, so a reader
	// can subtract it back out and a sum of the fields never counts it twice.
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		totals.input += m.usage.input ?? 0;
		totals.output += m.usage.output ?? 0;
		totals.cacheRead += m.usage.cacheRead ?? 0;
		totals.cacheWrite += m.usage.cacheWrite ?? 0;
		totals.reasoning += m.usage.reasoning ?? 0;
	}
	return totals;
}

function findLastError(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && m.errorMessage) return m.errorMessage;
		if (m.role === "toolResult" && m.isError) {
			const text = m.content.find((b) => b.type === "text")?.text;
			if (text) return text.slice(0, 200);
		}
	}
	return undefined;
}
