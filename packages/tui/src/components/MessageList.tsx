import { Box, Static, Text } from "ink";
import { type InlineSpan, parseBlocks } from "../markdown.ts";
import { type Theme, useTheme } from "../theme.ts";
import type { UiEntry } from "../ui-state.ts";

// biome-ignore format: keep the regex on one line so the ignore comment below stays attached
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching raw C0/C1 control bytes is the point
const ANSI_ESCAPE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping raw C0/C1 control bytes is the point
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Strip ANSI escape sequences and other control characters before handing
 * text to Ink's <Text>. Tool output and model text are untrusted — without
 * this, an adversarial file/command/response can inject cursor moves, screen
 * clears, or color resets that corrupt the rendered transcript.
 */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "").replace(CONTROL_CHARS_RE, "");
}

function UserMessageView({ text }: { text: string }) {
	const theme = useTheme();
	return (
		<Box marginBottom={1}>
			<Text color={theme.userInput}>
				{"> "}
				<Text bold>{stripAnsi(text)}</Text>
			</Text>
		</Box>
	);
}

function AssistantMessageView({ text }: { text: string }) {
	const theme = useTheme();
	return (
		<Box marginBottom={1} flexDirection="column">
			{renderMarkdownLite(stripAnsi(text), theme)}
		</Box>
	);
}

/**
 * Render the parsed blocks. Code keeps its box; everything else maps marks onto
 * Ink's text attributes, falling back to color where the terminal has no
 * equivalent (inline code, links).
 */
function renderMarkdownLite(text: string, theme: Theme) {
	return parseBlocks(text).map((block, i) => {
		const key = `b-${i}`;
		switch (block.kind) {
			case "code":
				return (
					<Box key={key} flexDirection="column" borderStyle="round" borderColor={theme.codeBorder} paddingX={1}>
						{block.lines.map((line, j) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional and never reordered
							<Text key={j} color={theme.codeText}>
								{line || " "}
							</Text>
						))}
					</Box>
				);
			case "heading":
				return (
					<Text key={key} color={theme.accent} bold>
						{renderSpans(block.spans, theme)}
					</Text>
				);
			case "listItem":
				return (
					<Text key={key} color={theme.text}>
						{"  ".repeat(block.indent)}
						<Text color={theme.accent}>{block.marker}</Text> {renderSpans(block.spans, theme)}
					</Text>
				);
			case "quote":
				return (
					<Text key={key} color={theme.textMuted}>
						{"│ "}
						{renderSpans(block.spans, theme)}
					</Text>
				);
			case "rule":
				return (
					<Text key={key} color={theme.border}>
						{"─".repeat(40)}
					</Text>
				);
			case "blank":
				return <Text key={key}> </Text>;
			default:
				return (
					<Text key={key} color={theme.text}>
						{renderSpans(block.spans, theme)}
					</Text>
				);
		}
	});
}

/** Marks onto Ink text attributes. Inline code and links get a color instead. */
function renderSpans(spans: InlineSpan[], theme: Theme) {
	return spans.map((span, i) => (
		<Text
			// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional within one line
			key={i}
			bold={span.bold}
			italic={span.italic}
			strikethrough={span.strike}
			color={span.code ? theme.codeText : span.href ? theme.link : undefined}
			underline={span.href !== undefined}
		>
			{span.text}
		</Text>
	));
}

function ToolUseView({ entry }: { entry: Extract<UiEntry, { kind: "toolUse" }> }) {
	const theme = useTheme();
	return (
		<Box marginBottom={1} flexDirection="column" borderStyle="round" borderColor={theme.toolBorder} paddingX={1}>
			<Text>
				<Text color={theme.toolName}>[{entry.toolName}]</Text> <Text color={theme.toolArgs}>{entry.inputPreview}</Text>
			</Text>
			{entry.resultText !== undefined && <ResultLines text={entry.resultText} isError={entry.isError} />}
		</Box>
	);
}

/** Render result lines; unified-diff markers (+/-/@@) get diff coloring. */
function ResultLines({ text, isError }: { text: string; isError?: boolean }) {
	const theme = useTheme();
	const sanitized = stripAnsi(text);
	const capped = sanitized.length > 400 ? `${sanitized.slice(0, 397)}...` : sanitized || "(no output)";
	if (isError) {
		return (
			<Text color={theme.error} bold={theme.bold.error}>
				{theme.marks.error} {capped}
			</Text>
		);
	}
	const hasDiff = /^[-+@ ]/m.test(capped) && (capped.includes("\n- ") || capped.includes("\n+ "));
	if (!hasDiff) {
		return <Text color={theme.toolOutput}>{capped}</Text>;
	}
	return (
		<Box flexDirection="column">
			{capped.split("\n").map((line, i) => {
				let color = theme.toolOutput;
				if (line.startsWith("+")) color = theme.diffAdded;
				else if (line.startsWith("-")) color = theme.diffRemoved;
				else if (line.startsWith("@@")) color = theme.diffHeader;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: capped is a fixed string slice split into immutable, never-reordered lines
					<Text key={i} color={color}>
						{line}
					</Text>
				);
			})}
		</Box>
	);
}

export function MessageList({ entries }: { entries: UiEntry[] }) {
	return (
		<Box flexDirection="column">
			{entries.map((entry, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: entries is append-only, existing indices never change identity
				<EntryView key={i} entry={entry} />
			))}
		</Box>
	);
}

/**
 * An error entry. Carries the theme's error mark and weight as well as its
 * color, so the entry is still identifiable as an error when color is not
 * available — a colorblind reader, a monochrome terminal, piped output.
 */
function ErrorView({ text }: { text: string }) {
	const theme = useTheme();
	return (
		<Box marginBottom={1}>
			<Text color={theme.error} bold={theme.bold.error}>
				{theme.marks.error} {stripAnsi(text)}
			</Text>
		</Box>
	);
}

function InfoView({ text }: { text: string }) {
	const theme = useTheme();
	return (
		<Box marginBottom={1}>
			<Text color={theme.textMuted}>{text}</Text>
		</Box>
	);
}

export function EntryView({ entry }: { entry: UiEntry }) {
	switch (entry.kind) {
		case "user":
			return <UserMessageView text={entry.text} />;
		case "assistant":
			return <AssistantMessageView text={entry.text} />;
		case "toolUse":
			return <ToolUseView entry={entry} />;
		case "error":
			return <ErrorView text={entry.text} />;
		case "info":
			return <InfoView text={entry.text} />;
	}
}

/**
 * Number of trailing entries kept live (re-rendered every frame). Everything
 * older is sealed into ink's Static scrollback and never re-rendered.
 * Tool entries without results stay live so late-arriving output still lands.
 */
const LIVE_WINDOW = 8;

export function sealCount(entries: UiEntry[]): number {
	let boundary = Math.max(0, entries.length - LIVE_WINDOW);
	for (let i = 0; i < Math.min(boundary, entries.length); i++) {
		const entry = entries[i];
		if (entry.kind === "toolUse" && entry.resultText === undefined) {
			boundary = i; // a pending tool blocks sealing past it
			break;
		}
	}
	return boundary;
}

/** Virtualized transcript: sealed history via Static + live tail re-rendered. */
export function VirtualMessageList({ entries }: { entries: UiEntry[] }) {
	const sealed = sealCount(entries);
	const head = entries.slice(0, sealed);
	const tail = entries.slice(sealed);

	return (
		<Box flexDirection="column">
			<Static items={head}>{(entry, i) => <EntryView key={`sealed-${i}`} entry={entry} />}</Static>
			{tail.map((entry, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: sealed + i reconstructs the entry's stable absolute position in the full list
				<EntryView key={`live-${sealed + i}`} entry={entry} />
			))}
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
