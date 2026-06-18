/**
 * Pi-Context extension — live context window tracker with cross-model handoff.
 */
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import {
	getContextImportCompletions,
	getContextNameCompletions,
} from "./completions.ts";
import { loadConfig, saveConfig, listPacksForCwd } from "./config.ts";
import {
	handoffBudget,
	handoffExceedsBudget,
	importContextPack,
	saveContextPack,
} from "./handoff.ts";
import { formatPercent, formatTokens, percentValue } from "./format.ts";
import {
	buildPackSummary,
	buildSnapshot,
	extractArtifacts,
	extractPackMessages,
} from "./snapshot.ts";
import { TOTAL_CATEGORY_KEYS } from "./categories.ts";
import type { ContextPack, ContextSnapshot } from "./types.ts";
import { ContextView } from "./view.ts";

export default function piContextExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	let lastPromptOptions: BuildSystemPromptOptions | null = null;
	let lastSnapshot: ContextSnapshot | null = null;
	let lastCwd = process.cwd();

	function resolvePromptOptions(
		ctx: ExtensionContext,
	): BuildSystemPromptOptions | null {
		if (lastPromptOptions) return lastPromptOptions;
		const cmd = ctx as ExtensionCommandContext;
		if (typeof cmd.getSystemPromptOptions === "function") {
			return cmd.getSystemPromptOptions();
		}
		return null;
	}

	function refreshSnapshot(ctx: ExtensionContext): ContextSnapshot {
		const snap = buildSnapshot(ctx, pi, resolvePromptOptions(ctx));
		lastSnapshot = snap;
		return snap;
	}

	pi.on("before_agent_start", async (event) => {
		lastPromptOptions = event.systemPromptOptions;
	});

	pi.on("session_start", async (_e, ctx) => {
		lastCwd = ctx.cwd;
		lastPromptOptions = null;
		refreshSnapshot(ctx);
		refreshWidget(ctx);
	});

	pi.on("turn_end", async (_e, ctx) => {
		lastCwd = ctx.cwd;
		refreshSnapshot(ctx);
		refreshWidget(ctx);
		if (lastSnapshot) {
			pi.events.emit("context:snapshot", lastSnapshot);
		}
	});

	pi.on("session_compact", async (_e, ctx) => {
		refreshSnapshot(ctx);
		refreshWidget(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		refreshSnapshot(ctx);
		refreshWidget(ctx);
		if (!config.autoSuggestHandoff) return;
		const packs = listPacksForCwd(ctx.cwd);
		if (packs.length > 0) {
			ctx.ui.notify(
				`Context packs for this project: ${packs.slice(0, 3).join(", ")}${packs.length > 3 ? "…" : ""} — /context-import <name>`,
				"info",
			);
		}
	});

	async function runExportPack(
		ctx: ExtensionCommandContext,
		name?: string,
	): Promise<string> {
		const packName = name?.trim() || `pack-${Date.now()}`;
		const snapshot = lastSnapshot ?? refreshSnapshot(ctx);
		const pack = buildPackFromSnapshot(packName, ctx, snapshot);
		saveContextPack(pack);
		ctx.ui.notify(`Context pack saved: ${packName}`, "info");
		return packName;
	}

	async function runImportPack(
		ctx: ExtensionCommandContext,
		name?: string,
	): Promise<void> {
		const packName = name?.trim();
		if (!packName) {
			const packs = listPacksForCwd(ctx.cwd);
			if (packs.length === 0) {
				ctx.ui.notify(
					"No packs for this project — press e to export or /context-export",
					"error",
				);
				return;
			}
			if (packs.length > 1) {
				ctx.ui.notify(
					`Multiple packs: ${packs.join(", ")} — /context-import <name>`,
					"info",
				);
				return;
			}
			return runImportPack(ctx, packs[0]);
		}

		const targetWindow = ctx.model?.contextWindow ?? 128_000;
		let result;
		try {
			result = importContextPack(
				packName,
				targetWindow,
				config.reservePercent,
				ctx.cwd,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(msg, "error");
			return;
		}
		if (!result) {
			ctx.ui.notify(
				`Pack "${packName}" not found — /context-export ${packName}`,
				"error",
			);
			return;
		}

		if (
			handoffExceedsBudget(
				result.scaledTokens,
				targetWindow,
				config.reservePercent,
			)
		) {
			const budget = handoffBudget(targetWindow, config.reservePercent);
			ctx.ui.notify(
				`Handoff still exceeds budget (${formatTokens(result.scaledTokens)} > ${formatTokens(budget)}). Import cancelled.`,
				"error",
			);
			return;
		}

		pi.sendUserMessage(result.injectMessage);
		const omit =
			result.omitted.length > 0
				? ` Omitted: ${result.omitted.slice(0, 3).join("; ")}`
				: "";
		ctx.ui.notify(
			`Imported ${formatTokens(result.scaledTokens)} tok into ${ctx.model?.name ?? "model"}.${omit}`,
			"info",
		);
	}

	async function runHandoffPack(
		ctx: ExtensionCommandContext,
		name?: string,
	): Promise<string> {
		const packName = name?.trim() || `handoff-${Date.now()}`;
		const snapshot = lastSnapshot ?? refreshSnapshot(ctx);
		const pack = buildPackFromSnapshot(packName, ctx, snapshot);
		saveContextPack(pack);
		ctx.ui.notify(
			`Pack "${packName}" saved. Switch model, then /context-import ${packName}`,
			"info",
		);
		return packName;
	}

	async function openContextPanel(
		ctx: ExtensionCommandContext,
		expanded: boolean,
	): Promise<void> {
		const snapshot = lastSnapshot ?? refreshSnapshot(ctx);
		const view = new ContextView(
			{
				theme: ctx.ui.theme,
				tui: undefined,
				expandedMode: expanded,
				warnPercent: config.warnPercent,
				onClose: () => undefined,
				onRefresh: () => {
					view.setSnapshot(refreshSnapshot(ctx));
				},
				onExport: () => {
					void runExportPack(ctx);
				},
				onImport: () => {
					void runImportPack(ctx);
				},
				onHandoff: () => {
					void runHandoffPack(ctx);
				},
			},
			snapshot,
		);

		await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
			view.bind(tui, theme, () => done(undefined));
			return view;
		});
	}

	function refreshWidget(ctx: ExtensionContext): void {
		if (!config.showWidget) return;
		const snap = lastSnapshot ?? refreshSnapshot(ctx);
		const used = usedFromSnapshot(snap);
		const pct = percentValue(used, snap.contextWindow);
		const color =
			pct > 90 ? "error" : pct > config.warnPercent ? "warning" : "text";
		const pctLabel =
			snap.unknownTotal ? "?" : formatPercent(used, snap.contextWindow);
		ctx.ui.setWidget("context", [
			`${ctx.ui.theme.fg("dim", "◈")} ${ctx.ui.theme.fg(color, `${snap.unknownTotal ? "~" : ""}${formatTokens(used)}/${formatTokens(snap.contextWindow)} (${pctLabel})`)}`,
		]);
	}

	function buildPackFromSnapshot(
		name: string,
		ctx: ExtensionCommandContext,
		snapshot: ContextSnapshot,
	): ContextPack {
		const branch = ctx.sessionManager.getBranch();
		const { messages } = buildSessionContext(branch);
		return {
			version: 1,
			name,
			createdAt: new Date().toISOString(),
			source: {
				modelId: snapshot.modelId,
				modelName: snapshot.modelName,
				provider: snapshot.provider,
				contextWindow: snapshot.contextWindow,
				cwd: ctx.cwd,
				sessionPath: ctx.sessionManager.getSessionFile(),
			},
			summary: buildPackSummary(messages),
			totalTokens: snapshot.totalTokens ?? usedFromSnapshot(snapshot),
			categories: snapshot.categories,
			messages: extractPackMessages(messages),
			systemPromptExcerpt: ctx.getSystemPrompt().slice(0, 8000),
			artifacts: extractArtifacts(messages),
		};
	}

	pi.registerCommand("context", {
		description:
			"Context window — usage breakdown, dot grid, cross-model handoff",
		handler: async (args, ctx) => {
			const expanded = args?.trim() === "all";
			await openContextPanel(ctx, expanded);
		},
	});

	pi.registerCommand("context-export", {
		description: "Export context pack — /context-export [name]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
			getContextNameCompletions(prefix, lastCwd),
		handler: async (args, ctx) => {
			await runExportPack(ctx, args?.trim() || undefined);
		},
	});

	pi.registerCommand("context-import", {
		description: "Import context pack — /context-import <name>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
			getContextImportCompletions(prefix, lastCwd),
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /context-import <name>", "error");
				return;
			}
			await runImportPack(ctx, args.trim());
		},
	});

	pi.registerCommand("context-handoff", {
		description: "Export pack for model switch — /context-handoff [name]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null =>
			getContextNameCompletions(prefix, lastCwd),
		handler: async (args, ctx) => {
			await runHandoffPack(ctx, args?.trim() || undefined);
		},
	});

	pi.registerCommand("context-widget", {
		description: "Toggle always-on context usage widget",
		handler: async (_args, ctx) => {
			config = { ...config, showWidget: !config.showWidget };
			saveConfig(config);
			if (!config.showWidget) ctx.ui.setWidget("context", undefined);
			refreshWidget(ctx);
			ctx.ui.notify(
				`Context widget ${config.showWidget ? "on" : "off"}`,
				"info",
			);
		},
	});

	pi.registerCommand("context-config", {
		description: "Set warn threshold and handoff reserve percent",
		handler: async (_args, ctx) => {
			const warn = await ctx.ui.input(
				"Warn percent",
				String(config.warnPercent),
			);
			const reserve = await ctx.ui.input(
				"Handoff reserve percent",
				String(config.reservePercent),
			);
			if (warn) {
				const n = Number.parseInt(warn, 10);
				if (Number.isFinite(n) && n > 0 && n < 100) {
					config.warnPercent = n;
				}
			}
			if (reserve) {
				const n = Number.parseInt(reserve, 10);
				if (Number.isFinite(n) && n > 0 && n < 50) {
					config.reservePercent = n;
				}
			}
			saveConfig(config);
			ctx.ui.notify(
				`Context config: warn ${config.warnPercent}% · reserve ${config.reservePercent}%`,
				"info",
			);
		},
	});
}

function usedFromSnapshot(snapshot: ContextSnapshot): number {
	if (snapshot.totalTokens != null) return snapshot.totalTokens;
	return TOTAL_CATEGORY_KEYS.reduce(
		(s, k) => s + (snapshot.categories.find((c) => c.key === k)?.tokens ?? 0),
		0,
	);
}
