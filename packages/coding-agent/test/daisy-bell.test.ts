/**
 * Daisy Bell, and what can be pinned about a tune.
 *
 * The honest limit of this file: **nothing here can hear anything.** A WAV is a
 * header and a column of numbers, so every assertion is about a quantity a
 * listener would also perceive — how long it is, how many notes, which pitches,
 * whether the buffer is silent or clipping — and none of them is about whether it
 * sounds like Daisy Bell. What a test *can* do is catch the failure that matters
 * for an easter egg: a silent command, or one that ends in a click.
 *
 * The note events are MIDI's own units, so the assertions read in ticks and
 * note numbers rather than in seconds and hertz, and a tempo change is pinned to
 * move one and not the other.
 */
import { describe, expect, test } from "bun:test";
import { builtInCommands, findCommand } from "../src/commands.ts";
import {
	DAISY_BELL_SCORE,
	noteFrequency,
	parseScore,
	playerCandidates,
	playerSpawnOptions,
	renderWav,
	type Score,
	ScoreSyntaxError,
	TICKS_PER_QUARTER,
} from "../src/daisy-bell.ts";

/** A 3/4 bar in ticks: three quarters. */
const BAR_TICKS = TICKS_PER_QUARTER * 3;

/** The shortest score the reader accepts, for the cases that are not about pitch. */
const MINIMAL = `# Tempo: 120 BPM
# Time Signature: 3/4
C4 1/4
`;

/** Samples of a rendered WAV, indexed from zero, as signed 16-bit values. */
function samplesOf(wav: Uint8Array): (index: number) => number {
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	return (index) => view.getInt16(44 + index * 2, true);
}

/**
 * Root-mean-square over a window of samples.
 *
 * A single sample is a poor witness for anything to do with an envelope: five
 * partials sum, and where the sum happens to be crossing zero is a fact about the
 * phase, not the level. Comparing one sample of a ramped attack to one sample
 * after it measures whichever way those two particular sines were pointing. An RMS
 * is what a listener would call louder, and it does not care where the crossings
 * are — measured over twelve starting phases, a steady window of this width
 * varies by 10%.
 */
function rms(get: (index: number) => number, from: number, to: number): number {
	let sum = 0;
	for (let i = from; i < to; i++) sum += get(i) ** 2;
	return Math.sqrt(sum / (to - from));
}

/**
 * Amplitude of one frequency in a window, by the Goertzel algorithm.
 *
 * Not a general spectrum: a window per frequency, so this answers one question
 * well — *how loud is the second partial relative to the first* — at a fraction
 * of the cost of an FFT and with no window-function bookkeeping to get wrong.
 * The returned value is an amplitude estimate, comparable across calls at the
 * same window length.
 */
function goertzel(get: (index: number) => number, from: number, length: number, hz: number): number {
	const step = (2 * Math.PI * hz) / 44_100;
	const coefficient = 2 * Math.cos(step);
	let previous = 0;
	let beforePrevious = 0;
	for (let i = 0; i < length; i++) {
		const current = get(from + i) + coefficient * previous - beforePrevious;
		beforePrevious = previous;
		previous = current;
	}
	const real = previous - beforePrevious * Math.cos(step);
	const imaginary = beforePrevious * Math.sin(step);
	return (2 * Math.hypot(real, imaginary)) / length;
}

describe("the score", () => {
	test("is twenty-four bars of 3/4 at 120, and says so", () => {
		const score = parseScore();

		// Read from the score rather than assumed: a tempo that quietly stopped
		// being read would still play, just at the wrong speed, and nothing else
		// here would notice.
		expect(score.bpm).toBe(120);
		expect(score.beatsPerBar).toBe(3);
		expect(score.beatDenominator).toBe(4);
		// 24 bars x 3 quarters x 480 ticks, and 60 beats of notes plus 12 of rest.
		expect(score.ticks).toBe(34_560);
		expect(score.seconds).toBe(36);
	});

	test("is the fifty-two notes it claims to be", () => {
		const score = parseScore();

		expect(score.notes).toHaveLength(52);
		// Starts on G4 and lands on C5: the shape of the tune in two numbers,
		// which is what a transposition or a dropped line would move.
		expect(score.notes[0]?.midi).toBe(67);
		expect(score.notes.at(-1)?.midi).toBe(72);
	});

	test("notes and rests tile the timeline with no gap and no overlap", () => {
		// Both halves matter, and the second is the one that was wrong. A reader
		// that advanced the clock by note lengths only — which is what this file did
		// before the rests existed — still satisfies "nothing overlaps"; it fails
		// this, because the rests' lengths are then missing and the notes that
		// follow them start early. The tune it produces is eight phrases run
		// legato together, which is what a listener hears as no gap at all.
		const score = parseScore();
		const events = [...score.notes, ...score.rests].sort((a, b) => a.startTick - b.startTick);

		expect(events).toHaveLength(score.notes.length + score.rests.length);
		let tick = 0;
		for (const event of events) {
			expect(event.startTick).toBe(tick);
			tick += event.durationTicks;
		}
		expect(tick).toBe(score.ticks);
	});

	test("every phrase is separated from the last by a rest", () => {
		// The bug this pins was reported by ear, not found by a test: the eight
		// phrases ran into each other because the blank line between them was read
		// as layout and nothing else. So this asserts the thing the ear was
		// complaining about — a rest at every seam — and not merely that rests
		// exist somewhere.
		const score = parseScore();
		const seams: number[] = [];
		let previousEnd = 0;
		let previousText: string | undefined;
		for (const note of score.notes) {
			if (previousText !== undefined && note.text !== previousText) seams.push(previousEnd);
			previousEnd = note.startTick + note.durationTicks;
			previousText = note.text;
		}

		// Seven seams between eight phrases. Each one starts exactly where the
		// phrase before it stopped — not a tick earlier, which would eat the last
		// note's ring, and not a tick later, which would be a gap nobody can hear.
		expect(seams).toHaveLength(7);
		for (const seam of seams) {
			const rest = score.rests.find((candidate) => candidate.startTick === seam);
			expect(rest).toBeDefined();
			// The whole of the gap, and not a prefix of it: a rest too short to
			// matter passes this if the assertion is only `toBeDefined`.
			expect(rest?.durationTicks).toBeGreaterThanOrEqual(TICKS_PER_QUARTER);
		}
		// Twelve `R` lines, one per written beat: the seams are 1, 2, 1, 1, 3, 1
		// and 1 beats, which is ten of them, and two more close the last bar. A
		// multi-beat gap is several rests in the score and so it is several here —
		// there is no `R` spelling that means "the rest of the bar" in this format,
		// and inventing one would mean the reader knew about the metre twice.
		expect(score.rests).toHaveLength(12);
	});

	test("every phrase begins on a downbeat", () => {
		// In 3/4 a waltz line wants the strong beat, and the rests are chosen so
		// that they get it: a phrase runs 5, 7, 5, 8, 9, 8, 5, 13 beats, and each
		// rest fills the bar the phrase stopped in — 1, 2, 1, 1, 3, 1, 1, 2 beats.
		// The third is a whole bar, because that phrase is exactly three bars long
		// and would otherwise butt against the next one with nothing between them.
		const score = parseScore();
		const starts: number[] = [];
		let previousText: string | undefined;
		for (const note of score.notes) {
			if (note.text !== previousText) starts.push(note.startTick);
			previousText = note.text;
		}

		expect(starts).toHaveLength(8);
		for (const start of starts) {
			expect(start % BAR_TICKS).toBe(0);
		}
		// Bars 1, 3, 6, 8, 11, 15, 18, 20 — read rather than assumed, because
		// "every phrase is on a downbeat" is also true of a score with only one
		// phrase in it.
		expect(starts.map((start) => start / BAR_TICKS + 1)).toEqual([1, 3, 6, 8, 11, 15, 18, 20]);
	});

	test("A4 is 440 Hz and C4 is middle C", () => {
		// The one conversion in the file that a wrong answer would make the tune
		// transposed rather than merely wrong, so it is pinned at both ends.
		expect(noteFrequency(69)).toBeCloseTo(440, 6);
		expect(noteFrequency(60)).toBeCloseTo(261.6256, 3);
		// The written accidental, not the key: F#5 is 78 and F5 is 77.
		const score = parseScore();
		const sharps = score.notes.filter((note) => note.midi === 78);
		expect(sharps).toHaveLength(2);
		expect(score.notes.some((note) => note.midi === 77)).toBe(false);
	});

	test("the accent follows the bar, not the phrase", () => {
		const score = parseScore();

		const accented = score.notes.filter((note) => note.velocity === 96);
		const onTheBar = score.notes.filter((note) => note.startTick % BAR_TICKS === 0);
		// The same set, seen two ways. A reader that computed the accent from
		// anything but the bar would put these two out of step.
		expect(accented.map((note) => note.startTick)).toEqual(onTheBar.map((note) => note.startTick));
		// Not every bar: 24 bars, of which three open on a rest or in the middle
		// of the note before it — 5 and 24 carry a half note over the downbeat, and
		// 14 opens on the whole-bar rest. If this ever equals 24, the accent has
		// stopped being an accent and become a marker of "wherever the tune starts
		// a line", which is the failure this assertion is here to catch.
		expect(accented).toHaveLength(21);
	});

	test("a tempo change moves the seconds and leaves the ticks alone", () => {
		const slow = parseScore(DAISY_BELL_SCORE.replace("Tempo: 120 BPM", "Tempo: 60 BPM"));

		expect(slow.ticks).toBe(parseScore().ticks);
		expect(slow.seconds).toBe(72);
	});

	test("the lyrics come off the notes they were written under", () => {
		const score = parseScore();

		expect(score.lyrics).toHaveLength(8);
		expect(score.lyrics[0]).toBe("Daisy, Daisy");
		expect(score.lyrics.at(-1)).toBe("Upon the seat of a bicycle built for two");
		// The key line is a header like the tempo, not something to sing. Getting
		// this wrong is quiet: an extra line in the transcript and nothing else.
		expect(score.lyrics.some((line) => line.startsWith("Key:"))).toBe(false);
		expect(score.notes[0]?.text).toBe("Daisy, Daisy");
		// Both ends of the first phrase, and the seam between two phrases. A reader
		// that cleared the lyric after one note would answer the middle one
		// `undefined` and the seam one "Daisy, Daisy" — and the transcript it prints
		// would still come out looking right.
		expect(score.notes[3]?.text).toBe("Daisy, Daisy");
		expect(score.notes[4]?.text).toBe("Give me your answer, do");
		expect(new Set(score.notes.map((note) => note.text)).size).toBe(8);
	});
});

describe("a score the reader will not guess at", () => {
	test("no tempo", () => {
		expect(() => parseScore("# Time Signature: 3/4\nC4 1/4\n")).toThrow(ScoreSyntaxError);
	});

	test("no time signature", () => {
		// Not deferred to the end either: the accent needs the bar, so the first
		// note is already unreadable.
		expect(() => parseScore("# Tempo: 120 BPM\nC4 1/4\n")).toThrow(/Time Signature/);
	});

	test("no notes at all", () => {
		expect(() => parseScore("# Tempo: 120 BPM\n# Time Signature: 3/4\n")).toThrow(/no notes/);
	});

	test("a letter that is not a note", () => {
		expect(() => parseScore(`${MINIMAL}H4 1/4\n`)).toThrow(ScoreSyntaxError);
	});

	test("a length that is not n/d", () => {
		// `G4 half` and `G4 2` are both readable if you guess. Guessing is how a
		// score plays at the wrong tempo and nobody notices for twenty seconds.
		expect(() => parseScore(`${MINIMAL}G4 half\n`)).toThrow(ScoreSyntaxError);
		expect(() => parseScore(`${MINIMAL}G4 2\n`)).toThrow(ScoreSyntaxError);
	});

	test("an error names the line it gave up on", () => {
		try {
			// A double sharp is a real pitch the format cannot write, and the wrong
			// thing to do about it is read `G#5` and carry on: the note would be a
			// semitone flat, in a bar with nothing else wrong to notice it by.
			parseScore(`${MINIMAL}G##5 1/4\n`);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(ScoreSyntaxError);
			expect((error as ScoreSyntaxError).line).toBe("G##5 1/4");
		}
	});
});

describe("the WAV", () => {
	const wav = renderWav(parseScore());
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	const ascii = (at: number, length: number): string => String.fromCharCode(...wav.subarray(at, at + length));
	const sampleAt = samplesOf(wav);
	const sampleCount = (wav.length - 44) / 2;

	test("is a canonical 16-bit mono PCM file at 44100", () => {
		expect(ascii(0, 4)).toBe("RIFF");
		expect(ascii(8, 4)).toBe("WAVE");
		expect(ascii(12, 4)).toBe("fmt ");
		expect(view.getUint32(16, true)).toBe(16); // PCM fmt chunk
		expect(view.getUint16(20, true)).toBe(1); // format: PCM, not float
		expect(view.getUint16(22, true)).toBe(1); // channels
		expect(view.getUint32(24, true)).toBe(44_100);
		// Byte rate is rate x channels x bytes-per-sample; a header that says 44100
		// and omits this plays short or slow on some players and not others.
		expect(view.getUint32(28, true)).toBe(88_200);
		expect(view.getUint16(32, true)).toBe(2);
		expect(view.getUint16(34, true)).toBe(16);
		expect(ascii(36, 4)).toBe("data");
	});

	test("declares the size it actually has", () => {
		// The single most common way a hand-written WAV is rejected: the chunks
		// say one length and the file is another, and the player stops early.
		expect(view.getUint32(4, true)).toBe(wav.length - 8);
		expect(view.getUint32(40, true)).toBe(wav.length - 44);
		expect((wav.length - 44) % 2).toBe(0);
	});

	test("is as long as the score plus one second of ring-out", () => {
		expect(wav.length).toBe(44 + (36 + 1) * 44_100 * 2);
	});

	test("carries sound, and none of it clips", () => {
		let peak = 0;
		let loudest = 0;
		for (let i = 0; i < sampleCount; i++) {
			const value = Math.abs(sampleAt(i));
			if (value > peak) {
				peak = value;
				loudest = i;
			}
		}

		// Not a buffer of zeros: the command would exit 0 and make no sound.
		expect(peak).toBeGreaterThan(1000);
		// Normalised to 0.85 of full scale, so the clamp in the writer is never
		// reached and a peak of 32767 means something upstream doubled up.
		expect(peak).toBeLessThan(32_767);
		expect(peak).toBeGreaterThan(27_000);
		// And the loudest moment is inside the tune, not in a tail of garbage.
		expect(loudest).toBeGreaterThan(0);
		expect(loudest).toBeLessThan(wav.length / 2);
	});

	test("starts gently rather than jumping to full scale", () => {
		// One note, so the reference window is the same note: same partials, same
		// envelope, same normalisation, a quarter of a second later. Comparing the
		// first two milliseconds of a note against the first two milliseconds of a
		// *different* note instead would be measuring which note is louder.
		const get = samplesOf(renderWav(parseScore(MINIMAL)));
		const attack = rms(get, 0, 88);

		// A linear ramp has a mean square of 1/3, so the ratio belongs at
		// sqrt(1/3) = 0.577 whatever the note is, and an un-ramped note sits at 1.0.
		// The threshold is 0.8 to leave room for the 10% a window's starting phase
		// moves the number — the ramp is the claim, the phase is noise.
		const steady = rms(get, 11_000, 11_088);
		expect(steady).toBeGreaterThan(0);
		expect(attack / steady).toBeGreaterThan(0.3);
		expect(attack / steady).toBeLessThan(0.8);
	});

	test("the file cannot end on a sample edge, because the last note is released", () => {
		// The click this file used to prevent with a 0.3 s fade over the end of the
		// buffer is now prevented by the release, and this is the test for it: the
		// last note ends at 35.0 s, is damped by 35.12 s, and the buffer runs to
		// 37.0 s, so the tail has been at the 16-bit floor for over a second before
		// the file ends.
		//
		// This is also what replaced that fade. The driver mutated the fade away
		// and the suite stayed green, which is how you recognise dead code; what
		// guards the click now is this assertion, and a release long enough to ring
		// past the end of the buffer is exactly what a click is, so it fails loudly.
		//
		// 200 ms before the end of the buffer, and inside its last 68 ms. The peak
		// of this buffer is 27852, so 50 is a factor of 550 down — silence, rather
		// than music that happens to be quiet.
		expect(rms(sampleAt, sampleCount - 8820, sampleCount - 4410)).toBeLessThan(50);
		expect(rms(sampleAt, sampleCount - 3000, sampleCount)).toBeLessThan(50);
		// And it lands on zero, so the last sample is not the tail of a note.
		expect(Math.abs(sampleAt(sampleCount - 1))).toBeLessThan(200);
	});

	test("a score of one note renders too", () => {
		const tiny: Score = parseScore(MINIMAL);
		const bytes = renderWav(tiny);

		expect(bytes.length).toBeGreaterThan(44);
		expect(bytes.length).toBeLessThan(wav.length);
	});
});

describe("the instrument", () => {
	/**
	 * The relative level of each of the five partials in one sustained note.
	 *
	 * One note, windowed past the attack and inside its own ring, so the numbers
	 * are about the partials and not about which note was louder than which. Read
	 * the *ratios*, not the absolutes: normalisation scales the whole buffer, and
	 * the higher partials sit below the fundamental anyway.
	 */
	function partialRatios(): number[] {
		const score = parseScore(MINIMAL);
		const get = samplesOf(renderWav(score));
		const fundamental = noteFrequency(score.notes[0]?.midi ?? 60);
		const measured = [1, 2, 3, 4, 5].map((ratio) => goertzel(get, 4410, 8192, fundamental * ratio));
		const first = measured[0] ?? 0;
		return measured.map((value) => value / first);
	}

	test("the higher partials are quieter, and quieter in that order", () => {
		// This is the whole claim about the instrument in one assertion chain: five
		// partials, each below the one below it. A synth that summed five sines at
		// equal amplitude would pass every other test in this file — same length,
		// same pitches, no click, no clipping, a different instrument — which is
		// what makes it worth a probe rather than an assertion on a constant.
		const ratios = partialRatios();

		expect(ratios[0]).toBeCloseTo(1, 1);
		for (let i = 1; i < ratios.length; i++) {
			expect(ratios[i]).toBeLessThan(ratios[i - 1] ?? 0);
		}
		// All five are really there; a list truncated to two would satisfy the
		// ordering just as well.
		expect(ratios[4]).toBeGreaterThan(0);
	});

	test("the second partial sits near the gain the instrument declares", () => {
		// Measured 0.348 against a declared 0.42: the window is 0.1s into a note
		// whose higher partials have the shorter time constant, so they have already
		// decayed a little further by the time the window opens. The band is 0.2 to
		// 0.6 — wide enough for that, narrow enough that a gain table flattened
		// toward equal amplitudes (0.93) cannot sit inside it.
		const ratios = partialRatios();

		expect(ratios[1]).toBeGreaterThan(0.2);
		expect(ratios[1]).toBeLessThan(0.6);
	});

	test("a written rest goes quiet, because the note before it is released", () => {
		// This is the complaint the rests came from, in numbers. The first rest
		// begins at 2.5 s; the level in 50 ms slices either side of it runs
		//
		//     3876  3700  3458 | 2608  1478   799   492   336   237   186   152   100    59
		//     ----- note ------|--------------------- rest -------------------------
		//
		// so the tine is at a seventh of the level it struck at 150 ms into the beat
		// of silence, and under 2% by the end of it. With no release the same probe
		// reads 72% of the level before it for the whole rest — a dip rather than a
		// gap, which is exactly what "why is there no space between them" sounds
		// like.
		//
		// The probe sits 150 ms in rather than at the rest's first sample because
		// the opening hundred milliseconds of a rest *should* still carry the note
		// before it — that is a struck instrument, not a defect. A whole-rest
		// average would read 28%, which an unreleased render also produces.
		const score = parseScore();
		const get = samplesOf(renderWav(score));
		const secondsPerTick = 1 / (TICKS_PER_QUARTER * (score.bpm / 60));
		const rest = score.rests[0];
		if (!rest) throw new Error("the score has no rests to measure");
		const at = Math.round(rest.startTick * secondsPerTick * 44_100);

		const before = rms(get, at - 2205, at);
		expect(before).toBeGreaterThan(0);
		const quarterIn = rms(get, at + 6615, at + 8820);
		expect(quarterIn / before).toBeLessThan(0.3);
		// And it keeps falling to the end of the beat rather than bouncing back, so
		// this is the quietest part of the rest and not a trough between two tails.
		expect(rms(get, at + 17_640, at + 19_845)).toBeLessThan(quarterIn);
	});
});

describe("playback", () => {
	test("names a player that exists on each platform", () => {
		// Windows is the odd one: no `afplay`, and the media player is reached
		// through PowerShell rather than run directly.
		expect(playerCandidates("win32")[0]?.command).toBe("powershell.exe");
		expect(playerCandidates("darwin")[0]?.command).toBe("afplay");
		// Two names, because a container has one of them and never both.
		expect(playerCandidates("linux").map((player) => player.command)).toEqual(["aplay", "paplay"]);
	});

	test("the Windows player blocks, because an async play dies with its process", () => {
		const args = playerCandidates("win32")[0]?.args("C:\\tune.wav") ?? [];

		// PlaySync is load-bearing: `Play()` returns immediately and PowerShell
		// exits, which is a jingle that starts and then stops.
		expect(args.join(" ")).toContain("PlaySync");
		expect(args.join(" ")).toContain("C:\\tune.wav");
	});

	test("and asks for no execution-policy override", () => {
		// Every `/HAL` on every Windows machine would otherwise ship a switch whose
		// only job is to switch off a policy the operator set, on a command that
		// takes no input at all. The override is also worse than useless here: a
		// machine that refuses it makes the child exit non-zero into a stdio nobody
		// reads, which is silence under a success message.
		const args = playerCandidates("win32")[0]?.args("C:\\tune.wav") ?? [];

		expect(args).not.toContain("-ExecutionPolicy");
		expect(args).not.toContain("Bypass");
		expect(args.join(" ")).not.toMatch(/executionpolicy/i);
	});

	test("the player is not detached, because a detached one plays nothing", () => {
		// The bug this pins is the one that shipped: `detached: true` is the house
		// style for background work in this repo and it is right for a tool that
		// writes to a file. Fed to a PowerShell it becomes `DETACHED_PROCESS`, and
		// `SoundPlayer.PlaySync()` then returns in about half a second instead of
		// waiting — on a 3-second WAV, 510 ms against 4832 ms, **exit code 0**. A
		// thirty-second jingle therefore reports success over silence, and nothing
		// that inspects a return value, a buffer or an exit code can tell.
		//
		// Measured on this machine, which is the only reason the assertion is `false`
		// rather than "not true": a future platform where detaching is harmless
		// should be able to say so here, in one line, with the measurement to
		// back it up.
		expect(playerSpawnOptions().detached).toBe(false);
	});

	test("and the player is still started without holding the event loop open", () => {
		// The reason not to detach is *not* that the REPL should block for thirty
		// seconds. `unref()` at the call site is what lets the process exit without
		// waiting, and it is the part with no coverage anywhere else — so this
		// asserts the option that keeps the child's output away from the terminal
		// without pinning anything about the OS.
		const options = playerSpawnOptions();

		expect(options.stdio).toBe("ignore");
	});

	test("a quote in the path cannot end the PowerShell command early", () => {
		// The path is interpolated into a single-quoted PowerShell string. A temp
		// directory name ending in a quote is the case that would otherwise
		// execute whatever came after it.
		const args = playerCandidates("win32")[0]?.args("C:\\it's here\\tune.wav") ?? [];

		expect(args.join(" ")).toContain("it''s here");
	});
});

describe("the command", () => {
	test("/HAL reaches the tune", () => {
		// Case is the whole discoverability question here: a user types HAL, and
		// the registry is lowercased, so the command has to be stored that way.
		expect(findCommand(builtInCommands(), "/HAL")?.name).toBe("hal");
		expect(findCommand(builtInCommands(), "/hal")?.name).toBe("hal");
	});

	test("and describes itself in the only words that fit", () => {
		const command = findCommand(builtInCommands(), "/HAL");

		// `/help` prints this, so it is the first thing anybody reads about the
		// command. It also has to be a sentence, because the table is one.
		expect(command?.description).toBe("I'm sorry, Dave. I'm afraid I can't do that.");
	});
});
