/**
 * What a user message is made of, and when.
 *
 * A provider caches a prefix, so a user message written once and sent unchanged
 * for the rest of the conversation is worth more than the same message written
 * twice with different bytes. `LoopHooks.composeUserMessage` exists to make that
 * true for context a hook contributes: it runs at the moment the message is
 * created, and what it returns is what the transcript holds — so the second
 * request of a tool loop sends the same bytes as the first.
 *
 * These are the tests the old arrangement failed. It attached hook context to
 * the request instead of the message, which put it in the first request of a
 * prompt and left it out of every later one: the prefix diverged at that
 * message, and everything after it was written once and never read.
 */
import { describe, expect, test } from "bun:test";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { z } from "zod";
import { AgentSession, type AnyTool, buildTool } from "../src/index.ts";

const HOOK = "[hook] the build runs via make";

/** A tool the script can call, so a prompt's first turn is not its last. */
function noopTool(): AnyTool {
	return buildTool({
		name: "noop",
		description: "does nothing",
		inputSchema: z.object({}),
		call: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});
}

/**
 * Requests as they were sent, serialized at the moment they were received.
 *
 * The session hands the provider its live message array, so the context a
 * `fauxProvider` records is that array as it stands at the *end* of the run:
 * every request would compare equal to every other, and a prefix test written
 * against it would pass whatever the code did. Snapshotting here is what makes
 * the comparison mean anything. (The adapters serialize at the same moment, so
 * these are the bytes they put on the wire.)
 */
function recording(inner: StreamFn): { streamFn: StreamFn; sent: string[] } {
	const sent: string[] = [];
	const streamFn: StreamFn = async function* (model, context, options) {
		sent.push(JSON.stringify(context.messages));
		yield* inner(model, context, options);
	};
	return { streamFn, sent };
}

/**
 * Whether `later` sent `earlier`'s messages and then some — the prefix a
 * provider would have cached, expressed over the array's own serialization.
 *
 * A missing snapshot is not a prefix of anything, so a request that never
 * happened cannot pass this by accident.
 */
function isExtensionOf(earlier: string | undefined, later: string | undefined): boolean {
	if (!earlier || !later) return false;
	return later.startsWith(earlier.slice(0, -1)); // `]` is the only byte an append may change
}

/** The user messages the session holds, as text: composed, since they are strings. */
function userTexts(session: AgentSession): string[] {
	return session.messages.flatMap((m) => (m.role === "user" && typeof m.content === "string" ? [m.content] : []));
}

describe("composing a user message at creation", () => {
	test("what the hook contributes is in the transcript and in every request after it", async () => {
		const faux = fauxProvider([{ toolCalls: [{ name: "noop", arguments: {} }] }, { text: "done" }]);
		const rec = recording(faux.streamFn);
		const session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "sys",
			tools: [noopTool()],
			deps: {
				streamFn: rec.streamFn,
				hooks: { composeUserMessage: (text) => `${HOOK}\n\n---\n\n${text}` },
			},
		});

		await session.prompt("what is the build command?");

		// Stored: the hook's contribution is part of the message itself, not
		// something the request layer adds on the way out.
		expect(userTexts(session)).toEqual([`${HOOK}\n\n---\n\nwhat is the build command?`]);
		expect(rec.sent).toHaveLength(2);
		expect(rec.sent[0]).toContain(HOOK);
		// Sent again on the tool loop's next turn. This is the assertion that fails
		// when the context is attached to a request instead: the message goes out
		// without it, the prefix is rewritten from there down, and the entry the
		// first request wrote is never read again.
		expect(rec.sent[1]).toContain(HOOK);
		expect(isExtensionOf(rec.sent[0], rec.sent[1])).toBe(true);
	});

	test("a steered message and a queued follow-up are composed the same way", async () => {
		// Three ways a user message enters the transcript — a prompt, a steer, a
		// queued follow-up — and one rule for all of them: composed before it
		// exists anywhere. A site the rule misses is a rewrite, and a rewrite
		// nothing declared is exactly what the cache report calls a bug.
		const faux = fauxProvider([
			{ toolCalls: [{ name: "noop", arguments: {} }] },
			{ toolCalls: [{ name: "noop", arguments: {} }] },
			{ text: "done" },
			{ text: "done again" },
		]);
		const rec = recording(faux.streamFn);
		// Named before it exists, because both wrappers below have to reach the
		// session *while it runs*: a steer and a follow-up are messages a person
		// sends into a loop that is already going.
		let session: AgentSession;
		let steered = false;
		let queued = false;
		const streamFn: StreamFn = async function* (model, context, options) {
			if (!steered) {
				// Drained ahead of the next model call, so this lands in request 2.
				steered = true;
				session.steer("also check the tests");
			} else if (!queued && context.messages.some((m) => m.role === "toolResult")) {
				// Drained after the first turn that needs no further tool work.
				queued = true;
				session.followUp("and then summarize");
			}
			yield* rec.streamFn(model, context, options);
		};
		session = new AgentSession({
			model: FAUX_MODEL,
			systemPrompt: "sys",
			tools: [noopTool()],
			deps: {
				streamFn,
				hooks: { composeUserMessage: (text) => `${HOOK}\n\n---\n\n${text}` },
			},
		});

		await session.prompt("start");

		expect(userTexts(session)).toEqual([
			`${HOOK}\n\n---\n\nstart`,
			`${HOOK}\n\n---\n\nalso check the tests`,
			`${HOOK}\n\n---\n\nand then summarize`,
		]);
		// Four requests, and every one of them a byte-identical extension of the
		// one before — which is also what says the earlier messages still carry the
		// bytes they were stored with, rather than being rewritten in place.
		expect(rec.sent).toHaveLength(4);
		expect(rec.sent.map((_, i) => i === 0 || isExtensionOf(rec.sent[i - 1], rec.sent[i]))).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	test("with no hook the text is stored as it was given", async () => {
		const faux = fauxProvider([{ text: "done" }]);
		const rec = recording(faux.streamFn);
		const session = new AgentSession({ model: FAUX_MODEL, systemPrompt: "sys", deps: { streamFn: rec.streamFn } });

		await session.prompt("plain");

		expect(userTexts(session)).toEqual(["plain"]);
	});
});
