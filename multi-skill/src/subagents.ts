import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENT_TOOL = "subagent";
const DEFAULT_PARALLEL_AGENT = "general-purpose";

export function hasSubagentTool(pi: ExtensionAPI): boolean {
	try {
		return pi.getAllTools().some((tool) => tool.name === SUBAGENT_TOOL);
	} catch {
		return false;
	}
}

export function buildParallelDispatchBlock(options: {
	tasks: string[];
	subagentAvailable: boolean;
}): string {
	const { tasks, subagentAvailable } = options;
	if (tasks.length === 0) return "";

	const lines: string[] = ["<parallel_dispatch>"];

	if (subagentAvailable) {
		lines.push(
			"Use the `subagent` tool in PARALLEL mode for independent tasks below.",
			"Call `{ action: \"list\" }` first if you need to pick agents.",
		);
		if (tasks.length === 1) {
			lines.push("");
			lines.push("Suggested invocation:");
			lines.push("```json");
			lines.push(
				JSON.stringify(
					{
						tasks: [{ agent: DEFAULT_PARALLEL_AGENT, task: tasks[0] }],
					},
					null,
					2,
				),
			);
			lines.push("```");
		} else {
			lines.push("");
			lines.push("Suggested invocation:");
			lines.push("```json");
			lines.push(
				JSON.stringify(
					{
						tasks: tasks.map((task) => ({
							agent: DEFAULT_PARALLEL_AGENT,
							task,
						})),
					},
					null,
					2,
				),
			);
			lines.push("```");
		}
	} else {
		lines.push(
			"pi-subagents is not installed — execute tasks sequentially in the current session.",
			"Install: `pi install npm:pi-subagents` then `/reload`.",
		);
	}

	lines.push("");
	lines.push("Tasks:");
	for (const [i, task] of tasks.entries()) {
		lines.push(`${i + 1}. ${task}`);
	}
	lines.push("</parallel_dispatch>");

	return lines.join("\n");
}
