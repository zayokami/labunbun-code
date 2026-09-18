import type { PermissionDialogState } from "./ui-state.ts";

export interface PermissionRequestQueueOptions {
	/** Render this dialog as current, or clear it with null. */
	show: (dialog: PermissionDialogState | null) => void;
	/** Body text for the dialog: what the tool wants to do. */
	preview: (toolName: string, input: unknown) => string;
	/** Called when the user grants "always allow" so the app can persist a rule. */
	onAlwaysAllow?: (toolName: string) => void;
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
			queueLength: pending.length,
			resolve: (allow, alwaysAllow) => {
				pending.shift();
				if (allow && alwaysAllow) {
					options.onAlwaysAllow?.(next.toolName);
					// The rule just granted covers everything else queued for this
					// tool, so asking again would contradict the answer.
					for (let i = pending.length - 1; i >= 0; i--) {
						if (pending[i].toolName === next.toolName) pending.splice(i, 1)[0].resolve(true);
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
