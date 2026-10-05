/**
 * /beetle's app layer — the picker flow, the settings file, and the dispatch.
 *
 * The band itself is `beetle.test.ts`; this file holds what the REPL actually
 * runs: which lines reach the transcript, what lands in the user's settings
 * file, and what a second `/beetle <task>` does while one is on stage. The
 * picker is a recorder, the band's models all resolve to scripted faux
 * providers, and every test runs against a throwaway home — so the whole flow
 * runs for real without a terminal and without a bill.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type Model } from "@labunbun/ai";
import { createStore } from "@labunbun/tui";
import { beetleUsage } from "../src/beetle.ts";
import {
	type BeetleSurface,
	type BoardTask,
	boardLine,
	createBeetleSurface,
	createToolChangeLatch,
} from "../src/beetle-commands.ts";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

/** Rows the picker offers after "Follow the session model" — `provider/id` refs. */
const ROWS: Model[] = [
	{ ...FAUX_MODEL, provider: "one", id: "m1", name: "one/m1" },
	{ ...FAUX_MODEL, provider: "one", id: "m2", name: "one/m2" },
	{ ...FAUX_MODEL, provider: "two", id: "m3", name: "two/m3" },
];

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
	surface: BeetleSurface;
	notices: string[];
	userEntries: string[];
	/** Every picker opened, in order, with the rows and opening row it was given. */
	opened: Array<{ title: string; labels: string[]; initialIndex: number }>;
	session: AgentSession;
	home: string;
	/** Every tool-block-change cause the surface armed. */
	toolChanges: string[];
	cards: Array<{ title: string; details: Array<[string, string]> }>;
	/** The shared board the surface reads — push rows to seed `/beetle status`. */
	boardTasks: BoardTask[];
	bandToolNames: () => string[];
	savedModels: () => Record<string, string> | null;
}

function makeHarness(
	options: {
		picks?: Array<number | null>;
		initial?: Record<string, string>;
		withSession?: boolean;
		/** Held open before the first pick answers, to freeze a sequence mid-flight. */
		gateFirstPick?: Promise<void>;
	} = {},
): Harness {
	const home = mkdtempSync(join(tmpdir(), "lbb-beetle-"));
	const notices: string[] = [];
	const userEntries: string[] = [];
	const opened: Harness["opened"] = [];
	const toolChanges: string[] = [];
	const cards: Harness["cards"] = [];
	const boardTasks: BoardTask[] = [];
	const answers = [...(options.picks ?? [])];
	const byRef = new Map(ROWS.map((model) => [`${model.provider}/${model.id}`, model]));
	// One provider for every model: these tests assert on flow and lines, never
	// on what a request carried (that is beetle.test.ts's job).
	const streamFn = fauxProvider([{ text: "ok" }]).streamFn;
	const session = new AgentSession({
		model: FAUX_MODEL,
		systemPrompt: "main (test)",
		tools: [],
		deps: { streamFn },
	});
	const surface = createBeetleSurface({
		notify: (line) => notices.push(line),
		pushUserEntry: (text) => userEntries.push(text),
		getSession: () => (options.withSession === false ? null : session),
		pick: async (title, items, initialIndex) => {
			opened.push({ title, labels: items.map((item) => item.label), initialIndex });
			if (options.gateFirstPick && opened.length === 1) await options.gateFirstPick;
			const answer = answers.shift();
			return answer === undefined ? 0 : answer;
		},
		models: ROWS,
		home,
		cwd: process.cwd(),
		allTools: [],
		mcpTools: [],
		streamFn,
		model: () => session.model,
		resolveModel: (ref) => byRef.get(ref),
		canRunModel: () => true,
		thinkingLevel: () => undefined,
		permissionMode: () => "agent",
		sandbox: () => "workspace-write",
		network: () => undefined,
		getPermissionRules: () => [],
		noteToolChange: (cause) => toolChanges.push(cause),
		setStatusCard: (card) => cards.push(card),
		taskBoard: () => boardTasks,
		initialModels: options.initial ?? null,
	});
	const settingsPath = join(home, ".labunbun", "settings.json");
	return {
		surface,
		notices,
		userEntries,
		opened,
		session,
		home,
		toolChanges,
		cards,
		boardTasks,
		bandToolNames: () => session.tools.filter((tool) => tool.name === "BandMessage").map((tool) => tool.name),
		savedModels: () => {
			if (!existsSync(settingsPath)) return null;
			const data = JSON.parse(readFileSync(settingsPath, "utf8")) as { beetle?: { models?: Record<string, string> } };
			return data.beetle?.models ?? null;
		},
	};
}

/** The dispatch surface `/beetle` needs; everything else is absent on purpose. */
function ctxWith(beetle: BeetleSurface | undefined): { ctx: AppCommandContext; infos: () => string[] } {
	const store = createStore<{ entries: Array<{ kind: string; text: string }> }>({ entries: [] });
	const ctx = {
		getSession: () => null,
		handle: { store },
		beetle,
	} as unknown as AppCommandContext;
	return {
		ctx,
		infos: () =>
			store
				.get()
				.entries.filter((entry) => entry.kind === "info")
				.map((entry) => entry.text),
	};
}

describe("the /beetle dispatch", () => {
	test("a bare /beetle and a malformed say print the usage line", () => {
		const { ctx, infos } = ctxWith(makeHarness().surface);
		handleAppCommand("/beetle", ctx);
		handleAppCommand("/beetle say paul", ctx); // no text: usage, not a delivery
		expect(infos()).toEqual([beetleUsage(), beetleUsage()]);
	});

	test("a context with no band answers instead of throwing", () => {
		const { ctx, infos } = ctxWith(undefined);
		expect(handleAppCommand("/beetle do the thing", ctx)).toBe(true);
		expect(infos()[0]).toContain("No band in this context");
	});

	test("say routes through the parsed target and the relay line reaches the transcript", async () => {
		const harness = makeHarness();
		harness.surface.start("a task");
		await tick();
		const { ctx } = ctxWith(harness.surface);
		handleAppCommand("/beetle say john please review the plan", ctx);
		expect(harness.notices).toContain("[beetle] you → John: please review the plan");
	});
});

describe("starting a band", () => {
	test("first start walks four pickers, saves the config, and injects the tool", async () => {
		const harness = makeHarness({ picks: [0, 1, 2, 3] });
		harness.surface.start("ship the thing");
		await tick();

		expect(harness.opened).toHaveLength(4);
		expect(harness.opened[0]?.title).toContain("John (lead) — model 1/4");
		expect(harness.opened[3]?.title).toContain("Ringo (builder) — model 4/4");
		expect(harness.opened[0]?.labels[0]).toBe("* Follow the session model");
		expect(harness.opened[0]?.labels[1]).toContain("one/m1");
		expect(harness.opened.every((picker) => picker.initialIndex === 0)).toBe(true);
		// Picks 1..3 are rows 1..3 of the offered list, one row past the sentinel.
		expect(harness.savedModels()).toEqual({ john: "session", paul: "one/m1", george: "one/m2", ringo: "two/m3" });
		expect(harness.bandToolNames()).toEqual(["BandMessage"]);
		expect(harness.toolChanges).toEqual(["beetle: band tool added"]);
		expect(harness.notices.some((line) => line.startsWith("Band on stage"))).toBe(true);
		// The four briefings went out through the bus, each with a relay line.
		expect(harness.notices.filter((line) => line.includes("you →"))).toHaveLength(4);
	});

	test("a cancel at any step starts nothing and saves nothing", async () => {
		const harness = makeHarness({ picks: [0, null] });
		harness.surface.start("never starts");
		await tick();
		expect(harness.notices).toContain("Band cancelled — nothing started, nothing saved.");
		expect(harness.bandToolNames()).toEqual([]);
		expect(harness.savedModels()).toBeNull();
		expect(harness.session.tools).toHaveLength(0);
	});

	test("a saved config skips the picker entirely", async () => {
		const harness = makeHarness({
			initial: { john: "session", paul: "one/m2", george: "session", ringo: "session" },
		});
		harness.surface.start("straight to work");
		await tick();
		expect(harness.opened).toHaveLength(0);
		expect(harness.bandToolNames()).toEqual(["BandMessage"]);
		expect(harness.notices.some((line) => line.startsWith("Band on stage"))).toBe(true);
	});

	test("a second start while one runs is refused without a second picker or tool", async () => {
		const harness = makeHarness();
		harness.surface.start("first");
		await tick();
		const openedBefore = harness.opened.length;
		harness.surface.start("second");
		await tick();
		expect(harness.opened).toHaveLength(openedBefore);
		expect(harness.notices).toContain("A band is already on stage — /beetle off disbands it first.");
		expect(harness.bandToolNames()).toEqual(["BandMessage"]);
	});

	test("a second start or a reconfigure while the picker is open is refused", async () => {
		const gate = Promise.withResolvers<void>();
		const harness = makeHarness({ gateFirstPick: gate.promise });
		harness.surface.start("first");
		await tick();
		expect(harness.opened).toHaveLength(1);
		harness.surface.start("second");
		harness.surface.configure();
		await tick();
		expect(harness.notices).toEqual([
			"The model picker is still open — answer or cancel it first.",
			"The model picker is still open — answer or cancel it first.",
		]);
		expect(harness.opened).toHaveLength(1); // neither refusal opened anything
		gate.resolve();
		await tick();
		// The first sequence carries on to the end.
		expect(harness.opened).toHaveLength(4);
		expect(harness.notices.some((line) => line.startsWith("Band on stage") && line.endsWith(": first"))).toBe(true);
		expect(harness.bandToolNames()).toEqual(["BandMessage"]);
	});

	test("reconfiguring opens on the live refs and a running band keeps its models", async () => {
		const harness = makeHarness({ picks: [0, 1, 0, 0, 1, 1, 1, 1] });
		harness.surface.start("first");
		await tick();
		expect(harness.savedModels()).toEqual({ john: "session", paul: "one/m1", george: "session", ringo: "session" });
		harness.surface.configure();
		await tick();
		expect(harness.opened).toHaveLength(8);
		const reconfig = harness.opened.slice(4);
		expect(reconfig[0]?.initialIndex).toBe(0); // john follows the session — the first row
		expect(reconfig[1]?.initialIndex).toBe(1); // paul opens on one/m1 itself
		expect(harness.savedModels()).toEqual({ john: "one/m1", paul: "one/m1", george: "one/m1", ringo: "one/m1" });
		expect(harness.notices).toContain(
			"Band models saved — the current band keeps its models; the next one uses these.",
		);
	});

	test("cancelling a reconfigure changes nothing", async () => {
		const harness = makeHarness({ picks: [0, 1, 0, 0, null] });
		harness.surface.start("first");
		await tick();
		const before = harness.savedModels();
		harness.surface.configure();
		await tick();
		expect(harness.opened).toHaveLength(5);
		expect(harness.notices).toContain("Model reconfiguration cancelled — nothing changed.");
		expect(harness.savedModels()).toEqual(before);
	});

	test("off removes the tool, tallies the members, and a new band can start after", async () => {
		const harness = makeHarness();
		harness.surface.start("work it");
		await tick();
		harness.surface.stop();
		expect(harness.bandToolNames()).toEqual([]);
		expect(harness.toolChanges).toEqual(["beetle: band tool added", "beetle: band tool removed"]);
		const tally = harness.notices.find((line) => line.startsWith("Band off."));
		expect(tally).toContain("Final tally:");
		expect(tally).toMatch(/john \(lead\): \d+ turns, \$\d+\.\d{4}/);
		expect(tally).toMatch(/ringo \(builder\): \d+ turns, \$\d+\.\d{4}/);
		// The saved config survives the disband: a restart goes straight to work.
		harness.surface.start("again");
		await tick();
		expect(harness.opened).toHaveLength(4); // from the first start only
		expect(harness.bandToolNames()).toEqual(["BandMessage"]);
	});

	test("with no band, off and say both say so", () => {
		const harness = makeHarness();
		harness.surface.stop();
		harness.surface.say("john", "hello?");
		expect(harness.notices).toEqual(["No band is on stage.", "No band is on stage — start one with /beetle <task>."]);
	});

	test("status with no band says so; with one it draws the card and the settled summary", async () => {
		const harness = makeHarness();
		harness.surface.status();
		expect(harness.notices).toEqual(["No band yet — start one with /beetle <task>."]);
		harness.surface.start("status me");
		// Poll until the members' one-step scripts have finished: 0 running is the
		// only deterministic summary, and it is reached within a few ticks. The
		// board line trails the tally, so the tally is second-to-last.
		for (let i = 0; i < 50; i++) {
			await tick();
			harness.surface.status();
			if ((harness.notices.at(-2) ?? "").startsWith("Band: 0/4 running")) break;
		}
		expect(harness.cards.at(-1)?.title).toBe("Beetle band");
		expect(harness.cards.at(-1)?.details.map(([label]) => label)).toEqual([
			"john (lead)",
			"paul (implementer)",
			"george (verifier)",
			"ringo (builder)",
		]);
		// One briefing turn each, faux rows have no price: the tail is exact (the
		// model name leads the row and lastActivity may trail it).
		expect(harness.cards.at(-1)?.details[0]?.[1]).toMatch(/ · idle · 1 turns · \$0\.0000 unpriced( · .+)?$/);
		expect(harness.notices.at(-2)).toBe("Band: 0/4 running · 4 turns · $0.0000");
		expect(harness.notices.at(-1)).toBe("Board: no tasks yet.");
	});

	test("status adds the board summary as its last line", async () => {
		const harness = makeHarness();
		harness.surface.start("board test");
		// The board line needs a band (status reads the work alongside the band);
		// poll past the first start, then seed and read.
		for (let i = 0; i < 50; i++) {
			await tick();
			harness.surface.status();
			if (harness.notices.some((line) => line.startsWith("Band: "))) break;
		}
		harness.boardTasks.push(
			{ id: "1", subject: "Wire the bridge", status: "in_progress", owner: "paul" },
			{ id: "2", subject: "Mix the tape", status: "pending" },
			{ id: "3", subject: "Ship it", status: "completed", owner: "ringo" },
		);
		harness.surface.status();
		expect(harness.notices.at(-1)).toBe(
			"Board: 3 tasks · in_progress: #1 Wire the bridge (paul) · 1 pending · 1 completed",
		);
	});

	test("a mention routes to the member when a band is on stage and passes through when not", async () => {
		const harness = makeHarness();
		expect(harness.surface.handleMention("@john take a look")).toBe(false);
		expect(harness.userEntries).toEqual([]);
		harness.surface.start("mention test");
		await tick();
		expect(harness.surface.handleMention("@john take a look")).toBe(true);
		expect(harness.userEntries).toEqual(["@john take a look"]);
		expect(harness.notices).toContain("[beetle] you → John: take a look");
		// Not a member, not a mention: the main session keeps the line.
		expect(harness.surface.handleMention("@nobody hi")).toBe(false);
		// Disbanded: mentions pass through again.
		harness.surface.stop();
		expect(harness.surface.handleMention("@john one more")).toBe(false);
		expect(harness.userEntries).toEqual(["@john take a look"]);
	});
});

describe("boardLine", () => {
	test.each([
		["an empty board", [], "Board: no tasks yet."],
		[
			"a single task reads singular",
			[{ id: "1", subject: "Tune the kit", status: "pending" }],
			"Board: 1 task · 1 pending · 0 completed",
		],
		[
			"in_progress leads, owner in parentheses",
			[
				{ id: "2", subject: "Wire the bridge", status: "in_progress", owner: "paul" },
				{ id: "3", subject: "Mix the tape", status: "pending" },
				{ id: "4", subject: "Book the hall", status: "completed" },
			],
			"Board: 3 tasks · in_progress: #2 Wire the bridge (paul) · 1 pending · 1 completed",
		],
		[
			"an ownerless in_progress task renders without parentheses",
			[{ id: "5", subject: "Soundcheck", status: "in_progress" }],
			"Board: 1 task · in_progress: #5 Soundcheck · 0 pending · 0 completed",
		],
		[
			"several in progress list in board order",
			[
				{ id: "1", subject: "Drums", status: "in_progress", owner: "ringo" },
				{ id: "2", subject: "Bass", status: "in_progress", owner: "paul" },
			],
			"Board: 2 tasks · in_progress: #1 Drums (ringo), #2 Bass (paul) · 0 pending · 0 completed",
		],
		[
			"nothing in progress leaves the segment out",
			[{ id: "1", subject: "Done", status: "completed" }],
			"Board: 1 task · 0 pending · 1 completed",
		],
	] as Array<[string, BoardTask[], string]>)("renders %s", (_label, tasks, expected) => {
		expect(boardLine(tasks)).toBe(expected);
	});
});

describe("the tool-change latch", () => {
	test("registers the armed cause on the session's own next turn_start, once", () => {
		const noted: string[] = [];
		const latch = createToolChangeLatch((cause) => noted.push(cause));
		latch.arm("beetle: band tool added");
		latch.observe({ type: "tool_execution_end" }); // other events are not consumers
		expect(noted).toEqual([]);
		latch.observe({ type: "turn_start" });
		expect(noted).toEqual(["beetle: band tool added"]);
		latch.observe({ type: "turn_start" }); // registered once, not on every turn
		expect(noted).toHaveLength(1);
		latch.observe({ type: "tool_execution_end" }); // nothing armed: nothing fires
		expect(noted).toHaveLength(1);
		// Two arms before a turn: the newest cause is the one that registers.
		latch.arm("beetle: band tool added");
		latch.arm("beetle: band tool removed");
		latch.observe({ type: "turn_start" });
		expect(noted).toEqual(["beetle: band tool added", "beetle: band tool removed"]);
	});
});
