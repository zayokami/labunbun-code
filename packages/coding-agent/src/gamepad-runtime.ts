/**
 * The controller, as the app layer builds and owns it.
 *
 * Everything about *reading* a pad lives in `@labunbun/gamepad`; what lives here
 * is the part that only the application knows: where the settings come from,
 * what the user is told when the pad does not come up, and how `/gamepad` reads
 * the thing back. The tui never sees a source, a clock or a service — it is
 * handed the bridge and nothing else.
 *
 * Two decisions are worth stating because they are not visible in the code:
 *
 * The source is created *here*, with `importNodeHid` as the loader, so the one
 * optional dependency in the repository is imported from exactly one place, and
 * lazily: `enable()` is what asks for it, and by then the REPL is on screen. A
 * machine without node-hid runs everything else exactly as before.
 *
 * The samples `/gamepad watch` shows are *polled*, not subscribed. A DualShock
 * streams ~250 reports a second and the watch is a line of text a person reads;
 * asking for the last sample ten times a second costs one object read and cannot
 * flood a transcript, whereas a subscription would have to grow its own throttle
 * and its own dedupe anyway.
 */

import {
	bindingText,
	createNodeHidSource,
	createPadBridge,
	DEFAULT_BINDINGS,
	DS4_BATTERY_FULL,
	type Ds4TouchPoint,
	describePadDevice,
	importNodeHid,
	isPadTouchId,
	type PadBinding,
	type PadBindingMap,
	type PadBridge,
	type PadClock,
	type PadPalette,
	type PadSample,
	type PadService,
	type PadServiceStatus,
	type PadSource,
	padBatteryLow,
	resolveBindings,
} from "@labunbun/gamepad";
import { formatElapsed } from "@labunbun/tui";
import type { Settings } from "./settings.ts";

/** The `gamepad` block, with the defaults folded in and the bindings resolved. */
export interface PadConfig {
	/** Read a controller this run. */
	enabled: boolean;
	/** Whether ✕ may answer a permission dialog. */
	allowApprove: boolean;
	/** Path, or a substring of one, of the controller to open. */
	device?: string;
	deadzone?: number;
	/** Whether the pad may buzz, and whether it may light. Both on by default. */
	rumble: boolean;
	lightbar: boolean;
	phrases: readonly string[];
	/** Every button, with the user's overrides applied. */
	bindings: PadBindingMap;
	/**
	 * Overrides that could not be read, one line each. `/doctor` prints them and
	 * `/gamepad` prints them — a binding a user typed wrong has to be visible
	 * somewhere, and "the button does nothing" is not visible enough.
	 */
	problems: string[];
}

/**
 * The settings, as the pad layer wants them.
 *
 * `knownCommands` is passed by the app so a `command:` binding to a command that
 * no longer exists is reported rather than silently doing nothing; omitted, any
 * command text is taken at its word. The bindings are deliberately not validated
 * by the settings schema — see `SettingsSchema`, where the same bargain is
 * struck — so this is where a typo becomes a sentence.
 */
export function padConfigFrom(settings: Settings, knownCommands?: readonly string[]): PadConfig {
	const gamepad = settings.gamepad ?? {};
	const { bindings, problems } = resolveBindings(gamepad.bindings, knownCommands);
	return {
		// `=== true` rather than a truthy read: the schema rejects a string, but a
		// settings object built in code (a test, an embedder) has not been through
		// it, and "enabled: \"yes\"" must not read as on.
		enabled: gamepad.enabled === true,
		allowApprove: gamepad.allowApprove === true,
		device: gamepad.device,
		deadzone: gamepad.deadzone,
		// `!== false`, where the two above are `=== true`: these default to on, so the
		// question is whether the user turned them *off*, and an unreadable value
		// (a hand-built settings object, a string the schema would have rejected)
		// leaves the pad behaving the way the documentation says it does.
		rumble: gamepad.rumble !== false,
		lightbar: gamepad.lightbar !== false,
		phrases: gamepad.phrases ?? [],
		bindings,
		problems,
	};
}

export interface PadRuntimeDeps {
	/** The theme's colours at startup, for the lightbar. */
	palette: PadPalette;
	/**
	 * Where controllers come from. Injected so a test can run the whole app layer
	 * against the faux source — no hardware, no node-hid, no clock.
	 */
	source?: PadSource;
	clock?: PadClock;
}

export interface PadRuntime {
	bridge: PadBridge;
	service: PadService;
	config: PadConfig;
	/**
	 * Turn the controller on or off for this run, keeping `config.enabled` in step
	 * so `/gamepad status` reports what is happening rather than what was written
	 * in a file once. `enable` never rejects: a pad that cannot be opened is a
	 * status, not an exception. Persisting the choice is the caller's business —
	 * `--gamepad` must not write anything.
	 */
	setEnabled(next: boolean): Promise<void>;
	/** The user turned approvals on or off. Both halves, so they cannot drift. */
	setAllowApprove(next: boolean): void;
	/** The process is leaving: motors off, handle closed. */
	close(): void;
}

export function createPadRuntime(config: PadConfig, deps: PadRuntimeDeps): PadRuntime {
	const source = deps.source ?? createNodeHidSource({ load: importNodeHid });
	const { service, bridge } = createPadBridge({
		source,
		bindings: config.bindings,
		palette: deps.palette,
		device: config.device,
		deadzone: config.deadzone,
		allowApprove: config.allowApprove,
		rumble: config.rumble,
		lightbar: config.lightbar,
		phrases: config.phrases,
		clock: deps.clock,
	});

	return {
		bridge,
		service,
		config,
		async setEnabled(next) {
			config.enabled = next;
			// `warmUp` is where a missing optional dependency is discovered, and it is
			// swallowed by the service into a status rather than thrown — so this
			// promise resolving says nothing about whether there is a pad.
			if (next) await service.enable();
			else service.disable();
		},
		setAllowApprove(next) {
			config.allowApprove = next;
			bridge.setAllowApprove(next);
		},
		close() {
			service.close();
		},
	};
}

/**
 * What to tell the user right after the controller was turned on, or `undefined`
 * when there is nothing worth saying.
 *
 * The three ways this fails do not look alike in the status, and the difference
 * is the point: a missing optional dependency is `off` (nothing to retry), a
 * controller that is not there is `searching` (the service tries again every few
 * seconds), and one that refused to open is `error`. All three are news — the
 * user asked for a pad and does not have one — but only the middle one is news
 * that resolves itself, so it says so.
 *
 * The sentences themselves are the gamepad layer's (`NODE_HID_MISSING`,
 * `noDeviceDetail`): a message about a missing module has to name the command
 * that installs it, and the layer that knows the module is the only one that can
 * write it. What this adds is the prefix and the reading.
 */
export function padStartupNotice(status: PadServiceStatus): string | undefined {
	if (status.detail === undefined) return undefined;
	if (status.phase === "searching") return `Gamepad: ${status.detail} — looking again every few seconds`;
	return `Gamepad unavailable: ${status.detail}`;
}

/**
 * One line describing what the pad is doing, for `/gamepad watch`.
 *
 * Every field is one a person verifying a mapping needs: the transport (which is
 * also the payload layout), how long the report was (the quickest way to see the
 * transport change under a Bluetooth reconnect), the buttons, the axes, the
 * battery, whether the CRC checked out, and where the fingers are. Identical
 * samples produce identical lines, which is what lets the caller print on change
 * instead of on report.
 *
 * The touch points are printed whether or not anything is touching them. A line
 * that only mentioned a finger when there was one would leave "the pad is not
 * being touched" and "the decoder is reading the wrong bytes" looking exactly
 * alike — and reading those bytes *is* what this line is for, until the offsets
 * have argued with real hardware. `—` is the pad saying "no finger here", which
 * is a fact, not a gap.
 */
export function formatSample(sample: PadSample): string {
	const { state } = sample;
	const held = state.buttons.length > 0 ? state.buttons.join("+") : "—";
	const axis = (stick: { x: number; y: number }) => `${stick.x.toFixed(2)},${stick.y.toFixed(2)}`;
	const battery = `battery ${state.battery.level}/${DS4_BATTERY_FULL}${state.battery.cable ? " (cable)" : ""}`;
	const crc = sample.crcOk === undefined ? "" : ` · crc ${sample.crcOk ? "ok" : "bad"}`;
	const at = (point: Ds4TouchPoint | undefined) => (point === undefined ? "—" : `${point.x},${point.y}`);
	const touch = `touch 1 ${at(state.touch[0])} 2 ${at(state.touch[1])}`;
	const gestures = sample.gestures === undefined ? "" : ` · gesture ${sample.gestures.join("+")}`;
	return (
		`${sample.transport} ${sample.bytes}B · ${held} · dpad ${state.dpad ?? "—"}` +
		` · L ${axis(state.leftStick)} · R ${axis(state.rightStick)}` +
		` · L2 ${state.leftTrigger.toFixed(2)} R2 ${state.rightTrigger.toFixed(2)}` +
		` · ${battery} · ${touch}${gestures}${crc}`
	);
}

/**
 * How often `/gamepad watch` looks at the last sample.
 *
 * Ten times a second, which is not a frame rate: the line it prints is a
 * debugging view a person reads while pressing one button at a time, and a
 * report arrives roughly every 4 ms — fast enough to feel live, slow enough that
 * a held stick prints a readable trickle rather than a flood.
 */
export const PAD_WATCH_POLL_MS = 100;

/** `/gamepad watch`'s on/off, which is state rather than a subscription. */
export interface PadWatch {
	/** Toggle, and answer whether watching is now on. */
	toggle(): boolean;
	stop(): void;
	readonly watching: boolean;
}

/**
 * Every change to the pad, as a line at a time.
 *
 * Polled, and that is the design: a DualShock streams about 250 reports a
 * second, and what a person reading the screen wants is the moment a *field*
 * changes, not the moment a report arrives. `lastSample` is what the service
 * already keeps for exactly this, and comparing the rendered line is the whole
 * throttle — a resting pad repeats itself byte for byte, so nothing is printed.
 *
 * `report` is called with the line rather than given the sample, so the caller
 * cannot format it differently from the one `formatSample` dedupes on; two
 * formatters would print a line the throttle does not recognize as a repeat.
 */
export function createPadWatch(
	service: PadService,
	report: (line: string) => void,
	pollMs = PAD_WATCH_POLL_MS,
): PadWatch {
	let timer: ReturnType<typeof setInterval> | undefined;
	let line: string | undefined;

	const stop = (): void => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		line = undefined;
	};

	return {
		toggle() {
			if (timer !== undefined) {
				stop();
				return false;
			}
			line = undefined;
			timer = setInterval(() => {
				const sample = service.lastSample();
				if (!sample) return;
				const next = formatSample(sample);
				if (next === line) return;
				line = next;
				report(next);
			}, pollMs);
			// A debug view must not be the reason the process stays alive.
			timer.unref?.();
			return true;
		},
		stop,
		get watching() {
			return timer !== undefined;
		},
	};
}

/**
 * One line saying where the controller is, or why it is not.
 *
 * `/gamepad on` answers with this, and `/gamepad status` opens with it: the
 * question both are answering is the same one, and a user who turned the pad on
 * and got "Gamepad connected — DualShock 4 v2 (interface 3)" has learned
 * everything the toggle had to tell them.
 */
export function padHeadline(status: PadServiceStatus): string {
	const notice = padStartupNotice(status);
	if (notice) return notice;
	if (status.phase === "connected") {
		return `Gamepad connected — ${status.device ? describePadDevice(status.device) : "unknown device"}`;
	}
	return `Gamepad ${status.phase}`;
}

/**
 * The block `/gamepad status` prints.
 *
 * Written as one function rather than assembled at the call site so the same
 * answers can be asserted in a test without a REPL: this is the text a user
 * reads when the pad is not doing what they expected, and "it says off while the
 * light is on" is the bug that would make them stop trusting it.
 */
export function formatPadStatus(
	status: PadServiceStatus,
	config: PadConfig,
	service: PadService,
	/**
	 * The clock, passed in rather than read here — the same rule the mapper and the
	 * feedback follow, and the reason a test can ask what the card says a minute
	 * later without waiting for one. Required, because the age it prints is measured
	 * against whatever clock stamped the pad's writes: a caller with a fake one must
	 * not be handed the machine's by an omission.
	 */
	now: number,
): string {
	const lines: string[] = [padHeadline(status)];
	if (status.transport)
		lines.push(
			`  transport: ${status.transport}${status.crcOk === undefined ? "" : ` (crc ${status.crcOk ? "ok" : "bad"})`}`,
		);
	// Only when the pad answers on more than one link: the controller is attached
	// twice — a cable and the radio — and is being written to on both. Worth
	// saying out loud, because it is the state in which "the lightbar does
	// nothing" used to be invisible.
	if (status.links !== undefined && status.links.length > 1) {
		const reading = status.transport === undefined ? "" : ` (reading ${status.transport})`;
		lines.push(`  links: ${status.links.join(" + ")}${reading}`);
	}
	// The one state where "which controller is this" has an answer worth having:
	// two links, one of them saying buttons the other has not heard of. Nothing
	// can be picked automatically — nothing says which one the user means — so the
	// way out is named instead.
	if (status.linksDisagree) {
		lines.push("  both links report — these may be two controllers (pin one with the device filter)");
	}
	if (status.device?.path) lines.push(`  path: ${status.device.path}`);
	if (status.battery) {
		lines.push(
			`  battery: ${status.battery.level}/${DS4_BATTERY_FULL}${status.battery.cable ? " (cable)" : ""}${padBatteryLow(status.battery) ? " — low" : ""}`,
		);
	}
	if (status.detail) lines.push(`  detail: ${status.detail}`);

	const stats = service.stats();
	// The write age is the other half of "is the pad hearing me": reports say the
	// pad is talking, and a write is the only proof anything went back. Never is a
	// real answer, and the one worth seeing — it is what a pad that is connected
	// but has been told nothing looks like. Long gaps are normal: idle is silent.
	// (`formatElapsed` is what holds a negative age at `0s`; it already floors at
	// zero, and a guard here would be a second, untested copy of that rule.)
	const wrote = stats.lastWriteAt === undefined ? "never" : `${formatElapsed(now - stats.lastWriteAt)} ago`;
	// The separator belongs to the phrase rather than to the line, so the whole thing
	// is one template: a `+` here reads as arithmetic and renders as a stutter.
	const lastError = stats.lastError ? ` · last error: ${stats.lastError}` : "";
	lines.push(`  reports: ${stats.reports} · last write: ${wrote}${lastError}`);
	lines.push(
		`  approvals: ${config.allowApprove ? "on — ✕ may answer a permission dialog" : "off — the keyboard answers"}`,
	);
	// Only when one of them is off: both on is the documented default and needs no
	// line. But "why is the controller silent" is exactly the question this card is
	// read for, and the answer here is a setting three screens away from it.
	if (!config.rumble || !config.lightbar) {
		const off: string[] = [];
		if (!config.lightbar) off.push("lightbar");
		if (!config.rumble) off.push("rumble");
		lines.push(`  feedback: ${off.join(" + ")} off (settings)`);
	}
	lines.push(`  device filter: ${config.device ?? "(any DualShock 4)"}`);
	// Two families now, and the line names both. "25 controls" would be shorter and
	// would hide the surface entirely — and someone reading this line because a
	// gesture is not firing should be able to see that gestures are bound at all.
	const bound = Object.keys(config.bindings);
	const gestures = bound.filter((control) => isPadTouchId(control)).length;
	const changed = changedBindings(config.bindings).length;
	lines.push(
		`  bindings: ${bound.length - gestures} buttons + ${gestures} touch gestures` +
			`${changed > 0 ? `, ${changed} changed from the default` : ""}` +
			`${config.problems.length > 0 ? `, ${config.problems.length} unreadable` : ""}`,
	);
	for (const problem of config.problems) lines.push(`    ${problem}`);
	return lines.join("\n");
}

/**
 * `DEFAULT_BINDINGS` read by name, for the callers whose key is a `string`.
 *
 * A `PadInputId` is the name of a row in that table, so looking one up is total —
 * but the callers here start from `Object.entries`, which hands back string keys,
 * and a string is not proof of membership. This is where that difference lives,
 * so no other line has to pretend it does not exist: a name that is not in the
 * table has no default, which is an answer ("this is not a control") and not a
 * crash.
 */
const DEFAULTS_BY_NAME: Readonly<Record<string, PadBinding | undefined>> = DEFAULT_BINDINGS;

/**
 * Whether a control still does what it does out of the box.
 *
 * Compared as text — the same text the settings file writes — so "changed" means
 * "a line in the mapping table that would surprise the user", which is what both
 * `/gamepad` and `/doctor` are trying to show.
 */
export function isDefaultBinding(control: string, binding: PadBinding): boolean {
	const fallback = DEFAULTS_BY_NAME[control];
	return fallback !== undefined && bindingText(binding) === bindingText(fallback);
}

/** Which controls the user moved, as `control → action` lines. */
export function changedBindings(bindings: PadBindingMap): string[] {
	return Object.entries(bindings)
		.filter(([control, binding]) => !isDefaultBinding(control, binding))
		.map(([control, binding]) => `${control} → ${bindingText(binding)}`);
}
