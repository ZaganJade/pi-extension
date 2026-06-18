import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { BuildOptions, EnrichedSkillInfo, LoadMode } from "./types.ts";
import { stripFrontmatter } from "./metadata.ts";
import { buildParallelDispatchBlock } from "./subagents.ts";

const SUBAGENT_STOP = "<SUBAGENT-STOP>";
const SKILL_CHECK_MARKERS = [
	"If you think there is even a 1% chance a skill might apply",
	"Invoke relevant or requested skills BEFORE any response",
];

function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function readSkillFile(skill: EnrichedSkillInfo, cwd: string): string | null {
	try {
		return readFileSync(skill.filePath, "utf-8");
	} catch {
		// fall through
	}

	const dirs = [join(getAgentDir(), "skills"), join(cwd, ".pi", "skills")];
	for (const dir of dirs) {
		for (const candidate of [
			join(dir, skill.name, "SKILL.md"),
			join(dir, `${skill.name}.md`),
		]) {
			try {
				return readFileSync(candidate, "utf-8");
			} catch {
				// continue
			}
		}
	}
	return null;
}

function extractCommandsSection(body: string): string {
	const match = body.match(
		/## Available Commands[\s\S]*?(?=\n## |\n# |$)/i,
	);
	return match ? match[0].trim() : "";
}

function formatMetaBlock(skill: EnrichedSkillInfo): string {
	const commands = skill.metadata.commands.length
		? `\n\nCommands: ${skill.metadata.commands.join(", ")}`
		: "";
	const commandsSection = extractCommandsSection(skill.body);
	const sectionText = commandsSection ? `\n\n${commandsSection}` : "";

	return `<skill name="${skill.name}" location="${skill.filePath}" mode="meta">
${skill.metadata.description}${commands}${sectionText}
</skill>`;
}

function formatLazyBlock(skill: EnrichedSkillInfo, body: string): string {
	const baseDir = dirname(skill.filePath);
	const intro = body
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#"))
		.slice(0, 8)
		.join("\n");

	return `<skill name="${skill.name}" location="${skill.filePath}" mode="lazy">
References are relative to ${baseDir}. Load reference files with \`read\` only when the active workflow step requires them.

${intro}

${extractCommandsSection(body)}
</skill>`;
}

function formatFullBlock(skill: EnrichedSkillInfo, body: string): string {
	const baseDir = dirname(skill.filePath);
	return `<skill name="${skill.name}" location="${skill.filePath}" mode="full">
References are relative to ${baseDir}.

${body}
</skill>`;
}

function dedupeBody(name: string, body: string, seen: Set<string>): string {
	let result = body;

	if (body.includes(SUBAGENT_STOP)) {
		if (seen.has(SUBAGENT_STOP)) {
			result = result.replace(
				new RegExp(`${SUBAGENT_STOP}[\\s\\S]*?${SUBAGENT_STOP}`, "g"),
				"",
			);
		} else {
			seen.add(SUBAGENT_STOP);
		}
	}

	if (name !== "using-superpowers") {
		for (const marker of SKILL_CHECK_MARKERS) {
			if (result.includes(marker) && seen.has(marker)) {
				result = result.replace(
					new RegExp(`## Instruction Priority[\\s\\S]*?(?=\\n## |$)`, "i"),
					"",
				);
			}
			if (result.includes(marker)) seen.add(marker);
		}
	}

	return result.trim();
}

function renderSkillBlock(
	skill: EnrichedSkillInfo,
	cwd: string,
	mode: LoadMode,
	seenDedup: Set<string>,
): string | null {
	const effectiveMode = skill.metadata.tokenBudget ?? mode;
	const raw = readSkillFile(skill, cwd);
	if (!raw) return null;

	const body = dedupeBody(skill.name, stripFrontmatter(raw).trim(), seenDedup);
	switch (effectiveMode) {
		case "meta":
			return formatMetaBlock(skill);
		case "lazy":
			return formatLazyBlock(skill, body);
		default:
			return formatFullBlock(skill, body);
	}
}

export function buildCombinedMessage(
	skills: EnrichedSkillInfo[],
	cwd: string,
	options: BuildOptions,
): { message: string; notFound: string[]; skippedDuplicates: string[] } {
	const expandedBlocks: string[] = [];
	const notFound: string[] = [];
	const seenDedup = new Set<string>();
	const skippedDuplicates: string[] = [];

	for (const skill of skills) {
		const before = seenDedup.size;
		const block = renderSkillBlock(skill, cwd, options.mode, seenDedup);
		if (!block) {
			notFound.push(skill.name);
			continue;
		}
		if (seenDedup.size > before && before > 0) {
			skippedDuplicates.push(`${skill.name} (deduplicated sections)`);
		}
		expandedBlocks.push(block);
	}

	const skillNames = skills.map((s) => s.name).join(", ");
	const bundleAttr =
		options.bundles && options.bundles.length > 0
			? ` bundles="${options.bundles.map((b) => `@${b}`).join(",")}"`
			: "";
	const parts: string[] = [
		`<manually_attached_skills count="${skills.length}"${bundleAttr}>`,
		"The user activated multiple skills. Follow ALL of them before responding.",
		"Priority: process skills → planning → implementation. User instructions override conflicts.",
		`Skills: ${skillNames}`,
		`Load mode: ${options.mode}`,
	];

	if (options.parallel) {
		const tasks =
			options.parallelTasks && options.parallelTasks.length > 0
				? options.parallelTasks
				: options.instructions
					? [options.instructions]
					: [];
		parts.push(
			buildParallelDispatchBlock({
				tasks,
				subagentAvailable: options.subagentAvailable ?? false,
			}),
		);
	}

	parts.push("");
	parts.push(...expandedBlocks);

	if (options.bmadStatusBlock) {
		parts.push("");
		parts.push(options.bmadStatusBlock);
	}

	if (options.embeddedCommand) {
		parts.push("");
		parts.push(
			`<embedded_command>${options.embeddedCommand}</embedded_command>`,
		);
		parts.push(
			"Execute the embedded command workflow as part of fulfilling the user request.",
		);
	}

	if (options.instructions) {
		parts.push("");
		parts.push("<user_query>");
		parts.push(options.instructions);
		parts.push("</user_query>");
	}

	if (notFound.length > 0) {
		parts.push("");
		parts.push(`> ⚠️ Skills not found: ${notFound.join(", ")}`);
	}

	if (options.conflictWarnings?.length) {
		parts.push("");
		parts.push(`> ⚠️ Conflicts: ${options.conflictWarnings.join("; ")}`);
	}

	if (options.skippedDuplicates?.length) {
		parts.push("");
		parts.push(
			`> ℹ️ Deduplicated: ${options.skippedDuplicates.join(", ")}`,
		);
	}

	parts.push("</manually_attached_skills>");

	return {
		message: parts.join("\n"),
		notFound,
		skippedDuplicates,
	};
}

export function resolveAndReadLegacySkill(
	skillName: string,
	filePath: string,
	cwd: string,
): string | null {
	if (existsSync(filePath)) {
		try {
			const content = readFileSync(filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const baseDir = dirname(filePath);
			return `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
		} catch {
			// fall through
		}
	}

	const dirs = [join(getAgentDir(), "skills"), join(cwd, ".pi", "skills")];
	for (const dir of dirs) {
		for (const candidate of [
			join(dir, skillName, "SKILL.md"),
			join(dir, `${skillName}.md`),
		]) {
			try {
				const content = readFileSync(candidate, "utf-8");
				const body = stripFrontmatter(content).trim();
				return `<skill name="${skillName}" location="${candidate}">\nReferences are relative to ${dirname(candidate)}.\n\n${body}\n</skill>`;
			} catch {
				// continue
			}
		}
	}
	return null;
}
