/**
 * `/help` is generated rather than hand-maintained, because a hand-maintained
 * list is a list that drifts: `/theme` shipped, worked, and never appeared in
 * `/help`, so users had no way to find it. These tests pin the generation and,
 * more importantly, assert the generated table still matches the switch that
 * actually dispatches — the drift itself, not just one symptom of it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPACTION_DISABLED_NOTICE, CompactionManager } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { helpText } from "@labunbun/tui";
import { builtInCommands, completeCommands } from "../src/commands.ts";
import { COMPACTION_ACCURACY_NOTICE, lowContextWarning } from "../src/context-report.ts";
import { appCommandTable } from "../src/interactive.ts";
import { withheldDefinitionNotice } from "../src/project-trust.ts";

const INTERACTIVE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "interactive.ts"), "utf8");

/**
 * Command names the app-level switch dispatches, read from the source. A `case`
 * that falls straight through to the next one is an alias, and an alias does not
 * need its own `/help` row — only the name it falls through to does.
 */
function dispatchedAppCommands(): { primary: string[]; aliases: string[] } {
	const body = INTERACTIVE_SOURCE.slice(INTERACTIVE_SOURCE.indexOf("function handleAppCommand"));
	const primary: string[] = [];
	const aliases: string[] = [];
	const lines = body.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^\t\tcase "(\/[a-z-]+)":/.exec(lines[i]);
		if (!match) continue;
		const fallsThrough = /^\t\tcase "\/[a-z-]+":/.test(lines[i + 1] ?? "");
		(fallsThrough ? aliases : primary).push(match[1]);
	}
	return { primary: [...new Set(primary)].sort(), aliases: [...new Set(aliases)].sort() };
}

describe("app command table", () => {
	test("the source scan finds the switch, so the checks below are not vacuous", () => {
		const { primary, aliases } = dispatchedAppCommands();
		expect(primary.length).toBeGreaterThan(5);
		expect(primary).toContain("/theme");
		// If this stops holding, the fall-through detection is no longer exercised.
		expect(aliases).toContain("/permissions-mode");
	});

	// The check that would have caught the original bug: a `case` added to the
	// switch without a row here means a command users cannot discover.
	test("every dispatched app command has a description", () => {
		const described = new Set(appCommandTable().map(([name]) => name));
		const undocumented = dispatchedAppCommands().primary.filter((name) => !described.has(name));
		expect(undocumented, "add a row to appCommandTable() for each new case in handleAppCommand").toEqual([]);
	});

	test("no described command is missing from the switch", () => {
		// An alias is allowed to go undescribed, but a described name that nothing
		// dispatches is a promise the REPL does not keep.
		const { primary, aliases } = dispatchedAppCommands();
		const dispatched = new Set([...primary, ...aliases]);
		const dead = appCommandTable()
			.map(([name]) => name)
			.filter((name) => !dispatched.has(name));
		expect(dead, "these are listed in /help but no case handles them").toEqual([]);
	});

	test("descriptions are non-empty and names are sorted and unique", () => {
		const names = appCommandTable().map(([name]) => name);
		expect(names).toEqual([...names].sort());
		expect(new Set(names).size).toBe(names.length);
		for (const [name, description] of appCommandTable()) {
			expect(name.startsWith("/"), `${name} should start with a slash`).toBe(true);
			expect(description.length, `${name} needs a description`).toBeGreaterThan(0);
		}
	});
});

/**
 * The messages that tell a stuck user what to type.
 *
 * They are written where the trouble is detected — the compaction manager says
 * the conversation no longer fits, the context report says it is nearly there —
 * which is a long way from the switch that decides what a command means. A line
 * that says `/new` reads as help and behaves as an error, and it is read at the
 * one moment the user has no room to work out what to do instead.
 */
describe("advice about a context that is full", () => {
	/** Every command the user can type and have dispatched. */
	function knownCommands(): Set<string> {
		// The REPL answers these itself, and keeps them out of any caller's table.
		return new Set([
			...appCommandTable().map(([name]) => name),
			...builtInCommands().map((command) => `/${command.name}`),
			"/help",
			"/clear",
			"/exit",
			"/quit",
		]);
	}

	function advice(): string[] {
		// Constructed for one string method: what a blocked request says is a
		// property of the window it was configured with.
		const manager = new CompactionManager(
			{ contextWindow: 200_000, maxOutputTokens: 8_192 },
			{ streamFn: fauxProvider([{ text: "unused" }]).streamFn, summarizerModel: FAUX_MODEL },
		);
		const withheld = { agents: 1, skills: 2 };
		return [
			manager.blockedMessage(),
			COMPACTION_DISABLED_NOTICE,
			lowContextWarning(1_600, 2_000),
			COMPACTION_ACCURACY_NOTICE,
			// The two startup notices that say a project tier is being held back: the
			// counts were shared from the start, the sentence around them was written
			// twice, and only a test can say whether either still names a real command.
			withheldDefinitionNotice(withheld, "repl"),
			withheldDefinitionNotice(withheld, "headless"),
		];
	}

	test("the advice about repeated compaction suggests a session, not a command that is not one", () => {
		// The reference implementation says "start a new thread", and this app has
		// no command that does that: advice ending in "unknown command" is read at
		// the one moment the user has no room to work out what to do instead. What
		// it names instead is `/export`, which exists and is what makes walking away
		// from a long session safe.
		expect(COMPACTION_ACCURACY_NOTICE).not.toContain("/new");
		expect(COMPACTION_ACCURACY_NOTICE).toContain("/export");
	});

	test("every command they name is a command that exists", () => {
		const known = knownCommands();
		const named = advice().flatMap((text) => text.match(/\/[a-z-]+/g) ?? []);
		// The scan has to be finding something, or the check below is vacuous.
		expect(named.length).toBeGreaterThan(2);
		expect(named).toContain("/compact");
		for (const name of named) {
			expect(known.has(name), `${name} is named in advice but no command answers to it`).toBe(true);
		}
	});

	test("the way out of a blocked request needs no model call", () => {
		// The summary is what stopped working when the breaker tripped, so a
		// message that offers only /compact offers only the thing that failed.
		expect(COMPACTION_DISABLED_NOTICE).toContain("/trim");
	});
});

describe("helpText", () => {
	/** The suggestion table interactive.ts builds, without mounting a REPL. */
	function suggestions(): Array<[string, string]> {
		return [
			...completeCommands(builtInCommands(), "").map((c) => [`/${c.name}`, c.description] as [string, string]),
			...appCommandTable(),
		].sort(([a], [b]) => a.localeCompare(b));
	}

	test("lists the app commands it was given", () => {
		const help = helpText(suggestions());
		for (const [name] of appCommandTable()) {
			expect(help, `${name} should appear in /help`).toContain(name);
		}
	});

	test("includes /theme, the command that was missing", () => {
		expect(helpText(suggestions())).toContain("/theme");
	});

	test("lists the registry commands too", () => {
		const help = helpText(suggestions());
		for (const command of builtInCommands()) {
			expect(help, `/${command.name} should appear in /help`).toContain(`/${command.name}`);
		}
	});

	test("keeps the commands the REPL dispatches on its own", () => {
		// These are not in any caller's table, so merging rather than replacing is
		// what keeps them visible.
		const help = helpText(suggestions());
		for (const name of ["/help", "/clear", "/model", "/exit"]) {
			expect(help).toContain(name);
		}
	});

	test("falls back to the built-ins when given no table", () => {
		const help = helpText();
		expect(help).toContain("/help");
		expect(help).toContain("/clear");
		expect(help).not.toContain("/theme"); // nothing supplied it
	});

	test("a caller-supplied description wins over the built-in one", () => {
		const help = helpText([["/model", "Switch between configured models"]]);
		expect(help).toContain("Switch between configured models");
		expect(help).not.toContain("Show or switch model");
	});

	test("names are padded to a common width, so descriptions line up", () => {
		const help = helpText([
			["/a", "short name"],
			["/longer-name", "long name"],
		]);
		const starts = help
			.split("\n")
			.filter((line) => /^ {2}\/(a|longer-name) /.test(line))
			.map((line) => line.search(/(short|long) name/));
		expect(starts).toHaveLength(2);
		expect(new Set(starts).size).toBe(1);
	});

	test("ends with the key bindings", () => {
		const help = helpText(suggestions());
		expect(help).toContain("Enter send");
		expect(help).toContain("↑/↓ history");
		expect(help).toContain("Esc interrupt");
	});

	test("each command appears exactly once", () => {
		const help = helpText(suggestions());
		const names = help
			.split("\n")
			.filter((line) => line.startsWith("  /"))
			.map((line) => line.trim().split(/\s+/)[0]);
		expect(new Set(names).size).toBe(names.length);
	});

	test("with vim on it says what Escape does in the editor", () => {
		// The key list promised "Esc interrupt" even where the editor takes the
		// key first. The plain list stays byte-identical for everyone else.
		const plain = helpText(suggestions());
		const vim = helpText(suggestions(), true);
		expect(vim.startsWith(plain)).toBe(true);
		expect(vim).toContain("Esc leave insert");

		const added = vim
			.slice(plain.length)
			.split("\n")
			.filter((line) => line.trim() !== "");
		expect(added).toHaveLength(1);
		expect(added[0]).toContain("vim:");
	});
});
