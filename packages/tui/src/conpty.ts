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
		const end = cut >= start ? cut + 1 : start + max;
		chunks.push(data.slice(start, end));
		start = end;
	}
	if (start < data.length) chunks.push(data.slice(start));
	return chunks;
}

const chunked = new WeakSet<object>();

/**
 * Replace the stream's `write` with one that chunks, in place, once — whoever
 * holds the stream afterwards (ink, a title writer) writes through it without
 * knowing. Idempotent, so an entry that runs twice installs once. A write that
 * already fits, or that carries trailing arguments (an encoding or callback —
 * nothing in this app sends one), passes through untouched.
 */
export function chunkWritesForConPTY(stream: { write: (...args: any[]) => unknown }, max = MAX_CONPTY_WRITE): void {
	if (chunked.has(stream)) return;
	chunked.add(stream);
	const write = stream.write.bind(stream);
	stream.write = (data: string, ...rest: unknown[]) => {
		if (rest.length > 0 || data.length <= max) return write(data, ...rest);
		let result: unknown = true;
		for (const chunk of chunkForConPTY(data, max)) result = write(chunk);
		return result;
	};
}
