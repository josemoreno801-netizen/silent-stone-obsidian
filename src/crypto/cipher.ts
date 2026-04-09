import { randomBytes } from '@noble/hashes/utils.js';

export const NONCE_LENGTH = 12;

/** Copy bytes into a fresh ArrayBuffer (TS 5.7 BufferSource compat). */
function toBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.length);
  new Uint8Array(buf).set(data);
  return buf;
}

/**
 * Encrypt a blob with AES-256-GCM.
 * Returns: nonce (12 bytes) || ciphertext || GCM tag (16 bytes).
 * Each call generates a fresh random nonce — never reuse.
 */
export async function encryptBlob(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== 32) {
    throw new Error('Key must be 32 bytes (AES-256)');
  }

  const nonce = randomBytes(NONCE_LENGTH);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(key),
    'AES-GCM',
    false,
    ['encrypt'],
  );

  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(nonce) },
      cryptoKey,
      toBuffer(plaintext),
    ),
  );

  const result = new Uint8Array(NONCE_LENGTH + ciphertextWithTag.length);
  result.set(nonce, 0);
  result.set(ciphertextWithTag, NONCE_LENGTH);
  return result;
}

/**
 * Decrypt an AES-256-GCM encrypted blob.
 * Input format: nonce (12 bytes) || ciphertext || GCM tag (16 bytes).
 * Throws if key is wrong or data is tampered (GCM auth tag verification).
 */
export async function decryptBlob(
  encrypted: Uint8Array,
  key: Uint8Array,
): Promise<Uint8Array> {
  if (key.length !== 32) {
    throw new Error('Key must be 32 bytes (AES-256)');
  }
  if (encrypted.length < NONCE_LENGTH + 16) {
    throw new Error('Encrypted data too short (minimum 28 bytes: 12 nonce + 16 tag)');
  }

  const nonce = encrypted.slice(0, NONCE_LENGTH);
  const ciphertextWithTag = encrypted.slice(NONCE_LENGTH);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(key),
    'AES-GCM',
    false,
    ['decrypt'],
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBuffer(nonce) },
    cryptoKey,
    toBuffer(ciphertextWithTag),
  );

  return new Uint8Array(plaintext);
}

/** Encode a UTF-8 string to bytes, encrypt, return encrypted blob. */
export async function encryptString(
  text: string,
  key: Uint8Array,
): Promise<Uint8Array> {
  return encryptBlob(new TextEncoder().encode(text), key);
}

/** Decrypt a blob and decode the plaintext as UTF-8. */
export async function decryptString(
  encrypted: Uint8Array,
  key: Uint8Array,
): Promise<string> {
  const plaintext = await decryptBlob(encrypted, key);
  return new TextDecoder().decode(plaintext);
}
