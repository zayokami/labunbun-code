import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";

/**
 * The first frame's greeting.
 *
 * An empty session used to draw nothing above the prompt: no name, no version,
 * no sign of what the program can do. The banner is the one screen a new user
 * reads before they have typed anything, so it carries the three facts that
 * were missing — what this is, where it runs, and the four keys that get
 * someone started — without pushing the prompt off the screen.
 *
 * It is the live frame's, not the transcript's: once the first message is sent
 * the greeting has done its job and goes away, the way Claude Code's welcome
 * does. Nothing here is printed into the scrollback, so a cleared screen still
 * starts with this one.
 */

/** Below this many columns the label alone is the whole greeting. */
export const WELCOME_MINIMAL_MIN_COLUMNS = 34;
/** Two columns need this much room for the tips to stay on one line each. */
export const WELCOME_WIDE_MIN_COLUMNS = 78;
/**
 * The mascot and the tips are taller than the prompt on a short terminal.
 *
 * These are budget numbers, not style choices. The live frame under the banner
 * (status + prompt + its legend) is six rows, the frame cap is one row short of
 * the viewport, and Ink switches to its clear-and-reprint path the moment a
 * frame reaches the last row. So the two-column panel (15 rows, plus its
 * margin) needs 24, and the one-column panel (11 rows) needs 20; anything less
 * gets the two-line label. A greeting that costs the prompt visible rows — or
 * worse, puts the frame into the fullscreen path where ConPTY reprints the
 * scrollback — is not worth the extra tips.
 */
export const WELCOME_MIN_ROWS = 14;
export const WELCOME_COMPACT_MIN_COLUMNS = 50;
export const WELCOME_COMPACT_MIN_ROWS = 20;
export const WELCOME_WIDE_MIN_ROWS = 24;

export type WelcomeLayout = "wide" | "compact" | "minimal" | "hidden";

/**
 * How much of the greeting fits. Pure so the thresholds are testable: a frame
 * carries no ANSI under the test runner, and the decision is the interesting
 * part — the drawing is just rows.
 */
export function welcomeLayout(columns: number, rows: number): WelcomeLayout {
	if (columns < WELCOME_MINIMAL_MIN_COLUMNS || rows < WELCOME_MIN_ROWS) return "hidden";
	if (columns >= WELCOME_WIDE_MIN_COLUMNS && rows >= WELCOME_WIDE_MIN_ROWS) return "wide";
	if (columns >= WELCOME_COMPACT_MIN_COLUMNS && rows >= WELCOME_COMPACT_MIN_ROWS) return "compact";
	return "minimal";
}

/**
 * The mascot, as rows of equal width so the column centers it without a
 * measurement. Ears, eyes and a nose: a bun, not a wordmark. It is drawn in
 * the accent colour and nothing else, which is what keeps it from competing
 * with the tips beside it.
 */
export const MASCOT = [
	"   ██   ██   ",
	"   ██   ██   ",
	"  ███████████",
	"  ██ ▀   ▀ ██",
	"  ██   ▄   ██",
	"  ██  ▄ ▄  ██",
	"   ▀███████▀ ",
];

/**
 * The rows of the tips column. Order is the order a new reader needs them:
 * the command list first (everything else is in there), then the three
 * gestures that are not text, then the interrupt.
 */
export const TIPS: ReadonlyArray<readonly [string, string]> = [
	["/help", "list every command"],
	["/model", "switch the model"],
	["@path", "mention a file"],
	["shift+tab", "change the permission mode"],
	["esc", "interrupt a running turn"],
	["?", "show all keybindings"],
];

/** Padded to the longest key (`shift+tab`) plus two, so descriptions align. */
const TIP_KEY_WIDTH = 11;

/**
 * A path cut from the left rather than the right: the tail is the part that
 * says where you are, and an ellipsis on the left is how every terminal
 * prompt has abbreviated a deep directory.
 */
export function fitPath(path: string, width: number): string {
	if (width <= 0) return "";
	if (path.length <= width) return path;
	if (width === 1) return "…";
	return `…${path.slice(path.length - (width - 1))}`;
}

/** One line of a two-column row, quietly labelled. */
function MetaRow({ label, value, width }: { label: string; value: string; width: number }) {
	return (
		<Text dimColor>
			{label.padEnd(7)}
			{fitPath(value, Math.max(1, width - 7))}
		</Text>
	);
}

function Mascot() {
	const theme = useTheme();
	return <Text color={theme.accent}>{MASCOT.join("\n")}</Text>;
}

function Version({ version }: { version?: string }) {
	if (!version) return null;
	return <Text dimColor> v{version}</Text>;
}

/**
 * The greeting panel.
 *
 * `columns`/`rows` come from Ink's window size rather than `process.stdout`,
 * so a resize re-lays it out with the rest of the frame. `cwd` is the
 * workspace root, not the basename: a greeting that only says `labunbun`
 * could be any of a dozen checkouts.
 */
export function WelcomeBanner({
	columns,
	rows,
	noticeRows = 0,
	version,
	cwd,
	modelName,
}: {
	columns: number;
	rows: number;
	/**
	 * Rows the startup notices below the panel already take. They are not the
	 * panel's to draw, but they are the terminal's to spend: three diagnostics on
	 * a 24-row screen leave the two-column greeting with no room, and a frame
	 * that overflows clips its own top border. Counted here so the panel steps
	 * down instead.
	 */
	noticeRows?: number;
	version?: string;
	cwd?: string;
	modelName: string;
}) {
	const theme = useTheme();
	const layout = welcomeLayout(columns, Math.max(0, rows - noticeRows));
	if (layout === "hidden") return null;

	// Full frame width, like the prompt below it: a panel narrower than the box
	// it introduces reads as a floating card that has nothing to do with the
	// session. The tips column takes whatever is left after the mascot.
	const width = columns;
	// The wide layout gives the mascot a column as wide as the welcome line, so
	// the two center under each other. The compact one only has the mascot in
	// it, so it can give the sentence every column it does not need.
	const leftWidth = layout === "wide" ? 30 : 16;
	// What is left for a value once the right column's chrome is taken out.
	const rightWidth = Math.max(18, width - leftWidth - 8);

	if (layout === "minimal") {
		return (
			<Box marginBottom={1}>
				<Box width={width} borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column">
					<Text>
						<Text color={theme.accent} bold>
							Welcome to LaBunbun Code
						</Text>
						<Version version={version} />
					</Text>
					<Text dimColor>/help commands · @ files · ? keys</Text>
				</Box>
			</Box>
		);
	}

	return (
		<Box marginBottom={1}>
			<Box width={width} borderStyle="round" borderColor={theme.accent} flexDirection="row" paddingX={1} paddingY={1}>
				<Box width={leftWidth} flexDirection="column" alignItems="center" paddingX={1}>
					<Mascot />
					{layout === "wide" ? (
						<>
							<Text> </Text>
							<Text color={theme.accent} bold>
								Welcome to LaBunbun Code
							</Text>
							{/* The version gets its own row. Inline, it pushed the greeting
							    past the column's padding and Ink wrapped it alone anyway —
							    same rows, but at a width nobody chose. */}
							{version ? <Text dimColor>v{version}</Text> : null}
						</>
					) : null}
				</Box>
				{layout === "wide" ? (
					<Box
						flexGrow={1}
						flexDirection="column"
						borderStyle="single"
						borderTop={false}
						borderRight={false}
						borderBottom={false}
						borderColor={theme.border}
						paddingLeft={2}
					>
						<Text color={theme.accent} bold>
							Tips for getting started
						</Text>
						<Text> </Text>
						{TIPS.map(([key, description]) => (
							<Text key={key}>
								<Text color={theme.accent}>{key.padEnd(TIP_KEY_WIDTH)}</Text>
								<Text dimColor>{description}</Text>
							</Text>
						))}
						<Text> </Text>
						<MetaRow label="cwd" value={cwd ?? ""} width={rightWidth} />
						<MetaRow label="model" value={modelName} width={rightWidth} />
					</Box>
				) : (
					<Box flexGrow={1} flexDirection="column" paddingLeft={2}>
						<Text>
							<Text color={theme.accent} bold>
								Welcome to LaBunbun Code
							</Text>
							<Version version={version} />
						</Text>
						<Text> </Text>
						<Text dimColor>/help commands · /model models</Text>
						<Text dimColor>@ file · shift+tab mode · esc stop</Text>
						<Text dimColor>{fitPath(cwd ?? "", rightWidth)}</Text>
					</Box>
				)}
			</Box>
		</Box>
	);
}
