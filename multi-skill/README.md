# pi-multi-skill

Load multiple skills at once in [pi](https://github.com/earendil-works/pi-mono) via the `/skills` command.

## Why?

Pi's built-in `/skill:name` only loads one skill at a time. When you need multiple skills working together (e.g. `frontend-design` + `motion-design` + `test-driven-development`), you'd have to invoke them one by one. This extension lets you chain them in a single command.

## Usage

```
/skills frontend-design,motion-design Create an animated landing page
/skills test-driven-development,systematic-debugging Fix the failing tests
/skills                              → show help + list available skills
```

- **Comma-separated** skill names after `/skills`
- **Optional instructions** after the skill list (passed to the agent alongside the skill content)
- **Autocomplete** — typing `/skills ` shows all available skills with descriptions, and selecting one appends it with a comma for chaining

### Legacy formats (also supported)

```
/skills:frontend-design,motion-design [args]   (colon + comma)
/skill:frontend-design+motion-design [args]    (colon + plus)
```

## Install

Use **`pi install`**, not plain `npm install`. Pi registers packages in `settings.json` under `"packages"` and loads extensions from the `pi.extensions` manifest.

```bash
pi install npm:@zaganjade/pi-multi-skill
```

Then run `/reload` in pi (or restart the CLI). The `/skills` command should appear in slash autocomplete.

Quick test without persisting to settings:

```bash
pi -e npm:@zaganjade/pi-multi-skill
```

From GitHub (monorepo):

```bash
pi install git:github.com/ZaganJade/pi-extension
```

From a local path:

```bash
pi install ./multi-skill
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `/skills` not in autocomplete | Run `pi install npm:@zaganjade/pi-multi-skill`, then `/reload` |
| Installed with `npm install -g` but pi ignores it | Use `pi install npm:@zaganjade/pi-multi-skill` instead |
| Added `npm:...` to `"extensions"` in settings | Wrong key — use `"packages"`, or run `pi install` |
| Command shows as `/skills:2` | Two copies loaded (local path + npm). Remove the duplicate from `extensions` or `packages` |
| Extension listed but disabled | Run `pi config` and enable the extension resource |

Verify install:

```bash
pi list
# should show: npm:@zaganjade/pi-multi-skill
```

## How it works

The extension discovers all available skills via `pi.getCommands()` (covers user-level, project-level, and package-installed skills), reads each selected skill's `SKILL.md`, strips frontmatter, wraps it in `<skill>` blocks, and sends the combined content as a user message to trigger agent processing.

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — registers `/skills` command, autocomplete, and input handler |
