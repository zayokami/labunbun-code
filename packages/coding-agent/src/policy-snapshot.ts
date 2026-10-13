/**
 * The permission policy, kept in the session file.
 *
 * A rule granted from the dialog ("don't ask again") used to live in an array in
 * `interactive.ts`'s closure and nowhere else, so it died with the process: the
 * user answered a question, and a restart asked it again. The same was true of
 * the mode axes — a `/mode plan` or a Shift+Tab was gone by the next `--resume`,
 * which re-derived both axes from flags and settings as if the session had never
 * said otherwise. The user's expectation is the other one: the conversation is
 * still the conversation, so what they told it still holds.
 *
 * What is recorded is a snapshot, not an edit log, exactly as with the task list
 * (`task-snapshot.ts`): the policy is small, the newest snapshot *is* the policy,
 * and a file whose last line was lost mid-append resumes under the snapshot
 * before it rather than under half an update.
 *
 * The rules are stored without their `source`, because they all have the same
 * one: what a session file holds is what this session's user granted. They are
 * read back as `source: "session"` for that reason — a restored grant has to be
 * the *same* grant, or the `/permissions` list would say a user-settings rule was
 * answering when no settings file ever held it.
 *
 * Not here, deliberately: a log of per-call decisions (what was asked, what was
 * answered, when). That is an audit trail with a different lifecycle and a much
 * larger volume, and it is Wave 2.
 */
import {
	type ModeChoice,
	NETWORK_DOMAIN_PERMISSIONS,
	NETWORK_SANDBOX_POLICIES,
	type NetworkAxis,
	PERMISSION_MODES,
	type PermissionMode,
	type PermissionRule,
	SANDBOX_MODES,
	type SandboxMode,
	type SessionStore,
} from "@labunbun/agent";

/** The `custom` entry kind the policy is saved under. On disk, so it is fixed. */
export const POLICY_SNAPSHOT_KIND = "policy";

/**
 * One rule as the file holds it: the two fields that decide matching, and its
 * behavior. `source` is left out on purpose — see this file's header.
 */
export interface StoredPolicyRule {
	toolName: string;
	/** Raw specifier inside `Tool(...)`; absent = bare tool rule. */
	specifier?: string;
	/**
	 * Which verdict the rule stands for. The type mirrors the engine's, `ask`
	 * included: a session that answers with a rule is holding a policy, and the
	 * file is where a policy survives a restart.
	 */
	behavior: PermissionRule["behavior"];
}

export interface PolicySnapshot {
	/** When the snapshot was taken, in epoch milliseconds. */
	at: number;
	rules: StoredPolicyRule[];
	mode: PermissionMode;
	sandbox: SandboxMode;
	network: NetworkAxis;
}

/** The rules as the file holds them. */
export function storedRules(rules: ReadonlyArray<PermissionRule>): StoredPolicyRule[] {
	return rules.map((rule) =>
		rule.specifier === undefined
			? { toolName: rule.toolName, behavior: rule.behavior }
			: { toolName: rule.toolName, specifier: rule.specifier, behavior: rule.behavior },
	);
}

/**
 * The rules as the engine reads them. Every one of them is `session`: a rule
 * that came out of this file was granted in this session, whatever the session
 * was called at the time.
 */
export function sessionRulesFrom(stored: ReadonlyArray<StoredPolicyRule>): PermissionRule[] {
	return stored.map((rule) => ({ ...rule, source: "session" as const }));
}

/**
 * Whether two snapshots say the same thing about the policy.
 *
 * `at` is left out: it is the record that the snapshot was taken, not part of
 * the policy, and comparing it would make every comparison false and every turn
 * a write.
 */
export function samePolicy(a: PolicySnapshot | undefined, b: PolicySnapshot | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return (
		a.mode === b.mode &&
		a.sandbox === b.sandbox &&
		a.network.access === b.network.access &&
		JSON.stringify(a.network.domains) === JSON.stringify(b.network.domains) &&
		JSON.stringify(a.rules) === JSON.stringify(b.rules)
	);
}

/**
 * The policy the session last held, or undefined when it never held one.
 *
 * Read off the active chain, so a policy abandoned by a branch is not
 * resurrected. A compaction is the reason the app re-saves rather than a reason
 * this reads any other way: the boundary hangs off the chain's root, which takes
 * the snapshots above it out of the walk, and `interactive.ts` puts the snapshot
 * back when a pass ends.
 */
export function readPolicySnapshot(session: SessionStore): PolicySnapshot | undefined {
	const entries = session.linearEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.kind !== POLICY_SNAPSHOT_KIND) continue;
		if (isPolicySnapshot(entry.data)) return entry.data;
	}
	return undefined;
}

/**
 * Make the session's active chain end holding the policy as it stands.
 *
 * Best effort, like the writes themselves and for the same reason the task list
 * swallows there: a session file that cannot be appended to must not fail the
 * turn the user is in the middle of. The cost of a lost snapshot is a grant that
 * is asked for again next time.
 */
export function savePolicySnapshot(session: SessionStore | undefined, next: PolicySnapshot): void {
	if (!session) return;
	if (samePolicy(readPolicySnapshot(session), next)) return;
	try {
		session.appendCustom(POLICY_SNAPSHOT_KIND, next);
	} catch {
		// Nothing to do about it: the ask the user just answered is not the file.
	}
}

/**
 * The three axes a session starts under, from the four sources that can claim
 * them, in the order the user would expect:
 *
 *   1. the flag or startup picker entry, because a run that names a mode means
 *      it for this run;
 *   2. the session's own snapshot, because the conversation was told this and is
 *      still the same conversation;
 *   3. settings, which is the standing answer for a session that has never said;
 *   4. the default row.
 *
 * Per axis, not per pair. `--permission-mode plan` names the mode and nothing
 * else, and the sandbox it runs under is the one the session recorded (or the
 * one settings carry) — which is what the resolution did before sessions
 * recorded anything, with one source inserted in the middle.
 *
 * `danger-full-access` is not exempt: widening the sandbox without naming it is
 * exactly the change a snapshot exists to remember.
 */
export function resolveStartupAxes(input: {
	/** The startup picker's row, when one was named. Sets both axes at once. */
	choice?: Pick<ModeChoice, "mode" | "sandbox">;
	flagMode?: PermissionMode;
	flagSandbox?: SandboxMode;
	policy?: Pick<PolicySnapshot, "mode" | "sandbox" | "network">;
	settingsMode?: PermissionMode;
	settingsSandbox?: SandboxMode;
	settingsNetwork: NetworkAxis;
	fallback: Pick<ModeChoice, "mode" | "sandbox">;
}): { mode: PermissionMode; sandbox: SandboxMode; network: NetworkAxis } {
	return {
		mode: input.choice?.mode ?? input.flagMode ?? input.policy?.mode ?? input.settingsMode ?? input.fallback.mode,
		sandbox:
			input.choice?.sandbox ??
			input.flagSandbox ??
			input.policy?.sandbox ??
			input.settingsSandbox ??
			input.fallback.sandbox,
		// No flag names this axis: it is a settings key, and a session that
		// recorded one outranks it for the same reason the other two do.
		network: input.policy?.network ?? input.settingsNetwork,
	};
}

/**
 * A snapshot is data read back from a file, so it is checked rather than trusted.
 *
 * A mode this build does not know would reach `evaluatePermissions` as a string
 * that matches none of its branches, and the axes are worse than the rules that
 * way: a bad rule is skipped by the matcher, while a bad mode decides every
 * undecided call. The network domain table is checked for the same reason the
 * settings parser checks it — a table whose entries have no `permission` key is
 * a table that would answer every host with `undefined`.
 */
function isPolicySnapshot(value: unknown): value is PolicySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<PolicySnapshot>;
	if (typeof candidate.at !== "number") return false;
	if (!(PERMISSION_MODES as readonly string[]).includes(candidate.mode as string)) return false;
	if (!(SANDBOX_MODES as readonly string[]).includes(candidate.sandbox as string)) return false;
	if (!isNetworkAxis(candidate.network)) return false;
	return Array.isArray(candidate.rules) && candidate.rules.every(isStoredRule);
}

function isNetworkAxis(value: unknown): value is NetworkAxis {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<NetworkAxis>;
	if (!(NETWORK_SANDBOX_POLICIES as readonly string[]).includes(candidate.access as string)) return false;
	if (!Array.isArray(candidate.domains)) return false;
	return candidate.domains.every((rule) => {
		if (typeof rule !== "object" || rule === null) return false;
		const { pattern, permission } = rule as { pattern?: unknown; permission?: unknown };
		return (
			typeof pattern === "string" && (NETWORK_DOMAIN_PERMISSIONS as readonly string[]).includes(permission as string)
		);
	});
}

function isStoredRule(value: unknown): value is StoredPolicyRule {
	if (typeof value !== "object" || value === null) return false;
	const rule = value as Partial<StoredPolicyRule>;
	if (typeof rule.toolName !== "string" || rule.toolName.length === 0) return false;
	if (rule.behavior !== "allow" && rule.behavior !== "deny") return false;
	return rule.specifier === undefined || typeof rule.specifier === "string";
}
