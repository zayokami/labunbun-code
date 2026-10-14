/**
 * Interactive mode: settings hierarchy → model resolution → tools →
 * permission engine + dialog bridge → Ink REPL with app-level commands.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import {
	type ActivityRange,
	type AgentDeps,
	AgentSession,
	type CompactionManager,
	type CompactionTrigger,
	collectActivity,
	collectReadOnlyToolNames,
	compactionThreshold,
	contextBreakdown,
	DEFAULT_MODE_CHOICE,
	describeModeChoice,
	describeNetworkPolicy,
	estimateContextUsage,
	evaluatePermissions,
	findModeChoice,
	formatRetryNotice,
	MODE_CHOICES,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionRule,
	type SandboxMode,
	SessionStore,
	windowStartFor,
} from "@labunbun/agent";
import {
	type AgentMessage,
	apiKeyEnvNames,
	createTrackedStreamFn,
	formatCatalogNotice,
	gatewayProvidersFor,
	type Model,
	missingApiKey,
	refreshModelCatalog,
	repairToolPairing,
	resolveModel,
	THINKING_LEVELS,
	type ThinkingLevel,
	withModelFallback,
} from "@labunbun/ai";
import {
	bindingText,
	DS4_BUTTON_IDS,
	describePadDevice,
	PAD_TOUCH_IDS,
	type PadInputId,
	type PadSource,
	padPalette,
} from "@labunbun/gamepad";
import {
	connectAllMcpServers,
	connectMcpServer,
	disconnectAllMcpServers,
	getPrompt,
	listPrompts,
	listResources,
	loadApprovedMcpServers,
	loadMcpConfig,
	loadProjectMcpServerNames,
	type McpConfigError,
	type McpConnection,
	type McpPrompt,
	type McpPromptBlock,
	type McpResourceContents,
	type McpResourceSummary,
	type McpServerConfig,
	parseMcpServersRecord,
	approveMcpServer as persistMcpApproval,
	readResource,
} from "@labunbun/mcp";
import {
	type AgentTask,
	type BackgroundShell,
	BackgroundShellManager,
	createAllTools,
	defaultOperations,
	describeSandboxBackend,
	describeWritableRoots,
	detectRuntime,
	killPidTree,
	networkConfinement,
	type Operations,
	ReadFileState,
	type SandboxBackend,
	TaskStore,
} from "@labunbun/tools";
import {
	AUTO_THEME_NAME,
	describeEditor,
	editorShadowNotice,
	installStdinTrace,
	liveOutputLines,
	mountRepl,
	opposingEditorKey,
	RESULT_TEXT_CAP,
	type ReplAppHandle,
	resolveBuiltInTheme,
	resolveEditingMode,
	ruleSpecifierFor,
} from "@labunbun/tui";
import { activitySummaryLine } from "./activity-report.ts";
import { createAskUserQuestionTool } from "./ask-user.ts";
import {
	applyAutocompactAction,
	autocompactReport,
	autocompactUsageLine,
	parseAutocompactCommand,
	userSettingsAutocompactIo,
} from "./autocompact.ts";
import {
	BACKGROUND_SHELL_POLL_MS,
	formatShellOutput,
	recoveredStopFailureMessage,
	resolveShellId,
	shellPickerItems,
} from "./background-commands.ts";
import { attachShellNotices } from "./background-notifications.ts";
import { beetleUsage, parseBeetleCommand } from "./beetle.ts";
import { type BeetleSurface, createBeetleSurface, createToolChangeLatch } from "./beetle-commands.ts";
import { cacheStatusLine, formatCacheReport } from "./cache-report.ts";
import { createChatGptCredentialStore, createChatGptCredentials } from "./chatgpt-auth.ts";
import {
	type ChatGptAuthHooks,
	chatGptLoginFlow,
	chatGptSignedInLine,
	clearChatGptSubscription,
} from "./chatgpt-login.ts";
import {
	createToolLedger,
	formatResumeSummary,
	latestTestFailures,
	readToolCheckpoints,
	recordRewind,
	resendCheckpointsAcrossCompaction,
	type TouchedFileReport,
	touchedFileReports,
} from "./checkpoint-log.ts";
import { createClaudeCredentialStore, createClaudeCredentials } from "./claude-auth.ts";
import {
	type ClaudeAuthHooks,
	claudeLoginFlow,
	clearClaudeSubscription,
	completeClaudeLogin,
	type PendingClaudeLogin,
	signedInLine,
} from "./claude-login.ts";
import {
	builtInCommands,
	type Command,
	completeCommands,
	expandPromptCommand,
	findCommand,
	type LocalCommandContext,
} from "./commands.ts";
import {
	type CompactionTuning,
	compactionActivityText,
	compactionPhaseText,
	compactionReceiptLines,
	createCompactionWiring,
	resolveCompactionSummarizer,
} from "./compaction-wiring.ts";
import {
	contextRows,
	contextSummaryLine,
	formatTokens,
	isContextLow,
	lowContextWarning,
	preservedFilesDrift,
} from "./context-report.ts";
import { CostTracker, formatCostReport } from "./cost-tracker.ts";
import {
	detectSubscriptionSignIns,
	missingCredentialNotice,
	NO_SIGN_INS,
	requestPathPermits,
	type SubscriptionSignIns,
	unrunnableSuffix,
} from "./credential-presence.ts";
import { createExitGuard } from "./exit-guard.ts";
import { sessionToMarkdown } from "./export-session.ts";
import { createFileCompleter } from "./file-completions.ts";
import {
	createPadRuntime,
	createPadWatch,
	formatPadStatus,
	isDefaultBinding,
	type PadRuntime,
	padConfigFrom,
	padHeadline,
	padStartupNotice,
} from "./gamepad-runtime.ts";
import { appendHistory, loadHistory } from "./history.ts";
import { advisoryHookFailures, snapshotHooks } from "./hooks.ts";
import { CLI_NAME } from "./index.ts";
import { createMcpToolRefreshHandler } from "./mcp-tool-refresh.ts";
import { loadMemoryFiles } from "./memory.ts";
import { formatMissionSummary, readMissionRecord, writeMissionRecord } from "./mission-ledger.ts";
import { noToolCallingNotice, offeredModels } from "./model-offer.ts";
import {
	budgetVerdict,
	createModelChainResolver,
	modelRefKey,
	resolveRoles,
	roleCeilings,
	roleOrder,
	seatsByRef,
} from "./model-roles.ts";
import { createPlanModeCallbacks, createPlanModeTools, type PlanModeCallbacks } from "./plan-mode.ts";
import {
	readPolicySnapshot,
	resolveStartupAxes,
	savePolicySnapshot,
	sessionRulesFrom,
	storedRules,
} from "./policy-snapshot.ts";
import {
	approveProjectDefinitions,
	type DefinitionKind,
	describeWithheld,
	enclosingRepositoryRoot,
	withheldDefinitionNotice,
} from "./project-trust.ts";
import {
	damagedSessionNotice,
	exitSummaryLine,
	findSession,
	formatMessageCount,
	listSessions,
	loadSessionForResume,
	resolveContinueTarget,
	type SessionSummary,
	shortSessionId,
} from "./session-resume.ts";
import {
	applyCatalogSettings,
	applySettingsEnv,
	collectPermissionRules,
	formatIgnoredKeysNotice,
	type LoadedSettings,
	loadSettings,
	networkAxisFrom,
	type RawSettingsInput,
	resolveMode,
	type Settings,
	shadowedChoiceNotice,
} from "./settings.ts";
import {
	attachShellLedger,
	excludeManagedShells,
	formatShellRecovery,
	isRecoveredShell,
	observeRecoveredShells,
	probePidState,
	type RecoveredShell,
	readShellLedger,
	recoveredShellOutput,
} from "./shell-ledger.ts";
import { createShellPassthrough } from "./shell-passthrough.ts";
import {
	loadSkillsWithNotes,
	type Skill,
	skillDiscoveryBlock,
	skillDiscoveryBudgetChars,
	skillsAsCommands,
	withheldProjectSkills,
} from "./skills.ts";
import { markStartup } from "./startup-trace.ts";
import {
	formatRetryEnding,
	formatSubagentList,
	formatSubagentLog,
	resolveSubagentId,
	subagentPickerItems,
} from "./subagent-commands.ts";
import { formatSubagentRecovery, readSubagentLedger } from "./subagent-ledger.ts";
import { type SubagentHandle, SubagentRegistry, subagentStatus } from "./subagent-registry.ts";
import {
	type AgentDefinition,
	createSubagentTools,
	GENERAL_PURPOSE,
	loadAgentDefinitions,
	type SubagentControl,
	withheldProjectAgents,
} from "./subagents.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { bindTaskStore, restoreTasks, saveTasks } from "./task-snapshot.ts";
import { formatTaskTree } from "./task-tree.ts";
import {
	cachedAppearance,
	loadThemeFiles,
	persistThemeChoice,
	type ResolvedTheme,
	resolveTheme,
	selectableThemeNames,
} from "./theme-file.ts";
import { pruneToolOutput, toolOutputRoot, toolSpillDir, writeToolOutput } from "./tool-output.ts";
import { persistModelChoice, writeUserSettingsNestedPatch, writeUserSettingsPatch } from "./user-settings.ts";
import { runWizard, shouldRunWizard } from "./wizard.ts";

export interface InteractiveOptions {
	modelRef?: string;
	permissionMode?: PermissionMode;
	/**
	 * The other axis. Absent means "derive it from the mode", which is
	 * `DEFAULT_SANDBOX_FOR_MODE` — every mode ships confined, and turning the
	 * confinement off has to be something asked for by name.
	 */
	sandbox?: SandboxMode;
	/**
	 * A `MODE_CHOICES` id. Sets both axes at once, and wins over the two
	 * separate options when they disagree, because a picker entry is one thing
	 * and two contradictory options are not.
	 */
	modeId?: string;
	resumeSessionId?: string;
	/** Continue the most recent session (the --continue flag). */
	continueLast?: boolean;
	cwd?: string;
	/** Theme name: a built-in, a theme file, or "auto". */
	theme?: string;
	/** Home directory for user-owned state; injectable so tests don't touch the real one. */
	home?: string;
	/**
	 * The subscription sign-ins, when the caller already knows them. Absent
	 * (production) means: read the credential stores — but only when the
	 * environment cannot settle the startup model on its own. A test passes a
	 * value so the machine running it — where the operator may well be signed
	 * in — cannot decide what the test sees, and so no test reads a real
	 * keychain.
	 */
	signIns?: SubscriptionSignIns;
	/**
	 * Settings delivered as a JSON object on the command line (`--settings`),
	 * merged over every file tier. Parsed and shape-checked in `main.ts`, where a
	 * malformed value can exit 2 before anything reads it.
	 */
	flagSettings?: RawSettingsInput;
	/**
	 * Read a DualShock 4 this run (the --gamepad flag). Overrides the setting for
	 * one session and writes nothing — a flag that edited the user's file would
	 * make "try it once" impossible.
	 */
	gamepad?: boolean;
	/**
	 * Where the controller comes from. Injected by an end-to-end test, which has
	 * no pad and must not load node-hid; production leaves it out and gets the
	 * real source.
	 */
	padSource?: PadSource;
}

/**
 * A file's text, or null when it cannot be read — one answer for the two
 * readers that compare files against a record: the compaction that fingerprints
 * them, and `/context` that checks the fingerprints against the disk. They must
 * agree about what "unreadable" means, or a file one of them could not open
 * reads as changed to the other.
 */
function readFileOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export async function runInteractive(options: InteractiveOptions = {}): Promise<number> {
	markStartup("interactive: enter");
	// The input trace, when `LBB_INPUT_TRACE` asks for one: installed before any
	// probe or render, so the log holds every handler that ever touched stdin,
	// in order. Off costs one env read when the variable is unset.
	installStdinTrace(process.stdin);
	const cwd = options.cwd ?? process.cwd();
	const home = options.home ?? homedir();

	// ---- first-run setup (before settings load, so it can create them) ----
	// `home` is threaded through both halves: the wizard reads and writes the
	// settings this session is about to load, so a session pointed at another
	// home must not set up the real one.
	if (shouldRunWizard({ home })) await runWizard(cwd, home);

	// ---- settings & providers ----
	const loadedSettings = loadSettings(cwd, options.flagSettings, home);
	const { settings } = loadedSettings;
	markStartup("settings loaded");
	// Say out loud what a file inside this project asked for and did not get —
	// silence here would look like the setting simply didn't work.
	const ignoredNotice = formatIgnoredKeysNotice(loadedSettings.ignoredKeys);
	if (ignoredNotice) console.error(`Warning: ${ignoredNotice}`);
	// Before provider registration and the API-key check below, both of which
	// read process.env — a key configured via settings.env has to be in place
	// by then or it would have no effect at all.
	applySettingsEnv(settings);
	// Models and prices the settings file declares, before anything resolves one.
	applyCatalogSettings(settings);
	markStartup("catalog settings applied");

	// ---- catalog refresh ----
	// Ask each provider what it serves, in the background. Started before the
	// model resolves, because for one kind of provider — the local Ollama
	// daemon, whose catalog exists only in its own answer — resolution has
	// nothing to match until the listing is in. Nothing waits on it unless that
	// happens: the catalog's own table is already usable, and a provider that
	// does not answer leaves it exactly as it was.
	const catalogAbort = new AbortController();
	const catalogRefresh =
		settings.modelDiscovery === false ? undefined : refreshModelCatalog({ signal: catalogAbort.signal });

	// ---- model roles ----
	// `settings.roles`, resolved once: who answers, who plans, who summarizes,
	// where subagents run. Fail-soft — an unknown reference or a missing key
	// warns on stderr and leaves the seat on its host default — because a role
	// is a convenience, and a convenience that stops the app is worse than one
	// that does not apply. The warning lands here, before anything is on screen,
	// where every other startup warning does.
	const resolvedRoles = await resolveRoles(settings.roles, () => catalogRefresh);
	for (const warning of resolvedRoles.warnings) console.error(warning);
	markStartup("roles resolved");

	// ---- model ----
	// Priority, most explicit first: the per-run `--model`, the model the user
	// last chose (written to their settings by `/model`), then `roles.main` —
	// the role stack's statement about what the main seat defaults to — and
	// finally the built-in default, which `roles.main` exists to replace. This
	// is also what keeps `/model` working beside a role: a switch persists to
	// `model`, and a persisted choice outranks the role's default, exactly as
	// the user's explicit ask should.
	const builtinModelRef = "anthropic/claude-sonnet-5";
	const modelRef = options.modelRef ?? settings.model;
	let model = modelRef ? resolveModel(modelRef) : (resolvedRoles.main.model ?? resolveModel(builtinModelRef));
	if (!model && modelRef && catalogRefresh) {
		// A ref the table does not know may be one a provider is about to name:
		// wait for the listing once, then ask again. An explicit ask that still
		// resolves to nothing is a hard error below — the role only ever answers
		// for a seat nothing more explicit filled.
		await catalogRefresh;
		model = resolveModel(modelRef);
	}
	if (!model) {
		console.error(`Unknown model: ${modelRef ?? builtinModelRef}`);
		return 1;
	}
	// Narrowed alias: closures below (hot-swap) read the startup model without
	// re-narrowing.
	const startupModel: Model = model;
	markStartup("model resolved");
	// There is deliberately no credential gate here. The gate that used to
	// `return 1` read only the environment, so it refused exactly the machines
	// that had already done the work `/login` asks for — a subscription-only
	// box could not start. The session now mounts either way: a model that
	// cannot run fails its first prompt the way the request path fails it, and
	// the startup notice below says so before anything is typed.

	// ---- compaction settings ----
	// `settings.compaction`, resolved once: the summarizer is a property of the
	// conversation, not of the session model `/model` swaps, so the wiring is
	// handed the model rather than a reader. A summarizer that will not resolve
	// warns and falls back where an unknown session model above stops the app —
	// compaction degrades; a session that cannot send its first request does not
	// exist. `roles.compaction.model` is the newer spelling of the same choice
	// and wins where both are set; the older key keeps working alone, which is
	// what keeps every configuration written before the role stack did.
	const compactionSettings = settings.compaction;
	const compactionSummarizer = resolvedRoles.compaction.model
		? { model: resolvedRoles.compaction.model }
		: await resolveCompactionSummarizer(compactionSettings?.model, () => catalogRefresh);
	if (compactionSummarizer.warning) console.error(compactionSummarizer.warning);
	// The tuning struct exists when either key named the summarizer: with only
	// `roles.compaction.model` set there are no knobs, but the model still has to
	// travel — a struct built only for `settings.compaction` would leave the role
	// resolved and never read, and the session model would summarize.
	let compactionTuning: CompactionTuning | undefined =
		compactionSettings || compactionSummarizer.model
			? {
					summarizerModel: compactionSummarizer.model,
					reserveTokens: compactionSettings?.reserveTokens,
					thresholdPercent: compactionSettings?.thresholdPercent,
					enabled: compactionSettings?.enabled,
				}
			: undefined;

	// ---- session persistence: resume, continue, or new ----
	let store: SessionStore | undefined;
	/** Said out loud below: a resumed conversation that is missing messages. */
	let damageNotice: string | undefined;
	// The repaired transcript `loadSessionForResume` handed back, kept beside
	// the store so the session below starts from it rather than re-reading the
	// same file raw.
	let resumedMessages: AgentMessage[] | undefined;
	if (options.resumeSessionId) {
		const resumeId = options.resumeSessionId;
		const match = findSession(listSessions(cwd, home), resumeId);
		if (!match) {
			console.error(`Session not found: ${options.resumeSessionId}`);
			return 1;
		}
		const loaded = loadSessionForResume(match.path);
		if (loaded) {
			store = loaded.store;
			damageNotice = damagedSessionNotice(loaded.store, loaded.removed);
			resumedMessages = loaded.messages;
		} else {
			// The file lists — its name is the id — and matches, but nothing can be
			// rebuilt from it: its header is gone. This used to leave the run with
			// no store at all, silently: the exchange stayed in memory and was
			// thrown away when the process exited. A new session is started, and
			// the miss is said out loud.
			console.error(`Could not read session ${resumeId} — starting a new one.`);
			store = SessionStore.startNew(cwd, home);
		}
	} else if (options.continueLast) {
		// --resume wins when both are given; this is the shorthand.
		const target = resolveContinueTarget(cwd, home);
		if (target) {
			const loaded = loadSessionForResume(target.path);
			store = loaded?.store;
			if (loaded) {
				damageNotice = damagedSessionNotice(loaded.store, loaded.removed);
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
	markStartup("store opened");
	// Before the transcript is on screen, so the count the user is about to read
	// is explained rather than contradicted.
	if (damageNotice) console.error(`Warning: ${damageNotice}`);

	// The last run's own close-out note, read from the session being continued:
	// when and why that run ended, and what it was still holding when it did.
	// One line, and it comes before the recovery notices below because it is
	// the context they belong to — a session that ended cleanly knowing it had
	// shells running is a different story from one that died mid-flight. A
	// fresh session has no note to read and says nothing.
	const missionSummary = formatMissionSummary(readMissionRecord(store));
	if (missionSummary) console.error(missionSummary);

	// What the previous run left behind: shells still running with nobody
	// watching them, and shells that ended with nobody watching. Printed here
	// for the same reason as the warning above — a fresh session reads an empty
	// ledger and says nothing.
	let shellRecovery = readShellLedger(store);
	const recoveryNotice = formatShellRecovery(shellRecovery);
	if (recoveryNotice) console.error(`Warning: ${recoveryNotice}`);
	// The same recovered shells in one live array, which is what `/ps` lists,
	// `/stop` splices and the exit guard counts: the buckets are the read's
	// verdicts, this is the set the commands mutate between one screen and the
	// next. Both are reassigned together by a hot swap; nothing else touches it.
	let recoveredShells: RecoveredShell[] = [...shellRecovery.alive, ...shellRecovery.unknown];

	// The other thing a dead process leaves behind: subagent runs that began
	// and were never seen to end. Nothing about them can be revived — a
	// subagent lives in memory, and its conversation was never written down —
	// so the notice says what was left and what to do instead, and says it
	// here with the warning above: a fresh session reads an empty ledger.
	const subagentNotice = formatSubagentRecovery(readSubagentLedger(store));
	if (subagentNotice) console.error(`Warning: ${subagentNotice}`);

	// The recovery protocol's one line: what the resumed ledger says the last
	// run was doing — last call, files touched, failing tests, next step — and
	// where to look next. A fresh session reads an empty ledger and prints
	// nothing, so this needs no --resume branch of its own. stderr, like the
	// notices above: startup context for the transcript that is about to render,
	// not something a pinned REPL frame should hold.
	const resumeSummary = formatResumeSummary(readToolCheckpoints(store.entries));
	if (resumeSummary) console.error(resumeSummary);

	// ---- tools & session ----
	const taskStore = new TaskStore();
	// The list survives the process by living in the session file: this run starts
	// from the plan the last one left, and every change after that is recorded.
	// Read through `store` (not the value it holds now) so `/resume` takes effect.
	bindTaskStore(taskStore, () => store);
	// Read's record of what it has shown, held here for the same reason as the
	// task store above: `hotSwapSession` has to be able to forget it, and the
	// tools it forgets on are the ones `createAllTools` builds from this instance.
	const readState = new ReadFileState();
	// One shared Operations instance: the "!" shell passthrough and the Bash
	// tool must resolve shells and kill process trees identically.
	const ops: Operations = defaultOperations();
	// Owned here rather than inside createAllTools so `/ps` and `/stop` can reach
	// the same shells the Bash tool started; the factory would otherwise make a
	// private manager nobody else can see.
	const backgroundShells = new BackgroundShellManager(detectRuntime(), ops);
	// Every shell this session starts goes onto the session file too, so a
	// later run can find the ones that outlive this process — and stop them.
	const detachShellLedger = attachShellLedger(backgroundShells, () => store);
	// Results too large for the context go here instead of being thrown away, and
	// Read is allowed back into this directory to fetch them.
	const tools = createAllTools(cwd, {
		taskStore,
		readState,
		operations: ops,
		backgroundShells,
		readOnlyRoots: [toolOutputRoot(cwd, home)],
		// Under the root Read is already allowed into, so every pointer a tool
		// result carries is a path Read can open.
		spillDir: toolSpillDir(cwd, home),
		// The Bash tool builds its policy from these. Without `home` the resolver
		// gets nothing and returns no roots, which is the safe direction but means
		// `workspace-write` still cannot reach the temp directory or a package cache
		// — the usability defect these roots exist to close.
		home,
		writableRoots: settings.permissions.additionalDirectories,
	});
	// Best effort, and before anything can spill: an expired file is one the
	// context cannot be pointing at, since nothing has run yet this session.
	pruneToolOutput(cwd, { home });
	markStartup("tool output pruned");
	const sessionRules: PermissionRule[] = [];
	const baseRules: PermissionRule[] = collectPermissionRules(loadedSettings);
	// What the session being opened — or continued — was running under: the rules
	// it granted, and the three axes it moved. Read before the axes resolve,
	// because the snapshot is one of the sources they resolve from. A session with
	// no snapshot yields undefined and changes nothing below.
	const loadedPolicy = store ? readPolicySnapshot(store) : undefined;
	if (loadedPolicy) sessionRules.push(...sessionRulesFrom(loadedPolicy.rules));
	// All three axes, resolved together, from the sources `resolveStartupAxes`
	// documents in order: the flag or picker entry, the session's own snapshot,
	// settings, the default row. The default is `MODE_CHOICES[0]` rather than a
	// hardcoded pair, so "what does this start in" has exactly one answer in the
	// repo.
	//
	// A `modeId` names one row of that table and therefore both axes at once, so
	// it takes precedence over the two separate options: passed together with a
	// contradicting `--permission-mode`, it is the picker entry the user picked.
	const choice = findModeChoice(options.modeId ?? "");
	const {
		mode: requestedMode,
		sandbox: requestedSandbox,
		network: effectiveNetwork,
	} = resolveStartupAxes({
		choice,
		flagMode: options.permissionMode,
		flagSandbox: options.sandbox,
		policy: loadedPolicy,
		settingsMode: settings.permissionMode,
		settingsSandbox: settings.sandbox,
		settingsNetwork: networkAxisFrom(settings),
		fallback: DEFAULT_MODE_CHOICE,
	});
	const {
		mode: effectiveMode,
		sandbox: effectiveSandbox,
		downgradeReason,
	} = resolveMode({ mode: requestedMode, sandbox: requestedSandbox }, loadedSettings);

	/**
	 * Record the policy the session is running under, when it differs from the one
	 * the session file already holds.
	 *
	 * Called at the moments the policy changes rather than on a timer: a grant
	 * (`onAlwaysAllow`), a `/mode`, a Shift+Tab, and the end of a compaction —
	 * which re-roots the chain and so drops the snapshot above the boundary, the
	 * same reason `saveTasks` runs there. All four go through this one function so
	 * the snapshot has one shape and one comparison.
	 *
	 * Read through `sessionRef` and `store` rather than captured, because both are
	 * rebound by an in-app `/resume`: a snapshot taken from a captured session
	 * would record the axes of the conversation the user just left.
	 */
	function persistPolicy(): void {
		const live = sessionRef;
		if (!live) return;
		savePolicySnapshot(store, {
			at: Date.now(),
			rules: storedRules(sessionRules),
			mode: live.permissionMode,
			sandbox: live.sandbox,
			network: live.network,
		});
	}

	let handle: ReplAppHandle | null = null;

	// Memory files (LABUNBUN.md / AGENTS.md), part of the system prompt. `home` is
	// passed rather than left to `homedir()`: the caller may have named one, and a
	// home the code reads but does not honour is how a test run ends up reading
	// the operator's own memory files.
	const memory = loadMemoryFiles(cwd, home);
	markStartup("memory loaded");

	// ---- model fallback chain ----
	// Tracked, so `/cache` can report what the provider actually did with each
	// request. The tracker sees every request the app makes — the loop, the
	// compaction summary, each subagent — because they all come through here.
	// The credentials providers ride along for the same reason: every request
	// that ends at the anthropic or chatgpt-responses adapter gets the
	// subscription mint when one is signed in, and `/login` swaps the stored
	// credential under it.
	const credentials = createClaudeCredentials({ home });
	const chatgptCredentials = createChatGptCredentials({ home });
	const { streamFn: baseStreamFn, tracker: cacheTracker } = createTrackedStreamFn({
		policy: settings.cache,
		credentials,
		chatgptCredentials,
	});
	// The chain handed to the pipeline is computed from the model that failed —
	// the parameter the old fixed list ignored — and descends the order that
	// owns it: the main seat from `roles.main` (still anchored at the role's
	// model when an explicit `--model` moved the session, so the rungs below
	// wherever it landed are walked), then the plan, compaction and light seats
	// for requests they make, and the global `settings.fallbackModels` as the
	// net every one of them shares.
	const globalFallbacks = (settings.fallbackModels ?? [])
		.map((ref) => resolveModel(ref))
		.filter((m): m is NonNullable<typeof m> => Boolean(m));
	const mainSeat = resolvedRoles.main.model ?? model;
	// Which seat owns which model ref, and the ceiling it carries — the lookup
	// the budget gate runs on every request (see the session deps below). Built
	// here from the same resolution as the orders, because the two are one
	// decision: the seat a model belongs to is what decides both where its
	// fallbacks descend from and whose budget it spends.
	const seatTable = seatsByRef(resolvedRoles);
	const roleOrders = [
		roleOrder(mainSeat, resolvedRoles.main.fallback, globalFallbacks),
		...(resolvedRoles.plan.model
			? [roleOrder(resolvedRoles.plan.model, resolvedRoles.plan.fallback, globalFallbacks)]
			: []),
		...(resolvedRoles.compaction.model
			? [roleOrder(resolvedRoles.compaction.model, resolvedRoles.compaction.fallback, globalFallbacks)]
			: []),
		...(resolvedRoles.light.model
			? [roleOrder(resolvedRoles.light.model, resolvedRoles.light.fallback, globalFallbacks)]
			: []),
	];
	const streamFn = withModelFallback(baseStreamFn, createModelChainResolver(roleOrders, globalFallbacks));

	// Compaction, shared with the headless run and every subagent through the
	// same wiring. Recreated on /resume or /model switch — the manager binds to
	// one store and one model's window, so a swap must rebuild it.
	const compactionWiring = createCompactionWiring({
		model,
		store,
		streamFn,
		trimOldToolResults: settings.trimOldToolResults,
		tuning: compactionTuning,
		report: (text) => pushInfo(handle, text),
		// A summary runs for as long as a turn does and used to say nothing at
		// all: the screen sat on "Thinking…" while a full-prefix request was
		// being paid for. The status row is the report while it is in flight; the
		// transcript gets the line that outlives it. `/compact` is the exception
		// to the second half — it prints its own summary of the same event, and
		// two lines for one compaction is the app talking over itself.
		onPhase: async (phase) => {
			// The store directly, the way `pushInfo` does: one word and one clock
			// with no behaviour of their own, and a handle method for them would be
			// a second name for a `set`. The clock is stamped when the pass first
			// says something and cleared with the last word, so the row's seconds
			// span the whole compaction rather than restarting at every phase.
			handle?.store.set((state) => {
				const activity = compactionActivityText(phase);
				return {
					...state,
					contextActivity: activity,
					contextActivitySince: activity === undefined ? undefined : (state.contextActivitySince ?? Date.now()),
				};
			});
			// Only the endings reach the transcript, in the manager's words: the
			// states before them are the row's job, since a line about a wait the
			// row is already showing would outlive the wait. `/compact` is the
			// exception — it prints its own summary of the same ending, and two
			// lines for one compaction is the app talking over itself.
			if ((phase.kind === "done" || phase.kind === "failed") && phase.trigger !== "manual") {
				pushInfo(handle, compactionPhaseText(phase));
			}
			// The receipt: what the pass can prove about itself, under the size line
			// it just printed. One entry rather than a line each, because it is one
			// report — the /compact path prints the same block under its own
			// headline, from `lastVerification`, and the two must read alike.
			if (phase.kind === "done" && phase.trigger !== "manual") {
				pushInfo(handle, compactionReceiptLines(phase.verification).join("\n"));
			}
			// The pass re-rooted the chain before it ended — the boundary hangs off
			// the root, so the chain no longer runs through the task snapshots above
			// it. Putting the list back here is what makes a restart after a summary
			// start from the plan; `done` is the first moment it can, since the
			// manager appends the boundary before it announces the pass as over.
			//
			// The policy goes back for the same reason and in the same breath: the
			// rules the user granted and the axes they chose are above the boundary
			// too, and a summary that cost the session its grants would make /compact
			// a way to be asked everything again.
			//
			// And the same put-back for the other two readers the re-root strands:
			// the file checkpoints `/rewind` restores from, and the shell starts
			// the next resume pairs. Right here for the same reason — `done` is
			// the first moment the boundary is in the file.
			if (phase.kind === "done") {
				saveTasks(taskStore, store);
				persistPolicy();
				resendCheckpointsAcrossCompaction(store);
				// The `PostCompact` event, for anything that wants to know a pass
				// finished. It observes: a failing hook is a line, never a veto, and
				// the sizes it reads are the pair the receipt above prints.
				if (hooksRuntime.has("PostCompact")) {
					const outcome = await hooksRuntime.run("PostCompact", {
						session_id: sessionIdHolder.current,
						cwd,
						trigger: phase.trigger,
						pre_tokens: phase.preTokens,
						post_tokens: phase.postTokens,
					});
					reportHookErrors(handle, advisoryHookFailures("PostCompact", outcome));
				}
			}
		},
		readFile: readFileOrNull,
		preCompact: async (trigger, customInstructions) => {
			if (!hooksRuntime.has("PreCompact")) return { blocked: false };
			const outcome = await hooksRuntime.run("PreCompact", {
				session_id: sessionIdHolder.current,
				cwd,
				trigger,
				// A manual pass's focus argument; undefined for the automatic
				// passes, and dropped from the payload then.
				custom_instructions: customInstructions,
			});
			reportHookErrors(
				handle,
				outcome.errors.map((e) => `PreCompact hook failed: ${e}`),
			);
			return { blocked: outcome.blocked, reason: outcome.reason };
		},
		noteRewrite: (cause) => cacheTracker.note(cause),
	});
	// Read by the setContextInfo closure on every turn boundary.
	const thresholdHolder = {
		current: compactionThreshold({ contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens }),
	};

	/**
	 * What the context indicator measures, and what it measures against.
	 *
	 * The whole request the model will be sent — system prompt and tool schemas
	 * included, not just the transcript: a session with a large toolset carries
	 * thousands of tokens before the user types anything, and an indicator that
	 * reads the messages alone calls that session empty right up until it
	 * compacts. The denominator is the threshold where the session acts, so the
	 * line answers "how much room before this conversation changes shape".
	 */
	function contextInfoFor(target: AgentSession): { usedTokens: number; threshold: number } {
		return { usedTokens: estimateContextUsage(target.currentContext()), threshold: thresholdHolder.current };
	}

	/** Republish the indicator. Anything that changes the context calls this. */
	function refreshContextInfo(target: AgentSession): void {
		handle?.setContextInfo(contextInfoFor(target));
	}

	// ---- user hooks (snapshotted at startup against mid-session injection) ----
	const hooksRuntime = snapshotHooks(settings.hooks);
	markStartup("hooks snapshotted");
	/**
	 * Session-scoped mutable state lives behind holders. An in-app /resume or a
	 * /model switch rebinds them without invalidating any closure that captured
	 * the holder itself.
	 */
	const sessionIdHolder: { current: string | undefined } = { current: store?.sessionId ?? undefined };

	// Context contributed by hooks (SessionStart / UserPromptSubmit). Composed
	// into the next user message at the moment that message is created, so the
	// bytes the transcript holds are the bytes every later request sends.
	const pendingHookContext: string[] = [];

	// ---- SessionStart: runs before the REPL mounts, so its context is
	// available to the very first prompt. Errors are reported, never fatal.
	const sessionStartOutcome = await hooksRuntime.run("SessionStart", {
		session_id: sessionIdHolder.current,
		cwd,
	});
	pendingHookContext.push(...sessionStartOutcome.addedContext);
	const startupHookErrors = advisoryHookFailures("SessionStart", sessionStartOutcome);

	// ---- MCP servers ----
	// User-scoped servers (~/.labunbun/.mcp.json) are trusted like any other
	// setting the user wrote themselves. Project-scoped servers ship with the
	// repo's .mcp.json — a cloned/untrusted repo could otherwise auto-spawn
	// arbitrary commands or connect to arbitrary URLs with zero user action —
	// so they need one-time approval, persisted under the user's home directory
	// (~/.labunbun/projects/<cwd>/mcp-approved.json) where repo contents cannot
	// pre-approve them.
	const mcpLoad = loadMcpConfig(cwd, home);
	// `settings.json`'s `mcpServers` is user-tier (a project file cannot set it),
	// so a name it defines is the user's own configuration and it wins over a
	// project `.mcp.json` entry of the same name — including the gate below:
	// what the user wrote themselves does not need the user's approval.
	const settingsMcp = parseMcpServersRecord(settings.mcpServers, "settings.json");
	const mcpLoadErrors: McpConfigError[] = [...mcpLoad.errors, ...settingsMcp.errors];
	const mcpConfig: Record<string, McpServerConfig> = { ...mcpLoad.servers, ...settingsMcp.servers };
	const projectMcpServerNames = loadProjectMcpServerNames(cwd);
	const approvedProjectMcpServers = loadApprovedMcpServers(cwd, home);
	const approvedMcpServers = new Set(
		Object.keys(mcpConfig).filter(
			(name) =>
				!projectMcpServerNames.has(name) ||
				settingsMcp.servers[name] !== undefined ||
				approvedProjectMcpServers.has(name),
		),
	);
	// Started, not awaited: a connect spawns server processes and waits on
	// their handshakes, and a slow one held the whole window for its startup
	// (measured: five seconds). The session mounts on the local tools; the
	// connections land in this array when they answer — every reader below
	// holds it by reference — and the wiring below moves their tools into the
	// live session at that point, through the same path a mid-session
	// `tools/list_changed` takes.
	const mcpConnections: McpConnection[] = [];
	const mcpConnectStarted = connectAllMcpServers(mcpConfig, approvedMcpServers);
	// Set at the `allTools` snapshot below: the session is then born with the
	// connections already in its list, and no refresh is owed for them.
	let mcpToolsSeededAtBirth = false;
	// One refresh only — from the connect landing or from the mount, whichever
	// is second.
	let mcpToolsRefreshed = false;
	markStartup("mcp connect started");
	const pendingMcpApprovals = [...projectMcpServerNames].filter(
		(name) => settingsMcp.servers[name] === undefined && !approvedProjectMcpServers.has(name),
	);
	/**
	 * A server that changed its tool list mid-session, wired to the live session.
	 * The handler and its reasoning live in `mcp-tool-refresh.ts`, with the test
	 * that holds them; `sessionRef` below is read through the arrow at the call,
	 * never captured, so a `/resume` swap lands the rebuilt list on the live
	 * conversation — the arrow defers evaluation past the declaration below, and
	 * this wiring already relies on that ordering.
	 */
	const onMcpToolsChanged = createMcpToolRefreshHandler({
		getSession: () => sessionRef,
		connections: mcpConnections,
		// Read at the call like the session: the tracker is created above and
		// survives every swap.
		noteCacheChange: (cause) => cacheTracker.note(cause),
	});
	/**
	 * Move the arrived connections' tools into the live session, once, from
	 * whichever side is second — the connect landing, or the mount. Both call
	 * sites below consult this, and the latch makes the pair one refresh. A
	 * session born with the connections already in its list (they landed
	 * before the `allTools` snapshot) needs no refresh at all: the snapshot
	 * flag says so. `sessionRef` is read through the variable, never captured,
	 * for the same reason as the handler above.
	 */
	const refreshMcpToolsOnce = (): void => {
		if (mcpToolsRefreshed || mcpToolsSeededAtBirth) {
			mcpToolsRefreshed = true;
			return;
		}
		if (!sessionRef || mcpConnections.length === 0) return;
		mcpToolsRefreshed = true;
		onMcpToolsChanged();
	};
	// The connections, when they answer: into the array every reader holds by
	// reference, the refresh handler on each, and one refresh for the session
	// that mounted without them. The rejection is handled because there is no
	// caller to hand it to; a failed server already reports itself as an
	// `error` row on its connection.
	void mcpConnectStarted
		.then((connections) => {
			mcpConnections.push(...connections);
			markStartup("mcp connected");
			for (const connection of connections) connection.onToolsChanged = onMcpToolsChanged;
			refreshMcpToolsOnce();
		})
		.catch(() => {});

	// ---- subagents, skills, plan mode ----
	/** The live session. Declared before the tools that read it through a getter. */
	let sessionRef: AgentSession | null = null;
	// The "!" shell passthrough, built after the session for the same reason the
	// tools are: its sandbox and network axes are read through `sessionRef` per
	// run, so a `/mode` or Shift+Tab lands on the next "!" the way it lands on
	// the next Bash call. The root inputs mirror `createAllTools` above (`home`,
	// the configured writable roots), so both paths hand the policy resolver the
	// same facts.
	const shellPassthrough = createShellPassthrough({
		cwd,
		ops,
		sandbox: () => sessionRef?.sandbox ?? effectiveSandbox,
		network: () => sessionRef?.network ?? effectiveNetwork,
		home,
		writableRoots: settings.permissions.additionalDirectories,
	});
	/**
	 * How hard the model should think, seeded from settings and moved by
	 * `/think`. Declared before the session and the Task tool for the same reason
	 * the session is: both read it through a getter, and a change is meant to
	 * land on the very next request either one makes — including requests a
	 * subagent makes while it is still running.
	 */
	let thinkingLevel: ThinkingLevel | undefined = settings.thinkingLevel;
	const agentDefinitions = loadAgentDefinitions(cwd);
	// The host's own registry, so `/subagents` can see lifecycles the REPL
	// did not spawn — the tools hold no display state of their own.
	const subagentRegistry = new SubagentRegistry();
	/**
	 * The ledger every usage record books into, subagents included. Constructed
	 * before the subagent tools because their booking reaches it at spawn time;
	 * construction reads nothing but cwd, and the session seeding happens below,
	 * where the store knows what the conversation holds.
	 */
	const costTracker = new CostTracker(cwd);
	const [taskTool, sendMessageTool, taskStopTool, subagentControl] = createSubagentTools({
		streamFn,
		// Read through the session, not captured: /model swaps the model and
		// /resume swaps the session a sidechain is written into, and a subagent
		// spawned after either must follow the user's choice rather than the one
		// that was in force when the REPL started.
		model: () => sessionRef?.model ?? model,
		// `roles.light`, when the user configured one: the seat subagents run on
		// unless their definition names its own model. A subagent's own
		// compaction window comes from this model, exactly as it would from the
		// parent's — which is why the seat is read here rather than captured.
		lightModel: () => resolvedRoles.light.model,
		resolveModel,
		// Read at the call, not captured: a subagent spawned after a mid-session
		// tool addition (tools/list_changed, or `/mcp approve`) has to see it.
		allTools: () => [...tools, ...mcpConnections.flatMap((c) => c.tools)],
		definitions: () => agentDefinitions,
		store: () => store,
		permissionMode: () => sessionRef?.permissionMode ?? effectiveMode,
		sandbox: () => sessionRef?.sandbox ?? effectiveSandbox,
		network: () => sessionRef?.network ?? effectiveNetwork,
		thinkingLevel: () => thinkingLevel,
		getPermissionRules: () => [...baseRules, ...sessionRules],
		trimOldToolResults: settings.trimOldToolResults,
		compactionTuning,
		report: (text) => pushInfo(handle, text),
		// A subagent's spend, into the same ledger as the session's: its
		// conversation never enters the parent's transcript, so this is the only
		// booking it gets. Persisted at once, like the session's own turn_end.
		onUsage: (provider, modelId, usage, seat) => {
			costTracker.recordUsage(provider, modelId, usage, 0, seat);
			costTracker.persist();
		},
		// The light seat's spending gate, read at every door into a subagent
		// run. The spend is the share this seat itself booked —
		// `roleCostUSD.light`, the only share attributable to a seat — against
		// the ceiling the user set on `roles.light`; a seat with none answers
		// `null` for every call, which is the pre-budget behaviour.
		budgetGate: (role) => {
			const verdict = budgetVerdict(costTracker.sessionState.roleCostUSD[role] ?? 0, {
				role,
				budgetUSD: resolvedRoles[role].budgetUSD,
			});
			return verdict.action === "blocked" ? verdict.message : null;
		},
		registry: subagentRegistry,
		// The subagent's asks join the session's own dialog — one queue for every
		// level. Read through the holder, not captured: the tools are built before
		// `mountRepl` returns, and an ask that somehow landed before the REPL
		// exists must fail closed rather than wait on a dialog that cannot be.
		requestPermission: (toolName, input, source, signal) => {
			const app = handle;
			if (!app) return Promise.resolve(false);
			return app.requestPermission(toolName, input, source, signal);
		},
	});
	// The three tools as one list for every consumer that spreads them; the
	// control rides beside them for the command layer only.
	const subagentTools = [taskTool, sendMessageTool, taskStopTool];
	const { skills, notes: skillNotes } = loadSkillsWithNotes(cwd);
	markStartup("definitions+skills loaded");
	// What the trust gate is withholding for this directory. Project-tier agent
	// definitions and skills load only after one approval (`project-trust.ts`), and
	// these two lists are what the startup notice and `/agents` speak for. The
	// loaders above enforce the gate themselves, so a `-p` run — which has no
	// dialog to approve anything with — fails closed through the same rule.
	const withheldAgents = withheldProjectAgents(cwd, home);
	const withheldSkills = withheldProjectSkills(cwd, home);
	const planCallbacks: PlanModeCallbacks = createPlanModeCallbacks(
		() => sessionRef,
		// The approval dialog is built here rather than handed the handle whole so
		// that it carries the abort race: Esc with the plan on screen ends the
		// turn, and the tool call waiting behind the dialog has to end with it.
		() => {
			const app = handle;
			return app
				? {
						requestPermission: (toolName, input, signal) => requestPermissionOrAbort(app, toolName, input, signal),
					}
				: null;
		},
		// `roles.plan`, when the user configured one: the planning cycle runs on
		// the plan seat and approval moves the session back. The swap carries the
		// consequences of a `/model` switch — the compaction wiring, the threshold
		// and the status row all bind to a model — but not its persistence: enter
		// and exit are a cycle, not a choice, and the user's saved model must come
		// out the way it went in.
		{
			planModel: () => resolvedRoles.plan.model,
			onModelSwapped: (next) => {
				compactionWiring.rebuild(next, store);
				thresholdHolder.current = compactionThreshold({
					contextWindow: next.contextWindow,
					maxOutputTokens: next.maxOutputTokens,
				});
				handle?.setModelName(`${next.provider}/${next.id}`);
				if (sessionRef) refreshContextInfo(sessionRef);
			},
		},
	);
	const planTools = createPlanModeTools(planCallbacks);
	const askUserTool = createAskUserQuestionTool({
		askUser: (questions, signal) => (handle ? askUserOrAbort(handle, questions, signal) : Promise.resolve(null)),
	});

	// Startup list for the session, the system prompt and the pre-session
	// fallbacks; the session's own list then moves with the servers (see
	// `onMcpToolsChanged` above), so this is a seed, not the truth.
	const allTools = [...tools, ...mcpConnections.flatMap((c) => c.tools), ...subagentTools, ...planTools, askUserTool];
	// Whether the birth list above already holds the MCP connections; read by
	// the refresh wiring above.
	mcpToolsSeededAtBirth = mcpConnections.length > 0;

	const systemPrompt = buildSystemPrompt(allTools, {
		cwd,
		platform: process.platform,
		isTTY: true,
		memory: memory.content,
		skills: skillDiscoveryBlock(skills, skillDiscoveryBudgetChars(model.contextWindow)),
	});

	/**
	 * The ledger writer: one entry per finished call, the /rewind snapshots, and
	 * the fingerprints on either side of an Edit or Write. Defined in
	 * `checkpoint-log.ts` and wired from the same event points a `-p` run uses,
	 * so the two modes cannot drift about what a call leaves behind — headless
	 * recorded none of this until the seam existed. Its two mutation notes run
	 * before the user's own hooks below, for the reason stated at each note.
	 */
	const ledger = createToolLedger({ store: () => store, readFile: readFileOrNull });

	/**
	 * Named so a hot-swap can hand the SAME deps object to the next session.
	 * Its closures read only holder-bound or let-bound state (compaction,
	 * store, sessionIdHolder, handle), so they stay correct across swaps.
	 */
	const sessionDeps: AgentDeps = {
		streamFn,
		// Read through the holder on every request, so `/think` lands on the next
		// one rather than the next session.
		thinkingLevel: () => thinkingLevel,
		// Read through the holder rather than a captured id: /resume swaps the
		// session, and the spills belong to whichever one is live.
		spillOutput: (request) => writeToolOutput(request, { cwd, sessionId: sessionIdHolder.current, home }),
		canUseTool: async (toolName, input, ctx) => {
			// The plan gate's read-only answer, taken from the live tool objects
			// rather than from the engine's static name list — see
			// `collectReadOnlyToolNames`. Read per call, not snapshotted at startup,
			// because the session's tools change under it: `/mcp approve` appends the
			// server's tools, and a band starting appends `BandMessage`, which
			// declares itself read-only and must stay admitted in plan mode.
			const readOnlyToolNames = collectReadOnlyToolNames(sessionRef?.tools ?? allTools);
			const decision = evaluatePermissions(toolName, input, {
				mode: ctx.mode,
				sandbox: ctx.sandbox,
				rules: [...baseRules, ...sessionRules],
				cwd,
				readOnlyToolNames,
			});
			if (decision.behavior !== "ask") return decision;
			// No handle means nothing can answer — a `-p` run reached this code, or
			// the REPL is shutting down mid-call. An unresolved ask then fails
			// closed, because a wait that no one is present for is not an approval.
			// This is what the deleted `dontAsk` mode used to be a name for; the
			// real condition was never the mode, it was the absent human.
			if (!handle) {
				return {
					behavior: "deny",
					message: `Permission required and there is no one to ask (${toolName})`,
				};
			}
			// ExitPlanMode and AskUserQuestion do not need permission, they need an
			// answer: each one's own call puts its dialog up and returns what the user
			// said — the plan for approve/reject, the question for a choice. The
			// dialog the default rules would raise here is the same question asked
			// twice, and the second one is the real one. Deny rules and plan mode's
			// own refusals are untouched — they decide above, not as an "ask".
			if (toolName === "ExitPlanMode" || toolName === "AskUserQuestion") {
				return { behavior: "allow" };
			}
			// Notification: the session is about to block on a human. This is
			// the hook users wire to desktop alerts, so it fires before the
			// dialog appears rather than after it resolves.
			if (hooksRuntime.has("Notification")) {
				// The wait belongs to the run, and so does the abort: an interrupt
				// stops waiting on the hook rather than waiting it out — nothing it
				// produces past the abort is read, and the dialog it precedes is
				// about to be withdrawn by the aborted entry check below anyway.
				const outcome = await unlessAborted(
					hooksRuntime.run("Notification", {
						tool_name: toolName,
						tool_input: input,
						session_id: sessionIdHolder.current,
						cwd,
					}),
					ctx.signal,
				);
				// Advisory: a Notification hook cannot veto the dialog.
				if (outcome) reportHookErrors(handle, advisoryHookFailures("Notification", outcome));
			}
			const allowed = await requestPermissionOrAbort(handle, toolName, input, ctx.signal);
			if (!allowed) return { behavior: "deny", message: "User denied permission" };
			// The answer settles the question that was asked. Whether *this* call may run
			// is a separate question, and the mode it was asked under can be gone: the
			// dialog is a blocking wait, and `EnterPlanMode` is concurrency-safe, so a
			// sibling call in the same batch switches modes with this one on screen. The
			// user answered "may I write this" and got a plan-mode promise they were never
			// shown.
			//
			// So the answer is applied, and then re-decided — and only a fresh `deny` is
			// allowed to override it. Narrowing refuses, because that is the direction
			// that matters. Widening changes nothing: the human said yes and the wider
			// mode would have run it without asking. A fresh `ask` is answered by the
			// human who just answered, so there is nothing left to do.
			//
			// (This is the same "recheck after the permission wait" that `pipeline.ts:116`
			// does for aborts, applied to the other thing that can change under the wait.)
			//
			// Only the mode is compared. `evaluatePermissions` does not read `sandbox` at
			// all — the axis exists to pick the policy handed to the process, not to
			// decide a call — so a sandbox change on its own cannot flip this verdict, and
			// a comparison that looks load-bearing but cannot change anything is a thing
			// a reader will come to rely on.
			const live = sessionRef;
			if (live && live.permissionMode !== ctx.mode) {
				const after = evaluatePermissions(toolName, input, {
					mode: live.permissionMode,
					sandbox: live.sandbox,
					rules: [...baseRules, ...sessionRules],
					cwd,
					readOnlyToolNames: collectReadOnlyToolNames(live.tools),
				});
				if (after.behavior === "deny") return after;
			}
			return { behavior: "allow" };
		},
		// The whole decision — threshold, cheap rung, breaker, cache registration
		// and what the user is told — lives in the wiring, shared with `-p` runs
		// and subagents. What is left here is what only the interactive app has:
		// the PreCompact hook, whose veto it reports, and the transcript.
		checkCompaction: compactionWiring.checkCompaction,
		// The spending ceiling, asked before every request of this seat's own
		// loop: the model about to answer names the seat (a model no seat owns
		// is never gated), and the spend is the session's cumulative total at
		// that moment — the conversation in front of the user, subagents
		// included, since their money is booked into the same total. Read
		// through the tracker rather than captured: `/resume` reseeds it and
		// every turn moves it, and `/model` moves which seat is answering.
		checkBudget: ({ model: answering }) => {
			const seat = seatTable.get(modelRefKey(answering));
			if (!seat) return { action: "ok" };
			return budgetVerdict(costTracker.sessionState.totalCostUSD, seat);
		},
		hooks: {
			composeUserMessage: (text) => {
				// Hook-contributed context drains on the message it belongs to, at the
				// moment that message is created — so it is part of the stored
				// transcript and every later request replays it identically. Attaching
				// it to the request instead (which is what the app used to do) put it in
				// the first request of a prompt and left it out of every later one: the
				// prefix diverged at that message, and the whole tail after it was
				// written once and never read.
				//
				// Memory is not here, and that is deliberate: memory is a section of
				// the system prompt, which is the one place that survives a compaction
				// and the one the cache breakpoint covers.
				const hookContext = pendingHookContext.splice(0, pendingHookContext.length);
				if (hookContext.length === 0) return text;
				return `${hookContext.join("\n\n")}\n\n---\n\n${text}`.trimEnd();
			},
			beforeToolCall: async (toolName, input) => {
				// File checkpoint before mutations — powers /rewind — and the
				// before side of the call's own ledger entry, from the same read:
				// a second read here would be a different moment for no reason.
				ledger.noteBeforeMutation(toolName, input);
				if (!hooksRuntime.has("PreToolUse")) return undefined;
				const outcome = await hooksRuntime.run("PreToolUse", { tool_name: toolName, tool_input: input, cwd });
				reportHookErrors(
					handle,
					outcome.errors.map((e) => `PreToolUse hook failed: ${e}`),
				);
				if (outcome.blocked) return { block: true, reason: outcome.reason ?? "Blocked by PreToolUse hook" };
				return undefined;
			},
			afterToolCall: async (toolName, input, result) => {
				// The after side of the call's ledger entry — a file gone or
				// unreadable by now hashes to null, the absence of a fingerprint,
				// which is not a claim about the file.
				ledger.noteAfterMutation(toolName, input, result.isError);
				if (!hooksRuntime.has("PostToolUse")) return undefined;
				const outcome = await hooksRuntime.run("PostToolUse", { tool_name: toolName, tool_input: input, cwd });
				// Advisory: the call already ran, so a block has nothing to stop.
				reportHookErrors(handle, advisoryHookFailures("PostToolUse", outcome));
				return undefined;
			},
		},
	};

	const session = new AgentSession({
		model,
		systemPrompt,
		tools: allTools,
		store,
		cwd,
		permissionMode: effectiveMode,
		sandbox: effectiveSandbox,
		network: effectiveNetwork,
		deps: sessionDeps,
	});
	sessionRef = session;

	// Restore the selected store's transcript for both --resume and --continue.
	// A newly created store simply has no messages yet. A compacted session
	// resumes from its boundary, not from the transcript the summary replaced.
	// When the store came from a file, the repaired read is what goes in: half
	// of a tool call is a request the provider rejects, and the damage notice
	// above has already said that message is gone.
	if (store) {
		session.messages.push(...(resumedMessages ?? store.contextMessages()));
	}

	// ---- cost tracking + context indicator + session-scoped listeners ----
	// "This session" is the conversation being opened, not the project it lives
	// in: a resumed one arrives having already spent what its messages record, and
	// leaving that out would make /cost report less the moment a session continues.
	costTracker.beginSession(store?.messages() ?? []);
	// @-mention file list for the prompt, cached with a short TTL.
	const fileCompleter = createFileCompleter(cwd);
	// Guards against a Stop hook that blocks every turn: each resume is only
	// allowed to be driven by a hook a bounded number of times per session.
	let stopHookResumes = 0;
	const MAX_STOP_HOOK_RESUMES = 10;

	/**
	 * Coding-agent-side session listeners (cost, context indicator, Stop hook).
	 * Extracted so a hot-swap can attach them to the incoming session and drop
	 * the ones on the outgoing one — the store subscription in app.tsx is
	 * rebound separately by setSession.
	 */
	let detachSessionListeners: (() => void) | null = null;
	function attachSessionListeners(target: AgentSession): void {
		// Edge-triggered state for the low-context warning, per attached session:
		// after a hot swap the incoming conversation has its own size.
		let contextLowWarned = false;
		detachSessionListeners?.();
		detachSessionListeners = target.on(async (event) => {
			// The band's setTools rewrite, registered on the main session's own next
			// turn — the latch explains why it cannot register where the change does.
			toolChangeLatch.observe(event);
			// The tool ledger: one `custom` entry per finished call — what ran,
			// whether it worked, the file fingerprints Edit and Write took, the
			// failing tests a failed test run reported, and the next step the
			// board stated. Written from this subscription rather than the loop
			// so the main loop stays untouched; the input is taken at the start
			// event because the end event does not carry one.
			if (event.type === "tool_execution_start") ledger.noteToolStart(event.callId, event.input);
			if (event.type === "tool_execution_end") ledger.noteToolEnd(event);
			if (event.type === "turn_end") {
				costTracker.recordUsage(event.message.provider, event.message.model, event.message.usage);
				costTracker.persist();
			}
			// Tool calls may have created or deleted files; the next user turn should
			// see the tree as it is now, not as it was when they last typed.
			if (event.type === "agent_end") fileCompleter.bust();
			// The one thing that happens between a turn starting and its first token,
			// and it can last minutes: with nothing said here, a provider that is
			// down reads exactly like an app that has hung.
			if (event.type === "retry") {
				pushInfo(handle, formatRetryNotice(event));
			}
			// The loop compacts between requests and emits `turn_start` only after
			// that decision has been applied, so this is the first moment the *new*
			// context's size can be published — the size the request about to go
			// out will carry. Refreshing on the `turn_end` below alone left the row
			// showing the number a summary had already replaced, for a whole turn.
			if (event.type === "turn_start") refreshContextInfo(target);
			if (event.type === "turn_end" || event.type === "agent_end") {
				refreshContextInfo(target);
				// Said once per crossing. A warning repeated on every turn is a
				// warning nobody reads; a compaction — or a /trim — brings the
				// measurement back down and arms it again, which is what makes the
				// next crossing worth mentioning too.
				const info = contextInfoFor(target);
				if (isContextLow(info.usedTokens, info.threshold)) {
					if (!contextLowWarned) {
						contextLowWarned = true;
						pushInfo(handle, lowContextWarning(info.usedTokens, info.threshold));
					}
				} else {
					contextLowWarned = false;
				}
			}
			// Stop: the loop reached a natural end. A hook may send it back to work
			// (e.g. "tests still failing"), which followUp() does by design. Only
			// natural completion is resumable — an abort or error stays stopped.
			if (event.type === "agent_end" && event.reason === "completed") {
				if (hooksRuntime.has("Notification")) {
					const notification = await hooksRuntime.run("Notification", {
						session_id: sessionIdHolder.current,
						cwd,
					});
					reportHookErrors(handle, advisoryHookFailures("Notification", notification));
				}
				if (hooksRuntime.has("Stop")) {
					const outcome = await hooksRuntime.run("Stop", { session_id: sessionIdHolder.current, cwd });
					reportHookErrors(
						handle,
						outcome.errors.map((e) => `Stop hook failed: ${e}`),
					);
					if (outcome.blocked) {
						if (stopHookResumes >= MAX_STOP_HOOK_RESUMES) {
							pushInfo(
								handle,
								`Stop hook asked to continue but the per-session resume limit (${MAX_STOP_HOOK_RESUMES}) is reached.`,
							);
						} else {
							stopHookResumes++;
							const reason = outcome.reason ?? "Stop hook requested that work continue.";
							pushInfo(handle, `Continuing: ${reason}`);
							target.followUp(reason);
						}
					}
				}
			}
		});
	}

	/**
	 * Hot-swap the running REPL onto another saved session (in-app /resume):
	 * abort any in-flight work, rebuild the session and its compaction manager,
	 * rebind holders and listeners, and hand the new session to the UI.
	 *
	 * The incoming session is built with the same system prompt, memory files
	 * included, so there is nothing session-specific to re-inject: whatever the
	 * conversation being left behind had been told to work under, the one
	 * arriving is told too.
	 *
	 * The axes and the rules come from the *incoming* session's own snapshot when
	 * it has one, and from the outgoing session's axes when it does not. The
	 * fallback is what this used to do unconditionally, for the reason given
	 * there: resuming a session used to reset the mode to whatever this process
	 * launched in, so a `/mode agent` picked five minutes ago became `ask` again on
	 * `/resume`. What it could not do is the other half — a session that recorded
	 * `plan` has to arrive in `plan`, or the file says one thing and the screen
	 * another.
	 *
	 * The rules are replaced rather than merged, and that is the security half: a
	 * grant made minutes ago in the conversation being left is scoped to *that*
	 * conversation, and carrying it into another one would answer for a session the
	 * user never granted it in. A session with no snapshot ends up with no session
	 * rules, which is the safe direction.
	 */
	async function hotSwapSession(summary: SessionSummary): Promise<void> {
		const loaded = loadSessionForResume(summary.path);
		if (!loaded || !handle) {
			pushInfo(handle, `Could not load session ${summary.sessionId}`);
			return;
		}
		if (sessionRef?.isRunning) sessionRef.abort();

		const current = sessionRef;
		const incomingPolicy = readPolicySnapshot(loaded.store);
		sessionRules.length = 0;
		if (incomingPolicy) sessionRules.push(...sessionRulesFrom(incomingPolicy.rules));
		const next = new AgentSession({
			model: current?.model ?? startupModel,
			systemPrompt,
			tools: [...(current?.tools ?? allTools)],
			store: loaded.store,
			cwd,
			permissionMode: incomingPolicy?.mode ?? current?.permissionMode ?? effectiveMode,
			sandbox: incomingPolicy?.sandbox ?? current?.sandbox ?? effectiveSandbox,
			network: incomingPolicy?.network ?? current?.network ?? effectiveNetwork,
			deps: sessionDeps,
		});
		next.messages.push(...loaded.messages);

		store = loaded.store;
		sessionIdHolder.current = loaded.store.sessionId ?? undefined;
		// The incoming conversation brings its own spend; without this the new one
		// would open carrying the totals of the session just left.
		costTracker.beginSession(loaded.store.messages());
		// Its cache history starts over with it. The prefix just loaded has nothing
		// to do with the one being left, and holding on to the old one would report
		// a rewind at message 0 of a conversation that never existed — while the
		// numbers above it mixed two sessions' prompts into one ceiling.
		cacheTracker.reset();
		// And so does the tool-change latch: an armed cause belongs to the session
		// being left, and the incoming session's first turn_start would otherwise
		// register it against a request it has nothing to do with.
		toolChangeLatch.reset();
		compactionWiring.rebuild(next.model, loaded.store);
		thresholdHolder.current = compactionThreshold({
			contextWindow: next.model.contextWindow,
			maxOutputTokens: next.model.maxOutputTokens,
		});
		// The strip follows the conversation across the swap: the incoming session
		// brings its own list, and the store stopped being bound to the one being
		// left when `store` was reassigned above.
		restoreTasks(taskStore, loaded.store);
		// The tool array crosses the swap unchanged (`tools: [...current.tools]`
		// above), so without this the incoming conversation would inherit the
		// outgoing one's Read records and its Edit gate would accept a file *this*
		// conversation was never shown. Cleared with the task list, for the same
		// reason: the new conversation starts from what it itself knows, and the
		// safe direction is a re-read.
		readState.clear();
		handle.setTasks(taskStore.summary());
		handle.setSession(next);
		attachSessionListeners(next);
		refreshContextInfo(next);
		sessionRef = next;
		pushInfo(handle, `Resumed session ${shortSessionId(summary.sessionId)} (${loaded.messages.length} messages).`);
		// The incoming session's own shell ledger, read the way startup reads
		// one: the shells the record leaves open belong to whichever session
		// owns it, and `/ps`, `/stop`, `/tasks` and the exit guard all read the
		// set this variable holds — read once at startup, it would otherwise go
		// on describing the session just left. Shells this process itself holds
		// handles for are excluded: they are already listed and already counted,
		// and the incoming file may well record one — it was the live session
		// when the shell started.
		shellRecovery = excludeManagedShells(
			readShellLedger(loaded.store),
			backgroundShells.list().flatMap((shell) => (shell.pid === undefined ? [] : [shell.pid])),
		);
		recoveredShells = [...shellRecovery.alive, ...shellRecovery.unknown];
		const incomingShellNotice = formatShellRecovery(shellRecovery);
		if (incomingShellNotice) pushInfo(handle, `Warning: ${incomingShellNotice}`);
	}

	/** Switch the active model mid-session (/model). Returns false when refused. */
	function switchModel(ref: string): boolean {
		const next = resolveModel(ref);
		if (!next) {
			pushInfo(handle, unknownModelMessage(ref));
			return false;
		}
		// The same helper the band's `canRunModel` reads, and for the same
		// reason: a switch must not refuse what a request would run. On the
		// anthropic wire a sign-in stands in for the key, so only the
		// environment rows can fail this check — an actually-unsigned switch
		// proceeds and its first request names the sign-in the way the
		// adapter's own "not signed in" error does.
		if (!requestPathPermits(next)) {
			pushInfo(handle, `No API key for ${next.provider} — set ${apiKeyEnvNames(next).join(" or ")}. Model unchanged.`);
			return false;
		}
		sessionRef?.setModel(next);
		compactionWiring.rebuild(next, store);
		thresholdHolder.current = compactionThreshold({
			contextWindow: next.contextWindow,
			maxOutputTokens: next.maxOutputTokens,
		});
		try {
			persistModelChoice(ref);
		} catch (error) {
			pushInfo(handle, `Model switched but not saved: ${error instanceof Error ? error.message : String(error)}`);
		}
		handle?.setModelName(`${next.provider}/${next.id}`);
		// Another window, another threshold, and typically another tool budget:
		// the indicator is measured against the model that is now selected.
		if (sessionRef) refreshContextInfo(sessionRef);
		const shadowed = shadowedChoiceNotice(loadedSettings, "model", (path) => shortenHome(path, home));
		pushInfo(handle, `Model: ${ref} — takes effect on the next prompt${shadowed ? ` (${shadowed})` : ""}`);

		// Said after the switch rather than used to refuse it. The picker already
		// hides this row, so reaching it means the user named it deliberately — and
		// a model that cannot call tools is a legitimate thing to want for talking
		// about code. What must not happen is finding out by waiting for a turn that
		// returns prose where a file edit should be, so the fact is on screen first.
		if (next.toolCalling === false) {
			pushInfo(handle, noToolCallingNotice(next));
		}
		return true;
	}

	/**
	 * Move the session's thinking level (/think). Writes the holder the session
	 * reads on every request, and the user settings file the way `/model`
	 * persists its choice — including the notice when a higher tier sets the
	 * same key and will win at the next startup.
	 */
	function setThinkingLevel(level: ThinkingLevel): void {
		thinkingLevel = level;
		try {
			writeUserSettingsPatch({ thinkingLevel: level }, home);
		} catch (error) {
			// Already in effect; only the write failed. Said in the same shape as
			// every other settings write in this file.
			pushInfo(
				handle,
				`Thinking level: ${level} — not saved: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const shadowed = shadowedChoiceNotice(loadedSettings, "thinkingLevel", (path) => shortenHome(path, home));
		pushInfo(handle, `Thinking level: ${level} — takes effect on the next request${shadowed ? ` (${shadowed})` : ""}`);
	}

	// ---- the band (/beetle) ----
	// The band's setTools rewrites go through the latch (see its doc in
	// beetle-commands.ts): armed where the change happens, registered on the
	// main session's own next turn_start.
	const toolChangeLatch = createToolChangeLatch((cause) => cacheTracker.note(cause));
	const beetleSurface = createBeetleSurface({
		notify: (line) => pushInfo(handle, line),
		pushUserEntry: (text) => {
			handle?.store.set((s) => ({ ...s, entries: [...s.entries, { kind: "user", text }] }));
		},
		getSession: () => sessionRef,
		pick: (title, items, initialIndex) =>
			handle ? handle.pickFromList(title, items, { initialIndex }) : Promise.resolve(null),
		home,
		cwd,
		// The picker's annotation asks the same question `/model` does, and the
		// answer is read per opening because `/login` may have landed in between.
		signIns: () => detectSubscriptionSignIns({ home }),
		// The worker table, MCP apart — the split BeetleBandOptions documents; a
		// table that included MCP and the separate list both would hand every
		// seat its MCP tools twice.
		allTools: tools,
		// Read when the band is built (the `/beetle` command), not here at REPL
		// startup: a tool the connections gained in between has to reach the seats.
		mcpTools: () => mcpConnections.flatMap((c) => c.tools),
		streamFn,
		model: () => sessionRef?.model ?? model,
		resolveModel,
		// The request path's rule, read off the shared helper — the band spawns
		// members from its constructor, where an await cannot reach, and the
		// optimistic direction costs a member whose first request names the
		// missing sign-in, which is the same deal the session makes.
		canRunModel: requestPathPermits,
		thinkingLevel: () => thinkingLevel,
		trimOldToolResults: settings.trimOldToolResults,
		compactionTuning,
		permissionMode: () => sessionRef?.permissionMode ?? effectiveMode,
		sandbox: () => sessionRef?.sandbox ?? effectiveSandbox,
		network: () => sessionRef?.network ?? effectiveNetwork,
		getPermissionRules: () => [...baseRules, ...sessionRules],
		noteToolChange: (cause) => {
			toolChangeLatch.arm(cause);
		},
		setStatusCard: (card) => handle?.setStatusCard({ title: card.title, details: card.details }),
		// The same store the board tools (and so every member) already write
		// through — status reads the work, not a copy of it.
		taskBoard: () => taskStore.summary(),
		initialModels: settings.beetle?.models ?? null,
		maxTurns: settings.beetle?.maxTurns,
		maxCostUSD: settings.beetle?.maxCostUSD,
		stallNoticeMinutes: settings.beetle?.stallNoticeMinutes,
	});

	attachSessionListeners(session);
	// Before the first turn: the system prompt and the tool schemas are already
	// part of every request, and a resumed conversation arrives with its history.
	refreshContextInfo(session);

	// ---- command registry ----
	const commands: Command[] = [...builtInCommands(), ...skillsAsCommands(skills)];

	// ---- theme ----
	// Resolved before mounting: "auto" probes the terminal in raw mode, and Ink
	// claims stdin the moment it renders. The probe's answer is cached inside
	// theme-file.ts, so the runs that must not probe — the picker previewing
	// `auto`, `/doctor` naming it — read what this one found.
	const resolvedTheme = await resolveTheme(options.theme ?? settings.theme, cwd, home);

	// ---- controller ----
	// Built before mounting, enabled after: constructing the runtime loads
	// nothing (node-hid is imported by `enable`, which runs once the REPL is on
	// screen), and the bridge has to exist to be handed to the tree that shows
	// the battery and takes the buttons.
	//
	// The bindings are resolved against `appCommandTable` so a `command:` binding
	// naming a command that does not exist is a `/doctor` line rather than a
	// button that does nothing.
	const padConfig = padConfigFrom(
		settings,
		appCommandTable().map(([name]) => name),
	);
	const pad = createPadRuntime(padConfig, {
		palette: padPalette({ accent: resolvedTheme.theme.accent, alert: resolvedTheme.theme.permission }),
		source: options.padSource,
	});
	// The flag wins for this run and is not written anywhere; the setting is the
	// standing answer.
	const padWanted = options.gamepad ?? padConfig.enabled;

	const padWatch = createPadWatch(pad.service, (line) => pushInfo(handle, line));

	// ---- REPL ----
	handle = mountRepl({
		session,
		modelName: `${model.provider}/${model.id}`,
		theme: resolvedTheme.theme,
		vimMode: settings.vimMode,
		emacsMode: settings.emacsMode,
		// Both the registry commands and the app-level ones, so /help and Tab
		// completion cover everything that actually dispatches.
		commandSuggestions: [
			...completeCommands(commands, "").map((c) => [`/${c.name}`, c.description] as [string, string]),
			...appCommandTable(),
		].sort(([a], [b]) => a.localeCompare(b)),
		completeFiles: (query) => fileCompleter(query),
		dirName: basename(cwd),
		cwd,
		// Handed over even when the pad is switched off: the bridge is inert until
		// something enables the service, and `/gamepad on` has to reach a tree that
		// is already mounted. `--gamepad`/off decide whether anything is read, not
		// whether the screen can hear it.
		pad: pad.bridge,
		// Oldest first, which is the order ↑ recall walks backwards through.
		history: loadHistory(cwd),
		onAlwaysAllow: (toolName, input) => {
			// Scoped to what the user was looking at: `Bash(git *)`, not all of Bash.
			// No specifier means the tool could not be scoped, and the rule is the
			// bare tool — which is what every "don't ask again" answer used to mean.
			const specifier = ruleSpecifierFor(toolName, input, cwd);
			// An ask rule at this exact scope is the one thing that would outvote the
			// grant just made: ask is decided above allow, so "ask me every time for
			// `git `" answered earlier would keep raising the dialog this answer just
			// closed. Only the identical scope is dropped — a wider ask (`Bash(git *)`
			// under a `Bash(git commit *)` grant) still speaks for the calls this
			// grant does not name, and dropping it would widen the grant past the
			// answer the user gave.
			for (let i = sessionRules.length - 1; i >= 0; i--) {
				const rule = sessionRules[i];
				if (rule?.behavior === "ask" && rule.toolName === toolName && rule.specifier === specifier) {
					sessionRules.splice(i, 1);
				}
			}
			sessionRules.push({
				toolName,
				specifier,
				behavior: "allow",
				source: "session",
			});
			// And onto the session file, which is what makes the answer outlive the
			// process: a grant is the one decision here the user cannot redo without
			// being asked again, so it is worth the line.
			persistPolicy();
		},
		onAlwaysAsk: (toolName, input) => {
			// The mirror of the grant above, scoped the same way: yes to this call,
			// plus a session rule that keeps the next match of the scope coming back
			// to the dialog. No existing rule is dropped for it: ask is decided above
			// allow, so this rule answers even over a standing grant for the same
			// scope, and the grant stays for the session that no longer holds the ask.
			sessionRules.push({
				toolName,
				specifier: ruleSpecifierFor(toolName, input, cwd),
				behavior: "ask",
				source: "session",
			});
			persistPolicy();
		},
		// Shift+Tab moves both axes without passing through the app layer — the REPL
		// owns that key, and the session has no event for `setMode` — so this is how a
		// change made there reaches the file. The REPL applies it to the session
		// before calling this, which is why nothing is passed: the axes are read from
		// the live session, the same place `/mode`'s persist reads them.
		onModeChange: () => persistPolicy(),
		// Whether the queue may answer a pending request from that grant instead of
		// asking. The queue has already matched the rule; this is the second half —
		// the engine's own answer, under the rules *including* the one just pushed and
		// the mode as it stands now. `sessionRules` is read here rather than captured
		// for the same reason `getPermissionRules` exists on the subagent bridge: the
		// grant is pushed by the `onAlwaysAllow` above, one statement earlier, and a
		// snapshot taken before it would answer without it.
		canAutoResolve: (toolName, input) =>
			evaluatePermissions(toolName, input, {
				mode: sessionRef?.permissionMode ?? effectiveMode,
				sandbox: sessionRef?.sandbox ?? effectiveSandbox,
				rules: [...baseRules, ...sessionRules],
				cwd,
			}).behavior === "allow",
		onSubmitText: async (text) => {
			appendHistory(text, cwd);
			// "!cmd" runs the shell directly — no model, no dialog. The handled
			// verdict keeps the REPL from also pushing a user entry or prompting.
			if (text.startsWith("!")) {
				const command = text.slice(1).trim();
				// The prefix skips the model, not the policy. A deny is a floor in this
				// session — a deny rule, plan mode, or a command the classifier refuses
				// outright — and "I typed it myself" is not a rule that lifts one. An
				// `ask` verdict is treated as answered, because here the person and the
				// author of the command are the same one: a dialog asking "may I run
				// what you just typed" would be theater.
				if (command) {
					const verdict = evaluatePermissions(
						"Bash",
						{ command },
						{
							mode: sessionRef?.permissionMode ?? effectiveMode,
							sandbox: sessionRef?.sandbox ?? effectiveSandbox,
							rules: [...baseRules, ...sessionRules],
							cwd,
						},
					);
					if (verdict.behavior === "deny") {
						pushInfo(handle, `! refused — ${verdict.message}`);
						return { handled: true };
					}
				}
				if (handle) await shellPassthrough.run(command, handle.store);
				return { handled: true };
			}
			// A line addressed to a member while a band is on stage is the user
			// talking to that member — the bus is already the relay, and routing it
			// through the main model would make it two hops and a paraphrase. The
			// surface pushes the user's own line (a handled verdict suppresses the
			// REPL's push) and delivers; hooks do not run for it, because it is not
			// a prompt to this session. Nothing intercepts when no band is active.
			if (beetleSurface.handleMention(text)) return { handled: true };
			if (!hooksRuntime.has("UserPromptSubmit")) return undefined;
			const outcome = await hooksRuntime.run("UserPromptSubmit", {
				prompt: text,
				session_id: sessionIdHolder.current,
				cwd,
			});
			reportHookErrors(
				handle,
				outcome.errors.map((e) => `UserPromptSubmit hook failed: ${e}`),
			);
			// Context a hook attaches to this prompt is composed into the user
			// message the prompt creates, so it is part of the stored transcript
			// rather than a decoration on one request.
			pendingHookContext.push(...outcome.addedContext);
			if (outcome.blocked) {
				return { block: true, reason: outcome.reason ?? "Prompt blocked by UserPromptSubmit hook" };
			}
			return undefined;
		},
		// The same routing for a line typed while the main session runs: the busy
		// path never reaches onSubmitText, so an @-mention would otherwise be
		// steered or queued into the main session. No band or no mention: false,
		// and the line queues exactly as before.
		onMidRunText: (text) => beetleSurface.handleMention(text),
		onMemoryShortcut: (note) => {
			if (!note) return;
			appendMemoryNote(note);
			pushInfo(handle, `Remembered: ${note}`);
		},
		onCommand: (text) =>
			handleCommandDispatch(text, {
				getSession: () => sessionRef,
				handle,
				backgroundShells,
				// The shells the ledger recovered: `/ps` lists them beside this run's,
				// and `/stop` ends one by pid. Re-observed per command — a shell seen
				// to end says so on this screen, not only on the one it was read on —
				// and it is the live array the report counted, so a shell stopped here
				// is gone from the next picker too.
				recoveredShells: observeRecoveredShells(recoveredShells),
				refreshBackgroundShells: publishShells,
				settings,
				cwd,
				sandboxBackend: ops.sandboxBackend,
				home,
				costTracker,
				cache: {
					report: () =>
						formatCacheReport({
							records: cacheTracker.records(),
							model: sessionRef?.model,
							notices: cacheTracker.notices(),
						}),
					statusLine: () => cacheStatusLine(cacheTracker.records(), sessionRef?.model),
					note: (cause: string) => cacheTracker.note(cause),
				},
				baseRules,
				sessionRules,
				persistPolicy,
				commands,
				agentDefinitions,
				withheldAgents,
				withheldSkills,
				subagents: subagentRegistry,
				subagentControl,
				pad,
				padWatch,
				compaction: compactionWiring.manager,
				// The manual pass's veto door — the same hook the automatic pass
				// consults inside the wiring, asked here because `/compact` runs its
				// summary through the manager itself.
				preCompact: (trigger, customInstructions) => compactionWiring.runPreCompact(trigger, customInstructions),
				// `/autocompact` applies the change to this session, not only the
				// file: the manager reads its switch from the config the wiring
				// builds, so one rebuild after the flip is what makes the next
				// check obey the report the command just printed. Mutated in place
				// because the struct is shared with the subagent context and the
				// beetle band — a replaced object would leave them on the old
				// answer at their next spawn.
				applyCompactionSettings: (patch) => {
					if (!compactionTuning) compactionTuning = {};
					Object.assign(compactionTuning, patch);
					compactionWiring.rebuild(sessionRef?.model ?? model, store);
				},
				mcpConnections,
				onMcpToolsChanged,
				mcpConfig,
				mcpLoadErrors,
				pendingMcpApprovals,
				sessionStore: () => store,
				taskSnapshot: () => taskStore.snapshot(),
				loadedSettings,
				theme: resolvedTheme,
				refreshContextInfo,
				memory: memory.content,
				hotSwapSession,
				switchModel,
				thinkingLevel: () => thinkingLevel,
				setThinkingLevel,
				beetle: beetleSurface,
			}),
		// Every exit request the REPL serves -- /exit, /quit, the idle double
		// Ctrl+C -- comes through the guard first, so the question about what
		// is still running is asked with the screen still up. The facts are
		// read fresh per request: shells and subagents start and end between
		// one exit attempt and the next.
		onExitRequest: createExitGuard({
			work: () => ({
				turnRunning: sessionRef?.isRunning === true,
				subagents: subagentRegistry.list().filter((entry) => entry.state === "live").length,
				shells:
					backgroundShells.list().filter((shell) => shell.status === "running").length +
					// Re-observed here too: a recovered shell seen to end is not
					// something exiting would interrupt, and a shell whose probe
					// cannot answer is counted -- the guard must not promise a quiet
					// exit about a shell that may still be running.
					observeRecoveredShells(recoveredShells).filter((shell) => shell.liveness !== "ended").length,
			}),
			cancelPicker: () => handle?.clearPickerRequest(),
			ask: (question) => {
				if (!handle) throw new Error("the REPL is not mounted");
				return handle.askUser([question]);
			},
		}),
	});

	markStartup("REPL mounted");
	refreshMcpToolsOnce();
	// Said out loud, because a definition that was not loaded and a definition that
	// never existed look identical from the prompt: without this line a repository's
	// skill simply stops answering and nothing on screen says there was one. MCP has
	// no equivalent line — a pending server is only visible under `/status` — which
	// is a habit this starts rather than one it copies.
	if (withheldAgents.length + withheldSkills.length > 0) {
		pushInfo(
			handle,
			withheldDefinitionNotice(
				{ agents: withheldAgents.length, skills: withheldSkills.length },
				"repl",
				enclosingRepositoryRoot(cwd),
			),
		);
	}
	// Held-back skill folders, one line each: the same "a definition that was not
	// loaded looks identical from the prompt" reason as the withheld tier above.
	for (const note of skillNotes) pushInfo(handle, `Skill not loaded: ${note}`);

	// MCP config that could not be read, said at startup for the same reason: a
	// `.mcp.json` with a typo used to read as "no servers configured", and the
	// server it defined simply never arrived with nothing on screen to say why.
	for (const error of mcpLoadErrors) pushInfo(handle, `MCP config: ${error.path} — ${error.message}`);

	// A model the machine cannot run fails its first prompt — and that failure
	// is where the story ends unless someone says so first. One line, before
	// the user types: what is missing, and the ways to fix it. The store probe
	// runs only when the environment cannot already answer, so the keychain is
	// never on the startup path of a machine with a key — and a test's signIns
	// seam skips it entirely.
	const startupSignIns =
		options.signIns ??
		(missingApiKey(startupModel) || startupModel.api === "chatgpt-responses"
			? await detectSubscriptionSignIns({ home })
			: NO_SIGN_INS);
	const startupNotice = missingCredentialNotice(startupModel, startupSignIns);
	if (startupNotice) pushInfo(handle, startupNotice);

	// The controller, now that there is somewhere to say what happened. Started
	// after the mount so the first line — including a failure — lands in a
	// transcript that exists; enabling loads node-hid, which is why it is not
	// awaited: the REPL is already interactive, and a missing optional dependency
	// is a status, not an exception.
	if (padWanted) {
		void pad.setEnabled(true).then(() => {
			const notice = padStartupNotice(pad.service.status());
			// Silence when it worked: the pad buzzes to say hello, and an unasked-for
			// line on every startup is how a feature becomes noise.
			if (notice) pushInfo(handle, notice);
		});
	} else {
		// The flag is the run's answer even when it is "no": a session started with
		// `--no-gamepad` over a settings file that says `enabled: true` otherwise
		// keeps a config saying on, and `/gamepad status` and `/doctor` would both
		// describe a pad that nothing is reading. Off is a state, not an absence —
		// and nothing is written, because `/gamepad on` during the run has to be
		// able to turn it back on.
		void pad.setEnabled(false);
	}

	// Task list → UI strip subscription.
	const unsubTasks = taskStore.subscribe(() => {
		handle?.setTasks(taskStore.summary());
	});
	// And the strip's starting state: a restored list is already there before any
	// task changes, so nothing would have pushed it to the UI.
	handle?.setTasks(taskStore.summary());

	/**
	 * Tail lines republished per shell on every tick.
	 *
	 * A budget, not a taste: the watch panel may draw twelve rows, of which two
	 * are its border, one is the honest "as of last poll" line and one is the
	 * shell's own header — eight lines of output for the shell on screen. This
	 * is deliberately per shell and not per selected shell: which one is being
	 * watched is the panel's decision, and handing it a fresh tail for the one
	 * it wants would mean a second publisher and a second cadence.
	 */
	const SHELL_TAIL_LINES = 8;

	/**
	 * Background shells → the status row.
	 *
	 * The manager has no change events, so this polls — the same shape as the task
	 * strip, which is pushed but could equally be polled. `setBackgroundShells`
	 * compares before publishing, so a tick that changed nothing costs one array
	 * walk and no render. Killing a shell publishes immediately rather than
	 * waiting out the interval: the row disappearing is the confirmation the
	 * command worked.
	 *
	 * Each row carries the end of the shell's own output as well, because the
	 * tail lives on disk in the manager and only this layer may read it — the
	 * panel that draws it is a render of what it was handed and nothing else.
	 */
	const publishShells = () => {
		handle?.setBackgroundShells(
			backgroundShells.list().map((shell) => ({
				id: shell.id,
				command: shell.command,
				status: shell.status,
				tail: liveOutputLines(backgroundShells.output(shell.id), SHELL_TAIL_LINES),
			})),
		);
	};
	const shellPoll = setInterval(publishShells, BACKGROUND_SHELL_POLL_MS);
	// A poll must not be the reason the process stays alive.
	shellPoll.unref();
	publishShells();

	// And the other half of that status row: when a shell finishes on its own,
	// the session is told instead of being polled for it. `getSession` rather
	// than the session itself because a `/resume` swaps it, and the setting is
	// read per completion for the same reason — the value in force is the one
	// at the moment there is something to report. A completion also publishes
	// the row immediately, so "finished" appears when it happens rather than at
	// the next tick, matching the kill path.
	const detachShellNotices = attachShellNotices({
		manager: backgroundShells,
		getSession: () => sessionRef,
		enabled: () => settings.backgroundShellNotifications !== false,
		onNotice: (text) => {
			publishShells();
			pushInfo(handle, text);
		},
	});

	// SessionStart ran before the REPL existed, so its failures surface now.
	reportHookErrors(handle, startupHookErrors);
	// Silently running in a weaker mode than the one asked for would be the
	// worst outcome here, so the veto is stated explicitly.
	if (downgradeReason) pushInfo(handle, `Warning: ${downgradeReason}`);
	// The catalog refresh started before there was anywhere to put an answer.
	if (catalogRefresh) {
		void catalogRefresh
			.then((refresh) => {
				const notice = formatCatalogNotice(refresh);
				if (notice) pushInfo(handle, notice);
			})
			.catch((error: unknown) => {
				// Fire-and-forget, but not silent: the refresh promises not to throw,
				// so a rejection here is a bug in it, and the only place it can be
				// seen is the screen.
				pushInfo(handle, `Model catalog refresh failed: ${error instanceof Error ? error.message : error}`);
			});
	}

	await handle.waitUntilExit();
	// ---- Close-out: the note the next run reads. Written the moment the REPL
	// is done, while the session is still whole — the shell ledger's detach
	// below is about to stop feeding it, and the counts have to describe the
	// state this run actually ended in, not the state after its own teardown
	// began dismantling it. Best effort, like the ledger writes: a note that
	// cost the teardown would be worse than a session that closes out in
	// silence. `store` is read through the variable, so a `/resume` earlier in
	// the run means the note lands in the session it swapped to.
	try {
		writeMissionRecord(store, {
			reason: "exit",
			shellsRunning: backgroundShells.list().filter((shell) => shell.status === "running").length,
			subagentsLive: subagentRegistry.list().filter((entry) => entry.state === "live").length,
			shellsRecovered: observeRecoveredShells(recoveredShells).filter((shell) => shell.liveness !== "ended").length,
		});
	} catch {
		// best effort — see above
	}
	// Nothing is waiting for the answer, and an in-flight request would hold the
	// process open after the user has quit.
	catalogAbort.abort();
	unsubTasks();
	detachShellNotices();
	detachShellLedger();
	clearInterval(shellPoll);
	// A band member mid-request is an in-flight request like any other, and
	// nothing is waiting for its answer once the user has quit.
	beetleSurface.shutdown();
	// Same reason, and one more: an open HID handle outlives the event loop's
	// interest in it, so a pad left open would keep the process from exiting.
	padWatch.stop();
	pad.close();

	// MCP stdio servers are child processes, and a transport left open is a child
	// left behind a REPL that has already quit. Best effort — a close that fails
	// must not hold the exit — and before the summary below, so the line about how
	// to come back is written while nothing else is still unwinding.
	// The startup connect may still be in flight when the window closes: give
	// it a moment to land so its servers are closed rather than orphaned, but
	// never hold a quit for the full connect budget.
	await Promise.race([mcpConnectStarted.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
	await disconnectAllMcpServers(mcpConnections);

	// How to come back to this conversation. Printed here rather than through the
	// REPL because the Ink frame owns the screen: a line written while it is up is
	// erased by the next render and never reaches the scrollback the user is about
	// to read. Only when there is something to resume, and only on a terminal.
	const summary = exitSummaryLine({
		sessionId: sessionIdHolder.current,
		messageCount: sessionRef?.messages.length ?? 0,
		cliName: CLI_NAME,
	});
	if (summary && process.stdout.isTTY) process.stdout.write(`\n${summary}\n`);

	// ---- SessionEnd: the UI is gone, so failures go to stderr. Never fatal —
	// a broken cleanup hook must not change the process exit code.
	const sessionEndOutcome = await hooksRuntime.run("SessionEnd", {
		session_id: sessionIdHolder.current,
		cwd,
	});
	for (const message of advisoryHookFailures("SessionEnd", sessionEndOutcome)) {
		console.error(`Warning: ${message}`);
	}
	return 0;
}

/**
 * Ask the UI for permission, with the run's abort as a second way out.
 *
 * Waiting for an answer is the one pipeline stage that depends on a human, and
 * the run can be aborted while the dialog is up (Ctrl+C, a hot-swap on /resume).
 * Without the race, that wait would outlive the run: the tool batch awaits this
 * call, so the turn would sit unfinished behind a question that no longer means
 * anything, and the next prompt would queue behind a session still marked
 * running. On abort the pending dialogs are denied and dismissed, which fails
 * closed and lets the aborted turn settle.
 */
async function requestPermissionOrAbort(
	handle: ReplAppHandle,
	toolName: string,
	input: unknown,
	signal?: AbortSignal,
): Promise<boolean> {
	const answer = handle.requestPermission(toolName, input);
	if (!signal) return answer;
	if (signal.aborted) {
		handle.clearPermissionRequest();
		return false;
	}

	let onAbort: (() => void) | undefined;
	const abort = new Promise<boolean>((resolve) => {
		onAbort = () => resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([answer, abort]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		// Deny anything still queued: whatever is left belongs to the aborted run.
		if (signal.aborted) handle.clearPermissionRequest();
	}
}

/**
 * Ask the user a question, with the run's abort as a second way out.
 *
 * The same race as `requestPermissionOrAbort` and for the same reason: the tool
 * batch awaits this call, so a question left on screen after the run was
 * aborted holds the turn open behind a dialog that no longer means anything —
 * and Ctrl+C does not check for one before aborting. Cancelling lands as
 * "dismissed", which is what the tool tells the model, and the turn settles.
 *
 * No guard for a signal that is already aborted, unlike the permission twin
 * above: this one is only ever reached from a tool body, and the pipeline
 * rechecks the signal immediately before invoking the tool (stages 0, 2, 3 and
 * again after the permission wait), with no await in between — so an abort
 * cannot arrive while this call is being entered. The permission twin runs
 * inside `canUseTool`, which awaits the Notification hook first, so it does
 * need one: a listener added to an already-aborted signal never fires, and the
 * race below would wait forever on an answer nobody can give.
 */
async function askUserOrAbort(
	handle: ReplAppHandle,
	questions: Parameters<ReplAppHandle["askUser"]>[0],
	signal?: AbortSignal,
): Promise<string[] | null> {
	const answer = handle.askUser(questions);
	if (!signal) return answer;

	let onAbort: (() => void) | undefined;
	const abort = new Promise<null>((resolve) => {
		onAbort = () => resolve(null);
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([answer, abort]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
		// Whatever is still on screen belongs to the aborted run.
		if (signal.aborted) handle.clearQuestionRequest();
	}
}

/**
 * Await `promise`, unless the run aborts first — then undefined.
 *
 * For waits whose product is a dialog: nothing past an abort reads the result,
 * and holding the wait open only delays settling the turn behind it. The work
 * is not cancelled — a spawned Notification hook runs to its own end — it just
 * stops being waited on; a rejection that lands after the abort is dropped
 * with the result, since there is no caller left to report it to.
 */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
	if (!signal) return promise;
	if (signal.aborted) {
		promise.catch(() => {});
		return Promise.resolve(undefined);
	}
	return new Promise<T | undefined>((resolve, reject) => {
		const onAbort = () => resolve(undefined);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** Surface hook failures in the transcript without interrupting the session. */
function reportHookErrors(handle: ReplAppHandle | null, messages: string[]): void {
	for (const message of messages) {
		pushInfo(handle, `Warning: ${message}`);
	}
}

function appendMemoryNote(note: string): void {
	const path = join(homedir(), ".labunbun", "MEMORY.md");
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `- ${note}\n`, "utf8");
	} catch {
		// best-effort
	}
}

interface CheckpointInfo {
	entryId: string;
	path: string;
	at: number;
	content: string;
}

/** The checkpoints a session holds, and the entries under the same kind it cannot read. */
interface CheckpointListing {
	checkpoints: CheckpointInfo[];
	/**
	 * Entries this build cannot turn into a restore — a damaged line, or a
	 * payload another writer left. Counted rather than dropped in silence, so
	 * `/rewind` can say the file has something it is not showing.
	 */
	unreadable: number;
}

function listCheckpoints(store: SessionStore): CheckpointListing {
	const checkpoints: CheckpointInfo[] = [];
	let unreadable = 0;
	for (const entry of store.linearEntries()) {
		if (entry.type !== "custom" || entry.kind !== "file_checkpoint") continue;
		// Data read back from the file is checked rather than trusted. The
		// content is about to be written over a real file, and defaulting a
		// missing field used to write the empty string over the file the entry
		// named — a restore that silently truncated it instead.
		const data: unknown = entry.data;
		if (typeof data !== "object" || data === null) {
			unreadable++;
			continue;
		}
		const record = data as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.content !== "string" || typeof record.at !== "number") {
			unreadable++;
			continue;
		}
		checkpoints.push({ entryId: entry.id, path: record.path, at: record.at, content: record.content });
	}
	return { checkpoints, unreadable };
}

/**
 * One row of `/checkpoint`'s file list: the verdict, the path, and — where the
 * verdict is not "unchanged" — what the verdict means. The four states are the
 * ones `preservedFilesDrift` names for a compaction's fingerprints, because it
 * is the same question one level down.
 */
function touchedFileLine(report: TouchedFileReport): string {
	const note =
		report.state === "changed"
			? " — no longer matches the hash the last call recorded"
			: report.state === "missing"
				? " — not on disk now (deleted, moved, or unreadable)"
				: report.state === "unfingerprinted"
					? " — the last call took no hash"
					: "";
	return `${report.state.padEnd(15)}${report.path}${note}`;
}

interface AppCommandContext {
	/** The live session, read at dispatch time — /resume may have swapped it. */
	getSession(): AgentSession | null;
	handle: ReplAppHandle | null;
	/** The shells the Bash tool started; `/ps` and `/stop` act on these. */
	backgroundShells: BackgroundShellAccess;
	/**
	 * Shells a previous run left running, recovered from the session ledger.
	 * They are offered beside this run's shells; stopping one goes by pid,
	 * because there is no handle here for a process from another process.
	 */
	recoveredShells?: RecoveredShell[];
	/** Republish the status row after a shell changes state outside the poll. */
	refreshBackgroundShells(): void;
	settings: Settings;
	/**
	 * The same settings with their tiers kept. `/theme`, `/model` and `/vim` all
	 * write the user file, and a project, local or managed file setting the same
	 * key wins at the next startup — which the confirmation has to say, or it
	 * reports a save that will be gone by tomorrow.
	 */
	loadedSettings: LoadedSettings;
	cwd: string;
	/**
	 * What confines commands run through this session's exec backend, if it can
	 * say. `/permissions` is the screen a user opens to find out what is actually
	 * holding the session in, and the sandbox axis is half of the answer — so it
	 * has to come from the same `Operations` the Bash tool spawns through rather
	 * than from a second look at `process.platform`, which is how the sentence
	 * would come to describe a machine other than the one running.
	 *
	 * Optional because a context built by hand has no exec backend behind it, and
	 * an absent answer renders as "simulated" rather than as the good news.
	 */
	sandboxBackend?: SandboxBackend;
	/** Home directory for user-owned state (MCP approvals). Defaults to the real one. */
	home?: string;
	costTracker: CostTracker;
	/**
	 * Cache diagnostics, when this session tracks them.
	 *
	 * Optional because a context assembled by hand — a test, an embedder that
	 * built its own stream function — has no tracker behind it, and `/cache` has
	 * to answer rather than throw. It answers that there is nothing to report.
	 */
	cache?: {
		report(): string;
		statusLine(): string;
		/**
		 * Declare a prefix rewrite before making it.
		 *
		 * A command that replaces part of the transcript is doing it on purpose, and
		 * the cache report has no other way to know that: a rewind the app meant and
		 * a rewind nothing admitted to look the same from the wire, and only the
		 * second is a bug.
		 */
		note?(cause: string): void;
	};
	baseRules: PermissionRule[];
	sessionRules: PermissionRule[];
	/**
	 * Record the session's policy — the rules and the three axes — in the session
	 * file. Called by `/mode`, which is the one command that moves the axes.
	 *
	 * Optional because a context assembled by hand has no session file behind it
	 * and nothing to record into; `/mode` has to work there exactly as it does
	 * with one, which is also why the call site reads it as optional rather than
	 * assuming it. Supplied by `runInteractive`, where it is `persistPolicy`.
	 */
	persistPolicy?(): void;
	commands: Command[];
	/**
	 * The live definition lists, the same arrays the session's tools read:
	 * the Task tool resolves a `subagent_type` against `agentDefinitions` at the
	 * call, and `/agents approve` pushes into it and into `commands` so an
	 * approval takes effect without a restart.
	 *
	 * `withheld*` are the project-tier lists the trust gate is holding back —
	 * spliced empty by the approval that loads them, so a second `/agents approve`
	 * has nothing to add and says so.
	 */
	agentDefinitions: AgentDefinition[];
	withheldAgents: AgentDefinition[];
	withheldSkills: Skill[];
	/**
	 * The subagent lifecycle table the Task tool records into; `/subagents`
	 * is the one screen that says what every spawned subagent is doing.
	 */
	subagents: SubagentRegistry;
	/**
	 * The same fleet, from the acting side: `/subagents stop|retry` ends and
	 * restarts runs with the mechanics TaskStop and Task use — one
	 * implementation of each, which is the point of holding it here.
	 */
	subagentControl: SubagentControl;
	/**
	 * The controller, when this session has one. Null only for a caller that
	 * builds a context without one — every interactive session has a runtime,
	 * switched on or not, because `/gamepad on` has to be able to reach it.
	 */
	pad: PadRuntime | null;
	/** `/gamepad watch`'s on/off, which is state rather than a subscription. */
	padWatch: { toggle(): boolean; stop(): void };
	/** Read at dispatch time; a swap or model switch rebuilds the manager. */
	compaction(): CompactionManager;
	/**
	 * The `PreCompact` hook for the passes a command runs itself, `/compact`
	 * being the one. The wiring consults the same hook inside `checkCompaction`;
	 * this door exists so the manual pass is stoppable by it too. Optional
	 * because a context assembled by hand has no hooks behind it.
	 */
	preCompact?(trigger: CompactionTrigger, customInstructions?: string): Promise<{ blocked: boolean; reason?: string }>;
	/**
	 * `/autocompact` applies a settings change to the running session, not only
	 * to the file: the manager reads its switch and its trigger line from the
	 * config the wiring builds, so this flips the tuning struct and rebuilds —
	 * the next check then behaves like the command's own report says it will.
	 * Optional because a context assembled by hand has no wiring to rebuild.
	 */
	applyCompactionSettings?(patch: { enabled?: boolean; thresholdPercent?: number }): void;
	mcpConnections: McpConnection[];
	/**
	 * The tool-list-change handler the startup connections carry (see
	 * `mcp-tool-refresh.ts`). Optional because a context assembled by hand — a
	 * test, an embedder — has no live session to rewrite; `/mcp approve` only
	 * uses it to wire the connection it just opened, so a server approved
	 * mid-run gets its later changes into the session like any other.
	 */
	onMcpToolsChanged?: () => void;
	mcpConfig: Record<string, McpServerConfig>;
	/** Config files (and `settings.json` entries) that could not be read, for /mcp to name. */
	mcpLoadErrors: McpConfigError[];
	pendingMcpApprovals: string[];
	sessionStore(): SessionStore | undefined;
	/**
	 * The session's task list, as copies, for `/checkpoint`. Optional because a
	 * context built by hand — a test, an embedder — has no board behind it, and
	 * the report has to say "none" rather than throw.
	 */
	taskSnapshot?(): AgentTask[];
	/** Theme resolved at startup; `/theme` reads its name and available list. */
	theme: ResolvedTheme;
	/** Republish the context indicator for a session whose context just changed. */
	refreshContextInfo(target: AgentSession): void;
	/** The memory files as loaded, which the system prompt carries; `/context` sizes them. */
	memory?: string;
	hotSwapSession(summary: SessionSummary): Promise<void>;
	switchModel(ref: string): boolean;
	/** The thinking level in force, read at dispatch time — `/status` and bare `/think` show it. */
	thinkingLevel(): ThinkingLevel | undefined;
	/** Set it (/think): the holder the session reads, and the user file. */
	setThinkingLevel(level: ThinkingLevel): void;
	/**
	 * The /beetle surface. Optional because a context built by hand — a test, an
	 * embedder without the REPL — has no band behind it, and `/beetle` has to
	 * answer rather than throw.
	 */
	beetle?: BeetleSurface;
	/**
	 * The Claude subscription surface, for `/login` and `/logout`. Optional
	 * because a context built by hand — a test, an embedder — has to be able
	 * to drive both commands without a browser, a network, or the keychain of
	 * the machine running the tests: a `/logout` that reached the real store
	 * would sign the operator out of their own subscription, which from the
	 * test runner's side is indistinguishable from working code.
	 */
	claudeAuth?: ClaudeAuthHooks;
	/**
	 * The ChatGPT subscription surface, for `/login chatgpt` and
	 * `/logout chatgpt`. Optional for the same reason as `claudeAuth` above:
	 * a context built by hand has to be able to drive both commands without a
	 * browser, a network, or the operator's own keychain.
	 */
	chatgptAuth?: ChatGptAuthHooks;
}

function handleCommandDispatch(text: string, ctx: AppCommandContext): boolean {
	const [rawName, ...rest] = text.split(/\s+/);
	const args = rest.join(" ");

	// Registry commands first (prompt-type expands into a model prompt).
	const command = findCommand(ctx.commands, rawName);
	if (command) {
		const session = ctx.getSession();
		if (!session) return true;
		if (command.type === "prompt") {
			ctx.handle?.store.set((s) => ({
				...s,
				entries: [...s.entries, { kind: "user", text }],
			}));
			// Expanded through the shared helper rather than `command.getPrompt`
			// directly: a `-p` run sends the same expansion for the same typed line,
			// and two call sites for one meaning is how they drift.
			void session.prompt(expandPromptCommand(ctx.commands, text) ?? text);
			return true;
		}
		const localCtx: LocalCommandContext = {
			session,
			compaction: ctx.compaction(),
			preCompact: async (trigger, customInstructions) =>
				(await ctx.preCompact?.(trigger, customInstructions)) ?? { blocked: false },
			cwd: ctx.cwd,
			pushInfo: (info) => pushInfo(ctx.handle, info),
			home: ctx.home,
			dialog: ctx.handle ?? undefined,
			refreshContext: () => ctx.refreshContextInfo(session),
			// `/compact` and `/trim` both replace part of the transcript, and the
			// cache report reads better naming them than flagging them.
			noteCacheRewrite: (cause) => ctx.cache?.note?.(cause),
		};
		void Promise.resolve(command.call(localCtx, args))
			.then((result) => {
				if (typeof result === "string" && result) pushInfo(ctx.handle, result);
			})
			.catch((error: unknown) => {
				// Fire-and-forget, but not silent: a command that throws is the user's
				// only signal that what they asked for did not happen.
				pushInfo(ctx.handle, `/${command.name} failed: ${error instanceof Error ? error.message : error}`);
			});
		return true;
	}

	return handleAppCommand(text, ctx);
}

/**
 * What each mode means, in the one line `/mode`'s list has room for.
 *
 * There is no second list. The hint lives on the `ModeChoice` it describes, and
 * `hint` is a required field, so the compiler is what notices a mode that has a
 * name and no explanation. `PERMISSION_MODE_HINTS` used to be a hand-written
 * `Record<PermissionMode, string>` with the modes spelled out again, and the two
 * could drift — which is the one thing `types.ts` claimed could not happen.
 *
 * `PERMISSION_MODES` itself is now unused here: `/mode` takes choice ids, and
 * the two are the same list wearing different names.
 */
function choiceForMode(mode: string): (typeof MODE_CHOICES)[number] | undefined {
	if (!(PERMISSION_MODES as readonly string[]).includes(mode)) return undefined;
	// The confined row for that mode. `agent`'s first entry is the sandboxed one,
	// so `/mode agent` can never be the row that turns the sandbox off — the only
	// way there is naming `agentNoSandbox` in full.
	return MODE_CHOICES.find((choice) => choice.mode === mode && choice.sandbox === "workspace-write");
}

/**
 * One short line naming both axes, for the status card and `/status`.
 *
 * It is `describeModeChoice` — the same function the prompt's badge and
 * Shift+Tab's label go through. It used to be a second copy living here, which
 * meant the name of a mode had two answers: a card could say "Agent 无沙箱"
 * while the prompt under it said `agent · danger-full-access`, and nothing in
 * either file would have noticed, because each was right on its own. The table
 * is in `@labunbun/agent` and so is the one function that reads it.
 */
const describeAxes = describeModeChoice;

/**
 * What `/think` and `/status` say when no level is set. One phrasing because
 * the two answer the same question, and a card disagreeing with a command
 * about the same state is a bug report about state, not about wording.
 */
function describeThinkingLevel(level: ThinkingLevel | undefined): string {
	return level ?? "unset — each model's own default";
}

/**
 * Tell the prompt which mode it is in, if there is a prompt to tell.
 *
 * The method is required on `ReplAppHandle`, and it is still called optionally
 * here. `/mode`'s job is to move the session's two axes, and that has already
 * happened by the time this runs — a handle that cannot carry a label (an
 * embedder's, or a test's hand-built one, which reaches the context through an
 * `as unknown as` cast and so never learns the method was added) should cost
 * the prompt's badge, not the command. `handle?.setModeLabel?.(label)` rather
 * than `handle?.setModeLabel(label)`: the outer `?.` guards the handle being
 * absent, and the inner one is the part that is actually load-bearing.
 */
function publishModeLabel(handle: ReplAppHandle | null, label: string): void {
	handle?.setModeLabel?.(label);
}

/**
 * App-level commands, which live in `handleAppCommand`'s switch rather than in
 * the command registry. `/help` is generated from the command table, so a
 * command missing from this list is a command the user cannot discover — that
 * was the `/theme` bug. The switch below is the source of truth for behaviour;
 * `appCommandTable` keeps `/help` in step with it, and a test asserts the two
 * agree so a new `case` cannot be added without a description.
 */
export function appCommandTable(): Array<[string, string]> {
	return [
		["/activity", "Show a heatmap of the days you used this, and the streak: /activity [7d|30d|all]"],
		["/agents", "List agent definitions, and load this project's: /agents [approve]"],
		["/autocompact", "Switch the automatic compaction passes and their trigger line: /autocompact [on|off|<percent>]"],
		[
			"/beetle",
			"Run a four-agent band that works until stopped: /beetle [<task>|status|off|models|say <member> <text>]",
		],
		["/cache", "Show prompt-cache hit rate, its ceiling, and any prefix rewinds"],
		["/checkpoint", "Show the tool ledger: the last call, files touched, tasks, and context use"],
		["/context", "Show what the context window is made of, and what is left"],
		["/cost", "Show token usage and cost for this conversation, then for this project"],
		["/doctor", "Check the environment, settings, and provider setup"],
		["/emacs", "Turn modeless emacs editing in the prompt on or off: /emacs [on|off]"],
		["/export", "Export this session to a Markdown file: /export [path]"],
		["/fork", "Branch the session from an entry id: /fork <id>"],
		["/gamepad", "Control the session from a DualShock 4: /gamepad [on|off|status|watch|list|reset|approve|rumble]"],
		[
			"/login",
			"Sign in to a subscription: /login [claude|chatgpt|<code#state>] — the Claude flow may ask you to paste",
		],
		["/logout", "Sign out of a subscription: /logout [claude|chatgpt]"],
		[
			"/mcp",
			"List MCP servers, approve one, or read prompts and resources: /mcp [approve <name>|prompts <server>|prompt <server> <name> [key=value ...]|resources <server>|resource <server> <uri>]",
		],
		["/mode", "Show or set the permission mode: /mode [mode]"],
		["/model", "Show or switch the model: /model [provider/id]"],
		["/permissions", "Show the active permission mode and rules"],
		["/ps", "List background shells and show what one has printed"],
		["/resume", "Resume an earlier session in this directory (pick from a list)"],
		["/rewind", "Restore a file from a checkpoint: /rewind [number]"],
		["/status", "Show model, context usage, cost, and settings at a glance"],
		["/stop", "Stop a background shell: /stop [id]"],
		["/subagents", "List subagents, and act on one: /subagents [stop|retry|log] [id] — no id opens a picker"],
		["/tasks", "Show the task tree: this session, its subagents, and its background shells"],
		["/theme", "Show or switch the theme: /theme [name|auto]"],
		["/think", `Show or set how hard the model thinks: /think [${THINKING_LEVELS.join("|")}]`],
		["/tree", "Show the session branch tree"],
		["/vim", "Turn modal vim editing in the prompt on or off: /vim [on|off]"],
	];
}

/**
 * The sign-in the REPL is waiting on, if any.
 *
 * The browser path completes inside `/login`; the manual path returns a
 * pending login whose code arrives as the argument of a later `/login`. Module
 * state rather than context state because there is one REPL per process, and
 * a session swap (/resume) must not discard a sign-in in progress.
 */
let pendingClaudeLogin: PendingClaudeLogin | null = null;
let claudeLoginRunning = false;
// No pending state for the ChatGPT flow: its fallback is the device code,
// which the flow polls to completion inside one `/login chatgpt`, so there is
// never a half-finished sign-in for a later command to pick up.
let chatgptLoginRunning = false;

function claudeAuthOf(ctx: AppCommandContext): ClaudeAuthHooks {
	return (
		ctx.claudeAuth ?? {
			store: () => createClaudeCredentialStore({ home: ctx.home }),
			login: claudeLoginFlow,
			complete: completeClaudeLogin,
		}
	);
}

function chatgptAuthOf(ctx: AppCommandContext): ChatGptAuthHooks {
	return (
		ctx.chatgptAuth ?? {
			store: () => createChatGptCredentialStore({ home: ctx.home }),
			login: chatGptLoginFlow,
		}
	);
}

function handleAppCommand(text: string, ctx: AppCommandContext): boolean {
	const [command] = text.split(/\s+/);
	const session = ctx.getSession();

	switch (command) {
		case "/activity": {
			const arg = text.split(/\s+/)[1]?.toLowerCase();
			const range: ActivityRange | undefined = arg === "7d" || arg === "30d" || arg === "all" ? arg : undefined;
			if (arg && !range) {
				pushInfo(ctx.handle, "Usage: /activity [7d|30d|all] — with no argument it opens on a month");
				return true;
			}
			const handle = ctx.handle;
			if (!handle) return true;
			// A month first, because a month is the shortest window in which a
			// streak is a thing you can have. The panel re-collects for itself when
			// `r` widens the window; this walk is for the transcript line, which a
			// picture that scrolls away cannot leave behind.
			handle.showActivity(ctx.home, range);
			void (async () => {
				const report = collectActivity(ctx.home, { windowStart: windowStartFor(range ?? "30d", Date.now()) });
				pushInfo(handle, activitySummaryLine(report, range ?? "30d"));
			})();
			return true;
		}
		case "/agents": {
			const [, sub] = text.split(/\s+/);
			if (sub === "approve") {
				// One decision covers both tiers. A repository that ships skills ships
				// them for the same reason it ships agents, and the question the gate
				// asks is "do I trust this checkout" — twice is once too many. What gets
				// recorded is still per kind, so a tier added later is not trusted by a
				// decision taken before it existed.
				const kinds: DefinitionKind[] = [];
				if (ctx.withheldAgents.length > 0) kinds.push("agents");
				if (ctx.withheldSkills.length > 0) kinds.push("skills");
				if (kinds.length === 0) {
					pushInfo(ctx.handle, "Nothing pending: this project's definitions are already loaded.");
					return true;
				}
				approveProjectDefinitions(ctx.cwd, kinds, ctx.home);
				const agents = ctx.withheldAgents.splice(0, ctx.withheldAgents.length);
				ctx.agentDefinitions.push(...agents);
				// Pushed into the registry the dispatcher reads rather than rebuilt: that
				// array is the one `findCommand` searches, so an approved skill answers
				// the next line typed. Tab completion was built from a copy at mount and
				// catches up on the next start — a restart is a smaller price than
				// rebuilding the mounted screen for a once-per-repository decision.
				const adopted = ctx.withheldSkills.splice(0, ctx.withheldSkills.length);
				ctx.commands.push(...skillsAsCommands(adopted));
				pushInfo(
					ctx.handle,
					`Approved this project's definitions — ${describeWithheld({
						agents: agents.length,
						skills: adopted.length,
					})} now loaded.`,
				);
				return true;
			}

			const lines = [GENERAL_PURPOSE, ...ctx.agentDefinitions].map(
				(definition) =>
					`  ${definition.agentType} [${definition.source}]${definition.whenToUse ? ` — ${definition.whenToUse}` : ""}`,
			);
			for (const definition of ctx.withheldAgents) {
				lines.push(`  ${definition.agentType} [project, not loaded — /agents approve]`);
			}
			// Skills are named only while they are part of a pending decision: this
			// command is about agent definitions, and a skill that is already loaded
			// has its own name to be typed by.
			if (ctx.withheldSkills.length > 0) {
				const names = ctx.withheldSkills.map((skill) => skill.name).join(", ");
				lines.push(
					`  ${ctx.withheldSkills.length} project skill${ctx.withheldSkills.length === 1 ? "" : "s"} not loaded: ${names} — /agents approve loads both`,
				);
			}
			pushInfo(ctx.handle, `Agent definitions:\n${lines.join("\n")}`);
			return true;
		}
		case "/beetle": {
			const surface = ctx.beetle;
			if (!surface) {
				pushInfo(ctx.handle, "No band in this context — /beetle lives in the interactive REPL.");
				return true;
			}
			const command = parseBeetleCommand(text.split(/\s+/).slice(1).join(" "));
			if (command.kind === "usage") {
				pushInfo(ctx.handle, beetleUsage());
			} else if (command.kind === "start") {
				surface.start(command.task);
			} else if (command.kind === "off") {
				surface.stop();
			} else if (command.kind === "status") {
				surface.status();
			} else if (command.kind === "models") {
				surface.configure();
			} else {
				surface.say(command.target, command.text);
			}
			return true;
		}
		case "/cache": {
			pushInfo(ctx.handle, ctx.cache ? ctx.cache.report() : "This session does not track the prompt cache.");
			return true;
		}
		case "/checkpoint": {
			const checkpointStore = ctx.sessionStore();
			// Read over every entry in the file, not the active chain: the question
			// is what this session did, and a compaction is exactly the moment the
			// chain stops holding the calls above the boundary. The entries a pass
			// re-sent keep this answer whole either way.
			const checkpoints = checkpointStore ? readToolCheckpoints(checkpointStore.entries) : [];
			const lines: string[] = [];
			if (checkpoints.length === 0) {
				lines.push("No tool calls recorded yet — one checkpoint is written when each call ends.");
			} else {
				const failed = checkpoints.filter((checkpoint) => checkpoint.isError).length;
				const last = checkpoints[checkpoints.length - 1];
				lines.push(
					`Checkpoints — ${checkpoints.length} tool ${checkpoints.length === 1 ? "call" : "calls"} recorded, ${failed} failed.`,
				);
				if (last) {
					const summary = last.inputSummary ? ` (${last.inputSummary})` : "";
					const when = new Date(last.at).toLocaleTimeString();
					lines.push(`Last: ${last.toolName} ${last.isError ? "failed" : "ok"} at ${when}${summary}.`);
				}
				// The step the newest call recorded, and the newest test run that
				// reported failures — with the names, because a count alone says a
				// run failed without saying what did. The run's time is printed so
				// a list that is turns old reads as old rather than as news.
				if (last?.nextStep) lines.push(`Next: ${last.nextStep}`);
				const failures = latestTestFailures(checkpoints);
				if (failures) {
					const count = failures.names.length + failures.omitted;
					lines.push(`Failing tests (${count}, from the run at ${new Date(failures.at).toLocaleTimeString()}):`);
					for (const name of failures.names) lines.push(`  ${name}`);
					if (failures.omitted > 0) lines.push(`  …and ${failures.omitted} more not named.`);
				}
			}
			// The files against the disk now: what the newest call on each path
			// recorded, and whether that still describes the file.
			const files = touchedFileReports(checkpoints, readFileOrNull);
			if (files.length > 0) {
				lines.push(`Files touched (${files.length}), read against the disk now:`);
				for (const file of files) lines.push(`  ${touchedFileLine(file)}`);
			}
			const tasks = ctx.taskSnapshot?.() ?? [];
			if (tasks.length === 0) {
				lines.push("Tasks: none.");
			} else {
				const done = tasks.filter((task) => task.status === "completed").length;
				const active = tasks.filter((task) => task.status === "in_progress").length;
				lines.push(
					`Tasks (${tasks.length}): ${done} done, ${active} in progress, ${tasks.length - done - active} pending.`,
				);
				const open = tasks.filter((task) => task.status !== "completed");
				for (const task of open.slice(0, 10)) lines.push(`  #${task.id} [${task.status}] ${task.subject}`);
				if (open.length > 10) lines.push(`  …and ${open.length - 10} more.`);
			}
			if (session) {
				const used = estimateContextUsage(session.currentContext());
				const limits = ctx.compaction().limits();
				lines.push(
					`Context: ${formatTokens(used)} tokens used of ${formatTokens(limits.threshold)} before auto-compact.`,
				);
			} else {
				lines.push("Context: no live session to measure.");
			}
			pushInfo(ctx.handle, lines.join("\n"));
			return true;
		}
		case "/cost": {
			// The ceilings come from the settings, not from a resolved stack: /cost
			// answers what the file says, and a budget set for a seat whose model
			// never resolved still shows, reading $0.0000 — which is how a user
			// finds out the seat they budgeted for is not the one running.
			pushInfo(
				ctx.handle,
				formatCostReport(ctx.costTracker.sessionState, ctx.costTracker.state, roleCeilings(ctx.settings?.roles)),
			);
			return true;
		}
		case "/permissions": {
			if (!session) return true;
			const rules = [...ctx.baseRules, ...ctx.sessionRules];
			// The left column is padded to the widest behavior ("allow") so the tool
			// names line up when the three behaviors mix.
			const behaviorLabel = (behavior: PermissionRule["behavior"]): string => {
				if (behavior === "allow") return "allow";
				if (behavior === "deny") return "deny ";
				return "ask  ";
			};
			const lines = [
				`Mode: ${session.permissionMode} · sandbox: ${session.sandbox}`,
				// Printed here rather than left to the mode hints, because this is
				// the screen a user opens to find out what is actually holding the
				// session in. The wording is not this file's to choose: the same
				// resolution that picks the argv picks the sentence, so the answer
				// cannot say "enforced" on a machine where nothing wraps the shell.
				// What the sentence never covers is the deny rules and the
				// classifier below — those apply in every case, including the
				// unrestricted one, and they are not the sandbox.
				describeSandboxBackend(ctx.sandboxBackend, session.sandbox),
				// The third axis, from the same source as the other two — read off
				// the session rather than off settings, so a session that changed it
				// mid-run reports what it is actually running under. The caveat is
				// derived from `ctx.sandboxBackend` and the sandbox axis — the same
				// two answers the line above prints — and not from `process.platform`:
				// a platform name says a backend *could* exist, not that one is
				// installed, and it says nothing about whether the mode asked for a
				// wrapper, so keying off it told a Linux box without bubblewrap, and a
				// Mac running `danger-full-access`, that the OS was holding the line.
				describeNetworkPolicy(
					session.network.access,
					session.network.domains,
					networkConfinement(ctx.sandboxBackend, session.sandbox, session.network.access),
				),
				// The writable roots, **and this line is why the row above can be
				// believed**: the sandbox sentence says a boundary is enforced, and
				// this is what the boundary is made of. A user who cannot see the
				// paths cannot tell a temp directory from a whole disk, and
				// `permissions.additionalDirectories` is a setting that widens the
				// write surface — one nobody can inspect is one nobody trusts.
				//
				// The sentence comes from the same resolver the policy is built
				// from, so what is printed here is what the argv carries rather
				// than a second account of it that can drift.
				describeWritableRoots({
					home: ctx.home,
					configured: ctx.settings.permissions.additionalDirectories,
				}),
				`Rules (${rules.length}):`,
				...rules.map(
					(r) => `  ${behaviorLabel(r.behavior)} ${r.toolName}${r.specifier ? `(${r.specifier})` : ""}  [${r.source}]`,
				),
			];
			pushInfo(ctx.handle, lines.join("\n") || "(none)");
			return true;
		}
		case "/resume": {
			if (!session || !ctx.handle) return true;
			if (session.isRunning) {
				pushInfo(ctx.handle, "Interrupt the current run first (Esc), then /resume.");
				return true;
			}
			// The running session is not something to resume into: it is the
			// newest file in the project, so it used to sit at the top of this
			// list and Enter on it cleared the screen onto the conversation
			// that was already open — a wipe in the shape of a resume.
			const currentId = ctx.sessionStore()?.sessionId;
			const sessions = listSessions(ctx.cwd, ctx.home).filter((s) => s.sessionId !== currentId);
			if (sessions.length === 0) {
				pushInfo(ctx.handle, "No saved sessions for this project.");
				return true;
			}
			void (async () => {
				const handleRef = ctx.handle;
				if (!handleRef) return;
				const items = sessions.map((s) => ({
					label: `${shortSessionId(s.sessionId)}  ${new Date(s.mtimeMs).toLocaleString()}`,
					description: `${formatMessageCount(s)} msgs — ${s.firstUserText}`,
				}));
				const index = await handleRef.pickFromList("Resume a session", items);
				if (index === null) return;
				await ctx.hotSwapSession(sessions[index]);
			})().catch((error) => {
				// The picker has closed and nothing else happened: the swap threw
				// after the dialog was gone, and an unhandled rejection used to
				// take the process down in the middle of a live terminal. The
				// failure lands in the transcript instead.
				pushInfo(ctx.handle, `Resume failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			return true;
		}
		case "/model": {
			if (!ctx.handle) return true;
			const arg = text.split(/\s+/).slice(1).join(" ").trim();
			if (arg) {
				ctx.switchModel(arg);
				return true;
			}
			void (async () => {
				const handleRef = ctx.handle;
				if (!handleRef) return;
				const current = ctx.getSession()?.model;
				// Which models may be offered is a question about what a session can
				// do, not about how a row looks — see `offeredModels`.
				const models = offeredModels();
				// Opened on the model in use, so Enter without moving anything keeps
				// it rather than switching to whichever happens to be first.
				const active = models.findIndex((m) => current && m.provider === current.provider && m.id === current.id);
				// Read when the picker opens, not cached from startup: `/login` may
				// have landed since, and the rows must show what that changed.
				const signIns = await detectSubscriptionSignIns({ home: ctx.home });
				const items = models.map((m, i) => {
					const suffix = unrunnableSuffix(m, signIns);
					// The display name leads and the wire reference follows: two rows
					// reading `anthropic/claude-sonnet-5` and `anthropic/claude-sonnet-5-1`
					// are a choice nobody can make at a glance, and the id is still what
					// /model <ref> takes, so it stays on the row rather than being lost.
					return {
						label: `${i === active ? "* " : "  "}${m.name}`,
						description: `${m.provider}/${m.id} · ${Math.round(m.contextWindow / 1000)}k context${suffix ? ` — ${suffix}` : ""}`,
					};
				});
				const index = await handleRef.pickFromList("Switch model", items, { initialIndex: Math.max(active, 0) });
				if (index === null || index < 0 || index >= models.length) return;
				const chosen = models[index];
				ctx.switchModel(`${chosen.provider}/${chosen.id}`);
			})();
			return true;
		}
		case "/think": {
			const arg = text.split(/\s+/)[1]?.toLowerCase() ?? "";
			if (!arg) {
				pushInfo(ctx.handle, `Thinking level: ${describeThinkingLevel(ctx.thinkingLevel())}`);
				return true;
			}
			const level = THINKING_LEVELS.find((candidate) => candidate === arg);
			if (!level) {
				pushInfo(
					ctx.handle,
					`Usage: /think [${THINKING_LEVELS.join("|")}] — with no argument it shows the current level`,
				);
				return true;
			}
			ctx.setThinkingLevel(level);
			return true;
		}
		case "/autocompact": {
			const parsed = parseAutocompactCommand(text.split(/\s+/).slice(1).join(" "));
			if (parsed.kind === "usage") {
				pushInfo(ctx.handle, autocompactUsageLine());
				return true;
			}
			const io = userSettingsAutocompactIo(ctx.home);
			try {
				if (parsed.kind === "report") {
					pushInfo(ctx.handle, autocompactReport(io.read()));
					return true;
				}
				// The file first, then the running session: the report below
				// describes what the next check will do, and it may only say that
				// about a write that landed — a failed write leaves the session
				// behaving as it did, and the user reads why.
				const state = applyAutocompactAction(parsed, io);
				ctx.applyCompactionSettings?.({ enabled: state.enabled, thresholdPercent: state.thresholdPercent });
				pushInfo(ctx.handle, autocompactReport(state));
			} catch (error) {
				pushInfo(ctx.handle, error instanceof Error ? error.message : String(error));
			}
			return true;
		}
		case "/status": {
			if (!session) return true;
			const store = ctx.handle?.store;
			const info = store?.get().contextInfo;
			const storeId = ctx.sessionStore()?.sessionId;
			// The live editor, not the startup flag: `/vim` and `/emacs` may have
			// changed it since. Resolved from both keys rather than read off one,
			// because the two are exclusive and a card that named a flag could not
			// describe the third state — the one with neither set.
			const live = store?.get();
			const editor = resolveEditingMode({
				vimMode: live?.vim ?? ctx.settings.vimMode === true,
				emacsMode: live?.emacs ?? ctx.settings.emacsMode === true,
			});
			ctx.handle?.setStatusCard({
				model: `${session.model.provider}/${session.model.id}`,
				directory: shortenHome(ctx.cwd, ctx.home),
				permissions: describeAxes(session.permissionMode, session.sandbox),
				session: storeId ? shortSessionId(storeId) : "(not persisted)",
				context: info,
				details: [
					[
						"Cost",
						`$${ctx.costTracker.sessionState.totalCostUSD.toFixed(4)} this session · ` +
							`$${ctx.costTracker.state.totalCostUSD.toFixed(4)} this project`,
					],
					// Beside the cost, because that is what it explains: a hit rate is
					// the reason a bill is what it is, and the two are read together.
					["Cache", ctx.cache?.statusLine() ?? "not tracked"],
					["Thinking", describeThinkingLevel(ctx.thinkingLevel())],
					["Theme", `${ctx.theme.theme.name} · ${describeEditor(editor)}`],
					[
						"MCP",
						`${ctx.mcpConnections.length} connected${
							ctx.pendingMcpApprovals.length > 0 ? `, ${ctx.pendingMcpApprovals.length} pending approval` : ""
						}`,
					],
				],
			});
			// The card carries the detail; the transcript keeps the one line, so the
			// fact that it was asked for is still in the session's own history.
			pushInfo(
				ctx.handle,
				`Status: ${session.model.provider}/${session.model.id} · ${describeAxes(session.permissionMode, session.sandbox)} · ${
					storeId ? shortSessionId(storeId) : "not persisted"
				}`,
			);
			return true;
		}
		case "/ps": {
			void (async () => {
				const shells: BackgroundShell[] = [...ctx.backgroundShells.list(), ...(ctx.recoveredShells ?? [])];
				if (shells.length === 0) {
					pushInfo(ctx.handle, "No background shells.");
					return;
				}
				if (!ctx.handle) return;
				const index = await ctx.handle.pickFromList("Background shells", shellPickerItems(shells));
				if (index === null || index >= shells.length) return;
				const shell = shells[index];
				// The tail, not the whole file: the question is what it is saying now,
				// and a dev server's log is mostly the first ten lines over and over.
				const output = isRecoveredShell(shell) ? recoveredShellOutput(shell) : ctx.backgroundShells.output(shell.id);
				pushInfo(ctx.handle, formatShellOutput(shell.id, output));
			})();
			return true;
		}
		case "/stop": {
			const arg = text.split(/\s+/).slice(1).join(" ").trim();
			const stop = async (shell: BackgroundShell): Promise<void> => {
				if (isRecoveredShell(shell)) {
					// No handle exists here for a process another process started, so
					// the kill goes by pid — and, unlike the manager's, it is awaited:
					// taskkill on Windows used to fail in silence, and a shell that
					// kept running must not leave a "stopped" row behind. Only a kill
					// that was confirmed true earns the splice, the removal from the
					// rows `/stop` and `/ps` offer next.
					const killed = await killPidTree(shell.pid);
					if (killed) {
						const at = ctx.recoveredShells?.indexOf(shell) ?? -1;
						if (at >= 0) ctx.recoveredShells?.splice(at, 1);
						pushInfo(ctx.handle, `Stopped ${shell.id} — it was left running by a previous run.`);
						return;
					}
					// The kill did not take. The pid is asked what became of it rather
					// than guessed at: "gone" was one way for the attempt to fail and
					// "still running" another, and the row stays either way.
					pushInfo(ctx.handle, recoveredStopFailureMessage(shell.id, probePidState(shell.pid)));
					return;
				}
				const killed = ctx.backgroundShells.kill(shell.id);
				ctx.refreshBackgroundShells();
				pushInfo(ctx.handle, killed ? `Stopped ${shell.id}.` : `${shell.id} is not running.`);
			};
			void (async () => {
				const all: BackgroundShell[] = [...ctx.backgroundShells.list(), ...(ctx.recoveredShells ?? [])];
				if (arg) {
					const target = resolveShellId(arg, all);
					if (!target) {
						pushInfo(ctx.handle, `No shell "${arg}". /ps lists them.`);
						return;
					}
					await stop(target);
					return;
				}
				const running = all.filter((shell) => shell.status === "running");
				if (running.length === 0) {
					pushInfo(ctx.handle, "No background shells are running.");
					return;
				}
				if (!ctx.handle) return;
				const index = await ctx.handle.pickFromList("Stop a background shell", shellPickerItems(running));
				if (index === null || index >= running.length) return;
				await stop(running[index]);
			})();
			return true;
		}
		case "/subagents": {
			// Bare `/subagents` lists; the three verbs act. Same shape as
			// `/ps` and `/stop`: an id argument acts directly, no argument opens
			// a picker over what the verb applies to.
			const [verb, ...rest] = text.split(/\s+/).slice(1);
			const arg = rest.join(" ").trim();
			const all = ctx.subagents.list();
			// Resolve `<id>` or pick from `eligible`; when neither applies, say
			// why nothing happened instead of acting on the wrong run.
			const resolveTarget = async (
				eligible: SubagentHandle[],
				pickerTitle: string,
				emptyLine: string,
			): Promise<SubagentHandle | null> => {
				if (arg) {
					const found = resolveSubagentId(arg, all);
					if (!found) {
						pushInfo(ctx.handle, `No subagent "${arg}". /subagents lists them.`);
						return null;
					}
					return found;
				}
				if (eligible.length === 0) {
					pushInfo(ctx.handle, emptyLine);
					return null;
				}
				if (!ctx.handle) return null;
				const index = await ctx.handle.pickFromList(pickerTitle, subagentPickerItems(eligible, Date.now()));
				return index === null ? null : (eligible[index] ?? null);
			};
			if (verb === "stop" || verb === "retry" || verb === "log") {
				void (async () => {
					if (verb === "stop") {
						const target = await resolveTarget(
							all.filter((handle) => handle.state === "live"),
							"Stop a subagent",
							"No subagents are running.",
						);
						if (!target) return;
						if (target.state === "stopped") {
							pushInfo(ctx.handle, `${target.sidechainId} was already stopped.`);
							return;
						}
						const wasLive = ctx.subagentControl.stop(target);
						pushInfo(
							ctx.handle,
							wasLive
								? `Stopped ${target.sidechainId}; it will not be resumed.`
								: `${target.sidechainId} had already ended; it is now marked stopped and will not be continued.`,
						);
						return;
					}
					if (verb === "retry") {
						const retryable = all.filter((handle) => {
							const status = subagentStatus(handle);
							return status === "failed" || status === "cancelled";
						});
						const target = await resolveTarget(retryable, "Retry a subagent", "No failed subagents to retry.");
						if (!target) return;
						const status = subagentStatus(target);
						if (status !== "failed" && status !== "cancelled") {
							pushInfo(
								ctx.handle,
								`${target.sidechainId} is ${status}; only failed or cancelled subagents can be retried.`,
							);
							return;
						}
						// A fresh conversation on the same terms; SendMessage is the door
						// for continuing the old one. No turn holds this run's cancel —
						// it is stopped with `/subagents stop`, like any other subagent.
						const done = ctx.subagentControl.retry(target, { cwd: ctx.cwd }, (spawned) =>
							pushInfo(ctx.handle, `Retrying "${target.title}" as ${spawned.sidechainId}.`),
						);
						void done.then(
							(result) => pushInfo(ctx.handle, formatRetryEnding(target.sidechainId, result)),
							(error) =>
								pushInfo(
									ctx.handle,
									`Retry of ${target.sidechainId} failed: ${error instanceof Error ? error.message : String(error)}`,
								),
						);
						return;
					}
					const target = await resolveTarget(all, "Show a subagent's log", "No subagents have run in this session.");
					if (!target) return;
					pushInfo(ctx.handle, formatSubagentLog(target, Date.now()));
				})();
				return true;
			}
			pushInfo(ctx.handle, formatSubagentList(all, Date.now()));
			return true;
		}
		case "/tasks": {
			// The tree is read, never acted on: the verbs live on /subagents and
			// /stop, and this screen is where their targets are read off. Fresh
			// reads of all three sources, because a subagent may have ended and a
			// shell died since the last time anything asked.
			const shells: BackgroundShell[] = [...ctx.backgroundShells.list(), ...(ctx.recoveredShells ?? [])];
			pushInfo(
				ctx.handle,
				formatTaskTree({
					mainRunning: session?.isRunning === true,
					subagents: ctx.subagents.list(),
					shells,
					now: Date.now(),
				}),
			);
			return true;
		}
		case "/export": {
			if (!session) return true;
			const arg = text.split(/\s+/).slice(1).join(" ").trim();
			const id = ctx.sessionStore()?.sessionId ?? Date.now().toString(36);
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			const path = arg || join(ctx.cwd, `labunbun-${id.slice(0, 8)}-${stamp}.md`);
			try {
				writeFileSync(path, sessionToMarkdown(session.messages), "utf8");
				pushInfo(ctx.handle, `Session exported to ${path}`);
			} catch (error) {
				pushInfo(ctx.handle, `Export failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			return true;
		}
		case "/mcp": {
			const [, sub, serverName, ...rest] = text.split(/\s+/);
			if (sub === "approve" && serverName) {
				if (!ctx.pendingMcpApprovals.includes(serverName)) {
					pushInfo(ctx.handle, `No pending approval for "${serverName}". See /mcp for the list.`);
					return true;
				}
				const config = ctx.mcpConfig[serverName];
				if (!config) {
					pushInfo(ctx.handle, `Unknown server: ${serverName}`);
					return true;
				}
				persistMcpApproval(ctx.cwd, serverName, ctx.home);
				void connectMcpServer(serverName, config).then((connection) => {
					ctx.mcpConnections.push(connection);
					// This connection appeared after the startup attach loop ran its
					// one pass, so it is wired here or a later tool-list change on
					// this server reaches nobody: the session would keep the list
					// this approval handed it, while the workers that read the
					// connections live would move ahead of it.
					if (ctx.onMcpToolsChanged) connection.onToolsChanged = ctx.onMcpToolsChanged;
					const index = ctx.pendingMcpApprovals.indexOf(serverName);
					if (index !== -1) ctx.pendingMcpApprovals.splice(index, 1);
					// Tools sit above the system prompt and the transcript, and a
					// provider keys its cache on them: one appended tool discards every
					// tier below it. Registered, this reads as the deliberate change it
					// is; unregistered, `/cache` would name it a bug.
					ctx.cache?.note?.("mcp tools added");
					ctx.getSession()?.setTools([...(ctx.getSession()?.tools ?? []), ...connection.tools]);
					pushInfo(
						ctx.handle,
						connection.error
							? `Approved "${serverName}" but connection failed: ${connection.error}`
							: `Approved "${serverName}" — connected with ${connection.tools.length} tools.`,
					);
				});
				return true;
			}

			// The read-only consumer surface: what a server offers besides tools.
			// Each read goes to the live server rather than to the connect-time
			// snapshot, because the answer as of the command is the point of asking.
			// Everything here renders as a transcript entry and never enters the
			// conversation. Nothing here is gated on a second approval: the dialog
			// already preceded the connection, and showing a prompt the server
			// defined, or reading a resource it itself listed, is a smaller act
			// than the `tools/call` the model may already make at any turn.
			if (sub === "prompts") {
				if (!serverName) {
					pushInfo(ctx.handle, MCP_SUBCOMMAND_USAGE.prompts);
					return true;
				}
				const connection = connectedMcpServer(ctx, serverName);
				if (!connection) {
					pushInfo(ctx.handle, mcpUnknownServer("prompts", serverName));
					return true;
				}
				void (async () => {
					try {
						const prompts = await listPrompts(connection.client);
						pushInfo(ctx.handle, capInfoText(formatMcpPrompts(connection.serverName, prompts)));
					} catch (error) {
						pushInfo(ctx.handle, mcpReadFailure("prompts/list", connection.serverName, error));
					}
				})();
				return true;
			}
			if (sub === "prompt") {
				const [name, ...pairs] = rest;
				if (!serverName || !name) {
					pushInfo(ctx.handle, MCP_SUBCOMMAND_USAGE.prompt);
					return true;
				}
				const connection = connectedMcpServer(ctx, serverName);
				if (!connection) {
					pushInfo(ctx.handle, mcpUnknownServer("prompt", serverName));
					return true;
				}
				// A bare token is a typo the server would silently drop: the wire
				// says key=value, so anything else is answered with the shape that
				// works rather than passed along.
				const malformed = pairs.find((pair) => !pair.includes("="));
				if (malformed !== undefined) {
					pushInfo(ctx.handle, `${MCP_SUBCOMMAND_USAGE.prompt}\nArguments must be key=value (got "${malformed}").`);
					return true;
				}
				const args: Record<string, string> = {};
				for (const pair of pairs) {
					const at = pair.indexOf("=");
					args[pair.slice(0, at)] = pair.slice(at + 1);
				}
				void (async () => {
					try {
						const prompt = await getPrompt(connection.client, name, args);
						pushInfo(ctx.handle, capInfoText(formatMcpPrompt(connection.serverName, name, prompt)));
					} catch (error) {
						pushInfo(ctx.handle, mcpReadFailure(`prompts/get "${name}"`, connection.serverName, error));
					}
				})();
				return true;
			}
			if (sub === "resources") {
				if (!serverName) {
					pushInfo(ctx.handle, MCP_SUBCOMMAND_USAGE.resources);
					return true;
				}
				const connection = connectedMcpServer(ctx, serverName);
				if (!connection) {
					pushInfo(ctx.handle, mcpUnknownServer("resources", serverName));
					return true;
				}
				void (async () => {
					try {
						const resources = await listResources(connection.client);
						pushInfo(ctx.handle, capInfoText(formatMcpResources(connection.serverName, resources)));
					} catch (error) {
						pushInfo(ctx.handle, mcpReadFailure("resources/list", connection.serverName, error));
					}
				})();
				return true;
			}
			if (sub === "resource") {
				const uri = rest[0];
				if (!serverName || !uri) {
					pushInfo(ctx.handle, MCP_SUBCOMMAND_USAGE.resource);
					return true;
				}
				const connection = connectedMcpServer(ctx, serverName);
				if (!connection) {
					pushInfo(ctx.handle, mcpUnknownServer("resource", serverName));
					return true;
				}
				void (async () => {
					try {
						const contents = await readResource(connection.client, uri);
						pushInfo(ctx.handle, capInfoText(formatMcpResource(connection.serverName, uri, contents)));
					} catch (error) {
						pushInfo(ctx.handle, mcpReadFailure(`resources/read "${uri}"`, connection.serverName, error));
					}
				})();
				return true;
			}

			if (ctx.mcpConnections.length === 0 && ctx.pendingMcpApprovals.length === 0 && ctx.mcpLoadErrors.length === 0) {
				pushInfo(ctx.handle, "No MCP servers configured (.mcp.json, settings.json, or ~/.labunbun/.mcp.json).");
				return true;
			}
			const lines = ctx.mcpConnections.map((c) => {
				// Prompts are discovered next to the tools and were reported by
				// nothing: a count the user cannot read is a capability the server
				// may as well not have.
				const status = c.error ? `✗ ${c.error}` : `✓ ${c.tools.length} tools, ${c.prompts.length} prompts`;
				return `  ${c.serverName}: ${status}`;
			});
			for (const name of ctx.pendingMcpApprovals) {
				lines.push(`  ${name}: pending approval — run /mcp approve ${name}`);
			}
			// A file that failed to parse is why a server the user wrote is absent
			// from the list above; without these rows the list reads as complete.
			for (const error of ctx.mcpLoadErrors) {
				lines.push(`  ! ${error.path}: ${error.message}`);
			}
			if (ctx.mcpConnections.length > 0) {
				lines.push("Read one's prompts or resources: /mcp prompts <server>, /mcp resources <server>");
			}
			pushInfo(ctx.handle, `MCP servers:\n${lines.join("\n")}`);
			return true;
		}
		case "/permissions-mode":
		case "/mode": {
			const session = ctx.getSession();
			const arg = text.split(/\s+/)[1];
			// A choice id names both axes at once, which is why `agentNoSandbox` is
			// spelled the way it is. A bare mode name is also accepted, since three
			// of the four ids are the mode name verbatim and typing `/mode agent`
			// is what a keyboard user reaches for first; it means that mode under
			// the confinement every mode ships with, never "keep whatever I had".
			const target = arg ? (findModeChoice(arg) ?? choiceForMode(arg)) : undefined;
			if (arg && !target) {
				pushInfo(ctx.handle, `Usage: /mode ${MODE_CHOICES.map((c) => c.id).join("|")}`);
			} else if (target) {
				session?.setMode(target.mode, target.sandbox);
				// The prompt's badge is a copy of the mode, and the session has no
				// event for `setMode` — so this is the only place that can tell the
				// store. Without it `/mode agent` would leave the prompt naming
				// whatever Shift+Tab last set, which is the one way this pair can
				// disagree after the wiring landed.
				publishModeLabel(ctx.handle, target.label);
				// And onto the session file, so a mode picked here is the mode the
				// session resumes under rather than one this process happened to be in.
				ctx.persistPolicy?.();
				pushInfo(ctx.handle, `Mode: ${target.label} (${target.mode} · sandbox ${target.sandbox})`);
			} else {
				// No argument opens the same list `/model` and `/theme` do, rather than
				// printing a usage line. A usage line is a dead end for a user with no
				// keyboard: `R3` on a controller runs this command, and until this
				// existed that button printed the one thing it could not act on.
				const handleRef = ctx.handle;
				if (!handleRef) return true;
				void (async () => {
					// The tick marks the *pair* the session is in, not just the mode:
					// `agent` and `Agent 无沙箱` share a mode and differ only here, and
					// a star on both of them would be a lie.
					const active = MODE_CHOICES.findIndex(
						(c) => c.mode === session?.permissionMode && c.sandbox === session.sandbox,
					);
					const items = MODE_CHOICES.map((choice, i) => ({
						label: `${i === active ? "* " : "  "}${choice.label}`,
						description: choice.hint,
					}));
					const index = await handleRef.pickFromList("Mode", items, {
						initialIndex: Math.max(active, 0),
					});
					if (index === null || index < 0) return;
					const chosen = MODE_CHOICES[index];
					if (!chosen) return;
					session?.setMode(chosen.mode, chosen.sandbox);
					// The picker's answer has to reach the prompt for the same reason the
					// argument path's does — this is the other way `/mode` can be run
					// with no keyboard at all, so it is the one where a stale badge would
					// be worst: a controller user who picked `Plan` and saw `Agent` under
					// their finger.
					publishModeLabel(ctx.handle, chosen.label);
					// The file gets it for the same reason, and this is the path where
					// forgetting it would be least visible: a controller user cannot
					// even retype the choice.
					ctx.persistPolicy?.();
					pushInfo(ctx.handle, `Mode: ${chosen.label} (${chosen.mode} · sandbox ${chosen.sandbox})`);
				})();
			}
			return true;
		}
		case "/tree": {
			const treeStore = ctx.sessionStore();
			if (!treeStore) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			const tree = treeStore.describeTree();
			const branches = treeStore.branchPoints();
			pushInfo(ctx.handle, `Session tree (* = active path, ${branches.length} branch point(s)):\n${tree}`);
			return true;
		}
		case "/fork": {
			const arg = text.split(/\s+/)[1];
			const forkSession = ctx.getSession();
			const forkStore = ctx.sessionStore();
			if (!forkStore || !forkSession) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			if (!arg) {
				pushInfo(ctx.handle, "Usage: /fork <entry-id> — see /tree for ids");
				return true;
			}
			if (!forkStore.branch(arg)) {
				pushInfo(ctx.handle, `Entry not found: ${arg}`);
				return true;
			}
			// Rebuild in-memory transcript from the new branch. The branch point may
			// sit above a compaction boundary, in which case the whole history from
			// there is live again — and below one, in which case it is not.
			//
			// A different branch is a different prefix, so the next request is a
			// genuine miss from the branch point down; the user asked for it, and the
			// registration is what says so.
			ctx.cache?.note?.("fork");
			// A fork point can sit right after a tool_use whose result lives on
			// the branch being left — the same half-pair a damaged line leaves
			// behind, and a request the provider rejects. Repaired here, the last
			// point the structure is still in hand, exactly as a resumed file is.
			const forkContext = forkStore.contextMessages();
			const forkRepaired = repairToolPairing(forkContext);
			forkSession.messages = forkRepaired.messages;
			const forkRemoved = forkContext.length - forkRepaired.messages.length;
			pushInfo(
				ctx.handle,
				`Branched from ${arg.slice(0, 8)}. New messages continue on this branch.` +
					(forkRemoved > 0 ? ` ${forkRemoved} message${forkRemoved === 1 ? "" : "s"} removed with its tool call.` : ""),
			);
			return true;
		}
		case "/rewind": {
			const rewindStore = ctx.sessionStore();
			if (!rewindStore) {
				pushInfo(ctx.handle, "No session store in this session.");
				return true;
			}
			const { checkpoints, unreadable } = listCheckpoints(rewindStore);
			if (checkpoints.length === 0) {
				pushInfo(
					ctx.handle,
					unreadable > 0
						? `${unreadable} checkpoint ${unreadable === 1 ? "entry" : "entries"} in this session cannot be read — nothing to restore.`
						: "No checkpoints yet — one is captured before every Edit/Write. A file that cannot be read, or is over 200k characters, is not captured.",
				);
				return true;
			}
			const arg = text.split(/\s+/)[1];
			if (!arg) {
				const lines = checkpoints
					.slice(-10)
					.reverse()
					.map((c, i) => `${checkpoints.length - 1 - i}. ${new Date(c.at).toLocaleTimeString()}  ${c.path}`);
				const skipped =
					unreadable > 0
						? `\n${unreadable} unreadable checkpoint ${unreadable === 1 ? "entry" : "entries"} skipped.`
						: "";
				pushInfo(
					ctx.handle,
					`Checkpoints (newest first). Restore with /rewind <number>:\n${lines.join("\n")}${skipped}`,
				);
				return true;
			}
			const index = Number(arg);
			if (!Number.isInteger(index) || index < 0 || index >= checkpoints.length) {
				pushInfo(ctx.handle, `Invalid checkpoint number: ${arg} (0-${checkpoints.length - 1})`);
				return true;
			}
			const checkpoint = checkpoints[index];
			try {
				writeFileSync(checkpoint.path, checkpoint.content, "utf8");
				// The rollback itself is recorded, so a later reader can tell a
				// workspace that was rolled back from one that was merely edited —
				// the drift a restore leaves behind has no tool call to explain it.
				// Only after the write succeeded: a restore that failed must not be
				// logged as one that happened.
				recordRewind(rewindStore, checkpoint.path, checkpoint.entryId);
				pushInfo(
					ctx.handle,
					`Restored ${checkpoint.path} to the ${new Date(checkpoint.at).toLocaleTimeString()} state.`,
				);
			} catch (error) {
				pushInfo(ctx.handle, `Restore failed: ${error instanceof Error ? error.message : error}`);
			}
			return true;
		}
		case "/context": {
			if (!session) return true;
			const breakdown = contextBreakdown(session.currentContext());
			const limits = ctx.compaction().limits();
			// Read from the store rather than the manager: the session file is where
			// a compaction is recorded, and a resumed session's earlier ones happened
			// before this manager was built.
			const store = ctx.sessionStore();
			const last = store?.compactions().at(-1);
			ctx.handle?.setStatusCard({
				title: "Context",
				context: { usedTokens: breakdown.usedTokens, threshold: limits.threshold },
				details: contextRows(breakdown, limits, {
					memoryChars: ctx.memory?.length ?? 0,
					compactions: store ? { count: store.compactionCount(), last } : undefined,
					// The first reader of the fingerprints the last pass recorded:
					// "the summary still describes this file" is a claim about the
					// file as it was, and only a hash taken then can check it.
					keptFiles: last?.preservedFiles ? preservedFilesDrift(last.preservedFiles, readFileOrNull) : undefined,
				}),
			});
			pushInfo(ctx.handle, contextSummaryLine(breakdown, limits));
			return true;
		}
		case "/doctor": {
			void (async () => {
				const { runDoctorChecks, formatDoctorReport } = await import("./doctor.ts");
				// The runtime's own config, so /doctor and /gamepad cannot disagree
				// about which bindings are readable. The sign-ins are read live —
				// the Auth row is about the machine now, and `/login` may have
				// landed since startup.
				const checks = await runDoctorChecks(
					ctx.settings,
					ctx.cwd,
					ctx.home,
					ctx.theme.choice,
					ctx.pad?.config,
					undefined,
					undefined,
					await detectSubscriptionSignIns({ home: ctx.home }),
				);
				pushInfo(ctx.handle, formatDoctorReport(checks));
			})();
			return true;
		}
		case "/theme": {
			const arg = text.split(/\s+/)[1];
			void (async () => {
				/**
				 * Show a theme as a preview: the live rows recolor, and the sealed
				 * transcript keeps the palette it was printed with. What the picker
				 * calls as the highlight moves — a move is not a choice.
				 */
				const preview = (resolved: ResolvedTheme) => {
					ctx.theme.theme = resolved.theme;
					ctx.theme.available = resolved.available;
					ctx.handle?.previewTheme(resolved.theme);
				};
				/** Show a theme as chosen: the sealed rows are wiped and reprinted under it. */
				const apply = (resolved: ResolvedTheme) => {
					ctx.theme.theme = resolved.theme;
					ctx.theme.available = resolved.available;
					ctx.handle?.setTheme(resolved.theme);
				};
				const save = (name: string, resolved: ResolvedTheme) => {
					// The choice moves with the choice, not with the write: if the
					// settings file cannot be written the session still shows this
					// theme, and a second `/theme` should open on what is on screen.
					ctx.theme.choice = name;
					const shadowed = shadowedChoiceNotice(ctx.loadedSettings, "theme", (path) => shortenHome(path, ctx.home));
					try {
						persistThemeChoice(name, ctx.home);
						pushInfo(
							ctx.handle,
							`Theme: ${resolved.theme.name}${name === AUTO_THEME_NAME ? " (detected)" : ""}` +
								`${shadowed ? ` (${shadowed})` : ""}`,
						);
					} catch (error) {
						// The theme is already applied; only the persistence failed.
						pushInfo(
							ctx.handle,
							`Theme: ${resolved.theme.name} (not saved: ${error instanceof Error ? error.message : String(error)})`,
						);
					}
				};
				if (arg) {
					const resolved = await resolveTheme(arg, ctx.cwd, ctx.home);
					// resolveTheme falls back to the default for an unknown name, so
					// check the name rather than trusting that a theme came back.
					if (arg !== AUTO_THEME_NAME && resolved.theme.name !== arg) {
						pushInfo(ctx.handle, `Unknown theme "${arg}". Available: ${resolved.available.join(", ")}`);
						return;
					}
					apply(resolved);
					save(arg, resolved);
					return;
				}

				// No name: pick from a list that previews itself. Every theme is
				// resolved up front so a highlight recolors the screen in the same
				// keystroke — and every row, `auto` included, resolves WITHOUT asking
				// the terminal (`allowProbe: false`): a probe stands Ink's stdin
				// listeners down for its timeout window, and doing that under a picker
				// that is being typed into is exactly a window in which the keys being
				// pressed reach nobody. `auto` previews from the appearance the
				// session already knows — the startup probe's cached answer, or the
				// standing environment — and choosing it commits below, where the
				// terminal is asked once, after the picker is down. Moving previews;
				// only Enter (or an argument) commits, and the commit is what pays
				// for wiping the screen and reprinting the transcript.
				//
				// The list is read from disk here rather than taken from the startup
				// snapshot: opening `/theme` is how a user reaches the file they just
				// saved, and a row left behind by a file they just deleted is a row
				// that lies.
				const previous = ctx.theme.theme;
				const previousAvailable = ctx.theme.available;
				const loaded = loadThemeFiles(ctx.cwd, ctx.home);
				const names = [...selectableThemeNames(loaded), AUTO_THEME_NAME];
				const resolved = await Promise.all(
					names.map((name) => resolveTheme(name, ctx.cwd, ctx.home, { allowProbe: false })),
				);
				if (!ctx.handle) return;
				// Marked, and opened on, is the choice — what Enter would save — not
				// the theme it resolved to. Under `auto` those differ, and marking the
				// resolved built-in meant Enter saved it over the setting. A choice
				// that no longer resolves (its file was deleted) marks nothing and
				// opens at the top.
				const active = names.indexOf(ctx.theme.choice);
				const index = await ctx.handle.pickFromList(
					"Theme — the highlight is a preview",
					names.map((name, i) => ({
						label: `${i === active ? "* " : "  "}${name}`,
						description:
							i === active
								? "active"
								: loaded.themes.has(name) && resolveBuiltInTheme(name) !== undefined
									? "theme file shadows the built-in"
									: resolved[i].theme.name !== name
										? resolved[i].theme.name
										: undefined,
					})),
					{
						initialIndex: Math.max(active, 0),
						onHighlight: (i) => preview(resolved[i]),
						onCancel: () => {
							ctx.theme.theme = previous;
							ctx.theme.available = previousAvailable;
							// A preview never touched the transcript, so undoing one
							// never has to reprint it either.
							ctx.handle?.previewTheme(previous);
						},
					},
				);
				if (index === null) return;
				// `auto` chosen for real is the one commit that asks the terminal:
				// the open path above could only preview it from the cached or
				// standing appearance, so when no probe has run yet this re-resolve
				// is where the keyboard is briefly held and handed back — with the
				// picker down, and Enter the last key the list needed.
				const chosen =
					names[index] === AUTO_THEME_NAME && cachedAppearance() === undefined
						? await resolveTheme(AUTO_THEME_NAME, ctx.cwd, ctx.home)
						: resolved[index];
				apply(chosen);
				save(names[index], chosen);
			})();
			return true;
		}
		case "/login": {
			const trimmed = text.trim().slice("/login".length).trim();
			const words = trimmed === "" ? [] : trimmed.split(/\s+/);
			// The first word may name the subscription. With no name — or with
			// "claude" — this is the Claude flow it has always been, and a bare
			// first word is the paste the manual flow asked for. A paste whose
			// code happened to read exactly "chatgpt" would be misread as a
			// name; the console's codes are long random strings, so the trade
			// is deliberate.
			if (words[0] === "chatgpt") {
				if (words.length > 1) {
					pushInfo(
						ctx.handle,
						"The ChatGPT sign-in takes no code — approve it in the browser. Run /login chatgpt to start.",
					);
					return true;
				}
				if (chatgptLoginRunning) {
					pushInfo(
						ctx.handle,
						"A ChatGPT sign-in is already running. Finish it in the browser, or approve the device code it printed.",
					);
					return true;
				}
				chatgptLoginRunning = true;
				void (async () => {
					try {
						const auth = chatgptAuthOf(ctx);
						const credential = await auth.login({
							store: auth.store(),
							note: (line) => pushInfo(ctx.handle, line),
						});
						pushInfo(ctx.handle, chatGptSignedInLine(credential));
					} catch (error) {
						pushInfo(ctx.handle, `The sign-in did not complete: ${error instanceof Error ? error.message : error}`);
					} finally {
						chatgptLoginRunning = false;
					}
				})();
				return true;
			}
			const input = words[0] === "claude" ? words.slice(1).join(" ") : trimmed;
			const auth = claudeAuthOf(ctx);
			// An argument is the paste the manual flow asked for; no argument
			// starts a sign-in. One case for both, because the URL the user is
			// holding is the one this REPL printed, and it must survive until
			// the code it shows comes back.
			if (input !== "") {
				const pending = pendingClaudeLogin;
				if (!pending) {
					pushInfo(ctx.handle, "No sign-in is waiting for a code. Run /login first, then paste what the page shows.");
					return true;
				}
				void (async () => {
					try {
						const credential = await auth.complete({ input, pending, store: auth.store() });
						pendingClaudeLogin = null;
						pushInfo(ctx.handle, signedInLine(credential));
					} catch (error) {
						// The pending login stays: the usual failure is a mis-paste,
						// and a fresh URL would invalidate the code still on screen.
						pushInfo(ctx.handle, `The sign-in did not complete: ${error instanceof Error ? error.message : error}`);
					}
				})();
				return true;
			}
			if (claudeLoginRunning) {
				pushInfo(
					ctx.handle,
					"A sign-in is already running. Finish it in the browser, or paste its code with /login <code#state>.",
				);
				return true;
			}
			claudeLoginRunning = true;
			void (async () => {
				try {
					const result = await auth.login({
						store: auth.store(),
						note: (line) => pushInfo(ctx.handle, line),
					});
					if (result.kind === "pending") {
						pendingClaudeLogin = result.pending;
						pushInfo(ctx.handle, "When the page shows the code, run: /login <code#state>");
					} else {
						pendingClaudeLogin = null;
						pushInfo(ctx.handle, signedInLine(result.credential));
					}
				} catch (error) {
					pushInfo(ctx.handle, `The sign-in did not complete: ${error instanceof Error ? error.message : error}`);
				} finally {
					claudeLoginRunning = false;
				}
			})();
			return true;
		}
		case "/logout": {
			// Fire-and-forget like the other network-touching commands: the
			// keychain write can block on a system dialog, and the prompt must
			// stay usable while it does.
			if (text.split(/\s+/)[1]?.toLowerCase() === "chatgpt") {
				void (async () => {
					try {
						const had = await clearChatGptSubscription(chatgptAuthOf(ctx).store());
						pushInfo(
							ctx.handle,
							had
								? "Signed out of the ChatGPT subscription. The next request to a ChatGPT model asks for a sign-in."
								: "No ChatGPT subscription was signed in.",
						);
					} catch (error) {
						pushInfo(ctx.handle, `Could not sign out: ${error instanceof Error ? error.message : error}`);
					}
				})();
				return true;
			}
			void (async () => {
				try {
					const had = await clearClaudeSubscription(claudeAuthOf(ctx).store());
					pendingClaudeLogin = null;
					pushInfo(
						ctx.handle,
						had
							? "Signed out of the Claude subscription. The next request falls back to the API-key path."
							: "No Claude subscription was signed in.",
					);
				} catch (error) {
					pushInfo(ctx.handle, `Could not sign out: ${error instanceof Error ? error.message : error}`);
				}
			})();
			return true;
		}
		case "/gamepad": {
			const pad = ctx.pad;
			const arg = text.split(/\s+/)[1]?.toLowerCase();
			if (!pad) {
				pushInfo(ctx.handle, "No controller in this session.");
				return true;
			}

			/**
			 * Write one field of the `gamepad` block, and say whether it stuck.
			 *
			 * Nested rather than top-level: `writeUserSettingsPatch` replaces the
			 * whole key, so `/gamepad off` written that way would take the user's
			 * `bindings` and `phrases` with it.
			 */
			const save = (patch: Record<string, unknown>): string => {
				const shadowed = shadowedChoiceNotice(ctx.loadedSettings, "gamepad", (path) => shortenHome(path, ctx.home));
				try {
					writeUserSettingsNestedPatch("gamepad", patch, ctx.home);
					return shadowed ? ` (${shadowed})` : "";
				} catch (error) {
					// In effect either way; only the write failed.
					return ` (not saved: ${error instanceof Error ? error.message : String(error)})`;
				}
			};

			if (arg === "on" || arg === "off") {
				const next = arg === "on";
				const saved = save({ enabled: next });
				if (!next) ctx.padWatch.stop();
				void pad.setEnabled(next).then(() => {
					pushInfo(ctx.handle, `${next ? padHeadline(pad.service.status()) : "Gamepad off"}${saved}`);
				});
				return true;
			}

			if (arg === "approve") {
				const value = text.split(/\s+/)[2]?.toLowerCase();
				if (value && value !== "on" && value !== "off") {
					pushInfo(ctx.handle, "Usage: /gamepad approve [on|off] — with no argument it toggles");
					return true;
				}
				// Toggled from what is in force, not from the file: the setting and the
				// running bridge are kept together by the runtime, and a file read here
				// would answer with what was written once rather than with what ✕ does.
				const next = value ? value === "on" : !pad.config.allowApprove;
				pad.setAllowApprove(next);
				pushInfo(
					ctx.handle,
					`Gamepad approvals ${next ? "on — ✕ may answer a permission dialog" : "off — the keyboard answers"}` +
						save({ allowApprove: next }),
				);
				return true;
			}

			switch (arg) {
				case undefined: {
					// The mapping, which is the manual. The ids are what the settings file
					// writes, so printing them is how a user learns them. The surface's
					// gestures get their own heading rather than a run of rows under
					// "Button": they are not buttons on the pad, and a table that mixed them
					// in would read as a list of keys that half exist.
					const families: ReadonlyArray<[string, readonly PadInputId[]]> = [
						["Button", DS4_BUTTON_IDS],
						["Touch surface", PAD_TOUCH_IDS],
					];
					const lines = [padHeadline(pad.service.status()), ""];
					for (const [heading, ids] of families) {
						if (lines.length > 2) lines.push("");
						lines.push(`  ${heading.padEnd(18)}Action`);
						for (const id of ids) {
							const binding = pad.config.bindings[id];
							const marker = isDefaultBinding(id, binding) ? "" : "  *";
							lines.push(`  ${id.padEnd(18)}${bindingText(binding)}${marker}`);
						}
					}
					lines.push("");
					lines.push("  * = changed from the default. Rebind them in settings.json:");
					lines.push('  "gamepad": { "bindings": { "cross": "confirm", "r2": "command:/status" } }');
					for (const problem of pad.config.problems) lines.push(`  ${problem}`);
					pushInfo(ctx.handle, lines.join("\n"));
					return true;
				}
				case "status":
					pushInfo(ctx.handle, formatPadStatus(pad.service.status(), pad.config, pad.service, Date.now()));
					return true;
				case "reset":
					// The rescue for a pad that is answering wrongly rather than not at
					// all: a handle the OS re-pointed, a link that went quiet under the
					// watchdog's two seconds. Reported after the fact, because the point
					// of it is what the pad looks like now.
					pad.service.rescan();
					pushInfo(ctx.handle, padHeadline(pad.service.status()));
					return true;
				case "watch": {
					const watching = ctx.padWatch.toggle();
					pushInfo(
						ctx.handle,
						watching
							? "Watching the controller — every change is a line here. /gamepad watch again to stop."
							: "Stopped watching the controller.",
					);
					return true;
				}
				case "list": {
					const devices = pad.service.devices();
					// An empty list has two very different causes — nothing plugged in,
					// and the optional module not installed — and the status is what knows
					// which, so it supplies the sentence.
					pushInfo(
						ctx.handle,
						devices.length === 0
							? `${padHeadline(pad.service.status())} — nothing to list.`
							: devices
									.map((device) => `  ${describePadDevice(device)}${device.carriesReports ? "" : " (no reports)"}`)
									.join("\n"),
					);
					return true;
				}
				case "rumble":
					// The one check that needs no screen: if the motors answer, the write
					// path works. With the switch off there is nothing to hear, and a
					// command that silently does nothing is worse than one that says why.
					if (!pad.config.rumble) {
						pushInfo(ctx.handle, "Rumble is off — gamepad.rumble is false in settings.");
						return true;
					}
					pad.bridge.buzz("alert");
					pushInfo(ctx.handle, "Buzzed.");
					return true;
				default:
					pushInfo(ctx.handle, `Unknown: /gamepad ${arg} — try on, off, status, watch, list, reset, approve, rumble`);
					return true;
			}
		}
		case "/vim":
			return applyEditorCommand(ctx, text, "vimMode");
		case "/emacs":
			return applyEditorCommand(ctx, text, "emacsMode");
		default:
			return false;
	}
}

/**
 * `/vim` and `/emacs`, which are one operation on an exclusive pair.
 *
 * Written once rather than twice on purpose. What is interesting about these two
 * commands is not the flag they set — it is the *other* flag they have to clear,
 * in the store and in the file, and the fact that they have to say so. A second
 * copy of that logic is a second thing to forget, and the failure it produces is
 * silent: a prompt that is both modal and modeless answers `C-f` according to
 * whichever engine was built last, and nothing in the UI mentions it.
 *
 * The store side of the exclusivity belongs to the handle — `setVimMode` and
 * `setEmacsMode` each clear the other — so that every route into the store gets
 * it, not just this one. What lives here is the file and the sentence. A store
 * that changed while the file did not is a run that ends in one editor and a next
 * run that opens in the other, which reads as the setting having been ignored.
 */
function applyEditorCommand(ctx: AppCommandContext, text: string, kind: "vimMode" | "emacsMode"): boolean {
	const label = kind === "vimMode" ? "Vim" : "Emacs";
	const arg = text.split(/\s+/)[1]?.toLowerCase();
	if (arg && arg !== "on" && arg !== "off") {
		pushInfo(ctx.handle, `Usage: /${kind === "vimMode" ? "vim" : "emacs"} [on|off] — with no argument it toggles`);
		return true;
	}
	const live = ctx.handle?.store.get();
	const on = kind === "vimMode" ? live?.vim === true : live?.emacs === true;
	// Toggled from what is actually on, not from the settings file: `/emacs` in a
	// session that started in emacs mode means off, and reading the saved value
	// would give the same answer every time.
	const next = arg ? arg === "on" : !on;
	if (kind === "vimMode") ctx.handle?.setVimMode(next);
	else ctx.handle?.setEmacsMode(next);

	const other = opposingEditorKey(kind);
	// Read live rather than off the file, because the sentence is about what just
	// changed and the file can be stale — a session that started before the last
	// edit, or a hand-edited file the store never saw.
	const otherOn = other === "vimMode" ? live?.vim === true : live?.emacs === true;
	const reasons: string[] = [];
	const cleared = editorShadowNotice({ [other]: otherOn }, kind, next);
	if (cleared) reasons.push(cleared);
	else {
		const shadowed = shadowedChoiceNotice(ctx.loadedSettings, kind, (path) => shortenHome(path, ctx.home));
		if (shadowed) reasons.push(shadowed);
	}
	// Turning one *on* writes the other's `false` next to it, which is the only
	// way to express "these are exclusive" with two independent booleans. Turning
	// one off writes only its own key, so `/emacs off` cannot quietly un-set a
	// vimMode the user set in the file and was never asked about.
	const patch = next ? { [kind]: true, [other]: false } : { [kind]: false };
	const said = `${label} mode ${next ? "on" : "off"}${reasons.length ? ` (${reasons.join("; ")})` : ""}`;
	try {
		writeUserSettingsPatch(patch, ctx.home);
		pushInfo(ctx.handle, said);
	} catch (error) {
		// Already in effect; only the write failed. Said in the same shape as every
		// other settings write in this file, so the reason reads as a reason and
		// not as a second thing that happened.
		const why = error instanceof Error ? error.message : String(error);
		pushInfo(
			ctx.handle,
			`${label} mode ${next ? "on" : "off"}${reasons.length ? ` (${reasons.join("; ")}; ` : " ("}not saved: ${why})`,
		);
	}
	return true;
}

/**
 * What `/ps` and `/stop` need from the shell manager. Structural rather than the
 * class itself so a test can hand in shells without spawning anything.
 */
export interface BackgroundShellAccess {
	list(): BackgroundShell[];
	output(id: string, maxChars?: number): string;
	kill(id: string): boolean;
}

function pushInfo(handle: ReplAppHandle | null, text: string): void {
	handle?.store.set((s) => ({ ...s, entries: [...s.entries, { kind: "info", text }] }));
}

/**
 * The usage of each `/mcp` read subcommand, in one place so the line an error
 * prints and the row `/help` carries cannot drift apart.
 */
const MCP_SUBCOMMAND_USAGE = {
	prompts: "Usage: /mcp prompts <server>",
	prompt: "Usage: /mcp prompt <server> <name> [key=value ...]",
	resources: "Usage: /mcp resources <server>",
	resource: "Usage: /mcp resource <server> <uri>",
} as const;

/**
 * Cap for one `/mcp` entry, the same bound the "!" passthrough applies to what
 * it writes: a resource read can be any size the server likes, and a transcript
 * entry is not where all of it has to live.
 */
function capInfoText(text: string): string {
	return text.length > RESULT_TEXT_CAP ? text.slice(0, RESULT_TEXT_CAP) : text;
}

/** The connection a `/mcp` read should go to: by name, and only if it opened. */
function connectedMcpServer(ctx: AppCommandContext, serverName: string | undefined): McpConnection | undefined {
	if (!serverName) return undefined;
	return ctx.mcpConnections.find((connection) => connection.serverName === serverName && connection.client);
}

/** What a named-but-not-connected server gets: the usage, and the name's absence. */
function mcpUnknownServer(sub: keyof typeof MCP_SUBCOMMAND_USAGE, serverName: string): string {
	return (
		`${MCP_SUBCOMMAND_USAGE[sub]}\n` +
		`Unknown or unconnected MCP server: "${serverName}" — /mcp lists the servers this session is connected to.`
	);
}

/**
 * One failed `/mcp` read. A silent screen would read as a server with nothing
 * to show, which is a claim about the server rather than about the request.
 */
function mcpReadFailure(request: string, serverName: string, error: unknown): string {
	return `MCP ${request} on "${serverName}" failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** One `prompts/list` answer as the `/mcp prompts` entry. */
function formatMcpPrompts(serverName: string, prompts: Array<{ name: string; description?: string }>): string {
	if (prompts.length === 0) return `MCP server "${serverName}" lists no prompts.`;
	// Name first, because it is what `/mcp prompt <server> <name>` addresses.
	const lines = prompts.map((prompt) => `  ${prompt.name}${prompt.description ? ` — ${prompt.description}` : ""}`);
	return `Prompts on MCP server "${serverName}":\n${lines.join("\n")}`;
}

/** One block of a prompt message, flattened to what a terminal can show. */
function renderMcpPromptBlock(block: McpPromptBlock): string {
	switch (block.type) {
		case "text":
			return block.text ?? "";
		case "image":
		case "audio":
			// Named and counted rather than mangled: the bytes behind it are base64
			// that would fill the entry and say nothing.
			return `[${block.type} ${block.mimeType ?? "unknown type"}]`;
		case "resource":
		case "resource_link":
			return `[${block.type} ${block.uri ?? "unknown uri"}]`;
		default:
			return `[${block.type}]`;
	}
}

/** One `prompts/get` answer as the `/mcp prompt` entry. */
function formatMcpPrompt(serverName: string, name: string, prompt: McpPrompt): string {
	// The messages are what the server would hand the model, shown as they would
	// be read — role by role, in the server's own order.
	const header = `Prompt "${name}" on MCP server "${serverName}"${prompt.description ? ` — ${prompt.description}` : ""}:`;
	if (prompt.messages.length === 0) return `${header}\n  (no messages)`;
	const lines = prompt.messages.map(
		(message) => `  ${message.role}: ${message.content.map(renderMcpPromptBlock).join(" ")}`,
	);
	return [header, ...lines].join("\n");
}

/** One `resources/list` answer as the `/mcp resources` entry. */
function formatMcpResources(serverName: string, resources: McpResourceSummary[]): string {
	if (resources.length === 0) return `MCP server "${serverName}" lists no resources.`;
	// The uri comes first: it is what `/mcp resource <server> <uri>` addresses.
	const lines = resources.map(
		(resource) =>
			`  ${resource.uri}${resource.name ? ` — ${resource.name}` : ""}${resource.mimeType ? ` (${resource.mimeType})` : ""}`,
	);
	return `Resources on MCP server "${serverName}":\n${lines.join("\n")}`;
}

/** One `resources/read` answer as the `/mcp resource` entry. */
function formatMcpResource(serverName: string, uri: string, contents: McpResourceContents[]): string {
	if (contents.length === 0) return `MCP resource "${uri}" on "${serverName}" answered no contents.`;
	const parts = contents.map((entry) => {
		if (entry.text !== undefined) return entry.text;
		// A blob is bytes a terminal cannot show; its size is the honest part.
		const bytes = Buffer.from(entry.blob ?? "", "base64").length;
		return `[binary ${entry.mimeType ?? "unknown type"}, ${bytes} bytes]`;
	});
	return `Resource "${uri}" on MCP server "${serverName}":\n${parts.join("\n")}`;
}

/**
 * A path as the user thinks of it, with `~` for their home directory.
 *
 * The status card is the one place the working directory is spelled out, and
 * `/Users/someone/projects/thing` is mostly noise next to `~/projects/thing`.
 * A home that is not a prefix (a `--cwd` outside it) is left exactly as given —
 * showing a partial match would be worse than showing the whole path.
 */
export function shortenHome(path: string, home: string | undefined): string {
	if (!home) return path;
	if (path === home) return "~";
	const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
	return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
}

/**
 * What `/model <ref>` says when the reference names nothing.
 *
 * At module scope rather than inside `switchModel` for one reason: that closure
 * holds seven bindings and is not reachable from any exported entry point, so a
 * message written in it is a message nothing can check. This is pure over two
 * exported functions and is tested as one.
 *
 * The hint exists because the `/model` picker labels every row `provider/id`
 * while a bare id is the thing people type. Since the gateway rows are reachable
 * only qualified, "Unknown model: gpt-5-codex" would be a sentence about a model
 * the user can see on the list they just came from. `gatewayProvidersFor` returns
 * nothing whenever the bare name would have worked, so the hint cannot fire on a
 * model that was fine.
 */
export function unknownModelMessage(ref: string): string {
	const elsewhere = gatewayProvidersFor(ref);
	if (elsewhere.length === 0) return `Unknown model: ${ref}`;
	// Every provider, so a model on all four says so once rather than sending the
	// reader off to compare; the first is offered as the thing to try, and table
	// order puts Zen before Go.
	return `Unknown model: ${ref} — offered by ${elsewhere.join(", ")}; try ${elsewhere[0]}/${ref}`;
}

export { type AppCommandContext, appendHistory, handleAppCommand, handleCommandDispatch };
