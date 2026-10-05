/**
 * The network axis, from the settings file to the subagent that runs under it.
 *
 * The proxy itself is tested where it lives (`packages/tools/test/network-proxy.test.ts`)
 * and its decision function where it lives (`packages/tools/test/network-policy.test.ts`).
 * What is untested by either is the wiring, and wiring is where this axis fails:
 * every step here is a `Settings` key becoming a `NetworkAxis` becoming an
 * environment variable, and a break at any of them is silent — the command still
 * runs, it just reaches somewhere it should not.
 *
 * Four seams, one file, because they are the four places the value can be
 * dropped:
 *
 *   1. the schema accepts both spellings of a rule and derives its enum
 *   2. `networkAxisFrom` is the only place the union is collapsed
 *   3. a subagent inherits the axis rather than defaulting to it
 *   4. a repository cannot set the keys that decide it
 */
import { describe, expect, test } from "bun:test";
import {
	type AnyTool,
	buildTool,
	NETWORK_DOMAIN_PERMISSIONS,
	NETWORK_SANDBOX_POLICIES,
	type NetworkAxis,
} from "@labunbun/agent";
import { FAUX_MODEL, fauxProvider } from "@labunbun/ai";
import { z } from "zod";
import { networkAxisFrom, PROJECT_TIER_KEY_POLICY, SettingsSchema } from "../src/settings.ts";
import { createSubagentTools } from "../src/subagents.ts";

describe("the network keys in a settings file", () => {
	test("a rule is a bare string or an object, and both survive the parse", () => {
		const parsed = SettingsSchema.parse({
			networkAccess: "restricted",
			networkDomains: ["registry.npmjs.org", { domain: "*.internal", action: "deny" }],
		});
		// Both shapes kept as written. Collapsing them here would be fine for
		// consumers and fatal for this test, which is the only thing standing
		// between a refactor and a silent change of what a file means.
		expect(parsed.networkDomains).toEqual(["registry.npmjs.org", { domain: "*.internal", action: "deny" }] as any);
	});

	test("every policy value the agent package defines is one the schema accepts", () => {
		// The F1 shape, for this axis: a value added to `NETWORK_SANDBOX_POLICIES`
		// and not to the zod enum would be a mode that exists everywhere except in
		// the one place a user could select it. The schema derives from the list,
		// and this is the test that says so rather than trusting the derivation.
		for (const policy of NETWORK_SANDBOX_POLICIES) {
			expect(SettingsSchema.safeParse({ networkAccess: policy }).success).toBe(true);
		}
		for (const permission of NETWORK_DOMAIN_PERMISSIONS) {
			expect(SettingsSchema.safeParse({ networkDomains: [{ domain: "x", action: permission }] }).success).toBe(true);
		}
		// And a value that is not one of them is refused rather than defaulted —
		// a typo in a file that silently became "enabled" would read as working.
		expect(SettingsSchema.safeParse({ networkAccess: "off" }).success).toBe(false);
		expect(SettingsSchema.safeParse({ networkDomains: [{ domain: "x", action: "block" }] }).success).toBe(false);
	});

	test("both keys are denied to a repository", () => {
		// A checked-in `networkAccess: "restricted"` with no allow list would make
		// `bun install` fail for everyone who clones, and would be indistinguishable
		// from a broken network. Tightening is a user's decision, never a
		// repository's.
		expect(PROJECT_TIER_KEY_POLICY.networkAccess).toBe("denied");
		expect(PROJECT_TIER_KEY_POLICY.networkDomains).toBe("denied");
	});
});

describe("reading the axis out of settings", () => {
	test("nothing in the file means today's behaviour, not a closed network", () => {
		// The default has to be `enabled`. An empty domain list under `restricted`
		// reaches nothing, so defaulting the *mode* would turn every settings file
		// that never mentions the network into a session that cannot fetch.
		expect(networkAxisFrom(SettingsSchema.parse({}))).toEqual({ access: "enabled", domains: [] });
	});

	test("a bare string becomes an allow and the object form keeps its action", () => {
		const axis = networkAxisFrom(
			SettingsSchema.parse({
				networkAccess: "restricted",
				networkDomains: ["registry.npmjs.org", { domain: "*.internal", action: "deny" }],
			}),
		);
		expect(axis).toEqual({
			access: "restricted",
			domains: [
				{ pattern: "registry.npmjs.org", permission: "allow" },
				{ pattern: "*.internal", permission: "deny" },
			],
		} satisfies NetworkAxis);
	});

	test("`enabled` with rules keeps the rules", () => {
		// The two halves are not one setting. `enabled` plus a deny is a real
		// configuration — it is what starts a proxy at all — and reading the mode
		// alone would report "not restricted" for a session whose proxy is
		// refusing three domains.
		const axis = networkAxisFrom(SettingsSchema.parse({ networkDomains: ["x.test"] }));
		expect(axis.access).toBe("enabled");
		expect(axis.domains).toEqual([{ pattern: "x.test", permission: "allow" }]);
	});
});

describe("what a subagent inherits", () => {
	/** Records the axis each tool call was made under. */
	function recordingTool(seen: NetworkAxis[]): AnyTool {
		return buildTool({
			name: "echo",
			description: "echo",
			inputSchema: z.object({ text: z.string() }),
			call: async (input: any, ctx) => {
				seen.push(ctx.network);
				return { content: [{ type: "text", text: input.text }] };
			},
		});
	}

	test("the parent's axis reaches the subagent's own tool calls", async () => {
		const seen: NetworkAxis[] = [];
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "inside" } }] }, { text: "SUB DONE" }]);
		const [taskTool] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [recordingTool(seen)],
			definitions: () => [],
			// What a `networkAccess: "restricted"` session would hand down.
			network: () => ({ access: "restricted", domains: [{ pattern: "*.npmjs.org", permission: "allow" }] }),
		});
		const result = await taskTool.call(
			{ description: "run sub", prompt: "do the thing" },
			{
				callId: "t1",
				signal: new AbortController().signal,
				cwd: process.cwd(),
				// Deliberately the *opposite* of what the provider hands the
				// subagent. A tool call context is the parent's own call, not the
				// subagent's, so a subagent that read this one instead of the
				// inherited value would look enabled from the outside.
				sandbox: "workspace-write" as const,
				network: { access: "enabled", domains: [] },
				onUpdate: () => {},
			},
		);
		expect((result.content[0] as any).text).toContain("SUB DONE");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ access: "restricted", domains: [{ pattern: "*.npmjs.org", permission: "allow" }] });
	});

	test("a parent that says nothing leaves the subagent on the default", async () => {
		// The back-compat default, and it is the permissive one. Asserted because
		// the alternative reading — a subagent inheriting a *closed* network —
		// would break every embedder that never set one, silently and only on the
		// machines that need the network.
		const seen: NetworkAxis[] = [];
		const faux = fauxProvider([{ toolCalls: [{ name: "echo", arguments: { text: "inside" } }] }, { text: "SUB DONE" }]);
		const [taskTool] = createSubagentTools({
			streamFn: faux.streamFn,
			model: () => FAUX_MODEL,
			allTools: [recordingTool(seen)],
			definitions: () => [],
		});
		await taskTool.call(
			{ description: "run sub", prompt: "do the thing" },
			{
				callId: "t1",
				signal: new AbortController().signal,
				cwd: process.cwd(),
				sandbox: "workspace-write" as const,
				network: { access: "enabled", domains: [] },
				onUpdate: () => {},
			},
		);
		expect(seen[0]).toEqual({ access: "enabled", domains: [] });
	});
});
