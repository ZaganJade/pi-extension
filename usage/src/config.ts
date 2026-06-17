/**
 * Persistent configuration for the usage extension.
 *
 * Stored at ~/.pi/agent/usage.json so it survives restarts and is easy to
 * edit by hand. Limits are expressed in USD; omit or set to 0 to disable a
 * quota bar (the panel then shows raw spend without a limit).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface UsageConfig {
	/** USD budget for the rolling 5-hour window. 0/undefined disables the bar. */
	fiveHourLimit?: number;
	/** USD budget for the rolling 7-day (weekly) window. 0/undefined disables the bar. */
	weeklyLimit?: number;
	/** Token budget for the rolling 5-hour window (for token-priced providers like zai/GLM). */
	fiveHourTokenLimit?: number;
	/** Token budget for the rolling 7-day (weekly) window. */
	weeklyTokenLimit?: number;
	/** When true, show a compact one-line usage summary widget above the editor. */
	showWidget?: boolean;
	/** Project cwd prefixes to exclude from aggregation (e.g. throwaway dirs). */
	excludeProjects?: string[];
	/** Maximum number of session files to scan (safety cap for huge histories). */
	maxSessions?: number;
}

const DEFAULTS: UsageConfig = {
	fiveHourLimit: 0,
	weeklyLimit: 0,
	fiveHourTokenLimit: 0,
	weeklyTokenLimit: 0,
	showWidget: false,
	excludeProjects: [],
	maxSessions: 1000,
};

function configPath(): string {
	return join(getAgentDir(), "usage.json");
}

/** Load config, merged with defaults. Never throws — returns defaults on error. */
export function loadConfig(): UsageConfig {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULTS };
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<UsageConfig>;
		return { ...DEFAULTS, ...parsed };
	} catch (err) {
		console.error(`[usage] Failed to read ${path}: ${err}`);
		return { ...DEFAULTS };
	}
}

/** Persist config to disk. Creates the agent dir if needed. */
export function saveConfig(config: UsageConfig): void {
	const path = configPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch (err) {
		console.error(`[usage] Failed to write ${path}: ${err}`);
	}
}
