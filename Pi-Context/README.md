# pi-context

Live context-window tracker for [pi](https://github.com/earendil-works/pi-mono). Shows how much of the active model's context is in use, breaks it down by category (messages, system prompt, tools, skills, MCP, bundles), and supports **cross-model handoff** when you switch providers mid-session.

**Version 0.3.7** — Pack name tab-completion for import/export/handoff; scans global, project, and extension pack dirs.

---

## Install

```bash
pi install npm:@zaganjade/pi-context
/reload
```

Local development:

```bash
pi install ./Pi-Context
/reload
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/context` | Open context panel (compact) — `Tab` expand, `e` export, `i` import, `h` handoff |
| `/context all` | Expanded view with child rows |
| `/context-export [name]` | Save Context Pack to `~/.pi/agent/context-packs/` |
| `/context-import <name>` | Scale + inject pack for current model (tab-complete from pack history) |
| `/context-handoff [name]` | Export pack + prompt to switch model (tab-complete names) |
| `/context-widget` | Toggle always-on context line |
| `/context-config` | Warn threshold + handoff reserve percent |

---

## Cross-model handoff (GLM → GPT)

```
# 1. Brainstorm with GLM
/context-handoff glm-brainstorm

# 2. Switch model in pi (e.g. to GPT)

# 3. Import shared context
/context-import glm-brainstorm
```

Pi-Context injects a native Pi `<skill name="pi-context-handoff" location="…">` block — the same envelope `/skill:name` uses. The TUI shows `[skill] pi-context-handoff` (Ctrl+O to expand) instead of dumping the full handoff. If the target model has a smaller context window, older messages are dropped and omissions are reported.

**Pack discovery:** Tab-complete on `/context-import`, `/context-export`, and `/context-handoff` scans `~/.pi/agent/context-packs/`, `{project}/.pi/context-packs/`, `{project}/context-packs/`, and the extension `context-packs/` folder. Project packs for the current cwd are ranked first.

---

## Categories tracked

| Category | Source |
|----------|--------|
| Messages | Session branch (`estimateTokens`) |
| System prompt | `ctx.getSystemPrompt()` |
| System tools | Active tool schemas |
| Skills | `before_agent_start` system prompt options |
| MCP tools | Active MCP-registered tools |
| MCP (deferred) | Inactive MCP tool schemas |
| Slash commands | Extension commands |
| Memory files | Project context files |
| Custom agents | pi-subagents detection |
| Bundles | `@bundle` from pi-multi-skill activations |
| Free space | `contextWindow - used` |

Total aligns with pi's native `ctx.getContextUsage()` when available. After compaction, total shows `?` until the next model response (same as pi footer).

**Accounting model:** The header total counts only **messages + system prompt + memory files** (non-overlapping). Rows like System tools, Skills, and MCP are an illustrative breakdown of what lives inside the system prompt — they are scaled to fit within that bucket and do **not** add to the header total separately.

---

## Configuration

`~/.pi/agent/context.json` (auto-created):

```json
{
  "showWidget": false,
  "warnPercent": 70,
  "reservePercent": 15,
  "autoSuggestHandoff": true
}
```

---

## License

MIT — see [LICENSE](./LICENSE).
