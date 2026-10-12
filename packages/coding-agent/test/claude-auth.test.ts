/**
 * The credential store: keychain first, file as the fallback.
 *
 * The keychain is injected in every test here, and never probed. `Bun.secrets`
 * on a real machine reaches the operator's own credential database, and a test
 * that cleared the entry "labunbun" / "claude-subscription" would delete a
 * real sign-in — which, from the test runner's point of view, is
 * indistinguishable from working code.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeOAuthCredential } from "@labunbun/ai";
import { createClaudeCredentialStore, type KeychainLike } from "../src/claude-auth.ts";

function makeHome(): { home: string; clean: () => void } {
	const home = mkdtempSync(join(tmpdir(), "lbb-claude-auth-"));
	return { home, clean: () => rmSync(home, { recursive: true, force: true }) };
}

function credential(overrides: Partial<ClaudeOAuthCredential> = {}): ClaudeOAuthCredential {
	return {
		accessToken: "access-1",
		refreshToken: "refresh-1",
		expiresAt: 1_000,
		refreshTokenExpiresAt: 2_000,
		scopes: ["user:inference"],
		clientId: "client-1",
		accountEmail: "user@example.com",
		...overrides,
	};
}

function filePathOf(home: string): string {
	return join(home, ".labunbun", ".credentials.json");
}

function writeFile(home: string, value: unknown): string {
	const filePath = filePathOf(home);
	mkdirSync(join(home, ".labunbun"), { recursive: true });
	writeFileSync(filePath, JSON.stringify(value));
	return filePath;
}

interface FakeKeychain extends KeychainLike {
	entries: Map<string, string>;
	calls: string[];
}

function fakeKeychain(
	seed?: ClaudeOAuthCredential,
	behavior: { failGet?: boolean; failSet?: boolean; failDelete?: boolean } = {},
): FakeKeychain {
	const key = "labunbun:claude-subscription";
	const entries = new Map<string, string>();
	if (seed) entries.set(key, JSON.stringify(seed));
	const calls: string[] = [];
	return {
		entries,
		calls,
		async get() {
			calls.push("get");
			if (behavior.failGet) throw new Error("keychain unavailable");
			return entries.get(key) ?? null;
		},
		async set(options) {
			calls.push("set");
			if (behavior.failSet) throw new Error("keychain refused");
			entries.set(`${options.service}:${options.name}`, options.value);
		},
		async delete() {
			calls.push("delete");
			if (behavior.failDelete) throw new Error("keychain refused");
			return entries.delete(key);
		},
	};
}

describe("createClaudeCredentialStore", () => {
	test("load prefers the keychain over a file from an earlier fallback era", async () => {
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const store = createClaudeCredentialStore({
				home,
				keychain: fakeKeychain(credential({ accessToken: "from-keychain" })),
			});
			expect((await store.load())?.accessToken).toBe("from-keychain");
		} finally {
			clean();
		}
	});

	test("load falls back to the file when the keychain has no entry", async () => {
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const store = createClaudeCredentialStore({ home, keychain: fakeKeychain() });
			expect((await store.load())?.accessToken).toBe("from-file");
		} finally {
			clean();
		}
	});

	test("load falls back to the file when the keychain throws", async () => {
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const store = createClaudeCredentialStore({ home, keychain: fakeKeychain(undefined, { failGet: true }) });
			expect((await store.load())?.accessToken).toBe("from-file");
		} finally {
			clean();
		}
	});

	test("load answers null when nothing is stored, and for malformed content", async () => {
		const { home, clean } = makeHome();
		try {
			expect(await createClaudeCredentialStore({ home, keychain: fakeKeychain() }).load()).toBeNull();
			mkdirSync(join(home, ".labunbun"), { recursive: true });
			writeFileSync(filePathOf(home), "{not json");
			const store = createClaudeCredentialStore({ home, keychain: fakeKeychain() });
			expect(await store.load()).toBeNull();
		} finally {
			clean();
		}
	});

	test("a malformed keychain entry is null and does NOT fall through to the file", async () => {
		// The two stores are one credential, so when the keychain holds an entry
		// the answer comes from it alone. Falling back here would serve a token
		// the keychain replaced, from a source nobody looks at.
		const { home, clean } = makeHome();
		try {
			writeFile(home, credential({ accessToken: "from-file" }));
			const keychain = fakeKeychain();
			keychain.entries.set("labunbun:claude-subscription", "{not json");
			const store = createClaudeCredentialStore({ home, keychain });
			expect(await store.load()).toBeNull();
		} finally {
			clean();
		}
	});

	test("save writes the keychain and removes a file left by an earlier fallback", async () => {
		const { home, clean } = makeHome();
		try {
			const filePath = writeFile(home, credential({ accessToken: "stale" }));
			const keychain = fakeKeychain();
			const warnings: string[] = [];
			const store = createClaudeCredentialStore({ home, keychain, warn: (m) => warnings.push(m) });
			await store.save(credential({ accessToken: "fresh" }));
			expect(JSON.parse(keychain.entries.get("labunbun:claude-subscription") ?? "{}").accessToken).toBe("fresh");
			expect(existsSync(filePath)).toBe(false);
			expect(warnings).toEqual([]);
		} finally {
			clean();
		}
	});

	test("save without a keychain warns once and writes a file only the user can read", async () => {
		const { home, clean } = makeHome();
		try {
			const warnings: string[] = [];
			const store = createClaudeCredentialStore({ home, keychain: null, warn: (m) => warnings.push(m) });
			await store.save(credential({ accessToken: "first" }));
			await store.save(credential({ accessToken: "second" }));
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain(".credentials.json");
			expect(JSON.parse(readFileSync(filePathOf(home), "utf8")).accessToken).toBe("second");
			if (process.platform !== "win32") {
				// Windows has no file modes; the check would pass vacuously there.
				expect(statSync(filePathOf(home)).mode & 0o777).toBe(0o600);
			}
		} finally {
			clean();
		}
	});

	test("a keychain that refuses on save falls back to the file with one warning", async () => {
		const { home, clean } = makeHome();
		try {
			const warnings: string[] = [];
			const store = createClaudeCredentialStore({
				home,
				keychain: fakeKeychain(undefined, { failSet: true }),
				warn: (m) => warnings.push(m),
			});
			await store.save(credential({ accessToken: "saved" }));
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain("keychain refused");
			expect(JSON.parse(readFileSync(filePathOf(home), "utf8")).accessToken).toBe("saved");
		} finally {
			clean();
		}
	});

	test("clear empties the keychain and the file", async () => {
		const { home, clean } = makeHome();
		try {
			const filePath = writeFile(home, credential());
			const keychain = fakeKeychain(credential());
			const store = createClaudeCredentialStore({ home, keychain });
			await store.clear();
			expect(keychain.entries.size).toBe(0);
			expect(existsSync(filePath)).toBe(false);
		} finally {
			clean();
		}
	});

	test("clear survives a keychain that refuses to delete", async () => {
		const { home, clean } = makeHome();
		try {
			const filePath = writeFile(home, credential());
			const store = createClaudeCredentialStore({ home, keychain: fakeKeychain(credential(), { failDelete: true }) });
			await store.clear();
			expect(existsSync(filePath)).toBe(false);
		} finally {
			clean();
		}
	});
});
