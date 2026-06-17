<div align="center">

# 🛰️ Pi Extensions

### Supercharge your [pi](https://github.com/earendil-works/pi-mono) coding agent with a Claude Code-style usage panel and multi-skill loader.

[![npm](https://img.shields.io/npm/v/@zaganjade/pi-usage?label=pi-usage&color=cb3837)](https://www.npmjs.com/package/@zaganjade/pi-usage)
[![npm](https://img.shields.io/npm/v/@zaganjade/pi-multi-skill?label=pi-multi-skill&color=cb3837)](https://www.npmjs.com/package/@zaganjade/pi-multi-skill)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi-package](https://img.shields.io/badge/keyword-pi--package-blue)](https://pi.dev/packages)

**Two production-ready extensions** — zero-config, auto-discovered by pi, no build step.

</div>

---

## 📦 What's inside

| Extension | npm | Description |
|-----------|-----|-------------|
| **📊 pi-usage** | [`@zaganjade/pi-usage`](https://www.npmjs.com/package/@zaganjade/pi-usage) | Claude Code-style `/usage` panel — live 5H/weekly quota bars, cost & token breakdowns by model/skill/plugin/tool/project, upstream provider quota for ZAI & OpenAI Codex |
| **⚡ pi-multi-skill** | [`@zaganjade/pi-multi-skill`](https://www.npmjs.com/package/@zaganjade/pi-multi-skill) | Load multiple skills at once via `/skills` — comma-separated, with autocomplete & inline instructions |

---

## 📊 pi-usage

A real-time usage dashboard for pi. Mirrors the look and feel of Claude Code's `/usage` screen — but works with **any provider** (ZAI, OpenAI Codex, OpenRouter, Anthropic, custom routers, and more).

### What you see

```
┌─ Usage ──────────────────────────────────────────── 5H │ DAY │ WEEK │ ALL ─┐

  Showing: last 24 hours                   last activity 2m ago · 254 sessions

  5-hour quota     ████░░░░░░░░░░░ 12% used / 145.9M · 88% left · resets 4h 58m
  Weekly quota     ██████░░░░░░░░░ 55% used / 176.7M · 45% left · resets 11h 49m
  live from provider  max plan · upstream quota
  Web searches  0/4000

  ↑51.8M  ↓3.7M  ⚡97.7M  $0.201   ·  855 turns

  Active provider
  zai / glm-5.2  api.z.ai  key ✓

  Top consumer
  100% of usage came from model gpt-5.5

  Plugin usage
  frontend-design          12% ██░░░░░░ 720k  frontend-design
  bmad                     12% ██░░░░░░ 720k  bmad-master, analyst
  pi-subagents              7% █░░░░░░░ 450k  subagent
  (core / no plugin)       59% ██████░░ 3.6M  builtin tools only

  Models                          %        tokens
  glm-5.2                      73% ███████████████ 81.2M
  glm-5.1                      11% ██░░░░░░░░░░░░░ 12.1M
```

### Key features

- **📊 Live upstream quota** — fetches real 5H/weekly used/remaining % directly from ZAI (`/api/monitor/usage/quota/limit`) and OpenAI Codex (`/backend-api/wham/usage` via pi's AuthStorage). No token management — uses the **same credentials pi authenticates with**.
- **⏱️ Real-time rate-limit windows** — captures `x-ratelimit-*` / `x-codex-*` / `anthropic-ratelimit-*` headers from every provider HTTP response via the `after_provider_response` event. Shows tokens/min, requests/min, with live reset countdowns.
- **🔍 Full attribution breakdown** — which **models**, **skills**, **plugins**, **tools**, and **projects** consumed your quota, ranked by usage with mini progress bars.
- **🧩 Plugin usage analysis** — see which plugins drive your usage the most, with per-plugin contributing skills/tools. Includes an honest "(core / no plugin)" remainder for builtin-only turns.
- **💎 Adaptive units** — automatically shows **USD** for priced providers (Anthropic, OpenAI metered) and **tokens** for token-priced providers (ZAI/GLM, custom routers) where cost is always 0.
- **🎨 Combined bar format** — upstream `% used` + session cost/tokens + `% left` + reset countdown, all in one line.
- **📟 Always-on widget** — optional compact spend summary above the editor (`/usage-widget`).
- **⌨️ Fully keyboard-driven** — `5`/`d`/`w`/`a` to switch windows, `j`/`k` to scroll, `r` to refresh, `q` to close.

### Commands

| Command | Description |
|---------|-------------|
| `/usage` | Open the interactive usage panel |
| `/usage-config` | Set 5H/weekly USD & token budgets (for fallback session-derived bars) |
| `/usage-widget` | Toggle compact always-on spend widget above the editor |

### Provider quota support

| Provider | Source | What it shows |
|----------|--------|---------------|
| **ZAI (GLM coding plans)** | `api.z.ai` REST endpoint | 5H + weekly used %, reset countdown, web-search quota, plan tier |
| **OpenAI Codex (ChatGPT Plus/Pro)** | pi's AuthStorage OAuth → `chatgpt.com/backend-api/wham/usage` | 5H + weekly used %, reset countdown, credits balance, plan tier |
| **OpenRouter** | `/api/v1/credits` | Account credits remaining |
| **OpenAI (metered API)** | `/v1/organization/costs` | 5H + 7d spend, monthly hard limit |
| **Any provider** | `after_provider_response` headers | Rate-limit windows with live reset countdown |

> **For subscriptions (ZAI, Codex):** the bars come **directly from the upstream** — no budget config needed. These ARE your plan's real 5h/weekly limits.
>
> **For other providers:** the bars use session-aggregated usage against optional budgets set via `/usage-config`.

---

## ⚡ pi-multi-skill

Load multiple skills in a single command. Pi's built-in `/skill:name` only loads one at a time — this extension lets you chain them with commas.

### Usage

```bash
# Load multiple skills + pass instructions in one go
/skills frontend-design,motion-design Create an animated landing page

# View all available skills with descriptions
/skills
```

### Features

- **🔗 Comma-separated chaining** — `/skills skill1,skill2,skill3 [instructions]`
- **📋 Smart autocomplete** — typing `/skills ` shows all available skills with full descriptions; selecting one appends a comma so you keep chaining
- **🔄 Legacy format support** — `/skills:name1,name2` and `/skill:name1+name2` also work
- **🌐 Universal skill discovery** — finds skills from all sources: user-level, project-level, npm packages, git packages
- **📝 Inline instructions** — anything after the skill list is passed to the agent alongside the skill content

---

## 🚀 Install

### From npm (recommended)

```bash
pi install npm:@zaganjade/pi-usage
pi install npm:@zaganjade/pi-multi-skill
```

### From GitHub

```bash
pi install git:github.com/ZaganJade/pi-extension
```

### From local path

```bash
git clone https://github.com/ZaganJade/pi-extension.git
pi install ./pi-extension/usage
pi install ./pi-extension/multi-skill
```

After installing, run `/reload` in pi (or restart) and the commands are available immediately. **No build step** — pi loads TypeScript directly via jiti.

---

## ⚙️ Configuration (pi-usage)

`~/.pi/agent/usage.json` (auto-created on first `/usage-config`):

```json
{
  "fiveHourLimit": 20,
  "weeklyLimit": 100,
  "fiveHourTokenLimit": 2000000,
  "weeklyTokenLimit": 10000000,
  "showWidget": false,
  "excludeProjects": ["/tmp/throwaway"],
  "maxSessions": 1000
}
```

| Key | Description |
|-----|-------------|
| `fiveHourLimit` / `weeklyLimit` | USD budgets for priced providers (Anthropic, OpenAI metered) |
| `fiveHourTokenLimit` / `weeklyTokenLimit` | Token budgets for token-priced providers (ZAI/GLM, custom routers) |
| `showWidget` | Compact one-line spend summary above the editor |
| `excludeProjects` | Project cwd prefixes to skip during aggregation |
| `maxSessions` | Safety cap on session files to scan |

---

## 🏗️ Architecture

### pi-usage (6 files)

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | ~270 | Entry point — command registration, async scan orchestration, widget |
| `view.ts` | ~780 | Interactive TUI panel (`UsageView`) — quota bars, breakdowns, scrolling |
| `aggregate.ts` | ~380 | Session scanning, time-windowing, attribution engine |
| `provider.ts` | ~740 | Active-provider detection, rate-limit parsing, live quota fetch (ZAI/Codex/OpenRouter/OpenAI) |
| `config.ts` | ~65 | Load/save `usage.json` |
| `format.ts` | ~100 | Token/currency/bar/label formatting helpers |

### pi-multi-skill (1 file)

| File | Lines | Purpose |
|------|-------|---------|
| `index.ts` | ~350 | `/skills` command, autocomplete, input handler for legacy formats |

---

## 📄 License

MIT — see [LICENSE](./usage/LICENSE).

<div align="center">

**Made with ❤️ for the [pi](https://github.com/earendil-works/pi-mono) community**

[Report a bug](https://github.com/ZaganJade/pi-extension/issues) · [Request a feature](https://github.com/ZaganJade/pi-extension/issues) · [npm: @zaganjade](https://www.npmjs.com/~zaganjade)

</div>
