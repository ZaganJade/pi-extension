export type CategoryKey =
	| "messages"
	| "systemPrompt"
	| "systemTools"
	| "skills"
	| "mcpTools"
	| "mcpDeferred"
	| "commands"
	| "memoryFiles"
	| "customAgents"
	| "bundles"
	| "free";

export interface CategoryChild {
	name: string;
	tokens: number;
	hint?: string;
}

export interface CategoryItem {
	key: CategoryKey;
	label: string;
	tokens: number;
	percent: number;
	deferred?: boolean;
	count?: number;
	children?: CategoryChild[];
}

export interface ContextSnapshot {
	at: number;
	modelId: string;
	modelName: string;
	provider: string;
	contextWindow: number;
	totalTokens: number | null;
	categories: CategoryItem[];
	expanded: CategoryKey | null;
	unknownTotal: boolean;
}

export interface PackMessage {
	role: "user" | "assistant";
	text: string;
	tokens: number;
}

export interface ContextPack {
	version: 1;
	name: string;
	createdAt: string;
	source: {
		modelId: string;
		modelName: string;
		provider: string;
		contextWindow: number;
		cwd: string;
		sessionPath?: string;
	};
	summary: string;
	totalTokens: number;
	categories: CategoryItem[];
	messages: PackMessage[];
	systemPromptExcerpt: string;
	artifacts: string[];
}

export interface HandoffResult {
	pack: ContextPack;
	targetWindow: number;
	scaledTokens: number;
	omitted: string[];
	injectMessage: string;
}
