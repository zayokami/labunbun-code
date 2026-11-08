/**
 * Review the working diff across four dimensions, dedupe the findings across
 * all of them, then try to refute each one through three independent lenses.
 *
 * Copy this file to ~/.labunbun/workflows/review-changes.js and call it as:
 *
 *   Workflow({ name: "review-changes", args: { target: "the staged diff" } })
 *
 * The pass to `args.target` is prose the agents follow — a path, a range, a
 * description of what to inspect — not a parsed value.
 */
export const meta = {
	name: "review-changes",
	description: "Review the diff across dimensions, then adversarially verify each unique finding",
	whenToUse: "When the user asks for a thorough review of the current changes",
};

const FINDINGS = {
	type: "object",
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					file: { type: "string" },
					line: { type: "integer" },
					claim: { type: "string" },
					failure: { type: "string" },
				},
				required: ["file", "line", "claim", "failure"],
				additionalProperties: false,
			},
		},
	},
	required: ["findings"],
	additionalProperties: false,
};

const VERDICT = {
	type: "object",
	properties: {
		real: { type: "boolean" },
		reason: { type: "string" },
	},
	required: ["real", "reason"],
	additionalProperties: false,
};

const DIMENSIONS = [
	{
		key: "correctness",
		prompt: "logic errors, off-by-one mistakes, wrong conditions, unhandled empty or null cases",
	},
	{
		key: "security",
		prompt: "untrusted input reaching a sink, missing authorization checks, secrets in logs or files",
	},
	{
		key: "performance",
		prompt: "work repeated per item that could be hoisted, quadratic scans, unbounded growth",
	},
	{
		key: "testing",
		prompt: "behavior changed without a test that would fail if it regressed, tests asserting the wrong thing",
	},
];

const target = typeof args?.target === "string" ? args.target : "the current working tree diff";

phase("Review");
const rounds = await parallel(
	DIMENSIONS.map((dimension) => () =>
		agent(
			`Review ${target}. Focus only on ${dimension.key}: ${dimension.prompt}.\n` +
				"Report only defects you can point at with an exact file and line. " +
				"Do not report style preferences. Reply with JSON matching the schema.",
			{ label: `find:${dimension.key}`, phase: "Review", schema: FINDINGS },
		),
	),
);

// Dedup across every dimension at once — this needs the barrier, since a
// finding reported by two dimensions should be verified once.
const seen = new Set();
const unique = [];
for (const round of rounds.filter(Boolean)) {
	for (const finding of round.findings) {
		const key = `${finding.file}:${finding.line}:${finding.claim}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(finding);
	}
}
log(`${unique.length} unique findings from ${DIMENSIONS.length} dimensions`);
if (unique.length === 0) return { findings: [], dropped: 0 };

phase("Verify");
const verified = await pipeline(
	unique,
	(finding) =>
		parallel(
			["correctness", "security", "repro"].map((lens) => () =>
				agent(
					`Try to REFUTE this review finding using the ${lens} lens. Default to real=false when uncertain.\n` +
						`Claim: ${finding.claim}\nWhere: ${finding.file}:${finding.line}\n` +
						`Claimed failure: ${finding.failure}`,
					{
						label: `verify:${lens}:${finding.file}:${finding.line}`,
						phase: "Verify",
						schema: VERDICT,
					},
				),
			),
		),
	(votes, finding) => {
		const real = votes.filter(Boolean).filter((vote) => vote.real).length;
		return {
			finding,
			real: real >= 2,
			reasons: votes.filter(Boolean).map((vote) => vote.reason),
		};
	},
);

const confirmed = verified.filter(Boolean).filter((entry) => entry.real).map((entry) => entry.finding);
log(`${confirmed.length}/${unique.length} findings survived adversarial verify`);
return { findings: confirmed, dropped: unique.length - confirmed.length };
