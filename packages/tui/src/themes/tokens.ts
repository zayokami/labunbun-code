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
	success: string;
	warning: string;
	error: string;
	/**
	 * Permission prompts. Deliberately distinct from `warning`: this means
	 * "waiting on your decision", not "something went wrong".
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
	/** File paths. */
	path: string;
	/** URLs. */
	link: string;
	/** Foreground of the selected row in a list or dialog. */
	selection: string;
	/** General-purpose border: dialogs, the prompt input. */
	border: string;
	/** Text cursor. */
	cursor: string;
	/** Primary accent. */
	accent: string;

	// ---- aliases ----
	/**
	 * Same value as `accent`. Kept so existing components keep working; new
	 * code should read `accent`.
	 */
	primary: string;
	/** Same value as `textMuted`. New code should read `textMuted`. */
	dim: string;
	/** Same value as `userInput`. New code should read `userInput`. */
	userMessage: string;

	// ---- non-color encoding ----
	/**
	 * State must be distinguishable without color: a red/green colorblind
	 * reader cannot tell success from error by hue, and neither can anyone
	 * piping output through a tool that strips ANSI.
	 */
	marks: ThemeMarks;
	bold: ThemeBold;
}

/** A theme with the alias tokens omitted — `defineTheme` fills them in. */
export type ThemeSpec = Omit<Theme, "primary" | "dim" | "userMessage">;

/**
 * Build a theme from its canonical tokens, deriving the compatibility aliases
 * so the two spellings of a token can never drift apart.
 */
export function defineTheme(spec: ThemeSpec): Theme {
	return { ...spec, primary: spec.accent, dim: spec.textMuted, userMessage: spec.userInput };
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
 * restating the others, and the aliases are recomputed from whatever the
 * result's canonical tokens ended up being — overriding `accent` alone still
 * moves `primary` with it.
 */
export function deriveTheme(base: Theme, overrides: ThemeOverrides): Theme {
	const merged: Theme = {
		...base,
		...overrides,
		marks: { ...base.marks, ...overrides.marks },
		bold: { ...base.bold, ...overrides.bold },
		syntax: { ...base.syntax, ...overrides.syntax },
	};
	return {
		...merged,
		primary: overrides.primary ?? merged.accent,
		dim: overrides.dim ?? merged.textMuted,
		userMessage: overrides.userMessage ?? merged.userInput,
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
	"cursor",
	"accent",
	"primary",
	"dim",
	"userMessage",
	"marks",
	"bold",
];
