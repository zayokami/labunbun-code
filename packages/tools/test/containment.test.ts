/**
 * Path containment: the guard that keeps a model-supplied path from reaching
 * outside the workspace. These are adversarial by design — the interesting cases
 * are the ones an attacker would try, not the ones a well-behaved caller sends.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { guardPathContainment, isContainedIn, normalizePathSeparators, resolveCanonical } from "../src/containment.ts";

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

	// Windows paths differ in case without differing in identity.
	test("compares case-insensitively", () => {
		expect(isContainedIn("C:/Work/Project/src/a.ts", "c:/work/project")).toBe(true);
		expect(isContainedIn("c:/work/project", "C:/WORK/PROJECT")).toBe(true);
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
