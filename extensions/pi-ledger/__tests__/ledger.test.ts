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
  convertTpsEntries,
  extractTpsEntries,
  fmtHours,
  fmtMoney,
  rehydrateFromEntries,
  type LedgerSettings,
  type ReceiptData,
} from '../index';

// Stub the browser opener so /ledger-receipt never launches anything during tests.
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const DEFAULTS: LedgerSettings = {
  agentRatePerHour: 0,
  humanRatePerHour: 0,
  graceMinutes: 1,
  pomodoroMinutes: 20,
  project: '',
  author: '',
  currency: 'USD',
  autoWizard: true,
};

function lastEntry(fixture: TestFixture, customType: string): any {
  const calls = fixture.appendEntrySpy.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === customType) return calls[i][1];
  }
  return undefined;
}

function entryCount(fixture: TestFixture, customType: string): number {
  return fixture.appendEntrySpy.mock.calls.filter((c) => c[0] === customType).length;
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
    expect(b.blendedRate).toBeCloseTo(83.33, 1);
  });
  it('blended rate is 0 when no hours', () => {
    expect(computeBilling(0, 0, DEFAULTS).blendedRate).toBe(0);
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
    expect(applySettingValue(DEFAULTS, 'agentRatePerHour', '-5').agentRatePerHour).toBe(0); // reject negative
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
    expect(applySettingValue(DEFAULTS, 'agentRatePerHour', 'nope').agentRatePerHour).toBe(0);
  });
});

describe('rehydrateFromEntries', () => {
  it('replays agent + human segments and restores last settings', () => {
    const entries = [
      {
        type: 'custom',
        customType: 'ledger-settings',
        data: { ...DEFAULTS, agentRatePerHour: 100 },
      },
      {
        type: 'custom',
        customType: 'ledger-agent',
        data: {
          kind: 'agent',
          turnIndex: 0,
          agentMs: 3_600_000,
          generationMs: 3_000_000,
          stallMs: 0,
          toolMs: 600_000,
          tokens: { input: 100, output: 50, total: 150 },
          model: { provider: 'openai', modelId: 'gpt-4' },
          timestamp: 1000,
        },
      },
      {
        type: 'custom',
        customType: 'ledger-human',
        data: {
          kind: 'human',
          billedMs: 1_800_000,
          idleMs: 1_800_000,
          grantedBudgetMs: 60_000,
          extensions: 0,
          openedAt: 0,
          closedAt: 1_800_000,
          timestamp: 2000,
        },
      },
    ];
    const r = rehydrateFromEntries(entries);
    expect(r.settings.agentRatePerHour).toBe(100);
    expect(r.totals.agentMs).toBe(3_600_000);
    expect(r.totals.humanMs).toBe(1_800_000);
    expect(r.totals.agentTurns).toBe(1);
    expect(r.totals.humanWindows).toBe(1);
    expect(r.totals.agentTokens.total).toBe(150);
  });
  it('defaults settings when none persisted', () => {
    const r = rehydrateFromEntries([]);
    expect(r.settings).toEqual(DEFAULTS);
    expect(r.totals.agentMs).toBe(0);
  });
  it('dedups agent segments by turnIndex, keeping the last (tps over fallback)', () => {
    const entries = [
      {
        type: 'custom',
        customType: 'ledger-agent',
        data: {
          kind: 'agent',
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
      },
      {
        type: 'custom',
        customType: 'ledger-agent',
        data: {
          kind: 'agent',
          turnIndex: 0,
          agentMs: 1500,
          generationMs: 2000,
          stallMs: 500,
          toolMs: 0,
          tokens: { input: 10, output: 5, total: 15 },
          model: { provider: 'openai', modelId: 'gpt-4' },
          source: 'tps',
          timestamp: 2,
        },
      },
    ];
    const r = rehydrateFromEntries(entries);
    expect(r.totals.agentMs).toBe(1500);
    expect(r.totals.agentTurns).toBe(1);
    expect(r.totals.agentTokens.total).toBe(15);
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
    blendedRate: 145 / 1.7,
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
  it('shows the blended rate', () => {
    const html = buildReceiptHtml(data);
    expect(html).toContain('Blended rate');
    expect(html).toContain('$85.29/h');
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

  beforeEach(async () => {
    vi.useFakeTimers();
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.useRealTimers();
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
    const appended = fixture.appendEntrySpy.mock.calls
      .filter((c) => c[0] === 'ledger-agent')
      .map((c) => ({ type: 'custom', customType: 'ledger-agent', data: c[1] }));
    const r = rehydrateFromEntries(appended);
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
    const agentEntries = fixture.appendEntrySpy.mock.calls.filter((c) => c[0] === 'ledger-agent');
    expect(agentEntries).toHaveLength(1); // only the turn-0 tps entry
  });

  it('opens/closes a human window and bills actual idle under the grace budget', async () => {
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // grace 1m
    await vi.advanceTimersByTimeAsync(5000); // 5s idle — wizard (60s) not yet fired
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg).toBeDefined();
    expect(seg.billedMs).toBe(5000);
    expect(seg.grantedBudgetMs).toBe(60_000);
    expect(seg.extensions).toBe(0);
    expect(fixture.customSpy).not.toHaveBeenCalled(); // wizard never popped
  });

  it('caps human time at the grace minute when the wizard is dismissed', async () => {
    fixture.setCustomResult('stop');
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    await vi.advanceTimersByTimeAsync(60_000); // grace ends → wizard fires, dismissed
    await vi.advanceTimersByTimeAsync(30_000); // 90s total idle, no re-arm after dismiss
    fixture.run('agent_start', { type: 'agent_start' });

    expect(fixture.customSpy).toHaveBeenCalledTimes(1);
    const seg = lastEntry(fixture, 'ledger-human');
    expect(seg.billedMs).toBe(60_000); // capped at grace
    expect(seg.extensions).toBe(0);
  });

  it('extends the budget when the wizard is accepted', async () => {
    fixture.setCustomResult('extend');
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    await vi.advanceTimersByTimeAsync(60_000); // wizard fires, accepted → +20m
    await vi.advanceTimersByTimeAsync(300_000); // 5m more idle, re-armed wizard (20m) not yet fired
    fixture.run('agent_start', { type: 'agent_start' });

    const seg = lastEntry(fixture, 'ledger-human');
    // budget grew to 1m + 20m = 21m; actual idle 6m is under budget → billed = actual
    expect(seg.grantedBudgetMs).toBe(60_000 + 20 * 60_000);
    expect(seg.extensions).toBe(1);
    expect(seg.billedMs).toBe(360_000); // 6 min
  });

  it('/ledger-extend manually raises the budget and caps billing', async () => {
    fixture.run('agent_end', { type: 'agent_end', messages: [] }); // grace 1m, timer armed
    await fixture.commands['ledger-extend'].handler('5', fixture.mockCtx); // +5m → budget 6m
    await vi.advanceTimersByTimeAsync(100_000); // 100s idle, under 6m budget, wizard (6m) not fired
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
    fixture.mockEntries.push(
      {
        type: 'custom',
        customType: 'ledger-settings',
        data: {
          ...DEFAULTS,
          agentRatePerHour: 100,
          humanRatePerHour: 50,
          project: 'app',
          author: 'tom',
        },
      },
      {
        type: 'custom',
        customType: 'ledger-agent',
        data: {
          kind: 'agent',
          turnIndex: 0,
          agentMs: 3_600_000,
          generationMs: 3_000_000,
          stallMs: 0,
          toolMs: 600_000,
          tokens: { input: 0, output: 0, total: 0 },
          model: { provider: 'openai', modelId: 'gpt-4' },
          timestamp: 1000,
        },
      },
      {
        type: 'custom',
        customType: 'ledger-human',
        data: {
          kind: 'human',
          billedMs: 1_800_000,
          idleMs: 1_800_000,
          grantedBudgetMs: 60_000,
          extensions: 0,
          openedAt: 0,
          closedAt: 1_800_000,
          timestamp: 2000,
        },
      }
    );
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await fixture.commands['ledger'].handler('', fixture.mockCtx);

    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('agent 1.00h (1 turns)');
    expect(msg).toContain('human 0.50h (1 windows)');
    expect(msg).toContain('total $125.00');
    // custom grey footer installed and shows the live hours
    expect(fixture.setFooterSpy).toHaveBeenCalledTimes(1);
    expect(fixture.footerComponent).not.toBeNull();
    const bar = fixture.footerComponent!.render(120)[0]!;
    expect(bar).toContain('\x1b[48;5;240m'); // grey background
    expect(bar).toContain('agent 1.00h');
    expect(bar).toContain('main'); // git branch from footerData
  });

  it('derives the footer + /ledger hours from pi-tps markers for a tps-only session', async () => {
    fixture.mockEntries.push({
      type: 'custom',
      customType: 'ledger-settings',
      data: { ...DEFAULTS, agentRatePerHour: 120, humanRatePerHour: 60 },
    });
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

    const bar = fixture.footerComponent!.render(120)[0]!;
    expect(bar).toContain('\x1b[48;5;240m');
    expect(bar).toContain('agent 1.00h'); // 3.6M ms = 1h

    await fixture.commands['ledger'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-2)![0] as string;
    expect(msg).toContain('agent 1.00h (1 turns)');
    expect(
      fixture.notifySpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('Derived from 1 pi-tps markers')
      )
    ).toBe(true);
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
      fixture.mockEntries.push({
        type: 'custom',
        customType: 'ledger-settings',
        data: {
          ...DEFAULTS,
          agentRatePerHour: 100,
          humanRatePerHour: 50,
          project: 'app.inloop.studio',
          author: 'tom',
        },
      });
      fixture.mockEntries.push({
        type: 'custom',
        customType: 'ledger-agent',
        data: {
          kind: 'agent',
          turnIndex: 0,
          agentMs: 3_600_000,
          generationMs: 3_600_000,
          stallMs: 0,
          toolMs: 0,
          tokens: { input: 0, output: 0, total: 1500 },
          model: { provider: 'openai', modelId: 'gpt-4' },
          timestamp: 1000,
        },
      });
      fixture.run('session_start', { type: 'session_start', reason: 'resume' });

      await fixture.commands['ledger-receipt'].handler('', fixture.mockCtx);

      const dir = path.join(tmp, 'pi-ledger');
      const files = fs.readdirSync(dir);
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
      fixture.mockEntries.push({
        type: 'custom',
        customType: 'ledger-settings',
        data: { ...DEFAULTS, agentRatePerHour: 100, humanRatePerHour: 50, project: 'demo' },
      });
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
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      const html = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
      // 1h agent @ $100 = $100; single marker → no inter-turn gap → no human time
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
});
