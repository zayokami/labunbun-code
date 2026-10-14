/**
 * The `/autocompact` switch, as logic a test can hold: what a line asked for,
 * what to write, and what to say back.
 *
 * The setting itself is `settings.compaction.enabled`, and it is deliberately
 * one-sided: off silences the two passes the app starts by itself — the
 * automatic summary when the context crosses the trigger line, and the cheap
 * trim that runs ahead of one — while the passes a person starts (`/compact`,
 * `/trim`) and the recovery pass after a provider refuses an over-long request
 * stay. A conversation already too big to send still has to get smaller
 * somehow; that is not a habit to switch off.
 *
 * No terminal, no session, no console: the REPL parses a line with
 * {@link parseAutocompactCommand}, writes it through
 * {@link applyAutocompactAction}, and prints what {@link autocompactReport}
 * gives back — so the merge rule and the wording are testable without either.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripBom } from "./json-text.ts";
import { writeUserSettingsNestedPatch } from "./user-settings.ts";

/**
 * The two keys the command owns, as a settings file or a session carries them.
 *
 * A type rather than an interface so it stays assignable to the
 * `Record<string, unknown>` the settings writers take — same shape, one less
 * conversion at every seam.
 */
export type AutocompactState = {
	/** False once the user turned the automatic passes off; undefined means on. */
	enabled?: boolean;
	/** The trigger line, as a percent of the window; undefined uses the reserve formula. */
	thresholdPercent?: number;
};

/** What one line of `/autocompact` asked for. */
export type AutocompactCommand =
	/** No argument: report the setting as it stands. */
	| { kind: "report" }
	/**
	 * `on`, `off` or a percent — the one kind with something to write. `on` and
	 * `off` carry no `thresholdPercent` on purpose: the toggle must not forget a
	 * line the user configured, so turning it back on restores that line.
	 */
	| { kind: "set"; enabled: boolean; thresholdPercent?: number }
	/** An argument that is none of the above. */
	| { kind: "usage" };

/** The one variant with something to write. */
export type AutocompactSetCommand = Extract<AutocompactCommand, { kind: "set" }>;

/**
 * Read the argument as the whole rest of the line, trimmed and case-folded the
 * way every command handler folds its own argument.
 *
 * The whole rest is load-bearing: `on off` is usage, not `on`. So is every
 * near-miss — `0` and `100` because the schema refuses them too (0% would
 * compact before the first request, 100% sits past the point where requests
 * are refused), and `50%` because it is a shell habit the command does not
 * have; the usage line names the one spelling it accepts. Digits only: a
 * signed, fractional or exponential spelling is a percent the user should
 * retype, not one this parser should guess at.
 */
export function parseAutocompactCommand(args: string): AutocompactCommand {
	const arg = args.trim().toLowerCase();
	if (arg === "") return { kind: "report" };
	if (arg === "on") return { kind: "set", enabled: true };
	if (arg === "off") return { kind: "set", enabled: false };
	if (!/^\d+$/.test(arg)) return { kind: "usage" };
	const percent = Number(arg);
	if (percent < 1 || percent > 99) return { kind: "usage" };
	return { kind: "set", enabled: true, thresholdPercent: percent };
}

/** One line naming the three forms the argument takes. */
export function autocompactUsageLine(): string {
	return (
		"Usage: /autocompact on | off | <percent 1-99> — on and off switch the automatic passes; " +
		"a percent also sets the trigger line"
	);
}

/**
 * One line for the setting, with no follow-up lecture.
 *
 * The off line names both halves of the consequence because "off" alone reads
 * as "the session will stop managing its context", which is not what this
 * switch does — the passes a person starts and the pass an over-long request
 * forces still run, and the line says so. The two on lines differ by where the
 * trigger line comes from, because that is the only thing the two states do
 * differently.
 */
export function autocompactReport(state: AutocompactState): string {
	if (state.enabled === false) {
		return (
			"Auto-compaction is off: the automatic summary and the cheap trim no longer run on their own; " +
			"/compact and the provider-refusal recovery still do."
		);
	}
	if (state.thresholdPercent === undefined) {
		return "Auto-compaction is on: the trigger line comes from the window's reserve formula.";
	}
	return `Auto-compaction is on at ${state.thresholdPercent}% of the window.`;
}

/**
 * Where {@link applyAutocompactAction} reads and writes.
 *
 * Two functions rather than a home directory because the read side is what
 * lets an `on` that changes nothing write nothing — the file keeps no key
 * whose value was already in effect — and a caller whose settings live
 * somewhere else gets the same merge rule through the same pair.
 */
export interface AutocompactIo {
	/** The two owned keys of the `compaction` block, as the user's settings file states them. */
	read(): AutocompactState;
	/**
	 * Merge the patch into the `compaction` block of the user's settings file,
	 * through the same nested writer `/gamepad` persists through: keys the patch
	 * does not name survive, both in the block and in the file around it.
	 */
	save(patch: AutocompactState): void;
}

/**
 * Apply a parsed command and return the setting as it now stands.
 *
 * The return is the patch merged over what was read — the same shape
 * {@link autocompactReport} takes — so the caller prints the new state without
 * a second read. The patch itself carries only keys whose value actually
 * changes: `on` against a file that never said `enabled` (or said `true`)
 * writes nothing at all, because a key whose value is already in effect is the
 * absence of news, and the file already says what it would say.
 */
export function applyAutocompactAction(action: AutocompactSetCommand, io: AutocompactIo): AutocompactState {
	const current = io.read();
	const patch: AutocompactState = {};
	// `undefined` and `true` are one state — on — so only an explicit `false`
	// reads as off, and only a difference from that state is worth writing.
	if (action.enabled !== (current.enabled !== false)) patch.enabled = action.enabled;
	if (action.thresholdPercent !== undefined && action.thresholdPercent !== current.thresholdPercent) {
		patch.thresholdPercent = action.thresholdPercent;
	}
	if (patch.enabled === undefined && patch.thresholdPercent === undefined) return current;
	io.save(patch);
	return { ...current, ...patch };
}

/**
 * The io a session uses: the user's own settings file, read and written the
 * way every settings command touches it.
 *
 * The read is local rather than shared because `user-settings.ts` keeps its
 * reader private — and it must agree with the writer's reader exactly, or
 * `on` could decide there is nothing to write while the file actually says
 * `false`. So it follows the same rules: a missing file reads as empty, a
 * BOM is tolerated, and a file nobody can parse throws the writer's own
 * sentence rather than reading as empty, because the merge about to happen
 * would otherwise discard what it could not read.
 */
export function userSettingsAutocompactIo(home: string = homedir()): AutocompactIo {
	const path = join(home, ".labunbun", "settings.json");
	return {
		read: () => readCompactionBlock(path),
		save: (patch) => writeUserSettingsNestedPatch("compaction", patch, home),
	};
}

/** The two owned keys of one file's `compaction` block, under the writer's rules. */
function readCompactionBlock(path: string): AutocompactState {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch {
		throw new Error(`${path} is not valid JSON; fix it before changing settings`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const block = (parsed as Record<string, unknown>).compaction;
	if (typeof block !== "object" || block === null || Array.isArray(block)) return {};
	const { enabled, thresholdPercent } = block as Record<string, unknown>;
	const state: AutocompactState = {};
	// Only the two keys, and only in the shapes the schema would accept: a
	// hand-edited `"enabled": "yes"` is not a value this command compares
	// against, and letting it through would have `on` skip a write the file
	// needs.
	if (typeof enabled === "boolean") state.enabled = enabled;
	if (typeof thresholdPercent === "number") state.thresholdPercent = thresholdPercent;
	return state;
}
