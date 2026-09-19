import { inputMatchesSpecifier } from "@labunbun/agent";
import { permissionOptions, ruleSpecifierFor } from "./permission-options.ts";
import type { PermissionDialogState } from "./ui-state.ts";

export interface PermissionRequestQueueOptions {
	/** Render this dialog as current, or clear it with null. */
	show: (dialog: PermissionDialogState | null) => void;
	/** Body text for the dialog: what the tool wants to do. */
	preview: (toolName: string, input: unknown) => string;
	/** The same input in full, for the dialog's Ctrl+A view. */
	fullPreview?: (toolName: string, input: unknown) => string;
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
}

export interface PermissionRequestQueue {
	/** Ask for permission; resolves true when allowed. Answered in arrival order. */
	request: (toolName: string, input: unknown) => Promise<boolean>;
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
export function createPermissionQueue(options: PermissionRequestQueueOptions): PermissionRequestQueue {
	const pending: Array<{ toolName: string; input: unknown; resolve: (allow: boolean) => void }> = [];

	const show = (): void => {
		const next = pending[0];
		if (!next) {
			options.show(null);
			return;
		}
		options.show({
			callId: `perm-${next.toolName}`,
			toolName: next.toolName,
			inputPreview: options.preview(next.toolName, next.input),
			inputFull: options.fullPreview?.(next.toolName, next.input),
			options: permissionOptions(next.toolName, next.input, options.cwd),
			queueLength: pending.length,
			resolve: (allow, alwaysAllow) => {
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
						if (coveredBy(pending[i], next.toolName, specifier, options.cwd)) pending.splice(i, 1)[0].resolve(true);
					}
				}
				show();
				next.resolve(allow);
			},
		});
	};

	return {
		request: (toolName, input) =>
			new Promise<boolean>((resolve) => {
				pending.push({ toolName, input, resolve });
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
