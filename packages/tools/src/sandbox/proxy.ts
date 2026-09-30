/**
 * A local HTTP and SOCKS5 proxy that refuses what the domain policy refuses.
 *
 * This is the part of the network axis that touches a socket; the decision it
 * enforces is a pure function in `@labunbun/agent` (`network-policy.ts`) so
 * that the rules can be asserted on any machine, including the Windows one this
 * was written on. Every connection here goes through `decideNetworkRequest`
 * **before** an upstream socket is opened, which is the property that makes
 * this a filter rather than a logger.
 *
 * ## No MITM, deliberately
 *
 * `https://` reaches this proxy as `CONNECT host:443` followed by a byte pipe.
 * The proxy sees the hostname and then stops being able to see anything, which
 * is exactly the trade this build makes: it can refuse a destination, and it
 * cannot read the traffic. The alternative — a locally generated CA, as Codex
 * does in `network-proxy/src/mitm.rs` — buys content inspection and costs the
 * user a certificate in their trust store that whoever gets one file write can
 * use. Not making that trade is in the plan's "not delivered" list and it is a
 * real limitation, not an oversight: a domain on the allow list can exfiltrate
 * through a request this proxy cannot read.
 *
 * ## What this does not stop
 *
 * Proxy environment variables are a convention. A program that calls `connect`
 * without consulting them is not routed here and is subject to no rule in this
 * file. On macOS and Linux the OS sandbox closes that gap; on Windows nothing
 * in this build does, and `describeNetworkPolicy` says so per platform rather
 * than in a footnote nobody reads.
 *
 * ## Two ports, because tooling differs
 *
 * `HTTP_PROXY`/`HTTPS_PROXY` speak the HTTP proxy protocol; `ALL_PROXY` speaks
 * SOCKS5. Both point at the same decision. A client handed only one of them is
 * a client this cannot filter, which is why both are started together rather
 * than one being offered as an option.
 */

import type { EventEmitter } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { decideNetworkRequest, type NetworkDomainRule, needsNetworkProxy } from "@labunbun/agent";

/** SOCKS5 reply codes. RFC 1928 §6. */
const SOCKS_SUCCESS = 0x00;
/** "Connection not allowed by ruleset" — the code for a policy refusal. */
const SOCKS_REFUSED = 0x02;
/** "Command not supported" — this proxy is CONNECT only. */
const SOCKS_COMMAND_UNSUPPORTED = 0x07;

/**
 * A complete SOCKS5 reply: VER, REP, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0.
 *
 * Ten bytes, written out whole rather than assembled from a placeholder and a
 * `subarray`. The assembled version shipped one byte too long — the placeholder's
 * own VER survived into the middle — and the extra byte sat in the client's
 * read buffer, shifting everything the tunnel then carried. It answered every
 * reply test correctly, because those tests read the first ten bytes.
 */
function socksReply(code: number): Buffer {
	return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

export interface NetworkProxyOptions {
	/** The mode the decision is made under. */
	network: "restricted" | "enabled";
	/** The domain table. Empty is meaningful under `restricted`: it reaches nothing. */
	rules: readonly NetworkDomainRule[];
	/** Loopback to bind on. Overridable so a test can pick a free port. */
	host?: string;
	/** Give up on an upstream that has not answered `connect` in this long. */
	connectTimeoutMs?: number;
}

export interface NetworkProxy {
	/** `http://127.0.0.1:PORT` — the endpoint `HTTP_PROXY` and `HTTPS_PROXY` name. */
	httpUrl: string;
	/** `socks5://127.0.0.1:PORT` — the endpoint `ALL_PROXY` names. */
	socksUrl: string;
	/** The environment a child process needs for its traffic to arrive here. */
	env: Record<string, string>;
	/** Stop listening and drop every connection this proxy opened. */
	close(): Promise<void>;
}

/**
 * Environment variables that carry a proxy URL, in both cases.
 *
 * Both spellings are set deliberately. A great deal of tooling reads only the
 * lowercase form (`curl`, `requests`, most JVM launchers) and a great deal
 * reads only the uppercase one; setting one and leaving the other is how a
 * policy ends up enforced for half the tools in a build, and it fails open for
 * the other half. Codex lists the same keys for the same reason
 * (`network-proxy/src/proxy.rs:599`).
 */
const HTTP_PROXY_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;
const SOCKS_PROXY_KEYS = ["ALL_PROXY", "all_proxy"] as const;
const EXTRA_HTTP_PROXY_KEYS = ["WS_PROXY", "ws_proxy", "WSS_PROXY", "wss_proxy", "FTP_PROXY", "ftp_proxy"] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

/**
 * `NO_PROXY` is set to the **empty string**, deliberately, and that is worth
 * reading twice.
 *
 * Putting `localhost` or `127.0.0.1` there is the conventional thing to do and
 * it is a documented bypass: a client honouring it connects straight to the
 * address instead of asking this proxy, so under `restricted` every host-local
 * service becomes reachable by adding one line to a config file. An empty value
 * routes even loopback through the decision, where it is judged like anything
 * else — and it is set in both spellings for the same reason the URLs are,
 * because a stale lowercase `no_proxy=localhost` inherited from the ambient
 * environment would otherwise win on half the tools.
 */
function proxyEnv(httpUrl: string, socksUrl: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of HTTP_PROXY_KEYS) env[key] = httpUrl;
	for (const key of SOCKS_PROXY_KEYS) env[key] = socksUrl;
	for (const key of EXTRA_HTTP_PROXY_KEYS) env[key] = httpUrl;
	for (const key of NO_PROXY_KEYS) env[key] = "";
	return env;
}

/**
 * Start both proxies.
 *
 * Returns `undefined` when the policy confines nothing, so a caller does not
 * pay for a listening socket and a poisoned environment in exchange for
 * enforcing nothing. That is also the only case where a child's ambient proxy
 * variables are left alone.
 */
export async function startNetworkProxy(options: NetworkProxyOptions): Promise<NetworkProxy | undefined> {
	if (!needsNetworkProxy(options.network, options.rules)) return undefined;

	const host = options.host ?? "127.0.0.1";
	const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;

	// Every socket either server accepts, plus every one they open upstream.
	// `server.close()` does not return until its connections end, so tearing
	// this proxy down without them would hang the first `await` after the last
	// command rather than shutting anything down.
	const live = new Set<Duplex>();
	const track = <T extends Duplex>(socket: T): T => {
		live.add(socket);
		socket.once("close", () => live.delete(socket));
		return socket;
	};

	const httpServer = createServer((req, res) => {
		void handleHttp(options, req, res).catch(() => {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
			res.end("proxy could not reach the origin\n");
		});
	});
	trackServer(httpServer, live);
	httpServer.on("connect", (req, clientSocket, head) => {
		void handleConnect(options, req, clientSocket, head, connectTimeoutMs, track).catch(() => {
			clientSocket.destroy();
		});
	});
	await listen(httpServer, host);

	// SOCKS5 is a byte exchange, not HTTP, so it gets a `net.Server`. The two
	// are interchangeable for `listen`/`address`/`close`, but only `net.Server`
	// is guaranteed to hand out its connections: an `http.Server` built with no
	// request listener never emits `connection`, and the symptom is a SOCKS5
	// client that connects and then waits forever for a greeting.
	const socksServer = createTcpServer();
	trackServer(socksServer, live);
	socksServer.on("connection", (clientSocket) => {
		void handleSocks(options, clientSocket, connectTimeoutMs, track).catch(() => clientSocket.destroy());
	});
	await listen(socksServer, host);

	const httpUrl = `http://${host}:${portOf(httpServer)}`;
	const socksUrl = `socks5://${host}:${portOf(socksServer)}`;

	return {
		httpUrl,
		socksUrl,
		env: proxyEnv(httpUrl, socksUrl),
		close: async () => {
			for (const socket of live) socket.destroy();
			await Promise.all([closed(httpServer), closed(socksServer)]);
		},
	};
}

/** `CONNECT host:port` — the shape every `HTTPS_PROXY` client uses. */
async function handleConnect(
	options: NetworkProxyOptions,
	req: IncomingMessage,
	clientSocket: Duplex,
	head: Buffer,
	connectTimeoutMs: number,
	track: <T extends Duplex>(socket: T) => T,
): Promise<void> {
	const [host, port] = splitHostPort(req.url ?? "");
	const decision = decideNetworkRequest(options.rules, host, options.network);
	if (!decision.allowed) {
		// 403 rather than a reset, and the reason in a header. A client that
		// cannot read why it was refused says "connection failed", and the one
		// line here is the difference between a user who knows their allow list
		// is missing a domain and a user who thinks the network is down.
		clientSocket.end(
			`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nX-LBB-Denial: ${decision.reason ?? "denied"}\r\nConnection: close\r\n\r\n`,
		);
		return;
	}

	const upstream = track(await openUpstream(host, Number(port ?? 443), connectTimeoutMs));
	clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
	if (head.length > 0) upstream.write(head);
	clientSocket.pipe(upstream);
	upstream.pipe(clientSocket);
}

/**
 * Absolute-form `GET http://host/path` — the shape `HTTP_PROXY` clients use.
 *
 * A client that ignores the proxy environment sends origin-form here instead
 * (`GET /path`), which is not a URL this can place and fails as a malformed
 * host. That is the right answer for it: it was never going through the proxy,
 * and the OS sandbox is what bounds it.
 */
async function handleHttp(options: NetworkProxyOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const target = new URL(req.url ?? "");
	const decision = decideNetworkRequest(options.rules, target.hostname, options.network);
	if (!decision.allowed) {
		res.writeHead(403, { "content-type": "text/plain", "x-lbb-denial": decision.reason ?? "denied" });
		res.end(`refused by network policy: ${decision.reason ?? "denied"}\n`);
		return;
	}

	const upstream = httpRequest(
		{
			host: target.hostname,
			port: target.port || 80,
			method: req.method,
			path: `${target.pathname}${target.search}`,
			// The client sent the proxy's own `Host`; the origin needs its own.
			headers: { ...req.headers, host: target.host },
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);
	upstream.on("error", () => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
		res.end("proxy could not reach the origin\n");
	});
	req.pipe(upstream);
}

/**
 * Split `host:port`, keeping an unbracketed IPv6 literal intact.
 *
 * Splitting at the first colon is the one line of code that turns `::1` into
 * an empty host, which then reads as malformed and is refused — a fail-closed
 * accident rather than a decision, which is the kind of accident that gets
 * "fixed" later by someone who reads the failure as the bug.
 */
export function splitHostPort(authority: string): [string, string | undefined] {
	const value = authority.trim();
	if (value.startsWith("[")) {
		const close = value.indexOf("]");
		if (close < 0) return [value, undefined];
		const rest = value.slice(close + 1);
		return [value.slice(1, close), rest.startsWith(":") ? rest.slice(1) : undefined];
	}
	const first = value.indexOf(":");
	if (first < 0 || value.indexOf(":", first + 1) >= 0) return [value, undefined];
	return [value.slice(0, first), value.slice(first + 1)];
}

/** The SOCKS5 greeting and request, in RFC 1928 order. */
async function handleSocks(
	options: NetworkProxyOptions,
	client: Duplex,
	connectTimeoutMs: number,
	track: <T extends Duplex>(socket: T) => T,
): Promise<void> {
	const reader = byteReader(client);
	try {
		// Greeting: VER NMETHODS METHODS. Only "no authentication" is offered,
		// because this proxy authenticates nothing and a client told to offer
		// more has nothing to offer.
		const greeting = await reader.read(2);
		if (byte(greeting, 0) !== 0x05) throw new Error("not a SOCKS5 greeting");
		const methods = await reader.read(byte(greeting, 1));
		if (!methods.includes(0x00)) throw new Error("no acceptable SOCKS5 authentication method");
		client.write(Buffer.from([0x05, 0x00]));

		// Request: VER CMD RSV ATYP ADDR PORT.
		const head = await reader.read(4);
		if (byte(head, 1) !== 0x01) {
			client.write(socksReply(SOCKS_COMMAND_UNSUPPORTED));
			client.end();
			return;
		}

		const host = await readAddress(reader.read, byte(head, 3));
		const port = uint16(await reader.read(2));

		const decision = decideNetworkRequest(options.rules, host, options.network);
		if (!decision.allowed) {
			client.write(socksReply(SOCKS_REFUSED));
			client.end();
			return;
		}

		const upstream = track(await openUpstream(host, port, connectTimeoutMs));
		// Hand the socket over: the reader's `data` listener has to go, or the
		// tunnel bytes get buffered by a handshake that has already finished
		// while `pipe` is trying to read the same bytes.
		reader.release();
		client.write(socksReply(SOCKS_SUCCESS));
		client.pipe(upstream);
		upstream.pipe(client);
	} catch (error) {
		reader.release();
		throw error;
	}
}

/**
 * One byte of a wire buffer, or a throw.
 *
 * `noUncheckedIndexedAccess` makes every index into a `Buffer` a `number |
 * undefined`, and this file reads a protocol whose whole job is to fail on a
 * malformed message. The three ways out of that are all worse than a throw: an
 * `!` the linter forbids, a `?? 0` that turns a truncated greeting into a
 * plausible one, and a comparison against `undefined` that quietly does the
 * right thing for every value except the one it was written for.
 */
function byte(buffer: Buffer, index: number): number {
	const value = buffer[index];
	if (value === undefined) throw new Error(`expected at least ${index + 1} bytes, got ${buffer.length}`);
	return value;
}

/** Two bytes, big-endian. Same reason as {@link byte}, and it is the only use. */
function uint16(buffer: Buffer): number {
	return (byte(buffer, 0) << 8) | byte(buffer, 1);
}

/** The destination, in whichever of the three address forms the client used. */
async function readAddress(read: (count: number) => Promise<Buffer>, kind: number): Promise<string> {
	if (kind === 0x01) return Array.from(await read(4)).join(".");
	if (kind === 0x03) return (await read(byte(await read(1), 0))).toString("latin1");
	if (kind === 0x04) return formatIpv6(await read(16));
	throw new Error(`unsupported SOCKS5 address type ${kind}`);
}

/**
 * Eight 16-bit groups as a hostname, with the longest run of zeros collapsed
 * to `::` per RFC 5952. A run has to be two or more to be written that way,
 * because `::` standing for one zero group is a different string.
 */
function formatIpv6(bytes: Buffer): string {
	const groups: number[] = [];
	for (let i = 0; i < 16; i += 2) groups.push(uint16(bytes.subarray(i, i + 2)));

	let bestStart = -1;
	let bestLength = 0;
	let runStart = -1;
	for (let i = 0; i <= groups.length; i++) {
		if (i < groups.length && groups[i] === 0) {
			if (runStart < 0) runStart = i;
			continue;
		}
		if (runStart >= 0 && i - runStart > bestLength) {
			bestStart = runStart;
			bestLength = i - runStart;
		}
		runStart = -1;
	}

	const hex = groups.map((group) => group.toString(16));
	if (bestLength < 2) return hex.join(":");
	return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/**
 * A byte reader that keeps **one** `data` listener for the whole handshake.
 *
 * Attaching and removing a listener per read looks equivalent and is not: with
 * no listener attached the socket keeps whatever was left in its buffer, and
 * bytes that arrive in the gap between two awaits are dropped. A SOCKS5
 * greeting is 2+N+method bytes sent in one write, so the gap is exactly where
 * the rest of the greeting is. `release()` removes the listener before the
 * socket is handed to `pipe`, which is the other half of the same hazard.
 */
function byteReader(socket: Duplex) {
	// Annotated rather than inferred: `Buffer.alloc` narrows to a buffer over
	// `ArrayBuffer`, and the `data` event hands over the wider `Buffer` type, so
	// the first concatenation would not type-check.
	let buffer: Buffer = Buffer.alloc(0);
	const waiters: Array<{
		count: number;
		resolve: (bytes: Buffer) => void;
		reject: (error: Error) => void;
	}> = [];

	const take = (count: number): Buffer => {
		const head = buffer.subarray(0, count);
		buffer = buffer.subarray(count);
		return Buffer.from(head);
	};
	const flush = () => {
		// The waiter has to be read off the queue *before* it is taken off it:
		// asking `waiters[0]` again after the shift answers for the next caller.
		// Written as a loop with a `break` rather than a condition on
		// `waiters[0].count`, because that index is optional under this repo's
		// `noUncheckedIndexedAccess` and the only ways to use it are an assertion
		// the linter forbids or a default that would answer 0 for an empty queue.
		for (;;) {
			const waiter = waiters[0];
			if (waiter === undefined || buffer.length < waiter.count) break;
			waiters.shift();
			waiter.resolve(take(waiter.count));
		}
	};
	const fail = (error: Error) => {
		// Drained with a splice rather than a shift loop so the loop variable is
		// the waiter itself, which is the value that needs rejecting.
		for (const waiter of waiters.splice(0)) waiter.reject(error);
	};

	const onData = (chunk: Buffer) => {
		buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
		flush();
	};
	const onError = (error: Error) => fail(error);
	const onEnd = () => fail(new Error("client closed during the SOCKS5 handshake"));

	socket.on("data", onData);
	socket.on("error", onError);
	socket.on("end", onEnd);

	const read = (count: number): Promise<Buffer> =>
		buffer.length >= count
			? Promise.resolve(take(count))
			: new Promise<Buffer>((resolve, reject) => waiters.push({ count, resolve, reject }));

	return {
		read,
		release: () => {
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("end", onEnd);
		},
	};
}

/** The upstream socket for an allowed destination, with a connect deadline. */
function openUpstream(host: string, port: number, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host, port });
		const giveUp = (error: Error) => {
			clearTimeout(timer);
			socket.destroy();
			reject(error);
		};
		const timer = setTimeout(() => giveUp(new Error(`connecting to ${host}:${port} timed out`)), timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", giveUp);
	});
}

/**
 * What `http.Server` and `net.Server` share, and all this file calls on either.
 *
 * Declaring it structurally is what lets the SOCKS5 listener be a `net.Server`
 * without every helper above growing a union or a cast. The event methods come
 * from `EventEmitter` rather than being spelled out, because a hand-written
 * `on(event: string, ...)` is not assignable from Node's typed overloads.
 */
interface ListeningServer extends EventEmitter {
	listen(port: number, host: string, callback: () => void): unknown;
	address(): { port: number } | string | null;
	close(callback?: () => void): unknown;
}

function listen(server: ListeningServer, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, host, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

function portOf(server: ListeningServer): number {
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the network proxy did not report a port");
	}
	return address.port;
}

/** Accept connections onto `live` so `close()` can drop them. */
function trackServer(server: ListeningServer, live: Set<Duplex>): void {
	server.on("connection", (socket: Duplex) => {
		live.add(socket);
		socket.once("close", () => live.delete(socket));
	});
}

function closed(server: ListeningServer): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}
