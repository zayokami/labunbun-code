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
 * Must be awaited before the REPL mounts. It puts stdin in raw mode, and Ink
 * installs its own input handling on mount — the two cannot overlap.
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
	 * handler that receives them types them into the prompt.
	 */
	const displaced = stdin.listeners("data") as Array<(...args: unknown[]) => void>;
	stdin.removeAllListeners("data");

	return await new Promise<Appearance>((resolve) => {
		let settled = false;
		let buffer = "";
		let timer: ReturnType<typeof setTimeout> | undefined;

		/**
		 * Single exit path for every outcome. Leaving raw mode on, or leaving the
		 * listener attached, would take keystrokes away from the REPL that mounts
		 * immediately afterwards — so timeout, success, and the
		 * unsupported-terminal path all come through here.
		 */
		const finish = (appearance: Appearance): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			stdin.off("data", onData);
			for (const listener of displaced) stdin.on("data", listener);
			try {
				stdin.setRawMode(wasRaw);
			} catch {
				// Nothing actionable: the stream may already be closed.
			}
			if (wasPaused) stdin.pause();
			resolve(appearance);
		};

		function onData(chunk: Buffer | string): void {
			buffer += chunk.toString();
			const luminance = parseBackgroundLuminance(buffer);
			if (luminance !== undefined) {
				finish(luminance > LIGHT_LUMINANCE_THRESHOLD ? "light" : "dark");
				return;
			}
			if (hasDa1Reply(buffer)) finish(fromEnv());
		}

		try {
			stdin.setRawMode(true);
		} catch {
			for (const listener of displaced) stdin.on("data", listener);
			resolve(fromEnv());
			return;
		}
		stdin.resume();
		stdin.on("data", onData);
		timer = setTimeout(() => finish(fromEnv()), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		stdout.write(QUERY_BACKGROUND);
		stdout.write(QUERY_DA1);
	});
}
