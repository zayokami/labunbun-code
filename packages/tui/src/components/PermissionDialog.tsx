import type { PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { isAimedAt, usePadAction } from "../pad.ts";
import type { DiffLineKind, PermissionDiff } from "../permission-diff.ts";
import { type PermissionOption, permissionOptions } from "../permission-options.ts";
import { type Theme, useTheme } from "../theme.ts";

export interface PermissionDialogProps {
	toolName: string;
	inputPreview: string;
	/** The input in full, for Ctrl+A. Absent means there is nothing more to show. */
	inputFull?: string;
	/**
	 * The change this call will make, when the call is a change (`Edit`,
	 * `Write`). Takes the preview's place; Ctrl+A still swaps in the raw input.
	 */
	diff?: PermissionDiff;
	/**
	 * The answers to offer. Supplied by the host, which is the only place that
	 * still holds the raw input the scope of a rule is computed from; without it
	 * the widest truthful wording is used (the bare tool).
	 */
	options?: PermissionOption[];
	onResolve: (allow: boolean, alwaysAllow: boolean, alwaysAsk?: boolean) => void;
	/** Requests queued behind this one, including it (see PermissionDialogState). */
	queueLength?: number;
	/**
	 * Who raised the request when that is not this session: an ask forwarded
	 * from a subagent (see PermissionDialogState.source). Absent for the
	 * session's own calls.
	 */
	source?: string;
	/**
	 * The controller, when there is one. It may answer this dialog only if the
	 * user turned that on — see `PadBridge.allowApprove`, which is a user-tier
	 * setting nothing below it can raise.
	 */
	pad?: PadBridge;
}

/**
 * Permission dialog: 1) allow once  2) always allow, scoped to this command or
 * this directory this session  3) yes, and keep asking for the same scope  4)
 * deny. Esc denies. The promise passed in via onResolve comes from the
 * app-layer canUseTool implementation.
 *
 * The options are named for their consequences rather than for their position —
 * "don't ask again" used to grant the whole tool, so approving `git status` also
 * approved every later Bash call. Esc stays the safe answer.
 *
 * The pad's answers follow the same principle: ○ denies, ✕ takes the
 * highlighted answer, and *holding* ✕ takes the standing one — "yes, and stop
 * asking like this". A hold is deliberate in a way a tap is not, which is what
 * makes it the right gesture for the grant that outlives the question.
 */
export function PermissionDialog({
	toolName,
	inputPreview,
	inputFull,
	diff,
	options,
	onResolve,
	queueLength,
	source,
	pad,
}: PermissionDialogProps) {
	const theme = useTheme();
	const [selected, setSelected] = useState(0);
	/**
	 * The stepping truth behind `selected`, which exists to paint. One read can
	 * carry several keys — a held key's autorepeat, or a burst the terminal
	 * coalesced — and the dispatcher runs them all before React has committed
	 * the first move. A move and the Enter it earned, read from the rendered
	 * value, would answer the row the screen was still showing a keystroke ago.
	 * Every read of the highlight goes through this ref.
	 */
	const selectedRef = useRef(0);
	const [expanded, setExpanded] = useState(false);
	const answers = options ?? permissionOptions(toolName, undefined);
	const body = expanded && inputFull ? inputFull : inputPreview;
	/** The row a held ✕ takes — the one that stops the asking — or -1 for none. */
	const standing = answers.findIndex((answer) => answer.alwaysAllow);

	/** Move the highlight, wrapping. */
	const step = (delta: number): void => {
		const next = (((selectedRef.current + delta) % answers.length) + answers.length) % answers.length;
		selectedRef.current = next;
		setSelected(next);
	};

	const openedAt = useRef(Date.now());
	usePadAction(pad, (action) => {
		if (action.phase === "release" || !isAimedAt(action, openedAt.current)) return false;
		// Denying is always safe, and always the pad's to do: a controller that
		// could only say yes would be worse than one that said nothing.
		if (action.kind === "cancel") {
			// The pad's own no, said out loud. The screen answers either way, but a
			// press with nothing behind it is a press the thumb cannot tell from a
			// report that never arrived — and this is the answer the dialog is happy to
			// let the pad give, so confirming it costs nothing and settles the doubt.
			pad?.buzz("refused");
			onResolve(false, false);
			return true;
		}
		// The highlight moves the way the arrows move it. Without this the pad
		// could say "yes, once" and — by holding ✕ — "yes, always", but a "no,
		// and tell the model what to do differently" is a *different* no from
		// ○'s, and one only a person reading the screen would pick.
		if (action.kind === "up" || action.kind === "left") {
			step(-1);
			return true;
		}
		if (action.kind === "down" || action.kind === "right") {
			step(1);
			return true;
		}
		if (action.kind !== "confirm") return false;
		// The gate the whole feature is built around. Approving is off unless the
		// user turned it on, and a pad that is not allowed to answer says so out
		// loud — a buzz, because the thumb that just pressed ✕ is the only
		// evidence the press happened at all.
		if (!pad?.allowApprove) {
			pad?.buzz("refused");
			return true;
		}
		const standing = answers.find((answer) => answer.alwaysAllow);
		const answer = action.phase === "hold" && standing ? standing : answers[selectedRef.current % answers.length];
		onResolve(answer.allow, answer.alwaysAllow, answer.alwaysAsk);
		return true;
	});

	useInput((input, key) => {
		if (key.upArrow) step(-1);
		else if (key.downArrow) step(1);
		else if (key.ctrl && input === "a") setExpanded((e) => !e);
		else if (key.return) {
			const answer = answers[selectedRef.current % answers.length];
			onResolve(answer.allow, answer.alwaysAllow, answer.alwaysAsk);
		} else if (key.escape) {
			onResolve(false, false);
		} else if (input === "y") {
			onResolve(true, false);
		} else if (input === "n") {
			onResolve(false, false);
		} else if (input === "1" || input === "2" || input === "3" || input === "4") {
			const answer = answers[Number(input) - 1];
			if (answer) onResolve(answer.allow, answer.alwaysAllow, answer.alwaysAsk);
		}
	});

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.permission} paddingX={1} marginBottom={1}>
			<Text color={theme.permission} bold>
				Permission required
				{queueLength !== undefined && queueLength > 1 ? ` (+${queueLength - 1} more waiting)` : ""}
			</Text>
			{source ? (
				// The label stays dim and the source wears the agent token, as
				// siblings rather than one dim Text with a nested color: ink applies
				// `dimColor` as a transform over the whole squashed line, so a nested
				// color could not stand on its own. Who is asking is the fact this
				// line exists for — the session's own asks carry no source at all.
				<Text>
					<Text dimColor>Requested by </Text>
					<Text color={theme.agent}>{source}</Text>
				</Text>
			) : null}
			<Text>
				Tool{" "}
				<Text color={theme.toolName} bold>
					{toolName}
				</Text>{" "}
				wants to:
			</Text>
			{diff && !expanded ? (
				<Box flexDirection="column">
					{diff.lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and never reordered
						<Text key={`diff-${i}`} color={diffColor(line.kind, theme)}>
							{diffPrefix(line.kind)}
							{line.text}
						</Text>
					))}
					{diff.notice ? <Text dimColor>{diff.notice}</Text> : null}
				</Box>
			) : (
				<Text color={theme.toolArgs}>{body}</Text>
			)}
			<Box flexDirection="column" marginTop={1}>
				{answers.map((answer, i) => (
					<Text key={answer.label} color={i === selected ? theme.selection : theme.textMuted}>
						{i === selected ? `${theme.marks.selected} ` : "  "}
						{i + 1}. {answer.label}
					</Text>
				))}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>
					↑/↓ select · Enter confirm · Esc deny
					{inputFull ? ` · Ctrl+A ${expanded ? "collapse" : "show full input"}` : ""}
					{/* The pad's answers, named next to the keyboard's the way the wheel
					    and the on-screen keyboard name them. The hold is the part that has
					    to be said out loud: nobody holds a button by accident, so the one
					    gesture that grants a standing allowance is the one no user finds
					    by trying buttons. It points at the numbered row a hold would take
					    rather than promising an "always" the list is not offering.
					    A ✕ that does nothing reads as a broken controller, so the refusal
					    says why — the setting is one the user chose, not one to guess — and
					    ○ stays named, because a pad that can only refuse is still a pad
					    that can answer the question. */}
					{pad
						? pad.allowApprove
							? ` · ✕ confirm${standing >= 0 ? ` · hold ✕ row ${standing + 1}` : ""} · ○ deny`
							: " · pad may not approve · ○ deny"
						: ""}
				</Text>
			</Box>
		</Box>
	);
}

/** The marker a unified diff puts in front of the line, and the indent of context. */
function diffPrefix(kind: DiffLineKind): string {
	if (kind === "added") return "+";
	if (kind === "removed") return "-";
	if (kind === "context") return " ";
	return "";
}

/**
 * The palette a result diff already uses (MessageList): one set of colours for
 * one idea of a change.
 */
function diffColor(kind: DiffLineKind, theme: Theme): string {
	if (kind === "added") return theme.diffAdded;
	if (kind === "removed") return theme.diffRemoved;
	if (kind === "header") return theme.diffHeader;
	return theme.toolOutput;
}
