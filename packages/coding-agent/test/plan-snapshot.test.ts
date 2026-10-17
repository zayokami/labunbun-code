/**
 * The plan across a turn, a resume, and a compaction.
 *
 * Plan mode's product is a plan; once approved, the task board built from its
 * steps is the durable half. The plan itself is kept the way the task list is:
 * a newest-wins snapshot on the session's active chain, so a later turn can
 * read what was proposed instead of starting from a blank prompt.
 *
 * A compaction is the moment this gets interesting. The boundary hangs off the
 * chain's root, so the snapshot above it stops being on the active chain — the
 * pass has to put it back, exactly like the task list.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@labunbun/agent";
import { userMessage } from "@labunbun/ai";
import {
	formatPlanAttachment,
	MAX_INJECTED_PLAN_CHARS,
	PLAN_SNAPSHOT_KIND,
	type PlanSnapshot,
	readPlanSnapshot,
	reanchorPlanSnapshot,
	writePlanSnapshot,
} from "../src/plan-snapshot.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): SessionStore {
	const store = SessionStore.startNew(
		mkdtempSync(join(tmpdir(), "lbb-plan-cwd-")),
		mkdtempSync(join(tmpdir(), "lbb-plan-home-")),
	);
	roots.push(store.path);
	return store;
}

function snapshot(patch: Partial<PlanSnapshot> = {}): PlanSnapshot {
	return { plan: "Implement the agreed change", approved: false, at: "2026-10-17T00:00:00.000Z", ...patch };
}

/** The snapshots a file holds, in the order they were written. */
function snapshots(path: string): unknown[] {
	return SessionStore.load(path)
		.entries.filter((entry) => entry.type === "custom" && entry.kind === PLAN_SNAPSHOT_KIND)
		.map((entry) => (entry.type === "custom" ? entry.data : undefined));
}

describe("a plan saved in a session", () => {
	test("the newest readable snapshot is the plan, across a reload", () => {
		const store = freshStore();
		writePlanSnapshot(store, snapshot({ plan: "first", at: "2026-10-17T00:00:01.000Z" }));
		writePlanSnapshot(
			store,
			snapshot({
				plan: "second",
				approved: true,
				steps: [{ subject: "Run tests" }, { subject: "Write up", description: "a summary" }],
				at: "2026-10-17T00:00:02.000Z",
			}),
		);

		const expected = snapshot({
			plan: "second",
			approved: true,
			steps: [{ subject: "Run tests" }, { subject: "Write up", description: "a summary" }],
			at: "2026-10-17T00:00:02.000Z",
		});
		expect(readPlanSnapshot(store)).toEqual(expected);
		// A second run reads the file rather than sharing memory with the first.
		expect(readPlanSnapshot(SessionStore.load(store.path))).toEqual(expected);
	});

	test("entries a build cannot read are skipped, and the plan before them stands", () => {
		const store = freshStore();
		const valid = snapshot({ plan: "the plan that stands" });
		writePlanSnapshot(store, valid);

		const malformed: unknown[] = [
			// Not an object at all.
			"a plan written by something else",
			// Missing or empty text.
			{ approved: false, at: "2026-10-17T00:00:00.000Z" },
			{ plan: "   ", approved: false, at: "2026-10-17T00:00:00.000Z" },
			// Wrong types on the two fields the reader branches on.
			{ plan: "text", approved: "yes", at: "2026-10-17T00:00:00.000Z" },
			{ plan: "text", approved: true, at: 17 },
			// Steps must be an array of subjects when present.
			{ plan: "text", approved: true, at: "2026-10-17T00:00:00.000Z", steps: "one" },
			{ plan: "text", approved: true, at: "2026-10-17T00:00:00.000Z", steps: [{ description: "no subject" }] },
			{ plan: "text", approved: true, at: "2026-10-17T00:00:00.000Z", steps: [{ subject: "" }] },
			{ plan: "text", approved: true, at: "2026-10-17T00:00:00.000Z", steps: [{ subject: "ok", description: 7 }] },
		];
		for (const data of malformed) store.appendCustom(PLAN_SNAPSHOT_KIND, data);

		expect(readPlanSnapshot(store)).toEqual(valid);
	});

	test("a snapshot that has not changed is not written again", () => {
		const store = freshStore();
		const plan = snapshot({ steps: [{ subject: "One" }] });
		writePlanSnapshot(store, plan);
		expect(snapshots(store.path)).toHaveLength(1);

		// The compaction put-back re-saves the exact snapshot it read; the file
		// should not grow a line for a plan nothing has changed.
		writePlanSnapshot(store, { ...plan, steps: [{ subject: "One" }] });
		expect(snapshots(store.path)).toHaveLength(1);

		// Any field moving is a new state, including the timestamp and an added
		// description on a step.
		writePlanSnapshot(store, { ...plan, at: "2026-10-17T00:00:09.000Z" });
		writePlanSnapshot(store, { ...plan, steps: [{ subject: "One", description: "with detail" }] });
		writePlanSnapshot(store, { ...plan, approved: true });
		expect(snapshots(store.path)).toHaveLength(4);
	});

	test("no session is a no-op, never a crash", () => {
		const plan = snapshot();
		expect(() => writePlanSnapshot(undefined, plan)).not.toThrow();
		expect(readPlanSnapshot(undefined)).toBeNull();
		expect(() => reanchorPlanSnapshot(undefined, plan)).not.toThrow();
	});

	test("a compaction re-root strands the plan until the pass puts it back", () => {
		const store = freshStore();
		const plan = snapshot({
			plan: "Ship the change",
			approved: true,
			steps: [{ subject: "Run tests" }],
		});
		writePlanSnapshot(store, plan);
		// The wiring reads the snapshot before the pass, while the chain still
		// runs through it — `done` is too late, the boundary is already in.
		const carried = readPlanSnapshot(store);
		expect(carried).toEqual(plan);

		expect(
			store.appendCompaction({
				boundary: userMessage("[Conversation compacted to stay within the context window.]"),
				suffix: [],
				summary: "1. Primary Request: ship the change",
				preservedFiles: [],
				preTokens: 90_000,
				postTokens: 1_000,
				model: "faux-1",
				trigger: "auto",
			}),
		).not.toBeNull();
		expect(readPlanSnapshot(store)).toBeNull();

		reanchorPlanSnapshot(store, carried);
		expect(readPlanSnapshot(store)).toEqual(plan);
		expect(readPlanSnapshot(SessionStore.load(store.path))).toEqual(plan);

		// A pass that carried no plan writes nothing, and a second put-back of the
		// same snapshot does not grow the file.
		const before = snapshots(store.path).length;
		reanchorPlanSnapshot(store, null);
		reanchorPlanSnapshot(store, readPlanSnapshot(store));
		expect(snapshots(store.path)).toHaveLength(before);
	});
});

describe("the plan attachment a re-entry reads", () => {
	test("states the status, the step count, and the recorded time", () => {
		const text = formatPlanAttachment(
			snapshot({ approved: true, steps: [{ subject: "One" }, { subject: "Two" }], at: "2026-10-17T01:02:03.000Z" }),
		);
		expect(text).toContain("approved");
		expect(text).toContain("2 steps");
		expect(text).toContain("2026-10-17T01:02:03.000Z");
		expect(text).toContain("Implement the agreed change");
	});

	test("a plan exactly at the limit is complete, and one character over is marked", () => {
		const atLimit = "x".repeat(MAX_INJECTED_PLAN_CHARS);
		const exact = formatPlanAttachment(snapshot({ plan: atLimit }));
		expect(exact).toContain(atLimit);
		expect(exact).not.toContain("[truncated");

		const over = `${atLimit}y`;
		const truncated = formatPlanAttachment(snapshot({ plan: over }));
		expect(truncated).toContain("x".repeat(MAX_INJECTED_PLAN_CHARS));
		expect(truncated).not.toContain(over);
		// The marker names exactly how much was cut, so the model knows what it is
		// missing rather than reading a sentence that ends mid-word.
		expect(truncated).toContain("[truncated 1 chars]");
	});
});
