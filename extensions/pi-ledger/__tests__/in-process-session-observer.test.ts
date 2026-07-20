import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installInProcessAgentSessionObserver,
  type AgentSessionClassLike,
  type InProcessAgentSessionObserverCallbacks,
  type InProcessAgentSessionObserverHandle,
} from '../in-process-session-observer';

type FakeSessionEvent = Record<string, unknown>;
type FakeListener = (event: FakeSessionEvent) => void;

function assistantEnd(overrides: Record<string, unknown> = {}): FakeSessionEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'private response text' }],
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
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.01,
          cacheWrite: 0.02,
          total: 0.33,
        },
      },
      stopReason: 'toolUse',
      timestamp: 1234,
      ...overrides,
    },
  };
}

function toolStart(
  toolCallId: string,
  toolName = 'bash',
  args: unknown = { command: 'private command' }
): FakeSessionEvent {
  return { type: 'tool_execution_start', toolCallId, toolName, args };
}

function toolEnd(toolCallId: string, toolName = 'bash'): FakeSessionEvent {
  return {
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: { content: [{ type: 'text', text: 'private tool output' }] },
    isError: false,
  };
}

function createFakeAgentSessionClass() {
  return class FakeAgentSession {
    readonly listeners = new Set<FakeListener>();
    readonly prompts: string[] = [];
    subscribeCalls = 0;
    unsubscribeCalls = 0;
    promptFailure: unknown;
    subscribeFailure: unknown;
    unsubscribeFailure: unknown;
    promptEvent?: FakeSessionEvent;
    lastPromptResult?: Promise<void>;
    onUnsubscribe?: () => void;

    constructor(
      readonly sessionId: string,
      readonly sessionFile: string | undefined = `/sessions/${sessionId}.jsonl`,
      readonly model: { provider: string; id: string } | undefined = {
        provider: 'openai',
        id: 'session-model',
      }
    ) {}

    prompt(text: string): Promise<void> {
      this.prompts.push(text);
      if (this.promptEvent) this.emit(this.promptEvent);
      const result = this.promptFailure
        ? Promise.reject(this.promptFailure)
        : Promise.resolve(undefined);
      this.lastPromptResult = result;
      return result;
    }

    subscribe(listener: FakeListener): () => void {
      this.subscribeCalls += 1;
      if (this.subscribeFailure) throw this.subscribeFailure;
      this.listeners.add(listener);
      return () => {
        this.unsubscribeCalls += 1;
        this.listeners.delete(listener);
        this.onUnsubscribe?.();
        if (this.unsubscribeFailure) throw this.unsubscribeFailure;
      };
    }

    emit(event: FakeSessionEvent): void {
      for (const listener of [...this.listeners]) listener(event);
    }

    dispose(): void {
      this.listeners.clear();
    }
  };
}

const handles: InProcessAgentSessionObserverHandle[] = [];

function installFor(
  AgentSession: AgentSessionClassLike,
  callbacks: InProcessAgentSessionObserverCallbacks = {},
  now: () => number = Date.now,
  rootSessionIds?: Iterable<string>
): InProcessAgentSessionObserverHandle {
  const handle = installInProcessAgentSessionObserver({
    ...callbacks,
    rootSessionIds,
    dependencies: { AgentSession, now },
  });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.uninstall();
});

describe('in-process AgentSession observer', () => {
  it('attaches one public listener before the first prompt and never wraps session instances', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const usage = vi.fn();
    installFor(FakeAgentSession, { onAssistantUsage: usage });
    const session = new FakeAgentSession('child-1');
    session.promptEvent = assistantEnd();

    await session.prompt('private first prompt');
    await session.prompt('private second prompt');

    expect(session.subscribeCalls).toBe(1);
    expect(session.listeners).toHaveLength(1);
    expect(session.prompts).toEqual(['private first prompt', 'private second prompt']);
    expect(Object.hasOwn(session, 'prompt')).toBe(false);
    expect(usage).toHaveBeenCalledTimes(2);
  });

  it('excludes tracked root IDs and can observe the same instance after it is untracked', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const usage = vi.fn();
    const handle = installFor(FakeAgentSession, { onAssistantUsage: usage }, Date.now, [
      'root-session',
    ]);
    const root = new FakeAgentSession('root-session');
    const child = new FakeAgentSession('child-session');

    await root.prompt('root prompt');
    await child.prompt('child prompt');
    root.emit(assistantEnd());
    child.emit(assistantEnd());

    expect(root.subscribeCalls).toBe(0);
    expect(child.subscribeCalls).toBe(1);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage.mock.calls[0]![0].sessionId).toBe('child-session');

    handle.removeRootSessionId('root-session');
    await root.prompt('now observable');
    root.emit(assistantEnd({ responseId: 'root-after-untrack' }));

    expect(root.subscribeCalls).toBe(1);
    expect(usage).toHaveBeenCalledTimes(2);
    expect(usage.mock.calls[1]![0].responseId).toBe('root-after-untrack');
  });

  it('reference-counts root exclusions across observer handles', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const firstUsage = vi.fn();
    const secondUsage = vi.fn();
    const first = installFor(FakeAgentSession, { onAssistantUsage: firstUsage }, Date.now, [
      'shared-root',
    ]);
    const second = installFor(FakeAgentSession, { onAssistantUsage: secondUsage }, Date.now, [
      'shared-root',
    ]);
    const session = new FakeAgentSession('shared-root');

    await session.prompt('excluded by both');
    first.removeRootSessionId('shared-root');
    await session.prompt('still excluded by second');

    expect(session.subscribeCalls).toBe(0);

    second.removeRootSessionId('shared-root');
    await session.prompt('now observable');
    session.emit(assistantEnd());

    expect(session.subscribeCalls).toBe(1);
    expect(firstUsage).toHaveBeenCalledTimes(1);
    expect(secondUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent child sessions and their tool clocks isolated', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    let now = 0;
    const usage = vi.fn();
    const intervals = vi.fn();
    installFor(FakeAgentSession, { onAssistantUsage: usage, onToolInterval: intervals }, () => now);
    const first = new FakeAgentSession('child-a');
    const second = new FakeAgentSession('child-b');
    await Promise.all([first.prompt('a'), second.prompt('b')]);

    first.emit(assistantEnd({ responseId: 'response-a' }));
    second.emit(assistantEnd({ responseId: 'response-b' }));
    now = 10;
    first.emit(toolStart('a-tool'));
    now = 15;
    second.emit(toolStart('b-tool'));
    now = 25;
    first.emit(toolEnd('a-tool'));
    now = 40;
    second.emit(toolEnd('b-tool'));

    expect(usage.mock.calls.map((call) => call[0].sessionId)).toEqual(['child-a', 'child-b']);
    expect(intervals).toHaveBeenCalledTimes(2);
    expect(intervals.mock.calls[0]![0]).toMatchObject({
      sessionId: 'child-a',
      responseId: 'response-a',
      startedAt: 10,
      endedAt: 25,
      durationMs: 15,
    });
    expect(intervals.mock.calls[1]![0]).toMatchObject({
      sessionId: 'child-b',
      responseId: 'response-b',
      startedAt: 15,
      endedAt: 40,
      durationMs: 25,
    });
  });

  it('normalizes assistant usage and parallel tools into text-free union intervals', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    let now = 100;
    const usage = vi.fn();
    const intervals = vi.fn();
    installFor(FakeAgentSession, { onAssistantUsage: usage, onToolInterval: intervals }, () => now);
    const session = new FakeAgentSession('child-usage', '/tmp/child.jsonl');
    await session.prompt('secret prompt text');

    session.emit(assistantEnd());
    session.emit(toolStart('call-a', 'bash'));
    now = 120;
    session.emit(toolStart('call-b', 'read'));
    now = 150;
    session.emit(toolEnd('call-a', 'bash'));
    expect(intervals).not.toHaveBeenCalled();
    now = 180;
    session.emit(toolEnd('call-b', 'read'));

    expect(usage).toHaveBeenCalledWith({
      type: 'assistant_usage',
      sessionId: 'child-usage',
      sessionFile: '/tmp/child.jsonl',
      model: { provider: 'openai', modelId: 'gpt-child' },
      responseId: 'response-1',
      timestamp: 1234,
      stopReason: 'toolUse',
      usage: {
        input: 120,
        output: 30,
        cacheRead: 10,
        cacheWrite: 5,
        reasoning: 4,
        totalTokens: 165,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.01,
          cacheWrite: 0.02,
          total: 0.33,
        },
      },
    });
    expect(intervals).toHaveBeenCalledWith({
      type: 'tool_interval',
      sessionId: 'child-usage',
      sessionFile: '/tmp/child.jsonl',
      model: { provider: 'openai', modelId: 'gpt-child' },
      responseId: 'response-1',
      startedAt: 100,
      endedAt: 180,
      durationMs: 80,
      toolCalls: [
        { toolCallId: 'call-a', toolName: 'bash' },
        { toolCallId: 'call-b', toolName: 'read' },
      ],
    });

    const serialized = JSON.stringify({ usage: usage.mock.calls, intervals: intervals.mock.calls });
    expect(serialized).not.toContain('private response text');
    expect(serialized).not.toContain('private command');
    expect(serialized).not.toContain('private tool output');
    expect(serialized).not.toContain('secret prompt text');
  });

  it('reference-counts installs and restores the exact prompt descriptor after the last uninstall', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const original = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!;
    const firstUsage = vi.fn();
    const secondUsage = vi.fn();
    const first = installFor(FakeAgentSession, { onAssistantUsage: firstUsage });
    const wrapped = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!;
    const second = installFor(FakeAgentSession, { onAssistantUsage: secondUsage });

    expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!.value).toBe(
      wrapped.value
    );
    const session = new FakeAgentSession('child-refcount');
    await session.prompt('one');
    expect(session.subscribeCalls).toBe(1);

    first.uninstall();
    session.emit(assistantEnd());
    expect(firstUsage).not.toHaveBeenCalled();
    expect(secondUsage).toHaveBeenCalledTimes(1);
    expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!.value).toBe(
      wrapped.value
    );

    second.uninstall();
    second.uninstall();
    const restored = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!;
    expect(restored).toEqual(original);
    expect(restored.value).toBe(original.value);
    expect(session.listeners).toHaveLength(0);
    expect(session.unsubscribeCalls).toBe(1);

    await session.prompt('without observer');
    expect(session.subscribeCalls).toBe(1);
    const reinstalled = installFor(FakeAgentSession, { onAssistantUsage: firstUsage });
    await session.prompt('after reinstall');
    expect(reinstalled.installed).toBe(true);
    expect(session.subscribeCalls).toBe(2);
    expect(session.listeners).toHaveLength(1);
  });

  it('keeps the wrapper installed when the last uninstall reentrantly installs a subscriber', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const original = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!;
    const first = installFor(FakeAgentSession);
    const wrapped = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!;
    const session = new FakeAgentSession('child-reentrant');
    await session.prompt('attach first listener');

    const usage = vi.fn();
    let replacement: InProcessAgentSessionObserverHandle | undefined;
    session.onUnsubscribe = () => {
      session.onUnsubscribe = undefined;
      replacement = installFor(FakeAgentSession, { onAssistantUsage: usage });
    };

    first.uninstall();

    expect(replacement?.installed).toBe(true);
    expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!.value).toBe(
      wrapped.value
    );
    await session.prompt('attach replacement listener');
    session.emit(assistantEnd());
    expect(usage).toHaveBeenCalledTimes(1);

    replacement!.uninstall();
    expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')).toEqual(original);
  });

  it('shares one prototype wrapper across uncached module evaluations', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    vi.resetModules();
    const firstModule = await import('../in-process-session-observer.js');
    const first = firstModule.installInProcessAgentSessionObserver({
      dependencies: { AgentSession: FakeAgentSession, now: Date.now },
    });
    handles.push(first);
    const wrapper = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!.value;

    vi.resetModules();
    const secondModule = await import('../in-process-session-observer.js');
    const second = secondModule.installInProcessAgentSessionObserver({
      dependencies: { AgentSession: FakeAgentSession, now: Date.now },
    });
    handles.push(second);

    expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!.value).toBe(
      wrapper
    );
    const session = new FakeAgentSession('child-reload');
    await session.prompt('one listener');
    expect(session.subscribeCalls).toBe(1);
  });

  it('reattaches after an unsubscribe callback removes its listener and then throws', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const errors = vi.fn();
    const first = installFor(FakeAgentSession, { onError: errors });
    const session = new FakeAgentSession('child-throwing-unsubscribe');
    await session.prompt('attach first listener');
    const unsubscribeError = new Error('unsubscribe failed after removal');
    session.unsubscribeFailure = unsubscribeError;

    first.uninstall();

    expect(session.listeners).toHaveLength(0);
    expect(errors).toHaveBeenCalledWith({ phase: 'uninstall', error: unsubscribeError });
    session.unsubscribeFailure = undefined;
    const usage = vi.fn();
    installFor(FakeAgentSession, { onAssistantUsage: usage });
    await session.prompt('reattach listener');
    session.emit(assistantEnd());

    expect(session.subscribeCalls).toBe(2);
    expect(session.listeners).toHaveLength(1);
    expect(usage).toHaveBeenCalledTimes(1);
  });

  it('preserves prompt rejection identity and retries a failed subscription without blocking prompts', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const errors = vi.fn();
    installFor(FakeAgentSession, { onError: errors });
    const session = new FakeAgentSession('child-errors');
    const subscribeError = new Error('subscribe failed');
    session.subscribeFailure = subscribeError;

    const firstResult = session.prompt('still delivered');
    expect(firstResult).toBe(session.lastPromptResult);
    await expect(firstResult).resolves.toBeUndefined();
    expect(session.subscribeCalls).toBe(1);
    expect(errors).toHaveBeenCalledWith({ phase: 'attach', error: subscribeError });

    session.subscribeFailure = undefined;
    const promptError = new Error('prompt failed');
    session.promptFailure = promptError;
    const secondResult = session.prompt('rejected prompt');
    expect(secondResult).toBe(session.lastPromptResult);
    await expect(secondResult).rejects.toBe(promptError);
    expect(session.subscribeCalls).toBe(2);

    await expect(session.prompt('rejected again')).rejects.toBe(promptError);
    expect(session.subscribeCalls).toBe(2);
  });

  it('contains callback failures and tolerates session disposal', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const callbackError = new Error('consumer failed');
    const errors = vi.fn();
    const usage = vi.fn(() => {
      throw callbackError;
    });
    const handle = installFor(FakeAgentSession, { onAssistantUsage: usage, onError: errors });
    const session = new FakeAgentSession('child-dispose');
    await session.prompt('attach');

    expect(() => session.emit(assistantEnd())).not.toThrow();
    expect(errors).toHaveBeenCalledWith({ phase: 'callback', error: callbackError });
    session.dispose();
    expect(session.listeners).toHaveLength(0);
    expect(() => session.emit(assistantEnd())).not.toThrow();
    expect(usage).toHaveBeenCalledTimes(1);
    expect(() => handle.uninstall()).not.toThrow();
  });

  it('rejects a malformed process-global patch state without touching the prototype', () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const seed = installFor(FakeAgentSession);
    seed.uninstall();

    const registry = Reflect.get(
      globalThis,
      Symbol.for('@monotykamary/pi-ledger/in-process-agent-session-observer/v1')
    ) as { patches: WeakMap<object, unknown> };
    const malformed = Object.create(null) as object;
    Object.defineProperty(malformed, 'brand', {
      get() {
        throw new Error('poisoned patch brand');
      },
    });
    registry.patches.set(FakeAgentSession.prototype, malformed);

    try {
      const before = Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')!;
      const errors = vi.fn();
      const handle = installFor(FakeAgentSession, { onError: errors });

      expect(Object.isFrozen(registry)).toBe(true);
      expect(handle).toMatchObject({ installed: false, incompatibility: 'prototype-conflict' });
      expect(Object.getOwnPropertyDescriptor(FakeAgentSession.prototype, 'prompt')).toEqual(before);
      expect(errors.mock.calls[0]![0].phase).toBe('install');
    } finally {
      registry.patches.delete(FakeAgentSession.prototype);
    }
  });

  it('degrades without patching when the public prototype contract is incompatible', async () => {
    class NonWritableSession {
      prompt(): Promise<void> {
        return Promise.resolve();
      }
      subscribe(): () => void {
        return () => undefined;
      }
    }
    const descriptor = Object.getOwnPropertyDescriptor(NonWritableSession.prototype, 'prompt')!;
    Object.defineProperty(NonWritableSession.prototype, 'prompt', {
      ...descriptor,
      writable: false,
    });
    const before = Object.getOwnPropertyDescriptor(NonWritableSession.prototype, 'prompt')!;
    const errors = vi.fn();

    const handle = installFor(NonWritableSession, { onError: errors });

    expect(handle).toMatchObject({ installed: false, incompatibility: 'prompt-descriptor' });
    expect(Object.getOwnPropertyDescriptor(NonWritableSession.prototype, 'prompt')).toEqual(before);
    await expect(new NonWritableSession().prompt()).resolves.toBeUndefined();
    expect(errors.mock.calls[0]![0].phase).toBe('install');
  });

  it('keeps observing safe fields when optional metadata getters fail', async () => {
    const FakeAgentSession = createFakeAgentSessionClass();
    const metadataError = new Error('session file unavailable');
    const errors = vi.fn();
    const usage = vi.fn();
    installFor(FakeAgentSession, { onAssistantUsage: usage, onError: errors });
    const session = new FakeAgentSession('child-metadata');
    Object.defineProperty(session, 'sessionFile', {
      get() {
        throw metadataError;
      },
    });

    await session.prompt('attach');
    expect(() => session.emit(assistantEnd())).not.toThrow();

    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'child-metadata', responseId: 'response-1' })
    );
    expect(errors).toHaveBeenCalledWith({ phase: 'metadata', error: metadataError });
  });
});
