import type { PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { rankItems } from "../filter-rank.ts";
import { inputTrace } from "../input-trace.ts";
import { isAimedAt, usePadAction } from "../pad.ts";
import { useTheme } from "../theme.ts";

export interface PickerItem {
	label: string;
	description?: string;
}

/**
 * What a picker can show about the highlighted row when the caller has more to
 * say than a one-line description. The dialog does not interpret it: a session
 * preview and any future preview are the same panel, and the loading question
 * (where the lines come from) stays with the caller.
 */
export interface PickerPreview {
	/** The item's own name, when it has one — a session title, say. */
	title?: string;
	lines: string[];
	/** What the preview left out, or why it is short. */
	notice?: string;
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
	/**
	 * Loads a preview for one of the caller's rows. With it, Space opens a
	 * preview panel for the highlighted row and arrows reload it; without it,
	 * Space is an ordinary filter character and the panel never appears.
	 */
	preview?: (originalIndex: number) => Promise<PickerPreview | null>;
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
 * Esc cancels. Typing filters the list by label and description; the indices
 * handed back are the caller's indices, not positions in the filtered view.
 *
 * A pad moves and resolves the same way, through the same two helpers — the
 * highlight a thumb moves and the highlight an arrow key moves are the same
 * highlight, and a caller previewing it (the theme picker) must not be able to
 * tell which one moved it.
 */
export function ListPickerDialog({
	title,
	items,
	initialIndex,
	resolve,
	onHighlight,
	onCancel,
	preview: loadPreview,
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
	/**
	 * The stepping truth behind `selected`, which exists to paint. One read can
	 * carry several keys — a held key's autorepeat, or a burst of presses the
	 * terminal coalesced — and the dispatcher runs them all before React has
	 * committed the row the first of them asked for. A step computed from the
	 * rendered value would read the same position every time and collapse the
	 * whole burst into one move; every action steps from this ref instead.
	 */
	const selectedRef = useRef(selected);
	const [query, setQuery] = useState("");
	/** The filter the next key must see, not the one the last render painted. */
	const queryRef = useRef("");
	/** The original index last reported to `onHighlight`, for de-duplicating. */
	const highlightedRef = useRef(selected);
	/** Whether the preview panel is up. A ref for the same reason as the others: a burst of keys must see the state the first key left. */
	const previewOpenRef = useRef(false);
	const [previewOpen, setPreviewOpen] = useState(false);
	/** Undefined while loading, null when the caller has nothing, else the preview. */
	const [previewContent, setPreviewContent] = useState<PickerPreview | null | undefined>(undefined);
	/** Which load the panel is showing; a slow answer for an old row must not land. */
	const previewRequestRef = useRef(0);

	/**
	 * Matching positions in `items`, in display order. Recomputed per call
	 * rather than memoized: these lists are short, and the key handler needs the
	 * result for the query it just accepted, before React has re-rendered.
	 */
	const matchesFor = (value: string): number[] =>
		rankItems(items, value, (item) => [item.label, item.description ?? ""]);
	const matches = matchesFor(query);

	const cancel = () => {
		inputTrace("picker.cancel", { query: queryRef.current });
		onCancel?.();
		resolve(null);
	};

	/** The caller's index for the highlighted row, or undefined when none. */
	const chosen = (): number | undefined => matchesFor(queryRef.current)[selectedRef.current];

	/** Take the preview panel down, and make any answer still in flight miss. */
	const closePreview = (): void => {
		previewOpenRef.current = false;
		previewRequestRef.current++;
		setPreviewOpen(false);
	};

	/** Ask for the highlighted row's preview and keep only the newest answer. */
	const loadPreviewFor = (originalIndex: number | undefined): void => {
		const request = ++previewRequestRef.current;
		if (originalIndex === undefined || !loadPreview) {
			setPreviewContent(null);
			return;
		}
		setPreviewContent(undefined);
		void loadPreview(originalIndex).then(
			(result) => {
				if (request === previewRequestRef.current) setPreviewContent(result);
			},
			() => {
				if (request === previewRequestRef.current) setPreviewContent(null);
			},
		);
	};

	const togglePreview = (): void => {
		if (previewOpenRef.current) {
			closePreview();
			return;
		}
		previewOpenRef.current = true;
		setPreviewOpen(true);
		loadPreviewFor(chosen());
		inputTrace("picker.preview", { index: chosen() });
	};

	/** Move the highlight, wrapping, and tell whoever is previewing it. */
	const step = (delta: number): void => {
		const current = matchesFor(queryRef.current);
		if (current.length === 0) return;
		const next = (((selectedRef.current + delta) % current.length) + current.length) % current.length;
		selectedRef.current = next;
		setSelected(next);
		const original = current[next];
		if (original !== undefined) {
			highlightedRef.current = original;
			onHighlight?.(original);
			// The preview follows the highlight, like the theme preview does: the
			// row being looked at is the row the panel is about.
			if (previewOpenRef.current) loadPreviewFor(original);
		}
		inputTrace("picker.step", { delta, to: next, items: current.length });
	};

	/**
	 * Accept a new query and put the highlight back at the top of the result.
	 * The highlight preview (the theme picker) follows the filtered list, but
	 * only when the row it points at actually changed — typing a letter that
	 * keeps the same first match should not re-apply a theme.
	 */
	const applyQuery = (next: string): void => {
		// Typing is a statement about the list, not about the preview: the panel
		// goes away rather than showing a row that is no longer highlighted.
		if (previewOpenRef.current) closePreview();
		queryRef.current = next;
		setQuery(next);
		selectedRef.current = 0;
		setSelected(0);
		const nextMatches = matchesFor(next);
		const original = nextMatches[0];
		if (original !== undefined && original !== highlightedRef.current) {
			highlightedRef.current = original;
			onHighlight?.(original);
		}
		inputTrace("picker.filter", { chars: next.length, matches: nextMatches.length });
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
			case "confirm": {
				const index = chosen();
				if (index === undefined) return true;
				inputTrace("picker.resolve", { index, via: "pad", query: queryRef.current });
				resolve(index);
				return true;
			}
			case "cancel":
				// Same two-stage Esc: the panel is the thing on top, so it is the
				// thing the key closes first.
				if (previewOpenRef.current) closePreview();
				else cancel();
				return true;
			default:
				return false;
		}
	});

	useInput((input, key) => {
		// What the picker actually saw, for the `LBB_INPUT_TRACE` log: the first
		// question about keys that "do nothing" is whether any of them arrived
		// here at all, and the second is what they were parsed as.
		inputTrace("picker.input", {
			input: JSON.stringify(input),
			up: key.upArrow,
			down: key.downArrow,
			ret: key.return,
			esc: key.escape,
			query: queryRef.current,
		});
		if (items.length === 0) {
			if (key.escape || key.return) cancel();
			return;
		}
		if (key.escape) {
			// Two stages: Esc closes the preview panel first, and a second press
			// leaves the list. Cancelling both at once would make the panel a
			// trap — the one key that got the user in would take the list away.
			if (previewOpenRef.current) closePreview();
			else cancel();
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
			const index = chosen();
			if (index === undefined) return;
			inputTrace("picker.resolve", { index, via: "key", query: queryRef.current });
			resolve(index);
			return;
		}
		// Space previews only while the query is empty. With a query it is text
		// like any other character — a search field that eats spaces cannot
		// search for a phrase.
		if (input === " " && queryRef.current === "" && loadPreview) {
			togglePreview();
			return;
		}
		if (key.ctrl && input === "u") {
			if (queryRef.current) applyQuery("");
			return;
		}
		if (key.backspace || key.delete) {
			const characters = Array.from(queryRef.current);
			if (characters.length > 0) applyQuery(characters.slice(0, -1).join(""));
			return;
		}
		// Everything that produces text is a filter character. Ctrl and Meta
		// combinations are commands; Tab is the prompt's completion key and is
		// not a character a list should search for.
		if (!key.ctrl && !key.meta && !key.tab && input.length > 0) {
			applyQuery(queryRef.current + input);
		}
	});

	if (items.length === 0) return null;

	// Scroll window: keep `selected` inside VISIBLE_ROWS rows of the matches.
	const start = Math.max(0, Math.min(selected - (VISIBLE_ROWS - 1), matches.length - VISIBLE_ROWS));
	const visible = matches.slice(start, start + VISIBLE_ROWS);

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				{title}
			</Text>
			{query ? (
				<Text color={theme.textMuted}>
					Search: {query}
					{matches.length > 0 ? ` · ${matches.length} match${matches.length === 1 ? "" : "es"}` : ""}
				</Text>
			) : null}
			<Box flexDirection="column" marginTop={1}>
				{matches.length === 0 ? (
					<Text dimColor>No matches</Text>
				) : (
					visible.map((originalIndex, row) => {
						const item = items[originalIndex];
						if (!item) return null;
						const isSelected = start + row === selected;
						return (
							// Keyed by the original index, not the row: filtering changes
							// which item a row shows, and a key that stayed behind would
							// repaint one item's text with another's state. Labels can also
							// repeat (two themes with the same name), so the label is not a
							// key either.
							<Text key={`row-${originalIndex}`} color={isSelected ? theme.selection : theme.textMuted}>
								{isSelected ? `${theme.marks.selected} ` : "  "}
								{item.label}
								{item.description ? ` — ${item.description}` : ""}
							</Text>
						);
					})
				)}
				{matches.length > VISIBLE_ROWS && (
					<Text dimColor>
						{start + 1}-{Math.min(start + VISIBLE_ROWS, matches.length)} of {matches.length}
					</Text>
				)}
			</Box>
			{previewOpen ? (
				<Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={theme.border} paddingX={1}>
					<Text color={theme.accent} bold>
						{previewContent?.title ?? "Preview"}
					</Text>
					{previewContent === undefined ? (
						<Text dimColor>Loading preview…</Text>
					) : previewContent === null ? (
						<Text dimColor>Preview unavailable.</Text>
					) : previewContent.lines.length === 0 ? (
						<Text dimColor>No messages to preview.</Text>
					) : (
						previewContent.lines.map((line, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: preview lines are positional and never reordered
							<Text key={`preview-${index}`} color={theme.textMuted}>
								{line}
							</Text>
						))
					)}
					{previewContent?.notice ? <Text dimColor>{previewContent.notice}</Text> : null}
					<Text dimColor>Esc closes preview</Text>
				</Box>
			) : null}
			<Box marginTop={1}>
				{/* The pad's two answers, named next to the keyboard's: a picker opened
				    by a controller is a picker a controller has to be able to leave. */}
				<Text dimColor>
					{loadPreview && !query ? (previewOpen ? "space close preview · " : "space preview · ") : ""}
					type to filter · ↑/↓ select · Enter choose · Esc cancel
					{pad ? " · ✕ choose · ○ cancel" : ""}
				</Text>
			</Box>
		</Box>
	);
}
