/**
 * pi-ledger — Timesheet maker for pi
 *
 * Bills human + agent time like serverless: metered per-invocation,
 * scale-to-zero idle. Consumes pi-tps's `tps:telemetry` event for
 * per-turn agent timing and tracks tool-execution time itself; meters
 * human idle windows with a grace minute plus pomodoro extensions.
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
 * submit, bills nothing (idle with no output is wasted). Capped by a granted
 * budget (grace + rolling extension credit). A non-blocking wizard prompts
 * engagement (agent_end with no credit, /resume) and offers +pomodoro
 * extensions; `/ledger-extend` does the same manually. Extensions are ROLLING
 * credit — provisioned pomodoro blocks survive across agent turns, so the
 * wizard stays silent while credit remains and only re-pops when it's
 * exhausted.
 *
 * Commands: /ledger, /ledger-settings, /ledger-extend [m], /ledger-receipt
 *
 * Standalone but pi-tps-aware: works on its own, and uses pi-tps's
 * `tps:telemetry` event for refined per-turn timing when present.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {
  CustomEditor,
  DynamicBorder,
  getSelectListTheme,
  getSettingsListTheme,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  type EditorTheme,
  type SelectItem,
  type SettingItem,
  type TUI,
} from '@earendil-works/pi-tui';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Event emitted by @monotykamary/pi-tps after each turn with per-turn telemetry (optional). */
const TPS_TELEMETRY_EVENT = 'tps:telemetry';

/** Custom entry type written by @monotykamary/pi-tps into the session JSONL. */
const TPS_CUSTOM_TYPE = 'tps';

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
  graceMinutes: 1,
  pomodoroMinutes: 20,
  referenceTps: 75,
  project: '',
  author: '',
  currency: 'USD',
  autoWizard: true,
};

// ─── Data types ─────────────────────────────────────────────────────────────

export interface LedgerSettings {
  agentRatePerHour: number;
  humanRatePerHour: number;
  graceMinutes: number;
  pomodoroMinutes: number;
  /** Output tokens/sec generation is normalized to (frontier-model average ≈ 75).
   *  Higher → less normalized time → a lower bill for fast models. */
  referenceTps: number;
  project: string;
  author: string;
  currency: string;
  autoWizard: boolean;
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
 *  `grantedBudgetMs` is this window's billing cap = grace + `extensionBudgetMs`. */
export interface HumanOpenEvent {
  kind: 'human-open';
  openedAt: number;
  grantedBudgetMs: number;
  extensions: number;
  /** How the window engaged: "keystroke" (first key typed) or "extension"
   *  (the wizard's extend / `/ledger-extend` — which both grant capacity and
   *  count as engagement). Optional on legacy events; backfilled to
   *  "keystroke" on replay. */
  engagedVia?: 'keystroke' | 'extension';
  /** Remaining rolling extension budget at the time of this event. Optional
   *  on legacy events; backfilled from `grantedBudgetMs` − grace on replay. */
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
 *  finishes). Billed as human time under the same grace + rolling-credit cap
 *  as an idle window. The editor hook stages every keystroke during the run;
 *  on submit, the active-typing burst sum (not the wall-clock span) is billed,
 *  so a single key or keys spread minutes apart bill nothing — only sustained
 *  typing that's actually queued/steered to the agent bills. Typing never
 *  submitted is discarded (it never reached the agent). */
export interface SteerEvent {
  kind: 'steer';
  /** First staged keystroke during the run. */
  startedAt: number;
  /** Submit time (the `input` event). */
  submittedAt: number;
  /** Wall-clock composition span (submittedAt − startedAt), kept for audit. */
  durationMs: number;
  /** Billed active-typing time = min(burst sum, grace + rolling credit). May
   *  be less than `durationMs` — the burst sum excludes idle gaps before and
   *  between typing. */
  billedMs: number;
  /** Number of staged keystrokes (audit). */
  keystrokes: number;
  /** How the message was delivered: "steer" (mid-stream interrupt) or
   *  "followUp" (queued until the agent finishes). */
  behavior: 'steer' | 'followUp';
  /** The window's billing cap = grace + rolling extension budget at submit. */
  grantedBudgetMs: number;
  /** Remaining rolling extension budget after this steer (carried forward). */
  extensionBudgetMs: number;
  timestamp: number;
}

/** A settings snapshot (rates, grace, project, …). Last one wins on replay. */
export interface SettingsEvent {
  kind: 'settings';
  settings: LedgerSettings;
  timestamp: number;
}

/** The sidecar event log: per-session, append-only, survives compaction. */
export type SidecarEvent =
  | SettingsEvent
  | AgentEvent
  | HumanOpenEvent
  | HumanCloseEvent
  | SteerEvent;

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
  // granted (ms), and credit consumed (billed beyond grace). Remaining =
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
  graceMinutes?: number;
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
 *  The first `graceMs` of every idle window is always billable (per-window,
 *  never rolls). Only the billed time BEYOND grace eats into the rolling
 *  extension credit, capped at what was provisioned. Pure. */
export function consumeExtensionBudget(
  billedMs: number,
  graceMs: number,
  extensionBudgetMs: number
): number {
  return Math.min(Math.max(0, billedMs - graceMs), Math.max(0, extensionBudgetMs));
}

/** Resolve the rolling extension budget recorded on a human event, with a
 *  backfill for legacy sidecar entries that predate the field. Pure.
 *  @internal Exported for testing only. */
export function resolveExtensionBudget(
  e: HumanOpenEvent | HumanCloseEvent,
  graceMs: number
): number {
  if (typeof e.extensionBudgetMs === 'number') return e.extensionBudgetMs;
  if (e.kind === 'human-open') return Math.max(0, e.grantedBudgetMs - graceMs);
  // human-close: remaining = cap − max(billed, grace) (grace is free per window)
  return Math.max(0, e.grantedBudgetMs - Math.max(e.billedMs, graceMs));
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
    case 'graceMinutes': {
      const n = parseNumber(value);
      if (n !== null) next.graceMinutes = Math.max(0, Math.round(n));
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
    engagedVia: 'keystroke' | 'extension';
  } | null;
  extensionBudgetMs: number;
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
  // a close records what remains after that window's consumption.
  let extensionBudgetMs = 0;
  const closedOpenedAts = new Set<number>();
  // Apply a recorded rolling-budget value: a rise = a credit grant (one
  // block), a fall = a consumption (billed beyond grace). Mirrors the live
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
      applyBudgetDelta(
        resolveExtensionBudget(e, (settings ?? DEFAULT_SETTINGS).graceMinutes * MS_PER_MINUTE)
      );
    } else if (e.kind === 'human-open') {
      applyBudgetDelta(
        resolveExtensionBudget(e, (settings ?? DEFAULT_SETTINGS).graceMinutes * MS_PER_MINUTE)
      );
    } else if (e.kind === 'steer') {
      // A steer/followUp composed during a run is human time, billed under the
      // same grace + rolling-credit cap as an idle window. It consumes rolling
      // credit beyond grace; its `extensionBudgetMs` is the credit remaining
      // after the steer (carried forward, last wins on replay).
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
    engagedVia: 'keystroke' | 'extension';
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
  };
}

/** Path to a session's sidecar event log. Exported for tests to seed the log. */
export function sidecarPathFor(sessionId: string): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'pi-ledger', 'sessions', `${sessionId}.jsonl`);
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
 * time is estimated from inter-turn gaps — each gap is capped at the grace
 * budget (no wizard ran, so no extensions) — which mirrors the scale-to-zero
 * billing rule. When `nowMs` is given, the trailing idle after the last marker
 * (up to now) is added as a final human window, capped at grace — the
 * in-progress "last idle" minute, for display only (never persisted). @internal */
export function convertTpsEntries(
  tps: TpsMarker[],
  graceMs: number,
  referenceTps: number,
  nowMs?: number
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
  let humanMs = 0;
  let humanWindows = 0;
  let stallMs = 0;
  let stalledTurns = 0;
  for (let i = 0; i < tps.length; i++) {
    const e = tps[i]!;
    agentMs += computeAgentMs(e.tokens.output || 0, 0, referenceTps);
    agentTokens.input += e.tokens.input || 0;
    agentTokens.output += e.tokens.output || 0;
    agentTokens.total += e.tokens.total || 0;
    const sm = e.timing.stallMs || 0;
    stallMs += sm;
    if (sm > 0) stalledTurns += 1;
    if (i + 1 < tps.length) {
      const next = tps[i + 1]!;
      // next turn started ~ next.timestamp − next.totalMs; idle = that − this turn's end
      const turnStartNext = (next.timestamp || 0) - (next.timing.totalMs || 0);
      const gap = turnStartNext - (e.timestamp || 0);
      if (gap > 0) {
        humanMs += Math.min(gap, graceMs);
        humanWindows += 1;
      }
    }
  }
  // Trailing idle after the last turn, up to `nowMs` (the in-progress "last
  // idle" minute). Display-only; only added when nowMs is provided.
  if (nowMs != null && tps.length > 0) {
    const last = tps[tps.length - 1]!;
    const trailing = Math.max(0, nowMs - (last.timestamp || 0));
    if (trailing > 0) {
      humanMs += Math.min(trailing, graceMs);
      humanWindows += 1;
    }
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
    humanIdleMs: humanMs, // estimated inter-turn idle (no steering from markers)
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
  const graceMin = d.graceMinutes ?? 0;

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
      `${idleWindows} windows · ${idleKeystrokes} keystrokes` +
        (graceMin ? ` · grace ${graceMin}m/win` : ''),
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
  .foot { margin-top: 22px; font-size: 10px; color: #c2c2c2; text-align: center; }
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
  // `grantedBudgetMs` is this window's billing cap = grace + the rolling
  // extension budget carried into it.
  let humanWindow: {
    openedAt: number;
    grantedBudgetMs: number;
    extensions: number;
    engagedVia: 'keystroke' | 'extension';
  } | null = null;

  // Rolling billable-human-time budget: provisioned pomodoro credit that
  // survives across agent turns (the serverless "provisioned capacity"
  // analogy). The first grace minute of every idle window is always billable
  // and never rolls; only time beyond grace consumes this budget. The wizard
  // is suppressed at `agent_end` while this is > 0, and re-arms to fire when
  // it's exhausted.
  let extensionBudgetMs = 0;

  // Whether the agent loop is currently running (between agent_start and
  // agent_end). Steering composition is metered only while this is true — the
  // initial and idle windows already capture typing outside a run.
  let agentRunning = false;
  // Staging buffer of keystroke timestamps during the current run — the raw
  // material for billing a steer/followUp the human composes while the agent
  // works. The editor hook (`noteKeystroke`) pushes to it on every keystroke;
  // the `input` event commits it on submit (billed as a typing-burst sum) and
  // clears it. Nothing is billed until a steer/followUp is actually queued or
  // steered to the agent — an uncommitted buffer is discarded at agent_end, so
  // typing that never reaches the agent costs nothing.
  let steerStaging: number[] = [];

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
  function appendSidecar(event: SidecarEvent): void {
    if (sessionId === 'unknown' && lastCtx) {
      const id = lastCtx.sessionManager.getSessionId?.();
      if (typeof id === 'string') sessionId = id;
    }
    try {
      const p = sidecarPath();
      mkdirSync(join(p, '..'), { recursive: true });
      appendFileSync(p, JSON.stringify(event) + '\n');
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
    } else if (agentRunning && steerStaging.length > 0) {
      // In-progress steer/followUp composition during the run — no idle window
      // is open while the agent works, so show the typing-burst sum so far
      // (capped at grace + current rolling credit) like an open human window,
      // until it's submitted (then it's recorded as a `steer` event). Shows
      // active typing only, so idle gaps during composition don't accrue.
      const cap = settings.graceMinutes * MS_PER_MINUTE + extensionBudgetMs;
      openSteerMs = Math.min(computeBurstMs(steerStaging, STEER_GAP_MS), cap);
      openSteerCount = 1;
      openSteerKeystrokes = steerStaging.length;
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
        const c = convertTpsEntries(
          tps,
          settings.graceMinutes * MS_PER_MINUTE,
          settings.referenceTps,
          now
        );
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
    const text = `ledger · agent ${fmtHours(t.agentMs)} · human ${fmtHours(t.humanMs)} · ${fmtMoney(b.total, settings.currency)}`;
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
    const graceMs = settings.graceMinutes * MS_PER_MINUTE;
    // An idle window bills only when the human's submit produces agent work
    // (a prompt at `agent_start` = `committed`). Abandoned idle — the session
    // ended with no submit — bills nothing: idle time with no output is wasted.
    let billedMs: number;
    let idleMs: number;
    if (committed) {
      const r = closeWindowBudget(w.openedAt, closedAt, w.grantedBudgetMs);
      idleMs = r.idleMs;
      billedMs = r.billedMs;
      // Only billed time beyond the per-window grace consumes the rolling
      // extension budget; the leftover rolls forward to the next idle window.
      const consumed = consumeExtensionBudget(billedMs, graceMs, extensionBudgetMs);
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
   *  keystrokes), capped at `grace + credit`, but ONLY when committed by a
   *  submitted prompt at `agent_start` — abandoned idle bills 0. `engagedVia`
   *  records how the human signaled presence (audit). `extendMs` provisions a
   *  pomodoro block on open (the engagement-via-extension case). */
  function openIdleWindow(
    ctx: ExtensionContext,
    engagedVia: 'keystroke' | 'extension',
    extendMs = 0
  ) {
    if (humanWindow) return; // safety: never open a second window
    idleKeystrokes = 0; // reset the composition-density count for the new window
    const graceMs = settings.graceMinutes * MS_PER_MINUTE;
    if (extendMs > 0) {
      extensionBudgetMs += extendMs;
      totals.extensionCreditMs += extendMs; // provisioned capacity (one block)
      totals.extensionsGranted += 1;
    }
    const cap = graceMs + extensionBudgetMs;
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
    // Arm the wizard to fire when this window's budget is exhausted (from the
    // onset) — never pop now: the human is engaging, and an immediate pop would
    // interrupt. The exhaustion pop offers the next extension.
    armWizardForBoundary(ctx);
    updateStatus(ctx);
  }

  // Steering composition: the human types a steer/followUp while the agent
  // runs. The editor hook (`noteKeystroke`) stages every keystroke; the
  // `input` event commits it on submit. Billed as the active-typing burst sum
  // (not wall-clock) under the same grace + rolling-credit cap as an idle
  // window — a single key or keys spread minutes apart bill nothing, so typing
  // is only billed when it's actually queued/steered to the agent.
  function noteKeystroke(data: string) {
    const now = Date.now();
    // Held-key collapse: a held key auto-repeats the same data within
    // AUTO_REPEAT_MS. Collapse to one event so a single physical action can't
    // fabricate a sustained burst (steer staging) or inflate the idle keystroke
    // count. Varied keys, same-key gaps at/above the threshold, and voice/paste
    // (distinct blobs) are unaffected. Reset at agent_start/end and recordSteer.
    const autoRepeat = data === lastKey && now - lastKeyTime < AUTO_REPEAT_MS;
    lastKey = data;
    lastKeyTime = now;
    if (autoRepeat) return;
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

  function recordSteer(ctx: ExtensionContext, behavior: 'steer' | 'followUp') {
    const submittedAt = Date.now();
    const graceMs = settings.graceMinutes * MS_PER_MINUTE;
    const cap = graceMs + extensionBudgetMs;
    // Bill active typing (burst sum), not the wall-clock span from the first
    // keystroke — so idle gaps before/between typing don't accrue, and a single
    // keystroke can't open a billable window.
    const burstMs = computeBurstMs(steerStaging, STEER_GAP_MS);
    const billedMs = Math.min(burstMs, Math.max(0, cap));
    const startedAt = steerStaging[0] ?? submittedAt;
    const durationMs = Math.max(0, submittedAt - startedAt); // wall-clock span (audit)
    const keystrokes = steerStaging.length;
    steerStaging = [];
    lastKey = null; // reset held-key tracking so the next burst starts fresh
    lastKeyTime = 0;
    // Only billed time beyond the per-window grace consumes rolling credit;
    // the leftover rolls forward (same rule as an idle window).
    const consumed = consumeExtensionBudget(billedMs, graceMs, extensionBudgetMs);
    extensionBudgetMs -= consumed;
    totals.extensionConsumedMs += consumed;
    appendSidecar({
      kind: 'steer',
      startedAt,
      submittedAt,
      durationMs,
      billedMs,
      keystrokes,
      behavior,
      grantedBudgetMs: cap,
      extensionBudgetMs,
      timestamp: submittedAt,
    });
    if (billedMs > 0) {
      totals.humanMs += billedMs;
      totals.humanWindows += 1;
      if (behavior === 'steer') {
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

  // ── Wizard ─────────────────────────────────────────────────────────────

  function clearWizardTimer() {
    if (wizardTimer) {
      clearTimeout(wizardTimer);
      wizardTimer = null;
    }
  }

  function disarmWizard() {
    clearWizardTimer();
  }

  function armWizardForBoundary(ctx: ExtensionContext) {
    clearWizardTimer();
    if (!humanWindow || !settings.autoWizard || !ctx.hasUI || ctx.mode !== 'tui') return;
    const elapsed = Date.now() - humanWindow.openedAt;
    const delay = humanWindow.grantedBudgetMs - elapsed;
    if (delay <= 0) {
      showWizard(ctx);
      return;
    }
    wizardTimer = setTimeout(() => showWizard(ctx), delay);
  }

  /** Show the wizard immediately — to prompt engagement at `agent_end` (no
   *  credit) or on `/resume` (no window yet), or as a re-offer. Works with or
   *  without an open window: the extend action engages one if none is open. */
  function armWizardNow(ctx: ExtensionContext) {
    clearWizardTimer();
    if (!settings.autoWizard || !ctx.hasUI || ctx.mode !== 'tui') return;
    showWizard(ctx);
  }

  function showWizard(ctx: ExtensionContext, extendMins: number = settings.pomodoroMinutes) {
    wizardTimer = null;
    const pomodoro = extendMins;
    // Works with or without an open window. With no window this is the
    // engagement prompt (agent_end no-credit / /resume): extend engages one.
    // Snapshot the rolling credit still provisioned (and unconsumed so far) so
    // the user knows extending ADDS to existing capacity, not replaces it.
    // Captured before the async custom() closure — state can change.
    const graceMs = settings.graceMinutes * MS_PER_MINUTE;
    const elapsedNow = humanWindow ? Math.max(0, Date.now() - humanWindow.openedAt) : 0;
    const remainingProvisioned = humanWindow
      ? Math.max(0, extensionBudgetMs - Math.max(0, elapsedNow - graceMs))
      : extensionBudgetMs;

    ctx.ui
      .custom<string>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg('accent', theme.bold('⏱  Extend billable human time?')), 1, 0)
        );
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg('muted', `Idle after the agent. Add a ${pomodoro}m pomodoro block?`),
            1,
            0
          )
        );
        // Show any rolling credit still provisioned (and unconsumed so far) so
        // the user knows extending ADDS to existing capacity, not replaces it.
        if (remainingProvisioned > 0) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(
              theme.fg(
                'dim',
                `${Math.max(1, Math.round(remainingProvisioned / MS_PER_MINUTE))}m still provisioned — extending adds more.`
              ),
              1,
              0
            )
          );
        }
        container.addChild(new Spacer(1));
        const items: SelectItem[] = [
          {
            value: 'extend',
            label: `Extend +${pomodoro}m`,
            description: 'Add a pomodoro to billable human time',
          },
          {
            value: 'stop',
            label: 'Stop billing',
            description: 'Cap human time at the current budget',
          },
        ];
        const list = new SelectList(items, 5, getSelectListTheme());
        list.onSelect = (item) => done(item.value);
        list.onCancel = () => done('stop');
        container.addChild(list);
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg('dim', '↑↓ navigate · enter select · esc dismiss'), 1, 0)
        );
        container.addChild(new Spacer(1));
        container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      })
      .then((choice) => {
        if (choice !== 'extend') return; // stop/dismiss = no engagement, no change
        const addMs = pomodoro * MS_PER_MINUTE;
        if (!humanWindow) {
          // No window yet: extend both engages (onset = now) and grants capacity.
          // openIdleWindow opens, records, arms for exhaustion, and re-renders.
          openIdleWindow(ctx, 'extension', addMs);
          notify(ctx, `Extended billable human time by ${pomodoro}m.`, 'info');
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
        notify(ctx, `Extended billable human time by ${pomodoro}m.`, 'info');
      });
  }

  function notify(
    ctx: ExtensionContext | null,
    message: string,
    type: 'info' | 'warning' | 'error'
  ) {
    if (ctx && ctx.hasUI) ctx.ui.notify(message, type);
  }

  // ── Rehydration ────────────────────────────────────────────────────────

  function rehydrate(ctx: ExtensionContext) {
    sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
    const events = readSidecar();
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
    // Wrap the input editor so keystrokes stage for billing: during a run they
    // feed a steer/followUp burst (committed on submit via `input`); between
    // turns the FIRST keystroke engages an idle window at its onset. Extends
    // CustomEditor and delegates every keystroke to the base editor, so app
    // keybindings (escape-to-abort, ctrl+d, …) are preserved. TUI-only: non-
    // interactive modes have no editor to type into, so nothing stages.
    if (ctx.mode === 'tui' && ctx.hasUI) {
      ctx.ui.setEditorComponent(
        (tui, theme, kb) => new LedgerEditor(tui, theme, kb, noteKeystroke)
      );
    }
    // No initial window is opened here — engagement is gated on the first
    // keystroke/extension, so pre-engagement time (reading the transcript,
    // thinking) bills nothing unless the human extends. On /resume (or
    // /reload) pop the wizard to prompt that engagement, so review time can be
    // billed via an extension. (Startup/new start typing right away — no pop.)
    if ((event.reason === 'resume' || event.reason === 'reload') && settings.autoWizard) {
      armWizardNow(ctx);
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
    // Record the exit: close any open human window. Idle only bills when
    // committed by a submitted prompt (an agent action) — a window still open
    // at shutdown was never committed, so it's abandoned and bills 0 (idle
    // with no output is wasted). Persisted as a close for replay cleanliness.
    closeHumanWindow(lastCtx, false);
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

  pi.on('message_start', (event) => {
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
    // its idle (from the engagement onset) bills now, capped at grace + credit.
    // If the human never engaged (no keystroke, no extension), there's no
    // window to close and the turn handoff bills nothing.
    closeHumanWindow(ctx, true);
  });

  pi.on('agent_end', (event, ctx) => {
    lastCtx = ctx;
    agentRunning = false;
    // Discard any uncommitted in-run typing: a steer/followUp that was never
    // submitted never reached the agent, so it bills nothing (a submitted
    // steer already cleared the buffer in `recordSteer`). The post-turn idle
    // window opens only on the next engagement — no backdate — so mid-run
    // typing that isn't actually queued/steered can't inflate it.
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
    // Skip the human idle window when the turn ended in a provider error
    // (last assistant stopReason "error"). That's a retry/queue in flight, not
    // a human handoff — a retry extension (pi-retry) sleeps with backoff then
    // re-prompts, or pi-core compacts an overflow and retries — so opening a
    // window here would bill the retry's backoff sleep as human time. That
    // violates scale-to-zero: "a slow/queued provider is a retry, not billable
    // time." No window means no billing (and no wizard pop) during the retry;
    // the next non-error agent_end opens the window for genuine post-turn idle.
    // max_tokens ("length") continuations are left alone: their pre-continue
    // gap is small and they're ambiguous without a retry extension (a bare
    // max_tokens stop hands control back to the human to decide).
    if (lastAssistantStopReason(event.messages) === 'error') return;
    // The idle window is NOT opened here — it opens only when the human
    // engages (first keystroke or extension). Until then, idle bills nothing.
    // If the human has no rolling credit (hasn't extended), pop the wizard now
    // to prompt that engagement (an extension both engages and grants
    // capacity). With credit, stay quiet — the window opens on the first
    // keystroke and arms for exhaustion then.
    if (extensionBudgetMs <= 0) armWizardNow(ctx);
  });

  // Steering composition is submitted via the `input` event, which tells us
  // how the message is delivered (`streamingBehavior`: "steer" for a mid-stream
  // interrupt, "followUp" for a queued message) and where it came from
  // (`source`: "interactive" for a human typing). Commit the staged typing as
  // human time — billed as the active-typing burst sum, only when it's
  // actually queued/steered to the agent. Pass-through: never transform or
  // handle the input — only observe it for billing.
  pi.on('input', (event, ctx) => {
    lastCtx = ctx;
    const behavior = event.streamingBehavior;
    if (behavior !== 'steer' && behavior !== 'followUp') return; // only mid-run
    if (event.source !== 'interactive') return; // only human-typed steers
    if (steerStaging.length === 0) return; // nothing staged (e.g. non-TUI / no typing)
    recordSteer(ctx, behavior);
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
        ` · total ${fmtMoney(b.total, settings.currency)}`;
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
      if (ctx.mode !== 'tui' || !ctx.hasUI) {
        ctx.ui.notify(
          'Open the wizard in a TUI session (extend after the agent finishes a turn).',
          'warning'
        );
        return;
      }
      // Works with or without an open window: with no window, extend engages
      // one (onset = now) and grants the block — an explicit engagement signal.
      const mins = parseMinutes(args) ?? settings.pomodoroMinutes;
      showWizard(ctx, mins);
    },
  });

  pi.registerCommand('ledger-settings', {
    description:
      'Configure billing: agent $/h, human $/h, grace minutes, pomodoro minutes, project, author, currency, auto-wizard.',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/ledger-settings requires TUI mode', 'error');
        return;
      }
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
        graceMinutes: settings.graceMinutes,
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
        id: 'graceMinutes',
        label: 'Grace minutes',
        currentValue: String(settings.graceMinutes),
        description: 'First N minutes of idle billed before the wizard offers an extension',
        submenu: numberSubmenu(theme, 'Grace minutes'),
      },
      {
        id: 'pomodoroMinutes',
        label: 'Pomodoro minutes',
        currentValue: String(settings.pomodoroMinutes),
        description: 'Minutes added per extension (wizard · /ledger-extend)',
        submenu: numberSubmenu(theme, 'Pomodoro minutes'),
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
        description: 'Auto-popup at the end of the grace minute',
        values: ['on', 'off'],
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
 *  every keystroke to the base editor; the only addition is a lightweight
 *  `onKeystroke` callback fired before `super.handleInput`. The callback is
 *  trivial (sets one timestamp) and never throws, so input is never blocked. */
class LedgerEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly onKeystroke: (data: string) => void
  ) {
    super(tui, theme, keybindings);
  }
  override handleInput(data: string): void {
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

/** stopReason of the last assistant message in an `agent_end` event's
 *  `messages`, or undefined when no assistant message is present. A turn whose
 *  final assistant message has stopReason "error" is a provider failure — a
 *  retry/queue in flight (pi-retry backoff, or pi-core compaction), not a
 *  human idle moment — so its idle window must not open.
 *  @internal Exported for testing only. */
export function lastAssistantStopReason(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const r = m as { role?: string; stopReason?: string };
    if (r.role === 'assistant') return r.stopReason;
  }
  return undefined;
}
