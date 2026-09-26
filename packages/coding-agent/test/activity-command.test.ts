/**
 * `/activity`, wired.
 *
 * The formatter has its own test. This one is about the four things that can be
 * wrong while every number in the sentence is right: the panel is handed the
 * wrong home (which would put a real user's history on screen, or an empty one),
 * the range argument is dropped, an unrecognised range opens the panel anyway,
 * and the transcript line is never written at all because the walk threw.
 *
 * The sessions are written through `SessionStore` rather than by hand. That is
 * what keeps this fixture honest: if the on-disk format changes, these files
 * change shape with it, instead of going quietly out of date beside the
 * collector that has to read them.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActivityRange, SessionStore } from "@labunbun/agent";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, appCommandTable, handleAppCommand } from "../src/interactive.ts";

/** What the command asked the panel to show, in order. */
type Shown = Array<{ home: string | undefined; range: ActivityRange | undefined }>;

function makeCtx() {
	const home = mkdtempSync(join(tmpdir(), "lbb-activity-"));
	const cwd = join(home, "project");
	const store = createStore<UiState>({ ...initialUiState(false) });
	const shown: Shown = [];

	const ctx = {
		getSession: () => null,
		handle: {
			store,
			showActivity: (h: string | undefined, range?: ActivityRange) => shown.push({ home: h, range }),
			clearActivity: () => shown.push({ home: undefined, range: undefined }),
		},
		home,
		cwd,
		settings: {},
		costTracker: {
			state: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
			sessionState: { totalCostUSD: 0, totalDurationMs: 0, modelsUsage: {} },
		},
		baseRules: [],
		sessionRules: [],
		commands: [],
	} as unknown as AppCommandContext;

	return {
		ctx,
		home,
		shown,
		store,
		clean: () => rmSync(home, { recursive: true, force: true }),
		info: () =>
			store
				.get()
				.entries.filter((e) => e.kind === "info")
				.map((e) => (e as { text: string }).text)
				.join("\n"),
	};
}

/** One real session with one real message, in the temp home. */
function seedSession(home: string, cwd: string) {
	const store = SessionStore.startNew(cwd, home);
	store.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	return store;
}

describe("/activity", () => {
	test("opens the panel on the session home, not the real one", () => {
		const h = makeCtx();
		try {
			expect(handleAppCommand("/activity", h.ctx)).toBe(true);
			expect(h.shown).toHaveLength(1);
			// The walk behind the panel reads whatever home it is given. Handing it
			// `undefined` would fall back to the real one and put every session the
			// user has ever run on screen, which is a different command from this.
			expect(h.shown[0]?.home).toBe(h.home);
		} finally {
			h.clean();
		}
	});

	test("with no argument it leaves the range to the panel, which opens on a month", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/activity", h.ctx);
			expect(h.shown[0]?.range).toBeUndefined();
		} finally {
			h.clean();
		}
	});

	test("each range is passed through, so `r` starts where the user asked", () => {
		for (const range of ["7d", "30d", "all"] as const) {
			const h = makeCtx();
			try {
				expect(handleAppCommand(`/activity ${range}`, h.ctx)).toBe(true);
				expect(h.shown[0]?.range).toBe(range);
			} finally {
				h.clean();
			}
		}
	});

	// A typo that opened the panel would be worse than one that did not: the user
	// would be looking at a month of history they did not ask for, with no way to
	// tell that the argument they typed was never read.
	test("an unrecognised range explains itself and opens nothing", () => {
		const h = makeCtx();
		try {
			expect(handleAppCommand("/activity fortnight", h.ctx)).toBe(true);
			expect(h.shown).toHaveLength(0);
			expect(h.info()).toContain("Usage: /activity");
		} finally {
			h.clean();
		}
	});

	test("leaves a summary line in the transcript, where the panel cannot follow", () => {
		const h = makeCtx();
		try {
			seedSession(h.home, h.ctx.cwd);
			handleAppCommand("/activity 7d", h.ctx);
			// A session written a moment ago is today's, so the streak is a single
			// day and the line says so in the singular. An empty walk would also
			// produce a line — the point is that a real one produces *this* one.
			expect(h.info()).toContain("Current streak 1 day");
			expect(h.info()).toContain("1 active day");
		} finally {
			h.clean();
		}
	});

	test("a home with no sessions says so instead of claiming a zero streak", () => {
		const h = makeCtx();
		try {
			handleAppCommand("/activity", h.ctx);
			expect(h.info()).toContain("nothing recorded");
		} finally {
			h.clean();
		}
	});

	// `/help` is generated from this table, and the table is what keeps a `case`
	// from being added without a description — the `/theme` bug. Asserted here as
	// well as in help-commands.test.ts because the description is a sentence
	// about this command's own shape, and that is the part a generic "is it
	// documented" check cannot see.
	test("the help row names the ranges the parser accepts", () => {
		const row = appCommandTable().find(([name]) => name === "/activity")?.[1] ?? "";
		expect(row).toContain("7d|30d|all");
		expect(row).toContain("streak");
	});
});
