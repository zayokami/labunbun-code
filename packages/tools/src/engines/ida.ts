/**
 * AnalyzeWithIda — IDA Pro in batch mode, driven by an original IDAPython
 * bridge rather than by an MCP server.
 *
 * Why this shape: REA's IDA provider is an MCP client for an upstream server
 * and contains no IDA launcher of its own. What it does contribute is the
 * safety model, and that is the model copied here — copy the target into a
 * private workspace, verify the copy's digest, open the copy only, never save
 * a database, and report honestly what the analysis could not answer. The
 * bridge below is written for this tool; the operation names and the "0x…"
 * address rule follow REA's provider so an agent that learned one vocabulary
 * can use the other.
 *
 * The engine loads and parses the target; it never executes it. A Hex-Rays
 * license is required for `decompile`, and the tool says so when the plugin is
 * not there instead of returning an empty answer.
 */
import { readFile } from "node:fs/promises";
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
	isIdaDatabase,
	missingEngineText,
	quoteToken,
	readResult,
	runEngineCommand,
	writeRequest,
} from "./common.ts";

const MAX_REPORT_CHARS = 24_000;

/** What the bridge reads and writes, relative to the private workspace it runs in. */
const REQUEST_FILE = "req.json";
const RESULT_FILE = "out.json";
const BRIDGE_FILE = "bridge.py";
const LOG_FILE = "ida.log";

/** Analysis can legitimately take minutes on a large binary; the ceiling is the caller's. */
const DEFAULT_TIMEOUT_SECONDS = 600;
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
			"What to read. metadata: format, image base, processor, segment and function counts. " +
				"functions: the function inventory. strings: the string inventory. segments: memory layout. " +
				"exports: entry points and exported names. function: one function's disassembly. " +
				"decompile: Hex-Rays pseudocode for one function. xrefs: references to an address. " +
				"bytes: raw bytes at an address.",
		),
	address: z.string().optional().describe("Hexadecimal address (0x...) for function, decompile, xrefs and bytes"),
	name: z.string().optional().describe("Function or symbol name, used instead of address where one is accepted"),
	limit: z.number().int().min(1).max(5_000).optional().describe("Maximum rows to return (default 200)"),
	offset: z.number().int().min(0).max(1_000_000).optional().describe("Rows to skip in a paginated listing"),
	length: z.number().int().min(1).max(4_096).optional().describe("Byte count for action=bytes (default 64)"),
	timeoutSeconds: z
		.number()
		.int()
		.min(10)
		.max(MAX_TIMEOUT_SECONDS)
		.optional()
		.describe(`Wall-clock analysis ceiling (default ${DEFAULT_TIMEOUT_SECONDS}s)`),
});

type IdaInput = z.infer<typeof inputSchema>;

export interface AnalyzeWithIdaOptions {
	/** Where private workspaces are created; defaults to the system temp directory. */
	tempDir?: string;
	/** The install probe's environment. */
	env?: NodeJS.ProcessEnv;
	/** An explicit engine executable, for tests and unusual layouts. */
	enginePath?: string;
}

interface IdaFunctionRow {
	address: string;
	name: string;
	size?: number;
}
interface IdaStringRow {
	address: string;
	value: string;
	length?: number;
	type?: number;
}
interface IdaSegmentRow {
	name: string;
	start: string;
	end: string;
	size?: number;
	permissions?: string;
	class?: string;
}
interface IdaExportRow {
	address: string;
	name: string;
	ordinal?: number;
}
interface IdaMetadata {
	file?: string;
	path?: string;
	imageBase?: string;
	minAddress?: string;
	maxAddress?: string;
	processor?: string;
	is64Bit?: boolean;
	idaVersion?: string;
	functionCount?: number;
	segments?: IdaSegmentRow[];
}
interface IdaFunction {
	address?: string;
	name?: string;
	start?: string;
	end?: string;
	size?: number;
	instructions?: Array<{ address: string; text: string }>;
	truncated?: boolean;
	pseudocode?: string;
	error?: string;
}
interface IdaBytes {
	address?: string;
	length?: number;
	hex?: string;
	error?: string;
}
interface IdaResult extends IdaMetadata, IdaFunction, IdaBytes {
	// The bridge returns a different `entries` row shape per listing action, so
	// the render step narrows by the action the caller asked for.
	entries?: unknown;
	hasMore?: boolean;
	offset?: number;
	limit?: number;
	count?: number;
}

/** Analyze one target with a headless IDA run and report the selected view. */
export function createAnalyzeWithIdaTool(cwd: string, ops: Operations, options: AnalyzeWithIdaOptions = {}): AnyTool {
	return buildTool({
		name: "AnalyzeWithIda",
		description:
			"Analyzes an executable with IDA Pro in headless batch mode and reads the result: metadata, function and " +
			"string inventories, segments, exports, one function's disassembly, Hex-Rays pseudocode, cross-references, " +
			"or raw bytes. The target is copied into a private workspace and analyzed there; the original is never " +
			"opened, saved or executed. Requires an IDA Pro installation (set LBB_IDA_PATH when it is not found); " +
			"decompile requires a Hex-Rays license. Analysis is a long-running external process, so the call may take " +
			"minutes on a large binary.",
		inputSchema,
		// Starting a heavyweight third-party engine is not a read: it writes a
		// private database and runs for minutes. It is deliberately not offered in
		// plan mode.
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
				source = guardPathContainment(input.path, cwd, "AnalyzeWithIda");
				if (isIdaDatabase(source)) {
					return errorResult(
						"AnalyzeWithIda analyzes programs, not IDA databases: pass the executable, not an .i64/.idb file.",
					);
				}
				await assertTargetFile(source, input.path);
			} catch (error) {
				return errorResult(message(error));
			}
			if (ctx.sandbox === "read-only") {
				return errorResult(
					"AnalyzeWithIda needs a writable private workspace for IDA's database; the session sandbox is read-only.",
				);
			}

			const installed =
				options.enginePath !== undefined
					? { program: options.enginePath }
					: discoverEngine("ida", defaultProbe(options.env));
			if (installed === undefined) return errorResult(missingEngineText("ida"));

			const workspace = await createEngineWorkspace("ida", options.tempDir);
			try {
				const target = await copyTarget(source, workspace);
				await writeRequest(join(workspace.root, REQUEST_FILE), requestFor(input));
				await ops.writeTextFile(join(workspace.root, BRIDGE_FILE), IDA_BRIDGE);

				const program = assertCommandSafe(installed.program, "IDA");
				const command = [
					quoteToken(program),
					"-A",
					`-L${LOG_FILE}`,
					// The script name is ours and contains no spaces; with no separate
					// argument the shell never has to decide how to split it.
					`-S${BRIDGE_FILE}`,
					quoteToken(target.name),
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

				const logText = await readOptional(join(workspace.root, LOG_FILE));
				const parsed = await readResult<IdaResult>(join(workspace.root, RESULT_FILE));
				if ("error" in parsed) {
					return errorResult(engineFailureText("IDA", run, logText || run.stderr));
				}
				if (parsed.result.error !== undefined) {
					return errorResult(`IDA could not complete ${input.action}: ${parsed.result.error}`);
				}
				if (run.exitCode !== 0 && run.exitCode !== null) {
					// A result file is authoritative even when IDA's exit status is odd
					// (a qexit path can leave a non-zero code behind), but the status
					// is still worth showing rather than swallowing.
					const report = render(input, parsed.result);
					return { content: [{ type: "text", text: `${report}\n\n(IDA exited with code ${run.exitCode}.)` }] };
				}
				return { content: [{ type: "text", text: cap(render(input, parsed.result)) }] };
			} catch (error) {
				return errorResult(message(error));
			} finally {
				const cleaned = await workspace.cleanup();
				if (!cleaned) {
					// Leftovers are possible on Windows while IDA still holds a handle;
					// naming the path is more useful than pretending the run was clean.
					console.error(`AnalyzeWithIda: could not remove ${workspace.root}`);
				}
			}
		},
	});
}

function requestFor(input: IdaInput): Record<string, unknown> {
	return {
		action: input.action,
		address: input.address,
		name: input.name,
		limit: input.limit ?? 200,
		offset: input.offset ?? 0,
		length: input.length ?? 64,
	};
}

async function readOptional(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

function render(input: IdaInput, result: IdaResult): string {
	switch (input.action) {
		case "metadata": {
			const lines = [
				`IDA analysis of ${result.file ?? input.path}`,
				`  image base: ${result.imageBase ?? "unknown"}`,
				`  address range: ${result.minAddress ?? "?"}..${result.maxAddress ?? "?"}`,
				`  processor: ${result.processor ?? "unknown"}${result.is64Bit ? " (64-bit)" : ""}`,
				`  IDA version: ${result.idaVersion ?? "unknown"}`,
				`  functions: ${result.functionCount ?? "unknown"}`,
			];
			return [...lines, ...renderSegments(result.segments)].join("\n");
		}
		case "segments":
			return [`IDA segments of ${input.path}`, ...renderSegments(result.segments)].join("\n");
		case "functions": {
			const rows = (result.entries ?? []) as IdaFunctionRow[];
			const lines = [`IDA functions in ${input.path} (offset ${result.offset ?? 0})`];
			for (const row of rows) {
				const size = row.size === undefined ? "" : `  (${row.size} bytes)`;
				lines.push(`  ${row.address}  ${row.name}${size}`);
			}
			if (rows.length === 0) lines.push("  (none)");
			if (result.hasMore) lines.push(nextPageHint(result));
			return lines.join("\n");
		}
		case "strings": {
			const rows = (result.entries ?? []) as IdaStringRow[];
			const lines = [`IDA strings in ${input.path} (offset ${result.offset ?? 0})`];
			for (const row of rows) lines.push(`  ${row.address}  ${quote(row.value)}`);
			if (rows.length === 0) lines.push("  (none)");
			if (result.hasMore) lines.push(nextPageHint(result));
			return lines.join("\n");
		}
		case "exports": {
			const rows = (result.entries ?? []) as IdaExportRow[];
			const lines = [`IDA exports of ${input.path}`];
			for (const row of rows) {
				const ordinal = row.ordinal === undefined ? "" : ` [#${row.ordinal}]`;
				lines.push(`  ${row.address}  ${row.name || "(unnamed)"}${ordinal}`);
			}
			if (rows.length === 0) lines.push("  (none)");
			if (result.hasMore) lines.push(nextPageHint(result));
			return lines.join("\n");
		}
		case "function": {
			const lines = [
				`IDA function ${result.name ?? "(unnamed)"} at ${result.address ?? "?"}`,
				`  range: ${result.start ?? "?"}..${result.end ?? "?"}${result.size === undefined ? "" : ` (${result.size} bytes)`}`,
			];
			for (const instruction of result.instructions ?? []) {
				lines.push(`  ${instruction.address}  ${instruction.text}`);
			}
			if (result.truncated) lines.push(`  ... more instructions not shown; raise limit.`);
			return lines.join("\n");
		}
		case "decompile":
			return [
				`IDA Hex-Rays pseudocode for ${result.name ?? input.name ?? input.address ?? "?"} at ${result.address ?? "?"}`,
				"",
				result.pseudocode ?? "(no pseudocode)",
			].join("\n");
		case "xrefs": {
			const rows = (result.entries ?? []) as Array<{ from: string; to: string; type?: string; isCode?: boolean }>;
			const lines = [`IDA cross-references to ${result.address ?? input.address ?? input.name ?? "?"}`];
			for (const row of rows) {
				lines.push(
					`  ${row.from} -> ${row.to}${row.type === undefined ? "" : `  ${row.type}`}${row.isCode ? " (code)" : ""}`,
				);
			}
			if (rows.length === 0) lines.push("  (none)");
			if (result.hasMore) lines.push("  ... more references not shown; raise limit.");
			return lines.join("\n");
		}
		case "bytes":
			return [
				`IDA bytes at ${result.address ?? input.address ?? "?"} (${result.length ?? 0} bytes)`,
				`  ${result.hex ?? ""}`,
			].join("\n");
		default:
			return `IDA returned an unexpected action result for ${String(input.action)}.`;
	}
}

function renderSegments(segments: IdaSegmentRow[] | undefined): string[] {
	if (segments === undefined || segments.length === 0) return ["  segments: (none)"];
	const lines = [`  segments (${segments.length}):`];
	for (const segment of segments.slice(0, 40)) {
		const size = segment.size === undefined ? "" : `  ${segment.size} bytes`;
		const permissions = segment.permissions === undefined ? "" : `  ${segment.permissions}`;
		lines.push(`    ${segment.start}..${segment.end}  ${segment.name}${size}${permissions}`);
	}
	if (segments.length > 40) lines.push(`    ... ${segments.length - 40} more segments`);
	return lines;
}

function nextPageHint(result: { entries?: unknown; offset?: number }): string {
	const shown = Array.isArray(result.entries) ? result.entries.length : 0;
	const offset = result.offset ?? 0;
	return `  ... listing continues; next call: offset=${offset + shown}.`;
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

/**
 * The IDAPython bridge.
 *
 * It reads `req.json`, calls `auto_wait()` so batch mode cannot answer from a
 * half-analyzed database, writes `out.json`, and leaves through `qexit(0)`.
 * The database is never saved: `qexit` without `save_database` is the only
 * exit path, and the workspace is deleted afterwards anyway.
 *
 * Kept as source text rather than a package asset so a compiled binary and a
 * source checkout ship exactly the same script.
 */
const IDA_BRIDGE = `
# Labunbun IDA Pro headless bridge. Original work; no REA source is included.
import json
import os
import traceback

REQUEST = "req.json"
RESULT = "out.json"


def hexea(ea):
    return "0x%x" % int(ea)


def write_result(value):
    temporary = RESULT + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False)
    os.replace(temporary, RESULT)


def segments():
    import ida_segment
    rows = []
    for index in range(ida_segment.get_segm_qty()):
        segment = ida_segment.getnseg(index)
        if segment is None:
            continue
        permissions = ""
        try:
            permissions = ida_segment.get_segm_class(segment) or ""
        except Exception:
            permissions = ""
        rows.append({
            "name": ida_segment.get_segm_name(segment) or "",
            "start": hexea(segment.start_ea),
            "end": hexea(segment.end_ea),
            "size": int(segment.end_ea - segment.start_ea),
            "class": permissions,
            "permissions": segment_perm(segment),
        })
    return rows


def segment_perm(segment):
    try:
        perm = int(segment.perm)
    except Exception:
        return ""
    # Same order as the Ghidra tool's blocks: r, w, x.
    flags = []
    if perm & 4:
        flags.append("r")
    if perm & 2:
        flags.append("w")
    if perm & 1:
        flags.append("x")
    return "".join(flags)


def resolve(req):
    import ida_name
    import idautils
    address = req.get("address")
    if address:
        return int(str(address), 16)
    name = req.get("name")
    if name:
        import idaapi
        ea = ida_name.get_name_ea(idaapi.BADADDR, name)
        if ea != idaapi.BADADDR:
            return ea
        for candidate_ea, candidate_name in idautils.Names():
            if candidate_name == name:
                return candidate_ea
    raise ValueError("an address (0x...) or a symbol name is required")


def function_name(ea):
    import ida_funcs
    import ida_name
    try:
        return ida_funcs.get_func_name(ea) or ida_name.get_name(ea) or ""
    except Exception:
        return ""


def disassemble(ea):
    import ida_lines
    try:
        import idc
        return ida_lines.tag_remove(idc.GetDisasm(ea) or "")
    except Exception:
        try:
            import idc
            return ida_lines.tag_remove(idc.generate_disasm_line(ea, 0) or "")
        except Exception:
            return ""


def listing(req):
    limit = max(1, int(req.get("limit", 200)))
    offset = max(0, int(req.get("offset", 0)))
    rows = []
    scanned = 0
    has_more = False
    iterator = req["_rows"]()
    for row in iterator:
        if scanned < offset:
            scanned += 1
            continue
        if len(rows) >= limit:
            has_more = True
            break
        rows.append(row)
        scanned += 1
    return {
        "offset": offset,
        "limit": limit,
        "count": len(rows),
        "hasMore": has_more,
        "entries": rows,
    }


def function_rows():
    import ida_funcs
    import idautils
    for ea in idautils.Functions():
        function = ida_funcs.get_func(ea)
        size = int(function.end_ea - function.start_ea) if function is not None else 0
        yield {"address": hexea(ea), "name": function_name(ea), "size": size}


def string_rows():
    import idautils
    for item in idautils.Strings():
        yield {
            "address": hexea(item.ea),
            "value": str(item),
            "length": int(item.length),
            "type": int(item.strtype) if hasattr(item, "strtype") else None,
        }


def export_rows():
    import ida_entry
    rows = []
    for index in range(ida_entry.get_entry_qty()):
        ordinal = ida_entry.get_entry_ordinal(index)
        ea = ida_entry.get_entry(ordinal)
        if ea is None:
            continue
        try:
            name = ida_entry.get_entry_name(ordinal) or ""
        except Exception:
            name = ""
        rows.append({"address": hexea(ea), "name": name, "ordinal": int(ordinal)})
    return rows


def metadata():
    import ida_ida
    import ida_kernwin
    import ida_nalt
    import idautils
    count = 0
    for _ in idautils.Functions():
        count += 1
    return {
        "engine": "ida",
        "file": ida_nalt.get_root_filename() or "",
        "path": ida_nalt.get_input_file_path() or "",
        "imageBase": hexea(ida_nalt.get_imagebase()),
        "minAddress": hexea(ida_ida.inf_get_min_ea()),
        "maxAddress": hexea(ida_ida.inf_get_max_ea()),
        "processor": ida_ida.inf_get_procname() or "",
        "is64Bit": bool(ida_ida.inf_is_64bit()),
        "idaVersion": ida_kernwin.get_kernel_version() or "",
        "functionCount": count,
        "segments": segments(),
    }


def one_function(req):
    import ida_funcs
    import idautils
    ea = resolve(req)
    function = ida_funcs.get_func(ea)
    if function is None:
        raise ValueError("no function contains address %s" % hexea(ea))
    limit = max(1, int(req.get("limit", 200)))
    instructions = []
    truncated = False
    for item_ea in idautils.FuncItems(function.start_ea):
        if len(instructions) >= limit:
            # The limit was reached before this item was taken, so something was
            # left out. Equal lengths alone do not mean that: a function with
            # exactly limit instructions ends with the iterator, not this branch.
            truncated = True
            break
        instructions.append({"address": hexea(item_ea), "text": disassemble(item_ea)})
    return {
        "address": hexea(function.start_ea),
        "name": function_name(function.start_ea),
        "start": hexea(function.start_ea),
        "end": hexea(function.end_ea),
        "size": int(function.end_ea - function.start_ea),
        "instructions": instructions,
        "truncated": truncated,
    }


def decompile(req):
    import ida_funcs
    import ida_hexrays
    ea = resolve(req)
    function = ida_funcs.get_func(ea)
    if function is None:
        raise ValueError("no function contains address %s" % hexea(ea))
    if not ida_hexrays.init_hexrays_plugin():
        return {"error": "the Hex-Rays decompiler is not available in this IDA installation or license"}
    cfunction = ida_hexrays.decompile(function.start_ea)
    if cfunction is None:
        return {"error": "Hex-Rays produced no pseudocode for %s" % hexea(function.start_ea)}
    return {
        "address": hexea(function.start_ea),
        "name": function_name(function.start_ea),
        "pseudocode": str(cfunction),
    }


def xrefs(req):
    import idautils
    ea = resolve(req)
    limit = max(1, int(req.get("limit", 200)))
    rows = []
    has_more = False
    for reference in idautils.XrefsTo(ea, 0):
        if len(rows) >= limit:
            has_more = True
            break
        rows.append({
            "from": hexea(reference.frm),
            "to": hexea(reference.to),
            "type": xref_type(reference.type),
            "isCode": bool(reference.iscode),
        })
    return {"address": hexea(ea), "entries": rows, "hasMore": has_more}


def xref_type(value):
    try:
        import ida_xref
        return ida_xref.XrefTypeName(value)
    except Exception:
        return str(value)


def read_bytes(req):
    import ida_bytes
    ea = resolve(req)
    length = min(max(1, int(req.get("length", 64))), 4096)
    data = ida_bytes.get_bytes(ea, length)
    if data is None:
        return {"error": "no bytes at %s" % hexea(ea)}
    return {"address": hexea(ea), "length": len(data), "hex": data.hex()}


def run(req):
    import ida_auto
    ida_auto.auto_wait()
    action = str(req.get("action", "metadata"))
    if action == "metadata":
        return metadata()
    if action == "segments":
        return {"segments": segments()}
    if action == "functions":
        req["_rows"] = function_rows
        return listing(req)
    if action == "strings":
        req["_rows"] = string_rows
        return listing(req)
    if action == "exports":
        req["_rows"] = export_rows
        return listing(req)
    if action == "function":
        return one_function(req)
    if action == "decompile":
        return decompile(req)
    if action == "xrefs":
        return xrefs(req)
    if action == "bytes":
        return read_bytes(req)
    raise ValueError("unknown action: %s" % action)


def main():
    try:
        with open(REQUEST, "r", encoding="utf-8") as handle:
            req = json.load(handle)
        result = run(req)
    except Exception as exc:
        result = {"error": str(exc), "trace": traceback.format_exc()[-4000:]}
    try:
        write_result(result)
    except Exception:
        pass
    try:
        import ida_pro
        ida_pro.qexit(0)
    except Exception:
        pass


main()
`;
