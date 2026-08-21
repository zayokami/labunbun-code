import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../theme.ts";

export interface PermissionDialogProps {
	toolName: string;
	inputPreview: string;
	onResolve: (allow: boolean, alwaysAllow: boolean) => void;
}

/**
 * Permission dialog: 1) allow once  2) always allow this tool this session
 * 3) deny. Esc denies. The promise passed in via onResolve comes from the
 * app-layer canUseTool implementation.
 */
export function PermissionDialog({ toolName, inputPreview, onResolve }: PermissionDialogProps) {
	const theme = useTheme();
	const [selected, setSelected] = useState(0);
	const options = ["Yes", "Yes, and don't ask again for this tool", "No, tell it what to do differently"];

	useInput((input, key) => {
		if (key.upArrow) setSelected((s) => (s + options.length - 1) % options.length);
		else if (key.downArrow) setSelected((s) => (s + 1) % options.length);
		else if (key.return) {
			if (selected === 0) onResolve(true, false);
			else if (selected === 1) onResolve(true, true);
			else onResolve(false, false);
		} else if (key.escape) {
			onResolve(false, false);
		} else if (input === "y") {
			onResolve(true, false);
		} else if (input === "n") {
			onResolve(false, false);
		} else if (input === "1" || input === "2" || input === "3") {
			const index = Number(input) - 1;
			if (index === 0) onResolve(true, false);
			else if (index === 1) onResolve(true, true);
			else onResolve(false, false);
		}
	});

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1} marginBottom={1}>
			<Text color={theme.warning} bold>
				Permission required
			</Text>
			<Text>
				Tool{" "}
				<Text color={theme.toolName} bold>
					{toolName}
				</Text>{" "}
				wants to:
			</Text>
			<Text dimColor>{inputPreview}</Text>
			<Box flexDirection="column" marginTop={1}>
				{options.map((option, i) => (
					<Text key={option} color={i === selected ? theme.primary : theme.dim}>
						{i === selected ? "❯ " : "  "}
						{i + 1}. {option}
					</Text>
				))}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>↑/↓ select · Enter confirm · Esc deny</Text>
			</Box>
		</Box>
	);
}
