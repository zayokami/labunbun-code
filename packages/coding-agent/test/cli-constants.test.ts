/**
 * The startup constants are copies, and this file is what keeps them copies.
 *
 * `main.ts` cannot import `@labunbun/agent` or `./migrate.ts` at the top without
 * paying for both module graphs before `--version` prints a string, so
 * `cli-constants.ts` carries the arrays and the default row itself. A copy is a
 * second source of truth the moment nobody checks it: adding a mode or a
 * migration source to the real list would leave the CLI validating against a
 * list that no longer matches while every existing test passed. The comparisons
 * below run against whatever the authoritative modules currently export, so the
 * drift is the only thing that can turn them red.
 *
 * These tests may import the heavy modules. Production startup does not.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_MODE_CHOICE as AGENT_DEFAULT_MODE_CHOICE,
	NETWORK_SANDBOX_POLICIES as AGENT_NETWORK_SANDBOX_POLICIES,
	PERMISSION_MODES as AGENT_PERMISSION_MODES,
	SANDBOX_MODES as AGENT_SANDBOX_MODES,
	type ModeChoice,
} from "@labunbun/agent";
import {
	CLI_NAME,
	CODING_AGENT_VERSION,
	DEFAULT_HISTORY_LIMIT,
	DEFAULT_MODE_CHOICE,
	MIGRATION_SOURCE_IDS,
	NETWORK_SANDBOX_POLICIES,
	PERMISSION_MODES,
	SANDBOX_MODES,
} from "../src/cli-constants.ts";
import { CLI_NAME as PUBLIC_CLI_NAME, CODING_AGENT_VERSION as PUBLIC_CODING_AGENT_VERSION } from "../src/index.ts";
import {
	DEFAULT_HISTORY_LIMIT as MIGRATE_DEFAULT_HISTORY_LIMIT,
	MIGRATION_SOURCE_IDS as MIGRATE_MIGRATION_SOURCE_IDS,
} from "../src/migrate.ts";

describe("the startup constants are the authoritative values", () => {
	test("PERMISSION_MODES matches @labunbun/agent", () => {
		expect([...PERMISSION_MODES]).toEqual([...AGENT_PERMISSION_MODES]);
	});

	test("SANDBOX_MODES matches @labunbun/agent", () => {
		expect([...SANDBOX_MODES]).toEqual([...AGENT_SANDBOX_MODES]);
	});

	test("NETWORK_SANDBOX_POLICIES matches @labunbun/agent", () => {
		expect([...NETWORK_SANDBOX_POLICIES]).toEqual([...AGENT_NETWORK_SANDBOX_POLICIES]);
	});

	/**
	 * The whole row, not just the mode name: `--help` prints the mode and
	 * `--permission-mode` accepts the value, but the label and hint are what the
	 * picker shows, and a copy that named the same mode differently would be a
	 * user-visible difference that no other test sees.
	 */
	test("DEFAULT_MODE_CHOICE matches @labunbun/agent", () => {
		const copy: ModeChoice = DEFAULT_MODE_CHOICE;
		expect(copy).toEqual(AGENT_DEFAULT_MODE_CHOICE);
	});

	test("MIGRATION_SOURCE_IDS matches ./migrate.ts, in order", () => {
		expect([...MIGRATION_SOURCE_IDS]).toEqual([...MIGRATE_MIGRATION_SOURCE_IDS]);
	});

	test("DEFAULT_HISTORY_LIMIT matches ./migrate.ts", () => {
		expect(DEFAULT_HISTORY_LIMIT).toBe(MIGRATE_DEFAULT_HISTORY_LIMIT);
	});
});

describe("the public API still exports the CLI name and version", () => {
	test("index.ts re-exports the constants main.ts reads", () => {
		expect(PUBLIC_CLI_NAME).toBe(CLI_NAME);
		expect(PUBLIC_CODING_AGENT_VERSION).toBe(CODING_AGENT_VERSION);
	});
});
