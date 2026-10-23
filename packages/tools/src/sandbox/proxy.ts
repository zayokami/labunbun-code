// A local HTTP and SOCKS5 proxy that refuses what the domain policy refuses.
// The decision it enforces is a pure function in `@labunbun/agent`.
// Long-form design notes: docs/dev/sandbox.md

import { lookup as dnsLookup } from "node:dns/promises";
import type { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, isIP, connect as netConnect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
	decideNetworkRequest,
	isBlockedNetworkHost,
	type NetworkDecision,
	type NetworkDomainRule,
	needsNetworkProxy,
	normalizeHost,
} from "@labunbun/agent";
import type { BridgePair, UnixBridge } from "./bridge.ts";

/** SOCKS5 reply codes. RFC 1928 §6. */
const SOCKS_SUCCESS = 0x00;
/** "Connection not allowed by ruleset" — the code for a policy refusal. */
const SOCKS_REFUSED = 0x02;
/** "Command not supported" — this proxy is CONNECT only. */
const SOCKS_COMMAND_UNSUPPORTED = 0x07;

// Long-form design notes: docs/dev/sandbox.md
/** A complete SOCKS5 reply: VER, REP, RSV, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0. */
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
	// Long-form design notes: docs/dev/sandbox.md
	/** The address blocklist. Defaults to {@link isBlockedNetworkHost}. Injectable so a test can watch a permitted connection. */
	isBlockedHost?: (host: string) => boolean;
	// Long-form design notes: docs/dev/sandbox.md
	/**
	 * Resolves a hostname to every address it currently names. Injectable so a
	 * test can model a name that answers a blocked address without owning DNS;
	 * defaults to the system resolver.
	 */
	resolveHost?: (host: string) => Promise<readonly string[]>;
	/**
	 * Also serve this proxy over Unix sockets, one per loopback port, in a
	 * fresh directory under the system temp. The Linux loopback bridge is the
	 * only consumer: a confined command's traffic reaches those sockets over
	 * the shared filesystem, the one route a network namespace leaves
	 * standing. Off by default, so every existing caller keeps the two
	 * listeners it had.
	 */
	unixBridge?: boolean;
}

// Long-form design notes: docs/dev/sandbox.md
/** The one gate. The address blocklist runs before the domain rules. */
function decideUpstream(options: NetworkProxyOptions, host: string): NetworkDecision {
	const blocked = (options.isBlockedHost ?? isBlockedNetworkHost)(host);
	if (blocked) return { allowed: false, reason: "blocked_address" };
	return decideNetworkRequest(options.rules, host, options.network);
}

/** A policy answer with the addresses a permitted request may dial, every one already checked. */
type VettedUpstream = { allowed: false; reason: string } | { allowed: true; addresses: readonly [string, ...string[]] };

/**
 * The system resolver, returning every address rather than the one the
 * platform would dial first.
 *
 * `verbatim: false` puts IPv4 ahead of IPv6. The order is an availability
 * choice and nothing else — every address is vetted before it is tried — but
 * it is the honest one for a proxy whose CONNECT path can try the next entry
 * while the HTTP path dials the first: a broken IPv6 route is the older
 * dual-stack failure, and it should not decide which origin answers.
 */
async function resolveAllAddresses(host: string): Promise<readonly string[]> {
	const answers = await dnsLookup(host, { all: true, verbatim: false });
	return answers.map((answer) => answer.address);
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * The address this proxy may connect to for `host`, after asking both layers
 * and, for a name, the resolver.
 *
 * The string blocklist and the domain table decide what they always decided.
 * A name carries one more question they cannot answer: the addresses it
 * resolves to *now* are not necessarily the ones a later lookup will see, and
 * `localhost` was only the spelling this build could recognise as itself. All
 * answers are checked and any blocked one refuses the name — a host that
 * answers both a public and a private address is the DNS-rebinding shape, and
 * picking the clean answer would be guessing which half the next lookup gets.
 * The chosen address is then handed to the connect call as a literal, so the
 * socket's own resolver never runs and the address checked is the address
 * dialled.
 */
async function vettedUpstream(options: NetworkProxyOptions, host: string): Promise<VettedUpstream> {
	const decision = decideUpstream(options, host);
	if (!decision.allowed) return { allowed: false, reason: decision.reason ?? "denied" };
	// A literal resolves to itself, and the blocklist above already judged it.
	if (isIP(host) !== 0) return { allowed: true, addresses: [host] };
	const blocked = options.isBlockedHost ?? isBlockedNetworkHost;
	let addresses: readonly string[];
	try {
		addresses = await (options.resolveHost ?? resolveAllAddresses)(host);
	} catch {
		return { allowed: false, reason: "unresolvable_host" };
	}
	if (addresses.length === 0) return { allowed: false, reason: "unresolvable_host" };
	for (const address of addresses) {
		if (blocked(address)) return { allowed: false, reason: "blocked_address" };
	}
	// A resolver is an external boundary like any other: an answer that is not
	// an address cannot be pinned, so it is refused rather than handed on.
	if (addresses.some((address) => isIP(address) === 0)) return { allowed: false, reason: "unresolvable_host" };
	const [first, ...rest] = addresses;
	// Unreachable after the length check above; the guard is what makes the
	// non-empty tuple this function promises a fact the compiler can see.
	if (first === undefined) return { allowed: false, reason: "unresolvable_host" };
	return { allowed: true, addresses: [first, ...rest] };
}

export interface NetworkProxy {
	/** `http://127.0.0.1:PORT` — the endpoint `HTTP_PROXY` and `HTTPS_PROXY` name. */
	httpUrl: string;
	/** `socks5://127.0.0.1:PORT` — the endpoint `ALL_PROXY` names. */
	socksUrl: string;
	/** The environment a child process needs for its traffic to arrive here. */
	env: Record<string, string>;
	/**
	 * The Unix-socket side of this proxy, when `unixBridge` asked for one: the
	 * pairs the Linux loopback bridge forwards to. Absent means no bridge
	 * process can reach this proxy, which on a namespace backend is the dead
	 * network this build had before the bridge existed.
	 */
	bridge?: UnixBridge;
	/** Stop listening and drop every connection this proxy opened. */
	close(): Promise<void>;
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * The loopback ports this proxy is listening on, read from the two URLs it
 * already publishes rather than a third field that could disagree with them.
 * A caller that has to name the proxy by port — the macOS profile this build
 * generates — reads these. Deduplicated because both listeners are separate
 * today but a profile must not carry the same rule twice if that changes.
 */
export function portsOf(proxy: NetworkProxy): number[] {
	const ports = [proxy.httpUrl, proxy.socksUrl].map((url) => Number(new URL(url).port));
	return [...new Set(ports)];
}

// Long-form design notes: docs/dev/sandbox.md
/** Environment variables that carry a proxy URL, in both cases. */
const HTTP_PROXY_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;
const SOCKS_PROXY_KEYS = ["ALL_PROXY", "all_proxy"] as const;
// Long-form design notes: docs/dev/sandbox.md
/** WebSocket and FTP spellings, set alongside the standard ones. */
const EXTRA_HTTP_PROXY_KEYS = ["WS_PROXY", "ws_proxy", "WSS_PROXY", "wss_proxy", "FTP_PROXY", "ftp_proxy"] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

// Long-form design notes: docs/dev/sandbox.md
/** Per-tool proxy overrides, pinned to this policy's destination. */
const TOOL_PROXY_KEYS = [
	"npm_config_proxy",
	"NPM_CONFIG_PROXY",
	"npm_config_https_proxy",
	"NPM_CONFIG_HTTPS_PROXY",
	"PIP_PROXY",
] as const;
/** The no-proxy half of the same override, pinned to the same empty value. */
const TOOL_NO_PROXY_KEYS = ["npm_config_noproxy", "NPM_CONFIG_NOPROXY"] as const;

// Long-form design notes: docs/dev/sandbox.md
/** `NO_PROXY` is set to the empty string, deliberately: the conventional `localhost` entry is a documented bypass. */
function proxyEnv(httpUrl: string, socksUrl: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of HTTP_PROXY_KEYS) env[key] = httpUrl;
	for (const key of SOCKS_PROXY_KEYS) env[key] = socksUrl;
	for (const key of EXTRA_HTTP_PROXY_KEYS) env[key] = httpUrl;
	for (const key of NO_PROXY_KEYS) env[key] = "";
	// After the standard keys, and only ever to the same values, so the merge
	// order in `operations.ts` cannot put the caller's spelling back on top.
	for (const key of TOOL_PROXY_KEYS) env[key] = httpUrl;
	for (const key of TOOL_NO_PROXY_KEYS) env[key] = "";
	return env;
}

// Long-form design notes: docs/dev/sandbox.md
/** Start both proxies. Returns `undefined` when the policy confines nothing. */
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
	// Deduplicated the way `portsOf` deduplicates the published pair: the two
	// listeners are separate today, and a bridge must not carry one port twice
	// if that ever changes.
	const started = options.unixBridge
		? await startUnixBridge(host, [...new Set([portOf(httpServer), portOf(socksServer)])], live)
		: undefined;

	return {
		httpUrl,
		socksUrl,
		env: proxyEnv(httpUrl, socksUrl),
		// Spread rather than assigned: with `exactOptionalPropertyTypes` an
		// explicit `undefined` here would not type-check against the optional
		// field, and the key's absence is the honest shape for "no bridge".
		...(started === undefined ? {} : { bridge: started.pair }),
		close: async () => {
			for (const socket of live) socket.destroy();
			const servers = [httpServer, socksServer, ...(started?.servers ?? [])];
			await Promise.all(servers.map((server) => closed(server)));
			if (started !== undefined) rmSync(started.dir, { recursive: true, force: true });
		},
	};
}

// Long-form design notes: docs/dev/sandbox.md
/**
 * The Unix-socket mirror of the TCP listeners, one socket per port in a fresh
 * directory under the system temp — the one directory every sandbox inherits
 * as writable, so the rendezvous file is reachable from inside the namespace
 * as well as outside it. Each socket speaks whatever its port speaks: a
 * connection accepted here is piped straight to the loopback port, where the
 * decisions were always made. The directory is removed on close; a crash that
 * skips that leaves a stale socket under temp, which is what temp is for.
 */
async function startUnixBridge(
	host: string,
	ports: readonly number[],
	live: Set<Duplex>,
): Promise<{ pair: UnixBridge; servers: Server[]; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "lbb-bridge-"));
	const pairs: BridgePair[] = [];
	const servers: Server[] = [];
	for (const port of ports) {
		const socket = join(dir, `port-${port}.sock`);
		const server = createTcpServer((client) => {
			const upstream = netConnect(port, host);
			// Both halves are tracked like every other socket here: `close()`
			// destroys them, and without that a bridge connection parked on an
			// idle client would hold `server.close()` open forever.
			live.add(upstream);
			upstream.once("close", () => live.delete(upstream));
			const teardown = () => {
				client.destroy();
				upstream.destroy();
			};
			client.on("error", teardown);
			upstream.on("error", teardown);
			client.pipe(upstream);
			upstream.pipe(client);
		});
		servers.push(server);
		// Tracked before listening, so no connection can arrive before its
		// socket is in the set.
		trackServer(server, live);
		await listenSocket(server, socket);
		pairs.push({ port, socket });
	}
	return { pair: { pairs }, servers, dir };
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
	const vetted = await vettedUpstream(options, host);
	if (!vetted.allowed) {
		// 403 rather than a reset, and the reason in a header. A client that
		// cannot read why it was refused says "connection failed", and the one
		// line here is the difference between a user who knows their allow list
		// is missing a domain and a user who thinks the network is down.
		clientSocket.end(
			`HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nX-LBB-Denial: ${vetted.reason}\r\nConnection: close\r\n\r\n`,
		);
		return;
	}

	const upstream = track(
		await openUpstream(
			host,
			vetted.addresses,
			Number(port ?? 443),
			connectTimeoutMs,
			options.isBlockedHost ?? isBlockedNetworkHost,
		),
	);
	clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
	if (head.length > 0) upstream.write(head);
	clientSocket.pipe(upstream);
	upstream.pipe(clientSocket);
}

// Long-form design notes: docs/dev/sandbox.md
/** Absolute-form `GET http://host/path` — the shape `HTTP_PROXY` clients use. Origin-form fails as a malformed host. */
async function handleHttp(options: NetworkProxyOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const target = new URL(req.url ?? "");
	// `URL.hostname` keeps the brackets around an IPv6 literal; every layer
	// below — the blocklist, the resolver's literal fast path, the connect —
	// speaks the unbracketed spelling.
	const host = normalizeHost(target.hostname);
	const vetted = await vettedUpstream(options, host);
	if (!vetted.allowed) {
		res.writeHead(403, { "content-type": "text/plain", "x-lbb-denial": vetted.reason });
		res.end(`refused by network policy: ${vetted.reason}\n`);
		return;
	}

	const upstream = httpRequest(
		{
			// The vetted literal, not `host`: `Host` below still names the
			// origin, so the request is addressed as before, while the socket
			// connects to the address this proxy checked. An IP literal leaves
			// no lookup for the HTTP client to run. The request path has no
			// address-list fallback; the HTTP client dials the first one.
			host: vetted.addresses[0],
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

// Long-form design notes: docs/dev/sandbox.md
/** Split `host:port`, keeping an unbracketed IPv6 literal intact. */
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

		const vetted = await vettedUpstream(options, host);
		if (!vetted.allowed) {
			// No reason reaches the client here, and that is the protocol rather
			// than an oversight: RFC 1928's reply carries a code and nothing else,
			// so a blocked address, a denied domain and an unmatched allow rule
			// are one byte apart to a SOCKS client. `handleConnect` above answers
			// in a header because HTTP has somewhere to put it.
			client.write(socksReply(SOCKS_REFUSED));
			client.end();
			return;
		}

		const upstream = track(
			await openUpstream(host, vetted.addresses, port, connectTimeoutMs, options.isBlockedHost ?? isBlockedNetworkHost),
		);
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

// Long-form design notes: docs/dev/sandbox.md
/** One byte of a wire buffer, or a throw. */
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

// Long-form design notes: docs/dev/sandbox.md
/** A byte reader that keeps **one** `data` listener for the whole handshake. */
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

/** The upstream socket for addresses already vetted for this request, with one connect deadline. */
function openUpstream(
	host: string,
	addresses: readonly string[],
	port: number,
	timeoutMs: number,
	blocked: (host: string) => boolean,
): Promise<Socket> {
	return new Promise((resolve, reject) => {
		let done = false;
		let pending: Socket | undefined;
		const fail = (error: Error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			pending?.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(new Error(`connecting to ${host}:${port} timed out`)), timeoutMs);
		const attempt = (index: number): void => {
			if (done) return;
			const address = addresses[index];
			if (address === undefined) {
				fail(new Error(`could not connect to ${host}:${port}`));
				return;
			}
			// `address`, never `host`: every entry is a literal, so the socket's
			// connect has nothing left to resolve and the address that was vetted
			// is the one dialled. Trying the next vetted address on a failed
			// attempt is what keeps a dual-stack answer usable when only one
			// family has a route — every address tried has been through the same
			// check.
			const socket = netConnect({ host: address, port });
			pending = socket;
			socket.once("error", () => {
				if (done) return;
				socket.destroy();
				attempt(index + 1);
			});
			socket.once("connect", () => {
				if (done) return;
				// Belt and braces after the pin: the peer TCP actually reached is
				// put through the same blocklist. The property then survives a
				// future caller that reaches this function with a name.
				const peer = socket.remoteAddress;
				if (peer !== undefined && blocked(peer)) {
					socket.destroy();
					fail(new Error(`the peer at ${peer} is a blocked address`));
					return;
				}
				done = true;
				clearTimeout(timer);
				resolve(socket);
			});
		};
		attempt(0);
	});
}

// Long-form design notes: docs/dev/sandbox.md
/** What `http.Server` and `net.Server` share, and all this file calls on either. */
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

/**
 * `listen` for a Unix socket. A helper of its own rather than an overload of
 * the port-shaped one, because the two disagree about their address types and
 * `portOf` refuses a string address — widening `listen` to take both would
 * move that refusal into a caller that cannot act on it.
 */
function listenSocket(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
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
