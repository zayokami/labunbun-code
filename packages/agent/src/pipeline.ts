/**
 * Per-tool-call execution pipeline:
 *   zod safeParse → validateInput → beforeToolCall hooks → canUseTool
 *   → tool.call → afterToolCall hooks → truncate → ToolResultMessage
 *
 * Every failure mode produces an isError ToolResultMessage — the pipeline
 * never throws, so the loop always has paired results for the wire.
 */
import type { ToolResultMessage } from "@labunbun/ai";
import { textContent, toolResultMessage } from "@labunbun/ai";
import type { AgentDeps, AnyTool, PermissionContext, ToolCallContext, ToolResult } from "./types.ts";

export interface PipelineRunOptions {
	callId: string;
	tool: AnyTool;
	rawInput: unknown;
	deps: AgentDeps;
	ctx: Omit<ToolCallContext, "onUpdate">;
	permissionContext: PermissionContext;
	onUpdate: (partial: unknown) => void;
}

const MAX_RESULT_CHARS_DEFAULT = 30_000;

export async function runToolPipeline(options: PipelineRunOptions): Promise<ToolResultMessage> {
	const { callId, tool, rawInput, deps, ctx, permissionContext } = options;
	const finish = (result: ToolResult): ToolResultMessage =>
		truncate(toolResultMessage(callId, tool.name, result.content, result.isError ?? false), tool);

	try {
		// 1. Schema validation
		const parsed = tool.inputSchema.safeParse(rawInput);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const path = issue?.path?.length ? ` at "${issue.path.join(".")}"` : "";
			return finish({
				content: [
					textContent(
						`InputValidationError: ${issue?.message ?? "invalid input"}${path}\nInput was: ${JSON.stringify(rawInput)}`,
					),
				],
				isError: true,
			});
		}
		let input: unknown = parsed.data;

		// 2. Semantic validation
		if (tool.validateInput) {
			const error = await tool.validateInput(input);
			if (error) {
				return finish({ content: [textContent(`Validation failed: ${error}`)], isError: true });
			}
		}

		// 3. Loop hooks (before)
		if (deps.hooks?.beforeToolCall) {
			const decision = await deps.hooks.beforeToolCall(tool.name, input, permissionContext);
			if (decision?.block) {
				return finish({
					content: [textContent(decision.reason ?? "Blocked by beforeToolCall hook")],
					isError: true,
				});
			}
		}

		// 4. Permissions — the resolver must resolve "ask" itself (dialog); a
		// bare "ask" result here means nobody resolved it, so fail safe.
		if (deps.canUseTool) {
			const decision = await deps.canUseTool(tool.name, input, permissionContext);
			if (decision.behavior === "deny") {
				return finish({ content: [textContent(decision.message)], isError: true });
			}
			if (decision.behavior === "ask") {
				return finish({
					content: [textContent(`Permission required but unresolved: ${decision.message ?? tool.name}`)],
					isError: true,
				});
			}
			if (decision.updatedInput !== undefined) {
				input = decision.updatedInput;
			}
		}

		// 5. Execute
		let result: ToolResult;
		try {
			result = await tool.call(input, { ...ctx, onUpdate: options.onUpdate });
		} catch (error) {
			const aborted = ctx.signal.aborted;
			const message = error instanceof Error ? error.message : String(error);
			return finish({
				content: [textContent(aborted ? `Tool execution aborted` : `Tool error: ${message}`)],
				isError: true,
			});
		}

		// 6. Loop hooks (after) — may replace the result message
		let resultMessage = finish(result);
		if (deps.hooks?.afterToolCall) {
			const replaced = await deps.hooks.afterToolCall(tool.name, input, resultMessage);
			if (replaced) resultMessage = replaced;
		}
		return resultMessage;
	} catch (error) {
		// Hook failures and unexpected pipeline errors — still never throw.
		const message = error instanceof Error ? error.message : String(error);
		return toolResultMessage(callId, tool.name, [textContent(`Pipeline error: ${message}`)], true);
	}
}

function truncate(message: ToolResultMessage, tool: AnyTool): ToolResultMessage {
	const limit = tool.maxResultSizeChars ?? MAX_RESULT_CHARS_DEFAULT;
	let total = 0;
	const content = message.content.map((block) => {
		if (block.type !== "text") return block;
		const remaining = limit - total;
		if (block.text.length <= remaining) {
			total += block.text.length;
			return block;
		}
		const truncated =
			remaining > 100
				? `${block.text.slice(0, remaining)}\n... [truncated ${block.text.length - remaining} chars]`
				: "[output truncated]";
		total = limit;
		return { type: "text" as const, text: truncated };
	});
	return { ...message, content };
}
