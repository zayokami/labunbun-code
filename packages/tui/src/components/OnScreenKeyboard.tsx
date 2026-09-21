import { Box, Text } from "ink";
import { type OskCursor, oskClamp, oskLabel, oskPage } from "../osk.ts";
import { useTheme } from "../theme.ts";

export interface OnScreenKeyboardProps {
	/** Which page is up; wraps, so any integer is a page. */
	pageIndex: number;
	cursor: OskCursor;
	shift: boolean;
}

/**
 * The keyboard, drawn. Every cell is the same width — the selected one wears
 * brackets instead of a different colour — because the highlight has to survive
 * a terminal with no colours at all, which is the same terminal the tests run
 * against.
 */
export function OnScreenKeyboard({ pageIndex, cursor, shift }: OnScreenKeyboardProps) {
	const theme = useTheme();
	const page = oskPage(pageIndex);
	// Clamped before anything is drawn: a cursor that moved down from a long row
	// onto a short one has to land on a key, and the cell it lands on is the one
	// that wears the brackets.
	const at = oskClamp(page, cursor);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				On-screen keyboard · {page.name}
				{shift ? " · shift" : ""}
			</Text>
			<Box flexDirection="column">
				{page.rows.map((row, r) => (
					<Text key={row.map((key) => key.label).join("")}>
						{row.map((key, c) => {
							// A cell's identity is where it sits, not what it says: the same
							// character can appear twice on one page, and the two are the same
							// key only from the thumb's point of view.
							const cell = `${r}.${c}`;
							const selected = r === at.row && c === at.col;
							const label = oskLabel(key, shift);
							return (
								<Text key={cell} color={selected ? theme.selection : theme.textMuted} inverse={selected}>
									{selected ? `[${label}]` : ` ${label} `}
								</Text>
							);
						})}
					</Text>
				))}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>✕ type · ⏎ send · L1/R1 page · △ shift · □ backspace · ○ close</Text>
			</Box>
		</Box>
	);
}
