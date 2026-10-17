# The Agent Client Protocol

ACP is the Agent Client Protocol: an editor (Zed is the client this exists for) launches the agent as a child process and speaks JSON-RPC 2.0 over stdio with newline-delimited framing — one JSON object per line, in both directions, and nothing else on the wire (`packages/coding-agent/src/acp.ts:1-9`). The agent half lives in `packages/coding-agent/src/acp.ts` and is started by `labunbun acp` or the `--acp` flag (`packages/coding-agent/src/main.ts:62`, `:218-222`); the README's "Editor sessions" section is the user-facing side of the same page. Sessions are the same `AgentSession`s a `-p` run and the REPL use — the same loop, tools, settings, permission engine and hooks, assembled through the same helpers `headless.ts` calls — so a turn cannot behave one way under `-p` and another way under an editor (`acp.ts:11-21`).

"The wire carries frames only" is the constraint the rest of the file is written around. Every notice goes to stderr: version mismatches (`acp.ts:580-585`), ignored settings keys (`:877-878`), role, compaction and downgrade warnings (`:892`, `:922`, `:987`), the damaged-session notice (`:637`), hook and skill notes (`:994-995`, `:1038`), and the subagent orphan notice a session reads at assembly (`:968-969`). `main.ts` skips its ConPTY write-chunking install on this path for that reason — the transform inspects bytes for a viewport's last newline, which a frame stream should never see (`main.ts:309-317`).

## The wire and its methods

`runAcp` (`acp.ts:1181-1193`) wraps `process.stdout`/`stdin` as web streams, hands them to the protocol library's `ndJsonStream` (`@zed-industries/agent-client-protocol`), and constructs the `AgentSideConnection`. It serves until stdin ends — the client's way of ending the session (`:1196-1201`) — then closes out every open session with a `mission` close-out note and runs the pending `SessionEnd` hooks (`:837-857`), and returns 0.

The implemented method set is the mandatory half of the agent side plus `session/set_mode` (`acp.ts:11-21`):

- `initialize` (`:573-596`) answers with exactly the protocol version this agent speaks, whatever the client asked for; a different request is named on stderr rather than answered with a version this agent cannot be. Capabilities are `loadSession: true` and an empty `promptCapabilities` — `session/load` is implemented, image, audio and embedded-context blocks are not interpreted.
- `authenticate` (`:601-610`) is a stub: no `authMethods` are advertised, so the weird method id is worth a stderr line and an empty success rather than a failed sign-in nobody can act on.
- `session/new` (`:612-617`) resolves the cwd, assembles a session, and answers `{ sessionId, modes }`.
- `session/load` (`:618-655`, below), `session/prompt` (`:670-716`), `session/cancel` (`:719-725`), `session/set_mode` (`:658-669`).

Deliberately not implemented, as a second batch (`acp.ts:23-38`): `fs/read_text_file`/`fs/write_text_file` and `terminal/*` (the local tools stand in for the client's filesystem and terminals), `mcpServers` from `session/new`/`session/load` (configured servers are not connected), a real `authenticate`, `available_commands_update` and with it the expansion of a prompt that names a skill (a `/skill-x` goes to the model as written), `session/set_model` (UNSTABLE in the protocol), and the partial half of `tool_execution_update` (there is no representation for a half-typed tool result; the update is announced `in_progress` and the partial is dropped).

## Modes

`ACP_MODE_ROWS` filters the app's mode table down to rows whose `id` is the mode itself (`acp.ts:516`; the table is `MODE_CHOICES` in `packages/agent/src/types.ts:72-105`): `ask`, `plan`, `agent`. The `agentNoSandbox` pairing is left out on purpose — `SessionMode` is one opaque string, so advertising it would mean an editor offering a mode id no other client understands (`acp.ts:510-516`). `sessionModesFor` (`:519-525`) labels the rows from the same table the REPL's picker reads, so the two cannot drift apart. `session/set_mode` (`:680-691`) maps the id back through `permissionModeFromModeId` (`:527-529`), leaves the sandbox axis where it stands — the protocol names one axis, and the other is the user's own setting (`:685-688`) — and announces `current_mode_update`. The session's initial pairing is the REPL's, not headless's: an editor has a person in front of it and an "ask" that reaches them is the whole point (`acp.ts:1018-1033`).

The `plan` row is a permission mode only. An editor session gets the engine's read-only gate from it, but no `EnterPlanMode` or `ExitPlanMode` tool, no review dialog, and no approval loop: its tool set is the `createAllTools` set with the task board and without the plan tools (`acp.ts:975-982`, `:1076-1077`). The task board itself is present and per live session (`:968-975`, `:996-1002`).

## The permission round trip

When the permission engine's answer is `ask`, the question becomes a `session/request_permission` the editor's user answers — the difference from headless, where an unresolved ask is a silent denial (`acp.ts:1099-1102`). Everything else — allow and deny rules — settles without the client (`:767-774`); with no client connected, the ask is a denial (`:775-778`).

The four options (`acpPermissionOptions`, `:255-267`) are the protocol's four kinds. The first three labels are the REPL's own `permissionOptions`, so the same question reads the same way in a terminal and in an editor — and the "always" answer says the scope it actually grants; `reject_always` has no REPL counterpart (the dialog's "no" is once per call), so its label says so. `permissionFromOptionId` (`:270-283`) maps the answer back to allow/deny plus remembering; an option id the agent never offered fails closed (`:800-804`).

Two details are about where the question lands and how it can end:

- The question is attached to the tool call the editor is already showing, through the id kept from that call's `tool_execution_start` (`takeAnnouncedCallId`, `:1132-1139`) — concurrent calls of the same tool are why this is a list with a consumed flag rather than a map by name (`:1124-1131`).
- The answer races the run's abort signal (`raceWithAbort`, `:1148-1164`). A cancelled turn settles the tool as *denied*, not left pending: the response to the permission request belongs to the client, and abandoning the promise would leave the tool batch held open behind a dialog the editor has dismissed (`:748-759`, `:791-798`). The client's own cancellation and the abort are different facts that reach the same denial (`:1141-1147`).

A remembered answer writes the same session-scoped rule the REPL's "don't ask again" writes, scoped the same way (`ruleSpecifierFor`), so an "always" answer in an editor cannot grant more than the same answer in a terminal (`:805-818`).

## One turn

`session/prompt` (`acp.ts:671-717`) runs one prompt at a time per session (`:674-676`) and rejects an empty one (`:677-680`). The `UserPromptSubmit` hook runs on the typed text before anything is stored — the same order `-p` uses, so a hook that blocks a prompt blocks it in both; a blocked prompt becomes a JSON-RPC error carrying the hook's reason (`:683-701`).

The turn's progress arrives as `session/update` notifications built by `updatesForEvent` (`:295-308`):

- a tool's start becomes a `pending` `tool_call` with a kind and a one-line title (`:318-327`, `:166-205`); a partial update is announced `in_progress` and the partial itself is dropped (`:302`);
- the end becomes a `tool_call_update` with `completed` or `failed` and the text result (`:344-371`) — a command that exited 1 is a failed call, not a completed one;
- text and thinking deltas become `agent_message_chunk` and `agent_thought_chunk` (`:329-342`).

`agent_end` does not become a frame: the turn's end is the *response* to `session/prompt`, built from the loop's own return value rather than from a flag a notification handler set, so it cannot be missed or double-counted (`:285-294`). `stopReasonFor` (`:145-158`) maps `completed` → `end_turn`, `aborted` → `cancelled` and `max_turns` → `max_turn_requests`; `error` has no protocol counterpart, because the remaining reasons describe what the model did and a machinery failure is a failed request — the response is a JSON-RPC `internalError` carrying the loop's last error message (`:705-712`, `:1166-1173`).

Updates are started, not awaited: the session's event emitter awaits its handlers, and a slow socket must not become the model loop's clock; the order is still the call order, because the connection queues writes in the order they were made (`acp.ts:740-744`).

`session/cancel` (`:719-725`) is a notification and therefore unanswerable — an id nobody has is a no-op rather than an error the client cannot hear. It aborts the session, and the acknowledgement is where the protocol puts it: the interrupted `session/prompt` answers `stopReason: "cancelled"` (`:149-152`).

## `session/load`

`session/load` (`acp.ts:619-656`) resumes with the same lookup `--resume` uses — `findSession` over `listSessions`, then `loadSessionForResume` from `session-resume.ts` — so a client carrying the id from `session/new` and a person who typed the short tail both land in the session they meant (`:625-632`). An id nothing saved is `invalidParams` (`:630`, `:632`), and the damaged-session notice goes to stderr, because a resumed conversation that is shorter than it was must not be presented as whole (`:633-637`).

The protocol's contract for this method is that the entire stored history reaches the client as `session/update` frames *before* the load response does. The replay is `replayUpdatesForMessages(loaded.store.messages())` (`:645-647`, `:446-483`) — the store's full linear history, deliberately not the model-facing view: a compaction boundary is a statement about what the model is sent next, and a client showing the session shows the conversation the person had, including the part the boundary dropped from future requests (`:421-425`). Each frame is awaited before the next, so the response cannot overtake the history, and the session is registered only after the replay — a request that raced it must not find a session whose history is still arriving (`:640-652`).

The replay's pairing rules (`:427-444`): an assistant tool call and the result that answers it become the same two frames the live stream sent, the update emitted where the result sits in the file so parallel calls finish in the order they actually finished; a call with no result on the path becomes `tool_call` alone with status `pending`, the value the live announcement carried, where `in_progress` would claim the call is running now and `completed`/`failed` an outcome never recorded; a result whose call is missing is announced first from what the result itself knows — its tool name and no input — so the client has a row to attach the outcome to. The response carries `modes` and no `models`: that field is UNSTABLE, the same reason `session/set_model` is not implemented (`:653-655`).

## Session assembly

`#createSession` (`acp.ts:871-1121`) is the shape `headless.ts` assembles a `-p` run in: the same settings tiers, permission rules and engine, tool set, compaction wiring, hooks, memory and skills, and the same spill directory. It is written out rather than shared, because the two differ in exactly the places that matter — the defaults each mode may pick, the mode sources, and where a turn's output goes (`:859-869`). The details worth naming:

- `settings.roles` resolves fail-soft, warned on stderr (`:904-914`). An editor session advertises the `plan` permission mode but has no `EnterPlanMode`/`ExitPlanMode` tools and no review loop, so the plan seat resolves but is never used; it also has no subagents, so the light seat is unused (`:904-908`, `:1076-1077`). Its task board is real and per live session: one `TaskStore` bound to the session's store, restored on load and re-saved when a compaction ends (`:974-975`, `:997-1002`, `:1128-1133`). The fallback orders cover main and compaction only (`:1078-1091`).
- The model precedence is the REPL's — explicit `--model`, persisted `settings.model`, `roles.main`, built-in default — and an unknown model is a JSON-RPC error, not a stderr line and an exit code (`:894-910`).
- The budget gate (`checkBudget`, `:1093-1097`) runs before every request: the model about to answer names its seat by ref (a model no seat owns is never gated), and the spend is this conversation's cumulative total re-costed from the transcript's own usage records — an editor session has no ledger of its own, and a resumed conversation counts what it already spent because the costed messages are the ones it was resumed with (`:1085-1092`).
- The sign-in store is the same one the REPL reads, Claude, ChatGPT and Gemini (`:998-1008`); `SessionStart` runs at assembly (`:990-996`), `SessionEnd` at shutdown (`:837-857`).

## Tests that hold these claims

- `packages/coding-agent/test/acp-mapping.test.ts` holds the pure mappings with no session or socket anywhere near them (`acp.ts:126-132`): stop reasons (`:64-81`), tool updates (`:81-146`), kinds and titles (`:146-169`), the history replay (`:170-308`), prompt blocks (`:309-347`), permission options (`:348-370`), session modes (`:371-391`).
- `packages/coding-agent/test/acp-e2e.test.ts` runs a real child process per contract: initialize, session/new and session/prompt answer in frames and stdout carries nothing else (`:340`), `--acp` is the same server and closing stdin ends it with exit 0 (`:397`), a flag this mode cannot honor is refused rather than parsed and dropped (`:410`), the permission round trip both ways (`:429`, `:474`), `session/cancel` answering `cancelled` (`:499`), `session/load` replaying before it answers (`:518`), an unknown id as `invalidParams` with no session started (`:583`), every open session closing out with a `mission` note at shutdown (`:607`), and the orphan subagent notice on `session/load` with stdout staying frames (`:649`).
