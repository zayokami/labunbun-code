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
import type { EditorKind } from "../editing-mode.ts";
import { EmacsEngine } from "../emacs.ts";
import { nextChar, prevChar, snapToChar, VimEngine, type VimMode } from "../vim.ts";

/**
 * An engine and the editor it belongs to.
 *
 * The kind is carried beside the engine rather than asked of it, because the two
 * answer different questions and only one of them can: `VimEngine` has a `mode`
 * and an `EmacsEngine` has no such concept at all, so "which editor is this" has
 * to be a separate fact or the type has to pretend emacs is in insert mode.
 */
type EditorEngine = { kind: "vim"; engine: VimEngine } | { kind: "emacs"; engine: EmacsEngine };

/**
 * Emacs's region as a range, or null when there is not one.
 *
 * Three conditions, because `region-active-p` is three conditions: the mark is
 * set, `mark-active` is on, and the two differ. This host is always in Transient
 * Mark mode, so the fourth — that Transient Mark mode is on at all — is the one
 * that cannot fail. The last condition is the one worth writing down: a region
 * whose ends coincide is *not* a region, and `C-@` pressed twice leaves exactly
 * that state, which has to draw nothing rather than draw a caret-width block.
 */
function emacsRegion(engine: EmacsEngine | null, cursor: number): { start: number; end: number } | null {
	if (!engine) return null;
	const { mark } = engine;
	if (!engine.markActive || mark === null || mark === cursor) return null;
	return { start: Math.min(mark, cursor), end: Math.max(mark, cursor) };
}

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
	/** Put a recalled entry in the buffer, caret at the end — history search uses this. */
	recall(text: string): void;
	undo(): void;
	redo(): void;
}

const UNDO_LIMIT = 200;

/**
 * One insert-mode Backspace step. A character is not a code unit: an emoji is a
 * surrogate pair and `é` may be `e` plus a combining acute, so stepping by one
 * unit would leave half a character behind. vim's insert-mode <BS> deletes the
 * whole cluster — and a lone leading mark on its own — which is exactly what the
 * engine's prevChar/nextChar boundaries give (verified against vim 9.1).
 */
export function backspaceChar(text: string, cursor: number): { text: string; cursor: number } {
	const end = snapToChar(text, cursor);
	const start = prevChar(text, end);
	return { text: text.slice(0, start) + text.slice(end), cursor: start };
}

/** The forward twin: vim's insert-mode <Del>, deleting the whole character. */
export function deleteChar(text: string, cursor: number): { text: string; cursor: number } {
	const end = snapToChar(text, cursor);
	return { text: text.slice(0, end) + text.slice(nextChar(text, end)), cursor: end };
}

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

export function useTextInput(initialHistory: string[] = [], editor: EditorKind = "none") {
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
		// At the buffer ends the primitives return the buffer unchanged, and
		// commitWithUndo's no-change rule keeps that out of the undo stack.
		backspace: () => {
			lastActionWasKillRef.current = false;
			commitWithUndo((s) => backspaceChar(s.text, s.cursor));
		},
		delete: () => {
			lastActionWasKillRef.current = false;
			commitWithUndo((s) => deleteChar(s.text, s.cursor));
		},
		moveLeft: () => commit((s) => ({ ...s, cursor: prevChar(s.text, s.cursor) })),
		// nextChar steps past the buffer end; the clamp is what keeps the cursor legal.
		moveRight: () => commit((s) => ({ ...s, cursor: Math.min(s.text.length, nextChar(s.text, s.cursor)) })),
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
		recall: (text) => {
			lastActionWasKillRef.current = false;
			commitWithUndo(() => ({ text, cursor: text.length }));
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
		const next = fn(stateRef.current);
		// An edit that changes nothing must not push a snapshot: the push would
		// clear the redo stack the user still expects to walk back through.
		if (next.text === stateRef.current.text && next.cursor === stateRef.current.cursor) return;
		recordUndo();
		commit(next);
	}

	// -- the editing engine ---------------------------------------------------

	/**
	 * The engine for one editor, over the buffer this hook owns.
	 *
	 * A factory rather than a constructor call at each use site, because the rule
	 * that has to hold for *every* engine is the one above it: leaving an editor
	 * has to drop the engine, not just stop creating one. Vim's engine was only
	 * ever constructed and never discarded, so the hook went on handing keys to an
	 * engine that was no longer vim's to consume, and `r` redid instead of typing.
	 * With the rule inside the factory, the second editor cannot forget it — and
	 * the mode is carried on the engine, so switching editors rebuilds rather than
	 * handing vim's keys to emacs.
	 */
	function buildEditorEngine(kind: Exclude<EditorKind, "none">): EditorEngine {
		const ops = {
			getText: () => stateRef.current.text,
			getCursor: () => stateRef.current.cursor,
			setCursor: (pos: number) => commit((s) => ({ ...s, cursor: Math.max(0, Math.min(pos, s.text.length)) })),
			setAll: (text: string, cursor: number) => commitWithUndo(() => ({ text, cursor })),
		};
		if (kind === "emacs") {
			// Emacs takes the four buffer operations and nothing else. It has no
			// modes to enter or leave, and no `j`/`k` history gesture of its own —
			// a wider interface here would mean passing no-ops to express "this
			// engine does not have that", which is how a caller ends up wiring a
			// handler into a command that does not exist.
			return { kind, engine: new EmacsEngine(ops) };
		}
		return {
			kind,
			engine: new VimEngine({
				...ops,
				enterInsert: () => {},
				toNormal: () => {},
				recallHistory: (dir) => (dir === "up" ? historyUp() : historyDown()),
				undo: () => actions.undo(),
				redo: () => actions.redo(),
			}),
		};
	}

	const engineRef = useRef<EditorEngine | null>(null);
	if (editor === "none") engineRef.current = null;
	if (editor !== "none" && engineRef.current?.kind !== editor) {
		engineRef.current = buildEditorEngine(editor);
	}

	// Pure mode/selection flips don't touch React state — bump a tick so the
	// mode badge and selection highlight stay live.
	const [, setRenderTick] = useState(0);
	const handleEditorKey = useCallback((input: string, key: Partial<Key>): boolean => {
		const current = engineRef.current;
		if (!current) return false;
		const shared = {
			escape: key.escape,
			return: key.return,
			ctrl: key.ctrl,
			meta: key.meta,
			tab: key.tab,
			upArrow: key.upArrow,
			downArrow: key.downArrow,
			leftArrow: key.leftArrow,
			rightArrow: key.rightArrow,
			home: key.home,
			end: key.end,
			backspace: key.backspace,
			delete: key.delete,
		};
		if (current.kind === "emacs") {
			// Emacs is modeless, so there is no mode to compare and no selection the
			// engine keeps: the region is read off the mark. Anything that changes
			// the region without moving the cursor still needs the repaint, so the
			// before/after pair is the mark pair rather than the mode.
			const engine = current.engine as EmacsEngine;
			// `[C-backspace]` and `[M-DEL]` are the same command in Emacs
			// (`backward-kill-word`, `bindings.el:1634` and `:1613`), and a terminal
			// sends both as Escape followed by the erase character, which is the
			// shape Ink reports as `meta` plus `backspace`. Deriving the engine's
			// flag from that is faithful rather than a guess — and it matters, because
			// without it the key falls through to the readline path in PromptInput,
			// which kills the word into a different buffer and so breaks the chain
			// the emacs kill ring is for.
			const backspaceKey = key.backspace === true && key.meta === true;
			const before = `${engine.mark}:${engine.markActive}`;
			const consumed = engine.handleKey(input, { ...shared, ctrlBackspace: backspaceKey });
			if (consumed && `${engine.mark}:${engine.markActive}` !== before) setRenderTick((t) => t + 1);
			return consumed;
		}
		const engine = current.engine as VimEngine;
		const before = `${engine.mode}:${JSON.stringify(engine.selection)}`;
		const consumed = engine.handleKey(input, shared);
		if (consumed && `${engine.mode}:${JSON.stringify(engine.selection)}` !== before) {
			setRenderTick((t) => t + 1);
		}
		return consumed;
	}, []);

	const vimEngine = engineRef.current?.kind === "vim" ? (engineRef.current.engine as VimEngine) : null;
	// "insert" whenever vim is not the editor, which is what the badge and the
	// hint line read. Emacs has no modes, so there is nothing for them to say.
	const vimMode: VimMode = vimEngine ? vimEngine.mode : "insert";
	/**
	 * The highlighted range, from whichever engine is up.
	 *
	 * Emacs keeps a region as a mark plus `mark-active` rather than as a stored
	 * range (`use-region-p`, `simple.el:7238-7263`), so the range is derived rather
	 * than read: a region needs the mark set, the flag on, and the two to differ.
	 * An active but zero-width region is not a region, and highlighting nothing is
	 * what Emacs does with it.
	 */
	const emacsEngine = engineRef.current?.kind === "emacs" ? (engineRef.current.engine as EmacsEngine) : null;
	const selection: { start: number; end: number } | null = vimEngine
		? vimEngine.selection
		: emacsRegion(emacsEngine, stateRef.current.cursor);

	/**
	 * The live history, newest last — the same array ↑ recall walks, not just the
	 * seed it started from. A copy, because a search that mutated what it was
	 * reading would be a fine way to lose a prompt.
	 */
	const getHistory = useCallback(() => [...historyRef.current], []);

	return {
		state,
		actions,
		historyUp,
		historyDown,
		pushHistory,
		getHistory,
		vimMode,
		handleEditorKey,
		selection,
	};
}
