/**
 * Terminal text editor state: multiline buffer, cursor motion, word jumps,
 * kill/yank, and history recall. Pure state transitions; the component maps
 * ink useInput keys onto these actions. Optional vim layer: normal/insert
 * modal editing over the same buffer.
 */

import type { Key } from "ink";
import { useCallback, useRef, useState } from "react";

export interface TextInputState {
	text: string;
	cursor: number;
}

export interface TextInputActions {
	insert(text: string): void;
	newline(): void;
	backspace(): void;
	delete(): void;
	moveLeft(): void;
	moveRight(): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	moveWordLeft(): void;
	moveWordRight(): void;
	killToEnd(): void;
	killToStart(): void;
	yank(): void;
	clear(): void;
	setText(text: string): void;
}

export function useTextInput(initialHistory: string[] = [], vim = false) {
	const [state, setState] = useState<TextInputState>({ text: "", cursor: 0 });
	const [vimMode, setVimModeState] = useState<"normal" | "insert">(vim ? "normal" : "insert");
	// Mirror for synchronous reads inside key handlers (state updates lag one render).
	const vimModeRef = useRef<"normal" | "insert">(vim ? "normal" : "insert");
	const setVimMode = (mode: "normal" | "insert") => {
		vimModeRef.current = mode;
		setVimModeState(mode);
	};
	const historyRef = useRef<string[]>([...initialHistory]);
	const historyIndexRef = useRef<number>(-1);
	const draftRef = useRef<string>("");
	const killRingRef = useRef<string>("");

	const historyUp = useCallback(() => {
		if (historyRef.current.length === 0) return;
		if (historyIndexRef.current === -1) {
			draftRef.current = state.text;
			historyIndexRef.current = historyRef.current.length - 1;
		} else if (historyIndexRef.current > 0) {
			historyIndexRef.current--;
		} else {
			return;
		}
		const entry = historyRef.current[historyIndexRef.current];
		setState({ text: entry, cursor: entry.length });
	}, [state.text]);

	const historyDown = useCallback(() => {
		if (historyIndexRef.current === -1) return;
		if (historyIndexRef.current < historyRef.current.length - 1) {
			historyIndexRef.current++;
			const entry = historyRef.current[historyIndexRef.current];
			setState({ text: entry, cursor: entry.length });
		} else {
			historyIndexRef.current = -1;
			setState({ text: draftRef.current, cursor: draftRef.current.length });
		}
	}, []);

	const pushHistory = useCallback((entry: string) => {
		const trimmed = entry.trim();
		if (!trimmed) return;
		const existing = historyRef.current.indexOf(trimmed);
		if (existing !== -1) historyRef.current.splice(existing, 1);
		historyRef.current.push(trimmed);
		if (historyRef.current.length > 100) historyRef.current.shift();
		historyIndexRef.current = -1;
		draftRef.current = "";
	}, []);

	const actions: TextInputActions = {
		insert: (text) =>
			setState((s) => ({
				text: s.text.slice(0, s.cursor) + text + s.text.slice(s.cursor),
				cursor: s.cursor + text.length,
			})),
		newline: () => actions.insert("\n"),
		backspace: () =>
			setState((s) =>
				s.cursor === 0 ? s : { text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1 },
			),
		delete: () =>
			setState((s) =>
				s.cursor >= s.text.length
					? s
					: { text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), cursor: s.cursor },
			),
		moveLeft: () => setState((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) })),
		moveRight: () => setState((s) => ({ ...s, cursor: Math.min(s.text.length, s.cursor + 1) })),
		moveToLineStart: () => setState((s) => ({ ...s, cursor: 0 })),
		moveToLineEnd: () => setState((s) => ({ ...s, cursor: s.text.length })),
		moveWordLeft: () =>
			setState((s) => {
				let i = s.cursor;
				while (i > 0 && /\s/.test(s.text[i - 1])) i--;
				while (i > 0 && !/\s/.test(s.text[i - 1])) i--;
				return { ...s, cursor: i };
			}),
		moveWordRight: () =>
			setState((s) => {
				let i = s.cursor;
				while (i < s.text.length && !/\s/.test(s.text[i])) i++;
				while (i < s.text.length && /\s/.test(s.text[i])) i++;
				return { ...s, cursor: i };
			}),
		killToEnd: () =>
			setState((s) => {
				killRingRef.current = s.text.slice(s.cursor);
				return { text: s.text.slice(0, s.cursor), cursor: s.cursor };
			}),
		killToStart: () =>
			setState((s) => {
				killRingRef.current = s.text.slice(0, s.cursor);
				return { text: s.text.slice(s.cursor), cursor: 0 };
			}),
		yank: () => actions.insert(killRingRef.current),
		clear: () => setState({ text: "", cursor: 0 }),
		setText: (text) => setState({ text, cursor: text.length }),
	};

	return {
		state,
		actions,
		historyUp,
		historyDown,
		pushHistory,
		// Read through the ref so key handlers see the mode synchronously;
		// the mirrored state exists only to re-render the mode indicator.
		get vimMode() {
			return vim ? vimModeRef.current : ("insert" as const);
		},
		/**
		 * Vim key handler — call before default handling; returns true when the
		 * key was consumed by normal mode (insert mode falls through except Esc).
		 */
		handleVimKey(input: string, key: Key): boolean {
			if (!vim) return false;
			if (vimModeRef.current === "insert") {
				if (key.escape) {
					setVimMode("normal");
					return true;
				}
				return false;
			}
			switch (true) {
				case input === "h":
					actions.moveLeft();
					break;
				case input === "l":
					actions.moveRight();
					break;
				case input === "0":
					actions.moveToLineStart();
					break;
				case input === "$":
					actions.moveToLineEnd();
					break;
				case input === "w":
					actions.moveWordRight();
					break;
				case input === "b":
					actions.moveWordLeft();
					break;
				case input === "x":
					actions.delete();
					break;
				case input === "D":
					actions.killToEnd();
					break;
				case input === "i":
					setVimMode("insert");
					break;
				case input === "a":
					setVimMode("insert");
					setState((s) => ({ ...s, cursor: Math.min(s.text.length, s.cursor + 1) }));
					break;
				case input === "A":
					setVimMode("insert");
					setState((s) => ({ ...s, cursor: s.text.length }));
					break;
				case input === "o":
					setVimMode("insert");
					setState((s) => ({ text: `${s.text}\n`, cursor: s.text.length + 1 }));
					break;
				case input === "j":
					historyDown();
					break;
				case input === "k":
					historyUp();
					break;
				default:
					break;
			}
			return true; // normal mode consumes everything
		},
	};
}
