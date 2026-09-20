/**
 * The DeepSeek Harness MCP reader (`../src/dsh-cordis.ts`).
 *
 * DeepSeek Harness has no MCP config file: a server is a Cordis composition row
 * — a plugin entry named `@deepseek-ai/dsh-mcp-client` with a `config` block —
 * in the same YAML that composes the harness. The reader turns those rows into
 * the `{name, transport, …}` shape the rest of the importer already speaks,
 * reading the home-level patch and then each profile in sorted order.
 *
 * Two properties the fixtures exist to prove:
 * - A `!!js` value is a JavaScript expression the harness evaluates at load
 *   time. Its *text* is never carried as if it were a value: `process.cwd()`
 *   is not a directory.
 * - A file that cannot be parsed is a note, not a throw: the rest of the home
 *   is still worth importing.
 *
 * Fixture credentials are fake and say so; nothing here is key-shaped.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { McpServerConfigSchema } from "@labunbun/mcp";
import { readDshMcpServers } from "../src/dsh-cordis.ts";
import { runMigration } from "../src/migrate.ts";

/** Files a harness home should contain, keyed by path relative to the root. */
type SourceTree = Record<string, string>;

function writeTree(base: string, tree: SourceTree): void {
	for (const [path, content] of Object.entries(tree)) {
		const full = join(base, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

/** Run `body` against a throwaway harness home seeded with `tree`. */
function withRoot(tree: SourceTree, body: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "lbb-dsh-cordis-"));
	try {
		writeTree(root, tree);
		body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** Run `body` against a throwaway home whose `~/.dsh` holds `tree`. */
function withHarnessHome(tree: SourceTree, body: (home: string) => void): void {
	const home = mkdtempSync(join(tmpdir(), "lbb-dsh-mcp-home-"));
	const prevHome = process.env.USERPROFILE;
	const prevPosixHome = process.env.HOME;
	const prevDsh = process.env.DSH_HOME;
	try {
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		delete process.env.DSH_HOME;
		writeTree(join(home, ".dsh"), tree);
		body(home);
	} finally {
		if (prevHome === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevHome;
		if (prevPosixHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevPosixHome;
		if (prevDsh === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = prevDsh;
		rmSync(home, { recursive: true, force: true });
	}
}

/**
 * The machine-local patch: every transport, a literal `cwd` beside a computed
 * one, and a `serverName` a profile declares again.
 */
const HOME_PATCH = [
	"# Machine-local MCP servers, applied over every profile's own layer.",
	"- insert:",
	"    - id: mcp-files",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: files",
	"        transport: stdio",
	"        command: npx",
	"        args: ['-y', '@modelcontextprotocol/server-filesystem', 'G:/work']",
	"        env:",
	"          FILES_ROOT_TOKEN: fake-not-a-real-token",
	"        cwd: !!js process.cwd()",
	"    - id: mcp-notes",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: notes",
	"        transport: stdio",
	"        command: node",
	"        args: ['notes.js']",
	"        cwd: /tmp/dsh-work",
	"    - id: mcp-docs",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: docs",
	"        transport: streamable-http",
	"        url: https://mcp.example/docs",
	"        headers:",
	"          Authorization: !!js process.env.DOCS_TOKEN",
	// A template literal written as fixture text: the escaping keeps it literal.
	`          X-Computed: !!js () => \`Bearer \${process.env.TOKEN}\``,
	"          X-Client: labunbun-migrate",
	"    - id: mcp-metrics",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: metrics",
	"        transport: streamable-http",
	"        url: https://mcp.example/metrics",
	"        headers:",
	"          Authorization: Bearer fixture-token-not-real",
	"          X-Client: labunbun-migrate",
	"    - id: mcp-shared",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: shared",
	"        transport: stdio",
	"        command: node",
	"        args: ['shared-from-home.js']",
	"",
].join("\n");

/** The alpha profile's own layer: a server of its own, and a duplicate name. */
const ALPHA_PATCH = [
	"- insert:",
	"    - id: mcp-alpha",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: alpha-only",
	"        transport: stdio",
	"        command: node",
	"        args: ['alpha.js']",
	"    - id: mcp-shared-again",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: shared",
	"        transport: stdio",
	"        command: node",
	"        args: ['shared-from-alpha.js']",
	"",
].join("\n");

/** The zeta profile: one server, and one row that is not an MCP client at all. */
const ZETA_PATCH = [
	"- insert:",
	"    - id: mcp-zeta",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: zeta-only",
	"        transport: stdio",
	"        command: node",
	"        args: ['zeta.js']",
	"    - id: not-a-client",
	"      name: '@deepseek-ai/dsh-something-else'",
	"      config:",
	"        serverName: not-a-server",
	"        transport: stdio",
	"        command: node",
	"        args: ['ignored.js']",
	"",
].join("\n");

/**
 * A patch whose last flow sequence never closes.
 *
 * An unclosed `{...}` mapping is the shape Bun 1.3.5's parser panics on (an
 * internal assertion failure, uncatchable) rather than throwing; that shape has
 * its own tests below, because the guard they are about is the only thing
 * keeping this process alive for them.
 */
const BROKEN_PATCH = [
	"- insert:",
	"    - id: broken",
	"      name: '@deepseek-ai/dsh-mcp-client'",
	"      config:",
	"        serverName: broken",
	"        transport: stdio",
	"        args: [oops",
	"",
].join("\n");

const FIXTURE_TREE: SourceTree = {
	"cordis.patch.yml": HOME_PATCH,
	[join("profiles", "alpha", "cordis.patch.yml")]: ALPHA_PATCH,
	[join("profiles", "zeta", "cordis.patch.yml")]: ZETA_PATCH,
};

describe("migrate: DeepSeek Harness MCP reader", () => {
	// 1.
	test("a stdio row carries command, args and env, and only a literal cwd", () => {
		withRoot(FIXTURE_TREE, (root) => {
			const read = readDshMcpServers(root);
			const files = read.servers.find((s) => s.name === "files");
			expect(files?.transport).toBe("stdio");
			expect(files?.command).toBe("npx");
			expect(files?.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "G:/work"]);
			expect(files?.env).toEqual({ FILES_ROOT_TOKEN: "fake-not-a-real-token" });
			expect(files?.from).toBe(join(root, "cordis.patch.yml"));

			// The file computes its cwd, so there is no directory to carry: an
			// imported `process.cwd()` would point the server somewhere the user
			// never asked for.
			expect(files?.cwd).toBeUndefined();
			expect(read.notes.some((n) => n.from === join(root, "cordis.patch.yml") && /cwd/i.test(n.reason))).toBe(true);

			// A literal one is a value, and travels as written.
			const notes = read.servers.find((s) => s.name === "notes");
			expect(notes?.cwd).toBe("/tmp/dsh-work");
			expect(notes?.env).toEqual({});
		});
	});

	// 2.
	test("a streamable-http row keeps its url and its literal headers", () => {
		withRoot(FIXTURE_TREE, (root) => {
			const read = readDshMcpServers(root);
			const metrics = read.servers.find((s) => s.name === "metrics");
			expect(metrics?.transport).toBe("streamable-http");
			expect(metrics?.url).toBe("https://mcp.example/metrics");
			expect(metrics?.headers).toEqual({
				Authorization: "Bearer fixture-token-not-real",
				"X-Client": "labunbun-migrate",
			});
			expect(metrics?.args).toEqual([]);

			// The docs row computes its Authorization header. The url still travels;
			// the expression does not, and neither the value it would evaluate to.
			const docs = read.servers.find((s) => s.name === "docs");
			expect(docs?.url).toBe("https://mcp.example/docs");
			expect(docs?.headers.Authorization).toBeUndefined();
			expect(JSON.stringify(docs)).not.toContain("process.env");
		});
	});

	// 3.
	test("a profile's own patch is read, in a deterministic order", () => {
		withRoot(FIXTURE_TREE, (root) => {
			const read = readDshMcpServers(root);
			const names = read.servers.map((s) => s.name);
			expect(names).toContain("alpha-only");
			expect(names).toContain("zeta-only");
			// Profiles are visited in sorted order, so "the first declaration wins"
			// below is the same answer on every run, whatever the filesystem says.
			expect(names.indexOf("alpha-only")).toBeLessThan(names.indexOf("zeta-only"));
			// A row for a different plugin is not an MCP server.
			expect(names).not.toContain("not-a-server");

			expect(read.filesRead).toContain(join(root, "profiles", "alpha", "cordis.patch.yml"));
			expect(read.filesRead).toContain(join(root, "profiles", "zeta", "cordis.patch.yml"));
			expect(readDshMcpServers(root)).toEqual(read);
		});
	});

	// 4.
	test("a duplicate serverName keeps the first declaration and says so", () => {
		withRoot(FIXTURE_TREE, (root) => {
			const read = readDshMcpServers(root);
			const shared = read.servers.filter((s) => s.name === "shared");
			// One server, not two: the name is what the model-facing tool names are
			// built from, so a second one would shadow the first.
			expect(shared.length).toBe(1);
			// The home-level patch is read first, so it is the one that wins.
			expect(shared[0]?.from).toBe(join(root, "cordis.patch.yml"));
			expect(shared[0]?.args).toEqual(["shared-from-home.js"]);

			// The loser is reported rather than silently swallowed, and it is dropped
			// rather than returned in a flagged form: `servers` holds only what the
			// harness itself would load.
			expect(read.notes.some((n) => n.reason.includes("shared") && /duplicate/i.test(n.reason))).toBe(true);
		});
	});

	// 5.
	test("a computed value is never carried as source text", () => {
		withRoot(FIXTURE_TREE, (root) => {
			const read = readDshMcpServers(root);
			const serialized = JSON.stringify(read);
			// `process.` and `cwd()` catch `process.cwd()`, `process.env.X` and
			// friends; `=>` catches a value written as an arrow function.
			for (const fragment of ["process.", "=>", "cwd()"]) {
				expect(serialized).not.toContain(fragment);
			}
			// And no field was invented to stand in for one: every server in the
			// fixture has a literal command, and both http rows have a literal url.
			for (const server of read.servers) {
				if (server.transport === "stdio") expect(typeof server.command).toBe("string");
				else expect(typeof server.url).toBe("string");
			}
		});
	});

	// 6.
	test("a malformed patch is a note, and the rest of the home still reads", () => {
		withRoot(
			{
				"cordis.patch.yml": HOME_PATCH,
				[join("profiles", "broken", "cordis.patch.yml")]: BROKEN_PATCH,
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers.map((s) => s.name)).toContain("files");
				const note = read.notes.find((n) => n.from === join(root, "profiles", "broken", "cordis.patch.yml"));
				expect(note).toBeDefined();
				expect(note?.reason).toMatch(/YAML|parse|valid/i);
			},
		);
	});

	// 7.
	test("the importer writes both shapes, and marks the writes that hold credentials", () => {
		withHarnessHome({ "cordis.patch.yml": HOME_PATCH }, (home) => {
			const result = runMigration({ home });
			const write = result.plan.writes.find((w) => w.path.endsWith(".mcp.json"));
			const parsed = JSON.parse(write?.content ?? "{}") as { mcpServers: Record<string, unknown> };

			const stdio = McpServerConfigSchema.safeParse(parsed.mcpServers.files);
			expect(stdio.success).toBe(true);
			expect(stdio.data).toEqual({
				type: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-filesystem", "G:/work"],
				env: { FILES_ROOT_TOKEN: "fake-not-a-real-token" },
			});

			const http = McpServerConfigSchema.safeParse(parsed.mcpServers.metrics);
			expect(http.success).toBe(true);
			expect(http.data).toEqual({
				type: "http",
				url: "https://mcp.example/metrics",
				headers: { Authorization: "Bearer fixture-token-not-real", "X-Client": "labunbun-migrate" },
			});

			// The write carries credentials (an env holding a TOKEN, headers), and
			// the plan says so instead of leaving it to the reader to notice.
			expect(write?.containsSecret).toBe(true);

			// Values stay out of the report; the item names the file and the server.
			expect(result.report).not.toContain("fake-not-a-real-token");
			expect(result.report).not.toContain("fixture-token-not-real");
			const item = result.plan.items.find((i) => i.source === "deepseek-harness" && i.to.includes("mcpServers.files"));
			expect(item?.action).toBe("map");
		});
	});
});

/**
 * The guard that keeps a half-written patch from killing the run.
 *
 * Bun's YAML parser does not reject the shape a truncated composition row makes
 * (`config: {serverName: x`, left open) — it panics the process, uncatchably, so
 * the migration would end mid-run with no report and no chance to catch. The
 * reader therefore checks the text before handing it over, and these tests are
 * that check's: each one is a shape measured to panic this parser without it.
 *
 * The counterweight is the second half of the file: braces that are *scalars* —
 * a path, a glob, a `{{cwd}}` template, a quoted string — are ordinary text and
 * must still be read. A guard that refused them would pass every test above and
 * break on files the harness itself ships.
 */
describe("migrate: DeepSeek Harness MCP reader, the flow guard", () => {
	/** A row, with whatever extra config lines the case needs. */
	function row(id: string, name: string, extra: string[] = []): string[] {
		return [
			`    - id: ${id}`,
			"      name: '@deepseek-ai/dsh-mcp-client'",
			"      config:",
			`        serverName: ${name}`,
			"        transport: stdio",
			"        command: node",
			...extra,
		];
	}

	// 8.
	test("an unclosed mapping is refused before the parser can panic on it", () => {
		// Measured: this document panics Bun's parser (exit 3, `Internal assertion
		// failure`) the moment it reaches `Bun.YAML.parse`. The assertion running at
		// all is half the result — a regression here kills the test process rather
		// than failing it.
		withRoot(
			{
				"cordis.patch.yml": [
					"- insert:",
					...row("mcp-broken", "broken", ["      config: {serverName: broken"]),
					"",
				].join("\n"),
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers).toEqual([]);
				expect(read.filesRead).toEqual([]);
				expect(read.notes.length).toBe(1);
				expect(read.notes[0]?.reason).toMatch(/flow collection/i);
			},
		);
	});

	// 9.
	test("a stray closer does not disarm the guard, in either order", () => {
		// The bind this guard was rewritten for. A `}` that closes nothing — here
		// one sitting in a plain scalar, `cwd: a}b` — used to drive the brace count
		// to zero or below, so an unclosed opener later in the file read as
		// balanced and the parse panicked with the count back at zero. Measured
		// panicking in both orders before the rewrite, and cleanly noted after it.
		const closer = row("mcp-ok", "ok", ["        cwd: a}b"]);
		const broken = row("mcp-broken", "broken", ["      config: {serverName: broken"]);
		for (const rows of [
			[...closer, ...broken],
			[...broken, ...closer],
		]) {
			withRoot({ "cordis.patch.yml": ["- insert:", ...rows, ""].join("\n") }, (root) => {
				const read = readDshMcpServers(root);
				expect(read.servers).toEqual([]);
				expect(read.notes.some((n) => /flow collection/i.test(n.reason))).toBe(true);
			});
		}
	});

	// 10.
	test("a flow collection kept open across a line is refused in a row", () => {
		// Also measured panicking: a multi-line flow *nested in a row* crashes the
		// parser even though it closes properly. The same text at the top level of a
		// document parses, which is why this is refused for the shape rather than
		// for being invalid YAML.
		withRoot(
			{
				"cordis.patch.yml": [
					"- insert:",
					...row("mcp-flow", "flow", [
						"      config: {",
						"        serverName: flow,",
						"        transport: stdio,",
						"      }",
					]),
					"",
				].join("\n"),
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers).toEqual([]);
				expect(read.notes.some((n) => /flow collection/i.test(n.reason))).toBe(true);
			},
		);
	});

	// 11.
	test("braces that are scalars are read, not refused", () => {
		// Every one of these parses fine, measured, and every one is the kind of
		// text a real composition holds — the harness's own shipped patch uses
		// `{{cwd}}` in a plain scalar. A guard that counted them would refuse files
		// the harness loads.
		withRoot(
			{
				"cordis.patch.yml": [
					"- insert:",
					...row("mcp-scalars", "scalars", [
						"        cwd: /srv/{tenant",
						"        args: ['a{b', \"x { y\", '*.{ts,js}']",
						"        personaSuffix: Your working directory is {{cwd}}.",
						"        note: a}b",
						"        extra: {a: 1}",
					]),
					"",
				].join("\n"),
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers.map((s) => s.name)).toEqual(["scalars"]);
				expect(read.notes).toEqual([]);
				expect(read.servers[0]?.cwd).toBe("/srv/{tenant");
				expect(read.servers[0]?.args).toEqual(["a{b", "x { y", "*.{ts,js}"]);
			},
		);
	});

	// 12.
	test("`!!js` is a tag only where a value can begin", () => {
		// The text `!!js` inside a quoted string is a string. Blanking from it to
		// the end of the line — which is what a bare search does — drops the opening
		// quote with it, leaves the flow collection unbalanced, and refuses the
		// whole file: every server in it is lost to a mention in a note.
		withRoot(
			{
				"cordis.patch.yml": [
					"- insert:",
					...row("mcp-plain", "plain", [
						"        args: ['--note', 'values are computed via !!js in our other profile']",
					]),
					"",
				].join("\n"),
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers.map((s) => s.name)).toEqual(["plain"]);
				expect(read.servers[0]?.args).toEqual(["--note", "values are computed via !!js in our other profile"]);
				expect(read.notes).toEqual([]);
			},
		);
	});

	// 13.
	test("a `!!js` value inside a flow collection ends at its delimiter", () => {
		// Inside a flow mapping the value ends at the `,` or `}`, not at the line.
		// Blanking to the line's end swallows the rest of the collection, so a
		// one-line row that the harness reads fine becomes a file this reader
		// refuses. The env map is dropped whole — a computed entry is not a value,
		// and the map is one field — but the row survives with its command.
		withRoot(
			{
				"cordis.patch.yml": [
					"- insert:",
					"    - id: mcp-flow-env",
					"      name: '@deepseek-ai/dsh-mcp-client'",
					"      config: { serverName: flow, transport: stdio, command: node, args: ['flow.js'], env: { TOKEN: !!js process.env.TOKEN, MODE: dev } }",
					"",
				].join("\n"),
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers.map((s) => s.name)).toEqual(["flow"]);
				expect(read.servers[0]?.command).toBe("node");
				expect(read.servers[0]?.args).toEqual(["flow.js"]);
				expect(read.servers[0]?.env).toEqual({});
				expect(read.notes.some((n) => /env is computed/.test(n.reason))).toBe(true);
				expect(JSON.stringify(read)).not.toContain("process.env");
			},
		);
	});

	// 14.
	test("a `!!js` mentioned in a comment is prose, and its braces are too", () => {
		// Two separate mechanisms read comments, and both have to: the blanker,
		// which must not treat a tag in a comment as a tag, and the guard, which
		// must not count a `{` in a comment — a commented-out draft row is exactly
		// what a user's patch holds, and it is unfinished by definition.
		withRoot(
			{
				"cordis.patch.yml": [
					"# cwd is often computed: cwd: !!js process.cwd() — never read here",
					"#   config: { serverName: draft, transport: streamable-http",
					"- insert:",
					...row("mcp-live", "live"),
					"",
				].join("\n"),
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers.map((s) => s.name)).toEqual(["live"]);
				expect(read.notes).toEqual([]);
			},
		);
	});

	// 15.
	test("a `!!js` in a comment never swallows the document around it", () => {
		// The same commented-out draft, this time directly above the live rows rather
		// than with a second comment line in between. A blanker that treats a tag in
		// a comment as a tag blanks to the end of that line and then reads the lines
		// under it as the block body of a multi-line expression, deleting every one of
		// them: the document parses as nothing at all and its servers are lost, not
		// merely annotated. Nothing about the indent saves it — a leading `- ` counts
		// as two columns, so every top-level row is "deeper" than a comment at column
		// zero. The second comment line is what test 14 accidentally relies on: it
		// ends the swallow before it reaches the rows.
		withRoot(
			{
				"cordis.patch.yml": [
					"# draft cwd, kept for later: cwd: !!js process.cwd()",
					"- insert:",
					...row("mcp-live", "live"),
					"",
				].join("\n"),
			},
			(root) => {
				const read = readDshMcpServers(root);
				expect(read.servers.map((s) => s.name)).toEqual(["live"]);
				expect(read.notes).toEqual([]);
			},
		);
	});

	// 16.
	test("every Cordis file the harness ships is read, not refused", () => {
		// The guard's precision, against real files rather than fixtures written to
		// suit it: the harness's own bundles and overlays. A guard that fired on one
		// of these would refuse a composition the harness loads — and since it would
		// refuse it silently, as a note in a report, only a sweep notices.
		const harness = "G:/Bunttta/deepseek-harness-master";
		const files: string[] = [];
		for (const pattern of [
			`${harness}/packages/bundle/**/cordis.patch.yml`,
			`${harness}/apps/cli/config/**/*.cordis.yml`,
			`${harness}/**/cordis.patch.yml`,
		]) {
			for (const found of new Bun.Glob(pattern).scanSync()) files.push(found);
		}
		const unique = [...new Set(files)].sort();
		expect(unique.length).toBeGreaterThan(10);

		const refused: string[] = [];
		withRoot({}, (root) => {
			for (const path of unique) {
				// The reader finds its own file names under a root, so each real file
				// is presented to it under the name it would have in a user's home.
				writeFileSync(join(root, "cordis.patch.yml"), readFileSync(path, "utf8"));
				const read = readDshMcpServers(root);
				for (const note of read.notes) {
					if (/flow collection|YAML|parsed/i.test(note.reason)) refused.push(`${basename(path)}: ${note.reason}`);
				}
			}
		});
		expect(refused).toEqual([]);
	});
});
