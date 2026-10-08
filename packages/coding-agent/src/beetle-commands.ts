/**
 * /beetle's app layer: the picker, the settings file, the tool-block change,
 * and the lines the user reads.
 *
 * `beetle.ts` owns the band itself — sessions, the bus, refusals. This module
 * owns what the REPL does with it. It is a factory over injected dependencies
 * rather than a set of closures inside the REPL run for one reason: the flow
 * has branches worth holding down — first run asks and saves, a saved config
 * skips the asking, a cancel writes nothing, reconfiguring opens on what the
 * members actually run — and with the picker injected a test walks all of them
 * without a terminal.
 */
import type { AgentSession, AnyTool, NetworkAxis, PermissionMode, PermissionRule, SandboxMode } from "@labunbun/agent";
import type { Model, StreamFn, ThinkingLevel } from "@labunbun/ai";
import {
	BeetleBand,
	type BeetleMember,
	type BeetleModels,
	type BeetlePickOption,
	formatReceipt,
	memberTallyLines,
	pickBeetleModels,
	routeMention,
	SESSION_MODEL_REF,
} from "./beetle.ts";
import { writeUserSettingsNestedPatch } from "./user-settings.ts";

/** The slice of a status card `/beetle status` draws; the rest is the UI's. */
export interface BeetleStatusCard {
	title: string;
	details: Array<[string, string]>;
}

/** The board slice the summary line reads — `TaskStore.summary()`'s shape. */
export interface BoardTask {
	id: string;
	subject: string;
	status: "pending" | "in_progress" | "completed";
	owner?: string;
}

/**
 * The board's one-line summary for `/beetle status`. Pure, so the shapes —
 * empty, nothing in progress, several in progress — are test rows rather than
 * whatever a live store happens to hold.
 */
export function boardLine(tasks: BoardTask[]): string {
	if (tasks.length === 0) return "Board: no tasks yet.";
	const parts = [`${tasks.length} task${tasks.length === 1 ? "" : "s"}`];
	const active = tasks
		.filter((task) => task.status === "in_progress")
		.map((task) => `#${task.id} ${task.subject}${task.owner ? ` (${task.owner})` : ""}`);
	if (active.length > 0) parts.push(`in_progress: ${active.join(", ")}`);
	parts.push(`${tasks.filter((task) => task.status === "pending").length} pending`);
	parts.push(`${tasks.filter((task) => task.status === "completed").length} completed`);
	return `Board: ${parts.join(" · ")}`;
}

export interface BeetleSurfaceDeps {
	/** One transcript line. */
	notify: (line: string) => void;
	/** The user's own typed line, appended where the REPL would have put it. */
	pushUserEntry: (text: string) => void;
	/** The main session, read at the call — a /resume swaps it. */
	getSession: () => AgentSession | null;
	/** The list picker; a null index is a cancellation. */
	pick: (title: string, items: BeetlePickOption[], initialIndex: number) => Promise<number | null>;
	/** The picker's rows; defaults to `offeredModels()` inside pickBeetleModels. */
	models?: Model[];
	home: string | undefined;
	cwd: string;
	/** The worker table members draw from; MCP is the separate list (see BeetleBandOptions). */
	allTools: AnyTool[];
	mcpTools: AnyTool[];
	streamFn: StreamFn;
	model: () => Model;
	resolveModel: (ref: string) => Model | undefined;
	canRunModel: (model: Model) => boolean;
	thinkingLevel: () => ThinkingLevel | undefined;
	trimOldToolResults?: boolean;
	permissionMode: () => PermissionMode | undefined;
	sandbox: () => SandboxMode | undefined;
	network: () => NetworkAxis | undefined;
	getPermissionRules: () => PermissionRule[];
	/**
	 * Arm the pending tool-block-change registration for the main session's next
	 * turn. The band's `setTools` is a cached-prefix rewrite, and its cause is
	 * consumed by whichever family requests next — so it cannot register where
	 * the change happens. The app wires this to `createToolChangeLatch` and
	 * feeds that latch every main-session event.
	 */
	noteToolChange: (cause: string) => void;
	/** `/beetle status` draws its table here; absent when nothing can. */
	setStatusCard?: (card: BeetleStatusCard) => void;
	/** The shared task board, read at the call — `TaskStore.summary()` in the app. */
	taskBoard?: () => BoardTask[];
	/** The seeded config from settings; null = never configured. */
	initialModels: Partial<BeetleModels> | null;
	/** Per-run turn cap for every member (settings.beetle.maxTurns); undefined = unbounded. */
	maxTurns?: number;
	/** Band-wide dollar ceiling (settings.beetle.maxCostUSD); undefined = unbounded. */
	maxCostUSD?: number;
}

export interface BeetleSurface {
	start(task: string): void;
	configure(): void;
	stop(): void;
	say(target: BeetleMember | "all", text: string): void;
	status(): void;
	/** True when `text` was an @-mention and has been delivered to that member. */
	handleMention(text: string): boolean;
	/** Abort the members at process exit; nothing is waiting for the answer. */
	shutdown(): void;
}

/**
 * The tool-block-change cause latch. `setTools` is a cached-prefix rewrite, and
 * its cause has to be registered as a cache cause — but not where the change
 * happens: the causes queue is global and the next recorded request from *any*
 * family consumes it whole, so a note armed at band start would be eaten by
 * whichever member answers first, and the main session's own later rewind
 * would read as UNREGISTERED in `/cache`. Arming on the change and registering
 * on the main session's own next `turn_start` ties the cause to the request it
 * belongs to. The residue — a member request landing between that turn's start
 * and its first request — costs one misattributed line there.
 */
export interface ToolChangeLatch {
	arm(cause: string): void;
	/** Call for every session event; an armed cause registers on `turn_start`. */
	observe(event: { type: string }): void;
	/**
	 * Drop an armed cause without registering it. A hot swap replaces the
	 * session the cause was armed for; without this, the incoming session's
	 * first `turn_start` would register a cause that belongs to the outgoing
	 * session's tool change.
	 */
	reset(): void;
}

export function createToolChangeLatch(note: (cause: string) => void): ToolChangeLatch {
	let pending: string | null = null;
	return {
		arm(cause) {
			pending = cause;
		},
		observe(event) {
			if (event.type !== "turn_start" || pending === null) return;
			note(pending);
			pending = null;
		},
		reset() {
			pending = null;
		},
	};
}

export function createBeetleSurface(deps: BeetleSurfaceDeps): BeetleSurface {
	let band: BeetleBand | null = null;
	let configured: Partial<BeetleModels> | null = deps.initialModels;
	/** A picker sequence is walking; a second start must not open a second one. */
	let picking = false;

	function pickModels(current?: Partial<BeetleModels>): Promise<BeetleModels | null> {
		const session = deps.getSession();
		return pickBeetleModels({
			pick: deps.pick,
			models: deps.models,
			sessionModel: session ? `${session.model.provider}/${session.model.id}` : "the session model",
			current,
		});
	}

	function saveModels(models: BeetleModels): void {
		configured = models;
		try {
			writeUserSettingsNestedPatch("beetle", { models }, deps.home);
		} catch (error) {
			// In effect for this process either way; only the write failed — the
			// same shape every other settings write in this app reports in.
			deps.notify(`Band models chosen but not saved: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function detachTool(target: BeetleBand): void {
		const session = deps.getSession();
		if (!session?.tools.includes(target.mainTool)) return;
		session.setTools(session.tools.filter((tool) => tool !== target.mainTool));
		deps.noteToolChange("beetle: band tool removed");
	}

	function spawn(task: string): void {
		const models: BeetleModels = {
			john: SESSION_MODEL_REF,
			paul: SESSION_MODEL_REF,
			george: SESSION_MODEL_REF,
			ringo: SESSION_MODEL_REF,
			...configured,
		};
		const next = new BeetleBand({
			models,
			cwd: deps.cwd,
			streamFn: deps.streamFn,
			allTools: deps.allTools,
			mcpTools: deps.mcpTools,
			model: deps.model,
			resolveModel: deps.resolveModel,
			canRunModel: deps.canRunModel,
			thinkingLevel: deps.thinkingLevel,
			trimOldToolResults: deps.trimOldToolResults,
			maxTurns: deps.maxTurns,
			maxCostUSD: deps.maxCostUSD,
			onNotice: deps.notify,
			report: deps.notify,
			// Every disband path — the user's /beetle off, the budget ceiling —
			// takes the main session's tool off here, so no dead BandMessage
			// survives a band that is no longer on stage.
			onDisband: () => detachTool(next),
			getMain: deps.getSession,
			permissionMode: deps.permissionMode,
			sandbox: deps.sandbox,
			network: deps.network,
			getPermissionRules: deps.getPermissionRules,
		});
		band = next;
		const session = deps.getSession();
		if (session) {
			session.setTools([...session.tools, next.mainTool]);
			deps.noteToolChange("beetle: band tool added");
		}
		deps.notify(`Band on stage — John, Paul, George and Ringo are on it: ${task}`);
		next.start(task);
	}

	return {
		start(task) {
			if (band?.active) {
				deps.notify("A band is already on stage — /beetle off disbands it first.");
				return;
			}
			if (picking) {
				deps.notify("The model picker is still open — answer or cancel it first.");
				return;
			}
			if (configured) {
				spawn(task);
				return;
			}
			// First start: the four choices come before anything runs, and a cancel
			// at any step leaves the setting absent — which is what makes the next
			// start ask again rather than silently reuse a half-picked config.
			picking = true;
			void (async () => {
				try {
					const picked = await pickModels();
					if (!picked) {
						deps.notify("Band cancelled — nothing started, nothing saved.");
						return;
					}
					saveModels(picked);
					spawn(task);
				} catch (error) {
					// The picker is a dialog the host owns; a rejection here used to
					// vanish as an unhandled rejection — no band, and no line saying why.
					deps.notify(`Band start failed: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					picking = false;
				}
			})();
		},

		configure() {
			if (picking) {
				deps.notify("The model picker is still open — answer or cancel it first.");
				return;
			}
			// Live refs when a band exists: reconfiguring should open on what the
			// members are actually running, not on what the file last said.
			const current = band
				? (Object.fromEntries(band.status().map((entry) => [entry.name, entry.modelRef])) as Partial<BeetleModels>)
				: (configured ?? undefined);
			picking = true;
			void (async () => {
				try {
					const picked = await pickModels(current);
					if (!picked) {
						deps.notify("Model reconfiguration cancelled — nothing changed.");
						return;
					}
					saveModels(picked);
					deps.notify(
						band?.active
							? "Band models saved — the current band keeps its models; the next one uses these."
							: "Band models saved.",
					);
				} catch (error) {
					deps.notify(`Model reconfiguration failed: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					picking = false;
				}
			})();
		},

		stop() {
			const current = band;
			if (!current?.active) {
				deps.notify("No band is on stage.");
				return;
			}
			try {
				const members = current.off();
				deps.notify(`Band off. Final tally:\n${memberTallyLines(members).join("\n")}`);
			} finally {
				// The disband is already under way: the tool comes off the session
				// even if the band's own teardown throws — otherwise the main
				// session keeps a BandMessage that points at nothing. Idempotent:
				// `off()` already detached through `onDisband`.
				detachTool(current);
			}
		},

		say(target, text) {
			if (!band?.active) {
				deps.notify("No band is on stage — start one with /beetle <task>.");
				return;
			}
			// The relay line already reaches the transcript through onNotice; only
			// the refusal reasons would otherwise vanish.
			const outcome = band.deliver({ kind: "user" }, target, text);
			if (!outcome.ok) deps.notify(formatReceipt(outcome));
		},

		status() {
			const current = band;
			if (!current) {
				deps.notify("No band yet — start one with /beetle <task>.");
				return;
			}
			const members = current.status();
			deps.setStatusCard?.({
				title: current.active ? "Beetle band" : "Beetle band (disbanded)",
				details: members.map((entry) => [
					`${entry.name} (${entry.role})`,
					`${entry.model}${entry.pendingRef ? ` — waiting on ${entry.pendingRef}` : ""} · ${entry.state} · ${entry.turns} turns · $${entry.costUSD.toFixed(4)}${entry.unpriced ? " unpriced" : ""}${
						entry.lastActivity ? ` · ${entry.lastActivity}` : ""
					}`,
				]),
			});
			const running = members.filter((entry) => entry.state === "live").length;
			const turns = members.reduce((sum, entry) => sum + entry.turns, 0);
			const cost = members.reduce((sum, entry) => sum + entry.costUSD, 0);
			deps.notify(
				`Band: ${running}/${members.length} running · ${turns} turns · $${cost.toFixed(4)}${current.active ? "" : " · disbanded"}`,
			);
			// The board last: the tally line is about the band, the board line is
			// about the work — and the two read together are what "how is it going"
			// means. Absent when no board is wired (a test surface, headless).
			const board = deps.taskBoard?.();
			if (board) deps.notify(boardLine(board));
		},

		handleMention(text) {
			if (!band?.active) return false;
			const mention = routeMention(text);
			if (!mention) return false;
			// The user's own line first: a handled verdict suppresses the REPL's
			// push, and the relay notice would otherwise land before the line it
			// relays.
			deps.pushUserEntry(text);
			const outcome = band.deliver({ kind: "user" }, mention.member, mention.text);
			if (!outcome.ok) deps.notify(formatReceipt(outcome));
			return true;
		},

		shutdown() {
			band?.off();
		},
	};
}
