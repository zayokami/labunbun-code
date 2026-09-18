/**
 * Path containment: the guard that keeps a model-supplied path from reaching
 * outside the workspace. These are adversarial by design — the interesting cases
 * are the ones an attacker would try, not the ones a well-behaved caller sends.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	caseInsensitivePaths,
	guardPathContainment,
	guardWritablePath,
	isContainedIn,
	normalizePathSeparators,
	resolveCanonical,
} from "../src/containment.ts";

const CWD = process.platform === "win32" ? "C:/work/project" : "/work/project";
const OUTSIDE = process.platform === "win32" ? "C:/work/other" : "/work/other";

describe("normalizePathSeparators", () => {
	test("rewrites backslashes so the two platforms compare alike", () => {
		expect(normalizePathSeparators("a\\b\\c")).toBe("a/b/c");
		expect(normalizePathSeparators("C:\\work\\project")).toBe("C:/work/project");
	});

	test("leaves forward slashes and plain names untouched", () => {
		expect(normalizePathSeparators("a/b/c")).toBe("a/b/c");
		expect(normalizePathSeparators("file.ts")).toBe("file.ts");
		expect(normalizePathSeparators("")).toBe("");
	});

	test("rewrites every separator, not just the first", () => {
		expect(normalizePathSeparators("a\\b\\c\\d\\e")).toBe("a/b/c/d/e");
	});
});

describe("resolveCanonical", () => {
	test("makes a relative path absolute against cwd", () => {
		expect(resolveCanonical("src/index.ts", CWD)).toBe(`${CWD}/src/index.ts`);
	});

	test("collapses traversal segments instead of leaving them in the string", () => {
		expect(resolveCanonical("src/../src/index.ts", CWD)).toBe(`${CWD}/src/index.ts`);
		expect(resolveCanonical("./src/./index.ts", CWD)).toBe(`${CWD}/src/index.ts`);
	});

	test("resolves above cwd when the path says so", () => {
		expect(resolveCanonical("../other/x.ts", CWD)).toBe(`${OUTSIDE}/x.ts`);
	});

	test("keeps an already-absolute path, normalized", () => {
		expect(resolveCanonical(`${OUTSIDE}/x.ts`, CWD)).toBe(`${OUTSIDE}/x.ts`);
	});

	test("resolves cwd itself to cwd", () => {
		expect(resolveCanonical(".", CWD)).toBe(CWD);
	});

	test("agrees with node's resolve, modulo separators", () => {
		expect(resolveCanonical("a/b", CWD)).toBe(normalizePathSeparators(resolve(CWD, "a/b")));
	});
});

describe("isContainedIn", () => {
	test("accepts a descendant and the root itself", () => {
		expect(isContainedIn(`${CWD}/src/index.ts`, CWD)).toBe(true);
		expect(isContainedIn(CWD, CWD)).toBe(true);
	});

	test("rejects a sibling and an ancestor", () => {
		expect(isContainedIn(OUTSIDE, CWD)).toBe(false);
		expect(isContainedIn("/work", "/work/project")).toBe(false);
	});

	// The case a plain `startsWith` gets wrong: a sibling directory whose name
	// begins with the root's name is not inside the root.
	test("rejects a sibling whose name merely starts with the root name", () => {
		expect(isContainedIn("/work/project-evil/x.ts", "/work/project")).toBe(false);
		expect(isContainedIn("/work/projectx", "/work/project")).toBe(false);
	});

	test("tolerates a trailing slash on the root", () => {
		expect(isContainedIn("/work/project/src/a.ts", "/work/project/")).toBe(true);
		expect(isContainedIn("/work/project", "/work/project/")).toBe(true);
	});

	// Case folding is a property of the filesystem, not of the check: on a
	// case-sensitive filesystem those two spellings are genuinely different
	// directories, so accepting one as the other would be the bug.
	test("compares case-insensitively only where the filesystem does", () => {
		expect(isContainedIn("C:/Work/Project/src/a.ts", "c:/work/project")).toBe(caseInsensitivePaths);
		expect(isContainedIn("c:/work/project", "C:/WORK/PROJECT")).toBe(caseInsensitivePaths);
		expect(isContainedIn("C:/Work/Other/x.ts", "c:/work/project")).toBe(false);
	});

	test("a deeply nested descendant is still contained", () => {
		expect(isContainedIn(`${CWD}/a/b/c/d/e/f.ts`, CWD)).toBe(true);
	});
});

describe("guardPathContainment", () => {
	test("returns the canonical path for something inside the workspace", () => {
		expect(guardPathContainment("src/index.ts", CWD, "Read")).toBe(`${CWD}/src/index.ts`);
		expect(guardPathContainment("./src/../src/index.ts", CWD, "Read")).toBe(`${CWD}/src/index.ts`);
	});

	test("allows cwd itself", () => {
		expect(guardPathContainment(".", CWD, "LS")).toBe(CWD);
	});

	test("rejects a simple parent traversal", () => {
		expect(() => guardPathContainment("../secrets.txt", CWD, "Read")).toThrow(/outside workspace/);
	});

	test("rejects traversal buried mid-path, which string checks miss", () => {
		expect(() => guardPathContainment("src/../../secrets.txt", CWD, "Read")).toThrow(/outside workspace/);
		expect(() => guardPathContainment("a/b/c/../../../../etc/passwd", CWD, "Read")).toThrow(/outside workspace/);
	});

	test("rejects an absolute path pointing elsewhere", () => {
		expect(() => guardPathContainment(`${OUTSIDE}/x.ts`, CWD, "Write")).toThrow(/outside workspace/);
	});

	test("rejects a repeated-traversal walk to the filesystem root", () => {
		expect(() => guardPathContainment(`${"../".repeat(20)}etc/passwd`, CWD, "Read")).toThrow(/outside workspace/);
	});

	test("rejects a sibling directory sharing the workspace name prefix", () => {
		expect(() => guardPathContainment("../project-evil/x.ts", CWD, "Read")).toThrow(/outside workspace/);
	});

	// The message is what the model sees and has to act on, so it names the
	// operation, the path as given, and where it actually landed.
	test("names the operation, the input path, and the resolved path", () => {
		let message = "";
		try {
			guardPathContainment("../escape.txt", CWD, "Edit");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Edit");
		expect(message).toContain("../escape.txt");
		expect(message).toContain("escape.txt");
		expect(message).toContain(normalizePathSeparators(CWD));
	});

	test("accepts backslash-separated input on the platform that uses it", () => {
		expect(guardPathContainment("src\\index.ts", CWD, "Read")).toBe(
			normalizePathSeparators(resolve(CWD, "src\\index.ts")),
		);
	});
});

describe("guardWritablePath", () => {
	test("allows ordinary files, including ones whose name resembles git metadata", () => {
		expect(guardWritablePath("src/index.ts", CWD, "Write")).toBe(`${CWD}/src/index.ts`);
		expect(guardWritablePath(".gitignore", CWD, "Write")).toBe(`${CWD}/.gitignore`);
		expect(guardWritablePath(".gitattributes", CWD, "Edit")).toBe(`${CWD}/.gitattributes`);
		expect(guardWritablePath(".gitmodules", CWD, "Edit")).toBe(`${CWD}/.gitmodules`);
		expect(guardWritablePath(".github/workflows/ci.yml", CWD, "Write")).toBe(`${CWD}/.github/workflows/ci.yml`);
		expect(guardWritablePath("src/x.git/config.ts", CWD, "Write")).toBe(`${CWD}/src/x.git/config.ts`);
	});

	test("rejects a file directly inside .git", () => {
		expect(() => guardWritablePath(".git/config", CWD, "Write")).toThrow(/version-control metadata/);
		expect(() => guardWritablePath(".git/HEAD", CWD, "Edit")).toThrow(/version-control metadata/);
		expect(() => guardWritablePath(".git/hooks/pre-commit", CWD, "Write")).toThrow(/version-control metadata/);
	});

	test("rejects the .git directory itself", () => {
		expect(() => guardWritablePath(".git", CWD, "Write")).toThrow(/version-control metadata/);
		expect(() => guardWritablePath(`${CWD}/.git`, CWD, "Edit")).toThrow(/version-control metadata/);
	});

	// A nested repository (submodule, vendored checkout, worktree) has its own
	// .git, and it is just as unrecoverable as the top-level one.
	test("rejects .git of a nested repository, not just the top-level one", () => {
		expect(() => guardWritablePath("vendor/lib/.git/config", CWD, "Write")).toThrow(/version-control metadata/);
		expect(() => guardWritablePath("sub/.git", CWD, "Edit")).toThrow(/version-control metadata/);
	});

	test("sees through traversal that lands in .git", () => {
		expect(() => guardWritablePath("src/../.git/config", CWD, "Write")).toThrow(/version-control metadata/);
		expect(() => guardWritablePath("../project/.git/config", CWD, "Write")).toThrow(/version-control metadata/);
	});

	test("still enforces containment, and says so first", () => {
		expect(() => guardWritablePath(`${OUTSIDE}/x.ts`, CWD, "Write")).toThrow(/outside workspace/);
		expect(() => guardWritablePath("../secrets.txt", CWD, "Write")).toThrow(/outside workspace/);
	});

	test("names the operation, the input path, and where it actually resolved", () => {
		let message = "";
		try {
			guardWritablePath(".git/config", CWD, "Write");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Write");
		expect(message).toContain(".git/config");
		expect(message).toContain(".git/");
		expect(message).toContain(`${normalizePathSeparators(CWD)}/.git/config`);
	});

	test("rejects a case-variant spelling where the filesystem would too", () => {
		if (caseInsensitivePaths) {
			expect(() => guardWritablePath(".GIT/config", CWD, "Write")).toThrow(/version-control metadata/);
		} else {
			// On a case-sensitive filesystem `.GIT` is simply a different directory.
			expect(guardWritablePath(".GIT/config", CWD, "Write")).toBe(`${CWD}/.GIT/config`);
		}
	});
});

// These use a real temporary tree because the point of resolveSymlinks is what
// the filesystem does with a link, which a fictional path cannot demonstrate.
describe("symlinks and junctions", () => {
	function linkDir(target: string, linkPath: string): void {
		symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
	}

	function withWorkspace(run: (workspace: string) => void): void {
		const root = mkdtempSync(join(tmpdir(), "labunbun-containment-"));
		try {
			const workspace = join(root, "workspace");
			mkdirSync(workspace, { recursive: true });
			run(workspace);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	test("a link pointing outside the workspace does not launder the path", () => {
		withWorkspace((workspace) => {
			const outside = join(workspace, "..", "outside");
			mkdirSync(outside, { recursive: true });
			writeFileSync(join(outside, "secret.txt"), "not yours\n");
			linkDir(outside, join(workspace, "escape"));

			expect(() => guardPathContainment("escape/secret.txt", workspace, "Read")).toThrow(/outside workspace/);
			expect(() => guardPathContainment("escape/secret.txt", workspace, "Write")).toThrow(/outside workspace/);
		});
	});

	test("a link pointing inside the workspace still resolves normally", () => {
		withWorkspace((workspace) => {
			mkdirSync(join(workspace, "real"));
			linkDir(join(workspace, "real"), join(workspace, "alias"));

			const resolved = guardPathContainment("alias/a.txt", workspace, "Write");
			expect(resolved).toBe(normalizePathSeparators(join(workspace, "real", "a.txt")));
		});
	});

	test("a link cannot be used to reach .git", () => {
		withWorkspace((workspace) => {
			mkdirSync(join(workspace, ".git"));
			writeFileSync(join(workspace, ".git", "config"), "[core]\n");
			linkDir(join(workspace, ".git"), join(workspace, "githack"));

			expect(() => guardWritablePath("githack/config", workspace, "Write")).toThrow(/version-control metadata/);
			expect(() => guardWritablePath("githack/HEAD", workspace, "Edit")).toThrow(/version-control metadata/);
			// Reading it is still fine — only writes are refused.
			expect(guardPathContainment("githack/config", workspace, "Read")).toBe(
				normalizePathSeparators(join(workspace, ".git", "config")),
			);
		});
	});
});
