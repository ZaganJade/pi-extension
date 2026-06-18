import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import {
	CATEGORY_META,
	CATEGORY_ORDER,
	SYSTEM_DETAIL_KEYS,
	TOTAL_CATEGORY_KEYS,
} from "./categories.ts";
import {
	estimateBundlesTokens,
	estimateCommandsTokens,
	estimateContextFilesTokens,
	estimateMessagesTokens,
	estimateSkillsTokens,
	estimateToolSchemaTokens,
	hasSubagents,
	parseSkillBundles,
	partitionMcpTools,
} from "./estimate.ts";
import { detectSubagentCommands } from "./detect.ts";
import { estimateTextTokens, percentValue } from "./format.ts";
import type { CategoryItem, CategoryKey, ContextSnapshot } from "./types.ts";

function textOfUserContent(content: AgentMessage["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function findLatestBundles(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>): string[] {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;
		const text = textOfUserContent(entry.message.content);
		const bundles = parseSkillBundles(text);
		if (bundles.length > 0) return bundles;
	}
	return [];
}

function extractArtifacts(messages: AgentMessage[]): string[] {
	const paths = new Set<string>();
	const re = /(?:^|\s)([\w./~-]+(?:\.(?:ts|tsx|js|jsx|md|json|yaml|yml|py|rs|go)))/g;
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text =
			typeof m.content === "string"
				? m.content
				: m.content
						.filter((b): b is { type: "text"; text: string } => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		for (const match of text.matchAll(re)) {
			if (match[1].includes("/") || match[1].includes(".")) {
				paths.add(match[1]);
			}
		}
	}
	return [...paths].slice(0, 20);
}

export function buildSnapshot(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	promptOptions: BuildSystemPromptOptions | null,
): ContextSnapshot {
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
	const branch = ctx.sessionManager.getBranch();
	const { messages } = buildSessionContext(branch);

	const activeTools = new Set(pi.getActiveTools());
	const allTools = pi.getAllTools();
	const { mcp, mcpDeferred, system } = partitionMcpTools(allTools, activeTools);

	const msgTokens = estimateMessagesTokens(messages);
	const sysPromptTokens = estimateTextTokens(ctx.getSystemPrompt());
	const activeSystemTools = system.filter((t) => activeTools.has(t.name));
	const systemToolTokens = activeSystemTools.reduce(
		(s, t) => s + estimateToolSchemaTokens(t),
		0,
	);
	const skillsEst = estimateSkillsTokens(promptOptions?.skills ?? []);
	const memEst = estimateContextFilesTokens(promptOptions?.contextFiles ?? []);
	const cmdEst = estimateCommandsTokens(pi.getCommands());
	const mcpActive = mcp.reduce((s, t) => s + estimateToolSchemaTokens(t), 0);
	const mcpDef = mcpDeferred.reduce((s, t) => s + estimateToolSchemaTokens(t), 0);
	const bundleNames = findLatestBundles(branch);
	const bundleTokens = estimateBundlesTokens(bundleNames);

	const bucket = new Map<CategoryKey, CategoryItem>();

	const set = (key: CategoryKey, tokens: number, extra?: Partial<CategoryItem>) => {
		bucket.set(key, {
			key,
			label: CATEGORY_META[key].label,
			tokens,
			percent: percentValue(tokens, contextWindow),
			...extra,
		});
	};

	set("messages", msgTokens);
	set("systemTools", systemToolTokens, {
		count: activeSystemTools.length,
		children: activeSystemTools.map((t) => ({
			name: t.name,
			tokens: estimateToolSchemaTokens(t),
		})),
	});
	set("systemPrompt", sysPromptTokens);
	set("skills", skillsEst.total, {
		count: skillsEst.children.length,
		children: skillsEst.children.map((c) => ({ ...c, hint: "/skills" })),
	});
	set("mcpTools", mcpActive, {
		count: mcp.length,
		children: mcp.map((t) => ({
			name: t.name,
			tokens: estimateToolSchemaTokens(t),
			hint: "/mcp",
		})),
	});
	set("mcpDeferred", mcpDef, {
		deferred: true,
		count: mcpDeferred.length,
		children: mcpDeferred.map((t) => ({
			name: t.name,
			tokens: estimateToolSchemaTokens(t),
			hint: "loaded on-demand",
		})),
	});
	set("commands", cmdEst.total, {
		count: cmdEst.children.length,
		children: cmdEst.children,
	});
	set("memoryFiles", memEst.total, {
		count: memEst.children.length,
		children: memEst.children,
	});

	if (hasSubagents(pi)) {
		const agentCmds = detectSubagentCommands(pi);
		set("customAgents", estimateTextTokens(agentCmds.join(" ")), {
			count: agentCmds.length,
			children: agentCmds.map((name) => ({
				name: `/${name}`,
				tokens: estimateTextTokens(name),
				hint: "/agents",
			})),
		});
	} else {
		set("customAgents", 0, { count: 0 });
	}

	if (bundleNames.length > 0) {
		set("bundles", bundleTokens, {
			count: bundleNames.length,
			children: bundleNames.map((b) => ({
				name: b.startsWith("@") ? b : `@${b}`,
				tokens: estimateTextTokens(b),
			})),
		});
	} else {
		set("bundles", 0, { count: 0 });
	}

	reconcileSystemDetails(bucket, contextWindow);

	const estimatedTotal = TOTAL_CATEGORY_KEYS.reduce(
		(s, k) => s + (bucket.get(k)?.tokens ?? 0),
		0,
	);
	const totalForFree = usage?.tokens ?? estimatedTotal;
	set("free", Math.max(0, contextWindow - totalForFree));

	const categories = CATEGORY_ORDER.map((k) => bucket.get(k)).filter(
		(c): c is CategoryItem => c !== undefined,
	);

	return {
		at: Date.now(),
		modelId: model?.id ?? "unknown",
		modelName: model?.name ?? "unknown",
		provider: model?.provider ?? "",
		contextWindow,
		totalTokens: usage?.tokens ?? null,
		categories,
		expanded: null,
		unknownTotal: usage?.tokens == null,
	};
}

const PACK_MESSAGE_CHAR_LIMIT = 4000;

export function extractPackMessages(messages: AgentMessage[]): {
	role: "user" | "assistant";
	text: string;
	tokens: number;
}[] {
	const out: { role: "user" | "assistant"; text: string; tokens: number }[] = [];
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const raw =
			typeof m.content === "string"
				? m.content
				: m.content
						.filter((b): b is { type: "text"; text: string } => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		if (!raw.trim()) continue;
		const text = raw.slice(0, PACK_MESSAGE_CHAR_LIMIT);
		out.push({
			role: m.role,
			text,
			tokens: estimateTextTokens(text),
		});
	}
	return out;
}

export function buildPackSummary(messages: AgentMessage[]): string {
	const packed = extractPackMessages(messages);
	if (packed.length === 0) return "No conversation messages to summarize.";

	const lines: string[] = [];
	if (packed.length > 10) {
		lines.push(
			`Session digest: ${packed.length} messages total. Older turns are omitted on import when the target model has a smaller context window.`,
		);
		const early = packed.slice(0, 2);
		for (const m of early) {
			lines.push(`[${m.role}] ${m.text.slice(0, 300)}`);
		}
		lines.push("…");
	}

	const recent = packed.slice(-8);
	for (const m of recent) {
		lines.push(`[${m.role}] ${m.text.slice(0, 500)}`);
	}
	return lines.join("\n\n");
}

/** Scale detail buckets so they do not exceed the system prompt total. */
export function reconcileSystemDetails(
	bucket: Map<CategoryKey, CategoryItem>,
	contextWindow: number,
): void {
	const sysPrompt = bucket.get("systemPrompt")?.tokens ?? 0;
	if (sysPrompt <= 0) return;

	const detailSum = SYSTEM_DETAIL_KEYS.reduce(
		(s, k) => s + (bucket.get(k)?.tokens ?? 0),
		0,
	);
	if (detailSum <= sysPrompt) return;

	const ratio = sysPrompt / detailSum;
	for (const key of SYSTEM_DETAIL_KEYS) {
		const item = bucket.get(key);
		if (!item) continue;
		const scaled = Math.floor(item.tokens * ratio);
		const scaledChildren = item.children?.map((c) => ({
			...c,
			tokens: Math.floor(c.tokens * ratio),
		}));
		bucket.set(key, {
			...item,
			tokens: scaled,
			percent: percentValue(scaled, contextWindow),
			children: scaledChildren,
		});
	}
}

export { extractArtifacts };
