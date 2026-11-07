/**
 * The row cap clips; it does not squeeze.
 *
 * A frame taller than the terminal is capped at `rows - 1` so ink stays on its
 * incremental path (see the comment above `frameCap` in `REPL.tsx`). What the
 * cap must never do is compress the rows it keeps: Yoga's default flexShrink is
 * 1, and a squeezed text node draws *all* of its lines from a reduced offset, so
 * the banner's rows, a dialog's rows and the prompt box land on top of each
 * other. The screenshots that prompted this test read `Deny ruless:`, dropped
 * `Type exactly: I only live once`, showed `/model`'s tail after `mention a
 * file`, and pressed the prompt's border, input and hint into one row.
 *
 * ink-testing-library renders without a TTY (and its stream has no height), and
 * the REPL only caps a TTY, so these mount on a fake one. `debug: true` writes
 * each frame as the renderer produced it — no erase sequences — and
 * `interactive: true` keeps the keyboard live under a CI runner, where ink would
 * otherwise ignore it.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink";
import { REPL } from "../src/components/REPL.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME, ThemeContext } from "../src/theme.ts";
import { initialUiState, type PhraseConfirmState, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeStdout extends EventEmitter {
	isTTY = true;
	columns: number;
	rows: number;
	frames: string[] = [];
	constructor(columns: number, rows: number) {
		super();
		this.columns = columns;
		this.rows = rows;
	}
	write = (frame: string) => {
		this.frames.push(frame);
		return true;
	};
	lastFrame = () => this.frames.at(-1);
}

class FakeStdin extends EventEmitter {
	isTTY = true;
	private buffer: string | null = null;
	setEncoding() {}
	setRawMode() {}
	resume() {}
	pause() {}
	ref() {}
	unref() {}
	read() {
		const data = this.buffer;
		this.buffer = null;
		return data;
	}
	write = (data: string) => {
		this.buffer = data;
		this.emit("readable");
	};
}

interface MountOptions {
	columns?: number;
	rows?: number;
	state?: Partial<UiState>;
	suggestions?: Array<[string, string]>;
}

function mount({ columns = 100, rows = 24, state = {}, suggestions }: MountOptions) {
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), ...state });
	const stdout = new FakeStdout(columns, rows);
	const stdin = new FakeStdin();
	const view = render(
		<ThemeContext.Provider value={DARK_THEME}>
			<REPL
				getSession={() => session}
				store={store}
				modelName="test"
				onExit={() => {}}
				version="9.9.9"
				commandSuggestions={suggestions}
			/>
		</ThemeContext.Provider>,
		{
			stdout: stdout as unknown as NodeJS.WriteStream,
			stdin: stdin as unknown as NodeJS.ReadStream,
			stderr: new FakeStdout(columns, rows) as unknown as NodeJS.WriteStream,
			debug: true,
			exitOnCtrlC: false,
			patchConsole: false,
			interactive: true,
		},
	);
	return { store, stdout, stdin, view, finish: () => view.unmount() };
}

/** The frame's lines, as the terminal would receive them. */
function frameLines(stdout: FakeStdout): string[] {
	return (stdout.lastFrame() ?? "").split("\n");
}

/** What is left on a row after `needle`, spaces aside. */
function restOfLine(line: string, needle: string): string {
	return line.slice(line.indexOf(needle) + needle.length).replace(/ /g, "");
}

/** The dialog `/yolo` opens, word for word. */
const YOLO: PhraseConfirmState = {
	title: "YOLO mode — You Only Live Once",
	phrase: "I only live once",
	off: ["Dangerous-command classifier", "Ask rules", "Approval prompts for every tool"],
	on: [
		"Deny rules",
		"Hooks",
		"The sandbox and its network policy",
		"Plan mode's read-only gate, and the read-only sandbox's write refusal",
		"Tool validation and MCP server approvals",
	],
	sandbox: "workspace-write",
	note: "Running subagents and band members adopt YOLO from their next permission decision.",
	resolve: () => {},
};

const CATALOG: Array<[string, string]> = [
	["/activity", "Show a heatmap of the days you used this, and the streak: /activity [7d|30d|all]"],
	["/agents", "List agent definitions, and load this project's: /agents [approve]"],
	["/autocompact", "Switch the automatic compaction passes and their trigger line: /autocompact [on|off|<percent>]"],
	["/beetle", "Run a four-agent band that works until stopped: /beetle [<task>|status|off|models|say <member> <text>]"],
	["/cache", "Show prompt-cache hit rate, its ceiling, and any prefix rewinds"],
	["/clear", "Clear the conversation"],
	["/compact", "Summarize the conversation to free context; optional focus instructions"],
];

describe("a frame taller than the terminal", () => {
	test("keeps the phrase confirmation's rows apart and its input visible", async () => {
		const h = mount({ rows: 24, state: { phraseConfirm: YOLO } });
		await delay(40);
		const lines = frameLines(h.stdout);

		// The row that vanished into the border above it when the dialog was
		// squeezed. Without it there is nothing on screen that says what to type.
		const instruction = lines.findIndex((line) => line.includes("Type exactly: I only live once"));
		expect(instruction, "the typed-phrase instruction is on screen").toBeGreaterThanOrEqual(0);

		// Rows keep their own content: nothing follows the last character but the
		// box's own padding and border.
		for (const [needle, ended] of [
			["Type exactly: I only live once", "│"],
			["The phrase is case-sensitive.", "│"],
			["Deny rules", "│"],
		] as const) {
			const line = lines.find((candidate) => candidate.includes(needle));
			expect(line, needle).toBeDefined();
			expect(restOfLine(line ?? "", needle), `nothing is left over after "${needle}"`).toBe(ended);
		}
		expect(lines.some((line) => line.includes("ruless"))).toBe(false);
		expect(lines.some((line) => line.includes("case-sensitive.e"))).toBe(false);

		// The prompt's three rows stay three rows: border, the placeholder (which
		// the squeezed box lost), and the border under it.
		const placeholder = lines.findIndex((line) => line.includes('> Try "fix the failing test" — / for commands'));
		expect(placeholder).toBeGreaterThan(0);
		expect(lines[placeholder - 1].trimStart().startsWith("╭")).toBe(true);
		expect(lines[placeholder + 1].trimStart().startsWith("╰")).toBe(true);
		h.finish();
	});

	test("keeps the suggestion list's rows apart on a 30-row screen", async () => {
		// The first screenshot: the greeting plus eight suggestions do not fit in a
		// 29-row cap. The rows that stay keep their own text — the cap takes the
		// banner's top, never a column out of the middle of a row.
		const h = mount({ rows: 30, suggestions: CATALOG });
		await delay(40);
		h.stdin.write("/");
		await delay(60);
		const lines = frameLines(h.stdout);

		// The squeeze cut the `T` off the tips title and folded `/model` and
		// `@path` into the rows above them. The title is matched at a word
		// boundary rather than as a substring: `Tips for getting started` contains
		// `ips for getting started`, so a plain `includes` would call the whole
		// row an artifact — and the row is a legitimate one when the cap leaves it
		// on screen.
		expect(lines.some((line) => /\bips for getting started/.test(line))).toBe(false);
		expect(lines.some((line) => line.includes("mention a fileel"))).toBe(false);
		expect(lines.some((line) => line.includes("show all keybindingsturn"))).toBe(false);
		// A suggestion row ends with its own last word, not with the tail of the
		// row above it (`/agents [approve]ity [7d|30d|all]`).
		for (const [needle, tail] of [
			["/agents", "[approve]"],
			["/clear", "conversation"],
		] as const) {
			const line = lines.find((candidate) => candidate.trimStart().startsWith(needle));
			expect(line, needle).toBeDefined();
			expect(restOfLine(line ?? "", needle).endsWith(tail), `the ${needle} row keeps its own tail`).toBe(true);
		}
		// And the prompt is still a box with what was typed in it — not one row
		// that is a border, the input and the hint at once.
		const input = lines.findIndex((line) => line.includes("│ > /"));
		expect(input, "the typed `/` is on its own row").toBeGreaterThan(0);
		expect(lines[input - 1].trimStart().startsWith("╭")).toBe(true);
		expect(lines[input + 1].trimStart().startsWith("╰")).toBe(true);
		h.finish();
	});
});
