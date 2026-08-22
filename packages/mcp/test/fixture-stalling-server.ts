/**
 * MCP stdio fixture that accepts the connection and then never answers.
 *
 * This is what the connect timeout exists for: the pipe stays open, so the
 * transport never reports a close, but `initialize` gets no reply. A process
 * that merely exits (or closes stdio) would instead surface a connection
 * error and never reach the timeout branch.
 */

// Hold stdin open so the parent's transport sees a live pipe.
process.stdin.resume();
// Keep the event loop alive, writing nothing to stdout, until killed.
setInterval(() => {}, 1_000);
