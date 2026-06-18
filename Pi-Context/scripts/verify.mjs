/**
 * Pi-Context verification script — run: node scripts/verify.mjs
 */
import {
	scalePack,
	buildHandoffMessage,
	buildCompactHandoff,
	isPiSkillBlock,
	normalizePackMessage,
	validatePackCwd,
	handoffBudget,
	handoffExceedsBudget,
} from "../src/handoff.ts";
import {
	escapeXml,
	estimateTextTokens,
	truncateToTokenBudget,
	layoutCategoryCells,
	barUsageColor,
	buildDotGridCells,
	renderMiniBar,
} from "../src/format.ts";
import { extractPackMessages, buildSnapshot, reconcileSystemDetails } from "../src/snapshot.ts";
import { SYSTEM_DETAIL_KEYS, CATEGORY_ORDER } from "../src/categories.ts";
import { partitionMcpTools } from "../src/estimate.ts";
import { sanitizePackName, parseConfigJson, CONFIG_DEFAULTS, packPath, packFileName, writePack, readPack, listPackCatalog } from "../src/config.ts";
import { getContextImportCompletions } from "../src/completions.ts";
import { contextHint } from "../src/mascot.ts";
import { loadContextPack } from "../src/handoff.ts";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function assert(cond, label) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.error(`  ✗ ${label}`);
	}
}

console.log("Pi-Context verify\n");

// 1. Token mismatch fix
const packed = extractPackMessages([
	{ role: "user", content: "a".repeat(8000) },
]);
assert(packed[0].tokens === 1000, "extractPackMessages tokens match stored text");

// 2. Legacy pack normalize
const legacy = normalizePackMessage({
	role: "user",
	text: "hello",
	tokens: 9999,
});
assert(legacy.tokens === estimateTextTokens("hello"), "normalizePackMessage fixes stale tokens");

// 3. XML escape
const evil = '<script>"&</script>';
const escaped = escapeXml(evil);
assert(!escaped.includes("<script>"), "escapeXml neutralizes tags");
assert(escaped.includes("&lt;"), "escapeXml escapes <");

// 4. truncateToTokenBudget respects budget
const long = "x".repeat(10000);
const truncated = truncateToTokenBudget(long, 100);
assert(estimateTextTokens(truncated) <= 100, "truncateToTokenBudget stays within budget");

// 5. GPT -> GLM stress
const bigPack = {
	version: 1,
	name: "stress",
	createdAt: new Date().toISOString(),
	source: {
		modelId: "gpt-5",
		modelName: "GPT",
		provider: "openai",
		contextWindow: 1_000_000,
		cwd: "/proj/a",
	},
	summary: "y".repeat(50_000),
	totalTokens: 900_000,
	categories: [],
	messages: [
		...Array.from({ length: 499 }, () => ({
			role: "user",
			text: "a".repeat(4000),
			tokens: 9999,
		})),
		{ role: "user", text: '<unsafe>"&</unsafe>', tokens: 9999 },
	],
	systemPromptExcerpt: "system ".repeat(2000),
	artifacts: ["src/a.ts"],
};
const budget = Math.floor(128_000 * 0.85);
const r = scalePack(bigPack, 128_000, 0.15);
assert(r.scaledTokens <= budget, `GPT→GLM inject ${r.scaledTokens} <= budget ${budget}`);
assert(isPiSkillBlock(r.injectMessage), "handoff uses Pi native skill envelope");
assert(
	!r.injectMessage.includes("</message>") &&
		!r.injectMessage.includes("<recent_messages") &&
		!r.injectMessage.includes("<manually_attached_skills"),
	"handoff avoids nested XML wrappers",
);

// 6. cwd validation
const cwdErr = validatePackCwd(bigPack, "/proj/b");
assert(cwdErr !== null, "validatePackCwd rejects wrong project");
assert(validatePackCwd(bigPack, "/proj/a") === null, "validatePackCwd accepts matching cwd");

// 7. Tiny window edge case
const tiny = scalePack(
	{
		...bigPack,
		messages: [{ role: "user", text: "hi", tokens: 1 }],
		summary: "short",
		systemPromptExcerpt: "",
	},
	8_000,
	0.15,
);
assert(tiny.scaledTokens <= Math.floor(8_000 * 0.85), "tiny window handoff fits budget");

// 8. buildHandoffMessage with special chars
const msg = buildHandoffMessage(
	bigPack,
	'<summary>"test"',
	"",
	[{ role: "user", text: "<xml>", tokens: 2 }],
	false,
);
assert(msg.includes('<summary>"test"'), "buildHandoffMessage keeps summary literal in markdown");
assert(msg.includes("<xml>"), "buildHandoffMessage keeps message body literal");
assert(isPiSkillBlock(msg), "buildHandoffMessage matches Pi skill envelope");

// 9. scalePack loop termination on tiny window
const tinyBudget = Math.floor(500 * 0.85);
const tinyLoop = scalePack(
	{ ...bigPack, messages: [], summary: "x".repeat(5000), systemPromptExcerpt: "y".repeat(5000) },
	500,
	0.15,
);
assert(Number.isFinite(tinyLoop.scaledTokens), "scalePack terminates on tiny window");
assert(
	tinyLoop.scaledTokens <= tinyBudget,
	`tiny window ${tinyLoop.scaledTokens} tok <= budget ${tinyBudget}`,
);

// 10. view render smoke
const { ContextView } = await import("../src/view.ts");
const snap = {
	at: Date.now(),
	modelId: "test",
	modelName: "Test",
	provider: "test",
	contextWindow: 128000,
	totalTokens: 1000,
	unknownTotal: false,
	expanded: null,
	categories: [
		{ key: "messages", label: "Messages", tokens: 800, percent: 0.6, children: [] },
		{ key: "free", label: "Free space", tokens: 127000, percent: 99 },
	],
};
const view = new ContextView(
	{ theme: { fg: (_c, t) => t }, tui: undefined, onClose: () => {}, onRefresh: () => {}, expandedMode: false },
	snap,
);
const lines = view.render(80);
assert(lines.length > 0, "ContextView renders without crash");

// 11. reconcileSystemDetails caps detail buckets
const bucket = new Map();
bucket.set("systemPrompt", {
	key: "systemPrompt",
	label: "System prompt",
	tokens: 100,
	percent: 1,
});
bucket.set("systemTools", {
	key: "systemTools",
	label: "System tools",
	tokens: 300,
	percent: 3,
	children: [{ name: "tool-a", tokens: 300 }],
});
bucket.set("skills", {
	key: "skills",
	label: "Skills",
	tokens: 200,
	percent: 2,
	children: [{ name: "skill-a", tokens: 200 }],
});
reconcileSystemDetails(bucket, 10_000);
const sysPrompt = bucket.get("systemPrompt").tokens;
const detailSum = SYSTEM_DETAIL_KEYS.reduce(
	(s, k) => s + (bucket.get(k)?.tokens ?? 0),
	0,
);
assert(detailSum <= sysPrompt, "reconcileSystemDetails caps detail sum to systemPrompt");
for (const key of SYSTEM_DETAIL_KEYS) {
	const item = bucket.get(key);
	if (!item?.children?.length) continue;
	const childSum = item.children.reduce((s, c) => s + c.tokens, 0);
	assert(childSum <= item.tokens, `reconcileSystemDetails scales ${key} children`);
}

// 12. buildSnapshot reconciles inflated tool estimates
const mockCtx = {
	getContextUsage: () => ({ tokens: 5000, contextWindow: 128_000 }),
	model: {
		id: "test-model",
		name: "Test Model",
		provider: "test",
		contextWindow: 128_000,
	},
	sessionManager: { getBranch: () => [] },
	getSystemPrompt: () => "hi",
};
const mockPi = {
	getActiveTools: () => ["heavy_tool"],
	getAllTools: () => [
		{
			name: "heavy_tool",
			description: "x".repeat(8000),
			parameters: { type: "object", properties: {} },
			sourceInfo: { source: "builtin", path: "" },
		},
	],
	getCommands: () => [],
};
const mockSnap = buildSnapshot(mockCtx, mockPi, { skills: [], contextFiles: [] });
const snapSys = mockSnap.categories.find((c) => c.key === "systemPrompt")?.tokens ?? 0;
const snapTools = mockSnap.categories.find((c) => c.key === "systemTools")?.tokens ?? 0;
assert(snapTools <= snapSys, "buildSnapshot keeps systemTools within systemPrompt");
assert(mockSnap.totalTokens === 5000, "buildSnapshot uses authoritative usage total");
assert(mockSnap.unknownTotal === false, "buildSnapshot marks known total when usage present");

// 13. handoff import budget guard
assert(handoffBudget(128_000, 15) === 108_800, "handoffBudget matches reserve percent");
assert(
	handoffExceedsBudget(108_801, 128_000, 15),
	"handoffExceedsBudget rejects over-budget inject",
);
assert(
	!handoffExceedsBudget(108_800, 128_000, 15),
	"handoffExceedsBudget accepts at-budget inject",
);

// 14. partitionMcpTools splits MCP vs system
const tools = [
	{ name: "read", description: "read", parameters: {}, sourceInfo: { source: "builtin", path: "" } },
	{ name: "mcp_search", description: "search", parameters: {}, sourceInfo: { source: "mcp-server", path: "" } },
	{ name: "mcp_idle", description: "idle", parameters: {}, sourceInfo: { source: "mcp-server", path: "" } },
];
const active = new Set(["read", "mcp_search"]);
const parts = partitionMcpTools(tools, active);
assert(parts.system.length === 1 && parts.system[0].name === "read", "partitionMcpTools keeps system tools");
assert(parts.mcp.length === 1 && parts.mcp[0].name === "mcp_search", "partitionMcpTools keeps active MCP");
assert(parts.mcpDeferred.length === 1 && parts.mcpDeferred[0].name === "mcp_idle", "partitionMcpTools defers inactive MCP");

// 15. ContextView cycleExpand with expandable categories
const expandableSnap = {
	...mockSnap,
	categories: [
		{
			key: "systemTools",
			label: "System tools",
			tokens: 100,
			percent: 1,
			children: [{ name: "read", tokens: 100 }],
		},
		{ key: "free", label: "Free space", tokens: 127900, percent: 99 },
	],
};
const expandView = new ContextView(
	{ theme: { fg: (_c, t) => t }, tui: undefined, onClose: () => {}, onRefresh: () => {}, expandedMode: false },
	expandableSnap,
);
expandView.handleInput("\t");
const expandedLines = expandView.render(80);
assert(
	expandedLines.some((l) => l.includes("read")),
	"ContextView cycleExpand shows child rows",
);

// 16. layoutCategoryCells fills all cells
const layout = layoutCategoryCells(
	[
		{ key: "messages", tokens: 6000 },
		{ key: "systemPrompt", tokens: 3000 },
		{ key: "free", tokens: 119000 },
	],
	128_000,
	60,
	CATEGORY_ORDER,
);
assert(
	layout.reduce((s, l) => s + l.cells, 0) === 60,
	"layoutCategoryCells sums to bar width",
);
assert(layout.some((l) => l.key === "messages"), "layoutCategoryCells includes messages");

// 16b. grid reserves free cells from authoritative used total
const gridCells = buildDotGridCells(
	[
		{ key: "messages", tokens: 300 },
		{ key: "systemPrompt", tokens: 200 },
	],
	1000,
	CATEGORY_ORDER,
	100,
	500,
);
const gridFilled = gridCells.filter((c) => c !== "free").length;
const gridFree = gridCells.filter((c) => c === "free").length;
assert(gridFilled === 50, `grid filled cells match used share (${gridFilled})`);
assert(gridFree === 50, `grid free cells match remainder (${gridFree})`);

// 16c. mini bar shows at least one cell for tiny non-zero shares
const tinyBar = renderMiniBar(7600, 1_000_000, 40);
assert(tinyBar.startsWith("█"), "mini bar renders sliver for 0.8% share");
assert(tinyBar.length === 40, "mini bar keeps full track width");

// 17. barUsageColor respects warnPercent
assert(barUsageColor(80_000, 100_000, 70) === "warning", "barUsageColor warns above threshold");
assert(barUsageColor(80_000, 100_000, 90) === "accent", "barUsageColor uses custom warnPercent");
assert(barUsageColor(95_000, 100_000, 70) === "error", "barUsageColor errors above 90%");

// 18. sanitizePackName
assert(sanitizePackName("foo/bar") === "foo_bar", "sanitizePackName replaces slashes");
assert(sanitizePackName("safe-pack.v1") === "safe-pack.v1", "sanitizePackName keeps safe chars");

// 19. mascot hints include panel shortcuts
assert(contextHint(false).includes("Tab details"), "contextHint lists expand key");
assert(contextHint(false).includes("e export"), "contextHint lists export key");
assert(contextHint(false).includes("i import"), "contextHint lists import key");

// 20. panel e/i/h callbacks
let exportCalled = false;
let importCalled = false;
let handoffCalled = false;
const actionView = new ContextView(
	{
		theme: { fg: (_c, t) => t },
		tui: undefined,
		onClose: () => {},
		onRefresh: () => {},
		expandedMode: false,
		onExport: () => { exportCalled = true; },
		onImport: () => { importCalled = true; },
		onHandoff: () => { handoffCalled = true; },
	},
	snap,
);
actionView.handleInput("e");
actionView.handleInput("i");
actionView.handleInput("h");
assert(exportCalled, "ContextView e triggers onExport");
assert(importCalled, "ContextView i triggers onImport");
assert(handoffCalled, "ContextView h triggers onHandoff");

// 21. segmented bar renders category blocks
const segSnap = {
	...snap,
	contextWindow: 1000,
	totalTokens: 500,
	categories: [
		{ key: "messages", label: "Messages", tokens: 300, percent: 30 },
		{ key: "systemPrompt", label: "System prompt", tokens: 200, percent: 20 },
		{ key: "free", label: "Free space", tokens: 500, percent: 50 },
	],
};
const segView = new ContextView(
	{ theme: { fg: (_c, t) => t }, tui: undefined, onClose: () => {}, onRefresh: () => {}, expandedMode: false, warnPercent: 50 },
	segSnap,
);
const segLines = segView.render(80);
assert(
	segLines.some((l) => l.includes("Context ·") && l.includes("/")),
	"title bar kept above context panel",
);
assert(
	segLines.some((l) => l.includes("█") && l.includes("░")),
	"overview bar kept above context panel",
);
assert(
	segLines.some((l) => l.includes("Context usage")),
	"claude-style context usage header",
);
assert(
	segLines.some((l) => l.includes("Estimated usage by category")),
	"side panel shows category estimate header",
);
assert(
	segLines.some((l) => l.includes("▤") || l.includes("□")),
	"grid uses filled and free glyphs",
);
assert(
	segLines.some((l) => l.includes("tokens (")) &&
		segLines.some((l) => l.includes("Free space")),
	"legend rows show tokens and free space",
);
assert(
	segLines.some((l) => l.includes("Category") && l.includes("Usage")),
	"breakdown table includes usage column",
);
assert(
	segLines.some((l) => l.includes("Breakdown")),
	"breakdown section header renders",
);
assert(
	segLines.some((l) => l.includes("Messages") && /█|░/.test(l)),
	"category rows include usage bars",
);
assert(
	segLines.some((l) => l.includes("Keys") && l.includes("Tab")),
	"footer keys row aligns to table",
);
assert(
	segLines.some((l) => l.includes("Note") && l.includes("system prompt")),
	"footer note row aligns to table",
);

const narrowLines = segView.render(60);
assert(
	narrowLines.some((l) => l.includes("Context ·")),
	"narrow terminal keeps title bar",
);
assert(
	narrowLines.some((l) => l.includes("█") && l.includes("░")),
	"narrow terminal keeps overview bar",
);
assert(
	!narrowLines.some((l) => l.includes("Context usage")),
	"narrow terminal hides context panel",
);

const { resolveContextGridLayout } = await import("../src/format.ts");
const layout80 = resolveContextGridLayout(80);
const layout120 = resolveContextGridLayout(120);
assert(layout120.rightColStart > layout80.rightColStart, "wider terminal spreads right panel");
assert(layout120.cols >= layout80.cols, "wider terminal uses wider grid");

// 22. parseConfigJson corrupt JSON
assert(
	parseConfigJson("{not-json").warnPercent === CONFIG_DEFAULTS.warnPercent,
	"parseConfigJson returns defaults on corrupt JSON",
);

// 23. parseConfigJson invalid numeric fields
const badNums = parseConfigJson('{"warnPercent":"nope","reservePercent":999}');
assert(badNums.warnPercent === 70, "parseConfigJson rejects invalid warnPercent");
assert(badNums.reservePercent === 15, "parseConfigJson rejects out-of-range reservePercent");

// 24. parseConfigJson partial merge
const partial = parseConfigJson('{"showWidget":true,"warnPercent":55}');
assert(partial.showWidget === true && partial.warnPercent === 55, "parseConfigJson merges valid fields");
assert(partial.reservePercent === 15, "parseConfigJson keeps defaults for missing fields");

// 25. packPath / packFileName sanitization
assert(packFileName("foo/bar") === "foo_bar.json", "packFileName sanitizes slashes");
assert(packPath("foo/bar").endsWith("foo_bar.json"), "packPath ends with sanitized filename");

// 26. writePack/readPack roundtrip with unsafe name
const roundName = `verify-round-${Date.now()}`;
const roundSlash = `${roundName}/x`;
writePack(roundSlash, '{"version":1,"probe":true}');
const roundRaw = readPack(roundSlash);
assert(roundRaw?.includes('"probe":true'), "writePack/readPack roundtrip via sanitized path");
if (existsSync(packPath(roundSlash))) unlinkSync(packPath(roundSlash));

// 27. loadContextPack rejects unknown version
writePack("verify-bad-version", '{"version":2,"name":"x"}');
assert(loadContextPack("verify-bad-version") === null, "loadContextPack rejects version !== 1");
if (existsSync(packPath("verify-bad-version"))) unlinkSync(packPath("verify-bad-version"));

// 28–32. index.ts command handlers (mock pi + ctx)
const handlers = {};
const commandSpecs = {};
const sentMessages = [];
const notifications = [];
const widgets = [];
const verifyCwd = "/verify-pi-context-proj";

const handlerPi = {
	registerCommand(name, spec) {
		handlers[name] = spec.handler;
		commandSpecs[name] = spec;
	},
	on() {},
	getActiveTools: () => [],
	getAllTools: () => [],
	getCommands: () => [],
	sendUserMessage(msg) {
		sentMessages.push(msg);
	},
	events: { emit() {} },
};

const handlerCtx = {
	cwd: verifyCwd,
	getContextUsage: () => ({ tokens: 1200, contextWindow: 128_000 }),
	model: {
		id: "verify-model",
		name: "Verify Model",
		provider: "test",
		contextWindow: 128_000,
	},
	sessionManager: {
		getBranch: () => [
			{
				type: "message",
				message: { role: "user", content: "verify handler test" },
			},
		],
		getSessionFile: () => "/tmp/verify-session.json",
	},
	getSystemPrompt: () => "verify system prompt",
	ui: {
		theme: { fg: (_c, t) => t },
		notify(msg, level) {
			notifications.push({ msg, level });
		},
		setWidget(_id, lines) {
			widgets.push(lines);
		},
		custom: async () => undefined,
		input: async () => null,
	},
};

const ext = await import("../src/index.ts");
ext.default(handlerPi);

const exportName = `verify-export-${Date.now()}`;
await handlers["context-export"](exportName, handlerCtx);
const exported = readPack(exportName);
assert(exported?.includes('"version": 1'), "context-export handler writes pack file");
assert(
	notifications.some((n) => n.msg.includes(exportName) && n.level === "info"),
	"context-export handler notifies success",
);

sentMessages.length = 0;
notifications.length = 0;
await handlers["context-import"](exportName, handlerCtx);
assert(sentMessages.length === 1, "context-import handler injects handoff message");
assert(isPiSkillBlock(sentMessages[0]), "context-import injects Pi skill envelope");
assert(
	notifications.some((n) => n.msg.includes("Imported") && n.level === "info"),
	"context-import handler notifies success",
);

// import guard: cwd mismatch
const mismatchName = `verify-mismatch-${Date.now()}`;
writePack(
	mismatchName,
	JSON.stringify({
		version: 1,
		name: mismatchName,
		createdAt: new Date().toISOString(),
		source: {
			modelId: "x",
			modelName: "x",
			provider: "x",
			contextWindow: 128_000,
			cwd: "/other/project",
		},
		summary: "test",
		totalTokens: 10,
		categories: [],
		messages: [],
		systemPromptExcerpt: "",
		artifacts: [],
	}),
);
sentMessages.length = 0;
notifications.length = 0;
await handlers["context-import"](mismatchName, handlerCtx);
assert(sentMessages.length === 0, "context-import rejects cwd mismatch");
assert(
	notifications.some((n) => n.level === "error" && n.msg.includes("belongs to")),
	"context-import notifies cwd mismatch",
);

// import guard: micro window falls back to compact handoff
const overName = `verify-over-${Date.now()}`;
writePack(
	overName,
	JSON.stringify({
		version: 1,
		name: overName,
		createdAt: new Date().toISOString(),
		source: {
			modelId: "x",
			modelName: "x",
			provider: "x",
			contextWindow: 128_000,
			cwd: verifyCwd,
		},
		summary: "minimal",
		totalTokens: 10,
		categories: [],
		messages: [],
		systemPromptExcerpt: "",
		artifacts: [],
	}),
);
const tinyCtx = {
	...handlerCtx,
	model: { ...handlerCtx.model, contextWindow: 70 },
};
sentMessages.length = 0;
notifications.length = 0;
await handlers["context-import"](overName, tinyCtx);
assert(sentMessages.length === 1, "context-import injects compact handoff on micro window");
assert(isPiSkillBlock(sentMessages[0]), "micro import keeps Pi skill envelope");
assert(
	notifications.some((n) => n.level === "info" && n.msg.includes("Imported")),
	"context-import notifies micro window success",
);

// context-handoff handler
const handoffName = `verify-handoff-${Date.now()}`;
notifications.length = 0;
await handlers["context-handoff"](handoffName, handlerCtx);
assert(readPack(handoffName) !== null, "context-handoff handler saves pack");
assert(
	notifications.some((n) => n.msg.includes(handoffName) && n.msg.includes("Switch model")),
	"context-handoff handler notifies next step",
);
assert(
	typeof commandSpecs["context-import"]?.getArgumentCompletions === "function",
	"context-import registers argument completions",
);

const catalog = listPackCatalog(verifyCwd);
assert(
	catalog.some((e) => e.name === exportName && e.matchesProject),
	"catalog lists exported pack for project cwd",
);
const importItems = getContextImportCompletions(exportName.slice(0, 12), verifyCwd);
assert(
	importItems?.some((i) => i.value === exportName),
	"import completions suggest exported pack",
);

const localDir = join(verifyCwd, ".pi", "context-packs");
mkdirSync(localDir, { recursive: true });
const localPack = "verify-local-pack";
writeFileSync(
	join(localDir, `${localPack}.json`),
	JSON.stringify({
		version: 1,
		name: localPack,
		createdAt: new Date().toISOString(),
		source: {
			cwd: verifyCwd,
			modelName: "Local",
			modelId: "local",
			provider: "test",
			contextWindow: 1000,
		},
		totalTokens: 100,
		summary: "",
		categories: [],
		messages: [],
		systemPromptExcerpt: "",
		artifacts: [],
	}),
);
assert(
	listPackCatalog(verifyCwd).some((e) => e.name === localPack && e.origin === "project-dot-pi"),
	"catalog scans project .pi/context-packs",
);
rmSync(join(localDir, `${localPack}.json`), { force: true });

// cleanup verify packs
for (const name of [exportName, mismatchName, overName, handoffName]) {
	const p = packPath(name);
	if (existsSync(p)) unlinkSync(p);
}

// 33. scalePack always fits budget (compact fallback on micro windows)
const micro = scalePack(
	{
		version: 1,
		name: "env",
		createdAt: "",
		source: { modelId: "x", modelName: "x", provider: "x", contextWindow: 500, cwd: "/a" },
		summary: "",
		totalTokens: 0,
		categories: [],
		messages: [],
		systemPromptExcerpt: "",
		artifacts: [],
	},
	70,
	0.15,
);
const microBudget = Math.floor(70 * 0.85);
assert(
	micro.scaledTokens <= microBudget,
	`scalePack fits micro window (${micro.scaledTokens} <= ${microBudget})`,
);
assert(
	micro.omitted.some((o) => o.includes("minimal envelope")),
	"scalePack notes minimal envelope fallback",
);

// 34. buildCompactHandoff stays within tight budget
const compact = buildCompactHandoff(
	{
		version: 1,
		name: "c",
		createdAt: "",
		source: { modelId: "x", modelName: "x", provider: "x", contextWindow: 70, cwd: "/a" },
		summary: "",
		totalTokens: 0,
		categories: [],
		messages: [],
		systemPromptExcerpt: "",
		artifacts: [],
	},
	"Digest omitted.",
);
assert(estimateTextTokens(compact) <= microBudget, "buildCompactHandoff fits micro budget");

// 35. pack name collision awareness
assert(
	sanitizePackName("foo/bar") === sanitizePackName("foo_bar"),
	"sanitizePackName collides foo/bar and foo_bar",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
