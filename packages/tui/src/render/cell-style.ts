/**
 * Cell styles, interned to small integers.
 *
 * A grid cell stores its appearance in a `Uint32Array`, so a style cannot be an
 * object per cell: it is an id into this table. Interning also gives the diff
 * the identity it needs — two cells wearing the same colour and attributes
 * compare by id, and the encoder emits one SGR sequence for the run between
 * style changes rather than one per cell.
 */

/**
 * A colour a cell can carry.
 *
 * A number is a terminal palette index (0–255, clamped); a three-number tuple
 * is a truecolor channel triple (also clamped). Undefined means the terminal's
 * own default, which is what a style with no `fg`/`bg` gets.
 */
export type Color = number | readonly [number, number, number];

/** Everything a cell can say about how it looks. */
export interface CellStyle {
	readonly fg?: Color;
	readonly bg?: Color;
	readonly bold?: boolean;
	readonly dim?: boolean;
	readonly italic?: boolean;
	readonly underline?: boolean;
	readonly inverse?: boolean;
	readonly strikethrough?: boolean;
}

/** Attribute bits, in the order they are written into the SGR parameters. */
const ATTRIBUTES: ReadonlyArray<readonly [keyof CellStyle, number]> = [
	["bold", 1],
	["dim", 2],
	["italic", 3],
	["underline", 4],
	["inverse", 7],
	["strikethrough", 9],
];

function channel(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.trunc(value))) : 0;
}

function paletteIndex(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(255, Math.trunc(value))) : 0;
}

function colorKey(color: Color): string {
	if (typeof color === "number") return `i${paletteIndex(color)}`;
	const [r, g, b] = color;
	return `r${channel(r)},${channel(g)},${channel(b)}`;
}

function colorParameters(color: Color, background: boolean): string[] {
	const prefix = background ? "48" : "38";
	if (typeof color === "number") return [prefix, "5", String(paletteIndex(color))];
	const [r, g, b] = color;
	return [prefix, "2", String(channel(r)), String(channel(g)), String(channel(b))];
}

/**
 * The interned style table shared by every cell in a screen.
 *
 * Id 0 is the empty style — no colours, no attributes — and exists before the
 * first call, because a cleared cell has to point somewhere. Ids are handed out
 * in first-use order and live as long as the table, which for the app's lifetime
 * is one small object per theme in use: a style that stops being used stays, at
 * the cost of a few dozen bytes.
 */
export class StyleTable {
	private readonly ids = new Map<string, number>();
	private readonly styles: CellStyle[] = [];
	private readonly sequences: string[] = [];

	constructor() {
		this.intern({});
	}

	/** The id for `style`, creating it on first use. */
	intern(style: CellStyle): number {
		const key = this.key(style);
		const existing = this.ids.get(key);
		if (existing !== undefined) return existing;
		const id = this.styles.length;
		this.ids.set(key, id);
		this.styles.push({ ...style });
		this.sequences.push(this.sequence(style));
		return id;
	}

	/** The style an id stands for. Ids come from this table; an unknown id is the default. */
	style(id: number): CellStyle {
		return this.styles[id] ?? this.styles[0];
	}

	/** The SGR sequence that puts the terminal into `id`'s appearance. */
	sgr(id: number): string {
		return this.sequences[id] ?? this.sequences[0];
	}

	/** How many distinct styles the caller has used, including the default. */
	get size(): number {
		return this.styles.length;
	}

	/** A stable string for `style`, with colours normalized so 300 and 255 share an id. */
	private key(style: CellStyle): string {
		const parts: string[] = [];
		parts.push(style.fg === undefined ? "" : `f${colorKey(style.fg)}`);
		parts.push(style.bg === undefined ? "" : `b${colorKey(style.bg)}`);
		for (const [name, code] of ATTRIBUTES) parts.push(style[name] === true ? String(code) : "");
		return parts.join("|");
	}

	private sequence(style: CellStyle): string {
		const params = ["0"];
		for (const [name, code] of ATTRIBUTES) if (style[name] === true) params.push(String(code));
		if (style.fg !== undefined) params.push(...colorParameters(style.fg, false));
		if (style.bg !== undefined) params.push(...colorParameters(style.bg, true));
		return `\x1b[${params.join(";")}m`;
	}
}
