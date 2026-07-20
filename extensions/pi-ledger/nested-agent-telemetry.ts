import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const NESTED_AGENT_TELEMETRY_EVENT = 'pi-ledger:nested-agent-telemetry';

export const NESTED_AGENT_TELEMETRY_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 2_048,
  maxArrayItems: 64,
  maxObjectKeys: 96,
  maxObservations: 128,
  maxStringBytes: 512,
  maxPathBytes: 4_096,
  maxIdentityCandidates: 12,
  maxDedupeEntries: 2_048,
});

export interface NestedAgentTelemetryLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
  readonly maxObservations: number;
  readonly maxStringBytes: number;
  readonly maxPathBytes: number;
  readonly maxIdentityCandidates: number;
  readonly maxDedupeEntries: number;
}

export type NestedAgentTelemetrySource =
  | 'tool_execution_update.partialResult'
  | 'tool_execution_end.result'
  | 'tool_result.details'
  | 'tool_result_message.details'
  | 'custom_message.details'
  | 'artifact.metadata';

export type NestedAgentTelemetryConfidence = 'high' | 'medium' | 'low';
export type NestedAgentUsageMeasurement = 'cumulative' | 'delta';

export type NestedAgentIdentityKind =
  | 'responseId'
  | 'runId'
  | 'sessionId'
  | 'toolCallId'
  | 'agentId'
  | 'agent';

export interface NestedAgentIdentityCandidate {
  kind: NestedAgentIdentityKind;
  value: string;
}

/**
 * A bounded, metadata-only child-usage observation. It is intentionally not a
 * ledger billing event: future billing code must independently require
 * `childAgentCorroborated` and reconcile cumulative observations.
 */
export interface NestedAgentTelemetryObservation {
  version: 1;
  source: NestedAgentTelemetrySource;
  sourcePath: string;
  identityCandidates: NestedAgentIdentityCandidate[];
  measurement: NestedAgentUsageMeasurement;
  cumulative: boolean;
  confidence: NestedAgentTelemetryConfidence;
  childAgentCorroborated: boolean;
  billingEligible: false;
  outputTokens: number;
  inputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  provider?: string;
  model?: string;
  responseId?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  logFile?: string;
  sessionFile?: string;
  artifactPath?: string;
  timestamp?: number;
}

export interface NestedAgentTelemetryInput {
  source: NestedAgentTelemetrySource;
  value: unknown;
  toolName?: unknown;
  customType?: unknown;
  toolCallId?: unknown;
  sessionId?: unknown;
  artifactPath?: unknown;
}

export interface NestedAgentTelemetryHarvesterOptions {
  limits?: Partial<NestedAgentTelemetryLimits>;
  onObservation?: (observation: NestedAgentTelemetryObservation) => void;
}

interface UsageFields {
  outputTokens: number;
  inputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

interface Metadata {
  provider?: string;
  model?: string;
  responseId?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  agentId?: string;
  agent?: string;
  logFile?: string;
  sessionFile?: string;
  artifactPath?: string;
  timestamp?: number;
}

interface ScanItem {
  value: object;
  depth: number;
  relativePath: string;
  metadata: Metadata;
  evidence: number;
  parentKey?: string;
}

interface DataEntry {
  key: string;
  normalizedKey: string;
  value: unknown;
}

interface DedupeSnapshot extends UsageFields {
  fingerprint: string;
}

const EVIDENCE_SOURCE_AGENT = 1 << 0;
const EVIDENCE_RESULTS = 1 << 1;
const EVIDENCE_CHILDREN = 1 << 2;
const EVIDENCE_AGENT_IDENTITY = 1 << 3;
const EVIDENCE_ASSISTANT = 1 << 4;
const EVIDENCE_CHILD_TOTAL = 1 << 5;
const EVIDENCE_FABRIC_AGENT = 1 << 6;
const EVIDENCE_METADATA_SOURCE = 1 << 7;
const EVIDENCE_MESSAGES = 1 << 8;
const EVIDENCE_FABRIC_SOURCE = 1 << 9;

const HARD_LIMITS: NestedAgentTelemetryLimits = {
  maxDepth: 32,
  maxNodes: 32_768,
  maxArrayItems: 1_024,
  maxObjectKeys: 1_024,
  maxObservations: 2_048,
  maxStringBytes: 4_096,
  maxPathBytes: 16_384,
  maxIdentityCandidates: 64,
  maxDedupeEntries: 32_768,
};

const TELEMETRY_SOURCES = new Set<NestedAgentTelemetrySource>([
  'tool_execution_update.partialResult',
  'tool_execution_end.result',
  'tool_result.details',
  'tool_result_message.details',
  'custom_message.details',
  'artifact.metadata',
]);

const AGENT_TOOL_NAMES = new Set([
  'agent',
  'agents',
  'delegate',
  'delegation',
  'pi-agent',
  'pi-agents',
  'pi-subagent',
  'pi-subagents',
  'pi_agent',
  'pi_agents',
  'pi_subagent',
  'pi_subagents',
  'subagent',
  'subagents',
]);

const RAW_VALUE_KEYS = new Set([
  'content',
  'errormessage',
  'finaloutput',
  'outputtext',
  'prompt',
  'raw',
  'reasoning',
  'response',
  'stderr',
  'stdout',
  'summary',
  'task',
  'text',
  'thinking',
  'value',
]);

const MEDIA_KEYS = new Set(['audio', 'base64', 'image', 'images', 'media', 'video']);

const USAGE_CONTAINER_KEYS = new Set([
  'childusage',
  'cumulativeusage',
  'deltausage',
  'totalchildusage',
  'totalusage',
  'tokens',
  'usage',
  'usagecumulative',
  'usagedelta',
]);

const RESULT_CONTAINER_KEYS = new Set(['nodes', 'results', 'steps']);
const MESSAGE_CONTAINER_KEYS = new Set(['messages']);
const CHILD_CONTAINER_KEYS = new Set([
  'agents',
  'children',
  'nestedagents',
  'subagents',
  'workers',
]);

const RELEVANT_KEYS = new Set([
  ...USAGE_CONTAINER_KEYS,
  ...RESULT_CONTAINER_KEYS,
  ...CHILD_CONTAINER_KEYS,
  'action',
  'agent',
  'agentid',
  'agentname',
  'artifactpath',
  'artifactpaths',
  'artifacts',
  'asyncid',
  'audits',
  'cacheread',
  'cachereadtokens',
  'cachewrite',
  'cachewritetokens',
  'completiontokens',
  'cost',
  'costusd',
  'details',
  'id',
  'input',
  'inputtokens',
  'kind',
  'logfile',
  'messages',
  'metadata',
  'model',
  'modelid',
  'output',
  'outputtokens',
  'provider',
  'ref',
  'responseid',
  'result',
  'role',
  'runid',
  'runtimeplan',
  'sessionfile',
  'sessionid',
  'sessionpath',
  'target',
  'timestamp',
  'tool',
  'toolcallid',
  'total',
  'totaltokens',
]);

const TOKEN_LIMIT = 1_000_000_000_000;
const COST_LIMIT = 1_000_000_000;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const keyName = normalizedKey(key);
  if (keyName === 'token') return true;
  if (keyName.endsWith('token') && !keyName.endsWith('tokens')) return true;
  return [
    'apikey',
    'authorization',
    'clientsecret',
    'cookie',
    'credential',
    'credentials',
    'password',
    'passwd',
    'privatekey',
    'secret',
  ].some((sensitive) => keyName === sensitive || keyName.endsWith(sensitive));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const ellipsis = '…';
  const suffix = byteLength(ellipsis) <= maxBytes ? ellipsis : '';
  const available = maxBytes - byteLength(suffix);
  let result = '';
  let used = 0;
  for (const character of value) {
    const characterBytes = byteLength(character);
    if (used + characterBytes > available) break;
    result += character;
    used += characterBytes;
  }
  return `${result}${suffix}`;
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value
    : undefined;
}

function boundedCost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= COST_LIMIT
    ? value
    : undefined;
}

function configuredLimit(
  requested: number | undefined,
  fallback: number,
  hardMaximum: number
): number {
  if (!Number.isSafeInteger(requested) || requested === undefined || requested < 1) {
    return fallback;
  }
  return Math.min(requested, hardMaximum);
}

function resolveLimits(
  requested: Partial<NestedAgentTelemetryLimits> | undefined
): NestedAgentTelemetryLimits {
  return {
    maxDepth: configuredLimit(
      requested?.maxDepth,
      NESTED_AGENT_TELEMETRY_LIMITS.maxDepth,
      HARD_LIMITS.maxDepth
    ),
    maxNodes: configuredLimit(
      requested?.maxNodes,
      NESTED_AGENT_TELEMETRY_LIMITS.maxNodes,
      HARD_LIMITS.maxNodes
    ),
    maxArrayItems: configuredLimit(
      requested?.maxArrayItems,
      NESTED_AGENT_TELEMETRY_LIMITS.maxArrayItems,
      HARD_LIMITS.maxArrayItems
    ),
    maxObjectKeys: configuredLimit(
      requested?.maxObjectKeys,
      NESTED_AGENT_TELEMETRY_LIMITS.maxObjectKeys,
      HARD_LIMITS.maxObjectKeys
    ),
    maxObservations: configuredLimit(
      requested?.maxObservations,
      NESTED_AGENT_TELEMETRY_LIMITS.maxObservations,
      HARD_LIMITS.maxObservations
    ),
    maxStringBytes: configuredLimit(
      requested?.maxStringBytes,
      NESTED_AGENT_TELEMETRY_LIMITS.maxStringBytes,
      HARD_LIMITS.maxStringBytes
    ),
    maxPathBytes: configuredLimit(
      requested?.maxPathBytes,
      NESTED_AGENT_TELEMETRY_LIMITS.maxPathBytes,
      HARD_LIMITS.maxPathBytes
    ),
    maxIdentityCandidates: configuredLimit(
      requested?.maxIdentityCandidates,
      NESTED_AGENT_TELEMETRY_LIMITS.maxIdentityCandidates,
      HARD_LIMITS.maxIdentityCandidates
    ),
    maxDedupeEntries: configuredLimit(
      requested?.maxDedupeEntries,
      NESTED_AGENT_TELEMETRY_LIMITS.maxDedupeEntries,
      HARD_LIMITS.maxDedupeEntries
    ),
  };
}

function safeArray(value: object): boolean | undefined {
  try {
    return Array.isArray(value);
  } catch {
    return undefined;
  }
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedPropertyKey(key: string, limits: NestedAgentTelemetryLimits): boolean {
  if (byteLength(key) > limits.maxStringBytes) return false;
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function objectEntries(value: object, limits: NestedAgentTelemetryLimits): DataEntry[] {
  const isArray = safeArray(value);
  if (isArray === undefined) return [];
  if (isArray) {
    const length = boundedInteger(ownDataProperty(value, 'length'), Number.MAX_SAFE_INTEGER) ?? 0;
    const entries: DataEntry[] = [];
    const count = Math.min(length, limits.maxArrayItems);
    for (let index = 0; index < count; index++) {
      const key = String(index);
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor) {
          entries.push({ key, normalizedKey: key, value: descriptor.value });
        }
      } catch {
        // A hostile proxy can fail individual descriptor reads.
      }
    }
    return entries;
  }

  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    return [];
  }

  const entries: DataEntry[] = [];
  for (const key of ownKeys.slice(0, limits.maxObjectKeys)) {
    if (typeof key !== 'string' || !boundedPropertyKey(key, limits)) continue;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) continue;
      entries.push({ key, normalizedKey: normalizedKey(key), value: descriptor.value });
    } catch {
      // Skip getters, revoked proxies, and inconsistent descriptors.
    }
  }
  entries.sort((left, right) => {
    const leftPriority = RELEVANT_KEYS.has(left.normalizedKey) ? 0 : 1;
    const rightPriority = RELEVANT_KEYS.has(right.normalizedKey) ? 0 : 1;
    return leftPriority - rightPriority || left.key.localeCompare(right.key);
  });
  return entries;
}

function entryValue(entries: DataEntry[], ...keys: string[]): unknown {
  for (const key of keys) {
    const found = entries.find((entry) => entry.normalizedKey === key);
    if (found) return found.value;
  }
  return undefined;
}

function boundedString(value: unknown, limits: NestedAgentTelemetryLimits): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (byteLength(value) > limits.maxStringBytes) return undefined;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return undefined;
  }
  return value;
}

function structuralIdentifier(
  value: unknown,
  limits: NestedAgentTelemetryLimits
): string | undefined {
  const candidate = boundedString(value, limits);
  if (!candidate || candidate.length > 512) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+~-]*$/.test(candidate)) return undefined;
  return candidate;
}

function safeLocalPath(value: unknown, limits: NestedAgentTelemetryLimits): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (byteLength(value) > limits.maxPathBytes || value.includes('\0')) return undefined;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return undefined;
  }
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(value);
  if (!isWindowsPath && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return undefined;
  if (value.startsWith('//') || value.startsWith('\\\\')) return undefined;
  return value;
}

function timestampValue(value: unknown, limits: NestedAgentTelemetryLimits): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  const text = boundedString(value, limits);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function recognizedAgentToolName(value: unknown, limits: NestedAgentTelemetryLimits): boolean {
  const name = boundedString(value, limits)?.toLowerCase();
  return name !== undefined && AGENT_TOOL_NAMES.has(name);
}

function recognizedAgentCustomType(value: unknown, limits: NestedAgentTelemetryLimits): boolean {
  const customType = boundedString(value, limits)?.toLowerCase();
  if (!customType) return false;
  return (
    /^(?:(?:pi|child|nested)[-_:])?(?:agent|agents|subagent|subagents)(?:[-_:][a-z0-9][a-z0-9._+~-]*)*$/.test(
      customType
    ) || /^pi[-_:]tidy(?:[-_:][a-z0-9][a-z0-9._+~-]*)*$/.test(customType)
  );
}

function mergeMetadata(parent: Metadata, local: Metadata): Metadata {
  return {
    ...parent,
    ...Object.fromEntries(
      Object.entries(local).filter(
        (entry): entry is [string, string | number] => entry[1] !== undefined
      )
    ),
  };
}

function modelMetadata(
  value: unknown,
  limits: NestedAgentTelemetryLimits
): Pick<Metadata, 'provider' | 'model'> {
  const direct = structuralIdentifier(value, limits);
  if (direct) return { model: direct };
  if (typeof value !== 'object' || value === null) return {};
  const entries = objectEntries(value, limits);
  const provider = structuralIdentifier(entryValue(entries, 'provider'), limits);
  const model = structuralIdentifier(entryValue(entries, 'model', 'modelid', 'id'), limits);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function nestedRuntimeMetadata(
  value: unknown,
  limits: NestedAgentTelemetryLimits
): Pick<Metadata, 'provider' | 'model'> {
  if (typeof value !== 'object' || value === null) return {};
  const entries = objectEntries(value, limits);
  const observed = entryValue(entries, 'observed');
  if (typeof observed === 'object' && observed !== null) {
    const observedEntries = objectEntries(observed, limits);
    const provider = structuralIdentifier(entryValue(observedEntries, 'provider'), limits);
    const model = structuralIdentifier(entryValue(observedEntries, 'modelid', 'model'), limits);
    if (provider || model) {
      return {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      };
    }
  }
  const provider = structuralIdentifier(entryValue(entries, 'provider'), limits);
  const model = structuralIdentifier(entryValue(entries, 'modelid', 'model'), limits);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function nestedPathMetadata(
  value: unknown,
  limits: NestedAgentTelemetryLimits
): Pick<Metadata, 'logFile' | 'sessionFile' | 'artifactPath'> {
  if (typeof value !== 'object' || value === null) return {};
  const entries = objectEntries(value, limits);
  const logFile = safeLocalPath(entryValue(entries, 'logfile'), limits);
  const sessionFile = safeLocalPath(entryValue(entries, 'sessionfile', 'sessionpath'), limits);
  const artifactPath = safeLocalPath(
    entryValue(
      entries,
      'artifactpath',
      'outputpath',
      'savedoutputpath',
      'structuredoutputpath',
      'transcriptpath',
      'metadatapath',
      'jsonlpath',
      'path',
      'dir'
    ),
    limits
  );
  return {
    ...(logFile ? { logFile } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(artifactPath ? { artifactPath } : {}),
  };
}

function directMetadata(
  entries: DataEntry[],
  parent: Metadata,
  evidence: number,
  relativePath: string,
  limits: NestedAgentTelemetryLimits
): Metadata {
  const provider = structuralIdentifier(entryValue(entries, 'provider'), limits);
  const model = modelMetadata(entryValue(entries, 'model'), limits);
  const responseId = structuralIdentifier(entryValue(entries, 'responseid'), limits);
  const sessionId = structuralIdentifier(entryValue(entries, 'sessionid'), limits);
  const explicitRunId = structuralIdentifier(entryValue(entries, 'runid', 'asyncid'), limits);
  const toolCallId = structuralIdentifier(entryValue(entries, 'toolcallid'), limits);
  const agentId = structuralIdentifier(entryValue(entries, 'agentid', 'childid', 'target'), limits);
  const agent = structuralIdentifier(entryValue(entries, 'agent', 'agentname'), limits);
  const genericId = structuralIdentifier(entryValue(entries, 'id'), limits);
  const logFile = safeLocalPath(entryValue(entries, 'logfile'), limits);
  const sessionFile = safeLocalPath(entryValue(entries, 'sessionfile', 'sessionpath'), limits);
  const explicitArtifactPath = safeLocalPath(
    entryValue(
      entries,
      'artifactpath',
      'outputpath',
      'savedoutputpath',
      'structuredoutputpath',
      'transcriptpath'
    ),
    limits
  );
  const genericPath = /(?:^|\.)(?:artifact|artifacts|metadata)(?:\.|\[|$)/i.test(relativePath)
    ? safeLocalPath(entryValue(entries, 'path', 'dir'), limits)
    : undefined;
  const timestamp = timestampValue(
    entryValue(entries, 'timestamp', 'createdat', 'endedat', 'finishedat', 'updatedat'),
    limits
  );
  const runtimePlan = nestedRuntimeMetadata(entryValue(entries, 'runtimeplan'), limits);
  const nestedPaths = nestedPathMetadata(
    entryValue(entries, 'artifactpaths', 'artifacts', 'metadata'),
    limits
  );
  const inferredRunId =
    !explicitRunId &&
    !parent.runId &&
    genericId &&
    (evidence & (EVIDENCE_FABRIC_AGENT | EVIDENCE_CHILDREN | EVIDENCE_SOURCE_AGENT)) !== 0
      ? genericId
      : undefined;

  return mergeMetadata(parent, {
    ...(provider ? { provider } : {}),
    ...model,
    ...runtimePlan,
    ...(responseId ? { responseId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(explicitRunId || inferredRunId ? { runId: explicitRunId ?? inferredRunId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agent ? { agent } : {}),
    ...nestedPaths,
    ...(logFile ? { logFile } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(explicitArtifactPath || genericPath
      ? { artifactPath: explicitArtifactPath ?? genericPath }
      : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  });
}

function evidenceFromObject(
  entries: DataEntry[],
  inherited: number,
  limits: NestedAgentTelemetryLimits
): number {
  let evidence = inherited;
  const role = boundedString(entryValue(entries, 'role'), limits);
  const provider = structuralIdentifier(entryValue(entries, 'provider'), limits);
  const model = structuralIdentifier(entryValue(entries, 'model', 'modelid'), limits);
  const timestamp = timestampValue(entryValue(entries, 'timestamp'), limits);
  if (role === 'assistant' && provider && model && timestamp !== undefined) {
    evidence |= EVIDENCE_ASSISTANT;
  }
  if (
    structuralIdentifier(entryValue(entries, 'agent', 'agentid', 'agentname', 'childid'), limits) ||
    entryValue(entries, 'kind') === 'agent'
  ) {
    evidence |= EVIDENCE_AGENT_IDENTITY;
  }
  const ref = structuralIdentifier(entryValue(entries, 'ref'), limits)?.toLowerCase();
  const action = structuralIdentifier(entryValue(entries, 'action', 'tool'), limits)?.toLowerCase();
  if (
    (inherited & EVIDENCE_FABRIC_SOURCE) !== 0 &&
    ref === 'agents.run' &&
    provider?.toLowerCase() === 'agents' &&
    action === 'run'
  ) {
    evidence |= EVIDENCE_FABRIC_AGENT;
  }
  return evidence;
}

function nestedNumber(
  value: unknown,
  keys: string[],
  maximum: number,
  limits: NestedAgentTelemetryLimits
): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const entries = objectEntries(value, limits);
  return boundedInteger(entryValue(entries, ...keys), maximum);
}

function costValue(value: unknown, limits: NestedAgentTelemetryLimits): number | undefined {
  const direct = boundedCost(value);
  if (direct !== undefined) return direct;
  if (typeof value !== 'object' || value === null) return undefined;
  const entries = objectEntries(value, limits);
  return boundedCost(entryValue(entries, 'total', 'costusd', 'usd'));
}

function parseUsage(
  entries: DataEntry[],
  parentKey: string | undefined,
  evidence: number,
  limits: NestedAgentTelemetryLimits
): UsageFields | undefined {
  const output = boundedInteger(
    entryValue(entries, 'output', 'outputtokens', 'completiontokens'),
    TOKEN_LIMIT
  );
  const tokenObject = entryValue(entries, 'tokens');
  const nestedOutput = nestedNumber(
    tokenObject,
    ['output', 'outputtokens', 'completiontokens'],
    TOKEN_LIMIT,
    limits
  );
  const outputTokens = output ?? nestedOutput;
  if (outputTokens === undefined) return undefined;

  const normalizedParent = parentKey ? normalizedKey(parentKey) : undefined;
  const explicitContainer = normalizedParent ? USAGE_CONTAINER_KEYS.has(normalizedParent) : false;
  const flattenedNames = entries.some((entry) =>
    ['inputtokens', 'outputtokens', 'completiontokens', 'costusd'].includes(entry.normalizedKey)
  );
  const flatChildUsage =
    (evidence &
      (EVIDENCE_RESULTS | EVIDENCE_CHILDREN | EVIDENCE_SOURCE_AGENT | EVIDENCE_FABRIC_AGENT)) !==
      0 &&
    entries.some((entry) => entry.normalizedKey === 'input') &&
    entries.some((entry) => entry.normalizedKey === 'output') &&
    entries.some((entry) =>
      [
        'cacheread',
        'cachewrite',
        'cost',
        'providertaffic',
        'providertraffic',
        'tokens',
        'turns',
      ].includes(entry.normalizedKey)
    );
  if (!explicitContainer && !flattenedNames && !flatChildUsage) return undefined;

  const inputTokens =
    boundedInteger(entryValue(entries, 'input', 'inputtokens', 'prompttokens'), TOKEN_LIMIT) ??
    nestedNumber(tokenObject, ['input', 'inputtokens', 'prompttokens'], TOKEN_LIMIT, limits);
  const totalTokens =
    boundedInteger(entryValue(entries, 'total', 'totaltokens'), TOKEN_LIMIT) ??
    nestedNumber(tokenObject, ['total', 'totaltokens'], TOKEN_LIMIT, limits);
  const cacheReadTokens = boundedInteger(
    entryValue(entries, 'cacheread', 'cachereadtokens'),
    TOKEN_LIMIT
  );
  const cacheWriteTokens = boundedInteger(
    entryValue(entries, 'cachewrite', 'cachewritetokens'),
    TOKEN_LIMIT
  );
  const costUsd = costValue(entryValue(entries, 'cost', 'costusd'), limits);
  return {
    outputTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function childEvidenceForKey(evidence: number, key: string): number {
  const normalized = normalizedKey(key);
  if (RESULT_CONTAINER_KEYS.has(normalized)) return evidence | EVIDENCE_RESULTS;
  if (CHILD_CONTAINER_KEYS.has(normalized)) return evidence | EVIDENCE_CHILDREN;
  if (MESSAGE_CONTAINER_KEYS.has(normalized)) return evidence | EVIDENCE_MESSAGES;
  if (normalized === 'totalchildusage' || normalized === 'childusage') {
    return evidence | EVIDENCE_CHILD_TOTAL;
  }
  return evidence;
}

function confidenceFor(evidence: number): {
  confidence: NestedAgentTelemetryConfidence;
  corroborated: boolean;
} | null {
  const fromAgentSource = (evidence & EVIDENCE_SOURCE_AGENT) !== 0;
  const fromMetadata = (evidence & EVIDENCE_METADATA_SOURCE) !== 0;
  const hasAgentIdentity = (evidence & EVIDENCE_AGENT_IDENTITY) !== 0;
  const inChildStructure = (evidence & (EVIDENCE_RESULTS | EVIDENCE_CHILDREN)) !== 0;
  const isAssistant = (evidence & EVIDENCE_ASSISTANT) !== 0;

  if ((evidence & EVIDENCE_MESSAGES) !== 0 && !isAssistant) return null;
  if ((evidence & EVIDENCE_FABRIC_AGENT) !== 0) {
    return { confidence: 'high', corroborated: true };
  }
  if (fromAgentSource && (evidence & EVIDENCE_CHILD_TOTAL) !== 0) {
    return { confidence: 'high', corroborated: true };
  }
  if (fromAgentSource && (hasAgentIdentity || (isAssistant && inChildStructure))) {
    return { confidence: 'high', corroborated: true };
  }
  if (fromMetadata && hasAgentIdentity && inChildStructure) {
    return { confidence: 'medium', corroborated: true };
  }
  if (fromAgentSource || (fromMetadata && isAssistant && inChildStructure)) {
    return { confidence: 'low', corroborated: false };
  }
  return null;
}

function measurementFor(
  parentKey: string | undefined,
  evidence: number
): NestedAgentUsageMeasurement {
  const normalized = parentKey ? normalizedKey(parentKey) : '';
  if (normalized.includes('delta') || (evidence & EVIDENCE_ASSISTANT) !== 0) return 'delta';
  return 'cumulative';
}

function sourcePath(
  source: NestedAgentTelemetrySource,
  relativePath: string,
  limits: NestedAgentTelemetryLimits
): string {
  const joined = relativePath ? `${source}.${relativePath}` : source;
  return truncateUtf8(joined, limits.maxPathBytes);
}

function hashedPathKey(key: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `#${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function childPath(
  parent: string,
  key: string,
  array: boolean,
  limits: NestedAgentTelemetryLimits
): string | undefined {
  const segment = array
    ? `[${key}]`
    : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
      ? parent
        ? `.${key}`
        : key
      : `['${hashedPathKey(key)}']`;
  const path = `${parent}${segment}`;
  return byteLength(path) <= limits.maxPathBytes ? path : undefined;
}

function canonicalDedupePath(relativePath: string): string {
  return relativePath
    .replace(/^details\./, '')
    .replace(/^message\.details\./, '')
    .replace(/\.details\./g, '.');
}

function identityCandidates(
  metadata: Metadata,
  limits: NestedAgentTelemetryLimits
): NestedAgentIdentityCandidate[] {
  const candidates: NestedAgentIdentityCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: NestedAgentIdentityKind, value: string | undefined) => {
    if (!value || candidates.length >= limits.maxIdentityCandidates) return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, value });
  };
  add('responseId', metadata.responseId);
  add('runId', metadata.runId);
  add('sessionId', metadata.sessionId);
  add('toolCallId', metadata.toolCallId);
  add('agentId', metadata.agentId);
  add('agent', metadata.agent);
  return candidates;
}

function usageFingerprint(observation: NestedAgentTelemetryObservation): string {
  return [
    observation.outputTokens,
    observation.inputTokens ?? '',
    observation.totalTokens ?? '',
    observation.cacheReadTokens ?? '',
    observation.cacheWriteTokens ?? '',
    observation.costUsd ?? '',
  ].join(':');
}

function dedupeSnapshot(observation: NestedAgentTelemetryObservation): DedupeSnapshot {
  return {
    outputTokens: observation.outputTokens,
    ...(observation.inputTokens !== undefined ? { inputTokens: observation.inputTokens } : {}),
    ...(observation.totalTokens !== undefined ? { totalTokens: observation.totalTokens } : {}),
    ...(observation.cacheReadTokens !== undefined
      ? { cacheReadTokens: observation.cacheReadTokens }
      : {}),
    ...(observation.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: observation.cacheWriteTokens }
      : {}),
    ...(observation.costUsd !== undefined ? { costUsd: observation.costUsd } : {}),
    fingerprint: usageFingerprint(observation),
  };
}

function cumulativeProgress(previous: DedupeSnapshot, current: DedupeSnapshot): boolean {
  const fields = [
    'outputTokens',
    'inputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd',
  ] as const;
  let advanced = false;
  for (const field of fields) {
    const previousValue = previous[field];
    const currentValue = current[field];
    if (currentValue === undefined) {
      if (previousValue !== undefined) return false;
      continue;
    }
    if (previousValue === undefined) {
      advanced = true;
      continue;
    }
    if (currentValue < previousValue) return false;
    if (currentValue > previousValue) advanced = true;
  }
  return advanced;
}

function safeTelemetryInput(input: unknown): NestedAgentTelemetryInput | undefined {
  const source = ownDataProperty(input, 'source');
  if (typeof source !== 'string' || !TELEMETRY_SOURCES.has(source as NestedAgentTelemetrySource)) {
    return undefined;
  }
  return {
    source: source as NestedAgentTelemetrySource,
    value: ownDataProperty(input, 'value'),
    toolName: ownDataProperty(input, 'toolName'),
    customType: ownDataProperty(input, 'customType'),
    toolCallId: ownDataProperty(input, 'toolCallId'),
    sessionId: ownDataProperty(input, 'sessionId'),
    artifactPath: ownDataProperty(input, 'artifactPath'),
  };
}

function safeMessageEnvelope(message: unknown): {
  role?: string;
  customType?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  details?: unknown;
} {
  const role = ownDataProperty(message, 'role');
  return {
    ...(typeof role === 'string' ? { role } : {}),
    customType: ownDataProperty(message, 'customType'),
    toolCallId: ownDataProperty(message, 'toolCallId'),
    toolName: ownDataProperty(message, 'toolName'),
    details: ownDataProperty(message, 'details'),
  };
}

/**
 * Structural scanner for untrusted extension/tool metadata. It never reads an
 * artifact path, invokes an accessor, or retains raw model/tool text.
 */
export class NestedAgentTelemetryHarvester {
  readonly limits: NestedAgentTelemetryLimits;
  private readonly onObservation:
    | ((observation: NestedAgentTelemetryObservation) => void)
    | undefined;
  private readonly dedupe = new Map<string, DedupeSnapshot>();

  constructor(options: NestedAgentTelemetryHarvesterOptions = {}) {
    this.limits = Object.freeze(resolveLimits(options.limits));
    this.onObservation = options.onObservation;
  }

  reset(): void {
    this.dedupe.clear();
  }

  harvest(input: NestedAgentTelemetryInput): NestedAgentTelemetryObservation[] {
    try {
      const safeInput = safeTelemetryInput(input);
      return safeInput ? this.harvestUnchecked(safeInput) : [];
    } catch {
      return [];
    }
  }

  private harvestUnchecked(input: NestedAgentTelemetryInput): NestedAgentTelemetryObservation[] {
    if (typeof input.value !== 'object' || input.value === null) return [];
    const rootIsArray = safeArray(input.value);
    if (rootIsArray === undefined) return [];

    const toolName = boundedString(input.toolName, this.limits)?.toLowerCase();
    let evidence = input.source === 'artifact.metadata' ? EVIDENCE_METADATA_SOURCE : 0;
    if (
      recognizedAgentToolName(input.toolName, this.limits) ||
      recognizedAgentCustomType(input.customType, this.limits)
    ) {
      evidence |= EVIDENCE_SOURCE_AGENT;
    }
    if (toolName === 'fabric_exec') evidence |= EVIDENCE_FABRIC_SOURCE;

    const toolCallId = structuralIdentifier(input.toolCallId, this.limits);
    const sessionId = structuralIdentifier(input.sessionId, this.limits);
    const artifactPath = safeLocalPath(input.artifactPath, this.limits);
    const initialMetadata: Metadata = {
      ...(toolCallId ? { toolCallId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(artifactPath ? { artifactPath } : {}),
    };
    const queue: ScanItem[] = [
      {
        value: input.value,
        depth: 0,
        relativePath: '',
        metadata: initialMetadata,
        evidence,
      },
    ];
    const visited = new WeakSet<object>();
    const observations: NestedAgentTelemetryObservation[] = [];
    let queueIndex = 0;
    let nodes = 0;

    while (
      queueIndex < queue.length &&
      nodes < this.limits.maxNodes &&
      observations.length < this.limits.maxObservations
    ) {
      const item = queue[queueIndex++];
      if (!item) break;
      nodes++;
      try {
        if (visited.has(item.value)) continue;
        visited.add(item.value);
      } catch {
        continue;
      }
      const entries = objectEntries(item.value, this.limits);
      if (entries.length === 0) continue;
      const objectEvidence = evidenceFromObject(entries, item.evidence, this.limits);
      const metadata = directMetadata(
        entries,
        item.metadata,
        objectEvidence,
        item.relativePath,
        this.limits
      );
      const usage = parseUsage(entries, item.parentKey, objectEvidence, this.limits);
      if (usage) {
        const confidence = confidenceFor(objectEvidence);
        if (confidence) {
          const measurement = measurementFor(item.parentKey, objectEvidence);
          const observation: NestedAgentTelemetryObservation = {
            version: 1,
            source: input.source,
            sourcePath: sourcePath(input.source, item.relativePath, this.limits),
            identityCandidates: identityCandidates(metadata, this.limits),
            measurement,
            cumulative: measurement === 'cumulative',
            confidence: confidence.confidence,
            childAgentCorroborated: confidence.corroborated,
            billingEligible: false,
            ...usage,
            ...(metadata.provider ? { provider: metadata.provider } : {}),
            ...(metadata.model ? { model: metadata.model } : {}),
            ...(metadata.responseId ? { responseId: metadata.responseId } : {}),
            ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {}),
            ...(metadata.runId ? { runId: metadata.runId } : {}),
            ...(metadata.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
            ...(metadata.logFile ? { logFile: metadata.logFile } : {}),
            ...(metadata.sessionFile ? { sessionFile: metadata.sessionFile } : {}),
            ...(metadata.artifactPath ? { artifactPath: metadata.artifactPath } : {}),
            ...(metadata.timestamp !== undefined ? { timestamp: metadata.timestamp } : {}),
          };
          if (this.acceptObservation(observation, canonicalDedupePath(item.relativePath))) {
            observations.push(observation);
            try {
              this.onObservation?.(observation);
            } catch {
              // Telemetry consumers must not affect tool execution.
            }
          }
        }
      }

      if (item.depth >= this.limits.maxDepth) continue;
      const parentIsArray = safeArray(item.value) === true;
      for (const entry of entries) {
        if (isSensitiveKey(entry.key) || MEDIA_KEYS.has(entry.normalizedKey)) continue;
        if (RAW_VALUE_KEYS.has(entry.normalizedKey)) continue;
        if (typeof entry.value !== 'object' || entry.value === null) continue;
        const entryIsArray = safeArray(entry.value);
        if (entryIsArray === undefined) continue;
        const nextPath = childPath(item.relativePath, entry.key, parentIsArray, this.limits);
        if (nextPath === undefined) continue;
        if (queue.length >= this.limits.maxNodes) break;
        const nextEvidence = childEvidenceForKey(objectEvidence, entry.key);
        queue.push({
          value: entry.value,
          depth: item.depth + 1,
          relativePath: nextPath,
          metadata,
          evidence: nextEvidence,
          parentKey: entry.key,
        });
      }
    }
    return observations;
  }

  private acceptObservation(
    observation: NestedAgentTelemetryObservation,
    relativePath: string
  ): boolean {
    let stableIdentity: string | undefined;
    if (observation.responseId) {
      stableIdentity = `response:${observation.responseId}`;
    } else {
      const identifiers = [
        observation.runId ? `run:${observation.runId}` : '',
        observation.sessionId ? `session:${observation.sessionId}` : '',
        observation.toolCallId ? `tool:${observation.toolCallId}` : '',
      ].filter(Boolean);
      if (identifiers.length === 0) return true;
      stableIdentity = [...identifiers, `path:${relativePath}`].join('|');
    }

    const current = dedupeSnapshot(observation);
    const previous = this.dedupe.get(stableIdentity);
    const monotonic = observation.cumulative || observation.responseId !== undefined;
    if (previous) {
      if (previous.fingerprint === current.fingerprint) return false;
      if (monotonic && !cumulativeProgress(previous, current)) return false;
      this.dedupe.delete(stableIdentity);
    }
    this.dedupe.set(stableIdentity, current);
    while (this.dedupe.size > this.limits.maxDedupeEntries) {
      const oldest = this.dedupe.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.dedupe.delete(oldest);
    }
    return true;
  }
}

export function harvestNestedAgentTelemetry(
  input: NestedAgentTelemetryInput,
  options: NestedAgentTelemetryHarvesterOptions = {}
): NestedAgentTelemetryObservation[] {
  return new NestedAgentTelemetryHarvester(options).harvest(input);
}

/**
 * Attach the isolated harvester to Pi lifecycle metadata surfaces. The only
 * side effect is a shared event-bus observation; ledger totals and billing are
 * deliberately untouched.
 */
export function installNestedAgentTelemetryHarvester(
  pi: Pick<ExtensionAPI, 'on' | 'events'>,
  options: Omit<NestedAgentTelemetryHarvesterOptions, 'onObservation'> = {}
): NestedAgentTelemetryHarvester {
  const harvester = new NestedAgentTelemetryHarvester({
    ...options,
    onObservation: (observation) => {
      try {
        pi.events.emit(NESTED_AGENT_TELEMETRY_EVENT, observation);
      } catch {
        // Shared-bus listeners are observational and never load-bearing.
      }
    },
  });

  pi.on('session_start', () => {
    harvester.reset();
  });
  pi.on('tool_execution_update', (event) => {
    harvester.harvest({
      source: 'tool_execution_update.partialResult',
      value: ownDataProperty(event, 'partialResult'),
      toolName: ownDataProperty(event, 'toolName'),
      toolCallId: ownDataProperty(event, 'toolCallId'),
    });
  });
  pi.on('tool_execution_end', (event) => {
    harvester.harvest({
      source: 'tool_execution_end.result',
      value: ownDataProperty(event, 'result'),
      toolName: ownDataProperty(event, 'toolName'),
      toolCallId: ownDataProperty(event, 'toolCallId'),
    });
  });
  pi.on('tool_result', (event) => {
    harvester.harvest({
      source: 'tool_result.details',
      value: ownDataProperty(event, 'details'),
      toolName: ownDataProperty(event, 'toolName'),
      toolCallId: ownDataProperty(event, 'toolCallId'),
    });
  });
  pi.on('message_end', (event) => {
    const message = safeMessageEnvelope(ownDataProperty(event, 'message'));
    if (message.role !== 'custom' && message.role !== 'toolResult') return;
    harvester.harvest({
      source: message.role === 'custom' ? 'custom_message.details' : 'tool_result_message.details',
      value: message.details,
      customType: message.customType,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
    });
  });
  return harvester;
}
