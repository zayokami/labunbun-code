/**
 * What the terminal's scrollback is allowed to receive.
 *
 * Sealed transcript rows belong in the scrollback once. Ink's `<Static>` is
 * what puts them there, and it knows how many it has already printed — but
 * only while it stays mounted, and only while the frame it belongs to stays
 * below the viewport. Either condition broken prints the whole sealed
 * history again: a remount starts its index at zero, and a fullscreen frame
 * makes ink clear the screen and replay every static byte it has collected.
 * On a ConPTY host that replay is not followed by a scrollback erase (see
 * `conpty.ts`), so each copy lands above the last one and scrolling up shows
 * the same conversation over and over.
 *
 * These rows drive the real REPL on a console-shaped stdout, in the same
 * write discipline production installs.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink";
import { connectSessionToStore, REPL } from "../src/components/REPL.tsx";
import { chunkWritesForConPTY } from "../src/conpty.ts";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiEntry, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stdout shaped like the Windows console family: TTY with a real height. */
class ConsoleStdout extends EventEmitter {
	isTTY = true;
	columns = 80;
	rows: number;
	frames: string[] = [];
	constructor(rows: number) {
		super();
		this.rows = rows;
		// The same transform `main.ts` installs before the REPL mounts.
		chunkWritesForConPTY(this);
	}
	write = (data: string | Uint8Array) => {
		this.frames.push(String(data));
		return true;
	};
}

/** The smallest stdin ink's raw-mode input path needs. */
class ConsoleStdin extends EventEmitter {
	isTTY = true;
	private data: string | null = null;
	setEncoding() {}
	setRawMode() {}
	resume() {}
	pause() {}
	ref() {}
	unref() {}
	read = () => {
		const data = this.data;
		this.data = null;
		return data;
	};
	/** Feed one key, the way ink-testing-library does. */
	send = (data: string) => {
		this.data = data;
		this.emit("readable");
		this.emit("data", data);
	};
}

function setup(entries: UiEntry[], rows = 24) {
	const stdout = new ConsoleStdout(rows);
	const stderr = new ConsoleStdout(rows);
	const stdin = new ConsoleStdin();
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
	const store = createStore<UiState>({ ...initialUiState(), entries });
	const unsubscribe = connectSessionToStore(session, store);
	const instance = render(<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} />, {
		stdout: stdout as never,
		stderr: stderr as never,
		stdin: stdin as never,
		interactive: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	return {
		stdout,
		stdin,
		store,
		write: () => stdout.frames.join(""),
		finish: () => {
			unsubscribe();
			instance.unmount();
			instance.cleanup();
		},
	};
}

/** How many times `needle` appears in everything written to the console. */
const copies = (text: string, needle: string): number => text.split(needle).length - 1;

const settled = (count: number, prefix = "tail"): UiEntry[] =>
	Array.from({ length: count }, (_, i) => ({ kind: "assistant", text: `${prefix} ${i}` }) as UiEntry);

describe("the scrollback gets each sealed row once", () => {
	test("a live frame taller than the console does not replay the sealed rows", async () => {
		const sealed = Array.from({ length: 4 }, (_, i) => ({ kind: "assistant", text: `SEALED-${i}` }) as UiEntry);
		const tall = Array.from({ length: 80 }, (_, i) => `LIVE-LINE-${i}`).join("\n");
		const entries: UiEntry[] = [...sealed, ...settled(7), { kind: "assistant", text: tall }];
		const h = setup(entries);
		await delay(60);
		const printedAtStart = copies(h.write(), "SEALED-0");
		expect(printedAtStart).toBe(1);

		// Each store write is a frame. The tall answer keeps the frame over the
		// viewport, which is what used to make ink clear and replay.
		for (let i = 0; i < 5; i++) {
			h.store.set((s) => ({ ...s, streamingText: `tick ${i}` }));
			await delay(40);
		}

		expect(copies(h.write(), "SEALED-0")).toBe(1);
		h.finish();
	}, 20_000);

	test("a look at the transcript and back does not replay the sealed rows", async () => {
		// Forty rows put the first four behind the transcript's twenty-five-row
		// window, so the marker cannot arrive in a frame: only a Static reprint
		// can put it in the write stream after the first print.
		const entries = [...settled(4, "SEALED"), ...settled(36)];
		const h = setup(entries);
		await delay(60);
		expect(copies(h.write(), "SEALED 0")).toBe(1);

		h.stdin.send("\x0f"); // ctrl+o
		await delay(60);
		h.stdin.send("\x0f");
		await delay(60);

		expect(copies(h.write(), "SEALED 0")).toBe(1);
		h.finish();
	}, 20_000);

	test("a dialog kept under the transcript cannot answer keys aimed at it", async () => {
		// Keeping the live tree mounted is what preserves the Static index, but
		// the dialogs read keys through their own `useInput`. A permission dialog
		// mounted behind the transcript would still answer `y`, approving a tool
		// call the reader cannot see — so it is unmounted with the live screen,
		// even though the Static above it stays.
		const h = setup(settled(4));
		await delay(60);
		const answers: boolean[] = [];
		h.store.set((s) => ({
			...s,
			dialog: {
				callId: "perm-1",
				toolName: "Bash",
				inputPreview: "Allow Bash?",
				resolve: (allow) => {
					answers.push(allow);
				},
			},
		}));
		await delay(40);

		h.stdin.send("\x0f"); // ctrl+o
		await delay(40);
		h.stdin.send("y");
		await delay(40);
		expect(answers).toEqual([]);

		h.stdin.send("\x0f");
		await delay(40);
		h.stdin.send("y");
		await delay(40);
		expect(answers).toEqual([true]);
		h.finish();
	}, 20_000);
});
