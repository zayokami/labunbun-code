/**
 * DeepSeek harness state: `settings.yaml`, `AGENTS.md`, skills, the cordis
 * patches that declare MCP servers, `.agent-presets`, and sessions.
 *
 * `DSH_SETTINGS_FILES` is private to this reader, and that is the only reason
 * it is here rather than shared: it names this harness's own files.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DshMcpRead } from "./dsh-cordis.ts";
import { readDshMcpServers } from "./dsh-cordis.ts";
import { dshRoot } from "./dsh-home.ts";
import { isRecord, readSkillDirs, readText } from "./migrate-core.ts";
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
	/** Top-level sections of the settings document; its keys are settings namespaces. */
	settings: Record<string, unknown>;
	/**
	 * The settings document that was read, when there was one: its file name, and —
	 * when it could not be parsed — the fact that is worth reporting. Absent when
	 * the root holds no settings file, which is why the plan says nothing about one.
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

/** Settings documents the harness reads, in the order it looks for one. */
const DSH_SETTINGS_FILES = ["settings.yaml", "settings.yml", "settings.json"];

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
 * The harness's settings document, as one namespace-keyed object.
 *
 * `Bun.YAML.parse` reads JSON too, so one call covers all three spellings. Only
 * the first file that exists is read: the harness composes exactly one settings
 * document, so a second one beside it is not a second settings source.
 *
 * A document that will not parse migrates nothing and is reported as such. The
 * harness itself refuses to start on one, so there is a file for the user to fix;
 * aborting the whole migration over it would also drop the sources that are fine.
 * The reason is a fixed phrase rather than the parser's own message, which can
 * quote the line it choked on — and that line is often a credential.
 */
function readDshSettings(
	root: string,
): { settings: Record<string, unknown> } & Pick<RawDeepSeekHarness, "settingsSource"> {
	for (const file of DSH_SETTINGS_FILES) {
		const text = readText(join(root, file));
		if (text === null) continue;
		try {
			const parsed: unknown = Bun.YAML.parse(text);
			// A document with no mapping at its root has no sections to read.
			return { settings: isRecord(parsed) ? parsed : {}, settingsSource: { file } };
		} catch {
			return { settings: {}, settingsSource: { file, error: "is not parseable as YAML or JSON" } };
		}
	}
	return { settings: {} };
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
