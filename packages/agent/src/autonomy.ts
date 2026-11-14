/**
 * How much of a decision the agent owns.
 *
 * This is a decision axis, not a permission axis. A level changes what the model
 * asks the user about; it never widens what the harness lets the model do.
 * `permissionMode`, `sandbox`, deny rules and the plan gate apply unchanged at
 * every level, and the prompt says so. Keeping the two axes apart is what lets a
 * session be more autonomous without becoming less confined: autonomy is about
 * who chooses, permission is about what is allowed.
 *
 * The levels are deliberately about reversibility rather than about categories
 * of work. A technical choice is the agent's when its outcome can be read in the
 * diff and undone; it is the user's when it changes the deliverable, costs
 * money, or reaches outside the checkout. `docs/dev/autonomy.md` carries the
 * long form.
 */
export const AUTONOMY_LEVELS = ["guided", "balanced", "autonomous"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/**
 * The level a session runs at when neither the settings file nor a host names
 * one.
 *
 * `autonomous` is the default because the harness already defaults to the
 * autonomous end of the permission axis (`agent`: execute without asking). A
 * decision default more cautious than the execution default would ask the user
 * to confirm work this same session was already trusted to run. The level keeps
 * its hard stops — irreversible or externally visible actions, and decisions
 * only the user can make — so it is autonomy over the how, not over the what.
 */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "autonomous";

/** One level as the command surface shows it: the id to type, and what it means. */
export interface AutonomyChoice {
	id: AutonomyLevel;
	label: string;
	hint: string;
}

export const AUTONOMY_CHOICES: readonly AutonomyChoice[] = [
	{
		id: "guided",
		label: "Guided",
		hint: "Ask before choosing among approaches; decide only the details inside the approach the user picked.",
	},
	{
		id: "balanced",
		label: "Balanced",
		hint: "Decide the implementation; ask when the answer changes what the user gets.",
	},
	{
		id: "autonomous",
		label: "Autonomous",
		hint: "Decide every reversible step the evidence supports and report assumptions; ask only for hard blockers.",
	},
];

/** Whether a value names an autonomy level. */
export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
	return typeof value === "string" && (AUTONOMY_LEVELS as readonly string[]).includes(value);
}

/** The choice a level id names, or undefined when the id is unknown. */
export function findAutonomyChoice(id: string): AutonomyChoice | undefined {
	return AUTONOMY_CHOICES.find((choice) => choice.id === id);
}

/** The level's display label ("Autonomous"). Unknown values read as themselves. */
export function describeAutonomyLevel(level: AutonomyLevel): string {
	return findAutonomyChoice(level)?.label ?? level;
}
