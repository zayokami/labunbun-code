/**
 * What was typed while a turn was already running, shown above the prompt.
 *
 * The transcript already holds these messages — they were typed, they will be
 * sent — so this is not a second copy of them. It answers the question the
 * transcript cannot: *when*. A message queued behind a turn and a message sent
 * into it look identical once they land, and by then it is too late to tell.
 */
import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";
import type { QueuedMessage } from "../ui-state.ts";

/** Queued messages listed before the rest are counted instead. */
export const QUEUED_PREVIEW_ROWS = 3;

/** One queued message gets one line: a pasted paragraph must not own the screen. */
export const QUEUED_PREVIEW_CHARS = 72;

/** One line, folded and elided — the preview is a reminder, not the message. */
export function queuedPreview(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > QUEUED_PREVIEW_CHARS ? `${oneLine.slice(0, QUEUED_PREVIEW_CHARS - 1)}…` : oneLine;
}

/**
 * What the keys do *now*. Enter's meaning depends on whether the turn can take
 * a message mid-flight, so the hint has to say which one it is rather than
 * naming both and leaving the user to guess.
 *
 * `vim` is here for the same reason: there Escape is a mode key, so the prompt's
 * Escape never sends the buffer (see PromptInput) and the hint must not claim
 * it does — a legend that promises a key to be a mode toggle is worse than none.
 */
export function queuedHint(canSteer: boolean, vim = false): string {
	const enter = canSteer ? "Enter steer (at the next tool)" : "Enter queue (when this turn ends)";
	return `Tab queue · ${enter} · Esc interrupt${vim ? "" : " & send"}`;
}

export function QueuedMessages({
	queued,
	canSteer,
	vim = false,
}: {
	queued: QueuedMessage[];
	canSteer: boolean;
	vim?: boolean;
}) {
	const theme = useTheme();
	if (queued.length === 0) return null;
	const shown = queued.slice(0, QUEUED_PREVIEW_ROWS);
	const rest = queued.length - shown.length;
	return (
		<Box flexDirection="column">
			<Text dimColor>{queuedHint(canSteer, vim)}</Text>
			{shown.map((message) => (
				<Text key={message.id} dimColor color={message.mode === "steer" ? theme.userInput : undefined}>
					{message.mode === "steer" ? `  ≫ ${queuedPreview(message.text)}` : `  ↳ ${queuedPreview(message.text)}`}
				</Text>
			))}
			{rest > 0 && <Text dimColor>{`  … +${rest} more`}</Text>}
		</Box>
	);
}
