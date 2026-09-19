/**
 * The three answers an approval dialog offers, named for what each one actually
 * does.
 *
 * "Always allow" is the dangerous one: what it grants depends on the tool, and
 * the old label ("don't ask again for Bash") described a rule far wider than the
 * command the user was looking at. Each option now says the scope it applies to,
 * and says "(this session)" because that is the truth — the rule lives in memory
 * only, and approving a command never edits the user's settings file.
 *
 * Pure, so the labels and the specifier they correspond to can be asserted
 * together: a label that names a prefix the rule does not actually grant is the
 * one failure mode worth testing for.
 */
import { relative, resolve } from "node:path";

export interface PermissionOption {
	label: string;
	allow: boolean;
	alwaysAllow: boolean;
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

export function alwaysAllowLabel(toolName: string, input: unknown, cwd?: string): string {
	const specifier = ruleSpecifierFor(toolName, input, cwd);
	if (specifier === undefined) return `Yes, and don't ask again for ${toolName} (this session)`;
	if (toolName === "Bash") {
		if (specifier === "*") return "Yes, and don't ask again for any command (this session)";
		// A single-word command keeps the bare word: there is no prefix to widen,
		// so promising one would overstate what the rule covers.
		if (!specifier.endsWith(" *")) return `Yes, and don't ask again for \`${specifier}\` (this session)`;
		return `Yes, and don't ask again for commands starting with \`${specifier.slice(0, -2)} \` (this session)`;
	}
	return `Yes, and don't ask again for files under \`${specifier.slice(0, -3)}/\` (this session)`;
}

export function permissionOptions(toolName: string, input: unknown, cwd?: string): PermissionOption[] {
	return [
		{ label: "Yes, just this once", allow: true, alwaysAllow: false },
		{ label: alwaysAllowLabel(toolName, input, cwd), allow: true, alwaysAllow: true },
		{ label: "No, and tell the model what to do differently", allow: false, alwaysAllow: false },
	];
}
