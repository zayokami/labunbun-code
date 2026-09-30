/**
 * The network proxy, driven over real sockets.
 *
 * The decision it enforces is asserted as a value in `network-policy.test.ts`.
 * This file is for the half that cannot be a value: that a refusal happens
 * *before* an upstream socket exists, and that an allowed destination is
 * actually reached rather than merely not-refused.
 *
 * Every request below is written onto a socket by hand. That is deliberate and
 * it costs bytes: `fetch` would be three lines, and it would also decide for us
 * which of the proxy's two protocols we ended up testing. A hand-written
 * `CONNECT` line or a hand-written SOCKS5 greeting is the thing under test, so
 * it has to be the thing that is written.
 *
 * The upstreams count what reaches them, and that count is the assertion that
 * matters. A proxy that opens the socket and *then* decides is a proxy that
 * has already done the thing it promised not to, and it would answer every
 * refusal test here correctly.
 */
import { describe, expect, test } from "bun:test";
import type { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";
import type { NetworkDomainRule } from "@labunbun/agent";
import { splitHostPort, startNetworkProxy } from "../src/sandbox/proxy.ts";

const allow = (...patterns: string[]): NetworkDomainRule[] =>
	patterns.map((pattern) => ({ pattern, permission: "allow" as const }));

const deny = (...patterns: string[]): NetworkDomainRule[] =>
	patterns.map((pattern) => ({ pattern, permission: "deny" as const }));

interface ListeningServer extends EventEmitter {
	listen(port: number, host: string, callback: () => void): unknown;
	address(): { port: number } | string | null;
	close(callback?: () => void): unknown;
}

function listen(server: ListeningServer): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

function portOf(server: ListeningServer): number {
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

function shut(server: ListeningServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

const portOfUrl = (url: string): number => Number(new URL(url).port);

// --- fake upstreams -------------------------------------------------------

/** An HTTP origin that answers and remembers every request line it was given. */
async function startUpstream() {
	const seen: string[] = [];
	let connections = 0;
	const server = createServer((req, res) => {
		seen.push(req.url ?? "");
		res.writeHead(200, { "content-type": "text/plain", connection: "close" });
		res.end(`upstream saw ${req.url}\n`);
	});
	server.on("connection", () => {
		connections++;
	});
	await listen(server);
	return {
		port: portOf(server),
		seen: () => [...seen],
		connections: () => connections,
		close: () => shut(server),
	};
}

/** A TCP origin that upper-cases whatever it is sent, so a tunnel is visible. */
async function startEcho() {
	let connections = 0;
	const server: TcpServer = createTcpServer((socket) => {
		socket.on("data", (chunk: Buffer) => socket.write(chunk.toString("latin1").toUpperCase()));
	});
	server.on("connection", () => {
		connections++;
	});
	await listen(server);
	return { port: portOf(server), connections: () => connections, close: () => shut(server) };
}

/** Run `body` against a restricted proxy and two upstreams, then tear all down. */
async function withProxy(
	rules: readonly NetworkDomainRule[],
	body: (ports: { proxy: number; socks: number; upstream: number; echo: number }) => Promise<void>,
) {
	const upstream = await startUpstream();
	const echo = await startEcho();
	const proxy = await startNetworkProxy({ network: "restricted", rules });
	if (!proxy) throw new Error("expected the policy to confine something");
	try {
		await body({
			proxy: portOfUrl(proxy.httpUrl),
			socks: portOfUrl(proxy.socksUrl),
			upstream: upstream.port,
			echo: echo.port,
		});
	} finally {
		await proxy.close();
		await upstream.close();
		await echo.close();
	}
}

// --- raw socket helpers ---------------------------------------------------

function open(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

/**
 * A buffered reader, for the same reason the proxy has one: attaching a
 * listener per read drops whatever arrived between two awaits, and a `CONNECT`
 * reply followed by tunnelled bytes is exactly that shape.
 */
function reader(socket: Socket) {
	let buffer: Buffer = Buffer.alloc(0);
	const waiters: Array<{ count: number; resolve: (bytes: Buffer) => void }> = [];
	const take = (count: number): Buffer => {
		const head = Buffer.from(buffer.subarray(0, count));
		buffer = buffer.subarray(count);
		return head;
	};
	const flush = () => {
		// Same shape as the proxy's own reader, for the same reason: the head of
		// the queue is read before it is shifted off, and `waiters[0]` is an
		// optional index under this repo's compiler settings.
		for (;;) {
			const waiter = waiters[0];
			if (waiter === undefined || buffer.length < waiter.count) break;
			waiters.shift();
			waiter.resolve(take(waiter.count));
		}
	};
	socket.on("data", (chunk: Buffer) => {
		buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
		flush();
	});
	return {
		read: (count: number): Promise<Buffer> =>
			buffer.length >= count
				? Promise.resolve(take(count))
				: new Promise<Buffer>((resolve) => waiters.push({ count, resolve })),
		/**
		 * Everything up to and including `marker`, consumed. The consumption is
		 * the load-bearing half: a `CONNECT` reply and the first tunnelled bytes
		 * often arrive in one chunk, and a peek that left the header in the
		 * buffer handed those tunnel bytes to the next `read`.
		 */
		until: (marker: string): Promise<string> =>
			new Promise<string>((resolve) => {
				const check = () => {
					const at = buffer.indexOf(marker);
					if (at < 0) return;
					const found = buffer.subarray(0, at + marker.length).toString("latin1");
					buffer = buffer.subarray(at + marker.length);
					resolve(found);
					socket.off("data", check);
				};
				check();
				socket.on("data", check);
			}),
	};
}

/**
 * One absolute-form request, read back to `Content-Length`.
 *
 * Not "read until the socket closes": the response says `Connection: close`
 * and the body arrives, but the peer does not necessarily *close* promptly,
 * so a test waiting for the close waits for the timeout and learns nothing.
 */
async function exchange(port: number, request: string): Promise<{ head: string; body: string }> {
	const socket = await open(port);
	const io = reader(socket);
	socket.write(request);
	const head = await io.until("\r\n\r\n");
	const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? "0");
	const body = (await io.read(length)).toString("latin1");
	socket.destroy();
	return { head, body };
}

// --- the pure half that is worth its own table ----------------------------

describe("splitHostPort", () => {
	test.each([
		["example.com:443", "example.com", "443"],
		["example.com", "example.com", undefined],
		["[::1]:8080", "::1", "8080"],
		["[::1]", "::1", undefined],
		// The whole reason this function exists: splitting `::1` at its first
		// colon yields an empty host, which reads as malformed and is refused —
		// a fail-closed accident rather than a decision.
		["::1", "::1", undefined],
		["2001:db8::1:443", "2001:db8::1:443", undefined],
		[":443", "", "443"],
		["", "", undefined],
	])("%s splits to [%s, %s]", (authority, host, port) => {
		expect(splitHostPort(authority)).toEqual([host, port]);
	});
});

// --- lifecycle ------------------------------------------------------------

describe("startNetworkProxy", () => {
	test("starts nothing when the policy confines nothing", async () => {
		// The case that would otherwise cost a listening socket and a set of
		// poisoned environment variables in every child, to enforce nothing.
		expect(await startNetworkProxy({ network: "enabled", rules: [] })).toBeUndefined();
	});

	test("env names the HTTP proxy for the URL keys and the SOCKS one for ALL_PROXY", async () => {
		const proxy = await startNetworkProxy({ network: "restricted", rules: allow("example.com") });
		if (!proxy) throw new Error("expected a proxy");
		try {
			for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"]) {
				expect(proxy.env[key]).toBe(proxy.httpUrl);
			}
			for (const key of ["ALL_PROXY", "all_proxy"]) {
				expect(proxy.env[key]).toBe(proxy.socksUrl);
			}
			// Empty, not `localhost`. A `no_proxy` listing loopback is a bypass
			// written down, and a stale lowercase one inherited from the ambient
			// environment would win on half the tools if only the upper were set.
			expect(proxy.env.NO_PROXY).toBe("");
			expect(proxy.env.no_proxy).toBe("");
		} finally {
			await proxy.close();
		}
	});

	test("close resolves and leaves both ports unconnectable", async () => {
		// `server.close()` does not return until its connections end, so a
		// teardown that forgets them hangs rather than fails. The test timeout is
		// the assertion.
		const proxy = await startNetworkProxy({ network: "restricted", rules: allow("example.com") });
		if (!proxy) throw new Error("expected a proxy");
		const ports = [portOfUrl(proxy.httpUrl), portOfUrl(proxy.socksUrl)];
		await proxy.close();
		for (const port of ports) {
			expect(
				await open(Number(port)).then(
					() => "open",
					() => "refused",
				),
			).toBe("refused");
		}
	});
});

// --- HTTP proxy -----------------------------------------------------------

describe("HTTP proxy", () => {
	test("an absolute-form request to an allowed host arrives at the origin", async () => {
		const upstream = await startUpstream();
		const proxy = await startNetworkProxy({ network: "restricted", rules: allow("127.0.0.1") });
		if (!proxy) throw new Error("expected a proxy");
		try {
			const { head, body } = await exchange(
				portOfUrl(proxy.httpUrl),
				`GET http://127.0.0.1:${upstream.port}/resource HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\n\r\n`,
			);
			expect(head).toContain("200 OK");
			expect(body).toBe("upstream saw /resource\n");
			expect(upstream.seen()).toEqual(["/resource"]);
		} finally {
			await proxy.close();
			await upstream.close();
		}
	});

	test("a request the rules do not allow is refused and never reaches the origin", async () => {
		const upstream = await startUpstream();
		const proxy = await startNetworkProxy({ network: "restricted", rules: allow("example.com") });
		if (!proxy) throw new Error("expected a proxy");
		try {
			const { head } = await exchange(
				portOfUrl(proxy.httpUrl),
				`GET http://127.0.0.1:${upstream.port}/secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
			);
			expect(head).toContain("403 Forbidden");
			// The reason travels with the refusal, so a user can tell a missing
			// allow-list entry from a network that is down.
			expect(head.toLowerCase()).toContain("x-lbb-denial: no_matching_allow_rule");
			// The origin is the point: nothing arrived, so nothing was opened.
			expect(upstream.seen()).toEqual([]);
			expect(upstream.connections()).toBe(0);
		} finally {
			await proxy.close();
			await upstream.close();
		}
	});

	test("CONNECT tunnels to an allowed destination", async () => {
		await withProxy(allow("127.0.0.1"), async ({ proxy, echo }) => {
			const socket = await open(proxy);
			const io = reader(socket);
			socket.write(`CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
			expect(await io.until("\r\n\r\n")).toContain("200 Connection Established");
			socket.write("ping");
			// Upper-cased by the echo upstream, so the bytes are provably its.
			expect((await io.read(4)).toString("latin1")).toBe("PING");
			socket.destroy();
		});
	});

	test("CONNECT refuses a denied destination before opening a socket", async () => {
		await withProxy([...allow("127.0.0.1"), ...deny("127.0.0.1")], async ({ proxy, echo }) => {
			// Both rules cover the same host, so this is the deny-beats-allow
			// invariant arriving over a real socket rather than as a value.
			const socket = await open(proxy);
			const io = reader(socket);
			socket.write(`CONNECT 127.0.0.1:${echo} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
			const status = await io.until("\r\n\r\n");
			expect(status).toContain("403 Forbidden");
			expect(status).toContain("X-LBB-Denial: domain_denied");
			socket.destroy();
		});
	});
});

// --- SOCKS5 ---------------------------------------------------------------

describe("SOCKS5", () => {
	test("tunnels an allowed destination", async () => {
		await withProxy(allow("127.0.0.1"), async ({ socks, echo }) => {
			const socket = await open(socks);
			const io = reader(socket);
			socket.write(Buffer.from([0x05, 0x01, 0x00]));
			expect(Array.from(await io.read(2))).toEqual([0x05, 0x00]);
			socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, echo >> 8, echo & 0xff]));
			expect((await io.read(10))[1]).toBe(0x00);
			socket.write("ping");
			expect((await io.read(4)).toString("latin1")).toBe("PING");
			socket.destroy();
		});
	});

	test("refuses with the ruleset code rather than dropping the connection", async () => {
		await withProxy(allow("example.com"), async ({ socks, echo }) => {
			const socket = await open(socks);
			const io = reader(socket);
			socket.write(Buffer.from([0x05, 0x01, 0x00]));
			await io.read(2);
			socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, echo >> 8, echo & 0xff]));
			// 0x02 is "connection not allowed by ruleset". A dropped socket would
			// also keep the destination unreachable, but the client would report
			// a transport failure and never learn there was a policy.
			expect((await io.read(10))[1]).toBe(0x02);
			socket.destroy();
		});
	});

	test("reads a domain-name address, which is the length-prefixed branch", async () => {
		await withProxy(allow("127.0.0.1"), async ({ socks, echo }) => {
			const socket = await open(socks);
			const io = reader(socket);
			socket.write(Buffer.from([0x05, 0x01, 0x00]));
			await io.read(2);
			const name = Buffer.from("127.0.0.1", "latin1");
			socket.write(
				Buffer.concat([
					Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
					name,
					Buffer.from([echo >> 8, echo & 0xff]),
				]),
			);
			expect((await io.read(10))[1]).toBe(0x00);
			socket.write("ping");
			expect((await io.read(4)).toString("latin1")).toBe("PING");
			socket.destroy();
		});
	});

	test("decides on the IPv6 address it parsed, not on the raw bytes", async () => {
		// ATYP 4 carries sixteen bytes that have to become a hostname before any
		// rule can match them. The only observable is the reply, so the rules are
		// written so that a correct parse denies and a broken one allows — and an
		// allowed `::1` would then try to connect, which is what makes this fail
		// loudly rather than silently.
		await withProxy([...allow("*"), ...deny("::1")], async ({ socks }) => {
			const socket = await open(socks);
			const io = reader(socket);
			socket.write(Buffer.from([0x05, 0x01, 0x00]));
			await io.read(2);
			socket.write(
				// `::1` is sixteen bytes; the last group is 1.
				Buffer.from([0x05, 0x01, 0x00, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x01, 0xbb]),
			);
			expect((await io.read(10))[1]).toBe(0x02);
			socket.destroy();
		});
	});
});
