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
  graceMinutes: 1,
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
  const grace = 60_000;
  it('consumes nothing while billed stays within the per-window grace', () => {
    expect(consumeExtensionBudget(30_000, grace, 20 * 60_000)).toBe(0);
    expect(consumeExtensionBudget(60_000, grace, 20 * 60_000)).toBe(0); // exactly grace → free
  });
  it('consumes the billed time beyond grace, up to the provisioned budget', () => {
    // billed 5m, grace 1m → 4m beyond grace, 20m provisioned → consume 4m
    expect(consumeExtensionBudget(5 * 60_000, grace, 20 * 60_000)).toBe(4 * 60_000);
  });
  it('caps consumption at the remaining provisioned budget', () => {
    // billed 10m, grace 1m → 9m beyond grace, but only 2m provisioned → consume 2m
    expect(consumeExtensionBudget(10 * 60_000, grace, 2 * 60_000)).toBe(2 * 60_000);
  });
  it('clamps zero/empty budgets', () => {
    expect(consumeExtensionBudget(5 * 60_000, grace, 0)).toBe(0);
    expect(consumeExtensionBudget(0, grace, 20 * 60_000)).toBe(0);
  });
});

describe('resolveExtensionBudget', () => {
  const grace = 60_000;
  it('reads the recorded field when present (open + close)', () => {
    const open = {
      kind: 'human-open',
      openedAt: 0,
      grantedBudgetMs: 21 * 60_000,
      extensions: 1,
      extensionBudgetMs: 20 * 60_000,
      timestamp: 0,
    } as SidecarEvent;
    expect(resolveExtensionBudget(open, grace)).toBe(20 * 60_000);
    const close = {
      kind: 'human-close',
      openedAt: 0,
      closedAt: 1000,
      billedMs: 1000,
      idleMs: 1000,
      grantedBudgetMs: 21 * 60_000,
      extensions: 1,
      extensionBudgetMs: 19 * 60_000,
      timestamp: 1,
    } as SidecarEvent;
    expect(resolveExtensionBudget(close, grace)).toBe(19 * 60_000);
  });
  it('backfills an open legacy event as cap − grace (the extension portion)', () => {
    const open = {
      kind: 'human-open',
      openedAt: 0,
      grantedBudgetMs: 21 * 60_000,
      extensions: 1,
      timestamp: 0,
    } as SidecarEvent;
    expect(resolveExtensionBudget(open, grace)).toBe(20 * 60_000);
  });
  it('backfills a close legacy event as cap − max(billed, grace)', () => {
    // billed 5m, grace 1m, cap 21m → remaining = 21m − 5m = 16m
    const close = {
      kind: 'human-close',
      openedAt: 0,
      closedAt: 5 * 60_000,
      billedMs: 5 * 60_000,
      idleMs: 5 * 60_000,
      grantedBudgetMs: 21 * 60_000,
      extensions: 1,
      timestamp: 1,
    } as SidecarEvent;
    expect(resolveExtensionBudget(close, grace)).toBe(16 * 60_000);
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
  it('clamps grace/pomodoro to sane integers', () => {
    expect(applySettingValue(DEFAULTS, 'graceMinutes', '0').graceMinutes).toBe(0);
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
    expect(r.humanWindow).toEqual({ openedAt: 5000, grantedBudgetMs: 60_000, extensions: 0 });
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
    // open with cap 21m (grace 1m + 20m ext), no extensionBudgetMs field
    const events: SidecarEvent[] = [
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 1000,
        grantedBudgetMs: 21 * 60_000,
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

  it('converts markers to agent + estimated human time (gaps capped at grace)', () => {
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
      60_000,
      75
    );
    // agent = (50 + 100 + 25) output tokens ÷ 75 TPS = 667 + 1333 + 333 = 2333
    expect(c.agentMs).toBe(2333);
    expect(c.agentTurns).toBe(3);
    expect(c.agentTokens.total).toBe(525);
    // gap0 = (70000-4000) - 0 = 66000 -> capped at 60000; gap1 = (90000-1500) - 70000 = 18500
    expect(c.humanMs).toBe(60000 + 18500);
    expect(c.humanWindows).toBe(2);
    expect(c.startedAt).toBe(0);
  });

  it('returns zeros for no markers', () => {
    const c = convertTpsEntries([], 60_000, 75);
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

  it('pops the wizard immediately at agent_end and bills actual idle under grace when ignored', async () => {
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // wizard pops immediately (no selection → ignored)
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000); // 5s idle, under 1m grace
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg).toBeDefined();
    expect(seg.billedMs).toBe(5000);
    expect(seg.grantedBudgetMs).toBe(60_000);
    expect(seg.extensions).toBe(0);
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
    await vi.advanceTimersByTimeAsync(60_000); // a full grace minute of backoff
    fixture.run('agent_start', { type: 'agent_start' });
    expect(fixture.lastSidecarEvent('human-close')).toBeUndefined();
  });

  it('does not bill the retry backoff between an errored turn and the retry agent_start', async () => {
    // turn 1 errors → retry in flight (no human window opened)
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error' }],
    });
    await vi.advanceTimersByTimeAsync(60_000); // 60s backoff — would bill a grace minute if a window were open
    fixture.run('agent_start', { type: 'agent_start' }); // retry runs; nothing to close
    // retry succeeds → a real human window opens now for genuine post-turn idle
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    });
    const opens = fixture.readSidecarEvents().filter((e) => e.kind === 'human-open');
    expect(opens).toHaveLength(1); // only the post-success window, not during the retry
    expect(fixture.lastSidecarEvent('human-close')).toBeUndefined(); // still open
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

  it('opens the human window for a normal (stop) agent_end — regression guard', async () => {
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'stop' }],
    });
    expect(fixture.customSpy).toHaveBeenCalledTimes(1); // wizard pops
    expect(fixture.lastSidecarEvent('human-open')).toBeDefined();
  });

  it('still opens the human window for an aborted agent_end (a retry is not in flight)', async () => {
    fixture.run('agent_end', {
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'aborted' }],
    });
    expect(fixture.lastSidecarEvent('human-open')).toBeDefined();
  });

  it('opens the human window when agent_end has no assistant message (unchanged)', async () => {
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.lastSidecarEvent('human-open')).toBeDefined();
  });

  it('caps human time at the grace minute when the wizard is dismissed', async () => {
    fixture.setCustomResult('stop');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // wizard pops immediately, dismissed ('stop')
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000); // 90s idle, no re-arm after dismiss
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg.billedMs).toBe(60_000); // capped at grace
    expect(seg.extensions).toBe(0);
  });

  it('extends the budget when the wizard is accepted', async () => {
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // wizard pops immediately, accepted → +20m, re-armed at 21m
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(360_000); // 6m idle, under 21m budget → re-armed wizard not fired
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg.grantedBudgetMs).toBe(60_000 + 20 * 60_000);
    expect(seg.extensions).toBe(1);
    expect(seg.billedMs).toBe(360_000); // 6 min
  });

  it('suppresses the wizard at the next agent_end while rolling extension credit remains', async () => {
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // pops → +20m
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000); // 2m idle (under 21m cap); flushes the extend
    fixture.run('agent_start', { type: 'agent_start' }); // close: 2m billed, 1m ext consumed → 19m left

    const seg1 = lastEntry(fixture, 'ledger-human');
    expect(seg1.billedMs).toBe(120_000);
    expect(seg1.extensionBudgetMs).toBe(19 * 60_000);

    // next agent_end: 19m credit remains → wizard is NOT shown (armed for exhaustion instead)
    fixture.customSpy.mockClear();
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled();
    // the new window's cap = per-window grace (1m) + 19m rolling credit = 20m
    const open = fixture.lastSidecarEvent('human-open');
    expect(open!.grantedBudgetMs).toBe(20 * 60_000);
    expect(open!.extensionBudgetMs).toBe(19 * 60_000);
  });

  it('rolls unused extension credit across multiple agent turns', async () => {
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // +20m
    await vi.advanceTimersByTimeAsync(120_000); // 2m idle
    fixture.run('agent_start', { type: 'agent_start' }); // close → 1m ext consumed → 19m left

    // turn 2: credit remains → no pop
    fixture.customSpy.mockClear();
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000); // 2m idle
    fixture.run('agent_start', { type: 'agent_start' }); // close → 1m ext consumed → 18m left
    expect(lastEntry(fixture, 'ledger-human').extensionBudgetMs).toBe(18 * 60_000);

    // turn 3: still 18m credit → still suppressed
    fixture.customSpy.mockClear();
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled();
  });

  it('pops the wizard at agent_end when no rolling credit remains', async () => {
    fixture.seedSidecar([{ kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 }]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).toHaveBeenCalledTimes(1); // no credit → pop immediately
  });

  it('suppresses the wizard at agent_end when rolling credit is rehydrated', async () => {
    // A prior idle window left 19m of rolling pomodoro credit on the sidecar.
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 0,
        grantedBudgetMs: 21 * 60_000,
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
        grantedBudgetMs: 21 * 60_000,
        extensions: 1,
        extensionBudgetMs: 19 * 60_000,
        timestamp: 2000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' }); // rehydrate 19m credit
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    expect(fixture.customSpy).not.toHaveBeenCalled(); // 19m credit → suppressed
    const open = fixture.lastSidecarEvent('human-open');
    expect(open!.grantedBudgetMs).toBe(20 * 60_000); // grace 1m + 19m credit
    expect(open!.extensionBudgetMs).toBe(19 * 60_000);
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

    await vi.advanceTimersByTimeAsync(100_000); // 100s idle, under 6m budget
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg.grantedBudgetMs).toBe(60_000 + 5 * 60_000);
    expect(seg.extensions).toBe(1);
    expect(seg.billedMs).toBe(100_000);
  });

  it('/ledger-extend warns when no window is open', async () => {
    await fixture.commands['ledger-extend'].handler('5', fixture.mockCtx);
    expect(fixture.notifySpy).toHaveBeenCalledWith(
      expect.stringContaining('No active human-time window'),
      'warning'
    );
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
    // 1 closed human window (rehydrated) + 1 open initial window (opened at
    // session_start) = 2 windows; the initial window's idle is ~0 here.
    expect(msg).toContain('human 0.50h (2 windows)');
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
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // opens a human window (wizard pops, ignored)
    await vi.advanceTimersByTimeAsync(30_000); // 30s idle, window still open
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    // the open window's 30s idle is counted now (capped at the 1m grace), not deferred to close
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
      // 1h agent @ $100 = $100; trailing idle (→ now) adds up to a grace minute of human time
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

  it('session_shutdown closes the open window and persists its idle (exit recorded)', async () => {
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // opens a window (wizard pops, ignored)
    await vi.advanceTimersByTimeAsync(30_000); // 30s idle
    fixture.run('session_shutdown', { type: 'session_shutdown' }); // exit → close + record
    const close = fixture.lastSidecarEvent('human-close') as { billedMs: number } | undefined;
    expect(close).toBeDefined();
    expect(close!.billedMs).toBe(30_000); // 30s retained, capped at the 1m grace
    // re-entering (rehydrate) retains the closed window's idle — not lost on exit.
    // The closed 30s window + the open initial window (opened at session_start)
    // = 2 windows; the idle (30s) is retained.
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('human 0.01h (2 windows)');
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
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // opens a window; idle grows
    await vi.advanceTimersByTimeAsync(30_000); // 30s idle
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

  it('opens an initial human window at session_start and bills first-prompt composition (silent — no wizard)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    // the initial window opens silently — the wizard never auto-pops here
    expect(fixture.customSpy).not.toHaveBeenCalled();
    const open = fixture.lastSidecarEvent('human-open');
    expect(open).toBeDefined();
    expect(open!.grantedBudgetMs).toBe(60_000); // grace 1m; no credit provisioned yet
    expect(open!.extensionBudgetMs).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000); // 30s composing the first prompt
    fixture.run('agent_start', { type: 'agent_start' }); // submitted → close

    const close = fixture.lastSidecarEvent('human-close');
    expect(close).toBeDefined();
    expect(close!.billedMs).toBe(30_000); // under the 1m grace → billed in full
    expect(close!.extensions).toBe(0);
  });

  it('caps the initial window at the grace minute — a long composition bills only grace (abuse guard)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5m "thinking" before the first prompt
    fixture.run('agent_start', { type: 'agent_start' });

    const close = fixture.lastSidecarEvent('human-close');
    expect(close!.billedMs).toBe(60_000); // capped at the 1m grace; the rest is unbilled
    expect(close!.idleMs).toBe(5 * 60_000);
    expect(close!.extensions).toBe(0);
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
    // rehydrate restored the unclosed window — don't open a second initial window
    const opens = fixture.readSidecarEvents().filter((e) => e.kind === 'human-open');
    expect(opens).toHaveLength(1); // only the seeded one; no new human-open appended
  });

  it('carries rehydrated rolling credit into the initial window (cap = grace + credit), wizard silent', async () => {
    // A prior idle window left 19m of rolling pomodoro credit on the sidecar.
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 0,
        grantedBudgetMs: 21 * 60_000,
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
        grantedBudgetMs: 21 * 60_000,
        extensions: 1,
        extensionBudgetMs: 19 * 60_000,
        timestamp: 2000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    // the initial window inherits the 19m rolling credit: cap = grace 1m + 19m
    const open = fixture.lastSidecarEvent('human-open');
    expect(open!.grantedBudgetMs).toBe(20 * 60_000);
    expect(open!.extensionBudgetMs).toBe(19 * 60_000);
    // silent — the wizard never auto-pops for the initial window
    expect(fixture.customSpy).not.toHaveBeenCalled();
  });

  it('/ledger-extend extends the initial window before the first prompt is submitted', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    expect(fixture.customSpy).not.toHaveBeenCalled(); // initial window is silent
    fixture.setCustomResult('extend');
    await fixture.commands['ledger-extend'].handler('5', fixture.mockCtx); // manually provision +5m
    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000); // 4m composing (under grace 1m + 5m = 6m)
    fixture.run('agent_start', { type: 'agent_start' });

    const close = fixture.lastSidecarEvent('human-close');
    expect(close!.grantedBudgetMs).toBe(60_000 + 5 * 60_000);
    expect(close!.extensions).toBe(1);
    expect(close!.billedMs).toBe(4 * 60_000); // 4m, under the 6m cap
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

  it('bills a steer composed during the run under the grace minute', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' }); // run begins; closes the initial window
    await typeBurst(fixture, 30_000); // 30s of sustained typing mid-stream
    fixture.run('input', steerInput('steer'));

    const steer = lastSteer(fixture);
    expect(steer).toBeDefined();
    expect(steer!.billedMs).toBe(30_000); // active-typing burst, under 1m grace → billed in full
    expect(steer!.durationMs).toBe(30_000); // wall-clock span == burst (no idle gap)
    expect(steer!.keystrokes).toBe(31); // 30s at 1s intervals = 31 keys
    expect(steer!.behavior).toBe('steer');
    expect(steer!.grantedBudgetMs).toBe(60_000); // grace 1m, no credit
    expect(steer!.extensionBudgetMs).toBe(0);
  });

  it('consumes rolling credit for a steer composed beyond the grace minute', async () => {
    // Rehydrate 19m of rolling pomodoro credit from a prior idle window.
    fixture.seedSidecar([
      { kind: 'settings', settings: { ...DEFAULTS }, timestamp: 0 },
      {
        kind: 'human-open',
        openedAt: 0,
        grantedBudgetMs: 21 * 60_000,
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
        grantedBudgetMs: 21 * 60_000,
        extensions: 1,
        extensionBudgetMs: 19 * 60_000,
        timestamp: 2000,
      },
    ]);
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    fixture.run('agent_start', { type: 'agent_start' }); // close the initial window; start the run
    await typeBurst(fixture, 3 * 60_000); // 3m of sustained typing
    fixture.run('input', steerInput('steer'));

    const steer = lastSteer(fixture);
    expect(steer!.billedMs).toBe(3 * 60_000); // under the 20m cap (grace 1m + 19m credit)
    expect(steer!.grantedBudgetMs).toBe(20 * 60_000);
    expect(steer!.extensionBudgetMs).toBe(17 * 60_000); // 19m − 2m consumed beyond grace
  });

  it('bills a queued followUp the same as a mid-stream steer', async () => {
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
  });

  it('discards an unsubmitted in-run composition (no backdate — it never reached the agent)', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    const firstKey = Date.now();
    await typeBurst(fixture, 20_000); // 20s of typing mid-run, NOT submitted
    const agentEnd = Date.now(); // == the moment agent_end opens the idle window
    // the agent finishes before the human submits — no `input` fires mid-stream
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // idle window opens FRESH
    await vi.advanceTimersByTimeAsync(0); // flush the wizard's resolved promise

    const open = fixture.lastSidecarEvent('human-open') as { openedAt: number } | undefined;
    expect(open).toBeDefined();
    expect(open!.openedAt).toBe(agentEnd); // fresh at agent_end, NOT backdated to the first key
    expect(open!.openedAt).not.toBe(firstKey);
    expect(fixture.lastSidecarEvent('steer')).toBeUndefined(); // unsubmitted typing is discarded

    await vi.advanceTimersByTimeAsync(10_000); // 10s of post-run idle
    fixture.run('input', { type: 'input', text: 'h', source: 'interactive' }); // idle prompt
    fixture.run('agent_start', { type: 'agent_start' }); // closes the idle window

    const close = fixture.lastSidecarEvent('human-close') as
      | {
          billedMs: number;
          idleMs: number;
          openedAt: number;
        }
      | undefined;
    expect(close).toBeDefined();
    expect(close!.openedAt).toBe(agentEnd); // the idle window, not the discarded typing
    expect(close!.idleMs).toBe(10_000); // only the 10s post-run idle — the 20s mid-run typing is unbilled
    expect(close!.billedMs).toBe(10_000);
  });

  it('bills a submitted steer from its burst; the post-turn idle window bills only post-run idle', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 15_000); // 15s typing burst mid-run
    fixture.run('input', steerInput('steer')); // submitted mid-run → recorded
    const steer = lastSteer(fixture);
    expect(steer!.billedMs).toBe(15_000); // the typing burst
    const afterAgentEnd = Date.now() + 25_000; // agent_end will fire 25s later
    await vi.advanceTimersByTimeAsync(25_000); // agent keeps working (no typing)
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // idle window opens fresh
    await vi.advanceTimersByTimeAsync(0);

    const open = fixture.lastSidecarEvent('human-open') as { openedAt: number } | undefined;
    expect(open).toBeDefined();
    expect(open!.openedAt).toBe(afterAgentEnd); // fresh at agent_end, NOT the steer's first keystroke

    await vi.advanceTimersByTimeAsync(10_000); // 10s post-run idle
    fixture.run('agent_start', { type: 'agent_start' }); // closes the idle window
    const close = fixture.lastSidecarEvent('human-close') as
      | { billedMs: number; idleMs: number }
      | undefined;
    expect(close!.idleMs).toBe(10_000); // only post-run idle — no overlap with the steer's burst
    expect(close!.billedMs).toBe(10_000);
  });

  it('shows in-progress steer typing in /ledger while the run is active', async () => {
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
    fixture.run('agent_start', { type: 'agent_start' });
    await typeBurst(fixture, 30_000); // 30s of sustained typing (not yet submitted)
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('human 0.01h (1 windows)'); // 30s active typing as 1 in-progress window
    expect(fixture.lastSidecarEvent('steer')).toBeUndefined(); // not submitted yet
  });

  it('bills only active typing, not the idle wait before submit (billedMs < durationMs)', async () => {
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
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('human 0.01h'); // 30s steer rehydrated as human time
    expect(msg).toContain('(2 windows)'); // 1 rehydrated steer + 1 open initial window
  });
});
