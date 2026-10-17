/**
 * UI state model: AgentSession events reduce into a flat transcript of
 * renderable entries plus transient streaming/status slices.
 */
import {
	type ActivityRange,
	type AgentEvent,
	COMPACTION_BOUNDARY_LEAD,
	isCompactionBoundary,
	LENGTH_RECOVERY_MESSAGE,
} from "@labunbun/agent";
import type { AgentMessage, ImageContent, TextContent } from "@labunbun/ai";
import type { ListPickerState } from "./components/ListPickerDialog.tsx";
import type { PermissionOption } from "./permission-options.ts";
import { DEFAULT_THEME } from "./themes/index.ts";
import type { Theme } from "./themes/tokens.ts";

export type UiEntry =
	/** `steered` marks a message sent into a running turn rather than as a new one. */
	| { kind: "user"; text: string; steered?: boolean }
	| { kind: "assistant"; text: string }
	| {
			kind: "toolUse";
			callId: string;
			toolName: string;
			inputPreview: string;
			resultText?: string;
			isError?: boolean;
	  }
	| { kind: "error"; text: string }
	| { kind: "info"; text: string };

export interface PendingTool {
	callId: string;
	toolName: string;
}

export type StatusPhase = "idle" | "thinking" | "responding" | "tools";

export interface UiTask {
	id: string;
	subject: string;
	status: "pending" | "in_progress" | "completed";
	activeForm?: string;
	owner?: string;
}

/**
 * A message typed while a turn was running. `queue` waits for the turn to end;
 * `steer` goes in at the next tool boundary, before the model is called again.
 * Both are promises about a run, so both die with it — see the reducer.
 */
export interface QueuedMessage {
	/** Stable key for the preview list; the text alone can repeat. */
	id: string;
	text: string;
	mode: "queue" | "steer";
}

/**
 * A background shell, as far as the UI is concerned: what it is and whether it
 * is still going. The manager's own record carries a temp output path and a
 * child process — neither belongs in a rendering layer.
 */
export interface UiBackgroundShell {
	id: string;
	command: string;
	status: "running" | "completed" | "killed";
	/**
	 * The end of the shell's output so far, newest last, already trimmed to the
	 * window a reader wants (`liveOutputLines`). Pushed with the same poll that
	 * carries the row, because the manager keeps its output on disk and reading
	 * it is the app layer's job — the panel that draws this takes no file of its
	 * own and no clock.
	 *
	 * Part of the value, not beside it: the store only changes when the publisher
	 * says this list is *different*, and a tail that is not compared would be a
	 * dev server that visibly never prints again. See `sameShells`.
	 */
	tail: string[];
}

/**
 * What `/status` shows, as data rather than as an info line.
 *
 * A card is read as a whole — model, directory, permission mode, session id,
 * how full the context is — and the transcript is the wrong place for it: a
 * dozen info lines scroll away exactly when the answer is needed again. The
 * values are already formatted by the caller, which is the layer that knows what
 * the numbers mean.
 */
export interface StatusCardData {
	/**
	 * Card heading. `/status` is one of two cards now — `/context` draws its
	 * breakdown the same way — so the subject belongs to the caller.
	 */
	title?: string;
	/** The rows about *where* this session is. Absent on a card that is not about it. */
	model?: string;
	directory?: string;
	permissions?: string;
	session?: string;
	/** Context usage, drawn as a bar; absent until the first turn is measured. */
	context?: { usedTokens: number; threshold: number };
	/** Anything else worth a row, in display order: cost, theme, MCP, … */
	details: Array<[label: string, value: string]>;
}

/**
 * What `/activity` opens.
 *
 * The panel is a view over the session files on disk, so it is told where they
 * are and how wide a window it wants — not given a finished report. `range`
 * starts at a week because a month is the first range that shows a streak, and
 * a year is one nobody waits for.
 */
export interface ActivityView {
	home: string | undefined;
	range: ActivityRange;
}

export interface UiState {
	entries: UiEntry[];
	streamingText: string;
	thinkingText: string;
	pendingTools: PendingTool[];
	/**
	 * Output streamed by a tool that is still running, by callId. Separate from
	 * `pendingTools` because it changes on a different cadence — a command can
	 * print thousands of lines while the list of running tools stays put — and
	 * dropped as soon as the tool's result lands, since the result supersedes it.
	 */
	liveOutputs: Record<string, string>;
	statusPhase: StatusPhase;
	dialog: PermissionDialogState | null;
	question: QuestionDialogState | null;
	/**
	 * The plan review dialog: a plan going up for approve / keep planning /
	 * feedback. Its own surface rather than the permission dialog because the
	 * answer is richer than allow/deny — a rejection can carry the sentence the
	 * planner should act on.
	 */
	planReview: PlanReviewDialogState | null;
	/** Pick-one dialog (resume, model switch). Like `question`, carries a resolve closure. */
	picker: ListPickerState | null;
	contextInfo?: { usedTokens: number; threshold: number };
	/**
	 * What the app is doing to the context while it does it — a summarization in
	 * flight, which can take as long as a whole turn. Shown on the status row in
	 * place of the turn's own phase, and set by the app layer rather than derived
	 * from session events: a compaction is the loop working on its own history
	 * and emits nothing while it runs.
	 */
	contextActivity?: string;
	/**
	 * When the activity above began, in epoch milliseconds, for the seconds the
	 * status row shows beside it — a summary can run for half a minute, and a
	 * word alone cannot tell a slow call from a stuck one. Stamped once, when an
	 * activity first appears, and cleared with it, so the clock spans the whole
	 * compaction rather than restarting at every phase it moves through.
	 */
	contextActivitySince?: number;
	/**
	 * The `/status` card, shown over the prompt until Esc or the next submit.
	 * Not modal: it reports on the run, it does not block it.
	 */
	statusCard: StatusCardData | null;
	/**
	 * The activity heatmap, open over the prompt. It carries the home directory
	 * rather than a report because the panel re-collects whenever `r` changes the
	 * range, and handing it the path is what lets that happen without the app layer
	 * re-walking the session tree for every range it cycles through.
	 */
	activity: ActivityView | null;
	/**
	 * Long-running shells started by the Bash tool. In the store because the app
	 * layer only learns about them by polling the manager, and a dev server that
	 * is still up after the turn ended is exactly what the user needs told.
	 */
	backgroundShells: UiBackgroundShell[];
	/**
	 * The watch panel's subagent stop: the counts line, then one row per
	 * subagent, preformatted by the app layer because the registry and the
	 * ageing vocabulary live there. Lines rather than structured rows for the
	 * same reason the shell tail is lines — the panel draws what it was handed,
	 * and what a row says belongs to the layer that knows the fleet.
	 */
	watchSubagentLines: string[];
	/**
	 * The watch panel's facts stop: model, cost, context and cache, phrased
	 * where the readings are and drawn verbatim. The panel exists partly so
	 * these stop costing a `/status`, and a card and a band that describe the
	 * same session in the same words are the point of that.
	 */
	watchStatusLines: string[];
	/**
	 * Messages typed during a run, waiting to be delivered. Reported above the
	 * prompt because the transcript already holds them: what the user cannot see
	 * without this is that they have not been sent *yet*.
	 */
	queued: QueuedMessage[];
	tasks?: UiTask[];
	/**
	 * Active theme. Lives in the store so `/theme` can take effect immediately:
	 * the provider reads it from here, so a change rerenders the tree.
	 */
	theme: Theme;
	/**
	 * The palette the sealed rows were printed with — the half of the theme
	 * `<Static>` froze into the scrollback. Moves only when the transcript is
	 * actually reprinted under a new palette (`applyTheme`, and Ctrl+L's
	 * repaint); a picker preview recolors the live rows through the provider
	 * and leaves the printed ones alone, so it must not move this. The list
	 * keys its remount on this rather than on `theme` (`transcriptPaintKey`),
	 * which is what keeps arrow presses in the theme picker from wiping the
	 * screen and reprinting the whole transcript per keystroke. Equal to
	 * `theme` at rest.
	 */
	themeCommit: Theme;
	/** Display name of the active model. In the store so /model switching updates the status line live. */
	modelName: string;
	/**
	 * The permission mode, named by `describeModeChoice` — the label, not the id,
	 * because the id of the widest row (`agentNoSandbox`) is not a thing to put
	 * on a prompt.
	 *
	 * In the store rather than read from the session because the session cannot
	 * announce a change: `setMode` is a setter, and there is no event for it, so a
	 * label read straight off the session would go stale the moment `/mode` ran.
	 * That is the same reason `/vim` and `/emacs` are flags here rather than
	 * props, and the same reason `setModeLabel` sits on the app handle — the app
	 * layer is the only place that can tell the store what it just did.
	 */
	modeLabel: string;
	/**
	 * Modal vim editing in the prompt. In the store rather than a prop because
	 * `/vim` turns it on and off while the app is running — and because `/help`
	 * and the key-list overlay have to describe the editor that is actually up.
	 */
	vim: boolean;
	/**
	 * Modeless emacs editing in the prompt, and the second of an exclusive pair
	 * with {@link vim}. Stored beside it rather than as one three-valued field so
	 * that every existing reader of `vim` keeps meaning what it meant; the one
	 * place that has to have a single answer is `resolveEditingMode`, and the
	 * commands are what keep the two from both being on.
	 */
	emacs: boolean;
	/**
	 * Asked-for repaints of the transcript. `<Static>` prints its children once
	 * and only prints them again when the list remounts, so anything that wipes
	 * the terminal underneath a sealed transcript (Ctrl+L) has to ask for one.
	 * Only the identity of the value matters, which is why nothing resets it.
	 */
	paint: number;
}

export interface PermissionDialogState {
	callId: string;
	toolName: string;
	inputPreview: string;
	/**
	 * The same input in full, several lines, for the Ctrl+A view. The one-line
	 * preview is short on purpose; this is what makes the dialog answerable when
	 * a command is long enough that its tail is where the danger is.
	 */
	inputFull?: string;
	/**
	 * The answers to offer, named for what each one grants (permission-options).
	 * Absent when the host had no input to scope a rule to, in which case the
	 * dialog falls back to the widest truthful wording — the bare tool.
	 */
	options?: PermissionOption[];
	/**
	 * Requests still waiting behind this one, including it. Requests arrive
	 * concurrently (a turn runs several tools at once) and are answered in
	 * order, so the dialog says how many answers are queued rather than
	 * appearing to repeat itself.
	 */
	queueLength?: number;
	/**
	 * Who raised the request when that is not this session: an ask forwarded
	 * from a subagent ("subagent \"…\" (sidechain-…)"), so the answer does not
	 * have to guess which worker is waiting on it. Absent for the session's own
	 * calls, which are the only kind this dialog used to show.
	 */
	source?: string;
	/**
	 * The answer, with the two standing extras. `alwaysAllow` records a session
	 * grant for the scope the user was looking at; `alwaysAsk` records a session
	 * ask rule instead — they are opposite answers and never both true
	 * (permission-options). Optional so a caller that predates the fourth answer
	 * still resolves the plain ones.
	 */
	resolve: (allow: boolean, alwaysAllow: boolean, alwaysAsk?: boolean) => void;
}

export interface UiQuestion {
	question: string;
	header: string;
	options: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

export interface QuestionDialogState {
	questions: UiQuestion[];
	/** Resolves with per-question selected labels; null = user cancelled. */
	resolve: (answers: string[] | null) => void;
}

/**
 * What the reviewer said about a plan.
 *
 * `approved: false` with no feedback is "keep planning, no note"; with feedback
 * it is the instruction the planner reads on rejection. `null`, one level up,
 * means the dialog was canceled rather than answered.
 */
export interface PlanReviewResult {
	approved: boolean;
	feedback?: string;
}

export interface PlanReviewDialogState {
	/** The plan text, as the model submitted it. */
	plan: string;
	/** Resolves with the answer; null = canceled (Esc, abort, replacement). */
	resolve: (result: PlanReviewResult | null) => void;
}

/**
 * Tool output kept per entry. Generous on purpose — transcript mode (Ctrl+O)
 * renders up to this much so real command output stays readable — while the
 * live view still truncates for layout.
 */
export const RESULT_TEXT_CAP = 16_000;

export function initialUiState(vim = false, emacs = false, modeLabel = ""): UiState {
	return {
		entries: [],
		streamingText: "",
		thinkingText: "",
		pendingTools: [],
		liveOutputs: {},
		statusPhase: "idle",
		dialog: null,
		question: null,
		planReview: null,
		picker: null,
		statusCard: null,
		activity: null,
		backgroundShells: [],
		watchSubagentLines: [],
		watchStatusLines: [],
		queued: [],
		theme: DEFAULT_THEME,
		themeCommit: DEFAULT_THEME,
		modelName: "",
		modeLabel,
		vim,
		emacs,
		paint: 0,
	};
}

function previewInput(input: unknown): string {
	if (input === null || input === undefined) return "";
	const text = typeof input === "string" ? input : JSON.stringify(input);
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * The text an update contributes to the running tool's window, whatever shape it
 * wrapped it in.
 *
 * `partial` is `unknown` by design — every tool decides what progress looks like
 * — so the only things worth rendering here are text and the reason a call
 * failed: a tool whose update is a percentage or a count has nothing for the
 * output window, and an MCP call that failed reports why on this channel before
 * its result lands. Dropping that report left a server that timed out saying
 * nothing at all on screen.
 */
function streamedText(partial: unknown): string | undefined {
	if (typeof partial === "string") return partial;
	if (typeof partial !== "object" || partial === null) return undefined;
	const record = partial as Record<string, unknown>;
	const value = record.partialOutput;
	if (typeof value === "string") return value;
	const mcpError = record.mcpError;
	return typeof mcpError === "string" && mcpError !== "" ? mcpError : undefined;
}

/**
 * Extract the primary preview for common tools (command, path, pattern,
 * description). The key list is ordered by priority: `description` sits last
 * because a Task row has nothing better to show than its one-line summary,
 * while a Bash call carrying both must keep showing its command — the row used
 * to fall through to the JSON dump for Task, which is a preview of nothing.
 */
export function toolPreview(_toolName: string, input: unknown): string {
	if (typeof input !== "object" || input === null) return previewInput(input);
	const record = input as Record<string, unknown>;
	const key = ["command", "file_path", "pattern", "path", "description"].find((k) => k in record);
	if (key) return String(record[key]);
	return previewInput(input);
}

/**
 * How much of an input the Ctrl+A view shows. Generous — a command long enough
 * to be truncated here is a command nobody can read at a glance anyway — but
 * bounded, because this string is held in React state and rendered every frame.
 */
export const INPUT_FULL_MAX = 4000;

/**
 * The whole tool input for the Ctrl+A view, key by key, instead of the one-line
 * preview that trims it to 120 characters.
 *
 * The preview answers "roughly what is this"; this answers "yes, and what was
 * on the end of it", which is the question that matters when the payload is a
 * long command or a diff.
 */
export function toolFullView(_toolName: string, input: unknown): string {
	const text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
	if (text.length <= INPUT_FULL_MAX) return text;
	return `${text.slice(0, INPUT_FULL_MAX)}\n… (${text.length - INPUT_FULL_MAX} more characters)`;
}

export function reduceEvent(state: UiState, event: AgentEvent): UiState {
	switch (event.type) {
		case "agent_start":
			return { ...state, statusPhase: "thinking" };

		case "turn_start":
			// A turn only starts after the loop has drained both queues into the
			// transcript (steering right before, follow-ups just before that), so
			// anything still listed as waiting has been delivered and is now a
			// user message in the entries above.
			return {
				...state,
				streamingText: "",
				thinkingText: "",
				statusPhase: "thinking",
				queued: state.queued.length > 0 ? [] : state.queued,
			};

		case "message_update": {
			// Incremental append from the delta itself — rejoining the full
			// content array per delta is O(n²) on long responses.
			const ae = event.assistantMessageEvent;
			switch (ae.type) {
				case "thinking_start":
					return { ...state, thinkingText: "" };
				case "thinking_delta":
					return { ...state, thinkingText: state.thinkingText + ae.delta };
				case "text_start":
					return { ...state, statusPhase: "responding", streamingText: "" };
				case "text_delta":
					return {
						...state,
						statusPhase: "responding",
						streamingText: state.streamingText + ae.delta,
					};
				default:
					return state;
			}
		}

		case "turn_end":
			return {
				...state,
				entries: [
					...state.entries,
					...(state.streamingText ? [{ kind: "assistant", text: state.streamingText } as UiEntry] : []),
				],
				streamingText: "",
				thinkingText: "",
				statusPhase: event.toolResults.length > 0 ? "tools" : "idle",
			};

		case "tool_execution_start":
			return {
				...state,
				statusPhase: "tools",
				pendingTools: [...state.pendingTools, { callId: event.callId, toolName: event.toolName }],
				entries: [
					...state.entries,
					{
						kind: "toolUse",
						callId: event.callId,
						toolName: event.toolName,
						inputPreview: toolPreview(event.toolName, event.input),
					},
				],
			};

		case "tool_execution_update": {
			const text = streamedText(event.partial);
			if (text === undefined) return state;
			return { ...state, liveOutputs: { ...state.liveOutputs, [event.callId]: text } };
		}

		case "tool_execution_end": {
			const content = Array.isArray(event.result.content) ? event.result.content : [];
			const resultText = content
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.slice(0, RESULT_TEXT_CAP);
			// The result supersedes the stream: keeping both would hold every
			// command's output in memory for the life of the session.
			const liveOutputs = { ...state.liveOutputs };
			delete liveOutputs[event.callId];
			return {
				...state,
				liveOutputs,
				pendingTools: state.pendingTools.filter((p) => p.callId !== event.callId),
				entries: state.entries.map((entry) =>
					entry.kind === "toolUse" && entry.callId === event.callId
						? { ...entry, resultText, isError: event.result.isError }
						: entry,
				),
			};
		}

		case "agent_end": {
			const entries = [...state.entries];
			if (state.streamingText) {
				entries.push({ kind: "assistant", text: state.streamingText });
			}
			if (event.reason === "error" && event.errorMessage) {
				entries.push({ kind: "error", text: `Error: ${event.errorMessage}` });
			} else if (event.reason === "aborted") {
				// The run these were queued for is gone, and the session dropped
				// them with it. Saying so is the difference between a message that
				// was refused and one that was silently thrown away.
				const dropped = state.queued.length;
				entries.push({
					kind: "info",
					text:
						dropped > 0
							? `[interrupted · ${dropped} queued message${dropped === 1 ? "" : "s"} dropped]`
							: "[interrupted]",
				});
			}
			return {
				...state,
				entries,
				streamingText: "",
				thinkingText: "",
				pendingTools: [],
				liveOutputs: {},
				statusPhase: "idle",
				// A run that ended naturally has already drained them into the
				// transcript; the ones left here ended with it.
				queued: [],
			};
		}

		default:
			return state;
	}
}

/**
 * The transcript a session already has, as renderable rows.
 *
 * `reduceEvent` turns live events into rows, and a resumed session emits none
 * for the conversation it arrives with — the messages are pushed into the
 * session and nothing else happens, so connecting a store to it left the
 * screen blank while the model answered with the full history in mind. This
 * is the missing half: the same rows, built from the messages themselves.
 *
 * Two messages in the array are not the user's. A compaction boundary is a
 * marker line, not something to read back as their words; the loop's own
 * length-recovery message is not shown at all. A tool result attaches to the
 * row of the call it answers — and one whose call is gone, which is what a
 * session file that lost a line leaves behind, is dropped rather than shown
 * as output from nowhere.
 */
export function entriesFromMessages(messages: readonly AgentMessage[]): UiEntry[] {
	const entries: UiEntry[] = [];
	// The rows a later toolResult attaches to, by call id. Each object is
	// pushed into `entries` first and filled in place, so the array that is
	// returned is the array that was finished.
	const toolRows = new Map<string, Extract<UiEntry, { kind: "toolUse" }>>();
	for (const message of messages) {
		if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : textOfBlocks(message.content);
			if (text.trim().length === 0) continue;
			if (isCompactionBoundary(message)) {
				entries.push({ kind: "info", text: COMPACTION_BOUNDARY_LEAD });
				continue;
			}
			if (text.trim().startsWith(LENGTH_RECOVERY_MESSAGE)) continue;
			entries.push({ kind: "user", text });
			continue;
		}
		if (message.role === "assistant") {
			// Text runs and tool calls keep their order inside the message; a run
			// of text is one row, and a message with nothing but tool calls gets
			// no assistant row at all.
			let textRun: string[] = [];
			const flushText = (): void => {
				const text = textRun.join("\n");
				if (text.trim().length > 0) entries.push({ kind: "assistant", text });
				textRun = [];
			};
			for (const block of message.content) {
				if (block.type === "text") {
					textRun.push(block.text);
				} else if (block.type === "toolCall") {
					flushText();
					const row: Extract<UiEntry, { kind: "toolUse" }> = {
						kind: "toolUse",
						callId: block.id,
						toolName: block.name,
						inputPreview: toolPreview(block.name, parseToolArguments(block.arguments)),
					};
					toolRows.set(block.id, row);
					entries.push(row);
				}
			}
			flushText();
			continue;
		}
		const row = toolRows.get(message.toolCallId);
		if (!row) continue;
		row.resultText = textOfBlocks(message.content).slice(0, RESULT_TEXT_CAP);
		row.isError = message.isError;
	}
	return entries;
}

/** A block array's text, in order — the same join the live reducer writes. */
function textOfBlocks(blocks: readonly (TextContent | ImageContent)[]): string {
	return blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Tool arguments are a JSON string on the wire. A shape that does not parse
 * is previewed as the raw string — the row still says what was asked for.
 */
function parseToolArguments(argumentsText: string): unknown {
	try {
		return JSON.parse(argumentsText);
	} catch {
		return argumentsText;
	}
}
