/**
 * InspectWebCapture — what an offline HAR or Fiddler SAZ recorded, without
 * showing anything that was secret in it.
 *
 * A capture is evidence about traffic, not traffic: every answer here comes
 * from bytes already on disk, and nothing is fetched, opened, or replayed.
 * That distinction drives the two formats' readers. A HAR is JSON whose
 * entries may hold request and response bodies, and a SAZ is a zip whose
 * `raw/` members hold the request and response in HTTP wire format. Both can
 * carry an `Authorization` header, a session cookie, a query-string token, or
 * a body that is itself a credential, so the report is built from counts,
 * names, sizes, and hashes: header values, cookie values, query values, URL
 * userinfo, fragments, and body text are never printed. A body is decoded only
 * far enough to hash the bytes the capture recorded; `Content-Encoding` and
 * HAR `content.compression` are not undone, because the question here is what
 * was captured, not what a client would have seen after decompression.
 *
 * The same honesty applies to damage. A structurally broken zip or a JSON
 * document that is not HAR 1.2 fails the call: there is no capture to report.
 * One broken record inside a sound capture is reported as that record being
 * malformed or unknown, with a reason, while the other records still count.
 * Selection ordinals are 0-based in the capture's own order; aggregates always
 * cover every record, and the report says so when a selection hid some from
 * the list.
 */
import { stat } from "node:fs/promises";
import { type AnyTool, buildTool, formatCutMarker } from "@labunbun/agent";
import { z } from "zod";
import {
	type ArchiveFile,
	isRecord,
	message,
	printable,
	readRange,
	readZipDirectory,
	readZipEntry,
	u32,
	type ZipEntry,
} from "./archive.ts";
import { guardPathContainment } from "./containment.ts";
import { describeFsFailure } from "./path-errors.ts";

/** A HAR past this size is refused rather than read. */
const MAX_HAR_BYTES = 32 * 1024 * 1024;

/** HAR entries read before the capture is refused as too large. */
const MAX_HAR_ENTRIES = 50_000;

/** SAZ members read before the capture is refused as too large. */
const MAX_SAZ_MEMBERS = 20_000;

/** Declared uncompressed bytes of the request and response members together. */
const MAX_SAZ_EXPANDED_BYTES = 32 * 1024 * 1024;

/** Compressed bytes of one SAZ member that may be read. */
const MAX_SAZ_MEMBER_BYTES = 64 * 1024 * 1024;

/** Records listed before the rest are counted. */
const MAX_LISTED_RECORDS = 200;

/** Header names listed per direction. */
const MAX_HEADER_NAMES = 20;

/** Hex characters of a SHA-256 shown for one body. */
const DISPLAY_HASH_CHARS = 12;

/** Whole-report cap; past it the tail is cut with an explicit marker. */
const MAX_REPORT_CHARS = 20_000;

/** The session members a Fiddler archive puts beside each other in `raw/`. */
const SESSION_MEMBER = /^raw\/([^/]+)_([csmwg])\.(txt|xml)$/;

type Format = "har" | "saz";
type RecordState = "ok" | "malformed" | "unknown";
type UrlClass = "http" | "non-http" | "unparsable" | "relative" | "authority";

/** A URL or HTTP target reduced to what may be printed. */
interface TargetView {
	text: string;
	origin: string | null;
	query: number;
	kind: UrlClass;
}

/** One request or response as far as this report reads it. */
interface HttpPart {
	headers: Map<string, number>;
	cookies: number;
	mime: string | null;
	body: Uint8Array;
	startLine: string;
	badHeaders: number;
}

/** One capture record, in the shape both readers can fill. */
interface RecordView {
	index: number;
	state: RecordState;
	reason: string | null;
	method: string | null;
	target: TargetView | null;
	status: number | null;
	mime: string | null;
	requestBytes: number;
	requestHash: string | null;
	/** The request exists; `requestRecorded` says its body text was captured. */
	requestPresent: boolean;
	requestRecorded: boolean;
	responseBytes: number;
	responseHash: string | null;
	responsePresent: boolean;
	responseRecorded: boolean;
	timeMs: number | null;
	requestHeaders: Map<string, number>;
	responseHeaders: Map<string, number>;
	requestCookies: number;
	responseCookies: number;
	badHeaders: number;
	metadataBytes: number | null;
	extras: string[];
	compressedBody: boolean;
}

/** Everything a reader learned, before formatting. */
interface CaptureReport {
	display: string;
	format: string;
	recordNoun: "records" | "sessions";
	records: RecordView[];
	malformedLabel: string;
	creator: string | null;
	pages: number | null;
	otherMembers: number | null;
	compressedBodies: number;
	limitations: string[];
}

/** Structure of one capture report. */
export function createInspectWebCaptureTool(cwd: string): AnyTool {
	return buildTool({
		name: "InspectWebCapture",
		description:
			"Reports what an offline HAR 1.2 or Fiddler SAZ capture recorded: methods, status classes, MIME types, origins, " +
			"body sizes and SHA-256 hashes, header and cookie counts, and per-record request/response lines. Header, " +
			"cookie, query-string and body values are never printed, URL userinfo and fragments are dropped, and no body " +
			"is decompressed or dechunked. The capture is parsed from disk; no URL is fetched. Use it to see the shape of a " +
			"recorded session without exposing its credentials. Records are selected by 0-based ordinals; aggregates always " +
			"cover the whole capture.",
		inputSchema: z.object({
			path: z.string().describe("Path to a .har or .saz capture (or any name; the bytes decide the format)"),
			format: z.enum(["auto", "har", "saz"]).optional().describe("Capture format; auto reads the leading bytes"),
			records: z
				.array(z.number().int())
				.optional()
				.describe("0-based ordinals to list; aggregates still cover every record"),
		}),
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		call: async (input) => {
			let source: string;
			try {
				source = guardPathContainment(input.path, cwd, "InspectWebCapture");
			} catch (error) {
				return failure(message(error));
			}
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(source);
			} catch (error) {
				return failure(describeFsFailure(error, input.path, "inspect"));
			}
			if (info.isDirectory()) return failure(`${input.path} is a directory, not a capture file.`);
			if (!info.isFile()) return failure(`${input.path} is not a regular file.`);

			const file = Bun.file(source);
			let format: Format;
			try {
				format = await detectFormat(file, info.size, input.format ?? "auto");
			} catch (error) {
				return failure(`InspectWebCapture: ${message(error)}`);
			}
			let report: CaptureReport;
			try {
				report =
					format === "har" ? await readHar(file, info.size, input.path) : await readSaz(file, info.size, input.path);
			} catch (error) {
				return failure(`InspectWebCapture: ${message(error)}`);
			}
			const selection = chooseRecords(input.records, report.records.length);
			if (typeof selection === "string") return failure(`InspectWebCapture: ${selection}`);
			return ok(capReport(render(report, selection)));
		},
	});
}

/** The format the caller named, or what the leading bytes say. */
async function detectFormat(file: ArchiveFile, size: number, requested: "auto" | Format): Promise<Format> {
	if (requested !== "auto") return requested;
	if (size >= 4) {
		const head = await readRange(file, 0, 4);
		const signature = u32(head, 0);
		if (signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x02014b50) return "saz";
	}
	return "har";
}

/** The 0-based ordinals to list, or a reason the request cannot be honored. */
function chooseRecords(requested: number[] | undefined, total: number): number[] | string | undefined {
	if (requested === undefined) return undefined;
	const seen = new Set<number>();
	const chosen: number[] = [];
	for (const index of requested) {
		if (!Number.isInteger(index) || index < 0) return `records must be non-negative integers; ${index} is not one`;
		if (index >= total) return `record ${index} is out of range (the capture has ${total} record(s))`;
		if (seen.has(index)) return `record ${index} is requested more than once`;
		seen.add(index);
		chosen.push(index);
	}
	return chosen;
}

// ---------------------------------------------------------------------------
// HAR 1.2
// ---------------------------------------------------------------------------

/** Parse a HAR document and turn every entry into a record. Fatal damage throws. */
async function readHar(file: ArchiveFile, size: number, display: string): Promise<CaptureReport> {
	if (size > MAX_HAR_BYTES) {
		throw new Error(`the file is ${size} bytes, past the ${MAX_HAR_BYTES}-byte HAR read cap`);
	}
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.length > MAX_HAR_BYTES) {
		throw new Error(`the file grew past the ${MAX_HAR_BYTES}-byte HAR read cap while being read`);
	}
	const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		// The parser's message can quote the offending input, and that input is
		// the capture; the report says what failed, not what it contained.
		throw new Error("the file did not parse as JSON");
	}
	if (!isRecord(root)) throw new Error("the JSON root is not an object");
	const log = root.log;
	if (!isRecord(log)) throw new Error('the JSON root has no "log" object');
	if (log.version !== "1.2") throw new Error('log.version is not "1.2"');
	const entries = log.entries;
	if (!Array.isArray(entries)) throw new Error("log.entries is not an array");
	if (entries.length > MAX_HAR_ENTRIES) {
		throw new Error(`the capture holds ${entries.length} entries, past the ${MAX_HAR_ENTRIES}-entry read cap`);
	}

	const records = entries.map((entry, index) => harRecord(entry, index));
	let creator: string | null = null;
	if (isRecord(log.creator) && typeof log.creator.name === "string") {
		creator = printable(
			`${log.creator.name}${typeof log.creator.version === "string" ? ` ${log.creator.version}` : ""}`,
		);
	}
	const limitations: string[] = [];
	let pages: number | null = null;
	if (log.pages !== undefined) {
		if (Array.isArray(log.pages)) pages = log.pages.length;
		else limitations.push("log.pages is not an array; its count is not reported");
	}
	const compressedBodies = records.filter(
		(record) => record.state === "ok" && record.compressedBody && record.responseHash !== null,
	).length;
	return {
		display,
		format: "HAR 1.2",
		recordNoun: "records",
		records,
		malformedLabel: "malformed",
		creator,
		pages,
		otherMembers: null,
		compressedBodies,
		limitations,
	};
}

/** One HAR entry, or the reason it cannot be read. */
function harRecord(entry: unknown, index: number): RecordView {
	const bad = (reason: string): RecordView => blankRecord(index, "malformed", reason);
	if (!isRecord(entry)) return bad("the record is not an object");
	const request = entry.request;
	if (!isRecord(request)) return bad("request is not an object");
	if (typeof request.method !== "string" || request.method === "")
		return bad("request.method is not a non-empty string");
	if (typeof request.url !== "string") return bad("request.url is not a string");
	const response = entry.response;
	if (!isRecord(response)) return bad("response is not an object");
	if (typeof response.status !== "number" || !Number.isFinite(response.status)) {
		return bad("response.status is not a number");
	}
	if (!Array.isArray(request.headers)) return bad("request.headers is not an array");
	if (!Array.isArray(response.headers)) return bad("response.headers is not an array");
	const requestHeaders = headerTallies(request.headers, "request.headers");
	if (typeof requestHeaders === "string") return bad(requestHeaders);
	const responseHeaders = headerTallies(response.headers, "response.headers");
	if (typeof responseHeaders === "string") return bad(responseHeaders);
	const content = response.content;
	if (!isRecord(content)) return bad("response.content is not an object");
	if (content.text !== undefined && typeof content.text !== "string") {
		return bad("response.content.text is not a string");
	}
	if (content.encoding !== undefined && content.encoding !== "base64") {
		return bad("response.content.encoding is not supported");
	}
	let responseBody: Uint8Array | null = null;
	if (typeof content.text === "string") {
		const decoded = decodeBody(content.text, content.encoding === "base64");
		if (typeof decoded === "string") return bad(`response body ${decoded}`);
		responseBody = decoded;
	}
	let postText: string | null = null;
	if (request.postData !== undefined) {
		if (!isRecord(request.postData)) return bad("request.postData is not an object");
		if (request.postData.text !== undefined) {
			if (typeof request.postData.text !== "string") return bad("request.postData.text is not a string");
			postText = request.postData.text;
		}
	}
	const requestCookies = cookieCount(request.cookies, "request.cookies");
	if (typeof requestCookies === "string") return bad(requestCookies);
	const responseCookies = cookieCount(response.cookies, "response.cookies");
	if (typeof responseCookies === "string") return bad(responseCookies);
	const declaredSize =
		typeof content.size === "number" && Number.isFinite(content.size) && content.size >= 0 ? content.size : null;
	const responseBytes = responseBody === null ? (declaredSize ?? 0) : responseBody.length;
	const requestBytes = postText === null ? 0 : Buffer.byteLength(postText, "utf8");
	const timeMs = typeof entry.time === "number" && Number.isFinite(entry.time) && entry.time >= 0 ? entry.time : null;
	const target = viewUrl(request.url);
	return {
		index,
		state: "ok",
		reason: null,
		method: printable(request.method),
		target,
		status: response.status,
		mime: mimeEssence(content.mimeType),
		requestBytes,
		requestHash: postText === null ? null : sha256Hex(new TextEncoder().encode(postText)),
		requestPresent: true,
		requestRecorded: postText !== null,
		responseBytes,
		responseHash: responseBody === null ? null : sha256Hex(responseBody),
		responsePresent: true,
		responseRecorded: responseBody !== null,
		timeMs,
		requestHeaders,
		responseHeaders,
		requestCookies,
		responseCookies,
		badHeaders: 0,
		metadataBytes: null,
		extras: [],
		compressedBody: content.compression !== undefined,
	};
}

/** Header names and their counts; values are not read. */
function headerTallies(headers: unknown[], field: string): Map<string, number> | string {
	const counts = new Map<string, number>();
	for (const [index, header] of headers.entries()) {
		if (!isRecord(header) || typeof header.name !== "string") {
			return `${field}[${index}] is not an object with a string name`;
		}
		const name = header.name.toLowerCase();
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return counts;
}

/** A cookie array's length; a present non-array is damage. */
function cookieCount(value: unknown, field: string): number | string {
	if (value === undefined) return 0;
	if (!Array.isArray(value)) return `${field} is not an array`;
	return value.length;
}

/**
 * The bytes a HAR body claims as text.
 *
 * Base64 is accepted only in its canonical form: the string must round-trip
 * through the decoder unchanged, so a truncated or padded-in-the-middle body
 * is reported as unknown instead of hashed as something it is not.
 */
function decodeBody(text: string, base64: boolean): Uint8Array | string {
	if (!base64) return new TextEncoder().encode(text);
	if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return "is not canonical base64";
	const decoded = Buffer.from(text, "base64");
	if (decoded.toString("base64") !== text) return "is not canonical base64";
	return decoded;
}

// ---------------------------------------------------------------------------
// SAZ
// ---------------------------------------------------------------------------

/** Parse a Fiddler session archive into records. Structural damage throws. */
async function readSaz(file: ArchiveFile, size: number, display: string): Promise<CaptureReport> {
	const parsed = await readZipDirectory(file, size, MAX_SAZ_MEMBERS);
	if (parsed.truncated)
		throw new Error("the central directory is larger than the read window; the archive cannot be grouped");
	if (parsed.count > MAX_SAZ_MEMBERS) {
		throw new Error(`the archive holds ${parsed.count} members, past the ${MAX_SAZ_MEMBERS}-member read cap`);
	}
	if (parsed.duplicateNames.length > 0) {
		throw new Error("the archive holds duplicate member names; session grouping would be ambiguous");
	}
	if (parsed.entries.some((entry) => (entry.flags & 1) !== 0)) {
		throw new Error("the archive holds encrypted members; their bytes cannot be read");
	}

	const sessions = new Map<string, Map<"c" | "s" | "m" | "w" | "g", ZipEntry>>();
	const order: string[] = [];
	let otherMembers = 0;
	for (const entry of parsed.entries) {
		const name = entry.name.split("\\").join("/");
		const match = SESSION_MEMBER.exec(name);
		const letter = match?.[2] as "c" | "s" | "m" | "w" | "g" | undefined;
		const extension = match?.[3];
		if (!match || !letter || (letter === "m" ? extension !== "xml" : extension !== "txt")) {
			otherMembers += 1;
			continue;
		}
		const stem = match[1] as string;
		let members = sessions.get(stem);
		if (members === undefined) {
			members = new Map();
			sessions.set(stem, members);
			order.push(stem);
		} else if (members.has(letter)) {
			throw new Error(`session "${printable(stem)}" has more than one ${letter} member; grouping would be ambiguous`);
		}
		members.set(letter, entry);
	}
	if (order.length === 0) {
		return {
			display,
			format: "SAZ (Fiddler session archive)",
			recordNoun: "sessions",
			records: [],
			malformedLabel: "unknown",
			creator: null,
			pages: null,
			otherMembers,
			compressedBodies: 0,
			limitations: ["no raw/<stem>_c|s|m|w|g members were found"],
		};
	}
	let expanded = 0;
	for (const members of sessions.values()) {
		for (const letter of ["c", "s"] as const) {
			const entry = members.get(letter);
			if (entry) expanded += entry.uncompressed;
		}
	}
	if (expanded > MAX_SAZ_EXPANDED_BYTES) {
		throw new Error(
			`the request and response members declare ${expanded} bytes in total, past the ${MAX_SAZ_EXPANDED_BYTES}-byte expansion cap`,
		);
	}

	const records: RecordView[] = [];
	for (const [index, stem] of order.entries()) {
		const members = sessions.get(stem) as Map<"c" | "s" | "m" | "w" | "g", ZipEntry>;
		const reasons: string[] = [];
		let request: HttpPart | null = null;
		let response: HttpPart | null = null;
		const requestEntry = members.get("c");
		const responseEntry = members.get("s");
		if (requestEntry) {
			const read = await readSazMember(file, size, requestEntry);
			if (typeof read === "string") reasons.push(`request member: ${read}`);
			else {
				const parsedRequest = parseRequest(read, requestEntry.uncompressed);
				if (typeof parsedRequest === "string") reasons.push(`request ${parsedRequest}`);
				else request = parsedRequest;
			}
		}
		if (responseEntry) {
			const read = await readSazMember(file, size, responseEntry);
			if (typeof read === "string") reasons.push(`response member: ${read}`);
			else {
				const parsedResponse = parseResponse(read);
				if (typeof parsedResponse === "string") reasons.push(`response ${parsedResponse}`);
				else response = parsedResponse;
			}
		}
		const state: RecordState = reasons.length === 0 ? "ok" : "unknown";
		const requestTokens = request ? request.startLine.trim().split(/\s+/) : [];
		const target = request ? viewTarget(requestTokens[1] ?? "") : null;
		const extras = (["w", "g"] as const).filter((letter) => members.has(letter));
		records.push({
			index,
			state,
			reason: reasons.length === 0 ? null : reasons.join("; "),
			method: request ? printable(requestTokens[0] ?? "") : null,
			target,
			status: response ? responseStatus(response.startLine) : null,
			mime: response ? response.mime : null,
			requestBytes: request ? request.body.length : 0,
			requestHash: request ? sha256Hex(request.body) : null,
			requestPresent: requestEntry !== undefined,
			requestRecorded: request !== null,
			responseBytes: response ? response.body.length : 0,
			responseHash: response ? sha256Hex(response.body) : null,
			responsePresent: responseEntry !== undefined,
			responseRecorded: response !== null,
			timeMs: null,
			requestHeaders: request ? request.headers : new Map(),
			responseHeaders: response ? response.headers : new Map(),
			requestCookies: request ? request.cookies : 0,
			responseCookies: response ? response.cookies : 0,
			badHeaders: (request?.badHeaders ?? 0) + (response?.badHeaders ?? 0),
			metadataBytes: members.get("m")?.uncompressed ?? null,
			extras,
			compressedBody: false,
		});
	}
	const limitations: string[] = [];
	return {
		display,
		format: "SAZ (Fiddler session archive)",
		recordNoun: "sessions",
		records,
		malformedLabel: "unknown",
		creator: null,
		pages: null,
		otherMembers,
		compressedBodies: 0,
		limitations,
	};
}

/** One `_c`/`_s` member's bytes, or the reason it cannot be read. */
async function readSazMember(file: ArchiveFile, size: number, entry: ZipEntry): Promise<Uint8Array | string> {
	if (entry.compressed > MAX_SAZ_MEMBER_BYTES) {
		return `${entry.compressed} compressed bytes is past the ${MAX_SAZ_MEMBER_BYTES}-byte member cap`;
	}
	try {
		return await readZipEntry(file, size, entry, MAX_SAZ_EXPANDED_BYTES);
	} catch (error) {
		return message(error);
	}
}

/** Split a wire-format request into its start line, header names, and raw body. */
function parseRequest(bytes: Uint8Array, declared: number): HttpPart | string {
	if (bytes.length !== declared) return `holds ${bytes.length} bytes where the directory declares ${declared}`;
	const part = splitHttpMessage(bytes, "request");
	const tokens = part.startLine.trim().split(/\s+/);
	if (tokens.length < 2 || tokens[0] === "") return "start line has no method and target";
	return part;
}

/** Split a wire-format response and read its status. */
function parseResponse(bytes: Uint8Array): HttpPart | string {
	const part = splitHttpMessage(bytes, "response");
	if (responseStatus(part.startLine) === null) return 'start line is not "HTTP/x.y <status>"';
	return part;
}

/** The start line, header-name counts, MIME essence, cookie-header count, and body. */
function splitHttpMessage(bytes: Uint8Array, direction: "request" | "response"): HttpPart {
	const boundary = headBoundary(bytes);
	const head = new TextDecoder("utf-8").decode(bytes.subarray(0, boundary.headEnd));
	const lines = head.split(/\r?\n/);
	const startLine = lines.shift() ?? "";
	const headers = new Map<string, number>();
	let mime: string | null = null;
	let cookies = 0;
	let badHeaders = 0;
	for (const line of lines) {
		if (line === "") continue;
		if (/^[ \t]/.test(line)) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) {
			badHeaders += 1;
			continue;
		}
		const name = line.slice(0, colon).trim().toLowerCase();
		if (name === "") {
			badHeaders += 1;
			continue;
		}
		headers.set(name, (headers.get(name) ?? 0) + 1);
		if (name === "content-type" && mime === null) mime = mimeEssence(line.slice(colon + 1).trim());
		if (direction === "request" ? name === "cookie" : name === "set-cookie") cookies += 1;
	}
	return { headers, cookies, mime, body: bytes.subarray(boundary.bodyStart), startLine, badHeaders };
}

/** Where the header block ends and the body starts, for CRLF or LF line endings. */
function headBoundary(bytes: Uint8Array): { headEnd: number; bodyStart: number } {
	const crlf = findBytes(bytes, [13, 10, 13, 10]);
	const lf = findBytes(bytes, [10, 10]);
	if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { headEnd: crlf, bodyStart: crlf + 4 };
	if (lf >= 0) return { headEnd: lf, bodyStart: lf + 2 };
	return { headEnd: bytes.length, bodyStart: bytes.length };
}

function findBytes(haystack: Uint8Array, needle: number[]): number {
	for (let at = 0; at + needle.length <= haystack.length; at++) {
		let matched = true;
		for (let offset = 0; offset < needle.length; offset++) {
			if (haystack[at + offset] !== needle[offset]) {
				matched = false;
				break;
			}
		}
		if (matched) return at;
	}
	return -1;
}

/** The status in a response start line, or null. */
function responseStatus(startLine: string): number | null {
	const match = /^HTTP\/\d(?:\.\d+)?\s+(\d{3})(?:\s|$)/i.exec(startLine.trim());
	return match ? Number.parseInt(match[1] as string, 10) : null;
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

/** A HAR URL reduced to scheme, host, port, path, and a query count. */
function viewUrl(raw: string): TargetView {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { text: "(unparsable URL)", origin: null, query: 0, kind: "unparsable" };
	}
	const query = [...url.searchParams.keys()].length;
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { text: `${url.protocol}//(non-http scheme)`, origin: null, query, kind: "non-http" };
	}
	return {
		text: `${printable(url.origin)}${printable(url.pathname)}${queryLabel(query)}`,
		origin: printable(url.origin),
		query,
		kind: "http",
	};
}

/** A raw request target: absolute-form, origin-form, asterisk, or authority-form. */
function viewTarget(raw: string): TargetView | null {
	const target = raw.trim();
	if (target === "") return null;
	if (target === "*") return { text: "*", origin: null, query: 0, kind: "relative" };
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target)) return viewUrl(target);
	const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(target);
	if (scheme && !/^\d+$/.test(target.slice(scheme[0].length))) {
		return { text: `${scheme[1]?.toLowerCase()}://(non-http scheme)`, origin: null, query: 0, kind: "non-http" };
	}
	if (target.startsWith("/")) {
		const withoutFragment = target.split("#")[0] as string;
		const at = withoutFragment.indexOf("?");
		const path = at >= 0 ? withoutFragment.slice(0, at) : withoutFragment;
		const query = at >= 0 ? [...new URLSearchParams(withoutFragment.slice(at + 1)).keys()].length : 0;
		return {
			text: `${printable(path === "" ? "/" : path)}${queryLabel(query)}`,
			origin: null,
			query,
			kind: "relative",
		};
	}
	// Anything else is treated as authority-form. Strip a query and fragment
	// anyway: a malformed origin-form target must not smuggle its values into
	// the report through this branch.
	const withoutFragment = target.split("#")[0] as string;
	const at = withoutFragment.indexOf("?");
	const authority = at >= 0 ? withoutFragment.slice(0, at) : withoutFragment;
	const query = at >= 0 ? [...new URLSearchParams(withoutFragment.slice(at + 1)).keys()].length : 0;
	const bare = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
	return { text: `${printable(bare)}${queryLabel(query)}`, origin: null, query, kind: "authority" };
}

function queryLabel(count: number): string {
	if (count === 0) return "";
	return `?<${count} param${count === 1 ? "" : "s"}>`;
}

/** A MIME type's essence, lower-cased: the type before any parameters. */
function mimeEssence(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const essence = value.split(";")[0]?.trim().toLowerCase();
	return essence ? printable(essence) : null;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function render(report: CaptureReport, selection: number[] | undefined): string {
	const valid = report.records.filter((record) => record.state === "ok");
	const methods = tally(valid.map((record) => record.method));
	const statuses = new Map<string, number>();
	const mimes = tally(valid.map((record) => record.mime));
	const origins = tally(valid.map((record) => record.target?.origin ?? null));
	const requestHeaders = mergeTallies(valid.map((record) => record.requestHeaders));
	const responseHeaders = mergeTallies(valid.map((record) => record.responseHeaders));
	for (const record of valid) {
		if (record.status === null) continue;
		const key = statusClass(record.status);
		statuses.set(key, (statuses.get(key) ?? 0) + 1);
	}
	const requestBytes = valid.reduce((sum, record) => sum + record.requestBytes, 0);
	const responseBytes = valid.reduce((sum, record) => sum + record.responseBytes, 0);
	const requestCookies = valid.reduce((sum, record) => sum + record.requestCookies, 0);
	const responseCookies = valid.reduce((sum, record) => sum + record.responseCookies, 0);
	const badHeaders = valid.reduce((sum, record) => sum + record.badHeaders, 0);
	const malformed = report.records.length - valid.length;

	const lines = [`InspectWebCapture report for ${printable(report.display)}`, `format: ${report.format}`];
	if (report.creator !== null) lines.push(`creator: ${report.creator}`);
	if (report.pages !== null) lines.push(`pages: ${report.pages}`);
	lines.push(
		`${report.recordNoun}: ${report.records.length}${malformed > 0 ? ` (${report.malformedLabel}: ${malformed})` : ""}`,
	);
	lines.push(`methods: ${tallyLine(methods)}`);
	lines.push(`statuses: ${tallyLine(statuses, statusOrder)}`);
	lines.push(`MIME types: ${tallyLine(mimes)}`);
	if (origins.size > 0) lines.push(`origins: ${tallyLine(origins)}`);
	lines.push(`request bytes: ${requestBytes}, response bytes: ${responseBytes}`);
	lines.push(`cookies: request ${requestCookies}, response ${responseCookies}`);
	lines.push(`request header names: ${tallyLine(requestHeaders, undefined, MAX_HEADER_NAMES)}`);
	lines.push(`response header names: ${tallyLine(responseHeaders, undefined, MAX_HEADER_NAMES)}`);
	if (report.otherMembers !== null) lines.push(`other members: ${report.otherMembers}`);
	if (selection !== undefined) {
		lines.push(
			`selection: record(s) ${selection.length === 0 ? "(none)" : selection.join(", ")} of ${report.records.length}; aggregates cover all ${report.records.length}`,
		);
	}

	lines.push("records:");
	const listed = selection ?? report.records.map((_, index) => index).slice(0, MAX_LISTED_RECORDS);
	if (report.records.length === 0) lines.push("  (no records)");
	else if (listed.length === 0) lines.push("  (no records selected)");
	for (const index of listed.slice(0, MAX_LISTED_RECORDS)) {
		const record = report.records[index] as RecordView;
		lines.push(`  ${recordLine(record)}`);
	}
	const hidden = (selection?.length ?? report.records.length) - Math.min(listed.length, MAX_LISTED_RECORDS);
	if (hidden > 0) lines.push(`  ... ${hidden} more record(s) not listed (the list stops at ${MAX_LISTED_RECORDS})`);
	lines.push(
		"read scope: the capture was parsed offline; no URL was fetched; header, cookie, query-string and body values were not printed; body hashes cover the recorded bytes only, with no decompression or dechunking; URL paths are shown and may themselves contain sensitive text",
	);

	const limitations = [...report.limitations];
	const nonHttp = valid.filter((record) => record.target?.kind === "non-http").length;
	const unparsable = valid.filter((record) => record.target?.kind === "unparsable").length;
	if (nonHttp > 0) limitations.push(`${nonHttp} target(s) use a non-http scheme; only the scheme is shown`);
	if (unparsable > 0) limitations.push(`${unparsable} URL(s) could not be parsed; their text is not shown`);
	if (report.compressedBodies > 0) {
		limitations.push(
			`${report.compressedBodies} response body(ies) declare content.compression; the recorded bytes were hashed without decompression`,
		);
	}
	if (report.format.startsWith("SAZ")) {
		limitations.push("_m.xml metadata was not parsed; _w and _g members are reported by presence only");
	}
	if (badHeaders > 0) limitations.push(`${badHeaders} header line(s) had no name/value shape and were not counted`);
	if (malformed > 0)
		limitations.push(`${malformed} record(s) are ${report.malformedLabel}; they are excluded from the aggregates`);
	for (const limitation of [...new Set(limitations)]) lines.push(`limitation: ${limitation}`);
	return lines.join("\n");
}

function recordLine(record: RecordView): string {
	if (record.state !== "ok") {
		return `#${record.index} ${record.state} (${record.reason ?? "reason not stated"})`;
	}
	let line = `#${record.index}`;
	let described = false;
	if (record.method !== null) {
		line += ` ${record.method}`;
		described = true;
	}
	if (record.target !== null) {
		line += ` ${record.target.text}`;
		described = true;
	}
	if (record.status !== null) {
		line += ` -> ${record.status} ${record.mime ?? "(no MIME)"}`;
		described = true;
	}
	const details: string[] = [];
	if (record.requestPresent) {
		details.push(
			record.requestRecorded
				? describeBody("request", record.requestBytes, record.requestHash)
				: `request ${record.requestBytes} B (body not recorded)`,
		);
	} else {
		details.push("request absent");
	}
	if (record.responsePresent) {
		details.push(
			record.responseRecorded
				? describeBody("response", record.responseBytes, record.responseHash)
				: `response ${record.responseBytes} B (body not recorded)`,
		);
	} else {
		details.push("response absent");
	}
	if (record.timeMs !== null) details.push(`${record.timeMs} ms`);
	if (record.metadataBytes !== null) details.push(`metadata ${record.metadataBytes} B`);
	if (record.extras.length > 0) details.push(`extras: ${record.extras.join(", ")}`);
	if (details.length > 0) line += `${described ? ", " : " "}${details.join(", ")}`;
	return line;
}

/** A recorded body as a size and a short hash, or a size and the reason it is not hashed. */
function describeBody(label: string, bytes: number, hash: string | null): string {
	if (hash === null) return `${label} ${bytes} B (body not recorded)`;
	return `${label} ${bytes} B (sha256:${hash.slice(0, DISPLAY_HASH_CHARS)})`;
}

function statusClass(status: number): string {
	if (!Number.isInteger(status)) return "unknown";
	const group = Math.floor(status / 100);
	return group >= 1 && group <= 5 ? `${group}xx` : "unknown";
}

function statusOrder(left: string, right: string): number {
	const order = ["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"];
	return order.indexOf(left) - order.indexOf(right);
}

function tally(values: (string | null)[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) {
		if (value === null) continue;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return counts;
}

function mergeTallies(sources: Map<string, number>[]): Map<string, number> {
	const merged = new Map<string, number>();
	for (const source of sources) {
		for (const [name, count] of source) merged.set(name, (merged.get(name) ?? 0) + count);
	}
	return merged;
}

function tallyLine(
	counts: Map<string, number>,
	order?: (left: string, right: string) => number,
	limit = Number.MAX_SAFE_INTEGER,
): string {
	if (counts.size === 0) return "none";
	const entries = [...counts.entries()].sort((a, b) => {
		if (order) {
			const byOrder = order(a[0], b[0]);
			if (byOrder !== 0) return byOrder;
			return b[1] - a[1];
		}
		const byCount = b[1] - a[1];
		if (byCount !== 0) return byCount;
		return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
	});
	const shown = entries.slice(0, limit).map(([name, count]) => `${printable(name)} ${count}`);
	if (entries.length > limit) shown.push(`+${entries.length - limit} more`);
	return shown.join(", ");
}

function blankRecord(index: number, state: RecordState, reason: string): RecordView {
	return {
		index,
		state,
		reason,
		method: null,
		target: null,
		status: null,
		mime: null,
		requestBytes: 0,
		requestHash: null,
		requestPresent: false,
		requestRecorded: false,
		responseBytes: 0,
		responseHash: null,
		responsePresent: false,
		responseRecorded: false,
		timeMs: null,
		requestHeaders: new Map(),
		responseHeaders: new Map(),
		requestCookies: 0,
		responseCookies: 0,
		badHeaders: 0,
		metadataBytes: null,
		extras: [],
		compressedBody: false,
	};
}

function sha256Hex(data: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(data);
	return hasher.digest("hex");
}

/** The report up to `MAX_REPORT_CHARS`, with the usual marker naming what was cut. */
function capReport(text: string): string {
	if (text.length <= MAX_REPORT_CHARS) return text;
	return `${text.slice(0, MAX_REPORT_CHARS)}\n${formatCutMarker(text.length - MAX_REPORT_CHARS)}`;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function failure(text: string) {
	return { content: [{ type: "text" as const, text }], isError: true as const };
}
