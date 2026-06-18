export type LoadMode = "full" | "meta" | "lazy";

export type SkillOrder = "process-first" | "explicit" | "alpha";

export interface SkillBundle {
	description: string;
	skills: string[];
	order?: SkillOrder;
	default_mode?: LoadMode;
	/** Human-readable dependency label shown in help/autocomplete. */
	requires?: string;
	/** One-line install instructions when bundle skills are missing. */
	install?: string;
}

export interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

export interface SkillMetadata {
	name: string;
	description: string;
	type: "process" | "rigid" | "flexible" | "unknown";
	module: string;
	priority: number;
	commands: string[];
	skillId: string;
	version: string;
	pairsWith: string[];
	conflictsWith: string[];
	tokenBudget?: LoadMode;
}

export interface EnrichedSkillInfo extends SkillInfo {
	metadata: SkillMetadata;
	rawContent: string;
	body: string;
}

export interface ParsedSkillsArgs {
	skillNames: string[];
	mode: LoadMode;
	auto: boolean;
	parallel: boolean;
	parallelTasks: string[];
	embeddedCommand?: string;
	instructions: string;
}

export interface BuildOptions {
	mode: LoadMode;
	bundles?: string[];
	bmadStatusBlock?: string;
	parallel: boolean;
	parallelTasks?: string[];
	subagentAvailable?: boolean;
	embeddedCommand?: string;
	instructions?: string;
	skippedDuplicates?: string[];
	conflictWarnings?: string[];
}
