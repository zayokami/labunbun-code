/**
 * DeepSeek harness state: the cordis patch rows that carry both its settings and
 * its MCP servers, `AGENTS.md`, skills, and sessions.
 *
 * **There is no settings document.** The reader used to open
 * `<root>/settings.yaml` (plus `settings.yml` and `settings.json`), and all
 * three names are wrong for the current product: `settings.yaml` is retired —
 * `settings/settings/src/index.ts:238` calls it "the removed `settings.yaml`"
 * and only renames it to `.imported` on a one-shot upgrade import — and the
 * other two have zero occurrences anywhere in the shipped tree. Reading them
 * found nothing on every current install, so every settings-driven branch of the
 * planner was silently unreachable. See {@link readDshSettingsRows}.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DshMcpRead } from "./dsh-cordis.ts";
import { readDshMcpServers, readDshSettingsRows } from "./dsh-cordis.ts";
import { dshRoot } from "./dsh-home.ts";
import { readSkillDirs, readText } from "./migrate-core.ts";
import type { RawFile } from "./migrate-types.ts";

/**
 * DeepSeek Harness (`dsh`): the whole user state lives under one root, and
 * `$DSH_HOME` decides where that root is (see {@link dshRoot}) — so the resolved
 * root travels with the data, and every report line is written from it rather
 * than from a guess about `~`.
 */
export interface RawDeepSeekHarness {
	/** Resolved harness home: `$DSH_HOME` when set, else `~/.dsh`. */
	root: string;
	present: boolean;
	/** <root>/AGENTS.md */
	memory: string | null;
	skills: RawFile[];
	/** Cordis settings rows, keyed by entry id; the values are their `config` blocks. */
	settings: Record<string, unknown>;
	/**
	 * The composition the settings rows were folded out of, when there was one:
	 * the file that carried them, or how many layers there were. Absent when no
	 * patch layer carried a row, which is why the plan says nothing about one.
	 * `error` is set when a layer existed but would not parse.
	 */
	settingsSource?: { file: string; error?: string };
	/** MCP servers declared by the root's cordis patches, as the sibling reader found them. */
	mcp: DshMcpRead;
	/** Entries under `.agent-presets`, in either spelling the discovery reads — counted, never read. */
	presetCount: number;
	/** Live session logs under `sessions` — counted, never read. */
	sessionCount: number;
	/** `<root>/.credentials.yaml` exists. Reported by name; never opened. */
	credentialsPresent: boolean;
	/** `<root>/.env` exists. Reported by name; never opened. */
	envFilePresent: boolean;
	/** `<root>/attachments` exists — session payloads, reported by name only. */
	attachmentsPresent: boolean;
	/** `<root>/storages` exists — non-session storage, reported by name only. */
	storagesPresent: boolean;
}

/**
 * The settings rows out of the harness home, keyed by entry id.
 *
 * **The `settings` field is the whole settings model, and there is no file
 * behind it.** The planner indexes it by id (`raw.settings["llm-pi-ai"]`,
 * `raw.settings["llm-deepseek"]`, `raw.settings["agent-default-model"]`,
 * `raw.settings.permission`) — which is what it has always done and is exactly
 * the shape a Cordis patch row composes to — so the repair was entirely on this
 * side: read the rows out of the patch layers instead of opening three filenames
 * the product does not use.
 */
function readDshSettings(root: string): {
	settings: Record<string, unknown>;
	settingsSource?: { file: string; error?: string };
} {
	const read = readDshSettingsRows(root);
	// Every row's config block, keyed by id. A row with no `config` folds to `{}`,
	// which is the harness's own meaning for "the row exists and sets nothing".
	const settings: Record<string, unknown> = { ...read.rows };
	const entries = Object.entries(read.sources);

	if (entries.length === 0) {
		// No patch layer carried a row. That is an honest absence and the plan
		// says nothing about settings, exactly as it says nothing about a missing
		// `settings.json` used to — but the reason is now the composition, and
		// naming it costs one line and tells a user where to look.
		if (read.notes.length > 0) {
			return { settings, settingsSource: { file: "cordis.patch.yml", error: read.notes[0]?.reason } };
		}
		return { settings };
	}

	// The file that carried the most rows is the one to name. When a home has
	// several layers this is a summary rather than a single answer, and the plan
	// only uses the name to point at "where the settings are", so the summary is
	// the honest thing to print.
	const files = [...new Set(entries.map(([, file]) => file))];
	// `files.length === 1` is the only way `files[0]` is read, so the empty case
	// cannot reach it — but a non-null assertion says "prove it", and the claim is
	// one character from being wrong. Spelled out instead.
	const only = files.length === 1 ? files[0] : undefined;
	return { settings, settingsSource: { file: only === undefined ? `${files.length} patch layers` : basenameOf(only) } };
}

function basenameOf(path: string): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return cut === -1 ? path : path.slice(cut + 1);
}

export function readDeepSeekHarness(home: string): RawDeepSeekHarness {
	const root = dshRoot(home);
	return {
		root,
		present: existsSync(root),
		memory: readText(join(root, "AGENTS.md")),
		skills: readDshSkills(join(root, "skills")),
		...readDshSettings(root),
		mcp: readDshMcpServers(root),
		presetCount: countDshPresets(join(root, ".agent-presets")),
		sessionCount: countDshSessionLogs(join(root, "sessions")),
		// Existence only, and deliberately no more than that: both files hold
		// credentials the harness resolves through its own credential service, and
		// a migration has no use for a secret it may not even name in the report.
		credentialsPresent: existsSync(join(root, ".credentials.yaml")),
		envFilePresent: existsSync(join(root, ".env")),
		// Session payloads and non-session storage. Named in the report so their
		// absence from the plan reads as a decision; the trees are large and
		// binary, so neither is walked.
		attachmentsPresent: existsSync(join(root, "attachments")),
		storagesPresent: existsSync(join(root, "storages")),
	};
}

/**
 * Skills under `<root>/skills`, in both spellings the harness reads side by
 * side: a directory bundle (`<name>/SKILL.md`) and a flat file (`<name>.md`).
 * Both become the same target here — a skill directory whose SKILL.md is the
 * file — which is why the flat form is read rather than reported as unknown.
 *
 * `.system` holds the harness's own bundled skills on this root; its discovery
 * skips that name, and importing them would file somebody else's content as the
 * user's own.
 */
function readDshSkills(skillsRoot: string): RawFile[] {
	const files = readSkillDirs(skillsRoot).filter((file) => file.name !== ".system");
	try {
		if (!existsSync(skillsRoot)) return files;
		for (const name of readdirSync(skillsRoot).sort()) {
			if (!name.endsWith(".md")) continue;
			const base = name.slice(0, -3);
			if (base === ".system") continue;
			const path = join(skillsRoot, name);
			if (!statSync(path).isFile()) continue;
			const content = readText(path);
			if (content !== null) files.push({ name: base, sourcePath: path, content });
		}
	} catch {
		// unreadable skills dir — the directory bundles are already collected
	}
	return files;
}

/**
 * Presets under `<root>/.agent-presets`, counted rather than read.
 *
 * A preset is a whole agent composition (`agent.cordis.yml`), which is another
 * product's plugin wiring; the report names the count and stops there. A file is
 * counted beside a directory: the discovery reads either spelling, so an entry
 * that is there at all is one the harness would offer.
 */
function countDshPresets(dir: string): number {
	try {
		if (!existsSync(dir)) return 0;
		return readdirSync(dir).filter((name) => !name.startsWith(".")).length;
	} catch {
		return 0;
	}
}

/**
 * Live session logs under `<root>/sessions`, counted rather than read: the
 * history importer reads them, and reading them here would pay for the
 * transcript twice.
 *
 * The layout is `<sessions>/<project>/<session-id>/<generation>.jsonl`, or
 * `.jsonl.zstd` on a compressed deployment. Only files one level below a session
 * directory count: an older flat artifact is not a log the harness would open
 * either, so counting one would promise a transcript that is not there.
 */
function countDshSessionLogs(sessionsRoot: string): number {
	let total = 0;
	try {
		if (!existsSync(sessionsRoot)) return 0;
		for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
			if (!project.isDirectory()) continue;
			const projectDir = join(sessionsRoot, project.name);
			for (const session of readdirSync(projectDir, { withFileTypes: true })) {
				if (!session.isDirectory()) continue;
				total += readdirSync(join(projectDir, session.name)).filter(
					(name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd"),
				).length;
			}
		}
	} catch {
		// unreadable sessions tree — nothing to report
	}
	return total;
}
