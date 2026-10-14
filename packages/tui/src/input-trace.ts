/**
 * Input-path diagnostics for the "keys stop reaching the UI" class of bug.
 *
 * Off unless `LBB_INPUT_TRACE` says otherwise: `1` appends to
 * `lbb-input-trace.log` in the system temp directory, any other value is the
 * path to append to. The variable is read on every call — a test can point it
 * at a scratch file mid-process, and the log picks up whatever the environment
 * says at the moment of the call that matters.
 *
 * Nothing here may throw: it runs on the reply path of the very thing it is
 * diagnosing, and a diagnostic that takes the input stream down would hide the
 * bug it was turned on to find.
 */
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SWITCH = "LBB_INPUT_TRACE";

/** Where this call should write, or undefined when tracing is off. */
function traceTarget(): string | undefined {
	const value = process.env[SWITCH];
	if (!value || value === "0") return undefined;
	return value === "1" ? join(tmpdir(), "lbb-input-trace.log") : value;
}

/** Append one timestamped line, when tracing is on. Never throws. */
export function inputTrace(section: string, detail?: unknown): void {
	const target = traceTarget();
	if (target === undefined) return;
	try {
		const tail = detail === undefined ? "" : typeof detail === "string" ? detail : JSON.stringify(detail);
		appendFileSync(target, `${new Date().toISOString()} [${section}] ${tail}\n`);
	} catch {
		// A full disk or an unwritable path is not worth taking the input path
		// down for; the diagnosis can be missing a line, but not the keys.
	}
}

/** The stream facts a trace line cares about. */
function stdinState(stdin: NodeJS.ReadStream): Record<string, unknown> {
	return {
		isTTY: stdin.isTTY,
		isRaw: stdin.isRaw,
		isPaused: stdin.isPaused(),
		flowing: stdin.readableFlowing,
		dataListeners: stdin.listenerCount("data"),
		readableListeners: stdin.listenerCount("readable"),
	};
}

const wrapped = new WeakSet<NodeJS.ReadStream>();

/**
 * Wrap the read-side methods of `stdin` so every call lands in the trace with
 * the state it left behind, and every listener change is noted by name.
 *
 * This is what makes the bug class readable from a single log file. A stream
 * that looks attached but is no longer read fails in the sequence — who
 * suspended the flow, who resumed it, who re-attached after whom — and no one
 * of those events is wrong on its own. Instrumentation only: every original
 * method runs and its return value passes through unchanged.
 */
export function installStdinTrace(stdin: NodeJS.ReadStream): void {
	if (traceTarget() === undefined) return;
	if (wrapped.has(stdin)) return;
	wrapped.add(stdin);
	inputTrace("stdin.install", stdinState(stdin));

	const target = stdin as unknown as Record<string, unknown>;
	for (const method of ["read", "resume", "pause", "setRawMode"] as const) {
		const original = stdin[method] as unknown as ((...args: unknown[]) => unknown) | undefined;
		if (typeof original !== "function") continue;
		target[method] = (...args: unknown[]) => {
			const result = original.apply(stdin, args);
			// A null from read() is the read loop's normal stop signal; logging every
			// one would bury the chunks under stop signals.
			if (method === "read" && result == null) return result;
			inputTrace(
				`stdin.${method}`,
				method === "read"
					? { chunk: JSON.stringify(String(result)) }
					: { args: args.map((arg) => String(arg)), state: stdinState(stdin) },
			);
			return result;
		};
	}

	const originalOn = stdin.on.bind(stdin);
	const originalOff = stdin.off.bind(stdin);
	const originalRemoveAll = stdin.removeAllListeners.bind(stdin);
	target.on = (event: string | symbol, listener: (...args: unknown[]) => void) => {
		inputTrace("stdin.on", { event: String(event), after: stdin.listenerCount(event) + 1 });
		return originalOn(event as never, listener as never);
	};
	target.off = (event: string | symbol, listener: (...args: unknown[]) => void) => {
		inputTrace("stdin.off", { event: String(event) });
		return originalOff(event as never, listener as never);
	};
	target.removeAllListeners = (event?: string | symbol) => {
		inputTrace("stdin.removeAllListeners", { event: event === undefined ? "all" : String(event) });
		return event === undefined ? originalRemoveAll() : originalRemoveAll(event as never);
	};
}
