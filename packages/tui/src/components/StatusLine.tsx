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

export function StatusLine({
	phase,
	modelName,
	elapsedMs,
	contextInfo,
}: {
	phase: StatusPhase;
	modelName: string;
	elapsedMs: number;
	contextInfo?: { usedTokens: number; threshold: number };
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
	return (
		<Text color={theme.primary}>
			{FRAMES[frame]} {PHASE_LABEL[phase]}{" "}
			<Text dimColor>
				({seconds}s · {modelName}
				{contextPart})
			</Text>
		</Text>
	);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}
