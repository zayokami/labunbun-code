// The Linux loopback bridge: the one route back into a `bwrap` network
// namespace. A confined command's proxy variables point at loopback ports, and
// the namespace has no route to the loopback those ports live on — so a small
// process inside the namespace listens on those same ports and forwards over a
// Unix socket to the host, where `NetworkProxy` serves the other end. The
// socket file is the entire rendezvous: it rides the filesystem the two
// namespaces share, and nothing else crosses.
// Long-form design notes: docs/dev/sandbox.md
import { existsSync } from "node:fs";
import { createServer, connect as netConnect, type Server } from "node:net";
import { join } from "node:path";

// Long-form design notes: docs/dev/sandbox.md
/**
 * One hop of the bridge: the loopback port a confined command dials, and the
 * socket its traffic lands on. The port numbers are the proxy's own, on both
 * sides, so the proxy environment needs no rewriting for the confined command.
 */
export interface BridgePair {
	readonly port: number;
	readonly socket: string;
}

// Long-form design notes: docs/dev/sandbox.md
/** The host side of the bridge, published by the proxy that serves its sockets. */
export interface UnixBridge {
	readonly pairs: readonly BridgePair[];
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * The argv that starts a bridge under this same executable. Two shapes: a
 * source checkout runs the script beside this file, and a compiled binary
 * re-enters its own entry point with `__bridge`, because on disk there is no
 * script to point at (measured: a compiled binary reports a virtual
 * `import.meta.dir`, and the join below does not exist under it). `exists` is
 * injected so a test can hold either shape still.
 */
export function bridgeRuntime(exists: (path: string) => boolean = existsSync): string[] {
	const script = join(import.meta.dir, "bridge-main.ts");
	return exists(script) ? [process.execPath, script] : [process.execPath, "__bridge"];
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * `command`, wrapped so the bridge is up before it runs. `undefined` when the
 * command must not be wrapped — no pairs to bridge, or no `/bin/bash` to run
 * the wrapper — and the caller then keeps the bare argv, which in a restricted
 * namespace is the dead network this build had before the bridge existed.
 *
 * The wrapper is one `bash -c` script. It brings loopback up — belt and
 * braces, not the mechanism: bubblewrap's own `loopback_setup()` raises `lo`
 * on every `--unshare-net` and exits if it cannot (measured against 0.9.0,
 * the version this repo's CI installs), so the `ip` line only covers older
 * bubblewrap's namespaces, where `lo` stays down. Then it starts the bridge
 * in the background — stderr attached, because a bridge that cannot listen
 * says so there and nowhere else — and polls both
 * ports with `/dev/tcp` until a connect succeeds — the only evidence that
 * matters, because it is exactly what the confined command will do. On timeout
 * it says so on stderr and runs the command anyway: fail closed, like every
 * other unavailable-network path, rather than refusing a command the user
 * asked for. The command itself is passed through as positional arguments and
 * `exec`ed, so its argv is untouched and its exit status is its own.
 */
export function wrapWithBridge(
	command: readonly string[],
	bridge: UnixBridge,
	exists: (path: string) => boolean = existsSync,
): string[] | undefined {
	if (bridge.pairs.length === 0) return undefined;
	if (!exists("/bin/bash")) return undefined;

	const runtime = bridgeRuntime(exists).map(quote);
	const pairs = bridge.pairs.flatMap((pair) => [quote(pair.socket), String(pair.port)]);
	// The probe opens both ports in a subshell per try, so a failed connect
	// leaves no descriptor behind in the shell that later `exec`s the command.
	const probes = bridge.pairs
		.map((pair, index) => `(exec ${index + 7}<>/dev/tcp/127.0.0.1/${pair.port}) 2>/dev/null`)
		.join(" && ");
	const closes = bridge.pairs.map((_, index) => `exec ${index + 7}>&-`).join(" ");

	const script = [
		"if command -v ip >/dev/null 2>&1; then ip link set lo up 2>/dev/null; ip addr add 127.0.0.1/8 dev lo 2>/dev/null; fi",
		// The bridge's stderr is *not* discarded: a bridge that cannot start
		// reports why on its own stderr, and the first version of this line
		// sent it to /dev/null — the one failure mode nobody could read.
		`${runtime.join(" ")} ${pairs.join(" ")} </dev/null >/dev/null &`,
		"_lbb_bridge=$!",
		"_lbb_ok=0",
		"_lbb_tries=0",
		`while [ "$_lbb_tries" -lt 100 ]; do if ${probes}; then ${closes}; _lbb_ok=1; break; fi; kill -0 "$_lbb_bridge" 2>/dev/null || break; _lbb_tries=$((_lbb_tries + 1)); sleep 0.05; done`,
		`if [ "$_lbb_ok" -ne 1 ]; then printf '%s\\n' 'labunbun: the network bridge did not start; the command runs with no network reachable' >&2; kill -0 "$_lbb_bridge" 2>/dev/null && printf '%s\\n' 'labunbun: the bridge process is still running' >&2 || printf '%s\\n' 'labunbun: the bridge process has exited' >&2; fi`,
		'exec "$@"',
	].join("\n");

	// The trailing argv is the command itself, reached by `"$@"`: the shell's
	// `$0` is the placeholder, so nothing in the command's own argv can be read
	// as an option to bash.
	return ["/bin/bash", "-c", script, "lbb-bridge", ...command];
}

/** One argument, quoted for `bash -c`: single quotes, with the standard `'\''` escape inside. */
function quote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
}

// Long-form design notes: docs/dev/sandbox.md
/** Parse the bridge argv: `socket port` pairs, in the order `runBridge` was handed them. */
export function parseBridgeArgs(args: readonly string[]): BridgePair[] {
	if (args.length === 0 || args.length % 2 !== 0) {
		throw new Error(`the network bridge takes socket/port pairs and got ${args.length} argument(s)`);
	}
	const pairs: BridgePair[] = [];
	for (let i = 0; i < args.length; i += 2) {
		const socket = args[i] ?? "";
		const port = Number(args[i + 1]);
		if (socket === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
			throw new Error(`the network bridge cannot parse ${JSON.stringify(args.slice(i, i + 2))}`);
		}
		pairs.push({ socket, port });
	}
	return pairs;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * The bridge process: listen on each pair's loopback port inside this network
 * namespace and forward every connection to the paired socket. Reached two
 * ways — `packages/tools/src/sandbox/bridge-main.ts` in a checkout and the
 * `__bridge` branch of the CLI's main in a compiled build — and it serves
 * until the namespace it lives in is torn down, which is what a never-settling
 * await expresses: there is nothing to do after this and no exit path to run.
 */
export async function runBridge(args: readonly string[]): Promise<void> {
	for (const pair of parseBridgeArgs(args)) await bridgePort(pair);
	await new Promise<void>(() => {});
}

/** One listener: accepts on `port` and pipes the connection to `socket`. */
function bridgePort(pair: BridgePair): Promise<Server> {
	const server = createServer((client) => {
		const upstream = netConnect(pair.socket);
		const teardown = () => {
			client.destroy();
			upstream.destroy();
		};
		client.on("error", teardown);
		upstream.on("error", teardown);
		client.pipe(upstream);
		upstream.pipe(client);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(pair.port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}
