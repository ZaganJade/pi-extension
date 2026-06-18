import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	ACTIVE_CATEGORY_KEYS,
	CATEGORY_META,
	CATEGORY_ORDER,
	SYSTEM_DETAIL_KEYS,
	TOTAL_CATEGORY_KEYS,
} from "./categories.ts";
import {
	barUsageColor,
	buildDotGridCells,
	formatPercent,
	formatTokens,
	GRID_FILLED_GLYPH,
	GRID_FREE_GLYPH,
	layoutCategoryCells,
	padEndVisible,
	renderMiniBar,
	resolveContextGridLayout,
} from "./format.ts";
import { contextShortcuts, formatShortcutList } from "./mascot.ts";
import type { CategoryItem, CategoryKey, ContextSnapshot } from "./types.ts";

export interface ContextViewDeps {
	theme: Theme;
	tui: TUI | undefined;
	onClose: () => void;
	onRefresh: () => void;
	expandedMode: boolean;
	warnPercent?: number;
	onExport?: () => void;
	onImport?: () => void;
	onHandoff?: () => void;
}

const DETAIL_KEYS = new Set<CategoryKey>([
	...SYSTEM_DETAIL_KEYS,
	"mcpDeferred",
]);

const GRID_MIN_WIDTH = 72;

/** Legend order matches Claude Code `/context` panel. */
const CLAUDE_LEGEND_ORDER: CategoryKey[] = [
	"systemPrompt",
	"systemTools",
	"customAgents",
	"skills",
	"mcpTools",
	"commands",
	"memoryFiles",
	"bundles",
	"messages",
	"mcpDeferred",
	"free",
];

export class ContextView {
	private readonly deps: ContextViewDeps;
	private snapshot: ContextSnapshot;
	private scroll = 0;
	private expandedKey: CategoryKey | null = null;

	constructor(deps: ContextViewDeps, snapshot: ContextSnapshot) {
		this.deps = deps;
		this.snapshot = snapshot;
		this.expandedKey = deps.expandedMode
			? (snapshot.categories.find((c) => c.children?.length)?.key ?? null)
			: null;
	}

	bind(tui: TUI, theme: Theme, onClose: () => void): void {
		this.deps.tui = tui;
		this.deps.theme = theme;
		this.deps.onClose = onClose;
		this.deps.tui?.requestRender();
	}

	setSnapshot(snapshot: ContextSnapshot): void {
		this.snapshot = snapshot;
		this.deps.tui?.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			this.deps.onClose();
			return;
		}
		if (matchesKey(data, "r")) {
			this.deps.onRefresh();
			return;
		}
		if (matchesKey(data, "e") && this.deps.onExport) {
			this.deps.onExport();
			return;
		}
		if (matchesKey(data, "i") && this.deps.onImport) {
			this.deps.onImport();
			return;
		}
		if (matchesKey(data, "h") && this.deps.onHandoff) {
			this.deps.onHandoff();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter)) {
			this.cycleExpand();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.scroll = Math.max(0, this.scroll - 1);
			this.deps.tui?.requestRender();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.scroll += 1;
			this.deps.tui?.requestRender();
		}
	}

	private cycleExpand(): void {
		const expandable = this.snapshot.categories.filter(
			(c) => CATEGORY_META[c.key].expandable && (c.children?.length ?? 0) > 0,
		);
		if (expandable.length === 0) return;
		if (!this.expandedKey) {
			this.expandedKey = expandable[0].key;
		} else {
			const idx = expandable.findIndex((c) => c.key === this.expandedKey);
			this.expandedKey =
				idx < 0 || idx >= expandable.length - 1
					? null
					: expandable[idx + 1].key;
		}
		this.deps.tui?.requestRender();
	}

	render(width: number): string[] {
		const theme = this.deps.theme;
		const snap = this.snapshot;
		const w = Math.max(48, width);
		const cols = this.columnWidths(w);
		const warnPercent = this.deps.warnPercent ?? 70;
		const used = this.usedTokens(snap);
		const headerColor = barUsageColor(used, snap.contextWindow, warnPercent);

		const lines: string[] = [];
		lines.push(truncateToWidth(this.renderTitleLine(theme, used, headerColor), w));
		lines.push(truncateToWidth(this.renderOverviewBar(theme, w, used, headerColor), w));

		if (w >= GRID_MIN_WIDTH) {
			lines.push(...this.renderContextUsagePanel(theme, w, used, headerColor));
		}

		lines.push("");
		lines.push(" " + theme.fg("dim", "└ Breakdown"));
		lines.push(this.tableRule(theme, w, cols));
		lines.push(...this.renderTableHeader(theme, w, cols));

		const visible = this.buildCategoryLines(theme, w, cols);
		const maxBody = Math.max(10, Math.floor((process.stdout.rows || 24) * 0.55));
		const start = Math.min(this.scroll, Math.max(0, visible.length - maxBody));
		for (const line of visible.slice(start, start + maxBody)) {
			lines.push(line);
		}

		lines.push(...this.renderFooter(theme, w, cols));
		return lines;
	}

	private renderTitleLine(
		theme: Theme,
		used: number,
		headerColor: ReturnType<typeof barUsageColor>,
	): string {
		const snap = this.snapshot;
		const usedPrefix = snap.unknownTotal ? "~" : "";
		const pct = snap.unknownTotal ? "?" : formatPercent(used, snap.contextWindow);
		const winStr = formatTokens(snap.contextWindow);
		return (
			theme.fg(
				headerColor,
				` Context · ${snap.modelName} · ${usedPrefix}${formatTokens(used)} / ${winStr} (${pct})`,
			)
		);
	}

	private renderGridGlyph(
		theme: Theme,
		key: CategoryKey | "free",
	): string {
		if (key === "free") {
			return theme.fg("dim", GRID_FREE_GLYPH);
		}
		const meta = CATEGORY_META[key];
		return theme.fg(meta.color, meta.deferred ? "▒" : GRID_FILLED_GLYPH);
	}

	private renderLegendGlyph(theme: Theme, cat: CategoryItem): string {
		if (cat.key === "free") {
			return theme.fg("dim", GRID_FREE_GLYPH);
		}
		const meta = CATEGORY_META[cat.key];
		return theme.fg(meta.color, meta.deferred ? "▒" : GRID_FILLED_GLYPH);
	}

	private shouldShowLegendCategory(cat: CategoryItem): boolean {
		if (this.deps.expandedMode) return true;
		if (cat.key === "free") return true;
		return cat.tokens > 0;
	}

	private renderLegendRow(theme: Theme, cat: CategoryItem): string {
		const snap = this.snapshot;
		const icon = this.renderLegendGlyph(theme, cat);
		const tok = formatTokens(cat.tokens);
		const pct = formatPercent(cat.tokens, snap.contextWindow);
		if (cat.key === "free") {
			return (
				`${icon} ${cat.label}: ` +
				theme.fg("text", tok) +
				theme.fg("dim", ` (${pct})`)
			);
		}
		return (
			`${icon} ${cat.label}: ` +
			theme.fg("text", `${tok} tokens`) +
			theme.fg("dim", ` (${pct})`)
		);
	}

	private renderGridRow(
		theme: Theme,
		cells: (CategoryKey | "free")[],
		row: number,
		cols: number,
		cellStride: number,
	): { text: string; visibleW: number } {
		let text = "";
		let visibleW = 0;
		for (let col = 0; col < cols; col++) {
			const idx = row * cols + col;
			if (idx >= cells.length) break;
			text += this.renderGridGlyph(theme, cells[idx]);
			visibleW += 1;
			if (cellStride > 1 && col < cols - 1) {
				text += " ";
				visibleW += 1;
			}
		}
		return { text, visibleW };
	}

	private composePanelRow(
		gridText: string,
		gridVisibleW: number,
		rightColStart: number,
		rightText: string,
	): string {
		const pad = Math.max(2, rightColStart - gridVisibleW);
		return ` ${gridText}${" ".repeat(pad)}${rightText}`;
	}

	/** Claude Code side-by-side: grid left, model + category estimate right. */
	private renderContextUsagePanel(
		theme: Theme,
		width: number,
		used: number,
		headerColor: ReturnType<typeof barUsageColor>,
	): string[] {
		const snap = this.snapshot;
		const gridLayout = resolveContextGridLayout(width);
		const cellCount = gridLayout.cols * gridLayout.rows;
		const cells = buildDotGridCells(
			snap.categories.map((c) => ({ key: c.key, tokens: c.tokens })),
			snap.contextWindow,
			CATEGORY_ORDER,
			cellCount,
			used,
		);

		const byKey = new Map(snap.categories.map((c) => [c.key, c]));
		const legendCats = CLAUDE_LEGEND_ORDER.map((k) => byKey.get(k)).filter(
			(c): c is CategoryItem => c != null && this.shouldShowLegendCategory(c),
		);

		const usedPrefix = snap.unknownTotal ? "~" : "";
		const pct = snap.unknownTotal ? "?" : formatPercent(used, snap.contextWindow);
		const winStr = formatTokens(snap.contextWindow);

		const rightLines: string[] = [
			theme.fg(headerColor, snap.modelName),
			theme.fg("dim", snap.modelId),
			theme.fg(
				"text",
				`${usedPrefix}${formatTokens(used)}/${winStr} tokens (${pct})`,
			),
			"",
			theme.fg("dim", "Estimated usage by category:"),
			...legendCats.map((cat) => this.renderLegendRow(theme, cat)),
		];

		const lines: string[] = [
			"",
			" " + theme.fg("dim", "└ Context usage"),
			"",
		];

		const rowCount = Math.max(gridLayout.rows, rightLines.length);

		for (let row = 0; row < rowCount; row++) {
			const grid =
				row < gridLayout.rows
					? this.renderGridRow(
							theme,
							cells,
							row,
							gridLayout.cols,
							gridLayout.cellStride,
						)
					: { text: "", visibleW: 0 };
			const right = row < rightLines.length ? rightLines[row] : "";
			lines.push(
				truncateToWidth(
					this.composePanelRow(
						grid.text,
						grid.visibleW,
						gridLayout.rightColStart,
						right,
					),
					width,
				),
			);
		}

		return lines;
	}

	private renderOverviewBar(
		theme: Theme,
		width: number,
		used: number,
		headerColor: ReturnType<typeof barUsageColor>,
	): string {
		const snap = this.snapshot;
		const window = snap.contextWindow;
		const statsW = 14;
		const trackW = Math.max(16, width - statsW - 2);

		const usedW =
			window > 0
				? Math.max(0, Math.min(trackW, Math.round((used / window) * trackW)))
				: 0;
		const freeW = Math.max(0, trackW - usedW);

		const layout = layoutCategoryCells(
			snap.categories.map((c) => ({ key: c.key, tokens: c.tokens })),
			window,
			usedW,
			CATEGORY_ORDER,
		);

		let bar = "";
		for (const seg of layout) {
			const meta = CATEGORY_META[seg.key];
			const ch = meta.deferred ? "▒" : "█";
			bar += theme.fg(meta.color, ch.repeat(seg.cells));
		}
		const laid = layout.reduce((s, l) => s + l.cells, 0);
		if (laid < usedW) {
			bar += theme.fg("accent", "█".repeat(usedW - laid));
		}
		if (freeW > 0) {
			bar += theme.fg("dim", "░".repeat(freeW));
		}

		return (
			" " +
			bar +
			theme.fg("text", ` ${snap.unknownTotal ? "~" : ""}${formatTokens(used)}`) +
			theme.fg(headerColor, ` ${snap.unknownTotal ? "?" : formatPercent(used, window)}`)
		);
	}

	private tableRule(
		theme: Theme,
		width: number,
		cols: ReturnType<ContextView["columnWidths"]>,
	): string {
		const ruleW = cols.labelW + cols.tokW + cols.pctW + cols.barW;
		return theme.fg("dim", " " + "─".repeat(Math.min(width - 1, ruleW)));
	}

	private renderFooter(
		theme: Theme,
		width: number,
		cols: ReturnType<ContextView["columnWidths"]>,
	): string[] {
		const shortcuts = formatShortcutList(
			contextShortcuts(this.expandedKey !== null),
		);
		const lines = ["", this.tableRule(theme, width, cols)];
		lines.push(
			truncateToWidth(
				" " +
					theme.fg("dim", padEndVisible("Keys", cols.labelW)) +
					theme.fg("text", shortcuts),
				width,
			),
		);
		if (!this.deps.expandedMode) {
			lines.push(
				truncateToWidth(
					" " +
						theme.fg("dim", padEndVisible("Note", cols.labelW)) +
						theme.fg(
							"dim",
							"Indented rows are inside system prompt (not added to total)",
						),
					width,
				),
			);
		}
		return lines;
	}

	private usedTokens(snap: ContextSnapshot): number {
		return (
			snap.totalTokens ??
			ACTIVE_CATEGORY_KEYS.reduce(
				(s, k) => s + (snap.categories.find((c) => c.key === k)?.tokens ?? 0),
				0,
			)
		);
	}

	private renderTableHeader(
		theme: Theme,
		width: number,
		cols: ReturnType<ContextView["columnWidths"]>,
	): string[] {
		const header =
			" " +
			padEndVisible("Category", cols.labelW) +
			padEndVisible("Tokens", cols.tokW) +
			padEndVisible("Share", cols.pctW) +
			padEndVisible("Usage", cols.barW);
		return [theme.fg("dim", truncateToWidth(header, width))];
	}

	private columnWidths(width: number): {
		labelW: number;
		tokW: number;
		pctW: number;
		barW: number;
	} {
		const labelW = Math.max(20, Math.min(28, Math.floor(width * 0.34)));
		const tokW = 8;
		const pctW = 6;
		const barW = Math.max(14, width - labelW - tokW - pctW - 3);
		return { labelW, tokW, pctW, barW };
	}

	private renderUsageBar(
		theme: Theme,
		cat: CategoryItem,
		window: number,
		barW: number,
	): string {
		if (barW <= 0) return "";
		if (cat.tokens <= 0 || window <= 0) {
			return " ".repeat(barW);
		}
		const raw = renderMiniBar(cat.tokens, window, barW);
		const meta = CATEGORY_META[cat.key];
		const isDetail = DETAIL_KEYS.has(cat.key);

		if (cat.key === "free") {
			return theme.fg("dim", raw.replace(/█/g, "░"));
		}
		const color =
			isDetail || meta.deferred ? "muted" : meta.color;
		const filled = raw.indexOf(" ");
		if (filled <= 0) {
			return theme.fg(color, raw);
		}
		return (
			theme.fg(color, raw.slice(0, filled)) + raw.slice(filled)
		);
	}

	private formatLabel(cat: CategoryItem, labelW: number): string {
		const meta = CATEGORY_META[cat.key];
		const isDetail = DETAIL_KEYS.has(cat.key);
		const countStr = cat.count != null && cat.count > 0 ? ` (${cat.count})` : "";
		const chevron =
			meta.expandable && (cat.children?.length ?? 0) > 0
				? cat.key === this.expandedKey
					? " ▾"
					: " ›"
				: "";
		let prefix: string;
		if (cat.key === "free") {
			prefix = "○ ";
		} else if (isDetail) {
			prefix = "  └ ";
		} else if (meta.deferred) {
			prefix = "░ ";
		} else {
			prefix = "■ ";
		}
		const name = `${cat.label}${countStr}`;
		const slot = labelW - prefix.length;
		const clipped =
			name.length > slot ? `${name.slice(0, Math.max(1, slot - 1))}…` : name;
		return `${prefix}${clipped}${chevron}`;
	}

	private shouldShowCategory(cat: CategoryItem): boolean {
		if (this.deps.expandedMode || this.expandedKey) return true;
		if (cat.key === "free") return true;
		if (TOTAL_CATEGORY_KEYS.includes(cat.key)) return true;
		return cat.tokens > 0;
	}

	private renderCategoryRow(
		theme: Theme,
		width: number,
		cols: ReturnType<ContextView["columnWidths"]>,
		cat: CategoryItem,
	): string {
		const snap = this.snapshot;
		const meta = CATEGORY_META[cat.key];
		const isDetail = DETAIL_KEYS.has(cat.key);
		const label = this.formatLabel(cat, cols.labelW);
		const tok = formatTokens(cat.tokens);
		const pct = formatPercent(cat.tokens, snap.contextWindow);
		const color =
			cat.key === "free" ? "dim" : isDetail || meta.deferred ? "muted" : meta.color;
		const bar = this.renderUsageBar(theme, cat, snap.contextWindow, cols.barW);

		return truncateToWidth(
			" " +
				theme.fg(color, padEndVisible(label, cols.labelW)) +
				theme.fg("text", padEndVisible(tok, cols.tokW)) +
				theme.fg("muted", padEndVisible(pct, cols.pctW)) +
				bar,
			width,
		);
	}

	private buildCategoryLines(
		theme: Theme,
		width: number,
		cols: ReturnType<ContextView["columnWidths"]>,
	): string[] {
		const lines: string[] = [];
		const snap = this.snapshot;
		const byKey = new Map(snap.categories.map((c) => [c.key, c]));

		for (const key of CATEGORY_ORDER) {
			const cat = byKey.get(key);
			if (!cat || !this.shouldShowCategory(cat)) continue;
			if (cat.key === "free" && cat.tokens <= 0 && !this.deps.expandedMode) {
				continue;
			}

			lines.push(this.renderCategoryRow(theme, width, cols, cat));

			if (cat.key === this.expandedKey && cat.children) {
				for (const child of cat.children.slice(0, 14)) {
					const childLabel = `      ${child.name}`;
					const childTok = formatTokens(child.tokens);
					const childPct = formatPercent(child.tokens, snap.contextWindow);
					const childBar = this.renderUsageBar(
						theme,
						{ ...cat, key: cat.key, label: child.name, tokens: child.tokens },
						snap.contextWindow,
						cols.barW,
					);
					lines.push(
						truncateToWidth(
							" " +
								theme.fg("dim", padEndVisible(childLabel, cols.labelW)) +
								theme.fg("dim", padEndVisible(childTok, cols.tokW)) +
								theme.fg("dim", padEndVisible(childPct, cols.pctW)) +
								childBar,
							width,
						),
					);
				}
				if (cat.children.length > 14) {
					lines.push(
						theme.fg("dim", `      … +${cat.children.length - 14} more`),
					);
				}
			}
		}
		return lines;
	}
}
