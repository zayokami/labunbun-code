/**
 * The first frame.
 *
 * An empty session used to draw a bare prompt and nothing else: no product
 * name, no version, no sign of what the program does. The banner is the one
 * screen a new user reads before typing, so these tests hold the facts it has
 * to carry — identity, version, workspace, and the keys out — and the heights
 * and widths at which it steps aside so the prompt always fits.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { render } from "ink-testing-library";
import type React from "react";
import { REPL } from "../src/components/REPL.tsx";
import { fitPath, TIPS, WelcomeBanner, welcomeLayout } from "../src/components/WelcomeBanner.tsx";
import { createStore } from "../src/store.ts";
import { DARK_THEME, type Theme, ThemeContext } from "../src/theme.ts";
import { initialUiState, type UiState } from "../src/ui-state.ts";

function withTheme(node: React.ReactNode, theme: Theme = DARK_THEME) {
	return <ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>;
}

function flat(frame: string | undefined): string {
	return (frame ?? "").replace(/\s+/g, " ");
}

const renderBanner = (columns: number, rows = 30, noticeRows = 0) =>
	render(
		withTheme(
			<WelcomeBanner
				columns={columns}
				rows={rows}
				noticeRows={noticeRows}
				version="9.9.9"
				cwd="/work/labunbun"
				modelName="anthropic/claude-sonnet-5"
			/>,
		),
	);

describe("the greeting's size ladder", () => {
	// The prompt is the thing that must not leave the screen. The banner is the
	// one element that can, so every threshold is a "does it still fit" answer
	// and never a style choice.
	test("a full screen gets both columns", () => {
		expect(welcomeLayout(100, 30)).toBe("wide");
	});

	test("a shorter screen gets the one-column greeting", () => {
		expect(welcomeLayout(100, 23)).toBe("compact");
		expect(welcomeLayout(50, 20)).toBe("compact");
	});

	// The mascot plus a prompt does not fit in fourteen rows, so height alone
	// can demote the compact panel even when the width would allow it.
	test("a wide but short screen gets the label alone", () => {
		expect(welcomeLayout(100, 16)).toBe("minimal");
		expect(welcomeLayout(100, 19)).toBe("minimal");
	});

	test("a narrow screen gets the label alone", () => {
		expect(welcomeLayout(40, 30)).toBe("minimal");
		expect(welcomeLayout(49, 30)).toBe("minimal");
	});

	test("a screen with no room for a greeting gets nothing", () => {
		expect(welcomeLayout(30, 30)).toBe("hidden");
		expect(welcomeLayout(100, 10)).toBe("hidden");
	});
});

describe("fitPath", () => {
	test("leaves a path that fits alone", () => {
		expect(fitPath("/work/labunbun", 20)).toBe("/work/labunbun");
	});

	// The tail is the part that says where you are, so the cut is on the left.
	test("cuts a long path from the left", () => {
		expect(fitPath("/work/a/very/deep/checkout", 12)).toBe("…ep/checkout");
	});

	test("never asks for a negative width", () => {
		expect(fitPath("/work/labunbun", 0)).toBe("");
	});
});

describe("the welcome panel", () => {
	test("names the product, the version, the workspace and the model", () => {
		const { lastFrame, unmount } = renderBanner(100);
		const frame = flat(lastFrame());
		expect(frame).toContain("Welcome to LaBunbun Code");
		expect(frame).toContain("v9.9.9");
		expect(frame).toContain("/work/labunbun");
		expect(frame).toContain("anthropic/claude-sonnet-5");
		unmount();
	});

	// The tips are the answer to "what do I do now?", so the key and its
	// description both have to survive the frame.
	test("lists every tip", () => {
		const { lastFrame, unmount } = renderBanner(100);
		const frame = flat(lastFrame());
		for (const [key, description] of TIPS) {
			expect(frame).toContain(key);
			expect(frame).toContain(description);
		}
		unmount();
	});

	test("draws the panel in rounded corners", () => {
		const { lastFrame, unmount } = renderBanner(100);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("╭");
		expect(frame).toContain("╰");
		unmount();
	});

	// Inline, the version pushed the greeting past the column's padding and Ink
	// wrapped it onto a second line by itself. The row is deliberate now.
	test("puts the version on its own row under the greeting", () => {
		const { lastFrame, unmount } = renderBanner(100);
		const lines = (lastFrame() ?? "").split("\n");
		const welcome = lines.findIndex((line) => line.includes("Welcome to LaBunbun Code"));
		expect(welcome).toBeGreaterThanOrEqual(0);
		expect(lines[welcome]).not.toContain("v9.9.9");
		expect(lines[welcome + 1]).toContain("v9.9.9");
		unmount();
	});

	// The compact panel gives up the tips column before it gives up the name.
	test("keeps the name and drops the tips column when the screen narrows", () => {
		const { lastFrame, unmount } = renderBanner(60, 30);
		const frame = flat(lastFrame());
		expect(frame).toContain("Welcome to LaBunbun Code");
		expect(frame).not.toContain("Tips for getting started");
		unmount();
	});

	// Startup notices are rows the terminal has already spent by the time the
	// panel is drawn. A 24-row screen with three of them has no room for the
	// two-column greeting, and a frame that overflows clips the panel's top.
	test("spends the rows the startup notices take", () => {
		const wide = renderBanner(100, 30, 4);
		expect(flat(wide.lastFrame())).toContain("Tips for getting started");
		wide.unmount();

		const tight = renderBanner(100, 24, 4);
		const frame = flat(tight.lastFrame());
		expect(frame).toContain("Welcome to LaBunbun Code");
		expect(frame).not.toContain("Tips for getting started");
		tight.unmount();
	});

	test("renders nothing at all below its minimum", () => {
		const { lastFrame, unmount } = renderBanner(28, 30);
		expect(flat(lastFrame())).toBe("");
		unmount();
	});
});

describe("the REPL's first frame", () => {
	function setup(state: Partial<UiState> = {}) {
		const faux = fauxProvider([{ text: "n/a" }]);
		const session = new AgentSession({ model: FAUX_MODEL, deps: { streamFn: faux.streamFn } });
		const store = createStore<UiState>({ ...initialUiState(), ...state });
		const view = render(
			<REPL getSession={() => session} store={store} modelName="test" onExit={() => {}} version="9.9.9" />,
		);
		return { store, view, frame: () => flat(view.lastFrame()) };
	}

	test("shows the greeting before the first message", async () => {
		const h = setup();
		await new Promise((r) => setTimeout(r, 40));
		expect(h.frame()).toContain("Welcome to LaBunbun Code");
		h.view.unmount();
	});

	test("stands aside once the transcript has a row", async () => {
		const h = setup({ entries: [{ kind: "user", text: "hello" }] });
		await new Promise((r) => setTimeout(r, 40));
		expect(h.frame()).not.toContain("Welcome to LaBunbun Code");
		h.view.unmount();
	});

	// A real start puts a few notices in the transcript before the user has
	// typed anything: no controller, a skill that failed validation, a catalog
	// refresh. Treating those as a conversation hid the panel on the machines
	// where it matters most — the ones with something to report.
	test("keeps the greeting above startup info rows", async () => {
		const h = setup({
			entries: [
				{ kind: "info", text: 'Skill not loaded: skill "x" must match the directory name' },
				{ kind: "info", text: "Gamepad: no controller attached — looking again every few seconds" },
			],
		});
		await new Promise((r) => setTimeout(r, 40));
		expect(h.frame()).toContain("Welcome to LaBunbun Code");
		expect(h.frame()).toContain("no controller attached");
		h.view.unmount();
	});

	// The banner is the one thing on screen not doing anything. A run in
	// flight, or any overlay, has the rows it needs.
	test("stands aside while a turn is running", async () => {
		const h = setup({ statusPhase: "thinking" });
		await new Promise((r) => setTimeout(r, 40));
		expect(h.frame()).not.toContain("Welcome to LaBunbun Code");
		h.view.unmount();
	});
});
