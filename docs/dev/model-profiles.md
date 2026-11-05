# Model profiles

Model profiles are the part of the system prompt that changes with the model.
They answer a narrow question: given the row the session is about to run on,
should the harness phrase its instructions differently, and should it use the
short prompt?

The layer is in `packages/coding-agent/src/model-profile.ts`. It is not a
second model catalog. Thinking shape, accepted efforts, output limits, cache
capability and pricing stay on `Model` (`packages/ai/src/types.ts`), where the
wire adapters read them. A profile only decides how the harness talks to the
family: prompt variant, whether independent tool calls may share a turn, and
which edit shape the family handles most reliably.

## What Claude Code does

Anthropic does not publish the Claude Code prompt, so the mechanism below is
reconstructed from the binary's own strings, public prompt collections
([Piebald-AI](https://github.com/Piebald-AI/claude-code-system-prompts),
[asgeirtj](https://github.com/asgeirtj/system_prompts_leaks/tree/main/Anthropic/claude-code)),
and Anthropic's product documentation. Exact wording is unverified; the shape
is not.

The important finding is that Claude Code does **not** keep one persona per
Claude model. Its per-model prompt files are nearly the same size and share the
same behavioural sections. What changes is:

- **Identity.** The prompt names the model and its knowledge cutoff.
- **Capability gating.** A per-model catalog says whether the model supports
  effort, adaptive thinking, fast mode, auto mode, and whether thinking can be
  turned off. Prompt sections and request parameters are selected from it.
- **Effort calibration.** Opaque effort tables are tuned per family, and the
  default effort differs by model.
- **Prompt variant.** A full prompt is used for recognized models; a short
  "simple" prompt is used when the model name is unrecognized (for example, a
  Bedrock ARN that hides the model id).
- **Routing.** Plan mode, exploration subagents and compaction seats run on
  different models by default.
- **Cache-aware updates.** The static prompt and tool list stay fixed; new
  instructions are appended as messages rather than rewriting the prefix.

Anthropic's own guidance for agent builders points the same way: support a
small set of models with similar capability profiles rather than write a prompt
per model ([Seeing like an agent](https://claude.dev/blog/seeing-like-an-agent/)).
This repository follows that advice. The family table has one entry per
behavioural family, not one per row.

## What other coding agents do

The same split appears across the open-source agents, with the prompt layer
usually the smallest of the three:

| Agent | Model-specific mechanism |
|---|---|
| [Cline](https://github.com/cline/cline/tree/84205277bdc0ee5e69c4f8c37d7fcd586afee738/src/core/prompts/system-prompt/variants) | A variant registry where the first matcher wins, with a `GENERIC` fallback; GLM has its own prompt component overrides, and native tool calls are gated by model family and provider. |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code/blob/main/src/api/transform/model-params.ts) | Capability metadata (`supportsReasoningBudget`, `supportsReasoningEffort`, `verbosity`) plus a native-only tool protocol; parameter adaptation rather than prompt forks. |
| [Aider](https://github.com/Aider-AI/aider/blob/main/aider/resources/model-settings.yml) | An exact-name settings table: edit format (`whole`, `diff`, `udiff`, `architect`), temperature, reasoning tag, and `extra_params` per model. |
| [OpenHands](https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/llm/utils/model_features.py) | Substring feature lists for stop words, reasoning-content echo, string serializers and extended thinking; prompt families such as `openai_gpt`, `anthropic_claude`, `google_gemini`, `meta_llama`, and tool presets that swap `str_replace` for `apply_patch` on GPT-5. |
| [Codex CLI](https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json) | A per-slug capability record: `supports_parallel_tool_calls`, `supported_reasoning_levels`, `default_reasoning_summary`, `support_verbosity`, `auto_compact_token_limit`, and a freeform `apply_patch` tool. |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/prompts.ts) / [Qwen Code](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/core/prompts.ts) | The prompt is assembled by model generation (`isGemini2Model`/`isGemini3Model`); thinking uses `thinkingBudget` or `thinkingLevel`, and Qwen adds `enable_thinking`/`thinking_budget`. |
| [OpenCode](https://github.com/sst/opencode/blob/dev/packages/opencode/src/provider/transform.ts) | A provider transform for parameter compatibility, separate Anthropic/GPT/Gemini/default prompt files, and a tool registry that offers `apply_patch` only to models that can use it. |

The recurring failure modes are the ones the profile layer is meant to avoid:
tool-call syntax the model does not speak, reasoning text leaking into the
answer, parameters the provider rejects, and exact-match edits the model cannot
land. The layers that address them are independent: a prompt variant, a
tool/edit protocol, and request parameters. This repository already carries the
third on `Model` (thinking shape, effort subsets, `toolReasoningEffort`,
`responsesLite`, `toolCalling`) and the second in the tool set (`Edit`,
`Write`, `apply_patch` is not a labunbun tool). Profiles add the first, plus
the prompt-side half of the second: how to use those tools on this family.

## What this repository does

`resolveModelProfile` (`packages/coding-agent/src/model-profile.ts:329`) is a
pure function from a row to a profile. `inferModelFamily`
(`:295`) reads the model id before the provider, because a gateway row's
provider names the route and its id names the model: `openrouter` serving
`anthropic/claude-opus-5` is Claude, not "OpenRouter". A first-party row whose
id carries no vendor word (`hy4`, `mimo-v2.6-pro`) falls back to its provider.

The family table (`:99`) is deliberately small:

| Profile | Families | Tool calls | Edit shape |
|---|---|---|---|
| Full | Claude | parallel | exact |
| Full | GPT | parallel | exact |
| Full | Gemini | parallel | exact |
| Full | DeepSeek | sequential | exact |
| Full | Kimi | parallel | exact |
| Full | Qwen | parallel | exact |
| Full | GLM | parallel | exact |
| Full | MiniMax | parallel | exact |
| Full | Mistral | sequential | exact |
| Full | Meta | parallel | exact |
| Full | Hunyuan | sequential | exact |
| Full | MiMo | parallel | exact |
| Full | NVIDIA | parallel | exact |
| Lean | local Ollama | sequential | whole-file |
| Lean | unknown | sequential | whole-file |

`resolveModelProfile` turns a row into the `lean` variant when either:

- the row states a window below 32,000 tokens, which is the case a discovered
  row can present that no family table knows; or
- the row is the local Ollama daemon and its tag states a parameter count of
  14B or less, or states none at all. The tag is the only evidence, and
  guessing "large" from silence is the more expensive mistake.

A lean row also pins the conservative tool and edit shapes even when its family
table says otherwise. A 7B Qwen row is still a 7B model.

`buildSystemPrompt` (`packages/coding-agent/src/system-prompt.ts:175`) chooses
`fullBasePrompt` (`:102`) or `leanBasePrompt` (`:136`) from the variant, then
appends `# Model guidance` after `# Tool guidance`. The section carries the
model identity, the family's reminders, and the shared tool/edit line. An
unknown family emits no section: there is no behaviour to tune, and a heading
over generic advice would spend tokens buying nothing.

The section sits below `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` because a `/model`
switch rebuilds it. The interactive host does that in `switchModel`
(`packages/coding-agent/src/interactive.ts:1980`), and the `#` memory shortcut
already rebuilds with the live session model (`:2310`). Headless and ACP pass
their resolved model at startup (`packages/coding-agent/src/headless.ts:903`,
`packages/coding-agent/src/acp.ts:1224`).

A subagent can run on a model of its own: the definition's frontmatter, the
light seat, or the parent's. `buildSubagentContext`
(`packages/coding-agent/src/system-prompt.ts:254`) therefore takes the
worker's model and appends that profile, not the parent's. The call site is
`subagents.ts:593`, where the model has already been resolved.

`buildSystemPrompt`'s `model` field is optional. A caller that passes no model
— a library embedder, a test, a prompt assembled before the model is known —
keeps the exact bytes the prompt had before this layer existed. That is what
keeps the change additive and lets the existing prompt tests stay meaningful.

## Adding a family

1. Add an entry to `FAMILY_PROFILES` (`packages/coding-agent/src/model-profile.ts:99`)
   with a label, tool-call style, edit style, and only the reminders the base
   prompt does not already carry.
2. Add its provider or id pattern to `PROVIDER_FAMILY` or `ID_PATTERNS`
   (`:238`, `:272`). Prefer an id pattern when the vendor is also served
   through a gateway.
3. Add a case to `packages/coding-agent/test/model-profile.test.ts`: the family
   inference, the variant, and that the section names the row.

Guidance must be an instruction the harness can keep. "Use tools directly" is
in scope; "this model is better at X" is not, unless the claim comes from the
vendor's own documentation and the test can pin the behaviour it changes.

## What is deliberately not here

- **Thinking shape and effort subsets.** Those are wire facts on `Model`
  (`thinkingMode`, `reasoningEfforts`, `toolReasoningEffort`) and the adapters
  already read them.
- **Model defaults for thinking level.** The session's `/think` setting wins;
  a profile does not silently spend more or less money.
- **A prompt per model.** The family table is the unit, because the differences
  that matter cluster by family, not by version.
- **Tool availability.** A profile does not remove a tool. A model that cannot
  call tools is marked `toolCalling: false` on its row, and the offer and
  picker layers read that flag.
