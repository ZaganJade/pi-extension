import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function detectSubagentCommands(pi: ExtensionAPI): string[] {
	return pi
		.getCommands()
		.filter((c) => /subagent|agents?/i.test(c.name))
		.map((c) => c.name);
}
