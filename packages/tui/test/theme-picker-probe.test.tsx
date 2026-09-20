/**
 * `/theme` opens the picker and, for the `auto` row, probes the terminal — on the
 * same stdin Ink is reading, while the picker is up.
 *
 * That is what the user hit: the terminal answers the probe a beat late, and the
 * answer reaches Ink as input. Ink's parser strips the escape byte and hands the
 * rest to the key handlers, so the reply is typed into the prompt as
 * `]11;rgb:0c0c/0c0c/0c0c\` and `[?61;4;6;7;…c`, and an escape that arrives on
 * its own dismisses the picker out from under the arrows. This mounts a reader
 * and the picker together and runs the probe on their stream, the way the app
 * runs it on `process.stdin`.
 */
import { describe, expect, test } from "bun:test";
import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import type React from "react";
import { ListPickerDialog } from "../src/components/ListPickerDialog.tsx";
import { detectAppearance } from "../src/detect-appearance.ts";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";

const ESC = String.fromCharCode(0x1b);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ITEMS = [{ label: "dark" }, { label: "light" }, { label: "auto" }];

/** Records writes and never blocks, standing in for a TTY stdout. */
const quietStdout = () => ({ isTTY: true, write: () => true }) as unknown as NodeJS.WriteStream;

function mount() {
	const typed: string[] = [];
	const highlights: number[] = [];

	function Recorder() {
		useInput((input) => {
			typed.push(input);
		});
		return <Text> </Text>;
	}

	const { stdin, lastFrame, unmount } = render(
		(
			<ThemeContext.Provider value={DARK_THEME}>
				<Recorder />
				<ListPickerDialog
					title="Theme"
					items={ITEMS}
					resolve={() => {}}
					onHighlight={(index) => highlights.push(index)}
				/>
			</ThemeContext.Provider>
		) as React.ReactElement,
	);
	return { stdin, typed, highlights, frame: () => lastFrame() ?? "", unmount };
}

describe("a theme probe running under the open picker", () => {
	test("the terminal's answers become neither input nor a dismissed picker", async () => {
		const app = mount();
		await delay(30);

		// The app hands the probe the stream Ink reads; the library's fake is
		// minimal, so it is given the two guards a TTY stream would already have.
		const probeStdin = app.stdin as unknown as NodeJS.ReadStream & { isPaused: () => boolean };
		probeStdin.isPaused = () => true;
		const answered = detectAppearance({ stdin: probeStdin, stdout: quietStdout(), env: {}, timeoutMs: 500 });
		await delay(10);

		// The tripwire's answer is cheap and lands first; the colour follows it.
		app.stdin.write(`${ESC}[?61;4;6;7;14;21;22;23;24;28;32;42;52c`);
		await delay(20);
		app.stdin.write(`${ESC}]11;rgb:0c0c/0c0c/0c0c${ESC}\\`);

		expect(await answered).toBe("dark");
		await delay(30);
		expect(app.typed).toEqual([]);

		app.stdin.write(`${ESC}[B`);
		await delay(30);
		expect(app.highlights).toEqual([1]);
		expect(app.frame()).toContain("auto");
		app.unmount();
	});
});
