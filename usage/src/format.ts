/**
 * Number, currency, and progress-bar formatting helpers for the usage panel.
 *
 * Kept dependency-free so it is easy to unit-test and reuse.
 */

/** Format a token count with k/M suffixes. */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${trim(n / 1000)}k`;
	return `${trim(n / 1_000_000)}M`;
}

/** Format a USD cost. Small amounts get more precision. */
export function formatCost(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/** Percentage of `part` relative to `total`, as a rounded integer string. */
export function percent(part: number, total: number): string {
	if (total <= 0) return "0%";
	return `${Math.round((part / total) * 100)}%`;
}

/** Render a horizontal progress bar. Returns the bar string (without ANSI). */
export function bar(ratio: number, width: number): string {
	const w = Math.max(0, Math.floor(width));
	const filled = Math.max(
		0,
		Math.min(w, Math.round(Math.max(0, Math.min(1, ratio)) * w)),
	);
	return "█".repeat(filled) + "░".repeat(w - filled);
}

/** Shorten an absolute path to a friendly project label (~/... style). */
export function shortenPath(p: string, home: string): string {
	if (!p) return "(unknown)";
	let path = p.replace(/\\/g, "/");
	const homeN = home.replace(/\\/g, "/");
	if (homeN && path.toLowerCase().startsWith(homeN.toLowerCase())) {
		path = `~${path.slice(homeN.length)}`;
	}
	// Show last two segments for very long paths.
	const parts = path.split("/").filter(Boolean);
	if (parts.length > 3) return parts.slice(-2).join("/");
	return path || "(unknown)";
}

/**
 * Derive a human-friendly plugin label from a resource's SourceInfo.
 *
 * Priority:
 *   1. Package sources (npm:/git:/github:) → package name (ref stripped)
 *   2. Local/auto skills → the `/skills/<group>/` segment from the path, so
 *      e.g. `~/.claude/skills/bmad/core/bmad-master/SKILL.md` → "bmad" and
 *      `~/.pi/agent/skills/frontend-design/SKILL.md` → "frontend-design".
 *   3. Local extensions → last baseDir segment (skipping generic names)
 *   4. fallback "other"
 */
export function sourceLabel(sourceInfo: {
	source?: string;
	baseDir?: string;
	path?: string;
}): string {
	const { source, baseDir, path } = sourceInfo;

	// 1. Package sources → package name.
	if (source && /^(npm|git|github|file):/.test(source)) {
		let s = source;
		for (const prefix of ["npm:", "git:", "github:", "file:"]) {
			if (s.startsWith(prefix)) s = s.slice(prefix.length);
		}
		s = s.replace(/@[^/]+$/, ""); // strip @version/@sha/@branch
		const parts = s.split("/");
		return parts[parts.length - 1] || s;
	}

	// 2. Local/auto skills: group by the segment right after "/skills/".
	if (path) {
		const p = path.replace(/\\/g, "/");
		const m = p.match(/\/skills\/([^/]+)\//);
		if (m?.[1]) return m[1];
	}

	// 3. Local extensions: last meaningful baseDir segment.
	if (baseDir) {
		const base = baseDir
			.replace(/\\/g, "/")
			.replace(/\/$/, "")
			.split("/")
			.pop();
		if (
			base &&
			base !== "extensions" &&
			base !== "skills" &&
			base !== "agent"
		) {
			return base;
		}
	}

	return "other";
}

function trim(n: number): string {
	return (Math.round(n * 10) / 10).toString();
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human day label from a `YYYY-MM-DD` key, e.g. "Mon Jun 17". */
export function formatDayLabel(dateKey: string): string {
	const [y, m, d] = dateKey.split("-").map((n) => Number.parseInt(n, 10));
	if (!y || !m || !d) return dateKey;
	const date = new Date(y, m - 1, d);
	return `${WEEKDAYS[date.getDay()]} ${MONTHS[m - 1]} ${`${d}`.padStart(2, "0")}`;
}

/** Short month name for a 1-based month index (1 = Jan). */
export function monthLabel(month1: number): string {
	return MONTHS[(month1 - 1 + 12) % 12] ?? "";
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Render a unicode sparkline for a series of non-negative values. */
export function sparkline(values: number[]): string {
	if (values.length === 0) return "";
	const max = Math.max(...values);
	if (max <= 0) return SPARK_CHARS[0].repeat(values.length);
	return values
		.map((v) => {
			if (v <= 0) return " ";
			const idx = Math.min(
				SPARK_CHARS.length - 1,
				Math.max(0, Math.round((v / max) * (SPARK_CHARS.length - 1))),
			);
			return SPARK_CHARS[idx];
		})
		.join("");
}

/** Heatmap glyphs per intensity level (0 = empty). */
export const HEAT_CHARS = ["·", "▪", "▩", "▣", "█"] as const;

/** Format an hour-of-day (0-23) as a friendly 12-hour label, e.g. "2pm". */
export function formatHour(h: number): string {
	const hour = ((h % 24) + 24) % 24;
	if (hour === 0) return "12am";
	if (hour === 12) return "12pm";
	return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/** Format an integer with thousands separators (e.g. 24086 → "24,086"). */
export function formatInt(n: number): string {
	if (!Number.isFinite(n)) return "0";
	return Math.round(n).toLocaleString("en-US");
}

/** Format a duration in ms as a compact human string (e.g. "2h 14m"). */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	const rm = m % 60;
	if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
	const d = Math.floor(h / 24);
	const rh = h % 24;
	return rh ? `${d}d ${rh}h` : `${d}d`;
}
