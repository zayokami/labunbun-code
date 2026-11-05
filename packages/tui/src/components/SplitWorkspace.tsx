/**
 * The split view: the transcript on the left, the watch panel on the right,
 * the prompt still under both.
 *
 * This is what "split screen" can honestly mean in a terminal whose history
 * lives in the scrollback. The sealed rows are not re-layoutable (measured:
 * `docs/dev/split-pane-design.md`), so the left pane is not the scrollback —
 * it is a window over the same `entries` the `Ctrl+O` transcript screen draws,
 * rendered fresh by the app every frame. The right pane is the watch panel,
 * with its own width and height instead of the terminal's. The result is one
 * live row of panes the app owns, above a prompt that keeps working: the
 * thing a reader actually asks for, without the alternate screen's price.
 *
 * What it deliberately is not: a second view of history. The transcript pane
 * shows the tail of the conversation, scrollable with PgUp/PgDn, and says
 * which entries it is showing. The scrollback above the frame is still the
 * terminal's, and still full width — no row is reprinted to pretend otherwise.
 *
 * ## Why the left pane is a line model, not `<MessageList>`
 *
 * Ink 7.1.1 mis-renders a nested box whose content is taller than its fixed
 * height: rows merge ("0 fail" and "pass" landing on one line), every other
 * line disappears, and `justifyContent="flex-end"` makes it worse. A minimal
 * reproduction lives beside this file in the history of `docs/dev/split-pane-
 * design.md`; the finding that matters is that content sliced to *exactly* the
 * rows available renders cleanly. So this pane never clips: {@link
 * buildConversation} wraps, tails, and pads the entries itself to produce
 * exactly `rows` single-row lines, and the component renders that list with no
 * overflow to clip. The line model is also why the pane can promise a row
 * count at all — a test can assert it without a terminal.
 *
 * The layout decisions live in pure functions so they can be tested without a
 * terminal: {@link workspaceFits} says whether the terminal has room for two
 * columns, {@link watchColumnWidth} allocates the right one, and
 * {@link workspaceHeight} leaves the status block and the prompt their rows.
 * The frame must never reach the viewport height on Windows (ink stops
 * diffing and starts clearing, `docs/dev/split-pane-design.md`), which is why
 * the height is spent from `rows - 1` and the bottom block is reserved.
 */
import { Box, Text } from "ink";
import { ASSISTANT_DOT, RESULT_INDENT, RESULT_LEAD, TOOL_DOT } from "../figures.ts";
import { type Theme, useTheme } from "../theme.ts";
import type { UiBackgroundShell, UiEntry, UiTask } from "../ui-state.ts";
import { looksLikeDiff, resultLineColor, stripAnsi } from "./MessageList.tsx";
import { ICONS } from "./TaskStrip.tsx";
import { WatchPanel, type WatchSelection } from "./WatchPanel.tsx";

/**
 * The narrowest terminal that can hold two columns with a readable left pane.
 * Below this the REPL keeps the inline watch panel instead — the same key,
 * one column, no pretend split.
 */
export const WORKSPACE_MIN_COLUMNS = 88;

/** The shortest terminal worth splitting; below it the inline panel is better. */
export const WORKSPACE_MIN_HEIGHT = 12;

/**
 * Rows the split view must leave below itself: the status block with its
 * detail row (two), the prompt box (three), its hint (one), and the blank line
 * under it (one) — plus one spare for a queued-message preview or the Ctrl+C
 * hint. Itemized rather than tuned invisibly, for the same reason
 * `WATCH_PANEL_RESERVE_ROWS` is.
 */
export const WORKSPACE_BOTTOM_ROWS = 8;

/** Rows the panes may occupy on a terminal of `rows` rows. */
export function workspaceHeight(rows: number): number {
	return Math.max(0, rows - 1 - WORKSPACE_BOTTOM_ROWS);
}

/**
 * The right column's width, or 0 when the terminal is too narrow to split.
 *
 * A share rather than a constant, with both ends clamped: the watch panel is
 * unreadable below 32 columns, and the transcript is unreadable if it gives
 * more than the right pane's share away on a wide screen.
 */
export function watchColumnWidth(columns: number): number {
	if (columns < WORKSPACE_MIN_COLUMNS) return 0;
	// 40 is the panel's own floor: its poll note is 36 columns of text, and the
	// note is where the cycle key is advertised — a pane too narrow to finish
	// that sentence would hide the one key the panel exists to make findable.
	return Math.min(56, Math.max(40, Math.floor(columns * 0.38)));
}

/** Whether the terminal can show both panes at once. */
export function workspaceFits(columns: number, rows: number): boolean {
	return watchColumnWidth(columns) > 0 && workspaceHeight(rows) >= WORKSPACE_MIN_HEIGHT;
}

/**
 * The blank column between the panes. Two borders drawn one against the other
 * read as a single glyph; a cell of air is what makes them two panes.
 */
export const SPLIT_GAP = 1;

/**
 * The two panes' geometry from the terminal's size. The left pane's body is its
 * width minus two border columns and two padding columns, and its height minus
 * the header and footer rows; the page keys and the renderer both measure from
 * this one function, so a page can never be a different size than the screen.
 */
export function splitBodySize(
	columns: number,
	height: number,
): { watchWidth: number; leftWidth: number; bodyWidth: number; bodyRows: number } {
	const watchWidth = Math.max(1, watchColumnWidth(columns));
	const leftWidth = Math.max(1, columns - watchWidth - SPLIT_GAP);
	return {
		watchWidth,
		leftWidth,
		bodyWidth: Math.max(8, leftWidth - 4),
		bodyRows: Math.max(1, height - 4),
	};
}

/**
 * A scrolled conversation pane. `end` is the entry just past the pane's bottom
 * — an index, not a distance from the newest, so entries arriving below do not
 * slide the page out from under a reader. `total` is how many entries existed
 * when the reader left the tail; it is the baseline for "N new".
 */
export interface WorkspaceScroll {
	end: number;
	total: number;
}

/**
 * One page-key press. Up pins the pane a page earlier; down walks back toward
 * the newest and unpins at the tail, where the pane follows new entries again.
 * A page never skips the whole conversation: it is measured from the entries
 * currently on screen, so a press moves roughly one screenful and no entry is
 * passed over unseen.
 */
export function scrollWorkspace(
	current: WorkspaceScroll | null,
	entryCount: number,
	page: number,
	direction: "up" | "down",
): WorkspaceScroll | null {
	const step = Math.max(1, Math.floor(page));
	if (direction === "down") {
		if (!current) return null;
		return current.end + step >= entryCount ? null : { end: current.end + step, total: current.total };
	}
	const base = current?.end ?? entryCount;
	const next = Math.max(0, base - step);
	if (entryCount === 0 || next >= entryCount) return null;
	return { end: next, total: current?.total ?? entryCount };
}

/**
 * The rows the split's compact task strip needs: one blank separator, one
 * header, and up to three unfinished tasks. `0` when there is nothing to show.
 * Itemized so the right column's two children can never exceed its height.
 */
export function taskStripRows(tasks: UiTask[] | undefined): number {
	if (!tasks || tasks.length === 0) return 0;
	return 2 + Math.min(3, tasks.filter((task) => task.status !== "completed").length);
}

/** One styled run of a pane row. A row with one segment is the common case. */
export interface PaneSegment {
	text: string;
	color?: string;
	dim?: boolean;
	bold?: boolean;
}

/** One rendered row of the conversation pane. Always exactly one terminal row. */
export interface PaneLine {
	segments: PaneSegment[];
}

/** Printable width of one code point, near enough for terminal layout. */
function charWidth(code: number): number {
	// Combining marks and zero-width joiners take no cell of their own.
	if (
		code === 0x200b ||
		code === 0x200c ||
		code === 0x200d ||
		code === 0xfeff ||
		(code >= 0x0300 && code <= 0x036f) ||
		(code >= 0x1ab0 && code <= 0x1aff) ||
		(code >= 0x1dc0 && code <= 0x1dff) ||
		(code >= 0x20d0 && code <= 0x20ff) ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		(code >= 0xfe20 && code <= 0xfe2f)
	) {
		return 0;
	}
	// C0/C1 control bytes have already been stripped; any that survive take no cell.
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
	// East Asian wide and fullwidth ranges, plus the emoji blocks a terminal
	// renders two cells wide. An underestimate here is safe — the row truncates
	// rather than wraps — but a CJK transcript laid out as half-width would read
	// as broken spacing, so the common ranges are listed.
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** The columns `text` occupies on screen. */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
	return width;
}

/** The prefix of `text` that fits in `width` columns, at a code-point boundary. */
function sliceToWidth(text: string, width: number): string {
	let used = 0;
	let end = 0;
	for (const char of text) {
		const next = used + charWidth(char.codePointAt(0) ?? 0);
		if (next > width) break;
		used = next;
		end += char.length;
	}
	return text.slice(0, end);
}

/**
 * Where to break a line that does not fit: after the last space that still
 * fits, or at the last code point that does. CJK text has no spaces, so the
 * second case is not a fallback there — it is the normal path.
 */
function breakPoint(text: string, limit: number): number {
	let used = 0;
	let lastSpace = -1;
	let end = 0;
	for (const char of text) {
		const next = used + charWidth(char.codePointAt(0) ?? 0);
		if (next > limit) break;
		if (char === " ") lastSpace = end;
		used = next;
		end += char.length;
	}
	if (end >= text.length) return text.length;
	if (lastSpace > 0) return lastSpace;
	return Math.max(1, end);
}

/**
 * Wrap `text` to `width` columns, prefixed on the first line and on each
 * continuation. Returns raw strings: callers attach the style, and tests can
 * assert the exact rows.
 */
export function wrapText(text: string, width: number, firstLead = "", restLead = ""): string[] {
	const lines: string[] = [];
	// Tabs are layout, not content: expanding them here keeps every later width
	// computation honest.
	const paragraphs = text.replace(/\t/g, "  ").split("\n");
	let started = false;
	for (const paragraph of paragraphs) {
		let rest = paragraph.trimEnd();
		if (rest === "") {
			// A blank line between paragraphs is part of the paragraph break; one
			// at the very start would only push the first row off the pane.
			if (started) lines.push("");
			continue;
		}
		let first = !started;
		while (rest.length > 0) {
			const lead = first ? firstLead : restLead;
			const available = Math.max(1, width - displayWidth(lead));
			if (displayWidth(rest) <= available) {
				lines.push(lead + rest);
				break;
			}
			const cut = breakPoint(rest, available);
			lines.push((lead + rest.slice(0, cut)).trimEnd());
			rest = rest.slice(cut).trimStart();
			first = false;
			started = true;
		}
		started = true;
	}
	return lines;
}

function blankLine(): PaneLine {
	return { segments: [{ text: " " }] };
}

/** One styled single-segment line. */
function styledLine(text: string, style: Omit<PaneSegment, "text">): PaneLine {
	return { segments: [{ text: text === "" ? " " : text, ...style }] };
}

function wrapStyled(
	text: string,
	width: number,
	firstLead: string,
	restLead: string,
	style: Omit<PaneSegment, "text">,
): PaneLine[] {
	return wrapText(text, width, firstLead, restLead).map((line) => styledLine(line, style));
}

/** Cut a run of segments to `width` columns, ending in an ellipsis when cut. */
function truncateSegments(segments: PaneSegment[], width: number): PaneSegment[] {
	const out: PaneSegment[] = [];
	let left = width;
	for (const segment of segments) {
		if (segment.text === "") continue;
		if (left <= 0) break;
		const used = displayWidth(segment.text);
		if (used <= left) {
			out.push(segment);
			left -= used;
			continue;
		}
		out.push({ ...segment, text: `${sliceToWidth(segment.text, Math.max(0, left - 1))}…` });
		left = 0;
	}
	return out.length > 0 ? out : [{ text: " " }];
}

/** The call row of a tool entry: dot, name, and the one-line input preview. */
function toolCallLine(entry: Extract<UiEntry, { kind: "toolUse" }>, theme: Theme, width: number): PaneLine {
	const state =
		entry.resultText === undefined ? "running" : entry.interrupted ? "interrupted" : entry.isError ? "error" : "done";
	const dotColor = state === "interrupted" ? theme.warning : state === "error" ? theme.error : theme.toolName;
	return {
		segments: truncateSegments(
			[
				{ text: `${TOOL_DOT} `, color: dotColor, dim: state === "running" },
				{ text: entry.toolName, color: theme.toolName, bold: true },
				{ text: entry.inputPreview ? ` (${entry.inputPreview})` : "", color: theme.toolArgs },
			],
			width,
		),
	};
}

/**
 * A tool result as rows, first line under the `⎿` lead and the rest indented
 * beneath it, each line colored by what it says (a diff keeps its own palette,
 * an error keeps the error color).
 *
 * `maxLines` is a tail: an output taller than the pane shows its end, because
 * the end is where an error and a summary live. The result is sliced from the
 * source *before* wrapping, so a 16 000-character output costs a screenful of
 * work, not a page of allocation.
 */
function resultBlockLines(
	text: string,
	width: number,
	theme: Theme,
	maxLines: number,
	options: { isError?: boolean; interrupted?: boolean },
): PaneLine[] {
	const bodyWidth = Math.max(1, width - displayWidth(RESULT_LEAD));
	const raw = stripAnsi(text);
	const source = raw === "" ? "(no output)" : raw;
	// Only the tail can survive the slice, so only the tail is wrapped. One
	// extra line of characters covers a wrap boundary without guessing.
	const bounded = bodyWidth * (maxLines + 1);
	const tail = source.length > bounded ? `…\n${source.slice(source.length - bounded)}` : source;
	const diff = looksLikeDiff(tail.split("\n").slice(0, 40));
	const wrapped = wrapText(tail, width, RESULT_LEAD, RESULT_INDENT);
	const lines = wrapped.slice(-Math.max(1, maxLines)).map((line, index) => {
		const body = line.startsWith(RESULT_LEAD)
			? line.slice(RESULT_LEAD.length)
			: line.startsWith(RESULT_INDENT)
				? line.slice(RESULT_INDENT.length)
				: line;
		const first = index === 0;
		const lead = first ? RESULT_LEAD : RESULT_INDENT;
		const color = options.interrupted ? theme.warning : resultLineColor(body, options.isError, diff, theme);
		const bold = options.isError && !options.interrupted ? theme.bold.error : undefined;
		// The error mark goes behind the lead — `  ⎿  ✗ text` — so it reads as the
		// state of the output, not of the call. It is counted against the width
		// here rather than widening the line: the body was wrapped for the bare
		// lead, and an extra two columns would be one truncation away from losing
		// the sentence the mark is introducing.
		const mark = first && options.isError && !options.interrupted ? `${theme.marks.error} ` : "";
		const prefix = `${lead}${mark}`;
		const room = Math.max(0, width - displayWidth(prefix));
		return styledLine(prefix + sliceToWidth(body, room), { color, bold });
	});
	if (options.interrupted) {
		lines.push(styledLine(`${RESULT_INDENT}(interrupted; output is partial)`, { color: theme.warning, dim: true }));
	}
	return lines.slice(-Math.max(1, maxLines));
}

/** The rows one entry contributes, tail-bounded to `maxLines`. */
function entryLines(
	entry: UiEntry,
	theme: Theme,
	width: number,
	maxLines: number,
	liveOutputs?: Record<string, string>,
): PaneLine[] {
	const limited = Math.max(1, maxLines);
	switch (entry.kind) {
		case "user":
			return wrapStyled(stripAnsi(entry.text), width, entry.steered ? "≫ " : "> ", "  ", {
				color: theme.userInput,
				bold: true,
			}).slice(-limited);
		case "assistant": {
			const lines = wrapStyled(stripAnsi(entry.text), width, `${ASSISTANT_DOT} `, "  ", { color: theme.text });
			if (entry.incomplete) {
				lines.push(styledLine("(response ended early; output is partial)", { color: theme.warning }));
			}
			return lines.slice(-limited);
		}
		case "toolUse": {
			const call = toolCallLine(entry, theme, width);
			if (entry.resultText !== undefined) {
				return [call, ...resultBlockLines(entry.resultText, width, theme, limited - 1, entry)];
			}
			const live = liveOutputs?.[entry.callId];
			if (live) {
				return [call, ...resultBlockLines(live, width, theme, Math.max(1, limited - 1), {})];
			}
			return [call];
		}
		case "error":
			return wrapStyled(stripAnsi(entry.text), width, `${theme.marks.error} `, "  ", {
				color: theme.error,
				bold: theme.bold.error,
			}).slice(-limited);
		case "info":
			return wrapStyled(entry.text, width, "", "", { color: theme.textMuted }).slice(-limited);
	}
}

/**
 * What the left pane shows: exactly `rows` one-column-tall rows, the newest
 * entry at the bottom, backed off by `offset` entries.
 *
 * Blocks are collected newest-first until the pane is full, so a long
 * conversation costs one pane of wrapping per frame rather than all of it.
 * The streaming answer is a trailing block only at offset 0: scrolled back,
 * the reader is looking at history, and the answer still arriving would be
 * below the window they chose.
 */
export interface ConversationView {
	lines: PaneLine[];
	/** First entry visible, or `lastEntry` when the pane is empty. */
	firstEntry: number;
	/** One past the last entry visible before any streaming block. */
	lastEntry: number;
}

export function buildConversation({
	entries,
	theme,
	width,
	rows,
	offset,
	streamingText,
	thinkingText,
	liveOutputs,
}: {
	entries: UiEntry[];
	theme: Theme;
	width: number;
	rows: number;
	offset: number;
	streamingText: string;
	thinkingText: string;
	liveOutputs?: Record<string, string>;
}): ConversationView {
	const paneRows = Math.max(1, Math.floor(rows));
	const paneWidth = Math.max(8, Math.floor(width));
	const total = entries.length;
	const end = Math.max(0, Math.min(total, total - Math.max(0, offset)));
	// Blocks are collected newest-first, then kept in display order. `index` is
	// the entry each block came from; the streaming block is -1, because it is
	// not in `entries` yet and must not be named in the header.
	const blocks: Array<{ index: number; lines: PaneLine[] }> = [];
	let built = 0;
	for (let index = end - 1; index >= 0 && built < paneRows; index--) {
		const room = Math.max(1, paneRows - built);
		const block = entryLines(entries[index], theme, paneWidth, room, liveOutputs);
		if (block.length === 0) continue;
		blocks.unshift({ index, lines: block });
		built += block.length + 1;
	}
	if (offset === 0) {
		const stream: PaneLine[] = [];
		const text = stripAnsi(streamingText);
		if (text) {
			stream.push(...wrapStyled(text, paneWidth, `${ASSISTANT_DOT} `, "  ", { color: theme.text }));
		} else if (thinkingText) {
			stream.push(
				...wrapStyled(`… ${stripAnsi(thinkingText).slice(-200)}`, paneWidth, "", "", {
					color: theme.thinking,
					dim: true,
				}),
			);
		}
		if (stream.length > 0) {
			blocks.push({ index: -1, lines: stream });
			built += stream.length;
		}
	}
	// Drop whole old entries while anything above would still be cut. Slicing
	// lines blindly would leave a result row at the top with the call row it
	// answers cut away; dropping the entry costs at most a few blank rows at the
	// top, and only when the pane was already going to be full.
	let joinedLength = blocks.reduce((sum, block) => sum + block.lines.length, 0) + Math.max(0, blocks.length - 1);
	while (blocks.length > 1 && joinedLength > paneRows) {
		joinedLength -= blocks[0].lines.length + 1;
		blocks.shift();
	}
	const joined: PaneLine[] = [];
	for (const block of blocks) {
		if (joined.length > 0) joined.push(blankLine());
		joined.push(...block.lines);
	}
	const lines = joined.slice(-paneRows);
	while (lines.length < paneRows) lines.unshift(blankLine());
	const firstEntry = blocks.find((block) => block.index >= 0)?.index ?? end;
	return { lines, firstEntry, lastEntry: end };
}

export function SplitWorkspace({
	entries,
	liveOutputs,
	streamingText,
	thinkingText,
	shells,
	selection = null,
	subagentLines = [],
	statusLines = [],
	tasks,
	columns,
	height,
	offset,
	newBelow = 0,
}: {
	entries: UiEntry[];
	liveOutputs?: Record<string, string>;
	streamingText: string;
	thinkingText: string;
	shells: UiBackgroundShell[];
	selection?: WatchSelection | null;
	subagentLines?: string[];
	statusLines?: string[];
	tasks?: UiTask[];
	columns: number;
	/** Total height of the pane row, borders included. */
	height: number;
	/** Entries scrolled back from the newest; 0 follows the tail. */
	offset: number;
	/** Entries that arrived after the reader left the tail. */
	newBelow?: number;
}) {
	const theme = useTheme();
	const { watchWidth, leftWidth, bodyWidth, bodyRows } = splitBodySize(columns, height);

	// The task strip is worth its rows only when the watch panel still has a
	// usable body left; otherwise the right column is the panel alone. Its rows
	// are handed to it exactly, like the transcript pane's: two children whose
	// heights add up to the column's height cannot overflow it.
	const stripRows = taskStripRows(tasks);
	const showTasks = stripRows > 0 && height - stripRows >= 8;
	const watchHeight = showTasks ? height - stripRows : height;

	const { lines, firstEntry, lastEntry } = buildConversation({
		entries,
		theme,
		width: bodyWidth,
		rows: bodyRows,
		offset,
		streamingText,
		thinkingText,
		liveOutputs,
	});
	const scrolled = offset > 0;
	const range =
		entries.length === 0 || firstEntry >= lastEntry ? "" : ` ${firstEntry + 1}-${lastEntry} of ${entries.length}`;

	return (
		<Box flexDirection="row" height={height} flexShrink={0}>
			<Box
				width={leftWidth}
				height={height}
				flexShrink={0}
				flexDirection="column"
				borderStyle="round"
				borderColor={theme.border}
				paddingX={1}
			>
				<Text wrap="truncate">
					<Text bold color={theme.textMuted}>
						Conversation
					</Text>
					{range ? <Text dimColor>{range}</Text> : null}
					{scrolled ? <Text color={theme.warning}> · scrolled</Text> : null}
					{newBelow > 0 ? <Text color={theme.accent}> · {newBelow} new</Text> : null}
				</Text>
				{/* Exactly `bodyRows` rows, each truncated rather than wrapped if a
				    width estimate was off — Ink's clipping is the bug this avoids. */}
				<Box flexDirection="column" height={bodyRows} flexShrink={0}>
					{lines.map((line, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: pane rows are positional and rebuilt every frame
						<Text key={i} wrap="truncate">
							{line.segments.map((segment, j) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within one row
								<Text key={j} color={segment.color} dimColor={segment.dim} bold={segment.bold}>
									{segment.text}
								</Text>
							))}
						</Text>
					))}
				</Box>
				<Text dimColor wrap="truncate">
					PgUp/PgDn scroll · Esc close
				</Text>
			</Box>
			<Box width={SPLIT_GAP} flexShrink={0} />
			<Box width={watchWidth} height={height} flexShrink={0} flexDirection="column">
				<WatchPanel
					shells={shells}
					selection={selection}
					subagentLines={subagentLines}
					statusLines={statusLines}
					columns={watchWidth}
					height={watchHeight}
				/>
				{showTasks && tasks ? <CompactTaskStrip tasks={tasks} width={watchWidth} rows={stripRows} /> : null}
			</Box>
		</Box>
	);
}

/**
 * The task strip the right column can afford: one blank separator, a count, and
 * up to three unfinished tasks, each exactly one row. The frame's task strip
 * (with its border, active-form row and margin) is the inline layout's shape;
 * here the column is 40–56 columns wide and its height is a budget, so the
 * compact form trades decoration for rows the watch panel can use.
 */
function CompactTaskStrip({ tasks, width, rows }: { tasks: UiTask[]; width: number; rows: number }) {
	const theme = useTheme();
	const completed = tasks.filter((task) => task.status === "completed").length;
	const active = tasks.find((task) => task.status === "in_progress");
	const allDone = completed === tasks.length;
	const visible = tasks.filter((task) => task.status !== "completed").slice(0, Math.max(0, rows - 2));
	return (
		<Box flexDirection="column" width={width} height={rows} flexShrink={0}>
			<Text> </Text>
			<Text color={allDone ? theme.success : active ? theme.accent : theme.textMuted} wrap="truncate">
				{`Tasks ${completed}/${tasks.length}${active?.activeForm ? ` · ${active.activeForm}` : ""}`}
			</Text>
			{visible.map((task) => (
				<Text key={task.id} color={task.status === "in_progress" ? theme.accent : theme.pending} wrap="truncate">
					{`${ICONS[task.status]} #${task.id} ${task.subject}${task.owner ? ` · ${task.owner}` : ""}`}
				</Text>
			))}
		</Box>
	);
}
