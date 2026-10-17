/**
 * MCP client: connects servers over stdio or StreamableHTTP and adapts their
 * tools into the agent Tool registry under `mcp__<server>__<tool>` names.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AnyTool, buildTool, sanitizeCwd, type ToolResult } from "@labunbun/agent";
// Type-only on purpose: these erase at compile time. The SDK's *values* are
// imported lazily by the functions that connect (see `httpTransport`,
// `stdioTransport` and `connectMcpServer`), so importing this package does not
// execute the SDK for a host that has no MCP server configured.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

export const McpServerConfigSchema = z.union([
	z.object({
		type: z.literal("stdio").default("stdio"),
		// Non-empty: a bare `command: ""` used to pass validation and fail at
		// spawn, where the platform's shell answered instead of the config
		// error that actually names the problem.
		command: z.string().min(1),
		args: z.array(z.string()).default([]),
		env: z.record(z.string(), z.string()).optional(),
		cwd: z.string().optional(),
	}),
	z.object({
		type: z.literal("http").default("http"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
]);

export type McpServerConfig = z.input<typeof McpServerConfigSchema>;

/** How long a server gets to complete connect + capability discovery. */
export const CONNECT_TIMEOUT_MS = 30_000;

/**
 * How long one `tools/call` may take. Connect was bounded but a call was not:
 * a server that accepts a request and never answers froze the whole tool batch
 * (and the run) until the user gave up on it, with nothing naming the culprit.
 */
export const CALL_TIMEOUT_MS = 60_000;

/**
 * Strip secret *values* out of a message, keeping key names.
 *
 * A stdio server's `env` typically holds API keys and an HTTP server's
 * `headers` hold bearer tokens. Config-validation errors quote the value they
 * rejected, and connection failures can echo the spawn environment — both
 * paths would otherwise write live credentials into the transcript UI and the
 * session JSONL on disk, where they persist long after the error scrolled past.
 */
export function sanitizeMcpError(message: string, config: McpServerConfig): string {
	const secrets = new Set<string>();
	const record = config as { env?: Record<string, string>; headers?: Record<string, string> };
	for (const value of Object.values(record.env ?? {})) {
		if (value) secrets.add(value);
	}
	for (const value of Object.values(record.headers ?? {})) {
		if (value) secrets.add(value);
	}

	let out = message;
	// Longest first, so a value that contains another is redacted whole.
	for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
		out = out.split(secret).join("[redacted]");
	}
	return out;
}

/** One resource a server lists, as much of it as this client keeps. */
export interface McpResourceSummary {
	uri: string;
	name?: string;
	mimeType?: string;
}

export interface McpConnection {
	serverName: string;
	client: Client;
	/**
	 * The adapted tools, as of the last successful `tools/list` walk. Replaced
	 * when the server announces a tool list change (see the handlers in
	 * {@link connectMcpServer}); the field is what a host reads, so it is
	 * written rather than made a fresh connection for.
	 */
	tools: AnyTool[];
	prompts: Array<{ name: string; description?: string }>;
	/** The resource snapshot, refreshed when the server announces a change. */
	resources: McpResourceSummary[];
	/**
	 * Where the connection stands: set to `"connected"` once it opens, then
	 * `"closed"` for good when its transport ends. `"error"` is provisional — an
	 * error the transport reported, which a later close overwrites, because "the
	 * transport is closed" is the more precise fact once it is true. Absent on a
	 * connection that never opened, and optional so a host's own literal of this
	 * shape keeps compiling.
	 */
	state?: "connected" | "closed" | "error";
	error?: string;
	/**
	 * The host's hook for a tool list that changed while the session runs.
	 *
	 * Absent by default: a host that never sets it (a `-p` run, whose process
	 * ends before a change could matter) still gets the refreshed `tools`, but
	 * nothing is told to move the list into a live session. The REPL sets it so
	 * the agent's registry follows the server, the way `/mcp approve` already
	 * appends a newly approved server's tools.
	 */
	onToolsChanged?: () => void;
}

/**
 * Wrap `base` so it also accepts null when the schema spells nullability
 * either way it is spelled in the wild: `nullable: true` (OpenAPI 3.0 style,
 * which servers copy into MCP schemas) or `"null"` among `type`'s values.
 */
function withNullable(schema: Record<string, unknown>, base: z.ZodType): z.ZodType {
	const typeArray = Array.isArray(schema.type) ? schema.type : [];
	return schema.nullable === true || typeArray.includes("null") ? base.nullable() : base;
}

/** Map a single JSON Schema `type` name to a zod schema. */
function singleJsonType(type: string, schema: Record<string, unknown>): z.ZodType {
	if (type === "object") {
		const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		const required = new Set((schema.required as string[] | undefined) ?? []);
		const shape: Record<string, z.ZodType> = {};
		for (const [key, prop] of Object.entries(properties)) {
			const mapped = jsonSchemaToZod(prop);
			shape[key] = required.has(key) ? mapped : mapped.optional();
		}
		// Passthrough rather than strip: the server may accept properties it did
		// not declare, and a parsed input that silently dropped keys the model
		// sent would hand the server a different call than the one requested.
		return z.object(shape).passthrough();
	}
	if (type === "string") return z.string();
	// `integer` maps to the same validator as `number` on purpose: JSON draws no
	// line between the two, and a server that declares `integer` and emits `2.0`
	// is within the format — rejecting it would be a false positive on the
	// server's own declared shape.
	if (type === "number" || type === "integer") return z.number();
	if (type === "boolean") return z.boolean();
	if (type === "null") return z.null();
	if (type === "array") {
		const items = schema.items;
		// Draft 2020-12 tuple form: one schema per position.
		if (Array.isArray(items)) {
			if (items.length === 0) return z.array(z.unknown());
			return z.tuple(
				items.map((item) => jsonSchemaToZod(item as Record<string, unknown>)) as [z.ZodType, ...z.ZodType[]],
			);
		}
		if (items && typeof items === "object") return z.array(jsonSchemaToZod(items as Record<string, unknown>));
		return z.array(z.unknown());
	}
	return z.unknown();
}

/**
 * Convert a JSON Schema object to a zod schema for tool input validation.
 *
 * This is the only description of a tool's input the model ever sees the
 * validation of, so the mapping is as faithful as JSON Schema allows: an enum
 * validates as that enum, a union accepts either branch, a nullable field
 * accepts null, and array items validate their element type. Only shapes with
 * no faithful equivalent — an enum whose values include objects, an unknown
 * `type` — fall back to `z.unknown()`, which validates nothing; that fallback
 * used to be the answer for most of this list.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
	// oneOf/anyOf describe the whole value, so they are consulted before
	// `type`. A single-member union is just that member.
	const members = (Array.isArray(schema.oneOf) ? schema.oneOf : schema.anyOf) as unknown[] | undefined;
	if (Array.isArray(members) && members.length > 0) {
		const mapped = members.map((member) => jsonSchemaToZod(member as Record<string, unknown>));
		const base: z.ZodType =
			mapped.length === 1 ? (mapped[0] as z.ZodType) : z.union(mapped as [z.ZodType, z.ZodType, ...z.ZodType[]]);
		return withNullable(schema, base);
	}
	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const values = schema.enum;
		// `z.enum` is the faithful form when every value is a string.
		if (values.every((value) => typeof value === "string")) {
			return withNullable(schema, z.enum(values as [string, ...string[]]));
		}
		// Otherwise literals cover the primitives. An object or array value has
		// no literal form, and accepting it as part of a union with `unknown`
		// would accept everything — so a mixed enum falls back whole.
		if (values.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))) {
			const literals = values.map((value): z.ZodType => z.literal(value as string | number | boolean | null));
			const base: z.ZodType =
				literals.length === 1
					? (literals[0] as z.ZodType)
					: z.union(literals as [z.ZodType, z.ZodType, ...z.ZodType[]]);
			return withNullable(schema, base);
		}
		return z.unknown();
	}
	// `type` is a single string in draft-07 and an array in draft 2020-12;
	// "null" among the values is nullability, and the rest names the value.
	const rawTypes = Array.isArray(schema.type)
		? schema.type.filter((type): type is string => typeof type === "string")
		: typeof schema.type === "string"
			? [schema.type]
			: [];
	if (rawTypes.length === 0) return z.unknown();
	const types = rawTypes.filter((type) => type !== "null");
	if (types.length === 0) return z.null();
	const base =
		types.length === 1
			? singleJsonType(types[0] as string, schema)
			: z.union(types.map((type) => singleJsonType(type, schema)) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
	return withNullable(schema, base);
}

/**
 * Bound a connect attempt. On timeout the pending work is abandoned and
 * `onTimeout` gets a chance to release the transport (a stdio server would
 * otherwise leave an orphaned child process behind for the session's lifetime).
 */
async function withTimeout<T>(work: Promise<T>, onTimeout: () => void, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					onTimeout();
					reject(new Error(`timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		// A rejected `work` promise is already surfaced by the race; swallow any
		// later rejection so losing the race can't raise an unhandled rejection.
		void work.catch(() => {});
	}
}

/**
 * Every page of a list request, in the order the server hands them out.
 *
 * Both list calls take an optional `cursor` and answer an optional
 * `nextCursor`, and a server is free to split a list across pages. The call
 * that passes no cursor gets the first page and nothing says how many pages
 * follow, so reading one result is indistinguishable from a complete list —
 * a server with 200 tools looked exactly like a server with the 50 that fit in
 * page one, and the missing ones were missing without a word.
 *
 * `label` names the list in the one warning this can print, because that
 * warning is the only trace a broken walk leaves.
 */
async function listEveryPage<TPage extends { nextCursor?: string }>(
	label: string,
	requestPage: (cursor: string | undefined) => Promise<TPage>,
): Promise<TPage[]> {
	const pages: TPage[] = [];
	// The cursors already used to ask for a page. A server that repeats one is
	// not advancing, and asking again with it would return the same page for as
	// long as the connect budget lasts — a busy wait, not a slow server. The
	// pages collected so far are real, so they are kept and the list is reported
	// short rather than discarded.
	const asked = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		const page = await requestPage(cursor);
		pages.push(page);
		const next = page.nextCursor;
		if (!next) return pages;
		if (asked.has(next)) {
			console.error(`Warning: ${label} repeated the page cursor "${next}"; the list from this server is incomplete.`);
			return pages;
		}
		asked.add(next);
		cursor = next;
	}
}

/**
 * The stdio spawn a host's confiner sees: the configured command, and the
 * fields the transport would open it with.
 */
export interface McpStdioSpawn {
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
}

/**
 * The host's hook over a stdio spawn. It receives what the config asked for
 * and returns what is actually opened — for the REPL and headless hosts that
 * is the session's sandbox wrapped around the command, the same wrapping the
 * Bash tool's own commands get. A rejection fails this server's connect with
 * the message, which is the fail-closed side for a server the host meant to
 * confine.
 */
export type McpSpawnConfiner = (spawn: McpStdioSpawn) => Promise<McpStdioSpawn>;

export interface ConnectMcpOptions {
	/** Connect + discovery budget. Defaults to CONNECT_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Budget for one `tools/call`. Defaults to CALL_TIMEOUT_MS. */
	callTimeoutMs?: number;
	/** Runs over the stdio spawn before the transport opens it. The HTTP branch never consults it — there is no process there to wrap. */
	confine?: McpSpawnConfiner;
}

/** Budget for one request against an already-connected server. */
export interface McpRequestOptions {
	/** Defaults to CALL_TIMEOUT_MS, the same bound a `tools/call` gets. */
	timeoutMs?: number;
}

/**
 * One request against a connected server, bounded the way a tool call is.
 *
 * `tools/call` was not the only request a hung server could hold open: a list
 * or a read on a server that accepts the request and never answers would leave
 * the `/mcp` screen, or a notification refresh, waiting forever — and the same
 * server that earned the call budget will earn its way into these. Aborting the
 * request rather than racing a timer is also what tells the server the request
 * is off: the SDK turns the aborted signal into `notifications/cancelled`.
 */
async function withCallBudget<T>(
	label: string,
	timeoutMs: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		return await work(controller.signal);
	} catch (error) {
		// The server's own refusal and the timer's abort both land as a rejection;
		// when the timer is what fired, "the server never answered" is the cause
		// worth naming (the same split the call path makes).
		if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Every page of a list request, bounded. `label` serves both the walk's
 * repeated-cursor warning and the timeout message, so a bare wrapper and the
 * refresh inside `connectMcpServer` differ only in whether it names the server.
 */
async function listPagesFrom<TPage extends { nextCursor?: string }>(
	label: string,
	timeoutMs: number,
	requestPage: (cursor: string | undefined, signal: AbortSignal) => Promise<TPage>,
): Promise<TPage[]> {
	return withCallBudget(label, timeoutMs, (signal) => listEveryPage(label, (cursor) => requestPage(cursor, signal)));
}

/**
 * Every prompt a connected server offers.
 *
 * The connection's `prompts` is a snapshot for the row that counts them; this
 * reads the server itself, so `/mcp prompts` shows the list as of the command
 * that asked rather than the one as of connect time.
 */
async function listPromptsFrom(
	label: string,
	client: Client,
	timeoutMs: number,
): Promise<Array<{ name: string; description?: string }>> {
	const pages = await listPagesFrom(label, timeoutMs, (cursor, signal) =>
		client.listPrompts(cursor ? { cursor } : undefined, { signal }),
	);
	return pages
		.flatMap((page) => page.prompts ?? [])
		.map((prompt) => ({ name: prompt.name, description: prompt.description }));
}

/** As {@link listPrompts}, with the caller's own label (the connect path names the server). */
export async function listPrompts(
	client: Client,
	options?: McpRequestOptions,
): Promise<Array<{ name: string; description?: string }>> {
	return listPromptsFrom("prompts/list", client, options?.timeoutMs ?? CALL_TIMEOUT_MS);
}

/** Every resource a connected server lists, every page of it. */
async function listResourcesFrom(label: string, client: Client, timeoutMs: number): Promise<McpResourceSummary[]> {
	const pages = await listPagesFrom(label, timeoutMs, (cursor, signal) =>
		client.listResources(cursor ? { cursor } : undefined, { signal }),
	);
	return pages
		.flatMap((page) => page.resources ?? [])
		.map((resource) => ({ uri: resource.uri, name: resource.name, mimeType: resource.mimeType }));
}

/** As {@link listResourcesFrom}, exported for `/mcp resources`. */
export async function listResources(client: Client, options?: McpRequestOptions): Promise<McpResourceSummary[]> {
	return listResourcesFrom("resources/list", client, options?.timeoutMs ?? CALL_TIMEOUT_MS);
}

/** One entry of a `resources/read` answer: `text` or `blob`, exactly one. */
export interface McpResourceContents {
	uri: string;
	mimeType?: string;
	text?: string;
	/** Base64, as it came over the wire. */
	blob?: string;
}

/** The contents of one resource, bounded like a call. */
export async function readResource(
	client: Client,
	uri: string,
	options?: McpRequestOptions,
): Promise<McpResourceContents[]> {
	return withCallBudget(`resources/read ${uri}`, options?.timeoutMs ?? CALL_TIMEOUT_MS, async (signal) => {
		const result = await client.readResource({ uri }, { signal });
		return (result.contents ?? []).map((entry) =>
			"text" in entry
				? { uri: entry.uri, mimeType: entry.mimeType, text: entry.text }
				: { uri: entry.uri, mimeType: entry.mimeType, blob: entry.blob },
		);
	});
}

/**
 * One content block of a prompt message, flattened to the fields a screen can
 * print. A prompt is a template, not a document: the point of the `/mcp prompt`
 * view is to show what the server would hand the model, so blocks that hold
 * bytes a terminal cannot show are named and counted rather than mangled.
 */
export interface McpPromptBlock {
	type: string;
	text?: string;
	mimeType?: string;
	/** The uri of an embedded resource or a resource link. */
	uri?: string;
}

export interface McpPromptMessage {
	role: string;
	content: McpPromptBlock[];
}

export interface McpPrompt {
	description?: string;
	messages: McpPromptMessage[];
}

/** One wire block, flattened. Unknown shapes keep their `type` and nothing else. */
function toPromptBlock(block: unknown): McpPromptBlock {
	const record = block as {
		type?: string;
		text?: string;
		mimeType?: string;
		uri?: string;
		resource?: { uri?: string; mimeType?: string };
	};
	switch (record?.type) {
		case "text":
			return { type: "text", text: record.text ?? "" };
		case "image":
		case "audio":
			return { type: record.type, mimeType: record.mimeType };
		case "resource":
			return { type: "resource", uri: record.resource?.uri, mimeType: record.resource?.mimeType };
		case "resource_link":
			return { type: "resource_link", uri: record.uri, mimeType: record.mimeType };
		default:
			// An unknown block survives as its type name: printing nothing would read
			// as "the message was empty", which is a claim about the server.
			return { type: record?.type ?? "unknown" };
	}
}

/** Render one prompt with arguments, bounded like a call. */
export async function getPrompt(
	client: Client,
	name: string,
	args: Record<string, string> = {},
	options?: McpRequestOptions,
): Promise<McpPrompt> {
	return withCallBudget(`prompts/get ${name}`, options?.timeoutMs ?? CALL_TIMEOUT_MS, async (signal) => {
		const result = await client.getPrompt({ name, arguments: args }, { signal });
		return {
			description: result.description,
			// One wire block per message — the schema says so — carried as a list
			// because a prompt block is a content block, and content is plural
			// everywhere else in this codebase.
			messages: (result.messages ?? []).map((message) => ({
				role: message.role,
				content: [toPromptBlock(message.content)],
			})),
		};
	});
}

/**
 * Adapt one walk of a server's tool definitions into agent tools under the
 * `mcp__<server>__<tool>` naming.
 *
 * Its own function because two callers walk the list now: the initial discovery
 * and the rebuild a `tools/list_changed` notification triggers. Both have to
 * produce the same tools — same names, same validation, same call path — or a
 * tool gained mid-session would be a different tool than the ones that connected.
 */
function adaptTools(
	serverName: string,
	config: McpServerConfig,
	client: Client,
	definitions: Array<{
		name: string;
		description?: string;
		inputSchema?: unknown;
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			idempotentHint?: boolean;
			openWorldHint?: boolean;
		};
	}>,
	callTimeoutMs: number,
): AnyTool[] {
	return definitions.map((mcpTool) =>
		buildTool({
			name: `mcp__${serverName}__${mcpTool.name}`,
			description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`,
			inputSchema: jsonSchemaToZod((mcpTool.inputSchema ?? { type: "object" }) as Record<string, unknown>) as z.ZodType,
			// The server owns the declaration: only an explicit readOnlyHint:true
			// makes a tool read-only; absent, false, or a destructiveHint alone
			// keeps the fail-closed default. Plan mode reads this same isReadOnly
			// answer through collectReadOnlyToolNames.
			isReadOnly: () => mcpTool.annotations?.readOnlyHint === true,
			// Conservative default: a tool may run in parallel only when the
			// server declares it read-only; idempotentHint alone does not qualify.
			isConcurrencySafe: () => mcpTool.annotations?.readOnlyHint === true,
			// No maxResultSizeChars override on purpose: the result flows
			// through the same pipeline budget as every other tool, so a
			// server cannot outgrow the conversation by answering over the
			// wire, and the same truncation marker says what was cut.
			call: async (input, ctx): Promise<ToolResult> => {
				// A run cancelled before the call starts must not reach the server:
				// an abort event does not replay for listeners added after it, so
				// the already-aborted case is handled rather than subscribed to.
				if (ctx.signal.aborted) {
					return { content: [{ type: "text", text: "Tool execution aborted" }], isError: true };
				}
				// Two ways out of a call, two signals: the run's (Esc) and this
				// call's own timer (a server that accepts the request and never
				// answers). Aborting the request — rather than racing a timeout
				// promise — is also what tells the server the call is off: the
				// SDK turns it into notifications/cancelled.
				const controller = new AbortController();
				let timedOut = false;
				const forward = () => controller.abort();
				ctx.signal.addEventListener("abort", forward, { once: true });
				const timer = setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, callTimeoutMs);
				try {
					const result = await client.callTool(
						{ name: mcpTool.name, arguments: input as Record<string, unknown> },
						undefined,
						{
							signal: controller.signal,
						},
					);
					const content = Array.isArray(result.content)
						? result.content.map((block) =>
								(block as { type: string; text?: string }).type === "text"
									? { type: "text" as const, text: String((block as { text?: string }).text ?? "") }
									: { type: "text" as const, text: JSON.stringify(block) },
							)
						: [{ type: "text" as const, text: JSON.stringify(result) }];
					return { content, isError: Boolean(result.isError) };
				} catch (error) {
					// Checked before the run's signal: both paths end in an abort, and
					// when the timer is what fired, "the server never answered" is the
					// cause worth naming.
					if (timedOut) {
						const message = `${serverName}/${mcpTool.name} timed out after ${callTimeoutMs}ms`;
						ctx.onUpdate({ mcpError: message });
						return {
							content: [{ type: "text", text: `MCP call failed: ${message}` }],
							isError: true,
						};
					}
					// The SDK rejects the pending request when the signal aborts — that
					// is the run being cancelled, not an MCP server failure.
					if (ctx.signal.aborted) {
						return { content: [{ type: "text", text: "Tool execution aborted" }], isError: true };
					}
					const message = sanitizeMcpError(error instanceof Error ? error.message : String(error), config);
					ctx.onUpdate({ mcpError: message });
					return {
						content: [{ type: "text", text: `MCP call failed: ${message}` }],
						isError: true,
					};
				} finally {
					clearTimeout(timer);
					ctx.signal.removeEventListener("abort", forward);
				}
			},
		}),
	);
}

/** Every tool a connected server offers, adapted under the `mcp__<server>__` naming. */
async function listToolsFrom(
	label: string,
	serverName: string,
	config: McpServerConfig,
	client: Client,
	timeoutMs: number,
): Promise<AnyTool[]> {
	const pages = await listPagesFrom(label, timeoutMs, (cursor, signal) =>
		client.listTools(cursor ? { cursor } : undefined, { signal }),
	);
	return adaptTools(
		serverName,
		config,
		client,
		pages.flatMap((page) => page.tools ?? []),
		timeoutMs,
	);
}

/**
 * The StreamableHTTP transport for one config. The SDK is loaded here, at the
 * moment a server is actually connected, rather than when this module is
 * imported: a host with no MCP server configured never executes it.
 */
async function httpTransport(url: string, headers?: Record<string, string>): Promise<StreamableHTTPClientTransport> {
	const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
	return new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
}

/**
 * The stdio transport for one config, through the host's confiner when one is
 * wired. The confiner's answer is what opens — for the REPL that is the
 * sandbox wrapper around the command, plus the policy's proxy variables as an
 * env increment the transport merges over its own whitelist. A rejection here
 * fails this server's connect (the caller catches), not the session.
 *
 * The SDK is imported here, not at module scope: this path only runs when a
 * stdio server is actually configured.
 */
async function stdioTransport(
	params: { command: string; args: string[]; env?: Record<string, string>; cwd?: string },
	confine: McpSpawnConfiner | undefined,
): Promise<StdioClientTransport> {
	const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
	const spawn: McpStdioSpawn = confine
		? await confine({ command: params.command, args: params.args, env: params.env, cwd: params.cwd })
		: { command: params.command, args: params.args, env: params.env, cwd: params.cwd };
	return new StdioClientTransport({ command: spawn.command, args: spawn.args, env: spawn.env, cwd: spawn.cwd });
}

/** Connect to one MCP server and adapt its tools. Never throws. */
export async function connectMcpServer(
	serverName: string,
	config: McpServerConfig,
	options?: ConnectMcpOptions,
): Promise<McpConnection> {
	const parsed = McpServerConfigSchema.safeParse(config);
	if (!parsed.success) {
		return {
			serverName,
			client: null as never,
			tools: [],
			prompts: [],
			resources: [],
			error: `invalid config: ${sanitizeMcpError(parsed.error.message, config)}`,
		};
	}

	/** The live client, once one exists: the catch below has to be able to close it. */
	let opened: Client | null = null;

	try {
		const transport =
			"type" in parsed.data && parsed.data.type === "http"
				? await httpTransport(parsed.data.url, parsed.data.headers)
				: await stdioTransport(
						parsed.data as { command: string; args: string[]; env?: Record<string, string>; cwd?: string },
						options?.confine,
					);

		const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
		const client = new Client({ name: "labunbun", version: "0.1.0" });
		opened = client;
		const callTimeoutMs = options?.callTimeoutMs ?? CALL_TIMEOUT_MS;
		/** The object the host holds; the notification handlers refresh it in place. */
		const connection: McpConnection = {
			serverName,
			client,
			tools: [],
			prompts: [],
			resources: [],
			state: "connected",
		};

		// The connection's own account of ending. Both hooks are the SDK's, fired
		// by the transport (the stdio child exiting, the HTTP stream ending) and
		// by the protocol (a request that closes it).
		//
		// `onerror` only labels: it fires for recoverable trouble too — the HTTP
		// transport reports a stream it is already reconnecting, the protocol
		// reports an unknown message id — so treating every one of them as the
		// connection's death would drop a working server's tools over noise. The
		// label is provisional; the close below overwrites it.
		client.onerror = () => {
			if (connection.state !== "closed") connection.state = "error";
		};
		// A close is terminal, and it is the event that has to reach the session:
		// the host rebuilds its registry from `connections.flatMap(c => c.tools)`,
		// so a connection that still lists the tools of a server that is gone
		// leaves the model able to pick them, with every call failing at the wire
		// and nothing on the screen saying why. Emptying the snapshots is what
		// takes them out of the live session, and ringing the bell a
		// tools/list_changed rings is what makes the host look.
		client.onclose = () => {
			if (connection.state === "closed") return;
			connection.state = "closed";
			connection.tools = [];
			connection.prompts = [];
			connection.resources = [];
			connection.onToolsChanged?.();
		};

		// A refresh that fails keeps the last good snapshot: a server that stopped
		// answering one of its lists has not thereby withdrawn what it already
		// handed out, and dropping the tools would take a working session down with
		// a broken one. The failure goes to both audiences the message has — the
		// `/mcp` row that shows `connection.error`, and stderr, the one channel a
		// host with no screen at all (a `-p` run) reads.
		let refreshFailed = false;
		const noteRefreshFailure = (list: string, error: unknown): void => {
			const message = sanitizeMcpError(error instanceof Error ? error.message : String(error), config);
			refreshFailed = true;
			connection.error = `${list} refresh failed: ${message}`;
			console.error(`Warning: MCP server ${serverName}: ${list} refresh failed: ${message}`);
		};
		const noteRefreshSuccess = (): void => {
			// A row that keeps the ✗ of a failure that has since been repaired is the
			// same lie in the other direction.
			if (!refreshFailed) return;
			refreshFailed = false;
			connection.error = undefined;
		};
		// Whether a notification-driven refresh has written the field yet. The
		// initial walk must not overwrite a newer answer with the snapshot it
		// started from, and a server is free to announce a change while that walk
		// is still running.
		let toolsRefreshed = false;
		let promptsRefreshed = false;

		// A server that accepts the connection but never answers would otherwise
		// hang startup forever — every server gets a bounded window to finish
		// connecting and reporting its capabilities.
		await withTimeout(
			(async () => {
				await client.connect(transport);

				// The notification schemas are values, so they are loaded with the
				// connection rather than when this package is imported. `Client` has
				// already pulled in the module that defines them, so this reads the
				// cache — and they are the same objects a static import would have
				// bound, not copies.
				const {
					PromptListChangedNotificationSchema,
					ResourceListChangedNotificationSchema,
					ToolListChangedNotificationSchema,
				} = await import("@modelcontextprotocol/sdk/types.js");

				// A server that adds, removes or replaces a tool mid-session says so on
				// the wire, and the SDK drops a notification that has no handler — there
				// is no fallback handler — so without these the session would serve the
				// list it saw at connect time for the rest of its life, and a tool the
				// server gained would be one the model can never call. Registered before
				// the first walk, so a change announced during discovery lands here
				// instead of falling into the gap between connect and the walk's end.
				client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
					try {
						connection.tools = await listToolsFrom(
							`${serverName}/tools/list`,
							serverName,
							config,
							client,
							callTimeoutMs,
						);
					} catch (error) {
						noteRefreshFailure("tools", error);
						return;
					}
					toolsRefreshed = true;
					noteRefreshSuccess();
					// The one list a running session has to be told about: prompts and
					// resources are read on demand, the tools are held by the agent.
					connection.onToolsChanged?.();
				});
				client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
					try {
						connection.prompts = await listPromptsFrom(`${serverName}/prompts/list`, client, callTimeoutMs);
					} catch (error) {
						noteRefreshFailure("prompts", error);
						return;
					}
					promptsRefreshed = true;
					noteRefreshSuccess();
				});
				client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
					try {
						connection.resources = await listResourcesFrom(`${serverName}/resources/list`, client, callTimeoutMs);
					} catch (error) {
						noteRefreshFailure("resources", error);
						return;
					}
					noteRefreshSuccess();
				});

				// Discovery. A server that does not implement prompts has none; that
				// is a server without prompts, not a failed connection.
				const tools = await listToolsFrom(`${serverName}/tools/list`, serverName, config, client, callTimeoutMs);
				if (!toolsRefreshed) connection.tools = tools;
				const prompts = await listPromptsFrom(`${serverName}/prompts/list`, client, callTimeoutMs).catch(() => []);
				if (!promptsRefreshed) connection.prompts = prompts;
			})(),
			() => void client.close().catch(() => {}),
			options?.timeoutMs ?? CONNECT_TIMEOUT_MS,
		);

		return connection;
	} catch (error) {
		// A client that connected and then failed discovery has nobody left to
		// close it: the error connection below carries `client: null` — the same
		// shape as a server that never opened — and `disconnectAllMcpServers`
		// skips those, so a stdio server would stay alive, pipes and all, for the
		// rest of the session. A server that accepts the connection and refuses
		// the first `tools/list` is enough to leave one behind, so the close
		// happens here or not at all. `close` is safe to call twice: after the
		// transport is closed `Protocol.close` is a no-op, the stdio transport
		// clears its process handle before its first await, and the HTTP
		// transport's abort is idempotent — so this also holds on the timeout
		// path, where `withTimeout` has already asked for the same close.
		if (opened) await opened.close().catch(() => {});
		return {
			serverName,
			client: null as never,
			tools: [],
			prompts: [],
			resources: [],
			error: sanitizeMcpError(error instanceof Error ? error.message : String(error), config),
		};
	}
}

/** One config file that could not be read, for a caller to report rather than swallow. */
export interface McpConfigError {
	path: string;
	message: string;
}

export interface McpConfigLoad {
	servers: Record<string, McpServerConfig>;
	errors: McpConfigError[];
}

/**
 * Load .mcp.json from a project root (and user scope).
 *
 * `home` is injectable and must be the caller's: this used to read
 * `USERPROFILE`/`HOME` from the environment, so a caller that had resolved its
 * own home (a test, an override) read a different file than the one it was told
 * about. A file that failed to parse also vanished without a word — a typo in
 * `.mcp.json` read as "no servers configured" — so unreadable files come back
 * in `errors` for the caller to report.
 */
export function loadMcpConfig(cwd: string, home: string = homedir()): McpConfigLoad {
	const servers: Record<string, McpServerConfig> = {};
	const errors: McpConfigError[] = [];
	for (const path of [join(cwd, ".mcp.json"), join(home, ".labunbun", ".mcp.json")]) {
		try {
			if (!existsSync(path)) continue;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
			Object.assign(servers, parsed.mcpServers ?? {});
		} catch (error) {
			errors.push({
				path,
				// A JSON.parse failure quotes the text around the mistake, and this
				// file can hold credentials inside `env`/`headers` values — the one
				// thing that must not ride into a UI or a transcript (the same rule
				// `sanitizeMcpError` enforces for everything else).
				message: error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { servers, errors };
}

/**
 * Validate the `mcpServers` object a settings file (or `--settings`) declares
 * into the same shape {@link loadMcpConfig} returns.
 *
 * The settings schema keeps the value as `unknown` so that one bad entry cannot
 * fail the whole settings load; this is where each entry is checked against the
 * real server schema. An entry that fails comes back as an error rather than
 * being dropped silently — a server that never appears anywhere else is the one
 * failure the user cannot debug. Validation messages go through
 * `sanitizeMcpError` for the same reason connection errors do: the schema quotes
 * the value it rejected, and a rejected `env`/`headers` entry is exactly where a
 * credential sits.
 */
export function parseMcpServersRecord(raw: unknown, sourceLabel: string): McpConfigLoad {
	const servers: Record<string, McpServerConfig> = {};
	const errors: McpConfigError[] = [];
	if (raw === undefined) return { servers, errors };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push({ path: sourceLabel, message: "mcpServers is not an object" });
		return { servers, errors };
	}
	for (const [name, entry] of Object.entries(raw)) {
		const parsed = McpServerConfigSchema.safeParse(entry);
		if (parsed.success) {
			servers[name] = entry as McpServerConfig;
		} else {
			errors.push({
				path: `${sourceLabel}: mcpServers.${name}`,
				message: `invalid config: ${sanitizeMcpError(parsed.error.message, entry as McpServerConfig)}`,
			});
		}
	}
	return { servers, errors };
}

/**
 * Server names sourced specifically from the project-level `<cwd>/.mcp.json`
 * — as opposed to user scope (`~/.labunbun/.mcp.json`). When `cwd` is a
 * cloned repo the user doesn't control, this file ships with the repo and is
 * attacker-controlled, unlike the home-directory config the user wrote themselves.
 */
export function loadProjectMcpServerNames(cwd: string): Set<string> {
	const path = join(cwd, ".mcp.json");
	try {
		if (!existsSync(path)) return new Set();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
		return new Set(Object.keys(parsed.mcpServers ?? {}));
	} catch {
		return new Set();
	}
}

/**
 * Where a project server's approval is remembered:
 * `~/.labunbun/projects/<cwd-slug>/mcp-approved.json`.
 *
 * This used to live in `<cwd>/.labunbun/settings.local.json`, on the reasoning
 * that the file was gitignored and therefore machine-local. Nothing ever wrote
 * that ignore rule, so a cloned repo could ship the file and pre-approve its
 * own servers — the exact hole the approval gate exists to close, since
 * `.mcp.json` and `settings.local.json` sit in the same directory and travel
 * together. Approvals now live under the user's home, keyed by the resolved
 * cwd, where repo contents cannot reach them. Approvals granted before this
 * change are intentionally not read from the old location: re-approving a
 * server costs one `/mcp approve`, reading a repo-controlled file costs
 * everything.
 *
 * The directory is keyed with `sanitizeCwd` exactly as SessionStore keys its
 * sessions, so a project's approvals land next to that project's history.
 */
function approvalStorePath(cwd: string, home: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd), "mcp-approved.json");
}

/**
 * Project-scoped MCP servers explicitly approved by the user. Stored outside
 * the working tree (see {@link approvalStorePath}) so a cloned repo can't
 * pre-approve its own servers. `home` is injectable for tests.
 */
export function loadApprovedMcpServers(cwd: string, home: string = homedir()): Set<string> {
	const path = approvalStorePath(cwd, home);
	try {
		if (!existsSync(path)) return new Set();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { approvedMcpServers?: string[] };
		return new Set(parsed.approvedMcpServers ?? []);
	} catch {
		return new Set();
	}
}

/**
 * Write a JSON store by replacement: the bytes land in a sibling file and are
 * renamed over the target, so a process that dies mid-write leaves the previous
 * complete file rather than a truncated one.
 *
 * Truncation is the failure worth this much care here: the store is read back
 * as the whole set of approvals, and a half-written file parses as nothing, so
 * the cost of a torn write is not one lost approval but every approval the
 * project ever collected. Throws when the write fails, leaving the caller to
 * decide whether a store it could not save is worth failing over; the temp file
 * does not survive the failure either way.
 */
// Long-form design notes: docs/dev/crash-consistency.md
function writeJsonAtomic(path: string, data: Record<string, unknown>): void {
	const tmp = `${path}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// No temp file to remove (the write failed before it existed).
		}
		throw error;
	}
}

/** Persist one more approved server name (creates the file/dir as needed). */
export function approveMcpServer(cwd: string, serverName: string, home: string = homedir()): void {
	const path = approvalStorePath(cwd, home);
	let existing: Record<string, unknown> = {};
	let parseFailure: unknown;
	try {
		if (existsSync(path)) existing = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		parseFailure = error;
	}
	if (parseFailure !== undefined) {
		// Read-modify-write over an unreadable file: continuing with `{}` would
		// rewrite the store holding only the new name, dropping every earlier
		// approval in silence. The corrupt file moves aside (best effort) and the
		// warning names where it went — the earlier approvals are then visibly
		// gone from /mcp rather than invisibly gone from the disk.
		const backup = `${path}.corrupt-${Date.now()}`;
		let moved: string | null = null;
		try {
			renameSync(path, backup);
			moved = backup;
		} catch {}
		console.error(
			`Warning: ${path} could not be read (${parseFailure instanceof Error ? parseFailure.message : String(parseFailure)}); ` +
				(moved ? `moved to ${moved}.` : "could not be moved aside.") +
				" Earlier approvals are not in effect until re-approved.",
		);
	}
	const approved = new Set<string>(Array.isArray(existing.approvedMcpServers) ? existing.approvedMcpServers : []);
	approved.add(serverName);
	existing.approvedMcpServers = [...approved];
	mkdirSync(dirname(path), { recursive: true });
	writeJsonAtomic(path, existing);
}

/** Connect all configured servers in parallel. */
export async function connectAllMcpServers(
	configs: Record<string, McpServerConfig>,
	approvedServers?: Set<string>,
	options?: ConnectMcpOptions,
): Promise<McpConnection[]> {
	return Promise.all(
		Object.entries(configs).map(async ([name, config]) => {
			if (approvedServers && !approvedServers.has(name)) {
				return {
					serverName: name,
					client: null as never,
					tools: [],
					prompts: [],
					resources: [],
					error: "not approved",
				};
			}
			return connectMcpServer(name, config, options);
		}),
	);
}

/**
 * Close every connection that opened. Best effort: a failed close must not fail
 * the run that is ending, and a connection that never opened (`client: null`)
 * has nothing to close.
 */
export async function disconnectAllMcpServers(connections: McpConnection[]): Promise<void> {
	await Promise.all(
		connections.map(async (connection) => {
			if (!connection.client) return;
			try {
				await connection.client.close();
			} catch {}
		}),
	);
}
