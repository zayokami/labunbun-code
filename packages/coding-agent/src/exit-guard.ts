/**
 * The question asked on the way out, and the guard that asks it.
 *
 * `/exit`, `/quit` and the idle double Ctrl+C used to end the process the
 * instant they were recognized, whatever was still going. What dies at that
 * moment is invisible from the inside: a turn in flight ends mid-request, and
 * subagents end with it -- their sidechains live only in memory. Background
 * shells are the reverse and just as invisible: they were started precisely
 * to outlive the session, so quitting leaves them serving with nobody who
 * knows their names. The last moment there is a screen to say any of this on
 * is the exit itself, so it stopped being immediate and became a question:
 * what is still going, what dies, what survives, and -- for what survives --
 * how to find and end it later.
 *
 * The guard holds the policy; the caller holds the facts and the dialog. Two
 * decisions are deliberate:
 *
 * - Nothing running means no question. The confirmation is for state the user
 *   cannot see; a dialog over a quiet session would be a tax on leaving.
 * - Doubt leaves. A guard that cannot ask -- no REPL to ask with, a dialog
 *   that throws -- must not become an app nobody can exit, so every failure
 *   path here settles on "leave".
 */

/** What is still going at the moment the exit was asked for. */
export interface ExitWork {
	/** A turn is in flight; the model request behind it ends with the process. */
	turnRunning: boolean;
	/** Live subagents, waiting ones included: their sidechains live only in memory. */
	subagents: number;
	/** Background shells still running -- this run's and recovered ones alike. */
	shells: number;
}

/** The answer that leaves. Any other answer -- a dismissal included -- stays. */
export const EXIT_ANSWER = "Exit anyway";

/** One question in the shape the question dialog renders. */
export interface ExitQuestion {
	header: string;
	question: string;
	options: Array<{ label: string; description?: string }>;
}

/** `2 subagents`, `1 shell` -- the noun agreeing with the number in front of it. */
const counted = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The confirmation for the work in flight, or null when there is none to write
 * about.
 *
 * Every claim in it is one the exit really makes true: the run and the
 * subagents end (the process is about to), and the shells keep running (this
 * code never kills one on the way out -- that is the whole point of a
 * background shell). The surviving shells get the two commands that can find
 * and end them again, because the question is the last chance to say them and
 * the next session is where they take effect.
 */
export function exitConfirmation(work: ExitWork): ExitQuestion | null {
	const active: string[] = [];
	if (work.turnRunning) active.push("a run is in flight");
	if (work.subagents > 0) active.push(counted(work.subagents, "subagent", "subagents"));
	if (work.shells > 0) active.push(counted(work.shells, "background shell", "background shells"));
	if (active.length === 0) return null;

	const fates: string[] = [];
	const named = work.subagents === 1 ? "the subagent" : "the subagents";
	if (work.turnRunning && work.subagents > 0) {
		fates.push(`Exiting stops the run and terminates ${named}.`);
	} else if (work.turnRunning) {
		fates.push("Exiting stops the run where it is.");
	} else if (work.subagents > 0) {
		fates.push(`Exiting terminates ${named}.`);
	}
	if (work.shells > 0) {
		fates.push(
			work.shells === 1
				? "The shell keeps running; /ps lists it and /stop ends it."
				: "The shells keep running; /ps lists them and /stop ends one.",
		);
	}
	return {
		header: "Exit",
		question: `Still active: ${active.join(", ")}. ${fates.join(" ")}`,
		options: [
			{ label: "Stay", description: "The work continues." },
			{ label: EXIT_ANSWER, description: "The process ends now." },
		],
	};
}

/** What the guard needs from around it: the facts, the picker, the dialog. */
export interface ExitGuardDeps {
	/** Read fresh at each request -- work starts and ends between requests. */
	work: () => ExitWork;
	/** Dismiss an open picker the way Esc would; see where it is called below. */
	cancelPicker: () => void;
	/** Put the question on screen; resolves with the chosen labels, or null when dismissed. */
	ask: (question: ExitQuestion) => Promise<string[] | null>;
}

/**
 * The exit request handler: resolves true to leave, false to stay.
 *
 * One request at a time. A second request while the question is up is the
 * same request arriving twice (a Ctrl+C held a beat too long), and answering
 * it would replace the question on screen with its own twin; it is refused
 * instead. The picker is dismissed before the question because both listen on
 * the same keys -- with a list left up, one Enter would answer both, and the
 * two answers could disagree.
 */
export function createExitGuard(deps: ExitGuardDeps): () => Promise<boolean> {
	let asking = false;
	return async () => {
		if (asking) return false;
		const question = exitConfirmation(deps.work());
		if (!question) return true;
		asking = true;
		try {
			deps.cancelPicker();
			const answers = await deps.ask(question);
			return answers?.[0] === EXIT_ANSWER;
		} catch {
			// Fail open: the user asked to leave, and a broken guard must not
			// hold them here.
			return true;
		} finally {
			asking = false;
		}
	};
}
