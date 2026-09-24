import type { PadAction, PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type HistorySearchState, historyMatches, searchSelection, searchSelectionIndex } from "../history-search.ts";
import { useTextInput } from "../hooks/useTextInput.ts";
import { type OskCursor, oskKeyAt, oskMove, oskPage, oskTurn, oskType } from "../osk.ts";
import { type PadPromptRef, usePadAction } from "../pad.ts";
import { expandPasteTokens, makePasteToken, normalizePaste, shouldPlaceholderize } from "../paste.ts";
import { applyFileCompletion, currentAtWord, filterFiles } from "../prompt-files.ts";
import { hintLine } from "../shortcuts.ts";
import { useTheme } from "../theme.ts";
import { OnScreenKeyboard } from "./OnScreenKeyboard.tsx";

export interface PromptInputProps {
	onSubmit: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
	/** Slash-command suggestions: [name, description]. */
	commandSuggestions?: Array<[string, string]>;
	/**
	 * Candidate file paths for @-mention completion. Receives the typed query
	 * but MAY return an unfiltered superset — this component always applies its
	 * own ranking and cap.
	 */
	completeFiles?: (query: string) => Promise<string[]>;
	/** Modal vim editing (normal/insert). */
	vim?: boolean;
	/**
	 * Prompts from earlier sessions, oldest first, for ↑ recall. Without this the
	 * buffer starts empty and ↑ only reaches prompts typed in this session.
	 */
	history?: string[];
	/**
	 * Filled in here with a handler the owner calls when it sees Escape (see
	 * REPL). Ink hands every press to every active listener, so the editor cannot
	 * "consume" the key on its own: this is how it gets the first look, and how an
	 * Escape it did not want still reaches the host. Without it the component
	 * handles Escape itself.
	 */
	escapeRef?: RefObject<(() => boolean) | null>;
	/**
	 * `?` on an empty prompt. Declared here rather than in the host's global key
	 * handler because `?` is an ordinary character the buffer would otherwise
	 * claim: ink delivers a press to every listener with no way to consume it,
	 * so whoever owns the buffer has to be the one to decide.
	 */
	onToggleHelp?: () => void;
	/**
	 * A run is in progress, so there is nothing to submit *to*: the keys that
	 * normally send the buffer queue it instead, for the run to pick up.
	 */
	busy?: boolean;
	/**
	 * Whether the running turn can actually take a message mid-flight (tools are
	 * executing, so another model call is coming). Without that, "send it now"
	 * would be a promise the session cannot keep, and the key queues instead.
	 */
	canSteer?: boolean;
	/** `busy` + a non-empty buffer: send after the current turn ends. */
	onQueue?: (text: string) => void;
	/**
	 * `busy` + `canSteer` + a non-empty buffer: send into the running turn, at
	 * the next tool boundary.
	 */
	onSteer?: (text: string) => void;
	/**
	 * Escape on a non-empty buffer during a run: stop the run and send what was
	 * typed. Handled here rather than by the host because the buffer is here —
	 * the same reason `?` and Ctrl+R are.
	 */
	onInterruptSend?: (text: string) => void;
	/** The controller, when there is one. */
	pad?: PadBridge;
	/**
	 * Filled in here with the editor's pad handler, for the same reason
	 * `escapeRef` exists: ink hands an action to every subscriber, so the window
	 * has to ask before it acts. The editor's answer covers the on-screen
	 * keyboard and the two things the prompt does with a pad (✕ sends, and
	 * whatever the editor is showing has the first claim on the movement keys).
	 *
	 * Handing one over hands the controller over with it: an editor with a window
	 * to ask it does not listen on its own, because the bridge would give it the
	 * same press twice.
	 */
	padRef?: PadPromptRef;
	/**
	 * On screen, or behind a full-screen view.
	 *
	 * The window that covers this editor still renders it, because what is in the
	 * buffer — and the undo stack, the folded pastes, the open history search that
	 * go with it — is not reconstructable from anywhere else, and the screen a user
	 * comes back to should be the screen they left. What a covered editor must not
	 * do is *listen*: ink hands a key to every subscriber and a pad action to every
	 * subscriber, so an editor behind the transcript would type into a buffer
	 * nobody can see, paste into it, and answer the window's Escape and pad
	 * questions for a screen it is not part of. `display: none` takes it out of the
	 * layout; this takes it out of the conversation.
	 */
	hidden?: boolean;
}

/**
 * Split the placeholder so the first character can be drawn as a caret. An empty
 * prompt with no caret reads as unfocused — there is nothing on screen saying the
 * REPL is accepting input. Returned as data so the choice is testable: rendered
 * frames carry no ANSI when stdout is not a TTY, which is every test run.
 */
export function placeholderCaret(placeholder: string): { caret: string; rest: string } {
	return { caret: placeholder.slice(0, 1) || " ", rest: placeholder.slice(1) };
}

/**
 * Not a message: a command acts on the app *now* (`/stop`, `/status`, `/help`),
 * so a running turn is no reason to hold it back — `/stop` delivered one turn
 * later is worse than useless. The host owns these prefixes; this only has to
 * keep them out of the queue.
 */
function isHostCommand(text: string): boolean {
	return text.startsWith("/") || text.startsWith("#");
}

/**
 * Multiline prompt: Enter submits, shift+enter / alt+enter inserts a newline.
 * Up/down recall history when the caret is on a single-line buffer. Tab
 * completes the top slash-command suggestion. With `vim`, normal-mode keys
 * are consumed by the modal layer.
 */
export function PromptInput({
	onSubmit,
	disabled = false,
	placeholder = 'Try "fix the failing test" — / for commands',
	commandSuggestions = [],
	completeFiles,
	vim = false,
	history = [],
	escapeRef,
	onToggleHelp,
	busy = false,
	canSteer = false,
	onQueue,
	onSteer,
	onInterruptSend,
	pad,
	padRef,
	hidden = false,
}: PromptInputProps) {
	const theme = useTheme();
	const { columns } = useWindowSize();
	const { state, actions, historyUp, historyDown, pushHistory, getHistory, vimMode, handleVimKey, selection } =
		useTextInput(history, vim);
	const [suggestionIndex, setSuggestionIndex] = useState(0);
	/** Ctrl+R state; null when the search is closed. */
	const [search, setSearch] = useState<HistorySearchState | null>(null);
	const matches = search ? historyMatches(getHistory(), search.query) : [];
	const matched = search ? searchSelection(matches, search.index) : undefined;
	/**
	 * What was typed before the first Tab, or null when nothing has been completed
	 * yet. Filtering on the buffer alone collapses the list to a single entry the
	 * moment Tab writes a full command into it, which makes further cycling
	 * impossible — so the original prefix keeps driving the list.
	 */
	const [completionPrefix, setCompletionPrefix] = useState<string | null>(null);
	// Bracketed-paste payloads fold into placeholder tokens; this map holds the
	// originals until submit. It survives submits so a recalled history entry
	// containing tokens can still be re-expanded.
	const pasteMapRef = useRef(new Map<string, string>());
	const pasteSeqRef = useRef(0);
	/** The on-screen keyboard: closed, or where its cursor stands. */
	const [osk, setOsk] = useState(false);
	const [oskPageIndex, setOskPageIndex] = useState(0);
	const [oskCursor, setOskCursor] = useState<OskCursor>({ row: 0, col: 0 });
	const [oskShift, setOskShift] = useState(false);
	const page = oskPage(oskPageIndex);

	/**
	 * Send what is in the buffer. One implementation for two senders — the Enter
	 * key and the keyboard's ⏎ cell — because the two must not drift: a pad that
	 * queued where a key would have steered (or the reverse) silently reorders
	 * what the user said, and nothing on screen would say so.
	 *
	 * Placeholder tokens expand here, so the model and the transcript see the
	 * real payload. History keeps the compact token form — recall and resubmit
	 * expand through the still-live map. Vim mode treats a token as one
	 * character, so an edit cannot leave a half-token that no longer matches (see
	 * `pasteTokenAt`); outside vim mode a stray keystroke in the host's own
	 * editing can still, and such a token is then submitted literally.
	 */
	const submitCurrent = useCallback(() => {
		const raw = state.text;
		const text = expandPasteTokens(raw, pasteMapRef.current);
		if (!text.trim()) return;
		pushHistory(raw);
		actions.clear();
		setSuggestionIndex(0);
		setCompletionPrefix(null);
		// Mid-run there is nothing to submit to. Enter means "as soon as this turn
		// can take it" — into the turn when it can (tools are running, so another
		// model call is coming), otherwise queued behind it. The two are told apart
		// because a steer is delivered *before* the next model call and a queue
		// after the whole turn: picking the wrong one would silently reorder what
		// the user said.
		if (busy && onQueue && !isHostCommand(text)) {
			if (canSteer && onSteer) onSteer(text);
			else onQueue(text);
			return;
		}
		onSubmit(text);
	}, [state.text, actions, pushHistory, busy, onQueue, canSteer, onSteer, onSubmit]);

	/** Press the key under the keyboard's cursor. */
	const pressOskKey = useCallback(() => {
		const key = oskKeyAt(page, oskCursor);
		if (key.command === "submit") submitCurrent();
		else if (key.command === "shift") setOskShift((shift) => !shift);
		else if (key.command === "backspace") actions.backspace();
		else {
			const character = oskType(key, oskShift);
			if (character !== undefined) actions.insert(character);
		}
	}, [page, oskCursor, oskShift, submitCurrent, actions]);

	/**
	 * The editor's share of the pad.
	 *
	 * With the keyboard open it takes everything it can use and lets the rest
	 * through — the transcript, `/status`, the theme picker are all still worth
	 * having a button for while typing. With it closed it takes two things: the
	 * key that opens the keyboard, and ✕, which sends. ✕ is the one button that
	 * has to mean "send" *outside* the keyboard, because a person holding a
	 * controller who has just watched words appear and wants to send them will
	 * press the button that means yes. Inside the keyboard it presses the
	 * highlighted cell instead, which is why sending there is a cell of its own.
	 */
	const padAction = useCallback(
		(action: PadAction): boolean => {
			if (!osk) {
				if (action.kind === "osk" && action.phase !== "release") {
					setOsk(true);
					setOskCursor({ row: 0, col: 0 });
					return true;
				}
				if (action.kind === "confirm" && action.phase === "press") {
					submitCurrent();
					return true;
				}
				return false;
			}
			// A release says nothing here: every key this keyboard has is a thing
			// that happened when the button went down.
			if (action.phase === "release") return true;
			// The one place that judges by button rather than by kind. □ and △ mean
			// something different *while the keyboard is up* — a backspace and shift
			// — because "clear the screen" and "open the command wheel" are not
			// things anyone does mid-word.
			if (action.button === "square") {
				actions.backspace();
				return true;
			}
			if (action.button === "triangle") {
				setOskShift((shift) => !shift);
				return true;
			}
			switch (action.kind) {
				case "up":
				case "down":
				case "left":
				case "right":
					setOskCursor((cursor) => oskMove(page, cursor, action.kind as "up" | "down" | "left" | "right"));
					return true;
				case "page-next":
					setOskPageIndex((index) => oskTurn(index, 1));
					return true;
				case "page-prev":
					setOskPageIndex((index) => oskTurn(index, -1));
					return true;
				case "confirm":
					pressOskKey();
					return true;
				case "cancel":
				case "osk":
					setOsk(false);
					return true;
				default:
					return false;
			}
		},
		[osk, page, actions, submitCurrent, pressOskKey],
	);

	// The editor listens only when nobody is driving it. A window that holds the
	// handle below asks it before it acts — the hand-off Escape uses — and the
	// bridge hands every action to *every* subscriber, so an editor that both
	// listened and was asked answered each press twice: one ✕ in the on-screen
	// keyboard typed two letters, and one step of the d-pad moved the brackets two
	// cells, which is a whole row of the keyboard gone past. Being asked is the
	// more precise of the two arrangements, because the window is the only thing
	// that knows what is in front of what; a window that stops asking is a window
	// whose editor still works. A covered editor is asked by nobody at all, and
	// `isActive` is the one line of that: the subscription stays where it is, and
	// the presses stop there instead of being typed into a screen nobody is on.
	usePadAction(padRef ? undefined : pad, padAction, { isActive: !hidden });

	// A layout effect, for the reason `usePadAction` gives: the window asks
	// this ref before it acts, so a press arriving between a commit and a passive
	// effect would be answered by the editor of the render before — with the
	// keyboard closed that it had just opened, or the other way round. A covered
	// editor publishes nothing: the window is looking at a screen that does not
	// include this one, and the handle is how it would hand it a press.
	useLayoutEffect(() => {
		if (!padRef) return;
		if (!hidden) {
			padRef.current = {
				action: padAction,
				fill: (text: string) => actions.setBuffer(text, text.length),
			};
		}
		return () => {
			padRef.current = null;
		};
	}, [padRef, padAction, actions, hidden]);

	usePaste(
		(text) => {
			const clean = normalizePaste(text);
			setCompletionPrefix(null);
			setSuggestionIndex(0);
			if (!shouldPlaceholderize(clean)) {
				actions.insert(clean);
				return;
			}
			pasteSeqRef.current += 1;
			const token = makePasteToken(pasteSeqRef.current, clean.length);
			pasteMapRef.current.set(token, clean);
			actions.insert(token);
		},
		{ isActive: !disabled && !hidden },
	);

	const query = completionPrefix ?? state.text;
	const suggestions =
		state.text.startsWith("/") && !state.text.includes(" ")
			? commandSuggestions.filter(([name]) => name.startsWith(query.toLowerCase())).slice(0, 5)
			: [];

	// @-mention suggestions. The slash list and the at-word are exclusive by
	// construction: slash needs a buffer starting with "/" and no space, an
	// at-word is a single token that starts with "@".
	const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
	const [fileIndex, setFileIndex] = useState(0);
	const atQuery = currentAtWord(state.text, state.cursor);

	useEffect(() => {
		if (!completeFiles || atQuery === null) return;
		const timer = setTimeout(() => {
			completeFiles(atQuery)
				.then((files) => {
					setFileSuggestions(filterFiles(files, atQuery));
					setFileIndex(0);
				})
				.catch(() => setFileSuggestions([]));
		}, 120);
		return () => clearTimeout(timer);
	}, [atQuery, completeFiles]);

	// A stale list must not linger once the caret leaves the at-word.
	useEffect(() => {
		if (atQuery === null) setFileSuggestions([]);
	}, [atQuery]);

	// Escape routing for an owner that took the key (REPL). A vim user needs Esc to
	// leave insert or drop a half-typed command without the same press also
	// aborting the turn the host aborts on.
	useEffect(() => {
		if (!escapeRef) return;
		// Covered: an Escape that closes this editor's search, drops its @-list or
		// sends its half-typed buffer belongs to a screen that is not on. The window
		// that covers it answers Escape itself — leaving the transcript, closing a
		// dialog — and this must not be a second answer to the same key.
		if (hidden) return;
		escapeRef.current = () => {
			// The search first: an Escape that closes it must not go on to interrupt
			// the turn behind it.
			if (search) {
				setSearch(null);
				return true;
			}
			if (fileSuggestions.length > 0) {
				setFileSuggestions([]);
				return true;
			}
			// True only when vim had something to cancel; an idle Esc is the host's.
			if (handleVimKey("", { escape: true })) return true;
			// Escape during a run with something typed means "stop, and send this":
			// the alternative — throwing away the run *and* the text — reads as a
			// lost keystroke. An empty buffer still falls through, so a bare Escape
			// keeps meaning interrupt.
			//
			// Not in vim mode. There Escape is a mode key pressed by reflex dozens of
			// times an hour, and a reflex that fires the buffer as a prompt while
			// killing the run is not a feature — vim users keep the plain interrupt.
			const text = expandPasteTokens(state.text, pasteMapRef.current);
			if (busy && !vim && text.trim() && onInterruptSend) {
				pushHistory(state.text);
				actions.clear();
				onInterruptSend(text);
				return true;
			}
			return false;
		};
		return () => {
			escapeRef.current = null;
		};
	}, [
		escapeRef,
		fileSuggestions,
		handleVimKey,
		search,
		busy,
		vim,
		onInterruptSend,
		state.text,
		actions,
		pushHistory,
		hidden,
	]);

	useInput(
		(input, key) => {
			// The owner calls back into the handler above; acting on it here as well
			// would run the cancel twice.
			if (key.escape && escapeRef) return;
			// While a search is open, Escape closes it. Not "leave insert", and not
			// an interrupt: this is the one thing the key can mean right now.
			if (search && key.escape) {
				setSearch(null);
				return;
			}
			if (handleVimKey(input, key)) return;
			if (search) {
				// Everything else is the query while a search is open. The vim engine
				// has already had its say above, which is what keeps Ctrl+R as redo in
				// normal and visual mode — the rule lives in the engine, not here.
				if (key.return) {
					if (matched) actions.recall(matched);
					setSearch(null);
					return;
				}
				if (key.upArrow || (key.ctrl && input === "r")) {
					setSearch((s) => (s ? { ...s, index: s.index + 1 } : s));
					return;
				}
				if (key.downArrow) {
					setSearch((s) => (s ? { ...s, index: s.index - 1 } : s));
					return;
				}
				if (key.backspace || key.delete) {
					setSearch((s) => (s ? { ...s, query: s.query.slice(0, -1), index: 0 } : s));
					return;
				}
				if (input && !key.ctrl && !key.meta && input !== "\r") {
					setSearch((s) => (s ? { ...s, query: s.query + input, index: 0 } : s));
					return;
				}
				return;
			}
			if (key.ctrl && input === "r") {
				setSearch({ query: "", index: 0 });
				return;
			}
			// Tab writes the highlighted suggestion into the buffer. Cycling alone
			// left the user staring at a list they could not accept.
			if (key.tab && fileSuggestions.length > 0) {
				const path = fileSuggestions[fileIndex % fileSuggestions.length];
				const applied = applyFileCompletion(state.text, state.cursor, path);
				setCompletionPrefix(null);
				setFileSuggestions([]);
				actions.setBuffer(applied.text, applied.cursor);
				return;
			}
			if (key.tab && suggestions.length > 0) {
				if (completionPrefix === null) {
					setCompletionPrefix(state.text);
					actions.setText(suggestions[suggestionIndex % suggestions.length][0]);
					return;
				}
				// Already completed: Tab again accepts the next match.
				const next = (suggestionIndex + 1) % suggestions.length;
				setSuggestionIndex(next);
				actions.setText(suggestions[next][0]);
				return;
			}
			if (key.escape && fileSuggestions.length > 0) {
				setFileSuggestions([]);
				return;
			}
			// Tab is completion first: while a suggestion list is open it accepts
			// from it (above). Queueing is what is left over — during a run, with
			// nothing to complete, which is exactly when the buffer has nowhere
			// else to go.
			if (key.tab && busy && onQueue && state.text.trim() && !isHostCommand(state.text.trim())) {
				const text = expandPasteTokens(state.text, pasteMapRef.current);
				pushHistory(state.text);
				actions.clear();
				onQueue(text);
				return;
			}
			if (key.return && (input === "" || input === "\r")) {
				submitCurrent();
				return;
			}
			// While a suggestion list is open the arrows move through it. Recalling
			// history here would replace the half-typed command with an old prompt,
			// which is the opposite of what someone browsing commands wants.
			if (key.upArrow) {
				if (fileSuggestions.length > 0) {
					setFileIndex((i) => (i - 1 + fileSuggestions.length) % fileSuggestions.length);
				} else if (suggestions.length > 0) {
					setSuggestionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
				} else if (!state.text.includes("\n")) {
					historyUp();
				}
				return;
			}
			if (key.downArrow) {
				if (fileSuggestions.length > 0) {
					setFileIndex((i) => (i + 1) % fileSuggestions.length);
				} else if (suggestions.length > 0) {
					setSuggestionIndex((i) => (i + 1) % suggestions.length);
				} else if (!state.text.includes("\n")) {
					historyDown();
				}
				return;
			}
			if (key.leftArrow) {
				actions.moveLeft();
				return;
			}
			if (key.rightArrow) {
				actions.moveRight();
				return;
			}
			if (key.home || (key.ctrl && input === "a")) {
				actions.moveToLineStart();
				return;
			}
			if (key.end || (key.ctrl && input === "e")) {
				actions.moveToLineEnd();
				return;
			}
			// Readline word motions and word kills. The kill ring accumulates
			// consecutive kills, so Ctrl+W Ctrl+W yanks both words back.
			if (key.meta && input === "b") {
				actions.moveWordLeft();
				return;
			}
			if (key.meta && input === "f") {
				actions.moveWordRight();
				return;
			}
			if ((key.ctrl && input === "w") || (key.meta && key.backspace)) {
				setCompletionPrefix(null);
				actions.killWordBack();
				return;
			}
			if (key.meta && input === "d") {
				setCompletionPrefix(null);
				actions.killWordForward();
				return;
			}
			if (key.ctrl && input === "k") {
				actions.killToEnd();
				return;
			}
			if (key.ctrl && input === "u") {
				actions.killToStart();
				return;
			}
			if (key.ctrl && input === "y") {
				actions.yank();
				return;
			}
			// Ctrl+_ arrives as the raw 0x1f byte on most terminals — ink only
			// treats bytes up to 0x1A as ctrl+letter. The same byte is often sent
			// for Ctrl+/, which is an acceptable alias.
			if (input === "\x1f" || (key.ctrl && input === "_")) {
				actions.undo();
				return;
			}
			if (key.backspace || key.delete) {
				// Editing invalidates the remembered prefix: the list should follow
				// what is in the buffer again. Forward-delete finally reaches the
				// hook's own delete action instead of masquerading as backspace.
				setCompletionPrefix(null);
				if (key.delete) actions.delete();
				else actions.backspace();
				return;
			}
			if (input === "\n" || (key.meta && key.return)) {
				actions.newline();
				return;
			}
			// `?` asks for the key list — but only on an empty prompt. Anywhere else
			// it is a character someone typed on purpose, in a question or a glob.
			if (input === "?" && state.text.length === 0 && onToggleHelp) {
				onToggleHelp();
				return;
			}
			if (input && !key.ctrl && !key.meta && input !== "\r") {
				setCompletionPrefix(null);
				setSuggestionIndex(0);
				actions.insert(input);
			}
		},
		{ isActive: !disabled && !hidden },
	);

	const lines = state.text.split("\n");
	const cursorLine = state.text.slice(0, state.cursor).split("\n").length - 1;
	const selected = suggestions.length > 0 ? suggestions[suggestionIndex % suggestions.length] : null;
	const sel = vimMode.startsWith("visual") ? selection : null;

	const MODE_LABEL: Record<string, string> = {
		normal: "NORMAL",
		insert: "INSERT",
		visual: "VISUAL",
		"visual-line": "V-LINE",
	};

	return (
		<Box flexDirection="column">
			{search && (
				// readline's own rendering: the query, then the entry it currently
				// points at. The list underneath is what readline does not have — it
				// is what turns "keep pressing Ctrl+R" into a choice.
				<Box flexDirection="column">
					<Text color={theme.accent}>
						(reverse-i-search)`{search.query}': {matched ?? ""}
					</Text>
					{matches.length > 1 &&
						matches.map((entry, i) => {
							const isSelected = i === searchSelectionIndex(matches, search.index);
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: matches come from history, which does not dedupe a caller-supplied seed
								<Text key={i} color={isSelected ? theme.selection : theme.textMuted}>
									{isSelected ? `${theme.marks.selected} ` : "  "}
									{entry}
								</Text>
							);
						})}
					<Text dimColor>{matches.length === 0 ? "no match" : "↑/↓ or Ctrl+R older · Enter use · Esc cancel"}</Text>
				</Box>
			)}
			{(suggestions.length > 0 || fileSuggestions.length > 0) && (
				<Box flexDirection="column" marginBottom={0}>
					{suggestions.map(([name, description], i) => {
						const isSelected = suggestionIndex % suggestions.length === i;
						return (
							<Text key={name} color={isSelected ? theme.selection : theme.textMuted}>
								{isSelected ? `${theme.marks.selected} ` : "  "}
								{name}
								{description ? ` — ${description}` : ""}
							</Text>
						);
					})}
					{fileSuggestions.map((path, i) => {
						const isSelected = fileIndex % fileSuggestions.length === i;
						return (
							<Text key={path} color={isSelected ? theme.selection : theme.textMuted}>
								{isSelected ? `${theme.marks.selected} ` : "  "}@{path}
							</Text>
						);
					})}
					{fileSuggestions.length > 0 ? (
						<Text dimColor>↑/↓ select · Tab complete · Esc dismiss</Text>
					) : (
						<Text dimColor>Tab cycle · Enter run</Text>
					)}
				</Box>
			)}
			{selected && state.text !== selected[0] && <Text dimColor> </Text>}
			{/* Above the prompt, where the suggestion lists go: it is a thing to
			    read and press while typing, not a modal standing over the app. */}
			{osk && <OnScreenKeyboard pageIndex={oskPageIndex} cursor={oskCursor} shift={oskShift} />}
			<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
				{state.text.length === 0 ? (
					// The cursor has to be drawn here too. Falling through to the
					// placeholder alone leaves an empty prompt with no caret, so the
					// terminal looks unfocused until the first keystroke.
					<Text>
						<Text inverse>{placeholderCaret(placeholder).caret}</Text>
						<Text dimColor>{placeholderCaret(placeholder).rest}</Text>
					</Text>
				) : (
					lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are plain text renders with no per-item state to preserve
						<Text key={i} color={theme.text}>
							{i === cursorLine || (sel && sel.start < lineEndOf(state.text, i))
								? renderLineWithCursorAndSelection(state, i, cursorColumn(state.text, state.cursor, i), sel)
								: line}
						</Text>
					))
				)}
				<Text dimColor>
					{vim ? `[${MODE_LABEL[vimMode] ?? "NORMAL"}] ` : ""}
					{hintLine(columns, { vim, vimMode })}
				</Text>
			</Box>
		</Box>
	);
}

function cursorColumn(text: string, cursor: number, lineIndex: number): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < lineIndex; i++) offset += lines[i].length + 1;
	return cursor - offset;
}

function lineEndOf(text: string, lineIndex: number): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i <= lineIndex && i < lines.length; i++) offset += lines[i].length + (i < lines.length - 1 ? 1 : 0);
	return offset;
}

/** Render one line with the vim selection range and cursor position highlighted. */
function renderLineWithCursorAndSelection(
	state: { text: string; cursor: number },
	lineIndex: number,
	cursorCol: number,
	sel: { start: number; end: number } | null,
) {
	const lines = state.text.split("\n");
	const line = lines[lineIndex] ?? "";
	let offset = 0;
	for (let i = 0; i < lineIndex; i++) offset += lines[i].length + 1;
	const lineStartPos = offset;
	const lineEndPos = offset + line.length;

	const selStart = sel ? Math.max(sel.start, lineStartPos) : -1;
	const selEnd = sel ? Math.min(sel.end, lineEndPos) : -1;
	const hasSelection = sel !== null && selEnd > selStart;

	if (!hasSelection) {
		// Cursor-only rendering.
		if (state.cursor < lineStartPos || state.cursor > lineEndPos) return line;
		const col = cursorCol;
		return (
			<>
				{line.slice(0, col)}
				<Text inverse>{line.slice(col, col + 1) || " "}</Text>
				{line.slice(col + 1)}
			</>
		);
	}

	// Selection may span multiple lines — clip to this line.
	const pieces: React.ReactNode[] = [];
	const before = line.slice(0, Math.max(0, selStart - lineStartPos));
	const midStart = Math.max(0, selStart - lineStartPos);
	const midEnd = Math.min(line.length, selEnd - lineStartPos);
	const middle = line.slice(midStart, midEnd);
	const after = line.slice(midEnd);

	pieces.push(before);
	if (state.cursor >= lineStartPos && state.cursor <= lineEndPos && state.cursor >= selStart && state.cursor < selEnd) {
		const relCursor = state.cursor - lineStartPos - midStart;
		if (relCursor >= 0 && relCursor < middle.length) {
			pieces.push(
				<Text inverse key="c">
					{middle.slice(relCursor, relCursor + 1)}
				</Text>,
			);
			pieces.push(middle.slice(relCursor + 1));
		} else {
			pieces.push(middle);
		}
	} else {
		pieces.push(
			<Text inverse key="s">
				{middle}
			</Text>,
		);
	}
	pieces.push(after);
	return pieces;
}
