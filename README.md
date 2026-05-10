# pi-recap

**Session at a glance.** An always-visible recap panel for [pi coding agent](https://github.com/earendil-works/pi-coding-agent) that shows your session goal and the last few turns above the editor — no scrolling back to remember what you were doing.

![pi-recap screenshot](_tmp/screenshot.png)

## Features

- **Auto-derived session goal** — the title updates automatically after the first turn using a fast LLM
- **Turn history** — last 4 recaps with timestamps, speaker tags (`you` / `pi`), and fade-to-dim for older entries
- **Live streaming** — breathing dot while thinking, caret blink during token arrival, 180ms settle animation on completion
- **Keyboard navigation** — `Ctrl+Shift+R` to focus, `↑↓` to scroll older entries, `Esc` to release
- **Slash commands** — `/goal` to override the title, `/recap-model` to pick the summarization model, `/recap-blacklist` to manage the model skip-list
- **Theme-agnostic text colors** — recap headline and body use hardcoded high-contrast colors that work on any theme (light or dark)
- **Cheap summarization** — auto-selects the fastest/cheapest available model (flash/mini/haiku/turbo) to keep costs near zero

## Installation

Pi auto-discovers extensions from `~/.pi/agent/extensions/`. Clone the repo there:

```bash
git clone https://github.com/fornace/pi-recap.git ~/.pi/agent/extensions/pi-recap
```

Restart pi. The recap panel appears above the editor on your next session.

## Usage

The panel is passive — it just shows the last few turns. No configuration needed.

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Focus the recap panel |
| `↑` / `↓` | Navigate older entries (while focused) |
| `Esc` | Release focus |

### Slash commands

| Command | Description |
|---|---|
| `/goal <text>` | Override the session title |
| `/goal clear` | Remove override, return to auto-derivation |
| `/recap-model` | List available fast models and select one |
| `/recap-model clear` | Remove model override |
| `/recap-blacklist add <id> [reason]` | Skip a model from the picker chain |
| `/recap-blacklist remove <id>` | Re-enable a model |
| `/recap-blacklist list` | Show current blacklist |
| `/recap-blacklist reset` | Clear the blacklist entirely |
| `/recap-blacklist seed` | Re-populate with known-bad defaults |

## Architecture

```
pi-recap/
├── index.ts           # Extension entry point (hooks, slash commands, state management)
├── state/
│   ├── state.ts       # HistoryEntry type, speaker enum
│   ├── store.ts       # In-memory state + persistence (session branch entries)
│   ├── replay.ts      # Restore state from session entries on restart
│   └── blacklist.ts   # Persistent model skip-list
├── subagent/
│   ├── recap.ts       # User & agent recap generation (streams from cheap model)
│   ├── goal.ts        # Session goal derivation (streams from cheap model)
│   └── picker.ts      # Model selection chain: override → cache → curated → discovery → ctx.model
├── ui/
│   ├── status-widget.ts  # TUI component (rendered above editor)
│   └── anim.ts        # Animation primitives (streaming dot, settle sweep, color utilities)
└── util/
    ├── date.ts        # Timestamp formatting ("now", "14m", "14:30")
    └── log.ts         # Best-effort debug logging
```

### Model picker chain

The summarization model is selected through a 5-layer chain (top wins):

1. **User override** — set via `/recap-model <id>`
2. **Cached winner** — 24h TTL from last successful run
3. **Curated chain** — hand-picked fast/cheap models (gemini-2.5-flash, gpt-4.1-mini, etc.)
4. **Discovery** — regex-scan of available models, sorted by cost
5. **ctx.model** — pi's configured model (sacred fallback, never blacklisted)

## Development

```bash
cd ~/.pi/agent/extensions/pi-recap
npm install        # types + typescript
npx tsc            # type-check (no emit, jiti loads .ts directly)
```

Pi loads `.ts` files via jiti — no build step needed during development.

### Testing

```bash
npx tsx test-recap.ts            # test recap/goal generation with mock registry
npx tsx test-recap-models.ts     # test model picker chain against real registry
```

## License

MIT
