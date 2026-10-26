#!/usr/bin/env bun
/**
 * The controller, on this machine, without the app in the way.
 *
 * Usage: bun run scripts/gamepad-probe.ts [--seconds 8] [--raw] [--touch] [--light] [--rumble] [--dark] [--all]
 *
 * `/gamepad watch` answers "is my mapping right" — it shows the decoded state.
 * This answers the other questions, the ones the REPL cannot: does the optional
 * module load at all under this Bun, which of the pad's interfaces carries the
 * reports, what do the raw bytes look like, and can the pad be written to.
 *
 * Two families answer those differently. A DualShock 4 arrives through node-hid
 * as HID reports; an Xbox pad on Windows arrives through XInput, which is the
 * only path that works there — its HID collection opens and delivers nothing.
 * The probe uses the same combined source the app uses, and says which family
 * it opened.
 *
 * `--touch` is the one mode with a question of its own: are the touchpad offsets
 * right? They came out of another project's source, and the only thing that can
 * settle them is a finger on real hardware — so this prints both the decoded
 * points and the eight bytes they came from, quiet about everything else, and
 * ends with the extremes it saw. A sweep from one corner to the other is then a
 * measurement rather than an impression: the numbers should run to about
 * (0, 0) and (1920, 943), and a run that never lands near them says the offsets,
 * the packing or the panel size is wrong — with the bytes printed to say which.
 * An Xbox pad has no surface, so the mode says so and runs the ordinary view.
 *
 * It opens the device through the same source the app uses, so a run that works
 * here is a run that works in the REPL, and a crash here is a crash the app
 * would have had — printed next to the step that was doing it.
 *
 * Nothing is written unless asked: `--light` and `--rumble` send output reports,
 * which are visible in the room, and that is the point of them. A write is one
 * packet describing the whole pad, so a run that writes always says which
 * colour it wrote — sending rumble alone would darken the lightbar, and a probe
 * that quietly turned the lights off would be a bad probe. An Xbox pad has only
 * motors; there is no lightbar to darken and no touchpad to measure.
 *
 * The pad holds the last packet it is given, which cuts both ways: `--rumble`
 * has to stop its own motors (nothing about this process exiting does), and
 * `--dark` exists because otherwise the only way to clear the bar a previous run
 * lit is to unplug the pad.
 *
 * A run that could read nothing keeps listening for a moment after it writes,
 * because that write is the thing a Bluetooth DualShock 4 switches on waiting
 * for: the first report after it is the first one that can be read at all.
 */

import { formatSample } from "../packages/coding-agent/src/gamepad-runtime.ts";
import {
	buildDs4Output,
	buildXboxOutput,
	createCombinedSource,
	createNodeHidSource,
	createXInputSource,
	type Ds4Touch,
	type Ds4TouchPoint,
	type Ds4Transport,
	describePadDevice,
	deviceFamily,
	deviceTransport,
	importNodeHid,
	importXInput,
	type PadReport,
	type PadTransport,
	parseDs4Input,
	parseXboxInput,
	pickDevice,
	TOUCH_HEIGHT,
	TOUCH_WIDTH,
} from "../packages/gamepad/src/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const seconds = (() => {
	const at = argv.indexOf("--seconds");
	return at === -1 ? 8 : Number(argv[at + 1]) || 8;
})();

const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");

/** How long `--rumble` buzzes. Long enough to feel, short enough to be a test. */
const BUZZ_MS = 500;

/**
 * How still a byte has to be before `--raw` calls it settled. A person holding a
 * button down is the slowest thing in this loop by two orders of magnitude, so
 * the threshold only has to clear the gyro — which never settles at all.
 */
const RAW_SETTLE_MS = 300;

/**
 * How long to keep reading after a write that was supposed to change what the pad
 * sends. The write is also a question — "are you in your power-on mode?" — and
 * this is how long the answer is given to arrive.
 */
const POST_WRITE_MS = 2_000;

/**
 * The touch block, in payload offsets: two counters with three bytes of position
 * behind each. The same numbers `ds4.ts` decodes from, repeated here so the
 * measurement can be read without opening the decoder — and so that a run which
 * disagrees with the decoder says so at the point of disagreement.
 */
const TOUCH_FROM = 34;
const TOUCH_TO = 41;

/** Where a payload starts in the whole report: the transports differ by this alone. */
function payloadAt(transport: Ds4Transport): number {
	return transport === "bluetooth" ? 3 : 1;
}

/** `--touch`'s line: the two decoded points, then the bytes they came from. */
function touchLine(touch: Ds4Touch, raw: string): string {
	const point = (at: Ds4TouchPoint | undefined) => (at === undefined ? "—" : `#${at.id} ${at.x},${at.y}`);
	return `touch 1 ${point(touch[0])} · 2 ${point(touch[1])} · raw ${TOUCH_FROM}..${TOUCH_TO}: ${raw}`;
}

console.log("Loading the controller sources the way the app does…");
const source = createCombinedSource([
	createNodeHidSource({ load: importNodeHid }),
	createXInputSource({ load: importXInput }),
]);
await source.warmUp();

const unavailable = source.unavailable();
if (unavailable) {
	console.error(unavailable);
	process.exit(1);
}

// The raw listing, next to the filtered one: a pad that is attached but absent
// from `devices` below is a pad this package does not recognize, and the usage
// fields are what says which interface the reports arrive on. XInput pads do
// not appear here at all — XInput is the listing for those.
const devices = source.list();
const everyDevice = (await importNodeHid())?.devices() ?? [];
const ds4Interfaces = devices.filter((candidate) => deviceFamily(candidate) === "ds4").length;
console.log(
	`${everyDevice.length} HID device(s) attached · ${devices.length} controller(s)` +
		` (${ds4Interfaces} DualShock 4 interface(s), ${devices.length - ds4Interfaces} Xbox)`,
);
for (const info of everyDevice) {
	const isPad = devices.some((device) => device.path === info.path);
	if (!isPad && !flag("all")) continue;
	console.log(
		`  ${info.path ?? "(no path — held by another program)"}` +
			` · usagePage=${info.usagePage ?? "?"} usage=${info.usage ?? "?"}` +
			` · interface=${info.interface ?? "?"} · ${info.product ?? ""}${isPad ? "" : " (not a pad)"}`,
	);
}

const device = pickDevice(devices);
if (!device) {
	console.error(
		"Nothing to open — plug a DualShock 4 in or connect an Xbox controller, or pass --all to see every HID device.",
	);
	process.exit(1);
}

const family = deviceFamily(device);
// The line before the open, and this one after it, are the whole point of the
// step being here: `new HID()` is reported to take Bun down on Windows, and a
// silent exit between two printed lines names the culprit without a debugger.
console.log(`Opening ${describePadDevice(device)} [${family}] — a crash here is the runtime, not the pad.`);
const handle = source.open(device);
console.log("Opened. Listening…\n");

if (flag("touch") && family !== "ds4") {
	console.log("An Xbox controller has no touch surface; showing the decoded state instead.\n");
}

if (flag("touch") && family === "ds4") {
	// The offsets, the packing and the panel, all on screen before the measurement:
	// a person holding a finger on a corner is comparing these numbers with what
	// comes out below, and having to remember them would make it an impression.
	console.log(`Touch surface — payload ${TOUCH_FROM}..${TOUCH_TO}, the offsets ds4.ts reads:`);
	console.log(
		`  point 1 counter ${TOUCH_FROM}, data ${TOUCH_FROM + 1}/${TOUCH_FROM + 2}/${TOUCH_FROM + 3}` +
			` · point 2 counter ${TOUCH_FROM + 4}, data ${TOUCH_FROM + 5}/${TOUCH_FROM + 6}/${TOUCH_FROM + 7}`,
	);
	console.log("  x = b35 | ((b36 & 0f) << 8) · y = (b36 >> 4) | (b37 << 4) · counter bit 7 set = no finger");
	console.log(`  the corners should read about (0,0) and (${TOUCH_WIDTH},${TOUCH_HEIGHT})\n`);
}

let reports = 0;
let badCrc = 0;
let lastLine: string | undefined;
/** `--touch`: the block as it was last printed, so a still surface stays quiet. */
let lastTouch: string | undefined;
/** `--touch`: the extremes a sweep reached, and the touch ids the pad handed out. */
const reached = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
const touchIds = new Set<number>();
let first: Uint8Array | undefined;
/** Per index: the value it is holding, since when, and the last one printed. */
const settled = new Map<number, { value: number; since: number; reported: number }>();
const transports = new Set<PadTransport>();
const unreadable = new Set<string>();

handle.onReport((bytes) => {
	reports++;
	if (!first) {
		first = bytes;
		console.log(`first report: ${bytes.length} bytes · ${hex(bytes.subarray(0, 16))}`);
	}
	// `--raw` answers the question a decoded line cannot: which byte carries which
	// button. Printing every change answers nothing — this pad puts its gyro,
	// accelerometer, timestamp and counter in every packet, so most indices move
	// hundreds of times a second whatever the user does. What a *button* looks like
	// from here is the opposite: a byte that stops moving. Hold ✕ and one index
	// settles at a value it will keep until the button comes up, while the gyro
	// churns on. So the filter is "held still long enough to be a decision", and
	// only the transitions are printed.
	if (flag("raw")) {
		const now = performance.now();
		for (let i = 0; i < bytes.length; i++) {
			const seen = settled.get(i);
			if (seen === undefined) {
				settled.set(i, { value: bytes[i], since: now, reported: bytes[i] });
				continue;
			}
			if (seen.value !== bytes[i]) {
				seen.value = bytes[i];
				seen.since = now;
				continue;
			}
			if (now - seen.since >= RAW_SETTLE_MS && seen.reported !== seen.value) {
				seen.reported = seen.value;
				console.log(`settled: ${i} = ${hex(Uint8Array.of(seen.value))}`);
			}
		}
	}
	// The family decides the parser, exactly as it does in the service: an Xbox
	// report is built by the XInput source, not framed by the pad's HID firmware.
	const report: PadReport | undefined = family === "xbox" ? parseXboxInput(bytes) : parseDs4Input(bytes);
	if (!report) {
		// Once per shape, not once per report: a stream of identical complaints is
		// noise, and the shape is the diagnosis.
		const shape = `${bytes.length} bytes id ${bytes[0]}`;
		if (!unreadable.has(shape)) {
			unreadable.add(shape);
			console.log(`unreadable: ${shape} · ${hex(bytes.subarray(0, 16))}`);
		}
		return;
	}
	transports.add(report.transport);
	if (report.crcOk === false) badCrc++;
	if (flag("touch") && family === "ds4") {
		// Everything else is left unsaid here, which is the point of the mode: a
		// person sweeping a finger across the surface while the battery, the sticks
		// and the CRC print on every change has nothing to read.
		// A DS4 report is framed as one of its two transports; the ternary only
		// teaches the type what this branch already knows.
		const transport: Ds4Transport = report.transport === "bluetooth" ? "bluetooth" : "usb";
		const at = payloadAt(transport);
		const raw = hex(bytes.subarray(at + TOUCH_FROM, at + TOUCH_TO + 1));
		// Deduped on the block itself and not on the decoded line, so a stick being
		// moved — which changes the sample but not the surface — prints nothing.
		if (raw === lastTouch) return;
		lastTouch = raw;
		const touch = report.state.touch;
		if (touch === undefined) return;
		for (const point of touch) {
			if (point === undefined) continue;
			reached.minX = Math.min(reached.minX, point.x);
			reached.maxX = Math.max(reached.maxX, point.x);
			reached.minY = Math.min(reached.minY, point.y);
			reached.maxY = Math.max(reached.maxY, point.y);
			touchIds.add(point.id);
		}
		console.log(touchLine(touch, raw));
		return;
	}
	// Same line `/gamepad watch` prints, so what is verified here is what will be
	// read there; only printed when it changes, because a resting pad repeats.
	const line = formatSample({
		at: performance.now(),
		family,
		transport: report.transport,
		state: report.state,
		bytes: bytes.length,
		crcOk: report.crcOk,
	});
	if (line === lastLine) return;
	lastLine = line;
	console.log(line);
});

handle.onError((error) => {
	console.error(`device error: ${error.message}`);
});

console.log(
	flag("touch") && family === "ds4"
		? `Sweep the surface: top-left corner, then bottom-right, then a drag and a two-finger slide. ${seconds}s…`
		: `Press every button, one at a time. ${seconds}s…`,
);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const seen = [...transports];
console.log(
	`\n${reports} report(s) in ${seconds}s · ${seen.join(", ") || "no transport identified"}` +
		`${badCrc > 0 ? ` · ${badCrc} with a bad CRC` : ""}`,
);

if (flag("touch") && family === "ds4") {
	const ids = [...touchIds].sort((a, b) => a - b).join(", ");
	console.log(
		reached.maxX === -Infinity
			? "No finger was seen at all — if one was on the surface, the offsets are wrong."
			: `surface: x ${reached.minX}..${reached.maxX} · y ${reached.minY}..${reached.maxY} · touch id(s) ${ids}`,
	);
}

if (flag("light") || flag("rumble") || flag("dark")) {
	// A report beats the device's own description, and the device's own description
	// beats a guess: a pad that powered on over Bluetooth reports nothing readable
	// until it has been written to, so `seen` being empty is exactly the state this
	// write is here to end. An Xbox pad has no framing to guess: XInput is the
	// transport, whether the pad is on a cable or on the radio.
	const transport: PadTransport = seen[0] ?? (family === "xbox" ? "xinput" : deviceTransport(device));
	// This branch only runs for a DualShock 4 in the write itself; the type needs
	// to be told what the family already decided.
	const ds4Transport: Ds4Transport = transport === "xinput" ? "usb" : transport;
	if (seen.length === 0)
		console.log(`No report could be read, so this one is sent as ${transport} — what the device says it is.`);
	if (family === "xbox" && flag("light")) {
		console.log("An Xbox controller has no lightbar — only the motors can be asked to do anything.");
	}
	// Green rather than a colour of its own: two runs in a row are then two
	// identical packets, and this is a test of the write, not of the palette.
	const lightbar = flag("light") ? { r: 0, g: 255, b: 0 } : { r: 0, g: 0, b: 64 };
	const rumble = flag("rumble") ? { small: 140, large: 200 } : undefined;
	const packet =
		family === "xbox"
			? buildXboxOutput(flag("dark") ? {} : { rumble })
			: flag("dark")
				? buildDs4Output(ds4Transport)
				: buildDs4Output(ds4Transport, { lightbar, rumble });
	const wrote = handle.write(packet);
	console.log(
		`${wrote ? "Wrote" : "The device refused"} ${packet.length} bytes as ${transport} · ${hex(packet.subarray(0, 16))}`,
	);
	if (family === "ds4" && seen.length === 0) {
		// The write above was also a question, and this is the answer: a pad that
		// powered on over Bluetooth sends its USB shape — unreadable, and with no CRC
		// to prove otherwise — until a host writes to it, and its native report from
		// then on. Listening on afterwards is what turns "the lightbar came on" into
		// "the pad is now talking, and here is what it says".
		console.log(`Listening ${POST_WRITE_MS} ms for what the write changed…`);
		const before = reports;
		const badBefore = badCrc;
		await new Promise((resolve) => setTimeout(resolve, POST_WRITE_MS));
		const arrived = reports - before;
		console.log(
			arrived === 0
				? "Still nothing readable: the write did not change what the pad sends."
				: `${arrived} readable report(s) since the write · transport ${[...transports].join(", ")}` +
						`${badCrc > badBefore ? ` · ${badCrc - badBefore} with a bad CRC` : ""}`,
		);
	}
	if (flag("rumble")) {
		// The pad runs its motors until a packet says otherwise, and this process
		// exiting is not a packet. Printing the stop is half the test: a buzz that
		// outlives the probe is the one failure a person cannot tell from success.
		console.log(`Buzzing for ${BUZZ_MS} ms…`);
		await new Promise((resolve) => setTimeout(resolve, BUZZ_MS));
		handle.write(family === "xbox" ? buildXboxOutput() : buildDs4Output(ds4Transport, { lightbar }));
		console.log(
			family === "xbox" ? "Motors stopped." : "Motors stopped. The lightbar is left as it was — `--dark` turns it off.",
		);
	} else if (family === "xbox") {
		console.log("Xbox: there is no lightbar; `--rumble` is the only output this pad has.");
	} else {
		console.log(
			transport === "bluetooth"
				? "Wireless: the pad verifies the CRC before it looks at anything else, so a dark lightbar means the CRC, not the colour."
				: "USB: the lightbar should be lit now. Nothing to verify — a USB packet has no CRC.",
		);
	}
}

handle.close();
