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
import { DEFAULT_MODEL_PRICES } from "./prices.ts";

/**
 * Manual price for a model, in USD per **million tokens**. Used to compute a
 * cost for token-priced / proxied providers that pi records with cost 0
 * (e.g. zai/GLM, 9Router `kr/…`, `cx/…`). Omitted fields count as 0.
 */
export interface ModelPrice {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

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
	/**
	 * Manual per-model prices ($/million tokens) used to fill in cost when pi
	 * recorded none. Keyed by model ID; an entry keyed by the base name (without
	 * a proxy prefix like `kr/`) matches all proxied variants.
	 */
	modelPrices?: Record<string, ModelPrice>;
}

const DEFAULTS: UsageConfig = {
	fiveHourLimit: 0,
	weeklyLimit: 0,
	fiveHourTokenLimit: 0,
	weeklyTokenLimit: 0,
	showWidget: false,
	excludeProjects: [],
	maxSessions: 1000,
	modelPrices: {},
};

function configPath(): string {
	return join(getAgentDir(), "usage.json");
}

/** Load config, merged with defaults. Never throws — returns defaults on error. */
export function loadConfig(): UsageConfig {
	const path = configPath();
	if (!existsSync(path)) {
		return { ...DEFAULTS, modelPrices: { ...DEFAULT_MODEL_PRICES } };
	}
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw) as Partial<UsageConfig>;
		// Bundled prices are defaults; the user's modelPrices override per-key.
		return {
			...DEFAULTS,
			...parsed,
			modelPrices: { ...DEFAULT_MODEL_PRICES, ...(parsed.modelPrices ?? {}) },
		};
	} catch (err) {
		console.error(`[usage] Failed to read ${path}: ${err}`);
		return { ...DEFAULTS, modelPrices: { ...DEFAULT_MODEL_PRICES } };
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
