<div align="center">

# 🧾 pi-ledger

**Billing engine for the serverless agency — a [pi](https://github.com/earendil-works/pi-coding-agent) extension that meters agentic dev work like cloud compute and invoices it like a timesheet.**

_Per-invocation · duration-based · scale-to-zero idle. A pomodoro human-time wizard, and an invoice-grade receipt._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

pi-ledger is the billing engine for the **serverless agency** — a dev shop that
runs on on-demand agents and bills the way serverless compute is billed:
**per-invocation, duration-based, scale-to-zero idle**.

| Serverless compute     | pi-ledger                                             |
| ---------------------- | ----------------------------------------------------- |
| On-demand function     | The agent — each turn is an invocation                |
| Execution duration     | Per-turn agent time (generation − stalls + tool time) |
| Scale-to-zero idle     | Human idle costs nothing by default                   |
| Provisioned capacity   | Opt-in pomodoro extensions (billed human oversight)   |
| Usage report / invoice | `/ledger-receipt` — an invoice-grade HTML receipt     |

The agent is the on-demand function; each turn is an invocation billed by
duration, with stalls excluded (a slow or queued provider is a retry, not
billable time). Human oversight — review, steering, the next prompt — is
metered separately, like managed capacity, with a free grace tier and opt-in
pomodoro extensions. Idle costs nothing by default: only the first grace minute
of human time is billable, and a wizard pops immediately at `agent_end`
(inline, pi-core settings style) to offer pomodoro-style blocks.
`/ledger-receipt` then emits the invoice — the cloud-provider usage report, for
your own work.

> **Standalone, but pi-tps-aware.** pi-ledger works on its own — it measures
> agent time itself when [`@monotykamary/pi-tps`](https://github.com/monotykamary/pi-tps)
> isn't installed. When pi-tps **is** present, it emits the `tps:telemetry` event
> after every turn and pi-ledger consumes its refined generation/stall numbers
> (and adds tool-execution time of its own). pi-tps writes `tps` markers to the
> session JSONL; pi-ledger keeps its own event log in a per-session sidecar.
> Installing pi-tps is purely an upgrade in fidelity.

## Quick start

```bash
pi install github:inloopstudio-team/pi-ledger
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
human time estimated from inter-turn gaps plus the trailing idle up to now,
capped at the grace budget) but enough to demo the output.

## Commands

| Command              | What it does                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ledger`            | Show running totals: agent/human hours, costs, total.                                                                                       |
| `/ledger-settings`   | Bordered, searchable settings TUI (rates, grace, pomodoro, project, author, currency, auto-wizard).                                         |
| `/ledger-extend [m]` | Open the human-time wizard to extend the window by `m` minutes (default: pomodoro length); confirm or stop in the dialog. Works while idle. |
| `/ledger-receipt`    | Export a self-contained HTML receipt for the session and open it.                                                                           |

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
- **Immediately at `agent_end`**, a **wizard** pops inline (the same pi-core
  settings style as `/ledger-settings`, so the status bar stays visible):
  _Extend +pomodoro?_ — `Enter` adds a block and re-arms at the next boundary;
  `Esc`/dismiss (or ignoring it) caps billing at the grace minute.
- `/ledger-extend [m]` opens the wizard manually (any time the window is
  open) offering to extend by `m` minutes — confirm in the dialog, or stop.
- The status bar and receipt total the **entire session up to now** — they
  include the in-progress open human window's idle (capped at its granted
  budget) and, for a pi-tps-only session, the trailing idle after the last
  marker. Unlike pi-tps (per-turn), this is the full session so far.

Because billing is `min(actual_idle, budget)`, the 8 seconds you spend
_deciding_ in the wizard are correctly unbilled if you decline.

## Settings

`/ledger-settings` opens a pi-core-style bordered, searchable list. Rate and
text fields open an inline input on `Enter`; currency and the auto-wizard
toggle cycle through presets. Settings persist to the per-session sidecar (see [Data model](#data-model))
and rehydrate on resume and `/tree` navigation.

| Setting          | Default  | Notes                                                   |
| ---------------- | -------- | ------------------------------------------------------- |
| Agent rate       | `60`     | $/hour billed for agent work                            |
| Human rate       | `60`     | $/hour billed for human work                            |
| Grace minutes    | `1`      | Idle minutes billed by default if the wizard is ignored |
| Pomodoro minutes | `20`     | Minutes added per extension                             |
| Project          | _(cwd)_  | Shown on the receipt; falls back to the cwd name        |
| Author           | _(user)_ | Shown on the receipt; falls back to your OS user        |
| Currency         | `USD`    | Symbol for amounts                                      |
| Auto-wizard      | `on`     | Auto-popup immediately at `agent_end`                   |

## Receipt

`/ledger-receipt` writes a self-contained HTML file to
`~/.cache/pi-ledger/receipt-<session>-<timestamp>.html` and opens it.

- **White background, white receipt** card with a hairline border and a whisper shadow.
- **Geist Mono** throughout.
- Values **stream in autoregressively** — each field types out character-by-character
  like an LLM token stream, with a blinking cursor tracking the active field.
- Shows billable **agent** and **human** hours, per-category costs, and the
  **total** — plus project, author, session, and date range.

The HTML is fully self-contained (inline CSS + JS, Geist Mono via Google Fonts)
and prints cleanly to PDF (`⌘P`) — the cursor hides for print.

## Data model

pi-ledger keeps a **per-session sidecar event log** at
`~/.cache/pi-ledger/sessions/<sessionId>.jsonl` — the source of truth, outside
the session JSONL so it survives **compaction** (which discards old custom
entries) and accumulates across **all branches** of the session. Events:

- `settings` — a settings snapshot (last one wins on replay).
- `agent` — one per turn: `{ id, turnIndex, agentMs, generationMs, stallMs, toolMs, tokens, model, source, supersedes?, timestamp }`. A `'tps'` turn may `supersede` an earlier `'fallback'` for the same turn (load-order race) so it isn't double-counted.
- `human-open` — on `agent_end` (and re-recorded on each wizard extend): `{ openedAt, grantedBudgetMs, extensions, timestamp }`.
- `human-close` — on the next `agent_start` **or on `session_shutdown`** (exit): `{ openedAt, closedAt, billedMs, idleMs, grantedBudgetMs, extensions, timestamp }`.

On `session_start` (fresh load/reload), pi-ledger replays the sidecar to rebuild
totals, settings, and the in-progress human window (the last unclosed
`human-open`). `/tree` branching stays in the same session, so the live
in-memory totals are kept as-is (not re-read — never reset to $0). Recording
the exit close means accrued idle is **retained**
across exit/re-enter — not lost — and totals are **global across branches**.

## Architecture

```
turn_start            → reset per-turn tool + fallback accumulators
tool_execution_start  → tool depth counter (union timing)
tool_execution_end    →   (parallel tools don't double-count)
message_start/update/end → fallback generation + stall gate (self-sufficient)
tps:telemetry (pi-tps)→ record 'tps' agent segment = (gen − stall) + tool
                        └ corrects a 'fallback' already written this turn

turn_end (no pi-tps)  → record 'fallback' agent segment from own measurement
agent_end             → open human window (grace budget), pop wizard immediately
                        └ extend → +pomodoro, re-arm at the next boundary
                            └ dismiss/ignore → cap at the grace minute
agent_start           → close window: billed = min(idle, budget)
session_shutdown      → close any open window (record the exit: idle is retained)
```

Agent timing prefers pi-tps's `tps:telemetry` (`generationMs`, `stallMs`);
when pi-tps is absent, pi-ledger measures generation + a basic stall gap gate
itself at `turn_end`. Tool-execution time is always measured locally and paired
with the turn. The wizard is driven entirely by the extension (the agent is
unaware), auto-fires immediately at `agent_end`, and is disarmed on the next
`agent_start` or `session_shutdown`. State is **stateless**: everything is
rebuilt from the per-session sidecar on `session_start` (fresh load/reload);
`/tree` keeps the live in-memory totals (branching stays in the same session,
so the status never resets to $0). A `'tps'`
agent event `supersedes` the `'fallback'` it replaces, so the same turn isn't
double-counted. The status and receipt compute the whole session up to the
current moment, including the in-progress open human window, from the sidecar
— so they survive compaction and branching.

## Testing

```bash
pnpm install
pnpm test            # vitest run (50 tests)
pnpm run typecheck   # tsc --noEmit
pnpm run lint:dead   # knip
```

## License

MIT
