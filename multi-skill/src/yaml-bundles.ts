import type { LoadMode, SkillBundle, SkillOrder } from "./types.ts";

/** Minimal YAML parser for skill-bundles.yaml (bundles map only). */
export function parseYamlBundles(content: string): Record<string, SkillBundle> {
	const bundles: Record<string, SkillBundle> = {};
	const lines = content.replace(/\r\n/g, "\n").split("\n");

	let inBundles = false;
	let currentName: string | null = null;
	let current: Partial<SkillBundle> & { skills?: string[] } = {};
	let inSkillsList = false;

	const flush = () => {
		if (!currentName || !current.description || !current.skills?.length) {
			currentName = null;
			current = {};
			inSkillsList = false;
			return;
		}
		bundles[currentName] = {
			description: current.description,
			skills: current.skills,
			order: current.order,
			default_mode: current.default_mode,
		};
		currentName = null;
		current = {};
		inSkillsList = false;
	};

	for (const raw of lines) {
		const line = raw.replace(/\t/g, "  ");
		if (!line.trim() || line.trim().startsWith("#")) continue;

		if (/^bundles:\s*$/.test(line)) {
			inBundles = true;
			continue;
		}
		if (!inBundles) continue;

		const bundleMatch = line.match(/^  ([\w-]+):\s*$/);
		if (bundleMatch) {
			flush();
			currentName = bundleMatch[1];
			continue;
		}

		if (!currentName) continue;

		const descMatch = line.match(/^    description:\s*(.+)$/);
		if (descMatch) {
			current.description = descMatch[1].trim().replace(/^["']|["']$/g, "");
			continue;
		}

		const orderMatch = line.match(/^    order:\s*(\S+)/);
		if (orderMatch) {
			current.order = orderMatch[1] as SkillOrder;
			continue;
		}

		const modeMatch = line.match(/^    default_mode:\s*(\S+)/);
		if (modeMatch) {
			current.default_mode = modeMatch[1] as LoadMode;
			continue;
		}

		if (/^    skills:\s*$/.test(line)) {
			inSkillsList = true;
			current.skills = [];
			continue;
		}

		const inlineSkills = line.match(/^    skills:\s*\[(.*)\]\s*$/);
		if (inlineSkills) {
			current.skills = inlineSkills[1]
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
			inSkillsList = false;
			continue;
		}

		if (inSkillsList) {
			const itemMatch = line.match(/^      -\s+(.+)$/);
			if (itemMatch) {
				current.skills ??= [];
				current.skills.push(
					itemMatch[1].trim().replace(/^["']|["']$/g, ""),
				);
			}
		}
	}

	flush();
	return bundles;
}
