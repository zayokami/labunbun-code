import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import { type RefObject, useEffect, useRef, useState } from "react";
import { type HistorySearchState, historyMatches, searchSelection, searchSelectionIndex } from "../history-search.ts";
import { useTextInput } from "../hooks/useTextInput.ts";
import { expandPasteTokens, makePasteToken, normalizePaste, shouldPlaceholderize } from "../paste.ts";
import { applyFileCompletion, currentAtWord, filterFiles } from "../prompt-files.ts";
import { hintLine } from "../shortcuts.ts";
import { useTheme } from "../theme.ts";

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
		{ isActive: !disabled },
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
			return handleVimKey("", { escape: true });
		};
		return () => {
			escapeRef.current = null;
		};
	}, [escapeRef, fileSuggestions, handleVimKey, search]);

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
			if (key.return && (input === "" || input === "\r")) {
				// Placeholder tokens expand here, so the model and the transcript see
				// the real payload. History keeps the compact token form — recall and
				// resubmit expand through the still-live map. A partially deleted
				// token no longer matches and stays literal text (accepted limitation).
				const raw = state.text;
				const text = expandPasteTokens(raw, pasteMapRef.current);
				if (!text.trim()) return;
				pushHistory(raw);
				actions.clear();
				setSuggestionIndex(0);
				setCompletionPrefix(null);
				onSubmit(text);
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
		{ isActive: !disabled },
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
