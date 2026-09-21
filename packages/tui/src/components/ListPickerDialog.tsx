import type { PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { isAimedAt, usePadAction } from "../pad.ts";
import { useTheme } from "../theme.ts";

export interface PickerItem {
	label: string;
	description?: string;
}

export interface ListPickerState {
	title: string;
	items: PickerItem[];
	/**
	 * The row to open on, for a list that has a current one (the theme picker
	 * opens on the configured theme). Without it the highlight starts at the top
	 * and Enter takes the first entry, which for a picker that writes its answer
	 * down is a silent change the user never asked for.
	 *
	 * Opening is not a highlight move: `onHighlight` is not called for it.
	 */
	initialIndex?: number;
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

export interface ListPickerDialogProps extends ListPickerState {
	/** The controller, when there is one. */
	pad?: PadBridge;
}

/**
 * A scrollable pick-one dialog (session resume, model switch). Modeled on
 * QuestionDialog but for a single potentially long list: ↑/↓ move with
 * wrapping, the window scrolls to keep the selection visible, Enter resolves,
 * Esc cancels. A pad moves and resolves the same way, through the same two
 * helpers — the highlight a thumb moves and the highlight an arrow key moves are
 * the same highlight, and a caller previewing it (the theme picker) must not be
 * able to tell which one moved it.
 */
export function ListPickerDialog({
	title,
	items,
	initialIndex,
	resolve,
	onHighlight,
	onCancel,
	pad,
}: ListPickerDialogProps) {
	const theme = useTheme();
	// A whole number first: a fraction highlights no row at all (`index === 1.9`
	// is false for every row) and the caller is handed an index no item has to
	// look up. NaN does not even move afterwards — `(NaN + 1) % items.length` is
	// NaN — so every arrow key is spent going nowhere; it has no position to
	// clamp, so it opens at the top. Everything else is clamped, because an index
	// computed against a list that has since shrunk must still open on a row
	// rather than on none.
	const [selected, setSelected] = useState(() => {
		const asked = initialIndex ?? 0;
		const whole = Number.isNaN(asked) ? 0 : Math.trunc(asked);
		return Math.min(Math.max(whole, 0), Math.max(items.length - 1, 0));
	});

	const cancel = () => {
		onCancel?.();
		resolve(null);
	};

	/** Move the highlight, wrapping, and tell whoever is previewing it. */
	const step = (delta: number): void => {
		if (items.length === 0) return;
		const next = (((selected + delta) % items.length) + items.length) % items.length;
		setSelected(next);
		onHighlight?.(next);
	};

	const openedAt = useRef(Date.now());
	usePadAction(pad, (action) => {
		// A release ends a press that was already answered, and a press that began
		// before this list appeared was aimed at the screen before it — the mapper
		// carries every press's age so this question has an answer.
		if (action.phase === "release" || !isAimedAt(action, openedAt.current)) return false;
		if (items.length === 0) {
			// Nothing to choose from, so the only thing a pad can do is leave —
			// the same two answers the keyboard has for an empty list.
			if (action.kind === "cancel" || action.kind === "confirm") {
				cancel();
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
			case "page-prev":
				step(-VISIBLE_ROWS);
				return true;
			case "page-next":
				step(VISIBLE_ROWS);
				return true;
			case "confirm":
				resolve(selected);
				return true;
			case "cancel":
				cancel();
				return true;
			default:
				return false;
		}
	});

	useInput((_input, key) => {
		if (items.length === 0) {
			if (key.escape || key.return) cancel();
			return;
		}
		if (key.escape) {
			cancel();
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
						// Keyed by row, not by label: the labels are theme names, and two of
						// them can be the same one — two files that call themselves the same
						// thing, or a file named after a built-in. React on duplicate keys
						// is not a cosmetic warning; the behavior is unsupported, and the row
						// that goes missing would be a theme.
						<Text key={`row-${index}`} color={isSelected ? theme.selection : theme.textMuted}>
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
				{/* The pad's two answers, named next to the keyboard's: a picker opened
				    by a controller is a picker a controller has to be able to leave. */}
				<Text dimColor>↑/↓ select · Enter choose · Esc cancel{pad ? " · ✕ choose · ○ cancel" : ""}</Text>
			</Box>
		</Box>
	);
}
