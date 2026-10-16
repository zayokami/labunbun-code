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
import { isProjectTierTrusted } from "./project-trust.ts";

export interface OutputStyle {
	name: string;
	content: string;
	sourcePath: string;
	source: "user" | "project";
}

function loadStylesFromDir(dir: string, source: "user" | "project"): OutputStyle[] {
	const out: OutputStyle[] = [];
	try {
		if (!existsSync(dir)) return out;
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
			} catch {
				// A file that vanished between the listing and the read is skipped;
				// it must not fail the styles that did load.
			}
		}
	} catch {
		// unreadable directory — treated as holding no styles
	}
	return out;
}

/**
 * The user tier always, the project tier only once this directory is trusted —
 * the same gate, read the same way, as skills and agent definitions.
 */
export function loadOutputStyles(cwd: string, home: string = homedir()): OutputStyle[] {
	const user = loadStylesFromDir(join(home, ".labunbun", "output-styles"), "user");
	const project = isProjectTierTrusted(cwd, "styles", home)
		? loadStylesFromDir(join(cwd, ".labunbun", "output-styles"), "project")
		: [];
	// Project styles override user styles with the same name.
	const byName = new Map<string, OutputStyle>();
	for (const style of [...user, ...project]) byName.set(style.name, style);
	return [...byName.values()];
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
