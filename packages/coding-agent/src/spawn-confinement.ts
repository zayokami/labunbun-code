/**
 * The confinement hook the non-Bash spawns share: MCP stdio servers and hook
 * commands. Both open their own child processes — the MCP SDK its transport,
 * the hooks runner its shell — so neither passes through `operations.exec`,
 * and without this hook neither would ever see the session's sandbox.
 *
 * The shape mirrors `shell-passthrough.ts`: the live axes are getters because
 * `/mode` can move them mid-session, and a spawn later in the session must get
 * the axis the user is looking at then, not the one from startup.
 *
 * What comes back is `resolveSandboxExecution`'s answer: on darwin and linux
 * with a native backend, the command re-parented under `sandbox-exec`/`bwrap`
 * with the policy's proxy variables as an env increment (the caller folds its
 * own base — the MCP SDK merges over its own whitelist, the hooks runner over
 * `process.env`). Everywhere else — win32, where the AppContainer path opens
 * processes through `CreateProcessW` and cannot be spelled as an argv, and the
 * simulated/unconfined resolutions — the spawn comes back unchanged, which is
 * exactly what these paths did before the hook existed. Long-form notes:
 * docs/dev/sandbox.md.
 */

import type { NetworkAxis, SandboxMode } from "@labunbun/agent";
import type { Operations, SpawnConfiner, SpawnSpec } from "@labunbun/tools";
import { resolveWritableRoots, workspacePolicy } from "@labunbun/tools";

export function createSpawnConfiner(opts: {
	cwd: string;
	ops: Operations;
	/** The live sandbox and network axes, as getters for the same reason the Bash tool reads them per call. */
	sandbox: () => SandboxMode;
	network: () => NetworkAxis;
	/** The root inputs the Bash tool is built with (`home`, `permissions.additionalDirectories`), so all paths resolve the same writable roots. */
	home?: string;
	writableRoots?: readonly string[];
}): SpawnConfiner {
	return async (spawn: SpawnSpec): Promise<SpawnSpec> => {
		// The presence check comes first: a caller's own executor (tests, embeds)
		// may predate the hook, and then there is no resolver to ask and the spawn
		// is handed back as-is without paying for a policy we would not use.
		if (opts.ops.confineSpawn === undefined) {
			return spawn;
		}
		// Built per spawn, from the same resolver the Bash tool uses. The policy
		// roots at the session workspace, not the spawn's own cwd: an MCP config
		// may name a cwd outside it, and that is where the process sits, not what
		// the session decided it may write.
		const policy = await workspacePolicy(opts.cwd, {
			sandbox: opts.sandbox(),
			network: opts.network(),
			writableRoots: resolveWritableRoots({ home: opts.home, configured: opts.writableRoots }),
		});
		// Property call, not a destructured one: the implementation reads its own
		// runtime off `this`.
		return opts.ops.confineSpawn({
			policy,
			command: spawn.command,
			args: spawn.args,
			env: spawn.env,
			cwd: spawn.cwd,
		});
	};
}
