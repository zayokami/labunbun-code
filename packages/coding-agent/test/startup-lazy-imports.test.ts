/**
 * An ordinary start must not pay for the migration stack.
 *
 * `./migrate.ts` carries every source reader — twenty tools' worth of parsing
 * for Claude Code, Codex, ZCode and the rest — and none of it is needed to
 * start a REPL or a `-p` run. It used to arrive through two static edges:
 * `commands.ts` imported it for `/yoshi`, and `interactive.ts` imported
 * `CLI_NAME` from the public barrel `./index.ts`, which re-exports the whole
 * module. `wizard.ts` was a third: `interactive.ts` imports it unconditionally,
 * and it imported `runMigration` for its first-run import offer.
 *
 * The repair is a dynamic import inside the branch that uses the value, so the
 * graph is loaded when `/yoshi` is typed or the wizard offers an import, and
 * not before. These guards read the source text rather than the module graph
 * because the failure is an edge, and the source is where an edge is written —
 * the same reason `source-text-hygiene.test.ts` and `source-env-coverage.test.ts`
 * scan text. A test that imported the modules could not tell whether the graph
 * was already loaded by the time it looked.
 *
 * The scan is deliberately dumb and one direction is safe to fail in: anything
 * it cannot prove is a type-only import is treated as a value import, so a
 * reintroduced edge fails the test even if written in an unfamiliar shape.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** The two modules whose readers must stay out of ordinary starts. */
const MIGRATION_STACK = new Set(["./migrate.ts", "./migrate-wizard.ts"]);

interface StaticEdge {
	/** `import ... from` or a runtime re-export (`export ... from`). */
	kind: "import" | "reexport";
	specifier: string;
	/** `import type` / `export type`: erased, so it loads nothing. */
	typeOnly: boolean;
}

/**
 * Every static module edge in a file, and no dynamic one.
 *
 * The from-clause pattern cannot cross a semicolon, which is what keeps a lazy
 * match from running from an unrelated statement to a later `from`. Dynamic
 * imports (`import("…")`, with or without space) are excluded by the `(?!\()`
 * lookahead; they are the fix this file protects, not the regression.
 */
function staticEdges(text: string): StaticEdge[] {
	const edges: StaticEdge[] = [];
	for (const match of text.matchAll(/^[ \t]*(import|export)\s+(?!\()([^;]*?)\bfrom\s+["']([^"']+)["']/gm)) {
		edges.push({
			kind: match[1] === "export" ? "reexport" : "import",
			specifier: match[3] ?? "",
			typeOnly: /^\s*type\b/.test(match[2] ?? ""),
		});
	}
	// A side-effect import has no `from` clause and is always a value import.
	for (const match of text.matchAll(/^[ \t]*import\s+["']([^"']+)["']/gm)) {
		edges.push({ kind: "import", specifier: match[1] ?? "", typeOnly: false });
	}
	return edges;
}

function source(name: string): string {
	return readFileSync(join(SRC, name), "utf8");
}

describe("ordinary starts do not load the migration stack", () => {
	test("commands.ts keeps the migration modules inside the yoshi handler", () => {
		const text = source("commands.ts");
		const valueEdges = staticEdges(text).filter((edge) => !edge.typeOnly && MIGRATION_STACK.has(edge.specifier));
		expect(valueEdges).toEqual([]);
		// Coverage, asserted: the file above is the one this test means to read,
		// and the handler still reaches both entry points the command uses.
		expect(text).toContain("export function builtInCommands");
		expect(text).toContain('await import("./migrate.ts")');
		expect(text).toContain('await import("./migrate-wizard.ts")');
	});

	test("interactive.ts does not import the public barrel", () => {
		const text = source("interactive.ts");
		expect(staticEdges(text).filter((edge) => edge.specifier === "./index.ts")).toEqual([]);
		// The dynamic form would pull the same graph, so it is refused too.
		expect(/\bimport\s*\(\s*["']\.\/index\.ts["']\s*\)/.test(text)).toBe(false);
		expect(text).toContain("export async function runInteractive");
	});

	test("wizard.ts, which interactive.ts does load, keeps the readers for its import offer", () => {
		const text = source("wizard.ts");
		expect(staticEdges(text).filter((edge) => !edge.typeOnly && edge.specifier === "./migrate.ts")).toEqual([]);
		expect(text).toContain('await import("./migrate.ts")');
	});

	test("the scan sees static edges, including the shapes an edge is written in", () => {
		// The control for the three tests above. A scan with the comparison the
		// wrong way round — or one that mistakes a dynamic import for a static
		// one — leaves every assertion above green while checking nothing.
		expect(staticEdges('import { runMigration } from "./migrate.ts";\n')).toEqual([
			{ kind: "import", specifier: "./migrate.ts", typeOnly: false },
		]);
		expect(staticEdges('import {\n\trunMigration,\n} from "./migrate.ts";\n')).toEqual([
			{ kind: "import", specifier: "./migrate.ts", typeOnly: false },
		]);
		expect(staticEdges('import "./migrate.ts";\n')).toEqual([
			{ kind: "import", specifier: "./migrate.ts", typeOnly: false },
		]);
		expect(staticEdges('export { runMigration } from "./migrate.ts";\n')).toEqual([
			{ kind: "reexport", specifier: "./migrate.ts", typeOnly: false },
		]);
		// Type-only edges load nothing, so they are reported as such rather than
		// silently dropped: the callers above filter on the flag.
		expect(staticEdges('import type { X } from "./migrate.ts";\n')).toEqual([
			{ kind: "import", specifier: "./migrate.ts", typeOnly: true },
		]);
		expect(staticEdges('export type { X } from "./migrate.ts";\n')).toEqual([
			{ kind: "reexport", specifier: "./migrate.ts", typeOnly: true },
		]);
		// Dynamic imports are the repaired form and must not be flagged.
		expect(staticEdges('const { runMigration } = await import("./migrate.ts");\n')).toEqual([]);
		expect(staticEdges('const { runMigration } = await import(\n\t"./migrate.ts"\n);\n')).toEqual([]);
	});
});
