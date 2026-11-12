/**
 * What a typed `/command` sends, and what the transcript keeps.
 *
 * The two are deliberately different. The transcript shows the line the user
 * typed — `/skill-echo the-args` — while the model receives the skill's body
 * with the arguments substituted. Sending the typed line instead looks the same
 * on screen and hands the model a name it has never seen; showing the expansion
 * loses the command the reader can point at. And both have to be the *same*
 * expansion a `-p` run sends for the same line, or a skill works when typed and
 * does nothing when scripted.
 *
 * Driven through the real `handleCommandDispatch`, because the wiring from a
 * typed line to the request is the part that can go missing; `skillsAsCommands`
 * and the frontmatter reader have their own tests next door.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { builtInCommands, expandPromptCommand } from "../src/commands.ts";
import { type AppCommandContext, handleCommandDispatch } from "../src/interactive.ts";
import { skillsAsCommands } from "../src/skills.ts";

const SKILL = {
	name: "echo",
	description: "says it back",
	body: "SKILL-BODY-MARKER for $ARGUMENTS",
	sourcePath: "C:/skills/echo/SKILL.md",
	disableModelInvocation: false,
};

interface Harness {
	ctx: AppCommandContext;
	faux: ReturnType<typeof fauxProvider>;
	/** The transcript view as the dispatch left it. */
	transcript: () => Array<{ kind: string; text: string }>;
}

function harness(steps: Parameters<typeof fauxProvider>[0] = [{ text: "ok" }]): Harness {
	const faux = fauxProvider(steps);
	const session = new AgentSession({
		model: FAUX_MODEL,
		systemPrompt: "sys",
		deps: {
			streamFn: async function* (model, context, options) {
				yield* faux.streamFn(model, context, options);
			},
		},
	});
	let transcript: Array<{ kind: string; text: string }> = [];
	const ctx = {
		commands: [...builtInCommands(), ...skillsAsCommands([SKILL])],
		getSession: () => session,
		// Local commands read these at dispatch even when they do not use them.
		compaction: () => undefined,
		beginCommand: undefined,
		handle: {
			// The store's contract: an update applied to the current state. Recording
			// the result rather than the argument is what lets a test see the entry
			// the user would see.
			store: {
				set: (update: unknown) => {
					const current = { entries: transcript };
					const next =
						typeof update === "function"
							? (update as (state: typeof current) => typeof current)(current)
							: (update as typeof current);
					transcript = next.entries;
				},
			},
		},
	} as unknown as AppCommandContext;
	return { ctx, faux, transcript: () => transcript };
}

/**
 * The last user message the model was sent, once one has been sent.
 *
 * Read from the user side and not `messages.at(-1)`: the context the transport
 * recorded holds the session's live array, which by the time this runs has the
 * assistant's reply appended to it.
 */
async function lastRequest(faux: ReturnType<typeof fauxProvider>): Promise<string> {
	const deadline = Date.now() + 2_000;
	while (faux.receivedContexts.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	const messages = faux.receivedContexts.at(-1)?.messages ?? [];
	return JSON.stringify([...messages].reverse().find((message) => message.role === "user"));
}

describe("a prompt command typed into the REPL", () => {
	test("reaches the model as the skill's body, with the arguments in it", async () => {
		const h = harness();

		expect(handleCommandDispatch("/skill-echo the-args", h.ctx)).toBe(true);

		const sent = await lastRequest(h.faux);
		expect(sent).toContain("SKILL-BODY-MARKER");
		expect(sent).toContain("the-args");
		expect(sent).not.toContain("/skill-echo");
	});

	test("leaves the line the user typed in the transcript", async () => {
		const h = harness();

		handleCommandDispatch("/skill-echo the-args", h.ctx);
		await lastRequest(h.faux);

		expect(h.transcript()).toEqual([{ kind: "user", text: "/skill-echo the-args" }]);
	});

	test("expands a built-in prompt command the same way", async () => {
		const h = harness();

		handleCommandDispatch("/explain the parser", h.ctx);

		expect(await lastRequest(h.faux)).toContain("Explain the parser");
	});
});

describe("what counts as a prompt command", () => {
	test("a local command is not one, so a caller has to handle it itself", () => {
		// `/compact` reads and rewrites the live session; there is nothing to send
		// to a model, and a `-p` run has to keep its own hands off it.
		expect(expandPromptCommand(builtInCommands(), "/compact")).toBeNull();
	});

	test("neither is a line that names nothing", () => {
		expect(expandPromptCommand(builtInCommands(), "why is this failing?")).toBeNull();
		expect(expandPromptCommand([], "/anything at all")).toBeNull();
	});

	test("an alias resolves like the name it points at", () => {
		// Same lookup the REPL uses, so an alias of a prompt command expands too
		// instead of falling through to the app-level table.
		const commands = [
			{ name: "short", aliases: ["s"], description: "", type: "prompt" as const, getPrompt: () => "EXPANDED" },
		];
		expect(expandPromptCommand(commands, "/s rest")).toBe("EXPANDED");
	});
});

/**
 * `/btw` is a question about the conversation, not a turn in it: the answer
 * goes to the screen and nowhere else, so the next request is the one the
 * user's work would have sent anyway.
 */
describe("the /btw command", () => {
	const waitFor = async (check: () => boolean): Promise<void> => {
		const deadline = Date.now() + 2_000;
		while (!check()) {
			if (Date.now() > deadline) throw new Error("timed out waiting for the command");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	};

	test("shows the answer and leaves the session history untouched", async () => {
		const h = harness([{ text: "aside answer" }]);

		expect(handleCommandDispatch("/btw what did that mean?", h.ctx)).toBe(true);
		await waitFor(() => h.transcript().some((entry) => entry.kind === "info" && entry.text === "aside answer"));

		// The request carried the question with no tools, and the session is still
		// empty: there is no turn for the next prompt to inherit.
		expect(h.faux.receivedContexts[0]?.tools).toEqual([]);
		expect(JSON.stringify(h.faux.receivedContexts[0]?.messages)).toContain("what did that mean?");
		expect(h.ctx.getSession()?.messages).toEqual([]);
	});

	test("says how to use it when there is no question", async () => {
		const h = harness();

		handleCommandDispatch("/btw", h.ctx);
		await waitFor(() => h.transcript().some((entry) => entry.kind === "info"));
		expect(h.transcript().at(-1)?.text).toContain("Usage: /btw");
		expect(h.faux.receivedContexts).toHaveLength(0);
	});
});

/**
 * `/init` writes a file every later session loads, and the documented failure
 * is a long file that restates what the model can already read from the repo.
 * The prompt is the only control over what lands in it.
 */
describe("the /init prompt", () => {
	test("asks for checks and non-obvious rules, and caps what the file becomes", () => {
		const init = builtInCommands().find((command) => command.name === "init");
		if (init?.type !== "prompt") throw new Error("/init is not a prompt command");
		const body = init.getPrompt("");
		expect(body).toContain("how to run one test file");
		expect(body).toContain("cannot be learned by reading the repo");
		expect(body).toContain("concrete, checkable instruction");
		expect(body).toContain("Do not describe the architecture or file layout");
		expect(body).toContain("well under 200 lines");
	});
});
