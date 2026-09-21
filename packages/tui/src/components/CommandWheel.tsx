import { Box, Text } from "ink";
import { WHEEL_ROWS, type WheelEntry, wheelStart } from "../command-wheel.ts";
import { useTheme } from "../theme.ts";

export interface CommandWheelProps {
	entries: WheelEntry[];
	/** Which entry is under the ✕. Any integer; the ring wraps. */
	index: number;
}

/**
 * The wheel, drawn as a list. The window follows the selection for the same
 * reason the picker's does: a highlight that walked off the bottom of a box
 * would leave the user pressing ✕ on something they cannot see.
 */
export function CommandWheel({ entries, index }: CommandWheelProps) {
	const theme = useTheme();
	const start = wheelStart(entries.length, index);
	const rows = entries.slice(start, start + WHEEL_ROWS);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				Commands
			</Text>
			{entries.length === 0 ? (
				<Text dimColor>Nothing to offer — no commands, no phrases</Text>
			) : (
				<Box flexDirection="column">
					{rows.map((entry, row) => {
						// Keyed by place in the ring, not by label: a user can write a phrase
						// whose text is a command's name, and the same words twice.
						const ringIndex = start + row;
						const selected = ringIndex === index;
						return (
							<Text key={`${entry.kind}-${ringIndex}`} color={selected ? theme.selection : theme.textMuted}>
								{selected ? `${theme.marks.selected} ` : "  "}
								{entry.label}
								{entry.kind === "command" && entry.description ? ` — ${entry.description}` : ""}
							</Text>
						);
					})}
				</Box>
			)}
			<Box marginTop={1}>
				<Text dimColor>✕ run · ↑/↓ move · L1/R1 page · ○ close</Text>
			</Box>
		</Box>
	);
}
