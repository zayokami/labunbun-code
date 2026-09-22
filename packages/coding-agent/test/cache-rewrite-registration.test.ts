/**
 * Rewrites the app makes on purpose, and the report's right to know about them.
 *
 * A prefix rewrite the app meant to make and a prefix rewrite nothing admitted
 * to look identical from the wire; the difference is visible only to the code
 * that made the change. These tests are about that code telling the cache
 * report, because the report's only other option is to call the session buggy.
 *
 * The commands are driven through `handleCommandDispatch`, not called directly,
 * because the wiring between a command and the tracker is one of the things
 * that can be missing — a command that registers its rewrite with the wrong
 * listener is a command that did not register anything.
 */
import { describe, expect, test } from "bun:test";
import type { AgentSession, CompactionManager, SessionStore } from "@labunbun/agent";
import { type Context, userMessage } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { rewriteCause } from "../src/cache-report.ts";
import { builtInCommands } from "../src/commands.ts";
import { type AppCommandContext, handleAppCommand, handleCommandDispatch } from "../src/interactive.ts";

/** A context small enough to be legal and big enough to be measured. */
function context(): Context {
	return { systemPrompt: "sys", messages: [userMessage("hello")], tools: [] };
}

/** Let the fire-and-forget command path reach its `await`s. */
async function settled(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface Notes {
	/** Every cause this context was told about, in order. */
	causes: string[];
}

/**
 * The transcript the context's session holds.
 *
 * Read back through the context rather than from a variable the test kept: a
 * command reaches its session through `getSession()`, and a test holding its
 * own reference would be watching a different object.
 */
function userTexts(ctx: AppCommandContext): string[] {
	const messages = ctx.getSession()?.messages ?? [];
	return messages.flatMap((m) => (m.role === "user" && typeof m.content === "string" ? [m.content] : []));
}

/**
 * The smallest context the commands under test read: a session, a compaction
 * manager whose answers are scripted, and a cache recorder.
 */
function makeCtx(
	notes: Notes,
	options: {
		session?: Partial<AgentSession>;
		compaction?: Partial<CompactionManager>;
		sessionStore?: () => SessionStore | undefined;
	} = {},
): AppCommandContext {
	const session = {
		currentContext: () => context(),
		messages: [],
		applyCompaction: () => {},
		...options.session,
	};
	const store = createStore<UiState>({ ...initialUiState(false) });
	return {
		getSession: () => session as AgentSession,
		handle: { store },
		backgroundShells: { list: () => [], output: () => "", kill: () => false },
		refreshBackgroundShells: () => {},
		settings: {} as never,
		cwd: process.cwd(),
		costTracker: { state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} } } as never,
		cache: {
			report: () => "",
			statusLine: () => "",
			note: (cause: string) => notes.causes.push(cause),
		},
		baseRules: [],
		sessionRules: [],
		// The real registry: `/compact` and `/trim` are built-in commands, and a
		// dispatch test against an empty registry would test nothing.
		commands: builtInCommands(),
		compaction: () => options.compaction as CompactionManager,
		mcpConnections: [],
		mcpConfig: {},
		pendingMcpApprovals: [],
		sessionStore: options.sessionStore ?? (() => undefined),
		theme: { theme: {} as never, available: [], problems: [] },
		refreshContextInfo: () => {},
		hotSwapSession: async () => {},
		switchModel: () => false,
		loadedSettings: {} as never,
		pad: null,
		padWatch: { toggle: () => false, stop: () => {} },
	} as unknown as AppCommandContext;
}

describe("an automatic rewrite is registered where it is decided", () => {
	test("a summary and a trim are named differently", () => {
		// The rung that fires on its own and the command a person types describe
		// the same rewrite; from the wire they are indistinguishable, so the word
		// is only checkable here.
		expect([rewriteCause("compact"), rewriteCause("reduced")]).toEqual(["compaction", "trim"]);
	});
});

describe("/compact", () => {
	test("registers the rewrite, then adopts what it produced", async () => {
		const notes: Notes = { causes: [] };
		const applied: Context[] = [];
		const compacted = { systemPrompt: "sys", messages: [userMessage("summary")], tools: [] };
		const ctx = makeCtx(notes, {
			session: { applyCompaction: (next: Context) => applied.push(next) },
			compaction: { compact: (async () => compacted) as unknown as CompactionManager["compact"] },
		});

		expect(handleCommandDispatch("/compact", ctx)).toBe(true);
		await settled(() => notes.causes.length > 0);

		expect(notes.causes).toEqual(["compaction"]);
		// Registered *and* adopted: a command that reported success without
		// applying anything would leave the cache blamed for a rewrite that was
		// never made.
		expect(applied).toEqual([compacted]);
	});

	test("registers nothing when compaction is not available", async () => {
		const notes: Notes = { causes: [] };
		const ctx = makeCtx(notes, { compaction: undefined });
		handleCommandDispatch("/compact", ctx);
		await settled(() => false, 50);

		expect(notes.causes).toEqual([]);
	});
});

describe("/trim", () => {
	test("registers the trim it made", async () => {
		const notes: Notes = { causes: [] };
		const applied: Context[] = [];
		const trimmed = { systemPrompt: "sys", messages: [userMessage("preview")], tools: [] };
		const ctx = makeCtx(notes, {
			session: { applyCompaction: (next: Context) => applied.push(next) },
			compaction: {
				trim: (() => ({
					context: trimmed,
					cleared: { results: 2, chars: 400 },
				})) as unknown as CompactionManager["trim"],
			},
		});

		handleCommandDispatch("/trim", ctx);
		await settled(() => notes.causes.length > 0);

		expect(notes.causes).toEqual(["trim"]);
		expect(applied).toEqual([trimmed]);
	});

	test("registers nothing when there was nothing to trim", async () => {
		// A registered cause with no rewrite behind it would explain away the next
		// genuine miss — which is the one thing the report exists to catch.
		const notes: Notes = { causes: [] };
		const ctx = makeCtx(notes, {
			compaction: { trim: (() => null) as unknown as CompactionManager["trim"] },
		});

		handleCommandDispatch("/trim", ctx);
		await settled(() => false, 50);

		expect(notes.causes).toEqual([]);
	});
});

describe("/fork", () => {
	function forkStore(known: string): SessionStore {
		const restored = [userMessage("from the branch")];
		return {
			branch: (id: string) => id === known,
			contextMessages: () => restored,
		} as unknown as SessionStore;
	}

	test("registers the branch before the transcript is replaced", () => {
		const notes: Notes = { causes: [] };
		const ctx = makeCtx(notes, {
			session: { messages: [userMessage("on the old branch")] },
			sessionStore: () => forkStore("abc12345"),
		});

		expect(handleAppCommand("/fork abc12345", ctx)).toBe(true);

		expect(notes.causes).toEqual(["fork"]);
		// The new branch is a different prefix from the branch point down, so the
		// next request misses there — and it is the branch the user asked for.
		expect(userTexts(ctx)).toEqual(["from the branch"]);
	});

	test("a branch that did not happen registers nothing", () => {
		const notes: Notes = { causes: [] };
		const ctx = makeCtx(notes, {
			session: { messages: [userMessage("kept")] },
			sessionStore: () => forkStore("abc12345"),
		});

		expect(handleAppCommand("/fork nosuchid", ctx)).toBe(true);

		expect(notes.causes).toEqual([]);
		// The transcript is untouched: an id that matched nothing is not a rewrite.
		expect(userTexts(ctx)).toEqual(["kept"]);
	});
});
