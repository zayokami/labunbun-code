import type { PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { isAimedAt, usePadAction } from "../pad.ts";
import { dropLastChar } from "../terminal-input.ts";
import { useTheme } from "../theme.ts";
import type { PlanReviewDialogState, PlanReviewResult } from "../ui-state.ts";

/**
 * How much of a plan the dialog prints. Generous enough for a real multi-file
 * plan, bounded because the string is held in React state and redrawn every
 * frame. Past this the reader gets a note, not a silently cut-off plan.
 */
export const PLAN_REVIEW_MAX = 12_000;

/**
 * The plan review surface: the plan as prose, then three answers.
 *
 * This is deliberately not the permission dialog. A plan is read, not scanned
 * for danger, and the useful rejection is a sentence rather than a no — so
 * "no" and "no, and here is what to change" are separate answers, and the
 * second one collects a line of text before it settles. That text travels back
 * through ExitPlanMode's result to the planner; a review that could only say no
 * made the model guess what was wrong.
 *
 * Esc means different things by mode: on the option list it cancels the whole
 * review (null), and inside the feedback input it backs out to the list without
 * answering. A single Esc that cancelled a half-typed sentence would throw away
 * work the user was in the middle of doing.
 */
export function PlanReviewDialog({ plan, resolve, pad }: PlanReviewDialogState & { pad?: PadBridge }) {
	const theme = useTheme();
	/**
	 * Which screen the dialog is on. Local because only this component draws it,
	 * and because the feedback text belongs with it: leaving the input and coming
	 * back must not carry a draft into a second answer unannounced.
	 */
	const [feedbackMode, setFeedbackMode] = useState(false);
	const [feedback, setFeedback] = useState("");
	const [selected, setSelected] = useState(0);
	/**
	 * The stepping truth behind `selected`, which exists to paint. One read can
	 * carry several keys — a held key's autorepeat, or a burst the terminal
	 * coalesced — and the dispatcher runs them all before React has committed the
	 * first move. Every read of the highlight goes through this ref, as in the
	 * question and permission dialogs.
	 */
	const selectedRef = useRef(0);
	/** Resolve once. A burst can contain Enter and then Esc in the same read. */
	const settledRef = useRef(false);

	const settle = (result: PlanReviewResult | null): void => {
		if (settledRef.current) return;
		settledRef.current = true;
		resolve(result);
	};

	const truncated = plan.length > PLAN_REVIEW_MAX;
	const shown = truncated ? plan.slice(0, PLAN_REVIEW_MAX) : plan;

	/** Move the highlight, wrapping. */
	const step = (delta: number): void => {
		const next = (((selectedRef.current + delta) % 3) + 3) % 3;
		selectedRef.current = next;
		setSelected(next);
	};

	/** Take the highlighted answer. Enter and the pad's ✕ both land here. */
	const confirm = (): void => {
		switch (selectedRef.current) {
			case 0:
				settle({ approved: true });
				return;
			case 1:
				settle({ approved: false });
				return;
			default:
				// The third row opens the input. It does not answer anything yet.
				setFeedbackMode(true);
		}
	};

	const openedAt = useRef(Date.now());
	usePadAction(pad, (action) => {
		if (action.phase === "release" || !isAimedAt(action, openedAt.current)) return false;
		if (feedbackMode) {
			// No free typing on a controller, so the only things the pad can do here
			// are the two the keyboard does around the input: send, or go back.
			if (action.kind === "cancel") {
				setFeedbackMode(false);
				return true;
			}
			if (action.kind === "confirm") {
				settle({ approved: false, feedback: feedback.trim() });
				return true;
			}
			return false;
		}
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
			case "cancel":
				settle(null);
				return true;
			default:
				return false;
		}
	});

	useInput((input, key) => {
		if (feedbackMode) {
			if (key.escape) {
				setFeedbackMode(false);
				return;
			}
			if (key.return) {
				settle({ approved: false, feedback: feedback.trim() });
				return;
			}
			if (key.backspace || key.delete) {
				setFeedback((text) => dropLastChar(text));
				return;
			}
			// Modifiers are commands, not text. Control characters (Tab included)
			// are dropped; anything else printable is appended, so a pasted line
			// arrives whole. Filtered by code point rather than by regex: a
			// character class of control characters is what the lint rule forbids,
			// and a named range here reads better than an escape table anyway.
			if (key.ctrl || key.meta) return;
			const printable = [...input]
				.filter((char) => {
					const code = char.codePointAt(0) ?? 0;
					return code >= 0x20 && code !== 0x7f;
				})
				.join("");
			if (printable) setFeedback((text) => text + printable);
			return;
		}
		if (key.escape) {
			settle(null);
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
		if (key.return) {
			confirm();
			return;
		}
		// y/n are shortcuts for the two plain answers, and only here: in the
		// feedback input they are letters like any other, which is the whole
		// reason the shortcuts are gated on the option list.
		if (input === "y") {
			settle({ approved: true });
			return;
		}
		if (input === "n") {
			settle({ approved: false });
			return;
		}
		if (input === "1" || input === "2" || input === "3") {
			selectedRef.current = Number(input) - 1;
			setSelected(Number(input) - 1);
			confirm();
		}
	});

	const options = ["Yes, implement this plan", "No, keep planning", "Send feedback to the planner"];

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				Plan for your approval
			</Text>
			<Box flexDirection="column" marginTop={1}>
				<Text>{shown}</Text>
				{truncated ? (
					<Text dimColor>{`… plan truncated: showing the first ${PLAN_REVIEW_MAX} of ${plan.length} characters`}</Text>
				) : null}
			</Box>
			{feedbackMode ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.textMuted}>Feedback for the planner (it will revise the plan):</Text>
					<Text color={theme.selection}>
						{feedback}
						{"▌"}
					</Text>
				</Box>
			) : (
				<Box flexDirection="column" marginTop={1}>
					{options.map((label, i) => (
						<Text key={label} color={i === selected ? theme.selection : theme.textMuted}>
							{i === selected ? `${theme.marks.selected} ` : "  "}
							{i + 1}. {label}
						</Text>
					))}
				</Box>
			)}
			<Box marginTop={1}>
				<Text dimColor>
					{feedbackMode
						? "Type feedback · Backspace delete · Enter send · Esc back"
						: "↑/↓ select · Enter confirm · 1-3 answer · y approve · n keep planning · Esc cancel"}
					{pad ? (feedbackMode ? " · ✕ send · ○ back" : " · ✕ confirm · ○ cancel") : ""}
				</Text>
			</Box>
		</Box>
	);
}
