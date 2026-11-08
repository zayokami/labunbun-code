/**
 * DetectReverseEngines — the one read-only member of the engine family.
 *
 * It reads the filesystem and the environment and nothing else: no engine is
 * started, so a detection says an install was found, not that it works. The
 * distinction matters in the report, because a program found on PATH can still
 * fail to start, and the analysis tools are the ones that find out.
 */
import { type AnyTool, buildTool } from "@labunbun/agent";
import { z } from "zod";
import { defaultProbe, discoverEngines, ENGINE_LABELS, type EngineId, type EngineInstall } from "./common.ts";

export interface DetectReverseEnginesOptions {
	env?: NodeJS.ProcessEnv;
}

const SOURCE_LABELS: Record<EngineInstall["source"], string> = {
	environment: "named in the environment",
	path: "found on PATH",
	"known-location": "found at a well-known install location",
};

const ENV_NAMES: Record<EngineId, string> = {
	ida: "LBB_IDA_PATH",
	ghidra: "LBB_GHIDRA_HOME",
	frida: "LBB_FRIDA_PATH",
	x64dbg: "LBB_X64DBG_PATH",
};

/** What each engine's absence means for the tools that need it. */
const MISSING_HINT: Record<EngineId, string> = {
	ida: "AnalyzeWithIda is unavailable until IDA Pro is installed or LBB_IDA_PATH names idat64/idat.",
	ghidra: "AnalyzeWithGhidra is unavailable until Ghidra is installed or LBB_GHIDRA_HOME names the install.",
	frida:
		"ListFridaTargets and InstrumentWithFrida are unavailable until frida-tools is installed or LBB_FRIDA_PATH names the CLI.",
	x64dbg: "DebugWithX64dbg is unavailable until x64dbg is installed; it also needs the headless.exe build.",
};

/** Report which reverse-engineering engines this machine has, without starting one. */
export function createDetectReverseEnginesTool(options: DetectReverseEnginesOptions = {}): AnyTool {
	return buildTool({
		name: "DetectReverseEngines",
		description:
			"Reports which reverse-engineering engines are installed and where: IDA Pro, Ghidra, Frida and x64dbg. " +
			"Detection only reads the filesystem; no engine is started, so a found install is not yet a working one. " +
			"Use it before calling AnalyzeWithIda, AnalyzeWithGhidra, ListFridaTargets, InstrumentWithFrida, or " +
			"DebugWithX64dbg to learn what the machine has.",
		inputSchema: z.object({}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async () => {
			const found = discoverEngines(defaultProbe(options.env));
			const byId = new Map(found.map((install) => [install.id, install]));
			const lines = ["Reverse-engineering engines found on this machine:", ""];
			for (const id of Object.keys(ENGINE_LABELS) as EngineId[]) {
				const install = byId.get(id);
				const label = ENGINE_LABELS[id];
				if (install === undefined) {
					lines.push(`${label}: not found`);
					lines.push(`  ${MISSING_HINT[id]}`);
					lines.push(`  Detection looked for ${ENV_NAMES[id]}, PATH entries, and the tool's usual install locations.`);
					lines.push("");
					continue;
				}
				lines.push(`${label}: ${install.program}`);
				lines.push(
					`  ${SOURCE_LABELS[install.source]}${install.version === undefined ? "" : `, version ${install.version}`}`,
				);
				if (install.home !== undefined) lines.push(`  install: ${install.home}`);
				if (id === "x64dbg") {
					lines.push(`  x64 headless: ${install.details?.headlessX64 ?? "not found"}`);
					lines.push(`  x32 headless: ${install.details?.headlessX32 ?? "not found"}`);
				}
				lines.push("");
			}
			lines.push("Detection does not start an engine; the analysis tools report whether it runs.");
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	});
}
