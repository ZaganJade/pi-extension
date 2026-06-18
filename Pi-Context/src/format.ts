/** Token, percent, and bar formatting for the context panel. */

import type { CategoryKey } from "./types.ts";

export interface CategoryCellLayout {
	key: CategoryKey;
	cells: number;
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 10_000) return `${trim(n / 1000)}k`;
	if (n < 1_000_000) return `${trim(n / 1000)}k`;
	if (n < 10_000_000) return `${trim(n / 1_000_000)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

function trim(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function percentValue(part: number, total: number): number {
	if (total <= 0) return 0;
	return (part / total) * 100;
}

export function formatPercent(part: number, total: number): string {
	const p = percentValue(part, total);
	if (p < 10) return `${p.toFixed(1)}%`;
	return `${Math.round(p)}%`;
}

export function renderBar(used: number, total: number, width: number): string {
	const ratio = total > 0 ? Math.min(1, used / total) : 0;
	const filled = Math.round(ratio * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/**
 * Distribute cells across categories proportional to token share of contextWindow.
 * Uses largest-remainder so the sum equals cellCount when contextWindow > 0.
 */
export function layoutCategoryCells(
	categories: { key: CategoryKey; tokens: number }[],
	contextWindow: number,
	cellCount: number,
	order: CategoryKey[],
): CategoryCellLayout[] {
	if (contextWindow <= 0 || cellCount <= 0) return [];

	const byKey = new Map(categories.map((c) => [c.key, c.tokens]));
	const keys = order.filter((k) => k !== "free" && (byKey.get(k) ?? 0) > 0);
	if (keys.length === 0) return [];

	const quotas = keys.map((key) => {
		const exact = ((byKey.get(key) ?? 0) / contextWindow) * cellCount;
		const cells = Math.floor(exact);
		return { key, cells, remainder: exact - cells };
	});

	let assigned = quotas.reduce((s, q) => s + q.cells, 0);
	let spare = cellCount - assigned;
	const byRemainder = [...quotas].sort((a, b) => b.remainder - a.remainder);
	for (let i = 0; spare > 0; i++, spare--) {
		byRemainder[i % byRemainder.length].cells += 1;
	}

	const cellMap = new Map(byRemainder.map((q) => [q.key, q.cells]));
	return keys
		.map((key) => ({ key, cells: cellMap.get(key) ?? 0 }))
		.filter((s) => s.cells > 0);
}

export function renderMiniBar(part: number, total: number, width: number): string {
	if (width <= 0) return "";
	if (part <= 0 || total <= 0) return " ".repeat(width);
	let filled = Math.max(0, Math.min(width, Math.round((part / total) * width)));
	// Keep a visible sliver for non-zero shares that round to 0 cells.
	if (part > 0 && filled === 0) filled = 1;
	return "█".repeat(filled) + " ".repeat(width - filled);
}

export function padEndVisible(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	return text + " ".repeat(width - text.length);
}

export function barUsageColor(
	used: number,
	total: number,
	warnPercent = 70,
): "accent" | "warning" | "error" {
	const pct = percentValue(used, total);
	if (pct > 90) return "error";
	if (pct > warnPercent) return "warning";
	return "accent";
}

export function buildDotGridCells(
	categories: { key: CategoryKey; tokens: number }[],
	contextWindow: number,
	order: CategoryKey[],
	cellCount: number,
	usedTokens: number,
): (CategoryKey | "free")[] {
	const filledCount =
		contextWindow > 0
			? Math.max(
					0,
					Math.min(
						cellCount,
						Math.round((usedTokens / contextWindow) * cellCount),
					),
				)
			: 0;

	const layout = layoutCategoryCells(
		categories,
		contextWindow,
		filledCount,
		order,
	);
	const cells: (CategoryKey | "free")[] = [];
	for (const seg of layout) {
		for (let i = 0; i < seg.cells; i++) cells.push(seg.key);
	}
	while (cells.length < cellCount) cells.push("free");
	return cells.slice(0, cellCount);
}

/** Claude Code `/context` grid dimensions (16×9 default). */
export const CONTEXT_GRID_COLS = 16;
export const CONTEXT_GRID_ROWS = 9;
export const CONTEXT_GRID_CELL_COUNT = CONTEXT_GRID_COLS * CONTEXT_GRID_ROWS;

/** Filled / free glyphs approximating Claude's stack / hollow cells. */
export const GRID_FILLED_GLYPH = "▤";
export const GRID_FREE_GLYPH = "□";

export interface ContextGridLayout {
	cols: number;
	rows: number;
	cellStride: number;
	/** Visible column (0-based after leading space) where right panel begins. */
	rightColStart: number;
}

/** Scale grid + right column with terminal width so content is not left-cramped. */
export function resolveContextGridLayout(width: number): ContextGridLayout {
	const inner = Math.max(48, width) - 1;
	let cols = CONTEXT_GRID_COLS;
	let cellStride = 1;
	if (inner >= 120) {
		cols = 24;
		cellStride = 2;
	} else if (inner >= 100) {
		cols = 20;
		cellStride = 2;
	} else if (inner >= 88) {
		cols = 18;
		cellStride = 2;
	}
	const rows = CONTEXT_GRID_ROWS;
	const gridVisibleW = cols * cellStride;
	const rightColStart = Math.max(
		gridVisibleW + 10,
		Math.floor(inner * 0.38),
	);
	return { cols, rows, cellStride, rightColStart };
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

const TRUNC_SUFFIX = "\n…[truncated]";

/** Escape text for safe inclusion inside XML elements/attributes. */
export function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Truncate text so estimateTextTokens(result) <= tokenBudget.
 * Re-checks after suffix append to avoid overshooting the budget.
 */
export function truncateToTokenBudget(text: string, tokenBudget: number): string {
	if (tokenBudget <= 0) return "";
	if (estimateTextTokens(text) <= tokenBudget) return text;

	const suffixTokens = estimateTextTokens(TRUNC_SUFFIX);
	const contentBudget = Math.max(1, tokenBudget - suffixTokens);
	let maxChars = contentBudget * 4;
	let result = `${text.slice(0, maxChars)}${TRUNC_SUFFIX}`;

	while (estimateTextTokens(result) > tokenBudget && maxChars > 0) {
		maxChars -= 32;
		result =
			maxChars > 0
				? `${text.slice(0, maxChars)}${TRUNC_SUFFIX}`
				: "";
	}
	return result;
}
