import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PHASE_SKILLS: Record<string, string[]> = {
	analysis: ["bmad-master", "analyst"],
	planning: ["bmad-master", "analyst", "pm"],
	solutioning: ["bmad-master", "architect", "ux-designer"],
	implementation: ["bmad-master", "developer", "scrum-master"],
};

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function workflowStatus(content: string, key: string): string | null {
	const patterns = [
		new RegExp(`${key}:\\s*\\n[\\s\\S]*?status:\\s*([\\w-]+)`, "i"),
		new RegExp(`${key}:[\\s\\S]*?status:\\s*([\\w\\s-]+)`, "i"),
	];
	for (const re of patterns) {
		const match = content.match(re);
		if (match) return match[1].trim().toLowerCase().replace(/\s+/g, "-");
	}
	return null;
}

function isIncomplete(status: string | null): boolean {
	if (!status) return true;
	return /not-started|not_started|pending|required|in-progress|in_progress|started/.test(
		status,
	);
}

function detectPhase(content: string): keyof typeof PHASE_SKILLS {
	const checks: Array<[string, keyof typeof PHASE_SKILLS]> = [
		["product-brief", "analysis"],
		["brainstorm", "analysis"],
		["research", "analysis"],
		["prd", "planning"],
		["tech-spec", "planning"],
		["tech_spec", "planning"],
		["architecture", "solutioning"],
		["ux-design", "solutioning"],
		["sprint-planning", "implementation"],
		["dev-story", "implementation"],
		["create-story", "implementation"],
	];

	for (const [key, phase] of checks) {
		if (isIncomplete(workflowStatus(content, key))) return phase;
	}

	if (/implementation|phase:\s*4/i.test(content)) return "implementation";
	if (/solutioning|phase:\s*3/i.test(content)) return "solutioning";
	if (/planning|phase:\s*2/i.test(content)) return "planning";
	return "analysis";
}

function projectLevel(cwd: string): number {
	const configPath = join(cwd, "bmad", "config.yaml");
	const content = readText(configPath);
	if (!content) return 1;
	const match = content.match(/project_level:\s*(\d)/i);
	return match ? Number.parseInt(match[1], 10) : 1;
}

export function resolveBmadAutoSkills(cwd: string): string[] {
	const statusPath = join(cwd, "docs", "bmm-workflow-status.yaml");
	const content = readText(statusPath);

	if (!content) {
		const level = projectLevel(cwd);
		if (level <= 1) return ["bmad-master", "pm"];
		return ["bmad-master", "analyst"];
	}

	const phase = detectPhase(content);
	const skills = [...(PHASE_SKILLS[phase] ?? ["bmad-master"])];

	const level = projectLevel(cwd);
	if (level <= 1 && phase === "planning" && !skills.includes("pm")) {
		skills.push("pm");
	}

	return [...new Set(skills)];
}

export function bmadAutoHint(cwd: string): string | null {
	const statusPath = join(cwd, "docs", "bmm-workflow-status.yaml");
	if (!existsSync(statusPath)) {
		return "BMAD status not found — loaded bmad-master with planning defaults";
	}
	const phase = detectPhase(readText(statusPath) ?? "");
	return `BMAD --auto detected phase: ${phase}`;
}
