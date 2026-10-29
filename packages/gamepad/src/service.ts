/**
 * The controller's life: find it, read it, light it, and survive losing it.
 *
 * Three things here are less obvious than they look.
 *
 * The service owns *both* halves of the signal the pad shows. The app supplies
 * the phase and whether something is waiting for an answer; the battery comes
 * from the reports. They change on different clocks and neither can be trusted
 * to fire the other, so both funnel into one place that compares the merged
 * signal with what the pad was last told — which is also what keeps an idle pad
 * from being written to at all.
 *
 * The tick is not a timer for the mapper. Repeats and holds are settled by the
 * reports themselves (a pad sends 250 a second; that is the clock the user's
 * thumb is on). The tick exists for two other things: the lightbar, which is a
 * function of time rather than of events, and the silence watchdog — a
 * Bluetooth pad that goes out of range does not raise an error, it simply stops
 * talking, and the only way to notice is to have expected something by now.
 *
 * A disconnect is not an error to report to the transcript. It is a state, and
 * the state says what happened; the user's session is not interrupted because
 * they put the controller down.
 */

import { PAD_SWITCH_REPORTS, padIsActive } from "./activity.ts";
import type { PadBindingMap } from "./bindings.ts";
import {
	buildDs4Output,
	type Ds4ButtonId,
	type Ds4Touch,
	type Ds4Transport,
	type PadBattery,
	type PadOutputState,
	type PadReport,
	type PadState,
	type PadTransport,
	parseDs4Input,
} from "./ds4.ts";
import {
	createPadFeedback,
	PAD_RUMBLE,
	type PadPalette,
	type PadRumble,
	type PadRumbleCommand,
	type PadRumbleEvent,
	type PadSignal,
	type PadUiPhase,
	padSignalEqual,
} from "./feedback.ts";
import { createMapper, PAD_DEADZONE, type PadAction, type PadRepeat } from "./mapping.ts";
import {
	deviceFamily,
	devicePadKey,
	deviceTransport,
	hasDeviceFilter,
	matchesDevice,
	type PadFamily,
	type PadSource,
	type PadSourceDevice,
	type PadSourceHandle,
	pickLinks,
} from "./source.ts";
import { createTouchReader, type PadTouchConfig, type PadTouchId } from "./touch.ts";
import { buildXboxOutput, parseXboxInput } from "./xbox.ts";

export type PadServicePhase = "off" | "searching" | "connected" | "error";

/**
 * One attached controller: a pad the source can read, whether or not the app is
 * listening to it. The app reads exactly one at a time and moves when someone
 * uses the other; this is how the UI can say which is which without opening the
 * source itself.
 */
export interface PadControllerStatus {
	/** The grouping key: `ds4`, or `xbox:<slot path>`. See `devicePadKey`. */
	key: string;
	family: PadFamily;
	/** The link the app reads for this pad, or its first link while inactive. */
	device: PadSourceDevice;
	transports: readonly PadTransport[];
	battery?: PadBattery;
	/** Whether this is the pad whose reports move the app. */
	active: boolean;
}

/**
 * What the UI needs to know, and nothing that changes 250 times a second: this
 * object is what `useSyncExternalStore` hands back, so a new identity means a
 * re-render and an old identity means none. It is replaced only when one of
 * these fields actually differs.
 */
export interface PadServiceStatus {
	phase: PadServicePhase;
	/** The device in use, or the one that failed. */
	device?: PadSourceDevice;
	/**
	 * The link the app is *reading*: the one whose reports move the app. See
	 * `links` for the rest — a pad attached twice is written to on all of them.
	 */
	transport?: PadTransport;
	/**
	 * Every link the pad is answering on, the one being read first. More than one
	 * means the controller is attached twice — a cable and the radio — and is
	 * being written to on both.
	 */
	links?: readonly PadTransport[];
	battery?: PadBattery;
	/** Why it is not connected, in words worth showing to the person holding it. */
	detail?: string;
	/** Bluetooth only: whether the last report's CRC verified. */
	crcOk?: boolean;
	/**
	 * Every attached controller, in the order its first link was opened — the pad
	 * being read leads, because its link is the first after `pickLinks` sorted
	 * them. More than one means a second pad is attached and watched: it is being
	 * parsed for battery and for a deliberate press, but its input does not move
	 * the app until someone uses it.
	 */
	controllers?: readonly PadControllerStatus[];
	/**
	 * The links have been reporting contradictory buttons for long enough that
	 * they are probably not one pad. Nothing is done about it — there is no
	 * identity to pick the right one by — but it explains a button nobody pressed
	 * and a bar changing colour by itself, and `gamepad.device` is how a user pins
	 * the one they mean.
	 */
	linksDisagree?: boolean;
}

/** Everything the last report carried, for `/gamepad watch`. */
export interface PadSample {
	/** When it arrived, on the service's clock. */
	at: number;
	/** Which family decoded it; the button names printed for a person depend on it. */
	family: PadFamily;
	transport: PadTransport;
	state: PadState;
	/** How long the report was: the quickest way to see the transport change. */
	bytes: number;
	/**
	 * The gestures this report held, when it held any. Set only then, so a pad
	 * nobody is touching keeps the exact sample shape it had before there were
	 * gestures — which is also what keeps `/gamepad watch` from printing a line
	 * per report on a pad lying on the desk.
	 */
	gestures?: readonly PadTouchId[];
	/** Bluetooth only. `undefined` on USB, where there is nothing to verify. */
	crcOk?: boolean;
}

/** Counters for `/gamepad status` and `/doctor`. Polled, never subscribed. */
export interface PadStats {
	/** Reports read since the current connection began. */
	reports: number;
	lastReportAt?: number;
	/** When the pad was last written to. Long gaps are normal: idle is silent. */
	lastWriteAt?: number;
	/** The last reason the pad went away, or the last open that failed. */
	lastError?: string;
}

export interface PadTimer {
	unref?(): void;
}

/**
 * Everything the service does with time goes through here, which is what lets a
 * test run a minute of pad in a microsecond and hold a button for exactly 600
 * of them.
 */
export interface PadClock {
	now(): number;
	setInterval(handler: () => void, ms: number): PadTimer;
	clearInterval(handle: PadTimer): void;
	setTimeout(handler: () => void, ms: number): PadTimer;
	clearTimeout(handle: PadTimer): void;
}

/**
 * The real clock. Timers are unreferenced: they are background work for a
 * program that is already running, and a tick that outlives the REPL would hold
 * the process open after the user asked it to stop.
 */
export const systemPadClock: PadClock = {
	now: () => Date.now(),
	setInterval(handler, ms) {
		const timer = setInterval(handler, ms);
		timer.unref?.();
		return timer;
	},
	clearInterval(handle) {
		clearInterval(handle as ReturnType<typeof setInterval>);
	},
	setTimeout(handler, ms) {
		const timer = setTimeout(handler, ms);
		timer.unref?.();
		return timer;
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/** The app's half of the signal. The battery is the pad's own business. */
export interface PadUiSignal {
	phase: PadUiPhase;
	/** A dialog is on screen waiting for an answer. */
	awaiting: boolean;
}

export interface PadServiceConfig {
	bindings: PadBindingMap;
	/** The theme's colours, as the lightbar's. */
	palette: PadPalette;
	/** The `device` setting. See `matchesDevice`. */
	device?: string;
	deadzone?: number;
	repeat?: Partial<PadRepeat>;
	/** The touch surface's thresholds. Every one of them is a guess until measured. */
	touch?: PadTouchConfig;
	/** How long to wait before looking for a controller again. */
	reconnectMs?: number;
	/** Shortest gap between writes. The bar is an animation; 30 Hz is smooth. */
	outputMs?: number;
	/**
	 * How long a connected pad may say nothing before we treat it as gone. A
	 * DualShock 4 streams continuously while connected — that is why its battery
	 * lasts hours and not days — so two seconds of quiet is not a pause.
	 */
	silenceMs?: number;
	/**
	 * Whether the pad may buzz, and whether it may light at all. Both default to on,
	 * and off is *silence and darkness* rather than "less of it": the field is left
	 * out of every packet, and a packet describes the whole pad, so there is no way
	 * to withhold one field and leave the pad's own light alone. Someone wiring a
	 * pad they cannot silence would have to unplug it instead.
	 */
	rumble?: boolean;
	lightbar?: boolean;
}

export interface PadServiceDeps {
	source: PadSource;
	clock?: PadClock;
	/** The mapped actions of one report, in the order they happened. */
	onActions?: (actions: PadAction[]) => void;
	/** Every report, unthrottled. Firehose: dedupe before rendering. */
	onReport?: (sample: PadSample) => void;
	onStatus?: (status: PadServiceStatus) => void;
}

export interface PadService {
	/** Look for a controller and start reading. Safe to call twice. */
	enable(): Promise<void>;
	/** The user turned it off. Can be enabled again. */
	disable(): void;
	/** The process is leaving: same, and nothing more is read. */
	close(): void;
	status(): PadServiceStatus;
	stats(): PadStats;
	lastSample(): PadSample | undefined;
	/** Every interface of every controller attached right now. */
	devices(): readonly PadSourceDevice[];
	/**
	 * Move the app to another attached controller, by hand.
	 *
	 * No target, `"next"` or a blank string cycles to the next pad; a decimal
	 * `"1"`..`"N"` picks the n-th controller in `status().controllers`; anything
	 * else matches, case-insensitively, a family word (`xbox`, `ds4`,
	 * `dualshock`, `playstation`), a transport (`usb`, `bluetooth`, `xinput`), or
	 * a substring of the device's name or path — the same matching `device` uses.
	 * `false` only when there is no such controller; naming the one already being
	 * read is a valid request that changes nothing and answers `true`.
	 */
	switchPad(target?: string): boolean;
	/**
	 * Let go of every link and look again, now: the rescue for a pad that is
	 * answering, but answering wrongly — a handle the OS has quietly re-pointed, a
	 * link whose reports stopped short of the watchdog's two seconds. Worse than
	 * nothing can happen to a pad that is working: every link is reopened, and a
	 * reopened pad is told everything again, the signal included.
	 */
	rescan(): void;
	/** What the app is doing, for the lightbar and the buzzes that go with it. */
	setFeedback(ui: PadUiSignal): void;
	/**
	 * The theme's colours, again — a user who changes theme mid-session expects
	 * the bar in their hand to change with the screen in front of them.
	 */
	setPalette(palette: PadPalette): void;
	/**
	 * One of `PAD_RUMBLE`, right now. Unlike the buzzes that follow state
	 * changes, this is a person asking for one, so the gap rule does not apply.
	 */
	buzz(name: PadRumbleEvent): void;
	/** Stop repeating without forgetting what is held. See `PadMapper`. */
	suspendRepeat(): void;
}

const DEFAULT_RECONNECT_MS = 3_000;
const DEFAULT_OUTPUT_MS = 33;
const DEFAULT_SILENCE_MS = 2_000;
/**
 * How long the pad can say nothing before the reports count as having stopped
 * rather than as having been a little late.
 *
 * A live DS4 reports every few milliseconds on either transport, so a quarter of
 * a second is dozens of reports that never came; and it is an eighth of
 * `silenceMs`, where the pad is declared gone and everything is forgotten. This
 * is the gap in between: too short to be a lost pad, too long to be jitter — and
 * what it costs the mapper is time a press was not vouched for (see `holdFrom`).
 */
const REPORT_GAP_MS = 250;
/**
 * How long two links have to disagree about the buttons before the app says out
 * loud that they may be two controllers. One pad's links are a few milliseconds
 * apart at every edge; a second of it is not latency.
 */
const LINKS_DISAGREE_MS = 1_000;
/**
 * How often to look for a link the pad gained while we were already talking to
 * it. Nothing announces that a cable has been plugged into a controller that was
 * on the radio: the OS simply starts listing a second collection of the same
 * device. One OS enumeration a second is invisible next to the writes, and it is
 * the difference between driving every link and driving whichever one happened
 * to be attached when the app looked.
 */
const LINK_SCAN_MS = 1_000;

/** The pad's own colour when it should show nothing: motors stopped, bar dark. */
const DARK: PadOutputState = { lightbar: { r: 0, g: 0, b: 0 } };

/** No fingers: what a family without a touch surface reports, every report. */
const NO_TOUCH: Ds4Touch = [undefined, undefined];

/** No gestures: what a suppressed report carries. It is not read by the surface. */
const NO_GESTURE: readonly PadTouchId[] = [];

/**
 * Whether a finger is on the surface, resting included.
 *
 * This is part of "at rest" but deliberately not part of `padIsActive`: a finger
 * is not a deliberate press for the purpose of choosing a pad, yet it is enough
 * to make one — `touch-tap` is a default binding for confirm. See the one caller.
 */
function hasFinger(state: PadState): boolean {
	return (state.touch ?? []).some((point) => point !== undefined);
}

/**
 * Whether a stick is pushed far enough for the mapper to read a direction from it.
 *
 * `padIsActive` asks for 0.6 before a stick can *choose* a pad; the mapper acts
 * from the deadzone, a quarter of the travel by default. A stick that chose the
 * pad passes back through the band between the two on its way home, and a pad
 * that counted as neutral there would answer with a navigation step for the push
 * that was only meant to pick it up. Both sticks count, on either axis, because
 * "near the center" is what the README promises for each. A deadzone of zero
 * leaves nothing to push past, so only a stick that is off zero counts.
 */
function stickPushed(state: PadState, deadzone: number): boolean {
	return [state.leftStick, state.rightStick].some((stick) => {
		const travel = Math.hypot(stick.x, stick.y);
		return travel > 0 && travel >= deadzone;
	});
}

/**
 * One open collection of the pad: a link, and the shape its bytes take on it.
 *
 * A controller can have more than one at a time — see `pickLinks` — and each
 * keeps its own last packet, because "unchanged" is a per-link fact: a link
 * opened a moment ago has been told nothing. The family is part of the link
 * rather than of the device only because it decides both directions: which
 * parser reads a report and which builder writes a packet.
 */
interface PadLinkBase {
	device: PadSourceDevice;
	handle: PadSourceHandle;
	/** Which physical pad this link belongs to. See `devicePadKey`. */
	padKey: string;
	/** The last packet written here, byte for byte. An identical one is skipped. */
	lastPacket?: Uint8Array;
	/** When this link last delivered a report; `undefined` until one parses. */
	lastReportAt?: number;
	/**
	 * Whether this link has been seen at rest since its pad stopped being read.
	 *
	 * Counts only start from an armed link, which is what makes a button *held*
	 * through a switch different from a button *pressed* after it: the held one
	 * never sees a neutral report, so it can never arm. Every switch disarms the
	 * pads it leaves behind.
	 */
	armed: boolean;
	/**
	 * Consecutive deliberate reports from an armed link, reset by an idle one.
	 *
	 * A switch happens on exactly `PAD_SWITCH_REPORTS`: the count starts at zero
	 * the moment the link is armed, so a pad lying around cannot accumulate a
	 * switch out of stray jolts.
	 */
	activeRun: number;
}

interface Ds4Link extends PadLinkBase {
	family: "ds4";
	/** How this link's packets are framed. See `linkTransport`. */
	transport: Ds4Transport;
}

interface XInputLink extends PadLinkBase {
	family: "xbox";
	/** XInput does not say which wire it is; the transport is the API. */
	transport: "xinput";
}

type PadLink = Ds4Link | XInputLink;

/**
 * What a link's packets are framed as, once a report has said something.
 *
 * The device's own description decides it first, and a report can only ever
 * *add* Bluetooth: a DualShock 4 switched on over the radio sends its USB-shaped
 * report until something writes to it, so a report that parses as USB on a link
 * the OS calls Bluetooth is the power-on mode talking, not the link changing its
 * mind. Writing the Bluetooth shape at that link is what ends that mode — which
 * is why the framing has to be decided before the first report arrives rather
 * than from it, and why a USB-shaped report never takes it back to 32-byte
 * packets that the pad would listen to only over a cable.
 */
function linkTransport(link: Ds4Link, seen: Ds4Transport): Ds4Transport {
	return seen === "bluetooth" ? "bluetooth" : link.transport;
}

/**
 * The packet a link understands. The meaning is one app state; the bytes are
 * the family's, and XInput's are a four-byte vibration rather than a report.
 */
function buildLinkOutput(link: PadLink, state: PadOutputState): Uint8Array {
	return link.family === "xbox" ? buildXboxOutput(state) : buildDs4Output(link.transport, state);
}

/**
 * Why there is no controller to open, in the words that get the user unstuck.
 * The middle case is the one worth the words: a pad that another program is
 * holding enumerates as a device with no path, and "no controller attached"
 * would send someone to check a cable that is already plugged in.
 */
export function noDeviceDetail(devices: readonly PadSourceDevice[], wanted?: string): string {
	if (hasDeviceFilter(wanted) && devices.length > 0) return `no controller matching "${wanted}"`;
	if (devices.some((device) => device.path === undefined)) {
		return "a controller is attached but another program is holding it — close Steam or DS4Windows and try again";
	}
	return "no controller attached";
}

export function createPadService(config: PadServiceConfig, deps: PadServiceDeps): PadService {
	const clock = deps.clock ?? systemPadClock;
	const reconnectMs = config.reconnectMs ?? DEFAULT_RECONNECT_MS;
	const outputMs = config.outputMs ?? DEFAULT_OUTPUT_MS;
	const silenceMs = config.silenceMs ?? DEFAULT_SILENCE_MS;
	// `!== false` rather than a truthy read: the default is on, so the question is
	// whether the user turned it off — and a settings object built in code (a test,
	// an embedder) has not been through the schema that would have rejected a
	// string. A value we cannot read leaves the feature as the documentation
	// describes it.
	const rumbleOn = config.rumble !== false;
	const lightbarOn = config.lightbar !== false;
	// One palette object, copied and then mutated in place rather than replaced:
	// the feedback reads it on every frame, and its own bookkeeping (how recently
	// it buzzed) lives in a closure that a theme change must not reset.
	const palette: PadPalette = { ...config.palette };
	const feedback = createPadFeedback(palette);
	const deadzone = config.deadzone ?? PAD_DEADZONE;
	const mapper = createMapper({ bindings: config.bindings, deadzone, repeat: config.repeat });
	// The surface's gestures, read before the mapper sees a report. They come out
	// as ids the mapper treats exactly like buttons, which is why nothing above
	// this line had to learn about the touchpad at all.
	const touch = createTouchReader(config.touch);

	let enabled = false;
	let closed = false;
	/** Every open link of every attached pad. Grouped by `padKey`, one or two per pad. */
	let links: PadLink[] = [];
	/** The pad whose reports move the app. `undefined` when no controller is read. */
	let activeKey: string | undefined;
	/**
	 * The link the app reads. One at a time, and only one, and always one of the
	 * active pad's: both links of a pad attached twice carry the same buttons a
	 * few milliseconds apart, and the mapper works on edges — a report from the
	 * other link is the same state seen late, which reads as a release and then as
	 * the press again. A second copy of one press is exactly the kind of thing a
	 * user notices and cannot explain.
	 */
	let primary: PadLink | undefined;
	let sample: PadSample | undefined;
	/** The battery each pad last reported, whether or not it is the pad being read. */
	const padBattery = new Map<string, PadBattery>();
	/**
	 * When the active pad's silence budget began. A switch gives the new pad a
	 * budget of its own instead of inheriting the age of the pad it replaced.
	 */
	let activeSince = 0;
	/**
	 * Set when the app moves to another pad, and cleared by the first report that
	 * shows that pad at rest.
	 *
	 * A switch is usually made *with* the pad: the press that chose it is a real
	 * press, and its release may come later. That press must not answer a dialog
	 * that was already open on the screen — so the new pad has to be seen idle
	 * once before any of its input is fed to the mapper. The idle report itself is
	 * fed through (and produces nothing), which is how the mapper's state and the
	 * pad agree from the first frame that matters.
	 */
	let suppressUntilNeutral = false;
	/**
	 * When the link nobody is reading started saying something the one being read
	 * does not: `undefined` while they agree. Only ever about links of the *same*
	 * pad — two pads disagreeing is the normal state of the world, not a fault.
	 *
	 * Two links of one pad report the same buttons a few milliseconds apart, so a
	 * disagreement is expected for about as long as the slower link takes to catch
	 * up. One that lasts is something else — two controllers, both answering to
	 * "DualShock 4", picked up as two links of one pad because nothing on either
	 * says which device it belongs to.
	 */
	let disagreeingSince: number | undefined;
	/** The signal the pad has been told about. `undefined` = it has not been told. */
	let signal: PadSignal | undefined;
	let ui: PadUiSignal = { phase: "idle", awaiting: false };
	/** The motors as currently commanded, or `undefined` for "stopped". */
	let motors: PadRumble | undefined;
	let stopMotors: PadTimer | undefined;
	/** The silence before the second half of a two-part pattern. See `PAD_RUMBLE.stopped`. */
	let againAfter: PadTimer | undefined;
	let wroteAt: number | undefined;
	let openedAt = 0;
	let scannedAt = 0;
	let tick: PadTimer | undefined;
	let retry: PadTimer | undefined;
	let status: PadServiceStatus = { phase: "off" };
	let stats: PadStats = { reports: 0 };

	function setStatus(patch: Partial<PadServiceStatus>): void {
		const next: PadServiceStatus = { ...status, ...patch };
		// Derived every time rather than patched by hand: any report can change a
		// battery, and any link change can change the set of pads.
		next.controllers = activeKey === undefined ? undefined : controllersStatus();
		if (sameStatus(status, next)) return;
		status = next;
		deps.onStatus?.(status);
	}

	/** The links of one pad, or of the active pad when none is named. */
	function padLinks(key: string | undefined): PadLink[] {
		if (key === undefined) return [];
		return links.filter((link) => link.padKey === key);
	}

	function activeLinks(): PadLink[] {
		return padLinks(activeKey);
	}

	/** The pads attached right now, in the order their first link was opened. */
	function padKeys(): string[] {
		const keys: string[] = [];
		for (const link of links) if (!keys.includes(link.padKey)) keys.push(link.padKey);
		return keys;
	}

	/** A pad's transports, the link being read first — the order the status card shows. */
	function padTransports(pad: readonly PadLink[], reader: PadLink | undefined): PadTransport[] {
		const transports = pad.map((link) => link.transport);
		if (reader === undefined) return transports;
		return [reader.transport, ...transports.filter((transport) => transport !== reader.transport)];
	}

	/** Every attached pad, as the UI sees it. Built from the links, never stored. */
	function controllersStatus(): PadControllerStatus[] {
		return padKeys().map((key) => {
			const pad = padLinks(key);
			const reader = key === activeKey && primary !== undefined && pad.includes(primary) ? primary : undefined;
			const lead = reader ?? pad[0];
			return {
				key,
				family: lead.family,
				device: lead.device,
				transports: padTransports(pad, reader),
				battery: padBattery.get(key),
				active: key === activeKey,
			};
		});
	}

	/**
	 * One link again, or none: there is nobody left to disagree with, and a status
	 * still saying "these may be two controllers" would outlive the second
	 * controller. Called from the two places the set of links changes shape rather
	 * than from each of them by hand.
	 */
	function forgetSecondOpinion(): void {
		disagreeingSince = undefined;
		setStatus({ linksDisagree: undefined });
	}

	/**
	 * The non-reading link's buttons, against the ones the app is reading. Called
	 * for every report that is ignored for being the second opinion, which is the
	 * only moment that opinion exists.
	 */
	function noteSecondOpinion(buttons: readonly Ds4ButtonId[], now: number): void {
		const reading = sample?.state.buttons;
		if (reading === undefined) return;
		const agrees = buttons.length === reading.length && buttons.every((button, at) => reading[at] === button);
		if (agrees) {
			if (disagreeingSince !== undefined) forgetSecondOpinion();
			return;
		}
		disagreeingSince ??= now;
		if (now - disagreeingSince >= LINKS_DISAGREE_MS) setStatus({ linksDisagree: true });
	}

	/** The app's half of the signal, joined to what the pad says about itself. */
	function currentSignal(): PadSignal {
		const battery = status.battery;
		return battery === undefined ? { ...ui } : { ...ui, battery };
	}

	/** Tell the pad what the app is doing, if that is news. */
	function pushSignal(): void {
		const next = currentSignal();
		// "News" is measured against what this pad has been *told*, not against the
		// last signal: a pad that has been written to nothing is told, even when the
		// news is what its predecessor already heard. A controller unplugged and
		// plugged back in has no memory of the colour, and its first report is the
		// first moment there is a transport to say it on.
		const told = activeLinks().some((link) => link.lastPacket !== undefined);
		if (told && signal !== undefined && padSignalEqual(signal, next)) return;
		const command = feedback.rumble(signal, next, clock.now());
		signal = next;
		if (command !== undefined) buzzCommand(command);
		flush(clock.now());
	}

	/** Motors on, and off again after `durationMs`. The one place a buzz is timed. */
	function rumbleFor(rumble: PadRumble, durationMs: number): void {
		motors = rumble;
		flush(clock.now(), true);
		if (stopMotors !== undefined) clock.clearTimeout(stopMotors);
		stopMotors = clock.setTimeout(() => {
			stopMotors = undefined;
			motors = undefined;
			flush(clock.now(), true);
		}, durationMs);
	}

	function buzzCommand(command: PadRumbleCommand): void {
		if (!rumbleOn) return;
		// Whatever was playing is replaced rather than queued, and its second half —
		// if it had one — goes with it: a pattern interrupted halfway is a pattern
		// the user would hear the tail of under the next one.
		if (againAfter !== undefined) {
			clock.clearTimeout(againAfter);
			againAfter = undefined;
		}
		rumbleFor(command.rumble, command.durationMs);
		const again = command.again;
		if (again === undefined) return;
		againAfter = clock.setTimeout(() => {
			againAfter = undefined;
			rumbleFor(command.rumble, again.durationMs);
		}, command.durationMs + again.afterMs);
	}

	/**
	 * Write what the bar and the motors should be doing, on every link of the pad
	 * the app is reading.
	 *
	 * One app state, one packet per link: the framing differs — 32 bytes for USB,
	 * 78 with a CRC for Bluetooth — and the meaning does not. Nothing here can
	 * tell which link the pad obeys; the OS accepts writes on all of them and
	 * reports only that the bytes were taken, never that the pad listened. So it
	 * is told on all of them, and the bar follows whichever one it chose.
	 *
	 * Inactive pads are deliberately not written to here. They get one dark packet
	 * when they are opened (see `wakeInactivePads`), which is all a Bluetooth pad
	 * needs to stop sending its unreadable power-on reports; a bar animation in a
	 * bag is a battery drain nobody asked for.
	 *
	 * Compared as bytes rather than as intent, because that is what the pad
	 * receives: "unchanged" has to mean the same packet, and the motors are part
	 * of it. The comparison is per link, and the packet a link was last told is
	 * never written twice — the first write to a link is the one that ends its
	 * silent power-on mode, and it is the one that must not be skipped.
	 */
	function flush(now: number, immediate = false): void {
		const targets = activeLinks();
		if (targets.length === 0) return;
		const signal = currentSignal();
		const state: PadOutputState = {};
		// A field left out is a field written as zero, which is what the lightbar
		// switch wants: dark rather than dim. There is no way to write "nothing here"
		// and have the pad keep its own. The motors switch is not asked here — the one
		// thing that ever turns them on is `buzzCommand`, and it returns before that
		// when it is off, so a `motors` that reached this line is a `motors` to write.
		if (lightbarOn) {
			state.lightbar = feedback.lightbar(signal, now);
			const blink = feedback.blink(signal);
			if (blink !== undefined) state.blink = blink;
		}
		if (motors !== undefined) state.rumble = motors;
		const packets = targets.map((link) => ({ link, packet: buildLinkOutput(link, state) }));
		const unchanged = packets.every(
			({ link, packet }) => link.lastPacket !== undefined && sameBytes(link.lastPacket, packet),
		);
		if (unchanged) return;
		if (!immediate && wroteAt !== undefined && now - wroteAt < outputMs) return;
		for (const { link, packet } of packets) {
			link.lastPacket = packet;
			link.handle.write(packet);
		}
		wroteAt = now;
		stats = { ...stats, lastWriteAt: now };
	}

	/**
	 * Put one pad's links out: motors stopped, bar dark — and remember the packet,
	 * because the next signal is compared against it, not against what the pad was
	 * last doing while it was being read.
	 */
	function darken(pad: readonly PadLink[]): void {
		for (const link of pad) {
			const packet = buildLinkOutput(link, DARK);
			link.lastPacket = packet;
			link.handle.write(packet);
		}
	}

	/**
	 * One dark packet per link of every pad the app is not reading.
	 *
	 * This is a write-path wakeup, not feedback. A DualShock 4 switched on over
	 * Bluetooth sends its USB-shaped power-on report until a host writes a valid
	 * output report to it, and that report is unreadable here; a pad that is never
	 * written to could therefore never say anything the service can parse, and so
	 * could never be the pad someone picks up. The packet says "motors off, bar
	 * dark" and nothing else, and it is not a switch tap: the pad stays inactive.
	 */
	function wakeInactivePads(): void {
		for (const key of padKeys()) {
			if (key === activeKey) continue;
			darken(padLinks(key));
		}
	}

	/**
	 * Motors off, bar dark, on every pad — written while the devices are still
	 * there to hear it. Turning the feature off is not about the pad being read;
	 * a controller in the bag keeps its light on unless it is told otherwise.
	 */
	function goDark(): void {
		darken(links);
	}

	/**
	 * The most recent report the *active* pad has delivered: what the watchdog
	 * measures. A pad in a bag that is still polling must not keep the pad in the
	 * user's hands alive, and a pad that went quiet while active must still lose.
	 */
	function activeReportAt(): number | undefined {
		let latest: number | undefined;
		for (const link of activeLinks()) {
			if (link.lastReportAt === undefined) continue;
			if (latest === undefined || link.lastReportAt > latest) latest = link.lastReportAt;
		}
		return latest;
	}

	/** The active pad's links, the one being read first: what the status card names. */
	function linkTransports(): PadTransport[] {
		const reader = primary !== undefined && primary.padKey === activeKey ? primary : undefined;
		return padTransports(activeLinks(), reader);
	}

	/** Wire an open handle in as a link of whichever pad its device says it is. */
	function openLink(device: PadSourceDevice, opened: PadSourceHandle): PadLink {
		const shared = { device, handle: opened, padKey: devicePadKey(device), armed: false, activeRun: 0 };
		const link: PadLink =
			deviceFamily(device) === "xbox"
				? { ...shared, family: "xbox", transport: "xinput" }
				: { ...shared, family: "ds4", transport: deviceTransport(device) };
		opened.onReport((bytes) => onBytes(link, bytes));
		opened.onError((error) => dropLink(link, message(error)));
		links.push(link);
		return link;
	}

	function stopTimers(): void {
		if (tick !== undefined) clock.clearInterval(tick);
		if (retry !== undefined) clock.clearInterval(retry);
		if (stopMotors !== undefined) clock.clearTimeout(stopMotors);
		if (againAfter !== undefined) clock.clearTimeout(againAfter);
		tick = undefined;
		retry = undefined;
		stopMotors = undefined;
		againAfter = undefined;
	}

	function startTick(): void {
		if (tick !== undefined) return;
		tick = clock.setInterval(() => {
			const now = clock.now();
			if (links.length > 0 && now - (activeReportAt() ?? activeSince) > silenceMs) {
				// Gone without saying so. Same as a cable: keep what the user had, drop
				// the pad, look again.
				if (padKeys().length > 1) {
					// Another pad is attached and healthy, and losing everything would
					// close it too. Only the silent pad's links go: the last of them hands
					// the app to the next pad, as a pulled cable does.
					for (const link of activeLinks()) dropLink(link, "the controller stopped reporting");
					return;
				}
				lose("the controller stopped reporting");
				return;
			}
			if (now - scannedAt >= LINK_SCAN_MS) {
				scannedAt = now;
				lookForLinks();
			}
			flush(now);
		}, outputMs);
	}

	/**
	 * Look for a pad, or a link of a pad, that appeared while we were already
	 * talking: a cable plugged into a controller that was on the radio, a radio
	 * coming up under a wired one, or a second controller switched on. A pad
	 * answering on every transport it has gains nothing here.
	 */
	function lookForLinks(): void {
		if (closed || links.length === 0) return;
		const known = new Set(links.map((link) => link.device.path));
		for (const device of pickLinks(deps.source.list(), config.device)) {
			if (known.has(device.path)) continue;
			let opened: PadSourceHandle;
			try {
				opened = deps.source.open(device);
			} catch (error) {
				// Worth remembering, not worth acting on: a link we cannot open is not
				// the pad failing, and the one already in hand is still working.
				stats = { ...stats, lastError: message(error) };
				continue;
			}
			const link = openLink(device, opened);
			if (link.padKey === activeKey) {
				// A second link of the pad being read: the next frame's signal reaches
				// it like any other link.
				setStatus({ links: linkTransports() });
				continue;
			}
			// A pad nobody is reading yet still has to be told something once, or a
			// Bluetooth DualShock 4 can never get out of its power-on report mode
			// and can never switch in. See `wakeInactivePads`.
			darken([link]);
			setStatus({});
		}
	}

	/**
	 * One link is gone: the cable was pulled, or the radio dropped it. The pad is
	 * not gone while another link still answers — that is the point of holding more
	 * than one — and nothing is invented about what the user was holding: the mapper
	 * keeps the state it had, so a button still down on the surviving link is that
	 * link's news to tell, and one that went up with the dead link waits for a
	 * report rather than for a guess.
	 */
	function dropLink(link: PadLink, reason: string): void {
		const at = links.indexOf(link);
		if (at === -1) return;
		const key = link.padKey;
		const wasActive = key === activeKey;
		links.splice(at, 1);
		try {
			link.handle.close();
		} catch {
			// Already gone.
		}
		stats = { ...stats, lastError: reason };
		if (links.length === 0) {
			lose(reason);
			return;
		}
		if (!wasActive) {
			// A pad nobody is reading lost a link. The app did not notice its input
			// and does not need a search; when its last link goes, the pad is simply
			// no longer listed.
			if (padLinks(key).length === 0) padBattery.delete(key);
			setStatus({});
			return;
		}
		// The pad being read lost a link: the second opinion it may have had is
		// about a primary that no longer exists.
		disagreeingSince = undefined;
		const remaining = padLinks(key);
		if (remaining.length === 0) {
			// The pad the app was reading is gone while another is attached: move to
			// it at once — no silence to wait out, because the reader's handle is
			// closed and nothing is left that could still be holding the state it was
			// reading. A switch of any kind resets the mapper and the touch reader.
			padBattery.delete(key);
			if (primary === link) primary = undefined;
			const next = padKeys()[0];
			if (next !== undefined) switchTo(next, "disconnect", clock.now());
			return;
		}
		// The link that stays takes over at once, for the same reason. With one
		// link per transport there is at most one other to hand it to.
		if (primary === link) primary = remaining[0];
		setStatus({
			device: primary?.device,
			transport: primary?.transport,
			links: linkTransports(),
			linksDisagree: undefined,
		});
	}

	/** The pad is no longer ours: forget everything that was about *this* pad. */
	function release(reason?: string): void {
		for (const link of links) {
			try {
				link.handle.close();
			} catch {
				// Already gone. Nothing to do about it and nothing to say.
			}
		}
		links = [];
		activeKey = undefined;
		primary = undefined;
		padBattery.clear();
		suppressUntilNeutral = false;
		activeSince = 0;
		// The disagreement goes without an announcement of its own. Every caller
		// writes a fresh status immediately after this — searching, off, or whatever
		// `connect` found — and one emitted here would still name the pad whose
		// handles have just been closed, with no controllers attached to it any more.
		// The cleared flag still has to be in the status the caller merges onto, or
		// the line about two controllers would outlive both of them.
		disagreeingSince = undefined;
		status = { ...status, linksDisagree: undefined };
		wroteAt = undefined;
		motors = undefined;
		// Not "the last signal with a hole in it": a pad that comes back is a new
		// pad, and it should be told everything again — starting with the buzz that
		// means "I can hear you", which is the only proof the feature works.
		signal = undefined;
		mapper.reset();
		// A finger that was on the surface when the pad slept must not become a tap
		// when it wakes: the reports that would have ended the touch never arrived.
		touch.reset();
		stopTimers();
		if (reason !== undefined) stats = { ...stats, lastError: reason };
	}

	function lose(reason: string): void {
		release(reason);
		setStatus({
			phase: enabled ? "searching" : "off",
			detail: reason,
			device: undefined,
			transport: undefined,
			links: undefined,
			crcOk: undefined,
		});
		if (enabled) scheduleRetry();
	}

	/**
	 * Move the app to another attached pad.
	 *
	 * The old pad is put out first — bar dark, motors stopped — so a controller
	 * put down does not keep lighting up for an app it no longer drives. Everything
	 * the mapper and the touch reader knew belonged to the old pad: letting them
	 * keep it is how a held button becomes a release, or a resting finger a tap,
	 * on a pad that never saw either. The new pad is then told the current signal,
	 * and its own input waits until it has been seen at rest once — a hand still
	 * on the button it used to choose the pad must not answer a dialog.
	 */
	function switchTo(key: string, cause: "input" | "manual" | "disconnect", now: number, activate?: PadLink): void {
		const pad = padLinks(key);
		if (pad.length === 0 || key === activeKey) return;
		if (activeKey !== undefined) darken(padLinks(activeKey));
		activeKey = key;
		primary = activate ?? pad[0];
		// Every pad left behind is disarmed until it reports at rest. Anything held
		// right now is not a new press and must not take the app back; anything
		// pressed after a release is, and counts from zero.
		for (const link of links) {
			if (link.padKey === key) continue;
			link.armed = false;
			link.activeRun = 0;
		}
		disagreeingSince = undefined;
		signal = undefined;
		sample = undefined;
		activeSince = now;
		suppressUntilNeutral = true;
		mapper.reset();
		touch.reset();
		setStatus({
			device: primary.device,
			transport: primary.transport,
			links: linkTransports(),
			battery: padBattery.get(key),
			crcOk: undefined,
			linksDisagree: undefined,
			detail: undefined,
		});
		// A switch made by hand, or by using the other pad, is confirmed quietly. A
		// pad taking over because the first one died is not a confirmation of
		// anything, and gets no tap of its own.
		if (cause !== "disconnect") {
			buzzCommand(PAD_RUMBLE.switched);
			feedback.buzzed(now);
		}
		pushSignal();
		// The bar belongs to the pad now in hand; do not make it wait for a frame.
		flush(now, true);
	}

	function scheduleRetry(): void {
		if (retry !== undefined || closed) return;
		retry = clock.setInterval(() => {
			if (retry !== undefined) clock.clearInterval(retry);
			retry = undefined;
			connect();
		}, reconnectMs);
	}

	function connect(): void {
		if (links.length > 0 || closed) return;
		// A source that cannot work at all is not worth retrying: waiting three
		// seconds to ask again whether node-hid is installed answers the same way
		// every time, and the user is owed the reason instead of a search.
		const blocked = deps.source.unavailable();
		if (blocked !== undefined) {
			setStatus({ phase: "off", detail: blocked, device: undefined, transport: undefined, links: undefined });
			return;
		}
		const devices = deps.source.list();
		const wanted = pickLinks(devices, config.device);
		if (wanted.length === 0) {
			setStatus({
				phase: "searching",
				detail: noDeviceDetail(devices, config.device),
				device: undefined,
				transport: undefined,
				links: undefined,
			});
			scheduleRetry();
			return;
		}
		openedAt = clock.now();
		// Every link, opened together. One that will not open is not the pad: on a
		// controller that is wired and on the radio at once, the other link may be
		// exactly the one that works, and a pad held by another program fails on all
		// of them anyway. The reason is kept for the status either way.
		for (const device of wanted) {
			let opened: PadSourceHandle;
			try {
				opened = deps.source.open(device);
			} catch (error) {
				stats = { ...stats, lastError: message(error) };
				continue;
			}
			openLink(device, opened);
		}
		if (links.length === 0) {
			setStatus({
				phase: "error",
				detail: stats.lastError,
				device: undefined,
				transport: undefined,
				links: undefined,
			});
			scheduleRetry();
			return;
		}
		// The first pad in `pickLinks` order leads: the wire before the radio, and a
		// DualShock 4 before an Xbox pad. Anything else attached is opened, watched,
		// and becomes active when someone uses it or asks for it by name.
		activeKey = padKeys()[0];
		primary = activeLinks()[0];
		activeSince = openedAt;
		suppressUntilNeutral = false;
		// The counters are about this connection; why the last one ended is not, and
		// it is the thing being asked about after a cable has been knocked out twice.
		stats = { reports: 0, lastError: stats.lastError };
		setStatus({
			phase: "connected",
			device: primary?.device,
			detail: undefined,
			transport: primary?.transport,
			links: linkTransports(),
			battery: activeKey === undefined ? undefined : padBattery.get(activeKey),
			crcOk: undefined,
		});
		// A pad nobody is reading still needs its power-on mode ended; then the buzz
		// that proves the feature is alive happens on the pad being read, before its
		// first report, because the transport is not needed to say hello.
		wakeInactivePads();
		pushSignal();
		startTick();
	}

	function onBytes(link: PadLink, bytes: Uint8Array): void {
		if (closed || !links.includes(link)) return;
		// The parser is the family's, and so is the builder below: an Xbox link is
		// fed by XInput and speaks four-byte vibration packets, not HID reports.
		const report: PadReport | undefined = link.family === "xbox" ? parseXboxInput(bytes) : parseDs4Input(bytes);
		// Anything else on the wire belongs to another collection of the same
		// device; the pad sends those too.
		if (report === undefined) return;
		const now = clock.now();
		// The gap since the last report the app acted on — the mapper's stream, so
		// the other link's reports, which are not fed to it, are not reports. Read
		// before the stamps below, which is what makes it a gap and not a zero.
		const quietMs = stats.lastReportAt === undefined ? 0 : now - stats.lastReportAt;
		link.lastReportAt = now;
		// What the bytes say this link is, whoever is reading it: the framing of
		// every link's packets is settled here, and a link nobody is reading still
		// has to be written to correctly. XInput reports no framing decision — the
		// transport is the API, not something the bytes reveal.
		if (link.family === "ds4" && report.transport !== "xinput") {
			link.transport = linkTransport(link, report.transport);
		}
		if (link.padKey !== activeKey) {
			// A pad nobody is reading says two things: its battery, which the card
			// shows, and whether someone has picked it up. Nothing else about it is
			// the app's business.
			padBattery.set(link.padKey, report.state.battery);
			// Only a pad that has been seen at rest can count a press. A button held
			// through the switch that moved the app away never produces the neutral
			// report that arms it, so it cannot pull the app back without being let
			// go of first — however many reports it sends while held.
			if (!padIsActive(report.state)) {
				link.armed = true;
				link.activeRun = 0;
			} else if (!link.armed) {
				link.activeRun = 0;
			} else {
				link.activeRun += 1;
			}
			if (link.activeRun !== PAD_SWITCH_REPORTS) {
				setStatus({});
				return;
			}
			// A deliberate pick-up moves the app. The report that did it is not fed
			// to the mapper below: the press that chooses a pad must not answer a
			// dialog that was already on screen.
			switchTo(link.padKey, "input", now, link);
		}
		if (primary !== link) {
			// A link that is not being read only says "still here". Reading both
			// would interleave the same buttons at two latencies: the state from the
			// other link is this report seen late. Unless the reader has gone quiet,
			// which is the moment the pad moved to this link and the app has to move
			// with it — a link that has never reported at all included.
			const readerAt = primary?.lastReportAt;
			if (readerAt !== undefined && now - readerAt <= silenceMs) {
				noteSecondOpinion(report.state.buttons, now);
				return;
			}
			primary = link;
		}
		const next: PadSample = {
			at: now,
			family: link.family,
			transport: link.transport,
			state: report.state,
			bytes: bytes.length,
		};
		// A finger on the surface counts as "not at rest" even though `padIsActive`
		// ignores touch: `touch-tap` is a default binding for confirm, so a finger
		// already resting when the pad became active would become an accidental
		// approval the moment it moved or lifted. Suppression ends only on a report
		// with no buttons, triggers and no touch points, and with both sticks back
		// inside the deadzone, where the mapper reads them as centered.
		const suppressed =
			suppressUntilNeutral &&
			(padIsActive(report.state) || hasFinger(report.state) || stickPushed(report.state, deadzone));
		// Where the surface turns into input. The gestures are read from *this*
		// report — a tap is decided on the report where the finger is already gone —
		// and handed to the mapper beside the buttons, so that everything downstream
		// of it, the sample included, sees the same frame the user's thumb made. A
		// family with no surface reports no fingers, which is what the reader needs
		// to hear so a touch from a previous pad cannot become a tap on this one.
		// While suppression is on, the reader is not asked at all: a finger resting
		// through a switch must not become a gesture on the pad that just arrived.
		const gestures = suppressed ? NO_GESTURE : touch.push(report.state.touch ?? NO_TOUCH, now);
		if (gestures.length > 0) next.gestures = gestures;
		if (report.crcOk !== undefined) next.crcOk = report.crcOk;
		sample = next;
		// Reports the app did not act on still say the pad is alive, which is what
		// the next real report's gap is measured against — otherwise the first
		// mapped report after a switch would look like a silence.
		stats = { ...stats, reports: suppressed ? stats.reports : stats.reports + 1, lastReportAt: now };
		padBattery.set(link.padKey, report.state.battery);
		setStatus({
			device: link.device,
			transport: link.transport,
			links: linkTransports(),
			battery: report.state.battery,
			crcOk: report.crcOk,
		});
		// Before the actions: a battery that just went critical owns the bar, and
		// the actions of this report cannot have moved the app's half yet. This is
		// also where the first write happens: the signal gains the battery here, so
		// it differs from what the pad was told when it was opened.
		pushSignal();
		if (suppressed) {
			// The pad that just became active has not been seen at rest yet: its
			// state is shown, and `onReport` hears the bytes, but the mapper does
			// not. The first report that is idle *and* finger-free clears this and
			// is itself mapped; because the surface never saw that finger, the lift
			// that clears it cannot be read as a tap.
			deps.onReport?.(sample);
			return;
		}
		suppressUntilNeutral = false;
		const actions = mapper.update(report.state, now, gestures, quietMs > REPORT_GAP_MS ? quietMs : 0);
		if (actions.length > 0) deps.onActions?.(actions);
		deps.onReport?.(sample);
	}

	return {
		async enable() {
			if (enabled || closed) return;
			enabled = true;
			try {
				await deps.source.warmUp();
			} catch (error) {
				// A source that cannot even load is not a crash: it is a pad that is
				// not there, which is the state this whole file is built around.
				enabled = false;
				setStatus({ phase: "error", detail: message(error) });
				return;
			}
			if (!enabled || closed) return;
			connect();
		},

		disable() {
			if (!enabled) return;
			enabled = false;
			goDark();
			release();
			setStatus({
				phase: "off",
				detail: undefined,
				device: undefined,
				transport: undefined,
				links: undefined,
				crcOk: undefined,
			});
		},

		rescan() {
			// Off is the user's answer, not a state to look past: there is nothing to
			// rescue when nothing is being read.
			if (closed || !enabled) return;
			release();
			// No status of its own: every way `connect` can end writes one — connected,
			// searching with the reason, error with it — and it runs before this returns,
			// so anything said here would be overwritten unread. The retry timer `release`
			// stopped is not restarted either: the looking happens right here.
			connect();
		},

		close() {
			closed = true;
			enabled = false;
			goDark();
			release();
			setStatus({
				phase: "off",
				detail: undefined,
				device: undefined,
				transport: undefined,
				links: undefined,
				crcOk: undefined,
			});
		},

		status: () => status,
		stats: () => stats,
		lastSample: () => sample,
		devices: () => deps.source.list(),

		switchPad(target) {
			if (closed || !enabled) return false;
			const keys = padKeys();
			if (keys.length === 0) return false;
			const wanted = target?.trim().toLowerCase();
			if (wanted === undefined || wanted === "" || wanted === "next") {
				if (keys.length < 2) return false;
				const at = activeKey === undefined ? -1 : keys.indexOf(activeKey);
				const next: string | undefined = keys[(at + 1) % keys.length];
				if (next === undefined) return false;
				switchTo(next, "manual", clock.now());
				return true;
			}
			const indexed = /^\d+$/.test(wanted) ? Number(wanted) : undefined;
			let key: string | undefined;
			if (indexed === undefined) {
				// Every link of a pad answers to its name and path: the controller row
				// names the reader, but `/gamepad list` shows both links of a DualShock 4,
				// and a path copied from it must pick the pad whichever one it came from.
				const controllers = controllersStatus();
				key = (
					controllers.find(
						(controller) =>
							controllerNamed(controller, wanted) ||
							padLinks(controller.key).some((link) => matchesDevice(link.device, wanted)),
					) ?? controllers.find((controller) => controllerInFamily(controller, wanted))
				)?.key;
			} else {
				key = keys[indexed - 1];
			}
			// The pad already being read is a valid answer: the caller named a
			// controller, and that controller is the one in hand.
			if (key === undefined) return false;
			if (key !== activeKey) switchTo(key, "manual", clock.now());
			return true;
		},

		setFeedback(next) {
			ui = next;
			pushSignal();
		},

		setPalette(next) {
			Object.assign(palette, next);
			// Written out rather than left to the next tick: the tick would get there
			// in `outputMs`, but a colourless half-second after a theme change reads
			// as the bar being broken rather than as it being 30 Hz.
			flush(clock.now(), true);
		},

		buzz(name) {
			// Deliberately not through `feedback.rumble`: this is a person asking for
			// a buzz, not a state change that might deserve one, so the gap rule that
			// keeps news from stuttering cannot drop it. The pad has still buzzed,
			// though, and the feedback is told so: a `done` a moment after a buzz the
			// user asked for would land as the tail of a stutter, and a stop they made
			// by hand has to be the last thing the hand feels.
			buzzCommand(PAD_RUMBLE[name]);
			feedback.buzzed(clock.now());
		},

		suspendRepeat() {
			mapper.suspendRepeat();
		},
	};
}

/** Whether two statuses say the same thing — the UI re-renders on `false`. */
function sameStatus(a: PadServiceStatus, b: PadServiceStatus): boolean {
	return (
		a.phase === b.phase &&
		a.detail === b.detail &&
		a.transport === b.transport &&
		sameLinks(a.links, b.links) &&
		sameControllers(a.controllers, b.controllers) &&
		a.crcOk === b.crcOk &&
		a.device?.path === b.device?.path &&
		a.device?.carriesReports === b.device?.carriesReports &&
		a.battery?.level === b.battery?.level &&
		a.battery?.cable === b.battery?.cable &&
		a.battery?.full === b.battery?.full &&
		a.battery?.low === b.battery?.low &&
		a.linksDisagree === b.linksDisagree
	);
}

/**
 * Whether two controller lists say the same thing. By value, for the same reason
 * the link list is: every report rebuilds the controllers from the links, and a
 * fresh array on each one would re-render the screen 250 times a second.
 */
function sameControllers(
	a: readonly PadControllerStatus[] | undefined,
	b: readonly PadControllerStatus[] | undefined,
): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	return a.every((controller, at) => {
		const other = b[at];
		return (
			controller.key === other.key &&
			controller.family === other.family &&
			controller.active === other.active &&
			controller.device.path === other.device.path &&
			controller.device.name === other.device.name &&
			sameLinks(controller.transports, other.transports) &&
			controller.battery?.level === other.battery?.level &&
			controller.battery?.cable === other.battery?.cable &&
			controller.battery?.full === other.battery?.full &&
			controller.battery?.low === other.battery?.low
		);
	});
}

/** The words a person might use for a family when asking which pad to switch to. */
const FAMILY_WORDS: Readonly<Record<PadFamily, readonly string[]>> = {
	xbox: ["xbox"],
	ds4: ["ds4", "dualshock", "playstation"],
};

/**
 * Whether a controller answers to a `switchPad` target by what is printed on it:
 * one of its transports, or the same case-insensitive substring of name and path
 * that the `device` setting matches.
 *
 * Asked of every controller before any family word is, because a name is more
 * specific than a family: the name of one Xbox pad, copied from the list, contains
 * "xbox", and matching the word first would pick the first Xbox pad every time.
 */
function controllerNamed(controller: PadControllerStatus, wanted: string): boolean {
	const needle = wanted.trim().toLowerCase();
	if (controller.transports.some((transport) => transport.includes(needle))) return true;
	return matchesDevice(controller.device, wanted);
}

/** Whether a controller answers to a `switchPad` target by its family word. */
function controllerInFamily(controller: PadControllerStatus, wanted: string): boolean {
	const needle = wanted.trim().toLowerCase();
	return FAMILY_WORDS[controller.family].some((word) => word.includes(needle) || needle.includes(word));
}

/**
 * Whether two link lists name the same transports in the same order. By value,
 * because the status is rebuilt from scratch on every report and an identity
 * comparison would re-render the UI 250 times a second.
 */
function sameLinks(a: readonly PadTransport[] | undefined, b: readonly PadTransport[] | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined || a.length !== b.length) return false;
	return a.every((transport, at) => transport === b[at]);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let at = 0; at < a.length; at += 1) if (a[at] !== b[at]) return false;
	return true;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
