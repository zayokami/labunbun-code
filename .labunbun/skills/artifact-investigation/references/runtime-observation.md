# Runtime observation

## Static evidence stops at existence

Reading code, strings, manifests, banners, or configuration shows what the artifact contains. It never shows what ran. A registered handler, a declared capability, a hardening flag, a feature constant — all static facts about possibility, none of them behavior. Never phrase a static finding as an executed one: "the module is bundled" is not "the module loads", and "the route exists" is not "the route serves".

## Passive versus active observation

Passive observation watches a running thing without touching it: reading a log, inspecting an application the user already opened, examining a capture that was recorded earlier. Its reach is exact and narrow — the channel it listened on and the window it was attached.

- It cannot see before it attached, and it cannot prove a thing did not happen somewhere else.
- Report authorship precisely. If the user clicked, the record shows the user clicked; claiming the click as yours attaches your name to an action you did not perform.

Active observation drives the target: starting it, sending input, walking a scenario end to end. Two obligations come with it.

- Declare the actions, then report that you performed them — on which target, in which way.
- Keep the result in its scope: one driven run is one path through the program. It does not show the path is common, that an ordinary user can reach it, or that it is the only one. A module that loads is not a handler that fires; a component present in a running process is not a code path taken.

For both kinds, the recording's limitations — attach time, filters, truncation, dropped records — belong next to the finding they qualify. A general caveats paragraph at the end is where limitations go to be ignored.

## Freshness and pairing

A capture is a moment, not a current state. A question about "now" needs the observation established as current, or labeled as historical. Prefer the newest capture whose window actually covers the question.

Pairing what ran with what is on disk goes through exact identity: the digest of the code that executed against the digest of the code being read. Matching file names, matching structure, or matching string fragments are hypotheses, not pairings. When recorded identity and current identity disagree, the disagreement is itself a finding — preserve it; do not resolve it by choosing the convenient side.

## Choosing the evidence type

Ask what the claim needs, then go get that.

- Structure, contents, strings, declarations — a static read answers directly.
- Behavior, ordering, defaults, enforcement, reachability — runtime observation, if it is authorized (see `references/authorization-and-blockers.md`). A static fact can bound the runtime answer — "this branch is the only writer of that file" — without becoming it.
- When runtime evidence exists, it still does not upgrade neighboring static claims; it answers the question it was recorded for.
