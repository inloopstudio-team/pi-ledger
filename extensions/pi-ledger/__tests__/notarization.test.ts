import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GENESIS_PREV,
  canonicalJson,
  digestEvent,
  identityFromSeed,
  kidFromPublicKey,
  sealMessage,
  sidecarPathFor,
  verifySidecarChain,
  type AgentEvent,
  type ChainFields,
  type SessionCloseEvent,
  type SidecarEvent,
} from '../index';
import {
  activateExtension,
  createTestFixture,
  makeAssistantMessage,
  makeTpsTelemetry,
  type TestFixture,
} from './helpers';

// The receipt handler shells out to `open`/`xdg-open` — stub it (mirrors
// ledger.test.ts).
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

const SESSION_ID = '019fabcd-aaaa-bbbb-cccc-dddddddddddd';

describe('session notarization (hash chain + Ed25519 seal)', () => {
  let fixture: TestFixture;
  let cacheDir: string;
  let configDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-test-'));
    process.env.XDG_CACHE_HOME = cacheDir;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ledger-config-'));
    process.env.XDG_CONFIG_HOME = configDir;
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.PI_LEDGER_IDENTITY_B64;
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const sidecarFile = () => sidecarPathFor(SESSION_ID);
  const rawLines = (): string[] =>
    fs
      .readFileSync(sidecarFile(), 'utf8')
      .split('\n')
      .filter((l) => l.trim());
  const rawEvents = (): SidecarEvent[] => rawLines().map((l) => JSON.parse(l) as SidecarEvent);
  const writeRaw = (lines: string[]) => {
    fs.writeFileSync(sidecarFile(), lines.join('\n') + '\n');
  };

  type Chain = { kid: string; publicKeyRaw: Buffer };
  const chainKey = (): Chain => {
    const d = JSON.parse(
      fs.readFileSync(path.join(configDir, 'pi-ledger', 'identity.json'), 'utf8')
    ) as { kid: string; publicKey: string };
    return { kid: d.kid, publicKeyRaw: Buffer.from(d.publicKey, 'base64') };
  };
  const pubKeyObject = (publicKeyB64: string): crypto.KeyObject =>
    crypto.createPublicKey({
      format: 'jwk',
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(publicKeyB64, 'base64').toString('base64url'),
      },
    });
  const lastClose = (events: SidecarEvent[]): (SessionCloseEvent & ChainFields) | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === 'session-close') return e;
    }
    return undefined;
  };

  /** Drive one fallback-timed agent turn (appends one 'agent' event). */
  function driveFallbackTurn(turnIndex: number) {
    fixture.run('turn_start', { type: 'turn_start', turnIndex, timestamp: Date.now() });
    fixture.run('message_start', { type: 'message_start', message: makeAssistantMessage() });
    vi.advanceTimersByTime(2000);
    fixture.run('message_end', { type: 'message_end', message: makeAssistantMessage() });
    fixture.run('turn_end', { type: 'turn_end', turnIndex, timestamp: Date.now() });
  }

  /** seq strictly 0-based monotonic, prev == digest of the previous event as written. */
  function expectLinkage(events: SidecarEvent[]) {
    events.forEach((e, i) => {
      expect(e.seq, `event ${i} (${e.kind}) seq`).toBe(i);
      expect(e.prev, `event ${i} (${e.kind}) prev`).toBe(
        i === 0 ? GENESIS_PREV : digestEvent(events[i - 1])
      );
    });
  }

  function sealSignatureVerifies(
    close: SessionCloseEvent & ChainFields,
    publicKeyB64: string
  ): boolean {
    return crypto.verify(
      null,
      Buffer.from(sealMessage(close.sessionId, close.head), 'utf8'),
      pubKeyObject(publicKeyB64),
      Buffer.from(close.headSig, 'base64')
    );
  }

  describe('canonical form', () => {
    it('is JSON.stringify of a recursively key-sorted deep copy (arrays keep order, integral floats print as integers)', () => {
      expect(canonicalJson({ b: 1.0, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe(
        '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}'
      );
    });
    it('digestEvent is the sha256 hex of the canonical form', () => {
      const event = { b: 2, a: 1 };
      expect(digestEvent(event)).toMatch(/^[0-9a-f]{64}$/);
      expect(digestEvent(event)).toBe(
        crypto.createHash('sha256').update(canonicalJson(event), 'utf8').digest('hex')
      );
      // key order in the source object is irrelevant (canonical form sorts)
      expect(digestEvent({ a: 1, b: 2 })).toBe(digestEvent(event));
    });
  });

  describe('hash chain linkage', () => {
    it('continues seq/prev across appends, including supersede/correction events', () => {
      fixture.run('session_start', { type: 'session_start', reason: 'startup' });
      driveFallbackTurn(0); // fallback agent segment
      // pi-tps arrives later for the same turn → correction event (supersedes).
      fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ output: 500 }));

      const events = rawEvents();
      expect(events.map((e) => e.kind)).toEqual(['agent', 'agent']);
      const [fallback, tps] = events as [AgentEvent & ChainFields, AgentEvent & ChainFields];
      expect(fallback.source).toBe('fallback');
      expect(tps.source).toBe('tps');
      expect(tps.supersedes).toBe(fallback.id); // the correction links by id
      expectLinkage(events); // … and every kind links by seq/prev
    });
  });

  describe('session seal', () => {
    it('session_shutdown appends a signed session-close; the signature verifies with node crypto', () => {
      fixture.run('session_start', { type: 'session_start', reason: 'startup' });
      driveFallbackTurn(0);
      fixture.run('session_shutdown', { type: 'session_shutdown' });

      const events = rawEvents();
      expectLinkage(events);
      const close = lastClose(events);
      expect(close).toBeDefined();
      expect(close!.checkpoint).toBeUndefined();
      expect(close!.sessionId).toBe(SESSION_ID);
      // head === prev === digest of the previous event as written
      expect(close!.head).toBe(close!.prev);
      expect(close!.head).toBe(digestEvent(events[events.length - 2]));

      // Identity files: base64 32-byte seed (mode 0600) + {kid, publicKey}.
      const secretPath = path.join(configDir, 'pi-ledger', 'identity.secret');
      expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
      const seed = Buffer.from(fs.readFileSync(secretPath, 'utf8').trim(), 'base64');
      expect(seed.length).toBe(32);
      const descriptor = JSON.parse(
        fs.readFileSync(path.join(configDir, 'pi-ledger', 'identity.json'), 'utf8')
      ) as { kid: string; publicKey: string };
      expect(Buffer.from(descriptor.publicKey, 'base64').length).toBe(32);
      expect(descriptor.kid).toBe(kidFromPublicKey(Buffer.from(descriptor.publicKey, 'base64')));
      expect(identityFromSeed(seed).kid).toBe(descriptor.kid); // seed restores the same identity
      expect(close!.kid).toBe(descriptor.kid);

      // Verifies with the identity's public key; fails with a wrong key.
      expect(sealSignatureVerifies(close!, descriptor.publicKey)).toBe(true);
      const wrong = crypto.generateKeyPairSync('ed25519');
      const wrongX = wrong.publicKey.export({ format: 'jwk' }).x as string;
      expect(
        sealSignatureVerifies(close!, Buffer.from(wrongX, 'base64url').toString('base64'))
      ).toBe(false);

      const v = verifySidecarChain(events, chainKey());
      expect(v.status).toBe('sealed');
      expect(v.sigValid).toBe(true);
    });

    it('PI_LEDGER_IDENTITY_B64 overrides the on-disk identity (no files written)', () => {
      const seed = crypto.randomBytes(32);
      process.env.PI_LEDGER_IDENTITY_B64 = seed.toString('base64');
      const expected = identityFromSeed(seed);

      fixture.run('session_start', { type: 'session_start', reason: 'startup' });
      driveFallbackTurn(0);
      fixture.run('session_shutdown', { type: 'session_shutdown' });

      const close = lastClose(rawEvents());
      expect(close).toBeDefined();
      expect(close!.kid).toBe(expected.kid);
      expect(sealSignatureVerifies(close!, expected.publicKey)).toBe(true);
      // The override replaces the on-disk identity: nothing is materialized.
      expect(fs.existsSync(path.join(configDir, 'pi-ledger', 'identity.secret'))).toBe(false);
      expect(fs.existsSync(path.join(configDir, 'pi-ledger', 'identity.json'))).toBe(false);
    });
  });

  describe('tamper detection', () => {
    function buildSealedLog(): { events: SidecarEvent[]; key: Chain } {
      fixture.run('session_start', { type: 'session_start', reason: 'startup' });
      driveFallbackTurn(0);
      driveFallbackTurn(1);
      fixture.run('session_shutdown', { type: 'session_shutdown' });
      return { events: rawEvents(), key: chainKey() };
    }

    it('an untouched chained log verifies as sealed (baseline)', () => {
      const { events, key } = buildSealedLog();
      expectLinkage(events);
      expect(verifySidecarChain(events, key).status).toBe('sealed');
    });

    it('detects a byte edit mid-file', () => {
      const { key } = buildSealedLog();
      const events = rawEvents();
      (events[1] as AgentEvent).timestamp += 1; // edit the middle event
      writeRaw(events.map((e) => JSON.stringify(e)));
      expect(verifySidecarChain(rawEvents(), key).status).toBe('tampered');
    });

    it('detects a dropped line', () => {
      const { key } = buildSealedLog();
      const lines = rawLines();
      lines.splice(1, 1); // drop the middle event → seq gap
      writeRaw(lines);
      expect(verifySidecarChain(rawEvents(), key).status).toBe('tampered');
    });

    it('detects reordered lines', () => {
      const { key } = buildSealedLog();
      const lines = rawLines();
      [lines[0], lines[1]] = [lines[1]!, lines[0]!];
      writeRaw(lines);
      expect(verifySidecarChain(rawEvents(), key).status).toBe('tampered');
    });

    it('detects a signature failure (seal re-signed with the wrong key)', () => {
      const { events, key } = buildSealedLog();
      const close = lastClose(events)!;
      const wrong = crypto.generateKeyPairSync('ed25519');
      close.headSig = crypto
        .sign(null, Buffer.from(sealMessage(close.sessionId, close.head), 'utf8'), wrong.privateKey)
        .toString('base64');
      const v = verifySidecarChain(events, key);
      expect(v.status).toBe('tampered');
      expect(v.sigValid).toBe(false);
    });

    it('detects an unknown signing key (kid mismatch is unverifiable, never sealed)', () => {
      const { events, key } = buildSealedLog();
      expect(verifySidecarChain(events, { ...key, kid: 'f'.repeat(16) }).status).toBe('tampered');
      expect(verifySidecarChain(events, null).status).toBe('tampered'); // no key to verify with
    });

    it('detects a mixed log (chained tail over unchained events)', () => {
      const { events, key } = buildSealedLog();
      delete events[1]!.seq; // strip chain fields from a middle event
      delete events[1]!.prev;
      expect(verifySidecarChain(events, key).status).toBe('tampered');
    });
  });

  describe('legacy sidecars (pre-notarization)', () => {
    it('rehydrates, stays uniformly legacy (new appends unchained), and is never sealed', async () => {
      fixture.seedSidecar([
        {
          kind: 'settings',
          settings: {
            agentRatePerHour: 100,
            humanRatePerHour: 50,
            pomodoroMinutes: 20,
            referenceTps: 75,
            project: 'legacy-demo',
            author: 'tom',
            currency: 'USD',
            autoWizard: true,
            autoExtend: false,
          },
          timestamp: 0,
        },
        {
          kind: 'agent',
          id: 'a1',
          turnIndex: 0,
          agentMs: 3_600_000,
          generationMs: 3_600_000,
          stallMs: 0,
          toolMs: 0,
          tokens: { input: 0, output: 1500, total: 1500 },
          model: { provider: 'openai', modelId: 'gpt-4' },
          source: 'tps',
          timestamp: 1000,
        },
      ] as SidecarEvent[]);
      fixture.run('session_start', { type: 'session_start', reason: 'resume' });
      driveFallbackTurn(1); // a NEW append to the legacy log…
      fixture.run('session_shutdown', { type: 'session_shutdown' }); // …and no seal

      const events = rawEvents();
      expect(events.every((e) => e.seq === undefined && e.prev === undefined)).toBe(true);
      expect(events.some((e) => e.kind === 'session-close')).toBe(false);
      expect(verifySidecarChain(events, null).status).toBe('legacy');

      // No chain-broken noise for a legitimately legacy session…
      await fixture.commands['ledger']!.handler('', fixture.mockCtx);
      const ledgerMsg = String(fixture.notifySpy.mock.calls.at(-1)?.[0] ?? '');
      expect(ledgerMsg).not.toContain('chain broken');

      // …and the receipt renders an unattested footer.
      await fixture.commands['ledger-receipt']!.handler('', fixture.mockCtx);
      const dir = path.join(cacheDir, 'pi-ledger');
      const html = fs.readFileSync(
        path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.html'))!),
        'utf8'
      );
      expect(html).toContain('seal legacy');
      expect(html).toContain(`session ${SESSION_ID}`);
    });
  });

  describe('surfacing: /ledger and /ledger-receipt', () => {
    it('/ledger shows a chain broken marker when the sidecar is tampered', async () => {
      fixture.run('session_start', { type: 'session_start', reason: 'startup' });
      driveFallbackTurn(0);
      driveFallbackTurn(1);
      fixture.run('session_shutdown', { type: 'session_shutdown' });

      // Tamper AFTER shutdown: drop a middle line, then resume the session.
      const lines = rawLines();
      lines.splice(1, 1);
      writeRaw(lines);
      fixture.run('session_start', { type: 'session_start', reason: 'resume' });

      await fixture.commands['ledger']!.handler('', fixture.mockCtx);
      const msg = String(fixture.notifySpy.mock.calls.at(-1)?.[0] ?? '');
      expect(msg).toContain('chain broken');
    });

    it('/ledger-receipt checkpoints an OPEN session without disrupting later appends, then the real close re-seals', async () => {
      fixture.run('session_start', { type: 'session_start', reason: 'startup' });
      driveFallbackTurn(0); // seq 0

      await fixture.commands['ledger-receipt']!.handler('', fixture.mockCtx);

      let events = rawEvents();
      const checkpoint = lastClose(events);
      expect(checkpoint).toBeDefined();
      expect(checkpoint!.checkpoint).toBe(true);
      expect(checkpoint!.seq).toBe(1); // right after the agent event
      expectLinkage(events);

      // The receipt footer carries the audit block for the checkpoint seal.
      const dir = path.join(cacheDir, 'pi-ledger');
      const html = fs.readFileSync(
        path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.html'))!),
        'utf8'
      );
      expect(html).toContain('seal open');
      expect(html).toContain(`session ${SESSION_ID}`);
      expect(html).toContain(`kid ${checkpoint!.kid}`);
      expect(html).toContain(`head ${checkpoint!.head}`);
      expect(html).toContain(`sig ${checkpoint!.headSig}`);

      // Later appends continue the chain FROM the checkpoint…
      driveFallbackTurn(1); // seq 2
      events = rawEvents();
      expect(events[2]!.seq).toBe(2);
      expect(events[2]!.prev).toBe(digestEvent(events[1]));
      expectLinkage(events);
      // …and only a checkpoint exists so far → open, chain intact.
      expect(verifySidecarChain(events, chainKey()).status).toBe('open');

      // …and a later real close re-seals the new head.
      fixture.run('session_shutdown', { type: 'session_shutdown' });
      events = rawEvents();
      const finalClose = lastClose(events);
      expect(finalClose!.checkpoint).toBeUndefined();
      expectLinkage(events);
      const v = verifySidecarChain(events, chainKey());
      expect(v.status).toBe('sealed');
      expect(v.sigValid).toBe(true);
    });
  });
});
