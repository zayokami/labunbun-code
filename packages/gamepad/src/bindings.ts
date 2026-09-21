/**
 * Which button does what, and how a user's override gets in.
 *
 * The map is total: every button and every touch gesture has an entry, and
 * "nothing" is an action (`none`) rather than a missing key. Totality means the
 * mapper never asks "was this unbound?" — and a control a user deliberately
 * unbinds is as quiet as one they never bound, which is the only reading of
 * `"none"` that makes sense.
 *
 * An override that cannot be read is *dropped*: the control keeps its default and
 * the text lands in `problems`. A typo should cost the user the one binding they
 * were editing, never the confirm button they were not.
 */

import { DS4_BUTTON_IDS, type Ds4ButtonId } from "./ds4.ts";
import { PAD_TOUCH_IDS, type PadTouchId } from "./touch.ts";

/**
 * Everything that can be bound: the pad's own controls, and the surface's
 * gestures. One union rather than two families threaded through separately,
 * because a binding table that could hold a button *or* a gesture and a mapper
 * that had to ask which is exactly the kind of split this layer exists to avoid.
 */
export type PadInputId = Ds4ButtonId | PadTouchId;

/** Every bindable control, buttons first — what the settings table and the problem line list. */
export const PAD_INPUT_IDS: readonly PadInputId[] = [...DS4_BUTTON_IDS, ...PAD_TOUCH_IDS];

/**
 * Everything a button can be asked to do. The type is derived from the list, so
 * the two cannot drift; the order is the order `/gamepad` prints.
 */
export const PAD_ACTION_KINDS = [
	"confirm",
	"cancel",
	"interrupt",
	"up",
	"down",
	"left",
	"right",
	"page-prev",
	"page-next",
	"scroll",
	"wheel",
	"osk",
	"transcript",
	"status",
	"clear",
	"model",
	"mode",
	"theme-next",
	"theme-prev",
	"none",
] as const;

export type PadActionKind = (typeof PAD_ACTION_KINDS)[number];

/**
 * The four navigation slots. They are also the four directional actions, and
 * that is deliberate: the slots are named after the direction the *input* points
 * — the d-pad, or the left stick — while a rebinding changes what stepping in
 * that direction does, not which way the stick points. `up` bound to `confirm`
 * means "pushing the stick up confirms", and if that is not what a user wants
 * they are free to bind it back.
 */
export const PAD_DIRECTIONS: readonly PadDirection[] = ["up", "down", "left", "right"];

export type PadDirection = Extract<PadActionKind, "up" | "down" | "left" | "right">;

export interface PadBinding {
	/** What the button does. `"command"` means the text in `command`. */
	kind: PadActionKind | "command";
	/** Set only for `"command"`: the line to run, e.g. `/theme`. */
	command?: string;
}

/** Totality is the point: see the file comment. */
export type PadBindingMap = Readonly<Record<PadInputId, PadBinding>>;

/**
 * The default mapping, in the order `ds4.ts` lists the buttons and `touch.ts` the
 * gestures. Every line here is a thing a user can change in settings; every line
 * *not* here (the sticks, the analog triggers as modifiers) is not a binding at
 * all and cannot be.
 *
 * `l2` and `r2` are `none` because their real job is the repeat modifier in the
 * mapper, which is not a binding. They are still rebindable — binding one gives
 * it a second job on top of the modifier, which is a user's call to make.
 *
 * `ps` is `none` on purpose: on Windows the system or Steam usually owns it, and
 * a button that half the time opens something else is worse than no button.
 *
 * The surface's four drags answer to the four directions — the same move the
 * d-pad and the stick make, which is what a thumb drawn across a touchpad is
 * asking for. The tap confirms, which is the touchpad *click*'s neighbour and the
 * gesture a finger makes before a press has even occurred to anyone.
 */
export const DEFAULT_BINDINGS: PadBindingMap = {
	up: { kind: "up" },
	down: { kind: "down" },
	left: { kind: "left" },
	right: { kind: "right" },
	square: { kind: "clear" },
	cross: { kind: "confirm" },
	circle: { kind: "cancel" },
	triangle: { kind: "wheel" },
	l1: { kind: "page-prev" },
	r1: { kind: "page-next" },
	l2: { kind: "none" },
	r2: { kind: "none" },
	share: { kind: "osk" },
	options: { kind: "transcript" },
	l3: { kind: "model" },
	r3: { kind: "mode" },
	ps: { kind: "none" },
	touchpad: { kind: "status" },
	"touch-tap": { kind: "confirm" },
	"touch-up": { kind: "up" },
	"touch-down": { kind: "down" },
	"touch-left": { kind: "left" },
	"touch-right": { kind: "right" },
	"touch-two-left": { kind: "page-prev" },
	"touch-two-right": { kind: "page-next" },
};

/** `command:` is how a binding asks for a command instead of an action. */
export const PAD_COMMAND_PREFIX = "command:";

/** How a binding reads back — the form `/gamepad` prints and settings accept. */
export function bindingText(binding: PadBinding): string {
	return binding.kind === "command" ? `${PAD_COMMAND_PREFIX}${binding.command ?? ""}` : binding.kind;
}

export interface ResolvedBindings {
	bindings: PadBindingMap;
	/**
	 * Overrides that made no sense, in the order they appeared. One line each,
	 * ready to print — `/doctor` is the intended reader. Empty is normal.
	 */
	problems: string[];
}

/**
 * `DEFAULT_BINDINGS` with the user's overrides applied.
 *
 * `knownCommands` is the list of commands a `command:` binding may name. Omit it
 * and any command text is taken at its word — which is what the settings UI and
 * the tests want; the app passes its own command table so a binding to a command
 * that no longer exists is reported instead of silently doing nothing.
 */
export function resolveBindings(
	raw?: Readonly<Record<string, unknown>>,
	knownCommands?: readonly string[],
): ResolvedBindings {
	const bindings: Record<PadInputId, PadBinding> = { ...DEFAULT_BINDINGS };
	const problems: string[] = [];
	const commands = knownCommands?.map(withoutSlash);

	for (const [rawKey, rawValue] of Object.entries(raw ?? {})) {
		const problem = (message: string) => problems.push(`bindings.${rawKey}: ${message}`);
		const key = rawKey.trim().toLowerCase();
		const control = PAD_INPUT_IDS.find((id) => id === key);
		if (!control) {
			problem(`not a button or gesture (expected one of: ${PAD_INPUT_IDS.join(", ")})`);
			continue;
		}
		if (typeof rawValue !== "string") {
			problem("expected an action name, not a number or a list");
			continue;
		}
		const parsed = parseBinding(rawValue, commands);
		if (typeof parsed === "string") problem(parsed);
		else bindings[control] = parsed;
	}

	return { bindings, problems };
}

function withoutSlash(name: string): string {
	return name.startsWith("/") ? name.slice(1) : name;
}

/**
 * The binding a piece of text asks for, or a line saying why it cannot be read.
 * Returning a message instead of throwing keeps a bad override from taking the
 * whole settings file down with it.
 */
function parseBinding(text: string, commands?: readonly string[]): PadBinding | string {
	const trimmed = text.trim();
	if (trimmed === "") return "expected an action name, not an empty string";

	// `none` and the action names are matched case-insensitively because settings
	// files are written by hand; a command's own text is not, because dispatch
	// is not.
	const lowered = trimmed.toLowerCase();
	if (lowered === "none") return { kind: "none" };

	if (lowered.startsWith(PAD_COMMAND_PREFIX)) {
		const body = trimmed.slice(PAD_COMMAND_PREFIX.length).trim();
		if (body === "") return `expected a command after "${PAD_COMMAND_PREFIX}"`;
		const command = body.startsWith("/") ? body : `/${body}`;
		const name = withoutSlash(command.split(/\s+/)[0] ?? "");
		if (commands && !commands.includes(name)) return `unknown command "/${name}"`;
		return { kind: "command", command };
	}

	const kind = PAD_ACTION_KINDS.find((candidate) => candidate === lowered);
	if (!kind) return `unknown action "${trimmed}"`;
	return { kind };
}
