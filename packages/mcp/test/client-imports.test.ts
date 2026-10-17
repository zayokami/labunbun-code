/**
 * `@labunbun/mcp` must not execute the MCP SDK unless a server is configured.
 *
 * Every host imports this package, including runs that never touch MCP, so a
 * static value import from `@modelcontextprotocol/sdk` in `client.ts` puts the
 * SDK's module graph on every startup. The imports that need values are
 * therefore `await import(...)` inside `connectMcpServer` and its transport
 * helpers; type-only imports may stay at the top because they erase.
 *
 * This is a source-text assertion because the property is about the module
 * graph *before any function runs*. By the time a test can inspect the loaded
 * modules, importing this package to write the test has itself loaded whatever
 * `client.ts` statically imports — the observation would always be too late.
 * `scanImports` is the TypeScript-aware scan Bun already uses: it reports the
 * imports that survive type erasure, so an `import type` is absent from its
 * result (correctly allowed) while a dynamic `import(...)` is a different kind.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLIENT_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "client.ts"), "utf8");

/** Every import in `client.ts`, as the compiler would see it after type erasure. */
function clientImports(): Bun.Import[] {
	return new Bun.Transpiler({ loader: "ts" }).scanImports(CLIENT_SOURCE);
}

describe("client module graph", () => {
	test("the MCP SDK is loaded lazily, never by a static value import", () => {
		const imports = clientImports();
		const isSdk = (entry: Bun.Import) => entry.path.startsWith("@modelcontextprotocol/sdk");

		// The lazy imports this file is supposed to have. Asserting that the scan
		// sees them keeps a scan that reads nothing from passing as a scan that
		// finds nothing — the failure mode a bare "no matches" assertion cannot
		// tell apart.
		expect(imports.filter((entry) => entry.kind === "dynamic-import" && isSdk(entry)).length).toBeGreaterThan(0);

		// A static value import is an `import-statement` here; `import type` does
		// not survive type erasure and is not reported at all.
		expect(imports.filter((entry) => entry.kind === "import-statement" && isSdk(entry))).toEqual([]);
	});
});
