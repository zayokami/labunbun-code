# Authorization, blockers, and sensitive material

## Two questions, asked separately

Entitlement — is this the user's artifact? Investigate only what the user owns or is authorized to analyze; that is a question about the target. If the user's words point at several plausible targets, that is a question back to the user, not a license to pick the likeliest. Files that are nearby, convenient, or look like the described one — samples, fixtures, other projects in the same folder — are not the target. Never substitute a different target or scope and report the result under the original question; that produces a false claim with a clean audit trail.

Authority — is this action allowed? The actions an investigation uses form a ladder, roughly:

1. Reading a saved artifact: bytes on disk, a recorded capture, a document.
2. Inspecting a live system passively: watching what is already running.
3. Starting, attaching to, or driving a program.
4. Interacting with networked services.
5. Writing, extracting, or modifying anything.

Climbing one rung does not grant the next. Inspecting is not executing: a permission to look at a thing — a readability check, an open port, a passing configuration probe, an unlocked file — is never the permission to run, contact, or change anything. Where the two questions blur, stop and re-ask them in order, because a confused authorization is how an investigation ends up doing something nobody approved.

## When a step is blocked

Name the layer that blocked, because the layers have different remedies: a session or client policy may require approval for this specific operation; the environment may lack a tool that understands the format; a target may simply be unavailable; some blocks are deliberate boundaries and not problems at all. Calling every block "the tooling is broken" leads to the worst behavior — repeated attempts and environment surgery.

- Do not fire an identical request again hoping for a different answer. Change something real — the input, the scope, the layer — or stop.
- Do not widen approval, scope, or target to get past a decision that was made. Do not disable, weaken, or step around a safeguard — a sandbox, a permission prompt, a network restriction — to make an analysis step succeed. Adding or upgrading surrounding software is not a fix either; the investigation adapts to the environment, not the reverse.
- Keep the user's question in view: continue the parts the same question allows — another evidence type, another sub-question — record the blocked step in the ledger as open with the missing authority named, and report the block plainly: what was attempted, what refused it, what would unblock it.

Also keep evidence authorship straight: output from a general-purpose shell utility is a different grade of evidence from output of a purpose-built analyzer, and the report says which produced what.

## Sensitive material

- Keep authentication tokens, session material, private keys, and anything the user or configuration marks sensitive out of the ledger, the report, and any file written during the investigation. Redact at the point of collection; scrubbing later misses the copy that already left.
- Secrecy follows provenance, not spelling. A value is sensitive because of where it came from and what it is known to be — not because its name sounds dangerous, or harmless. Mark sensitive things deliberately and carry the marking; a string's appearance settles nothing, in either direction.
