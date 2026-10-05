/**
 * The flavor wiring: the thinking segment's clock, the finished-run footer's
 * clock, and the two places a user meets them.
 *
 * The words themselves live in flavor.test.ts; this file is about time. The
 * hook runs on real timers and waits for its numbers instead of on fixed
 * windows, and the footer's clock is hand-fed — so nothing here bets on a
 * machine's speed, and nothing waits on a forty-five-second thought.
 */
import { describe, expect, test } from "bun:test";
import { AgentSession } from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider, type StreamFn } from "@labunbun/ai";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useState } from "react";
import { connectSessionToStore, connectTurnFooter, REPL } from "../src/components/REPL.tsx";
import { useThinkingSegment } from "../src/hooks/useTurnTimer.ts";
import { createStore } from "../src/store.ts";
import { initialUiState, type UiEntry, type UiState } from "../src/ui-state.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A one-line probe for the thinking-segment hook; `control` drives its props. */
function SegmentProbe({
	control,
}: {
	control: { set: ((props: { thinking: boolean; frozen: boolean }) => void) | null };
}) {
	const [props, setProps] = useState({ thinking: true, frozen: false });
	control.set = setProps;
	const ms = useThinkingSegment(props);
	return <Text>{`ms=${ms}`}</Text>;
}

const shownMs = (frame: string | undefined): number => Number(/ms=(\d+)/.exec(frame ?? "")?.[1] ?? Number.NaN);

/** Poll `read` until `done` accepts it or the budget runs out; returns the last value. */
async function until<T>(read: () => T, done: (value: T) => boolean, budgetMs = 4_000, stepMs = 100): Promise<T> {
	const deadline = Date.now() + budgetMs;
	let value = read();
	while (!done(value) && Date.now() < deadline) {
		await delay(stepMs);
		value = read();
	}
	return value;
}

describe("the thinking segment clock", () => {
	test("counts, holds exactly while frozen, resumes, and zeroes when thinking ends", async () => {
		const control: { set: ((props: { thinking: boolean; frozen: boolean }) => void) | null } = { set: null };
		const { lastFrame, unmount } = render(<SegmentProbe control={control} />);
		const shown = () => shownMs(lastFrame());

		// Waited for rather than timed out on: a loaded machine flushes the
		// first render and the 500ms tick late, and a fixed window would read a
		// clock that had simply not started moving yet.
		const counting = await until(shown, (v) => v >= 450); // a 500ms tick has landed
		expect(counting).toBeGreaterThanOrEqual(450);

		control.set?.({ thinking: true, frozen: true });
		// A frozen clock is one that misses full tick periods. Read `held` only
		// once two reads a tick apart agree — the freeze itself can be observed
		// a beat late under load, and the value moves once more before it settles.
		let held = shown();
		for (let i = 0; i < 8; i++) {
			await delay(700);
			const next = shown();
			if (next === held) break;
			held = next;
		}
		expect(held).toBeGreaterThanOrEqual(counting);
		// More than a tick later: a frozen clock has moved by exactly nothing.
		await delay(700);
		expect(shown()).toBe(held);

		control.set?.({ thinking: true, frozen: false });
		expect(await until(shown, (v) => v > held)).toBeGreaterThan(held);

		// Leaving the phase is a reset, not a pause: the next thought starts at 0.
		control.set?.({ thinking: false, frozen: false });
		expect(await until(shown, (v) => v === 0)).toBe(0);
		unmount();
	}, 20_000);
});

describe("the footer's clock", () => {
	test("counts working time only — a dialog's minute is not the model's", () => {
		let nowMs = 0;
		const handlers: Array<(event: unknown) => void> = [];
		const fakeSession = {
			on(handler: (event: unknown) => void) {
				handlers.push(handler);
				return () => {};
			},
		} as unknown as AgentSession;
		const store = createStore<UiState>(initialUiState());
		connectTurnFooter(fakeSession, store, { random: () => 0, now: () => nowMs });

		nowMs = 0;
		store.set((s) => ({ ...s, statusPhase: "thinking" }));
		nowMs = 4_000;
		store.set((s) => ({ ...s, streamingText: "…" }));
		// The user is deciding on a dialog for a minute. The row would freeze;
		// the footer must repeat the row, not the wall clock.
		nowMs = 5_000;
		store.set((s) => ({
			...s,
			dialog: { callId: "p1", toolName: "Write", inputPreview: "Allow?", resolve: () => {} },
		}));
		nowMs = 65_000;
		store.set((s) => ({ ...s, dialog: null }));
		nowMs = 65_500;
		store.set((s) => ({ ...s, streamingText: "…." }));
		// The reducer's agent_end lands first (idle), then the footer's listener.
		nowMs = 66_000;
		store.set((s) => ({ ...s, statusPhase: "idle" }));
		handlers[0]?.({ type: "agent_end", reason: "completed", messages: [] });

		// 4s before the dialog + 0.5s after it; the wall clock would have said 1m 06s.
		expect(store.get().entries.at(-1)).toMatchObject({ kind: "info", text: "♪ Composed for 5s" });
	});
});

function setup(options: { hold?: Promise<void> } = {}) {
	const makeSession = (text: string): AgentSession => {
		const base = fauxProvider([{ text }]).streamFn;
		const streamFn: StreamFn = async function* (model, context, streamOptions) {
			for await (const event of base(model, context, streamOptions)) {
				if (event.type === "done" && options.hold) await options.hold;
				yield event;
			}
		};
		return new AgentSession({ model: FAUX_MODEL, deps: { streamFn } });
	};
	const store = createStore<UiState>(initialUiState());
	const first = makeSession("first in line");
	const holder = { current: first };
	let unsubs = [
		connectSessionToStore(holder.current, store),
		connectTurnFooter(holder.current, store, { random: () => 0 }),
	];
	const view = render(<REPL getSession={() => holder.current} store={store} modelName="test" onExit={() => {}} />);
	return {
		store,
		session: () => holder.current,
		first: () => first,
		footers: () =>
			store
				.get()
				.entries.filter(
					(entry): entry is Extract<UiEntry, { kind: "info" }> => entry.kind === "info" && entry.text.startsWith("♪"),
				),
		/** What the app's setSession does: rebind both listeners to the next session. */
		swap() {
			for (const unsub of unsubs) unsub();
			holder.current = makeSession("second in line");
			unsubs = [
				connectSessionToStore(holder.current, store),
				connectTurnFooter(holder.current, store, { random: () => 0 }),
			];
			store.set((s) => ({ ...s, entries: [], statusPhase: "idle" }));
		},
		frame: () => view.lastFrame() ?? "",
		unmount: () => {
			for (const unsub of unsubs) unsub();
			view.unmount();
		},
	};
}

describe("the finished-run footer, wired", () => {
	test("a run that completed leaves one footer line, in the transcript", async () => {
		const h = setup();
		await h.session().prompt("say something");
		await delay(20);
		const footers = h.footers();
		expect(footers).toHaveLength(1);
		expect(footers[0]?.text).toMatch(/^♪ Composed for \d+s$/);
		expect(h.frame()).toContain("♪ Composed for");
		h.unmount();
	}, 20_000);

	test("a run the user interrupted says so and wears no flourish", async () => {
		const hold = Promise.withResolvers<void>();
		const h = setup({ hold: hold.promise });
		const run = h.session().prompt("hold that thought");
		await delay(40);
		h.session().abort();
		hold.resolve();
		await run;
		await delay(20);
		expect(h.footers()).toHaveLength(0);
		expect(h.store.get().entries.some((entry) => entry.kind === "info" && entry.text === "[interrupted]")).toBe(true);
		h.unmount();
	}, 20_000);

	test("after an in-app /resume the footer follows the new session and forgets the old", async () => {
		const h = setup();
		await h.session().prompt("first run");
		await delay(20);
		expect(h.footers()).toHaveLength(1);
		h.swap();
		await h.session().prompt("second run");
		await delay(20);
		// The swap cleared the transcript: exactly one line, and it is the new run's.
		expect(h.footers()).toHaveLength(1);
		expect(h.frame()).toContain("♪ Composed for");
		// A swapped-out session is silent: its next run reaches no listener at all.
		const quiet = h.store.get().entries.length;
		await h.first().prompt("late run");
		await delay(20);
		expect(h.store.get().entries.length).toBe(quiet);
		h.unmount();
	}, 20_000);
});
