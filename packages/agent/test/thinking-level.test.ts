/**
 * The session's thinking level is a reader, not a value.
 *
 * A `/think` in the app layer changes a setting; the request that follows is
 * the only place the change is observable. That works only if the session
 * consults the reader on every request rather than capturing the answer it was
 * built with — a captured one would apply the choice at the next *session*,
 * which from the user's seat is indistinguishable from the command not working.
 * The transport is scripted, so the assertion is about what would have been
 * sent, not about a provider's reaction.
 */
import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, fauxProvider, type StreamOptions } from "@labunbun/ai";
import { AgentSession } from "../src/index.ts";

describe("the session's thinking level", () => {
	test("is read on every request, so a change made mid-session lands on the next one", async () => {
		const faux = fauxProvider([{ text: "one" }, { text: "two" }, { text: "three" }]);
		const seen: Array<StreamOptions["thinkingLevel"]> = [];
		let level: StreamOptions["thinkingLevel"];
		const session = new AgentSession({
			model: FAUX_MODEL,
			deps: {
				streamFn: (model, context, options) => {
					seen.push(options?.thinkingLevel);
					return faux.streamFn(model, context, options);
				},
				thinkingLevel: () => level,
			},
		});

		await session.prompt("first");
		level = "high";
		await session.prompt("second");
		// Unsetting is expressible too: the reader answering undefined again must
		// reach the wire as "no level", not as the last value it ever gave.
		level = undefined;
		await session.prompt("third");

		expect(seen).toEqual([undefined, "high", undefined]);
	});

	test("a session built without the reader sends no level", async () => {
		const faux = fauxProvider([{ text: "one" }]);
		const seen: Array<StreamOptions["thinkingLevel"]> = [];
		const session = new AgentSession({
			model: FAUX_MODEL,
			deps: {
				streamFn: (model, context, options) => {
					seen.push(options?.thinkingLevel);
					return faux.streamFn(model, context, options);
				},
			},
		});

		await session.prompt("go");

		expect(seen).toEqual([undefined]);
	});
});
