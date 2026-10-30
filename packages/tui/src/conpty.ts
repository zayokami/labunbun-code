/**
 * Windows consoles stop following the cursor when one write runs past their
 * buffer — roughly 32 KB. The bytes still land; the viewport stays where it
 * was, so a reader who had scrolled up ends up parked over old content while
 * the new output fills in below, and the wheel is the only way to find it. A
 * reprint of the whole transcript is one write, and every clear (Ctrl+L, the
 * pad's □, a theme change) pays a reprint, so a long session walks into this.
 *
 * The writers here keep every write under a fourth of that budget. Chunks cut
 * at newlines, which no escape sequence contains, so a cut cannot split one.
 * The family is wider than one product: ConPTY sits behind Windows Terminal,
 * conhost, VS Code's terminal, Tabby and Hyper alike, and a WSL shell hosted
 * by any of them crosses it too.
 *
 * A second rule rides along on the same write: no scrollback erase. See
 * `stripScrollbackErase` — a Windows console reads 3J literally, and ink
 * emits it inside the clear it performs on every redraw of a fullscreen
 * frame there, which is the shape a picker-size dialog gives every frame.
 */

/** A fourth of the smallest buffer budget anyone has reported. */
export const MAX_CONPTY_WRITE = 8 * 1024;

/**
 * True where stdout crosses a Windows console stack. WSL runs as linux, but
 * the shell's output still lands in one when the host is a Windows terminal.
 */
export function isConPTYHost(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return platform === "win32" || env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined;
}

/**
 * Split one write into pieces no larger than `max`, cutting at the last
 * newline that fits. A window with no newline at all (one giant line) cuts at
 * the budget anyway, because progress has to be made; only then can a cut
 * land inside an escape sequence, and such a sequence would have had to span
 * a full window.
 */
export function chunkForConPTY(data: string, max = MAX_CONPTY_WRITE): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (data.length - start > max) {
		const cut = data.lastIndexOf("\n", start + max - 1);
		let end = cut >= start ? cut + 1 : start + max;
		// A budget cut must not part a surrogate pair: each half would be encoded
		// alone, as U+FFFD, and the character would reach the screen as two boxes.
		if (cut < start && end - start > 1) {
			const last = data.charCodeAt(end - 1);
			if (last >= 0xd800 && last <= 0xdbff) end -= 1;
		}
		chunks.push(data.slice(start, end));
		start = end;
	}
	if (start < data.length) chunks.push(data.slice(start));
	return chunks;
}

const chunked = new WeakSet<object>();

/**
 * Drop the scrollback erase from a write.
 *
 * `3J` erases the terminal's scrollback, and a Windows console reads it
 * literally: the scrollback goes and a reader who had scrolled up is pulled
 * back to the screen. The app's own clears already stop at the screen on a
 * ConPTY host (`clearScreenSequence`), but ink's own fullscreen clear is
 * built from `ansiEscapes.clearTerminal`, which carries the 3J
 * unconditionally — on every redraw of a fullscreen frame. Nothing this app
 * draws lives above the screen — that is what the screen erase underneath is
 * for — so the sequence is removed from every write headed for one.
 */
export function stripScrollbackErase(data: string): string {
	return data.replaceAll("\x1b[3J", "");
}

/**
 * Replace the stream's `write` with the ConPTY rules — chunks under the
 * budget, no scrollback erase — in place, once; whoever holds the stream
 * afterwards (ink, a title writer) writes through it without knowing.
 * Idempotent, so an entry that runs twice installs once. A write carrying
 * trailing arguments (an encoding or callback — nothing in this app sends
 * one), passes through untouched.
 */
export function chunkWritesForConPTY(stream: { write: (...args: any[]) => unknown }, max = MAX_CONPTY_WRITE): void {
	if (chunked.has(stream)) return;
	chunked.add(stream);
	const write = stream.write.bind(stream);
	stream.write = (data: string, ...rest: unknown[]) => {
		// A Buffer or Uint8Array has no `replaceAll` and no escape sequence to strip.
		if (rest.length > 0 || typeof data !== "string") return write(data, ...rest);
		// Stripped first, so the cut sees the bytes that will land: a chunk
		// boundary never falls inside a sequence that no longer exists.
		const cleaned = stripScrollbackErase(data);
		if (cleaned.length <= max) return write(cleaned);
		let result: unknown = true;
		for (const chunk of chunkForConPTY(cleaned, max)) result = write(chunk);
		return result;
	};
}
