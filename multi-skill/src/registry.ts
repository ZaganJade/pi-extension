import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { enrichSkill } from "./metadata.ts";
import type { SkillInfo } from "./types.ts";

function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

export function rebuildSkillIndex(skills: SkillInfo[]): void {
	const index = {
		updatedAt: new Date().toISOString(),
		count: skills.length,
		skills: skills.map((skill) => {
			const enriched = enrichSkill(skill);
			return {
				name: enriched.name,
				description: enriched.metadata.description,
				type: enriched.metadata.type,
				module: enriched.metadata.module,
				priority: enriched.metadata.priority,
				skillId: enriched.metadata.skillId,
				version: enriched.metadata.version,
				pairsWith: enriched.metadata.pairsWith,
				conflictsWith: enriched.metadata.conflictsWith,
				tokenBudget: enriched.metadata.tokenBudget,
				commands: enriched.metadata.commands,
				location: enriched.filePath,
			};
		}),
	};

	const dir = getAgentDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	try {
		writeFileSync(
			join(dir, "skill-index.json"),
			`${JSON.stringify(index, null, 2)}\n`,
			"utf-8",
		);
	} catch {
		// Non-fatal — index is optional
	}
}
