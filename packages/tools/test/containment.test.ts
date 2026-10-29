/**
 * Path containment: the guard that keeps a model-supplied path from reaching
 * outside the workspace. These are adversarial by design — the interesting cases
 * are the ones an attacker would try, not the ones a well-behaved caller sends.
 */
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	filesystemFoldsCase,
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
		const folds = filesystemFoldsCase("c:/work/project");
		expect(isContainedIn("C:/Work/Project/src/a.ts", "c:/work/project")).toBe(folds);
		expect(isContainedIn("c:/work/project", "C:/WORK/PROJECT")).toBe(folds);
		expect(isContainedIn("C:/Work/Other/x.ts", "c:/work/project")).toBe(false);
	});

	test("an explicit case-sensitive answer keeps case-variant siblings apart", () => {
		// The seam models the macOS volume format the probe cannot create here.
		// Folding these two would accept `/Users/me/WS` as `/Users/me/ws`.
		expect(isContainedIn("/Users/me/WS/payload", "/Users/me/ws", false)).toBe(false);
		expect(isContainedIn("/Users/me/WS/payload", "/Users/me/ws", true)).toBe(true);
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
		if (filesystemFoldsCase(CWD)) {
			expect(() => guardWritablePath(".GIT/config", CWD, "Write")).toThrow(/version-control metadata/);
		} else {
			// On a case-sensitive filesystem `.GIT` is simply a different directory.
			expect(guardWritablePath(".GIT/config", CWD, "Write")).toBe(`${CWD}/.GIT/config`);
		}
	});

	/**
	 * A segment that is `.git` once trailing dots and spaces come off.
	 *
	 * This is not a case-conditional test the way the one above is, and the
	 * asymmetry is deliberate. A case-variant spelling is refused only where the
	 * filesystem would collapse it; these are refused everywhere. On Windows
	 * `.git ` and `.git.` name *sibling directories* — writing them creates
	 * something new and leaves the real `.git` alone — so on this platform the
	 * old behaviour was a false negative rather than an escape. On an SMB share,
	 * a tar or zip extraction, or the POSIX side of a WSL mount, those trailing
	 * characters are stripped and the same path lands inside the real `.git`,
	 * which is why refusing it unconditionally is the direction that is safe on
	 * every platform rather than only the one this test runs on.
	 */
	test.each([
		[".git /config", "a trailing space"],
		[".git./config", "a trailing dot"],
		[".git.../config", "several of them"],
		["vendor/lib/.git /config", "and inside a nested repository"],
		[".git /hooks/pre-commit", "on a hook"],
	])("rejects %s — %s", (path) => {
		expect(() => guardWritablePath(path, CWD, "Write")).toThrow(/version-control metadata/);
	});

	/**
	 * The message has to name `.git`, not the spelling that was refused. A user
	 * who has to act on the string should not be told they are writing inside
	 * `.git /`, which is a directory that does not exist on their machine.
	 */
	test("the message names the canonical directory, not the near-miss spelling", () => {
		let message = "";
		try {
			guardWritablePath(".git /config", CWD, "Write");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("inside .git/");
		expect(message).not.toContain("inside .git /");
	});

	/**
	 * The other direction, and it is the reason this is not "strip then compare":
	 * a path that merely *ends* in a dot is ordinary on Windows and is not an
	 * attempt to reach `.git`. Refusing those would be a false positive on a
	 * real pattern.
	 */
	test("a filename that ends in a dot is not a .git near-miss", () => {
		expect(guardWritablePath("build/output.", CWD, "Write")).toBe(`${CWD}/build/output.`);
		expect(guardWritablePath("src/.gitignore", CWD, "Write")).toBe(`${CWD}/src/.gitignore`);
		expect(guardWritablePath("src/x.git/config.ts", CWD, "Write")).toBe(`${CWD}/src/x.git/config.ts`);
	});
});

/**
 * `.git` has a second name on a Windows volume that generates 8.3 short names:
 * `GIT~1`. The guard works on names, so a path spelled through the alias used to
 * walk straight past it, into the real repository's hooks and config. The
 * expander the guard looks the path up with is injectable, so the rule is pinned
 * on every platform with the mapping a Windows volume would supply; the second
 * block asks a real volume.
 */
describe("guardWritablePath and the 8.3 alias of .git", () => {
	/** What a volume with short names does: `GIT~1` is the directory entry `.git`, and nothing else changes. */
	const volume = (path: string): string => path.replace(/\/GIT~1(?=\/|$)/i, "/.git");

	test("refuses a path spelled through GIT~1, in the places .git is refused", () => {
		for (const path of ["GIT~1/hooks/pre-commit", "git~1/config", "GIT~1", "vendor/lib/GIT~1/HEAD"]) {
			expect(() => guardWritablePath(path, CWD, "Write", volume)).toThrow(/inside \.git\/ — version-control metadata/);
		}
	});

	test("names .git in the message, not the alias that was typed", () => {
		let message = "";
		try {
			guardWritablePath("GIT~1/config", CWD, "Edit", volume);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("Edit");
		expect(message).toContain("'GIT~1/config'");
		expect(message).toContain("inside .git/");
	});

	test("keeps writable what only resembles git", () => {
		for (const path of [
			"gitignore-notes/todo.md",
			".github/workflows/ci.yml",
			".gitignore",
			"GITHUB~1/x.yml",
			"src/x.git/config.ts",
			"git~1x/a.ts",
		]) {
			expect(guardWritablePath(path, CWD, "Write", volume)).toBe(`${CWD}/${path}`);
		}
	});

	test("a directory that is really called GIT~1, with no alias behind it, stays writable", () => {
		// The identity expander is a volume where `GIT~1` is an entry in its own
		// right: refusing it would be a false positive on a legal directory name.
		expect(guardWritablePath("GIT~1/notes.txt", CWD, "Write", (path) => path)).toBe(`${CWD}/GIT~1/notes.txt`);
	});

	test("a workspace reached through a short-name spelling is compared in long form", () => {
		// RUNNER~1 for a long user name: root and path both expand, and the
		// `.git` below them still shows once they do.
		const expand = (path: string): string => volume(path).replace("/RUNNER~1/", "/runneradmin/");
		const cwd = `${CWD.replace(/\/work\/project$/, "")}/Users/RUNNER~1/ws`;
		expect(() => guardWritablePath("GIT~1/config", cwd, "Write", expand)).toThrow(/version-control metadata/);
		expect(guardWritablePath("src/a.ts", cwd, "Write", expand)).toBe(`${cwd}/src/a.ts`);
	});

	test("a real volume: the alias of an existing .git is refused, and its neighbours are not", () => {
		if (process.platform !== "win32") return;
		const root = mkdtempSync(join(tmpdir(), "lbb-short-git-"));
		try {
			mkdirSync(join(root, ".git", "hooks"), { recursive: true });
			mkdirSync(join(root, "gitignore-notes"), { recursive: true });
			mkdirSync(join(root, ".github"), { recursive: true });
			const alias = join(root, "GIT~1");
			// A volume that generates no short names has no alias to refuse. That is
			// a fact about the volume, and there is nothing to assert on it.
			if (!existsSync(alias)) return;

			// The default expander, not an injected one: this is the path a tool takes.
			expect(() => guardWritablePath(join(alias, "hooks", "pre-commit"), root, "Write")).toThrow(
				/version-control metadata/,
			);
			expect(() => guardWritablePath(join(alias, "config"), root, "Edit")).toThrow(/version-control metadata/);
			expect(guardWritablePath(join(root, "gitignore-notes", "a.md"), root, "Write")).toContain("gitignore-notes");
			expect(guardWritablePath(join(root, ".github", "ci.yml"), root, "Write")).toContain(".github");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("filesystemFoldsCase", () => {
	test("reports what the volume does with a case-variant lookup", () => {
		const root = mkdtempSync(join(tmpdir(), "lbb-case-probe-"));
		try {
			const file = join(root, "probe.txt");
			writeFileSync(file, "x");
			// The independent answer: if the other spelling resolves, does it reach
			// the same directory entry, or a sibling that genuinely exists?
			const variant = join(root, "PROBE.TXT");
			const sameFile = existsSync(variant) && statSync(variant).ino === statSync(file).ino;
			expect(filesystemFoldsCase(root)).toBe(sameFile);
		} finally {
			rmSync(root, { recursive: true, force: true });
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
			const created = join(root, "workspace");
			mkdirSync(created, { recursive: true });
			// The workspace in the spelling the guard works in, which is not always
			// the spelling `mkdtemp` hands back. The guard resolves symlinks before
			// it compares anything, so it returns a real path; macOS's `tmpdir()` is
			// `/var/folders/…` while its real path is `/private/var/folders/…`, and
			// the two tests below that compare an exact result failed there and
			// nowhere else. The `\\?\` prefix goes the way `resolveCanonical` strips
			// it — but the realpath call is this file's own, so a guard that stopped
			// resolving would still fail these tests rather than quietly agree with
			// a fixture built by the same code it is meant to check.
			const workspace = realpathSync(created).replace(/^\\\\\?\\/, "");
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
