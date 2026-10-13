/**
 * `/help-uganda` — the note the Vim mode owes Vim, in the command that prints it.
 *
 * The text is the whole feature, so it is pinned whole rather than by pieces:
 * a reworded sentence, a lost line break or a drifted URL would each still
 * hold a substring of the original and pass a looser check.
 */
import { describe, expect, test } from "bun:test";
import { builtInCommands, completeCommands, findCommand } from "../src/commands.ts";

const MESSAGE =
	"LaBunbun’s Vim feature was inspired by Vim’s source code.\n" +
	"Vim is completely free and open-source software. If you like LaBunbun’s Vim feature, " +
	"please donate to help children in need in Uganda! https://www.vim.org/sponsor/";

describe("/help-uganda", () => {
	test("answers to its name whatever the casing", () => {
		expect(findCommand(builtInCommands(), "/help-uganda")?.name).toBe("help-uganda");
		expect(findCommand(builtInCommands(), "/HELP-UGANDA")?.name).toBe("help-uganda");
	});

	test("prints the dedication whole, in two lines", async () => {
		const command = findCommand(builtInCommands(), "/help-uganda");
		// Narrowing is itself an assertion: a command that stopped being local
		// would have no `call` to make, and one that is unfindable answers
		// `undefined` here rather than below.
		if (command?.type !== "local") throw new Error("/help-uganda is no longer a local command");
		const text = await command.call({} as never, "");
		expect(text).toBe(MESSAGE);
		expect(text?.split("\n")).toHaveLength(2);
	});

	test("is discoverable: its distinctive tail completes it", () => {
		// `/help` is generated from this registry, so being in it is the listing
		// claim; this pins the other way in — typing the part that is not the
		// shared `/help` prefix.
		expect(completeCommands(builtInCommands(), "uganda").map((c) => c.name)).toContain("help-uganda");
	});
});
