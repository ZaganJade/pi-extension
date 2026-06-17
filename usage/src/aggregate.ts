/**
 * Session aggregation and usage attribution.
 *
 * The usage panel mirrors Claude Code's `/usage` view: it shows how spend and
 * tokens are distributed across models, skills, plugins, tools, and projects,
 * bucketed by time window (5h / 24h / 7d / all).
 *
 * Data source
 * -----------
 * Pi stores per-turn usage (tokens + cost) on every assistant message across
 * all session JSONL files under ~/.pi/agent/sessions/. We open each file once,
 * walk its entries in append order, and attribute each assistant turn to:
 *   - a model        (from message.model)
 *   - a project      (from the session header cwd)
 *   - a skill        (detected via parseSkillBlock on the preceding user msg)
 *   - tools/plugins  (from the tool calls inside the assistant message)
 *
 * Important: skills, plugins, tools and models are *independent characteristics*
 * of usage, not a disjoint partition — a single turn can contribute to several
 * buckets at once (exactly like Claude Code's wording). Percentages therefore
 * do not sum to 100% across categories.
 */
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	parseSkillBlock,
	type SessionEntry,
	type SessionInfo,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { sourceLabel } from "./format.ts";

/** Time windows selectable in the panel. */
export type WindowKey = "5h" | "24h" | "7d" | "all";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function windowMs(key: WindowKey): number {
	switch (key) {
		case "5h":
			return 5 * HOUR;
		case "24h":
			return DAY;
		case "7d":
			return 7 * DAY;
		case "all":
			return Number.POSITIVE_INFINITY;
	}
}

export function windowLabel(key: WindowKey): string {
	switch (key) {
		case "5h":
			return "Last 5 hours";
		case "24h":
			return "Last 24 hours";
		case "7d":
			return "Last 7 days";
		case "all":
			return "All time";
	}
}

/** Built-in tool names — excluded from the Plugins breakdown but shown in Tools. */
const BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

/** Mutable usage totals for a bucket. */
export interface Bucket {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
}

function emptyBucket(): Bucket {
	return {
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		turns: 0,
	};
}

function addBucket(b: Bucket, u: Usage): void {
	b.cost += u.cost.total;
	b.input += u.input;
	b.output += u.output;
	b.cacheRead += u.cacheRead;
	b.cacheWrite += u.cacheWrite;
	b.turns += 1;
}

/** Total tokens consumed by a bucket (input + output + cache reads/writes). */
export function bucketTokens(b: Bucket): number {
	return b.input + b.output + b.cacheRead + b.cacheWrite;
}

/** A single attributed assistant turn on the timeline. */
export interface TurnEntry {
	ts: number;
	model: string;
	provider: string;
	project: string;
	cost: number;
	usage: Usage;
	skill: string | null;
	tools: string[];
}

/** Full raw report built once, then windowed on demand. */
export interface Report {
	computedAt: number;
	sessionCount: number;
	turnCount: number;
	entries: TurnEntry[];
}

/** Runtime-derived maps for attributing tools/skills to plugin labels. */
export interface AttributionMaps {
	toolToPlugin: Map<string, string>;
	skillToPlugin: Map<string, string>;
}

/** Build tool->plugin and skill->plugin maps from the currently loaded resources. */
export function buildAttributionMaps(pi: ExtensionAPI): AttributionMaps {
	const toolToPlugin = new Map<string, string>();
	for (const tool of pi.getAllTools()) {
		if (BUILTIN_TOOLS.has(tool.name)) continue;
		toolToPlugin.set(tool.name, sourceLabel(tool.sourceInfo));
	}

	const skillToPlugin = new Map<string, string>();
	for (const cmd of pi.getCommands()) {
		if (cmd.source !== "skill") continue;
		// Skill command names look like "skill:<name>"; the skill name is what
		// appears in <skill name="..."> blocks stored in sessions.
		const skillName = cmd.name.startsWith("skill:")
			? cmd.name.slice("skill:".length)
			: cmd.name;
		skillToPlugin.set(skillName, sourceLabel(cmd.sourceInfo));
	}

	return { toolToPlugin, skillToPlugin };
}

function textOfUserContent(
	content: AssistantMessage["content"] | string | unknown,
): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) =>
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				block.type === "text"
					? (block as { text: string }).text
					: "",
			)
			.join("\n");
	}
	return "";
}

function shouldExclude(project: string, excludes: string[]): boolean {
	if (!excludes || excludes.length === 0) return false;
	const p = project.replace(/\\/g, "/").toLowerCase();
	return excludes.some((ex) =>
		p.startsWith(ex.replace(/\\/g, "/").toLowerCase()),
	);
}

/**
 * Scan every session file and build the timeline of attributed turns.
 *
 * `onProgress` receives (loaded, total) for UI feedback. Resolves even if some
 * files fail to parse — bad files are skipped with a console warning.
 */
export async function scanSessions(
	maxSessions: number,
	excludes: string[],
	onProgress?: (loaded: number, total: number) => void,
): Promise<Report> {
	const all = await SessionManager.listAll();
	// Most recent first — most relevant for time-windowed views.
	const sessions = stableSort(
		all,
		(a, b) => b.modified.getTime() - a.modified.getTime(),
	).slice(0, maxSessions);

	const entries: TurnEntry[] = [];
	let processed = 0;

	for (const info of sessions) {
		processed += 1;
		onProgress?.(processed, sessions.length);
		const project = info.cwd || "";

		try {
			collectFromSession(info, project, excludes, entries);
		} catch (err) {
			console.error(`[usage] Failed to read session ${info.path}: ${err}`);
		}
	}

	return {
		computedAt: Date.now(),
		sessionCount: sessions.length,
		turnCount: entries.length,
		entries,
	};
}

/** Open one session file, attribute its assistant turns, append to `out`. */
function collectFromSession(
	info: SessionInfo,
	project: string,
	excludes: string[],
	out: TurnEntry[],
): number {
	if (shouldExclude(project, excludes)) return 0;

	const sm = SessionManager.open(info.path);
	const sessionEntries: SessionEntry[] = sm.getEntries();

	let currentSkill: string | null = null;
	let added = 0;

	// getEntries() returns append order, which is the natural conversation order
	// along the active path. Branch entries appear after their parents, which is
	// fine for attribution: each assistant entry is counted once.
	for (const entry of sessionEntries) {
		if (entry.type !== "message") continue;
		const message = entry.message;

		if (message.role === "user") {
			const text = textOfUserContent(message.content).trimStart();
			const skill = parseSkillBlock(text);
			currentSkill = skill ? skill.name : null;
			continue;
		}

		if (message.role !== "assistant") continue;
		const usage = message.usage;
		if (!usage) continue;

		const tools = message.content
			.filter((b): b is ToolCall => b.type === "toolCall")
			.map((b) => b.name);

		out.push({
			ts: message.timestamp,
			model: message.model || message.provider || "unknown",
			provider: message.provider || "",
			project,
			cost: usage.cost.total,
			usage,
			skill: currentSkill,
			tools,
		});
		added += 1;
	}
	return added;
}

/** Per-plugin contribution detail for the Plugin usage section. */
export interface PluginContribution {
	bucket: Bucket;
	/** Skills of this plugin that were invoked (→ turn buckets). */
	skills: Map<string, Bucket>;
	/** Tools owned by this plugin that were called (→ turn buckets). */
	tools: Map<string, Bucket>;
}

/** A windowed view of the report ready for rendering. */
export interface WindowedReport {
	window: WindowKey;
	total: Bucket;
	fiveHour: Bucket;
	weekly: Bucket;
	byModel: Map<string, Bucket>;
	bySkill: Map<string, Bucket>;
	byPlugin: Map<string, Bucket>;
	/** Per-plugin detail: which skills/tools drove each plugin's usage. */
	pluginDetail: Map<string, PluginContribution>;
	/** Turns that used NO plugin tool/skill (builtin-only, no preceding skill). */
	byCore: Bucket;
	byTool: Map<string, Bucket>;
	byProject: Map<string, Bucket>;
	turnCount: number;
	sessionCount: number;
	earliest: number;
	latest: number;
}

/** Filter the timeline to a window and roll up all breakdowns. */
export function windowize(
	report: Report,
	key: WindowKey,
	maps: AttributionMaps,
): WindowedReport {
	const now = Date.now();
	const horizon = windowMs(key);
	const cutoff = horizon === Number.POSITIVE_INFINITY ? -1 : now - horizon;

	const total = emptyBucket();
	const fiveHour = emptyBucket();
	const weekly = emptyBucket();
	const byModel = new Map<string, Bucket>();
	const bySkill = new Map<string, Bucket>();
	const byPlugin = new Map<string, Bucket>();
	const pluginDetail = new Map<string, PluginContribution>();
	const byCore = emptyBucket();
	const byTool = new Map<string, Bucket>();
	const byProject = new Map<string, Bucket>();

	let earliest = Number.POSITIVE_INFINITY;
	let latest = 0;
	let turnCount = 0;

	for (const turn of report.entries) {
		earliest = Math.min(earliest, turn.ts);
		latest = Math.max(latest, turn.ts);

		// Always-on quota bars use fixed 5h and 7d horizons regardless of window.
		if (turn.ts >= now - 5 * HOUR) addBucket(fiveHour, turn.usage);
		if (turn.ts >= now - 7 * DAY) addBucket(weekly, turn.usage);

		if (cutoff !== -1 && turn.ts < cutoff) continue;
		turnCount += 1;

		addBucket(total, turn.usage);
		bump(byModel, turn.model, turn.usage);

		// Skill attribution (independent characteristic).
		if (turn.skill) bump(bySkill, turn.skill, turn.usage);

		// Plugin attribution: each turn counts ONCE per distinct plugin involved,
		// whether via a tool it owns or a skill it bundles (deduped, no double count).
		// We also record WHICH skills/tools contributed so the Plugin usage section
		// can show per-plugin detail.
		const turnPlugins = new Map<
			string,
			{ skills: Set<string>; tools: Set<string> }
		>();
		const notePlugin = (plugin: string) => {
			let entry = turnPlugins.get(plugin);
			if (!entry) {
				entry = { skills: new Set(), tools: new Set() };
				turnPlugins.set(plugin, entry);
			}
			return entry;
		};
		for (const toolName of turn.tools) {
			bump(byTool, toolName, turn.usage);
			const owner = maps.toolToPlugin.get(toolName);
			if (owner) notePlugin(owner).tools.add(toolName);
		}
		if (turn.skill) {
			const skillOwner = maps.skillToPlugin.get(turn.skill);
			if (skillOwner) notePlugin(skillOwner).skills.add(turn.skill);
		}
		if (turnPlugins.size === 0) {
			// No plugin tool or plugin skill involved → core pi usage.
			addBucket(byCore, turn.usage);
		} else {
			for (const [plugin, contrib] of turnPlugins) {
				bump(byPlugin, plugin, turn.usage);
				let detail = pluginDetail.get(plugin);
				if (!detail) {
					detail = {
						bucket: emptyBucket(),
						skills: new Map(),
						tools: new Map(),
					};
					pluginDetail.set(plugin, detail);
				}
				addBucket(detail.bucket, turn.usage);
				for (const s of contrib.skills) bump(detail.skills, s, turn.usage);
				for (const t of contrib.tools) bump(detail.tools, t, turn.usage);
			}
		}

		bump(byProject, turn.project || "(unknown)", turn.usage);
	}

	return {
		window: key,
		total,
		fiveHour,
		weekly,
		byModel,
		bySkill,
		byPlugin,
		pluginDetail,
		byCore,
		byTool,
		byProject,
		turnCount,
		sessionCount: report.sessionCount,
		earliest: Number.isFinite(earliest) ? earliest : now,
		latest,
	};
}

function bump(map: Map<string, Bucket>, key: string, usage: Usage): void {
	let bucket = map.get(key);
	if (!bucket) {
		bucket = emptyBucket();
		map.set(key, bucket);
	}
	addBucket(bucket, usage);
}

/** Map<K, V> sorted (desc) by a numeric extractor → array of [key, V]. */
export function ranked<V>(
	map: Map<string, V>,
	value: (v: V) => number,
): Array<[string, V]> {
	return [...map.entries()].sort((a, b) => value(b[1]) - value(a[1]));
}

function stableSort<T>(arr: T[], cmp: (a: T, b: T) => number): T[] {
	return arr
		.map((v, i) => [v, i] as const)
		.sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1])
		.map((p) => p[0]);
}
