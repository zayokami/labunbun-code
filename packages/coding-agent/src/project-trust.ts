/**
 * One-time trust for the definitions a repository ships.
 *
 * A project's `.labunbun/agents` markdown files and `.labunbun/skills` folders are read
 * into a session as if the user had written them: an agent definition becomes the
 * system prompt of every subagent spawned from it, and a skill becomes a slash
 * command whose expansion is sent to the model. Cloning a repository and opening
 * it was therefore enough to change what the model is told to be, with no user
 * action and nothing on screen to point at.
 *
 * Project-tier definitions now load only after this directory has been trusted
 * once, and the decision is remembered outside the working tree —
 * `~/.labunbun/projects/<slug>/trusted-definitions.json`, keyed with
 * `sanitizeCwd` exactly as SessionStore keys its sessions — for the reason MCP
 * approvals live there too: a ledger inside the repository is a file its author
 * can ship pre-approved. The user tier (`~/.labunbun/agents`,
 * `~/.labunbun/skills`) is not gated: it is the user's own, and it is where a
 * definition belongs when it should apply everywhere.
 *
 * What is remembered is the project, not the bytes of what was approved. A skill
 * edited after approval is trusted without being re-read — the same bound
 * `.mcp.json` has, and the reason `/agents` lists what is about to be loaded
 * rather than asking the user to approve a hash they cannot read.
 *
 * A refusal is not recorded anywhere. Declining is simply not calling
 * `approveProjectDefinitions`, so the definitions stay withheld and the notice
 * comes back on the next start — the question is asked again rather than the
 * answer being remembered, which is the same shape the MCP gate has.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeCwd } from "@labunbun/agent";

/** The two project tiers one trust decision covers, named as their directories are. */
export type DefinitionKind = "agents" | "skills";

/** Fixed order, so repeated approvals write the same bytes. */
const KINDS: DefinitionKind[] = ["agents", "skills"];

function trustStorePath(cwd: string, home: string): string {
	return join(home, ".labunbun", "projects", sanitizeCwd(cwd), "trusted-definitions.json");
}

/**
 * The kinds this directory has been trusted for; empty when the ledger is
 * missing, unreadable, or says something this build does not load.
 *
 * Fail-closed, and entry by entry: a hand-edited file naming a tier that does
 * not exist grants nothing for that entry instead of throwing where a session is
 * starting up, and an unparseable one grants nothing at all.
 */
export function loadTrustedDefinitionKinds(cwd: string, home: string = homedir()): Set<DefinitionKind> {
	try {
		const path = trustStorePath(cwd, home);
		if (!existsSync(path)) return new Set();
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { trustedDefinitionKinds?: unknown };
		const list = Array.isArray(parsed?.trustedDefinitionKinds) ? parsed.trustedDefinitionKinds : [];
		return new Set(list.filter((kind): kind is DefinitionKind => KINDS.includes(kind as DefinitionKind)));
	} catch {
		return new Set();
	}
}

/**
 * "2 agent definitions, 1 skill" — the withheld counts, phrased in one place.
 *
 * Three lines print these numbers (the REPL's startup notice, its confirmation
 * after an approval, and a `-p` run's stderr) and the pluralisation is the part
 * that drifts quietly between them.
 */
export function describeWithheld(kinds: { agents: number; skills: number }): string {
	return `${kinds.agents} agent definition${kinds.agents === 1 ? "" : "s"}, ${kinds.skills} skill${kinds.skills === 1 ? "" : "s"}`;
}

/** Whether this directory's tier of `kind` may be loaded. */
export function isProjectTierTrusted(cwd: string, kind: DefinitionKind, home: string = homedir()): boolean {
	return loadTrustedDefinitionKinds(cwd, home).has(kind);
}

/** Persist a trust decision, creating the file and its directory as needed. */
export function approveProjectDefinitions(cwd: string, kinds: DefinitionKind[], home: string = homedir()): void {
	const path = trustStorePath(cwd, home);
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			// Anything that is not an object would be replaced rather than extended;
			// this file is only ever written here, and a hand-edited one still starts
			// from whatever else it holds.
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
		}
	} catch {}
	const trusted = loadTrustedDefinitionKinds(cwd, home);
	for (const kind of kinds) trusted.add(kind);
	existing.trustedDefinitionKinds = KINDS.filter((kind) => trusted.has(kind));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}
