import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { formatTokens } from "./format.ts";
import { listPackCatalog, type PackCatalogEntry } from "./config.ts";

function formatPackDescription(entry: PackCatalogEntry, cwd: string): string {
	const parts: string[] = [];
	if (entry.modelName) parts.push(entry.modelName);
	if (entry.totalTokens != null && entry.totalTokens > 0) {
		parts.push(`${formatTokens(entry.totalTokens)} tok`);
	}
	if (entry.matchesProject) {
		parts.push("this project");
	} else if (entry.cwd) {
		const short = entry.cwd.length > 28 ? `…${entry.cwd.slice(-27)}` : entry.cwd;
		parts.push(short);
	}
	if (entry.ageLabel) parts.push(entry.ageLabel);
	if (entry.origin === "extension") parts.push("extension");
	return parts.join(" · ") || entry.name;
}

function rankPack(entry: PackCatalogEntry): number {
	let score = 0;
	if (entry.matchesProject) score += 1000;
	if (entry.name.startsWith("handoff-")) score += 50;
	if (entry.createdAt) score += Math.min(500, entry.createdAt / 1_000_000_000_000);
	return score;
}

function completePackNames(
	prefix: string,
	cwd: string,
): AutocompleteItem[] {
	const query = prefix.trim().toLowerCase();
	const catalog = listPackCatalog(cwd)
		.filter((e) => !query || e.name.toLowerCase().startsWith(query))
		.sort((a, b) => rankPack(b) - rankPack(a) || b.name.localeCompare(a.name));

	return catalog.map((entry) => ({
		value: entry.name,
		label: entry.name,
		description: formatPackDescription(entry, cwd),
	}));
}

/** Autocomplete for /context-import <name> */
export function getContextImportCompletions(
	prefix: string,
	cwd: string,
): AutocompleteItem[] | null {
	const items = completePackNames(prefix, cwd);
	return items.length > 0 ? items : null;
}

/** Autocomplete for /context-export and /context-handoff optional names. */
export function getContextNameCompletions(
	prefix: string,
	cwd: string,
): AutocompleteItem[] | null {
	const items = completePackNames(prefix, cwd);
	return items.length > 0 ? items : null;
}
