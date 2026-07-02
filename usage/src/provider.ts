/**
 * Active-provider detection and live quota fetching.
 *
 * The usage panel surfaces TWO independent signals about your active provider:
 *
 *   1. Live money quota   — fetched from the provider's billing API when it has
 *                           one (OpenRouter credits, OpenAI costs). This is the
 *                           provider's own view of your account.
 *   2. Rate-limit headers — captured from every provider HTTP response via the
 *                           `after_provider_response` event. These are universal
 *                           (Anthropic, OpenAI, OpenRouter, Google, … all return
 *                           them) and reflect the live per-window limits applied
 *                           to your current API key.
 *
 * API keys are resolved with pi's own resolver — `AuthStorage.getApiKey()` —
 * which checks `~/.pi/agent/auth.json` FIRST (api_key via resolveConfigValue,
 * or OAuth with refresh), then env vars, then custom-provider fallback. This
 * matches pi's built-in auth exactly, so keys stored via `/login` or
 * `pi config` (which land in auth.json) resolve correctly, not just env vars.
 */
import { type Api, getEnvApiKey, type Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { classifyZaiLimits, type ZaiQuotaLimit } from "./zai.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Cached AuthStorage — pi's credential store at ~/.pi/agent/auth.json.
 *
 * `AuthStorage.getApiKey()` is the SAME resolver pi uses at request time: it
 * checks auth.json (api_key via `resolveConfigValue`, or OAuth with refresh)
 * before falling back to env vars. Using it here makes key detection match pi's
 * built-in auth exactly — so keys stored via `/login` or `pi config` (which
 * land in auth.json, not the environment) resolve correctly.
 */
let authStore: AuthStorage | null = null;
function getAuthStore(): AuthStorage {
	if (!authStore) {
		authStore = AuthStorage.create();
	}
	return authStore;
}

/**
 * Resolve a provider's API key the way pi does: auth.json first (api_key/OAuth),
 * then env var, then custom-provider fallback. Returns undefined if unconfigured.
 */
export async function resolveApiKey(
	provider: string,
): Promise<string | undefined> {
	if (!provider) return undefined;
	try {
		return await getAuthStore().getApiKey(provider, { includeFallback: true });
	} catch (err) {
		// Resolution failure (e.g. transient OAuth refresh error) → fall back to env.
		console.error(
			`[usage] getApiKey(${provider}) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return getEnvApiKey(provider);
	}
}

/**
 * Sync check: is ANY form of auth configured for this provider?
 * Checks auth.json + env (sync). Used for the provider badge in the panel.
 */
export function hasProviderKey(provider: string): boolean {
	if (!provider) return false;
	try {
		return getAuthStore().hasAuth(provider);
	} catch {
		return !!getEnvApiKey(provider);
	}
}

export interface ActiveProvider {
	provider: string;
	modelId: string;
	baseUrl: string;
	api: string;
	/** True when an API key for this provider is resolvable from the environment. */
	hasKey: boolean;
}

/** Detect the currently active provider/model from the session context. */
export function detectActiveProvider(
	model: Model<Api> | undefined,
): ActiveProvider | null {
	if (!model) return null;
	const provider = model.provider ?? "";
	return {
		provider,
		modelId: model.id ?? "",
		baseUrl: model.baseUrl ?? "",
		api: (model as { api?: string }).api ?? "",
		// Sync auth check: auth.json (the usual home for /login keys) + env.
		hasKey: hasProviderKey(provider),
	};
}

export interface RateLimitWindow {
	/** "requests" | "tokens" | "input-tokens" | "output-tokens" */
	resource: string;
	/** Approximate window label, e.g. "tokens/min". Heuristic per provider tier. */
	window: string;
	limit: number;
	remaining: number;
	/** Epoch ms when the window resets, or 0 if unknown. */
	resetMs: number;
}

export interface ProviderQuota {
	active: ActiveProvider | null;
	fetchedAt: number;
	/** Live account credits (OpenRouter). Undefined when not applicable/available. */
	credits?: { total: number; used: number; remaining: number };
	/** Live provider spend in USD (OpenAI organization/costs API). Best-effort. */
	spend5h?: number;
	spend7d?: number;
	monthlyLimit?: number;
	/**
	 * Provider-native plan quotas (ZAI GLM coding plans, OpenAI Codex subscription):
	 * session (5h) and weekly (7d) windows reported directly by the upstream as a
	 * used percentage with a live reset countdown. These replace the session-derived bars.
	 */
	planQuota?: {
		plan: string;
		session5h?: { usedPct: number; resetMs: number };
		weekly?: { usedPct: number; resetMs: number };
		webSearches?: { used: number; limit: number; resetMs: number };
		/** Purchased credits balance (OpenAI Codex), when reported. */
		credits?: { balance: number; unlimited: boolean };
	};
	/** Rate-limit windows captured from the most recent provider response. */
	rateLimits: RateLimitWindow[];
	/** "live" if a billing API responded, "headers" if only rate-limit headers, "none" otherwise. */
	source: "live" | "headers" | "none";
	/** Human hints (e.g. why live quota is unavailable). */
	notes: string[];
	error?: string;
}

/**
 * Parse provider rate-limit headers into structured windows.
 *
 * Recognizes three conventions and de-dupes by resource:
 *   - Anthropic: `anthropic-ratelimit-{resource}-{limit|remaining|reset}`
 *   - OpenAI:    `x-ratelimit-{limit|remaining|reset}-{resource}`
 *   - Generic:   `x-ratelimit-{limit|remaining|reset}` (older/simpler APIs)
 *
 * Pi lowercases all header keys, so matching is case-insensitive by contract.
 */
export function parseRateLimits(
	headers: Record<string, string>,
	now: number = Date.now(),
): RateLimitWindow[] {
	const windows: RateLimitWindow[] = [];
	const seen = new Set<string>();

	const anthropicRe =
		/^anthropic-ratelimit-(requests|tokens|input-tokens|output-tokens)-(limit|remaining|reset)$/;
	const openaiRe = /^x-ratelimit-(limit|remaining|reset)-(requests|tokens)$/;

	const pushGroup = (
		groups: Map<string, { limit?: number; remaining?: number; reset?: string }>,
		origin: string,
	) => {
		for (const [resource, g] of groups) {
			const key = `${origin}:${resource}`;
			if (seen.has(key)) continue;
			if (g.limit == null && g.remaining == null) continue;
			seen.add(key);
			windows.push({
				resource,
				window: windowLabel(resource),
				limit: g.limit ?? 0,
				remaining: g.remaining ?? 0,
				resetMs: parseReset(g.reset, now),
			});
		}
	};

	const anthropicGroups = new Map<
		string,
		{ limit?: number; remaining?: number; reset?: string }
	>();
	const openaiGroups = new Map<
		string,
		{ limit?: number; remaining?: number; reset?: string }
	>();
	for (const [kRaw, v] of Object.entries(headers)) {
		const k = kRaw.toLowerCase();
		const a = k.match(anthropicRe);
		if (a) {
			const [, resource, field] = a;
			const g = anthropicGroups.get(resource) ?? {};
			applyField(g, field, v);
			anthropicGroups.set(resource, g);
			continue;
		}
		const o = k.match(openaiRe);
		if (o) {
			const [, field, resource] = o;
			const g = openaiGroups.get(resource) ?? {};
			applyField(g, field, v);
			openaiGroups.set(resource, g);
		}
	}
	pushGroup(anthropicGroups, "anthropic");
	pushGroup(openaiGroups, "openai");

	// Generic single-window fallback (no resource distinction).
	const gLimit = headers["x-ratelimit-limit"] ?? headers["ratelimit-limit"];
	const gRemaining =
		headers["x-ratelimit-remaining"] ?? headers["ratelimit-remaining"];
	const gReset = headers["x-ratelimit-reset"] ?? headers["ratelimit-reset"];
	if ((gLimit || gRemaining) && !seen.has("generic")) {
		windows.push({
			resource: "requests",
			window: "window",
			limit: Number(gLimit) || 0,
			remaining: Number(gRemaining) || 0,
			resetMs: parseReset(gReset, now),
		});
	}

	return windows;
}

function applyField(
	g: { limit?: number; remaining?: number; reset?: string },
	field: string,
	value: string,
): void {
	if (field === "limit") g.limit = Number(value);
	else if (field === "remaining") g.remaining = Number(value);
	else g.reset = value;
}

function windowLabel(resource: string): string {
	if (resource.includes("token")) return "tokens/min";
	return "requests/min";
}

/**
 * Parse a reset value into an epoch-ms timestamp.
 *
 * Handles ISO-8601 timestamps ("2024-01-01T12:00:00Z"), OpenAI-style durations
 * ("6m0s", "500ms", "2h"), and bare-seconds integers.
 */
export function parseReset(value: string | undefined, now: number): number {
	if (!value) return 0;
	const s = String(value).trim();
	if (!s) return 0;

	// ISO 8601 / RFC3339 timestamp.
	if (/^\d{4}-\d{2}-\d{2}T/.test(s) || s.endsWith("Z")) {
		const t = Date.parse(s);
		if (!Number.isNaN(t)) return t;
	}

	// Duration: "1d2h3m4s500ms" (any subset, OpenAI style).
	const dm = s.match(
		/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/,
	);
	if (dm && s.match(/\d/)) {
		const days = Number(dm[1] ?? 0);
		const hours = Number(dm[2] ?? 0);
		const mins = Number(dm[3] ?? 0);
		const secs = Number(dm[4] ?? 0);
		const ms = Number(dm[5] ?? 0);
		const totalMs =
			((days * 24 + hours) * 60 + mins) * 60 * 1000 + secs * 1000 + ms;
		if (totalMs > 0) return now + totalMs;
	}

	// Plain number → seconds until reset (some providers).
	if (/^\d+(\.\d+)?$/.test(s)) return now + Number(s) * 1000;

	return 0;
}

/** Normalize a base URL so it ends with exactly `/v1`. Falls back to `<fallback>/v1` when not derivable. */
function ensureV1(baseUrl: string, fallback: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (/\/v\d+$/.test(trimmed)) return trimmed; // already has a version segment
	if (trimmed) return `${trimmed}/v1`;
	return `${fallback}/v1`;
}

/** Fetch OpenRouter account credits. Works with a normal API key. */
async function fetchOpenRouterCredits(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ total: number; used: number; remaining: number } | undefined> {
	const root = ensureV1(baseUrl, "https://openrouter.ai");
	const res = await fetch(`${root}/credits`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!res.ok) throw new Error(`OpenRouter /credits HTTP ${res.status}`);
	const json = (await res.json()) as {
		data?: { total_credits?: number; total_usage?: number };
	};
	const total = json?.data?.total_credits;
	const used = json?.data?.total_usage;
	if (typeof total !== "number" || typeof used !== "number") return undefined;
	return { total, used, remaining: Math.max(0, total - used) };
}

/** Best-effort OpenAI spend for the 5h and 7d windows via the organization/costs API. */
async function fetchOpenAICosts(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<
	{ spend5h: number; spend7d: number; monthlyLimit?: number } | undefined
> {
	const root = ensureV1(baseUrl, "https://api.openai.com");
	const nowS = Math.floor(Date.now() / 1000);
	const start5 = Math.floor((Date.now() - 5 * HOUR) / 1000);
	const start7 = Math.floor((Date.now() - 7 * DAY) / 1000);

	const sumCosts = async (start: number): Promise<number> => {
		const url = `${root}/organization/costs?start_time=${start}&end_time=${nowS}&limit=1`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (!res.ok) throw new Error(`OpenAI /costs HTTP ${res.status}`);
		const json = (await res.json()) as {
			data?: Array<{ results?: Array<{ cost?: { value?: number } }> }>;
		};
		let total = 0;
		for (const bucket of json.data ?? []) {
			for (const r of bucket.results ?? []) total += r.cost?.value ?? 0;
		}
		return total;
	};

	const [spend5h, spend7d] = await Promise.all([
		sumCosts(start5),
		sumCosts(start7),
	]);

	// Monthly hard limit is best-effort; many keys can't read /subscription.
	let monthlyLimit: number | undefined;
	try {
		const subRes = await fetch(`${root}/organization/subscription`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (subRes.ok) {
			const sub = (await subRes.json()) as {
				plan?: { hard_limit_usd?: number };
			};
			const hard = sub?.plan?.hard_limit_usd;
			if (typeof hard === "number") monthlyLimit = hard;
		}
	} catch {
		// Optional; ignore.
	}

	return { spend5h, spend7d, monthlyLimit };
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Shape of ZAI's /api/monitor/usage/quota/limit response. */
interface ZaiQuotaPayload {
	code?: number;
	success?: boolean;
	data?: {
		level?: string;
		limits?: ZaiQuotaLimit[];
	};
}

/**
 * Fetch ZAI (Zhipu / GLM coding plans) native plan quota from the undocumented
 * monitor endpoint used by the subscription UI. Verified schema (2026-06):
 *
 *   GET https://api.z.ai/api/monitor/usage/quota/limit   (intl)
 *   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit   (CN fallback)
 *   Authorization: Bearer <key>
 *
 *   { code:200, success:true, data:{ level:"max", limits:[
 *     { type:"TOKENS_LIMIT", unit:3, number:5, percentage:81, nextResetTime:<ms> },  // 5h session
 *     { type:"TOKENS_LIMIT", unit:6, number:1, percentage:51, nextResetTime:<ms> },  // weekly
 *     { type:"TIME_LIMIT",   unit:5, number:1, usage:4000, currentValue:0, remaining:4000, nextResetTime:<ms>, usageDetails:[...] } // web searches
 *   ]}}
 *
 * ZAI only exposes `percentage` for the token windows (absolute used/remaining
 * are hidden), so we report the upstream percentage + reset countdown.
 */
async function fetchZaiPlanQuota(
	apiKey: string,
	signal?: AbortSignal,
): Promise<NonNullable<ProviderQuota["planQuota"]> | undefined> {
	const endpoints = [
		"https://api.z.ai/api/monitor/usage/quota/limit",
		"https://open.bigmodel.cn/api/monitor/usage/quota/limit",
	];
	const headers = {
		Authorization: `Bearer ${apiKey}`,
		Accept: "application/json",
	};

	let payload: ZaiQuotaPayload | null = null;

	for (const url of endpoints) {
		try {
			const res = await fetch(url, { headers, signal });
			if (res.status === 404) continue; // endpoint not available on this region
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			payload = (await res.json()) as ZaiQuotaPayload;
			break;
		} catch (e) {
			// Try the next endpoint; if this was the last one, rethrow to the caller.
			if (url === endpoints[endpoints.length - 1]) throw e;
		}
	}
	if (!payload?.data?.limits) return undefined;
	return classifyZaiLimits(payload.data.limits, payload.data.level ?? "");
}

/**
 * Parse OpenAI Codex subscription quota from response headers captured via
 * `after_provider_response`. This is the reliable path: the headers come fresh
 * from pi's own authenticated Codex request, so there is no token/refresh
 * management (unlike the `/wham/usage` REST endpoint, whose OAuth token in
 * `~/.codex/auth.json` is frequently stale/rotated).
 *
 * Header families (authoritative: openai/codex rate_limits.rs):
 *   x-codex-primary-used-percent        — 5h rolling window used % (0-100)
 *   x-codex-primary-reset-at            — unix SECONDS of next reset
 *   x-codex-secondary-used-percent      — 7-day rolling window used %
 *   x-codex-secondary-reset-at          — unix SECONDS
 *   x-codex-credits-has-credits / -unlimited / -balance  — purchased credits
 *   x-codex-limit-name                  — plan/limit display name
 *
 * Returns the planQuota shape (shared with ZAI) when any Codex window is present.
 */
export function parseCodexQuota(
	headers: Record<string, string>,
): NonNullable<ProviderQuota["planQuota"]> | undefined {
	const get = (name: string): string | undefined => {
		// Pi lowercases header keys; be defensive about case either way.
		return headers[name] ?? headers[name.toLowerCase()];
	};
	const num = (v: string | undefined): number | undefined => {
		if (v == null || v === "") return undefined;
		const n = Number(v);
		return Number.isFinite(n) ? n : undefined;
	};

	const pctPrimary = num(get("x-codex-primary-used-percent"));
	const pctSecondary = num(get("x-codex-secondary-used-percent"));
	const resetPrimary = num(get("x-codex-primary-reset-at")); // unix seconds
	const resetSecondary = num(get("x-codex-secondary-reset-at"));
	const limitName = get("x-codex-limit-name");

	if (pctPrimary == null && pctSecondary == null) return undefined;

	// Credits (optional).
	let credits: { balance: number; unlimited: boolean } | undefined;
	const hasCredits = get("x-codex-credits-has-credits");
	if (hasCredits != null) {
		const balance = num(get("x-codex-credits-balance")) ?? 0;
		const unlimited =
			get("x-codex-credits-unlimited") === "true" ||
			get("x-codex-credits-unlimited") === "1";
		credits = { balance, unlimited };
	}

	return {
		plan: limitName ?? "codex",
		session5h:
			pctPrimary != null && resetPrimary != null
				? { usedPct: pctPrimary, resetMs: resetPrimary * 1000 }
				: undefined,
		weekly:
			pctSecondary != null && resetSecondary != null
				? { usedPct: pctSecondary, resetMs: resetSecondary * 1000 }
				: undefined,
		credits,
	};
}

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface CodexUsage {
	plan_type?: string;
	rate_limit?: {
		primary_window?: {
			used_percent?: number;
			reset_at?: number;
			limit_window_seconds?: number;
		};
		secondary_window?: {
			used_percent?: number;
			reset_at?: number;
			limit_window_seconds?: number;
		};
	};
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		balance?: number | string;
	};
	rate_limit_reset_credits?: { available_count?: number };
}

/**
 * Fetch OpenAI Codex subscription quota from the REST endpoint
 * (https://chatgpt.com/backend-api/wham/usage). Uses pi's OWN AuthStorage —
 * the SAME credentials pi uses to authenticate with Codex — so the token is
 * always fresh (pi auto-refreshes OAuth). Reading ~/.codex/auth.json (the
 * Codex CLI's file) was wrong: that file is frequently stale/rotated while
 * pi keeps its own copy current.
 *
 * The `x-codex-*` header path is also unreliable: pi's codex provider uses a
 * WebSocket for streaming and does NOT surface response headers to the
 * `after_provider_response` event. The REST endpoint is the only reliable way
 * to get live quota data.
 */
export async function fetchCodexQuota(
	provider = "openai-codex",
	signal?: AbortSignal,
): Promise<
	| { quota: NonNullable<ProviderQuota["planQuota"]>; error?: string }
	| { quota: undefined; error: string }
	| undefined
> {
	// Resolve the access token via pi's AuthStorage (handles OAuth refresh).
	const accessToken = await resolveApiKey(provider);
	if (!accessToken) {
		return {
			quota: undefined,
			error: `No Codex credentials in pi's auth for "${provider}" — run /login to authenticate.`,
		};
	}

	// The /wham/usage endpoint needs the ChatGPT account id. Read it from pi's
	// OAuth credential (stored as `accountId` on the OAuthCredential).
	let accountId: string | undefined;
	try {
		const cred = getAuthStore().get(provider);
		if (cred && cred.type === "oauth") {
			accountId = (cred as { accountId?: string }).accountId;
		}
	} catch {
		// accountId is optional for the REST call; ignore errors.
	}

	// Fetch the quota.
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
	};
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	let json: CodexUsage;
	try {
		const res = await fetch(CODEX_USAGE_URL, { headers, signal });
		if (res.status === 401) {
			return {
				quota: undefined,
				error:
					"Codex token rejected by server — sign in to Codex CLI to refresh credentials.",
			};
		}
		if (!res.ok) {
			return {
				quota: undefined,
				error: `Codex usage HTTP ${res.status}`,
			};
		}
		json = (await res.json()) as CodexUsage;
	} catch (e) {
		return {
			quota: undefined,
			error: `Codex usage fetch failed: ${errMsg(e)}`,
		};
	}

	const rl = json.rate_limit;
	const primary = rl?.primary_window;
	const secondary = rl?.secondary_window;
	const plan: string =
		(rl && (rl as { limit_name?: string }).limit_name) ||
		json.plan_type ||
		"codex";

	return {
		quota: {
			plan,
			session5h:
				primary?.used_percent != null && primary.reset_at != null
					? { usedPct: primary.used_percent, resetMs: primary.reset_at * 1000 }
					: undefined,
			weekly:
				secondary?.used_percent != null && secondary.reset_at != null
					? {
							usedPct: secondary.used_percent,
							resetMs: secondary.reset_at * 1000,
						}
					: undefined,
			credits: json.credits
				? {
						balance: Number(json.credits.balance ?? 0),
						unlimited: json.credits.unlimited ?? false,
					}
				: undefined,
		},
	};
}

/**
 * Build a full provider quota snapshot: merge already-captured rate-limit
 * headers with a fresh live fetch from the provider's billing API (if any).
 *
 * `capturedRateLimits` comes from the `after_provider_response` event in the
 * orchestrator (index.ts), so it reflects the most recent real request made by
 * the active provider.
 */
export async function fetchProviderQuota(
	active: ActiveProvider | null,
	capturedRateLimits: RateLimitWindow[],
	capturedHeaders: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<ProviderQuota> {
	const result: ProviderQuota = {
		active,
		fetchedAt: Date.now(),
		rateLimits: capturedRateLimits,
		source: "none",
		notes: [],
	};

	if (!active) {
		result.error = "No active model";
		return result;
	}

	if (!active.hasKey) {
		result.notes.push(
			`No auth configured for "${active.provider}" — set a key via /login or an env var to enable live quota.`,
		);
	}

	// Resolve the key through pi's full auth chain (auth.json first, then env).
	// OpenAI Codex subscription: quota is fetched from the REST endpoint
	// (https://chatgpt.com/backend-api/wham/usage) using the OAuth token in
	// ~/.codex/auth.json, with auto-refresh via auth.openai.com if expired.
	//
	// Why NOT headers? pi's codex provider uses a WebSocket for streaming and
	// only surfaces the HTTP/SSE response headers to `after_provider_response`.
	// The WebSocket upgrade response (which carries `x-codex-*`) is NOT exposed
	// to extensions, so the header path is unreliable for codex. The REST
	// endpoint is the only reliable way to get live quota data.
	if (!result.planQuota) {
		const lowerKeys = Object.keys(capturedHeaders).map((k) => k.toLowerCase());
		const hasCodexHeaders = lowerKeys.includes("x-codex-primary-used-percent");
		const isCodex =
			active.provider === "openai-codex" ||
			active.provider.startsWith("openai-codex-") ||
			hasCodexHeaders;
		if (isCodex) {
			// Prefer the REST fetch (works proactively, no request needed).
			const rest = await fetchCodexQuota(active.provider, signal);
			if (rest) {
				// Only set planQuota when we actually got real window data. On error
				// (token expired / rejected), rest.quota is undefined so planQuota
				// stays unset and the view falls to the subscription-hint branch,
				// which shows the clear error instead of an empty "codex plan" label.
				if (rest.quota) {
					result.planQuota = rest.quota;
					result.source = "live";
				}
				if (rest.error) result.notes.push(rest.error);
			}
			// Fallback: parse any captured headers (in case the user just made
			// a request and some headers leaked through, or they were captured
			// by pi's WS path in the future).
			const pq = result.planQuota;
			if (pq && !pq.session5h && !pq.weekly) {
				const fromHeaders = parseCodexQuota(capturedHeaders);
				if (fromHeaders) {
					result.planQuota = fromHeaders;
					result.source = result.source === "live" ? "live" : "headers";
				}
			}
		}
	}

	const key = await resolveApiKey(active.provider);

	if (key) {
		try {
			if (active.provider === "openrouter") {
				const credits = await fetchOpenRouterCredits(
					active.baseUrl,
					key,
					signal,
				);
				if (credits) {
					result.credits = credits;
					result.source = "live";
				}
			} else if (active.provider === "openai") {
				const costs = await fetchOpenAICosts(active.baseUrl, key, signal);
				if (costs) {
					result.spend5h = costs.spend5h;
					result.spend7d = costs.spend7d;
					result.monthlyLimit = costs.monthlyLimit;
					result.source = "live";
				}
			} else if (active.provider === "zai") {
				// ZAI GLM coding plans expose a native 5h-session + weekly quota via an
				// undocumented monitor endpoint. This is the authoritative upstream view
				// (used/remaining % with reset countdown) — replaces session-derived bars.
				const planQuota = await fetchZaiPlanQuota(key, signal);
				if (planQuota) {
					result.planQuota = planQuota;
					result.source = "live";
				}
			}
		} catch (e) {
			result.notes.push(`Live quota fetch failed: ${errMsg(e)}`);
		}
	}

	if (result.source === "none" && capturedRateLimits.length > 0)
		result.source = "headers";
	return result;
}
