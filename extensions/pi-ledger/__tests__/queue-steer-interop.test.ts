import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { activateExtension, createTestFixture, type TestFixture } from './helpers';

// pi-queue-steer(-factory) interop: while the queue extension reports
// undispatched rows, pi-core agent_settled is a pause, not a human handoff —
// the no-credit engagement wizard must hold back and re-offer when the
// backlog drains without starting a run. Producer contract:
// globalThis.__tmustierPiQueueSteerState mirror + 'queue-steer:state'
// pi.events emissions on change.

interface Snapshot {
  pending: number;
  paused: boolean;
  blocked: boolean;
}

const setMirror = (snapshot: Snapshot | undefined) => {
  globalThis.__tmustierPiQueueSteerState = snapshot;
};

const REARM_MS = 1500;

describe('queue-steer interop', () => {
  let fixture: TestFixture;
  let cacheDir: string;
  let configDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-qs-'));
    process.env.XDG_CACHE_HOME = cacheDir;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-qs-config-'));
    process.env.XDG_CONFIG_HOME = configDir;
    fixture = createTestFixture();
    await activateExtension(fixture);
    fixture.run('session_start', { type: 'session_start', reason: 'startup' });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    setMirror(undefined);
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const settle = () => {
    fixture.run('agent_end', { type: 'agent_end', messages: [] });
    fixture.run('agent_settled', { type: 'agent_settled' });
  };

  it('holds the wizard at agent_settled while the mirror reports a parked backlog', async () => {
    setMirror({ pending: 3, paused: true, blocked: false });
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.wizardSpy).not.toHaveBeenCalled();
  });

  it('re-offers the wizard once the backlog drains and stays empty through the grace window', async () => {
    setMirror({ pending: 2, paused: false, blocked: false });
    settle();
    expect(fixture.wizardSpy).not.toHaveBeenCalled();

    // The backlog drains without a run (rows sent/removed by hand): the
    // mirror updates, then the change event lands.
    setMirror({ pending: 0, paused: false, blocked: false });
    fixture.emitEvent('queue-steer:state', { pending: 0, paused: false, blocked: false });
    await vi.advanceTimersByTimeAsync(REARM_MS - 1);
    expect(fixture.wizardSpy).not.toHaveBeenCalled(); // still in the grace window
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.wizardSpy).toHaveBeenCalledTimes(1);
  });

  it('tracks the backlog via events alone when no mirror is installed (events-only publisher)', async () => {
    fixture.emitEvent('queue-steer:state', { pending: 2, paused: false, blocked: false });
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.wizardSpy).not.toHaveBeenCalled();

    fixture.emitEvent('queue-steer:state', { pending: 0, paused: false, blocked: false });
    await vi.advanceTimersByTimeAsync(REARM_MS);
    expect(fixture.wizardSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels the drain re-offer when the drain feeds a run (agent_start wins the race)', async () => {
    setMirror({ pending: 1, paused: false, blocked: false });
    settle();
    expect(fixture.wizardSpy).not.toHaveBeenCalled();

    // queue-steer dispatches the row from idle: the drain event fires first,
    // the dispatched prompt starts a run within the grace window.
    setMirror({ pending: 0, paused: false, blocked: false });
    fixture.emitEvent('queue-steer:state', { pending: 0, paused: false, blocked: false });
    fixture.run('agent_start', { type: 'agent_start' });
    await vi.advanceTimersByTimeAsync(REARM_MS + 500);
    expect(fixture.wizardSpy).not.toHaveBeenCalled();

    // The run settles with the queue now empty: the normal settle path pops.
    settle();
    expect(fixture.wizardSpy).toHaveBeenCalledTimes(1);
  });

  it('skips the re-offer when the drain left native follow-ups pending', async () => {
    setMirror({ pending: 1, paused: false, blocked: false });
    settle();
    setMirror({ pending: 0, paused: false, blocked: false });
    (fixture.mockCtx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(true);
    fixture.emitEvent('queue-steer:state', { pending: 0, paused: false, blocked: false });
    await vi.advanceTimersByTimeAsync(REARM_MS + 500);
    expect(fixture.wizardSpy).not.toHaveBeenCalled();
  });

  it('keeps the suppression when the backlog refills during the grace window (later drain re-arms)', async () => {
    setMirror({ pending: 2, paused: false, blocked: false });
    settle();
    setMirror({ pending: 0, paused: false, blocked: false });
    fixture.emitEvent('queue-steer:state', { pending: 0, paused: false, blocked: false });
    await vi.advanceTimersByTimeAsync(REARM_MS - 500);

    // Refill mid-grace: the timer must not pop, and must stay suppressed.
    setMirror({ pending: 1, paused: false, blocked: false });
    fixture.emitEvent('queue-steer:state', { pending: 1, paused: false, blocked: false });
    await vi.advanceTimersByTimeAsync(REARM_MS + 500);
    expect(fixture.wizardSpy).not.toHaveBeenCalled();

    setMirror({ pending: 0, paused: false, blocked: false });
    fixture.emitEvent('queue-steer:state', { pending: 0, paused: false, blocked: false });
    await vi.advanceTimersByTimeAsync(REARM_MS);
    expect(fixture.wizardSpy).toHaveBeenCalledTimes(1);
  });

  it('holds the resume prompt too when a parked backlog survived the swap', async () => {
    // Re-run a resume session_start with a restored backlog mirrored.
    setMirror({ pending: 4, paused: false, blocked: false });
    fixture.run('session_start', { type: 'session_start', reason: 'resume' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.wizardSpy).not.toHaveBeenCalled();
    // no resume grace either — a parked backlog means queued work is in
    // flight, and an unattended dispatch would bill the grace with no human
    expect(fixture.readSidecarEvents().filter((e) => e.kind === 'human-open')).toHaveLength(0);

    setMirror({ pending: 0, paused: false, blocked: false });
    fixture.emitEvent('queue-steer:state', { pending: 0, paused: false, blocked: false });
    await vi.advanceTimersByTimeAsync(REARM_MS);
    expect(fixture.wizardSpy).toHaveBeenCalledTimes(1);
  });

  it('does not pop on later settles while items remain parked (no double-rearming)', async () => {
    setMirror({ pending: 1, paused: true, blocked: false });
    settle();
    settle(); // a second settle (e.g. aborted manual row) — still parked
    await vi.advanceTimersByTimeAsync(REARM_MS + 500);
    expect(fixture.wizardSpy).not.toHaveBeenCalled();
  });
});
