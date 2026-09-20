/**
 * The theme token contract. Components consume semantic names through
 * `ThemeContext`, never raw color names — that is what makes a theme swap a
 * single provider change instead of an audit of every component.
 *
 * Every token below is documented because this interface is the whole
 * specification a third-party theme author has to work from. A token whose
 * meaning is unclear gets used for the wrong thing, and the theme then breaks
 * whenever that component changes.
 *
 * Values are anything Ink accepts: a named color (`"red"`), a hex string
 * (`"#d55e00"`), or `rgb(r,g,b)`. Named colors follow the terminal's own
 * palette, which is usually what you want for a theme meant to blend in; hex
 * values render identically everywhere, which is what you want when the exact
 * shade carries meaning (contrast ratios, colorblind-safe palettes).
 */

/** Symbols that encode state without relying on color. */
export interface ThemeMarks {
	/** Prefix for a completed/succeeded item. */
	success: string;
	/** Prefix for a warning. */
	warning: string;
	/** Prefix for a failure. */
	error: string;
	/** Prefix for a not-yet-started item. */
	pending: string;
	/** Cursor for the highlighted row of a list or dialog. */
	selected: string;
	/** Column separator in a rendered table. */
	tableColumn: string;
}

/** Which state text renders bold. Weight is the second non-color channel. */
export interface ThemeBold {
	error: boolean;
	warning: boolean;
	success: boolean;
}

/** Colors for the five syntax classes a fenced code block is split into. */
export interface ThemeSyntax {
	/** Language keywords (`const`, `def`, `fn`). */
	keyword: string;
	/** String and character literals, including their quotes. */
	string: string;
	/** Line and block comments. */
	comment: string;
	/** Numeric literals. */
	number: string;
	/** Identifiers in a call or declaration position. */
	function: string;
}

export interface Theme {
	/** Theme identifier, as used by `theme` in settings and by `/theme <name>`. */
	name: string;
	/**
	 * The background this theme was designed against. Does not affect
	 * rendering — `auto` uses it to pick a theme, and it tells a reader which
	 * way the contrast was meant to run.
	 */
	appearance: "dark" | "light";

	// ---- text ----
	/** Body text, including assistant prose. */
	text: string;
	/** Secondary text: hints, metadata, anything subordinate to `text`. */
	textMuted: string;
	/** The user's own submitted prompt in the transcript. */
	userInput: string;
	/** Extended-thinking stream. */
	thinking: string;

	// ---- tools ----
	/** Tool name in a tool-call header. */
	toolName: string;
	/** The argument preview beside the tool name. */
	toolArgs: string;
	/** Tool result body. */
	toolOutput: string;
	/** Border around a tool-call block. */
	toolBorder: string;

	// ---- state ----
	/**
	 * The state colors. `error` is the only one a row renders today — the entry
	 * model is user, assistant, toolUse, error and info, and only `error` is a
	 * state — but the colorblind palettes pick their success and warning hues
	 * deliberately (blue against yellow where green against red would not read),
	 * so the contract keeps them rather than making every palette restate that
	 * work the day the row arrives. Nothing reads them yet; that is the whole
	 * of what is wrong with them.
	 */
	success: string;
	warning: string;
	error: string;
	/**
	 * Permission prompts. Deliberately distinct from `warning` (this means
	 * "waiting on your decision", not "something went wrong") and from `accent`
	 * (a prompt for you is not ordinary chrome) — `themes.test.ts` holds every
	 * built-in to both.
	 */
	permission: string;
	/** Queued or not-yet-started work. */
	pending: string;

	// ---- diff and code ----
	/** Added lines (`+`). */
	diffAdded: string;
	/** Removed lines (`-`). */
	diffRemoved: string;
	/** Hunk headers (`@@`). */
	diffHeader: string;
	/** Body text inside a fenced code block, and any unhighlighted run of it. */
	codeText: string;
	/** Border around a fenced code block. */
	codeBorder: string;
	/**
	 * Syntax colors for highlighted code. Only fenced blocks with a recognized
	 * language tag are highlighted; everything else stays `codeText`.
	 */
	syntax: ThemeSyntax;

	// ---- tables ----
	/** Table header text. */
	tableHeader: string;
	/** Table rules and column separators. */
	tableBorder: string;

	// ---- structure ----
	/**
	 * File paths. Nothing renders it yet — a path in prose or in tool output
	 * goes through `link` and `toolArgs` — and it is kept for the same reason
	 * as `success`: a palette that has decided what a path should look like
	 * should not have to decide again.
	 */
	path: string;
	/** URLs. */
	link: string;
	/** Foreground of the selected row in a list or dialog. */
	selection: string;
	/** General-purpose border: dialogs, the prompt input. */
	border: string;
	/** Primary accent. */
	accent: string;

	// ---- non-color encoding ----
	/**
	 * State must be distinguishable without color: a red/green colorblind
	 * reader cannot tell success from error by hue, and neither can anyone
	 * piping output through a tool that strips ANSI. `marks.success`,
	 * `marks.warning`, `marks.pending` and the `bold.success`/`bold.warning`
	 * flags are waiting on the same rows as the colors above.
	 */
	marks: ThemeMarks;
	bold: ThemeBold;
}

/** Overrides accepted by `deriveTheme`: any token, with partial nested groups. */
export type ThemeOverrides = Partial<Omit<Theme, "marks" | "bold" | "syntax">> & {
	marks?: Partial<ThemeMarks>;
	bold?: Partial<ThemeBold>;
	syntax?: Partial<ThemeSyntax>;
};

/**
 * Derive a variant from an existing theme. `marks`, `bold` and `syntax` merge
 * per key so a variant can change one symbol or one syntax color without
 * restating the others.
 */
export function deriveTheme(base: Theme, overrides: ThemeOverrides): Theme {
	return {
		...base,
		...overrides,
		marks: { ...base.marks, ...overrides.marks },
		bold: { ...base.bold, ...overrides.bold },
		syntax: { ...base.syntax, ...overrides.syntax },
	};
}

/** Token keys, for validating third-party theme files against the contract. */
export const THEME_TOKEN_KEYS: ReadonlyArray<keyof Theme> = [
	"name",
	"appearance",
	"text",
	"textMuted",
	"userInput",
	"thinking",
	"toolName",
	"toolArgs",
	"toolOutput",
	"toolBorder",
	"success",
	"warning",
	"error",
	"permission",
	"pending",
	"diffAdded",
	"diffRemoved",
	"diffHeader",
	"codeText",
	"codeBorder",
	"syntax",
	"tableHeader",
	"tableBorder",
	"path",
	"link",
	"selection",
	"border",
	"accent",
	"marks",
	"bold",
];
