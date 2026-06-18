import type { ContextPack, HandoffResult, PackMessage } from "./types.ts";
import { escapeXml, estimateTextTokens, truncateToTokenBudget } from "./format.ts";
import { writePack, readPack, findPackFile, packPath } from "./config.ts";

const HANDOFF_SKILL = "pi-context-handoff";

/** `<skill>` open/close tag overhead (approx tokens). */
const HANDOFF_BASE_OVERHEAD = 120;
/** Per-message markdown section (`### role` + spacing). */
const MSG_SECTION_OVERHEAD = 18;

/** Pi TUI collapses user messages that match this exact envelope. */
const PI_SKILL_BLOCK_RE =
	/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

export function handoffBudget(
	targetWindow: number,
	reservePercent: number,
): number {
	return Math.floor(targetWindow * (1 - reservePercent / 100));
}

export function handoffExceedsBudget(
	scaledTokens: number,
	targetWindow: number,
	reservePercent: number,
): boolean {
	return scaledTokens > handoffBudget(targetWindow, reservePercent);
}

export function saveContextPack(pack: ContextPack): void {
	writePack(pack.name, JSON.stringify(pack, null, 2));
}

export function loadContextPack(name: string, cwd?: string): ContextPack | null {
	const raw = readPack(name, cwd);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as ContextPack;
		if (parsed.version !== 1) return null;
		return normalizePack(parsed);
	} catch {
		return null;
	}
}

/** Recompute token counts from stored text (fixes legacy v0.1.0 packs). */
export function normalizePackMessage(msg: PackMessage): PackMessage {
	return {
		...msg,
		tokens: estimateTextTokens(msg.text),
	};
}

export function normalizePack(pack: ContextPack): ContextPack {
	return {
		...pack,
		messages: pack.messages.map(normalizePackMessage),
	};
}

export function validatePackCwd(pack: ContextPack, cwd: string): string | null {
	if (!pack.source.cwd) return null;
	if (pack.source.cwd !== cwd) {
		return `Pack "${pack.name}" belongs to ${pack.source.cwd}, not this project (${cwd}).`;
	}
	return null;
}

function handoffLocation(pack: ContextPack, cwd?: string): string {
	return findPackFile(pack.name, cwd) ?? packPath(pack.name);
}

/** Wrap content in Pi's native skill block so the TUI shows `[skill] name`. */
export function formatPiSkillBlock(
	name: string,
	location: string,
	content: string,
): string {
	return `<skill name="${escapeXml(name)}" location="${escapeXml(location)}">\n${content}\n</skill>`;
}

/** True when text matches Pi's collapsed skill-invocation envelope. */
export function isPiSkillBlock(text: string): boolean {
	return PI_SKILL_BLOCK_RE.test(text);
}

export function buildHandoffMessage(
	pack: ContextPack,
	summary: string,
	systemExcerpt: string,
	messages: PackMessage[],
	scaled: boolean,
	cwd?: string,
): string {
	const lines: string[] = [
		"# Context handoff",
		"",
		`Pack: ${pack.name}`,
		`Source: ${pack.source.modelName} (${pack.source.modelId})`,
	];

	if (scaled) {
		lines.push("", "_Scaled to fit target context window._");
	}

	if (systemExcerpt.trim()) {
		lines.push("", "## System context excerpt", systemExcerpt.trim());
	}

	lines.push("", "## Summary", summary.trim());

	if (messages.length > 0) {
		lines.push("", `## Recent messages (${messages.length})`);
		for (const m of messages) {
			lines.push("", `### ${m.role}`, m.text);
		}
	}

	lines.push("", "## Artifacts");
	if (pack.artifacts.length > 0) {
		for (const artifact of pack.artifacts) {
			lines.push(`- ${artifact}`);
		}
	} else {
		lines.push("(none)");
	}

	lines.push(
		"",
		`Imported from pi-context pack "${pack.name}". Continue with this shared context.`,
	);

	return formatPiSkillBlock(
		HANDOFF_SKILL,
		handoffLocation(pack, cwd),
		lines.join("\n"),
	);
}

/** Smallest valid handoff envelope — used when the target window is extremely tight. */
export function buildCompactHandoff(
	pack: ContextPack,
	note: string,
	cwd?: string,
): string {
	const content = [
		"# Context handoff",
		"",
		`Pack: ${pack.name}`,
		`Source: ${pack.source.modelName}`,
		note.trim(),
	].join("\n");

	return formatPiSkillBlock(
		HANDOFF_SKILL,
		handoffLocation(pack, cwd),
		content,
	);
}

function fitHandoffToBudget(
	pack: ContextPack,
	budget: number,
	cwd?: string,
): string {
	if (budget <= 0) return "";

	const notes = [
		"Context digest omitted — target window too small.",
		"Digest omitted — window too small.",
		"Omitted.",
		"…",
	];

	for (const note of notes) {
		const msg = buildCompactHandoff(pack, note, cwd);
		if (estimateTextTokens(msg) <= budget) return msg;
	}

	const empty = buildCompactHandoff(pack, "", cwd);
	return truncateToTokenBudget(empty, budget);
}

function messageTokens(msg: PackMessage): number {
	return estimateTextTokens(msg.text);
}

export function scalePack(
	pack: ContextPack,
	targetWindow: number,
	reserveRatio = 0.15,
	cwd?: string,
): HandoffResult {
	const normalized = normalizePack(pack);
	const budget = Math.floor(targetWindow * (1 - reserveRatio));
	const omitted: string[] = [];
	let remaining = budget - HANDOFF_BASE_OVERHEAD;

	const excerptBudget = Math.min(Math.floor(budget * 0.12), 4000);
	let systemExcerpt = truncateToTokenBudget(
		normalized.systemPromptExcerpt ?? "",
		excerptBudget,
	);
	remaining -= estimateTextTokens(systemExcerpt);

	const summaryBudget = Math.min(Math.floor(budget * 0.18), 6000);
	let summary = truncateToTokenBudget(normalized.summary, summaryBudget);
	remaining -= estimateTextTokens(summary);

	const kept: PackMessage[] = [];

	for (const raw of [...normalized.messages].reverse()) {
		const msg = normalizePackMessage(raw);
		const overhead = MSG_SECTION_OVERHEAD;
		const available = remaining - overhead;
		if (available <= 0) {
			omitted.push(`${msg.role} message (${messageTokens(msg)} tok)`);
			continue;
		}

		const tok = messageTokens(msg);
		if (tok <= available) {
			kept.unshift(msg);
			remaining -= tok + overhead;
			continue;
		}

		const truncatedText = truncateToTokenBudget(msg.text, available);
		if (!truncatedText.trim()) {
			omitted.push(`${msg.role} message (${tok} tok, no room)`);
			continue;
		}
		const truncated: PackMessage = {
			role: msg.role,
			text: truncatedText,
			tokens: estimateTextTokens(truncatedText),
		};
		kept.unshift(truncated);
		remaining -= truncated.tokens + overhead;
		omitted.push(
			`truncated ${msg.role} message (${tok} → ${truncated.tokens} tok)`,
		);
	}

	if (
		normalized.source.contextWindow > targetWindow &&
		(omitted.length > 0 || kept.length < normalized.messages.length)
	) {
		omitted.unshift(
			`scaled ${normalized.source.contextWindow} → ${targetWindow} context window`,
		);
	}

	let scaled = omitted.length > 0;
	let injectMessage = buildHandoffMessage(
		normalized,
		summary,
		systemExcerpt,
		kept,
		scaled,
		cwd,
	);

	while (estimateTextTokens(injectMessage) > budget && kept.length > 0) {
		const dropped = kept.shift();
		if (dropped) {
			omitted.push(`dropped oldest ${dropped.role} message to fit budget`);
		}
		scaled = true;
		injectMessage = buildHandoffMessage(
			normalized,
			summary,
			systemExcerpt,
			kept,
			scaled,
			cwd,
		);
	}

	while (estimateTextTokens(injectMessage) > budget && summary.length > 0) {
		const prevSummary = summary;
		const prevTokens = estimateTextTokens(summary);
		summary = truncateToTokenBudget(
			summary,
			Math.max(1, Math.floor(prevTokens / 2)),
		);
		if (!summary.trim() || summary === prevSummary) {
			summary = "";
			break;
		}
		scaled = true;
		omitted.push("summary further truncated to fit target window");
		injectMessage = buildHandoffMessage(
			normalized,
			summary,
			systemExcerpt,
			kept,
			scaled,
			cwd,
		);
	}

	while (estimateTextTokens(injectMessage) > budget && systemExcerpt.length > 0) {
		systemExcerpt = "";
		scaled = true;
		omitted.push("system context excerpt dropped to fit target window");
		injectMessage = buildHandoffMessage(
			normalized,
			summary,
			systemExcerpt,
			kept,
			scaled,
			cwd,
		);
	}

	if (estimateTextTokens(injectMessage) > budget) {
		scaled = true;
		omitted.push("handoff reduced to minimal envelope for target window");
		injectMessage = fitHandoffToBudget(normalized, budget, cwd);
	}

	const scaledTokens = estimateTextTokens(injectMessage);

	return {
		pack: normalized,
		targetWindow,
		scaledTokens,
		omitted,
		injectMessage,
	};
}

export function importContextPack(
	name: string,
	targetWindow: number,
	reservePercent: number,
	cwd?: string,
): HandoffResult | null {
	const pack = loadContextPack(name, cwd);
	if (!pack) return null;
	if (cwd) {
		const err = validatePackCwd(pack, cwd);
		if (err) throw new Error(err);
	}
	return scalePack(pack, targetWindow, reservePercent / 100, cwd);
}
