// The source-checkout entry for the network bridge. A compiled build has no
// file here to point at and re-enters the CLI's main with `__bridge` instead —
// see `bridgeRuntime` in ./bridge.ts, which is the one place both shapes are
// told apart.
import { runBridge } from "./bridge.ts";

await runBridge(process.argv.slice(2));
