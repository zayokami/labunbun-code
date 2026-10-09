/**
 * The Windows AppContainer backend for the filesystem sandbox.
 *
 * **Status, stated exactly.** Both halves are wired here: the profile/spawn
 * half, and the ACL grant half — `acquireWorkspaceGrant` /
 * `releaseWorkspaceGrant`, refcounted per profile, covering every writable
 * root the policy names rather than only the workspace. `resolveSandboxExecution`
 * has an `appcontainer` branch and `exec` consumes it: grant before the spawn,
 * release in a `finally`, so an abort or a failed spawn cannot leak an ACE.
 * What still keeps production off it is measured, not cautious — a confined
 * child inherits a token that executes only what the grant names its package
 * SID, and this machine's `git`, `node`, and `bun` live outside every grant,
 * so selecting the backend would confine every default-mode command into
 * something that cannot run `git status`. The measurement lives on
 * `SandboxRuntime.hasAppContainer` in `./index.ts`; `simulated.ts` records
 * what the tool layer still does while the OS does nothing.
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
 *   - Directory ENUMERATION works and `cmd /c dir` does not: FindFirstFile
 *     through a for-glob or PowerShell lists a granted tree fine, while cmd's
 *     `dir` is refused — the AppContainer token cannot reach the volume /
 *     mount-manager subsystem cmd queries (the MS STL issue #6286 landing).
 *     `git status`, `ls` in bash, and every other FindFirstFile consumer work;
 *     the earlier "listing is denied" report measured with cmd's `dir` and was
 *     a property of the instrument, not of the backend.
 *   - What the session shell does inside the container is the toolchain
 *     measurement from the other side. `detectShell` prefers
 *     `C:\Program Files\Git\bin\bash.exe` wherever Git for Windows is
 *     installed, and such a shell starts under the container token and dies
 *     at DLL initialization — 0xC0000142, `STATUS_DLL_INIT_FAILED` — because
 *     the MSYS runtime beside it is granted to nobody. Four container-path
 *     tests failed exactly that way on the GitHub Windows runner while the
 *     same suite passed here, where the conventional path does not exist and
 *     the shell is `cmd.exe`. `containerCanExecute` turns that number into a
 *     refusal naming the program, and the container-path tests inject a shell
 *     of their own so a machine's Git layout is not part of what they measure.
 *   - `.git` is NOT protected by this build tonight, and the reason is a
 *     measurement that would not repeat. The deny ACE (Codex's mutation mask,
 *     0x10156) demonstrably refuses create/overwrite/delete/rename under
 *     `.git` when an external process writes it, and demonstrably does not
 *     when `acquire`'s own `protectGitDir` writes it two statements after
 *     `grantRootAccess` — same ACL on disk (icacls confirms the deny both
 *     times), same confined child (the low-integrity label confirms it),
 *     opposite results. A self-verifying guard was built to settle it and its
 *     verdict was the unreliable side: it refused on clean trees where the
 *     settled replay was refused. So the deny is out until the timing is
 *     understood, and the workspace boundary is the only confinement this
 *     half ships. Reintroduce `protectGitDir` (last known shape: one
 *     inherited deny ACE, mask 0x10156) as the opening question of the next
 *     session.
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
import { realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** `S-1-15-2-…`, 40 bytes on x64 — the shape the kernel checks per file access. */
export interface AppContainerProfile {
	/** The profile name: deterministic from the workspace, stable across runs. */
	name: string;
	/** The derived package SID, in string form. */
	sid: string;
	/**
	 * Whether this profile was created with the network capability baked in.
	 *
	 * The capability is a property of the *profile* (baked at creation, ignored
	 * on the ALREADY_EXISTS path), not of the spawn — so a caller that runs
	 * under a net profile must not assume a spawn-time caps struct alone would
	 * have granted the network, and a caller holding an offline profile must
	 * not pass one and expect it to stick.
	 */
	network: boolean;
}

function wbuf(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2 + 2);
	const view = new DataView(out.buffer);
	for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
	return out;
}

/**
 * The program name to put first in a confined command line.
 *
 * `CreateProcessW` is handed `lpApplicationName: null`, so the kernel resolves
 * the program from the first token of the command line — and it resolves it
 * **without the parent's PATH**: the child's own restricted token performs
 * the lookup, and a bare `cmd.exe` fails with 203 (ERROR_INVALID_FUNCTION).
 * Measured, and asymmetric with the spawn path in a way that matters: `spawn`
 * reaches the same call but through a code path that resolves the program name
 * itself, so a relative shell name has always worked there and the container
 * is the first place it did not.
 *
 * The resolution is deliberately narrow: an argument that already carries a
 * path separator or an extension is used as given, and only a bare name is
 * looked up under the System32 directory — where the one bare name this build
 * ever passes (`cmd.exe`, the `detectShell` fallback when no bash is
 * installed) lives. A wider search (scanning the parent's PATH) would put the
 * parent's environment inside a decision about the child's identity, which is
 * the opposite of what a confined spawn is for.
 */
export function confinedProgramName(program: string): string {
	if (program.includes("\\") || program.includes("/")) return program;
	return `C:\\Windows\\System32\\${program}`;
}

/** `c:\windows\system32\` — the one directory every container child executes without a grant. */
const SYSTEM32_PREFIX = "c:\\windows\\system32\\";

/**
 * Whether a container child can execute the named program: under System32, or
 * inside a root the grant names — and nothing else.
 *
 * Takes the program **as `confinedProgramName` resolves it** (a bare name has
 * already become `C:\Windows\System32\<name>` by the time this is asked),
 * because the resolution and the executability are two questions about the
 * same token and one answer.
 *
 * The rule is the blocker recorded on `SandboxRuntime.hasAppContainer`, seen
 * from the program's side: a confined child executes only what the grant names
 * its package SID, plus the system directories the image grants every
 * AppContainer. `git`, `node` and `bun` outside every grant come back "not
 * recognized" by PATH and "Access is denied" by absolute path, while a copy
 * placed inside the granted workspace runs — the grant is the whole
 * difference.
 *
 * **The consequence this function exists for is the session shell.**
 * `detectShell` prefers `C:\Program Files\Git\bin\bash.exe` when Git for
 * Windows is installed in its conventional place, so on such a machine the
 * shell is in neither set: `CreateProcessW` starts it — the image file itself
 * is readable — and it dies at DLL initialization with exit code 0xC0000142
 * (`STATUS_DLL_INIT_FAILED`) because the MSYS runtime beside it cannot be
 * loaded. That measured as four opaque failures on the GitHub Windows runner
 * (`test (windows-latest)`, every container-path spawn red with the same
 * number) while the identical suite was green here, where the conventional
 * path does not exist and the shell falls back to `cmd.exe`. A refusal naming
 * the program beats that number, so `operations.exec` checks before it
 * spawns.
 *
 * Case-insensitive and separator-agnostic on purpose: Windows paths differ
 * only in case (see `caseInsensitiveSandboxPaths`), and the granted roots
 * arrive from the policy with whichever separator the policy was built with.
 * Pure, so it is tested on every platform — the containment is a property of
 * the rule, not of the machine.
 */
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

/**
 * One Windows command line from argv, quoted the way `CreateProcessW`'s
 * `lpCommandLine` is parsed.
 *
 * **This is the verbatim form, and that is a measured requirement, not a
 * shortcut.** `CreateProcessW` hands the string to the child's CRT, which
 * splits it with `CommandLineToArgvW`-style rules — full escaping included —
 * and that is the right shape for a program that parses its own argv. It is
 * the wrong shape for `cmd /c`, whose `/s` means "take the text between the
 * quotes exactly as it stands": an escaped `\"` then survives as a literal
 * backslash-quote pair, cmd cannot parse it, and every command containing a
 * quote — which is every redirection, and every command with a string in it —
 * fails with "The filename, directory name, or volume label syntax is
 * incorrect". Measured on both sides: Node's `spawn` with its default argv
 * quoting fails the same command, and the same spawn with
 * `windowsVerbatimArguments: true` — one layer of quotes, embedded quotes
 * untouched — succeeds.
 *
 * So the rule here is one layer per argument: wrap in double quotes when the
 * argument contains a space or a tab, and leave everything else alone. A
 * program that needs escaping is not a program this shell ever runs; `bash`
 * parses the same verbatim string with its own rules and is unaffected.
 *
 * Pure, so it is tested on every platform — the rule is a property of the
 * Windows command-line format, not of the machine parsing it.
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

/**
 * The environment block `CreateProcessW` wants: `K=V\0K=V\0\0`, UTF-16LE.
 *
 * A `Record` is not that shape, and the difference is not cosmetic: a block
 * that is not double-NUL-terminated leaves the CRT reading past the end, and
 * one that is not UTF-16 is read as garbage the first time a child looks up
 * `PATH`. `wbuf` supplies the UTF-16 conversion and the final terminator, so
 * what is left is the `K=V` entries joined with NULs.
 *
 * Entries the format cannot carry are dropped rather than thrown: a key naming
 * `=` or NUL would parse as two variables, and a value with NUL would truncate
 * the block for everything after it. An environment variable cannot contain
 * those characters on Windows anyway, so what is being skipped is malformed
 * input rather than a real setting.
 *
 * **One name is load-bearing, measured, and the measurement is strange enough
 * to record in full.** A confined spawn whose block omits `LOCALAPPDATA` fails
 * with 203 (ERROR_INVALID_FUNCTION) before any command runs — with or without
 * a `cwd`, with a quoted or unquoted command line, with a 1-entry or a 93-entry
 * block. Of all 94 variables in a real environment, adding `LOCALAPPDATA` is
 * the only one that fixes it, and the *value* is irrelevant: a path that does
 * not exist works, `C:\Windows\System32` works, and renaming the variable
 * while keeping the value fails. `APPDATA` and `USERPROFILE`, the two nearest
 * siblings, do nothing. The name is what the confined child resolves. The
 * production path always spreads `process.env` and so is safe by accident;
 * a caller building a minimal block has to name it, and
 * `sandbox-wiring.test.ts` asserts the resolved form so the accident stays
 * load-bearing.
 */
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
/**
 * The poll slice while waiting for the child: short enough that an abort's
 * latency stays imperceptible, long enough that a fast command does not spin
 * the loop.
 */
const POLL_MS = 25;

const EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
/**
 * Reads `lpEnvironment` as UTF-16, which is the form `confinedEnvBlock`
 * writes.
 *
 * **Measured, and the failure is quietly catastrophic.** Without this bit the
 * kernel reads the same bytes through the ANSI code page instead: a wide
 * environment block is then a stream of interleaved NULs to it, the child's
 * CRT init fails, and `CreateProcessW` returns 203
 * (ERROR_INVALID_FUNCTION) for *every* command — with or without `cwd`, with
 * an empty block or a 94-entry one. The two shapes were bisected apart
 * precisely because a wrong answer here looks like a quoting bug or a PATH
 * bug rather than a flag.
 */
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

/**
 * SECURITY_CAPABILITY_INTERNET_CLIENT `1` — Winnt.h:10748.
 *
 * The value that grants the container outbound network. NOT 85: that is the
 * `WinCapabilityInternetClientSid` **CreateWellKnownSid enum ordinal** — a
 * different namespace that happens to describe the same capability. Allocating
 * with 85 produces a structurally valid SID that grants nothing, and the first
 * capability probe burned a full run on that confusion (loopback timeouts and
 * DNS failure with "network-capable" children) before the SDK header settled
 * which number was which.
 */
const CAPABILITY_INTERNET_CLIENT = 1;

/** SE_GROUP_ENABLED — the attributes word a capability carries in SECURITY_CAPABILITIES. */
const SE_GROUP_ENABLED = 4;

/**
 * The capability SID addresses, kept alive for the life of the process.
 *
 * A SID_AND_ATTRIBUTES entry holds a raw pointer to the SID bytes, so an
 * allocation freed (or collected) under a live SECURITY_CAPABILITIES struct is
 * a wild pointer the kernel follows during process creation. Two capabilities
 * allocated once and cached is cheaper than reasoning about lifetimes at every
 * spawn.
 */
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

/**
 * Build `{ SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES[] }` for an app SID plus
 * capabilities.
 *
 * Layout, x64: SECURITY_CAPABILITIES is 24 bytes (app SID at 0, capabilities
 * pointer at 8, count at 16, reserved at 20); each SID_AND_ATTRIBUTES is 16
 * bytes (SID pointer at 0, attributes at 8). With no capabilities the pointer
 * is NULL and the count zero — never the address of a zero-length buffer,
 * which is what the empty-buffer path would hand the kernel.
 *
 * The returned buffers must stay referenced until `CreateProcessW` returns:
 * the kernel reads them during creation.
 */
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

/**
 * The profile name for a workspace: `labunbun-<16 hex of the canonical path>`.
 *
 * Deterministic on purpose. The SID is derived from the name, and the SID is
 * what the ACL grant will name — so two runs that agree on the workspace must
 * agree on the profile, or the second run's grant would name a SID no process
 * can ever hold. The hash is of the lowercased absolute path (Windows paths
 * are case-insensitive, and `C:\Ws` and `c:\ws` are the same directory).
 *
 * The `labunbun-net-` variant is a separate name because capabilities are baked
 * into the profile at creation: creating a profile that already exists is a
 * no-op success whose capabilities parameter is ignored (measured), so the
 * mode has to be part of the name or the first creation decides the mode
 * forever. If a net profile was ever created without them on a machine, the fix
 * is to delete the profile and let it be recreated — which is recorded here so
 * the next person does not have to rediscover why.
 */
export function appContainerProfileName(workspace: string, network = false): string {
	// Backslash and forward slash are the same separator on Windows; two
	// spellings of one directory must not get two profiles.
	const normalized = workspace.toLowerCase().replace(/\\/g, "/");
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	return network ? `labunbun-net-${digest}` : `labunbun-${digest}`;
}

/**
 * Create the profile if this user does not have it yet, and derive its SID.
 *
 * Creating a profile that already exists fails with a pointer-size HRESULT
 * (`0x800700B7`, ERROR_ALREADY_EXISTS) — which is the success case for every
 * run after the first, so it is not an error here. The SID is derived either
 * way, because derivation never fails for a name this user owns.
 *
 * `network` selects the profile *and* its capability set. The capabilities are
 * baked at creation, and the creation call ignores them when the profile
 * already exists (measured: the ALREADY_EXISTS path never writes the output
 * SID either, which is why the derive follows) — so the name carrying the mode
 * is what keeps the first creation's capability set from being the permanent
 * answer for both modes.
 */
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

// ---- The ACL half: what lets the confined process touch the workspace ----

const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 0x00000004;
const PROTECTED_DACL_SECURITY_INFORMATION = 0x8000_0000;
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
	const daclAddr = Number(out[2]);
	if (daclAddr === 0) return null;
	const head = new DataView(memoryAt(daclAddr, 8));
	const used = head.getUint16(2, true);
	return new Uint8Array(memoryAt(daclAddr, used));
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
	return wideStringAt(Number(strOut[0]));
}

/**
 * A new DACL holding these ACEs.
 *
 * The header is {revision, sbz1, AclSize, AceCount, sbz2}: AceCount is the
 * number of ACEs, NOT the byte length — writing the length there is a
 * malformed ACL, and the malformation shows up as protection that silently
 * does not apply rather than as an error.
 */
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

function writeDacl(path: string, dacl: Uint8Array, protect: boolean): string | null {
	const lib = advapi();
	if (lib === null) return "advapi32 is not loadable";
	const info = DACL_SECURITY_INFORMATION | (protect ? PROTECTED_DACL_SECURITY_INFORMATION : 0);
	const code = lib.symbols.SetNamedSecurityInfoW(ptr(wbuf(path)), SE_FILE_OBJECT, info, null, null, ptr(dacl), null);
	if (code !== 0) return `SetNamedSecurityInfoW on ${path} failed (${code})`;
	return null;
}

/** Grants read+write on this root and everything under it, to this SID. */
export function grantRootAccess(path: string, sid: Uint8Array): string | null {
	const existing = readDacl(path);
	// A NULL DACL grants everyone everything, so writing one would be an
	// escalation: refuse rather than guess.
	if (existing === null) return `${path} carries no DACL to extend`;
	if (acesOf(existing).some((ace) => aceSidString(ace) === sidStringOf(sid))) return null; // already granted
	const aces = acesOf(existing);
	aces.push(allowAce(sid, FILE_ALL_ACCESS));
	return writeDacl(path, buildDacl(aces), false);
}

export function dropAcesFor(path: string, sid: Uint8Array): string | null {
	const existing = readDacl(path);
	if (existing === null) return null; // nothing to clean
	const kept = acesOf(existing).filter((ace) => aceSidString(ace) !== sidStringOf(sid));
	if (kept.length === acesOf(existing).length) return null;
	return writeDacl(path, buildDacl(kept), false);
}

function sidStringOf(sid: Uint8Array): string | null {
	const conv = advapi();
	if (conv === null) return null;
	// The bytes travel through the same pointer FFI accepts: the address of
	// the buffer holding them.
	const strOut = new BigUint64Array(1);
	if (conv.symbols.ConvertSidToStringSidW(ptr(sid) as unknown as Pointer, strOut) === 0) return null;
	return wideStringAt(Number(strOut[0]));
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

/**
 * Run one command line inside this profile, streaming its output.
 *
 * The command's stdout/stderr arrive on anonymous pipes — the shape the Bash
 * tool needs (captured output with a live preview, not an inherited console),
 * and it is why the spawner lives here rather than being a `Bun.spawn` the
 * caller could have done itself: `Bun.spawn` cannot attach the
 * security-capabilities attribute to the child it creates. Chunks are decoded
 * incrementally, so a multi-byte character split across two reads arrives
 * whole rather than as a replacement character.
 *
 * An abort signal or a timeout kills the child; either way the result reports
 * `killed`. On failure the result says which call failed and with what error
 * code, because every failure mode here is a number a reader can act on.
 */
export function runConfined(
	profile: AppContainerProfile,
	commandLine: string,
	options: ConfinedRunOptions = {},
): ConfinedRunResult {
	const lib = kernel32();
	if (lib === null) return ffFailure("kernel32 FFI is unavailable");
	{
		const sid = deriveAppContainerSid(profile.name);
		if (sid === null) return ffFailure(`no profile named ${profile.name} exists for this user`);
	}
	const sidAddr = sidAddressFor(profile.name);
	if (sidAddr === null) return ffFailure(`no profile named ${profile.name} exists for this user`);

	// The capability list the spawn's SECURITY_CAPABILITIES carries. The
	// profile's baked-in capability would be enough on its own for a profile
	// created with it, but the spawn-time struct is what the kernel actually
	// reads for the token, so a net profile passes the same list here — a
	// mismatch (net profile, empty caps) would be a network-less child under a
	// profile that says otherwise.
	const spawnRids = profile.network ? [CAPABILITY_INTERNET_CLIENT] : [];
	return runConfinedWithSid(sidAddr, commandLine, options, spawnRids);
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
	spawnRids: readonly number[] = [],
): ConfinedRunResult {
	const lib = kernel32();
	if (lib === null) return ffFailure("kernel32 FFI is unavailable");

	// SECURITY_CAPABILITIES { AppContainerSid, Capabilities, Count, Reserved }.
	// The capabilities and their array must stay referenced until CreateProcessW
	// returns — the kernel reads both during creation — which is why they are
	// locals held across the whole function rather than temporaries in the
	// argument list. `attrs` is deliberately unused: the kernel reaches the
	// SID_AND_ATTRIBUTES array through the pointer inside `caps`, so keeping
	// the JS reference is the whole job (a GC'd array under a live pointer is
	// a wild read), and the linter's "unused" is exactly the lifetime pin.
	const { caps, attrs } = buildSecurityCapabilities(sidAddr, spawnRids);
	void attrs;

	const sizeOut = new BigUint64Array(1);
	// Two attributes, not one: the container capabilities, and — because the
	// child must inherit its std handles — a handle list that lets exactly
	// those through. A plain `bInheritHandles: TRUE` without the list hands
	// the sandbox every inheritable handle this process holds.
	const attrCount = 2;
	lib.symbols.InitializeProcThreadAttributeList(null, attrCount, 0, sizeOut);
	const attrList = new Uint8Array(Number(sizeOut[0]));
	if (lib.symbols.InitializeProcThreadAttributeList(ptr(attrList), attrCount, 0, sizeOut) === 0) {
		return ffFailure(`InitializeProcThreadAttributeList failed (${lib.symbols.GetLastError()})`);
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
		return ffFailure(`UpdateProcThreadAttribute(capabilities) failed (${lib.symbols.GetLastError()})`);
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
		return ffFailure(`CreatePipe(stdin) failed (${lib.symbols.GetLastError()})`);
	}
	if (lib.symbols.CreatePipe(outRead, outWrite, ptr(inheritable), 0) === 0) {
		lib.symbols.CloseHandle(inRead[0]);
		lib.symbols.CloseHandle(inWrite[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return ffFailure(`CreatePipe(stdout) failed (${lib.symbols.GetLastError()})`);
	}
	if (lib.symbols.CreatePipe(errRead, errWrite, ptr(inheritable), 0) === 0) {
		lib.symbols.CloseHandle(inRead[0]);
		lib.symbols.CloseHandle(inWrite[0]);
		lib.symbols.CloseHandle(outRead[0]);
		lib.symbols.CloseHandle(outWrite[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return ffFailure(`CreatePipe(stderr) failed (${lib.symbols.GetLastError()})`);
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
		return ffFailure(`UpdateProcThreadAttribute(handles) failed (${lib.symbols.GetLastError()})`);
	}

	// STARTUPINFOEX on x64: 104 bytes of STARTUPINFO (dwFlags at 60, the three
	// std handles at 80/88/96 — writing them anywhere else hands the kernel
	// garbage handles and it faults), then lpAttributeList at 104.
	//
	// lpDesktop (offset 16) is the interactive desktop, named explicitly: a
	// restricted-token child that inherits its parent's desktop instead dies
	// in CRT init with STATUS_DLL_INIT_FAILED (0xC0000142). Codex's
	// windows-sandbox does the same for the same reason
	// (command_runner/win.rs: "Some processes can fail with
	// STATUS_DLL_INIT_FAILED if lpDesktop is not set when launching with a
	// restricted token").
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
	// would wait for a writer that is already gone.
	lib.symbols.CloseHandle(outWrite[0]);
	lib.symbols.CloseHandle(errWrite[0]);
	if (spawned === 0) {
		const err = lib.symbols.GetLastError();
		lib.symbols.CloseHandle(outRead[0]);
		lib.symbols.CloseHandle(errRead[0]);
		lib.symbols.DeleteProcThreadAttributeList(attrAddr);
		return ffFailure(`CreateProcessW failed (${err})`);
	}

	const timeoutMs = options.timeoutMs ?? 600_000;
	const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
	const decoderOut = new StringDecoder("utf8");
	const decoderErr = new StringDecoder("utf8");
	const outChunks: string[] = [];
	const errChunks: string[] = [];
	const pumpOut = (): { eof: boolean; text: boolean } =>
		pumpPipe(lib, outRead[0], decoderOut, outChunks, options.onStdout);
	const pumpErr = (): { eof: boolean; text: boolean } =>
		pumpPipe(lib, errRead[0], decoderErr, errChunks, options.onStderr);

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
	lib.symbols.CloseHandle(outRead[0]);
	lib.symbols.CloseHandle(errRead[0]);
	lib.symbols.DeleteProcThreadAttributeList(attrAddr);
	return {
		exitCode: exit[0],
		stdout: outChunks.join(""),
		stderr: errChunks.join(""),
		killed: waitError !== undefined,
		...(waitError !== undefined ? { error: waitError } : {}),
	};
}

/**
 * One non-blocking round of a pipe: everything currently buffered comes out,
 * decoded, and emitted. Reports whether the pipe reached EOF (a broken pipe —
 * every writer closed) and whether this round produced any text.
 *
 * Peek before every read: `ReadFile` on a synchronous pipe blocks until data
 * or EOF, and `PeekNamedPipe` is what tells the two apart without blocking.
 * Its 5th parameter is the one that answers — lpTotalBytesAvail; the 6th is
 * bytes-left-in-this-message, which is zero for a byte stream and reads as
 * "no data" forever.
 */
function pumpPipe(
	lib: NonNullable<ReturnType<typeof kernel32>>,
	handle: bigint,
	decoder: StringDecoder,
	sink: string[],
	onText: ((chunk: string) => void) | undefined,
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
			sink.push(chunk);
			onText?.(chunk);
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
	 * Every root this grant wrote an ACE on, the workspace first.
	 *
	 * Recorded because the release has to remove exactly what the acquire
	 * added: dropping only the workspace would leave write ACEs on the temp
	 * directory and the caches — a grant that outlives the command that asked
	 * for it, which is a widening rather than a leak.
	 */
	roots: string[];
}

const activeGrants = new Map<string, ActiveGrant>();

/**
 * The one spelling of a root every reader agrees on: symlinks, junctions,
 * `\\?\` prefixes and 8.3 short names all resolved, so an ACE written here
 * covers a child however it spells the same directory. Best-effort — a path
 * that cannot be resolved is returned as spelled, because a grant that
 * refuses over an unreadable parent would fail closed for no gain.
 */
function canonicalGrantPath(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return root;
	}
}

export interface GrantOutcome {
	profile?: AppContainerProfile;
	error?: string;
}

/**
 * Grants the container SID write access to this workspace — and to any extra
 * writable roots a real session names — with a refcount.
 *
 * The refcount is per profile and per process: two commands running at once
 * share one grant, and the grant is released only by the last. The key is the
 * profile name rather than the workspace because a workspace now has two
 * profiles — offline and network-capable — with two SIDs, and a grant that
 * named the wrong one would be an ACE for an identity no child ever runs as.
 *
 * `extraRoots` is what the resolver's `grantRoots` carries beyond the
 * workspace. A real session's policy names the temp directory and the home
 * package caches beside the workspace, and a container granted only the
 * workspace cannot `mktemp` and cannot write its install cache — so a caller
 * that resolves through `resolveSandboxExecution` passes the whole list, not
 * just the entry the profile is derived from.
 *
 * A crash leaves the ACEs on disk — a later round sweeps those from the state
 * file this records, and until then they name the same SID the next run
 * derives again, so a leftover grant is reusable rather than dangerous.
 */
export function acquireWorkspaceGrant(
	workspace: string,
	network = false,
	extraRoots: readonly string[] = [],
): GrantOutcome {
	const profile = ensureAppContainerProfile(workspace, network);
	if ("error" in profile) return { error: profile.error };
	const existing = activeGrants.get(profile.name);
	if (existing !== undefined) {
		existing.refs += 1;
		return { profile };
	}
	const sid = sidBytesFor(profile.name);
	if (sid === null) {
		return { profile, error: `the profile for ${workspace} has no readable SID` };
	}
	// The workspace first, then the roots the policy adds. Every root is
	// granted or none is: a half-grant leaves a command that can write its
	// workspace but not its cache, which is the narrower-than-asked failure
	// this repository already fixed once in `policyFor` — and here it would be
	// worse, because the first write that misses is the one that fails.
	//
	// Each root is canonicalised before the ACE is written, and the reason is
	// a measured failure on the GitHub Windows runner rather than tidiness:
	// that machine's `TEMP` is spelled with the 8.3 short name
	// (`C:\Users\RUNNER~1\AppData\Local\Temp`), and an ACE written against the
	// short spelling does not cover a child that opens the same directory by
	// another spelling — the confined powershell died with .NET's
	// `Access to the path 'C:\Users\RUNNER~1\AppData\Local\Temp\lbb-…' is
	// denied` while the write-test shell under the same policy succeeded,
	// because the two children resolved the path differently. `realpathSync`
	// resolves short names, `\\?\` prefixes and junctions to the one spelling
	// the kernel checks, so the ACE lands where every reader finds it. A path
	// that cannot be resolved is granted as spelled: resolving is best-effort
	// and the grant failing closed covers the rest.
	const roots = [workspace, ...extraRoots.filter((root) => root !== workspace)].map(canonicalGrantPath);
	for (const root of roots) {
		const grantError = grantRootAccess(root, sid);
		if (grantError !== null) {
			// Fail closed on the write boundary that matters: a command that runs
			// with no grant cannot touch the workspace, which is a legible failure
			// rather than an unconfined one.
			return { profile, error: grantError };
		}
	}
	activeGrants.set(profile.name, { sid, refs: 1, roots });
	return { profile };
}

/** Drops one reference, and on the last one removes every ACE this grant added. */
export function releaseWorkspaceGrant(workspace: string, network = false): string | null {
	const grant = activeGrants.get(appContainerProfileName(workspace, network));
	if (grant === undefined) return null;
	grant.refs -= 1;
	if (grant.refs > 0) return null;
	activeGrants.delete(appContainerProfileName(workspace, network));
	// Every root, not just the workspace — see `ActiveGrant.roots` for why.
	let firstError: string | null = null;
	for (const root of grant.roots) {
		const dropError = dropAcesFor(root, grant.sid);
		if (dropError !== null && firstError === null) firstError = dropError;
	}
	return firstError;
}

/** The SID bytes of a profile name, through the same derivation the profile uses. */
function sidBytesFor(name: string): Uint8Array | null {
	const lib = userenv();
	const conv = advapi();
	if (lib === null || conv === null) return null;
	const sidOut = new BigUint64Array(1);
	if (lib.symbols.DeriveAppContainerSidFromAppContainerName(ptr(wbuf(name)), sidOut) !== 0) return null;
	return sidBytes(Number(sidOut[0]));
}
