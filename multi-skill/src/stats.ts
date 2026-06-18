import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoadMode } from "./types.ts";

export interface ActivationRecord {
	at: string;
	mode: LoadMode;
	skillNames: string[];
	bundles: string[];
	parallel: boolean;
	skillCount: number;
	/** Original /skills args for /skills-last replay. */
	rawArgs?: string;
}

export interface MultiSkillStats {
	version: 1;
	activations: number;
	byMode: Record<LoadMode, number>;
	byBundle: Record<string, number>;
	bySkillCount: Record<string, number>;
	recent: ActivationRecord[];
}

function statsPath(): string {
	return join(homedir(), ".pi", "agent", "multi-skill-stats.json");
}

function emptyStats(): MultiSkillStats {
	return {
		version: 1,
		activations: 0,
		byMode: { full: 0, meta: 0, lazy: 0 },
		byBundle: {},
		bySkillCount: {},
		recent: [],
	};
}

export function loadStats(): MultiSkillStats {
	const path = statsPath();
	if (!existsSync(path)) return emptyStats();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as MultiSkillStats;
		if (parsed.version !== 1) return emptyStats();
		return { ...emptyStats(), ...parsed, recent: parsed.recent ?? [] };
	} catch {
		return emptyStats();
	}
}

function saveStats(stats: MultiSkillStats): void {
	const dir = join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(statsPath(), `${JSON.stringify(stats, null, 2)}\n`, "utf-8");
}

export function recordActivation(
	record: Omit<ActivationRecord, "at">,
): void {
	const stats = loadStats();
	stats.activations += 1;
	stats.byMode[record.mode] = (stats.byMode[record.mode] ?? 0) + 1;

	for (const bundle of record.bundles) {
		stats.byBundle[bundle] = (stats.byBundle[bundle] ?? 0) + 1;
	}

	const bucket =
		record.skillCount <= 1
			? "1"
			: record.skillCount <= 3
				? "2-3"
				: "4+";
	stats.bySkillCount[bucket] = (stats.bySkillCount[bucket] ?? 0) + 1;

	stats.recent.unshift({ ...record, at: new Date().toISOString() });
	stats.recent = stats.recent.slice(0, 20);

	saveStats(stats);
}

export function formatStatsReport(): string {
	const stats = loadStats();
	const lines: string[] = [
		`Multi-skill activations: ${stats.activations}`,
		"",
		"By load mode:",
		`  full: ${stats.byMode.full} · meta: ${stats.byMode.meta} · lazy: ${stats.byMode.lazy}`,
	];

	const bundles = Object.entries(stats.byBundle).sort((a, b) => b[1] - a[1]);
	if (bundles.length > 0) {
		lines.push("", "Top bundles:");
		for (const [name, count] of bundles.slice(0, 8)) {
			lines.push(`  @${name}: ${count}`);
		}
	}

	const counts = Object.entries(stats.bySkillCount);
	if (counts.length > 0) {
		lines.push("", "Skills per activation:");
		for (const [bucket, count] of counts) {
			lines.push(`  ${bucket} skill(s): ${count}`);
		}
	}

	if (stats.recent.length > 0) {
		lines.push("", "Recent:");
		for (const r of stats.recent.slice(0, 5)) {
			const label =
				r.bundles.length > 0
					? r.bundles.map((b) => `@${b}`).join(",")
					: r.skillNames.slice(0, 3).join(",");
			lines.push(
				`  ${r.at.slice(0, 19)} · ${r.mode} · ${label}${r.parallel ? " · parallel" : ""}`,
			);
		}
	}

	lines.push("", "Stats file: ~/.pi/agent/multi-skill-stats.json");
	return lines.join("\n");
}

export function getLastActivation(): ActivationRecord | null {
	const stats = loadStats();
	return stats.recent[0] ?? null;
}

const MODE_FLAGS = ["--meta", "--lazy", "--full", "--auto", "--parallel"] as const;

/** Replay last activation, optionally overriding load-mode / parallel flags. */
export function replayLastArgs(overrideArgs: string): string | null {
	const last = getLastActivation();
	if (!last?.rawArgs) return null;

	let base = last.rawArgs;
	for (const flag of MODE_FLAGS) {
		base = base.replace(new RegExp(`\\s*${flag}\\b`, "g"), " ").trim();
	}

	const override = overrideArgs.trim();
	if (!override) return base;

	const extraFlags: string[] = [];
	if (/\s--meta\b/.test(` ${override} `)) extraFlags.push("--meta");
	else if (/\s--lazy\b/.test(` ${override} `)) extraFlags.push("--lazy");
	else if (/\s--full\b/.test(` ${override} `)) extraFlags.push("--full");
	if (/\s--auto\b/.test(` ${override} `)) extraFlags.push("--auto");
	if (/\s--parallel\b/.test(` ${override} `)) extraFlags.push("--parallel");

	return extraFlags.length > 0 ? `${base} ${extraFlags.join(" ")}` : base;
}

export function formatLastActivationHint(): string | null {
	const last = getLastActivation();
	if (!last) return null;
	const label =
		last.bundles.length > 0
			? last.bundles.map((b) => `@${b}`).join(",")
			: last.skillNames.slice(0, 4).join(",");
	return `${label} · ${last.mode}${last.parallel ? " · parallel" : ""} · ${last.at.slice(0, 19)}`;
}
