/**
 * The ACP server, driven the way an editor drives it: a real `labunbun acp`
 * child process, newline-delimited JSON-RPC on its stdin and stdout, and a local
 * stub endpoint answering as the model.
 *
 * What only this file can prove:
 *
 *   - **stdout is frames and nothing else.** The editor parses every line it
 *     reads, so one stray `console.log`, one warning printed to the wrong
 *     stream, or one write transform between the connection and the pipe is a
 *     protocol violation — and the only place that is observable is a real
 *     process with a real pipe. The settings warning asserted here is on stderr,
 *     on purpose.
 *   - **the permission round trip reaches a person.** `ask` in the REPL is a
 *     dialog; here it is `session/request_permission`, and the answer decides
 *     whether the tool ran or not — a fact about the filesystem, not about a
 *     return value.
 *   - **cancel answers the prompt that was interrupted.** `session/cancel` is a
 *     notification with no reply of its own; the acknowledgement is the
 *     `stopReason: "cancelled"` on the original `session/prompt`.
 *
 * Zero network: the stub binds 127.0.0.1 and the child's settings point their
 * model at it. No credential is read — the home is a temp directory.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { assistantMessage, toolResultMessage, userMessage } from "@labunbun/ai";
import { TASK_BOARD_TOOL_NAMES } from "@labunbun/tools";
import { type StubStep, startCacheStub } from "../../ai/test/cache-stub-server.ts";
import { shortSessionId } from "../src/session-resume.ts";

const CLI = join(import.meta.dir, "..", "bin", "labunbun.ts");

const roots: string[] = [];
const stubs: Array<ReturnType<typeof startCacheStub>> = [];

afterAll(() => {
	for (const stub of stubs.splice(0)) stub.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

interface Fixture {
	home: string;
	dir: string;
	stub: ReturnType<typeof startCacheStub>;
	out: string;
}

/**
 * A project, a home, and a stub model. The home's settings register the stub as
 * an OpenAI-compatible provider, so the child resolves `stub/stub-model` from
 * its own settings file and reaches the socket on loopback.
 *
 * The project gets a `.labunbun/settings.json` carrying a hooks block. That tier
 * is repo-controlled and deliberately not trusted; it is here so the child has
 * something to say on stderr — which is how the purity assertion above is about
 * a stream that was actually used, not about a quiet run.
 */
function fixture(steps: StubStep[] | ((out: string) => StubStep[])): Fixture {
	const home = scratch("lbb-acp-home-");
	const dir = scratch("lbb-acp-proj-");
	const out = join(dir, "out.txt");
	const stub = startCacheStub({ steps: typeof steps === "function" ? steps(out) : steps, modelId: "stub-model" });
	stubs.push(stub);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(
		join(home, ".labunbun", "settings.json"),
		JSON.stringify({
			model: "stub/stub-model",
			providers: {
				openaiCompatible: [
					{
						id: "stub",
						baseUrl: stub.openAIBaseUrl,
						apiKeyEnv: "STUB_KEY",
						models: [{ id: "stub-model", contextWindow: 200_000, maxOutputTokens: 8_192 }],
					},
				],
			},
		}),
	);
	mkdirSync(join(dir, ".labunbun"), { recursive: true });
	writeFileSync(
		join(dir, ".labunbun", "settings.json"),
		JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
	);
	return { home, dir, stub, out };
}

interface Frame {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string; data?: unknown };
}

/** The pieces of a spawned child this file uses. */
interface ChildPipes {
	stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(): unknown;
}

/**
 * A reader for the child's two streams, and the client side of the protocol on
 * its stdin. Frames are collected rather than consumed: a test that waits for
 * one thing does not make the next test's frame disappear, and every line the
 * child ever wrote is still there to be asserted on at the end.
 */
class AcpClient {
	readonly rawLines: string[] = [];
	readonly frames: Frame[] = [];
	/** Lines that were not JSON at all — the failure the purity check looks for. */
	readonly junk: string[] = [];
	readonly drained: Promise<void>;
	readonly stderrDrained: Promise<void>;
	#stderrText = "";
	#nextId = 0;
	#exitCode: number | undefined;
	readonly #proc: ChildPipes;

	constructor(proc: ChildPipes) {
		this.#proc = proc;
		this.drained = this.#pump(this.#proc.stdout, (line) => this.#onLine(line));
		this.stderrDrained = this.#pump(this.#proc.stderr, (line) => {
			this.#stderrText += `${line}\n`;
		});
	}

	async #pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let cut = buffer.indexOf("\n");
			while (cut >= 0) {
				const line = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 1);
				if (line.trim() !== "") onLine(line);
				cut = buffer.indexOf("\n");
			}
		}
		if (buffer.trim() !== "") onLine(buffer);
	}

	#onLine(line: string): void {
		this.rawLines.push(line);
		let frame: Frame;
		try {
			frame = JSON.parse(line) as Frame;
		} catch {
			this.junk.push(line);
			return;
		}
		this.frames.push(frame);
	}

	stderr(): string {
		return this.#stderrText;
	}

	/** Every `session/update` payload, in arrival order. */
	updates(): Array<Record<string, unknown>> {
		return this.frames
			.filter((frame) => frame.method === "session/update")
			.map((frame) => (frame.params?.update ?? {}) as Record<string, unknown>);
	}

	async #write(frame: Record<string, unknown>): Promise<void> {
		this.#proc.stdin.write(`${JSON.stringify(frame)}\n`);
		await this.#proc.stdin.flush();
	}

	async request(method: string, params: Record<string, unknown>): Promise<Frame> {
		const id = this.#nextId++;
		await this.#write({ jsonrpc: "2.0", id, method, params });
		return await this.waitFor(
			(frames) => frames.find((f) => f.id === id && (f.result !== undefined || f.error !== undefined)),
			`${method} response`,
		);
	}

	/** `session/prompt` without waiting — the turn is watched frame by frame. */
	async startPrompt(sessionId: string, text: string): Promise<number> {
		const id = this.#nextId++;
		await this.#write({
			jsonrpc: "2.0",
			id,
			method: "session/prompt",
			params: { sessionId, prompt: [{ type: "text", text }] },
		});
		return id;
	}

	/** The response to a prompt started by id. */
	async promptResult(id: number): Promise<Frame> {
		return await this.waitFor(
			(frames) => frames.find((f) => f.id === id && (f.result !== undefined || f.error !== undefined)),
			"prompt response",
		);
	}

	async notify(method: string, params: Record<string, unknown>): Promise<void> {
		await this.#write({ jsonrpc: "2.0", method, params });
	}

	async respond(id: number | undefined, result: Record<string, unknown>): Promise<void> {
		if (id === undefined) throw new Error("the frame being answered carried no id");
		await this.#write({ jsonrpc: "2.0", id, result });
	}

	/** Polls, because a frame may arrive between the check and the wait. */
	async waitFor<T>(look: (frames: Frame[]) => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = look(this.frames);
			if (found !== undefined) return found;
			if (Date.now() > deadline) {
				throw new Error(
					`timed out waiting for ${what} — ${this.frames.length} frame(s) seen; stderr: ${this.#stderrText.slice(-2000)}`,
				);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		}
	}

	async close(): Promise<number> {
		await this.#proc.stdin.end();
		this.#exitCode = await this.#proc.exited;
		return this.#exitCode;
	}

	/** The exit code, once `close` (or a failed body's `kill`) has resolved. */
	get exitCode(): number | undefined {
		return this.#exitCode;
	}
}

/**
 * One child, closed in a `finally`: a leaked ACP server is a process that never
 * exits, and Bun keeps the test runner alive for it.
 */
async function withAcp(f: Fixture, args: string[], body: (client: AcpClient) => Promise<void>): Promise<AcpClient> {
	const proc = Bun.spawn([process.execPath, CLI, ...args], {
		cwd: f.dir,
		env: {
			...process.env,
			// Both names: homedir() reads USERPROFILE on Windows and HOME elsewhere.
			USERPROFILE: f.home,
			HOME: f.home,
			ANTHROPIC_API_KEY: "sk-not-a-real-key-for-tests",
			STUB_KEY: "stub-key-for-tests",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const client = new AcpClient(proc);
	let failed = false;
	try {
		await body(client);
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		if (failed) proc.kill();
		else await client.close();
	}
	return client;
}

/** The handshake an editor opens with, up to a live session id. */
async function openSession(client: AcpClient, cwd: string): Promise<string> {
	const init = await client.request("initialize", {
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
	});
	expect(init.error).toBeUndefined();
	expect(init.result?.protocolVersion).toBe(1);
	const created = await client.request("session/new", { cwd, mcpServers: [] });
	expect(created.error).toBeUndefined();
	const sessionId = created.result?.sessionId;
	if (typeof sessionId !== "string") throw new Error("session/new returned no session id");
	return sessionId;
}

/**
 * A conversation a previous run would have left behind, in the fixture's home
 * under the project directory the child reads: a turn with thinking, a tool
 * call and its result, and the answer that used the result.
 */
function seedConversation(f: Fixture): SessionStore {
	const store = SessionStore.startNew(f.dir, f.home);
	store.appendMessage(userMessage("what does the config say"));
	store.appendMessage(
		assistantMessage({
			content: [
				{ type: "thinking", thinking: "checking the config" },
				{ type: "text", text: "let me look" },
				{ type: "toolCall", id: "call_1", name: "Read", arguments: JSON.stringify({ file_path: "config.json" }) },
			],
		}),
	);
	store.appendMessage(toolResultMessage("call_1", "Read", [{ type: "text", text: "port = 8080" }]));
	store.appendMessage(assistantMessage({ content: [{ type: "text", text: "the port is 8080" }] }));
	return store;
}

/** Every JSONL line of a session file, parsed. */
function fileEntries(path: string): Array<{ type?: string; kind?: string; data?: Record<string, unknown> }> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as { type?: string; kind?: string; data?: Record<string, unknown> });
}

/** The close-out notes a session file holds, in file order. */
function missionNotes(path: string): Array<Record<string, unknown>> {
	return fileEntries(path)
		.filter((entry) => entry.type === "custom" && entry.kind === "mission")
		.map((entry) => entry.data ?? {});
}

describe("the ACP server, end to end", () => {
	test("initialize, session/new and session/prompt answer in frames, and stdout carries nothing else", async () => {
		const f = fixture([{ text: "hello from the stub" }]);
		const client = await withAcp(f, ["acp"], async (client) => {
			const init = await client.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
			});
			expect(init.result?.protocolVersion).toBe(1);
			// The capability object is a claim about behaviour, so it is asserted
			// whole: `session/load` is implemented (the load tests below call it),
			// and no prompt capability this agent does not have — an empty object,
			// not a missing field.
			expect(init.result?.agentCapabilities).toEqual({ loadSession: true, promptCapabilities: {} });

			// No auth methods are advertised, and the client asks anyway: the answer
			// is an empty success rather than an error nobody can act on.
			const auth = await client.request("authenticate", { methodId: "none" });
			expect(auth.error).toBeUndefined();
			expect(auth.result).toEqual({});

			const created = await client.request("session/new", { cwd: f.dir, mcpServers: [] });
			const sessionId = created.result?.sessionId;
			expect(typeof sessionId).toBe("string");
			const modes = created.result?.modes as { currentModeId?: string; availableModes?: unknown[] } | undefined;
			expect(modes?.currentModeId).toBe("agent");
			expect(modes?.availableModes).toHaveLength(3);

			const promptId = await client.startPrompt(sessionId as string, "say hi");
			const response = await client.promptResult(promptId);
			expect(response.error).toBeUndefined();
			expect(response.result?.stopReason).toBe("end_turn");

			// The answer arrived as a stream of chunks, in the protocol's own shape.
			const chunks = client
				.updates()
				.filter((update) => update.sessionUpdate === "agent_message_chunk")
				.map((update) => (update.content as { text?: string } | undefined)?.text ?? "");
			expect(chunks.join("")).toContain("hello from the stub");
			expect(f.stub.requests).toHaveLength(1);
		});
		// `withAcp` closed stdin, so the child has exited and both streams have
		// ended — the whole run is in hand now.
		await client.drained;
		await client.stderrDrained;
		// The settings tier was read: the project's hooks block is reported as
		// untrusted, on stderr — the stream this file never parses.
		expect(client.stderr()).toContain("project:hooks");
		// The purity assertion: every line the child wrote parsed as a frame. One
		// `console.log` anywhere on this path lands here as a line of junk.
		expect(client.junk).toEqual([]);
		expect(client.rawLines.length).toBe(client.frames.length);
		// And every frame is JSON-RPC 2.0, in one of the two directions.
		for (const frame of client.frames) {
			expect(frame.jsonrpc).toBe("2.0");
		}
	}, 60_000);

	test("--acp is the same server, and closing stdin ends it with exit 0", async () => {
		const f = fixture([{ text: "unused" }]);
		const client = await withAcp(f, ["--acp"], async (client) => {
			const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
			expect(init.result?.protocolVersion).toBe(1);
		});
		// The end of stdin is the client's way of ending the session, and the
		// measured behaviour on Windows is that the child then leaves by itself:
		// exit 0, not a signal and not a hang. (stdin carries no byte that could be
		// mistaken for a shutdown request, so this is the only supported ending.)
		expect(client.exitCode).toBe(0);
	}, 60_000);

	test("a flag this mode cannot honor is refused, not parsed and dropped", async () => {
		const f = fixture([{ text: "unused" }]);
		const proc = Bun.spawn([process.execPath, CLI, "acp", "-p", "hello"], {
			cwd: f.dir,
			env: { ...process.env, USERPROFILE: f.home, HOME: f.home },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(2);
		expect(stderr).toContain("cannot be combined");
		expect(stdout).toBe("");
	}, 60_000);

	test("an ask becomes a permission request, and allowing it runs the tool", async () => {
		const f = fixture((out) => [
			{ tool: { name: "Write", input: { file_path: out, content: "written by the stub" } } },
			{ text: "done" },
		]);
		// `ask` is pinned rather than taken from the default: the dialog frame is
		// this test's subject, and under the default (`agent`) the write runs with
		// no question on the wire at all.
		await withAcp(f, ["acp", "--permission-mode", "ask"], async (client) => {
			const sessionId = await openSession(client, f.dir);
			const promptId = await client.startPrompt(sessionId, "write the file");

			const ask = await client.waitFor(
				(frames) => frames.find((frame) => frame.method === "session/request_permission"),
				"session/request_permission",
			);
			const params = ask.params as {
				toolCall: { toolCallId: string; status?: string };
				options: Array<{ kind: string; optionId: string }>;
			};
			// The four answers, in the protocol's four kinds.
			expect(params.options.map((option) => option.kind)).toEqual([
				"allow_once",
				"allow_always",
				"reject_once",
				"reject_always",
			]);
			// The question is attached to the call the editor is already showing, not
			// to an id it has never heard of.
			const announced = client.updates().find((update) => update.sessionUpdate === "tool_call") as
				| { toolCallId?: string }
				| undefined;
			expect(announced?.toolCallId).toBe(params.toolCall.toolCallId);

			await client.respond(ask.id, { outcome: { outcome: "selected", optionId: "allow_once" } });

			const response = await client.promptResult(promptId);
			expect(response.error).toBeUndefined();
			expect(response.result?.stopReason).toBe("end_turn");
			// Allowed means it ran: the file is the fact, not the return value.
			expect(readFileSync(f.out, "utf8")).toBe("written by the stub");
			const finished = client
				.updates()
				.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
			expect(finished).toBeDefined();
		});
	}, 60_000);

	test("denying it does not run the tool, and the model is told so", async () => {
		const f = fixture((out) => [
			{ tool: { name: "Write", input: { file_path: out, content: "should never land" } } },
			{ text: "understood" },
		]);
		await withAcp(f, ["acp", "--permission-mode", "ask"], async (client) => {
			const sessionId = await openSession(client, f.dir);
			const promptId = await client.startPrompt(sessionId, "write the file");
			const ask = await client.waitFor(
				(frames) => frames.find((frame) => frame.method === "session/request_permission"),
				"session/request_permission",
			);
			await client.respond(ask.id, { outcome: { outcome: "selected", optionId: "reject_once" } });

			const response = await client.promptResult(promptId);
			expect(response.result?.stopReason).toBe("end_turn");
			expect(existsSync(f.out)).toBe(false);
			// The turn went on: the denial is a tool result the model has to see, or
			// the model would keep proposing the same call forever.
			expect(f.stub.requests.length).toBeGreaterThanOrEqual(2);
			const lastRequest = JSON.stringify(f.stub.requests.at(-1)?.body ?? {});
			expect(lastRequest).toMatch(/denied/i);
		});
	}, 60_000);

	test("session/cancel answers the interrupted prompt with stopReason cancelled", async () => {
		const f = fixture((out) => [{ tool: { name: "Write", input: { file_path: out, content: "should never land" } } }]);
		await withAcp(f, ["acp", "--permission-mode", "ask"], async (client) => {
			const sessionId = await openSession(client, f.dir);
			const promptId = await client.startPrompt(sessionId, "write the file");
			// Cancel while the user is being asked: the question is what parks the
			// turn, and a cancelled turn must not sit waiting behind it.
			await client.waitFor(
				(frames) => frames.find((frame) => frame.method === "session/request_permission"),
				"session/request_permission",
			);
			await client.notify("session/cancel", { sessionId });
			const response = await client.promptResult(promptId);
			expect(response.error).toBeUndefined();
			expect(response.result?.stopReason).toBe("cancelled");
			expect(existsSync(f.out)).toBe(false);
		});
	}, 60_000);

	test("session/load replays the stored conversation before it answers, and the loaded session runs", async () => {
		const f = fixture([{ text: "the config says 8080" }]);
		const store = seedConversation(f);
		const sessionId = store.sessionId ?? "";
		expect(sessionId).not.toBe("");

		await withAcp(f, ["acp"], async (client) => {
			await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
			// The short tail — the spelling `--resume` prints and a person types —
			// has to resolve to the session the full id names.
			const response = await client.request("session/load", {
				sessionId: shortSessionId(sessionId),
				cwd: f.dir,
				mcpServers: [],
			});
			expect(response.error).toBeUndefined();
			const modes = response.result?.modes as { currentModeId?: string; availableModes?: unknown[] } | undefined;
			expect(modes?.currentModeId).toBe("agent");
			expect(modes?.availableModes).toHaveLength(3);
			// `models` is UNSTABLE in the protocol, so it is not filled in.
			expect(response.result?.models).toBeUndefined();

			// Every replay frame is on the wire before the response. The ordering
			// is the method's contract, and a real stream is the only place it is
			// observable.
			const responseIndex = client.frames.indexOf(response);
			const replayed = client.updates();
			expect(replayed.map((update) => update.sessionUpdate)).toEqual([
				"user_message_chunk",
				"agent_thought_chunk",
				"agent_message_chunk",
				"tool_call",
				"tool_call_update",
				"agent_message_chunk",
			]);
			for (const [index, frame] of client.frames.entries()) {
				if (frame.method === "session/update") expect(index).toBeLessThan(responseIndex);
			}
			// The frames carry the file's own content, not just its shape.
			expect((replayed[0]?.content as { text?: string } | undefined)?.text).toBe("what does the config say");
			const call = replayed[3] as { toolCallId?: string; title?: string; kind?: string; status?: string };
			expect(call.toolCallId).toBe("call_1");
			expect(call.title).toBe("Read: config.json");
			expect(call.kind).toBe("read");
			expect(call.status).toBe("pending");
			const finished = replayed[4] as { toolCallId?: string; status?: string };
			expect(finished.toolCallId).toBe("call_1");
			expect(finished.status).toBe("completed");
			expect((replayed[5]?.content as { text?: string } | undefined)?.text).toBe("the port is 8080");

			// The session is alive: a new turn runs, and the model request carries
			// the conversation the replay showed.
			const promptId = await client.startPrompt(sessionId, "and the host?");
			const answer = await client.promptResult(promptId);
			expect(answer.error).toBeUndefined();
			expect(answer.result?.stopReason).toBe("end_turn");
			const lastRequest = JSON.stringify(f.stub.requests.at(-1)?.body ?? {});
			expect(lastRequest).toContain("what does the config say");
			expect(lastRequest).toContain("the port is 8080");
			// The new turn was appended through the store the replay read from:
			// one open file, not two.
			expect(readFileSync(store.path, "utf8")).toContain("and the host?");
		});
	}, 60_000);

	test("session/load with an id nothing saved is invalidParams, and starts no session", async () => {
		const f = fixture([{ text: "unused" }]);
		await withAcp(f, ["acp"], async (client) => {
			await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const response = await client.request("session/load", {
				sessionId: "no-such-session",
				cwd: f.dir,
				mcpServers: [],
			});
			expect(response.result).toBeUndefined();
			expect(response.error?.code).toBe(-32602);
			expect(JSON.stringify(response.error)).toContain("no-such-session");
			// Nothing was replayed, and the failed id did not come into being as a
			// session a prompt could reach.
			expect(client.updates()).toEqual([]);
			const prompt = await client.request("session/prompt", {
				sessionId: "no-such-session",
				prompt: [{ type: "text", text: "hello?" }],
			});
			expect(prompt.error?.code).toBe(-32602);
			expect(f.stub.requests).toHaveLength(0);
		});
	}, 60_000);

	test("every open session closes out at shutdown, a new one and a loaded one alike", async () => {
		const f = fixture([{ text: "closing" }, { text: "closing too" }]);
		const seeded = seedConversation(f);
		const seededId = seeded.sessionId ?? "";
		expect(seededId).not.toBe("");
		let newId = "";
		const client = await withAcp(f, ["acp"], async (client) => {
			newId = await openSession(client, f.dir);
			const first = await client.promptResult(await client.startPrompt(newId, "say bye"));
			expect(first.error).toBeUndefined();
			expect(first.result?.stopReason).toBe("end_turn");
			// A second, resumed session on the same connection — the protocol and
			// this host both allow several, and each open store gets its own note.
			const loaded = await client.request("session/load", { sessionId: seededId, cwd: f.dir, mcpServers: [] });
			expect(loaded.error).toBeUndefined();
			const second = await client.promptResult(await client.startPrompt(seededId, "and again"));
			expect(second.error).toBeUndefined();
			expect(second.result?.stopReason).toBe("end_turn");
		});
		// `withAcp` closed stdin, so the child ran its shutdown and exited before
		// either stream ended — the notes are on disk by this line.
		expect(client.exitCode).toBe(0);

		const byId = new Map(SessionStore.listSessions(f.dir, f.home).map((session) => [session.sessionId, session.path]));
		const freshPath = byId.get(newId);
		if (!freshPath) throw new Error(`no session file for ${newId}`);
		const notes = missionNotes(freshPath);
		expect(notes).toHaveLength(1);
		const record = notes[0] ?? {};
		expect(record.reason).toBe("exit");
		expect(record.shellsRunning).toBe(0);
		expect(record.subagentsLive).toBe(0);
		expect(typeof record.at).toBe("number");
		// The zero recovered-shell count is dropped by the writer rather than
		// written: this host attaches no shell ledger to recover one from.
		expect(record).not.toHaveProperty("shellsRecovered");
		// The loaded session closed out in its own file, not the new one's.
		const loadedNotes = missionNotes(seeded.path);
		expect(loadedNotes).toHaveLength(1);
		expect(loadedNotes[0]?.reason).toBe("exit");
	}, 60_000);

	test("session/load prints the orphan subagent notice on stderr, and stdout stays frames", async () => {
		const f = fixture([{ text: "unused" }]);
		const store = seedConversation(f);
		// What a previous process left in the file: a subagent run nobody
		// finished, and a close-out naming two background shells — whose summary
		// must NOT print here, because its sentence sends the reader to `/ps`, a
		// command no editor session has.
		store.appendCustom("subagent_start", { sidechainId: "sidechain-orphan", agentType: "researcher" });
		store.appendCustom("mission", { at: Date.now() - 30_000, reason: "exit", shellsRunning: 2, subagentsLive: 0 });
		const sessionId = store.sessionId ?? "";

		const client = await withAcp(f, ["acp"], async (client) => {
			await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const response = await client.request("session/load", { sessionId, cwd: f.dir, mcpServers: [] });
			expect(response.error).toBeUndefined();
		});
		await client.drained;
		await client.stderrDrained;

		expect(client.stderr()).toContain(
			"Warning: 1 subagent run from a previous run never finished: sidechain-orphan (researcher)",
		);
		expect(client.stderr()).not.toContain("see /ps");
		// The notice is stderr only: stdout is frames and nothing else, exactly as
		// the purity assertion in the first test of this file demands.
		expect(client.junk).toEqual([]);
		expect(client.rawLines.length).toBe(client.frames.length);
		for (const frame of client.frames) {
			expect(frame.jsonrpc).toBe("2.0");
		}
	}, 60_000);

	test("a live session carries the board tools, and a TaskCreate is visible to TaskList in it", async () => {
		const f = fixture([
			{
				tool: {
					name: "TaskCreate",
					input: { subject: "Ship the ACP board", description: "wire the live session's store" },
				},
			},
			{ tool: { name: "TaskList", input: {} } },
			{ text: "board ready" },
		]);
		let sessionId = "";
		await withAcp(f, ["acp"], async (client) => {
			sessionId = await openSession(client, f.dir);
			const response = await client.promptResult(await client.startPrompt(sessionId, "set up the board"));
			expect(response.error).toBeUndefined();
			expect(response.result?.stopReason).toBe("end_turn");

			// The tools as they went over the wire, not merely as this file intends:
			// the four names are in the request the stub actually received.
			const body = f.stub.requests[0]?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined;
			const advertised = (body?.tools ?? []).map((tool) => tool.function?.name);
			for (const name of TASK_BOARD_TOOL_NAMES) expect(advertised).toContain(name);

			// TaskList's answer carried the task TaskCreate made a moment earlier in
			// this session — one shared store, through the host's tool list.
			const answers = client
				.updates()
				.filter((update) => update.sessionUpdate === "tool_call_update")
				.map((update) => JSON.stringify(update.content ?? ""));
			expect(answers.some((text) => text.includes("Ship the ACP board"))).toBe(true);
		});

		// The board reached this session's own file, as the same `custom` entry kind
		// the REPL and a `-p` run write — what a later session/load resumes from.
		const path = SessionStore.listSessions(f.dir, f.home).find((session) => session.sessionId === sessionId)?.path;
		if (!path) throw new Error(`no session file for ${sessionId}`);
		const snapshot = fileEntries(path).find((entry) => entry.type === "custom" && entry.kind === "tasks");
		expect((snapshot?.data as Array<{ subject?: string }> | undefined)?.[0]?.subject).toBe("Ship the ACP board");
	}, 60_000);

	test("session/load restores the loaded session's board into its tools", async () => {
		const f = fixture([{ tool: { name: "TaskList", input: {} } }, { text: "listed" }]);
		const store = SessionStore.startNew(f.dir, f.home);
		store.appendMessage(userMessage("what was I doing"));
		// The snapshot a previous run would have left: the same shape
		// `readTaskSnapshot` validates, so a malformed fixture would be ignored
		// rather than restored, and the test would fail on the answer below.
		store.appendCustom("tasks", [
			{
				id: "1",
				subject: "Resume the board",
				description: "restored from the session file",
				status: "in_progress",
				blockedBy: [],
				createdAt: Date.now(),
			},
		]);
		const sessionId = store.sessionId ?? "";
		expect(sessionId).not.toBe("");

		await withAcp(f, ["acp"], async (client) => {
			await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
			const loaded = await client.request("session/load", { sessionId, cwd: f.dir, mcpServers: [] });
			expect(loaded.error).toBeUndefined();
			const response = await client.promptResult(await client.startPrompt(sessionId, "what is on the board?"));
			expect(response.error).toBeUndefined();
			const answers = client
				.updates()
				.filter((update) => update.sessionUpdate === "tool_call_update")
				.map((update) => JSON.stringify(update.content ?? ""));
			expect(answers.some((text) => text.includes("Resume the board"))).toBe(true);
		});
	}, 60_000);
});

/**
 * Rewrite the home settings with the fixture's provider plus extra keys.
 *
 * The home tier is the trusted one: project keys are reported as untrusted (the
 * fixture's own project hooks block exists to produce that stderr line), so a
 * hook or a compaction knob written into a project file would never run.
 */
function writeHomeSettings(f: Fixture, extra: Record<string, unknown>): void {
	writeFileSync(
		join(f.home, ".labunbun", "settings.json"),
		JSON.stringify({
			model: "stub/stub-model",
			providers: {
				openaiCompatible: [
					{
						id: "stub",
						baseUrl: f.stub.openAIBaseUrl,
						apiKeyEnv: "STUB_KEY",
						models: [{ id: "stub-model", contextWindow: 200_000, maxOutputTokens: 8_192 }],
					},
				],
			},
			...extra,
		}),
	);
}

/** Wait for a file a hook writes; the hook runs outside the awaited path. */
async function waitForFile(path: string, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
}

/** The file of the session the editor created, or a fixture that failed to save. */
function sessionPath(f: Fixture, sessionId: string): string {
	const path = SessionStore.listSessions(f.dir, f.home).find((session) => session.sessionId === sessionId)?.path;
	if (!path) throw new Error(`no session file for ${sessionId}`);
	return path;
}

/** A hook script that records the payload it was handed, then replies once. */
function payloadHook(f: Fixture, name: string, marker: string, reply: string): string {
	const script = join(f.dir, `${name}.mjs`);
	writeFileSync(
		script,
		'import { writeFileSync } from "node:fs";\n' +
			'let input = "";\n' +
			"for await (const chunk of process.stdin) input += chunk;\n" +
			`writeFileSync(${JSON.stringify(marker)}, input);\n` +
			(reply ? `console.log(${JSON.stringify(reply)});\n` : ""),
	);
	return `${process.execPath} ${script}`;
}

describe("the compaction hooks in an ACP session", () => {
	// A 20k-character prompt is ~5k estimated tokens, which clears a threshold of
	// 1% of a 200k window (2k) with room to spare: the automatic pass is certain
	// to be asked, so what the hook sees — or whether it is consulted at all — is
	// what these tests are about.
	const LONG_PROMPT = "x".repeat(20_000);

	test("a PreCompact hook vetoes the automatic pass, and no summary is requested", async () => {
		// The same veto the REPL and a `-p` run honor. An editor has no dialog, so
		// a hook is the workspace's word — and a blocked estimate-driven pass must
		// leave the transcript alone rather than pay for a summary anyway.
		const f = fixture([{ text: "holding" }]);
		const marker = join(f.dir, "precompact.json");
		const command = payloadHook(
			f,
			"precompact",
			marker,
			JSON.stringify({ decision: "block", reason: "editor said no" }),
		);
		writeHomeSettings(f, {
			compaction: { thresholdPercent: 1 },
			hooks: { PreCompact: [{ hooks: [{ type: "command", command }] }] },
		});

		let sessionId = "";
		await withAcp(f, ["acp"], async (client) => {
			sessionId = await openSession(client, f.dir);
			const response = await client.promptResult(await client.startPrompt(sessionId, LONG_PROMPT));
			expect(response.error).toBeUndefined();
			expect(response.result?.stopReason).toBe("end_turn");
		});

		// The veto came before the manager: the only model call is the prompt.
		expect(f.stub.requests).toHaveLength(1);
		// The hook really saw the pass it vetoed, so silence is not the story.
		const payload = JSON.parse(readFileSync(marker, "utf8")) as { trigger?: string };
		expect(payload.trigger).toBe("auto");
		// And the session file carries no boundary, so a resume replays it unchanged.
		expect(fileEntries(sessionPath(f, sessionId)).some((entry) => entry.type === "compaction")).toBe(false);
	}, 60_000);

	test("a completed compaction fires PostCompact with the trigger and the sizes", async () => {
		// The observer event: the pass completed, the editor's surface is stderr,
		// and the hook's answer cannot change what already happened. The payload is
		// the same one the REPL hands over, through the ACP host.
		const f = fixture([{ text: "<summary>1. Primary Request: a long prompt</summary>" }, { text: "done" }]);
		const marker = join(f.dir, "postcompact.json");
		const command = payloadHook(f, "postcompact", marker, "");
		writeHomeSettings(f, {
			compaction: { thresholdPercent: 1 },
			hooks: { PostCompact: [{ hooks: [{ type: "command", command }] }] },
		});

		let sessionId = "";
		await withAcp(f, ["acp"], async (client) => {
			sessionId = await openSession(client, f.dir);
			const response = await client.promptResult(await client.startPrompt(sessionId, LONG_PROMPT));
			expect(response.error).toBeUndefined();
			expect(response.result?.stopReason).toBe("end_turn");
			// The `onPhase` contract is synchronous, so the hook run is not awaited
			// by the manager; poll while the child is still up.
			await waitForFile(marker);
		});

		const payload = JSON.parse(readFileSync(marker, "utf8")) as {
			event?: string;
			session_id?: string;
			cwd?: string;
			trigger?: string;
			pre_tokens?: number;
			post_tokens?: number;
		};
		expect(payload.event).toBe("PostCompact");
		expect(payload.trigger).toBe("auto");
		expect(payload.session_id).toBe(sessionId);
		expect(payload.cwd).toBe(f.dir);
		expect(payload.pre_tokens ?? 0).toBeGreaterThan(0);
		expect(typeof payload.post_tokens).toBe("number");
		// The store recorded the pass the hook was told about.
		expect(fileEntries(sessionPath(f, sessionId)).some((entry) => entry.type === "compaction")).toBe(true);
	}, 60_000);
});
