/**
 * Serialize a session transcript to Markdown. Pure: takes messages, returns
 * text. Used by /export; the caller decides the file path.
 */

import type { AgentMessage } from "@labunbun/ai";

/** Per-result cap so one noisy command cannot dominate the export. */
const RESULT_CAP = 4_000;

export function sessionToMarkdown(messages: AgentMessage[]): string {
	const sections: string[] = ["# Session export", ""];

	for (const message of messages) {
		if (message.role === "user") {
			sections.push("## user", "", textOf(message.content) || "*(empty)*", "");
			continue;
		}
		if (message.role === "assistant") {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) parts.push(block.text);
				if (block.type === "thinking" && block.thinking?.trim()) parts.push(`> (thinking) ${block.thinking}`);
				if (block.type === "toolCall") {
					parts.push(`**Tool call: ${block.name}**\n\n\`\`\`json\n${block.arguments}\n\`\`\``);
				}
			}
			if (parts.length > 0) sections.push("## assistant", "", parts.join("\n\n"), "");
			continue;
		}
		// toolResult
		const body = textOf(message.content).slice(0, RESULT_CAP);
		const suffix = textOf(message.content).length > RESULT_CAP ? "\n[...truncated]" : "";
		sections.push(
			`## tool result (${message.toolName})${message.isError ? " — error" : ""}`,
			"",
			`\`${message.toolCallId}\``,
			"",
			body + suffix,
			"",
		);
	}

	return sections.join("\n");
}

function textOf(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
}
