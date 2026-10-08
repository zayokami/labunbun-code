/**
 * The Windows AppContainer backend for the filesystem sandbox.
 *
 * **Status, stated exactly.** The mechanism is measured on this machine and the
 * profile/spawn half is wired here; the ACL grant half (the part that lets the
 * confined process touch the workspace at all) is NOT wired yet — see
 * `simulated.ts`, whose header records what was measured and what remains.
 *
 * What is measured (2026-10-09, Windows 11 26200, no elevation, no helper
 * binary, no service), through this module's own FFI path:
 *
 *   - `CreateAppContainerProfile` / `DeriveAppContainerSidFromAppContainerName`
 *     / `DeleteAppContainerProfile` in `userenv.dll` all succeed for the
 *     current user. Derivation is deterministic: the same name yields the same
 *     SID every time, without creating anything.
 *   - A child created with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
 *     (0x00020009 — enum 9 in WinBase.h with the Input bit set; the value is
 *     NOT 0x2000B, which is a different attribute and fails with
 *     ERROR_BAD_LENGTH) runs and returns its exit code.
 *   - With one `(OI)(CI)(F)` allow ACE for the container SID on a workspace
 *     root, the confined child reads and writes that subtree; a write outside
 *     it is refused by the kernel with access-denied. Without the grant the
 *     child cannot even read the workspace, so the backend fails closed.
 *   - With a mutation deny ACE (write-data, append-data, write-EA,
 *     write-attributes, delete, delete-child) on a nested `.git`, the confined
 *     child cannot overwrite, delete, or rename anything under `.git` — but it
 *     CAN still create a new file there, so `.git` protection is not yet
 *     correct and the grant half must not ship until it is.
 *
 * Why AppContainer and not a job object: `JOBOBJECT_SECURITY_LIMIT_INFORMATION`
 * is documented as no longer supported in the SDK, so no `JOB_OBJECT_LIMIT_*`
 * takes a path. Job objects remain fine for process/memory ceilings and
 * useless as a filesystem boundary. A restricted token is also not it: no
 * token restricts writes to a path.
 *
 * Why bun:ffi and not a compiled helper: the repo ships no native binaries,
 * and `bun:ffi` calls these documented user-mode entry points directly. The
 * one thing FFI needs that is easy to get wrong is addresses, and the rule
 * here is the one every probe confirmed: **`ptr(typedArray)` returns that
 * buffer's numeric address**, a typed array marshals to its own address when
 * passed for a pointer argument, and `toArrayBuffer(numericAddress, 0, len)`
 * views C-allocated memory for reading.
 */
import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";

/** `S-1-15-2-…`, 40 bytes on x64 — the shape the kernel checks per file access. */
export interface AppContainerProfile {
	/** The profile name: deterministic from the workspace, stable across runs. */
	name: string;
	/** The derived package SID, in string form. */
	sid: string;
}

function wbuf(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2 + 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
	return out;
}

/** Read a NUL-terminated UTF-16 string out of C-allocated memory. */
/**
 * A window on C-allocated memory at a numeric address.
 *
 * The runtime accepts an address where the typings accept only buffers — the
 * probes measured it — so this one helper is where the two are bridged, and
 * the two readers below never mention it.
 */
function memoryAt(address: number, maxBytes: number): ArrayBuffer {
	return toArrayBuffer(address, 0, maxBytes);
}

function wideStringAt(addr: number, maxBytes = 2048): string {
	const bytes = new Uint8Array(memoryAt(addr, maxBytes));
	let out = "";
	for (let i = 0; i + 1 < bytes.length; i += 2) {
		const code = bytes[i] | (bytes[i + 1] << 8);
		if (code === 0) return out;
		out += String.fromCharCode(code);
	}
	return out;
}

/** The three DLLs, loaded lazily: a Windows-only module must not try to open a Windows DLL on a Mac. */
let userenvCache: ReturnType<typeof loadUserenvRaw> | undefined;
function userenv(): ReturnType<typeof loadUserenvRaw> | null {
	if (userenvCache === undefined) userenvCache = loadUserenvRaw();
	return userenvCache;
}

function loadUserenvRaw() {
	if (process.platform !== "win32") return null;
	try {
		return dlopen("userenv.dll", {
			// HRESULT CreateAppContainerProfile(PCWSTR name, PCWSTR displayName,
			//   PCWSTR description, PSID_AND_ATTRIBUTES capabilities, UINT32
			//   capabilityCount, PSID *sid)
			CreateAppContainerProfile: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
			// HRESULT DeriveAppContainerSidFromAppContainerName(PCWSTR, PSID*)
			DeriveAppContainerSidFromAppContainerName: {
				args: [FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
			// HRESULT DeleteAppContainerProfile(PCWSTR)
			DeleteAppContainerProfile: { args: [FFIType.ptr], returns: FFIType.i32 },
		});
	} catch {
		return null;
	}
}

// Each DLL loads into a lazily-filled cache; the loaders carry no explicit
// return type on purpose — inferring it from the dlopen call is what keeps the
// per-symbol argument types, and annotating it loses them to `never`.
let advapiCache: ReturnType<typeof loadAdvabiRaw> | undefined;
function advapi(): ReturnType<typeof loadAdvabiRaw> | null {
	if (advapiCache === undefined) advapiCache = loadAdvabiRaw();
	return advapiCache;
}

function loadAdvabiRaw() {
	try {
		return dlopen("advapi32.dll", {
			ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			GetLengthSid: { args: [FFIType.ptr], returns: FFIType.u32 },
		});
	} catch {
		return null;
	}
}

function loadKernel32Raw() {
	try {
		return dlopen("kernel32.dll", {
			InitializeProcThreadAttributeList: {
				args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr],
				returns: FFIType.i32,
			},
			UpdateProcThreadAttribute: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
			DeleteProcThreadAttributeList: { args: [FFIType.ptr], returns: FFIType.void },
			CreateProcessW: {
				args: [
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.i32,
					FFIType.u32,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
				],
				returns: FFIType.i32,
			},
			CreatePipe: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			PeekNamedPipe: {
				args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
			ReadFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			WriteFile: { args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
			WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
			GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
			TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		});
	} catch {
		return null;
	}
}

let kernel32Cache: ReturnType<typeof loadKernel32Raw> | undefined;
function kernel32(): ReturnType<typeof loadKernel32Raw> | null {
	if (kernel32Cache === undefined) kernel32Cache = loadKernel32Raw();
	return kernel32Cache;
}

/** The WinBase.h enum value, Input bit set — verified against the SDK headers. */
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
/** WinBase.h enum 2 (HandleList), Input bit set — bounds handle inheritance. */
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
const STARTF_USESTDHANDLES = 0x00000100;

/**
 * The profile name for a workspace: `labunbun-<16 hex of the canonical path>`.
 *
 * Deterministic on purpose. The SID is derived from the name, and the SID is
 * what the ACL grant will name — so two runs that agree on the workspace must
 * agree on the profile, or the second run's grant would name a SID no process
 * can ever hold. The hash is of the lowercased absolute path (Windows paths
 * are case-insensitive, and `C:\Ws` and `c:\ws` are the same directory).
 */
export function appContainerProfileName(workspace: string): string {
	// Backslash and forward slash are the same separator on Windows; two
	// spellings of one directory must not get two profiles.
	const normalized = workspace.toLowerCase().replace(/\\/g, "/");
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	return `labunbun-${digest}`;
}

/**
 * Create the profile if this user does not have it yet, and derive its SID.
 *
 * Creating a profile that already exists fails with a pointer-size HRESULT
 * (`0x800700B7`, ERROR_ALREADY_EXISTS) — which is the success case for every
 * run after the first, so it is not an error here. The SID is derived either
 * way, because derivation never fails for a name this user owns.
 */
export function ensureAppContainerProfile(workspace: string): AppContainerProfile | { error: string } {
	const lib = userenv();
	if (lib === null) return { error: "userenv.dll is not loadable on this platform" };
	const name = appContainerProfileName(workspace);
	const nameBuf = wbuf(name);
	const sidOut = new BigUint64Array(1);
	const display = wbuf("LaBunbun sandbox");
	const description = wbuf("Holds commands a LaBunbun session runs under the workspace-write sandbox.");
	const created = lib.symbols.CreateAppContainerProfile(ptr(nameBuf), ptr(display), ptr(description), null, 0, sidOut);
	const S_OK = 0;
	const ERROR_ALREADY_EXISTS = 0x800700b7;
	if (created !== S_OK && created !== ERROR_ALREADY_EXISTS) {
		return { error: `CreateAppContainerProfile failed with 0x${(created >>> 0).toString(16)}` };
	}
	const sid = sidString(Number(sidOut[0]));
	if (sid === null) return { error: "the profile was created but its SID could not be read back" };
	return { name, sid };
}

/** The SID string for a name, creating nothing. Deterministic. */
export function deriveAppContainerSid(name: string): string | null {
	const lib = userenv();
	const conv = advapi();
	if (lib === null || conv === null) return null;
	const sidOut = new BigUint64Array(1);
	if (lib.symbols.DeriveAppContainerSidFromAppContainerName(ptr(wbuf(name)), sidOut) !== 0) return null;
	return sidString(Number(sidOut[0]));
}

export function deleteAppContainerProfile(name: string): boolean {
	const lib = userenv();
	if (lib === null) return false;
	const deleted = lib.symbols.DeleteAppContainerProfile(ptr(wbuf(name)));
	// ERROR_FILE_NOT_FOUND is the answer for a profile that was never created.
	return deleted === 0 || deleted >>> 0 === 0x80070002;
}

function sidString(sidAddr: number): string | null {
	const conv = advapi();
	if (conv === null) return null;
	const strOut = new BigUint64Array(1);
	if (conv.symbols.ConvertSidToStringSidW(sidAddr as unknown as Pointer, strOut) === 0) return null;
	const value = wideStringAt(Number(strOut[0]));
	return value.startsWith("S-1-15-2-") ? value : null;
}

/** The raw SID bytes, for the ACL work that will name this identity. */
export function sidBytes(sidAddr: number): Uint8Array | null {
	const conv = advapi();
	if (conv === null) return null;
	const length = conv.symbols.GetLengthSid(sidAddr as unknown as Pointer);
	if (length === 0) return null;
	return new Uint8Array(memoryAt(sidAddr, length));
}

export interface ConfinedRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Why the run did not complete normally, when it did not. */
	error?: string;
}

export interface ConfinedRunOptions {
	cwd?: string;
	/** Environment block for the child, in the `K=V\0K=V\0\0` form Windows wants. */
	env?: Uint8Array;
	timeoutMs?: number;
}

/**
 * Run one command line inside this profile and wait for it.
 *
 * The command runs to completion with its stdout/stderr on anonymous pipes —
 * this is the shape the Bash tool needs (captured output, not an inherited
 * console), and it is why the spawner lives here rather than being a
 * `Bun.spawn` the caller could have done itself: `Bun.spawn` cannot attach
 * the security-capabilities attribute to the child it creates.
 *
 * On failure the result says which call failed and with what error code,
 * because every failure mode here is a number a reader can act on.
 */
export function runConfined(
	profile: AppContainerProfile,
	commandLine: string,
	options: ConfinedRunOptions = {},
): ConfinedRunResult {
	const lib = kernel32();
	if (lib === null) return { exitCode: -1, stdout: "", stderr: "", error: "kernel32 FFI is unavailable" };
	{
		const sid = deriveAppContainerSid(profile.name);
		if (sid === null)
			return { exitCode: -1, stdout: "", stderr: "", error: `no profile named ${profile.name} exists for this user` };
	}
	const sidAddr = sidAddressFor(profile.name);
	if (sidAddr === null)
		return { exitCode: -1, stdout: "", stderr: "", error: `no profile named ${profile.name} exists for this user` };

	return runConfinedWithSid(sidAddr, commandLine, options);
}

function sidAddressFor(name: string): number | null {
	const userenvLib = userenv();
	if (userenvLib === null) return null;
	const sidOut = new BigUint64Array(1);
	if (userenvLib.symbols.DeriveAppContainerSidFromAppContainerName(ptr(wbuf(name)), sidOut) !== 0) return null;
	return Number(sidOut[0]);
}

function runConfinedWithSid(
	sidAddr: number,
	commandLine: string,
	options: ConfinedRunOptions,
): ConfinedRunResult {
	const lib = kernel32();
	if (lib === null) return { exitCode: -1, stdout: "", stderr: "", error: "kernel32 FFI is unavailable" };

	// SECURITY_CAPABILITIES { AppContainerSid, Capabilities = null, Count = 0, Reserved = 0 }
	const caps = new Uint8Array(24);
	new DataView(caps.buffer).setBigUint64(0, BigInt(sidAddr), true);

	const sizeOut = new BigUint64Array(1);
	// Two attributes, not one: the container capabilities, and — because the
	// child must inherit its std handles — a handle list that lets exactly
	// those through. A plain `bInheritHandles: TRUE` without the list hands
	// the sandbox every inheritable handle this process holds.
	const attrCount = 2;
	lib.symbols.InitializeProcThreadAttributeList(null, attrCount, 0, sizeOut);
	const attrList = new Uint8Array(Number(sizeOut[0]));
	if (lib.symbols.InitializeProcThreadAttributeList(ptr(attrList), attrCount, 0, sizeOut) === 0) {
		return {
			exitCode: -1,
			stdout: "",
			stderr: "",
			error: `InitializeProcThreadAttributeList failed (${lib.symbols.GetLastError()})`,
		};
	}
	const attrAddr = ptr(attrList);
	if (
		lib.symbols.UpdateProcThreadAttribute(
			attrAddr,
			0,
			PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
			ptr(caps),
			24,
			null,
			null,
		) === 0
	) {
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return {
			exitCode: -1,
			stdout: "",
			stderr: "",
			error: `UpdateProcThreadAttribute(capabilities) failed (${lib.symbols.GetLastError()})`,
		};
	}

	// Pipes for stdin/stdout/stderr. Each carries SECURITY_ATTRIBUTES with
	// bInheritHandle = TRUE, because a child that must inherit handles from a
	// parent that did not ask for inheritance (bInheritHandles=FALSE) gets
	// none at all — the child then sees an invalid stdout and every write
	// fails, which reads as "echo works, output is empty" until the pipes are
	// examined.
	// SECURITY_ATTRIBUTES on x64: nLength at 0, lpSecurityDescriptor (NULL) at
	// 8, bInheritHandle at 16 — not at 8, which is the security descriptor's
	// own field, and writing there hands the kernel a non-null pointer it
	// cannot read (ERROR_NOACCESS, 998).
	const inheritable = new Uint8Array(24);
	const inheritableView = new DataView(inheritable.buffer);
	inheritableView.setUint32(0, 24, true); // nLength
	inheritableView.setUint32(16, 1, true); // bInheritHandle
	const inRead = new BigUint64Array(1);
	const inWrite = new BigUint64Array(1);
	const outRead = new BigUint64Array(1);
	const outWrite = new BigUint64Array(1);
	const errRead = new BigUint64Array(1);
	const errWrite = new BigUint64Array(1);
	if (lib.symbols.CreatePipe(inRead, inWrite, ptr(inheritable), 0) === 0) {
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { exitCode: -1, stdout: "", stderr: "", error: `CreatePipe(stdin) failed (${lib.symbols.GetLastError()})` };
	}
	if (lib.symbols.CreatePipe(outRead, outWrite, ptr(inheritable), 0) === 0) {
		lib.symbols.CloseHandle(inRead[0]);
		lib.symbols.CloseHandle(inWrite[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { exitCode: -1, stdout: "", stderr: "", error: `CreatePipe(stdout) failed (${lib.symbols.GetLastError()})` };
	}
	if (lib.symbols.CreatePipe(errRead, errWrite, ptr(inheritable), 0) === 0) {
		lib.symbols.CloseHandle(inRead[0]);
		lib.symbols.CloseHandle(inWrite[0]);
		lib.symbols.CloseHandle(outRead[0]);
		lib.symbols.CloseHandle(outWrite[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { exitCode: -1, stdout: "", stderr: "", error: `CreatePipe(stderr) failed (${lib.symbols.GetLastError()})` };
	}
	lib.symbols.CloseHandle(inWrite[0]);

	// The handle list, so inheritance is exactly the three std ends the child
	// needs and nothing else this process holds open.
	const handleList = new BigUint64Array([inRead[0], outWrite[0], errWrite[0]]);
	if (
		lib.symbols.UpdateProcThreadAttribute(
			attrAddr,
			0,
			PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
			ptr(handleList),
			handleList.byteLength,
			null,
			null,
		) === 0
	) {
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		lib.symbols.CloseHandle(inRead[0]);
		lib.symbols.CloseHandle(outRead[0]);
		lib.symbols.CloseHandle(outWrite[0]);
		lib.symbols.CloseHandle(errRead[0]);
		lib.symbols.CloseHandle(errWrite[0]);
		return {
			exitCode: -1,
			stdout: "",
			stderr: "",
			error: `UpdateProcThreadAttribute(handles) failed (${lib.symbols.GetLastError()})`,
		};
	}

	// STARTUPINFOEX on x64: 104 bytes of STARTUPINFO (dwFlags at 60, the three
	// std handles at 80/88/96 — writing them anywhere else hands the kernel
	// garbage handles and it faults), then lpAttributeList at 104.
	const siex = new Uint8Array(112);
	const siexView = new DataView(siex.buffer);
	siexView.setInt32(0, 112, true);
	siexView.setUint32(60, STARTF_USESTDHANDLES, true); // dwFlags
	siexView.setBigUint64(80, inRead[0], true); // hStdInput: a pipe already at EOF
	siexView.setBigUint64(88, outWrite[0], true); // hStdOutput
	siexView.setBigUint64(96, errWrite[0], true); // hStdError
	siexView.setBigUint64(104, BigInt(attrAddr), true); // lpAttributeList

	const cwdBuf = options.cwd === undefined ? null : wbuf(options.cwd);
	const envBuf = options.env ?? null;
	const pi = new BigUint64Array(2);
	const spawned = lib.symbols.CreateProcessW(
		null, // the first token of the command line names the program
		wbuf(commandLine),
		null,
		null,
		1, // bInheritHandles: the std handles must cross into the child
		EXTENDED_STARTUPINFO_PRESENT,
		envBuf === null ? null : ptr(envBuf),
		cwdBuf === null ? null : ptr(cwdBuf),
		ptr(siex),
		pi,
	);
	// The parent's copies of the write ends must close or the read loops below
	// would wait for a writer that is already gone.
	lib.symbols.CloseHandle(outWrite[0]);
	lib.symbols.CloseHandle(errWrite[0]);
	if (spawned === 0) {
		const err = lib.symbols.GetLastError();
		lib.symbols.CloseHandle(outRead[0]);
		lib.symbols.CloseHandle(errRead[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { exitCode: -1, stdout: "", stderr: "", error: `CreateProcessW failed (${err})` };
	}

	const timeoutMs = options.timeoutMs ?? 600_000;
	const waited = lib.symbols.WaitForSingleObject(pi[0], timeoutMs);
	if (waited === 258) {
		// WAIT_TIMEOUT: the command outlived its budget. Kill it FIRST — a
		// process that still lives still holds the write ends, and reading a
		// pipe with a live writer blocks forever, which is a deadlock, not a
		// slow read.
		lib.symbols.TerminateProcess(pi[0], 1);
	}
	// Reading happens only with every writer either exited or killed: a read
	// then either drains or reports the broken pipe that means EOF.
	const stdout = drainPipe(pi[0], lib, outRead[0]);
	const stderr = drainPipe(pi[0], lib, errRead[0]);
	const exit = new Uint32Array(1);
	lib.symbols.GetExitCodeProcess(pi[0], exit);
	lib.symbols.CloseHandle(pi[0]);
	lib.symbols.CloseHandle(pi[1]);
	lib.symbols.CloseHandle(outRead[0]);
	lib.symbols.CloseHandle(errRead[0]);
	lib.symbols.DeleteProcThreadAttributeList(attrAddr);
	return {
		exitCode: exit[0],
		stdout,
		stderr,
		...(waited === 258 ? { error: `the command did not exit within ${timeoutMs}ms` } : {}),
	};
}

/**
 * Drain a pipe whose writers are all gone, as text — and keep draining while
 * the command lives, because a slow builder writes for minutes.
 *
 * Peek before every read: `ReadFile` on a synchronous pipe blocks until data
 * or EOF, and EOF is the one state Peek reports as a broken pipe. The wait is
 * bounded by the process, not by the pipe — quiet with the command still
 * running is a build mid-thought, and cutting it off there would truncate
 * real output. Only a dead process with a quiet pipe is a grandchild holding
 * the write end (a `start`ed background process, a service the command
 * launched), and that is the one state this loop stops waiting for.
 */
function drainPipe(processHandle: bigint, lib: NonNullable<ReturnType<typeof kernel32>>, handle: bigint): string {
	const chunks: Uint8Array[] = [];
	let quietPolls = 0;
	for (;;) {
		// Peek's 5th parameter is the one that answers — lpTotalBytesAvail. The
		// 6th is bytes-left-in-this-message, which is zero for a byte stream
		// and reads as "no data" forever.
		const available = new BigUint64Array(1);
		const peek = lib.symbols.PeekNamedPipe(handle, null, 0, null, available, null);
		if (peek === 0) break; // ERROR_BROKEN_PIPE: every writer is closed — EOF
		const bytes = Number(available[0]);
		if (bytes === 0) {
			// Quiet: fine while the command runs, bounded once it does not.
			// WAIT_OBJECT_0 (0) means signaled, which for a process handle
			// means it has exited — the opposite reading spins forever on a
			// pipe whose writer is already gone.
			const exited = lib.symbols.WaitForSingleObject(processHandle, 0) === 0;
			if (exited) {
				quietPolls += 1;
				if (quietPolls > 50) break;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
			continue;
		}
		quietPolls = 0;
		const buffer = new Uint8Array(Math.min(bytes, 1024 * 1024));
		const read = new BigUint64Array(1);
		if (lib.symbols.ReadFile(handle, buffer, buffer.length, read, null) === 0) break;
		const count = Number(read[0]);
		if (count > 0) chunks.push(buffer.slice(0, count));
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** True when this machine can confine a process this way at all. */
export function appContainerAvailable(): boolean {
	return process.platform === "win32" && userenv() !== null && kernel32() !== null;
}

