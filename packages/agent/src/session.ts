/**
 * AgentSession — the stateful conversation runner.
 *
 * Loop shape (per plan): context prep → drain steering → stream → finalize →
 * branch on stopReason → tool execution → feed results back. The presence of
 * toolCall blocks is THE loop-continue signal; stopReason alone is never
 * trusted (OpenAI-family finish_reason is unreliable).
 *
 * Recovery features ported from the reference architecture:
 * - orphaned tool_use synthesis on abnormal termination (wire pairing)
 * - max_output_tokens ladder (escalate once, then ≤3 continue-retries)
 * - steering queue (inject before next model call) and followUp queue
 *   (restart after natural termination)
 */
import type {
	AgentMessage,
	AssistantMessage,
	Context,
	Model,
	StreamOptions,
	ToolCall,
	ToolResultMessage,
} from "@labunbun/ai";
import { textContent, toolResultMessage, userMessage } from "@labunbun/ai";
import { partitionToolCalls } from "./concurrency.ts";
import { runToolPipeline } from "./pipeline.ts";
import type {
	AgentDeps,
	AgentEndReason,
	AgentEvent,
	AgentEventHandler,
	AnyTool,
	PermissionMode,
	ResolvedToolCall,
} from "./types.ts";
import { toWireTools } from "./types.ts";

export interface AgentSessionOptions {
	model: Model;
	systemPrompt?: string;
	tools?: AnyTool[];
	deps: AgentDeps;
	store?: import("./session-store.ts").SessionStore;
	cwd?: string;
	maxTurns?: number;
	permissionMode?: PermissionMode;
}

const MAX_OUTPUT_TOKENS_CAP = 64_000;
const LENGTH_CONTINUE_RETRIES = 3;

export class AgentSession {
	readonly cwd: string;
	messages: AgentMessage[] = [];

	#model: Model;
	#systemPrompt: string;
	#tools: AnyTool[];
	#wireTools: Context["tools"];
	#deps: AgentDeps;
	#store?: import("./session-store.ts").SessionStore;
	#maxTurns: number;
	#permissionMode: PermissionMode;

	#handlers = new Set<AgentEventHandler>();
	#steering: string[] = [];
	#followUp: string[] = [];
	#abortController: AbortController | null = null;
	#running = false;

	constructor(options: AgentSessionOptions) {
		this.#model = options.model;
		this.#systemPrompt = options.systemPrompt ?? "";
		this.#tools = [...(options.tools ?? [])];
		this.#deps = options.deps;
		this.#store = options.store;
		this.cwd = options.cwd ?? process.cwd();
		this.#maxTurns = options.maxTurns ?? Number.POSITIVE_INFINITY;
		this.#permissionMode = options.permissionMode ?? "default";
		// Freeze wire-tool order at construction for prompt-cache stability.
		this.#wireTools = toWireTools(this.#tools);
	}

	// -- configuration --------------------------------------------------------

	get model(): Model {
		return this.#model;
	}

	setModel(model: Model): void {
		this.#model = model;
	}

	get tools(): readonly AnyTool[] {
		return this.#tools;
	}

	setTools(tools: AnyTool[]): void {
		this.#tools = [...tools];
		this.#wireTools = toWireTools(this.#tools);
	}

	setSystemPrompt(prompt: string): void {
		this.#systemPrompt = prompt;
	}

	setPermissionMode(mode: PermissionMode): void {
		this.#permissionMode = mode;
	}

	get permissionMode(): PermissionMode {
		return this.#permissionMode;
	}

	get isRunning(): boolean {
		return this.#running;
	}

	// -- events ---------------------------------------------------------------

	on(handler: AgentEventHandler): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	async #emit(event: AgentEvent): Promise<void> {
		for (const handler of this.#handlers) {
			await handler(event);
		}
	}

	// -- queues ---------------------------------------------------------------

	/** Inject a message into the CURRENT run, before the next model call. */
	steer(text: string): void {
		this.#steering.push(text);
	}

	/** Queue a message that restarts the loop after natural termination. */
	followUp(text: string): void {
		if (this.#running) {
			this.#followUp.push(text);
		} else {
			void this.prompt(text);
		}
	}

	abort(): void {
		// Dropping queued follow-ups on explicit abort is the least surprising
		// behavior — stale queued prompts should not fire after an interrupt.
		this.#followUp = [];
		this.#abortController?.abort();
	}

	// -- the loop -------------------------------------------------------------

	async prompt(text: string): Promise<AgentEndReason> {
		if (this.#running) throw new Error("AgentSession is already running");
		this.#running = true;
		this.#abortController = new AbortController();

		const userMsg = userMessage(text);
		this.messages.push(userMsg);
		this.#store?.appendMessage(userMsg);

		let reason: AgentEndReason = "completed";
		let errorMessage: string | undefined;
		let escalatedOnce = false;
		let continueRetries = 0;
		let turns = 0;

		await this.#emit({ type: "agent_start" });

		try {
			while (true) {
				// ---- context preparation ----
				let context: Context = {
					systemPrompt: this.#systemPrompt,
					messages: this.messages,
					tools: this.#wireTools,
				};
				if (this.#deps.hooks?.transformContext) {
					context = await this.#deps.hooks.transformContext(context);
				}
				if (this.#deps.checkCompaction) {
					const compacted = await this.#deps.checkCompaction(context);
					if (compacted) {
						this.messages = compacted.messages;
						context = compacted;
					}
				}

				// Drain steering queue ahead of the model call.
				while (this.#steering.length > 0) {
					const text = this.#steering.shift();
					if (text === undefined) break;
					const steerMsg = userMessage(text);
					this.messages.push(steerMsg);
					this.#store?.appendMessage(steerMsg);
				}

				turns++;
				if (turns > this.#maxTurns) {
					reason = "max_turns";
					break;
				}
				await this.#emit({ type: "turn_start" });

				// ---- stream the assistant turn ----
				const streamOptions: StreamOptions = {
					signal: this.#abortController.signal,
					maxOutputTokens: escalatedOnce ? Math.min(this.#model.maxOutputTokens * 2, MAX_OUTPUT_TOKENS_CAP) : undefined,
				};

				let assistant: AssistantMessage | null = null;
				let lastPartial: AssistantMessage | null = null;
				// Streaming tool execution: concurrency-safe tools start the moment
				// their toolCall block completes, while the model keeps streaming.
				const earlyResults = new Map<string, ToolResultMessage>();
				const earlyPromises = new Map<string, Promise<void>>();
				try {
					for await (const event of this.#deps.streamFn(this.#model, context, streamOptions)) {
						if (event.type === "done" || event.type === "error") {
							assistant = event.message;
						} else {
							lastPartial = event.partial;
							await this.#emit({
								type: "message_update",
								message: event.partial,
								assistantMessageEvent: event,
							});
							if (event.type === "toolcall_end") {
								this.#maybeStartEarlyTool(event.toolCall, earlyResults, earlyPromises);
							}
						}
					}
				} catch (streamError) {
					// Retry wrapper converts pre-content failures to error events;
					// mid-stream throws land here. Keep the last partial so any
					// already-streamed toolCall blocks still get paired results.
					if (this.#abortController.signal.aborted) {
						assistant = lastPartial
							? { ...lastPartial, stopReason: "aborted" }
							: interruptedAssistant(this.#model, "aborted");
					} else {
						throw streamError;
					}
				}

				if (!assistant) {
					assistant = interruptedAssistant(this.#model, "error", "Provider stream produced no terminal event");
				}

				// ---- length recovery ladder ----
				if (assistant.stopReason === "length") {
					if (!escalatedOnce && this.#model.maxOutputTokens < MAX_OUTPUT_TOKENS_CAP) {
						// Discard the truncated partial and retry with more room.
						escalatedOnce = true;
						continue;
					}
					if (continueRetries < LENGTH_CONTINUE_RETRIES) {
						continueRetries++;
						const resume = userMessage(
							"Your previous response was cut off by the output limit. Continue exactly where you left off — do not repeat completed work.",
						);
						this.messages.push(resume);
						this.#store?.appendMessage(resume);
						continue;
					}
					// Ladder exhausted.
					this.messages.push(assistant);
					this.#store?.appendMessage(assistant);
					errorMessage = "Response repeatedly exceeded the output token limit";
					reason = "error";
					break;
				}

				// ---- persist the finalized assistant message ----
				this.messages.push(assistant);
				this.#store?.appendMessage(assistant);

				// ---- abnormal termination ----
				if (assistant.stopReason === "aborted") {
					this.#synthesizeOrphanResults(assistant);
					reason = "aborted";
					break;
				}
				if (assistant.stopReason === "error") {
					this.#synthesizeOrphanResults(assistant);
					errorMessage = assistant.errorMessage ?? "Unknown provider error";
					reason = "error";
					break;
				}

				// ---- tool-call dispatch (THE loop-continue signal) ----
				const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
				if (toolCalls.length === 0) {
					await this.#emit({ type: "turn_end", message: assistant, toolResults: [] });
					const followUpText = this.#followUp.shift();
					if (followUpText !== undefined) {
						const followUpMsg = userMessage(followUpText);
						this.messages.push(followUpMsg);
						this.#store?.appendMessage(followUpMsg);
						continue;
					}
					break;
				}

				const results = await this.#executeToolCalls(toolCalls, earlyPromises, earlyResults);
				for (const result of results) {
					this.messages.push(result);
					this.#store?.appendMessage(result);
				}
				await this.#emit({ type: "turn_end", message: assistant, toolResults: results });
			}
		} catch (loopError) {
			reason = "error";
			errorMessage = loopError instanceof Error ? loopError.message : String(loopError);
			// Pair any dangling tool_use from the last assistant message.
			const lastAssistant = [...this.messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
			if (lastAssistant) this.#synthesizeOrphanResults(lastAssistant);
		} finally {
			this.#running = false;
			this.#abortController = null;
			await this.#emit({ type: "agent_end", reason, messages: this.messages, errorMessage });
		}

		return reason;
	}

	// -- tool execution -------------------------------------------------------

	async #executeToolCalls(
		toolCalls: ToolCall[],
		earlyPromises: Map<string, Promise<void>>,
		earlyResults: Map<string, ToolResultMessage>,
	): Promise<ToolResultMessage[]> {
		const resolved: ResolvedToolCall[] = [];
		const unknownResults: ToolResultMessage[] = [];

		for (const call of toolCalls) {
			if (earlyPromises.has(call.id)) continue; // already executing from the stream
			const tool = this.#tools.find((t) => t.name === call.name);
			if (!tool?.isEnabled?.()) {
				unknownResults.push(toolResultMessage(call.id, call.name, [textContent(`Unknown tool: ${call.name}`)], true));
				continue;
			}
			resolved.push({ callId: call.id, tool, input: parseArguments(call.arguments) });
		}

		const resultsByCallId = new Map<string, ToolResultMessage>();
		for (const r of unknownResults) resultsByCallId.set(r.toolCallId, r);

		const batches = partitionToolCalls(resolved);
		for (const batch of batches) {
			if (batch.parallel) {
				await Promise.all(batch.calls.map((call) => this.#runOne(call, resultsByCallId)));
			} else {
				for (const call of batch.calls) {
					await this.#runOne(call, resultsByCallId);
				}
			}
		}

		// Wait for tools that started mid-stream and merge their buffered results.
		if (earlyPromises.size > 0) {
			await Promise.all(earlyPromises.values());
			for (const [callId, result] of earlyResults) {
				resultsByCallId.set(callId, result);
			}
		}

		// Assemble strictly in assistant source order.
		return toolCalls.map((call) => resultsByCallId.get(call.id)).filter((r) => r !== undefined);
	}

	/**
	 * Start a concurrency-safe tool while the model is still streaming. Unsafe
	 * tools wait for the normal post-message path so they never overlap.
	 */
	#maybeStartEarlyTool(
		toolCall: ToolCall,
		earlyResults: Map<string, ToolResultMessage>,
		earlyPromises: Map<string, Promise<void>>,
	): void {
		if (this.#abortController?.signal.aborted) return;
		const tool = this.#tools.find((t) => t.name === toolCall.name);
		if (!tool?.isEnabled?.()) return;
		const input = parseArguments(toolCall.arguments);
		if (!tool.isConcurrencySafe?.(input)) return;

		const resolved: ResolvedToolCall = { callId: toolCall.id, tool, input };
		const promise = this.#runOne(resolved, earlyResults).catch(() => {
			// #runOne never throws by contract; belt-and-braces for event handler
			// rejections — orphan synthesis covers any missing result.
		});
		earlyPromises.set(toolCall.id, promise);
	}

	async #runOne(call: ResolvedToolCall, out: Map<string, ToolResultMessage>): Promise<void> {
		const signal = this.#abortController?.signal ?? new AbortController().signal;
		await this.#emit({
			type: "tool_execution_start",
			callId: call.callId,
			toolName: call.tool.name,
			input: call.input,
		});

		const result = await runToolPipeline({
			callId: call.callId,
			tool: call.tool,
			rawInput: call.input,
			deps: this.#deps,
			ctx: { callId: call.callId, signal, cwd: this.cwd },
			permissionContext: {
				mode: this.#permissionMode,
				toolName: call.tool.name,
				input: call.input,
				cwd: this.cwd,
			},
			onUpdate: (partial) => {
				void this.#emit({
					type: "tool_execution_update",
					callId: call.callId,
					toolName: call.tool.name,
					partial,
				});
			},
		});

		out.set(result.toolCallId, result);
		await this.#emit({
			type: "tool_execution_end",
			callId: call.callId,
			toolName: call.tool.name,
			result,
		});
	}

	/**
	 * Synthesize isError tool_results for every tool_use block that never got a
	 * paired result — both wire APIs require strict pairing on the next request,
	 * so resuming without this corrupts the conversation.
	 */
	#synthesizeOrphanResults(assistant: AssistantMessage): void {
		const existing = new Set(
			this.messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => m.toolCallId),
		);
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || existing.has(block.id)) continue;
			const orphan = toolResultMessage(
				block.id,
				block.name,
				[textContent("Tool execution was interrupted before completion.")],
				true,
			);
			this.messages.push(orphan);
			this.#store?.appendMessage(orphan);
		}
	}
}

function interruptedAssistant(model: Model, stopReason: "error" | "aborted", message?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason,
		errorMessage: message ?? (stopReason === "aborted" ? "Interrupted by user" : "Unknown error"),
		timestamp: Date.now(),
	};
}

function parseArguments(raw: string): unknown {
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		// Let the pipeline's zod validation produce the proper error result.
		return { __malformedArguments: raw };
	}
}
