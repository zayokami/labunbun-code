# Task scale

Task scale is the part of the harness that decides how much process a request
has earned. It is a deterministic read of the user's own words — no model call
and no clock — that produces two things: a short contract the model reads with
the request, and the thinking effort the request is sent at.

The layer is in `packages/agent/src/task-scale.ts`. The hosts compose it through
`LoopHooks.composeUserMessage` (the session's own seam for text that must be
part of the stored message), and read its effort answer through the existing
`thinkingLevel` getter.

## Why it exists

A coding agent fails in both directions. Doing too little is the one that gets
opened as a bug; doing too much is the one users describe as the agent not
listening. Codex's tracker and its community record the pattern consistently:

- [openai/codex#6587](https://github.com/openai/codex/issues/6587) — the CLI
  reaches for stubs, shims, fallbacks and placeholders, then reports success
  even after explicit instructions not to.
- [openai/codex#34898](https://github.com/openai/codex/issues/34898) — a bounded
  task turns into self-generated governance, evidence and review loops; one
  reported run spent 633,788 tokens while the requested feature stayed
  unfinished.
- [openai/codex#30496](https://github.com/openai/codex/issues/30496) — the other
  half: the agent acts past the project's own guardrails.
- The V2EX thread [“Codex 的过度设计,防御性编程,测试狂魔有解法吗”](https://global.v2ex.co/t/1254035)
  collects the workarounds users actually adopt — an AGENTS.md that bans
  fallbacks, a file-and-line plan before edits, smaller tasks, and explicit
  statements about when tests are required.
- The Hacker News discussion of codex/sol
  ([althacker.news](https://althacker.news/item?id=49393505)) describes the
  same tendency: whole validation frameworks written for imagined hostile
  input, and tests for an initial state treated as a permanent invariant.

The common remedy in that record is not a better prompt alone. It is telling
the agent, before it starts, how big the job is.

## What it decides

Two independent facts:

- **Kind** — `answer` or `change`. A question that carries no change verb is
  answered from what is read; it does not become an edit. “How do I fix the
  flaky test?” carries `fix` and is a change.
- **Scale** — `trivial`, `standard`, or `complex`, scored from explicit cues
  rather than inferred from length alone.

The classifier is conservative in the direction that costs correctness least:

| Reading | Needs | Contract |
|---|---|---|
| `trivial` | an explicit small cue: `just`, `only`, `quick`, `typo`, `只改`, `简单`, … | no plan, no delegation, smallest edit, one targeted check, no extra tests/docs/defences |
| `complex` | explicit scope evidence: `all`, `every`, `whole`, `across`, `refactor`, `migrate`, `audit`, `所有`, `重构`, …; or three file paths; or a long, many-sentence request | read first, short plan before the first edit, one focused pass, relevant checks, then stop |
| `standard` | none of the above | nothing is added; the base prompt and the model's own default apply |

`trivial` needs the cue, not merely a short text. “Implement retry with backoff
and jitter” is short and is not trivial; “fix the typo” is. A classifier that
read brevity as simplicity would be the same failure in the other direction.
Three paths is complex because a change that names three files is not a
one-file change, even when its wording is modest.

The full rule set and its weights are in `classifyTask`. The signals that
decided a request are returned as stable names (`explicit-small`, `short`,
`explicit-large`, `long`, `many-sentences`, `several-paths`, `question`,
`change-verb`, `answer-verb`), so a test can assert why a boundary moved.

## Where the contract goes

The block is prepended at the moment the user message is stored:

```text
<task-scale scale="trivial" kind="change">
This is a small, contained change. Do not plan, delegate, or widen the search. …
</task-scale>

---

<the user's text>
```

That moment matters, and it is the same reason `composeUserMessage` exists: the
stored message is what every later request in the conversation replays, byte
for byte. Attaching the contract to one request instead would make the prompt
prefix diverge on the next turn, and the provider would charge the whole tail
again.

The block is composed last, after any hook context, so it is always the head of
the stored message. That is what lets the transcript rebuild (`ui-state.ts`),
the `/resume` preview and the Markdown export strip it by prefix with
`stripTaskScale`: the model sees machine guidance, the user does not.

`standard` adds nothing. The base prompt already says the ordinary things, and
a block repeated on every request is the prompt bloat this feature is meant to
avoid.

## Effort

`taskScaleThinkingLevel` answers `low` for a trivial change and `high` for a
complex one, and leaves `undefined` for standard and for every question — the
adapter's own default is better than a guess for “why does this fail?”. The
rungs above `high` are never chosen automatically: the vendor pages that name
them do not promise they help, and the community guidance is consistent that
blanket depth burns budget without buying accuracy.

A level the user pinned (`settings.thinkingLevel` or `/think`) always wins. The
calibration answers only when the reader has no level of its own.

The effort is read per request, not captured at session start. A follow-up that
is itself a new prompt is classified again; a steer is not, because a steer is
the harness talking to the model rather than a new task. That distinction is
why `composeUserMessage` now receives a `UserMessageOrigin` (`prompt`, `steer`,
`followUp`); a hook written for the text alone still type-checks and still runs.

## Off switch and limits

`LBB_TASK_SCALE=off` in the environment turns both halves off — no block, no
effort change — for a session that wants the old behaviour. It is an
environment variable rather than a settings key because it is a debugging and
A/B switch, like `LBB_TASK_REMINDER`.

This is a heuristic, not a judgment. It reads English and Chinese cue words and
file-shaped tokens; it does not read the repository, the conversation, or the
model's confidence. It can be wrong in both directions, which is why the
unknown case is `standard`, why the contract is phrased as scope rather than as
a hard limit on tool use, and why the user's own effort choice outranks it.
It is also not a security decision: permissions and the sandbox remain the only
layers that admit or refuse a call.

The alternative — a model call that classifies the request — is the design the
difficulty-routing literature uses (for example RoutingGen, AAAI 2026, routes
with a Qwen3-8B classifier and reports a 46.37% average token reduction). That
is a second request on every turn, which is the cost this layer exists to
avoid. Three coarse tiers do not need a model, and a pure function can be
pinned in a unit test.
