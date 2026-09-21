/**
 * `/mode` with a name applies it; `/mode` alone opens a list.
 *
 * The no-argument path is the one that matters here. A usage line is a dead end
 * for a user whose only keyboard is a controller — `R3` runs this command, and
 * for a while that button printed the list of modes it could not choose between
 * — so the command now opens the same picker `/model` and `/theme` do. What is
 * under test is the wiring: which rows the list offers, which one it opens on,
 * and that confirming is what changes the mode.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession, PERMISSION_MODES, type PermissionMode } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { createStore, initialUiState, type UiState } from "@labunbun/tui";
import { type AppCommandContext, handleAppCommand } from "../src/interactive.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pick {
	title: string;
	items: Array<{ label: string; description?: string }>;
	initialIndex?: number;
}

function makeCtx(mode?: PermissionMode) {
	const store = createStore<UiState>(initialUiState(false));
	const faux = fauxProvider([{ text: "n/a" }]);
	const session = new AgentSession({
		model: FAUX_MODEL,
		deps: { streamFn: faux.streamFn },
		...(mode ? { permissionMode: mode } : {}),
	});

	const picks: Pick[] = [];
	let settle: ((index: number | null) => void) | undefined;
	const ctx = {
		getSession: () => session,
		sessionRef: session,
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
async function openPicker(mode?: PermissionMode) {
	const h = makeCtx(mode);
	expect(handleAppCommand("/mode", h.ctx)).toBe(true);
	for (let i = 0; i < 100 && h.picks.length === 0; i++) await delay(10);
	expect(h.picks).toHaveLength(1);
	return { ...h, pick: h.picks[0] };
}

describe("/mode with a name", () => {
	test("applies it and says so, without opening anything", () => {
		const h = makeCtx();
		expect(handleAppCommand("/mode plan", h.ctx)).toBe(true);

		expect(h.session.permissionMode).toBe("plan");
		expect(h.picks).toHaveLength(0);
		expect(infoTexts(h.store)).toBe("Permission mode: plan");
	});

	test("every mode the agent knows is a mode the command accepts", () => {
		// The list is the single source of truth for what is valid, so a mode added
		// there is one this command takes without any other file changing.
		for (const mode of PERMISSION_MODES) {
			const h = makeCtx();
			handleAppCommand(`/mode ${mode}`, h.ctx);
			expect(h.session.permissionMode).toBe(mode);
			expect(infoTexts(h.store)).toBe(`Permission mode: ${mode}`);
		}
	});

	test("a name that is not a mode is refused with the names that are", () => {
		const h = makeCtx("plan");
		handleAppCommand("/mode plna", h.ctx);

		expect(h.session.permissionMode).toBe("plan");
		expect(h.picks).toHaveLength(0);
		expect(infoTexts(h.store)).toBe(`Usage: /mode ${PERMISSION_MODES.join("|")}`);
	});
});

describe("/mode without an argument", () => {
	test("offers every mode, marking the one in force", async () => {
		const h = await openPicker();
		expect(rowNames(h.pick)).toEqual([...PERMISSION_MODES]);
		expect(h.pick.title).toBe("Permission mode");
		expect(markedRow(h.pick)).toBe("* default");
		expect(h.pick.initialIndex).toBe(0);
		// A row with no explanation is a mode the user has to look up elsewhere, and
		// the list is the only place the difference is written down.
		expect(h.pick.items.every((item) => (item.description ?? "").length > 0)).toBe(true);
		h.finish(null);
	});

	test("opens on the mode the session is already in", async () => {
		const h = await openPicker("dontAsk");
		expect(markedRow(h.pick)).toBe("* dontAsk");
		expect(h.pick.initialIndex).toBe(PERMISSION_MODES.indexOf("dontAsk"));
		expect(h.pick.items.filter((item) => item.label.startsWith("*"))).toHaveLength(1);
		h.finish(null);
	});

	test("confirming a row sets the mode", async () => {
		const h = await openPicker();
		const index = PERMISSION_MODES.indexOf("bypassPermissions");
		h.finish(index);
		await delay(10);

		expect(h.session.permissionMode).toBe("bypassPermissions");
		expect(infoTexts(h.store)).toBe("Permission mode: bypassPermissions");
	});

	test("cancelling leaves the mode alone and says nothing", async () => {
		const h = await openPicker("plan");
		h.finish(null);
		await delay(10);

		expect(h.session.permissionMode).toBe("plan");
		expect(infoTexts(h.store)).toBe("");
	});
});
