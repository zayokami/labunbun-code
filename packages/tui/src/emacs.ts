/**
 * Emacs editing engine — batch E-2: motion, kill ring, prefix argument, vertical motion.
 *
 * Emacs is **modeless**, and that is the whole contract. `VimEngine` consumes a printable
 * character in NORMAL because NORMAL is not for typing; here the default answer to a key
 * is "not mine" — {@link EmacsEngine.handleKey} returns `false` and the host inserts the
 * character exactly as it would with no engine at all. What an Emacs engine *is* is the
 * set of keys Emacs has bound, plus the four pieces of state a modeless editor needs that
 * a modal one gets from its mode: the kill ring, the prefix argument, the mark and region,
 * and the goal column.
 *
 * Six things a first reading of this batch gets wrong, and where the truth is. Each is a
 * place where the obvious plan is not what the tree does.
 *
 *   - **There is no `lisp/emacs/`.** `simple.el`, `bindings.el` and `subr.el` are flat, in
 *     `lisp/`. `killed-move.el` does not exist at all, and the C command file is
 *     `src/cmds.c`, where `delete-char` lives (`cmds.c:221`).
 *   - **`backward-kill-line` does not exist.** Nothing in the tree defines it, and `C-b` is
 *     `backward-char` (`subr.el:1777`).
 *   - **`C-u C-k` is not a binding.** Nothing anywhere `define-key`s it. `C-u` is
 *     `universal-argument` (`bindings.el:1298`) and `C-k` is `kill-line`
 *     (`bindings.el:1326`), and what everyone calls "`C-u C-k`" is those two composed: the
 *     `(4)` reaches `kill-line` through its `"P"` spec and `prefix-numeric-value`
 *     (`simple.el:6807`) turns it into four lines. Emacs's `dd` is `kill-whole-line`, on
 *     `[C-S-backspace]` (`bindings.el:1407`).
 *   - **The basic key table is not in `bindings.el`.** `global-map` is built in
 *     `subr.el:1759-1779` — it has to exist before `bindings.el` loads — and `esc-map` is
 *     `subr.el:1715-1724`. `subr.el:1771` walks `#o040` to `#o0177` binding
 *     `self-insert-command` to every one of them, which is exactly why this engine hands
 *     plain characters straight back.
 *   - **`C-h` is not bound in `global-map` at all.** The only `C-h` in the tree is
 *     `mark-defun` in `esc-map` (`bindings.el:1666`); there is no `define-key global-map`
 *     for it, and `backward-delete-char-untabify` — the command most descriptions of Emacs
 *     call `C-h` — is bound nowhere outside CUA remaps and a couple of programming modes.
 *     What *is* bound is the DEL character, as `delete-backward-char` (`bindings.el:1318`,
 *     `"\177"`), and a terminal sends the Backspace key as either `^?` or `^H`. This engine
 *     therefore routes both spellings to `delete-backward-char` and says so as a host
 *     decision rather than a transcription. See `EmacsEngine` on `C-h`.
 *   - **The word rules are the syntax table plus a character script, and the script table is
 *     built from Unicode *Blocks*, not Scripts.** See {@link emacsScriptOf} and
 *     {@link emacsIsWordChar}.
 *
 * Contracts the host relies on:
 *
 *   - **Unbound means yours.** `handleKey` returns `false` for anything Emacs has not bound,
 *     including every printable character. ink hands one keypress to every `useInput`
 *     listener, so `false` is what lets the host type, and it is also what leaves the REPL's
 *     own Escape and Enter alone.
 *   - **The host's typing is read back off the buffer, not told to us.** The engine keeps a
 *     `#typedFrom` marker copied from `VimEngine`'s (`vim.ts:2499`, armed at `3888`, consumed
 *     at `2564-2567`): a character we declined is remembered by position, and the next key
 *     compares the buffer against the snapshot to find out what landed. That is the only way
 *     this engine learns the two facts Emacs's command loop hands over for free — that the
 *     last command was `self-insert-command`, which breaks the kill chain and re-seeds the
 *     goal column, and that the buffer was modified, which moves every marker and deactivates
 *     the mark.
 *   - **Every structural mutation goes through `EmacsOps.setAll`**, and every one of them
 *     moves the mark the way a marker moves and deactivates the region. In Emacs that is not a
 *     property of the commands but of the buffer: `prepare_to_modify_buffer_1` in
 *     `src/insdel.c:2189` does `Fset (Qdeactivate_mark, Qt)`, so *any* change does it, and the
 *     same function's tail relocates point "as if it were a marker"
 *     (`src/insdel.c:1802-1810`). That is why the key that changes a character collects the
 *     region rather than the command after it, and why a mark set before a deletion still
 *     points at the same text afterwards.
 *   - **Cursor-only moves use `EmacsOps.setCursor` and are not undoable**, exactly as in
 *     `VimEngine`.
 *
 * Out of scope for this batch, deliberately: `.`/redo (Emacs has an undo stack and no redo
 * command, and this engine has neither yet), rectangle mode, `M-z` / `M-h`, the case commands
 * `M-u M-l M-c`, transpose, `C-o`, incremental search, `C-q`, and the rest of `ctl-x-map`.
 * Their keys are listed in {@link RESERVED_KEYS} and consumed without effect, so that they are
 * *this engine's* and cannot fall through to the host as something else.
 */

import { lineCount, lineEndExclusive, lineOf, lineStart, nthLineStart } from "./vim.ts";

// ---------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------

/**
 * The buffer operations this engine needs — a strict subset of `VimOps` (`vim.ts:142-153`),
 * declared here rather than imported.
 *
 * `VimOps` also carries `enterInsert` / `toNormal` (there is no mode to enter or leave),
 * `recallHistory` (Emacs's `C-n`/`C-p` are line motions; letting them double as prompt history
 * is a host decision, not an engine one) and `undo` / `redo` (`redo` has no command in Emacs at
 * all; `undo` is a later batch). Importing the wider interface would have made the host pass
 * five no-ops to express "I do not know what you mean", and would have let a caller wire
 * `recallHistory` into a command that does not exist.
 */
export interface EmacsOps {
	getText(): string;
	getCursor(): number;
	setCursor(pos: number): void;
	/** Every structural change. The host makes it one undo step. */
	setAll(text: string, cursor: number): void;
}

export interface EmacsKey {
	escape?: boolean;
	return?: boolean;
	ctrl?: boolean;
	meta?: boolean;
	tab?: boolean;
	home?: boolean;
	end?: boolean;
	/** `<backspace>` — the key a terminal also sends as `^?` or `^H`. `delete-backward-char`. */
	backspace?: boolean;
	/** `<deletechar>` — `delete-forward-char` (`bindings.el:1460`). */
	delete?: boolean;
	/** `[C-backspace]` and `M-DEL` — `backward-kill-word` (`bindings.el:1634`, `:1613`). */
	ctrlBackspace?: boolean;
	/** `[C-S-backspace]` — `kill-whole-line` (`bindings.el:1407`), Emacs's `dd`. */
	ctrlShiftBackspace?: boolean;
	// No terminal reaches the flag above. Ink's parser reports `ctrl` and
	// `backspace`, never the two together, and the sequence a terminal sends for
	// Ctrl+Shift+Backspace (`CSI 27;5;~` with modifyOtherKeys, or Escape plus the
	// erase character without it) is the same one `[M-DEL]` sends — so the host
	// cannot tell them apart, and a host that guessed would make `M-DEL` kill the
	// whole line. The engine implements the command and the host leaves the flag
	// unset; `C-w C-k C-k` and the other whole-line routes in the key legend are
	// what actually reach it. Setting this from a guess is the one change here
	// that would be worse than the gap.
	upArrow?: boolean;
	downArrow?: boolean;
	leftArrow?: boolean;
	rightArrow?: boolean;
}

// ---------------------------------------------------------------------------
// Command symbols (`last-command` / `this-command`)
// ---------------------------------------------------------------------------

/**
 * The command symbols this engine compares.
 *
 * Emacs compares with `eq`, which is symbol identity. In JS a bare string has the same effect
 * *if* one command has exactly one spelling, and the risk is a typo making two commands look
 * equal — `last-command` would read `kill-line` where it must be `kill-region`, and every
 * consecutive kill would chain. The set is closed and each name appears once, so string
 * equality is symbol equality here. {@link EmacsCommand} is widened to `string` because a
 * handful of commands are named but never compared (`beginning-of-line`, `forward-char`); the
 * ones that *are* compared are the constants below.
 *
 * `last-command` has two more values this model carries: `nil` (before a command runs, and
 * after a key that ran none) and `t`. The `t` is `yank`'s own sentinel (`simple.el:6451`), not
 * a decoration: `yank` sets `this-command` to `t` before it can fail and back to `'yank`
 * after it cannot, so a `yank` that dies half way leaves `last-command` as `t` and the next
 * `M-y` declines to rotate.
 */
const CMD = {
	killRegion: "kill-region",
	killWord: "kill-word",
	killLine: "kill-line",
	killWholeLine: "kill-whole-line",
	killRingSave: "kill-ring-save",
	yank: "yank",
	yankPop: "yank-pop",
	selfInsert: "self-insert-command",
	nextLine: "next-line",
	previousLine: "previous-line",
	moveBeginningOfLine: "move-beginning-of-line",
	moveEndOfLine: "move-end-of-line",
	setMarkCommand: "set-mark-command",
	popToMarkCommand: "pop-to-mark-command",
	exchangePointAndMark: "exchange-point-and-mark",
	forwardChar: "forward-char",
	backwardChar: "backward-char",
	forwardWord: "forward-word",
	backwardWord: "backward-word",
	beginningOfBuffer: "beginning-of-buffer",
	endOfBuffer: "end-of-buffer",
	deleteChar: "delete-char",
} as const;

/** Any command symbol. The ones this engine compares on are the {@link CMD} constants. */
export type EmacsCommand = string;

/** `last-command` / `this-command`: a symbol, `t`, or `nil`. */
export type EmacsCommandState = EmacsCommand | true | null;

// ---------------------------------------------------------------------------
// Prefix argument — four states, and two channels
// ---------------------------------------------------------------------------

/**
 * A cons whose `car` is the count. `C-u` is `(4)` (`simple.el:5571`), a second `C-u` makes it
 * `(16)` (`simple.el:5580`), and it is still a cons when the command that wanted a number gets
 * one.
 */
export interface EmacsPrefixList {
	car: number;
	cdr: number[];
}

/**
 * What `prefix-arg` can be, and **two channels, not one** — the distinction this whole section
 * exists for:
 *
 *   - `null` — no argument.
 *   - a number — what `(interactive "p")` produces, because `p` is `Fprefix_numeric_value`
 *     (`callint.c:651-655`). That is `prefix-numeric-value` applied, not the raw value: `p`
 *     **converts**.
 *   - `'-` — the *symbol*, from `negative-argument` (`simple.el:5591-5593`). Not -1.
 *   - a cons — what `(interactive "P")` produces, handed over untouched.
 *
 * The fourth state is not decoration. `yank` branches on it (`simple.el:6453-6456`), so a
 * single number channel would lose the difference between "`C-u C-y`, treat 4 as the count" and
 * "`C-u C-y`, this is a flag, put point at the front" — which is the observable in `yank`'s own
 * docstring: "Put point at the end, and set mark at the beginning without activating it. With
 * just \[universal-argument] as argument, put point at beginning, and mark at end"
 * (`simple.el:6406-6409`).
 *
 * The `^` in a spec like `"^p"` is **not** an argument modifier: it is `handle_shift_selection`
 * (`callint.c:407-408`), and the `p` behind it is still `Fprefix_numeric_value`. So
 * `backward-word` (`(interactive "^p")`, `simple.el:8959`) receives a **number**, and the
 * `(- '(4))` a plan written from memory predicts cannot happen from a keystroke.
 */
export type EmacsPrefixArg = null | number | "-" | EmacsPrefixList;

/** `prefix-numeric-value`: the count a `"p"` spec sees. */
export function emacsPrefixValue(arg: EmacsPrefixArg): number {
	if (arg === null) return 1;
	if (arg === "-") return -1;
	if (typeof arg === "number") return arg;
	return arg.car;
}

/**
 * Lisp's unary `-` over a prefix argument.
 *
 * A number negates; `'-` is `negative-argument`'s symbol and becomes -1; a cons keeps its `cdr`
 * and negates its `car`. So `(- '(4))` is a **one-element cons holding -4**, not a two-element
 * list — and from the keyboard nothing ever builds it, because `backward-word`'s `"^p"` hands
 * its body a plain number (`simple.el:8959-8960`). Exported so that the shape is checkable
 * rather than a comment: if a cons ever does reach `forward-word`, its `CHECK_FIXNUM`
 * (`src/syntax.c:1603`) is a real guard and not decoration, and this is the only place in the
 * engine that can produce one.
 */
export function emacsPrefixMinus(arg: EmacsPrefixArg): EmacsPrefixArg {
	if (arg === null) return null;
	if (arg === "-") return -1;
	if (typeof arg === "number") return -arg;
	return { car: -arg.car, cdr: arg.cdr };
}

/**
 * The `car` of a cons argument, or `null` — `kill-forward-chars`' first line
 * (`simple.el:6665`), which is the correct way to write what `backward-word` writes wrongly,
 * and the reading of `"p\nP"` that makes a prefix raw on the second channel.
 */
export function emacsPrefixCar(arg: EmacsPrefixArg): number | null {
	if (arg !== null && typeof arg === "object") return arg.car;
	return null;
}

/**
 * `kill-forward-chars` (`simple.el:6663-6667`) in full: collapse a cons to its `car`, turn `'-`
 * into -1, take the number itself otherwise. `delete-char`'s kill path (`src/cmds.c:258`) hands
 * it a *number*, so for the `C-d` and `C-h` paths this is the identity — but the prefix a user
 * typed arrives raw, so both clauses still matter.
 */
export function emacsPrefixForwardChars(arg: EmacsPrefixArg): number {
	const car = emacsPrefixCar(arg);
	if (car !== null) return car;
	return arg === "-" ? -1 : emacsPrefixValue(arg);
}

// ---------------------------------------------------------------------------
// Syntax: which characters are `Sword`
// ---------------------------------------------------------------------------

/**
 * Whether `cp` has word syntax, as the standard syntax table gives it.
 *
 * `init_syntax_once` (`src/syntax.c:3664-3744`) is short enough to transcribe whole, and the last
 * line is the one that matters most:
 *
 * ```text
 *   Sword         a-z A-Z 0-9, plus $ and %            syntax.c:3699-3708
 *   Ssymbol       _ - + * / & | < > =                  syntax.c:3727-3732
 *   Spunct        . , ; : ? ! # @ ~ ^ ' `              syntax.c:3734-3739
 *   Sword         0x80 .. MAX_CHAR, "All multibyte characters have syntax `word' by
 *                 default."                             syntax.c:3741-3743
 * ```
 *
 * That last line is the surprise: **every** multibyte character is a word constituent in a plain
 * text buffer. A mode's syntax table can take that away, but `fundamental-mode` does not, and
 * that is the table this engine has. So `$` and `%` are word characters here (they are `Sword`,
 * not punctuation), `_` and the other nine are `Ssymbol` and therefore *not*, and a space is
 * neither — which is why `foo_bar` is two words and `foo$bar` is one.
 */
export function emacsIsWordChar(cp: number): boolean {
	if (cp >= 0x80) return true;
	if (cp >= 0x30 && cp <= 0x39) return true; // 0-9
	if (cp >= 0x41 && cp <= 0x5a) return true; // A-Z
	if (cp >= 0x61 && cp <= 0x7a) return true; // a-z
	return cp === 0x24 || cp === 0x25; // $ and %
}

// ---------------------------------------------------------------------------
// Script: which characters share a `char-script-table` entry
// ---------------------------------------------------------------------------

const S_OTHER = 0;
const S_LATIN = 1;
const S_GREEK = 2;
const S_COPTIC = 3;
const S_CYRILLIC = 4;
const S_HEBREW = 5;
const S_ARABIC = 6;
const S_ARMENIAN = 7;
const S_DEVANAGARI = 8;
const S_THAI = 9;
const S_HAN = 10;
const S_KANA = 11;
const S_HANGUL = 12;
const S_BOPOMOFO = 13;
const S_KANBUN = 14;
const S_HALFWIDTH = 15;
const S_CJK_MISC = 16;
const S_SYMBOL = 17;
const S_NUMBER_FORM = 18;
const S_MATHEMATICAL = 19;

/**
 * `char-script-table`, which is what `word_boundary_p` compares (`src/category.c:383-384`).
 *
 * The table is **not** built from Unicode's `Scripts.txt`. It is *generated*: there is no
 * `lisp/international/charscript.el` in the tree, and `admin/unidata/blocks.awk` writes one at
 * build time from `Blocks.txt` and `emoji-data.txt` (`blocks.awk:276-277`). So the source of
 * truth for a reader of the tree is the awk script, which lumps blocks together *by language* —
 * which is why the names are `han` and `kana` and not `cjk` and `japanese`. Every row below is a
 * `Blocks.txt` line number, after `name2alias` (`blocks.awk:97-140`) and the hard-coded splits.
 *
 * Four things in that generator are load-bearing, and each is a row here:
 *
 *   - **`fix_start["0080"] = "00A0"`** (`blocks.awk:77`). Without it the C1 controls would
 *     inherit the `latin` of "Latin-1 Supplement" — and the name "C1 Controls and Latin-1
 *     Supplement" matches `/latin/`, which is exactly the bug the fix exists to stop. So
 *     0080..009F is unassigned and `latin` starts at 00A0.
 *   - **Hiragana and Katakana are one script here, not two.** `name2alias` sends both to `kana`
 *     (`blocks.awk:111`), the two blocks are adjacent so the "combine adjacent ranges with the
 *     same name" step (`blocks.awk:187-192`) merges them into one `3040..30FF kana` entry, and
 *     `word-separating-categories`' docstring says so in as many words: "to tell that there's a
 *     word boundary between Hiragana and Katakana (both are in the same script `kana'), the
 *     element `(?H . ?K)' should be in this list" (`src/category.c:481-482`). So `M-f` in `あア`
 *     does **not** stop between them, and a table with two buckets would be wrong.
 *   - **The `0370` split** (`blocks.awk:195-206`) cuts "Greek and Coptic" 0370..03FF into
 *     0370..03E1 `greek`, 03E2..03EF `coptic` and 03F0..03FF `greek`. The separate "Coptic"
 *     block at 2C80 is `coptic` by name (`blocks.awk:105`).
 *   - **The `FF00` split** (`blocks.awk:219-234`) gives FF00..FF60 its own alias, **FF61..FF9F
 *     `kana`**, FFA0..FFDF `hangul` and FFE0..FFEF `cjk-misc`, so a fullwidth Latin letter is a
 *     different script from an ASCII one and `M-f` stops between `a` and `ａ`. The `FB00` split
 *     (`blocks.awk:207-218`) likewise cuts "Alphabetic Presentation Forms" into `latin`,
 *     `armenian` and `hebrew`, and the `3300` split (`blocks.awk:156-165`) sends CJK
 *     Compatibility's first half to `kana`.
 *
 * **Every simplification in this table can only miss a boundary, never invent one**, and that is
 * the claim the two coarse buckets rest on:
 *
 *   - `S_OTHER` is one bucket for every block this table does not carry. Characters inside it are
 *     mutually boundary-free, which is right for emoji — the largest single case, since
 *     `blocks.awk:237-253` gives every `Emoji_Presentation` range one `emoji` script and
 *     `blocks.awk:264-273` overrides U+FE0F as well. So the visible cost is that `M-f` will not
 *     stop where Emacs stops *inside* a block not listed here, and 2600..26FF and 2700..27BF —
 *     where the emoji pass overrides half of each block — are deliberately left in `S_OTHER`
 *     rather than guessed at `symbol`, because guessing would *invent* boundaries inside them.
 *   - `S_SYMBOL` merges "Number Forms", "Box Drawing", "Block Elements" and the rest of the
 *     symbol-ish blocks, which `name2alias` gives distinct aliases. The cost is named rather
 *     than hidden: `M-f` will not stop between U+2160 (a Number Form) and U+2100 (a Letterlike
 *     Symbol), where Emacs would.
 */
const SCRIPT_INTERVALS: ReadonlyArray<readonly [number, number, number]> = [
	[0x0000, 0x007f, S_LATIN], // Blocks.txt:36  Basic Latin
	[0x00a0, 0x017f, S_LATIN], // :37 (fix_start 0080 -> 00A0, blocks.awk:77) + :38 Latin Extended-A
	[0x0180, 0x024f, S_LATIN], // :39 Latin Extended-B
	[0x02b0, 0x02ff, S_LATIN], // :41 Spacing Modifier Letters
	[0x0300, 0x036f, S_LATIN], // :42 Combining Diacritical Marks
	[0x0370, 0x03e1, S_GREEK], // :43 Greek and Coptic, truncated by blocks.awk:195-197
	[0x03e2, 0x03ef, S_COPTIC], // blocks.awk:198-201
	[0x03f0, 0x03ff, S_GREEK], // blocks.awk:202-205
	[0x0400, 0x052f, S_CYRILLIC], // :44 + :45, same alias, merged (blocks.awk:187-192)
	[0x0590, 0x05ff, S_HEBREW], // :47 Hebrew
	[0x0600, 0x06ff, S_ARABIC], // :48 Arabic
	[0x0750, 0x077f, S_ARABIC], // :50 Arabic Supplement
	[0x0870, 0x08ff, S_ARABIC], // :56 + :57, adjacent, merged
	[0x0900, 0x097f, S_DEVANAGARI], // :58 Devanagari
	[0x0e00, 0x0e7f, S_THAI], // :68 Thai
	[0x1100, 0x11ff, S_HANGUL], // :73 Hangul Jamo
	[0x1ab0, 0x1aff, S_LATIN], // :93 Combining Diacritical Marks Extended
	[0x1c80, 0x1c8f, S_CYRILLIC], // :99 Cyrillic Extended-C
	[0x1dc0, 0x1eff, S_LATIN], // :105 + :106, both alias `latin`, so merged
	[0x1f00, 0x1fff, S_GREEK], // :107 Greek Extended
	[0x2000, 0x20ff, S_SYMBOL], // :108-111, the last ending "for Symbols"
	[0x2100, 0x214f, S_SYMBOL], // :112 Letterlike Symbols
	[0x2150, 0x218f, S_NUMBER_FORM], // :113 Number Forms, its own alias
	[0x2190, 0x22ff, S_SYMBOL], // :114 Arrows + :115 Mathematical Operators
	[0x2300, 0x23ff, S_SYMBOL], // :116 Miscellaneous Technical
	[0x2460, 0x24ff, S_SYMBOL], // :119 Enclosed Alphanumerics
	[0x2500, 0x25ff, S_SYMBOL], // :120-122, merged (see the note above)
	[0x27f0, 0x27ff, S_SYMBOL], // :126 Supplemental Arrows-A
	[0x2900, 0x2bff, S_SYMBOL], // :128, :130, :131
	[0x2c60, 0x2c7f, S_LATIN], // :133 Latin Extended-C
	[0x2c80, 0x2cff, S_COPTIC], // :134 Coptic
	[0x2de0, 0x2dff, S_CYRILLIC], // :138 Cyrillic Extended-A
	[0x2e00, 0x2e7f, S_SYMBOL], // :139 Supplemental Punctuation
	[0x2e80, 0x2eff, S_HAN], // :140 CJK Radicals Supplement -> han
	[0x3000, 0x303f, S_HAN], // :143 CJK Symbols and Punctuation -> han
	[0x3040, 0x30ff, S_KANA], // :144 + :145, merged: ONE script, not two
	[0x3100, 0x312f, S_BOPOMOFO], // :146 Bopomofo (+ :149 Bopomofo Extended, same alias)
	[0x3130, 0x318f, S_HANGUL], // :147 Hangul Compatibility Jamo
	[0x3190, 0x319f, S_KANBUN], // :148 Kanbun
	[0x31c0, 0x31ef, S_HAN], // :150 CJK Strokes -> han
	[0x31f0, 0x31ff, S_KANA], // :151 Katakana Phonetic Extensions
	[0x3200, 0x32ff, S_HAN], // :152 Enclosed CJK Letters and Months -> han
	[0x3300, 0x3357, S_KANA], // :153, truncated by blocks.awk:156-160
	[0x3358, 0x33ff, S_HAN], // :153, the remainder
	[0x3400, 0x4dbf, S_HAN], // :154 CJK Unified Ideographs Extension A
	[0x4e00, 0x9fff, S_HAN], // :156 CJK Unified Ideographs
	[0xa640, 0xa69f, S_CYRILLIC], // :161 Cyrillic Extended-B
	[0xa700, 0xa7ff, S_LATIN], // :163 Modifier Tone Letters + :164 Latin Extended-D
	[0xa8e0, 0xa8ff, S_DEVANAGARI], // :169 Devanagari Extended
	[0xa960, 0xa97f, S_HANGUL], // :172 Hangul Jamo Extended-A
	[0xab30, 0xab6f, S_LATIN], // :180 Latin Extended-E
	[0xac00, 0xd7ff, S_HANGUL], // :183 + :184, adjacent, merged
	[0xf900, 0xfaff, S_HAN], // :189 CJK Compatibility Ideographs
	[0xfb00, 0xfb06, S_LATIN], // :190, truncated by blocks.awk:207-209
	[0xfb13, 0xfb17, S_ARMENIAN], // blocks.awk:210-212
	[0xfb1d, 0xfb4f, S_HEBREW], // blocks.awk:213-215
	[0xfb50, 0xfdff, S_ARABIC], // :191 Arabic Presentation Forms-A
	[0xfe20, 0xfe2f, S_LATIN], // :194 Combining Half Marks
	[0xfe30, 0xfe4f, S_HAN], // :195 CJK Compatibility Forms -> han
	[0xfe50, 0xfe6f, S_SYMBOL], // :196 Small Form Variants
	[0xfe70, 0xfeff, S_ARABIC], // :197 Arabic Presentation Forms-B
	[0xff00, 0xff60, S_HALFWIDTH], // :198, truncated by blocks.awk:219-221
	[0xff61, 0xff9f, S_KANA], // blocks.awk:222-224
	[0xffa0, 0xffdf, S_HANGUL], // blocks.awk:225-227
	[0xffe0, 0xffef, S_CJK_MISC], // blocks.awk:228-230
	[0x102e0, 0x102ff, S_COPTIC], // :208 Coptic Epact Numbers
	[0x10780, 0x107bf, S_LATIN], // :223 Latin Extended-F
	[0x10ec0, 0x10eff, S_ARABIC], // :248 Arabic Extended-C
	[0x11b00, 0x11b5f, S_DEVANAGARI], // :282 Devanagari Extended-A
	[0x1d400, 0x1d7ff, S_MATHEMATICAL], // :340 Mathematical Alphanumeric Symbols
	[0x1df00, 0x1dfff, S_LATIN], // :343 Latin Extended-G
	[0x1e030, 0x1e08f, S_CYRILLIC], // :345 Cyrillic Extended-D
	[0x20000, 0x2a6df, S_HAN], // :374 CJK Unified Ideographs Extension B
	[0x2a700, 0x2ee5f, S_HAN], // :375-379, adjacent, merged
	[0x2f800, 0x2fa1f, S_HAN], // :380 CJK Compatibility Ideographs Supplement
	[0x30000, 0x323af, S_HAN], // :381 + :382, adjacent, merged
];

/**
 * The script `cp` belongs to. Exported for the same reason `codePointClass` is exported in
 * `vim.ts:455`: a hand-built table is not something a handful of word motions can vouch for, and
 * this one is read off two generated files rather than off Emacs's own comments.
 */
export function emacsScriptOf(cp: number): number {
	let lo = 0;
	let hi = SCRIPT_INTERVALS.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const iv = SCRIPT_INTERVALS[mid];
		if (cp < iv[0]) hi = mid - 1;
		else if (cp > iv[1]) lo = mid + 1;
		else return iv[2];
	}
	return S_OTHER;
}

/**
 * `word_boundary_p` (`src/category.c:376-406`) with both of its exception lists at their
 * defaults — `word-combining-categories` is `Qnil` (`src/category.c:485`) and
 * `word-separating-categories` is `Qnil` (`src/category.c:491`). That collapses the whole
 * function to one comparison: the two characters are in the same `char-script-table` slot, so
 * `default_result` is 0, and both per-category loops then find an empty list to walk. **Same
 * script, no boundary; different script, boundary.** In `foo中文bar` that puts three words where
 * a Latin-only reader expects two, and `M-f` stops at 3, then 5, then 8.
 *
 * The category 5 that `charscript.el` gives every `symbol` character (`blocks.awk:296-300`)
 * reaches this function as `CATEGORY_SET`, and with both lists nil it cannot change the answer —
 * which is why this table has no category dimension.
 */
function emacsWordBoundary(c1: number, c2: number): boolean {
	return emacsScriptOf(c1) !== emacsScriptOf(c2);
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/**
 * One Emacs character forward: a whole code point, a surrogate pair included.
 *
 * **This is not `vim.ts`'s `nextChar`, and the difference is the point.** `nextChar` steps a
 * *grapheme cluster*: after a base character it also steps over any combining marks
 * (`markWidthAt`, `vim.ts:557-563`, returns 1 or 2 for U+0300 and up). Emacs's `forward-char` is
 * `move_point`, i.e. `PT + N` validated (`cmds.c:36-67`) — one code point per unit, so a combining
 * mark has a position of its own and `M-f` can stop on it. Importing `nextChar` would have made
 * `C-f` take fewer keystrokes than Emacs over `e` + U+0301, which is the whole reason this function
 * exists.
 *
 * The line-navigation helpers (`lineStart` / `lineEndExclusive` / `lineOf` / `nthLineStart` /
 * `lineCount`, `vim.ts:730-767`) *are* shared: they are token-free and are exactly
 * `line-beginning-position`, `line-end-position` and `forward-line`.
 */
function advance(text: string, pos: number): number {
	if (pos >= text.length) return text.length;
	const cp = text.codePointAt(pos);
	if (cp === undefined) return pos + 1;
	return pos + (cp > 0xffff ? 2 : 1);
}

/** One Emacs character backward — the mirror, and a surrogate pair is one step. */
function retreat(text: string, pos: number): number {
	if (pos <= 0) return 0;
	const code = text.charCodeAt(pos - 1);
	if (code >= 0xdc00 && code <= 0xdfff && pos >= 2) {
		const high = text.charCodeAt(pos - 2);
		if (high >= 0xd800 && high <= 0xdbff) return pos - 2;
	}
	return pos - 1;
}

/** The code point at `pos`, read as a whole one even if it takes two units. */
function codePointAt(text: string, pos: number): number {
	if (pos < 0 || pos >= text.length) return -1;
	return text.codePointAt(pos) ?? -1;
}

// ---------------------------------------------------------------------------
// Word motion
// ---------------------------------------------------------------------------

/**
 * `scan_words` forward (`src/syntax.c:1475-1523`) with `words-include-escapes` at its default
 * `nil`, so the `Sescape`/`Scharquote` clauses drop out and the first loop is a bare `Sword` test.
 * This is `Fforward_word` (`src/syntax.c:1581-1616`).
 *
 * A word is a maximal run of `Sword` characters with no `word_boundary_p` between neighbours, and
 * forward motion ends *at* the end of the run rather than past it: the inner loop breaks on the
 * first character that fails **without consuming it** (`src/syntax.c:1506-1521`).
 *
 * Two details are the whole reason this is transcribed rather than borrowed from
 * `motionForwardWord` (`vim.ts:1201`):
 *
 *   - the first loop **skips** everything that is not `Sword` and stops *on* the first one that
 *     is (`src/syntax.c:1477-1491`). So the `-` in `foo-bar` is skipped over rather than landed
 *     on, and a run of punctuation is not a word at all — the opposite of vim, where a punctuation
 *     run is a word of its own.
 *   - running off either edge returns the buffer's edge rather than the position it reached:
 *     `if (from == end) return 0;` (`src/syntax.c:1479-1480`) becomes `val = arg > 0 ? ZV :
 *     BEGV` in `Fforward_word` (`src/syntax.c:1605-1607`).
 */
export function emacsWordForward(text: string, pos: number, count = 1): number {
	let from = pos;
	for (let n = 0; n < count; n++) {
		// Skip forward to the first word-constituent character, and remember it: the inner
		// loop compares every later character against it, not against the one before it.
		let ch0 = -1;
		while (from < text.length) {
			ch0 = codePointAt(text, from);
			from = advance(text, from);
			if (ch0 >= 0 && emacsIsWordChar(ch0)) break;
			ch0 = -1;
		}
		if (ch0 < 0) return text.length;
		for (;;) {
			if (from >= text.length) break;
			const ch1 = codePointAt(text, from);
			if (!emacsIsWordChar(ch1) || emacsWordBoundary(ch0, ch1)) break;
			ch0 = ch1;
			from = advance(text, from);
		}
	}
	return from;
}

/**
 * `scan_words` backward (`src/syntax.c:1524-1576`), which is the same word found from the other
 * end, landing on its **first** character.
 *
 * That landing is the `inc_both` on the way out of the inner loop (`src/syntax.c:1555-1573`):
 *
 * ```c
 *   dec_both (&from, &from_byte);
 *   ch0 = FETCH_CHAR_AS_MULTIBYTE (from_byte);
 *   if ((code != Sword && ...) || word_boundary_p (ch0, ch1))
 *     { inc_both (&from, &from_byte); break; }   // step back over it
 * ```
 *
 * `dec_both` has just moved point *onto* the boundary character and `inc_both` undoes that.
 * Without the step the loop would leave point on the last character of the *preceding* run — a
 * space, say — so `M-b M-b` from the end of `foo bar` would land on the space rather than on `b`.
 * The two halves are easy to write the same shape and get opposite results, which is the only
 * place in this file where a "harmless simplification" would be visible in behaviour.
 */
export function emacsWordBackward(text: string, pos: number, count = 1): number {
	let from = pos;
	for (let n = 0; n < count; n++) {
		// Step back onto the last word-constituent character at or before `from`.
		let ch1 = -1;
		while (from > 0) {
			from = retreat(text, from);
			ch1 = codePointAt(text, from);
			if (ch1 >= 0 && emacsIsWordChar(ch1)) break;
			ch1 = -1;
		}
		if (ch1 < 0) return 0;
		for (;;) {
			if (from <= 0) break;
			const prev = retreat(text, from);
			const ch0 = codePointAt(text, prev);
			// The `inc_both` before this `break` is expressed by *not* taking `prev`.
			if (!emacsIsWordChar(ch0) || emacsWordBoundary(ch0, ch1)) break;
			from = prev;
			ch1 = ch0;
		}
	}
	return from;
}

/**
 * `camelCase` is deliberately **not** a rule here.
 *
 * `find-word-boundary-function-table` is the hook that would make it one, and it is consulted by
 * `scan_words` in place of `word_boundary_p` (`src/syntax.c:1494-1504` forward, `:1543-1552`
 * backward) — a per-character table, so a buffer can have one rule for `c` and another for `o`.
 * `subword-mode` is what installs into it (`lisp/progmodes/subword.el:320-336` — note the path:
 * `progmodes/`, not `lisp/`), and `backward-word`'s docstring says exactly what that means: "The
 * word boundaries are normally determined by the buffer's syntax table and character script
 * (according to `char-script-table'), but `find-word-boundary-function-table', such as set up by
 * `subword-mode', can change that" (`simple.el:8952-8958`).
 *
 * This engine does not install it, and the reason is not that subword support is out of scope —
 * it is that welding it in would make `M-f` *wrong* for the two cases the script rule exists to
 * get right. `"foo中文bar"` would stop at the `c`-to-`中` script change anyway, and
 * `"foo-barBar"` would be one word where Emacs says three, because Emacs's own boundary is the
 * syntax table plus the script and nothing else. A user who wants subword motion can have it by
 * turning on a mode; they cannot have it by it happening.
 */

// ---------------------------------------------------------------------------
// Reserved keys — later batches
// ---------------------------------------------------------------------------

/**
 * Keys Emacs binds, that this batch does not implement, and that are consumed anyway. The
 * contract for a modeless engine is "unbound means yours", so a bound-but-unimplemented key has to
 * be swallowed: letting `C-t` fall through would hand the host a keypress the user believes is
 * transpose, and letting `M-x` fall through would hand it a bare Escape-prefixed letter.
 *
 * Each entry is `(key, the command waiting for it)`, so the next batch is a list edit rather than
 * an archaeology exercise. `C-x`-prefixed keys live in {@link CTL_X_RESERVED}, because the `C-x`
 * prefix is read before they are.
 *
 * The cost of an unimplemented command is nil: `command_loop_1` sets `this-command` to `Qnil` for
 * a key sequence that ran no command (`src/keyboard.c:1416-1417`) and only commits `last-command`
 * after one has run (`src/keyboard.c:1579-1580`). Both of this engine's `last-command` consumers —
 * the kill chain and the goal-column stickiness — test membership against two specific symbols, so
 * `nil` breaks each exactly as a real command like `transpose-chars` would.
 *
 * Two keys are deliberately **absent** from this list, because a list entry that cannot be reached
 * is a lie:
 *
 *   - `.` is `#o056`, inside the `self-insert-command` range, so `#isSelfInsert` claims it before
 *     the reserved lookup is ever consulted and it reaches the host as text. That is right: in
 *     this tree `bindings.el` binds the literal `.` in exactly one place, `ctl-x-map` as
 *     `set-fill-prefix` (`bindings.el:1706`), and in no mode map at all — so "Emacs binds `.`" is
 *     false. That one `C-x` member is the reason `CTL_X_RESERVED` is a list of the members worth
 *     recording rather than a transcription of the map: an unlisted member is still consumed and
 *     dropped, it simply leaves no note.
 *   - `C-m` is Enter, and a terminal sends it as `\r` with `key.return` set. `#dispatch` returns
 *     `false` for `key.return` before any of this, so a `C-m` entry could never fire. See the
 *     `key.return` branch.
 */
export const RESERVED_KEYS: ReadonlyArray<readonly [string, string]> = [
	["C-t", "transpose-chars (bindings.el:1596)"],
	["M-t", "transpose-words (bindings.el:1597)"],
	["C-M-t", "transpose-sexps (bindings.el:1598)"],
	["C-q", "quoted-insert (bindings.el:1230)"],
	["C-o", "open-line (bindings.el:1228)"],
	["M-o", "split-line (bindings.el:1229)"],
	["C-g", "keyboard-quit (bindings.el:1221)"],
	["M-z", "zap-to-char (bindings.el:1236)"],
	["M-h", "mark-paragraph (bindings.el:1710)"],
	["M-@", "mark-word (bindings.el:1609)"],
	["M-u", "upcase-word (subr.el:1717)"],
	["M-l", "downcase-word (subr.el:1718)"],
	["M-c", "capitalize-word (subr.el:1719)"],
	["M-x", "execute-extended-command (subr.el:1720)"],
	["M-X", "execute-extended-command-for-buffer (subr.el:1721)"],
	["M-\\", "delete-horizontal-space (bindings.el:1618)"],
	["M-{", "backward-paragraph (bindings.el:1708)"],
	["M-}", "forward-paragraph (bindings.el:1709)"],
	["M-q", "fill-paragraph (bindings.el:1705)"],
	["M-a", "backward-sentence (bindings.el:1711)"],
	["M-e", "forward-sentence (bindings.el:1712)"],
	["C-s", "isearch-forward (isearch.el:1000)"],
	["C-r", "isearch-backward (isearch.el:1002)"],
	["M-C-s", "isearch-forward-regexp (isearch.el:1001)"],
	["M-C-r", "isearch-backward-regexp (isearch.el:1003)"],
	["M-s", "search-map (bindings.el:1383)"],
	["M-=", "count-words-region (bindings.el:1237)"],
];

/**
 * The members of `ctl-x-map` that are bound but not implemented.
 *
 * Nothing reads this at run time — a `C-x` sequence whose second key is not `C-x` is consumed and
 * dropped whatever it is (`#dispatch`), so a member being *listed* changes no behaviour. It is
 * exported for the two things that do need the list and cannot get it from the engine: the host's
 * key-legend overlay, and the batch that implements them, which should delete entries here as it
 * takes them rather than leaving a table that drifts from the switch.
 */
export const CTL_X_RESERVED: ReadonlyArray<readonly [string, string]> = [
	["t", "transpose-lines (bindings.el:1599)"],
	["C-@", "pop-global-mark (bindings.el:1339)"],
	["C-SPC", "pop-global-mark (bindings.el:1341)"],
	[" ", "rectangle-mark-mode (bindings.el:1340)"],
	["n", "set-goal-column (bindings.el:1345)"],
	["g", "unset-goal-column (bindings.el:1344)"],
	["h", "mark-whole-buffer (bindings.el:1617)"],
	["=", "what-cursor-position (bindings.el:1238)"],
	["o", "delete-blank-lines (bindings.el:1234)"],
	["r", "ctl-x-r-map (bindings.el:1703)"],
];

/**
 * The token a key is filed under, so ctrl and meta are part of the name. Only the keys that reach
 * {@link RESERVED_KEYS} are tokenised; everything else is dispatched by the control/meta switches
 * directly. Meta is tested first so that `C-M-t` gets its own name rather than collapsing onto
 * `C-t`.
 */
export function emacsKeyToken(input: string, key: EmacsKey): string {
	if (key.meta) return key.ctrl ? `C-M-${input}` : `M-${input}`;
	if (key.ctrl) {
		if (input === " ") return "C-SPC";
		if (input === "@") return "C-@";
		return `C-${input}`;
	}
	return input;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** `kill-ring-max` is 120 in this tree (`simple.el:5720-5724`, `:version '29.1`). */
const KILL_RING_MAX = 120;

/** `mark-ring-max` is 16 (`simple.el:7410-7413`). */
const MARK_RING_MAX = 16;

/**
 * `(skip-chars-forward " \t" end)` collapsed to a predicate on the text between point and the end
 * of the line, which is the one thing `kill-line`'s no-argument branch tests
 * (`simple.el:6813-6821`). No `g` flag, so `test` carries no state between calls.
 */
const BLANK_RE = /^[\t ]*$/;

export class EmacsEngine {
	/** The mark's position, or `null` when no mark is set. Deactivation never clears it. */
	mark: number | null = null;
	/**
	 * `mark-active`. A field rather than a test on {@link mark}, because `region-active-p` is
	 * three conditions (`simple.el:7272-7277`): Transient Mark mode is on, `mark-active` is set,
	 * *and* a mark is actually set. This host is always in Transient Mark mode, so the two that
	 * are left are both modelled.
	 */
	markActive = false;
	/** `mark-ring`, for the local half of `pop-to-mark-command` (`simple.el:7553-7561`). */
	markRing: number[] = [];
	/** `kill-ring`, newest first — the `car` is the latest kill. */
	killRing: string[] = [];

	#ops: EmacsOps;
	/**
	 * `kill-ring-yank-pointer`, as an index into {@link killRing}. The variable in Emacs is a
	 * *tail* of the list rather than a subscript; see {@link #currentKill} for why an index
	 * computes the same thing.
	 */
	#yankPointer = 0;
	#lastCommand: EmacsCommandState = null;
	#thisCommand: EmacsCommandState = null;
	/**
	 * `prefix-arg`, raw and in all four of its states. A `"p"` command reads
	 * {@link emacsPrefixValue} of it; a `"P"` command reads it unchanged.
	 *
	 * The lifetime is the subtle part. `command_loop_1` clears the variable once, at its top,
	 * **before** the `while (true)` loop that reads key sequences (`src/keyboard.c:1323` vs
	 * `:1357`) — not once per key. A `C-u 4 C-f` sequence is a single pass of that loop, because
	 * `set-transient-map` makes `read_key_sequence` keep reading, so the `(4)` survives every key
	 * of the sequence. Modelled here by {@link #prefixArgLive}: a prefix key sets it, and the next
	 * `handleKey` clears the argument only if no prefix key preceded it.
	 */
	#prefixArg: EmacsPrefixArg = null;
	#prefixArgLive = false;
	/** `universal-argument-map` is open — `set-transient-map` in `universal-argument--mode`. */
	#prefixPending = false;
	/** `ctl-x-map` is open. Only `C-x C-x` is implemented; the rest is read and dropped. */
	#ctlXPending = false;
	/** `temporary-goal-column`: the column the current run of vertical motion returns to. */
	#temporaryGoalColumn = 0;
	/** Where the host's next write will start — `VimEngine`'s `#typedFrom`, `vim.ts:2499`. */
	#typedFrom: number | null = null;
	#typedFromText = "";
	/** False while a key sequence is unfinished or a command signalled: nothing is committed. */
	#commit = true;

	constructor(ops: EmacsOps) {
		this.#ops = ops;
	}

	/** `last-command` — the reason a kill chain is a chain. */
	get lastCommand(): EmacsCommandState {
		return this.#lastCommand;
	}

	/** `prefix-arg`, raw. `C-u`'s count and `C-u C-y`'s flag are the same field. */
	get prefixArg(): EmacsPrefixArg {
		return this.#prefixArg;
	}

	/** `temporary-goal-column`: where the current run of vertical motion is aiming. */
	get temporaryGoalColumn(): number {
		return this.#temporaryGoalColumn;
	}

	/** `kill-ring-yank-pointer` as the index {@link #currentKill} is standing on. */
	get yankPointer(): number {
		return this.#yankPointer;
	}

	// -- entry point ---------------------------------------------------------

	/**
	 * Handle one key event. Returns true when consumed.
	 *
	 * A key this engine does not own returns `false` and the host does whatever it would have
	 * done anyway — which, for a printable character, is insert it.
	 */
	handleKey(input: string, key: EmacsKey): boolean {
		// The host may have written to the buffer since the last key, and if it did that is two
		// facts Emacs's command loop would have handed over for free: the last command was
		// `self-insert-command`, and the buffer was modified — which moves every marker and
		// deactivates the mark.
		this.#reconcileTyped();

		if (!this.#prefixArgLive) this.#prefixArg = null;
		this.#prefixArgLive = false;

		// `command_loop_1` sets `Vthis_command` to `Qnil` for every key sequence before it looks
		// for a command (`src/keyboard.c:1416-1417`).
		this.#thisCommand = null;
		this.#commit = true;

		const consumed = this.#dispatch(input, key);

		// `command_loop`'s tail: after a command, `last-command` is whatever `this-command`
		// ended up being (`src/keyboard.c:1579-1580`). An unfinished key sequence runs no
		// command, and a signal leaves the tail unreached, so neither commits.
		if (this.#commit) this.#lastCommand = this.#thisCommand;
		return consumed;
	}

	#dispatch(input: string, key: EmacsKey): boolean {
		// Enter and Escape are the host's, and they are checked *before* the transient maps for a
		// reason: a map's whole design is that a key it does not recognise is swallowed, and a REPL
		// user who hits Escape to interrupt does not mean "discard the `C-x` I typed". In Emacs
		// the same situation reads `C-x ESC`, which `esc-map` does not have a member for, so it
		// rings the bell rather than dropping the key; declining it is the closer match to what
		// the host is going to do with it.
		//
		// No command runs in either case, so the tail of `handleKey` must not reach
		// `kset_last_command` (`src/keyboard.c:1579`). That is a deviation worth naming: Emacs
		// binds Enter to `newline` (`bindings.el:1227`), and a real `newline` *is* a command and
		// would have broken the kill chain. Here the host takes the key, and the next
		// `#reconcileTyped` decides what ran in between.
		if (key.return) {
			this.#prefixPending = false;
			this.#ctlXPending = false;
			this.#commit = false;
			return false;
		}
		if (key.escape) {
			// There is no mode to leave and no line to abandon, so popping the pending maps is
			// all Escape can do here, and returning false leaves the REPL's own Escape (interrupt)
			// alone — the same reasoning `VimEngine` gives.
			this.#prefixPending = false;
			this.#ctlXPending = false;
			this.#commit = false;
			return false;
		}

		// The transient prefix map is open: `C-u`, a digit and `-` are read here
		// (universal-argument-map, simple.el:5518-5553) and nowhere else, until a key that is
		// none of those ends it. The argument itself survives — only the map pops.
		if (this.#prefixPending) {
			if (this.#prefixKey(input, key)) return true;
			this.#prefixPending = false;
		}

		if (this.#ctlXPending) {
			// `C-x C-x` is `exchange-point-and-mark` (`bindings.el:1338`) and the only
			// implemented member. Anything else in the map is *read and dropped*: the key is
			// consumed so the user is not typing into the prompt, and no command runs — which
			// is what `this_command` = `Qnil` means (`src/keyboard.c:1416`), and `last-command`
			// becomes `nil`, breaking a kill chain and re-seeding the goal column exactly as any
			// other non-kill command would.
			this.#ctlXPending = false;
			if (key.ctrl && input === "x") return this.#exchangePointAndMark();
			this.#commit = true;
			return true;
		}
		if (key.ctrl && input === "x") {
			// `global-map` maps `C-x` to `Control-X-prefix` (`subr.el:1762`), a prefix key: the
			// sequence is not finished, so no command has run.
			this.#ctlXPending = true;
			this.#commit = false;
			return true;
		}

		if (this.#handleNamed(input, key)) return true;

		// A plain character: `subr.el:1764-1771` binds `self-insert-command` to `\C-i` and to
		// every code point from `#o040` to `#o0177`. Not consuming it is the whole of that
		// command here; the commit at the tail leaves `last-command` = nil, which
		// `#reconcileTyped` repairs into `self-insert-command` once the host has written.
		if (this.#isSelfInsert(input, key)) {
			this.#typedFrom = this.#ops.getCursor();
			this.#typedFromText = this.#ops.getText();
			return false;
		}

		const token = emacsKeyToken(input, key);
		if (RESERVED_KEYS.some(([t]) => t === token)) return true;
		return false;
	}

	// -- the host's own writing ----------------------------------------------

	/**
	 * Read back whatever the host inserted since the last key, and charge it to
	 * `self-insert-command`.
	 *
	 * `VimEngine` does this in insert mode at the Escape (`vim.ts:2564-2567`). There is no Escape
	 * here to do it at, so it happens at the start of the next key instead — same information,
	 * one key later.
	 *
	 * The mark handling is the reason this is not just bookkeeping. `self-insert-command` modifies
	 * the buffer, and Emacs's marks are markers, so one after the insertion point shifts by the
	 * length inserted and one before it does not; and `prepare_to_modify_buffer_1`
	 * (`src/insdel.c:2189`) deactivates the mark for **every** modification, so the region a user
	 * built with `C-SPC` is gone the moment they type into it. No command in this batch says so;
	 * the buffer says it.
	 */
	#reconcileTyped(): void {
		if (this.#typedFrom === null) return;
		const from = this.#typedFrom;
		const before = this.#typedFromText;
		this.#typedFrom = null;
		const text = this.#ops.getText();
		const pos = this.#ops.getCursor();
		if (text === before && pos === from) return;
		if (text.length > before.length && text.slice(0, from) === before.slice(0, from)) {
			this.#adjustMark(from, from, pos);
		}
		// `last-command` and not `this-command`: the self-insert ran *between* the two keys, so
		// it is the command before the one being dispatched now. Getting this backwards would
		// charge the command being dispatched with the self-insert's state and quietly break
		// every kill chain that follows a keystroke.
		this.#lastCommand = CMD.selfInsert;
		this.markActive = false;
	}

	/**
	 * Move a marker across a replacement, the way `adjust_marker_positions` and the "Relocate
	 * point as if it were a marker" tail of `del_range_1` (`src/insdel.c:1802-1810`) do.
	 *
	 * `[from, oldEnd)` of the old text became `[from, newEnd)` of the new. A marker at or before
	 * `from` does not move; one inside the replaced span collapses to `from`; one after it shifts
	 * by the length change. A marker sitting exactly at an insertion point stays *before* the
	 * inserted text, which is why the first test is `<=` and not `<` — `yank` pushes the mark to
	 * point and then inserts there, and the mark must stay at the front of what it just pasted.
	 * Both ends of a deleted span collapse onto its start, which is what `kill-whole-line`'s
	 * two-step relies on.
	 */
	#adjustMark(from: number, oldEnd: number, newEnd: number): void {
		if (this.mark === null) return;
		const p = this.mark;
		if (p <= from) return;
		this.mark = p < oldEnd ? from : p + (newEnd - oldEnd);
	}

	/**
	 * Whether the host will insert this key as text — the `self-insert-command` range,
	 * `subr.el:1771`. Only keys in it arm `#typedFrom`: every other key that goes unconsumed
	 * (Enter, a host shortcut) either writes nothing or writes the prompt's own way, and arming
	 * the marker for those would charge a `self-insert-command` that never happened.
	 *
	 * Tab is inside Emacs's range (`subr.el:1764` binds `\C-i` to `self-insert-command`) and
	 * excluded here, because in a prompt field it is completion, which is the host's to own. So
	 * are the arrow keys, which Emacs binds per terminal (`lisp/term/`) and which this engine
	 * leaves alone.
	 */
	#isSelfInsert(input: string, key: EmacsKey): boolean {
		if (key.ctrl || key.meta || key.tab) return false;
		if (key.home || key.end || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return false;
		if (key.backspace || key.delete || key.ctrlBackspace || key.ctrlShiftBackspace) return false;
		if (input.length === 0) return false;
		const cp = input.codePointAt(0) ?? 0;
		// `#o040` .. `#o0177`, verbatim: every printable character a terminal sends, and nothing
		// else.
		return cp >= 0o040 && cp <= 0o0177;
	}

	// -- named keys ----------------------------------------------------------

	#handleNamed(input: string, key: EmacsKey): boolean {
		if (key.ctrlShiftBackspace) {
			// `[C-S-backspace]` is `kill-whole-line` (`bindings.el:1407`) — Emacs's `dd`. It is
			// not `C-u C-k`; see the header.
			this.#beginCommand(CMD.killWholeLine);
			this.#killWholeLine(emacsPrefixValue(this.#prefixArg));
			return true;
		}
		if (key.ctrlBackspace) {
			// `[C-backspace]` (`bindings.el:1634`) and `M-DEL` (`bindings.el:1613`) are both
			// `backward-kill-word`, whose spec is `"p"` and whose whole body is
			// `(kill-word (- arg))` (`simple.el:9003-9007`).
			this.#beginCommand(CMD.killWord);
			this.#killWord(-emacsPrefixValue(this.#prefixArg));
			return true;
		}
		if (key.backspace && !key.ctrl) {
			// `<backspace>` is `delete-backward-char`, which the terminal also sends as `^?` — and
			// that is the byte Emacs binds (`bindings.el:1318` binds `"\177"`). The same key
			// arrives as `^H` on some terminals, so both spellings land here.
			return this.#deleteBackwardChar();
		}
		if (key.delete && !key.ctrl) {
			// `<deletechar>` is `delete-forward-char` (`bindings.el:1460`).
			return this.#deleteForwardChar();
		}
		if (key.home && !key.ctrl && !key.meta) {
			// `[home]` is `move-beginning-of-line` (`bindings.el:1408`).
			return this.#moveBeginningOfLine();
		}
		if (key.end && !key.ctrl && !key.meta) {
			return this.#moveEndOfLine();
		}

		// **Meta first.** A terminal reports `M-C-w` as one event with both flags, but Emacs
		// resolves the meta bit by looking `meta_prefix_char` — ESC — up in the *current* map
		// and, if that yields a keymap, switching to it and **clearing the meta bit from the
		// index** (`src/keymap.c:344-361`, `map = event_meta_map; idx = … & ~meta_modifier`).
		// So `M-C-w` is `esc-map`'s `[?\C-w]` — `append-next-kill` (`bindings.el:1329`) — and
		// only if `esc-map` had no binding would it fall through to `global-map`'s `[?\C-w]`,
		// which is `kill-region` (`bindings.el:1327`): a different command with the opposite
		// effect on the ring. Testing `ctrl` first picks the wrong one every time.
		if (key.meta) return this.#handleMeta(input, key);
		if (key.ctrl) return this.#handleCtrl(input);
		return false;
	}

	#handleCtrl(input: string): boolean {
		// `esc-map` binds the control digits to `digit-argument` (`bindings.el:1311-1314`), and
		// a terminal sends `C-1` as 0x31..0x39 with the control flag set.
		if (input >= "0" && input <= "9") {
			this.#digitArgument(input.charCodeAt(0) - 0x30);
			return true;
		}
		switch (input) {
			// `C-u` is `universal-argument` (`bindings.el:1298`). It does nothing by itself: it
			// sets `prefix-arg` and opens the transient map, and the *next* key is the one that
			// runs.
			case "u":
				this.#universalArgument();
				return true;
			// `C-@` and `C-SPC` are both `set-mark-command` (`bindings.el:1333` and `:1335` —
			// "Many people are used to typing C-SPC and getting C-@").
			case "@":
			case " ":
				return this.#setMarkCommand();
			case "a":
				return this.#moveBeginningOfLine();
			case "e":
				return this.#moveEndOfLine();
			case "f":
				this.#beginCommand(CMD.forwardChar);
				this.#forwardChar(emacsPrefixValue(this.#prefixArg));
				return true;
			case "b":
				this.#beginCommand(CMD.backwardChar);
				this.#backwardChar(emacsPrefixValue(this.#prefixArg));
				return true;
			case "n":
				// `next-line` (`bindings.el:1343`) and `previous-line` (`:1344`), both through
				// `line-move-1`.
				this.#beginCommand(CMD.nextLine);
				this.#lineMove(true, emacsPrefixValue(this.#prefixArg));
				return true;
			case "p":
				this.#beginCommand(CMD.previousLine);
				this.#lineMove(false, emacsPrefixValue(this.#prefixArg));
				return true;
			// `delete-char` (`bindings.el:1324`) and **not** `delete-forward-char`, and the reason
			// is written out in the file: "We explicitly want C-d to use `delete-char' instead
			// of `delete-forward-char' so that it ignores `delete-active-region'"
			// (`bindings.el:1319-1323`). So `C-d` never collects the region, and it is
			// `delete-active-region` (not `use-region-p`) that a `C-d` user is being protected
			// from.
			case "d":
				this.#beginCommand(CMD.deleteChar);
				this.#runDeleteChar(
					emacsPrefixValue(this.#prefixArg),
					this.#prefixArg !== null,
					emacsPrefixForwardChars(this.#prefixArg),
				);
				return true;
			// `\C-?` is `delete-backward-char` (`bindings.el:1318`). `C-h` is *not bound at
			// all* in `global-map` in this tree — it is a `key-translate` alias, swapped with
			// `DEL` for a terminal whose normal erase key is `C-h` (`simple.el:11239-11251`),
			// which is why pressing Backspace in a terminal Emacs runs this command. It is
			// `mark-defun` in `esc-map` only (`bindings.el:1666`), and no terminal sends
			// meta+`C-h` as one event, so routing `^H` to the Backspace command reproduces what
			// a real Emacs does with the key rather than what its keymap literally says.
			case "h":
			case "?":
				return this.#deleteBackwardChar();
			case "y":
				// `yank` (`bindings.el:1330`). Its spec is `"*P"` — raw.
				this.#beginCommand(CMD.yank);
				this.#yank(this.#prefixArg);
				return true;
			case "k":
				// `kill-line` (`bindings.el:1326`), spec `"P"` — raw, and *not* the same as a
				// number: 0 is not nil, so `C-0 C-k` takes the argument branch and kills the
				// text *before* point.
				this.#beginCommand(CMD.killLine);
				this.#killLine(this.#prefixArg);
				return true;
			case "w":
				return this.#killRegionCommand();
			// `[?\C--]` and `[?\C-\M--]` are both `negative-argument` (`bindings.el:1309` and
			// `:1315`); a terminal sends `M--` as `C-_` when there is no meta prefix to send.
			case "-":
			case "_":
				this.#negativeArgument();
				return true;
			default:
				return false;
		}
	}

	#handleMeta(input: string, key: EmacsKey): boolean {
		if (key.ctrl) {
			// `esc-map` binds `\C-w` to `append-next-kill` (`bindings.el:1329`).
			if (input === "w") {
				this.#appendNextKill();
				return true;
			}
			return false;
		}
		switch (input) {
			case "f":
				// `forward-word` (`bindings.el:1610`).
				this.#beginCommand(CMD.forwardWord);
				this.#ops.setCursor(this.#forwardWord(emacsPrefixValue(this.#prefixArg)));
				return true;
			case "b":
				// `backward-word` (`bindings.el:1611`), spec `"^p"` — see {@link EmacsPrefixArg}
				// for why what arrives is a number.
				this.#beginCommand(CMD.backwardWord);
				this.#ops.setCursor(this.#backwardWord(emacsPrefixValue(this.#prefixArg)));
				return true;
			case "<":
				// `beginning-of-buffer` (`bindings.el:1615`).
				this.#beginCommand(CMD.beginningOfBuffer);
				this.#ops.setCursor(0);
				return true;
			case ">":
				// `end-of-buffer` (`bindings.el:1616`).
				this.#beginCommand(CMD.endOfBuffer);
				this.#ops.setCursor(this.#text().length);
				return true;
			case "d":
				// `kill-word` (`bindings.el:1612`), spec `"p"`, and the whole body is
				// `(kill-region (point) (progn (forward-word arg) (point)))`
				// (`simple.el:8997-9001`). `kill-region` is what sets `this-command`, so
				// `this-command` is left as `kill-word` here and only upgraded if the region is
				// non-empty or the chain is already open.
				this.#beginCommand(CMD.killWord);
				this.#killWord(emacsPrefixValue(this.#prefixArg));
				return true;
			case "w":
				// `kill-ring-save` (`bindings.el:1328`).
				this.#beginCommand(CMD.killRingSave);
				this.#copyRegionAsKill();
				return true;
			case "y":
				// `yank-pop` (`bindings.el:1331`), spec `"p"`.
				this.#beginCommand(CMD.yankPop);
				this.#yankPop(emacsPrefixValue(this.#prefixArg));
				return true;
			// `esc-map "-"`, and every spelling of it: a terminal sends `M--` as `ESC -` where
			// meta exists and as `C-_` where it does not, and both are bound (`bindings.el:1303`,
			// `:1309`, `:1315`).
			case "-":
			case "_":
				this.#negativeArgument();
				return true;
			// `M-0`..`M-9` are `digit-argument` (`bindings.el:1299-1302`). A *bare* digit is
			// not: `subr.el:1771` binds it to `self-insert-command`, so it belongs to the host.
			default:
				if (input >= "0" && input <= "9") {
					this.#digitArgument(input.charCodeAt(0) - 0x30);
					return true;
				}
				return false;
		}
	}

	// -- prefix argument -----------------------------------------------------

	/**
	 * The `universal-argument-map` table (`simple.el:5518-5553`): `C-u`, a digit, and `-`. Any
	 * other key pops the map and is read by the command table instead, with the argument it has
	 * built so far.
	 *
	 * The `-` case is subtler than it looks. Its binding is a `menu-item` whose `:filter`
	 * suppresses the command when digits have already been entered (`simple.el:5521-5525`): "For
	 * backward compatibility, minus with no modifiers is an ordinary command if digits have
	 * already been entered." So `C-u 5 -` leaves `prefix-arg` at 5 and lets the `-` be typed,
	 * rather than making it -5.
	 */
	#prefixKey(input: string, key: EmacsKey): boolean {
		if (key.ctrl && input === "u") {
			this.#universalArgument();
			return true;
		}
		if (key.ctrl || key.meta) return false;
		if (input >= "0" && input <= "9") {
			this.#digitArgument(input.charCodeAt(0) - 0x30);
			return true;
		}
		if (input === "-") {
			if (typeof this.#prefixArg === "number") return false;
			this.#negativeArgument();
			return true;
		}
		return false;
	}

	/**
	 * `universal-argument` (`simple.el:5559-5572`):
	 *
	 * ```elisp
	 *   (prefix-command-preserve-state)
	 *   (setq prefix-arg (list 4))
	 *   (universal-argument--mode)
	 * ```
	 *
	 * The `list 4` is why the argument is four states long. The times-four is *not* here: a
	 * second `C-u` is read from the transient map, where `[?\C-u]` is `universal-argument-more`
	 * (`simple.el:5529`), whose body is
	 * `(setq prefix-arg (if (consp arg) (list (* 4 (car arg))) (if (eq arg '-) (list -4) arg)))`
	 * (`simple.el:5579-5583`) followed by `(when (consp prefix-arg) (universal-argument--mode))`.
	 * So a *number* passes through untouched and the map closes — "otherwise it means to terminate
	 * the prefix arg" (`simple.el:5575-5576`). Both entry points are {@link #universalArgument}
	 * here, because the only thing that distinguishes them is which map was read, and the numbers
	 * are identical.
	 */
	#universalArgument(): void {
		this.#preserveCommandState();
		const arg = this.#prefixArg;
		if (typeof arg === "number") {
			// Terminate the argument and pop the map.
			this.#prefixPending = false;
			this.#prefixArgLive = true;
			return;
		}
		if (arg === "-") this.#prefixArg = { car: -4, cdr: [] };
		else if (arg !== null) this.#prefixArg = { car: 4 * arg.car, cdr: arg.cdr };
		else this.#prefixArg = { car: 4, cdr: [] };
		this.#prefixPending = true;
		this.#prefixArgLive = true;
	}

	/**
	 * `negative-argument` (`simple.el:5586-5594`):
	 * `(setq prefix-arg (cond ((integerp arg) (- arg)) ((eq arg '-) nil) (t '-)))`. Bare `M--`
	 * gives the **symbol** `'-`, not -1 — which `yank` then reads as a rotation of -2 rather than
	 * of -1 (`simple.el:6455`), and which a second `M--` cancels back to `nil`. Bound
	 * unconditionally on `esc-map` (`bindings.el:1303`), so it works whether or not the transient
	 * map is open.
	 */
	#negativeArgument(): void {
		this.#preserveCommandState();
		const arg = this.#prefixArg;
		if (typeof arg === "number") this.#prefixArg = -arg;
		else if (arg === "-") this.#prefixArg = null;
		else this.#prefixArg = "-";
		this.#prefixPending = true;
		this.#prefixArgLive = true;
	}

	/**
	 * `digit-argument` (`simple.el:5596-5613`): `(+ (* arg 10) digit)`, and **subtracting** the
	 * digit when the argument is already negative — which is what makes `M-- 5` mean -5 rather
	 * than "minus, then plus five".
	 */
	#digitArgument(digit: number): void {
		this.#preserveCommandState();
		const arg = this.#prefixArg;
		if (typeof arg === "number") {
			this.#prefixArg = arg * 10 + (arg < 0 ? -digit : digit);
		} else if (arg === "-") {
			// "Treat -0 as just -, so that -01 will work." (`simple.el:5609-5610`)
			this.#prefixArg = digit === 0 ? "-" : -digit;
		} else {
			this.#prefixArg = digit;
		}
		this.#prefixPending = true;
		this.#prefixArgLive = true;
	}

	/**
	 * `prefix-command-preserve-state` (`simple.el:5478-5487`): "If the current command is a prefix
	 * command, we don't want the next (real) command to have `last-command` set to, say,
	 * `universal-argument'." One assignment, and it is load-bearing for this engine:
	 * `this-command` becomes whatever `last-command` was, and the tail of `handleKey` copies that
	 * straight back into `last-command`. So a `C-u` is invisible to the goal column and to the
	 * kill chain, which is why `C-u C-n` still continues a vertical run and `C-u C-k` still
	 * chains onto the previous kill.
	 */
	#preserveCommandState(): void {
		this.#thisCommand = this.#lastCommand;
	}

	// -- command plumbing ----------------------------------------------------

	/**
	 * `command_loop_1` sets `Vthis_command` to the command's own symbol before calling it
	 * (`src/keyboard.c:1506-1507`). That default is load-bearing in three places: it is why `M-w`
	 * leaves `last-command` as `kill-ring-save` rather than as `kill-region` (see
	 * {@link #copyRegionAsKill}), why a `kill-line` that killed nothing leaves `last-command` as
	 * `kill-line`, and why a `kill-word` that killed nothing leaves it as `kill-word`.
	 */
	#beginCommand(command: EmacsCommand): void {
		this.#thisCommand = command;
	}

	#text(): string {
		return this.#ops.getText();
	}

	#clamp(pos: number): number {
		return Math.max(0, Math.min(pos, this.#text().length));
	}

	/**
	 * The one write path. Everything that changes the buffer goes through it, so two things hold
	 * everywhere: the host makes it one undo step, and the mark moves the way a marker moves and
	 * the region goes away.
	 *
	 * The region going away is the modification layer's half of the contract
	 * (`prepare_to_modify_buffer_1`, `src/insdel.c:2189`). It is deliberately not repeated in the
	 * kill commands: in Emacs it is not in them either. `kill-region` does set `deactivate-mark`
	 * itself (`simple.el:5994`) but the *guarantee* comes from the buffer, and a command that
	 * never heard of the mark — `delete-char`, `self-insert-command` — gets it for free.
	 */
	#write(newText: string, cursor: number): void {
		const [from, oldEnd, newEnd] = replacedSpan(this.#text(), newText);
		this.#adjustMark(from, oldEnd, newEnd);
		this.markActive = false;
		this.#ops.setAll(newText, cursor);
	}

	/**
	 * The mark-to-point span in the *order* `kill-region` and `copy-region-as-kill` receive it:
	 * `beg` is the mark, `end` is point, **unsorted**, because `(< end beg)` is the direction test.
	 * `lo`/`hi` are the same span sorted, which is what the text is actually sliced with.
	 */
	#regionArgs(): { beg: number; end: number; before: boolean; lo: number; hi: number } {
		const pos = this.#ops.getCursor();
		const mark = this.mark ?? pos;
		return { beg: mark, end: pos, before: pos < mark, lo: Math.min(pos, mark), hi: Math.max(pos, mark) };
	}

	/**
	 * `region-beginning` / `region-end` (`src/editfns.c:251-262`): "Return the integer value of
	 * point or mark, whichever is smaller" / "whichever is larger". **Purely geometric** — neither
	 * consults `mark-active`. This matters more than it looks, because `C-w` and `M-w` are *not*
	 * `use-region-p` commands, so a set-but-inactive mark still gives them a span to work on.
	 */
	#region(): { beg: number; end: number } {
		const pos = this.#ops.getCursor();
		const mark = this.mark ?? pos;
		return { beg: Math.min(pos, mark), end: Math.max(pos, mark) };
	}

	/**
	 * `use-region-p` (`simple.el:7238-7263`):
	 *
	 * ```elisp
	 * (and (region-active-p)
	 *      (or (> (region-end) (region-beginning))
	 *          (and use-empty-active-region
	 *               (not (eq (car-safe last-input-event) 'down-mouse-1))
	 *               (not (mouse-movement-p last-input-event)))))
	 * ```
	 *
	 * `use-empty-active-region` is `nil` by default (`simple.el:7207-7218`), so **an active
	 * region of zero width is not a region**. `region-active-p` (`simple.el:7265-7277`) is
	 * Transient Mark mode **and** `mark-active` **and** a mark that is actually set, which is why
	 * {@link mark} and {@link markActive} are two fields and not one.
	 *
	 * Named {@link #regionApplies} rather than after the Lisp function: Biome reads a
	 * `use…`-shaped method name as a React hook and this is not React.
	 */
	#regionApplies(): boolean {
		if (!this.markActive || this.mark === null) return false;
		const r = this.#region();
		return r.end > r.beg;
	}

	// -- mark and region -----------------------------------------------------

	/**
	 * `move-beginning-of-line` (`C-a` / `[home]`, `bindings.el:1346` / `:1408`).
	 *
	 * Its own spec is `"^p"` and its body is "With argument N not nil or 1, move forward N - 1
	 * lines first" (`cmds.c:150-152`), so a prefix argument makes it a whole-line motion. Only
	 * the no-argument form is wired up here: `emacsPrefixValue` collapses `null` to 1, and the
	 * counted form belongs with the vertical-motion batch's own prefix handling rather than
	 * half-implemented now.
	 */
	#moveBeginningOfLine(): boolean {
		this.#beginCommand(CMD.moveBeginningOfLine);
		this.#ops.setCursor(lineStart(this.#text(), this.#ops.getCursor()));
		return true;
	}

	/** `move-end-of-line` (`C-e` / `[end]`), spec `"^p"` (`bindings.el:1347`), same limit. */
	#moveEndOfLine(): boolean {
		this.#beginCommand(CMD.moveEndOfLine);
		this.#ops.setCursor(lineEndExclusive(this.#text(), this.#ops.getCursor()));
		return true;
	}

	/**
	 * `set-mark-command` (`C-SPC` / `C-@`, `bindings.el:1333` / `:1335`), spec `"P"`.
	 *
	 * The `cond` at `simple.el:7493-7518` has six arms and one of them is **dead from the
	 * keyboard**: `(not (eq this-command 'set-mark-command))` at `:7496`, because `command_loop_1`
	 * has already set `this-command` to `set-mark-command` before the body runs
	 * (`src/keyboard.c:1506-1507`). It is kept because it is what a Lisp caller reaches, and
	 * because deleting it would leave the remaining arms unlabelled. The first two arms of the
	 * `cond` — on `transient-mark-mode` being a lambda or the symbol `only` — are unreachable in
	 * a host that is in Transient Mark mode as `t`, and are likewise omitted.
	 *
	 * What is left, in order:
	 *
	 *   - `C-u C-u C-SPC` is `(16)`, a cons over 4, so arm 1 fires: "unconditionally set mark
	 *     where point is" (`simple.el:7482-7484`). `C-u C-SPC` is `(4)`, not over 4, so it falls
	 *     to arm 4 and **jumps to the mark** — the docstring says so at `simple.el:7472-7476`.
	 *   - arms 3 and 4 are the `set-mark-command-repeat-pop` ones. That option is `nil` by
	 *     default (`simple.el:7447-7457`), so arm 3 is dead and arm 4 collapses to "any non-nil
	 *     argument", which is what it reduces to here.
	 *   - arm 5 is the toggle everyone knows: `(eq last-command 'set-mark-command)` plus
	 *     `region-active-p`. It uses `region-active-p` and **not** `use-region-p`, so a mark
	 *     sitting at point still counts as an active region — two `C-SPC` in a row at the same
	 *     place activate, then deactivate, then activate.
	 */
	#setMarkCommand(): boolean {
		this.#beginCommand(CMD.setMarkCommand);
		const arg = this.#prefixArg;
		// `((and (consp arg) (> (prefix-numeric-value arg) 4)) (push-mark-command nil))`
		if (arg !== null && typeof arg === "object" && arg.car > 4) {
			this.#pushMarkCommand(false);
			return true;
		}
		// `((not (eq this-command 'set-mark-command)) (if arg (pop-to-mark-command)
		//   (push-mark-command t)))` — always false from the keyboard.
		if (this.#thisCommand !== CMD.setMarkCommand) {
			if (arg !== null) this.#popToMark();
			else this.#pushMarkCommand(true);
			return true;
		}
		// `((or (and set-mark-command-repeat-pop (eq last-command 'pop-to-mark-command)) arg)
		//   (setq this-command 'pop-to-mark-command) (pop-to-mark-command))`
		if (arg !== null) {
			this.#popToMark();
			return true;
		}
		// `((eq last-command 'set-mark-command) (if (region-active-p) (deactivate-mark)
		//   (activate-mark)))`
		if (this.#lastCommand === CMD.setMarkCommand) {
			this.markActive = !this.markActive && this.mark !== null;
			return true;
		}
		this.#pushMarkCommand(false);
		return true;
	}

	/**
	 * `push-mark-command` (`simple.el:7435-7445`) over `push-mark` (`simple.el:7520-7551`).
	 *
	 * ```elisp
	 * (let ((mark (mark t)))
	 *   (if (or arg (null mark) (/= mark (point)))
	 *       (push-mark nil nomsg t)
	 *     (activate-mark 'no-tmm)))
	 * ```
	 *
	 * Both arms activate — `push-mark`'s third argument is `ACTIVATE`, and
	 * `(if (or activate (not transient-mark-mode)) (set-mark (mark t)))`
	 * (`simple.el:7549-7550`) takes the `activate` branch whatever TMM says. The arms differ only
	 * in whether the old mark goes on the ring: it does not when the mark is already exactly at
	 * point and there is no argument, which is the "If no prefix ARG and mark is already set
	 * there, just activate it" case from the docstring.
	 *
	 * The `force` parameter is the two call shapes in the source: arm 2 of `set-mark-command`
	 * passes `t` and arm 1 and the final `t` arm pass `nil`. `nil` is *not* the same as `false` in
	 * the same way, and the difference shows: with `nil` a `C-SPC` pressed twice at the same spot
	 * does not grow the mark ring, with `t` it does.
	 *
	 * Note there is no `(setq this-command 'push-mark-command)` in that function, so
	 * `last-command` after a bare `C-SPC` is `set-mark-command` — which is the only reason the
	 * toggle arm above ever fires.
	 */
	#pushMarkCommand(force: boolean): void {
		const pos = this.#ops.getCursor();
		if (force || this.mark === null || this.mark !== pos) {
			if (this.mark !== null) {
				this.markRing.push(this.mark);
				if (this.markRing.length > MARK_RING_MAX) this.markRing.shift();
			}
			this.mark = pos;
		}
		this.markActive = true;
	}

	/**
	 * `pop-to-mark-command` (`simple.el:7424-7433`) over `pop-mark` (`simple.el:7553-7561`): jump
	 * to the mark, then take the mark from the mark ring.
	 *
	 * Three details worth having. `pop-mark` is a no-op on an empty ring, so the mark keeps the
	 * position the jump just left it at. The ring is not a stack: `pop-mark` `nconc`s the current
	 * mark onto the **end** and promotes the **car**, so the mark a jump leaves behind goes to the
	 * back of the queue rather than the front. And `pop-mark` ends with `(deactivate-mark)`, so
	 * the region is gone whether or not there was anything to pop.
	 */
	#popToMark(): void {
		if (this.mark === null) {
			// `(user-error "No mark set in this buffer")` — the signal leaves `command_loop_1`
			// before its tail, so nothing is committed.
			this.#commit = false;
			return;
		}
		this.#beginCommand(CMD.popToMarkCommand);
		const target = this.mark;
		if (this.markRing.length > 0) {
			this.markRing.push(target);
			if (this.markRing.length > MARK_RING_MAX) this.markRing.shift();
			this.mark = this.markRing.shift() ?? target;
		}
		this.markActive = false;
		this.#ops.setCursor(target);
	}

	/**
	 * `exchange-point-and-mark` (`C-x C-x`, `bindings.el:1338`), spec `"P"`.
	 *
	 * It "works even when the mark is not active, and it reactivates the mark"
	 * (`simple.el:7579-7580`). That falls out of the source: `set-mark` at `simple.el:7596` calls
	 * `activate-mark` internally (`simple.el:7138-7156`), so by the time the `cond` at `:7598`
	 * asks, the region *is* active, the `xor` at `:7599` is false, and the `t` branch activates
	 * again. A `C-x C-x` after a `C-SPC` gives a live region where there was a bare mark, and so
	 * does one after a `yank`, whose `push-mark` does not activate.
	 */
	#exchangePointAndMark(): boolean {
		this.#beginCommand(CMD.exchangePointAndMark);
		if (this.mark === null) {
			// `(user-error "No mark set in this buffer")` (`simple.el:7593-7594`).
			this.#commit = false;
			return true;
		}
		const pos = this.#ops.getCursor();
		const was = this.mark;
		this.mark = pos;
		this.markActive = true;
		this.#ops.setCursor(was);
		return true;
	}

	// -- the kill ring -------------------------------------------------------

	/**
	 * `kill-new` (`simple.el:5763-5818`), reduced to the part that is a state machine: push to the
	 * **front**, or overwrite the front when `replace` is non-nil, and reset the yank pointer to
	 * it.
	 *
	 * ```elisp
	 * (if (and replace kill-ring)
	 *     (setcar kill-ring string)
	 *   (let ((history-delete-duplicates nil))
	 *     (add-to-history 'kill-ring string kill-ring-max t)))
	 * (setq kill-ring-yank-pointer kill-ring)
	 * ```
	 *
	 * `add-to-history` (`subr.el:2703-2735`) conses to the front and truncates from the tail
	 * (`(setq tail (nthcdr (1- maxelt) history))` … `(setcdr tail nil)`, `subr.el:2732-2734`).
	 * Its deduplication is off here and that is deliberate, not an omission: `kill-new` binds
	 * `history-delete-duplicates` to `nil` around the call (`simple.el:5814`), and the separate
	 * `kill-do-not-save-duplicates` guard (`simple.el:5810-5811`) is off by default too. So
	 * killing the same text twice, non-consecutively, gives **two** entries.
	 */
	#killNew(text: string, replace: boolean): void {
		if (replace && this.killRing.length > 0) this.killRing[0] = text;
		else {
			this.killRing.unshift(text);
			if (this.killRing.length > KILL_RING_MAX) this.killRing.length = KILL_RING_MAX;
		}
		this.#yankPointer = 0;
	}

	/**
	 * `kill-append` (`simple.el:5831-5851`):
	 *
	 * ```elisp
	 * (kill-new (if before-p (concat string cur) (concat cur string))
	 *           (or (= (length cur) 0)
	 *               (null (get-text-property 0 'yank-handler cur))))
	 * ```
	 *
	 * Two facts, and both are observable. The direction is `before-p`, which the caller works out
	 * from **geometry** — `kill-region` passes `(< end beg)` (`simple.el:5989`) — and not from
	 * which key was pressed, which is why `append-next-kill`'s docstring can say "Kill commands
	 * that act on the region, such as `kill-region', are regarded as killing forward if point is
	 * after mark, and killing backward if point is before mark" (`simple.el:6149-6152`). And the
	 * second argument to `kill-new` is why **a chain does not grow the ring**: `replace` is
	 * non-nil whenever the current entry carries no yank handler, which in a plain text buffer is
	 * always, and `setcar` then overwrites the head in place. The yank-handler clause is what
	 * keeps a rectangle kill from being concatenated with ordinary text; there are no text
	 * properties here, so that half of the `or` is vacuous and the ring-length result is the same
	 * either way.
	 */
	#killAppend(text: string, before: boolean): void {
		const cur = this.killRing.length > 0 ? this.killRing[0] : "";
		this.#killNew(before ? text + cur : cur + text, true);
	}

	/**
	 * `current-kill` (`simple.el:5900-5924`), with `kill-ring-yank-pointer` as an index.
	 *
	 * ```elisp
	 * (nthcdr (mod (- n (length kill-ring-yank-pointer)) (length kill-ring)) kill-ring)
	 * ```
	 *
	 * The pointer is a **tail of the list**, not a subscript, and that is the whole difficulty:
	 * its length is the number of elements *after* the one it points at, so the index it stands
	 * for is `length - (length pointer)`, and substituting that into the `mod` above gives
	 *
	 * ```text
	 *   newIndex = (mod (- n (length - index)) length) = (mod (+ n index) length)
	 * ```
	 *
	 * which is an ordinary modular step. Two consequences worth having: `n` = 0 does not move the
	 * pointer, so a bare `yank` never rotates, and the sequence wraps, so from the oldest kill one
	 * more step forward is the newest again.
	 */
	#currentKill(n: number): string | null {
		if (this.killRing.length === 0) return null;
		const len = this.killRing.length;
		this.#yankPointer = ((((this.#yankPointer + n) % len) + len) % len) | 0;
		return this.killRing[this.#yankPointer];
	}

	/**
	 * `kill-region` (`simple.el:5930-6011`).
	 *
	 * `beg` and `end` are Emacs's parameter names and their **order is the whole point**: "Pass
	 * mark first, then point, because the order matters when calling `kill-append'"
	 * (`simple.el:5961-5962`). The buffer-changing core is
	 *
	 * ```elisp
	 * (let ((string (cond
	 *                ((memq region '(unix-word emacs-word)) …)
	 *                (region (funcall region-extract-function 'delete))
	 *                ((filter-buffer-substring beg end 'delete)))))
	 *   (when string			;STRING is nil if BEG = END
	 *     (if (and (not (memq region '(unix-word emacs-word)))
	 *              (eq last-command 'kill-region))
	 *         (kill-append string (< end beg))
	 *       (kill-new string)))
	 *   (when (and (not (memq region '(unix-word emacs-word)))
	 *              (or string (eq last-command 'kill-region)))
	 *     (setq this-command 'kill-region))
	 *   (setq deactivate-mark t))
	 * ```
	 *
	 * Four things in here are the entire behaviour of the kill ring:
	 *
	 *   - **`(< end beg)`** is the direction, decided by geometry. A region that runs backwards
	 *     from point prepends, and one that runs forwards appends.
	 *   - **the chain test is that one exact symbol**, `(eq last-command 'kill-region)`, not "was
	 *     the last command something that killed". So every command that kills *through*
	 *     `kill-region` must let `kill-region` set `this-command`, or the chain breaks between two
	 *     kills that did kill.
	 *   - **`string` is never nil for any caller in this batch.** The `nil` case the comment
	 *     describes is the `unix-word` / `emacs-word` region types, which reach this engine only
	 *     from Lisp. Both other branches go through `filter-buffer-substring`
	 *     (`simple.el:5630-5649`) or `region-extract-function`, and those return `""` for an
	 *     empty range, not `nil`. So **an empty kill still pushes an empty entry** and still
	 *     sets `this-command` to `kill-region`: killing nothing is not the same as not being
	 *     between kills.
	 *   - **`deactivate-mark` runs on every path**, empty region included.
	 *
	 * Point ends at the region's beginning. `filter-buffer-substring` does
	 * `(save-excursion (delete-and-extract-region beg end) …)` and point is relocated as if it
	 * were a marker (`src/insdel.c:1802-1810`), so a point inside the deleted range collapses to
	 * the start. Both `beg` and `end` are usable in either order — "The order of BEG and END does
	 * not matter" (`simple.el:5634`) — which is what lets a reversed region still delete the right
	 * span.
	 */
	#killRegion(beg: number, end: number): void {
		const from = this.#clamp(Math.min(beg, end));
		const to = this.#clamp(Math.max(beg, end));
		const text = this.#text();
		const string = text.slice(from, to);
		// An empty region **does** enter the ring, and the source's own comment says the
		// opposite. `simple.el:5986` reads `;STRING is nil if BEG = END`, and if that were so the
		// `(when string …)` a line below would skip the ring for a collapsed selection. It is
		// not so: `string` is bound to `filter-buffer-substring` → `delete-and-extract-region`,
		// and that returns `empty_unibyte_string` — `""`, not `nil` — when the two positions
		// are equal (`src/editfns.c:2697-2699`). `""` is truthy in Lisp, so the `when` runs and
		// the empty kill is recorded. The comment is stale; the code is what runs.
		//
		// Worth writing down because this is a case where reading the source faithfully would
		// mean copying a comment that its own implementation contradicts.
		if (this.#lastCommand === CMD.killRegion) this.#killAppend(string, end < beg);
		else this.#killNew(string, false);
		this.#thisCommand = CMD.killRegion;
		this.markActive = false;
		// The write is skipped, not the kill: the ring entry above is the observable part, and
		// a zero-width write is a no-op under the host's no-change rule anyway.
		if (from === to) return;
		this.#write(text.slice(0, from) + text.slice(to), from);
	}

	/**
	 * `kill-region` as a command (`C-w`, `bindings.el:1327`).
	 *
	 * `kill-region-dwim` is `nil` by default, so the interactive spec (`simple.el:5963-5971`)
	 * reduces to:
	 *
	 * ```elisp
	 * (let ((beg (mark kill-region-dwim)) (end (point)))
	 *   (cond ((and kill-region-dwim (not (use-region-p))) (list beg end kill-region-dwim))
	 *         ((not (and beg end))
	 *          (user-error "The mark is not set now, so there is no region"))
	 *         ((list beg end 'region))))
	 * ```
	 *
	 * Two things follow, and both are surprising:
	 *
	 *   - **no mark at all is a `user-error`**, and only no mark — `C-w` refuses rather than doing
	 *     nothing quietly (`simple.el:5969-5970`).
	 *   - **a mark that is set but inactive is still a region for `C-w`.** `region` is `'region`,
	 *     which sends `kill-region` to `region-extract-function`, and that calls
	 *     `region-beginning` / `region-end`, which are `min`/`max` of point and mark and consult
	 *     nothing else (`src/editfns.c:251-262`). So `C-w` kills the mark-to-point span whether
	 *     or not the region is active, and it deactivates the mark afterwards.
	 */
	#killRegionCommand(): boolean {
		this.#beginCommand(CMD.killRegion);
		if (this.mark === null) {
			// "(The mark is not set now, so there is no region)" — a `user-error`, so the command
			// aborts and `last-command` stands.
			this.#commit = false;
			return true;
		}
		const a = this.#regionArgs();
		this.#killRegion(a.beg, a.end);
		return true;
	}

	/**
	 * `copy-region-as-kill` (`simple.el:6016-6042`), which is what `kill-ring-save` (`M-w`) calls
	 * (`simple.el:6044-6071`).
	 *
	 * ```elisp
	 * ;; copy-region-as-kill no longer sets this-command, because it's confusing
	 * ;; to get two copies of the text when the user accidentally types M-w and
	 * ;; then corrects it with the intended C-w.
	 *   (if (eq last-command 'kill-region) (kill-append str (< end beg)) (kill-new str))
	 *   (setq deactivate-mark t)
	 * ```
	 *
	 * That comment is the behaviour, and the two halves of it are **not symmetric**:
	 *
	 *   - `M-w` then `C-w` gives two separate copies, because the copy leaves `this-command` as
	 *     `kill-ring-save` and does not overwrite `last-command` either — so the `C-w` does not
	 *     see a chain. The `C-w` still has the mark to point at, so what lands in the ring is the
	 *     copy and then a *second* copy of the same span.
	 *   - the *append* half of the same two lines is **dead from the keyboard**. It tests
	 *     `last-command`, and every kill sets `deactivate-mark`, so reaching it would need a
	 *     command that re-activates the mark without disturbing `last-command` — and
	 *     `push-mark-command` and `exchange-point-and-mark` both change it. Which is why
	 *     `kill-ring-save`'s own docstring says the way to append is "\\[append-next-kill]
	 *     before \\[kill-ring-save]" (`simple.el:6051-6052`) rather than pressing both keys.
	 *
	 * `M-w` does need a mark to have been set at some point, and the spec is
	 * `(interactive (list (mark) (point) 'region))` — `region` is `'region`, so the two positions
	 * are ignored and the span is geometric on the mark exactly as for `C-w`. With no mark the
	 * span is empty and `""` is pushed; there is no error, unlike `C-w`.
	 */
	#copyRegionAsKill(): void {
		// `(list (mark) (point) 'region)`: `beg` is the mark and `end` is point, **not** sorted,
		// because `(< end beg)` is the direction test.
		const a = this.#regionArgs();
		const str = this.#text().slice(a.lo, a.hi);
		if (this.#lastCommand === CMD.killRegion) this.#killAppend(str, a.before);
		else this.#killNew(str, false);
		// Note what is *not* set: `this-command` stays `kill-ring-save`, set by
		// `#beginCommand` in the caller.
		this.markActive = false;
	}

	/**
	 * `append-next-kill` (`M-C-w`, `simple.el:6145-6164`):
	 *
	 * ```elisp
	 * (if interactive
	 *     (progn (setq this-command 'kill-region) (message "…"))
	 *   (setq last-command 'kill-region))
	 * ```
	 *
	 * Interactively it sets `this-command`, which `command_loop` copies into `last-command` — so
	 * the *next* kill, however far away it is and whatever direction, joins the previous one. The
	 * non-interactive branch sets `last-command` directly, which is the same intent without a
	 * command loop to do it. Its docstring also says what "no effect" means: "If the next
	 * command is not a kill command, `append-next-kill' has no effect"
	 * (`simple.el:6154-6155`).
	 */
	#appendNextKill(): void {
		this.#thisCommand = CMD.killRegion;
	}

	// -- kill commands -------------------------------------------------------

	/**
	 * `kill-line` (`C-k`, `simple.el:6769-6822`), spec `"P"` — raw.
	 *
	 * ```elisp
	 * (kill-region (point)
	 *              (progn
	 *                (if arg
	 *                    (forward-visible-line (prefix-numeric-value arg))
	 *                  (if (eobp) (signal 'end-of-buffer nil))
	 *                  (let ((end (save-excursion (end-of-visible-line) (point))))
	 *                    (if (or (save-excursion
	 *                              (unless show-trailing-whitespace
	 *                                (skip-chars-forward " \t" end))
	 *                              (= (point) end))
	 *                            (and kill-whole-line (bolp)))
	 *                        (forward-visible-line 1)
	 *                      (goto-char end))))
	 *                (point)))
	 * ```
	 *
	 * Three cases, and the raw spec is what tells them apart, because **0 is not nil**:
	 *
	 *   - an argument, of any value: move down that many lines first and there is **no `eobp`
	 *     check at all** — the check is in the `else` branch of `(if arg …)`. So `C-u C-k` is
	 *     `(4)` through `prefix-numeric-value` and kills four lines; `C-0 C-k` — arg `0`, which
	 *     is non-nil — moves to the beginning of the line and kills the text *before* point,
	 *     backward, which **prepends** to the previous kill ("With zero argument, kills the text
	 *     before point on the current line", `simple.el:6773`). A bare `C-k` always kills forward
	 *     and so can never prepend; this is the only `C-k` that can.
	 *   - no argument: the two branches of that `if` are the whole of the behaviour, and **which
	 *     one runs is decided by the absence of a nonblank between point and end of line**, not
	 *     by being at end of line as such. The condition is `(or (skip-chars-forward " \t" end)
	 *     (= (point) end) (and kill-whole-line (bolp)))`; `skip-chars-forward` returns a *count*,
	 *     and `0` is false in Lisp, so the condition reduces to "everything in `[point, end)` is a
	 *     space or a tab" — vacuously true at end of line, where the range is empty. True means
	 *     `(forward-visible-line 1)`, which is the **next line's start**, so the line break is
	 *     killed and the lines join; false means `(goto-char end)`, so the kill stops at the first
	 *     nonblank and the line break stays. This is the branch that makes a second `C-k` join the
	 *     first, and reading it as "kill to end of line" gets the chain wrong.
	 *   - at end of buffer, `(signal 'end-of-buffer nil)` means nothing happens and no command is
	 *     recorded. That check is *only* in the no-argument branch.
	 *
	 * The docstring's first line — "if no nonblanks there, kill thru newline" — is therefore an
	 * accurate summary, and it is `show-trailing-whitespace` being `nil` (`simple.el:6816-6817`)
	 * that makes it true: with it non-nil the `skip-chars-forward` is skipped over and a line
	 * whose tail is spaces is treated as having a nonblank, so the whitespace goes and the line
	 * break stays. The default is the one implemented here.
	 */
	#killLine(arg: EmacsPrefixArg): void {
		const text = this.#text();
		const pos = this.#ops.getCursor();
		if (arg === null) {
			if (pos >= text.length) {
				// `(signal 'end-of-buffer nil)` — the key is taken and nothing runs, so
				// `last-command` is left standing.
				this.#commit = false;
				return;
			}
			const end = lineEndExclusive(text, pos);
			// The condition, reduced. `BLANK_RE` is the only regexp in the file; it stands for
			// `skip-chars-forward " \t"` over `[pos, end)`, which cannot fail inside the line.
			const onlyBlanks = BLANK_RE.test(text.slice(pos, end));
			// True branch: `(forward-visible-line 1)` — the start of the next line, clamped, which
			// for the last line of a buffer is the end of the buffer.
			this.#killRegion(pos, onlyBlanks ? nthLineStart(text, lineOf(text, pos) + 1) : end);
			return;
		}
		this.#killRegion(pos, this.#forwardVisibleLine(emacsPrefixValue(arg)));
	}

	/**
	 * `forward-visible-line` for a buffer with no invisible newlines: the start of the line `n`
	 * away, clamped at both ends. The real function does not signal at the edges, which is why
	 * the *callers* have to check `eobp` themselves.
	 */
	#forwardVisibleLine(n: number): number {
		const text = this.#text();
		const line = lineOf(text, this.#ops.getCursor()) + n;
		return nthLineStart(text, Math.max(0, Math.min(line, lineCount(text) - 1)));
	}

	/**
	 * `kill-whole-line` (`[C-S-backspace]`, `simple.el:6824-6885`).
	 *
	 * It is two kills, and the two-step is not an implementation detail — the source explains it
	 * (`simple.el:6839-6843`):
	 *
	 * ```elisp
	 * (unless (eq last-command 'kill-region)
	 *   (kill-new "")            ;; seed an EMPTY entry
	 *   (setq last-command 'kill-region))
	 * ;; - We need to kill in two steps, because the previous command
	 * ;;   could have been a kill command, in which case the text before
	 * ;;   point needs to be prepended to the current kill ring entry and
	 * ;;   the text after point appended.
	 * ```
	 *
	 * `regions-begin` is a *marker* at point and `region1-end` a marker at the other end of the
	 * first region, and the two `kill-region` calls are `(regions-begin, region1-end)` and then
	 * `(regions-begin, point)` (`simple.el:6880-6883`). The `cond` that computes `region1-end`
	 * (`:6853-6868`) is three branches, and **two of them put it at point itself**:
	 *
	 * ```elisp
	 * ((zerop arg) (prog1 (save-excursion (forward-visible-line 0) (point-marker))
	 *                   (end-of-visible-line)))
	 * ((< arg 0)   (prog1 (save-excursion (end-of-visible-line) (point-marker))
	 *                   (forward-visible-line (1+ arg)) (unless (bobp) (backward-char))))
	 * (t           (prog1 (save-excursion (forward-visible-line 0) (point-marker))
	 *                   (forward-visible-line arg)))
	 * ```
	 *
	 * `forward-visible-line 0` does not move, so for a zero or positive count the first region is
	 * empty and only `end-of-visible-line` — for zero — or `forward-visible-line arg` moves point.
	 * That is the whole reason the comment above says "text before point **needs to be** prepended"
	 * rather than "is": with a positive count **nothing before point is killed at all**. `C-S-BS`
	 * at column 1 of `abc` in `abc\ndef` kills `bc\n` and leaves `adef`, which is what `dd` does in
	 * a normal buffer. Only the negative branch reaches back before point, and it is also the only
	 * one whose first region is non-empty: point-to-end-of-line, appended, then the far end
	 * prepended — "text after point appended" first and "text before point prepended" second, which
	 * is the order the comment lists them in for a reason.
	 *
	 * So the two steps collapse: for a zero or positive count the first `kill-region` is
	 * `kill-region(pos, pos)`, an empty append that only fixes the direction bookkeeping, and for
	 * a negative count it is the real first half. The seed `""` is still needed, because
	 * `kill-append` does `(car kill-ring)` and an empty ring is `nil`.
	 *
	 * The other half of the reason for two steps is the comment at `simple.el:6871-6876`: "Pass
	 * the marker positions and not the markers themselves. kill-region determines whether to
	 * prepend or append to a previous kill by checking the direction of the region. But it deletes
	 * the content and hence moves the markers before that. That effectively makes every region
	 * delimited by markers an (empty) forward region." In this engine that turns out to be a
	 * **no-op**, and the two ways of seeing why agree: the first region is either empty or lies
	 * entirely *after* the second region's far end, so nothing the first kill deletes is in front
	 * of a position the second one still needs. `regions-begin` is a marker at the deletion's
	 * start, and `del_range_1` relocates a point as if it were a marker (`src/insdel.c:1802-1810`),
	 * so it still reads `pos` when the second call is made.
	 */
	#killWholeLine(n: number): void {
		if (this.#lastCommand !== CMD.killRegion) {
			this.#killNew("", false);
			this.#lastCommand = CMD.killRegion;
		}
		const text = this.#text();
		const pos = this.#ops.getCursor();
		const bol = lineStart(text, pos);
		const eol = lineEndExclusive(text, pos);
		// `(if (and (> arg 0) (eobp) (save-excursion (forward-visible-line 0) (eobp)))
		//     (signal 'end-of-buffer nil))` — on the last line, and only if it is empty.
		if (n > 0 && pos >= text.length && bol >= text.length) {
			this.#commit = false;
			return;
		}
		// `(if (and (< arg 0) (bobp) (save-excursion (end-of-visible-line) (bobp)))
		//     (signal 'beginning-of-buffer nil))`
		if (n < 0 && pos <= 0 && eol <= 0) {
			this.#commit = false;
			return;
		}
		let target: number;
		if (n < 0) {
			const above = nthLineStart(text, Math.max(0, lineOf(text, pos) + n + 1));
			// `(unless (bobp) (backward-char))`
			target = above > 0 ? retreat(text, above) : above;
		} else {
			// `(end-of-visible-line)` for zero, `forward-visible-line arg` otherwise. They differ
			// only on the last line, where `forward-visible-line` clamps and `end-of-visible-line`
			// does not.
			target = n === 0 ? eol : this.#forwardVisibleLine(n);
		}
		// `region1-end`: end of line for a negative count, point itself otherwise.
		this.#killRegion(pos, n < 0 ? eol : pos);
		this.#killRegion(pos, target);
	}

	/**
	 * `kill-word` (`M-d`, `simple.el:8997-9001`): `(kill-region (point) (progn (forward-word arg)
	 * (point)))`. A negative count is `backward-kill-word` (`simple.el:9003-9007`), which is
	 * nothing but `(kill-word (- arg))`.
	 */
	#killWord(n: number): void {
		const pos = this.#ops.getCursor();
		const target = n >= 0 ? this.#forwardWord(n) : this.#backwardWord(-n);
		this.#killRegion(pos, target);
	}

	// -- deletion ------------------------------------------------------------

	/**
	 * The one place all three delete commands meet, which is the only way the batch can honour a
	 * spec they all share: `delete-char` is `"p\nP"` (`src/cmds.c:221`), `delete-backward-char` is
	 * `"p\nP"` (`simple.el:1497`) and `delete-forward-char` is `"p\nP"` (`simple.el:1540`). Two
	 * arguments, two channels — see {@link EmacsPrefixArg}.
	 *
	 * `n` is the count `delete-char` receives (already signed, negative meaning the other
	 * direction), `kill` is `KILLFLAG`, and `killCount` is what `kill-forward-chars` is then
	 * handed. The three differ for `C-h`: `delete-backward-char` negates before calling
	 * (`(delete-char (- n) killflag)`, `simple.el:1518`), so its kill count is `-n` while `C-d`'s
	 * is `n`.
	 *
	 * `delete-char`'s body (`src/cmds.c:231-260`) is: `if (NILP (killflag))` delete the range,
	 * `else` `(calln (Qkill_forward_chars, n))`. The docstring above it is the sentence that
	 * matters: "Interactively, N is the prefix arg, and KILLFLAG is set if N was explicitly
	 * specified" (`src/cmds.c:224-225`). So **any** prefix argument turns the deletion into a
	 * kill: a bare `C-d` deletes and does not touch the kill ring, and `C-u C-d` kills four
	 * characters into it. That is the single most surprising thing about a prefix argument in an
	 * Emacs-style editor, it is in no docstring beyond that sentence, and it is why the two
	 * argument channels have to be modelled separately.
	 *
	 * At the edges `xsignal0 (Qend_of_buffer)` / `(Qbeginning_of_buffer)`
	 * (`src/cmds.c:243-251`) mean nothing happens — the key is taken and `last-command` is left
	 * alone, because the signal leaves `command_loop_1` before its tail.
	 */
	#runDeleteChar(n: number, kill: boolean, killCount: number): void {
		const text = this.#text();
		const pos = this.#ops.getCursor();
		if (kill) {
			// `kill-forward-chars` (`simple.el:6663-6667`): the listp collapse and the `'-` case
			// are written out there for the Lisp callers, and the numeric argument `delete-char`
			// passes needs neither — but the prefix a user typed arrives here raw, so both still
			// matter.
			this.#killRegion(pos, pos + killCount);
			return;
		}
		const end = pos + n;
		if (end < 0 || end > text.length) {
			this.#commit = false;
			return;
		}
		const from = Math.min(pos, end);
		this.#write(text.slice(0, from) + text.slice(Math.max(pos, end)), from);
	}

	/**
	 * `delete-backward-char` (`<backspace>` / `C-h`, `simple.el:1478-1518`).
	 *
	 * The region is consulted but only when `n` is 1 (`:1500-1502`):
	 *
	 * ```elisp
	 * (cond ((and (use-region-p) delete-active-region (= n 1))
	 *        (if (eq delete-active-region 'kill)
	 *            (kill-region (region-beginning) (region-end) 'region)
	 *          (funcall region-extract-function 'delete-only)))
	 *       ...)
	 * ```
	 *
	 * `delete-active-region` is `t` by default (`:1438-1451`) and `t` is not the symbol `kill`, so
	 * the region branch is `(delete-region beg end)` — the region is **removed, not saved**
	 * ("though not `delete-char'", `:1441-1442`). `(= n 1)` is why `M-2 C-h` deletes two
	 * characters and leaves the region standing.
	 *
	 * `n` can be negative — "following if N is negative" (`:1479`) — which is why the two
	 * functions end in the same `delete-char` call with opposite signs. The overwrite-mode
	 * untabify branch between them (`:1508-1516`) needs `overwrite-mode`, which a prompt field is
	 * not, so it never runs here.
	 */
	#deleteBackwardChar(): boolean {
		const n = emacsPrefixValue(this.#prefixArg);
		if (n === 1 && this.#regionApplies()) {
			this.#deleteActiveRegion();
			return true;
		}
		this.#beginCommand(CMD.deleteChar);
		this.#runDeleteChar(-n, this.#prefixArg !== null, -n);
		return true;
	}

	/**
	 * `delete-forward-char` (`<deletechar>`, `simple.el:1520-1560`), the same `(= n 1)` guard at
	 * `:1543-1545` and the same `(delete-region …)`.
	 *
	 * Its docstring also says that for a positive `n` "characters composed into a single grapheme
	 * cluster count as a single character" (`:1526-1529`), which this engine does not model: a
	 * prompt field is not a composition host, and the kill path (`kill-forward-chars`) does not do
	 * it either.
	 */
	#deleteForwardChar(): boolean {
		const n = emacsPrefixValue(this.#prefixArg);
		if (n === 1 && this.#regionApplies()) {
			this.#deleteActiveRegion();
			return true;
		}
		this.#beginCommand(CMD.deleteChar);
		this.#runDeleteChar(n, this.#prefixArg !== null, n);
		return true;
	}

	/** `region-extract-function` with method `'delete-only` (`simple.el:1460-1461`). */
	#deleteActiveRegion(): void {
		const r = this.#region();
		if (r.end <= r.beg) return;
		const text = this.#text();
		this.#write(text.slice(0, r.beg) + text.slice(r.end), r.beg);
	}

	// -- yank ----------------------------------------------------------------

	/**
	 * `yank` (`C-y`, `simple.el:6403-6466`), spec `"*P"` — raw.
	 *
	 * ```elisp
	 *   (setq this-command t)                       ;; the sentinel
	 *   (push-mark)
	 *   (insert-for-yank (current-kill (cond ((listp arg) 0)
	 *                                            ((eq arg '-) -2)
	 *                                            (t (1- arg)))))
	 *   (if (consp arg) (goto-char (prog1 (mark t) (set-marker (mark-marker) (point)))))
	 *   (if (eq this-command t) (setq this-command 'yank))
	 * ```
	 *
	 * Four things, all observable:
	 *
	 *   - **the rotation count is `(1- arg)`**, not `arg`, and the first branch is
	 *     `(listp arg)` — which is **true of `nil`**, because `nil` is the empty list. A bare
	 *     `C-y` therefore takes the `0` branch and never rotates; had the test been `(consp arg)`
	 *     it would have fallen to `(1- nil)` = -1 and walked the ring backwards, which is the
	 *     single easiest thing in this file to get wrong. `M-2 C-y` gives 1 (the second most
	 *     recent); `M-- C-y` gives -2.
	 *   - **a cons argument rotates 0 and then flips the result**: point goes to the *front* of
	 *     the pasted text and the mark to the back, the opposite of the default. This is
	 *     `C-u C-y`, and it is the reason the cons has to survive the argument channel.
	 *   - **the `t` sentinel** is the shape to copy for any command that changes state and might
	 *     then fail: `yank` sets `this-command` to `t` before the insert and back to `'yank`
	 *     after it, so a `yank` that dies in between leaves `last-command` as `t` and the next
	 *     `M-y` declines to rotate. It is also what an **empty kill ring** produces:
	 *     `current-kill` signals `(error "Kill ring is empty")` (`simple.el:5898`) and
	 *     `last-command` becomes `t`.
	 *   - **the mark ends up inactive**: `push-mark` is called without `activate`, and
	 *     `(if (or activate (not transient-mark-mode)) (set-mark …))` (`simple.el:7549-7550`)
	 *     takes neither branch, so it is not activated — and the insertion deactivates it anyway,
	 *     which is what the source's own comment says ("It is cleaner to avoid activation, even
	 *     though the command loop would deactivate the mark because we inserted text.",
	 *     `simple.el:6460-6462`).
	 */
	#yank(arg: EmacsPrefixArg): void {
		// `(setq this-command t)` — before anything that can go wrong.
		this.#thisCommand = true;
		// `(listp arg)` is true of `nil`, which is what makes a bare `C-y` a no-rotation.
		const isCons = arg !== null && typeof arg === "object";
		const rotate = isCons ? 0 : arg === "-" ? -2 : arg === null ? 0 : arg - 1;
		const pasted = this.#currentKill(rotate);
		if (pasted === null) return; // "Kill ring is empty" — `this-command` stays `t`.
		const text = this.#text();
		const pos = this.#ops.getCursor();
		// `push-mark`: the old mark goes on the ring, the mark becomes point, and it is **not**
		// activated.
		if (this.mark !== null) {
			this.markRing.push(this.mark);
			if (this.markRing.length > MARK_RING_MAX) this.markRing.shift();
		}
		this.mark = pos;
		this.markActive = false;
		this.#write(text.slice(0, pos) + pasted + text.slice(pos), pos + pasted.length);
		// `(if (consp arg) (goto-char (prog1 (mark t) (set-marker (mark-marker) (point)))))` —
		// the old mark becomes point and the new point becomes the mark.
		if (isCons && this.mark !== null) {
			const end = this.#ops.getCursor();
			const front = this.mark;
			this.mark = end;
			this.#ops.setCursor(front);
		}
		// `(if (eq this-command t) (setq this-command 'yank))`
		if (this.#thisCommand === true) this.#thisCommand = CMD.yank;
	}

	/**
	 * `yank-pop` (`M-y`, `simple.el:6355-6401`), spec `"p"`.
	 *
	 * ```elisp
	 * (if (not (eq last-command 'yank))
	 *     (yank-from-kill-ring (read-from-kill-ring "Yank from kill-ring: ")
	 *                          current-prefix-arg)
	 *   (setq this-command 'yank)
	 *   (unless arg (setq arg 1))
	 *   (let ((before (< (point) (mark t))))
	 *     (funcall (or yank-undo-function 'delete-region) (point) (mark t))
	 *     (set-marker (mark-marker) (point) (current-buffer))
	 *     (insert-for-yank (current-kill arg))
	 *     (if before (goto-char (prog1 (mark t) (set-marker (mark-marker) (point))))))
	 * ```
	 *
	 * The gate is on `last-command`, and it is what lets a second `M-y` rotate without asking: the
	 * rotation sets `this-command` back to `'yank`, so a chain of `M-y`s keeps its own state.
	 * `unless arg (setq arg 1)` is why `C-0 M-y` moves one step and not none. And the point/mark
	 * swap in the `before` case is deliberately the *same* swap `yank` does for a cons argument,
	 * so that a rotation leaves the same geometry the original paste did — which is the only way
	 * a second `M-y` knows what to delete.
	 *
	 * The other branch is `yank-from-kill-ring`, which **prompts** — a minibuffer, which this
	 * batch has no shape for. The key is taken, nothing is inserted and nothing is committed, so
	 * that `M-y` on its own does something defined instead of silently pasting the newest kill a
	 * second time. That is a deliberate divergence: in Emacs the prompt eventually inserts
	 * something chosen by the user and `last-command` ends up `yank`; here nothing is inserted, so
	 * claiming `yank` would leave the next `M-y` trying to rotate a yank that never happened.
	 */
	#yankPop(n: number): void {
		if (this.#lastCommand !== CMD.yank) {
			this.#commit = false;
			return;
		}
		this.#thisCommand = CMD.yank;
		const text = this.#text();
		const pos = this.#ops.getCursor();
		const mark = this.mark ?? pos;
		const before = pos < mark;
		// `(unless arg (setq arg 1))` (`simple.el:6380`) fires on `nil` and on nothing else.
		// The `nil` case is already handled upstream — `emacsPrefixValue(null)` is 1 — so this
		// passes `n` straight through, and the reason to write it down is the trap it avoids:
		// in Lisp `0` is truthy, so `C-0 M-y` rotates **zero** and re-pastes the entry it is
		// already showing. Written the way the lisp reads — `n || 1` — JavaScript's falsy `0`
		// would turn that into a rotation of one and `C-0 M-y` would move a kill the user
		// explicitly asked it to leave alone.
		const pasted = this.#currentKill(n);
		if (pasted === null) return;
		// The previous yank's stretch is the region between point and mark, and it goes before
		// the new text goes in. Both arguments of `delete-region` are usable in either order.
		const beg = Math.min(pos, mark);
		const end = Math.max(pos, mark);
		// `(set-marker (mark-marker) (point))` — the mark becomes where the old text started;
		// then the insert; then, for the `before` case only, point and mark swap.
		this.mark = beg;
		this.#write(text.slice(0, beg) + pasted + text.slice(end), beg + pasted.length);
		if (before) {
			const tail = this.#ops.getCursor();
			this.mark = tail;
			this.#ops.setCursor(beg);
		}
	}

	// -- character and word motion ------------------------------------------

	/**
	 * `forward-char` (`C-f`, `src/cmds.c:69-81`): a count moves that many *characters*, and the
	 * buffer edge is a clamp **plus a signal** — `move_point` does `SET_PT (ZV)` and only then
	 * `xsignal0 (Qend_of_buffer)` (`src/cmds.c:59-63`), so the count neither wraps nor stops
	 * early, the point is left at the end, and the signal means the tail of the command loop is
	 * never reached: `last-command` keeps whatever the previous key left behind. That is
	 * observable, and it is why the edge press here is not the same as a successful move.
	 *
	 * Note this is *not* what `forward-word` does — see {@link #forwardWord}.
	 */
	#forwardChar(n: number): void {
		const text = this.#text();
		let pos = this.#ops.getCursor();
		for (let i = 0; i < n; i++) {
			if (pos >= text.length) {
				this.#commit = false;
				break;
			}
			pos = advance(text, pos);
		}
		this.#ops.setCursor(pos);
	}

	/**
	 * `backward-char` (`C-b`, `src/cmds.c:83-95`): the mirror, and it clamps at the start with
	 * `xsignal0 (Qbeginning_of_buffer)` on the same terms (`src/cmds.c:55-58`).
	 */
	#backwardChar(n: number): void {
		const text = this.#text();
		let pos = this.#ops.getCursor();
		for (let i = 0; i < n; i++) {
			if (pos <= 0) {
				this.#commit = false;
				break;
			}
			pos = retreat(text, pos);
		}
		this.#ops.setCursor(pos);
	}

	/**
	 * `forward-word` (`M-f`): `scan_words` for a positive count, its mirror for a negative one.
	 *
	 * `Fforward_word` (`src/syntax.c:1600-1616`) clamps the same way but **does not signal** — it
	 * falls back to `ZV`/`BEGV` when `scan_words` returns 0 and returns `nil` — so unlike
	 * {@link #forwardChar} an edge press here *is* recorded as the command that ran. Its
	 * `find-word-boundary-function-table` hook (`src/syntax.c:1591-1593`) is deliberately not
	 * implemented; see the header.
	 */
	#forwardWord(n: number): number {
		const text = this.#text();
		const pos = this.#ops.getCursor();
		return this.#clamp(n >= 0 ? emacsWordForward(text, pos, n) : emacsWordBackward(text, pos, -n));
	}

	/**
	 * `backward-word` (`M-b`, `simple.el:8947-8960`):
	 *
	 * ```elisp
	 * (defun backward-word (&optional arg) (interactive "^p")
	 *   (forward-word (- (or arg 1))))
	 * ```
	 *
	 * The `^` is not an argument modifier — it is `handle_shift_selection`
	 * (`src/callint.c:407-408`), consumed in the first modifier loop, and the `p` behind it is
	 * still `Fprefix_numeric_value` (`src/callint.c:651-653`). So `arg` is a **number** by the
	 * time the body sees it, and `(- '(4))` cannot happen from a keystroke; what the body's
	 * unary `-` produces is `-4`, and `forward-word`'s `CHECK_FIXNUM` (`src/syntax.c:1603`) has
	 * nothing to catch. That is what the `^` is for, and why this negates a number rather than a
	 * prefix argument. {@link emacsPrefixMinus} is the version that keeps the cons, for callers
	 * that do get one — and there are none yet, which is why it is exported and not on any
	 * command path.
	 */
	#backwardWord(n: number): number {
		const text = this.#text();
		const pos = this.#ops.getCursor();
		return this.#clamp(n >= 0 ? emacsWordBackward(text, pos, n) : emacsWordForward(text, pos, -n));
	}

	// -- vertical motion -----------------------------------------------------

	/**
	 * `next-line` / `previous-line` (`C-n` / `C-p`, `bindings.el:1343-1344`), both through
	 * `line-move-1` (`simple.el:8203-8332`) with `noerror` nil (`simple.el:7775`), which matters:
	 * it is what decides between clamping and signalling.
	 *
	 * The goal column is where Emacs and vim differ, and the difference is one test
	 * (`simple.el:8216-8223`):
	 *
	 * ```elisp
	 * (if (not (memq last-command '(next-line previous-line)))
	 *     (setq temporary-goal-column
	 *           (if (and track-eol (eolp)
	 *                    (or (not (bolp)) (eq last-command 'move-end-of-line)))
	 *               most-positive-fixnum
	 *             (current-column))))
	 * ```
	 *
	 * Sticky **only** for the two line motions. *Every* other command re-seeds it, `C-e` and `C-f`
	 * and `M-f` included — where vim's `curswant` survives a horizontal motion. `track-eol` is
	 * `nil` by default (`simple.el:7811-7817`), so the re-seed is the current column and the
	 * `most-positive-fixnum` branch is unreachable; it is written out because the guard *inside*
	 * it is the interesting half, and because `move-end-of-line` does reach `line-move`
	 * (`simple.el:8488-8489`), with `goal-column` bound to 0.
	 *
	 * Three behaviours, and only one of them is a clamp:
	 *
	 *   - **landing on a shorter line clamps to its end**, in **both** directions, because the
	 *     landing is `line-move-finish` → `line-move-to-column` → `move-to-column`, and "If it's
	 *     past end of line, point goes to end of line" (`src/indent.c:1125-1126`). Moving *up*
	 *     onto a short line therefore stops at its **end**, not at its beginning — which is the
	 *     opposite of what a plan written from memory predicts, and the reason the
	 *     downward-short/upward-short pair in the tests assert EOL both times.
	 *   - **running off the bottom clamps to the end of the last line**, but only when that line
	 *     is non-empty. `forward-line` counts "a non-empty line at the end of the buffer ... as
	 *     one line successfully moved" (`src/cmds.c:108-113`), which zeroes the shortfall and
	 *     routes the move through `line-move-finish`. On an *empty* last line there is nothing to
	 *     count, `arg` stays non-zero, and `:8240-8244` signals `end-of-buffer`.
	 *   - **running off the top always signals** `beginning-of-buffer` and changes nothing. There
	 *     is no "clamp to beginning of line" path for `C-n`/`C-p` at all: the `((< arg 0) …
	 *     line-beginning-position)` arm at `:8322-8328` is only reachable with `noerror` non-nil,
	 *     and `next-line` / `previous-line` pass nil. A signal also leaves `last-command`
	 *     standing, because `command_loop_1`'s tail (`src/keyboard.c:1579-1580`) is not reached.
	 *
	 * `next-line-add-newlines` is `nil` (`simple.el:7730-7734`), so `C-n` at the end of the
	 * buffer does **not** open a line.
	 *
	 * `goal-column` proper — the permanent one `C-x n` sets — is a later batch, so
	 * `line-move-finish`'s `(or goal-column temporary-goal-column)` (`simple.el:8330`) collapses
	 * to the second term and is written that way here. `current-column` is a display column; this
	 * engine has no display layer, so it counts characters — the same number for everything a
	 * prompt buffer can hold, and named here because it is a choice rather than a transcription.
	 */
	#lineMove(down: boolean, n: number): void {
		const text = this.#text();
		const pos = this.#ops.getCursor();
		if (this.#lastCommand !== CMD.nextLine && this.#lastCommand !== CMD.previousLine) {
			this.#temporaryGoalColumn = this.#currentColumn(text, pos);
		}
		const goal = this.#temporaryGoalColumn;
		const line = lineOf(text, pos);
		const target = down ? line + n : line - n;
		if (target < 0) {
			// `(and (zerop (forward-line arg)) (bolp) (setq arg 0))` fails on the first line,
			// so `:8240-8244` signals `beginning-of-buffer`: nothing moves and `last-command`
			// stands.
			this.#commit = false;
			return;
		}
		if (target >= lineCount(text)) {
			const last = lineCount(text) - 1;
			const lastStart = nthLineStart(text, last);
			if (lineEndExclusive(text, lastStart) === lastStart) {
				// An empty last line: there is nothing for `forward-line` to count as a line
				// moved, the shortfall stays non-zero, and `:8240-8244` signals `end-of-buffer`.
				// A buffer that ends in a line break is the case — "ab\ncd\n" has three lines
				// and the third is the empty one.
				this.#commit = false;
				return;
			}
			// A non-empty last line: `forward-line` moves point as far as it can — to the end of
			// the buffer — and counts it, and `line-move-finish` then applies the goal column
			// **to that line**, clamped to its end. Landing on the *current* line's end instead
			// would be a different command: a `C-u C-n` that overshoots belongs on the last
			// line, not on the one it started from.
			this.#landOn(text, last, goal);
			return;
		}
		this.#landOn(text, target, goal);
	}

	/**
	 * `line-move-finish` (`simple.el:8333-8428`) reduced to what is left once
	 * `goal-column` proper — the permanent one `C-x n` sets, a later batch — collapses
	 * `line-move-finish`'s `(or goal-column temporary-goal-column)` (`simple.el:8330`) to its
	 * second term: land on the line's start, advance by the goal column, and let
	 * `move-to-column` put point at the end of the line if the column runs past it
	 * (`src/indent.c:1125-1126`). That last clamp is the whole reason a move onto a shorter
	 * line stops at its **end** in both directions.
	 */
	#landOn(text: string, line: number, goal: number): void {
		const start = nthLineStart(text, line);
		const end = lineEndExclusive(text, start);
		this.#ops.setCursor(start + Math.min(goal, end - start));
	}

	/**
	 * `current-column`: Emacs's is a **display** column, which would mean the terminal's idea of
	 * a wide glyph's width. This engine is a text buffer with no display layer, so it counts
	 * characters — the same number for everything the host can put in a prompt, and named here
	 * because it is a choice rather than a transcription.
	 */
	#currentColumn(text: string, pos: number): number {
		const start = lineStart(text, pos);
		let col = 0;
		for (let i = start; i < pos; i = advance(text, i)) col++;
		return col;
	}
}

/**
 * The one replaced span between two versions of the buffer, as `[from, oldEnd, newEnd]`: the text
 * `[from, oldEnd)` of `a` became `[from, newEnd)` of `b`. Found by the longest common prefix and
 * suffix, which is exact for every write this engine makes — each one replaces a single contiguous
 * range.
 */
function replacedSpan(a: string, b: string): [number, number, number] {
	const max = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (suffix < max - prefix && a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)) suffix++;
	return [prefix, a.length - suffix, prefix + (b.length - suffix)];
}
