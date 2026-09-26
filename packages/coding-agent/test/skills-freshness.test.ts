/**
 * The skills must not cite things that no longer exist.
 *
 * `.labunbun/skills/<name>/SKILL.md` is the only place this repo writes down what
 * its invariants *are* — the permission order, the containment guards, the shape
 * of a migration skip. It is also the one file type nothing type-checks and no
 * compiler sees, so it rots silently: a module gets renamed, a helper gets
 * inlined, and the skill goes on telling a reviewer to go and look at a symbol
 * that has been gone for weeks. The reviewer then either reports a finding
 * against a mechanism that does not exist, or — worse — trusts the sentence and
 * skips the check it was describing.
 *
 * That already happened once. `code-review-security` told reviewers that a new
 * settings key belongs in `PROJECT_TIER_DENIED_KEYS`; that name was replaced by
 * a `Record<keyof Settings, …>` policy table and the old one has had zero
 * hits ever since. This test is the thing that noticed, and it is here so the
 * next one does not need a human sweep to find.
 *
 * **Two premises this check rests on, both of which are load-bearing and both
 * of which a future edit could quietly break:**
 *
 * 1. The lowercase skip (`/^[a-z]+$/` and ≤8 chars) is what keeps prose out. A
 *    backticked `continue` or `decision` is a word in a sentence, not a symbol;
 *    without the skip this test reports dozens of false failures and gets
 *    ignored, which is worse than not having it. Measured over all 13 skills:
 *    37 `packages/` paths and 90 bare identifiers, one unresolved before the
 *    fix and zero after. If you widen the token pattern, re-measure that ratio
 *    before assuming a new red is a real defect.
 * 2. "Appears somewhere under `packages/`" is a liveness check, not a
 *    correctness one. A symbol that survives only inside a test file passes
 *    here. That is good enough to catch renames — the case this exists for —
 *    but it does not prove the skill is *right* about the symbol, only that the
 *    name still resolves. Correctness of the claim is still review's job.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SKILLS_DIR = join(REPO, ".labunbun", "skills");

function skillFiles(): Array<{ name: string; text: string }> {
	return readdirSync(SKILLS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const name = entry.name;
			const path = join(SKILLS_DIR, name, "SKILL.md");
			return existsSync(path) ? { name, text: readFileSync(path, "utf8") } : null;
		})
		.filter((found): found is { name: string; text: string } => found !== null);
}

/**
 * Every identifier that appears anywhere under `packages/`, as a set.
 *
 * Deliberately includes `.md` and test files: this asks "does the name still
 * resolve somewhere", and narrowing the corpus would make it a different and
 * much noisier question.
 *
 * Two things about how the file list is built, both of them learned the hard
 * way by getting them wrong first:
 *
 * - `readdirSync(…, { recursive: true })` walks `node_modules` as well as
 *   source. Measured on this tree: 20,288 files / 180 MB unfiltered versus 372
 *   files / 5.4 MB filtered, and 10,036 ms versus 183 ms to index. The test
 *   timed out at 5 s before the filter and is not close to the limit after it.
 *   The filter is a substring test rather than a segment split on purpose —
 *   over-including a file only makes this check marginally looser, and a guard
 *   that fails for the wrong reason is the one failure mode worth engineering
 *   against.
 * - **This file is excluded from its own corpus.** Otherwise the header
 *   comment above — which names the symbol that died, as the receipt for why
 *   this test exists — becomes the proof that the symbol is alive, and the
 *   guard quietly stops guarding the exact case it was written for. A checker
 *   that indexes its own prose can be fooled by its own prose.
 */
function packageFiles(): string[] {
	return readdirSync(join(REPO, "packages"), { recursive: true }).filter(
		(entry): entry is string =>
			typeof entry === "string" &&
			/\.(ts|tsx|md|json)$/.test(entry) &&
			!entry.includes("node_modules") &&
			!entry.endsWith("skills-freshness.test.ts"),
	);
}

function identifierIndex(): Set<string> {
	const index = new Set<string>();
	for (const entry of packageFiles()) {
		let text: string;
		try {
			text = readFileSync(join(REPO, "packages", entry), "utf8");
		} catch {
			// A file that vanished or is unreadable is not this test's business;
			// the token it might have defined will show up as unresolved.
			continue;
		}
		for (const token of text.matchAll(/[A-Za-z_$][\w$]*/g)) index.add(token[0]);
	}
	return index;
}

/**
 * The fallback for a symbol that is not a whole token anywhere but does appear
 * inside a longer one — `isReadOnly` cited while the repo spells the helper
 * `isReadOnlyTool`, say. Substring semantics are what the noise ratio was
 * measured against, so they are preserved here rather than silently tightened
 * to whole-token matching, which would invent failures nobody asked for.
 *
 * Runs at most once, and only when the fast path found a miss.
 */
function appearsAsSubstring(symbols: string[]): Set<string> {
	const found = new Set<string>();
	if (symbols.length === 0) return found;
	for (const entry of packageFiles()) {
		let text: string;
		try {
			text = readFileSync(join(REPO, "packages", entry), "utf8");
		} catch {
			continue;
		}
		for (const symbol of symbols) {
			if (text.includes(symbol)) found.add(symbol);
		}
	}
	return found;
}

const BACKTICKED = /`([^`\n]+)`/g;
/** A `packages/…` citation, with trailing punctuation trimmed off the sentence. */
const PATH_CITATION = /^packages\/[\w./-]+/;
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function citations(skills: Array<{ name: string; text: string }>): {
	paths: Array<{ skill: string; path: string }>;
	identifiers: Array<{ skill: string; symbol: string }>;
} {
	const paths: Array<{ skill: string; path: string }> = [];
	const identifiers: Array<{ skill: string; symbol: string }> = [];
	for (const { name, text } of skills) {
		for (const match of text.matchAll(BACKTICKED)) {
			const token = match[1].trim();
			const path = token.match(PATH_CITATION);
			if (path) {
				paths.push({ skill: name, path: path[0].replace(/[.,;:]+$/, "") });
				continue;
			}
			// Prose guard — see premise 1 in the file header.
			if (!BARE_IDENTIFIER.test(token)) continue;
			if (/^[a-z]+$/.test(token) && token.length <= 8) continue;
			identifiers.push({ skill: name, symbol: token });
		}
	}
	return { paths, identifiers };
}

const skills = skillFiles();
const found = citations(skills);

describe("skills cite things that exist", () => {
	// The anti-vacuity guard, and it is not decoration. A test that scans zero
	// files passes every assertion below for the wrong reason, which is the
	// failure mode this whole file exists to prevent — so the scan finding
	// nothing is itself the finding.
	test("the scan actually found the skills to check", () => {
		expect(existsSync(SKILLS_DIR)).toBe(true);
		expect(skills.length).toBeGreaterThan(0);
		expect(found.paths.length).toBeGreaterThan(0);
		expect(found.identifiers.length).toBeGreaterThan(0);
	});

	test("every packages/ path a skill names is still a file", () => {
		const dead = found.paths.filter(({ path }) => !existsSync(join(REPO, path)));
		expect(dead.map((d) => `${d.skill} → ${d.path}`)).toEqual([]);
	});

	test("every symbol a skill names still resolves under packages/", () => {
		const index = identifierIndex();
		const missed = [...new Set(found.identifiers.map((c) => c.symbol))].filter((s) => !index.has(s));
		const rescued = appearsAsSubstring(missed);
		const dead = missed.filter((symbol) => !rescued.has(symbol));
		const reported = found.identifiers.filter((c) => dead.includes(c.symbol)).map((c) => `${c.skill} → ${c.symbol}`);
		expect(reported).toEqual([]);
	});
});
