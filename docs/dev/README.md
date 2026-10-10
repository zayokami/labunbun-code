# Developer design notes

This directory holds the long-form design notes for the labunbun repository. Each document carries notes that moved out of the source comments. The source keeps a short comment with a pointer, `// Long-form design notes: docs/dev/<topic>.md`.

- [AI layer](ai-layer.md): the model registry, the prompt cache rules, and the three wire adapters in `packages/ai`.
- [Command classifier](command-classifier.md): the classifier that reports whether one command line can destroy data, and the permission engine that runs it.
- [Migration framework](migration-framework.md): how the framework reads another agent's files and writes them into labunbun.
- [Migration sources](migration-sources.md): what the module for each source knows about the product it reads.
- [Output limits](output-limits.md): the bounds on tool output per result and per round, and the capture of a stream that has not finished.
- [Sandbox](sandbox.md): the sandbox policy as a value, its three platform back ends, and the network proxy.
- [Session store](session-store.md): the JSONL session tree, its append-only form, branches, and compaction.
- [Tools](tools.md): the built-in tool set in `packages/tools/src` and the operations layer below it.

Every document is in English. Each claim cites its source as `path:line`.
