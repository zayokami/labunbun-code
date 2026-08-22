import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, type FauxStep, fauxProvider } from "@labunbun/ai";
import { AgentSession } from "../src/index.ts";

/**
 * The Stop-hook resume pattern the app layer relies on: an `agent_end`
 * listener calls `followUp()` to send a completed loop back to work.
 *
 * `agent_end` is emitted from the `finally` block *after* `#running` is
 * cleared, so `followUp()` there takes the `prompt()` branch rather than the
 * queue branch. These pin that re-entrant path down, since a regression would
 * silently make Stop hooks unable to continue a session.
 */

function textStep(text: string): FauxStep {
	return { text };
}

describe("followUp from an agent_end listener (Stop hook resume)", () => {
	test("a listener that calls followUp once drives a second turn", async () => {
		const faux = fauxProvider([textStep("first answer"), textStep("second answer")]);
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "test",
			tools: [],
			deps: { streamFn: faux.streamFn },
		});

		let resumed = false;
		const endReasons: string[] = [];
		session.on(async (event) => {
			if (event.type !== "agent_end") return;
			endReasons.push(event.reason);
			if (resumed) return;
			resumed = true;
			session.followUp("keep going");
		});

		await session.prompt("go");
		// Let the re-entrant prompt() settle.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const userTexts = session.messages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(userTexts).toContain("keep going");
		// Two completed runs: the original and the hook-driven resume.
		expect(endReasons.length).toBeGreaterThanOrEqual(2);
	});

	test("a bounded resume counter stops an always-blocking Stop hook", async () => {
		const steps: FauxStep[] = Array.from({ length: 12 }, (_, i) => textStep(`answer ${i}`));
		const faux = fauxProvider(steps);
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "test",
			tools: [],
			deps: { streamFn: faux.streamFn },
		});

		// Mirrors the app layer's guard: a hook that always asks to continue
		// must not spin the loop forever.
		const MAX_RESUMES = 3;
		let resumes = 0;
		session.on(async (event) => {
			if (event.type !== "agent_end") return;
			if (resumes >= MAX_RESUMES) return;
			resumes++;
			session.followUp(`resume ${resumes}`);
		});

		await session.prompt("go");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(resumes).toBe(MAX_RESUMES);
		const userTexts = session.messages
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""));
		// Original prompt plus exactly MAX_RESUMES hook-driven prompts.
		expect(userTexts).toHaveLength(MAX_RESUMES + 1);
	});
});
