# Prompt guidance taken from Anthropic's prompting docs

The base prompt is behaviour with no runtime oracle, so every clause in it
should be traceable to a failure mode somebody measured. This note records
which parts of Anthropic's current prompting guidance were adopted, where they
land in `packages/coding-agent/src/system-prompt.ts`, and which were left out
on purpose.

Sources (all read 2026-11-12):

- [Prompting Claude Fable 5.2](https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-engineering/prompting-claude-fable-5-2)
- [Reduce hallucinations](https://platform.claude.com/docs/zh-CN/test-and-evaluate/strengthen-guardrails/reduce-hallucinations)
- [Claude prompting best practices](https://platform.claude.com/docs/zh-CN/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Increase consistency](https://platform.claude.com/docs/zh-CN/test-and-evaluate/strengthen-guardrails/increase-consistency)
- [Define success criteria and build evals](https://platform.claude.com/docs/zh-CN/test-and-evaluate/develop-tests)

## Adopted

**Finish the whole task.** Long turns ended with a list of remaining work or an
offer to continue. The `# Finishing work` section says that an ordinary
obstacle — a failing command, a timeout, a locked file, an empty result — is
for the agent to diagnose and work through, and reserves asking for decisions
the user must make and for deliberate blockers. It keeps the separate rule
that risky or irreversible actions still need confirmation, because the vendor
guidance is explicit that persistence must not swallow that step.

**Ground claims in what was read.** `# Doing tasks` requires reading a file
before editing it *and* before claiming what it contains, and explicitly allows
"say what you do not know" instead of guessing. This is the reduce-
hallucinations guidance, narrowed to a coding agent: the failure to prevent is
a confident description of code that was never opened.

**Solve the problem, not the example.** One line forbids hard-coded values and
helper scripts that route around the task, and asks the agent to report a test
that looks wrong rather than code to it. This is the "avoid only focusing on
passing tests" guidance.

**A check counts only when its output is visible.** The verification bullet now
adds that a passing check is a claim about a tool result in this conversation,
not something to infer. The existing rule that a failed command is reported
with its output stays.

**Tell the user what is happening.** The communication section keeps the
one-line opener, and adds the closing recap from the vendor guidance: what was
found, what changed, and how it was checked, standing on its own for a reader
who sees only the last message. The recap is a deliberate token cost; it is
what makes a long turn readable after the fact.

**Complete tool calls.** One line says to give every call complete arguments
and not to describe a call in prose where the call belongs. Family guidance
already said this for several models; the base prompt now carries it for
everyone.

**Iteration files are scratch.** Temporary files and helper scripts created
while iterating are removed before the report, from the best-practices
"reduce file creation" guidance.

**Read the diff before reporting.** One line asks the agent to re-read its own
changes: every changed line should be explainable and nothing unrelated should
have moved. This is the self-check step, applied to the artifact this harness
actually produces.

**Subagent cost.** The Task tool prompt now says a subagent costs a separate
context window and its own tokens, names when delegation is worth it, and says
not to delegate a quick lookup or a single-file edit. The description also
asks for the goal, constraints, and report contents in the prompt, because a
worker does not see the parent conversation.

**A requested change is made, not proposed.** The vendor's
`<default_to_action>` block targets a measured failure: asked for a change, the
model describes the change it would make. The adopted line is scoped so it does
not fight the process-matching rule beside it — a change asked for is made in
the turn; advice or a recommendation asked for is answered without editing.

**No destructive shortcut past an obstacle.** The persistence section says an
obstacle is the agent's to work through, which is exactly the pressure that
produces a bypass. The vendor's autonomy-and-safety section pairs the two, so
`# Finishing work` now names the failure directly: never bypass a sandbox or
hook or `--no-verify`, and never delete files the agent did not create, to get
past a failure.

**A regression test proves itself.** The eval-design page builds every example
around edge cases, and this repository's own benchmark treats red-to-green as
the pass condition (`scripts/benchmark.ts`). The prompt now says the same for
the one test the scope rule permits: it has to fail without the fix and cover
the input that failed, not just the happy path.

**Re-read the request before reporting.** The best-practices page's self-check
step (verify the answer against the criteria) is applied to the artifact this
harness produces: the diff check now also asks whether every part of the request
is covered.

**Decide the reversible, ask for the rest.** The vendor's autonomy guidance is
to act when enough information is available and to confirm risky or irreversible
actions, and it is explicit that persistence must not swallow the confirmation
step. `# Autonomy` turns that into one decision test — reversibility and blast
radius — and gives the model a level (`guided`, `balanced`, `autonomous`) that
moves the line without moving any permission gate. The permission engine still
owns what may run; this section only says what to ask about. The long form is
[autonomy](autonomy.md).

**An approval is not a standing order.** The documented autonomy failure mode is
the agent reading a yes to one action as permission for every later action of
the same shape. `# Autonomy` now says an answer covers the action it was asked
about, not the class, so the next request is decided by the same test rather
than by the previous answer. Delegation got the same treatment from the other
end: the Task tool asks for the worker's file ownership and output format up
front, warns against two writers on one file, and tells the parent to check a
report before relying on it. A worker is told that no user is reachable and
that its evidence belongs in the report.

The short prompt for small models and tiny windows keeps the same hard rules in
compressed form, since it is a separate body and would otherwise drift. It gained
the regression-test exception, the act-on-a-change line, the red-before-green
rule, and the safety-check line.

## What the eval-design page informs

The develop-tests page is about how to test a prompt, not about what to put in
one, so most of it does not become prompt text. Its principles do apply to this
repository's evaluation work: success criteria should be specific, measurable,
and automated where possible; there should be many cases with a weaker automatic
score rather than a few hand-graded ones; and edge cases and ambiguous inputs
belong in every set. `packages/coding-agent/test/system-prompt.test.ts` follows
the first and third — each clause is pinned by a distinctive phrase, and the
short prompt has its own cases because it is a different body. `scripts/benchmark.ts`
already embodies the second: the task set is the repository's own history, and
red-to-green is automatic and needs no rubric. The page's LLM-as-judge advice
(use a different model as the grader) applies only if a judged eval is added;
nothing in the repository uses one today.

## Deliberately not adopted

**Code ownership.** The guidance that the model owns the codebase reliably
raises duplicate-code consolidation, but it also raises output by 70–80% and
produces unrequested changes, and the vendor notes that a minimal-diff rule
does not cancel it. This harness's contract is the opposite — focused changes,
nothing unrequested — so the ownership line would fight a rule higher up in the
same prompt.

**Effort calibration and "do not think" instructions.** Effort is a per-request
parameter and `thinkingLevel` already exposes it; the vendor guidance says
prompt text does not stop thinking at `medium` and above. A prompt clause would
be a second, weaker control next to the real one.

**Prefill migration.** Nothing here used assistant prefill, and the current
models reject it.

**Long-form writing rules and report templates.** The base prompt already says
to answer directly and avoid padding. The vendor's own guidance warns that
hard writing rules ("one idea per sentence") make output stilted; the recap is
the one structural request worth making.

**Medication, payments, and frontend-aesthetics blocks.** These are specific to
those products; the general principle that survived is the risky-action
confirmation list already in `# Finishing work`.

## Where the tests are

`packages/coding-agent/test/system-prompt.test.ts` pins each new clause above
the dynamic boundary, said once, by its distinctive phrase rather than by a
golden file. The short prompt gets its own small suite for the same reason: the
full prompt's assertions never read those bytes.
`packages/coding-agent/test/subagents-skills-plan.test.ts` pins the Task tool
description, which is a prompt the model reads on every call and is not part of
the system prompt.
