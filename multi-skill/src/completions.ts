import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	assessBundleAvailability,
	formatBundleCoverage,
} from "./bundle-status.ts";
import { expandSkillNames } from "./bundles.ts";
import { enrichSkill } from "./metadata.ts";
import type { SkillBundle, SkillInfo } from "./types.ts";

function resolveSkillNamesForCompletion(
	skillPart: string,
	bundles: Map<string, SkillBundle>,
): string[] {
	const raw = skillPart
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (raw.length === 0) return [];
	return expandSkillNames(raw, bundles).skills;
}

function collectEmbeddedCommands(
	skillNames: string[],
	allSkills: SkillInfo[],
): Map<string, string> {
	const byName = new Map(allSkills.map((s) => [s.name, s]));
	const commands = new Map<string, string>();

	for (const name of skillNames) {
		const skill = byName.get(name);
		if (!skill) continue;
		const enriched = enrichSkill(skill);
		for (const cmd of enriched.metadata.commands) {
			if (!commands.has(cmd)) {
				commands.set(cmd, enriched.name);
			}
		}
	}

	return commands;
}

function completeSkillNames(
	prefix: string,
	allSkills: SkillInfo[],
	bundles: Map<string, SkillBundle>,
): AutocompleteItem[] {
	const parts = prefix.split(",");
	const currentPart = parts[parts.length - 1].trim();
	const alreadySelected = parts
		.slice(0, -1)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const items: AutocompleteItem[] = [];

	if (currentPart.startsWith("@") || currentPart === "") {
		const bundleQuery = currentPart.startsWith("@")
			? currentPart.slice(1)
			: "";
		for (const [name, bundle] of bundles) {
			if (bundleQuery && !name.startsWith(bundleQuery)) continue;
			if (alreadySelected.includes(`@${name}`)) continue;
			const status = assessBundleAvailability(name, bundle, allSkills);
			const prefixValue =
				alreadySelected.length > 0
					? `${parts.slice(0, -1).join(",")},@${name}`
					: `@${name}`;
			const coverage = formatBundleCoverage(status);
			const req =
				status.coverage === 0 && bundle.requires
					? ` · needs ${bundle.requires}`
					: "";
			items.push({
				value: prefixValue,
				label: `@${name}`,
				description: `${bundle.description} (${coverage})${req}`,
			});
		}
	}

	const remaining = allSkills.filter(
		(s) => !alreadySelected.includes(s.name),
	);
	let candidates: SkillInfo[] = [];
	if (currentPart && !currentPart.startsWith("@")) {
		candidates = remaining.filter((s) => s.name.startsWith(currentPart));
	} else if (!currentPart.startsWith("@")) {
		candidates = remaining;
	}

	const needsComma = alreadySelected.length > 0;
	for (const s of candidates) {
		items.push({
			value: needsComma
				? `${parts.slice(0, -1).join(",")},${s.name}`
				: s.name,
			label: alreadySelected.length > 0 ? `  ${s.name}` : s.name,
			description: s.description || undefined,
		});
	}

	return items.sort((a, b) => {
		const aReady = a.description?.includes("0/") ? 1 : 0;
		const bReady = b.description?.includes("0/") ? 1 : 0;
		if (aReady !== bReady) return aReady - bReady;
		return a.label.localeCompare(b.label);
	});
}

function completeEmbeddedCommands(
	skillPart: string,
	commandPrefix: string,
	allSkills: SkillInfo[],
	bundles: Map<string, SkillBundle>,
	pi: ExtensionAPI,
): AutocompleteItem[] {
	const skillNames = resolveSkillNamesForCompletion(skillPart, bundles);
	const fromSkills = collectEmbeddedCommands(skillNames, allSkills);
	const query = commandPrefix.trim();
	const normalizedQuery = query.startsWith("/") ? query : `/${query}`;

	const items: AutocompleteItem[] = [];
	const seen = new Set<string>();

	for (const [cmd, sourceSkill] of fromSkills) {
		if (normalizedQuery && !cmd.startsWith(normalizedQuery)) continue;
		if (seen.has(cmd)) continue;
		seen.add(cmd);
		items.push({
			value: `${skillPart} ${cmd}`,
			label: cmd,
			description: `from ${sourceSkill}`,
		});
	}

	for (const cmd of pi.getCommands()) {
		const slashName = cmd.name.startsWith("skill:")
			? null
			: `/${cmd.name}`;
		if (!slashName) continue;
		if (normalizedQuery && !slashName.startsWith(normalizedQuery)) continue;
		if (seen.has(slashName)) continue;
		seen.add(slashName);
		items.push({
			value: `${skillPart} ${slashName}`,
			label: slashName,
			description: cmd.description || cmd.source,
		});
	}

	return items.sort((a, b) => a.label.localeCompare(b.label));
}

export function getSkillsArgumentCompletions(
	prefix: string,
	allSkills: SkillInfo[],
	bundles: Map<string, SkillBundle>,
	pi: ExtensionAPI,
): AutocompleteItem[] | null {
	const spaceIndex = prefix.indexOf(" ");
	if (spaceIndex === -1) {
		const items = completeSkillNames(prefix, allSkills, bundles);
		return items.length > 0 ? items : null;
	}

	const skillPart = prefix.slice(0, spaceIndex);
	const rest = prefix.slice(spaceIndex + 1);

	// Embedded command phase: "/skills skill /command args"
	if (rest.startsWith("/") || rest.length === 0) {
		const items = completeEmbeddedCommands(
			skillPart,
			rest,
			allSkills,
			bundles,
			pi,
		);
		return items.length > 0 ? items : null;
	}

	return null;
}
