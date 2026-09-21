/**
 * One object the UI holds, so no component ever holds a source, a clock, or a
 * service. The service owns the pad; the bridge is what the screen sees, and the
 * two are built together because the service's listeners *are* the bridge.
 *
 * The shape is deliberately the smallest thing that works: subscribe to actions,
 * read the status (the identity is stable, so it is what
 * `useSyncExternalStore` wants), and hand the app's phase back. Everything the
 * UI cannot ask for — the device list, the counters, closing the handle — stays
 * on the service, where the app layer can reach it and a rendering layer cannot.
 *
 * Two settings live here rather than in the service because they are the user's
 * decisions rather than the pad's business: whether the pad may answer a
 * permission dialog, and the phrases the wheel offers.
 */

import type { PadBindingMap } from "./bindings.ts";
import type { PadPalette, PadRumbleEvent } from "./feedback.ts";
import type { PadAction, PadRepeat } from "./mapping.ts";
import {
	createPadService,
	type PadClock,
	type PadService,
	type PadServiceStatus,
	type PadUiSignal,
} from "./service.ts";
import type { PadSource } from "./source.ts";

export interface PadBridgeOptions {
	/** The thing that finds and opens controllers. */
	source: PadSource;
	/** The resolved button→action map (see `resolveBindings`). */
	bindings: PadBindingMap;
	/** The theme's colours, as the lightbar's. */
	palette: PadPalette;
	/** The `device` setting. See `matchesDevice`. */
	device?: string;
	deadzone?: number;
	repeat?: Partial<PadRepeat>;
	/** How long to wait before looking again, and how often to write. */
	reconnectMs?: number;
	outputMs?: number;
	silenceMs?: number;
	/** Whether the pad may buzz, and whether it may light. Both default to on. */
	rumble?: boolean;
	lightbar?: boolean;
	clock?: PadClock;
	/**
	 * Whether the pad may answer a permission dialog. **Off unless the user says
	 * otherwise**: a controller in a pocket is not a person deciding, so this is a
	 * user-tier setting and nothing below it can turn it on.
	 */
	allowApprove?: boolean;
	/** Whole prompts, one press away, on the command wheel. */
	phrases?: readonly string[];
}

/** What the UI is given. Satisfied by the real bridge; a test writes ten lines. */
export interface PadBridge {
	/**
	 * Whether ✕ may answer a permission dialog. Read at press time, so
	 * `/gamepad approve` takes effect on the next question rather than the next
	 * start — a security switch that only works after a restart is a switch the
	 * user will not believe.
	 */
	readonly allowApprove: boolean;
	/** The user turned approvals on or off. */
	setAllowApprove(next: boolean): void;
	/** What the wheel offers beyond the command table. */
	readonly phrases: readonly string[];
	/** Every action, in the order the reports carried them. */
	onAction(handler: (action: PadAction) => void): () => void;
	/** The current status. The same object until something actually changed. */
	status(): PadServiceStatus;
	/** For `useSyncExternalStore`. */
	subscribe(listener: () => void): () => void;
	/** What the app is doing, for the lightbar and the buzzes that follow it. */
	setFeedback(ui: PadUiSignal): void;
	/** The theme changed: the bar in the user's hand follows the screen. */
	setPalette(palette: PadPalette): void;
	/** One of `PAD_RUMBLE`, now: a person asking for a buzz, not a state change. */
	buzz(name: PadRumbleEvent): void;
}

/** The two ends of one controller: the service that owns it, the bridge the UI sees. */
export interface PadInstallation {
	service: PadService;
	bridge: PadBridge;
}

export function createPadBridge(options: PadBridgeOptions): PadInstallation {
	const handlers = new Set<(action: PadAction) => void>();
	const listeners = new Set<() => void>();

	const service = createPadService(
		{
			bindings: options.bindings,
			palette: options.palette,
			device: options.device,
			deadzone: options.deadzone,
			repeat: options.repeat,
			reconnectMs: options.reconnectMs,
			outputMs: options.outputMs,
			silenceMs: options.silenceMs,
			rumble: options.rumble,
			lightbar: options.lightbar,
		},
		{
			source: options.source,
			clock: options.clock,
			// One action at a time out of the service's array, and to every handler:
			// a subscriber is a listener, not a link in a chain. Nothing here reads a
			// handler's answer, so ownership is the subscribers' own business — a
			// component that needs to know whether someone else already used an action
			// has to *ask* that someone (`padRef` in the tui is exactly that), and a
			// component that both subscribes and is asked will act twice.
			onActions: (actions) => {
				for (const action of actions) for (const handler of handlers) handler(action);
			},
			onStatus: () => {
				for (const listener of listeners) listener();
			},
		},
	);

	// A variable behind a getter rather than a field: the dialogs read it when a
	// button is pressed, and `/gamepad approve off` has to be felt immediately.
	let allowApprove = options.allowApprove ?? false;

	return {
		service,
		bridge: {
			get allowApprove() {
				return allowApprove;
			},
			setAllowApprove(next) {
				allowApprove = next;
			},
			phrases: cleanPhrases(options.phrases),
			onAction(handler) {
				handlers.add(handler);
				return () => {
					handlers.delete(handler);
				};
			},
			status: () => service.status(),
			subscribe(listener) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			setFeedback: (ui) => service.setFeedback(ui),
			setPalette: (next) => service.setPalette(next),
			buzz: (name) => service.buzz(name),
		},
	};
}

/**
 * A phrase with only spaces around it is not a phrase: it would take a row on the
 * wheel and put nothing in the prompt. Blank ones are dropped rather than
 * reported — the settings layer is where a bad line gets a sentence, and by the
 * time a phrase is here it has already been through it.
 */
function cleanPhrases(phrases: readonly string[] | undefined): readonly string[] {
	return (phrases ?? []).map((phrase) => phrase.trim()).filter((phrase) => phrase !== "");
}
