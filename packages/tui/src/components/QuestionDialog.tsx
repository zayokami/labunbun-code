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
	/**
	 * The free-text answer, while it is being typed. A string, possibly empty,
	 * while the field is up; null while the option list owns the keys. Only
	 * single-select questions offer it: a multi-select answer is a set of
	 * labels, and "Other" plus a set has no meaning the rest of the pipeline
	 * could read back (see the option's row in the render below).
	 */
	const [other, setOther] = useState<string | null>(null);
	/**
	 * The stepping truth behind `selected`, which exists to paint. One read can
	 * carry several keys — a held key's autorepeat, or a burst the terminal
	 * coalesced — and the dispatcher runs them all before React has committed
	 * the first move. A move and the Space or Enter it earned, read from the
	 * rendered value, would answer the option the screen was still showing a
	 * keystroke ago. Every read of the highlight goes through this ref.
	 */
	const selectedRef = useRef(0);
	/** Labels toggled for the current question; only ever non-empty for a multi-select. */
	const [picked, setPicked] = useState<string[]>([]);
	const [answers, setAnswers] = useState<string[]>([]);

	const current = questions[questionIndex];
	const multi = current?.multiSelect === true;
	/** The label of the free-text row; the answer it produces is what was typed. */
	const OTHER_LABEL = "Other…";
	/** The Other row's index, or -1 when the question does not offer one. */
	const otherRow = multi || !current ? -1 : current.options.length;

	const advance = (answer: string): void => {
		const next = [...answers, answer];
		if (questionIndex + 1 < questions.length) {
			setAnswers(next);
			setQuestionIndex(questionIndex + 1);
			selectedRef.current = 0;
			setSelected(0);
			setPicked([]);
			setOther(null);
		} else {
			resolve(next);
		}
	};

	/** Move the highlight, wrapping. Keyboard navigation includes the Other row. */
	const step = (delta: number): void => {
		if (!current || current.options.length === 0) return;
		const count = current.options.length + (otherRow >= 0 ? 1 : 0);
		const next = (((selectedRef.current + delta) % count) + count) % count;
		selectedRef.current = next;
		setSelected(next);
	};

	/**
	 * The pad's movement skips Other: a controller cannot type the answer, and
	 * a row that can only be confirmed into nothing is a row that looks broken.
	 */
	const stepPad = (delta: number): void => {
		if (!current || current.options.length === 0) return;
		const count = current.options.length;
		const from = selectedRef.current >= count ? (delta > 0 ? count - 1 : 0) : selectedRef.current;
		const next = (((from + delta) % count) + count) % count;
		selectedRef.current = next;
		setSelected(next);
	};

	/** Tick or untick the highlighted box. The pad's □ and the space bar. */
	const toggle = (): void => {
		const label = current?.options[selectedRef.current]?.label;
		if (label === undefined) return;
		setPicked((p) => (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]));
	};

	/** Answer the question on screen. Enter and the pad's ✕ both land here. */
	const confirm = (): void => {
		if (!current || current.options.length === 0) return;
		// The free-text row opens its field instead of answering: there is no
		// answer to give until something is typed, and an empty one is not an
		// answer at all.
		if (selectedRef.current === otherRow) {
			setOther("");
			return;
		}
		const label = current.options[selectedRef.current]?.label ?? "";
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
		// The free-text field is keyboard territory — no button types — so the
		// pad's two keys around it are ○ to go back and ✕ to do nothing.
		if (other !== null) {
			if (action.kind === "cancel") setOther(null);
			return true;
		}
		if (!current || current.options.length === 0) return false;
		switch (action.kind) {
			case "up":
			case "left":
				stepPad(-1);
				return true;
			case "down":
			case "right":
				stepPad(1);
				return true;
			case "confirm":
				// The pad never lands on Other, but the keyboard can leave the
				// highlight there; ✕ on that row does nothing rather than opening a
				// field the controller cannot fill.
				if (selectedRef.current !== otherRow) confirm();
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
		if (other !== null) {
			// The field's keys, and only these. Esc goes back to the options
			// rather than cancelling the question: the person who opened the
			// field by mistake has not said "no answer at all". Enter with an
			// empty field does nothing — an empty answer is not one.
			if (key.escape) {
				setOther(null);
				return;
			}
			if (key.return) {
				const answer = other.trim();
				if (answer) advance(answer);
				return;
			}
			if (key.backspace || key.delete) {
				setOther((text) => (text ?? "").slice(0, -1));
				return;
			}
			if (key.ctrl || key.meta) return;
			const printable = [...input]
				.filter((char) => {
					const code = char.codePointAt(0) ?? 0;
					return code >= 0x20 && code !== 0x7f;
				})
				.join("");
			if (printable) setOther((text) => (text ?? "") + printable);
			return;
		}
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
		<Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1}>
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
				{otherRow >= 0 ? (
					<Text color={selected === otherRow ? theme.selection : theme.textMuted}>
						{selected === otherRow ? `${theme.marks.selected} ` : "  "}
						{OTHER_LABEL}
					</Text>
				) : null}
			</Box>
			{other !== null ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.accent}>Your answer:</Text>
					<Text>{other.length > 0 ? other : " "}</Text>
					<Text dimColor>
						Enter submit{other.trim() ? "" : " (type an answer first)"} · Esc back
						{pad ? " · ○ back" : ""}
					</Text>
				</Box>
			) : (
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
			)}
		</Box>
	);
}
