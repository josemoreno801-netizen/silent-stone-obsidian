import { describe, expect, it } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import {
  decryptBlob,
  decryptString,
  encryptBlob,
  encryptString,
  NONCE_LENGTH,
} from '../cipher.js';

const TEST_KEY = randomBytes(32);

describe('encryptBlob / decryptBlob', () => {
  it('round-trips: encrypt then decrypt returns original bytes', async () => {
    const plaintext = new TextEncoder().encode('hello vault');
    const encrypted = await encryptBlob(plaintext, TEST_KEY);
    const decrypted = await decryptBlob(encrypted, TEST_KEY);
    expect(Buffer.from(decrypted)).toEqual(Buffer.from(plaintext));
  });

  it('output is nonce + ciphertext + tag (at least 28 bytes longer than nothing)', async () => {
    const plaintext = new Uint8Array(100);
    const encrypted = await encryptBlob(plaintext, TEST_KEY);
    // 12 nonce + 100 ciphertext + 16 tag = 128
    expect(encrypted.length).toBe(NONCE_LENGTH + 100 + 16);
  });

  it('produces different ciphertext each time (unique nonce)', async () => {
    const plaintext = new TextEncoder().encode('same input');
    const a = await encryptBlob(plaintext, TEST_KEY);
    const b = await encryptBlob(plaintext, TEST_KEY);
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b));
  });

  it('encrypts empty input', async () => {
    const plaintext = new Uint8Array(0);
    const encrypted = await encryptBlob(plaintext, TEST_KEY);
    expect(encrypted.length).toBe(NONCE_LENGTH + 16); // nonce + tag only
    const decrypted = await decryptBlob(encrypted, TEST_KEY);
    expect(decrypted.length).toBe(0);
  });

  it('handles large payloads (1 MB)', async () => {
    // randomBytes() caps at 65536; fill a 1 MB buffer in chunks
    const plaintext = new Uint8Array(1024 * 1024);
    for (let i = 0; i < plaintext.length; i += 65536) {
      plaintext.set(randomBytes(Math.min(65536, plaintext.length - i)), i);
    }
    const encrypted = await encryptBlob(plaintext, TEST_KEY);
    const decrypted = await decryptBlob(encrypted, TEST_KEY);
    expect(Buffer.from(decrypted)).toEqual(Buffer.from(plaintext));
  });
});

describe('error handling', () => {
  it('throws on wrong key', async () => {
    const plaintext = new TextEncoder().encode('secret');
    const encrypted = await encryptBlob(plaintext, TEST_KEY);
    const wrongKey = randomBytes(32);
    await expect(decryptBlob(encrypted, wrongKey)).rejects.toThrow();
  });

  it('throws on corrupted ciphertext', async () => {
    const plaintext = new TextEncoder().encode('secret');
    const encrypted = await encryptBlob(plaintext, TEST_KEY);
    encrypted[NONCE_LENGTH + 5] ^= 0xff; // flip a byte
    await expect(decryptBlob(encrypted, TEST_KEY)).rejects.toThrow();
  });

  it('throws on truncated data', async () => {
    await expect(decryptBlob(new Uint8Array(10), TEST_KEY)).rejects.toThrow(
      'too short',
    );
  });

  it('rejects non-32-byte keys for encrypt', async () => {
    const plaintext = new TextEncoder().encode('test');
    await expect(encryptBlob(plaintext, new Uint8Array(16))).rejects.toThrow(
      '32 bytes',
    );
  });

  it('rejects non-32-byte keys for decrypt', async () => {
    await expect(
      decryptBlob(new Uint8Array(28), new Uint8Array(16)),
    ).rejects.toThrow('32 bytes');
  });
});

describe('encryptString / decryptString', () => {
  it('round-trips text content', async () => {
    const text = 'Hello, Silent Stone! \u{1F512}';
    const encrypted = await encryptString(text, TEST_KEY);
    const decrypted = await decryptString(encrypted, TEST_KEY);
    expect(decrypted).toBe(text);
  });

  it('handles empty string', async () => {
    const encrypted = await encryptString('', TEST_KEY);
    const decrypted = await decryptString(encrypted, TEST_KEY);
    expect(decrypted).toBe('');
  });
});
