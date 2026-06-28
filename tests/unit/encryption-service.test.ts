import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '../../src/domain/events.js';
import {
  decryptEventPayload,
  decryptPayload,
  encryptEventPayload,
  encryptPayload,
  generateProjectKey,
  isEncryptedEnvelope,
  keyId,
} from '../../src/services/encryption-service.js';

const AAD = 'evt_123';

function makeEvent(payload: unknown, id = 'evt_123'): DomainEvent {
  return {
    id,
    schemaVersion: '1.0.0',
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    type: 'task.created',
    projectId: 'proj_1',
    scopeType: 'project',
    scopeId: 'proj_1',
    actor: 'user',
    payload,
  };
}

describe('encryption-service', () => {
  it('round-trips a payload through encrypt → decrypt', () => {
    const key = generateProjectKey();
    const payload = { title: 'secret task', tags: ['a', 'b'], n: 42 };
    const env = encryptPayload(payload, key, AAD);
    expect(isEncryptedEnvelope(env)).toBe(true);
    expect(decryptPayload(env, key, AAD)).toEqual(payload);
  });

  it('produces a self-describing __enc envelope, not plaintext', () => {
    const key = generateProjectKey();
    const env = encryptPayload({ secret: 'value' }, key, AAD);
    expect(env.__enc).toBe('A256GCM');
    expect(env.kid).toBe(keyId(key));
    expect(typeof env.iv).toBe('string');
    expect(typeof env.ct).toBe('string');
    expect(typeof env.tag).toBe('string');
    // The plaintext must not be recoverable from the serialized envelope.
    expect(JSON.stringify(env)).not.toContain('value');
  });

  it('stamps a stable, key-specific kid and fails fast on key-id mismatch', () => {
    const keyA = generateProjectKey();
    const keyB = generateProjectKey();
    expect(keyId(keyA)).toBe(keyId(keyA)); // stable
    expect(keyId(keyA)).not.toBe(keyId(keyB)); // key-specific
    const env = encryptPayload({ x: 1 }, keyA, AAD);
    expect(() => decryptPayload(env, keyB, AAD)).toThrow(/key id/);
  });

  it('uses a fresh IV per call (same input → different ciphertext)', () => {
    const key = generateProjectKey();
    const a = encryptPayload({ x: 1 }, key, AAD);
    const b = encryptPayload({ x: 1 }, key, AAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('fails to decrypt with the wrong key', () => {
    const env = encryptPayload({ x: 1 }, generateProjectKey(), AAD);
    expect(() => decryptPayload(env, generateProjectKey(), AAD)).toThrow();
  });

  it('fails to decrypt with a mismatched AAD (event-id binding)', () => {
    const key = generateProjectKey();
    const env = encryptPayload({ x: 1 }, key, 'evt_a');
    expect(() => decryptPayload(env, key, 'evt_b')).toThrow();
  });

  it('fails to decrypt tampered ciphertext (GCM auth)', () => {
    const key = generateProjectKey();
    const env = encryptPayload({ x: 1 }, key, AAD);
    const tampered = { ...env, ct: Buffer.from('garbage').toString('base64') };
    expect(() => decryptPayload(tampered, key, AAD)).toThrow();
  });

  it('passes a plaintext (non-envelope) value through unchanged', () => {
    const key = generateProjectKey();
    const plain = { title: 'not encrypted' };
    expect(decryptPayload(plain, key, AAD)).toEqual(plain);
    expect(isEncryptedEnvelope(plain)).toBe(false);
  });

  it('rejects a malformed base64 key', () => {
    expect(() => encryptPayload({ x: 1 }, 'too-short', AAD)).toThrow(
      /Invalid encryption key/,
    );
  });

  it('encryptEventPayload leaves routing fields plaintext, hides payload', () => {
    const key = generateProjectKey();
    const event = makeEvent({ title: 'secret' });
    const enc = encryptEventPayload(event, key);
    // Metadata stays cleartext for the relay to route on.
    expect(enc.id).toBe(event.id);
    expect(enc.type).toBe(event.type);
    expect(enc.scopeId).toBe(event.scopeId);
    expect(enc.actor).toBe(event.actor);
    // Payload is now ciphertext.
    expect(isEncryptedEnvelope(enc.payload)).toBe(true);
    expect(JSON.stringify(enc.payload)).not.toContain('secret');
    // ...and decrypts back to the original.
    expect(decryptEventPayload(enc, key).payload).toEqual(event.payload);
  });

  it('decryptEventPayload uses the event id as AAD (cross-event replay fails)', () => {
    const key = generateProjectKey();
    const enc = encryptEventPayload(makeEvent({ x: 1 }, 'evt_a'), key);
    // Splice the ciphertext onto a different event id → auth failure.
    const replayed = { ...enc, id: 'evt_b' };
    expect(() => decryptEventPayload(replayed, key)).toThrow();
  });
});
