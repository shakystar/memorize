import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import type { DomainEvent } from '../domain/events.js';

/**
 * #182 — client-side E2E encryption of synced event payloads. memorize_hub (the
 * relay) treats payloads as opaque and depends only on `event.id`, so encrypting
 * just the `payload` field — leaving id/type/scope/actor/timestamps plaintext —
 * makes the relay unable to read memory content with ZERO changes to the wire
 * shape or to the Hub.
 *
 * Primitive: AES-256-GCM via Node's built-in `node:crypto` (zero dependency,
 * AES-NI accelerated). Each event gets a fresh random 96-bit IV, and the event's
 * `id` is authenticated as AAD so a ciphertext cannot be replayed onto a
 * different event. This is a WIRE-only concern: the local SQLite log and
 * projections stay plaintext (the local machine is trusted).
 *
 * Acknowledged leak (matches #182's threat model): event ids, types, scope,
 * actor, sizes, and timing remain visible to the relay. Only `payload` is hidden.
 */

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce, the standard GCM IV size

/**
 * Self-describing ciphertext that replaces an event's `payload` on the wire. The
 * `__enc` marker lets the decryptor detect ciphertext and distinguish it from a
 * plaintext payload (which is passed through untouched for backward compat).
 */
export interface EncEnvelope {
  __enc: 'A256GCM';
  /**
   * Key fingerprint ({@link keyId}). Single-key today, but reserved now so key
   * rotation and per-replica asymmetric key wrapping — both of which require
   * multiple keys to coexist — can select the right key WITHOUT a wire-format
   * migration of already-synced ciphertext. Also lets decrypt fail fast with a
   * clear "wrong key" error instead of an opaque GCM auth failure.
   */
  kid: string;
  /** base64 random 96-bit IV, fresh per event. */
  iv: string;
  /** base64 ciphertext of `JSON.stringify(payload)`. */
  ct: string;
  /** base64 16-byte GCM authentication tag. */
  tag: string;
}

/** Generate a fresh base64 AES-256 project key (used by the deferred CLI). */
export function generateProjectKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Stable short fingerprint of a key (16 hex chars), domain-separated so it is
 * not a bare hash of the key material. Used as the envelope `kid`.
 */
export function keyId(keyB64: string): string {
  return createHash('sha256')
    .update('memorize-e2e-kid:')
    .update(decodeKey(keyB64))
    .digest('hex')
    .slice(0, 16);
}

function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Invalid encryption key: expected ${KEY_BYTES} bytes (base64), got ${key.length}.`,
    );
  }
  return key;
}

/** True iff `value` is an `__enc` ciphertext envelope (the detection guard). */
export function isEncryptedEnvelope(value: unknown): value is EncEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.__enc === 'A256GCM' &&
    typeof v.kid === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.ct === 'string' &&
    typeof v.tag === 'string'
  );
}

/**
 * Encrypt a payload into an `EncEnvelope`. `aad` (the event id) is authenticated
 * but not encrypted, binding the ciphertext to its event.
 */
export function encryptPayload(
  payload: unknown,
  keyB64: string,
  aad: string,
): EncEnvelope {
  const key = decodeKey(keyB64);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  // JSON.stringify(undefined) is undefined; normalize so round-trips are total.
  const json = JSON.stringify(payload) ?? 'null';
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return {
    __enc: 'A256GCM',
    kid: keyId(keyB64),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypt a value produced by {@link encryptPayload}. A non-envelope value is
 * returned unchanged (plaintext compat). A wrong key, tampered ciphertext/tag, or
 * mismatched `aad` throws on GCM auth failure — fail-closed, surfacing as a sync
 * error rather than silently returning garbage.
 */
export function decryptPayload(
  value: unknown,
  keyB64: string,
  aad: string,
): unknown {
  if (!isEncryptedEnvelope(value)) return value;
  const key = decodeKey(keyB64);
  // Fail fast with a clear error when the configured key is not the one this
  // ciphertext was sealed with — far friendlier than an opaque GCM auth failure,
  // and the seam through which rotation/multi-key will pick the right key.
  if (value.kid !== keyId(keyB64)) {
    throw new Error(
      `Cannot decrypt: ciphertext key id ${value.kid} does not match the ` +
        `configured key id ${keyId(keyB64)}.`,
    );
  }
  const decipher = createDecipheriv(ALG, key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(value.ct, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString('utf8'));
}

/**
 * Return a shallow clone of `event` with its `payload` encrypted, using the
 * event id as AAD. All other fields (id/type/scope/actor/timestamps) are left
 * plaintext for the relay to route on.
 */
export function encryptEventPayload(
  event: DomainEvent,
  keyB64: string,
): DomainEvent {
  return { ...event, payload: encryptPayload(event.payload, keyB64, event.id) };
}

/** Inverse of {@link encryptEventPayload}; plaintext payloads pass through. */
export function decryptEventPayload(
  event: DomainEvent,
  keyB64: string,
): DomainEvent {
  return { ...event, payload: decryptPayload(event.payload, keyB64, event.id) };
}
