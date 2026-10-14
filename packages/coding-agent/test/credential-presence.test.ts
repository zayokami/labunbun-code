/**
 * The machine-availability rule: the sync mirror of the request path's
 * credential check, the wording it drives on rows and in the startup notice,
 * and the store probe behind both.
 *
 * No test here may touch the real keychain — see claude-auth.ts: a probe that
 * read it would report the sign-in of whoever runs the tests, which is a
 * different fact than whether the code works. Every store below is reached
 * through the 0600 file fallback under a throwaway home, with `keychain: null`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAUX_MODEL, type Model } from "@labunbun/ai";
import {
	detectSubscriptionSignIns,
	missingCredentialNotice,
	modelMayRun,
	NO_SIGN_INS,
	requestPathPermits,
	type SubscriptionSignIns,
	unrunnableSuffix,
} from "../src/credential-presence.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
	const home = mkdtempSync(join(tmpdir(), "lbb-credential-"));
	roots.push(home);
	return home;
}

function testModel(overrides: Partial<Model> = {}): Model {
	return { ...FAUX_MODEL, ...overrides };
}

/** A model on the anthropic wire with no key: the row subscriptions exist for. */
const anthropicRow = testModel({ provider: "anthropic", id: "claude-sonnet-5" });
/** A wire that is subscription or nothing, and names no variable by construction. */
const chatgptRow = testModel({ provider: "chatgpt", id: "gpt-5.6", api: "chatgpt-responses", apiKeyEnv: undefined });
/** An ordinary env-keyed row on a provider with no subscription. */
const envRow = testModel({ id: "env-row", apiKeyEnv: "CREDENTIAL_TEST_KEY" });
/** The local daemon's shape: no variable named at all. */
const keylessRow = testModel({ id: "keyless", apiKeyEnv: undefined });

function signIns(overrides: Partial<SubscriptionSignIns> = {}): SubscriptionSignIns {
	return { claude: false, chatgpt: false, ...overrides };
}

describe("modelMayRun", () => {
	test("an env-keyed row runs exactly when its variable is set", () => {
		expect(modelMayRun(envRow, NO_SIGN_INS)).toBe(false);
		process.env.CREDENTIAL_TEST_KEY = "cr-test";
		try {
			expect(modelMayRun(envRow, NO_SIGN_INS)).toBe(true);
		} finally {
			delete process.env.CREDENTIAL_TEST_KEY;
		}
	});

	test("a row naming no variable runs without one — the local daemon", () => {
		expect(modelMayRun(keylessRow, NO_SIGN_INS)).toBe(true);
	});

	test("the anthropic wire runs on a Claude sign-in alone", () => {
		expect(modelMayRun(anthropicRow, NO_SIGN_INS)).toBe(false);
		expect(modelMayRun(anthropicRow, signIns({ claude: true }))).toBe(true);
		// The other subscription belongs to a different wire.
		expect(modelMayRun(anthropicRow, signIns({ chatgpt: true }))).toBe(false);
	});

	test("the ChatGPT wire runs on its sign-in alone", () => {
		expect(modelMayRun(chatgptRow, NO_SIGN_INS)).toBe(false);
		expect(modelMayRun(chatgptRow, signIns({ chatgpt: true }))).toBe(true);
		expect(modelMayRun(chatgptRow, signIns({ claude: true }))).toBe(false);
	});

	test("a sign-in does not leak onto other providers' rows", () => {
		expect(modelMayRun(envRow, signIns({ claude: true, chatgpt: true }))).toBe(false);
	});
});

describe("requestPathPermits", () => {
	test("the anthropic wire is let through on the subscription allowance alone", () => {
		// `anthropicRow` names FAUX_API_KEY, which no test sets — this is the
		// no-key machine, and the allowance (not the environment) is what lets
		// the row pass. Dropping the allowance turns this red; that is the bug
		// the guard at `/model` and the band's `canRunModel` both exist for.
		expect(requestPathPermits(anthropicRow)).toBe(true);
	});

	test("an env-keyed row on another provider needs its variable", () => {
		expect(requestPathPermits(envRow)).toBe(false);
		process.env.CREDENTIAL_TEST_KEY = "cr-test";
		try {
			expect(requestPathPermits(envRow)).toBe(true);
		} finally {
			delete process.env.CREDENTIAL_TEST_KEY;
		}
	});

	test("a row naming no variable is never refused", () => {
		expect(requestPathPermits(keylessRow)).toBe(true);
	});
});

describe("unrunnableSuffix", () => {
	test("the wording follows the wire, because the fix does", () => {
		expect(unrunnableSuffix(anthropicRow, NO_SIGN_INS)).toBe("no API key or sign-in");
		expect(unrunnableSuffix(chatgptRow, NO_SIGN_INS)).toBe("no ChatGPT sign-in");
		expect(unrunnableSuffix(envRow, NO_SIGN_INS)).toBe("no API key");
	});

	test("a row that can run carries no suffix", () => {
		expect(unrunnableSuffix(anthropicRow, signIns({ claude: true }))).toBeUndefined();
		expect(unrunnableSuffix(keylessRow, NO_SIGN_INS)).toBeUndefined();
	});
});

describe("missingCredentialNotice", () => {
	test("the anthropic default names /login and /yoshi", () => {
		expect(missingCredentialNotice(anthropicRow, NO_SIGN_INS)).toBe(
			"No credential for anthropic/claude-sonnet-5 yet — the first prompt will fail. /login to sign in, or /yoshi to import a setup.",
		);
	});

	test("the ChatGPT wire names the sign-in to ask for", () => {
		expect(missingCredentialNotice(chatgptRow, NO_SIGN_INS)).toContain("/login chatgpt to sign in");
	});

	test("an env row names the variable", () => {
		expect(missingCredentialNotice(envRow, NO_SIGN_INS)).toContain("Set CREDENTIAL_TEST_KEY in your environment");
	});

	test("a runnable model gets no notice", () => {
		expect(missingCredentialNotice(anthropicRow, signIns({ claude: true }))).toBeUndefined();
	});
});

describe("detectSubscriptionSignIns", () => {
	/** The file one store falls back to, written the way a saved sign-in leaves it. */
	function signInFile(home: string, name: string): void {
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", name), "{}\n");
	}

	test("an empty home reports both signed out", async () => {
		const home = makeHome();
		expect(await detectSubscriptionSignIns({ home, keychain: null })).toEqual({ claude: false, chatgpt: false });
	});

	test("each store answers for its own subscription", async () => {
		const home = makeHome();
		signInFile(home, ".credentials.json");
		expect(await detectSubscriptionSignIns({ home, keychain: null })).toEqual({ claude: true, chatgpt: false });
		signInFile(home, ".chatgpt-credentials.json");
		expect(await detectSubscriptionSignIns({ home, keychain: null })).toEqual({ claude: true, chatgpt: true });
	});

	test("a malformed file is not a sign-in", async () => {
		const home = makeHome();
		mkdirSync(join(home, ".labunbun"), { recursive: true });
		writeFileSync(join(home, ".labunbun", ".credentials.json"), "{not json");
		expect((await detectSubscriptionSignIns({ home, keychain: null })).claude).toBe(false);
	});
});
