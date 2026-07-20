import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyPiSubprocess,
  installSubprocessTelemetryObserver,
  type DiagnosticsChannelLike,
  type SubprocessAssistantUsageEvent,
  type SubprocessLifecycleEvent,
  type SubprocessMalformedLineEvent,
  type SubprocessToolIntervalEvent,
} from '../subprocess-observer';

class FakeChannel implements DiagnosticsChannelLike {
  readonly listeners = new Set<(message: unknown, name?: string | symbol) => void>();

  subscribe(listener: (message: unknown, name?: string | symbol) => void): void {
    this.listeners.add(listener);
  }

  unsubscribe(listener: (message: unknown, name?: string | symbol) => void): boolean {
    return this.listeners.delete(listener);
  }

  publish(child: FakeChild): void {
    for (const listener of [...this.listeners]) listener({ process: child }, 'child_process');
  }
}

class FakeChild extends EventEmitter {
  pid = 4242;
  spawnfile: string | null = null;
  spawnargs: string[] | undefined;

  constructor(readonly stdout: EventEmitter | null = new EventEmitter()) {
    super();
  }

  spawn(spawnfile: string, spawnargs: string[]): void {
    this.spawnfile = spawnfile;
    this.spawnargs = spawnargs;
    this.emit('spawn');
  }
}

function assistantLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'private 😀 response text' }],
      provider: 'openai',
      model: 'gpt-child',
      responseId: 'response-1',
      usage: {
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 5,
        reasoning: 4,
        totalTokens: 165,
        cost: { total: 99 },
      },
      timestamp: 1234,
      ...overrides,
    },
  })}\n`;
}

function rpcChild(
  channel: FakeChannel,
  stdout: EventEmitter | null = new EventEmitter()
): FakeChild {
  const child = new FakeChild(stdout);
  channel.publish(child);
  child.spawn('/usr/local/bin/pi', ['/usr/local/bin/pi', '--mode', 'rpc']);
  return child;
}

function send(stdout: EventEmitter, value: unknown): void {
  stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`));
}

describe('classifyPiSubprocess', () => {
  it('recognizes Pi RPC and JSON launch forms conservatively', () => {
    expect(classifyPiSubprocess('/opt/bin/pi', ['/opt/bin/pi', '--mode', 'rpc'])).toBe('rpc');
    expect(classifyPiSubprocess('pi.exe', ['pi.exe', '--mode=json'])).toBe('json');
    expect(
      classifyPiSubprocess('node', [
        'node',
        '/repo/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
        '--mode',
        'rpc',
      ])
    ).toBe('rpc');
    expect(
      classifyPiSubprocess('node', [
        'node',
        '/repo/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js',
      ])
    ).toBe('rpc');
    expect(classifyPiSubprocess('npx', ['npx', 'pi', '--mode=json'])).toBe('json');

    expect(classifyPiSubprocess('pi', ['pi'])).toBeUndefined();
    expect(
      classifyPiSubprocess('node', ['node', '/tmp/worker.js', '--mode', 'rpc'])
    ).toBeUndefined();
    expect(classifyPiSubprocess('other', ['other', 'pi', '--mode', 'json'])).toBeUndefined();
  });
});

describe('subprocess JSONL observation', () => {
  it('parses chunks and split UTF-8 while recovering from malformed and overflow lines', () => {
    const channel = new FakeChannel();
    const usage: SubprocessAssistantUsageEvent[] = [];
    const malformed: SubprocessMalformedLineEvent[] = [];
    const handle = installSubprocessTelemetryObserver({
      maxLineBytes: 512,
      dependencies: { channel, now: () => 9000 },
      onAssistantUsage: (event) => usage.push(event),
      onMalformedLine: (event) => malformed.push(event),
    });
    const child = rpcChild(channel);
    const stdout = child.stdout!;
    const encoded = Buffer.from(assistantLine());
    const split = encoded.indexOf(Buffer.from('😀')) + 2;

    stdout.emit('data', encoded.subarray(0, split));
    stdout.emit('data', encoded.subarray(split));
    stdout.emit('data', Buffer.from('{not-json}\n'));
    stdout.emit('data', Buffer.alloc(700, 'x'));
    stdout.emit('data', Buffer.from(`\n${assistantLine({ responseId: 'response-2' })}`));

    expect(usage).toHaveLength(2);
    expect(usage[0]).toEqual({
      type: 'assistant_usage',
      pid: 4242,
      mode: 'rpc',
      timestamp: 1234,
      model: { provider: 'openai', modelId: 'gpt-child' },
      responseId: 'response-1',
      usage: {
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 5,
        reasoning: 4,
        totalTokens: 165,
      },
    });
    expect(usage[1]!.responseId).toBe('response-2');
    expect(malformed.map(({ reason }) => reason)).toEqual(['invalid_json', 'line_too_long']);
    expect(malformed[1]!.lineBytes).toBe(700);
    expect(JSON.stringify({ usage, malformed })).not.toContain('private');
    expect(JSON.stringify({ usage, malformed })).not.toContain('😀');
    handle.unsubscribe();
  });

  it('preserves the stdout consumer, exact emit call contract, and passive stream state', () => {
    const channel = new FakeChannel();
    const usage = vi.fn();
    const stdout = new EventEmitter();
    const consumer = vi.fn();
    stdout.on('data', consumer);
    const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
    const returnValue = { exact: true };
    const baseEmit = stdout.emit;
    const original = function (this: unknown, ...args: unknown[]): unknown {
      calls.push({ receiver: this, args });
      Reflect.apply(baseEmit, this, args);
      return returnValue;
    };
    Object.defineProperty(stdout, 'emit', { value: original, writable: true, configurable: true });
    const listenersBefore = stdout.listenerCount('data');
    installSubprocessTelemetryObserver({ dependencies: { channel }, onAssistantUsage: usage });
    rpcChild(channel, stdout);
    const chunk = Buffer.from(assistantLine());

    const actual = Reflect.apply(stdout.emit, stdout, ['data', chunk, 'extra']);

    expect(actual).toBe(returnValue);
    expect(calls.at(-1)).toEqual({ receiver: stdout, args: ['data', chunk, 'extra'] });
    expect(consumer).toHaveBeenCalledWith(chunk, 'extra');
    expect(stdout.listenerCount('data')).toBe(listenersBefore);
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it('measures the union of parallel tools with an injected clock', () => {
    const channel = new FakeChannel();
    const intervals: SubprocessToolIntervalEvent[] = [];
    let now = 0;
    installSubprocessTelemetryObserver({
      dependencies: { channel, now: () => now },
      onToolInterval: (event) => intervals.push(event),
    });
    const child = rpcChild(channel);
    const stdout = child.stdout!;
    stdout.emit('data', Buffer.from(assistantLine()));

    now = 10;
    send(stdout, { type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'bash' });
    now = 20;
    send(stdout, { type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'read' });
    now = 30;
    send(stdout, { type: 'tool_execution_end', toolCallId: 'call-a', result: { text: 'private' } });
    expect(intervals).toEqual([]);
    now = 50;
    send(stdout, { type: 'tool_execution_end', toolCallId: 'call-b' });

    expect(intervals).toEqual([
      {
        type: 'tool_interval',
        pid: 4242,
        mode: 'rpc',
        model: { provider: 'openai', modelId: 'gpt-child' },
        responseId: 'response-1',
        startedAt: 10,
        endedAt: 50,
        durationMs: 40,
        toolCalls: [
          { toolCallId: 'call-a', toolName: 'bash' },
          { toolCallId: 'call-b', toolName: 'read' },
        ],
      },
    ]);
    expect(JSON.stringify(intervals)).not.toContain('private');
  });

  it('ignores non-Pi children and handles a classified child without stdout', () => {
    const channel = new FakeChannel();
    const lifecycle: SubprocessLifecycleEvent[] = [];
    const handle = installSubprocessTelemetryObserver({
      dependencies: { channel, now: () => 10 },
      onLifecycle: (event) => lifecycle.push(event),
    });
    const nonPiStdout = new EventEmitter();
    const original = nonPiStdout.emit;
    const nonPi = new FakeChild(nonPiStdout);
    channel.publish(nonPi);
    nonPi.spawn('/usr/bin/node', ['/usr/bin/node', '/tmp/worker.js', '--mode', 'rpc']);
    nonPiStdout.emit('data', Buffer.from(assistantLine()));

    const noStdout = rpcChild(channel, null);
    noStdout.emit('close', 0, null);

    expect(nonPiStdout.emit).toBe(original);
    expect(lifecycle.map(({ phase }) => phase)).toEqual(['spawn', 'close']);
    expect(lifecycle[1]).toMatchObject({ pid: 4242, mode: 'rpc', code: 0, signal: null });
    expect(handle.installed).toBe(true);
    handle.unsubscribe();
  });

  it('unsubscribes idempotently and restores emit on unsubscribe or stream close', () => {
    const channel = new FakeChannel();
    const usage = vi.fn();
    const firstStdout = new EventEmitter();
    const firstOriginal = firstStdout.emit;
    const firstHadOwnEmit = Object.hasOwn(firstStdout, 'emit');
    const handle = installSubprocessTelemetryObserver({
      dependencies: { channel },
      onAssistantUsage: usage,
    });
    rpcChild(channel, firstStdout);

    expect(firstStdout.emit).not.toBe(firstOriginal);
    handle.unsubscribe();
    handle.unsubscribe();
    expect(channel.listeners).toHaveLength(0);
    expect(firstStdout.emit).toBe(firstOriginal);
    expect(Object.hasOwn(firstStdout, 'emit')).toBe(firstHadOwnEmit);
    firstStdout.emit('data', Buffer.from(assistantLine()));
    expect(usage).not.toHaveBeenCalled();

    const secondChannel = new FakeChannel();
    const secondStdout = new EventEmitter();
    const secondOriginal = secondStdout.emit;
    const second = installSubprocessTelemetryObserver({ dependencies: { channel: secondChannel } });
    rpcChild(secondChannel, secondStdout);
    secondStdout.emit('close');
    expect(secondStdout.emit).toBe(secondOriginal);
    expect(() => second.unsubscribe()).not.toThrow();
  });

  it('restores the exact emit method after stacked observers uninstall in either order', () => {
    for (const order of ['first-second', 'second-first'] as const) {
      const channel = new FakeChannel();
      const stdout = new EventEmitter();
      const original = stdout.emit;
      const hadOwnEmit = Object.hasOwn(stdout, 'emit');
      const first = installSubprocessTelemetryObserver({ dependencies: { channel } });
      const second = installSubprocessTelemetryObserver({ dependencies: { channel } });
      rpcChild(channel, stdout);

      expect(stdout.emit).not.toBe(original);
      if (order === 'first-second') {
        first.unsubscribe();
        second.unsubscribe();
      } else {
        second.unsubscribe();
        first.unsubscribe();
      }
      expect(stdout.emit).toBe(original);
      expect(Object.hasOwn(stdout, 'emit')).toBe(hadOwnEmit);
    }
  });

  it('cleans up a child when its stdout emit method cannot be wrapped', () => {
    const channel = new FakeChannel();
    const stdout = new EventEmitter();
    Object.defineProperty(stdout, 'emit', {
      value: stdout.emit,
      writable: false,
      configurable: false,
    });
    const child = new FakeChild(stdout);
    const errors = vi.fn();
    const handle = installSubprocessTelemetryObserver({
      dependencies: { channel },
      onError: errors,
    });

    channel.publish(child);
    child.spawn('/usr/local/bin/pi', ['/usr/local/bin/pi', '--mode', 'rpc']);

    expect(errors.mock.calls[0]![0].phase).toBe('attach');
    expect(child.listenerCount('spawn')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(() => handle.unsubscribe()).not.toThrow();
  });

  it('restores pending observations and degrades when the channel is unavailable', () => {
    const channel = new FakeChannel();
    const pending = new FakeChild();
    const handle = installSubprocessTelemetryObserver({ dependencies: { channel } });
    channel.publish(pending);
    expect(pending.listenerCount('spawn')).toBe(1);

    handle.unsubscribe();
    expect(pending.listenerCount('spawn')).toBe(0);
    pending.spawn('pi', ['pi', '--mode', 'rpc']);
    expect(Object.hasOwn(pending.stdout!, 'emit')).toBe(false);

    const unavailable = installSubprocessTelemetryObserver({ dependencies: { channel: null } });
    expect(unavailable).toMatchObject({ installed: false, incompatibility: 'diagnostics_channel' });
    expect(() => unavailable.unsubscribe()).not.toThrow();
  });

  it('contains observer callback failures instead of throwing into stdout', () => {
    const channel = new FakeChannel();
    const callbackError = new Error('consumer failed');
    const errors = vi.fn();
    installSubprocessTelemetryObserver({
      dependencies: { channel },
      onAssistantUsage: () => {
        throw callbackError;
      },
      onError: errors,
    });
    const child = rpcChild(channel);

    expect(() => child.stdout!.emit('data', Buffer.from(assistantLine()))).not.toThrow();
    expect(errors).toHaveBeenCalledWith({ phase: 'callback', error: callbackError });
  });
});
