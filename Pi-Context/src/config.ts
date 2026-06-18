import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ContextPack } from "./types.ts";

export interface ContextConfig {
	showWidget: boolean;
	warnPercent: number;
	reservePercent: number;
	autoSuggestHandoff: boolean;
}

const DEFAULTS: ContextConfig = {
	showWidget: false,
	warnPercent: 70,
	reservePercent: 15,
	autoSuggestHandoff: true,
};

export const CONFIG_DEFAULTS: ContextConfig = { ...DEFAULTS };

function clampInt(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(n) || n < min || n > max) return fallback;
	return Math.trunc(n);
}

/** Parse context.json body — returns defaults on corrupt or invalid values. */
export function parseConfigJson(raw: string): ContextConfig {
	try {
		const parsed = JSON.parse(raw) as Partial<ContextConfig>;
		return {
			showWidget:
				typeof parsed.showWidget === "boolean"
					? parsed.showWidget
					: DEFAULTS.showWidget,
			warnPercent: clampInt(parsed.warnPercent, 1, 99, DEFAULTS.warnPercent),
			reservePercent: clampInt(parsed.reservePercent, 1, 49, DEFAULTS.reservePercent),
			autoSuggestHandoff:
				typeof parsed.autoSuggestHandoff === "boolean"
					? parsed.autoSuggestHandoff
					: DEFAULTS.autoSuggestHandoff,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

function configPath(): string {
	return join(getAgentDir(), "context.json");
}

export function loadConfig(): ContextConfig {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULTS };
	try {
		return parseConfigJson(readFileSync(path, "utf8"));
	} catch (err) {
		console.error(`[pi-context] Failed to read ${path}: ${err}`);
		return { ...DEFAULTS };
	}
}

export function saveConfig(config: ContextConfig): void {
	const path = configPath();
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	} catch (err) {
		console.error(`[pi-context] Failed to write ${path}: ${err}`);
	}
}

export function packsDir(): string {
	return join(getAgentDir(), "context-packs");
}

/** Optional packs shipped with or created beside the extension package. */
export function extensionPacksDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "context-packs");
}

export function projectPacksDirs(cwd: string): string[] {
	return [
		join(cwd, ".pi", "context-packs"),
		join(cwd, "context-packs"),
	];
}

export interface PackCatalogEntry {
	name: string;
	origin: "global" | "project-dot-pi" | "project" | "extension";
	cwd?: string;
	modelName?: string;
	createdAt?: number;
	ageLabel?: string;
	totalTokens?: number;
	matchesProject: boolean;
}

function ageLabelFromIso(iso: string | undefined): string | undefined {
	if (!iso) return undefined;
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
	if (ms < 86_400_000) return `${Math.max(1, Math.round(ms / 3_600_000))}h ago`;
	return `${Math.max(1, Math.round(ms / 86_400_000))}d ago`;
}

function originFromDir(dir: string, cwd: string): PackCatalogEntry["origin"] {
	if (dir === extensionPacksDir()) return "extension";
	if (dir === join(cwd, ".pi", "context-packs")) return "project-dot-pi";
	if (dir === join(cwd, "context-packs")) return "project";
	return "global";
}

function parsePackMeta(
	raw: string,
	name: string,
	origin: PackCatalogEntry["origin"],
	cwd: string,
): PackCatalogEntry | null {
	try {
		const parsed = JSON.parse(raw) as Partial<ContextPack>;
		const packCwd = parsed.source?.cwd;
		const createdAt = parsed.createdAt
			? new Date(parsed.createdAt).getTime()
			: undefined;
		return {
			name: parsed.name ?? name,
			origin,
			cwd: packCwd,
			modelName: parsed.source?.modelName,
			createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
			ageLabel: ageLabelFromIso(parsed.createdAt),
			totalTokens: parsed.totalTokens,
			matchesProject: packCwd === cwd,
		};
	} catch {
		return null;
	}
}

function listPacksInDir(
	dir: string,
	origin: PackCatalogEntry["origin"],
	cwd: string,
): PackCatalogEntry[] {
	if (!existsSync(dir)) return [];
	const entries: PackCatalogEntry[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const name = file.slice(0, -5);
		const raw = readFileSync(join(dir, file), "utf8");
		const meta = parsePackMeta(raw, name, origin, cwd);
		if (meta) entries.push(meta);
	}
	return entries;
}

/** All known packs: global agent dir, project roots, extension folder. */
export function listPackCatalog(cwd: string): PackCatalogEntry[] {
	const byName = new Map<string, PackCatalogEntry>();
	const dirs: { dir: string; origin: PackCatalogEntry["origin"] }[] = [
		{ dir: packsDir(), origin: "global" },
		...projectPacksDirs(cwd).map((dir) => ({
			dir,
			origin: originFromDir(dir, cwd),
		})),
		{ dir: extensionPacksDir(), origin: "extension" },
	];

	for (const { dir, origin } of dirs) {
		for (const entry of listPacksInDir(dir, origin, cwd)) {
			const prev = byName.get(entry.name);
			if (!prev || rankCatalogEntry(entry) > rankCatalogEntry(prev)) {
				byName.set(entry.name, entry);
			}
		}
	}

	return [...byName.values()].sort(
		(a, b) => rankCatalogEntry(b) - rankCatalogEntry(a) || a.name.localeCompare(b.name),
	);
}

function rankCatalogEntry(entry: PackCatalogEntry): number {
	let score = 0;
	if (entry.matchesProject) score += 1000;
	if (entry.createdAt) score += Math.min(500, entry.createdAt / 1_000_000_000_000);
	if (entry.origin === "global") score += 10;
	return score;
}

export function findPackFile(name: string, cwd?: string): string | null {
	const candidates = [
		packPath(name),
		...(cwd ? projectPacksDirs(cwd).map((d) => join(d, packFileName(name))) : []),
		join(extensionPacksDir(), packFileName(name)),
	];
	for (const path of candidates) {
		if (existsSync(path)) return path;
	}
	return null;
}

export function sanitizePackName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function packFileName(name: string): string {
	return `${sanitizePackName(name)}.json`;
}

export function packPath(name: string): string {
	return join(packsDir(), packFileName(name));
}

export function listPacks(): string[] {
	const dir = packsDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -5));
}

/** Packs saved from the same project cwd (or global if cwd matches). */
export function listPacksForCwd(cwd: string): string[] {
	return listPackCatalog(cwd)
		.filter((e) => e.matchesProject)
		.map((e) => e.name);
}

export function readPack(name: string, cwd?: string): string | null {
	const path = findPackFile(name, cwd) ?? packPath(name);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

export function writePack(name: string, json: string): void {
	const dir = packsDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(packPath(name), `${json}\n`, "utf8");
}
