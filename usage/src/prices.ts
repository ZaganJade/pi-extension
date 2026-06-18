/**
 * Bundled default model prices ($/million tokens).
 *
 * pi records `cost = 0` for token-priced / proxied providers it has no pricing
 * for (zai/GLM, 9Router `kr/…` `cx/…`, MiniMax, etc.). These defaults let the
 * panel show an approximate cost out of the box. They are merged under the
 * user's `~/.pi/agent/usage.json` `modelPrices`, so any user entry overrides
 * the matching default. Set your own with `/usage-pricing`.
 *
 * Figures are taken from each provider's official pricing page (June 2026):
 *   - Anthropic   platform.claude.com/docs/en/about-claude/pricing
 *   - OpenAI      developers.openai.com/api/docs/pricing
 *   - Google      ai.google.dev/gemini-api/docs/pricing
 *   - Z.ai (GLM)  docs.z.ai/guides/overview/pricing
 *   - MiniMax     platform.minimax.io/docs/guides/pricing-paygo
 *
 * Keys match a model ID exactly, or by base name (after the last `/`) so an
 * entry like `claude-opus-4.7` also covers `kr/claude-opus-4.7`. Prices change
 * often and subscription/proxy costs differ from list rates — treat these as
 * estimates and override as needed.
 */
import type { ModelPrice } from "./config.ts";

export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
	// Anthropic Claude — Opus tier ($5 / $25, cache hit $0.50, 5m write $6.25).
	"claude-opus-4.8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8-high": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8-max": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-8-thinking-max": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	"claude-opus-4-5-thinking": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	// Anthropic Claude — Sonnet tier ($3 / $15, cache hit $0.30, 5m write $3.75).
	"claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	"claude-4.5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	// OpenAI GPT-5 family (cached input only; no cache-write charge).
	"gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-5.5-review": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
	"gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
	"gpt-5.3-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	"gpt-5.1": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
	// Google Gemini 3.
	"gemini-3.1-pro-preview": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
	"gemini-3.1-pro-high": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
	"gemini-3.1-pro-low": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
	"gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
	// Z.ai GLM (per-token API list rates; subscription cost differs).
	"glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5": { input: 1.0, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
	"glm-5-turbo": { input: 1.2, output: 4.0, cacheRead: 0.24, cacheWrite: 0 },
	"glm-5v-turbo": { input: 1.2, output: 4.0, cacheRead: 0.24, cacheWrite: 0 },
	"glm-4.7": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	"glm-4.6": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	"glm-4.6v": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	"glm-4.5v": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
	// MiniMax M-series.
	"MiniMax-M3": { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
	"MiniMax-M2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
	"MiniMax-M2.7-highspeed": { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 },
};
