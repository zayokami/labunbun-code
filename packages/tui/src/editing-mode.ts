/**
 * Which editing model the prompt is in, decided once.
 *
 * Vim and Emacs are not two settings for one feature. Vim is modal — a state the
 * buffer is in, with a mode line to say so, and a key that has to mean something
 * different depending on it. Emacs is modeless — there is no mode to be in, and
 * a key that means something different depending on one would be a bug. So they
 * are separate keys in the settings and a single decision here, and every caller
 * that needs to know reads this rather than asking the settings again.
 *
 * That matters because the two callers are in different layers and were
 * previously both reading `settings.vimMode` directly: the input hook, which
 * builds the engine, and the app layer, which seeds the store and prints the
 * answer in `/status`. A second editor added to only one of them is the shape of
 * bug this file exists to make impossible — one answer, both callers, and a test
 * that says they got the same one.
 *
 * It lives here, in the package that owns the state, rather than in the app layer
 * that owns the settings: the input hook is the one caller that cannot import
 * upward, so a rule kept above it would have to be copied into the TUI to be
 * usable at all, and the copy is the bug. The app layer imports it from
 * `@labunbun/tui`, which it already depends on for `mountRepl`.
 *
 * Setting both is not an error. It is a state with a right answer (Emacs wins,
 * because it is the one that was asked for second and a modal buffer that
 * suddenly stops being modal is the worse surprise) and something to *say* about,
 * which is what `shadowed` is for: a user who turns on Emacs over Vim and gets no
 * word about it will file the second one as broken. Only a hand-edited settings
 * file can produce it — the commands clear the other key — so this is the safety
 * net under a file, not a state the UI walks into on its own.
 */

export type EditorKind = "none" | "vim" | "emacs";

/** What the settings asked for, as far as this layer can tell. */
export interface EditingModeInput {
	vimMode?: boolean;
	emacsMode?: boolean;
}

export interface EditingMode {
	/** The model the prompt is in. */
	mode: EditorKind;
	/**
	 * Which setting asked for the answer, when one of them did. A caller that
	 * toggles the editor wants to name the key it is about to write, and the
	 * other one is the key whose value is currently being overridden.
	 */
	chosen: "vimMode" | "emacsMode" | null;
	/** The other key, if it was also on. Null in every ordinary case. */
	shadowed: "vimMode" | "emacsMode" | null;
}

/**
 * The answer, from the settings alone.
 *
 * `emacsMode` wins over `vimMode` when both are set. Emacs is modeless, so
 * turning it on has to *remove* the modal state rather than add a second one
 * beside it — a prompt that is both would answer `C-f` as vim's and as emacs's
 * depending on which engine was constructed last, and neither is a thing anyone
 * asked for. Which of the two should lose is a judgement; that the loser has to
 * be reported rather than silently dropped is not.
 */
export function resolveEditingMode(settings: EditingModeInput): EditingMode {
	const vim = settings.vimMode === true;
	const emacs = settings.emacsMode === true;
	if (emacs) {
		return { mode: "emacs", chosen: "emacsMode", shadowed: vim ? "vimMode" : null };
	}
	if (vim) {
		return { mode: "vim", chosen: "vimMode", shadowed: null };
	}
	return { mode: "none", chosen: null, shadowed: null };
}

/**
 * The editor, in the words `/status` puts on a card.
 *
 * Names the winner rather than listing the flags, because a card that said
 * "Vim off · Emacs off" is a sentence about settings and a card that says
 * "Emacs" is a sentence about the prompt. The shadowed key is named too when
 * there is one: both being set is reachable by hand-editing the file, and a
 * user staring at a card that says Emacs while their file says both has no way
 * to tell that the file is not wrong.
 */
export function describeEditor(editor: EditingMode): string {
	if (editor.mode === "none") return "no editor";
	const name = editor.mode === "vim" ? "Vim" : "Emacs";
	return editor.shadowed ? `${name} (${editor.shadowed} also set)` : name;
}

/**
 * The other key, for a caller that is about to turn one of them on or off.
 *
 * `/vim on` while Emacs is up is not a request for a modal editor: it is a
 * request for Emacs to stop being special, and the only way to express that with
 * two independent booleans is to clear the other one. Returns the key to clear,
 * or null when there is nothing to clear.
 */
export function opposingEditorKey(kind: "vimMode" | "emacsMode"): "vimMode" | "emacsMode" {
	return kind === "vimMode" ? "emacsMode" : "vimMode";
}

/**
 * The line `/emacs` and `/vim` say when one key had to be cleared to set the
 * other. Undefined in the ordinary case, so a caller can append it and leave the
 * sentence alone.
 */
export function editorShadowNotice(
	settings: EditingModeInput,
	kind: "vimMode" | "emacsMode",
	next: boolean,
): string | undefined {
	if (!next) return undefined;
	const other = opposingEditorKey(kind);
	return settings[other] === true ? `cleared ${other}, which was also on` : undefined;
}
