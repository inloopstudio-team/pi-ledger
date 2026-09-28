import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rehydrateFromSidecar, verifySidecarChain, type BackgroundToolEvent } from '../index.js';
import { FABRIC_SHELL_TIMING_EVENT, FabricShellTimeMeter } from '../fabric-shell-timing.js';
import {
  activateExtension,
  createTestFixture,
  makeAssistantMessage,
  makeTpsTelemetry,
  type TestFixture,
} from './helpers.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

describe('Fabric background shell accounting', () => {
  let fixture: TestFixture;
  let directory: string;
  const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const event = (taskId: string, phase: 'started' | 'finished', extra = {}) => ({
    version: 1,
    sessionId: fixture.mockCtx.sessionManager.getSessionId(),
    taskId,
    tool: 'bash',
    phase,
    timestamp: Date.now(),
    ...extra,
  });
  const emit = (taskId: string, phase: 'started' | 'finished', extra = {}) =>
    fixture.emitEvent(FABRIC_SHELL_TIMING_EVENT, event(taskId, phase, extra));
  const totals = () => rehydrateFromSidecar(fixture.readSidecarEvents()).totals;
  const spans = () =>
    fixture
      .readSidecarEvents()
      .filter((e): e is BackgroundToolEvent => e.kind === 'background-tool');
  const tool = (phase: 'start' | 'end', id = 'outer') =>
    fixture.run(`tool_execution_${phase}`, {
      toolCallId: id,
      toolName: 'fabric_exec',
      args: {},
      result: {},
      isError: false,
    });
  const turn = (index: number) => {
    fixture.run('turn_start', { turnIndex: index });
    const message = makeAssistantMessage({ output: 75, input: 0, totalTokens: 75 });
    fixture.run('message_start', { message });
    fixture.run('message_end', { message });
    return () => fixture.run('turn_end', { turnIndex: index, message, toolResults: [] });
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-shell-'));
    vi.stubEnv('XDG_CACHE_HOME', path.join(directory, 'cache'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(directory, 'config'));
    fixture = createTestFixture();
    await activateExtension(fixture);
    fixture.run('session_start', { reason: 'new' });
  });
  afterEach(() => {
    fixture.run('session_shutdown', {});
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('unions detached shells with foreground tools across turns and idle completion', () => {
    const endFirst = turn(0);
    tool('start');
    advance(100);
    emit('a', 'started');
    advance(100);
    tool('end');
    endFirst();
    advance(100);
    emit('b', 'started', { tool: 'powershell' });
    advance(100);
    const endSecond = turn(1);
    tool('start', 'wait');
    advance(100);
    tool('start', 'parallel');
    advance(100);
    tool('end', 'wait');
    advance(100);
    tool('end', 'parallel');
    endSecond();
    advance(100);
    emit('a', 'finished');
    advance(200);
    emit('b', 'finished', { tool: 'powershell' });
    expect(totals()).toMatchObject({
      agentMs: 3000,
      agentToolMs: 1000,
      agentGenMs: 2000,
      agentTurns: 2,
      toolTurns: 2,
    });
    expect(spans().reduce((sum, e) => sum + e.toolMs, 0)).toBe(500);
    expect(spans().some((e) => e.taskIds.length === 2)).toBe(true);
    advance(10_000);
    fixture.run('session_shutdown', {});
    expect(totals().agentToolMs).toBe(1000);
  });

  it('keeps background spans independent of a late TPS fallback correction', () => {
    const end = turn(0);
    tool('start');
    advance(100);
    emit('a', 'started');
    advance(100);
    tool('end');
    advance(100);
    end();
    advance(100);
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ output: 150, input: 0, total: 150 }));
    advance(100);
    emit('a', 'finished');
    expect(totals()).toMatchObject({
      agentMs: 2500,
      agentToolMs: 500,
      agentGenMs: 2000,
      agentTurns: 1,
    });
    expect(totals().agentTokens.output).toBe(150);
  });

  it('counts background-only work without fabricating model turns or human time', async () => {
    emit('ui-monitor', 'started');
    advance(60_000);
    await fixture.commands.ledger!.handler('', fixture.mockCtx);
    expect(totals()).toMatchObject({
      agentMs: 60_000,
      agentToolMs: 60_000,
      agentTurns: 0,
      agentGenMs: 0,
      humanMs: 0,
    });
    expect(fixture.notifySpy).toHaveBeenCalledWith(expect.stringContaining('agent 0.02h'), 'info');
    advance(1000);
    emit('ui-monitor', 'finished');
    expect(totals().agentToolMs).toBe(61_000);
  });

  it('rejects foreign/malformed events and ignores duplicate lifecycle notifications', () => {
    emit('foreign', 'started', { sessionId: 'another-session' });
    emit('future', 'started', { timestamp: Date.now() + 1 });
    emit('invalid', 'started', { version: 2 });
    emit('invalid-tool', 'started', { tool: 'read' });
    fixture.emitEvent(FABRIC_SHELL_TIMING_EVENT, null);
    advance(100);
    expect(totals().agentToolMs).toBe(0);
    emit('a', 'started');
    advance(100);
    emit('a', 'started');
    advance(100);
    emit('a', 'finished');
    advance(100);
    emit('a', 'finished');
    emit('a', 'started');
    advance(100);
    fixture.run('session_shutdown', {});
    expect(totals().agentToolMs).toBe(200);
  });

  it('flushes before the shutdown seal and rejects late cleanup notifications', () => {
    emit('a', 'started');
    advance(1000);
    fixture.run('session_shutdown', {});
    const before = fixture.readSidecarEvents();
    expect(before.at(-1)?.kind).toBe('session-close');
    expect(totals().agentToolMs).toBe(1000);
    advance(1000);
    emit('a', 'finished');
    emit('late', 'started');
    expect(fixture.readSidecarEvents()).toEqual(before);
    const identity = JSON.parse(
      fs.readFileSync(path.join(directory, 'config', 'pi-ledger', 'identity.json'), 'utf8')
    );
    expect(
      verifySidecarChain(before, {
        kid: identity.kid,
        publicKeyRaw: Buffer.from(identity.publicKey, 'base64'),
      }).status
    ).toBe('sealed');
  });

  it('rehydrates completed spans on reload but never resumes a stale running clock', async () => {
    emit('a', 'started');
    advance(1000);
    fixture.run('session_shutdown', {});
    advance(10_000);
    fixture = createTestFixture();
    await activateExtension(fixture);
    fixture.run('session_start', { reason: 'reload' });
    emit('a', 'finished');
    emit('new', 'started');
    advance(500);
    emit('new', 'finished');
    expect(totals().agentToolMs).toBe(1500);
  });

  it('exports live background time under Tool execution in the receipt', async () => {
    emit('build', 'started');
    advance(60_000);
    await fixture.commands['ledger-receipt']!.handler('', fixture.mockCtx);
    const root = path.join(directory, 'cache', 'pi-ledger');
    const file = fs.readdirSync(root).find((name) => name.endsWith('.html'))!;
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    expect(html).toContain('data-reveal="Tool execution"');
    expect(html).toContain('data-reveal="$1.00"');
    expect(totals().agentToolMs).toBe(60_000);
    emit('build', 'finished');
  });

  it('preserves historical TPS-only generation when adding background-only work', async () => {
    fixture.mockEntries.push({
      type: 'custom',
      customType: 'tps',
      data: makeTpsTelemetry({ output: 4500 }),
    });
    emit('build', 'started');
    advance(60_000);
    emit('build', 'finished');
    await fixture.commands.ledger!.handler('', fixture.mockCtx);
    // One minute generation + one minute background at the default $60/hour.
    expect(fixture.notifySpy).toHaveBeenCalledWith(expect.stringContaining('total $2.00'), 'info');
  });

  it('detaches and rebinds the session bus listener on lifecycle changes', () => {
    const events = fixture.mockPi.events!;
    const on = vi.mocked(events.on).getMockImplementation()!;
    const off = vi.fn();
    vi.spyOn(events, 'on').mockImplementation((name, listener) => {
      const unsubscribe = on(name, listener);
      return name === FABRIC_SHELL_TIMING_EVENT ? off : unsubscribe;
    });
    fixture.run('session_start', { reason: 'new' });
    fixture.run('session_shutdown', {});
    expect(off).toHaveBeenCalledTimes(1);
    fixture.run('session_start', { reason: 'new' });
    emit('fresh', 'started');
    advance(100);
    emit('fresh', 'finished');
    expect(totals().agentToolMs).toBe(100);
  });

  it('does not lose a terminal event when the wall clock moves backwards', () => {
    const record = vi.fn();
    const meter = new FabricShellTimeMeter(() => false, record);
    meter.startSession(fixture.mockCtx.sessionManager.getSessionId());
    meter.accept(event('clock', 'started'));
    advance(100);
    meter.checkpoint();
    advance(-50);
    meter.accept(event('clock', 'finished'));
    advance(1000);
    meter.close();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![0].toolMs).toBe(100);
  });
});
