/**
 * `urlCredentialProblem` — the one credential channel a name-based scan cannot see.
 *
 * **Every importer in this repository copies an MCP server's `url` verbatim**, and
 * a credential can live inside that URL without any secret-shaped *key* anywhere
 * near it: `https://alice:hunter2@host/sse` and `https://host/mcp?access_token=…`
 * are both ordinary strings that every MCP client accepts. The scrub that strips
 * `headers` and `env` values walks keys, so it looks straight past both.
 *
 * Three properties are pinned below, and each one is a way the first
 * implementation of this function was measured to be wrong:
 *
 *   - **It does not use `new URL`.** The parser rejects a space in the host, a
 *     port above 65535, an unclosed bracket, and a scheme-relative
 *     `//user:pass@host` — measured, all four returned "no problem" while
 *     carrying a working password, because a hand-edited URL is what a pasted
 *     credential URL *is*. Every row below is answered structurally, so the
 *     malformed spellings and the well-formed ones get the same answer.
 *   - **The fragment is scanned, and so is the query.** A token after `#` is
 *     never sent over HTTP, so it authenticates nothing — and it is still copied
 *     byte-for-byte into a file on disk, which is the thing being prevented.
 *   - **It over-flags on purpose.** See the OVER-FLAGGED rows. A false positive
 *     costs a user one server and the report says which one and why; a false
 *     negative writes a live token into `.mcp.json` under a report line that
 *     denies there is one.
 *
 * Nothing here is a real address or a real credential: every host is under
 * `.invalid` (RFC 2606) and every value is a fixed string.
 */

import { describe, expect, test } from "bun:test";
import { urlCredentialProblem } from "../src/migrate-core.ts";

describe("userinfo", () => {
	// The `@` only counts in the authority. `https://host/a@b` has one in the path
	// and is a perfectly ordinary address.
	test.each([
		"https://alice:hunter2@host/sse",
		"https://alice@host/x",
		"https://:hunter2@host/x",
		"HTTPS://alice:hunter2@host/",
		"https://a%40b:p%40ss@host/",
		"https://alice:hunter2@host:8443/sse",
		"https://alice:hunter2@[::1]:8080/x",
	])("%s carries one", (url) => {
		expect(urlCredentialProblem(url)).not.toBeNull();
	});

	// Every one of these is unparseable, and every one of them carries the
	// credential anyway. "The parser rejected it" is not "it is safe" — this is
	// the block the `new URL` version got wrong.
	test.each([
		["//alice:hunter2@host/sse", "scheme-relative"],
		["alice:hunter2@host/sse", "scheme dropped from a pasted URL"],
		["https://alice:hunter2@ho st/sse", "a space in the host"],
		["https://alice:hunter2@host:99999999/x", "a port above 65535"],
		["https://user:pass@[bad/x", "an unclosed bracket"],
		["https://alice:hunter2@host\n/sse", "a newline in the middle"],
		["file://user:pass@/C:/x", "a scheme with no host at all"],
	])("%s carries one (%s)", (url) => {
		expect(urlCredentialProblem(url)).not.toBeNull();
	});

	test.each(["https://host/mcp", "https://host/path@thing", "https://host/mcp?a@b=c", "http://host/a@b/c"])(
		"%s does not",
		(url) => {
			expect(urlCredentialProblem(url)).toBeNull();
		},
	);
});

describe("parameter names", () => {
	// The spellings a user actually pastes. The first four are the same credential
	// four ways, and an earlier version caught three of them and let the lowercase
	// run-together one through.
	test.each([
		"https://host/mcp?access_token=x",
		"https://host/mcp?api_key=x",
		"https://host/mcp?apikey=x",
		"https://host/mcp?accessToken=x",
		"https://host/mcp?accesstoken=x",
		"https://host/mcp?AccessToken=x",
		"https://host/mcp?client_secret=x",
		"https://host/mcp?clientsecret=x",
		"https://host/mcp?X-Amz-Signature=x",
		"https://host/mcp?sig=x",
		"https://host/mcp?auth=x",
		"https://host/mcp?jwt=x",
		"https://host/mcp?bearer=x",
	])("%s carries one", (url) => {
		expect(urlCredentialProblem(url)).not.toBeNull();
	});

	// Position, separator, encoding and the empty cases. A name is a name whether
	// or not anything follows the `=`.
	test.each([
		"https://host/mcp?a=1&access_token=x",
		"https://host/mcp?a=1;access_token=x",
		"https://host/mcp?access_token",
		"https://host/mcp?access_token=",
		"https://host/mcp?access%5Ftoken=x",
		"https://host/mcp?access+token=x",
		"notaurl?access_token=x",
	])("%s carries one", (url) => {
		expect(urlCredentialProblem(url)).not.toBeNull();
	});

	// The fragment. Nothing here is ever transmitted, so none of it authenticates
	// anything — and all of it lands in a file the user may share.
	test.each(["https://host/mcp#access_token=x", "https://host/mcp?a=1#x=1&sig=k"])("%s carries one", (url) => {
		expect(urlCredentialProblem(url)).not.toBeNull();
	});

	// A credential word used as an *adjective* is not a credential, and taking
	// these three back is what the "last segment" rule buys.
	test.each([
		"https://host/mcp?key_count=3",
		"https://host/mcp?token_type=bearer",
		"https://host/mcp?signature_version=4",
		"https://host/mcp?max_keys=10",
	])("%s does not", (url) => {
		expect(urlCredentialProblem(url)).toBeNull();
	});

	// The substring trap. `KEY` is a substring of all five and a credential of
	// none of them.
	test.each([
		"https://host/mcp?monkey=1",
		"https://host/mcp?keyboard=layout",
		"https://host/mcp?turkey=",
		"https://host/mcp?hockey=1",
		"https://host/mcp?keynote=abc",
	])("%s does not", (url) => {
		expect(urlCredentialProblem(url)).toBeNull();
	});

	// Plurals and derivations are different segments.
	test.each(["https://host/mcp?keys=1", "https://host/mcp?tokens=1", "https://host/mcp?tokenize=1"])(
		"%s does not",
		(url) => {
			expect(urlCredentialProblem(url)).toBeNull();
		},
	);

	test.each(["https://host/mcp", "https://host/mcp?a=1&b=2", "https://host/keys/abc", "https://host/mcp?x[y]=1", ""])(
		"%s does not",
		(url) => {
			expect(urlCredentialProblem(url)).toBeNull();
		},
	);
});

describe("the cases it over-flags on purpose", () => {
	// There is no way to tell these from `access_token` by name alone, and the
	// two errors are not symmetric: over-flagging costs a user one server and
	// prints a line saying which one and why, while under-flagging writes a token
	// into `.mcp.json` under a report that denies there is one. These rows are
	// here so that anyone who disagrees with the trade has to look at it.
	test.each([
		"https://host/mcp?sortKey=updatedAt",
		"https://host/mcp?public_key=abc",
		"https://host/mcp?hasToken=false",
		"https://host/mcp?auth=none",
		"https://host/mcp?key=value",
	])("%s is flagged even though it need not be", (url) => {
		expect(urlCredentialProblem(url)).not.toBeNull();
	});
});

describe("what it is allowed to say", () => {
	// The reason goes in a report line the user reads, so it can describe the
	// shape and never the value. Every one of these strings is a constant.
	test.each(["https://alice:hunter2@host/sse", "https://host/mcp?access_token=SUPERSECRETVALUE"])(
		"%s names the shape without repeating it",
		(url) => {
			const problem = urlCredentialProblem(url);
			expect(problem).not.toBeNull();
			expect(problem).not.toContain("hunter2");
			expect(problem).not.toContain("SUPERSECRETVALUE");
			expect(problem).not.toContain("alice");
			expect(problem).not.toContain("host");
			expect(problem?.length).toBeLessThan(80);
		},
	);

	// A userinfo hit with no password, and one with no username, must not claim a
	// password is there. An earlier fixed phrase said "a username and password"
	// for both.
	expect(urlCredentialProblem("https://alice@host/x")).not.toContain("password@host");
	expect(urlCredentialProblem("https://alice:hunter2@host/sse")).not.toContain("hunter2");
});
