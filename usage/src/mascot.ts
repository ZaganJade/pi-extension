/**
 * Pi-chan — lightweight anime mascot for the usage panel TUI.
 * ASCII poses + per-view icons keep the menu and Wrapped view playful
 * without breaking narrow terminals.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { WrappedStats } from "./aggregate.ts";
import { formatHour } from "./format.ts";

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
export const VIEW_ORDER: ViewKey[] = [
	"overview",
	"models",
	"daily",
	"stats",
	"hourly",
	"agents",
	"wrapped",
];

export interface ViewTabMeta {
	icon: string;
	short: string;
	label: string;
	hint: string;
	/** Accent when this tab is selected. */
	color: ThemeColor;
}

export const VIEW_TABS: Record<ViewKey, ViewTabMeta> = {
	overview: {
		icon: "◈",
		short: "Over",
		label: "Overview",
		hint: "Quota bars & headline stats at a glance",
		color: "accent",
	},
	models: {
		icon: "◎",
		short: "Mod",
		label: "Models",
		hint: "Models, skills, plugins, tools & projects",
		color: "success",
	},
	daily: {
		icon: "☀",
		short: "Day",
		label: "Daily",
		hint: "Per-day activity, uptime & top model",
		color: "warning",
	},
	stats: {
		icon: "▦",
		short: "Stat",
		label: "Stats",
		hint: "Contribution graph & streaks",
		color: "accent",
	},
	hourly: {
		icon: "⏱",
		short: "Hr",
		label: "Hourly",
		hint: "Peak coding hours through the day",
		color: "success",
	},
	agents: {
		icon: "⚡",
		short: "Agnt",
		label: "Agents",
		hint: "Usage split by provider / backend",
		color: "warning",
	},
	wrapped: {
		icon: "✦",
		short: "Wrap",
		label: "Wrapped",
		hint: "Year in review — [ ] or y to change year",
		color: "accent",
	},
};

/** Cycle palette for rainbow bars (monthly chart, tool rows, etc.). */
export const RAINBOW: ThemeColor[] = [
	"accent",
	"success",
	"warning",
	"error",
	"accent",
	"success",
	"warning",
	"accent",
	"success",
	"warning",
	"error",
	"accent",
];

export type MascotPose =
	| "wave"
	| "celebrate"
	| "night"
	| "curious"
	| "sleepy"
	| "tools";

/** Raw ASCII lines per pose (no theme — color applied at render). */
const POSES: Record<MascotPose, string[]> = {
	wave: ["  ∧＿∧", " (◕ ω ◕)", " /  つ  Year", " (  ～  )", "  ～ ～  "],
	celebrate: [" \\(^o^)/", "  ∧＿∧ ", " (≧▽≦)", " /  つ  !", "  ★ ★ ★"],
	night: ["  ∧＿∧ ", " (◕ ‿ ◕)", " /  zzz", " (  つ  )", "  ～ ☾  "],
	curious: ["  ∧＿∧", " (◕ ◡ ◕)?", " /  つ  hm", " (  ～  )", "  ？ ？  "],
	sleepy: ["  ∧＿∧", " ( - ω -)", " /  つ  zZ", " (  ～  )", "  ～ ～  "],
	tools: ["  ∧＿∧", " (◕ ▽ ◕)", " /  つ ⚙", " (  ～  )", "  ♪ ♪ ♪"],
};

const VIEW_POSE: Partial<Record<ViewKey, MascotPose>> = {
	overview: "wave",
	models: "tools",
	daily: "curious",
	stats: "celebrate",
	hourly: "night",
	agents: "wave",
	wrapped: "celebrate",
};

/** Pick a mascot pose for the active view or Wrapped stats mood. */
export function mascotPose(view: ViewKey, stats?: WrappedStats | null): MascotPose {
	if (view === "wrapped") {
		if (!stats) return "sleepy";
		if (stats.longestStreak >= 7) return "celebrate";
		if (stats.peakHour != null && stats.peakHour >= 22) return "night";
		if (stats.modelCount >= 4) return "curious";
		return "celebrate";
	}
	return VIEW_POSE[view] ?? "wave";
}

/** Compact mascot for the Wrapped report sidebar (4 lines, aligned). */
const WRAPPED_POSES: Record<MascotPose, string[]> = {
	wave: ["  ∧＿∧", " (◕‿◕)", " /つ wrap", "  ～～"],
	celebrate: ["  ∧＿∧", " (≧◡≦)", " /つ ✦", "  ★ ★"],
	night: ["  ∧＿∧", " (◕‿◕)", " /つ ☾", "  zzz"],
	curious: ["  ∧＿∧", " (◕◡◕)", " /つ ?", "  ～～"],
	sleepy: ["  ∧＿∧", " (－ω－)", " /つ …", "  ～～"],
	tools: ["  ∧＿∧", " (◕‿◕)", " /つ ⚙", "  ～～"],
};

/** Theme-colored mascot lines. */
export function renderMascot(pose: MascotPose, theme: Theme): string[] {
	const lines = POSES[pose];
	const faceColor: ThemeColor =
		pose === "celebrate" ? "warning" : pose === "night" ? "accent" : "success";
	return lines.map((line, i) => {
		if (i === 1) return theme.fg(faceColor, line);
		if (i === 4 && (pose === "celebrate" || pose === "tools"))
			return theme.fg("warning", line);
		return theme.fg("muted", line);
	});
}

/** Wrapped sidebar mascot — compact, report-card styling. */
export function renderWrappedMascot(pose: MascotPose, theme: Theme): string[] {
	const lines = WRAPPED_POSES[pose];
	return lines.map((line, i) => {
		if (i === 1) return theme.fg("accent", line);
		if (i === 3 && pose === "celebrate")
			return theme.fg("warning", line);
		return theme.fg("borderMuted", line);
	});
}

/** One-line insight caption for the Wrapped footer. */
export function wrappedMascotCaption(stats: WrappedStats | null, year: number): string {
	if (!stats) return `No sessions recorded in ${year}. Pick another year with [ ].`;
	if (stats.longestStreak >= 14) return `${stats.longestStreak}-day streak — standout consistency.`;
	if (stats.peakHour != null && stats.peakHour >= 22)
		return `Peak hour ${formatHour(stats.peakHour)} — late-night sessions dominated.`;
	if (stats.peakHour != null && stats.peakHour < 7)
		return `Peak hour ${formatHour(stats.peakHour)} — early starts shaped the year.`;
	if (stats.topModels.length >= 1 && stats.topModels[0].pct >= 60)
		return `${Math.round(stats.topModels[0].pct)}% of usage on ${stats.topModels[0].name}.`;
	return `${stats.activeDays} active days across ${stats.modelCount} models.`;
}

/** Short speech line for menu hint row. */
export function mascotQuip(view: ViewKey, stats?: WrappedStats | null): string {
	if (view === "wrapped") {
		if (!stats) return "Year in review — [ ] or y to change year";
		if (stats.longestStreak >= 14) return `${stats.longestStreak}-day streak — your highlight stat`;
		if (stats.peakHour != null && stats.peakHour >= 22)
			return "Night sessions defined your peak hours";
		return `${stats.year} report ready — scroll for breakdowns`;
	}
	const tab = VIEW_TABS[view];
	return tab.hint;
}

/** Glyphs for common pi tool names (Models → Tools section). */
const TOOL_GLYPHS: Record<string, string> = {
	read: "↳",
	write: "✎",
	edit: "✎",
	bash: "$",
	grep: "⌕",
	glob: "✶",
	web_fetch: "@",
	web_search: "◎",
	task: "▶",
	ask: "?",
};

export function toolGlyph(name: string): string {
	const base = name.split(":").pop()?.split("/").pop() ?? name;
	return TOOL_GLYPHS[base] ?? TOOL_GLYPHS[base.toLowerCase()] ?? "•";
}
