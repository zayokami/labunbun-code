/**
 * Terminal background detection for `theme: "auto"`.
 *
 * Terminals do not report their color scheme, so this asks: OSC 11 requests
 * the background color, and the reply's luminance decides dark vs light. Plenty
 * of terminals ignore the request, so every step degrades quietly to the next
 * and the whole thing ends at `"dark"` rather than at an error — a failed probe
 * is the normal case on older terminals, not something to report.
 */

// Built rather than written as literals: an escape byte in a source file is
// invisible in most editors and easily mangled by anything that rewrites it.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** OSC 11 background query. */
const QUERY_BACKGROUND = `${ESC}]11;?${BEL}`;
/**
 * Primary Device Attributes. Sent right behind the OSC 11 query as a tripwire:
 * nearly every terminal answers DA1, so a DA1 reply with no OSC 11 reply means
 * the terminal has been heard from and does not support the query. That turns
 * the common "unsupported" case into an immediate fallback instead of sitting
 * out the full timeout.
 */
const QUERY_DA1 = `${ESC}[c`;

/**
 * Whether the buffer holds a DA1 reply (`ESC [ ? <params> c`). A scan rather
 * than a regex so the escape byte stays a named constant instead of becoming
 * an invisible literal inside a pattern.
 */
function hasDa1Reply(buffer: string): boolean {
	const start = buffer.indexOf(`${ESC}[?`);
	return start >= 0 && buffer.includes("c", start + 2);
}

/** How long to wait for a reply before giving up and using the environment. */
const DEFAULT_TIMEOUT_MS = 150;

/**
 * How long the stream is held after the answer, waiting for the terminal's other
 * reply.
 *
 * Two queries go out and the terminal answers them in whatever order it reaches
 * them, milliseconds apart. The reply that is still in flight when the probe
 * stops listening arrives on a stream the REPL is reading, and a key handler
 * that receives escape bytes types them into the prompt. The window ends as soon
 * as both replies are accounted for, so a terminal that answers both (nearly all
 * of them) holds the stream for no longer than it takes the slower reply to
 * arrive; this is only paid in full by a terminal that answers one query and not
 * the other, where there is nothing left to wait for but nothing that says so.
 */
const DRAIN_TIMEOUT_MS = 100;

/** Above this relative luminance the background counts as light. */
const LIGHT_LUMINANCE_THRESHOLD = 0.5;

export interface DetectAppearanceOptions {
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export type Appearance = "dark" | "light";

/**
 * Relative luminance of an OSC 11 `rgb:` reply, or undefined if it is not one.
 *
 * Channels are 1–4 hex digits and terminals differ in how many they send, so
 * each is scaled by its own width. Dividing everything by 0xffff instead would
 * read a two-digit `rgb:ff/ff/ff` — pure white — as almost black.
 */
export function parseBackgroundLuminance(reply: string): number | undefined {
	const match = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
	if (!match) return undefined;
	const [r, g, b] = [match[1], match[2], match[3]].map((hex) => Number.parseInt(hex, 16) / (16 ** hex.length - 1));
	// sRGB luma weights: the eye is far more sensitive to green than to blue.
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Appearance from `COLORFGBG`, set by rxvt and several other terminals. The
 * last field is the background as an ANSI palette index: 0-6 are the dark
 * colors, 7-15 the light ones.
 */
export function appearanceFromColorFgBg(value: string | undefined): Appearance | undefined {
	if (!value) return undefined;
	const fields = value.split(";");
	const background = Number.parseInt(fields[fields.length - 1] ?? "", 10);
	if (!Number.isInteger(background) || background < 0 || background > 15) return undefined;
	return background <= 6 ? "dark" : "light";
}

/** Whether querying the terminal is appropriate at all. */
function canProbe(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, env: NodeJS.ProcessEnv): boolean {
	// CI logs and NO_COLOR setups are not interactive terminals; writing an
	// escape sequence there just leaves the raw bytes in the output.
	if (env.CI || env.NO_COLOR) return false;
	return Boolean(stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === "function");
}

/**
 * Detect the terminal's background, in order: skip probing entirely when it is
 * not a real terminal, ask via OSC 11, fall back to `COLORFGBG`, then default
 * to dark.
 *
 * Runs before the REPL mounts, and again from inside it when `/theme auto` is
 * picked. Mid-session the readers already on stdin — Ink's among them — are
 * stood down while the queries are outstanding and put back when the terminal
 * is done answering, so the replies are read here and not typed into the prompt.
 */
export async function detectAppearance(options: DetectAppearanceOptions = {}): Promise<Appearance> {
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const env = options.env ?? process.env;
	const fromEnv = (): Appearance => appearanceFromColorFgBg(env.COLORFGBG) ?? "dark";

	if (!canProbe(stdin, stdout, env)) return fromEnv();

	const wasRaw = stdin.isRaw === true;
	const wasPaused = stdin.isPaused();
	/**
	 * Whoever else is reading stdin — Ink, when `/theme auto` runs from inside the
	 * REPL — is stood down for the duration. The reply is escape bytes, and a key
	 * handler that receives them types them into the prompt. Both events are
	 * taken: Ink 7 reads through a `readable` listener and attaches no `data` one
	 * at all, so standing down only the `data` readers leaves it reading. Ink
	 * re-attaches that listener only when it enables raw mode from zero — a
	 * component with input mounting on an otherwise idle stream — which cannot
	 * happen here: the prompt that ran the command already holds raw mode.
	 */
	const displacedData = stdin.listeners("data") as Array<(...args: unknown[]) => void>;
	const displacedReadable = stdin.listeners("readable") as Array<(...args: unknown[]) => void>;
	const restore = (): void => {
		for (const listener of displacedData) stdin.on("data", listener);
		for (const listener of displacedReadable) stdin.on("readable", listener);
	};
	stdin.removeAllListeners("data");
	stdin.removeAllListeners("readable");

	return await new Promise<Appearance>((resolve) => {
		let settled = false;
		let released = false;
		let seenBackground = false;
		let seenDa1 = false;
		let answer: Appearance | undefined;
		let buffer = "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		let drain: ReturnType<typeof setTimeout> | undefined;

		/**
		 * Single exit path for every outcome. Leaving raw mode on, or leaving the
		 * listener attached, would take keystrokes away from the REPL that mounts
		 * immediately afterwards — so timeout, success, and the
		 * unsupported-terminal path all come through here.
		 */
		const release = (): void => {
			if (released) return;
			released = true;
			if (timer) clearTimeout(timer);
			if (drain) clearTimeout(drain);
			// Restored before our own listener goes: a byte that arrives while the
			// readers are being put back is still swallowed, not handed to them.
			restore();
			stdin.off("data", onData);
			try {
				stdin.setRawMode(wasRaw);
			} catch {
				// Nothing actionable: the stream may already be closed.
			}
			if (wasPaused) stdin.pause();
			resolve(answer ?? fromEnv());
		};

		const finish = (appearance: Appearance): void => {
			if (settled) return;
			settled = true;
			answer = appearance;
			if (timer) clearTimeout(timer);
			drain = setTimeout(release, DRAIN_TIMEOUT_MS);
		};

		function onData(chunk: Buffer | string): void {
			buffer += chunk.toString();
			const luminance = parseBackgroundLuminance(buffer);
			// The two replies can share a chunk, so both are looked for in each one.
			if (luminance !== undefined && !seenBackground) {
				seenBackground = true;
				if (!settled) finish(luminance > LIGHT_LUMINANCE_THRESHOLD ? "light" : "dark");
			}
			if (hasDa1Reply(buffer) && !seenDa1) {
				seenDa1 = true;
				if (!settled) finish(fromEnv());
			}
			// Both queries answered: nothing is in flight any more, so the window
			// can close without waiting the rest of it out.
			if (settled && seenBackground && seenDa1) release();
		}

		try {
			stdin.setRawMode(true);
		} catch {
			restore();
			resolve(fromEnv());
			return;
		}
		stdin.resume();
		stdin.on("data", onData);
		timer = setTimeout(() => finish(fromEnv()), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			stdout.write(QUERY_BACKGROUND);
			stdout.write(QUERY_DA1);
		} catch {
			// The terminal cannot be written to, so it has not been asked and will
			// not answer: give up now rather than sit out the timeout waiting on a
			// question nobody heard. What matters more is that the stream comes
			// back — this is the one moment stdin is out of its readers' hands, and
			// a probe that fails is normal while a probe that keeps the keyboard
			// (raw mode on, nothing listening) is not.
			finish(fromEnv());
			release();
		}
	});
}
