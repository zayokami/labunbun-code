# Developer design notes

This directory holds the long-form design notes for the labunbun repository. Each document carries notes that moved out of the source comments. The source keeps a short comment with a pointer, `// Long-form design notes: docs/dev/<topic>.md`.

- [Agent Client Protocol](acp.md): the editor-facing server over stdio — the frames it emits, the modes it advertises, the permission round trip, and what `session/load` replays.
- [AI layer](ai-layer.md): the model registry, the prompt cache rules, and the wire adapters in `packages/ai`.
- [ChatGPT subscription](chatgpt-subscription.md): the app-side sign-in for a ChatGPT subscription — the credential store, the two login shapes, and where the app wires them.
- [Checkpoint ledger](checkpoint-ledger.md): the record of what the agent did — the entry one finished tool call leaves, the file snapshots `/rewind` restores from, and the recovery line a resumed session prints.
- [Claude subscription](claude-subscription.md): the app-side sign-in for a Claude subscription — the credential store, the login flow, and where the app wires them.
- [Command classifier](command-classifier.md): the classifier that reports whether one command line can destroy data, and the permission engine that runs it.
- [Crash consistency](crash-consistency.md): what survives a killed process — the files replaced by a rename, the files appended to, and the writes still made in place.
- [Gemini subscription](gemini-subscription.md): the app-side sign-in for a Gemini subscription — the credential store, the loopback and paste login shapes, and where the app wires them.
- [MCP client](mcp.md): connecting `.mcp.json` and settings servers — tool adaptation, list-change refreshes, the approval gate, and the `/mcp` reads.
- [Migration framework](migration-framework.md): how the framework reads another agent's files and writes them into labunbun.
- [Migration sources](migration-sources.md): what the module for each source knows about the product it reads.
- [Missions](missions.md): what the last run left behind — the close-out note, the shell ledger a resume probes, the subagent orphan notice, the `/tasks` tree, and the exit guard.
- [Model roles](model-roles.md): the five seats of `settings.roles` — how each resolves fail-soft, the fallback chains, and the budget rule that refuses a request past its ceiling.
- [Out-of-box experience](oobe-design.md): what a brand-new user meets on a machine with no settings file and no credential — the call path from an empty home, what OpenAI's Codex CLI does in the same position, and the first-launch flow this app builds.
- [Output limits](output-limits.md): the bounds on tool output per result and per round, and the capture of a stream that has not finished.
- [Plan mode](plan-mode.md): the permission mode and the interactive cycle — entry and approval, the review dialog, the plan and task snapshots, the board reminders, and the seats each host runs.
- [Sandbox](sandbox.md): the sandbox policy as a value, its three platform back ends, and the network proxy.
- [Session store](session-store.md): the JSONL session tree, its append-only form, branches, and compaction.
- [Split panes](split-pane-design.md): whether two things can be shown at once — the design gate for a watch panel, view screens, and a full-screen workspace over the Static scrollback model.
- [Tools](tools.md): the built-in tool set in `packages/tools/src` and the operations layer below it.

Every document is in English. Each claim cites its source as `path:line`.
