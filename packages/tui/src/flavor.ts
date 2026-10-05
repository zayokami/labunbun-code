/**
 * The status row's flavor: what a finished turn is called, and how long a
 * thought has to run before it earns a longer name.
 *
 * Pure and self-contained on purpose — the words and the boundaries are test
 * rows rather than something only a stopped watch could check. Nothing here
 * reads a clock or a random source of its own; both arrive as arguments.
 */
import { formatElapsed } from "./elapsed.ts";

/**
 * What a completed turn calls itself — one pick per turn.
 *
 * Every word is work the band the app is named for actually does, so the
 * footer reads as a note about the task rather than a mood about a person.
 */
export const DONE_VERBS: readonly string[] = [
	"Composed",
	"Arranged",
	"Drummed",
	"Grooved",
	"Soloed",
	"Tuned",
	"Mixed",
	"Mastered",
];

/**
 * Pick this turn's verb. `random` returns [0, 1); the fallback covers a source
 * that breaks that contract — a plausible word in the transcript beats an
 * `undefined` in it.
 */
export function pickDoneVerb(random: () => number): string {
	return DONE_VERBS[Math.floor(random() * DONE_VERBS.length)] ?? "Played";
}

/**
 * The word for a thought that has been running `ms` milliseconds.
 *
 * Two thresholds, because two are what the row needs: past ten seconds
 * "Thinking…" starts reading like a stuck spinner, and past forty-five the
 * wait has changed kind — it is no longer fast, and saying so is kinder than
 * repeating the word that has been on screen the whole time.
 */
export function thinkingWord(ms: number): string {
	if (ms >= 45_000) return "Deep in the groove";
	if (ms >= 10_000) return "Still composing";
	return "Thinking…";
}

/**
 * The footer a completed turn leaves: `♪ Composed for 12s`.
 *
 * The duration goes through `formatElapsed`, the same spelling the status row
 * uses, so the two numbers a user watched back to back never disagree on
 * format. Only a run that finished carries the mark — one that was interrupted
 * says so in its own line, and dressing that up would be the wrong note.
 */
export function formatDoneLine(verb: string, elapsedMs: number): string {
	return `♪ ${verb} for ${formatElapsed(elapsedMs)}`;
}
