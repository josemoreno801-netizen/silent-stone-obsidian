import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type {
  Argon2Params,
  MasterKeyMaterial,
  RecoveryPhrase,
  UnwrapInput,
  WrappedKey,
} from './types.js';

/** Default Argon2id parameters: 64 MB memory, 3 iterations, 4 threads. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = {
  memory: 65536,
  time: 3,
  parallelism: 4,
};

const HKDF_SALT = new TextEncoder().encode('silent-stone-master-key');

/** Copy bytes into a fresh ArrayBuffer (fixes TS 5.7 BufferSource compat with @noble libs). */
function toBuffer(data: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(data.length);
  new Uint8Array(buf).set(data);
  return buf;
}
const HKDF_KEY_LENGTH = 32; // 256-bit AES key
const ENTROPY_LENGTH = 16; // 128-bit → 12 BIP39 words
const NONCE_LENGTH = 12; // AES-GCM standard
const SALT_LENGTH = 16; // Argon2 salt
const KEK_LENGTH = 32; // 256-bit KEK

/** Derive a 256-bit AES key from 128-bit entropy via HKDF-SHA256. */
function deriveKeyFromEntropy(entropy: Uint8Array): Uint8Array {
  return hkdf(sha256, entropy, HKDF_SALT, undefined, HKDF_KEY_LENGTH);
}

/**
 * Generate a fresh master key from 128-bit random entropy.
 * The entropy is kept so it can be encoded as a 12-word recovery phrase.
 * The 256-bit AES key is derived deterministically via HKDF.
 */
export function generateMasterKey(): MasterKeyMaterial {
  const entropy = randomBytes(ENTROPY_LENGTH);
  const key = deriveKeyFromEntropy(entropy);
  return { key, entropy };
}

/** Encode the master key's entropy as a 12-word BIP39 English mnemonic. */
export function masterKeyToRecoveryPhrase(
  material: MasterKeyMaterial,
): RecoveryPhrase {
  return { mnemonic: entropyToMnemonic(material.entropy, wordlist) };
}

/** Decode a 12-word BIP39 mnemonic back to the master key material. */
export function recoveryPhraseToMasterKey(
  phrase: RecoveryPhrase,
): MasterKeyMaterial {
  const entropy = mnemonicToEntropy(phrase.mnemonic, wordlist);
  const key = deriveKeyFromEntropy(entropy);
  return { key, entropy };
}

/**
 * Derive a 256-bit Key Encryption Key from a password via Argon2id.
 * The KEK is used to wrap/unwrap the master key — never stored.
 */
export function deriveKEK(
  password: string,
  salt: Uint8Array,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Uint8Array {
  return argon2id(password, salt, {
    t: params.time,
    m: params.memory,
    p: params.parallelism,
    dkLen: KEK_LENGTH,
  });
}

/**
 * Wrap (encrypt) the master key with the user's password.
 * Returns the encrypted blob, salt, and Argon2 params for server storage.
 *
 * Format: base64(nonce‖ciphertext‖tag) — 12 + 32 + 16 = 60 bytes.
 */
export async function wrapMasterKey(
  masterKey: Uint8Array,
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<WrappedKey> {
  const salt = randomBytes(SALT_LENGTH);
  const kek = deriveKEK(password, salt, params);
  const nonce = randomBytes(NONCE_LENGTH);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(kek),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const ciphertextWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(nonce) },
      cryptoKey,
      toBuffer(masterKey),
    ),
  );

  // Pack: nonce || ciphertext || tag
  const packed = new Uint8Array(
    nonce.length + ciphertextWithTag.length,
  );
  packed.set(nonce, 0);
  packed.set(ciphertextWithTag, nonce.length);

  return {
    encryptedMasterKey: btoa(String.fromCharCode(...packed)),
    salt: btoa(String.fromCharCode(...salt)),
    argon2Params: { ...params },
  };
}

/**
 * Unwrap (decrypt) the master key using the user's password.
 * Throws if the password is wrong (AES-GCM auth tag check fails).
 */
export async function unwrapMasterKey(input: UnwrapInput): Promise<Uint8Array> {
  const packed = Uint8Array.from(atob(input.encryptedMasterKey), (c) =>
    c.charCodeAt(0),
  );
  const salt = Uint8Array.from(atob(input.salt), (c) => c.charCodeAt(0));

  const nonce = packed.slice(0, NONCE_LENGTH);
  const ciphertextWithTag = packed.slice(NONCE_LENGTH);

  const kek = deriveKEK(input.password, salt, input.argon2Params);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBuffer(kek),
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
