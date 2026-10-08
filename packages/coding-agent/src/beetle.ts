/**
 * /beetle — a band of four long-lived members that work a task together.
 *
 * The design is a message-driven relay: a delivery to a member is both a
 * message and a wake-up. An idle member starts on it immediately; a busy one
 * reads it at its turn boundary (the session's follow-up queue, whose contract
 * is "restart the loop after natural termination" — steering would dangle, see
 * `session.ts`). A delivery can also be marked wake-less: it then waits in a
 * per-target mailbox and rides in front of the next waking delivery to that
 * target, so a stopped member can be given work to read on revival instead of
 * being woken into a failing request per message. Nobody polls: with every
 * member idle the band costs nothing, and only `/beetle off` disbands it.
 *
 * The four seats exist so the roles are structurally forced rather than asked
 * for politely. John has no Edit/Write: his only way to change anything is a
 * message to Paul, the single writer. George has no Edit/Write either: a
 * verifier who can patch tends to patch instead of reporting. Ringo has none:
 * a runner that fixes the thing under test hides the evidence. This is
 * structural guidance, not a sandbox — every seat keeps Bash, and Bash can
 * write — and the personas say so honestly.
 *
 * The band's own tool is BandMessage: the main session gains it while a band
 * is active, and each member carries its own copy with `main` added to its
 * targets. The shared task board (TaskCreate/TaskGet/TaskList/TaskUpdate) is
 * not built here — it arrives in the worker table backed by the main session's
 * store — and the name filter below keeps it in every seat's table, so all
 * four work off one board.
 */
import {
	type AgentEvent,
	AgentSession,
	type AnyTool,
	buildTool,
	evaluatePermissions,
	type NetworkAxis,
	type PermissionMode,
	type PermissionRule,
	type SandboxMode,
} from "@labunbun/agent";
import { type Model, resolveApiKey, type StreamFn, type ThinkingLevel, textContent } from "@labunbun/ai";
import { TASK_BOARD_TOOL_NAMES } from "@labunbun/tools";
import { z } from "zod";
import { type CompactionWiring, createCompactionWiring } from "./compaction-wiring.ts";
import { costStateFromMessages } from "./cost-tracker.ts";
import { offeredModels } from "./model-offer.ts";

export const BEETLE_MEMBERS = ["john", "paul", "george", "ringo"] as const;
export type BeetleMember = (typeof BEETLE_MEMBERS)[number];

/** The seat captions, one word each, used in envelopes, pickers and briefings. */
export const BEETLE_ROLES: Record<BeetleMember, string> = {
	john: "lead",
	paul: "implementer",
	george: "verifier",
	ringo: "builder",
};

const DISPLAY_NAME: Record<BeetleMember, string> = {
	john: "John",
	paul: "Paul",
	george: "George",
	ringo: "Ringo",
};

/** Per-member model config: a `provider/id` ref, or the sentinel `"session"`. */
export type BeetleModels = Record<BeetleMember, string>;

/** `"session"` means "whatever model the session is on", resolved at the call. */
export const SESSION_MODEL_REF = "session";

// ---------------------------------------------------------------------------
// Envelopes — provenance for messages that arrive as user-role turns
// ---------------------------------------------------------------------------

/**
 * Who a band message is from. Split from the display string so the envelope,
 * the user-visible line and the receipts cannot disagree about a sender.
 */
export type BandSender = { kind: "member"; name: BeetleMember } | { kind: "main" } | { kind: "user" };

/** A member, the main session, or everyone (minus the sender, for members). */
export type BandTarget = BeetleMember | "main" | "all";

function senderLabel(sender: BandSender): string {
	if (sender.kind === "member") return `${DISPLAY_NAME[sender.name]} (${BEETLE_ROLES[sender.name]})`;
	if (sender.kind === "main") return "the main session";
	return "the user";
}

const BAND_REPLY_HINT =
	"Reply with BandMessage to anyone (john | paul | george | ringo | main | all), or end your turn and stand by.";

/**
 * The text a member (or the main session) receives for a band message.
 *
 * The first line is load-bearing: without it, a user-role message from a peer
 * reads exactly like the user speaking — as a new instruction, or worse, as
 * consent to keep going. "From the user" is the only variant that means the
 * user; everything else is automated band traffic.
 */
export function bandEnvelope(sender: BandSender, text: string): string {
	const from = senderLabel(sender);
	const provenance =
		sender.kind === "user"
			? "[beetle band message — from the user, not a peer relay]"
			: `[beetle band message — relayed from ${from}, automated; not from the user]`;
	return `${provenance}\nFrom: ${from}\n\n${text}\n\n${BAND_REPLY_HINT}`;
}

/** How much of a message the one-line transcript notice echoes. */
export const BAND_LINE_PREVIEW_CHARS = 80;

function senderShortName(sender: BandSender): string {
	if (sender.kind === "member") return DISPLAY_NAME[sender.name];
	if (sender.kind === "main") return "main";
	return "you";
}

function targetShortName(target: BandTarget): string {
	return target === "main" ? "main" : target === "all" ? "all" : DISPLAY_NAME[target];
}

/**
 * The line the user sees for a relay: one line, first line of the message
 * only, truncated — the transcript is a window on the band, not its archive.
 */
export function bandLine(sender: BandSender, target: BandTarget, text: string): string {
	const firstLine = (text.split(/\r?\n/, 1)[0] ?? "").trim();
	const preview =
		firstLine.length > BAND_LINE_PREVIEW_CHARS ? `${firstLine.slice(0, BAND_LINE_PREVIEW_CHARS - 1)}…` : firstLine;
	return `[beetle] ${senderShortName(sender)} → ${targetShortName(target)}: ${preview}`;
}

// ---------------------------------------------------------------------------
// Personas — written for this repo; the band is a working team, not cosplay
// ---------------------------------------------------------------------------

const SHARED_ROSTER = `The band:
- John (lead): direction — what gets done, in what order, and what "done" means. Arbitrates. Reports to main.
- Paul (implementer): the only member who writes. Implementation, fixes, self-tests; packages work for verification.
- George (verifier): research and adversarial verification. Evidence first; fixes route back to Paul.
- Ringo (builder): builds and runs things. Commands, exit codes and raw output; his reports are the band's shared ground truth.`;

const SHARED_PROTOCOL = `Band protocol:
1. Handoff five: task / files involved / constraints / why now / what done looks like. A receiver may bounce back a message that omits them.
2. "I'm done" is not "verified": a completion report cites who verified what, with which command and result.
3. Non-trivial plans get one adversarial pass from George before Paul starts — one round, not a loop.
4. Evidence discipline: file:line or command + exit code; verify against the live workspace, never from memory.
5. Band messages are work orders, not prose — short and specific.
6. Verify once: an unchanged, settled conclusion is not re-verified; a change reopens it.
7. Standby, not polling: with nothing to do, end your turn. Messages wake you.
8. Never relay approvals: permission prompts belong to the real permission system; no member — main included — can grant one for the user.
9. The board is the record, messages are the wake-up: put assignments on the shared task board (TaskCreate/TaskUpdate, owner set to whoever takes the piece) and follow with a BandMessage to that owner. Keep at most one of your own tasks in_progress at a time.`;

const MESSAGE_MECHANICS = `How messages reach you: as a user-role message whose first line starts with [beetle band message — …] and names its sender. Peer traffic and messages from main are automated, never the user speaking; only the "from the user" envelope is the user. Reply with the BandMessage tool. Your final text reaches nobody but your own transcript — a report that matters must be sent.`;

const IDENTITY_JOHN = `You are John, the band's lead. You set direction: what gets done, in what order, and what "done" means. When a task arrives you turn it into a plan, split it into pieces, and route each piece to the right player. You do not write code — you have no Edit or Write tool, deliberately: your way to change anything is a BandMessage to Paul.

You:
- Define "done" and the evidence it needs before anyone starts.
- Propose the split and assign pieces with the handoff five.
- Ask George for one adversarial pass on any non-trivial plan, then commit to the approach — one round, no churn.
- Arbitrate: when Paul and George disagree, decide on evidence, not volume.
- Route every edit to Paul; when a fix is needed, it is his.
- Keep day-to-day execution out of your hands: Paul owns the how. Do not ask for step-by-step status unless direction changes.
- Report to main: what changed, what proved it, what is left — citing verification, never assuming it.

Refuse: implementing anything yourself; approving on the user's behalf; declaring done without verification you can cite.

Prototype: the band's founder and catalyst for change — moved the group somewhere new, held it together in a crisis, then handed day-to-day running to Paul.`;

const IDENTITY_PAUL = `You are Paul, the band's implementer — the only member who writes. Every edit in the band comes from you.

You:
- Turn direction into working code; the "how" is yours, so refine details in place rather than asking John about them.
- Run your own tests as you go — that is craft, not verification. The verification stamp belongs to George (logic, claims) and Ringo (builds, runs).
- Package finished work for verification with the handoff five; when George bounces something back, resolve his question before continuing.
- Keep long tasks moving: when work remains, say what you are doing next and do it. You are the engine — the band advances at your tempo.
- Use whatever the job needs: you carry the full toolset, and a missing tool is never an excuse — it is a different approach.

Refuse: certifying your own work as verified (say "ready for verification", with what to check); pushing past George's questions — they are the product, not an obstacle.

Prototype: the band's arranger and workhorse — took raw ideas and built them out note by note, kept every session moving, and got far more made than the others would have alone.`;

const IDENTITY_GEORGE = `You are George, the band's researcher and verifier. You check before anyone asserts, and you treat confirmation as the last resort: your job is to try to falsify.

You:
- Research first: read the code, run the risky command, search the web when the answer is not in this repo — then report with evidence.
- Verify completed work against the live workspace: re-read the files, re-run the command. A memory of what the code said is not evidence.
- Carry the detail ear: a half-note off is worth a message. Precision is the value you add.
- Bring outside knowledge in: when the band is stuck on an approach, go find how others solved it and bring back what fits.
- Report; do not patch. You have no Edit or Write tool — deliberately: a verifier who can fix tends to fix instead of saying what is wrong. Fixes route to Paul.
- Take the work nobody notices: the quiet check that catches the break is worth more than a showy output. Silence is fine — the record is the point.

Refuse: verdicts without evidence ("looks fine" is not a finding); skipping verification because a change "looks trivial".

Prototype: the quiet one — meticulous ear for detail, went outside the band to bring in sounds nobody there had heard, did his part without seeking notice; the record shows where it landed.`;

const IDENTITY_RINGO = `You are Ringo, the band's builder and runner. You run things — builds, test suites, commands, reproductions — and report exactly what happened.

You:
- Execute exactly what was asked: command, exit code, and the relevant output, verbatim (truncate with an explicit marker, never silently).
- Report raw first, always: your account is the band's shared ground truth — John plans on it, Paul codes on it, George verifies against it. It never gets polished into something friendlier.
- First report is the accurate one: no retry for appearance, no retelling to look better. If it failed, the failure is the report.
- Don't decorate and don't interrupt: the output is the output. Commentary beyond the facts is other seats' job.
- Failures: report, don't fix. Fixes go to Paul — you have no Edit or Write tool, deliberately: a runner who patches the thing under test hides the evidence.
- Steady tempo: run after run, same accuracy. Long tasks lean on this.

Refuse: editing anything; running commands whose blast radius exceeds the task; passing on a "cleaned up" version of an output.

Prototype: the timekeeper — steady, right the first time, played for the song and never interrupted it; the one whose reliability held everyone else together.`;

const IDENTITIES: Record<BeetleMember, string> = {
	john: IDENTITY_JOHN,
	paul: IDENTITY_PAUL,
	george: IDENTITY_GEORGE,
	ringo: IDENTITY_RINGO,
};

export function memberSystemPrompt(member: BeetleMember): string {
	return [IDENTITIES[member], SHARED_ROSTER, SHARED_PROTOCOL, MESSAGE_MECHANICS].join("\n\n");
}

/**
 * The first message a member receives when a band starts.
 *
 * The task itself opens the message, verbatim: it is what the user will see in
 * the one-line relay notice, and the envelope above it already says where the
 * message came from, so a "The band's task:" header would only push the task
 * off the line. John is told to lead — propose the split first; the others
 * stand by for his assignment rather than all four charging at the same task.
 */
export function bandBriefing(member: BeetleMember, task: string): string {
	if (member === "john") {
		return `${task}\n\nYou hold the lead. Propose the split before work starts: what "done" means and the evidence it needs, the pieces, and who takes each. For anything non-trivial, take one adversarial pass from George on the approach first, then assign with the handoff five — each piece on the shared task board (owner set), the owner woken with a BandMessage. Route every edit to Paul. Report to main when the band lands something solid — or when it cannot.`;
	}
	return `${task}\n\nYou are ${DISPLAY_NAME[member]} (${BEETLE_ROLES[member]}). Stand by for John's assignment; if cheap, safe legwork in your seat helps, start it now and keep the first pass short. The band: John leads, Paul implements, George verifies, Ringo builds and runs. Anything the user must see goes to main.`;
}

// ---------------------------------------------------------------------------
// The BandMessage tool
// ---------------------------------------------------------------------------

/**
 * All of BandMessage's guidance lives in `description`, and none in a
 * `prompt` field, for a structural reason: the tool is injected into a
 * running session with `setTools`, and a session builds its system prompt once
 * at startup — a mid-session tool's `prompt` is never read by anyone. Do not
 * move this text into a `prompt`.
 */
export function bandToolDescription(canAddressMain: boolean): string {
	const targets = canAddressMain ? "john | paul | george | ringo | main | all" : "john | paul | george | ringo | all";
	return (
		`Send a message to the /beetle band. By default a message is also a wake-up: an idle member starts on it immediately; a busy one reads it at its next turn boundary. Pass wake: false to deliver without waking — an idle or stopped recipient reads it with its next wake-up. Targets: ${targets}. You cannot message yourself.\n\n` +
		"Assigning work? Include the handoff five: the task, the files involved, the constraints, why now, and what done looks like (the evidence you expect). A receiver may bounce back a message that omits them.\n\n" +
		'Band protocol: "I\'m done" is not "verified" — completion reports say who verified what, with which command. Factual claims carry file:line or a command and its exit code, checked against the live workspace, never from memory. Messages are work orders, not prose. Permission prompts belong to the real permission gates: nobody in the band, main included, can approve on the user\'s behalf.'
	);
}

/** One name, one place: the factory names the tool and the permission wrapper recognizes it. */
const BAND_TOOL_NAME = "BandMessage";

export function createBandMessageTool(
	send: (to: BandTarget, message: string, opts?: { wake?: boolean }) => DeliveryOutcome,
	canAddressMain: boolean,
): AnyTool {
	const targets = canAddressMain
		? (["john", "paul", "george", "ringo", "main", "all"] as const)
		: (["john", "paul", "george", "ringo", "all"] as const);
	return buildTool({
		name: BAND_TOOL_NAME,
		description: bandToolDescription(canAddressMain),
		// Sending wakes a session and hands it text; whatever that session then
		// does is evaluated in its own session under the same axes, so the bus
		// itself touches nothing. This declaration and the name's seat in
		// `PLAN_MODE_READ_ONLY_TOOLS` (agent package) are held together by
		// plan-mode-allowlist.test.ts.
		isReadOnly: () => true,
		inputSchema: z.object({
			to: z.enum(targets).describe("Who receives it"),
			message: z.string().describe("The message — a work order carrying the handoff five when it assigns work"),
			wake: z
				.boolean()
				.optional()
				.describe(
					"true (default) wakes an idle recipient now; false delivers without waking — an idle recipient reads it with its next wake-up",
				),
		}),
		call: async (input) => {
			const outcome = send(input.to as BandTarget, input.message, { wake: input.wake });
			return { content: [textContent(formatReceipt(outcome))], isError: !outcome.ok };
		},
	});
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface DeliveryReceipt {
	/** The raw target this receipt is about: a member name, "main", or "all". */
	to: string;
	status: "woken" | "queued" | "revived" | "held" | "refused";
	reason?: string;
}

export interface DeliveryOutcome {
	/** True when at least one recipient took the message. */
	ok: boolean;
	receipts: DeliveryReceipt[];
}

function receiptLabel(to: string): string {
	return to === "main" ? "main" : to === "all" ? "all" : (DISPLAY_NAME[to as BeetleMember] ?? to);
}

export function formatReceipt(outcome: DeliveryOutcome): string {
	return outcome.receipts
		.map((receipt) => {
			const to = receiptLabel(receipt.to);
			if (receipt.status === "woken") return `Delivered to ${to} — woken; it is running your message now.`;
			if (receipt.status === "queued") {
				return `Delivered to ${to} — queued; it will read the message at its next turn boundary.`;
			}
			if (receipt.status === "revived") {
				return `Delivered to ${to} — it was stopped; brought back for this message, and running now.`;
			}
			if (receipt.status === "held") {
				return `Delivered to ${to} — held; it will read the message at its next wake-up.`;
			}
			return `Refused (${to}): ${receipt.reason ?? "not delivered"}`;
		})
		.join("\n");
}

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

export type BeetleMemberState = "idle" | "live" | "stopped";

export interface BeetleMemberStatus {
	name: BeetleMember;
	role: string;
	/** The configured ref: `provider/id` or `"session"`. */
	modelRef: string;
	/** The model actually in use, `provider/id`. */
	model: string;
	/** Set while a configured ref could not be resolved — retried each delivery. */
	pendingRef: string | undefined;
	state: BeetleMemberState;
	turns: number;
	costUSD: number;
	/** True when the catalog has no price for the model in use. */
	unpriced: boolean;
	lastActivity: string | null;
	messages: number;
}

interface MemberRuntime {
	name: BeetleMember;
	session: AgentSession;
	wiring: CompactionWiring;
	modelRef: string;
	pendingRef: string | undefined;
	state: BeetleMemberState;
	turns: number;
	lastActivity: string | null;
}

/**
 * The non-writing seats' tool names. Paul draws from the whole table.
 *
 * Names not on this list — or on `TASK_BOARD_TOOL_NAMES`, which `#memberTools`
 * keeps for every seat, the writing one included — are dropped for John,
 * George and Ringo. MCP tools cannot be classified by name and pass through
 * separately (`mcpTools`), with the persona as the backstop there.
 */
export const READ_SEAT_TOOL_NAMES = ["Bash", "Glob", "Grep", "Read"] as const;

export interface BeetleBandOptions {
	models: BeetleModels;
	cwd: string;
	/** The same session stream the main conversation uses. */
	streamFn: StreamFn;
	/** The worker tool table (the one subagents draw from). */
	allTools: AnyTool[];
	/** Tools outside the worker table that pass through to every seat (MCP). */
	mcpTools?: AnyTool[];
	/** The session model, read at the call. */
	model: () => Model;
	/** Resolve a configured ref, or undefined while it cannot be resolved yet. */
	resolveModel?: (ref: string) => Model | undefined;
	/** Credential check for a resolved model; false means fall back with a report. */
	canRunModel?: (model: Model) => boolean;
	thinkingLevel?: () => ThinkingLevel | undefined;
	trimOldToolResults?: boolean;
	maxTurns?: number;
	/** One-line transcript notices: relays and lifecycle events. */
	onNotice?: (text: string) => void;
	/** Lines into the main transcript: fallbacks, compaction, stops. */
	report?: (text: string) => void;
	/** The main session to wake, read at the call — `/resume` swaps it. */
	getMain?: () => AgentSession | null;
	/** The permission axes, re-read before every delivery. */
	permissionMode?: () => PermissionMode | undefined;
	sandbox?: () => SandboxMode | undefined;
	network?: () => NetworkAxis | undefined;
	getPermissionRules?: () => PermissionRule[];
}

export class BeetleBand {
	#options: BeetleBandOptions;
	#members = new Map<BeetleMember, MemberRuntime>();
	#mainTool: AnyTool;
	#active = true;
	/** Wake-less deliveries, held per target in send order until a wake drains them. */
	#held = new Map<BeetleMember | "main", string[]>();

	constructor(options: BeetleBandOptions) {
		this.#options = options;
		for (const name of BEETLE_MEMBERS) {
			this.#members.set(name, this.#spawn(name));
		}
		this.#mainTool = createBandMessageTool(
			(to, message, opts) => this.deliver({ kind: "main" }, to, message, opts),
			false,
		);
	}

	get active(): boolean {
		return this.#active;
	}

	/**
	 * The BandMessage tool for the main session.
	 *
	 * One stable object, so removing it from the session's tool list later is
	 * `!==` against this rather than a name search.
	 */
	get mainTool(): AnyTool {
		return this.#mainTool;
	}

	memberSession(name: BeetleMember): AgentSession | undefined {
		return this.#members.get(name)?.session;
	}

	/** Wake all four with the task briefing; John additionally gets the lead's instructions. */
	start(task: string): void {
		for (const name of BEETLE_MEMBERS) {
			this.deliver({ kind: "user" }, name, bandBriefing(name, task));
		}
	}

	/**
	 * Route one message. Sync: delivery is a queue push, and a member's run is
	 * observed through its session's events, not through this call.
	 *
	 * `opts.wake === false` delivers without waking: a busy recipient queues as
	 * usual, an idle or stopped one has the message held for its next wake-up
	 * (see {@link #hold}).
	 */
	deliver(from: BandSender, to: BandTarget, text: string, opts?: { wake?: boolean }): DeliveryOutcome {
		if (!this.#active) {
			return {
				ok: false,
				receipts: [{ to, status: "refused", reason: "the band is not active — start one with /beetle <task>" }],
			};
		}
		// A refusal is still an attempt the band watched happen: the receipt
		// travels back to the sender through the tool result, and the line below
		// reaches the user like it does for every other attempt — a model stuck
		// addressing itself shows up in the transcript instead of vanishing.
		const receipts: DeliveryReceipt[] =
			from.kind === "member" && to === from.name
				? [
						{
							to,
							status: "refused",
							reason: "that is yourself — a band message is a handoff; address someone else",
						},
					]
				: this.#recipientsFor(from, to).map((target) => this.#deliverOne(from, target, text, opts));
		const outcome: DeliveryOutcome = { ok: receipts.some((receipt) => receipt.status !== "refused"), receipts };
		try {
			this.#options.onNotice?.(bandLine(from, to, text));
		} catch {
			// A UI subscriber's bug must not cost the delivery.
		}
		return outcome;
	}

	/**
	 * Disband: abort every member and refuse everything after.
	 *
	 * Members are marked stopped *before* the abort so the aborted run's
	 * `agent_end` — which arrives after this returns — cannot flip them back to
	 * idle. Queued follow-ups are dropped by `abort` itself.
	 */
	off(): BeetleMemberStatus[] {
		if (this.#active) {
			this.#active = false;
			for (const member of this.#members.values()) {
				member.state = "stopped";
				try {
					member.session.abort();
				} catch {
					// One member's broken teardown must not strand the other three:
					// the band is stopping either way, and the tally still comes back.
				}
			}
			// Held messages die with the band — a mailbox that outlived it would
			// be a delivery promise nothing can keep. The user hears the count.
			const dropped = [...this.#held.values()].reduce((count, list) => count + list.length, 0);
			this.#held.clear();
			if (dropped > 0) {
				this.#options.report?.(
					`[beetle] ${dropped} undelivered band message${dropped === 1 ? "" : "s"} dropped at disband.`,
				);
			}
		}
		return this.status();
	}

	/** What the four are doing, priced from their own transcripts. */
	status(): BeetleMemberStatus[] {
		return BEETLE_MEMBERS.map((name) => {
			const member = this.#members.get(name);
			if (!member) throw new Error(`beetle member missing at construction: ${name}`);
			const cost = costStateFromMessages(member.session.messages);
			const model = member.session.model;
			return {
				name,
				role: BEETLE_ROLES[name],
				modelRef: member.modelRef,
				model: `${model.provider}/${model.id}`,
				pendingRef: member.pendingRef,
				state: member.state,
				turns: member.turns,
				costUSD: cost.totalCostUSD,
				unpriced: model.pricing === undefined,
				lastActivity: member.lastActivity,
				messages: member.session.messages.length,
			};
		});
	}

	#recipientsFor(from: BandSender, to: BandTarget): Array<BeetleMember | "main"> {
		if (to !== "all") return [to];
		// Everyone but the sender, and main hears it too when a member broadcasts.
		const rest: Array<BeetleMember | "main"> = BEETLE_MEMBERS.filter(
			(name) => !(from.kind === "member" && from.name === name),
		);
		if (from.kind === "member") rest.push("main");
		return rest;
	}

	#deliverOne(
		from: BandSender,
		target: BeetleMember | "main",
		text: string,
		opts?: { wake?: boolean },
	): DeliveryReceipt {
		const wake = opts?.wake ?? true;
		if (target === "main") {
			const main = this.#options.getMain?.() ?? null;
			if (!main) return { to: "main", status: "refused", reason: "no main session is connected" };
			if (!wake && !main.isRunning) {
				this.#hold(target, from, text);
				return { to: "main", status: "held" };
			}
			const wasRunning = main.isRunning;
			main.followUp(this.#release(target, bandEnvelope(from, text)));
			return { to: "main", status: wasRunning ? "queued" : "woken" };
		}
		const member = this.#members.get(target);
		if (!member) return { to: target, status: "refused", reason: `unknown member "${target}"` };
		if (member.state === "stopped") {
			if (!wake) {
				// The wake-less form asks for nothing and spends nothing: it
				// waits in the mailbox — even against a member that only the
				// user may revive, whose revival then carries the backlog.
				this.#hold(target, from, text);
				return { to: target, status: "held" };
			}
			// A stopped member that keeps receiving messages would burn a failed
			// request per message with nothing to show for it. Only the user gets
			// to overrule that — and the revival is explicit in the receipt.
			if (from.kind !== "user") {
				return {
					to: target,
					status: "refused",
					reason: `${DISPLAY_NAME[target]} is stopped after a failed run — only the user can revive it (/beetle say ${target} <task>)`,
				};
			}
			member.state = "idle";
			this.#tryLateResolve(member);
			this.#applyAxes(member);
			member.session.followUp(this.#release(target, bandEnvelope(from, text)));
			return { to: target, status: "revived" };
		}
		if (!wake && !member.session.isRunning) {
			this.#hold(target, from, text);
			return { to: target, status: "held" };
		}
		this.#tryLateResolve(member);
		this.#applyAxes(member);
		const wasRunning = member.session.isRunning;
		member.session.followUp(this.#release(target, bandEnvelope(from, text)));
		return { to: target, status: wasRunning ? "queued" : "woken" };
	}

	/** Hold one wake-less delivery, envelope and all, in send order. */
	#hold(target: BeetleMember | "main", from: BandSender, text: string): void {
		const list = this.#held.get(target) ?? [];
		list.push(bandEnvelope(from, text));
		this.#held.set(target, list);
	}

	/**
	 * The envelope a waking delivery actually delivers: the target's held
	 * messages, oldest first, in front of the message that is doing the waking
	 * — one follow-up, so the receiver reads the backlog as one batch, each
	 * message still carrying its own sender's envelope.
	 */
	#release(target: BeetleMember | "main", envelope: string): string {
		const held = this.#held.get(target);
		if (!held || held.length === 0) return envelope;
		this.#held.delete(target);
		return [...held, envelope].join("\n\n");
	}

	/**
	 * A configured ref that did not resolve at spawn gets re-resolved before
	 * every delivery: model discovery can land a row mid-session, and a member
	 * pinned to the session model forever because its model was a minute late
	 * would be a silent downgrade. The compaction manager moves with the model —
	 * its thresholds come from the window.
	 */
	#tryLateResolve(member: MemberRuntime): void {
		if (!member.pendingRef) return;
		const ref = member.pendingRef;
		const resolved = this.#options.resolveModel?.(ref);
		if (!resolved || !(this.#options.canRunModel?.(resolved) ?? true)) return;
		member.session.setModel(resolved);
		member.wiring.rebuild(resolved, undefined);
		member.pendingRef = undefined;
		this.#options.report?.(`[beetle] ${DISPLAY_NAME[member.name]}: model "${ref}" is now available — switched to it.`);
	}

	/**
	 * The axes are read again before every delivery, not remembered from the
	 * spawn: a member woken an hour later must run under the mode, sandbox and
	 * network the user has now — a relay that reached all three while only the
	 * members kept an old confinement would be the one place the user's choice
	 * did not arrive.
	 */
	#applyAxes(member: MemberRuntime): void {
		const mode = this.#options.permissionMode?.();
		const sandbox = this.#options.sandbox?.();
		if (mode !== undefined || sandbox !== undefined) {
			member.session.setMode(mode ?? member.session.permissionMode, sandbox);
		}
		const network = this.#options.network?.();
		if (network !== undefined) member.session.setNetwork(network);
	}

	#spawn(name: BeetleMember): MemberRuntime {
		const options = this.#options;
		const ref = options.models[name];
		const configured = ref !== SESSION_MODEL_REF ? this.#resolveRef(ref) : undefined;
		const initialModel = configured?.model ?? options.model();
		if (ref !== SESSION_MODEL_REF && !configured?.model) {
			options.report?.(
				`[beetle] ${DISPLAY_NAME[name]}: model "${ref}" is not available — running on the session model for now; it will switch over the moment it is.`,
			);
		}
		const wiring = createCompactionWiring({
			model: initialModel,
			store: undefined,
			streamFn: options.streamFn,
			trimOldToolResults: options.trimOldToolResults,
			report: (text) => options.report?.(`[beetle] ${DISPLAY_NAME[name]}: ${text}`),
		});
		const session = new AgentSession({
			model: initialModel,
			systemPrompt: memberSystemPrompt(name),
			tools: this.#memberTools(name),
			cwd: options.cwd,
			maxTurns: options.maxTurns,
			deps: {
				streamFn: options.streamFn,
				thinkingLevel: options.thinkingLevel,
				checkCompaction: wiring.checkCompaction,
				// Members inherit the session's rules but have no dialog of their own
				// to resolve an "ask" — fail closed rather than hang or auto-allow.
				canUseTool: async (toolName, input, ctx) => {
					const decision = evaluatePermissions(toolName, input, {
						mode: ctx.mode,
						sandbox: ctx.sandbox,
						rules: options.getPermissionRules?.() ?? [],
						cwd: options.cwd,
					});
					if (decision.behavior !== "ask") return decision;
					// The bus and the board are the calls that must survive an "ask":
					// neither touches a file — the board lives in the main session's
					// in-memory store — and every action a woken member takes is
					// evaluated in that member's own session under the same axes.
					// Without this exemption the band would go mute in `ask` mode —
					// the default mode — leaving a user who never widened the session
					// with no band and no way to be told why. Deny rules and plan mode
					// decide above this (plan mode's list admits the two read-only
					// board tools and denies the two that mutate), so a user's own
					// verdict on the bus and the board is still theirs.
					if (toolName === BAND_TOOL_NAME || (TASK_BOARD_TOOL_NAMES as readonly string[]).includes(toolName)) {
						return { behavior: "allow" };
					}
					return {
						behavior: "deny",
						message: decision.message ?? `Permission required for ${toolName} (a band member has no dialog to ask in)`,
					};
				},
			},
		});
		const member: MemberRuntime = {
			name,
			session,
			wiring,
			modelRef: ref,
			pendingRef: configured?.pendingRef,
			state: "idle",
			turns: 0,
			lastActivity: null,
		};
		session.on((event) => this.#onMemberEvent(member, event));
		return member;
	}

	#resolveRef(ref: string): { model?: Model; pendingRef?: string } {
		const resolved = this.#options.resolveModel?.(ref);
		if (resolved && (this.#options.canRunModel?.(resolved) ?? true)) return { model: resolved };
		return { pendingRef: ref };
	}

	#memberTools(name: BeetleMember): AnyTool[] {
		const all = this.#options.allTools;
		const kept =
			name === "paul"
				? [...all, ...(this.#options.mcpTools ?? [])]
				: [
						...all.filter(
							(tool) =>
								(READ_SEAT_TOOL_NAMES as readonly string[]).includes(tool.name) ||
								(TASK_BOARD_TOOL_NAMES as readonly string[]).includes(tool.name),
						),
						...(this.#options.mcpTools ?? []),
					];
		const bandTool = createBandMessageTool(
			(to, message, opts) => this.deliver({ kind: "member", name }, to, message, opts),
			true,
		);
		return [...kept, bandTool];
	}

	#onMemberEvent(member: MemberRuntime, event: AgentEvent): void {
		if (event.type === "agent_start") {
			if (member.state !== "stopped") member.state = "live";
		} else if (event.type === "turn_end") {
			// Model turns completed, not runs: a long assignment with a dozen tool
			// rounds is a dozen turns, and a run that died before finishing its
			// first turn is zero — which is the number that says whether anything
			// was actually done.
			member.turns++;
		} else if (event.type === "agent_end") {
			if (event.reason === "error" || event.reason === "max_turns") {
				// No auto-retry and no auto-revival: a member failing into an
				// infinite retry loop at the band's expense is exactly the runaway
				// the manual-stop design exists to avoid. Next delivery refuses
				// loudly, and /beetle say revives explicitly.
				member.state = "stopped";
				const detail = event.errorMessage ? ` (${event.errorMessage})` : "";
				this.#options.report?.(
					`[beetle] ${DISPLAY_NAME[member.name]} stopped after its run ended with ${event.reason}${detail}. The rest of the band keeps going; only the user can bring it back — /beetle say ${member.name} <task>.`,
				);
			} else if (member.state !== "stopped") {
				member.state = "idle";
			}
		} else if (event.type === "tool_execution_end") {
			member.lastActivity = `${event.toolName}: ${event.result.isError ? "error" : "ok"}`;
		}
	}
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export type BeetleCommand =
	| { kind: "start"; task: string }
	| { kind: "off" }
	| { kind: "status" }
	| { kind: "models" }
	| { kind: "say"; target: BeetleMember | "all"; text: string }
	| { kind: "usage" };

export function beetleUsage(): string {
	return "Usage: /beetle <task> · /beetle status · /beetle off · /beetle models · /beetle say <john|paul|george|ringo|all> <text>";
}

/**
 * What the argument after `/beetle` means.
 *
 * `off`, `status` and `models` match the whole argument only: "off the rails"
 * is a task, not a disband. `start` is the escape hatch for a task that begins
 * with a reserved word. Anything else is the task.
 */
export function parseBeetleCommand(arg: string): BeetleCommand {
	const trimmed = arg.trim();
	if (trimmed === "") return { kind: "usage" };
	if (trimmed === "off") return { kind: "off" };
	if (trimmed === "status") return { kind: "status" };
	if (trimmed === "models") return { kind: "models" };
	if (trimmed === "start") return { kind: "usage" };
	if (trimmed.startsWith("start ")) {
		const task = trimmed.slice("start ".length).trim();
		return task ? { kind: "start", task } : { kind: "usage" };
	}
	if (trimmed === "say") return { kind: "usage" };
	if (trimmed.startsWith("say ")) {
		const rest = trimmed.slice("say ".length).trim();
		const split = rest.indexOf(" ");
		if (split === -1) return { kind: "usage" };
		const target = rest.slice(0, split).toLowerCase();
		const text = rest.slice(split + 1).trim();
		if (!text) return { kind: "usage" };
		if (target === "all" || (BEETLE_MEMBERS as readonly string[]).includes(target)) {
			return { kind: "say", target: target as BeetleMember | "all", text };
		}
		return { kind: "usage" };
	}
	return { kind: "start", task: trimmed };
}

/** `@john fix the thing` — a direct line to one member, when a band is active. */
export function routeMention(text: string): { member: BeetleMember; text: string } | null {
	const match = /^@(\w+)\s+([\s\S]*)$/.exec(text.trim());
	if (!match) return null;
	const name = (match[1] ?? "").toLowerCase();
	if (!(BEETLE_MEMBERS as readonly string[]).includes(name)) return null;
	const body = (match[2] ?? "").trim();
	if (!body) return null;
	return { member: name as BeetleMember, text: body };
}

// ---------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------

export interface BeetlePickOption {
	label: string;
	description: string;
}

export interface PickBeetleModelsOptions {
	/** The list picker; returns the chosen index, or null when cancelled. */
	pick: (title: string, items: BeetlePickOption[], initialIndex: number) => Promise<number | null>;
	/** The session model as `provider/id` — the fallback row's description. */
	sessionModel: string;
	/** Current config to mark and open on, when reconfiguring. */
	current?: Partial<BeetleModels>;
	/** The offered rows; injected for tests, `offeredModels()` in the app. */
	models?: Model[];
}

/**
 * Walk the four members, one picker each, and return the config — or null if
 * the user cancelled anywhere (nothing is saved and nothing spawns).
 *
 * A pure orchestration with the picker injected: the flow is a sequence of
 * decisions, and a test can make all of them without a terminal. Rows are the
 * `/model` shape — the session-model row first, then the same `provider/id`
 * list with the same context and missing-key annotations. The active row is
 * marked and opened on, so reconfiguring shows what is configured now.
 */
export async function pickBeetleModels(options: PickBeetleModelsOptions): Promise<BeetleModels | null> {
	const models = options.models ?? offeredModels();
	const result = {} as BeetleModels;
	for (let i = 0; i < BEETLE_MEMBERS.length; i++) {
		const member = BEETLE_MEMBERS[i];
		if (!member) return null;
		const currentRef = options.current?.[member];
		const currentIndex =
			currentRef && currentRef !== SESSION_MODEL_REF
				? models.findIndex((model) => `${model.provider}/${model.id}` === currentRef)
				: -1;
		const active = currentIndex >= 0 ? currentIndex + 1 : 0;
		const items: BeetlePickOption[] = [
			{
				label: `${active === 0 ? "* " : "  "}Follow the session model`,
				description: options.sessionModel,
			},
			...models.map((model, row) => ({
				label: `${active === row + 1 ? "* " : "  "}${model.provider}/${model.id}`,
				description: `${Math.round(model.contextWindow / 1000)}k context${resolveApiKey(model) ? "" : " — no API key"}`,
			})),
		];
		const title = `Beetle · ${DISPLAY_NAME[member]} (${BEETLE_ROLES[member]}) — model ${i + 1}/4`;
		const index = await options.pick(title, items, active);
		if (index === null || index < 0 || index >= items.length) return null;
		if (index === 0) {
			result[member] = SESSION_MODEL_REF;
			continue;
		}
		const chosen = models[index - 1];
		if (!chosen) return null;
		result[member] = `${chosen.provider}/${chosen.id}`;
	}
	return result;
}
