import { Box, Static, Text } from "ink";
import { useTheme } from "../theme.ts";
import type { UiEntry } from "../ui-state.ts";

function UserMessageView({ text }: { text: string }) {
	const theme = useTheme();
	return (
		<Box marginBottom={1}>
			<Text color={theme.userMessage}>
				{"> "}
				<Text bold>{text}</Text>
			</Text>
		</Box>
	);
}

function AssistantMessageView({ text }: { text: string }) {
	const theme = useTheme();
	return (
		<Box marginBottom={1} flexDirection="column">
			{renderMarkdownLite(text, theme.text)}
		</Box>
	);
}

/** Minimal markdown: fenced code blocks dimmed, rest plain. */
function renderMarkdownLite(text: string, color: string) {
	const lines = text.split("\n");
	const out: React.ReactNode[] = [];
	let inCode = false;
	let codeBuffer: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trimStart().startsWith("```")) {
			if (inCode) {
				out.push(
					<Box key={`code-${out.length}`} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
						{codeBuffer.map((l, j) => (
							<Text key={j} color="gray">
								{l}
							</Text>
						))}
					</Box>,
				);
				codeBuffer = [];
				inCode = false;
			} else {
				inCode = true;
			}
			continue;
		}
		if (inCode) {
			codeBuffer.push(line);
			continue;
		}
		out.push(
			<Text key={`line-${i}`} color={color}>
				{line || " "}
			</Text>,
		);
	}
	if (codeBuffer.length > 0) {
		out.push(
			<Box key="code-tail" flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
				{codeBuffer.map((l, j) => (
					<Text key={j} color="gray">
						{l}
					</Text>
				))}
			</Box>,
		);
	}
	return out;
}

function ToolUseView({ entry }: { entry: Extract<UiEntry, { kind: "toolUse" }> }) {
	const theme = useTheme();
	const resultColor = entry.isError ? theme.error : theme.dim;
	return (
		<Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor={theme.toolBorder} paddingX={1}>
			<Text>
				<Text color={theme.toolName}>[{entry.toolName}]</Text> <Text dimColor>{entry.inputPreview}</Text>
			</Text>
			{entry.resultText !== undefined && (
				<Text color={resultColor}>
					{entry.resultText.length > 400 ? `${entry.resultText.slice(0, 397)}...` : entry.resultText || "(no output)"}
				</Text>
			)}
		</Box>
	);
}

export function MessageList({ entries }: { entries: UiEntry[] }) {
	return (
		<Box flexDirection="column">
			{entries.map((entry, i) => {
				switch (entry.kind) {
					case "user":
						return <UserMessageView key={i} text={entry.text} />;
					case "assistant":
						return <AssistantMessageView key={i} text={entry.text} />;
					case "toolUse":
						return <ToolUseView key={i} entry={entry} />;
					case "error":
						return (
							<Box key={i} marginBottom={1}>
								<Text color="red">{entry.text}</Text>
							</Box>
						);
					case "info":
						return (
							<Box key={i} marginBottom={1}>
								<Text dimColor>{entry.text}</Text>
							</Box>
						);
				}
			})}
		</Box>
	);
}

/** Streaming preview shown while the assistant is responding. */
export function StreamingPreview({ text, thinking }: { text: string; thinking: string }) {
	const theme = useTheme();
	if (!text && !thinking) return null;
	return (
		<Box flexDirection="column" marginBottom={1}>
			{text && <Text color={theme.text}>{text}</Text>}
			{thinking && !text && <Text color={theme.thinking}>… {thinking.slice(-200)}</Text>}
		</Box>
	);
}

export { Static };
