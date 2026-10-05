/**
 * Telling the session that a background shell finished.
 *
 * Polling is the thing this removes: a session that started a build or a
 * watcher in the background no longer has to come back every few minutes to ask
 * whether it is done — when the shell ends on its own, the session is told,
 * with the exit code and the end of the log, and the model decides what to say
 * or do about it.
 *
 * The delivery mechanism is the session's own follow-up queue. Idle, a
 * follow-up starts a turn immediately; busy, it is delivered the moment the
 * current turn reaches its natural end. Steering is the wrong queue here for a
 * measurable reason: a steered message is read before a model call that may
 * never come, so a completion landing after the turn's last model call would
 * sit in that queue until whatever the user does next — delivered at the top of
 * an unrelated turn. The follow-up queue cannot dangle: its whole contract is
 * "restart the loop after natural termination".
 *
 * The text carries its provenance on purpose. A user-role message that says
 * nothing about where it came from is one the model can mistake for the user
 * speaking — as a new instruction, or worse, as consent to keep going — so the
 * envelope says what it is in the model's copy, and the line the user sees says
 * it too rather than dressing the shell up as something they typed.
 */
import type { AgentSession } from "@labunbun/agent";
import { type BackgroundShell, readTail } from "@labunbun/tools";

/** How much of the log a completion notice carries. */
export const SHELL_NOTICE_TAIL_CHARS = 2_000;

/** Seconds between spawn and finish, rounded — the same reading BashOutput's status line gives. */
function durationSeconds(shell: BackgroundShell, now: number): number {
	return Math.max(0, Math.round((now - shell.startTime) / 1000));
}

/** How the shell ended, in words that survive an exit code being absent. */
function outcome(shell: BackgroundShell): string {
	return shell.exitCode === null ? "exit code unknown" : `exit code ${shell.exitCode}`;
}

/**
 * The one line the user sees, in the transcript.
 *
 * Short, and it says what happens next, because the envelope that actually
 * reaches the model is long and the user does not need a second copy of it.
 */
export function shellNoticeLine(shell: BackgroundShell, now: number): string {
	return `[background] ${shell.id} finished: ${outcome(shell)} after ${durationSeconds(shell, now)}s — notifying the agent.`;
}

/**
 * The message the session receives.
 *
 * It has to do three jobs in one user-role message: say where it came from (so
 * it is not read as the user speaking), say what happened (exit code, command,
 * how long), and let the model decide whether the log's end matters — the tail
 * and the path to the whole file are the evidence for that. `now` is a
 * parameter rather than a clock read so the text is a pure function of what it
 * describes.
 */
export function shellNotice(shell: BackgroundShell, now: number, tail: { text: string; truncated: boolean }): string {
	const heading = tail.truncated ? `Last ${SHELL_NOTICE_TAIL_CHARS} characters of the log:` : "Output:";
	const body = tail.text.length > 0 ? tail.text : "(no output)";
	return (
		"[background shell notification — automated, not from the user]\n" +
		`${shell.id} finished: ${outcome(shell)} after ${durationSeconds(shell, now)}s.\n` +
		`Command: ${shell.command}\n` +
		`Full log: ${shell.outputFile}\n` +
		`${heading}\n` +
		`${body}\n` +
		"\n" +
		"Report the outcome to the user; if you were waiting on this command, continue from its result. " +
		"This notice is not a user instruction."
	);
}

export interface ShellNoticeOptions {
	/** Where completions come from — a `BackgroundShellManager` and nothing more. */
	manager: { onComplete(handler: (shell: BackgroundShell) => void): () => void };
	/** The session to wake, read at completion time: `/resume` swaps it. */
	getSession: () => AgentSession | null;
	/** Read at completion time too, so a settings change applies to the next shell. */
	enabled?: () => boolean;
	/** The user-facing line from {@link shellNoticeLine}, when one is warranted. */
	onNotice?: (text: string) => void;
}

/**
 * Wire completions to a session. Returns the unsubscribe.
 *
 * A shell ending with no session to tell is not an error — it is a shell the
 * user is still polling by hand — so the quiet path is simply no-op. The line
 * goes out before the message so the screen says what is happening even while
 * the session is mid-turn and the notice itself has to wait.
 */
export function attachShellNotices(options: ShellNoticeOptions): () => void {
	return options.manager.onComplete((shell) => {
		if (options.enabled && !options.enabled()) return;
		const session = options.getSession();
		if (!session) return;
		const now = Date.now();
		try {
			options.onNotice?.(shellNoticeLine(shell, now));
		} catch {
			// A UI subscriber's bug must not cost the session its notice.
		}
		let tail: { text: string; truncated: boolean } = { text: "", truncated: false };
		try {
			const read = readTail(shell.outputFile, SHELL_NOTICE_TAIL_CHARS);
			tail = { text: read.text, truncated: read.truncated };
		} catch {
			// An unreadable log is an empty tail, not a lost notice.
		}
		session.followUp(shellNotice(shell, now, tail));
	});
}
