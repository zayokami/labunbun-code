/**
 * Token counts, shortened the way the app shortens them (1234 → 1.2k).
 *
 * One copy for the whole workspace: the status line and the status card draw
 * from here directly, and the coding agent re-exports it for the readings it
 * formats (context summaries, the watch panel's facts stop). A number that
 * reads "1.2k" in one place and "1234" in another would be two answers to one
 * question — this file is why that cannot happen.
 */
export function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}
