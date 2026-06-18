import type { SkillBundle, SkillInfo } from "./types.ts";
import { assessBundleAvailability } from "./bundle-status.ts";

const SUGGESTIONS: Array<{ pattern: RegExp; bundle: string; reason: string }> =
	[
		{
			pattern: /fail(ing|ed)?\s+test|test\s+fail/i,
			bundle: "debug",
			reason: "failing tests detected",
		},
		{
			pattern: /\bbug\b|\berror\b|\bcrash\b|\bexception\b/i,
			bundle: "debug",
			reason: "bug/error keywords detected",
		},
		{
			pattern: /\bprd\b|product requirement|tech spec/i,
			bundle: "bmad-planning",
			reason: "planning keywords detected",
		},
		{
			pattern: /\barchitect|\bapi design|\bdatabase schema/i,
			bundle: "bmad-solutioning",
			reason: "architecture keywords detected",
		},
		{
			pattern: /\bimplement|\buser story|\bdev-story|\bfeature\b/i,
			bundle: "bmad-build",
			reason: "implementation keywords detected",
		},
		{
			pattern: /\bnew feature|\bbuild\b|\bcreate\b.+\bcomponent/i,
			bundle: "cc-feature",
			reason: "feature development keywords detected",
		},
	];

export function suggestSkillBundle(
	text: string,
	bundles?: Map<string, SkillBundle>,
	availableSkills?: SkillInfo[],
): {
	bundle: string;
	reason: string;
} | null {
	const sample = text.slice(0, 500);
	for (const entry of SUGGESTIONS) {
		if (!entry.pattern.test(sample)) continue;
		if (bundles && availableSkills) {
			const bundle = bundles.get(entry.bundle);
			if (bundle) {
				const status = assessBundleAvailability(
					entry.bundle,
					bundle,
					availableSkills,
				);
				if (!status.ready) continue;
			}
		}
		return { bundle: entry.bundle, reason: entry.reason };
	}
	return null;
}

export function formatSuggestionHint(
	bundle: string,
	reason: string,
): string {
	return `💡 Suggested: /skills @${bundle} (${reason})`;
}
