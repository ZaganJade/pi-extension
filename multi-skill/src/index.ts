import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	bundleOrderHint,
	DEFAULT_BUNDLES,
	expandSkillNames,
	loadBundles,
} from "./bundles.ts";
import {
	assessAllBundles,
	formatBundleFailureGuide,
	formatBundleHelpLine,
	formatMissingSkillHints,
	formatSetupReport,
} from "./bundle-status.ts";
import { bmadAutoHint, resolveBmadAutoSkills } from "./bmad-auto.ts";
import { buildBmadStatusBlock, shouldInjectBmadStatus } from "./bmad-status.ts";
import { buildCombinedMessage } from "./build.ts";
import { getSkillsArgumentCompletions } from "./completions.ts";
import { resolveSkillConflicts } from "./conflicts.ts";
import { discoverAllSkills, resolveSkillByName } from "./discover.ts";
import { enrichSkill, sortSkills } from "./metadata.ts";
import { parseSkillsArgs } from "./parse-args.ts";
import { rebuildSkillIndex } from "./registry.ts";
import { formatStatsReport, recordActivation, replayLastArgs, formatLastActivationHint } from "./stats.ts";
import { formatSuggestionHint, suggestSkillBundle } from "./suggestions.ts";
import { hasSubagentTool } from "./subagents.ts";
import type { EnrichedSkillInfo, LoadMode, SkillBundle, SkillInfo, SkillOrder } from "./types.ts";

/**
 * Multi-Skill Loader Extension for Pi
 */

function resolveSelectedSkills(
	names: string[],
	available: SkillInfo[],
	order: SkillOrder = "process-first",
): EnrichedSkillInfo[] {
	const nameToSkill = new Map(available.map((s) => [s.name, s]));
	const selected: SkillInfo[] = [];

	for (const name of names) {
		const skill =
			nameToSkill.get(name) ?? resolveSkillByName(name, nameToSkill);
		if (skill) {
			nameToSkill.set(skill.name, skill);
			selected.push(skill);
		}
	}

	return sortSkills(selected.map(enrichSkill), order);
}

function resolveSelectedSkillsWithConflicts(
	names: string[],
	available: SkillInfo[],
	order: SkillOrder = "process-first",
): { skills: EnrichedSkillInfo[]; warnings: string[] } {
	const sorted = resolveSelectedSkills(names, available, order);
	const resolved = resolveSkillConflicts(sorted);
	return { skills: resolved.skills, warnings: resolved.warnings };
}

function formatHelp(available: SkillInfo[], bundles: Map<string, SkillBundle>): string {
	const skillLines = available
		.map((s) =>
			s.description ? `  • ${s.name} — ${s.description}` : `  • ${s.name}`,
		)
		.join("\n");

	const bundleStatuses = assessAllBundles(bundles, available);
	const bundleLines = bundleStatuses.map(formatBundleHelpLine).join("\n");
	const readyCount = bundleStatuses.filter((s) => s.ready).length;

	return (
		`Usage:\n` +
		`  /skills skill1,skill2 [instructions]\n` +
		`  /skills @bundle [--meta|--lazy|--full] [instructions]\n` +
		`  /skills bmad-master /workflow-status\n` +
		`  /skills @bmad-planning --auto\n` +
		`  /skills @cc-feature --parallel Task A | Task B | Task C\n\n` +
		`Flags: --meta · --lazy · --full · --auto · --parallel\n` +
		`Setup: /skills-setup · Stats: /skills-stats · Repeat: /skills-last\n\n` +
		`Bundles (${readyCount}/${bundles.size} usable on this machine):\n${bundleLines}\n\n` +
		`Skills (${available.length}):\n${skillLines}\n\n` +
		`No BMAD/Superpowers? Use /skills-setup or create ~/.pi/agent/skill-bundles.json`
	);
}

function processAndSend(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	rawArgs: string,
	getSkills: (cwd: string) => SkillInfo[],
): void {
	const bundles = loadBundles(ctx.cwd);
	const parsed = parseSkillsArgs(rawArgs);
	let skillNames = [...parsed.skillNames];
	let mode: LoadMode = parsed.mode;

	if (parsed.auto) {
		skillNames = resolveBmadAutoSkills(ctx.cwd);
		const hint = bmadAutoHint(ctx.cwd);
		if (hint) ctx.ui.notify(hint, "info");
	} else {
		const expanded = expandSkillNames(skillNames, bundles);
		skillNames = expanded.skills;
		if (mode === "full" && expanded.modeHint) mode = expanded.modeHint;
	}

	if (skillNames.length === 0) {
		ctx.ui.notify("No skill names provided.", "error");
		return;
	}

	const bundleNames = parsed.skillNames
		.filter((n) => n.startsWith("@"))
		.map((n) => n.slice(1));

	const allSkills = getSkills(ctx.cwd);
	const order =
		bundleOrderHint(parsed.skillNames, bundles) ?? "process-first";
	const { skills: selected, warnings: conflictWarnings } =
		resolveSelectedSkillsWithConflicts(skillNames, allSkills, order);

	if (selected.length === 0) {
		if (bundleNames.length > 0) {
			ctx.ui.notify(
				formatBundleFailureGuide(bundleNames, bundles, allSkills),
				"error",
			);
		} else {
			ctx.ui.notify(
				`No skills found for: ${skillNames.join(", ")}\n` +
					`Install skills under ~/.pi/agent/skills, ~/.claude/skills, or pi settings "skills" paths.\n` +
					`Run /skills-setup for bundle install guide.`,
				"error",
			);
		}
		return;
	}

	const missing = skillNames.filter(
		(name) => !selected.some((s) => s.name === name),
	);
	if (missing.length > 0) {
		const hint =
			bundleNames.length > 0
				? `Skills not found (partial bundle load):\n${formatMissingSkillHints(missing)}\nRun /skills-setup for install guide.`
				: `Skills not found: ${missing.join(", ")}`;
		ctx.ui.notify(hint, "info");
	}
	if (conflictWarnings.length > 0) {
		ctx.ui.notify(conflictWarnings.join("\n"), "info");
	}

	if (parsed.embeddedCommand) {
		ctx.ui.notify(
			`Loading ${selected.map((s) => s.name).join(", ")} → ${parsed.embeddedCommand}`,
			"info",
		);
	}

	const subagentAvailable = hasSubagentTool(pi);
	if (parsed.parallel && !subagentAvailable) {
		ctx.ui.notify(
			"Parallel mode: pi-subagents not detected — tasks will run sequentially. Install: pi install npm:pi-subagents",
			"info",
		);
	}

	const bmadStatusBlock = shouldInjectBmadStatus({
		embeddedCommand: parsed.embeddedCommand,
		auto: parsed.auto,
	})
		? buildBmadStatusBlock(ctx.cwd)
		: null;

	const { message } = buildCombinedMessage(selected, ctx.cwd, {
		mode,
		bundles: bundleNames,
		bmadStatusBlock: bmadStatusBlock ?? undefined,
		parallel: parsed.parallel,
		parallelTasks: parsed.parallelTasks,
		subagentAvailable,
		embeddedCommand: parsed.embeddedCommand,
		instructions: parsed.instructions || undefined,
		conflictWarnings,
	});

	if (!message.includes("<skill ")) {
		ctx.ui.notify(`Could not read skill files for: ${skillNames.join(", ")}`, "error");
		return;
	}

	recordActivation({
		mode,
		skillNames: selected.map((s) => s.name),
		bundles: bundleNames,
		parallel: parsed.parallel,
		skillCount: selected.length,
		rawArgs,
	});

	pi.sendUserMessage(message);
}

export default function (pi: ExtensionAPI) {
	let cachedSkills: SkillInfo[] | null = null;

	function getSkills(cwd: string): SkillInfo[] {
		if (!cachedSkills) {
			cachedSkills = discoverAllSkills(pi, cwd);
		}
		return cachedSkills;
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			cachedSkills = null;
			const cwd = ctx?.cwd ?? process.cwd();
			rebuildSkillIndex(getSkills(cwd));
		} catch (err) {
			console.error("[pi-multi-skill] session_start:", err);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		try {
			const sm = ctx?.sessionManager;
			if (!sm) return;

			for (const entry of [...sm.getBranch()].reverse()) {
				if (entry.type !== "message") continue;
				if (entry.message.role !== "user") continue;
				const content = entry.message.content;
				const text = typeof content === "string" ? content : "";
				if (
					text.includes("<manually_attached_skills") ||
					text.includes("<skill ")
				) {
					return;
				}
				const suggestion = suggestSkillBundle(
					text,
					loadBundles(ctx.cwd),
					getSkills(ctx.cwd),
				);
				if (suggestion) {
					ctx.ui.notify(
						formatSuggestionHint(suggestion.bundle, suggestion.reason),
						"info",
					);
				}
				return;
			}
		} catch (err) {
			console.error("[pi-multi-skill] turn_end:", err);
		}
	});

	pi.registerCommand("skills", {
		description:
			"Load multiple skills — /skills @bundle,skill1,skill2 [--meta|--lazy] [instructions]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
			getSkillsArgumentCompletions(
				prefix,
				getSkills(process.cwd()),
				loadBundles(process.cwd()),
				pi,
			),
		handler: async (args, ctx) => {
			const available = getSkills(ctx.cwd);
			const bundles = loadBundles(ctx.cwd);

			if (!args || args.trim().length === 0) {
				ctx.ui.notify(formatHelp(available, bundles), "info");
				return;
			}

			processAndSend(pi, ctx, args, getSkills);
		},
	});

	pi.registerCommand("skills-stats", {
		description: "Show multi-skill activation statistics",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStatsReport(), "info");
		},
	});

	pi.registerCommand("skills-setup", {
		description: "Bundle prerequisites and install guide (BMAD, Superpowers, custom bundles)",
		handler: async (_args, ctx) => {
			const available = getSkills(ctx.cwd);
			const bundles = loadBundles(ctx.cwd);
			ctx.ui.notify(formatSetupReport(bundles, available), "info");
		},
	});

	pi.registerCommand("skills-last", {
		description: "Repeat the last /skills activation (optional: --meta|--lazy|--full|--parallel)",
		handler: async (args, ctx) => {
			const replay = replayLastArgs(args?.trim() ?? "");
			if (!replay) {
				ctx.ui.notify(
					"No recent /skills activation to replay.\nRun /skills first, then /skills-last.",
					"error",
				);
				return;
			}
			const hint = formatLastActivationHint();
			if (hint) ctx.ui.notify(`Repeating: ${hint}`, "info");
			processAndSend(pi, ctx, replay, getSkills);
		},
	});

	pi.on("input", async (event, ctx) => {
		const text = event.text.trim();
		if (!text.startsWith("/skills:") && !text.startsWith("/skill:")) {
			return { action: "continue" };
		}
		if (text.startsWith("/skill:") && !text.slice(7).includes("+")) {
			return { action: "continue" };
		}

		const colonIndex = text.indexOf(":");
		const spaceIndex = text.indexOf(" ", colonIndex);
		const skillListRaw =
			spaceIndex === -1
				? text.slice(colonIndex + 1)
				: text.slice(colonIndex + 1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
		const separator = text.startsWith("/skills:") ? "," : "+";
		const skillNames = skillListRaw
			.split(separator)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);

		if (skillNames.length === 0) return { action: "continue" };

		const available = getSkills(ctx.cwd);
		const { skills: selected } = resolveSelectedSkillsWithConflicts(
			skillNames,
			available,
		);

		if (selected.length === 0) return { action: "continue" };

		const { message } = buildCombinedMessage(selected, ctx.cwd, {
			mode: "full",
			parallel: false,
			instructions: args || undefined,
		});

		if (!message.includes("<skill ")) return { action: "continue" };

		return { action: "transform", text: message };
	});
}

export { DEFAULT_BUNDLES };
