import { Box, Text } from "ink";
import { useTheme } from "../theme.ts";
import type { UiTask } from "../ui-state.ts";

const ICONS: Record<UiTask["status"], string> = {
	pending: "☐",
	in_progress: "◐",
	completed: "☑",
};

/**
 * Compact task progress strip shown above the status line while the agent
 * works through a task list.
 */
export function TaskStrip({ tasks }: { tasks: UiTask[] }) {
	const theme = useTheme();
	if (tasks.length === 0) return null;

	const completed = tasks.filter((t) => t.status === "completed").length;
	const active = tasks.find((t) => t.status === "in_progress");
	const visible = tasks.filter((t) => t.status !== "completed").slice(0, 4);

	return (
		<Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={theme.toolBorder} paddingX={1}>
			<Text color={theme.dim}>
				Tasks {completed}/{tasks.length}
			</Text>
			{active?.activeForm && <Text color={theme.primary}>▸ {active.activeForm}</Text>}
			{visible.map((task) => (
				<Text key={task.id} color={task.status === "in_progress" ? theme.primary : theme.dim}>
					{ICONS[task.status]} #{task.id} {task.subject}
				</Text>
			))}
		</Box>
	);
}
