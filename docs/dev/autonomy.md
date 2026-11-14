# Decision autonomy

The agent has two independent questions to answer about every step: **may it do
this**, and **should it ask the user first**. This note is about the second one.
`permissionMode` and `sandbox` answer the first and are covered in
[plan mode](plan-mode.md), [sandbox](sandbox.md) and
[YOLO mode](yolo-mode.md); changing the answer to the second must not change the
answer to the first.

## Why it is a separate axis

Conflating the two produces one of two bad defaults. Treat permission as the
whole story and an agent with `permissionMode: agent` will also stop to ask
whether it may name a helper function — a question that costs a turn and
teaches the user to press Enter. Treat autonomy as the whole story and a user
who raises it to stop the questions has also silently loosened the sandbox.

The industry split is the same one. Claude Code separates its permission mode
(default, accept-edits, plan, auto, dontAsk, bypass) from the decision posture
the prompt describes, and its deny rules survive even the loosest mode. Human
in-the-loop agent research reaches the same conclusion from the other side:
intervention is proportional to **reversibility and blast radius**, not to how
technical the choice feels. A local rename is reversible and local; a deploy is
not.

So autonomy here is a prompt posture. It changes what the model asks about. It
does not add an allow rule, move a sandbox axis, or outrank a deny rule.

## The three levels

The list lives in `packages/agent/src/autonomy.ts`; the prompt text lives in
`packages/coding-agent/src/system-prompt.ts`.

| id | what the agent decides | when it asks |
| --- | --- | --- |
| `guided` | details inside the approach the user picked | before choosing among approaches; before a new dependency, file, or public surface |
| `balanced` | the approach and its implementation | when the answer changes the deliverable: an ambiguous requirement, a scope trade-off, or behaviour the user did not ask to change |
| `autonomous` | every reversible step the evidence supports, including open details implied by the request | only a hard blocker (withheld access, unsafe or destructive action, information only the user has) or a decision explicitly the user's (money, hard-to-undo work, activity visible outside the checkout, scope beyond the request) |

The definitions are deliberately about **reversibility**, not about categories
of work. A choice the agent can read back in the diff and undo is its own. A
choice that changes the deliverable, spends money, or reaches other people is
the user's, even when the agent has a recommendation.

`autonomous` still says "the smallest choice consistent with the existing
code". It is not a licence to add scope: a request that is silent on an
implementation detail gets the nearest option, while a request that is silent
on a feature does not get the feature.

## The default

The default is `autonomous` (`DEFAULT_AUTONOMY_LEVEL`).

The harness already defaults to the autonomous end of the permission axis:
`agent` runs tool calls without asking. A decision default more cautious than
the execution default would ask the user to confirm work the same session was
already trusted to perform, and the questions would land on the technical
details where the agent has the most evidence and the user the least. The hard
stops above are what make the default safe: autonomy over the *how*, never over
the *what*.

A user who wants the questions back can set `autonomy` in
`~/.labunbun/settings.json` or run `/autonomy guided`; a repository cannot set
it at all (see below).

## What the prompt says

`# Autonomy` sits after `# Finishing work` in the full prompt, so it refines
the one sentence there that used to say "ask when the task cannot move forward"
— a rule that was true for persistence but too coarse for decisions. The
section carries:

1. **The boundary is not a decision.** Permission prompts, sandbox limits, deny
   rules, and withheld access apply at every level. Autonomy never grants
   access, and a refusal is not something to route around with another tool.
2. **The how is the agent's; the what is the user's.** The first list is
   concrete (structure, naming, existing libraries, error handling, test
   placement, which local check to run) because "use your judgment" is not an
   instruction a model can act on.
3. **Answer before asking.** Code, tests, config, docs, and history are cheaper
   than a turn from the user. A question the repository can answer wastes the
   user's time and teaches them nothing.
4. **Ask once, well.** Batch related questions; state the options considered;
   recommend one first; say what changes with each answer. Do not ask twice for
   something one answer could have covered.
5. **The level clause.** One sentence per level, because a small model can act
   on a behaviour ("ask before choosing among approaches") far better than on a
   rule with two conditions in it.

The short prompt for small local models gets a compressed level clause in its
`# Rules` section instead of the full section. Its own suite reads those bytes;
the full prompt's tests never do.

`AskUserQuestion`'s description and tool prompt were narrowed to match: it is a
last resort for a decision that is genuinely the user's, not a check-in, and
not a way to ask the repository a question. The tool is still only built by the
interactive host; headless and ACP runs have no human to ask, so the level there
is purely prompt posture.

## Persistence and inheritance

`autonomy` is a normal settings key, merged through the same tiers as the rest
(`packages/coding-agent/src/settings.ts`). It is **denied to the project and
local tiers**, like `permissionMode` and `language`: a repository that could
change how often its own checkout's agent asks would be quieting the questions
its code provokes, or widening what the user's judgment is spent on. A policy
file can still set it, as a policy can set anything.

`/autonomy` writes the choice to the user's settings file with
`writeUserSettingsPatch`, the same read-merge-write `/think` uses, and prints
the shadowing notice when a higher tier will win on the next start. The live
session changes even if the write fails: the posture is already in force, and
only the persistence is lost, which the line says.

The REPL rebuilds its system prompt at once, because a session holds one prompt
and nothing else would replace it before the next request. `-p` and ACP read
the merged setting once at startup and build their prompt from it; neither host
has a `/autonomy` command, and an editor session that wants a different level
sets it in settings. `--autonomy <level>` is the flag tier's spelling of the
same key: `main.ts` validates it against the CLI's copy of the list and merges
it into the flag settings object, so all three hosts read one value and none of
them needs to know the flag exists.

Subagents do not carry the section either. They are spawned without
`AskUserQuestion`, so they have no decision to ask about, and their report back
to the parent is the escalation path. The spawner appends a
`# Working as a subagent` contract instead: no user is reachable, reversible
steps are the worker's to decide, assumptions and blockers belong in the
report, the permission boundary is unchanged, and the report has to name the
check that was run. A host-supplied `systemPromptFor` replaces the role, not
that contract. Their permission mode, sandbox, network, and YOLO flag still
follow the root session, unchanged by this axis.

## What this is not

- **Not a permission mode.** It never changes `permissionMode`, `sandbox`,
  `network`, or the rule lists. `/autonomy autonomous` on a plan-mode session
  stays in plan mode.
- **Not YOLO.** YOLO skips the dangerous-command classifier and the ask rules
  for the rest of the session; autonomy changes no gate. The two are orthogonal
  and can be on at once.
- **Not a session-only override.** YOLO is a deliberate exception: a switch that
  widens permission and must not survive a restart. Autonomy is a durable
  posture, so `/autonomy` writes it to the user's settings file, and there is no
  in-memory-only variant. The permission axes still record their pair in the
  session file; this axis does not need a second copy.
- **Not a model choice.** The level does not swap models or thinking depth;
  `thinkingLevel`, `roles` and the task calibration own that.

## Tests

- `packages/coding-agent/test/system-prompt.test.ts` pins the shared clauses
  and each level's distinctive sentence, and that the section sits above the
  dynamic boundary.
- `packages/coding-agent/test/autonomy-command.test.ts` pins `/autonomy`'s
  report, its argument handling, and that a confirmed level reaches the
  context's setter.
- `packages/coding-agent/test/settings-autonomy.test.ts` pins the schema, the
  default, and the project-tier denial.
