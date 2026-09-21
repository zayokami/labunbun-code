import type { PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { isAimedAt, usePadAction } from "../pad.ts";
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
 *
 * A pad answers through the same two helpers the keys use, and gets the one key
 * it has no equivalent for: □ is the space bar, so a checkbox can be ticked
 * without a keyboard. Esc's job — cancel everything — is ○'s.
 */
export function QuestionDialog({ questions, resolve, pad }: QuestionDialogState & { pad?: PadBridge }) {
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

	/** Move the highlight, wrapping. */
	const step = (delta: number): void => {
		if (!current || current.options.length === 0) return;
		setSelected((s) => (((s + delta) % current.options.length) + current.options.length) % current.options.length);
	};

	/** Tick or untick the highlighted box. The pad's □ and the space bar. */
	const toggle = (): void => {
		const label = current?.options[selected]?.label;
		if (label === undefined) return;
		setPicked((p) => (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]));
	};

	/** Answer the question on screen. Enter and the pad's ✕ both land here. */
	const confirm = (): void => {
		if (!current || current.options.length === 0) return;
		const label = current.options[selected]?.label ?? "";
		if (!multi) {
			advance(label);
			return;
		}
		// The toggled set; with nothing toggled the highlighted option is the
		// answer, so confirming never dead-ends on a question with an obvious
		// one-key response.
		advance((picked.length > 0 ? picked : [label]).filter(Boolean).join(", "));
	};

	const openedAt = useRef(Date.now());
	usePadAction(pad, (action) => {
		if (action.phase === "release" || !isAimedAt(action, openedAt.current)) return false;
		if (!current || current.options.length === 0) return false;
		switch (action.kind) {
			case "up":
			case "left":
				step(-1);
				return true;
			case "down":
			case "right":
				step(1);
				return true;
			case "confirm":
				confirm();
				return true;
			case "clear":
				if (multi) toggle();
				return true;
			case "cancel":
				resolve(null);
				return true;
			default:
				return false;
		}
	});

	useInput((input, key) => {
		if (!current || current.options.length === 0) return;
		if (key.escape) {
			resolve(null);
			return;
		}
		if (multi && input === " ") {
			toggle();
			return;
		}
		if (key.upArrow) {
			step(-1);
			return;
		}
		if (key.downArrow) {
			step(1);
			return;
		}
		if (key.return) confirm();
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
					{/* □ is the pad's space bar, and it is worth naming for the same reason
					    the permission dialog names its hold: a multi-select whose ticks a
					    controller could not make would answer with the highlighted option
					    and call that a choice. */}
					{pad ? (multi ? " · □ select · ✕ confirm · ○ cancel" : " · ✕ answer · ○ cancel") : ""}
				</Text>
			</Box>
		</Box>
	);
}
