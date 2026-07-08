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
 * Requires @monotykamary/pi-tps installed as a peer — it emits the
 * `tps:telemetry` event this extension consumes.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
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
  type OverlayHandle,
  type SelectItem,
  type SettingItem,
} from '@earendil-works/pi-tui';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Event emitted by @monotykamary/pi-tps after each turn with per-turn telemetry. */
const TPS_TELEMETRY_EVENT = 'tps:telemetry';

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
  const totals: Totals = {
    agentMs: 0,
    humanMs: 0,
    agentTurns: 0,
    humanWindows: 0,
    agentTokens: { input: 0, output: 0, total: 0 },
  };
  for (const e of entries) {
    if (e.type !== 'custom') continue;
    if (e.customType === SETTINGS_CUSTOM_TYPE) {
      const d = e.data as Partial<LedgerSettings> | null;
      if (d) settings = { ...DEFAULT_SETTINGS, ...d };
    } else if (e.customType === AGENT_CUSTOM_TYPE) {
      const d = e.data as AgentSegment | null;
      if (!d) continue;
      totals.agentMs += d.agentMs;
      totals.agentTurns += 1;
      totals.agentTokens.input += d.tokens.input;
      totals.agentTokens.output += d.tokens.output;
      totals.agentTokens.total += d.tokens.total;
    } else if (e.customType === HUMAN_CUSTOM_TYPE) {
      const d = e.data as HumanSegment | null;
      if (!d) continue;
      totals.humanMs += d.billedMs;
      totals.humanWindows += 1;
    }
  }
  return { settings: settings ?? { ...DEFAULT_SETTINGS }, totals };
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
  return ` data-reveal="${esc(text)}">${esc(text)}`;
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
      (r) => `      <div class="line">
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
  @media print { .cursor { display: none; } body { padding: 0; } .receipt { box-shadow: none; border-color: #ddd; } }
</style>
</head>
<body>
  <div class="receipt">
    <div class="brand"${reveal('pi-ledger')}</div>
    <div class="tagline"${reveal('billed like serverless')}</div>
    <hr class="rule" />
    <div class="meta">
      <div class="mrow"><span class="k">Project</span><span${reveal(d.project)}</span></div>
      <div class="mrow"><span class="k">Author</span><span${reveal(d.author)}</span></div>
      <div class="mrow"><span class="k">Session</span><span${reveal(d.sessionId)}</span></div>
      <div class="mrow"><span class="k">Date</span><span${reveal(dateLine)}</span></div>
    </div>
    <hr class="rule" />
${rowHtml}
    <hr class="rule" />
    <div class="blended"><span${reveal('Blended rate')}</span><span${reveal(blended)}</span></div>
    <div class="total"><span${reveal('Total')}</span><span class="amt"${reveal(fmtMoney(d.total, cur))}</span></div>
    <div class="foot"${reveal('generated ' + fmtDate(d.generatedAt) + ' · pi-ledger')}</div>
    <span class="cursor" id="cursor"></span>
  </div>
<script>
(function () {
  var els = document.querySelectorAll('[data-reveal]');
  var cursor = document.getElementById('cursor');
  var i = 0;
  function typeNext() {
    if (i >= els.length) { if (cursor) cursor.remove(); return; }
    var el = els[i++];
    var final = el.getAttribute('data-reveal');
    el.textContent = '';
    if (cursor && el.parentNode) el.parentNode.appendChild(cursor);
    var c = 0;
    function step() {
      if (c <= final.length) { el.textContent = final.slice(0, c); c++; setTimeout(step, 16); }
      else setTimeout(typeNext, 90);
    }
    step();
  }
  window.addEventListener('load', typeNext);
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
  let tpsSeen = false;

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

  // ── Status footer ──────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext | null) {
    if (!ctx || !ctx.hasUI) return;
    const b = computeBilling(totals.agentMs, totals.humanMs, settings);
    ctx.ui.setStatus(
      'ledger',
      `ledger · agent ${fmtHours(totals.agentMs)} · human ${fmtHours(totals.humanMs)} · ${fmtMoney(b.total, settings.currency)}`
    );
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
    updateStatus(ctx);
  }

  pi.on('session_start', (_event, ctx) => {
    lastCtx = ctx;
    rehydrate(ctx);
  });

  pi.on('session_tree', (_event, ctx) => {
    lastCtx = ctx;
    rehydrate(ctx);
  });

  pi.on('session_shutdown', () => {
    disarmWizard();
  });

  // ── Agent timing (tool execution) ─────────────────────────────────────

  pi.on('turn_start', (event, ctx) => {
    lastCtx = ctx;
    currentTurnIndex = event.turnIndex;
    toolDepth = 0;
    toolSpanStart = 0;
    toolMsThisTurn = 0;
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

  // ── Agent segment (consumed from pi-tps) ──────────────────────────────

  pi.events.on(TPS_TELEMETRY_EVENT, (payload: unknown) => {
    const t = payload as TpsTelemetry | null;
    if (!t || !t.timing || !t.tokens || !t.model) return;
    tpsSeen = true;
    const generationMs = Number.isFinite(t.timing.generationMs) ? t.timing.generationMs : 0;
    const stallMs = Number.isFinite(t.timing.stallMs) ? t.timing.stallMs : 0;
    const toolMs = toolMsThisTurn;
    toolMsThisTurn = 0;
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
      timestamp: Date.now(),
    };
    pi.appendEntry(AGENT_CUSTOM_TYPE, seg);
    totals.agentMs += agentMs;
    totals.agentTurns += 1;
    totals.agentTokens.input += seg.tokens.input;
    totals.agentTokens.output += seg.tokens.output;
    totals.agentTokens.total += seg.tokens.total;
    updateStatus(lastCtx);
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
    if (!tpsSeen) {
      notify(
        ctx,
        'pi-ledger: no tps:telemetry seen — install @monotykamary/pi-tps to track agent time.',
        'warning'
      );
    }
    armWizardForBoundary(ctx);
    updateStatus(ctx);
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand('ledger', {
    description: 'Show running billable totals (agent + human hours, blended rate, total).',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const b = computeBilling(totals.agentMs, totals.humanMs, settings);
      const msg =
        `agent ${fmtHours(totals.agentMs)} (${totals.agentTurns} turns) @ ${fmtMoney(settings.agentRatePerHour, settings.currency)}/h = ${fmtMoney(b.agentCost, settings.currency)}` +
        ` · human ${fmtHours(totals.humanMs)} (${totals.humanWindows} windows) @ ${fmtMoney(settings.humanRatePerHour, settings.currency)}/h = ${fmtMoney(b.humanCost, settings.currency)}` +
        ` · blended ${b.totalHours > 0 ? fmtMoney(b.blendedRate, settings.currency) + '/h' : '—'}` +
        ` · total ${fmtMoney(b.total, settings.currency)}`;
      ctx.ui.notify(msg, 'info');
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
      const b = computeBilling(totals.agentMs, totals.humanMs, settings);
      const sessionId = ctx.sessionManager.getSessionId?.() ?? 'unknown';
      const startedAt = earliestLedgerTimestamp(ctx);
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
        agentTurns: totals.agentTurns,
        humanWindows: totals.humanWindows,
        agentTokens: { ...totals.agentTokens },
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
    return (currentValue: string, done: (selectedValue?: string) => void) => {
      const input = new Input();
      input.focused = true;
      input.setValue(currentValue);
      input.onSubmit = (v) => done(v);
      input.onEscape = () => done();
      const box = new Container();
      box.addChild(
        new Text(theme.fg('muted', placeholder + ' — enter to save · esc to cancel'), 1, 0)
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
    return (currentValue: string, done: (selectedValue?: string) => void) => {
      const input = new Input();
      input.focused = true;
      input.setValue(currentValue);
      input.onSubmit = (v) => done(v);
      input.onEscape = () => done();
      const box = new Container();
      box.addChild(
        new Text(theme.fg('muted', placeholder + ' — enter to save · esc to cancel'), 1, 0)
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
