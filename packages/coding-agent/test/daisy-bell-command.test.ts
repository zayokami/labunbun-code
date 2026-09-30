/**
 * `/hal` reaches the synthesiser.
 *
 * Its own file, and the reason is a mutation rather than a style choice. Every
 * other assertion in this feature's suite can pass with the command's `call`
 * replaced by a string constant: the command would still be registered, still
 * answer, and still exit 0 — a `/hal` that prints "♪ Daisy Bell ♪" and makes no
 * sound, which is the one outcome an easter egg must not have. So this mocks the
 * playback and asks the command what it says, which is the only question that
 * distinguishes the two.
 *
 * The real module is spread into the mock rather than replaced by it, so a
 * `parseScore` call in another file still finds a parser. A wrapper that reads
 * the namespace *after* installing the mock gets the wrapper back — the mock
 * re-links the namespace object — and recurses; so the real one is read first,
 * here, before anything is installed.
 */
import { describe, expect, mock, test } from "bun:test";
import * as daisyBell from "../src/daisy-bell.ts";

const real = daisyBell;

mock.module("../src/daisy-bell.ts", () => ({
	...real,
	playDaisyBell: async () => ({ played: true, message: "♪ from the mock ♪" }),
}));

const { builtInCommands, findCommand } = await import("../src/commands.ts");

describe("/hal", () => {
	test("plays the tune rather than saying so", async () => {
		const command = findCommand(builtInCommands(), "/HAL");
		// Narrowing is itself the first assertion: a `/hal` that became a prompt
		// command would stop having a `call` to make at all, and a command that
		// cannot be found would answer `undefined` below.
		if (command?.type !== "local") throw new Error("/HAL is no longer a local command");

		// The whole claim. A `call` that renders nothing returns the wrong string and
		// this goes red; the command cannot reach the mock and be quiet about it.
		expect(await command.call({} as never, "")).toBe("♪ from the mock ♪");
	});
});
