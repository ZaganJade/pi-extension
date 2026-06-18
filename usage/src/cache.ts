/**
 * Persistent, incremental scan cache.
 *
 * Re-reading and JSON-parsing every session file on each `/usage` open is the
 * dominant cost (hundreds of files, hundreds of MB). Session files are almost
 * all immutable once written, so we cache the *attributed turns* per session
 * keyed by the file's mtime + size. A later scan only re-parses files whose
 * mtime/size changed; everything else is reused from this cache.
 *
 * The cache is keyed by a `pricesKey` fingerprint too, because manual prices
 * are baked into each turn's cost at parse time — if prices change, the whole
 * cache is rebuilt.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelPrice } from "./config.ts";
import type { TurnEntry } from "./aggregate.ts";

/** Bump when the cached entry shape changes, to invalidate stale caches. */
const CACHE_VERSION = 4;

export interface CachedSession {
	mtimeMs: number;
	size: number;
	entries: TurnEntry[];
}

export interface ScanCache {
	version: number;
	/** Fingerprint of the price table the cached costs were computed with. */
	pricesKey: string;
	/** Per-session-file cached attribution, keyed by absolute file path. */
	sessions: Record<string, CachedSession>;
}

/** Stable fingerprint of the price table (key order-independent). */
export function pricesFingerprint(
	prices: Record<string, ModelPrice> | undefined,
): string {
	if (!prices) return "";
	const keys = Object.keys(prices).sort();
	const parts = keys.map((k) => {
		const p = prices[k];
		return `${k}:${p.input ?? 0},${p.output ?? 0},${p.cacheRead ?? 0},${p.cacheWrite ?? 0}`;
	});
	return parts.join("|");
}

function cachePath(): string {
	return join(getAgentDir(), "usage-cache.json");
}

/** Load the scan cache; returns an empty cache on any error/missing file. */
export function loadScanCache(): ScanCache {
	const empty: ScanCache = { version: CACHE_VERSION, pricesKey: "", sessions: {} };
	const path = cachePath();
	if (!existsSync(path)) return empty;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as ScanCache;
		if (parsed.version !== CACHE_VERSION || typeof parsed.sessions !== "object") {
			return empty;
		}
		return { version: CACHE_VERSION, pricesKey: parsed.pricesKey ?? "", sessions: parsed.sessions ?? {} };
	} catch (err) {
		console.error(`[usage] Failed to read scan cache: ${err}`);
		return empty;
	}
}

/** Persist the scan cache. Never throws. */
export function saveScanCache(cache: ScanCache): void {
	const path = cachePath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cache), "utf8");
	} catch (err) {
		console.error(`[usage] Failed to write scan cache: ${err}`);
	}
}
