import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";
import type { StatusCardData } from "../ui-state.ts";

/** Segments in the context bar. Fixed, so the card does not resize as it fills. */
export const CONTEXT_BAR_SEGMENTS = 20;

/**
 * The context bar and its percentage.
 *
 * A bar answers "how much room is left" faster than a number does, and the
 * number is still there for the case where the difference between 38% and 40%
 * matters. Both come from the same ratio so they can never disagree.
 */
export function contextBar(usedTokens: number, threshold: number, segments = CONTEXT_BAR_SEGMENTS) {
	const ratio = threshold > 0 ? Math.min(1, Math.max(0, usedTokens / threshold)) : 0;
	const filled = Math.round(ratio * segments);
	return {
		filled,
		percent: Math.round(ratio * 100),
		bar: `${"█".repeat(filled)}${"░".repeat(segments - filled)}`,
	};
}

/** Tokens, shortened the way the status line shortens them (1 234 → 1.2k). */
function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

/**
 * The `/status` and `/context` card: one row per fact, a bar for the context
 * window, and the reminder that Esc puts it away. Like the other overlays it is
 * dismissed with Escape, which is why it is rendered next to them rather than
 * in the transcript, where it would scroll out of reach.
 *
 * The identity rows are optional because the card is not always about a
 * session's whereabouts: `/context` is about one number and what it is made of,
 * and the model and directory belong on the card the user asked for them on.
 */
export function StatusCard({ data }: { data: StatusCardData }) {
	const theme = useTheme();
	const context = data.context ? contextBar(data.context.usedTokens, data.context.threshold) : undefined;
	const rows: Array<[string, string]> = [
		...(data.model ? ([["Model", data.model]] as Array<[string, string]>) : []),
		...(data.directory ? ([["Directory", data.directory]] as Array<[string, string]>) : []),
		...(data.permissions ? ([["Permissions", data.permissions]] as Array<[string, string]>) : []),
		...(data.session ? ([["Session", data.session]] as Array<[string, string]>) : []),
		...(context && data.context
			? ([["Context", `${context.bar} ${context.percent}%`]] as Array<[string, string]>)
			: []),
		...data.details,
	];
	// Every part of a row is now optional, so a card can arrive with none of them
	// and an unguarded maximum would be -Infinity.
	const width = Math.max(0, ...rows.map(([label]) => label.length));

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				{data.title ?? "Status"}
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{rows.map(([label, value]) => (
					// The label is the row's identity: values change as the turn runs,
					// and a row that is re-keyed on every measurement loses its place.
					<Text key={label}>
						<Text color={theme.textMuted}>{label.padEnd(width)}</Text> {value}
					</Text>
				))}
				{data.context ? (
					<Text dimColor>{`${" ".repeat(width + 1)}~${formatTokens(data.context.usedTokens)} of ${formatTokens(
						data.context.threshold,
					)} — auto-compacts near the top`}</Text>
				) : (
					<Text dimColor>{`${" ".repeat(width + 1)}measured after the first turn`}</Text>
				)}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>Esc to dismiss</Text>
			</Box>
		</Box>
	);
}
