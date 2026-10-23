/**
 * `web-capture.ts` — what a HAR or SAZ recorded, with the secrets left out.
 *
 * The fixtures are built from plain JSON and from the shared byte-level zip
 * builder, so every case states the exact member names and wire bytes it is
 * about. The assertions check two things at once: the metadata the report
 * promises (counts, ordinals, hashes, sizes) and the values it must never
 * print — authorization headers, cookies, query values, request and response
 * bodies, metadata, and websocket members all carry a sentinel that the
 * output has to be free of.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInspectWebCaptureTool } from "../src/web-capture.ts";
import { buildZip, encoder, writeFixture } from "./archive-fixtures.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lbb-web-capture-"));
	roots.push(dir);
	return dir;
}

const ctx = (cwd: string) => ({
	callId: "t1",
	signal: new AbortController().signal,
	cwd,
	sandbox: "workspace-write" as const,
	network: { access: "enabled" as const, domains: [] },
	onUpdate: () => {},
});

function textOf(result: { content: unknown[] }): string {
	return (result.content[0] as { text: string }).text;
}

async function inspect(cwd: string, input: { path: string; format?: "auto" | "har" | "saz"; records?: number[] }) {
	const result = await createInspectWebCaptureTool(cwd).call(input, ctx(cwd));
	return { result, text: textOf(result) };
}

function sha256(data: string | Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(data);
	return hasher.digest("hex");
}

interface HarEntryOptions {
	method?: string;
	url?: string;
	status?: number;
	mime?: string;
	requestHeaders?: { name: string; value: string }[];
	responseHeaders?: { name: string; value: string }[];
	content?: Record<string, unknown>;
	postData?: Record<string, unknown>;
	requestCookies?: unknown[];
	responseCookies?: unknown[];
	time?: number;
}

function harEntry(options: HarEntryOptions = {}): Record<string, unknown> {
	const mime = options.mime ?? "application/json";
	return {
		request: {
			method: options.method ?? "GET",
			url: options.url ?? "https://example.com/api/items?token=SECRET&x=1",
			headers: options.requestHeaders ?? [
				{ name: "Accept", value: "application/json" },
				{ name: "Authorization", value: "Bearer SECRET" },
			],
			...(options.postData === undefined ? {} : { postData: options.postData }),
			...(options.requestCookies === undefined ? {} : { cookies: options.requestCookies }),
		},
		response: {
			status: options.status ?? 200,
			headers: options.responseHeaders ?? [
				{ name: "Content-Type", value: `${mime}; charset=utf-8` },
				{ name: "Set-Cookie", value: "sid=SECRET" },
			],
			content: options.content ?? { mimeType: mime, size: 11, text: '{"ok":true}' },
			...(options.responseCookies === undefined ? {} : { cookies: options.responseCookies }),
		},
		time: options.time ?? 84,
	};
}

function writeHar(
	dir: string,
	name: string,
	entries: unknown[],
	logExtra: Record<string, unknown> = {},
	rootExtra: Record<string, unknown> = {},
): string {
	const document = {
		log: {
			version: "1.2",
			creator: { name: "Test", version: "1.0" },
			pages: [],
			entries,
			...logExtra,
		},
		...rootExtra,
	};
	writeFileSync(join(dir, name), JSON.stringify(document));
	return name;
}

function writeSaz(
	dir: string,
	name: string,
	entries: {
		name: string;
		data: string | Uint8Array;
		flags?: number;
		method?: number;
		declaredUncompressed?: number;
	}[],
): string {
	const zip = buildZip({
		entries: entries.map((entry) => ({
			name: entry.name,
			data: typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data,
			flags: entry.flags,
			method: entry.method,
			declaredUncompressed: entry.declaredUncompressed,
		})),
	});
	writeFixture(dir, name, zip.bytes);
	return name;
}

describe("InspectWebCapture reads HAR 1.2 metadata", () => {
	test("methods, statuses, origins and bodies are summarized without any recorded value", async () => {
		const dir = tempDir();
		writeHar(dir, "capture.har", [
			harEntry({
				requestCookies: [{ name: "sid", value: "SECRET" }],
				responseCookies: [{ name: "sid", value: "SECRET" }],
			}),
			harEntry({
				method: "POST",
				url: "https://api.example.org/v1?q=SECRET",
				status: 404,
				mime: "text/plain",
				content: { mimeType: "text/plain", size: 7, text: "missing" },
				postData: { mimeType: "application/x-www-form-urlencoded", text: "token=SECRET" },
				time: 12,
			}),
		]);

		const { result, text } = await inspect(dir, { path: "capture.har" });

		expect(result.isError).toBeFalsy();
		expect(text).toContain("InspectWebCapture report for capture.har");
		expect(text).toContain("format: HAR 1.2");
		expect(text).toContain("creator: Test 1.0");
		expect(text).toContain("pages: 0");
		expect(text).toContain("records: 2");
		expect(text).toContain("methods: GET 1, POST 1");
		expect(text).toContain("statuses: 2xx 1, 4xx 1");
		expect(text).toContain("MIME types: application/json 1, text/plain 1");
		expect(text).toContain("origins: https://api.example.org 1");
		expect(text).toContain("https://example.com 1");
		expect(text).toContain("cookies: request 1, response 1");
		expect(text).toContain("request header names: accept 2, authorization 2");
		expect(text).toContain("response header names: content-type 2, set-cookie 2");
		expect(text).toContain("#0 GET https://example.com/api/items?<2 params> -> 200 application/json, request 0 B");
		expect(text).toContain(`response 11 B (sha256:${sha256('{"ok":true}').slice(0, 12)})`);
		expect(text).toContain("request 0 B (body not recorded)");
		expect(text).toContain("84 ms");
		expect(text).toContain("#1 POST https://api.example.org/v1?<1 param> -> 404 text/plain, request 12 B");
		expect(text).toContain(`request 12 B (sha256:${sha256("token=SECRET").slice(0, 12)})`);
		expect(text).toContain("12 ms");
		expect(text).toContain("read scope: the capture was parsed offline; no URL was fetched");
		expect(text).not.toContain("SECRET");
		expect(text).not.toContain("Bearer");
		expect(text).not.toContain("sid=");
		expect(text).not.toContain("token=");
		expect(text).not.toContain("missing");
	});

	test("the request URL's userinfo and fragment are dropped", async () => {
		const dir = tempDir();
		writeHar(dir, "userinfo.har", [
			harEntry({
				url: "https://user:pass@example.com/private/path?q=SECRET&q=SECOND#fragments=SECRET",
				content: { mimeType: "text/plain", size: 0, text: "" },
			}),
		]);

		const { text } = await inspect(dir, { path: "userinfo.har" });

		expect(text).toContain("https://example.com/private/path?<2 params>");
		expect(text).not.toContain("user:pass");
		expect(text).not.toContain("pass@");
		expect(text).not.toContain("SECRET");
		expect(text).not.toContain("fragments");
	});

	test("a non-http scheme and an unparsable URL are reduced to labels", async () => {
		const dir = tempDir();
		writeHar(dir, "schemes.har", [
			harEntry({ url: "ws://example.com/socket?token=SECRET" }),
			harEntry({ url: "not a url" }),
		]);

		const { text } = await inspect(dir, { path: "schemes.har" });

		expect(text).toContain("ws://(non-http scheme)");
		expect(text).toContain("(unparsable URL)");
		expect(text).toContain("limitation: 1 target(s) use a non-http scheme; only the scheme is shown");
		expect(text).toContain("limitation: 1 URL(s) could not be parsed; their text is not shown");
		expect(text).not.toContain("SECRET");
		expect(text).not.toContain("not a url");
	});

	test("a base64 body is decoded for its hash only; non-canonical base64 is malformed", async () => {
		const dir = tempDir();
		writeHar(dir, "base64.har", [
			harEntry({
				mime: "text/plain",
				content: { mimeType: "text/plain", size: 5, text: "aGVsbG8=", encoding: "base64" },
			}),
			harEntry({
				mime: "text/plain",
				content: { mimeType: "text/plain", size: 4, text: "!!!!", encoding: "base64" },
			}),
		]);

		const { text } = await inspect(dir, { path: "base64.har" });

		expect(text).toContain(`response 5 B (sha256:${sha256("hello").slice(0, 12)})`);
		expect(text).toContain("#1 malformed (response body is not canonical base64)");
		expect(text).toContain("records: 2 (malformed: 1)");
		expect(text).not.toContain("aGVsbG8=");
		expect(text).not.toContain("hello");
	});

	test("a declared body size without text is reported as not recorded", async () => {
		const dir = tempDir();
		writeHar(dir, "size-only.har", [harEntry({ content: { mimeType: "application/octet-stream", size: 12 } })]);

		const { text } = await inspect(dir, { path: "size-only.har" });

		expect(text).toContain("response 12 B (body not recorded)");
		expect(text).not.toMatch(/response 12 B \(sha256:/);
	});

	test("a damaged record is named while its neighbours still count", async () => {
		const dir = tempDir();
		const bad = harEntry();
		(bad.request as Record<string, unknown>).method = 7;
		writeHar(dir, "damaged.har", [bad, harEntry({ time: 5 })]);

		const { result, text } = await inspect(dir, { path: "damaged.har" });

		expect(result.isError).toBeFalsy();
		expect(text).toContain("records: 2 (malformed: 1)");
		expect(text).toContain("#0 malformed (request.method is not a non-empty string)");
		expect(text).toContain("#1 GET");
		expect(text).toContain("methods: GET 1");
		expect(text).toContain("limitation: 1 record(s) are malformed; they are excluded from the aggregates");
	});

	test("selection keeps the caller's order and aggregate coverage is stated", async () => {
		const dir = tempDir();
		writeHar(dir, "select.har", [
			harEntry({ method: "GET" }),
			harEntry({ method: "POST", status: 201 }),
			harEntry({ method: "DELETE", status: 204 }),
		]);

		const { text } = await inspect(dir, { path: "select.har", records: [2, 0] });

		expect(text).toContain("selection: record(s) 2, 0 of 3; aggregates cover all 3");
		expect(text).toContain("#2 DELETE");
		expect(text).toContain("#0 GET");
		expect(text).not.toContain("#1 POST");
		expect(text).toContain("methods: DELETE 1, GET 1, POST 1");
		const recordLines = text.split("\n").filter((line) => line.startsWith("  #"));
		expect(recordLines[0]).toStartWith("  #2 DELETE");
		expect(recordLines[1]).toStartWith("  #0 GET");
	});

	test("duplicate and out-of-range ordinals are errors", async () => {
		const dir = tempDir();
		writeHar(dir, "select.har", [harEntry()]);

		const duplicate = await inspect(dir, { path: "select.har", records: [0, 0] });
		expect(duplicate.result.isError).toBe(true);
		expect(duplicate.text).toContain("record 0 is requested more than once");

		const outside = await inspect(dir, { path: "select.har", records: [1] });
		expect(outside.result.isError).toBe(true);
		expect(outside.text).toContain("record 1 is out of range");

		const negative = await inspect(dir, { path: "select.har", records: [-1] });
		expect(negative.result.isError).toBe(true);
		expect(negative.text).toContain("records must be non-negative integers");
	});

	test("a capture past 32 MiB is refused before it is read", async () => {
		const dir = tempDir();
		const path = join(dir, "huge.har");
		writeFileSync(path, "");
		truncateSync(path, 32 * 1024 * 1024 + 1);

		const { result, text } = await inspect(dir, { path: "huge.har" });
		expect(result.isError).toBe(true);
		expect(text).toContain("past the 33554432-byte HAR read cap");
	});
});

describe("InspectWebCapture refuses a HAR that is not HAR 1.2", () => {
	test("bad JSON, a missing log, the wrong version, and a non-array entry list are errors", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "bad.json"), "not json");
		writeFileSync(join(dir, "root.json"), JSON.stringify({ version: "1.2" }));
		writeHar(dir, "version.har", [], { version: "1.1" });
		writeHar(dir, "entries.har", [], { entries: "many" });

		for (const name of ["bad.json", "root.json", "version.har", "entries.har"]) {
			const { result, text } = await inspect(dir, { path: name });
			expect(result.isError).toBe(true);
			expect(text).toContain("InspectWebCapture:");
		}
		const badJson = await inspect(dir, { path: "bad.json" });
		expect(badJson.text).toContain("did not parse as JSON");
		const wrongVersion = await inspect(dir, { path: "version.har" });
		expect(wrongVersion.text).toContain('not "1.2"');
	});
});

describe("InspectWebCapture reads SAZ sessions", () => {
	const request =
		"GET /api/items?token=SECRET&x=1 HTTP/1.1\r\nHost: example.com\r\nCookie: sid=SECRET\r\nAuthorization: Bearer SECRET\r\n\r\n";
	const response =
		'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nSet-Cookie: sid=SECRET\r\n\r\n{"ok":true}';

	function basicSaz(dir: string): string {
		return writeSaz(dir, "capture.saz", [
			{ name: "raw/1_c.txt", data: request },
			{ name: "raw/1_s.txt", data: response },
			{ name: "raw/1_m.xml", data: '<Session SID="SECRET"/>' },
			{ name: "raw/1_w.txt", data: "SECRET websocket frame" },
			{ name: "raw/2_s.txt", data: "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nmissing" },
			{ name: "other.bin", data: "SECRET other member" },
		]);
	}

	test("paired members are summarized and absent members are distinct from empty bodies", async () => {
		const dir = tempDir();
		basicSaz(dir);

		const { result, text } = await inspect(dir, { path: "capture.saz" });

		expect(result.isError).toBeFalsy();
		expect(text).toContain("InspectWebCapture report for capture.saz");
		expect(text).toContain("format: SAZ (Fiddler session archive)");
		expect(text).toContain("sessions: 2");
		expect(text).toContain("methods: GET 1");
		expect(text).toContain("statuses: 2xx 1, 4xx 1");
		expect(text).toContain("MIME types: application/json 1, text/plain 1");
		expect(text).toContain("other members: 1");
		expect(text).toContain("cookies: request 1, response 1");
		expect(text).toContain("request header names: authorization 1, cookie 1, host 1");
		expect(text).toContain("#0 GET /api/items?<2 params> -> 200 application/json, request 0 B");
		expect(text).toContain(`response 11 B (sha256:${sha256('{"ok":true}').slice(0, 12)})`);
		expect(text).toContain(`request 0 B (sha256:${sha256("").slice(0, 12)})`);
		expect(text).toContain("metadata ");
		expect(text).toContain("extras: w");
		expect(text).toContain("#1 -> 404 text/plain, request absent");
		expect(text).toContain(`response 7 B (sha256:${sha256("missing").slice(0, 12)})`);
		expect(text).toContain("limitation: _m.xml metadata was not parsed");
		expect(text).not.toContain("SECRET");
		expect(text).not.toContain("Bearer");
		expect(text).not.toContain("sid=");
		expect(text).not.toContain("missing");
		expect(text).not.toContain("websocket frame");
		expect(text).not.toContain("<Session");
	});

	test("ordinals follow each session's first member, not the numeric stem", async () => {
		const dir = tempDir();
		writeSaz(dir, "order.saz", [
			{ name: "raw/10_s.txt", data: "HTTP/1.1 201 Created\r\n\r\n" },
			{ name: "raw/2_c.txt", data: "GET /two HTTP/1.1\r\n\r\n" },
			{ name: "raw/2_s.txt", data: "HTTP/1.1 204 No Content\r\n\r\n" },
			{ name: "raw/10_c.txt", data: "GET /ten HTTP/1.1\r\n\r\n" },
		]);

		const selected = await inspect(dir, { path: "order.saz", records: [0] });

		expect(selected.text).toContain("selection: record(s) 0 of 2; aggregates cover all 2");
		expect(selected.text).toContain("#0 GET /ten -> 201");
		expect(selected.text).not.toContain("#1");
		expect(selected.text).not.toContain("204");

		const all = await inspect(dir, { path: "order.saz" });
		const lines = all.text.split("\n").filter((line) => line.startsWith("  #"));
		expect(lines[0]).toContain("#0 GET /ten");
		expect(lines[1]).toContain("#1 GET /two");
	});

	test("a request with no response is reported with the response absent", async () => {
		const dir = tempDir();
		writeSaz(dir, "request-only.saz", [{ name: "raw/1_c.txt", data: "GET /only HTTP/1.1\r\n\r\n" }]);

		const { text } = await inspect(dir, { path: "request-only.saz" });

		expect(text).toContain("#0 GET /only, request 0 B (sha256:");
		expect(text).toContain("response absent");
		expect(text).toContain("statuses: none");
		expect(text).toContain("sessions: 1");
	});

	test("a bad start line makes that session unknown and a bad member size is named", async () => {
		const dir = tempDir();
		writeSaz(dir, "damaged.saz", [
			{ name: "raw/1_c.txt", data: "GET /ok HTTP/1.1\r\n\r\n" },
			{ name: "raw/1_s.txt", data: "garbage\r\n\r\n" },
			{ name: "raw/2_c.txt", data: "GET /short HTTP/1.1\r\n\r\n", declaredUncompressed: 999 },
			{ name: "raw/2_s.txt", data: "HTTP/1.1 200 OK\r\n\r\n" },
		]);

		const { result, text } = await inspect(dir, { path: "damaged.saz" });

		expect(result.isError).toBeFalsy();
		expect(text).toContain("sessions: 2 (unknown: 2)");
		expect(text).toContain('#0 unknown (response start line is not "HTTP/x.y <status>")');
		expect(text).toContain("#1 unknown (request member:");
		expect(text).toContain("declares 999");
		expect(text).toContain("statuses: none");
	});

	test("an unsupported member compression is unknown for that session", async () => {
		const dir = tempDir();
		writeSaz(dir, "method.saz", [
			{ name: "raw/1_c.txt", data: "GET / HTTP/1.1\r\n\r\n", method: 12 },
			{ name: "raw/1_s.txt", data: "HTTP/1.1 200 OK\r\n\r\n" },
		]);

		const { text } = await inspect(dir, { path: "method.saz" });
		expect(text).toContain("#0 unknown (request member:");
		expect(text).toContain("compression method 12 is not supported");
	});

	test("duplicate members, an encrypted member, and an over-budget expansion are errors", async () => {
		const dir = tempDir();
		writeSaz(dir, "duplicate.saz", [
			{ name: "raw/1_c.txt", data: "GET / HTTP/1.1\r\n\r\n" },
			{ name: "raw/1_c.txt", data: "GET /other HTTP/1.1\r\n\r\n" },
		]);
		const duplicate = await inspect(dir, { path: "duplicate.saz" });
		expect(duplicate.result.isError).toBe(true);
		expect(duplicate.text).toContain("duplicate member names");

		writeSaz(dir, "encrypted.saz", [{ name: "raw/1_c.txt", data: "GET / HTTP/1.1\r\n\r\n", flags: 1 }]);
		const encrypted = await inspect(dir, { path: "encrypted.saz" });
		expect(encrypted.result.isError).toBe(true);
		expect(encrypted.text).toContain("encrypted members");

		writeSaz(dir, "expanded.saz", [
			{ name: "raw/1_c.txt", data: "x", declaredUncompressed: 17 * 1024 * 1024 },
			{ name: "raw/1_s.txt", data: "y", declaredUncompressed: 17 * 1024 * 1024 },
		]);
		const expanded = await inspect(dir, { path: "expanded.saz" });
		expect(expanded.result.isError).toBe(true);
		expect(expanded.text).toContain("past the 33554432-byte expansion cap");
	});
});

describe("InspectWebCapture stays offline and format-honest", () => {
	test("auto detects both formats; a forced format that does not match is an error", async () => {
		const dir = tempDir();
		writeHar(dir, "one.har", [harEntry()]);
		writeSaz(dir, "one.saz", [{ name: "raw/1_c.txt", data: "GET / HTTP/1.1\r\n\r\n" }]);

		expect((await inspect(dir, { path: "one.har" })).text).toContain("format: HAR 1.2");
		expect((await inspect(dir, { path: "one.saz" })).text).toContain("format: SAZ");

		const harAsSaz = await inspect(dir, { path: "one.har", format: "saz" });
		expect(harAsSaz.result.isError).toBe(true);
		const sazAsHar = await inspect(dir, { path: "one.saz", format: "har" });
		expect(sazAsHar.result.isError).toBe(true);
	});

	test("nothing is fetched and the capture directory is unchanged", async () => {
		const dir = tempDir();
		const name = writeSaz(dir, "offline.saz", [
			{ name: "raw/1_c.txt", data: "GET https://example.com/ HTTP/1.1\r\n\r\n" },
			{ name: "raw/1_s.txt", data: "HTTP/1.1 200 OK\r\n\r\n" },
		]);
		const before = readFileSync(join(dir, name));
		const listing = readdirSync(dir).sort();
		const originalFetch = globalThis.fetch;
		let fetched = false;
		globalThis.fetch = (() => {
			fetched = true;
			throw new Error("the capture reader must not fetch");
		}) as unknown as typeof fetch;
		try {
			const { result } = await inspect(dir, { path: name });
			expect(result.isError).toBeFalsy();
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(fetched).toBe(false);
		expect(readFileSync(join(dir, name)).equals(before)).toBe(true);
		expect(readdirSync(dir).sort()).toEqual(listing);
	});
});
