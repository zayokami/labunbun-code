/**
 * `/map` and `/map-refresh`: the command half of the repository map.
 *
 * What these pin is the contract between a command and the host's scanner: the
 * optional directory is positional, the budget needs its flag, refresh is the
 * only difference between the two commands, and a missing scanner is answered
 * rather than thrown. The rendering itself belongs to the tools package, where
 * `repomap-p2.test.ts` covers it.
 */
import { describe, expect, test } from "bun:test";
import { builtInCommands, findCommand, type RepoMapCommandResult } from "../src/commands.ts";

const RESULT: RepoMapCommandResult = {
	root: "G:/repo",
	text: "src/a.ts:\n│export function alpha() {}",
	tokens: 1000,
	definitions: 7,
	files: 1,
	totalDefinitions: 7,
	totalFiles: 1,
	partial: false,
	elapsedMs: 1234,
};

interface Call {
	path?: string;
	maxTokens?: number;
	refresh?: boolean;
}

function harness() {
	const calls: Call[] = [];
	const repoMap = {
		map: async (options: Call): Promise<RepoMapCommandResult> => {
			calls.push(options);
			return RESULT;
		},
	};
	return { calls, ctx: { repoMap } as never };
}

function local(name: string) {
	const command = findCommand(builtInCommands(), name);
	if (command?.type !== "local") throw new Error(`/${name} is no longer a local command`);
	return command;
}

describe("/map", () => {
	test("maps the workspace with the default budget", async () => {
		const { calls, ctx } = harness();
		const text = await local("map").call(ctx, "");

		expect(calls).toEqual([{ path: undefined, maxTokens: undefined, refresh: false }]);
		expect(text).toContain("src/a.ts:");
		expect(text).toContain("Repo map: 7 definitions in 1 file, ~1,000 tokens, 1.2s.");
	});

	test("takes the directory first and the budget after --tokens", async () => {
		const { calls, ctx } = harness();
		await local("map").call(ctx, "packages/tools --tokens 4096");

		expect(calls).toEqual([{ path: "packages/tools", maxTokens: 4096, refresh: false }]);
	});

	test("accepts --tokens=N and ignores a budget that is not a number", async () => {
		const { calls, ctx } = harness();
		await local("map").call(ctx, "--tokens=2048 src");
		await local("map").call(ctx, "src --tokens lots");

		expect(calls[0]).toEqual({ path: "src", maxTokens: 2048, refresh: false });
		expect(calls[1]).toEqual({ path: "src", maxTokens: undefined, refresh: false });
	});

	test("a partial map says how much it left out and how to see more", async () => {
		const { ctx } = harness();
		const command = local("map");
		const partial = {
			...RESULT,
			definitions: 3,
			totalDefinitions: 7,
			partial: true,
		};
		(ctx as unknown as { repoMap: { map(): Promise<RepoMapCommandResult> } }).repoMap.map = async () => partial;

		const text = await command.call(ctx, "");

		expect(text).toContain("3 of 7 definitions in 1 of 1 files");
		expect(text).toContain("/map --tokens");
	});

	test("answers that maps are unavailable without a scanner", async () => {
		const text = await local("map").call({} as never, "");
		expect(text).toBe("Repository maps are not available in this session.");
	});

	test("reports a scanner failure instead of throwing", async () => {
		const ctx = {
			repoMap: {
				map: async () => {
					throw new Error("RepoMap: path '../x' resolves outside workspace");
				},
			},
		} as never;

		expect(await local("map").call(ctx, "../x")).toBe(
			"Repo map failed: RepoMap: path '../x' resolves outside workspace",
		);
	});

	test("is discoverable", () => {
		const names = builtInCommands().map((command) => command.name);
		expect(names).toContain("map");
		expect(names).toContain("map-refresh");
	});
});

describe("/map-refresh", () => {
	test("asks the scanner to drop its cache", async () => {
		const { calls, ctx } = harness();
		await local("map-refresh").call(ctx, "src");

		expect(calls).toEqual([{ path: "src", maxTokens: undefined, refresh: true }]);
	});

	test("renders the same report as /map", async () => {
		const { ctx } = harness();
		expect(await local("map-refresh").call(ctx, "")).toBe(await local("map").call(ctx, ""));
	});
});
