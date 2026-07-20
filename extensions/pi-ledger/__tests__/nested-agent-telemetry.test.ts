import { describe, expect, it, vi } from 'vitest';
import {
  NESTED_AGENT_TELEMETRY_EVENT,
  NESTED_AGENT_TELEMETRY_LIMITS,
  NestedAgentTelemetryHarvester,
  harvestNestedAgentTelemetry,
  installNestedAgentTelemetryHarvester,
  type NestedAgentTelemetryObservation,
} from '../nested-agent-telemetry';

function byPath(
  observations: NestedAgentTelemetryObservation[],
  suffix: string
): NestedAgentTelemetryObservation {
  const observation = observations.find((candidate) => candidate.sourcePath.endsWith(suffix));
  expect(observation, `missing observation ending in ${suffix}`).toBeDefined();
  return observation!;
}

function usage(output: number, input = output * 2) {
  return {
    input,
    output,
    cacheRead: 3,
    cacheWrite: 2,
    totalTokens: input + output + 5,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

describe('NestedAgentTelemetryHarvester structural formats', () => {
  it('harvests the canonical Pi subagent aggregate and assistant usage', () => {
    const observations = harvestNestedAgentTelemetry({
      source: 'tool_execution_end.result',
      toolName: 'subagent',
      toolCallId: 'call-parent-1',
      value: {
        content: [{ type: 'text', text: 'raw child answer must not be retained' }],
        details: {
          mode: 'single',
          results: [
            {
              agent: 'scout',
              model: 'claude-sonnet-4-5',
              sessionFile: '/tmp/pi-child/session.jsonl',
              usage: {
                input: 120,
                output: 30,
                cacheRead: 4,
                cacheWrite: 1,
                cost: 0.012,
                turns: 1,
              },
              messages: [
                {
                  role: 'assistant',
                  provider: 'anthropic',
                  model: 'claude-sonnet-4-5',
                  responseId: 'resp-canonical-1',
                  timestamp: 1_700_000_000_000,
                  content: [{ type: 'text', text: 'private response prose' }],
                  usage: usage(28, 110),
                },
              ],
            },
          ],
        },
      },
    });

    expect(observations).toHaveLength(2);
    const aggregate = byPath(observations, 'details.results[0].usage');
    expect(aggregate).toMatchObject({
      outputTokens: 30,
      inputTokens: 120,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      costUsd: 0.012,
      model: 'claude-sonnet-4-5',
      toolCallId: 'call-parent-1',
      sessionFile: '/tmp/pi-child/session.jsonl',
      measurement: 'cumulative',
      cumulative: true,
      confidence: 'high',
      childAgentCorroborated: true,
      billingEligible: false,
    });
    expect(aggregate.identityCandidates).toContainEqual({ kind: 'agent', value: 'scout' });

    const assistant = byPath(observations, 'details.results[0].messages[0].usage');
    expect(assistant).toMatchObject({
      outputTokens: 28,
      inputTokens: 110,
      totalTokens: 143,
      costUsd: 0.003,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      responseId: 'resp-canonical-1',
      timestamp: 1_700_000_000_000,
      measurement: 'delta',
      cumulative: false,
      confidence: 'high',
    });
    expect(JSON.stringify(observations)).not.toContain('private response prose');
    expect(JSON.stringify(observations)).not.toContain('raw child answer');
  });

  it('recognizes pi-subagents totalChildUsage, results usage, and safe artifact metadata', () => {
    const harvester = new NestedAgentTelemetryHarvester();
    const partial = {
      content: [{ type: 'text', text: 'Subagents running' }],
      details: {
        mode: 'parallel',
        runId: 'run-subagents-42',
        totalChildUsage: {
          input: 300,
          output: 80,
          cacheRead: 20,
          cacheWrite: 10,
          cost: 0.08,
          turns: 3,
        },
        results: [
          {
            agent: 'reviewer',
            model: 'openai/gpt-5.4',
            sessionFile: '/tmp/subagents/reviewer.jsonl',
            artifactPaths: {
              inputPath: '/tmp/subagents/input.md',
              outputPath: '/tmp/subagents/output.md',
              jsonlPath: '/tmp/subagents/events.jsonl',
              transcriptPath: '/tmp/subagents/transcript.md',
              metadataPath: '/tmp/subagents/metadata.json',
            },
            usage: {
              input: 180,
              output: 45,
              cacheRead: 8,
              cacheWrite: 4,
              cost: 0.045,
              turns: 2,
            },
          },
        ],
      },
    };

    const first = harvester.harvest({
      source: 'tool_execution_update.partialResult',
      toolName: 'subagent',
      toolCallId: 'call-subagents',
      value: partial,
    });
    expect(first).toHaveLength(2);
    expect(byPath(first, 'details.totalChildUsage')).toMatchObject({
      runId: 'run-subagents-42',
      outputTokens: 80,
      costUsd: 0.08,
      confidence: 'high',
      measurement: 'cumulative',
    });
    expect(byPath(first, 'details.results[0].usage')).toMatchObject({
      runId: 'run-subagents-42',
      outputTokens: 45,
      artifactPath: '/tmp/subagents/output.md',
      sessionFile: '/tmp/subagents/reviewer.jsonl',
    });

    expect(
      harvester.harvest({
        source: 'tool_execution_end.result',
        toolName: 'subagent',
        toolCallId: 'call-subagents',
        value: partial,
      })
    ).toEqual([]);

    const advanced = structuredClone(partial);
    advanced.details.totalChildUsage.output = 90;
    expect(
      harvester.harvest({
        source: 'tool_execution_update.partialResult',
        toolName: 'subagent',
        toolCallId: 'call-subagents',
        value: advanced,
      })
    ).toEqual([
      expect.objectContaining({
        sourcePath: expect.stringContaining('totalChildUsage'),
        outputTokens: 90,
      }),
    ]);
  });

  it('accepts pi-agents run-event metadata with inputTokens/outputTokens/cost', () => {
    const observations = harvestNestedAgentTelemetry({
      source: 'artifact.metadata',
      customType: 'pi-agents:run-event:v3',
      artifactPath: '/tmp/pi-agents/parent.pi-agents.jsonl',
      value: {
        type: 'node_completed',
        at: 1_700_000_010_000,
        runId: 'workflow-run-7',
        path: '$.branches.review',
        instance: '$.branches.review@0',
        agent: 'reviewer',
        sessionFile: '/tmp/pi-agents/reviewer.jsonl',
        usage: {
          inputTokens: 900,
          outputTokens: 111,
          cost: 0.07,
        },
      },
    });

    expect(observations).toEqual([
      expect.objectContaining({
        source: 'artifact.metadata',
        sourcePath: 'artifact.metadata.usage',
        runId: 'workflow-run-7',
        outputTokens: 111,
        inputTokens: 900,
        costUsd: 0.07,
        artifactPath: '/tmp/pi-agents/parent.pi-agents.jsonl',
        sessionFile: '/tmp/pi-agents/reviewer.jsonl',
        confidence: 'high',
        childAgentCorroborated: true,
      }),
    ]);
  });

  it('normalizes pi-tidy flattened child counters and observed runtime identity', () => {
    const observations = harvestNestedAgentTelemetry({
      source: 'tool_execution_update.partialResult',
      toolName: 'subagent',
      toolCallId: 'tidy-call-1',
      value: {
        content: [{ type: 'text', text: 'Subagents running' }],
        details: {
          schemaVersion: 3,
          runId: 'tidy-run-1',
          runDir: '/tmp/tidy/run-1',
          children: [
            {
              id: 'child-001',
              target: 'tidy-run-1:child-001',
              agent: 'researcher',
              status: 'running',
              input: 75,
              output: 25,
              cacheRead: 6,
              cacheWrite: 4,
              providerTraffic: 110,
              tokens: 110,
              model: 'claude-sonnet-4-5',
              runtimePlan: {
                observed: {
                  provider: 'anthropic',
                  modelId: 'claude-sonnet-4-5',
                },
              },
              artifactPath: '/tmp/tidy/run-1/child-001.md',
              response: 'raw answer',
            },
          ],
        },
      },
    });

    expect(observations).toEqual([
      expect.objectContaining({
        sourcePath: 'tool_execution_update.partialResult.details.children[0]',
        runId: 'tidy-run-1',
        outputTokens: 25,
        inputTokens: 75,
        cacheReadTokens: 6,
        cacheWriteTokens: 4,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        artifactPath: '/tmp/tidy/run-1/child-001.md',
        measurement: 'cumulative',
        confidence: 'high',
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain('raw answer');
  });

  it('finds Fabric live audit agent results without trusting unrelated Fabric calls', () => {
    const observations = harvestNestedAgentTelemetry({
      source: 'tool_execution_update.partialResult',
      toolName: 'fabric_exec',
      toolCallId: 'fabric-parent-call',
      value: {
        content: [{ type: 'text', text: 'Calling agents.run' }],
        details: {
          progress: 'Calling agents.run',
          audits: [
            {
              ref: 'pi.read',
              provider: 'pi',
              tool: 'read',
              result: { usage: { input: 1, output: 999, cost: 100 } },
            },
            {
              ref: 'agents.run',
              provider: 'agents',
              tool: 'run',
              result: {
                id: 'fabric-child-1',
                name: 'security-review',
                status: 'completed',
                runner: 'pi',
                model: 'openai/gpt-5.4',
                sessionId: 'fabric-session-1',
                logFile: '/tmp/fabric/fabric-child-1/events.jsonl',
                usage: {
                  input: 400,
                  output: 123,
                  cacheRead: 20,
                  cacheWrite: 5,
                  cost: 0.12,
                },
              },
            },
          ],
        },
      },
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sourcePath: 'tool_execution_update.partialResult.details.audits[1].result.usage',
      runId: 'fabric-child-1',
      sessionId: 'fabric-session-1',
      toolCallId: 'fabric-parent-call',
      logFile: '/tmp/fabric/fabric-child-1/events.jsonl',
      outputTokens: 123,
      costUsd: 0.12,
      confidence: 'high',
      childAgentCorroborated: true,
    });
  });

  it('handles async completion custom-message details and suppresses their replay', () => {
    const harvester = new NestedAgentTelemetryHarvester();
    const completion = {
      runId: 'async-run-9',
      state: 'complete',
      results: [
        {
          agent: 'planner',
          sessionId: 'async-child-session',
          sessionFile: '/tmp/async/planner.jsonl',
          usage: {
            inputTokens: 250,
            outputTokens: 64,
            costUsd: 0.032,
          },
        },
      ],
    };
    const first = harvester.harvest({
      source: 'custom_message.details',
      customType: 'pi-subagents:async-complete',
      value: completion,
    });
    expect(first).toEqual([
      expect.objectContaining({
        runId: 'async-run-9',
        sessionId: 'async-child-session',
        outputTokens: 64,
        measurement: 'cumulative',
        confidence: 'high',
      }),
    ]);
    expect(
      harvester.harvest({
        source: 'custom_message.details',
        customType: 'pi-subagents:async-complete',
        value: structuredClone(completion),
      })
    ).toEqual([]);
  });
});

describe('NestedAgentTelemetryHarvester safety and deduplication', () => {
  it('does not invoke getters and survives cycles and hostile proxies', () => {
    let getterCalls = 0;
    const cyclic: Record<string, unknown> = {
      children: [
        {
          agent: 'safe-child',
          usage: { input: 20, output: 10, cost: 0.01 },
        },
      ],
    };
    Object.defineProperty(cyclic, 'trap', {
      enumerable: true,
      get() {
        getterCalls++;
        throw new Error('getter should not run');
      },
    });
    cyclic.self = cyclic;
    cyclic.hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('proxy ownKeys failed');
        },
      }
    );
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    (cyclic.children as unknown[]).push(revoked.proxy);

    const observations = harvestNestedAgentTelemetry({
      source: 'artifact.metadata',
      value: cyclic,
    });
    expect(getterCalls).toBe(0);
    expect(observations).toEqual([
      expect.objectContaining({ outputTokens: 10, confidence: 'medium' }),
    ]);
    expect(() =>
      harvestNestedAgentTelemetry({ source: 'artifact.metadata', value: revoked.proxy })
    ).not.toThrow();
  });

  it('does not invoke accessors on the harvest envelope', () => {
    let getterCalls = 0;
    const input = { source: 'artifact.metadata' } as Record<string, unknown>;
    Object.defineProperty(input, 'value', {
      enumerable: true,
      get() {
        getterCalls++;
        return { children: [{ agent: 'spoof', usage: { input: 2, output: 1 } }] };
      },
    });

    expect(new NestedAgentTelemetryHarvester().harvest(input as any)).toEqual([]);
    expect(getterCalls).toBe(0);
  });

  it('requires recognized provenance for plausible nested usage', () => {
    const validSpoof = {
      results: [{ agent: 'spoof', usage: { input: 10, output: 5, cost: 0.5 } }],
    };

    expect(
      harvestNestedAgentTelemetry({
        source: 'tool_execution_end.result',
        toolName: 'user-agent-reporter',
        value: validSpoof,
      })
    ).toEqual([]);
    expect(
      harvestNestedAgentTelemetry({
        source: 'custom_message.details',
        customType: 'user-agent-report',
        value: validSpoof,
      })
    ).toEqual([]);
    expect(
      harvestNestedAgentTelemetry({
        source: 'tool_execution_end.result',
        toolName: 'fabric_exec',
        value: {
          audits: [
            {
              ref: 'agents.run',
              provider: 'pi',
              tool: 'run',
              result: validSpoof.results[0],
            },
          ],
        },
      })
    ).toEqual([]);
    expect(
      harvestNestedAgentTelemetry({
        source: 'tool_execution_end.result',
        toolName: 'subagent',
        value: {
          results: [
            {
              agent: 'worker',
              messages: [
                {
                  role: 'user',
                  provider: 'openai',
                  model: 'gpt-5.4',
                  timestamp: 1_700_000_000_000,
                  usage: { input: 10, output: 5, cost: 0.5 },
                },
              ],
            },
          ],
        },
      })
    ).toEqual([]);
  });

  it('ignores raw text, sensitive branches, malformed numbers, and arbitrary root usage', () => {
    const harvester = new NestedAgentTelemetryHarvester();
    const observations = harvester.harvest({
      source: 'tool_execution_end.result',
      toolName: 'bash',
      toolCallId: 'bash-call',
      value: {
        usage: { input: 1, output: 500, cost: 10 },
        content: {
          children: [{ agent: 'spoof', usage: { input: 1, output: 900, cost: 90 } }],
        },
        apiKey: {
          children: [{ agent: 'secret', usage: { input: 1, output: 800, cost: 80 } }],
        },
        children: [
          { agent: 'negative', usage: { input: 1, output: -1, cost: 1 } },
          { agent: 'fractional', usage: { input: 1, output: 1.5, cost: 1 } },
          { agent: 'infinite', usage: { input: 1, output: Number.POSITIVE_INFINITY, cost: 1 } },
          { agent: 'string', usage: { input: 1, output: '1000', cost: 1 } },
        ],
      },
    });
    expect(observations).toEqual([]);

    const noCorroboration = harvester.harvest({
      source: 'tool_execution_end.result',
      toolName: 'bash',
      value: { usage: { input: 10, output: 5, cost: 0.5 } },
    });
    expect(noCorroboration).toEqual([]);
  });

  it('does not retain prose disguised as metadata or property names', () => {
    const privateModelText = 'private model prose must not survive';
    const privatePathKey = 'private response prose must not survive';
    const observations = harvestNestedAgentTelemetry({
      source: 'tool_execution_end.result',
      toolName: 'subagent',
      value: {
        results: [
          {
            agent: 'worker',
            model: privateModelText,
            [privatePathKey]: {
              input: 10,
              output: 5,
              cost: 0.01,
              provider: privateModelText,
            },
          },
        ],
      },
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).not.toHaveProperty('provider');
    expect(observations[0]).not.toHaveProperty('model');
    expect(JSON.stringify(observations)).not.toContain(privateModelText);
    expect(JSON.stringify(observations)).not.toContain(privatePathKey);
    expect(observations[0]!.sourcePath).toMatch(/\['#[0-9a-f]{8}'\]$/);
  });

  it('validates metadata paths lexically without reading them', () => {
    const observations = harvestNestedAgentTelemetry({
      source: 'artifact.metadata',
      customType: 'child-agent-completion',
      value: {
        runId: 'path-run',
        children: [
          {
            agent: 'worker',
            logFile: 'https://user:secret@example.test/events.jsonl',
            sessionFile: 'file:///tmp/session.jsonl',
            artifactPath: '/definitely/not/present/output.md',
            usage: { input: 10, output: 5, cost: 0.01 },
          },
        ],
      },
    });
    expect(observations[0]).toMatchObject({
      artifactPath: '/definitely/not/present/output.md',
    });
    expect(observations[0]).not.toHaveProperty('logFile');
    expect(observations[0]).not.toHaveProperty('sessionFile');
  });

  it('dedupes mirrored assistant responses by responseId before source path', () => {
    const harvester = new NestedAgentTelemetryHarvester();
    const assistant = (output: number) => ({
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-5.4',
      responseId: 'resp-shared',
      timestamp: 1_700_000_020_000,
      usage: usage(output, 40),
      content: [{ type: 'text', text: 'ignored' }],
    });
    const first = harvester.harvest({
      source: 'tool_execution_update.partialResult',
      toolName: 'subagent',
      value: {
        results: [
          { agent: 'a', messages: [assistant(10)] },
          { agent: 'b', messages: [assistant(10)] },
        ],
      },
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.responseId).toBe('resp-shared');

    const advanced = harvester.harvest({
      source: 'tool_execution_update.partialResult',
      toolName: 'subagent',
      value: { results: [{ agent: 'a', messages: [assistant(12)] }] },
    });
    expect(advanced).toEqual([expect.objectContaining({ outputTokens: 12 })]);

    const stale = harvester.harvest({
      source: 'tool_execution_end.result',
      toolName: 'subagent',
      value: { results: [{ agent: 'a', messages: [assistant(11)] }] },
    });
    expect(stale).toEqual([]);
  });

  it('accepts monotonic cumulative progress and rejects mixed regressions', () => {
    const harvester = new NestedAgentTelemetryHarvester();
    const result = (input: number, output: number) => ({
      runId: 'vector-run',
      results: [{ agent: 'worker', usage: { input, output, cost: 0.02 } }],
    });

    expect(
      harvester.harvest({
        source: 'tool_execution_update.partialResult',
        toolName: 'subagent',
        value: result(30, 15),
      })
    ).toHaveLength(1);
    expect(
      harvester.harvest({
        source: 'tool_execution_update.partialResult',
        toolName: 'subagent',
        value: result(35, 15),
      })
    ).toEqual([expect.objectContaining({ inputTokens: 35, outputTokens: 15 })]);
    expect(
      harvester.harvest({
        source: 'tool_execution_update.partialResult',
        toolName: 'subagent',
        value: result(34, 16),
      })
    ).toEqual([]);
  });

  it('does not dedupe unrelated observations that lack a stable identity', () => {
    const harvester = new NestedAgentTelemetryHarvester();
    const value = {
      children: [{ agent: 'worker', usage: { input: 10, output: 5, cost: 0.01 } }],
    };
    const harvest = () =>
      harvester.harvest({
        source: 'artifact.metadata',
        value: structuredClone(value),
      });

    expect(harvest()).toHaveLength(1);
    expect(harvest()).toHaveLength(1);
  });

  it('dedupes cumulative update/end/tool-result mirrors by run, session, and semantic path', () => {
    const harvester = new NestedAgentTelemetryHarvester();
    const details = {
      runId: 'stable-run',
      sessionId: 'stable-session',
      results: [{ agent: 'worker', usage: { input: 30, output: 15, cost: 0.02 } }],
    };
    expect(
      harvester.harvest({
        source: 'tool_execution_update.partialResult',
        toolName: 'subagent',
        toolCallId: 'stable-call',
        value: { details },
      })
    ).toHaveLength(1);
    expect(
      harvester.harvest({
        source: 'tool_execution_end.result',
        toolName: 'subagent',
        toolCallId: 'stable-call',
        value: { details: structuredClone(details) },
      })
    ).toEqual([]);
    expect(
      harvester.harvest({
        source: 'tool_result.details',
        toolName: 'subagent',
        toolCallId: 'stable-call',
        value: structuredClone(details),
      })
    ).toEqual([]);
  });

  it('bounds descriptor work, freezes limits, and byte-bounds short paths', () => {
    let descriptorReads = 0;
    const values: Record<string, number> = {
      outputTokens: 5,
      inputTokens: 10,
      ignoredA: 1,
      ignoredB: 2,
    };
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => Object.keys(values),
        getOwnPropertyDescriptor: (_target, key) => {
          descriptorReads++;
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: values[String(key)],
          };
        },
      }
    );
    const bounded = new NestedAgentTelemetryHarvester({ limits: { maxObjectKeys: 2 } });

    expect(
      bounded.harvest({
        source: 'tool_execution_end.result',
        toolName: 'subagent',
        value: proxy,
      })
    ).toEqual([expect.objectContaining({ inputTokens: 10, outputTokens: 5 })]);
    expect(descriptorReads).toBe(2);
    expect(Object.isFrozen(bounded.limits)).toBe(true);
    expect(Reflect.set(bounded.limits, 'maxNodes', Number.MAX_SAFE_INTEGER)).toBe(false);

    const shortPath = new NestedAgentTelemetryHarvester({ limits: { maxPathBytes: 1 } });
    const observations = shortPath.harvest({
      source: 'tool_execution_end.result',
      toolName: 'subagent',
      value: { outputTokens: 1 },
    });
    expect(observations).toHaveLength(1);
    expect(Buffer.byteLength(observations[0]!.sourcePath, 'utf8')).toBeLessThanOrEqual(1);
  });

  it('enforces depth, node, array, observation, string, and path limits', () => {
    const harvester = new NestedAgentTelemetryHarvester({
      limits: {
        maxDepth: 3,
        maxNodes: 12,
        maxArrayItems: 1,
        maxObjectKeys: 8,
        maxObservations: 1,
        maxStringBytes: 32,
        maxPathBytes: 80,
        maxIdentityCandidates: 2,
        maxDedupeEntries: 2,
      },
    });
    const tooDeep = { child: { child: { child: { usage: { input: 2, output: 1 } } } } };
    expect(
      harvester.harvest({
        source: 'artifact.metadata',
        customType: 'child-agent',
        value: tooDeep,
      })
    ).toEqual([]);

    const bounded = harvester.harvest({
      source: 'artifact.metadata',
      customType: 'child-agent',
      value: {
        children: [
          {
            agent: 'first',
            runId: 'run-first',
            sessionId: 'session-first',
            toolCallId: 'tool-first',
            usage: { input: 2, output: 1 },
          },
          { agent: 'second', usage: { input: 200, output: 100 } },
        ],
      },
    });
    expect(bounded).toHaveLength(1);
    expect(bounded[0]!.outputTokens).toBe(1);
    expect(bounded[0]!.identityCandidates.length).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(bounded[0]!.sourcePath, 'utf8')).toBeLessThanOrEqual(80);
  });

  it('publishes observations from Pi lifecycle surfaces without changing billing state', () => {
    const handlers = new Map<string, Array<(event: any) => void>>();
    const emit = vi.fn();
    const pi = {
      on: vi.fn((name: string, handler: (event: any) => void) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      }),
      events: { emit },
    } as any;
    installNestedAgentTelemetryHarvester(pi);

    for (const handler of handlers.get('message_end') ?? []) {
      handler({
        type: 'message_end',
        message: {
          role: 'custom',
          customType: 'pi-subagents:async-complete',
          content: 'raw completion text',
          details: {
            runId: 'event-run',
            results: [{ agent: 'worker', usage: { input: 8, output: 4, cost: 0.01 } }],
          },
        },
      });
    }

    let messageGetterCalls = 0;
    for (const handler of handlers.get('message_end') ?? []) {
      const event = {};
      Object.defineProperty(event, 'message', {
        enumerable: true,
        get() {
          messageGetterCalls++;
          throw new Error('message getter should not run');
        },
      });
      expect(() => handler(event)).not.toThrow();
    }

    expect(messageGetterCalls).toBe(0);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      NESTED_AGENT_TELEMETRY_EVENT,
      expect.objectContaining({
        source: 'custom_message.details',
        runId: 'event-run',
        outputTokens: 4,
        billingEligible: false,
      })
    );
  });
});

describe('nested telemetry public limits', () => {
  it('exposes finite conservative defaults', () => {
    expect(NESTED_AGENT_TELEMETRY_LIMITS).toEqual({
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
  });
});
