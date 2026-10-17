// Kept in a module with no other imports so `main.ts` can read the version and
// answer `--version` without loading the rest of this package. Re-exported here
// so the public API is unchanged.
export { CLI_NAME, CODING_AGENT_VERSION } from "./cli-constants.ts";

export {
	type AppliedResult,
	applyMigration,
	detectSources,
	formatMigrationReport,
	MIGRATION_SOURCE_IDS,
	type MigrationAction,
	type MigrationItem,
	type MigrationPlan,
	type MigrationSourceId,
	type PlannedWrite,
	parseFromOption,
	planMigration,
	type RawSources,
	type RunMigrationResult,
	readClaudeCode,
	readCodex,
	readSources,
	resolveModelReference,
	runMigration,
} from "./migrate.ts";
export {
	type LoadedThemes,
	loadThemeFiles,
	persistThemeChoice,
	type ResolvedTheme,
	resolveTheme,
	type ThemeFile,
	ThemeFileSchema,
	themeFromFile,
} from "./theme-file.ts";
