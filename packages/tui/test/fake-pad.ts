/**
 * A controller, in a few lines.
 *
 * The real bridge is a service, a source and a clock, and a component test
 * wants none of them. What it wants is to hand the screen one action and look
 * at what the screen did with it. So this is the four methods a component calls
 * — plus recordings of the two it calls back on, because "the pad complained"
 * and "the lightbar was told the app is busy" are things worth asserting.
 *
 * Not a `.test.ts`: bun would run an empty suite out of it.
 */

import type {
	Ds4Battery,
	PadAction,
	PadBridge,
	PadPalette,
	PadRumbleEvent,
	PadServicePhase,
	PadServiceStatus,
	PadUiSignal,
} from "@labunbun/gamepad";

export interface FakePad extends PadBridge {
	/** Deliver one action to every listener, in the order the service would. */
	push(action: PadAction): void;
	/** Every `setFeedback`, in order. */
	readonly feedback: PadUiSignal[];
	/** Every buzz, by name. */
	readonly buzzes: PadRumbleEvent[];
	/** Every `setPalette`, in order: one per real theme change, and no others. */
	readonly palettes: PadPalette[];
	/** Replace the status and tell the subscribers, the way the service does. */
	setStatus(phase: PadServicePhase, battery?: Ds4Battery): void;
}

export interface FakePadOptions {
	allowApprove?: boolean;
	phrases?: readonly string[];
	phase?: PadServicePhase;
	battery?: Ds4Battery;
}

export function fakePad(options: FakePadOptions = {}): FakePad {
	const handlers = new Set<(action: PadAction) => void>();
	const listeners = new Set<() => void>();
	const feedback: PadUiSignal[] = [];
	const buzzes: PadRumbleEvent[] = [];
	const palettes: PadPalette[] = [];
	let status: PadServiceStatus = { phase: options.phase ?? "connected" };
	if (options.battery) status = { ...status, battery: options.battery };

	let allowApprove = options.allowApprove ?? false;

	return {
		get allowApprove() {
			return allowApprove;
		},
		setAllowApprove: (next) => {
			allowApprove = next;
		},
		phrases: options.phrases ?? [],
		feedback,
		buzzes,
		palettes,
		push(action) {
			for (const handler of [...handlers]) handler(action);
		},
		onAction(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		status: () => status,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setStatus(phase, battery) {
			// A new object every time, as the service does when something changed —
			// `useSyncExternalStore` compares by identity and would otherwise skip
			// the render these tests are waiting for.
			status = battery ? { phase, battery } : { phase };
			for (const listener of [...listeners]) listener();
		},
		setFeedback: (ui) => {
			feedback.push(ui);
		},
		setPalette: (palette) => {
			palettes.push(palette);
		},
		buzz: (name) => {
			buzzes.push(name);
		},
	};
}

/**
 * One action, with the defaults a thumb would give it: a fresh press of ✕,
 * which is the press that began just now and is therefore aimed at whatever is
 * on screen.
 */
export function padAction(kind: PadAction["kind"], overrides: Partial<PadAction> = {}): PadAction {
	return { kind, button: "cross", phase: "press", heldMs: 0, ...overrides };
}
