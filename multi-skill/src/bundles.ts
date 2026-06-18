import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillBundle } from "./types.ts";
import { parseYamlBundles } from "./yaml-bundles.ts";

export const DEFAULT_BUNDLES: Record<string, SkillBundle> = {
	"bmad-planning": {
		description: "BMAD Phase 1-2 — analysis & planning",
		skills: ["bmad-master", "analyst", "pm"],
		order: "process-first",
		default_mode: "meta",
		requires: "BMAD Method",
		install:
			"git clone BMAD-METHOD to ~/.claude/skills/bmad, add path in pi settings \"skills\"",
	},
	"bmad-solutioning": {
		description: "BMAD Phase 3 — architecture & design",
		skills: ["bmad-master", "architect", "ux-designer"],
		order: "process-first",
		default_mode: "meta",
		requires: "BMAD Method",
		install:
			"git clone BMAD-METHOD to ~/.claude/skills/bmad, add path in pi settings \"skills\"",
	},
	"bmad-build": {
		description: "BMAD Phase 4 — story implementation",
		skills: ["bmad-master", "developer", "scrum-master"],
		order: "process-first",
		default_mode: "lazy",
		requires: "BMAD Method",
		install:
			"git clone BMAD-METHOD to ~/.claude/skills/bmad, add path in pi settings \"skills\"",
	},
	"cc-feature": {
		description: "Claude Code-style feature workflow",
		skills: [
			"using-superpowers",
			"brainstorming",
			"writing-plans",
			"test-driven-development",
			"requesting-code-review",
		],
		order: "process-first",
		default_mode: "lazy",
		requires: "Superpowers",
		install:
			"Install Claude Code Superpowers plugin, or copy skills to ~/.pi/agent/skills",
	},
	debug: {
		description: "Systematic bug investigation",
		skills: ["systematic-debugging", "test-driven-development"],
		order: "process-first",
		default_mode: "full",
		requires: "Superpowers",
		install:
			"Install Claude Code Superpowers plugin, or copy skills to ~/.pi/agent/skills",
	},
};

function getAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

function mergeBundleFile(
	target: Map<string, SkillBundle>,
	path: string,
): void {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed =
			path.endsWith(".yaml") || path.endsWith(".yml")
				? { bundles: parseYamlBundles(raw) }
				: (JSON.parse(raw) as { bundles?: Record<string, SkillBundle> });
		if (!parsed.bundles) return;
		for (const [name, bundle] of Object.entries(parsed.bundles)) {
			if (Array.isArray(bundle.skills) && bundle.skills.length > 0) {
				target.set(name, bundle);
			}
		}
	} catch {
		// Skip invalid bundle files
	}
}

export function loadBundles(cwd: string): Map<string, SkillBundle> {
	const bundles = new Map<string, SkillBundle>();
	for (const [name, bundle] of Object.entries(DEFAULT_BUNDLES)) {
		bundles.set(name, bundle);
	}

	const paths = [
		join(getAgentDir(), "skill-bundles.json"),
		join(getAgentDir(), "skill-bundles.yaml"),
		join(getAgentDir(), "skill-bundles.yml"),
		join(cwd, ".pi", "skill-bundles.json"),
		join(cwd, ".pi", "skill-bundles.yaml"),
		join(cwd, ".pi", "skill-bundles.yml"),
	];
	for (const path of paths) {
		if (existsSync(path)) mergeBundleFile(bundles, path);
	}

	return bundles;
}

export function expandSkillNames(
	names: string[],
	bundles: Map<string, SkillBundle>,
): { skills: string[]; modeHint?: SkillBundle["default_mode"] } {
	const expanded: string[] = [];
	let modeHint: SkillBundle["default_mode"] | undefined;

	for (const name of names) {
		const bundleName = name.startsWith("@") ? name.slice(1) : name;
		const bundle = bundles.get(bundleName);
		if (name.startsWith("@") && bundle) {
			expanded.push(...bundle.skills);
			modeHint = modeHint ?? bundle.default_mode;
		} else {
			expanded.push(name);
		}
	}

	return { skills: [...new Set(expanded)], modeHint };
}

export function bundleOrderHint(
	names: string[],
	bundles: Map<string, SkillBundle>,
): SkillBundle["order"] | undefined {
	for (const name of names) {
		if (!name.startsWith("@")) continue;
		const bundle = bundles.get(name.slice(1));
		if (bundle?.order) return bundle.order;
	}
	return undefined;
}
