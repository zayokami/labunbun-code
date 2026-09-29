/**
 * `/mode` picks a *pair*: a permission mode and a sandbox mode, which are two
 * axes and not one list (see `MODE_CHOICES` in `@labunbun/agent`).
 *
 * The no-argument path is the one that matters here. A usage line is a dead end
 * for a user whose only keyboard is a controller — `R3` runs this command, and
 * for a while that button printed the list of modes it could not choose between
 * — so the command opens the same picker `/model` and `/theme` do. What is
 * under test is the wiring: which rows the list offers, which one it opens on,
 * and that confirming is what changes the session's two axes.
 *
 * The star is the part most likely to go quietly wrong. Two of the four rows
 * share a mode and differ only in the sandbox, so a marker keyed on the mode
 * alone would light up two rows and leave the user unable to tell which
 * confinement they are in.
 */
import { describe, expect, test } from "bun:test";
import {
	AgentSession,
	DEFAULT_MODE_CHOICE,
	findModeChoice,
	MODE_CHOICES,
	PERMISSION_MODES,
	type PermissionMode,
	type SandboxMode,
} from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pick {
	title: string;
	items: Array<{ label: string; description?: string }>;
	initialIndex?: number;
}

function makeCtx(pair?: { mode: PermissionMode; sandbox: SandboxMode }) {
	const store = createStore<UiState>(initialUiState(false));
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		deps: { streamFn: faux.streamFn },
		...(pair ? { permissionMode: pair.mode, sandbox: pair.sandbox } : {}),
	});

	const picks: Pick[] = [];
	let settle: ((index: number | null) => void) | undefined;
	const ctx = {
		getSession: () => session,
		handle: {
			store,
			pickFromList: (title: string, items: Pick["items"], options?: Pick) => {
				picks.push({ title, items, ...options });
				return new Promise<number | null>((resolve) => {
					settle = resolve;
				});
			},
		},
	} as unknown as AppCommandContext;

	return { ctx, store, session, picks, finish: (index: number | null) => settle?.(index) };
}

const infoTexts = (store: { get: () => UiState }) =>
	store
		.get()
		.entries.filter((e) => e.kind === "info")
		.map((e) => (e as { text: string }).text)
		.join("\n");

/** The labels, with the active-row marker taken off. */
const rowNames = (pick: Pick) => pick.items.map((item) => item.label.replace(/^\*\s+|^\s+/, ""));

/** The one row marked as the current choice, if any. */
const markedRow = (pick: Pick) => pick.items.find((item) => item.label.startsWith("*"))?.label;

/** `/mode` with no argument, waited on: the list opens on a later tick. */
async function openPicker(pair?: { mode: PermissionMode; sandbox: SandboxMode }) {
	const h = makeCtx(pair);
	expect(handleAppCommand("/mode", h.ctx)).toBe(true);
	for (let i = 0; i < 100 && h.picks.length === 0; i++) await delay(10);
	expect(h.picks).toHaveLength(1);
	return { ...h, pick: h.picks[0] };
}

describe("/mode with a name", () => {
	test("applies both axes and says so, without opening anything", () => {
		const h = makeCtx();
		expect(handleAppCommand("/mode plan", h.ctx)).toBe(true);

		expect(h.session.permissionMode).toBe("plan");
		expect(h.session.sandbox).toBe("workspace-write");
		expect(h.picks).toHaveLength(0);
		expect(infoTexts(h.store)).toBe("Mode: Plan (plan · sandbox workspace-write)");
	});

	/**
	 * The single-source claim, walked over the picker.
	 *
	 * `types.ts` says every consumer reads `MODE_CHOICES` rather than re-spelling
	 * it, and that claim was made before and was false — a hand-written
	 * `z.enum` in `settings.ts` carried a second copy of the mode list. A test
	 * that only names `PERMISSION_MODES` cannot catch a fifth row, or a row whose
	 * id the command does not accept, so this walks the rows themselves: one
	 * `/mode` per row, asserting the session ends up on *that row's* pair.
	 */
	test("every choice the agent publishes is one the command applies", () => {
		for (const choice of MODE_CHOICES) {
			const h = makeCtx();
			handleAppCommand(`/mode ${choice.id}`, h.ctx);
			expect(h.session.permissionMode).toBe(choice.mode);
			expect(h.session.sandbox).toBe(choice.sandbox);
			expect(infoTexts(h.store)).toBe(`Mode: ${choice.label} (${choice.mode} · sandbox ${choice.sandbox})`);
		}
	});

	/**
	 * A bare mode name is the same as the confined row, and must not be a way to
	 * keep whatever confinement the session happened to have.
	 */
	test("a bare mode name means that mode under confinement, not 'keep the sandbox'", () => {
		for (const mode of PERMISSION_MODES) {
			const h = makeCtx({ mode, sandbox: "danger-full-access" });
			handleAppCommand(`/mode ${mode}`, h.ctx);
			expect(h.session.permissionMode).toBe(mode);
			expect(h.session.sandbox).toBe("workspace-write");
		}
	});

	test("a name that is not a mode is refused with the names that are", () => {
		const h = makeCtx({ mode: "plan", sandbox: "workspace-write" });
		handleAppCommand("/mode plna", h.ctx);

		expect(h.session.permissionMode).toBe("plan");
		expect(h.session.sandbox).toBe("workspace-write");
		expect(h.picks).toHaveLength(0);
		expect(infoTexts(h.store)).toBe(`Usage: /mode ${MODE_CHOICES.map((c) => c.id).join("|")}`);
	});
});

describe("/mode without an argument", () => {
	test("offers every choice, marking the one in force", async () => {
		const h = await openPicker();
		expect(rowNames(h.pick)).toEqual(MODE_CHOICES.map((c) => c.label));
		expect(h.pick.title).toBe("Mode");
		expect(markedRow(h.pick)).toBe(`* ${DEFAULT_MODE_CHOICE.label}`);
		expect(h.pick.initialIndex).toBe(0);
		// A row with no explanation is a choice the user has to look up elsewhere,
		// and the list is the only place the difference is written down.
		expect(h.pick.items.every((item) => (item.description ?? "").length > 0)).toBe(true);
		h.finish(null);
	});

	/**
	 * The star is keyed on the pair, and this is the case that proves it.
	 *
	 * `agent` and `Agent 无沙箱` differ only in the sandbox axis. A marker that
	 * looked the row up by mode would put a star on both, and the user would have
	 * no way to tell which of the two the session is actually running under — the
	 * one number on that screen that decides what a command can reach.
	 */
	test.each([
		["agent", "workspace-write", "Agent"],
		["agent", "danger-full-access", "Agent 无沙箱"],
	] as const)("opens on %s with sandbox %s, and only that row is marked", async (mode, sandbox, label) => {
		const h = await openPicker({ mode, sandbox });
		const index = MODE_CHOICES.findIndex((c) => c.mode === mode && c.sandbox === sandbox);
		expect(index).toBeGreaterThanOrEqual(0);
		expect(markedRow(h.pick)).toBe(`* ${label}`);
		expect(h.pick.initialIndex).toBe(index);
		expect(h.pick.items.filter((item) => item.label.startsWith("*"))).toHaveLength(1);
		h.finish(null);
	});

	test("confirming a row sets both axes", async () => {
		const h = await openPicker();
		const index = MODE_CHOICES.findIndex((c) => c.id === "agentNoSandbox");
		h.finish(index);
		await delay(10);

		expect(h.session.permissionMode).toBe("agent");
		expect(h.session.sandbox).toBe("danger-full-access");
		expect(infoTexts(h.store)).toBe("Mode: Agent 无沙箱 (agent · sandbox danger-full-access)");
	});

	test("cancelling leaves both axes alone and says nothing", async () => {
		const h = await openPicker({ mode: "plan", sandbox: "workspace-write" });
		h.finish(null);
		await delay(10);

		expect(h.session.permissionMode).toBe("plan");
		expect(h.session.sandbox).toBe("workspace-write");
		expect(infoTexts(h.store)).toBe("");
	});
});

describe("the choice list itself", () => {
	/**
	 * The four rows are compositions of the two axes, so a row that repeats
	 * another row is a row a user can select and get no change from. The pair is
	 * the row's identity, and it is what `findModeChoice` resolves against.
	 */
	test("no two choices name the same pair", () => {
		const pairs = MODE_CHOICES.map((c) => `${c.mode} ${c.sandbox}`);
		expect(new Set(pairs).size).toBe(pairs.length);
	});

	test("every id resolves to its own row", () => {
		for (const choice of MODE_CHOICES) {
			expect(findModeChoice(choice.id)).toBe(choice);
		}
		expect(findModeChoice("nope")).toBeUndefined();
	});

	/**
	 * The unconfined row is spelled with a different id from its mode on purpose:
	 * two rows share the mode `agent`, so an id equal to the mode would make one
	 * of them unaddressable. If this ever fails, the second row lost its name.
	 */
	test("the unconfined row is addressable by an id of its own", () => {
		const unconfined = MODE_CHOICES.filter((c) => c.sandbox === "danger-full-access");
		expect(unconfined).toHaveLength(1);
		expect(findModeChoice(unconfined[0].mode)).toBeDefined();
		expect(unconfined[0].id).not.toBe(unconfined[0].mode);
	});
});
