/**
 * Read the MCP servers a DeepSeek Harness home declares, for the `dsh`
 * migration source.
 *
 * DeepSeek Harness has no MCP config file: an MCP server is a Cordis
 * composition row — a plugin entry named `@deepseek-ai/dsh-mcp-client` with a
 * `config` block — living in the same YAML that composes the harness, namely
 * `<dshHome>/cordis.patch.yml` (every profile) and each profile's own
 * `cordis.patch.yml` and `cordis.yml`.
 *
 * Three properties drive the code below:
 *
 * - A composition may carry `!!js` values whose text is a JavaScript expression
 *   the harness evaluates at load time, with the ambient environment in scope.
 *   This reader never evaluates them and never reports an expression such as
 *   `process.cwd()` as if it were a value: the expression is blanked out before
 *   parsing, and a field that was computed is described in a note instead.
 *   Literal `env` values travel unchanged — they are the server's own
 *   configuration, and the planner marks the write that carries them.
 * - Only the composition files are opened. The credentials store sitting in the
 *   same home is never read.
 * - A file that cannot be read or parsed is a note, not a throw: the rest of
 *   the home is still worth importing.
 *
 * Reading is I/O and validation only; what to do with the servers is the
 * planner's decision, made in `migrate.ts`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Row `name` whose plugin hosts one MCP server. */
const MCP_CLIENT_PLUGIN = "dsh-mcp-client";

/** Home-level patch, layered over every profile. */
const HOME_PATCH_FILE = "cordis.patch.yml";

/** Directory under the harness home holding one directory per profile. */
const PROFILES_DIR = "profiles";

/** A profile's own patch, read before its root composition. */
const PROFILE_PATCH_FILE = "cordis.patch.yml";

/** A profile's root composition. */
const PROFILE_ROOT_FILE = "cordis.yml";

/** What `serverName` may look like; the model-facing tool names are built from it. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Cordis tag whose value is a JavaScript expression evaluated when the file loads. */
const JS_TAG = "!!js";

/**
 * Stand-in written where a `!!js` value was removed.
 *
 * The replacement has to survive parsing and stay recognisable, so it is a
 * plain string rather than YAML's own empty value: an absent or explicit `null`
 * field means "unset", while this marker means "the harness computes it", and
 * the two earn different notes. A composition containing the literal text
 * `__dsh_js_value__` would be misread as computed, which costs that one field
 * and a note — never a leaked expression.
 */
const COMPUTED = "__dsh_js_value__";

/** One MCP server a dsh composition declares. */
export interface DshMcpServer {
	/** The row's `config.serverName`. */
	name: string;
	transport: "stdio" | "streamable-http";
	/** Executable to start, for a stdio row. */
	command?: string;
	args: string[];
	env: Record<string, string>;
	/** Working directory, for a stdio row the file states a literal one for. */
	cwd?: string;
	/** Endpoint, for a Streamable HTTP row. */
	url?: string;
	headers: Record<string, string>;
	/** Absolute path of the patch file that declared it. */
	from: string;
}

export interface DshMcpRead {
	servers: DshMcpServer[];
	/** Patch files that were read but yielded nothing usable, with the reason. */
	notes: Array<{ from: string; reason: string }>;
	/** Patch files that existed and were parsed, for the report. */
	filesRead: string[];
}

/** Accumulator threaded through one home's worth of patch files. */
interface ReadState {
	servers: DshMcpServer[];
	notes: Array<{ from: string; reason: string }>;
	filesRead: string[];
	/** `serverName` → the file that has already declared it. The first one wins. */
	claimed: Map<string, string>;
}

/**
 * Every MCP server the harness home declares, in the order the files declare
 * them: the home-level patch first, then profiles in sorted order.
 * @param dshHome - resolved harness home (`$DSH_HOME` or `~/.dsh`).
 * @returns the servers still importable, plus what was read and what was turned
 * away. Never throws: an unusable file is one of the notes.
 */
export function readDshMcpServers(dshHome: string): DshMcpRead {
	const state: ReadState = { servers: [], notes: [], filesRead: [], claimed: new Map() };
	for (const file of compositionFiles(dshHome)) readCompositionFile(file, state);
	return { servers: state.servers, notes: state.notes, filesRead: state.filesRead };
}

/**
 * The files of a harness home that may declare MCP rows, in reading order.
 *
 * The home-level patch applies to every profile and outranks each profile's own
 * layer, so it is read first: with the first declaration of a `serverName`
 * winning, that is the same choice the harness would make. A profile's own
 * patch comes before its root composition, the other order the harness layers
 * them in. Sorting the profile directories keeps the result stable across
 * filesystems, so the same home imports the same servers on every run. Names
 * that are not profiles (the `node_modules` directory the harness keeps beside
 * them) cost one existence check and read nothing.
 */
function compositionFiles(dshHome: string): string[] {
	const files = [join(dshHome, HOME_PATCH_FILE)];
	const profiles = join(dshHome, PROFILES_DIR);
	let names: string[];
	try {
		names = readdirSync(profiles).sort();
	} catch {
		// A home with no profiles directory is normal — the home-level patch is
		// all there is — and an unreadable one is worth no more than that.
		return files;
	}
	for (const name of names) {
		files.push(join(profiles, name, PROFILE_PATCH_FILE));
		files.push(join(profiles, name, PROFILE_ROOT_FILE));
	}
	return files;
}

/** Read one patch file and add whatever rows it declares. */
function readCompositionFile(file: string, state: ReadState): void {
	if (!existsSync(file)) return;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		state.notes.push({ from: file, reason: `could not be read — ${errorText(error)}` });
		return;
	}
	let document: unknown;
	try {
		// A byte-order mark is a text editor's artifact, not part of the
		// document, and Bun's parser rejects a file that starts with one. A patch
		// that the harness loads must not be reported as broken YAML here.
		const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
		const sanitized = blankJsValues(source);
		if (leavesFlowOpen(sanitized)) {
			state.notes.push({
				from: file,
				reason:
					"not parsed — the document leaves a flow collection (`{` or `[`) open past the end of its line, " +
					"which the YAML parser here crashes on rather than rejecting; keep each flow collection on one line",
			});
			return;
		}
		document = Bun.YAML.parse(sanitized);
	} catch (error) {
		state.notes.push({ from: file, reason: `not valid YAML — ${errorText(error)}` });
		return;
	}
	// Read, and parsed: whether it held anything is what `servers` and `notes`
	// say, so the report can name every file it got through.
	state.filesRead.push(file);
	if (!Array.isArray(document)) {
		// A Cordis composition is a list of entries; every shipped file is one,
		// so anything else is a file this reader cannot interpret rather than a
		// composition with a different shape. Saying what was found is the
		// difference between "wrong file" and "empty file".
		state.notes.push({
			from: file,
			reason: `root is not a YAML list of composition rows — found ${documentKind(document)}`,
		});
		return;
	}
	const rows: Array<Record<string, unknown>> = [];
	collectMcpRows(document, rows, new Set());
	for (const [index, row] of rows.entries()) addRow(row, index, file, state);
}

/**
 * Collect every mcp-client row of a composition, in the order it declares them.
 *
 * A row sits wherever the composition puts it: a bare list entry, an entry
 * inside an `insert:` list (the layout the shipped examples and bundles use), or
 * anything a later Cordis release nests differently. The walk is structural for
 * that reason — any object whose `name` ends in the plugin's name and whose
 * `config` is an object is a row, at whatever depth it appears. A composition
 * that never names the plugin yields nothing, which is the common case: the
 * same file composes the whole harness.
 *
 * `ancestors` holds the collections on the current path. Bun's parser resolves
 * a YAML alias to the same object, and that object may be its own ancestor, so
 * the walk refuses to re-enter one it is already inside.
 */
function collectMcpRows(node: unknown, rows: Array<Record<string, unknown>>, ancestors: Set<object>): void {
	if (typeof node !== "object" || node === null || ancestors.has(node)) return;
	if (!Array.isArray(node) && !isRecord(node)) return;
	ancestors.add(node);
	if (isRecord(node) && isMcpClientRow(node)) rows.push(node);
	for (const value of Array.isArray(node) ? node : Object.values(node)) {
		collectMcpRows(value, rows, ancestors);
	}
	ancestors.delete(node);
}

/** Whether a composition object is one mcp-client row. */
function isMcpClientRow(node: Record<string, unknown>): boolean {
	return typeof node.name === "string" && node.name.endsWith(MCP_CLIENT_PLUGIN) && isRecord(node.config);
}

/**
 * Validate one row and, when it survives, add its server.
 *
 * Every refusal is a note: a row that names no server, a transport this build
 * cannot speak, a stdio row with no command, a Streamable HTTP row with no URL
 * that parses. A required field the harness computes at load time is a refusal
 * for the same reason — there is no literal value to carry — while the optional
 * ones (`args`, `env`, `headers`, `cwd`) are dropped one by one and the server
 * is imported regardless.
 */
function addRow(row: Record<string, unknown>, index: number, file: string, state: ReadState): void {
	const config = isRecord(row.config) ? row.config : {};
	const label = rowLabel(row, config.serverName, index);
	const serverName = config.serverName;
	if (serverName === COMPUTED) {
		state.notes.push({ from: file, reason: `serverName is computed at load time — ${label} has no fixed name` });
		return;
	}
	if (typeof serverName !== "string" || !SERVER_NAME_PATTERN.test(serverName)) {
		state.notes.push({
			from: file,
			reason: `${label} has no usable serverName — found ${quotedValue(serverName)} (must match [A-Za-z0-9_-]{1,32})`,
		});
		return;
	}
	const transport = config.transport;
	if (transport !== "stdio" && transport !== "streamable-http") {
		state.notes.push({
			from: file,
			reason: `${label} has no usable transport — found ${quotedValue(transport)} (stdio and streamable-http only)`,
		});
		return;
	}
	const server =
		transport === "stdio"
			? stdioServer(config, serverName, label, file, state)
			: httpServer(config, serverName, label, file, state);
	if (server === null) return;
	const declaredBy = state.claimed.get(serverName);
	if (declaredBy !== undefined) {
		state.notes.push({
			from: file,
			reason:
				`serverName "${serverName}" — ${label} is a duplicate of the row declared by ${declaredBy}, ` +
				"so this one was dropped",
		});
		return;
	}
	state.claimed.set(serverName, file);
	state.servers.push(server);
}

/**
 * The stdio server one row declares, or `null` when the row was refused.
 *
 * `cwd` is carried only when the file states a literal one. The harness runs a
 * stdio server in the session's working directory unless the row overrides it,
 * so an absent or empty `cwd` — the field's own default — means "unset" here
 * too, and inventing a directory would move the server somewhere the user never
 * asked for.
 */
function stdioServer(
	config: Record<string, unknown>,
	name: string,
	label: string,
	file: string,
	state: ReadState,
): DshMcpServer | null {
	const command = config.command;
	if (command === COMPUTED || typeof command !== "string" || command.trim() === "") {
		state.notes.push({
			from: file,
			reason: `${label} is a stdio server with no literal command — found ${quotedValue(command)}`,
		});
		return null;
	}
	const args = computedField(config.args, "args", label, file, state);
	const env = computedField(config.env, "env", label, file, state);
	const cwd = computedField(config.cwd, "cwd", label, file, state);
	const literal = typeof cwd === "string" && cwd.trim() !== "" ? cwd : undefined;
	return {
		name,
		transport: "stdio",
		command,
		args: args === undefined ? [] : stringList(args),
		env: env === undefined ? {} : stringMap(env),
		...(literal === undefined ? {} : { cwd: literal }),
		headers: {},
		from: file,
	};
}

/** The Streamable HTTP server one row declares, or `null` when the row was refused. */
function httpServer(
	config: Record<string, unknown>,
	name: string,
	label: string,
	file: string,
	state: ReadState,
): DshMcpServer | null {
	const url = config.url;
	if (url === COMPUTED || typeof url !== "string" || url.trim() === "") {
		state.notes.push({
			from: file,
			reason: `${label} is a streamable-http server with no literal url — found ${quotedValue(url)}`,
		});
		return null;
	}
	try {
		new URL(url);
	} catch {
		// The target's MCP client builds a `URL` from this string, so a value
		// that does not parse here would fail there, after the import.
		state.notes.push({ from: file, reason: `${label} declares url "${url}", which does not parse as a URL` });
		return null;
	}
	const headers = computedField(config.headers, "headers", label, file, state);
	return {
		name,
		transport: "streamable-http",
		args: [],
		env: {},
		url,
		headers: headers === undefined ? {} : stringMap(headers),
		from: file,
	};
}

/**
 * The field's value, or `undefined` when the harness computes it.
 *
 * A computed value is not a value: importing it would mean importing the text
 * of an expression, so the field is left at its schema default and the note
 * says which field and which row lost it.
 */
function computedField(value: unknown, field: string, label: string, file: string, state: ReadState): unknown {
	if (!isComputed(value)) return value;
	state.notes.push({ from: file, reason: `${field} is computed at load time — dropped from ${label}` });
	return undefined;
}

/** Whether a parsed value, or anything inside it, replaced a `!!js` expression. */
function isComputed(value: unknown): boolean {
	if (value === COMPUTED) return true;
	if (Array.isArray(value)) return value.some(isComputed);
	if (isRecord(value)) return Object.values(value).some(isComputed);
	return false;
}

/**
 * How a note names the row it refused. The Cordis `id` is what the user sees in
 * their composition and what a patch targets, so it comes first; a row inserted
 * without one falls back to its `serverName`, then to its position.
 */
function rowLabel(row: Record<string, unknown>, serverName: unknown, index: number): string {
	if (typeof row.id === "string" && row.id.trim() !== "") return `row "${row.id}"`;
	if (typeof serverName === "string" && serverName !== "" && serverName !== COMPUTED) {
		return `row "${serverName}"`;
	}
	return `row #${index + 1}`;
}

/**
 * How a note quotes a value it could not use: the reader's whole job is to tell
 * the user what their file actually said. A computed value is described rather
 * than quoted — its text is code the harness will run, not a value it will use.
 */
function quotedValue(value: unknown): string {
	if (value === undefined) return "nothing";
	if (value === COMPUTED) return "a value computed at load time";
	if (typeof value === "string") return `"${value}"`;
	return JSON.stringify(value) ?? String(value);
}

/** A YAML list as the string list a row's `args` holds; anything else is no list at all. */
function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const args: string[] = [];
	for (const item of value) {
		// Scalars only: the row's own schema coerces them the same way, and a
		// nested list has no place in an argv.
		if (typeof item === "string") args.push(item);
		else if (typeof item === "number" || typeof item === "boolean") args.push(String(item));
	}
	return args;
}

/** A YAML mapping as the `Record<string, string>` a row's `env`/`headers` hold. */
function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const map: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") map[key] = item;
		else if (typeof item === "number" || typeof item === "boolean") map[key] = String(item);
	}
	return map;
}

/** One line of an error's message, so that a note stays a note. */
function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n")[0]?.trim() || "unknown error";
}

/** What a patch file's root turned out to be, for a note that has to explain itself. */
function documentKind(document: unknown): string {
	if (document === null || document === undefined) return "nothing";
	return isRecord(document) ? "a mapping" : "a scalar";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a document leaves a flow collection open past the end of a line.
 *
 * Bun's YAML parser does not merely reject the shape a half-written patch
 * produces (`config: {serverName: x`, left open inside a block row): it panics
 * the process, which no `try` can catch and which would take the rest of the
 * migration down with it. The check therefore runs before parsing.
 *
 * Depth alone does not answer the question. A closer that closes nothing — a
 * `}` inside a plain scalar, which 35 of the harness's own 173 shipped Cordis
 * files contain — drives the count to zero or below, and a later unclosed opener
 * then reads as balanced. Measured against this parser, that file panics with
 * the depth back at zero, in either order of the two. What the parser cannot
 * survive is a collection still open when its line ends, so that is what is
 * asked here instead.
 *
 * The tolerance a scalar's own braces need is kept: `{` and `[` count only where
 * a collection can begin, so a plain scalar such as `cwd: /srv/{tenant` stays a
 * path, a `{{cwd}}` template balances itself, and braces inside quotes count not
 * at all. Every Cordis file the harness ships passes this check.
 *
 * A multi-line collection at the top level of a document does parse here, and
 * this refuses it along with the rest: no row of a composition can hold one
 * without the parser panicking, so a document carrying one is not a composition
 * this reader could have read anyway.
 */
function leavesFlowOpen(source: string): boolean {
	/** Where a quoted scalar or a flow collection may start. */
	const BOUNDARY = /[\s:,[{'"-]/;
	let depth = 0;
	/** Set once a counted collection outlives the line it began on. */
	let open = false;
	let quote = "";
	let comment = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (char === "\n") {
			if (depth > 0) open = true;
			// A comment ends at the line's end; a quoted scalar does not.
			comment = false;
			continue;
		}
		if (comment) continue;
		if (quote !== "") {
			if (char === quote) quote = "";
			else if (char === "\\" && quote === '"') index += 1;
			continue;
		}
		const boundary = index === 0 || BOUNDARY.test(source[index - 1] ?? "");
		if (char === "#" && boundary) {
			comment = true;
			continue;
		}
		if ((char === "'" || char === '"') && boundary) {
			quote = char;
			continue;
		}
		// A closer with nothing open to close is a character in a scalar, not the
		// end of a collection: counting it would let it cancel out a real opener
		// later on, which is the whole failure this check exists to avoid.
		if (char === "}" || char === "]") {
			if (depth > 0) depth -= 1;
		} else if ((char === "{" || char === "[") && boundary) depth += 1;
	}
	return open || depth > 0;
}

/**
 * Blank out every `!!js` value of a composition before it is parsed.
 *
 * Cordis evaluates the expression that follows the tag when the file loads, with
 * the ambient environment in scope, so `cwd: !!js process.cwd()` is a working
 * directory nobody can know without running the harness. Bun's YAML parser keeps
 * the expression as an ordinary string instead of failing on the tag, so without
 * this step the migration would import `process.cwd()` as a literal path — the
 * one outcome worse than importing nothing.
 *
 * Only a tag that opens a node counts, because `!!js` also appears in prose: a
 * patch that documents the tag inside an `args` string or a comment must keep
 * that text. Blanking a mention would cut the line in half and leave the quote
 * open, which refuses a file whose rows have nothing to do with computed fields.
 *
 * A tag is blanked to the end of its line, and past it when a block scalar
 * follows, which is how the multi-line form (`!!js >-`) carries a long
 * expression. The lines of the block are indented past their key: taking them
 * for the value of the next key would corrupt the row that follows. Inside a
 * flow collection the expression ends at its entry's delimiter instead, so the
 * bracket that closes the collection survives — and the rest of the line keeps
 * being read, because a flow collection holds several entries on one line.
 */
function blankJsValues(text: string): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	for (let line = 0; line < lines.length; line += 1) {
		const source = lines[line] ?? "";
		let rewritten = "";
		let cursor = 0;
		let toLineEnd = false;
		for (let tag = tagPosition(source, cursor); tag !== -1; tag = tagPosition(source, cursor)) {
			const context = lineContext(source, tag);
			if (context.comment) break; // the rest of the line is prose the parser drops
			rewritten += `${source.slice(cursor, tag)}${COMPUTED}`;
			if (!context.flow) {
				cursor = source.length;
				toLineEnd = true;
				break;
			}
			cursor = flowScalarEnd(source, tag);
		}
		kept.push(rewritten === "" ? source : `${rewritten}${source.slice(cursor)}`);
		if (!toLineEnd) continue;
		const keyIndent = contentIndent(source);
		let next = line + 1;
		while (next < lines.length) {
			const candidate = lines[next] ?? "";
			if (candidate.trim() === "") {
				// Blank lines belong to the block only when it resumes after them.
				let probe = next + 1;
				while (probe < lines.length && (lines[probe] ?? "").trim() === "") probe += 1;
				if (contentIndent(lines[probe] ?? "") <= keyIndent) break;
				next = probe;
				continue;
			}
			if (contentIndent(candidate) <= keyIndent) break;
			next += 1;
		}
		line = next - 1;
	}
	return kept.join("\n");
}

/**
 * Where the next `!!js` tag at or after `from` starts, or `-1` when the rest of
 * the line only mentions it.
 *
 * The tag opens the node that follows, so YAML can only have written it after a
 * separator: `cwd: !!js …` (mapping value), `- !!js …` (sequence entry),
 * `{ x: !!js … }` and `[!!js …]` (flow entries), or at the start of the line.
 * Any other `!!js` is text inside a scalar, which the parser must keep.
 */
function tagPosition(line: string, from: number): number {
	for (let at = line.indexOf(JS_TAG, from); at !== -1; at = line.indexOf(JS_TAG, at + 1)) {
		if (opensNode(line, at)) return at;
	}
	return -1;
}

/** Whether the `!!js` at `at` follows a node separator or starts the line. */
function opensNode(line: string, at: number): boolean {
	for (let before = at - 1; before >= 0; before -= 1) {
		const char = line[before] ?? "";
		if (char === " " || char === "\t") continue;
		return char === ":" || char === "-" || char === "," || char === "[" || char === "{";
	}
	return true;
}

/**
 * What the text before a tag says about where the tag sits: whether it is inside
 * a comment, and whether a flow collection is open around it.
 *
 * Both change how the tag is blanked. A comment holds prose rather than a value,
 * so rewriting it can only cost the file something. And `{ cwd: !!js … }` is a
 * tag after a `:` like any mapping value, but its expression ends where the entry
 * does: blanking to the end of that line would take the `}` with it and refuse a
 * file that closes its collection.
 */
function lineContext(line: string, at: number): { comment: boolean; flow: boolean } {
	let depth = 0;
	let comment = false;
	let quote = "";
	for (let index = 0; index < at; index += 1) {
		const char = line[index] ?? "";
		if (comment) continue;
		if (quote !== "") {
			if (char === quote) quote = "";
			else if (char === "\\" && quote === '"') index += 1;
			continue;
		}
		// A `#` opens a comment only at the start of a line or after a space.
		if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
			comment = true;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "{" || char === "[") depth += 1;
		else if (char === "}" || char === "]") depth -= 1;
	}
	return { comment, flow: depth > 0 };
}

/**
 * Where the expression of a flow-collection tag ends: at the `,`, `}` or `]`
 * that closes its entry rather than at the end of the line. The delimiters of
 * the expression itself — `!!js fn({a: 1}, "x")` — are part of the expression.
 */
function flowScalarEnd(line: string, at: number): number {
	let depth = 0;
	let quote = "";
	for (let index = at + JS_TAG.length; index < line.length; index += 1) {
		const char = line[index] ?? "";
		if (quote !== "") {
			if (char === quote) quote = "";
			else if (char === "\\" && quote === '"') index += 1;
			continue;
		}
		if (char === "'" || char === '"') quote = char;
		else if (char === "(" || char === "[" || char === "{") depth += 1;
		else if (char === ")" || char === "]" || char === "}") {
			if (depth === 0) return index;
			depth -= 1;
		} else if (char === "," && depth === 0) return index;
	}
	return line.length;
}

/**
 * The column where a line's content starts, counting a leading `- ` sequence as
 * indentation rather than as content: a block scalar under `- name: !!js >-` is
 * indented past the key, not past the dash that introduces the entry.
 */
function contentIndent(line: string): number {
	let index = 0;
	while (index < line.length) {
		const char = line[index];
		if (char === " " || char === "\t") {
			index += 1;
			continue;
		}
		const after = line[index + 1];
		if (char === "-" && (after === " " || after === "\t")) {
			index += 2;
			continue;
		}
		break;
	}
	return index;
}
