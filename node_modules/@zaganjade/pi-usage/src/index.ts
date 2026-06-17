/**
 * Pi usage extension — a Claude Code-style `/usage` panel for pi.
 *
 * Commands:
 *   /usage         Open the interactive usage panel (5H / day / week / all
 *                  windows, quota bars, model/skill/plugin/tool/project
 *                  breakdowns).
 *   /usage-config  Set your 5-hour and weekly USD budgets.
 *   /usage-widget  Toggle a compact always-on spend widget above the editor.
 *
 * Config: ~/.pi/agent/usage.json (see config.ts).
 *
 * Budgets are user-defined because pi works with any provider — unlike Claude
 * Code's subscription, pi has no built-in quota. Set limits that match your
 * plan and the panel shows progress against them.
 */
import { homedir } from "node:os";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AttributionMaps,
	buildAttributionMaps,
	type Report,
	scanSessions,
} from "./aggregate.ts";
import { loadConfig, saveConfig, type UsageConfig } from "./config.ts";
import { formatCost, formatTokens } from "./format.ts";
import {
	type ActiveProvider,
	detectActiveProvider,
	fetchProviderQuota,
	parseRateLimits,
	type RateLimitWindow,
} from "./provider.ts";
import { UsageView } from "./view.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

export default function usageExtension(pi: ExtensionAPI) {
	const home = homedir();
	let config: UsageConfig = loadConfig();
	let maps: AttributionMaps = {
		toolToPlugin: new Map(),
		skillToPlugin: new Map(),
	};
	let cache: { report: Report; at: number } | null = null;
	// Latest context, captured for widget updates (setWidget needs ctx.ui).
	let latestCtx: ExtensionContext | null = null;
	// Active provider + most recent rate-limit headers, captured live from the
	// provider responses so the panel can show the provider's own quota.
	let activeProvider: ActiveProvider | null = null;
	let capturedRateLimits: RateLimitWindow[] = [];
	// Raw headers from the most recent provider response (for Codex x-codex-* parsing).
	let capturedHeaders: Record<string, string> = {};

	// Track the active provider and capture rate-limit headers from responses.
	pi.on("session_start", async (_e, ctx) => {
		activeProvider = detectActiveProvider(ctx.model);
	});
	pi.on("model_select", async (event) => {
		activeProvider = detectActiveProvider(event.model);
		refreshWidget();
	});
	pi.on("after_provider_response", async (event) => {
		// Only trust headers from successful responses; 4xx/5xx often omit them.
		if (event.status >= 400) return;
		capturedRateLimits = parseRateLimits(event.headers);
		capturedHeaders = event.headers;
	});

	const captureCtx = (ctx: ExtensionContext) => {
		latestCtx = ctx;
	};

	// Rebuild attribution maps when resources (re)load; refresh the widget.
	pi.on("session_start", async () => {
		maps = buildAttributionMaps(pi);
		refreshWidget();
	});
	pi.on("session_start", async (_e, ctx) => captureCtx(ctx));
	pi.on("turn_end", async (_e, ctx) => {
		captureCtx(ctx);
		refreshWidget();
	});

	// ------------------------------------------------------------------ /usage

	pi.registerCommand("usage", {
		description: "Show usage panel (5h / day / week / all, quotas, breakdowns)",
		handler: async (_args, ctx) => {
			await openUsagePanel(ctx);
		},
	});

	async function openUsagePanel(ctx: ExtensionContext): Promise<void> {
		// Constructed with tui/theme undefined; both are re-bound inside the
		// custom() factory where pi hands us the real instances. No setReport
		// is called before binding, so the optional tui access is safe.
		const view = new UsageView({
			theme: ctx.ui.theme,
			tui: undefined,
			maps,
			home,
			getConfig: () => config,
			onClose: () => undefined, // patched once `done` is available
			onRefresh: () => {
				void runScan(ctx, view, true);
				void runProviderQuota(ctx, view);
			},
			onConfigure: () => {
				void configureLimits(ctx);
			},
		});

		await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
			view.bind(tui, theme, () => done(undefined));

			// Show the provider's live quota (active provider + captured headers +
			// billing-API fetch) alongside the session-aggregated usage.
			void runProviderQuota(ctx, view);

			const cached = cache;
			const fresh = cached != null && Date.now() - cached.at < CACHE_TTL;
			if (fresh && cached) view.setReport(cached.report);
			else void runScan(ctx, view, false);

			return view;
		});
	}

	async function runScan(
		ctx: ExtensionContext,
		view: UsageView,
		force: boolean,
	): Promise<void> {
		if (!force && cache && Date.now() - cache.at < CACHE_TTL) {
			view.setReport(cache.report);
			return;
		}
		view.setScanning(0, 0);
		try {
			const report = await scanSessions(
				config.maxSessions ?? 1000,
				config.excludeProjects ?? [],
				(loaded, total) => view.setScanning(loaded, total),
			);
			cache = { report, at: Date.now() };
			view.setReport(report);
			refreshWidget();
		} catch (err) {
			view.setError(
				`Failed to scan sessions: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		void ctx; // ctx retained for future per-session filtering
	}

	/** Fetch the active provider's live quota + merge captured rate-limit headers. */
	async function runProviderQuota(
		ctx: ExtensionContext,
		view: UsageView,
	): Promise<void> {
		// Keep the active provider fresh in case the model changed.
		activeProvider = detectActiveProvider(ctx.model);
		try {
			const quota = await fetchProviderQuota(
				activeProvider,
				capturedRateLimits,
				capturedHeaders,
				ctx.signal,
			);
			view.setProviderQuota(quota);
		} catch (err) {
			view.setProviderQuota({
				active: activeProvider,
				fetchedAt: Date.now(),
				rateLimits: capturedRateLimits,
				source: "none",
				notes: [],
				error: `Failed to fetch provider quota: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}

	// ------------------------------------------------------------ /usage-config

	pi.registerCommand("usage-config", {
		description: "Set 5-hour and weekly USD usage budgets",
		handler: async (_args, ctx) => {
			await configureLimits(ctx);
		},
	});

	async function configureLimits(ctx: ExtensionContext): Promise<void> {
		// USD budgets (priced providers).
		const five = await ctx.ui.input(
			"5-hour budget (USD, 0 = no limit)",
			`${config.fiveHourLimit ?? 0}`,
		);
		if (five === undefined) return;
		const weekly = await ctx.ui.input(
			"Weekly budget (USD, 0 = no limit)",
			`${config.weeklyLimit ?? 0}`,
		);
		if (weekly === undefined) return;
		// Token budgets (token-priced providers like zai/GLM).
		const fiveTok = await ctx.ui.input(
			"5-hour token budget (e.g. 2000000, 0 = none)",
			`${config.fiveHourTokenLimit ?? 0}`,
		);
		if (fiveTok === undefined) return;
		const weeklyTok = await ctx.ui.input(
			"Weekly token budget (e.g. 10000000, 0 = none)",
			`${config.weeklyTokenLimit ?? 0}`,
		);
		if (weeklyTok === undefined) return;

		config = {
			...config,
			fiveHourLimit: parseUsd(five),
			weeklyLimit: parseUsd(weekly),
			fiveHourTokenLimit: parseUsd(fiveTok),
			weeklyTokenLimit: parseUsd(weeklyTok),
		};
		saveConfig(config);
		cache = null; // force re-eval of quota colors next open
		refreshWidget();
		ctx.ui.notify(
			`Budgets set · 5h ${formatCost(config.fiveHourLimit ?? 0)} / ${formatTokens(config.fiveHourTokenLimit ?? 0)} tok`,
			"info",
		);
	}

	// ------------------------------------------------------------ /usage-widget

	pi.registerCommand("usage-widget", {
		description: "Toggle the always-on usage summary widget",
		handler: async (_args, ctx) => {
			config = { ...config, showWidget: !config.showWidget };
			saveConfig(config);
			if (!config.showWidget) ctx.ui.setWidget("usage", undefined);
			refreshWidget();
			ctx.ui.notify(`Usage widget ${config.showWidget ? "on" : "off"}`, "info");
		},
	});

	function refreshWidget(): void {
		if (!config.showWidget || !latestCtx) return;
		const summary = currentSessionWindows();
		// Use tokens when there's no meaningful $ cost in the current session (token-priced providers).
		const useTokens = summary.fiveHourCost <= 0 && summary.weeklyCost <= 0;
		const fmt = (n: number) => (useTokens ? formatTokens(n) : formatCost(n));
		const f5 = useTokens ? summary.fiveHourTokens : summary.fiveHourCost;
		const w7 = useTokens ? summary.weeklyTokens : summary.weeklyCost;
		const lim5 = useTokens ? config.fiveHourTokenLimit : config.fiveHourLimit;
		const lim7 = useTokens ? config.weeklyTokenLimit : config.weeklyLimit;
		const five = `5H ${fmt(f5)}${lim5 && lim5 > 0 ? ` / ${fmt(lim5)}` : ""}${useTokens ? " tok" : ""}`;
		const week = `week ${fmt(w7)}${lim7 && lim7 > 0 ? ` / ${fmt(lim7)}` : ""}${useTokens ? " tok" : ""}`;
		const theme = latestCtx.ui.theme;
		latestCtx.ui.setWidget("usage", [
			`${theme.fg("dim", "usage")}  ${theme.fg("text", five)}   ${theme.fg("text", week)}`,
		]);
	}

	/** Sum cost + tokens in the current session branch for the 5h and 7d windows. */
	function currentSessionWindows(): {
		fiveHourCost: number;
		weeklyCost: number;
		fiveHourTokens: number;
		weeklyTokens: number;
	} {
		const zero = {
			fiveHourCost: 0,
			weeklyCost: 0,
			fiveHourTokens: 0,
			weeklyTokens: 0,
		};
		const sm = latestCtx?.sessionManager;
		if (!sm) return zero;
		const now = Date.now();
		let fiveHourCost = 0;
		let weeklyCost = 0;
		let fiveHourTokens = 0;
		let weeklyTokens = 0;
		for (const e of sm.getBranch()) {
			if (e.type !== "message") continue;
			const m = e.message as AssistantMessage;
			if (m.role !== "assistant" || !m.usage) continue;
			const u = m.usage;
			const tok = u.input + u.output + u.cacheRead + u.cacheWrite;
			if (m.timestamp >= now - 5 * HOUR) {
				fiveHourCost += u.cost.total;
				fiveHourTokens += tok;
			}
			if (m.timestamp >= now - 7 * DAY) {
				weeklyCost += u.cost.total;
				weeklyTokens += tok;
			}
		}
		return { fiveHourCost, weeklyCost, fiveHourTokens, weeklyTokens };
	}
}

/** Parse a user-entered USD string into a number (0 on invalid/empty). */
function parseUsd(input: string | undefined): number {
	if (!input) return 0;
	const n = Number.parseFloat(input.replace(/[^0-9.]/g, ""));
	return Number.isFinite(n) && n >= 0 ? n : 0;
}
