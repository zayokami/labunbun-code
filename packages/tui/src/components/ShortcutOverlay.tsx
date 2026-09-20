import { Box, Text, useWindowSize } from "ink";
import { SHORTCUT_TWO_COLUMN_MIN_COLUMNS, type ShortcutGroup, splitShortcutGroups } from "../shortcuts.ts";
import { useTheme } from "../theme.ts";

/**
 * The full key list, on `?`.
 *
 * The hint under the prompt can only afford a clause or two; this is where the
 * rest lives, including the commands the app layer registered. Width is read
 * from ink rather than `process.stdout` so a resize reflows it — the terminal
 * cannot be reflowed after the fact, so a layout that only fits the width it
 * started at gets worse the narrower the window becomes.
 */
export function ShortcutOverlay({
	groups,
	columns: measured,
}: {
	groups: ShortcutGroup[];
	/** Width, for a caller that has already measured it. Defaults to the terminal's. */
	columns?: number;
}) {
	const theme = useTheme();
	const { columns: windowColumns } = useWindowSize();
	const columns = measured ?? windowColumns;
	const layout = columns >= SHORTCUT_TWO_COLUMN_MIN_COLUMNS ? splitShortcutGroups(groups) : [groups];

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				Keyboard shortcuts
			</Text>
			<Box flexDirection="row">
				{layout.map((column, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the layout is a fixed pair of columns
					<Box key={i} flexDirection="column" marginRight={layout.length > 1 && i === 0 ? 4 : 0}>
						{column.map((group) => (
							<GroupView key={group.title} group={group} />
						))}
					</Box>
				))}
			</Box>
			<Text dimColor>Esc or ? to close</Text>
		</Box>
	);
}

/** One heading and its key rows, with the keys in a column of their own. */
function GroupView({ group }: { group: ShortcutGroup }) {
	const theme = useTheme();
	const width = Math.max(...group.rows.map(([keys]) => keys.length));
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color={theme.accent} bold>
				{group.title}
			</Text>
			{group.rows.map(([keys, what]) => (
				// Keyed by the row, not by the key name: one key can legitimately
				// appear twice in a group (Esc leaves insert *and* cancels a
				// selection), and duplicate keys make React drop rows.
				<Text key={`${keys} ${what}`} color={theme.text}>
					{"  "}
					<Text color={theme.textMuted}>{keys.padEnd(width)}</Text> {what}
				</Text>
			))}
		</Box>
	);
}
