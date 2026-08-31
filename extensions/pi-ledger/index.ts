/**
 * pi-ledger — Timesheet maker for pi
 *
 * Bills human + agent time like serverless: metered per-invocation,
 * scale-to-zero idle. Consumes pi-tps's `tps:telemetry` event for
 * per-turn agent timing and tracks tool-execution time itself; meters
 * human idle windows against rolling pomodoro extensions.
 *
 * Agent billable time per turn = normalizedGenerationMs + toolExecutionMs,
 * where normalizedGenerationMs = outputTokens / referenceTps × 1000. Generation
 * is billed by output tokens at a reference TPS (frontier-model average,
 * default 75), so model speed can't change the bill — a fast model and a slow
 * one producing the same tokens bill the same. Stalls drop out automatically
 * (a stall produces no tokens) and the real wall-clock generation/stall ms
 * stay on the event for audit; tool-execution time is billed as-is.
 *
 * Human time = the idle window the human ENGAGES with (first keystroke or
 * extension) after agent_end, committed when their next submit produces agent
 * work (agent_start) — so idle with no engagement, or engagement with no
 * submit, bills nothing (idle with no output is wasted). Capped by a
 * budget (rolling extension credit). On /resume (or /reload) with no credit
 * left, a small RESUME GRACE (default 1m, `resumeGraceMinutes`) is
 * provisioned instead of prompting immediately: transcript re-orientation
 * counts as (committed) human time, and the engagement prompt lands at the
 * grace boundary. A non-blocking wizard prompts engagement (agent_settled
 * with no credit, or that grace boundary) and offers +pomodoro extensions;
 * `/ledger-extend` does the same manually. The wizard asks only at TRUE
 * IDLENESS — prompts never land mid-typing: while genuine keystrokes are
 * recent the no-credit prompt defers until hands leave the keyboard, and an
 * exhaustion boundary hit while typing rolls a block silently (observed
 * presence = engagement). Silence never creates the FIRST credit; only an
 * explicit extend (or the configured resume grace) can. Extensions are
 * ROLLING credit — provisioned pomodoro blocks survive across agent turns,
 * so the wizard stays silent while credit remains and only re-pops when it's
 * exhausted (and the human is idle).
 *
 * Commands: /ledger, /ledger-settings, /ledger-extend [m], /ledger-receipt
 *
 * Standalone but pi-tps-aware: works on its own, and uses pi-tps's
 * `tps:telemetry` event for refined per-turn timing when present.
 */

import { execSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEventResult,
  KeybindingsManager,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { CustomEditor, DynamicBorder, getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  matchesKey,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type SettingItem,
  type TUI,
} from '@earendil-works/pi-tui';
import { installNestedAgentTelemetryHarvester } from './nested-agent-telemetry.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Event emitted by @monotykamary/pi-tps after each turn with per-turn telemetry (optional). */
const TPS_TELEMETRY_EVENT = 'tps:telemetry';

// Engagement wizard widget: a docked prompt box above the editor (setWidget)
// instead of a modal popup. The box is rendered in every UI mode — the TUI via
// a themed component, RPC/GUI clients via plain string lines (component
// factories are ignored on the extension_ui wire; only string[] round-trip).
const WIZARD_WIDGET_KEY = 'pi-ledger-wizard';

/** Custom entry type written by @monotykamary/pi-tps into the session JSONL. */
const TPS_CUSTOM_TYPE = 'tps';

/** Custom events emitted by @monotykamary/pi-retry around its retry loop:
 *  'started' (with a retryId) when the loop spins up, 'completed' when it
 *  exits on success, 'cancelled' when it exits on abort/session-change.
 *  pi-ledger subscribes so the engagement wizard does not pop mid-retry —
 *  agent_settled can fire during a pi-retry backoff sleep (before pi-retry has
 *  re-prompted), and popping then would bill the backoff as human time
 *  (violating scale-to-zero: a slow/queued provider is a retry, not billable).
 *  The prompt is deferred until the retry settles. Mirrors localterm's
 *  agent-notify handshake. */
const PI_RETRY_STARTED_EVENT = 'pi-retry:started';
const PI_RETRY_COMPLETED_EVENT = 'pi-retry:completed';
const PI_RETRY_CANCELLED_EVENT = 'pi-retry:cancelled';

/** Minimum gap between streaming updates to count as an inference stall (ms). */
const STALL_THRESHOLD_MS = 500;

/** Max gap (ms) between two keystrokes to stay in the same steering-composition
 *  burst. A steer/followUp is billed by the sum of its typing bursts (active
 *  typing), not the wall-clock from the first keystroke — so a single key, or
 *  keys spread minutes apart, bills nothing; only sustained typing bills. Tune
 *  tighter to make farming a burst harder (at the cost of splitting legitimate
 *  brief pauses), or looser to preserve longer thinking pauses. */
const STEER_GAP_MS = 3000;

/** Max gap (ms) between two identical keystrokes to collapse as auto-repeat
 *  (a held key) when staging a steer burst. A held key fires handleInput rapidly
 *  with the same data; collapsing consecutive identical keys within this
 *  window to one timestamp prevents a sustained burst (zero-length) from being
 *  fabricated by holding a key. Human typing — varied keys, or same-key gaps at
 *  or above this threshold (e.g. deliberate double letters) — is unaffected. */
const AUTO_REPEAT_MS = 50;

/** Presence window (ms) for wizard gating. A genuine (post-held-key-collapse)
 *  keystroke within this window counts as ENGAGED: an exhaustion boundary
 *  reached while engaged rolls a pomodoro block silently instead of popping
 *  mid-typing, and the no-credit engagement prompt defers until the human has
 *  been hands-off for this long. Long enough to cover typing bursts and short
 *  reading pauses; a walk-away is always ≥ this before the pop lands. */
const ENGAGED_ACTIVITY_MS = 90_000;

/** pi-queue-steer(-factory) interop: the queue extension parks rows OUTSIDE
 *  pi-core's native queues, so a session with queued work still ends in a
 *  genuine agent_settled. It publishes its backlog snapshot on this pi.events
 *  channel on every change and mirrors the latest one on globalThis under
 *  __tmustierPiQueueSteerState (synchronous reads, immune to listener
 *  registration order). While it reports undispatched rows the no-credit
 *  wizard holds back at settle, and re-offers when the backlog drains. */
const QUEUE_STEER_STATE_EVENT = 'queue-steer:state';

/** Grace (ms) between a queue-steer drain event and re-offering a suppressed
 *  wizard: a drain that FEEDS a run (dispatch from idle/settle) fires
 *  agent_start within milliseconds (or leaves native follow-ups pending), so
 *  the delay lets the run win instead of popping the prompt into it. */
const QUEUE_STEER_REARM_MS = 1500;

/** The read side of the queue-steer snapshot: every field optional/unknown so
 *  a missing or older publisher degrades to 0 pending. All row states count
 *  (paused, edit-held, blocking control rows) — any parked backlog means the
 *  session has queued work in flight. */
interface QueueSteerSnapshot {
  pending?: unknown;
  paused?: unknown;
  blocked?: unknown;
}

declare global {
  // Written by pi-queue-steer(-factory) on every queue change; survives
  // in-process runtime swaps, so it stays accurate across an extension reload.

  var __tmustierPiQueueSteerState: QueueSteerSnapshot | undefined;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  VND: '₫',
  AUD: 'A$',
  CAD: 'C$',
  SGD: 'S$',
};

const DEFAULT_SETTINGS: LedgerSettings = {
  agentRatePerHour: 60,
  humanRatePerHour: 60,
  pomodoroMinutes: 20,
  referenceTps: 75,
  project: '',
  author: '',
  currency: 'USD',
  autoWizard: true,
  autoExtend: false,
  resumeGraceMinutes: 1,
};

// ─── Data types ─────────────────────────────────────────────────────────────

export interface LedgerSettings {
  agentRatePerHour: number;
  humanRatePerHour: number;
  pomodoroMinutes: number;
  /** Output tokens/sec generation is normalized to (frontier-model average ≈ 75).
   *  Higher → less normalized time → a lower bill for fast models. */
  referenceTps: number;
  project: string;
  author: string;
  currency: string;
  autoWizard: boolean;
  /** When `autoWizard` would prompt, auto-provision a pomodoro block silently
   *  instead (no dialog) — for headless/GUI sessions where a prompt can't be
   *  shown or a hands-off "bill my review time" policy is wanted. Bills only
   *  idle that's committed by a later submit, capped at the block (scale-to-zero
   *  with provisioned capacity), so walking away never over-bills. */
  autoExtend: boolean;
  /** Billable human-time block (minutes) provisioned on /resume (and /reload)
   *  when no rolling credit remains — transcript re-orientation counts,
   *  committed by the next submit like any idle window; the engagement prompt
   *  lands at the grace boundary instead of popping at the resume moment.
   *  0 disables (prompt on resume, as before). */
  resumeGraceMinutes: number;
}

/** Persisted per agent turn (replayed on rehydrate). */
/** A billable agent turn, appended to the sidecar event log. A 'tps' event may
 *  `supersede` an earlier 'fallback' event for the same turn (extension load
 *  order) so the turn isn't double-counted on replay. */
export interface AgentEvent {
  kind: 'agent';
  id: string;
  turnIndex: number;
  /** Billable agent time: generation normalized to the reference TPS + tool
   *  time (what's summed into totals and billed). */
  agentMs: number;
  /** Real wall-clock generation (TTFT + streaming), kept for audit. */
  generationMs: number;
  /** Real mid-stream stall time, kept for audit (excluded from billing). */
  stallMs: number;
  /** Real tool-execution time (billed as-is). */
  toolMs: number;
  tokens: { input: number; output: number; total: number };
  model: { provider: string; modelId: string };
  source: 'tps' | 'fallback';
  supersedes?: string;
  timestamp: number;
}

/** Opens (and re-records, on each wizard extend) a human idle window.
 *  `extensionBudgetMs` is the rolling billable-human-time budget carried INTO
 *  this window (provisioned pomodoro credit that survives across agent turns);
 *  `grantedBudgetMs` is this window's billing cap = `extensionBudgetMs` (rolling credit). */
export interface HumanOpenEvent {
  kind: 'human-open';
  openedAt: number;
  grantedBudgetMs: number;
  extensions: number;
  /** How the window engaged: "keystroke" (first key typed), "extension"
   *  (the wizard's extend / `/ledger-extend` — which both grant capacity and
   *  count as engagement), or "grace" (the /resume · /reload re-orientation
   *  grace — standing-config credit, onset = the resume moment). Optional on
   *  legacy events; backfilled to "keystroke" on replay. */
  engagedVia?: 'keystroke' | 'extension' | 'grace';
  /** Remaining rolling extension budget at the time of this event. Optional
   *  on legacy events; backfilled from `grantedBudgetMs` on replay. */
  extensionBudgetMs?: number;
  timestamp: number;
}

/** Closes a human idle window (at the next agent_start, or at session exit).
 *  `extensionBudgetMs` is the rolling budget REMAINING after this window's
 *  consumption — the credit carried forward to the next idle window. */
export interface HumanCloseEvent {
  kind: 'human-close';
  openedAt: number;
  closedAt: number;
  billedMs: number;
  idleMs: number;
  grantedBudgetMs: number;
  extensions: number;
  /** Keystrokes the human typed while the window was open (analytics — idle
   *  bills wall-clock from onset, so the count isn't load-bearing for the bill;
   *  it records composition density, after held-key collapse). Optional on
   *  legacy events. */
  keystrokes?: number;
  /** Whether the window's idle was committed by an agent action (a submitted
   *  prompt at `agent_start`). `false` = abandoned (the session ended with no
   *  submit): idle with no output bills nothing, so `billedMs` is 0. Optional
   *  on legacy events; backfilled to `true` (the old model billed every close). */
  committed?: boolean;
  /** Remaining rolling extension budget after this window's consumption.
   *  Optional on legacy events; backfilled on replay. */
  extensionBudgetMs?: number;
  timestamp: number;
}

/** A steer/followUp the human composed and submitted WHILE the agent was
 *  running (a mid-stream interrupt or a message queued until the agent
 *  finishes). Billed as human time under the same rolling-credit cap as an
 *  idle window. The editor hook stages every keystroke during the run; on
 *  submit the composition becomes PENDING (queued to the agent) and is billed
 *  at DELIVERY — when the queued message enters the conversation (an agent
 *  outcome) — not at submit. So a steer you revert (dequeue) and re-steer
 *  bills once at the delivery that produces agent work, and one you dequeue
 *  and never re-send bills nothing (no outcome). The billed amount is the
 *  active-typing burst sum (not the wall-clock span), so a single key or keys
 *  spread minutes apart bill nothing — only sustained typing that's actually
 *  queued/steered to the agent bills. `submittedAt` is the (re-)submit time;
 *  `timestamp` is the delivery/commit time. */
export interface SteerEvent {
  kind: 'steer';
  /** First staged keystroke during the run. */
  startedAt: number;
  /** Submit time (the `input` event). */
  submittedAt: number;
  /** Wall-clock composition span (submittedAt − startedAt), kept for audit. */
  durationMs: number;
  /** Billed active-typing time = min(burst sum, rolling credit). May
   *  be less than `durationMs` — the burst sum excludes idle gaps before and
   *  between typing. */
  billedMs: number;
  /** Number of staged keystrokes (audit). */
  keystrokes: number;
  /** How the message was delivered: "steer" (mid-stream interrupt) or
   *  "followUp" (queued until the agent finishes). */
  behavior: 'steer' | 'followUp';
  /** The window's billing cap = rolling extension budget at submit. */
  grantedBudgetMs: number;
  /** Remaining rolling extension budget after this steer (carried forward). */
  extensionBudgetMs: number;
  timestamp: number;
}

/** A settings snapshot (rates, project, …). Last one wins on replay. */
export interface SettingsEvent {
  kind: 'settings';
  settings: LedgerSettings;
  timestamp: number;
}

/** A billing-pause toggle (the wizard's "Stop billing" choice). Last one wins
 *  on replay: while paused, interactive prompts/steers to the agent are
 *  blocked (the `input` event returns "handled") until the human extends via
 *  `/ledger-extend`. Slash commands are unaffected — pi-core runs registered
 *  slash commands before emitting the `input` event. */
export interface BillingPauseEvent {
  kind: 'billing-pause';
  paused: boolean;
  timestamp: number;
}

/** The session seal (notarization): one signed close over the hash-chain head,
 *  appended at session_shutdown — and as a checkpoint (`checkpoint: true`) when
 *  /ledger-receipt renders a still-open session. `head` deliberately duplicates
 *  `prev` (both are the digest of the previous event) so the seal verifies
 *  without re-walking the chain; `headSig` is the base64 Ed25519 signature over
 *  `"pi-ledger-seal:v1:<sessionId>:<head>"` (UTF-8), made by the key `kid`
 *  identifies. Replay ignores this kind (tolerant by kind). */
export interface SessionCloseEvent {
  kind: 'session-close';
  sessionId: string;
  head: string;
  headSig: string;
  kid: string;
  checkpoint?: boolean;
  timestamp: number;
}

/** Hash-chain fields stamped on every event of a notarized sidecar: `seq` is
 *  the 0-based position in the session's log and `prev` the 64-hex sha256 of
 *  the previous event exactly as written (its digest includes its own seq/prev);
 *  the genesis event uses 64 zeros. Absent on legacy (pre-notarization) logs —
 *  a log whose tail lacks chain fields stays uniformly unchained: new appends
 *  omit them, and no seal is written. */
export interface ChainFields {
  seq?: number;
  prev?: string;
}

/** The sidecar event log: per-session, append-only, survives compaction. */
export type SidecarEvent =
  | (SettingsEvent & ChainFields)
  | (BillingPauseEvent & ChainFields)
  | (AgentEvent & ChainFields)
  | (HumanOpenEvent & ChainFields)
  | (HumanCloseEvent & ChainFields)
  | (SteerEvent & ChainFields)
  | (SessionCloseEvent & ChainFields);

/** Notarization status of a session's sidecar (consumed by /ledger, the
 *  receipt, and — for delivered logs — by app.inloop.studio's parser). */
export type ChainStatus =
  /** chain intact, close signature verifies against the signing key */
  | 'sealed'
  /** chain intact, no final close event yet (session still running) */
  | 'open'
  /** events lack seq/prev (pre-notarization sessions) */
  | 'legacy'
  /** any seq/prev mismatch, duplicate seq, or signature failure */
  | 'tampered';

/** Result of verifying a sidecar's hash chain (+ final seal signature). */
export interface ChainVerification {
  status: ChainStatus;
  /** seq of the last chained event (-1 = none / legacy). */
  lastSeq: number;
  /** Digest of the chain tip (the last event); genesis zeros when empty/legacy. */
  head: string;
  /** The final (last, non-checkpoint) session-close, if any. */
  lastClose: (SessionCloseEvent & ChainFields) | null;
  /** Whether lastClose's signature verified (absent when there is no close). */
  sigValid?: boolean;
}

/** The slice of pi-tps's `tps:telemetry` payload that we read. */
interface TpsTelemetry {
  model: { provider: string; modelId: string };
  tokens: { input: number; output: number; total: number };
  timing: { generationMs: number; stallMs: number };
  timestamp: number;
}

interface Totals {
  agentMs: number;
  humanMs: number;
  agentTurns: number;
  humanWindows: number;
  agentTokens: { input: number; output: number; total: number };
  // Agent breakdown for the itemized receipt: billed generation
  // (token-normalized) and billed tool time split out so the invoice shows
  // compute vs. I/O (both @ agentRate); stallMs is the UNbilled wall-clock.
  agentGenMs: number;
  agentToolMs: number;
  stallMs: number;
  toolTurns: number;
  stalledTurns: number;
  // Human breakdown (all billable @ humanRate): committed idle (review/think)
  // vs. steering vs. queuing (followUp), each with its own count + keystroke
  // total; abandonedWindows/abandonedMs is the UNbilled walk-away span.
  humanIdleMs: number;
  humanSteerMs: number;
  humanQueueMs: number;
  idleWindows: number;
  steerCount: number;
  queueCount: number;
  idleKeystrokes: number;
  steerKeystrokes: number;
  queueKeystrokes: number;
  abandonedWindows: number;
  abandonedMs: number;
  // Extension (provisioned capacity) breakdown: blocks granted, total credit
  // granted (ms), and credit consumed (billed against it). Remaining =
  // granted − consumed (the live rolling budget).
  extensionsGranted: number;
  extensionCreditMs: number;
  extensionConsumedMs: number;
}

export interface Billing {
  agentHours: number;
  humanHours: number;
  agentCost: number;
  humanCost: number;
  total: number;
  totalHours: number;
}

/** The notarization audit block shown in the receipt footer: the full session
 *  id (the seal signature message binds it), the signing key id, the signed
 *  chain head, the seal signature, and the verification status — the block a
 *  client can independently re-verify. */
export interface ReceiptSeal {
  status: ChainStatus;
  sessionId: string;
  kid?: string;
  head?: string;
  signature?: string;
}

export interface ReceiptData {
  project: string;
  author: string;
  sessionId: string;
  currency: string;
  agentRate: number;
  humanRate: number;
  agentHours: number;
  humanHours: number;
  agentCost: number;
  humanCost: number;
  total: number;
  agentTurns: number;
  humanWindows: number;
  agentTokens: { input: number; output: number; total: number };
  startedAt: number;
  generatedAt: number;
  // Itemized sub-totals for the grouped invoice. All optional: when absent
  // (e.g. a legacy/test ReceiptData) the builder falls back to the bundled
  // hours so the group still itemizes as a single line at its hourly rate.
  // The billable sub-items sum to their group total; stallMs/abandonedMs are
  // the UNbilled audit spans shown as $0 lines.
  agentGenMs?: number;
  agentToolMs?: number;
  stallMs?: number;
  toolTurns?: number;
  stalledTurns?: number;
  humanIdleMs?: number;
  humanSteerMs?: number;
  humanQueueMs?: number;
  idleWindows?: number;
  steerCount?: number;
  queueCount?: number;
  idleKeystrokes?: number;
  steerKeystrokes?: number;
  queueKeystrokes?: number;
  abandonedWindows?: number;
  abandonedMs?: number;
  extensionsGranted?: number;
  extensionCreditMs?: number;
  extensionConsumedMs?: number;
  // Notarization audit block (absent only for hand-built/test ReceiptData).
  seal?: ReceiptSeal;
}

// ─── Pure helpers (exported for testing) ────────────────────────────────────

/** Billable agent time: generation normalized to a reference TPS, plus real
 *  tool-execution time.
 *
 *  Generation is billed as `outputTokens / referenceTps` seconds — a fast model
 *  and a slow one producing the same output tokens bill the same, so model
 *  speed can't change the bill. Stalls drop out automatically (a stall produces
 *  no tokens); the real wall-clock generation/stall ms stay on the event for
 *  audit. Tool time is billed as-is (it isn't token-bound). */
export function computeAgentMs(outputTokens: number, toolMs: number, referenceTps: number): number {
  const refTps = referenceTps > 0 ? referenceTps : 0;
  const standardGenMs = refTps > 0 ? Math.round((Math.max(0, outputTokens) / refTps) * 1000) : 0;
  return standardGenMs + Math.max(0, toolMs);
}

/** Close an idle window: billed = min(actual idle, granted budget). */
export function closeWindowBudget(
  openedAt: number,
  closedAt: number,
  grantedBudgetMs: number
): { idleMs: number; billedMs: number } {
  const idleMs = Math.max(0, closedAt - openedAt);
  const billedMs = Math.min(idleMs, Math.max(0, grantedBudgetMs));
  return { idleMs, billedMs };
}

/** Sum of typing-burst durations from keystroke timestamps. Consecutive
 *  keystrokes within `gapMs` cluster into a burst; a burst's duration is its
 *  last keystroke minus its first (a single keystroke is a zero-length burst).
 *  Pressing isolated keys therefore bills nothing; only sustained typing
 *  bills. Timestamps must be ascending (the editor hook pushes them in order).
 *  Pure. */
export function computeBurstMs(timestamps: number[], gapMs: number): number {
  if (timestamps.length === 0) return 0;
  let sum = 0;
  let burstStart = timestamps[0]!;
  let last = timestamps[0]!;
  for (let i = 1; i < timestamps.length; i++) {
    const t = timestamps[i]!;
    if (t - last > gapMs) {
      sum += last - burstStart;
      burstStart = t;
    }
    last = t;
  }
  sum += last - burstStart;
  return Math.max(0, sum);
}

/** How much of the rolling extension budget a closing window consumes.
 *
 *  Idle bills against rolling extension credit only: all
 *  billed time eats into the credit, capped at what was provisioned. Pure. */
export function consumeExtensionBudget(billedMs: number, extensionBudgetMs: number): number {
  return Math.min(Math.max(0, billedMs), Math.max(0, extensionBudgetMs));
}

/** Resolve the rolling extension budget recorded on a human event, with a
 *  backfill for legacy sidecar entries that predate the field. Pure.
 *  @internal Exported for testing only. */
export function resolveExtensionBudget(e: HumanOpenEvent | HumanCloseEvent): number {
  if (typeof e.extensionBudgetMs === 'number') return e.extensionBudgetMs;
  if (e.kind === 'human-open') return Math.max(0, e.grantedBudgetMs);
  // human-close legacy backfill: remaining = cap − billed (credit left after use)
  return Math.max(0, e.grantedBudgetMs - e.billedMs);
}

export function computeBilling(
  agentMs: number,
  humanMs: number,
  settings: LedgerSettings
): Billing {
  const agentHours = agentMs / MS_PER_HOUR;
  const humanHours = humanMs / MS_PER_HOUR;
  const agentCost = agentHours * settings.agentRatePerHour;
  const humanCost = humanHours * settings.humanRatePerHour;
  const total = agentCost + humanCost;
  const totalHours = agentHours + humanHours;
  return { agentHours, humanHours, agentCost, humanCost, total, totalHours };
}

export function fmtHours(ms: number): string {
  return `${(ms / MS_PER_HOUR).toFixed(2)}h`;
}

export function fmtMoney(amount: number, currency: string): string {
  const sym = CURRENCY_SYMBOL[currency] ?? '';
  return `${sym}${amount.toFixed(2)}`;
}

function fmtRate(rate: number): string {
  return rate === Math.round(rate) ? `${rate}` : `${rate.toFixed(2)}`;
}

function fmtTps(n: number): string {
  return n === Math.round(n) ? `${n}` : `${n.toFixed(1)}`;
}

function parseNumber(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseMinutes(args: string): number | null {
  const tok = args.trim().split(/\s+/).filter(Boolean)[0];
  if (!tok) return null;
  const n = parseNumber(tok);
  if (n === null || n <= 0) return null;
  return Math.round(n);
}

/**
 * Apply one settings change. Returns a new settings object (pure).
 * @internal Exported for testing only.
 */
export function applySettingValue(
  settings: LedgerSettings,
  id: string,
  value: string
): LedgerSettings {
  const next: LedgerSettings = { ...settings };
  switch (id) {
    case 'agentRatePerHour': {
      const n = parseNumber(value);
      if (n !== null && n >= 0) next.agentRatePerHour = n;
      break;
    }
    case 'humanRatePerHour': {
      const n = parseNumber(value);
      if (n !== null && n >= 0) next.humanRatePerHour = n;
      break;
    }
    case 'pomodoroMinutes': {
      const n = parseNumber(value);
      if (n !== null) next.pomodoroMinutes = Math.max(1, Math.round(n));
      break;
    }
    case 'referenceTps': {
      const n = parseNumber(value);
      if (n !== null && n > 0) next.referenceTps = Math.round(n * 10) / 10;
      break;
    }
    case 'project':
      next.project = value;
      break;
    case 'author':
      next.author = value;
      break;
    case 'currency':
      next.currency = value;
      break;
    case 'autoWizard':
      next.autoWizard = value === 'on';
      break;
    case 'autoExtend':
      next.autoExtend = value === 'on';
      break;
    case 'resumeGraceMinutes': {
      const n = parseNumber(value);
      if (n !== null && n >= 0) next.resumeGraceMinutes = Math.round(n);
      break;
    }
  }
  return next;
}

/**
 * Replay persisted ledger entries into settings + totals. Pure.
 * @internal Exported for testing only.
 */
/** Rebuild settings + totals + the open human window from the sidecar event
 *  log. Pure: the sidecar is the source of truth (stateless); in-memory state
 *  is a cache rebuilt from this. Agent events supersede earlier ones (by id)
 *  so a fallback→tps correction for the same turn isn't double-counted; every
 *  non-superseded event counts, so totals span ALL branches of the session.
 *  @internal Exported for testing only. */
export function rehydrateFromSidecar(events: SidecarEvent[]): {
  settings: LedgerSettings;
  totals: Totals;
  humanWindow: {
    openedAt: number;
    grantedBudgetMs: number;
    extensions: number;
    engagedVia: 'keystroke' | 'extension' | 'grace';
  } | null;
  extensionBudgetMs: number;
  billingPaused: boolean;
} {
  let settings: LedgerSettings | null = null;
  const superseded = new Set<string>();
  for (const e of events) if (e.kind === 'agent' && e.supersedes) superseded.add(e.supersedes);
  let agentMs = 0;
  let agentTurns = 0;
  const agentTokens = { input: 0, output: 0, total: 0 };
  let humanMs = 0;
  let humanWindows = 0;
  // Sub-totals for the itemized receipt (billable at their group rate except
  // stallMs/abandonedMs, the UNbilled audit spans).
  let agentGenMs = 0;
  let agentToolMs = 0;
  let stallMs = 0;
  let toolTurns = 0;
  let stalledTurns = 0;
  let humanIdleMs = 0;
  let humanSteerMs = 0;
  let humanQueueMs = 0;
  let idleWindows = 0;
  let steerCount = 0;
  let queueCount = 0;
  let idleKeystrokes = 0;
  let steerKeystrokes = 0;
  let queueKeystrokes = 0;
  let abandonedWindows = 0;
  let abandonedMs = 0;
  let extensionsGranted = 0;
  let extensionCreditMs = 0;
  let extensionConsumedMs = 0;
  // Rolling billable-human-time budget (provisioned pomodoro credit) carried
  // across agent turns. The last human-open/close event in the log holds the
  // current value: an open window records what was carried in (and extended);
  // a close records what remains after that window's consumption. A rise = a
  // grant (one block), a fall = a consumption (billed against credit). Mirrors
  // the live grant/consume calls exactly, so rehydrate reconstructs the same
  // totals.
  let extensionBudgetMs = 0;
  // Skip-billing guard: last `billing-pause` event wins on replay. While
  // paused, interactive prompts/steers are blocked until the human extends.
  let billingPaused = false;
  const closedOpenedAts = new Set<number>();
  // Apply a recorded rolling-budget value: a rise = a credit grant (one
  // block), a fall = a consumption (billed against credit). Mirrors the live
  // grant/consume calls exactly, so rehydrate reconstructs the same totals.
  function applyBudgetDelta(next: number) {
    if (next > extensionBudgetMs) {
      extensionCreditMs += next - extensionBudgetMs;
      extensionsGranted += 1;
    } else if (next < extensionBudgetMs) {
      extensionConsumedMs += extensionBudgetMs - next;
    }
    extensionBudgetMs = next;
  }
  for (const e of events) {
    if (e.kind === 'settings') {
      settings = { ...DEFAULT_SETTINGS, ...e.settings };
    } else if (e.kind === 'agent') {
      if (superseded.has(e.id)) continue;
      agentMs += e.agentMs;
      agentTurns += 1;
      agentTokens.input += e.tokens.input;
      agentTokens.output += e.tokens.output;
      agentTokens.total += e.tokens.total;
      // Billed agent time = generation (token-normalized) + tool; the event
      // records the bundled `agentMs`, so generation = agentMs − toolMs.
      agentGenMs += e.agentMs - e.toolMs;
      agentToolMs += e.toolMs;
      stallMs += e.stallMs;
      if (e.toolMs > 0) toolTurns += 1;
      if (e.stallMs > 0) stalledTurns += 1;
    } else if (e.kind === 'human-close') {
      closedOpenedAts.add(e.openedAt);
      humanMs += e.billedMs;
      if (e.billedMs > 0) humanWindows += 1; // match live: only billed windows count
      const committed = e.committed ?? true;
      if (committed && e.billedMs > 0) {
        humanIdleMs += e.billedMs;
        idleWindows += 1;
        idleKeystrokes += e.keystrokes ?? 0;
      } else if (!committed) {
        abandonedWindows += 1;
        abandonedMs += e.idleMs;
      }
      applyBudgetDelta(resolveExtensionBudget(e));
    } else if (e.kind === 'human-open') {
      applyBudgetDelta(resolveExtensionBudget(e));
    } else if (e.kind === 'billing-pause') {
      billingPaused = e.paused;
    } else if (e.kind === 'steer') {
      // A steer/followUp composed during a run is human time, billed under the
      // same rolling-credit cap as an idle window. It consumes rolling credit;
      // its `extensionBudgetMs` is the credit remaining after the steer
      // (carried forward, last wins on replay).
      humanMs += e.billedMs;
      humanWindows += 1;
      if (e.billedMs > 0) {
        if (e.behavior === 'steer') {
          humanSteerMs += e.billedMs;
          steerCount += 1;
          steerKeystrokes += e.keystrokes;
        } else {
          humanQueueMs += e.billedMs;
          queueCount += 1;
          queueKeystrokes += e.keystrokes;
        }
      }
      applyBudgetDelta(e.extensionBudgetMs);
    }
  }
  // Last unclosed human-open (by append order) is the in-progress window.
  let humanWindow: {
    openedAt: number;
    grantedBudgetMs: number;
    extensions: number;
    engagedVia: 'keystroke' | 'extension' | 'grace';
  } | null = null;
  for (const e of events) {
    if (e.kind === 'human-open' && !closedOpenedAts.has(e.openedAt)) {
      humanWindow = {
        openedAt: e.openedAt,
        grantedBudgetMs: e.grantedBudgetMs,
        extensions: e.extensions,
        engagedVia: e.engagedVia ?? 'keystroke',
      };
    }
  }
  return {
    settings: settings ?? { ...DEFAULT_SETTINGS },
    totals: {
      agentMs,
      humanMs,
      agentTurns,
      humanWindows,
      agentTokens,
      agentGenMs,
      agentToolMs,
      stallMs,
      toolTurns,
      stalledTurns,
      humanIdleMs,
      humanSteerMs,
      humanQueueMs,
      idleWindows,
      steerCount,
      queueCount,
      idleKeystrokes,
      steerKeystrokes,
      queueKeystrokes,
      abandonedWindows,
      abandonedMs,
      extensionsGranted,
      extensionCreditMs,
      extensionConsumedMs,
    },
    humanWindow,
    extensionBudgetMs,
    billingPaused,
  };
}

/** Path to a session's sidecar event log. Exported for tests to seed the log. */
export function sidecarPathFor(sessionId: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'pi-ledger', 'sessions', `${sessionId}.jsonl`);
}

// ─── Notarization (hash chain + Ed25519 session seal) ───────────────────────

/** `prev` of the genesis event: 64 hex zeros. */
export const GENESIS_PREV = '0'.repeat(64);

/** PKCS#8 DER prefix wrapping a raw 32-byte Ed25519 seed (OneAsymmetricKey
 *  with the id-Ed25519 algorithm OID); the seed bytes follow directly. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep); // arrays keep order
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue; // mirrors JSON.stringify (drops undefined)
      out[k] = sortKeysDeep(v);
    }
    return out;
  }
  return value;
}

/** The canonical form of an event: `JSON.stringify` of a recursively
 *  key-sorted deep copy (arrays keep order, numbers stay JSON numbers — note
 *  `JSON.stringify` prints integral floats as integers, e.g. 1.0 → "1", which
 *  the Ruby verifier replicates — no extra number formatting here). Pure. */
export function canonicalJson(event: unknown): string {
  return JSON.stringify(sortKeysDeep(event));
}

/** `sha256_hex(canonical(event))` — computed over the COMPLETE event object,
 *  including its seq/prev fields (the digest of event N is what event N+1 puts
 *  in `prev`). Pure. */
export function digestEvent(event: unknown): string {
  return createHash('sha256').update(canonicalJson(event), 'utf8').digest('hex');
}

/** The exact message a session seal signs (UTF-8). Frozen by the effort
 *  protocol — app.inloop.studio's verifier reconstructs it byte-for-byte. */
export function sealMessage(sessionId: string, head: string): string {
  return `pi-ledger-seal:v1:${sessionId}:${head}`;
}

/** `kid` = first 8 bytes of sha256(raw public key bytes) as 16 hex chars. Pure. */
export function kidFromPublicKey(rawPublicKey: Buffer): string {
  return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16);
}

/** The local signing identity: `publicKey` is the base64 of the raw 32-byte
 *  Ed25519 public key (registered in app.inloop.studio admin). */
export interface IdentityMaterial {
  kid: string;
  publicKey: string;
  privateKey: KeyObject;
}

/** Rebuild the Ed25519 identity from its 32-byte seed (the JWK `d` field — the
 *  raw public key `x` is re-derived via the PKCS#8 wrapper). Pure. */
export function identityFromSeed(seed: Buffer): IdentityMaterial {
  if (seed.length !== 32) throw new RangeError('Ed25519 seed must be 32 bytes');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = privateKey.export({ format: 'jwk' });
  const rawPublic = Buffer.from(jwk.x as string, 'base64url');
  return { kid: kidFromPublicKey(rawPublic), publicKey: rawPublic.toString('base64'), privateKey };
}

function verifySealSignature(close: SessionCloseEvent, publicKeyRaw: Buffer): boolean {
  try {
    const pub = createPublicKey({
      format: 'jwk',
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyRaw.toString('base64url') },
    });
    return cryptoVerify(
      null,
      Buffer.from(sealMessage(close.sessionId, close.head), 'utf8'),
      pub,
      Buffer.from(close.headSig, 'base64')
    );
  } catch {
    return false;
  }
}

/** Verify a sidecar log's notarization: per-event chain linkage (seq strictly
 *  0-based monotonic, prev == digest of the previous event as written) plus,
 *  when a final (non-checkpoint) session-close exists, its Ed25519 signature.
 *  `key` is the identity expected to have sealed the log; a close whose kid is
 *  unknown (identity lost, or sealed by another meter) is unverifiable and
 *  reports tampered — never silently 'sealed'. Pure. */
export function verifySidecarChain(
  events: SidecarEvent[],
  key?: { kid: string; publicKeyRaw: Buffer } | null
): ChainVerification {
  if (events.length === 0) {
    return { status: 'open', lastSeq: -1, head: GENESIS_PREV, lastClose: null };
  }
  const tip = events[events.length - 1]!;
  if (typeof tip.seq !== 'number' || typeof tip.prev !== 'string') {
    // The tail lacks chain fields → pre-notarization log; by design such a
    // session stays uniformly legacy (new appends never start a chain mid-log).
    return { status: 'legacy', lastSeq: -1, head: GENESIS_PREV, lastClose: null };
  }
  let prev = GENESIS_PREV;
  let seq = 0;
  let lastClose: (SessionCloseEvent & ChainFields) | null = null;
  for (const e of events) {
    // Chained tail but an unchained event inside → insertion / mixed log.
    if (typeof e.seq !== 'number' || typeof e.prev !== 'string') {
      return { status: 'tampered', lastSeq: seq - 1, head: prev, lastClose: null };
    }
    // seq strictly monotonic (gaps = dropped lines, duplicates = inserted
    // lines), each event linking to the previous event's digest (any byte
    // edit or reorder breaks this).
    if (e.seq !== seq || e.prev !== prev) {
      return { status: 'tampered', lastSeq: seq - 1, head: prev, lastClose: null };
    }
    prev = digestEvent(e);
    seq += 1;
    if (e.kind === 'session-close' && !e.checkpoint) lastClose = e;
  }
  if (!lastClose) return { status: 'open', lastSeq: seq - 1, head: prev, lastClose: null };
  const sigValid =
    lastClose.head === lastClose.prev &&
    !!key &&
    key.kid === lastClose.kid &&
    verifySealSignature(lastClose, key.publicKeyRaw);
  return {
    status: sigValid ? 'sealed' : 'tampered',
    lastSeq: seq - 1,
    head: prev,
    lastClose,
    sigValid,
  };
}

/** A pi-tps `tps` entry as it appears in the session JSONL. */
export interface TpsMarker {
  timing: { generationMs: number; stallMs: number; totalMs: number };
  tokens: { input: number; output: number; total: number };
  model: { provider: string; modelId: string };
  timestamp: number;
}

/** Pull pi-tps `tps` entries out of a session entry list. Pure. */
export function extractTpsEntries(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>
): TpsMarker[] {
  const out: TpsMarker[] = [];
  for (const e of entries) {
    if (e.type !== 'custom' || e.customType !== TPS_CUSTOM_TYPE) continue;
    const d = e.data as TpsMarker | null;
    if (d && d.timing && d.tokens && d.model && typeof d.timestamp === 'number') out.push(d);
  }
  return out;
}

/** Convert pi-tps markers into billable agent + (estimated) human time. Pure.
 *
 * Agent time per marker = outputTokens / referenceTps (generation normalized
 * to the reference TPS; tool time is unavailable from pi-tps markers). Human
 * time is NOT estimated from markers: idle bills only against rolling
 * extension credit, and markers carry no credit/commit info,
 * so marker-only sessions bill 0 human time (mirrors scale-to-zero). @internal */
export function convertTpsEntries(
  tps: TpsMarker[],
  referenceTps: number
): {
  agentMs: number;
  agentTurns: number;
  agentTokens: { input: number; output: number; total: number };
  humanMs: number;
  humanWindows: number;
  startedAt: number;
  // Itemized sub-totals. pi-tps markers carry no tool time and can't
  // reconstruct steering/abandonment, so only generation and idle/review are
  // populated; the rest are zero (the receipt still itemizes them as $0).
  agentGenMs: number;
  agentToolMs: number;
  stallMs: number;
  toolTurns: number;
  stalledTurns: number;
  humanIdleMs: number;
  humanSteerMs: number;
  humanQueueMs: number;
  idleWindows: number;
  steerCount: number;
  queueCount: number;
  idleKeystrokes: number;
  steerKeystrokes: number;
  queueKeystrokes: number;
  abandonedWindows: number;
  abandonedMs: number;
  extensionsGranted: number;
  extensionCreditMs: number;
  extensionConsumedMs: number;
} {
  let agentMs = 0;
  const agentTokens = { input: 0, output: 0, total: 0 };
  const humanMs = 0;
  const humanWindows = 0;
  let stallMs = 0;
  let stalledTurns = 0;
  for (const e of tps) {
    agentMs += computeAgentMs(e.tokens.output || 0, 0, referenceTps);
    agentTokens.input += e.tokens.input || 0;
    agentTokens.output += e.tokens.output || 0;
    agentTokens.total += e.tokens.total || 0;
    const sm = e.timing.stallMs || 0;
    stallMs += sm;
    if (sm > 0) stalledTurns += 1;
  }
  return {
    agentMs,
    agentTurns: tps.length,
    agentTokens,
    humanMs,
    humanWindows,
    startedAt: tps.length > 0 ? tps[0]!.timestamp : 0,
    agentGenMs: agentMs, // markers have no tool time → all generation
    agentToolMs: 0,
    stallMs,
    toolTurns: 0,
    stalledTurns,
    humanIdleMs: humanMs, // markers carry no credit/commit info → 0 human
    humanSteerMs: 0,
    humanQueueMs: 0,
    idleWindows: humanWindows,
    steerCount: 0,
    queueCount: 0,
    idleKeystrokes: 0,
    steerKeystrokes: 0,
    queueKeystrokes: 0,
    abandonedWindows: 0,
    abandonedMs: 0,
    extensionsGranted: 0,
    extensionCreditMs: 0,
    extensionConsumedMs: 0,
  };
}

// ─── Receipt HTML ───────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reveal(text: string): string {
  // Empty content — the typewriter fills it in, avoiding a flash of final
  // text when the block unhides. data-reveal carries the final string.
  return ` data-reveal="${esc(text)}">`;
}

/** Pull the 'retryId' out of a @monotykamary/pi-retry event payload, or
 *  'undefined' if it is absent/malformed. Used to match a 'completed'/
 *  'cancelled' event back to its 'started' so pi-ledger only acts on its own
 *  retry. Mirrors localterm's retry-event-id util. Pure.
 *  @internal Exported for testing only. */
export function retryEventId(event: unknown): number | undefined {
  if (typeof event !== 'object' || event === null || !('retryId' in event)) return undefined;
  const id = (event as { retryId?: unknown }).retryId;
  return typeof id === 'number' ? id : undefined;
}

/**
 * Build a self-contained HTML receipt. White-on-white, Geist Mono, with
 * values that stream in autoregressively (char-by-char) on load.
 * @internal Exported for testing only.
 */
export function buildReceiptHtml(d: ReceiptData): string {
  const cur = d.currency;
  const dateLine =
    d.startedAt > 0 && d.startedAt !== d.generatedAt
      ? `${fmtDate(d.startedAt)} → ${fmtDate(d.generatedAt)}`
      : fmtDate(d.generatedAt);

  // Sub-totals with a legacy fallback: when the itemized fields are absent
  // (a hand-built/test ReceiptData) the whole group bills as a single line —
  // generation / review — at its hourly rate, so the invoice still reconciles.
  const hrs = (ms: number) => `${(ms / MS_PER_HOUR).toFixed(2)} h`;
  const money = (n: number) => fmtMoney(n, cur);
  const bill = (ms: number, rate: number) => (ms / MS_PER_HOUR) * rate;
  const agentGenMs = d.agentGenMs ?? d.agentHours * MS_PER_HOUR;
  const agentToolMs = d.agentToolMs ?? 0;
  const stallMs = d.stallMs ?? 0;
  const humanIdleMs = d.humanIdleMs ?? d.humanHours * MS_PER_HOUR;
  const humanSteerMs = d.humanSteerMs ?? 0;
  const humanQueueMs = d.humanQueueMs ?? 0;
  const abandonedMs = d.abandonedMs ?? 0;
  const toolTurns = d.toolTurns ?? 0;
  const stalledTurns = d.stalledTurns ?? 0;
  const idleWindows = d.idleWindows ?? d.humanWindows;
  const steerCount = d.steerCount ?? 0;
  const queueCount = d.queueCount ?? 0;
  const idleKeystrokes = d.idleKeystrokes ?? 0;
  const steerKeystrokes = d.steerKeystrokes ?? 0;
  const queueKeystrokes = d.queueKeystrokes ?? 0;
  const abandonedWindows = d.abandonedWindows ?? 0;
  const extensionsGranted = d.extensionsGranted ?? 0;
  const extensionCreditMs = d.extensionCreditMs ?? 0;
  const extensionConsumedMs = d.extensionConsumedMs ?? 0;
  const remainingMs = extensionCreditMs - extensionConsumedMs;

  const agentSubtotalMs = agentGenMs + agentToolMs;
  const humanSubtotalMs = humanIdleMs + humanSteerMs + humanQueueMs;
  const agentSubtotalCost = bill(agentSubtotalMs, d.agentRate);
  const humanSubtotalCost = bill(humanSubtotalMs, d.humanRate);
  const grandTotal = agentSubtotalCost + humanSubtotalCost;
  const tok = d.agentTokens;

  // Row builders — each is an autoregressively-revealed block.
  const group = (label: string, rate: number) =>
    `<div class="group r-block r-hidden"><span class="label"${reveal(label)}</span><span class="rate"${reveal(`@ ${fmtMoney(rate, cur)}/h`)}</span></div>`;
  const item = (label: string, detail: string, ms: number, rate: number) =>
    `<div class="sub r-block r-hidden"><div class="left"><span class="label"${reveal(label)}</span><span class="detail"${reveal(detail)}</span></div><div class="right"><span class="hrs"${reveal(hrs(ms))}</span><span class="amt"${reveal(money(bill(ms, rate)))}</span></div></div>`;
  const nuance = (label: string, detail: string, ms: number) =>
    `<div class="sub nuance r-block r-hidden"><div class="left"><span class="label"${reveal(label)}</span><span class="detail"${reveal(detail)}</span></div><div class="right"><span class="hrs"${reveal(hrs(ms))}</span><span class="amt"${reveal(money(0))}</span><span class="nb"${reveal('not billed')}</span></div></div>`;
  const subtotalRow = (ms: number, rate: number) =>
    `<div class="subtotal r-block r-hidden"><span class="label"${reveal('Subtotal')}</span><div class="right"><span class="hrs"${reveal(hrs(ms))}</span><span class="amt"${reveal(money(bill(ms, rate)))}</span></div></div>`;

  const rows: string[] = [];
  rows.push(group('Agent', d.agentRate));
  rows.push(
    item(
      'Compute (generation)',
      `${d.agentTurns} turns · ${fmtNumber(tok.total)} tok (${fmtNumber(tok.input)} in / ${fmtNumber(tok.output)} out)`,
      agentGenMs,
      d.agentRate
    )
  );
  if (agentToolMs > 0)
    rows.push(item('Tool execution', `${toolTurns} turns with tools`, agentToolMs, d.agentRate));
  if (stallMs > 0) rows.push(nuance('Stalls', `${stalledTurns} stalled turns`, stallMs));
  rows.push(subtotalRow(agentSubtotalMs, d.agentRate));
  rows.push(group('Human', d.humanRate));
  rows.push(
    item(
      'Review / think',
      `${idleWindows} windows · ${idleKeystrokes} keystrokes`,
      humanIdleMs,
      d.humanRate
    )
  );
  if (humanSteerMs > 0)
    rows.push(
      item(
        'Steering',
        `${steerCount} steers · ${steerKeystrokes} keystrokes`,
        humanSteerMs,
        d.humanRate
      )
    );
  if (humanQueueMs > 0)
    rows.push(
      item(
        'Queuing',
        `${queueCount} queued · ${queueKeystrokes} keystrokes`,
        humanQueueMs,
        d.humanRate
      )
    );
  if (abandonedWindows > 0)
    rows.push(nuance('Idle abandoned', `${abandonedWindows} windows · no submit`, abandonedMs));
  rows.push(subtotalRow(humanSubtotalMs, d.humanRate));
  const rowHtml = rows.map((r) => '    ' + r).join('\n');

  // Context footer: provisioned capacity, then session span, then generated.
  const footer: string[] = [];
  if (extensionsGranted > 0) {
    const min = (ms: number) => Math.round(ms / 60_000);
    footer.push(
      `Extensions: ${extensionsGranted} granted · ${min(extensionCreditMs)}m total · ${min(extensionConsumedMs)}m used · ${min(remainingMs)}m remaining`
    );
  }
  if (d.startedAt > 0) {
    const spanMs = Math.max(0, d.generatedAt - d.startedAt);
    const billedMs = agentSubtotalMs + humanSubtotalMs;
    footer.push(`Session span ${hrs(spanMs)} · billed ${hrs(billedMs)}`);
  }
  footer.push(`generated ${fmtDate(d.generatedAt)} · pi-ledger`);
  // Notarization audit block: session id (full — the seal signature binds it),
  // kid, signed head, signature, and verification status — independently
  // re-verifiable by the client. A tampered log is flagged in-band.
  if (d.seal) {
    footer.push(`seal ${d.seal.status}${d.seal.status === 'tampered' ? ' ⚠ chain broken' : ''}`);
    footer.push(`session ${d.seal.sessionId}`);
    if (d.seal.kid) footer.push(`kid ${d.seal.kid}`);
    if (d.seal.head) footer.push(`head ${d.seal.head}`);
    if (d.seal.signature) footer.push(`sig ${d.seal.signature}`);
  }
  const footerHtml = footer
    .map((f) => `    <div class="foot r-block r-hidden"><span${reveal(f)}</span></div>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pi-ledger receipt · ${esc(d.project)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111; font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace; -webkit-font-smoothing: antialiased; padding: 48px 16px; }
  .receipt { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #ececec; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.03), 0 10px 34px rgba(0,0,0,0.05); padding: 34px 38px 30px; }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
  .tagline { font-size: 11px; color: #9a9a9a; margin-top: 3px; }
  .rule { border: 0; border-top: 1px solid #f0f0f0; margin: 18px 0; }
  .meta .mrow { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; color: #555; }
  .meta .k { color: #9a9a9a; }
  .group { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 0 2px; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; }
  .group .rate { font-size: 11px; color: #9a9a9a; font-weight: 400; letter-spacing: 0; }
  .sub { display: flex; justify-content: space-between; align-items: flex-start; padding: 9px 0 9px 14px; font-size: 13px; }
  .sub + .sub { border-top: 1px dashed #f3f3f3; }
  .sub .left { display: flex; flex-direction: column; }
  .sub .label { font-weight: 500; }
  .sub .detail { font-size: 10px; color: #b8b8b8; font-weight: 400; margin-top: 3px; }
  .sub .right { text-align: right; white-space: nowrap; }
  .sub .hrs { display: block; font-size: 11px; color: #777; }
  .sub .amt { font-weight: 600; }
  .nuance .label, .nuance .hrs, .nuance .amt { color: #c2c2c2; font-weight: 400; }
  .nuance .nb { display: block; font-size: 9px; color: #c8c8c8; font-style: italic; }
  .subtotal { display: flex; justify-content: space-between; align-items: baseline; padding: 10px 0 4px 14px; font-size: 13px; border-top: 1px solid #f0f0f0; }
  .subtotal .label { font-weight: 600; color: #666; letter-spacing: 0.04em; }
  .subtotal .right { text-align: right; white-space: nowrap; }
  .subtotal .hrs { font-size: 11px; color: #777; margin-right: 8px; }
  .subtotal .amt { font-weight: 700; }
  .total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 8px; padding-top: 14px; border-top: 1px solid #ececec; font-size: 17px; }
  .total .amt { font-weight: 700; }
  .foot { margin-top: 22px; font-size: 10px; color: #c2c2c2; text-align: center; overflow-wrap: anywhere; }
  .cursor { display: inline-block; width: 7px; height: 1em; vertical-align: -0.12em; background: #111; margin-left: 2px; animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .r-hidden { display: none !important; }
  .r-block { animation: rFade .15s ease both; }
  @keyframes rFade { from { opacity: 0 } to { opacity: 1 } }
  @media print { .cursor { display: none; } body { padding: 0; } .receipt { box-shadow: none; border-color: #ddd; } .r-block { animation: none; } }
</style>
</head>
<body>
  <div class="receipt">
    <div class="brand r-block r-hidden"><span${reveal('pi-ledger')}</span></div>
    <div class="tagline r-block r-hidden"><span${reveal('billed like serverless')}</span></div>
    <hr class="rule r-block r-hidden" />
    <div class="meta">
      <div class="mrow r-block r-hidden"><span class="k">Project</span><span${reveal(d.project)}</span></div>
      <div class="mrow r-block r-hidden"><span class="k">Author</span><span${reveal(d.author)}</span></div>
      <div class="mrow r-block r-hidden"><span class="k">Session</span><span${reveal(d.sessionId)}</span></div>
      <div class="mrow r-block r-hidden"><span class="k">Date</span><span${reveal(dateLine)}</span></div>
    </div>
    <hr class="rule r-block r-hidden" />
${rowHtml}
    <div class="total r-block r-hidden"><span${reveal('Total')}</span><span class="amt"${reveal(fmtMoney(grandTotal, cur))}</span></div>
${footerHtml}
    <span class="cursor" id="cursor"></span>
  </div>
<script>
(function () {
  // Reveal the receipt block-by-block: each line unhides (card grows), then
  // its values type in autoregressively; the cursor tracks the active value.
  // The cursor is appended INSIDE the active element (after a text node) so it
  // never becomes a flex sibling — that keeps right-aligned values pinned to
  // the right edge instead of reflowing to the middle as they type.
  var TPS = 100;
  var blocks = document.querySelectorAll('.r-block');
  var cursor = document.getElementById('cursor');
  var bi = 0;
  function nextBlock() {
    if (bi >= blocks.length) { if (cursor) cursor.remove(); return; }
    var block = blocks[bi++];
    block.classList.remove('r-hidden');
    var spans = block.querySelectorAll('[data-reveal]');
    if (spans.length === 0) { requestAnimationFrame(nextBlock); return; }
    var si = 0;
    function nextSpan() {
      if (si >= spans.length) { requestAnimationFrame(nextBlock); return; }
      var el = spans[si++];
      var final = el.getAttribute('data-reveal') || '';
      el.textContent = '';
      var tn = document.createTextNode('');
      el.appendChild(tn);
      if (cursor) el.appendChild(cursor);
      var start = null;
      function step(now) {
        if (start === null) start = now;
        var n = Math.floor(((now - start) * TPS) / 1000);
        if (n < final.length) { tn.nodeValue = final.slice(0, n); requestAnimationFrame(step); }
        else { tn.nodeValue = final; requestAnimationFrame(nextSpan); }
      }
      requestAnimationFrame(step);
    }
    nextSpan();
  }
  window.addEventListener('load', function () { requestAnimationFrame(nextBlock); });
})();
</script>
</body>
</html>
`;
}

function fmtNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    const s = v.toFixed(1);
    return (s.endsWith('.0') ? v.toFixed(0) : s) + 'K';
  }
  const v = n / 1_000_000;
  const s = v.toFixed(1);
  return (s.endsWith('.0') ? v.toFixed(0) : s) + 'M';
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function ledgerExtension(pi: ExtensionAPI) {
  installNestedAgentTelemetryHarvester(pi);

  let settings: LedgerSettings = { ...DEFAULT_SETTINGS };

  const totals: Totals = {
    agentMs: 0,
    humanMs: 0,
    agentTurns: 0,
    humanWindows: 0,
    agentTokens: { input: 0, output: 0, total: 0 },
    agentGenMs: 0,
    agentToolMs: 0,
    stallMs: 0,
    toolTurns: 0,
    stalledTurns: 0,
    humanIdleMs: 0,
    humanSteerMs: 0,
    humanQueueMs: 0,
    idleWindows: 0,
    steerCount: 0,
    queueCount: 0,
    idleKeystrokes: 0,
    steerKeystrokes: 0,
    queueKeystrokes: 0,
    abandonedWindows: 0,
    abandonedMs: 0,
    extensionsGranted: 0,
    extensionCreditMs: 0,
    extensionConsumedMs: 0,
  };

  // Per-turn tool-execution accumulator (depth counter → union wall-clock).
  let toolDepth = 0;
  let toolSpanStart = 0;
  let toolMsThisTurn = 0;
  let currentTurnIndex = 0;

  // Current human idle window (null while the agent is working). Its
  // `grantedBudgetMs` is this window's billing cap = the rolling extension
  // budget carried into it.
  let humanWindow: {
    openedAt: number;
    grantedBudgetMs: number;
    extensions: number;
    engagedVia: 'keystroke' | 'extension' | 'grace';
  } | null = null;

  // Rolling billable-human-time budget: provisioned pomodoro credit that
  // survives across agent turns (the serverless "provisioned capacity"
  // analogy). All billed idle/steering time consumes this budget (no free
  // minute); the leftover rolls forward. The wizard is suppressed at
  // `agent_settled` while this is > 0, and re-arms to fire when
  // it's exhausted.
  let extensionBudgetMs = 0;

  // Skip-billing guard: set when the human chooses "Stop billing" in the
  // wizard. While true, the `input` event blocks interactive prompts/steers
  // from reaching the agent (returns "handled") until the human extends via
  // `/ledger-extend`. Slash commands are unaffected (pi-core runs them
  // before emitting `input`). Persisted to the sidecar so the guard survives
  // reload/compaction (the source of truth); rehydrate restores it.
  let billingPaused = false;

  // Whether the agent loop is currently running (between agent_start and
  // agent_end). Steering composition is metered only while this is true — the
  // initial and idle windows already capture typing outside a run.
  let agentRunning = false;
  // Staging buffer of keystroke timestamps during the current run — the raw
  // material for billing a steer/followUp the human composes while the agent
  // works. The editor hook (`noteKeystroke`) pushes to it on every keystroke;
  // the `input` event STAGES it into a pending composition (a submit per burst
  // group) and clears it — billing is committed at DELIVERY (the agent
  // outcome), not at submit. Nothing is billed until a steer/followUp is
  // actually delivered to the agent; an unsubmitted buffer is discarded at
  // agent_end, and a submitted-but-undelivered (e.g. dequeued) composition is
  // abandoned at shutdown, so typing that never reaches the agent costs nothing.
  let steerStaging: number[] = [];

  // Pending steer/followUp compositions: submitted (queued to the agent) but
  // not yet DELIVERED. Committed (billed) at delivery — the `message_start` user
  // message that means the queued composition reached the agent — so a steer
  // you revert (dequeue) and re-steer bills once at the re-steer's delivery, and
  // one you dequeue and never re-send bills nothing (no agent outcome). Each
  // entry holds the typing bursts snapshotted at its submit; dequeue merges
  // them into `dequeuedBuffer` (carried to the next submit). In-memory only —
  // never persisted; on reload a pending is abandoned (bills 0).
  let pendingSteers: {
    bursts: number[];
    behavior: 'steer' | 'followUp';
    submittedAt: number;
  }[] = [];

  // Composition a dequeue put back in the editor (the human reverted a queued
  // steer/followUp). Its typing bursts carry forward to the next submit (the
  // re-steer/re-queue), so reverting then re-steering bills the original
  // composition at the re-steer's delivery. Cleared on the next submit or at
  // shutdown. In-memory only.
  let dequeuedBuffer: number[] | null = null;

  // Held-key collapse for steer burst billing: auto-repeat (a held key) fires
  // handleInput rapidly with the same data. Consecutive identical keystrokes
  // within AUTO_REPEAT_MS collapse to one timestamp (a zero-length burst), so
  // holding a key can't fabricate a sustained typing burst. Human typing —
  // varied keys, or same-key gaps at/above the threshold (deliberate doubles) —
  // is unaffected. Reset at agent_start with the staging buffer.
  let lastKey: string | null = null;
  let lastKeyTime = 0;

  // Idle keystroke count for analytics: every keystroke while an idle window is
  // open (after held-key collapse), recorded on the window's `human-close`.
  // Idle bills wall-clock from onset, so this is composition density, not a
  // billing input. Reset when a window opens/closes and at session_start.
  let idleKeystrokes = 0;

  let wizardTimer: ReturnType<typeof setTimeout> | null = null;
  // The docked wizard widget outlives the timer that opened it. Keep the TUI/RPC
  // prompt single-flight so overlapping lifecycle, retry, and command triggers
  // cannot replace it while it waits for an answer.
  let wizardOpen = false;
  // TUI answer path: the docked box is interactive — the LedgerEditor wrapper
  // consumes ↑/↓/enter/escape while the box shows and moves this selection.
  // RPC answers arrive through the select() dialog instead.
  let wizardSelection = 0;
  // Prompt parameters captured at show time (rendered by the widget and used
  // by the editor's confirm key).
  let wizardPomodoro = 0;
  let wizardRemainingProvisioned = 0;

  // Deferred no-credit engagement prompt: armed at settle/resume, pops only
  // once the human has been hands-off for ENGAGED_ACTIVITY_MS; further typing
  // slides it, agent_start / a granted credit / a new session disarms it (the
  // next settle re-arms). Never grants anything — it can only POP the wizard.
  let consentTimer: ReturnType<typeof setTimeout> | null = null;

  // Presence: the last GENUINE keystroke's timestamp (post held-key collapse,
  // so a held key can't fake presence), spanning idle and in-run typing. Unlike
  // lastKeyTime it is NOT reset per-run — a settle asks "when did the human
  // last act", which includes prompts typed before the run. null = no typing
  // observed this process (RPC/GUI mode never wraps the editor, so it stays
  // null there and prompts fire immediately, as before). Reset at session_start.
  let lastGenuineActivityAt: number | null = null;

  // pi-retry awareness: when @monotykamary/pi-retry is installed it emits
  // pi-retry:started/completed/cancelled around its (possibly multi-attempt)
  // retry loop. agent_settled can fire during a retry's backoff sleep —
  // before pi-retry has decided whether to re-prompt — so without gating the
  // wizard would pop mid-retry (billing the backoff as human time, violating
  // scale-to-zero). We capture the active retryId and DEFER the settled
  // prompt until the retry settles: pop only on 'completed', never on
  // 'cancelled', and never while a retry is in flight. Mirrors localterm's
  // agent-notify handshake.
  let retryActiveId: number | undefined;
  // The run settled (agent_settled fired, no rolling credit) but a retry was
  // in flight, so the engagement prompt is pending until the retry completes.
  // Cleared on pop, on agent_start (a new run supersedes the stale settled
  // state), on retry cancelled, and at session boundaries.
  let pendingSettledWizard: { ctx: ExtensionContext } | null = null;
  // Unsubscribers for the pi-retry event capture (a session-scoped resource);
  // torn down at session_shutdown. The factory re-binds on the next session.
  let retryUnsubs: Array<() => void> = [];

  // pi-queue-steer backlog hold (see QUEUE_STEER_STATE_EVENT): the last
  // events-reported pending count (fallback for the globalThis mirror).
  let queueSteerEventPending: number | null = null;
  // True when a settle (or resume/reload) suppressed the no-credit wizard
  // because queue-steer reported a parked backlog. Re-offered — grace-deferred
  // by QUEUE_STEER_REARM_MS — when the backlog drains without a new run (rows
  // deleted by hand, an unpause that dispatches nothing, a failed dispatch).
  let queueSteerSuppressed = false;
  let queueSteerRearmTimer: ReturnType<typeof setTimeout> | null = null;

  // Latest ctx (event-bus listeners for tps:telemetry don't receive one).
  let lastCtx: ExtensionContext | null = null;

  // pi-tps awareness: when pi-tps is present it emits `tps:telemetry` per turn
  // and we use its refined generation/stall numbers. When it's absent we fall
  // back to our own measurement (basic generation + a stall gap gate) so the
  // extension stands alone.
  let tpsEverSeen = false;
  let lastFallback: {
    id: string;
    turnIndex: number;
    agentMs: number;
    toolMs: number;
    stallMs: number;
    tokens: { input: number; output: number; total: number };
  } | null = null;
  let fallbackNotified = false;

  // Per-session sidecar event log — the source of truth (stateless). Survives
  // compaction (it's outside the session JSONL) and accumulates across all
  // branches of the session. In-memory `settings`/`totals`/`humanWindow` are a
  // cache rebuilt from this on every rehydrate.
  let sessionId = 'unknown';
  function sidecarPath(): string {
    return sidecarPathFor(sessionId);
  }

  // Session notarization (hash chain + Ed25519 seal). `chainMode` is decided
  // eagerly by rehydrate's full verification, or lazily from the on-disk tail
  // on the first append: a legacy log (pre-notarization tail, no seq/prev)
  // stays uniformly unchained — new appends omit chain fields and no seal is
  // written — while a chained log continues from (chainSeq, chainDigest).
  let chainMode: 'chained' | 'legacy' | null = null;
  let chainSeq = -1; // seq of the last chained event (-1 = none yet)
  let chainDigest = GENESIS_PREV; // digest of the chain tip (the previous event)
  let chainStatus: ChainStatus = 'open'; // verification status (/ledger, receipt)
  let latestSeal: (SessionCloseEvent & ChainFields) | null = null; // newest session-close seen/appended
  // Signing identity (Ed25519). Materialized on the first SIGNED append (or
  // when /ledger-settings displays it for registration) — never by read-only
  // chain verification.
  let identity: IdentityMaterial | null = null;

  function identityDir(): string {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(base, 'pi-ledger');
  }

  /** Load (or, unless `create` is false, generate) the Ed25519 identity.
   *  `PI_LEDGER_IDENTITY_B64` (base64 32-byte seed) overrides the on-disk
   *  identity entirely (headless/CI fleet); an invalid override stays unsigned
   *  rather than silently falling back to the wrong key. Secret file:
   *  `identity.secret` (base64 seed, mode 0600); public descriptor:
   *  `identity.json` ({kid, publicKey}). */
  function getIdentity(create = true): IdentityMaterial | null {
    if (identity) return identity;
    try {
      const envB64 = process.env.PI_LEDGER_IDENTITY_B64;
      if (envB64) {
        const seed = Buffer.from(envB64, 'base64');
        if (seed.length !== 32) return null; // invalid override → unsigned
        identity = identityFromSeed(seed);
        return identity;
      }
      const dir = identityDir();
      const secretPath = join(dir, 'identity.secret');
      let seed: Buffer | null = null;
      try {
        const parsed = Buffer.from(readFileSync(secretPath, 'utf8').trim(), 'base64');
        if (parsed.length === 32) seed = parsed;
      } catch {
        // missing/unreadable → generate below when allowed
      }
      if (!seed && !create) return null;
      if (!seed) {
        const { privateKey } = generateKeyPairSync('ed25519');
        const jwk = privateKey.export({ format: 'jwk' });
        seed = Buffer.from(jwk.d as string, 'base64url'); // the 32-byte seed
        mkdirSync(dir, { recursive: true });
        writeFileSync(secretPath, seed.toString('base64'), { mode: 0o600 });
        try {
          chmodSync(secretPath, 0o600);
        } catch {
          // best-effort
        }
      }
      identity = identityFromSeed(seed);
      if (create) {
        // Publish the public descriptor (also heals a deleted identity.json).
        writeFileSync(
          join(dir, 'identity.json'),
          JSON.stringify({ kid: identity.kid, publicKey: identity.publicKey }) + '\n'
        );
      }
      return identity;
    } catch {
      return null; // identity is best-effort: metering never fails on it
    }
  }

  /** Decide chainMode lazily (first append before any rehydrate): read the
   *  sidecar's LAST line only — chained tail → continue the chain
   *  (recomputing the tip's digest); unchained tail → the whole log is legacy. */
  function initChainFromDisk(): void {
    chainMode = 'chained';
    chainSeq = -1;
    chainDigest = GENESIS_PREV;
    chainStatus = 'open';
    let raw: string;
    try {
      raw = readFileSync(sidecarPath(), 'utf8');
    } catch {
      return; // no sidecar yet → fresh chain
    }
    let lastLine = '';
    for (const l of raw.split('\n')) if (l.trim()) lastLine = l;
    if (!lastLine) return; // empty log → fresh chain
    try {
      const tail = JSON.parse(lastLine) as SidecarEvent;
      if (typeof tail.seq === 'number' && typeof tail.prev === 'string') {
        chainSeq = tail.seq;
        chainDigest = digestEvent(tail);
        if (tail.kind === 'session-close') latestSeal = tail;
      } else {
        chainMode = 'legacy';
        chainStatus = 'legacy';
      }
    } catch {
      // corrupt tail: don't start a chain mid-log
      chainMode = 'legacy';
      chainStatus = 'legacy';
    }
  }

  /** Append the notarization seal: one signed session-close over the current
   *  chain head. `checkpoint` marks an audit snapshot of an OPEN session (from
   *  /ledger-receipt); the chain then continues normally — seq keeps
   *  incrementing from the checkpoint and a later real close re-seals the new
   *  head. Legacy logs are never sealed. */
  function appendSessionClose(checkpoint: boolean): void {
    if (chainMode === null) initChainFromDisk();
    if (chainMode !== 'chained') return;
    const id = getIdentity(); // materializes the identity (first signed append)
    if (!id) return;
    // The seal binds the tip as it was BEFORE this event: head = digest of the
    // previous event (genesis zeros for an empty log), which appendSidecar
    // stamps as this event's `prev` too (head === prev by design, so a verifier
    // can check the seal without re-walking the chain).
    const head = chainDigest;
    const headSig = cryptoSign(
      null,
      Buffer.from(sealMessage(sessionId, head), 'utf8'),
      id.privateKey
    ).toString('base64');
    const close: SessionCloseEvent = {
      kind: 'session-close',
      sessionId,
      head,
      headSig,
      kid: id.kid,
      timestamp: Date.now(),
    };
    if (checkpoint) close.checkpoint = true;
    appendSidecar(close);
    latestSeal = close;
    if (!checkpoint) chainStatus = 'sealed';
  }

  function appendSidecar(event: SidecarEvent): void {
    if (sessionId === 'unknown' && lastCtx) {
      const id = lastCtx.sessionManager.getSessionId?.();
      if (typeof id === 'string') sessionId = id;
    }
    try {
      if (chainMode === null) initChainFromDisk();
      let out = event;
      if (chainMode === 'chained') {
        // Stamp seq/prev (all kinds, including settings/correction/seal
        // events); the tip digest is taken over the event exactly as written
        // (seq/prev included), so insertion, deletion, reordering, or any byte
        // edit breaks the chain.
        const seq = chainSeq + 1;
        out = { ...event, seq, prev: chainDigest };
        chainSeq = seq;
        chainDigest = digestEvent(JSON.parse(JSON.stringify(out)));
        // Any append after a seal reopens the chain (the seal is no longer the tip).
        if (chainStatus === 'sealed') chainStatus = 'open';
      }
      const p = sidecarPath();
      mkdirSync(join(p, '..'), { recursive: true });
      appendFileSync(p, JSON.stringify(out) + '\n');
    } catch {
      // ignore — best-effort persistence
    }
  }
  function readSidecar(): SidecarEvent[] {
    try {
      const out: SidecarEvent[] = [];
      for (const l of readFileSync(sidecarPath(), 'utf8').split('\n')) {
        const t = l.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as SidecarEvent);
        } catch {
          // skip a malformed line rather than dropping the whole log
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // Fallback per-turn measurement (used iff pi-tps is absent for a turn).
  const fb = {
    totalGenerationMs: 0,
    stallMs: 0,
    stallCount: 0,
    inStall: false,
    lastUpdateMs: 0,
    firstTokenMs: 0,
    currentMessageStartMs: 0,
    messageCount: 0,
    tokens: { input: 0, output: 0, total: 0 },
    model: null as { provider: string; modelId: string } | null,
  };

  // ── Settings persistence ───────────────────────────────────────────────

  function persistSettings() {
    appendSidecar({ kind: 'settings', settings: { ...settings }, timestamp: Date.now() });
  }

  function persistPause(paused: boolean) {
    appendSidecar({ kind: 'billing-pause', paused, timestamp: Date.now() });
  }

  function effectiveAuthor(): string {
    return settings.author || defaultAuthor();
  }

  function effectiveProject(ctx: ExtensionContext): string {
    return settings.project || basename(ctx.cwd);
  }

  // ── Status footer ──────────────────────────────────────────────────────

  /** Entire-session display totals for the status + receipt.
   *
   *  - When pi-ledger is tracking (or a human window is open), use the live
   *    cumulative `totals` PLUS the in-progress open human window's idle so
   *    far (capped at its granted budget) — the "last idle" minute is counted
   *    even before the window closes.
   *  - When pi-ledger has no live data (a resumed pi-tps-only session), derive
   *    the whole session from pi-tps `tps` markers, including the trailing idle
   *    up to now. The in-progress initial human window (opened at session_start)
   *    doesn't suppress this — it has no accrued ledger data of its own.
   *
   *  Unlike pi-tps (per-turn), this is the full session up to the moment. */
  function computeDisplayTotals(ctx: ExtensionContext): Totals {
    const now = Date.now();
    let openIdleMs = 0;
    let openIdleWindows = 0;
    let openIdleKeystrokes = 0;
    let openSteerMs = 0;
    let openSteerCount = 0;
    let openSteerKeystrokes = 0;
    if (humanWindow) {
      // In-progress idle window: bill wall-clock from onset (capped), and fold
      // in the live composition-density count as a provisional idle window.
      const elapsed = Math.max(0, now - humanWindow.openedAt);
      openIdleMs = Math.min(elapsed, humanWindow.grantedBudgetMs);
      openIdleWindows = 1;
      openIdleKeystrokes = idleKeystrokes;
    } else {
      // In-flight steer composition: typing staged this run, plus compositions
      // submitted (pending, awaiting delivery) or reverted to the editor
      // (dequeuedBuffer) — all billed at delivery, so show the typing-burst sum
      // so far (capped at current rolling credit) like open human windows. No
      // idle window is open while any of this is in flight; a pending followUp
      // awaiting delivery after agent_end shows here too. Active typing only,
      // so idle gaps during composition don't accrue.
      const inFlight = [
        ...(dequeuedBuffer ?? []),
        ...pendingSteers.flatMap((p) => p.bursts),
        ...steerStaging,
      ];
      if (inFlight.length > 0) {
        const cap = extensionBudgetMs;
        openSteerMs = Math.min(computeBurstMs(inFlight, STEER_GAP_MS), cap);
        openSteerCount =
          pendingSteers.length + (dequeuedBuffer ? 1 : 0) + (steerStaging.length > 0 ? 1 : 0);
        openSteerKeystrokes = inFlight.length;
      }
    }
    const openHumanMs = openIdleMs + openSteerMs;
    const openWindows = openIdleWindows + openSteerCount;
    if (totals.agentTurns === 0 && totals.humanWindows === 0) {
      let tps: TpsMarker[] = [];
      try {
        tps = extractTpsEntries(ctx.sessionManager.getBranch());
      } catch {
        tps = [];
      }
      if (tps.length > 0) {
        const c = convertTpsEntries(tps, settings.referenceTps);
        return { ...c };
      }
    }
    return {
      ...totals,
      humanMs: totals.humanMs + openHumanMs,
      humanWindows: totals.humanWindows + openWindows,
      humanIdleMs: totals.humanIdleMs + openIdleMs,
      idleWindows: totals.idleWindows + openIdleWindows,
      idleKeystrokes: totals.idleKeystrokes + openIdleKeystrokes,
      humanSteerMs: totals.humanSteerMs + openSteerMs,
      steerCount: totals.steerCount + openSteerCount,
      steerKeystrokes: totals.steerKeystrokes + openSteerKeystrokes,
    };
  }

  function updateStatus(ctx: ExtensionContext | null) {
    if (!ctx || !ctx.hasUI) return;
    const t = computeDisplayTotals(ctx);
    const b = computeBilling(t.agentMs, t.humanMs, settings);
    const text = `ledger · agent ${fmtHours(t.agentMs)} · human ${fmtHours(t.humanMs)} · ${fmtMoney(b.total, settings.currency)}${billingPaused ? ' · paused' : ''}`;
    const theme = ctx.ui.theme;
    ctx.ui.setStatus('ledger', theme ? theme.fg('dim', text) : text);
  }

  // ── Human idle window ──────────────────────────────────────────────────

  function closeHumanWindow(ctx: ExtensionContext | null, committed: boolean) {
    disarmWizard();
    const w = humanWindow;
    humanWindow = null;
    if (!w) return;
    const closedAt = Date.now();
    // An idle window bills only when the human's submit produces agent work
    // (a prompt at `agent_start` = `committed`). Abandoned idle — the session
    // ended with no submit — bills nothing: idle time with no output is wasted.
    let billedMs: number;
    let idleMs: number;
    if (committed) {
      const r = closeWindowBudget(w.openedAt, closedAt, w.grantedBudgetMs);
      idleMs = r.idleMs;
      billedMs = r.billedMs;
      // All billed idle consumes the rolling extension credit;
      // the leftover rolls forward to the next idle window.
      const consumed = consumeExtensionBudget(billedMs, extensionBudgetMs);
      extensionBudgetMs -= consumed;
      totals.humanIdleMs += billedMs;
      totals.idleWindows += 1;
      totals.idleKeystrokes += idleKeystrokes;
      totals.extensionConsumedMs += consumed;
    } else {
      idleMs = Math.max(0, closedAt - w.openedAt); // span, kept for audit only
      billedMs = 0; // abandoned → unbilled
      totals.abandonedWindows += 1;
      totals.abandonedMs += idleMs;
    }
    // Always record the close (even abandoned/0-billed) so the open window is
    // marked closed on replay — never restored as a stale in-progress window.
    appendSidecar({
      kind: 'human-close',
      openedAt: w.openedAt,
      closedAt,
      billedMs,
      idleMs,
      keystrokes: idleKeystrokes,
      committed,
      grantedBudgetMs: w.grantedBudgetMs,
      extensions: w.extensions,
      extensionBudgetMs,
      timestamp: closedAt,
    });
    idleKeystrokes = 0; // reset for the next window
    if (billedMs > 0) {
      totals.humanMs += billedMs;
      totals.humanWindows += 1;
    }
    updateStatus(ctx);
  }

  /** Open a human idle window at the moment of first engagement — the first
   *  keystroke the human types, or the first extension (wizard/`/ledger-extend`,
   *  which both grant capacity and engage). No engagement → no window → no bill:
   *  pure idle (no typing, no extension) until the end bills nothing. The
   *  window bills wall-clock from this onset (capturing thinking, not just
   *  keystrokes), capped at `extensionBudgetMs` (rolling credit), but ONLY when
   *  committed by a submitted prompt at `agent_start` — abandoned idle bills 0.
   *  `engagedVia` records how the human signaled presence (audit): 'keystroke',
   *  'extension', or 'grace' (the resume grace — onset is the resume moment,
   *  standing-config engagement rather than an observed signal). `extendMs`
   *  provisions a pomodoro block on open (the extension/grace cases). */
  function openIdleWindow(
    ctx: ExtensionContext,
    engagedVia: 'keystroke' | 'extension' | 'grace',
    extendMs = 0
  ) {
    if (humanWindow) return; // safety: never open a second window
    idleKeystrokes = 0; // reset the composition-density count for the new window
    if (extendMs > 0) {
      extensionBudgetMs += extendMs;
      totals.extensionCreditMs += extendMs; // provisioned capacity (one block)
      totals.extensionsGranted += 1;
    }
    const cap = extensionBudgetMs;
    const openedAt = Date.now();
    humanWindow = {
      openedAt,
      engagedVia,
      grantedBudgetMs: cap,
      extensions: extendMs > 0 ? 1 : 0,
    };
    appendSidecar({
      kind: 'human-open',
      openedAt,
      engagedVia,
      grantedBudgetMs: cap,
      extensions: humanWindow.extensions,
      extensionBudgetMs,
      timestamp: openedAt,
    });
    // Arm the wizard for when this window's budget is exhausted (from the
    // onset) — never pop now: the human is engaging, and an immediate pop would
    // interrupt typing. At the boundary, recent typing rolls a block silently
    // and only true idleness pops the next-extension prompt.
    armWizardForBoundary(ctx);
    updateStatus(ctx);
  }

  // Steering composition: the human types a steer/followUp while the agent
  // runs. The editor hook (`noteKeystroke`) stages every keystroke; the
  // `input` event stages it as PENDING on submit, and the `message_start` user
  // message (delivery — the agent outcome) commits it. Billed as the
  // active-typing burst sum (not wall-clock) under the same rolling-credit cap
  // as an idle window — a single key or keys spread minutes apart bill
  // nothing, so typing is only billed when it's actually delivered to the agent.
  function noteKeystroke(data: string) {
    const now = Date.now();
    // Held-key collapse: a held key auto-repeats the same data within
    // AUTO_REPEAT_MS. Collapse to one event so a single physical action can't
    // fabricate a sustained burst (steer staging) or inflate the idle keystroke
    // count. Varied keys, same-key gaps at/above the threshold, and voice/paste
    // (distinct blobs) are unaffected. Reset at agent_start/end and at submit.
    const autoRepeat = data === lastKey && now - lastKeyTime < AUTO_REPEAT_MS;
    lastKey = data;
    lastKeyTime = now;
    if (autoRepeat) return;
    lastGenuineActivityAt = now; // genuine typing = presence; held keys don't refresh it
    // A docked wizard prompt does NOT step aside on typing: the LedgerEditor
    // wrapper consumed ↑/↓/enter/escape before this hook (they never reach
    // noteKeystroke, so answering stages no phantom billing keystroke), and
    // any other key passes through to the editor with the box still docked.
    if (agentRunning) {
      steerStaging.push(now);
    } else if (lastCtx) {
      // First keystroke after a turn (or at session start) engages an idle
      // window at this onset — no engagement means no bill. Subsequent idle
      // keystrokes add to the composition-density count (idle bills wall-clock
      // from the onset, not keystrokes).
      if (!humanWindow) openIdleWindow(lastCtx, 'keystroke');
      idleKeystrokes++;
    }
  }

  /** A steer/followUp submit (the `input` event): the composition is now
   *  queued to the agent. Stage it as PENDING — billed at delivery (the agent
   *  outcome), not here. A prior dequeue's composition (`dequeuedBuffer`, text
   *  the human reverted to the editor) is prepended so a re-steer/re-queue
   *  bills the original typing at this submit's delivery. Typing bursts are
   *  snapshotted per submit, so multiple distinct steers in one run each bill
   *  at their own delivery. */
  function stagePendingSteer(ctx: ExtensionContext | null, behavior: 'steer' | 'followUp') {
    const bursts = [...(dequeuedBuffer ?? []), ...steerStaging].sort((a, b) => a - b);
    if (bursts.length === 0) return; // no typing composed (non-TUI / paste / no keystrokes)
    pendingSteers.push({ bursts, behavior, submittedAt: Date.now() });
    dequeuedBuffer = null;
    steerStaging = [];
    lastKey = null; // reset held-key tracking so the next burst starts fresh
    lastKeyTime = 0;
    updateStatus(ctx);
  }

  /** A queued steer/followUp was DELIVERED to the agent (a `message_start` user
   *  message — the agent outcome): commit the front pending composition. Bills
   *  its typing-burst sum, capped at the rolling credit remaining, and consumes
   *  that credit. The initial/normal prompt fires `message_start` too but stages
   *  no pending (no `streamingBehavior`), so this is a no-op for them. */
  function commitPendingSteer(ctx: ExtensionContext | null) {
    const entry = pendingSteers.shift();
    if (!entry) return;
    const submittedAt = entry.submittedAt;
    const cap = extensionBudgetMs;
    // Bill active typing (burst sum), not the wall-clock span from the first
    // keystroke — so idle gaps before/between typing don't accrue, and a single
    // keystroke can't open a billable window.
    const burstMs = computeBurstMs(entry.bursts, STEER_GAP_MS);
    const billedMs = Math.min(burstMs, Math.max(0, cap));
    const startedAt = entry.bursts[0] ?? submittedAt;
    const durationMs = Math.max(0, submittedAt - startedAt); // wall-clock span (audit)
    const keystrokes = entry.bursts.length;
    // All billed typing consumes rolling credit; the leftover rolls forward
    // (same rule as an idle window).
    const consumed = consumeExtensionBudget(billedMs, extensionBudgetMs);
    extensionBudgetMs -= consumed;
    totals.extensionConsumedMs += consumed;
    appendSidecar({
      kind: 'steer',
      startedAt,
      submittedAt,
      durationMs,
      billedMs,
      keystrokes,
      behavior: entry.behavior,
      grantedBudgetMs: cap,
      extensionBudgetMs,
      timestamp: Date.now(),
    });
    if (billedMs > 0) {
      totals.humanMs += billedMs;
      totals.humanWindows += 1;
      if (entry.behavior === 'steer') {
        totals.humanSteerMs += billedMs;
        totals.steerCount += 1;
        totals.steerKeystrokes += keystrokes;
      } else {
        totals.humanQueueMs += billedMs;
        totals.queueCount += 1;
        totals.queueKeystrokes += keystrokes;
      }
    }
    updateStatus(ctx);
  }

  /** The human reverted a queued message back to the editor (the
   *  `app.message.dequeue` action, alt+up). The composition isn't abandoned —
   *  it carries forward to the next submit (the re-steer/re-queue), which bills
   *  it at delivery. Merge all pending compositions into `dequeuedBuffer`
   *  (dequeue restores ALL queued messages at once, joined in the editor). */
  function revertSteerToEditor() {
    if (pendingSteers.length === 0) return; // nothing queued (a no-op dequeue)
    dequeuedBuffer = [...(dequeuedBuffer ?? []), ...pendingSteers.flatMap((p) => p.bursts)].sort(
      (a, b) => a - b
    );
    pendingSteers = [];
    updateStatus(lastCtx);
  }

  /** Abandon any pending/dequeued steer composition (bill 0). Called at
   *  session_shutdown and rehydrate: a pending composition never reached the
   *  agent (it was dequeued and not re-sent, or the run was interrupted), so no
   *  agent outcome means no bill. Never persisted — a pending was never billed. */
  function abandonPendingSteer() {
    pendingSteers = [];
    dequeuedBuffer = null;
  }

  // ── Wizard ─────────────────────────────────────────────────────────────

  function clearWizardTimer() {
    if (wizardTimer) {
      clearTimeout(wizardTimer);
      wizardTimer = null;
    }
  }

  function clearConsentTimer() {
    if (consentTimer) {
      clearTimeout(consentTimer);
      consentTimer = null;
    }
  }

  function disarmWizard() {
    clearWizardTimer();
    clearConsentTimer();
  }

  function armWizardForBoundary(ctx: ExtensionContext) {
    clearWizardTimer();
    if (!humanWindow || !settings.autoWizard) return;
    // No credit provisioned → nothing to exhaust; the agent_settled / resume
    // engagement prompt (itself idle-gated) offers engagement, so don't re-pop
    // on the first keystroke (that would intercept typing). Only arm the
    // exhaustion boundary when there's credit.
    if (humanWindow.grantedBudgetMs <= 0) return;
    const elapsed = Date.now() - humanWindow.openedAt;
    const delay = humanWindow.grantedBudgetMs - elapsed;
    if (settings.autoExtend) {
      // Auto-extend silently when the block is exhausted — works in any mode
      // (no UI needed), so headless/GUI sessions keep review-time credit rolling.
      if (delay <= 0) autoExtendNow(ctx);
      else wizardTimer = setTimeout(() => autoExtendNow(ctx), delay);
      return;
    }
    if (!canPromptWizard(ctx)) return;
    if (delay <= 0) {
      onExhaustionBoundary(ctx);
      return;
    }
    wizardTimer = setTimeout(() => onExhaustionBoundary(ctx), delay);
  }

  /** Presence = a genuine keystroke within the presence window. */
  function isEngaged(): boolean {
    return (
      lastGenuineActivityAt !== null && Date.now() - lastGenuineActivityAt < ENGAGED_ACTIVITY_MS
    );
  }

  /** The open window's credit ran out. Engaged (typing within the presence
   *  window) → roll a pomodoro block SILENTLY: presence is the engagement
   *  signal already, and popping mid-typing would steal the editor. True
   *  idleness → pop the wizard (extend / stop billing). Silence only ever
   *  ROLLS a grant the human already made — the first credit is always an
   *  explicit extend (the wizard's extend or /ledger-extend). */
  function onExhaustionBoundary(ctx: ExtensionContext) {
    wizardTimer = null;
    if (isEngaged()) {
      autoExtendNow(ctx); // silent roll; extendHumanTime re-arms the next boundary
      return;
    }
    showWizard(ctx);
  }

  /** A wizard prompt can be shown where a dialog renders: the TUI (custom
   *  component) or an RPC client that speaks the `select` dialog protocol
   *  (e.g. the vscode-pi GUI). `hasUI` is true in both; `print`/`json` have no
   *  dialog UI, so they fall back to the silent auto-extend path. */
  function canPromptWizard(ctx: ExtensionContext): boolean {
    return ctx.hasUI && (ctx.mode === 'tui' || ctx.mode === 'rpc');
  }

  /** Grant `mins` of billable-human-time capacity and engage an idle window if
   *  none is open. Shared by the wizard's "Extend" choice and `autoExtend` —
   *  both provision a rolling pomodoro block (credit survives across turns). */
  function extendHumanTime(ctx: ExtensionContext, mins: number) {
    // Credit granted — a pending (deferred) engagement prompt is moot, and a
    // docked wizard prompt is answered (its box steps aside).
    clearConsentTimer();
    closeWizardPrompt(ctx);
    // Extending resumes billing: clear the skip-billing guard so agent messages
    // reach the model again (the documented way to resume after "Stop billing").
    if (billingPaused) {
      billingPaused = false;
      persistPause(false);
    }
    const addMs = mins * MS_PER_MINUTE;
    if (!humanWindow) {
      // No window yet: extend both engages (onset = now) and grants capacity.
      // openIdleWindow opens, records, arms for exhaustion, and re-renders.
      openIdleWindow(ctx, 'extension', addMs);
      return;
    }
    // Window already engaged: grant capacity and re-record the cap bump.
    humanWindow.grantedBudgetMs += addMs;
    humanWindow.extensions += 1;
    extensionBudgetMs += addMs;
    totals.extensionCreditMs += addMs; // provisioned capacity (one block)
    totals.extensionsGranted += 1;
    appendSidecar({
      kind: 'human-open',
      openedAt: humanWindow.openedAt,
      engagedVia: humanWindow.engagedVia,
      grantedBudgetMs: humanWindow.grantedBudgetMs,
      extensions: humanWindow.extensions,
      extensionBudgetMs,
      timestamp: Date.now(),
    });
    armWizardForBoundary(ctx);
    updateStatus(ctx);
  }

  /** `autoExtend`: provision a pomodoro block silently (no dialog) when the
   *  wizard would otherwise prompt — for headless/GUI sessions where a prompt
   *  can't render, or a hands-off "bill my review time" policy. Acts exactly
   *  like choosing "Extend" in the wizard. Works in any mode (no UI needed). */
  function autoExtendNow(ctx: ExtensionContext, mins: number = settings.pomodoroMinutes) {
    extendHumanTime(ctx, mins);
    notify(ctx, `Auto-extended billable human time by ${mins}m.`, 'info');
  }

  /** The /resume (and /reload) grace: provision `resumeGraceMinutes` of
   *  billable human time so re-orientation — reading the transcript, regaining
   *  context — counts, without making the human extend first. Engages a window
   *  at the resume moment (onset = now) capped at the grace block (rolling
   *  credit, so any unspent remainder carries forward like any grant). It
   *  bills only when committed by the human's next submit (agent_start);
   *  resume-and-walk-away abandons it (bills 0). openIdleWindow arms the
   *  exhaustion boundary, which is where the engagement prompt now lands —
   *  deferred from the resume moment by the grace. This is the one
   *  standing-config credit grant; `resumeGraceMinutes: 0` restores
   *  prompt-first engagement. */
  function grantResumeGrace(ctx: ExtensionContext) {
    openIdleWindow(ctx, 'grace', settings.resumeGraceMinutes * MS_PER_MINUTE);
    notify(
      ctx,
      `Resume grace: ${settings.resumeGraceMinutes}m of billable human time for re-orientation.`,
      'info'
    );
  }

  /** Apply the wizard's choice: 'extend' grants capacity (shared path),
   *  'stop' arms the skip-billing guard, anything else (dismiss) is a no-op. */
  function applyWizardChoice(
    ctx: ExtensionContext,
    choice: 'extend' | 'stop' | 'dismiss' | undefined,
    pomodoro: number
  ) {
    if (choice !== 'extend' && choice !== 'stop') return; // dismiss = no change
    if (choice === 'stop') {
      // "Stop billing" = skip billing: arm the guard so interactive
      // prompts/steers to the agent are blocked until the human extends
      // (via /ledger-extend). Slash commands are unaffected (pi-core runs
      // them before emitting the `input` event). Persist so the guard
      // survives reload/compaction — the sidecar is the source of truth.
      billingPaused = true;
      persistPause(true);
      updateStatus(ctx);
      notify(
        ctx,
        'Billing stopped — run /ledger-extend to extend your time and resume the agent.',
        'warning'
      );
      return;
    }
    extendHumanTime(ctx, pomodoro);
    notify(ctx, `Extended billable human time by ${pomodoro}m.`, 'info');
  }

  /** Clear a pending queue-steer drain re-offer (see QUEUE_STEER_REARM_MS). */
  function clearQueueSteerRearm() {
    if (queueSteerRearmTimer) {
      clearTimeout(queueSteerRearmTimer);
      queueSteerRearmTimer = null;
    }
  }

  /** Undispatched rows pi-queue-steer reports right now (0 when the queue
   *  extension is absent). The globalThis mirror wins — it is always current,
   *  regardless of extension load order; the events-tracked count is the
   *  fallback for an events-only publisher. */
  function queueSteerPending(): number {
    const mirrored = globalThis.__tmustierPiQueueSteerState;
    if (typeof mirrored?.pending === 'number') return mirrored.pending;
    return queueSteerEventPending ?? 0;
  }

  /** The no-credit engagement prompt (agent_settled with no rolling credit,
   *  /resume, or a re-offer after a retry settles). Pops only at TRUE IDLENESS:
   *  if the human typed within the presence window they're mid-flow — composing
   *  the next prompt, steering, or still reading with intent — so defer and
   *  re-check once hands have been off the keyboard for ENGAGED_ACTIVITY_MS.
   *  Further typing slides the timer; agent_start or a granted credit disarms
   *  it (the next settle re-evaluates). Already idle past the window, or never
   *  typed → pop now. The deferral path NEVER grants credit — the first credit
   *  is always an explicit extend, so an actively-typing session stays at a $0
   *  billing cap until consent. With `autoExtend`, skip the prompt and
   *  provision a block silently (any mode, including headless); otherwise
   *  prompt only where the docked widget can show (TUI component, or an RPC
   *  client that speaks the extension_ui wire; the choice rides the wizard
   *  shortcuts in the TUI and the `select` dialog round-trip in RPC). */
  function armEngagementPrompt(ctx: ExtensionContext) {
    clearWizardTimer();
    clearConsentTimer();
    if (!settings.autoWizard) return;
    if (settings.autoExtend) {
      autoExtendNow(ctx);
      return;
    }
    if (!canPromptWizard(ctx)) return;
    const idleFor = lastGenuineActivityAt === null ? Infinity : Date.now() - lastGenuineActivityAt;
    if (idleFor >= ENGAGED_ACTIVITY_MS) {
      showWizard(ctx);
      return;
    }
    consentTimer = setTimeout(() => armEngagementPrompt(ctx), ENGAGED_ACTIVITY_MS - idleFor);
  }

  /** Close the docked wizard prompt: clear the widget and drop the answer
   *  path. Every closer funnels here so wizardOpen stays truthful. */
  function closeWizardPrompt(ctx: ExtensionContext | null) {
    if (!wizardOpen) return;
    wizardOpen = false;
    wizardSelection = 0;
    if (ctx?.hasUI) ctx.ui.setWidget(WIZARD_WIDGET_KEY, undefined);
  }

  /** Render the wizard prompt as a queue-steer-style docked box. Pure, so the
   *  themed TUI component and the plain RPC string[] widget stay in sync.
   *  Every row is fitted to the box width; `color` re-inks rows for the TUI. */
  function wizardBoxLines(
    width: number,
    opts: { pomodoro: number; remainingProvisioned: number; selected: number },
    color?: {
      border: (s: string) => string;
      accent: (s: string) => string;
      muted: (s: string) => string;
      dim: (s: string) => string;
    }
  ): string[] {
    const c = color ?? {
      border: (s: string) => s,
      accent: (s: string) => s,
      muted: (s: string) => s,
      dim: (s: string) => s,
    };
    const fit = (s: string, w: number) =>
      truncateToWidth(s, w) + ' '.repeat(Math.max(0, w - visibleWidth(s)));
    const title = ` pi-ledger · extend? · ${opts.pomodoro}m pomodoro `;
    const topFill = '─'.repeat(Math.max(0, width - visibleWidth(title) - 2));
    const cell = Math.max(1, width - 4);
    const row = (picked: boolean, label: string, hint: string) =>
      picked
        ? fit(`${c.accent(`▶ ${label}`)}${c.muted(` · ${hint}`)}`, cell)
        : fit(`  ${label}${c.dim(` · ${hint}`)}`, cell);
    const rows: string[] = [];
    rows.push(c.border(`┌${title}${topFill}┐`));
    rows.push(
      `│ ${row(opts.selected === 0, `Extend +${opts.pomodoro}m`, 'add a pomodoro to billable human time')} │`
    );
    rows.push(
      `│ ${row(opts.selected === 1, 'Stop billing', 'pause the agent until /ledger-extend')} │`
    );
    if (opts.remainingProvisioned > 0) {
      rows.push(
        `│ ${fit(c.dim(`${Math.max(1, Math.round(opts.remainingProvisioned / MS_PER_MINUTE))}m still provisioned — extending adds more`), cell)} │`
      );
    }
    rows.push(
      `│ ${fit(c.dim('↑/↓ select · enter confirm · esc dismiss · typing keeps the box'), cell)} │`
    );
    rows.push(c.border(`└${'─'.repeat(Math.max(0, width - 2))}┘`));
    return rows;
  }

  /** The themed TUI component behind the docked wizard widget. Reads the
   *  live selection at render time so a re-set of the widget re-draws the
   *  moved cursor. */
  class WizardWidget {
    constructor(private readonly theme: Theme) {}
    render(width: number): string[] {
      const t = this.theme;
      return wizardBoxLines(
        Math.max(width, 20),
        {
          pomodoro: wizardPomodoro,
          remainingProvisioned: wizardRemainingProvisioned,
          selected: wizardSelection,
        },
        {
          border: (s) => t.fg('accent', s),
          accent: (s) => t.fg('accent', s),
          muted: (s) => t.fg('muted', s),
          dim: (s) => t.fg('dim', s),
        }
      );
    }
    invalidate() {}
  }

  function showWizard(ctx: ExtensionContext, extendMins: number = settings.pomodoroMinutes) {
    wizardTimer = null;
    if (wizardOpen) return;
    wizardOpen = true;
    const pomodoro = extendMins;
    // Works with or without an open window. With no window this is the
    // engagement prompt (agent_end no-credit / /resume): extend engages one.
    // Snapshot the rolling credit still provisioned (and unconsumed so far) so
    // the user knows extending ADDS to existing capacity, not replaces it.
    // Captured before the async closure — state can change.
    const elapsedNow = humanWindow ? Math.max(0, Date.now() - humanWindow.openedAt) : 0;
    const remainingProvisioned = humanWindow
      ? Math.max(0, extensionBudgetMs - elapsedNow)
      : extensionBudgetMs;
    const extendLabel = `Extend +${pomodoro}m`;
    const stopLabel = 'Stop billing';

    // The prompt is a docked widget box above the editor, not a modal popup.
    // In the TUI it's interactive: the LedgerEditor wrapper consumes
    // ↑/↓/enter/escape while the box shows (queue-steer's editor-interception
    // pattern) and moves the selection; every other key passes through, so
    // typing keeps the box docked instead of dropping it.
    //
    // RPC/GUI clients additionally keep the `select` dialog: it round-trips
    // through the extension_ui protocol and is how a GUI captures the choice
    // (widgets are fire-and-forget there, and there is no editor to
    // intercept). The same box goes over the wire as plain string lines —
    // component factories are ignored in RPC mode — so the GUI shows the
    // docked prompt too. RPC behavior is additive: a client that ignores
    // widgets still gets the same dialog as before.
    wizardPomodoro = pomodoro;
    wizardRemainingProvisioned = remainingProvisioned;
    wizardSelection = 0;
    if (ctx.mode !== 'tui') {
      const credit =
        remainingProvisioned > 0
          ? ` · ${Math.max(1, Math.round(remainingProvisioned / MS_PER_MINUTE))}m still provisioned — extending adds more.`
          : '';
      if (ctx.hasUI) {
        ctx.ui.setWidget(
          WIZARD_WIDGET_KEY,
          wizardBoxLines(64, { pomodoro, remainingProvisioned, selected: wizardSelection })
        );
      }
      ctx.ui
        .select(
          `⏱ Extend billable human time? Idle after the agent. Add a ${pomodoro}m pomodoro block?${credit}`,
          [extendLabel, stopLabel]
        )
        .then((picked) => {
          const choice =
            picked === extendLabel ? 'extend' : picked === stopLabel ? 'stop' : 'dismiss';
          applyWizardChoice(ctx, choice, pomodoro);
        })
        .finally(() => {
          closeWizardPrompt(ctx);
        });
      return;
    }

    rerenderWizard(ctx);
  }

  /** (Re)install the docked wizard widget. Called on show and on every
   *  selection move; setWidget with the same key re-renders the box. */
  function rerenderWizard(ctx: ExtensionContext | null) {
    if (!ctx?.hasUI || !wizardOpen) return;
    ctx.ui.setWidget(WIZARD_WIDGET_KEY, (_tui, theme) => new WizardWidget(theme));
  }

  /** The editor's wizard interception (LedgerEditor calls this before any
   *  other handling while the box shows). Consumes ↑/↓/enter/escape —
   *  answering or dismissing the prompt — and passes everything else through
   *  so typing continues with the box still docked. Returns true when the
   *  key was consumed. */
  function handleWizardKey(data: string, isShowingAutocomplete: () => boolean): boolean {
    if (!wizardOpen) return false;
    const ctx = lastCtx;
    // Autocomplete owns arrows/enter/escape — let the editor navigate/confirm
    // its list; the box stays docked underneath.
    if (isShowingAutocomplete()) return false;
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      const moved = matchesKey(data, 'up') ? 0 : 1; // two rows — absolute, clamped
      if (moved !== wizardSelection) {
        wizardSelection = moved;
        rerenderWizard(ctx);
      }
      return true;
    }
    if (matchesKey(data, 'enter')) {
      const choice = wizardSelection === 0 ? 'extend' : 'stop';
      closeWizardPrompt(ctx);
      if (ctx) applyWizardChoice(ctx, choice, wizardPomodoro);
      return true;
    }
    if (matchesKey(data, 'escape')) {
      closeWizardPrompt(ctx);
      return true;
    }
    return false;
  }

  function notify(
    ctx: ExtensionContext | null,
    message: string,
    type: 'info' | 'warning' | 'error'
  ) {
    if (ctx && ctx.hasUI) ctx.ui.notify(message, type);
  }

  // ── Rehydration ────────────────────────────────────────────────────────

  /** Notarization on load: verify chain linkage per event (events arrive in
   *  order, so this is a cheap single pass) plus the final seal's signature,
   *  and prime the append path (continue the chain, or keep a legacy log
   *  uniformly unchained). */
  function verifyChain(events: SidecarEvent[]): void {
    latestSeal = null;
    for (let i = events.length - 1; i >= 0 && !latestSeal; i--) {
      const e = events[i]!;
      if (e.kind === 'session-close') latestSeal = e;
    }
    if (events.length === 0) {
      chainMode = null; // undetermined — the first append reads the (empty) tail
      chainSeq = -1;
      chainDigest = GENESIS_PREV;
      chainStatus = 'open';
      return;
    }
    // Verification is read-only: never materialize an identity just to verify
    // (created on the first signed append, per the notarization contract).
    const id = getIdentity(false);
    const v = verifySidecarChain(
      events,
      id ? { kid: id.kid, publicKeyRaw: Buffer.from(id.publicKey, 'base64') } : null
    );
    chainStatus = v.status;
    if (v.status === 'legacy') {
      chainMode = 'legacy';
    } else {
      chainMode = 'chained';
      chainSeq = v.lastSeq;
      chainDigest = v.head;
    }
    if (v.lastClose) latestSeal = v.lastClose;
  }

  function rehydrate(ctx: ExtensionContext) {
    sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
    const events = readSidecar();
    verifyChain(events);
    // Restore from the sidecar only if it has events. During a live session the
    // in-memory totals are already current (every event updates them); never
    // overwrite them with an empty read (which would reset the status to $0).
    if (events.length > 0) {
      const r = rehydrateFromSidecar(events);
      settings = r.settings;
      // Restore the ENTIRE totals object — including the itemized sub-totals
      // the receipt itemizes from (agent gen/tool/stall, human idle/steer/queue/
      // abandoned, extensions). Copying only the bundled ms left the sub-totals
      // at 0 after a reload, so the receipt collapsed to just the in-progress
      // window while the status bar (which uses the bundled ms) stayed correct.
      Object.assign(totals, r.totals);
      extensionBudgetMs = r.extensionBudgetMs; // rolling credit carries forward
      billingPaused = r.billingPaused; // skip-billing guard carries forward
      // An unclosed window from a prior session was never committed by an agent
      // action — idle with no output is wasted, so abandon it (bills 0) rather
      // than continuing its stale onset across the session gap. Mark it closed
      // (committed: false) so a future replay doesn't treat it as in-progress.
      if (r.humanWindow) {
        appendSidecar({
          kind: 'human-close',
          openedAt: r.humanWindow.openedAt,
          closedAt: Date.now(),
          billedMs: 0,
          idleMs: 0,
          committed: false,
          grantedBudgetMs: r.humanWindow.grantedBudgetMs,
          extensions: r.humanWindow.extensions,
          extensionBudgetMs,
          timestamp: Date.now(),
        });
      }
      humanWindow = null; // never restore a stale window; engage fresh instead
    }
    updateStatus(ctx);
  }

  pi.on('session_start', (event, ctx) => {
    lastCtx = ctx;
    rehydrate(ctx);
    agentRunning = false;
    steerStaging = [];
    lastKey = null;
    lastKeyTime = 0;
    idleKeystrokes = 0;
    // A reload leaves no live timers: rehydrate abandoned any open window, so
    // its boundary is stale, and any pending consent prompt re-evaluates below
    // (resume/reload) or at the next settle. Presence is per-process — nothing
    // has been typed yet in this one.
    disarmWizard();
    closeWizardPrompt(ctx); // a docked prompt never survives a session swap
    lastGenuineActivityAt = null;
    // A pending/dequeued composition is in-memory only — on a fresh load/reload
    // it was never delivered (no agent outcome), so abandon it (bills 0). Same
    // rule as an unclosed idle window: uncommitted, so not restored.
    pendingSteers = [];
    dequeuedBuffer = null;
    // Reset pi-retry capture state — a fresh session has no in-flight retry and
    // no deferred prompt (an unclosed prior session's retry could otherwise
    // leak across the session boundary on a per-process extension instance).
    retryActiveId = undefined;
    pendingSettledWizard = null;
    // Queue-steer hold state is per-session too: a fresh session re-reads the
    // live mirror at its first settle (or resume/reload prompt gate below).
    queueSteerEventPending = null;
    queueSteerSuppressed = false;
    clearQueueSteerRearm();
    // Wrap the input editor so keystrokes stage for billing: during a run they
    // feed a steer/followUp burst (committed on submit via `input`); between
    // turns the FIRST keystroke engages an idle window at its onset. Extends
    // CustomEditor and delegates every keystroke to the base editor, so app
    // keybindings (escape-to-abort, ctrl+d, …) are preserved. TUI-only: non-
    // interactive modes have no editor to type into, so nothing stages.
    if (ctx.mode === 'tui' && ctx.hasUI) {
      ctx.ui.setEditorComponent(
        (tui, theme, kb) =>
          new LedgerEditor(tui, theme, kb, noteKeystroke, revertSteerToEditor, handleWizardKey)
      );
    }
    // No initial window is opened here for a fresh session — engagement is
    // gated on the first keystroke/extension, so pre-engagement time (reading
    // the transcript, thinking) bills nothing unless the human extends. On
    // /resume (or /reload) the session IS continued work: with no rolling
    // credit left, the RESUME GRACE provisions a small billable human-time
    // block so re-orientation (reading the transcript, regaining context)
    // counts as human time when the next submit commits — and the engagement
    // prompt lands at the grace boundary instead of popping immediately.
    // Grace disabled → prompt on resume, as before. (Startup/new start typing
    // right away — no grace, no pop.)
    if (event.reason === 'resume' || event.reason === 'reload') {
      if (settings.autoWizard && queueSteerPending() > 0) {
        // A parked queue-steer backlog survived the swap (restored rows):
        // hold the prompt exactly as at agent_settled; the drain re-offers it.
        // No grace either — queued work is in flight, and an unattended
        // dispatch would commit (bill) the grace with no human present.
        queueSteerSuppressed = true;
      } else if (
        settings.autoWizard &&
        settings.resumeGraceMinutes > 0 &&
        !billingPaused && // "Stop billing" must survive the resume
        extensionBudgetMs <= 0 // rolling credit already bills engaged review
      ) {
        grantResumeGrace(ctx);
      } else if (settings.autoWizard) {
        armEngagementPrompt(ctx);
      }
    }
  });

  pi.on('session_tree', (_event, ctx) => {
    lastCtx = ctx;
    // Branching (/tree → "go back") changes the leaf but stays in the same
    // session, so the live in-memory totals are still current. Don't re-read
    // the sidecar here — that would reset the status to $0 if the read came
    // back empty. Just re-render the status; restore only happens on
    // session_start (fresh load / reload).
    updateStatus(ctx);
  });

  pi.on('session_shutdown', () => {
    // Abandon any pending/dequeued steer composition: it never reached the
    // agent (dequeued and not re-sent, or the run was interrupted) — no agent
    // outcome means no bill. Never persisted (a pending was never billed).
    abandonPendingSteer();
    // Record the exit: close any open human window. Idle only bills when
    // committed by a submitted prompt (an agent action) — a window still open
    // at shutdown was never committed, so it's abandoned and bills 0 (idle
    // with no output is wasted). Persisted as a close for replay cleanliness.
    closeHumanWindow(lastCtx, false);
    // Tear down the pi-retry event capture (a session-scoped resource): the
    // factory re-binds subscriptions on the next session, so unbind here to
    // avoid leaking listeners across the session boundary. Reset the capture
    // state too — no in-flight retry survives a session teardown.
    for (const unsub of retryUnsubs) {
      try {
        unsub();
      } catch {
        // best-effort — ignore a stale bus
      }
    }
    retryUnsubs = [];
    retryActiveId = undefined;
    pendingSettledWizard = null;
    // Notarization: seal the session — one signed session-close over the final
    // chain head, appended AFTER all other shutdown bookkeeping so the seal's
    // head covers the complete log. Legacy logs stay unsealed.
    appendSessionClose(false);
  });

  // ── Agent timing (tool execution) ─────────────────────────────────────

  pi.on('turn_start', (event, ctx) => {
    lastCtx = ctx;
    currentTurnIndex = event.turnIndex;
    toolDepth = 0;
    toolSpanStart = 0;
    toolMsThisTurn = 0;
    fb.totalGenerationMs = 0;
    fb.stallMs = 0;
    fb.stallCount = 0;
    fb.inStall = false;
    fb.lastUpdateMs = 0;
    fb.firstTokenMs = 0;
    fb.currentMessageStartMs = 0;
    fb.messageCount = 0;
    fb.tokens = { input: 0, output: 0, total: 0 };
    fb.model = null;
  });

  pi.on('tool_execution_start', () => {
    if (toolDepth === 0) toolSpanStart = Date.now();
    toolDepth += 1;
  });

  pi.on('tool_execution_end', () => {
    if (toolDepth <= 0) return;
    toolDepth -= 1;
    if (toolDepth === 0 && toolSpanStart) {
      toolMsThisTurn += Date.now() - toolSpanStart;
      toolSpanStart = 0;
    }
  });

  // ── Fallback agent timing (self-sufficient; used iff pi-tps is absent) ─

  pi.on('message_start', (event, ctx) => {
    // A queued steer/followUp delivered to the agent = the agent outcome that
    // commits its pending composition (bills the typing bursts, capped at
    // credit). Fires for every user message, but only a steer/followUp submit
    // stages a pending — the initial/normal prompt (no `streamingBehavior`)
    // leaves `pendingSteers` empty, so this is a no-op for them.
    if (isUserMessage(event.message)) {
      commitPendingSteer(ctx ?? lastCtx);
    }
    const m = asAssistant(event.message);
    if (!m) return;
    const now = Date.now();
    fb.currentMessageStartMs = now;
    fb.messageCount += 1;
    fb.lastUpdateMs = now;
    fb.inStall = false;
    fb.firstTokenMs = 0;
  });

  pi.on('message_update', (event) => {
    const m = asAssistant(event.message);
    if (!m) return;
    const now = Date.now();
    if (fb.firstTokenMs === 0) {
      fb.firstTokenMs = now;
      fb.lastUpdateMs = now;
      return;
    }
    const gap = now - fb.lastUpdateMs;
    if (gap >= STALL_THRESHOLD_MS) {
      if (!fb.inStall) fb.stallCount += 1;
      fb.inStall = true;
      fb.stallMs += gap;
    } else {
      fb.inStall = false;
    }
    fb.lastUpdateMs = now;
  });

  pi.on('message_end', (event) => {
    const m = asAssistant(event.message);
    if (!m) return;
    const now = Date.now();
    if (fb.currentMessageStartMs) {
      fb.totalGenerationMs += now - fb.currentMessageStartMs;
      fb.currentMessageStartMs = 0;
    }
    if (m.usage) {
      fb.tokens.input += m.usage.input || 0;
      fb.tokens.output += m.usage.output || 0;
      fb.tokens.total += m.usage.totalTokens || 0;
    }
    if (m.provider && m.model && !fb.model) fb.model = { provider: m.provider, modelId: m.model };
    fb.lastUpdateMs = now;
  });

  // ── Agent segment ──────────────────────────────────────────────────────
  // High fidelity from pi-tps when present; otherwise a fallback measured
  // at turn_end. Exactly one segment is written per turn regardless of
  // extension load order — a 'fallback' may be corrected by a later 'tps'
  // entry for the same turnIndex (rehydrate keeps the last per turnIndex).

  // ── pi-retry capture ─────────────────────────────────────────────────
  // @monotykamary/pi-retry emits started/completed/cancelled around its
  // (possibly multi-attempt) retry loop. agent_settled can land during a
  // retry's backoff sleep — before pi-retry has re-prompted — so without this
  // capture the engagement wizard would pop mid-retry, billing the backoff as
  // human time (violating scale-to-zero: a slow/queued provider is a retry,
  // not billable). Defer the settled prompt until the retry settles: pop on
  // 'completed' (if still no credit), never on 'cancelled', never while one is
  // in flight. Unsubscribed at session_shutdown (a session-scoped resource);
  // the factory re-binds on the next session. Mirrors localterm's agent-notify.
  retryUnsubs.push(
    pi.events.on(PI_RETRY_STARTED_EVENT, (event: unknown) => {
      retryActiveId = retryEventId(event);
    })
  );
  retryUnsubs.push(
    pi.events.on(PI_RETRY_COMPLETED_EVENT, (event: unknown) => {
      if (retryEventId(event) !== retryActiveId) return;
      retryActiveId = undefined;
      const pending = pendingSettledWizard;
      if (!pending) return;
      pendingSettledWizard = null;
      // Credit may have changed since settle (e.g. a mid-backoff /ledger-extend);
      // with none, pop now that the retry has settled. With credit, stay quiet.
      if (extensionBudgetMs <= 0) armEngagementPrompt(pending.ctx);
    })
  );
  retryUnsubs.push(
    pi.events.on(PI_RETRY_CANCELLED_EVENT, (event: unknown) => {
      if (retryEventId(event) !== retryActiveId) return;
      retryActiveId = undefined;
      pendingSettledWizard = null; // abort/session-change → no prompt
    })
  );

  // pi-queue-steer backlog feed (see QUEUE_STEER_STATE_EVENT). Tracks the
  // parked-row count as a fallback for the settle gate and re-offers a
  // suppressed wizard when the backlog drains without starting a run. The
  // re-offer is grace-deferred (QUEUE_STEER_REARM_MS): a drain that FEEDS a
  // run (dispatch at an agent boundary or from idle) produces agent_start
  // within the window — or leaves native follow-ups pending — and a parked
  // backlog that refills re-reads non-zero at fire time, so the prompt only
  // lands on a genuinely idle, queue-empty session.
  pi.events.on(QUEUE_STEER_STATE_EVENT, (data: unknown) => {
    const snapshot = (data ?? {}) as QueueSteerSnapshot;
    if (typeof snapshot.pending === 'number') queueSteerEventPending = snapshot.pending;
    if (queueSteerPending() > 0 || !queueSteerSuppressed) return;
    clearQueueSteerRearm();
    queueSteerRearmTimer = setTimeout(() => {
      queueSteerRearmTimer = null;
      // A backlog that refilled during the grace keeps the suppression; the
      // next drain event re-arms.
      if (queueSteerPending() > 0) return;
      queueSteerSuppressed = false;
      if (agentRunning || wizardOpen || extensionBudgetMs > 0 || !lastCtx) return;
      if (lastCtx.hasPendingMessages()) return; // the drain fed a native follow-up
      if (retryActiveId !== undefined) {
        pendingSettledWizard = { ctx: lastCtx };
      } else {
        armEngagementPrompt(lastCtx);
      }
    }, QUEUE_STEER_REARM_MS);
  });

  pi.events.on(TPS_TELEMETRY_EVENT, (payload: unknown) => {
    const t = payload as TpsTelemetry | null;
    if (!t || !t.timing || !t.tokens || !t.model) return;
    tpsEverSeen = true;
    const generationMs = Number.isFinite(t.timing.generationMs) ? t.timing.generationMs : 0;
    const stallMs = Number.isFinite(t.timing.stallMs) ? t.timing.stallMs : 0;
    const toolMs = toolMsThisTurn;
    // Bill generation by output tokens at the reference TPS (speed-invariant);
    // the real generationMs/stallMs above are still recorded for audit.
    const agentMs = computeAgentMs(t.tokens.output || 0, toolMs, settings.referenceTps);
    if (agentMs <= 0) return;
    const supersedes =
      lastFallback && lastFallback.turnIndex === currentTurnIndex ? lastFallback.id : undefined;
    if (supersedes) {
      totals.agentMs -= lastFallback!.agentMs;
      totals.agentTurns -= 1;
      totals.agentTokens.input -= lastFallback!.tokens.input;
      totals.agentTokens.output -= lastFallback!.tokens.output;
      totals.agentTokens.total -= lastFallback!.tokens.total;
      totals.agentGenMs -= lastFallback!.agentMs - lastFallback!.toolMs;
      totals.agentToolMs -= lastFallback!.toolMs;
      totals.stallMs -= lastFallback!.stallMs;
      if (lastFallback!.toolMs > 0) totals.toolTurns -= 1;
      if (lastFallback!.stallMs > 0) totals.stalledTurns -= 1;
      lastFallback = null;
    }
    appendSidecar({
      kind: 'agent',
      id: randomUUID(),
      turnIndex: currentTurnIndex,
      agentMs,
      generationMs,
      stallMs,
      toolMs,
      tokens: {
        input: t.tokens.input || 0,
        output: t.tokens.output || 0,
        total: t.tokens.total || 0,
      },
      model: t.model,
      source: 'tps',
      supersedes,
      timestamp: Date.now(),
    });
    totals.agentMs += agentMs;
    totals.agentTurns += 1;
    totals.agentTokens.input += t.tokens.input || 0;
    totals.agentTokens.output += t.tokens.output || 0;
    totals.agentTokens.total += t.tokens.total || 0;
    totals.agentGenMs += agentMs - toolMs;
    totals.agentToolMs += toolMs;
    totals.stallMs += stallMs;
    if (toolMs > 0) totals.toolTurns += 1;
    if (stallMs > 0) totals.stalledTurns += 1;
    updateStatus(lastCtx);
  });

  // Fallback: pi-tps absent for this turn → measure ourselves at turn_end.
  pi.on('turn_end', (event, ctx) => {
    lastCtx = ctx;
    if (tpsEverSeen) return; // pi-tps present; it handles turns (or intentionally skips)
    if (fb.messageCount === 0 || !fb.model) return;
    const toolMs = toolMsThisTurn;
    // Bill generation by output tokens at the reference TPS (speed-invariant);
    // the real totalGenerationMs/stallMs are still recorded for audit.
    const agentMs = computeAgentMs(fb.tokens.output || 0, toolMs, settings.referenceTps);
    if (agentMs <= 0) return;
    const id = randomUUID();
    appendSidecar({
      kind: 'agent',
      id,
      turnIndex: event.turnIndex,
      agentMs,
      generationMs: fb.totalGenerationMs,
      stallMs: fb.stallMs,
      toolMs,
      tokens: { input: fb.tokens.input, output: fb.tokens.output, total: fb.tokens.total },
      model: fb.model,
      source: 'fallback',
      timestamp: Date.now(),
    });
    totals.agentMs += agentMs;
    totals.agentTurns += 1;
    totals.agentTokens.input += fb.tokens.input;
    totals.agentTokens.output += fb.tokens.output;
    totals.agentTokens.total += fb.tokens.total;
    totals.agentGenMs += agentMs - toolMs;
    totals.agentToolMs += toolMs;
    totals.stallMs += fb.stallMs;
    if (toolMs > 0) totals.toolTurns += 1;
    if (fb.stallMs > 0) totals.stalledTurns += 1;
    lastFallback = {
      id,
      turnIndex: event.turnIndex,
      agentMs,
      toolMs,
      stallMs: fb.stallMs,
      tokens: { input: fb.tokens.input, output: fb.tokens.output, total: fb.tokens.total },
    };
    updateStatus(ctx);
  });

  // ── Human idle windows ────────────────────────────────────────────────

  pi.on('agent_start', (_event, ctx) => {
    lastCtx = ctx;
    agentRunning = true;
    steerStaging = []; // a new run starts; any prior staging is stale
    lastKey = null;
    lastKeyTime = 0;
    // A submitted prompt is the agent action that COMMITS the idle window —
    // its idle (from the engagement onset) bills now, capped at credit.
    // If the human never engaged (no keystroke, no extension), there's no
    // window to close and the turn handoff bills nothing.
    closeHumanWindow(ctx, true);
    // A new run supersedes any deferred settled prompt (a retry turn, a queued
    // follow-up, or a fresh prompt all re-settle later — agent_settled
    // re-evaluates then). Keeps a pi-retry that completes after a retry
    // turn's agent_end from popping on a stale 'settled' until that run settles.
    pendingSettledWizard = null;
    // A queue-steer backlog that starts running re-settles at its end — the
    // drain re-offer only matters while the session stays parked and idle.
    queueSteerSuppressed = false;
    clearQueueSteerRearm();
    // A run starting supersedes the docked prompt (a queued dispatch can start
    // one without typing); the next settle re-evaluates.
    closeWizardPrompt(ctx);
  });

  pi.on('agent_end', (_event, ctx) => {
    lastCtx = ctx;
    agentRunning = false;
    // Discard any uncommitted in-run typing: a steer/followUp that was never
    // submitted never reached the agent, so it bills nothing (a submitted
    // steer already moved its bursts to a pending composition at submit).
    // Pending compositions survive agent_end — they deliver in a later run
    // (a followUp) or were already delivered mid-run (a steer) — so they're
    // NOT abandoned here. The post-turn idle window opens only on the next
    // engagement — no backdate — so mid-run typing that isn't actually
    // queued/steered can't inflate it.
    steerStaging = [];
    lastKey = null;
    lastKeyTime = 0;
    if (!tpsEverSeen && !fallbackNotified) {
      fallbackNotified = true;
      notify(
        ctx,
        'pi-ledger: built-in timing in use (pi-tps not detected; install @monotykamary/pi-tps for refined stall detection).',
        'info'
      );
    }
    // The engagement prompt (wizard) and the post-turn idle window are NOT
    // armed here — they live at `agent_settled` (see below). agent_end fires
    // per low-level run, but Pi may still auto-retry, auto-compact and retry,
    // or continue with a queued follow-up; popping here would prompt the human
    // to engage during that in-flight time, billing a retry backoff or an
    // overflow compaction as human time (violating scale-to-zero: a
    // slow/queued provider is a retry, not billable). The earlier stopReason
    // "error" heuristic only caught provider-error retries, missing overflow
    // compactions and queued follow-ups; agent_settled is the pi-core-blessed
    // "no more automatic continuation" signal, so it needs no such heuristic.
  });

  pi.on('agent_settled', (_event, ctx) => {
    lastCtx = ctx;
    // The agent will not continue automatically — no retry, compaction, or
    // queued follow-up is left — so this is the genuine human handoff moment.
    // The idle window is NOT opened here — it opens only when the human
    // engages (first keystroke or extension). Until then, idle bills nothing.
    // If the human has no rolling credit (hasn't extended), pop the wizard now
    // to prompt that engagement (an extension both engages and grants
    // capacity). With credit, stay quiet — the window opens on the first
    // keystroke and arms for exhaustion then. This also re-offers the prompt
    // after a retry storm exhausts — the last errored agent_end no longer
    // suppresses it, since the run has now settled and the human must take
    // over.
    if (extensionBudgetMs <= 0) {
      // @monotykamary/pi-retry (if installed) drives its own retry loop with
      // backoff sleeps outside processEvents; pi-core's settlement detection
      // can fire this agent_settled during that backoff — before pi-retry has
      // decided whether to re-prompt. Popping then would bill the backoff as
      // human time (violating scale-to-zero: a slow/queued provider is a
      // retry, not billable). Defer: if a pi-retry is in flight, stage the
      // prompt and pop when the retry settles (on pi-retry:completed); a
      // cancelled retry never pops. With no pi-retry (or none active), prompt
      // as before — idle-gated now, so an actively-typing human isn't interrupted.
      if (queueSteerPending() > 0) {
        // pi-queue-steer parks rows outside pi-core's native queues (a paused
        // backlog, a blocking control row, one-at-a-time rows awaiting their
        // boundary): the session still has queued work, so this settle is a
        // pause, not a human handoff. Hold the wizard; the queue-steer drain
        // event re-offers it if the backlog empties without starting a run.
        queueSteerSuppressed = true;
      } else if (retryActiveId !== undefined) {
        pendingSettledWizard = { ctx };
      } else {
        armEngagementPrompt(ctx);
      }
    }
  });

  // The `input` event fires for every interactive submit that isn't a slash
  // command (pi-core runs registered slash commands before emitting `input`),
  // so this is the choke point to guard agent messages when billing is
  // skipped. Steering composition is also submitted here (see below).
  pi.on('input', (event, ctx): InputEventResult | void => {
    lastCtx = ctx;
    // Skip-billing guard: if the human chose "Stop billing" in the wizard,
    // block interactive prompts/steers from reaching the agent until they
    // extend via /ledger-extend. Returning "handled" tells pi-core to drop the
    // input (no agent turn). Slash commands are unaffected — pi-core executes
    // them before `input` fires — so /ledger-extend still works to resume.
    // Programmatic sources (extension/rpc) are left alone so other extensions'
    // workflows aren't blocked by a human billing decision.
    if (billingPaused && event.source === 'interactive') {
      notify(
        ctx,
        'Billing is paused — run /ledger-extend to extend your time and resume.',
        'warning'
      );
      return { action: 'handled' };
    }
    const behavior = event.streamingBehavior;
    if (behavior !== 'steer' && behavior !== 'followUp') return; // only mid-run
    if (event.source !== 'interactive') return; // only human-typed steers
    // Queued to the agent — stage the composition as PENDING, billed at
    // delivery (the agent outcome), not here. A no-typing submit (paste / no
    // keystrokes) with no prior dequeue stages nothing and bills nothing.
    stagePendingSteer(ctx, behavior);
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand('ledger', {
    description: 'Show running billable totals (agent + human hours, total).',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const t = computeDisplayTotals(ctx);
      const b = computeBilling(t.agentMs, t.humanMs, settings);
      const msg =
        `agent ${fmtHours(t.agentMs)} (${t.agentTurns} turns) @ ${fmtMoney(settings.agentRatePerHour, settings.currency)}/h = ${fmtMoney(b.agentCost, settings.currency)}` +
        ` · human ${fmtHours(t.humanMs)} (${t.humanWindows} windows) @ ${fmtMoney(settings.humanRatePerHour, settings.currency)}/h = ${fmtMoney(b.humanCost, settings.currency)}` +
        ` · total ${fmtMoney(b.total, settings.currency)}` +
        (chainStatus === 'tampered' ? ' · ⚠ chain broken (sidecar failed notarization)' : '');
      ctx.ui.notify(msg, 'info');
      if (totals.agentTurns === 0 && totals.humanWindows === 0) {
        const tps = extractTpsEntries(ctx.sessionManager.getBranch());
        if (tps.length > 0) {
          ctx.ui.notify(
            `Derived from ${tps.length} pi-tps markers (lower fidelity: no tool time; human time estimated).`,
            'info'
          );
        }
      }
    },
  });

  pi.registerCommand('ledger-extend', {
    description:
      'Open the human-time wizard to extend the billing window by N minutes (default: pomodoro length); confirm or stop in the dialog.',
    getArgumentCompletions: (argumentPrefix: string) => {
      const presets = [String(settings.pomodoroMinutes), '40', '60', '90', '120'];
      return presets
        .filter((p) => p.startsWith(argumentPrefix))
        .map((p) => ({ value: p, label: `${p}m` }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI || (ctx.mode !== 'tui' && ctx.mode !== 'rpc')) {
        ctx.ui.notify(
          'Open the wizard in a TUI or GUI session (extend after the agent finishes a turn).',
          'warning'
        );
        return;
      }
      // Works with or without an open window: with no window, extend engages
      // one (onset = now) and grants the block — an explicit engagement signal.
      // TUI renders the custom wizard; RPC (e.g. vscode-pi) renders a `select`.
      const mins = parseMinutes(args) ?? settings.pomodoroMinutes;
      showWizard(ctx, mins);
    },
  });

  pi.registerCommand('ledger-settings', {
    description:
      'Configure billing: agent $/h, human $/h, pomodoro minutes, project, author, currency, auto-wizard, auto-extend.',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // RPC/GUI (e.g. vscode-pi): a `select` -> `input`/`select` flow, since the
      // custom SettingsList only renders in the terminal. One setting per run.
      if (ctx.mode !== 'tui') {
        if (!ctx.hasUI) {
          ctx.ui.notify('/ledger-settings requires a UI (TUI or GUI)', 'error');
          return;
        }
        const items = rpcSettingItems(ctx);
        const pick = await ctx.ui.select(
          'pi-ledger · billing settings — pick a setting to change',
          items.map((i) => `${i.label}: ${i.current}`)
        );
        if (pick === undefined) return; // dismissed
        const item = items.find((i) => pick.startsWith(`${i.label}:`));
        if (!item) return;
        if (item.readOnly) {
          // Identity rows display the notarization key for registration; pick
          // one to echo the full value (e.g. to copy the public key).
          ctx.ui.notify(`${item.label}: ${item.current}`, 'info');
          return;
        }
        let value: string | undefined;
        if (item.values) {
          value = await ctx.ui.select(item.label, item.values);
        } else {
          value = await ctx.ui.input(`New value for ${item.label}`, item.current);
        }
        if (value === undefined || value.trim() === '') return;
        settings = applySettingValue(settings, item.id, value.trim());
        persistSettings();
        updateStatus(ctx);
        ctx.ui.notify(
          `Saved ${item.label} = ${value.trim()}. Run /ledger-settings for more.`,
          'info'
        );
        return;
      }
      // TUI: the rich searchable SettingsList (submenus, inline edit).
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(
          new Text(theme.fg('accent', theme.bold('pi-ledger · billing settings')), 1, 0)
        );
        container.addChild(new Text(theme.fg('muted', 'billed like serverless'), 1, 0));

        let list: SettingsList;
        const items = buildSettingItems(theme, ctx);
        list = new SettingsList(
          items,
          Math.min(items.length + 2, 16),
          getSettingsListTheme(),
          (id: string, newValue: string) => {
            settings = applySettingValue(settings, id, newValue);
            persistSettings();
            const refreshed = buildSettingItems(theme, ctx).find((i) => i.id === id);
            if (refreshed) list.updateValue(id, refreshed.currentValue);
            updateStatus(ctx);
          },
          () => done(undefined),
          { enableSearch: true }
        );
        container.addChild(list);
        container.addChild(
          new Text(theme.fg('dim', '↑↓ navigate · / search · enter edit · esc close'), 1, 0)
        );
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
          },
        };
      });
    },
  });

  pi.registerCommand('ledger-receipt', {
    description:
      'Export an itemized HTML invoice for this session (agent + human line items at their hourly rates, with a total).',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // Entire-session totals: live ledger data + the in-progress open human
      // window, or — if pi-ledger tracked nothing — derived from pi-tps markers
      // (including the trailing idle up to now).
      const t = computeDisplayTotals(ctx);
      const b = computeBilling(t.agentMs, t.humanMs, settings);

      let startedAt = earliestSidecarTimestamp();
      const tpsEntries = extractTpsEntries(ctx.sessionManager.getBranch());
      // When pi-ledger has no live data (a resumed pi-tps-only session whose
      // only sidecar event may be the initial human-open), fall back to the
      // first pi-tps marker for the receipt's start date.
      const noLiveData = totals.agentTurns === 0 && totals.humanWindows === 0;
      if ((startedAt === 0 || noLiveData) && tpsEntries.length > 0) {
        startedAt = tpsEntries[0]!.timestamp;
      }
      if (noLiveData && tpsEntries.length > 0) {
        ctx.ui.notify(
          `Receipt derived from ${tpsEntries.length} pi-tps markers (lower fidelity: no tool time; human time estimated; includes idle up to now).`,
          'info'
        );
      }

      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      // Notarization: a receipt for a still-OPEN chained session appends a
      // checkpoint seal first, so the audit block attests the current chain
      // head. The checkpoint never disrupts later appends — the chain
      // continues (seq increments) and a real close at shutdown re-seals the
      // new head. Legacy logs render an unattested footer.
      if (chainStatus === 'open') appendSessionClose(true);
      let seal: ReceiptSeal | undefined;
      if (chainMode === 'legacy') {
        seal = { status: 'legacy', sessionId };
      } else if (chainMode === 'chained') {
        seal = {
          status: chainStatus,
          sessionId,
          kid: latestSeal?.kid,
          head: latestSeal?.head,
          signature: latestSeal?.headSig,
        };
      }
      const data: ReceiptData = {
        project: effectiveProject(ctx),
        author: effectiveAuthor(),
        sessionId: sessionId.slice(0, 8),
        currency: settings.currency,
        agentRate: settings.agentRatePerHour,
        humanRate: settings.humanRatePerHour,
        agentHours: b.agentHours,
        humanHours: b.humanHours,
        agentCost: b.agentCost,
        humanCost: b.humanCost,
        total: b.total,
        agentTurns: t.agentTurns,
        humanWindows: t.humanWindows,
        agentTokens: { ...t.agentTokens },
        startedAt,
        generatedAt: Date.now(),
        // Itemized sub-totals (computeDisplayTotals spreads the live cache +
        // the in-progress window/steer; remaining credit = granted − consumed).
        agentGenMs: t.agentGenMs,
        agentToolMs: t.agentToolMs,
        stallMs: t.stallMs,
        toolTurns: t.toolTurns,
        stalledTurns: t.stalledTurns,
        humanIdleMs: t.humanIdleMs,
        humanSteerMs: t.humanSteerMs,
        humanQueueMs: t.humanQueueMs,
        idleWindows: t.idleWindows,
        steerCount: t.steerCount,
        queueCount: t.queueCount,
        idleKeystrokes: t.idleKeystrokes,
        steerKeystrokes: t.steerKeystrokes,
        queueKeystrokes: t.queueKeystrokes,
        abandonedWindows: t.abandonedWindows,
        abandonedMs: t.abandonedMs,
        extensionsGranted: t.extensionsGranted,
        extensionCreditMs: t.extensionCreditMs,
        extensionConsumedMs: t.extensionConsumedMs,
        seal,
      };
      const html = buildReceiptHtml(data);

      const cacheBase = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      const dir = join(cacheBase, 'pi-ledger');
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filepath = join(dir, `receipt-${sessionId.slice(0, 8)}-${ts}.html`);
      writeFileSync(filepath, html);

      try {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execSync(`${opener} ${JSON.stringify(filepath)}`, { stdio: 'ignore' });
      } catch {
        // opener unavailable — the file is still written
      }
      ctx.ui.notify(`Receipt → ${filepath}`, 'info');
    },
  });

  // ── Helpers requiring ctx ─────────────────────────────────────────────

  /** Setting descriptors for the RPC/GUI `/ledger-settings` flow (a `select`
   *  -> `input`/`select` dialog). Mirrors `buildSettingItems` without the TUI
   *  `submenu` factories (which need a terminal to render). */
  interface RpcSettingItem {
    id: string;
    label: string;
    current: string;
    values?: string[];
    /** Display-only (notarization identity): picking echoes the value. */
    readOnly?: boolean;
  }

  function rpcSettingItems(ctx: ExtensionCommandContext): RpcSettingItem[] {
    return [
      { id: 'agentRatePerHour', label: 'Agent rate', current: fmtRate(settings.agentRatePerHour) },
      { id: 'humanRatePerHour', label: 'Human rate', current: fmtRate(settings.humanRatePerHour) },
      {
        id: 'pomodoroMinutes',
        label: 'Pomodoro minutes',
        current: String(settings.pomodoroMinutes),
      },
      {
        id: 'resumeGraceMinutes',
        label: 'Resume grace (min)',
        current: String(settings.resumeGraceMinutes),
      },
      { id: 'referenceTps', label: 'Reference TPS', current: fmtTps(settings.referenceTps) },
      { id: 'project', label: 'Project', current: settings.project || basename(ctx.cwd) },
      { id: 'author', label: 'Author', current: settings.author || defaultAuthor() },
      {
        id: 'currency',
        label: 'Currency',
        current: settings.currency,
        values: ['USD', 'EUR', 'GBP', 'JPY', 'VND', 'AUD', 'CAD', 'SGD'],
      },
      {
        id: 'autoWizard',
        label: 'Auto-wizard',
        current: settings.autoWizard ? 'on' : 'off',
        values: ['on', 'off'],
      },
      {
        id: 'autoExtend',
        label: 'Auto-extend',
        current: settings.autoExtend ? 'on' : 'off',
        values: ['on', 'off'],
      },
      {
        id: 'identityKid',
        label: 'Identity key id',
        current: getIdentity()?.kid ?? '(unavailable)',
        readOnly: true,
      },
      {
        id: 'identityPublicKey',
        label: 'Identity public key',
        current: getIdentity()?.publicKey ?? '(unavailable)',
        readOnly: true,
      },
    ];
  }

  function buildSettingItems(theme: Theme, ctx: ExtensionContext): SettingItem[] {
    return [
      {
        id: 'agentRatePerHour',
        label: 'Agent rate',
        currentValue: fmtRate(settings.agentRatePerHour),
        description: 'Hourly rate billed for agent work',
        submenu: numberSubmenu(theme, 'Agent $/hour'),
      },
      {
        id: 'humanRatePerHour',
        label: 'Human rate',
        currentValue: fmtRate(settings.humanRatePerHour),
        description: 'Hourly rate billed for human work',
        submenu: numberSubmenu(theme, 'Human $/hour'),
      },
      {
        id: 'pomodoroMinutes',
        label: 'Pomodoro minutes',
        currentValue: String(settings.pomodoroMinutes),
        description: 'Minutes added per extension (wizard · /ledger-extend)',
        submenu: numberSubmenu(theme, 'Pomodoro minutes'),
      },
      {
        id: 'resumeGraceMinutes',
        label: 'Resume grace (min)',
        currentValue: String(settings.resumeGraceMinutes),
        description:
          'Billable human-time block provisioned on /resume · /reload (0 = prompt instead)',
        submenu: numberSubmenu(theme, 'Resume grace minutes'),
      },
      {
        id: 'referenceTps',
        label: 'Reference TPS',
        currentValue: fmtTps(settings.referenceTps),
        description: 'Output tokens/sec to normalize generation to (frontier avg ≈ 75)',
        submenu: numberSubmenu(theme, 'Reference TPS'),
      },
      {
        id: 'project',
        label: 'Project',
        currentValue: settings.project || basename(ctx.cwd),
        description: 'Project name shown on the receipt',
        submenu: textSubmenu(theme, 'Project name'),
      },
      {
        id: 'author',
        label: 'Author',
        currentValue: settings.author || defaultAuthor(),
        description: 'Author / operator shown on the receipt',
        submenu: textSubmenu(theme, 'Author name'),
      },
      {
        id: 'currency',
        label: 'Currency',
        currentValue: settings.currency,
        description: 'Currency symbol for amounts',
        values: ['USD', 'EUR', 'GBP', 'JPY', 'VND', 'AUD', 'CAD', 'SGD'],
      },
      {
        id: 'autoWizard',
        label: 'Auto-wizard',
        currentValue: settings.autoWizard ? 'on' : 'off',
        description: 'Auto-popup to prompt extending when billable credit runs out',
        values: ['on', 'off'],
      },
      {
        id: 'autoExtend',
        label: 'Auto-extend',
        currentValue: settings.autoExtend ? 'on' : 'off',
        description:
          'Auto-provision a pomodoro block silently (no prompt) when credit runs out — for GUI/headless sessions',
        values: ['on', 'off'],
      },
      // Notarization identity (read-only rows): register the public key in
      // app.inloop.studio admin so delivered logs verify as sealed.
      {
        id: 'identityKid',
        label: 'Identity key id',
        currentValue: getIdentity()?.kid ?? '(unavailable)',
        description: 'Signing identity (kid) of this meter — shown on sealed session receipts',
      },
      {
        id: 'identityPublicKey',
        label: 'Identity public key',
        currentValue: getIdentity()?.publicKey ?? '(unavailable)',
        description: 'Ed25519 public key (base64) — register it in app.inloop.studio admin',
      },
    ];
  }

  function numberSubmenu(theme: Theme, placeholder: string) {
    return (_currentValue: string, done: (selectedValue?: string) => void) => {
      const input = new Input();
      input.focused = true;
      input.onSubmit = (v) => done(v);
      input.onEscape = () => done();
      const box = new Container();
      box.addChild(
        new Text(
          theme.fg('muted', placeholder + ' — type a value · enter saves · esc cancels'),
          1,
          0
        )
      );
      box.addChild(input);
      return {
        render: (w: number) => box.render(w),
        invalidate: () => box.invalidate(),
        handleInput: (data: string) => input.handleInput(data),
      };
    };
  }

  function textSubmenu(theme: Theme, placeholder: string) {
    return (_currentValue: string, done: (selectedValue?: string) => void) => {
      const input = new Input();
      input.focused = true;
      input.onSubmit = (v) => done(v);
      input.onEscape = () => done();
      const box = new Container();
      box.addChild(
        new Text(
          theme.fg('muted', placeholder + ' — type a value · enter saves · esc cancels'),
          1,
          0
        )
      );
      box.addChild(input);
      return {
        render: (w: number) => box.render(w),
        invalidate: () => box.invalidate(),
        handleInput: (data: string) => input.handleInput(data),
      };
    };
  }

  function earliestSidecarTimestamp(): number {
    let earliest = 0;
    for (const e of readSidecar()) {
      if (e.kind === 'settings') continue;
      if (earliest === 0 || e.timestamp < earliest) earliest = e.timestamp;
    }
    return earliest;
  }
}

// ─── Module-local helpers ──────────────────────────────────────────────────

/** Editor wrapper that observes keystrokes so pi-ledger can meter steering
 *  composition while the agent runs. Extends `CustomEditor` (app keybindings,
 *  escape-to-abort, ctrl+d, model switching, autocomplete, …) and delegates
 *  every keystroke to the base editor; additions are a lightweight `onKeystroke`
 *  callback fired before `super.handleInput` (stages a typing burst) and an
 *  `onDequeue` callback fired when the human reverts a queued message back to
 *  the editor (alt+up). Both are trivial and never throw, so input is never
 *  blocked. */
class LedgerEditor extends CustomEditor {
  private readonly kb: KeybindingsManager;
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly onKeystroke: (data: string) => void,
    private readonly onDequeue: () => void,
    private readonly onWizardKey: (data: string, isShowingAutocomplete: () => boolean) => boolean
  ) {
    super(tui, theme, keybindings);
    this.kb = keybindings;
  }
  override handleInput(data: string): void {
    // While the docked wizard prompt shows, it owns ↑/↓/enter/escape (the
    // queue-steer interception pattern): select/confirm/dismiss, consuming
    // the key so the editor never sees it. Everything else falls through —
    // typing keeps the box docked.
    const isShowingAutocomplete = (): boolean =>
      (this as unknown as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() ??
      false;
    if (this.onWizardKey(data, isShowingAutocomplete)) return;
    // The dequeue (alt+up) and followUp (alt+enter) actions are submits/edits,
    // not composition typing — don't stage them as steer bursts. Dequeue also
    // signals pi-ledger that a queued composition reverted to the editor, so its
    // typing carries forward to the next submit (not abandoned here). Matched by
    // action id, so a rebound key still fires; only a fully-unbound
    // app.message.dequeue would be missed (then revert/re-steer degrades to the
    // pre-fix no-bill — never over-billing).
    if (this.kb.matches(data, 'app.message.dequeue')) {
      this.onDequeue();
      super.handleInput(data); // run the copied handler → restore text to editor
      return;
    }
    if (this.kb.matches(data, 'app.message.followUp')) {
      super.handleInput(data); // queue the followUp (the `input` event stages it)
      return;
    }
    this.onKeystroke(data);
    super.handleInput(data);
  }
}

function defaultAuthor(): string {
  try {
    return userInfo().username || 'operator';
  } catch {
    return 'operator';
  }
}

/** Narrow an AgentMessage to its assistant fields (for fallback timing). */
function asAssistant(message: unknown): {
  role?: string;
  usage?: { input?: number; output?: number; totalTokens?: number };
  provider?: string;
  model?: string;
} | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as {
    role?: string;
    usage?: { input?: number; output?: number; totalTokens?: number };
    provider?: string;
    model?: string;
  };
  return m.role === 'assistant' ? m : null;
}

/** Narrow to a user message (a queued steer/followUp delivered to the agent).
 *  Mirrors `asAssistant`'s safe `unknown` cast. */
function isUserMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  return (message as { role?: string }).role === 'user';
}
