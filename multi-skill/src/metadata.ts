import { readFileSync } from "node:fs";
import {
	parseFrontmatter as parsePiFrontmatter,
	stripFrontmatter as stripPiFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { EnrichedSkillInfo, LoadMode, SkillInfo, SkillMetadata, SkillOrder } from "./types.ts";

const PROCESS_NAMES = new Set([
	"using-superpowers",
	"brainstorming",
	"systematic-debugging",
	"bmad-master",
	"writing-plans",
	"dispatching-parallel-agents",
	"subagent-driven-development",
	"executing-plans",
]);

const PLANNING_NAMES = new Set([
	"analyst",
	"pm",
	"architect",
	"ux-designer",
	"scrum-master",
]);

function parseFrontmatter(content: string): Record<string, string> {
	const { frontmatter } = parsePiFrontmatter<Record<string, unknown>>(content);
	const fields: Record<string, string> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value === undefined || value === null) continue;
		fields[key] = String(value);
	}
	return fields;
}

export function stripFrontmatter(content: string): string {
	return stripPiFrontmatter(content);
}

function parseListField(value: string | undefined): string[] {
	if (!value) return [];
	const trimmed = value.trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.map(String).filter(Boolean);
			}
		} catch {
			// fall through
		}
	}
	return trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseTokenBudget(value: string | undefined): LoadMode | undefined {
	if (value === "meta" || value === "lazy" || value === "full") return value;
	return undefined;
}

function extractCommands(body: string): string[] {
	const commands: string[] = [];
	const section = body.match(
		/## Available Commands[\s\S]*?(?=\n## |\n# |$)/i,
	);
	if (!section) return commands;

	for (const line of section[0].split("\n")) {
		const match = line.match(/\*\*(\/[\w-]+)/);
		if (match) commands.push(match[1]);
	}
	return commands;
}

function inferType(
	name: string,
	frontmatter: Record<string, string>,
): SkillMetadata["type"] {
	const explicit = frontmatter.type?.toLowerCase();
	if (explicit === "process" || explicit === "rigid" || explicit === "flexible") {
		return explicit;
	}
	if (PROCESS_NAMES.has(name)) return "process";
	if (name.includes("debug") || name.includes("tdd")) return "rigid";
	return "unknown";
}

function priorityScore(meta: SkillMetadata): number {
	if (meta.type === "process") return 0;
	if (PROCESS_NAMES.has(meta.name)) return 1;
	if (PLANNING_NAMES.has(meta.name)) return 2;
	if (meta.module === "core") return 1;
	if (meta.module === "bmm") return 3;
	return 4;
}

export function enrichSkill(skill: SkillInfo): EnrichedSkillInfo {
	let rawContent = "";
	try {
		rawContent = readFileSync(skill.filePath, "utf-8");
	} catch {
		rawContent = "";
	}

	const frontmatter = parseFrontmatter(rawContent);
	const body = stripFrontmatter(rawContent).trim();
	const name = frontmatter.name || skill.name;
	const description =
		skill.description || frontmatter.description || truncateFirstLine(body);

	const metadata: SkillMetadata = {
		name,
		description,
		type: inferType(name, frontmatter),
		module: frontmatter.module || "",
		priority: Number.parseInt(frontmatter.priority || "50", 10) || 50,
		commands: extractCommands(body),
		skillId: frontmatter.skill_id || "",
		version: frontmatter.version || "",
		pairsWith: parseListField(frontmatter.pairs_with),
		conflictsWith: parseListField(frontmatter.conflicts_with),
		tokenBudget: parseTokenBudget(frontmatter.token_budget),
	};

	return { ...skill, name, description, metadata, rawContent, body };
}

function truncateFirstLine(body: string): string {
	const line = body
		.split("\n")
		.map((l) => l.replace(/^>\s*/, "").trim())
		.find((l) => l.length > 0);
	return line?.slice(0, 120) ?? "";
}

export function sortSkills(
	skills: EnrichedSkillInfo[],
	order: SkillOrder = "process-first",
): EnrichedSkillInfo[] {
	if (order === "alpha") {
		return [...skills].sort((a, b) => a.name.localeCompare(b.name));
	}
	if (order === "explicit") return skills;

	return [...skills].sort((a, b) => {
		const pa = priorityScore(a.metadata);
		const pb = priorityScore(b.metadata);
		if (pa !== pb) return pa - pb;
		if (a.metadata.priority !== b.metadata.priority) {
			return a.metadata.priority - b.metadata.priority;
		}
		return a.name.localeCompare(b.name);
	});
}

export function truncateDescription(desc: string, maxLen = 120): string {
	if (!desc) return "";
	const lines = desc
		.split("\n")
		.map((l) => l.replace(/^>\s*/, "").trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) return "";
	let text = lines[0];
	if (lines.length > 1 && text.length < 40) text = `${text} ${lines[1]}`;
	return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}
