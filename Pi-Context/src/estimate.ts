import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	SlashCommandInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { estimateTextTokens } from "./format.ts";

export function estimateMessagesTokens(messages: AgentMessage[]): number {
	return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

export function estimateToolSchemaTokens(tool: ToolInfo): number {
	const payload = JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		guidelines: tool.promptGuidelines,
	});
	return estimateTextTokens(payload);
}

export function estimateSkillsTokens(skills: Skill[] = []): {
	total: number;
	children: { name: string; tokens: number }[];
} {
	if (skills.length === 0) return { total: 0, children: [] };
	const formatted = formatSkillsForPrompt(skills);
	const total = estimateTextTokens(formatted);
	const children = skills.map((s) => ({
		name: s.name,
		tokens: estimateTextTokens(s.description || s.name),
	}));
	return { total, children };
}

export function estimateContextFilesTokens(
	files: BuildSystemPromptOptions["contextFiles"] = [],
): { total: number; children: { name: string; tokens: number }[] } {
	const children = files.map((f) => ({
		name: f.path,
		tokens: estimateTextTokens(f.content),
	}));
	return { total: children.reduce((a, c) => a + c.tokens, 0), children };
}

export function estimateCommandsTokens(commands: SlashCommandInfo[]): {
	total: number;
	children: { name: string; tokens: number }[];
} {
	const extensionCommands = commands.filter((c) => c.source === "extension");
	const children = extensionCommands.map((c) => ({
		name: `/${c.name}`,
		tokens: estimateTextTokens(`${c.name} ${c.description ?? ""}`),
	}));
	return { total: children.reduce((a, c) => a + c.tokens, 0), children };
}

export function partitionMcpTools(tools: ToolInfo[], active: Set<string>) {
	const mcp: ToolInfo[] = [];
	const mcpDeferred: ToolInfo[] = [];
	const system: ToolInfo[] = [];

	for (const t of tools) {
		const src = `${t.sourceInfo?.source ?? ""} ${t.sourceInfo?.path ?? ""}`;
		const isMcp = /mcp/i.test(src) || t.name.startsWith("mcp_");
		if (isMcp) {
			(active.has(t.name) ? mcp : mcpDeferred).push(t);
		} else {
			system.push(t);
		}
	}
	return { mcp, mcpDeferred, system };
}

export function hasSubagents(pi: ExtensionAPI): boolean {
	return (
		pi.getCommands().some((c) => /subagent|agents?/i.test(c.name)) ||
		pi.getAllTools().some((t) => /subagent|task/i.test(t.name))
	);
}

export function parseSkillBundles(text: string): string[] {
	const m = text.match(/<manually_attached_skills[^>]*bundles="([^"]+)"/);
	if (!m) return [];
	return m[1].split(",").map((b) => b.trim()).filter(Boolean);
}

export function estimateBundlesTokens(bundleNames: string[]): number {
	return bundleNames.reduce((s, b) => s + estimateTextTokens(b), 0);
}
