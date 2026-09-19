import { useAnimation } from "ink";
import { useEffect, useRef } from "react";
import { sanitizeText } from "../sanitize.ts";
import type { StatusPhase } from "../ui-state.ts";
import { FRAMES, SPINNER_INTERVAL_MS } from "./StatusLine.tsx";

/** Wrap a title in the OSC-0 set-window-title sequence. */
export function terminalTitle(title: string): string {
	return `\x1b]0;${title}\x07`;
}

/** Longest title written. Beyond this a window title is unreadable anyway. */
export const TITLE_MAX_CHARS = 80;

/** How fast "[ ! ] Action Required" blinks, alternating once a second. */
export const TITLE_BLINK_MS = 1000;

/**
 * Make text safe to splice into the title sequence. A directory name is the one
 * part of the title the user did not type into this program, and it is a
 * perfectly good place to hide `\x07` or a second `\x1b]0;`.
 */
export function sanitizeTitle(text: string, maxChars = TITLE_MAX_CHARS): string {
	return sanitizeText(text, maxChars);
}

/** The title while a run is blocked waiting on the user. */
export function actionTitle(blinkOn: boolean): string {
	return blinkOn ? "[ ! ] Action Required" : "[ . ] Action Required";
}

const PHASE_TITLE: Record<StatusPhase, string> = {
	idle: "",
	thinking: "thinking",
	responding: "responding",
	tools: "running tools",
};

/**
 * What the window title should read.
 *
 * Being blocked outranks being busy: "the agent is waiting on you" is the one
 * state where nothing moves until the reader acts, and it is the state most
 * likely to be missed while looking at another window. The spinner rides next to
 * the phase, and the whole string is sanitized and capped once at the end so
 * there is a single choke point for everything spliced into the escape sequence.
 */
export function windowTitle({
	phase,
	dirName,
	actionRequired,
	frame,
	blinkOn,
}: {
	phase: StatusPhase;
	dirName: string;
	actionRequired: boolean;
	frame: number;
	blinkOn: boolean;
}): string {
	const base = `labunbun — ${dirName}`;
	const title = actionRequired
		? `${base} · ${actionTitle(blinkOn)}`
		: phase === "idle"
			? base
			: `${base} · ${FRAMES[frame % FRAMES.length]} ${PHASE_TITLE[phase]}`;
	return sanitizeTitle(title);
}

/**
 * Keep the terminal window title in step with the session. Pure side effect —
 * renders nothing. Writes are TTY-guarded: piped output must never receive
 * escape sequences.
 */
export function TerminalTitle({
	phase,
	dirName,
	actionRequired = false,
}: {
	phase: StatusPhase;
	dirName: string;
	/** A dialog is open and the run cannot continue without an answer. */
	actionRequired?: boolean;
}) {
	// The frames only tick while there is something to animate; `useAnimation`
	// shares ink's single timer, so an idle title costs nothing.
	const { frame } = useAnimation({ interval: SPINNER_INTERVAL_MS, isActive: !actionRequired && phase !== "idle" });
	const { frame: blinkFrame } = useAnimation({ interval: TITLE_BLINK_MS, isActive: actionRequired });
	const title = windowTitle({ phase, dirName, actionRequired, frame, blinkOn: blinkFrame % 2 === 0 });
	const idleTitle = windowTitle({ phase: "idle", dirName, actionRequired: false, frame: 0, blinkOn: true });

	// Latest value in a ref so the unmount cleanup can read it without the effect
	// re-running: a cleanup keyed on the title would rewrite the idle title
	// between two spinner frames, which is a visible flicker.
	const idleRef = useRef(idleTitle);
	idleRef.current = idleTitle;

	useEffect(() => {
		if (!process.stdout.isTTY) return;
		process.stdout.write(terminalTitle(title));
	}, [title]);

	useEffect(
		() => () => {
			// On unmount, drop the suffix so the title doesn't claim a run in flight.
			if (process.stdout.isTTY) process.stdout.write(terminalTitle(idleRef.current));
		},
		[],
	);

	return null;
}
