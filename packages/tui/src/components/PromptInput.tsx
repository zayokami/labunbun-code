import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTextInput } from "../hooks/useTextInput.ts";
import { useTheme } from "../theme.ts";

export interface PromptInputProps {
	onSubmit: (text: string) => void;
	disabled?: boolean;
	placeholder?: string;
	/** Slash-command suggestions: [name, description]. */
	commandSuggestions?: Array<[string, string]>;
	/** Modal vim editing (normal/insert). */
	vim?: boolean;
	/**
	 * Prompts from earlier sessions, oldest first, for ↑ recall. Without this the
	 * buffer starts empty and ↑ only reaches prompts typed in this session.
	 */
	history?: string[];
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
	vim = false,
	history = [],
}: PromptInputProps) {
	const theme = useTheme();
	const { state, actions, historyUp, historyDown, pushHistory, vimMode, handleVimKey, selection } = useTextInput(
		history,
		vim,
	);
	const [suggestionIndex, setSuggestionIndex] = useState(0);
	/**
	 * What was typed before the first Tab, or null when nothing has been completed
	 * yet. Filtering on the buffer alone collapses the list to a single entry the
	 * moment Tab writes a full command into it, which makes further cycling
	 * impossible — so the original prefix keeps driving the list.
	 */
	const [completionPrefix, setCompletionPrefix] = useState<string | null>(null);

	const query = completionPrefix ?? state.text;
	const suggestions =
		state.text.startsWith("/") && !state.text.includes(" ")
			? commandSuggestions.filter(([name]) => name.startsWith(query.toLowerCase())).slice(0, 5)
			: [];

	useInput(
		(input, key) => {
			if (handleVimKey(input, key)) return;
			// Tab writes the highlighted suggestion into the buffer. Cycling alone
			// left the user staring at a list they could not accept.
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
			if (key.return && (input === "" || input === "\r")) {
				const text = state.text;
				if (!text.trim()) return;
				pushHistory(text);
				actions.clear();
				setSuggestionIndex(0);
				setCompletionPrefix(null);
				onSubmit(text);
				return;
			}
			// While the suggestion list is open the arrows move through it. Recalling
			// history here would replace the half-typed command with an old prompt,
			// which is the opposite of what someone browsing commands wants.
			if (key.upArrow) {
				if (suggestions.length > 0) {
					setSuggestionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
				} else if (!state.text.includes("\n")) {
					historyUp();
				}
				return;
			}
			if (key.downArrow) {
				if (suggestions.length > 0) {
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
			if (key.backspace || key.delete) {
				// Editing invalidates the remembered prefix: the list should follow
				// what is in the buffer again.
				setCompletionPrefix(null);
				actions.backspace();
				return;
			}
			if (input === "\n" || (key.meta && key.return)) {
				actions.newline();
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
			{suggestions.length > 0 && (
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
					<Text dimColor>Tab cycle · Enter run</Text>
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
					Enter send · Shift+Enter newline · ↑↓ history · Esc interrupt · /help
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
