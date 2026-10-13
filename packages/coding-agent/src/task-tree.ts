/**
 * `/tasks` -- the whole picture on one screen: the session at the root and
 * everything it is running hanging under it.
 *
 * `/subagents` answers one run's questions and `/ps` answers the shells', but
 * neither answers the question the multi-agent design is about: what is this
 * session running right now, as one tree, with the lifecycle's own words on
 * every row. `/tasks` is that picture -- the root row, then a branch per
 * subagent and per background shell, every state visible (running, waiting,
 * completed, failed, cancelled, killed) and every id spelled out, because the
 * tree is where a person reads one off to hand to `/subagents stop` or
 * `/stop`.
 *
 * Rows that have ended stay on: a failed subagent and a killed shell are
 * states of the schedule, and a tree that dropped them would say the work
 * never happened. The order is the two listings' own -- subagents in
 * `/subagents` order (running oldest-first on top), then shells in the order
 * they were started.
 *
 * Pure, so the shape of the tree can be asserted with no subagent and no
 * process anywhere near it.
 */

import type { BackgroundShell } from "@labunbun/tools";
import { formatElapsed } from "@labunbun/tui";
import { elideShellCommand, shellAge } from "./background-commands.ts";
import { isRecoveredShell, shellStateWord } from "./shell-ledger.ts";
import { orderSubagents, subagentAgeMs } from "./subagent-commands.ts";
import { type SubagentHandle, subagentStatus } from "./subagent-registry.ts";

/** What the tree is drawn from: the root's state, and everything under it. */
export interface TaskTreeInput {
	/** A turn is in flight. The root row says running or idle, and nothing more. */
	mainRunning: boolean;
	/** All retained handles, ended ones included -- their states are the point. */
	subagents: SubagentHandle[];
	/** This run's shells plus the ledger's alive recoveries, as `/ps` reads them. */
	shells: BackgroundShell[];
	now: number;
}

const BRANCH = "├─ ";
const LAST = "└─ ";

/**
 * Column widths shared with the `/subagents` listing, so the two screens line
 * up as one family; the shell columns reuse the same ones.
 */
const STATUS_WIDTH = 9;
const TYPE_WIDTH = 16;
const AGE_WIDTH = 8;

function subagentRow(handle: SubagentHandle, now: number): string {
	const status = subagentStatus(handle).padEnd(STATUS_WIDTH);
	const type = handle.agentType.padEnd(TYPE_WIDTH);
	const age = formatElapsed(subagentAgeMs(handle, now)).padEnd(AGE_WIDTH);
	return `agent  ${status} ${type} ${age} ${handle.title}  (${handle.sidechainId})`;
}

function shellRow(shell: BackgroundShell, now: number): string {
	// `shellStateWord`: a recovered shell's row carries the liveness the last
	// probe settled, so a shell seen to end stops reading "running" here.
	const status = shellStateWord(shell).padEnd(STATUS_WIDTH);
	const age = shellAge(shell, now).padEnd(AGE_WIDTH);
	// A recovered shell was started by a process that is gone. The mark is what
	// explains the row's pid-shaped id to someone who never typed it here, and
	// it points at the only command that can still act on the shell: /stop's
	// pid path.
	const origin = isRecoveredShell(shell) ? ", from a previous run" : "";
	return `shell  ${status} ${age} ${elideShellCommand(shell.command)}  (${shell.id}${origin})`;
}

/**
 * The tree as the transcript shows it: the root row, then one branch per
 * subagent and shell -- `└─` on the last of them, `├─` on the rest.
 */
export function formatTaskTree(input: TaskTreeInput): string {
	const lines = [`main  ${input.mainRunning ? "running" : "idle"}`];
	const rows = [
		...orderSubagents(input.subagents).map((handle) => subagentRow(handle, input.now)),
		...input.shells.map((shell) => shellRow(shell, input.now)),
	];
	if (rows.length === 0) {
		lines.push(`${LAST}(no subagents or background shells this session)`);
		return lines.join("\n");
	}
	rows.forEach((row, index) => {
		lines.push(`${index === rows.length - 1 ? LAST : BRANCH}${row}`);
	});
	return lines.join("\n");
}
