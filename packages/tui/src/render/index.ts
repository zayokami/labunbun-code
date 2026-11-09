/**
 * The cell-grid renderer: a TypedArray double buffer, a frame diff, and the
 * ANSI writer that puts the difference on a terminal.
 *
 * The pieces are exported separately because they answer different questions.
 * `CellBuffer` is one screen of cells; `CellGrid` is the front/back pair and the
 * diff between them; `TerminalScreen` is the lifecycle around a stream. A test
 * or a tool can drive any layer without a terminal, and a full-screen view only
 * needs `TerminalScreen`.
 */

export { CellBuffer, CellGrid } from "./cell-grid.ts";
export {
	type CellStyle,
	type Color,
	StyleTable,
} from "./cell-style.ts";
export {
	chunkFrame,
	diffBuffers,
	encodeFrame,
	type FrameOp,
	type FrameOptions,
} from "./frame.ts";
export {
	type CursorPosition,
	type ScreenStream,
	TerminalScreen,
	type TerminalScreenOptions,
} from "./terminal-screen.ts";
export { codePointWidth, displayWidth, graphemeWidth } from "./width.ts";
