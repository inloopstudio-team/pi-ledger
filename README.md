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

| Serverless compute     | pi-ledger                                                          |
| ---------------------- | ------------------------------------------------------------------ |
| On-demand function     | The agent — each turn is an invocation                             |
| Execution duration     | Per-turn agent time (generation normalized to ref TPS + tool time) |
| Scale-to-zero idle     | Human idle costs nothing by default                                |
| Provisioned capacity   | Opt-in pomodoro extensions (billed human oversight)                |
| Usage report / invoice | `/ledger-receipt` — an invoice-grade HTML receipt                  |

The agent is the on-demand function; each turn is an invocation billed by
duration, with stalls excluded (a slow or queued provider is a retry, not
billable time). Human oversight — review, steering, the next prompt — is
metered separately, like managed capacity, with a free grace tier and opt-in
pomodoro extensions. Even the time spent writing the first prompt is metered:
an initial window opens on your **first keystroke** and commits when you send
the prompt (it produces agent work), billed under the same grace minute. So
is steering: a steer or queued followUp you compose while the agent runs is
metered by its typing bursts — and only when actually queued/steered to the
agent — under the same cap. Idle costs nothing by default: an idle window
opens only when you **engage** it (first keystroke or extension) after
`agent_end`, and bills only when your next submit produces agent work
(`agent_start`) — so pure idle, or idle you walk away from, bills nothing. The
first grace minute of an engaged window is billable (per-window, never rolls);
beyond that a wizard pops at `agent_end` (inline, pi-core settings style) and
on `/resume` to offer pomodoro-style blocks.
Extensions are **rolling credit** — provisioned pomodoro blocks survive across
agent turns (like provisioned capacity) and are themselves an engagement
signal, so the wizard stays silent while credit remains and only re-pops
when it's exhausted. `/ledger-receipt` then
emits the invoice — the cloud-provider usage report, for your own work.

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

| Command              | What it does                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ledger`            | Show running totals: agent/human hours, costs, total.                                                                                                       |
| `/ledger-settings`   | Bordered, searchable settings TUI (rates, grace, pomodoro, project, author, currency, auto-wizard).                                                         |
| `/ledger-extend [m]` | Open the human-time wizard to extend the window by `m` minutes (default: pomodoro length); confirm or stop in the dialog. Engages a window if none is open. |
| `/ledger-receipt`    | Export a self-contained HTML receipt for the session and open it.                                                                                           |

## How time is measured

| Phase     | Bracket                                                          | Billed as  |
| --------- | ---------------------------------------------------------------- | ---------- |
| **Agent** | `agent_start` → `agent_end` (sum of turns)                       | Agent time |
| **Human** | idle after `agent_end` (engaged → committed at `agent_start`)    | Human time |
| **Human** | first-prompt composition (first keystroke → first `agent_start`) | Human time |
| **Human** | steer/followUp composed during a run (typing bursts, on submit)  | Human time |

> A provider-error turn (`stopReason` `error`) opens **no** human window — its
> retry/queue backoff isn't human idle and isn't billed (see below).

**Agent time** is the billable agent work per turn — generation normalized to a
reference TPS plus real tool-execution time — summed across turns and priced at
the agent rate:

```
agent_ms_per_turn = (output_tokens / reference_tps × 1000) + tool_ms
agent_hours       = Σ agent_ms_per_turn / 3_600_000
agent_cost        = agent_hours × agent_rate_per_hour
```

(`× 1000` carries token-seconds to ms; `3_600_000` ms = 1 hour.)

- **Generation** is billed by **output tokens at a reference TPS** (frontier-model average, default 75), so model speed can't change the bill — a fast model and a slow one producing the same output tokens bill the same, and the faster model no longer punishes the contractor. `referenceTps` is configurable in `/ledger-settings`.
- **Tool execution** is the agent doing the work (running bash, reading files, …) — billable, measured as the union wall-clock of tool calls within the turn (parallel tools don't double-count). It isn't token-bound, so it's billed as real time.
- **Stalls** (mid-stream inference pauses) **drop out automatically** — a stall produces no tokens, so token-normalized billing never counts it (the abuse vector a slow/queued provider could inflate). The real wall-clock `generationMs`/`stallMs` are still recorded on the event for audit.
- **Source** is either `tps` (high-fidelity, from pi-tps's event) or `fallback`
  (self-measured). Exactly one segment is written per turn regardless of
  extension load order — a `fallback` may be corrected by a later `tps` entry
  for the same turn, and rehydration keeps the last per turn (no double-count).

**Human time** is the idle window between when the agent hands control back
(`agent_end`) and when the user takes it again (`agent_start`), capped by a
granted budget. A turn that ends in a **provider error** (`stopReason` `error`)
does **not** open a window — that's a retry/queue in flight (a retry extension
sleeps with backoff then re-prompts, or pi-core compacts an overflow and
retries), not a human handoff, so the backoff wait is never billed as human
time (scale-to-zero: a slow/queued provider is a retry, not billable). The
window reopens at the next non-error `agent_end`. The **first prompt** is
special — nothing precedes it — so an **initial window** opens at
`session_start` and closes at the first
`agent_start`, metering the time you spend composing (or reviewing a resumed
session before your next prompt) under the same cap:

```
billed_human  = min(engaged_idle, granted_budget)   # only when committed at agent_start
granted_budget = grace_minutes + remaining_extension_credit
```

**Steering while the agent runs** is also human time. A thin input-editor
wrapper stages every keystroke during a run; when you submit a steer or queued
followUp (the `input` event's `streamingBehavior`), the composition is billed
as the sum of its **typing bursts** — consecutive keystrokes within a gap
threshold — not the wall-clock from the first keystroke. A single key, or keys
spread minutes apart, bills nothing; only sustained typing that's actually
queued/steered to the agent bills, under the same `grace + credit` cap as any
window. (This closes an earlier gap: only typing _between_ turns was metered,
so composing a steer _during_ a run was unmetered.) Typing never submitted never
reached the agent, so it's discarded — it bills nothing and can't inflate the
post-turn idle window.

**Idle time is engagement-gated and commit-gated.** Between turns an idle
window opens only when you **engage** — the first keystroke you type, or the
first extension (the wizard's extend / `/ledger-extend`, which both grant
capacity and count as engagement). It bills **wall-clock from that onset**
(capturing thinking, not just keystrokes), capped at `grace + credit` — but
only when your next submit produces agent work (`agent_start` commits it). Pure
idle (no keystroke, no extension) opens no window and bills nothing; idle you
walk away from (no submit) is abandoned at `session_shutdown` and bills 0.
Idle with no output is wasted time.

- The first **grace minute** (configurable) of an engaged window is billable —
  per-window, it never rolls. (No engagement → no grace billing at all.)
- The **initial window** opens on your **first keystroke** (not at
  `session_start`) and commits at the first `agent_start`, metering first-prompt
  composition under the same `grace + credit` cap. Review time _before_ the
  first keystroke has no signal and bills nothing — so on `/resume` the wizard
  pops to let you extend (engaging) and bill that review.
- Extensions are **rolling credit**: `remaining_extension_credit` is the
  provisioned pomodoro balance carried across agent turns. Only billed time
  **beyond** grace consumes it; the remainder rolls forward to the next idle
  window (like provisioned capacity).
- **At `agent_end`**, a **wizard** pops inline (the same pi-core settings style
  as `/ledger-settings`, so the status bar stays visible) **only when no
  rolling credit remains** — to prompt engagement (an extension both engages and
  grants capacity). With credit, it stays silent and arms to fire when the
  engaged window's budget is exhausted; the exhaustion pop offers the next
  extension (the `extend + extend + extend` chain).
- `/ledger-extend [m]` opens the wizard manually — with or without an open
  window (no window → extend engages one) — offering to extend by `m` minutes;
  confirm in the dialog, or stop.
- The status bar and receipt total the **entire session up to now** — they
  include the in-progress engaged window's idle (capped at its granted
  budget) and, for a pi-tps-only session, the trailing idle after the last
  marker. Unlike pi-tps (per-turn), this is the full session so far.

Because billing is `min(engaged_idle, budget)` and only commits on an agent
action, the time you spend _deciding_ in the wizard is unbilled if you decline
— and unused extension credit isn't forfeited when you re-engage the agent
after a short idle; it rolls into the next window. But idle you never commit
(walk away, dismiss, quit) bills nothing.

## Settings

`/ledger-settings` opens a pi-core-style bordered, searchable list. Rate and
text fields open an inline input on `Enter`; currency and the auto-wizard
toggle cycle through presets. Settings persist to the per-session sidecar (see [Data model](#data-model))
and rehydrate on resume and `/tree` navigation.

| Setting          | Default  | Notes                                                       |
| ---------------- | -------- | ----------------------------------------------------------- |
| Agent rate       | `60`     | $/hour billed for agent work                                |
| Human rate       | `60`     | $/hour billed for human work                                |
| Grace minutes    | `1`      | Engaged-idle minutes billed by default if not extended      |
| Pomodoro minutes | `20`     | Minutes added per extension                                 |
| Reference TPS    | `75`     | Output tokens/sec to normalize generation to (frontier avg) |
| Project          | _(cwd)_  | Shown on the receipt; falls back to the cwd name            |
| Author           | _(user)_ | Shown on the receipt; falls back to your OS user            |
| Currency         | `USD`    | Symbol for amounts                                          |
| Auto-wizard      | `on`     | Auto-popup at `agent_end` (no credit) and on `/resume`      |

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
- `agent` — one per turn: `{ id, turnIndex, agentMs, generationMs, stallMs, toolMs, tokens, model, source, supersedes?, timestamp }`. `agentMs` is the billable time (generation normalized to the reference TPS + tool time); `generationMs`/`stallMs` are the real wall-clock (audit). A `'tps'` turn may `supersede` an earlier `'fallback'` for the same turn (load-order race) so it isn't double-counted.
- `human-open` — on **engagement** (the first keystroke you type after a turn, or the first extension — both open the window), and re-recorded on each wizard extend: `{ openedAt, engagedVia, grantedBudgetMs, extensions, extensionBudgetMs, timestamp }`. `openedAt` is the engagement onset; `engagedVia` is `"keystroke"` or `"extension"` (audit); `grantedBudgetMs` is the window's cap = `grace + extensionBudgetMs`; `extensionBudgetMs` is the rolling credit carried into the window. No `human-open` is written at `session_start` or `agent_end` — the window is engagement-gated.
- `human-close` — on the next `agent_start` (**committed** = your submit produced agent work) **or on `session_shutdown`** (**abandoned** = you left without submitting): `{ openedAt, closedAt, billedMs, idleMs, keystrokes, committed, grantedBudgetMs, extensions, extensionBudgetMs, timestamp }`. Committed bills `min([onset, agent_start], grace + credit)`; abandoned bills 0 (idle with no output is wasted). `keystrokes` is the composition-density count while the window was open (after held-key collapse; idle bills wall-clock, so it's analytics, not a billing input). `committed` defaults to `true` on legacy events. Its `extensionBudgetMs` is the rolling credit remaining after this window's consumption (carried forward). Legacy events lacking `extensionBudgetMs` are backfilled on replay.
- `steer` — a steer/followUp composed while the agent ran (editor keystrokes → `input` submit): `{ startedAt, submittedAt, durationMs, billedMs, keystrokes, behavior, grantedBudgetMs, extensionBudgetMs, timestamp }`. `billedMs` is `min` of the typing-burst sum and `grace + credit` (not the wall-clock span — `durationMs` is the span, kept for audit); `keystrokes` is the staged count; `behavior` is `"steer"` (mid-stream interrupt) or `"followUp"` (queued). Billed as human time, consuming rolling credit beyond grace (same rule as an idle window).

On `session_start` (fresh load/reload), pi-ledger replays the sidecar to rebuild
totals, settings, and the rolling extension credit. An unclosed window from a
prior session was never committed by an agent action, so it's **abandoned** (a
`human-close` with `committed: false`, billed 0) rather than restored — it
isn't carried forward. No window is opened at `session_start`; the next one
opens on engagement. `/tree` branching stays in the same session, so the live
in-memory totals are kept as-is (not re-read — never reset to $0). Totals are
**global across branches**; idle you commit is retained across exit/re-enter,
idle you abandon is not.

## Architecture

```
session_start         → rehydrate from sidecar (rebuild totals, settings,
                        rolling credit; ABANDON any unclosed prior window —
                        uncommitted idle bills 0, not restored). Open NO
                        window (engagement-gated). On /resume (or /reload) pop
                        the wizard to prompt engagement (bill review via
                        extend); startup/new stay silent. Wrap the input editor
                        (TUI) to stage keystrokes — during a run for a
                        steer/followUp burst, and between turns the FIRST
                        keystroke engages an idle window at its onset.
turn_start            → reset per-turn tool + fallback accumulators
tool_execution_start  → tool depth counter (union timing)
tool_execution_end    →   (parallel tools don't double-count)
message_start/update/end → fallback generation + stall gate (self-sufficient)
tps:telemetry (pi-tps)→ record 'tps' agent segment = (output tokens / ref TPS) + tool
                        └ corrects a 'fallback' already written this turn

turn_end (no pi-tps)  → record 'fallback' agent segment from own measurement
agent_end             → discard any uncommitted in-run typing (a steer never
                        submitted never reached the agent → bills 0). Open NO
                        window (engagement-gated):
                        └ no credit left → pop the wizard (engagement prompt)
                            └ extend → engage + grant a pomodoro, arm at boundary
                            └ dismiss/ignore → no engagement, no window, no bill
                        └ rolling credit > 0 → stay silent (arm at engagement)
                        └ last assistant stopReason "error" → no pop, no window
                          (a retry/queue is in flight: a retry extension's
                          backoff, or pi-core's compaction-retry — not human
                          idle; nothing bills during the retry)
engage (idle)         → first keystroke OR first extension opens the idle
                        window at onset (grace + rolling credit); an extension
                        also grants capacity. Arms the wizard for exhaustion.
agent_start           → COMMIT the engaged window: billed =
                        min([onset, agent_start], grace + credit), committed;
                        consume credit = max(0, billed − grace) (rolls the rest).
                        No engagement → no window → bills nothing.
input (steer/followUp)→ commit staged keystrokes as a `steer` event: billed =
                        the typing-burst sum (not wall-clock), capped at grace +
                        credit; consume credit beyond grace. Interactive sources
                        only; pass-through (never transform the input). An
                        uncommitted buffer is discarded at agent_end — typing
                        never queued/steered bills nothing. Held keys
                        (auto-repeat) collapse, so they can't fake a burst;
                        idle keystrokes are counted (composition density).
session_shutdown      → ABANDON any open window (committed: false, billed 0 —
                        idle with no submit is wasted; nothing retained).
```

Agent timing prefers pi-tps's `tps:telemetry` (`generationMs`, `stallMs`,
`tokens.output`); when pi-tps is absent, pi-ledger measures generation + a basic
stall gap gate itself at `turn_end`. Either way generation is billed by output
tokens at the reference TPS (speed-invariant); the real generation/stall ms are
recorded for audit. Tool-execution time is always measured locally, billed as
real time, and paired with the turn. The wizard is driven entirely by the extension (the agent is
unaware): it auto-pops at `agent_end` only when no rolling pomodoro credit
remains (and on `/resume`, to prompt engagement for review), and is disarmed on
the next `agent_start` or `session_shutdown`. No window opens at `session_start`
or `agent_end` — an idle window opens only on engagement (first keystroke or
extension) and bills only when committed by a submitted prompt at `agent_start`;
abandoned idle (shutdown without a submit) bills 0. The first grace minute of
an engaged window is billable and never rolls; only billed time beyond grace
consumes the rolling extension credit, whose remainder carries forward to the
next idle window. State is **stateless**: everything is
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
pnpm test            # vitest run (111 tests)
pnpm run typecheck   # tsc --noEmit
pnpm run lint:dead   # knip
```

## License

MIT
