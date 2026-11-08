/**
 * AnalyzeWithGhidra — Ghidra's `analyzeHeadless` over an original Java
 * post-script.
 *
 * REA's Ghidra provider keeps one JVM alive per target and speaks NDJSON over a
 * private socket; that is the right shape for a long analysis session and the
 * wrong shape for a first slice, because it needs a resident bridge process to
 * own and reap. This tool instead runs one headless import, gives the analysis
 * a generous ceiling, and reads a JSON file the post-script writes. Ghidra can
 * take several minutes to start on Windows; the timeout is set for that and the
 * message on failure says so rather than blaming the target.
 *
 * The script is generated per call with the request's parameters embedded as
 * constants, so no caller text is ever parsed as Java or passed through a
 * command line. The target is a private copy, the project is ephemeral, and the
 * target is never executed.
 */
import { join } from "node:path";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import { guardPathContainment } from "../containment.ts";
import type { Operations } from "../operations.ts";
import { resolveWritableRoots } from "../sandbox/default-writable-roots.ts";
import { workspacePolicy } from "../sandbox/workspace-policy.ts";
import {
	assertCommandSafe,
	assertTargetFile,
	copyTarget,
	createEngineWorkspace,
	defaultProbe,
	discoverEngine,
	engineFailureText,
	missingEngineText,
	quoteToken,
	readResult,
	runEngineCommand,
	tailLines,
	writeRequest,
} from "./common.ts";

const MAX_REPORT_CHARS = 24_000;
const RESULT_FILE = "out.json";
const BRIDGE_FILE = "LbbBridge.java";
const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TIMEOUT_SECONDS = 1_800;

const ACTIONS = [
	"metadata",
	"functions",
	"strings",
	"segments",
	"exports",
	"function",
	"decompile",
	"xrefs",
	"bytes",
] as const;

const inputSchema = z.object({
	path: z.string().describe("Path to the executable or object file, inside the workspace"),
	action: z
		.enum(ACTIONS)
		.default("metadata")
		.describe(
			"What to read from the imported program: metadata, functions, strings, segments, exports, function, decompile, xrefs, or bytes.",
		),
	address: z.string().optional().describe("Hexadecimal address (0x...) for function, decompile, xrefs and bytes"),
	name: z.string().optional().describe("Function or symbol name, used instead of address where one is accepted"),
	limit: z.number().int().min(1).max(5_000).optional().describe("Maximum rows to return (default 200)"),
	offset: z.number().int().min(0).max(1_000_000).optional().describe("Rows to skip in a paginated listing"),
	length: z.number().int().min(1).max(4_096).optional().describe("Byte count for action=bytes (default 64)"),
	timeoutSeconds: z
		.number()
		.int()
		.min(30)
		.max(MAX_TIMEOUT_SECONDS)
		.optional()
		.describe(`Wall-clock analysis ceiling (default ${DEFAULT_TIMEOUT_SECONDS}s; Ghidra cold starts are slow)`),
});

type GhidraInput = z.infer<typeof inputSchema>;

export interface AnalyzeWithGhidraOptions {
	tempDir?: string;
	env?: NodeJS.ProcessEnv;
	/** An explicit `analyzeHeadless` path, for tests and unusual installs. */
	enginePath?: string;
}

interface GhidraFunctionRow {
	address: string;
	name: string;
	size?: number;
}
interface GhidraStringRow {
	address: string;
	value: string;
	length?: number;
}
interface GhidraSegmentRow {
	name: string;
	start: string;
	end: string;
	size?: number;
	permissions?: string;
	initialized?: boolean;
}
interface GhidraExportRow {
	address: string;
	name: string;
}
interface GhidraResult {
	error?: string;
	trace?: string;
	file?: string;
	path?: string;
	imageBase?: string;
	processor?: string;
	is64Bit?: boolean;
	version?: string;
	functionCount?: number;
	segments?: GhidraSegmentRow[];
	entries?: unknown;
	hasMore?: boolean;
	/** The defined-data scan hit its budget before the listing did. */
	scanCapped?: boolean;
	offset?: number;
	limit?: number;
	address?: string;
	start?: string;
	end?: string;
	size?: number;
	name?: string;
	instructions?: Array<{ address: string; text: string }>;
	truncated?: boolean;
	pseudocode?: string;
	length?: number;
	hex?: string;
}

/** Analyze one target with one headless Ghidra import and report the selected view. */
export function createAnalyzeWithGhidraTool(
	cwd: string,
	ops: Operations,
	options: AnalyzeWithGhidraOptions = {},
): AnyTool {
	return buildTool({
		name: "AnalyzeWithGhidra",
		description:
			"Analyzes an executable with Ghidra's headless analyzer and reads the imported program: metadata, function " +
			"and string inventories, memory blocks, exports, one function's disassembly, decompiler output, " +
			"cross-references, or raw bytes. The target is copied into a private workspace and imported into an " +
			"ephemeral project; the original is never modified or executed. Requires a Ghidra installation (set " +
			"LBB_GHIDRA_HOME when it is not found). Ghidra cold starts can take minutes; raise timeoutSeconds for a " +
			"large binary.",
		inputSchema,
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		validateInput: async (input) => {
			if (
				(input.action === "function" || input.action === "decompile" || input.action === "xrefs") &&
				!input.address &&
				!input.name
			) {
				return `${input.action} needs an address (0x...) or a function name.`;
			}
			if (input.action === "bytes" && !input.address) return "bytes needs an address (0x...).";
			if (input.address !== undefined && !/^(0x)?[0-9a-f]+$/i.test(input.address)) {
				return `address must be hexadecimal (0x...), got ${JSON.stringify(input.address)}.`;
			}
			return null;
		},
		call: async (input, ctx) => {
			let source: string;
			try {
				source = guardPathContainment(input.path, cwd, "AnalyzeWithGhidra");
				await assertTargetFile(source, input.path);
			} catch (error) {
				return errorResult(message(error));
			}
			if (ctx.sandbox === "read-only") {
				return errorResult(
					"AnalyzeWithGhidra needs a writable private workspace for its project and outputs; the session sandbox is read-only.",
				);
			}

			const installed =
				options.enginePath !== undefined
					? { program: options.enginePath }
					: discoverEngine("ghidra", defaultProbe(options.env));
			if (installed === undefined) return errorResult(missingEngineText("ghidra"));

			const workspace = await createEngineWorkspace("ghidra", options.tempDir);
			try {
				const target = await copyTarget(source, workspace);
				const requestPath = join(workspace.root, "req.json");
				const resultPath = join(workspace.root, RESULT_FILE);
				// The request file is written for evidence even though the generated
				// bridge carries the same values as constants.
				await writeRequest(requestPath, requestFor(input));
				await ops.writeTextFile(join(workspace.root, BRIDGE_FILE), ghidraBridgeSource(input, resultPath));

				const program = assertCommandSafe(installed.program, "Ghidra");
				const project = join(workspace.root, "project");
				const command = [
					quoteToken(program),
					quoteToken(project),
					"lbb",
					"-import",
					quoteToken(target.name),
					"-scriptPath",
					quoteToken(workspace.root),
					"-postScript",
					BRIDGE_FILE,
					"-deleteProject",
				].join(" ");
				const policy = await workspacePolicy(cwd, {
					sandbox: ctx.sandbox,
					network: ctx.network,
					writableRoots: [
						{ path: workspace.root, kind: "data" },
						...resolveWritableRoots({ tempDir: options.tempDir }),
					],
				});
				const timeoutMs = Math.min(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1_000;
				const run = await runEngineCommand({
					ops,
					command,
					cwd: workspace.root,
					timeoutMs,
					signal: ctx.signal,
					sandbox: policy,
				});

				const parsed = await readResult<GhidraResult>(resultPath);
				if ("error" in parsed) {
					// Ghidra's own console is where a failed import or a failed script
					// compile says why; the result file does not exist then.
					return errorResult(engineFailureText("Ghidra", run));
				}
				if (parsed.result.error !== undefined) {
					const where = parsed.result.trace === undefined ? "" : `\n${tailLines(parsed.result.trace, 10)}`;
					return errorResult(`Ghidra could not complete ${input.action}: ${parsed.result.error}${where}`);
				}
				return { content: [{ type: "text", text: cap(render(input, parsed.result)) }] };
			} catch (error) {
				return errorResult(message(error));
			} finally {
				const cleaned = await workspace.cleanup();
				if (!cleaned) console.error(`AnalyzeWithGhidra: could not remove ${workspace.root}`);
			}
		},
	});
}

function requestFor(input: GhidraInput): Record<string, unknown> {
	return {
		action: input.action,
		address: input.address,
		name: input.name,
		limit: input.limit ?? 200,
		offset: input.offset ?? 0,
		length: input.length ?? 64,
	};
}

function render(input: GhidraInput, result: GhidraResult): string {
	switch (input.action) {
		case "metadata": {
			const lines = [
				`Ghidra analysis of ${result.file ?? input.path}`,
				`  image base: ${result.imageBase ?? "unknown"}`,
				`  processor: ${result.processor ?? "unknown"}${result.is64Bit ? " (64-bit)" : ""}`,
				`  Ghidra version: ${result.version ?? "unknown"}`,
				`  functions: ${result.functionCount ?? "unknown"}`,
			];
			return [...lines, ...renderSegments(result.segments)].join("\n");
		}
		case "segments":
			return [`Ghidra memory blocks of ${input.path}`, ...renderSegments(result.segments)].join("\n");
		case "functions": {
			const rows = (result.entries ?? []) as GhidraFunctionRow[];
			const lines = [`Ghidra functions in ${input.path} (offset ${result.offset ?? 0})`];
			for (const row of rows) {
				const size = row.size === undefined ? "" : `  (${row.size} bytes)`;
				lines.push(`  ${row.address}  ${row.name}${size}`);
			}
			if (rows.length === 0) lines.push("  (none)");
			if (result.hasMore) lines.push(nextPageHint(rows.length, result.offset));
			return lines.join("\n");
		}
		case "strings": {
			const rows = (result.entries ?? []) as GhidraStringRow[];
			const lines = [`Ghidra strings in ${input.path} (offset ${result.offset ?? 0})`];
			for (const row of rows) lines.push(`  ${row.address}  ${quote(row.value)}`);
			if (rows.length === 0) lines.push("  (none)");
			if (result.scanCapped) {
				lines.push("  ... the scan stopped after 2,000,000 defined data items; later strings were not examined.");
			}
			if (result.hasMore) lines.push(nextPageHint(rows.length, result.offset));
			return lines.join("\n");
		}
		case "exports": {
			const rows = (result.entries ?? []) as GhidraExportRow[];
			const lines = [`Ghidra external entry points of ${input.path}`];
			for (const row of rows) lines.push(`  ${row.address}  ${row.name || "(unnamed)"}`);
			if (rows.length === 0) lines.push("  (none)");
			if (result.hasMore) lines.push(nextPageHint(rows.length, result.offset));
			return lines.join("\n");
		}
		case "function": {
			const lines = [
				`Ghidra function ${result.name ?? "(unnamed)"} at ${result.address ?? "?"}`,
				`  range: ${result.start ?? "?"}..${result.end ?? "?"}${result.size === undefined ? "" : ` (${result.size} bytes)`}`,
			];
			for (const instruction of result.instructions ?? []) {
				lines.push(`  ${instruction.address}  ${instruction.text}`);
			}
			if (result.truncated) lines.push("  ... more instructions not shown; raise limit.");
			return lines.join("\n");
		}
		case "decompile":
			return [
				`Ghidra decompiler output for ${result.name ?? input.name ?? input.address ?? "?"} at ${result.address ?? "?"}`,
				"",
				result.pseudocode ?? "(no decompiler output)",
			].join("\n");
		case "xrefs": {
			const rows = (result.entries ?? []) as Array<{ from: string; to: string; type?: string; isCall?: boolean }>;
			const lines = [`Ghidra references to ${result.address ?? input.address ?? input.name ?? "?"}`];
			for (const row of rows) {
				lines.push(
					`  ${row.from} -> ${row.to}${row.type === undefined ? "" : `  ${row.type}`}${row.isCall ? " (call)" : ""}`,
				);
			}
			if (rows.length === 0) lines.push("  (none)");
			if (result.hasMore) lines.push("  ... more references not shown; raise limit.");
			return lines.join("\n");
		}
		case "bytes":
			return [
				`Ghidra bytes at ${result.address ?? input.address ?? "?"} (${result.length ?? 0} bytes)`,
				`  ${result.hex ?? ""}`,
			].join("\n");
		default:
			return `Ghidra returned an unexpected action result for ${String(input.action)}.`;
	}
}

function renderSegments(segments: GhidraSegmentRow[] | undefined): string[] {
	if (segments === undefined || segments.length === 0) return ["  memory blocks: (none)"];
	const lines = [`  memory blocks (${segments.length}):`];
	for (const segment of segments.slice(0, 40)) {
		const size = segment.size === undefined ? "" : `  ${segment.size} bytes`;
		const permissions = segment.permissions === undefined ? "" : `  ${segment.permissions}`;
		lines.push(`    ${segment.start}..${segment.end}  ${segment.name}${size}${permissions}`);
	}
	if (segments.length > 40) lines.push(`    ... ${segments.length - 40} more blocks`);
	return lines;
}

function nextPageHint(shown: number, offset: number | undefined): string {
	return `  ... listing continues; next call: offset=${(offset ?? 0) + shown}.`;
}

function quote(value: string): string {
	const shortened = value.length > 300 ? `${value.slice(0, 299)}…` : value;
	return JSON.stringify(shortened);
}

function cap(report: string): string {
	if (report.length <= MAX_REPORT_CHARS) return report;
	return `${report.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(report.length - MAX_REPORT_CHARS)}`;
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A Java string literal, with the characters Java treats specially escaped. */
function javaString(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t");
}

/**
 * The bridge source for one call. Parameters are constants rather than a
 * request file: Ghidra compiles this file each run, so there is no parser here
 * that caller text could reach, and no quoting between two process layers.
 */
function ghidraBridgeSource(input: GhidraInput, resultPath: string): string {
	const values: Record<string, string> = {
		__ACTION__: javaString(input.action),
		__ADDRESS__: javaString(input.address ?? ""),
		__NAME__: javaString(input.name ?? ""),
		__LIMIT__: String(input.limit ?? 200),
		__OFFSET__: String(input.offset ?? 0),
		__LENGTH__: String(input.length ?? 64),
		__RESULT__: javaString(resultPath),
	};
	// One scan with a function replacer. A replacement string has its own
	// syntax — `$&`, `$'`, `` $` `` and `$$` expand — and chained replacements
	// would also rewrite a placeholder that appeared in an earlier value, so a
	// symbol named `__LIMIT__` would leave the real constant undefined. A single
	// pass over the template makes caller text inert in both ways.
	return GHIDRA_BRIDGE.replace(/__[A-Z]+__/g, (token) => values[token] ?? token);
}

/**
 * Java source for the post-script. It subclasses GhidraScript, uses only the
 * long-stable program model APIs (FunctionManager, SymbolTable, Listing,
 * ReferenceManager, DecompInterface), and writes one JSON object to the path
 * compiled into it.
 */
const GHIDRA_BRIDGE = String.raw`
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolTable;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

public class LbbBridge extends GhidraScript {
    private static final String ACTION = "__ACTION__";
    private static final String ADDRESS = "__ADDRESS__";
    private static final String NAME = "__NAME__";
    private static final int LIMIT = __LIMIT__;
    private static final int OFFSET = __OFFSET__;
    private static final int LENGTH = __LENGTH__;
    private static final String RESULT = "__RESULT__";

    private static String json(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder out = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            switch (ch) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        out.append(String.format("\\u%04x", (int) ch));
                    } else {
                        out.append(ch);
                    }
            }
        }
        return out.append('"').toString();
    }

    private static String error(String message) {
        return "{\"error\":" + json(message) + "}";
    }

    private Address resolve() throws Exception {
        if (ADDRESS != null && ADDRESS.length() > 0) {
            Address address;
            try {
                address = toAddr(ADDRESS);
            } catch (RuntimeException exception) {
                // AddressOutOfBoundsException is unchecked: AddressEvaluator only
                // converts its own checked ExpressionException to null, so a value
                // larger than the space would otherwise surface as Java internals.
                throw new Exception("address " + ADDRESS + " is outside this program's address space");
            }
            if (address == null) {
                throw new Exception("could not parse address " + ADDRESS);
            }
            return address;
        }
        if (NAME == null || NAME.length() == 0) {
            throw new Exception("an address (0x...) or a symbol name is required");
        }
        SymbolTable table = currentProgram.getSymbolTable();
        SymbolIterator symbols = table.getSymbols(NAME);
        while (symbols.hasNext()) {
            Symbol symbol = symbols.next();
            if (!symbol.isExternal()) {
                return symbol.getAddress();
            }
        }
        throw new Exception("no symbol named " + NAME);
    }

    private Function functionAt(Address address) throws Exception {
        Function function = getFunctionAt(address);
        if (function == null) {
            function = getFunctionContaining(address);
        }
        if (function == null) {
            throw new Exception("no function contains address " + address);
        }
        return function;
    }

    private String segmentsJson() {
        Memory memory = currentProgram.getMemory();
        StringBuilder out = new StringBuilder("[");
        MemoryBlock[] blocks = memory.getBlocks();
        for (int index = 0; index < blocks.length; index++) {
            MemoryBlock block = blocks[index];
            if (index > 0) {
                out.append(',');
            }
            out.append("{\"name\":").append(json(block.getName()));
            out.append(",\"start\":").append(json(block.getStart().toString()));
            out.append(",\"end\":").append(json(block.getEnd().toString()));
            out.append(",\"size\":").append(block.getSize());
            out.append(",\"permissions\":").append(json(
                (block.isRead() ? "r" : "") + (block.isWrite() ? "w" : "") + (block.isExecute() ? "x" : "")));
            out.append(",\"initialized\":").append(block.isInitialized());
            out.append('}');
        }
        return out.append(']').toString();
    }

    private String listingJson(List<String> rows, boolean hasMore) {
        return listingJson(rows, hasMore, false);
    }

    private String listingJson(List<String> rows, boolean hasMore, boolean scanCapped) {
        StringBuilder out = new StringBuilder("{\"offset\":").append(OFFSET);
        out.append(",\"limit\":").append(LIMIT);
        out.append(",\"count\":").append(rows.size());
        out.append(",\"hasMore\":").append(hasMore);
        out.append(",\"scanCapped\":").append(scanCapped);
        out.append(",\"entries\":[");
        for (int index = 0; index < rows.size(); index++) {
            if (index > 0) {
                out.append(',');
            }
            out.append(rows.get(index));
        }
        return out.append("]}").toString();
    }

    private String functionsJson() {
        List<String> rows = new ArrayList<String>();
        boolean hasMore = false;
        int seen = 0;
        for (Function function : currentProgram.getFunctionManager().getFunctions(true)) {
            if (seen < OFFSET) {
                seen++;
                continue;
            }
            if (rows.size() >= LIMIT) {
                hasMore = true;
                break;
            }
            rows.add("{\"address\":" + json(function.getEntryPoint().toString())
                + ",\"name\":" + json(function.getName())
                + ",\"size\":" + function.getBody().getNumAddresses() + "}");
            seen++;
        }
        return listingJson(rows, hasMore);
    }

    private String stringsJson() {
        List<String> rows = new ArrayList<String>();
        boolean hasMore = false;
        int seen = 0;
        int scanned = 0;
        Listing listing = currentProgram.getListing();
        DataIterator data = listing.getDefinedData(true);
        while (data.hasNext() && scanned < 2000000) {
            Data item = data.next();
            scanned++;
            if (!item.hasStringValue()) {
                continue;
            }
            if (seen < OFFSET) {
                seen++;
                continue;
            }
            if (rows.size() >= LIMIT) {
                hasMore = true;
                break;
            }
            Object value = item.getValue();
            rows.add("{\"address\":" + json(item.getAddress().toString())
                + ",\"value\":" + json(value == null ? "" : value.toString()) + "}");
            seen++;
        }
        // The scan cap is a budget, not the end of the program: say the list is
        // incomplete rather than letting a huge image read as fully enumerated.
        // hasMore is not the right word — raising offset would meet the same
        // cap — so the listing carries its own flag.
        boolean scanCapped = data.hasNext();
        return listingJson(rows, hasMore, scanCapped);
    }

    private String exportsJson() {
        List<String> rows = new ArrayList<String>();
        boolean hasMore = false;
        int seen = 0;
        SymbolTable table = currentProgram.getSymbolTable();
        var entries = table.getExternalEntryPointIterator();
        while (entries.hasNext()) {
            Address address = entries.next();
            if (seen < OFFSET) {
                seen++;
                continue;
            }
            if (rows.size() >= LIMIT) {
                hasMore = true;
                break;
            }
            Symbol symbol = table.getPrimarySymbol(address);
            rows.add("{\"address\":" + json(address.toString())
                + ",\"name\":" + json(symbol == null ? "" : symbol.getName()) + "}");
            seen++;
        }
        return listingJson(rows, hasMore);
    }

    private String metadataJson() {
        return "{\"file\":" + json(currentProgram.getName())
            + ",\"path\":" + json(currentProgram.getExecutablePath())
            + ",\"imageBase\":" + json(currentProgram.getImageBase().toString())
            + ",\"processor\":" + json(currentProgram.getLanguageID().toString())
            + ",\"is64Bit\":" + (currentProgram.getAddressFactory().getDefaultAddressSpace().getSize() == 64)
            + ",\"version\":" + json(Application.getApplicationVersion())
            + ",\"functionCount\":" + currentProgram.getFunctionManager().getFunctionCount()
            + ",\"segments\":" + segmentsJson() + "}";
    }

    private String functionJson() throws Exception {
        Address address = resolve();
        Function function = functionAt(address);
        List<String> instructions = new ArrayList<String>();
        boolean truncated = false;
        InstructionIterator iterator = currentProgram.getListing().getInstructions(function.getBody(), true);
        while (iterator.hasNext()) {
            Instruction instruction = iterator.next();
            if (instructions.size() >= LIMIT) {
                truncated = true;
                break;
            }
            instructions.add("{\"address\":" + json(instruction.getAddress().toString())
                + ",\"text\":" + json(instruction.toString()) + "}");
        }
        StringBuilder out = new StringBuilder("{\"address\":").append(json(function.getEntryPoint().toString()));
        out.append(",\"name\":").append(json(function.getName()));
        out.append(",\"start\":").append(json(function.getBody().getMinAddress().toString()));
        out.append(",\"end\":").append(json(function.getBody().getMaxAddress().toString()));
        out.append(",\"size\":").append(function.getBody().getNumAddresses());
        out.append(",\"truncated\":").append(truncated);
        out.append(",\"instructions\":[");
        for (int index = 0; index < instructions.size(); index++) {
            if (index > 0) {
                out.append(',');
            }
            out.append(instructions.get(index));
        }
        return out.append("]}").toString();
    }

    private String decompileJson() throws Exception {
        Address address = resolve();
        Function function = functionAt(address);
        DecompInterface decompiler = new DecompInterface();
        try {
            if (!decompiler.openProgram(currentProgram)) {
                return error("the decompiler could not open this program");
            }
            DecompileResults results = decompiler.decompileFunction(function, 120, monitor);
            if (results == null || !results.decompileCompleted()) {
                String reason = results == null ? "no result" : results.getErrorMessage();
                return error("decompilation failed: " + reason);
            }
            String text = results.getDecompiledFunction() == null ? "" : results.getDecompiledFunction().getC();
            return "{\"address\":" + json(function.getEntryPoint().toString())
                + ",\"name\":" + json(function.getName())
                + ",\"pseudocode\":" + json(text) + "}";
        } finally {
            decompiler.dispose();
        }
    }

    private String xrefsJson() throws Exception {
        Address address = resolve();
        ReferenceManager manager = currentProgram.getReferenceManager();
        List<String> rows = new ArrayList<String>();
        boolean hasMore = false;
        ReferenceIterator references = manager.getReferencesTo(address);
        while (references.hasNext()) {
            Reference reference = references.next();
            if (rows.size() >= LIMIT) {
                hasMore = true;
                break;
            }
            rows.add("{\"from\":" + json(reference.getFromAddress().toString())
                + ",\"to\":" + json(reference.getToAddress().toString())
                + ",\"type\":" + json(reference.getReferenceType().getName())
                + ",\"isCall\":" + reference.getReferenceType().isCall() + "}");
        }
        StringBuilder out = new StringBuilder("{\"address\":").append(json(address.toString()));
        out.append(",\"hasMore\":").append(hasMore);
        out.append(",\"entries\":[");
        for (int index = 0; index < rows.size(); index++) {
            if (index > 0) {
                out.append(',');
            }
            out.append(rows.get(index));
        }
        return out.append("]}").toString();
    }

    private String bytesJson() throws Exception {
        Address address = resolve();
        Memory memory = currentProgram.getMemory();
        StringBuilder hex = new StringBuilder();
        int read = 0;
        for (int index = 0; index < LENGTH; index++) {
            try {
                byte value = memory.getByte(address.add(index));
                hex.append(String.format("%02x", value & 0xff));
                read++;
            } catch (Exception stop) {
                break;
            }
        }
        if (read == 0) {
            return error("no bytes at " + address);
        }
        return "{\"address\":" + json(address.toString())
            + ",\"length\":" + read
            + ",\"hex\":" + json(hex.toString()) + "}";
    }

    private String handle() throws Exception {
        if ("metadata".equals(ACTION)) {
            return metadataJson();
        }
        if ("segments".equals(ACTION)) {
            return "{\"segments\":" + segmentsJson() + "}";
        }
        if ("functions".equals(ACTION)) {
            return functionsJson();
        }
        if ("strings".equals(ACTION)) {
            return stringsJson();
        }
        if ("exports".equals(ACTION)) {
            return exportsJson();
        }
        if ("function".equals(ACTION)) {
            return functionJson();
        }
        if ("decompile".equals(ACTION)) {
            return decompileJson();
        }
        if ("xrefs".equals(ACTION)) {
            return xrefsJson();
        }
        if ("bytes".equals(ACTION)) {
            return bytesJson();
        }
        return error("unknown action: " + ACTION);
    }

    @Override
    public void run() throws Exception {
        String output;
        try {
            output = handle();
        } catch (Throwable problem) {
            output = "{\"error\":" + json(problem.toString()) + "}";
        }
        Files.write(Paths.get(RESULT), output.getBytes(StandardCharsets.UTF_8));
    }
}
`;
