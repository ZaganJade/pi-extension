# usage

A Claude Code–style `/usage` panel for [pi](https://github.com/earendil-works/pi-mono).

Shows how your spend and tokens are distributed across **models, skills, plugins,
tools, and projects**, bucketed by time window — with always-visible **5-hour**
and **weekly** quota bars. Mirrors the layout and wording of Claude Code's
`/usage` screen.

```
┌─ Usage ─────────────────────────────── 5H │ DAY │ WEEK │ ALL ─┐

  Showing: last 24 hours            last activity 2m ago · 12 sessions

  5-hour quota   ████████░░░░░  $4.23 / $20.00 (21%)
  Weekly quota   ██░░░░░░░░░░░  $12.40 / $100.00 (12%)

  ↑1.24M ↓245k ⚡3.10M $4.23   · 128 turns · 1.69M total tokens

  Top consumer
  42% of usage came from model claude-sonnet-4-5

  Models                          %        cost
    claude-sonnet-4-5          42%  ████░░░░░  $1.78
    gpt-5                       8%  █░░░░░░░░  $0.34
  …
```

## Views

The panel is organized into seven **menu views** (Tokscale-inspired, extended with
Wrapped AI), switchable inside `/usage` and openable directly via shortcuts:

| View | Shows |
|------|-------|
| **Overview** | Quota bars, headline stats, active-provider quota, top consumer, a 30-day trend sparkline, and the top models. |
| **Models** | Detailed model table (↑input ↓output ⚡cache + turns), plus Skills, Plugin usage, Tools, and Projects breakdowns. |
| **Daily** | Per-day rows with an activity bar plus exact cost, tokens, uptime (active span), and the day's top model; topped with all-time totals (uptime / tokens / cost). Sortable by date or usage. |
| **Stats** | GitHub-style contribution graph with month labels, an interactive time-range selector (all / 7d / 30d via `a`/`w`/`m`), and a two-column summary (total, turns, active days, favorite model, current/longest streak, busiest day, peak hour, averages) plus a fun usage comparison. |
| **Hourly** | Time-of-day breakdown (0–23h, all days combined): activity bars, tokens, turns, and top model per hour — spot your peak coding windows. |
| **Agents** | Usage by provider/backend (e.g. `zai`, `openai-codex`, `9Router`): share bars, tokens, project count, and top model per provider. Sortable by usage or name. |
| **Wrapped AI** | Compact year-in-review: headline totals, monthly mini-chart, top models/providers, streaks, peak hour, top project, and a one-line insight. Cycle years with `[` / `]` or `y`. |

## Commands

| Command | Description |
|---------|-------------|
| `/usage` | Open the interactive usage panel (Overview view). |
| `/usage-models` | Open the panel directly on the **Models** view. |
| `/usage-daily` | Open the panel directly on the **Daily** summary view. |
| `/usage-stats` | Open the panel directly on the **Stats** (contribution graph) view. |
| `/usage-hourly` | Open the panel directly on the **Hourly** (time-of-day) view. |
| `/usage-agents` | Open the panel directly on the **Agents** (provider) view. |
| `/usage-wrapped` | Open the panel directly on the **Wrapped AI** year-in-review view. |
| `/usage-config` | Set your 5-hour and weekly USD budgets. |
| `/usage-pricing` | Set a manual per-model price ($/M tokens) so cost shows for token-priced / proxied models pi records as $0. |
| `/usage-widget` | Toggle a compact always-on spend widget above the editor. |

### Keys inside `/usage`

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab`, `←` / `→` | Switch view (Overview ↔ … ↔ Wrapped AI) |
| `1` `2` `3` `4` `5` `6` `7` | Jump to Overview / Models / Daily / Stats / Hourly / Agents / Wrapped |
| `5` / `d` / `w` / `a` | On Overview & Models: switch window (5 hours / day / week / all). On other views, `5` opens **Hourly**. |
| `a` / `w` / `m` | Stats range: all time / last 7 days / last 30 days (Stats view) |
| `c` / `t` / `n` | Models or Agents view: sort by usage (`c`/`t`) or name (`n`) |
| `t` / `c` / `d` | Daily view: sort by tokens / cost / date — press the same key again to flip ascending ↔ descending |
| `[` / `]` / `y` | Wrapped AI: previous / next calendar year |
| `j` `k` / `↑` `↓` | Scroll  •  `space`/`ctrl+d` half-page down, `ctrl+u`/`b` up |
| `g` / `G` | Jump to top / bottom |
| `r` | Force re-scan of sessions |
| `s` | Set budgets (same as `/usage-config`) |
| `q` / `esc` | Close |

## Configuration

`~/.pi/agent/usage.json` (auto-created on first change):

```json
{
  "fiveHourLimit": 20,
  "weeklyLimit": 100,
  "fiveHourTokenLimit": 2000000,
  "weeklyTokenLimit": 10000000,
  "showWidget": false,
  "excludeProjects": ["/tmp/throwaway"],
  "maxSessions": 1000,
  "modelPrices": {
    "claude-opus-4.7": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 },
    "glm-5-turbo": { "input": 0.6, "output": 2.2 }
  }
}
```

- `fiveHourLimit` / `weeklyLimit` — USD budgets for **priced** providers (e.g.
  Anthropic, OpenAI metered). `0`/omitted shows raw spend with no bar.
- `fiveHourTokenLimit` / `weeklyTokenLimit` — token budgets for **token-priced**
  providers (e.g. zai/GLM, where per-token cost is unknown). `0`/omitted shows
  raw token usage with no bar.
- `showWidget` — keep a one-line spend summary above the editor.
- `excludeProjects` — cwd prefixes to skip during aggregation.
- `maxSessions` — safety cap on how many session files to scan.
- `modelPrices` — prices in **USD per 1M tokens** used to compute cost for
  token-priced / proxied models that pi records with `$0` (e.g. zai/GLM, 9Router
  `kr/…`, `cx/…`). The extension **ships with default prices** for common models
  (`src/prices.ts`, taken from official provider pricing pages); your
  `modelPrices` entries **override** those per key. A cost recorded by pi always
  wins; the price table only fills gaps. Keys match the model ID exactly, or by
  **base name** (after the last `/`) so `claude-opus-4.7` covers
  `kr/claude-opus-4.7` and `cx/claude-opus-4.7`. Set entries interactively with
  `/usage-pricing`. Prices are estimates — verify against your provider.

### Adaptive units

The quota bars, headline stats, and breakdown sections automatically switch
**unit** based on the active provider:

- **USD** when the selected window has meaningful $ cost (priced providers).
- **Tokens** when the window's cost is 0 (token-priced providers like zai/GLM,
  where the model has no pricing in pi's registry). For these, tokens are the
  real usage signal — the panel shows e.g. `1.3M / 2M (63%)` against your
  `fiveHourTokenLimit`, and the live per-minute rate-limit headers below give
  the real-time "remaining this window" from the provider.

## Performance

The first scan parses every session file once (can take a few seconds for large
histories). Results are then cached **per session file** to
`~/.pi/agent/usage-cache.json`, keyed by each file's mtime + size. Subsequent
opens — even after restarting pi — only re-parse sessions that actually changed,
so the panel comes up in well under a second instead of re-reading everything.
The cache is rebuilt automatically if you change `modelPrices` (costs are baked
in at parse time). Delete the file to force a full re-scan.

## How it works

Pi records per-turn usage (tokens + cost) on every assistant message across all
session files in `~/.pi/agent/sessions/`. This extension opens each file once,
walks the entries, and attributes every assistant turn to:

- **model** — from `message.model`
- **project** — from the session's working directory
- **skill** — detected via `parseSkillBlock()` on the preceding user message
- **plugins / tools** — from the tool calls in the assistant message, mapped to
  their owning package via `pi.getAllTools()` / `pi.getCommands()`

Like Claude Code, these are **independent characteristics** of your usage, not a
disjoint partition — a single turn can contribute to several buckets, so
percentages need not sum to 100% across categories.

### Active provider quota

Beyond your own session history, the panel also surfaces the **active
provider's** view of your quota. It detects the active provider from `ctx.model`
and shows:

- **OpenAI Codex (subscription, e.g. ChatGPT Plus/Pro via Codex CLI)** — the
  5-hour and weekly rate-limit windows come from the live response headers
  (`x-codex-primary-used-percent`, `x-codex-secondary-used-percent`,
  `x-codex-primary-reset-at`, `x-codex-secondary-reset-at`) that pi captures
  on every Codex request. No extra auth needed — the headers are always
  fresh, straight from pi's own authenticated Codex call. Also shows the
  plan/limit name (`x-codex-limit-name`) and purchased credits balance
  (`x-codex-credits-*`) when present. The `/backend-api/wham/usage` REST
  endpoint is **not** used because its OAuth token in `~/.codex/auth.json` is
  frequently stale/rotated (single-use refresh tokens).
- **ZAI (GLM coding plans)** — the authoritative **5-hour** and **weekly**
  quota is fetched live from ZAI's subscription API
  (`https://api.z.ai/api/monitor/usage/quota/limit`, undocumented but used by
  the ZAI management UI). It reports the upstream used/remaining percentage
  with a live reset countdown — **no budget config needed**, these ARE the
  plan's 5h/weekly limits straight from the source. Also shows web-search
  quota when present. (Two endpoints are tried: `api.z.ai` intl +
  `open.bigmodel.cn` CN.)
- **OpenRouter** — account credits remaining (`/api/v1/credits`).
- **OpenAI** — 5h/7d spend via `/v1/organization/costs` (+ monthly hard limit
  when readable).
- **Other / fallback** — when a provider has no upstream quota API, the bars
  fall back to session-derived usage (USD or tokens) against an optional
  user budget via `/usage-config`.
- **Rate-limit windows** — captured universally from every provider HTTP
  response (Anthropic, OpenAI, OpenRouter, Google, …) via the
  `after_provider_response` event, with live reset countdowns.

API keys are resolved with pi's own resolver (`getEnvApiKey(provider)` from
`@earendil-works/pi-ai`, which mirrors pi's env-var precedence). Providers that
use OAuth (Anthropic subscription, GitHub Copilot) won't resolve here — their
rate-limit headers still work and are shown.

> **Why budgets are user-defined:** pi works with any provider, so it has no
> built-in quota (unlike Claude Code's subscription). Set limits that match your
> plan and the panel tracks progress against them.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point — registers commands (incl. `/usage-models`, `/usage-daily`, `/usage-stats`), orchestrates scan + widget |
| `view.ts` | The interactive TUI panel component (`UsageView`) with Overview / Models / Daily / Stats / Hourly / Agents / Wrapped AI views |
| `aggregate.ts` | Session scanning + windowing + attribution; daily aggregation, contribution graph, and lifetime stats |
| `provider.ts` | Active-provider detection + rate-limit parsing + live quota fetch |
| `config.ts` | Load/save `~/.pi/agent/usage.json` (merges bundled default prices) |
| `cache.ts` | Persistent incremental scan cache (`~/.pi/agent/usage-cache.json`) |
| `prices.ts` | Bundled default model prices ($/M tokens) from official provider pricing pages |
| `format.ts` | Token/currency/bar/label formatting helpers |

## Install

This is an auto-discovered pi extension — it already lives at
`~/.pi/agent/extensions/usage/`. Run `/reload` in pi (or restart) and it's
available. No build step; pi loads TypeScript directly via jiti.
