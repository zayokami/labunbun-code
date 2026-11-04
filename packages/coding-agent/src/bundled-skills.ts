/**
 * The skills the product ships with, kept out of the user's home until a session
 * asks for them.
 *
 * `.labunbun/skills` is embedded into the executable at build time
 * (`bundled-skills.generated.ts`, written by `scripts/bundle-skills.ts`), which
 * is the only way a one-file binary can carry a directory of Markdown. The
 * loader wants a directory, though: a skill's body names `references/…` next to
 * it, and the Skill tool hands the model a `sourcePath` it can open. So the
 * embedded files are materialized once per version under
 * `~/.labunbun/bundled-skills/<version>/` and loaded from there with the same
 * reader as every other tier.
 *
 * They are *not* copied into `~/.labunbun/skills`: that directory is the user's,
 * and a built-in appearing beside their own work would make "delete it" mean
 * "it comes back on the next start". Precedence is the other way around —
 * bundled lowest, then the user's, then the project's — so a user skill with
 * the same name substitutes for the product's rather than being shadowed by it.
 *
 * The refresh check is a content digest, not the version string alone: a dev
 * build keeps the same version across edits, and a skill body edited without a
 * version bump must not leave the old copy on disk forever.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUNDLED_SKILL_FILES } from "./bundled-skills.generated.ts";
import { CODING_AGENT_VERSION } from "./cli-constants.ts";

/** One embedded file: its path under the skills root, and the importable path. */
export type BundledSkillFile = readonly [path: string, sourcePath: string];

export interface BundledSkillsResult {
	/** The directory to load from, or `null` when it could not be written. */
	root: string | null;
	/** Why the directory is missing, for the same notes channel as every other load failure. */
	note?: string;
}

export function bundledSkillsRoot(home: string): string {
	return join(home, ".labunbun", "bundled-skills", CODING_AGENT_VERSION);
}

/** The digest of every embedded file, so a content edit is seen even without a version bump. */
function manifestDigest(): string {
	const hash = createHash("sha256");
	for (const [path, source] of BUNDLED_SKILL_FILES) {
		hash.update(path);
		hash.update("\0");
		hash.update(readFileSync(source));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/**
 * Write the embedded files to `~/.labunbun/bundled-skills/<version>/`, skipping
 * the work when the marker says this exact content is already there.
 *
 * Never throws: a read-only home, a policy-managed machine or a full disk should
 * cost the built-in skills, not the session. The note names the directory so
 * the user can see why the list is shorter.
 */
export function materializeBundledSkills(home: string): BundledSkillsResult {
	const root = bundledSkillsRoot(home);
	const marker = join(root, ".manifest");
	try {
		const digest = manifestDigest();
		if (existsSync(marker) && readFileSync(marker, "utf8").trim() === digest) return { root };
		for (const [path, source] of BUNDLED_SKILL_FILES) {
			const target = join(root, ...path.split("/"));
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, readFileSync(source));
		}
		writeFileSync(marker, `${digest}\n`);
		return { root };
	} catch (error) {
		return {
			root: null,
			note: `built-in skills could not be written to ${root}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
