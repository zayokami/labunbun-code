import type { PadBridge } from "@labunbun/gamepad";
import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { isAimedAt, usePadAction } from "../pad.ts";
import { dropLastChar } from "../terminal-input.ts";
import { useTheme } from "../theme.ts";
import type { PhraseConfirmState } from "../ui-state.ts";

/**
 * The YOLO confirmation: a typed sentence, matched exactly.
 *
 * Deliberately not the structured question dialog. That dialog's free-text row
 * resolves whatever was typed, which is the opposite of a safety confirmation:
 * here a mismatch keeps the dialog open, shows why, and counts for nothing. The
 * comparison is exact after trimming surrounding whitespace, case included.
 *
 * The field is keyboard territory. The pad can cancel with ○, but its confirm
 * button does nothing — a button that accepts a phrase nobody typed would turn
 * the one typed acknowledgment in the app back into a keypress.
 */
export function PhraseConfirmDialog({
	phrase,
	title,
	off,
	on,
	sandbox,
	note,
	resolve,
	pad,
}: PhraseConfirmState & { pad?: PadBridge }) {
	const theme = useTheme();
	const [typed, setTyped] = useState("");
	const [error, setError] = useState<string | null>(null);
	/** When this dialog appeared, so a button held from before cannot act on it. */
	const openedAt = useRef(Date.now());

	const submit = (): void => {
		if (typed.trim() === phrase) {
			resolve(true);
			return;
		}
		// The dialog stays up. The sentence names the one thing that is most
		// likely wrong — the capitalisation — because the phrase is displayed and
		// "wrong" alone would send the user hunting for a typo they cannot see.
		setError(`That is not the phrase. Type it exactly, capitalisation included: ${phrase}`);
	};

	usePadAction(pad, (action) => {
		if (action.phase === "release" || !isAimedAt(action, openedAt.current)) return false;
		// The only pad key that does anything is cancel. Confirm is swallowed on
		// purpose: the phrase has to be typed, and there is no button that types.
		if (action.kind === "cancel") {
			resolve(false);
			return true;
		}
		return true;
	});

	useInput((input, key) => {
		if (key.escape) {
			resolve(false);
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
		// Control and meta chords are not phrase characters. Arrows and function
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

	return (
		<Box flexDirection="column" borderStyle="single" borderColor={theme.permission} paddingX={1} marginBottom={1}>
			<Text color={theme.permission} bold>
				{title}
			</Text>
			<Box flexDirection="column" marginTop={1}>
				<Text color={theme.warning}>Stops:</Text>
				{off.map((line) => (
					<Text key={line} color={theme.textMuted}>
						{"  "}
						{line}
					</Text>
				))}
			</Box>
			<Box flexDirection="column" marginTop={1}>
				<Text color={theme.textMuted}>Still applies:</Text>
				{on.map((line) => (
					<Text key={line} color={theme.textMuted}>
						{"  "}
						{line}
					</Text>
				))}
			</Box>
			<Text color={theme.textMuted}>
				Sandbox: <Text color={theme.accent}>{sandbox}</Text> — the sandbox is now the only automatic containment.
			</Text>
			{note ? <Text color={theme.textMuted}>{note}</Text> : null}
			<Box flexDirection="column" marginTop={1}>
				<Text>
					Type exactly:{" "}
					<Text color={theme.accent} bold>
						{phrase}
					</Text>
				</Text>
				<Text dimColor>The phrase is case-sensitive.</Text>
			</Box>
			<Box marginTop={1}>
				<Text color={theme.selection}>{"> "}</Text>
				<Text>{typed.length > 0 ? typed : " "}</Text>
			</Box>
			{error ? <Text color={theme.error}>{error}</Text> : null}
			<Box marginTop={1}>
				<Text dimColor>Enter confirm · Esc cancel{pad ? " · ○ cancel" : ""}</Text>
			</Box>
		</Box>
	);
}
