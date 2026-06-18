import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { CategoryKey } from "./types.ts";

export interface CategoryMeta {
	key: CategoryKey;
	label: string;
	icon: string;
	color: ThemeColor;
	deferred?: boolean;
	expandable?: boolean;
}

export const CATEGORY_ORDER: CategoryKey[] = [
	"messages",
	"systemTools",
	"systemPrompt",
	"skills",
	"mcpTools",
	"commands",
	"memoryFiles",
	"customAgents",
	"bundles",
	"mcpDeferred",
	"free",
];

export const CATEGORY_META: Record<CategoryKey, CategoryMeta> = {
	messages: {
		key: "messages",
		label: "Messages",
		icon: "■",
		color: "accent",
	},
	systemTools: {
		key: "systemTools",
		label: "System tools",
		icon: "■",
		color: "success",
		expandable: true,
	},
	systemPrompt: {
		key: "systemPrompt",
		label: "System prompt",
		icon: "■",
		color: "muted",
	},
	skills: {
		key: "skills",
		label: "Skills",
		icon: "■",
		color: "warning",
		expandable: true,
	},
	mcpTools: {
		key: "mcpTools",
		label: "MCP tools",
		icon: "■",
		color: "accent",
		expandable: true,
	},
	mcpDeferred: {
		key: "mcpDeferred",
		label: "MCP tools (deferred)",
		icon: "░",
		color: "dim",
		deferred: true,
		expandable: true,
	},
	commands: {
		key: "commands",
		label: "Slash commands",
		icon: "■",
		color: "text",
		expandable: true,
	},
	memoryFiles: {
		key: "memoryFiles",
		label: "Memory files",
		icon: "■",
		color: "text",
		expandable: true,
	},
	customAgents: {
		key: "customAgents",
		label: "Custom agents",
		icon: "■",
		color: "success",
		expandable: true,
	},
	bundles: {
		key: "bundles",
		label: "Bundles",
		icon: "■",
		color: "warning",
		expandable: true,
	},
	free: {
		key: "free",
		label: "Free space",
		icon: "○",
		color: "dim",
	},
};

/** Non-overlapping keys used for total/free-space math. */
export const TOTAL_CATEGORY_KEYS: CategoryKey[] = [
	"messages",
	"systemPrompt",
	"memoryFiles",
];

/** Sub-breakdown of system prompt — scaled to fit within systemPrompt total. */
export const SYSTEM_DETAIL_KEYS: CategoryKey[] = [
	"systemTools",
	"skills",
	"mcpTools",
	"commands",
	"bundles",
	"customAgents",
];

export const ACTIVE_CATEGORY_KEYS: CategoryKey[] = TOTAL_CATEGORY_KEYS;
