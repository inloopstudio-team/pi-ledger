# pi-ledger session notarization

> Status: design contract — implemented in `extensions/pi-ledger/`, verified by
> app.inloop.studio (`LedgerSessionParser`). Frozen field names; change only with
> an effort-protocol version bump on the studio side.
>
> Companion spec: `app.inloop.studio/docs/serverless_agency_protocol.md`.

## Purpose

The per-session sidecar (`~/.cache/pi-ledger/sessions/<sessionId>.jsonl`) is the
source of truth for billing, delivered to a client as invoice-grade evidence.
Plain JSONL is self-reported and tamperable. Notarization makes the sidecar
cryptographically verifiable end to end:

1. **Hash chain** — every event links to the previous event's digest, so any
   insertion, deletion, reordering, or edit breaks the chain.
2. **Session seal** — a closing event carries the chain head plus an Ed25519
   signature over the head, so an unsigned or wrongly-signed log is rejected.
3. **Identity** — the signing key identifies the meter (a workstation, or the
   agency CI runner fleet), and its public half is registered where the log is
   verified.

## Canonical form

`canonical(event)` is the UTF-8 JSON serialization of the event with object keys
recursively sorted (arrays keep order, numbers stay JSON numbers, no whitespace
padding — i.e. `JSON.stringify` of a recursively key-sorted deep copy).

`digest(event) = sha256_hex(canonical(event))` — computed over the complete
event object _including_ its `seq`/`prev` fields (the digest of event N is what
event N+1 puts in `prev`).

## Chain fields (additive on every event kind)

| Field  | Type   | Meaning                                                    |
| ------ | ------ | ---------------------------------------------------------- |
| `seq`  | int    | 0-based position in this session's sidecar                 |
| `prev` | string | 64-hex sha256 of the previous event; genesis uses 64 zeros |

Existing event shapes (`settings`, `agent`, `human-open`, `human-close`,
`steer`) are unchanged apart from these two fields. Replay/rehydrate logic must
tolerate legacy events lacking them (see Verification states).

## Session seal

On `session_shutdown` (and as a checkpoint before `/ledger-receipt` on an open
session), append exactly one:

```json
{
  "kind": "session-close",
  "sessionId": "<session id>",
  "seq": <n>,
  "prev": "<digest of previous event>",
  "head": "<digest of previous event>",
  "headSig": "<base64 Ed25519 signature>",
  "kid": "<16-hex key id>",
  "timestamp": <unix ms>
}
```

- `head` equals `prev` (written twice deliberately: the seal is verifiable
  without re-walking the chain).
- Signature message: `"pi-ledger-seal:v1:" + sessionId + ":" + head` (UTF-8).
- A receipt for a still-open session appends a checkpoint `session-close` with
  `"checkpoint": true`; a later real close re-seals with the new head. A
  checkpoint must never suppress later appends.

## Identity

- Secret key: `~/.config/pi-ledger/identity.secret` — base64 64-byte Ed25519
  secret key, file mode 0600. Auto-generated on first signed append.
- Public descriptor: `~/.config/pi-ledger/identity.json` —
  `{ "kid": "<16 hex>", "publicKey": "<base64 32 bytes>" }`.
- `kid` = first 8 bytes of `sha256(publicKey)` as hex (16 chars).
- `/ledger-settings` displays `kid` and the full public key for registration.
- Headless/CI override: env `PI_LEDGER_IDENTITY_B64` (base64 of the secret key
  bytes) replaces the on-disk identity; `kid` is derived the same way. The
  agency registers the CI fleet's public key in app.inloop.studio so
  runner-produced sessions attest as agency infrastructure.

## Verification states (consumed by studio)

| State      | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `sealed`   | chain intact, close signature verifies against registered key             |
| `open`     | chain intact, no close event (session still running; checkpoint optional) |
| `legacy`   | events lack `seq`/`prev` (pre-notarization sessions)                      |
| `tampered` | any seq/prev mismatch, duplicate seq, or signature failure                |

`LedgerSessionParser` on app.inloop.studio exposes `chain_status` alongside the
billing result and must refuse `tampered` sessions at delivery preflight.

## Local surfacing

Rehydrate verifies linkage as it replays (cheap, events arrive in order); a
broken chain shows a `chain broken` marker in `/ledger` and on the receipt.
The receipt footer shows: session id, `kid`, head digest, signature, seal
status — the audit block a client can independently re-verify.

## Headless / CI note

A headless or subprocess-observed session produces no human events by
construction (no editor keystrokes, no wizard), so CI-produced sessions bill
agent time only. Nothing in metering changes; notarization applies identically
to fallback, pi-tps, and subprocess-observed sessions.

## Backward compatibility

- Old sidecars parse as `legacy`; studio may accept them with a visible warning
  until the fleet cutover date set in the effort protocol doc.
- New fields are additive; older pi-ledger builds rehydrating new sidecars must
  ignore unknown fields (they already do — replay is tolerant by kind).
