import type { EnrichedSkillInfo } from "./types.ts";

/** Drop lower-priority skills that conflict with an earlier skill in the sorted list. */
export function resolveSkillConflicts(
	skills: EnrichedSkillInfo[],
): { skills: EnrichedSkillInfo[]; warnings: string[] } {
	const kept: EnrichedSkillInfo[] = [];
	const warnings: string[] = [];
	const keptNames = new Set<string>();

	for (const skill of skills) {
		const conflictsWithKept = skill.metadata.conflictsWith.filter((name) =>
			keptNames.has(name),
		);
		if (conflictsWithKept.length > 0) {
			warnings.push(
				`Skipped ${skill.name} (conflicts with ${conflictsWithKept.join(", ")})`,
			);
			continue;
		}
		kept.push(skill);
		keptNames.add(skill.name);
	}

	return { skills: kept, warnings };
}
