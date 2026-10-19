/**
 * What a run does when it cannot even get its first message down.
 *
 * Admission is the step before the first turn: composing the stored text,
 * writing it to the session file, and announcing the start. Each of those can
 * fail for reasons that have nothing to do with the model — a disk that is full,
 * a hook with a bug — and the failure used to escape `prompt()` before the
 * `finally` that clears the running flag. The session then answered "already
 * running" forever. These tests pin the contract that replaced it: the call
 * resolves `"error"`, the event stream opens and closes exactly once, the
 * transcript is unchanged, and the next prompt is still accepted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentMessage, FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { type AgentEvent, AgentSession, type SessionEntry, SessionStore } from "../src/index.ts";
import { runHarness } from "./harness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

/** A store whose disk has room for the header and none for the conversation. */
class RefusingStore extends SessionStore {
	failures = 0;

	override appendMessage(_message: AgentMessage): SessionEntry {
		this.failures++;
		throw new Error("ENOSPC: no space left on device");
	}
}

function ends(events: AgentEvent[]): Array<Extract<AgentEvent, { type: "agent_end" }>> {
	return events.filter((event): event is Extract<AgentEvent, { type: "agent_end" }> => event.type === "agent_end");
}

describe("a prompt whose admission fails", () => {
	test("a refusing session file ends the run and leaves the session usable", async () => {
		const seed = SessionStore.startNew(tmpDir("lbb-admit-cwd-"), tmpDir("lbb-admit-home-"));
		const store = new RefusingStore(seed.path);
		// The stream must never be reached: admission fails before the first turn.
		const neverCalled: StreamFn = () => {
			throw new Error("the stream must not be reached");
		};
		const session = new AgentSession({ model: FAUX_MODEL, store, deps: { streamFn: neverCalled } });
		const events: AgentEvent[] = [];
		session.on((event) => {
			events.push(event);
		});

		expect(await session.prompt("hello")).toBe("error");

		// Open and close as a pair, even though no turn ever started.
		expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
		expect(ends(events)[0]?.reason).toBe("error");
		expect(ends(events)[0]?.errorMessage).toContain("ENOSPC");
		expect(session.isRunning).toBe(false);
		expect(session.isInterrupted).toBe(false);
		// Nothing reached memory either: the provider must never be sent a message
		// that no resume can find.
		expect(session.messages).toEqual([]);

		// A failed admission is not a wedge: the next call still reaches the loop
		// (and fails on the same disk) instead of throwing "already running".
		expect(await session.prompt("again")).toBe("error");
		expect(store.failures).toBe(2);
	});

	test("a hook that throws loses the prompt but not the session", async () => {
		const { session, events, reason } = await runHarness([{ text: "never sent" }], {
			depsOverrides: {
				hooks: {
					composeUserMessage: async () => {
						throw new Error("hook exploded");
					},
				},
			},
		});

		expect(reason).toBe("error");
		expect(events.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
		expect(ends(events)[0]?.errorMessage).toBe("hook exploded");
		expect(session.messages).toEqual([]);
		expect(session.isRunning).toBe(false);
	});
});

describe("what agent_end says about a failed run", () => {
	test("the provider's kind and the host's remedy travel with the ending", async () => {
		const { events, reason } = await runHarness(
			[{ stopReason: "error", errorMessage: "slow down", errorKind: "rate_limit" }],
			{
				depsOverrides: {
					errorRemedy: (kind) => (kind === "rate_limit" ? "Wait a few seconds, then retry." : undefined),
				},
			},
		);

		expect(reason).toBe("error");
		const ending = ends(events)[0];
		expect(ending?.errorKind).toBe("rate_limit");
		expect(ending?.errorRemedy).toBe("Wait a few seconds, then retry.");
		expect(ending?.errorMessage).toBe("slow down");
	});

	test("a host that has no advice adds no remedy field", async () => {
		const { events } = await runHarness([{ stopReason: "error", errorMessage: "nope" }]);

		const ending = ends(events)[0];
		expect(ending?.errorKind).toBeUndefined();
		expect(ending && "errorRemedy" in ending).toBe(false);
	});
});

describe("fallback notices", () => {
	test("a wrapper's notice reaches subscribers as a fallback event", async () => {
		const faux = fauxProvider([{ text: "recovered" }]);
		const streamFn: StreamFn = async function* (model, context, options) {
			options?.onFallback?.({
				from: { provider: "anthropic", id: "primary" },
				to: { provider: "openai", id: "backup" },
				reason: "rate limited",
				errorKind: "rate_limit",
			});
			yield* faux.streamFn(model, context, options);
		};

		const { events, reason } = await runHarness([{ text: "recovered" }], { depsOverrides: { streamFn } });

		expect(reason).toBe("completed");
		expect(events.find((event) => event.type === "fallback")).toEqual({
			type: "fallback",
			from: { provider: "anthropic", id: "primary" },
			to: { provider: "openai", id: "backup" },
			reason: "rate limited",
			errorKind: "rate_limit",
		});
	});
});
