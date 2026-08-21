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
	const { state, actions, historyUp, historyDown, pushHistory, vimMode, handleVimKey } = useTextInput([], vim);
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
							{i === cursorLine ? (
								<>
									{line.slice(0, cursorColumn(state.text, state.cursor, i))}
									<Text inverse> </Text>
									{line.slice(cursorColumn(state.text, state.cursor, i))}
								</>
							) : (
								line
							)}
						</Text>
					))
				)}
				<Text dimColor>
					{vim ? `[${vimMode === "normal" ? "NORMAL" : "INSERT"}] ` : ""}
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
