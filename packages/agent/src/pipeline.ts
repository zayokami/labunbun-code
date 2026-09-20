/**
 * Per-tool-call execution pipeline:
 *   zod safeParse → validateInput → beforeToolCall hooks → canUseTool
 *   → tool.call → afterToolCall hooks → bound the result → ToolResultMessage
 *
 * Every failure mode produces an isError ToolResultMessage — the pipeline
 * never throws, so the loop always has paired results for the wire.
 */
import type { ToolResultMessage } from "@labunbun/ai";
import { textContent, toolResultMessage } from "@labunbun/ai";
import { cutContent, type SpillWriter } from "./output-limits.ts";
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

/**
 * True once the run has been cancelled — checked before each pipeline stage
 * so an abort (user interrupt, hot-swap) during an async gate (validation,
 * hooks, permission dialog) or while queued behind a serial batch never
 * reaches tool execution. Cancelled calls still return a paired isError
 * result so the wire's tool_use/tool_result pairing stays intact.
 */
function isAborted(ctx: Omit<ToolCallContext, "onUpdate">): boolean {
	return ctx.signal.aborted;
}

const ABORTED_RESULT_TEXT = "Tool execution aborted";

export async function runToolPipeline(options: PipelineRunOptions): Promise<ToolResultMessage> {
	const { callId, tool, rawInput, deps, ctx, permissionContext } = options;
	const finish = (result: ToolResult): ToolResultMessage =>
		bound(toolResultMessage(callId, tool.name, result.content, result.isError ?? false), tool, deps.spillOutput);

	try {
		// 0. Cancellation — an already-aborted signal never reaches the tool.
		if (isAborted(ctx)) {
			return finish({ content: [textContent(ABORTED_RESULT_TEXT)], isError: true });
		}

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
		if (isAborted(ctx)) {
			return finish({ content: [textContent(ABORTED_RESULT_TEXT)], isError: true });
		}

		// 3. Loop hooks (before)
		// Before the permission check on purpose: a hook is the user's own code
		// and is how prompt policies get enforced (e.g. "block anything touching
		// prod"), so it must be able to refuse a call that permissions would
		// otherwise allow. The corresponding hazard — a *repo* shipping hooks
		// that run before the agent's own guardrails — is handled at the source,
		// by refusing hooks from project/local settings tiers; by the time a
		// hooksRuntime exists here, every hook in it came from the user.
		if (deps.hooks?.beforeToolCall) {
			const decision = await deps.hooks.beforeToolCall(tool.name, input, permissionContext);
			if (decision?.block) {
				return finish({
					content: [textContent(decision.reason ?? "Blocked by beforeToolCall hook")],
					isError: true,
				});
			}
		}
		if (isAborted(ctx)) {
			return finish({ content: [textContent(ABORTED_RESULT_TEXT)], isError: true });
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

		// 5. Execute — recheck after the permission wait: a dialog resolved only
		// because the user interrupted must not run the tool anyway.
		if (isAborted(ctx)) {
			return finish({ content: [textContent(ABORTED_RESULT_TEXT)], isError: true });
		}
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
			// Bounded like any other result: what a hook returns is still going into
			// the context, and an unbounded replacement would be a way to put a
			// megabyte there that no limit in this file can see.
			if (replaced) resultMessage = bound(replaced, tool, deps.spillOutput);
		}
		return resultMessage;
	} catch (error) {
		// Hook failures and unexpected pipeline errors — still never throw, and
		// still bounded: this is a result like any other, and the branch that
		// reports the failure is not exempt from the limit it might exceed.
		const message = error instanceof Error ? error.message : String(error);
		return finish({ content: [textContent(`Pipeline error: ${message}`)], isError: true });
	}
}

/**
 * Enforce the tool's own limit on one result.
 *
 * A tool that declared `overflow: "spill"` gets the full text written out and a
 * pointer instead of a dead end; every other tool is cut in place, which is the
 * right answer for a result that can be asked for again — a file read at a
 * smaller range costs the model one call, and a spilled copy of a file that is
 * still on disk is a copy nobody asked for.
 */
function bound(message: ToolResultMessage, tool: AnyTool, spill?: SpillWriter): ToolResultMessage {
	const limit = tool.maxResultSizeChars ?? MAX_RESULT_CHARS_DEFAULT;
	const writer = tool.overflow === "spill" ? spill : undefined;
	const request = { callId: message.toolCallId, toolName: message.toolName, text: "" };
	return { ...message, content: cutContent(message.content, limit, writer, request) };
}
