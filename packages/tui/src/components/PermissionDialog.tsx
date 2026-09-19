import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { type PermissionOption, permissionOptions } from "../permission-options.ts";
import { useTheme } from "../theme.ts";

export interface PermissionDialogProps {
	toolName: string;
	inputPreview: string;
	/** The input in full, for Ctrl+A. Absent means there is nothing more to show. */
	inputFull?: string;
	/**
	 * The answers to offer. Supplied by the host, which is the only place that
	 * still holds the raw input the scope of a rule is computed from; without it
	 * the widest truthful wording is used (the bare tool).
	 */
	options?: PermissionOption[];
	onResolve: (allow: boolean, alwaysAllow: boolean) => void;
	/** Requests queued behind this one, including it (see PermissionDialogState). */
	queueLength?: number;
}

/**
 * Permission dialog: 1) allow once  2) always allow, scoped to this command or
 * this directory this session  3) deny. Esc denies. The promise passed in via
 * onResolve comes from the app-layer canUseTool implementation.
 *
 * The options are named for their consequences rather than for their position —
 * "don't ask again" used to grant the whole tool, so approving `git status` also
 * approved every later Bash call. Esc stays the safe answer.
 */
export function PermissionDialog({
	toolName,
	inputPreview,
	inputFull,
	options,
	onResolve,
	queueLength,
}: PermissionDialogProps) {
	const theme = useTheme();
	const [selected, setSelected] = useState(0);
	const [expanded, setExpanded] = useState(false);
	const answers = options ?? permissionOptions(toolName, undefined);
	const body = expanded && inputFull ? inputFull : inputPreview;

	useInput((input, key) => {
		if (key.upArrow) setSelected((s) => (s + answers.length - 1) % answers.length);
		else if (key.downArrow) setSelected((s) => (s + 1) % answers.length);
		else if (key.ctrl && input === "a") setExpanded((e) => !e);
		else if (key.return) {
			const answer = answers[selected % answers.length];
			onResolve(answer.allow, answer.alwaysAllow);
		} else if (key.escape) {
			onResolve(false, false);
		} else if (input === "y") {
			onResolve(true, false);
		} else if (input === "n") {
			onResolve(false, false);
		} else if (input === "1" || input === "2" || input === "3") {
			const answer = answers[Number(input) - 1];
			if (answer) onResolve(answer.allow, answer.alwaysAllow);
		}
	});

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.permission} paddingX={1} marginBottom={1}>
			<Text color={theme.permission} bold>
				Permission required
				{queueLength !== undefined && queueLength > 1 ? ` (+${queueLength - 1} more waiting)` : ""}
			</Text>
			<Text>
				Tool{" "}
				<Text color={theme.toolName} bold>
					{toolName}
				</Text>{" "}
				wants to:
			</Text>
			<Text color={theme.toolArgs}>{body}</Text>
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
				</Text>
			</Box>
		</Box>
	);
}
