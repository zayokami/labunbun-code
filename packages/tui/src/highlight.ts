/**
 * Minimal syntax highlighting for fenced code blocks.
 *
 * A terminal transcript needs far less than an editor: five token classes are
 * enough to make code scannable, and anything finer is wasted on a 256-color
 * grid. So this is a hand-written scanner over a per-language keyword set
 * rather than a real parser or a highlighting dependency — it never has to be
 * correct enough to compile, only correct enough to read.
 *
 * The scanner is single-pass and stateful across lines, because the one thing a
 * per-line tokenizer gets visibly wrong is a block comment: `/*` on line 1
 * means line 2 is still a comment, and coloring line 2 as code makes the block
 * look broken. Strings deliberately do NOT continue across lines (except where
 * a language's raw strings do), since an unterminated quote is much more often
 * a typo than a multiline string.
 */

/** What a run of code text is, semantically. Maps onto one theme token each. */
export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "function";

export interface CodeToken {
	text: string;
	kind: TokenKind;
}

interface LanguageRules {
	keywords: Set<string>;
	/** Line-comment introducers, longest first so `///` beats `//`. */
	lineComment: string[];
	/** Block comment delimiters, if the language has them. */
	blockComment?: { open: string; close: string };
	/** Quote characters that start a string. */
	quotes: string[];
	/** Whether `#` starts a comment (shell, python, ruby, yaml...). */
	hashComment?: boolean;
}

const C_LIKE_KEYWORDS = [
	"as",
	"async",
	"await",
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"from",
	"function",
	"get",
	"if",
	"implements",
	"import",
	"in",
	"instanceof",
	"interface",
	"let",
	"new",
	"null",
	"of",
	"private",
	"protected",
	"public",
	"readonly",
	"return",
	"satisfies",
	"set",
	"static",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"type",
	"typeof",
	"undefined",
	"var",
	"void",
	"while",
	"yield",
];

const PYTHON_KEYWORDS = [
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"False",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"None",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"True",
	"try",
	"while",
	"with",
	"yield",
];

const RUST_KEYWORDS = [
	"as",
	"async",
	"await",
	"break",
	"const",
	"continue",
	"crate",
	"dyn",
	"else",
	"enum",
	"extern",
	"false",
	"fn",
	"for",
	"if",
	"impl",
	"in",
	"let",
	"loop",
	"match",
	"mod",
	"move",
	"mut",
	"pub",
	"ref",
	"return",
	"self",
	"Self",
	"static",
	"struct",
	"super",
	"trait",
	"true",
	"type",
	"unsafe",
	"use",
	"where",
	"while",
];

const GO_KEYWORDS = [
	"break",
	"case",
	"chan",
	"const",
	"continue",
	"default",
	"defer",
	"else",
	"fallthrough",
	"for",
	"func",
	"go",
	"goto",
	"if",
	"import",
	"interface",
	"map",
	"package",
	"range",
	"return",
	"select",
	"struct",
	"switch",
	"type",
	"var",
];

const SHELL_KEYWORDS = [
	"case",
	"do",
	"done",
	"elif",
	"else",
	"esac",
	"export",
	"fi",
	"for",
	"function",
	"if",
	"in",
	"local",
	"return",
	"then",
	"until",
	"while",
];

const SQL_KEYWORDS = [
	"and",
	"as",
	"asc",
	"by",
	"create",
	"delete",
	"desc",
	"distinct",
	"drop",
	"from",
	"group",
	"having",
	"insert",
	"into",
	"join",
	"left",
	"limit",
	"not",
	"null",
	"on",
	"or",
	"order",
	"outer",
	"select",
	"set",
	"table",
	"update",
	"values",
	"where",
];

function rules(keywords: string[], overrides: Partial<Omit<LanguageRules, "keywords">> = {}): LanguageRules {
	return {
		keywords: new Set(keywords),
		lineComment: overrides.lineComment ?? ["//"],
		blockComment: "blockComment" in overrides ? overrides.blockComment : { open: "/*", close: "*/" },
		quotes: overrides.quotes ?? ['"', "'", "`"],
		hashComment: overrides.hashComment,
	};
}

const C_LIKE = rules(C_LIKE_KEYWORDS);

/**
 * Language rules by fence tag. Unknown tags fall back to `null`, which renders
 * the block as plain text — a wrong guess is worse than no highlighting, since
 * mis-colored code reads as broken code.
 */
const LANGUAGES: Record<string, LanguageRules> = {
	ts: C_LIKE,
	tsx: C_LIKE,
	typescript: C_LIKE,
	js: C_LIKE,
	jsx: C_LIKE,
	javascript: C_LIKE,
	mjs: C_LIKE,
	cjs: C_LIKE,
	json: rules([], { lineComment: [], blockComment: undefined, quotes: ['"'] }),
	java: C_LIKE,
	c: C_LIKE,
	cpp: C_LIKE,
	cs: C_LIKE,
	css: rules([], { lineComment: [], quotes: ['"', "'"] }),
	go: rules(GO_KEYWORDS, { quotes: ['"', "`"] }),
	rust: rules(RUST_KEYWORDS),
	rs: rules(RUST_KEYWORDS),
	py: rules(PYTHON_KEYWORDS, { lineComment: [], blockComment: undefined, hashComment: true }),
	python: rules(PYTHON_KEYWORDS, { lineComment: [], blockComment: undefined, hashComment: true }),
	rb: rules(PYTHON_KEYWORDS, { lineComment: [], blockComment: undefined, hashComment: true }),
	sh: rules(SHELL_KEYWORDS, { lineComment: [], blockComment: undefined, hashComment: true }),
	bash: rules(SHELL_KEYWORDS, { lineComment: [], blockComment: undefined, hashComment: true }),
	zsh: rules(SHELL_KEYWORDS, { lineComment: [], blockComment: undefined, hashComment: true }),
	shell: rules(SHELL_KEYWORDS, { lineComment: [], blockComment: undefined, hashComment: true }),
	yaml: rules([], { lineComment: [], blockComment: undefined, hashComment: true, quotes: ['"', "'"] }),
	yml: rules([], { lineComment: [], blockComment: undefined, hashComment: true, quotes: ['"', "'"] }),
	toml: rules([], { lineComment: [], blockComment: undefined, hashComment: true, quotes: ['"', "'"] }),
	sql: rules(SQL_KEYWORDS, { lineComment: ["--"], quotes: ["'", '"'] }),
};

/** Whether a fence tag has highlighting rules. */
export function isSupportedLanguage(language: string): boolean {
	return language.toLowerCase() in LANGUAGES;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Tokenize the lines of one fenced block. Returns one token array per input
 * line, so the renderer keeps its one-Text-per-line structure and line numbers
 * stay aligned. Concatenating every token's `text` reproduces the input
 * exactly — a highlighter that drops characters silently corrupts code the user
 * is about to copy.
 */
export function highlightCode(lines: string[], language: string): CodeToken[][] {
	const rule = LANGUAGES[language.toLowerCase()];
	if (!rule) return lines.map((line) => (line ? [{ text: line, kind: "plain" as const }] : []));

	const out: CodeToken[][] = [];
	// Block comments are the only state that survives a line break.
	let inBlockComment = false;

	for (const line of lines) {
		const tokens: CodeToken[] = [];
		let plain = "";
		const flush = () => {
			if (plain) tokens.push({ text: plain, kind: "plain" });
			plain = "";
		};
		let i = 0;

		while (i < line.length) {
			if (inBlockComment) {
				const close = rule.blockComment ? line.indexOf(rule.blockComment.close, i) : -1;
				if (close === -1) {
					tokens.push({ text: line.slice(i), kind: "comment" });
					i = line.length;
				} else {
					const end = close + (rule.blockComment?.close.length ?? 0);
					tokens.push({ text: line.slice(i, end), kind: "comment" });
					i = end;
					inBlockComment = false;
				}
				continue;
			}

			const rest = line.slice(i);

			if (rule.blockComment && rest.startsWith(rule.blockComment.open)) {
				flush();
				inBlockComment = true;
				continue;
			}

			// The rest of the line is a comment.
			const lineCommentMarker =
				rule.lineComment.find((marker) => rest.startsWith(marker)) ??
				(rule.hashComment && rest[0] === "#" ? "#" : null);
			if (lineCommentMarker) {
				flush();
				tokens.push({ text: rest, kind: "comment" });
				i = line.length;
				continue;
			}

			if (rule.quotes.includes(rest[0])) {
				const quote = rest[0];
				let j = 1;
				while (j < rest.length) {
					if (rest[j] === "\\") {
						j += 2;
						continue;
					}
					if (rest[j] === quote) {
						j++;
						break;
					}
					j++;
				}
				flush();
				// An unterminated quote takes the rest of the line and no more: the
				// alternative is one typo tinting every line below it.
				tokens.push({ text: rest.slice(0, Math.min(j, rest.length)), kind: "string" });
				i += Math.min(j, rest.length);
				continue;
			}

			// A number, but not the tail of an identifier like `utf8`.
			if (/[0-9]/.test(rest[0]) && !(i > 0 && IDENT_PART.test(line[i - 1]))) {
				const match = /^(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)n?/.exec(rest);
				if (match) {
					flush();
					tokens.push({ text: match[0], kind: "number" });
					i += match[0].length;
					continue;
				}
			}

			if (IDENT_START.test(rest[0])) {
				let j = 1;
				while (j < rest.length && IDENT_PART.test(rest[j])) j++;
				const word = rest.slice(0, j);
				flush();
				if (rule.keywords.has(word)) {
					tokens.push({ text: word, kind: "keyword" });
				} else if (rest[j] === "(") {
					// Call or declaration site. Close enough for a transcript, and it is
					// what makes the shape of unfamiliar code readable at a glance.
					tokens.push({ text: word, kind: "function" });
				} else {
					tokens.push({ text: word, kind: "plain" });
				}
				i += j;
				continue;
			}

			plain += rest[0];
			i++;
		}
		flush();
		out.push(tokens);
	}
	return out;
}
