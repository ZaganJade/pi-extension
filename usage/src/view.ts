/**
 * Interactive usage panel TUI component.
 *
 * Rendered via ctx.ui.custom(). Mirrors Claude Code's `/usage` screen:
 * always-visible 5-hour and weekly quota bars, a selectable time window, and
 * independent-characteristic breakdowns by model / skill / plugin / tool /
 * project. Supports vertical scrolling for small terminals.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	agentStats,
	agentTopModel,
	type AttributionMaps,
	availableYears,
	type Bucket,
	bucketTokens,
	computeStats,
	type ContribGraph,
	contributionGraph,
	dailyStats,
	dayTopModel,
	dayUptimeMs,
	defaultWrappedYear,
	hourlyStats,
	hourTopModel,
	metricValue,
	naturalMetric,
	ranked,
	rangeLabel,
	rangeSince,
	type Report,
	type StatsRange,
	tokensPerSecond,
	type WrappedStats,
	wrappedStats,
	type WindowedReport,
	type WindowKey,
	windowize,
} from "./aggregate.ts";
import {
	formatCost,
	formatDayLabel,
	formatDuration,
	formatHour,
	formatInt,
	formatTokens,
	monthLabel,
	percent,
	shortenPath,
	sparkline,
} from "./format.ts";
import type { ProviderQuota } from "./provider.ts";

/** Selectable top-level views (Tokscale-style menu + Wrapped AI). */
export type ViewKey =
	| "overview"
	| "models"
	| "daily"
	| "stats"
	| "hourly"
	| "agents"
	| "wrapped";

/** Ordered list of views for tab/arrow navigation. */
const VIEW_ORDER: ViewKey[] = [
	"overview",
	"models",
	"daily",
	"stats",
	"hourly",
	"agents",
	"wrapped",
];

/** Sort field for the Models table. */
type SortKey = "value" | "name";

/** Sort field + direction for the Daily table. */
type DailySortField = "tokens" | "cost" | "date";
type SortDir = "asc" | "desc";

export interface UsageViewDeps {
	theme: Theme;
	tui: TUI | undefined;
	maps: AttributionMaps;
	home: string;
	getConfig: () => {
		fiveHourLimit?: number;
		weeklyLimit?: number;
		fiveHourTokenLimit?: number;
		weeklyTokenLimit?: number;
	};
	onClose: () => void;
	onRefresh: () => void;
	onConfigure: () => void;
}

interface ViewState {
	report: Report | undefined;
	windowKey: WindowKey;
	/** Active top-level view (Overview / Models / Daily / Stats). */
	view: ViewKey;
	/** Sort field for the Models table. */
	sortKey: SortKey;
	/** Sort field + direction for the Daily table. */
	dailySortField: DailySortField;
	dailySortDir: SortDir;
	/** Time range for the Stats view summary (All / 30d / 7d). */
	statsRange: StatsRange;
	/** Calendar year for the Wrapped AI view. */
	wrappedYear: number;
	/** Sort field for the Agents table. */
	agentSortKey: SortKey;
	scanProgress: { loaded: number; total: number } | null;
	scroll: number;
	error: string | null;
	providerQuota: ProviderQuota | null;
}

export class UsageView {
	private readonly deps: UsageViewDeps;
	private state: ViewState = {
		report: undefined,
		windowKey: "24h",
		view: "overview",
		sortKey: "value",
		dailySortField: "tokens",
		dailySortDir: "desc",
		statsRange: "all",
		wrappedYear: new Date().getFullYear(),
		agentSortKey: "value",
		scanProgress: null,
		scroll: 0,
		error: null,
		providerQuota: null,
	};

	constructor(deps: UsageViewDeps) {
		this.deps = deps;
	}

	/** Set the initial view (used by /usage-models, /usage-daily, … shortcuts). */
	setInitialView(view: ViewKey): void {
		this.state.view = view;
		this.deps.tui?.requestRender();
	}

	/** Re-bind the TUI/theme/close callback once pi's custom() factory runs. */
	bind(tui: TUI, theme: Theme, onClose: () => void): void {
		this.deps.tui = tui;
		this.deps.theme = theme;
		this.deps.onClose = onClose;
		this.deps.tui?.requestRender();
	}

	// --- mutators used by the orchestrator (index.ts) ---

	setReport(report: Report): void {
		this.state.report = report;
		this.state.scanProgress = null;
		this.state.error = null;
		this.state.wrappedYear = defaultWrappedYear(report);
		this.clampScroll();
		this.deps.tui?.requestRender();
	}

	setScanning(loaded: number, total: number): void {
		this.state.scanProgress = { loaded, total };
		this.deps.tui?.requestRender();
	}

	setError(message: string): void {
		this.state.error = message;
		this.state.scanProgress = null;
		this.deps.tui?.requestRender();
	}

	setProviderQuota(quota: ProviderQuota): void {
		this.state.providerQuota = quota;
		this.clampScroll();
		this.deps.tui?.requestRender();
	}

	// --- Component interface ---

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			this.deps.onClose();
			return;
		}
		// View navigation: Tab / Shift+Tab + arrows + number keys.
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.cycleView(1);
			return;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, Key.left)) {
			this.cycleView(-1);
			return;
		}
		if (data === "1") return this.setView("overview");
		if (data === "2") return this.setView("models");
		if (data === "3") return this.setView("daily");
		if (data === "4") return this.setView("stats");
		if (data === "6") return this.setView("agents");
		if (data === "7") return this.setView("wrapped");
		if (data === "5") {
			if (this.state.view === "overview" || this.state.view === "models") {
				this.setWindow("5h");
				return;
			}
			return this.setView("hourly");
		}
		// Wrapped AI: [ / ] or y cycle calendar years.
		if (this.state.view === "wrapped") {
			if (data === "[") return this.cycleWrappedYear(-1);
			if (data === "]") return this.cycleWrappedYear(1);
			if (matchesKey(data, "y")) return this.cycleWrappedYear(1);
		}
		// Agents view: c/n sort by usage or name.
		if (this.state.view === "agents") {
			if (matchesKey(data, "c") || matchesKey(data, "t")) {
				this.state.agentSortKey = "value";
				this.deps.tui?.requestRender();
				return;
			}
			if (matchesKey(data, "n")) {
				this.state.agentSortKey = "name";
				this.deps.tui?.requestRender();
				return;
			}
		}
		// Stats view: a/w/m pick the summary time range (intercept before the
		// window-key handlers, since the time window doesn't apply to Stats).
		if (this.state.view === "stats") {
			if (matchesKey(data, "a")) return this.setStatsRange("all");
			if (matchesKey(data, "w")) return this.setStatsRange("7d");
			if (matchesKey(data, "m")) return this.setStatsRange("30d");
		}
		// Daily view: t/c/d choose the sort field; pressing the same key flips
		// direction. Intercept before the global sort/window handlers.
		if (this.state.view === "daily") {
			if (matchesKey(data, "t")) return this.setDailySort("tokens");
			if (matchesKey(data, "c")) return this.setDailySort("cost");
			if (matchesKey(data, "d")) return this.setDailySort("date");
		}
		// Sorting (Models & Daily tables).
		if (this.state.view === "models" && (matchesKey(data, "c") || matchesKey(data, "t"))) {
			this.state.sortKey = "value";
			this.deps.tui?.requestRender();
			return;
		}
		if (this.state.view === "models" && matchesKey(data, "n")) {
			this.state.sortKey = "name";
			this.deps.tui?.requestRender();
			return;
		}
		if (matchesKey(data, "d")) {
			this.setWindow("24h");
			return;
		}
		if (matchesKey(data, "w")) {
			this.setWindow("7d");
			return;
		}
		if (matchesKey(data, "a")) {
			this.setWindow("all");
			return;
		}
		if (matchesKey(data, "r")) {
			this.deps.onRefresh();
			return;
		}
		if (matchesKey(data, "s")) {
			this.deps.onConfigure();
			return;
		}
		if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.space) || matchesKey(data, "ctrl+d")) {
			this.scrollBy(this.availableHeight() / 2);
			return;
		}
		if (matchesKey(data, "ctrl+u") || matchesKey(data, "b")) {
			this.scrollBy(-this.availableHeight() / 2);
			return;
		}
		if (data === "g") {
			this.scrollTo(0);
			return;
		}
		if (data === "G") {
			this.scrollTo(Number.MAX_SAFE_INTEGER);
			return;
		}
	}

	render(width: number): string[] {
		const { theme } = this.deps;
		const all = this.buildLines(width);
		const height = this.availableHeight();

		if (all.length <= height) {
			this.state.scroll = 0;
			return all;
		}

		const max = all.length - height;
		if (this.state.scroll > max) this.state.scroll = max;
		if (this.state.scroll < 0) this.state.scroll = 0;
		const start = this.state.scroll;
		const slice = all.slice(start, start + height);

		// Scroll indicator (top-right) so the user knows there is more content.
		const indicator = ` ${start + 1}-${Math.min(start + height, all.length)}/${all.length} `;
		const last = slice[slice.length - 1] ?? "";
		const pad = Math.max(
			0,
			width - visibleWidth(last) - visibleWidth(indicator),
		);
		slice[slice.length - 1] =
			last + " ".repeat(pad) + theme.fg("dim", indicator);
		return slice;
	}

	invalidate(): void {
		this.deps.tui?.requestRender();
	}

	// --- internals ---

	private availableHeight(): number {
		// Reserve a couple of rows for pi's footer/status. Floor at a sane minimum.
		const rows = this.deps.tui?.terminal?.rows ?? 24;
		return Math.max(8, rows - 2);
	}

	private setWindow(key: WindowKey): void {
		this.state.windowKey = key;
		this.state.scroll = 0;
		this.deps.tui?.requestRender();
	}

	private setView(view: ViewKey): void {
		this.state.view = view;
		this.state.scroll = 0;
		this.deps.tui?.requestRender();
	}

	private cycleView(delta: number): void {
		const idx = VIEW_ORDER.indexOf(this.state.view);
		const next = (idx + delta + VIEW_ORDER.length) % VIEW_ORDER.length;
		this.setView(VIEW_ORDER[next]);
	}

	private setStatsRange(range: StatsRange): void {
		this.state.statsRange = range;
		this.state.scroll = 0;
		this.deps.tui?.requestRender();
	}

	/** Set the Daily sort field; pressing the same field again flips direction. */
	private setDailySort(field: DailySortField): void {
		if (this.state.dailySortField === field) {
			this.state.dailySortDir =
				this.state.dailySortDir === "desc" ? "asc" : "desc";
		} else {
			this.state.dailySortField = field;
			this.state.dailySortDir = "desc";
		}
		this.state.scroll = 0;
		this.deps.tui?.requestRender();
	}

	private cycleWrappedYear(delta: number): void {
		const report = this.state.report;
		if (!report) return;
		const years = availableYears(report);
		if (years.length === 0) return;
		const cur = this.state.wrappedYear;
		const idx = years.indexOf(cur);
		const base = idx >= 0 ? idx : 0;
		const next = (base + delta + years.length) % years.length;
		this.state.wrappedYear = years[next];
		this.state.scroll = 0;
		this.deps.tui?.requestRender();
	}

	private scrollBy(delta: number): void {
		this.scrollTo(this.state.scroll + delta);
	}

	private scrollTo(pos: number): void {
		this.state.scroll = Math.max(0, Math.round(pos));
		this.clampScroll();
		this.deps.tui?.requestRender();
	}

	private clampScroll(): void {
		// Re-clamped precisely in render(); keep a rough bound here.
		if (this.state.scroll < 0) this.state.scroll = 0;
	}

	private buildLines(width: number): string[] {
		const { theme } = this.deps;
		const lines: string[] = [];
		const w = Math.max(40, width);

		lines.push(theme.fg("borderMuted", "─".repeat(w)));
		lines.push(this.titleLineRaw(w));
		lines.push(this.menuLine(w));

		if (this.state.error) {
			lines.push("");
			lines.push(`  ${theme.fg("error", this.state.error)}`);
			lines.push("");
			lines.push(this.footerLine(w));
			lines.push(theme.fg("borderMuted", "─".repeat(w)));
			return lines;
		}

		if (!this.state.report) {
			lines.push("");
			const prog = this.state.scanProgress;
			const msg = prog
				? `Scanning sessions… ${prog.loaded}/${prog.total}`
				: "Scanning sessions…";
			lines.push(`  ${theme.fg("accent", msg)}`);
			lines.push("");
			lines.push(this.footerLine(w));
			lines.push(theme.fg("borderMuted", "─".repeat(w)));
			return lines;
		}

		switch (this.state.view) {
			case "overview":
				this.renderOverview(lines, w);
				break;
			case "models":
				this.renderModels(lines, w);
				break;
			case "daily":
				this.renderDaily(lines, w);
				break;
			case "stats":
				this.renderStats(lines, w);
				break;
			case "hourly":
				this.renderHourly(lines, w);
				break;
			case "agents":
				this.renderAgents(lines, w);
				break;
			case "wrapped":
				this.renderWrapped(lines, w);
				break;
		}

		lines.push(this.footerLine(w));
		lines.push(theme.fg("borderMuted", "─".repeat(w)));
		return lines;
	}

	/**
	 * Subscription-aware breakdown unit: token-priced providers (Codex, ZAI
	 * plans) always show tokens; otherwise USD when the window has real cost.
	 */
	private unitForWindow(win: WindowedReport): "usd" | "tokens" {
		const activeProviderName = this.state.providerQuota?.active?.provider ?? "";
		const isSubscription =
			activeProviderName === "openai-codex" ||
			activeProviderName.startsWith("openai-codex-") ||
			!!this.state.providerQuota?.planQuota;
		return isSubscription || win.total.cost <= 0 ? "tokens" : "usd";
	}

	// ---------------------------------------------------------------- Overview

	private renderOverview(lines: string[], w: number): void {
		const { theme } = this.deps;
		const report = this.state.report;
		if (!report) return;
		const win = windowize(report, this.state.windowKey, this.deps.maps);
		lines.push(this.subheaderLine(win, w));
		lines.push("");

		const unit = this.unitForWindow(win);
		this.renderQuotaBlock(lines, win, w, unit);
		lines.push("");

		// Headline stats for the selected window.
		lines.push(this.statsLine(win, w));
		lines.push("");

		// Active provider + live quota (from the provider itself).
		this.appendProviderSection(lines, w);

		// "Top consumer" sentence (single biggest independent characteristic).
		const top = this.topConsumer(win, unit);
		if (top) {
			lines.push(`  ${theme.fg("muted", "Top consumer")}`);
			lines.push(
				`  ${theme.fg("text", `${top.pct} of usage came from ${top.kind} `)}${theme.fg("accent", top.name)}`,
			);
			lines.push("");
		}

		// Mini trend: last 30 active-window days as a sparkline.
		this.appendTrendSparkline(lines, w);

		// Compact top models for at-a-glance context (full table in Models view).
		const total = unit === "tokens" ? bucketTokens(win.total) : win.total.cost;
		this.appendSection(lines, "Top models", win.byModel, total, w, 5, undefined, unit);
		lines.push(
			`  ${theme.fg("dim", "→ Tab for views · 2 Models · 3 Daily · 5 Hourly · 7 Wrapped AI")}`,
		);
	}

	/** Render the always-on quota bars (plan quota or session-derived budget). */
	private renderQuotaBlock(
		lines: string[],
		win: WindowedReport,
		w: number,
		unit: "usd" | "tokens",
	): void {
		const { theme } = this.deps;
		const cfg = this.deps.getConfig();
		const activeProviderName = this.state.providerQuota?.active?.provider ?? "";
		const planQuota = this.state.providerQuota?.planQuota;
		if (planQuota) {
			// Provider-native plan quota (ZAI GLM coding plans): the upstream reports
			// the authoritative used % + live reset countdown directly. No budget
			// config needed — these ARE the 5h/weekly used/remaining from upstream.
			const planLabel = planQuota.plan
				? `  ${theme.fg("accent", planQuota.plan)} plan · upstream quota`
				: "";
			if (planQuota.session5h) {
				// Session-derived cost/tokens in the same window, combined with the
				// upstream percentage. The right-side text reads:
				//   "100% used / $02.12 · 0% left · resets 3m 9s"
				lines.push(
					this.percentLine(
						"5-hour quota",
						planQuota.session5h,
						w,
						unit,
						win.fiveHour,
					),
				);
			} else if (planQuota.weekly) {
				// Upstream reports weekly but not 5h — show an explicit line so the
				// row doesn't silently disappear (some plans/plans-in-certain-regions
				// only expose the weekly window).
				lines.push(
					`  ${theme.fg("text", "5-hour quota".padEnd(16))} ${theme.fg("dim", "not reported by upstream for this plan")}`,
				);
			}
			if (planQuota.weekly) {
				lines.push(
					this.percentLine(
						"Weekly quota",
						planQuota.weekly,
						w,
						unit,
						win.weekly,
					),
				);
			}
			lines.push(`  ${theme.fg("dim", "live from provider")}${planLabel}`);
			if (planQuota.webSearches) {
				const ws = planQuota.webSearches;
				lines.push(
					`  ${theme.fg("text", "Web searches")}  ${theme.fg("muted", `${ws.used}/${ws.limit}`)}${ws.resetMs ? ` ${theme.fg("dim", `resets ${countdown(ws.resetMs)}`)}` : ""}`,
				);
			}
			if (planQuota.credits) {
				const c = planQuota.credits;
				const value = c.unlimited ? "unlimited" : `${c.balance} credits`;
				lines.push(
					`  ${theme.fg("text", "Credits")}  ${theme.fg("muted", value)}`,
				);
			}
		} else {
			// For subscription providers (OpenAI Codex, ZAI coding plans) the session-derived
			// fallback is misleading — the panel should never suggest `/usage-config` for
			// a subscription, because the real quota comes from the upstream. Show a
			// clear action hint instead so the user knows what to do.
			const isSubscriptionProvider =
				activeProviderName === "openai-codex" ||
				activeProviderName.startsWith("openai-codex-") ||
				activeProviderName === "zai";
			if (isSubscriptionProvider) {
				lines.push(
					`  ${theme.fg("warning", this.buildSubscriptionHint(activeProviderName))}`,
				);
			} else {
				// Fallback: session-derived usage. Unit adapts to the provider (USD for
				// priced providers, tokens for token-priced ones) against a user budget.
				const unitTag = theme.fg(
					"dim",
					unit === "tokens" ? "(tokens)" : "(USD)",
				);
				lines.push(
					this.quotaLine(
						"5-hour quota",
						win.fiveHour,
						unit === "usd" ? cfg.fiveHourLimit : cfg.fiveHourTokenLimit,
						w,
						unit,
					),
				);
				lines.push(
					this.quotaLine(
						"Weekly quota",
						win.weekly,
						unit === "usd" ? cfg.weeklyLimit : cfg.weeklyTokenLimit,
						w,
						unit,
					),
				);
				lines.push(
					`  ${unitTag}  ${theme.fg("dim", `session history · set a budget via /usage-config`)}`,
				);
			}
		}
	}

	// ------------------------------------------------------------------ Models

	private renderModels(lines: string[], w: number): void {
		const report = this.state.report;
		if (!report) return;
		const win = windowize(report, this.state.windowKey, this.deps.maps);
		lines.push(this.subheaderLine(win, w));
		lines.push("");

		const unit = this.unitForWindow(win);
		// Breakdown sections use the same unit as the quota bars (tokens when
		// the provider has no pricing, USD otherwise).
		const total = unit === "tokens" ? bucketTokens(win.total) : win.total.cost;
		this.appendModelTable(lines, win, total, w, unit);
		this.appendSection(lines, "Skills", win.bySkill, total, w, 8, undefined, unit);
		// Plugin usage: ranked plugins with the skills/tools that drove each, plus
		// the “core” remainder (turns that used only builtin tools and no skill).
		this.appendPluginUsageSection(lines, win, total, w, unit);
		this.appendSection(lines, "Tools", win.byTool, total, w, 8, undefined, unit);
		this.appendSection(
			lines,
			"Projects",
			win.byProject,
			total,
			w,
			6,
			(k) => shortenPath(k, this.deps.home),
			unit,
		);
	}

	/**
	 * Models table styled like the Skills section (name · % · bar · value), with
	 * an extra column for the average generation speed (estimated tok/s).
	 */
	private appendModelTable(
		lines: string[],
		win: WindowedReport,
		total: number,
		width: number,
		unit: "usd" | "tokens",
	): void {
		const { theme } = this.deps;
		const bucketValue = (b: Bucket) =>
			unit === "tokens" ? bucketTokens(b) : b.cost;
		const fmt = (n: number) =>
			unit === "tokens" ? formatTokens(n) : formatCost(n);

		const rows =
			this.state.sortKey === "name"
				? [...win.byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))
				: ranked(win.byModel, bucketValue);

		// Match the Skills/appendSection geometry so both sections line up, plus a
		// fixed-width value column so the tok/s column aligns under its header.
		const labelW = Math.max(16, Math.min(36, Math.floor((width - 30) * 0.6)));
		const barW = Math.max(6, Math.min(20, width - labelW - 26));
		const valueW = 9;
		const unitLabel = unit === "tokens" ? "tokens" : "cost";

		lines.push(this.tableHeader("Models", labelW, barW, unitLabel, "tok/s", valueW));
		if (rows.length === 0) {
			lines.push(`  ${theme.fg("dim", "— none in this window —")}`);
			lines.push("");
			return;
		}

		const shown = rows.slice(0, 12);
		for (const [key, b] of shown) {
			const value = bucketValue(b);
			const name = truncateToWidth(key, labelW).padEnd(labelW);
			const pctStr = percent(value, total).padStart(4);
			const ratio = total > 0 ? value / total : 0;
			const filled = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * barW));
			const barStr =
				theme.fg("accent", "█".repeat(filled)) +
				theme.fg("borderMuted", "░".repeat(barW - filled));
			const valueStr = fmt(value).padEnd(valueW);
			const tps = tokensPerSecond(b);
			const rate = tps > 0 ? formatRate(tps) : "—";
			lines.push(
				`  ${theme.fg("text", name)} ${theme.fg("muted", pctStr)} ${barStr} ${theme.fg("dim", valueStr)} ${theme.fg("success", rate)}`,
			);
		}
		const rest = rows.length - shown.length;
		if (rest > 0) {
			lines.push(`  ${theme.fg("dim", `… +${rest} more`)}`);
		}
		lines.push(`  ${theme.fg("dim", "tok/s · est. avg output speed")}`);
		lines.push("");
	}

	// ------------------------------------------------------------ Daily Summary

	private renderDaily(lines: string[], w: number): void {
		const { theme } = this.deps;
		const report = this.state.report;
		if (!report) return;

		const days = dailyStats(report);

		// Totals across all active days (uptime / tokens / cost).
		let totalCost = 0;
		let totalTokens = 0;
		let totalUptime = 0;
		for (const d of days) {
			totalCost += d.bucket.cost;
			totalTokens += bucketTokens(d.bucket);
			totalUptime += dayUptimeMs(d);
		}

		const field = this.state.dailySortField;
		const dir = this.state.dailySortDir;
		const arrow = dir === "asc" ? "↑" : "↓";
		lines.push(
			`  ${theme.fg("muted", "Daily")}   ${theme.fg("dim", `${days.length} active days · all time · sort: ${field} ${arrow}`)}`,
		);
		if (days.length > 0) {
			const totalCostStr =
				totalCost > 0
					? `   ${theme.fg("dim", "·")}   ${theme.fg("dim", "cost")} ${theme.fg("success", formatCost(totalCost))}`
					: "";
			lines.push(
				`  ${theme.fg("dim", "uptime")} ${theme.fg("text", formatDuration(totalUptime))}` +
					`   ${theme.fg("dim", "·")}   ${theme.fg("dim", "tokens")} ${theme.fg("text", formatTokens(totalTokens))}` +
					totalCostStr,
			);
		}
		lines.push("");

		if (days.length === 0) {
			lines.push(`  ${theme.fg("dim", "— no activity recorded —")}`);
			lines.push("");
			return;
		}

		// The bar always tracks tokens (activity): most models are token-priced
		// (cost 0), so a cost-based bar would collapse to empty.
		const dayTokens = (d: (typeof days)[number]) => bucketTokens(d.bucket);
		const maxVal = days.reduce((m, d) => Math.max(m, dayTokens(d)), 0);

		// Sort by the chosen field + direction.
		const sortValue = (d: (typeof days)[number]) =>
			field === "cost" ? d.bucket.cost : field === "date" ? d.ts : dayTokens(d);
		const sign = dir === "asc" ? 1 : -1;
		const sorted = [...days].sort((a, b) => sign * (sortValue(a) - sortValue(b)));

		// Column geometry. The bar is the "graph"; numeric columns give the
		// exact cost / tokens / uptime, and the last column names the day's top
		// model (the model that drove most of that day's spend).
		const labelW = 14;
		const costW = 8;
		const tokW = 9;
		const upW = 7;
		const fixed = 2 + labelW + 1 + 1 + costW + 1 + tokW + 1 + upW + 1;
		const barW = Math.max(6, Math.min(12, w - fixed - 10));
		const modelW = w - fixed - barW;
		const showModel = modelW >= 8;

		// Aligned header.
		let header = `  ${theme.fg("accent", theme.bold("Day".padEnd(labelW)))} ${" ".repeat(barW)}`;
		header += ` ${theme.fg("dim", "cost".padStart(costW))}`;
		header += ` ${theme.fg("dim", "tokens".padStart(tokW))}`;
		header += ` ${theme.fg("dim", "uptime".padStart(upW))}`;
		if (showModel) header += ` ${theme.fg("dim", "top model")}`;
		lines.push(header);

		for (const d of sorted.slice(0, 60)) {
			const value = dayTokens(d);
			const ratio = maxVal > 0 ? value / maxVal : 0;
			const filled = Math.max(value > 0 ? 1 : 0, Math.round(ratio * barW));
			const barColor: ThemeColor =
				ratio > 0.66 ? "accent" : ratio > 0.33 ? "success" : "warning";
			const barStr =
				theme.fg(barColor, "█".repeat(filled)) +
				theme.fg("borderMuted", "░".repeat(barW - filled));
			const label = truncateToWidth(formatDayLabel(d.dateKey), labelW).padEnd(
				labelW,
			);
			// Cost is "—" when the day's models are token-priced (no pricing → 0),
			// so the column doesn't read as a broken row of $0.00.
			const cost = (d.bucket.cost > 0 ? formatCost(d.bucket.cost) : "—").padStart(
				costW,
			);
			const tokens = formatTokens(bucketTokens(d.bucket)).padStart(tokW);
			const uptime = formatDuration(dayUptimeMs(d)).padStart(upW);
			const costCell =
				d.bucket.cost > 0
					? theme.fg("success", cost)
					: theme.fg("dim", cost);
			let line =
				`  ${theme.fg("text", label)} ${barStr}` +
				` ${costCell} ${theme.fg("muted", tokens)} ${theme.fg("dim", uptime)}`;
			if (showModel) {
				const top = dayTopModel(d) ?? "—";
				const m = truncateToWidth(top, modelW - 1);
				line += ` ${theme.fg("accent", m)}`;
			}
			lines.push(line);
		}
		if (sorted.length > 60) {
			lines.push(`  ${theme.fg("dim", `… +${sorted.length - 60} more days`)}`);
		}
		lines.push("");
	}

	// ---------------------------------------------------------------- Hourly

	private renderHourly(lines: string[], w: number): void {
		const { theme } = this.deps;
		const report = this.state.report;
		if (!report) return;

		const hours = hourlyStats(report);
		let totalTokens = 0;
		let totalTurns = 0;
		let activeHours = 0;
		for (const h of hours) {
			const tok = bucketTokens(h.bucket);
			totalTokens += tok;
			totalTurns += h.bucket.turns;
			if (tok > 0) activeHours += 1;
		}

		lines.push(
			`  ${theme.fg("muted", "Hourly")}   ${theme.fg("dim", "by time of day · all days combined")}`,
		);
		if (totalTurns > 0) {
			lines.push(
				`  ${theme.fg("dim", "turns")} ${theme.fg("text", formatInt(totalTurns))}` +
					`   ${theme.fg("dim", "·")}   ${theme.fg("dim", "tokens")} ${theme.fg("text", formatTokens(totalTokens))}` +
					`   ${theme.fg("dim", "·")}   ${theme.fg("dim", "active hours")} ${theme.fg("text", `${activeHours}/24`)}`,
			);
		}
		lines.push("");

		if (totalTurns === 0) {
			lines.push(`  ${theme.fg("dim", "— no activity recorded —")}`);
			lines.push("");
			return;
		}

		const maxVal = hours.reduce(
			(m, h) => Math.max(m, bucketTokens(h.bucket)),
			0,
		);
		const labelW = 6;
		const tokW = 9;
		const turnW = 6;
		const fixed = 2 + labelW + 1 + 1 + tokW + 1 + turnW + 1;
		const barW = Math.max(8, Math.min(24, w - fixed - 14));
		const modelW = Math.max(0, w - fixed - barW);
		const showModel = modelW >= 10;

		let header = `  ${theme.fg("accent", theme.bold("Hour".padEnd(labelW)))} ${" ".repeat(barW)}`;
		header += ` ${theme.fg("dim", "tokens".padStart(tokW))}`;
		header += ` ${theme.fg("dim", "turns".padStart(turnW))}`;
		if (showModel) header += ` ${theme.fg("dim", "top model")}`;
		lines.push(header);

		for (const h of hours) {
			const value = bucketTokens(h.bucket);
			const ratio = maxVal > 0 ? value / maxVal : 0;
			const filled = Math.max(value > 0 ? 1 : 0, Math.round(ratio * barW));
			const barColor: ThemeColor =
				ratio > 0.66 ? "accent" : ratio > 0.33 ? "success" : value > 0 ? "warning" : "borderMuted";
			const barStr =
				value > 0
					? theme.fg(barColor, "█".repeat(filled)) +
						theme.fg("borderMuted", "░".repeat(barW - filled))
					: theme.fg("borderMuted", "·".repeat(barW));
			const label = formatHour(h.hour).padEnd(labelW);
			const tokens = (value > 0 ? formatTokens(value) : "—").padStart(tokW);
			const turns = (h.bucket.turns > 0 ? formatInt(h.bucket.turns) : "—").padStart(
				turnW,
			);
			let line =
				`  ${theme.fg(value > 0 ? "text" : "dim", label)} ${barStr}` +
				` ${theme.fg(value > 0 ? "text" : "dim", tokens)}` +
				` ${theme.fg("dim", turns)}`;
			if (showModel) {
				const top = hourTopModel(h);
				const modelCell = top
					? truncateToWidth(top, modelW)
					: theme.fg("dim", "—");
				line += ` ${theme.fg("muted", modelCell)}`;
			}
			lines.push(line);
		}
		lines.push("");
	}

	// ----------------------------------------------------------------- Agents

	private renderAgents(lines: string[], w: number): void {
		const { theme } = this.deps;
		const report = this.state.report;
		if (!report) return;

		const agents = agentStats(report);
		let totalTokens = 0;
		let totalCost = 0;
		for (const a of agents) {
			totalTokens += bucketTokens(a.bucket);
			totalCost += a.bucket.cost;
		}

		const sortLabel = this.state.agentSortKey === "name" ? "name" : "usage";
		lines.push(
			`  ${theme.fg("muted", "Agents")}   ${theme.fg("dim", `${agents.length} providers · sort: ${sortLabel}`)}`,
		);
		if (agents.length > 0) {
			const costStr =
				totalCost > 0
					? `   ${theme.fg("dim", "·")}   ${theme.fg("dim", "cost")} ${theme.fg("success", formatCost(totalCost))}`
					: "";
			lines.push(
				`  ${theme.fg("dim", "tokens")} ${theme.fg("text", formatTokens(totalTokens))}${costStr}`,
			);
		}
		lines.push("");

		if (agents.length === 0) {
			lines.push(`  ${theme.fg("dim", "— no providers recorded —")}`);
			lines.push("");
			return;
		}

		const rows =
			this.state.agentSortKey === "name"
				? [...agents].sort((a, b) => a.provider.localeCompare(b.provider))
				: agents;

		const labelW = Math.max(14, Math.min(28, Math.floor((w - 36) * 0.45)));
		const barW = Math.max(6, Math.min(18, w - labelW - 28));
		const tokW = 9;
		const projW = 5;

		lines.push(
			this.tableHeader("Provider", labelW, barW, "tokens", "proj", tokW),
		);

		for (const a of rows.slice(0, 16)) {
			const value = bucketTokens(a.bucket);
			const name = truncateToWidth(a.provider, labelW).padEnd(labelW);
			const pctStr = percent(value, totalTokens).padStart(4);
			const ratio = totalTokens > 0 ? value / totalTokens : 0;
			const filled = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * barW));
			const barStr =
				theme.fg("accent", "█".repeat(filled)) +
				theme.fg("borderMuted", "░".repeat(barW - filled));
			const tokStr = formatTokens(value).padEnd(tokW);
			const projStr = formatInt(a.projects.size).padStart(projW);
			const top = agentTopModel(a);
			lines.push(
				`  ${theme.fg("text", name)} ${theme.fg("muted", pctStr)} ${barStr} ${theme.fg("dim", tokStr)} ${theme.fg("success", projStr)}`,
			);
			if (top && w >= labelW + barW + 40) {
				lines.push(
					`  ${" ".repeat(labelW + barW + 8)}${theme.fg("dim", `↳ ${truncateToWidth(top, w - labelW - barW - 12)}`)}`,
				);
			}
		}
		if (rows.length > 16) {
			lines.push(`  ${theme.fg("dim", `… +${rows.length - 16} more providers`)}`);
		}
		lines.push(`  ${theme.fg("dim", "proj · distinct project paths per provider")}`);
		lines.push("");
	}

	// ----------------------------------------------------------- Wrapped AI

	private renderWrapped(lines: string[], w: number): void {
		const { theme } = this.deps;
		const report = this.state.report;
		if (!report) return;

		const year = this.state.wrappedYear;
		const stats = wrappedStats(report, year);
		const years = availableYears(report);

		lines.push(this.wrappedYearLine(years));
		lines.push("");

		if (!stats) {
			lines.push(`  ${theme.fg("dim", `— no activity in ${year} —`)}`);
			if (years.length > 0) {
				lines.push(
					`  ${theme.fg("dim", `Try [ ] to switch year (${years.map(String).join(", ")})`)}`,
				);
			}
			lines.push("");
			return;
		}

		this.appendWrappedHero(lines, stats, w);
		lines.push("");
		this.appendWrappedMonthly(lines, stats, w);
		lines.push("");
		this.appendWrappedHighlights(lines, stats, w);
		lines.push("");
		this.appendWrappedTops(lines, stats, w);
		lines.push("");
		const insight = this.wrappedInsight(stats);
		if (insight) {
			lines.push(`  ${theme.fg("accent", insight)}`);
			lines.push("");
		}
	}

	private wrappedYearLine(years: number[]): string {
		const { theme } = this.deps;
		const year = this.state.wrappedYear;
		const title = theme.fg("accent", theme.bold(" Wrapped AI "));
		const yearBadge = theme.bg(
			"selectedBg",
			theme.fg("accent", theme.bold(` ${year} `)),
		);
		const nav =
			years.length > 1
				? theme.fg("dim", "  [ ] year  ·  y next")
				: theme.fg("dim", "  all years in data");
		return `  ${title}${yearBadge}${nav}`;
	}

	private appendWrappedHero(lines: string[], stats: WrappedStats, w: number): void {
		const { theme } = this.deps;
		const headline =
			stats.metric === "tokens"
				? formatTokens(stats.totalTokens)
				: formatCost(stats.totalCost);
		const unit =
			stats.metric === "tokens" ? "tokens processed" : "estimated spend";
		lines.push(
			`  ${theme.fg("text", theme.bold(headline))} ${theme.fg("muted", unit)}`,
		);
		lines.push(
			`  ${theme.fg("dim", `${formatInt(stats.totalTurns)} turns`)}` +
				`   ${theme.fg("dim", "·")}   ${theme.fg("dim", `${stats.activeDays} active days`)}` +
				`   ${theme.fg("dim", "·")}   ${theme.fg("dim", `${stats.modelCount} models`)}` +
				`   ${theme.fg("dim", "·")}   ${theme.fg("dim", `${stats.providerCount} providers`)}`,
		);

		const pairs: Array<[string, string]> = [
			["Favorite model", stats.favoriteModel ?? "—"],
			["Top provider", stats.favoriteProvider ?? "—"],
			[
				"Busiest day",
				stats.busiestDay ? formatDayLabel(stats.busiestDay.dateKey) : "—",
			],
			["Peak hour", stats.peakHour != null ? formatHour(stats.peakHour) : "—"],
			["Longest streak", `${stats.longestStreak} day${stats.longestStreak === 1 ? "" : "s"}`],
			[
				"Avg / active day",
				stats.metric === "tokens"
					? formatTokens(Math.round(stats.avgPerActiveDay))
					: formatCost(stats.avgPerActiveDay),
			],
		];
		this.appendStatGrid(lines, pairs, w);
	}

	private appendWrappedMonthly(lines: string[], stats: WrappedStats, w: number): void {
		const { theme } = this.deps;
		const max = Math.max(...stats.monthlyTokens, 1);
		const months = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
		const barW = Math.max(1, Math.min(3, Math.floor((w - 40) / 12)));
		const parts: string[] = [];
		for (let i = 0; i < 12; i++) {
			const v = stats.monthlyTokens[i];
			const ratio = v / max;
			const filled = v > 0 ? Math.max(1, Math.round(ratio * barW)) : 0;
			const bar =
				filled > 0
					? theme.fg("accent", "▮".repeat(filled))
					: theme.fg("borderMuted", "·");
			parts.push(`${theme.fg("dim", months[i])}${bar}`);
		}
		lines.push(`  ${theme.fg("muted", "Monthly")}  ${parts.join(" ")}`);
		const activeMonths = stats.monthlyTokens.filter((v) => v > 0).length;
		lines.push(
			`  ${theme.fg("dim", `${activeMonths} active month${activeMonths === 1 ? "" : "s"} in ${stats.year}`)}`,
		);
	}

	private appendWrappedHighlights(lines: string[], stats: WrappedStats, w: number): void {
		const { theme } = this.deps;
		const topProj = stats.topProject
			? truncateToWidth(shortenPath(stats.topProject, this.deps.home), Math.max(20, w - 24))
			: "—";
		const chips = [
			`models ${stats.modelCount}`,
			`providers ${stats.providerCount}`,
			`projects ${stats.projectCount}`,
		];
		lines.push(
			`  ${theme.fg("muted", "Scope")}   ${chips.map((c) => theme.fg("text", c)).join(theme.fg("dim", "  ·  "))}`,
		);
		lines.push(`  ${theme.fg("muted", "Top project")}  ${theme.fg("accent", topProj)}`);
	}

	private appendWrappedTops(lines: string[], stats: WrappedStats, w: number): void {
		const { theme } = this.deps;
		const labelW = Math.max(16, Math.min(28, Math.floor(w * 0.35)));
		const pctW = 5;

		lines.push(`  ${theme.fg("muted", "Top models")}`);
		if (stats.topModels.length === 0) {
			lines.push(`  ${theme.fg("dim", "—")}`);
		}
		for (const m of stats.topModels) {
			const name = truncateToWidth(m.name, labelW).padEnd(labelW);
			const pct = `${Math.round(m.pct)}%`.padStart(pctW);
			lines.push(
				`  ${theme.fg("text", name)} ${theme.fg("muted", pct)} ${theme.fg("dim", formatTokens(m.tokens))}`,
			);
		}

		lines.push("");
		lines.push(`  ${theme.fg("muted", "Top providers")}`);
		if (stats.topProviders.length === 0) {
			lines.push(`  ${theme.fg("dim", "—")}`);
		}
		for (const p of stats.topProviders) {
			const name = truncateToWidth(p.name, labelW).padEnd(labelW);
			const pct = `${Math.round(p.pct)}%`.padStart(pctW);
			lines.push(
				`  ${theme.fg("text", name)} ${theme.fg("muted", pct)} ${theme.fg("dim", formatTokens(p.tokens))}`,
			);
		}
	}

	private wrappedInsight(stats: WrappedStats): string | null {
		if (stats.peakHour != null && stats.peakHour >= 22) {
			return `You're a night owl — peak activity around ${formatHour(stats.peakHour)}`;
		}
		if (stats.peakHour != null && stats.peakHour < 7) {
			return `Early bird — most active around ${formatHour(stats.peakHour)}`;
		}
		if (stats.longestStreak >= 7) {
			return `${stats.longestStreak}-day streak — consistency wins`;
		}
		if (stats.topModels.length >= 2) {
			const top = stats.topModels[0];
			const second = stats.topModels[1];
			if (top.pct >= 60) {
				return `${Math.round(top.pct)}% of your year ran on ${top.name}`;
			}
			if (second.pct >= 20) {
				return `Split between ${top.name} and ${second.name} — versatile stack`;
			}
		}
		if (stats.metric === "usd" && stats.totalCost > 0) {
			return `Estimated ${formatCost(stats.totalCost)} across ${stats.activeDays} active days in ${stats.year}`;
		}
		return `${formatTokens(stats.totalTokens)} tokens across ${stats.activeDays} days — your ${stats.year} in pi`;
	}

	// ------------------------------------------------------------------- Stats

	private renderStats(lines: string[], w: number): void {
		const { theme } = this.deps;
		const report = this.state.report;
		if (!report) return;

		const since = rangeSince(this.state.statsRange);
		const stats = computeStats(report, undefined, since);
		// The calendar always shows the trailing ~year (GitHub-style), regardless
		// of the summary range below it.
		const graph = contributionGraph(report, 53, stats.metric);
		const fmt = (n: number) =>
			stats.metric === "tokens" ? formatTokens(n) : formatCost(n);
		const headline =
			stats.metric === "tokens"
				? `${formatTokens(stats.totalTokens)} tokens`
				: formatCost(stats.totalCost);

		// Title + interactive range selector.
		lines.push(this.statsRangeLine());
		lines.push("");
		this.appendContribGraph(lines, graph, w);
		lines.push("");

		const fmtKey = (k: string | null) => (k ? formatDayLabel(k) : "—");
		const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
		const pairs: Array<[string, string]> = [
			["Total", headline],
			["Total turns", formatInt(stats.totalTurns)],
			["Active days", `${stats.activeDays}`],
			["Favorite model", stats.favoriteModel ?? "—"],
			["Current streak", dayWord(stats.currentStreak)],
			["Longest streak", dayWord(stats.longestStreak)],
			[
				"Busiest day",
				stats.busiestDay ? fmtKey(stats.busiestDay.dateKey) : "—",
			],
			["Peak hour", stats.peakHour != null ? formatHour(stats.peakHour) : "—"],
			["First activity", fmtKey(stats.firstDay)],
			["Avg / active day", fmt(stats.avgPerActiveDay)],
		];
		this.appendStatGrid(lines, pairs, w);

		const fun = this.statsFunFact(stats);
		if (fun) {
			lines.push("");
			lines.push(`  ${theme.fg("accent", fun)}`);
		}
		lines.push("");
	}

	/** Interactive range selector for the Stats view (All / 7d / 30d). */
	private statsRangeLine(): string {
		const { theme } = this.deps;
		const ranges: StatsRange[] = ["all", "7d", "30d"];
		const tabs = ranges
			.map((r) => {
				const text = ` ${rangeLabel(r)} `;
				return r === this.state.statsRange
					? theme.bg("selectedBg", theme.fg("accent", theme.bold(text)))
					: theme.fg("dim", text);
			})
			.join(theme.fg("borderMuted", "│"));
		return `  ${theme.fg("muted", "Stats")}   ${tabs}`;
	}

	/** Render stat pairs in two aligned columns. */
	private appendStatGrid(
		lines: string[],
		pairs: Array<[string, string]>,
		width: number,
	): void {
		const { theme } = this.deps;
		const colW = Math.max(24, Math.floor((width - 2) / 2));
		const labelW = 16;
		const cell = (label: string, value: string) => {
			const v = truncateToWidth(value, Math.max(6, colW - labelW - 1));
			return `${theme.fg("muted", label.padEnd(labelW))} ${theme.fg("text", v)}`;
		};
		for (let i = 0; i < pairs.length; i += 2) {
			const left = cell(pairs[i][0], pairs[i][1]);
			let line = `  ${left}`;
			const next = pairs[i + 1];
			if (next) {
				const pad = Math.max(2, colW - visibleWidth(left));
				line += `${" ".repeat(pad)}${cell(next[0], next[1])}`;
			}
			lines.push(line);
		}
	}

	/** A playful one-liner comparing total usage to a familiar reference. */
	private statsFunFact(stats: {
		totalTokens: number;
		totalCost: number;
		metric: "usd" | "tokens";
	}): string | null {
		// The Great Gatsby ≈ 47k words ≈ ~62k tokens.
		const GATSBY_TOKENS = 62000;
		if (stats.totalTokens >= GATSBY_TOKENS) {
			const ratio = stats.totalTokens / GATSBY_TOKENS;
			return `You've used ~${formatInt(ratio)}x more tokens than The Great Gatsby`;
		}
		if (stats.metric === "usd" && stats.totalCost > 0) {
			return `Total spend across these sessions: ${formatCost(stats.totalCost)}`;
		}
		return null;
	}

	/**
	 * GitHub-style contribution heatmap: a month-label header row, then 7 day
	 * rows (Sun..Sat) of graded square cells, then a Less→More legend.
	 */
	private appendContribGraph(
		lines: string[],
		graph: ContribGraph,
		width: number,
	): void {
		const { theme } = this.deps;
		const colorFor = (level: number): ThemeColor => {
			switch (level) {
				case 4:
					return "accent";
				case 3:
					return "success";
				case 2:
					return "warning";
				case 1:
					return "muted";
				default:
					return "borderMuted";
			}
		};
		// Active days are solid 2-wide blocks so consecutive activity fuses into
		// chunky, seamless squares (the tokscale / Claude Code look). Inactive
		// days stay a faint dot on the dark background — never a filled block —
		// so only real activity is colored.
		const cellW = 2;
		const block = "█".repeat(cellW);
		const empty = "·".padEnd(cellW);

		// Left gutter holds the weekday labels; keep month header aligned to it.
		const gutter = 5;
		const leftPad = gutter + 1;
		const maxWeeks = Math.max(6, Math.floor((width - leftPad - 1) / cellW));
		const weeks =
			graph.weeks.length > maxWeeks
				? graph.weeks.slice(graph.weeks.length - maxWeeks)
				: graph.weeks;

		// Month-label header: place each month abbreviation at the week where it
		// first appears (GitHub-style), so the timeline reads left→right.
		const firstTs = (col: Array<{ ts: number } | null>): number | null => {
			for (const c of col) if (c) return c.ts;
			return null;
		};
		const monthRow = new Array<string>(weeks.length * cellW).fill(" ");
		let lastMonth = -1;
		for (let i = 0; i < weeks.length; i++) {
			const ts = firstTs(weeks[i]);
			if (ts == null) continue;
			const mon = new Date(ts).getMonth();
			if (mon !== lastMonth) {
				lastMonth = mon;
				const label = monthLabel(mon + 1);
				const at = i * cellW;
				for (let k = 0; k < label.length && at + k < monthRow.length; k++) {
					monthRow[at + k] = label[k];
				}
			}
		}
		lines.push(`${" ".repeat(leftPad)}${theme.fg("dim", monthRow.join(""))}`);

		const dowLabels = ["", "Mon", "", "Wed", "", "Fri", ""];
		for (let row = 0; row < 7; row++) {
			let line = `  ${theme.fg("dim", (dowLabels[row] ?? "").padEnd(gutter - 2))} `;
			for (const col of weeks) {
				const cell = col[row];
				if (!cell) {
					line += " ".repeat(cellW);
					continue;
				}
				// Inactive day: faint dot on the dark background (no fill).
				if (cell.level === 0) {
					line += theme.fg("borderMuted", empty);
					continue;
				}
				line += theme.fg(colorFor(cell.level), block);
			}
			lines.push(line);
		}

		let legend = `  ${theme.fg("dim", "Less ")}`;
		legend += theme.fg("borderMuted", empty);
		for (let l = 1; l < 5; l++) legend += theme.fg(colorFor(l), block);
		legend += theme.fg("dim", " More");
		lines.push(legend);
	}

	/** Sparkline of the last 30 active-window days (Overview trend strip). */
	private appendTrendSparkline(lines: string[], _w: number): void {
		const { theme } = this.deps;
		const report = this.state.report;
		if (!report) return;
		const days = dailyStats(report);
		if (days.length === 0) return;
		const metric = naturalMetric(days);
		const recent = days.slice(-30);
		const values = recent.map((d) => metricValue(d.bucket, metric));
		const spark = sparkline(values);
		const span =
			recent.length > 1
				? `${formatDayLabel(recent[0].dateKey).slice(4)} → ${formatDayLabel(recent[recent.length - 1].dateKey).slice(4)}`
				: formatDayLabel(recent[0].dateKey).slice(4);
		lines.push(
			`  ${theme.fg("muted", "Trend")}  ${theme.fg("accent", spark)}  ${theme.fg("dim", span)}`,
		);
		lines.push("");
	}

	private menuLine(width: number): string {
		const { theme } = this.deps;
		const compact = width < 100;
		const labels: Array<[ViewKey, string]> = [
			["overview", compact ? "Over" : "Overview"],
			["models", compact ? "Mod" : "Models"],
			["daily", compact ? "Day" : "Daily"],
			["stats", compact ? "Stat" : "Stats"],
			["hourly", compact ? "Hr" : "Hourly"],
			["agents", compact ? "Agnt" : "Agents"],
			["wrapped", compact ? "Wrap" : "Wrapped"],
		];
		const parts = labels.map(([key, label], i) => {
			const text = ` ${i + 1} ${label} `;
			return key === this.state.view
				? theme.bg("selectedBg", theme.fg("accent", theme.bold(text)))
				: theme.fg("dim", text);
		});
		const menu = parts.join(theme.fg("borderMuted", "│"));
		const pad = Math.max(0, width - visibleWidth(menu) - 2);
		return `  ${menu}${" ".repeat(pad)}`;
	}

	private titleLineRaw(width: number): string {
		const { theme } = this.deps;
		const title = theme.fg("accent", theme.bold(" Usage "));
		const tabs = this.windowTabs();
		const dots = Math.max(
			2,
			width - visibleWidth(title) - visibleWidth(tabs) - 2,
		);
		return `${title}${theme.fg("borderMuted", "─".repeat(dots))}${tabs}`;
	}

	private windowTabs(): string {
		const { theme } = this.deps;
		const cur = this.state.windowKey;
		const tabs: string[] = [];
		for (const key of ["5h", "24h", "7d", "all"] as WindowKey[]) {
			const label = key
				.toUpperCase()
				.replace("24H", "DAY")
				.replace("7D", "WEEK");
			const text = ` ${label} `;
			tabs.push(
				key === cur
					? theme.bg("selectedBg", theme.fg("accent", theme.bold(text)))
					: theme.fg("dim", text),
			);
		}
		return tabs.join(theme.fg("borderMuted", "│"));
	}

	private subheaderLine(win: WindowedReport, width: number): string {
		const { theme } = this.deps;
		const left = theme.fg("muted", `  Showing: ${labelForWindow(win.window)}`);
		const ago =
			win.latest > 0
				? `last activity ${relativeTime(win.latest)}`
				: "no activity";
		const right = theme.fg("dim", `${ago}  ·  ${win.sessionCount} sessions  `);
		const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return left + " ".repeat(pad) + right;
	}

	private quotaLine(
		label: string,
		bucket: Bucket,
		limit: number | undefined,
		width: number,
		unit: "usd" | "tokens" = "usd",
	): string {
		const { theme } = this.deps;
		// Pick the measured value for the chosen unit. When a provider has no
		// pricing (cost === 0 across the window) dollars are meaningless, so the
		// caller switches the unit to tokens — the real usage signal.
		const used = unit === "tokens" ? bucketTokens(bucket) : bucket.cost;
		const hasLimit = typeof limit === "number" && limit > 0;
		const ratio = hasLimit ? used / limit : 0;
		const color: ThemeColor =
			ratio >= 1 ? "error" : ratio >= 0.85 ? "warning" : "success";

		const fmt = (n: number) =>
			unit === "tokens" ? formatTokens(n) : formatCost(n);
		const labelW = 16;
		const lbl = truncateToWidth(label, labelW).padEnd(labelW);
		const barW = Math.max(8, Math.min(28, width - labelW - 34));
		const filled = hasLimit
			? Math.round(Math.min(1, ratio) * barW)
			: Math.min(
					barW,
					Math.max(
						used > 0 ? 1 : 0,
						Math.round(
							Math.sqrt(Math.max(0, used)) * (unit === "tokens" ? 0.02 : 2),
						),
					),
				);
		const barStr =
			theme.fg(color, "█".repeat(filled)) +
			theme.fg("borderMuted", "░".repeat(barW - filled));

		let right: string;
		if (hasLimit) {
			right = `${fmt(used)} / ${fmt(limit as number)} (${percent(used, limit as number)})`;
		} else {
			const hint =
				unit === "tokens"
					? "(no token budget — press s)"
					: "(no limit set — press s)";
			right = `${fmt(used)}  ${theme.fg("dim", hint)}`;
		}
		return `  ${theme.fg("text", lbl)} ${barStr} ${theme.fg("muted", right)}`;
	}

	/**
	 * Render an upstream-reported percentage quota bar (e.g. ZAI 5h/weekly).
	 * The provider only exposes `usedPct` (0-100) + a reset countdown, so the bar
	 * shows used%, remaining%, and when the window resets.
	 */
	private percentLine(
		label: string,
		window: { usedPct: number; resetMs: number },
		width: number,
		unit: "usd" | "tokens",
		sessionBucket?: Bucket,
	): string {
		const { theme } = this.deps;
		const pct = Math.max(0, Math.min(100, window.usedPct));
		const remaining = 100 - pct;
		const color: ThemeColor =
			pct >= 90 ? "error" : pct >= 75 ? "warning" : "success";

		const labelW = 16;
		const lbl = truncateToWidth(label, labelW).padEnd(labelW);

		// Session-derived cost/tokens in the same window, combined with the
		// upstream percentage. Format: "<pct>% used / $<cost> · <rem>% left · resets X".
		let sessionText = "";
		if (sessionBucket) {
			const value =
				unit === "tokens" ? bucketTokens(sessionBucket) : sessionBucket.cost;
			const fmt = (n: number) =>
				unit === "tokens" ? formatTokens(n) : formatCost(n);
			// Always show the session value, even if 0 (so the user sees the bar
			// is genuinely empty for the chosen unit, not just hidden).
			sessionText = ` / ${fmt(value)}`;
		}

		const right = `${pct}% used${sessionText} · ${remaining}% left${
			window.resetMs ? ` · resets ${countdown(window.resetMs)}` : ""
		}`;
		const rightW = visibleWidth(right);
		const barW = Math.max(8, Math.min(28, width - labelW - rightW - 6));
		// Guarantee at least one filled cell when usedPct > 0, so a low-usage
		// window (e.g. 1% of 5h) is still visible rather than rendering as a
		// fully-empty bar that looks like "nothing".
		const filled = pct > 0 ? Math.max(1, Math.round((pct / 100) * barW)) : 0;
		const barStr =
			theme.fg(color, "█".repeat(filled)) +
			theme.fg("borderMuted", "░".repeat(barW - filled));
		return `  ${theme.fg("text", lbl)} ${barStr} ${theme.fg("muted", right)}`;
	}

	/**
	 * Build a context-aware hint explaining why the subscription quota isn't
	 * shown yet. Subscriptions (OpenAI Codex, ZAI coding plans) get their quota
	 * from the upstream — the panel must never suggest `/usage-config` for
	 * these, because that would be wrong (it would just aggregate session
	 * history, not the real plan quota).
	 */
	private buildSubscriptionHint(provider: string): string {
		const notes = this.state.providerQuota?.notes ?? [];
		if (provider === "zai") {
			// ZAI quota comes from the monitor endpoint. If we have notes from
			// fetchProviderQuota, surface them (e.g. token expired).
			return (
				notes[0] ??
				"No upstream quota yet — press r to refresh, or make a request to retry."
			);
		}
		// openai-codex: quota comes from response headers (`x-codex-*`) captured by
		// pi on every Codex request. If we haven't made one this session, no
		// headers are captured yet.
		if (notes.some((n) => n.includes("expired") || n.includes("sign in"))) {
			return "OpenAI Codex token expired — sign in to Codex CLI (`codex auth`), then press r to refresh.";
		}
		return "No Codex headers captured yet — make any request to refresh, then press r.";
	}

	private statsLine(win: WindowedReport, _width: number): string {
		const { theme } = this.deps;
		const t = win.total;
		const totalTokens = bucketTokens(t);
		const parts = [
			`${theme.fg("accent", "↑")}${theme.fg("text", formatTokens(t.input))}`,
			`${theme.fg("accent", "↓")}${theme.fg("text", formatTokens(t.output))}`,
			`${theme.fg("accent", "⚡")}${theme.fg("text", formatTokens(t.cacheRead))}`,
		];
		// Only show $ when there's real pricing; otherwise emphasize total tokens.
		if (t.cost > 0) {
			parts.push(theme.fg("success", formatCost(t.cost)));
		} else {
			parts.push(
				`${theme.fg("success", formatTokens(totalTokens))} ${theme.fg("dim", "tokens")}`,
			);
		}
		const meta = theme.fg("dim", `·  ${win.turnCount} turns`);
		return `  ${parts.join("  ")}   ${meta}`;
	}

	private topConsumer(
		win: WindowedReport,
		unit: "usd" | "tokens",
	): { kind: string; name: string; pct: string } | null {
		// Use the same subscription-aware unit as the rest of the panel. Ranking by
		// cost when a subscription provider is active would wrongly credit the one
		// priced legacy turn (e.g. $0.20 of codex) as "100% of usage" while ignoring
		// the token-heavy subscription turns (e.g. glm-5.2 with 81M tokens).
		const useTokens = unit === "tokens";
		const total = useTokens ? bucketTokens(win.total) : win.total.cost;
		if (total <= 0) return null;
		const bucketValue = (b: Bucket) => (useTokens ? bucketTokens(b) : b.cost);
		const candidates: Array<{ kind: string; name: string; value: number }> = [];
		const pick = (kind: string, map: Map<string, Bucket>) => {
			for (const [name, b] of ranked(map, bucketValue).slice(0, 1)) {
				candidates.push({ kind, name, value: bucketValue(b) });
			}
		};
		pick("model", win.byModel);
		pick("skill", win.bySkill);
		pick("plugin", win.byPlugin);
		candidates.sort((a, b) => b.value - a.value);
		const best = candidates[0];
		if (!best || best.value <= 0) return null;
		return {
			kind: best.kind,
			name: best.name,
			pct: percent(best.value, total),
		};
	}

	/** Render the active-provider banner + live quota + rate-limit windows. */
	private appendProviderSection(lines: string[], width: number): void {
		const { theme } = this.deps;
		const quota = this.state.providerQuota;

		lines.push(`  ${theme.fg("accent", theme.bold("Active provider"))}`);

		if (!quota?.active) {
			lines.push(`  ${theme.fg("dim", "— no active model yet —")}`);
			lines.push("");
			return;
		}

		const a = quota.active;
		const host = hostFromUrl(a.baseUrl);
		const keyBadge = a.hasKey
			? theme.fg("success", "key ✓")
			: theme.fg("warning", "no env key");
		lines.push(
			`  ${theme.fg("text", `${a.provider} / ${a.modelId}`)}  ${theme.fg("dim", host)}  ${keyBadge}`,
		);

		// Live money quota from the provider's billing API.
		if (quota.credits) {
			const c = quota.credits;
			lines.push(
				this.miniBar(
					"Account credits",
					c.remaining,
					c.total,
					`${formatCost(c.remaining)} / ${formatCost(c.total)}`,
					width,
				),
			);
		}
		if (quota.spend5h != null || quota.spend7d != null) {
			const parts: string[] = [];
			if (quota.spend5h != null) parts.push(`5h ${formatCost(quota.spend5h)}`);
			if (quota.spend7d != null) parts.push(`7d ${formatCost(quota.spend7d)}`);
			if (quota.monthlyLimit != null)
				parts.push(`limit ${formatCost(quota.monthlyLimit)}/mo`);
			lines.push(
				`  ${theme.fg("muted", "Provider spend")}  ${theme.fg("text", parts.join("   "))}`,
			);
		}

		// Rate-limit windows captured from the latest provider response.
		if (quota.rateLimits.length > 0) {
			lines.push(
				`  ${theme.fg("muted", "Rate limits (live, from last response)")}`,
			);
			for (const rl of quota.rateLimits.slice(0, 6)) {
				const limit = rl.limit > 0 ? rl.limit : 0;
				const ratio = limit > 0 ? rl.remaining / limit : 0;
				const used = Math.max(0, limit - rl.remaining);
				const reset =
					rl.resetMs > 0 ? `resets in ${countdown(rl.resetMs)}` : "";
				const right = `${formatLimit(rl.remaining)}/${formatLimit(limit)}${reset ? `  ${reset}` : ""}`;
				lines.push(
					this.miniBar(
						rl.resource,
						Math.max(0, ratio),
						undefined,
						right,
						width,
						used,
						limit,
					),
				);
			}
		} else if (quota.source === "none") {
			lines.push(
				`  ${theme.fg("dim", "No rate-limit headers captured yet — make a request first.")}`,
			);
		}

		for (const note of quota.notes) {
			lines.push(`  ${theme.fg("dim", `• ${note}`)}`);
		}
		if (quota.error) {
			lines.push(`  ${theme.fg("error", quota.error)}`);
		}
		lines.push("");
	}

	/** Compact single-line bar: `[label] ██████░░░░ right` */
	private miniBar(
		label: string,
		ratioOrValue: number,
		limitForRatio: number | undefined,
		right: string,
		width: number,
		used?: number,
		limitNum?: number,
	): string {
		const { theme } = this.deps;
		const labelW = 16;
		const lbl = truncateToWidth(label, labelW).padEnd(labelW);

		let ratio: number;
		if (limitForRatio === undefined) {
			// ratioOrValue is itself a 0..1 ratio
			ratio = Math.max(0, Math.min(1, ratioOrValue));
		} else if (limitForRatio > 0) {
			// remaining/limit → bar shows remaining; color by usage pressure
			const remaining = ratioOrValue;
			ratio = remaining / limitForRatio;
		} else {
			ratio = 0;
		}
		// Color: green when plenty remaining, yellow mid, red low.
		const color: ThemeColor =
			ratio >= 0.5 ? "success" : ratio >= 0.2 ? "warning" : "error";

		const rightW = visibleWidth(right);
		const barW = Math.max(6, Math.min(22, width - labelW - rightW - 6));
		const filled = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * barW));
		const barStr =
			theme.fg(color, "█".repeat(filled)) +
			theme.fg("borderMuted", "░".repeat(barW - filled));
		void used;
		void limitNum;
		return `  ${theme.fg("text", lbl)} ${barStr} ${theme.fg("muted", right)}`;
	}

	/**
	 * One aligned table-header row: the section title fills the label column and
	 * the column labels (`%`, value unit, optional extra) sit directly above
	 * their data columns. Keeps every breakdown section visually consistent.
	 */
	private tableHeader(
		title: string,
		labelW: number,
		barW: number,
		valueLabel: string,
		extraLabel?: string,
		valueW?: number,
	): string {
		const { theme } = this.deps;
		const titleCell = theme.fg(
			"accent",
			theme.bold(truncateToWidth(title, labelW).padEnd(labelW)),
		);
		const pctCell = theme.fg("dim", "%".padStart(4));
		const barSpace = " ".repeat(barW);
		const valueCell = theme.fg(
			"dim",
			valueW ? valueLabel.padEnd(valueW) : valueLabel,
		);
		let line = `  ${titleCell} ${pctCell} ${barSpace} ${valueCell}`;
		if (extraLabel) line += ` ${theme.fg("dim", extraLabel)}`;
		return line;
	}

	private appendSection(
		lines: string[],
		title: string,
		map: Map<string, Bucket>,
		total: number,
		width: number,
		limit: number,
		labelFn: (key: string) => string = (k) => k,
		unit: "usd" | "tokens" = "usd",
	): void {
		const { theme } = this.deps;
		const bucketValue = (b: Bucket) =>
			unit === "tokens" ? bucketTokens(b) : b.cost;
		const fmt = (n: number) =>
			unit === "tokens" ? formatTokens(n) : formatCost(n);
		const rows = ranked(map, bucketValue);
		const unitLabel = unit === "tokens" ? "tokens" : "cost";

		// Column geometry (shared with the row layout below) so the header labels
		// sit directly above their columns instead of drifting to the far right.
		const labelW = Math.max(16, Math.min(36, Math.floor((width - 30) * 0.6)));
		const barW = Math.max(6, Math.min(20, width - labelW - 26));
		lines.push(this.tableHeader(title, labelW, barW, unitLabel));

		if (rows.length === 0) {
			lines.push(`  ${theme.fg("dim", "— none in this window —")}`);
			lines.push("");
			return;
		}

		const shown = rows.slice(0, limit);

		for (const [key, bucket] of shown) {
			const value = bucketValue(bucket);
			const name = truncateToWidth(labelFn(key), labelW).padEnd(labelW);
			const pct = percent(value, total);
			const ratio = total > 0 ? value / total : 0;
			const filled = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * barW));
			const barStr =
				theme.fg("accent", "█".repeat(filled)) +
				theme.fg("borderMuted", "░".repeat(barW - filled));
			const pctStr = pct.padStart(4);
			lines.push(
				`  ${theme.fg("text", name)} ${theme.fg("muted", pctStr)} ${barStr} ${theme.fg("dim", fmt(value))}`,
			);
		}

		const rest = rows.length - shown.length;
		if (rest > 0) {
			lines.push(`  ${theme.fg("dim", `… +${rest} more`)}`);
		}
		lines.push("");
	}

	/**
	 * Plugin usage section: ranks plugins by their attributed usage and shows the
	 * specific skills/tools that drove each one, plus the "core" remainder
	 * (turns with only builtin tools and no skill — i.e. plain pi usage).
	 *
	 * Plugins are independent characteristics: a single turn can credit several
	 * plugins, so the percentages need not sum to 100. The core line is the
	 * complement (turns attributed to NO plugin).
	 */
	private appendPluginUsageSection(
		lines: string[],
		win: WindowedReport,
		total: number,
		width: number,
		unit: "usd" | "tokens",
	): void {
		const { theme } = this.deps;
		const fmt = (n: number) =>
			unit === "tokens" ? formatTokens(n) : formatCost(n);
		const bucketValue = (b: Bucket) =>
			unit === "tokens" ? bucketTokens(b) : b.cost;

		const rows = ranked(win.pluginDetail, (c) => bucketValue(c.bucket));
		const coreValue = bucketValue(win.byCore);

		// Share the geometry with the other breakdown sections so columns and bars
		// line up, and give the value a fixed width so the "via" detail aligns.
		const labelW = Math.max(16, Math.min(36, Math.floor((width - 30) * 0.6)));
		const barW = Math.max(6, Math.min(20, width - labelW - 26));
		const valueW = 9;
		const unitLabel = unit === "tokens" ? "tokens" : "cost";

		lines.push(
			this.tableHeader("Plugin usage", labelW, barW, unitLabel, "via", valueW),
		);
		if (rows.length === 0 && coreValue <= 0) {
			lines.push(`  ${theme.fg("dim", "— none in this window —")}`);
			lines.push("");
			return;
		}

		const renderRow = (name: string, value: number, detail?: string) => {
			const pct = total > 0 ? percent(value, total) : "0%";
			const ratio = total > 0 ? value / total : 0;
			const filled = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * barW));
			const barStr =
				theme.fg("accent", "█".repeat(filled)) +
				theme.fg("borderMuted", "░".repeat(barW - filled));
			const nm = truncateToWidth(name, labelW).padEnd(labelW);
			const valueStr = fmt(value).padEnd(valueW);
			const detailStr = detail ? ` ${theme.fg("dim", detail)}` : "";
			lines.push(
				`  ${theme.fg("text", nm)} ${theme.fg("muted", pct.padStart(4))} ${barStr} ${theme.fg("dim", valueStr)}${detailStr}`,
			);
		};

		for (const [name, contrib] of rows.slice(0, 8)) {
			// Summarize which skills/tools of this plugin contributed.
			const parts: string[] = [];
			const topSkills = ranked(contrib.skills, (b) => bucketValue(b)).slice(
				0,
				2,
			);
			for (const [s] of topSkills) parts.push(s);
			const topTools = ranked(contrib.tools, (b) => bucketValue(b)).slice(0, 2);
			for (const [t] of topTools) parts.push(t);
			const detail = parts.length > 0 ? parts.join(", ") : undefined;
			renderRow(name, bucketValue(contrib.bucket), detail);
		}
		if (rows.length > 8) {
			lines.push(`  ${theme.fg("dim", `… +${rows.length - 8} more`)}`);
		}
		// Core remainder: turns with no plugin attribution (builtin tools only).
		if (coreValue > 0) {
			renderRow("(core / no plugin)", coreValue, "builtin tools only");
		}
		lines.push("");
	}

	private footerLine(_width: number): string {
		const { theme } = this.deps;
		const view = this.state.view;
		const keys: Array<[string, string]> = [["⇥/←→", "views"]];
		if (view === "overview" || view === "models") {
			keys.push(["5/d/w/a", "window"]);
		}
		if (view === "models") {
			keys.push(["c/n", "sort"]);
		}
		if (view === "daily") {
			keys.push(["t/c/d", "sort ±"]);
		}
		if (view === "stats") {
			keys.push(["a/w/m", "range"]);
		}
		if (view === "agents") {
			keys.push(["c/n", "sort"]);
		}
		if (view === "wrapped") {
			keys.push(["[ ]/y", "year"]);
		}
		keys.push(["1-7", "jump"], ["r", "refresh"], ["s", "limits"], ["j/k", "scroll"], ["q", "close"]);
		const parts = keys.map(
			([k, label]) => `${theme.fg("accent", k)} ${theme.fg("dim", label)}`,
		);
		return `  ${parts.join(theme.fg("borderMuted", " · "))}`;
	}
}

function labelForWindow(key: WindowKey): string {
	switch (key) {
		case "5h":
			return "last 5 hours";
		case "24h":
			return "last 24 hours";
		case "7d":
			return "last 7 days";
		case "all":
			return "all time";
	}
}

function relativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const min = 60 * 1000;
	const hour = 60 * min;
	const day = 24 * hour;
	if (diff < min) return "just now";
	if (diff < hour) return `${Math.floor(diff / min)}m ago`;
	if (diff < day) return `${Math.floor(diff / hour)}h ago`;
	return `${Math.floor(diff / day)}d ago`;
}

/** Extract a short host from a base URL for the provider banner. */
function hostFromUrl(url: string): string {
	if (!url) return "";
	try {
		const u = new URL(url);
		return u.host;
	} catch {
		return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	}
}

/** Human countdown to a future epoch-ms timestamp. */
function countdown(resetMs: number): string {
	const diff = resetMs - Date.now();
	if (diff <= 0) return "now";
	const s = Math.round(diff / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/** Format a tokens/second rate compactly (e.g. "47", "8.2", "1.2k"). */
function formatRate(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	if (n >= 100) return `${Math.round(n)}`;
	return n.toFixed(1);
}

/** Format a rate-limit count (tokens use k/M suffixes). */
function formatLimit(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}
