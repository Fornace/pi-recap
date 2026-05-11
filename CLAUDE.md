# pi-recap project notes

## Architecture
- `pi-recap` is a pi extension that provides AI-powered conversation recaps
- State persistence is dual: per-branch via `pi.appendEntry("recap", ...)` and global via `~/.pi/agent/extensions/pi-recap/state/config.json`
- The StatusWidget renders in the terminal via pi-tui; it's reused across sessions (`??=` in `session_start`)

## pi-ai model ID format mismatch (CRITICAL)
The pi-ai registry uses **provider-prefixed IDs** like `anthropic.claude-haiku-4-5-20251001-v1:0`.
The bench CSV and CURATED_CHAIN use **bare handles** like `claude-haiku-4.5`.
The picker (`subagent/picker.ts`) does `byId.get(id)` — exact match fails silently.

**Resolution strategy** (in `resolveModelId()` and picker fallback):
1. Exact match first
2. Normalize dots to dashes (`claude-haiku-4.5` → `claude-haiku-4-5`)
3. Suffix match against registry IDs (`anthropic.claude-haiku-4-5`)

Applied in:
- Bench handler (index.ts): resolves before saving modelOverride
- Picker Layer 1 (user override): fallback resolution for existing bare handles
- Picker Layer 3 (curated chain): fallback resolution so curated chain actually works

## Widget rendering pause pattern
To prevent the StatusWidget animation timer from painting over custom UI overlays:
- `pauseRendering()` before showing overlay (atomically sets flag, clears benchLines, stops timers, forces redraw)
- `resumeRendering()` after overlay is dismissed (only clears flag, no eager update())
- **Never** call `setBenchProgress(undefined)` immediately before `pauseRendering()` — it triggers a premature `update()` that races with the overlay

## Global config persistence
- `state/config.ts` stores global model override in `~/.pi/agent/extensions/pi-recap/state/config.json`
- Loaded on `session_start` if per-branch replay has no modelOverride
- Saved whenever user picks a model from bench or `/recap` menu
- `fireSessionStartNotice` must fire AFTER global override commit (reads state, needs fresh modelOverride)

## Known issues (latent)
- **Blacklist ID format mismatch**: blacklist stores bare handles (`gemini-1.5-flash`), but cached winners are now saved as registry IDs (`anthropic.claude-haiku-4-5-20251001-v1:0`). `isBlacklisted(cachedWinner.id)` in picker Layer 2 will never match. Low priority — seed blacklist only contains retired Gemini models, not cached winners. Fix by normalizing IDs in `isBlacklisted()`.

## Conventions
- Never put AI as coauthor/author in commits, package manifests, or READMEs
- Less code is better — prefer deleting 50 lines and adding 10 over adding 30 on top
