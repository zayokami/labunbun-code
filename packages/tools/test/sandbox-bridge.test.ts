/**
 * The loopback bridge: the one route back into a `bwrap` network namespace.
 *
 * Two halves, each with its own kind of proof. The argv half is a pure value —
 * the wrapper script, its quoting, the runtime shape — so it is asserted piece
 * by piece. The serving half is real sockets: a bridge started through
 * `runBridge` is dialed exactly the way a confined command would dial it, and
 * the bytes that come back are the ones the socket on the other side answered.
 * Nothing here touches bwrap; whether the namespace carries this route is
 * `sandbox-bwrap-smoke.test.ts`'s question.
 */
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeRuntime, parseBridgeArgs, runBridge, wrapWithBridge } from "../src/sandbox/bridge.ts";

const pair = (socket: string, port: number) => ({ socket, port });

describe("parseBridgeArgs", () => {
	test("reads socket/port pairs in the order the wrapper writes them", () => {
		expect(parseBridgeArgs(["/tmp/a.sock", "4001", "/tmp/b.sock", "4002"])).toEqual([
			{ socket: "/tmp/a.sock", port: 4001 },
			{ socket: "/tmp/b.sock", port: 4002 },
		]);
	});

	test.each([
		[[]],
		[["/tmp/a.sock"]],
		[["/tmp/a.sock", "4001", "/tmp/b.sock"]],
		[["", "4001"]],
		[["/tmp/a.sock", "0"]],
		[["/tmp/a.sock", "65536"]],
		[["/tmp/a.sock", "abc"]],
		[["/tmp/a.sock", "4001.5"]],
	])("refuses %p", (args) => {
		expect(() => parseBridgeArgs(args as string[])).toThrow();
	});
});

describe("bridgeRuntime", () => {
	test("a source checkout runs the script beside the module", () => {
		const runtime = bridgeRuntime(() => true);
		expect(runtime).toHaveLength(2);
		expect(runtime[0]).toBe(process.execPath);
		expect(runtime[1]?.endsWith("bridge-main.ts")).toBe(true);
	});

	test("a compiled build re-enters its own entry point with __bridge", () => {
		// The measured shape: a compiled binary reports a virtual
		// `import.meta.dir` and there is no script under it, so the only script
		// that exists is the binary itself.
		expect(bridgeRuntime(() => false)).toEqual([process.execPath, "__bridge"]);
	});
});

describe("wrapWithBridge", () => {
	const bridge = { pairs: [pair("/tmp/lbb/port-4001.sock", 4001)] };
	const command = ["/bin/sh", "-lc", "echo hi"];

	test("declines with no pairs, and the caller keeps the dead network", () => {
		expect(wrapWithBridge(command, { pairs: [] }, () => true)).toBeUndefined();
	});

	test("declines with no /bin/bash to run the wrapper", () => {
		expect(wrapWithBridge(command, bridge, (path) => path !== "/bin/bash")).toBeUndefined();
	});

	test("carries the command verbatim after a placeholder $0", () => {
		const argv = wrapWithBridge(command, bridge, () => true);
		expect(argv).toBeDefined();
		const [program, flag, , placeholder, ...tail] = argv ?? [];
		expect(program).toBe("/bin/bash");
		expect(flag).toBe("-c");
		// The placeholder is what `$@` starts after: nothing in the command's
		// own argv can be read as an option to bash.
		expect(placeholder).toBe("lbb-bridge");
		expect(tail).toEqual(command);
	});

	test("the script brings loopback up, starts the bridge, and probes the port it will use", () => {
		const argv = wrapWithBridge(command, bridge, () => true);
		const script = argv?.[2] ?? "";
		expect(script).toContain("ip link set lo up");
		expect(script).toContain("ip addr add 127.0.0.1/8 dev lo");
		// The runtime is this process: `bridgeRuntime` with the injected `exists`
		// resolves to the script shape, and both words are quoted.
		expect(script).toContain(`'${process.execPath}'`);
		expect(script).toContain("'/tmp/lbb/port-4001.sock' 4001");
		// The probe is the exact connect the confined command will make, on a
		// descriptor that is closed again whether or not other probes follow.
		expect(script).toContain("(exec 7<>/dev/tcp/127.0.0.1/4001) 2>/dev/null");
		expect(script).toContain("exec 7>&-");
		// Fail closed and out loud: the command still runs, and the reason the
		// network is dead went to stderr.
		expect(script).toContain("labunbun: the network bridge did not start; the command runs with no network reachable");
		expect(script).toContain('exec "$@"');
	});

	test("two pairs get two probes and two closes", () => {
		const argv = wrapWithBridge(
			command,
			{ pairs: [pair("/tmp/lbb/a.sock", 4001), pair("/tmp/lbb/b.sock", 4002)] },
			() => true,
		);
		const script = argv?.[2] ?? "";
		expect(script).toContain(
			"(exec 7<>/dev/tcp/127.0.0.1/4001) 2>/dev/null && (exec 8<>/dev/tcp/127.0.0.1/4002) 2>/dev/null",
		);
		expect(script).toContain("exec 7>&- exec 8>&-");
	});

	test("a socket path with a quote in it cannot break out of its word", () => {
		const argv = wrapWithBridge(command, { pairs: [pair("/tmp/a'b.sock", 4001)] }, () => true);
		const script = argv?.[2] ?? "";
		expect(script).toContain(`'/tmp/a'\\''b.sock' 4001`);
	});
});

describe("runBridge", () => {
	test("serves every pair: TCP in, the socket's bytes back", async () => {
		// The socket side first — the stand-in for the host proxy: it answers
		// with the same bytes upper-cased, so both directions of the relay are
		// visible in one exchange.
		const socketPath = join(tmpdir(), `lbb-bridge-test-${process.pid}-${Date.now()}.sock`);
		const upstream: Server = createServer((socket: Socket) => {
			socket.on("data", (chunk: Buffer) => socket.write(chunk.toString("latin1").toUpperCase()));
		});
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(socketPath, () => {
				upstream.removeListener("error", reject);
				resolve();
			});
		});

		// A free port, taken the only portable way: ask the kernel, give it
		// back, dial it — the bridge rebinds it a moment later.
		const port = await new Promise<number>((resolve, reject) => {
			const scout = createServer();
			scout.once("error", reject);
			scout.listen(0, "127.0.0.1", () => {
				const address = scout.address();
				if (address === null || typeof address === "string") {
					reject(new Error("no port"));
					return;
				}
				const chosen = address.port;
				scout.close(() => resolve(chosen));
			});
		});

		// Started, not awaited: `runBridge` never settles — it serves until the
		// namespace around it is torn down, and this process's end stands in
		// for that teardown.
		void runBridge([socketPath, String(port)]);
		try {
			const client = await dialUntilUp(port);
			client.write("ping");
			const echoed = await new Promise<string>((resolve) => {
				client.once("data", (chunk: Buffer) => resolve(chunk.toString("latin1")));
			});
			expect(echoed).toBe("PING");
			client.destroy();
		} finally {
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
			rmSync(socketPath, { force: true });
		}
	});
});

/** Connect to `port`, retrying until the bridge's listener is up. */
async function dialUntilUp(port: number): Promise<Socket> {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			return await new Promise<Socket>((resolve, reject) => {
				const socket = connect({ host: "127.0.0.1", port });
				socket.once("connect", () => resolve(socket));
				socket.once("error", reject);
			});
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error("the bridge never accepted a connection");
}
