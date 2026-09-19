import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useTheme } from "../theme.ts";

export interface PickerItem {
	label: string;
	description?: string;
}

export interface ListPickerState {
	title: string;
	items: PickerItem[];
	/**
	 * Called when the highlight moves — and only then, never on open. A caller
	 * that previews the highlighted choice (the theme picker does, so the choice
	 * is made by looking at it) must not apply something the user has not reached
	 * yet: opening the list would otherwise silently switch the theme to whatever
	 * happens to be first.
	 */
	onHighlight?: (index: number) => void;
	/** Called before resolving null, so a preview can be undone. */
	onCancel?: () => void;
	/** Resolves with the chosen index, or null when the user cancelled. */
	resolve: (index: number | null) => void;
}

/** How many rows are visible before the list scrolls. */
const VISIBLE_ROWS = 8;

/**
 * A scrollable pick-one dialog (session resume, model switch). Modeled on
 * QuestionDialog but for a single potentially long list: ↑/↓ move with
 * wrapping, the window scrolls to keep the selection visible, Enter resolves,
 * Esc cancels.
 */
export function ListPickerDialog({ title, items, resolve, onHighlight, onCancel }: ListPickerState) {
	const theme = useTheme();
	const [selected, setSelected] = useState(0);

	useInput((_input, key) => {
		const cancel = () => {
			onCancel?.();
			resolve(null);
		};
		if (items.length === 0) {
			if (key.escape || key.return) cancel();
			return;
		}
		if (key.escape) {
			cancel();
			return;
		}
		if (key.upArrow) {
			const next = (selected + items.length - 1) % items.length;
			setSelected(next);
			onHighlight?.(next);
			return;
		}
		if (key.downArrow) {
			const next = (selected + 1) % items.length;
			setSelected(next);
			onHighlight?.(next);
			return;
		}
		if (key.return) resolve(selected);
	});

	if (items.length === 0) return null;

	// Scroll window: keep `selected` inside VISIBLE_ROWS rows.
	const start = Math.max(0, Math.min(selected - (VISIBLE_ROWS - 1), items.length - VISIBLE_ROWS));
	const visible = items.slice(start, start + VISIBLE_ROWS);

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				{title}
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{visible.map((item, row) => {
					const index = start + row;
					const isSelected = index === selected;
					return (
						<Text key={item.label} color={isSelected ? theme.selection : theme.textMuted}>
							{isSelected ? `${theme.marks.selected} ` : "  "}
							{item.label}
							{item.description ? ` — ${item.description}` : ""}
						</Text>
					);
				})}
				{items.length > VISIBLE_ROWS && (
					<Text dimColor>
						{start + 1}-{Math.min(start + VISIBLE_ROWS, items.length)} of {items.length}
					</Text>
				)}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>↑/↓ select · Enter choose · Esc cancel</Text>
			</Box>
		</Box>
	);
}
