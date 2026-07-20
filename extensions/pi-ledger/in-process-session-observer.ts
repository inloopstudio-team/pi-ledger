import { AgentSession } from '@earendil-works/pi-coding-agent';

const REGISTRY_SYMBOL = Symbol.for('@monotykamary/pi-ledger/in-process-agent-session-observer/v1');
const REGISTRY_BRAND = '@monotykamary/pi-ledger/in-process-agent-session-observer/v1';
const PATCH_BRAND = `${REGISTRY_BRAND}/patch`;

export interface InProcessModelRef {
  readonly provider?: string;
  readonly modelId?: string;
}

export interface InProcessUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface InProcessAssistantUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly totalTokens: number;
  readonly cost?: InProcessUsageCost;
}

export interface InProcessSessionMetadata {
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly model?: InProcessModelRef;
  readonly responseId?: string;
}

export interface InProcessAssistantUsageEvent extends InProcessSessionMetadata {
  readonly type: 'assistant_usage';
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly usage: InProcessAssistantUsage;
}

export interface InProcessToolCallRef {
  readonly toolCallId: string;
  readonly toolName?: string;
}

export interface InProcessToolIntervalEvent extends InProcessSessionMetadata {
  readonly type: 'tool_interval';
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly toolCalls: readonly InProcessToolCallRef[];
}

export type InProcessObserverErrorPhase =
  | 'install'
  | 'attach'
  | 'metadata'
  | 'event'
  | 'callback'
  | 'uninstall';

export interface InProcessObserverError {
  readonly phase: InProcessObserverErrorPhase;
  readonly error: unknown;
}

export interface InProcessAgentSessionObserverCallbacks {
  onAssistantUsage?: (event: InProcessAssistantUsageEvent) => void | Promise<void>;
  onToolInterval?: (event: InProcessToolIntervalEvent) => void | Promise<void>;
  onError?: (error: InProcessObserverError) => void | Promise<void>;
}

export interface AgentSessionClassLike {
  readonly prototype: object;
}

export interface InProcessAgentSessionObserverDependencies {
  readonly AgentSession: AgentSessionClassLike;
  readonly now: () => number;
}

export interface InProcessAgentSessionObserverOptions extends InProcessAgentSessionObserverCallbacks {
  readonly rootSessionIds?: Iterable<string>;
  readonly dependencies?: Partial<InProcessAgentSessionObserverDependencies>;
}

export type InProcessObserverIncompatibility =
  | 'global-registry'
  | 'agent-session-prototype'
  | 'prompt-descriptor'
  | 'subscribe-method'
  | 'prototype-conflict'
  | 'prototype-patch';

export interface InProcessAgentSessionObserverHandle {
  readonly installed: boolean;
  readonly incompatibility?: InProcessObserverIncompatibility;
  addRootSessionId(sessionId: string): void;
  removeRootSessionId(sessionId: string): void;
  uninstall(): void;
}

type PromptFunction = (this: unknown, ...args: unknown[]) => unknown;
type SessionEventListener = (event: unknown) => void;

type ObserverCallbacks = Readonly<InProcessAgentSessionObserverCallbacks>;

interface Subscriber {
  readonly callbacks: ObserverCallbacks;
  readonly roots: Set<string>;
}

interface SessionMetadata {
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly model?: InProcessModelRef;
}

interface SessionObservation {
  generation: number;
  subscribed: boolean;
  unsubscribe?: () => void;
  sessionRef: WeakRef<object>;
  readonly listener: SessionEventListener;
  readonly activeTools: Map<string, string | undefined>;
  readonly unionToolCalls: Map<string, string | undefined>;
  unionStartedAt?: number;
  unionMetadata?: InProcessSessionMetadata;
  lastModel?: InProcessModelRef;
  lastResponseId?: string;
}

interface PatchState {
  readonly brand: typeof PATCH_BRAND;
  readonly prototype: object;
  readonly originalDescriptor: PropertyDescriptor;
  readonly wrappedDescriptor: PropertyDescriptor;
  active: boolean;
  generation: number;
  now: () => number;
  readonly subscribers: Map<symbol, Subscriber>;
  readonly rootSessionIds: Map<string, number>;
  readonly sessions: WeakMap<object, SessionObservation>;
  readonly attachmentRefs: Set<WeakRef<SessionObservation>>;
  readonly attachmentFinalizer: FinalizationRegistry<WeakRef<SessionObservation>>;
}

interface GlobalRegistry {
  readonly brand: typeof REGISTRY_BRAND;
  readonly patches: WeakMap<object, PatchState>;
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function asRecord(value: unknown): Record<PropertyKey, unknown> | undefined {
  return isObject(value) ? (value as Record<PropertyKey, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, asFiniteNumber(value) ?? 0);
}

function invokeCallback<T>(
  callback: ((value: T) => void | Promise<void>) | undefined,
  value: T,
  onError: (error: unknown) => void
): void {
  if (!callback) return;
  try {
    const result = callback(value);
    if (result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(onError);
    }
  } catch (error) {
    onError(error);
  }
}

function reportDirect(
  callback: InProcessAgentSessionObserverCallbacks['onError'],
  phase: InProcessObserverErrorPhase,
  error: unknown
): void {
  invokeCallback(callback, Object.freeze({ phase, error }), () => undefined);
}

function reportSubscriber(
  subscriber: Subscriber,
  phase: InProcessObserverErrorPhase,
  error: unknown
): void {
  reportDirect(subscriber.callbacks.onError, phase, error);
}

function reportAll(state: PatchState, phase: InProcessObserverErrorPhase, error: unknown): void {
  for (const subscriber of [...state.subscribers.values()]) {
    reportSubscriber(subscriber, phase, error);
  }
}

function isGlobalRegistry(value: unknown): value is GlobalRegistry {
  try {
    const record = asRecord(value);
    return record?.brand === REGISTRY_BRAND && record.patches instanceof WeakMap;
  } catch {
    return false;
  }
}

function getGlobalRegistry(
  onError: InProcessAgentSessionObserverCallbacks['onError']
): GlobalRegistry | undefined {
  const holder = globalThis as unknown as Record<PropertyKey, unknown>;
  let existing: unknown;
  try {
    existing = Reflect.get(holder, REGISTRY_SYMBOL);
  } catch (error) {
    reportDirect(onError, 'install', error);
    return undefined;
  }
  if (existing !== undefined) {
    if (isGlobalRegistry(existing)) return existing;
    reportDirect(
      onError,
      'install',
      new Error('The process-global AgentSession observer registry is incompatible.')
    );
    return undefined;
  }

  const registry: GlobalRegistry = Object.freeze({
    brand: REGISTRY_BRAND,
    patches: new WeakMap<object, PatchState>(),
  });
  try {
    Object.defineProperty(holder, REGISTRY_SYMBOL, {
      value: registry,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    return registry;
  } catch (error) {
    reportDirect(onError, 'install', error);
    return undefined;
  }
}

function descriptorsEqual(left: PropertyDescriptor, right: PropertyDescriptor): boolean {
  return (
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set &&
    left.writable === right.writable &&
    left.enumerable === right.enumerable &&
    left.configurable === right.configurable
  );
}

function readDescriptor(prototype: object): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(prototype, 'prompt');
  } catch {
    return undefined;
  }
}

function readPrototypeMethod(prototype: object, name: string): unknown {
  try {
    return Reflect.get(prototype, name);
  } catch {
    return undefined;
  }
}

function isPatchState(value: unknown): value is PatchState {
  try {
    const record = asRecord(value);
    return (
      record?.brand === PATCH_BRAND &&
      isObject(record.prototype) &&
      isObject(record.originalDescriptor) &&
      isObject(record.wrappedDescriptor) &&
      typeof record.active === 'boolean' &&
      typeof record.generation === 'number' &&
      typeof record.now === 'function' &&
      record.subscribers instanceof Map &&
      record.rootSessionIds instanceof Map &&
      record.sessions instanceof WeakMap &&
      record.attachmentRefs instanceof Set &&
      isObject(record.attachmentFinalizer)
    );
  } catch {
    return false;
  }
}

function createPatchState(
  prototype: object,
  descriptor: PropertyDescriptor,
  now: () => number
): PatchState {
  let state: PatchState;
  const originalDescriptor = Object.freeze({ ...descriptor });
  const originalPrompt = originalDescriptor.value as PromptFunction;
  const wrapper: PromptFunction = function observedAgentSessionPrompt(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    if (state.active) {
      try {
        attachSession(state, this);
      } catch (error) {
        reportAll(state, 'attach', error);
      }
    }
    return Reflect.apply(originalPrompt, this, args);
  };
  const wrappedDescriptor = Object.freeze({ ...originalDescriptor, value: wrapper });
  const attachmentRefs = new Set<WeakRef<SessionObservation>>();

  state = {
    brand: PATCH_BRAND,
    prototype,
    originalDescriptor,
    wrappedDescriptor,
    active: false,
    generation: 0,
    now,
    subscribers: new Map<symbol, Subscriber>(),
    rootSessionIds: new Map<string, number>(),
    sessions: new WeakMap<object, SessionObservation>(),
    attachmentRefs,
    attachmentFinalizer: new FinalizationRegistry((ref) => attachmentRefs.delete(ref)),
  };
  return state;
}

function activatePatch(
  state: PatchState,
  now: () => number,
  onError: InProcessAgentSessionObserverCallbacks['onError']
): InProcessObserverIncompatibility | undefined {
  const current = readDescriptor(state.prototype);
  if (!current) {
    reportDirect(onError, 'install', new Error('AgentSession.prototype.prompt is unavailable.'));
    return 'prompt-descriptor';
  }

  if (state.active) {
    if (!descriptorsEqual(current, state.wrappedDescriptor)) {
      reportDirect(
        onError,
        'install',
        new Error('AgentSession.prototype.prompt changed while observation was installed.')
      );
      return 'prototype-conflict';
    }
    return undefined;
  }

  if (
    !descriptorsEqual(current, state.originalDescriptor) &&
    !descriptorsEqual(current, state.wrappedDescriptor)
  ) {
    reportDirect(
      onError,
      'install',
      new Error('AgentSession.prototype.prompt no longer matches the compatible descriptor.')
    );
    return 'prototype-conflict';
  }

  try {
    if (!descriptorsEqual(current, state.wrappedDescriptor)) {
      Object.defineProperty(state.prototype, 'prompt', state.wrappedDescriptor);
    }
  } catch (error) {
    reportDirect(onError, 'install', error);
    return 'prototype-patch';
  }

  state.now = now;
  state.active = true;
  state.generation += 1;
  return undefined;
}

function resetObservation(observation: SessionObservation, generation: number): void {
  observation.generation = generation;
  observation.activeTools.clear();
  observation.unionToolCalls.clear();
  observation.unionStartedAt = undefined;
  observation.unionMetadata = undefined;
  observation.lastModel = undefined;
  observation.lastResponseId = undefined;
}

function detachSessions(state: PatchState, reportingSubscriber: Subscriber): void {
  for (const ref of [...state.attachmentRefs]) {
    const observation = ref.deref();
    if (!observation) {
      state.attachmentRefs.delete(ref);
      continue;
    }
    resetObservation(observation, state.generation);
    if (!observation.subscribed || !observation.unsubscribe) continue;
    try {
      observation.unsubscribe();
    } catch (error) {
      reportSubscriber(reportingSubscriber, 'uninstall', error);
    } finally {
      observation.unsubscribe = undefined;
      observation.subscribed = false;
    }
  }
}

function deactivatePatch(state: PatchState, reportingSubscriber: Subscriber): void {
  state.active = false;
  state.generation += 1;
  detachSessions(state, reportingSubscriber);
  if (state.subscribers.size > 0) return;

  const current = readDescriptor(state.prototype);
  if (!current) {
    reportSubscriber(
      reportingSubscriber,
      'uninstall',
      new Error('AgentSession.prototype.prompt disappeared before restoration.')
    );
    return;
  }
  if (descriptorsEqual(current, state.originalDescriptor)) return;
  if (!descriptorsEqual(current, state.wrappedDescriptor)) {
    reportSubscriber(
      reportingSubscriber,
      'uninstall',
      new Error('AgentSession.prototype.prompt changed; refusing to overwrite the newer value.')
    );
    return;
  }
  try {
    Object.defineProperty(state.prototype, 'prompt', state.originalDescriptor);
  } catch (error) {
    reportSubscriber(reportingSubscriber, 'uninstall', error);
  }
}

function readSessionProperty(
  state: PatchState,
  session: object,
  property: string,
  phase: 'attach' | 'metadata' = 'metadata'
): unknown {
  try {
    return Reflect.get(session, property);
  } catch (error) {
    reportAll(state, phase, error);
    return undefined;
  }
}

function normalizeModel(value: unknown): InProcessModelRef | undefined {
  const model = asRecord(value);
  if (!model) return undefined;
  const provider = asString(model.provider);
  const modelId = asString(model.id) ?? asString(model.modelId) ?? asString(model.model);
  if (!provider && !modelId) return undefined;
  return Object.freeze({
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
  });
}

function readSessionMetadata(state: PatchState, session: object): SessionMetadata {
  const sessionId = asString(readSessionProperty(state, session, 'sessionId'));
  const sessionFile = asString(readSessionProperty(state, session, 'sessionFile'));
  let model: InProcessModelRef | undefined;
  try {
    model = normalizeModel(readSessionProperty(state, session, 'model'));
  } catch (error) {
    reportAll(state, 'metadata', error);
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(model ? { model } : {}),
  };
}

function metadataWithResponse(
  metadata: SessionMetadata,
  model: InProcessModelRef | undefined,
  responseId: string | undefined
): InProcessSessionMetadata {
  return Object.freeze({
    ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
    ...(metadata.sessionFile ? { sessionFile: metadata.sessionFile } : {}),
    ...(model ? { model } : {}),
    ...(responseId ? { responseId } : {}),
  });
}

function readNow(state: PatchState): number {
  try {
    const value = state.now();
    if (Number.isFinite(value)) return value;
    reportAll(
      state,
      'event',
      new Error('AgentSession observer clock returned a non-finite value.')
    );
  } catch (error) {
    reportAll(state, 'event', error);
  }
  return Date.now();
}

function normalizeUsage(value: unknown): InProcessAssistantUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const reasoning = asFiniteNumber(usage.reasoning);
  const costRecord = asRecord(usage.cost);
  const cost = costRecord
    ? Object.freeze({
        input: nonNegativeNumber(costRecord.input),
        output: nonNegativeNumber(costRecord.output),
        cacheRead: nonNegativeNumber(costRecord.cacheRead),
        cacheWrite: nonNegativeNumber(costRecord.cacheWrite),
        total: nonNegativeNumber(costRecord.total),
      })
    : undefined;
  const input = nonNegativeNumber(usage.input);
  const output = nonNegativeNumber(usage.output);
  const cacheRead = nonNegativeNumber(usage.cacheRead);
  const cacheWrite = nonNegativeNumber(usage.cacheWrite);
  const suppliedTotal = asFiniteNumber(usage.totalTokens);
  const totalTokens =
    suppliedTotal === undefined
      ? input + output + cacheRead + cacheWrite
      : Math.max(0, suppliedTotal);
  return Object.freeze({
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(reasoning !== undefined ? { reasoning: Math.max(0, reasoning) } : {}),
    totalTokens,
    ...(cost ? { cost } : {}),
  });
}

function normalizeMessageModel(
  message: Record<PropertyKey, unknown>,
  fallback: InProcessModelRef | undefined
): InProcessModelRef | undefined {
  const provider = asString(message.provider) ?? fallback?.provider;
  const modelId = asString(message.model) ?? fallback?.modelId;
  if (!provider && !modelId) return undefined;
  return Object.freeze({
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
  });
}

function dispatchEvent(
  state: PatchState,
  event: InProcessAssistantUsageEvent | InProcessToolIntervalEvent
): void {
  if (event.sessionId && state.rootSessionIds.has(event.sessionId)) return;
  for (const [id, subscriber] of [...state.subscribers.entries()]) {
    if (!state.subscribers.has(id)) continue;
    const onError = (error: unknown): void => reportSubscriber(subscriber, 'callback', error);
    if (event.type === 'assistant_usage') {
      invokeCallback(subscriber.callbacks.onAssistantUsage, event, onError);
    } else {
      invokeCallback(subscriber.callbacks.onToolInterval, event, onError);
    }
  }
}

function handleAssistantMessageEnd(
  state: PatchState,
  observation: SessionObservation,
  metadata: SessionMetadata,
  event: Record<PropertyKey, unknown>
): void {
  const message = asRecord(event.message);
  if (!message || message.role !== 'assistant') return;

  const model = normalizeMessageModel(message, metadata.model);
  const responseId = asString(message.responseId);
  observation.lastModel = model;
  observation.lastResponseId = responseId;

  const usage = normalizeUsage(message.usage);
  if (!usage) return;
  const timestamp = asFiniteNumber(message.timestamp) ?? readNow(state);
  const stopReason = asString(message.stopReason);
  const normalized = Object.freeze({
    type: 'assistant_usage' as const,
    ...metadataWithResponse(metadata, model, responseId),
    timestamp,
    ...(stopReason ? { stopReason } : {}),
    usage,
  });
  dispatchEvent(state, normalized);
}

function handleToolStart(
  state: PatchState,
  observation: SessionObservation,
  metadata: SessionMetadata,
  event: Record<PropertyKey, unknown>
): void {
  const toolCallId = asString(event.toolCallId);
  if (!toolCallId || observation.activeTools.has(toolCallId)) return;
  const toolName = asString(event.toolName);
  const startedAt = readNow(state);
  if (observation.activeTools.size === 0) {
    observation.unionStartedAt = startedAt;
    observation.unionToolCalls.clear();
    observation.unionMetadata = metadataWithResponse(
      metadata,
      observation.lastModel ?? metadata.model,
      observation.lastResponseId
    );
  }
  observation.activeTools.set(toolCallId, toolName);
  observation.unionToolCalls.set(toolCallId, toolName);
}

function handleToolEnd(
  state: PatchState,
  observation: SessionObservation,
  event: Record<PropertyKey, unknown>
): void {
  const toolCallId = asString(event.toolCallId);
  if (!toolCallId || !observation.activeTools.has(toolCallId)) return;
  observation.activeTools.delete(toolCallId);
  if (observation.activeTools.size > 0) return;

  const startedAt = observation.unionStartedAt ?? readNow(state);
  const endedAt = Math.max(startedAt, readNow(state));
  const metadata = observation.unionMetadata ?? {};
  const toolCalls = Object.freeze(
    [...observation.unionToolCalls.entries()].map(([id, name]) =>
      Object.freeze({
        toolCallId: id,
        ...(name ? { toolName: name } : {}),
      })
    )
  );
  observation.unionStartedAt = undefined;
  observation.unionMetadata = undefined;
  observation.unionToolCalls.clear();

  dispatchEvent(
    state,
    Object.freeze({
      type: 'tool_interval' as const,
      ...metadata,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      toolCalls,
    })
  );
}

function handleSessionEvent(
  state: PatchState,
  observation: SessionObservation,
  eventValue: unknown
): void {
  if (!state.active || state.subscribers.size === 0) {
    resetObservation(observation, state.generation);
    return;
  }
  if (observation.generation !== state.generation) {
    resetObservation(observation, state.generation);
  }

  const session = observation.sessionRef.deref();
  if (!session) return;
  const metadata = readSessionMetadata(state, session);
  if (metadata.sessionId && state.rootSessionIds.has(metadata.sessionId)) {
    resetObservation(observation, state.generation);
    return;
  }

  try {
    const event = asRecord(eventValue);
    const type = event ? asString(event.type) : undefined;
    if (!event || !type) return;
    if (type === 'message_end') {
      handleAssistantMessageEnd(state, observation, metadata, event);
    } else if (type === 'tool_execution_start') {
      handleToolStart(state, observation, metadata, event);
    } else if (type === 'tool_execution_end') {
      handleToolEnd(state, observation, event);
    }
  } catch (error) {
    reportAll(state, 'event', error);
  }
}

function createSessionObservation(state: PatchState, session: object): SessionObservation {
  let observation: SessionObservation;
  const listener: SessionEventListener = (event) => {
    handleSessionEvent(state, observation, event);
  };
  observation = {
    generation: state.generation,
    subscribed: false,
    sessionRef: new WeakRef(session),
    listener,
    activeTools: new Map<string, string | undefined>(),
    unionToolCalls: new Map<string, string | undefined>(),
  };
  const ref = new WeakRef(observation);
  state.attachmentRefs.add(ref);
  state.attachmentFinalizer.register(observation, ref, observation);
  return observation;
}

function attachSession(state: PatchState, sessionValue: unknown): void {
  if (!isObject(sessionValue)) return;
  const session = sessionValue;
  const sessionId = asString(readSessionProperty(state, session, 'sessionId'));
  if (sessionId && state.rootSessionIds.has(sessionId)) return;

  let observation = state.sessions.get(session);
  if (!observation) {
    observation = createSessionObservation(state, session);
    state.sessions.set(session, observation);
  } else {
    observation.sessionRef = new WeakRef(session);
  }
  if (observation.subscribed) return;

  const subscribe = readSessionProperty(state, session, 'subscribe', 'attach');
  if (typeof subscribe !== 'function') {
    reportAll(
      state,
      'attach',
      new Error('AgentSession instance does not expose the public subscribe method.')
    );
    return;
  }

  resetObservation(observation, state.generation);
  try {
    const unsubscribe = Reflect.apply(subscribe, session, [observation.listener]);
    observation.unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : undefined;
    observation.subscribed = true;
  } catch (error) {
    reportAll(state, 'attach', error);
  }
}

function decrementRoot(state: PatchState, sessionId: string): void {
  const count = state.rootSessionIds.get(sessionId);
  if (count === undefined) return;
  if (count <= 1) state.rootSessionIds.delete(sessionId);
  else state.rootSessionIds.set(sessionId, count - 1);
}

function unavailableHandle(
  incompatibility: InProcessObserverIncompatibility
): InProcessAgentSessionObserverHandle {
  return {
    installed: false,
    incompatibility,
    addRootSessionId() {},
    removeRootSessionId() {},
    uninstall() {},
  };
}

export function installInProcessAgentSessionObserver(
  options: InProcessAgentSessionObserverOptions = {}
): InProcessAgentSessionObserverHandle {
  const callbacks: ObserverCallbacks = Object.freeze({
    onAssistantUsage: options.onAssistantUsage,
    onToolInterval: options.onToolInterval,
    onError: options.onError,
  });
  const agentSessionClass = options.dependencies?.AgentSession ?? AgentSession;
  const now = options.dependencies?.now ?? Date.now;
  const prototype = agentSessionClass?.prototype;
  if (!isObject(prototype)) {
    reportDirect(
      callbacks.onError,
      'install',
      new Error('The AgentSession class does not expose a compatible prototype.')
    );
    return unavailableHandle('agent-session-prototype');
  }

  const registry = getGlobalRegistry(callbacks.onError);
  if (!registry) return unavailableHandle('global-registry');

  let state = registry.patches.get(prototype);
  if (state && !isPatchState(state)) {
    reportDirect(
      callbacks.onError,
      'install',
      new Error('The existing AgentSession prototype observer is incompatible.')
    );
    return unavailableHandle('prototype-conflict');
  }

  if (!state) {
    const descriptor = readDescriptor(prototype);
    if (!descriptor || typeof descriptor.value !== 'function' || descriptor.writable !== true) {
      reportDirect(
        callbacks.onError,
        'install',
        new Error('AgentSession.prototype.prompt is not a writable public method.')
      );
      return unavailableHandle('prompt-descriptor');
    }
    if (typeof readPrototypeMethod(prototype, 'subscribe') !== 'function') {
      reportDirect(
        callbacks.onError,
        'install',
        new Error('AgentSession.prototype.subscribe is not a public method.')
      );
      return unavailableHandle('subscribe-method');
    }
    state = createPatchState(prototype, descriptor, now);
    registry.patches.set(prototype, state);
  }

  const patch = state;
  const incompatibility = activatePatch(patch, now, callbacks.onError);
  if (incompatibility) return unavailableHandle(incompatibility);

  const token = Symbol('pi-ledger-in-process-observer-subscriber');
  const subscriber: Subscriber = { callbacks, roots: new Set<string>() };
  patch.subscribers.set(token, subscriber);
  let uninstalled = false;

  const addRootSessionId = (sessionId: string): void => {
    if (uninstalled || !asString(sessionId) || subscriber.roots.has(sessionId)) return;
    subscriber.roots.add(sessionId);
    patch.rootSessionIds.set(sessionId, (patch.rootSessionIds.get(sessionId) ?? 0) + 1);
  };
  const removeRootSessionId = (sessionId: string): void => {
    if (uninstalled || !subscriber.roots.delete(sessionId)) return;
    decrementRoot(patch, sessionId);
  };

  if (options.rootSessionIds) {
    try {
      for (const sessionId of options.rootSessionIds) addRootSessionId(sessionId);
    } catch (error) {
      reportSubscriber(subscriber, 'install', error);
    }
  }

  return {
    installed: true,
    addRootSessionId,
    removeRootSessionId,
    uninstall(): void {
      if (uninstalled) return;
      uninstalled = true;
      for (const sessionId of subscriber.roots) decrementRoot(patch, sessionId);
      subscriber.roots.clear();
      patch.subscribers.delete(token);
      if (patch.subscribers.size === 0) deactivatePatch(patch, subscriber);
    },
  };
}
