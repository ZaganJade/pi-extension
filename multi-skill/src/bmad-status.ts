import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bmadAutoHint, resolveBmadAutoSkills } from "./bmad-auto.ts";

const STATUS_COMMANDS = new Set([
	"/workflow-status",
	"/status",
	"/workflow-init",
	"/init",
]);

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
		if (match) return match[1].trim();
	}
	return null;
}

function projectMeta(cwd: string): {
	level: number;
	name: string | null;
	type: string | null;
} {
	const content = readText(join(cwd, "bmad", "config.yaml"));
	if (!content) return { level: 1, name: null, type: null };
	const level = content.match(/project_level:\s*(\d)/i);
	const name = content.match(/project_name:\s*["']?([^"'\n]+)/i);
	const type = content.match(/project_type:\s*["']?([^"'\n]+)/i);
	return {
		level: level ? Number.parseInt(level[1], 10) : 1,
		name: name?.[1]?.trim() ?? null,
		type: type?.[1]?.trim() ?? null,
	};
}

const WORKFLOW_KEYS = [
	"product-brief",
	"brainstorm",
	"research",
	"prd",
	"tech-spec",
	"architecture",
	"ux-design",
	"sprint-planning",
	"dev-story",
	"create-story",
];

export function shouldInjectBmadStatus(options: {
	embeddedCommand?: string;
	auto?: boolean;
}): boolean {
	if (options.auto) return true;
	if (!options.embeddedCommand) return false;
	const cmd = options.embeddedCommand.split(/\s+/)[0] ?? "";
	return STATUS_COMMANDS.has(cmd);
}

export function buildBmadStatusBlock(cwd: string): string | null {
	const statusPath = join(cwd, "docs", "bmm-workflow-status.yaml");
	const configPath = join(cwd, "bmad", "config.yaml");
	const statusExists = existsSync(statusPath);
	const configExists = existsSync(configPath);

	if (!statusExists && !configExists) return null;

	const hint = bmadAutoHint(cwd);
	const phaseMatch = hint?.match(/phase:\s*(\w+)/);
	const phase = phaseMatch?.[1] ?? "unknown";
	const project = projectMeta(cwd);
	const recommendedSkills = resolveBmadAutoSkills(cwd);

	const lines: string[] = [
		`<bmad_status phase="${phase}" project_level="${project.level}" status_file="${statusExists ? "docs/bmm-workflow-status.yaml" : "missing"}">`,
	];

	if (project.name) lines.push(`Project: ${project.name}`);
	if (project.type) lines.push(`Type: ${project.type}`);
	lines.push(`Detected phase: ${phase}`);
	lines.push(`Recommended skills for this phase: ${recommendedSkills.join(", ")}`);

	if (statusExists) {
		const content = readText(statusPath) ?? "";
		const incomplete: string[] = [];
		const complete: string[] = [];
		for (const key of WORKFLOW_KEYS) {
			const status = workflowStatus(content, key);
			if (!status) continue;
			if (/complete|done|finished/i.test(status)) {
				complete.push(`${key}: ${status}`);
			} else {
				incomplete.push(`${key}: ${status}`);
			}
		}
		if (incomplete.length > 0) {
			lines.push("", "Incomplete / in-progress workflows:");
			for (const item of incomplete.slice(0, 8)) lines.push(`  • ${item}`);
		}
		if (complete.length > 0) {
			lines.push("", "Completed workflows:");
			for (const item of complete.slice(0, 5)) lines.push(`  • ${item}`);
		}
	} else {
		lines.push("", "BMAD not initialized in this project.");
		lines.push("Run /workflow-init or /skills bmad-master /workflow-init to set up.");
	}

	lines.push("", "Use this context when executing the embedded BMAD command.");
	lines.push("</bmad_status>");

	return lines.join("\n");
}
