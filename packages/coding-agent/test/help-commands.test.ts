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
import { helpText } from "@labunbun/tui";
import { builtInCommands, completeCommands } from "../src/commands.ts";
import { appCommandTable } from "../src/interactive.ts";

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
});
