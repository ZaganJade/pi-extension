/**
 * Pure ZAI (Zhipu / GLM coding plans) quota-limit classification.
 *
 * Extracted from provider.ts into its own module so it has ZERO pi / pi-ai
 * runtime dependencies and is unit-testable without network or auth. The
 * network layer (provider.ts) imports `classifyZaiLimits` from here.
 *
 * The return shape is structurally compatible with the `planQuota` field on
 * provider.ts's `ProviderQuota` (a subset: ZAI never reports purchased
 * credits, only the 5h/weekly windows + web searches), so it can be returned
 * directly from `fetchZaiPlanQuota`.
 */

/** A single quota window in ZAI's /quota/limit response. */
export interface ZaiQuotaLimit {
	type?: string;
	unit?: number;
	number?: number;
	usage?: number;
	currentValue?: number;
	remaining?: number;
	percentage?: number;
	nextResetTime?: number;
}

/** Provider-native plan quota fragment produced from a ZAI limits array. */
export interface ZaiPlanQuota {
	plan: string;
	session5h?: { usedPct: number; resetMs: number };
	weekly?: { usedPct: number; resetMs: number };
	webSearches?: { used: number; limit: number; resetMs: number };
}

/**
 * Classify a ZAI /quota/limit `limits[]` into the planQuota shape.
 *
 * PURE function (no network). Detection strategy (robust across ZAI plan
 * tiers and regions):
 *   1. Prefer the documented exact identifiers verified on the "max" plan:
 *      session 5h = (unit 3, number 5), weekly 7d = (unit 6, number 1).
 *   2. Fall back to positional pairing: ZAI only ever reports these two
 *      token windows, so the window that is NOT the session is the weekly.
 *      This keeps weekly resolving when other plans/regions encode the window
 *      with different unit/number values — the production bug where only the
 *      5h bar appeared for non-"max" accounts.
 *   3. When neither exact code matches, assign by reset-window length: the
 *      shorter countdown maps to the 5h session, the longer to weekly.
 */
export function classifyZaiLimits(
	limits: ZaiQuotaLimit[],
	level: string,
): ZaiPlanQuota | undefined {
	const tokLimits = limits.filter((l) => l.type === "TOKENS_LIMIT");
	const web = limits.find((l) => l.type === "TIME_LIMIT");

	// 1. Documented exact identifiers (verified on the "max" plan).
	const byCode = (unit: number, num: number): ZaiQuotaLimit | undefined =>
		tokLimits.find((l) => l.unit === unit && l.number === num);
	let session = byCode(3, 5);
	let weekly = byCode(6, 1);

	// 2/3. Positional-pairing fallback for plans whose window codes differ.
	if (tokLimits.length >= 2 && (!session || !weekly)) {
		const known = new Set<ZaiQuotaLimit>();
		if (session) known.add(session);
		if (weekly) known.add(weekly);
		const remaining = tokLimits.filter((l) => !known.has(l));
		if (!session && !weekly) {
			// Neither code matched: sooner reset = 5h session, later = weekly.
			const sorted = [...remaining].sort(
				(a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0),
			);
			session = sorted[0];
			weekly = sorted[sorted.length - 1];
		} else if (!weekly && remaining.length > 0) {
			weekly = remaining[0];
		} else if (!session && remaining.length > 0) {
			session = remaining[0];
		}
	}

	if (!session && !weekly && !web) return undefined;

	return {
		plan: level ?? "",
		session5h:
			session?.percentage != null && session.nextResetTime != null
				? { usedPct: session.percentage, resetMs: session.nextResetTime }
				: undefined,
		weekly:
			weekly?.percentage != null && weekly.nextResetTime != null
				? { usedPct: weekly.percentage, resetMs: weekly.nextResetTime }
				: undefined,
		webSearches:
			web && web.usage != null && web.remaining != null
				? {
						used: web.currentValue ?? 0,
						limit: web.usage,
						resetMs: web.nextResetTime ?? 0,
					}
				: undefined,
	};
}
