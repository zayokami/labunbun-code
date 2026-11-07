/**
 * Where a session's repository map lives.
 *
 * One service per session, shared by the RepoMap tool, the `/map` commands and
 * the startup prompt section: each of those scans the same checkout, and three
 * caches over one tree would pay three cold scans. The cache is per project
 * rather than per session — a second `labunbun` in the same checkout starts
 * hot — and lives beside the sessions so it ages out with the project state.
 *
 * The prompt section is best effort by design. A scan that fails is a reason to
 * leave the section out, not a reason a session cannot start; the RepoMap tool
 * will report the same failure if the user asks for the map directly.
 */
import { join } from "node:path";
import { sanitizeCwd, sessionsRoot } from "@labunbun/agent";
import { type Operations, RepoMapService } from "@labunbun/tools";

/** The project's persistent map cache, shared by every session in this checkout. */
export function repoMapCachePath(cwd: string, home?: string): string {
	return join(sessionsRoot(home), sanitizeCwd(cwd), "repomap.sqlite");
}

export function createRepoMapService(cwd: string, ops: Operations, home?: string): RepoMapService {
	return new RepoMapService({ root: cwd, ops, cachePath: repoMapCachePath(cwd, home) });
}

/** The body of the `# Repository map` section, or undefined when the repository is too large. */
export async function repoMapPromptSection(service: RepoMapService): Promise<string | undefined> {
	try {
		const section = await service.promptSection();
		return section?.text;
	} catch {
		return undefined;
	}
}
