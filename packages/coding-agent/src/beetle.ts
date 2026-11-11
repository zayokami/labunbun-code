/**
 * /beetle — a band of four members that work a task together.
 *
 * Two shapes share this file, chosen by `beetle.context`.
 *
 * The default with a board connected (`"task"`) is the blackboard: a member
 * hands work over by writing a task, a deterministic dispatcher claims the
 * lowest-id ready task per idle seat and wakes its owner with a rendered card,
 * and a worker's session is created at the claim and destroyed when the task
 * completes — its memory is the board. `BandMessage` survives as a one-per-task
 * clarification channel from a worker to John; John answers by editing the
 * board. The human's `/beetle say` and `@john` are the intervention channels.
 * `docs/dev/blackboard.md` is the long form.
 *
 * Without a board (`"session"`, also the fallback when `"task"` is asked for
 * with no store) the original message-driven relay runs: a delivery to a member
 * is both a message and a wake-up. An idle member starts on it immediately; a
 * busy one reads it at its turn boundary (the session's follow-up queue, whose
 * contract is "restart the loop after natural termination" — steering would
 * dangle, see `session.ts`). A delivery can also be marked wake-less: it then
 * waits in a per-target mailbox and rides in front of the next waking delivery
 * to that target, so a stopped member can be given work to read on revival
 * instead of being woken into a failing request per message. Nobody polls: with
 * every member idle the band costs nothing, and only `/beetle off` disbands it.
 *
 * The four seats exist so the roles are structurally forced rather than asked
 * for politely. John has no Edit/Write: his only way to change anything is to
 * write work for Paul, the single writer. George has no Edit/Write either: a
 * verifier who can patch tends to patch instead of reporting. Ringo has none:
 * a runner that fixes the thing under test hides the evidence. This is
 * structural guidance, not a sandbox — every seat keeps Bash, and Bash can
 * write — and the personas say so honestly.
 *
 * The shared task board (TaskCreate/TaskGet/TaskList/TaskUpdate) is not built
 * here — it arrives in the worker table backed by the main session's store —
 * and the name filter below keeps it in every seat's table, so all four work
 * off one board.
 */
import {
	type AgentEvent,
	AgentSession,
	type AnyTool,
	buildTool,
	collectReadOnlyToolNames,
	evaluatePermissions,
	type NetworkAxis,
	type PermissionMode,
	type PermissionRule,
	type SandboxMode,
	type SpillWriter,
} from "@labunbun/agent";
import { type Model, type StreamFn, type ThinkingLevel, textContent } from "@labunbun/ai";
import { type AgentTask, TASK_BOARD_TOOL_NAMES, type TaskStore } from "@labunbun/tools";
import { z } from "zod";
import { BlackboardDispatcher, type BoardReport } from "./blackboard.ts";
import { type CompactionTuning, type CompactionWiring, createCompactionWiring } from "./compaction-wiring.ts";
import { costStateFromMessages } from "./cost-tracker.ts";
import { NO_SIGN_INS, type SubscriptionSignIns, unrunnableSuffix } from "./credential-presence.ts";
import { offeredModels } from "./model-offer.ts";
import { TaskPheromoneRecorder } from "./task-pheromone.ts";
import { writeToolOutput } from "./tool-output.ts";

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

export type { BoardReport };

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
 * The reply hint on the board path. Worker clarifications are answered by a
 * board write, not by a message back: a natural-language reply would hand the
 * woken member a reply to read and answer, and the exchange would grow a turn
 * every round. John edits the task; the dispatcher wakes its owner.
 */
export const TASK_REPLY_HINT =
	"Answer on the task board: edit the task (TaskUpdate) or add one (TaskCreate) — the board wakes the worker. " +
	"BandMessage is a one-per-task clarification channel from a worker to John, not a conversation; end your turn otherwise.";

/**
 * The text a member (or the main session) receives for a band message.
 *
 * The first line is load-bearing: without it, a user-role message from a peer
 * reads exactly like the user speaking — as a new instruction, or worse, as
 * consent to keep going. "From the user" is the only variant that means the
 * user; everything else is automated band traffic.
 */
export function bandEnvelope(sender: BandSender, text: string, replyHint = BAND_REPLY_HINT): string {
	const from = senderLabel(sender);
	const provenance =
		sender.kind === "user"
			? "[beetle band message — from the user, not a peer relay]"
			: `[beetle band message — relayed from ${from}, automated; not from the user]`;
	return `${provenance}\nFrom: ${from}\n\n${text}\n\n${replyHint}`;
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

const PROTOCOL_HEAD = `Band protocol:
1. Handoff five: task / files involved / constraints / why now / what done looks like. A receiver may bounce back a message that omits them.
2. "I'm done" is not "verified": a completion report cites who verified what, with which command and result.
3. Non-trivial plans get one adversarial pass from George before Paul starts — one round, not a loop.
4. Evidence discipline: file:line or command + exit code; verify against the live workspace, never from memory.
5. Band messages are work orders, not prose — short and specific.
6. Verify once: an unchanged, settled conclusion is not re-verified; a change reopens it.
7. Standby, not polling: with nothing to do, end your turn. Messages wake you.
8. Never relay approvals: permission prompts belong to the real permission system; no member — main included — can grant one for the user.`;

/** The long-lived relay: the board records the work, a message is what starts it. */
const SHARED_PROTOCOL = `${PROTOCOL_HEAD}
9. The board is the record, messages are the wake-up: put assignments on the shared task board (TaskCreate/TaskUpdate, owner set to whoever takes the piece) and follow with a BandMessage to that owner. Keep at most one of your own tasks in_progress at a time.`;

/** The blackboard: the dispatcher reads the board and wakes the owner itself. */
const SHARED_PROTOCOL_TASK = `${PROTOCOL_HEAD}
9. The board is the record and the only handoff: put work on the shared task board (TaskCreate, owner set). The dispatcher wakes the owner — do not message a peer to start work. Keep at most one of your own tasks in_progress at a time.`;

const MESSAGE_MECHANICS = `How messages reach you: as a user-role message whose first line starts with [beetle band message — …] and names its sender. Peer traffic and messages from main are automated, never the user speaking; only the "from the user" envelope is the user. Reply with the BandMessage tool. Your final text reaches nobody but your own transcript — a report that matters must be sent.`;

const TASK_MECHANICS = `How your work arrives: as a task card rendered from the shared board, not as a message from a peer. The board is the record: record progress with TaskUpdate, and create derived work with TaskCreate (owner set). The dispatcher wakes the owner; never message a peer to hand work over. One BandMessage to John per task is the only message channel, for a clarification only — John answers by editing the task, and the edited card wakes you again. Your final text reaches nobody but your own transcript.`;

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

/**
 * The seat's system prompt in the band shape it will run. The blackboard swaps
 * two things: the handoff rule (the dispatcher wakes owners; a message starts
 * nothing) and John's account of how he changes anything (a task for Paul, not
 * a message to him). The rest of the persona is the same person either way.
 */
export function memberSystemPrompt(member: BeetleMember, context: BeetleContext = "session"): string {
	const task = context === "task";
	const identity =
		task && member === "john"
			? IDENTITY_JOHN.replace(
					"your way to change anything is a BandMessage to Paul.",
					"your way to change anything is a task on the board for Paul — he is the only writer.",
				)
			: IDENTITIES[member];
	return [
		identity,
		SHARED_ROSTER,
		task ? SHARED_PROTOCOL_TASK : SHARED_PROTOCOL,
		task ? TASK_MECHANICS : MESSAGE_MECHANICS,
	].join("\n\n");
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

/**
 * The lead's standing instruction, prepended to every card he is woken with.
 * The split is a board write: the dispatcher wakes owners, so a message from
 * John would be a second, unaccounted-for way to start work.
 */
export const LEAD_WAKE =
	"You hold the lead. Put the split on the shared task board: TaskCreate one task per piece with owner " +
	"(paul | george | ringo), kind, acceptance and files. The board wakes its owner — do not message workers. " +
	"Mark your own task completed when every piece is done.";

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
export function bandToolDescription(canAddressMain: boolean, allowed?: readonly BandTarget[]): string {
	if (allowed) {
		return (
			`Send at most ONE clarification, to ${allowed.join(" | ")} only, during the task you are running. ` +
			"Ask what the task card cannot answer: a genuine ambiguity or a decision only the lead can make. " +
			"A second call in the same task is refused. Do not use it to report progress or to acknowledge — " +
			"put work on the task board (TaskCreate/TaskUpdate) and the board wakes its owner. " +
			"John answers by changing the task, not by replying; his answer reaches you as the next task card."
		);
	}
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
	allowed?: readonly BandTarget[],
): AnyTool {
	const targets =
		allowed ??
		(canAddressMain
			? (["john", "paul", "george", "ringo", "main", "all"] as const)
			: (["john", "paul", "george", "ringo", "all"] as const));
	const enumValues = [...targets] as [BandTarget, ...BandTarget[]];
	return buildTool({
		name: BAND_TOOL_NAME,
		description: bandToolDescription(canAddressMain, allowed),
		// Sending wakes a session and hands it text; whatever that session then
		// does is evaluated in its own session under the same axes, so the bus
		// itself touches nothing. This declaration and the name's seat in
		// `PLAN_MODE_READ_ONLY_TOOLS` (agent package) are held together by
		// plan-mode-allowlist.test.ts.
		isReadOnly: () => true,
		inputSchema: z.object({
			to: z.enum(enumValues).describe("Who receives it"),
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

/**
 * The worker's TaskCreate: a derived task — `fix`, `verify` or `research` —
 * that names its parent, at most {@link MAX_DERIVED_TASKS} per parent per
 * worker.
 *
 * The stock tool is replaced rather than filtered at call time because the
 * schema is what tells the model the shape: a worker offered the full form
 * writes an `implement` task for Paul, which is the relay this band replaces.
 * The call-time refusal is the backstop for a model that ignores the schema.
 */
export function createWorkerTaskCreateTool(store: TaskStore, seat: BeetleMember): AnyTool {
	const owners = [...BEETLE_MEMBERS] as [BeetleMember, ...BeetleMember[]];
	return buildTool({
		name: "TaskCreate",
		description:
			`Create a derived task on the shared board: kind ${WORKER_TASK_KINDS.join(" | ")}, parent required. ` +
			`At most ${MAX_DERIVED_TASKS} derived tasks per parent, per worker. Use it for a repair or a check ` +
			"your seat cannot do itself; routing new work stays with John.",
		inputSchema: z.object({
			subject: z.string().describe("Brief imperative title, e.g. 'Fix the parser edge case'"),
			description: z.string().describe("What needs to be done, with enough context to act on"),
			activeForm: z.string().optional().describe("Present-continuous form shown while running"),
			owner: z.enum(owners).optional().describe("Who is on the hook; defaults to you"),
			blockedBy: z.array(z.string()).optional().describe("Task ids that must complete before this one"),
			kind: z.enum(WORKER_TASK_KINDS).describe("What the task is for"),
			acceptance: z.string().optional().describe("What done looks like, in terms a verifier can check"),
			files: z.array(z.string()).optional().describe("Files or areas this task touches"),
			commands: z.array(z.string()).optional().describe("On a verify task, the commands whose exit codes decide"),
			parent: z.string().describe("The task this one derives from"),
		}),
		isConcurrencySafe: () => false,
		call: async (input) => {
			if (!store.get(input.parent)) {
				return {
					content: [textContent(`Task #${input.parent} not found — a derived task must name its parent`)],
					isError: true,
				};
			}
			const derived = store.list().filter((task) => task.createdBy === seat && task.parent === input.parent);
			if (derived.length >= MAX_DERIVED_TASKS) {
				return {
					content: [
						textContent(
							`Refused: ${seat} already derived ${derived.length} tasks from #${input.parent} — the limit is ${MAX_DERIVED_TASKS}. Put the rest in your report to John.`,
						),
					],
					isError: true,
				};
			}
			const task = store.create(
				input.subject,
				input.description,
				input.activeForm,
				input.owner ?? seat,
				input.blockedBy,
				{
					kind: input.kind,
					acceptance: input.acceptance,
					files: input.files,
					commands: input.commands,
					parent: input.parent,
					createdBy: seat,
				},
			);
			return { content: [textContent(`Created task #${task.id}: ${task.subject}`)] };
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

/**
 * The book-keeping snapshot the app layer persists: the status table, plus
 * what the table itself does not know — the task, and whether the band is
 * still on stage. `at` is when the snapshot was taken.
 */
export interface BeetleStateSnapshot {
	task: string;
	active: boolean;
	at: string;
	members: BeetleMemberStatus[];
}

/**
 * The per-member tally lines. Shared so `/beetle off` and the budget ceiling's
 * report read as the same table rather than two spellings of it.
 */
export function memberTallyLines(members: BeetleMemberStatus[]): string[] {
	return members.map(
		(entry) =>
			`  ${entry.name} (${entry.role}): ${entry.turns} turns, $${entry.costUSD.toFixed(4)}${entry.unpriced ? " (unpriced)" : ""}`,
	);
}

/**
 * How long a worker's conversation lives.
 *
 * `"task"` is the blackboard default: the session is created when the task is
 * claimed and destroyed when it reaches a terminal state, so nothing a worker
 * said in one task reaches the next — its memory is the board. `"session"` is
 * the old long-lived conversation, kept as the explicit fallback (and for a
 * band constructed without a board, where there is nothing to dispatch over).
 */
export type BeetleContext = "task" | "session";

interface MemberRuntime {
	name: BeetleMember;
	/** Undefined between a destroyed task session and the next claim. */
	session: AgentSession | undefined;
	wiring: CompactionWiring | undefined;
	modelRef: string;
	pendingRef: string | undefined;
	/** The model a new session starts on, kept when no session is alive. */
	model: Model;
	state: BeetleMemberState;
	turns: number;
	/** Spend from sessions this member has already finished, in USD. */
	settledCostUSD: number;
	lastActivity: string | null;
	/** When this member's last event landed, for the quiet watchdog. */
	lastEventAt: number;
	/** One quiet notice per episode; that member's next event clears it. */
	stallNotified: boolean;
	/** The task whose card this member's current session was started with. */
	currentTaskId: string | undefined;
	/** A terminal task landed while the run was still going; destroy at its end. */
	pendingDispose: boolean;
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

/**
 * The task kinds a worker may derive on the board: a repair, a check, or
 * research. Planning, splitting and routing stay with John — a worker that could
 * write an `implement` task for a peer would be the message relay again, with
 * the dispatcher as its postman.
 */
export const WORKER_TASK_KINDS = ["fix", "verify", "research"] as const;

/** Derived tasks a worker may register for one parent task. */
export const MAX_DERIVED_TASKS = 3;

/** A live member silent this long gets one notice (the settings key reads in minutes). */
const DEFAULT_STALL_NOTICE_MS = 300_000;

/** How often the quiet watchdog sweeps. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;

/** "45s" under a minute, "6m" above it — the units a reader thinks in. */
function formatQuiet(ms: number): string {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

export interface BeetleBandOptions {
	models: BeetleModels;
	cwd: string;
	/**
	 * The shared task board the dispatcher routes over. Without one, the band
	 * falls back to `"session"` context: there is nothing to claim a task from.
	 */
	taskStore?: TaskStore;
	/** Defaults to `"task"` when a board is connected, `"session"` otherwise. */
	context?: BeetleContext;
	/** Bound on a rendered task card; `beetle.taskCardChars` in the app. */
	taskCardChars?: number;
	/** Bound on the failing run's cut inside a card; `beetle.errorSummaryChars`. */
	errorSummaryChars?: number;
	/** Repair rounds per task before the dispatcher escalates it; `beetle.maxFixRounds`. */
	maxFixRounds?: number;
	/** Repair failed build/verify runs; `beetle.autoFix: false` leaves them for John. */
	autoFix?: boolean;
	/** The same session stream the main conversation uses. */
	streamFn: StreamFn;
	/** The worker tool table (the one subagents draw from). */
	allTools: AnyTool[];
	/**
	 * Tools outside the worker table that pass through to every seat (MCP).
	 * Read when the band is constructed — the `/beetle` command — rather than
	 * captured when these options were put together at REPL startup: a seat's
	 * table has to be the connections of that moment, the way a subagent's is.
	 */
	mcpTools?: () => AnyTool[];
	/** The session model, read at the call. */
	model: () => Model;
	/** Resolve a configured ref, or undefined while it cannot be resolved yet. */
	resolveModel?: (ref: string) => Model | undefined;
	/** Credential check for a resolved model; false means fall back with a report. */
	canRunModel?: (model: Model) => boolean;
	thinkingLevel?: () => ThinkingLevel | undefined;
	trimOldToolResults?: boolean;
	/** `settings.compaction`, passed through whole — see `TaskToolContext`. */
	compactionTuning?: CompactionTuning;
	maxTurns?: number;
	/**
	 * Stop the whole band once its four transcripts price past this many USD.
	 * The check rides on `turn_end` — cost appears when a turn's message lands —
	 * and only priced turns count: a member on an unpriced model contributes
	 * zero, which its tally line marks "(unpriced)". Undefined is unbounded.
	 */
	maxCostUSD?: number;
	/**
	 * How long a live member may go without an event before one notice fires.
	 * Undefined reads as five minutes; zero or negative turns the watch off.
	 * Notice-only by design: a quiet member is reported, never stopped.
	 */
	stallNoticeMs?: number;
	/** Watchdog sweep cadence in ms. Undefined reads as 30 seconds. */
	watchdogIntervalMs?: number;
	/** One-line transcript notices: relays and lifecycle events. */
	onNotice?: (text: string) => void;
	/** Lines into the main transcript: fallbacks, compaction, stops. */
	report?: (text: string) => void;
	/**
	 * The band just went inactive, through `off()`. The app layer drops the
	 * main session's BandMessage here so every disband path — the user's stop,
	 * the budget ceiling — leaves no dead tool behind.
	 */
	onDisband?: () => void;
	/**
	 * Book-keeping snapshots: on start, after every turn (the moment a turn's
	 * spend is committed), and once more at disband. The app layer persists
	 * them — a subscriber's bug is caught and costs the band nothing.
	 */
	onState?: (snapshot: BeetleStateSnapshot) => void;
	/** The main session to wake, read at the call — `/resume` swaps it. */
	getMain?: () => AgentSession | null;
	/** The permission axes, re-read before every delivery. */
	permissionMode?: () => PermissionMode | undefined;
	sandbox?: () => SandboxMode | undefined;
	network?: () => NetworkAxis | undefined;
	/**
	 * The root session's YOLO flag, read at each evaluation. A member inherits
	 * the posture its band belongs to and has no command to change it; a copied
	 * boolean would keep approving after the root had left.
	 */
	yolo?: () => boolean | undefined;
	getPermissionRules?: () => PermissionRule[];
}

export class BeetleBand {
	#options: BeetleBandOptions;
	#members = new Map<BeetleMember, MemberRuntime>();
	#mainTool: AnyTool;
	#active = true;
	/** The task `start` was given; rides on every snapshot. */
	#task = "";
	/** Wake-less deliveries, held per target in send order until a wake drains them. */
	#held = new Map<BeetleMember | "main", string[]>();
	/** The quiet watchdog's interval, dropped with the band in `off()`. */
	#watchdog: ReturnType<typeof setInterval> | undefined;
	readonly #context: BeetleContext;
	#dispatcher: BlackboardDispatcher | undefined;
	/** Reads Bash results into the board; only a task-routed band has one. */
	#pheromone: TaskPheromoneRecorder | undefined;
	/** One clarification per worker per claimed task. */
	#bandBudget = new Map<BeetleMember, { used: boolean }>();

	constructor(options: BeetleBandOptions) {
		this.#options = options;
		// A board is the precondition for task routing: with none connected there is
		// nothing to claim tasks from, so even an explicit "task" runs the
		// long-lived band rather than a hybrid with no dispatcher.
		this.#context = options.taskStore ? (options.context ?? "task") : "session";
		for (const name of BEETLE_MEMBERS) {
			this.#members.set(name, this.#runtime(name));
		}
		// A board can outlive its band. An `in_progress` task owned by a member
		// then has no session behind it — sessions are created at the claim — so
		// it goes back to pending, with one more attempt, before anyone is woken.
		if (this.#context === "task" && options.taskStore) this.#recoverBoard(options.taskStore);
		if (this.#context === "task") {
			// John keeps the lead's conversation for the band's lifetime; the
			// workers start when the board hands them a task.
			this.#ensureSession(this.#members.get("john") as MemberRuntime);
		} else {
			for (const member of this.#members.values()) this.#ensureSession(member);
		}
		this.#mainTool = createBandMessageTool(
			(to, message, opts) => this.deliver({ kind: "main" }, to, message, opts),
			false,
		);
		this.#watchdog = this.#startWatchdog();
		if (this.#context === "task" && options.taskStore) {
			this.#dispatcher = new BlackboardDispatcher({
				store: options.taskStore,
				seats: BEETLE_MEMBERS,
				isBusy: (seat) => this.#members.get(seat as BeetleMember)?.session?.isRunning ?? false,
				wake: (seat, card, task) => this.#wakeForTask(seat as BeetleMember, card, task),
				release: (seat, task) => this.#releaseSeat(seat as BeetleMember, task),
				notice: (line) => this.#options.onNotice?.(line),
				charBudget: options.taskCardChars,
				errorChars: options.errorSummaryChars,
				maxAttempts: options.maxFixRounds,
				autoFix: options.autoFix,
			});
			// The environment speaks through the seat's own tool events. The
			// recorder writes a declared command's result to the task — a store
			// write, not a model turn — and closes a clean build/verify.
			this.#pheromone = new TaskPheromoneRecorder({
				store: options.taskStore,
				errorChars: options.errorSummaryChars,
				notice: (line) => this.#options.onNotice?.(line),
			});
		}
	}

	get active(): boolean {
		return this.#active;
	}

	/** `"task"` routes over the board; `"session"` keeps the old long-lived band. */
	get context(): BeetleContext {
		return this.#context;
	}

	/** The dispatcher's counters for `/beetle status`; undefined on the session band. */
	boardReport(): BoardReport | undefined {
		return this.#dispatcher?.report();
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

	/**
	 * Open the work.
	 *
	 * On the board path the band's task becomes one task owned by John: the
	 * dispatcher claims it and wakes him with its card. The workers are not
	 * woken — they start when John's TaskCreate hands one of them a piece. The
	 * long-lived path keeps the old behavior and wakes all four.
	 */
	start(task: string): void {
		this.#task = task;
		if (this.#context === "task" && this.#options.taskStore) {
			const subject = (task.split(/\r?\n/, 1)[0] ?? "").trim() || "band task";
			this.#options.taskStore.create(subject, task, undefined, "john", [], { kind: "plan", createdBy: "user" });
			this.#dispatcher?.kick();
		} else {
			for (const name of BEETLE_MEMBERS) {
				this.deliver({ kind: "user" }, name, bandBriefing(name, task));
			}
		}
		this.#emitState();
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
		const policy = this.#policyRefusal(from, to);
		const receipts: DeliveryReceipt[] = policy
			? [{ to, status: "refused", reason: policy }]
			: from.kind === "member" && to === from.name
				? [
						{
							to,
							status: "refused",
							reason: "that is yourself — a band message is a handoff; address someone else",
						},
					]
				: this.#recipientsFor(from, to).map((target) => this.#deliverOne(from, target, text, opts));
		const outcome: DeliveryOutcome = { ok: receipts.some((receipt) => receipt.status !== "refused"), receipts };
		// The clarification is spent only when it actually reached John: a refused
		// or undeliverable call leaves the worker its one question.
		if (outcome.ok && this.#context === "task" && from.kind === "member" && to === "john") {
			const budget = this.#bandBudget.get(from.name);
			if (budget) budget.used = true;
		}
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
			if (this.#watchdog !== undefined) {
				clearInterval(this.#watchdog);
				this.#watchdog = undefined;
			}
			this.#dispatcher?.dispose();
			this.#dispatcher = undefined;
			for (const member of this.#members.values()) {
				member.state = "stopped";
				try {
					member.session?.abort();
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
			// Farewell after the teardown, so the app layer's listener sees a
			// band that is already stopped. Its bug must not cost the disband —
			// same rule as the relay notices.
			try {
				this.#options.onDisband?.();
			} catch {
				// Ignored on purpose: stopping is not negotiable.
			}
			// The final snapshot — after every member reads stopped — is what
			// the app layer records as the disband.
			this.#emitState();
		}
		return this.status();
	}

	/**
	 * What the four are doing, priced from their own transcripts. A worker
	 * between tasks has no transcript; its spend and turns still count, because
	 * a destroyed session is not a refund.
	 */
	status(): BeetleMemberStatus[] {
		return BEETLE_MEMBERS.map((name) => {
			const member = this.#members.get(name);
			if (!member) throw new Error(`beetle member missing at construction: ${name}`);
			const liveCost = member.session ? costStateFromMessages(member.session.messages).totalCostUSD : 0;
			const model = member.session?.model ?? member.model;
			return {
				name,
				role: BEETLE_ROLES[name],
				modelRef: member.modelRef,
				model: `${model.provider}/${model.id}`,
				pendingRef: member.pendingRef,
				state: member.state,
				turns: member.turns,
				costUSD: member.settledCostUSD + liveCost,
				unpriced: model.pricing === undefined,
				lastActivity: member.lastActivity,
				messages: member.session?.messages.length ?? 0,
			};
		});
	}

	/**
	 * One snapshot to the app layer. Subscriber bugs are caught — the same
	 * rule as the relay notices: book-keeping must not cost the band.
	 */
	#emitState(): void {
		try {
			this.#options.onState?.({
				task: this.#task,
				active: this.#active,
				at: new Date().toISOString(),
				members: this.status(),
			});
		} catch {
			// Ignored on purpose: the ledger records the band; it does not leash it.
		}
	}

	/**
	 * The board path's star topology, enforced where the message would leave.
	 *
	 * Workers address John only, once per task. John has no send tool and no
	 * exception here: his answer to a clarification is a board write, and the
	 * dispatcher wakes the worker with the edited task. A human's `/beetle say`
	 * and `@john` are different senders and are not caught by this.
	 */
	#policyRefusal(from: BandSender, to: BandTarget): string | undefined {
		if (this.#context !== "task" || from.kind !== "member") return undefined;
		if (from.name === "john") {
			return "John answers on the board — edit the task with TaskUpdate and the dispatcher wakes its owner; he does not message the band.";
		}
		if (to !== "john") {
			return "workers address John only — put the work on the task board instead of messaging a peer.";
		}
		if (this.#bandBudget.get(from.name)?.used) {
			return "one clarification per task — put the rest on the board (TaskCreate/TaskUpdate) or end your turn.";
		}
		return undefined;
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
		// On the board path the message that reaches a worker is a card or a
		// human's line, not a peer relay; either way its answer belongs on the
		// board, so the hint says so.
		const hint = this.#context === "task" ? TASK_REPLY_HINT : BAND_REPLY_HINT;
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
			const revived = this.#ensureSession(member);
			this.#tryLateResolve(member);
			this.#applyAxes(member);
			revived.followUp(this.#release(target, bandEnvelope(from, text, hint)));
			return { to: target, status: "revived" };
		}
		if (!wake && !(member.session?.isRunning ?? false)) {
			this.#hold(target, from, text);
			return { to: target, status: "held" };
		}
		const session = this.#ensureSession(member);
		this.#tryLateResolve(member);
		this.#applyAxes(member);
		const wasRunning = session.isRunning;
		session.followUp(this.#release(target, bandEnvelope(from, text, hint)));
		return { to: target, status: wasRunning ? "queued" : "woken" };
	}

	/** Hold one wake-less delivery, envelope and all, in send order. */
	#hold(target: BeetleMember | "main", from: BandSender, text: string): void {
		const list = this.#held.get(target) ?? [];
		list.push(bandEnvelope(from, text, this.#context === "task" ? TASK_REPLY_HINT : BAND_REPLY_HINT));
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
		member.model = resolved;
		member.session?.setModel(resolved);
		member.wiring?.rebuild(resolved, undefined);
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
		const session = member.session;
		if (!session) return;
		const mode = this.#options.permissionMode?.();
		const sandbox = this.#options.sandbox?.();
		if (mode !== undefined || sandbox !== undefined) {
			session.setMode(mode ?? session.permissionMode, sandbox);
		}
		const network = this.#options.network?.();
		if (network !== undefined) session.setNetwork(network);
	}

	/** A member's book-keeping, resolved once; the session itself comes later. */
	#runtime(name: BeetleMember): MemberRuntime {
		const options = this.#options;
		const ref = options.models[name];
		const configured = ref !== SESSION_MODEL_REF ? this.#resolveRef(ref) : undefined;
		if (ref !== SESSION_MODEL_REF && !configured?.model) {
			options.report?.(
				`[beetle] ${DISPLAY_NAME[name]}: model "${ref}" is not available — running on the session model for now; it will switch over the moment it is.`,
			);
		}
		return {
			name,
			session: undefined,
			wiring: undefined,
			modelRef: ref,
			pendingRef: configured?.pendingRef,
			model: configured?.model ?? options.model(),
			state: "idle",
			turns: 0,
			settledCostUSD: 0,
			lastActivity: null,
			lastEventAt: Date.now(),
			stallNotified: false,
			currentTaskId: undefined,
			pendingDispose: false,
		};
	}

	/**
	 * Return a previous band's in-flight tasks to the board's pool.
	 *
	 * A task-scoped worker session exists only while its task is in progress, so
	 * an `in_progress` task at band start has no session behind it: the band that
	 * claimed it is gone. Leaving it in progress would strand the work — no seat
	 * is running it, and the claim rule refuses to hand it to anyone else. It
	 * goes back to pending with one more attempt, and the dispatcher claims it
	 * fresh like any other ready task.
	 */
	#recoverBoard(store: TaskStore): void {
		for (const task of store.list()) {
			if (task.status !== "in_progress") continue;
			if (!task.owner || !(BEETLE_MEMBERS as readonly string[]).includes(task.owner)) continue;
			store.update(task.id, { status: "pending", attempts: (task.attempts ?? 0) + 1 });
			this.#options.onNotice?.(
				`[blackboard] #${task.id} ${task.subject} was in progress when its band stopped — returned to pending.`,
			);
		}
	}

	/**
	 * The member's session, created on first use. On the board path this is the
	 * task boundary: a worker has none between tasks, and gets a fresh one —
	 * system prompt, tools, empty transcript — when the dispatcher hands it a
	 * card.
	 */
	#ensureSession(member: MemberRuntime): AgentSession {
		if (member.session) return member.session;
		const options = this.#options;
		const name = member.name;
		// A member has no store, so a draft it trims has no session file to fall
		// back on. The spill root is the band's cwd — the same tree the inherited
		// worker tools were built for, and the one Read allows. No member session
		// id exists, so the files land under `unassigned` beside subagents'.
		const spillOutput: SpillWriter = (request) => writeToolOutput(request, { cwd: options.cwd, sessionId: undefined });
		const wiring = createCompactionWiring({
			model: member.model,
			store: undefined,
			streamFn: options.streamFn,
			trimOldToolResults: options.trimOldToolResults,
			tuning: options.compactionTuning,
			spillOutput,
			report: (text) => options.report?.(`[beetle] ${DISPLAY_NAME[name]}: ${text}`),
		});
		const memberTools = this.#memberTools(name);
		// The member's plan gate reads the same declarations the session's does,
		// taken from the table this seat actually has (which includes `BandMessage`,
		// a tool that declares itself read-only and must stay admitted in plan mode).
		const readOnlyToolNames = collectReadOnlyToolNames(memberTools);
		const session = new AgentSession({
			model: member.model,
			systemPrompt: memberSystemPrompt(name, this.#context),
			tools: memberTools,
			cwd: options.cwd,
			maxTurns: options.maxTurns,
			deps: {
				streamFn: options.streamFn,
				thinkingLevel: options.thinkingLevel,
				// The pipeline's cuts spill under the same root, so a truncated
				// result in a member's context stays recoverable.
				spillOutput,
				checkCompaction: wiring.checkCompaction,
				// Members inherit the session's rules but have no dialog of their own
				// to resolve an "ask" — fail closed rather than hang or auto-allow.
				canUseTool: async (toolName, input, ctx) => {
					const decision = evaluatePermissions(toolName, input, {
						mode: ctx.mode,
						sandbox: ctx.sandbox,
						rules: options.getPermissionRules?.() ?? [],
						cwd: options.cwd,
						readOnlyToolNames,
						yolo: options.yolo?.() ?? false,
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
		member.session = session;
		member.wiring = wiring;
		member.lastEventAt = Date.now();
		member.stallNotified = false;
		session.on((event) => this.#onMemberEvent(member, session, event));
		return session;
	}

	/**
	 * Destroy a task-scoped session. Its spend and turns stay on the member's
	 * tally — a destroyed session is not a refund — and the transcript goes with
	 * it, which is the point: the next task starts from its card, not from what
	 * the last one said.
	 */
	#disposeMember(member: MemberRuntime): void {
		const session = member.session;
		member.session = undefined;
		member.wiring = undefined;
		member.pendingDispose = false;
		member.currentTaskId = undefined;
		if (!session) return;
		member.settledCostUSD += costStateFromMessages(session.messages).totalCostUSD;
		try {
			session.abort();
		} catch {
			// Nothing to salvage: the transcript is already off the member.
		}
		if (member.state !== "stopped") member.state = "idle";
	}

	/** Hand a claimed task to its owner: one card, one wake. */
	#wakeForTask(name: BeetleMember, card: string, task: AgentTask): void {
		const member = this.#members.get(name);
		if (!member) return;
		if (member.state === "stopped") {
			// A stopped member refuses requests; waking it would burn a failed
			// request. The claim stays open and the user can revive it explicitly.
			this.#options.report?.(
				`[beetle] ${DISPLAY_NAME[name]} is stopped — task #${task.id} was not delivered. /beetle say ${name} <task> revives it.`,
			);
			return;
		}
		const resumedTask = member.currentTaskId === task.id && member.session !== undefined;
		const session = this.#ensureSession(member);
		// The clarification budget belongs to the task execution, not to one run of
		// it: John answering by editing the task wakes the worker again, and that
		// second run may not spend a second question. A destroyed session (or a
		// different task) starts a fresh execution and a fresh budget.
		if (!resumedTask) this.#bandBudget.set(name, { used: false });
		member.currentTaskId = task.id;
		member.pendingDispose = false;
		this.#tryLateResolve(member);
		this.#applyAxes(member);
		// The lead's card carries the one instruction his persona cannot infer
		// from a task: the split goes on the board, not into messages.
		const text = name === "john" ? `${LEAD_WAKE}\n\n${card}` : card;
		session.followUp(text);
	}

	/**
	 * A claimed task reached a terminal state. A running worker finishes its
	 * current run first — cutting it off mid-tool would leave the transcript and
	 * the board disagreeing about what happened — then the session goes.
	 */
	#releaseSeat(name: BeetleMember, _task: AgentTask): void {
		const member = this.#members.get(name);
		if (!member) return;
		if (!member.session) return;
		if (member.session.isRunning) {
			member.pendingDispose = true;
			return;
		}
		this.#disposeMember(member);
	}

	#resolveRef(ref: string): { model?: Model; pendingRef?: string } {
		const resolved = this.#options.resolveModel?.(ref);
		if (resolved && (this.#options.canRunModel?.(resolved) ?? true)) return { model: resolved };
		return { pendingRef: ref };
	}

	#memberTools(name: BeetleMember): AnyTool[] {
		const all = this.#options.allTools;
		// Read here — the call is the band's own construction — rather than
		// captured by whoever built the options: those are built once at REPL
		// startup, and `/beetle` constructs the band much later, so a tool the
		// connections gained in between has to be in the seats' table.
		const mcp = this.#options.mcpTools?.() ?? [];
		const kept =
			name === "paul"
				? [...all, ...mcp]
				: [
						...all.filter(
							(tool) =>
								(READ_SEAT_TOOL_NAMES as readonly string[]).includes(tool.name) ||
								(TASK_BOARD_TOOL_NAMES as readonly string[]).includes(tool.name),
						),
						...mcp,
					];
		if (this.#context === "task") {
			// John's answer is a board write, so he carries no send tool at all;
			// a worker's copy can address John and no one else. The delivery path
			// enforces the rest (one per task, no peer traffic) rather than relying
			// on the enum: a schema is guidance, a refusal is a fact.
			if (name === "john") return kept;
			// George and Ringo may register derived work, not route it: their
			// TaskCreate admits only fix/verify/research under a named parent.
			// Paul and John keep the full board tool.
			const table =
				name === "george" || name === "ringo"
					? [
							...kept.filter((tool) => tool.name !== "TaskCreate"),
							createWorkerTaskCreateTool(this.#options.taskStore as TaskStore, name),
						]
					: kept;
			return [
				...table,
				createBandMessageTool((to, message, opts) => this.deliver({ kind: "member", name }, to, message, opts), false, [
					"john",
				]),
			];
		}
		const bandTool = createBandMessageTool(
			(to, message, opts) => this.deliver({ kind: "member", name }, to, message, opts),
			true,
		);
		return [...kept, bandTool];
	}

	#onMemberEvent(member: MemberRuntime, session: AgentSession, event: AgentEvent): void {
		// A session that has already been destroyed can still emit the tail of an
		// aborted run; it is no longer this member's, and must not revive a state
		// the next task already owns.
		if (member.session !== session) return;
		// Every event is a heartbeat: the quiet watchdog reads from here, and an
		// arriving event re-arms the member for a fresh notice if it goes quiet
		// again later — one notice per episode, not one per stall.
		member.lastEventAt = Date.now();
		member.stallNotified = false;
		if (event.type === "agent_start") {
			if (member.state !== "stopped") member.state = "live";
		} else if (event.type === "turn_end") {
			// Model turns completed, not runs: a long assignment with a dozen tool
			// rounds is a dozen turns, and a run that died before finishing its
			// first turn is zero — which is the number that says whether anything
			// was actually done.
			member.turns++;
			this.#checkBudget();
			// After the budget check: a ceiling that just disbanded emitted its
			// own final snapshot, and an "active" one must not overwrite it.
			if (this.#active) this.#emitState();
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
			// The task boundary. A terminal task destroys the session now that the
			// run that touched it has ended; a run that ended with its task still
			// open keeps its session — the board may change under it, and the
			// dispatcher will wake it with the edited card.
			if (this.#active) {
				if (member.pendingDispose || this.#taskTerminal(member)) this.#disposeMember(member);
				this.#emitState();
				this.#dispatcher?.kick();
			}
		} else if (event.type === "tool_execution_start") {
			member.lastActivity = `${event.toolName}: running`;
			this.#pheromone?.begin(event.callId, event.toolName, event.input);
		} else if (event.type === "tool_execution_end") {
			member.lastActivity = `${event.toolName}: ${event.result.isError ? "error" : "ok"}`;
			this.#pheromone?.record(member.name, member.currentTaskId, event.toolName, event.callId, event.result);
		}
	}

	/** True when the member's current task has been recorded completed. */
	#taskTerminal(member: MemberRuntime): boolean {
		if (!member.currentTaskId) return false;
		return this.#options.taskStore?.get(member.currentTaskId)?.status === "completed";
	}

	/**
	 * Arm the quiet watchdog. `stallNoticeMs` of zero or less — the settings
	 * key's "off" — gets no timer at all; `unref()` keeps the handle from
	 * holding the process open, the way the shell poll's does.
	 */
	#startWatchdog(): ReturnType<typeof setInterval> | undefined {
		const threshold = this.#options.stallNoticeMs ?? DEFAULT_STALL_NOTICE_MS;
		if (threshold <= 0) return undefined;
		const every = this.#options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
		const timer = setInterval(() => this.#sweepQuiet(), every);
		timer.unref();
		return timer;
	}

	/**
	 * One watchdog pass: a live member that has gone event-quiet past the
	 * threshold gets one notice naming what it was last doing.
	 *
	 * Only live members count. An idle member's silence is the design — it has
	 * nothing to do until the next delivery — and a stopped one is silent on
	 * purpose. The notice says out loud that nothing was stopped: the watchdog
	 * observes, it never acts.
	 */
	#sweepQuiet(): void {
		if (!this.#active) return;
		const threshold = this.#options.stallNoticeMs ?? DEFAULT_STALL_NOTICE_MS;
		const now = Date.now();
		for (const member of this.#members.values()) {
			if (member.state !== "live" || member.stallNotified) continue;
			const quiet = now - member.lastEventAt;
			if (quiet < threshold) continue;
			member.stallNotified = true;
			try {
				this.#options.onNotice?.(
					`[beetle] ${DISPLAY_NAME[member.name]} has been quiet for ${formatQuiet(quiet)} (last: ${member.lastActivity ?? "no tool activity"}) — nothing was stopped; /beetle status shows the band.`,
				);
			} catch {
				// A UI subscriber's bug must not cost the sweep — same rule as the relays.
			}
		}
	}

	/**
	 * Stop the band once its spend crosses `maxCostUSD`.
	 *
	 * Runs on every `turn_end` — the moment a turn's message, and so its cost,
	 * is committed — and only when the option is set: no ceiling means the band
	 * runs until it is stopped by hand, exactly as before. The report carries
	 * the final tally and says how to start the next band; deliveries after it
	 * refuse like any disbanded band's.
	 */
	#checkBudget(): void {
		const ceiling = this.#options.maxCostUSD;
		if (ceiling === undefined || !this.#active) return;
		const total = this.status().reduce((sum, entry) => sum + entry.costUSD, 0);
		if (total <= ceiling) return;
		const members = this.off();
		this.#options.report?.(
			`[beetle] budget ceiling crossed — $${total.toFixed(4)} spent, $${ceiling.toFixed(4)} allowed. Final tally:\n${memberTallyLines(members).join("\n")}\nThe band is off; /beetle <task> starts a new one.`,
		);
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
	/**
	 * The machine's subscription sign-ins, read when asked — the rows carry the
	 * same availability the request path enforces, and the one input it cannot
	 * read itself is a keychain. Absent means "none": the answer a machine that
	 * never signed in gives, which keeps every caller that predates
	 * subscriptions exactly as informative as it was.
	 */
	signIns?: () => Promise<SubscriptionSignIns>;
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
	const signIns = options.signIns ? await options.signIns() : NO_SIGN_INS;
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
			...models.map((model, row) => {
				const suffix = unrunnableSuffix(model, signIns);
				// The display name leads and the id rides the description, the same
				// shape /model uses: "claude-sonnet-5" tells a human less than
				// "Claude Sonnet 5", but the id is what gets stored, so both show.
				return {
					label: `${active === row + 1 ? "* " : "  "}${model.name}`,
					description: `${model.provider}/${model.id} · ${Math.round(model.contextWindow / 1000)}k context${suffix ? ` — ${suffix}` : ""}`,
				};
			}),
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
