/**
 * The subset of Markdown a terminal transcript can usefully show.
 *
 * Parsing is split from rendering so the hard part — inline marks, which nest
 * and can be left unterminated by a truncated stream — is plain data that can be
 * tested without a renderer. Anything unrecognized stays verbatim: a transcript
 * that silently eats characters is worse than one that shows a stray asterisk.
 */

/** A run of text carrying the marks that apply to it. */
export interface InlineSpan {
	text: string;
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
	strike?: boolean;
	/** Set when the span came from `[label](href)`. */
	href?: string;
}

export type Block =
	| { kind: "paragraph"; spans: InlineSpan[] }
	| { kind: "heading"; level: number; spans: InlineSpan[] }
	| { kind: "listItem"; marker: string; indent: number; spans: InlineSpan[] }
	| { kind: "quote"; spans: InlineSpan[] }
	| { kind: "code"; language: string; lines: string[] }
	| { kind: "rule" }
	| { kind: "blank" };

/** Inline code spans a backtick run of the same length, so `` `a` `` nests. */
const CODE_RE = /^(`+)([\s\S]*?)\1/;

/**
 * Inline marks, left to right. Code is matched first because its contents are
 * literal — `` `**not bold**` `` must survive as written.
 */
export function parseInline(text: string): InlineSpan[] {
	const spans: InlineSpan[] = [];
	let buffer = "";

	const flush = () => {
		if (buffer) spans.push({ text: buffer });
		buffer = "";
	};
	/** Marks apply to the whole nested parse, so `**a _b_**` keeps both. */
	const nested = (inner: string, mark: Partial<InlineSpan>) => {
		flush();
		for (const span of parseInline(inner)) spans.push({ ...span, ...mark });
	};

	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i);

		// Escapes: a backslash makes the next character literal.
		if (rest[0] === "\\" && rest.length > 1) {
			buffer += rest[1];
			i += 2;
			continue;
		}

		const code = CODE_RE.exec(rest);
		if (code) {
			flush();
			// A single leading and trailing space is padding, per CommonMark, so
			// `` ` `` can be written as `` ` ` ``.
			spans.push({ text: code[2].replace(/^ (.*) $/, "$1"), code: true });
			i += code[0].length;
			continue;
		}

		const link = /^\[([^\]]*)\]\(([^)\s]*)\)/.exec(rest);
		if (link) {
			flush();
			const label = link[1] || link[2];
			for (const span of parseInline(label)) spans.push({ ...span, href: link[2] });
			i += link[0].length;
			continue;
		}

		const strike = /^~~([\s\S]+?)~~/.exec(rest);
		if (strike) {
			nested(strike[1], { strike: true });
			i += strike[0].length;
			continue;
		}

		const bold = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest);
		if (bold) {
			nested(bold[2], { bold: true });
			i += bold[0].length;
			continue;
		}

		// Single-character emphasis. The lookarounds keep `a * b` and snake_case
		// identifiers from being read as marks.
		const italic = /^(\*|_)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest);
		if (italic && !(italic[1] === "_" && /\w$/.test(text.slice(0, i)))) {
			nested(italic[2], { italic: true });
			i += italic[0].length;
			continue;
		}

		buffer += rest[0];
		i += 1;
	}
	flush();
	return spans;
}

/**
 * Split text into blocks. Fenced code wins over everything inside it, and an
 * unterminated fence still yields its lines — the streaming case, where the
 * closing fence has not arrived yet.
 */
export function parseBlocks(text: string): Block[] {
	const out: Block[] = [];
	const lines = text.split("\n");
	let fence: { marker: string; language: string; lines: string[] } | null = null;

	for (const line of lines) {
		const fenceMatch = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
		if (fence) {
			// Only a fence of the same character closes the block.
			if (fenceMatch && fenceMatch[1][0] === fence.marker[0] && fenceMatch[1].length >= fence.marker.length) {
				out.push({ kind: "code", language: fence.language, lines: fence.lines });
				fence = null;
			} else {
				fence.lines.push(line);
			}
			continue;
		}
		if (fenceMatch) {
			fence = { marker: fenceMatch[1], language: fenceMatch[2], lines: [] };
			continue;
		}

		if (!line.trim()) {
			out.push({ kind: "blank" });
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push({ kind: "rule" });
			continue;
		}

		const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			out.push({ kind: "heading", level: heading[1].length, spans: parseInline(heading[2].trim()) });
			continue;
		}

		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			out.push({ kind: "quote", spans: parseInline(quote[1]) });
			continue;
		}

		const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
		if (bullet) {
			out.push({
				kind: "listItem",
				marker: "•",
				indent: Math.floor(bullet[1].length / 2),
				spans: parseInline(bullet[3]),
			});
			continue;
		}

		const ordered = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
		if (ordered) {
			out.push({
				kind: "listItem",
				marker: `${ordered[2]}.`,
				indent: Math.floor(ordered[1].length / 2),
				spans: parseInline(ordered[3]),
			});
			continue;
		}

		out.push({ kind: "paragraph", spans: parseInline(line) });
	}

	// A fence still open at the end of the text: render what arrived.
	if (fence) out.push({ kind: "code", language: fence.language, lines: fence.lines });
	return out;
}
