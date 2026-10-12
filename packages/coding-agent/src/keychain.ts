/**
 * The three calls a credential store needs from an OS keychain. `Bun.secrets`
 * matches this shape; a store's tests pass a fake — never the real one, which
 * on a real machine is the operator's own credential database.
 */
export interface KeychainLike {
	get(options: { service: string; name: string }): Promise<string | null>;
	set(options: { service: string; name: string; value: string }): Promise<void>;
	delete(options: { service: string; name: string }): Promise<boolean>;
}
