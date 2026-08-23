import { Text } from "ink";
import { useEffect, useState } from "react";
import { useTheme } from "../theme.ts";
import type { StatusPhase } from "../ui-state.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
		const timer = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
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
	const seconds = (elapsedMs / 1000).toFixed(0);
	const outputPart = outputEstimate && outputEstimate > 0 ? ` · ~${formatTokens(outputEstimate)} out` : "";
	return (
		<Text color={theme.primary}>
			{FRAMES[frame]} {PHASE_LABEL[phase]}{" "}
			<Text dimColor>
				({seconds}s · {modelName}
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
