import type { PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { isAimedAt, usePadAction } from "../pad.ts";
import { dropLastChar } from "../terminal-input.ts";
import { useTheme } from "../theme.ts";
import type { TextPromptState } from "../ui-state.ts";

/** How many masked characters are drawn before the rest is elided. */
const MASK_WIDTH = 40;

/**
 * One line of text, asked for on purpose.
 *
 * The dialog exists for answers that are a value rather than a choice: an API
 * key, a base URL, a provider id. The structured question dialog cannot serve
 * that — its free-text row is one option among several and resolves whatever
 * was typed — and the phrase confirmation is about matching a known sentence,
 * not collecting an unknown one.
 *
 * `mask` is the reason it is a surface of its own rather than the prompt. A
 * key typed into the prompt stays on screen, in the scrollback and in any
 * screenshot of it; here it is drawn as dots, and the value leaves through the
 * promise rather than through the transcript.
 */
export function TextPromptDialog({
	title,
	hint,
	initial,
	mask,
	optional,
	validate,
	resolve,
	pad,
}: TextPromptState & { pad?: PadBridge }) {
	const theme = useTheme();
	const [typed, setTyped] = useState(initial ?? "");
	const [error, setError] = useState<string | null>(null);
	/** When this dialog appeared, so a button held from before cannot act on it. */
	const openedAt = useRef(Date.now());

	const submit = (): void => {
		// Surrounding whitespace is almost always paste noise — a trailing newline
		// from a copied key, a space before a URL — and no value this dialog asks
		// for wants it. Interior text is left exactly as typed.
		const value = typed.trim();
		if (value === "") {
			if (optional) {
				resolve("");
				return;
			}
			setError("A value is required.");
			return;
		}
		const problem = validate?.(value);
		if (problem !== undefined) {
			setError(problem);
			return;
		}
		resolve(value);
	};

	usePadAction(pad, (action) => {
		if (action.phase === "release" || !isAimedAt(action, openedAt.current)) return false;
		// A controller cannot type, so the only button with anything to say is
		// cancel. Confirm is swallowed for the same reason it is in the phrase
		// dialog: an empty field is not an answer.
		if (action.kind === "cancel") {
			resolve(null);
			return true;
		}
		return true;
	});

	useInput((input, key) => {
		if (key.escape) {
			resolve(null);
			return;
		}
		if (key.return) {
			submit();
			return;
		}
		if (key.backspace || key.delete) {
			setError(null);
			setTyped((text) => dropLastChar(text));
			return;
		}
		// Control and meta chords are not value characters. Arrows and function
		// keys arrive with escape sequences that the printable filter below drops.
		if (key.ctrl || key.meta) return;
		const printable = [...input]
			.filter((char) => {
				const code = char.codePointAt(0) ?? 0;
				return code >= 0x20 && code !== 0x7f;
			})
			.join("");
		if (printable) {
			setError(null);
			setTyped((text) => text + printable);
		}
	});

	// A key can be longer than the row it is drawn on. The elision is on the
	// dots only: what is shown is never the value, so a truncated view cannot
	// mislead about which characters were typed.
	const shownChars = [...typed];
	const shown = mask
		? shownChars.length > MASK_WIDTH
			? `…${"•".repeat(MASK_WIDTH)}`
			: "•".repeat(shownChars.length)
		: typed;

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.accent} paddingX={1} marginBottom={1}>
			<Text color={theme.accent} bold>
				{title}
			</Text>
			{hint ? <Text color={theme.textMuted}>{hint}</Text> : null}
			{/* The same marker and block caret the prompt draws: a field without a
			    cursor looks like a label. */}
			<Box marginTop={1}>
				<Text color={theme.accent}>{"> "}</Text>
				<Text>{shown}</Text>
				<Text inverse> </Text>
			</Box>
			{error ? <Text color={theme.error}>{error}</Text> : null}
			<Box marginTop={1}>
				<Text dimColor>
					Enter confirm · Esc cancel{optional ? " · empty skips" : ""}
					{pad ? " · ○ cancel" : ""}
				</Text>
			</Box>
		</Box>
	);
}
