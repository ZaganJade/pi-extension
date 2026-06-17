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
	type AttributionMaps,
	type Bucket,
	bucketTokens,
	type Report,
	ranked,
	type WindowedReport,
	type WindowKey,
	windowize,
} from "./aggregate.ts";
import { formatCost, formatTokens, percent, shortenPath } from "./format.ts";
import type { ProviderQuota } from "./provider.ts";

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
		scanProgress: null,
		scroll: 0,
		error: null,
		providerQuota: null,
	};

	constructor(deps: UsageViewDeps) {
		this.deps = deps;
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
		if (matchesKey(data, "5")) {
			this.setWindow("5h");
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

		const win = windowize(
			this.state.report,
			this.state.windowKey,
			this.deps.maps,
		);
		lines.push(this.subheaderLine(win, w));
		lines.push("");

		// Always-on quota bars (5h + weekly).
		const cfg = this.deps.getConfig();
		// The breakdown unit is derived from session history, BUT for subscription
		// providers (e.g. OpenAI Codex, ZAI coding plans) the active session is
		// token-priced, so the breakdown always shows tokens regardless of the
		// cost mix — otherwise a handful of priced legacy turns would force USD
		// mode and token-heavy subscription turns would render as "$0.00" (empty).
		const activeProviderName = this.state.providerQuota?.active?.provider ?? "";
		const isSubscription =
			activeProviderName === "openai-codex" ||
			activeProviderName.startsWith("openai-codex-") ||
			!!this.state.providerQuota?.planQuota;
		const unit: "usd" | "tokens" =
			isSubscription || win.total.cost <= 0 ? "tokens" : "usd";
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
		lines.push("");

		// Headline stats for the selected window.
		lines.push(this.statsLine(win, w));
		lines.push("");

		// Active provider + live quota (from the provider itself).
		this.appendProviderSection(lines, w);

		// "Top consumer" sentence (single biggest independent characteristic).
		const top = this.topConsumer(win);
		if (top) {
			lines.push(`  ${theme.fg("muted", "Top consumer")}`);
			lines.push(
				`  ${theme.fg("text", `${top.pct} of usage came from ${top.kind} `)}${theme.fg("accent", top.name)}`,
			);
			lines.push("");
		}

		// Breakdown sections use the same unit as the quota bars (tokens when
		// the provider has no pricing, USD otherwise).
		const total = unit === "tokens" ? bucketTokens(win.total) : win.total.cost;
		this.appendSection(
			lines,
			"Models",
			win.byModel,
			total,
			w,
			6,
			undefined,
			unit,
		);
		this.appendSection(
			lines,
			"Skills",
			win.bySkill,
			total,
			w,
			6,
			undefined,
			unit,
		);
		// Plugin usage: ranked plugins with the skills/tools that drove each, plus
		// the “core” remainder (turns that used only builtin tools and no skill).
		this.appendPluginUsageSection(lines, win, total, w, unit);
		this.appendSection(
			lines,
			"Tools",
			win.byTool,
			total,
			w,
			6,
			undefined,
			unit,
		);
		this.appendSection(
			lines,
			"Projects",
			win.byProject,
			total,
			w,
			5,
			(k) => shortenPath(k, this.deps.home),
			unit,
		);

		lines.push(this.footerLine(w));
		lines.push(theme.fg("borderMuted", "─".repeat(w)));
		return lines;
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
	): { kind: string; name: string; pct: string } | null {
		// Rank by cost when there's pricing, otherwise by tokens (token-priced providers).
		const useTokens = win.total.cost <= 0;
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

		const headerPad = Math.max(1, width - visibleWidth(`  ${title}`) - 22);
		lines.push(
			`  ${theme.fg("accent", theme.bold(title))}${" ".repeat(headerPad)}${theme.fg("dim", `%        ${unitLabel}`)}`,
		);

		if (rows.length === 0) {
			lines.push(`  ${theme.fg("dim", "— none in this window —")}`);
			lines.push("");
			return;
		}

		const labelW = Math.max(16, Math.min(36, Math.floor((width - 30) * 0.6)));
		const barW = Math.max(6, Math.min(20, width - labelW - 26));
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

		lines.push(`  ${theme.fg("accent", theme.bold("Plugin usage"))}`);
		if (rows.length === 0 && coreValue <= 0) {
			lines.push(`  ${theme.fg("dim", "— none in this window —")}`);
			lines.push("");
			return;
		}

		const labelW = Math.max(16, Math.min(30, Math.floor((width - 32) * 0.5)));
		const barW = Math.max(6, Math.min(16, width - labelW - 30));

		const renderRow = (name: string, value: number, detail?: string) => {
			const pct = total > 0 ? percent(value, total) : "0%";
			const ratio = total > 0 ? value / total : 0;
			const filled = Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * barW));
			const barStr =
				theme.fg("accent", "█".repeat(filled)) +
				theme.fg("borderMuted", "░".repeat(barW - filled));
			const nm = truncateToWidth(name, labelW).padEnd(labelW);
			const right = `${fmt(value)}${detail ? `  ${theme.fg("dim", detail)}` : ""}`;
			lines.push(
				`  ${theme.fg("text", nm)} ${theme.fg("muted", pct.padStart(4))} ${barStr} ${right}`,
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
		const keys = [
			["5", "5-hour"],
			["d", "day"],
			["w", "week"],
			["a", "all"],
			["r", "refresh"],
			["s", "limits"],
			["j/k", "scroll"],
			["q", "close"],
		];
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

/** Format a rate-limit count (tokens use k/M suffixes). */
function formatLimit(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n)}`;
}
