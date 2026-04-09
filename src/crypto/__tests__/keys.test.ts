import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ARGON2_PARAMS,
  deriveKEK,
  generateMasterKey,
  masterKeyToRecoveryPhrase,
  recoveryPhraseToMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
} from '../keys.js';

describe('generateMasterKey', () => {
  it('produces 16-byte entropy and 32-byte key', () => {
    const material = generateMasterKey();
    expect(material.entropy).toBeInstanceOf(Uint8Array);
    expect(material.entropy.length).toBe(16);
    expect(material.key).toBeInstanceOf(Uint8Array);
    expect(material.key.length).toBe(32);
  });

  it('derives key deterministically from entropy', () => {
    const a = generateMasterKey();
    const phrase = masterKeyToRecoveryPhrase(a);
    const b = recoveryPhraseToMasterKey(phrase);
    // Same entropy must always produce the same key
    expect(Buffer.from(b.key)).toEqual(Buffer.from(a.key));
  });

  it('produces unique keys across calls', () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    expect(Buffer.from(a.entropy)).not.toEqual(Buffer.from(b.entropy));
    expect(Buffer.from(a.key)).not.toEqual(Buffer.from(b.key));
  });
});

describe('recovery phrase', () => {
  it('encodes entropy as a 12-word English mnemonic', () => {
    const material = generateMasterKey();
    const { mnemonic } = masterKeyToRecoveryPhrase(material);
    const words = mnemonic.split(' ');
    expect(words.length).toBe(12);
    // Each word should be lowercase alpha only
    for (const word of words) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it('roundtrips: generate → phrase → back to identical key material', () => {
    const original = generateMasterKey();
    const phrase = masterKeyToRecoveryPhrase(original);
    const recovered = recoveryPhraseToMasterKey(phrase);

    expect(Buffer.from(recovered.entropy)).toEqual(
      Buffer.from(original.entropy),
    );
    expect(Buffer.from(recovered.key)).toEqual(Buffer.from(original.key));
  });
});

describe('deriveKEK', () => {
  // Use minimal params for fast tests
  const FAST_PARAMS = { memory: 1024, time: 1, parallelism: 1 };
  const salt = new Uint8Array(16).fill(42);

  it('produces a 32-byte key', () => {
    const kek = deriveKEK('password', salt, FAST_PARAMS);
    expect(kek).toBeInstanceOf(Uint8Array);
    expect(kek.length).toBe(32);
  });

  it('is deterministic for the same inputs', () => {
    const a = deriveKEK('password', salt, FAST_PARAMS);
    const b = deriveKEK('password', salt, FAST_PARAMS);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });

  it('produces different output for different passwords', () => {
    const a = deriveKEK('password-a', salt, FAST_PARAMS);
    const b = deriveKEK('password-b', salt, FAST_PARAMS);
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it('exports reasonable default params', () => {
    expect(DEFAULT_ARGON2_PARAMS).toEqual({
      memory: 65536,
      time: 3,
      parallelism: 4,
    });
  });
});

describe('wrapMasterKey / unwrapMasterKey', () => {
  // Use minimal Argon2 params so tests don't take ages
  const FAST_PARAMS = { memory: 1024, time: 1, parallelism: 1 };

  it('roundtrips: wrap → unwrap returns identical key', async () => {
    const { key } = generateMasterKey();
    const password = 'test-password-123';

    const wrapped = await wrapMasterKey(key, password, FAST_PARAMS);
    const unwrapped = await unwrapMasterKey({
      password,
      encryptedMasterKey: wrapped.encryptedMasterKey,
      salt: wrapped.salt,
      argon2Params: wrapped.argon2Params,
    });

    expect(Buffer.from(unwrapped)).toEqual(Buffer.from(key));
  });

  it('packed blob is exactly 60 bytes (12 nonce + 32 ciphertext + 16 tag)', async () => {
    const { key } = generateMasterKey();
    const wrapped = await wrapMasterKey(key, 'pw', FAST_PARAMS);
    const packed = Uint8Array.from(atob(wrapped.encryptedMasterKey), (c) =>
      c.charCodeAt(0),
    );
    expect(packed.length).toBe(60);
  });

  it('salt is 16 bytes base64-encoded', async () => {
    const { key } = generateMasterKey();
    const wrapped = await wrapMasterKey(key, 'pw', FAST_PARAMS);
    const salt = Uint8Array.from(atob(wrapped.salt), (c) => c.charCodeAt(0));
    expect(salt.length).toBe(16);
  });

  it('produces different salts on each wrap', async () => {
    const { key } = generateMasterKey();
    const a = await wrapMasterKey(key, 'pw', FAST_PARAMS);
    const b = await wrapMasterKey(key, 'pw', FAST_PARAMS);
    expect(a.salt).not.toBe(b.salt);
  });

  it('throws on wrong password', async () => {
    const { key } = generateMasterKey();
    const wrapped = await wrapMasterKey(key, 'right-password', FAST_PARAMS);

    await expect(
      unwrapMasterKey({
        password: 'wrong-password',
        encryptedMasterKey: wrapped.encryptedMasterKey,
        salt: wrapped.salt,
        argon2Params: wrapped.argon2Params,
      }),
    ).rejects.toThrow();
  });
});
