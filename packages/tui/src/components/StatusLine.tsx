import { Text } from "ink";
import { useEffect, useState } from "react";
import { formatElapsed } from "../elapsed.ts";
import { useTheme } from "../theme.ts";
import type { PendingTool, StatusPhase, UiBackgroundShell } from "../ui-state.ts";

/** Braille spinner, shared with the terminal title so both turn at one rate. */
export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Milliseconds between spinner frames. */
export const SPINNER_INTERVAL_MS = 80;

const PHASE_LABEL: Record<StatusPhase, string> = {
	idle: "",
	thinking: "Thinking…",
	responding: "Responding…",
	tools: "Running tools…",
};

/** Rough live output size in tokens — chars/4, the usual English heuristic. */
export function estimateOutputTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

/**
 * What is running, for the detail row under the spinner.
 *
 * Repeats are counted rather than listed: three parallel Bash calls reading
 * "Bash · Bash · Bash" is the same word three times over, and the reader has to
 * count it to learn what "Bash ×3" says outright.
 */
export function toolSummary(tools: PendingTool[]): string {
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
	return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(" · ");
}

/**
 * The background-shell row, or null when there is nothing to report.
 *
 * Only running shells are counted, and the row carries the two commands that do
 * something about them: a dev server outliving its turn is normal, but a dev
 * server nobody remembers starting is how ports get stuck.
 */
export function backgroundShellRow(shells: UiBackgroundShell[]): string | null {
	const running = shells.filter((shell) => shell.status === "running").length;
	if (running === 0) return null;
	return `${running} background shell${running === 1 ? "" : "s"} running · /ps to view · /stop to close`;
}

export function StatusLine({
	phase,
	modelName,
	elapsedMs,
	contextInfo,
	outputEstimate,
}: {
	phase: StatusPhase;
	modelName: string;
	elapsedMs: number;
	contextInfo?: { usedTokens: number; threshold: number };
	/** Live output-token estimate for the in-flight response. */
	outputEstimate?: number;
}) {
	const theme = useTheme();
	const [frame, setFrame] = useState(0);

	useEffect(() => {
		if (phase === "idle") return;
		const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), SPINNER_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [phase]);

	const contextPart = contextInfo
		? ` · ctx ${formatTokens(contextInfo.usedTokens)}${
				contextInfo.threshold > 0
					? ` (${Math.max(0, Math.min(100, Math.round((1 - contextInfo.usedTokens / contextInfo.threshold) * 100)))}% free)`
					: ""
			}`
		: "";

	if (phase === "idle") {
		return contextPart ? (
			<Text dimColor>
				{modelName}
				{contextPart}
			</Text>
		) : null;
	}
	const outputPart = outputEstimate && outputEstimate > 0 ? ` · ~${formatTokens(outputEstimate)} out` : "";
	return (
		<Text color={theme.accent}>
			{FRAMES[frame]} {PHASE_LABEL[phase]}{" "}
			<Text dimColor>
				({formatElapsed(elapsedMs)} · {modelName}
				{outputPart}
				{contextPart} · esc to interrupt)
			</Text>
		</Text>
	);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}
