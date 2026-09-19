import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../theme.ts";
import type { QuestionDialogState } from "../ui-state.ts";

/**
 * Structured question dialog: renders the agent's questions one at a time.
 * ↑/↓ move, Enter selects and advances, Esc cancels everything.
 *
 * A question marked `multiSelect` gets checkboxes instead: Space toggles, and
 * Enter confirms the whole set — still one answer string per question, the
 * chosen labels joined with ", ", so nothing downstream has to know which kind
 * of question it was.
 */
export function QuestionDialog({ questions, resolve }: QuestionDialogState) {
	const theme = useTheme();
	const [questionIndex, setQuestionIndex] = useState(0);
	const [selected, setSelected] = useState(0);
	/** Labels toggled for the current question; only ever non-empty for a multi-select. */
	const [picked, setPicked] = useState<string[]>([]);
	const [answers, setAnswers] = useState<string[]>([]);

	const current = questions[questionIndex];
	const multi = current?.multiSelect === true;

	const advance = (answer: string): void => {
		const next = [...answers, answer];
		if (questionIndex + 1 < questions.length) {
			setAnswers(next);
			setQuestionIndex(questionIndex + 1);
			setSelected(0);
			setPicked([]);
		} else {
			resolve(next);
		}
	};

	useInput((input, key) => {
		if (!current || current.options.length === 0) return;
		if (key.escape) {
			resolve(null);
			return;
		}
		if (multi && input === " ") {
			const label = current.options[selected]?.label;
			if (label !== undefined) {
				setPicked((p) => (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]));
			}
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
			if (!multi) {
				advance(label);
				return;
			}
			// The toggled set; with nothing toggled the highlighted option is the
			// answer, so confirming never dead-ends on a question with an obvious
			// one-key response.
			advance((picked.length > 0 ? picked : [label]).filter(Boolean).join(", "));
		}
	});

	if (!current || current.options.length === 0) return null;

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				{current.header}
				{questions.length > 1 ? ` (${questionIndex + 1}/${questions.length})` : ""}
			</Text>
			<Text>{current.question}</Text>
			<Box flexDirection="column" marginTop={1}>
				{current.options.map((option, i) => {
					const isCursor = i === selected;
					const isPicked = multi && picked.includes(option.label);
					const marker = multi
						? `${isCursor ? theme.marks.selected : " "} [${isPicked ? "x" : " "}] `
						: isCursor
							? `${theme.marks.selected} `
							: "  ";
					return (
						<Box key={option.label} flexDirection="column">
							<Text color={isCursor ? theme.selection : theme.textMuted}>
								{marker}
								{option.label}
							</Text>
							{isCursor && option.description && <Text dimColor> {option.description}</Text>}
						</Box>
					);
				})}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>
					{multi ? "↑/↓ move · Space select · Enter confirm · Esc cancel" : "↑/↓ select · Enter confirm · Esc cancel"}
				</Text>
			</Box>
		</Box>
	);
}
