import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/**
 * Multi-Skill Loader Extension for Pi
 *
 * Enables loading multiple skills at once via the /skills command.
 * Appears in the slash autocomplete menu alongside built-in commands,
 * with full skill descriptions shown just like /skill: commands.
 *
 * Uses pi.getCommands() to discover ALL skills from every source:
 * user-level, project-level, npm packages, git packages, etc.
 *
 * Usage:
 *   /skills frontend-design,motion-design Create an animated landing page
 *   /skills                              → shows help + available skills
 *
 * Also handles legacy formats via the input event:
 *   /skills:frontend-design,motion-design [args]   (colon-separated)
 *   /skill:frontend-design+motion-design [args]    (plus-separated)
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Normalize CRLF → LF then strip YAML frontmatter, return body. */
function stripFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	const match = normalized.match(/^---\n([\s\S]*?\n)?---\n?/);
	return match ? normalized.slice(match[0].length) : normalized;
}

/** Truncate a description to a single readable line for autocomplete display. */
function truncateDescription(desc: string, maxLen = 120): string {
	if (!desc) return "";

	// Take first non-empty line
	const lines = desc
		.split("\n")
		.map((l) => l.replace(/^>\s*/, "").trim())
		.filter((l) => l.length > 0);

	if (lines.length === 0) return "";

	let text = lines[0];
	if (lines.length > 1 && text.length < 40) {
		text = `${text} ${lines[1]}`;
	}

	if (text.length > maxLen) {
		text = `${text.slice(0, maxLen - 1)}…`;
	}

	return text;
}

function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

/**
 * Discover ALL available skills via pi.getCommands().
 * This covers user-level, project-level, and package-installed skills.
 */
function discoverSkillsFromPi(pi: ExtensionAPI): SkillInfo[] {
	const commands = pi.getCommands();
	const skills: SkillInfo[] = [];

	for (const cmd of commands) {
		if (cmd.source !== "skill") continue;

		// Command name is like "skill:name" → extract the skill name
		const skillName = cmd.name.startsWith("skill:")
			? cmd.name.slice(6)
			: cmd.name;

		const filePath = cmd.sourceInfo.path;
		const baseDir = cmd.sourceInfo.baseDir || dirname(filePath);

		skills.push({
			name: skillName,
			description: truncateDescription(cmd.description || ""),
			filePath,
			baseDir,
		});
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fallback: scan filesystem for skills not yet discovered via pi.getCommands().
 * Used to catch any edge cases.
 */
function discoverSkillsFromFilesystem(
	cwd: string,
	knownNames: Set<string>,
): SkillInfo[] {
	const skills: SkillInfo[] = [];
	const dirs = [
		join(getAgentDir(), "skills"),
		join(cwd, ".pi", "skills"),
	].filter((d) => existsSync(d));

	for (const dir of dirs) {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const skillFile = join(dir, entry.name, "SKILL.md");
					if (existsSync(skillFile) && !knownNames.has(entry.name)) {
						skills.push({
							name: entry.name,
							description: "",
							filePath: skillFile,
							baseDir: join(dir, entry.name),
						});
						knownNames.add(entry.name);
					}
				} else if (entry.isFile() && entry.name.endsWith(".md")) {
					const name = entry.name.replace(/\.md$/, "");
					if (!knownNames.has(name)) {
						const skillFile = join(dir, entry.name);
						skills.push({
							name,
							description: "",
							filePath: skillFile,
							baseDir: dir,
						});
						knownNames.add(name);
					}
				}
			}
		} catch {
			// Skip unreadable directories
		}
	}

	return skills;
}

function resolveAndReadSkill(skillName: string, cwd: string): string | null {
	// Try all possible skill locations
	const dirs = [join(getAgentDir(), "skills"), join(cwd, ".pi", "skills")];

	for (const dir of dirs) {
		// Directory-based: <dir>/<name>/SKILL.md
		const skillFile = join(dir, skillName, "SKILL.md");
		try {
			const content = readFileSync(skillFile, "utf-8");
			const body = stripFrontmatter(content).trim();
			return `<skill name="${skillName}" location="${skillFile}">\nReferences are relative to ${dirname(skillFile)}.\n\n${body}\n</skill>`;
		} catch {
			// not found
		}

		// File-based: <dir>/<name>.md
		const mdFile = join(dir, `${skillName}.md`);
		try {
			const content = readFileSync(mdFile, "utf-8");
			const body = stripFrontmatter(content).trim();
			return `<skill name="${skillName}" location="${mdFile}">\nReferences are relative to ${dirname(mdFile)}.\n\n${body}\n</skill>`;
		} catch {
			// not found
		}
	}

	return null;
}

/**
 * Read a skill file by its absolute path (for package-installed skills
 * that live outside ~/.pi/agent/skills/).
 */
function resolveAndReadSkillByPath(
	skillName: string,
	filePath: string,
): string | null {
	try {
		const content = readFileSync(filePath, "utf-8");
		const body = stripFrontmatter(content).trim();
		const baseDir = dirname(filePath);
		return `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
	} catch {
		return null;
	}
}

/** Build the combined skill block text from a list of skill infos. */
function buildCombinedSkills(
	selectedSkills: SkillInfo[],
	cwd: string,
	instructions?: string,
): string {
	const expandedBlocks: string[] = [];
	const notFound: string[] = [];

	for (const skill of selectedSkills) {
		// Try reading by the known filePath first (works for package skills)
		let content = resolveAndReadSkillByPath(skill.name, skill.filePath);

		// Fallback to filesystem scan for user/project skills
		if (!content) {
			content = resolveAndReadSkill(skill.name, cwd);
		}

		if (content) expandedBlocks.push(content);
		else notFound.push(skill.name);
	}

	let combined = expandedBlocks.join("\n\n");

	if (notFound.length > 0) {
		combined += `\n\n> ⚠️ Skills not found: ${notFound.join(", ")}`;
	}

	if (instructions) {
		combined += `\n\n${instructions}`;
	}

	return combined;
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Cache skills list for the session (refreshed on reload)
	let cachedSkills: SkillInfo[] | null = null;

	function getSkills(cwd?: string): SkillInfo[] {
		if (!cachedSkills) {
			// Primary: use pi.getCommands() which covers ALL sources
			const piSkills = discoverSkillsFromPi(pi);
			const knownNames = new Set(piSkills.map((s) => s.name));

			// Secondary: filesystem fallback for anything missed
			const fsSkills = cwd ? discoverSkillsFromFilesystem(cwd, knownNames) : [];

			cachedSkills = [...piSkills, ...fsSkills].sort((a, b) =>
				a.name.localeCompare(b.name),
			);
		}
		return cachedSkills;
	}

	// Clear cache on session start (skills might have changed)
	pi.on("session_start", async () => {
		cachedSkills = null;
	});

	// ========================================================================
	// /skills command — registered as an extension command so it appears in
	// the slash autocomplete menu when the user types "/".
	// ========================================================================
	pi.registerCommand("skills", {
		description:
			"Load multiple skills at once. Usage: /skills skill1,skill2 [instructions]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const allSkills = getSkills();
			if (allSkills.length === 0) return null;

			// Parse comma-separated skills already typed
			// e.g. prefix = "frontend-design,mot" → already = ["frontend-design"], current = "mot"
			const parts = prefix.split(",");
			const currentPart = parts[parts.length - 1].trim();
			const alreadySelected = parts
				.slice(0, -1)
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			// Filter out already selected skills
			const remaining = allSkills.filter(
				(s) => !alreadySelected.includes(s.name),
			);

			let candidates = remaining;
			if (currentPart) {
				candidates = remaining.filter((s) => s.name.startsWith(currentPart));
			}

			if (candidates.length === 0) return null;

			// If user has already typed some skills, show completion with comma prefix
			// so selecting appends properly
			const needsComma = alreadySelected.length > 0;
			return candidates.map((s) => ({
				value: needsComma
					? `${parts.slice(0, -1).join(",")},${s.name}`
					: s.name,
				label: alreadySelected.length > 0 ? `  ${s.name}` : s.name,
				description: s.description || undefined,
			}));
		},
		handler: async (args, ctx) => {
			const available = getSkills(ctx.cwd);

			if (!args || args.trim().length === 0) {
				// No args → show help with available skills list + descriptions
				const skillLines = available
					.map((s) =>
						s.description
							? `  • ${s.name} — ${s.description}`
							: `  • ${s.name}`,
					)
					.join("\n");

				ctx.ui.notify(
					`Usage: /skills skill1,skill2,... [additional instructions]\n` +
						`Example: /skills frontend-design,motion-design Create an animated page\n\n` +
						`Available skills (${available.length}):\n${skillLines}`,
					"info",
				);
				return;
			}

			// Parse: first token is comma-separated skill names, rest is instructions
			const tokens = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
			if (!tokens) {
				ctx.ui.notify(
					"Invalid format. Usage: /skills skill1,skill2 [instructions]",
					"error",
				);
				return;
			}

			const skillNames = tokens[1]
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
			const instructions = tokens[2]?.trim() || "";

			if (skillNames.length === 0) {
				ctx.ui.notify("No skill names provided.", "error");
				return;
			}

			// Resolve skill infos from names
			const nameToSkill = new Map(available.map((s) => [s.name, s]));
			const selectedSkills = skillNames
				.map((name) => nameToSkill.get(name))
				.filter((s): s is SkillInfo => s !== undefined);

			const combined = buildCombinedSkills(
				selectedSkills.length > 0 ? selectedSkills : [],
				ctx.cwd,
				instructions || undefined,
			);

			// Check if any skills were actually loaded
			if (!combined.includes("<skill ")) {
				ctx.ui.notify(`No skills found for: ${skillNames.join(", ")}`, "error");
				return;
			}

			// Send the combined skill content as a user message to trigger agent processing
			pi.sendUserMessage(combined);
		},
	});

	// ========================================================================
	// Input event — handles legacy formats that use colons/plus signs.
	// These formats bypass the command system, so we intercept via input.
	//
	// Supported:
	//   /skills:name1,name2,... [args]   (colon + comma)
	//   /skill:name1+name2+... [args]   (colon + plus)
	// ========================================================================
	pi.on("input", async (event, _ctx) => {
		const text = event.text.trim();

		// Only handle /skills:... or /skill:...+... formats
		// /skills ... (space) is handled by the registered command above
		if (!text.startsWith("/skills:") && !text.startsWith("/skill:"))
			return { action: "continue" };

		// For /skill:... with no plus sign, let pi's built-in handler deal with it
		if (text.startsWith("/skill:") && !text.slice(7).includes("+")) {
			return { action: "continue" };
		}

		// Parse the skill list
		const colonIndex = text.indexOf(":");
		const spaceIndex = text.indexOf(" ", colonIndex);
		const skillListRaw =
			spaceIndex === -1
				? text.slice(colonIndex + 1)
				: text.slice(colonIndex + 1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		// Determine separator: comma for /skills:, plus for /skill:
		const separator = text.startsWith("/skills:") ? "," : "+";
		const skillNames = skillListRaw
			.split(separator)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);

		if (skillNames.length === 0) return { action: "continue" };

		// Resolve skills from the full skill list
		const available = getSkills(_ctx.cwd);
		const nameToSkill = new Map(available.map((s) => [s.name, s]));
		const selectedSkills = skillNames
			.map((name) => nameToSkill.get(name))
			.filter((s): s is SkillInfo => s !== undefined);

		const combined = buildCombinedSkills(
			selectedSkills.length > 0 ? selectedSkills : [],
			_ctx.cwd,
			args || undefined,
		);

		if (!combined.includes("<skill ")) return { action: "continue" };

		return { action: "transform", text: combined };
	});
}
