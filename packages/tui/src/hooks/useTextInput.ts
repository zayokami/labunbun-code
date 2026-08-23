/**
 * Terminal text editor state: multiline buffer, cursor motion, word jumps,
 * kill/yank, undo/redo, and history recall. Pure state transitions; the
 * component maps ink useInput keys onto these actions.
 *
 * The optional vim layer delegates to the pure VimEngine (../vim.ts); this
 * hook only supplies the editor operations (read/replace/undo) and keeps a
 * synchronous state mirror so the engine can read the buffer between renders.
 */

import type { Key } from "ink";
import { useCallback, useRef, useState } from "react";
import { VimEngine, type VimMode } from "../vim.ts";

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
	killWordBack(): void;
	killWordForward(): void;
	yank(): void;
	clear(): void;
	setText(text: string): void;
	/** Replace the whole buffer and place the cursor exactly — completions use this. */
	setBuffer(text: string, cursor: number): void;
	undo(): void;
	redo(): void;
}

const UNDO_LIMIT = 200;

/**
 * Word-kill primitives, pure so the boundaries are testable without a
 * component. Boundary logic matches moveWordLeft/moveWordRight: whitespace
 * collapses together with the adjacent word, readline-style.
 */
export function killWordBack(text: string, cursor: number): { text: string; cursor: number; killed: string } {
	let i = cursor;
	while (i > 0 && /\s/.test(text[i - 1])) i--;
	while (i > 0 && !/\s/.test(text[i - 1])) i--;
	return { text: text.slice(0, i) + text.slice(cursor), cursor: i, killed: text.slice(i, cursor) };
}

export function killWordForward(text: string, cursor: number): { text: string; cursor: number; killed: string } {
	let i = cursor;
	while (i < text.length && !/\s/.test(text[i])) i++;
	while (i < text.length && /\s/.test(text[i])) i++;
	return { text: text.slice(0, cursor) + text.slice(i), cursor, killed: text.slice(cursor, i) };
}

export function useTextInput(initialHistory: string[] = [], vim = false) {
	const [state, setState] = useState<TextInputState>({ text: "", cursor: 0 });
	// Synchronous mirror — the vim engine reads the buffer between renders.
	const stateRef = useRef<TextInputState>({ text: "", cursor: 0 });
	const commit = useCallback((next: TextInputState | ((s: TextInputState) => TextInputState)) => {
		const resolved = typeof next === "function" ? next(stateRef.current) : next;
		stateRef.current = resolved;
		setState(resolved);
	}, []);

	const historyRef = useRef<string[]>([...initialHistory]);
	const historyIndexRef = useRef<number>(-1);
	const draftRef = useRef<string>("");
	const killRingRef = useRef<string>("");
	// Readline kill semantics: consecutive kills accumulate in the ring, any
	// other edit starts a fresh one. Motions do not break the chain.
	const lastActionWasKillRef = useRef(false);
	const undoStackRef = useRef<TextInputState[]>([]);
	const redoStackRef = useRef<TextInputState[]>([]);

	/** Fold a freshly killed region into the ring, honoring consecutive kills. */
	const recordKill = useCallback((killed: string, direction: "back" | "forward") => {
		if (killed.length === 0) return;
		if (lastActionWasKillRef.current && killed.length > 0) {
			killRingRef.current = direction === "back" ? killed + killRingRef.current : killRingRef.current + killed;
		} else {
			killRingRef.current = killed;
		}
		lastActionWasKillRef.current = true;
	}, []);

	/** Record the current state on the undo stack (call BEFORE mutating). */
	const recordUndo = useCallback(() => {
		undoStackRef.current.push({ ...stateRef.current });
		if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
		redoStackRef.current = [];
	}, []);

	const historyUp = useCallback(() => {
		if (historyRef.current.length === 0) return;
		if (historyIndexRef.current === -1) {
			draftRef.current = stateRef.current.text;
			historyIndexRef.current = historyRef.current.length - 1;
		} else if (historyIndexRef.current > 0) {
			historyIndexRef.current--;
		} else {
			return;
		}
		const entry = historyRef.current[historyIndexRef.current];
		commit({ text: entry, cursor: entry.length });
	}, [commit]);

	const historyDown = useCallback(() => {
		if (historyIndexRef.current === -1) return;
		if (historyIndexRef.current < historyRef.current.length - 1) {
			historyIndexRef.current++;
			const entry = historyRef.current[historyIndexRef.current];
			commit({ text: entry, cursor: entry.length });
		} else {
			historyIndexRef.current = -1;
			commit({ text: draftRef.current, cursor: draftRef.current.length });
		}
	}, [commit]);

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
		insert: (text) => {
			lastActionWasKillRef.current = false;
			commitWithUndo((s) => ({
				text: s.text.slice(0, s.cursor) + text + s.text.slice(s.cursor),
				cursor: s.cursor + text.length,
			}));
		},
		newline: () => actions.insert("\n"),
		backspace: () => {
			lastActionWasKillRef.current = false;
			commitWithUndo((s) =>
				s.cursor === 0 ? s : { text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1 },
			);
		},
		delete: () => {
			lastActionWasKillRef.current = false;
			commitWithUndo((s) =>
				s.cursor >= s.text.length
					? s
					: { text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1), cursor: s.cursor },
			);
		},
		moveLeft: () => commit((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) })),
		moveRight: () => commit((s) => ({ ...s, cursor: Math.min(s.text.length, s.cursor + 1) })),
		moveToLineStart: () => commit((s) => ({ ...s, cursor: 0 })),
		moveToLineEnd: () => commit((s) => ({ ...s, cursor: s.text.length })),
		moveWordLeft: () =>
			commit((s) => {
				let i = s.cursor;
				while (i > 0 && /\s/.test(s.text[i - 1])) i--;
				while (i > 0 && !/\s/.test(s.text[i - 1])) i--;
				return { ...s, cursor: i };
			}),
		moveWordRight: () =>
			commit((s) => {
				let i = s.cursor;
				while (i < s.text.length && !/\s/.test(s.text[i])) i++;
				while (i < s.text.length && /\s/.test(s.text[i])) i++;
				return { ...s, cursor: i };
			}),
		killToEnd: () =>
			commitWithUndo((s) => {
				recordKill(s.text.slice(s.cursor), "forward");
				return { text: s.text.slice(0, s.cursor), cursor: s.cursor };
			}),
		killToStart: () =>
			commitWithUndo((s) => {
				recordKill(s.text.slice(0, s.cursor), "back");
				return { text: s.text.slice(s.cursor), cursor: 0 };
			}),
		killWordBack: () =>
			commitWithUndo((s) => {
				const next = killWordBack(s.text, s.cursor);
				recordKill(next.killed, "back");
				return { text: next.text, cursor: next.cursor };
			}),
		killWordForward: () =>
			commitWithUndo((s) => {
				const next = killWordForward(s.text, s.cursor);
				recordKill(next.killed, "forward");
				return { text: next.text, cursor: next.cursor };
			}),
		yank: () => actions.insert(killRingRef.current),
		clear: () => {
			lastActionWasKillRef.current = false;
			commitWithUndo(() => ({ text: "", cursor: 0 }));
		},
		setText: (text) => {
			lastActionWasKillRef.current = false;
			commitWithUndo(() => ({ text, cursor: text.length }));
		},
		setBuffer: (text, cursor) => {
			lastActionWasKillRef.current = false;
			commitWithUndo(() => ({ text, cursor }));
		},
		undo: () => {
			lastActionWasKillRef.current = false;
			const prev = undoStackRef.current.pop();
			if (!prev) return;
			redoStackRef.current.push({ ...stateRef.current });
			commit(prev);
		},
		redo: () => {
			lastActionWasKillRef.current = false;
			const next = redoStackRef.current.pop();
			if (!next) return;
			undoStackRef.current.push({ ...stateRef.current });
			commit(next);
		},
	};

	function commitWithUndo(fn: (s: TextInputState) => TextInputState): void {
		recordUndo();
		commit(fn(stateRef.current));
	}

	// -- vim engine -----------------------------------------------------------

	const engineRef = useRef<VimEngine | null>(null);
	if (vim && engineRef.current === null) {
		engineRef.current = new VimEngine(
			{
				getText: () => stateRef.current.text,
				getCursor: () => stateRef.current.cursor,
				setCursor: (pos) => commit((s) => ({ ...s, cursor: Math.max(0, Math.min(pos, s.text.length)) })),
				setAll: (text, cursor) => commitWithUndo(() => ({ text, cursor })),
				enterInsert: () => {},
				toNormal: () => {},
				recallHistory: (dir) => (dir === "up" ? historyUp() : historyDown()),
				undo: () => actions.undo(),
				redo: () => actions.redo(),
			},
			true,
		);
	}

	// Pure mode/selection flips don't touch React state — bump a tick so the
	// mode badge and selection highlight stay live.
	const [, setRenderTick] = useState(0);
	const handleVimKey = useCallback((input: string, key: Partial<Key>): boolean => {
		const engine = engineRef.current;
		if (!engine) return false;
		const before = `${engine.mode}:${JSON.stringify(engine.selection)}`;
		const consumed = engine.handleKey(input, {
			escape: key.escape,
			return: key.return,
			ctrl: key.ctrl,
			meta: key.meta,
			upArrow: key.upArrow,
			downArrow: key.downArrow,
			leftArrow: key.leftArrow,
			rightArrow: key.rightArrow,
		});
		if (consumed && `${engine.mode}:${JSON.stringify(engine.selection)}` !== before) {
			setRenderTick((t) => t + 1);
		}
		return consumed;
	}, []);

	const vimMode: VimMode = engineRef.current ? engineRef.current.mode : "insert";
	const selection = engineRef.current?.selection ?? null;

	return {
		state,
		actions,
		historyUp,
		historyDown,
		pushHistory,
		vimMode,
		handleVimKey,
		selection,
	};
}
