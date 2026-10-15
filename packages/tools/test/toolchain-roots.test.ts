/**
 * Which roots a toolchain occupies, and which of them a grant may name.
 *
 * These rows are the grant boundary of the AppContainer backend: the root a
 * program's install occupies becomes read+execute for the container, and the
 * refused roots (a drive, a share, the user profile) are the ones a wrong
 * answer would open too wide. The module implements Windows path semantics
 * literally, so every string row answers the same way on every host; only the
 * rows where the disk decides are gated to Windows.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
	detectExecutableRoots,
	installRootOf,
	pathCandidates,
	toolchainRootsFor,
} from "../src/sandbox/toolchain-roots.ts";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describe("installRootOf", () => {
	test("climbs through bin-class directories to the install root", () => {
		expect(installRootOf("D:\\Program Files\\Git\\mingw64\\bin\\git.exe")).toBe("D:\\Program Files\\Git");
		expect(installRootOf("C:\\Program Files\\Git\\cmd\\git.exe")).toBe("C:\\Program Files\\Git");
		expect(installRootOf("C:\\a\\BIN\\t.exe")).toBe("C:\\a");
		expect(installRootOf("D:/Program Files/Git/mingw64/bin/git.exe")).toBe("D:\\Program Files\\Git");
	});

	test("stops at the first ordinary directory", () => {
		// usr is not a bin-class name: the sibling shell stops below Git.
		expect(installRootOf("C:\\Program Files\\Git\\usr\\bin\\bash.exe")).toBe("C:\\Program Files\\Git\\usr");
		expect(installRootOf("C:\\Users\\x\\projects\\thing.exe")).toBe("C:\\Users\\x\\projects");
		expect(installRootOf("C:\\Users\\x\\.bun\\bin\\bun.exe")).toBe("C:\\Users\\x\\.bun");
	});

	test("null, empty, and non-absolute paths answer null", () => {
		expect(installRootOf(null)).toBeNull();
		expect(installRootOf(undefined)).toBeNull();
		expect(installRootOf("")).toBeNull();
		expect(installRootOf("bash.exe")).toBeNull();
		expect(installRootOf("tools\\thing.exe")).toBeNull();
	});
});

describe("toolchainRootsFor", () => {
	const home = "C:\\Users\\x";

	test("one root per install, first spelling wins", () => {
		expect(
			toolchainRootsFor(
				[
					"D:\\Program Files\\Git\\mingw64\\bin\\git.exe",
					"d:\\program files\\git\\cmd\\git.exe",
					"C:\\Users\\x\\.bun\\bin\\bun.exe",
				],
				{ home },
			),
		).toEqual(["D:\\Program Files\\Git", "C:\\Users\\x\\.bun"]);
	});

	test("unresolvable programs contribute nothing", () => {
		expect(toolchainRootsFor([null, undefined, "", "bash.exe", "tools\\thing.exe"], { home })).toEqual([]);
	});

	test("refuses drive roots, share roots, and the home tree", () => {
		expect(toolchainRootsFor(["C:\\bin\\x.exe"], { home })).toEqual([]);
		expect(toolchainRootsFor(["\\\\server\\share\\bin\\x.exe"], { home })).toEqual([]);
		expect(toolchainRootsFor(["C:\\Users\\x\\bin\\x.exe"], { home })).toEqual([]);
		expect(toolchainRootsFor(["C:\\Users\\bin\\x.exe"], { home })).toEqual([]);
	});

	test("a directory inside the home tree is a root like any other", () => {
		expect(toolchainRootsFor(["C:\\Users\\x\\.bun\\bin\\bun.exe"], { home })).toEqual(["C:\\Users\\x\\.bun"]);
		expect(toolchainRootsFor(["\\\\server\\share\\tools\\x.exe"], { home })).toEqual(["\\\\server\\share\\tools"]);
	});
});

describe("pathCandidates", () => {
	test("reads Windows PATH syntax: semicolons, quotes, drive letters only", () => {
		expect([...pathCandidates("git.exe", '"C:\\Tools";D:/Git/cmd;\\\\wsl$\\nope;/usr/bin')]).toEqual([
			"C:\\Tools\\git.exe",
			"D:\\Git\\cmd\\git.exe",
		]);
	});
});

describe("detectExecutableRoots", () => {
	test("a System32 shell needs no root", () => {
		expect(detectExecutableRoots("C:\\Windows\\System32\\cmd.exe", { PATH: "", USERPROFILE: "" })).toEqual([]);
	});
});

describeWindows("detectExecutableRoots against the disk", () => {
	const base = `${process.env.LOCALAPPDATA}\\Temp\\tr-s2-${process.pid}`;

	test("one PATH scan resolves each program's install", () => {
		try {
			mkdirSync(`${base}\\Git\\cmd`, { recursive: true });
			mkdirSync(`${base}\\node`, { recursive: true });
			writeFileSync(`${base}\\Git\\cmd\\git.exe`, "");
			writeFileSync(`${base}\\node\\node.exe`, "");
			const env = { PATH: `${base}\\Git\\cmd;${base}\\node`, USERPROFILE: `${base}\\home` };
			expect(detectExecutableRoots(`${base}\\Git\\bin\\bash.exe`, env)).toEqual([`${base}\\Git`, `${base}\\node`]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("the ~\\.bun\\bin fallback is a root of its own", () => {
		try {
			mkdirSync(`${base}\\.bun\\bin`, { recursive: true });
			writeFileSync(`${base}\\.bun\\bin\\bun.exe`, "");
			expect(detectExecutableRoots(null, { PATH: "", USERPROFILE: base })).toEqual([`${base}\\.bun`]);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
