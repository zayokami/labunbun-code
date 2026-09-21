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

import type { PadBindingMap } from "./bindings.ts";
import {
	buildDs4Output,
	type Ds4Battery,
	type Ds4OutputState,
	type Ds4State,
	type Ds4Transport,
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
import { createMapper, type PadAction, type PadRepeat } from "./mapping.ts";
import { deviceTransport, type PadSource, type PadSourceDevice, type PadSourceHandle, pickLinks } from "./source.ts";

export type PadServicePhase = "off" | "searching" | "connected" | "error";

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
	transport?: Ds4Transport;
	/**
	 * Every link the pad is answering on, the one being read first. More than one
	 * means the controller is attached twice — a cable and the radio — and is
	 * being written to on both.
	 */
	links?: readonly Ds4Transport[];
	battery?: Ds4Battery;
	/** Why it is not connected, in words worth showing to the person holding it. */
	detail?: string;
	/** Bluetooth only: whether the last report's CRC verified. */
	crcOk?: boolean;
}

/** Everything the last report carried, for `/gamepad watch`. */
export interface PadSample {
	/** When it arrived, on the service's clock. */
	at: number;
	transport: Ds4Transport;
	state: Ds4State;
	/** How long the report was: the quickest way to see the transport change. */
	bytes: number;
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
 * How often to look for a link the pad gained while we were already talking to
 * it. Nothing announces that a cable has been plugged into a controller that was
 * on the radio: the OS simply starts listing a second collection of the same
 * device. One OS enumeration a second is invisible next to the writes, and it is
 * the difference between driving every link and driving whichever one happened
 * to be attached when the app looked.
 */
const LINK_SCAN_MS = 1_000;

/** The pad's own colour when it should show nothing: motors stopped, bar dark. */
const DARK: Ds4OutputState = { lightbar: { r: 0, g: 0, b: 0 } };

/**
 * One open collection of the pad: a link, and the shape its bytes take on it.
 *
 * A controller can have more than one at a time — see `pickLinks` — and each
 * keeps its own last packet, because "unchanged" is a per-link fact: a link
 * opened a moment ago has been told nothing.
 */
interface PadLink {
	device: PadSourceDevice;
	handle: PadSourceHandle;
	/** How this link's packets are framed. See `linkTransport`. */
	transport: Ds4Transport;
	/** The last packet written here, byte for byte. An identical one is skipped. */
	lastPacket?: Uint8Array;
	/** When this link last delivered a report; `undefined` until one parses. */
	lastReportAt?: number;
}

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
function linkTransport(link: PadLink, seen: Ds4Transport): Ds4Transport {
	return seen === "bluetooth" ? "bluetooth" : link.transport;
}

/**
 * Why there is no controller to open, in the words that get the user unstuck.
 * The middle case is the one worth the words: a pad that another program is
 * holding enumerates as a device with no path, and "no controller attached"
 * would send someone to check a cable that is already plugged in.
 */
export function noDeviceDetail(devices: readonly PadSourceDevice[], wanted?: string): string {
	if (wanted !== undefined && devices.length > 0) return `no controller matching "${wanted}"`;
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
	// One palette object, copied and then mutated in place rather than replaced:
	// the feedback reads it on every frame, and its own bookkeeping (how recently
	// it buzzed) lives in a closure that a theme change must not reset.
	const palette: PadPalette = { ...config.palette };
	const feedback = createPadFeedback(palette);
	const mapper = createMapper({ bindings: config.bindings, deadzone: config.deadzone, repeat: config.repeat });

	let enabled = false;
	let closed = false;
	/** Every open collection of this pad. One per transport, as `pickLinks` says. */
	let links: PadLink[] = [];
	/**
	 * The link the app reads. One at a time, and only one: both links of a pad
	 * attached twice carry the same buttons a few milliseconds apart, and the
	 * mapper works on edges — a report from the other link is the same state seen
	 * late, which reads as a release and then as the press again. A second copy of
	 * one press is exactly the kind of thing a user notices and cannot explain.
	 */
	let primary: PadLink | undefined;
	let sample: PadSample | undefined;
	/** The signal the pad has been told about. `undefined` = it has not been told. */
	let signal: PadSignal | undefined;
	let ui: PadUiSignal = { phase: "idle", awaiting: false };
	/** The motors as currently commanded, or `undefined` for "stopped". */
	let motors: PadRumble | undefined;
	let stopMotors: PadTimer | undefined;
	let wroteAt: number | undefined;
	let openedAt = 0;
	let scannedAt = 0;
	let tick: PadTimer | undefined;
	let retry: PadTimer | undefined;
	let status: PadServiceStatus = { phase: "off" };
	let stats: PadStats = { reports: 0 };

	function setStatus(patch: Partial<PadServiceStatus>): void {
		const next: PadServiceStatus = { ...status, ...patch };
		if (sameStatus(status, next)) return;
		status = next;
		deps.onStatus?.(status);
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
		const told = links.some((link) => link.lastPacket !== undefined);
		if (told && signal !== undefined && padSignalEqual(signal, next)) return;
		const command = feedback.rumble(signal, next, clock.now());
		signal = next;
		if (command !== undefined) buzzCommand(command);
		flush(clock.now());
	}

	function buzzCommand(command: PadRumbleCommand): void {
		motors = command.rumble;
		flush(clock.now(), true);
		if (stopMotors !== undefined) clock.clearTimeout(stopMotors);
		stopMotors = clock.setTimeout(() => {
			stopMotors = undefined;
			motors = undefined;
			flush(clock.now(), true);
		}, command.durationMs);
	}

	/**
	 * Write what the bar and the motors should be doing, on every link the pad has.
	 *
	 * One app state, one packet per link: the framing differs — 32 bytes for USB,
	 * 78 with a CRC for Bluetooth — and the meaning does not. Nothing here can
	 * tell which link the pad obeys; the OS accepts writes on all of them and
	 * reports only that the bytes were taken, never that the pad listened. So it
	 * is told on all of them, and the bar follows whichever one it chose.
	 *
	 * Compared as bytes rather than as intent, because that is what the pad
	 * receives: "unchanged" has to mean the same packet, and the motors are part
	 * of it. The comparison is per link, and the packet a link was last told is
	 * never written twice — the first write to a link is the one that ends its
	 * silent power-on mode, and it is the one that must not be skipped.
	 */
	function flush(now: number, immediate = false): void {
		if (links.length === 0) return;
		const state: Ds4OutputState = { lightbar: feedback.lightbar(currentSignal(), now) };
		if (motors !== undefined) state.rumble = motors;
		const packets = links.map((link) => ({ link, packet: buildDs4Output(link.transport, state) }));
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

	/** Motors off, bar dark, written while the devices are still there to hear it. */
	function goDark(): void {
		for (const link of links) link.handle.write(buildDs4Output(link.transport, DARK));
	}

	/** The most recent report any link has delivered: what the watchdog measures. */
	function lastReportAt(): number | undefined {
		let latest: number | undefined;
		for (const link of links) {
			if (link.lastReportAt === undefined) continue;
			if (latest === undefined || link.lastReportAt > latest) latest = link.lastReportAt;
		}
		return latest;
	}

	/** Every live link, the one being read first: what the status card names. */
	function linkTransports(): Ds4Transport[] {
		const reader = primary;
		const transports = links.map((link) => link.transport);
		if (reader === undefined) return transports;
		return [reader.transport, ...transports.filter((transport) => transport !== reader.transport)];
	}

	/** Wire an open handle in as a link of this pad. */
	function openLink(device: PadSourceDevice, opened: PadSourceHandle): void {
		const link: PadLink = { device, handle: opened, transport: deviceTransport(device) };
		opened.onReport((bytes) => onBytes(link, bytes));
		opened.onError((error) => dropLink(link, message(error)));
		links.push(link);
		if (primary === undefined) primary = link;
	}

	function stopTimers(): void {
		if (tick !== undefined) clock.clearInterval(tick);
		if (retry !== undefined) clock.clearInterval(retry);
		if (stopMotors !== undefined) clock.clearTimeout(stopMotors);
		tick = undefined;
		retry = undefined;
		stopMotors = undefined;
	}

	function startTick(): void {
		if (tick !== undefined) return;
		tick = clock.setInterval(() => {
			const now = clock.now();
			if (links.length > 0 && now - (lastReportAt() ?? openedAt) > silenceMs) {
				// Gone without saying so. Same as a cable: keep what the user had, drop
				// the pad, look again.
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
	 * Look for a link this pad gained while we were already talking to it: a cable
	 * plugged into a controller that was on the radio, or a radio coming up under a
	 * wired one. A pad answering on every transport it has gains nothing here.
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
			openLink(device, opened);
			setStatus({ links: linkTransports() });
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
		// The reader left with it, and the link that stays takes over at once — no
		// silence to wait out, because the reader's handle is closed: there is
		// nothing left that could still be holding the state it was reading. With
		// one link per transport there is at most one other to hand it to.
		if (primary === link) primary = links[0];
		setStatus({ device: primary?.device, transport: primary?.transport, links: linkTransports() });
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
		primary = undefined;
		wroteAt = undefined;
		motors = undefined;
		// Not "the last signal with a hole in it": a pad that comes back is a new
		// pad, and it should be told everything again — starting with the buzz that
		// means "I can hear you", which is the only proof the feature works.
		signal = undefined;
		mapper.reset();
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
		// The counters are about this connection; why the last one ended is not, and
		// it is the thing being asked about after a cable has been knocked out twice.
		stats = { reports: 0, lastError: stats.lastError };
		setStatus({
			phase: "connected",
			device: primary?.device,
			detail: undefined,
			transport: primary?.transport,
			links: linkTransports(),
			crcOk: undefined,
		});
		// The buzz that proves the feature is alive happens here, before the first
		// report, because the transport is not needed to say hello.
		pushSignal();
		startTick();
	}

	function onBytes(link: PadLink, bytes: Uint8Array): void {
		if (closed || !links.includes(link)) return;
		const report = parseDs4Input(bytes);
		// Anything else on the wire belongs to another collection of the same
		// device; the pad sends those too.
		if (report === undefined) return;
		const now = clock.now();
		link.lastReportAt = now;
		// What the bytes say this link is, whoever is reading it: the framing of
		// every link's packets is settled here, and a link nobody is reading still
		// has to be written to correctly.
		link.transport = linkTransport(link, report.transport);
		if (primary !== link) {
			// A link that is not being read only says "still here". Reading both
			// would interleave the same buttons at two latencies: the state from the
			// other link is this report seen late. Unless the reader has gone quiet,
			// which is the moment the pad moved to this link and the app has to move
			// with it — a link that has never reported at all included.
			const readerAt = primary?.lastReportAt;
			if (readerAt !== undefined && now - readerAt <= silenceMs) return;
			primary = link;
		}
		const next: PadSample = { at: now, transport: link.transport, state: report.state, bytes: bytes.length };
		if (report.crcOk !== undefined) next.crcOk = report.crcOk;
		sample = next;
		// The counter counts the reports the app acted on: the reader's.
		stats = { ...stats, reports: stats.reports + 1, lastReportAt: now };
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
		const actions = mapper.update(report.state, now);
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
			// keeps news from stuttering does not apply to it.
			buzzCommand(PAD_RUMBLE[name]);
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
		a.crcOk === b.crcOk &&
		a.device?.path === b.device?.path &&
		a.device?.carriesReports === b.device?.carriesReports &&
		a.battery?.level === b.battery?.level &&
		a.battery?.cable === b.battery?.cable
	);
}

/**
 * Whether two link lists name the same transports in the same order. By value,
 * because the status is rebuilt from scratch on every report and an identity
 * comparison would re-render the UI 250 times a second.
 */
function sameLinks(a: readonly Ds4Transport[] | undefined, b: readonly Ds4Transport[] | undefined): boolean {
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
