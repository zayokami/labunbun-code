/**
 * Daisy Bell — a MIDI score the code plays itself.
 *
 * An easter egg with no asset. The tune is a score in this file, the score is
 * read into MIDI events (note number, a tick on a PPQ timeline, velocity), and
 * the events are played by a small synthesiser written here: partials, an
 * envelope, one delay tap. The result is a PCM buffer, a WAV, and one file
 * handed to whatever the machine already has for playing sound.
 *
 * The split is deliberate and is the reason this is not a `.mid` file plus a
 * player. A `.mid` needs a *MIDI output device*, and the honest survey of what
 * a developer actually has says otherwise: Windows has one (the wave table
 * synth, reachable only through winmm), macOS has one only if some app has
 * installed an IAC driver, and a Linux container usually has none of
 * `timidity`/`fluidsynth`. Shipping the file would mean shipping a command that
 * is silent everywhere except on some Windows machines, and silence is the one
 * outcome an easter egg must not have. So the score is MIDI — the units, the
 * tick clock and the velocities are all MIDI's — and the instrument is code.
 * What comes out is not a sampled piano, and it does not claim to be.
 *
 * Two limits, each because the alternative is worse:
 *
 * - **The score reader is not a general notation parser.** It takes this
 *   format — a pitch with an optional accidental and an octave, a `n/d` length,
 *   `R n/d` rests, and `#` lyric lines — and *throws* on anything else. A parser
 *   that accepted more would be one nobody has tested against the more.
 * - **The playback is fire-and-forget and says so.** The command returns at
 *   once, and when no player exists the command reports that rather than
 *   letting a REPL command look like it did nothing. What it does *not* report
 *   is a player that started and then failed — see the note on `detached` in
 *   {@link playDaisyBell}, which is where that bit actually bites.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * "Daisy, Daisy" — Harry Dacre, better known from *2001* and from every
 * machine that has ever been asked to hum. G major, 3/4, twenty-four bars.
 *
 * The lyrics are carried because they are most of what makes it the tune, and
 * the command prints them; they are not part of the MIDI stream, which has
 * nowhere to put words. The key is written on the first line as documentation
 * only — every accidental is written out on the note it belongs to, so the
 * synthesiser never needs a signature and pretending otherwise would be a
 * second, silent source of pitch.
 *
 * **The rests are the score, not its layout.** The lines run 5, 7, 5, 8, 9, 8,
 * 5 and 13 beats, and the eight phrases have to be separated or the tune is one
 * unbroken run of tines — eight lines of words sung at one tempo with nowhere
 * to breathe. So each rest fills the bar the phrase ended in, which puts every
 * phrase on the downbeat where a waltz wants it: 1, 2, 1, 1, **3**, 1, 1, 2
 * beats. The third one is a whole bar, because that phrase is exactly three
 * bars long and would otherwise run straight into the next one; the last rest
 * is silent in practice, since the renderer's one-second ring-out covers most
 * of it, and is here so the notated length is twenty-four *complete* bars.
 */
export const DAISY_BELL_SCORE = `# Tempo: 120 BPM
# Time Signature: 3/4
# Key: G major (documentation; every accidental is written out below)

# Daisy, Daisy
G4 1/4
E5 1/4
C5 1/4
G4 1/2
R 1/4

# Give me your answer, do
A4 1/4
B4 1/4
C5 1/4
A4 1/4
C5 1/4
G4 1/2
R 1/4
R 1/4

# I'm half crazy
D5 1/4
G5 1/4
E5 1/4
C5 1/2
R 1/4

# All for the love of you
A4 1/4
B4 1/4
C5 1/4
D5 1/4
E5 1/4
D5 1/4
C5 1/2
R 1/4

# It won't be a stylish marriage
E5 1/4
F#5 1/4
E5 1/4
D5 1/4
G5 1/4
E5 1/4
D5 1/4
C5 1/2
R 1/4
R 1/4
R 1/4

# I can't afford a carriage
D5 1/4
E5 1/4
C5 1/4
A4 1/4
C5 1/4
A4 1/4
G4 1/2
R 1/4

# But you'll look sweet
G4 1/4
C5 1/4
E5 1/4
D5 1/2
R 1/4

# Upon the seat of a bicycle built for two
G4 1/4
C5 1/4
E5 1/4
D5 1/4
E5 1/4
F#5 1/4
G5 1/4
E5 1/4
C5 1/4
D5 1/4
G4 1/4
C5 1/2
R 1/4
R 1/4
`;

/**
 * Ticks per quarter note, the MIDI default and the unit every length here is
 * measured in. A whole note is four of them, which is how `1/2` and `1/8` come
 * out as two and half as many ticks as `1/4` without a table of note values.
 */
export const TICKS_PER_QUARTER = 480;

const TICKS_PER_WHOLE = TICKS_PER_QUARTER * 4;

/**
 * Velocities for the waltz's two kinds of beat.
 *
 * A note list has no dynamics in it, so the accent is derived: in 3/4 the first
 * beat of the bar is the strong one and the other two are not. That is a
 * musical decision, and it is why the score is kept in MIDI's own units rather
 * than as a list of frequencies — velocity is a field with somewhere to go.
 */
const ACCENT_VELOCITY = 96;
const BEAT_VELOCITY = 84;

const SAMPLE_RATE = 44_100;

/** How long the last note is allowed to ring past the end of the score. */
const RING_OUT_SECONDS = 1;

/**
 * Where each partial sits and how loud it is.
 *
 * A struck metal tine is not a sine: it is a few partials that die at different
 * rates, and the higher ones dying first is most of what makes it read as
 * *struck* rather than *held*. A plain sine with an envelope is a test tone.
 */
const PARTIALS = [1, 2, 3, 4, 5];
const PARTIAL_GAIN = [1, 0.42, 0.2, 0.09, 0.04];

/**
 * Ramps in over this long.
 *
 * Every partial starts at `sin(0) = 0`, so the sum starts at zero on its own —
 * this is not what stops a click. What it does is keep the first couple of
 * milliseconds gentle: five partials sum faster than one does, and without the
 * ramp the attack is noticeably sharper than the tail it decays into.
 */
const ATTACK_SECONDS = 0.002;

/**
 * How long a note keeps sounding after the score has finished with it.
 *
 * This is the note-off, and it is why the rests in the score are audible as
 * rests. Without it a note rings for `held + tau * 4` however the score is
 * written — a quarter note at G4 has `tau ≈ 0.9 s`, so it is still at 57% a
 * whole beat later, and a written rest fills itself. Measured across the first
 * four rests of the tune, the level inside a rest came to 72% of the level
 * before it: a dip, not a gap. Damping over 120 ms puts the level a seventh of
 * that by 150 ms into the rest and under 2% by the end of it.
 *
 * It is **not** what makes consecutive notes separate, which is the obvious
 * thing to hope for and is not what happens: across the seam between two
 * quarter notes there is no trough at all, measured in 25 ms slices, just a
 * step from 6216 to 11686 as the next note strikes over the top of it. A note
 * an octave up is louder and decays faster, so it covers the tail underneath.
 * The rests are where the release is heard; the line between them is still one
 * unbroken run.
 */
const RELEASE_SECONDS = 0.12;

/**
 * One delay tap, and this is the whole of the ambience.
 *
 * A monophonic line played dry sounds like a test; one tap at a musical echo
 * time makes consecutive notes sit in a room. It is an instrument property and
 * adds no notes, so the score is untouched by it.
 */
const DELAY_SECONDS = 0.19;
const DELAY_GAIN = 0.28;

/** Peak the rendered buffer is normalised to, leaving a little headroom. */
const PEAK = 0.85;

// ---------------------------------------------------------------------------
// Score → MIDI events
// ---------------------------------------------------------------------------

/** Semitones above C, per letter. */
const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export interface ScoreNote {
	/** MIDI note number: C4 is 60, A4 is 69. */
	midi: number;
	startTick: number;
	durationTicks: number;
	/** 0–127. Read by the synthesiser; a score that carries it is not a melody. */
	velocity: number;
	/**
	 * The lyric heading the phrase this note is in, when the score carried one.
	 *
	 * A lyric comment stands over a whole phrase rather than over the note beneath
	 * it, so it stays until the next one replaces it. Clearing it after a single
	 * note would read the layout as a syllabified melody — one word per note —
	 * which is a claim the note list does not make.
	 */
	text?: string;
}

export interface ScoreRest {
	startTick: number;
	durationTicks: number;
}

export interface Score {
	/** Quarter notes per minute, from the score's own `Tempo:` line. */
	bpm: number;
	/** Beats per bar and the note value a beat is written in. */
	beatsPerBar: number;
	beatDenominator: number;
	notes: ScoreNote[];
	/**
	 * The rests, in order. Written as their own lines rather than inferred from
	 * the layout so that the silence is score data a test can read, instead of an
	 * accident of how the source happens to be formatted.
	 */
	rests: ScoreRest[];
	/** Length of the notated score in ticks, excluding any ring-out. */
	ticks: number;
	/** The same, in seconds. */
	seconds: number;
	/** The lyric lines, in order, without repeats. */
	lyrics: string[];
}

/** Thrown for a score this reader will not interpret, rather than guessing at it. */
export class ScoreSyntaxError extends Error {
	/** The offending line, kept rather than folded into the message alone. */
	readonly line: string;

	constructor(message: string, line: string) {
		super(`${message} — in ${JSON.stringify(line)}`);
		this.name = "ScoreSyntaxError";
		this.line = line;
	}
}

const TEMPO_LINE = /^#\s*Tempo:\s*(\d+(?:\.\d+)?)\s*BPM\b/i;
const TIME_LINE = /^#\s*Time Signature:\s*(\d+)\s*\/\s*(\d+)\s*$/i;
/**
 * The key line is skipped rather than sung.
 *
 * Matching it with a negative lookahead does not work: `\s*` backtracks, so a
 * one-space `Key:` still slips past the guard one character early and the line
 * comes back as a lyric. Naming the line that is *not* a lyric has no such
 * failure mode.
 */
const KEY_LINE = /^#\s*Key:/i;
const LYRIC_LINE = /^#\s+(.+)$/;
const NOTE_LINE = /^([A-G])([#b]?)(\d)\s+(\d+)\/(\d+)$/;
/** A rest: `R 1/4`. `R` is not a note letter, so it cannot collide with a pitch. */
const REST_LINE = /^R\s+(\d+)\/(\d+)$/;

/**
 * Read this score format into MIDI events.
 *
 * Tempo and metre are read from the score rather than taken as arguments: they
 * are the two things that change what a length *means*, so a caller that could
 * override them would be able to play a score at a tempo it was not written in
 * and still get a file. Everything else is computed — a note's start is the
 * sum of the ones before it, which is the only definition of a start.
 */
export function parseScore(score: string = DAISY_BELL_SCORE): Score {
	const lines = score.split(/\r?\n/);
	let bpm: number | undefined;
	let beatsPerBar: number | undefined;
	let beatDenominator: number | undefined;
	const notes: ScoreNote[] = [];
	const rests: ScoreRest[] = [];
	const lyrics: string[] = [];
	let pendingLyric: string | undefined;
	let tick = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		// Layout, not notation. A blank line between two phrases used to be read as
		// "nothing happens here", which it does not mean: the tick clock advances
		// only by note lengths, so the eight phrases came out legato with no gap at
		// all — the tune as one unbroken run of tines. Silence between the phrases
		// is written down, as `R` lines, where it can be read and tested.
		if (trimmed.length === 0) continue;

		const tempo = TEMPO_LINE.exec(trimmed);
		if (tempo) {
			bpm = Number(tempo[1]);
			continue;
		}
		const metre = TIME_LINE.exec(trimmed);
		if (metre) {
			beatsPerBar = Number(metre[1]);
			beatDenominator = Number(metre[2]);
			continue;
		}
		if (KEY_LINE.test(trimmed)) continue;
		const lyric = LYRIC_LINE.exec(trimmed);
		if (lyric?.[1]) {
			pendingLyric = lyric[1].trim();
			lyrics.push(pendingLyric);
			continue;
		}

		const rest = REST_LINE.exec(trimmed);
		if (rest) {
			const count = Number(rest[1]);
			const denominator = Number(rest[2]);
			if (!(count > 0) || !(denominator > 0)) {
				throw new ScoreSyntaxError("a rest's two numbers are both positive", line);
			}
			const durationTicks = (count * TICKS_PER_WHOLE) / denominator;
			// The clock moves and nothing is struck. Nothing downstream needs to
			// know: a rest is the absence of a note, and the next note's start is
			// simply later.
			rests.push({ startTick: tick, durationTicks });
			tick += durationTicks;
			continue;
		}

		const note = NOTE_LINE.exec(trimmed);
		if (!note) {
			throw new ScoreSyntaxError(
				"not a note this reader knows (`<letter>[#b]<octave> <n>/<d>`, `R <n>/<d>`, or `# <lyric>`)",
				line,
			);
		}

		const letter = note[1] ?? "";
		const semitone = LETTER_SEMITONE[letter];
		if (semitone === undefined) throw new ScoreSyntaxError("not a note letter", line);

		// A written accidental is absolute, not relative to anything: the key line
		// is documentation, so F#5 means F#5 rather than "F sharp unless the key
		// already said so".
		const alteration = note[2] === "#" ? 1 : note[2] === "b" ? -1 : 0;
		const octave = Number(note[3]);
		const midi = (octave + 1) * 12 + semitone + alteration;

		const count = Number(note[4]);
		const denominator = Number(note[5]);
		if (!(count > 0) || !(denominator > 0)) {
			throw new ScoreSyntaxError("a length's two numbers are both positive", line);
		}
		const durationTicks = (count * TICKS_PER_WHOLE) / denominator;

		// The accent needs the bar, so a score with no metre yet cannot be placed.
		// That is a real ordering constraint rather than a pedantic one: a strong
		// beat that is really two quarters early is worse than no accent at all.
		if (beatsPerBar === undefined || beatDenominator === undefined) {
			throw new ScoreSyntaxError("no `Time Signature:` line yet, so beats cannot be counted", line);
		}
		const barTicks = (beatsPerBar * TICKS_PER_WHOLE) / beatDenominator;
		const onStrongBeat = Math.round(tick % barTicks) === 0;

		// `pendingLyric` is deliberately not cleared after a note: it survives until
		// the next lyric line, because that line heads a phrase and every note under
		// it is part of that phrase.
		notes.push({
			midi,
			startTick: tick,
			durationTicks,
			velocity: onStrongBeat ? ACCENT_VELOCITY : BEAT_VELOCITY,
			...(pendingLyric ? { text: pendingLyric } : {}),
		});
		tick += durationTicks;
	}

	if (!bpm) throw new ScoreSyntaxError("no `Tempo:` line, so the score has no length in time", "");
	if (beatsPerBar === undefined || beatDenominator === undefined) {
		throw new ScoreSyntaxError("no `Time Signature:` line", "");
	}
	if (notes.length === 0) throw new ScoreSyntaxError("no notes", "");

	// One quarter per beat, the tempo's own unit: at 120 BPM a tick is 1/960 s.
	const seconds = tick / (TICKS_PER_QUARTER * (bpm / 60));
	return { bpm, beatsPerBar, beatDenominator, notes, rests, ticks: tick, seconds, lyrics };
}

/** Equal-tempered frequency for a MIDI note number, A4 = 69 = 440 Hz. */
export function noteFrequency(midi: number): number {
	return 440 * 2 ** ((midi - 69) / 12);
}

// ---------------------------------------------------------------------------
// MIDI events → sound
// ---------------------------------------------------------------------------

/**
 * Render a score as a 16-bit mono PCM WAV.
 *
 * Every note is summed into one buffer at its own offset rather than drawn into
 * a span of its own, which is the whole point: a music box rings into the next
 * note, and notes that do not overlap are thirty separate beeps.
 */
export function renderWav(score: Score, sampleRate: number = SAMPLE_RATE): Uint8Array {
	const tailSeconds = score.seconds + RING_OUT_SECONDS;
	const samples = new Float64Array(Math.max(1, Math.ceil(tailSeconds * sampleRate)));
	const secondsPerTick = 1 / (TICKS_PER_QUARTER * (score.bpm / 60));

	for (const note of score.notes) {
		const from = Math.round(note.startTick * secondsPerTick * sampleRate);
		if (from >= samples.length) continue;

		const frequency = noteFrequency(note.midi);
		const level = note.velocity / 127;
		// Higher tines ring shorter. Shorter notes ring shorter too, but not from
		// this constant — from the release below, which ends them at the tick the
		// score says they end. A note cut off before it has rung is an organ, not
		// a music box, so the two together rather than either alone: the decay
		// decides how a note sounds, the release decides when it stops.
		const held = note.durationTicks * secondsPerTick;
		const decay = Math.min(2.4, Math.max(0.3, 1.15 * (261.63 / frequency) ** 0.55));

		for (let p = 0; p < PARTIALS.length; p++) {
			const ratio = PARTIALS[p] ?? 1;
			const gain = PARTIAL_GAIN[p] ?? 1;
			const hz = frequency * ratio;
			// Above Nyquist there is nothing to render; dropping the partial is
			// audible only as a slightly plainer top note, which beats aliasing.
			if (hz >= sampleRate / 2) continue;
			const tau = decay / (1 + (ratio - 1) * 0.45);
			const step = (2 * Math.PI * hz) / sampleRate;
			const attackSamples = Math.max(1, Math.round(ATTACK_SECONDS * sampleRate));
			const heldSamples = Math.round(held * sampleRate);
			// Long enough for the tail to fall away, or to the end of the buffer.
			const length = Math.min(samples.length - from, Math.ceil((held + tau * 4) * sampleRate));

			for (let i = 0; i < length; i++) {
				// Past the note's written length the instrument is damped rather than
				// left to ring: exponential still, so nothing steps, but on a 120ms
				// time constant instead of the partial's own second or so.
				const release = i < heldSamples ? 1 : Math.exp(-(i - heldSamples) / sampleRate / RELEASE_SECONDS);
				const envelope = Math.exp(-i / sampleRate / tau) * Math.min(1, i / attackSamples) * release;
				// The gain belongs to the partial, not the note: an equal-amplitude
				// sum of five sines is a different instrument, one that starts bright
				// and has nothing to lose, which is the opposite of a struck tine.
				samples[from + i] += level * gain * envelope * Math.sin(step * i);
			}
		}

		echoInto(samples, from, Math.round(DELAY_SECONDS * sampleRate), DELAY_GAIN * level);
	}

	return toWav(normalise(samples), sampleRate);
}

/** One feedback tap: the note again, quieter and late. */
function echoInto(samples: Float64Array, from: number, offsetSamples: number, gain: number): void {
	if (offsetSamples <= 0) return;
	const end = samples.length - offsetSamples;
	for (let i = from; i < end; i++) samples[i + offsetSamples] += gain * samples[i];
}

/**
 * Scale to {@link PEAK}, leaving headroom so the writer's clamp is never what
 * stops a peak.
 *
 * There used to be a fade over the last 0.3 s of the buffer here, so the file
 * could not stop on a sample edge. It was dead, and the falsification driver is
 * what said so: mutating the fade away left the whole suite green, because
 * {@link RELEASE_SECONDS} damps the last note 0.12 s after its final tick and
 * the buffer runs a full second past that — every sample the fade would have
 * touched was already at the 16-bit floor. Untestable is how you recognise it.
 *
 * The click it was guarding is still guarded, by the release instead, and
 * guarding it is cheaper than repairing it: a release long enough to ring past
 * the end of the buffer is exactly what produces a click, and the tail-silence
 * test fails loudly when that happens.
 */
function normalise(samples: Float64Array): Float64Array {
	let peak = 0;
	for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
	if (peak === 0) return samples;

	const scale = (PEAK * 32_767) / peak;
	for (let i = 0; i < samples.length; i++) samples[i] *= scale;
	return samples;
}

/**
 * A canonical 44-byte-header PCM WAV. Every player takes one of these, and a
 * header is the only part of this file a test can read without hearing it.
 */
function toWav(samples: Float64Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * 2;
	const bytes = new Uint8Array(44 + dataBytes);
	const view = new DataView(bytes.buffer);

	const text = (offset: number, value: string): void => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};

	text(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // format: PCM
	view.setUint16(22, 1, true); // channels
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	text(36, "data");
	view.setUint32(40, dataBytes, true);

	for (let i = 0; i < samples.length; i++) {
		// Clamped rather than wrapped: a rounded value past full scale wrapping
		// around is a loud click, which is the one artefact a jingle cannot have.
		view.setInt16(44 + i * 2, Math.max(-32_768, Math.min(32_767, Math.round(samples[i]))), true);
	}
	return bytes;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

export interface Player {
	command: string;
	/** The argv, given the WAV's path. */
	args: (path: string) => string[];
}

/**
 * The players to try, in order, for a platform.
 *
 * Windows first because it is the least obvious: there is no `afplay` there,
 * and `System.Media.SoundPlayer` is reached through PowerShell. `PlaySync` rather
 * than `Play` — an async play dies with the process that started it, which would
 * be a jingle that starts and then stops.
 */
export function playerCandidates(platform: string): Player[] {
	if (platform === "win32") {
		return [
			{
				command: "powershell.exe",
				args: (path) => [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					// No `-ExecutionPolicy Bypass`, and its absence is measured rather than
					// assumed: an inline `-Command` string is not a script file, so the
					// policy has nothing to gate, and the probe WAV played with the flag
					// omitted. Adding it would mean shipping a switch that disarms the
					// machine's policy on every `/HAL` — and on the machines whose policy
					// actually refuses it, the child would exit non-zero into a `stdio:
					// "ignore"` the caller never reads, which is silence with a success
					// message above it.
					//
					// A non-zero exit is how a caller finds out it did not play: with no
					// audio device, or no such assembly, PowerShell throws.
					`$ErrorActionPreference='Stop'; $p=New-Object System.Media.SoundPlayer '${path.replace(/'/g, "''")}'; $p.PlaySync()`,
				],
			},
		];
	}
	if (platform === "darwin") return [{ command: "afplay", args: (path) => [path] }];
	// Everything else gets the two names a minimal container actually has.
	return [
		{ command: "aplay", args: (path) => ["-q", path] },
		{ command: "paplay", args: (path) => [path] },
	];
}

export interface Playback {
	/** True when a player was started. */
	played: boolean;
	/** What the command says, either way. */
	message: string;
}

/**
 * How a player is started.
 *
 * Its own export, and not because the options need naming — because the one
 * option here is a bug that is invisible in every other way. `detached: true`
 * is the house style for background work in this repo (`background.ts`,
 * `hooks.ts`) and it silently produces a command that reports success over
 * thirty seconds of silence, which no return value, no exit code and no test
 * over the rendered buffer can distinguish from a tune that played.
 *
 * A source-text guard cannot catch it either: the comment explaining why it is
 * wrong has to name the flag, so the string is in the file. Reading the value
 * is the only version of this test that is not a comment about a comment.
 *
 * Measured on this machine, a 3-second WAV through the same argv four ways:
 *
 *     spawnSync, foreground           lived 4576 ms   plays
 *     detached: false, stdio ignore   lived 4832 ms   plays
 *     detached: false, stdio inherit  lived 4442 ms   plays
 *     detached: true,  stdio ignore   lived  510 ms   silent, exits 0
 *     detached: true,  stdio pipe     lived  526 ms   silent, exits 0
 *
 * Only `detached` moves the number, and only on Windows: `detached: true` passes
 * `DETACHED_PROCESS`, and a PowerShell with no console comes back from
 * `SoundPlayer.PlaySync()` immediately instead of waiting for the sound.
 */
export function playerSpawnOptions(): { detached: boolean; stdio: "ignore" } {
	return { detached: false, stdio: "ignore" };
}

/**
 * Render and hand off to a player. Returns as soon as one has started, so the
 * REPL stays usable while the tune is still going.
 */
export async function playDaisyBell(): Promise<Playback> {
	const score = parseScore();
	const wav = renderWav(score);
	const players = playerCandidates(process.platform);
	const chosen = players.find((player) => Bun.which(player.command) !== null);
	const sung = `${score.notes.length} notes over ${score.seconds.toFixed(1)} seconds`;

	if (!chosen) {
		return {
			played: false,
			message:
				`♪  Daisy Bell  ♪\n${score.lyrics.join("\n")}\n\n` +
				`I tried, but this machine has none of ${players.map((p) => p.command).join(" or ")} to play it with. ` +
				`The tune is ${sung}, and it would have been Daisy Bell.`,
		};
	}

	const dir = mkdtempSync(join(tmpdir(), "labunbun-daisy-bell-"));
	const path = join(dir, "daisy-bell.wav");
	writeFileSync(path, wav);

	// **Not detached** — see {@link playerSpawnOptions} for the measurement, which
	// is the whole reason this call is not just the house style.
	//
	// `unref()` is what actually keeps the REPL usable: it drops the child's handle
	// from the event loop's refcount, so the process can exit without waiting for
	// the tune while the tune carries on playing. The cost of not detaching is that
	// a Ctrl-C reaches the player too, which stops the jingle early and is a fair
	// trade for a jingle that plays at all.
	const proc = spawn(chosen.command, chosen.args(path), playerSpawnOptions());
	proc.unref();
	proc.on("error", () => {
		// The child is gone before it could play; the directory goes with it so a
		// failed run does not leave a WAV behind for the OS to find.
		rmSync(dir, { recursive: true, force: true });
	});

	return {
		played: true,
		message: `♪  Daisy Bell  ♪  ${sung}, rendered here.\n${score.lyrics.join("\n")}`,
	};
}
