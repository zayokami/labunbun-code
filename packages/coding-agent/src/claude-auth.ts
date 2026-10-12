/**
 * Where the Claude subscription's credential lives on this machine.
 *
 * The OS keychain is the first choice: `Bun.secrets` reaches the Windows
 * Credential Manager, the macOS keychain, and libsecret on Linux. A machine
 * without a secret service — a container, a CI runner — falls back to a 0600
 * file under `~/.labunbun`, and the fallback says so once, because a fallback
 * nobody is told about is a fallback the user believes is a keychain.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type ClaudeCredentialStore,
	type ClaudeOAuthCredential,
	type ClaudeTokenProvider,
	createClaudeTokenProvider,
} from "@labunbun/ai";

/** The keychain entry. One account per process, so one named entry. */
export const CLAUDE_SUBSCRIPTION_KEYCHAIN = { service: "labunbun", name: "claude-subscription" } as const;

/** The three calls the store needs. `Bun.secrets` matches this shape. */
export interface KeychainLike {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string; value: string }): Promise<void>;
	delete(options: { service: string; name: string }): Promise<boolean>;
}

export interface ClaudeAuthOptions {
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

/**
 * The file-backed store, keychain-first.
 *
 * Load reads the keychain, and falls through to the file when the keychain
 * has nothing or cannot answer; save writes the keychain and removes any file
 * from an earlier fallback era, so the two can never disagree about which
 * token is current. Clear empties both, because a sign-out that leaves one
 * copy behind is not a sign-out.
 */
export function createClaudeCredentialStore(options: ClaudeAuthOptions = {}): ClaudeCredentialStore {
	const home = options.home ?? homedir();
	const filePath = join(home, ".labunbun", ".credentials.json");
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

	function readFile(): ClaudeOAuthCredential | null {
		try {
			return JSON.parse(readFileSync(filePath, "utf8")) as ClaudeOAuthCredential;
		} catch {
			// Missing and malformed are the same answer: not signed in. The file
			// stays in place, because it is the user's to repair.
			return null;
		}
	}

	function writeFile(credential: ClaudeOAuthCredential): void {
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
					const raw = await keychain.get(CLAUDE_SUBSCRIPTION_KEYCHAIN);
					if (raw !== null) {
						try {
							return JSON.parse(raw) as ClaudeOAuthCredential;
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
					await keychain.set({ ...CLAUDE_SUBSCRIPTION_KEYCHAIN, value: JSON.stringify(credential) });
					// A file from an earlier fallback era would otherwise hold an older
					// token than the one just stored.
					removeFile();
					return;
				} catch {
					fallback(
						`labunbun: the OS keychain refused the Claude credential; storing it in ${filePath} (mode 0600) instead.`,
					);
				}
			} else {
				fallback(`labunbun: no OS keychain here; the Claude credential lives in ${filePath} (mode 0600).`);
			}
			writeFile(credential);
		},
		async clear() {
			if (keychain) {
				try {
					await keychain.delete(CLAUDE_SUBSCRIPTION_KEYCHAIN);
				} catch {
					// Nothing to delete is not a failure.
				}
			}
			removeFile();
		},
	};
}

/** The provider the app hands its transports: mint from the store above. */
export function createClaudeCredentials(options: ClaudeAuthOptions = {}): ClaudeTokenProvider {
	return createClaudeTokenProvider(createClaudeCredentialStore(options));
}
