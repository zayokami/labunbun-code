// The Windows AppContainer backend for the filesystem sandbox: the profile and
// spawn half, and the refcounted ACL grant. Production selects it — or does
// not — through `appcontainer-probe.ts` alone: the one honest question is
// whether this machine's shell runs inside a real grant, so the probe asks by
// making one and running it (measured: nothing cheaper is evidence).
// Long-form design notes: docs/dev/sandbox.md
import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** `S-1-15-2-…`, 40 bytes on x64 — the shape the kernel checks per file access. */
export interface AppContainerProfile {
	/** The profile name: deterministic from the workspace, stable across runs. */
	name: string;
	/** The derived package SID, in string form. */
	sid: string;
	// Long-form design notes: docs/dev/sandbox.md
	/** Whether this profile carries the network capability — baked at creation, not granted per spawn. */
	network: boolean;
}

function wbuf(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2 + 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
	return out;
}

// Long-form design notes: docs/dev/sandbox.md
/** The program name to put first in a confined command line: a bare name resolves under System32. */
export function confinedProgramName(program: string): string {
	if (program.includes("\\") || program.includes("/")) return program;
	return `C:\\Windows\\System32\\${program}`;
}

/** `c:\windows\system32\` — the one directory every container child executes without a grant. */
const SYSTEM32_PREFIX = "c:\\windows\\system32\\";

// Long-form design notes: docs/dev/sandbox.md
/** Whether a container child can execute the named program, under System32 or a granted root. */
export function containerCanExecute(program: string, grantedRoots: readonly string[]): boolean {
	const programPath = program.toLowerCase().replace(/\//g, "\\");
	if (programPath.startsWith(SYSTEM32_PREFIX)) return true;
	return grantedRoots.some((root) => isContainedInPath(programPath, root));
}

/** `program === root` or `program` strictly inside `root`, compared as Windows does. */
function isContainedInPath(programPath: string, root: string): boolean {
	if (root === "") return false;
	const rootPath = root.toLowerCase().replace(/\//g, "\\");
	return programPath === rootPath || programPath.startsWith(rootPath.endsWith("\\") ? rootPath : `${rootPath}\\`);
}

// Long-form design notes: docs/dev/sandbox.md
/** The refusal for a session's shell the container cannot execute — one sentence, every caller. */
export function containerShellRefusal(shellProgram: string): string {
	return `the Windows container sandbox cannot run this session's shell: ${shellProgram} is not in C:\\Windows\\System32 and not inside a granted root, so the confined child could not execute it. Turn the sandbox off for this session, or point the shell (LBB_BASH_PATH) at a path inside a granted root.`;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * One Windows command line from argv, quoted the way `CreateProcessW`'s `lpCommandLine` is parsed.
 * Pure, so it is tested on every platform.
 */
export function confinedCommandLine(argv: readonly string[]): string {
	return argv.map(quoteCommandLineArg).join(" ");
}

function quoteCommandLineArg(arg: string): string {
	// Nothing to wrap and nothing to escape: the argument survives verbatim,
	// which is the common case for `/d`, `/s`, `/c`. The empty string is not
	// that case — verbatim it would vanish from the command line entirely and
	// shift every argument after it left by one, so it gets quotes of its own.
	if (arg !== "" && !/[\s"]/.test(arg)) return arg;
	// One layer of quotes, and nothing is escaped inside them: a backslash
	// before the closing quote would otherwise eat it, and the argument would
	// never terminate — so a trailing run of backslashes is kept as-is only
	// because the closing quote here is the one the shell strips, not the
	// program's. A quoted argument ending in backslashes would need doubling
	// under the escaped form; under the verbatim form nothing doubles.
	return `"${arg}"`;
}

// Long-form design notes: docs/dev/sandbox.md
/** The environment block `CreateProcessW` wants: `K=V\0K=V\0\0`, UTF-16LE. */
export function confinedEnvBlock(env: Record<string, string>): Uint8Array {
	const entries: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (key === "" || key.includes("=") || key.includes("\0") || value.includes("\0")) continue;
		entries.push(`${key}=${value}`);
	}
	// Each entry NUL-terminated, then the block's own extra NUL. An empty
	// environment is a single NUL, which is what `wbuf("")` produces.
	return wbuf(entries.length === 0 ? "" : `${entries.join("\0")}\0`);
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
			// BOOL AllocateAndInitializeSid(PSID_IDENTIFIER_AUTHORITY, BYTE nSubAuthorityCount,
			//   DWORD nSubAuthority0..nSubAuthority7, PSID *pSid) — securitybaseapi.h:424,
			//   NOT WinBase.h. Eleven arguments: authority, count, eight sub-authority
			//   slots, out-pointer. The reserved slots are passed as zero.
			AllocateAndInitializeSid: {
				args: [
					FFIType.ptr,
					FFIType.u8,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
				],
				returns: FFIType.i32,
			},
			// DWORD GetNamedSecurityInfoW(LPWSTR, SE_OBJECT_INFO, SECURITY_INFORMATION,
			//   PSID*, PSID*, PACL*, PACL*, PSECURITY_DESCRIPTOR*)
			GetNamedSecurityInfoW: {
				args: [FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.u32,
			},
			// DWORD SetNamedSecurityInfoW(LPWSTR, SE_OBJECT_INFO, SECURITY_INFORMATION,
			//   PSID, PSID, PACL, PACL)
			SetNamedSecurityInfoW: {
				args: [FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.u32,
			},
			// BOOL SetFileSecurityW(LPWSTR, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR)
			// — the descriptor's control word carries SE_DACL_PROTECTED; see
			// `writeDaclProtection` for why this route and not the info-flag one.
			SetFileSecurityW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
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
			// HANDLE CreateFileW(LPCWSTR, DWORD, DWORD, LPSECURITY_ATTRIBUTES,
			//   DWORD, DWORD, HANDLE) — fileapi.h. `readStoredDacl` opens its
			//   READ_CONTROL handle through this and nothing else calls it.
			CreateFileW: {
				args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.u64,
			},
			CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
			WaitForSingleObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.u32 },
			GetExitCodeProcess: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
			// DWORD GetProcessId(HANDLE Process) — processthreadsapi.h. The pid is
			// what a tree kill works by once this module's own handle is the only
			// other way to reach the child.
			GetProcessId: { args: [FFIType.u64], returns: FFIType.u32 },
			TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
			// HLOCAL LocalFree(HLOCAL hMem) — winbase.h. It is listed under
			// kernel32, not advapi32, though every allocation it frees here comes
			// out of an advapi32 call. Verified loadable on this machine.
			LocalFree: { args: [FFIType.u64], returns: FFIType.u64 },
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

/** ntdll, lazily like the rest: `readStoredDacl` is its only caller. */
let ntdllCache: ReturnType<typeof loadNtdllRaw> | undefined;
function ntdll(): ReturnType<typeof loadNtdllRaw> | null {
	if (ntdllCache === undefined) ntdllCache = loadNtdllRaw();
	return ntdllCache;
}

function loadNtdllRaw() {
	try {
		return dlopen("ntdll.dll", {
			// NTSTATUS NtQuerySecurityObject(HANDLE, SECURITY_INFORMATION,
			//   PSECURITY_DESCRIPTOR, ULONG, PULONG) — winternl.h. The
			//   storage-faithful query; `readStoredDacl` documents why the
			//   advapi32 readers cannot stand in for it.
			NtQuerySecurityObject: {
				args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
				returns: FFIType.i32,
			},
		});
	} catch {
		return null;
	}
}

/** The WinBase.h enum value, Input bit set — verified against the SDK headers. */
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
/** WinBase.h enum 2 (HandleList), Input bit set — bounds handle inheritance. */
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
/**
 * WinBase.h enum 14 (ChildProcessPolicy), Input bit set. Launches into a
 * container are children-restricted by default; this override states that the
 * confined child may spawn programs of its own. Measured 2026-10-15: with this
 * attribute set, a cmd inside the container starts bare and PATH-resolved
 * programs, and in-container FFI spawns by absolute path succeed; an env sweep
 * that dropped the attribute changed none of those outcomes, so its bearing on
 * them is not established. (The absolute-token refusals seen from cmd are the
 * volume-subsystem wall, not child-creation restriction.) It stays because
 * omitting it is fail-closed in the wrong direction: a child that could never
 * spawn anything would be unusable.
 */
const PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY = 0x0002000e;
/** WinBase.h PROCESS_CREATION_CHILD_PROCESS_OVERRIDE — the value this launch policy takes. */
const PROCESS_CREATION_CHILD_PROCESS_OVERRIDE = 0x02;
/**
 * The poll slice both runners wait on: short enough that an abort's latency
 * stays imperceptible, long enough that a fast command does not spin the loop.
 * The background runner uses it as its timer's period.
 */
const POLL_MS = 25;

const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
// Long-form design notes: docs/dev/sandbox.md
/** Reads `lpEnvironment` as UTF-16, which is the form `confinedEnvBlock` writes. */
const CREATE_UNICODE_ENVIRONMENT = 0x00000400;
const STARTF_USESTDHANDLES = 0x00000100;
/** `winsta0\default`, kept alive for the life of the process: STARTUPINFOECES carries a pointer to it. */
const INTERACTIVE_DESKTOP = wbuf("winsta0\\default");

/**
 * SECURITY_APP_PACKAGE_AUTHORITY `{0,0,0,0,0,15}` — Winnt.h:10724 — the SID
 * authority every capability SID hangs under.
 */
const CAPABILITY_AUTHORITY = new Uint8Array([0, 0, 0, 0, 0, 15]);

/**
 * SECURITY_CAPABILITY_BASE_RID `3` — Winnt.h:10729 — the first sub-authority
 * of every capability SID: `S-1-15-3-<rid>`.
 */
const CAPABILITY_BASE_RID = 3;

// Long-form design notes: docs/dev/sandbox.md
/** `SECURITY_CAPABILITY_INTERNET_CLIENT` — 1, the outbound-network capability. */
const CAPABILITY_INTERNET_CLIENT = 1;

/** SE_GROUP_ENABLED — the attributes word a capability carries in SECURITY_CAPABILITIES. */
const SE_GROUP_ENABLED = 4;

// Long-form design notes: docs/dev/sandbox.md
/** The capability SID addresses, kept alive because a freed SID under a live struct is a wild pointer. */
const capabilitySidCache = new Map<number, number>();

/** Allocates `S-1-15-3-<rid>` and returns its numeric address. */
function capabilitySid(rid: number): number | null {
	const cached = capabilitySidCache.get(rid);
	if (cached !== undefined) return cached;
	const conv = advapi();
	if (conv === null) return null;
	const out = new BigUint64Array(1);
	const ok = conv.symbols.AllocateAndInitializeSid(
		ptr(CAPABILITY_AUTHORITY),
		2, // revision-independent: the capability SID has two sub-authorities
		CAPABILITY_BASE_RID,
		rid,
		0,
		0,
		0,
		0,
		0,
		0,
		out,
	);
	if (ok === 0) return null;
	const addr = Number(out[0]);
	capabilitySidCache.set(rid, addr);
	return addr;
}

// Long-form design notes: docs/dev/sandbox.md
/** Build `{ SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES[] }` for an app SID plus capabilities. */
function buildSecurityCapabilities(
	appSidAddr: number,
	rids: readonly number[],
): { caps: Uint8Array; attrs: Uint8Array } {
	const caps = new Uint8Array(24);
	const capsView = new DataView(caps.buffer);
	capsView.setBigUint64(0, BigInt(appSidAddr), true);
	const attrs = rids.length === 0 ? new Uint8Array(0) : new Uint8Array(16 * rids.length);
	if (rids.length > 0) {
		const attrsView = new DataView(attrs.buffer);
		rids.forEach((rid, index) => {
			const sidAddr = capabilitySid(rid);
			if (sidAddr === null) throw new Error(`capability SID for rid ${rid} could not be allocated`);
			attrsView.setBigUint64(index * 16, BigInt(sidAddr), true);
			attrsView.setUint32(index * 16 + 8, SE_GROUP_ENABLED, true);
		});
		capsView.setBigUint64(8, BigInt(Number(ptr(attrs))), true);
	}
	capsView.setUint32(16, rids.length, true);
	return { caps, attrs };
}

// Long-form design notes: docs/dev/sandbox.md
/** The profile name for a workspace, deterministic so two runs agree on the SID a grant names. */
export function appContainerProfileName(workspace: string, network = false): string {
	// Backslash and forward slash are the same separator on Windows; two
	// spellings of one directory must not get two profiles.
	const normalized = workspace.toLowerCase().replace(/\\/g, "/");
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	return network ? `labunbun-net-${digest}` : `labunbun-${digest}`;
}

// Long-form design notes: docs/dev/sandbox.md
/** Create the profile if this user does not have it yet, and derive its SID. */
export function ensureAppContainerProfile(workspace: string, network = false): AppContainerProfile | { error: string } {
	const lib = userenv();
	if (lib === null) return { error: "userenv.dll is not loadable on this platform" };
	const name = appContainerProfileName(workspace, network);
	const nameBuf = wbuf(name);
	const sidOut = new BigUint64Array(1);
	const display = wbuf("LaBunbun sandbox");
	const description = wbuf("Holds commands a LaBunbun session runs under the workspace-write sandbox.");
	// The capabilities, as the SID_AND_ATTRIBUTES array creation wants — NOT
	// the SECURITY_CAPABILITIES struct: passing the struct in the fourth
	// parameter is E_INVALIDARG (0x80070057), measured. With no capabilities
	// the parameter must be NULL — `ptr` refuses a zero-length buffer anyway
	// ("a pointer to empty memory doesn't work"), which is the same rule the
	// kernel states.
	const rids = network ? [CAPABILITY_INTERNET_CLIENT] : [];
	const appSidAddr = sidAddressFor(name);
	const capsArray = appSidAddr === null || rids.length === 0 ? null : buildSecurityCapabilities(appSidAddr, rids);
	// Compare unsigned: the HRESULT arrives as a signed i32, and every
	// failure HRESULT has its high bit set — 0x800700B7 is a negative number
	// as the FFI returns it, and a signed compare reports ERROR_ALREADY_EXISTS
	// as an unknown failure.
	const created = lib.symbols.CreateAppContainerProfile(
		ptr(nameBuf),
		ptr(display),
		ptr(description),
		capsArray === null ? null : ptr(capsArray.attrs),
		rids.length,
		sidOut,
	);
	const S_OK = 0;
	const ERROR_ALREADY_EXISTS = 0x800700b7;
	const unsigned = created >>> 0;
	if (unsigned !== S_OK && unsigned !== ERROR_ALREADY_EXISTS) {
		return { error: `CreateAppContainerProfile failed with 0x${unsigned.toString(16)}` };
	}
	// A create that reports ALREADY_EXISTS does NOT write the SID — the
	// output parameter is only filled on success. Deriving is the same value
	// anyway (derivation is a pure function of the name), and it is the only
	// thing that works on every run after the first.
	const sid = unsigned === S_OK ? sidString(Number(sidOut[0])) : deriveAppContainerSid(name);
	if (sid === null) return { error: "the profile exists but its SID could not be read back" };
	return { name, sid, network };
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
	// The API hands back LocalAlloc'd memory the caller owns. The string is read
	// out *before* the free, because the read goes through a view of that same
	// memory — `toArrayBuffer` does not copy (measured 2026-10-15) — and a
	// `wideStringAt` over freed memory would be reading whichever allocation
	// landed there next.
	const value = wideStringAt(Number(strOut[0]));
	kernel32()?.symbols.LocalFree(strOut[0]);
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

// ---- The ACL half: what lets the confined process touch the workspace ----

const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 0x00000004;
// CreateFileW's arguments for the read-only handle `readStoredDacl` opens:
// READ_CONTROL is the one right its query needs, the share mask stays out of
// every other reader's way, and backup semantics is the bit that lets the
// path name a directory (measured 2026-10-16 on both this machine and a
// GitHub windows runner).
const READ_CONTROL = 0x0002_0000;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;
const INVALID_HANDLE_VALUE = 0xffff_ffff_ffff_ffffn;
// The self-relative descriptor's control word, as `SetFileSecurityW` reads it:
// SE_DACL_PRESENT says a DACL is carried, SE_DACL_PROTECTED pins that DACL
// against inheritance. Which route sets them, and which route cannot, is
// documented on `writeDaclProtection` below.
const SE_SELF_RELATIVE = 0x8000;
const SE_DACL_PRESENT = 0x0004;
const SE_DACL_PROTECTED = 0x1000;
// FILE_ALL_ACCESS, the documented value including the standard-rights bits. An
// earlier revision of this comment claimed the missing SYNCHRONIZE bit made
// the container unable to touch the tree at all — that was a misattribution:
// the mutation driver disproved it (the confined child writes fine without
// it), and the failure the bit was blamed for was the spawn shape. The full
// value stands because it is the standard constant, not because a test
// demands the bits.
const FILE_ALL_ACCESS = 0x001f_01ff;
const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
/**
 * FILE_GENERIC_READ | FILE_GENERIC_EXECUTE — the whole grant a toolchain root
 * gets, deliberately with no write bit. Measured 2026-10-15: a program under
 * such a root runs in the container, and a write beside it stays refused.
 */
const FILE_READ_EXECUTE = 0x0012_00a9;

/**
 * The DACL of `path`, as raw bytes, or null when the object carries none.
 *
 * Read through `GetNamedSecurityInfoW` with the DACL bit only: the owner and
 * group are deliberately not asked for, because writing a DACL is this
 * module's whole job and touching an owner is not.
 */
function readDacl(path: string): Uint8Array | null {
	const lib = advapi();
	if (lib === null) return null;
	const pathBuf = wbuf(path);
	const out = new BigUint64Array(6);
	const code = lib.symbols.GetNamedSecurityInfoW(
		ptr(pathBuf),
		SE_FILE_OBJECT,
		DACL_SECURITY_INFORMATION,
		ptr(out),
		ptr(out),
		ptr(out.subarray(2)),
		ptr(out.subarray(3)),
		ptr(out.subarray(4)),
	);
	if (code !== 0) return null;
	// The security descriptor is one LocalAlloc'd block the caller owns — the
	// fifth out-parameter — and it is freed on both exits below. The DACL bytes
	// leave as a copy: the reads go through views of that block (`toArrayBuffer`
	// does not copy, measured 2026-10-15), so anything read out of it must be
	// copied before the free, not read after. This function previously freed
	// nothing, which is why the views it returned stayed readable.
	const descriptor = out[4];
	const daclAddr = Number(out[2]);
	if (daclAddr === 0) {
		kernel32()?.symbols.LocalFree(descriptor);
		return null;
	}
	const head = new DataView(memoryAt(daclAddr, 8));
	const used = head.getUint16(2, true);
	const dacl = new Uint8Array(memoryAt(daclAddr, used)).slice();
	kernel32()?.symbols.LocalFree(descriptor);
	return dacl;
}

/**
 * The DACL of `path` as the file system stores it, or null when the object
 * carries none or cannot be opened.
 *
 * The advapi32 readers are not faithful on every kernel. Measured 2026-10-16
 * on a GitHub windows runner (kernel 26100): both `GetNamedSecurityInfoW`
 * and the handle-based `GetSecurityInfo` re-label rows that lack the
 * INHERITED flag and match the parent's inheritable set on the way out — a
 * directory storing `flags=0x3` reads back `0x13`, while `icacls` and this
 * query report the stored bytes. On this machine (kernel 26200) the same
 * state reads back with SE_DACL_PROTECTED synthesized in the control word
 * instead; the rows agree, so only the runner exposes the split. Nothing
 * that will be replayed through the raw writer may be captured through an
 * advapi32 reader: the raw writer stores bytes as given, so a promoted
 * capture materializes the phantom flags — the exact failure the 007dbd9
 * replay hit on the runner while staying green here.
 *
 * `NtQuerySecurityObject` over a READ_CONTROL handle is the storage-faithful
 * query. The buffer is the caller's, so no LocalFree — but the descriptor
 * bytes still leave as copies before the handle closes, the same ownership
 * rule as `readDacl`.
 */
function readStoredDacl(path: string): Uint8Array | null {
	const lib = ntdll();
	const files = kernel32();
	if (lib === null || files === null) return null;
	const handle = files.symbols.CreateFileW(
		ptr(wbuf(path)),
		READ_CONTROL,
		FILE_SHARE_ALL,
		null,
		OPEN_EXISTING,
		FILE_FLAG_BACKUP_SEMANTICS,
		null,
	);
	if (handle === INVALID_HANDLE_VALUE || handle === 0n) return null;
	let buffer = new Uint8Array(4096);
	const needed = new Uint32Array(1);
	let status = lib.symbols.NtQuerySecurityObject(
		handle,
		DACL_SECURITY_INFORMATION,
		ptr(buffer),
		buffer.length,
		ptr(needed),
	);
	// STATUS_BUFFER_TOO_SMALL (0xC0000023) and STATUS_BUFFER_OVERFLOW
	// (0x80000005) both mean the same thing here: retry with `needed` bytes.
	if (status >>> 0 === 0xc0000023 || status >>> 0 === 0x80000005) {
		buffer = new Uint8Array(needed[0]);
		status = lib.symbols.NtQuerySecurityObject(
			handle,
			DACL_SECURITY_INFORMATION,
			ptr(buffer),
			buffer.length,
			ptr(needed),
		);
	}
	files.symbols.CloseHandle(handle);
	if (status >>> 0 !== 0) return null;
	// The returned descriptor is self-relative: the DWORD at +16 is the
	// DACL's offset, and zero means the object carries none. The ACL's own
	// size field sits at +2 of the ACL; the copy is the header and every ACE.
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.length);
	const daclOffset = view.getUint32(16, true);
	if (daclOffset === 0) return null;
	const used = view.getUint16(daclOffset + 2, true);
	if (used < 8 || daclOffset + used > buffer.length) return null;
	return buffer.slice(daclOffset, daclOffset + used);
}

/** Every ACE in a DACL, walked by size, as raw slices. */
function acesOf(dacl: Uint8Array): Uint8Array[] {
	const aces: Uint8Array[] = [];
	let offset = 8; // the 8-byte ACL header
	while (offset + 4 <= dacl.length) {
		const size = new DataView(dacl.buffer, dacl.byteOffset + offset, 4).getUint16(2, true);
		if (size < 4 || offset + size > dacl.length) break;
		aces.push(dacl.slice(offset, offset + size));
		offset += size;
	}
	return aces;
}

/** The SID string carried inside an ACE, read from its bytes. */
function aceSidString(ace: Uint8Array): string | null {
	const conv = advapi();
	if (conv === null) return null;
	// ACCESS_ALLOWED/DENIED_ACE: 4-byte header, 4-byte mask, then the SID.
	const sidStart = 8;
	if (ace.length <= sidStart) return null;
	const strOut = new BigUint64Array(1);
	if (conv.symbols.ConvertSidToStringSidW((ptr(ace) + sidStart) as unknown as Pointer, strOut) === 0) return null;
	const value = wideStringAt(Number(strOut[0]));
	// Same ownership rule as `sidString`: read, then free the API's allocation.
	kernel32()?.symbols.LocalFree(strOut[0]);
	return value;
}

// Long-form design notes: docs/dev/sandbox.md
/** A new DACL holding these ACEs. `AceCount` is the number of ACEs, not the byte length. */
function buildDacl(aces: Uint8Array[]): Uint8Array {
	const size = 8 + aces.reduce((sum, ace) => sum + ace.length, 0);
	const dacl = new Uint8Array(size);
	const view = new DataView(dacl.buffer);
	view.setUint8(0, 2); // ACL_REVISION
	view.setUint16(2, size, true); // AclSize
	view.setUint16(4, aces.length, true); // AceCount
	let offset = 8;
	for (const ace of aces) {
		dacl.set(ace, offset);
		offset += ace.length;
	}
	return dacl;
}

/** An ACCESS_ALLOWED_ACE granting `mask` to `sidBytes`, inherited downward. */
function allowAce(sid: Uint8Array, mask: number): Uint8Array {
	const ace = new Uint8Array(8 + sid.length);
	const view = new DataView(ace.buffer);
	view.setUint8(0, 0); // ACCESS_ALLOWED_ACE_TYPE
	view.setUint8(1, SUB_CONTAINERS_AND_OBJECTS_INHERIT);
	view.setUint16(2, ace.length, true);
	view.setUint32(4, mask, true);
	ace.set(sid, 8);
	return ace;
}

/**
 * Replaces the DACL of `path` and leaves its protection state alone — measured
 * 2026-10-15: a plain write to a protected directory leaves it protected. The
 * protection state has its own writer below.
 */
function writeDacl(path: string, dacl: Uint8Array): string | null {
	const lib = advapi();
	if (lib === null) return "advapi32 is not loadable";
	const code = lib.symbols.SetNamedSecurityInfoW(
		ptr(wbuf(path)),
		SE_FILE_OBJECT,
		DACL_SECURITY_INFORMATION,
		null,
		null,
		ptr(dacl),
		null,
	);
	if (code !== 0) return `SetNamedSecurityInfoW on ${path} failed (${code})`;
	return null;
}

/** A self-relative security descriptor carrying this DACL and nothing else. */
function sdWithDacl(dacl: Uint8Array, protect: boolean): Uint8Array {
	const sd = new Uint8Array(20 + dacl.length);
	const view = new DataView(sd.buffer);
	view.setUint8(0, 1); // SECURITY_DESCRIPTOR_REVISION
	view.setUint16(2, SE_SELF_RELATIVE | SE_DACL_PRESENT | (protect ? SE_DACL_PROTECTED : 0), true);
	view.setUint32(16, 20, true); // the DACL starts right behind the 20-byte header
	sd.set(dacl, 20);
	return sd;
}

/**
 * Replaces the DACL of `path` and pins its protection state to `protect`.
 *
 * `SetNamedSecurityInfoW` with `PROTECTED_DACL_SECURITY_INFORMATION` is not
 * this writer: for a non-elevated token it answers 5 on this machine
 * (measured 2026-10-15 — and .NET's `Set-Acl` names the wall directly with
 * PrivilegeNotHeldException on SeSecurityPrivilege), while the same request
 * through `SetFileSecurityW`, with `SE_DACL_PROTECTED` in the descriptor's
 * control word, lands (measured, same session, same token). The unprotect
 * side rides the same route with the bit absent: a plain DACL write would
 * leave a protected directory protected (measured), and a `.git` that stays
 * protected after release would silently stop receiving the next grant's ACE.
 */
function writeDaclProtection(path: string, dacl: Uint8Array, protect: boolean): string | null {
	const lib = advapi();
	if (lib === null) return "advapi32 is not loadable";
	if (lib.symbols.SetFileSecurityW(ptr(wbuf(path)), DACL_SECURITY_INFORMATION, ptr(sdWithDacl(dacl, protect))) !== 0) {
		return null;
	}
	const code = kernel32()?.symbols.GetLastError() ?? 0;
	return `SetFileSecurityW on ${path} failed (${code})`;
}

/**
 * Whether an ACE is an allow for this SID whose mask already covers `mask`.
 *
 * The type byte is load-bearing: an ACCESS_DENIED_ACE for this SID grants
 * nothing — measured 2026-10-15, such a deny is inert in the container's
 * access check — so counting it as coverage would skip the grant the child
 * actually needs. The mask is the other half: a covered request is a no-op,
 * and a bigger request still lands.
 */
function aceGrants(ace: Uint8Array, sidString: string, mask: number): boolean {
	// 8 bytes of ACE header plus at least 8 bytes of SID.
	if (ace.length < 16) return false;
	const view = new DataView(ace.buffer, ace.byteOffset, ace.length);
	if (view.getUint8(0) !== 0) return false; // ACCESS_ALLOWED_ACE_TYPE
	if ((view.getUint32(4, true) & mask) !== mask) return false;
	return aceSidString(ace) === sidString;
}

/**
 * `ALL APPLICATION PACKAGES` — the app-model group present in every
 * AppContainer token. The system drive's program directories carry this
 * group's read+execute by default, so a toolchain root under them needs no
 * grant written at all; skipping is load-bearing off elevated machines,
 * where rewriting the ACL of `C:\Program Files\...` would fail on a missing
 * WRITE_DAC the child never needed.
 */
const ALL_APPLICATION_PACKAGES = "S-1-15-2-1";

function grantAccess(path: string, sid: Uint8Array, mask: number): string | null {
	const existing = readDacl(path);
	// A NULL DACL grants everyone everything, so writing one would be an
	// escalation: refuse rather than guess.
	if (existing === null) return `${path} carries no DACL to extend`;
	const sidString = sidStringOf(sid);
	if (sidString === null) return `the SID naming ${path} does not read back as a string`;
	const aces = acesOf(existing);
	if (aces.some((ace) => aceGrants(ace, sidString, mask))) return null; // already covered
	aces.push(allowAce(sid, mask));
	return writeDacl(path, buildDacl(aces));
}

/** Grants read+write on this root and everything under it, to this SID. */
export function grantRootAccess(path: string, sid: Uint8Array): string | null {
	return grantAccess(path, sid, FILE_ALL_ACCESS);
}

/**
 * Grants read+execute on this root and everything under it, to this SID.
 *
 * This is what a toolchain root gets: the confined child runs the programs
 * under it and cannot write one byte back.
 */
export function grantReadExecuteAccess(path: string, sid: Uint8Array): string | null {
	return grantAccess(path, sid, FILE_READ_EXECUTE);
}

export function dropAcesFor(path: string, sid: Uint8Array): string | null {
	const existing = readDacl(path);
	if (existing === null) return null; // nothing to clean
	// Both the SID's string form and the ACE list are hoisted out of the walk:
	// this runs per granted root on release, and neither changes between the
	// ACEs of one DACL. (The previous shape recomputed both per ACE.)
	const target = sidStringOf(sid);
	const aces = acesOf(existing);
	const kept = aces.filter((ace) => aceSidString(ace) !== target);
	if (kept.length === aces.length) return null;
	return writeDacl(path, buildDacl(kept));
}

function sidStringOf(sid: Uint8Array): string | null {
	const conv = advapi();
	if (conv === null) return null;
	// The bytes travel through the same pointer FFI accepts: the address of
	// the buffer holding them.
	const strOut = new BigUint64Array(1);
	if (conv.symbols.ConvertSidToStringSidW(ptr(sid) as unknown as Pointer, strOut) === 0) return null;
	const value = wideStringAt(Number(strOut[0]));
	// Same ownership rule as `sidString`: read, then free the API's allocation.
	kernel32()?.symbols.LocalFree(strOut[0]);
	return value;
}

/** What release must write back for one narrowed directory: the ACE list its DACL carried when the narrowing landed. */
export interface ProtectedRestore {
	path: string;
	aces: Uint8Array[];
}

export interface ProtectOutcome {
	/** What release must write back, when the narrowing landed on a directory that exists. */
	restore?: ProtectedRestore;
	error?: string;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * Narrows the container SID's own allow ACE on `dir` to read+execute, and
 * protects the DACL so inheritance cannot widen it back. This is the
 * allow-side route the S0 record settled on: a deny ACE for the package
 * SID is never consulted by the container's access check, while the SID's
 * own allow ACE, narrowed, is (measured 2026-10-15, 10 of 10 runs).
 *
 * Two writes, in this order, and the order is measured (2026-10-16):
 *
 * (1) the raw writer (`writeDaclProtection`) pins the narrowed list with
 * SE_DACL_PROTECTED. The raw writer is the one route the inheritance
 * engine does not steward — the reconciling writer corrects an ACE still
 * carrying INHERITED_ACE back to the ancestor's version (a narrowed
 * inherited copy evaporates, answering success — the original mystery of
 * this feature) and re-adds an ancestor ACE missing from the written list
 * beside what was written, both measured. Protection also shields the
 * directory from the next grant's own write above it.
 *
 * (2) one reconciling write (`writeDacl`) of the same list at the now
 * protected directory. The directory itself is not re-fattened (protected),
 * and the engine's tree walk leaves it going down: every existing
 * descendant that lacks the narrowed ACE receives it, and every descendant
 * carrying the grant's full-mask copy loses it — that copy's direct parent
 * no longer provides it, and the walk deletes orphaned inherited copies
 * (measured: pin-then-fire on a `.git` with a pre-existing `config` and a
 * nested object, four container semantics judged on the file system after).
 * This is how a file that predates the grant, which a plain narrowing
 * write never reaches, becomes read-only to the container.
 *
 * The pin payload keeps the ACEs' flags: only the mask moves, on
 * ACCESS_ALLOWED ACEs naming this SID. Release reverses it by writing the
 * read-back list through the raw writer (unprotected), and the sweep that
 * follows re-fuses inheritance for the whole tree. The reconciling writes
 * of that sweep re-let the inheritance engine label explicit rows as
 * inherited on some kernels (measured 2026-10-16, a GitHub windows
 * runner), so release ends with one more raw write — the list taken before
 * the grant wrote anything, `protectedAsFound` — replayed as the last word.
 * Both replayed lists are read through `readStoredDacl`, the storage-faithful
 * reader: a capture through an advapi32 reader hands the raw write the
 * promoted INHERITED bits, which it then stores as given (measured, same
 * runner, the diagnostic's second round).
 *
 * A directory that does not exist yet carries nothing to narrow and is
 * skipped — release has nothing to write back for it either. A directory
 * that exists but carries no DACL, or carries no allow ACE for this SID, is
 * an error rather than a skip: the first would be narrowed by guessing, and
 * the second means the grant this narrowing belongs to did not reach the
 * path it claims to protect.
 *
 * `grantRoots` bounds what may be narrowed. A path outside every grant root
 * is refused before anything is read or written: a narrowing is a narrowing
 * of a grant, and it must not be able to reach outside one.
 */
export function protectDirForGrant(dir: string, sid: Uint8Array, grantRoots: readonly string[]): ProtectOutcome {
	const canonical = canonicalPathForChild(dir);
	const inside = grantRoots.map(canonicalPathForChild).some((root) => isWithinRoot(canonical, root));
	if (!inside) return { error: `${dir} is outside every grant root; refusing to narrow it` };
	if (!existsSync(canonical)) return {};
	const existing = readStoredDacl(canonical);
	if (existing === null) return { error: `${canonical} carries no DACL to narrow` };
	const sidString = sidStringOf(sid);
	if (sidString === null) return { error: `the SID naming ${canonical} does not read back as a string` };
	const original = acesOf(existing);
	let narrowed = false;
	// Only the mask moves, and only on ACCESS_ALLOWED ACEs naming this SID:
	// the type, the inheritance flags and the length stay byte-identical, so
	// the write-back at release reverses a mask change rather than rebuilding
	// an ACE. The SID can be named by more than one ACE — a stale inherited
	// copy sits beside the fresh one the grant propagated — and every one of
	// them narrows.
	const masked = original.map((ace) => {
		if (ace.length < 16) return ace;
		const view = new DataView(ace.buffer, ace.byteOffset, ace.length);
		if (view.getUint8(0) !== 0) return ace; // ACCESS_ALLOWED_ACE_TYPE
		if (aceSidString(ace) !== sidString) return ace;
		const copy = ace.slice();
		new DataView(copy.buffer).setUint32(4, FILE_READ_EXECUTE, true);
		narrowed = true;
		return copy;
	});
	if (!narrowed) {
		return { error: `${canonical} carries no allow ACE for the container SID; the grant did not reach it` };
	}
	const pinError = writeDaclProtection(canonical, buildDacl(masked), true);
	if (pinError !== null) return { error: pinError };
	const fireError = writeDacl(canonical, buildDacl(masked));
	if (fireError !== null) {
		// The pin landed but the walk did not: put the bytes back, best
		// effort — the caller's rollback acts on the error either way. No
		// descendant has changed yet, because the pin does not descend.
		writeDaclProtection(canonical, buildDacl(original), false);
		return { error: fireError };
	}
	// The list that goes back is the one that was read: the masked copies
	// are separate slices, so the writes above left `original` untouched.
	return { restore: { path: canonical, aces: original } };
}

export interface ConfinedRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/**
	 * True when this run ended the child itself — a timeout kill or an abort
	 * kill — rather than the child exiting on its own.
	 */
	killed: boolean;
	/** Why the run did not complete normally, when it did not. */
	error?: string;
}

export interface ConfinedRunOptions {
	cwd?: string;
	/** Environment block for the child, in the `K=V\0K=V\0\0` form Windows wants. */
	env?: Uint8Array;
	timeoutMs?: number;
	/** Decoded stdout as it arrives — the live preview a shell user expects. */
	onStdout?: (chunk: string) => void;
	/** Decoded stderr as it arrives. */
	onStderr?: (chunk: string) => void;
	/** Aborting kills the child and settles the run; checked every poll. */
	signal?: AbortSignal;
}

/** The one failure shape: a run that never started, carrying a number a reader can act on. */
function ffFailure(error: string): ConfinedRunResult {
	return { exitCode: -1, stdout: "", stderr: "", killed: false, error };
}

// Long-form design notes: docs/dev/sandbox.md
/** Run one command line inside this profile, streaming its output on anonymous pipes. */
export function runConfined(
	profile: AppContainerProfile,
	commandLine: string,
	options: ConfinedRunOptions = {},
): ConfinedRunResult {
	const lib = kernel32();
	if (lib === null) return ffFailure("kernel32 FFI is unavailable");
	const sid = profileSidFor(profile);
	if ("error" in sid) return ffFailure(sid.error);
	return runConfinedWithSid(sid.sidAddr, commandLine, options, sid.spawnRids);
}

function sidAddressFor(name: string): number | null {
	const userenvLib = userenv();
	if (userenvLib === null) return null;
	const sidOut = new BigUint64Array(1);
	if (userenvLib.symbols.DeriveAppContainerSidFromAppContainerName(ptr(wbuf(name)), sidOut) !== 0) return null;
	return Number(sidOut[0]);
}

/**
 * The SID address and the spawn-time capabilities for a profile — derived in
 * one place, so the blocking runner and the background spawn cannot disagree
 * about the capability list a profile was made with. The profile's baked-in
 * capability would be enough on its own for a profile created with it, but the
 * spawn-time struct is what the kernel actually reads for the token, so a net
 * profile passes the same list here — a mismatch (net profile, empty caps)
 * would be a network-less child under a profile that says otherwise.
 */
function profileSidFor(
	profile: AppContainerProfile,
): { sidAddr: number; spawnRids: readonly number[] } | { error: string } {
	const sidAddr = sidAddressFor(profile.name);
	if (sidAddr === null) return { error: `no profile named ${profile.name} exists for this user` };
	return { sidAddr, spawnRids: profile.network ? [CAPABILITY_INTERNET_CLIENT] : [] };
}

/** What a successful raw spawn hands back: the process, its std read ends, and the pins that keep their memory alive. */
interface ConfinedSpawn {
	pi: BigUint64Array;
	attrList: Uint8Array;
	attrAddr: Pointer;
	outRead: bigint;
	errRead: bigint;
	pid: number;
}

/**
 * The spawn half both confined runners share: attribute list, three inherited
 * pipes, and one `CreateProcessW` under the container capabilities. It never
 * waits — the two runners wait in their own ways — and everything it
 * allocated is either closed here on a failure path or handed back in
 * `ConfinedSpawn` for the runner to close when the child ends.
 */
function spawnConfinedRaw(
	lib: NonNullable<ReturnType<typeof kernel32>>,
	sidAddr: number,
	commandLine: string,
	options: { cwd?: string; env?: Uint8Array },
	spawnRids: readonly number[] = [],
): ConfinedSpawn | { error: string } {
	// The capabilities and their array stay locals across the whole function: the
	// kernel reads both during creation, and a GC'd array under a live pointer is
	// a wild read. `attrs` is the lifetime pin, not dead code.
	// Long-form design notes: docs/dev/sandbox.md
	const { caps, attrs } = buildSecurityCapabilities(sidAddr, spawnRids);
	void attrs;

	const sizeOut = new BigUint64Array(1);
	// Three attributes: the container capabilities; a handle list that lets
	// exactly the std handles through (a plain `bInheritHandles: TRUE`
	// without the list hands the sandbox every inheritable handle this
	// process holds); and the child-process policy that lets the confined
	// child spawn programs of its own at all.
	const attrCount = 3;
	lib.symbols.InitializeProcThreadAttributeList(null, attrCount, 0, sizeOut);
	const attrList = new Uint8Array(Number(sizeOut[0]));
	if (lib.symbols.InitializeProcThreadAttributeList(ptr(attrList), attrCount, 0, sizeOut) === 0) {
		return { error: `InitializeProcThreadAttributeList failed (${lib.symbols.GetLastError()})` };
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
		return { error: `UpdateProcThreadAttribute(capabilities) failed (${lib.symbols.GetLastError()})` };
	}

	// The kernel reads lpValue at creation time, so the buffer stays a local
	// until CreateProcessW returns, like `caps` above.
	const childProcessPolicy = new Uint32Array([PROCESS_CREATION_CHILD_PROCESS_OVERRIDE]);
	if (
		lib.symbols.UpdateProcThreadAttribute(
			attrAddr,
			0,
			PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,
			ptr(childProcessPolicy),
			childProcessPolicy.byteLength,
			null,
			null,
		) === 0
	) {
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { error: `UpdateProcThreadAttribute(child policy) failed (${lib.symbols.GetLastError()})` };
	}

	// Each pipe carries SECURITY_ATTRIBUTES with bInheritHandle = TRUE, and the
	// field sits at offset 16 on x64, not 8.
	// Long-form design notes: docs/dev/sandbox.md
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
		return { error: `CreatePipe(stdin) failed (${lib.symbols.GetLastError()})` };
	}
	if (lib.symbols.CreatePipe(outRead, outWrite, ptr(inheritable), 0) === 0) {
		lib.symbols.CloseHandle(inRead[0]);
		lib.symbols.CloseHandle(inWrite[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { error: `CreatePipe(stdout) failed (${lib.symbols.GetLastError()})` };
	}
	if (lib.symbols.CreatePipe(errRead, errWrite, ptr(inheritable), 0) === 0) {
		lib.symbols.CloseHandle(inRead[0]);
		lib.symbols.CloseHandle(inWrite[0]);
		lib.symbols.CloseHandle(outRead[0]);
		lib.symbols.CloseHandle(outWrite[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { error: `CreatePipe(stderr) failed (${lib.symbols.GetLastError()})` };
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
		return { error: `UpdateProcThreadAttribute(handles) failed (${lib.symbols.GetLastError()})` };
	}

	// STARTUPINFOEX on x64: 104 bytes of STARTUPINFO, then lpAttributeList.
	// lpDesktop at offset 16 names the interactive desktop explicitly, or a
	// restricted-token child dies in CRT init with 0xC0000142.
	// Long-form design notes: docs/dev/sandbox.md
	const siex = new Uint8Array(112);
	const siexView = new DataView(siex.buffer);
	siexView.setInt32(0, 112, true);
	siexView.setBigUint64(16, BigInt(ptr(INTERACTIVE_DESKTOP)), true); // lpDesktop
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
		1, // bInheritHandles: the std handles must cross into the child. The
		// container child dies in CRT init without it AND without an explicit
		// lpDesktop — both halves are load-bearing, see the siex comment.
		EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
		envBuf === null ? null : ptr(envBuf),
		cwdBuf === null ? null : ptr(cwdBuf),
		ptr(siex),
		pi,
	);
	// The parent's copies of the write ends must close or the read loops below
	// would wait for a writer that is already gone. The read end of the child's
	// stdin closes here too — this one close covers both outcomes below — because
	// nothing on this side ever reads it, and every run that gets this far would
	// otherwise leave one inherited handle open for the life of the process.
	lib.symbols.CloseHandle(outWrite[0]);
	lib.symbols.CloseHandle(errWrite[0]);
	lib.symbols.CloseHandle(inRead[0]);
	if (spawned === 0) {
		const err = lib.symbols.GetLastError();
		lib.symbols.CloseHandle(outRead[0]);
		lib.symbols.CloseHandle(errRead[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return { error: `CreateProcessW failed (${err})` };
	}

	return {
		pi,
		attrList,
		attrAddr,
		outRead: outRead[0],
		errRead: errRead[0],
		pid: lib.symbols.GetProcessId(pi[0]),
	};
}

function runConfinedWithSid(
	sidAddr: number,
	commandLine: string,
	options: ConfinedRunOptions,
	spawnRids: readonly number[] = [],
): ConfinedRunResult {
	const lib = kernel32();
	if (lib === null) return ffFailure("kernel32 FFI is unavailable");
	const spawned = spawnConfinedRaw(lib, sidAddr, commandLine, options, spawnRids);
	if ("error" in spawned) return ffFailure(spawned.error);
	const { pi, attrList, attrAddr, outRead, errRead } = spawned;
	// Held until the delete at the end — see the spawn half's pin note.
	void attrList;

	const timeoutMs = options.timeoutMs ?? 600_000;
	const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
	const decoderOut = new StringDecoder("utf8");
	const decoderErr = new StringDecoder("utf8");
	const outChunks: string[] = [];
	const errChunks: string[] = [];
	const pumpOut = (): { eof: boolean; text: boolean } =>
		pumpPipe(lib, outRead, decoderOut, (chunk) => {
			outChunks.push(chunk);
			options.onStdout?.(chunk);
		});
	const pumpErr = (): { eof: boolean; text: boolean } =>
		pumpPipe(lib, errRead, decoderErr, (chunk) => {
			errChunks.push(chunk);
			options.onStderr?.(chunk);
		});

	// The wait is a poll, not one blocking call: the pipes have to be pumped
	// while the command runs — that is what a live preview is — and an abort
	// has to be able to end the run between polls. Each slice waits briefly,
	// drains both pipes, and then asks which of the end conditions arrived.
	let waitError: string | undefined;
	for (;;) {
		const waited = lib.symbols.WaitForSingleObject(pi[0], POLL_MS);
		// Pump before the exit check, so the child's final words — written on its
		// way out, after the last wait — are captured.
		pumpOut();
		pumpErr();
		// WAIT_OBJECT_0 (0) means signaled, which for a process handle means it
		// has exited.
		if (waited === 0) break;
		if (options.signal?.aborted) {
			// An abort is the caller's deadline arriving early: kill and say so.
			lib.symbols.TerminateProcess(pi[0], 1);
			waitError = "the command was aborted before it exited";
			break;
		}
		if (deadline !== null && Date.now() >= deadline) {
			// Kill FIRST — a process that still lives still holds the write
			// ends, and reading a pipe with a live writer blocks forever,
			// which is a deadlock, not a slow read.
			lib.symbols.TerminateProcess(pi[0], 1);
			waitError = `the command did not exit within ${timeoutMs}ms`;
			break;
		}
	}

	// The final drain. Exit or kill closed every writer the child held, so a
	// read now either drains or reports the broken pipe that means EOF. A
	// grandchild the command spawned may still hold one — quiet with the
	// process gone gets a bounded grace (50 × 20ms), the rule the old
	// drainPipe had.
	let quietPolls = 0;
	for (;;) {
		const out = pumpOut();
		const err = pumpErr();
		if (out.eof && err.eof) break;
		if (out.text || err.text) {
			quietPolls = 0;
			continue;
		}
		quietPolls += 1;
		if (quietPolls > 50) break;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
	}
	// A stream that ends mid-character leaves the decoder holding bytes; end()
	// flushes them as the replacement character rather than dropping them.
	const tailOut = decoderOut.end();
	const tailErr = decoderErr.end();
	if (tailOut !== "") {
		outChunks.push(tailOut);
		options.onStdout?.(tailOut);
	}
	if (tailErr !== "") {
		errChunks.push(tailErr);
		options.onStderr?.(tailErr);
	}

	const exit = new Uint32Array(1);
	lib.symbols.GetExitCodeProcess(pi[0], exit);
	lib.symbols.CloseHandle(pi[0]);
	lib.symbols.CloseHandle(pi[1]);
	lib.symbols.CloseHandle(outRead);
	lib.symbols.CloseHandle(errRead);
	lib.symbols.DeleteProcThreadAttributeList(attrAddr);
	return {
		exitCode: exit[0],
		stdout: outChunks.join(""),
		stderr: errChunks.join(""),
		killed: waitError !== undefined,
		...(waitError !== undefined ? { error: waitError } : {}),
	};
}

// ---- The background runner: the same spawn, waited on by a timer ----

/**
 * A tiny signal with node-shaped `on`/`once` — enough of an EventEmitter for a
 * consumer typed against a child's streams, without pulling the class in. A
 * throwing listener must not stop the pump that is delivering into it, so the
 * emit swallows per listener, the stance the shell manager takes with its own
 * dispatch.
 */
class ConfinedSignal<T> {
	#listeners: ((value: T) => void)[] = [];

	on(listener: (value: T) => void): void {
		this.#listeners.push(listener);
	}

	once(listener: (value: T) => void): void {
		const wrapper = (value: T): void => {
			const index = this.#listeners.indexOf(wrapper);
			if (index !== -1) this.#listeners.splice(index, 1);
			listener(value);
		};
		this.#listeners.push(wrapper);
	}

	emit(value: T): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener(value);
			} catch {
				// A listener's bug must not stop the pump or its siblings.
			}
		}
	}
}

/** The stream surface a confined child exposes: the ways the shell manager reads it, and no more. */
export interface ConfinedStream {
	setEncoding(encoding: string): void;
	on(event: "data", listener: (chunk: string) => void): void;
}

/**
 * A running confined child — the handle-based shape `runConfined` cannot give:
 * output is delivered as it arrives and the caller decides when to wait.
 * `error` is declared for the surface's sake and never emitted: spawn failures
 * come back as the `{ error }` return, so nothing can fail after this object
 * exists.
 */
export interface ConfinedProcess {
	readonly pid: number;
	readonly stdout: ConfinedStream;
	readonly stderr: ConfinedStream;
	on(event: "exit" | "close", listener: (code: number) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	once(event: "exit" | "close", listener: (code: number) => void): void;
	once(event: "error", listener: (error: Error) => void): void;
	kill(): void;
}

export interface ConfinedProcessOptions {
	cwd?: string;
	env?: Uint8Array;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * Start one command line inside this profile and hand the running child back.
 *
 * The handle-based twin of `runConfined`, for shells that outlive the call
 * that starts them: the wait becomes a timer over non-blocking polls, and the
 * output is emitted chunk by chunk — a long-lived shell must not accumulate
 * its own output into an array, so nothing here grows with the shell's
 * lifetime. `exit` then `close` fire once each, in that order, only after the
 * pipes have drained or their bounded grace ran out: the order a Node child
 * reports, and the one the shell manager's completion logic reads for.
 */
export function spawnConfined(
	profile: AppContainerProfile,
	commandLine: string,
	options: ConfinedProcessOptions = {},
): ConfinedProcess | { error: string } {
	const lib = kernel32();
	if (lib === null) return { error: "kernel32 FFI is unavailable" };
	const sid = profileSidFor(profile);
	if ("error" in sid) return sid;
	const spawned = spawnConfinedRaw(lib, sid.sidAddr, commandLine, options, sid.spawnRids);
	if ("error" in spawned) return spawned;
	const { pi, attrList, attrAddr, outRead, errRead, pid } = spawned;
	// Held until the delete in `finish` — see the spawn half's pin note.
	void attrList;

	const decoderOut = new StringDecoder("utf8");
	const decoderErr = new StringDecoder("utf8");
	const makeStream = (): { stream: ConfinedStream; emit: (chunk: string) => void } => {
		const listeners: ((chunk: string) => void)[] = [];
		return {
			stream: {
				setEncoding(_encoding: string): void {
					// Accepted and ignored: this pump decodes UTF-8 itself. The
					// method exists so the surface reads like a Node child's to
					// the manager that consumes it.
				},
				on(_event: "data", listener: (chunk: string) => void): void {
					listeners.push(listener);
				},
			},
			emit: (chunk) => {
				for (const listener of [...listeners]) {
					try {
						listener(chunk);
					} catch {
						// A listener's bug must not stop the pump or its siblings.
					}
				}
			},
		};
	};
	const stdout = makeStream();
	const stderr = makeStream();
	const exitSignal = new ConfinedSignal<number>();
	const closeSignal = new ConfinedSignal<number>();
	const errorSignal = new ConfinedSignal<Error>();

	let settled = false;
	let childExited = false;
	let quietTicks = 0;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		clearInterval(ticker);
		// A stream that ends mid-character leaves the decoder holding bytes;
		// end() flushes them as the replacement character rather than dropping
		// them — the same tail rule the blocking runner has.
		const tailOut = decoderOut.end();
		const tailErr = decoderErr.end();
		if (tailOut !== "") stdout.emit(tailOut);
		if (tailErr !== "") stderr.emit(tailErr);
		const exit = new Uint32Array(1);
		lib.symbols.GetExitCodeProcess(pi[0], exit);
		lib.symbols.CloseHandle(pi[0]);
		lib.symbols.CloseHandle(pi[1]);
		lib.symbols.CloseHandle(outRead);
		lib.symbols.CloseHandle(errRead);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		exitSignal.emit(exit[0]);
		closeSignal.emit(exit[0]);
	};
	// Deliberately not unref'd: a running child keeps the process alive, the
	// way a Node child does.
	const ticker = setInterval(() => {
		if (settled) return;
		if (childExited) {
			// The bounded drain: exit closed the child's writer ends, but a
			// grandchild it spawned may still hold one. Quiet for 50 ticks is
			// where the blocking runner stops too.
			const out = pumpPipe(lib, outRead, decoderOut, stdout.emit);
			const err = pumpPipe(lib, errRead, decoderErr, stderr.emit);
			if (out.eof && err.eof) {
				finish();
				return;
			}
			if (out.text || err.text) {
				quietTicks = 0;
			} else {
				quietTicks += 1;
				if (quietTicks > 50) finish();
			}
			return;
		}
		pumpPipe(lib, outRead, decoderOut, stdout.emit);
		pumpPipe(lib, errRead, decoderErr, stderr.emit);
		// A zero-timeout wait, so the tick never blocks: signaled (0) means the
		// child is gone, and the next tick drains what it left.
		if (lib.symbols.WaitForSingleObject(pi[0], 0) === 0) childExited = true;
	}, POLL_MS);

	return {
		pid,
		stdout: stdout.stream,
		stderr: stderr.stream,
		on(event: "exit" | "close" | "error", listener: ((code: number) => void) | ((error: Error) => void)): void {
			if (event === "error") errorSignal.on(listener as (error: Error) => void);
			else if (event === "exit") exitSignal.on(listener as (code: number) => void);
			else closeSignal.on(listener as (code: number) => void);
		},
		once(event: "exit" | "close" | "error", listener: ((code: number) => void) | ((error: Error) => void)): void {
			if (event === "error") errorSignal.once(listener as (error: Error) => void);
			else if (event === "exit") exitSignal.once(listener as (code: number) => void);
			else closeSignal.once(listener as (code: number) => void);
		},
		kill(): void {
			// Terminate through the handle this object holds — the backstop
			// behind a pid-based tree kill, which can race the child's own end.
			// After the end it is a no-op: the handle is closed.
			if (!settled) lib.symbols.TerminateProcess(pi[0], 1);
		},
	};
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * One non-blocking round of a pipe: everything buffered comes out, decoded, and emitted.
 * Peek before every read: `ReadFile` blocks, and the 5th `PeekNamedPipe` parameter answers.
 */
function pumpPipe(
	lib: NonNullable<ReturnType<typeof kernel32>>,
	handle: bigint,
	decoder: StringDecoder,
	onText: (chunk: string) => void,
): { eof: boolean; text: boolean } {
	let text = false;
	for (;;) {
		const available = new BigUint64Array(1);
		if (lib.symbols.PeekNamedPipe(handle, null, 0, null, available, null) === 0) return { eof: true, text };
		const bytes = Number(available[0]);
		if (bytes === 0) return { eof: false, text };
		const buffer = new Uint8Array(Math.min(bytes, 1024 * 1024));
		const read = new BigUint64Array(1);
		if (lib.symbols.ReadFile(handle, buffer, buffer.length, read, null) === 0) return { eof: true, text };
		const count = Number(read[0]);
		if (count === 0) return { eof: false, text };
		const chunk = decoder.write(Buffer.from(buffer.buffer, buffer.byteOffset, count));
		if (chunk !== "") {
			onText(chunk);
			text = true;
		}
	}
}

/** True when this machine can confine a process this way at all. */
export function appContainerAvailable(): boolean {
	return process.platform === "win32" && userenv() !== null && kernel32() !== null;
}

// ---- The grant: acquired per workspace, refcounted, released on the last ----

interface ActiveGrant {
	/** The container identity's SID bytes, for removing exactly its ACEs later. */
	sid: Uint8Array;
	/** How many commands are running under it right now. */
	refs: number;
	/**
	 * The roots this grant wrote FILE_ALL_ACCESS on, canonicalised: the bound a
	 * joining caller's protected narrowing may use, and the set that caller's
	 * write roots must already be covered by.
	 */
	writeRoots: string[];
	// Long-form design notes: docs/dev/sandbox.md
	/** Every root this grant wrote an ACE on, the workspace first. */
	roots: string[];
	/** The narrowed directories this grant must write back on release, with the ACE list each one carried before. */
	protectedRestores: ProtectedRestore[];
	/**
	 * The ACE list each protected directory carried before this grant wrote
	 * anything, read first so release can end on the raw writer: the
	 * reconciling writers in between re-let the inheritance engine label
	 * explicit rows as inherited on some kernels (measured 2026-10-16, a
	 * GitHub windows runner), and only the raw writer replays bytes as given —
	 * which is why the list itself is a `readStoredDacl` read: captured
	 * through an advapi32 reader it carries that reader's promoted INHERITED
	 * bits, and the raw write stores them for real (measured, same runner,
	 * the diagnostic's second round).
	 */
	protectedAsFound: ProtectedRestore[];
}

const activeGrants = new Map<string, ActiveGrant>();

// Long-form design notes: docs/dev/sandbox.md
/** The one spelling of a path every reader agrees on: symlinks, junctions, and 8.3 names resolved. */
export function canonicalPathForChild(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Whether `candidate` sits strictly inside `root`, both canonicalised by
 * `canonicalPathForChild`. Case-insensitive because the two spellings came
 * from separate `realpathSync` calls; a backslash boundary because
 * `D:\Program Files\Git` must not count as containing `D:\Program Files\GitHub`.
 */
export function isWithinRoot(candidate: string, root: string): boolean {
	// Separators fold before the compare: a root that exists canonicalises to
	// backslashes, while a not-yet-existing child keeps whatever spelling it
	// was handed — the policy spells paths with forward slashes. Measured
	// 2026-10-15: a missing `.git` compared against its realpath'd workspace
	// came out "outside every grant root" on every run for exactly this.
	const candidateFolded = candidate.replace(/\//g, "\\");
	const rootFolded = root.replace(/\//g, "\\");
	if (candidateFolded.length <= rootFolded.length) return false;
	const boundary = rootFolded.endsWith("\\") ? rootFolded : `${rootFolded}\\`;
	return candidateFolded.toLowerCase().startsWith(boundary.toLowerCase());
}

/** Whether two spellings name the same root, with the separators and case rules `isWithinRoot` uses. */
function sameRoot(path: string, root: string): boolean {
	return path.replace(/\//g, "\\").toLowerCase() === root.replace(/\//g, "\\").toLowerCase();
}

/** Whether some granted root already covers `path` for the same access: the path itself, or a directory above it. */
function coveredByGrant(path: string, granted: readonly string[]): boolean {
	return granted.some((root) => sameRoot(path, root) || isWithinRoot(path, root));
}

export interface GrantOutcome {
	profile?: AppContainerProfile;
	error?: string;
}

// Long-form design notes: docs/dev/sandbox.md
/** Grants the container SID write access to the workspace and any extra roots, read+execute to any toolchain roots, refcounted. */
export function acquireWorkspaceGrant(
	workspace: string,
	network = false,
	extraRoots: readonly string[] = [],
	executableRoots: readonly string[] = [],
	protectedRoots: readonly string[] = [],
): GrantOutcome {
	const profile = ensureAppContainerProfile(workspace, network);
	if ("error" in profile) return { error: profile.error };
	const existing = activeGrants.get(profile.name);
	if (existing !== undefined) {
		// A join is not automatically covered. The open grant wrote the roots and
		// narrowed the protected directories the first caller named; either half
		// can be narrower than what this caller asks for, and reusing it anyway
		// is how a repository created after the first acquire — a nested `.git`
		// from a clone or a submodule update — keeps the inheritable full-mask
		// ACE the first grant handed down, on a path the current policy calls
		// protected. Narrow what can be narrowed under the open grant; refuse
		// the join for a root it never granted, rather than run a command with
		// less access than the policy promises. Both failures are returned
		// without a reference, so the caller's error path cannot release a
		// grant it never held.
		const requestedWrites = [workspace, ...extraRoots.filter((root) => root !== workspace)].map(canonicalPathForChild);
		const missingWrite = requestedWrites.find((root) => !coveredByGrant(root, existing.writeRoots));
		if (missingWrite !== undefined) {
			return {
				profile,
				error: `the grant for ${workspace} is already open without write access to ${missingWrite}; release it before granting more`,
			};
		}
		const requestedExec = Array.from(new Set(executableRoots.map(canonicalPathForChild)));
		const missingExec = requestedExec.find((root) => !coveredByGrant(root, existing.roots));
		if (missingExec !== undefined) {
			return {
				profile,
				error: `the grant for ${workspace} is already open without read+execute access to ${missingExec}; release it before granting more`,
			};
		}
		for (const dir of [...new Set(protectedRoots.map(canonicalPathForChild))]) {
			// The same domain filter the acquire path applies: a path outside
			// every write root is not something this grant reaches.
			if (!existing.writeRoots.some((root) => isWithinRoot(dir, root))) continue;
			// A directory narrowed once is already protected, and its pre-grant
			// list is on the release list; narrowing again would capture the
			// narrowed list as its own restore.
			if (existing.protectedRestores.some((restore) => sameRoot(restore.path, dir))) continue;
			const outcome = protectDirForGrant(dir, existing.sid, existing.writeRoots);
			if (outcome.error !== undefined) return { profile, error: outcome.error };
			// A directory that does not exist yet carries nothing to narrow; it
			// stays off the release list, and the next join tries again.
			if (outcome.restore !== undefined) existing.protectedRestores.push(outcome.restore);
		}
		existing.refs += 1;
		return { profile };
	}
	const sid = sidBytesFor(profile.name);
	if (sid === null) {
		return { profile, error: `the profile for ${workspace} has no readable SID` };
	}
	const sidString = sidStringOf(sid);
	if (sidString === null) {
		return { profile, error: `the profile for ${workspace} has an unreadable SID` };
	}
	// The workspace first, then the roots the policy adds, then the toolchain
	// roots read+execute closes over. Every root is granted or none is: a
	// half-grant leaves a command that can write its workspace but not its
	// cache, which is the narrower-than-asked failure this repository already
	// fixed once in `policyFor` — and here it would be worse, because the
	// first write that misses is the one that fails. The caller gets the error
	// and runs nothing, which is the legible failure rather than an unconfined
	// one, and the rollback below writes back the DACL each touched root
	// carried before this call, so the rule holds on disk too.
	//
	// Each root is canonicalised before the ACE is written — a measured GitHub
	// runner failure: an ACE against the 8.3 short spelling does not cover a
	// child that opens the same directory by another spelling.
	// Long-form design notes: docs/dev/sandbox.md
	const writeRoots = [workspace, ...extraRoots.filter((root) => root !== workspace)].map(canonicalPathForChild);
	// A toolchain root is read and executed, never written: read+execute is
	// the whole grant. A root the write list already covers is dropped —
	// FILE_ALL_ACCESS is a superset, and the bigger ACE is the whole grant.
	const execRoots = Array.from(new Set(executableRoots.map(canonicalPathForChild))).filter(
		(root) => !writeRoots.includes(root),
	);
	// A root a shallower root already covers by inheritance is dropped from
	// the plan: writing it too pays a second full-tree ACL propagation and, on
	// the failure path, a second rollback of it. Measured 2026-10-15 on this
	// machine: a doomed `D:\Program Files\Git` listed behind a writable
	// `Git\usr` cost ~1.3 s of write-then-rollback on every probe; with the
	// shallower root going first, the same machine declines in tens of
	// milliseconds and never writes below it. One-directional on purpose: a
	// write root under a read+execute root stays — RX does not cover F, so
	// dropping it would narrow the grant below what was asked.
	const plannedWrites = writeRoots.filter(
		(root) => !writeRoots.some((other) => other !== root && isWithinRoot(root, other)),
	);
	const plannedExec = execRoots.filter(
		(root) => ![...plannedWrites, ...execRoots].some((other) => other !== root && isWithinRoot(root, other)),
	);
	const touched: Array<{ root: string; aces: Uint8Array[] }> = [];
	const protectRestores: ProtectedRestore[] = [];
	const protectAsFound: ProtectedRestore[] = [];
	const fail = (error: string): GrantOutcome => {
		// Best effort: the error that got here is the one the caller acts on,
		// and a rollback that failed would only trade it for a quieter one.
		// The narrowed directories first — their bytes go back raw and
		// unprotected, so the root write-back below, which is a reconciling
		// write, can carry the restoration on down over each one's subtree.
		for (const restore of protectRestores) writeDaclProtection(restore.path, buildDacl(restore.aces), false);
		for (const { root, aces } of touched) writeDacl(root, buildDacl(aces));
		// The reconciling writers above clean the tree but do not steward the
		// explicit-versus-inherited marking of what they touch, so the raw
		// writer gets the last word, replaying the lists read before each
		// write — same measurement as release's closing write, see there. The
		// lists are storage-faithful reads (`readStoredDacl`), see the capture
		// below.
		for (const { root, aces } of touched) writeDaclProtection(root, buildDacl(aces), false);
		for (const found of protectAsFound) writeDaclProtection(found.path, buildDacl(found.aces), false);
		return { profile, error };
	};
	const plan: Array<{ root: string; mask: number }> = [
		...plannedWrites.map((root) => ({ root, mask: FILE_ALL_ACCESS })),
		...plannedExec.map((root) => ({ root, mask: FILE_READ_EXECUTE })),
	];
	// The lists the protected directories carry now, read before the plan
	// writes — this is the state release and the rollback end on, through the
	// raw writer, because the reconciling writes in between re-let the
	// inheritance engine re-label explicit rows as inherited on some kernels
	// (measured 2026-10-16, a GitHub windows runner: rows born from the
	// token's default DACL came back (I)-marked while this machine's stayed
	// byte-identical). The read is `readStoredDacl`'s: on that runner the
	// advapi32 readers handed the same rows back already promoted, and
	// replaying such a capture through the raw writer materialized the
	// phantom marks — the second diagnostic round measured both halves.
	// A path outside every write root is left out — nothing will be written
	// there, so nothing must be restored either.
	for (const dir of [...new Set(protectedRoots.map(canonicalPathForChild))]) {
		if (!writeRoots.some((root) => isWithinRoot(dir, root))) continue;
		if (!existsSync(dir)) continue;
		const prior = readStoredDacl(dir);
		if (prior === null) continue;
		protectAsFound.push({ path: dir, aces: acesOf(prior) });
	}
	for (const { root, mask } of plan) {
		// Storage-faithful for the same reason as the protected list above:
		// the rollback replays this through the raw writer.
		const prior = readStoredDacl(root);
		if (prior === null) return fail(`${root} carries no DACL to extend`);
		const aces = acesOf(prior);
		if (aces.some((ace) => aceGrants(ace, sidString, mask))) continue; // already covered
		// Read+execute covered by the group every container token carries needs
		// no ACE written — and on a system-drive program directory rewriting
		// the DACL at all would need a WRITE_DAC the user may not hold.
		if (mask === FILE_READ_EXECUTE && aces.some((ace) => aceGrants(ace, ALL_APPLICATION_PACKAGES, mask))) continue;
		const grantError = writeDacl(root, buildDacl([...aces, allowAce(sid, mask)]));
		if (grantError !== null) return fail(grantError);
		touched.push({ root, aces });
	}
	// The protected directories, narrowed now that the grant is on disk: each
	// one has just received the SID's ACE by inheritance, and that copy is
	// what narrows in place. Part of the same all-or-nothing rule — a failure
	// here rolls the whole grant back through `fail`.
	for (const dir of [...new Set(protectedRoots.map(canonicalPathForChild))]) {
		const outcome = protectDirForGrant(dir, sid, writeRoots);
		if (outcome.error !== undefined) return fail(outcome.error);
		if (outcome.restore !== undefined) protectRestores.push(outcome.restore);
	}
	activeGrants.set(profile.name, {
		sid,
		refs: 1,
		writeRoots,
		roots: [...writeRoots, ...execRoots],
		protectedRestores: protectRestores,
		protectedAsFound: protectAsFound,
	});
	return { profile };
}

/** Drops one reference, and on the last one removes every ACE this grant added. */
export function releaseWorkspaceGrant(workspace: string, network = false): string | null {
	const grant = activeGrants.get(appContainerProfileName(workspace, network));
	if (grant === undefined) return null;
	grant.refs -= 1;
	if (grant.refs > 0) return null;
	activeGrants.delete(appContainerProfileName(workspace, network));
	let firstError: string | null = null;
	// The narrowed directories first: the write-back re-fuses inheritance
	// and runs while the grant's ACEs are still in place, so the sweep that
	// follows carries the removal past the directory and down its subtree —
	// the same reconciling write that re-fuses is also what deletes the
	// narrowed copies the grant's fire handed down, because their source ACE
	// leaves the directory's list in the very same write. Each path is then
	// swept with `dropAcesFor` rather than trusting that propagation to have
	// reached it: the write-back restores the inherited copy of the grant's
	// own ACE along with the rest of the original list, and the sweep is
	// what proves the path itself is clean.
	for (const restore of grant.protectedRestores) {
		const restoreError = writeDaclProtection(restore.path, buildDacl(restore.aces), false);
		const dropError = dropAcesFor(restore.path, grant.sid);
		const error = restoreError ?? dropError;
		if (error !== null && firstError === null) firstError = error;
	}
	// Every root, not just the workspace — see `ActiveGrant.roots` for why.
	for (const root of grant.roots) {
		const dropError = dropAcesFor(root, grant.sid);
		if (dropError !== null && firstError === null) firstError = dropError;
	}
	// The last word is raw. Everything above — the write-backs, the sweep,
	// and the tree walks the sweep triggers — goes through the reconciling
	// writers, which re-let the inheritance engine label the ACEs already
	// on a path. Measured 2026-10-16, on a GitHub windows runner where the
	// three rows of "the protected directory inside a grant" failed while
	// this machine stayed green: a directory born from the token's default
	// DACL — explicit rows, no INHERITED flag, unprotected — came back from
	// the cycle with every row (I)-marked. The raw writer stores the ACE
	// bytes as given (measured), and it runs here, after the sweep, so
	// nothing writes after it: the list read before the grant is what the
	// directory keeps. That read is a `readStoredDacl` read — see
	// `ActiveGrant.protectedAsFound` for why the capture side must be
	// storage-faithful: through an advapi32 reader the promoted INHERITED
	// bits would ride along, and this raw write would store them for real.
	for (const found of grant.protectedAsFound) {
		const error = writeDaclProtection(found.path, buildDacl(found.aces), false);
		if (error !== null && firstError === null) firstError = error;
	}
	return firstError;
}

/** The SID bytes of a profile name, through the same derivation the profile uses. */
export function sidBytesFor(name: string): Uint8Array | null {
	const lib = userenv();
	const conv = advapi();
	if (lib === null || conv === null) return null;
	const sidOut = new BigUint64Array(1);
	if (lib.symbols.DeriveAppContainerSidFromAppContainerName(ptr(wbuf(name)), sidOut) !== 0) return null;
	return sidBytes(Number(sidOut[0]));
}
