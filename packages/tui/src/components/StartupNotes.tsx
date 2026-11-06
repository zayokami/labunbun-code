import { Box, Text } from "ink";
import type { UiStartupNote } from "../ui-state.ts";

/**
 * The first screen's one line about what startup had to say.
 *
 * The ambient notices the app learns before the first prompt used to be info
 * rows of their own, printed between the greeting and the prompt: no
 * controller, a skill folder that failed validation, a catalog refresh.
 * Unboxed, unindented and in the same weight as everything else, three of
 * those read as a start that went wrong — not as a report. They were also the
 * rows that pushed the greeting up on the machines with the most to say.
 *
 * Folded, they cost one dim line: which subjects there are, and where the full
 * sentences live. `/doctor` prints them, because a machine-health report is
 * exactly what they are.
 */

/** How many subjects the line names before it starts counting the rest. */
const SUMMARY_LABEL_CAP = 3;

/**
 * The summary for a set of notes.
 *
 * Labels are deduplicated and kept in arrival order: two skill folders that
 * both failed are one subject ("skill not loaded"), not the same phrase twice.
 * Past the cap the rest are counted rather than named — a first screen with
 * eight notices should not have a summary longer than the greeting.
 */
export function startupNotesSummary(notes: Array<Pick<UiStartupNote, "label">>): string {
	const labels: string[] = [];
	for (const note of notes) {
		if (!labels.includes(note.label)) labels.push(note.label);
	}
	const shown = labels.slice(0, SUMMARY_LABEL_CAP);
	const more = labels.length - shown.length;
	if (more > 0) shown.push(`+${more} more`);
	return `ℹ ${shown.join(" · ")} · /doctor for details`;
}

export function StartupNotesLine({ notes }: { notes: UiStartupNote[] }) {
	if (notes.length === 0) return null;
	return (
		<Box marginBottom={1}>
			<Text dimColor>{startupNotesSummary(notes)}</Text>
		</Box>
	);
}
