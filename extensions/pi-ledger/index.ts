/**
 * pi-ledger — Timesheet maker for pi
 *
 * Bills human + agent time like serverless: metered per-invocation,
 * scale-to-zero idle. Consumes pi-tps's `tps:telemetry` event for
 * per-turn agent timing and tracks tool-execution time itself; meters
 * human idle windows with a grace minute plus pomodoro extensions.
 *
 * Agent billable time per turn = (generationMs − stallMs) + toolExecutionMs.
 * Stalls are excluded to avoid abuse — a slow or queued provider must not
 * inflate billable time. TTFT stays in (it's the model producing the first
 * token); tool-execution time stays in (the agent doing the work).
 *
 * Human time = the idle window between agent_end and the next agent_start,
 * capped by a granted budget: the first grace minute is always billable,
 * then a non-blocking wizard offers +pomodoro extensions; `/ledger-extend`
 * does the same manually.
 *
 * Commands: /ledger, /ledger-settings, /ledger-extend [m], /ledger-receipt
 *
 * Standalone but pi-tps-aware: works on its own, and uses pi-tps's
 * `tps:telemetry` event for refined per-turn timing when present.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {
  DynamicBorder,
  getSelectListTheme,
  getSettingsListTheme,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  SelectList,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth,
  type OverlayHandle,
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

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

const SETTINGS_CUSTOM_TYPE = 'ledger-settings';
const AGENT_CUSTOM_TYPE = 'ledger-agent';
const HUMAN_CUSTOM_TYPE = 'ledger-human';

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
  agentRatePerHour: 0,
  humanRatePerHour: 0,
  graceMinutes: 1,
  pomodoroMinutes: 20,
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
  project: string;
  author: string;
  currency: string;
  autoWizard: boolean;
}

/** Persisted per agent turn (replayed on rehydrate). */
export interface AgentSegment {
  kind: 'agent';
  turnIndex: number;
  agentMs: number;
  generationMs: number;
  stallMs: number;
  toolMs: number;
  tokens: { input: number; output: number; total: number };
  model: { provider: string; modelId: string };
  /** 'tps' = high-fidelity, from pi-tps's event; 'fallback' = self-measured. */
  source: 'tps' | 'fallback';
  timestamp: number;
}

/** Persisted per closed human idle window (replayed on rehydrate). */
export interface HumanSegment {
  kind: 'human';
  billedMs: number;
  idleMs: number;
  grantedBudgetMs: number;
  extensions: number;
  openedAt: number;
  closedAt: number;
  timestamp: number;
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
}

export interface Billing {
  agentHours: number;
  humanHours: number;
  agentCost: number;
  humanCost: number;
  total: number;
  totalHours: number;
  blendedRate: number;
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
  blendedRate: number;
  agentTurns: number;
  humanWindows: number;
  agentTokens: { input: number; output: number; total: number };
  startedAt: number;
  generatedAt: number;
}

// ─── Pure helpers (exported for testing) ────────────────────────────────────

/** Agent billable time: active generation (TTFT + streaming, minus stalls) + tool time. */
export function computeAgentMs(generationMs: number, stallMs: number, toolMs: number): number {
  const activeGen = Math.max(0, generationMs - Math.max(0, stallMs));
  return activeGen + Math.max(0, toolMs);
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
  const blendedRate = totalHours > 0 ? total / totalHours : 0;
  return { agentHours, humanHours, agentCost, humanCost, total, totalHours, blendedRate };
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

export function fmtDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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
export function rehydrateFromEntries(
  entries: Array<{ type?: string; customType?: string; data?: unknown }>
): { settings: LedgerSettings; totals: Totals } {
  let settings: LedgerSettings | null = null;
  // Last agent segment per turnIndex wins: a 'fallback' entry may be followed
  // by a higher-fidelity 'tps' correction for the same turn (extension load
  // order), so we keep the later one and never double-count.
  const agentByTurn = new Map<number, AgentSegment>();
  let humanMs = 0;
  let humanWindows = 0;
  for (const e of entries) {
    if (e.type !== 'custom') continue;
    if (e.customType === SETTINGS_CUSTOM_TYPE) {
      const d = e.data as Partial<LedgerSettings> | null;
      if (d) settings = { ...DEFAULT_SETTINGS, ...d };
    } else if (e.customType === AGENT_CUSTOM_TYPE) {
      const d = e.data as AgentSegment | null;
      if (d && typeof d.turnIndex === 'number') agentByTurn.set(d.turnIndex, d);
    } else if (e.customType === HUMAN_CUSTOM_TYPE) {
      const d = e.data as HumanSegment | null;
      if (!d) continue;
      humanMs += d.billedMs;
      humanWindows += 1;
    }
  }
  let agentMs = 0;
  const agentTokens = { input: 0, output: 0, total: 0 };
  for (const d of agentByTurn.values()) {
    agentMs += d.agentMs;
    agentTokens.input += d.tokens.input;
    agentTokens.output += d.tokens.output;
    agentTokens.total += d.tokens.total;
  }
  return {
    settings: settings ?? { ...DEFAULT_SETTINGS },
    totals: { agentMs, humanMs, agentTurns: agentByTurn.size, humanWindows, agentTokens },
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
 * Agent time per marker = (generationMs − stallMs); tool time is unavailable
 * from pi-tps markers. Human time is estimated from inter-turn gaps — each
 * gap is capped at the grace budget (no wizard ran, so no extensions) —
 * which mirrors the scale-to-zero billing rule. @internal */
export function convertTpsEntries(
  tps: TpsMarker[],
  graceMs: number
): {
  agentMs: number;
  agentTurns: number;
  agentTokens: { input: number; output: number; total: number };
  humanMs: number;
  humanWindows: number;
  startedAt: number;
} {
  let agentMs = 0;
  const agentTokens = { input: 0, output: 0, total: 0 };
  let humanMs = 0;
  let humanWindows = 0;
  for (let i = 0; i < tps.length; i++) {
    const e = tps[i]!;
    agentMs += computeAgentMs(e.timing.generationMs || 0, e.timing.stallMs || 0, 0);
    agentTokens.input += e.tokens.input || 0;
    agentTokens.output += e.tokens.output || 0;
    agentTokens.total += e.tokens.total || 0;
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
  return {
    agentMs,
    agentTurns: tps.length,
    agentTokens,
    humanMs,
    humanWindows,
    startedAt: tps.length > 0 ? tps[0]!.timestamp : 0,
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
  const totalHours = d.agentHours + d.humanHours;
  const agentHrs = d.agentHours.toFixed(2);
  const humanHrs = d.agentTurns === 0 && d.humanWindows === 0 ? '0.00' : d.humanHours.toFixed(2);
  const blended = totalHours > 0 ? fmtMoney(d.blendedRate, cur) + '/h' : '—';
  const dateLine =
    d.startedAt > 0 && d.startedAt !== d.generatedAt
      ? `${fmtDate(d.startedAt)} → ${fmtDate(d.generatedAt)}`
      : fmtDate(d.generatedAt);

  const rows = [
    {
      label: 'Agent',
      hrs: agentHrs + ' h',
      rate: '@ ' + fmtMoney(d.agentRate, cur) + '/h',
      amt: fmtMoney(d.agentCost, cur),
      detail: `${d.agentTurns} turns · ${fmtNumber(d.agentTokens.total)} tokens`,
    },
    {
      label: 'Human',
      hrs: humanHrs + ' h',
      rate: '@ ' + fmtMoney(d.humanRate, cur) + '/h',
      amt: fmtMoney(d.humanCost, cur),
      detail: `${d.humanWindows} windows`,
    },
  ];

  const rowHtml = rows
    .map(
      (r) => `      <div class="line r-block r-hidden">
        <div class="left">
          <span class="label"${reveal(r.label)}</span>
          <span class="detail"${reveal(r.detail)}</span>
        </div>
        <div class="right">
          <div><span class="hrs"${reveal(r.hrs)}</span> <span class="rate"${reveal(r.rate)}</span></div>
          <div class="amt"${reveal(r.amt)}</div>
        </div>
      </div>`
    )
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
  .line { display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 0; font-size: 13px; }
  .line + .line { border-top: 1px dashed #f2f2f2; }
  .line .left { display: flex; flex-direction: column; }
  .line .label { font-weight: 600; }
  .line .detail { font-size: 10px; color: #b0b0b0; font-weight: 400; margin-top: 3px; }
  .line .right { text-align: right; }
  .line .rate { font-size: 11px; color: #9a9a9a; margin-left: 6px; }
  .line .amt { font-weight: 600; margin-top: 2px; }
  .blended { display: flex; justify-content: space-between; font-size: 12px; color: #555; padding: 10px 0 4px; }
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
    <hr class="rule r-block r-hidden" />
    <div class="blended r-block r-hidden"><span${reveal('Blended rate')}</span><span${reveal(blended)}</span></div>
    <div class="total r-block r-hidden"><span${reveal('Total')}</span><span class="amt"${reveal(fmtMoney(d.total, cur))}</span></div>
    <div class="foot r-block r-hidden"><span${reveal('generated ' + fmtDate(d.generatedAt) + ' · pi-ledger')}</span></div>
    <span class="cursor" id="cursor"></span>
  </div>
<script>
(function () {
  // Reveal the receipt block-by-block: each line unhides (card grows), then
  // its values type in autoregressively; the cursor tracks the active span.
  var blocks = document.querySelectorAll('.r-block');
  var cursor = document.getElementById('cursor');
  var bi = 0;
  function nextBlock() {
    if (bi >= blocks.length) { if (cursor) cursor.remove(); return; }
    var block = blocks[bi++];
    block.classList.remove('r-hidden');
    var spans = block.querySelectorAll('[data-reveal]');
    if (spans.length === 0) { setTimeout(nextBlock, 140); return; }
    var si = 0;
    function nextSpan() {
      if (si >= spans.length) { setTimeout(nextBlock, 90); return; }
      var el = spans[si++];
      var final = el.getAttribute('data-reveal') || '';
      el.textContent = '';
      if (cursor) { try { el.after(cursor); } catch (e) {} }
      var c = 0;
      function step() {
        if (c <= final.length) { el.textContent = final.slice(0, c); c++; setTimeout(step, 16); }
        else { setTimeout(nextSpan, 60); }
      }
      step();
    }
    nextSpan();
  }
  window.addEventListener('load', nextBlock);
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
  };

  // Per-turn tool-execution accumulator (depth counter → union wall-clock).
  let toolDepth = 0;
  let toolSpanStart = 0;
  let toolMsThisTurn = 0;
  let currentTurnIndex = 0;

  // Current human idle window (null while the agent is working).
  let humanWindow: { openedAt: number; grantedBudgetMs: number; extensions: number } | null = null;

  let wizardTimer: ReturnType<typeof setTimeout> | null = null;
  let wizardHandle: OverlayHandle | null = null;

  // Latest ctx (event-bus listeners for tps:telemetry don't receive one).
  let lastCtx: ExtensionContext | null = null;

  // pi-tps awareness: when pi-tps is present it emits `tps:telemetry` per turn
  // and we use its refined generation/stall numbers. When it's absent we fall
  // back to our own measurement (basic generation + a stall gap gate) so the
  // extension stands alone.
  let tpsEverSeen = false;
  let lastFallback: {
    turnIndex: number;
    agentMs: number;
    tokens: { input: number; output: number; total: number };
  } | null = null;
  let fallbackNotified = false;

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

  // Footer (custom grey status bar) + totals derived from pi-tps markers,
  // used for the status/receipt when the session has no live ledger data.
  let derivedDisplay: ReturnType<typeof convertTpsEntries> | null = null;
  let footerTui: TUI | null = null;
  let footerCtx: ExtensionContext | null = null;
  let footerData: ReadonlyFooterDataProvider | null = null;
  let footerUnsub: (() => void) | null = null;

  // ── Settings persistence ───────────────────────────────────────────────

  function persistSettings() {
    pi.appendEntry(SETTINGS_CUSTOM_TYPE, settings);
  }

  function effectiveAuthor(): string {
    return settings.author || defaultAuthor();
  }

  function effectiveProject(ctx: ExtensionContext): string {
    return settings.project || basename(ctx.cwd);
  }

  // ── Status footer (custom grey bar) ────────────────────────────────────

  /** Live ledger totals, or — for a pi-tps-only session — totals derived
   *  from the session's `tps` markers, so the status reflects real hours. */
  function effectiveTotals(): Totals {
    if (totals.agentTurns > 0 || totals.humanWindows > 0) return totals;
    if (derivedDisplay) {
      return {
        agentMs: derivedDisplay.agentMs,
        humanMs: derivedDisplay.humanMs,
        agentTurns: derivedDisplay.agentTurns,
        humanWindows: derivedDisplay.humanWindows,
        agentTokens: derivedDisplay.agentTokens,
      };
    }
    return totals;
  }

  function renderFooterBar(width: number): string {
    const t = effectiveTotals();
    const b = computeBilling(t.agentMs, t.humanMs, settings);
    const totalsStr = `agent ${fmtHours(t.agentMs)} · human ${fmtHours(t.humanMs)} · ${fmtMoney(b.total, settings.currency)}`;
    const theme = footerCtx?.ui?.theme;
    let left = theme
      ? theme.fg('text', 'ledger · ') + theme.fg('accent', totalsStr)
      : `ledger · ${totalsStr}`;
    const rightParts: string[] = [];
    const usage = footerCtx?.getContextUsage?.();
    if (usage && usage.percent != null) rightParts.push(`${usage.percent}%`);
    if (footerCtx?.model?.id) rightParts.push(footerCtx.model.id);
    const git = footerData?.getGitBranch?.() ?? null;
    if (git) rightParts.push(git);
    let right = theme ? theme.fg('text', rightParts.join(' · ')) : rightParts.join(' · ');
    let lw = visibleWidth(left);
    let rw = visibleWidth(right);
    if (lw + rw + 1 > width) {
      const room = width - rw - 1;
      if (room >= 8) left = truncateToWidth(left, room, '');
      else {
        right = truncateToWidth(right, Math.max(1, width - 2), '');
        left = '';
      }
      lw = visibleWidth(left);
      rw = visibleWidth(right);
    }
    const pad = Math.max(1, width - lw - rw);
    return '\x1b[48;5;240m' + left + ' '.repeat(pad) + right + '\x1b[0m';
  }

  function installFooter(ctx: ExtensionContext) {
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    footerCtx = ctx;
    ctx.ui.setFooter((tui, _theme, data) => {
      footerTui = tui;
      footerData = data;
      footerUnsub = data.onBranchChange(() => tui.requestRender());
      return {
        render: (w: number) => [renderFooterBar(w)],
        invalidate: () => tui.requestRender(),
        dispose: () => {
          if (footerUnsub) {
            footerUnsub();
            footerUnsub = null;
          }
        },
      };
    });
    footerTui?.requestRender();
  }

  function restoreFooter(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setFooter(undefined);
    if (footerUnsub) {
      footerUnsub();
      footerUnsub = null;
    }
    footerTui = null;
    footerData = null;
    footerCtx = null;
  }

  function updateStatus(_ctx: ExtensionContext | null) {
    if (footerTui) footerTui.requestRender();
  }

  // ── Human idle window ──────────────────────────────────────────────────

  function closeHumanWindow(ctx: ExtensionContext) {
    disarmWizard();
    const w = humanWindow;
    humanWindow = null;
    if (!w) return;
    const closedAt = Date.now();
    const { idleMs, billedMs } = closeWindowBudget(w.openedAt, closedAt, w.grantedBudgetMs);
    if (billedMs > 0) {
      const seg: HumanSegment = {
        kind: 'human',
        billedMs,
        idleMs,
        grantedBudgetMs: w.grantedBudgetMs,
        extensions: w.extensions,
        openedAt: w.openedAt,
        closedAt,
        timestamp: closedAt,
      };
      pi.appendEntry(HUMAN_CUSTOM_TYPE, seg);
      totals.humanMs += billedMs;
      totals.humanWindows += 1;
    }
    updateStatus(ctx);
  }

  function extendWindow(ctx: ExtensionContext, mins: number) {
    if (!humanWindow) return;
    humanWindow.grantedBudgetMs += mins * MS_PER_MINUTE;
    humanWindow.extensions += 1;
    clearWizardTimer();
    armWizardForBoundary(ctx);
    updateStatus(ctx);
  }

  // ── Wizard ─────────────────────────────────────────────────────────────

  function clearWizardTimer() {
    if (wizardTimer) {
      clearTimeout(wizardTimer);
      wizardTimer = null;
    }
  }

  function closeWizardOverlay() {
    if (wizardHandle) {
      try {
        wizardHandle.hide();
      } catch {
        // already removed
      }
      wizardHandle = null;
    }
  }

  function disarmWizard() {
    clearWizardTimer();
    closeWizardOverlay();
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

  function showWizard(ctx: ExtensionContext) {
    wizardTimer = null;
    if (!humanWindow) return;
    const pomodoro = settings.pomodoroMinutes;

    ctx.ui
      .custom<string>(
        (tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
          container.addChild(
            new Text(theme.fg('accent', theme.bold('⏱  Extend billable human time?')), 1, 0)
          );
          container.addChild(
            new Text(
              theme.fg('muted', `Idle grace ending. Add a ${pomodoro}m pomodoro block?`),
              1,
              0
            )
          );
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
          container.addChild(
            new Text(theme.fg('dim', '↑↓ navigate · enter select · esc dismiss'), 1, 0)
          );
          container.addChild(new DynamicBorder((s: string) => theme.fg('accent', s)));
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              list.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: { anchor: 'center', width: '50%', minWidth: 48 },
          onHandle: (handle) => {
            wizardHandle = handle;
          },
        }
      )
      .then((choice) => {
        wizardHandle = null;
        if (!humanWindow || choice !== 'extend') return;
        humanWindow.grantedBudgetMs += pomodoro * MS_PER_MINUTE;
        humanWindow.extensions += 1;
        armWizardForBoundary(ctx);
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
    const entries = ctx.sessionManager.getBranch();
    const r = rehydrateFromEntries(entries);
    settings = r.settings;
    totals.agentMs = r.totals.agentMs;
    totals.humanMs = r.totals.humanMs;
    totals.agentTurns = r.totals.agentTurns;
    totals.humanWindows = r.totals.humanWindows;
    totals.agentTokens = r.totals.agentTokens;
    // No live ledger data → derive display totals from pi-tps markers so the
    // status/receipt reflect this session's hours even if pi-ledger wasn't
    // tracking live.
    if (totals.agentTurns === 0 && totals.humanWindows === 0) {
      const tps = extractTpsEntries(entries);
      derivedDisplay =
        tps.length > 0 ? convertTpsEntries(tps, settings.graceMinutes * MS_PER_MINUTE) : null;
    } else {
      derivedDisplay = null;
    }
    updateStatus(ctx);
  }

  pi.on('session_start', (_event, ctx) => {
    lastCtx = ctx;
    rehydrate(ctx);
    installFooter(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    lastCtx = ctx;
    rehydrate(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => {
    disarmWizard();
    restoreFooter(ctx);
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
    const agentMs = computeAgentMs(generationMs, stallMs, toolMs);
    if (agentMs <= 0) return;
    const seg: AgentSegment = {
      kind: 'agent',
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
      timestamp: Date.now(),
    };
    if (lastFallback && lastFallback.turnIndex === currentTurnIndex) {
      totals.agentMs -= lastFallback.agentMs;
      totals.agentTurns -= 1;
      totals.agentTokens.input -= lastFallback.tokens.input;
      totals.agentTokens.output -= lastFallback.tokens.output;
      totals.agentTokens.total -= lastFallback.tokens.total;
      lastFallback = null;
    }
    pi.appendEntry(AGENT_CUSTOM_TYPE, seg);
    totals.agentMs += agentMs;
    totals.agentTurns += 1;
    totals.agentTokens.input += seg.tokens.input;
    totals.agentTokens.output += seg.tokens.output;
    totals.agentTokens.total += seg.tokens.total;
    updateStatus(lastCtx);
  });

  // Fallback: pi-tps absent for this turn → measure ourselves at turn_end.
  pi.on('turn_end', (event, ctx) => {
    lastCtx = ctx;
    if (tpsEverSeen) return; // pi-tps present; it handles turns (or intentionally skips)
    if (fb.messageCount === 0 || !fb.model) return;
    const toolMs = toolMsThisTurn;
    const agentMs = computeAgentMs(fb.totalGenerationMs, fb.stallMs, toolMs);
    if (agentMs <= 0) return;
    const seg: AgentSegment = {
      kind: 'agent',
      turnIndex: event.turnIndex,
      agentMs,
      generationMs: fb.totalGenerationMs,
      stallMs: fb.stallMs,
      toolMs,
      tokens: { input: fb.tokens.input, output: fb.tokens.output, total: fb.tokens.total },
      model: fb.model,
      source: 'fallback',
      timestamp: Date.now(),
    };
    pi.appendEntry(AGENT_CUSTOM_TYPE, seg);
    totals.agentMs += agentMs;
    totals.agentTurns += 1;
    totals.agentTokens.input += seg.tokens.input;
    totals.agentTokens.output += seg.tokens.output;
    totals.agentTokens.total += seg.tokens.total;
    lastFallback = { turnIndex: event.turnIndex, agentMs, tokens: { ...seg.tokens } };
    updateStatus(ctx);
  });

  // ── Human idle windows ────────────────────────────────────────────────

  pi.on('agent_start', (_event, ctx) => {
    lastCtx = ctx;
    closeHumanWindow(ctx);
  });

  pi.on('agent_end', (_event, ctx) => {
    lastCtx = ctx;
    if (humanWindow) closeHumanWindow(ctx); // safety: should already be null
    humanWindow = {
      openedAt: Date.now(),
      grantedBudgetMs: settings.graceMinutes * MS_PER_MINUTE,
      extensions: 0,
    };
    if (!tpsEverSeen && !fallbackNotified) {
      fallbackNotified = true;
      notify(
        ctx,
        'pi-ledger: built-in timing in use (pi-tps not detected; install @monotykamary/pi-tps for refined stall detection).',
        'info'
      );
    }
    armWizardForBoundary(ctx);
    updateStatus(ctx);
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand('ledger', {
    description: 'Show running billable totals (agent + human hours, blended rate, total).',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const t = effectiveTotals();
      const b = computeBilling(t.agentMs, t.humanMs, settings);
      const msg =
        `agent ${fmtHours(t.agentMs)} (${t.agentTurns} turns) @ ${fmtMoney(settings.agentRatePerHour, settings.currency)}/h = ${fmtMoney(b.agentCost, settings.currency)}` +
        ` · human ${fmtHours(t.humanMs)} (${t.humanWindows} windows) @ ${fmtMoney(settings.humanRatePerHour, settings.currency)}/h = ${fmtMoney(b.humanCost, settings.currency)}` +
        ` · blended ${b.totalHours > 0 ? fmtMoney(b.blendedRate, settings.currency) + '/h' : '—'}` +
        ` · total ${fmtMoney(b.total, settings.currency)}`;
      ctx.ui.notify(msg, 'info');
      if (totals.agentTurns === 0 && derivedDisplay) {
        ctx.ui.notify(
          `Derived from ${derivedDisplay.agentTurns} pi-tps markers (lower fidelity: no tool time; human time estimated).`,
          'info'
        );
      }
    },
  });

  pi.registerCommand('ledger-extend', {
    description:
      'Extend the current human-time billing window by N minutes (default: pomodoro length).',
    getArgumentCompletions: (argumentPrefix: string) => {
      const presets = [String(settings.pomodoroMinutes), '40', '60', '90', '120'];
      return presets
        .filter((p) => p.startsWith(argumentPrefix))
        .map((p) => ({ value: p, label: `${p}m` }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!humanWindow) {
        ctx.ui.notify(
          'No active human-time window. Extend after the agent finishes a turn.',
          'warning'
        );
        return;
      }
      const mins = parseMinutes(args) ?? settings.pomodoroMinutes;
      extendWindow(ctx, mins);
      ctx.ui.notify(
        `Extended billable human time by ${mins}m (budget now ${fmtDuration(humanWindow.grantedBudgetMs)}).`,
        'info'
      );
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
      'Export an HTML receipt for this session (billable agent + human hours, blended rate, total).',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      let agentMs = totals.agentMs;
      let humanMs = totals.humanMs;
      let agentTurns = totals.agentTurns;
      let humanWindows = totals.humanWindows;
      const agentTokens = { ...totals.agentTokens };
      let startedAt = earliestLedgerTimestamp(ctx);

      // No live ledger data (pi-ledger wasn't tracking) → convert pi-tps markers
      // from the session so an existing pi-tps session still yields a receipt.
      if (agentTurns === 0) {
        const tps = extractTpsEntries(ctx.sessionManager.getBranch());
        if (tps.length > 0) {
          const c = convertTpsEntries(tps, settings.graceMinutes * MS_PER_MINUTE);
          agentMs = c.agentMs;
          agentTurns = c.agentTurns;
          agentTokens.input = c.agentTokens.input;
          agentTokens.output = c.agentTokens.output;
          agentTokens.total = c.agentTokens.total;
          humanMs = c.humanMs;
          humanWindows = c.humanWindows;
          startedAt = c.startedAt;
          ctx.ui.notify(
            `Receipt built from ${tps.length} pi-tps markers (lower fidelity: no tool time; human time estimated from inter-turn gaps).`,
            'info'
          );
        }
      }

      const b = computeBilling(agentMs, humanMs, settings);
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
        blendedRate: b.blendedRate,
        agentTurns,
        humanWindows,
        agentTokens,
        startedAt,
        generatedAt: Date.now(),
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

  function earliestLedgerTimestamp(ctx: ExtensionContext): number {
    let earliest = 0;
    try {
      for (const e of ctx.sessionManager.getBranch()) {
        if (e.type !== 'custom') continue;
        if (e.customType !== AGENT_CUSTOM_TYPE && e.customType !== HUMAN_CUSTOM_TYPE) continue;
        const ts = (e.data as { timestamp?: number } | null)?.timestamp;
        if (typeof ts === 'number' && (earliest === 0 || ts < earliest)) earliest = ts;
      }
    } catch {
      // ignore — fall back to generatedAt
    }
    return earliest;
  }
}

// ─── Module-local helpers ──────────────────────────────────────────────────

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
