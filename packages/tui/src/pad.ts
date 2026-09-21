/**
 * The seam between a controller and the screen.
 *
 * Three exports, and each one exists because of something this package already
 * does. `usePadAction` mirrors the `escapeRef` hand-off: ink hands every key to
 * every listener and every *pad* action to every subscriber, so ownership has to
 * be simulated by asking — a component that used the action says so by returning
 * true, and the one that asked first is the one that gets it. `usePadStatus` is
 * the shape `useSyncExternalStore` wants, and the bridge exists to make its
 * identity stable. `isAimedAt` is the one thing a dialog cannot work out on its
 * own: an action carries how long its button has been down, and a press that
 * began before the question appeared was not aimed at the question.
 *
 * Returning true is an answer to *whoever asked*, not to the bridge: the bridge
 * hands an action to every subscriber and reads nothing back, so two components
 * that both want it will both act. That is the whole reason `padRef` exists, and
 * the reason a component that publishes a handle must not also subscribe — see
 * `PromptInput`, where doing both typed every letter twice.
 *
 * Nothing here holds a source, a clock, or a service: the pad belongs to
 * `@labunbun/gamepad`, and this file only knows the two methods a screen needs.
 */

import type { PadAction, PadBridge, PadServiceStatus } from "@labunbun/gamepad";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

/**
 * An action, and whether it was used. `false` is the honest answer for "not
 * mine": the REPL asks the editor first, and anything it declines goes on to the
 * window behind it, exactly as an Escape the editor did not want does.
 */
export type PadActionHandler = (action: PadAction) => boolean;

/** What the prompt editor publishes, for the same reason `escapeRef` exists. */
export interface PadPromptHandle {
	/** First look at an action. True when the editor used it. */
	action(action: PadAction): boolean;
	/** Put a whole prompt in the buffer, for the wheel's phrases. */
	fill(text: string): void;
}

/** A ref the editor fills in with its handler, or null while it is not mounted. */
export type PadPromptRef = RefObject<PadPromptHandle | null>;

/**
 * Subscribe to the pad for as long as the component is mounted.
 *
 * The handler is kept in a ref rather than in the subscription: a component that
 * re-renders for its own reasons (a keystroke, a tick) must not churn the pad's
 * listener list, and a handler that closed over last render's state would answer
 * a press with a stale answer. `isActive` rides along in the same ref — it is
 * the pad's half of the rule ink's `useInput` states with `{ isActive }`: a
 * disabled prompt takes no pad actions either, so a dialog on top of it cannot
 * have its ✕ eaten by an editor nobody can type into.
 *
 * The ref is written by a *layout* effect rather than a passive one, which is
 * the one place this file departs from the usual shape, and it is not a
 * preference. Ink writes its frame from `resetAfterCommit` — inside the same
 * task the commit runs in — while a passive effect is flushed in a later one. A
 * press arriving in that gap is answered by the handler of the render before:
 * the screen shows one row and ✕ runs the previous one. A controller is a
 * timer-driven firehose rather than a person typing, so the gap is not
 * theoretical; a test that pressed as soon as the highlight moved landed in it,
 * and the wheel ran the row the mark had just left. A layout effect is flushed
 * before that task ends, so what is answering presses is never older than what
 * is on the screen.
 *
 * The subscription itself is a passive effect, and that is fine: it is
 * established once, on mount, long before anything can be pressed.
 */
export function usePadAction(
	bridge: PadBridge | undefined,
	handler: PadActionHandler,
	options: { isActive?: boolean } = {},
): void {
	const current = useRef({ handler, active: options.isActive ?? true });
	useLayoutEffect(() => {
		current.current = { handler, active: options.isActive ?? true };
	});

	useEffect(() => {
		if (!bridge) return;
		return bridge.onAction((action) => {
			// Read at press time, both of them: this is the whole point of the ref.
			const { handler: latest, active } = current.current;
			if (active) latest(action);
		});
	}, [bridge]);
}

const NOTHING = () => {};

/**
 * The pad's status, or `undefined` when there is no pad.
 *
 * `useSyncExternalStore` with the bridge's own `status()`: it hands back the
 * same object until something about the pad actually changed, which is what
 * keeps a thumb resting on a stick — a hundred reports a second, all saying the
 * same thing — from rerendering the tree.
 */
export function usePadStatus(bridge: PadBridge | undefined): PadServiceStatus | undefined {
	const subscribe = useCallback((listener: () => void) => bridge?.subscribe(listener) ?? NOTHING, [bridge]);
	const snapshot = useCallback(() => bridge?.status(), [bridge]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Whether the press behind an action began after `openedAt`.
 *
 * A dialog cannot assume the ✕ it just saw was meant for it. A button already
 * down when the question appeared belongs to whatever was on screen a moment
 * ago, and "always allow" is not a decision to inherit from a thumb that never
 * moved. The mapper's `heldMs` is what makes this answerable: a release — and a
 * hold — always carries the age of its own press, so `now - heldMs` is when the
 * button went down.
 */
export function isAimedAt(action: PadAction, openedAt: number, now = Date.now()): boolean {
	return now - action.heldMs >= openedAt;
}
