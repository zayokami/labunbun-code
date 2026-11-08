/**
 * Shared plumbing for the native reverse-engineering engine tools.
 *
 * The engine family is deliberately separate from the `Inspect*` readers: those
 * parse the target as bytes and promise never to start a process. These tools
 * start third-party engines (IDA, Ghidra, Frida, x64dbg), so every one of them
 * runs through `Operations.exec` — the same sandbox seam as Bash — and every
 * one is declared non-read-only unless its whole job is a filesystem probe.
 *
 * The static engines never touch the user's file. The target is copied into a
 * private temporary workspace, the copy's SHA-256 is checked against the
 * source, and the engine is pointed at the copy. Nothing here executes the
 * target; the two dynamic tools say so in their own descriptions.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ExecResult, Operations } from "../operations.ts";

/** One place an engine can be installed. `source` is what the report tells the user. */
export type EngineSource = "environment" | "path" | "known-location";

export interface EngineInstall {
	id: EngineId;
	/** The program the analysis tools run. */
	program: string;
	/** What was set or where the program was found. */
	source: EngineSource;
	/** Install root, when the engine is directory-based (Ghidra, x64dbg). */
	home?: string;
	/** A version read from an install file, when one is cheap to read. */
	version?: string;
	/** Extra discovered paths, engine-specific. */
	details?: Record<string, string>;
}

export type EngineId = "ida" | "ghidra" | "frida" | "x64dbg";

export const ENGINE_LABELS: Record<EngineId, string> = {
	ida: "IDA Pro",
	ghidra: "Ghidra",
	frida: "Frida",
	x64dbg: "x64dbg",
};

/** How an engine is found is a testable question because the filesystem probes are injected. */
export interface Probe {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	isFile: (path: string) => boolean;
	isDirectory: (path: string) => boolean;
	readDir: (path: string) => string[];
	readText: (path: string) => string;
}

export function defaultProbe(env: NodeJS.ProcessEnv = process.env): Probe {
	return {
		platform: process.platform,
		env,
		isFile: (path) => {
			try {
				return statSync(path).isFile();
			} catch {
				return false;
			}
		},
		isDirectory: (path) => {
			try {
				return statSync(path).isDirectory();
			} catch {
				return false;
			}
		},
		readDir: (path) => {
			try {
				return readdirSync(path);
			} catch {
				return [];
			}
		},
		readText: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return "";
			}
		},
	};
}

/** PATH entries that can hold an executable, in order. Empty entries match nothing. */
function pathDirectories(probe: Probe): string[] {
	const value = probe.env.PATH ?? probe.env.Path ?? "";
	const separator = probe.platform === "win32" ? ";" : ":";
	return value
		.split(separator)
		.map((entry) =>
			entry
				.trim()
				.replace(/^"|"$/g, "")
				.replace(/[\\/]+$/, ""),
		)
		.filter((entry) => entry !== "");
}

/** The first existing file among `names` on PATH. */
function onPath(probe: Probe, names: readonly string[]): string | undefined {
	for (const directory of pathDirectories(probe)) {
		for (const name of names) {
			const candidate = probe.platform === "win32" ? join(directory, name) : `${directory}/${name}`;
			if (probe.isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

/** `dir/name` in the platform's spelling. */
function child(probe: Probe, dir: string, name: string): string {
	return probe.platform === "win32" ? join(dir, name) : `${dir.replace(/\/+$/, "")}/${name}`;
}

/** A directory named by the environment, expanded for `~` and returned only when it exists. */
function envDirectory(probe: Probe, value: string | undefined): string | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const expanded =
		value.startsWith("~") && (value[1] === "/" || value[1] === "\\" || value.length === 1)
			? join(probe.env.USERPROFILE ?? probe.env.HOME ?? homedir(), value.slice(1))
			: value;
	return probe.isDirectory(expanded) ? expanded : undefined;
}

/** Directory listings that match a prefix, sorted, so a versioned install is found deterministically. */
function matchingChildren(probe: Probe, parent: string | undefined, prefix: string): string[] {
	if (parent === undefined || !probe.isDirectory(parent)) return [];
	return probe
		.readDir(parent)
		.filter((name) => name.toLowerCase().startsWith(prefix))
		.sort()
		.reverse()
		.map((name) => child(probe, parent, name))
		.filter((path) => probe.isDirectory(path));
}

/** The user profile's own spelling, for the well-known install locations. */
function homeOf(probe: Probe): string {
	return probe.env.USERPROFILE ?? probe.env.HOME ?? homedir();
}

const IDA_NAMES = ["idat64.exe", "idat.exe", "ida64.exe", "ida.exe"] as const;
const IDA_NAMES_POSIX = ["idat64", "idat", "ida64", "ida"] as const;

/** The text-mode IDA driver in a directory, preferring 64-bit. */
function idaInDirectory(probe: Probe, directory: string): string | undefined {
	for (const name of probe.platform === "win32" ? IDA_NAMES : IDA_NAMES_POSIX) {
		const candidate = child(probe, directory, name);
		if (probe.isFile(candidate)) return candidate;
	}
	return undefined;
}

function discoverIda(probe: Probe): EngineInstall | undefined {
	const configured = probe.env.LBB_IDA_PATH ?? probe.env.IDA_PATH;
	if (configured !== undefined && configured.trim() !== "") {
		const direct = envDirectory(probe, configured);
		const program = direct === undefined ? configured : idaInDirectory(probe, direct);
		if (program !== undefined && probe.isFile(program)) return { id: "ida", program, source: "environment" };
	}
	const fromPath = onPath(probe, probe.platform === "win32" ? IDA_NAMES : IDA_NAMES_POSIX);
	if (fromPath !== undefined) return { id: "ida", program: fromPath, source: "path" };

	const roots: string[] = [];
	if (probe.platform === "win32") {
		for (const key of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
			const root = envDirectory(probe, probe.env[key]);
			if (root === undefined) continue;
			roots.push(...matchingChildren(probe, root, "ida"), ...matchingChildren(probe, root, "ida pro"));
			if (key === "LOCALAPPDATA") roots.push(...matchingChildren(probe, child(probe, root, "Programs"), "ida"));
		}
	} else {
		for (const parent of ["/opt", "/usr/local", join(homeOf(probe), "ida"), join(homeOf(probe), "tools")]) {
			roots.push(...matchingChildren(probe, parent, "ida"));
		}
	}
	for (const root of roots) {
		const program = idaInDirectory(probe, root);
		if (program !== undefined) return { id: "ida", program, source: "known-location", home: root };
	}
	return undefined;
}

function ghidraHeadlessIn(probe: Probe, home: string): string | undefined {
	const support = child(probe, home, "support");
	for (const name of probe.platform === "win32" ? ["analyzeHeadless.bat", "analyzeHeadless"] : ["analyzeHeadless"]) {
		const candidate = child(probe, support, name);
		if (probe.isFile(candidate)) return candidate;
	}
	return undefined;
}

function ghidraVersion(probe: Probe, home: string): string | undefined {
	const properties = probe.readText(child(probe, child(probe, home, "Ghidra"), "application.properties"));
	const match = properties.match(/^application\.version\s*=\s*(\S+)/m);
	return match?.[1];
}

function discoverGhidra(probe: Probe): EngineInstall | undefined {
	const configured = probe.env.LBB_GHIDRA_HOME ?? probe.env.GHIDRA_HOME ?? probe.env.GHIDRA_INSTALL_DIR;
	if (configured !== undefined && configured.trim() !== "") {
		const directory = envDirectory(probe, configured);
		if (directory !== undefined) {
			const program = ghidraHeadlessIn(probe, directory);
			if (program !== undefined) {
				return {
					id: "ghidra",
					program,
					source: "environment",
					home: directory,
					version: ghidraVersion(probe, directory),
				};
			}
		}
		if (probe.isFile(configured)) return { id: "ghidra", program: configured, source: "environment" };
	}
	const fromPath = onPath(
		probe,
		probe.platform === "win32" ? ["analyzeHeadless.bat", "analyzeHeadless"] : ["analyzeHeadless"],
	);
	if (fromPath !== undefined) return { id: "ghidra", program: fromPath, source: "path" };

	const roots: string[] = [];
	if (probe.platform === "win32") {
		for (const key of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
			const root = envDirectory(probe, probe.env[key]);
			if (root === undefined) continue;
			roots.push(...matchingChildren(probe, root, "ghidra"));
			if (key === "LOCALAPPDATA") roots.push(...matchingChildren(probe, child(probe, root, "Programs"), "ghidra"));
		}
	} else {
		for (const parent of ["/opt", "/usr/local", join(homeOf(probe), "tools"), homeOf(probe)]) {
			roots.push(...matchingChildren(probe, parent, "ghidra"));
		}
	}
	for (const root of roots) {
		const program = ghidraHeadlessIn(probe, root);
		if (program !== undefined) {
			return { id: "ghidra", program, source: "known-location", home: root, version: ghidraVersion(probe, root) };
		}
	}
	return undefined;
}

const FRIDA_NAMES = ["frida.exe", "frida"] as const;

function discoverFrida(probe: Probe): EngineInstall | undefined {
	const configured = probe.env.LBB_FRIDA_PATH;
	if (configured !== undefined && configured.trim() !== "") {
		const directory = envDirectory(probe, configured);
		const program =
			directory === undefined
				? configured
				: (probe.platform === "win32" ? ["frida.exe", "frida"] : ["frida"])
						.map((name) => child(probe, directory, name))
						.find((candidate) => probe.isFile(candidate));
		if (program !== undefined && probe.isFile(program)) return { id: "frida", program, source: "environment" };
	}
	const fromPath = onPath(probe, FRIDA_NAMES);
	if (fromPath !== undefined) return { id: "frida", program: fromPath, source: "path" };

	// pip installs the console script under a Python version directory that is
	// only on PATH for the shell that installed it, so the user's own profile is
	// searched the same way the Python launcher would find it.
	const scripts: string[] = [];
	if (probe.platform === "win32") {
		for (const parent of [probe.env.APPDATA, probe.env.LOCALAPPDATA]) {
			const root = envDirectory(probe, parent);
			if (root === undefined) continue;
			const roaming = child(probe, root, "Python");
			const programs = child(probe, child(probe, root, "Programs"), "Python");
			for (const base of [roaming, programs]) {
				for (const version of probe.readDir(base).filter((name) => /^Python\d+$/i.test(name))) {
					scripts.push(child(probe, child(probe, base, version), "Scripts"));
				}
			}
			const direct = child(probe, root, "Scripts");
			scripts.push(direct);
		}
	} else {
		for (const base of [
			join(homeOf(probe), ".local", "bin"),
			"/usr/local/bin",
			"/usr/bin",
			join(homeOf(probe), ".local", "pipx", "venvs"),
		]) {
			scripts.push(base);
		}
	}
	for (const directory of scripts) {
		for (const name of FRIDA_NAMES) {
			const candidate = child(probe, directory, name);
			if (probe.isFile(candidate))
				return { id: "frida", program: candidate, source: "known-location", home: directory };
		}
	}
	return undefined;
}

function headlessIn(probe: Probe, directory: string): string | undefined {
	const candidate = child(probe, directory, probe.platform === "win32" ? "headless.exe" : "headless");
	return probe.isFile(candidate) ? candidate : undefined;
}

function discoverX64dbg(probe: Probe): EngineInstall | undefined {
	// x64dbg is Windows-only. A POSIX host gets no install rather than a
	// guessed path that could name a different program.
	if (probe.platform !== "win32") return undefined;
	const details: Record<string, string> = {};
	const finish = (dir: string, source: EngineSource, program: string): EngineInstall => {
		const x64 = headlessIn(probe, child(probe, child(probe, dir, "release"), "x64"));
		const x32 = headlessIn(probe, child(probe, child(probe, dir, "release"), "x32"));
		if (x64 !== undefined) details.headlessX64 = x64;
		if (x32 !== undefined) details.headlessX32 = x32;
		return { id: "x64dbg", program, source, home: dir, details };
	};

	const configured = probe.env.LBB_X64DBG_PATH;
	if (configured !== undefined && configured.trim() !== "") {
		const directory = envDirectory(probe, configured);
		if (directory !== undefined) {
			for (const name of ["x64dbg.exe", "x32dbg.exe", "headless.exe"]) {
				const program = child(probe, directory, name);
				if (probe.isFile(program)) return finish(directory, "environment", program);
			}
			const x64dbg = child(probe, child(probe, child(probe, directory, "release"), "x64"), "x64dbg.exe");
			if (probe.isFile(x64dbg)) return finish(directory, "environment", x64dbg);
		} else if (probe.isFile(configured)) {
			const dir = configured.replace(/[\\/][^\\/]+$/, "");
			const install = finish(dir, "environment", configured);
			// A user may point at headless.exe itself rather than the install root;
			// its own architecture folder is then the one build we know.
			if (configured.replace(/^.*[\\/]/, "").toLowerCase() === "headless.exe") {
				const arch = dir
					.replace(/[\\/]+$/, "")
					.split(/[\\/]/)
					.pop()
					?.toLowerCase();
				if (arch === "x64") install.details = { ...install.details, headlessX64: configured };
				else if (arch === "x32") install.details = { ...install.details, headlessX32: configured };
			}
			return install;
		}
	}
	const fromPath = onPath(probe, ["x64dbg.exe", "x32dbg.exe"]);
	if (fromPath !== undefined) {
		const dir = fromPath.replace(/[\\/][^\\/]+$/, "");
		return finish(dir, "path", fromPath);
	}

	const roots: string[] = [];
	for (const key of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
		const root = envDirectory(probe, probe.env[key]);
		if (root === undefined) continue;
		roots.push(child(probe, root, "x64dbg"), ...matchingChildren(probe, root, "x64dbg"));
	}
	if (probe.env.SystemDrive !== undefined) roots.push(child(probe, `${probe.env.SystemDrive}\\`, "x64dbg"));
	for (const root of roots) {
		for (const name of ["x64dbg.exe", "x32dbg.exe"]) {
			const program = child(probe, root, name);
			if (probe.isFile(program)) return finish(root, "known-location", program);
		}
	}
	return undefined;
}

/** Every engine this machine can find, in a stable order. */
export function discoverEngines(probe: Probe = defaultProbe()): EngineInstall[] {
	const found: EngineInstall[] = [];
	for (const discover of [discoverIda, discoverGhidra, discoverFrida, discoverX64dbg]) {
		const install = discover(probe);
		if (install !== undefined) found.push(install);
	}
	return found;
}

export function discoverEngine(id: EngineId, probe: Probe = defaultProbe()): EngineInstall | undefined {
	return discoverEngines(probe).find((engine) => engine.id === id);
}

/** The install guidance a missing-engine error carries, so the model can tell the user what to do. */
export function missingEngineText(id: EngineId): string {
	const label = ENGINE_LABELS[id];
	const variable = {
		ida: "LBB_IDA_PATH",
		ghidra: "LBB_GHIDRA_HOME",
		frida: "LBB_FRIDA_PATH",
		x64dbg: "LBB_X64DBG_PATH",
	}[id];
	return `${label} was not found on this machine. Install it, or set ${variable} to the executable (or install directory).`;
}

/**
 * A private workspace for one engine run, removed when the run settles.
 *
 * `cleanup` is best effort by design: an engine that still holds a file open
 * on Windows turns a successful analysis into a thrown exception otherwise,
 * and the leftover path is reported by the caller instead of being hidden.
 */
export interface EngineWorkspace {
	root: string;
	cleanup: () => Promise<boolean>;
}

export async function createEngineWorkspace(
	prefix: string,
	tempDirectory: string = tmpdir(),
): Promise<EngineWorkspace> {
	const root = await mkdtemp(join(tempDirectory, `lbb-${prefix}-`));
	return {
		root,
		cleanup: async () => {
			try {
				await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** A sample name that keeps the original extension: loaders and debuggers use it. */
export function engineTargetName(originalPath: string): string {
	const extension = extname(originalPath).toLowerCase();
	const safe = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : "";
	return `sample${safe}`;
}

/** Copy the target into the workspace and prove the copy is the same bytes. */
export async function copyTarget(
	source: string,
	workspace: EngineWorkspace,
): Promise<{ path: string; name: string; sha256: string }> {
	const name = engineTargetName(source);
	const path = join(workspace.root, name);
	await copyFile(source, path);
	const [sourceHash, copyHash] = await Promise.all([sha256File(source), sha256File(path)]);
	if (sourceHash !== copyHash) {
		throw new Error(`the private copy of ${basename(source)} does not match the source (SHA-256 differs)`);
	}
	return { path, name, sha256: sourceHash };
}

export async function sha256File(path: string): Promise<string> {
	const data = await readFile(path);
	return createHash("sha256").update(data).digest("hex");
}

/** Write a request file the bridge reads, with a trailing newline so a partial write is obvious. */
export async function writeRequest(path: string, request: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
}

/** Read a bridge's result file, or explain why there is nothing to read. */
export async function readResult<T>(path: string): Promise<{ result: T } | { error: string }> {
	try {
		const text = await readFile(path, "utf8");
		if (text.trim() === "") return { error: "the engine wrote an empty result file" };
		return { result: JSON.parse(text) as T };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { error: "the engine produced no result file" };
		if (error instanceof SyntaxError) return { error: `the engine's result was not valid JSON (${error.message})` };
		return { error: `the engine's result could not be read (${String(error)})` };
	}
}

/** The command token quoting every engine command uses; paths we build contain no quotes. */
export function quoteToken(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value;
	return `"${value.replace(/"/g, '\\"')}"`;
}

/** Refuse a path that cannot be handed to the shell safely. */
export function assertCommandSafe(path: string, role: string): string {
	if (/["\r\n]/.test(path)) {
		throw new Error(
			`${role} path contains a quote or newline and cannot be passed to the engine: ${JSON.stringify(path)}`,
		);
	}
	return path;
}

/** Output past this is not shown; the engine's own log keeps the rest. */
export const MAX_ENGINE_REPORT_CHARS = 24_000;

export function capEngineReport(report: string, cap = MAX_ENGINE_REPORT_CHARS): string {
	if (report.length <= cap) return report;
	return `${report.slice(0, cap)}\n... [output continued for ${report.length - cap} more characters]`;
}

/** The last `lines` lines of an engine's console output, for a failed run. */
export function tailLines(text: string, lines = 40): string {
	const all = text.trimEnd().split(/\r?\n/);
	return all.slice(-lines).join("\n");
}

export interface EngineRunOptions {
	ops: Operations;
	command: string;
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal;
	sandbox: Parameters<Operations["exec"]>[0]["sandbox"];
}

/** Run one engine invocation through the host's exec seam. */
export async function runEngineCommand(options: EngineRunOptions): Promise<ExecResult> {
	return options.ops.exec({
		command: options.command,
		cwd: options.cwd,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
		sandbox: options.sandbox,
	});
}

/** The sentence a failed engine run carries: exit status, then the engine's own last lines. */
export function engineFailureText(label: string, run: ExecResult, logText?: string): string {
	const status = run.killed
		? `${label} was stopped at its time limit`
		: run.exitCode === null
			? `${label} ended without an exit status`
			: `${label} exited with code ${run.exitCode}`;
	const detail = tailLines(logText ?? "", 30) || tailLines(run.stderr, 30) || tailLines(run.stdout, 30);
	return detail === "" ? status : `${status}.\n${detail}`;
}

/** Whether a path is one of IDA's own database forms, which are never admitted as analysis input. */
export function isIdaDatabase(path: string): boolean {
	return /\.(i64|idb|id0|id1|id2|nam|til)$/i.test(path);
}

/** Check a target path before it is copied: a regular, non-empty file. */
export async function assertTargetFile(source: string, displayPath: string): Promise<void> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(source);
	} catch (error) {
		throw new Error(`could not read ${displayPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!info.isFile()) throw new Error(`${displayPath} is not a regular file`);
	if (info.size === 0) throw new Error(`${displayPath} is empty`);
}
