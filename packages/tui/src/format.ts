/**
 * Token counts, shortened the way the app shortens them (1234 → 1.2k).
 *
 * One copy for the whole workspace: the status line and the status card draw
 * from here directly, and the coding agent re-exports it for the readings it
 * formats (context summaries, the watch panel's facts stop). A number that
 * reads "1.2k" in one place and "1234" in another would be two answers to one
 * question — this file is why that cannot happen.
 */

/** How token counts are shortened: thousands by default, millions on request. */
export type TokenUnit = "k" | "mtok";

/** The values the `tokenUnit` setting accepts. */
export const TOKEN_UNITS = ["k", "mtok"] as const;

/** One million tokens — the size at which MTok replaces the k form. */
const TOKENS_PER_MTOK = 1_000_000;

let activeUnit: TokenUnit = "k";

/**
 * Set the unit every later `formatTokens` call uses.
 *
 * A display preference is process-wide, and its readers are not all React
 * components: the status line draws inside the TUI, while `/cost` and the
 * compaction notices build their strings in the coding agent. A module-level
 * default is what lets one settings key reach both without threading a
 * parameter through every call site. The settings are read once at startup,
 * so nothing re-renders when this changes.
 */
export function setTokenUnit(unit: TokenUnit | undefined): void {
	activeUnit = unit ?? "k";
}

/** The unit `formatTokens` uses when the caller names none. */
export function getTokenUnit(): TokenUnit {
	return activeUnit;
}

/**
 * Shorten `tokens`.
 *
 * The compact form is the long-standing one. The MTok form is opt-in through
 * the `tokenUnit` setting, and it only takes over from one million up: below
 * that, `200.0k` is shorter and no less exact than `0.2 MTok`. Its purpose is
 * the cumulative readings — a project's lifetime spend, a busy day — where the
 * alternative is a seven-digit k figure or a comma-separated count.
 */
export function formatTokens(tokens: number, unit: TokenUnit = activeUnit): string {
	if (unit === "mtok" && tokens >= TOKENS_PER_MTOK) return `${(tokens / TOKENS_PER_MTOK).toFixed(1)} MTok`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

/**
 * Share of the auto-compact point in use, as a whole percent.
 *
 * One rounding rule for the number five surfaces print. They used to compute
 * their own, in two directions: the live row said "45% free", the card said
 * "55%" (used), and the summary said "of the auto-compact point", so a reader
 * could see one measurement as several unrelated numbers. Every surface now
 * says percent used, and names the base where it has room.
 *
 * Deliberately not clamped. Past the threshold, "106% of the auto-compact
 * point" is the fact a summary should print; only a bar clamps, because it has
 * nowhere to overflow.
 */
export function contextPercentUsed(usedTokens: number, threshold: number): number {
	if (threshold <= 0) return 0;
	return Math.round((usedTokens / threshold) * 100);
}

/**
 * A long-form token total for report lines (`/cost`, `/cache`).
 *
 * Reports are where exactness matters, so below a million this keeps every
 * digit with separators rather than shortening to `1.2k`; above it, the MTok
 * form takes over when the `tokenUnit` setting asks for it. The status line
 * keeps {@link formatTokens} because there the width is the constraint.
 */
export function formatTokenTotal(tokens: number, unit: TokenUnit = activeUnit): string {
	if (unit === "mtok" && tokens >= TOKENS_PER_MTOK) return `${(tokens / TOKENS_PER_MTOK).toFixed(1)} MTok`;
	return tokens.toLocaleString("en-US");
}
