<div align="center">

# 🧾 pi-ledger

**Timesheet maker for [pi](https://github.com/earendil-works/pi-coding-agent) — billed like serverless.**

_Metered agent + human time, a pomodoro human-time wizard, and an exportable receipt._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

pi-ledger turns a pi session into a billable timesheet. Agent work and human
work are metered separately and billed like serverless: **per-invocation,
duration-based, scale-to-zero idle**. The agent is the on-demand function; the
human prompt is the invocation. Idle costs nothing by default — only the first
grace minute of human time is billable, and a non-blocking wizard offers
pomodoro-style extensions.

> **Standalone, but pi-tps-aware.** pi-ledger works on its own — it measures
> agent time itself when [`@monotykamary/pi-tps`](https://github.com/monotykamary/pi-tps)
> isn't installed. When pi-tps **is** present, it emits the `tps:telemetry` event
> after every turn and pi-ledger consumes its refined generation/stall numbers
> (and adds tool-execution time of its own). Both extensions' data coexist in
> the session JSONL. Installing pi-tps is purely an upgrade in fidelity.

## Quick start

```bash
pi install npm:@monotykamary/pi-ledger
# optional — better stall detection & per-turn fidelity:
pi install npm:@monotykamary/pi-tps
```

Then in pi: `/ledger-settings` to set your rates, work a session, and
`/ledger-receipt` for the receipt.

### Demo shortcut: receipt from an existing pi-tps session

Didn't run a full pi-ledger session? `/ledger-receipt` also works on a session
that only has pi-tps markers (e.g. resume an older pi-tps session, set rates
with `/ledger-settings`, then `/ledger-receipt`). With no live ledger data it
converts the `tps` entries into the receipt — lower fidelity (no tool time;
human time estimated from inter-turn gaps, capped at the grace budget) but
enough to demo the output.

## Commands

| Command              | What it does                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `/ledger`            | Show running totals: agent/human hours, costs, blended rate, total.                                       |
| `/ledger-settings`   | Bordered, searchable settings TUI (rates, grace, pomodoro, project, author, currency, auto-wizard).       |
| `/ledger-extend [m]` | Extend the current human-time billing window by `m` minutes (default: pomodoro length). Works while idle. |
| `/ledger-receipt`    | Export a self-contained HTML receipt for the session and open it.                                         |

## How time is measured

| Phase     | Bracket                                        | Billed as  |
| --------- | ---------------------------------------------- | ---------- |
| **Agent** | `agent_start` → `agent_end` (sum of turns)     | Agent time |
| **Human** | `agent_end` → next `agent_start` (idle window) | Human time |

**Agent time per turn** = `(generationMs − stallMs) + toolExecutionMs`.

- **Generation** (incl. TTFT) is the model producing tokens — billable.
- **Tool execution** is the agent doing the work (running bash, reading files, …) — billable, measured as the union wall-clock of tool calls within the turn (parallel tools don't double-count).
- **Stalls** (mid-stream inference pauses) are **excluded**. A slow or queued provider must not inflate billable time — that's the abuse vector this rule closes.
- **Source** is either `tps` (high-fidelity, from pi-tps's event) or `fallback`
  (self-measured). Exactly one segment is written per turn regardless of
  extension load order — a `fallback` may be corrected by a later `tps` entry
  for the same turn, and rehydration keeps the last per turn (no double-count).

**Human time** is the idle window between when the agent hands control back
(`agent_end`) and when the user takes it again (`agent_start`), capped by a
granted budget:

```
billed_human = min(actual_idle, granted_budget)
granted_budget = grace_minutes + Σ extensions (each + pomodoro_minutes)
```

- The first **grace minute** (configurable) is always billable.
- At the grace boundary, if still idle, a **non-blocking wizard** pops:
  _Extend +pomodoro?_ — `Enter` adds a block and re-arms for the next boundary;
  `Esc`/dismiss caps billing at the current budget.
- `/ledger-extend [m]` raises the budget manually, any time the window is open.

Because billing is `min(actual_idle, budget)`, the 8 seconds you spend
_deciding_ in the wizard are correctly unbilled if you decline.

## Settings

`/ledger-settings` opens a pi-core-style bordered, searchable list. Rate and
text fields open an inline input on `Enter`; currency and the auto-wizard
toggle cycle through presets. Settings persist as a `ledger-settings` entry in
the session and rehydrate on resume and `/tree` navigation.

| Setting          | Default  | Notes                                            |
| ---------------- | -------- | ------------------------------------------------ |
| Agent rate       | `0`      | $/hour billed for agent work                     |
| Human rate       | `0`      | $/hour billed for human work                     |
| Grace minutes    | `1`      | First N minutes of idle billed before the wizard |
| Pomodoro minutes | `20`     | Minutes added per extension                      |
| Project          | _(cwd)_  | Shown on the receipt; falls back to the cwd name |
| Author           | _(user)_ | Shown on the receipt; falls back to your OS user |
| Currency         | `USD`    | Symbol for amounts                               |
| Auto-wizard      | `on`     | Auto-popup at the end of the grace minute        |

## Receipt

`/ledger-receipt` writes a self-contained HTML file to
`~/.cache/pi-ledger/receipt-<session>-<timestamp>.html` and opens it.

- **White background, white receipt** card with a hairline border and a whisper shadow.
- **Geist Mono** throughout.
- Values **stream in autoregressively** — each field types out character-by-character
  like an LLM token stream, with a blinking cursor tracking the active field.
- Shows billable **agent** and **human** hours, per-category costs, the **blended
  rate** (`total / total_hours`), and the **total** — plus project, author,
  session, and date range.

The HTML is fully self-contained (inline CSS + JS, Geist Mono via Google Fonts)
and prints cleanly to PDF (`⌘P`) — the cursor hides for print.

## Data model

pi-ledger appends custom entries to the session JSONL alongside pi-tps's `tps`
entries:

- `ledger-settings` — the settings snapshot (last write wins on rehydrate).
- `ledger-agent` — one per turn: `{ agentMs, generationMs, stallMs, toolMs, tokens, model, source, turnIndex, timestamp }` (`source` is `'tps'` or `'fallback'`).
- `ledger-human` — one per closed idle window: `{ billedMs, idleMs, grantedBudgetMs, extensions, openedAt, closedAt, timestamp }`.

On `session_start` and `/tree`, pi-ledger replays these entries to rebuild
running totals and restore settings. (An idle window open at reload is not
resumed — billing resumes on the next `agent_end`.)

## Architecture

```
turn_start            → reset per-turn tool + fallback accumulators
tool_execution_start  → tool depth counter (union timing)
tool_execution_end    →   (parallel tools don't double-count)
message_start/update/end → fallback generation + stall gate (self-sufficient)
tps:telemetry (pi-tps)→ record 'tps' agent segment = (gen − stall) + tool
                        └ corrects a 'fallback' already written this turn

turn_end (no pi-tps)  → record 'fallback' agent segment from own measurement
agent_end             → open human window (grace budget), arm wizard timer
                        └ at grace boundary → non-blocking wizard overlay
                            ├ extend → +pomodoro, re-arm
                            └ dismiss → cap at current budget
agent_start           → close window: billed = min(idle, budget)
```

Agent timing prefers pi-tps's `tps:telemetry` (`generationMs`, `stallMs`);
when pi-tps is absent, pi-ledger measures generation + a basic stall gap gate
itself at `turn_end`. Tool-execution time is always measured locally and paired
with the turn. The wizard is driven entirely by the extension (the agent is
unaware), auto-fires at `agent_end + grace`, and is disarmed on the next
`agent_start` or `session_shutdown`. Rehydration dedups `ledger-agent` by
`turnIndex`, keeping the last (so a `fallback` → `tps` correction never
double-counts).

## Testing

```bash
pnpm install
pnpm test            # vitest run (42 tests)
pnpm run typecheck   # tsc --noEmit
pnpm run lint:dead   # knip
```

## License

MIT
