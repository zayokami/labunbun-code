import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../theme.ts";
import type { QuestionDialogState } from "../ui-state.ts";

/**
 * Structured question dialog: renders the agent's questions one at a time.
 * ↑/↓ move, Enter selects and advances, Esc cancels everything.
 */
export function QuestionDialog({ questions, resolve }: QuestionDialogState) {
	const theme = useTheme();
	const [questionIndex, setQuestionIndex] = useState(0);
	const [selected, setSelected] = useState(0);
	const [answers, setAnswers] = useState<string[]>([]);

	const current = questions[questionIndex];

	useInput((_input, key) => {
		if (!current) return;
		if (key.escape) {
			resolve(null);
			return;
		}
		if (key.upArrow) {
			setSelected((s) => (s + current.options.length - 1) % current.options.length);
			return;
		}
		if (key.downArrow) {
			setSelected((s) => (s + 1) % current.options.length);
			return;
		}
		if (key.return) {
			const label = current.options[selected]?.label ?? "";
			const next = [...answers, label];
			if (questionIndex + 1 < questions.length) {
				setAnswers(next);
				setQuestionIndex(questionIndex + 1);
				setSelected(0);
			} else {
				resolve(next);
			}
		}
	});

	if (!current) return null;

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1} marginBottom={1}>
			<Text color={theme.primary} bold>
				{current.header}
				{questions.length > 1 ? ` (${questionIndex + 1}/${questions.length})` : ""}
			</Text>
			<Text>{current.question}</Text>
			<Box flexDirection="column" marginTop={1}>
				{current.options.map((option, i) => (
					<Box key={option.label} flexDirection="column">
						<Text color={i === selected ? theme.primary : theme.dim}>
							{i === selected ? "❯ " : "  "}
							{option.label}
						</Text>
						{i === selected && option.description && <Text dimColor> {option.description}</Text>}
					</Box>
				))}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>↑/↓ select · Enter confirm · Esc cancel</Text>
			</Box>
		</Box>
	);
}
