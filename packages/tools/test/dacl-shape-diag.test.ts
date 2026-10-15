/**
 * DIAGNOSTIC — branch only, not for main.
 *
 * A GitHub windows-2025 runner (CI 38783812239) fails three S6 assertions:
 * the fixture born under %LOCALAPPDATA%\Temp carries three rows
 * {SYSTEM, Administrators, the user} flagged (OI)(CI)(F), no (I) — and after
 * an acquire/release cycle, and after an acquire rollback, the same rows read
 * back (I)(OI)(CI)(F). This machine never reproduces it: children born under
 * its Temp carry (I)-marked rows from the start, so the local suite walks a
 * different geometry entirely and its green says nothing.
 *
 * This file dumps the byte-level DACL — control word, and per ACE the flags
 * byte, mask and SID — plus the icacls text at every phase, so one CI run
 * answers: what did the runner's birth actually store; what does a raw
 * SetFileSecurityW write keep on that kernel; and, walking the release and
 * rollback sequences primitive by primitive, which write adds the (I) mark
 * that the final raw replay is supposed to remove.
 */

import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
	acesOf,
	acquireWorkspaceGrant,
	allowAce,
	appContainerProfileName,
	buildDacl,
	canonicalPathForChild,
	deleteAppContainerProfile,
	dropAcesFor,
	ensureAppContainerProfile,
	protectDirForGrant,
	readDacl,
	releaseWorkspaceGrant,
	sidBytesFor,
	writeDacl,
	writeDaclProtection,
} from "../src/sandbox/appcontainer.ts";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

const advapi = dlopen("advapi32.dll", {
	ConvertSidToStringSidW: { args: ["ptr", "ptr"], returns: "i32" },
	ConvertStringSidToSidW: { args: ["ptr", "ptr"], returns: "i32" },
	GetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
	GetSecurityInfo: { args: ["u64", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
	SetFileSecurityW: { args: ["ptr", "u32", "ptr"], returns: "i32" },
});
const kernel32 = dlopen("kernel32.dll", {
	GetLastError: { args: [], returns: "u32" },
	LocalFree: { args: ["u64"], returns: "u64" },
	CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
	CloseHandle: { args: ["u64"], returns: "i32" },
});
const ntdll = dlopen("ntdll.dll", {
	NtQuerySecurityObject: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
});

const READ_CONTROL = 0x00020000;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const INVALID_HANDLE = 0xffffffffffffffffn;

function wbuf(s: string): Uint16Array {
	const b = new Uint16Array(s.length + 1);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
	return b;
}

// The same bridge the module under test uses: the runtime accepts an address
// where the typings accept only buffer-like arguments.
function memoryAt(address: number, maxBytes: number): ArrayBuffer {
	return toArrayBuffer(address, 0, maxBytes);
}

function wideStringAt(address: number): string {
	let out = "";
	for (let offset = 0; offset < 512; offset += 2) {
		const code = new DataView(memoryAt(address + offset, 2)).getUint16(0, true);
		if (code === 0) break;
		out += String.fromCharCode(code);
	}
	return out;
}

/** The byte-level reading of a path's DACL: control word plus one line per ACE. */
function readBytes(path: string): string {
	const ppDacl = new BigUint64Array(1);
	const ppSd = new BigUint64Array(1);
	const code = advapi.symbols.GetNamedSecurityInfoW(
		ptr(wbuf(path)),
		1 /* SE_FILE_OBJECT */,
		4 /* DACL_SECURITY_INFORMATION */,
		null,
		null,
		ptr(ppDacl),
		null,
		ptr(ppSd),
	);
	if (code !== 0) return `GetNamedSecurityInfoW failed (${code})`;
	const sd = Number(ppSd[0]);
	const control = new DataView(memoryAt(sd + 2, 2)).getUint16(0, true);
	const dacl = Number(ppDacl[0]);
	const count = new DataView(memoryAt(dacl, 8)).getUint16(4, true);
	const parts: string[] = [];
	let off = 8;
	for (let i = 0; i < count; i++) {
		const head = new DataView(memoryAt(dacl + off, 8));
		const size = head.getUint16(2, true);
		const strOut = new BigUint64Array(1);
		let sid = "?";
		if (advapi.symbols.ConvertSidToStringSidW(ptr(memoryAt(dacl + off + 8, 68)), ptr(strOut)) !== 0) {
			sid = wideStringAt(Number(strOut[0]));
			kernel32.symbols.LocalFree(strOut[0]);
		}
		parts.push(`flags=0x${head.getUint8(1).toString(16)} mask=0x${head.getUint32(4, true).toString(16)} ${sid}`);
		off += size;
	}
	kernel32.symbols.LocalFree(ppSd[0]);
	return `control=0x${control.toString(16)} | ${parts.join(" | ")}`;
}

function sidBytes(str: string): Uint8Array {
	const out = new BigUint64Array(1);
	if (advapi.symbols.ConvertStringSidToSidW(ptr(wbuf(str)), ptr(out)) === 0)
		throw new Error(`SID ${str} did not convert`);
	const sid = Number(out[0]);
	const len = 8 + 4 * new Uint8Array(memoryAt(sid, 2))[1];
	const bytes = new Uint8Array(memoryAt(sid, len)).slice();
	kernel32.symbols.LocalFree(out[0]);
	return bytes;
}

/** The raw writer with the control word under test. */
function rawWrite(path: string, control: number, aces: Uint8Array[]): void {
	const dacl = buildDacl(aces);
	const sd = new Uint8Array(20 + dacl.length);
	const view = new DataView(sd.buffer);
	view.setUint8(0, 1); // SECURITY_DESCRIPTOR_REVISION
	view.setUint16(2, control, true);
	view.setUint32(16, 20, true);
	sd.set(dacl, 20);
	if (advapi.symbols.SetFileSecurityW(ptr(wbuf(path)), 4, ptr(sd)) === 0) {
		throw new Error(`SetFileSecurityW on ${path} failed (${kernel32.symbols.GetLastError()})`);
	}
}

const icaclsOf = (path: string): string => execSync(`icacls "${path}"`, { encoding: "utf8" });

function dump(label: string, path: string): void {
	console.log(`DIAG ${label} path=${path}`);
	console.log(`DIAG ${label} bytes: ${readBytes(path)}`);
	try {
		console.log(`DIAG ${label} icacls: ${icaclsOf(path).trim().split(/\r?\n/).join(" ;; ")}`);
	} catch {
		console.log(`DIAG ${label} icacls: <failed>`);
	}
}

// ---- round 2: does a raw (handle-based) reader exist, and which final write restores birth's display ----

/** The named reader's control word alone — the strip decision in the fix simulations keys on it. */
function namedControl(path: string): number {
	const ppDacl = new BigUint64Array(1);
	const ppSd = new BigUint64Array(1);
	const code = advapi.symbols.GetNamedSecurityInfoW(
		ptr(wbuf(path)),
		1 /* SE_FILE_OBJECT */,
		4 /* DACL_SECURITY_INFORMATION */,
		null,
		null,
		ptr(ppDacl),
		null,
		ptr(ppSd),
	);
	if (code !== 0) return -1;
	const control = new DataView(memoryAt(Number(ppSd[0]) + 2, 2)).getUint16(0, true);
	kernel32.symbols.LocalFree(ppSd[0]);
	return control;
}

/** The same one-line rendering readBytes uses, over already-parsed ACE slices. */
function formatAces(control: number, aces: Uint8Array[]): string {
	const parts = aces.map((ace) => {
		const view = new DataView(ace.buffer, ace.byteOffset, ace.byteLength);
		const strOut = new BigUint64Array(1);
		let sid = "?";
		if (advapi.symbols.ConvertSidToStringSidW(ptr(ace.slice(8)), ptr(strOut)) !== 0) {
			sid = wideStringAt(Number(strOut[0]));
			kernel32.symbols.LocalFree(strOut[0]);
		}
		return `flags=0x${view.getUint8(1).toString(16)} mask=0x${view.getUint32(4, true).toString(16)} ${sid}`;
	});
	return `control=0x${control.toString(16)} | ${parts.join(" | ")}`;
}

/** The handle-based raw read: CreateFileW + GetSecurityInfo, the query icacls itself is built on. */
function daclRawRead(path: string): { control: number; aces: Uint8Array[] } | string {
	const handle = kernel32.symbols.CreateFileW(
		ptr(wbuf(path)),
		READ_CONTROL,
		FILE_SHARE_ALL,
		null,
		OPEN_EXISTING,
		FILE_FLAG_BACKUP_SEMANTICS,
		null,
	);
	if (handle === INVALID_HANDLE || handle === 0n) return `CreateFileW failed (${kernel32.symbols.GetLastError()})`;
	const ppDacl = new BigUint64Array(1);
	const ppSd = new BigUint64Array(1);
	const code = advapi.symbols.GetSecurityInfo(
		handle,
		1 /* SE_FILE_OBJECT */,
		4,
		null,
		null,
		ptr(ppDacl),
		null,
		ptr(ppSd),
	);
	if (code !== 0) {
		kernel32.symbols.CloseHandle(handle);
		return `GetSecurityInfo failed (${code})`;
	}
	const sd = Number(ppSd[0]);
	const control = new DataView(memoryAt(sd + 2, 2)).getUint16(0, true);
	const dacl = Number(ppDacl[0]);
	const aces: Uint8Array[] = [];
	if (dacl !== 0) {
		const count = new DataView(memoryAt(dacl, 8)).getUint16(4, true);
		let off = 8;
		for (let i = 0; i < count; i++) {
			const size = new DataView(memoryAt(dacl + off, 4)).getUint16(2, true);
			aces.push(new Uint8Array(memoryAt(dacl + off, size)).slice());
			off += size;
		}
	}
	kernel32.symbols.LocalFree(ppSd[0]);
	kernel32.symbols.CloseHandle(handle);
	return { control, aces };
}

/** The lowest-level query, straight off ntdll: NtQuerySecurityObject over the same handle. */
function readBytesNtQS(path: string): string {
	const handle = kernel32.symbols.CreateFileW(
		ptr(wbuf(path)),
		READ_CONTROL,
		FILE_SHARE_ALL,
		null,
		OPEN_EXISTING,
		FILE_FLAG_BACKUP_SEMANTICS,
		null,
	);
	if (handle === INVALID_HANDLE || handle === 0n) return `CreateFileW failed (${kernel32.symbols.GetLastError()})`;
	const buf = new Uint8Array(4096);
	const needed = new Uint32Array(1);
	const status = ntdll.symbols.NtQuerySecurityObject(handle, 4, ptr(buf), buf.length, ptr(needed));
	kernel32.symbols.CloseHandle(handle);
	if (status >>> 0 !== 0) return `NtQuerySecurityObject status=0x${(status >>> 0).toString(16)}`;
	const control = new DataView(buf.buffer).getUint16(2, true);
	const daclOff = new DataView(buf.buffer).getUint32(16, true);
	if (daclOff === 0) return `control=0x${control.toString(16)} | <no DACL>`;
	const count = new DataView(buf.buffer).getUint16(daclOff + 4, true);
	const parts: string[] = [];
	let off = daclOff + 8;
	for (let i = 0; i < count; i++) {
		const view = new DataView(buf.buffer, off, 8);
		const size = view.getUint16(2, true);
		const strOut = new BigUint64Array(1);
		let sid = "?";
		if (advapi.symbols.ConvertSidToStringSidW(ptr(buf.slice(off + 8, off + size)), ptr(strOut)) !== 0) {
			sid = wideStringAt(Number(strOut[0]));
			kernel32.symbols.LocalFree(strOut[0]);
		}
		parts.push(`flags=0x${view.getUint8(1).toString(16)} mask=0x${view.getUint32(4, true).toString(16)} ${sid}`);
		off += size;
	}
	return `control=0x${control.toString(16)} | ${parts.join(" | ")}`;
}

/** All four readers of one path, plus the icacls text the failing tests compare. */
function dump4(label: string, path: string): void {
	console.log(`DIAG ${label} named: ${readBytes(path)}`);
	const raw = daclRawRead(path);
	console.log(`DIAG ${label} raw: ${typeof raw === "string" ? raw : formatAces(raw.control, raw.aces)}`);
	console.log(`DIAG ${label} ntqs: ${readBytesNtQS(path)}`);
	try {
		console.log(`DIAG ${label} icacls: ${icaclsOf(path).trim().split(/\r?\n/).join(" ;; ")}`);
	} catch {
		console.log(`DIAG ${label} icacls: <failed>`);
	}
}

const FILE_ALL_ACCESS = 0x001f01ff;

describeWindows("DIAGNOSTIC: the DACL shapes of the S6 fixture", () => {
	test("every phase, byte for byte", () => {
		const base = `${process.env.LOCALAPPDATA}\\Temp`;
		const ws = `${base}\\ac-diag-ws-${process.pid}`;
		const gitDir = `${ws}\\.git`;
		const outside = `${base}\\ac-diag-outside-${process.pid}`;
		const forges = [0x8004, 0x8404, 0x9004].map((control) => ({
			control,
			path: `${base}\\ac-diag-forge-${control.toString(16)}-${process.pid}`,
		}));
		const cleanup = (): void => {
			execSync(`cmd /c if exist "${ws}" rmdir /s /q "${ws}"`, { stdio: "ignore" });
			execSync(`cmd /c if exist "${outside}" rmdir /s /q "${outside}"`, { stdio: "ignore" });
			for (const forge of forges)
				execSync(`cmd /c if exist "${forge.path}" rmdir /s /q "${forge.path}"`, { stdio: "ignore" });
		};
		const refresh = (): void => {
			execSync(`cmd /c if exist "${ws}" rmdir /s /q "${ws}"`, { stdio: "ignore" });
			execSync(`cmd /c mkdir "${gitDir}"`, { stdio: "ignore" });
			writeFileSync(`${gitDir}\\config`, "[core]\n");
		};
		try {
			// ---- the ancestry, so the runner's geometry chain is on record ----
			const userSid = execSync("C:\\Windows\\System32\\whoami.exe /user", { encoding: "utf8" }).match(
				/S-1-5-21-[\d-]+/,
			)?.[0];
			if (userSid === undefined) throw new Error("no user SID");
			const rows = [
				allowAce(sidBytes("S-1-5-18"), FILE_ALL_ACCESS),
				allowAce(sidBytes("S-1-5-32-544"), FILE_ALL_ACCESS),
				allowAce(sidBytes(userSid), FILE_ALL_ACCESS),
			];
			dump("ancestry-profile", process.env.USERPROFILE ?? "?");
			dump("ancestry-localappdata", process.env.LOCALAPPDATA ?? "?");
			dump("ancestry-temp", base);

			// ---- fixture A: the release sequence, primitive by primitive ----
			refresh();
			dump("a01-birth-ws", ws);
			dump("a02-birth-git", gitDir);
			const profile = ensureAppContainerProfile(ws);
			if ("error" in profile) throw new Error(profile.error);
			dump("a03-after-profile-git", gitDir);
			const beforeGitText = icaclsOf(gitDir);
			const beforeGitBytes = readBytes(gitDir);
			const birthGitDacl = readDacl(gitDir);
			if (birthGitDacl === null) throw new Error("no DACL to read");
			const birthGitAces = acesOf(birthGitDacl);
			const sid = sidBytesFor(profile.name);
			if (sid === null) throw new Error("no SID");
			const canonicalWs = canonicalPathForChild(ws);
			const canonicalGit = canonicalPathForChild(gitDir);

			const wsPrior = readDacl(canonicalWs);
			if (wsPrior === null) throw new Error("no ws DACL");
			console.log(
				`DIAG a10-grant-write err=${writeDacl(canonicalWs, buildDacl([...acesOf(wsPrior), allowAce(sid, FILE_ALL_ACCESS)]))}`,
			);
			dump("a11-after-grant-ws", ws);
			dump("a12-after-grant-git", gitDir);
			const pin = protectDirForGrant(canonicalGit, sid, [canonicalWs]);
			console.log(`DIAG a20-pin err=${pin.error ?? "none"}`);
			dump("a21-after-pin-git", gitDir);
			if (pin.restore !== undefined) {
				console.log(
					`DIAG a30-restore err=${writeDaclProtection(pin.restore.path, buildDacl(pin.restore.aces), false)}`,
				);
			}
			dump("a31-after-restore-git", gitDir);
			console.log(`DIAG a40-drop-git err=${dropAcesFor(canonicalGit, sid)}`);
			dump("a41-after-drop-git", gitDir);
			console.log(`DIAG a50-drop-ws err=${dropAcesFor(canonicalWs, sid)}`);
			dump("a51-after-drop-ws", ws);
			dump("a52-after-drop-ws-git", gitDir);
			// the fix's closing write: the as-found list through the raw writer
			console.log(`DIAG a60-replay err=${writeDaclProtection(canonicalGit, buildDacl(birthGitAces), false)}`);
			dump("a61-after-replay-git", gitDir);
			const afterReplayText = icaclsOf(gitDir);
			console.log(`DIAG a62 text_eq_before=${afterReplayText === beforeGitText}`);
			console.log(`DIAG a63 bytes_eq_before=${readBytes(gitDir) === beforeGitBytes}`);
			deleteAppContainerProfile(appContainerProfileName(ws));

			// ---- fixture B: the real acquire/release, as the failing test runs it ----
			refresh();
			const beforeB = icaclsOf(gitDir);
			const grantB = acquireWorkspaceGrant(ws, false, [], [], [gitDir]);
			console.log(`DIAG b01-acquire err=${grantB.error ?? "none"}`);
			dump("b02-after-acquire-git", gitDir);
			dump("b03-after-acquire-ws", ws);
			console.log(`DIAG b04-release err=${releaseWorkspaceGrant(ws, false) ?? "none"}`);
			dump("b05-after-release-git", gitDir);
			dump("b06-after-release-ws", ws);
			console.log(`DIAG b07 text_eq_before=${icaclsOf(gitDir) === beforeB}`);
			deleteAppContainerProfile(appContainerProfileName(ws));

			// ---- fixture C: the rollback path the third failing test walks ----
			refresh();
			execSync(`cmd /c mkdir "${outside}"`, { stdio: "ignore" });
			const beforeC = icaclsOf(ws);
			const grantC = acquireWorkspaceGrant(ws, false, [], [], [outside]);
			console.log(`DIAG c01-acquire err=${grantC.error ?? "none"}`);
			dump("c02-after-failed-ws", ws);
			console.log(`DIAG c03 text_eq_before=${icaclsOf(ws) === beforeC}`);
			deleteAppContainerProfile(appContainerProfileName(ws));

			// ---- the forges: what does a raw write keep on this kernel? ----
			for (const forge of forges) {
				execSync(`cmd /c mkdir "${forge.path}"`, { stdio: "ignore" });
				rawWrite(forge.path, forge.control, rows);
				const written = `control=0x${forge.control.toString(16)}`;
				const readBack = readBytes(forge.path);
				console.log(`DIAG f-${forge.control.toString(16)} wrote ${written}; read ${readBack}`);
				dump(`f-${forge.control.toString(16)}-icacls`, forge.path);
			}
		} finally {
			cleanup();
		}
		expect(true).toBe(true);
	}, 120_000);

	// Round 2 answers the question round 1 left open: the named reader returned
	// 0x13-flagged rows for states whose icacls text carries no (I), and the two
	// readings cannot both describe one stored DACL. Either a raw (handle-based)
	// reader disagrees with the named one — and the fix is to capture and replay
	// through it — or every reader agrees and the stored flags themselves were
	// rewritten, and the fix is to strip the phantom INHERITED bits that a
	// legacy (no SE_DACL_AUTO_INHERITED) snapshot carries when replaying. The
	// write matrix widens round 1's three forges to control x row-flags, and
	// the two simulations at the end of a real acquire/release — and of a real
	// rollback — measure exactly which final write makes icacls text equal the
	// birth text on this machine.
	test("round 2: raw readers, the write matrix, and two fix simulations", () => {
		const base = `${process.env.LOCALAPPDATA}\\Temp`;
		const ws = `${base}\\ac-diag2-ws-${process.pid}`;
		const gitDir = `${ws}\\.git`;
		const outside = `${base}\\ac-diag2-outside-${process.pid}`;
		const cleanup = (): void => {
			execSync(`cmd /c if exist "${ws}" rmdir /s /q "${ws}"`, { stdio: "ignore" });
			execSync(`cmd /c if exist "${outside}" rmdir /s /q "${outside}"`, { stdio: "ignore" });
		};
		const refresh = (): void => {
			execSync(`cmd /c if exist "${ws}" rmdir /s /q "${ws}"`, { stdio: "ignore" });
			execSync(`cmd /c mkdir "${gitDir}"`, { stdio: "ignore" });
			writeFileSync(`${gitDir}\\config`, "[core]\n");
		};
		try {
			const userSid = execSync("C:\\Windows\\System32\\whoami.exe /user", { encoding: "utf8" }).match(
				/S-1-5-21-[\d-]+/,
			)?.[0];
			if (userSid === undefined) throw new Error("no user SID");
			const rowsFor = (flags: number): Uint8Array[] =>
				[
					allowAce(sidBytes("S-1-5-18"), FILE_ALL_ACCESS),
					allowAce(sidBytes("S-1-5-32-544"), FILE_ALL_ACCESS),
					allowAce(sidBytes(userSid), FILE_ALL_ACCESS),
				].map((ace) => {
					ace[1] = flags;
					return ace;
				});

			// ---- do the readers disagree anywhere the store is known-raw? ----
			dump4("r2-ancestry-temp", base);

			// ---- the write matrix: four control words x two row-flag bytes ----
			for (const control of [0x8004, 0x8404, 0x9004, 0x9404]) {
				for (const flags of [0x03, 0x13]) {
					const forge = `${base}\\ac-diag2-forge-${control.toString(16)}-${flags.toString(16)}-${process.pid}`;
					execSync(`cmd /c mkdir "${forge}"`, { stdio: "ignore" });
					rawWrite(forge, control, rowsFor(flags));
					dump4(`r2-forge-${control.toString(16)}-${flags.toString(16)}`, forge);
					execSync(`cmd /c if exist "${forge}" rmdir /s /q "${forge}"`, { stdio: "ignore" });
				}
			}

			// ---- fixture B': birth, the real cycle, then the two replay candidates ----
			refresh();
			const beforeB = icaclsOf(gitDir);
			const birthDacl = readDacl(gitDir);
			const birthRows = birthDacl === null ? null : acesOf(birthDacl);
			const birthCtl = namedControl(gitDir);
			const birthRaw = daclRawRead(gitDir);
			console.log(
				`DIAG r2-b00-birth ctl=0x${birthCtl.toString(16)} raw=${typeof birthRaw === "string" ? birthRaw : formatAces(birthRaw.control, birthRaw.aces)}`,
			);
			const grantB = acquireWorkspaceGrant(ws, false, [], [], [gitDir]);
			console.log(`DIAG r2-b01-acquire err=${grantB.error ?? "none"}`);
			console.log(`DIAG r2-b04-release err=${releaseWorkspaceGrant(ws, false) ?? "none"}`);
			dump4("r2-b05-end-git", gitDir);
			console.log(`DIAG r2-b07-current text_eq_before=${icaclsOf(gitDir) === beforeB}`);
			if (birthRows !== null) {
				if (typeof birthRaw !== "string") {
					console.log(`DIAG r2-v1-write err=${writeDaclProtection(gitDir, buildDacl(birthRaw.aces), false)}`);
					console.log(`DIAG r2-v1 text_eq_before=${icaclsOf(gitDir) === beforeB}`);
					dump4("r2-v1-git", gitDir);
				} else {
					console.log(`DIAG r2-v1 skipped: ${birthRaw}`);
				}
				const strip = (birthCtl & 0x400) === 0;
				const v2rows = birthRows.map((ace) => {
					const copy = ace.slice();
					if (strip) copy[1] = copy[1] & ~0x10;
					return copy;
				});
				console.log(`DIAG r2-v2-decision ctl=0x${birthCtl.toString(16)} strip=${strip}`);
				console.log(`DIAG r2-v2-write err=${writeDaclProtection(gitDir, buildDacl(v2rows), false)}`);
				console.log(`DIAG r2-v2 text_eq_before=${icaclsOf(gitDir) === beforeB}`);
				dump4("r2-v2-git", gitDir);
			}
			deleteAppContainerProfile(appContainerProfileName(ws));

			// ---- fixture C': the rollback, both replays over the workspace ----
			refresh();
			execSync(`cmd /c mkdir "${outside}"`, { stdio: "ignore" });
			const beforeC = icaclsOf(ws);
			const birthWsDacl = readDacl(ws);
			const birthWsRows = birthWsDacl === null ? null : acesOf(birthWsDacl);
			const birthWsCtl = namedControl(ws);
			const birthWsRaw = daclRawRead(ws);
			console.log(
				`DIAG r2-c00-birth ctl=0x${birthWsCtl.toString(16)} raw=${typeof birthWsRaw === "string" ? birthWsRaw : formatAces(birthWsRaw.control, birthWsRaw.aces)}`,
			);
			const grantC = acquireWorkspaceGrant(ws, false, [], [], [outside]);
			console.log(`DIAG r2-c01-acquire err=${grantC.error ?? "none"}`);
			dump4("r2-c02-end-ws", ws);
			console.log(`DIAG r2-c03-current text_eq_before=${icaclsOf(ws) === beforeC}`);
			if (birthWsRows !== null) {
				if (typeof birthWsRaw !== "string") {
					console.log(`DIAG r2-cv1-write err=${writeDaclProtection(ws, buildDacl(birthWsRaw.aces), false)}`);
					console.log(`DIAG r2-cv1 text_eq_before=${icaclsOf(ws) === beforeC}`);
				} else {
					console.log(`DIAG r2-cv1 skipped: ${birthWsRaw}`);
				}
				const strip = (birthWsCtl & 0x400) === 0;
				const rows = birthWsRows.map((ace) => {
					const copy = ace.slice();
					if (strip) copy[1] = copy[1] & ~0x10;
					return copy;
				});
				console.log(`DIAG r2-cv2-decision ctl=0x${birthWsCtl.toString(16)} strip=${strip}`);
				console.log(`DIAG r2-cv2-write err=${writeDaclProtection(ws, buildDacl(rows), false)}`);
				console.log(`DIAG r2-cv2 text_eq_before=${icaclsOf(ws) === beforeC}`);
			}
			deleteAppContainerProfile(appContainerProfileName(ws));
		} finally {
			cleanup();
		}
		expect(true).toBe(true);
	}, 120_000);
});
