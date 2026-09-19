/**
 * Desktop notification for the two moments the user is likely to be looking at
 * another window: a run finished, or the agent is blocked on an approval.
 *
 * There is no focus detection anywhere in Ink 7 — `Key` carries no focus field,
 * there is no focus hook, and the kitty keyboard flags it negotiates include no
 * focus-reporting bit — so this cannot know whether the terminal is frontmost.
 * It therefore always notifies, and relies on coalescing to stay quiet rather
 * than on a guess about attention.
 */
import { sanitizeText } from "./sanitize.ts";

export type NotifyKind = "action" | "complete";

/** The bell, for terminals with no notification escape worth sending. */
export const BEL = "\x07";

/** Terminals whose OSC 9 is a real desktop notification, not a printed glyph. */
export const OSC9_TERMINALS = ["Ghostty", "iTerm.app", "kitty", "WarpTerminal", "WezTerm"];

/** A notification that does not raise the priority within this window is dropped. */
export const NOTIFY_COALESCE_MS = 3000;

export const NOTIFY_PRIORITY: Record<NotifyKind, number> = { complete: 0, action: 1 };

/**
 * The escape sequence for one notification.
 *
 * `kind` deliberately plays no part: it decides *whether* to notify, never how.
 * The message is sanitized because it is spliced into a sequence we compose —
 * an unsanitized BEL inside it would end the OSC early.
 */
export function notificationSequence(message: string, env: NodeJS.ProcessEnv = process.env): string {
	const body = sanitizeText(message, 120);
	if (!body) return "";
	if (env.TERM_PROGRAM && OSC9_TERMINALS.includes(env.TERM_PROGRAM)) return `\x1b]9;${body}\x07`;
	return BEL;
}

export interface LastNotification {
	kind: NotifyKind;
	at: number;
}

/**
 * Whether this notification is worth sending, given the last one.
 *
 * Outside the window everything passes. Inside it, only a notification that
 * outranks the previous one does — which is the case that matters: a completion
 * firing microseconds after an approval request must not bury it. Two requests
 * of the same priority inside the window are one alert, not two.
 *
 * (`last` is null for the first notification of a session.)
 */
export function shouldNotify(kind: NotifyKind, last: LastNotification | null, now: number): boolean {
	if (!last) return true;
	if (now - last.at > NOTIFY_COALESCE_MS) return true;
	return NOTIFY_PRIORITY[kind] > NOTIFY_PRIORITY[last.kind];
}
