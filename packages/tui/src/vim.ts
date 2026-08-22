/**
 * Vim modal-editing state machine — pure logic, no React/ink dependencies.
 *
 * Modes: NORMAL, INSERT, VISUAL (charwise), V-LINE (linewise).
 *
 * NORMAL supports:
 *   motions   h l 0 ^ $ w W b B e E f{c} F{c} t{c} T{c} ; , gg G j k
 *   operators d c y — doubled (dd/cc/yy) is linewise; cw keeps trailing
 *             whitespace (the classic cw/ce quirk); dgg/dG/dj/dk are linewise
 *   counts    [n] prefixes multiply (2w, d3j, 2dd); operator+motion counts
 *             multiply too (2d3w deletes 6 words)
 *   edits     x X D C S Y s r{c} ~ J p P i I a A o O u ctrl+r v V
 *
 * Deliberate simplifications: f/t/F/T are line-scoped (as in vim); `>>`/`<<`,
 * marks, registers beyond the unnamed one, and `:` ex-commands are out of
 * scope; j/k delegate to prompt-history recall when the buffer has no newline
 * (the common single-line REPL case).
 *
 * All structural mutations go through `ops.setAll` — the host wires that to an
 * undo-recording setState. Cursor-only moves use `ops.setCursor` and are not
 * undoable (vim separates cursor motion from the undo tree the same way).
 */

export type VimMode = "normal" | "insert" | "visual" | "visual-line";

export interface VimOps {
	getText(): string;
	getCursor(): number;
	setCursor(pos: number): void;
	setAll(text: string, cursor: number): void;
	enterInsert(): void;
	toNormal(): void;
	/** j/k on a single-line buffer delegates to prompt history. */
	recallHistory(direction: "up" | "down"): void;
	undo(): void;
	redo(): void;
}

export interface VimKey {
	escape?: boolean;
	return?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
}

// ---------------------------------------------------------------------------
// Pure text helpers (exported for unit tests)
// ---------------------------------------------------------------------------

type CharClass = 0 | 1 | 2; // 0 blank, 1 word, 2 punctuation

function charClass(c: string, big = false): CharClass {
	if (/\s/.test(c)) return 0;
	if (big) return 1;
	if (/[\w]/.test(c)) return 1;
	return 2;
}

export function lineStart(text: string, pos: number): number {
	let i = pos - 1;
	while (i >= 0 && text[i] !== "\n") i--;
	return i + 1;
}

export function lineEndExclusive(text: string, pos: number): number {
	let i = pos;
	while (i < text.length && text[i] !== "\n") i++;
	return i;
}

export function lineOf(text: string, pos: number): number {
	let count = 0;
	for (let i = 0; i < pos && i < text.length; i++) {
		if (text[i] === "\n") count++;
	}
	return count;
}

export function nthLineStart(text: string, line: number): number {
	let pos = 0;
	for (let i = 0; i < line; i++) {
		const next = text.indexOf("\n", pos);
		if (next === -1) return pos;
		pos = next + 1;
	}
	return pos;
}

export function lineCount(text: string): number {
	if (text.length === 0) return 1;
	let count = 1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") count++;
	}
	return count;
}

export function motionForwardWord(text: string, pos: number, big = false): number {
	const n = text.length;
	if (pos >= n) return n;
	let i = pos;
	const startCls = charClass(text[i], big);
	if (startCls !== 0) {
		while (i < n && charClass(text[i], big) === startCls) i++;
	}
	while (i < n && charClass(text[i], big) === 0) i++;
	return i;
}

export function motionBackWord(text: string, pos: number, big = false): number {
	if (pos <= 0) return 0;
	let i = pos - 1;
	while (i > 0 && charClass(text[i], big) === 0) i--;
	const c = charClass(text[i], big);
	while (i > 0 && charClass(text[i - 1], big) === c) i--;
	return i;
}

export function motionWordEnd(text: string, pos: number, big = false): number {
	const n = text.length;
	if (pos >= n - 1) return Math.max(0, n - 1);
	let i = pos + 1;
	while (i < n && charClass(text[i], big) === 0) i++;
	while (i + 1 < n && charClass(text[i + 1], big) !== 0 && charClass(text[i + 1], big) === charClass(text[i], big)) {
		i++;
	}
	return i;
}

export function motionFirstNonBlank(text: string, pos: number): number {
	const start = lineStart(text, pos);
	const end = lineEndExclusive(text, pos);
	let i = start;
	while (i < end && (text[i] === " " || text[i] === "\t")) i++;
	return i;
}

const WORD_MOTIONS = new Set(["w", "W", "b", "B", "e", "E"]);
const FIND_MOTIONS = new Set(["f", "F", "t", "T"]);
const LINEWISE_MOTIONS = new Set(["gg", "G", "j", "k"]);

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class VimEngine {
	mode: VimMode;
	/** Selection range while in a visual mode (start < end). */
	selection: { start: number; end: number } | null = null;

	#ops: VimOps;
	#anchor = 0;
	#pending: { operator: "d" | "c" | "y"; count: number } | null = null;
	#pendingChar: "f" | "F" | "t" | "T" | "r" | null = null;
	#pendingCharWithOp = false;
	#pendingG: { operator: "d" | "c" | "y" | null; count: number } | null = null;
	#countBuffer = "";
	#lastFind: { char: string; forward: boolean; till: boolean } | null = null;
	#register: { text: string; linewise: boolean } = { text: "", linewise: false };

	constructor(ops: VimOps, enabled = true) {
		this.#ops = ops;
		this.mode = enabled ? "normal" : "insert";
	}

	get enabled(): boolean {
		return this.mode !== "insert" || true; // engine always tracks mode once constructed
	}

	// -- main entry -----------------------------------------------------------

	/**
	 * Handle one key event. Returns true when consumed. In insert mode only
	 * Esc is consumed; everything else falls through to normal typing. Global
	 * shortcuts (ctrl/meta combos except ctrl+r) stay unconsumed so the host
	 * keeps its own keybindings, as does Enter (the REPL submits).
	 */
	handleKey(input: string, key: VimKey): boolean {
		if (this.mode === "insert") {
			if (key.escape) {
				this.mode = "normal";
				this.#ops.toNormal();
				return true;
			}
			return false;
		}

		if (key.meta) return false;
		if (key.ctrl) {
			if (input === "r") {
				this.#ops.redo();
				return true;
			}
			return false; // host shortcuts (ctrl+c, ctrl+o, …)
		}

		if (this.mode === "visual" || this.mode === "visual-line") {
			return this.#handleVisual(input, key);
		}
		return this.#handleNormal(input, key);
	}

	// -- shared ---------------------------------------------------------------

	#takeCount(): number {
		const n = this.#countBuffer ? Number(this.#countBuffer) : 1;
		this.#countBuffer = "";
		return Math.max(1, n);
	}

	#resetPending(): void {
		this.#pending = null;
		this.#pendingChar = null;
		this.#pendingCharWithOp = false;
		this.#pendingG = null;
		this.#countBuffer = "";
	}

	#clamp(pos: number): number {
		return Math.max(0, Math.min(pos, this.#ops.getText().length));
	}

	// -- normal mode ----------------------------------------------------------

	#handleNormal(input: string, key: VimKey): boolean {
		// 1. Complete a pending second keypress (r / f / F / t / T).
		if (this.#pendingChar) {
			const kind = this.#pendingChar;
			this.#pendingChar = null;
			if (key.escape) {
				this.#resetPending();
				return true;
			}
			const char = input === "" && key.return ? "\n" : input;
			if (kind === "r") {
				this.#replaceChar(char);
				this.#resetPending();
				return true;
			}
			this.#lastFind = { char, forward: kind === "f" || kind === "t", till: kind === "t" || kind === "T" };
			if (this.#pendingCharWithOp && this.#pending) {
				const op = this.#pending.operator;
				const preCount = this.#pending.count;
				this.#pending = null;
				this.#applyOperator(op, kind, Math.max(1, preCount) * this.#takeCount(), char);
			} else {
				this.#applyFind(kind, char, this.#takeCount());
			}
			return true;
		}

		// Enter is not consumed in normal mode — the host submits the prompt.
		if (key.return) return false;

		// 2. Complete a pending operator.
		if (this.#pending) {
			if (/^[0-9]$/.test(input)) {
				this.#countBuffer += input;
				return true;
			}
			if (key.escape) {
				this.#resetPending();
				return true;
			}
			const { operator, count } = this.#pending;
			if (input === operator) {
				this.#pending = null;
				this.#applyLinewise(operator, count * this.#takeCount());
				return true;
			}
			if (WORD_MOTIONS.has(input) || ["0", "^", "$", "G", "j", "k"].includes(input)) {
				this.#pending = null;
				const effective = count * this.#takeCount();
				this.#applyOperator(operator, input, effective);
				return true;
			}
			if (input === "g") {
				// d g g — wait for the second g.
				this.#pendingG = { operator, count };
				return true;
			}
			if (FIND_MOTIONS.has(input)) {
				// df{c} / dt{c}: keep the operator alive until the char arrives.
				this.#pendingChar = input as "f" | "F" | "t" | "T";
				this.#pendingCharWithOp = true;
				return true;
			}
			// Unknown key under an operator: cancel and swallow (vim behavior).
			this.#resetPending();
			return true;
		}

		// 3. Complete pending g (gg, with or without an operator).
		if (this.#pendingG) {
			const { operator, count } = this.#pendingG;
			this.#pendingG = null;
			if (input === "g") {
				if (operator) this.#applyOperator(operator, "gg", count);
				else this.#ops.setCursor(0);
			}
			return true; // any non-g key after g is swallowed
		}

		// 4. Count prefix (0 alone is a motion).
		if (/^[1-9]$/.test(input) || (input === "0" && this.#countBuffer !== "")) {
			this.#countBuffer += input;
			return true;
		}

		// 5. Start an operator.
		if (input === "d" || input === "c" || input === "y") {
			this.#pending = { operator: input, count: this.#takeCount() };
			this.#countBuffer = "";
			return true;
		}

		// 6. Start a find that may carry an operator.
		if (FIND_MOTIONS.has(input)) {
			this.#pendingChar = input as "f" | "F" | "t" | "T";
			this.#pendingCharWithOp = false;
			return true;
		}

		// 7. Start gg.
		if (input === "g") {
			this.#pendingG = { operator: null, count: this.#takeCount() };
			return true;
		}

		// 8. Single-key commands.
		switch (input) {
			case "h":
				this.#moveHorizontal(-this.#takeCount());
				return true;
			case "l":
			case " ":
				this.#moveHorizontal(this.#takeCount());
				return true;
			case "w":
				this.#moveByWord("w", false);
				return true;
			case "W":
				this.#moveByWord("w", true);
				return true;
			case "b":
				this.#moveByWord("b", false);
				return true;
			case "B":
				this.#moveByWord("b", true);
				return true;
			case "e":
				this.#moveByWord("e", false);
				return true;
			case "E":
				this.#moveByWord("e", true);
				return true;
			case ";":
				if (this.#lastFind) {
					const { char, forward, till } = this.#lastFind;
					this.#applyFind(forward ? "f" : "F", char, this.#takeCount(), till);
				}
				return true;
			case ",":
				if (this.#lastFind) {
					const { char, forward, till } = this.#lastFind;
					this.#applyFind(forward ? "F" : "f", char, this.#takeCount(), till);
				}
				return true;
			case "0":
				this.#ops.setCursor(lineStart(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "^":
				this.#ops.setCursor(motionFirstNonBlank(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "$": {
				const end = lineEndExclusive(this.#ops.getText(), this.#ops.getCursor());
				this.#ops.setCursor(Math.max(lineStart(this.#ops.getText(), this.#ops.getCursor()), end - 1));
				return true;
			}
			case "G": {
				const text = this.#ops.getText();
				const count = this.#countBuffer ? Number(this.#countBuffer) : null;
				this.#countBuffer = "";
				if (count !== null) {
					this.#ops.setCursor(nthLineStart(text, Math.min(count, lineCount(text)) - 1));
				} else {
					this.#ops.setCursor(text.length);
				}
				return true;
			}
			case "j":
				this.#vertical(1);
				return true;
			case "k":
				this.#vertical(-1);
				return true;
			case "x":
				this.#deleteChars(this.#takeCount());
				return true;
			case "X":
				this.#deleteChars(-this.#takeCount());
				return true;
			case "D":
				this.#applyToLineEnd("d");
				return true;
			case "C":
				this.#applyToLineEnd("c");
				return true;
			case "Y":
				this.#applyLinewise("y", this.#takeCount());
				return true;
			case "s":
				this.#deleteChars(1);
				this.#enterInsertAt(this.#ops.getCursor());
				return true;
			case "S":
				this.#applyLinewise("c", 1);
				return true;
			case "r":
				this.#pendingChar = "r";
				return true;
			case "~":
				this.#toggleCase(this.#takeCount());
				return true;
			case "J":
				this.#joinLines(this.#takeCount());
				return true;
			case "p":
				this.#paste(this.#takeCount(), false);
				return true;
			case "P":
				this.#paste(this.#takeCount(), true);
				return true;
			case "i":
				this.#enterInsertAt(this.#ops.getCursor());
				return true;
			case "I":
				this.#enterInsertAt(motionFirstNonBlank(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "a":
				this.#enterInsertAt(Math.min(this.#ops.getText().length, this.#ops.getCursor() + 1));
				return true;
			case "A":
				this.#enterInsertAt(lineEndExclusive(this.#ops.getText(), this.#ops.getCursor()));
				return true;
			case "o":
				this.#openLine(false);
				return true;
			case "O":
				this.#openLine(true);
				return true;
			case "v":
				this.#startVisual("visual");
				return true;
			case "V":
				this.#startVisual("visual-line");
				return true;
			case "u":
				this.#ops.undo();
				return true;
			default:
				this.#resetPending();
				return true; // normal mode swallows unmapped keys (vim behavior)
		}
	}

	// -- movement -------------------------------------------------------------

	#moveHorizontal(delta: number): void {
		this.#ops.setCursor(this.#clamp(this.#ops.getCursor() + delta));
	}

	#moveByWord(kind: "w" | "b" | "e", big: boolean): void {
		const text = this.#ops.getText();
		let pos = this.#ops.getCursor();
		const count = this.#takeCount();
		for (let i = 0; i < count; i++) {
			if (kind === "w") pos = motionForwardWord(text, pos, big);
			else if (kind === "b") pos = motionBackWord(text, pos, big);
			else pos = motionWordEnd(text, pos, big);
		}
		this.#ops.setCursor(pos);
	}

	#vertical(deltaLines: number): boolean {
		const text = this.#ops.getText();
		if (!text.includes("\n")) {
			this.#ops.recallHistory(deltaLines < 0 ? "up" : "down");
			return true;
		}
		const pos = this.#ops.getCursor();
		const col = pos - lineStart(text, pos);
		const line = Math.max(0, Math.min(lineOf(text, pos) + deltaLines, lineCount(text) - 1));
		const targetStart = nthLineStart(text, line);
		const targetEnd = lineEndExclusive(text, targetStart);
		this.#ops.setCursor(Math.min(targetStart + col, Math.max(targetStart, targetEnd - 1)));
		return true;
	}

	/** Raw position of the [count]'th occurrence of `char` on the current line, or null. */
	#findOnLine(char: string, forward: boolean, count: number): number | null {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		const start = lineStart(text, pos);
		const end = lineEndExclusive(text, pos);
		let found: number | null = null;

		if (forward) {
			let i = pos + 1;
			let remaining = count;
			while (i < end) {
				if (text[i] === char && --remaining === 0) {
					found = i;
					break;
				}
				i++;
			}
		} else {
			let i = pos - 1;
			let remaining = count;
			while (i >= start) {
				if (text[i] === char && --remaining === 0) {
					found = i;
					break;
				}
				i--;
			}
		}
		return found;
	}

	#applyFind(kind: string, char: string, count: number, tillOverride?: boolean): void {
		const forward = kind === "f" || kind === "t";
		const till = tillOverride ?? (kind === "t" || kind === "T");
		const found = this.#findOnLine(char, forward, count);
		if (found === null) return;
		// t/T land one short of the match; f/F land on it.
		this.#ops.setCursor(till ? found + (forward ? -1 : 1) : found);
	}

	// -- edits ----------------------------------------------------------------

	#deleteChars(count: number): void {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		if (count >= 0) {
			const end = Math.min(text.length, pos + count);
			if (end <= pos) return;
			this.#register = { text: text.slice(pos, end), linewise: false };
			this.#ops.setAll(text.slice(0, pos) + text.slice(end), pos);
		} else {
			const start = Math.max(0, pos + count);
			if (start >= pos) return;
			this.#register = { text: text.slice(start, pos), linewise: false };
			this.#ops.setAll(text.slice(0, start) + text.slice(pos), start);
		}
	}

	#replaceChar(char: string): void {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		if (char.length !== 1 || pos >= text.length || text[pos] === "\n") return;
		this.#ops.setAll(text.slice(0, pos) + char + text.slice(pos + 1), pos);
	}

	#toggleCase(count: number): void {
		const text = this.#ops.getText();
		let pos = this.#ops.getCursor();
		let out = text;
		for (let i = 0; i < count && pos < out.length; i++) {
			const c = out[pos];
			if (c === "\n") break;
			const swapped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
			out = out.slice(0, pos) + swapped + out.slice(pos + 1);
			pos++;
		}
		this.#ops.setAll(out, Math.min(pos, out.length));
	}

	#joinLines(count: number): void {
		let text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		let joins = Math.max(1, count - 1);
		while (joins-- > 0) {
			const end = lineEndExclusive(text, pos);
			if (end >= text.length) break;
			let next = end + 1;
			while (next < text.length && (text[next] === " " || text[next] === "\t")) next++;
			text = `${text.slice(0, end)} ${text.slice(next)}`;
			this.#ops.setAll(text, end);
		}
	}

	#paste(count: number, before: boolean): void {
		if (!this.#register.text) return;
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();

		if (this.#register.linewise) {
			const line = lineOf(text, pos);
			const targetLine = before ? line : line + 1;
			let insertAt: number;
			let block = this.#register.text;
			if (!block.endsWith("\n")) block += "\n";
			if (targetLine < lineCount(text)) {
				insertAt = nthLineStart(text, targetLine);
			} else {
				insertAt = text.length;
				if (text.length > 0 && !text.endsWith("\n")) block = `\n${block.replace(/\n$/, "")}`;
				else if (text.length === 0) block = this.#register.text;
			}
			const out = text.slice(0, insertAt) + block + text.slice(insertAt);
			this.#ops.setAll(out, insertAt);
			return;
		}

		const insertAt = before ? pos : Math.min(text.length, pos + (text.length > 0 ? 1 : 0));
		let out = text.slice(0, insertAt);
		for (let i = 0; i < count; i++) out += this.#register.text;
		out += text.slice(insertAt);
		this.#ops.setAll(out, insertAt);
	}

	#openLine(above: boolean): void {
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		const at = above ? lineStart(text, pos) : lineEndExclusive(text, pos);
		// Below: the new empty line starts AFTER the inserted newline.
		this.#ops.setAll(`${text.slice(0, at)}\n${text.slice(at)}`, above ? at : at + 1);
		this.#enterInsertAt(above ? at : at + 1);
	}

	#enterInsertAt(pos: number): void {
		this.#ops.setCursor(this.#clamp(pos));
		this.#enterInsert();
	}

	#enterInsert(): void {
		this.#resetPending();
		this.mode = "insert";
		this.#ops.enterInsert();
	}

	// -- operators ------------------------------------------------------------

	#applyOperator(operator: "d" | "c" | "y", motion: string, count: number, findChar?: string): void {
		const text = this.#ops.getText();

		if (LINEWISE_MOTIONS.has(motion)) {
			const cursorLine = lineOf(text, this.#ops.getCursor());
			let firstLine = cursorLine;
			let lastLine = cursorLine;
			if (motion === "gg") {
				firstLine = 0;
			} else if (motion === "G") {
				lastLine = lineCount(text) - 1;
			} else {
				const delta = motion === "j" ? count : -count;
				lastLine = Math.max(0, Math.min(cursorLine + delta, lineCount(text) - 1));
				if (delta < 0) {
					firstLine = lastLine;
					lastLine = cursorLine;
				}
			}
			const start = nthLineStart(text, firstLine);
			const lastStart = nthLineStart(text, lastLine);
			const lastEnd = lineEndExclusive(text, lastStart);
			const end = lastEnd < text.length ? lastEnd + 1 : lastEnd;
			this.#runLinewise(operator, start, end);
			return;
		}

		let range = this.#motionRange(motion, count, findChar);
		if (!range) return;
		// cw quirk: on a non-blank char, cw acts like ce (keeps trailing
		// whitespace). Plain dw still eats the trailing spaces.
		if (operator === "c" && motion === "w" && !/\s/.test(text[this.#ops.getCursor()] ?? " ")) {
			const endRange = this.#motionRange("e", count);
			if (endRange) range = endRange;
		}
		this.#runOperator(operator, range.start, range.end, range.inclusive);
	}

	#motionRange(
		motion: string,
		count: number,
		findChar?: string,
	): { start: number; end: number; inclusive: boolean } | null {
		const text = this.#ops.getText();
		const from = this.#ops.getCursor();

		if (FIND_MOTIONS.has(motion)) {
			if (!findChar) return null;
			const forward = motion === "f" || motion === "t";
			const till = motion === "t" || motion === "T";
			const found = this.#findOnLine(findChar, forward, count);
			if (found === null) return null;
			// f/t are vim-inclusive (the landing char is part of the range);
			// F/T are exclusive. Use the same landing position a bare motion
			// would use, then fold inclusivity into `end` like other motions.
			const target = till ? found + (forward ? -1 : 1) : found;
			const start = Math.min(from, target);
			let end = Math.max(from, target);
			if (forward && target >= from) end += 1;
			return { start, end: Math.min(end, text.length), inclusive: forward };
		}

		let target = from;
		let inclusive = false;
		switch (motion) {
			case "w":
			case "W":
				for (let i = 0; i < count; i++) target = motionForwardWord(text, target, motion === "W");
				break;
			case "b":
			case "B":
				for (let i = 0; i < count; i++) target = motionBackWord(text, target, motion === "B");
				break;
			case "e":
			case "E":
				for (let i = 0; i < count; i++) target = motionWordEnd(text, target, motion === "E");
				inclusive = true;
				break;
			case "0":
				target = lineStart(text, from);
				break;
			case "^":
				target = motionFirstNonBlank(text, from);
				break;
			case "$":
				target = Math.max(0, lineEndExclusive(text, from) - 1);
				inclusive = true;
				break;
			default:
				return null;
		}

		const start = Math.min(from, target);
		let end = Math.max(from, target);
		if (inclusive && target >= from) end += 1;
		return { start, end: Math.min(end, text.length), inclusive };
	}

	#runOperator(operator: "d" | "c" | "y", start: number, end: number, _inclusive: boolean): void {
		// NOTE: #motionRange already folds `inclusive` into `end`; do not add again.
		const text = this.#ops.getText();
		const cutEnd = Math.min(text.length, Math.max(start, end));
		this.#register = { text: text.slice(start, cutEnd), linewise: false };
		if (operator === "y") {
			this.#ops.setCursor(start);
			return;
		}
		const out = text.slice(0, start) + text.slice(cutEnd);
		this.#ops.setAll(out, Math.min(start, out.length));
		if (operator === "c") this.#enterInsert();
	}

	#runLinewise(operator: "d" | "c" | "y", start: number, end: number): void {
		const text = this.#ops.getText();
		this.#register = { text: text.slice(start, end), linewise: true };
		if (operator === "y") {
			this.#ops.setCursor(start);
			return;
		}
		const out = text.slice(0, start) + text.slice(end);
		this.#ops.setAll(out, Math.min(start, out.length));
		if (operator === "c") {
			// cc/S leaves an empty line behind and inserts on it.
			this.#ops.setAll(`${out.slice(0, start)}\n${out.slice(start)}`, start);
			this.#enterInsert();
		}
	}

	#applyLinewise(operator: "d" | "c" | "y", count: number): void {
		const text = this.#ops.getText();
		const startLine = lineOf(text, this.#ops.getCursor());
		const endLine = Math.min(lineCount(text) - 1, startLine + count - 1);
		const start = nthLineStart(text, startLine);
		const lastStart = nthLineStart(text, endLine);
		const lastEnd = lineEndExclusive(text, lastStart);
		const end = lastEnd < text.length ? lastEnd + 1 : lastEnd;
		this.#runLinewise(operator, start, end);
	}

	#applyToLineEnd(operator: "d" | "c"): void {
		const text = this.#ops.getText();
		const start = this.#ops.getCursor();
		const end = lineEndExclusive(text, start);
		this.#register = { text: text.slice(start, end), linewise: false };
		this.#ops.setAll(text.slice(0, start) + text.slice(end), start);
		if (operator === "c") this.#enterInsert();
	}

	// -- visual mode ----------------------------------------------------------

	#startVisual(mode: "visual" | "visual-line"): void {
		this.mode = mode;
		this.#anchor = this.#ops.getCursor();
		this.#syncSelection();
	}

	#syncSelection(): void {
		const text = this.#ops.getText();
		const a = this.#anchor;
		const c = this.#ops.getCursor();
		if (this.mode === "visual-line") {
			const start = lineStart(text, Math.min(a, c));
			const end = lineEndExclusive(text, Math.max(a, c));
			this.selection = { start, end: Math.min(text.length, end + 1) };
		} else {
			this.selection = {
				start: Math.min(a, c),
				end: Math.min(text.length, Math.max(a, c) + 1),
			};
		}
	}

	#handleVisual(input: string, key: VimKey): boolean {
		if (key.escape) {
			this.#exitVisual(this.#anchor);
			return true;
		}
		if (key.return) return false; // host submits
		if (key.upArrow || key.downArrow) {
			this.#vertical(key.upArrow ? -1 : 1);
			this.#syncSelection();
			return true;
		}
		if (key.leftArrow || key.rightArrow) {
			this.#moveHorizontal(key.rightArrow ? 1 : -1);
			this.#syncSelection();
			return true;
		}

		if (/^[1-9]$/.test(input) || (input === "0" && this.#countBuffer !== "")) {
			this.#countBuffer += input;
			return true;
		}

		switch (input) {
			case "h":
				this.#moveHorizontal(-this.#takeCount());
				this.#syncSelection();
				return true;
			case "l":
				this.#moveHorizontal(this.#takeCount());
				this.#syncSelection();
				return true;
			case "j":
			case "k": {
				const count = this.#takeCount();
				for (let i = 0; i < count; i++) this.#vertical(input === "j" ? 1 : -1);
				this.#syncSelection();
				return true;
			}
			case "w":
				this.#moveVisualByWord("w", false);
				return true;
			case "W":
				this.#moveVisualByWord("w", true);
				return true;
			case "b":
				this.#moveVisualByWord("b", false);
				return true;
			case "e":
				this.#moveVisualByWord("e", false);
				return true;
			case "0":
				this.#ops.setCursor(lineStart(this.#ops.getText(), this.#ops.getCursor()));
				this.#syncSelection();
				return true;
			case "$": {
				const end = lineEndExclusive(this.#ops.getText(), this.#ops.getCursor());
				this.#ops.setCursor(Math.max(0, end - 1));
				this.#syncSelection();
				return true;
			}
			case "o": {
				const swap = this.#anchor;
				this.#anchor = this.#ops.getCursor();
				this.#ops.setCursor(swap);
				this.#syncSelection();
				return true;
			}
			case "d":
			case "x":
				this.#deleteSelection();
				return true;
			case "y":
				this.#yankSelection();
				return true;
			case "c":
			case "s":
				this.#changeSelection();
				return true;
			case "u":
				this.#swapCaseSelection(false);
				return true;
			case "U":
				this.#swapCaseSelection(true);
				return true;
			case "v":
				this.#startVisual("visual");
				return true;
			case "V":
				this.#startVisual("visual-line");
				return true;
			default:
				return true;
		}
	}

	#moveVisualByWord(kind: "w" | "b" | "e", big: boolean): void {
		this.#moveByWord(kind, big);
		this.#syncSelection();
	}

	#exitVisual(cursorTo: number): void {
		this.mode = "normal";
		this.selection = null;
		this.#resetPending();
		this.#ops.setCursor(this.#clamp(cursorTo));
		this.#ops.toNormal();
	}

	#deleteSelection(): void {
		if (!this.selection) return;
		const text = this.#ops.getText();
		const { start, end } = this.selection;
		this.#register = { text: text.slice(start, end), linewise: this.mode === "visual-line" };
		this.#ops.setAll(text.slice(0, start) + text.slice(end), start);
		this.#exitVisual(start);
	}

	#yankSelection(): void {
		if (!this.selection) return;
		const text = this.#ops.getText();
		this.#register = {
			text: text.slice(this.selection.start, this.selection.end),
			linewise: this.mode === "visual-line",
		};
		this.#exitVisual(this.selection.start);
	}

	#changeSelection(): void {
		if (!this.selection) return;
		const { start, end } = this.selection;
		const text = this.#ops.getText();
		this.#register = { text: text.slice(start, end), linewise: this.mode === "visual-line" };
		this.#ops.setAll(text.slice(0, start) + text.slice(end), start);
		this.#exitVisual(start);
		this.#enterInsert();
	}

	#swapCaseSelection(toUpper: boolean): void {
		if (!this.selection) return;
		const text = this.#ops.getText();
		const { start, end } = this.selection;
		const segment = text.slice(start, end);
		const swapped = toUpper
			? segment.toUpperCase()
			: segment
					.split("")
					.map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
					.join("");
		this.#ops.setAll(text.slice(0, start) + swapped + text.slice(end), start);
		this.#exitVisual(start);
	}
}
