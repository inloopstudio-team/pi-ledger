import * as diagnosticsChannel from 'node:diagnostics_channel';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type PiSubprocessMode = 'rpc' | 'json';

export const SUBPROCESS_OBSERVER_LIMITS = Object.freeze({
  maxLineBytes: 1_048_576,
  maxMetadataBytes: 512,
  maxActiveTools: 256,
});

export interface SubprocessModelRef {
  readonly provider?: string;
  readonly modelId?: string;
}

export interface SubprocessAssistantUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
}

interface ProcessRef {
  readonly pid?: number;
  readonly mode: PiSubprocessMode;
}

export interface SubprocessAssistantUsageEvent extends ProcessRef {
  readonly type: 'assistant_usage';
  readonly timestamp: number;
  readonly model?: SubprocessModelRef;
  readonly responseId?: string;
  readonly usage: SubprocessAssistantUsage;
}

export interface SubprocessToolIntervalEvent extends ProcessRef {
  readonly type: 'tool_interval';
  readonly model?: SubprocessModelRef;
  readonly responseId?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly toolCalls: readonly { readonly toolCallId: string; readonly toolName?: string }[];
}

export interface SubprocessLifecycleEvent extends ProcessRef {
  readonly type: 'lifecycle';
  readonly phase: 'spawn' | 'close';
  readonly timestamp: number;
  readonly code?: number | null;
  readonly signal?: string | null;
}

export interface SubprocessMalformedLineEvent extends ProcessRef {
  readonly type: 'malformed_line';
  readonly reason: 'invalid_json' | 'line_too_long';
  readonly lineBytes: number;
  readonly timestamp: number;
}

export type SubprocessTelemetryEvent =
  | SubprocessAssistantUsageEvent
  | SubprocessToolIntervalEvent
  | SubprocessLifecycleEvent
  | SubprocessMalformedLineEvent;

export type SubprocessObserverErrorPhase = 'install' | 'attach' | 'stream' | 'callback' | 'cleanup';

export interface SubprocessTelemetryObserverOptions {
  readonly maxLineBytes?: number;
  readonly onAssistantUsage?: (event: SubprocessAssistantUsageEvent) => unknown;
  readonly onToolInterval?: (event: SubprocessToolIntervalEvent) => unknown;
  readonly onLifecycle?: (event: SubprocessLifecycleEvent) => unknown;
  readonly onMalformedLine?: (event: SubprocessMalformedLineEvent) => unknown;
  readonly onError?: (error: { phase: SubprocessObserverErrorPhase; error: unknown }) => unknown;
  readonly dependencies?: {
    readonly channel?: DiagnosticsChannelLike | null;
    readonly now?: () => number;
  };
}

export interface DiagnosticsChannelLike {
  subscribe(listener: DiagnosticListener): unknown;
  unsubscribe(listener: DiagnosticListener): unknown;
}

export interface SubprocessTelemetryObserverHandle {
  readonly installed: boolean;
  readonly incompatibility?: 'diagnostics_channel';
  unsubscribe(): void;
}

type DiagnosticListener = (message: unknown, name?: string | symbol) => void;
type Listener = (...args: unknown[]) => void;
type Emit = (this: unknown, ...args: unknown[]) => unknown;

const STREAM_PATCH_SYMBOL = Symbol.for('@monotykamary/pi-ledger/subprocess-stdout-emit-patch/v1');
const STREAM_PATCH_BRAND = '@monotykamary/pi-ledger/subprocess-stdout-emit-patch/v1';

interface StreamLike {
  emit: Emit;
}

interface StreamEmitPatch {
  readonly brand: typeof STREAM_PATCH_BRAND;
  readonly stream: StreamLike;
  readonly wrapper: Emit;
  readonly previous: Emit;
  readonly previousDescriptor?: PropertyDescriptor;
  active: boolean;
}

interface ChildLike {
  pid?: number;
  spawnfile?: string | null;
  spawnargs?: readonly string[];
  stdout?: StreamLike | null;
  once(event: string, listener: Listener): unknown;
  off?(event: string, listener: Listener): unknown;
  removeListener?(event: string, listener: Listener): unknown;
}

function executableName(value: string): string {
  return basename(value.replaceAll('\\', '/'))
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, '');
}

function piScript(value: string): 'cli' | 'rpc-entry' | undefined {
  const path = value.replaceAll('\\', '/').toLowerCase();
  if (!path.includes('pi-coding-agent/') && !path.includes('/node_modules/.bin/pi')) return;
  if (/(?:^|\/)rpc-entry\.(?:js|mjs|cjs|ts)$/.test(path)) return 'rpc-entry';
  if (/(?:^|\/)cli\.(?:js|mjs|cjs|ts)$/.test(path)) return 'cli';
  return undefined;
}

/** Conservatively identify Pi invocations that produce JSONL event streams. */
export function classifyPiSubprocess(
  spawnfile: unknown,
  spawnargs: unknown
): PiSubprocessMode | undefined {
  try {
    if (typeof spawnfile !== 'string' || !Array.isArray(spawnargs)) return;
    const args = spawnargs.filter((arg): arg is string => typeof arg === 'string');
    if (args.length !== spawnargs.length) return;
    let mode: PiSubprocessMode | undefined;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!.toLowerCase();
      const next = args[index + 1]?.toLowerCase();
      if (arg === '--mode' && (next === 'rpc' || next === 'json')) mode = next;
      if (arg === '--mode=rpc') mode = 'rpc';
      if (arg === '--mode=json') mode = 'json';
    }
    if (executableName(spawnfile) === 'pi') return mode;
    const scripts = [spawnfile, ...args].map(piScript);
    if (scripts.includes('rpc-entry')) return mode ?? 'rpc';
    if (!mode) return;
    const launcher = executableName(spawnfile);
    if (
      !['node', 'nodejs', 'bun', 'deno', 'env', 'npx', 'npm', 'pnpm', 'yarn', 'bunx'].includes(
        launcher
      )
    ) {
      return;
    }
    const hasPi = args.some(
      (arg) =>
        executableName(arg) === 'pi' ||
        arg.toLowerCase() === '@earendil-works/pi-coding-agent' ||
        piScript(arg) === 'cli'
    );
    return hasPi ? mode : undefined;
  } catch {
    return;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function streamEmitPatch(value: unknown): StreamEmitPatch | undefined {
  if (typeof value !== 'function') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, STREAM_PATCH_SYMBOL);
    const candidate = descriptor && 'value' in descriptor ? record(descriptor.value) : undefined;
    if (
      candidate?.brand !== STREAM_PATCH_BRAND ||
      candidate.wrapper !== value ||
      typeof candidate.previous !== 'function' ||
      typeof candidate.active !== 'boolean'
    ) {
      return undefined;
    }
    return candidate as unknown as StreamEmitPatch;
  } catch {
    return undefined;
  }
}

function peelInactiveStreamPatches(
  stream: StreamLike,
  onError: SubprocessTelemetryObserverOptions['onError']
): void {
  for (let depth = 0; depth < 64; depth++) {
    let current: unknown;
    try {
      current = Reflect.get(stream, 'emit');
    } catch (error) {
      report(onError, 'cleanup', error);
      return;
    }
    const patch = streamEmitPatch(current);
    if (!patch || patch.stream !== stream || patch.active) return;
    try {
      if (patch.previousDescriptor) {
        Object.defineProperty(stream, 'emit', patch.previousDescriptor);
      } else if (!Reflect.deleteProperty(stream, 'emit')) {
        throw new Error('Unable to restore the inherited stdout emit method.');
      }
    } catch (error) {
      report(onError, 'cleanup', error);
      return;
    }
  }
  report(onError, 'cleanup', new Error('Too many nested stdout emit observer patches.'));
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= SUBPROCESS_OBSERVER_LIMITS.maxMetadataBytes
    ? value
    : undefined;
}

interface ParserSink {
  event(event: SubprocessTelemetryEvent): void;
  now(): number;
}

class JsonlParser {
  private decoder = new StringDecoder('utf8');
  private text = '';
  private bytes = 0;
  private overflow = false;
  private ended = false;
  private readonly active = new Map<string, string | undefined>();
  private readonly union = new Map<string, string | undefined>();
  private unionStart?: number;
  private unionModel?: SubprocessModelRef;
  private unionResponseId?: string;
  private lastModel?: SubprocessModelRef;
  private lastResponseId?: string;

  constructor(
    private readonly ref: ProcessRef,
    private readonly maxLineBytes: number,
    private readonly sink: ParserSink
  ) {}

  push(chunk: unknown): void {
    if (this.ended) return;
    if (typeof chunk === 'string') this.pushString(chunk);
    else if (chunk instanceof Uint8Array) {
      this.pushBuffer(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.bytes || this.text || this.overflow) this.line();
    else this.decoder.end();
  }

  dispose(): void {
    this.ended = true;
    this.text = '';
    this.decoder.end();
    this.active.clear();
    this.union.clear();
  }

  private addBytes(count: number): void {
    this.bytes = Math.min(Number.MAX_SAFE_INTEGER, this.bytes + count);
  }

  private pushBuffer(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      const before = this.bytes;
      this.addBytes(part.length);
      if (!this.overflow && this.bytes <= this.maxLineBytes) this.text += this.decoder.write(part);
      else if (!this.overflow) {
        const allowed = Math.max(0, this.maxLineBytes - before);
        if (allowed) this.decoder.write(part.subarray(0, allowed));
        this.decoder.end();
        this.decoder = new StringDecoder('utf8');
        this.text = '';
        this.overflow = true;
      }
      if (newline < 0) return;
      this.line();
      start = newline + 1;
    }
  }

  private pushString(chunk: string): void {
    if (!this.overflow) this.text += this.decoder.end();
    else this.decoder.end();
    this.decoder = new StringDecoder('utf8');
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf('\n', start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.slice(start, end);
      this.addBytes(Buffer.byteLength(part, 'utf8'));
      if (!this.overflow && this.bytes <= this.maxLineBytes) this.text += part;
      else if (!this.overflow) {
        this.text = '';
        this.overflow = true;
      }
      if (newline < 0) return;
      this.line();
      start = newline + 1;
    }
  }

  private line(): void {
    const bytes = this.bytes;
    const tooLong = this.overflow;
    const line = tooLong ? '' : `${this.text}${this.decoder.end()}`.replace(/\r$/, '');
    this.decoder = new StringDecoder('utf8');
    this.text = '';
    this.bytes = 0;
    this.overflow = false;
    if (tooLong) {
      this.sink.event({
        type: 'malformed_line',
        ...this.ref,
        reason: 'line_too_long',
        lineBytes: bytes,
        timestamp: this.sink.now(),
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.sink.event({
        type: 'malformed_line',
        ...this.ref,
        reason: 'invalid_json',
        lineBytes: bytes,
        timestamp: this.sink.now(),
      });
      return;
    }
    this.handle(record(parsed));
  }

  private handle(event: Record<string, unknown> | undefined): void {
    if (event?.type === 'message_end') this.assistant(event);
    else if (event?.type === 'tool_execution_start') this.toolStart(event);
    else if (event?.type === 'tool_execution_end') this.toolEnd(event);
  }

  private assistant(event: Record<string, unknown>): void {
    const message = record(event.message);
    if (!message || message.role !== 'assistant') return;
    const provider = metadataString(message.provider);
    const modelId = metadataString(message.model);
    const model =
      provider || modelId
        ? { ...(provider ? { provider } : {}), ...(modelId ? { modelId } : {}) }
        : undefined;
    const responseId = metadataString(message.responseId);
    this.lastModel = model;
    this.lastResponseId = responseId;
    const source = record(message.usage);
    if (!source) return;
    const input = nonNegative(source.input);
    const output = nonNegative(source.output);
    const cacheRead = nonNegative(source.cacheRead);
    const cacheWrite = nonNegative(source.cacheWrite);
    const reasoning =
      typeof source.reasoning === 'number' && Number.isFinite(source.reasoning)
        ? Math.max(0, source.reasoning)
        : undefined;
    const total =
      typeof source.totalTokens === 'number' && Number.isFinite(source.totalTokens)
        ? Math.max(0, source.totalTokens)
        : input + output + cacheRead + cacheWrite;
    const usage: SubprocessAssistantUsage = {
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(reasoning !== undefined ? { reasoning } : {}),
      totalTokens: total,
    };
    const timestamp =
      typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? Math.max(0, message.timestamp)
        : this.sink.now();
    this.sink.event({
      type: 'assistant_usage',
      ...this.ref,
      timestamp,
      ...(model ? { model } : {}),
      ...(responseId ? { responseId } : {}),
      usage,
    });
  }

  private toolStart(event: Record<string, unknown>): void {
    const id = metadataString(event.toolCallId);
    if (!id || this.active.has(id) || this.active.size >= SUBPROCESS_OBSERVER_LIMITS.maxActiveTools)
      return;
    const name = metadataString(event.toolName);
    if (this.active.size === 0) {
      this.unionStart = this.sink.now();
      this.union.clear();
      this.unionModel = this.lastModel;
      this.unionResponseId = this.lastResponseId;
    }
    this.active.set(id, name);
    this.union.set(id, name);
  }

  private toolEnd(event: Record<string, unknown>): void {
    const id = metadataString(event.toolCallId);
    if (!id || !this.active.delete(id) || this.active.size) return;
    const startedAt = this.unionStart ?? this.sink.now();
    const endedAt = Math.max(startedAt, this.sink.now());
    const durationMs = endedAt - startedAt;
    const toolCalls = [...this.union].map(([toolCallId, toolName]) => ({
      toolCallId,
      ...(toolName ? { toolName } : {}),
    }));
    this.sink.event({
      type: 'tool_interval',
      ...this.ref,
      ...(this.unionModel ? { model: this.unionModel } : {}),
      ...(this.unionResponseId ? { responseId: this.unionResponseId } : {}),
      startedAt,
      endedAt,
      durationMs,
      toolCalls,
    });
    this.unionStart = undefined;
    this.unionModel = undefined;
    this.unionResponseId = undefined;
    this.union.clear();
  }
}

function report(
  callback: SubprocessTelemetryObserverOptions['onError'],
  phase: SubprocessObserverErrorPhase,
  error: unknown
): void {
  try {
    const result = callback?.({ phase, error });
    if (result instanceof Promise) void result.catch(() => undefined);
  } catch {
    // Observability is never load-bearing for a child process.
  }
}

function remove(child: ChildLike, event: string, listener: Listener): void {
  try {
    const method = child.off ?? child.removeListener;
    if (method) Reflect.apply(method, child, [event, listener]);
  } catch {
    // Best-effort cleanup for feature-compatible ChildProcess implementations.
  }
}

/** Observe future Pi RPC/JSON children without consuming or flowing stdout. */
export function installSubprocessTelemetryObserver(
  options: SubprocessTelemetryObserverOptions = {}
): SubprocessTelemetryObserverHandle {
  const nowSource = options.dependencies?.now ?? Date.now;
  const now = (): number => {
    try {
      const value = nowSource();
      if (Number.isFinite(value)) return value;
    } catch (error) {
      report(options.onError, 'stream', error);
    }
    return Date.now();
  };
  const requestedLimit = options.maxLineBytes;
  const maxLineBytes =
    Number.isSafeInteger(requestedLimit) && requestedLimit! > 0
      ? Math.min(requestedLimit!, 16_777_216)
      : SUBPROCESS_OBSERVER_LIMITS.maxLineBytes;
  let channel: DiagnosticsChannelLike | null = null;
  try {
    channel =
      options.dependencies && 'channel' in options.dependencies
        ? (options.dependencies.channel ?? null)
        : ((diagnosticsChannel.channel?.('child_process') as DiagnosticsChannelLike | undefined) ??
          null);
  } catch (error) {
    report(options.onError, 'install', error);
  }
  if (!channel?.subscribe || !channel.unsubscribe) {
    return { installed: false, incompatibility: 'diagnostics_channel', unsubscribe() {} };
  }

  const cleanups = new Set<() => void>();
  const dispatch = (event: SubprocessTelemetryEvent): void => {
    const callback =
      event.type === 'assistant_usage'
        ? options.onAssistantUsage
        : event.type === 'tool_interval'
          ? options.onToolInterval
          : event.type === 'lifecycle'
            ? options.onLifecycle
            : options.onMalformedLine;
    try {
      const result = callback?.(event as never);
      if (result instanceof Promise)
        void result.catch((error) => report(options.onError, 'callback', error));
    } catch (error) {
      report(options.onError, 'callback', error);
    }
  };

  const observe = (child: ChildLike): void => {
    let done = false;
    let parser: JsonlParser | undefined;
    let ref: ProcessRef | undefined;
    let restore = (): void => undefined;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      remove(child, 'spawn', spawned);
      remove(child, 'error', failed);
      remove(child, 'close', closed);
      parser?.dispose();
      restore();
      cleanups.delete(cleanup);
    };
    const failed: Listener = () => cleanup();
    const closed: Listener = (code, signal) => {
      try {
        parser?.finish();
        if (ref) {
          dispatch({
            type: 'lifecycle',
            ...ref,
            phase: 'close',
            timestamp: now(),
            ...(typeof code === 'number' || code === null ? { code } : {}),
            ...(typeof signal === 'string' || signal === null ? { signal } : {}),
          });
        }
      } catch (error) {
        report(options.onError, 'stream', error);
      } finally {
        cleanup();
      }
    };
    const spawned: Listener = () => {
      try {
        remove(child, 'error', failed);
        const mode = classifyPiSubprocess(child.spawnfile, child.spawnargs);
        if (!mode) return cleanup();
        const pid = Number.isSafeInteger(child.pid) && child.pid! >= 0 ? child.pid : undefined;
        ref = { mode, ...(pid !== undefined ? { pid } : {}) };
        dispatch({
          type: 'lifecycle',
          ...ref,
          phase: 'spawn',
          timestamp: now(),
        });
        if (done) return;
        const stdout = child.stdout;
        const previous = stdout?.emit;
        if (stdout && typeof previous === 'function') {
          parser = new JsonlParser(ref, maxLineBytes, { event: dispatch, now });
          const previousDescriptor = Object.getOwnPropertyDescriptor(stdout, 'emit');
          let patch: StreamEmitPatch;
          const wrapper: Emit = function (this: unknown, ...args: unknown[]): unknown {
            if (patch.active && this === stdout) {
              try {
                if (args[0] === 'data') parser?.push(args[1]);
                else if (args[0] === 'end') parser?.finish();
                else if (args[0] === 'close') {
                  parser?.finish();
                  restore();
                }
              } catch (error) {
                report(options.onError, 'stream', error);
              }
            }
            return Reflect.apply(previous, this, args);
          };
          patch = {
            brand: STREAM_PATCH_BRAND,
            stream: stdout,
            wrapper,
            previous,
            ...(previousDescriptor ? { previousDescriptor } : {}),
            active: true,
          };
          Object.defineProperty(wrapper, STREAM_PATCH_SYMBOL, {
            value: patch,
            enumerable: false,
            configurable: false,
            writable: false,
          });
          Object.defineProperty(stdout, 'emit', {
            value: wrapper,
            writable: previousDescriptor?.writable ?? true,
            enumerable: previousDescriptor?.enumerable ?? false,
            configurable: previousDescriptor?.configurable ?? true,
          });
          restore = (): void => {
            if (!patch.active) return;
            patch.active = false;
            peelInactiveStreamPatches(stdout, options.onError);
          };
        }
        Reflect.apply(child.once, child, ['close', closed]);
      } catch (error) {
        report(options.onError, 'attach', error);
        cleanup();
      }
    };
    cleanups.add(cleanup);
    try {
      Reflect.apply(child.once, child, ['error', failed]);
      Reflect.apply(child.once, child, ['spawn', spawned]);
    } catch (error) {
      report(options.onError, 'attach', error);
      cleanup();
    }
  };

  const listener: DiagnosticListener = (message) => {
    try {
      const child = record(message)?.process;
      if (
        child &&
        (typeof child === 'object' || typeof child === 'function') &&
        typeof Reflect.get(child, 'once') === 'function'
      ) {
        observe(child as ChildLike);
      }
    } catch (error) {
      report(options.onError, 'attach', error);
    }
  };
  try {
    channel.subscribe(listener);
  } catch (error) {
    report(options.onError, 'install', error);
    return { installed: false, incompatibility: 'diagnostics_channel', unsubscribe() {} };
  }

  let unsubscribed = false;
  return {
    installed: true,
    unsubscribe(): void {
      if (unsubscribed) return;
      unsubscribed = true;
      try {
        channel!.unsubscribe(listener);
      } catch (error) {
        report(options.onError, 'cleanup', error);
      }
      for (const cleanup of [...cleanups]) cleanup();
    },
  };
}
