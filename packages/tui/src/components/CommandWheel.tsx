import { Box, Text } from "ink";
import { WHEEL_ROWS, type WheelEntry, wheelStart } from "../command-wheel.ts";
import { useTheme } from "../theme.ts";

export interface CommandWheelProps {
	entries: WheelEntry[];
	/** Which entry is under the ✕. Any integer; the ring wraps. */
	index: number;
	/**
	 * Whether a controller is connected. The wheel is opened from a pad, but a
	 * pad can go away while it is up — and the footer names buttons, so it is
	 * drawn only while those buttons are on a pad somebody is holding.
	 */
	padHints?: boolean;
}

/**
 * The wheel, drawn as a list. The window follows the selection for the same
 * reason the picker's does: a highlight that walked off the bottom of a box
 * would leave the user pressing ✕ on something they cannot see.
 */
export function CommandWheel({ entries, index, padHints = false }: CommandWheelProps) {
	const theme = useTheme();
	const start = wheelStart(entries.length, index);
	const rows = entries.slice(start, start + WHEEL_ROWS);

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1}>
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
			{padHints ? (
				<Box marginTop={1}>
					<Text dimColor>✕ run · ↑/↓ move · L1/R1 page · ○ close</Text>
				</Box>
			) : null}
		</Box>
	);
}
