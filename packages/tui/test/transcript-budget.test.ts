/**
 * The transcript window is chosen by rows, not by entry count.
 *
 * A fixed count of entries used to decide how much history stayed mounted. One
 * 500-line tool result then cost more rows than the whole terminal, so the
 * window could overflow the frame cap and Ink clipped the live pane. The
 * budget counts estimated rows from the end of the transcript, so what is kept
 * is what the screen can actually show.
 */
import { describe, expect, test } from "bun:test";
import { transcriptEntryRows, transcriptWindowEntries } from "../src/components/REPL.tsx";
import type { UiEntry } from "../src/ui-state.ts";

const COLUMNS = 80;

function assistant(text: string): UiEntry {
	return { kind: "assistant", text };
}

function tool(resultText: string): UiEntry {
	return { kind: "toolUse", callId: "call-1", toolName: "bash", inputPreview: "echo hi", resultText };
}

function totalRows(entries: UiEntry[]): number {
	return entries.reduce((rows, entry) => rows + transcriptEntryRows(entry, COLUMNS), 0);
}

describe("transcriptEntryRows", () => {
	test("counts wrapped rows, not source lines", () => {
		const oneRow = transcriptEntryRows(assistant("short"), COLUMNS);
		const manyRows = transcriptEntryRows(assistant("x".repeat(COLUMNS * 3)), COLUMNS);
		expect(oneRow).toBe(2); // the text plus its blank line
		expect(manyRows).toBeGreaterThan(oneRow);
	});

	test("a tool call is charged its result rows", () => {
		const small = transcriptEntryRows(tool("ok"), COLUMNS);
		const large = transcriptEntryRows(tool("x".repeat(COLUMNS * 40)), COLUMNS);
		expect(large).toBeGreaterThan(small * 10);
	});
});

describe("transcriptWindowEntries", () => {
	test("keeps the newest entries that fit the row budget", () => {
		const entries = Array.from({ length: 40 }, (_, i) => assistant(`answer ${i}`));
		const picked = transcriptWindowEntries(entries, entries.length, entries.length, 10, COLUMNS);
		expect(picked.length).toBeLessThan(entries.length);
		expect(totalRows(picked)).toBeLessThanOrEqual(10);
		expect(picked.at(-1)).toBe(entries.at(-1));
	});

	test("a result taller than the budget does not drag its neighbours in", () => {
		const entries = [assistant("earlier answer"), tool("x".repeat(COLUMNS * 200))];
		const picked = transcriptWindowEntries(entries, entries.length, entries.length, 20, COLUMNS);
		// The newest entry is always shown, even over budget; nothing before it
		// can be charged against a budget it already exceeded.
		expect(picked).toEqual([entries[1]]);
	});

	test("without a budget it is the old entry-count slice", () => {
		const entries = Array.from({ length: 25 }, (_, i) => assistant(`answer ${i}`));
		const picked = transcriptWindowEntries(entries, 20, 5, undefined, COLUMNS);
		expect(picked).toEqual(entries.slice(15, 20));
	});

	test("the window never reaches behind the entry floor", () => {
		const entries = Array.from({ length: 25 }, (_, i) => assistant(`answer ${i}`));
		const picked = transcriptWindowEntries(entries, 20, 5, 1000, COLUMNS);
		expect(picked.length).toBeLessThanOrEqual(5);
		expect(picked.at(0)).toBe(entries[15]);
	});
});
