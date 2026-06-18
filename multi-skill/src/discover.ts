import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	getAgentDir,
	loadSkills,
	loadSkillsFromDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { truncateDescription } from "./metadata.ts";
import type { SkillInfo } from "./types.ts";

function readSettingsSkillPaths(): string[] {
	try {
		const raw = readFileSync(join(getAgentDir(), "settings.json"), "utf-8");
		const parsed = JSON.parse(raw) as { skills?: string[] };
		return Array.isArray(parsed.skills) ? parsed.skills : [];
	} catch {
		return [];
	}
}

function fromPiCommands(pi: ExtensionAPI): Map<string, SkillInfo> {
	const map = new Map<string, SkillInfo>();
	for (const cmd of pi.getCommands()) {
		if (cmd.source !== "skill") continue;
		const name = cmd.name.startsWith("skill:")
			? cmd.name.slice(6)
			: cmd.name;
		map.set(name, {
			name,
			description: truncateDescription(cmd.description || ""),
			filePath: cmd.sourceInfo.path,
			baseDir: cmd.sourceInfo.baseDir || dirname(cmd.sourceInfo.path),
		});
	}
	return map;
}

/** Claude Code plugin cache — superpowers and other plugin skills not in pi settings. */
function discoverClaudePluginSkills(): SkillInfo[] {
	const cacheRoot = join(homedir(), ".claude", "plugins", "cache");
	if (!existsSync(cacheRoot)) return [];

	const byName = new Map<string, SkillInfo>();
	try {
		for (const pluginEntry of readdirSync(cacheRoot, { withFileTypes: true })) {
			if (!pluginEntry.isDirectory()) continue;
			const pluginRoot = join(cacheRoot, pluginEntry.name);
			for (const versionEntry of readdirSync(pluginRoot, {
				withFileTypes: true,
			})) {
				if (!versionEntry.isDirectory()) continue;
				const skillsDir = join(pluginRoot, versionEntry.name, "skills");
				if (!existsSync(skillsDir)) continue;
				const result = loadSkillsFromDir({
					dir: skillsDir,
					source: "claude-plugin",
				});
				for (const skill of result.skills) {
					byName.set(skill.name, {
						name: skill.name,
						description: truncateDescription(skill.description || ""),
						filePath: skill.filePath,
						baseDir: skill.baseDir,
					});
				}
			}
		}
	} catch {
		// Non-fatal
	}
	return [...byName.values()];
}

function discoverCursorSkills(): SkillInfo[] {
	const dir = join(homedir(), ".cursor", "skills-cursor");
	if (!existsSync(dir)) return [];
	try {
		return loadSkillsFromDir({ dir, source: "cursor" }).skills.map((skill) => ({
			name: skill.name,
			description: truncateDescription(skill.description || ""),
			filePath: skill.filePath,
			baseDir: skill.baseDir,
		}));
	} catch {
		return [];
	}
}

/**
 * Discover skills from every source pi and Claude Code use:
 * getCommands(), settings skill paths, defaults, plugin cache, cursor skills.
 */
export function discoverAllSkills(
	pi: ExtensionAPI,
	cwd: string,
): SkillInfo[] {
	const map = fromPiCommands(pi);

	const loaded = loadSkills({
		cwd,
		agentDir: getAgentDir(),
		skillPaths: readSettingsSkillPaths(),
		includeDefaults: true,
	});
	for (const skill of loaded.skills) {
		if (!map.has(skill.name)) {
			map.set(skill.name, {
				name: skill.name,
				description: truncateDescription(skill.description || ""),
				filePath: skill.filePath,
				baseDir: skill.baseDir,
			});
		}
	}

	for (const skill of [
		...discoverClaudePluginSkills(),
		...discoverCursorSkills(),
	]) {
		if (!map.has(skill.name)) map.set(skill.name, skill);
	}

	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a skill by name when it was requested but missing from the primary index. */
export function resolveSkillByName(
	name: string,
	known: Map<string, SkillInfo>,
): SkillInfo | undefined {
	if (known.has(name)) return known.get(name);

	for (const skill of discoverClaudePluginSkills()) {
		if (skill.name === name) return skill;
	}
	for (const skill of discoverCursorSkills()) {
		if (skill.name === name) return skill;
	}

	const dirs = [
		join(getAgentDir(), "skills"),
		join(cwd, ".pi", "skills"),
	];
	for (const dir of dirs) {
		for (const candidate of [
			join(dir, name, "SKILL.md"),
			join(dir, `${name}.md`),
		]) {
			if (!existsSync(candidate)) continue;
			return {
				name,
				description: "",
				filePath: candidate,
				baseDir: dirname(candidate),
			};
		}
	}
	return undefined;
}
