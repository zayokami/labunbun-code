/**
 * `/autocompact`, the user-facing half of the off switch.
 *
 * Three rules carry the whole command, and each is one this file exists to keep
 * honest. The grammar: `on` and `off` are pure toggles that never carry a
 * percent of their own, so turning the switch back on restores a configured
 * trigger line; a percent is an integer 1–99 and nothing else is — not 0, not
 * 100, not `50%`. The merge: the two keys this command owns are patched into
 * the user's settings file through the same nested writer `/gamepad` uses, so
 * every key it does not name survives at both levels, and an `on` over a file
 * that is already on writes nothing at all. The scope: off silences only the
 * passes the app starts by itself, so the report line has to say what still
 * runs.
 *
 * The merge tests run against a throwaway home and the real writer; the
 * patch-shape tests inject an io, because which keys a patch names is a claim
 * about the call, and two different patches would leave equally valid files.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AutocompactIo,
	type AutocompactState,
	applyAutocompactAction,
	autocompactReport,
	autocompactUsageLine,
	parseAutocompactCommand,
	userSettingsAutocompactIo,
} from "../src/autocompact.ts";

function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "lbb-autocompact-"));
}

function settingsPath(home: string): string {
	return join(home, ".labunbun", "settings.json");
}

/** Put a settings file (or a string pretending to be one) in place. */
function seed(home: string, contents: unknown): void {
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(settingsPath(home), typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

function saved(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(settingsPath(home), "utf8"));
}

describe("parseAutocompactCommand", () => {
	test("no argument asks for the report, and so does only whitespace", () => {
		expect(parseAutocompactCommand("")).toEqual({ kind: "report" });
		expect(parseAutocompactCommand("   ")).toEqual({ kind: "report" });
	});

	test("on and off are the toggle, and carry no percent of their own", () => {
		// Equal to an object without the key on purpose: if the toggle filled in
		// a percent, turning the switch back on would silently rewrite a trigger
		// line the user configured.
		expect(parseAutocompactCommand("on")).toEqual({ kind: "set", enabled: true });
		expect(parseAutocompactCommand("off")).toEqual({ kind: "set", enabled: false });
		// Folded and trimmed like every other command handler's argument.
		expect(parseAutocompactCommand("ON")).toEqual({ kind: "set", enabled: true });
		expect(parseAutocompactCommand(" Off ")).toEqual({ kind: "set", enabled: false });
	});

	test("a percent from 1 to 99 turns it on and sets the trigger line", () => {
		expect(parseAutocompactCommand("1")).toEqual({ kind: "set", enabled: true, thresholdPercent: 1 });
		expect(parseAutocompactCommand("50")).toEqual({ kind: "set", enabled: true, thresholdPercent: 50 });
		expect(parseAutocompactCommand("99")).toEqual({ kind: "set", enabled: true, thresholdPercent: 99 });
		// Leading zeros are still the integer they spell.
		expect(parseAutocompactCommand("05")).toEqual({ kind: "set", enabled: true, thresholdPercent: 5 });
	});

	test("the ends, near-misses and extra words are usage", () => {
		// The ends are refused here for the same reason the schema refuses them:
		// 0% would compact before the first request and 100% sits past the point
		// where requests are refused. `50%` and the rest are spellings the usage
		// line does not name, which makes them typos to retype rather than values
		// to guess at.
		for (const junk of ["0", "100", "-5", "+5", "1.5", "50%", "1e2", "on off", "85 90", "true", "maybe", "onx"]) {
			expect(parseAutocompactCommand(junk)).toEqual({ kind: "usage" });
		}
	});
});

describe("autocompactUsageLine", () => {
	test("names the three forms on one line", () => {
		const line = autocompactUsageLine();
		expect(line).toBe(
			"Usage: /autocompact on | off | <percent 1-99> — on and off switch the automatic passes; " +
				"a percent also sets the trigger line",
		);
		expect(line.split("\n")).toHaveLength(1);
	});
});

describe("autocompactReport", () => {
	test("absent and true are one state, with the default trigger formula named", () => {
		const line = "Auto-compaction is on: the trigger line comes from the window's reserve formula.";
		expect(autocompactReport({})).toBe(line);
		expect(autocompactReport({ enabled: true })).toBe(line);
	});

	test("a configured line is named as a percent of the window", () => {
		expect(autocompactReport({ thresholdPercent: 85 })).toBe("Auto-compaction is on at 85% of the window.");
		expect(autocompactReport({ enabled: true, thresholdPercent: 70 })).toBe(
			"Auto-compaction is on at 70% of the window.",
		);
	});

	test("off names what still runs, because the switch does not stop everything", () => {
		// The consequence is part of the line rather than a second paragraph: a
		// bare "off" reads as "context management is off", and the passes a
		// person starts — plus the one an over-long request forces — still run.
		const line = autocompactReport({ enabled: false });
		expect(line).toBe(
			"Auto-compaction is off: the automatic summary and the cheap trim no longer run on their own; " +
				"/compact and the provider-refusal recovery still do.",
		);
		expect(line.split("\n")).toHaveLength(1);
		// A remembered line does not leak into the off report: it is restored by
		// `on`, not reported while the automatic passes are off.
		expect(autocompactReport({ enabled: false, thresholdPercent: 85 })).toBe(line);
	});
});

describe("applyAutocompactAction", () => {
	/** An io over a fixed state, recording every patch it is asked to save. */
	function spy(read: AutocompactState): { io: AutocompactIo; calls: AutocompactState[] } {
		const calls: AutocompactState[] = [];
		return { io: { read: () => read, save: (patch) => calls.push(patch) }, calls };
	}

	test("the patch names only the keys whose value changes", () => {
		// `on` against a file that is already on (the key absent) writes nothing:
		// the absence already says "on", and there is no news to add.
		const alreadyOn = spy({});
		expect(applyAutocompactAction({ kind: "set", enabled: true }, alreadyOn.io)).toEqual({});
		expect(alreadyOn.calls).toEqual([]);

		// A percent action whose value is already in effect is the same no-op.
		const samePercent = spy({ enabled: true, thresholdPercent: 85 });
		expect(applyAutocompactAction({ kind: "set", enabled: true, thresholdPercent: 85 }, samePercent.io)).toEqual({
			enabled: true,
			thresholdPercent: 85,
		});
		expect(samePercent.calls).toEqual([]);

		// `on` after `off` writes the enable and leaves the remembered line alone
		// — this is "turning it back on restores the configured line" at the
		// patch level.
		const restoring = spy({ enabled: false, thresholdPercent: 70 });
		expect(applyAutocompactAction({ kind: "set", enabled: true }, restoring.io)).toEqual({
			enabled: true,
			thresholdPercent: 70,
		});
		expect(restoring.calls).toEqual([{ enabled: true }]);

		// A percent with no enabled key on file: the percent is the only news,
		// and the write carries only it.
		const percentOnly = spy({ thresholdPercent: 70 });
		expect(applyAutocompactAction({ kind: "set", enabled: true, thresholdPercent: 90 }, percentOnly.io)).toEqual({
			thresholdPercent: 90,
		});
		expect(percentOnly.calls).toEqual([{ thresholdPercent: 90 }]);

		// `off` writes the enable even when the file said nothing — the one
		// direction the default cannot express.
		const turningOff = spy({});
		expect(applyAutocompactAction({ kind: "set", enabled: false }, turningOff.io)).toEqual({ enabled: false });
		expect(turningOff.calls).toEqual([{ enabled: false }]);
	});

	test("off writes only the switch, over the real read-merge-write path", () => {
		const home = tempHome();
		seed(home, {
			theme: "nord",
			vimMode: true,
			compaction: { model: "some/cheap-model", reserveTokens: 30_000, thresholdPercent: 70 },
		});

		applyAutocompactAction({ kind: "set", enabled: false }, userSettingsAutocompactIo(home));

		// The whole file and the whole block survive, the configured line
		// included: `/autocompact off` is a switch, not a reset.
		expect(saved(home)).toEqual({
			theme: "nord",
			vimMode: true,
			compaction: { model: "some/cheap-model", reserveTokens: 30_000, thresholdPercent: 70, enabled: false },
		});
	});

	test("a percent sets the switch and the line, and every other key survives", () => {
		const home = tempHome();
		seed(home, { theme: "nord", compaction: { enabled: false, model: "some/cheap-model" } });

		const next = applyAutocompactAction(
			{ kind: "set", enabled: true, thresholdPercent: 85 },
			userSettingsAutocompactIo(home),
		);

		expect(saved(home)).toEqual({
			theme: "nord",
			compaction: { enabled: true, model: "some/cheap-model", thresholdPercent: 85 },
		});
		// The returned state is what the caller prints.
		expect(autocompactReport(next)).toBe("Auto-compaction is on at 85% of the window.");
	});

	test("off then on restores the configured line", () => {
		const home = tempHome();
		seed(home, { compaction: { thresholdPercent: 70 } });
		const io = userSettingsAutocompactIo(home);

		applyAutocompactAction({ kind: "set", enabled: false }, io);
		const back = applyAutocompactAction({ kind: "set", enabled: true }, io);

		expect(autocompactReport(back)).toBe("Auto-compaction is on at 70% of the window.");
		expect(saved(home).compaction).toEqual({ thresholdPercent: 70, enabled: true });
	});

	test("on against a file that never said enabled writes nothing and creates nothing", () => {
		const home = tempHome();
		seed(home, { compaction: { model: "some/cheap-model" } });
		const before = readFileSync(settingsPath(home), "utf8");

		applyAutocompactAction({ kind: "set", enabled: true }, userSettingsAutocompactIo(home));

		// Byte-identical: the key that means "on" did not appear, because it did
		// not have to — writing `enabled: true` would only restate the default.
		expect(readFileSync(settingsPath(home), "utf8")).toBe(before);
		expect("enabled" in (saved(home).compaction as object)).toBe(false);

		// And a home with no settings file at all is not given one for an `on`
		// that changes nothing.
		const empty = tempHome();
		applyAutocompactAction({ kind: "set", enabled: true }, userSettingsAutocompactIo(empty));
		expect(existsSync(settingsPath(empty))).toBe(false);
	});

	test("a settings file nobody can parse is refused, not overwritten", () => {
		// The merge would discard a file the reader could not make sense of, so
		// the write is refused with the writer's own sentence — the user's
		// recovery is to fix the JSON, and the bytes have to still be there to
		// fix.
		const home = tempHome();
		const broken = '{ "theme": "nord", }';
		seed(home, broken);

		expect(() => applyAutocompactAction({ kind: "set", enabled: false }, userSettingsAutocompactIo(home))).toThrow(
			/not valid JSON/,
		);
		expect(readFileSync(settingsPath(home), "utf8")).toBe(broken);
	});
});
