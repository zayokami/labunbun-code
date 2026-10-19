/**
 * Output styles: `*.md` files from `~/.labunbun/output-styles/` and, once the
 * directory is trusted, `<cwd>/.labunbun/output-styles/`. The file name minus
 * `.md` is the name `settings.outputStyle` selects, and the winning file's body
 * becomes the `# Output style` section of the system prompt.
 *
 * Project over user on a name collision, the same merge skills make: that is
 * what makes a project style useful. The trust gate is what keeps a repository
 * from doing it silently — its styles load only after one approval
 * (`project-trust.ts`, kind "styles"), and even then only a style the user's own
 * settings name is ever read into a prompt. The selection is not a project-tier
 * setting for that reason: a repository that could both ship a style and select
 * it would be writing a prompt section the user never saw.
 *
 * The style body is a section, not a replacement for the prompt: the coding
 * instructions stay in place (see `system-prompt.ts`). A style governs voice; a
 * mechanism that let a style file delete the harness's own rules would turn a
 * tone setting into a way to ship a prompt.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMissingPathError } from "@labunbun/tools";
import { isProjectTierTrusted } from "./project-trust.ts";

export interface OutputStyle {
	name: string;
	content: string;
	sourcePath: string;
	source: "user" | "project";
}

export interface OutputStyleLoadResult {
	styles: OutputStyle[];
	/**
	 * Directories and files that are there but could not be read.
	 *
	 * An unreadable style directory used to be indistinguishable from one that
	 * holds nothing: the selected style simply did not reach the prompt, and no
	 * one was told.
	 */
	notes: string[];
}

function loadStylesFromDir(dir: string, source: "user" | "project", notes: string[]): OutputStyle[] {
	const out: OutputStyle[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			const path = join(dir, entry.name);
			try {
				out.push({
					name: entry.name.slice(0, -".md".length),
					content: readFileSync(path, "utf8"),
					sourcePath: path,
					source,
				});
			} catch (error) {
				// A file that vanished between the listing and the read is skipped;
				// it must not fail the styles that did load. One that is still there
				// and cannot be read is a style the user selected and will not get.
				if (!isMissingPathError(error)) {
					notes.push(
						`output style ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	} catch (error) {
		// An absent directory is the ordinary answer. An unreadable one is not:
		// every style under it is missing from the prompt.
		if (!isMissingPathError(error)) {
			notes.push(
				`output styles directory ${dir} could not be read: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return out;
}

/**
 * The user tier always, the project tier only once this directory is trusted —
 * the same gate, read the same way, as skills and agent definitions.
 *
 * The notes are for the host's startup surface; call sites that have nowhere to
 * put them keep using {@link loadOutputStyles}.
 */
export function loadOutputStylesWithNotes(cwd: string, home: string = homedir()): OutputStyleLoadResult {
	const notes: string[] = [];
	const user = loadStylesFromDir(join(home, ".labunbun", "output-styles"), "user", notes);
	const project = isProjectTierTrusted(cwd, "styles", home)
		? loadStylesFromDir(join(cwd, ".labunbun", "output-styles"), "project", notes)
		: [];
	// Project styles override user styles with the same name.
	const byName = new Map<string, OutputStyle>();
	for (const style of [...user, ...project]) byName.set(style.name, style);
	return { styles: [...byName.values()], notes };
}

/** The styles alone — the reader for call sites with no notice surface. */
export function loadOutputStyles(cwd: string, home: string = homedir()): OutputStyle[] {
	return loadOutputStylesWithNotes(cwd, home).styles;
}

/**
 * The style `settings.outputStyle` names, or undefined when it names nothing.
 *
 * A name that matches no file decides nothing — the session runs without a
 * style section — rather than failing: the same fail-soft an unknown theme name
 * gets, and a typo here is a thing `/doctor` can report rather than a thing
 * that stops a session.
 */
export function resolveOutputStyle(name: string | undefined, styles: OutputStyle[]): OutputStyle | undefined {
	if (!name) return undefined;
	return styles.find((style) => style.name === name);
}

/**
 * The project-tier style files the trust gate is holding back, for the startup
 * notice and `/agents` to name.
 *
 * The files are listed, never read. A style that has not been trusted is a path
 * the user can open before deciding; reading it here would defeat the gate this
 * function exists to report. The same readdir the loader uses decides what
 * counts as a style, so a name the listing shows is a name the approval would
 * actually load.
 */
export function withheldProjectOutputStyles(cwd: string, home: string = homedir()): string[] {
	const dir = join(cwd, ".labunbun", "output-styles");
	if (isProjectTierTrusted(cwd, "styles", home)) return [];
	try {
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((entry) => join(dir, entry.name));
	} catch {
		// An unreadable directory holds no styles, the same answer the loader gives.
		return [];
	}
}
