# Native reverse-engineering engines

The engine family lets the agent drive the tools a reverse engineer already has — IDA Pro, Ghidra, Frida and x64dbg — without an MCP server in between. It lives in `packages/tools/src/engines/` and is deliberately separate from the `Inspect*` readers: those parse bytes and never start a process, while every engine tool here starts a third-party program through `Operations.exec`, the same seam Bash uses.

The reference implementation for these capabilities is REA (`rea-main`), which reaches IDA and Ghidra through MCP bridges. This package keeps the operation vocabulary that REA exposes, but owns the process lifecycle itself: there is no bridge server to supervise, no resident JVM, and no long-lived debugger session to leak.

## Behavior

### Detection is a filesystem read

`DetectReverseEngines` is the only read-only member of the family, and the only one in the plan-mode allow-list. It reads environment overrides, `PATH`, and the tools' usual install directories; it never starts an engine. The report says where each install was found, the Ghidra version from `Ghidra/application.properties`, and both x64dbg headless builds. A detection says an install exists, not that it runs — the analysis tools are what find that out.

Discovery is a pure function over an injected `Probe` (`platform`, `env`, `isFile`, `isDirectory`, `readDir`, `readText`), so a test can describe a machine that does not exist. The environment overrides are `LBB_IDA_PATH`, `LBB_GHIDRA_HOME` (also `GHIDRA_HOME` and `GHIDRA_INSTALL_DIR`), `LBB_FRIDA_PATH`, and `LBB_X64DBG_PATH`. x64dbg is never discovered on a non-Windows host.

### The shared lifecycle

Both static tools copy the target into a private workspace under the system temporary directory, hash the source and the copy with SHA-256, and refuse to continue if the two differ. The engine is pointed at the copy under a name that keeps the original extension, because IDA and Ghidra choose a loader from it. The original is never opened by the engine and never modified. The workspace is removed in a `finally`; a failed removal is logged with its path rather than hidden.

Every run goes through `runEngineCommand`, which calls `Operations.exec` under a `workspacePolicy` built from the session's sandbox and network axes, with the private workspace added as a writable root. Commands are assembled from fixed tokens plus paths this package chooses; the engine path is the only environment-derived token, and it is quoted. A path containing a quote or newline is refused before a command is built.

Reports are capped at 24,000 characters with the usual cut marker. Listings paginate by `offset` and say so in the last line. The engine's own log is read for a failed run and its last lines are attached to the error.

### IDA Pro

`AnalyzeWithIda` runs the text-mode driver in batch mode:

```
idat64 -A -Lida.log -Sbridge.py sample.exe
```

The bridge is an original IDAPython script embedded in `ida.ts`. It reads a JSON request from the workspace, calls `ida_auto.auto_wait()` so the analysis is complete before any query, writes one JSON object atomically, and exits with `ida_pro.qexit(0)`. It never saves the database and never executes the target. The actions are `metadata`, `functions`, `strings`, `segments`, `exports`, `function`, `decompile`, `xrefs`, and `bytes`; `decompile` uses Hex-Rays and therefore needs a license. IDA database files (`.i64`, `.idb`, `.id0` and the rest) are refused as input: the tool analyzes programs, not databases.

The default timeout is 600 seconds. IDA's exit status is not ignored — a result file is authoritative even when `qexit` leaves an odd code, but the code is printed beside the report.

### Ghidra

`AnalyzeWithGhidra` runs one headless import:

```
analyzeHeadless <workspace>/project lbb -import sample.exe \
  -scriptPath <workspace> -postScript LbbBridge.java -deleteProject
```

REA keeps a JVM alive per target and speaks NDJSON over a private socket. That is the right shape for an interactive session and the wrong first slice here, because it needs a resident bridge process to own and reap. The one-shot form instead generates a `GhidraScript` subclass per call, with the action and parameters compiled in as constants; Ghidra compiles the file each run, so no caller text passes through a parser or a command line. The script writes `out.json` and the tool reads it. The Java uses only the long-stable program model: `FunctionManager`, `SymbolTable`, `Listing`, `ReferenceManager`, and `DecompInterface`.

The action vocabulary matches IDA. Ghidra cold starts are slow — several minutes on Windows is normal — so the default ceiling is 900 seconds and the failure text says the time limit was reached rather than implying the target was bad.

The constants are substituted in a single scan with a function replacer. A replacement string has its own syntax (`$&`, `$'`, `` $` ``, `$$`), and chained replacements would also rewrite a placeholder that appeared in an earlier value, so a symbol named `__LIMIT__` would leave the real constant undefined. One pass over the template makes caller text inert in both ways.

### Frida

`ListFridaTargets` runs `frida-ps -j -e` (adding `-a` for applications) and filters the JSON in TypeScript. It does not use `frida-ls-devices`, which needs a TTY and hangs without one. Listing does not attach to anything, but it does start a third-party program, so it is not declared read-only.

`InstrumentWithFrida` runs one bounded CLI invocation:

```
frida -q -t <seconds> -l script.js <attach or spawn arguments>
```

Exactly one of `script` (inline) or `scriptPath` must be provided. The script is written to the private workspace and is the only caller-authored file the run loads. Attach takes a pid or a process name; spawn takes a workspace file. The CLI's own timeout detaches at the end; if it outlives the tool's ceiling, `Operations.exec` kills the process tree and the report says the detach is unconfirmed. There is no persistent session, no injected agent left behind, and no handle a later call could reach.

Instrumentation executes the target's code and can change its behavior, so the tool is neither read-only nor concurrency-safe.

### x64dbg

REA has no x64dbg integration; this tool is designed from the debugger's own headless mode instead of ported. GUI x64dbg cannot run headless — it opens modal dialogs and has no quit command — while `headless.exe`, which ships beside the GUI in `release/x64` and `release/x32`, is what x64dbg's automated tests use. Its interface is not a stable public contract, so the tool takes no caller-authored commands and offers one action: a module snapshot.

The tool reads the PE machine word to choose the x64 or x32 headless build (`0x8664` or `0x14c`), refuses any other machine, any non-PE input, and a DLL (the COFF `IMAGE_FILE_DLL` flag), and runs a fixed script from the private workspace:

```
headless.exe -testing -userdir <workspace>/userdir -cf snapshot.script sample.exe
```

`-userdir` keeps x64dbg from writing its per-user database and configuration into the real profile; the tool creates that directory first, because x64dbg's startup refuses a `-userdir` that does not exist. `-testing -cf` makes the debugger run the script and wait for it instead of showing the GUI's dialogs. The script is:

```
RedirectLog snapshot.log
log "LABUNBUN snapshot begin"
var $base
mov $base, mod.main()
log "LABUNBUN base={x:$base}"
testassert $base
log "LABUNBUN entry={x:mod.entry($base)}"
log "LABUNBUN size={x:mod.size($base)}"
imageinfo $base
modcallfind
log "LABUNBUN status=ok"
stop
ret
```

The assert sits before the marker on purpose: when the module did not load, `mod.main()` is zero, the assertion aborts the script, and `LABUNBUN status=ok` is never written; x64dbg's own `testfinalize` records the run as failed too. The tool also refuses a zero base outright, so a log cannot turn an unloaded image into a snapshot.

The exit code is not a verdict: a headless test run can exit zero after a script error and non-zero after a complete snapshot. Success is the `LABUNBUN status=ok` marker the script logs. Headless writes the redirected log as UTF-8 bytes (`headless.cpp` appends the same text it prints); x64dbg's GUI redirection writes UTF-16LE with a byte-order mark. The tool reads UTF-8 and still recognizes a UTF-16 BOM, so the marker matches whichever build wrote the file. The log is returned as-is, capped.

The log path goes into the script through the script's own quoting rules, not `JSON.stringify`: the parser keeps a backslash literal unless it precedes a quote or a brace, so JSON escaping would double every Windows separator.

The debuggee runs under a debugger, so `DebugWithX64dbg` refuses anything below `danger-full-access` and is never read-only or concurrency-safe. It is Windows-only.

## Permissions and plan mode

Only `DetectReverseEngines` declares `isReadOnly: () => true` and appears in `PLAN_MODE_READ_ONLY_TOOLS`. The other five are non-read-only and non-concurrency-safe; the bilateral allow-list test in `packages/coding-agent` holds the declaration and the static list together. IDA, Ghidra and Frida need a writable private workspace and refuse the `read-only` sandbox. x64dbg needs `danger-full-access` because the debugger cannot work inside the sandbox wrapper.

## Why it is like this

The engine family is native rather than MCP-only because a user with IDA installed should not have to install and supervise a second server to use it. The static tools keep REA's operation vocabulary but not its resident bridges: a batch run has one process to own, one log to read, and no state to leak between calls.

The private copy is not a sandbox boundary — the engine runs with the user's own privileges — but it is the difference between "the analysis tool wrote next to the sample" and "it did not". It also makes the hash check meaningful: the bytes analyzed are the bytes the user named.

Honesty about what each tool does is part of the contract. Static analysis never executes the target and says so. Frida and x64dbg execute it and say so. Detection never starts an engine and says so.

## Known traps

- `frida-ls-devices` hangs without a TTY (prompt_toolkit); device listing is not offered.
- Ghidra's headless startup can take 400–600 seconds on Windows. A short timeout reads as a broken target when it is only a cold start.
- x64dbg's `-testing -cf` interface is undocumented. The fixed script and the log marker are the only stable parts, and `testassert` is there for x64dbg's own test harness.
- `-userdir` is a recent x64dbg option. A build that predates it ignores the flag and keeps its user data in its install directory; the analysis itself is unaffected.
- A headless x64dbg script can fail silently as far as the exit code is concerned; never derive success from it.
- Ghidra's `strings` scan stops after 2,000,000 defined data items. The report carries `scanCapped` and says the list is incomplete; `hasMore` would be the wrong word, because another page would meet the same budget.
- Ghidra's block and function ranges use an inclusive end address; IDA's `end_ea` is exclusive. Both rows carry a size, which is the field to compare.
- IDA's `qexit` can leave a non-zero exit status after a complete result. A present `out.json` is authoritative; the status is still printed.
- Windows can keep a handle open after a tool exits, so workspace cleanup is best effort and a failure names the path.

## Source map

| File | Role |
| --- | --- |
| `packages/tools/src/engines/common.ts` | Discovery, the workspace, the copy and digest check, command quoting, result reading, and failure text. |
| `packages/tools/src/engines/detect.ts` | `DetectReverseEngines`, the read-only report. |
| `packages/tools/src/engines/ida.ts` | `AnalyzeWithIda` and the embedded IDAPython bridge. |
| `packages/tools/src/engines/ghidra.ts` | `AnalyzeWithGhidra`, the generated Java source, and its renderers. |
| `packages/tools/src/engines/frida.ts` | `ListFridaTargets` and `InstrumentWithFrida`. |
| `packages/tools/src/engines/x64dbg.ts` | `DebugWithX64dbg`, PE machine selection, and the fixed snapshot script. |
| `packages/tools/src/engines/index.ts` | The family's exports. |
| `packages/tools/test/engines.test.ts` | Discovery over virtual probes; command, rendering and lifecycle checks with a faked exec. |

## Verification

```sh
bun test packages/tools/test/engines.test.ts
bun run typecheck
bun run lint
```

The tests never launch an engine. A fake `Operations.exec` writes the result file the real engine would have written into the workspace it was handed, which holds the tool to the command it builds, the copy it analyzes, the report it renders, and the cleanup it promises.
