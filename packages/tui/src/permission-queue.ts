import { inputMatchesSpecifier } from "@labunbun/agent";
import type { PermissionDiff } from "./permission-diff.ts";
import { type PermissionReply, permissionOptions, ruleSpecifierFor } from "./permission-options.ts";
import type { PermissionDialogState } from "./ui-state.ts";

export interface PermissionRequestQueueOptions {
	/** Render this dialog as current, or clear it with null. */
	show: (dialog: PermissionDialogState | null) => void;
	/** Body text for the dialog: what the tool wants to do. */
	preview: (toolName: string, input: unknown) => string;
	/** The same input in full, for the dialog's Ctrl+A view. */
	fullPreview?: (toolName: string, input: unknown) => string;
	/**
	 * A renderable diff of the change this input will make, when the input is a
	 * change at all (`Edit`, `Write`). The dialog shows it in place of the
	 * preview; Ctrl+A still reaches the raw input.
	 */
	diffPreview?: (toolName: string, input: unknown) => PermissionDiff | undefined;
	/**
	 * Workspace root. Specifiers for file tools are relative paths, so without
	 * this the queue cannot tell what a granted rule does and will not apply it
	 * to anything still waiting.
	 */
	cwd?: string;
	/**
	 * Called when the user grants "don't ask again", with the input it was
	 * granted for — the scope of the rule depends on what they were looking at.
	 */
	onAlwaysAllow?: (toolName: string, input: unknown) => void;
	/**
	 * Called when the user answers "ask me every time", with the input they were
	 * looking at. The app layer records a session rule with the `ask` behavior,
	 * which is what brings the next match of the same scope back to this dialog:
	 * the opposite of `onAlwaysAllow`, and the scope is computed the same way.
	 */
	onAlwaysAsk?: (toolName: string, input: unknown) => void;
	/**
	 * May this queued call be answered from a grant the user just made, rather
	 * than by asking about it?
	 *
	 * The queue knows *matching* — whether the rule just granted covers this
	 * input. It does not know *policy*: the rules, the permission mode, or the
	 * sandbox. Those live in the app layer, so the app layer answers, and the
	 * answer is a fresh evaluation rather than a restatement of the match.
	 *
	 * Matching cannot stand in for that, because a queued request outlives the
	 * policy that raised it: a turn's concurrency-safe tools run in parallel, so
	 * a sibling can move the session into plan mode while an earlier `Write` is
	 * still sitting on a dialog. Whether the rule covers this input is a claim
	 * about the input; whether this session may run it *now* is a second question,
	 * and the queue holds nothing that could answer it.
	 *
	 * Optional, and its absence is the safe direction: a queue with no policy
	 * access keeps the old behaviour rather than guessing.
	 */
	canAutoResolve?: (toolName: string, input: unknown) => boolean;
}

export interface PermissionRequestQueue {
	/**
	 * Ask for permission; resolves with the answer. Answered in arrival order.
	 *
	 * `source` names who raised the ask when that is not this session — an ask
	 * forwarded from a subagent, carried to the dialog so the answer knows which
	 * worker is waiting. `signal` withdraws the ask: on abort the request leaves
	 * the queue and resolves false, which is how a stopped subagent's question
	 * gets off the screen without touching any other ask.
	 *
	 * The reply is a `PermissionReply` rather than a boolean because the fourth
	 * answer carries a sentence; every path that does not collect one resolves
	 * the boolean it always did, which normalizes to the same decision.
	 */
	request: (toolName: string, input: unknown, source?: string, signal?: AbortSignal) => Promise<PermissionReply>;
	/** Deny everything still pending — for a run that is being aborted. */
	clear: () => void;
}

/**
 * The permission dialog is a single slot, but requests for it are concurrent: a
 * turn runs its concurrency-safe tools in parallel, and several may need
 * approval. Handing every request straight to that slot would let a later one
 * overwrite an earlier one, and the overwritten request's promise would never
 * settle — its caller is the tool pipeline, which the whole batch awaits, so
 * the turn would stop there with no dialog on screen and nothing to press.
 *
 * So requests queue: the oldest is shown, and answering it shows the next.
 */
/** One request waiting its turn for the single dialog. */
interface PendingRequest {
	toolName: string;
	input: unknown;
	/** Who raised it, when that was not this session (see `request`). */
	source?: string;
	/** Tells this request from every other, including an earlier one for the same tool. */
	id: number;
	resolve: (reply: PermissionReply) => void;
}

export function createPermissionQueue(options: PermissionRequestQueueOptions): PermissionRequestQueue {
	const pending: PendingRequest[] = [];
	let nextId = 0;

	const show = (): void => {
		const next = pending[0];
		if (!next) {
			options.show(null);
			return;
		}
		options.show({
			// Unique per request, not per tool: the REPL keys the dialog on it, and two
			// asks for the same tool back to back must not share a highlight, an open
			// feedback field or its text.
			callId: `perm-${next.toolName}-${next.id}`,
			toolName: next.toolName,
			inputPreview: options.preview(next.toolName, next.input),
			inputFull: options.fullPreview?.(next.toolName, next.input),
			diff: options.diffPreview?.(next.toolName, next.input),
			options: permissionOptions(next.toolName, next.input, options.cwd),
			queueLength: pending.length,
			source: next.source,
			resolve: (allow, alwaysAllow, alwaysAsk, message) => {
				// This dialog's own request must still be the one at the head. A second
				// answer (a key repeat the handler heard before it re-rendered) or one
				// that lands after an abort withdrew the ask would otherwise shift the
				// *next* request off the queue unanswered, and its caller would wait
				// forever.
				if (pending[0] !== next) return;
				pending.shift();
				if (allow && alwaysAllow) {
					options.onAlwaysAllow?.(next.toolName, next.input);
					// The rule just granted covers everything else queued for the same
					// tool *and the same scope* — so asking again would contradict the
					// answer. Same tool name is not the same rule: granting `Bash(git *)`
					// must not silently approve the `rm -rf` queued behind it, which is
					// what a name-only check would do.
					const specifier = ruleSpecifierFor(next.toolName, next.input, options.cwd);
					for (let i = pending.length - 1; i >= 0; i--) {
						const queued = pending[i];
						if (!queued) continue;
						if (!coveredBy(queued, next.toolName, specifier, options.cwd)) continue;
						// A match is not a permission. Everything queued here was raised
						// under the mode in force when it was raised, and a mode can change
						// while the queue waits — `EnterPlanMode` is concurrency-safe, so a
						// sibling call switches modes with a dialog up. A grant made after
						// that must not carry a call the current mode would refuse.
						if (options.canAutoResolve && !options.canAutoResolve(queued.toolName, queued.input)) continue;
						pending.splice(i, 1)[0]?.resolve(true);
					}
				} else if (allow && alwaysAsk) {
					// Nothing queued is settled here, deliberately: the answer says the
					// user wants matches of this scope *asked about*, and the requests
					// behind this one are exactly that — each will be shown in its turn.
					options.onAlwaysAsk?.(next.toolName, next.input);
				}
				show();
				// The object form exists only when there is something to carry: a
				// denial with no sentence is the boolean it always was, so callers
				// that only read the decision never meet a shape they do not know.
				const feedback = message?.trim();
				next.resolve(feedback ? { allow, alwaysAllow, alwaysAsk: alwaysAsk === true, message: feedback } : allow);
			},
		});
	};

	return {
		request: (toolName, input, source, signal) =>
			new Promise<PermissionReply>((resolve) => {
				// An ask whose run is already cancelled has no answer coming, and a
				// dialog for a cancelled call asks about something that no longer has
				// a subject. Denied here rather than queued, so nothing orphaned ever
				// reaches the screen.
				if (signal?.aborted) {
					resolve(false);
					return;
				}
				let settled = false;
				const settle = (reply: PermissionReply): void => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					resolve(reply);
				};
				// The abort withdraws this one request, not the queue: a stopped
				// subagent's ask must not take the session's own pending question down
				// with it. `clear` stays the whole-queue verdict for an aborted run;
				// this is the per-ask exit, and the re-show keeps the dialog's counted
				// "more waiting" honest.
				const onAbort = (): void => {
					const index = pending.indexOf(entry);
					if (index !== -1) {
						pending.splice(index, 1);
						show();
					}
					settle(false);
				};
				const entry: PendingRequest = { toolName, input, source, id: nextId++, resolve: settle };
				pending.push(entry);
				signal?.addEventListener("abort", onAbort, { once: true });
				show();
			}),
		clear: () => {
			// Deny rather than drop: these requests belong to a run being aborted
			// and their callers are still awaiting an answer. Dismissing the dialog
			// without resolving would leave that wait dangling, which is the one
			// thing an abort must not do.
			const dropped = pending.splice(0, pending.length);
			show();
			for (const request of dropped) request.resolve(false);
		},
	};
}

/**
 * Does the rule the user just granted cover a request still in the queue?
 *
 * A bare tool rule covers every call of that tool (the rule *is* the whole
 * tool). A scoped one covers only what it matches, and matching is the same
 * grammar the permission engine will use on every later call — if the two
 * disagreed, a request would be answered here by a rule that would not have
 * allowed it there.
 */
function coveredBy(
	request: { toolName: string; input: unknown },
	toolName: string,
	specifier: string | undefined,
	cwd: string | undefined,
): boolean {
	if (request.toolName !== toolName) return false;
	if (specifier === undefined) return true;
	// No workspace root to resolve a relative specifier against: the rule's reach
	// cannot be established here, so ask instead of assuming.
	if (cwd === undefined) return false;
	return inputMatchesSpecifier(toolName, specifier, request.input, cwd);
}
