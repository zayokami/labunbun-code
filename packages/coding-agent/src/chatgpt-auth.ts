/**
 * Where the ChatGPT subscription's credential lives on this machine.
 *
 * The same keychain-first shape as the Claude store, and the same fallback: a
 * 0600 file under `~/.labunbun` when no secret service answers, said out loud
 * once. The file has its own name — the Claude store's generic
 * `.credentials.json` predates the second subscription, and one file for both
 * logins would let the two disagree about which token is current.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type ChatGptCredentialStore,
	type ChatGptOAuthCredential,
	type ChatGptTokenProvider,
	createChatGptTokenProvider,
} from "@labunbun/ai";
import type { KeychainLike } from "./keychain.ts";

/** The keychain entry. One account per process, so one named entry. */
export const CHATGPT_SUBSCRIPTION_KEYCHAIN = { service: "labunbun", name: "chatgpt-subscription" } as const;

export type { KeychainLike };

export interface ChatGptAuthOptions {
	/** The directory user state lives under; defaults to the real home. */
	home?: string;
	/**
	 * The keychain to use. `undefined` means "the system's, if it has one";
	 * `null` means none at all. A test passes `null` — and must — because a
	 * test that reached the real keychain would clear the sign-in of the
	 * machine it runs on, which is indistinguishable from working code.
	 */
	keychain?: KeychainLike | null;
	/** Where the one-time fallback warning goes. Defaults to stderr. */
	warn?: (message: string) => void;
}

function systemKeychain(): KeychainLike | null {
	const secrets = (globalThis as { Bun?: { secrets?: KeychainLike } }).Bun?.secrets;
	return secrets && typeof secrets.get === "function" ? secrets : null;
}

// Long-form design notes: docs/dev/chatgpt-subscription.md
/**
 * The file-backed store, keychain-first.
 *
 * Load reads the keychain, and falls through to the file when the keychain
 * has nothing or cannot answer; save writes the keychain and removes any file
 * from an earlier fallback era, so the two can never disagree about which
 * token is current. Clear empties both, because a sign-out that leaves one
 * copy behind is not a sign-out.
 */
export function createChatGptCredentialStore(options: ChatGptAuthOptions = {}): ChatGptCredentialStore {
	const home = options.home ?? homedir();
	const filePath = join(home, ".labunbun", ".chatgpt-credentials.json");
	const warn = options.warn ?? ((message: string) => console.error(message));
	const keychain = options.keychain === undefined ? systemKeychain() : options.keychain;
	let warned = false;

	function fallback(message: string): void {
		if (warned) return;
		warned = true;
		warn(message);
	}

	function removeFile(): void {
		try {
			unlinkSync(filePath);
		} catch {
			// Already gone.
		}
	}

	function readFile(): ChatGptOAuthCredential | null {
		try {
			return JSON.parse(readFileSync(filePath, "utf8")) as ChatGptOAuthCredential;
		} catch {
			// Missing and malformed are the same answer: not signed in. The file
			// stays in place, because it is the user's to repair.
			return null;
		}
	}

	function writeFile(credential: ChatGptOAuthCredential): void {
		mkdirSync(dirname(filePath), { recursive: true });
		const tmp = `${filePath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
		try {
			// Windows has no file modes and this is a no-op there. On POSIX it also
			// repairs a pre-existing file the umask made wider. Best effort by
			// design: a store that refused to save because of a chmod would be a
			// store that cannot sign in.
			chmodSync(tmp, 0o600);
		} catch {
			// The mode was set at creation; nothing more to do.
		}
		// Rename rather than write in place, so a reader never sees half a token.
		renameSync(tmp, filePath);
	}

	return {
		async load() {
			if (keychain) {
				try {
					const raw = await keychain.get(CHATGPT_SUBSCRIPTION_KEYCHAIN);
					if (raw !== null) {
						try {
							return JSON.parse(raw) as ChatGptOAuthCredential;
						} catch {
							return null;
						}
					}
				} catch {
					// A keychain that cannot answer is the same as none here; the file
					// below may still hold a sign-in from a machine without one.
				}
			}
			return readFile();
		},
		async save(credential) {
			if (keychain) {
				try {
					await keychain.set({ ...CHATGPT_SUBSCRIPTION_KEYCHAIN, value: JSON.stringify(credential) });
					// A file from an earlier fallback era would otherwise hold an older
					// token than the one just stored.
					removeFile();
					return;
				} catch {
					fallback(
						`labunbun: the OS keychain refused the ChatGPT credential; storing it in ${filePath} (mode 0600) instead.`,
					);
				}
			} else {
				fallback(`labunbun: no OS keychain here; the ChatGPT credential lives in ${filePath} (mode 0600).`);
			}
			writeFile(credential);
		},
		async clear() {
			if (keychain) {
				try {
					await keychain.delete(CHATGPT_SUBSCRIPTION_KEYCHAIN);
				} catch {
					// Nothing to delete is not a failure.
				}
			}
			removeFile();
		},
	};
}

/** The provider the app hands its transports: mint from the store above. */
export function createChatGptCredentials(options: ChatGptAuthOptions = {}): ChatGptTokenProvider {
	return createChatGptTokenProvider(createChatGptCredentialStore(options));
}
