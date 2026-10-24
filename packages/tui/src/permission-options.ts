/**
 * The four answers an approval dialog offers, named for what each one actually
 * does.
 *
 * "Always allow" is the dangerous one: what it grants depends on the tool, and
 * the old label ("don't ask again for Bash") described a rule far wider than the
 * command the user was looking at. Each option now says the scope it applies to,
 * and says "(this session)" because that is the truth — the rule lives in memory
 * only, and approving a command never edits the user's settings file.
 *
 * "Ask me every time" is the counterpart, and it exists because a grant is the
 * one answer the user cannot take back: for the rest of the session, nothing
 * re-opens a question that "don't ask again" closed. Answering with the
 * opposite — yes to this call, plus a rule that keeps the *next* match of the
 * same scope coming back to a person — is how a user spends an allowance while
 * keeping the question. Its label names the same scope as the grant, computed
 * from the same specifier, and the app layer records it the same way: a session
 * rule, which survives a resume (interactive.ts, policy-snapshot.ts).
 *
 * Pure, so the labels and the specifier they correspond to can be asserted
 * together: a label that names a prefix the rule does not actually grant is the
 * one failure mode worth testing for.
 */
import { relative, resolve } from "node:path";

/**
 * The answer to an approval request.
 *
 * Boolean is the whole vocabulary the queue used to speak, and every caller
 * that predates the feedback option still speaks it; the object form exists so
 * the fourth answer can be a denial with a sentence attached. Callers that only
 * need the decision read `allow`, and a boolean is normalized to that same
 * reading, so the two forms are interchangeable at every seat but the one that
 * forwards the message.
 */
export type PermissionReply =
	| boolean
	| { allow: boolean; alwaysAllow?: boolean; alwaysAsk?: boolean; message?: string };

/** The decision part of a reply, whichever form it arrived in. */
export function replyAllowed(reply: PermissionReply): boolean {
	return typeof reply === "boolean" ? reply : reply.allow;
}

/** The feedback a reply carries; empty and whitespace-only messages are not feedback. */
export function replyMessage(reply: PermissionReply): string | undefined {
	if (typeof reply === "boolean") return undefined;
	const message = reply.message?.trim();
	return message ? message : undefined;
}

/** How much of a denial's sentence reaches the tool result. */
export const MAX_DENIAL_MESSAGE_CHARS = 2000;

/**
 * The sentence a denial hands the model, bounded so a pasted essay cannot
 * crowd out the rest of the turn. The fallback is the wording every denial
 * used before the field existed, so the ordinary no reads the same.
 */
export function replyDenyMessage(reply: PermissionReply, fallback = "User denied permission"): string {
	const message = replyMessage(reply);
	return message ? message.slice(0, MAX_DENIAL_MESSAGE_CHARS) : fallback;
}

export interface PermissionOption {
	label: string;
	allow: boolean;
	alwaysAllow: boolean;
	/**
	 * Yes to this call, and a rule that keeps later matches of the same scope
	 * coming back to the dialog. Exclusive with `alwaysAllow`: one answer widens
	 * the session's policy and the other narrows it, and no answer does both.
	 */
	alwaysAsk: boolean;
	/**
	 * Choosing this option opens a text field, and what is typed rides back with
	 * the answer. The label already promised to tell the model what to do
	 * differently; this is the seat that makes the promise true.
	 */
	collectsFeedback?: true;
}

const FILE_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit"]);

/**
 * The specifier that would be granted for "don't ask again", or undefined when
 * the grant can only be the bare tool (which is what the dialog used to do for
 * everything).
 *
 * The grammar these feed is `inputMatchesSpecifier` (packages/agent): a Bash
 * specifier is a glob over the whole trimmed command line, and a file specifier
 * is a workspace-relative path glob.
 */
export function ruleSpecifierFor(toolName: string, input: unknown, cwd?: string): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	if (toolName === "Bash") return bashSpecifier(String(record.command ?? ""));
	if (FILE_TOOLS.has(toolName)) {
		return fileSpecifier(String(record.file_path ?? record.notebook_path ?? ""), cwd);
	}
	return undefined;
}

/**
 * `git status` → `git *`, never `git*`: the specifier is matched against the
 * whole command line, so `git*` would also cover `gitk` while `git ` covers only
 * commands whose first word is exactly `git`. A single-word command keeps the
 * bare word, since there is no prefix to widen.
 */
function bashSpecifier(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	const first = trimmed.split(/\s+/)[0];
	return first === trimmed ? first : `${first} *`;
}

/**
 * The directory the file lives in, as a workspace-relative glob. Undefined for a
 * file directly in the workspace root (there is no directory to scope to) and
 * for any path outside it (scoping by a `../` glob would be a lie about what the
 * rule covers).
 */
function fileSpecifier(filePath: string, cwd?: string): string | undefined {
	if (!cwd || !filePath) return undefined;
	const rel = relative(resolve(cwd), resolve(cwd, filePath)).replace(/\\/g, "/");
	if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
	const cut = rel.lastIndexOf("/");
	if (cut <= 0) return undefined;
	return `${rel.slice(0, cut)}/**`;
}

/**
 * What a standing answer covers, as a phrase both labels share: the grant and
 * the ask are opposites, but they name the same scope, and two parallel branch
 * trees would sooner or later disagree about it — which is the exact mismatch
 * these labels exist to prevent.
 */
function scopePhrase(toolName: string, input: unknown, cwd?: string): string {
	const specifier = ruleSpecifierFor(toolName, input, cwd);
	if (specifier === undefined) return `for ${toolName}`;
	if (toolName === "Bash") {
		if (specifier === "*") return "for any command";
		// A single-word command keeps the bare word: there is no prefix to widen,
		// so promising one would overstate what the rule covers.
		if (!specifier.endsWith(" *")) return `for \`${specifier}\``;
		return `for commands starting with \`${specifier.slice(0, -2)} \``;
	}
	return `for files under \`${specifier.slice(0, -3)}/\``;
}

export function alwaysAllowLabel(toolName: string, input: unknown, cwd?: string): string {
	return `Yes, and don't ask again ${scopePhrase(toolName, input, cwd)} (this session)`;
}

export function alwaysAskLabel(toolName: string, input: unknown, cwd?: string): string {
	return `Yes, and ask me every time ${scopePhrase(toolName, input, cwd)} (this session)`;
}

export function permissionOptions(toolName: string, input: unknown, cwd?: string): PermissionOption[] {
	// An escalated command runs outside the sandbox for this one call. A standing answer would promise a rule
	// the engine never consults for it, so the only answers are this call and no.
	const escalated =
		toolName === "Bash" &&
		typeof input === "object" &&
		input !== null &&
		(input as { escalate?: unknown }).escalate === true;
	if (escalated) {
		return [
			{ label: "Yes, run outside the sandbox, just this once", allow: true, alwaysAllow: false, alwaysAsk: false },
			{
				label: "No, and tell the model what to do differently",
				allow: false,
				alwaysAllow: false,
				alwaysAsk: false,
				collectsFeedback: true,
			},
		];
	}
	return [
		{ label: "Yes, just this once", allow: true, alwaysAllow: false, alwaysAsk: false },
		{ label: alwaysAllowLabel(toolName, input, cwd), allow: true, alwaysAllow: true, alwaysAsk: false },
		{ label: alwaysAskLabel(toolName, input, cwd), allow: true, alwaysAllow: false, alwaysAsk: true },
		{
			label: "No, and tell the model what to do differently",
			allow: false,
			alwaysAllow: false,
			alwaysAsk: false,
			collectsFeedback: true,
		},
	];
}
