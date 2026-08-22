---
name: code-review-security
description: Check a diff against labunbun's actual security boundaries — permission rule evaluation, path containment, MCP secret handling, and hook trust — rather than generic security advice.
---

Check the diff against labunbun's real security boundaries, not a generic vulnerability checklist:

- **Permission rule evaluation** (`packages/agent/src/permissions.ts`): deny rules must keep winning across every source before any mode shortcut or allow rule is checked — `evaluatePermissions` deliberately scans denies first. A change that reorders this, or adds a new mode/shortcut that returns `allow` before the deny scan runs, reopens the exact bypass `extractBashFilePaths` was added to close (Bash reading a file that a `Read(...)` deny rule protects).
- **New file-touching tools or shell wrappers**: any new path that reads/writes a file must resolve through `resolveCanonical`/`pathMatches` (permissions.ts) or `guardPathContainment` (`packages/tools/src/containment.ts`) before the filesystem call — not a hand-rolled prefix check. A path accepted without going through containment is a traversal hole.
- **Secret handling in error text** (`packages/mcp/src/client.ts`, `sanitizeMcpError`): any new place that echoes an external error, a subprocess's stderr, or a config-validation failure into the transcript/UI must scrub values sourced from `env`/`headers` (or equivalent secret-bearing config) the same way — don't let a new error path bypass sanitization because it feels like "just a debug message."
- **Hook payloads** (`packages/coding-agent/src/hooks.ts`): hook commands are user-configured shell commands; tool inputs and prompts reach them only as JSON on stdin, never interpolated into the command string itself. A change that builds the hook's command line by concatenating tool input/prompt text would turn a config file into a command-injection vector.
- **Policy-layer privilege** (`allowManagedPermissionRulesOnly`, `disableBypassPermissionsMode` in `packages/coding-agent/src/settings.ts`): a new rule source or mode must still be checked against `loaded.perSource.policy` where relevant — a new code path that reads merged settings without consulting the policy tier silently lets project/user settings override a lockdown the policy file was meant to enforce.
- **MCP server trust** (`loadProjectMcpServerNames`, `loadApprovedMcpServers` in client.ts): project-shipped `.mcp.json` servers require explicit approval recorded in the gitignored `.labunbun/settings.local.json`, precisely because a cloned repo is attacker-controlled and shouldn't be able to self-approve its own servers. Flag any new path that auto-approves or auto-connects a project-scoped server without that local, machine-specific gate.

For each hit, name the surface, the concrete input that triggers it, and whether it's exploitable now or only under a specific configuration (e.g. `acceptEdits` mode, a permissive allowlist).
