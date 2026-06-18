import type { LoadMode, ParsedSkillsArgs } from "./types.ts";

const FLAG_MODES: Record<string, LoadMode> = {
	"--meta": "meta",
	"--full": "full",
	"--lazy": "lazy",
};

export function parseSkillsArgs(raw: string): ParsedSkillsArgs {
	let text = raw.trim();
	let mode: LoadMode = "full";
	let auto = false;
	let parallel = false;

	for (const [flag, loadMode] of Object.entries(FLAG_MODES)) {
		if (text.includes(flag)) {
			mode = loadMode;
			text = text.replace(new RegExp(`\\s*${flag}\\b`, "g"), " ").trim();
		}
	}

	if (/\s--auto\b/.test(text)) {
		auto = true;
		text = text.replace(/\s*--auto\b/g, " ").trim();
	}

	if (/\s--parallel\b/.test(text)) {
		parallel = true;
		text = text.replace(/\s*--parallel\b/g, " ").trim();
	}

	const tokens = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!tokens) {
		return {
			skillNames: [],
			mode,
			auto,
			parallel,
			parallelTasks: [],
			instructions: "",
		};
	}

	const skillNames = tokens[1]
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	let instructions = tokens[2]?.trim() ?? "";
	let embeddedCommand: string | undefined;
	let parallelTasks: string[] = [];

	if (parallel && instructions.includes("|")) {
		parallelTasks = instructions
			.split("|")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		instructions = "";
	} else if (parallel && instructions) {
		parallelTasks = [instructions];
	}

	const cmdMatch = instructions.match(
		/^(\/[\w-]+(?:\s+[^\n|]+)?)(?:\s+([\s\S]*))?$/,
	);
	if (cmdMatch && !parallel) {
		embeddedCommand = cmdMatch[1].trim();
		instructions = cmdMatch[2]?.trim() ?? "";
	}

	return {
		skillNames,
		mode,
		auto,
		parallel,
		parallelTasks,
		embeddedCommand,
		instructions,
	};
}
