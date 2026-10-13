#!/usr/bin/env bun
/**
 * Demo: the Agent Client Protocol server, driven the way an editor drives it.
 *
 * One real `labunbun acp` child process and JSON-RPC 2.0 over stdio with
 * newline-delimited framing. The demo walks the editor's sequence —
 * initialize → session/load (a seeded conversation, replayed as frames before
 * the response) → session/new → session/prompt, with one Write call whose
 * permission request the demo answers like a person would — and prints every
 * `session/update` as it arrives.
 *
 * No network beyond loopback and no real keys: the model is a stub the
 * settings point at (`127.0.0.1`), the keys are fake literals, and the home is
 * a temp directory. The real home is never read.
 *
 * Usage: bun run scripts/acp-demo.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../packages/agent/src/index.ts";
import { assistantMessage, toolResultMessage, userMessage } from "../packages/ai/src/index.ts";
import { type StubStep, startCacheStub } from "../packages/ai/test/cache-stub-server.ts";
import { shortSessionId } from "../packages/coding-agent/src/session-resume.ts";

const CLI = join(import.meta.dir, "..", "packages", "coding-agent", "bin", "labunbun.ts");

const roots: string[] = [];
const stubs: Array<ReturnType<typeof startCacheStub>> = [];

function cleanup(): void {
	for (const stub of stubs.splice(0)) stub.stop();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/**
 * A temp directory, physically spelled: on macOS `tmpdir()` is a symlink and
 * the child keys its session store by its own physical `process.cwd()`, while
 * this process would keep the symbolic spelling — two sizes of the same path.
 */
function scratch(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	roots.push(dir);
	return dir;
}

interface Frame {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

/** The pieces of the spawned child this demo uses. */
interface ChildPipes {
	stdin: { write(data: string): unknown; flush(): unknown; end(): unknown };
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}

/**
 * The client side of the protocol: frames are collected rather than consumed,
 * so the demo can assert on ordering after the fact, and `onFrame` prints each
 * one the moment it lands on the wire.
 */
class DemoClient {
	readonly frames: Frame[] = [];
	/** Lines that were not JSON at all — the purity check looks here. */
	readonly junk: string[] = [];
	readonly drained: Promise<void>;
	readonly stderrDrained: Promise<void>;
	onFrame: ((frame: Frame) => void) | undefined;
	#stderrText = "";
	#nextId = 0;
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
		let frame: Frame;
		try {
			frame = JSON.parse(line) as Frame;
		} catch {
			this.junk.push(line);
			return;
		}
		this.frames.push(frame);
		this.onFrame?.(frame);
	}

	stderr(): string {
		return this.#stderrText;
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
				throw new Error(`timed out waiting for ${what} — stderr: ${this.#stderrText.slice(-2000)}`);
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		}
	}

	async close(): Promise<number> {
		await this.#proc.stdin.end();
		return await this.#proc.exited;
	}
}

/** One line for one `session/update` payload, as it arrives. */
function describeUpdate(update: Record<string, unknown>): string {
	const kind = String(update.sessionUpdate ?? "?");
	const content = update.content as { text?: unknown } | undefined;
	if (content !== null && typeof content === "object" && !Array.isArray(content) && typeof content.text === "string") {
		return `${kind} ${JSON.stringify(content.text)}`;
	}
	const title = typeof update.title === "string" ? ` ${update.title}` : "";
	const status = typeof update.status === "string" ? ` (${update.status})` : "";
	return `${kind}${title}${status}`;
}

async function main(): Promise<void> {
	console.log("# acp demo — the editor's side of `labunbun acp`: NDJSON frames over stdio");

	const home = scratch("lbb-demo-acp-home-");
	const dir = scratch("lbb-demo-acp-proj-");
	const out = join(dir, "out.txt");

	const steps: StubStep[] = [
		{ tool: { name: "Write", input: { file_path: out, content: "written by the acp demo\n" } } },
		{ text: "done — out.txt written" },
	];
	const stub = startCacheStub({ steps, modelId: "stub-model" });
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
	// A repo-controlled settings tier, so the child has something to say on
	// stderr — the stream that must never carry a frame.
	mkdirSync(join(dir, ".labunbun"), { recursive: true });
	writeFileSync(
		join(dir, ".labunbun", "settings.json"),
		JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
	);

	// The conversation a previous run left behind: what session/load has to replay.
	const seeded = SessionStore.startNew(dir, home);
	seeded.appendMessage(userMessage("what does the config say"));
	seeded.appendMessage(
		assistantMessage({
			content: [
				{ type: "thinking", thinking: "checking the config" },
				{ type: "text", text: "let me look" },
				{ type: "toolCall", id: "call_1", name: "Read", arguments: JSON.stringify({ file_path: "config.json" }) },
			],
		}),
	);
	seeded.appendMessage(toolResultMessage("call_1", "Read", [{ type: "text", text: "port = 8080" }]));
	seeded.appendMessage(assistantMessage({ content: [{ type: "text", text: "the port is 8080" }] }));
	const seedId = seeded.sessionId;
	if (!seedId) throw new Error("the seeded session has no id");

	const proc = Bun.spawn([process.execPath, CLI, "acp"], {
		cwd: dir,
		// Both names: homedir() reads USERPROFILE on Windows and HOME elsewhere.
		env: {
			...process.env,
			USERPROFILE: home,
			HOME: home,
			ANTHROPIC_API_KEY: "sk-not-a-real-key-for-demo",
			STUB_KEY: "stub-key-for-demo",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const client = new DemoClient(proc);
	client.onFrame = (frame) => {
		if (frame.method === "session/update") {
			console.log(`  ← ${describeUpdate((frame.params?.update as Record<string, unknown> | undefined) ?? {})}`);
		}
	};

	try {
		console.log("\n→ initialize");
		const init = await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
		console.log(
			`  ← protocolVersion ${String(init.result?.protocolVersion)}, capabilities ${JSON.stringify(init.result?.agentCapabilities)}`,
		);

		console.log(`\n→ session/load ${shortSessionId(seedId)}  (the stored history must arrive before the response)`);
		const before = client.frames.length;
		const load = await client.request("session/load", { sessionId: shortSessionId(seedId), cwd: dir, mcpServers: [] });
		const replayed = client.frames.slice(before).filter((frame) => frame.method === "session/update").length;
		if (load.error) throw new Error(`session/load failed: ${load.error.message}`);
		const loadModes = load.result?.modes as { currentModeId?: string } | undefined;
		console.log(`  ← load response: mode ${loadModes?.currentModeId}, ${replayed} update frames already on the wire`);

		console.log("\n→ session/new");
		const created = await client.request("session/new", { cwd: dir, mcpServers: [] });
		const sessionId = created.result?.sessionId;
		if (typeof sessionId !== "string") throw new Error("session/new returned no session id");
		const modes = created.result?.modes as { currentModeId?: string; availableModes?: unknown[] } | undefined;
		console.log(
			`  ← sessionId ${shortSessionId(sessionId)}, modes: ${modes?.currentModeId} of ${modes?.availableModes?.length ?? 0}`,
		);

		console.log('\n→ session/prompt "write out.txt"');
		const promptId = await client.startPrompt(sessionId, "write out.txt");
		const ask = await client.waitFor(
			(frames) => frames.find((frame) => frame.method === "session/request_permission"),
			"session/request_permission",
		);
		const options = (ask.params?.options as Array<{ kind: string }> | undefined) ?? [];
		console.log(
			`  ← session/request_permission (${options.map((option) => option.kind).join(", ")}) — answering allow_once`,
		);
		await client.respond(ask.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
		const response = await client.promptResult(promptId);
		console.log(`  ← prompt response: stopReason ${String(response.result?.stopReason)}`);
		console.log(`  out.txt now says ${JSON.stringify(readFileSync(out, "utf8"))}`);
	} finally {
		console.log(`\n# stdin closed — the child exits by itself: exit ${await client.close()}`);
	}
	await client.drained;
	await client.stderrDrained;
	console.log(`# stdout purity: ${client.frames.length} frames, ${client.junk.length} non-frame lines`);
	const stderrTail = client.stderr().trim().split("\n").filter(Boolean).pop();
	console.log(`# stderr (never parsed as frames), last line: ${stderrTail ?? "(empty)"}`);
}

try {
	await main();
} finally {
	cleanup();
}
