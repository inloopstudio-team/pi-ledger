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
  computeBilling,
  consumeExtensionBudget,
  convertTpsEntries,
  extractTpsEntries,
  fmtHours,
  fmtMoney,
  rehydrateFromSidecar,
  resolveExtensionBudget,
  sidecarPathFor,
  type LedgerSettings,
  type ReceiptData,
  type SidecarEvent,
} from '../index';

// Stub the browser opener so /ledger-receipt never launches anything during tests.
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const DEFAULTS: LedgerSettings = {
  agentRatePerHour: 60,
  humanRatePerHour: 60,
  graceMinutes: 1,
  pomodoroMinutes: 20,
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
  it('excludes stalls, includes tools, keeps generation', () => {
    // generation includes TTFT + streaming; stalls are the abuse vector we drop.
    expect(computeAgentMs(2000, 500, 300)).toBe(1800); // (2000-500)+300
  });
  it('clamps negative stall overshoot to zero active gen', () => {
    expect(computeAgentMs(100, 500, 300)).toBe(300); // max(0,100-500)=0 +300
  });
  it('ignores negative tool time', () => {
    expect(computeAgentMs(1000, 0, -50)).toBe(1000);
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
      60_000
    );
    // agent = (2000-0) + (3000-500) + (1000-0) = 5500
    expect(c.agentMs).toBe(5500);
    expect(c.agentTurns).toBe(3);
    expect(c.agentTokens.total).toBe(525);
    // gap0 = (70000-4000) - 0 = 66000 -> capped at 60000; gap1 = (90000-1500) - 70000 = 18500
    expect(c.humanMs).toBe(60000 + 18500);
    expect(c.humanWindows).toBe(2);
    expect(c.startedAt).toBe(0);
  });

  it('returns zeros for no markers', () => {
    const c = convertTpsEntries([], 60_000);
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
    expect(seg.agentMs).toBe(2300); // (2000 - 500) + 800
    expect(seg.toolMs).toBe(800);
    expect(seg.generationMs).toBe(2000);
    expect(seg.stallMs).toBe(500);
    expect(seg.turnIndex).toBe(1);
    expect(seg.tokens.total).toBe(1400);
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
    expect(seg.agentMs).toBe(1200); // 1200ms generation, no stalls, no tools
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
    // generation 2300 (message span) − stall 1500 = 800
    expect(seg.source).toBe('fallback');
    expect(seg.generationMs).toBe(2300);
    expect(seg.stallMs).toBe(1500);
    expect(seg.agentMs).toBe(800);
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
    expect(lastEntry(fixture, 'ledger-agent').agentMs).toBe(800);
    // ...then tps arrives and corrects it
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ generationMs: 2000, stallMs: 500 }));

    const seg = lastEntry(fixture, 'ledger-agent');
    expect(seg.source).toBe('tps');
    expect(seg.agentMs).toBe(1500); // (2000 - 500) + 0
    expect(entryCount(fixture, 'ledger-agent')).toBe(2); // fallback + tps entries kept
    // rehydrate dedups → keeps tps
    // rehydrate from the sidecar: the fallback is superseded → only tps counts
    const r = rehydrateFromSidecar(fixture.readSidecarEvents());
    expect(r.totals.agentMs).toBe(1500);
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
        tokens: { input: 0, output: 0, total: 1500 },
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
          tokens: { input: 0, output: 0, total: 1500 },
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
    // re-entering (rehydrate) retains the closed window's idle — not lost on exit
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('human 0.01h (1 windows)');
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
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ generationMs: 3_600_000, stallMs: 0 }));
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
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ generationMs: 3_600_000, stallMs: 0 }));
    fixture.clearSidecar(); // simulate a missing/failed sidecar read
    fixture.run('session_start', { type: 'session_start', reason: 'reload' });
    expect(fixture.setStatusSpy.mock.calls.at(-1)![1]).toContain('agent 1.00h');
  });
});
