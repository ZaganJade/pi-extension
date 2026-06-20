/**
 * Regression test for the multi-skill display bug.
 *
 * Desired display (what the user wants):
 *
 *   [skill] analyst, frontend-design (ctrl+o to expand)
 *
 *    aku mau kamu revisi
 *
 * Pi achieves this when the message matches its native skill envelope with an
 * optional `userMessage` tail:
 *
 *   <skill name="analyst, frontend-design" location="pi-multi-skill">
 *   …collapsed content (priority rules + inner skill blocks + meta)…
 *   </skill>
 *
 *   aku mau kamu revisi
 *
 * Two things must hold:
 *  1. Inner per-skill blocks must NOT close with `</skill>` — Pi's non-greedy
 *     parser would split there and leak `</manually_attached_skills>`, the outer
 *     `</skill>`, and any `<user_query>` tags into the rendered user message.
 *  2. The user's free-text instructions must be the `userMessage` tail (plain
 *     text after `</skill>\n\n`), NOT wrapped in `<user_query>` inside the
 *     envelope, otherwise they are hidden inside the collapsed block.
 *
 * Run:  node --test multi-skill/test/parse-leak.test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCombinedMessage } from "../src/build.ts";
import { enrichSkill } from "../src/metadata.ts";

// Mirror of Pi's parseSkillBlock (pi-coding-agent). Replicated here to pin the
// exact parser behavior the extension must stay compatible with.
const PI_PARSE_RE =
	/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

function piParseSkillBlock(text) {
	const m = text.match(PI_PARSE_RE);
	if (!m) return null;
	return {
		name: m[1],
		location: m[2],
		content: m[3],
		userMessage: m[4]?.trim() || undefined,
	};
}

// Mirror of pi-usage parseSkillBlocks (only reads <skill name="…"> openings).
function piUsageSkillNames(text) {
	const re = /<skill\s+name="([^"]+)"/g;
	const names = [];
	for (const match of text.matchAll(re)) names.push(match[1]);
	return [...new Set(names)];
}

function makeSkillFile(dir, name) {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	const content = `---
name: ${name}
description: ${name} skill description.
type: flexible
---
# ${name}

Body for ${name}.

## Available Commands

- **/${name}-cmd** - Run ${name}
`;
	writeFileSync(filePath, content, "utf-8");
	return enrichSkill({
		name,
		description: `${name} skill description.`,
		filePath,
		baseDir: join(dir, name),
	});
}

let tmpDir;
let skills;

test.before(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-multi-skill-leak-"));
	skills = {
		analyst: makeSkillFile(tmpDir, "analyst"),
		frontendDesign: makeSkillFile(tmpDir, "frontend-design"),
		bmadMaster: makeSkillFile(tmpDir, "bmad-master"),
	};
});

test.after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

const CASES = [
	{
		label: "2 skills + instructions (the reported bug)",
		names: ["analyst", "frontendDesign"],
		opts: { mode: "meta", instructions: "aku mau kamu revisi" },
		expectVisible: "aku mau kamu revisi",
	},
	{
		label: "1 skill + instructions (wrap forced by instructions)",
		names: ["analyst"],
		opts: { mode: "meta", instructions: "do the thing" },
		expectVisible: "do the thing",
	},
	{
		label: "3 skills + instructions + status + warnings (combo)",
		names: ["analyst", "frontendDesign", "bmadMaster"],
		opts: {
			mode: "meta",
			instructions: "ship it",
			bmadStatusBlock: "## BMAD Status\nphase: 3",
			conflictWarnings: ["a vs b"],
			bundles: ["bmad-solutioning"],
		},
		expectVisible: "ship it",
	},
	{
		label: "2 skills, no instructions (nothing visible below header)",
		names: ["analyst", "frontendDesign"],
		opts: { mode: "meta" },
		expectVisible: undefined,
	},
	{
		label: "2 skills + bmadStatusBlock only (status hidden, no user msg)",
		names: ["analyst", "frontendDesign"],
		opts: { mode: "meta", bmadStatusBlock: "## BMAD Status\nphase: 3" },
		expectVisible: undefined,
	},
	{
		label: "2 skills + embeddedCommand only (command hidden, no user msg)",
		names: ["analyst", "frontendDesign"],
		opts: { mode: "meta", embeddedCommand: "/workflow-status" },
		expectVisible: undefined,
	},
];

for (const c of CASES) {
	test(`collapses skill content + surfaces instructions: ${c.label}`, () => {
		const selected = c.names.map((n) => skills[n]);
		const { message } = buildCombinedMessage(selected, tmpDir, c.opts);

		const parsed = piParseSkillBlock(message);
		assert.ok(parsed, "message must match Pi's skill-block envelope");

		// Header collapses to the skill set name.
		assert.equal(parsed.name, c.names.map((n) => skills[n].name).join(", "));

		// The user's instructions are the visible userMessage tail (clean text).
		assert.equal(
			parsed.userMessage,
			c.expectVisible,
			`userMessage should be ${JSON.stringify(c.expectVisible)}, got: ${JSON.stringify(parsed.userMessage)}`,
		);

		// No raw wrapper/leak tags anywhere in the rendered user message.
		if (parsed.userMessage) {
			assert.equal(parsed.userMessage.includes("<user_query>"), false);
			assert.equal(
				parsed.userMessage.includes("</manually_attached_skills>"),
				false,
			);
			assert.equal(parsed.userMessage.includes("</skill>"), false);
		}

		// Meta context (BMAD status) stays INSIDE the collapsed content, never
		// in the visible tail.
		if (c.opts.bmadStatusBlock) {
			assert.equal(parsed.content.includes("BMAD Status"), true);
			assert.notEqual(parsed.userMessage?.includes("BMAD Status"), true);
		}

		// Exactly one real </skill> (the outer envelope); inner closers are the
		// non-colliding </skill-block> token.
		assert.equal(
			(message.match(/<\/skill>/g) || []).length,
			1,
			"exactly one real </skill> (the outer envelope)",
		);
	});
}

for (const c of CASES) {
	test(`pi-usage attribution intact: ${c.label}`, () => {
		const selected = c.names.map((n) => skills[n]);
		const { message } = buildCombinedMessage(selected, tmpDir, c.opts);
		const found = piUsageSkillNames(message);
		for (const n of c.names) {
			assert.ok(
				found.includes(skills[n].name),
				`pi-usage should still see skill "${skills[n].name}" (found: ${found.join(", ")})`,
			);
		}
	});
}

test("header location is pi-multi-skill for multi-skill sets", () => {
	const selected = ["analyst", "frontendDesign"].map((n) => skills[n]);
	const { message } = buildCombinedMessage(selected, tmpDir, {
		mode: "meta",
		instructions: "revise",
	});
	const parsed = piParseSkillBlock(message);
	assert.equal(parsed.location, "pi-multi-skill");
});

test("legacy nested </skill> + <user_query> inside DOES leak (documents the bug)", () => {
	// Synthetic pre-fix message: inner blocks closed with </skill> AND the
	// user query wrapped in <user_query> inside the envelope.
	const legacy = `<skill name="analyst, frontend-design" location="pi-multi-skill">
<manually_attached_skills count="2">
Skills: analyst, frontend-design

<skill name="analyst" location="/x/SKILL.md">
(load mode: meta)
analyst body
</skill>
<skill name="frontend-design" location="/y/SKILL.md">
(load mode: meta)
fd body
</skill>

<user_query>
aku mau kamu revisi
</user_query>
</manually_attached_skills>
</skill>`;
	const parsed = piParseSkillBlock(legacy);
	// The bug: the whole tail (including raw tags) leaks into userMessage.
	assert.ok(parsed.userMessage);
	assert.equal(parsed.userMessage.includes("<user_query>"), true);
	assert.equal(
		parsed.userMessage.includes("</manually_attached_skills>"),
		true,
	);
	assert.equal(parsed.userMessage.includes("</skill>"), true);
});
