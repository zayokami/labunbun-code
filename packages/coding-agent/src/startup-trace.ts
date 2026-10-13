import { appendFileSync } from "node:fs";

/**
 * Startup phase timing. Off unless `LBB_STARTUP_TRACE` is set: one line per
 * mark, naming the phase and the milliseconds since the process started.
 * `LBB_STARTUP_TRACE=1` writes to stderr; any other value is a file path to
 * append to — the file form exists because a pty wrapper swallows stderr.
 * Written for the startup-speed measurement — a slow phase is named by the
 * trace rather than guessed at from the outside.
 */
const target = process.env.LBB_STARTUP_TRACE;

export function markStartup(phase: string): void {
	if (!target) return;
	const line = `[startup] ${Math.round(performance.now())}ms ${phase}\n`;
	if (target === "1") process.stderr.write(line);
	else appendFileSync(target, line);
}
