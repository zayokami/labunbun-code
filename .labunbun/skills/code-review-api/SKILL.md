---
name: code-review-api
description: Check the design quality of a new or changed API surface (tool, exported function, settings field, CLI flag) against labunbun's existing conventions — separate from code-review-breaking-changes, which checks compatibility for existing consumers.
---

This is about design quality for a *new* surface, not compatibility for an *existing* one — see `code-review-breaking-changes` for the latter. Check a new or changed tool, export, settings field, or flag against the conventions the rest of the codebase already follows:

- **Tool shape** (`packages/agent/src/types.ts`, `Tool<TInput>`/`buildTool`): a new tool should define one zod `inputSchema` as its only contract, rely on `buildTool`'s fail-closed defaults (`isReadOnly`/`isConcurrencySafe`/`checkPermissions`) rather than re-declaring them, and return `ToolResult` — never throw past its own boundary. Check the `description` is written for the model deciding whether to call the tool, not for a human reading the source.
- **Package boundaries are the `index.ts` files** (`packages/*/src/index.ts`): a new symbol meant for cross-package use must be exported from its package's `index.ts`. A consumer deep-importing `packages/agent/src/permissions.ts` directly instead of `@labunbun/agent` is bypassing the boundary the index file exists to define — flag it on either side (the export that's missing, or the import that skipped it).
- **Schema-driven config additions** (`packages/coding-agent/src/settings.ts`, `SettingsSchema`): a new settings field should be `.optional()` on the existing zod object (additive, so old settings files keep parsing) and follow the same flat-field style as `allowManagedPermissionRulesOnly`/`disableBypassPermissionsMode`, not a parallel hand-rolled reader that bypasses schema validation.
- **CLI flag shape** (`packages/coding-agent/src/main.ts`): new flags should match the existing long-form kebab-case naming (`--permission-mode`, `--max-turns`), and if the flag affects what gets printed, it needs to be considered against both `--output-format json` and `stream-json` — a flag that only changes human-readable output but silently no-ops under `--output-format json` is a design gap, not just a docs gap.
- **Schema/type pairing convention** (e.g. `HookMatcherSchema`/`HookMatcher`, `McpServerConfigSchema`/`McpServerConfig`): a new config or wire shape should define the zod schema first and derive its TS type with `z.infer`, matching every existing schema in the codebase — not a hand-written interface that happens to look similar but isn't actually validated against.

For each hit, say which existing convention it diverges from and point at the file that establishes that convention.
