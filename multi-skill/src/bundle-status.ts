import type { SkillBundle, SkillInfo } from "./types.ts";

export interface BundleAvailability {
	name: string;
	bundle: SkillBundle;
	available: string[];
	missing: string[];
	coverage: number;
	ready: boolean;
}

const SKILL_INSTALL_HINTS: Record<string, string> = {
	"bmad-master": "BMAD core — clone to ~/.claude/skills/bmad or add to pi settings \"skills\"",
	analyst: "BMAD analyst — part of ~/.claude/skills/bmad/bmm/",
	pm: "BMAD pm — part of ~/.claude/skills/bmad/bmm/",
	architect: "BMAD architect — part of ~/.claude/skills/bmad/bmm/",
	"ux-designer": "BMAD ux-designer — part of ~/.claude/skills/bmad/bmm/",
	developer: "BMAD developer — part of ~/.claude/skills/bmad/bmm/",
	"scrum-master": "BMAD scrum-master — part of ~/.claude/skills/bmad/bmm/",
	"using-superpowers": "Superpowers — Claude Code plugin cache or ~/.pi/agent/skills",
	brainstorming: "Superpowers — Claude Code plugin cache or ~/.pi/agent/skills",
	"writing-plans": "Superpowers — Claude Code plugin cache or ~/.pi/agent/skills",
	"test-driven-development": "Superpowers — Claude Code plugin cache or ~/.pi/agent/skills",
	"requesting-code-review": "Superpowers — Claude Code plugin cache or ~/.pi/agent/skills",
	"systematic-debugging": "Superpowers — Claude Code plugin cache or ~/.pi/agent/skills",
};

export function assessBundleAvailability(
	name: string,
	bundle: SkillBundle,
	availableSkills: SkillInfo[],
): BundleAvailability {
	const availableNames = new Set(availableSkills.map((s) => s.name));
	const available = bundle.skills.filter((s) => availableNames.has(s));
	const missing = bundle.skills.filter((s) => !availableNames.has(s));
	const coverage =
		bundle.skills.length === 0
			? 0
			: Math.round((available.length / bundle.skills.length) * 100);

	return {
		name,
		bundle,
		available,
		missing,
		coverage,
		ready: available.length > 0,
	};
}

export function assessAllBundles(
	bundles: Map<string, SkillBundle>,
	availableSkills: SkillInfo[],
): BundleAvailability[] {
	return [...bundles.entries()]
		.map(([name, bundle]) => assessBundleAvailability(name, bundle, availableSkills))
		.sort((a, b) => b.coverage - a.coverage || a.name.localeCompare(b.name));
}

export function formatBundleCoverage(status: BundleAvailability): string {
	if (status.coverage === 100) {
		return `${status.available.length}/${status.bundle.skills.length} ready`;
	}
	if (status.coverage === 0) {
		return `0/${status.bundle.skills.length} — install required`;
	}
	return `${status.available.length}/${status.bundle.skills.length} (${status.missing.length} missing)`;
}

export function formatBundleHelpLine(status: BundleAvailability): string {
	const coverage = formatBundleCoverage(status);
	const req = status.bundle.requires ? ` · ${status.bundle.requires}` : "";
	return `  • @${status.name} — ${status.bundle.description} [${coverage}]${req}`;
}

export function formatMissingSkillHints(missing: string[]): string {
	const lines = missing.map((name) => {
		const hint = SKILL_INSTALL_HINTS[name];
		return hint ? `  • ${name} — ${hint}` : `  • ${name}`;
	});
	return lines.join("\n");
}

export function formatBundleFailureGuide(
	bundleNames: string[],
	bundles: Map<string, SkillBundle>,
	availableSkills: SkillInfo[],
): string {
	const lines: string[] = [
		"Bundle skills not found on this machine.",
		"",
	];

	for (const bundleName of bundleNames) {
		const bundle = bundles.get(bundleName);
		if (!bundle) continue;
		const status = assessBundleAvailability(bundleName, bundle, availableSkills);
		lines.push(`@${bundleName} — ${status.bundle.description}`);
		if (status.bundle.install) {
			lines.push(`  Install: ${status.bundle.install}`);
		}
		if (status.missing.length > 0) {
			lines.push("  Missing skills:");
			lines.push(formatMissingSkillHints(status.missing));
		}
		lines.push("");
	}

	lines.push(
		"Options without installing presets:",
		"  1. /skills skill1,skill2 — chain skills you already have",
		"  2. Create ~/.pi/agent/skill-bundles.json with your own bundles",
		"  3. /skills-setup — full install guide",
	);

	return lines.join("\n");
}

export function formatSetupReport(
	bundles: Map<string, SkillBundle>,
	availableSkills: SkillInfo[],
): string {
	const statuses = assessAllBundles(bundles, availableSkills);
	const ready = statuses.filter((s) => s.coverage === 100);
	const partial = statuses.filter((s) => s.ready && s.coverage < 100);
	const unavailable = statuses.filter((s) => !s.ready);

	const lines: string[] = [
		"pi-multi-skill bundle setup",
		"",
		`Skills discovered: ${availableSkills.length}`,
		`Bundles ready: ${ready.length}/${statuses.length}`,
		"",
	];

	if (ready.length > 0) {
		lines.push("Ready to use:");
		for (const s of ready) {
			lines.push(`  @${s.name} — ${formatBundleCoverage(s)}`);
		}
		lines.push("");
	}

	if (partial.length > 0) {
		lines.push("Partial (loads available skills, warns about missing):");
		for (const s of partial) {
			lines.push(`  @${s.name} — ${formatBundleCoverage(s)}`);
			lines.push(`    missing: ${s.missing.join(", ")}`);
		}
		lines.push("");
	}

	if (unavailable.length > 0) {
		lines.push("Not available (install required):");
		for (const s of unavailable) {
			lines.push(`  @${s.name} — ${s.bundle.description}`);
			if (s.bundle.install) lines.push(`    ${s.bundle.install}`);
		}
		lines.push("");
	}

	lines.push(
		"Install BMAD (optional):",
		"  git clone https://github.com/bmad-code-org/BMAD-METHOD ~/.claude/skills/bmad",
		'  Add to ~/.pi/agent/settings.json → "skills": ["~/.claude/skills/bmad"]',
		"  /reload",
		"",
		"Install Superpowers (optional):",
		"  Use Claude Code Superpowers plugin, or copy skills to ~/.pi/agent/skills",
		"  pi-multi-skill also discovers ~/.claude/plugins/cache/**/skills/",
		"",
		"Custom bundles (no BMAD/Superpowers needed):",
		"  Copy skill-bundles.example.json → ~/.pi/agent/skill-bundles.json",
		"  List only skills you have installed.",
	);

	return lines.join("\n");
}
