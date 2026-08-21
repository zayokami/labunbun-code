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
}: PromptInputProps) {
	const theme = useTheme();
	const { state, actions, historyUp, historyDown, pushHistory, vimMode, handleVimKey, selection } = useTextInput(
		[],
		vim,
	);
	const [suggestionIndex, setSuggestionIndex] = useState(0);

	const suggestions =
		state.text.startsWith("/") && !state.text.includes(" ")
			? commandSuggestions.filter(([name]) => name.startsWith(state.text.toLowerCase())).slice(0, 5)
			: [];

	useInput(
		(input, key) => {
			if (handleVimKey(input, key)) return;
			if (key.tab && suggestions.length > 0) {
				setSuggestionIndex((i) => (i + 1) % suggestions.length);
				return;
			}
			if (key.return && (input === "" || input === "\r")) {
				const text = state.text;
				if (!text.trim()) return;
				pushHistory(text);
				actions.clear();
				setSuggestionIndex(0);
				onSubmit(text);
				return;
			}
			if (key.upArrow) {
				if (!state.text.includes("\n")) historyUp();
				return;
			}
			if (key.downArrow) {
				if (!state.text.includes("\n")) historyDown();
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
				actions.backspace();
				return;
			}
			if (input === "\n" || (key.meta && key.return)) {
				actions.newline();
				return;
			}
			if (input && !key.ctrl && !key.meta && input !== "\r") {
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
							<Text key={name} color={isSelected ? theme.primary : theme.dim}>
								{isSelected ? "❯ " : "  "}
								{name}
								{description ? ` — ${description}` : ""}
							</Text>
						);
					})}
					<Text dimColor>Tab cycle · Enter run</Text>
				</Box>
			)}
			{selected && state.text !== selected[0] && <Text dimColor> </Text>}
			<Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1}>
				{state.text.length === 0 ? (
					<Text dimColor>{placeholder}</Text>
				) : (
					lines.map((line, i) => (
						<Text key={i} color={theme.text}>
							{i === cursorLine || (sel && sel.start < lineEndOf(state.text, i)) ? (
								renderLineWithCursorAndSelection(state, i, cursorColumn(state.text, state.cursor, i), sel)
							) : (
								line
							)}
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
			pieces.push(<Text inverse key="c">{middle.slice(relCursor, relCursor + 1)}</Text>);
			pieces.push(middle.slice(relCursor + 1));
		} else {
			pieces.push(middle);
		}
	} else {
		pieces.push(<Text inverse key="s">{middle}</Text>);
	}
	pieces.push(after);
	return pieces;
}
