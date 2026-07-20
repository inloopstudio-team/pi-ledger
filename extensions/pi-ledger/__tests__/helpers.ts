import * as fs from 'node:fs';
import * as path from 'node:path';
import { vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { sidecarPathFor, type SidecarEvent } from '../index';

// Minimal fakes for instantiating a CustomEditor headlessly in tests: the
// editor wrapper delegates every keystroke to the base editor, which only
// needs these to process a key without a real terminal. See LedgerEditor.
const FAKE_TUI = {
  requestRender() {},
  requestGlobalRender() {},
  getColumns() {
    return 80;
  },
  getRows() {
    return 24;
  },
};
const FAKE_THEME = {
  borderColor: '',
  borderMutedColor: '',
  text: '',
  accent: '',
  muted: '',
  dim: '',
  success: '',
  error: '',
  warning: '',
  bg: (s: string) => s,
  fg: (_c: string, s: string) => s,
};
// Recognizes sentinel editor keys for app actions so tests can drive the
// LedgerEditor wrapper's dequeue/followUp branches (matched by action id, as
// in production). Real keybindings are not needed headlessly.
const FAKE_KB = {
  matches: (data: string, action: string) =>
    (action === 'app.message.dequeue' && data === 'dequeue') ||
    (action === 'app.message.followUp' && data === 'followUp'),
};

const TEST_SESSION_ID = '019fabcd-aaaa-bbbb-cccc-dddddddddddd';

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
  selectSpy: ReturnType<typeof vi.fn>;
  inputSpy: ReturnType<typeof vi.fn>;
  registerCommandSpy: ReturnType<typeof vi.fn>;
  setEditorComponentSpy: ReturnType<typeof vi.fn>;
  /** Send a keystroke into the editor wrapper installed via setEditorComponent. */
  sendEditorKey: (data: string) => void;
  emitEvent: (event: string, payload: unknown) => void;
  /** Invoke a lifecycle handler registered via pi.on(name, fn) with (event, ctx). */
  run: (name: string, event: unknown) => void;
  /** Set the value that ctx.ui.custom()'s promise resolves with (for wizard accept/dismiss). */
  setCustomResult: (value: unknown) => void;
  /** Set the value ctx.ui.select() resolves with (for RPC wizard/settings). */
  setSelectResult: (value: unknown) => void;
  /** Set the value ctx.ui.input() resolves with (for RPC settings). */
  setInputResult: (value: unknown) => void;
  mockEntries: Array<{ type?: string; customType?: string; data?: unknown }>;
  mockCtx: ExtensionContext;
  /** Overwrite the per-session sidecar event log with `events` (simulates a resumed session). */
  seedSidecar: (events: SidecarEvent[]) => void;
  /** Read the session's sidecar event log. */
  readSidecarEvents: () => SidecarEvent[];
  /** Last sidecar event of a given kind (or undefined). */
  lastSidecarEvent: (kind: SidecarEvent['kind']) => SidecarEvent | undefined;
  /** Delete the session's sidecar file (simulate a missing/failed read). */
  clearSidecar: () => void;
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
  const selectSpy = vi.fn();
  const inputSpy = vi.fn();
  const registerCommandSpy = vi.fn((name: string, options: unknown) => {
    commands[name] = options as TestFixture['commands'][string];
  });
  const setEditorComponentSpy = vi.fn();
  let editorFactory:
    | ((tui: unknown, theme: unknown, kb: unknown) => { handleInput(data: string): void })
    | null = null;
  let editorComponent: { handleInput(data: string): void } | null = null;
  setEditorComponentSpy.mockImplementation((factory: unknown) => {
    if (typeof factory === 'function') {
      editorFactory = factory as typeof editorFactory;
      editorComponent = null; // rebuild on reinstall (e.g. session reload)
    }
  });

  const mockEntries: Array<{ type?: string; customType?: string; data?: unknown }> = [];

  let customResult: unknown = undefined;
  const setCustomResult = (value: unknown) => {
    customResult = value;
  };
  let selectResult: unknown = undefined;
  const setSelectResult = (value: unknown) => {
    selectResult = value;
  };
  let inputResult: unknown = undefined;
  const setInputResult = (value: unknown) => {
    inputResult = value;
  };

  const mockCtx = {
    hasUI: true,
    mode: 'tui',
    cwd: '/tmp/project',
    ui: {
      notify: notifySpy,
      setStatus: setStatusSpy,
      custom: customSpy,
      select: selectSpy,
      input: inputSpy,
      setEditorComponent: setEditorComponentSpy,
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
    return handlers[name]?.(event, mockCtx);
  };

  const mockPi: Partial<ExtensionAPI> = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      const previous = handlers[event];
      handlers[event] = previous
        ? (...args: unknown[]) => {
            const previousResult = previous(...args);
            const result = handler(...args);
            return result === undefined ? previousResult : result;
          }
        : handler;
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
  selectSpy.mockImplementation(() => Promise.resolve(selectResult));
  inputSpy.mockImplementation(() => Promise.resolve(inputResult));

  const sidecarFile = () => sidecarPathFor(TEST_SESSION_ID);
  const seedSidecar = (events: SidecarEvent[]) => {
    fs.mkdirSync(path.dirname(sidecarFile()), { recursive: true });
    fs.writeFileSync(sidecarFile(), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };
  const readSidecarEvents = (): SidecarEvent[] => {
    try {
      return fs
        .readFileSync(sidecarFile(), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as SidecarEvent);
    } catch {
      return [];
    }
  };
  const lastSidecarEvent = (kind: SidecarEvent['kind']): SidecarEvent | undefined => {
    const events = readSidecarEvents();
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === kind) return events[i]!;
    return undefined;
  };
  const clearSidecar = () => {
    try {
      fs.rmSync(sidecarFile(), { force: true });
    } catch {
      // ignore
    }
  };

  const sendEditorKey = (data: string) => {
    if (!editorFactory) return;
    if (!editorComponent) editorComponent = editorFactory(FAKE_TUI, FAKE_THEME, FAKE_KB);
    editorComponent.handleInput(data);
  };

  return {
    mockPi,
    handlers,
    commands,
    appendEntrySpy,
    notifySpy,
    setStatusSpy,
    customSpy,
    selectSpy,
    inputSpy,
    registerCommandSpy,
    setEditorComponentSpy,
    sendEditorKey,
    emitEvent,
    run,
    setCustomResult,
    setSelectResult,
    setInputResult,
    mockEntries,
    mockCtx,
    seedSidecar,
    readSidecarEvents,
    lastSidecarEvent,
    clearSidecar,
  };
}

export async function activateExtension(fixture: TestFixture): Promise<void> {
  const { default: ledgerExtension } = await import('../index.js');
  ledgerExtension(fixture.mockPi as ExtensionAPI);
}

/** An assistant message for the message_start/update/end hooks (fallback timing). */
export function makeAssistantMessage(
  overrides: {
    input?: number;
    output?: number;
    totalTokens?: number;
    provider?: string;
    model?: string;
  } = {}
): unknown {
  const {
    input = 100,
    output = 50,
    totalTokens = 150,
    provider = 'openai',
    model = 'gpt-4',
  } = overrides;
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    provider,
    model,
    usage: {
      input,
      output,
      totalTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}
