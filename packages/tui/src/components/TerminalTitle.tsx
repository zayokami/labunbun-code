import { useEffect } from "react";
import type { StatusPhase } from "../ui-state.ts";

/** Wrap a title in the OSC-0 set-window-title sequence. */
export function terminalTitle(title: string): string {
	return `\x1b]0;${title}\x07`;
}

const PHASE_TITLE: Record<StatusPhase, string> = {
	idle: "",
	thinking: "thinking",
	responding: "responding",
	tools: "running tools",
};

/**
 * Keep the terminal window title in step with the session. Pure side effect —
 * renders nothing. Writes are TTY-guarded: piped output must never receive
 * escape sequences.
 */
export function TerminalTitle({ phase, dirName }: { phase: StatusPhase; dirName: string }) {
	useEffect(() => {
		if (!process.stdout.isTTY) return;
		const busy = phase !== "idle";
		const title = busy ? `labunbun — ${dirName} · ${PHASE_TITLE[phase]}` : `labunbun — ${dirName}`;
		process.stdout.write(terminalTitle(title));
		return () => {
			if (!process.stdout.isTTY) return;
			// On unmount, drop the suffix so the title doesn't claim a run in flight.
			process.stdout.write(terminalTitle(`labunbun — ${dirName}`));
		};
	}, [phase, dirName]);
	return null;
}
