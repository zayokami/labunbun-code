/**
 * The two commands that act on background shells.
 *
 * A shell started with `run_in_background` outlives the turn that started it,
 * which is the point of it — a dev server should keep serving — and also the
 * problem: nothing else in the UI would ever mention it again. The status row
 * says how many are running; these are what the row points at.
 *
 * Pure formatting, so what `/ps` shows and what `/stop` accepts can be asserted
 * without a running process.
 */

import type { BackgroundShell } from "@labunbun/tools";
import { LIVE_OUTPUT_LINES, liveOutputLines } from "@labunbun/tui";

/** Longest command shown in the picker before it is elided. */
const COMMAND_CHARS = 60;

/**
 * How often the shell list is republished to the status row. Slow on purpose:
 * the thing being watched is a dev server that has been up for ten minutes, and
 * the only event that matters — a shell ending, or being stopped — is published
 * the moment it is known.
 */
export const BACKGROUND_SHELL_POLL_MS = 2000;

/** How long a shell has been going, coarse enough to read at a glance. */
export function shellAge(shell: BackgroundShell, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - shell.startTime) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One row per shell, newest last, in the order the manager lists them (which is
 * the order they were started — ids are handed out in sequence).
 */
export function shellPickerItems(
	shells: BackgroundShell[],
	now = Date.now(),
): Array<{ label: string; description: string }> {
	return shells.map((shell) => ({
		label: `${shell.id}  ${elide(shell.command)}`,
		description: [shell.status, shell.exitCode !== null ? `exit ${shell.exitCode}` : undefined, shellAge(shell, now)]
			.filter(Boolean)
			.join(" · "),
	}));
}

/**
 * What `/ps` prints for the chosen shell: the same tail a running tool shows
 * while it streams, because it is the same question — "what is it saying now".
 */
export function formatShellOutput(id: string, text: string, maxLines: number = LIVE_OUTPUT_LINES): string {
	const body = liveOutputLines(text, maxLines);
	// A fresh log is "" and splits to one empty line rather than to nothing, so
	// "did it draw anything" is the question, not "how many lines came back" —
	// otherwise a silent server prints a blank window that looks like a failure.
	const drawn = body.some((line) => line.trim() !== "");
	const lines = drawn ? [`${id}:`, ...body.map((line) => `  ${line}`)] : [`${id}: (no output yet)`];
	return lines.join("\n");
}

/**
 * The shell named by an argument: `shell_2` or just `2`, since the id shown in
 * the picker is one and the number is what people remember.
 */
export function resolveShellId(arg: string, shells: BackgroundShell[]): BackgroundShell | undefined {
	const wanted = arg.trim().toLowerCase();
	if (!wanted) return undefined;
	return shells.find((shell) => shell.id.toLowerCase() === wanted || shell.id.toLowerCase() === `shell_${wanted}`);
}

/** Keep the head of a command — the tail is usually the flags, the head is what it is. */
function elide(command: string): string {
	const oneLine = command.replace(/\s+/g, " ").trim();
	return oneLine.length > COMMAND_CHARS ? `${oneLine.slice(0, COMMAND_CHARS - 1)}…` : oneLine;
}
