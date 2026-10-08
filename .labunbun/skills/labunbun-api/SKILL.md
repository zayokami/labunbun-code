---
name: labunbun-api
description: Quick reference for labunbun's own extension surfaces — package layout, the StreamFn seam, the model registry tables, discovery, and the settings tiers. Use when changing or extending this repository: adding a provider, a model row, a settings key, a tool, or a skill.
---

The map for working on this repository itself. Concrete files, not concepts.

## Packages and the dependency direction

One way: `@labunbun/ai` → `@labunbun/agent` → `@labunbun/tools` / `@labunbun/mcp` / `@labunbun/tui` → `@labunbun/coding-agent`. `@labunbun/gamepad` depends on nothing.

The load-bearing rule: **the agent loop never imports a provider adapter.** Adapters live in `packages/ai/src/providers/` and arrive as the `StreamFn` parameter of an `AgentSession`. This is why the whole suite runs with no network and no keys.

## The model registry — `packages/ai/src/model.ts`

- `BUILT_IN_MODELS` — the table every vendor row lives in. There is no provider registry; a provider is a row here.
- `RETIRED_MODEL_IDS` — retired ids remap to successors, and only when the prefix's provider matches the successor's.
- `allModels` (resolution — must never shrink) vs `listModels` (enumeration for `/model`). Resolving through `listModels` is a real footgun: an id hidden yesterday would stop resolving and bill at zero.
- `resolveModel`, `withPricingOverride`, `openAIPricing`, `anthropicPricing` — the helpers every new row uses.
- **Adding a model touches three places**: the const row, the four tables in `model-pricing.test.ts` (position must match the array order), and `KEY_VARS` in `discovery.test.ts`. The two fields that must never be guessed are `thinkingBlockBinding` and `toolReasoningEffort`. A bare alias is a family's stable representative, not the latest dot release.

## Discovery — `packages/ai/src/discovery.ts`

`refreshModelCatalog` runs once at startup per provider that has a key, and never throws. Only a complete, non-empty list hides models; an unknown model is added only with both limits present and no price (undeclared is not free). Prices never come from the API — they come from the table or `settings.pricing`.

## Settings tiers — `packages/coding-agent/src/settings.ts`

`PROJECT_TIER_KEY_POLICY` classifies every `Settings` key as user-only or project-safe, and `PROJECT_TIER_PERMISSION_KEY_POLICY` does the same per-field for `permissions.*`. A new key without a classification is a tsc error, on purpose. `permissions.deny` reads from every tier; tightening always survives.

## Skills

`.labunbun/skills/<name>/SKILL.md`, flat `key: value` frontmatter, project tier gated by trust. The discovery block and name rules are in `packages/coding-agent/src/skills.ts`; the authoring conventions are the `skill-writing` skill. Skill bodies are sent whole on invocation — keep them lean and point at files for detail.

## Where state lives

Sessions, MCP approvals, and trust ledgers under `~/.labunbun/projects/<sanitizeCwd(cwd)>/`; user settings at `~/.labunbun/settings.json`; project memory walked from cwd to the filesystem root (nearest wins, 40k characters total).
