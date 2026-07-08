import { vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export interface TestFixture {
  mockPi: Partial<ExtensionAPI>;
  handlers: Record<string, (...args: unknown[]) => unknown>;
  commands: Record<
    string,
    {
      description?: string;
      handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => unknown;
    }
  >;
  appendEntrySpy: ReturnType<typeof vi.fn>;
  notifySpy: ReturnType<typeof vi.fn>;
  setStatusSpy: ReturnType<typeof vi.fn>;
  customSpy: ReturnType<typeof vi.fn>;
  registerCommandSpy: ReturnType<typeof vi.fn>;
  emitEvent: (event: string, payload: unknown) => void;
  /** Invoke a lifecycle handler registered via pi.on(name, fn) with (event, ctx). */
  run: (name: string, event: unknown) => void;
  /** Set the value that ctx.ui.custom()'s promise resolves with (for wizard accept/dismiss). */
  setCustomResult: (value: unknown) => void;
  mockEntries: Array<{ type?: string; customType?: string; data?: unknown }>;
  mockCtx: ExtensionContext;
}

export function makeTpsTelemetry(
  overrides: {
    generationMs?: number;
    stallMs?: number;
    input?: number;
    output?: number;
    total?: number;
    provider?: string;
    modelId?: string;
  } = {}
): unknown {
  const {
    generationMs = 2000,
    stallMs = 0,
    input = 1000,
    output = 500,
    total = 1500,
    provider = 'openai',
    modelId = 'gpt-4',
  } = overrides;
  return {
    model: { provider, modelId },
    tokens: { input, output, total },
    timing: {
      generationMs,
      stallMs,
      ttftMs: 500,
      totalMs: 2500,
      streamMs: 1500,
      stallCount: 0,
      messageCount: 1,
    },
    tps: 250,
    cost: null,
    rateUsdPerMTokens: null,
    timestamp: Date.now(),
  };
}

export function createTestFixture(): TestFixture {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const commands: TestFixture['commands'] = {};
  const appendEntrySpy = vi.fn();
  const notifySpy = vi.fn();
  const setStatusSpy = vi.fn();
  const customSpy = vi.fn();
  const registerCommandSpy = vi.fn((name: string, options: unknown) => {
    commands[name] = options as TestFixture['commands'][string];
  });

  const mockEntries: Array<{ type?: string; customType?: string; data?: unknown }> = [];

  let customResult: unknown = undefined;
  const setCustomResult = (value: unknown) => {
    customResult = value;
  };

  const mockCtx = {
    hasUI: true,
    mode: 'tui',
    cwd: '/tmp/project',
    ui: {
      notify: notifySpy,
      setStatus: setStatusSpy,
      custom: customSpy,
    },
    sessionManager: {
      getEntries: vi.fn().mockReturnValue(mockEntries),
      getBranch: vi.fn().mockReturnValue(mockEntries),
      getSessionId: vi.fn().mockReturnValue('019fabcd-aaaa-bbbb-cccc-dddddddddddd'),
    },
    modelRegistry: undefined,
    model: undefined,
    isIdle: vi.fn().mockReturnValue(true),
    isProjectTrusted: vi.fn().mockReturnValue(true),
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: vi.fn().mockReturnValue(false),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(),
  } as unknown as ExtensionContext;

  const eventListeners = new Map<string, ((payload: unknown) => void)[]>();
  const emitEvent = (event: string, payload: unknown) => {
    for (const listener of eventListeners.get(event) ?? []) listener(payload);
  };
  const run = (name: string, event: unknown) => {
    handlers[name]?.(event, mockCtx);
  };

  const mockPi: Partial<ExtensionAPI> = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers[event] = handler;
      return mockPi as ExtensionAPI;
    }) as unknown as ExtensionAPI['on'],
    appendEntry: appendEntrySpy,
    registerCommand: registerCommandSpy as unknown as ExtensionAPI['registerCommand'],
    events: {
      on: vi.fn((event: string, listener: (payload: unknown) => void) => {
        const list = eventListeners.get(event) ?? [];
        list.push(listener);
        eventListeners.set(event, list);
        return () => {};
      }) as unknown as ExtensionAPI['events']['on'],
      emit: vi.fn(),
    } as unknown as ExtensionAPI['events'],
  };

  // ctx.ui.custom: by default resolve immediately without invoking the factory
  // (avoids needing a terminal). Tests can set a result to simulate a choice.
  customSpy.mockImplementation(() => Promise.resolve(customResult));

  return {
    mockPi,
    handlers,
    commands,
    appendEntrySpy,
    notifySpy,
    setStatusSpy,
    customSpy,
    registerCommandSpy,
    emitEvent,
    run,
    setCustomResult,
    mockEntries,
    mockCtx,
  };
}

export async function activateExtension(fixture: TestFixture): Promise<void> {
  const { default: ledgerExtension } = await import('../index.js');
  ledgerExtension(fixture.mockPi as ExtensionAPI);
}
