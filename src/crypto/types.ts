/** Raw master key material. Only exists in memory, never persisted. */
export interface MasterKeyMaterial {
	/** The 256-bit AES master key as raw bytes. */
	key: Uint8Array;
	/** The 128-bit entropy the key was derived from (needed for recovery phrase display). */
	entropy: Uint8Array;
}

/** The BIP39 mnemonic recovery phrase. */
export interface RecoveryPhrase {
	/** Space-separated 12-word BIP39 English mnemonic. */
	mnemonic: string;
}

/** Parameters for Argon2id key derivation. */
export interface Argon2Params {
	/** Memory cost in KiB (default: 65536 = 64 MB). */
	memory: number;
	/** Number of iterations (default: 3). */
	time: number;
	/** Degree of parallelism (default: 4). */
	parallelism: number;
}

/** Result of wrapping (encrypting) the master key with the KEK. */
export interface WrappedKey {
	/** base64(nonce || ciphertext || tag) — 60 bytes total. */
	encryptedMasterKey: string;
	/** base64(salt) — 16 random bytes. */
	salt: string;
	/** The Argon2id parameters used, stored for re-derivation on other devices. */
	argon2Params: Argon2Params;
}

/** Input needed to unwrap (decrypt) the master key. */
export interface UnwrapInput {
	/** The user's account password. */
	password: string;
	/** base64(nonce || ciphertext || tag) from server. */
	encryptedMasterKey: string;
	/** base64(salt) from server. */
	salt: string;
	/** Argon2id parameters from server. */
	argon2Params: Argon2Params;
}
