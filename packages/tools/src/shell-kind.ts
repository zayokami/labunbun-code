/**
 * Which grammar a shell speaks, read off its executable name.
 *
 * The tools that hand a command to a shell need the answer twice: the Bash
 * tool writes its instructions for the model in the shell's own syntax, and the
 * Windows container probe writes a script in it. The name is the only fact both
 * sites have, so the mapping lives here rather than in either of them.
 */
export type ShellKind = "powershell" | "bash" | "cmd";

/** The kind for a resolved program path, from the executable's own name. */
export function shellKindOf(program: string): ShellKind {
	const name = (program.split(/[\\/]/).pop() ?? "").toLowerCase();
	if (name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe") {
		return "powershell";
	}
	if (name === "cmd" || name === "cmd.exe") return "cmd";
	return "bash";
}
