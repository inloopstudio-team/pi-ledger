import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  activateExtension,
  createTestFixture,
  makeAssistantMessage,
  makeTpsTelemetry,
  type TestFixture,
} from './helpers';
import {
  applySettingValue,
  buildReceiptHtml,
  closeWindowBudget,
  computeAgentMs,
  computeBurstMs,
  computeBilling,
  consumeExtensionBudget,
  convertTpsEntries,
  extractTpsEntries,
  fmtHours,
  fmtMoney,
  lastAssistantStopReason,
  rehydrateFromSidecar,
  resolveExtensionBudget,
  sidecarPathFor,
  type LedgerSettings,
  type ReceiptData,
  type SidecarEvent,
  type SteerEvent,
} from '../index';

// Stub the browser opener so /ledger-receipt never launches anything during tests.
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const DEFAULTS: LedgerSettings = {
  agentRatePerHour: 60,
  humanRatePerHour: 60,
  pomodoroMinutes: 20,
  referenceTps: 75,
  project: '',
  author: '',
  currency: 'USD',
  autoWizard: true,
};

const KIND_BY_CUSTOM_TYPE: Record<string, SidecarEvent['kind']> = {
  'ledger-agent': 'agent',
  'ledger-human': 'human-close',
};

function lastEntry(fixture: TestFixture, customType: string): any {
  return fixture.lastSidecarEvent(
    KIND_BY_CUSTOM_TYPE[customType] ?? (customType as SidecarEvent['kind'])
  );
}

function entryCount(fixture: TestFixture, customType: string): number {
  const kind = KIND_BY_CUSTOM_TYPE[customType] ?? (customType as SidecarEvent['kind']);
  return fixture.readSidecarEvents().filter((e) => e.kind === kind).length;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe('computeAgentMs', () => {
  it('bills output tokens at the reference TPS plus tool time', () => {
    // 750 output tokens ÷ 75 TPS = 10s = 10_000ms; + 300ms tools
    expect(computeAgentMs(750, 300, 75)).toBe(10_300);
  });
  it('bills only tool time when there are no output tokens', () => {
    // generation is billed by tokens; no tokens → no generation bill (stalls moot)
    expect(computeAgentMs(0, 300, 75)).toBe(300);
  });
  it('ignores negative tool time', () => {
    expect(computeAgentMs(750, -50, 75)).toBe(10_000);
  });
  it('scales the generation bill by the reference TPS (higher TPS → lower bill)', () => {
    // same 750 tokens: at 150 TPS the normalized time halves vs 75 TPS
    expect(computeAgentMs(750, 0, 150)).toBe(5_000);
    expect(computeAgentMs(750, 0, 75)).toBe(10_000);
  });
});

describe('closeWindowBudget', () => {
  it('bills the full idle when under budget', () => {
    expect(closeWindowBudget(0, 30_000, 60_000)).toEqual({ idleMs: 30_000, billedMs: 30_000 });
  });
  it('caps billing at the granted budget', () => {
    expect(closeWindowBudget(0, 90_000, 60_000)).toEqual({ idleMs: 90_000, billedMs: 60_000 });
  });
  it('clamps negative durations', () => {
    expect(closeWindowBudget(100, 50, 60_000)).toEqual({ idleMs: 0, billedMs: 0 });
  });
});

describe('consumeExtensionBudget', () => {
  it('consumes the billed time up to the provisioned budget', () => {
    expect(consumeExtensionBudget(30_000, 20 * 60_000)).toBe(30_000); // 30s billed → 30s consumed
    expect(consumeExtensionBudget(5 * 60_000, 20 * 60_000)).toBe(5 * 60_000); // 5m → 5m
  });
  it('caps consumption at the remaining provisioned budget', () => {
    // billed 10m, only 2m provisioned → consume 2m
    expect(consumeExtensionBudget(10 * 60_000, 2 * 60_000)).toBe(2 * 60_000);
  });
  it('clamps zero/empty budgets', () => {
    expect(consumeExtensionBudget(5 * 60_000, 0)).toBe(0);
    expect(consumeExtensionBudget(0, 20 * 60_000)).toBe(0);
  });
});

describe('resolveExtensionBudget', () => {
  it('reads the recorded field when present (open + close)', () => {
    const open = {
      kind: 'human-open',
      openedAt: 0,
      grantedBudgetMs: 20 * 60_000,
      extensions: 1,
      extensionBudgetMs: 20 * 60_000,
      timestamp: 0,
    } as SidecarEvent;
    expect(resolveExtensionBudget(open)).toBe(20 * 60_000);
    const close = {
      kind: 'human-close',
      openedAt: 0,
      closedAt: 1000,
      billedMs: 1000,
      idleMs: 1000,
      grantedBudgetMs: 20 * 60_000,
      extensions: 1,
      extensionBudgetMs: 19 * 60_000,
      timestamp: 1,
    } as SidecarEvent;
    expect(resolveExtensionBudget(close)).toBe(19 * 60_000);
  });
  it('backfills an open legacy event as the recorded cap (no field)', () => {
    const open = {
      kind: 'human-open',
      openedAt: 0,
      grantedBudgetMs: 20 * 60_000,
      extensions: 1,
      timestamp: 0,
    } as SidecarEvent;
    expect(resolveExtensionBudget(open)).toBe(20 * 60_000);
  });
  it('backfills a close legacy event as cap − billed', () => {
    // billed 5m, cap 20m → remaining = 20m − 5m = 15m
    const close = {
      kind: 'human-close',
      openedAt: 0,
      closedAt: 5 * 60_000,
      billedMs: 5 * 60_000,
      idleMs: 5 * 60_000,
      grantedBudgetMs: 20 * 60_000,
      extensions: 1,
      timestamp: 1,
    } as SidecarEvent;
    expect(resolveExtensionBudget(close)).toBe(15 * 60_000);
  });
});

describe('computeBilling', () => {
  it('splits agent/human costs and blends', () => {
    const s = { ...DEFAULTS, agentRatePerHour: 100, humanRatePerHour: 50 };
    // 1h agent, 0.5h human
    const b = computeBilling(3_600_000, 1_800_000, s);
    expect(b.agentHours).toBe(1);
    expect(b.humanHours).toBe(0.5);
    expect(b.agentCost).toBe(100);
    expect(b.humanCost).toBe(25);
    expect(b.total).toBe(125);
    expect(b.totalHours).toBe(1.5);
  });
});

describe('formatting', () => {
  it('fmtHours', () => {
    expect(fmtHours(3_600_000)).toBe('1.00h');
    expect(fmtHours(1_800_000)).toBe('0.50h');
  });
  it('fmtMoney uses currency symbol', () => {
    expect(fmtMoney(125, 'USD')).toBe('$125.00');
    expect(fmtMoney(125, 'EUR')).toBe('€125.00');
    expect(fmtMoney(125, 'VND')).toBe('₫125.00');
    expect(fmtMoney(125, 'XYZ')).toBe('125.00'); // unknown → no symbol
  });
});

describe('lastAssistantStopReason', () => {
  it('returns the stopReason of the last assistant message', () => {
    expect(
      lastAssistantStopReason([{ role: 'user' }, { role: 'assistant', stopReason: 'error' }])
    ).toBe('error');
    expect(lastAssistantStopReason([{ role: 'assistant', stopReason: 'stop' }])).toBe('stop');
  });
  it('scans from the end and stops at the first assistant', () => {
    expect(
      lastAssistantStopReason([
        { role: 'assistant', stopReason: 'stop' },
        { role: 'assistant', stopReason: 'error' },
      ])
    ).toBe('error');
  });
  it('skips a trailing toolResult/user message', () => {
    expect(
      lastAssistantStopReason([{ role: 'assistant', stopReason: 'error' }, { role: 'toolResult' }])
    ).toBe('error');
  });
  it('returns undefined when no assistant is present', () => {
    expect(lastAssistantStopReason([{ role: 'user' }, { role: 'toolResult' }])).toBeUndefined();
    expect(lastAssistantStopReason([])).toBeUndefined();
  });
  it('returns undefined for non-array input', () => {
    expect(lastAssistantStopReason(undefined)).toBeUndefined();
    expect(lastAssistantStopReason(null)).toBeUndefined();
    expect(lastAssistantStopReason({})).toBeUndefined();
  });
});

describe('applySettingValue', () => {
  it('parses numeric rates and clamps negatives', () => {
    expect(applySettingValue(DEFAULTS, 'agentRatePerHour', '100').agentRatePerHour).toBe(100);
    expect(
      applySettingValue({ ...DEFAULTS, agentRatePerHour: 50 }, 'agentRatePerHour', '-5')
        .agentRatePerHour
    ).toBe(50); // reject negative → keeps old
    expect(applySettingValue(DEFAULTS, 'humanRatePerHour', '12.5').humanRatePerHour).toBe(12.5);
  });
  it('clamps pomodoro to a sane integer (min 1)', () => {
    expect(applySettingValue(DEFAULTS, 'pomodoroMinutes', '0').pomodoroMinutes).toBe(1); // min 1
    expect(applySettingValue(DEFAULTS, 'pomodoroMinutes', '15.7').pomodoroMinutes).toBe(16);
  });
  it('accepts a positive reference TPS and rejects non-positive', () => {
    expect(applySettingValue(DEFAULTS, 'referenceTps', '100').referenceTps).toBe(100);
    expect(applySettingValue(DEFAULTS, 'referenceTps', '12.5').referenceTps).toBe(12.5);
    expect(
      applySettingValue({ ...DEFAULTS, referenceTps: 75 }, 'referenceTps', '0').referenceTps
    ).toBe(75); // reject 0 → keeps old
    expect(
      applySettingValue({ ...DEFAULTS, referenceTps: 75 }, 'referenceTps', '-5').referenceTps
    ).toBe(75); // reject negative → keeps old
  });
  it('sets text fields and currency/toggle', () => {
    expect(applySettingValue(DEFAULTS, 'project', 'app.inloop.studio').project).toBe(
      'app.inloop.studio'
    );
    expect(applySettingValue(DEFAULTS, 'author', 'tom').author).toBe('tom');
    expect(applySettingValue(DEFAULTS, 'currency', 'EUR').currency).toBe('EUR');
    expect(applySettingValue(DEFAULTS, 'autoWizard', 'off').autoWizard).toBe(false);
    expect(applySettingValue(DEFAULTS, 'autoWizard', 'on').autoWizard).toBe(true);
  });
  it('ignores non-numeric input for numeric fields', () => {
    expect(
      applySettingValue({ ...DEFAULTS, agentRatePerHour: 50 }, 'agentRatePerHour', 'nope')
        .agentRatePerHour
    ).toBe(50);
  });
});

describe('rehydrateFromSidecar', () => {
  it('replays agent + human events and restores last settings', () => {
    const events: SidecarEvent[] = [
      { kind: 'settings', settings: { ...DEFAULTS, agentRatePerHour: 100 }, timestamp: 0 },
      {
        kind: 'agent',
        id: 'a1',
        turnIndex: 0,
        agentMs: 3_600_000,
        generationMs: 3_000_000,
        stallMs: 0,
        toolMs: 600_000,
        tokens: { input: 100, output: 50, total: 150 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        timestamp: 1000,
      },
      {
        kind: 'human-close',
        openedAt: 0,
        closedAt: 1_800_000,
        billedMs: 1_800_000,
        idleMs: 1_800_000,
        grantedBudgetMs: 60_000,
        extensions: 0,
        timestamp: 2000,
      },
    ];
    const r = rehydrateFromSidecar(events);
    expect(r.settings.agentRatePerHour).toBe(100);
    expect(r.totals.agentMs).toBe(3_600_000);
    expect(r.totals.humanMs).toBe(1_800_000);
    expect(r.totals.agentTurns).toBe(1);
    expect(r.totals.humanWindows).toBe(1);
    expect(r.totals.agentTokens.total).toBe(150);
    expect(r.humanWindow).toBeNull();
  });
  it('replays itemized sub-totals (agent gen/tool/stall, human idle/steer/queue/abandoned, extensions)', () => {
    const events: SidecarEvent[] = [
      { kind: 'settings', settings: { ...DEFAULTS, agentRatePerHour: 100 }, timestamp: 0 },
      {
        kind: 'agent',
        id: 'a1',
        turnIndex: 0,
        agentMs: 3_600_000,
        generationMs: 3_000_000,
        stallMs: 500,
        toolMs: 600_000,
        tokens: { input: 100, output: 50, total: 150 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        timestamp: 1000,
      },
      {
        kind: 'agent',
        id: 'a2',
        turnIndex: 1,
        agentMs: 2_000_000,
        generationMs: 2_000_000,
        stallMs: 0,
        toolMs: 0,
        tokens: { input: 200, output: 100, total: 300 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        timestamp: 2000,
      },
      // idle window engaged via extension: grants one 20m block (1_200_000ms)
      {
        kind: 'human-open',
        openedAt: 10_000,
        grantedBudgetMs: 1_200_000,
        extensions: 1,
        engagedVia: 'extension',
        extensionBudgetMs: 1_200_000,
        timestamp: 10_000,
      },
      // committed idle: bills 120s (consumes 120s of the 20m credit)
      {
        kind: 'human-close',
        openedAt: 10_000,
        closedAt: 130_000,
        billedMs: 120_000,
        idleMs: 120_000,
        keystrokes: 50,
        committed: true,
        grantedBudgetMs: 1_200_000,
        extensions: 1,
        extensionBudgetMs: 1_080_000,
        timestamp: 130_000,
      },
      // a steer (30s, consumes 30s) and a followUp (10s, consumes 10s)
      {
        kind: 'steer',
        startedAt: 200_000,
        submittedAt: 230_000,
        durationMs: 30_000,
        billedMs: 30_000,
        keystrokes: 20,
        behavior: 'steer',
        grantedBudgetMs: 1_080_000,
        extensionBudgetMs: 1_050_000,
        timestamp: 230_000,
      },
      {
        kind: 'steer',
        startedAt: 300_000,
        submittedAt: 310_000,
        durationMs: 10_000,
        billedMs: 10_000,
        keystrokes: 5,
        behavior: 'followUp',
        grantedBudgetMs: 1_050_000,
        extensionBudgetMs: 1_040_000,
        timestamp: 310_000,
      },
      // an abandoned window (walked away; no submit → 0 billed, consumes nothing)
      {
        kind: 'human-open',
        openedAt: 400_000,
        grantedBudgetMs: 1_040_000,
        extensions: 0,
        engagedVia: 'keystroke',
        extensionBudgetMs: 1_040_000,
        timestamp: 400_000,
      },
      {
        kind: 'human-close',
        openedAt: 400_000,
        closedAt: 600_000,
        billedMs: 0,
        idleMs: 200_000,
        committed: false,
        grantedBudgetMs: 1_040_000,
        extensions: 0,
        extensionBudgetMs: 1_040_000,
        timestamp: 600_000,
      },
    ];
    const r = rehydrateFromSidecar(events);
    // agent split: generation (token-normalized) vs tool, plus unbilled stall
    expect(r.totals.agentMs).toBe(5_600_000);
    expect(r.totals.agentGenMs).toBe(5_000_000); // (3.6m−600k) + 2m
    expect(r.totals.agentToolMs).toBe(600_000);
    expect(r.totals.stallMs).toBe(500);
    expect(r.totals.toolTurns).toBe(1);
    expect(r.totals.stalledTurns).toBe(1);
    expect(r.totals.agentTurns).toBe(2);
    // human split: committed idle vs steering vs queuing, plus abandoned
    expect(r.totals.humanMs).toBe(160_000); // 120k + 30k + 10k (abandoned bills 0)
    expect(r.totals.humanWindows).toBe(3);
    expect(r.totals.humanIdleMs).toBe(120_000);
    expect(r.totals.idleWindows).toBe(1);
    expect(r.totals.idleKeystrokes).toBe(50);
    expect(r.totals.humanSteerMs).toBe(30_000);
    expect(r.totals.steerCount).toBe(1);
    expect(r.totals.steerKeystrokes).toBe(20);
    expect(r.totals.humanQueueMs).toBe(10_000);
    expect(r.totals.queueCount).toBe(1);
    expect(r.totals.queueKeystrokes).toBe(5);
    expect(r.totals.abandonedWindows).toBe(1);
    expect(r.totals.abandonedMs).toBe(200_000);
    // extensions: 1 block granted (1_200_000), 160s consumed (120+30+10), 1_040_000 remaining
    expect(r.totals.extensionsGranted).toBe(1);
    expect(r.totals.extensionCreditMs).toBe(1_200_000);
    expect(r.totals.extensionConsumedMs).toBe(160_000);
    expect(r.extensionBudgetMs).toBe(1_040_000);
    expect(r.totals.extensionCreditMs - r.totals.extensionConsumedMs).toBe(r.extensionBudgetMs);
  });
  it('defaults settings when none persisted', () => {
    const r = rehydrateFromSidecar([]);
    expect(r.settings).toEqual(DEFAULTS);
    expect(r.totals.agentMs).toBe(0);
    expect(r.humanWindow).toBeNull();
  });
  it('supersedes a fallback agent event with the later tps event for the same turn (no double-count)', () => {
    const events: SidecarEvent[] = [
      {
        kind: 'agent',
        id: 'fb',
        turnIndex: 0,
        agentMs: 800,
        generationMs: 800,
        stallMs: 0,
        toolMs: 0,
        tokens: { input: 0, output: 0, total: 0 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'fallback',
        timestamp: 1,
      },
      {
        kind: 'agent',
        id: 'tps',
        turnIndex: 0,
        agentMs: 1500,
        generationMs: 2000,
        stallMs: 500,
        toolMs: 0,
        tokens: { input: 10, output: 5, total: 15 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        supersedes: 'fb',
        timestamp: 2,
      },
    ];
    const r = rehydrateFromSidecar(events);
    expect(r.totals.agentMs).toBe(1500);
    expect(r.totals.agentTurns).toBe(1);
    expect(r.totals.agentTokens.total).toBe(15);
  });
  it('reconstructs the open human window from the last unclosed human-open', () => {
    const events: SidecarEvent[] = [
      {
        kind: 'human-open',
        openedAt: 5000,
        grantedBudgetMs: 60_000,
        extensions: 0,
        timestamp: 5000,
      },
    ];
    const r = rehydrateFromSidecar(events);
    expect(r.humanWindow).toEqual({
      openedAt: 5000,
      grantedBudgetMs: 60_000,
      extensions: 0,
      engagedVia: 'keystroke',
    });
  });
  it('does not reconstruct a human window that was closed', () => {
    const events: SidecarEvent[] = [
      {
        kind: 'human-open',
        openedAt: 5000,
        grantedBudgetMs: 60_000,
        extensions: 0,
        timestamp: 5000,
      },
      {
        kind: 'human-close',
        openedAt: 5000,
        closedAt: 9000,
        billedMs: 4000,
        idleMs: 4000,
        grantedBudgetMs: 60_000,
        extensions: 0,
        timestamp: 9000,
      },
    ];
    const r = rehydrateFromSidecar(events);
    expect(r.humanWindow).toBeNull();
    expect(r.totals.humanMs).toBe(4000);
    expect(r.totals.humanWindows).toBe(1);
  });
  it('reconstructs the rolling extension budget carried into an open window', () => {
    const events: SidecarEvent[] = [
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 1000,
        grantedBudgetMs: 21 * 60_000,
        extensions: 1,
        extensionBudgetMs: 20 * 60_000,
        timestamp: 1000,
      },
    ];
    const r = rehydrateFromSidecar(events);
    expect(r.humanWindow).toEqual({
      openedAt: 1000,
      grantedBudgetMs: 21 * 60_000,
      extensions: 1,
      engagedVia: 'keystroke',
    });
    expect(r.extensionBudgetMs).toBe(20 * 60_000);
  });
  it('reconstructs the rolling budget remaining after a closed window', () => {
    const events: SidecarEvent[] = [
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 1000,
        grantedBudgetMs: 21 * 60_000,
        extensions: 1,
        extensionBudgetMs: 20 * 60_000,
        timestamp: 1000,
      },
      {
        kind: 'human-close',
        openedAt: 1000,
        closedAt: 3 * 60_000,
        billedMs: 3 * 60_000,
        idleMs: 3 * 60_000,
        grantedBudgetMs: 21 * 60_000,
        extensions: 1,
        extensionBudgetMs: 18 * 60_000,
        timestamp: 3000,
      },
    ];
    const r = rehydrateFromSidecar(events);
    expect(r.humanWindow).toBeNull();
    expect(r.extensionBudgetMs).toBe(18 * 60_000);
  });
  it('backfills the rolling budget for legacy events missing the field', () => {
    // open with cap 20m (20m ext), no extensionBudgetMs field
    const events: SidecarEvent[] = [
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 1000,
        grantedBudgetMs: 20 * 60_000,
        extensions: 1,
        timestamp: 1000,
      },
    ];
    const r = rehydrateFromSidecar(events);
    expect(r.extensionBudgetMs).toBe(20 * 60_000);
  });
});

describe('extractTpsEntries + convertTpsEntries', () => {
  it('extracts only tps markers', () => {
    const entries = [
      { type: 'custom', customType: 'ledger-settings', data: {} },
      {
        type: 'custom',
        customType: 'tps',
        data: {
          timing: { generationMs: 1, stallMs: 0, totalMs: 1 },
          tokens: { input: 0, output: 0, total: 0 },
          model: { provider: 'p', modelId: 'm' },
          timestamp: 10,
        },
      },
      { type: 'custom', customType: 'ledger-agent', data: {} },
    ];
    const tps = extractTpsEntries(entries);
    expect(tps).toHaveLength(1);
    expect(tps[0]!.timestamp).toBe(10);
  });

  it('converts markers to agent time (no human estimate — markers carry no credit/commit info)', () => {
    const c = convertTpsEntries(
      [
        {
          timing: { generationMs: 2000, stallMs: 0, totalMs: 2500 },
          tokens: { input: 100, output: 50, total: 150 },
          model: { provider: 'p', modelId: 'm' },
          timestamp: 0,
        },
        {
          timing: { generationMs: 3000, stallMs: 500, totalMs: 4000 },
          tokens: { input: 200, output: 100, total: 300 },
          model: { provider: 'p', modelId: 'm' },
          timestamp: 70000,
        },
        {
          timing: { generationMs: 1000, stallMs: 0, totalMs: 1500 },
          tokens: { input: 50, output: 25, total: 75 },
          model: { provider: 'p', modelId: 'm' },
          timestamp: 90000,
        },
      ],
      75
    );
    // agent = (50 + 100 + 25) output tokens ÷ 75 TPS = 667 + 1333 + 333 = 2333
    expect(c.agentMs).toBe(2333);
    expect(c.agentTurns).toBe(3);
    expect(c.agentTokens.total).toBe(525);
    // idle bills only against credit; markers carry none → 0 human time
    expect(c.humanMs).toBe(0);
    expect(c.humanWindows).toBe(0);
    expect(c.startedAt).toBe(0);
  });

  it('returns zeros for no markers', () => {
    const c = convertTpsEntries([], 75);
    expect(c.agentMs).toBe(0);
    expect(c.humanMs).toBe(0);
    expect(c.startedAt).toBe(0);
  });
});

describe('buildReceiptHtml', () => {
  const data: ReceiptData = {
    project: 'app.inloop.studio',
    author: 'Tom Nguyen',
    sessionId: '019fabcd',
    currency: 'USD',
    agentRate: 100,
    humanRate: 50,
    agentHours: 1.2,
    humanHours: 0.5,
    agentCost: 120,
    humanCost: 25,
    total: 145,
    agentTurns: 3,
    humanWindows: 2,
    agentTokens: { input: 1000, output: 500, total: 1500 },
    startedAt: 1_700_000_000_000,
    generatedAt: 1_700_000_180_000,
  };

  it('is a standalone document with Geist Mono', () => {
    const html = buildReceiptHtml(data);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Geist+Mono');
  });
  it('carries the brand, tagline, and project', () => {
    const html = buildReceiptHtml(data);
    expect(html).toContain('pi-ledger');
    expect(html).toContain('billed like serverless');
    expect(html).toContain('app.inloop.studio');
    expect(html).toContain('Tom Nguyen');
  });
  it('renders agent + human line items and the total', () => {
    const html = buildReceiptHtml(data);
    expect(html).toContain('data-reveal="Agent"');
    expect(html).toContain('data-reveal="Human"');
    expect(html).toContain('$120.00');
    expect(html).toContain('$25.00');
    expect(html).toContain('$145.00');
  });
  it('marks values as autoregressively revealable', () => {
    const html = buildReceiptHtml(data);
    const reveals = html.match(/data-reveal="/g);
    expect(reveals && reveals.length).toBeGreaterThan(10);
    expect(html).toContain('nextBlock'); // block-by-block typewriter engine
    expect(html).toContain('r-block r-hidden'); // starts blank, grows line by line
  });
  it('renders the itemized invoice: sub-items, $0 nuances, subtotals, footer', () => {
    const MS = 3_600_000;
    const h = (n: number) => n * MS;
    const full: ReceiptData = {
      ...data,
      agentRate: 20,
      humanRate: 60,
      agentHours: 1.23,
      humanHours: 0.97,
      agentCost: 24.6,
      humanCost: 58.2,
      total: 82.8,
      agentTurns: 42,
      humanWindows: 3 + 9 + 5,
      agentTokens: { input: 4100, output: 14300, total: 18400 },
      agentGenMs: h(0.95),
      agentToolMs: h(0.28),
      stallMs: h(0.3),
      toolTurns: 14,
      stalledTurns: 3,
      humanIdleMs: h(0.85),
      humanSteerMs: h(0.1),
      humanQueueMs: h(0.02),
      idleWindows: 3,
      steerCount: 9,
      queueCount: 5,
      idleKeystrokes: 412,
      steerKeystrokes: 88,
      queueKeystrokes: 24,
      abandonedWindows: 2,
      abandonedMs: h(0.15),
      extensionsGranted: 3,
      extensionCreditMs: 3 * 20 * 60_000,
      extensionConsumedMs: 50 * 60_000,
      startedAt: 1_700_000_000_000,
      generatedAt: 1_700_000_000_000 + h(3.4),
    };
    const html = buildReceiptHtml(full);
    // group headers carry the hourly rate (corroborating the pricing)
    expect(html).toContain('data-reveal="Agent"');
    expect(html).toContain('data-reveal="@ $20.00/h"');
    expect(html).toContain('data-reveal="@ $60.00/h"');
    // agent sub-items at the agent rate, summing to the subtotal
    expect(html).toContain('data-reveal="Compute (generation)"');
    expect(html).toContain('data-reveal="Tool execution"');
    expect(html).toContain('data-reveal="$19.00"'); // 0.95h × $20
    expect(html).toContain('data-reveal="$5.60"'); // 0.28h × $20
    // human sub-items at the human rate
    expect(html).toContain('data-reveal="Review / think"');
    expect(html).toContain('data-reveal="Steering"');
    expect(html).toContain('data-reveal="Queuing"');
    expect(html).toContain('data-reveal="$51.00"'); // 0.85h × $60
    expect(html).toContain('data-reveal="$6.00"'); // 0.10h × $60
    expect(html).toContain('data-reveal="$1.20"'); // 0.02h × $60
    // $0 nuance lines prove what we DON'T bill
    expect(html).toContain('data-reveal="Stalls"');
    expect(html).toContain('data-reveal="Idle abandoned"');
    expect(html).toContain('data-reveal="$0.00"');
    expect(html).toContain('data-reveal="not billed"');
    // subtotals + grand total reconcile
    expect(html).toContain('data-reveal="$24.60"'); // agent subtotal
    expect(html).toContain('data-reveal="$58.20"'); // human subtotal
    expect(html).toContain('data-reveal="$82.80"'); // total
    // footer: provisioned capacity + session span
    expect(html).toContain('Extensions: 3 granted · 60m total · 50m used · 10m remaining');
    expect(html).toContain('Session span 3.40 h · billed 2.20 h');
  });
});

// ─── Integration (fake timers) ──────────────────────────────────────────────

describe('extension integration', () => {
  let fixture: TestFixture;

  let cacheDir: string;
  beforeEach(async () => {
    vi.useFakeTimers();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-test-'));
    process.env.XDG_CACHE_HOME = cacheDir;
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.XDG_CACHE_HOME;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('registers the four commands', () => {
    expect(fixture.commands['ledger']).toBeDefined();
    expect(fixture.commands['ledger-extend']).toBeDefined();
    expect(fixture.commands['ledger-settings']).toBeDefined();
    expect(fixture.commands['ledger-receipt']).toBeDefined();
  });

  it('records an agent segment from tps:telemetry + tool time (stalls excluded)', async () => {
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    fixture.run('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'a',
      toolName: 'bash',
      args: {},
    });
    await vi.advanceTimersByTimeAsync(800);
    fixture.run('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'bash',
      result: {},
      isError: false,
    });
    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ generationMs: 2000, stallMs: 500, input: 1000, output: 400, total: 1400 })
    );

    const seg = lastEntry(fixture, 'ledger-agent');
    expect(seg).toBeDefined();
    // 400 output tokens ÷ 75 TPS = 5333ms + 800ms tools = 6133 (speed-invariant;
    // the 500ms stall is recorded below but not billed)
    expect(seg.agentMs).toBe(6133);
    expect(seg.toolMs).toBe(800);
    expect(seg.generationMs).toBe(2000);
    expect(seg.stallMs).toBe(500);
    expect(seg.turnIndex).toBe(1);
    expect(seg.tokens.total).toBe(1400);
  });

  it('bills the same agent time for a fast and a slow model with equal output (speed-invariant)', async () => {
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    // slow model: 30s real generation for 1500 output tokens (50 TPS)
    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ generationMs: 30_000, stallMs: 0, output: 1500, total: 1500 })
    );
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    // fast model: 5s real generation for the same 1500 output tokens (300 TPS)
    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ generationMs: 5_000, stallMs: 0, output: 1500, total: 1500 })
    );

    const events = fixture.readSidecarEvents().filter((e) => e.kind === 'agent');
    // both normalize to 1500 ÷ 75 × 1000 = 20_000ms regardless of real speed
    expect(events[0]!.agentMs).toBe(20_000);
    expect(events[1]!.agentMs).toBe(20_000);
    // the real wall-clock generation is preserved for audit
    expect(events[0]!.generationMs).toBe(30_000);
    expect(events[1]!.generationMs).toBe(5_000);
  });

  it('measures parallel tool execution as a union span (no double-count)', async () => {
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.run('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'a',
      toolName: 'bash',
      args: {},
    });
    await vi.advanceTimersByTimeAsync(200);
    fixture.run('tool_execution_start', {
      type: 'tool_execution_start',
      toolCallId: 'b',
      toolName: 'read',
      args: {},
    });
    await vi.advanceTimersByTimeAsync(300);
    fixture.run('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'b',
      toolName: 'read',
      result: {},
      isError: false,
    });
    await vi.advanceTimersByTimeAsync(100);
    fixture.run('tool_execution_end', {
      type: 'tool_execution_end',
      toolCallId: 'a',
      toolName: 'bash',
      result: {},
      isError: false,
    });
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ generationMs: 1000, stallMs: 0 }));

    const seg = lastEntry(fixture, 'ledger-agent');
    expect(seg.toolMs).toBe(600); // union [0,600], not 200+400+... summed
  });

  it('records a fallback agent segment at turn_end when pi-tps is absent', async () => {
    const msg = makeAssistantMessage();
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.run('message_start', { type: 'message_start', message: msg });
    fixture.run('message_update', { type: 'message_update', message: msg }); // first token
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_update', { type: 'message_update', message: msg });
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_update', { type: 'message_update', message: msg });
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_end', { type: 'message_end', message: msg });
    // no tps:telemetry → fallback fires at turn_end
    fixture.run('turn_end', { type: 'turn_end', turnIndex: 0, message: msg, toolResults: [] });

    const seg = lastEntry(fixture, 'ledger-agent');
    expect(seg).toBeDefined();
    expect(seg.source).toBe('fallback');
    // 50 output tokens ÷ 75 TPS = 667ms (speed-invariant; real 1200ms below is audit)
    expect(seg.agentMs).toBe(667);
    expect(seg.generationMs).toBe(1200);
    expect(seg.stallMs).toBe(0);
    expect(seg.model.modelId).toBe('gpt-4');
  });

  it('excludes stalls in the fallback measurement', async () => {
    const msg = makeAssistantMessage();
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.run('message_start', { type: 'message_start', message: msg });
    fixture.run('message_update', { type: 'message_update', message: msg }); // first token
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_update', { type: 'message_update', message: msg }); // gap 400, no stall
    await vi.advanceTimersByTimeAsync(1500);
    fixture.run('message_update', { type: 'message_update', message: msg }); // gap 1500 → stall
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_end', { type: 'message_end', message: msg });
    fixture.run('turn_end', { type: 'turn_end', turnIndex: 0, message: msg, toolResults: [] });

    const seg = lastEntry(fixture, 'ledger-agent');
    // 50 output tokens ÷ 75 TPS = 667ms — stalls are recorded (1500ms below) but
    // excluded from billing automatically (a stall produces no tokens)
    expect(seg.source).toBe('fallback');
    expect(seg.generationMs).toBe(2300);
    expect(seg.stallMs).toBe(1500);
    expect(seg.agentMs).toBe(667);
  });

  it('corrects a fallback with the later tps segment for the same turn (no double-count)', async () => {
    const msg = makeAssistantMessage();
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.run('message_start', { type: 'message_start', message: msg });
    fixture.run('message_update', { type: 'message_update', message: msg });
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_update', { type: 'message_update', message: msg });
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_end', { type: 'message_end', message: msg });
    // ledger-before-tps load order: fallback first...
    fixture.run('turn_end', { type: 'turn_end', turnIndex: 0, message: msg, toolResults: [] });
    expect(lastEntry(fixture, 'ledger-agent').source).toBe('fallback');
    expect(lastEntry(fixture, 'ledger-agent').agentMs).toBe(667); // 50 tokens ÷ 75 TPS
    // ...then tps arrives and corrects it
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ generationMs: 2000, stallMs: 500 }));

    const seg = lastEntry(fixture, 'ledger-agent');
    expect(seg.source).toBe('tps');
    expect(seg.agentMs).toBe(6667); // 500 tokens ÷ 75 TPS = 6667ms
    expect(entryCount(fixture, 'ledger-agent')).toBe(2); // fallback + tps entries kept
    // rehydrate dedups → keeps tps
    // rehydrate from the sidecar: the fallback is superseded → only tps counts
    const r = rehydrateFromSidecar(fixture.readSidecarEvents());
    expect(r.totals.agentMs).toBe(6667);
    expect(r.totals.agentTurns).toBe(1);
  });

  it('writes no fallback once pi-tps has been seen (skipped turns stay skipped)', async () => {
    const msg = makeAssistantMessage();
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ generationMs: 1000, stallMs: 0 }));
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 1, timestamp: Date.now() });
    fixture.run('message_start', { type: 'message_start', message: msg });
    fixture.run('message_update', { type: 'message_update', message: msg });
    await vi.advanceTimersByTimeAsync(400);
    fixture.run('message_end', { type: 'message_end', message: msg });
    fixture.run('turn_end', { type: 'turn_end', turnIndex: 1, message: msg, toolResults: [] });
    // turn 1 had no tps:telemetry (skipped); tpsEverSeen is true → no fallback
    const agentEntries = fixture.readSidecarEvents().filter((e) => e.kind === 'agent');
    expect(agentEntries).toHaveLength(1); // only the turn-0 tps entry
  });

  it('pops the wizard at agent_end (no credit); engaging without extending bills 0', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' }); // install the editor (no pop)
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // no credit → wizard pops (engagement prompt)
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // flush the dismissed wizard promise
    fixture.sendEditorKey('k'); // ENGAGE the idle window at onset (no credit → cap 0)
    await vi.advanceTimersByTimeAsync(5000); // 5s idle, but cap is 0
    fixture.run('agent_start', { type: 'agent_start' }); // COMMIT → bills 0 (no credit provisioned)

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg).toBeDefined();
    expect(seg.billedMs).toBe(0);
    expect(seg.grantedBudgetMs).toBe(0);
    expect(seg.extensions).toBe(0);
    expect(seg.committed).toBe(true);
    expect(fixture.lastSidecarEvent('human-open')!.engagedVia).toBe('keystroke');
  });

  // ── Retry/queue turns (pi-retry backoff) are not human idle ─────────────

  it('does not open a human window when agent_end carries a provider error (retry in flight)', async () => {
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error' }],
    });
    // no human window → no wizard, no human-open event
    expect(fixture.customSpy).not.toHaveBeenCalled();
    expect(fixture.lastSidecarEvent('human-open')).toBeUndefined();
    // the retry's backoff sleep is NOT billed: agent_start has no window to close
    await vi.advanceTimersByTimeAsync(60_000); // a full minute of backoff
    fixture.run('agent_start', { type: 'agent_start' });
    expect(fixture.lastSidecarEvent('human-close')).toBeUndefined();
  });

  it('does not bill the retry backoff between an errored turn and the retry agent_start', async () => {
    // turn 1 errors → retry in flight (no human window opened, no engagement)
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error' }],
    });
    await vi.advanceTimersByTimeAsync(60_000); // 60s backoff — would bill if a window were open
    fixture.run('agent_start', { type: 'agent_start' }); // retry runs; nothing to close (no window)
    expect(fixture.lastSidecarEvent('human-close')).toBeUndefined(); // backoff NOT billed
    // retry succeeds → the agent hands back control, but no window opens until the
    // human engages (idle is engagement-gated now); nothing is billed yet.
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    });
    expect(fixture.readSidecarEvents().filter((e) => e.kind === 'human-open')).toHaveLength(0);
    expect(fixture.lastSidecarEvent('human-close')).toBeUndefined(); // still nothing billed
  });

  it('does not bill backoff across a multi-retry storm (one error turn per retry)', async () => {
    // simulate 3 errored retries, each separated by a 60s backoff
    for (let i = 0; i < 3; i++) {
      fixture.run('agent_end', {
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'error' }],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      fixture.run('agent_start', { type: 'agent_start' }); // retry fires
    }
    // no human window was ever opened or billed across the whole storm
    expect(fixture.readSidecarEvents().filter((e) => e.kind === 'human-open')).toHaveLength(0);
    expect(fixture.readSidecarEvents().filter((e) => e.kind === 'human-close')).toHaveLength(0);
  });

  it('pops the wizard for a normal (stop) agent_end; a keystroke then engages the window', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    });
    expect(fixture.customSpy).toHaveBeenCalledTimes(1); // wizard pops (engagement prompt)
    expect(fixture.lastSidecarEvent('human-open')).toBeUndefined(); // no window until engaged
    fixture.sendEditorKey('k'); // engage → opens the idle window
    expect(fixture.lastSidecarEvent('human-open')).toBeDefined();
  });

  it('still pops the wizard for an aborted agent_end (a retry is not in flight)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'aborted' }],
    });
    expect(fixture.customSpy).toHaveBeenCalledTimes(1); // wizard pops (not an error retry)
    expect(fixture.lastSidecarEvent('human-open')).toBeUndefined(); // no window until engaged
    fixture.sendEditorKey('k');
    expect(fixture.lastSidecarEvent('human-open')).toBeDefined();
  });

  it('pops the wizard when agent_end has no assistant message; a keystroke engages', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).toHaveBeenCalledTimes(1); // wizard pops
    expect(fixture.lastSidecarEvent('human-open')).toBeUndefined();
    fixture.sendEditorKey('k');
    expect(fixture.lastSidecarEvent('human-open')).toBeDefined();
  });

  it('bills 0 for engaged idle after the wizard is dismissed (no credit)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('stop');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // wizard pops, dismissed ('stop' → no engagement)
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // flush the dismissed wizard
    fixture.sendEditorKey('k'); // engage the idle window at onset (no credit → cap 0)
    await vi.advanceTimersByTimeAsync(90_000); // 90s engaged idle, no credit
    fixture.run('agent_start', { type: 'agent_start' }); // commit

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg.billedMs).toBe(0); // no credit → bills 0
    expect(seg.extensions).toBe(0);
  });

  it('extends the budget when the wizard is accepted', async () => {
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // wizard pops immediately, accepted → +20m, engages, re-armed at 20m
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(360_000); // 6m idle, under 20m budget → re-armed wizard not fired
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg.grantedBudgetMs).toBe(20 * 60_000);
    expect(seg.extensions).toBe(1);
    expect(seg.billedMs).toBe(360_000); // 6 min
  });

  it('bills the thinking span for extend + extend + extend + type-and-go (the nuance pattern)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('extend'); // every wizard pop → extend (engages + grants capacity)
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // no credit → 1st pop → engage + +20m
    await vi.advanceTimersByTimeAsync(0); // flush the 1st extend → openIdleWindow('extension', 20m), cap 20m
    // idle to the first exhaustion (20m credit) → 2nd pop → +20m (cap 40m)
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    // idle to the next exhaustion (another 20m) → 3rd pop → +20m (cap 60m)
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    // 10m more thinking (under the 60m cap), then type and go (submit → agent_start commits)
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg).toBeDefined();
    expect(seg.extensions).toBe(3); // three pomodoro blocks granted
    expect(seg.billedMs).toBe(50 * 60_000); // the whole thinking span (20 + 20 + 10) min, under the 60m cap
    expect(seg.committed).toBe(true); // committed by the submit (agent action), not abandoned
    expect(fixture.lastSidecarEvent('human-open')!.engagedVia).toBe('extension'); // engaged via the first extend

    // live accumulation round-trips through rehydrate: 3 blocks granted (60m),
    // 50m billed (all consumed against credit), 10m credit remaining.
    const r = rehydrateFromSidecar(fixture.readSidecarEvents());
    expect(r.totals.extensionsGranted).toBe(3);
    expect(r.totals.extensionCreditMs).toBe(3 * 20 * 60_000);
    expect(r.totals.extensionConsumedMs).toBe(50 * 60_000);
    expect(r.extensionBudgetMs).toBe(10 * 60_000);
    expect(r.totals.humanIdleMs).toBe(50 * 60_000);
    expect(r.totals.idleWindows).toBe(1);
    expect(r.totals.humanSteerMs).toBe(0);
    expect(r.totals.abandonedWindows).toBe(0);
  });

  it('suppresses the wizard at the next agent_end while rolling extension credit remains', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // pops → +20m, engages via extension
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000); // 2m idle (under 20m cap); flushes the extend
    fixture.run('agent_start', { type: 'agent_start' }); // commit: 2m billed, 2m ext consumed → 18m left

    const seg1 = lastEntry(fixture, 'ledger-human');
    expect(seg1.billedMs).toBe(120_000);
    expect(seg1.extensionBudgetMs).toBe(18 * 60_000);

    // next agent_end: 18m credit remains → wizard is NOT shown (no pop, no auto-open)
    fixture.customSpy.mockClear();
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled();
    // the idle window opens only on engagement; engage via keystroke → cap = 18m credit
    fixture.sendEditorKey('k');
    const open = fixture.lastSidecarEvent('human-open');
    expect(open!.grantedBudgetMs).toBe(18 * 60_000); // 18m rolling credit
    expect(open!.extensionBudgetMs).toBe(18 * 60_000);
  });

  it('rolls unused extension credit across multiple agent turns', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // pops → +20m, engages via extension
    await vi.advanceTimersByTimeAsync(120_000); // 2m idle (flushes the extend)
    fixture.run('agent_start', { type: 'agent_start' }); // commit → 2m billed, 2m consumed → 18m left

    // turn 2: 18m credit remains → no pop at agent_end; engage via keystroke
    fixture.customSpy.mockClear();
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled();
    fixture.sendEditorKey('k'); // engage the new window (cap = 18m credit)
    await vi.advanceTimersByTimeAsync(120_000); // 2m idle
    fixture.run('agent_start', { type: 'agent_start' }); // commit → 2m consumed → 16m left
    expect(lastEntry(fixture, 'ledger-human').extensionBudgetMs).toBe(16 * 60_000);

    // turn 3: still 16m credit → still suppressed
    fixture.customSpy.mockClear();
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled();
  });

  it('pops the wizard at agent_end when no rolling credit remains', async () => {
    fixture.seedSidecar([{ kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 }]);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' }); // rehydrate settings; no pop (startup)
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).toHaveBeenCalledTimes(1); // no credit → pop immediately
  });

  it('pops the wizard on /resume (and /reload) to prompt engagement for review', async () => {
    fixture.seedSidecar([{ kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 }]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' }); // resume → pop
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    fixture.customSpy.mockClear();
    fixture.run('session_start', { type: 'session_start', reason: 'reload' }); // reload → pop
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    fixture.customSpy.mockClear();
    fixture.run('session_start', { type: 'session_start', reason: 'startup' }); // startup → no pop
    expect(fixture.customSpy).not.toHaveBeenCalled();
  });

  it('suppresses the wizard at agent_end when rolling credit is rehydrated', async () => {
    // A prior idle window left 18m of rolling pomodoro credit on the sidecar.
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 0,
        grantedBudgetMs: 20 * 60_000,
        extensions: 1,
        extensionBudgetMs: 20 * 60_000,
        timestamp: 1000,
      },
      {
        kind: 'human-close',
        openedAt: 0,
        closedAt: 2 * 60_000,
        billedMs: 2 * 60_000,
        idleMs: 2 * 60_000,
        grantedBudgetMs: 20 * 60_000,
        extensions: 1,
        extensionBudgetMs: 18 * 60_000,
        timestamp: 2000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' }); // rehydrate 18m credit; no pop
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled(); // 18m credit → suppressed
    fixture.sendEditorKey('k'); // engage → open window with cap = 18m credit
    const open = fixture.lastSidecarEvent('human-open');
    expect(open!.grantedBudgetMs).toBe(18 * 60_000); // 18m credit
    expect(open!.extensionBudgetMs).toBe(18 * 60_000);
  });

  it('/ledger-extend opens the wizard; confirming extends by the given minutes', async () => {
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS, autoWizard: false }, timestamp: 0 },
    ]);
    fixture.setCustomResult('extend');
    fixture.run('session_start', { type: 'session_start', reason: 'resume' }); // apply autoWizard: false
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // opens window; autoWizard off → no auto-pop
    expect(fixture.customSpy).not.toHaveBeenCalled();

    await fixture.commands['ledger-extend'].handler('5', fixture.mockCtx); // opens the wizard → confirm → +5m
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100_000); // 100s idle, under 5m budget
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg.grantedBudgetMs).toBe(5 * 60_000);
    expect(seg.extensions).toBe(1);
    expect(seg.billedMs).toBe(100_000);
  });

  it('/ledger-extend opens the wizard with no window open (engage via extension)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('extend');
    await fixture.commands['ledger-extend'].handler('5', fixture.mockCtx); // no window → wizard → extend engages
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // flush the extend → openIdleWindow('extension', 5m)
    const open = fixture.lastSidecarEvent('human-open');
    expect(open).toBeDefined();
    expect(open!.engagedVia).toBe('extension');
    expect(open!.grantedBudgetMs).toBe(5 * 60_000); // 5m credit
  });

  it('rehydrates totals + settings on session_start and /ledger reports them', async () => {
    fixture.seedSidecar([
      {
        kind: 'settings',
        settings: {
          ...DEFAULTS,
          agentRatePerHour: 100,
          humanRatePerHour: 50,
          project: 'app',
          author: 'tom',
        },
        timestamp: 0,
      },
      {
        kind: 'agent',
        id: 'a1',
        turnIndex: 0,
        agentMs: 3_600_000,
        generationMs: 3_000_000,
        stallMs: 0,
        toolMs: 600_000,
        tokens: { input: 0, output: 0, total: 0 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        timestamp: 1000,
      },
      {
        kind: 'human-close',
        openedAt: 0,
        closedAt: 1_800_000,
        billedMs: 1_800_000,
        idleMs: 1_800_000,
        grantedBudgetMs: 60_000,
        extensions: 0,
        timestamp: 2000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await fixture.commands['ledger'].handler('', fixture.mockCtx);

    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('agent 1.00h (1 turns)');
    // 1 rehydrated closed human window — no initial window opens at session_start
    // (engagement-gated), so just 1 window.
    expect(msg).toContain('human 0.50h (1 windows)');
    expect(msg).toContain('total $125.00');
    // status line shows the live hours, grey (dim) like pi-core's footer
    expect(fixture.setStatusSpy).toHaveBeenCalledWith(
      'ledger',
      expect.stringContaining('agent 1.00h')
    );
  });

  it('derives the footer + /ledger hours from pi-tps markers for a tps-only session', async () => {
    fixture.seedSidecar([
      {
        kind: 'settings',
        settings: { ...DEFAULTS, agentRatePerHour: 120, humanRatePerHour: 60 },
        timestamp: 0,
      },
    ]);
    fixture.mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: {
        timing: { generationMs: 3_600_000, stallMs: 0, totalMs: 3_700_000 },
        tokens: { input: 0, output: 270000, total: 270000 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        timestamp: 1000,
      },
    });
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });

    // status line derives agent hours from the tps marker, grey like pi-core
    expect(fixture.setStatusSpy).toHaveBeenCalledWith(
      'ledger',
      expect.stringContaining('agent 1.00h')
    );

    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-2)![0] as string;
    expect(msg).toContain('agent 1.00h (1 turns)');
    expect(
      fixture.notifySpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('Derived from 1 pi-tps markers')
      )
    ).toBe(true);
  });

  it('counts the in-progress open human window in /ledger (entire session up to now)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // no credit → wizard → extend +20m (engages)
    await vi.advanceTimersByTimeAsync(0); // flush the extend → open window, cap 20m
    await vi.advanceTimersByTimeAsync(30_000); // 30s idle, window still open (uncommitted)
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    // the open window's 30s idle is counted now (against the 20m credit), not deferred to close
    expect(msg).toContain('human 0.01h (1 windows)');
  });

  it('defaults agent and human rates to $60/h', async () => {
    // no settings entry → the extension defaults ($60/h) apply
    fixture.seedSidecar([
      {
        kind: 'agent',
        id: 'a1',
        turnIndex: 0,
        agentMs: 3_600_000,
        generationMs: 3_600_000,
        stallMs: 0,
        toolMs: 0,
        tokens: { input: 0, output: 0, total: 0 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        timestamp: 1000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    // 1h agent @ $60/h = $60; 0h human; total $60
    expect(msg).toContain('= $60.00');
    expect(msg).toContain('total $60.00');
  });

  it('notifies (once, info) that built-in timing is in use when pi-tps is absent', async () => {
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.notifySpy).toHaveBeenCalledWith(
      expect.stringContaining('built-in timing'),
      'info'
    );
    fixture.notifySpy.mockClear();
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    const noted = fixture.notifySpy.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('built-in timing')
    );
    expect(noted).toBe(false); // one-time only
  });

  it('does not notify built-in timing after telemetry has been seen', async () => {
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry());
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    const noted = fixture.notifySpy.mock.calls.some(
      (c) => typeof c[0] === 'string' && c[0].includes('built-in timing')
    );
    expect(noted).toBe(false);
  });

  it('/ledger-receipt writes an HTML file with the totals', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-test-'));
    process.env.XDG_CACHE_HOME = tmp;
    try {
      fixture.seedSidecar([
        {
          kind: 'settings',
          settings: {
            ...DEFAULTS,
            agentRatePerHour: 100,
            humanRatePerHour: 50,
            project: 'app.inloop.studio',
            author: 'tom',
          },
          timestamp: 0,
        },
        {
          kind: 'agent',
          id: 'a1',
          turnIndex: 0,
          agentMs: 3_600_000,
          generationMs: 3_600_000,
          stallMs: 0,
          toolMs: 0,
          tokens: { input: 0, output: 0, total: 1500 },
          model: { provider: 'openai', modelId: 'gpt-4' },
          source: 'tps',
          timestamp: 1000,
        },
      ]);
      fixture.run('session_start', { type: 'session_start', reason: 'resume' });

      await fixture.commands['ledger-receipt'].handler('', fixture.mockCtx);

      const dir = path.join(tmp, 'pi-ledger');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
      expect(files).toHaveLength(1);
      const html = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
      expect(html).toContain('pi-ledger');
      expect(html).toContain('billed like serverless');
      expect(html).toContain('Geist+Mono');
      expect(html).toContain('app.inloop.studio');
      expect(html).toContain('data-reveal');
      expect(html).toContain('$100.00'); // agent cost for 1h @ $100
      expect(
        fixture.notifySpy.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].startsWith('Receipt →')
        )
      ).toBe(true);
    } finally {
      delete process.env.XDG_CACHE_HOME;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('/ledger-receipt converts pi-tps markers when there is no live ledger data', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-test-'));
    process.env.XDG_CACHE_HOME = tmp;
    try {
      // A session with only pi-tps markers — pi-ledger wasn't tracking.
      fixture.seedSidecar([
        {
          kind: 'settings',
          settings: { ...DEFAULTS, agentRatePerHour: 100, humanRatePerHour: 50, project: 'demo' },
          timestamp: 0,
        },
      ]);
      fixture.mockEntries.push({
        type: 'custom',
        customType: 'tps',
        data: {
          timing: { generationMs: 3_600_000, stallMs: 0, totalMs: 3_700_000 },
          tokens: { input: 0, output: 270000, total: 270000 },
          model: { provider: 'openai', modelId: 'gpt-4' },
          timestamp: 1000,
        },
      });
      fixture.run('session_start', { type: 'session_start', reason: 'resume' }); // settings + empty totals

      await fixture.commands['ledger-receipt'].handler('', fixture.mockCtx);

      const dir = path.join(tmp, 'pi-ledger');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
      expect(files).toHaveLength(1);
      const html = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
      // 1h agent @ $100 = $100; markers carry no credit/commit info → 0 human time
      expect(html).toContain('$100.00');
      expect(html).toContain('demo');
      expect(
        fixture.notifySpy.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('pi-tps markers')
        )
      ).toBe(true);
    } finally {
      delete process.env.XDG_CACHE_HOME;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('session_shutdown abandons an uncommitted idle window (exit recorded, bills 0)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // wizard pops (no credit)
    await vi.advanceTimersByTimeAsync(0); // flush dismissed wizard
    fixture.sendEditorKey('k'); // engage the idle window
    await vi.advanceTimersByTimeAsync(30_000); // 30s idle, uncommitted (no submit)
    fixture.run('session_shutdown', { type: 'session_shutdown' }); // exit → close, ABANDONED
    const close = fixture.lastSidecarEvent('human-close');
    expect(close).toBeDefined();
    expect(close!.billedMs).toBe(0); // uncommitted idle bills nothing
    expect(close!.committed).toBe(false);
    // re-entering: the abandoned (0-billed) window is closed, not in-progress; idle
    // was NOT retained (idle with no output is wasted). No initial window opens.
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('human 0.00h (0 windows)');
  });

  it('rehydrates from the sidecar, so compaction (empty JSONL) does not reset totals', async () => {
    // The session JSONL is empty (as if compaction dropped it); the sidecar holds the history.
    fixture.mockEntries.length = 0;
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS, agentRatePerHour: 60 }, timestamp: 0 },
      {
        kind: 'agent',
        id: 'a1',
        turnIndex: 0,
        agentMs: 3_600_000,
        generationMs: 3_600_000,
        stallMs: 0,
        toolMs: 0,
        tokens: { input: 0, output: 0, total: 0 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        timestamp: 1000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('agent 1.00h (1 turns)'); // totals survive from the sidecar
  });

  it('session_tree (/tree go-back) keeps the live totals — does not reset to $0', async () => {
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ generationMs: 3_600_000, stallMs: 0, output: 270000, total: 270000 })
    );
    // branching (/tree → "go back to an earlier message") fires session_tree
    fixture.run('session_tree', { type: 'session_tree' });
    // the live in-memory total is kept — not reset to $0
    expect(fixture.setStatusSpy.mock.calls.at(-1)![1]).toContain('agent 1.00h');
  });

  it('session_tree keeps the open human window idle (the growing-idle case)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // no credit → wizard → extend +20m (engages)
    await vi.advanceTimersByTimeAsync(0); // flush the extend → open window, cap 20m
    await vi.advanceTimersByTimeAsync(30_000); // 30s idle, window open
    fixture.run('session_tree', { type: 'session_tree' }); // /tree → "go back"
    // status keeps the open window's idle — not reset to $0
    expect(fixture.setStatusSpy.mock.calls.at(-1)![1]).toContain('human 0.01h');
  });

  it('session_start keeps live totals if the sidecar read is empty (no reset to $0)', async () => {
    fixture.run('turn_start', { type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ generationMs: 3_600_000, stallMs: 0, output: 270000, total: 270000 })
    );
    fixture.clearSidecar(); // simulate a missing/failed sidecar read
    fixture.run('session_start', { type: 'session_start', reason: 'reload' });
    expect(fixture.setStatusSpy.mock.calls.at(-1)![1]).toContain('agent 1.00h');
  });

  // ── Initial human window (first-prompt composition) ────────────────────

  it('engages an initial human window on first keystroke; with no credit it bills 0 (no wizard at startup)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    // no window opens at session_start — engagement is gated on the first keystroke
    expect(fixture.customSpy).not.toHaveBeenCalled();
    expect(fixture.lastSidecarEvent('human-open')).toBeUndefined();
    fixture.sendEditorKey('k'); // first keystroke ENGAGES the initial window at onset
    const open = fixture.lastSidecarEvent('human-open');
    expect(open).toBeDefined();
    expect(open!.grantedBudgetMs).toBe(0); // no credit provisioned → cap 0
    expect(open!.engagedVia).toBe('keystroke');
    expect(open!.extensionBudgetMs).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000); // 30s composing the first prompt
    fixture.run('agent_start', { type: 'agent_start' }); // submitted → commit

    const close = fixture.lastSidecarEvent('human-close');
    expect(close).toBeDefined();
    expect(close!.billedMs).toBe(0); // no credit → bills 0
    expect(close!.committed).toBe(true);
    expect(close!.extensions).toBe(0);
  });

  it('a long engaged idle with no credit bills 0', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.sendEditorKey('k'); // engage the initial window at onset (no credit → cap 0)
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5m idle after engagement (no credit)
    fixture.run('agent_start', { type: 'agent_start' }); // commit

    const close = fixture.lastSidecarEvent('human-close');
    expect(close!.billedMs).toBe(0); // no credit provisioned → bills 0
    expect(close!.idleMs).toBe(5 * 60_000); // the 5m span is recorded for audit, unbilled
    expect(close!.extensions).toBe(0);
  });

  it('records the idle keystroke count on the human-close event (composition-density analytics)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    // engage via keystroke, then type 4 more distinct keys (no held-key collapse)
    fixture.sendEditorKey('h'); // engage (count 1)
    fixture.sendEditorKey('e');
    fixture.sendEditorKey('l');
    fixture.sendEditorKey('o');
    fixture.sendEditorKey('!');
    await vi.advanceTimersByTimeAsync(10_000);
    fixture.run('agent_start', { type: 'agent_start' }); // commit

    const close = fixture.lastSidecarEvent('human-close');
    expect(close!.keystrokes).toBe(5); // all five idle keystrokes counted
    expect(fixture.lastSidecarEvent('human-open')!.engagedVia).toBe('keystroke');
  });

  it('records 0 idle keystrokes when the window engaged via extension (no typing)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // pop → extend engages (no keystroke)
    await vi.advanceTimersByTimeAsync(0); // flush the extend → openIdleWindow('extension')
    await vi.advanceTimersByTimeAsync(10_000); // idle, no typing
    fixture.run('agent_start', { type: 'agent_start' }); // commit

    const open = fixture.lastSidecarEvent('human-open');
    expect(open!.engagedVia).toBe('extension');
    expect(fixture.lastSidecarEvent('human-close')!.keystrokes).toBe(0); // no typing
  });

  it('collapses a held key in the idle keystroke count (no auto-repeat inflation)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    await vi.advanceTimersByTimeAsync(0); // flush dismissed wizard
    // hold one key for ~1s: auto-repeat fires the same data every 10ms
    for (let i = 0; i < 100; i++) {
      fixture.sendEditorKey('a');
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1000);
    fixture.run('agent_start', { type: 'agent_start' }); // commit

    // 100 auto-repeats collapse to one keystroke — the count stays meaningful
    expect(fixture.lastSidecarEvent('human-close')!.keystrokes).toBe(1);
  });

  it('does not open a second initial window when rehydrate restores an open one (crashed prior process)', async () => {
    const openedAt = 5_000_000;
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt,
        grantedBudgetMs: 60_000,
        extensions: 0,
        extensionBudgetMs: 0,
        timestamp: openedAt,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    // rehydrate does NOT restore the stale unclosed window (idle with no committed
    // agent action is wasted) — it abandons it (a human-close committed:false, 0)
    // and opens no second window.
    const opens = fixture.readSidecarEvents().filter((e) => e.kind === 'human-open');
    expect(opens).toHaveLength(1); // only the seeded one; no new human-open appended
    const abandon = fixture.lastSidecarEvent('human-close');
    expect(abandon).toBeDefined();
    expect(abandon!.billedMs).toBe(0); // uncommitted → unbilled
    expect(abandon!.committed).toBe(false);
  });

  it('carries rehydrated rolling credit into the initial window (cap = credit), wizard silent', async () => {
    // A prior idle window left 18m of rolling pomodoro credit on the sidecar.
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 0,
        grantedBudgetMs: 20 * 60_000,
        extensions: 1,
        extensionBudgetMs: 20 * 60_000,
        timestamp: 1000,
      },
      {
        kind: 'human-close',
        openedAt: 0,
        closedAt: 2 * 60_000,
        billedMs: 2 * 60_000,
        idleMs: 2 * 60_000,
        grantedBudgetMs: 20 * 60_000,
        extensions: 1,
        extensionBudgetMs: 18 * 60_000,
        timestamp: 2000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' }); // rehydrate 18m credit; no pop
    // engaging inherits the 18m rolling credit: cap = 18m
    fixture.sendEditorKey('k');
    const open = fixture.lastSidecarEvent('human-open');
    expect(open!.grantedBudgetMs).toBe(18 * 60_000);
    expect(open!.extensionBudgetMs).toBe(18 * 60_000);
    // silent — the wizard never auto-pops at startup
    expect(fixture.customSpy).not.toHaveBeenCalled();
  });

  it('/ledger-extend extends the initial window before the first prompt is submitted', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    expect(fixture.customSpy).not.toHaveBeenCalled(); // initial window is silent
    fixture.setCustomResult('extend');
    await fixture.commands['ledger-extend'].handler('5', fixture.mockCtx); // manually provision +5m
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000); // 4m composing (under the 5m cap)
    fixture.run('agent_start', { type: 'agent_start' });

    const close = fixture.lastSidecarEvent('human-close');
    expect(close!.grantedBudgetMs).toBe(5 * 60_000);
    expect(close!.extensions).toBe(1);
    expect(close!.billedMs).toBe(4 * 60_000); // 4m, under the 5m cap
  });

  it('the silent initial window does not suppress the wizard at the following agent_end', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    expect(fixture.customSpy).not.toHaveBeenCalled(); // initial window silent
    fixture.run('agent_start', { type: 'agent_start' }); // first prompt → close initial (~0 billed)
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // post-turn window → wizard pops
    // the wizard pops at agent_end (where it belongs), not at session_start
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── Steering composition (human types while the agent runs) ────────────────

function lastSteer(fixture: TestFixture): SteerEvent | undefined {
  return fixture.lastSidecarEvent('steer') as SteerEvent | undefined;
}

function steerInput(behavior: 'steer' | 'followUp', source = 'interactive', text = 'h') {
  return { type: 'input' as const, text, source, streamingBehavior: behavior };
}

/** Type a sustained burst: keys at `gapMs` intervals spanning ~`durationMs`, so
 *  they cluster into one typing burst (gaps under STEER_GAP_MS). A single key,
 *  or keys spread minutes apart, bill nothing — only a burst like this bills. */
async function typeBurst(fixture: TestFixture, durationMs: number, gapMs = 1000) {
  const steps = Math.round(durationMs / gapMs);
  for (let i = 0; i <= steps; i++) {
    fixture.sendEditorKey('k');
    if (i < steps) await vi.advanceTimersByTimeAsync(gapMs);
  }
}

/** Seed `ms` of rolling extension credit from a prior (0-billed) idle window,
 *  so a fresh session rehydrates with billable credit already provisioned.
 *  Steering/idle bill against credit, so billing tests provision credit first. */
function seedCredit(fixture: TestFixture, ms: number) {
  fixture.seedSidecar([
    { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
    {
      kind: 'human-open',
      openedAt: 0,
      grantedBudgetMs: ms,
      extensions: 1,
      extensionBudgetMs: ms,
      timestamp: 1000,
    },
    {
      kind: 'human-close',
      openedAt: 0,
      closedAt: 1000,
      billedMs: 0,
      idleMs: 0,
      committed: true,
      grantedBudgetMs: ms,
      extensions: 1,
      extensionBudgetMs: ms,
      timestamp: 2000,
    },
  ]);
}

describe('computeBurstMs', () => {
  it('returns 0 for no keystrokes', () => {
    expect(computeBurstMs([], 3000)).toBe(0);
  });
  it('a single keystroke is a zero-length burst (bills nothing)', () => {
    expect(computeBurstMs([1000], 3000)).toBe(0);
  });
  it('sums one continuous burst as last − first', () => {
    expect(computeBurstMs([1000, 2000, 3000, 4000], 3000)).toBe(3000);
  });
  it('splits at gaps over the threshold and sums each burst', () => {
    // [1000..3000] = 2000, 5000 gap, [8000..9000] = 1000 → 3000
    expect(computeBurstMs([1000, 2000, 3000, 8000, 9000], 3000)).toBe(3000);
  });
  it('isolated keystrokes (gaps over the threshold) bill nothing', () => {
    expect(computeBurstMs([0, 60_000, 120_000, 180_000], 3000)).toBe(0);
  });
  it('clamps a descending/non-positive sum to 0', () => {
    expect(computeBurstMs([5000, 1000], 3000)).toBe(0);
  });
});

describe('steering composition (human types while the agent runs)', () => {
  let fixture: TestFixture;
  let cacheDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-test-'));
    process.env.XDG_CACHE_HOME = cacheDir;
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.XDG_CACHE_HOME;
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('installs an editor wrapper at session_start (TUI) to observe keystrokes', () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    expect(fixture.setEditorComponentSpy).toHaveBeenCalledTimes(1);
  });

  it('does not install the editor in non-TUI modes (no composition to capture)', () => {
    (fixture.mockCtx as unknown as { mode: string }).mode = 'print';
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    expect(fixture.setEditorComponentSpy).not.toHaveBeenCalled();
  });

  it('bills nothing for a steer with no credit provisioned', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' }); // run begins; closes the initial window
    await typeBurst(fixture, 30_000); // 30s of sustained typing mid-stream
    fixture.run('input', steerInput('steer'));

    const steer = lastSteer(fixture);
    expect(steer).toBeDefined();
    expect(steer!.billedMs).toBe(0); // no credit → bills 0
    expect(steer!.durationMs).toBe(30_000); // wall-clock span == burst (no idle gap)
    expect(steer!.keystrokes).toBe(31); // 30s at 1s intervals = 31 keys
    expect(steer!.behavior).toBe('steer');
    expect(steer!.grantedBudgetMs).toBe(0); // no credit
    expect(steer!.extensionBudgetMs).toBe(0);
  });

  it('consumes rolling credit for a steer (all billed time consumes credit)', async () => {
    // Rehydrate 18m of rolling pomodoro credit from a prior idle window.
    seedCredit(fixture, 18 * 60_000);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    fixture.run('agent_start', { type: 'agent_start' }); // close the initial window; start the run
    await typeBurst(fixture, 3 * 60_000); // 3m of sustained typing
    fixture.run('input', steerInput('steer'));

    const steer = lastSteer(fixture);
    expect(steer!.billedMs).toBe(3 * 60_000); // under the 18m cap
    expect(steer!.grantedBudgetMs).toBe(18 * 60_000);
    expect(steer!.extensionBudgetMs).toBe(15 * 60_000); // 18m − 3m consumed
  });

  it('bills a queued followUp the same as a mid-stream steer (both against credit)', async () => {
    seedCredit(fixture, 20 * 60_000);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 45_000); // 45s of sustained typing
    fixture.run('input', steerInput('followUp'));

    const steer = lastSteer(fixture);
    expect(steer!.behavior).toBe('followUp');
    expect(steer!.billedMs).toBe(45_000);
  });

  it('ignores steers from non-interactive sources (extension/rpc injected)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 30_000);
    fixture.run('input', steerInput('steer', 'extension'));
    expect(fixture.lastSidecarEvent('steer')).toBeUndefined();
  });

  it('does not record a steer for a normal idle prompt (submitted between turns)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // opens the idle window
    await vi.advanceTimersByTimeAsync(30_000);
    fixture.run('input', { type: 'input', text: 'next', source: 'interactive' }); // no streamingBehavior
    expect(fixture.lastSidecarEvent('steer')).toBeUndefined();
  });

  it('does not record a steer when no keystrokes preceded the submit (no onset)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    // no sendEditorKey — steerComposeStart stays null
    await vi.advanceTimersByTimeAsync(30_000);
    fixture.run('input', steerInput('steer'));
    expect(fixture.lastSidecarEvent('steer')).toBeUndefined();
  });

  it('records multiple steers in one run, each from its own typing burst', async () => {
    seedCredit(fixture, 20 * 60_000);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 10_000);
    fixture.run('input', steerInput('steer', 'interactive', 'a'));
    await typeBurst(fixture, 20_000); // a new burst after the first steer cleared staging
    fixture.run('input', steerInput('steer', 'interactive', 'b'));

    const steers = fixture.readSidecarEvents().filter((e) => e.kind === 'steer') as SteerEvent[];
    expect(steers).toHaveLength(2);
    expect(steers[0]!.billedMs).toBe(10_000);
    expect(steers[1]!.billedMs).toBe(20_000);

    // steering bills as human time, distinct from idle (no idle window here).
    const r = rehydrateFromSidecar(fixture.readSidecarEvents());
    expect(r.totals.humanSteerMs).toBe(30_000); // 10s + 20s
    expect(r.totals.steerCount).toBe(2);
    expect(r.totals.humanWindows).toBe(2);
    expect(r.totals.humanIdleMs).toBe(0);
    expect(r.totals.idleWindows).toBe(0);
  });

  it('restores itemized sub-totals on rehydrate (reload) so the receipt itemizes prior work', async () => {
    // A prior session's sidecar: one agent turn (generation + tool), one
    // committed idle window, and one steer — the kind of state a reload sees.
    const t0 = 1_700_000_000_000;
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: t0 },
      {
        kind: 'agent',
        id: 'a1',
        turnIndex: 0,
        agentMs: 3_600_000,
        generationMs: 3_000_000,
        stallMs: 0,
        toolMs: 600_000,
        tokens: { input: 100, output: 50, total: 150 },
        model: { provider: 'openai', modelId: 'gpt-4' },
        source: 'tps',
        timestamp: t0 + 1000,
      },
      {
        kind: 'human-open',
        openedAt: t0 + 2000,
        grantedBudgetMs: 60_000,
        extensions: 0,
        engagedVia: 'keystroke',
        extensionBudgetMs: 0,
        timestamp: t0 + 2000,
      },
      {
        kind: 'human-close',
        openedAt: t0 + 2000,
        closedAt: t0 + 62_000,
        billedMs: 60_000,
        idleMs: 60_000,
        keystrokes: 10,
        committed: true,
        grantedBudgetMs: 60_000,
        extensions: 0,
        extensionBudgetMs: 0,
        timestamp: t0 + 62_000,
      },
      {
        kind: 'steer',
        startedAt: t0 + 70_000,
        submittedAt: t0 + 90_000,
        durationMs: 20_000,
        billedMs: 20_000,
        keystrokes: 30,
        behavior: 'steer',
        grantedBudgetMs: 60_000,
        extensionBudgetMs: 0,
        timestamp: t0 + 90_000,
      },
    ]);
    // Reload → session_start rehydrates the in-memory totals from the sidecar.
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });

    // The receipt itemizes from the sub-totals; they must be restored (not 0).
    await fixture.commands['ledger-receipt']!.handler('', fixture.mockCtx);
    const file = fs
      .readdirSync(path.join(cacheDir, 'pi-ledger'))
      .filter((f) => f.startsWith('receipt-019fabcd-'))
      .sort()
      .pop();
    expect(file).toBeDefined();
    const html = fs.readFileSync(path.join(cacheDir, 'pi-ledger', file!), 'utf8');
    // agent sub-items restored: generation 3m @ $60 = $50, tool 0.167h = $10
    expect(html).toContain('$50.00'); // Compute (generation)
    expect(html).toContain('$10.00'); // Tool execution
    // human sub-items restored: idle 1m @ $60 = $1, steer 20s = $0.33
    expect(html).toContain('$1.00'); // Review / think
    expect(html).toContain('$0.33'); // Steering
    // total reconciles from the restored sub-totals (not just the in-progress window)
    expect(html).toContain('$61.33');
  });

  it('discards an unsubmitted in-run composition (no backdate — it never reached the agent)', async () => {
    seedCredit(fixture, 20 * 60_000);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 20_000); // 20s of typing mid-run, NOT submitted
    // the agent finishes before the human submits — no `input` fires mid-stream
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // discard staging; credit remains → no wizard pop

    // No steer (never submitted) and no NEW idle window (no engagement yet) — the
    // mid-run typing never reached the agent, so it bills nothing and opens nothing.
    expect(fixture.lastSidecarEvent('steer')).toBeUndefined();
    const opensAfterDiscard = fixture.readSidecarEvents().filter((e) => e.kind === 'human-open');
    expect(opensAfterDiscard).toHaveLength(1); // only the seeded (closed) window; the discard opened none
    expect(opensAfterDiscard[0]!.openedAt).toBe(0); // the seeded one, not a fresh engagement

    // The human engages AFTER the run (a fresh keystroke) and commits — only the
    // post-run idle bills; the discarded mid-run typing isn't folded in.
    fixture.sendEditorKey('k'); // engage the idle window at onset (now, post-run), cap 20m
    await vi.advanceTimersByTimeAsync(10_000); // 10s of post-run idle
    fixture.run('agent_start', { type: 'agent_start' }); // commit → bills 10s

    const close = fixture.lastSidecarEvent('human-close');
    expect(close).toBeDefined();
    expect(close!.billedMs).toBe(10_000); // only the 10s post-run idle — the 20s mid-run typing is unbilled
  });

  it('bills a submitted steer from its burst; the post-turn idle bills only post-run idle', async () => {
    seedCredit(fixture, 20 * 60_000);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 15_000); // 15s typing burst mid-run
    fixture.run('input', steerInput('steer')); // committed mid-run
    const steer = lastSteer(fixture);
    expect(steer!.billedMs).toBe(15_000); // the typing burst
    await vi.advanceTimersByTimeAsync(25_000); // agent keeps working (no typing)
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // credit remains → no wizard pop; no idle window opens (engagement-gated)

    // No NEW idle window yet — the human hasn't engaged post-run (only the seeded, closed one exists).
    const opensBeforeEngage = fixture.readSidecarEvents().filter((e) => e.kind === 'human-open');
    expect(opensBeforeEngage).toHaveLength(1); // the seeded (closed) window; no post-run engagement yet

    fixture.sendEditorKey('k'); // engage the post-run idle window at onset (cap = remaining credit)
    await vi.advanceTimersByTimeAsync(10_000); // 10s post-run idle
    fixture.run('agent_start', { type: 'agent_start' }); // commit → bills 10s
    const close = fixture.lastSidecarEvent('human-close');
    expect(close!.idleMs).toBe(10_000); // only post-run idle — no overlap with the steer's burst
    expect(close!.billedMs).toBe(10_000);
  });

  it('shows in-progress steer typing in /ledger while the run is active', async () => {
    seedCredit(fixture, 20 * 60_000);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 30_000); // 30s of sustained typing (not yet submitted)
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('human 0.01h (1 windows)'); // 30s active typing as 1 in-progress window
    expect(fixture.lastSidecarEvent('steer')).toBeUndefined(); // not submitted yet
  });

  it('bills only active typing, not the idle wait before submit (billedMs < durationMs)', async () => {
    seedCredit(fixture, 20 * 60_000);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 30_000); // 30s of typing
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5m idle, no typing, before submitting
    fixture.run('input', steerInput('steer'));

    const steer = lastSteer(fixture);
    expect(steer!.billedMs).toBe(30_000); // only the typing burst
    expect(steer!.durationMs).toBe(30_000 + 5 * 60_000); // wall-clock span includes the 5m idle
    expect(steer!.billedMs).toBeLessThan(steer!.durationMs);
  });

  it('bills nothing for isolated keystrokes (a key every minute — the abuse guard)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    // press a key every 60s (gaps far over the 3s burst threshold) for 4 minutes
    for (let i = 0; i < 4; i++) {
      fixture.sendEditorKey('k');
      if (i < 3) await vi.advanceTimersByTimeAsync(60_000);
    }
    fixture.run('input', steerInput('steer'));

    const steer = lastSteer(fixture);
    expect(steer).toBeDefined(); // the steer was submitted (audit)…
    expect(steer!.billedMs).toBe(0); // …but isolated keys form zero-length bursts → bills nothing
    expect(steer!.keystrokes).toBe(4);
  });

  it('collapses a held key (auto-repeat) so it cannot fabricate a sustained burst', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    // hold one key for ~1s: auto-repeat fires the SAME data every 10ms (well under
    // AUTO_REPEAT_MS). Each repeat collapses to one timestamp → a zero-length burst.
    for (let i = 0; i < 100; i++) {
      fixture.sendEditorKey('a');
      await vi.advanceTimersByTimeAsync(10);
    }
    fixture.run('input', steerInput('steer'));

    const steer = lastSteer(fixture);
    expect(steer).toBeDefined();
    expect(steer!.billedMs).toBe(0); // a held key bills nothing — no fabricated burst
    expect(steer!.keystrokes).toBe(1); // 100 auto-repeats collapsed to one staged keystroke
  });

  it('rehydrates steer events into human time and rolling credit', async () => {
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'steer',
        startedAt: 1000,
        submittedAt: 31_000,
        durationMs: 30_000,
        billedMs: 30_000,
        keystrokes: 31,
        behavior: 'steer',
        grantedBudgetMs: 60_000,
        extensionBudgetMs: 0,
        timestamp: 31_000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await vi.advanceTimersByTimeAsync(0); // flush the resume wizard pop (no engagement)
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('human 0.01h'); // 30s steer rehydrated as human time
    expect(msg).toContain('(1 windows)'); // just the rehydrated steer — no initial window (engagement-gated)
  });
});
