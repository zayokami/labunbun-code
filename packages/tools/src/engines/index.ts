/**
 * The native reverse-engineering engine tools.
 *
 * Two static analyzers (IDA, Ghidra) import a private copy and never execute
 * it; two dynamic tools (Frida, x64dbg) do execute. The families are separate
 * in behavior, permissions, and description, and `DetectReverseEngines` is the
 * only read-only member because it never starts a process.
 */
export {
	defaultProbe,
	discoverEngine,
	discoverEngines,
	ENGINE_LABELS,
	type EngineId,
	type EngineInstall,
	type EngineSource,
	type Probe,
} from "./common.ts";
export { createDetectReverseEnginesTool, type DetectReverseEnginesOptions } from "./detect.ts";
export { createInstrumentWithFridaTool, createListFridaTargetsTool, type FridaToolOptions } from "./frida.ts";
export { type AnalyzeWithGhidraOptions, createAnalyzeWithGhidraTool } from "./ghidra.ts";
export { type AnalyzeWithIdaOptions, createAnalyzeWithIdaTool } from "./ida.ts";
export { createDebugWithX64dbgTool, type DebugWithX64dbgOptions } from "./x64dbg.ts";
