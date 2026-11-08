/**
 * The native engine tools: discovery without a process, and one run of each
 * engine with the process seam faked.
 *
 * Nothing here launches IDA, Ghidra, Frida or x64dbg. The fake `exec` writes
 * the result file the real engine would have written into the workspace it was
 * given, which is enough to hold the tool to its own contract: the command it
 * builds, the private copy it analyzes, the rendering it produces, and the
 * cleanup it promises. Discovery is exercised through an injected `Probe`, so
 * it can describe a machine that does not exist.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAnalyzeWithGhidraTool,
	createAnalyzeWithIdaTool,
	createDebugWithX64dbgTool,
	createDetectReverseEnginesTool,
	createInstrumentWithFridaTool,
	createListFridaTargetsTool,
	defaultProbe,
	discoverEngine,
	type Probe,
} from "../src/engines/index.ts";
import type { Operations } from "../src/operations.ts";
import { defaultOperations } from "../src/operations.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function tempRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function ctx(cwd: string, sandbox: "read-only" | "workspace-write" | "danger-full-access" = "workspace-write") {
	return {
		callId: "engine-1",
		signal: new AbortController().signal,
		cwd,
		sandbox,
		network: { access: "enabled" as const, domains: [] },
		onUpdate: () => {},
	};
}

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

/** Real fs operations with only `exec` replaced. */
function opsWithExec(
	exec: (options: { command: string; cwd: string; [key: string]: unknown }) => Promise<{
		stdout: string;
		stderr: string;
		exitCode: number | null;
		killed: boolean;
	}>,
): Operations {
	const base = defaultOperations();
	return { ...base, exec: exec as unknown as Operations["exec"] };
}

/** A virtual machine for discovery: a file list, a text map and an environment. */
function virtualProbe(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	files: string[],
	texts: Record<string, string> = {},
): Probe {
	const separator = platform === "win32" ? "\\" : "/";
	const set = new Set(files);
	const dirs = new Set<string>();
	for (const file of files) {
		let index = file.lastIndexOf(separator);
		while (index > 0) {
			const dir = file.slice(0, index);
			dirs.add(dir);
			index = dir.lastIndexOf(separator);
		}
	}
	return {
		platform,
		env,
		isFile: (path) => set.has(path),
		isDirectory: (path) => dirs.has(path.replace(/[\\/]+$/, "")),
		readDir: (path) => {
			const prefix = `${path.replace(/[\\/]+$/, "")}${separator}`;
			return files
				.filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes(separator))
				.map((file) => file.slice(prefix.length));
		},
		readText: (path) => texts[path] ?? "",
	};
}

/** Paths for the host platform, so one fixture describes either CI machine. */
function hostNames(): { ida: string; ghidra: string; frida: string; fridaPs: string } {
	return process.platform === "win32"
		? { ida: "idat64.exe", ghidra: "analyzeHeadless.bat", frida: "frida.exe", fridaPs: "frida-ps.exe" }
		: { ida: "idat64", ghidra: "analyzeHeadless", frida: "frida", fridaPs: "frida-ps" };
}

describe("engine discovery", () => {
	test("IDA is found through LBB_IDA_PATH when the directory holds the text-mode driver", () => {
		const names = hostNames();
		const home = join(process.platform === "win32" ? "C:\\" : "/", "tools", "ida-9.0");
		const probe = virtualProbe(process.platform, { LBB_IDA_PATH: home }, [join(home, names.ida)]);
		const found = discoverEngine("ida", probe);
		expect(found?.program).toBe(join(home, names.ida));
		expect(found?.source).toBe("environment");
	});

	test("Ghidra is found from its home and its version is read from application.properties", () => {
		const names = hostNames();
		const home = join(process.platform === "win32" ? "C:\\" : "/", "tools", "ghidra_11.2.1_PUBLIC");
		const properties = join(home, "Ghidra", "application.properties");
		const probe = virtualProbe(
			process.platform,
			{ LBB_GHIDRA_HOME: home },
			[join(home, "support", names.ghidra), properties],
			{ [properties]: "application.name=Ghidra\napplication.version=11.2.1\n" },
		);
		const found = discoverEngine("ghidra", probe);
		expect(found?.program).toBe(join(home, "support", names.ghidra));
		expect(found?.version).toBe("11.2.1");
	});

	test("Frida is found on PATH and reports where it came from", () => {
		const names = hostNames();
		const bin = join(process.platform === "win32" ? "C:\\" : "/", "python", "Scripts");
		const separator = process.platform === "win32" ? ";" : ":";
		const probe = virtualProbe(process.platform, { PATH: [bin, "/other"].join(separator) }, [join(bin, names.frida)]);
		const found = discoverEngine("frida", probe);
		expect(found?.program).toBe(join(bin, names.frida));
		expect(found?.source).toBe("path");
	});

	test("x64dbg reports the x64 and x32 headless builds separately", () => {
		if (process.platform !== "win32") {
			expect(discoverEngine("x64dbg", virtualProbe("linux", {}, []))).toBeUndefined();
			return;
		}
		const home = "C:\\tools\\x64dbg";
		const gui = join(home, "x64dbg.exe");
		const x64 = join(home, "release", "x64", "headless.exe");
		const x32 = join(home, "release", "x32", "headless.exe");
		const found = discoverEngine("x64dbg", virtualProbe("win32", { LBB_X64DBG_PATH: home }, [gui, x64, x32]));
		expect(found?.program).toBe(gui);
		expect(found?.details?.headlessX64).toBe(x64);
		expect(found?.details?.headlessX32).toBe(x32);
	});
});

describe("DetectReverseEngines", () => {
	test("reports an install named by the environment and is read-only", async () => {
		const names = hostNames();
		const install = tempRoot("lbb-detect-");
		const program = join(install, names.ida);
		writeFileSync(program, "");
		const tool = createDetectReverseEnginesTool({ env: { ...process.env, LBB_IDA_PATH: install } });
		expect(tool.isReadOnly?.({})).toBe(true);
		const report = textOf(await tool.call({}, ctx(install)));
		expect(report).toContain(`IDA Pro: ${program}`);
		expect(report).toContain("named in the environment");
		expect(report).toContain("Detection does not start an engine");
		// Detection does not start anything: it must work in the read-only sandbox.
		const inReadOnly = await tool.call({}, ctx(install, "read-only"));
		expect(inReadOnly.isError).toBeUndefined();
	});
});

describe("AnalyzeWithIda", () => {
	test("analyzes a private copy, renders metadata, and removes the workspace", async () => {
		const cwd = tempRoot("lbb-ida-cwd-");
		const tempDir = tempRoot("lbb-ida-tmp-");
		const source = join(cwd, "sample.exe");
		const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
		writeFileSync(source, bytes);
		let command = "";
		let workspaceCwd = "";
		const ops = opsWithExec(async (options) => {
			command = options.command;
			workspaceCwd = options.cwd;
			expect(readdirSync(options.cwd)).toContain("sample.exe");
			expect(readFileSync(join(options.cwd, "sample.exe"))).toEqual(bytes);
			writeFileSync(
				join(options.cwd, "out.json"),
				JSON.stringify({
					file: "sample.exe",
					imageBase: "0x400000",
					minAddress: "0x400000",
					maxAddress: "0x402000",
					processor: "metapc",
					is64Bit: true,
					idaVersion: "9.0",
					functionCount: 2,
					segments: [{ name: ".text", start: "0x401000", end: "0x401fff", size: 4096, permissions: "r-x" }],
				}),
			);
			return { stdout: "", stderr: "", exitCode: 0, killed: false };
		});
		const tool = createAnalyzeWithIdaTool(cwd, ops, { enginePath: "C:\\fake\\idat64.exe", tempDir });
		const result = await tool.call({ path: "sample.exe", action: "metadata" }, ctx(cwd));
		const text = textOf(result);
		expect(result.isError).toBeUndefined();
		expect(text).toContain("IDA analysis of sample.exe");
		expect(text).toContain("0x400000");
		expect(text).toContain("functions: 2");
		expect(text).toContain(".text");
		expect(command).toContain("-A");
		expect(command).toContain("-Sbridge.py");
		expect(command).toContain("sample.exe");
		expect(workspaceCwd).not.toBe(cwd);
		expect(readFileSync(source)).toEqual(bytes);
		expect(readdirSync(tempDir)).toEqual([]);
	});

	test("refuses the read-only sandbox and IDA database inputs before starting anything", async () => {
		const cwd = tempRoot("lbb-ida-refuse-");
		writeFileSync(join(cwd, "sample.exe"), "MZ");
		writeFileSync(join(cwd, "sample.i64"), "database");
		let ran = false;
		const ops = opsWithExec(async () => {
			ran = true;
			return { stdout: "", stderr: "", exitCode: 0, killed: false };
		});
		const tool = createAnalyzeWithIdaTool(cwd, ops, { enginePath: "C:\\fake\\idat64.exe" });
		const readonly = await tool.call({ path: "sample.exe" }, ctx(cwd, "read-only"));
		expect(readonly.isError).toBe(true);
		expect(textOf(readonly)).toContain("read-only");
		const database = await tool.call({ path: "sample.i64" }, ctx(cwd));
		expect(database.isError).toBe(true);
		expect(textOf(database)).toContain("IDA databases");
		expect(ran).toBe(false);
	});
});

describe("AnalyzeWithGhidra", () => {
	test("runs analyzeHeadless over a private copy and renders the generated script", async () => {
		const cwd = tempRoot("lbb-ghidra-cwd-");
		const tempDir = tempRoot("lbb-ghidra-tmp-");
		writeFileSync(join(cwd, "sample.exe"), "MZ");
		let command = "";
		let bridge = "";
		const ops = opsWithExec(async (options) => {
			command = options.command;
			bridge = readFileSync(join(options.cwd, "LbbBridge.java"), "utf8");
			writeFileSync(
				join(options.cwd, "out.json"),
				JSON.stringify({
					offset: 0,
					limit: 200,
					count: 1,
					hasMore: false,
					entries: [{ address: "0x401000", name: "main", size: 12 }],
				}),
			);
			return { stdout: "", stderr: "", exitCode: 0, killed: false };
		});
		const tool = createAnalyzeWithGhidraTool(cwd, ops, {
			enginePath: "/opt/ghidra/support/analyzeHeadless",
			tempDir,
		});
		const result = await tool.call({ path: "sample.exe", action: "functions" }, ctx(cwd));
		const text = textOf(result);
		expect(result.isError).toBeUndefined();
		expect(text).toContain("Ghidra functions in sample.exe");
		expect(text).toContain("0x401000  main");
		expect(command).toContain("-import");
		expect(command).toContain("-postScript LbbBridge.java");
		expect(command).toContain("-deleteProject");
		expect(bridge).toContain('private static final String ACTION = "functions";');
		expect(bridge).toContain("private static final int LIMIT = 200;");
		expect(bridge).toContain("out.json");
		expect(readdirSync(tempDir)).toEqual([]);
	});

	test("keeps replacement syntax and placeholder words out of caller text", async () => {
		const cwd = tempRoot("lbb-ghidra-subst-");
		const tempDir = tempRoot("lbb-ghidra-subst-tmp-");
		writeFileSync(join(cwd, "sample.exe"), "MZ");
		let bridge = "";
		const ops = opsWithExec(async (options) => {
			bridge = readFileSync(join(options.cwd, "LbbBridge.java"), "utf8");
			writeFileSync(
				join(options.cwd, "out.json"),
				JSON.stringify({
					address: "0x401000",
					name: "x",
					start: "0x401000",
					end: "0x401010",
					size: 16,
					truncated: false,
					instructions: [],
				}),
			);
			return { stdout: "", stderr: "", exitCode: 0, killed: false };
		});
		const tool = createAnalyzeWithGhidraTool(cwd, ops, {
			enginePath: "/opt/ghidra/support/analyzeHeadless",
			tempDir,
		});
		// `$'` is replacement-string syntax and the other two are placeholder
		// spellings: neither may be interpreted by the generator.
		const result = await tool.call(
			{ path: "sample.exe", action: "function", name: "$' __LIMIT__ __RESULT__" },
			ctx(cwd),
		);
		expect(result.isError).toBeUndefined();
		expect(bridge).toContain(`private static final String NAME = "$' __LIMIT__ __RESULT__";`);
		expect(bridge).toContain("private static final int LIMIT = 200;");
		expect(bridge).toMatch(/private static final String RESULT = "[^"]*out\.json";/);
		expect(readdirSync(tempDir)).toEqual([]);
	});

	test("refuses function actions with neither an address nor a name", async () => {
		const tool = createAnalyzeWithGhidraTool(
			process.cwd(),
			opsWithExec(async () => {
				throw new Error("should not run");
			}),
		);
		expect(await tool.validateInput?.({ action: "decompile" } as never)).toContain("address");
	});
});

describe("Frida tools", () => {
	test("ListFridaTargets parses frida-ps JSON and filters it without attaching", async () => {
		const cwd = tempRoot("lbb-frida-list-");
		const names = hostNames();
		writeFileSync(join(cwd, names.frida), "");
		writeFileSync(join(cwd, names.fridaPs), "");
		let command = "";
		const ops = opsWithExec(async (options) => {
			command = options.command;
			return {
				stdout: JSON.stringify([
					{ pid: 10, name: "notepad.exe", identifier: "com.example.notepad" },
					{ pid: 20, name: "target.exe", identifier: "com.example.target" },
				]),
				stderr: "",
				exitCode: 0,
				killed: false,
			};
		});
		const tool = createListFridaTargetsTool(cwd, ops, { enginePath: join(cwd, names.frida) });
		const result = await tool.call({ filter: "target" }, ctx(cwd));
		const text = textOf(result);
		expect(result.isError).toBeUndefined();
		expect(command).toContain(names.fridaPs);
		expect(command).toContain("-j");
		expect(text).toContain("target.exe");
		expect(text).not.toContain("notepad.exe");
		expect(text).toContain('matching "target": 1');
	});

	test("InstrumentWithFrida writes the script privately and reports its output", async () => {
		const cwd = tempRoot("lbb-frida-run-");
		const tempDir = tempRoot("lbb-frida-tmp-");
		writeFileSync(join(cwd, "target.exe"), "MZ");
		let command = "";
		let script = "";
		const ops = opsWithExec(async (options) => {
			command = options.command;
			script = readFileSync(join(options.cwd, "script.js"), "utf8");
			return { stdout: "hooked send()\n", stderr: "", exitCode: 0, killed: false };
		});
		const tool = createInstrumentWithFridaTool(cwd, ops, { enginePath: "/usr/local/bin/frida", tempDir });
		const result = await tool.call(
			{ mode: "spawn", file: "target.exe", script: "console.log('hooked')", seconds: 5 },
			ctx(cwd),
		);
		const text = textOf(result);
		expect(result.isError).toBeUndefined();
		expect(script).toBe("console.log('hooked')");
		expect(command).toContain("-q -t 5 -l");
		expect(command).toContain("-f");
		expect(text).toContain("hooked send()");
		expect(readdirSync(tempDir)).toEqual([]);
	});

	test("InstrumentWithFrida refuses the read-only sandbox and two scripts", async () => {
		const cwd = tempRoot("lbb-frida-refuse-");
		writeFileSync(join(cwd, "target.exe"), "MZ");
		const tool = createInstrumentWithFridaTool(
			cwd,
			opsWithExec(async () => {
				throw new Error("should not run");
			}),
		);
		expect(
			await tool.validateInput?.({ mode: "spawn", file: "target.exe", script: "x", scriptPath: "y" } as never),
		).toContain("exactly one");
		const refused = await tool.call({ mode: "spawn", file: "target.exe", script: "x" }, ctx(cwd, "read-only"));
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("writable private workspace");
	});
});

describe("DebugWithX64dbg", () => {
	const windowsTest = test.skipIf(process.platform !== "win32");

	windowsTest("refuses anything below danger-full-access before reading the target", async () => {
		const cwd = tempRoot("lbb-x64-refuse-");
		writeFileSync(join(cwd, "sample.exe"), "MZ");
		let ran = false;
		const tool = createDebugWithX64dbgTool(
			cwd,
			opsWithExec(async () => {
				ran = true;
				return { stdout: "", stderr: "", exitCode: 0, killed: false };
			}),
		);
		const refused = await tool.call({ path: "sample.exe" }, ctx(cwd, "workspace-write"));
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("danger-full-access");
		expect(ran).toBe(false);
	});

	windowsTest("selects the x64 headless build from the PE machine and parses its log", async () => {
		const cwd = tempRoot("lbb-x64-cwd-");
		const tempDir = tempRoot("lbb-x64-tmp-");
		const install = tempRoot("lbb-x64-install-");
		mkdirSync(join(install, "release", "x64"), { recursive: true });
		writeFileSync(join(install, "x64dbg.exe"), "");
		writeFileSync(join(install, "release", "x64", "headless.exe"), "");

		const header = Buffer.alloc(0x200);
		header.write("MZ", 0, "ascii");
		header.writeUInt32LE(0x80, 0x3c);
		header.write("PE\0\0", 0x80, "ascii");
		header.writeUInt16LE(0x8664, 0x84);
		writeFileSync(join(cwd, "sample.exe"), header);

		let command = "";
		let script = "";
		let userDirExisted = false;
		const ops = opsWithExec(async (options) => {
			command = options.command;
			script = readFileSync(join(options.cwd, "snapshot.script"), "utf8");
			userDirExisted = existsSync(join(options.cwd, "userdir"));
			writeFileSync(
				join(options.cwd, "snapshot.log"),
				Buffer.concat([
					Buffer.from([0xff, 0xfe]),
					Buffer.from("LABUNBUN snapshot begin\nLABUNBUN base=0x140000000\nLABUNBUN status=ok\n", "utf16le"),
				]),
			);
			return { stdout: "", stderr: "", exitCode: 0, killed: false };
		});
		const tool = createDebugWithX64dbgTool(cwd, ops, { enginePath: install, tempDir });
		const result = await tool.call({ path: "sample.exe" }, ctx(cwd, "danger-full-access"));
		const text = textOf(result);
		expect(result.isError).toBeUndefined();
		expect(command).toContain(join(install, "release", "x64", "headless.exe"));
		expect(command).toContain("-testing");
		expect(command).toContain("-userdir");
		expect(command).toContain("-cf");
		expect(command).toContain("sample.exe");
		// The script's lexer keeps a backslash literal unless it precedes a quote
		// or a brace, so the log path must arrive with its separators uncrossed.
		const redirect = script.split("\n").find((line) => line.startsWith("RedirectLog ")) ?? "";
		expect(redirect).toContain("snapshot.log");
		expect(redirect).not.toContain("\\\\");
		// x64dbg refuses a -userdir that does not exist, and the tool passes one.
		expect(userDirExisted).toBe(true);
		expect(text).toContain("LABUNBUN status=ok");
		expect(text).toContain("base=0x140000000");
		expect(readdirSync(tempDir)).toEqual([]);
	});

	windowsTest("refuses a DLL before starting the debugger", async () => {
		const cwd = tempRoot("lbb-x64-dll-");
		const header = Buffer.alloc(0x200);
		header.write("MZ", 0, "ascii");
		header.writeUInt32LE(0x80, 0x3c);
		header.write("PE\0\0", 0x80, "ascii");
		header.writeUInt16LE(0x8664, 0x84);
		header.writeUInt16LE(0x2000, 0x96);
		writeFileSync(join(cwd, "library.dll"), header);

		let ran = false;
		const tool = createDebugWithX64dbgTool(
			cwd,
			opsWithExec(async () => {
				ran = true;
				return { stdout: "", stderr: "", exitCode: 0, killed: false };
			}),
		);
		const refused = await tool.call({ path: "library.dll" }, ctx(cwd, "danger-full-access"));
		expect(refused.isError).toBe(true);
		expect(textOf(refused)).toContain("is a DLL");
		expect(ran).toBe(false);
	});

	windowsTest("does not report a zero image base as a snapshot", async () => {
		const cwd = tempRoot("lbb-x64-zero-");
		const tempDir = tempRoot("lbb-x64-zero-tmp-");
		const install = tempRoot("lbb-x64-zero-install-");
		mkdirSync(join(install, "release", "x64"), { recursive: true });
		writeFileSync(join(install, "x64dbg.exe"), "");
		writeFileSync(join(install, "release", "x64", "headless.exe"), "");

		const header = Buffer.alloc(0x200);
		header.write("MZ", 0, "ascii");
		header.writeUInt32LE(0x80, 0x3c);
		header.write("PE\0\0", 0x80, "ascii");
		header.writeUInt16LE(0x8664, 0x84);
		writeFileSync(join(cwd, "sample.exe"), header);

		const ops = opsWithExec(async (options) => {
			writeFileSync(join(options.cwd, "snapshot.log"), "LABUNBUN base=0\nLABUNBUN status=ok\n");
			return { stdout: "", stderr: "", exitCode: 0, killed: false };
		});
		const tool = createDebugWithX64dbgTool(cwd, ops, { enginePath: install, tempDir });
		const result = await tool.call({ path: "sample.exe" }, ctx(cwd, "danger-full-access"));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("mod.main() is zero");
		expect(readdirSync(tempDir)).toEqual([]);
	});

	windowsTest("reports a non-PE target instead of starting the debugger", async () => {
		const cwd = tempRoot("lbb-x64-nope-");
		writeFileSync(join(cwd, "notes.txt"), "not a program");
		const tool = createDebugWithX64dbgTool(
			cwd,
			opsWithExec(async () => {
				throw new Error("should not run");
			}),
		);
		const result = await tool.call({ path: "notes.txt" }, ctx(cwd, "danger-full-access"));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("not a PE image");
	});
});

// The default probe is exported for the tools that let a caller inject one;
// holding it against the real machine would make this suite a property of the
// test host, so only its shape is asserted.
test("defaultProbe answers for this machine", () => {
	const probe = defaultProbe({ PATH: "" });
	expect(probe.platform).toBe(process.platform);
	expect(probe.isFile(join(tmpdir(), "definitely-not-here", "nope"))).toBe(false);
});
